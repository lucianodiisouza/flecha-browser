/** Next window: the walk through Flecha's windows. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextWindowId } from '../lib/windowCycle.ts';

test('walks the windows in the order they were opened, round and round', () => {
  assert.equal(nextWindowId([30, 10, 20], 10, 1), 20);
  assert.equal(nextWindowId([30, 10, 20], 30, 1), 10);
  assert.equal(nextWindowId([30, 10, 20], 10, -1), 30);
});

test('stays put with one window', () => {
  assert.equal(nextWindowId([10], 10, 1), undefined);
  assert.equal(nextWindowId([], 10, 1), undefined);
});

test('from a window outside the walk, such as Settings, goes to the first or the last', () => {
  assert.equal(nextWindowId([10, 20], 99, 1), 10);
  assert.equal(nextWindowId([10, 20], 99, -1), 20);
  assert.equal(nextWindowId([10], undefined, 1), 10);
});
