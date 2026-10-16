// Status bar (design: artboard 6): the reservation with its countdown, and
// link / UART / GDB indicators.

import * as vscode from 'vscode';
import type { SessionManager } from '../session/SessionManager';
import type { DebugTracker } from '../debug/ThubDebugProvider';
import { SerialTerminal } from '../serial/SerialTerminal';
import { formatLeft, msUntil } from '../cli/parse';

export class StatusBar implements vscode.Disposable {
  private readonly main = vscode.window.createStatusBarItem('thub.session', vscode.StatusBarAlignment.Left, 100);
  private readonly link = vscode.window.createStatusBarItem('thub.link', vscode.StatusBarAlignment.Left, 99);
  private readonly uart = vscode.window.createStatusBarItem('thub.uart', vscode.StatusBarAlignment.Left, 98);
  private readonly gdb = vscode.window.createStatusBarItem('thub.gdb', vscode.StatusBarAlignment.Left, 97);
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly mgr: SessionManager, private readonly debug: DebugTracker){
    this.main.name = 'thub: reservation';
    this.link.name = 'thub: link';
    this.uart.name = 'thub: UART';
    this.gdb.name = 'thub: GDB';
    this.uart.command = 'thub.openSerial';
    this.gdb.command = 'thub.debug';
    mgr.onDidChange(() => this.update());
    this.timer = setInterval(() => this.update(), 2000);
    this.update();
  }

  update(): void {
    const mine = this.mgr.mine,
      s = this.mgr.session;
    if (!this.mgr.signedIn){
      this.main.text = '$(plug) thub: Sign in';
      this.main.command = 'thub.signIn';
      this.main.backgroundColor = undefined;
      this.main.show();
      [this.link, this.uart, this.gdb].forEach((i) => i.hide());
      return;
    }
    if (!mine){
      this.main.text = '$(plug) thub: Reserve…';
      this.main.tooltip = 'Reserve a board in your TestHub lab';
      this.main.command = 'thub.reserve';
      this.main.backgroundColor = undefined;
      this.main.show();
      [this.link, this.uart, this.gdb].forEach((i) => i.hide());
      return;
    }
    const leftMs = msUntil(mine.reservation?.until),
      expiring = leftMs < 10 * 60_000,
      debugging = this.debug.active?.configuration.thubReservation === mine.reservation?.id;
    if (s && (s.link === 'reconnecting' || s.link === 'starting' || s.link === 'waiting')){
      this.main.text = `$(sync~spin) ${mine.name} · ${s.link === 'reconnecting' ? 'reconnecting' : 'connecting'}`;
    }
    else if (debugging){
      this.main.text = `$(debug-alt) Debugging on ${mine.name} · ${formatLeft(leftMs)} left`;
    }
    else {
      this.main.text = `$(lock) ${mine.name} · ${expiring ? `${formatLeft(leftMs)} left` : formatLeft(leftMs)}`;
    }
    this.main.tooltip = new vscode.MarkdownString(`**${mine.name}** reserved until ${new Date(mine.reservation!.until).toLocaleTimeString()}` +
      (expiring ? '\n\n[Extend 1h](command:thub.extend)' : ''));
    this.main.tooltip.isTrusted = { enabledCommands: ['thub.extend'] };
    this.main.command = expiring ? 'thub.extend' : s ? { command: 'workbench.view.extension.thub', title: 'Show thub' } : 'thub.connect';
    this.main.backgroundColor = new vscode.ThemeColor(expiring ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground');
    this.main.show();
    if (!s){
      this.link.text = '$(debug-disconnect) not connected';
      this.link.command = 'thub.connect';
      this.link.show();
      this.uart.hide();
      this.gdb.hide();
      return;
    }
    this.link.text = s.link === 'up' ? '$(circle-filled) link up' : s.link === 'reconnecting' ? '$(circle-outline) UART held' : '$(circle-outline) link';
    this.link.color = s.link === 'up' ? new vscode.ThemeColor('thub.ok') : undefined;
    this.link.tooltip = s.lastError && s.link !== 'up' ? s.lastError : undefined;
    this.link.command = 'thub.showLog';
    this.link.show();
    const uarts = [...SerialTerminal.open.entries()].filter(([k]) => k.startsWith(`${s.client}:`)).reduce((n, [, v]) => n + v, 0);
    this.uart.text = `UART ${uarts ? '●' : '○'}`;
    this.uart.tooltip = uarts ? `${uarts} serial terminal${uarts === 1 ? '' : 's'} open` : 'Open the serial terminal';
    this.gdb.text = `GDB ${debugging ? '●' : '○'}`;
    this.gdb.tooltip = debugging ? 'Debugging' : 'Debug on the reserved board';
    if (s.ready?.ports.some((p) => p.kind === 'uart')){
      this.uart.show();
    }
    else {
      this.uart.hide();
    }
    if (s.ready?.ports.some((p) => p.kind === 'swd')){
      this.gdb.show();
    }
    else {
      this.gdb.hide();
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    [this.main, this.link, this.uart, this.gdb].forEach((i) => i.dispose());
  }
}
