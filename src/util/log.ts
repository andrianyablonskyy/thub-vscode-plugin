// The "thub" output channel. The access key never reaches it.

import * as vscode from 'vscode';
import { mask } from '../cli/parse';

export class Log implements vscode.Disposable {
  readonly channel = vscode.window.createOutputChannel('thub');
  private secret: string | undefined;

  setSecret(secret: string | undefined): void {
    this.secret = secret;
  }

  line = (text: string): void => {
    const time = new Date().toLocaleTimeString(undefined, { hour12: false });
    for (const l of mask(text, this.secret).split(/\r?\n/)){
      this.channel.appendLine(`[${time}] ${l}`);
    }
  };

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
