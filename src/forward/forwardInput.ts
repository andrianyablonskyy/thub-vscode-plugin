import type { ForwardConfig } from '../cli/types';
import { normalizeForwards } from './ForwardStore';

export function parseForwardInput(value: string): ForwardConfig {
  const separator = value.lastIndexOf(':');
  if (separator < 0){
    throw new Error('Enter a service name and port in the format ServiceName:port (for example, Web UI:3000)');
  }
  const name = value.slice(0, separator).trim(),
    portText = value.slice(separator + 1).trim();
  if (!/^\d+$/.test(portText)){
    throw new Error('Enter a port between 1 and 65535 after the colon');
  }
  return normalizeForwards([{ name, clientPort: Number(portText) }])[0];
}
