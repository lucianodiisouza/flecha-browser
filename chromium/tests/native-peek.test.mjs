import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { loadModule } from './load-module.mjs';

test('failed legacy Peek cleanup preserves the saved window and the close shortcut', async (t) => {
  const stored = { peeks: [42] };
  const event = { addListener() {} };
  let attempts = 0;
  const close = t.mock.fn(async () => {
    if (++attempts === 1) throw new Error('The Peek is still open');
  });
  globalThis.chrome = {
    storage: { session: {
      get: async () => structuredClone(stored),
      set: async (update) => Object.assign(stored, structuredClone(update)),
    } },
    flechaPrivate: { openPeek: async () => {}, closePeek: close, onPeekChanged: event },
    contextMenus: { onClicked: event },
    windows: { onRemoved: event },
  };
  t.after(() => delete globalThis.chrome);
  const { runInPeek } = await loadModule('chromium/shell/native.ts');
  await nextTurn();
  assert.deepEqual(stored.peeks, [42]);
  assert.equal(runInPeek('closeTab', 42), true);
  await nextTurn();
  assert.deepEqual(stored.peeks, []);
  assert.equal(runInPeek('closeTab', 42), false);
});
