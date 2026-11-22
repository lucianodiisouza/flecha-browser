import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { loadModule } from './load-module.mjs';

const { applyStateUpdate, changedFields, OpenTabSnapshot } = await loadModule('chromium/shell/stateUpdates.ts');
const { Store } = await loadModule('chromium/shared/store.ts');

test('a page receives only changed open tabs and fields, including removals across the JSON port', () => {
  const snapshot = new OpenTabSnapshot();
  const keys = new Map();
  const a = { id: 'a', title: 'A', favicon: 'old', history: { entries: [], index: 0 } };
  const b = { id: 'b', title: 'B' };
  const space = { name: 'One' };
  snapshot.update({ a, b });
  changedFields(keys, { spaces: [space], environment: 'local' }, true);
  const initial = JSON.parse(JSON.stringify({ tabs: snapshot.tabs, spaces: [space], environment: 'local' }));
  a.favicon = undefined;
  a.title = 'Updated';
  const dirty = new Set(['a', 'closed']);
  const metadata = snapshot.update({ a, closed: { id: 'closed' } }, dirty);
  assert.deepEqual(Object.keys(metadata.tabs), ['a']);
  assert.equal(Object.hasOwn(metadata.tabs.a, 'history'), false);
  const update = { ...metadata, ...changedFields(keys, { environment: undefined }, false) };
  const next = applyStateUpdate(initial, JSON.parse(JSON.stringify(update)));
  assert.equal(next.tabs.a.title, 'Updated');
  assert.equal(next.tabs.a.favicon, undefined);
  assert.equal(next.tabs.b, initial.tabs.b);
  assert.equal(initial.tabs.a.favicon, 'old');
  assert.equal(Object.hasOwn(next, 'environment'), false);
  assert.deepEqual(Object.keys(snapshot.update({ a }, dirty).tabs), []);
  space.name = 'Two';
  const structural = { ...snapshot.update({ a }), ...changedFields(keys, { spaces: [space] }, true) };
  assert.deepEqual(structural.removed, ['b']);
  assert.deepEqual(applyStateUpdate(next, structural).spaces, [{ name: 'Two' }]);
  assert.deepEqual(changedFields(keys, { spaces: [{ name: 'Two' }] }, true), { fields: {}, cleared: [] });
});

test('Today activation belongs to its owning window and a shared tab claim requests full reconciliation', () => {
  const store = new Store({ load: () => undefined, save() {} });
  const first = store.focusedWindowId;
  const second = store.openWindow().id;
  const tab = store.addTab('https://example.test', { windowId: first });
  const events = [];
  store.onChange((kind, detail) => events.push([kind, detail]));
  store.activate(tab.id, { windowId: second });
  assert.deepEqual(events.pop(), ['structure', { kind: 'activation', tabId: tab.id, windowId: first }]);
  store.updateTab(tab.id, { title: tab.title, audible: true });
  assert.deepEqual(events.pop(), ['tab', { kind: 'metadata', tabId: tab.id, keys: ['audible'] }]);
  store.updateTab(tab.id, { audible: true });
  assert.equal(events.length, 0);
  store.togglePin(tab.id, first);
  store.activate(tab.id, { windowId: second });
  assert.deepEqual(events.pop(), ['structure', undefined]);
  assert.equal(store.windowShowing(tab.id), second);
  store.saveNow();
});

test('interleaved full and sidebar width saves publish only durable state', async t => {
  const width = 320;
  const failure = new Error('Storage failed');

  for (const order of [['full', 'width'], ['width', 'full']]) {
    for (const failures of [[], ['full'], ['width'], ['full', 'width']]) {
      await t.test(`${order.join(' then ')}; rejects: ${failures.join(', ') || 'none'}`, async () => {
        const writes = [];
        const published = [];
        const store = new Store({
          load: () => undefined,
          save(json) {
            const write = Promise.withResolvers();

            writes.push({ width: JSON.parse(json).sidebarWidth, ...write });
            return write.promise;
          },
        });
        let durableWidth = store.state.sidebarWidth;

        store.onChange(() => published.push(store.state.sidebarWidth));

        const completions = order.map(kind => {
          const save = Promise.resolve(kind === 'full' ? store.saveNow() : store.setSidebarWidth(width));

          return save.then(
            value => ({ status: 'fulfilled', value }),
            reason => ({ status: 'rejected', reason }),
          );
        });

        for (const [index, kind] of order.entries()) {
          await setImmediate();
          assert.equal(writes.length, index + 1, 'only one write can be in flight');
          assert.equal(store.state.sidebarWidth, durableWidth);

          const write = writes[index];

          assert.equal(write.width, kind === 'width' ? width : durableWidth);
          if (failures.includes(kind)) {
            write.reject(failure);
          } else {
            durableWidth = write.width;
            write.resolve();
          }

          const outcome = await completions[index];

          if (failures.includes(kind)) {
            assert.deepEqual(outcome, { status: 'rejected', reason: failure });
          } else {
            assert.deepEqual(outcome, { status: 'fulfilled', value: kind === 'width' ? width : undefined });
          }
          assert.equal(store.state.sidebarWidth, durableWidth);
        }

        assert.deepEqual(published, failures.includes('width') ? [] : [width]);
      });
    }
  }
});
