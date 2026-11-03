import type * as vscode from 'vscode';
import type { RttConfig } from '../cli/types';

const STORAGE_KEY = 'thub.rttConfigs.v1',
  ADDRESS = /^(?:0[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})$/,
  TARGET = /^[A-Za-z0-9_.-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeRtts(value: unknown): RttConfig[] {
  if (!Array.isArray(value)){
    throw new Error('RTT configurations must be a list');
  }
  const seen = new Set<number>();
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.address !== 'string' || typeof entry.size !== 'string' ||
        typeof entry.index !== 'number' || !Number.isInteger(entry.index) ||
        typeof entry.channel !== 'number' || !Number.isInteger(entry.channel)){
      throw new Error(`RTT configuration ${index + 1} needs an ST-Link, address, size and channel`);
    }
    const { address, size, channel } = entry,
      probeIndex = entry.index;
    if (probeIndex < 1 || probeIndex > 64){
      throw new Error(`RTT configuration ${index + 1}: ST-Link must be between 1 and 64`);
    }
    if (!ADDRESS.test(address) || !ADDRESS.test(size)){
      throw new Error(`RTT configuration ${index + 1}: address and size must be decimal or hexadecimal numbers`);
    }
    const start = Number(address),
      length = Number(size);
    if (!Number.isSafeInteger(start) || start < 0 || start > 0xffffffff ||
        !Number.isSafeInteger(length) || length < 1 || length > 0xffffffff || start + length > 0x1_0000_0000){
      throw new Error(`RTT configuration ${index + 1}: search range must fit in the 32-bit target address space`);
    }
    if (channel < 0 || channel > 255){
      throw new Error(`RTT configuration ${index + 1}: channel must be between 0 and 255`);
    }
    if (entry.target !== undefined && (typeof entry.target !== 'string' || !TARGET.test(entry.target))){
      throw new Error(`RTT configuration ${index + 1}: OpenOCD target must be a target script name`);
    }
    if (seen.has(probeIndex)){
      throw new Error(`An RTT configuration for ST-Link ${probeIndex} already exists`);
    }
    seen.add(probeIndex);
    return { index: probeIndex, address, size, channel, ...(entry.target ? { target: entry.target } : {}) };
  });
}

export class RttStore {
  constructor(private readonly state: vscode.Memento){}

  read(resourceId: string): RttConfig[] {
    const stored = this.state.get<unknown>(STORAGE_KEY, {});
    if (!isRecord(stored)){
      throw new Error('Saved RTT configurations are invalid; remove the extension global storage entry and try again');
    }
    const configs = stored[resourceId];
    return configs === undefined ? [] : normalizeRtts(configs);
  }

  async write(resourceId: string, configs: RttConfig[]): Promise<void> {
    const stored = this.state.get<unknown>(STORAGE_KEY, {});
    if (!isRecord(stored)){
      throw new Error('Saved RTT configurations are invalid; remove the extension global storage entry and try again');
    }
    await this.state.update(STORAGE_KEY, { ...stored, [resourceId]: normalizeRtts(configs) });
  }
}
