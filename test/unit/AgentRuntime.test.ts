import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { AgentRuntime } from '../../src/cli/AgentRuntime';
import type { Features } from '../../src/cli/types';

interface SpawnCall { command: string; args: string[]; env: NodeJS.ProcessEnv }

const ready: Features = {
  version: '1.1.25',
  reserve: true,
  connectNdjson: true,
  connectForward: true,
  connectRtt: true,
  connectRttTarget: true,
  whoamiJson: true,
  powerByClient: false
};

function fakeSpawn(answer: (command: string, args: string[]) => [number, string, string?]){
  const calls: SpawnCall[] = [],
    spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
      calls.push({ command, args, env: options.env as NodeJS.ProcessEnv });
      const child = new EventEmitter() as ChildProcess & EventEmitter,
        stdout = new PassThrough(),
        stderr = new PassThrough();
      Object.assign(child, { stdout, stderr });
      setImmediate(() => {
        const [code, out, error] = answer(command, args);
        stdout.end(out);
        stderr.end(error || '');
        child.emit('close', code);
      });
      return child;
    };
  return { calls, spawn };
}

function fakeCli(initialVersion: string | null, initialFeatures: Features){
  let version = initialVersion,
    features = initialFeatures;
  return {
    command: '/extension-storage/agent/node_modules/.bin/thub',
    version: async () => version,
    getFeatures: async () => features,
    reset: () => {
      version = ready.version;
      features = ready;
    }
  };
}

suite('AgentRuntime', () => {
  test('installs a current Agent into extension storage when none is available', async () => {
    const f = fakeSpawn((command, args) => {
        if (command === 'node'){
          assert.deepEqual(args, ['--version']);
          return [0, 'v24.0.0\n'];
        }
        assert.equal(command, 'npm');
        return [0, 'installed'];
      }),
      runtime = new AgentRuntime({
        globalStoragePath: '/extension-storage',
        cliPath: () => '',
        platform: 'linux',
        spawn: f.spawn
      }),
      cli = fakeCli(null, { ...ready, version: null });
    assert.equal(runtime.cliPath, '/extension-storage/agent/node_modules/.bin/thub');
    assert.equal(await runtime.ensure(cli), '1.1.25');
    assert.equal(f.calls[1].command, 'npm');
    assert.deepEqual(f.calls[1].args, [
      'install', '--prefix', '/extension-storage/agent', '--no-save', '--no-audit', '--no-fund', '@andrian.yablonskyy/thub-agent@latest'
    ]);
  });

  test('upgrades a managed Agent missing newly required features', async () => {
    const f = fakeSpawn((command) => command === 'node' ? [0, 'v24.2.0'] : [0, 'installed']),
      runtime = new AgentRuntime({
        globalStoragePath: '/extension-storage',
        cliPath: () => '',
        platform: 'linux',
        spawn: f.spawn
      }),
      cli = fakeCli('1.1.24', { ...ready, version: '1.1.24', connectRttTarget: false });
    assert.equal(await runtime.ensure(cli), '1.1.25');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].command, 'npm');
  });

  test('leaves a configured CLI alone and explains how to restore managed Agent mode', async () => {
    const f = fakeSpawn(() => {
        throw new Error('an explicit CLI must not invoke node or npm');
      }),
      runtime = new AgentRuntime({
        globalStoragePath: '/extension-storage',
        cliPath: () => '/custom/thub',
        platform: 'linux',
        spawn: f.spawn
      }),
      cli = fakeCli('1.1.24', { ...ready, version: '1.1.24', connectForward: false });
    await assert.rejects(runtime.ensure(cli), /Clear thub\.cliPath to let the extension manage its own Agent CLI/);
    assert.equal(f.calls.length, 0);
  });

  test('requires Node.js 24 before installing the Agent', async () => {
    const f = fakeSpawn(() => [0, 'v20.19.0']),
      runtime = new AgentRuntime({
        globalStoragePath: '/extension-storage',
        cliPath: () => '',
        platform: 'linux',
        spawn: f.spawn
      }),
      cli = fakeCli(null, { ...ready, version: null });
    await assert.rejects(runtime.ensure(cli), /Node\.js 24\+ is required/);
    assert.equal(f.calls.length, 1);
  });

  test('runs Windows npm.cmd through a static PowerShell wrapper with separate arguments', async () => {
    const f = fakeSpawn((command) => command === 'node' ? [0, 'v24.0.0'] : [0, 'installed']),
      runtime = new AgentRuntime({
        globalStoragePath: 'C:\\Users\\Developer\\AppData\\Roaming\\Code\\User\\globalStorage\\thub',
        cliPath: () => '',
        platform: 'win32',
        spawn: f.spawn
      }),
      cli = fakeCli(null, { ...ready, version: null });
    assert.equal(runtime.managedCliPath, 'C:\\Users\\Developer\\AppData\\Roaming\\Code\\User\\globalStorage\\thub\\agent\\node_modules\\.bin\\thub.cmd');
    await runtime.ensure(cli);
    const call = f.calls[1],
      script = Buffer.from(call.args.at(-1)!, 'base64').toString('utf16le');
    assert.equal(call.command, 'powershell.exe');
    assert.match(script, /& \$request\.command @arguments/);
    assert.deepEqual(JSON.parse(Buffer.from(call.env.THUB_NPM_INVOCATION!, 'base64').toString('utf8')), {
      command: 'npm.cmd',
      args: [
        'install', '--prefix',
        'C:\\Users\\Developer\\AppData\\Roaming\\Code\\User\\globalStorage\\thub\\agent',
        '--no-save', '--no-audit', '--no-fund', '@andrian.yablonskyy/thub-agent@latest'
      ]
    });
  });
});
