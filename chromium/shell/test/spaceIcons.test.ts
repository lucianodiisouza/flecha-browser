/** Monochrome Space icons. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPACE_EMOJIS } from '../ui/spaceChoices.ts';
import { monochromeIcon } from '../ui/spaceIcons.ts';

test('every emoji Flecha offers for a Space has a monochrome icon', () => {
  for (const emoji of SPACE_EMOJIS) assert.match(monochromeIcon(emoji) ?? '', /^M/, emoji);
});

test('an emoji matches with or without its variation selector', () => {
  assert.equal(monochromeIcon('☕'), monochromeIcon('☕️'));
});

test('other emoji, and none, have no icon and stay as they are', () => {
  assert.equal(monochromeIcon('🦄'), undefined);
  assert.equal(monochromeIcon(''), undefined);
  assert.equal(monochromeIcon(undefined), undefined);
});

test('no path leans on where the one before it ended', () => {
  // Lucide's shapes are joined into one path: a relative "m" in the middle would move from
  // the previous shape's end instead of from the origin.
  for (const emoji of SPACE_EMOJIS) assert.doesNotMatch(monochromeIcon(emoji)!, /m/, emoji);
});
