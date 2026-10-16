// The thub CLI (the Agent), wrapped: every call the extension makes to the
// Coordinator goes through here. No VS Code dependency, so it's unit-tested
// with a fake spawn.

import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { errorMessage, exitKind, mask, parseJsonOutput, type ExitKind } from './parse';
import type { Features, Job, Me, Resource } from './types';

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface CliOptions {
  /** thub.cliPath, or "" for thub on PATH. */
  cliPath: () => string;
  /** thub.url (or undefined: the CLI's own config). */
  url: () => string | undefined;
  /** The access key, from secret storage. */
  key: () => Promise<string | undefined>;
  log: (line: string) => void;
  spawn?: SpawnFn;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A thub command that didn't exit 0: its code, kind and message. */
export class ThubError extends Error {
  constructor(public readonly code: number | null, public readonly kind: ExitKind, message: string, public readonly stderr = ''){
    super(message);
    this.name = 'ThubError';
  }
}

export class ThubCli {
  private features?: Promise<Features>;
  private readonly spawnFn: SpawnFn;

  constructor(private readonly opts: CliOptions){
    this.spawnFn = opts.spawn ?? spawnProcess;
  }

  get command(): string {
    return this.opts.cliPath().trim() || 'thub';
  }

  /** The child's environment: URL and key from VS Code, self-update off. */
  async env(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, THUB_NO_SELF_UPDATE: '1' },
      url = this.opts.url()?.trim(),
      key = await this.opts.key();
    if (url){
      env.THUB_URL = url;
    }
    if (key){
      env.THUB_KEY = key;
    }
    return env;
  }

  /** Runs `thub <args>` (an argument array — never a shell string). */
  async run(args: string[], { timeoutMs = 60_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    const env = await this.env(),
      key = env.THUB_KEY;
    this.opts.log(`$ thub ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(this.command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      }
      catch (err){
        return reject(err);
      }
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => child.kill(), timeoutMs),
        onAbort = () => child.kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (d) => {
        stdout += d;
      });
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(err.code === 'ENOENT'
          ? new ThubError(null, 'unknown', `The thub CLI isn't installed (${this.command} not found): npm i -g @andrian.yablonskyy/thub-agent`)
          : err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (stderr.trim()){
          this.opts.log(mask(stderr.trimEnd(), key));
        }
        resolve({ code, stdout, stderr });
      });
    });
  }

  /** Runs it and throws a ThubError unless it exits 0. */
  async ok(args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string> {
    const r = await this.run(args, opts);
    if (r.code !== 0){
      throw new ThubError(r.code, exitKind(r.code), errorMessage(r.stderr, `thub ${args[0]} exited with ${r.code}`), r.stderr);
    }
    return r.stdout;
  }

  async json<T>(args: string[], opts?: { timeoutMs?: number }): Promise<T> {
    return parseJsonOutput<T>(await this.ok([...args, '--json'], opts));
  }

  /** `thub --version`, or null when there's no thub. */
  async version(): Promise<string | null> {
    try {
      const r = await this.run(['--version'], { timeoutMs: 15_000 });
      return r.code === 0 ? r.stdout.trim() : null;
    }
    catch {
      return null;
    }
  }

  /** What this thub can do, from its --help (cached until reset()). */
  getFeatures(): Promise<Features> {
    this.features ??= (async () => {
      const help = async (...cmd: string[]) => {
          try {
            const r = await this.run([...cmd, '--help'], { timeoutMs: 15_000 });
            return r.code === 0 ? r.stdout : '';
          }
          catch {
            return '';
          }
        },
        [version, reserve, connect, whoami, power] = await Promise.all([
          this.version(), help('reserve'), help('connect'), help('whoami'), help('power')
        ]);
      return {
        version,
        reserve: /--for/.test(reserve),
        connectNdjson: /NDJSON/i.test(connect),
        connectForward: /--forward/.test(connect),
        whoamiJson: /--json/.test(whoami),
        powerByClient: /<client>/.test(power)
      };
    })();
    return this.features;
  }

  reset(): void {
    this.features = undefined;
  }

  resources(): Promise<Resource[]> {
    return this.json<Resource[]>(['resources']);
  }

  async whoami(): Promise<Me> {
    if ((await this.getFeatures()).whoamiJson){
      return this.json<Me>(['whoami']);
    }
    // An older thub: its text, "alice (User) <a@x>" or `CI token "name"`.
    const text = (await this.ok(['whoami'])).trim(),
      ci = /^CI token "(.*)"/.exec(text);
    if (ci){
      return { kind: 'ci', name: ci[1] };
    }
    const m = /^(\S+)\s+\(([^)]+)\)/.exec(text);
    return { kind: 'cli', user: { username: m ? m[1] : text.split(/\s/)[0], role: m ? m[2].toLowerCase() : 'user' } };
  }

  async jobs(): Promise<Job[]> {
    return this.json<Job[]>(['jobs', '--mine']);
  }

  /** Reserves (or, already yours, extends from now) for `minutes`. */
  reserve(client: string, minutes: number): Promise<Resource> {
    return this.json<Resource>(['reserve', client, '--for', `${minutes}m`]);
  }

  release(client: string): Promise<Resource & { released: boolean }> {
    return this.json<Resource & { released: boolean }>(['release', client]);
  }

  /** USB power of the Client running job `jobId` (README §8.7). */
  power(action: 'on' | 'off' | 'reset', jobId: string, { port, delaySec }: { port?: number; delaySec?: number } = {}): Promise<unknown> {
    return this.json(['power', action, jobId,
      ...(port ? ['--port', String(port)] : []),
      ...(action === 'reset' && delaySec !== undefined ? ['--delay', String(delaySec)] : [])]);
  }

  /** The long-lived `thub connect` child of a session. */
  async startConnect(client: string, ports: { uart: number; gdb: number; video: number }, target?: string): Promise<ChildProcess> {
    const args = ['connect', client, '--json',
      '--uart-port', String(ports.uart), '--gdb-port', String(ports.gdb), '--video-port', String(ports.video),
      ...(target ? ['--target', target] : [])];
    this.opts.log(`$ thub ${args.join(' ')}`);
    return this.spawnFn(this.command, args, { env: await this.env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  }
}
