// "THUB PORTS" (design: artboard 5): every local port of the session — UARTs,
// GDB, camera and named Client services — with Open / Copy actions.

import * as vscode from 'vscode';
import type { SessionManager } from '../session/SessionManager';
import type { DebugTracker } from '../debug/ThubDebugProvider';
import { SerialTerminal } from '../serial/SerialTerminal';
import { ICONS, page } from '../util/webview';
import type { Features } from '../cli/types';

interface Row {
  icon: 'terminal' | 'bug' | 'camera' | 'arrow';
  name: string;
  remote: string;
  local: string;
  status: { text: string; tone: 'ok' | 'idle' | 'err' };
  actions: Array<{ label: string; msg: Record<string, unknown>; primary?: boolean; icon?: 'open' | 'copy' | 'edit' | 'remove' }>;
}

const ACTION_ICONS = {
  open: ICONS.external,
  copy: ICONS.copy,
  edit: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
  remove: '<svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg>'
},
ADD_ICONS = {
  rtt: '<svg class="icon" viewBox="0 0 24 24"><path d="M3 7l5 5-5 5M10 18h5"/><path d="M19 8v8m-4-4h8"/></svg>',
  forward: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 12h13m-5-5 5 5-5 5"/><path d="M20 5v6m-3-3h6"/></svg>'
};

