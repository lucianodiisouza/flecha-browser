import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { loadModule } from './load-module.mjs';

test('the toolbar overrides the surface and only state consumers use the sidebar port', async t => {
  const connections = [];
  globalThis.location = { pathname: '/window.html' };
  globalThis.document = { documentElement: { dataset: { surface: 'window' } } };
  globalThis.window = { addEventListener() {} };
  globalThis.chrome = { runtime: { connect({ name }) {
    connections.push(name);
    return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} } };
  } } };
  t.mock.method(globalThis, 'setInterval', () => {});
  const { portForPage } = await loadModule('chromium/shell/client.ts');
  assert.deepEqual(connections, ['flecha-sidebar']);
  for (const [path, surface, expected] of [
    ['/flechinha.html', 'window', 'flecha-toolbar'],
    ['/sidebar.html', 'panel', 'flecha-sidebar'],
    ['/newtab.html', 'newtab', 'flecha-sidebar'],
    ['/settings.html', undefined, 'flecha-settings'],
    ['/history.html', undefined, 'flecha-page'],
  ]) assert.equal(portForPage(path, surface), expected);
});

test('native frame and fullscreen recover from lookup and request failures', async t => {
  const calls = { frame: [], fullscreen: [] };
  const request = (kind, value, id) => {
    assert.equal(id, 41);
    const response = Promise.withResolvers();
    calls[kind].push({ value, ...response });
    return response.promise;
  };
  const firstLookup = Promise.withResolvers();
  const getWindowId = t.mock.fn(async () => 41);
  // windowUi independently looks up its window ID when the module loads.
  getWindowId.mock.mockImplementationOnce(() => firstLookup.promise, 1);
  let receive;
  globalThis.location = { pathname: '/window.html' };
  globalThis.document = { documentElement: { dataset: { surface: 'window' }, style: { setProperty() {} } }, getElementById: () => null };
  globalThis.window = { addEventListener() {} };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.chrome = {
    runtime: { connect: () => ({ onMessage: { addListener: listener => { receive = listener; } }, onDisconnect: { addListener() {} } }) },
    flechaPrivate: {
      getWindowId,
      setFrame: (value, id) => request('frame', value.overlay, id),
      setSidebarInPageFullscreen: (value, id) => request('fullscreen', value, id),
    },
  };
  t.mock.method(globalThis, 'setInterval', () => {});
  await loadModule('chromium/shell/flechaApi.ts');
  const emit = (name, value) => receive({ type: 'event', name, args: [value] });
  const frame = (enabled) => emit('frame', { sidebar: 'docked', overlay: enabled, sidebarInPageFullscreen: enabled });
  emit('state', { tint: '#ffffff', sidebarWidth: 260 });
  await t.test('both calls share a fresh window ID lookup after rejection', async () => {
    frame(false);
    assert.equal(getWindowId.mock.callCount(), 2);
    firstLookup.reject(new Error('Window ID unavailable'));
    await setImmediate();
    assert.deepEqual(calls, { frame: [], fullscreen: [] });
    frame(false);
    await setImmediate();
    assert.equal(getWindowId.mock.callCount(), 3);
    assert.equal(calls.frame.length, 1);
    assert.equal(calls.fullscreen.length, 1);
  });
  frame(false);
  await setImmediate();
  for (const kind of Object.values(calls)) {
    assert.deepEqual(kind.map(call => call.value), [false]);
    kind[0].reject(new Error('Native frame host unavailable'));
  }
  await setImmediate();

  frame(false); // Retry the same values, then cycle back to them while the retry is pending.
  frame(true);
  frame(false);
  await setImmediate();
  for (const kind of Object.values(calls)) {
    assert.deepEqual(kind.map(call => call.value), [false, false, true, false]);
    kind[1].reject(new Error('Older request with the same value failed'));
    kind[2].reject(new Error('Older request with a different value failed'));
  }
  await setImmediate();
  frame(false);
  await setImmediate();
  assert.equal(calls.frame.length, 4);
  assert.equal(calls.fullscreen.length, 4);

  calls.frame[3].reject(new Error('Current frame request failed'));
  calls.fullscreen[3].resolve();
  await setImmediate();
  frame(false);
  await setImmediate();
  assert.equal(calls.frame[4]?.value, false);
  assert.equal(calls.fullscreen.length, 4);
  calls.frame[4].resolve();
});

test('the worker’s closed snapshot preserves a palette opened locally in the side panel', async t => {
  let receive;
  globalThis.location = { pathname: '/sidebar.html' };
  globalThis.document = { documentElement: { dataset: { surface: 'panel' } } };
  globalThis.window = { addEventListener() {} };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.chrome = {
    runtime: { connect: () => ({ onMessage: { addListener: listener => { receive = listener; } }, onDisconnect: { addListener() {} } }) },
  };
  t.mock.method(globalThis, 'setInterval', () => {});
  await loadModule('chromium/shell/flechaApi.ts', { fresh: true });
  const api = window.flecha;
  const events = [];
  api.onPalette((mode) => events.push(mode));
  api.onClosePalette(() => events.push('closed'));
  const emit = (name, ...args) => receive({ type: 'event', name, args });
  api.openPalette('new-tab');
  emit('palette-closed');
  assert.deepEqual(events, ['new-tab']);
  emit('palette', 'navigate', 'worker');
  emit('palette-closed');
  assert.deepEqual(events, ['new-tab', 'navigate', 'closed']);
  api.openPalette('split');
  emit('close-palette');
  assert.deepEqual(events, ['new-tab', 'navigate', 'closed', 'split', 'closed']);
});
