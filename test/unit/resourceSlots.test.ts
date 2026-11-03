import * as assert from 'node:assert/strict';
import type { Resource } from '../../src/cli/types';
import { resourceSlot, resourceToReplace } from '../../src/session/resourceSlots';
import { supportsResourceFeature } from '../../src/session/resourceFeatures';

const resource = (name: string, type: Resource['type']): Resource => ({
  id: name, name, type, status: 'IDLE', busySource: null, labels: [], lastHeartbeatAt: null,
  reservation: { by: 'me', since: '2026-01-01T00:00:00Z', until: '2026-01-01T01:00:00Z', link: 'ws://local' }
});

suite('parallel reservation slots', () => {
  test('HIL and SIL are independent slots', () => {
    const hil = resource('hil-1', 'hw'),
      sil = resource('sil-1', 'sw');
    assert.equal(resourceSlot(hil), 'HIL');
    assert.equal(resourceSlot(sil), 'SIL');
    assert.equal(resourceToReplace([hil], sil), undefined);
  });

  test('a second reservation in the same slot replaces only that slot', () => {
    const hil = resource('hil-1', 'hw'),
      sil = resource('sil-1', 'sw');
    assert.equal(resourceToReplace([hil, sil], resource('hil-2', 'hw')), hil);
    assert.equal(resourceToReplace([hil, sil], resource('sil-2', 'sw')), sil);
    assert.equal(resourceToReplace([hil, sil], hil), undefined);
  });

  test('SIL resources support only forwarding and GDB', () => {
    const sil = { type: 'sw' } as const;
    for (const feature of ['uart', 'rtt', 'video', 'power'] as const){
      assert.equal(supportsResourceFeature(sil, feature), false, feature);
    }
    assert.equal(supportsResourceFeature(sil, 'forwarding'), true);
    assert.equal(supportsResourceFeature(sil, 'gdb'), true);
    for (const feature of ['uart', 'rtt', 'video', 'power', 'forwarding', 'gdb'] as const){
      assert.equal(supportsResourceFeature({ type: 'hw' }, feature), true, feature);
    }
  });
});
