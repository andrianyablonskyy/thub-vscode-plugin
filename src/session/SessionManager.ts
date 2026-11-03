// The boards, identity, reservations and sessions: refreshed from the thub
// CLI, shared by the tree, the status bar and every command.

import * as vscode from 'vscode';
import { ThubError, type ThubCli } from '../cli/ThubCli';
import { boardState, formatLeft, msUntil } from '../cli/parse';
import type { ForwardConfig, Job, Me, Resource, RttConfig } from '../cli/types';
import { ForwardStore, normalizeForwards } from '../forward/ForwardStore';
import { RttStore, normalizeRtts } from '../rtt/RttStore';
import { supportsResourceFeature } from './resourceFeatures';
import { Session } from './Session';
import { resourceSlot, resourceToReplace } from './resourceSlots';
import { settings } from '../util/config';

/** Warn this long before a reservation ends (once per reservation). */
const WARN_MS = 10 * 60_000,
  POLL_MS = 15_000;

export class SessionManager implements vscode.Disposable {
  resources: Resource[] = [];
  jobs: Job[] = [];
  me?: Me;
  signedIn = false;
  lastError?: string;
  lastRefresh?: Date;

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly sessionStarted = new vscode.EventEmitter<Session>();
  private readonly sessions = new Map<string, Session>();
  private readonly allocatedPorts = new Set<number>();
  private readonly pendingSlots = new Set<Resource['type']>();
  /** A new session (to attach UI to). */
  readonly onDidStartSession = this.sessionStarted.event;
  private poll?: NodeJS.Timeout;
  private ticker?: NodeJS.Timeout;
  private visible = false;
  private warned = new Set<string>();
  private refreshing?: Promise<void>;
  private activeClient?: string;
  private starting = Promise.resolve();

  constructor(
    private readonly cli: ThubCli,
    private readonly log: (line: string) => void,
    private readonly forwardStore: ForwardStore,
    private readonly rttStore: RttStore
  ){
    // The countdown, the 10-minute warning and the end check run every 15 s.
    this.ticker = setInterval(() => this.tick(), POLL_MS);
  }

  /** Reservations held by the current user, ordered HIL then SIL. */
  get mines(): Resource[] {
    return this.resources
      .filter((r) => boardState(r) === 'mine')
      .sort((a, b) => Number(b.type === 'hw') - Number(a.type === 'hw'));
  }

  /** The selected reservation, or the HIL reservation by default. */
  get mine(): Resource | undefined {
    return this.findMine();
  }

  findMine(client?: string): Resource | undefined {
    const mines = this.mines;
    if (client){
      return mines.find((r) => r.name === client);
    }
    return mines.find((r) => r.name === this.activeClient) || mines[0];
  }

  /** The selected connection, or the first active connection. */
  get session(): Session | undefined {
    return this.activeClient ? this.sessions.get(this.activeClient) : this.sessions.values().next().value;
  }

  get activeSessions(): Session[] {
    return [...this.sessions.values()];
  }

  getSession(client: string): Session | undefined {
    return this.sessions.get(client);
  }

