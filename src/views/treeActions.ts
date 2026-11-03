function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function treeItemIndex(value: unknown): number | undefined {
  const id = isRecord(value) && typeof value.id === 'string' ? value.id.split(':') : undefined,
    raw = typeof value === 'number' ? value : isRecord(value) ? value.index : undefined,
    index = typeof raw === 'number' ? raw : id?.[0] === 'endpoint' && /^\d+$/.test(id[2]) ? Number(id[2]) : undefined;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : undefined;
}

export function treeItemAddress(value: unknown): string | undefined {
  if (!isRecord(value)){
    return undefined;
  }
  if (typeof value.address === 'string' && value.address.trim()){
    return value.address.trim();
  }
  if (typeof value.id !== 'string' || !value.id.startsWith('endpoint:')){
    return undefined;
  }
  return decode(value.id.split(':')[3] || '');
}

export function treeItemClient(value: unknown): string | undefined {
  if (!isRecord(value)){
    return undefined;
  }
  if (typeof value.client === 'string'){
    return value.client;
  }
  if (typeof value.id !== 'string'){
    return undefined;
  }
  const parts = value.id.split(':');
  return parts[0] === 'endpoint' || parts[0] === 'forward' ? decode(parts[1] || '') : undefined;
}

export function treeItemName(value: unknown): string | undefined {
  if (typeof value === 'string'){
    return value;
  }
  if (!isRecord(value)){
    return undefined;
  }
  if (typeof value.client === 'string'){
    return value.client;
  }
  return typeof value.label === 'string' ? value.label : undefined;
}

export function treeItemForwardName(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.startsWith('forward:')){
    return undefined;
  }
  return decode(value.id.split(':')[2] || '');
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value) || undefined;
  }
  catch {
    return undefined;
  }
}
