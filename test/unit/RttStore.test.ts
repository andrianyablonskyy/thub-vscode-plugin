import * as assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { RttStore, normalizeRtts } from '../../src/rtt/RttStore';
import { RttDecoder } from '../../src/rtt/RttDecoder';

class MemoryState implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

suite('RTT configuration and stream decoding', () => {
  test('validates a 32-bit search range and rejects invalid or duplicate probe entries', () => {
    assert.deepEqual(normalizeRtts([{ index: 1, address: '0x20000000', size: '0x10000', channel: 0, target: 'stm32g4x' }]), [
      { index: 1, address: '0x20000000', size: '0x10000', channel: 0, target: 'stm32g4x' }
    ]);
    assert.deepEqual(normalizeRtts([{ index: 1, address: '0x20000000', size: '0x10000', channel: 0 }]), [
      { index: 1, address: '0x20000000', size: '0x10000', channel: 0 }
    ]);
    for (const configs of [
      [{ index: 1, address: '0x20000000; shutdown', size: '0x10000', channel: 0 }],
      [{ index: 1, address: '0xFFFFFFFF', size: '2', channel: 0 }],
      [{ index: 1, address: '0x20000000', size: '0', channel: 0 }],
      [{ index: 1, address: '0x20000000', size: '0x10000', channel: 256 }],
      [{ index: 1, address: '0x20000000', size: '0x10000', channel: 0, target: '../../shutdown' }],
      [{ index: 1, address: '0x20000000', size: '0x10000', channel: 0 }, { index: 1, address: '0x20000000', size: '0x10000', channel: 1 }]
    ]){
      assert.throws(() => normalizeRtts(configs));
    }
  });

  test('saves RTT settings per resource and supports removing a setup', async () => {
    const store = new RttStore(new MemoryState()),
      config = { index: 1, address: '0x20000000', size: '0x10000', channel: 0, target: 'stm32g4x' };
    await store.write('resource-1', [config]);
    await store.write('resource-2', [{ ...config, index: 2, channel: 1 }]);
    assert.deepEqual(store.read('resource-1'), [config]);
    assert.deepEqual(store.read('resource-2'), [{ ...config, index: 2, channel: 1 }]);
    await store.write('resource-1', []);
    assert.deepEqual(store.read('resource-1'), []);
  });

  test('decodes UTF-8 characters split across RTT network chunks', () => {
    const decoder = new RttDecoder(),
      bytes = Buffer.from('RTT ✓');
    assert.equal(decoder.write(bytes.subarray(0, bytes.length - 2)), 'RTT ');
    assert.equal(decoder.write(bytes.subarray(bytes.length - 2)), '✓');
    assert.equal(decoder.end(), '');
  });
});
