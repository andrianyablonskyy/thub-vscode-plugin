// Parsing and formatting with no VS Code dependency (unit-tested).

import type { BoardState, ConnectEvent, ConnectReady, Resource } from './types';

/** The JSON a `--json` command printed: its last line that parses. */
export function parseJsonOutput<T>(stdout: string): T {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--){
    try {
      return JSON.parse(lines[i]) as T;
    }
    catch {
      // not JSON: an older thub's human line — keep looking
    }
  }
  try {
    return JSON.parse(stdout) as T;
  }
  catch {
    throw new Error(`thub printed no JSON: ${stdout.slice(0, 200) || '(nothing)'}`);
  }
}

/**
 * One line of `thub connect --json`. A thub without NDJSON events prints a
 * single object without `event`: that's the ready one. Not JSON → null.
 */
export function parseConnectLine(line: string): ConnectEvent | null {
  const text = line.trim();
  if (!text.startsWith('{')){
    return null;
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text);
  }
  catch {
    return null;
  }
  if (!obj.event && Array.isArray(obj.ports)){
    return { ...(obj as unknown as ConnectReady), event: 'ready' };
  }
  return typeof obj.event === 'string' ? (obj as unknown as ConnectEvent) : null;
}

/** "30m", "2h", "90", "1d" → whole minutes; null when it isn't one. */
export function parseDurationMin(input: string): number | null {
  const m = /^\s*(\d+)\s*([mhd]?)\s*$/i.exec(input);
  if (!m){
    return null;
  }
  const n = Number(m[1]),
    min = n * ({ '': 1, m: 1, h: 60, d: 1440 } as Record<string, number>)[m[2].toLowerCase()];
  return min >= 1 ? min : null;
}

/** 102 min → "1h 42m"; 7 → "7m"; under a minute → "<1m". */
export function formatLeft(ms: number): string {
  if (ms < 60_000){
    return '<1m';
  }
  const min = Math.floor(ms / 60_000),
    h = Math.floor(min / 60);
  return h ? `${h}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`;
}

export function msUntil(iso: string | null | undefined, now = Date.now()): number {
  return iso ? new Date(iso).getTime() - now : 0;
}

/** A board's state for the tree: shape and label, never only colour. */
export function boardState(r: Resource, now = Date.now()): BoardState {
  if (r.reservation && msUntil(r.reservation.until, now) > 0){
    return r.reservation.link ? 'mine' : 'reserved';
  }
  if (r.status === 'OUT_OF_SERVICE' || r.status === 'REGISTERED'){
    return 'offline';
  }
  if (r.status === 'MAINTENANCE'){
    return 'maintenance';
  }
  return r.status === 'BUSY' ? 'job' : 'idle';
}

/** The board label (`board:nucleo-f401re` → "nucleo-f401re"), if it has one. */
export function boardModel(r: Resource): string | null {
  const l = r.labels.find((x) => x.startsWith('board:'));
  return l ? l.slice('board:'.length) : null;
}

/** "board:nucleo-f401re, video-stream" → "nucleo-f401re · camera". */
export function labelsSummary(r: Resource): string {
  const parts: string[] = [];
  const model = boardModel(r);
  if (model){
    parts.push(model);
  }
  if (r.labels.includes('video-stream')){
    parts.push('camera');
  }
  parts.push(...r.labels.filter((l) => !l.startsWith('board:') && l !== 'video-stream'));
  return parts.join(' · ');
}

/** Exit codes of the thub CLI (README §7). */
export const EXIT = {
  OK: 0,
  FAILED: 1,
  INFRA: 2,
  CANCELED: 3,
  USAGE: 4,
  STILL_RUNNING: 5,
  DETACHED: 130
} as const;

export type ExitKind = 'ok' | 'failed' | 'infra' | 'canceled' | 'auth' | 'running' | 'detached' | 'unknown';

/** Code 4 is usage, auth or connection: the extension offers "Sign in to thub". */
export function exitKind(code: number | null): ExitKind {
  switch (code){
    case EXIT.OK: return 'ok';
    case EXIT.FAILED: return 'failed';
    case EXIT.INFRA: return 'infra';
    case EXIT.CANCELED: return 'canceled';
    case EXIT.USAGE: return 'auth';
    case EXIT.STILL_RUNNING: return 'running';
    case EXIT.DETACHED: return 'detached';
    default: return 'unknown';
  }
}

/** The human error from thub's stderr ("Error: …"), without its prefix. */
export function errorMessage(stderr: string, fallback: string): string {
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  return line ? line.replace(/^Error:\s*/, '') : fallback;
}

/** Hides `secret` in anything that's logged. */
export function mask(text: string, secret: string | undefined): string {
  return secret && secret.length >= 4 ? text.split(secret).join(`${secret.slice(0, 4)}…`) : text;
}
