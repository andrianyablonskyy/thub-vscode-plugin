import type { Resource } from '../cli/types';

export type ResourceFeature = 'uart' | 'rtt' | 'video' | 'gdb' | 'forwarding' | 'power';

export function supportsResourceFeature(resource: Pick<Resource, 'type'>, feature: ResourceFeature): boolean {
  return resource.type === 'hw' || feature === 'gdb' || feature === 'forwarding';
}
