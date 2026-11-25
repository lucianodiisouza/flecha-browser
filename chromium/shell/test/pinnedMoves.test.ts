/** Dragging pinned tabs and folders around the sidebar. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../shared/store.ts';

function setup() {
  const store = new Store({ load: () => undefined, save: () => undefined });
  const view = store.attachView(store.createView({ resume: true }));
  const a = store.addTab(view, 'https://a.test/');
  const b = store.addTab(view, 'https://b.test/');
  store.togglePin(view, a.id);
  const folderId = store.newFolder('Docs', { view })!;
  store.togglePin(view, b.id);
  const ids = () => store.activeSpaceOf(view).pinned.map((n) => (n.kind === 'tab' ? n.tabId : n.id));
  return { store, view, a, b, folderId, ids };
}

test('a pinned tab dropped before a folder lands there, not at the end', () => {
  const { store, view, b, folderId, ids, a } = setup();
  assert.deepEqual(ids(), [a.id, folderId, b.id]);
  store.moveTab(view, b.id, { zone: 'pinned', beforeTabId: folderId });
  assert.deepEqual(ids(), [a.id, b.id, folderId]);
});

test('folders reorder, nest, and never go into themselves', () => {
  const { store, view, a, b, folderId, ids } = setup();
  const space = store.activeSpaceOf(view).id;
  assert.equal(store.moveFolder(folderId, { spaceId: space, beforeId: a.id }), true);
  assert.deepEqual(ids(), [folderId, a.id, b.id]);
  const inner = store.newFolder('Inner', { view })!;
  assert.equal(store.moveFolder(inner, { spaceId: space, folderId }), true);
  assert.equal(store.moveFolder(folderId, { spaceId: space, folderId: inner }), false);
  assert.deepEqual(ids(), [folderId, a.id, b.id]);
});

test('ungrouping keeps the tabs where the folder was', () => {
  const { store, view, a, folderId, ids, b } = setup();
  store.moveTab(view, a.id, { zone: 'pinned', folderId });
  assert.deepEqual(store.deleteFolder(folderId, true), []);
  assert.deepEqual(ids(), [a.id, b.id]);
});
