/** Which tabs get the console error badge, and how Settings' text becomes host patterns. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostMatches, parseHostPatterns, showsErrorBadge } from '../lib/consoleBadge.ts';

test('only local pages get a badge', () => {
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:8080/x', 'http://[::1]:5173/', 'https://app.test/', 'https://nas.local/', 'http://my.localhost/']) {
    assert.equal(showsErrorBadge(url), true, url);
  }
  for (const url of ['https://example.com/', 'https://local.example.com/', 'https://contest/', 'about:blank', 'not a url']) {
    assert.equal(showsErrorBadge(url), false, url);
  }
});

test('hidden hosts lose the badge', () => {
  assert.equal(showsErrorBadge('https://nas.local/admin', ['*.local']), false);
  assert.equal(showsErrorBadge('https://NAS.local/', ['nas.local']), false);
  assert.equal(showsErrorBadge('https://nas.local:8443/', ['nas.local']), false);
  assert.equal(showsErrorBadge('https://other.local/', ['nas.local']), true);
  assert.equal(showsErrorBadge('http://localhost:3000/', ['*.local']), true);
  assert.equal(showsErrorBadge('http://localhost:3000/', ['localhost']), false);
});

test('a pattern matches the whole host, with * for any run of characters', () => {
  assert.equal(hostMatches('a.b.local', '*.local'), true);
  assert.equal(hostMatches('local', '*.local'), false);
  assert.equal(hostMatches('nasxlocal', 'nas.local'), false);
  assert.equal(hostMatches('my-nas.local', 'nas.local'), false);
  assert.equal(hostMatches('start-9.local', 'start-*.local'), true);
  assert.equal(hostMatches('[::1]', '[::1]'), true);
});

test("Settings' text becomes patterns", () => {
  assert.deepEqual(parseHostPatterns('*.local\n  NAS.test , router.local\n\n*.local'), ['*.local', 'nas.test', 'router.local']);
  assert.deepEqual(parseHostPatterns('https://nas.local:8443/admin?x=1 localhost:3000'), ['nas.local', 'localhost']);
  assert.deepEqual(parseHostPatterns('(a+)+$ <script>'), []);
  assert.deepEqual(parseHostPatterns(''), []);
});
