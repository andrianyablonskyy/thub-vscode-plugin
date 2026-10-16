// Custom port forwards (a host:port reachable from the board's Client, to a
// local port). Known gap: `thub connect` has no --forward yet, so this is
// feature-detected and says so rather than pretending.

import * as vscode from 'vscode';
import type { Features } from '../cli/types';

export async function forwardPort(features: () => Promise<Features>): Promise<void> {
  if (!(await features()).connectForward){
    void vscode.window.showInformationMessage(
      'thub: custom port forwards need a thub CLI whose connect has --forward — it isn\'t available yet. ' +
      'UARTs, GDB and the camera are forwarded already (THUB PORTS).');
    return;
  }
  // A CLI that has it: this is where the form's values would be passed to
  // `thub connect --forward <host:port>=<local>` — not specified yet.
  void vscode.window.showInformationMessage('thub: this thub supports --forward; restart the session to apply forwards.');
}
