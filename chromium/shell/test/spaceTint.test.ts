/** Space colours in dark mode. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spaceTint } from '../lib/spaceTint.ts';

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const distance = (a: string, b: string) => Math.hypot(...rgb(a).map((c, i) => c - rgb(b)[i]));

test('light mode keeps the colour', () => {
  assert.equal(spaceTint('#f5e7c4', false), '#f5e7c4');
});

test('dark mode keeps the hue and makes it dark', () => {
  const [r, g, b] = rgb(spaceTint('#cdd9f7', true)); // a blue
  assert.ok(b > r && b > g);
  assert.ok(Math.max(r, g, b) < 90);
  const [r2, , b2] = rgb(spaceTint('#f7dcc0', true)); // a peach
  assert.ok(r2 > b2);
});

test('two Spaces still tell apart in dark mode', () => {
  assert.ok(distance(spaceTint('#cdd9f7', true), spaceTint('#f5e7c4', true)) > 30);
  assert.ok(distance(spaceTint('#d3ecd5', true), spaceTint('#f4cfdc', true)) > 30);
});

test('the plain colour wears the old dark slate', () => {
  assert.equal(spaceTint('#d9dfe9', true), '#2f3746');
  assert.equal(spaceTint('#D9DFE9', true), '#2f3746');
  assert.equal(spaceTint('#d9dfe9', false), '#d9dfe9');
});

test('a grey stays grey, and a malformed colour is left alone', () => {
  const [r, g, b] = rgb(spaceTint('#808080', true));
  assert.ok(r === g && g === b);
  assert.equal(spaceTint('red', true), 'red');
});
