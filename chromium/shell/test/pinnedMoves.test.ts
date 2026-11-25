/** Dragging pinned tabs and folders around the sidebar. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../shared/store.ts';

function setup() {
  const store = new Store({ load: () => undefined, save: () => undefined });
  const a = store.addTab('https://a.test/');
  const b = store.addTab('https://b.test/');
  store.togglePin(a.id);
  const folderId = store.newFolder('Docs')!;
  store.togglePin(b.id);
  const ids = () => store.activeSpace.pinned.map((n) => (n.kind === 'tab' ? n.tabId : n.id));
  return { store, a, b, folderId, ids };
}

test('a pinned tab dropped before a folder lands there, not at the end', () => {
  const { store, b, folderId, ids, a } = setup();
  assert.deepEqual(ids(), [a.id, folderId, b.id]);
  store.moveTab(b.id, { zone: 'pinned', beforeTabId: folderId });
  assert.deepEqual(ids(), [a.id, b.id, folderId]);
});

test('folders reorder, nest, and never go into themselves', () => {
  const { store, a, b, folderId, ids } = setup();
  const space = store.activeSpace.id;
  assert.equal(store.moveFolder(folderId, { spaceId: space, beforeId: a.id }), true);
  assert.deepEqual(ids(), [folderId, a.id, b.id]);
  const inner = store.newFolder('Inner')!;
  assert.equal(store.moveFolder(inner, { spaceId: space, folderId }), true);
  assert.equal(store.moveFolder(folderId, { spaceId: space, folderId: inner }), false);
  assert.deepEqual(ids(), [folderId, a.id, b.id]);
});

test('ungrouping keeps the tabs where the folder was', () => {
  const { store, a, folderId, ids, b } = setup();
  store.moveTab(a.id, { zone: 'pinned', folderId });
  assert.deepEqual(store.deleteFolder(folderId, true), []);
  assert.deepEqual(ids(), [a.id, b.id]);
});

test('a folder moves to another Space with what is in it, and the Space it left shows its next tab', () => {
  const { store, a, b, folderId } = setup();
  const from = store.activeSpace;
  const today = store.addTab('https://today.test/');
  const inner = store.newFolder('Inner')!;
  store.moveFolder(inner, { spaceId: from.id, folderId });
  store.moveTab(b.id, { zone: 'pinned', folderId: inner });
  const to = store.newSpace(false);
  store.activate(b.id);
  assert.equal(store.moveFolder(folderId, { spaceId: to.id }), true);
  assert.deepEqual(from.pinned, [{ kind: 'tab', tabId: a.id }]);
  assert.equal(to.pinned.at(-1)?.kind === 'folder' && to.pinned.at(-1)!.id, folderId);
  assert.equal(store.locate(b.id)?.space?.id, to.id);
  assert.equal(from.activeTabId, today.id);
});
