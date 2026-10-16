// Flashing the reserved board: a batch GDB `load` over the GDB port that
// `thub connect` opened (each GDB connection gets its own OpenOCD on the
// Client). Also the `thub` task type ({"type": "thub", "action": "flash"}).

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { SessionManager } from '../session/SessionManager';
import type { Session } from '../session/Session';
import { flashArgs, readFlashOutput, type FlashOutcome } from './gdb';
import { resolveVariables } from './match';
import { mainFolder, settings } from '../util/config';

export interface FlashRequest {
  /** Default: thub.flashAfterBuild.image. */
  image?: string;
  verify?: boolean;
  then?: 'run' | 'halt';
  skipUnchanged?: boolean;
  /** For a task: output goes here, no notifications. */
  write?: (text: string) => void;
  token?: vscode.CancellationToken;
  target?: string;
}

export interface FlashResult extends FlashOutcome {
  skipped?: boolean;
  image: string;
  client: string;
  ms: number;
  output: string;
}

const LAST_HASH_KEY = 'thub.lastFlashed';

export class Flasher {
  private busy?: Promise<FlashResult>;
  private readonly finished = new vscode.EventEmitter<FlashResult>();
  readonly onDidFlash = this.finished.event;

  constructor(
    private readonly mgr: SessionManager,
    private readonly state: vscode.Memento,
    private readonly log: { line: (t: string) => void; show: () => void }
  ){}

  get isBusy(): boolean {
    return Boolean(this.busy);
  }

  /** The image path, its variables resolved. */
  async resolveImage(image: string | undefined, folder = mainFolder()): Promise<string> {
    const raw = image || settings.flashAfterBuild(folder).image;
    return resolveVariables(raw, {
      workspaceFolder: folder?.uri.fsPath,
      env: (n) => process.env[n],
      config: (k) => vscode.workspace.getConfiguration().get(k),
      command: (id) => Promise.resolve(vscode.commands.executeCommand(id))
    });
  }

  /** One flash at a time. */
  async flash(req: FlashRequest = {}): Promise<FlashResult> {
    if (this.busy){
      throw new Error('A flash is already running');
    }
    this.busy = this.doFlash(req);
    try {
      return await this.busy;
    }
    finally {
      this.busy = undefined;
    }
  }

