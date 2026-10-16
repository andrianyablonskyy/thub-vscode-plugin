// The extension's settings (README: Settings).

import * as vscode from 'vscode';
import { normalizeConfig, type FlashAfterBuildConfig } from '../flash/match';

const cfg = () => vscode.workspace.getConfiguration('thub');

export const settings = {
  url: () => cfg().get<string>('url', '').trim() || undefined,
  cliPath: () => cfg().get<string>('cliPath', ''),
  gdbPath: () => cfg().get<string>('gdbPath', 'arm-none-eabi-gdb').trim() || 'arm-none-eabi-gdb',
  defaultTarget: () => cfg().get<string>('defaultTarget', '').trim(),
  defaultDuration: () => cfg().get<string>('defaultDuration', '2h'),
  ports: () => ({
    uart: cfg().get<number>('ports.uart', 5001),
    gdb: cfg().get<number>('ports.gdb', 3333),
    video: cfg().get<number>('ports.video', 8090)
  }),
  videoMode: () => cfg().get<'editor' | 'player' | 'browser'>('video.mode', 'editor'),
  videoPlayer: () => cfg().get<string>('video.player', 'mpv').trim() || 'mpv',
  ffmpegPath: () => cfg().get<string>('video.ffmpegPath', 'ffmpeg').trim() || 'ffmpeg',
  serialTimestamps: () => cfg().get<boolean>('serial.timestamps', true),
  serialLogDir: () => cfg().get<string>('serial.logDirectory', '').trim(),
  svdFile: () => cfg().get<string>('debug.svdFile', '').trim(),
  flashAfterBuild: (folder?: vscode.WorkspaceFolder): FlashAfterBuildConfig =>
    normalizeConfig(vscode.workspace.getConfiguration('thub', folder?.uri).get('flashAfterBuild'))
};

/** The folder flash-after-build and debug resolve ${workspaceFolder} against. */
export function mainFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  return (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
}
