// The preview of an Arc import and what applying it adds, from the synthetic fixture (arc-fixture.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { arcArchive, arcSidebar } from './arc-fixture.mjs';

const { parseArcSidebar, parseArcArchive } = await loadModule('chromium/native-host/arcImport.ts');
const { previewBrowserImport, applyBrowserImport } = await loadModule('chromium/shared/importApply.ts');
const { resultLine } = await loadModule('chromium/shared/importText.ts');
const { Store } = await loadModule('chromium/shared/store.ts');

const names = { 'Profile 1': 'Work profile' };
const arcData = () => {
  const arc = parseArcSidebar(arcSidebar(), names);
  arc.archive = parseArcArchive(arcArchive());
  return { name: 'Arc', arc, bookmarkCount: 0, history: [{ url: 'https://seen.example.com/', title: 'Seen', visits: 1, lastVisit: 1 }], warnings: [] };
};
const noHistory = { merge: (entries) => ({ added: entries.length, failed: 0 }) };

test('the preview lists each Space with its tabs, whether Merge joins it, its Profile, and what stays behind', () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  store.updateSpace(store.state.spaces[0].id, { name: 'Work' });
  const preview = previewBrowserImport(arcData(), store.state, true);
  assert.deepEqual(preview.spaces, [
    { name: 'Personal', emoji: '🏠', color: '#336699', pinned: 5, today: 4, splits: 2, matches: false, profile: undefined },
    { name: 'Work', emoji: '💼', color: '#ff0080', pinned: 1, today: 4, splits: 2, matches: true, profile: 'Work profile' },
  ]);
  assert.deepEqual([preview.favorites, preview.archived, preview.history, preview.canIsolate], [2, 3, 1, true]);
  assert.deepEqual(preview.skipped.slice(0, 4), [
    '1 tab with an address other than a web page (such as arc:)',
    '1 sidebar item of a kind Flecha doesn’t have (Arc calls it “easel”)',
    // Personal's three-tab split, and Work's second split.
    '2 split views kept as tabs side by side: Flecha shows one split of two tabs per Space',
    'Arc Profiles (“Work profile”): Flecha has no Profiles yet. Their Spaces can have Separate Cookies and Logins instead',
  ]);
  assert.match(preview.skipped.join('\n'), /Little Arc/);
  assert.match(preview.skipped.join('\n'), /Arc Notes aren’t in any file Flecha can read/);
});

test('importing merges by name, maps colour, split, archive and isolation, and summarizes Profiles and Notes', async () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  const result = await applyBrowserImport(arcData(), { mode: 'merge', isolate: [1] }, store, noHistory);
  assert.deepEqual(
    { spaces: result.spaces, merged: result.merged, bookmarks: result.bookmarks, archived: result.archived, history: result.history },
    // 5 + 4 Personal, 1 + 4 Work, 2 favorites.
    { spaces: 2, merged: 0, bookmarks: 16, archived: 3, history: 1 },
  );
  const [personal, work] = store.state.spaces;
  assert.deepEqual([personal.color, personal.isolated, work.color, work.isolated], ['#336699', undefined, '#ff0080', true]);
  const url = (id) => store.state.tabs[id].url;
  assert.deepEqual(store.view(personal).split.map(url), ['https://left.example.com/', 'https://right.example.com/']);
  assert.deepEqual(store.view(work).split.map(url), ['https://w1.example.com/', 'https://w2.example.com/']);
  assert.deepEqual(store.state.archive.map((a) => [a.url, a.title, new Date(a.closedAt).toISOString()]), [
    ['https://old.example.com/', 'Old, renamed', '2025-06-01T10:00:00.000Z'],
    ['https://old.example.com/', 'Old', '2025-05-01T10:00:00.000Z'],
    ['https://older.example.com/', 'Older', '2025-04-01T10:00:00.000Z'],
  ]);
  assert.match(result.details.join('\n'), /Arc Profiles \(“Work profile”\)/);
  assert.match(result.details.join('\n'), /Arc Notes/);

  // Again, merging: nothing is repeated.
  const again = await applyBrowserImport(arcData(), { mode: 'merge', isolate: [] }, store, noHistory);
  assert.deepEqual({ spaces: again.spaces, merged: again.merged, bookmarks: again.bookmarks, archived: again.archived }, { spaces: 0, merged: 2, bookmarks: 0, archived: 0 });
  // Again, adding: two more Spaces with everything but the favorites.
  const appended = await applyBrowserImport(arcData(), { mode: 'append', isolate: [] }, store, noHistory);
  assert.deepEqual({ spaces: appended.spaces, bookmarks: appended.bookmarks }, { spaces: 2, bookmarks: 14 });
  assert.equal(store.state.spaces.length, 4);
});

