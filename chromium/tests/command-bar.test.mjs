// The command bar's one ranked list, as Arc's Command Bar orders it, and its inline autocomplete.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

const { displayUrl, historyQuery, inlineCompletion, matchQuality, rank, score } = await loadModule('chromium/shell/lib/commandBar.ts');
const { SEARCH_ENGINES, resolveInput, webAddress } = await loadModule('chromium/shell/lib/url.ts');
const { describe, formatTargets, parseTargets } = await loadModule('chromium/shell/lib/environments.ts');
const { decodeState } = await loadModule('chromium/shared/savedState.ts');
const { Store } = await loadModule('chromium/shared/store.ts');
const { suggestable } = await loadModule('chromium/shell/lib/suggest.ts');
const { devSuggestions } = await loadModule('chromium/shell/ui/devCommands.ts');

test('typed development addresses open directly and environment badges follow explicit labels', () => {
  for (const address of ['192.168.0.10:3000/docs', 'app.localhost:3030', '0.0.0.0:8000', '[::1]:8080']) {
    assert.equal(resolveInput(address), `http://${address}`);
  }
  assert.equal(webAddress('mailto:dev@example.com'), 'mailto:dev@example.com');
  assert.equal(resolveInput('localhost:3000/my notes'), 'http://localhost:3000/my%20notes');
  assert.equal(resolveInput('localhost:443/my notes'), 'http://localhost:443/my%20notes');
  assert.equal(resolveInput('[0:0:0:0:0:0:0:1]:8080'), 'http://[0:0:0:0:0:0:0:1]:8080');
  assert.equal(resolveInput('203.0.113.9:3000'), 'https://203.0.113.9:3000');
  assert.equal(resolveInput('[fd00::1]:8443'), 'https://[fd00::1]:8443');
  for (const address of ['例子.中国', 'xn--fsqu00a.xn--fiqs8s']) assert.equal(resolveInput(address), `https://${address}`);
  for (const credentialed of [
    'test-user:fixture-password@example.com/private',
    'test-user:two words@example.com',
    'test-token@example.com/private',
    'test-token@example.com',
  ]) {
    assert.equal(resolveInput(credentialed), 'about:blank');
    assert.equal(suggestable(credentialed), false);
  }
  for (const broken of ['300.10.0.1', '192.168.1.010:3000', 'localhost: 3000', 'localhost:65536', 'localhost:3000@example.com']) {
    assert.equal(webAddress(broken), undefined, broken);
  }
  for (const malformed of [
    'localhost:65536/api?token=fixture',
    '%65xample%2ecom:65536/api?token=fixture',
    '%ZZxample%2ecom:65536/api?token=fixture',
    '[::gg]:80/api?token=fixture',
    'staging:65536/api?token=fixture',
  ]) {
    assert.equal(resolveInput(malformed), 'about:blank');
    assert.equal(suggestable(malformed), false);
  }
  assert.equal(suggestable('re: meet @ noon'), true);
  assert.match(resolveInput('re: meet @ noon'), /[?&]q=re%3A%20meet%20%40%20noon/);
  assert.equal(resolveInput('node.js: tutorial'), 'https://www.google.com/search?q=node.js%3A%20tutorial');
  assert.equal(suggestable('node.js: tutorial'), true);
  assert.match(resolveInput('mailto: vs tel: links'), /[?&]q=mailto%3A%20vs%20tel%3A%20links/);
  assert.equal(resolveInput('mailto:?subject=Hello'), 'mailto:?subject=Hello');
  assert.equal(new URL(resolveInput('%65xample.com/docs')).href, 'https://example.com/docs');
  const targets = parseTargets('prod https://staging.example.com\napp.localhost:3030\nflecha.dev\nlatest.example.com\n[::1]:8080\n0.0.0.0:8000\nstaging2.example.com\nqa01.example.com');
  const envs = [{ id: 'project', name: 'Project', targets }];
  assert.deepEqual(targets.map(({ origin }) => origin), ['https://staging.example.com', 'http://app.localhost:3030', 'https://flecha.dev', 'https://latest.example.com', 'http://[::1]:8080', 'http://0.0.0.0:8000', 'https://staging2.example.com', 'https://qa01.example.com']);
  assert.deepEqual(targets.map(({ origin }) => describe(origin, envs).tone), ['production', 'local', 'production', 'production', 'local', 'local', 'staging', 'staging']);
  assert.deepEqual(parseTargets('203.0.113.9:3000\n192.168.1.010:3000\ntel:1234\nssh:22\nInternal intranet'), [
    { label: '203.0.113.9:3000', origin: 'https://203.0.113.9:3000', autoLabel: true },
    { label: 'Internal', origin: 'https://intranet', autoLabel: false },
  ]);
  const extra = parseTargets('[fd00::1]:8443\nstaging:8443\nlocalhost-tools.example.com\nexample.test.com\napp.local');
  assert.deepEqual(extra.map(({ origin }) => origin), [
    'https://[fd00::1]:8443', 'https://staging:8443', 'https://localhost-tools.example.com', 'https://example.test.com', 'https://app.local',
  ]);
  assert.deepEqual(extra.map(({ origin }) => describe(origin, [{ id: 'extra', name: 'Extra', targets: extra }]).tone),
    ['production', 'staging', 'production', 'production', 'local']);
  const qualified = parseTargets('3d-staging:8443\nbuild.internal.:8443\nstaging.example.com.\nhttp://localhost.:3000\nwww.qa.co.uk\n[0:0:0:0:0:0:0:1]:8080');
  assert.deepEqual(qualified.map(({ origin }) => origin), [
    'https://3d-staging:8443', 'https://build.internal.:8443', 'https://staging.example.com.',
    'http://localhost.:3000', 'https://www.qa.co.uk', 'http://[::1]:8080',
  ]);
  assert.deepEqual(qualified.map(({ origin }) => describe(origin, [{ id: 'qualified', name: 'Qualified', targets: qualified }]).tone),
    ['staging', 'production', 'staging', 'local', 'production', 'local']);
  const text = 'Local http://local\nhttps://staging.example.de\nhttps://qa.appspot.com\nhttps://qa.project.appspot.com';
  const projects = parseTargets(text);
  assert.equal(formatTargets(projects), text);
  assert.deepEqual(projects.map(({ origin }) => describe(origin, [{ id: 'projects', name: 'Projects', targets: projects }]).tone),
    ['local', 'staging', 'production', 'staging']);
  const labels = parseTargets('QA_US https://example.com\nPROD_US https://staging.example.com');
  assert.deepEqual(labels.map(({ origin }) => describe(origin, [{ id: 'labels', name: 'Labels', targets: labels }]).tone), ['staging', 'production']);
});

