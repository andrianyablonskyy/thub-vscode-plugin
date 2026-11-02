import * as assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { ForwardStore, normalizeForwards } from '../../src/forward/ForwardStore';

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

suite('forwarded service configuration', () => {
  test('validates names and Client ports, and rejects duplicate names', () => {
    assert.deepEqual(normalizeForwards([{ name: ' Web UI ', clientPort: 3000 }]), [{ name: 'Web UI', clientPort: 3000 }]);
    for (const services of [
      [{ name: 'bad/name', clientPort: 3000 }],
      [{ name: 'Web UI', clientPort: 0 }],
      [{ name: 'Web UI', clientPort: 65536 }],
      [{ name: 'Web UI', clientPort: '3000' }],
      [{ name: 'Web UI', clientPort: 3000 }, { name: 'web ui', clientPort: 8080 }]
    ]){
      assert.throws(() => normalizeForwards(services));
    }
  });

  test('saves service lists per resource for reconnects', async () => {
    const store = new ForwardStore(new MemoryState());
    await store.write('resource-1', [{ name: 'Web UI', clientPort: 3000 }]);
    await store.write('resource-2', [{ name: 'Docs', clientPort: 8080 }]);
    assert.deepEqual(store.read('resource-1'), [{ name: 'Web UI', clientPort: 3000 }]);
    assert.deepEqual(store.read('resource-2'), [{ name: 'Docs', clientPort: 8080 }]);
    await store.write('resource-1', []);
    assert.deepEqual(store.read('resource-1'), []);
  });
});