test('bookmarks from other browsers merge into the Space named after the browser', async () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  const data = { name: 'Chrome', bookmarks: [{ kind: 'tab', url: 'https://example.com/', title: 'Example' }], bookmarkCount: 1, history: [], warnings: [] };
  assert.deepEqual(previewBrowserImport(data, store.state, false).skipped, []);
  assert.equal((await applyBrowserImport(data, { mode: 'merge', isolate: [] }, store, noHistory)).spaces, 1);
  const again = await applyBrowserImport(data, { mode: 'merge', isolate: [] }, store, noHistory);
  assert.deepEqual({ spaces: again.spaces, merged: again.merged, bookmarks: again.bookmarks, details: again.details }, { spaces: 0, merged: 1, bookmarks: 0, details: [] });
  assert.equal(again.changed, false);
});

test('a history-only import reports failed writes without counting them as imports', async () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  const data = { name: 'Chrome', bookmarkCount: 0, history: [{ url: 'https://example.com/' }], warnings: [] };
  const result = await applyBrowserImport(data, { mode: 'merge', isolate: [] }, store, { merge: () => ({ added: 0, failed: 1 }) });
  assert.equal(result.changed, false);
  assert.equal(result.history, 0);
  assert.deepEqual(result.warnings, ['Couldn’t import 1 page from history.']);
});

test('a history adapter failure preserves the imported bookmarks in the result', async () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  const url = 'https://example.com/';
  const data = { name: 'Chrome', bookmarkCount: 1, bookmarks: [{ kind: 'tab', url, title: 'Example' }], history: [{ url }], warnings: [] };
  const history = { merge: async () => { throw new Error('History store failed'); } };
  const result = await applyBrowserImport(data, { mode: 'merge', isolate: [] }, store, history);
  assert.equal(result.changed, true);
  assert.equal(result.bookmarks, 1);
  assert.equal(result.history, 0);
  assert.match(result.warnings[0], /importing browser history/);
  assert.ok(Object.values(store.state.tabs).some(tab => tab.url === url));
});

test('partial history import reports the page it added and a warning', async () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  const data = { name: 'Chrome', bookmarkCount: 0, history: [{ url: 'https://one.example/' }, { url: 'https://two.example/' }], warnings: [] };
  const result = await applyBrowserImport(data, { mode: 'merge', isolate: [] }, store, { merge: () => ({ added: 1, failed: 1 }) });
  assert.equal(result.changed, true);
  assert.equal(result.history, 1);
  assert.equal(resultLine(result), '1 page');
  assert.deepEqual(result.warnings, ['Couldn’t import 1 page from history.']);
});

test('an empty folder merge reports a change even without a new tab', async () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  store.updateSpace(store.state.spaces[0].id, { name: 'Work' });
  const data = { name: 'Work', bookmarkCount: 0, bookmarks: [{ kind: 'folder', name: 'Empty', children: [] }], history: [], warnings: [] };
  const result = await applyBrowserImport(data, { mode: 'merge', isolate: [] }, store, noHistory);
  assert.equal(result.changed, true);
  assert.equal(result.bookmarks, 0);
  assert.match(resultLine(result), /1 folder/);
});

