import type * as vscode from 'vscode';
import type { ForwardConfig } from '../cli/types';

const STORAGE_KEY = 'thub.forwardedServices.v1',
  SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeForwards(value: unknown): ForwardConfig[] {
  if (!Array.isArray(value)){
    throw new Error('Forwarded services must be a list');
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.clientPort !== 'number' || !Number.isInteger(entry.clientPort)){
      throw new Error(`Forwarded service ${index + 1} needs a name and a Client port`);
    }
    const name = entry.name.trim(),
      clientPort = entry.clientPort,
      key = name.toLowerCase();
    if (!SERVICE_NAME.test(name)){
      throw new Error(`"${name}" is not a valid service name (use 1–64 letters, numbers, spaces, dots, underscores or hyphens)`);
    }
    if (clientPort < 1 || clientPort > 65535){
      throw new Error(`${name}: Client port must be between 1 and 65535`);
    }
    if (seen.has(key)){
      throw new Error(`A forwarded service named "${name}" already exists`);
    }
    seen.add(key);
    return { name, clientPort };
  });
}

export class ForwardStore {
  constructor(private readonly state: vscode.Memento){}

  read(resourceId: string): ForwardConfig[] {
    const stored = this.state.get<unknown>(STORAGE_KEY, {});
    if (!isRecord(stored)){
      throw new Error('Saved forwarded services are invalid; remove the extension global storage entry and try again');
    }
    const services = stored[resourceId];
    return services === undefined ? [] : normalizeForwards(services);
  }

  async write(resourceId: string, services: ForwardConfig[]): Promise<void> {
    const stored = this.state.get<unknown>(STORAGE_KEY, {});
    if (!isRecord(stored)){
      throw new Error('Saved forwarded services are invalid; remove the extension global storage entry and try again');
    }
    await this.state.update(STORAGE_KEY, { ...stored, [resourceId]: normalizeForwards(services) });
  }
}
