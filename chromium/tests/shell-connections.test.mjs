import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { loadModule } from './load-module.mjs';

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => [...listeners].forEach((listener) => listener(...args)),
  };
}

test('worker restart resumes shell messages and a bad payload leaves other replies intact', async (t) => {
  const ports = [];
  let attempts = 0;
  let transportError;
  const toast = {};
  globalThis.window = { addEventListener() {}, setTimeout: (...args) => setTimeout(...args) };
  globalThis.document = { querySelector: () => toast };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  globalThis.chrome = { runtime: { connect() {
    if (++attempts === 2) throw new Error('Worker still starting');
    const port = {
      sent: [], onDisconnect: event(), onMessage: event(), disconnect: () => port.onDisconnect.emit(),
      postMessage(message) {
        if (transportError) throw new Error(transportError);
        port.sent.push(JSON.parse(JSON.stringify(message)));
      },
    };
    ports.push(port);
    return port;
  } } };
  t.after(() => {
    delete globalThis.chrome;
    delete globalThis.window;
    delete globalThis.document;
  });
  const { cmd, invoke, on, onReconnect } = await loadModule('chromium/shell/client.ts');
  let reconnects = 0;
  onReconnect(() => ++reconnects);
  const received = [];
  on('state', (state) => received.push(state));
  const pending = invoke('beforeRestart');
  const rejected = assert.rejects(pending, /background restarted/);
  ports[0].onDisconnect.emit();
  await rejected;

  t.mock.timers.tick(100);
  assert.equal(attempts, 2);
  assert.equal(ports.length, 1);
  await assert.rejects(invoke('duringBackoff'), /background can’t be reached/);
  assert.equal(cmd('newTab')(), false);
  assert.match(toast.textContent, /didn’t send this command/);
  assert.equal(attempts, 2);
  t.mock.timers.tick(200);
  assert.equal(ports.length, 2);
  assert.equal(reconnects, 1);
  ports[0].onMessage.emit({ type: 'event', name: 'state', args: ['old'] });
  ports[1].onMessage.emit({ type: 'event', name: 'state', args: ['new'] });
  assert.deepEqual(received, ['new']);
  const next = invoke('afterRestart');
  const circular = {};
  circular.self = circular;
  await assert.rejects(invoke('invalid', circular), /circular/);
  ports[1].onMessage.emit({ type: 'result', id: ports[1].sent[0].id, value: 'ok' });
  assert.equal(await next, 'ok');
  assert.deepEqual(ports.map((port) => port.sent.map(({ name }) => name)), [['beforeRestart'], ['afterRestart']]);

  const disconnect = t.mock.method(ports[1], 'disconnect');
  transportError = 'Attempting to use a disconnected port object';
  await assert.rejects(invoke('broken'), (error) => error.sent === false);
  assert.equal(disconnect.mock.callCount(), 1);
  t.mock.timers.tick(400);
  assert.equal(ports.length, 3);
  transportError = 'Extension context invalidated.';
  assert.equal(cmd('closeTab')(), false);
  assert.match(toast.textContent, /Reload this page/);
  const attemptsBeforeInvalidation = attempts;
  t.mock.timers.tick(20_000);
  assert.equal(attempts, attemptsBeforeInvalidation);
});

test('a broken reply port does not drop broadcasts to connected pages', async (t) => {
  globalThis.chrome = { runtime: { onConnect: event() } };
  t.after(() => delete globalThis.chrome);
  const { broadcast, handle, listen } = await loadModule('chromium/shell/hub.ts');
  handle({ probe: () => 'result' });
  listen(Promise.resolve());
  const page = (postMessage) => ({ name: 'flecha', onMessage: event(), onDisconnect: event(), postMessage, disconnect() {} });
  let attempts = 0;
  const broken = page(() => { attempts++; throw new Error('Disconnected'); });
  const events = [];
  const healthy = page((message) => events.push(message));
  chrome.runtime.onConnect.emit(broken);
  chrome.runtime.onConnect.emit(healthy);
  await nextTurn();
  broken.onMessage.emit({ type: 'invoke', name: 'probe', id: 1, args: [] });
  await nextTurn();
  broadcast('ready', true);
  assert.equal(attempts, 1);
  assert.deepEqual(events, [{ type: 'event', name: 'ready', args: [true] }]);
});

