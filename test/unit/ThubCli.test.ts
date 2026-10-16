import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { ThubCli, ThubError } from '../../src/cli/ThubCli';

interface Call { cmd: string; args: string[]; env: NodeJS.ProcessEnv }

/** A spawn that answers each call from `answer(args)`: [code, stdout, stderr]. */
function fakeSpawn(answer: (args: string[]) => [number, string, string?] | 'ENOENT'){
  const calls: Call[] = [];
  const spawn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
    calls.push({ cmd, args, env: opts.env as NodeJS.ProcessEnv });
    const child = new EventEmitter() as ChildProcess & EventEmitter,
      stdout = new PassThrough(),
      stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, kill: () => true });
    setImmediate(() => {
      const a = answer(args);
      if (a === 'ENOENT'){
        child.emit('error', Object.assign(new Error('spawn thub ENOENT'), { code: 'ENOENT' }));
        return;
      }
      stdout.write(a[1]);
      stderr.write(a[2] || '');
      child.emit('close', a[0]);
    });
    return child;
  };
  return { spawn, calls };
}

const make = (answer: Parameters<typeof fakeSpawn>[0], logs: string[] = []) => {
  const f = fakeSpawn(answer);
  return { cli: new ThubCli({ cliPath: () => '', url: () => 'https://thub.example.com', key: async () => 'thk_secret_key', log: (l) => logs.push(l), spawn: f.spawn }), calls: f.calls, logs };
};

suite('ThubCli', () => {
  test('runs thub with an argument array, the URL and key in its env, self-update off', async () => {
    const { cli, calls } = make(() => [0, '[{"name":"lab-hw-01"}]']);
    const resources = await cli.resources();
    assert.equal(resources[0].name, 'lab-hw-01');
    assert.equal(calls[0].cmd, 'thub');
    assert.deepEqual(calls[0].args, ['resources', '--json']);
    assert.equal(calls[0].env.THUB_URL, 'https://thub.example.com');
    assert.equal(calls[0].env.THUB_KEY, 'thk_secret_key');
    assert.equal(calls[0].env.THUB_NO_SELF_UPDATE, '1');
  });

  test('exit 4 is an auth/usage error with thub\'s message; the key never reaches the log', async () => {
    const { cli, logs } = make(() => [4, '', 'Error: Invalid or revoked access key thk_secret_key\n']);
    await assert.rejects(cli.resources(), (err: unknown) => err instanceof ThubError && err.kind === 'auth' && err.code === 4 &&
      /Invalid or revoked access key/.test(err.message));
    assert.ok(logs.every((l) => !l.includes('thk_secret_key')), logs.join('\n'));
  });

  test('no thub on PATH: says how to install it', async () => {
    const { cli } = make(() => 'ENOENT');
    await assert.rejects(cli.resources(), /npm i -g @andrian.yablonskyy\/thub-agent/);
    assert.equal(await cli.version(), null);
  });

  test('reserve, release and power: the right commands', async () => {
    const { cli, calls } = make(() => [0, '{"name":"lab-hw-01","released":true}']);
    await cli.reserve('lab-hw-01', 120);
    await cli.release('lab-hw-01');
    await cli.power('reset', 'M-00042', { port: 2, delaySec: 3 });
    await cli.power('on', 'M-00042', { delaySec: 3 });
    assert.deepEqual(calls.map((c) => c.args), [
      ['reserve', 'lab-hw-01', '--for', '120m', '--json'],
      ['release', 'lab-hw-01', '--json'],
      ['power', 'reset', 'M-00042', '--port', '2', '--delay', '3', '--json'],
      ['power', 'on', 'M-00042', '--json']
    ]);
  });

  test('features come from --help, never guessed', async () => {
    const help: Record<string, string> = {
      reserve: 'Usage: thub reserve [options] <client>\n  --for <duration>',
      connect: '  --json   NDJSON on stdout: "ready" …',
      whoami: '  --json   Machine-readable output',
      power: 'Usage: thub power <action> <jobId>'
    };
    const { cli } = make((args) => (args[0] === '--version' ? [0, '1.1.24\n'] : [0, help[args[0]] || '']));
    assert.deepEqual(await cli.getFeatures(), {
      version: '1.1.24', reserve: true, connectNdjson: true, connectForward: false, whoamiJson: true, powerByClient: false
    });
  });

  test('connect: pinned ports, --json, the target', async () => {
    const { cli, calls } = make(() => [0, '']);
    await cli.startConnect('lab-hw-01', { uart: 5001, gdb: 3333, video: 8090 }, 'stm32l4x');
    assert.deepEqual(calls[0].args, ['connect', 'lab-hw-01', '--json', '--uart-port', '5001', '--gdb-port', '3333', '--video-port', '8090', '--target', 'stm32l4x']);
  });

  test('whoami from an older thub without --json: its text', async () => {
    const { cli } = make((args) => (args[0] === 'whoami' && args[1] !== '--help' ? [0, 'alice (User) <a@example.com>\nJobs run in: any resource (no group)\n'] : [0, '']));
    assert.deepEqual(await cli.whoami(), { kind: 'cli', user: { username: 'alice', role: 'user' } });
  });
});
