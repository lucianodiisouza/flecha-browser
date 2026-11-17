import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

function event() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.forEach((listener) => listener(...args)),
  };
}

test('a worker restart rejects lost replies and the next connection resumes shell messages', async (t) => {
  const ports = [];
  t.mock.method(globalThis, 'setInterval', () => undefined);
  globalThis.chrome = { runtime: { connect() {
    const sent = [];
    const port = { sent, onDisconnect: event(), onMessage: event(), postMessage: (message) => sent.push(message) };
    ports.push(port);
    return port;
  } } };
  t.after(() => delete globalThis.chrome);
  const { invoke, on } = await loadModule('chromium/shell/client.ts');
  const received = [];
  on('state', (state) => received.push(state));
  const pending = invoke('beforeRestart');
  const rejected = assert.rejects(pending, /background restarted/);
  ports[0].onDisconnect.emit();
  await rejected;

  const next = invoke('afterRestart');
  assert.equal(ports.length, 2);
  ports[0].onMessage.emit({ type: 'event', name: 'state', args: ['old'] });
  ports[1].onMessage.emit({ type: 'event', name: 'state', args: ['new'] });
  ports[1].onMessage.emit({ type: 'result', id: ports[1].sent[0].id, value: 'ok' });
  assert.equal(await next, 'ok');
  assert.deepEqual(received, ['new']);
  assert.deepEqual(ports.map((port) => port.sent.map(({ name }) => name)), [['beforeRestart'], ['afterRestart']]);
});

test('agent work shares the responsive debugger and releasing the agent keeps the phone attached', async (t) => {
  const calls = [];
  globalThis.chrome = { debugger: {
    onDetach: event(),
    attach: async ({ tabId }) => calls.push(['attach', tabId]),
    detach: async ({ tabId }) => calls.push(['detach', tabId]),
  } };
  t.after(() => delete globalThis.chrome);
  const { acquire, hold, release } = await loadModule('chromium/shell/features/debuggee.ts');
  const [phone] = await Promise.all([hold(1, 'responsive'), acquire(1, 'agent')]);
  assert.equal(phone, true);
  await release(1, 'agent');
  assert.deepEqual(calls, [['attach', 1]]);
  await release(1, 'responsive');
  assert.deepEqual(calls, [['attach', 1], ['detach', 1]]);
});

test('the responsive split keeps the phone viewport width when the window grows', async () => {
  const { phoneSplitRatio, PHONE_WIDTH } = await loadModule('chromium/shell/lib/responsiveViewport.ts');
  for (const total of [800, 1200]) {
    const phoneWidth = total * (1 - phoneSplitRatio(total));
    assert.ok(Math.abs(phoneWidth - PHONE_WIDTH) < 1, 'split ratio rounds within a CSS pixel');
  }
});
