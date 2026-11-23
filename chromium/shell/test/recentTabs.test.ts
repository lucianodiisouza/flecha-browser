/** Recent tab: the walk through a Space's tabs by last use. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WALK_MS, stepRecent } from '../lib/recentTabs.ts';

// Used in the order d (oldest), c, b, a (showing now).
const tabs = [
  { id: 'a', lastActive: 400 },
  { id: 'b', lastActive: 300 },
  { id: 'c', lastActive: 200 },
  { id: 'd', lastActive: 100 },
];

test('one press goes to the tab used before this one', () => {
  const step = stepRecent(undefined, 's', tabs, 'a', 1000);
  assert.equal(step?.tabId, 'b');
  assert.equal(step?.passed, undefined);
});

test('presses in quick succession go further back, and wrap', () => {
  let step = stepRecent(undefined, 's', tabs, 'a', 1000)!;
  step = stepRecent(step.walk, 's', tabs, 'b', 1200)!;
  assert.equal(step.tabId, 'c');
  // b was only passed through: it gets its old time back.
  assert.deepEqual(step.passed, { tabId: 'b', lastActive: 300 });
  step = stepRecent(step.walk, 's', tabs, 'c', 1400)!;
  assert.equal(step.tabId, 'd');
  step = stepRecent(step.walk, 's', tabs, 'd', 1600)!;
  assert.equal(step.tabId, 'a');
  assert.deepEqual(step.passed, { tabId: 'd', lastActive: 100 });
  // Leaving the tab the walk began on takes nothing from it.
  step = stepRecent(step.walk, 's', tabs, 'a', 1800)!;
  assert.equal(step.tabId, 'b');
  assert.equal(step.passed, undefined);
});

test('after a pause the next press starts over: two tabs take turns', () => {
  const first = stepRecent(undefined, 's', tabs, 'a', 1000)!;
  // b is showing and is now the most recent; a is the one before.
  const later = [{ id: 'b', lastActive: 1000 }, ...tabs.filter((t) => t.id !== 'b')];
  const second = stepRecent(first.walk, 's', later, 'b', 1000 + WALK_MS)!;
  assert.equal(second.tabId, 'a');
  assert.equal(second.passed, undefined);
});

test('a walk ends when another tab is showing, the Space changes or a tab is gone', () => {
  const first = stepRecent(undefined, 's', tabs, 'a', 1000)!;
  assert.equal(stepRecent(first.walk, 's', tabs, 'd', 1100)!.tabId, 'a');
  assert.equal(stepRecent(first.walk, 'other', tabs, 'b', 1100)!.tabId, 'a');
  const fewer = tabs.filter((t) => t.id !== 'c');
  assert.equal(stepRecent(first.walk, 's', fewer, 'b', 1100)!.tabId, 'a');
});

test('nothing to do with one tab or none', () => {
  assert.equal(stepRecent(undefined, 's', [tabs[0]], 'a', 1000), null);
  assert.equal(stepRecent(undefined, 's', [], undefined, 1000), null);
});
