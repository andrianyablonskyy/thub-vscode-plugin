// Flash after build: which finished task triggers it, and the image path's
// variables (no VS Code dependency: callers pass what they need).

export type WhenNoBoard = 'ask' | 'reserve' | 'skip';
export type Then = 'run' | 'halt' | 'debug';

export interface FlashAfterBuildConfig {
  enabled: boolean;
  buildTask: string;
  image: string;
  skipUnchanged: boolean;
  board: string;
  whenNoBoard: WhenNoBoard;
  target: string;
  powerCycle: boolean;
  verify: boolean;
  then: Then;
  openSerial: boolean;
}

export const FLASH_AFTER_BUILD_DEFAULTS: FlashAfterBuildConfig = {
  enabled: false,
  buildTask: '',
  image: '${workspaceFolder}/build/${workspaceFolderBasename}.elf',
  skipUnchanged: true,
  board: 'reserved',
  whenNoBoard: 'ask',
  target: '',
  powerCycle: false,
  verify: true,
  then: 'run',
  openSerial: false
};

/** The setting with every key filled in (unknown values back to defaults). */
export function normalizeConfig(raw: Partial<FlashAfterBuildConfig> | undefined): FlashAfterBuildConfig {
  const c = { ...FLASH_AFTER_BUILD_DEFAULTS, ...(raw || {}) };
  if (!['ask', 'reserve', 'skip'].includes(c.whenNoBoard)){
    c.whenNoBoard = 'ask';
  }
  if (!['run', 'halt', 'debug'].includes(c.then)){
    c.then = 'run';
  }
  return c;
}

export interface FinishedTask {
  name: string;
  /** The task's type ("shell", "cmake", "thub" …). */
  type: string;
  isBuild: boolean;
  exitCode: number | undefined;
}

/**
 * Whether a finished task should flash: switched on, it succeeded, it's
 * the configured task (by label, with or without its source prefix) or —
 * none configured — any build-group task. Never a thub task (no loops).
 */
export function shouldFlash(task: FinishedTask, cfg: FlashAfterBuildConfig): boolean {
  if (!cfg.enabled || task.exitCode !== 0 || task.type === 'thub'){
    return false;
  }
  if (!cfg.buildTask){
    return task.isBuild;
  }
  const want = cfg.buildTask.trim();
  return task.name === want || `${task.type}: ${task.name}` === want;
}

export interface VariableContext {
  workspaceFolder?: string;
  env: (name: string) => string | undefined;
  config: (key: string) => unknown;
  command: (id: string) => Promise<unknown>;
}

/** ${workspaceFolder}, ${workspaceFolderBasename}, ${env:X}, ${config:x}, ${command:x}. */
export async function resolveVariables(text: string, ctx: VariableContext): Promise<string> {
  const re = /\$\{([^}]+)\}/g,
    parts: Array<string | Promise<string>> = [];
  let last = 0,
    m: RegExpExecArray | null;
  while ((m = re.exec(text))){
    parts.push(text.slice(last, m.index));
    const name = m[1];
    parts.push((async () => {
      if (name === 'workspaceFolder'){
        return need(ctx.workspaceFolder, name);
      }
      if (name === 'workspaceFolderBasename'){
        return need(ctx.workspaceFolder, name).split(/[\\/]/).filter(Boolean).pop() || '';
      }
      if (name.startsWith('env:')){
        return ctx.env(name.slice(4)) ?? '';
      }
      if (name.startsWith('config:')){
        const v = ctx.config(name.slice(7));
        return v === undefined || v === null ? '' : String(v);
      }
      if (name.startsWith('command:')){
        const v = await ctx.command(name.slice(8));
        if (v === undefined || v === null || v === ''){
          throw new Error(`\${${name}} gave nothing`);
        }
        return String(v);
      }
      throw new Error(`Unknown variable \${${name}}`);
    })());
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return (await Promise.all(parts)).join('');
}

function need(v: string | undefined, name: string): string {
  if (!v){
    throw new Error(`\${${name}} needs an open folder`);
  }
  return v;
}
