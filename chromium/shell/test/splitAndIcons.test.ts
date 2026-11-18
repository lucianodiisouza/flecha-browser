/** Swapping a split's sides, and a pinned tab's emoji icon. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../shared/store.ts';

const fresh = () => new Store({ load: () => undefined, save: () => undefined });

test('Swap Sides trades the halves, their places in Today and the divider', () => {
  const store = fresh();
  const a = store.addTab('https://a.example/').id;
  const b = store.addTab('https://b.example/').id;
  store.splitWith(a, 'left');
  store.setSplitRatio(0.3);
  const space = store.activeSpace;
  assert.deepEqual(space.split, [a, b]);
  const before = space.today.indexOf(a);
  store.swapSplit();
  assert.deepEqual(space.split, [b, a]);
  assert.equal(space.today.indexOf(b), before);
  assert.ok(Math.abs(space.splitRatio! - 0.7) < 1e-9);
});

test('a responsive split keeps its mirror on the right', () => {
  const store = fresh();
  store.addTab('https://a.example/');
  const mirror = store.openResponsive()!;
  store.swapSplit();
  assert.equal(store.activeSpace.split![1], mirror);
});

test('a tab icon is one emoji, and empty removes it', () => {
  const store = fresh();
  const id = store.addTab('https://a.example/').id;
  store.setTabEmoji(id, '🇧🇷 Brasil');
  assert.equal(store.state.tabs[id].emoji, '🇧🇷');
  store.setTabEmoji(id, '  ');
  assert.equal(store.state.tabs[id].emoji, undefined);
});
