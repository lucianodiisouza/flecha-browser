// Each window has its own active Space and Today tabs; Spaces, pinned tabs and favorites are shared.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

const { Store } = await loadModule('chromium/shared/store.ts');
const { decodeState, STATE_VERSION } = await loadModule('chromium/shared/savedState.ts');

function twoWindows() {
  const store = new Store({ load: () => undefined, save: () => {} });
  const work = store.newSpace(false);
  const first = store.focusedWindowId;
  const second = store.openWindow().id;
  return { store, first, second, personal: store.state.spaces[0].id, work: work.id };
}

test('a targeted split uses the chosen row even when another tab is active', () => {
  const { store, first, second } = twoWindows();
  const left = store.addTab('https://example.com/left', { windowId: first });
  const right = store.addTab('https://example.com/right', { windowId: first });
  store.addTab('https://example.com/active', { windowId: first });
  const elsewhere = store.addTab('https://example.com/elsewhere', { windowId: second });
  store.splitWith(left.id, 'left', first, right.id);
  assert.deepEqual(store.activeSpaceIn(first).split, [left.id, right.id]);
  store.splitWith(left.id, 'right', first, elsewhere.id);
  assert.deepEqual(store.activeSpaceIn(first).split, [left.id, right.id]);
  assert.equal(store.activeSpaceIn(second).split, undefined);
});

test('a folded Pinned section is shared by its Space and survives a save', () => {
  const { store, first, second, personal, work } = twoWindows();
  store.updateSpace(personal, { pinnedCollapsed: true });
  assert.equal(store.windowView(first).spaces.find((space) => space.id === personal).pinnedCollapsed, true);
  assert.equal(store.windowView(second).spaces.find((space) => space.id === personal).pinnedCollapsed, true);
  const saved = decodeState(store.serialize());
  assert.equal(saved.spaces.find((space) => space.id === personal).pinnedCollapsed, true);
  assert.equal(saved.spaces.find((space) => space.id === work).pinnedCollapsed, undefined);
});

test('a version 1 state becomes one window with each Space\'s Today tabs and selection', () => {
  const v1 = {
    version: 1,
    spaces: [
      { id: 'a', name: 'A', color: '#fff', pinned: [{ kind: 'tab', tabId: 'p' }], today: ['t1', 't2'], activeTabId: 't2', split: ['t1', 't2'], splitRatio: 0.3 },
      { id: 'b', name: 'B', color: '#fff', pinned: [], today: ['t3'], activeTabId: 'p' },
    ],
    activeSpaceId: 'b',
    favorites: [],
    tabs: Object.fromEntries(['p', 't1', 't2', 't3'].map((id) => [id, { url: `https://example.com/${id}`, title: id, lastActive: 1 }])),
    archive: [],
    sidebarVisible: true,
  };
  const state = decodeState(JSON.stringify(v1));
  assert.equal(state.windows.length, 1);
  assert.deepEqual(state.closedWindows, []);
  const [win] = state.windows;
  assert.equal(win.activeSpaceId, 'b');
  assert.deepEqual(win.spaces.a, { today: ['t1', 't2'], activeTabId: 't2', split: ['t1', 't2'], splitRatio: 0.3 });
  assert.deepEqual(win.spaces.b, { today: ['t3'], activeTabId: 'p' });
  assert.deepEqual(state.spaces.map((s) => Object.keys(s).sort()), [['color', 'id', 'name', 'pinned'], ['color', 'id', 'name', 'pinned']]);
  let json;
  const store = new Store({ load: () => state, save: (j) => (json = j) });
  assert.equal(store.activeTab.id, 'p');
  store.saveNow();
  assert.equal(JSON.parse(json).version, STATE_VERSION);
  assert.equal(STATE_VERSION, 2);
  assert.deepEqual(decodeState(json).windows, store.state.windows);
});

test('Today tabs belong to their window; pinned tabs and favorites to every window', () => {
  const { store, first, second } = twoWindows();
  const here = store.addTab('https://example.com/here', { windowId: first });
  const there = store.addTab('https://example.com/there', { windowId: second });
  store.togglePin(store.addTab('https://example.com/pin', { windowId: first }).id);
  const pinned = store.state.spaces[0].pinned[0].tabId;
  const space = store.state.spaces[0];
  assert.deepEqual(store.allTabIds(space, first), [pinned, here.id]);
  assert.deepEqual(store.allTabIds(space, second), [pinned, there.id]);
  assert.deepEqual(store.locate(there.id), { space, zone: 'today', windowId: second });
});

