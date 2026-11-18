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
  const unrelated = store.addTab('https://example.com/active', { windowId: first });
  const elsewhere = store.addTab('https://example.com/elsewhere', { windowId: second });
  store.splitWith(left.id, 'left', first, right.id);
  assert.deepEqual(store.activeSpaceIn(first).split, [left.id, right.id]);
  store.splitWith(unrelated.id, 'right', first, elsewhere.id);
  assert.deepEqual(store.activeSpaceIn(first).split, [left.id, right.id]);
  assert.equal(store.activeSpaceIn(second).split, undefined);
});

test('a folded Pinned section is shared by its Space and survives a save', () => {
  const { store, first, second, personal, work } = twoWindows();
  store.updateSpace(personal, { pinnedCollapsed: true });
  assert.equal(store.windowView(first).spaces.find((space) => space.id === personal).pinnedCollapsed, true);
  assert.equal(store.windowView(second).spaces.find((space) => space.id === personal).pinnedCollapsed, true);
  const saved = decodeState(store.serialize());
  const restored = new Store({ load: () => saved, save: () => {} });
  assert.equal(restored.windowView(first).spaces.find((space) => space.id === personal).pinnedCollapsed, true);
  assert.equal(restored.windowView(first).spaces.find((space) => space.id === work).pinnedCollapsed, undefined);
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

test('taking a pinned target from a responsive split disposes of its phone mirror', () => {
  const { store, first, second } = twoWindows();
  const pinned = store.addTab('https://example.com/pin', { windowId: second });
  store.togglePin(pinned.id, second);
  const mirror = store.openResponsive(second);
  store.togglePin(mirror, second);
  store.toggleFavorite(mirror, second);
  assert.deepEqual(store.activeSpaceIn(second).today, [mirror]);
  assert.equal(store.locate(mirror).zone, 'today');
  assert.equal(store.placeTab(mirror, { zone: 'favorites' }, second), false);
  store.activate(mirror, { windowId: second });
  const source = store.addTab('https://example.com/source', { windowId: first });

  store.splitWith(source.id, 'right', first, pinned.id);

  assert.deepEqual(store.activeSpaceIn(first).split, [pinned.id, source.id]);
  const displaced = store.activeSpaceIn(second);
  assert.equal(displaced.split, undefined);
  assert.equal(displaced.splitMode, undefined);
  assert.equal(displaced.activeTabId, undefined);
  assert.deepEqual(displaced.today, []);
  assert.equal(store.state.tabs[mirror], undefined);
  assert.deepEqual(store.state.archive, []);
});

test('a stale sidebar destination leaves the dragged tab in its original Space', () => {
  const { store, first, personal, work } = twoWindows();
  const source = store.addTab('https://example.com/source', { windowId: first });
  store.switchSpace(work, first);
  store.moveTab(source.id, { zone: 'pinned', spaceId: personal }, first);
  store.moveTab(source.id, { zone: 'today', spaceId: work, beforeTabId: 'gone' }, first);
  assert.deepEqual(store.activeSpaceIn(first).today, []);
  assert.equal(store.locate(source.id).space.id, personal);
});

test('closing a responsive source selects the next Today tab, and reopening a window omits phone mirrors', () => {
  const { store, second } = twoWindows();
  const desktop = store.addTab('https://example.com/desktop', { windowId: second });
  const alternate = store.addTab('https://example.com/alternate', { windowId: second, activate: false });
  const mirror = store.openResponsive(second);
  store.closeTab(desktop.id);
  assert.equal(store.activeTabIn(second)?.id, alternate.id);
  assert.equal(store.state.tabs[mirror], undefined);
  const nextMirror = store.openResponsive(second);
  const newer = store.addTab('https://example.com/newer', { windowId: second, activate: false });
  store.state.tabs[alternate.id].lastActive = 1;
  store.activate(nextMirror, { windowId: second });
  store.closeWindow(second);
  assert.equal(store.state.tabs[nextMirror], undefined);
  assert.equal(store.reopenWindow().id, second);
  assert.deepEqual(new Set(store.activeSpaceIn(second).today), new Set([alternate.id, newer.id]));
  assert.equal(store.activeTabIn(second)?.id, alternate.id);
});

test('loading older state preserves saved links and an unpaired tab in a closed window', () => {
  const { store, first, second, personal } = twoWindows();
  const olderWindowTab = store.addTab('https://example.com/restorable', { windowId: second });
  store.closeWindow(second);
  const pinned = store.addTab('https://example.com/pinned', { windowId: first });
  const favorite = store.addTab('https://example.com/favorite', { windowId: first });
  store.togglePin(pinned.id, first);
  store.toggleFavorite(favorite.id, first);
  const legacy = JSON.parse(store.serialize());
  legacy.tabs[pinned.id].device = 'mobile';
  legacy.tabs[favorite.id].device = 'mobile';
  legacy.tabs.phone = { ...legacy.tabs[pinned.id], id: 'phone' };
  const realWindowClosedAt = legacy.closedWindows[0].closedAt;
  legacy.closedWindows.unshift({ id: 'only-phone', activeSpaceId: personal, closedAt: realWindowClosedAt + 1,
    spaces: { [personal]: { today: ['phone'], activeTabId: 'phone' } } });
  const restored = new Store({ load: () => legacy, save: () => {} });
  assert.equal(restored.state.tabs.phone.device, undefined);
  assert.equal(restored.reopenWindow().id, 'only-phone');
  assert.equal(restored.activeTab?.id, 'phone');
  assert.equal(restored.lastClosedWindowAt(), realWindowClosedAt);
  assert.equal(restored.reopenWindow().id, second);
  assert.equal(restored.activeTabIn(second)?.id, olderWindowTab.id);
  assert.equal(restored.state.tabs[pinned.id].url, pinned.url);
  assert.equal(restored.state.tabs[favorite.id].url, favorite.url);
  restored.togglePin(pinned.id, first);
  restored.toggleFavorite(favorite.id, first);
  assert.equal(restored.locate(pinned.id).zone, 'today');
  assert.equal(restored.locate(favorite.id).zone, 'today');
});

test('loading a legacy closed responsive split drops its phone and keeps its desktop selected', () => {
  const { store, second, personal } = twoWindows();
  const desktop = store.addTab('https://example.com/desktop', { windowId: second });
  const phone = store.openResponsive(second);
  store.activate(phone, { windowId: second });
  const legacy = JSON.parse(store.serialize());
  const window = legacy.windows.splice(legacy.windows.findIndex((window) => window.id === second), 1)[0];
  legacy.closedWindows.push({ ...window, closedAt: Date.now() });
  const restored = new Store({ load: () => decodeState(JSON.stringify(legacy)), save: () => {} });
  assert.equal(restored.reopenWindow().id, second);
  assert.equal(restored.activeSpaceIn(second).id, personal);
  assert.equal(restored.activeSpaceIn(second).split, undefined);
  assert.equal(restored.activeTabIn(second)?.id, desktop.id);
  assert.equal(restored.state.tabs[phone], undefined);
});

test('undo restores a phone mirror only with its responsive pair', () => {
  const { store, first } = twoWindows();
  const desktop = store.addTab('https://example.com/desktop', { windowId: first });
  const mirror = store.openResponsive(first);
  store.removeTabs([desktop.id]);
  store.undo();
  assert.deepEqual(store.activeSpaceIn(first).split, [desktop.id, mirror]);
  store.removeTabs([desktop.id]);
  const left = store.addTab('https://example.com/left', { windowId: first });
  const right = store.addTab('https://example.com/right', { windowId: first });
  store.splitWith(right.id, 'right', first, left.id);
  store.undo();
  assert.deepEqual(store.activeSpaceIn(first).split, [left.id, right.id]);
  assert.ok(store.state.tabs[desktop.id]);
  assert.equal(store.state.tabs[mirror], undefined);
  assert.equal(store.activeSpaceIn(first).today.includes(mirror), false);
});

test('undoing a responsive desktop deletion restores selection in a closed window', () => {
  const { store, second, work } = twoWindows();
  store.switchSpace(work, second);
  store.addTab('https://example.com/other-space', { windowId: second });
  store.switchSpace(store.state.spaces[0].id, second);
  const desktop = store.addTab('https://example.com/desktop', { windowId: second });
  const phone = store.openResponsive(second);
  store.activate(phone, { windowId: second });
  store.removeTabs([desktop.id]);
  store.closeWindow(second);
  store.undo();
  assert.equal(store.reopenWindow().id, second);
  assert.equal(store.activeTabIn(second)?.id, desktop.id);
  assert.equal(store.state.tabs[phone], undefined);
});

test('loading responsive metadata checks the panes against the window’s Space', () => {
  const { store, first, personal, work } = twoWindows();
  const left = store.addTab('https://example.com/left', { windowId: first });
  const right = store.addTab('https://example.com/right', { windowId: first });
  store.switchSpace(work, first);
  const elsewhere = store.addTab('https://example.com/elsewhere', { windowId: first });
  store.togglePin(elsewhere.id, first);
  store.switchSpace(personal, first);
  store.splitWith(right.id, 'right', first, left.id);
  const snapshot = JSON.parse(store.serialize());
  const win = snapshot.windows.find((window) => window.id === first);
  const ws = win.spaces[personal];
  ws.splitMode = 'responsive';
  const load = () => new Store({ load: () => decodeState(JSON.stringify(snapshot)), save: () => {} });
  const ordinary = load();
  assert.equal(ordinary.activeSpaceIn(first).splitMode, undefined);
  assert.deepEqual(ordinary.activeSpaceIn(first).split, [left.id, right.id]);
  snapshot.tabs[right.id].device = 'mobile';
  ws.split = [elsewhere.id, right.id];
  ws.activeTabId = right.id;
  const unrelated = load();
  assert.equal(unrelated.activeSpaceIn(first).split, undefined);
  assert.equal(unrelated.activeTabIn(first), undefined);
  assert.equal(unrelated.state.tabs[right.id], undefined);
  assert.equal(unrelated.state.tabs[elsewhere.id].url, elsewhere.url);
  ws.activeTabId = elsewhere.id;
  assert.equal(load().activeTabIn(first), undefined);
});

test('loading a moved legacy phone tab preserves its history and its destination', () => {
  const { store, first, personal, work } = twoWindows();
  const desktop = store.addTab('https://example.com/desktop', { windowId: first });
  const phone = store.openResponsive(first);
  const snapshot = JSON.parse(store.serialize());
  const win = snapshot.windows.find((window) => window.id === first);
  win.spaces[personal] = { today: [desktop.id], activeTabId: desktop.id };
  win.spaces[work] = { today: [phone], activeTabId: phone };
  win.activeSpaceId = work;
  const history = { index: 0, entries: [{ url: 'https://example.com/visited', title: 'Visited' }] };
  snapshot.tabs[phone].history = history;
  const loaded = new Store({ load: () => decodeState(JSON.stringify(snapshot)), save: () => {} });
  assert.equal(loaded.activeTabIn(first)?.id, phone);
  assert.equal(loaded.state.tabs[phone].device, undefined);
  assert.deepEqual(loaded.state.tabs[phone].history, history);
});

test('the saved-state decoder drops a responsive mirror whose source no longer exists', () => {
  const { store, first, second, personal, work } = twoWindows();
  const desktop = store.addTab('https://example.com/desktop', { windowId: first });
  const phone = store.openResponsive(first);
  store.activate(phone, { windowId: first });
  const survivor = store.addTab('https://example.com/survivor', { windowId: second });
  const snapshot = JSON.parse(store.serialize());
  snapshot.windows = [second, first].map((id) => snapshot.windows.find((win) => win.id === id));
  snapshot.windows[0].spaces[work] = { today: [survivor.id], activeTabId: phone, split: [phone, survivor.id] };
  const withDesktop = decodeState(JSON.stringify(snapshot)).windows[0].spaces[work];
  assert.equal(withDesktop.activeTabId, phone);
  assert.deepEqual(withDesktop.split, [phone, survivor.id]);
  delete snapshot.tabs[desktop.id];
  const loaded = decodeState(JSON.stringify(snapshot));
  const space = loaded.windows.find((win) => win.id === first).spaces[personal];
  assert.equal(loaded.tabs[phone], undefined);
  assert.equal(space.activeTabId, undefined);
  assert.equal(space.split, undefined);
  assert.deepEqual(space.today, []);
  const otherSpace = loaded.windows.find((win) => win.id === second).spaces[work];
  assert.equal(otherSpace.activeTabId, undefined);
  assert.equal(otherSpace.split, undefined);
});

test('a hidden Space does not protect the unselected half of a split from auto-archive', () => {
  const { store, first, personal, work } = twoWindows();
  const left = store.addTab('https://example.com/left', { windowId: first });
  const right = store.addTab('https://example.com/right', { windowId: first });
  store.splitWith(right.id, 'right', first, left.id);
  store.activate(left.id, { windowId: first });
  store.switchSpace(work, first);
  right.lastActive = 1;
  assert.deepEqual(store.archiveStale(), [right.id]);
  assert.equal(store.state.archive[0].url, right.url);
  assert.equal(store.windowView(first).spaces.find((space) => space.id === personal).split, undefined);
});

test('auto-archive keeps both visible panes when the phone is selected', () => {
  const { store, first } = twoWindows();
  const desktop = store.addTab('https://example.com/desktop', { windowId: first });
  const other = store.addTab('https://example.com/old', { windowId: first, activate: false });
  const phone = store.openResponsive(first);
  store.activate(phone, { windowId: first });
  desktop.lastActive = other.lastActive = 1;
  assert.deepEqual(store.archiveStale(), [other.id]);
  assert.deepEqual(store.activeSpaceIn(first).split, [desktop.id, phone]);
  assert.equal(store.activeTabIn(first)?.id, phone);
});

test('archiving a hidden responsive split removes its selected mirror without archiving it', () => {
  const { store, first, personal, work } = twoWindows();
  const desktop = store.addTab('https://example.com/desktop', { windowId: first });
  const phone = store.openResponsive(first);
  store.activate(phone, { windowId: first });
  store.switchSpace(work, first);
  desktop.lastActive = 1;
  assert.deepEqual(store.archiveStale(), [desktop.id, phone]);
  assert.deepEqual(store.state.archive.map((entry) => entry.url), [desktop.url]);
  store.switchSpace(personal, first);
  assert.equal(store.activeTabIn(first), undefined);
  assert.equal(store.activeSpaceIn(first).split, undefined);
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
