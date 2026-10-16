// The thub view (design: artboard 1): My session, Boards, Recent jobs. Board
// states differ in icon and label, not only colour; amber marks what's yours.

import * as vscode from 'vscode';
import type { SessionManager } from '../session/SessionManager';
import { boardModel, boardState, formatLeft, labelsSummary, msUntil } from '../cli/parse';
import type { BoardState, Job, Resource } from '../cli/types';
import { linkText } from './PortsView';
import { settings } from '../util/config';

const accent = new vscode.ThemeColor('thub.accent'),
  idle = new vscode.ThemeColor('thub.idle'),
  error = new vscode.ThemeColor('thub.error'),
  muted = new vscode.ThemeColor('descriptionForeground');

type Node =
  | { kind: 'section'; id: 'session' | 'boards' | 'jobs' }
  | { kind: 'sessionHeader'; board: Resource }
  | { kind: 'endpoint'; label: string; address: string; context: string; command?: vscode.Command }
  | { kind: 'action'; label: string; icon: string; command: vscode.Command; primary?: boolean }
  | { kind: 'board'; board: Resource }
  | { kind: 'job'; job: Job }
  | { kind: 'message'; text: string };

export class BoardsTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly mgr: SessionManager){
    mgr.onDidChange(() => this.changed.fire(undefined));
  }

  getChildren(node?: Node): Node[] {
    if (!node){
      if (!this.mgr.signedIn && !this.mgr.resources.length){
        return this.mgr.lastError && !/sign in|access key|THUB_KEY/i.test(this.mgr.lastError)
          ? [{ kind: 'message', text: this.mgr.lastError }]
          : [];
      }
      return [
        ...(this.mgr.mine ? [{ kind: 'section', id: 'session' } as Node] : []),
        { kind: 'section', id: 'boards' },
        { kind: 'section', id: 'jobs' }
      ];
    }
    if (node.kind !== 'section'){
      return [];
    }
    if (node.id === 'session'){
      return this.sessionChildren();
    }
    if (node.id === 'boards'){
      return this.mgr.resources.length
        ? this.mgr.resources.map((board) => ({ kind: 'board', board }) as Node)
        : [{ kind: 'message', text: this.mgr.lastError || 'No boards' }];
    }
    return this.mgr.jobs.length
      ? this.mgr.jobs.map((job) => ({ kind: 'job', job }) as Node)
      : [{ kind: 'message', text: 'No jobs of yours yet' }];
  }

  private sessionChildren(): Node[] {
    const board = this.mgr.mine!,
      s = this.mgr.session,
      nodes: Node[] = [{ kind: 'sessionHeader', board }];
    if (s?.ready){
      for (const p of s.ready.ports){
        const address = `127.0.0.1:${p.port}`;
        nodes.push(p.kind === 'uart'
          ? { kind: 'endpoint', label: `UART ${p.index}`, address, context: 'endpoint.uart', command: { command: 'thub.openSerial', title: 'Open serial', arguments: [p.index] } }
          : { kind: 'endpoint', label: `GDB · ST-Link ${p.index}`, address, context: 'endpoint.gdb' });
      }
      if (s.ready.video){
        nodes.push({ kind: 'endpoint', label: 'Video', address: s.ready.video.url.replace(/^http:\/\//, ''), context: 'endpoint.video', command: { command: 'thub.openVideo', title: 'Open camera' } });
      }
      nodes.push(
        { kind: 'action', label: 'Flash', icon: 'arrow-up', command: { command: 'thub.flash', title: 'Flash' }, primary: true },
        { kind: 'action', label: 'Debug', icon: 'debug-alt', command: { command: 'thub.debug', title: 'Debug' } }
      );
    }
    else if (!s){
      nodes.push({ kind: 'action', label: 'Connect (UART, GDB, camera)', icon: 'plug', command: { command: 'thub.connect', title: 'Connect' }, primary: true });
    }
    nodes.push({ kind: 'action', label: 'Release board', icon: 'unlock', command: { command: 'thub.release', title: 'Release' } });
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind){
      case 'section': {
        const label = node.id === 'session' ? 'My session'
            : node.id === 'boards' ? 'Boards' : 'Recent jobs',
          item = new vscode.TreeItem(label, node.id === 'jobs' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section:${node.id}`;
        if (node.id === 'boards' && this.mgr.me?.group){
          item.description = `group: ${this.mgr.me.group}`;
        }
        return item;
      }
      case 'sessionHeader': {
        const s = this.mgr.session,
          left = msUntil(node.board.reservation?.until),
          item = new vscode.TreeItem(node.board.name);
        item.id = 'session:header';
        item.contextValue = 'session';
        item.description = `${formatLeft(left)} · ${s ? linkText(s.link) : 'not connected'}`;
        item.iconPath = new vscode.ThemeIcon(s && s.link !== 'up' && s.link !== 'ended' ? 'sync~spin' : 'lock', left < 10 * 60_000 ? error : accent);
        item.tooltip = new vscode.MarkdownString([
          `**${node.board.name}**${boardModel(node.board) ? ` · ${boardModel(node.board)}` : ''}${s?.target ? ` · ${s.target}` : ''}`,
          `Reserved until ${new Date(node.board.reservation!.until).toLocaleString()} (${formatLeft(left)} left)`,
          s?.lastError && s.link !== 'up' ? `Last error: ${s.lastError}` : ''
        ].filter(Boolean).join('\n\n'));
        return item;
      }
      case 'endpoint': {
        const item = new vscode.TreeItem(node.label);
        item.description = node.address;
        item.contextValue = node.context;
        item.iconPath = new vscode.ThemeIcon(node.context === 'endpoint.uart' ? 'terminal' : node.context === 'endpoint.gdb' ? 'debug' : 'device-camera-video');
        item.tooltip = `${node.label} — ${node.address}`;
        item.command = node.command;
        return item;
      }
      case 'action': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon, node.primary ? accent : undefined);
        item.command = node.command;
        return item;
      }
      case 'board':
        return this.boardItem(node.board);
      case 'job': {
        const j = node.job,
          item = new vscode.TreeItem(j.id),
          url = settings.url();
        item.description = `${j.state.toLowerCase()}${j.resource_name ? ` · ${j.resource_name}` : ''}`;
        item.iconPath = new vscode.ThemeIcon(jobIcon(j.state), j.state === 'PASSED' ? new vscode.ThemeColor('thub.ok') : /FAILED|ERROR|TIMEOUT|LOST/.test(j.state) ? error : undefined);
        if (url){
          item.command = { command: 'vscode.open', title: 'Open job', arguments: [vscode.Uri.parse(`${url.replace(/\/+$/, '')}/jobs/${j.id}`)] };
        }
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon('info', muted);
        return item;
      }
    }
  }

  private boardItem(r: Resource): vscode.TreeItem {
    const state: BoardState = boardState(r),
      connecting = state === 'mine' && this.mgr.session && this.mgr.session.link !== 'up',
      item = new vscode.TreeItem(r.name),
      left = formatLeft(msUntil(r.reservation?.until)),
      summary = labelsSummary(r);
    item.id = `board:${r.id}`;
    item.contextValue = `board.${state}`;
    const look: Record<BoardState, { icon: string; color?: vscode.ThemeColor; text: string }> = {
      idle: { icon: 'circle-large-outline', color: idle, text: `idle${summary ? ` · ${summary}` : ''}` },
      mine: { icon: connecting ? 'sync~spin' : 'lock', color: accent, text: connecting ? 'connecting' : `mine · ${left}` },
      reserved: { icon: 'lock', text: `${r.reservation?.by || 'someone'} · ${left}` },
      job: { icon: 'circle-filled', color: muted, text: `running a job${r.busySource ? ` (${r.busySource})` : ''}` },
      offline: { icon: 'dash', color: muted, text: 'offline' },
      maintenance: { icon: 'tools', color: muted, text: 'maintenance' }
    };
    const l = look[state];
    item.iconPath = new vscode.ThemeIcon(l.icon, l.color);
    item.description = l.text;
    item.tooltip = new vscode.MarkdownString([
      `**${r.name}** (${r.type.toUpperCase()}) — ${l.text}`,
      r.labels.length ? `Labels: ${r.labels.map((x) => `\`${x}\``).join(', ')}` : '',
      state === 'idle' ? '_Click to reserve_' : ''
    ].filter(Boolean).join('\n\n'));
    if (state === 'idle' && r.type === 'hw'){
      item.command = { command: 'thub.reserve', title: 'Reserve', arguments: [r.name] };
    }
    return item;
  }
}

function jobIcon(state: string): string {
  return ({ QUEUED: 'clock', ASSIGNED: 'clock', PREPARING: 'sync~spin', RUNNING: 'sync~spin', PASSED: 'pass', FAILED: 'error', ERROR: 'error',
    TIMEOUT: 'watch', CANCELED: 'circle-slash', LOST: 'question' } as Record<string, string>)[state] || 'circle-outline';
}
