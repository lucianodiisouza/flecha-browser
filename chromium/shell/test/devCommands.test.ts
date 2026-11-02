/** The command bar's developer shortcuts. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { devSuggestions } from '../ui/devCommands.ts';

test('words every object has are not commands', () => {
  for (const query of ['constructor function javascript', '__proto__ pollution', 'hasOwnProperty x']) {
    assert.deepEqual(devSuggestions(query), [], query);
  }
});

test('commands still work, in any case', () => {
  assert.equal(devSuggestions('npm react')[0].url, 'https://www.npmjs.com/package/react');
  assert.equal(devSuggestions('MDN grid')[0].url, 'https://developer.mozilla.org/en-US/search?q=grid');
});
