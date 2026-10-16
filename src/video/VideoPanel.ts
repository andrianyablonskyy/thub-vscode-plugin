// The board's camera (design: artboard 4). `thub connect` serves it as
// MPEG-TS at http://127.0.0.1:<port>/<reservation>/video.ts. Raw TS doesn't
// play in a webview <video>, so:
//   editor  — a local ffmpeg turns it into JPEG frames shown in the tab;
//   player  — thub.video.player (mpv, ffplay, vlc) plays the URL;
//   browser — a local page plays it with mpegts.js, through a same-origin proxy.

import * as vscode from 'vscode';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Session } from '../session/Session';
import type { Power } from '../power/Power';
import { ffmpegMjpegArgs, JpegSplitter } from './jpeg';
import { settings } from '../util/config';
import { ICONS, escapeHtml, page } from '../util/webview';

type Mode = 'editor' | 'player' | 'browser';

/** The mpegts.js player page for the browser mode (pinned, from jsDelivr). */
const MPEGTS_JS = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.8.2/dist/mpegts.js';

export class VideoPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, VideoPanel>();
  private ffmpeg?: ChildProcess;
  private player?: ChildProcess;
  private browserServer?: http.Server;
  private lastFrame?: Buffer;
  private mode: Mode;
  private ffmpegError?: string;
  private disposed = false;
  private readonly subs: vscode.Disposable[] = [];

  static show(session: Session, power: Power, mode?: Mode): void {
    const existing = VideoPanel.panels.get(session.reservationId);
    if (existing){
      existing.panel.reveal();
      if (mode){
        void existing.setMode(mode);
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel('thub.video', `Camera · ${session.client}`, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true
    });
    const vp = new VideoPanel(panel, session, power, mode || settings.videoMode());
    VideoPanel.panels.set(session.reservationId, vp);
    session.own(vp);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly session: Session, private readonly power: Power, mode: Mode){
    this.mode = mode;
    panel.webview.html = this.html();
    this.subs.push(
      panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      session.onDidChange(() => void this.post())
    );
  }

  private get url(): string | undefined {
    return this.session.videoUrl;
  }

  private async post(): Promise<void> {
    if (this.disposed){
      return;
    }
    const power = await this.power.availability();
    await this.panel.webview.postMessage({
      type: 'state',
      mode: this.mode,
      url: this.url || null,
      player: settings.videoPlayer(),
      streaming: this.session.video ? this.session.video.streaming : Boolean(this.url),
      error: this.session.video?.error || this.ffmpegError || (this.session.isUp ? null : `${this.session.client}: ${this.session.link}`),
      power: power.ok ? { ok: true } : { ok: false, why: power.why }
    });
  }

  private async onMessage(m: { type: string; mode?: Mode; action?: 'on' | 'off' | 'reset'; port?: number; delay?: number }): Promise<void> {
    switch (m.type){
      case 'ready':
        await this.post();
        await this.setMode(this.mode);
        break;
      case 'mode':
        await this.setMode(m.mode || 'editor');
        break;
      case 'openPlayer':
        this.openPlayer();
        break;
      case 'openBrowser':
        await this.openBrowser();
        break;
      case 'copy':
        if (this.url){
          await vscode.env.clipboard.writeText(this.url);
          void vscode.window.setStatusBarMessage('thub: camera URL copied', 3000);
        }
        break;
      case 'snapshot':
        await this.snapshot();
        break;
      case 'power':
        await this.power.run(m.action || 'reset', { port: m.port || undefined, delaySec: m.delay });
        await this.post();
        break;
      default:
        break;
    }
  }

  private async setMode(mode: Mode): Promise<void> {
    this.mode = mode;
    if (mode === 'editor'){
      this.startFrames();
    }
    else {
      this.stopFrames();
      if (mode === 'player'){
        this.openPlayer();
      }
      else {
        await this.openBrowser();
      }
    }
    await this.post();
  }

  /** editor mode: ffmpeg → JPEG frames → the webview. */
  private startFrames(): void {
    if (this.ffmpeg || !this.url){
      return;
    }
    this.ffmpegError = undefined;
    const child = spawn(settings.ffmpegPath(), ffmpegMjpegArgs(this.url), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
      splitter = new JpegSplitter();
    this.ffmpeg = child;
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const frames = splitter.push(chunk),
        frame = frames[frames.length - 1];
      if (frame){
        this.lastFrame = Buffer.from(frame);
        void this.panel.webview.postMessage({ type: 'frame', data: frame.toString('base64') });
      }
    });
    child.stderr.on('data', (d) => {
      err = `${err}${d}`.slice(-500);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      this.ffmpegError = e.code === 'ENOENT'
        ? `${settings.ffmpegPath()} isn't installed on this machine — install ffmpeg, or use External player / Browser`
        : e.message;
      void this.post();
    });
    child.on('close', (code) => {
      if (this.ffmpeg !== child){
        return;
      }
      this.ffmpeg = undefined;
      if (!this.disposed && this.mode === 'editor'){
        this.ffmpegError ??= code ? `ffmpeg stopped (${code}): ${err.trim().split('\n').pop() || ''}` : undefined;
        void this.post();
        // The stream may come back (a camera replugged, the link restored).
        setTimeout(() => this.mode === 'editor' && !this.disposed && this.startFrames(), 3000);
      }
    });
  }

  private stopFrames(): void {
    const child = this.ffmpeg;
    this.ffmpeg = undefined;
    child?.kill();
  }

  private openPlayer(): void {
    if (!this.url){
      return;
    }
    this.player?.kill();
    const player = settings.videoPlayer(),
      args = /ffplay/i.test(player) ? ['-fflags', 'nobuffer', '-window_title', `thub: ${this.session.client}`, this.url] : [this.url],
      child = spawn(player, args, { stdio: 'ignore', windowsHide: false });
    child.on('error', (e: NodeJS.ErrnoException) => void vscode.window.showErrorMessage(
      e.code === 'ENOENT' ? `${player} isn't installed — set thub.video.player (mpv, ffplay, vlc or a full path)` : `${player}: ${e.message}`));
    this.player = child;
  }

  /** browser mode: a local page with mpegts.js; the stream proxied from the same origin. */
  private async openBrowser(): Promise<void> {
    if (!this.url){
      return;
    }
    if (!this.browserServer){
      const source = this.url,
        title = escapeHtml(`Camera · ${this.session.client}`),
        server = http.createServer((req, res) => {
          if (req.url === '/video.ts'){
            http.get(source, (up) => {
              res.writeHead(up.statusCode || 502, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
              up.pipe(res);
            }).on('error', (e) => res.writeHead(502).end(e.message));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><title>${title}</title><body style="margin:0;background:#0a0c12;display:grid;place-items:center;height:100vh">
<video id="v" muted autoplay controls style="max-width:100%;max-height:100%"></video>
<script src="${MPEGTS_JS}"></script>
<script>const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: '/video.ts' }, { enableStashBuffer: false, liveBufferLatencyChasing: true });
p.attachMediaElement(document.getElementById('v')); p.load(); p.play();</script>`);
        });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      this.browserServer = server;
    }
    const port = (this.browserServer.address() as { port: number }).port,
      uri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}/`));
    await vscode.env.openExternal(uri);
  }

  private async snapshot(): Promise<void> {
    if (!this.lastFrame){
      void vscode.window.showInformationMessage('thub: no frame yet — the snapshot takes the picture shown In editor');
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${this.session.client}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`),
      filters: { JPEG: ['jpg'] }
    });
    if (target){
      fs.writeFileSync(target.fsPath, this.lastFrame);
    }
  }

  private html(): string {
    const body = `
<div class="bar">
  <div class="tabs" role="tablist">
    <button data-mode="editor" role="tab">In editor</button><button data-mode="player" role="tab">External player</button><button data-mode="browser" role="tab">Browser</button>
  </div>
  <div class="actions">
    <button id="player">${ICONS.external} <span id="playerName">Open in player</span></button>
    <button id="browser">Open in browser</button>
    <button id="copy" title="Copy the stream URL" aria-label="Copy the stream URL">${ICONS.copy}</button>
    <button id="snap" title="Save the current frame" aria-label="Save the current frame">${ICONS.snapshot}</button>
  </div>
</div>
<div class="grid">
  <div class="view card">
    <div class="badges"><span class="live" id="live">LIVE</span><span class="chip mono" id="fmt">MJPEG via ffmpeg</span></div>
    <img id="frame" alt="Live camera feed of ${escapeHtml(this.session.client)}">
    <div class="empty" id="empty">${ICONS.camera}<p id="emptyText">Waiting for the stream…</p></div>
    <span class="chip mono clock" id="clock"></span>
  </div>
  <aside>
    <section class="card"><h2>Power</h2>
      <p class="muted">Watch the board while you switch it. USB ports via uhubctl on the Client.</p>
      <button class="primary wide" data-power="reset">${ICONS.power} Power-cycle</button>
      <div class="two"><button data-power="on">On</button><button data-power="off">Off</button></div>
      <div class="kv"><span>Port</span><select id="port"><option value="0">All ports</option><option value="1">Port 1</option><option value="2">Port 2</option><option value="3">Port 3</option><option value="4">Port 4</option></select></div>
      <div class="kv"><span>Off time</span><select id="delay"><option>1</option><option selected>2</option><option>5</option><option>10</option></select></div>
      <p class="muted small" id="powerWhy"></p>
    </section>
    <section class="card"><h2>Stream</h2><p class="mono url" id="url"></p><p class="muted">Stops when the reservation ends.</p></section>
  </aside>
</div>`,
      css = `
.bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.tabs { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; padding: 3px; }
.tabs button { border: 0; } .tabs button[aria-selected=true] { background: var(--vscode-toolbar-activeBackground, rgba(128,128,128,.25)); font-weight: 600; }
.actions { display: flex; gap: 8px; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
.view { position: relative; min-height: 360px; display: grid; place-items: center; padding: 0; overflow: hidden; background: #0b0d14; }
#frame { max-width: 100%; max-height: 75vh; display: none; }
.empty { text-align: center; color: var(--muted); } .empty svg { width: 48px; height: 48px; }
.badges { position: absolute; top: 12px; left: 12px; display: flex; gap: 8px; }
.live { background: var(--error); color: #fff; font-weight: 700; border-radius: 5px; padding: 3px 8px; font-size: .85em; letter-spacing: .05em; }
.live.off { background: var(--muted); }
.chip { background: rgba(0,0,0,.55); color: #ddd; border-radius: 5px; padding: 3px 8px; }
.clock { position: absolute; left: 12px; bottom: 12px; }
.wide { width: 100%; padding: 10px; margin: 6px 0 10px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.kv { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 8px 0; } .kv select { width: auto; }
.url { word-break: break-all; } .small { font-size: .9em; }
`,
      script = `
const $ = (s) => document.querySelector(s);
let st = {}, frames = 0;
document.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => vscode.postMessage({ type: 'mode', mode: b.dataset.mode }));
$('#player').onclick = () => vscode.postMessage({ type: 'openPlayer' });
$('#browser').onclick = () => vscode.postMessage({ type: 'openBrowser' });
$('#copy').onclick = () => vscode.postMessage({ type: 'copy' });
$('#snap').onclick = () => vscode.postMessage({ type: 'snapshot' });
document.querySelectorAll('[data-power]').forEach((b) => b.onclick = () => vscode.postMessage({
  type: 'power', action: b.dataset.power, port: Number($('#port').value), delay: Number($('#delay').value) }));
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(); }, 1000);
const render = () => {
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === st.mode)));
  $('#playerName').textContent = 'Open in ' + (st.player || 'player').split(/[\\\\/]/).pop();
  $('#url').textContent = st.url || '—';
  const showFrame = st.mode === 'editor' && frames > 0 && !st.error;
  $('#frame').style.display = showFrame ? 'block' : 'none';
  $('#empty').style.display = showFrame ? 'none' : 'block';
  $('#emptyText').textContent = st.error ? st.error : st.mode === 'editor' ? 'Waiting for the stream…' :
    st.mode === 'player' ? 'Playing in ' + (st.player || 'the external player') : 'Playing in your browser';
  $('#live').className = 'live' + (st.streaming && !st.error ? '' : ' off');
  $('#live').textContent = st.streaming && !st.error ? 'LIVE' : 'OFF';
  $('#fmt').textContent = st.mode === 'editor' ? 'MJPEG via ffmpeg' : 'H.264 · MPEG-TS';
  document.querySelectorAll('[data-power]').forEach((b) => { b.disabled = !st.power?.ok; b.title = st.power?.ok ? '' : (st.power?.why || ''); });
  $('#powerWhy').textContent = st.power?.ok ? '' : (st.power?.why || '');
  document.querySelectorAll('#player, #browser, #copy').forEach((b) => b.disabled = !st.url);
};
window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') { st = data; render(); }
  else if (data.type === 'frame') {
    $('#frame').src = 'data:image/jpeg;base64,' + data.data;
    if (frames++ === 0) render();
  }
});
vscode.postMessage({ type: 'ready' });
`;
    return page(this.panel.webview, { title: `Camera · ${this.session.client}`, body, script, extraCss: css });
  }

  dispose(): void {
    if (this.disposed){
      return;
    }
    this.disposed = true;
    VideoPanel.panels.delete(this.session.reservationId);
    this.stopFrames();
    this.player?.kill();
    this.browserServer?.close();
    this.subs.forEach((s) => s.dispose());
    this.panel.dispose();
  }
}
