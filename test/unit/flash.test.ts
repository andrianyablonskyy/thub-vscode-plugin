import * as assert from 'node:assert/strict';
import { flashArgs, readFlashOutput } from '../../src/flash/gdb';
import { normalizeConfig, resolveVariables, shouldFlash, FLASH_AFTER_BUILD_DEFAULTS } from '../../src/flash/match';

suite('flash', () => {
  test('the GDB batch run: target, reset halt, load, verify, then run or halt', () => {
    const args = flashArgs({ image: '/w/build/app.elf', gdbPort: 3333, verify: true, then: 'run' }),
      cmds = args.filter((_, i) => args[i - 1] === '-ex');
    assert.equal(args[0], '-batch');
    assert.ok(args.includes('/w/build/app.elf'));
    assert.deepEqual(cmds, ['set confirm off', 'set remotetimeout 30', 'target extended-remote 127.0.0.1:3333', 'monitor reset halt', 'load',
      'compare-sections', 'monitor reset run', 'detach']);
    const halt = flashArgs({ image: 'a.elf', gdbPort: 3334, verify: false, then: 'halt' });
    assert.ok(!halt.includes('compare-sections'));
    assert.ok(halt.includes('monitor reset halt') && !halt.includes('monitor reset run'));
  });

  test('GDB\'s output: verified, a mismatch, a failure', () => {
    const ok = 'Loading section .text, size 0xb5e4 lma 0x80001a0\nStart address 0x08000194, load size 47144\nTransfer rate: 12 KB/sec\nSection .text, range 0x80001a0 -- 0x800b784: matched.\n';
    assert.deepEqual(readFlashOutput(ok, 0, true), { ok: true, verified: true, summary: 'Load, compare-sections and reset over GDB · verified' });
    assert.equal(readFlashOutput(`${ok}Section .data, range 0x1 -- 0x2: MIS-MATCHED!\n`, 0, true).ok, false);
    const failed = readFlashOutput('127.0.0.1:3333: Connection timed out.\n', 1, true);
    assert.equal(failed.ok, false);
    assert.match(failed.summary, /Connection timed out/);
    assert.match(readFlashOutput('', 1, false).summary, /GDB exited with 1/);
  });

  test('flash after build: only a successful configured build, never a thub task', () => {
    const cfg = { ...FLASH_AFTER_BUILD_DEFAULTS, enabled: true },
      build = { name: 'build', type: 'cmake', isBuild: true, exitCode: 0 };
    assert.equal(shouldFlash(build, cfg), true);
    assert.equal(shouldFlash(build, { ...cfg, enabled: false }), false);
    assert.equal(shouldFlash({ ...build, exitCode: 2 }, cfg), false);
    assert.equal(shouldFlash({ ...build, isBuild: false }, cfg), false);
    assert.equal(shouldFlash({ ...build, type: 'thub' }, cfg), false);
    assert.equal(shouldFlash({ ...build, isBuild: false }, { ...cfg, buildTask: 'cmake: build' }), true);
    assert.equal(shouldFlash(build, { ...cfg, buildTask: 'build' }), true);
    assert.equal(shouldFlash(build, { ...cfg, buildTask: 'make all' }), false);
  });

  test('settings: unknown values back to their defaults', () => {
    const c = normalizeConfig({ then: 'explode' as never, whenNoBoard: 'never' as never, enabled: true });
    assert.equal(c.then, 'run');
    assert.equal(c.whenNoBoard, 'ask');
    assert.equal(c.enabled, true);
    assert.equal(c.verify, true);
  });

  test('variables: folder, its name, env, config and commands', async () => {
    const ctx = {
      workspaceFolder: '/home/dev/firmware-f401',
      env: (n: string) => ({ BUILD: 'release' } as Record<string, string>)[n],
      config: (k: string) => ({ 'cmake.buildDirectory': '/b' } as Record<string, unknown>)[k],
      command: async (id: string) => (id === 'cmake.launchTargetPath' ? '/b/app.elf' : undefined)
    };
    assert.equal(await resolveVariables('${workspaceFolder}/build/${workspaceFolderBasename}.elf', ctx), '/home/dev/firmware-f401/build/firmware-f401.elf');
    assert.equal(await resolveVariables('${config:cmake.buildDirectory}/${env:BUILD}/x.elf', ctx), '/b/release/x.elf');
    assert.equal(await resolveVariables('${command:cmake.launchTargetPath}', ctx), '/b/app.elf');
    await assert.rejects(resolveVariables('${command:nope}', ctx), /gave nothing/);
    await assert.rejects(resolveVariables('${workspaceFolder}', { ...ctx, workspaceFolder: undefined }), /needs an open folder/);
    await assert.rejects(resolveVariables('${weird}', ctx), /Unknown variable/);
  });
});