test('agent wait validation leaves room for the transport watchdog', async () => {
  const { AGENT_TOOLS } = await loadModule('chromium/shared/agentTools.ts');
  const { MAX_TOOL_WAIT, toolTimeout, toolWatchdog } = await loadModule('chromium/native-host/protocol.ts');
  const value = AGENT_TOOLS.wait_for.inputSchema.timeoutMs;
  for (const invalid of [-1, 1.5, 2_147_483_647]) assert.equal(value.safeParse(invalid).success, false);
  assert.equal(value.safeParse(MAX_TOOL_WAIT).success, true);
  assert.equal(toolWatchdog(2_147_483_647), 2_147_483_647);
  assert.ok(toolWatchdog(MAX_TOOL_WAIT) > toolTimeout(MAX_TOOL_WAIT));
});

test('Boosts serializes saves and keeps the editor address aligned with a retained draft', async (t) => {
  const messages = [];
  const port = { onDisconnect: event(), onMessage: event(), postMessage: (message) => messages.push(message) };
  const nodes = new Map();
  const element = () => ({
    value: '', classList: { add() {}, toggle() {} }, addEventListener() {}, append() {}, replaceChildren() {}, focus() {},
  });
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const handlers = new Map();
  const location = { hash: '#first.css', pathname: '/boosts.html', search: '' };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const globals = {
    chrome: { runtime: { connect: () => port } },
    document: { getElementById: node, querySelector: node, createElement: element, addEventListener() {} },
    window: { addEventListener: (type, fn) => handlers.set(type, fn) },
    location,
    history: { replaceState: (_state, _title, hash) => { location.hash = hash; } },
    confirm: () => true,
  };
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const key of Object.keys(globals)) delete globalThis[key];
  });
  await loadModule('chromium/shell/boostsPage.ts');
  await nextTurn();
  const file = { name: 'first.css', host: 'first', kind: 'styles', code: 'original' };
  const reply = (message, value) => port.onMessage.emit({ type: 'result', id: message.id, value });
  reply(messages.find(({ name }) => name === 'boosts:get'), file);
  await nextTurn();
  const listRead = messages.find(({ name }) => name === 'boosts:list');
  const editorStatus = node('status').textContent;
  port.onMessage.emit({ type: 'result', id: listRead.id, error: 'Couldn’t read the list' });
  await nextTurn();
  assert.match(node('list-error').textContent, /Couldn’t load Boosts/);
  assert.equal(node('status').textContent, editorStatus);
  port.onMessage.emit({ type: 'event', name: 'boosts:changed', args: [] });
  reply(messages.filter(({ name }) => name === 'boosts:list').at(-1), [file]);
  await nextTurn();
  assert.equal(node('list-error').textContent, '');
  const code = node('code');
  const button = node('save');
  const sentSaves = () => messages.filter(({ name }) => name === 'boosts:save');
  code.value = 'first edit';
  button.onclick();
  code.value = 'second edit';
  button.onclick();
  await nextTurn();
  assert.deepEqual(sentSaves().map(({ args }) => args[1]), ['first edit']);
  reply(sentSaves()[0], { ...file, code: 'first edit' });
  await nextTurn();
  assert.deepEqual(sentSaves().map(({ args }) => args[1]), ['first edit', 'second edit']);
  reply(sentSaves()[1], { ...file, code: 'second edit' });
  await nextTurn();
  code.value = 'first edit';
  let beforeUnload = false;
  handlers.get('beforeunload')({ preventDefault: () => { beforeUnload = true; } });
  assert.equal(beforeUnload, true, 'reverting to the first save still differs from the second');

  location.hash = '#second.css';
  handlers.get('hashchange')();
  await nextTurn();
  code.value = 'retained draft';
  reply(messages.find(({ args }) => args[0] === 'second.css'), { ...file, name: 'second.css' });
  await nextTurn();
  assert.equal(code.value, 'retained draft');
  assert.equal(location.hash, '#first.css');

  code.value = 'new revision';
  button.onclick();
  code.value = 'newest revision';
  button.onclick();
  await nextTurn();
  location.hash = '#second.css';
  handlers.get('hashchange')();
  await nextTurn();
  const second = { ...file, name: 'second.css', code: 'second file' };
  reply(messages.filter(({ name }) => name === 'boosts:get').at(-1), second);
  await nextTurn();
  location.hash = '#first.css';
  handlers.get('hashchange')();
  await nextTurn();
  assert.equal(messages.filter(({ name }) => name === 'boosts:get').at(-1).args[0], 'second.css');
  reply(sentSaves().at(-1), { ...file, code: 'new revision' });
  await nextTurn();
  assert.equal(messages.filter(({ name }) => name === 'boosts:get').at(-1).args[0], 'second.css');
  reply(sentSaves().at(-1), { ...file, code: 'newest revision' });
  await nextTurn();
  reply(messages.filter(({ name }) => name === 'boosts:get').at(-1), { ...file, code: 'newest revision' });
  await nextTurn();
  assert.equal(code.value, 'newest revision');

  node('delete').onclick();
  assert.equal(code.readOnly, true);
  location.hash = '#second.css';
  handlers.get('hashchange')();
  await nextTurn();
  reply(messages.find(({ name }) => name === 'boosts:delete'), undefined);
  await nextTurn();
  assert.equal(location.hash, '#second.css');
  assert.equal(code.readOnly, false);
  port.onDisconnect.emit();
  await nextTurn();
  assert.equal(location.hash, '#second.css');
  t.mock.timers.tick(100);
  await nextTurn();
  assert.equal(messages.filter(({ name }) => name === 'boosts:get').at(-1).args[0], 'second.css');
  reply(messages.filter(({ name }) => name === 'boosts:get').at(-1), second);
  await nextTurn();
  assert.equal(code.value, 'second file');
  node('delete').onclick();
  assert.equal(code.readOnly, true);
  await nextTurn();
  const deletion = messages.filter(({ name }) => name === 'boosts:delete').at(-1);
  port.onMessage.emit({ type: 'result', id: deletion.id, error: 'Fixture delete failure' });
  await nextTurn();
  assert.equal(code.readOnly, false);
  assert.equal(code.value, 'second file');
});