test('each window has its own active Space', () => {
  const { store, first, second, personal, work } = twoWindows();
  store.switchSpace(work, second);
  assert.equal(store.activeSpaceIn(first).id, personal);
  assert.equal(store.activeSpaceIn(second).id, work);
  assert.deepEqual(store.windowView(second).spaces.map((s) => s.today), [[], []]);
});

test('a pinned tab shows in one window at a time; a Today tab only in its own', () => {
  const { store, first, second } = twoWindows();
  const tab = store.addTab('https://example.com/pin', { windowId: first });
  store.togglePin(tab.id);
  store.activate(tab.id, { windowId: first });
  assert.equal(store.activeTabIn(first)?.id, tab.id);
  assert.equal(store.activate(tab.id, { windowId: second }), second);
  assert.equal(store.activeTabIn(second)?.id, tab.id);
  assert.equal(store.activeTabIn(first), undefined);
  assert.equal(store.windowShowing(tab.id), second);
  const local = store.addTab('https://example.com/local', { windowId: first, activate: false });
  assert.equal(store.activate(local.id, { windowId: second }), first);
  assert.equal(store.activeTabIn(first)?.id, local.id);
  assert.equal(store.activeTabIn(second)?.id, tab.id);
});

test('a closed window keeps its Today tabs to reopen; the last window stays open', () => {
  const { store, first, second, work } = twoWindows();
  store.switchSpace(work, second);
  const tab = store.addTab('https://example.com/kept', { windowId: second });
  store.focusWindow(second);
  assert.equal(store.focusedWindowId, second);
  assert.deepEqual(store.closeWindow(second), []);
  assert.deepEqual(store.state.windows.map((w) => w.id), [first]);
  assert.equal(store.focusedWindowId, first);
  assert.ok(store.state.tabs[tab.id]);
  assert.ok(store.lastClosedWindowAt() > 0);
  assert.deepEqual(store.closeWindow(first), []);
  assert.deepEqual(store.state.windows.map((w) => w.id), [first]);
  const reopened = store.reopenWindow();
  assert.equal(reopened.id, second);
  assert.equal(store.focusedWindowId, second);
  assert.equal(store.activeSpaceIn(second).id, work);
  assert.equal(store.activeTabIn(second)?.id, tab.id);
  assert.equal(store.lastClosedWindowAt(), undefined);
});

test('a closed window\'s Today tabs are not among the tabs to switch to until it reopens', () => {
  const { store, first, second } = twoWindows();
  const here = store.addTab('https://example.com/here', { windowId: first });
  const pinned = store.addTab('https://example.com/pin', { windowId: second });
  store.togglePin(pinned.id);
  const gone = store.addTab('https://example.com/gone', { windowId: second });
  store.closeWindow(second);
  assert.ok(store.state.tabs[gone.id]);
  assert.deepEqual(Object.keys(store.openTabs()).sort(), [here.id, pinned.id].sort());
  // Every tab offered can be switched to; the closed window's can't.
  for (const id of Object.keys(store.openTabs())) assert.equal(store.activate(id, { windowId: first }), first);
  assert.equal(store.activate(gone.id, { windowId: first }), undefined);
  store.reopenWindow();
  assert.ok(store.openTabs()[gone.id]);
  assert.equal(store.activate(gone.id), second);
});

test('open tabs include nested pins and favorites, omit unplaced tabs, and keep saved order', () => {
  const { store, first, second } = twoWindows();
  const favorite = store.addTab('https://example.com/favorite', { windowId: first });
  const nested = store.addTab('https://example.com/nested', { windowId: first });
  const today = store.addTab('https://example.com/today', { windowId: second });
  const closed = store.addTab('https://example.com/closed', { windowId: second });
  store.closeWindow(second);
  const personal = store.state.spaces[0];
  store.state.favorites = [favorite.id];
  personal.pinned = [{ kind: 'folder', id: 'outer', name: 'Outer', children: [
    { kind: 'folder', id: 'inner', name: 'Inner', children: [{ kind: 'tab', tabId: nested.id }] },
  ] }];
  // The loaded state can contain an unplaced tab. Only list membership makes it open.
  store.state.windows.find(w => w.id === first).spaces[personal.id].today = [today.id];
  const orphan = { ...closed, id: 'orphan', url: 'https://example.com/orphan' };
  store.state.tabs[orphan.id] = orphan;
  const open = store.openTabs();
  assert.deepEqual(Object.keys(open), [favorite.id, nested.id, today.id]);
  assert.equal(open[nested.id], store.state.tabs[nested.id]);
  assert.equal(open[closed.id], undefined);
  assert.equal(open[orphan.id], undefined);
});

