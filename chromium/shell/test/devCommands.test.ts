/** The command bar's developer shortcuts. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { devSuggestions } from '../ui/devCommands.ts';

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('words every object has are not commands', () => {
  for (const query of ['constructor function javascript', '__proto__ pollution', 'hasOwnProperty x']) {
    assert.deepEqual(devSuggestions(query), [], query);
  }
});

test('commands still work, in any case', () => {
  assert.equal(devSuggestions('npm react')[0].url, 'https://www.npmjs.com/package/react');
  assert.equal(devSuggestions('MDN grid')[0].url, 'https://developer.mozilla.org/en-US/search?q=grid');
});

test('a JWT decodes as UTF-8', () => {
  const payload = { sub: 'João', name: 'José 日本' };
  const [jwt] = devSuggestions(`${base64url({ alg: 'HS256' })}.${base64url(payload)}.signature`);
  assert.match(jwt.label, /sub João/);
  assert.deepEqual(JSON.parse(jwt.copy!).payload, payload);
});
