import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

suite('thub extension in VS Code', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('adsystem-pro.thub-vscode');
    assert.ok(ext, 'the extension is installed');
    await ext.activate();
  });

  test('every command is registered', async () => {
    const all = await vscode.commands.getCommands(true),
      ours = ['signIn', 'refresh', 'reserve', 'extend', 'release', 'connect', 'flash', 'buildAndFlash', 'configureFlashAfterBuild',
        'toggleFlashAfterBuild', 'debug', 'openSerial', 'openVideo', 'powerCycle', 'powerOn', 'powerOff', 'forwardPort', 'copyEndpoint'];
    for (const c of ours){
      assert.ok(all.includes(`thub.${c}`), `thub.${c}`);
    }
  });

  test('session and endpoint tree actions use header placement and icons', () => {
    const ext = vscode.extensions.getExtension('adsystem-pro.thub-vscode');
    assert.ok(ext);
    const contributes = ext.packageJSON.contributes as {
      commands: Array<{ command: string; icon?: string }>;
      menus: { 'view/item/context': Array<{ command: string; when: string }> };
    };
    const inline = contributes.menus['view/item/context'],
      commands = new Map(contributes.commands.map((command) => [command.command, command]));
    assert.ok(inline.some((item) => item.command === 'thub.addForward' && item.when.includes('session')));
    assert.ok(inline.some((item) => item.command === 'thub.addRtt' && item.when.includes('session.gdb')));
    for (const id of ['thub.configureRtt', 'thub.removeRtt', 'thub.updateForward', 'thub.removeForward']){
      assert.ok(commands.get(id)?.icon, `${id} must have an icon for its inline tree action`);
    }
  });

  test('the thub task type offers "flash reserved board"', async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: 'thub' });
    assert.ok(tasks.some((t) => t.name === 'flash reserved board' && t.definition.action === 'flash'));
  });

  test('settings have their documented defaults', () => {
    const c = vscode.workspace.getConfiguration('thub');
    assert.equal(c.get('gdbPath'), 'arm-none-eabi-gdb');
    assert.equal(c.get('defaultDuration'), '2h');
    assert.equal(c.get('ports.uart'), 5001);
    assert.equal(c.get('ports.gdb'), 3333);
    assert.equal(c.get('ports.video'), 8090);
    assert.equal(c.get('video.mode'), 'editor');
    assert.equal(c.get<{ enabled: boolean }>('flashAfterBuild')?.enabled, false);
  });

  test('Cortex-Debug, which the thub debug type hands over to, is there', () => {
    assert.ok(vscode.extensions.getExtension('marus25.cortex-debug'));
  });
});
