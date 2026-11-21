import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

test('failed legacy Peek cleanup preserves the saved window and the close shortcut', async (t) => {
  const stored = { peeks: [42] };
  const writes = [Promise.withResolvers(), Promise.withResolvers()];
  let writeIndex = 0;
  const event = { addListener() {} };
  let attempts = 0;
  const close = t.mock.fn(async () => {
    if (++attempts === 1) throw new Error('The Peek is still open');
  });
  globalThis.chrome = {
    storage: { session: {
      get: async () => structuredClone(stored),
      set: async (update) => {
        Object.assign(stored, structuredClone(update));
        writes[writeIndex++].resolve();
      },
    } },
    flechaPrivate: { openPeek: async () => {}, closePeek: close, onPeekChanged: event },
    contextMenus: { onClicked: event },
    windows: { onRemoved: event },
  };
  t.after(() => delete globalThis.chrome);
  const { runInPeek } = await loadModule('chromium/shell/native.ts');
  await writes[0].promise;
  assert.equal(close.mock.callCount(), 1);
  assert.deepEqual(stored.peeks, [42]);
  assert.equal(runInPeek('closeTab', 42), true);
  await writes[1].promise;
  assert.equal(close.mock.callCount(), 2);
  assert.deepEqual(stored.peeks, []);
  assert.equal(runInPeek('closeTab', 42), false);
});