test('a reopened window shows a Today tab of its own when the tab it showed was shared', () => {
  const { store, first, second } = twoWindows();
  const older = store.addTab('https://example.com/older', { windowId: second });
  const newer = store.addTab('https://example.com/newer', { windowId: second });
  store.state.tabs[older.id].lastActive = 1;
  const pinned = store.addTab('https://example.com/pin', { windowId: first });
  store.togglePin(pinned.id);
  store.activate(pinned.id, { windowId: second });
  store.closeWindow(second);
  assert.equal(store.reopenWindow().spaces[store.activeSpaceIn(second).id].activeTabId, newer.id);
});

test('closed windows are kept as long as Chromium keeps closed tabs; older ones are archived', () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  const tabs = [];
  for (let i = 0; i < 27; i++) {
    const win = store.openWindow().id;
    tabs.push(store.addTab(`https://example.com/${i}`, { windowId: win }).id);
    store.closeWindow(win);
  }
  assert.equal(store.state.closedWindows.length, 25);
  assert.equal(store.state.tabs[tabs[0]], undefined);
  assert.equal(store.state.tabs[tabs[1]], undefined);
  assert.ok(store.state.tabs[tabs[2]]);
  assert.equal(store.state.archive[0].url, 'https://example.com/1');
});

test('deleting a Space removes its Today tabs from every window', () => {
  const { store, first, second, personal, work } = twoWindows();
  store.switchSpace(work, first);
  store.switchSpace(work, second);
  const a = store.addTab('https://example.com/a', { windowId: first });
  const b = store.addTab('https://example.com/b', { windowId: second });
  assert.deepEqual(store.deleteSpace(work).sort(), [a.id, b.id].sort());
  assert.equal(store.activeSpaceIn(first).id, personal);
  assert.equal(store.activeSpaceIn(second).id, personal);
  assert.equal(store.state.windows.some((w) => w.spaces[work]), false);
});

test('deleting a Space archives its pinned and Today tabs', () => {
  const { store, first, second, work } = twoWindows();
  store.switchSpace(work, first);
  store.switchSpace(work, second);
  const pinned = store.addTab('https://example.com/pinned', { windowId: first });
  store.togglePin(pinned.id, first);
  store.addTab('https://example.com/a', { windowId: first });
  store.addTab('https://example.com/b', { windowId: second });
  store.deleteSpace(work);
  assert.deepEqual(store.state.archive.map((a) => a.url).sort(), ['https://example.com/a', 'https://example.com/b', 'https://example.com/pinned']);
});

test('a window without a choice of its own acts as the focused window', () => {
  const { store, first, second } = twoWindows();
  store.focusWindow(second);
  const tab = store.addTab('https://example.com/focused');
  assert.equal(store.locate(tab.id).windowId, second);
  assert.equal(store.activeTab.id, tab.id);
  assert.equal(store.activeTabIn(first), undefined);
});

test('stale Today tabs are archived in every window', () => {
  const { store, first, second } = twoWindows();
  const old = store.addTab('https://example.com/old', { windowId: second, activate: false });
  store.addTab('https://example.com/new', { windowId: first });
  store.state.tabs[old.id].lastActive = 0;
  assert.deepEqual(store.archiveStale(), [old.id]);
});

test('a split with a pinned tab shown in another window takes it from there', () => {
  const { store, first, second } = twoWindows();
  const pinned = store.addTab('https://example.com/pin', { windowId: first });
  store.togglePin(pinned.id);
  store.activate(pinned.id, { windowId: second });
  store.splitWith(store.addTab('https://example.com/other', { windowId: second, activate: false }).id, 'right', second);
  assert.ok(store.activeSpaceIn(second).split.includes(pinned.id));
  store.addTab('https://example.com/here', { windowId: first });
  store.splitWith(pinned.id, 'right', first);
  assert.ok(store.activeSpaceIn(first).split.includes(pinned.id));
  assert.equal(store.windowShowing(pinned.id), first);
  assert.equal(store.activeSpaceIn(second).split, undefined);
  assert.notEqual(store.activeSpaceIn(second).activeTabId, pinned.id);
});

test('each window hides or shows its own sidebar; new windows start as the last choice', () => {
  const { store, first, second } = twoWindows();
  store.setSidebarVisible(false, first);
  assert.equal(store.sidebarVisibleIn(first), false);
  assert.equal(store.sidebarVisibleIn(second), true);
  assert.equal(store.sidebarVisibleIn(store.openWindow().id), false);
  const saved = JSON.parse(JSON.stringify({ version: 2, ...store.state }));
  assert.equal(decodeState(JSON.stringify(saved)).windows.find((w) => w.id === first).sidebarVisible, false);
});
