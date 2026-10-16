// One reservation's connection: its long-lived `thub connect` child, the
// local ports it opened, and everything the extension built on them
// (terminals, video, debug) — disposed together when it ends.

import * as vscode from 'vscode';
import * as readline from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import type { ThubCli } from '../cli/ThubCli';
import { parseConnectLine } from '../cli/parse';
import type { ConnectReady, Resource } from '../cli/types';
import { freeBlock } from '../util/ports';
import { settings } from '../util/config';

export type LinkState = 'starting' | 'waiting' | 'up' | 'reconnecting' | 'ended';

/** `thub connect` restarts after it exits on its own: 1, 2, 5, 10 s apart. */
const RESTART_DELAYS_S = [1, 2, 5, 10];

export class Session implements vscode.Disposable {
  readonly client: string;
  readonly reservationId: string;
  until: string;
  link: LinkState = 'starting';
  ready?: ConnectReady;
  video?: { streaming: boolean; error: string | null };
  /** The local ports, pinned: they stay the same across restarts. */
  ports = { uart: 0, gdb: 0, video: 0 };
  lastError?: string;

  private child?: ChildProcess;
  private restarts = 0;
  private restartTimer?: NodeJS.Timeout;
  private disposed = false;
  private wasUp = false;
  private fatal?: string;
  private readonly owned: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly ended = new vscode.EventEmitter<string>();
  private readonly cameBack = new vscode.EventEmitter<void>();
  /** Link state, ports or video changed. */
  readonly onDidChange = this.changed.event;
  /** The session is over (reason); everything it owned is gone. */
  readonly onDidEnd = this.ended.event;
  /** The link came back after `thub connect` restarted: a debugger must reattach. */
  readonly onDidReconnect = this.cameBack.event;

  constructor(
    private readonly cli: ThubCli,
    private readonly log: (line: string) => void,
    resource: Resource,
    readonly target: string | undefined,
    /** Whether the reservation `reservationId` still holds (for restarts). */
    private readonly stillReserved: () => Promise<boolean>
  ){
    this.client = resource.name;
    this.reservationId = resource.reservation?.id || '';
    this.until = resource.reservation?.until || '';
  }

  /** UART n's local port (n from 1). */
  uartPort(index = 1): number | undefined {
    return this.ready?.ports.find((p) => p.kind === 'uart' && p.index === index)?.port;
  }

  /** ST-Link n's local GDB port. */
  gdbPort(index = 1): number | undefined {
    return this.ready?.ports.find((p) => p.kind === 'swd' && p.index === index)?.port;
  }

  get videoUrl(): string | undefined {
    return this.ready?.video?.url;
  }

  get isUp(): boolean {
    return this.link === 'up';
  }

  /** Disposed with the session. */
  own<T extends vscode.Disposable>(d: T): T {
    if (this.disposed){
      d.dispose();
    }
    else {
      this.owned.push(d);
    }
    return d;
  }

  async start(): Promise<void> {
    const base = settings.ports();
    this.ports = {
      uart: await freeBlock(base.uart, 4),
      gdb: await freeBlock(base.gdb, 2),
      video: await freeBlock(base.video, 1)
    };
    await this.spawn();
  }

  /** Resolves once the link is up (or rejects when the session ends first). */
  whenUp(timeoutMs = 60_000): Promise<void> {
    if (this.isUp){
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`${this.client}: no link after ${timeoutMs / 1000} s${this.lastError ? ` — ${this.lastError}` : ''}`)), timeoutMs),
        subs = [
          this.onDidChange(() => this.isUp && done()),
          this.onDidEnd((reason) => done(new Error(reason)))
        ],
        done = (err?: Error) => {
          clearTimeout(timer);
          subs.forEach((s) => s.dispose());
          return err ? reject(err) : resolve();
        };
    });
  }

  private async spawn(): Promise<void> {
    if (this.disposed){
      return;
    }
    this.fatal = undefined;
    this.link = this.wasUp ? 'reconnecting' : 'starting';
    this.changed.fire();
    let child: ChildProcess;
    try {
      child = await this.cli.startConnect(this.client, this.ports, this.target);
    }
    catch (err){
      this.lastError = (err as Error).message;
      return this.scheduleRestart();
    }
    this.child = child;
    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr! }).on('line', (line) => {
      this.log(`[connect ${this.client}] ${line}`);
      if (/^Error:/.test(line)){
        this.lastError = line.replace(/^Error:\s*/, '');
      }
    });
    child.on('error', (err) => {
      this.lastError = err.message;
    });
    child.on('exit', (code) => this.onExit(child, code));
  }

  private onLine(line: string): void {
    const e = parseConnectLine(line);
    if (!e){
      return;
    }
    switch (e.event){
      case 'ready':
        this.ready = e;
        if (e.until){
          this.until = e.until;
        }
        this.setUp();
        break;
      case 'status':
        if (e.until){
          this.until = e.until;
        }
        if (e.state === 'waiting'){
          this.link = 'waiting';
          this.changed.fire();
        }
        else if (this.ready){
          this.setUp();
        }
        break;
      case 'disconnected':
        this.link = 'reconnecting';
        this.lastError = e.reason || undefined;
        this.changed.fire();
        break;
      case 'video':
        this.video = { streaming: e.streaming, error: e.error };
        this.changed.fire();
        break;
      case 'fatal':
        this.fatal = e.message;
        break;
      default:
        break;
    }
  }

  private setUp(): void {
    const again = this.wasUp && this.link !== 'up';
    this.link = 'up';
    this.wasUp = true;
    this.restarts = 0;
    this.changed.fire();
    if (again){
      this.cameBack.fire();
    }
  }

  private async onExit(child: ChildProcess, code: number | null): Promise<void> {
    if (this.child !== child || this.disposed){
      return;
    }
    this.child = undefined;
    const fatal = this.fatal || this.lastError;
    this.log(`thub connect ${this.client} exited (${code})${fatal ? `: ${fatal}` : ''}`);
    if (/reservation (has )?ended|isn't reserved|reserved by/i.test(fatal || '') || !(await this.stillReserved())){
      return this.end(fatal && /ended/i.test(fatal) ? 'Reservation ended' : fatal || 'Reservation ended');
    }
    this.lastError = fatal;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.disposed){
      return;
    }
    const delay = RESTART_DELAYS_S[Math.min(this.restarts++, RESTART_DELAYS_S.length - 1)];
    this.link = 'reconnecting';
    this.changed.fire();
    this.restartTimer = setTimeout(() => void this.spawn(), delay * 1000);
  }

  /** Ends the session: everything it owned is closed, once. */
  end(reason: string): void {
    if (this.disposed){
      return;
    }
    this.link = 'ended';
    this.ended.fire(reason);
    this.dispose();
  }

  dispose(): void {
    if (this.disposed){
      return;
    }
    this.disposed = true;
    this.link = 'ended';
    clearTimeout(this.restartTimer);
    // SIGINT: thub connect closes its ports and says goodbye; the reservation stays.
    this.child?.kill('SIGINT');
    for (const d of this.owned.splice(0).reverse()){
      try {
        d.dispose();
      }
      catch (err){
        this.log(`dispose: ${(err as Error).message}`);
      }
    }
    this.changed.fire();
    this.changed.dispose();
    this.ended.dispose();
    this.cameBack.dispose();
  }
}