  private async doFlash(req: FlashRequest): Promise<FlashResult> {
    const quiet = Boolean(req.write),
      write = req.write || ((t: string) => this.log.line(t.trimEnd()));
    // Flash and debug can't share the probe: stop a thub debug session first.
    const debugging = vscode.debug.activeDebugSession;
    if (debugging?.configuration.thubReservation){
      const pick = quiet ? 'Stop debugging and flash' : await vscode.window.showWarningMessage(
        'Flashing needs the probe the debugger is using.', { modal: true }, 'Stop debugging and flash');
      if (!pick){
        throw new Error('Canceled: stop debugging first');
      }
      await vscode.debug.stopDebugging(debugging);
    }
    const session = await this.mgr.ensureUp('Flashing', req.target),
      port = session.gdbPort(1);
    if (!port){
      throw new Error(`${session.client} has no ST-Link (no GDB port)`);
    }
    const image = await this.resolveImage(req.image);
    if (!fs.existsSync(image)){
      throw new Error(`Firmware image not found: ${image}`);
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex'),
      last = this.state.get<Record<string, string>>(LAST_HASH_KEY, {}),
      board = `${session.client}:${session.reservationId}`,
      verify = req.verify ?? true,
      then = req.then ?? 'run',
      started = Date.now();
    if (req.skipUnchanged && last[board] === hash){
      write(`thub: ${path.basename(image)} is already on ${session.client} — skipped\n`);
      return { ok: true, verified: false, skipped: true, summary: 'Unchanged — skipped', image, client: session.client, ms: 0, output: '' };
    }
    const args = flashArgs({ image, gdbPort: port, verify, then }),
      run = (token?: vscode.CancellationToken) => this.runGdb(args, write, token);
    write(`$ ${settings.gdbPath()} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n`);
    const { code, output } = quiet
      ? await run(req.token)
      : await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `thub: flashing ${path.basename(image)} to ${session.client}`,
        cancellable: true
      }, (_p, token) => run(token));
    const outcome = readFlashOutput(output, code, verify),
      result: FlashResult = { ...outcome, image, client: session.client, ms: Date.now() - started, output };
    if (outcome.ok){
      await this.state.update(LAST_HASH_KEY, { ...last, [board]: hash });
    }
    this.finished.fire(result);
    if (!quiet){
      void this.report(result, session, req);
    }
    return result;
  }

  private runGdb(args: string[], write: (t: string) => void, token?: vscode.CancellationToken): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(settings.gdbPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      const take = (d: Buffer) => {
          output += d;
          write(String(d));
        },
        sub = token?.onCancellationRequested(() => child.kill());
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (err: NodeJS.ErrnoException) => {
        sub?.dispose();
        reject(err.code === 'ENOENT'
          ? new Error(`${settings.gdbPath()} isn't installed (set thub.gdbPath, e.g. gdb-multiarch)`)
          : err);
      });
      child.on('close', (code) => {
        sub?.dispose();
        resolve({ code: token?.isCancellationRequested ? null : code, output: token?.isCancellationRequested ? `${output}\nCanceled` : output });
      });
    });
  }

  private async report(r: FlashResult, _session: Session, req: FlashRequest): Promise<void> {
    if (r.ok){
      const pick = await vscode.window.showInformationMessage(
        `Flashed ${vscode.workspace.asRelativePath(r.image)} to ${r.client}. ${r.summary}`, 'Show log', 'Open serial');
      if (pick === 'Show log'){
        this.log.show();
      }
      else if (pick === 'Open serial'){
        await vscode.commands.executeCommand('thub.openSerial');
      }
      return;
    }
    const pick = await vscode.window.showErrorMessage(`Flash failed: ${r.summary}`, 'Show log', 'Power-cycle and retry');
    if (pick === 'Show log'){
      this.log.show();
    }
    else if (pick === 'Power-cycle and retry'){
      if (await vscode.commands.executeCommand<boolean>('thub.powerCycle')){
        await new Promise((res) => setTimeout(res, 3000));
        await this.flash(req).catch((err) => vscode.window.showErrorMessage(`Flash failed: ${err.message}`));
      }
    }
  }
}

/** The `thub` task: {"type": "thub", "action": "flash", "image"?, "then"?}. */
export class ThubTaskProvider implements vscode.TaskProvider {
  constructor(private readonly flasher: Flasher){}

  provideTasks(): vscode.Task[] {
    return [this.make({ type: 'thub', action: 'flash' })];
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    return task.definition.action === 'flash' ? this.make(task.definition, task.scope) : undefined;
  }

  private make(def: vscode.TaskDefinition, scope: vscode.TaskScope | vscode.WorkspaceFolder = vscode.TaskScope.Workspace): vscode.Task {
    const task = new vscode.Task(def, scope, 'flash reserved board', 'thub', new vscode.CustomExecution(async () => new FlashTaskTerminal(this.flasher, def)));
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
    return task;
  }
}

class FlashTaskTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private readonly cancel = new vscode.CancellationTokenSource();

  constructor(private readonly flasher: Flasher, private readonly def: vscode.TaskDefinition){}

  open(): void {
    const write = (t: string) => this.writeEmitter.fire(t.replace(/\r?\n/g, '\r\n'));
    this.flasher.flash({ image: this.def.image, then: this.def.then, write, token: this.cancel.token })
      .then((r) => {
        write(`\nthub: ${r.ok ? '✓' : '✗'} ${r.summary}\n`);
        this.closeEmitter.fire(r.ok ? 0 : 1);
      }, (err: Error) => {
        write(`\nthub: ✗ ${err.message}\n`);
        this.closeEmitter.fire(1);
      });
  }

  close(): void {
    this.cancel.cancel();
  }
}