test('a split formed from existing tabs reports a change', async () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  store.updateSpace(store.state.spaces[0].id, { name: 'Work' });
  const urls = ['https://one.example/', 'https://two.example/'];
  for (const url of urls) store.addTab(url);
  const data = { name: 'Arc', bookmarkCount: 0, history: [], warnings: [], arc: {
    spaces: [{ name: 'Work', pinned: [], today: urls.map(url => ({ url, title: url })), splits: [urls] }],
    favorites: [], archive: [], skipped: {},
  } };
  const result = await applyBrowserImport(data, { mode: 'merge', isolate: [] }, store, noHistory);
  assert.equal(result.changed, true);
  assert.equal(result.bookmarks, 0);
  assert.match(resultLine(result), /1 split view/);
});

/** A one-Space sidebar whose Today holds `items` (id/object pairs) listed by `today`. */
const oneSpace = (items, today, space = {}) => ({
  sidebar: {
    containers: [
      {
        spaces: ['s', { id: 's', title: 'S', containerIDs: ['pinned', 'pin', 'unpinned', 'un'], ...space }],
        items: [...items, 'pin', { id: 'pin', childrenIds: [] }, 'un', { id: 'un', childrenIds: today }],
      },
    ],
  },
});
const arcTab = (id, url, title = null) => [id, { id, title, data: { tab: { savedURL: url } } }];

test('a split that lost a tab Flecha can’t open stays as the tabs that came over, and says so', async () => {
  const json = oneSpace(
    [
      ...arcTab('a', 'https://a.example.com/'), ...arcTab('arc', 'arc://settings'), 'two', { id: 'two', data: { splitView: {} }, childrenIds: ['a', 'arc'] },
      ...arcTab('b', 'https://b.example.com/'), ...arcTab('c', 'https://c.example.com/'), ...arcTab('arc2', 'arc://history'),
      'three', { id: 'three', data: { splitView: {} }, childrenIds: ['b', 'c', 'arc2'] },
      // A tab Arc kept no address for.
      ...arcTab('d', 'https://d.example.com/'), ...arcTab('e', 'https://e.example.com/'), 'blank', { id: 'blank', data: { tab: {} } },
      'nourl', { id: 'nourl', data: { splitView: {} }, childrenIds: ['d', 'e', 'blank'] },
    ],
    ['two', 'three', 'nourl'],
  );
  const arc = parseArcSidebar(json);
  assert.deepEqual(arc.spaces[0].splits, []);
  assert.deepEqual(arc.spaces[0].today.map((t) => t.url), ['https://a.example.com/', 'https://b.example.com/', 'https://c.example.com/', 'https://d.example.com/', 'https://e.example.com/']);
  assert.equal(arc.skipped['tab without address'], 1);
  const store = new Store({ load: () => undefined, save: () => {} });
  const result = await applyBrowserImport({ name: 'Arc', arc, bookmarkCount: 0, history: [], warnings: [] }, { mode: 'merge', isolate: [] }, store, noHistory);
  assert.equal(store.view(store.state.spaces[0]).split, undefined);
  assert.ok(result.details.includes('3 split views that lost a tab, kept as the tabs that came over'));
});

test('titles and emoji that aren’t text fall back instead of breaking the import', async () => {
  const json = oneSpace(
    [...arcTab('a', 'https://a.example.com/', 42), 'f', { id: 'f', title: { x: 1 }, data: { list: {} }, childrenIds: [] }],
    ['a'],
    { title: 7, customInfo: { iconType: { emoji_v2: 5 } } },
  );
  json.sidebar.containers[0].items.find((i) => i?.id === 'pin').childrenIds = ['f'];
  const arc = parseArcSidebar(json);
  assert.deepEqual([arc.spaces[0].name, arc.spaces[0].emoji, arc.spaces[0].pinned[0].name, arc.spaces[0].today[0].title], ['Space', undefined, 'Untitled folder', 'https://a.example.com/']);
  const store = new Store({ load: () => undefined, save: () => {} });
  const result = await applyBrowserImport({ name: 'Arc', arc, bookmarkCount: 0, history: [], warnings: [] }, { mode: 'merge', isolate: [] }, store, noHistory);
  assert.equal(result.spaces, 1);
});

