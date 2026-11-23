/** The menu bar's Spaces, Tabs and Archive menus (lib/menus.ts). Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../shared/store.ts';
import { flechaMenus } from '../lib/menus.ts';

const fresh = () => new Store({ load: () => undefined, save: () => undefined });
const keys = (id: string) => ({ pinTab: 'CmdOrCtrl+D', newSpace: 'Ctrl+Shift+N' })[id];
const menu = (store: Store, title: string, stayOnTop = false) =>
  flechaMenus(store.state, { stayOnTop, keys, spaceModifier: 'Ctrl' }).find((m) => m.title === title)!;
const labelled = (store: Store, title: string, label: string) => menu(store, title).items.find((i) => i.text === label);

test('Spaces lists every Space, checks the active one and numbers the first nine', () => {
  const store = fresh();
  const first = store.activeSpace.id;
  const second = store.newSpace();
  const items = menu(store, 'Spaces').items.filter((i) => i.command?.startsWith('menu:space:'));
  assert.equal(items.length, 2);
  assert.equal(items[0].command, `menu:space:${first}`);
  assert.equal(items[0].checked, false);
  assert.equal(items[1].checked, true);
  assert.equal(items[1].command, `menu:space:${second.id}`);
  assert.equal(items[1].accelerator, 'Ctrl+2');
  assert.equal(menu(store, 'Spaces').items[0].accelerator, 'Ctrl+Shift+N');
  assert.equal(labelled(store, 'Spaces', 'Separate Cookies and Logins')?.checked, true);
});

test('Tabs follows the active tab: Pin or Unpin, and split items only in a split', () => {
  const store = fresh();
  assert.equal(labelled(store, 'Tabs', 'Pin Tab')?.enabled, false);
  const a = store.addTab('https://a.example/').id;
  assert.equal(labelled(store, 'Tabs', 'Pin Tab')?.enabled, true);
  assert.equal(labelled(store, 'Tabs', 'Exit Split View')?.enabled, false);
  store.addTab('https://b.example/');
  store.splitWith(a, 'left');
  assert.equal(labelled(store, 'Tabs', 'Swap Split Sides')?.enabled, true);
  store.togglePin(store.activeSpace.activeTabId!);
  assert.ok(labelled(store, 'Tabs', 'Unpin Tab'));
});

test('Archive shows the latest archived tabs, and Window has Stay On Top and Next Window', () => {
  const store = fresh();
  assert.equal(menu(store, 'Archive').items.at(-1)?.text, 'No Archived Tabs');
  store.state.archive.unshift({ url: 'https://old.example/', title: 'Old page', closedAt: 42 });
  assert.equal(labelled(store, 'Archive', 'Old page')?.command, 'menu:reopen:42');
  assert.equal(menu(store, 'Window', true).items[0].checked, true);
  assert.equal(labelled(store, 'Window', 'Next Window')?.command, 'nextWindow');
  assert.equal(labelled(store, 'Window', 'Previous Window')?.command, 'previousWindow');
});
