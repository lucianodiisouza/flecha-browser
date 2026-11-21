import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

const { keyedRows } = await loadModule('chromium/shell/ui/keyedRows.ts');

test('metadata patches retain row identity, reorders move existing nodes and removed keys are released', () => {
  const mutations = [];
  const parent = {
    children: [],
    get firstElementChild() { return this.children[0] ?? null; },
    insertBefore(row, cursor) {
      this.children.splice(cursor ? this.children.indexOf(cursor) : this.children.length, 0, row);
      row.parentElement = this;
      mutations.push(['insert', row.dataset.rowKey]);
    },
    moveBefore(row, cursor) {
      this.children.splice(this.children.indexOf(row), 1);
      this.children.splice(cursor ? this.children.indexOf(cursor) : this.children.length, 0, row);
      mutations.push(['move', row.dataset.rowKey]);
    },
  };
  const draw = entries => keyedRows(parent, use => {
    for (const [key, title] of entries) {
      const row = use(key, () => ({
        dataset: {}, parentElement: null,
        get nextElementSibling() { return parent.children[parent.children.indexOf(this) + 1] ?? null; },
        remove() { parent.children.splice(parent.children.indexOf(this), 1); mutations.push(['remove', key]); },
      }));
      row.title = title;
    }
  });
  draw([['a', 'One'], ['b', 'Two'], ['c', 'Three']]);
  const [a, b, c] = parent.children;
  mutations.length = 0;
  draw([['a', 'One'], ['b', 'Renamed'], ['c', 'Three']]);
  assert.equal(b.title, 'Renamed');
  assert.deepEqual(mutations, []);
  draw([['c', 'Three'], ['b', 'Renamed']]);
  assert.deepEqual(parent.children, [c, b]);
  assert.ok(!parent.children.includes(a));
  assert.deepEqual(mutations, [['remove', 'a'], ['move', 'c']]);
});