  selectResource(client: string): void {
    if (!this.resources.some((r) => r.name === client)){
      throw new Error(`Board ${client} is no longer available`);
    }
    this.activeClient = client;
    this.changed.fire();
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
    if (this.visible || this.sessions.size){
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
    for (const [client, session] of this.sessions){
      const mine = this.findMine(client);
      if (!mine || mine.reservation?.id !== session.reservationId){
        session.end('Reservation ended');
      }
      else if (mine.reservation){
        session.until = mine.reservation.until;
      }
    }
  }

  private tick(): void {
    for (const mine of this.mines){
      const r = mine.reservation;
      if (!r?.id){
        continue;
      }
      const left = msUntil(r.until);
      if (left <= 0){
        void this.refresh();
      }
      else if (left <= WARN_MS && !this.warned.has(r.id)){
        this.warned.add(r.id);
        void this.warnExpiring(mine.name);
      }
    }
    this.changed.fire();
  }

  private async warnExpiring(client: string): Promise<void> {
    const left = formatLeft(msUntil(this.findMine(client)?.reservation?.until)),
      pick = await vscode.window.showWarningMessage(
        `${client} is yours for ${left === '<1m' ? 'less than a minute' : left.replace(/^0h /, '')} more. A running job keeps running when it ends.`,
        'Release now', 'Extend 1h'
      );
    if (pick === 'Extend 1h'){
        await this.extend(60, client);
    }
    else if (pick === 'Release now'){
        await this.release(client);
    }
  }

  /** Reserve (or extend mine) for `minutes`; then connect, if asked. */
  async reserve(client: string, minutes: number, connect: boolean): Promise<Resource> {
    const target = this.resources.find((r) => r.name === client);
    if (!target){
      throw new Error(`Board ${client} is no longer available`);
    }
    const sameType = resourceToReplace(this.mines, target);
    if (sameType){
      throw new Error(`You already hold a ${resourceSlot(target)} resource (${sameType.name}); switch it before reserving ${client}`);
    }
    if (this.pendingSlots.has(target.type)){
      throw new Error(`A ${resourceSlot(target)} reservation is already in progress`);
    }
    this.pendingSlots.add(target.type);
    try {
      const r = await this.cli.reserve(client, minutes);
      await this.refresh();
      if (connect){
        await this.connect(client);
      }
      return r;
    }
    finally {
      this.pendingSlots.delete(target.type);
    }
  }

  async extend(minutes = 60, client?: string): Promise<void> {
    const mine = this.findMine(client);
    if (!mine){
      throw new Error('You have no reserved board');
    }
    await this.cli.reserve(mine.name, minutes);
    if (mine.reservation?.id){
      this.warned.delete(mine.reservation.id);
    }
    await this.refresh();
  }

  async release(client?: string): Promise<void> {
    const mine = this.findMine(client),
      name = mine?.name || (client && this.sessions.has(client) ? client : undefined);
    if (!name){
      throw new Error('You have no reserved board');
    }
    this.sessions.get(name)?.end('Released');
    await this.cli.release(name);
    await this.refresh();
  }

  getForwardServices(client?: string): ForwardConfig[] {
    const mine = this.findMine(client);
    return mine ? this.forwardStore.read(mine.id) : [];
  }

  get forwardServices(): ForwardConfig[] {
    return this.getForwardServices();
  }

  async setForwardServices(forwards: unknown, client?: string): Promise<void> {
    const mine = this.findMine(client);
    if (!mine){
      throw new Error('Reserve a board before adding forwarded services');
    }
    const checked = normalizeForwards(forwards);
    await this.forwardStore.write(mine.id, checked);
    const reservationId = mine.reservation?.id;
    const session = this.sessions.get(mine.name);
    if (session && session.reservationId === reservationId){
      session.updateForwards(checked);
    }
    this.changed.fire();
  }

  getRttConfigs(client?: string): RttConfig[] {
    const mine = this.findMine(client);
    return mine ? this.rttStore.read(mine.id) : [];
  }

  get rttConfigs(): RttConfig[] {
    return this.getRttConfigs();
  }

  async setRttConfigs(configs: unknown, client?: string): Promise<void> {
    const mine = this.findMine(client);
    if (!mine){
      throw new Error('Reserve a board before configuring RTT logs');
    }
    if (!supportsResourceFeature(mine, 'rtt')){
      throw new Error('RTT is not available for SIL resources');
    }
    const checked = normalizeRtts(configs);
    if (checked.length && !(await this.cli.getFeatures()).connectRtt){
      throw new Error('The configured thub CLI does not support `connect --rtt`; clear thub.cliPath to use the extension-managed CLI, or update the configured CLI.');
    }
    await this.rttStore.write(mine.id, checked);
    const reservationId = mine.reservation?.id;
    const session = this.sessions.get(mine.name);
    if (session && session.reservationId === reservationId){
      session.updateRtts(checked);
    }
    this.changed.fire();
  }

  /** The selected reservation's session — started if it isn't yet. */
  async connect(client?: string, target?: string): Promise<Session> {
    const mine = this.findMine(client);
    if (!mine?.reservation?.id){
      throw new Error('Reserve a board first');
    }
    const reservationId = mine.reservation.id;
    this.activeClient = mine.name;
    const existing = this.sessions.get(mine.name);
    if (existing?.reservationId === reservationId){
      this.changed.fire();
      return existing;
    }
    const forwards = this.forwardStore.read(mine.id);
    if (forwards.length && !(await this.cli.getFeatures()).connectForward){
      throw new Error('The configured thub CLI does not support `connect --forward`; clear thub.cliPath to use the extension-managed CLI, or update the configured CLI.');
    }
    const rtts = supportsResourceFeature(mine, 'rtt') ? this.rttStore.read(mine.id) : [];
    if (rtts.length && !(await this.cli.getFeatures()).connectRtt){
      throw new Error('The configured thub CLI does not support `connect --rtt`; clear thub.cliPath to use the extension-managed CLI, or update the configured CLI.');
    }
    this.sessions.get(mine.name)?.end('Replaced');
    const id = reservationId,
      session = new Session(this.cli, this.log, mine, target || settings.defaultTarget() || undefined, async () => {
        await this.refresh();
        return this.findMine(mine.name)?.reservation?.id === id;
      }, forwards, rtts);
    this.sessions.set(mine.name, session);
    void vscode.commands.executeCommand('setContext', 'thub.hasSession', true);
    session.onDidChange(() => {
      void vscode.commands.executeCommand('setContext', 'thub.connected', [...this.sessions.values()].some((s) => s.isUp));
      this.changed.fire();
    });
    session.onDidEnd((reason) => {
      if (this.sessions.get(mine.name) === session){
        this.sessions.delete(mine.name);
        this.releasePorts(session);
        if (this.activeClient === mine.name){
          this.activeClient = this.sessions.keys().next().value;
        }
        void vscode.commands.executeCommand('setContext', 'thub.hasSession', this.sessions.size > 0);
        void vscode.commands.executeCommand('setContext', 'thub.connected', [...this.sessions.values()].some((s) => s.isUp));
        this.reschedule();
      }
      void vscode.window.showInformationMessage(`${reason}: ${session.client}. Terminals, camera and forwarded ports were closed.`);
      this.changed.fire();
    });
    this.reschedule();
    this.sessionStarted.fire(session);
    try {
      await this.startSession(session);
    }
    catch (err){
      if (this.sessions.get(mine.name) === session){
        this.sessions.delete(mine.name);
        this.releasePorts(session);
        void vscode.commands.executeCommand('setContext', 'thub.hasSession', this.sessions.size > 0);
        void vscode.commands.executeCommand('setContext', 'thub.connected', [...this.sessions.values()].some((s) => s.isUp));
      }
      this.changed.fire();
      throw err;
    }
    this.changed.fire();
    return session;
  }

  private async startSession(session: Session): Promise<void> {
    const previous = this.starting;
    let unlock!: () => void;
    this.starting = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      await session.start(this.allocatedPorts);
    }
    finally {
      unlock();
    }
  }

  private releasePorts(session: Session): void {
    for (let i = 0; i < 4; i++){
      this.allocatedPorts.delete(session.ports.uart + i);
    }
    for (let i = 0; i < 2; i++){
      this.allocatedPorts.delete(session.ports.gdb + i);
    }
    this.allocatedPorts.delete(session.ports.video);
  }

  /** The session, connected and up — reserving or connecting as needed (asks first). */
  async ensureUp(why: string, target?: string, client?: string): Promise<Session> {
    if (!this.findMine(client)){
      await this.refresh();
    }
    if (!this.findMine(client)){
      const pick = await vscode.window.showWarningMessage(`${why} needs a reserved board.`, 'Reserve board…');
      if (pick){
        await vscode.commands.executeCommand('thub.reserve');
      }
      if (!this.findMine(client)){
        throw new Error('No board reserved');
      }
    }
    const mine = this.findMine(client)!,
      session = await this.connect(mine.name, target);
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
    this.sessions.forEach((session) => session.dispose());
    this.sessions.clear();
    this.allocatedPorts.clear();
    this.changed.dispose();
    this.sessionStarted.dispose();
  }
}
