// Imported Spaces: a fresh install's empty Space gives way, Merge joins Spaces by name without
// repeating tabs, Append adds new ones, and splits, colours, isolation and the archive come over.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

const { Store, mergeArchive, pinnedTabIds } = await loadModule('chromium/shared/store.ts');

const newStore = () => new Store({ load: () => undefined, save: () => {} });
const tab = (url, title = url) => ({ kind: 'tab', url, title });
const bookmarks = [tab('https://example.com/', 'Example')];
const bookmarkSpace = (name = 'Imported') => ({ name, pinned: bookmarks, today: [] });
const urls = (store, ids) => ids.map((id) => store.state.tabs[id].url);
const spaceNamed = (store, name) => store.state.spaces.find((s) => s.name === name);

test('a fresh install’s empty Space gives way to the imported one', () => {
  const store = newStore();
  store.importSpaces([bookmarkSpace()], { mode: 'merge' });
  assert.deepEqual(store.state.spaces.map((s) => s.name), ['Imported']);
  assert.equal(store.window().activeSpaceId, store.state.spaces[0].id);
});

test('a Space is kept when a closed window holds its only tabs, so reopening that window brings them back', () => {
  const store = newStore();
  const [original] = store.state.spaces;
  const second = store.openWindow().id;
  const opened = store.addTab('https://example.org/', { windowId: second });
  store.closeWindow(second);
  store.importSpaces([bookmarkSpace()], { mode: 'merge' });
  assert.ok(store.state.spaces.some((s) => s.id === original.id));
  const reopened = store.reopenWindow();
  assert.equal(store.activeTabIn(reopened.id)?.id, opened.id);
});

test('import keeps an empty Personal Space with Pinned folded', () => {
  const store = newStore();
  const [original] = store.state.spaces;
  store.updateSpace(original.id, { pinnedCollapsed: true });
  store.importSpaces([bookmarkSpace()], { mode: 'merge' });
  assert.deepEqual(store.state.spaces.map((s) => s.id), [original.id, spaceNamed(store, 'Imported').id]);
  assert.equal(store.state.spaces[0].pinnedCollapsed, true);
});

test('a Space is kept when favorites are its only tabs', () => {
  const store = newStore();
  const [original] = store.state.spaces;
  store.toggleFavorite(store.addTab('https://example.org/').id);
  store.importSpaces([bookmarkSpace()], { mode: 'append' });
  assert.deepEqual(store.state.spaces.map((s) => s.id), [original.id, spaceNamed(store, 'Imported').id]);
});

