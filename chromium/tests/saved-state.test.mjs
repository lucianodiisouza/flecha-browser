// A damaged saved state must not keep the shell from starting, and must not be lost.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

const { loadSavedState, decodeState, STATE_VERSION, STATE_KEY, LAST_GOOD_KEY, DAMAGED_KEY } = await loadModule('chromium/shared/savedState.ts');
const { Store } = await loadModule('chromium/shared/store.ts');

/** A window's Today tabs and selection in a Space, in a saved (version 2) state. */
const inWindow = (state, spaceIndex = 0, windowIndex = 0) => state.windows[windowIndex].spaces[state.spaces[spaceIndex].id];

function area(items) {
  return {
    items,
    async get(keys) { return Object.fromEntries(keys.filter((k) => k in items).map((k) => [k, items[k]])); },
    async set(patch) { Object.assign(items, patch); },
  };
}

function savedStore(name) {
  let json;
  const store = new Store({ load: () => undefined, save: (j) => { json = j; } });
  store.state.spaces[0].name = name;
  store.addTab('https://example.com/');
  store.saveNow();
  return json;
}

function recordingStore(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [];
  const store = new Store({ load: () => undefined, save: (json) => { writes.push(json); } });
  return { store, writes };
}

test('a state that reads well loads, and becomes the last good copy once the shell has started', async () => {
  const good = savedStore('Work');
  const storage = area({ [STATE_KEY]: good });
  const { state, recovered, started } = await loadSavedState(storage);
  assert.equal(recovered, undefined);
  assert.equal(state.spaces[0].name, 'Work');
  assert.equal(storage.items[LAST_GOOD_KEY], undefined);
  await started();
  assert.deepEqual(JSON.parse(storage.items[LAST_GOOD_KEY]), JSON.parse(good));
});

test('an unparseable state falls back to the last good copy and is kept aside', async () => {
  const good = savedStore('Work');
  const storage = area({ [STATE_KEY]: '{"spaces": [', [LAST_GOOD_KEY]: good });
  const { state, recovered } = await loadSavedState(storage);
  assert.equal(recovered, 'last-good');
  assert.equal(state.spaces[0].name, 'Work');
  assert.equal(storage.items[DAMAGED_KEY], '{"spaces": [');
  assert.equal(storage.items[STATE_KEY], good);
});

test('with no readable copy the shell starts fresh, keeping the damaged state', async () => {
  const storage = area({ [STATE_KEY]: '{"spaces": []}', [LAST_GOOD_KEY]: 'not json' });
  const { state, recovered } = await loadSavedState(storage);
  assert.equal(state, undefined);
  assert.equal(recovered, 'fresh');
  assert.equal(storage.items[DAMAGED_KEY], '{"spaces": []}');
  assert.ok(new Store({ load: () => state, save: () => {} }).state.spaces.length);
});

test('a first start has nothing to recover', async () => {
  const storage = area({});
  const { state, recovered, started } = await loadSavedState(storage);
  assert.equal(state, undefined);
  assert.equal(recovered, undefined);
  await started();
  assert.deepEqual(storage.items, {});
});

test('failing backup writes are logged and never keep a readable state from loading', async () => {
  const good = savedStore('Work');
  const failing = { get: area({ [STATE_KEY]: '{', [LAST_GOOD_KEY]: good }).get, set: () => Promise.reject(new Error('disk full')) };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.equal((await loadSavedState(failing)).state.spaces[0].name, 'Work');
    const fresh = await loadSavedState({ get: area({ [STATE_KEY]: good }).get, set: failing.set });
    assert.equal(fresh.state.spaces[0].name, 'Work');
    await fresh.started();
  } finally {
    console.error = original;
  }
  assert.ok(errors.length >= 3);
});

test("a coding agent's tab is still in the agent's folder after a restart", () => {
  const saved = JSON.parse(savedStore('Work'));
  const tabId = inWindow(saved).today[0];
  saved.tabs[tabId].agent = true;
  assert.equal(decodeState(JSON.stringify(saved)).tabs[tabId].agent, true);
});

