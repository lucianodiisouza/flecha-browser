/** Swapping a split's sides, and a pinned tab's emoji icon. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../shared/store.ts';

const fresh = () => {
  const store = new Store({ load: () => undefined, save: () => undefined });
  return { store, view: store.attachView(store.createView({ resume: true })) };
};

test('Swap Sides trades the halves, their places in Today and the divider', () => {
  const { store, view } = fresh();
  const a = store.addTab(view, 'https://a.example/').id;
  const b = store.addTab(view, 'https://b.example/').id;
  store.splitWith(view, a, 'left');
  store.setSplitRatio(view, 0.3);
  const space = store.activeSpaceOf(view);
  assert.deepEqual(space.split, [a, b]);
  const before = space.today.indexOf(a);
  store.swapSplit(view);
  assert.deepEqual(space.split, [b, a]);
  assert.equal(space.today.indexOf(b), before);
  assert.ok(Math.abs(space.splitRatio! - 0.7) < 1e-9);
});

test('a responsive split keeps its mirror on the right', () => {
  const { store, view } = fresh();
  store.addTab(view, 'https://a.example/');
  const mirror = store.openResponsive(view)!;
  store.swapSplit(view);
  assert.equal(store.activeSpaceOf(view).split![1], mirror);
});

test('a tab icon is one emoji, and empty removes it', () => {
  const { store, view } = fresh();
  const id = store.addTab(view, 'https://a.example/').id;
  store.setTabEmoji(id, '🇧🇷 Brasil');
  assert.equal(store.state.tabs[id].emoji, '🇧🇷');
  store.setTabEmoji(id, '  ');
  assert.equal(store.state.tabs[id].emoji, undefined);
});
