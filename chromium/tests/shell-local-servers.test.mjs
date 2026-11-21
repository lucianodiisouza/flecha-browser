import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { loadModule } from './load-module.mjs';

const { DEV_PORTS, watchLocalServers } = await loadModule('chromium/shell/features/localServers.ts');

test('discovery sleeps without focus, scans on return and never overlaps a pending scan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let focus, initial, finish;
  globalThis.chrome = { windows: { WINDOW_ID_NONE: -1,
    onFocusChanged: { addListener: fn => { focus = fn; } },
    getLastFocused: () => new Promise(resolve => { initial = resolve; }),
  } };
  const calls = t.mock.method(globalThis, 'fetch', async () => {
    if (finish === undefined) await new Promise(resolve => { finish = resolve; });
    throw new Error('no server');
  });
  watchLocalServers(() => assert.fail('all ports are closed'));
  focus(-1);
  initial({ focused: true });
  await setImmediate();
  t.mock.timers.runAll();
  assert.equal(calls.mock.callCount(), 0);
  focus(1);
  assert.equal(calls.mock.callCount(), DEV_PORTS.length);
  focus(-1);
  focus(2);
  assert.equal(calls.mock.callCount(), DEV_PORTS.length);
  finish();
  await setImmediate();
  assert.equal(calls.mock.callCount(), DEV_PORTS.length);
  // Switching windows after the scan completes also preserves its next poll.
  focus(-1);
  focus(1);
  assert.equal(calls.mock.callCount(), DEV_PORTS.length);
  t.mock.timers.runAll();
  assert.equal(calls.mock.callCount(), DEV_PORTS.length * 2);
  await setImmediate();
  // Once a scheduled poll has missed focus, returning must wake it immediately.
  focus(-1);
  t.mock.timers.runAll();
  assert.equal(calls.mock.callCount(), DEV_PORTS.length * 2);
  focus(2);
  assert.equal(calls.mock.callCount(), DEV_PORTS.length * 3);
  await setImmediate();
});
