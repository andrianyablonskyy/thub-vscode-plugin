// Debug type "thub": makes sure the board is reserved and connected, then
// hands Cortex-Debug an external-server configuration on the GDB port that
// `thub connect` opened (design: artboard 2).

import * as vscode from 'vscode';
import type { SessionManager } from '../session/SessionManager';
import type { Session } from '../session/Session';
import { settings } from '../util/config';

export const DEFAULT_LAUNCH: vscode.DebugConfiguration = {
  type: 'thub',
  request: 'launch',
  name: 'thub: Debug on reserved board',
  executable: '${workspaceFolder}/build/${workspaceFolderBasename}.elf',
  flash: true,
  runToEntryPoint: 'main'
};

export class ThubDebugProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly mgr: SessionManager){}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [DEFAULT_LAUNCH];
  }

  async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    // F5 with no launch.json: debug the default ELF on the reserved board.
    if (!config.type && !config.request && !config.name){
      config = { ...DEFAULT_LAUNCH, executable: settings.flashAfterBuild(folder).image };
    }
    if (config.type !== 'thub'){
      return config;
    }
    let session: Session;
    try {
      session = await this.mgr.ensureUp('Debugging', config.target, typeof config.thubClient === 'string' ? config.thubClient : undefined);
    }
    catch (err){
      void vscode.window.showErrorMessage(`thub: ${(err as Error).message}`);
      return undefined;
    }
    const probe = Number(config.probe) || 1,
      port = session.gdbPort(probe);
    if (!port){
      void vscode.window.showErrorMessage(`thub: ${session.client} has no ST-Link ${probe} (no GDB port)`);
      return undefined;
    }
    return toCortexDebug(config, session, port, folder);
  }
}

/** The Cortex-Debug configuration for a thub one (servertype "external"). */
export function toCortexDebug(config: vscode.DebugConfiguration, session: Session, port: number, folder?: vscode.WorkspaceFolder): vscode.DebugConfiguration {
  const flash = config.request === 'launch' && config.flash !== false,
    svd = config.svdFile || settings.svdFile();
  return {
    type: 'cortex-debug',
    request: config.request === 'attach' ? 'attach' : 'launch',
    name: config.name || `thub: ${session.client}`,
    cwd: folder?.uri.fsPath,
    servertype: 'external',
    gdbTarget: `127.0.0.1:${port}`,
    gdbPath: settings.gdbPath(),
    executable: config.executable,
    ...(svd ? { svdFile: svd } : {}),
    ...(config.runToEntryPoint && config.request !== 'attach' ? { runToEntryPoint: config.runToEntryPoint } : {}),
    overrideLaunchCommands: flash
      ? ['set remotetimeout 30', 'monitor reset halt', 'load', 'monitor reset halt']
      : ['set remotetimeout 30', 'monitor reset halt'],
    overrideAttachCommands: ['set remotetimeout 30'],
    overrideRestartCommands: ['monitor reset halt'],
    overrideResetCommands: ['monitor reset halt'],
    // Ours: which reservation this debug session belongs to.
    thubClient: session.client,
    thubReservation: session.reservationId,
    thubExecutable: config.executable
  };
}

/** Tracks thub debug sessions: context key, and reattaching after a link drop. */
export class DebugTracker implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private readonly sessions = new Map<string, vscode.DebugSession>();

  get active(): vscode.DebugSession | undefined {
    return [...this.sessions.values()].at(-1);
  }

  isDebugging(reservationId: string | undefined): boolean {
    return reservationId ? this.sessions.has(reservationId) : false;
  }

  debugSession(reservationId: string): vscode.DebugSession | undefined {
    return this.sessions.get(reservationId);
  }

  constructor(private readonly mgr: SessionManager, private readonly onChange: () => void){
    this.subs.push(
      vscode.debug.onDidStartDebugSession((s) => {
        if (s.configuration.thubReservation){
          this.sessions.set(s.configuration.thubReservation, s);
          this.updateContexts();
          this.onChange();
        }
      }),
      vscode.debug.onDidTerminateDebugSession((s) => {
        const reservation = s.configuration.thubReservation;
        if (reservation && this.sessions.get(reservation) === s){
          this.sessions.delete(reservation);
          this.updateContexts();
          this.onChange();
        }
      })
    );
  }

  private updateContexts(): void {
    void vscode.commands.executeCommand('setContext', 'thub.debugging', this.sessions.size > 0);
    void vscode.commands.executeCommand('setContext', 'thub.debuggingHil',
      [...this.sessions.values()].some((session) => typeof session.configuration.thubClient === 'string' &&
        this.mgr.findMine(session.configuration.thubClient)?.type === 'hw'));
  }

  /** The link came back: the debugger has to reattach (it can't survive a drop). */
  async offerReattach(session: Session): Promise<void> {
    const s = this.sessions.get(session.reservationId);
    if (!s){
      return;
    }
    const pick = await vscode.window.showInformationMessage(
      `Link to ${session.client} came back. Serial stayed connected. The debug session has to reattach.`, 'Reattach debugger');
    if (pick){
        await this.reattach(s);
    }
  }

  async reattach(session?: vscode.DebugSession): Promise<void> {
      const s = session || this.active,
      executable = s?.configuration.thubExecutable;
    if (s){
      await vscode.debug.stopDebugging(s);
    }
    await vscode.debug.startDebugging(s?.workspaceFolder, {
      type: 'thub', request: 'attach', name: `thub: Attach (${s?.configuration.thubClient || 'reserved board'})`,
      executable: executable || '${workspaceFolder}/build/${workspaceFolderBasename}.elf',
      thubClient: s?.configuration.thubClient
    });
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
  }
}
