// thub for VS Code: wires the pieces together on activation — nothing else.

import * as vscode from 'vscode';
import { ThubCli, ThubError } from './cli/ThubCli';
import { SessionManager } from './session/SessionManager';
import { BoardsTree } from './views/BoardsTree';
import { PortsView } from './views/PortsView';
import { StatusBar } from './views/StatusBar';
import { SerialTerminals } from './serial/SerialTerminal';
import { DEFAULT_LAUNCH, DebugTracker, ThubDebugProvider } from './debug/ThubDebugProvider';
import { Flasher, ThubTaskProvider } from './flash/Flasher';
import { FlashAfterBuild } from './flash/FlashAfterBuild';
import { FlashSettingsPanel } from './flash/FlashSettingsPanel';
import { VideoPanel } from './video/VideoPanel';
import { Power } from './power/Power';
import { forwardPort } from './forward/Forwards';
import { reserveFlow } from './reserve/reserveFlow';
import { Log } from './util/log';
import { mainFolder, settings } from './util/config';
import { formatLeft, msUntil } from './cli/parse';

const KEY_SECRET = 'thub.key',
  AGENT_PACKAGE = '@andrian.yablonskyy/thub-agent';

export function activate(context: vscode.ExtensionContext): void {
  const log = new Log(),
    cli = new ThubCli({
      cliPath: settings.cliPath,
      url: settings.url,
      key: async () => {
        const key = await context.secrets.get(KEY_SECRET);
        log.setSecret(key);
        return key;
      },
      log: log.line
    }),
    mgr = new SessionManager(cli, log.line),
    power = new Power(cli, mgr),
    serial = new SerialTerminals(),
    flasher = new Flasher(mgr, context.workspaceState, log),
    debugTracker = new DebugTracker(() => {
      statusBar.update();
      ports.refresh();
    }),
    fab = new FlashAfterBuild(mgr, flasher, power, serial, context.workspaceState, log.line),
    tree = new BoardsTree(mgr),
    treeView = vscode.window.createTreeView('thub.boards', { treeDataProvider: tree, showCollapseAll: false }),
    ports = new PortsView(mgr, debugTracker, () => cli.getFeatures()),
    statusBar = new StatusBar(mgr, debugTracker);

  context.subscriptions.push(
    log, mgr, debugTracker, fab, treeView, ports, statusBar,
    treeView.onDidChangeVisibility((e) => mgr.setVisible(e.visible)),
    vscode.window.registerWebviewViewProvider('thub.ports', ports),
    vscode.tasks.registerTaskProvider('thub', new ThubTaskProvider(flasher)),
    vscode.debug.registerDebugConfigurationProvider('thub', new ThubDebugProvider(mgr)),
    vscode.debug.registerDebugConfigurationProvider('thub', { provideDebugConfigurations: () => [DEFAULT_LAUNCH] },
      vscode.DebugConfigurationProviderTriggerKind.Dynamic),
    mgr.onDidStartSession((session) => {
      session.onDidReconnect(() => void debugTracker.offerReattach(session));
    })
  );

  // Every command reports its failure; an auth/usage failure (exit 4) offers Sign in.
  const command = (id: string, fn: (...args: never[]) => unknown) => context.subscriptions.push(
    vscode.commands.registerCommand(id, async (...args: never[]) => {
      try {
        return await fn(...args);
      }
      catch (err){
        const message = (err as Error).message;
        log.line(`${id}: ${message}`);
        if (err instanceof ThubError && err.kind === 'auth' && /key|sign in|401|THUB_KEY|access/i.test(message)){
          const pick = await vscode.window.showErrorMessage(`thub: ${message}`, 'Sign in to thub');
          if (pick){
            await vscode.commands.executeCommand('thub.signIn');
          }
        }
        else if (!/^Canceled/.test(message)){
          void vscode.window.showErrorMessage(`thub: ${message}`);
        }
        return undefined;
      }
    })
  );

  command('thub.signIn', async () => {
    const url = await vscode.window.showInputBox({
      title: 'thub: Sign in (1/2)', prompt: 'Your TestHub Coordinator', value: settings.url() || 'https://',
      validateInput: (v) => (/^https?:\/\/[^/\s]+/.test(v.trim()) ? undefined : 'An http(s):// address, e.g. https://thub.example.com')
    });
    if (!url){
      return;
    }
    const key = await vscode.window.showInputBox({
      title: 'thub: Sign in (2/2)', prompt: 'Your access key (from your dashboard profile, or an admin) — kept in VS Code\'s secret storage',
      password: true, placeHolder: 'thk_…', ignoreFocusOut: true
    });
    if (!key){
      return;
    }
    await vscode.workspace.getConfiguration('thub').update('url', url.trim().replace(/\/+$/, ''), vscode.ConfigurationTarget.Global);
    await context.secrets.store(KEY_SECRET, key.trim());
    mgr.forgetIdentity();
    await mgr.refresh();
    if (!mgr.signedIn){
      throw new Error(mgr.lastError || 'Sign-in failed');
    }
    const who = mgr.me?.user ? `${mgr.me.user.username} (${mgr.me.user.role})` : mgr.me?.name || 'your key';
    void vscode.window.showInformationMessage(`thub: signed in to ${url} as ${who}`);
  });
  command('thub.signOut', async () => {
    mgr.session?.end('Signed out');
    await context.secrets.delete(KEY_SECRET);
    mgr.forgetIdentity();
    mgr.setSignedIn(false);
    await mgr.refresh();
  });
  command('thub.refresh', () => mgr.refresh());
  command('thub.showLog', () => log.show());
  command('thub.reserve', (name?: string) => reserveFlow(mgr, typeof name === 'string' ? name : undefined));
  command('thub.extend', async () => {
    await mgr.extend(60);
    const mine = mgr.mine;
    if (mine?.reservation){
      void vscode.window.showInformationMessage(`thub: ${mine.name} is yours for ${formatLeft(msUntil(mine.reservation.until))} more`);
    }
  });
  command('thub.release', async () => {
    const name = mgr.mine?.name || mgr.session?.client;
    if (!name){
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Release ${name}? Its terminals, camera and debug session close.`, { modal: true }, 'Release');
    if (ok){
      await mgr.release();
    }
  });
  command('thub.connect', async () => {
    const session = await mgr.connect();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `thub: connecting to ${session.client}` },
      () => session.whenUp());
  });
  command('thub.flash', async () => {
    const cfg = settings.flashAfterBuild(mainFolder());
    await flasher.flash({ verify: cfg.verify, then: 'run', target: cfg.target || undefined });
  });
  command('thub.buildAndFlash', () => fab.buildAndFlash());
  command('thub.configureFlashAfterBuild', () => FlashSettingsPanel.show(fab, mgr));
  command('thub.toggleFlashAfterBuild', () => fab.toggle());
  command('thub.debug', async () => {
    const folder = mainFolder();
    await vscode.debug.startDebugging(folder, { ...DEFAULT_LAUNCH, executable: settings.flashAfterBuild(folder).image });
  });
  command('thub.reattachDebugger', () => debugTracker.reattach());
  command('thub.openSerial', async (index?: number) => {
    const session = await mgr.ensureUp('The serial port'),
      uarts = session.ready?.ports.filter((p) => p.kind === 'uart') || [];
    if (!uarts.length){
      throw new Error(`${session.client} has no UARTs`);
    }
    let n = typeof index === 'number' ? index : undefined;
    if (n === undefined){
      n = uarts.length === 1 ? uarts[0].index : (await vscode.window.showQuickPick(
        uarts.map((u) => ({ label: `UART ${u.index}`, description: `${u.label} · ${u.baudRate || 115200} 8N1 · 127.0.0.1:${u.port}`, index: u.index })),
        { title: `thub: ${session.client} — which UART?` }))?.index;
    }
    if (n !== undefined){
      serial.show(session, n);
    }
  });
  command('thub.openVideo', async () => {
    const session = await mgr.ensureUp('The camera');
    if (!session.videoUrl){
      throw new Error(`${session.client} has no camera (runners with one carry the label video-stream)`);
    }
    VideoPanel.show(session, power);
  });
  command('thub.powerCycle', () => power.run('reset', { delaySec: 2 }));
  command('thub.powerOn', () => power.run('on'));
  command('thub.powerOff', () => power.run('off'));
  command('thub.forwardPort', () => forwardPort(() => cli.getFeatures()));
  command('thub.copyEndpoint', async (node?: { address?: string }) => {
    if (node?.address){
      await vscode.env.clipboard.writeText(node.address);
      void vscode.window.setStatusBarMessage(`thub: copied ${node.address}`, 3000);
    }
  });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('thub.url') || e.affectsConfiguration('thub.cliPath')){
      cli.reset();
      mgr.forgetIdentity();
      void mgr.refresh();
    }
  }));

  void startup(cli, mgr, log);
}

/** The thub CLI is there and new enough; then the first refresh. */
async function startup(cli: ThubCli, mgr: SessionManager, log: Log): Promise<void> {
  const version = await cli.version();
  if (!version){
    log.line(`thub CLI not found (${cli.command})`);
    const pick = await vscode.window.showWarningMessage(
      'thub: the thub CLI (the TestHub Agent) isn\'t installed — the extension runs it for everything.', 'Install it', 'Set its path');
    if (pick === 'Install it'){
      const term = vscode.window.createTerminal('thub: install');
      term.show();
      term.sendText(`npm i -g ${AGENT_PACKAGE}`);
    }
    else if (pick === 'Set its path'){
      await vscode.commands.executeCommand('workbench.action.openSettings', 'thub.cliPath');
    }
    void vscode.commands.executeCommand('setContext', 'thub.signedIn', false);
    return;
  }
  log.line(`thub CLI ${version}`);
  const f = await cli.getFeatures();
  if (!f.reserve){
    const pick = await vscode.window.showWarningMessage(`thub: this thub CLI (${version}) has no reservations — update it.`, 'Update');
    if (pick){
      const term = vscode.window.createTerminal('thub: update');
      term.show();
      term.sendText(`npm i -g ${AGENT_PACKAGE}@latest`);
    }
  }
  await mgr.refresh();
}

export function deactivate(): void {
  // Disposables (the session's thub connect included) go with the context.
}
