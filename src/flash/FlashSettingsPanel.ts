// "thub: Flash after build" — the settings tab (design: artboard 7). It
// reads and writes thub.flashAfterBuild through the configuration API:
// settings.json stays the source of truth, and the tab shows it live.

import * as vscode from 'vscode';
import type { FlashAfterBuild } from './FlashAfterBuild';
import type { SessionManager } from '../session/SessionManager';
import { mainFolder, settings } from '../util/config';
import { ICONS, page } from '../util/webview';
import { normalizeConfig, type FlashAfterBuildConfig } from './match';

export class FlashSettingsPanel {
  private static current?: FlashSettingsPanel;
  private readonly subs: vscode.Disposable[] = [];

  static show(fab: FlashAfterBuild, mgr: SessionManager): void {
    if (FlashSettingsPanel.current){
      FlashSettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('thub.flashAfterBuild', 'thub: Flash after build', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true
    });
    FlashSettingsPanel.current = new FlashSettingsPanel(panel, fab, mgr);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly fab: FlashAfterBuild, private readonly mgr: SessionManager){
    panel.webview.html = this.html();
    this.subs.push(
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('thub.flashAfterBuild') && void this.post()),
      fab.onDidChange(() => void this.post()),
      mgr.onDidChange(() => void this.post()),
      panel.onDidDispose(() => this.dispose())
    );
  }

  private async post(): Promise<void> {
    const tasks: vscode.Task[] = await Promise.resolve(vscode.tasks.fetchTasks()).catch(() => []),
      seen = new Set<string>(),
      labels: Array<{ value: string; label: string }> = [];
    for (const t of tasks.filter((x) => x.definition.type !== 'thub')){
      const label = t.source === 'Workspace' ? t.name : `${t.definition.type}: ${t.name}`;
      if (!seen.has(label)){
        seen.add(label);
        labels.push({ value: label, label: `${label}${t.group?.id === vscode.TaskGroup.Build.id && t.group.isDefault ? ' (default build task)' : ''}` });
      }
    }
    const mine = this.mgr.mine,
      boardLabels = [...new Set(this.mgr.resources.flatMap((r) => r.labels))].sort();
    await this.panel.webview.postMessage({
      type: 'state',
      config: settings.flashAfterBuild(mainFolder()),
      tasks: labels,
      boards: [
        { value: 'reserved', label: `My reserved board${mine ? ` (${mine.name})` : ''}` },
        ...this.mgr.resources.filter((r) => r.type === 'hw').map((r) => ({ value: r.name, label: r.name })),
        ...boardLabels.map((l) => ({ value: `label:${l}`, label: `Any board labelled ${l}` }))
      ],
      lastRun: this.fab.lastRun || null
    });
  }

  private async onMessage(m: { type: string; key?: keyof FlashAfterBuildConfig; value?: unknown }): Promise<void> {
    if (m.type === 'ready'){
      return this.post();
    }
    if (m.type === 'set' && m.key){
      const folder = mainFolder(),
        cur = settings.flashAfterBuild(folder),
        next = normalizeConfig({ ...cur, [m.key]: m.value });
      await vscode.workspace.getConfiguration('thub', folder?.uri).update('flashAfterBuild', next, vscode.ConfigurationTarget.Workspace);
      return;
    }
    if (m.type === 'openSettings'){
      await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
      return;
    }
    if (m.type === 'buildAndFlash'){
      await vscode.commands.executeCommand('thub.buildAndFlash');
    }
  }

  private html(): string {
    const body = `
<div class="layout">
  <main>
    <header class="head">
      <div><h1>Flash after build</h1>
        <p class="muted lead">When a build task finishes without errors, the firmware goes straight onto your reserved board. Saved to this workspace's settings.</p></div>
      <label class="enabled"><input type="checkbox" data-key="enabled"> Enabled</label>
    </header>
    <section class="card"><h2>1 · When</h2>
      <div class="row"><label for="buildTask">Build task</label><select id="buildTask" data-key="buildTask"></select></div>
      <div class="row"><label for="image">Firmware image</label><input id="image" type="text" class="mono" data-key="image" spellcheck="false"></div>
      <div class="row"><span>Only if the image changed</span><label><input type="checkbox" data-key="skipUnchanged"> Skip flashing when the ELF is identical to the last flashed one</label></div>
    </section>
    <section class="card"><h2>2 · Where</h2>
      <div class="row"><label for="board">Board</label><select id="board" data-key="board"></select></div>
      <div class="row"><span>No board reserved</span><div class="seg" data-seg="whenNoBoard">
        <button data-v="ask">Ask me</button><button data-v="reserve">Reserve a matching board</button><button data-v="skip">Skip</button></div></div>
      <div class="row"><label for="target">OpenOCD target</label><input id="target" type="text" class="mono" data-key="target" placeholder="the runner card's (e.g. stm32l4x)" spellcheck="false"></div>
    </section>
    <section class="card"><h2>3 · How</h2>
      <div class="row"><span>Before flashing</span><label><input type="checkbox" data-key="powerCycle"> Power-cycle the board (uhubctl, 2 s off — while a job of yours runs on it)</label></div>
      <div class="row"><span>Verify</span><label><input type="checkbox" data-key="verify"> Compare sections after load</label></div>
      <div class="row"><span>Then</span><div class="seg" data-seg="then">
        <button data-v="run">Reset and run</button><button data-v="halt">Halt</button><button data-v="debug">Start debugging</button></div></div>
      <div class="row"><span>Also</span><label><input type="checkbox" data-key="openSerial"> Open the UART 1 terminal and clear it</label></div>
    </section>
  </main>
  <aside>
    <h2>.vscode/settings.json</h2>
    <pre class="card json mono" id="json"></pre>
    <button class="link" id="openSettings">Open settings.json</button>
    <h2 class="last">Last run</h2>
    <div class="card mono" id="last"><span class="muted">No build has flashed yet.</span></div>
    <div class="spacer"></div>
    <button class="primary big" id="buildAndFlash">${ICONS.upload} Build and flash now</button>
  </aside>
</div>`,
      css = `
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 28px; max-width: 1200px; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
.lead { max-width: 560px; margin: 6px 0 0; }
.enabled { border: 1px solid var(--accent); color: var(--accent); border-radius: 8px; padding: 8px 14px; font-weight: 600; white-space: nowrap; }
.row { display: grid; grid-template-columns: 200px minmax(0, 1fr); align-items: center; gap: 12px; padding: 8px 0; }
.row > span, .row > label:first-child { font-weight: 600; }
aside { display: flex; flex-direction: column; }
.json { white-space: pre-wrap; margin: 0 0 8px; line-height: 1.5; }
h2.last { margin-top: 24px; }
.spacer { flex: 1; min-height: 16px; }
.big { padding: 12px; font-size: 1.05em; }
#last .ok { color: var(--ok); } #last .err { color: var(--error); }
`,
      script = `
let cfg = {};
const $ = (s) => document.querySelector(s), esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
const set = (key, value) => vscode.postMessage({ type: 'set', key, value });
document.querySelectorAll('[data-key]').forEach((el) => el.addEventListener('change', () =>
  set(el.dataset.key, el.type === 'checkbox' ? el.checked : el.value)));
document.querySelectorAll('[data-seg]').forEach((seg) => seg.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (b) set(seg.dataset.seg, b.dataset.v); }));
$('#openSettings').onclick = () => vscode.postMessage({ type: 'openSettings' });
$('#buildAndFlash').onclick = () => vscode.postMessage({ type: 'buildAndFlash' });
const options = (sel, list, value) => {
  const opts = list.some((o) => o.value === value) || !value ? list : [{ value, label: value }, ...list];
  sel.innerHTML = (sel.id === 'buildTask' ? '<option value="">Any build task</option>' : '') +
    opts.map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('');
  sel.value = value;
};
window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  cfg = data.config;
  options($('#buildTask'), data.tasks, cfg.buildTask);
  options($('#board'), data.boards, cfg.board);
  document.querySelectorAll('[data-key]').forEach((el) => {
    if (el.tagName === 'SELECT' || document.activeElement === el) return;
    if (el.type === 'checkbox') el.checked = Boolean(cfg[el.dataset.key]); else el.value = cfg[el.dataset.key] ?? '';
  });
  document.querySelectorAll('[data-seg]').forEach((seg) => seg.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(cfg[seg.dataset.seg] === b.dataset.v))));
  $('#json').textContent = '"thub.flashAfterBuild": ' + JSON.stringify(cfg, null, 2);
  const r = data.lastRun;
  if (r) {
    const sec = (ms) => ms == null ? '' : ' ' + (ms / 1000).toFixed(1) + ' s';
    const f = r.flash;
    $('#last').innerHTML = '<div class="muted">' + esc(new Date(r.at).toLocaleTimeString()) + '</div>' +
      (f ? '<div class="' + (f.ok ? 'ok' : 'err') + '">' + (f.skipped ? 'Unchanged · skipped' : f.ok ? (f.verified ? 'Flashed · verified' : 'Flashed') : 'Flash failed') + '</div>' : '') +
      '<div>build ' + esc(r.buildTask) + ' ✓' + sec(r.buildMs) + '</div>' +
      (f ? '<div>flash ' + esc(f.client) + ' ' + (f.ok ? '✓' : '✗') + sec(f.ms) + '</div>' +
        (f.ok && !f.skipped ? '<div>then ' + esc({ run: 'reset and run', halt: 'halt', debug: 'start debugging' }[r.then] || r.then) + ' ✓</div>' : '<div class="err">' + esc(f.summary) + '</div>') : '') +
      (r.error ? '<div class="err">' + esc(r.error) + '</div>' : '');
  }
});
vscode.postMessage({ type: 'ready' });
`;
    return page(this.panel.webview, { title: 'Flash after build', body, script, extraCss: css });
  }

  private dispose(): void {
    FlashSettingsPanel.current = undefined;
    this.subs.forEach((s) => s.dispose());
  }
}