test('the agent restores focus and can replay console logs after idle on a shared debugger', async (t) => {
  const calls = [];
  const results = [];
  const tab = { id: 12, title: 'Phone fixture', url: 'https://example.com/phone' };
  const port = { onMessage: event(), onDisconnect: event(), postMessage: (message) => results.push(message) };
  let emulatedFocus = false;
  let runtimeEnabled = false;
  let logEnabled = false;
  let disableRuntime = Promise.withResolvers();
  let failSetup = false;
  let readPending;
  let keyDown;
  const idleMessage = { type: 'error', args: [{ value: 'Logged while idle' }] };
  globalThis.chrome = {
    runtime: { connectNative: () => port },
    tabs: { onRemoved: event(), get: async () => tab },
    debugger: {
      onDetach: event(),
      onEvent: event(),
      attach: async ({ tabId }) => calls.push(['attach', tabId]),
      detach: async ({ tabId }) => calls.push(['detach', tabId]),
      async sendCommand(_tab, method, params) {
        if (method === 'Emulation.setFocusEmulationEnabled') emulatedFocus = params.enabled;
        if (method === 'Runtime.enable') {
          if (!runtimeEnabled && calls.some(([name]) => name === 'disabled')) {
            chrome.debugger.onEvent.emit({ tabId: tab.id }, 'Runtime.consoleAPICalled', idleMessage);
          }
          runtimeEnabled = true;
        }
        if (method === 'Runtime.disable') {
          await disableRuntime.promise;
          runtimeEnabled = false;
          calls.push(['disabled']);
        }
        if (method === 'Log.enable') {
          if (failSetup) {
            failSetup = false;
            throw new Error('Fixture setup failed');
          }
          logEnabled = true;
        }
        if (method === 'Log.disable') logEnabled = false;
        if (method === 'Runtime.evaluate') {
          await readPending?.promise;
          return { result: { value: 'fixture body' } };
        }
        if (method === 'Input.dispatchKeyEvent') {
          calls.push([params.type]);
          if (params.type === 'rawKeyDown') await keyDown?.promise;
        }
      },
    },
  };
  t.after(() => delete globalThis.chrome);
  const { Store, hold, release, registerNativeHost } = await loadModule('chromium/tests/native-agent-entry.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new Store({ load: () => undefined, save: () => {} });
  store.state.agent = { enabled: true };
  const phone = store.addTab(tab.url).id;
  assert.equal(await hold(tab.id, 'responsive'), true);
  const host = registerNativeHost({ store, broadcastState() {}, agentTabsChanged() {}, tabs: { chromeTab: async () => tab.id } });
  readPending = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 23, name: 'read_page', args: { tabId: phone } });
  await nextTurn();
  // Let Runtime replay messages, then approach the host's tool deadline.
  t.mock.timers.tick(100);
  await nextTurn();
  t.mock.timers.tick(59_000);
  await nextTurn();
  assert.equal(emulatedFocus, true, 'a tool retains its debugger while the host still waits');
  readPending.resolve();
  await nextTurn();
  assert.match(results.find(({ type }) => type === 'toolResult').result.content[0].text, /fixture body/);
  assert.equal(emulatedFocus, true);
  t.mock.timers.tick(120_000);
  await nextTurn();
  assert.equal(emulatedFocus, false);
  assert.equal(logEnabled, false);
  assert.equal(host.agentTabsInUse().has(tab.id), false);
  assert.deepEqual(calls, [['attach', tab.id]]);
  port.onMessage.emit({ type: 'tool', id: 24, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  assert.equal(emulatedFocus, false, 'the new request waits for cleanup');
  disableRuntime.resolve();
  await nextTurn();
  t.mock.timers.tick(100);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 24).result.content[0].text, /Logged while idle/);
  await release(tab.id, 'responsive');
  assert.deepEqual(calls, [['attach', tab.id], ['disabled']]);
  t.mock.timers.tick(120_000);
  await nextTurn();
  assert.deepEqual(calls, [['attach', tab.id], ['disabled'], ['detach', tab.id]]);

  failSetup = true;
  disableRuntime = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 25, name: 'read_page', args: { tabId: phone } });
  await nextTurn();
  port.onMessage.emit({ type: 'tool', id: 26, name: 'read_page', args: { tabId: phone } });
  await nextTurn();
  assert.equal(results.some(({ id }) => id === 26), false);
  disableRuntime.resolve();
  await nextTurn();
  t.mock.timers.tick(100);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 25).result.content[0].text, /Fixture setup failed/);
  assert.match(results.find(({ id }) => id === 26).result.content[0].text, /fixture body/);

  readPending = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 27, name: 'read_page', args: { tabId: phone } });
  await nextTurn();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 27).result.content[0].text, /didn’t answer read_page within 60s/);
  port.onMessage.emit({ type: 'tool', id: 30, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  assert.equal(results.some(({ id }) => id === 30), false, 'a retry waits for the old native command');
  readPending.resolve();
  await nextTurn();
  assert.ok(results.some(({ id }) => id === 30));
  t.mock.timers.tick(120_000);
  await nextTurn();
  assert.equal(host.agentTabsInUse().has(tab.id), false);
  assert.deepEqual(calls.at(-1), ['detach', tab.id]);

  assert.equal(await hold(tab.id, 'responsive'), true);
  disableRuntime = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 28, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  t.mock.timers.tick(100);
  await nextTurn();
  t.mock.timers.tick(120_000);
  await nextTurn();
  t.mock.timers.tick(60_000);
  await nextTurn();
  port.onMessage.emit({ type: 'tool', id: 33, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 33).result.content[0].text, /didn’t answer console_logs within 60s/);
  assert.equal(emulatedFocus, false, 'a canceled waiter cannot enable focus while cleanup is pending');
  port.onMessage.emit({ type: 'tool', id: 29, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  t.mock.timers.tick(100);
  await nextTurn();
  assert.equal(results.some(({ id }) => id === 29), false, 'a retry cannot enable domains before the old reset ends');
  disableRuntime.resolve();
  await nextTurn();
  t.mock.timers.tick(100);
  await nextTurn();
  assert.equal(results.find(({ id }) => id === 29)?.result.isError, undefined);
  assert.ok(results.some(({ id }) => id === 29));
  assert.equal(runtimeEnabled, true);
  keyDown = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 31, name: 'press_key', args: { tabId: phone, key: 'Escape' } });
  await nextTurn();
  assert.deepEqual(calls.at(-1), ['rawKeyDown']);
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.deepEqual(calls.at(-1), ['keyUp']);
  assert.match(results.find(({ id }) => id === 31).result.content[0].text, /didn’t answer press_key/);
  keyDown.resolve();
  await nextTurn();
  await release(tab.id, 'responsive');
});