test('saved environment targets preserve explicit and legacy labels', () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  const state = JSON.parse(store.serialize());
  state.environments = [{ id: 'project', name: 'Project', targets: [
    ...parseTargets('qa.example.com https://qa.example.com'),
    { label: 'QA.EXAMPLE.COM', origin: 'https://qa.example.com' },
    { label: 'example.com', origin: 'https://example.com' },
    { label: 'prod', origin: 'https://staging.example.com', autoLabel: 'false' },
  ] }];
  const [project] = decodeState(JSON.stringify(state)).environments;
  assert.equal(project.targets[3].autoLabel, undefined);
  assert.equal(formatTargets(project.targets), 'qa.example.com https://qa.example.com\nQA.EXAMPLE.COM https://qa.example.com\nhttps://example.com\nprod https://staging.example.com');
  assert.equal(describe('https://staging.example.com', [project]).tone, 'production');
});

test('developer command lookup ignores inherited properties and decodes UTF-8 JWTs', () => {
  assert.deepEqual(devSuggestions('constructor hello'), []);
  assert.deepEqual(devSuggestions('__proto__ hello'), []);
  const header = { alg: 'none' };
  const payload = { sub: 'räksmörgås' };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const [suggestion] = devSuggestions(`${encode(header)}.${encode(payload)}.`);
  assert.deepEqual(JSON.parse(suggestion.copy), { header, payload });
  const malformed = Buffer.from('{"sub":"\xff"}', 'latin1').toString('base64url');
  assert.deepEqual(devSuggestions(`${encode(header)}.${malformed}.`), []);
});

const result = (label, kind, match, extra = {}) => ({ label, score: score(kind, match), ...extra });
const labels = (results) => rank(results).map((r) => r.label);

test('what is typed matches the start of a text, the start of its words, or anywhere in it', () => {
  assert.equal(matchQuality('georg', 'georgia okeeffe'), 'start');
  assert.equal(matchQuality('okee', 'georgia okeeffe'), 'word');
  assert.equal(matchQuality('pin geo', 'Pin to Georgia'), 'word');
  assert.equal(matchQuality('effe', 'georgia okeeffe'), 'contains');
  assert.equal(matchQuality('xyz', 'georgia okeeffe', 'example.org'), undefined);
  assert.equal(matchQuality('  ', 'anything'), undefined);
  assert.equal(matchQuality('EXAM', 'Title', 'example.org/a'), 'start');
});

test('a tab or action that starts with the query comes before the typed search, and suggestions after it', () => {
  // "georg" in Arc's demo: the tab, an action, the search, then looser matches.
  const ranked = labels([
    result('georg', 'search'),
    result('georg one', 'suggestion'),
    result('Museum — Georgia O’Keeffe', 'tab', 'word', { url: 'https://museum.example/' }),
    result('georgia okeeffe', 'tab', 'start', { url: 'https://g.example/' }),
    result('Georgia history', 'history', 'start', { url: 'https://h.example/' }),
    result('Pin to Georgia', 'action', 'start'),
  ]);
  assert.deepEqual(ranked, ['Pin to Georgia', 'georgia okeeffe', 'georg', 'Museum — Georgia O’Keeffe', 'Georgia history', 'georg one']);
});

