// A UART of the reserved board as a VS Code terminal: a Pseudoterminal over
// the TCP port `thub connect` opened for it. Reconnects while the session
// lives (a restarted `thub connect` comes back on the same port).

import * as vscode from 'vscode';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '../session/Session';
import { settings } from '../util/config';

const RETRY_MS = 1000,
  DIM = '\x1b[2m',
  RESET = '\x1b[0m';

export class SerialTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private sock?: net.Socket;
  private retry?: NodeJS.Timeout;
  private closed = false;
  private atLineStart = true;
  private connectedOnce = false;
  private logFile?: fs.WriteStream;
  timestamps = settings.serialTimestamps();
  /** Open sockets, for the Ports view's "n clients". */
  static readonly open = new Map<string, number>();

  constructor(private readonly session: Session, readonly index: number){}

  get key(): string {
    return `${this.session.client}:uart${this.index}`;
  }

  open(): void {
    const dir = settings.serialLogDir();
    if (dir){
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${this.session.client}-uart${this.index}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      this.logFile = fs.createWriteStream(file, { flags: 'a' });
      this.note(`logging to ${file}`);
    }
    this.connect();
  }

  private note(text: string): void {
    this.writeEmitter.fire(`${this.atLineStart ? '' : '\r\n'}${DIM}— ${text} —${RESET}\r\n`);
    this.atLineStart = true;
  }

  private connect(): void {
    if (this.closed){
      return;
    }
    const port = this.session.uartPort(this.index);
    if (!port){
      this.note(`waiting for ${this.session.client}'s link`);
      this.retry = setTimeout(() => this.connect(), RETRY_MS);
      return;
    }
    const sock = net.connect(port, '127.0.0.1');
    let counted = false;
    this.sock = sock;
    sock.setNoDelay(true);
    sock.on('connect', () => {
      counted = true;
      SerialTerminal.open.set(this.key, (SerialTerminal.open.get(this.key) || 0) + 1);
      this.note(this.connectedOnce ? 'reconnected' : `${this.session.client} UART ${this.index} · 127.0.0.1:${port} · socket://127.0.0.1:${port}`);
      this.connectedOnce = true;
    });
    sock.on('data', (buf) => this.output(buf));
    sock.on('error', () => {});
    sock.on('close', () => {
      if (counted){
        SerialTerminal.open.set(this.key, Math.max(0, (SerialTerminal.open.get(this.key) || 1) - 1));
      }
      if (this.sock !== sock){
        return;
      }
      this.sock = undefined;
      if (!this.closed && this.session.link !== 'ended'){
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

  private output(buf: Buffer): void {
    this.logFile?.write(buf);
    const text = buf.toString('utf8');
    let out = '';
    for (const ch of text.split(/(\r\n|\n|\r)/)){
      if (ch === '\r\n' || ch === '\n'){
        out += '\r\n';
        this.atLineStart = true;
      }
      else if (ch === '\r'){
        out += '\r';
      }
      else if (ch){
        if (this.atLineStart && this.timestamps){
          out += `${DIM}${stamp()}${RESET} `;
        }
        out += ch;
        this.atLineStart = false;
      }
    }
    this.writeEmitter.fire(out);
  }

  handleInput(data: string): void {
    this.sock?.write(data);
  }

  /** Clears the terminal (flash-after-build's openSerial). */
  clear(): void {
    this.writeEmitter.fire('\x1bc');
    this.atLineStart = true;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.sock?.destroy();
    this.logFile?.end();
    this.writeEmitter.dispose();
  }

  dispose(): void {
    this.close();
    this.closeEmitter.fire();
  }
}

function stamp(): string {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** The UART terminals of the current session, one per UART (reused). */
export class SerialTerminals {
  private readonly terminals = new Map<string, { term: vscode.Terminal; pty: SerialTerminal }>();

  /** Opens (or shows) UART `index`'s terminal. */
  show(session: Session, index = 1, { clear = false } = {}): SerialTerminal {
    const key = `${session.reservationId}:${index}`,
      existing = this.terminals.get(key);
    if (existing && vscode.window.terminals.includes(existing.term)){
      if (clear){
        existing.pty.clear();
      }
      existing.term.show(true);
      return existing.pty;
    }
    const pty = new SerialTerminal(session, index),
      term = vscode.window.createTerminal({ name: `thub: ${session.client} UART ${index}`, pty, iconPath: new vscode.ThemeIcon('terminal') });
    this.terminals.set(key, { term, pty });
    session.own({ dispose: () => {
      pty.dispose();
      term.dispose();
      this.terminals.delete(key);
    } });
    term.show(true);
    return pty;
  }
}
