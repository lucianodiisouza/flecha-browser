import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

// Same step budget as the native Chromium workflow tests.
const STEP_TIMEOUT = 10_000;

async function waitForWrite(write, expected) {
  let timer;
  try {
    await Promise.race([write, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), STEP_TIMEOUT);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

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
  await waitForWrite(writes[0].promise, 'startup to preserve the Peek ID after a failed close');
  assert.equal(close.mock.callCount(), 1);
  assert.deepEqual(stored.peeks, [42]);
  assert.equal(runInPeek('closeTab', 42), true);
  await waitForWrite(writes[1].promise, 'the close shortcut to remove the Peek ID');
  assert.equal(close.mock.callCount(), 2);
  assert.deepEqual(stored.peeks, []);
  assert.equal(runInPeek('closeTab', 42), false);
});
