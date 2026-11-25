/** Air Traffic Control: which Space a link from another app goes to. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, linkRuleSpace, normalizeMatch } from '../../shared/store.ts';

const rules = [
  { id: '1', match: 'github.com/anthropics', spaceId: 'work' },
  { id: '2', match: 'github.com', spaceId: 'code' },
  { id: '3', match: 'figma.com', spaceId: 'design' },
];

test('a host covers its subdomains, and a path narrows it', () => {
  assert.equal(linkRuleSpace(rules, 'https://github.com/anthropics/claude-code'), 'work');
  assert.equal(linkRuleSpace(rules, 'https://github.com/anthropics'), 'work');
  assert.equal(linkRuleSpace(rules, 'https://github.com/anthropicsx'), 'code');
  assert.equal(linkRuleSpace(rules, 'https://gist.github.com/x'), 'code');
  assert.equal(linkRuleSpace(rules, 'https://www.figma.com/file/1'), 'design');
  assert.equal(linkRuleSpace(rules, 'https://notgithub.com/'), undefined);
  assert.equal(linkRuleSpace(rules, 'mailto:a@b.c'), undefined);
});

test('rules are typed loosely and cleaned up', () => {
  assert.equal(normalizeMatch(' HTTPS://www.GitHub.com/Anthropics/ '), 'github.com/anthropics');
  const store = new Store({ load: () => undefined, save: () => undefined });
  const space = store.state.activeSpaceId;
  store.setLinkRules([
    { id: 'a', match: 'https://linear.app/', spaceId: space },
    { id: 'b', match: '  ', spaceId: space },
    { id: 'c', match: 'x.com', spaceId: 'gone' },
  ]);
  assert.deepEqual(store.state.linkRules, [{ id: 'a', match: 'linear.app', spaceId: space }]);
});

test('a link sent to another Space opens there and switches to it', () => {
  const store = new Store({ load: () => undefined, save: () => undefined });
  const view = store.attachView(store.createView({ resume: true }));
  const first = store.activeSpaceOf(view).id;
  const other = store.newSpace().id;
  const tab = store.addTab(view, 'https://linear.app/', { spaceId: other });
  assert.equal(view.activeSpaceId, other);
  assert.equal(store.state.activeSpaceId, other);
  assert.equal(store.locate(tab.id)?.space?.id, other);
  assert.notEqual(first, other);
});

test('reset sends pinned tabs home; the archive forgets one tab or all', () => {
  const store = new Store({ load: () => undefined, save: () => undefined });
  const view = store.attachView(store.createView({ resume: true }));
  const tab = store.addTab(view, 'https://a.test/');
  store.togglePin(view, tab.id);
  store.updateTab(tab.id, { url: 'https://a.test/elsewhere' });
  assert.deepEqual(store.resetPinned(view.activeSpaceId), [{ tabId: tab.id, url: 'https://a.test/' }]);
  assert.deepEqual(store.resetPinned(view.activeSpaceId), []);

  const gone = store.addTab(view, 'https://b.test/');
  store.closeTab(gone.id);
  const [item] = store.state.archive;
  assert.equal(item.url, 'https://b.test/');
  assert.equal(store.removeArchived(item.closedAt, item.url)?.url, 'https://b.test/');
  store.closeTab(store.addTab(view, 'https://c.test/').id);
  store.clearArchive();
  assert.deepEqual(store.state.archive, []);
});

test('a folder icon is one emoji, and empty removes it', () => {
  const store = new Store({ load: () => undefined, save: () => undefined });
  const view = store.attachView(store.createView({ resume: true }));
  const id = store.newFolder('Docs', { view })!;
  store.setFolderEmoji(id, ' 👩🏽‍💻 extra');
  const folder = () => store.activeSpaceOf(view).pinned.find((n) => n.kind === 'folder' && n.id === id) as { emoji?: string };
  assert.equal(folder().emoji, '👩🏽‍💻');
  store.setFolderEmoji(id, '');
  assert.equal(folder().emoji, undefined);
});
