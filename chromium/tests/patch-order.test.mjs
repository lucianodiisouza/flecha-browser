import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';

test('Chromium patch filenames have unique sequence numbers', async () => {
  const names = await readdir(new URL('../patches/', import.meta.url));
  const patchesByNumber = new Map();

  for (const name of names.filter(name => name.endsWith('.patch')).sort()) {
    const match = /^(\d{4})-.+\.patch$/.exec(name);
    assert.ok(match, `Use NNNN-description.patch for ${name}`);
    const [, number] = match;
    const previous = patchesByNumber.get(number);
    assert.equal(previous, undefined, `Patch ${number} is shared by ${previous} and ${name}`);
    patchesByNumber.set(number, name);
  }
});
