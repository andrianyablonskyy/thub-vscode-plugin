// USB power of the reserved board (uhubctl on its Client, README §8.7).
//
// Known gap: `thub power` is keyed by a job id and works only for its
// owner's PREPARING/RUNNING job. Until thub supports power for a
// reservation's holder, it's offered only while a job of yours runs on the
// board — never faked.

import * as vscode from 'vscode';
import type { ThubCli } from '../cli/ThubCli';
import type { SessionManager } from '../session/SessionManager';

export type PowerAction = 'on' | 'off' | 'reset';

export type PowerAvailability = { ok: true; jobId: string } | { ok: false; why: string };

export class Power {
  constructor(private readonly cli: ThubCli, private readonly mgr: SessionManager){}

  /** Whether power can be switched now, and through which job. */
  async availability(): Promise<PowerAvailability> {
    const board = this.mgr.mine;
    if (!board){
      return { ok: false, why: 'Reserve a board first.' };
    }
    const jobs = await this.cli.jobs().catch(() => this.mgr.jobs),
      job = jobs.find((j) => (j.state === 'PREPARING' || j.state === 'RUNNING') && j.resource_id === board.id);
    if (!job){
      return {
        ok: false,
        why: `USB power works through a job for now: start one of yours on ${board.name} (thub run --client ${board.name} …) ` +
          'and switch it while it runs. Switching it for the reservation itself needs a newer thub.'
      };
    }
    return { ok: true, jobId: job.id };
  }

  /** Switches it, or says why it can't. */
  async run(action: PowerAction, { port, delaySec }: { port?: number; delaySec?: number } = {}): Promise<boolean> {
    const a = await this.availability();
    if (!a.ok){
      void vscode.window.showWarningMessage(`thub: ${a.why}`);
      return false;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `thub: USB power ${action}${port ? ` (port ${port})` : ''}` },
      () => this.cli.power(action, a.jobId, { port, delaySec: action === 'reset' ? delaySec ?? 2 : undefined })
    );
    void vscode.window.setStatusBarMessage(`thub: USB power ${action} sent — the job's log shows when it's done`, 5000);
    return true;
  }
}
