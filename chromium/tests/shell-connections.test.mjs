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

test('an unserializable reply fails only its own invoke', async (t) => {
  globalThis.chrome = { runtime: { onConnect: event() } };
  t.after(() => delete globalThis.chrome);
  const { broadcast, handle, listen } = await loadModule('chromium/shell/hub.ts');
  const delayed = Promise.withResolvers();
  const circular = {};
  circular.self = circular;
  handle({ malformed: () => circular, delayed: () => delayed.promise });
  listen(Promise.resolve());
  const received = [];
  const page = {
    name: 'flecha', onMessage: event(), onDisconnect: event(),
    postMessage(message) {
      try { JSON.stringify(message); }
      catch { throw new Error('Could not serialize message.'); }
      received.push(message);
    },
    disconnect() { this.onDisconnect.emit(); },
  };
  chrome.runtime.onConnect.emit(page);
  await nextTurn();
  page.onMessage.emit({ type: 'invoke', name: 'delayed', id: 1, args: [] });
  page.onMessage.emit({ type: 'invoke', name: 'malformed', id: 2, args: [] });
  await nextTurn();
  delayed.resolve('ok');
  await nextTurn();
  broadcast('ready', true);
  assert.deepEqual(received, [
    { type: 'result', id: 2, error: 'Could not serialize message.' },
    { type: 'result', id: 1, value: 'ok' },
    { type: 'event', name: 'ready', args: [true] },
  ]);
});

