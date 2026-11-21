import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { bundle, sidebarInstrument, waitForBrowserProcesses } from './perf-bench.mjs';

test('the benchmark CLI prints usage without TypeScript flags', () => {
  const stdout = execFileSync(process.execPath, ['chromium/tests/perf-bench.mjs', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.match(stdout, /^Usage: node chromium\/tests\/perf-bench\.mjs --chrome /);
});

test('the benchmark uses legacy snapshots or sidebar deltas according to the bundled worker', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-perf-shell-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: '1', background: { service_worker: 'worker.js' } }));
  await fs.writeFile(path.join(root, 'shell.css'), '.shell{}');
  await fs.writeFile(path.join(root, 'other.js'), 'chrome.runtime.connect({name:"flecha-sidebar"});');

  for (const statePort of ['flecha', 'flecha-sidebar']) {
    await fs.writeFile(path.join(root, 'worker.js'), `chrome.runtime.onConnect.addListener(port => { if (port.name !== "${statePort}") return; });`);
    const shell = await bundle(root);
    let receive;
    const connect = [];
    const messages = [];
    const context = { chrome: { runtime: { connect({ name }) {
      connect.push(name);
      return {
        onMessage: { addListener: listener => { receive = listener; } },
        postMessage: message => messages.push(message),
      };
    } } } };
    runInNewContext(sidebarInstrument(shell.statePort), context);
    assert.deepEqual(connect, [statePort]);
    assert.equal(messages[0]?.name, 'ready');
    const rpc = context.perfBench.rpc('activate', 'next');
    receive({ type: 'result', id: messages[1].id, value: 'acknowledged' });
    assert.equal(await rpc, 'acknowledged');

    const emit = (name, value) => receive({ type: 'event', name, args: [value] });
    const wait = context.perfBench.wait(state => state.activeSpaceId === 'next');
    emit('state', { activeSpaceId: 'initial', tint: 'blue', environment: 'old', tabs: { old: { title: 'Old' } } });
    if (statePort === 'flecha-sidebar') {
      emit('state-update', { fields: { activeSpaceId: 'next' }, cleared: ['environment'], tabs: { next: { title: 'Next' } }, removed: ['old'] });
    } else {
      emit('state', { activeSpaceId: 'next', tint: 'blue', tabs: { next: { title: 'Next' } } });
    }
    assert.deepEqual(structuredClone(await wait), { activeSpaceId: 'next', tint: 'blue', tabs: { next: { title: 'Next' } } });
  }
});

test('process cleanup reports the remaining PIDs when its deadline expires during a scan', async () => {
  const deadline = new AbortController();
  const scanning = Promise.withResolvers();
  const cleanup = waitForBrowserProcesses([41, 42], () => scanning.promise, deadline.signal);
  deadline.abort(new Error('Cleanup deadline reached'));
  await assert.rejects(cleanup, /Last observed PIDs: 41, 42/);
  scanning.resolve([]);
  await waitForBrowserProcesses([41, 42], async () => []);
});
