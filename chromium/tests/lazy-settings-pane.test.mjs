import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

const { lazySettingsPane } = await loadModule('chromium/shell/ui/lazySettingsPane.ts');

function mockPane(t) {
  const classes = new Set();
  const alerts = new Set();
  const pane = {
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    prepend: node => alerts.add(node),
  };
  globalThis.document = { createElement: tagName => ({
    tagName,
    children: [],
    append(...children) { this.children.push(...children); },
    addEventListener(name, callback) { this[name] = callback; },
    setAttribute(name, value) { this[name] = value; },
    remove() { alerts.delete(this); },
  }) };
  t.mock.method(console, 'error', () => {});
  return { pane, classes, alerts };
}

test('a failed Settings import offers to reload the document', async t => {
  const { pane, classes, alerts } = mockPane(t);
  const reload = t.mock.fn();
  globalThis.location = { reload };
  const load = t.mock.fn(async () => { throw new Error('Import failed'); });
  const setup = t.mock.fn();
  const visit = lazySettingsPane(load, setup);
  const first = visit(pane, 'Tabs & Spaces');
  assert.equal(visit(pane, 'Tabs & Spaces'), first);
  await first;
  assert.ok(classes.has('pane-load-failed'));
  const [alert] = alerts;
  assert.equal(alert.role, 'alert');
  assert.equal(alert.textContent, 'Could not load Tabs & Spaces.');
  const [, button] = alert.children;
  assert.equal(button.tagName, 'button');
  assert.equal(button.textContent, 'Reload Settings');
  button.click();
  assert.equal(reload.mock.callCount(), 1);
  await visit(pane, 'Tabs & Spaces');
  assert.equal(load.mock.callCount(), 1);
  assert.equal(setup.mock.callCount(), 0);
});

test('a failed Settings setup can initialize on a later visit', async t => {
  const { pane, classes, alerts } = mockPane(t);
  const firstSetup = Promise.withResolvers();
  let attempts = 0;
  const visit = lazySettingsPane(async () => {}, async () => {
    attempts++;
    if (attempts === 1) await firstSetup.promise;
    if (attempts === 2) throw new Error('Setup failed');
  });
  const first = visit(pane, 'Tabs & Spaces');
  assert.equal(visit(pane, 'Tabs & Spaces'), first);
  firstSetup.reject(new Error('Setup failed'));
  await first;
  assert.ok(classes.has('pane-load-failed'));
  const [alert] = alerts;
  assert.equal(alert.role, 'alert');
  assert.equal(alert.textContent + alert.children.join(''),
    'Could not load Tabs & Spaces. Open another pane, then return to try again.');

  await visit(pane, 'Tabs & Spaces');
  assert.equal(alerts.size, 1);
  await visit(pane, 'Tabs & Spaces');
  assert.equal(alerts.size, 0);
  assert.equal(classes.size, 0);
  await visit(pane, 'Tabs & Spaces');
  assert.equal(attempts, 3);
});
