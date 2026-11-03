import type { Resource } from '../cli/types';

export function resourceSlot(resource: Resource): 'HIL' | 'SIL' {
  return resource.type === 'hw' ? 'HIL' : 'SIL';
}

export function resourceToReplace(held: Resource[], target: Resource): Resource | undefined {
  return held.find((resource) => resource.type === target.type && resource.name !== target.name);
}
