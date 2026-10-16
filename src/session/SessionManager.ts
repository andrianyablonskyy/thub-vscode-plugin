// The boards, who I am, my reservation and its session: refreshed from the
// thub CLI, shared by the tree, the status bar and every command.

import * as vscode from 'vscode';
import { ThubError, type ThubCli } from '../cli/ThubCli';
import { boardState, formatLeft, msUntil } from '../cli/parse';
import type { Job, Me, Resource } from '../cli/types';
import { Session } from './Session';
import { settings } from '../util/config';

/** Warn this long before a reservation ends (once per reservation). */
const WARN_MS = 10 * 60_000,
  POLL_MS = 15_000;

export class SessionManager implements vscode.Disposable {
  resources: Resource[] = [];
  jobs: Job[] = [];
  me?: Me;
  session?: Session;
  signedIn = false;
  lastError?: string;
  lastRefresh?: Date;

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly sessionStarted = new vscode.EventEmitter<Session>();
  /** A new session (to attach UI to). */
  readonly onDidStartSession = this.sessionStarted.event;
  private poll?: NodeJS.Timeout;
  private ticker?: NodeJS.Timeout;
  private visible = false;
  private warned = new Set<string>();
  private refreshing?: Promise<void>;

  constructor(private readonly cli: ThubCli, private readonly log: (line: string) => void){
    // The countdown, the 10-minute warning and the end check run every 15 s.
    this.ticker = setInterval(() => this.tick(), POLL_MS);
  }

  /** My current reservation's runner, if I hold one. */
  get mine(): Resource | undefined {
    return this.resources.find((r) => boardState(r) === 'mine');
  }

  /** The Boards view shows or hides: it's polled only while visible (or a session runs). */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.reschedule();
    if (visible){
      void this.refresh();
    }
  }

  private reschedule(): void {
    clearInterval(this.poll);
    this.poll = undefined;
    if (this.visible || this.session){
      this.poll = setInterval(() => void this.refresh(), POLL_MS);
    }
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      const [resources, jobs] = await Promise.all([this.cli.resources(), this.cli.jobs().catch(() => this.jobs)]);
      this.resources = resources.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      this.jobs = jobs.slice(0, 10);
      this.lastError = undefined;
      this.lastRefresh = new Date();
      this.setSignedIn(true);
      if (!this.me){
        this.me = await this.cli.whoami().catch(() => undefined);
      }
      this.checkSession();
    }
    catch (err){
      this.lastError = (err as Error).message;
      if (err instanceof ThubError && err.kind === 'auth'){
        this.setSignedIn(false);
      }
      this.log(`refresh: ${this.lastError}`);
    }
    this.changed.fire();
  }

  setSignedIn(on: boolean): void {
    if (on !== this.signedIn){
      this.signedIn = on;
      void vscode.commands.executeCommand('setContext', 'thub.signedIn', on);
    }
  }

  forgetIdentity(): void {
    this.me = undefined;
  }

  /** My reservation is gone or another one: the session ends. Same one: its end time follows. */
  private checkSession(): void {
    const mine = this.mine,
      s = this.session;
    if (s && (!mine || mine.reservation?.id !== s.reservationId)){
      s.end('Reservation ended');
    }
    else if (s && mine?.reservation){
      s.until = mine.reservation.until;
    }
  }

  private tick(): void {
    const mine = this.mine,
      r = mine?.reservation;
    if (r?.id){
      const left = msUntil(r.until);
      if (left <= 0){
        void this.refresh();
      }
      else if (left <= WARN_MS && !this.warned.has(r.id)){
        this.warned.add(r.id);
        void this.warnExpiring(mine!.name);
      }
    }
    this.changed.fire();
  }

  private async warnExpiring(client: string): Promise<void> {
    const left = formatLeft(msUntil(this.mine?.reservation?.until)),
      pick = await vscode.window.showWarningMessage(
        `${client} is yours for ${left === '<1m' ? 'less than a minute' : left.replace(/^0h /, '')} more. A running job keeps running when it ends.`,
        'Release now', 'Extend 1h'
      );
    if (pick === 'Extend 1h'){
      await vscode.commands.executeCommand('thub.extend');
    }
    else if (pick === 'Release now'){
      await vscode.commands.executeCommand('thub.release');
    }
  }

  /** Reserve (or extend mine) for `minutes`; then connect, if asked. */
  async reserve(client: string, minutes: number, connect: boolean): Promise<Resource> {
    const r = await this.cli.reserve(client, minutes);
    await this.refresh();
    if (connect){
      await this.connect();
    }
    return r;
  }

  async extend(minutes = 60): Promise<void> {
    const mine = this.mine;
    if (!mine){
      throw new Error('You have no reserved board');
    }
    await this.cli.reserve(mine.name, minutes);
    if (mine.reservation?.id){
      this.warned.delete(mine.reservation.id);
    }
    await this.refresh();
  }

  async release(): Promise<void> {
    const mine = this.mine,
      name = mine?.name || this.session?.client;
    if (!name){
      throw new Error('You have no reserved board');
    }
    this.session?.end('Released');
    await this.cli.release(name);
    await this.refresh();
  }

  /** The session of my reservation — started if it isn't yet. */
  async connect(target?: string): Promise<Session> {
    const mine = this.mine;
    if (!mine?.reservation?.id){
      throw new Error('Reserve a board first');
    }
    if (this.session && this.session.reservationId === mine.reservation.id){
      return this.session;
    }
    this.session?.end('Replaced');
    const id = mine.reservation.id,
      session = new Session(this.cli, this.log, mine, target || settings.defaultTarget() || undefined, async () => {
        await this.refresh();
        return this.mine?.reservation?.id === id;
      });
    this.session = session;
    void vscode.commands.executeCommand('setContext', 'thub.hasSession', true);
    session.onDidChange(() => {
      void vscode.commands.executeCommand('setContext', 'thub.connected', session.isUp);
      this.changed.fire();
    });
    session.onDidEnd((reason) => {
      if (this.session === session){
        this.session = undefined;
        void vscode.commands.executeCommand('setContext', 'thub.hasSession', false);
        void vscode.commands.executeCommand('setContext', 'thub.connected', false);
        this.reschedule();
      }
      void vscode.window.showInformationMessage(`${reason}: ${session.client}. Terminals, camera and forwarded ports were closed.`);
      this.changed.fire();
    });
    this.reschedule();
    this.sessionStarted.fire(session);
    await session.start();
    this.changed.fire();
    return session;
  }

  /** The session, connected and up — reserving or connecting as needed (asks first). */
  async ensureUp(why: string, target?: string): Promise<Session> {
    if (!this.mine){
      await this.refresh();
    }
    if (!this.mine){
      const pick = await vscode.window.showWarningMessage(`${why} needs a reserved board.`, 'Reserve board…');
      if (pick){
        await vscode.commands.executeCommand('thub.reserve');
      }
      if (!this.mine){
        throw new Error('No board reserved');
      }
    }
    const session = await this.connect(target);
    if (target && session.target && session.target !== target){
      void vscode.window.showWarningMessage(`${session.client} is connected with OpenOCD target ${session.target}, not ${target}: release and reserve again to change it.`);
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `thub: connecting to ${session.client}` },
      () => session.whenUp()
    );
    return session;
  }

  dispose(): void {
    clearInterval(this.poll);
    clearInterval(this.ticker);
    this.session?.dispose();
    this.changed.dispose();
    this.sessionStarted.dispose();
  }
}
