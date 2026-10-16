// Shared webview scaffolding: a strict CSP with a nonce, VS Code theme
// variables, and the thub palette (contributed colours, so users can
// override them: --vscode-thub-accent …).

import * as crypto from 'node:crypto';
import type * as vscode from 'vscode';

export function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] as string);
}

/** The thub look: dark-first, the editor's fonts, amber for the one primary action. */
export const BASE_CSS = `
:root {
  --accent: var(--vscode-thub-accent, #FFAE2B);
  --on-accent: var(--vscode-thub-onAccent, #13110A);
  --idle: var(--vscode-thub-idle, #6EA8FE);
  --error: var(--vscode-thub-error, #F2665C);
  --ok: var(--vscode-thub-ok, #9ED9B0);
  --muted: var(--vscode-descriptionForeground);
  --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
  --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
code, .mono { font-family: var(--vscode-editor-font-family); font-size: calc(var(--vscode-editor-font-size, 13px) - 1px); }
h1 { font-size: 1.6em; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: .78em; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
.muted { color: var(--muted); }
.card { border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; background: var(--surface); margin-bottom: 16px; }
button { font: inherit; cursor: pointer; border-radius: 6px; padding: 6px 14px; border: 1px solid var(--border);
  background: transparent; color: var(--vscode-foreground); }
button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 600; }
button.primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--accent); }
button.link { border: 0; padding: 0; color: var(--accent); background: none; }
input[type=text], input[type=number], select { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 6px; padding: 6px 10px; width: 100%; }
input[type=checkbox] { accent-color: var(--accent); width: 16px; height: 16px; vertical-align: middle; }
.seg { display: inline-flex; gap: 8px; flex-wrap: wrap; }
.seg button[aria-pressed=true] { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.dot.ok { background: var(--ok); } .dot.err { background: var(--error); border-radius: 1px; } .dot.idle { border: 1.5px solid var(--muted); }
svg.icon { width: 16px; height: 16px; vertical-align: -3px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
`;

/** A page with a strict CSP: only our inline style and this nonce's script. */
export function page(webview: vscode.Webview, { title, body, script, extraCss = '', imgSrc = '' }:
  { title: string; body: string; script: string; extraCss?: string; imgSrc?: string }): string {
  const n = nonce();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob: ${imgSrc}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${BASE_CSS}${extraCss}</style></head><body>${body}
<script nonce="${n}">const vscode = acquireVsCodeApi();${script}</script></body></html>`;
}

/** 2px stroke icons for webviews. */
export const ICONS = {
  upload: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg>',
  power: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/></svg>',
  camera: '<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/></svg>',
  external: '<svg class="icon" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  copy: '<svg class="icon" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>',
  snapshot: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  terminal: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  bug: '<svg class="icon" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="13" rx="5"/><path d="M12 7V4M4 13h3M17 13h3M5 19l2.5-2M19 19l-2.5-2M5 7l2.5 2M19 7l-2.5 2"/></svg>',
  arrow: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 12h15M13 6l6 6-6 6"/></svg>'
};