test('failed startup tells the page to restart and does not reconnect or run buffered invokes', async (t) => {
  const connecting = event();
  const toast = {};
  globalThis.window = { addEventListener() {}, setTimeout: (...args) => setTimeout(...args) };
  globalThis.document = { querySelector: () => toast };
  const disconnect = t.mock.fn(() => {
    client.onDisconnect.emit();
    server.onDisconnect.emit();
  });
  const client = {
    onMessage: event(), onDisconnect: event(), disconnect,
    postMessage: (message) => server.onMessage.emit(message),
  };
  const server = {
    name: 'flecha', onMessage: event(), onDisconnect: event(), disconnect,
    postMessage: (message) => client.onMessage.emit(message),
  };
  const connect = t.mock.fn(() => { connecting.emit(server); return client; });
  globalThis.chrome = { runtime: { onConnect: connecting, connect } };
  t.after(() => {
    delete globalThis.chrome;
    delete globalThis.window;
    delete globalThis.document;
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(console, 'error', () => {});
  const { handle, listen } = await loadModule('chromium/shell/hub.ts');
  const startup = Promise.withResolvers();
  const invoked = t.mock.fn();
  handle({ startupProbe: invoked });
  listen(startup.promise);
  const { invoke } = await loadModule('chromium/shell/client.ts', { fresh: true });
  const rejected = assert.rejects(invoke('startupProbe'), { sent: false, message: /Restart Flecha/ });
  startup.reject(new Error('Failed to load preferences'));
  await rejected;
  assert.match(toast.textContent, /Restart Flecha/);
  assert.equal(disconnect.mock.callCount(), 1);
  await assert.rejects(invoke('startupProbe'), { sent: false, message: /Restart Flecha/ });
  t.mock.timers.tick(20_000);
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(invoked.mock.callCount(), 0);
});

test('a reconnect reads the committed Boost when deletion is delayed or rejected', async (t) => {
  const saved = { boosts: { 'kept.example.css': 'body {}' } };
  let write = Promise.withResolvers();
  const setting = t.mock.fn(async (items) => {
    await write.promise;
    Object.assign(saved, structuredClone(items));
  });
  globalThis.chrome = {
    extension: { inIncognitoContext: false },
    storage: { local: { get: async () => structuredClone(saved), set: setting } },
    tabs: { query: async () => [], onRemoved: event() },
    webNavigation: { onCommitted: event(), onDOMContentLoaded: event() },
    debugger: { onDetach: event() },
  };
  t.after(() => delete globalThis.chrome);
  const boosts = await loadModule('chromium/shell/features/boosts.ts');
  await boosts.ready();
  const name = 'kept.example.css';
  const deleting = boosts.remove(name);
  const failed = assert.rejects(deleting, /Storage write failed/);
  await nextTurn();
  assert.equal(setting.mock.callCount(), 1);
  const read = t.mock.fn();
  const reconnect = boosts.getCommitted(name).then(read);
  const list = t.mock.fn();
  const reloadingList = boosts.list().then(list);
  await nextTurn();
  assert.equal(read.mock.callCount(), 0);
  assert.equal(list.mock.callCount(), 0);
  write.reject(new Error('Storage write failed'));
  await failed;
  await Promise.all([reconnect, reloadingList]);
  assert.equal(read.mock.calls[0].arguments[0].name, name);
  assert.equal(list.mock.calls[0].arguments[0][0].name, name);
  assert.equal(saved.boosts[name], 'body {}');

  write = Promise.withResolvers();
  const retry = boosts.remove(name);
  const confirming = boosts.getCommitted(name);
  const confirmingList = boosts.list();
  write.resolve();
  await retry;
  assert.equal(await confirming, undefined);
  assert.deepEqual(await confirmingList, []);
  assert.equal(saved.boosts[name], undefined);
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

test('a Boost save returns its own result before the queued deletion updates Chrome', async (t) => {
  const refresh = Promise.withResolvers();
  const unregister = t.mock.fn(async () => {});
  const register = t.mock.fn(async () => {});
  const persist = t.mock.fn(async () => {});
  globalThis.chrome = {
    extension: { inIncognitoContext: false },
    storage: { local: { get: async () => ({}), set: persist } },
    tabs: { query: t.mock.fn(() => refresh.promise), onRemoved: event() },
    webNavigation: { onCommitted: event(), onDOMContentLoaded: event() },
    debugger: { onDetach: event() },
    userScripts: { getScripts: async () => [], unregister, register },
  };
  t.after(() => delete globalThis.chrome);
  const boosts = await loadModule('chromium/shell/features/boosts.ts', { fresh: true });
  const name = 'kept.example.ts';
  const saved = boosts.save(name, 'source', { build: { code: 'built' } });
  assert.equal((await boosts.getCommitted(name)).code, 'source');
  await nextTurn();
  assert.equal(register.mock.callCount(), 1);
  const deleting = boosts.remove(name);
  await nextTurn();
  assert.equal(persist.mock.callCount(), 1);
  assert.equal(unregister.mock.callCount(), 2, 'startup and save only while save refresh is pending');
  refresh.resolve([]);
  assert.equal((await saved).code, 'source');
  await deleting;
  assert.equal(unregister.mock.callCount(), 3);
  assert.deepEqual(await boosts.list(), []);
});

test('Boosts serializes saves and keeps the editor address aligned with a retained draft', async (t) => {
  const messages = [];
  const port = { onDisconnect: event(), onMessage: event(), postMessage: (message) => messages.push(message) };
  const nodes = new Map();
  const element = () => ({
    value: '', dataset: {}, children: [], classList: { add() {}, toggle() {} }, addEventListener() {}, focus() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return this.children.flatMap((child) => child.children); },
  });
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const handlers = new Map();
  const location = { hash: '', pathname: '/boosts.html', search: '' };
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
  const listRead = messages.find(({ name }) => name === 'boosts:list');
  port.onMessage.emit({ type: 'result', id: listRead.id, error: 'Couldn’t read the list' });
  await nextTurn();
  assert.match(node('list-error').textContent, /Couldn’t load Boosts/);
  assert.equal(node('retry-list').hidden, false);
  node('retry-list').onclick();
  const listRetry = messages.filter(({ name }) => name === 'boosts:list').at(-1);
  assert.notEqual(listRetry.id, listRead.id);
  reply(listRetry, [file]);
  await nextTurn();
  assert.equal(node('list-error').textContent, '');
  assert.equal(node('retry-list').hidden, true);
  location.hash = '#first.css';
  handlers.get('hashchange')();
  await nextTurn();
  const deepLinkList = messages.filter(({ name }) => name === 'boosts:list').at(-1);
  assert.notEqual(deepLinkList.id, listRetry.id);
  reply(deepLinkList, [file]);
  await nextTurn();
  assert.equal(node('list').children.length, 1, 'the list renders while the editor read is still pending');
  reply(messages.find(({ name }) => name === 'boosts:get'), file);
  await nextTurn();
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

  handlers.get('hashchange')();
  await nextTurn();
  const staleRead = messages.filter(({ name }) => name === 'boosts:get').at(-1);
  button.onclick();
  await nextTurn();
  reply(staleRead, { ...second, code: 'a newer disk revision' });
  await nextTurn();
  assert.equal(code.value, 'second file', 'a read started before Save cannot overwrite the committed draft');
  reply(sentSaves().at(-1), second);
  await nextTurn();
  reply(messages.filter(({ name }) => name === 'boosts:get').at(-1), second);
  await nextTurn();

  location.hash = '#%';
  handlers.get('hashchange')();
  await nextTurn();
  location.hash = '#second.css';
  handlers.get('hashchange')();
  await nextTurn();
  reply(messages.filter(({ name }) => name === 'boosts:get').at(-1), second);
  await nextTurn();
  code.value = 'unsaved draft';
  node('delete').onclick();
  await nextTurn();
  const deleteCount = messages.filter(({ name }) => name === 'boosts:delete').length;
  port.onDisconnect.emit();
  await nextTurn();
  assert.match(node('status').textContent, /Couldn’t confirm deletion/);
  t.mock.timers.tick(5_000);
  await nextTurn();
  const verification = messages.filter(({ name }) => name === 'boosts:get').at(-1);
  port.onMessage.emit({ type: 'result', id: verification.id, error: 'Fixture verification failure' });
  await nextTurn();
  assert.match(node('delete-check-status').textContent, /Couldn’t check/);
  assert.equal(node('retry-delete-check').hidden, false);
  assert.equal(code.readOnly, true);
  node('retry-delete-check').onclick();
  reply(messages.filter(({ name }) => name === 'boosts:get').at(-1), undefined);
  await nextTurn();
  assert.equal(node('retry-delete-check').hidden, true);
  assert.match(node('status').textContent, /deleted.*copy your draft/);
  assert.equal(code.value, 'unsaved draft');
  assert.equal(button.disabled, true);
  assert.equal(messages.filter(({ name }) => name === 'boosts:delete').length, deleteCount);

  location.hash = '#third.css';
  handlers.get('hashchange')();
  await nextTurn();
  reply(messages.filter(({ name }) => name === 'boosts:get').at(-1), { ...file, name: 'third.css' });
  await nextTurn();
  assert.equal(code.value, 'original');
  node('delete').onclick();
  await nextTurn();
  port.onDisconnect.emit();
  await nextTurn();
  t.mock.timers.tick(5_000);
  await nextTurn();
  const cleanVerification = messages.filter(({ name }) => name === 'boosts:get').at(-1);
  assert.deepEqual(cleanVerification.args, ['third.css']);
  reply(cleanVerification, undefined);
  await nextTurn();
  const savesBefore = sentSaves().length;
  button.onclick();
  await nextTurn();
  assert.equal(sentSaves().length, savesBefore, 'Save cannot recreate a clean Boost after deletion is confirmed');
  assert.equal(code.value, '');
  assert.equal(location.hash.slice(1), '');
});

test('the agent restores focus, replays idle logs, and recovers a stalled debugger', async (t) => {
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
  let keyUp;
  let setupPending;
  let pendingTabRead;
  let waitingForTabRead = false;
  let refusedEvaluation = false;
  let diagnosingRefusal = false;
  let detachPending;
  let evaluationError;
  const inputFailures = new Map();
  let pendingNavigation = Promise.withResolvers();
  const idleMessage = { type: 'error', args: [{ value: 'Logged while idle' }] };
  globalThis.chrome = {
    runtime: { connectNative: () => port },
    tabs: {
      onRemoved: event(),
      get: () => {
        if (!pendingTabRead) return Promise.resolve(tab);
        waitingForTabRead = true;
        return pendingTabRead;
      },
      async update(_id, { url }) {
        await pendingNavigation.promise;
        tab.url = url;
      },
    },
    scripting: { executeScript: () => {
      diagnosingRefusal = true;
      return new Promise(() => {});
    } },
    debugger: {
      onDetach: event(),
      onEvent: event(),
      attach: async ({ tabId }) => calls.push(['attach', tabId]),
      detach: async ({ tabId }) => {
        calls.push(['detach', tabId]);
        await detachPending?.promise;
      },
      async sendCommand(_tab, method, params) {
        if (method === 'Emulation.setFocusEmulationEnabled') emulatedFocus = params.enabled;
        if (method === 'Runtime.enable') {
          await setupPending?.promise;
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
          if (refusedEvaluation) throw new Error('Cannot attach to this target');
          await readPending?.promise;
          if (evaluationError) return { exceptionDetails: { text: evaluationError } };
          return { result: { value: 'fixture body' } };
        }
        if (method === 'Input.dispatchKeyEvent') {
          calls.push([params.type]);
          if (inputFailures.has(params.type)) throw new Error(inputFailures.get(params.type));
          if (params.type === 'rawKeyDown') await keyDown?.promise;
          if (params.type === 'keyUp') await keyUp?.promise;
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
  let liveId = tab.id;
  assert.equal(await hold(tab.id, 'responsive'), true);
  const host = registerNativeHost({ store, broadcastState() {}, agentTabsChanged() {}, tabs: {
    chromeTab: async () => tab.id,
    liveId: () => liveId,
    close(id) { store.closeTab(id); liveId = undefined; },
  } });
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

  readPending = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 34, name: 'evaluate', args: { tabId: phone, expression: 'new Promise(() => {})' } });
  await nextTurn();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 34).result.content[0].text, /didn’t answer evaluate within 60s/);
  t.mock.timers.tick(59_999);
  port.onMessage.emit({ type: 'tool', id: 35, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  assert.equal(results.some(({ id }) => id === 35), false, 'the retry cannot run on the stalled session');
  t.mock.timers.tick(1);
  await nextTurn();
  assert.deepEqual(calls.slice(-2), [['detach', tab.id], ['attach', tab.id]]);
  t.mock.timers.tick(100);
  await nextTurn();
  assert.equal(results.find(({ id }) => id === 35)?.result.isError, undefined);
  assert.ok(results.some(({ id }) => id === 35), 'a new tool runs even though the original evaluation never settles');

  assert.equal(await hold(tab.id, 'responsive'), true);
  disableRuntime = Promise.withResolvers();
  t.mock.timers.tick(120_000);
  await nextTurn();
  t.mock.timers.tick(59_999);
  port.onMessage.emit({ type: 'tool', id: 36, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  assert.equal(results.some(({ id }) => id === 36), false, 'a new tool waits for the shared cleanup');
  t.mock.timers.tick(1);
  await nextTurn();
  assert.deepEqual(calls.slice(-2), [['detach', tab.id], ['attach', tab.id]]);
  t.mock.timers.tick(100);
  await nextTurn();
  assert.equal(results.find(({ id }) => id === 36)?.result.isError, undefined);
  assert.ok(results.some(({ id }) => id === 36), 'a new tool runs even though the old shared cleanup never settles');

  keyDown = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 37, name: 'press_key', args: { tabId: phone, key: 'Escape' } });
  await nextTurn();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.deepEqual(calls.slice(-2), [['rawKeyDown'], ['keyUp']]);
  assert.match(results.find(({ id }) => id === 37).result.content[0].text, /didn’t answer press_key within 60s/);
  t.mock.timers.tick(59_999);
  port.onMessage.emit({ type: 'tool', id: 38, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  assert.equal(results.some(({ id }) => id === 38), false, 'the new tool waits for the stalled input session');
  t.mock.timers.tick(1);
  await nextTurn();
  assert.deepEqual(calls.slice(-2), [['detach', tab.id], ['attach', tab.id]]);
  t.mock.timers.tick(100);
  await nextTurn();
  assert.ok(results.some(({ id, result }) => id === 38 && !result.isError), 'the next tool recovers without resolving key-down');

  keyDown = undefined;
  keyUp = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 39, name: 'press_key', args: { tabId: phone, key: 'Escape' } });
  await nextTurn();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 39).result.content[0].text, /didn’t answer press_key within 60s/);
  t.mock.timers.tick(59_999);
  port.onMessage.emit({ type: 'tool', id: 40, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  t.mock.timers.tick(1);
  await nextTurn();
  assert.deepEqual(calls.slice(-2), [['detach', tab.id], ['attach', tab.id]]);
  t.mock.timers.tick(100);
  await nextTurn();
  assert.ok(results.some(({ id, result }) => id === 40 && !result.isError), 'the next tool recovers without resolving key-up');

  t.mock.timers.tick(120_000);
  await nextTurn();
  setupPending = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 41, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 41).result.content[0].text, /didn’t answer console_logs within 60s/);
  setupPending = undefined;
  t.mock.timers.tick(59_999);
  port.onMessage.emit({ type: 'tool', id: 42, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  t.mock.timers.tick(1);
  await nextTurn();
  assert.deepEqual(calls.slice(-2), [['detach', tab.id], ['attach', tab.id]]);
  t.mock.timers.tick(100);
  await nextTurn();
  assert.ok(results.some(({ id, result }) => id === 42 && !result.isError), 'the next tool recovers without resolving debugger setup');

  refusedEvaluation = true;
  port.onMessage.emit({ type: 'tool', id: 46, name: 'read_page', args: { tabId: phone } });
  await nextTurn();
  assert.equal(diagnosingRefusal, true);
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 46).result.content[0].text, /didn’t answer read_page within 60s/);
  refusedEvaluation = false;
  readPending = undefined;
  pendingTabRead = new Promise(() => {});
  port.onMessage.emit({ type: 'tool', id: 47, name: 'read_page', args: { tabId: phone } });
  await nextTurn();
  assert.equal(waitingForTabRead, true, 'diagnosis released the queue while its Chrome request was still pending');
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 47).result.content[0].text, /didn’t answer read_page within 60s/);
  port.onMessage.emit({ type: 'tool', id: 48, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  assert.ok(results.some(({ id, result }) => id === 48 && !result.isError), 'stalled non-debugger reads release the tab queue');
  pendingTabRead = undefined;

  const destination = 'https://example.com/after-navigation';
  port.onMessage.emit({ type: 'tool', id: 49, name: 'navigate', args: { tabId: phone, url: destination } });
  await nextTurn();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 49).result.content[0].text, /didn’t answer navigate within 60s/);
  port.onMessage.emit({ type: 'tool', id: 50, name: 'read_page', args: { tabId: phone } });
  await nextTurn();
  assert.equal(results.some(({ id }) => id === 50), false, 'the next tool waits for the underlying navigation');
  pendingNavigation.resolve();
  await nextTurn();
  assert.match(results.find(({ id }) => id === 50).result.content[0].text, /\/after-navigation/);

  pendingNavigation = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 51, name: 'navigate', args: { tabId: phone, url: 'https://example.com/late-navigation' } });
  await nextTurn();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 51).result.content[0].text, /didn’t answer navigate within 60s/);
  t.mock.timers.tick(59_999);
  port.onMessage.emit({ type: 'tool', id: 52, name: 'read_page', args: { tabId: phone } });
  await nextTurn();
  assert.equal(results.some(({ id }) => id === 52), false, 'the next tool still waits during navigation recovery');
  t.mock.timers.tick(1);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 52)?.result.content[0].text ?? '', /Chrome is still finishing a previous navigation/);
  assert.equal(tab.url, destination, 'the old navigation is still pending');
  disableRuntime.resolve();
  t.mock.timers.tick(120_000);
  await nextTurn();
  assert.equal(host.agentTabsInUse().has(tab.id), false, 'an unresolved navigation does not retain the idle debugger');
  pendingNavigation.resolve();
  await nextTurn();
  port.onMessage.emit({ type: 'tool', id: 53, name: 'read_page', args: { tabId: phone } });
  await nextTurn();
  t.mock.timers.tick(100);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 53)?.result.content[0].text ?? '', /\/late-navigation/);

  pendingTabRead = new Promise(() => {});
  port.onMessage.emit({ type: 'tool', id: 54, name: 'wait_for', args: { tabId: phone, timeoutMs: 100 } });
  await nextTurn();
  t.mock.timers.tick(99);
  await nextTurn();
  assert.equal(results.some(({ id }) => id === 54), false);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.match(results.find(({ id }) => id === 54).result.content[0].text, /Timed out after 100ms/);
  pendingTabRead = undefined;
  evaluationError = 'Invalid selector';
  port.onMessage.emit({ type: 'tool', id: 55, name: 'wait_for', args: { tabId: phone, selector: '[', timeoutMs: 100 } });
  await nextTurn();
  assert.match(results.find(({ id }) => id === 55).result.content[0].text, /Invalid selector/);
  evaluationError = undefined;

  keyUp = undefined;
  inputFailures.set('rawKeyDown', 'Press failed');
  inputFailures.set('keyUp', 'Release failed');
  port.onMessage.emit({ type: 'tool', id: 56, name: 'press_key', args: { tabId: phone, key: 'Escape' } });
  await nextTurn();
  assert.deepEqual(calls.slice(-2), [['rawKeyDown'], ['keyUp']]);
  assert.match(results.find(({ id }) => id === 56).result.content[0].text, /Press failed/);
  inputFailures.delete('rawKeyDown');
  port.onMessage.emit({ type: 'tool', id: 57, name: 'press_key', args: { tabId: phone, key: 'Escape' } });
  await nextTurn();
  assert.match(results.find(({ id }) => id === 57).result.content[0].text, /Release failed/);
  inputFailures.clear();

  inputFailures.set('rawKeyDown', 'Press failed before release stalled');
  keyUp = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 101, name: 'press_key', args: { tabId: phone, key: 'Escape' } });
  await nextTurn();
  assert.deepEqual(calls.slice(-2), [['rawKeyDown'], ['keyUp']]);
  assert.match(results.find(({ id }) => id === 101)?.result.content[0].text ?? '', /Press failed before release stalled/);
  port.onMessage.emit({ type: 'tool', id: 102, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  assert.equal(results.some(({ id }) => id === 102), false, 'the failed press keeps the tab locked while release is pending');
  keyUp.reject(new Error('Late release failure'));
  keyUp = undefined;
  inputFailures.clear();
  await nextTurn();
  assert.ok(results.some(({ id, result }) => id === 102 && !result.isError));

  readPending = Promise.withResolvers();
  detachPending = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 58, name: 'evaluate', args: { tabId: phone, expression: 'fixture' } });
  await nextTurn();
  for (const _ of [1, 2]) {
    t.mock.timers.tick(60_000);
    await nextTurn();
  }
  assert.match(results.find(({ id }) => id === 58).result.content[0].text, /didn’t answer evaluate within 60s/);
  assert.deepEqual(calls.at(-1), ['detach', tab.id]);
  port.onMessage.emit({ type: 'tool', id: 59, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  assert.match(results.find(({ id }) => id === 59)?.result.content[0].text ?? '', /has not confirmed the debugger reset/);
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.deepEqual(calls.at(-1), ['detach', tab.id], 'the agent cannot reattach before reset is confirmed');
  detachPending.resolve();
  readPending = undefined;
  await nextTurn();
  port.onMessage.emit({ type: 'tool', id: 60, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  t.mock.timers.tick(100);
  await nextTurn();
  assert.ok(results.some(({ id, result }) => id === 60 && !result.isError), 'a later tool can use a confirmed replacement session');

  store.togglePin(phone);
  readPending = Promise.withResolvers();
  port.onMessage.emit({ type: 'tool', id: 43, name: 'read_page', args: { tabId: phone } });
  await nextTurn();
  port.onMessage.emit({ type: 'tool', id: 44, name: 'console_logs', args: { tabId: phone } });
  await nextTurn();
  port.onMessage.emit({ type: 'tool', id: 45, name: 'close_tab', args: { tabId: phone } });
  await nextTurn();
  assert.ok(store.state.tabs[phone], 'unloading a pinned tab preserves its saved link');
  readPending.resolve();
  await nextTurn();
  assert.match(results.find(({ id }) => id === 44).result.content[0].text, /closed before the tool could run/);
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

test('debugger cleanup keeps a replacement holder and waits for an incomplete attach before resetting', async (t) => {
  const setup = Promise.withResolvers();
  const detached = [];
  globalThis.chrome = { debugger: {
    onDetach: event(),
    attach: async ({ tabId }) => { if (tabId === 13) await setup.promise; },
    detach: async ({ tabId }) => { detached.push(tabId); },
  } };
  t.after(() => delete globalThis.chrome);
  const { hold, release, resetDebugger } = await loadModule('chromium/shell/features/debuggee.ts');
  assert.equal(await hold(12, 'agent'), true);
  assert.equal(await hold(12, 'responsive'), true);
  const cleanup = Promise.withResolvers();
  const releasing = release(12, 'agent', () => cleanup.promise);
  await release(12, 'agent');
  assert.equal(await hold(12, 'agent'), true);
  cleanup.resolve();
  await releasing;
  await release(12, 'responsive');
  assert.deepEqual(detached, [], 'shared cleanup leaves a replacement lease attached');
  await release(12, 'agent');
  assert.deepEqual(detached, [12]);

  assert.equal(await hold(14, 'agent'), true);
  assert.equal(await hold(14, 'responsive'), true);
  const renewalCleanup = Promise.withResolvers();
  const leaving = release(14, 'agent', () => renewalCleanup.promise);
  const renewed = t.mock.fn();
  const renewing = hold(14, 'agent').then(renewed);
  await nextTurn();
  assert.equal(renewed.mock.callCount(), 0);
  renewalCleanup.resolve();
  await Promise.all([leaving, renewing]);
  await release(14, 'responsive');
  assert.deepEqual(detached, [12], 'releasing the other owner does not detach the renewed claim');
  await release(14, 'agent');
  assert.deepEqual(detached, [12, 14]);

  const attaching = hold(13, 'agent');
  await nextTurn();
  const reset = resetDebugger(13, 'agent');
  await nextTurn();
  assert.deepEqual(detached, [12, 14]);
  setup.resolve();
  await Promise.all([attaching, reset]);
  assert.deepEqual(detached, [12, 14, 13], 'the reset closes the session created by the pending attach');
});

test('canceling a debugger attachment invalidates reacquisition queued behind shared cleanup', async (t) => {
  const onDetach = event();
  const attach = t.mock.fn(async () => {});
  globalThis.chrome = { debugger: { onDetach, attach, detach: async () => {} } };
  t.after(() => delete globalThis.chrome);
  const { hold, release } = await loadModule('chromium/shell/features/debuggee.ts', { fresh: true });
  assert.equal(await hold(12, 'agent'), true);
  assert.equal(await hold(12, 'responsive'), true);
  const cleanup = Promise.withResolvers();
  const leaving = release(12, 'agent', () => cleanup.promise);
  const renewing = hold(12, 'agent');
  onDetach.emit({ tabId: 12 }, 'canceled_by_user');
  cleanup.resolve();
  await leaving;
  assert.equal(await renewing, false);
  assert.equal(attach.mock.callCount(), 1);
  assert.equal(await hold(12, 'agent'), true);
  assert.equal(attach.mock.callCount(), 2);
});

test('the responsive split keeps the phone viewport width when the window grows', async () => {
  const { phoneSplitRatio, PHONE_WIDTH } = await loadModule('chromium/shell/lib/responsiveViewport.ts');
  for (const total of [800, 1200, 3760, 5000]) {
    const phoneWidth = total * (1 - phoneSplitRatio(total));
    assert.ok(Math.abs(phoneWidth - PHONE_WIDTH) < 1, 'split ratio rounds within a CSS pixel');
  }
});

test('resetting responsive emulation does not reload the new debugger session', async (t) => {
  const onDetach = event();
  const oldTab = Promise.withResolvers();
  const get = t.mock.fn(() => oldTab.promise);
  const methods = [];
  globalThis.chrome = {
    debugger: {
      onDetach, attach: async () => {}, detach: async () => {},
      sendCommand: async (_target, method) => { methods.push(method); },
    },
    tabs: { get, onRemoved: event() },
  };
  t.after(() => delete globalThis.chrome);
  const { responsive } = await loadModule('chromium/shell/features/responsive.ts');
  responsive({ store: { state: { tabs: { phone: { device: 'mobile' } }, windows: [] } }, liveTabId: () => 12 }).sync();
  await nextTurn();
  assert.equal(get.mock.callCount(), 1);
  onDetach.emit({ tabId: 12 }, 'reset');
  await nextTurn();
  oldTab.resolve({ url: 'https://example.com/phone' });
  await nextTurn();
  assert.equal(methods.filter((method) => method === 'Emulation.setDeviceMetricsOverride').length, 2);
  assert.equal(methods.includes('Page.reload'), false);
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
