// Integration tests: a real VS Code with the extension and Cortex-Debug (its
// declared dependency) installed, an empty workspace, and no thub CLI.

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // Run from inside VS Code (its terminal, an agent), these would start the
  // test VS Code as plain Node, or attach it to the running one.
  for (const k of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PID', 'VSCODE_CWD']){
    delete process.env[k];
  }
  const root = path.resolve(__dirname, '../../..'),
    // VSCODE_EXECUTABLE: a VS Code already on this machine (offline, or to test that version).
    vscodeExecutablePath = process.env.VSCODE_EXECUTABLE || await downloadAndUnzipVSCode('stable'),
    [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath),
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-ws-'));
  fs.mkdirSync(path.join(workspace, '.vscode'));
  // No thub CLI: the extension must say so, not fail.
  fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'thub.cliPath': '/nonexistent/thub' }));
  const install = spawnSync(cli, [...cliArgs, '--install-extension', 'marus25.cortex-debug'], { encoding: 'utf8', stdio: 'inherit', shell: process.platform === 'win32' });
  if (install.status !== 0){
    throw new Error('Could not install marus25.cortex-debug for the tests');
  }
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, 'suite', 'index'),
    launchArgs: [workspace, ...cliArgs.filter((a) => a.startsWith('--extensions-dir') || a.startsWith('--user-data-dir'))]
  });
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
