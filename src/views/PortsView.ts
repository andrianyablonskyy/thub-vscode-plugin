// "THUB PORTS" (design: artboard 5): every local port of the session — UARTs,
// GDB, camera — with Open / Copy actions; custom forwards only where the
// thub CLI supports them (`thub connect --forward`).

import * as vscode from 'vscode';
import type { SessionManager } from '../session/SessionManager';
import type { DebugTracker } from '../debug/ThubDebugProvider';
import { SerialTerminal } from '../serial/SerialTerminal';
import { page } from '../util/webview';
import type { Features } from '../cli/types';

interface Row {
  icon: 'terminal' | 'bug' | 'camera' | 'arrow';
  name: string;
  remote: string;
  local: string;
  status: { text: string; tone: 'ok' | 'idle' | 'err' };
  actions: Array<{ label: string; msg: Record<string, unknown>; primary?: boolean }>;
}

export class PortsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly subs: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly mgr: SessionManager, private readonly debug: DebugTracker, private readonly features: () => Promise<Features>){
    this.subs.push(mgr.onDidChange(() => void this.post()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    // Terminal client counts change without a session event.
    this.timer = setInterval(() => view.visible && void this.post(), 2000);
    view.onDidDispose(() => clearInterval(this.timer));
  }

  refresh(): void {
    void this.post();
  }

  private rows(): Row[] {
    const s = this.mgr.session,
      ready = s?.ready;
    if (!s || !ready){
      return [];
    }
    const rows: Row[] = [];
    for (const p of ready.ports){
      const addr = `127.0.0.1:${p.port}`;
      if (p.kind === 'uart'){
        const n = SerialTerminal.open.get(`${s.client}:uart${p.index}`) || 0;
        rows.push({
          icon: 'terminal', name: `UART ${p.index}`, remote: `${p.label} · ${p.baudRate || 115200} 8N1`, local: addr,
          status: n ? { text: `${n} client${n === 1 ? '' : 's'}`, tone: 'ok' } : { text: 'idle', tone: 'idle' },
          actions: [{ label: 'Open terminal', msg: { type: 'serial', index: p.index }, primary: true }, { label: 'Copy', msg: { type: 'copy', text: `socket://${addr}` } }]
        });
      }
      else {
        const debugging = this.debug.active?.configuration.thubReservation === s.reservationId;
        rows.push({
          icon: 'bug', name: `GDB · ST-Link ${p.index}`, remote: `OpenOCD · ${p.target || s.target || 'runner card\'s target'}`, local: addr,
          status: debugging ? { text: 'debugging', tone: 'ok' } : { text: 'idle', tone: 'idle' },
          actions: [
            { label: 'Debug', msg: { type: 'command', command: 'thub.debug' }, primary: true },
            { label: 'Flash', msg: { type: 'command', command: 'thub.flash' }, primary: true },
            { label: 'Copy', msg: { type: 'copy', text: addr } }
          ]
        });
      }
    }
    if (ready.video){
      const v = s.video,
        streaming = v ? v.streaming : true;
      rows.push({
        icon: 'camera', name: 'Camera', remote: `video-stream · MPEG-TS`, local: ready.video.url.replace(/^http:\/\//, ''),
        status: streaming ? { text: 'streaming', tone: 'ok' } : { text: v?.error ? `not streaming — ${v.error}` : 'starting…', tone: v?.error ? 'err' : 'idle' },
        actions: [{ label: 'Open', msg: { type: 'command', command: 'thub.openVideo' }, primary: true }, { label: 'Copy', msg: { type: 'copy', text: ready.video.url } }]
      });
    }
    return rows;
  }

  private async post(): Promise<void> {
    if (!this.view){
      return;
    }
    const s = this.mgr.session,
      f = await this.features();
    await this.view.webview.postMessage({
      type: 'state',
      header: s ? `${s.client} · ${linkText(s.link)}` : '',
      hasSession: Boolean(s),
      hasReservation: Boolean(this.mgr.mine),
      rows: this.rows(),
      canForward: f.connectForward
    });
  }

  private async onMessage(m: { type: string; index?: number; text?: string; command?: string }): Promise<void> {
    if (m.type === 'ready'){
      return this.post();
    }
    if (m.type === 'serial'){
      await vscode.commands.executeCommand('thub.openSerial', m.index);
    }
    else if (m.type === 'copy' && m.text){
      await vscode.env.clipboard.writeText(m.text);
      void vscode.window.setStatusBarMessage(`thub: copied ${m.text}`, 3000);
    }
    else if (m.type === 'command' && m.command?.startsWith('thub.')){
      await vscode.commands.executeCommand(m.command);
    }
  }

  private html(webview: vscode.Webview): string {
    const body = `
<div class="top"><span></span><span class="muted" id="header"></span></div>
<div id="empty" class="muted"></div>
<table id="table"><thead><tr><th>Name</th><th>On the board's Client</th><th>Local address</th><th>Status</th><th class="right">Actions</th></tr></thead><tbody id="rows"></tbody></table>
<div id="forward" class="muted small"></div>`,
      css = `
body { padding: 6px 16px; }
.top { display: flex; justify-content: space-between; margin-bottom: 4px; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: .78em; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--border); }
td { padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td.remote, td.local { font-family: var(--vscode-editor-font-family); }
.right { text-align: right; }
.act { border: 0; background: none; padding: 0 0 0 14px; color: var(--muted); }
.act.primary { color: var(--accent); }
.tone-ok { color: var(--ok); } .tone-err { color: var(--error); }
.small { font-size: .9em; margin-top: 10px; }
`,
      script = `
const $ = (s) => document.querySelector(s), esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const ICON = { terminal: '>_', bug: '⏻', camera: '▭', arrow: '→' };
window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  $('#header').textContent = data.header;
  $('#table').style.display = data.rows.length ? 'table' : 'none';
  $('#empty').innerHTML = data.rows.length ? '' : data.hasSession ? 'Connecting… the ports appear once the board\\'s Client is linked.'
    : data.hasReservation ? 'Your board isn\\'t connected. <button class="link" id="connect">Connect</button>'
    : 'No board reserved. <button class="link" id="reserve">Reserve a board</button>';
  $('#connect')?.addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'thub.connect' }));
  $('#reserve')?.addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'thub.reserve' }));
  $('#rows').innerHTML = data.rows.map((r, i) => '<tr><td>' + ICON[r.icon] + ' ' + esc(r.name) + '</td><td class="remote">' + esc(r.remote) +
    '</td><td class="local">' + esc(r.local) + '</td><td class="tone-' + r.status.tone + '"><span class="dot ' + (r.status.tone === 'ok' ? 'ok' : r.status.tone === 'err' ? 'err' : 'idle') + '"></span>' +
    esc(r.status.text) + '</td><td class="right">' + r.actions.map((a, j) => '<button class="act' + (a.primary ? ' primary' : '') + '" data-r="' + i + '" data-a="' + j + '">' + esc(a.label) + '</button>').join('') + '</td></tr>').join('');
  document.querySelectorAll('.act').forEach((b) => b.onclick = () => vscode.postMessage(data.rows[b.dataset.r].actions[b.dataset.a].msg));
  $('#forward').textContent = !data.rows.length ? '' : data.canForward ? '' :
    'Custom port forwards (a host:port on the Client to a local port) need a thub CLI with connect --forward — not available yet.';
});
vscode.postMessage({ type: 'ready' });
`;
    return page(webview, { title: 'thub Ports', body, script, extraCss: css });
  }

  dispose(): void {
    clearInterval(this.timer);
    this.subs.forEach((s) => s.dispose());
  }
}

export function linkText(link: string): string {
  return ({ starting: 'connecting', waiting: 'waiting for its Client', up: 'link up', reconnecting: 'reconnecting', ended: 'ended' } as Record<string, string>)[link] || link;
}
