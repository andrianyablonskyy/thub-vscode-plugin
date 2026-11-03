import * as assert from 'node:assert/strict';
import { treeItemAddress, treeItemBoardId, treeItemClient, treeItemForwardName, treeItemIndex, treeItemName } from '../../src/views/treeActions';

suite('tree actions', () => {
  test('reads endpoint indices from tree nodes and direct commands', () => {
    assert.equal(treeItemIndex({ index: 2 }), 2);
    assert.equal(treeItemIndex(1), 1);
    assert.equal(treeItemIndex({ index: 0 }), 0);
    assert.equal(treeItemIndex({ index: 1.5 }), undefined);
    assert.equal(treeItemIndex(undefined), undefined);
  });

  test('reads a copyable address from an endpoint node', () => {
    assert.equal(treeItemAddress({ address: '127.0.0.1:5001' }), '127.0.0.1:5001');
    assert.equal(treeItemAddress({ id: 'endpoint:hil%3A1:2:127.0.0.1%3A5001' }), '127.0.0.1:5001');
    assert.equal(treeItemAddress({ address: '  ' }), undefined);
    assert.equal(treeItemAddress(undefined), undefined);
  });

  test('recovers the selected resource and probe from tree-item ids', () => {
    const item = { id: 'endpoint:hil%3A1:2:127.0.0.1%3A5001', label: 'RTT · ST-Link 2' };
    assert.equal(treeItemClient(item), 'hil:1');
    assert.equal(treeItemIndex(item), 2);
    assert.equal(treeItemIndex({ id: 'endpoint:hil%3A1:0:127.0.0.1%3A5001' }), 0);
    assert.equal(treeItemName({ label: 'hil-1' }), 'hil-1');
    assert.equal(treeItemName({ label: { label: 'hil-2', highlights: [] } }), 'hil-2');
    assert.equal(treeItemBoardId({ id: 'board:resource-123', label: 'hil-3' }), 'resource-123');
    assert.equal(treeItemBoardId({ id: 'endpoint:hil-1:0:' }), undefined);
  });

  test('recovers forwarded service names without the tree label suffix', () => {
    assert.equal(treeItemClient({ id: 'forward:sil-1:Web%20UI' }), 'sil-1');
    assert.equal(treeItemForwardName({ id: 'forward:sil-1:Web%20UI' }), 'Web UI');
  });
});
