// Flash after build: when a build task succeeds, its firmware goes onto the
// reserved board (setting thub.flashAfterBuild; design: artboard 7).

import * as vscode from 'vscode';
import type { SessionManager } from '../session/SessionManager';
import type { Flasher, FlashResult } from './Flasher';
import type { Power } from '../power/Power';
import type { SerialTerminals } from '../serial/SerialTerminal';
import { shouldFlash, type FlashAfterBuildConfig } from './match';
import { boardState } from '../cli/parse';
import { mainFolder, settings } from '../util/config';

export interface LastRun {
  at: string;
  buildTask: string;
  buildMs: number | null;
  flash: { ok: boolean; skipped?: boolean; verified: boolean; summary: string; client: string; ms: number } | null;
  then: string;
  error?: string;
}

const LAST_RUN_KEY = 'thub.flashAfterBuild.lastRun';

export class FlashAfterBuild implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private readonly starts = new Map<vscode.TaskExecution, number>();
  private running = false;
  private pending?: () => Promise<void>;
  /** buildAndFlash: flash after this task's next success, even if switched off. */
  private forceNext?: string;
  readonly statusItem = vscode.window.createStatusBarItem('thub.flashAfterBuild', vscode.StatusBarAlignment.Left, 49);
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly mgr: SessionManager,
    private readonly flasher: Flasher,
    private readonly power: Power,
    private readonly serial: SerialTerminals,
    private readonly state: vscode.Memento,
    private readonly log: (line: string) => void
  ){
    this.statusItem.name = 'thub: Flash after build';
    this.statusItem.command = 'thub.toggleFlashAfterBuild';
    this.subs.push(
      this.statusItem,
      vscode.tasks.onDidStartTaskProcess((e) => this.starts.set(e.execution, Date.now())),
      vscode.tasks.onDidEndTaskProcess((e) => this.onTaskEnd(e)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('thub.flashAfterBuild') && this.updateStatus())
    );
    this.updateStatus();
  }

  get lastRun(): LastRun | undefined {
    return this.state.get<LastRun>(LAST_RUN_KEY);
  }

  config(): FlashAfterBuildConfig {
    return settings.flashAfterBuild(mainFolder());
  }

  private updateStatus(): void {
    const on = this.config().enabled;
    this.statusItem.text = `$(arrow-up) Flash after build: ${on ? 'on' : 'off'}`;
    this.statusItem.tooltip = `${on ? 'Successful builds flash the reserved board' : 'Builds don\'t flash the board'} — click to switch ${on ? 'off' : 'on'}`;
    // Shown once it's been set up (on, or a build task chosen).
    if (on || this.config().buildTask){
      this.statusItem.show();
    }
    else {
      this.statusItem.hide();
    }
    this.changed.fire();
  }

  async toggle(): Promise<void> {
    const c = vscode.workspace.getConfiguration('thub', mainFolder()?.uri),
      cur = settings.flashAfterBuild(mainFolder());
    await c.update('flashAfterBuild', { ...cur, enabled: !cur.enabled }, vscode.ConfigurationTarget.Workspace);
    this.updateStatus();
  }

  private onTaskEnd(e: vscode.TaskProcessEndEvent): void {
    const task = e.execution.task,
      folder = typeof task.scope === 'object' ? task.scope as vscode.WorkspaceFolder : mainFolder(),
      cfg = settings.flashAfterBuild(folder),
      finished = {
        name: task.name,
        type: task.definition.type,
        isBuild: task.group?.id === vscode.TaskGroup.Build.id,
        exitCode: e.exitCode
      },
      started = this.starts.get(e.execution);
    this.starts.delete(e.execution);
    const forced = this.forceNext !== undefined && (this.forceNext === task.name || this.forceNext === `${task.definition.type}: ${task.name}`);
    if (forced && e.exitCode !== 0){
      this.forceNext = undefined;
      return;
    }
    if (!forced && !shouldFlash(finished, cfg)){
      return;
    }
    if (forced){
      this.forceNext = undefined;
    }
    const job = () => this.run(cfg, task.name, started ? Date.now() - started : null);
    // One flash at a time; a newer build replaces one still waiting.
    if (this.running){
      this.pending = job;
      this.log('flash after build: a flash is running — this build flashes next');
      return;
    }
    void job();
  }

  private async run(cfg: FlashAfterBuildConfig, buildTask: string, buildMs: number | null): Promise<void> {
    this.running = true;
    const record = (r: Partial<LastRun>) => this.state.update(LAST_RUN_KEY, {
      at: new Date().toISOString(), buildTask, buildMs, flash: null, then: cfg.then, ...r
    } satisfies LastRun).then(() => this.changed.fire());
    try {
      if (!(await this.boardReady(cfg))){
        await record({ error: 'No matching board reserved — skipped' });
        return;
      }
      if (cfg.powerCycle){
        await this.power.run('reset', { delaySec: 2 });
      }
      const r: FlashResult = await this.flasher.flash({
        verify: cfg.verify,
        then: cfg.then === 'run' ? 'run' : 'halt',
        skipUnchanged: cfg.skipUnchanged,
        target: cfg.target || undefined
      });
      await record({ flash: { ok: r.ok, skipped: r.skipped, verified: r.verified, summary: r.summary, client: r.client, ms: r.ms } });
      if (r.ok && cfg.openSerial && this.mgr.session){
        this.serial.show(this.mgr.session, 1, { clear: true });
      }
      if (r.ok && cfg.then === 'debug'){
        await vscode.debug.startDebugging(mainFolder(), {
          type: 'thub', request: 'launch', name: 'thub: Debug on reserved board',
          executable: await this.flasher.resolveImage(cfg.image), flash: false, runToEntryPoint: 'main'
        });
      }
    }
    catch (err){
      const message = (err as Error).message;
      await record({ error: message });
      if (/not found/.test(message)){
        const pick = await vscode.window.showErrorMessage(`Flash after build: ${message}`, 'Open settings');
        if (pick){
          await vscode.commands.executeCommand('thub.configureFlashAfterBuild');
        }
      }
      else {
        void vscode.window.showErrorMessage(`Flash after build: ${message}`);
      }
    }
    finally {
      this.running = false;
      const next = this.pending;
      this.pending = undefined;
      if (next){
        void next();
      }
    }
  }

  /** The configured board is mine and connected — or it's found, asked for or skipped. */
  private async boardReady(cfg: FlashAfterBuildConfig): Promise<boolean> {
    await this.mgr.refresh();
    const mine = this.mgr.mine,
      matches = (name: string, labels: string[]) => cfg.board === 'reserved' || cfg.board === name ||
        (cfg.board.startsWith('label:') && labels.includes(cfg.board.slice(6)));
    if (mine && matches(mine.name, mine.labels)){
      return true;
    }
    if (cfg.whenNoBoard === 'skip'){
      return false;
    }
    const candidate = this.mgr.resources.find((r) => r.type === 'hw' && boardState(r) === 'idle' && matches(r.name, r.labels));
    if (cfg.whenNoBoard === 'ask'){
      const pick = await vscode.window.showWarningMessage(
        `Flash after build: ${cfg.board === 'reserved' ? 'no board is reserved' : `no reservation of ${cfg.board}`}.`,
        ...(candidate ? [`Reserve ${candidate.name} for 1h`] : []), 'Reserve board…', 'Skip');
      if (pick === 'Reserve board…'){
        await vscode.commands.executeCommand('thub.reserve');
        return Boolean(this.mgr.mine);
      }
      if (!pick || pick === 'Skip' || !candidate){
        return false;
      }
    }
    if (!candidate){
      void vscode.window.showWarningMessage(`Flash after build: no idle board matches "${cfg.board}"`);
      return false;
    }
    await this.mgr.reserve(candidate.name, 60, true);
    return true;
  }

  /** thub.buildAndFlash: the configured build task, then a flash. */
  async buildAndFlash(): Promise<void> {
    const cfg = this.config(),
      tasks = await vscode.tasks.fetchTasks(),
      task = cfg.buildTask
        ? tasks.find((t) => t.name === cfg.buildTask || `${t.definition.type}: ${t.name}` === cfg.buildTask)
        : tasks.find((t) => t.group?.id === vscode.TaskGroup.Build.id && t.group?.isDefault) || tasks.find((t) => t.group?.id === vscode.TaskGroup.Build.id);
    if (!task){
      const pick = await vscode.window.showErrorMessage(
        cfg.buildTask ? `Build task "${cfg.buildTask}" not found` : 'No build task in this workspace', 'Flash after build…');
      if (pick){
        await vscode.commands.executeCommand('thub.configureFlashAfterBuild');
      }
      return;
    }
    this.forceNext = task.name;
    await vscode.tasks.executeTask(task);
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
