// What the thub CLI (the Agent) prints with --json. Shapes follow the
// Coordinator's Agent API (README §6.1) and `thub connect --json` (§5.6).

export type ResourceStatus = 'IDLE' | 'BUSY' | 'OUT_OF_SERVICE' | 'MAINTENANCE' | 'REGISTERED';

/** A runner's reservation. `id` and `link` only for its holder. */
export interface Reservation {
  by: string | null;
  since: string;
  until: string;
  id?: string;
  link?: string;
}

/** `thub resources --json` — one runner. */
export interface Resource {
  id: string;
  name: string;
  type: 'hw' | 'sw';
  status: ResourceStatus;
  busySource: string | null;
  labels: string[];
  lastHeartbeatAt: string | null;
  reservation: Reservation | null;
}

/** `thub whoami --json`. */
export interface Me {
  kind: 'cli' | 'ci';
  name?: string;
  group?: string | null;
  user?: { username: string; email?: string; role: string };
}

/** `thub jobs --json` — the fields the extension uses. */
export interface Job {
  id: string;
  state: string;
  source?: string;
  resource_id?: string | null;
  resource_name?: string | null;
  created_at?: string;
  message?: string | null;
}

export interface ConnectPort {
  kind: 'uart' | 'swd';
  index: number;
  label: string;
  host: string;
  port: number;
  baudRate?: number;
  serial?: string | null;
  target?: string | null;
}

/** `thub connect --json`: the first line, once the board's Client is linked. */
export interface ConnectReady {
  event?: 'ready';
  client: string;
  link: string;
  until: string | null;
  ports: ConnectPort[];
  video: { camera: string; url: string; udp: string | null } | null;
}

/** `thub connect --json`: every later line (NDJSON). */
export type ConnectEvent =
  | (ConnectReady & { event: 'ready' })
  | { event: 'status'; state: 'waiting' | 'ready'; client?: string; until?: string | null }
  | { event: 'disconnected'; retryMs: number; reason: string | null }
  | { event: 'connected'; again: boolean }
  | { event: 'video'; streaming: boolean; error: string | null }
  | { event: 'fatal'; message: string };

/** How a board shows in the Boards tree and the Reserve quick pick. */
export type BoardState = 'idle' | 'mine' | 'reserved' | 'job' | 'offline' | 'maintenance';

/** What this thub CLI can do — found from its --help, never guessed. */
export interface Features {
  version: string | null;
  reserve: boolean;
  connectNdjson: boolean;
  connectForward: boolean;
  whoamiJson: boolean;
  /** `thub power <client>` for a reservation's holder (not yet in thub). */
  powerByClient: boolean;
}
