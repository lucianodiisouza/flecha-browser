/** Arc's StorableSidebar.json, as Flecha reads it (a made-up file of the same shape). Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arcColor, parseArcSidebar } from '../../native-host/arcImport.ts';
import { Store } from '../../shared/store.ts';

const tab = (id: string, parentID: string, url: string, title = '') => ({ id, parentID, title, childrenIds: [], data: { tab: { savedURL: url, savedTitle: url } } });
const sidebar = {
  sidebar: {
    containers: [
      { global: {} },
      {
        topAppsContainerIDs: [{ default: true }, 'top'],
        spaces: [
          'S1',
          {
            id: 'S1',
            title: 'Work',
            profile: { default: true },
            containerIDs: ['pinned', 'P1', 'unpinned', 'U1'],
            customInfo: { iconType: { emoji_v2: '💼' }, windowTheme: { primaryColorPalette: { midTone: { red: 0.51, green: 0.54, blue: 1.01 } } } },
          },
          'S2',
          {
            id: 'S2',
            title: 'Side',
            profile: { custom: { _0: { directoryBasename: 'Profile 1' } } },
            containerIDs: ['pinned', 'P2', 'unpinned', 'U2'],
            customInfo: { iconType: { icon: 'checkbox' } },
          },
        ],
        items: [
          'top', { id: 'top', childrenIds: ['f1'], data: { itemContainer: {} } },
          'f1', tab('f1', 'top', 'https://mail.example/'),
          'P1', { id: 'P1', childrenIds: ['d1', 't2'], data: { itemContainer: {} } },
          'd1', { id: 'd1', parentID: 'P1', title: 'Docs', childrenIds: ['d2', 't1'], data: { list: {} } },
          'd2', { id: 'd2', parentID: 'd1', title: 'Inner', childrenIds: ['t3'], data: { list: {} } },
          't1', tab('t1', 'd1', 'https://docs.example/', 'My docs'),
          't2', tab('t2', 'P1', 'https://work.example/'),
          't3', tab('t3', 'd2', 'https://inner.example/'),
          'U1', { id: 'U1', childrenIds: ['t4'], data: { itemContainer: {} } },
          't4', tab('t4', 'U1', 'https://today.example/'),
          'P2', { id: 'P2', childrenIds: [], data: { itemContainer: {} } },
          'U2', { id: 'U2', childrenIds: [], data: { itemContainer: {} } },
        ],
      },
    ],
  },
};

test('Spaces, nested folders, renamed tabs, Today and favorites come across', () => {
  const arc = parseArcSidebar(sidebar);
  assert.equal(arc.spaces.length, 2);
  const [work, side] = arc.spaces;
  assert.equal(work.name, 'Work');
  assert.equal(work.emoji, '💼');
  const docs = work.pinned[0] as { kind: 'folder'; name: string; children: Array<{ kind: string; name?: string; title?: string }> };
  assert.equal(docs.name, 'Docs');
  assert.equal(docs.children[0].name, 'Inner');
  assert.equal(docs.children[1].title, 'My docs');
  assert.deepEqual(work.today.map((t) => t.url), ['https://today.example/']);
  assert.deepEqual(arc.favorites.map((t) => t.url), ['https://mail.example/']);
  assert.equal(side.emoji, '☑️');
});

test('the theme color becomes a pastel, and another profile keeps its own cookies', () => {
  const [work, side] = parseArcSidebar(sidebar).spaces;
  assert.equal(work.color, '#cdd0ff');
  assert.equal(side.color, undefined);
  assert.equal(work.isolated, false);
  assert.equal(side.isolated, true);
  assert.equal(arcColor({ red: Number.NaN, green: 0, blue: 0 }), undefined);

  const store = new Store({ load: () => undefined, save: () => undefined });
  store.importArc(parseArcSidebar(sidebar));
  const [w, s] = store.state.spaces.slice(-2);
  assert.equal(w.color, '#cdd0ff');
  assert.equal(w.isolated, undefined);
  assert.equal(s.isolated, true);
  assert.ok(s.emoji);
});