test('releasing a debugger holder queued behind a detach cancels its attachment', async (t) => {
  let detach = Promise.withResolvers();
  globalThis.chrome = { debugger: { onDetach: event(), attach: async () => {}, detach: () => detach.promise } };
  t.after(() => delete globalThis.chrome);
  const attach = t.mock.method(chrome.debugger, 'attach');
  const { hold, release } = await loadModule('chromium/shell/features/debuggee.ts');
  assert.equal(await hold(12, 'original'), true);
  const closing = release(12, 'original');
  const queued = hold(12, 'canceled');
  const canceling = release(12, 'canceled');
  detach.resolve();
  assert.equal(await queued, false);
  await Promise.all([closing, canceling]);
  assert.equal(attach.mock.callCount(), 1);
  assert.equal(await hold(12, 'new'), true);
  assert.equal(attach.mock.callCount(), 2);

  detach = Promise.withResolvers();
  const closingAgain = release(12, 'new');
  const oldClaim = hold(12, 'same-holder');
  const cancelingAgain = release(12, 'same-holder');
  const newClaim = hold(12, 'same-holder');
  chrome.debugger.onDetach.emit({ tabId: 12 }, 'target_closed');
  detach.resolve();
  assert.equal(await oldClaim, false);
  assert.equal(await newClaim, false);
  await Promise.all([closingAgain, cancelingAgain]);
  assert.equal(attach.mock.callCount(), 2);
});