export class PortsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly subs: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly mgr: SessionManager,
    private readonly debug: DebugTracker,
    private readonly features: () => Promise<Features>,
    private readonly log: (line: string) => void
  ){
    this.subs.push(mgr.onDidChange(() => this.postSafely()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    clearInterval(this.timer);
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    const messageSubscription = view.webview.onDidReceiveMessage((m) => {
      void this.onMessage(m).catch((err: unknown) => this.log(`Ports view message failed: ${errorText(err)}`));
    });
    // Terminal client counts change without a session event.
    const timer = setInterval(() => view.visible && this.postSafely(), 2000);
    this.timer = timer;
    view.onDidDispose(() => {
      messageSubscription.dispose();
      clearInterval(timer);
      if (this.view === view){
        this.view = undefined;
        this.timer = undefined;
      }
    });
  }

  refresh(): void {
    this.postSafely();
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
      else if (p.kind === 'rtt'){
        rows.push({
          icon: 'terminal', name: `RTT · ST-Link ${p.index} · CH ${p.channel ?? 0}`,
          remote: `OpenOCD RTT up-channel · ${p.label}`, local: addr,
          status: s.isUp ? { text: 'reading available', tone: 'ok' } : { text: s.link, tone: 'idle' },
          actions: [
            { label: 'Open logs', msg: { type: 'command', command: 'thub.openRtt', index: p.index }, primary: true, icon: 'open' },
            { label: 'Copy', msg: { type: 'copy', text: `socket://${addr}` }, icon: 'copy' },
            { label: 'Configure', msg: { type: 'command', command: 'thub.configureRtt', index: p.index }, icon: 'edit' },
            { label: 'Remove', msg: { type: 'command', command: 'thub.removeRtt', index: p.index }, icon: 'remove' }
          ]
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
    for (const service of ready.forwards || []){
      rows.push({
        icon: 'arrow', name: service.name, remote: `localhost:${service.clientPort}`, local: `127.0.0.1:${service.port}`,
        status: s.isUp ? { text: 'forwarding', tone: 'ok' } : { text: s.link, tone: 'idle' },
        actions: [
          { label: 'Open', msg: { type: 'command', command: 'thub.openForward', name: service.name }, primary: true, icon: 'open' },
          { label: 'Copy', msg: { type: 'command', command: 'thub.copyForward', name: service.name }, icon: 'copy' },
          { label: 'Update', msg: { type: 'command', command: 'thub.updateForward', name: service.name }, icon: 'edit' },
          { label: 'Remove', msg: { type: 'command', command: 'thub.removeForward', name: service.name }, icon: 'remove' }
        ]
      });
    }
    return rows;
  }

  private postSafely(): void {
    void this.post().catch((err: unknown) => this.log(`Ports view update failed: ${errorText(err)}`));
  }

  private async post(): Promise<void> {
    const view = this.view;
    if (!view){
      return;
    }
    const s = this.mgr.session,
      f = await this.features();
    if (this.view !== view){
      return;
    }
    try {
      await view.webview.postMessage({
        type: 'state',
        header: s ? `${s.client} · ${linkText(s.link)}` : '',
        hasSession: Boolean(s),
        hasReservation: Boolean(this.mgr.mine),
        rows: this.rows(),
        canForward: f.connectForward,
        canRtt: f.connectRtt && Boolean(s?.ready?.ports.some((port) => port.kind === 'swd')),
        rttFeature: f.connectRtt
      });
    }
    catch (err){
      if (this.view !== view){
        return;
      }
      throw err;
    }
  }

  private async onMessage(m: { type: string; index?: number; text?: string; command?: string; name?: string }): Promise<void> {
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
      await vscode.commands.executeCommand(m.command, m.index ?? m.name);
    }
  }

  private html(webview: vscode.Webview): string {
    const body = `
<div class="top"><span class="muted" id="header"></span><div class="top-actions">
  <button class="act icon" id="addRtt" title="Add RTT reader" aria-label="Add RTT reader" hidden>${ADD_ICONS.rtt}</button>
  <button class="act icon" id="addForward" title="Add forwarded service" aria-label="Add forwarded service" hidden>${ADD_ICONS.forward}</button>
</div></div>
<div id="empty" class="muted"></div>
<table id="table"><thead><tr><th>Name</th><th>On the board's Client</th><th>Local address</th><th>Status</th><th class="right">Actions</th></tr></thead><tbody id="rows"></tbody></table>
<div id="featureWarning" class="muted small"></div>`,
      css = `
body { padding: 6px 16px; }
.top { display: flex; justify-content: space-between; align-items: center; min-height: 34px; margin-bottom: 4px; }
.top-actions { display: flex; gap: 4px; }
.top-actions button[hidden] { display: none; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: .78em; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--border); }
td { padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td.remote, td.local { font-family: var(--vscode-editor-font-family); }
.right { text-align: right; }
.act { border: 0; background: none; padding: 0 0 0 14px; color: var(--muted); }
.act.icon { width: 30px; height: 30px; padding: 5px; vertical-align: middle; }
.act.icon.primary { color: var(--accent); }
.act.icon:hover { color: var(--vscode-foreground); }
.act.primary { color: var(--accent); }
.tone-ok { color: var(--ok); } .tone-err { color: var(--error); }
.small { font-size: .9em; margin-top: 10px; }
`,
      script = `
const $ = (s) => document.querySelector(s), esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const ICON = { terminal: '>_', bug: '⏻', camera: '▭', arrow: '→' };
const ACTION_ICONS = ${JSON.stringify(ACTION_ICONS)};
window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  $('#header').textContent = data.header;
  $('#addForward').hidden = !(data.canForward && data.hasReservation);
  $('#addRtt').hidden = !(data.canRtt && data.hasSession);
  $('#table').style.display = data.rows.length ? 'table' : 'none';
  $('#empty').innerHTML = data.rows.length ? '' : data.hasSession ? 'Connecting… the ports appear once the board\\'s Client is linked.'
    : data.hasReservation ? 'Your board isn\\'t connected. <button class="link" id="connect">Connect</button>'
    : 'No board reserved. <button class="link" id="reserve">Reserve a board</button>';
  $('#connect')?.addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'thub.connect' }));
  $('#reserve')?.addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'thub.reserve' }));
  $('#addForward').onclick = () => vscode.postMessage({ type: 'command', command: 'thub.addForward' });
  $('#addRtt').onclick = () => vscode.postMessage({ type: 'command', command: 'thub.addRtt' });
  $('#rows').innerHTML = data.rows.map((r, i) => '<tr><td>' + ICON[r.icon] + ' ' + esc(r.name) + '</td><td class="remote">' + esc(r.remote) +
    '</td><td class="local">' + esc(r.local) + '</td><td class="tone-' + r.status.tone + '"><span class="dot ' + (r.status.tone === 'ok' ? 'ok' : r.status.tone === 'err' ? 'err' : 'idle') + '"></span>' +
    esc(r.status.text) + '</td><td class="right">' + r.actions.map((a, j) => '<button class="act' + (a.icon ? ' icon' : '') + (a.primary ? ' primary' : '') + '" title="' + esc(a.label) +
    '" aria-label="' + esc(a.label) + '" data-r="' + i + '" data-a="' + j + '">' + (a.icon ? ACTION_ICONS[a.icon] : esc(a.label)) + '</button>').join('') + '</td></tr>').join('');
  document.querySelectorAll('#rows .act').forEach((b) => b.onclick = () => vscode.postMessage(data.rows[b.dataset.r].actions[b.dataset.a].msg));
  $('#featureWarning').textContent = data.hasReservation && !data.canForward
    ? 'Forwarded services need a newer thub CLI with connect --forward.'
    : data.hasSession && !data.rttFeature ? 'RTT is unavailable in the configured Agent CLI. Clear thub.cliPath to use the extension-managed CLI.' : '';
});
vscode.postMessage({ type: 'ready' });
`;
    return page(webview, { title: 'thub Ports', body, script, extraCss: css });
  }

  dispose(): void {
    clearInterval(this.timer);
    this.view = undefined;
    this.subs.forEach((s) => s.dispose());
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function linkText(link: string): string {
  return ({ starting: 'connecting', waiting: 'waiting for its Client', up: 'link up', reconnecting: 'reconnecting', ended: 'ended' } as Record<string, string>)[link] || link;
}
