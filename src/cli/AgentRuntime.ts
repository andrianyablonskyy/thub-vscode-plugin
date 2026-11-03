import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as path from 'node:path';
import type { Features } from './types';

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

interface RuntimeCli {
  readonly command: string;
  version(): Promise<string | null>;
  getFeatures(): Promise<Features>;
  reset(): void;
}

interface AgentRuntimeOptions {
  globalStoragePath: string;
  cliPath: () => string;
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
}

const AGENT_PACKAGE = '@andrian.yablonskyy/thub-agent',
  MIN_NODE_MAJOR = 24;

function run(command: string, args: string[], platform: NodeJS.Platform, spawn: SpawnFn): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let child: ChildProcess;
  const env = { ...process.env };
  let actualCommand = command,
    actualArgs = args;
  if (platform === 'win32' && command === 'npm.cmd'){
    const invocation = Buffer.from(JSON.stringify({ command, args }), 'utf8').toString('base64'),
      script = [
        '$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:THUB_NPM_INVOCATION)) | ConvertFrom-Json',
        '$arguments = [string[]]$request.args',
        '& $request.command @arguments',
        'exit $LASTEXITCODE'
      ].join('; ');
    actualCommand = 'powershell.exe';
    actualArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    env.THUB_NPM_INVOCATION = invocation;
  }
  try {
    child = spawn(actualCommand, actualArgs, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  }
  catch (err){
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let stdout = '',
      stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (data: string) => {
      stdout += data;
    });
    child.stderr?.setEncoding('utf8').on('data', (data: string) => {
      stderr += data;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export class AgentRuntime {
  private readonly platform: NodeJS.Platform;
  private readonly spawnFn: SpawnFn;
  private readonly pathApi: typeof path;
  private installPromise?: Promise<void>;

  constructor(private readonly options: AgentRuntimeOptions){
    this.platform = options.platform ?? process.platform;
    this.spawnFn = options.spawn ?? spawnProcess;
    this.pathApi = this.platform === 'win32' ? path.win32 : path;
  }

  get managedCliPath(): string {
    return this.pathApi.join(this.options.globalStoragePath, 'agent', 'node_modules', '.bin',
      this.platform === 'win32' ? 'thub.cmd' : 'thub');
  }

  get cliPath(): string {
    return this.options.cliPath().trim() || this.managedCliPath;
  }

  async ensure(cli: RuntimeCli): Promise<string> {
    let version = await cli.version(),
      features = await cli.getFeatures();
    if (version && this.hasRequiredFeatures(features)){
      return version;
    }

    if (this.options.cliPath().trim()){
      throw new Error(`The configured thub CLI (${cli.command}) needs \`connect --rtt\` with target support and \`connect --forward\`. Clear thub.cliPath to let the extension manage its own Agent CLI, or update the configured CLI.`);
    }

    const install = this.installPromise ??= this.installManagedAgent();
    try {
      await install;
    }
    finally {
      if (this.installPromise === install){
        this.installPromise = undefined;
      }
    }

    cli.reset();
    version = await cli.version();
    features = await cli.getFeatures();
    if (!version || !this.hasRequiredFeatures(features)){
      throw new Error(`The installed thub Agent${version ? ` (${version})` : ''} does not provide the required \`connect --rtt\` target support and \`connect --forward\` options. Check that the latest @andrian.yablonskyy/thub-agent is available from npm.`);
    }
    return version;
  }

  private async installManagedAgent(): Promise<void> {
    await this.requireNode24();
    const agentPath = this.pathApi.join(this.options.globalStoragePath, 'agent');
    const npm = this.platform === 'win32' ? 'npm.cmd' : 'npm',
      result = await run(npm, [
        'install', '--prefix', agentPath, '--no-save', '--no-audit', '--no-fund', `${AGENT_PACKAGE}@latest`
      ], this.platform, this.spawnFn).catch((err: unknown) => {
        throw new Error(`Could not run npm to install the thub Agent: ${err instanceof Error ? err.message : String(err)}`);
      });
    if (result.code !== 0){
      throw new Error(`Could not install the thub Agent in VS Code storage (npm exited with ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  private hasRequiredFeatures(features: Features): boolean {
    return features.reserve && features.connectNdjson && features.connectRtt && features.connectRttTarget && features.connectForward;
  }

  private async requireNode24(): Promise<void> {
    const result = await run('node', ['--version'], this.platform, this.spawnFn).catch(() => {
      throw new Error('Node.js 24+ and npm are required to install the thub Agent automatically. Install Node.js from https://nodejs.org/en/download and ensure node and npm are on PATH.');
    });
    if (result.code !== 0){
      throw new Error('Node.js 24+ and npm are required to install the thub Agent automatically. Install Node.js from https://nodejs.org/en/download and ensure node and npm are on PATH.');
    }
    const match = /^v?(\d+)/.exec(result.stdout.trim());
    if (!match || Number(match[1]) < MIN_NODE_MAJOR){
      throw new Error(`Node.js 24+ is required to install the thub Agent automatically; found ${result.stdout.trim() || 'an unknown version'}. Install Node.js from https://nodejs.org/en/download and ensure node and npm are on PATH.`);
    }
  }
}