test('the responsive split keeps the phone viewport width when the window grows', async () => {
  const { phoneSplitRatio, PHONE_WIDTH } = await loadModule('chromium/shell/lib/responsiveViewport.ts');
  for (const total of [800, 1200, 3760, 5000]) {
    const phoneWidth = total * (1 - phoneSplitRatio(total));
    assert.ok(Math.abs(phoneWidth - PHONE_WIDTH) < 1, 'split ratio rounds within a CSS pixel');
  }
});

test('responsive sizing waits for the native split, discards stale widths, and corrects divider drags', async (t) => {
  const boundsChanged = event();
  const tabsUpdated = event();
  const ratioChanged = event();
  const splitResized = event();
  const ratios = [];
  let write;
  let measure = async (id) => ({ splitViewId: id, width: 400 });
  globalThis.chrome = {
    flechaPrivate: {
      onSplitRatioChanged: ratioChanged,
      onSplitAreaResized: splitResized,
      setSplitRatio: async (...args) => {
        ratios.push(args);
        await write?.promise;
      },
    },
    tabs: { get: (id) => measure(id), onUpdated: tabsUpdated },
    windows: { onBoundsChanged: boundsChanged },
  };
  t.after(() => delete globalThis.chrome);
  const { Store } = await loadModule('chromium/shared/store.ts');
  const { frameResized, registerNative } = await loadModule('chromium/shell/native.ts');
  const { phoneSplitRatio } = await loadModule('chromium/shell/lib/responsiveViewport.ts');
  const store = new Store({ load: () => undefined, save: () => {} });
  const desktop = store.addTab('https://example.com/');
  const phone = store.openResponsive();
  const ids = new Map([[desktop.id, 1], [phone, 2]]);
  registerNative({
    store,
    chromeTabId: (id) => ids.get(id),
    flechaTabId: (id) => id === 1 ? desktop.id : phone,
    flechaWindowId: (id) => id === 10 ? store.focusedWindowId : undefined,
  });
  await nextTurn();
  assert.deepEqual(ratios, []);

  measure = async () => ({ splitViewId: 3, width: 400 });
  tabsUpdated.emit(2, { splitViewId: 3 });
  await nextTurn();
  assert.deepEqual(ratios, [[1, phoneSplitRatio(800)]]);

  const stale = Promise.withResolvers();
  measure = () => stale.promise;
  boundsChanged.emit();
  await nextTurn();
  measure = async () => ({ splitViewId: 3, width: 600 });
  boundsChanged.emit();
  await nextTurn();
  stale.resolve({ splitViewId: 3, width: 450 });
  await nextTurn();
  assert.deepEqual(ratios, [[1, phoneSplitRatio(800)], [1, phoneSplitRatio(1200)]]);

  ratioChanged.emit(1, 0.45);
  await nextTurn();
  assert.deepEqual(ratios.at(-1), [1, phoneSplitRatio(1200)]);
  assert.equal(ratios.length, 3);
  assert.equal(store.activeSpace.splitRatio, undefined);

  store.setSidebarVisible(false);
  await nextTurn();
  assert.equal(ratios.length, 3, 'the Store update precedes native layout');
  measure = async () => ({ splitViewId: 3, width: 640 });
  frameResized(store.focusedWindowId);
  await nextTurn();
  assert.deepEqual(ratios.at(-1), [1, phoneSplitRatio(1280)]);
  write = Promise.withResolvers();
  measure = async () => ({ splitViewId: 3, width: 600 });
  boundsChanged.emit();
  await nextTurn();
  measure = async () => ({ splitViewId: 3, width: 640 });
  boundsChanged.emit();
  assert.deepEqual(ratios.at(-1), [1, phoneSplitRatio(1200)]);
  write.resolve();
  await nextTurn();
  assert.deepEqual(ratios.at(-1), [1, phoneSplitRatio(1280)]);
  measure = async () => ({ splitViewId: 3, width: 2500 });
  splitResized.emit(10);
  await nextTurn();
  assert.deepEqual(ratios.at(-1), [1, phoneSplitRatio(5000), true]);
});