test('settings of the wrong type are dropped instead of breaking startup', () => {
  const saved = JSON.parse(savedStore('Work'));
  Object.assign(saved, { keybindings: { newTab: 42, closeTab: null, reload: 'CmdOrCtrl+R' }, theme: 'neon', archiveAfterHours: -1, searchEngine: 'kagi', window: { x: 1, y: 2, width: 'wide', height: 4 } });
  const tabId = inWindow(saved).today[0];
  Object.assign(saved.tabs[tabId], { title: 7, history: { index: 0, entries: 'none' }, muted: true });
  Object.assign(saved.spaces[0], { isolated: 'yes' });
  Object.assign(inWindow(saved), { splitRatio: 3 });
  const state = decodeState(JSON.stringify(saved));
  assert.deepEqual(state.keybindings, undefined);
  assert.equal(state.theme, undefined);
  assert.equal(state.archiveAfterHours, undefined);
  assert.equal(state.searchEngine, 'kagi');
  assert.equal(state.window, undefined);
  assert.equal(state.tabs[tabId].title, 'https://example.com/');
  assert.equal(state.tabs[tabId].history, undefined);
  assert.equal(state.tabs[tabId].muted, true);
  assert.equal(inWindow(state).splitRatio, undefined);
  assert.equal(state.spaces[0].isolated, undefined);
  const valid = JSON.parse(savedStore('Work'));
  valid.keybindings = { closeTab: null, reload: 'CmdOrCtrl+R' };
  assert.deepEqual(decodeState(JSON.stringify(valid)).keybindings, valid.keybindings);
});

test('only the fields the shell knows are kept, however deep the others go', () => {
  const saved = JSON.parse(savedStore('Work'));
  const tabId = inWindow(saved).today[0];
  const deep = '['.repeat(20000) + ']'.repeat(20000);
  saved.tabs[tabId].extra = 1;
  saved.spaces[0].extra = 2;
  saved.archive = [{ url: 'https://example.org/', title: 'Old', closedAt: 1, extra: 3 }];
  const json = JSON.stringify(saved).replace(/}$/, `,"unexpected":${deep}}`);
  const state = decodeState(json);
  assert.equal(state.spaces[0].name, 'Work');
  assert.equal('unexpected' in state, false);
  assert.equal('extra' in state.tabs[tabId], false);
  assert.equal('extra' in state.spaces[0], false);
  assert.deepEqual(state.archive, [{ url: 'https://example.org/', title: 'Old', closedAt: 1 }]);
  structuredClone(state);
});

test('inherited property names are not tabs', () => {
  const state = decodeState('{"spaces":[{"id":"s","today":["constructor","toString"],"pinned":[{"kind":"tab","tabId":"__proto__"}]}],"favorites":["hasOwnProperty"],"tabs":{"__proto__":{"url":"https://example.com/"}}}');
  assert.deepEqual(inWindow(state).today, []);
  assert.deepEqual(state.favorites, []);
  assert.deepEqual(state.spaces[0].pinned, [{ kind: 'tab', tabId: '__proto__' }]);
  assert.equal(Object.getPrototypeOf(state.tabs), Object.prototype);
  assert.equal(Object.hasOwn(state.tabs, '__proto__'), true);
});

test('a state nested deeper than repair can go recovers from the last good copy', async () => {
  // Written out by hand: JSON.stringify can't go this deep either.
  const depth = 20000;
  const pinned = '[' + '{"kind":"folder","id":"f","name":"F","children":['.repeat(depth) + ']}]'.repeat(depth) + ']';
  const deep = `{"spaces":[{"id":"s","name":"Deep","color":"#fff","today":[],"pinned":${pinned}}],"tabs":{}}`;
  const good = savedStore('Work');
  const storage = area({ [STATE_KEY]: deep, [LAST_GOOD_KEY]: good });
  const { state, recovered } = await loadSavedState(storage);
  assert.equal(recovered, 'last-good');
  assert.equal(state.spaces[0].name, 'Work');
  assert.equal(storage.items[DAMAGED_KEY], deep);
});

test('saves carry the schema version; unversioned states still load', () => {
  assert.equal(JSON.parse(savedStore('Work')).version, STATE_VERSION);
  const legacy = JSON.parse(savedStore('Old'));
  delete legacy.version;
  const state = decodeState(JSON.stringify(legacy));
  assert.equal(state.spaces[0].name, 'Old');
  assert.equal('version' in state, false);
});

