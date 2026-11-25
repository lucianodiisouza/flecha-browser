/** Several windows over one Store: each has its own Space, tabs and history (shared/store.ts, WindowView). Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../shared/store.ts';
import type { BrowserState } from '../../shared/types';

function setup() {
  let saved = '';
  const store = new Store({ load: () => undefined, save: (json) => (saved = json) });
  const first = store.attachView(store.createView({ resume: true }));
  const second = store.attachView(store.createView({ from: first }));
  const shown = (view: typeof first) => store.activeTabOf(view)?.id;
  return { store, first, second, shown, saved: () => (store.saveNow(), JSON.parse(saved) as BrowserState) };
}

test('a new window opens in the Space it was opened from and shows no tab', () => {
  const { store, first, second, shown } = setup();
  const a = store.addTab(first, 'https://a.example/').id;
  assert.equal(second.activeSpaceId, first.activeSpaceId);
  assert.equal(shown(first), a);
  assert.equal(shown(second), undefined);
});

test('two windows are in different Spaces, each with its own active tab', () => {
  const { store, first, second, shown } = setup();
  const home = first.activeSpaceId;
  const a = store.addTab(first, 'https://a.example/').id;
  const work = store.newSpace(second).id;
  const b = store.addTab(second, 'https://b.example/').id;
  assert.equal(first.activeSpaceId, home);
  assert.equal(second.activeSpaceId, work);
  assert.equal(shown(first), a);
  assert.equal(shown(second), b);
  // Each window gets the state as it sees it.
  assert.equal(store.stateFor(first).activeSpaceId, home);
  assert.equal(store.stateFor(second).activeSpaceId, work);
  assert.equal(store.stateFor(second).spaces.find((s) => s.id === work)?.activeTabId, b);
});

test('a tab shown in one window leaves the window that had it, which goes back to its last tab', () => {
  const { store, first, second, shown } = setup();
  const a = store.addTab(first, 'https://a.example/').id;
  const b = store.addTab(first, 'https://b.example/').id;
  assert.equal(shown(first), b);
  store.activate(second, b);
  assert.equal(shown(second), b);
  assert.equal(shown(first), a);
  assert.equal(store.shownElsewhere(b, first), second);
  // With no tab of its own to go back to, the window shows none.
  store.activate(second, a);
  assert.equal(shown(second), a);
  assert.equal(shown(first), b);
  store.closeTab(b);
  assert.equal(shown(first), undefined);
  assert.equal(shown(second), a);
});

test('closing a tab moves its window on to a free neighbour, never to a tab the other window shows', () => {
  const { store, first, second, shown } = setup();
  const a = store.addTab(first, 'https://a.example/').id;
  const b = store.addTab(first, 'https://b.example/', { afterTabId: a }).id;
  const c = store.addTab(first, 'https://c.example/', { afterTabId: b }).id;
  store.activate(second, c);
  store.activate(first, b);
  store.closeTab(b);
  assert.equal(shown(second), c);
  assert.equal(shown(first), a);
});

test('a split moves as a pair to the window that shows either half', () => {
  const { store, first, second, shown } = setup();
  const a = store.addTab(first, 'https://a.example/').id;
  const b = store.addTab(first, 'https://b.example/').id;
  const c = store.addTab(first, 'https://c.example/').id;
  store.activate(first, a);
  store.splitWith(first, b);
  assert.deepEqual(store.visibleTabIds(first), [a, b]);
  store.activate(second, a);
  assert.deepEqual(store.visibleTabIds(second), [a, b]);
  assert.equal(shown(first), c);
});

test('switching to a Space another window shows does not take its tab', () => {
  const { store, first, second, shown } = setup();
  const home = first.activeSpaceId;
  const work = store.newSpace(first).id;
  const a = store.addTab(first, 'https://a.example/').id;
  const b = store.addTab(first, 'https://b.example/').id;
  assert.equal(shown(first), b);
  // The second window's first time in the Space: the first keeps its tab, this one gets the most recent free one.
  store.switchSpace(second, work);
  assert.equal(shown(first), b);
  assert.equal(shown(second), a);
  // Back and forth, a window finds the tab it left.
  store.switchSpace(second, home);
  assert.equal(shown(second), undefined);
  store.switchSpace(second, work);
  assert.equal(shown(second), a);
});

test('each window keeps its own history', () => {
  const { store, first, second } = setup();
  const a = store.addTab(first, 'https://a.example/').id;
  const b = store.addTab(second, 'https://b.example/').id;
  // The window the session began with knows the tabs' earlier use; a new one only its own.
  assert.equal(typeof store.lastShown(first, b), 'number');
  assert.equal(store.lastShown(second, a), undefined);
  assert.equal(typeof store.lastShown(second, b), 'number');
});

test('the sidebar is each window\'s own, and the saved state follows the window in front', () => {
  const { store, first, second, saved } = setup();
  const home = first.activeSpaceId;
  const a = store.addTab(first, 'https://a.example/').id;
  const work = store.newSpace(second).id;
  const b = store.addTab(second, 'https://b.example/').id;
  store.setSidebarVisible(second, false);
  assert.equal(first.sidebarVisible, true);
  assert.equal(saved().activeSpaceId, home);
  assert.equal(saved().sidebarVisible, true);
  store.focusView(second);
  assert.equal(saved().activeSpaceId, work);
  assert.equal(saved().sidebarVisible, false);
  assert.equal(saved().spaces.find((s) => s.id === work)?.activeTabId, b);
  assert.equal(saved().spaces.find((s) => s.id === home)?.activeTabId, a);
  // A window opened now starts as the one in front is.
  assert.equal(store.createView().sidebarVisible, false);
});

test('a closed window lets go of its tabs, and a deleted Space sends its windows to the first one', () => {
  const { store, first, second, shown } = setup();
  const home = first.activeSpaceId;
  const a = store.addTab(first, 'https://a.example/').id;
  const work = store.newSpace(second).id;
  store.deleteSpace(work);
  assert.equal(second.activeSpaceId, home);
  assert.equal(shown(first), a);
  store.detachView(first);
  assert.equal(store.shownElsewhere(a, second), undefined);
  store.activate(second, a);
  assert.equal(shown(second), a);
});
