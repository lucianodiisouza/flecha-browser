import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

test('Settings refreshes the open indicator after delayed live-tab entry and on exit', async t => {
  const { Store, listen, LiveTabs, registerSettings } = await loadModule('chromium/tests/settings-tab-manager-entry.ts');
  const store = new Store({ load: () => undefined, save: () => {} });
  const liveTabs = new LiveTabs();
  let connect;
  globalThis.chrome = { runtime: { onConnect: { addListener: listener => { connect = listener; } } } };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  registerSettings({ store, liveTabs, unload() {}, broadcastState() {} });
  listen(Promise.resolve());
  const views = [];
  await connect({
    name: 'flecha-settings',
    onMessage: { addListener() {}, removeListener() {} },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      if (message.name === 'settings:tabs') views.push(message.args[0]);
    },
  });

  const tab = store.addTab('https://example.test/');
  const open = () => views.map(view => view.tabs[tab.id].open);
  // Let the Store's existing 120 ms refresh fire before the physical tab opens.
  t.mock.timers.tick(120);
  assert.deepEqual(open(), [false]);

  liveTabs.set(tab.id, 41);
  t.mock.timers.tick(120);
  assert.deepEqual(open(), [false, true]);
  store.updateTab(tab.id, { loading: true });
  liveTabs.set(tab.id, 42);
  t.mock.timers.tick(120);
  assert.deepEqual(open(), [false, true]);

  liveTabs.delete(tab.id);
  t.mock.timers.tick(120);
  assert.deepEqual(open(), [false, true, false]);
});