test('nothing is imported when the browser’s Spaces changed since the preview', async () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  const before = store.state.spaces.map((s) => s.id);
  const { spacesKey } = previewBrowserImport(arcData(), store.state, true);
  const changed = arcData();
  changed.arc.spaces.reverse();
  const result = await applyBrowserImport(changed, { mode: 'merge', isolate: [1], spacesKey }, store, noHistory);
  assert.deepEqual([result.spaces, result.bookmarks, result.history], [0, 0, 0]);
  assert.match(result.warnings.join('\n'), /changed since the preview/);
  assert.deepEqual(store.state.spaces.map((s) => s.id), before);
  // The preview's own key imports.
  assert.equal((await applyBrowserImport(arcData(), { mode: 'merge', isolate: [1], spacesKey }, store, noHistory)).spaces, 2);
});

test('on a fresh install, an Arc Space named like Flecha’s first Space doesn’t claim to join it', () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  const preview = previewBrowserImport(arcData(), store.state, true);
  assert.deepEqual(preview.spaces.map((s) => [s.name, s.matches]), [['Personal', false], ['Work', false]]);
});

test('import options from the page fall back to merging without isolation', async () => {
  const { importOptions } = await loadModule('chromium/shared/importApply.ts');
  assert.deepEqual(importOptions(null, true), { mode: 'merge', isolate: [], spacesKey: undefined });
  assert.deepEqual(importOptions({ mode: 'replace', isolate: 'all', spacesKey: 3 }, true), { mode: 'merge', isolate: [], spacesKey: undefined });
  assert.deepEqual(importOptions({ mode: 'append', isolate: [0, -1, 1.5, '2', 3], spacesKey: 'k' }, true), { mode: 'append', isolate: [0, 3], spacesKey: 'k' });
  assert.deepEqual(importOptions({ mode: 'append', isolate: [0] }, false).isolate, []);
});

test('two Arc Spaces of the same name stay two, each with its own isolation and tabs', async () => {
  const work = (id, dir) => ({ id, name: 'Work', profile: dir ? { dir, name: dir } : undefined, pinned: [{ kind: 'tab', url: 'https://same.example.com/', title: 'Same' }], today: [], splits: [] });
  const data = () => ({ name: 'Arc', arc: { spaces: [work('w1'), work('w2', 'Profile 1')], favorites: [], archive: [], skipped: {} }, bookmarkCount: 0, history: [], warnings: [] });
  const store = new Store({ load: () => undefined, save: () => {} });
  const preview = previewBrowserImport(data(), store.state, true);
  assert.deepEqual(preview.spaces.map((s) => s.matches), [false, false]);
  const result = await applyBrowserImport(data(), { mode: 'merge', isolate: [1], spacesKey: preview.spacesKey }, store, noHistory);
  assert.deepEqual([result.spaces, result.merged, result.bookmarks], [2, 0, 2]);
  assert.deepEqual(store.state.spaces.map((s) => [s.name, !!s.isolated, s.pinned.length]), [['Work', false, 1], ['Work', true, 1]]);

  // Both join a Work Space Flecha already had, and each keeps the tab the other brought.
  const merged = new Store({ load: () => undefined, save: () => {} });
  merged.updateSpace(merged.state.spaces[0].id, { name: 'Work' });
  const again = await applyBrowserImport(data(), { mode: 'merge', isolate: [] }, merged, noHistory);
  assert.deepEqual([again.spaces, again.merged, again.bookmarks], [0, 2, 2]);
  assert.equal(merged.state.spaces[0].pinned.length, 2);
});

test('the preview key tells apart Spaces of the same name and Profile by Arc’s id', async () => {
  const space = (id) => ({ id, name: 'Work', pinned: [], today: [], splits: [] });
  const data = (ids) => ({ name: 'Arc', arc: { spaces: ids.map(space), favorites: [], archive: [], skipped: {} }, bookmarkCount: 0, history: [], warnings: [] });
  const store = new Store({ load: () => undefined, save: () => {} });
  const { spacesKey } = previewBrowserImport(data(['a', 'b']), store.state, true);
  const result = await applyBrowserImport(data(['b', 'a']), { mode: 'append', isolate: [0], spacesKey }, store, noHistory);
  assert.equal(result.spaces, 0);
  assert.match(result.warnings.join(), /changed since the preview/);
});