test('new Spaces take the imported colour and emoji, or Flecha’s next ones', () => {
  const store = newStore();
  store.importSpaces([{ ...bookmarkSpace('Arc'), emoji: '🏠', color: '#336699' }, bookmarkSpace('Chrome')], { mode: 'append' });
  assert.deepEqual([spaceNamed(store, 'Arc').emoji, spaceNamed(store, 'Arc').color], ['🏠', '#336699']);
  assert.match(spaceNamed(store, 'Chrome').color, /^#[0-9a-f]{6}$/);
  assert.ok(spaceNamed(store, 'Chrome').emoji);
});

/** A Flecha with a Work Space: a pinned tab, a Dev folder with one tab, a Today tab and a favorite. */
function withWork() {
  const store = newStore();
  store.importSpaces(
    [{ name: 'Work', pinned: [tab('https://work.example.com/'), { kind: 'folder', name: 'Dev', children: [tab('https://repo.example.com/')] }], today: [tab('https://news.example.com/')] }],
    { mode: 'append', favorites: [tab('https://mail.example.com/')] },
  );
  return store;
}

const arcWork = {
  name: ' work ',
  pinned: [
    tab('https://work.example.com/'),
    { kind: 'folder', name: 'dev', children: [tab('https://repo.example.com/'), tab('https://ci.example.com/')] },
    { kind: 'folder', name: 'Old', children: [tab('https://news.example.com/')] },
    tab('https://mail.example.com/'),
    tab('https://new.example.com/'),
  ],
  today: [tab('https://news.example.com/'), tab('https://today.example.com/')],
};

test('Merge joins the Space of the same name and leaves out tabs it or the favorites already have', () => {
  const store = withWork();
  const work = spaceNamed(store, 'Work');
  const out = store.importSpaces([arcWork], { mode: 'merge', favorites: [tab('https://mail.example.com/'), tab('https://calendar.example.com/')] });
  assert.deepEqual({ spaces: out.spaces, merged: out.merged, tabs: out.tabs }, { spaces: 0, merged: 1, tabs: 4 });
  assert.deepEqual(store.state.spaces.map((s) => s.name), ['Work']);
  // The Dev folder gets the new tab; "Old" held only a tab that's already there, so it isn't added.
  assert.deepEqual(work.pinned.map((n) => (n.kind === 'tab' ? store.state.tabs[n.tabId].url : `${n.name}: ${urls(store, pinnedTabIds(n.children)).join(' ')}`)), [
    'https://work.example.com/',
    'Dev: https://repo.example.com/ https://ci.example.com/',
    'https://new.example.com/',
  ]);
  assert.deepEqual(urls(store, store.view(work).today), ['https://news.example.com/', 'https://today.example.com/']);
  assert.deepEqual(urls(store, store.state.favorites), ['https://mail.example.com/', 'https://calendar.example.com/']);
  // Importing the same again adds nothing.
  assert.equal(store.importSpaces([arcWork], { mode: 'merge' }).tabs, 0);
});

test('Append adds a new Space even when the name is taken, with every tab', () => {
  const store = withWork();
  const out = store.importSpaces([arcWork], { mode: 'append', favorites: [tab('https://mail.example.com/')] });
  assert.deepEqual({ spaces: out.spaces, merged: out.merged, tabs: out.tabs }, { spaces: 1, merged: 0, tabs: 8 });
  assert.equal(store.state.spaces.length, 2);
  // Favorites are shared, so even Append doesn't repeat one.
  assert.equal(store.state.favorites.length, 1);
});

test('a two-tab split becomes the Space’s split when both tabs exist; other splits stay as tabs side by side', () => {
  const store = newStore();
  const space = {
    name: 'Split',
    pinned: [tab('https://left.example.com/'), tab('https://right.example.com/')],
    today: ['a', 'b', 'c', 'd', 'e'].map((x) => tab(`https://${x}.example.com/`)),
    splits: [
      // One of its tabs didn't come over (an arc: page, say).
      ['https://left.example.com/', 'arc://settings'],
      ['https://left.example.com/', 'https://right.example.com/'],
      ['https://a.example.com/', 'https://b.example.com/'],
      ['https://c.example.com/', 'https://d.example.com/', 'https://e.example.com/'],
    ],
  };
  const out = store.importSpaces([space], { mode: 'append' });
  assert.deepEqual({ splits: out.splits, pairs: out.pairs }, { splits: 1, pairs: 3 });
  const view = store.view(spaceNamed(store, 'Split'));
  assert.deepEqual(urls(store, view.split), ['https://left.example.com/', 'https://right.example.com/']);
  // The tabs of a split that stays tabs keep their places, next to each other.
  assert.deepEqual(urls(store, view.today).slice(0, 2), ['https://a.example.com/', 'https://b.example.com/']);
});

test('a merged split uses the tab Flecha already had', () => {
  const store = withWork();
  const existing = store.view(spaceNamed(store, 'Work')).today[0];
  store.importSpaces([{ name: 'Work', pinned: [], today: [tab('https://news.example.com/'), tab('https://other.example.com/')], splits: [['https://news.example.com/', 'https://other.example.com/']] }], { mode: 'merge' });
  assert.equal(store.view(spaceNamed(store, 'Work')).split[0], existing);
});

test('new Spaces marked isolated get Separate Cookies and Logins; a Space merged into keeps its own', () => {
  const store = withWork();
  store.importSpaces([{ ...bookmarkSpace('Arc Work'), isolated: true }, bookmarkSpace('Arc Home'), { name: 'Work', pinned: [], today: [], isolated: true }], { mode: 'merge' });
  assert.deepEqual(store.state.spaces.map((s) => [s.name, !!s.isolated]), [['Work', false], ['Arc Work', true], ['Arc Home', false]]);
});

test('a fresh install’s Space that was renamed, recoloured or given a folder stays, and Merge joins it', () => {
  for (const change of [
    (store, id) => store.updateSpace(id, { name: 'Work' }),
    (store, id) => store.updateSpace(id, { color: '#000000' }),
    (store, id) => store.state.spaces[0].pinned.push({ kind: 'folder', id: 'f', name: 'Empty', open: false, children: [] }),
  ]) {
    const store = newStore();
    const [original] = store.state.spaces;
    change(store, original.id);
    store.importSpaces([{ ...bookmarkSpace(original.name), color: '#ffffff' }], { mode: 'merge' });
    assert.deepEqual(store.state.spaces.map((s) => s.id), [original.id]);
    assert.notEqual(original.color, '#ffffff');
    assert.deepEqual(urls(store, pinnedTabIds(original.pinned)), ['https://example.com/']);
  }
});

test('Merge leaves out a Space’s tab that the imported favorites hold', () => {
  const store = newStore();
  store.importSpaces([{ name: 'Arc', pinned: [tab('https://mail.example.com/'), tab('https://docs.example.com/')], today: [] }], { mode: 'merge', favorites: [tab('https://mail.example.com/')] });
  assert.deepEqual(urls(store, store.state.favorites), ['https://mail.example.com/']);
  assert.deepEqual(urls(store, pinnedTabIds(spaceNamed(store, 'Arc').pinned)), ['https://docs.example.com/']);
});

test('archived tabs keep title, address and time, newest first, each archiving once, within the archive’s limit', () => {
  const store = newStore();
  const day = 24 * 60 * 60 * 1000;
  const archived = Array.from({ length: 600 }, (_, i) => ({ url: `https://archived.example.com/${i}`, title: `Archived ${i}`, closedAt: Date.UTC(2025, 0, 1) + i * day }));
  const out = store.importSpaces([], { mode: 'merge', archive: archived });
  assert.deepEqual({ archived: out.archived, dropped: out.archiveDropped }, { archived: 500, dropped: 100 });
  assert.deepEqual(store.state.archive[0], archived[599]);
  assert.equal(store.state.archive.at(-1).url, 'https://archived.example.com/100');
  // No Space was given, so the fresh install's Space stays.
  assert.equal(store.state.spaces.length, 1);
  // The same archive again adds nothing.
  assert.deepEqual(mergeArchive(store.state.archive, archived.slice(100)), { archive: store.state.archive, added: 0, dropped: 0 });
});

test('Merge keeps an address the import itself repeats, as Append does', () => {
  const store = newStore();
  const folder = (name) => ({ kind: 'folder', name, children: [tab('https://x.example.com/')] });
  store.importSpaces([{ name: 'Chrome', pinned: [folder('A'), folder('B')], today: [] }], { mode: 'merge' });
  assert.deepEqual(spaceNamed(store, 'Chrome').pinned.map((n) => `${n.name}: ${urls(store, pinnedTabIds(n.children))}`), ['A: https://x.example.com/', 'B: https://x.example.com/']);
});

test('a favorite browsed away from still counts as its first address', () => {
  const store = newStore();
  store.importSpaces([], { mode: 'merge', favorites: [tab('https://mail.example.com/')] });
  store.state.tabs[store.state.favorites[0]].url = 'https://mail.example.com/inbox/1';
  store.importSpaces([], { mode: 'merge', favorites: [tab('https://mail.example.com/')] });
  assert.equal(store.state.favorites.length, 1);
});

test('a split of two tabs at the same address uses both, the ones this import added', () => {
  const store = newStore();
  const same = 'https://same.example.com/';
  store.importSpaces([{ name: 'Work', pinned: [tab(same)], today: [] }], { mode: 'append' });
  store.importSpaces([{ name: 'Work', pinned: [], today: [tab(same), tab(same)], splits: [[same, same]] }], { mode: 'append' });
  const work = store.state.spaces.at(-1);
  const view = store.view(work);
  assert.deepEqual(view.split, view.today);
});

test('Merge keeps a new Space’s folders of the same name apart, as the other browser had them', () => {
  const store = newStore();
  const folder = (url) => ({ kind: 'folder', name: 'Work', children: [tab(url)] });
  store.importSpaces([{ name: 'Chrome', pinned: [folder('https://a.example.com/'), folder('https://b.example.com/')], today: [] }], { mode: 'merge' });
  assert.deepEqual(spaceNamed(store, 'Chrome').pinned.map((n) => `${n.name}: ${urls(store, pinnedTabIds(n.children))}`), ['Work: https://a.example.com/', 'Work: https://b.example.com/']);
});

test('a split doesn’t take a pinned tab another window shows', () => {
  const store = withWork();
  const work = spaceNamed(store, 'Work');
  const [pinned] = pinnedTabIds(work.pinned);
  const other = store.openWindow().id;
  store.activate(pinned, { windowId: other });
  const out = store.importSpaces([{ name: 'Work', pinned: [], today: [tab('https://side.example.com/')], splits: [['https://work.example.com/', 'https://side.example.com/']] }], { mode: 'merge', windowId: store.state.windows[0].id });
  assert.deepEqual({ splits: out.splits, pairs: out.pairs }, { splits: 0, pairs: 1 });
  assert.equal(store.state.windows.find((w) => w.id === other).spaces[work.id].activeTabId, pinned);
});