test('references to missing tabs and Spaces are repaired, not fatal', () => {
  const state = decodeState(JSON.stringify({
    spaces: [
      { id: 's1', name: 'One', color: '#fff', activeTabId: 'gone', split: ['t1', 'gone'], today: ['t1', 'gone', 7, 't2'], pinned: [{ kind: 'tab', tabId: 'gone' }, { kind: 'folder', id: 'f', name: 'F', children: [{ kind: 'tab', tabId: 't1' }, null] }, 'junk'] },
      'not a space',
    ],
    activeSpaceId: 'missing',
    favorites: ['gone'],
    tabs: { t1: { url: 'https://example.com/', title: 'Example' }, t2: { url: 'https://example.org/' }, broken: { title: 'no url' } },
  }));
  assert.equal(state.windows[0].activeSpaceId, 's1');
  assert.deepEqual(Object.keys(state.tabs), ['t1', 't2']);
  assert.equal(state.tabs.t1.id, 't1');
  assert.deepEqual(state.favorites, []);
  assert.deepEqual(state.archive, []);
  const [space] = state.spaces;
  assert.deepEqual(inWindow(state).today, ['t2']);
  assert.equal(inWindow(state).activeTabId, undefined);
  assert.equal(inWindow(state).split, undefined);
  assert.deepEqual(space.pinned, [{ kind: 'folder', id: 'f', name: 'F', open: false, children: [{ kind: 'tab', tabId: 't1' }] }]);
  const store = new Store({ load: () => state, save: () => {} });
  assert.deepEqual(store.allTabIds(store.activeSpace), ['t1', 't2']);
});

test('shapes the shell cannot start from are rejected', () => {
  for (const json of [undefined, 42, '', 'null', '[]', '{}', '{"spaces":[],"tabs":{}}', '{"spaces":[{"name":"no id"}],"tabs":{}}', '{"spaces":[{"id":"s"}]}']) {
    assert.equal(decodeState(json), undefined, String(json));
  }
});

test('the sidebar width is kept within Chromium\'s vertical tab strip limits, and saved', async () => {
  let json;
  const store = new Store({ load: () => undefined, save: (j) => { json = j; } });
  await store.setSidebarWidth(90);
  assert.equal(store.state.sidebarWidth, 126);
  await store.setSidebarWidth(1000);
  assert.equal(store.state.sidebarWidth, 400);
  await store.setSidebarWidth(300.4);
  assert.equal(decodeState(json).sidebarWidth, 300);
  const saved = JSON.parse(json);
  for (const width of [125, 401, '300']) assert.equal(decodeState(JSON.stringify({ ...saved, sidebarWidth: width })).sidebarWidth, undefined);
});

test('live tab status still notifies listeners without rewriting unchanged saved state', (t) => {
  const { store, writes } = recordingStore(t);
  const tab = store.addTab('https://example.com/');
  store.saveNow();
  const saved = writes.pop();
  const changes = [];
  store.onChange((change) => changes.push(change));

  store.updateTab(tab.id, { title: tab.title, loading: true, audible: true });
  t.mock.timers.runAll();

  assert.equal(tab.loading, true);
  assert.equal(tab.audible, true);
  assert.deepEqual(changes, ['tab']);
  assert.equal(store.serialize(), saved);
  assert.deepEqual(writes, []);
});

test('a persisted tab change is saved even when accompanied by live status', (t) => {
  const { store, writes } = recordingStore(t);
  const tab = store.addTab('https://example.com/');
  store.saveNow();
  writes.length = 0;

  store.updateTab(tab.id, { title: 'Updated', loading: true, audible: true });
  t.mock.timers.runAll();

  assert.equal(writes.length, 1);
  const savedTab = JSON.parse(writes[0]).tabs[tab.id];
  assert.equal(savedTab.title, 'Updated');
  assert.equal('loading' in savedTab, false);
  assert.equal('audible' in savedTab, false);
});

test('live tab updates do not postpone an already-pending persistent save', (t) => {
  const { store, writes } = recordingStore(t);
  const tab = store.addTab('https://example.com/');
  // The existing save debounce is 500 ms. Update live status halfway through it.
  t.mock.timers.tick(250);
  store.updateTab(tab.id, { loading: true });
  t.mock.timers.tick(250);

  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0]).tabs[tab.id].url, 'https://example.com/');
  t.mock.timers.runAll();
  assert.equal(writes.length, 1);
});

test('a split repair during a live tab update is still persisted', (t) => {
  const { store, writes } = recordingStore(t);
  const tab = store.addTab('https://example.com/');
  store.saveNow();
  writes.length = 0;
  const windowSpace = inWindow(store.state);
  windowSpace.split = [tab.id, 'missing'];

  store.updateTab(tab.id, { loading: true });
  t.mock.timers.runAll();

  assert.equal(windowSpace.split, undefined);
  assert.equal(writes.length, 1);
  assert.equal(inWindow(JSON.parse(writes[0])).split, undefined);
});
