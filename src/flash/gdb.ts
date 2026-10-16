// The GDB batch run that flashes a board over thub (no VS Code dependency).

export interface FlashArgs {
  image: string;
  gdbPort: number;
  verify: boolean;
  /** After load: reset and run, or reset and stay halted. */
  then: 'run' | 'halt';
}

/**
 * gdb -batch <image> -ex "target extended-remote 127.0.0.1:<port>"
 *   -ex "monitor reset halt" -ex load [-ex compare-sections]
 *   -ex "monitor reset run" | -ex "monitor reset halt"
 * `load` sends the ELF from this machine; OpenOCD's `monitor program` would
 * look the file up on the Client host.
 */
export function flashArgs({ image, gdbPort, verify, then }: FlashArgs): string[] {
  return [
    '-batch', '-nx', image,
    '-ex', 'set confirm off',
    '-ex', 'set remotetimeout 30',
    '-ex', `target extended-remote 127.0.0.1:${gdbPort}`,
    '-ex', 'monitor reset halt',
    '-ex', 'load',
    ...(verify ? ['-ex', 'compare-sections'] : []),
    '-ex', then === 'run' ? 'monitor reset run' : 'monitor reset halt',
    '-ex', 'detach'
  ];
}

export interface FlashOutcome {
  ok: boolean;
  verified: boolean;
  /** One line for the notification. */
  summary: string;
}

/** Reads GDB's output: did the load (and the verify) succeed? */
export function readFlashOutput(output: string, code: number | null, verify: boolean): FlashOutcome {
  const text = output,
    mismatch = /MIS-MATCHED/i.test(text),
    loaded = /Transfer rate|Start address/i.test(text),
    failure = text.split(/\r?\n/).find((l) => /(error|failed|refused|timed out|not halted|Connection closed|No such file|can't|cannot)/i.test(l)
      && !/^warning:/i.test(l.trim()));
  if (code === 0 && loaded && !mismatch){
    return { ok: true, verified: verify && /matched/i.test(text), summary: verify ? 'Load, compare-sections and reset over GDB · verified' : 'Load and reset over GDB' };
  }
  if (mismatch){
    return { ok: false, verified: false, summary: 'Verify failed: a section on the board doesn\'t match the image' };
  }
  return { ok: false, verified: false, summary: (failure || `GDB exited with ${code}`).trim().slice(0, 200) };
}
