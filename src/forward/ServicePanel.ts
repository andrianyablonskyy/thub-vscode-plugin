import * as vscode from 'vscode';
import type { ConnectForward } from '../cli/types';
import type { Session } from '../session/Session';
import { escapeHtml } from '../util/webview';

export class ServicePanel implements vscode.Disposable {
  private static readonly panels = new Map<string, ServicePanel>();
  private readonly subscription: vscode.Disposable;
  private lastUrl?: string;
  private renderVersion = 0;
  private disposed = false;

  static async show(session: Session, service: ConnectForward): Promise<void> {
    const key = `${session.reservationId}:${service.name.toLowerCase()}`,
      existing = ServicePanel.panels.get(key);
    if (existing){
      existing.panel.reveal();
      await existing.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'thub.service',
      `${service.name} · ${session.client}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const view = new ServicePanel(key, panel, session);
    ServicePanel.panels.set(key, view);
    session.own(view);
    try {
      await view.render();
    }
    catch (err){
      view.dispose();
      throw err;
    }
  }

  private constructor(
    private readonly key: string,
    private readonly panel: vscode.WebviewPanel,
    private readonly session: Session
  ){
    this.subscription = session.onDidChange(() => {
      void this.render().catch((err: Error) => vscode.window.showErrorMessage(`thub: ${err.message}`));
    });
    panel.onDidDispose(() => this.dispose());
  }

  private async render(): Promise<void> {
    if (this.disposed){
      return;
    }
    const renderVersion = ++this.renderVersion;
    const service = this.session.ready?.forwards?.find((f) =>
      `${this.session.reservationId}:${f.name.toLowerCase()}` === this.key);
    if (!service){
      this.lastUrl = undefined;
      this.panel.webview.html = this.html('', 'Waiting for the Client service to reconnect…');
      return;
    }
    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535){
      throw new Error(`thub connect returned an invalid local port for ${service.name}`);
    }
    const localUri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${service.port}/`)),
      url = localUri.toString();
    if (this.disposed || renderVersion !== this.renderVersion){
      return;
    }
    if (url !== this.lastUrl){
      this.lastUrl = url;
      this.panel.webview.html = this.html(url, '');
    }
  }

  private html(url: string, message: string): string {
    const title = escapeHtml(`${this.session.client} · forwarded service`),
      status = message ? `<div class="status">${escapeHtml(message)}</div>` : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src http: https:;">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}.status{padding:10px 16px;color:var(--vscode-descriptionForeground)}iframe{width:100%;height:100%;border:0}</style></head>
<body>${status}${url ? `<iframe title="${escapeHtml(this.session.client)} service" src="${escapeHtml(url)}" sandbox="allow-forms allow-scripts allow-same-origin allow-downloads"></iframe>` : ''}</body></html>`;
  }

  dispose(): void {
    if (this.disposed){
      return;
    }
    this.disposed = true;
    this.subscription.dispose();
    ServicePanel.panels.delete(this.key);
    this.panel.dispose();
  }
}