test('with nothing better, the typed search is the top hit', () => {
  const ranked = labels([result('weather', 'search'), result('weather radar', 'suggestion'), result('Weather — smhi.se', 'history', 'contains', { url: 'https://smhi.se/' })]);
  assert.deepEqual(ranked, ['weather', 'weather radar', 'Weather — smhi.se']);
});

test('the page the address completes to is the top hit, and an open tab beats its own history entry', () => {
  const ranked = rank([
    result('1pass', 'search'),
    result('1Password — history', 'history', 'start', { url: 'https://1password.com/' }),
    result('1password.com', 'completion', undefined, { url: 'https://1password.com/' }),
    result('Import — support', 'history', 'word', { url: 'https://support.1password.com/import' }),
  ]);
  assert.deepEqual(
    ranked.map((r) => r.label),
    ['1password.com', '1pass', 'Import — support'],
  );
});

test('equal results go to the most recently used, then keep their order', () => {
  const ranked = labels([
    result('old', 'tab', 'start', { recency: 1, url: 'https://a.example/' }),
    result('new', 'tab', 'start', { recency: 5, url: 'https://b.example/' }),
    result('first', 'suggestion'),
    result('second', 'suggestion'),
  ]);
  assert.deepEqual(ranked, ['new', 'old', 'first', 'second']);
});

test('loose matches of some kinds are not offered', () => {
  assert.equal(score('action', 'contains'), undefined);
  assert.equal(score('tab', undefined), undefined);
  assert.equal(score('search'), score('search', 'contains'));
});

test('rows show the address without scheme, www or a trailing slash', () => {
  assert.equal(displayUrl('https://www.github.com/foo/'), 'github.com/foo');
  assert.equal(displayUrl('https://example.org/'), 'example.org');
  assert.equal(displayUrl('http://localhost:3000/a?b=1'), 'localhost:3000/a?b=1');
  assert.equal(displayUrl('chrome://settings/'), 'chrome://settings/');
  assert.equal(displayUrl('not a url'), 'not a url');
});

test('a site name completes inline to the site, and a longer address to the page', () => {
  const visited = [
    { url: 'https://support.1password.com/import-safari/', title: 'Import from Safari', weight: 9 },
    { url: 'https://1password.com/', title: '1Password', weight: 2 },
    { url: 'https://1password.com/pricing', title: 'Pricing', weight: 7 },
  ];
  assert.deepEqual(inlineCompletion('1pass', visited), { text: '1password.com', url: 'https://1password.com/', title: '1Password' });
  assert.deepEqual(inlineCompletion('1password.com/p', visited), { text: '1password.com/pricing', url: 'https://1password.com/pricing', title: 'Pricing' });
  assert.deepEqual(inlineCompletion('supp', visited), { text: 'support.1password.com', url: 'https://support.1password.com/', title: undefined });
  // A site never visited at its front page still completes to the site, from the most used page.
  assert.equal(inlineCompletion('WWW.EXAM', [{ url: 'https://www.example.org/a' }]), undefined);
  assert.deepEqual(inlineCompletion('exam', [{ url: 'https://www.example.org/a' }]), { text: 'example.org', url: 'https://www.example.org/', title: undefined });
});

test('a partly typed address asks history for its first word, which whole-word search can find', () => {
  assert.equal(historyQuery('example.o'), 'example');
  assert.equal(historyQuery('github.com/fo'), 'github');
  assert.equal(historyQuery('my-site.dev'), 'my-site');
  assert.equal(historyQuery('weather'), 'weather');
  assert.equal(historyQuery('weather in stockholm'), 'weather in stockholm');
  assert.equal(historyQuery('://'), '://');
});

test('searches, finished addresses and other schemes are not completed', () => {
  const visited = [{ url: 'https://example.org/' }, { url: 'chrome://settings/' }, { url: 'file:///home/me/a.txt' }];
  assert.equal(inlineCompletion('exa mple', visited), undefined);
  assert.equal(inlineCompletion('example.org', visited), undefined);
  assert.equal(inlineCompletion('https://exa', visited), undefined);
  assert.equal(inlineCompletion('chrome', visited), undefined);
  assert.equal(inlineCompletion('', visited), undefined);
});

test('the command bar page may connect to every engine’s suggest address', async () => {
  const html = await readFile(new URL('../shell/ui/index.html', import.meta.url), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? '';
  const connect = csp.split(';').map((d) => d.trim().split(/\s+/)).find(([name]) => name === 'connect-src') ?? [];
  for (const [id, engine] of Object.entries(SEARCH_ENGINES)) assert.ok(connect.includes(new URL(engine.suggest).origin), id);
});
