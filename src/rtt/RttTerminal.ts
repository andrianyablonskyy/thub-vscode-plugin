import * as vscode from 'vscode';
import * as net from 'node:net';
import type { Session } from '../session/Session';
import { RttDecoder } from './RttDecoder';

const RETRY_MS = 1000;

export class RttTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private sock?: net.Socket;
  private retry?: NodeJS.Timeout;
  private closed = false;
  private waiting = false;
  private failed = false;
  private connectedOnce = false;
  private readonly decoder = new RttDecoder();
  private readonly errorSubscription: vscode.Disposable;

  constructor(private readonly session: Session, readonly index: number, readonly channel: number) {
    this.errorSubscription = session.onDidRttError(({ index: failedIndex, message }) => {
      if (failedIndex === this.index){
        this.failed = true;
        clearTimeout(this.retry);
        this.note(`RTT stopped: ${message}`);
        this.sock?.destroy();
      }
    });
  }

  open(): void {
    this.connect();
  }

  get hasFailed(): boolean {
    return this.failed;
  }

  retryConnection(): void {
    if (this.closed || !this.failed){
      return;
    }
    this.failed = false;
    this.waiting = false;
    this.connect();
  }

  private connect(): void {
    if (this.closed){
      return;
    }
    const port = this.session.rttPort(this.index);
    if (!port){
      if (!this.waiting){
        this.note(`waiting for ${this.session.client}'s RTT listener`);
        this.waiting = true;
      }
      this.retry = setTimeout(() => this.connect(), RETRY_MS);
      return;
    }
    const sock = net.connect(port, '127.0.0.1');
    this.sock = sock;
    sock.setNoDelay(true);
    sock.on('connect', () => {
      this.waiting = false;
      this.note(this.connectedOnce ? 'reconnected' :
        `${this.session.client} ST-Link ${this.index} · RTT up-channel ${this.channel} · 127.0.0.1:${port}`);
      this.connectedOnce = true;
    });
    sock.on('data', (buf) => {
      const text = this.decoder.write(buf);
      if (text){
        this.writeEmitter.fire(text);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      const tail = this.decoder.end();
      if (tail && !this.closed){
        this.writeEmitter.fire(tail);
      }
      if (this.sock !== sock){
        return;
      }
      this.sock = undefined;
      if (this.closed || this.failed){
        return;
      }
      if (this.session.link !== 'ended'){
        if (this.connectedOnce){
          this.note('connection dropped — reconnecting');
        }
        this.retry = setTimeout(() => this.connect(), RETRY_MS);
      }
      else if (this.session.link === 'ended'){
        this.note('the reservation ended');
      }
    });
  }

  private note(text: string): void {
    this.writeEmitter.fire(`\r\n— ${text} —\r\n`);
  }

  handleInput(): void {}

  close(): void {
    if (this.closed){
      return;
    }
    this.closed = true;
    clearTimeout(this.retry);
    this.sock?.destroy();
    this.closeEmitter.fire();
  }

  dispose(): void {
    this.close();
    this.errorSubscription.dispose();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

export class RttTerminals {
  private readonly terminals = new Map<string, { term: vscode.Terminal; pty: RttTerminal }>();

  show(session: Session, index: number, channel: number): RttTerminal {
    const key = `${session.reservationId}:${index}`,
      existing = this.terminals.get(key);
    if (existing && vscode.window.terminals.includes(existing.term)){
      existing.pty.retryConnection();
      existing.term.show(true);
      return existing.pty;
    }
    const pty = new RttTerminal(session, index, channel),
      term = vscode.window.createTerminal({
        name: `thub: ${session.client} RTT ${index} CH ${channel}`,
        pty,
        iconPath: new vscode.ThemeIcon('terminal')
      });
    this.terminals.set(key, { term, pty });
    session.own({ dispose: () => {
      pty.dispose();
      term.dispose();
      this.terminals.delete(key);
    } });
    term.show(true);
    return pty;
  }

  close(session: Session, index: number): void {
    const key = `${session.reservationId}:${index}`,
      existing = this.terminals.get(key);
    if (existing){
      existing.pty.dispose();
      existing.term.dispose();
      this.terminals.delete(key);
    }
  }
}
