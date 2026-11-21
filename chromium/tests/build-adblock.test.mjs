import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer, get } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { buildAdblock, LISTS } from '../shell/build-adblock.mjs';

function subscription(url, rules) {
  const title = url === LISTS.easylist ? 'EasyList' : 'EasyPrivacy';
  return `[Adblock Plus 2.0]\n! Title: ${title}\n${rules}\n`;
}

function response(body, headers = { 'content-length': String(Buffer.byteLength(body)) }) {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode: 200, headers });
}

test('cosmetic CSS keeps independent selectors, cross-list exceptions and site exclusions', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-cosmetic-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const list = '/network\n##.ad\n## .ad\n##.unsupported:unknown()\n##.remove-me\nsite.example##.domain-only\n@@||site.example^$generichide';
  const privacy = '/tracker\n##.ad\n##[data-text="two words"]\nsite.example#@#.remove-me';
  await buildAdblock(out, { cache: path.join(out, 'cache'), download: url =>
    response(subscription(url, url === LISTS.easylist ? list : privacy)) });
  assert.equal(await fs.readFile(path.join(out, 'rules/cosmetic.css'), 'utf8'),
    '.ad{display:none!important}\n.unsupported:unknown(){display:none!important}\n[data-text="two words"]{display:none!important}');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, 'rules/cosmetic-exclude.json'))),
    ['*://site.example/*', '*://*.site.example/*']);
});

test('malformed cosmetic selectors cannot consume the next rule', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-cosmetic-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const escaped = String.raw`:is([data-ad="escaped\" quote ] )"], .ad\[\()/* unmatched ' [ ( */`;
  const list = [
    '/network', `##${escaped}`, '##[data-ad="unterminated]', '##.ad/* unterminated',
    '##[data-ad=test', '##:is(.ad', '##.ad]', '##.ad)', '##:is([data-ad=test)]', '##.next-ad',
  ].join('\n');
  await buildAdblock(out, { cache: path.join(out, 'cache'), download: url =>
    response(subscription(url, url === LISTS.easylist ? list : '/tracker')) });
  assert.equal(await fs.readFile(path.join(out, 'rules/cosmetic.css'), 'utf8'),
    `${escaped}{display:none!important}\n.next-ad{display:none!important}`);
});

test('reverse download completion preserves EasyList priority, rule IDs and the shared budget', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-rules-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const cache = path.join(out, 'cache');
  const replies = new Map();
  const build = buildAdblock(out, { cache, download: url => new Promise(resolve => replies.set(url, resolve)) });
  assert.deepEqual([...replies.keys()], Object.values(LISTS));
  replies.get(LISTS.easyprivacy)(response(subscription(LISTS.easyprivacy, '/track-one\n@@/allow\n/track-two')));
  // Leave room for one EasyPrivacy rule under Chromium's 30,000-rule guarantee.
  replies.get(LISTS.easylist)(response(subscription(LISTS.easylist,
    Array.from({ length: 29999 }, (_, i) => '/advert-' + i).join('\n'))));
  await build;
  const rules = async name => JSON.parse(await fs.readFile(path.join(out, 'rules', name + '.json'), 'utf8'));
  const list = await rules('easylist');
  assert.equal(list.length, 29999);
  assert.equal(list.at(-1).id, list.length);
  assert.deepEqual(await rules('easyprivacy'),
    [{ priority: 2, action: { type: 'allow' }, condition: { urlFilter: '/allow' }, id: 1 }]);
});

test('failed refresh requires a cached list with supported network rules', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-rules-cache-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const cache = path.join(out, 'cache');
  const offline = () => { throw new Error('offline'); };
  await assert.rejects(buildAdblock(out, { cache, download: offline }), /no cache exists/);
  const list = url => subscription(url, url === LISTS.easylist ? '||ads.example^\n/banner' : '@@/allow');
  await buildAdblock(out, { cache, download: url => response(list(url)) });
  await buildAdblock(out, { cache, refresh: true, download: offline });
  const prefix = subscription(LISTS.easylist, '||ads.example^');
  for (const [invalid, cause] of [
    [() => response(prefix, {}), 'no verifiable length'],
    [() => response(prefix, { 'content-encoding': 'identity', 'content-length': String(Buffer.byteLength(list(LISTS.easylist))) }),
      'could not verify Content-Length'],
    [() => response(prefix.replace('! Title:', '! Checksum: invalid\n! Title:')), 'ABP checksum mismatch'],
  ]) {
    const warnings = t.mock.method(console, 'warn', () => {});
    await buildAdblock(out, { cache, refresh: true, download: url => url === LISTS.easylist ? invalid() : response(list(url)) });
    assert.ok(warnings.mock.calls.some(call => call.arguments[0].includes(cause) && call.arguments[0].includes('using the cached copy')));
    warnings.mock.restore();
    assert.equal(await fs.readFile(path.join(cache, 'easylist.txt'), 'utf8'), list(LISTS.easylist));
    assert.equal(JSON.parse(await fs.readFile(path.join(out, 'rules/easylist.json'))).length, 2);
  }
  await fs.writeFile(path.join(cache, 'easyprivacy.txt'), subscription(LISTS.easyprivacy, '! truncated'));
  const warnings = t.mock.method(console, 'warn', () => {});
  await assert.rejects(buildAdblock(out, { cache, download: offline }), error =>
    error instanceof AggregateError && error.message.includes('easyprivacy') && error.errors[0].message === 'offline' &&
    error.errors[1].message === 'filter list contains no supported network rules');
  assert.ok(!warnings.mock.calls.some(call => call.arguments[0].includes('using the cached copy')));
});

test('an ABP checksum validates normalized text without a length and identity verifies UTF-8 bytes', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-signed-rules-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const signed = '[Adblock Plus 2.0]\r\n! Checksum: z2RKQ5QVHnDHGokvvaKKdg\r\n! Title: EasyList\r\n\r\n||ads.example^\r\n';
  const cache = path.join(out, 'cache');
  await buildAdblock(out, { cache, download: (url, options) => {
    assert.equal(options.headers['Accept-Encoding'], 'gzip');
    return url === LISTS.easylist ? response(signed, {}) : response(subscription(url, '! précision\n@@/allow'));
  } });
  assert.equal(await fs.readFile(path.join(cache, 'easylist.txt'), 'utf8'), signed);
});

test('compressed wire data is decoded and a truncated gzip refresh retains the verified cache', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-compressed-rules-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const cache = path.join(out, 'cache');
  const original = url => subscription(url, '/old-rule');
  const compressed = (bytes, encoding) => response(bytes, { 'content-encoding': encoding, 'content-length': String(bytes.length) });
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
    await buildAdblock(out, { cache, refresh: true, download: url => compressed(compress(original(url)), encoding) });
    assert.equal(await fs.readFile(path.join(cache, 'easylist.txt'), 'utf8'), original(LISTS.easylist));
  }

  const truncated = url => compressed(gzipSync(subscription(url, '/new-rule')).subarray(0, -1), 'gzip');
  const warnings = t.mock.method(console, 'warn', () => {});
  await buildAdblock(out, { cache, refresh: true, download: truncated });
  assert.equal(warnings.mock.calls.length, Object.keys(LISTS).length);
  assert.ok(warnings.mock.calls.every(call => call.arguments[0].includes('unexpected end of file') &&
    call.arguments[0].includes('using the cached copy')));
  for (const [id, url] of Object.entries(LISTS)) {
    assert.equal(await fs.readFile(path.join(cache, id + '.txt'), 'utf8'), original(url));
    const [rule] = JSON.parse(await fs.readFile(path.join(out, 'rules', id + '.json'), 'utf8'));
    assert.equal(rule.condition.urlFilter, '/old-rule');
  }
  await assert.rejects(buildAdblock(out, { cache: path.join(out, 'empty-cache'), download: truncated }),
    error => error.cause?.code === 'Z_BUF_ERROR');
});

test('wire data exceeding Content-Length is rejected before reading more chunks', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-rules-length-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const download = () => Object.assign({
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('oversized chunk');
      assert.fail('must stop reading once Content-Length is exceeded');
    },
  }, { statusCode: 200, headers: { 'content-length': '1' } });
  await assert.rejects(buildAdblock(out, { cache: path.join(out, 'cache'), download }),
    error => error.cause?.message === 'response exceeded Content-Length');
});

test('a relative redirect reaches the local server and a partial refresh keeps the validated cache', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-rules-transport-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const cache = path.join(out, 'cache');
  const original = subscription(LISTS.easylist, '/cached-rule');
  const requests = [];
  let truncate = false;
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/easylist/easylist.txt') {
      res.writeHead(302, { Location: '../updates/easylist.txt' }).end();
    } else if (req.url === '/updates/easylist.txt' && truncate) {
      const partial = subscription(LISTS.easylist, '/partial-rule');
      const complete = partial + '/another-rule\n';
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(complete) });
      res.write(partial, () => res.destroy());
    } else {
      const body = req.url === '/updates/easylist.txt' ? original : subscription(LISTS.easyprivacy, '/privacy');
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(body) }).end(body);
    }
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const signals = new Map();
  // Route the HTTPS URLs to a local HTTP transport without relaxing redirect validation.
  const download = (url, options) => new Promise((resolve, reject) => {
    const { pathname } = new URL(url);
    signals.set(pathname, options.signal);
    get({ ...options, hostname: '127.0.0.1', port: server.address().port, path: pathname }, resolve).once('error', reject);
  });

  const file = path.join(cache, 'easylist.txt');
  await buildAdblock(out, { cache, download });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(signals.get('/easylist/easylist.txt'), signals.get('/updates/easylist.txt'));

  truncate = true;
  const warnings = t.mock.method(console, 'warn', () => {});
  await buildAdblock(out, { cache, refresh: true, download });
  assert.deepEqual(requests.filter(url => url.endsWith('/easylist.txt')), [
    '/easylist/easylist.txt', '/updates/easylist.txt', '/easylist/easylist.txt', '/updates/easylist.txt',
  ]);
  assert.equal(signals.get('/easylist/easylist.txt'), signals.get('/updates/easylist.txt'));
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), [
    "adblock: couldn't refresh easylist (aborted); using the cached copy",
  ]);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const [rule] = JSON.parse(await fs.readFile(path.join(out, 'rules/easylist.json'), 'utf8'));
  assert.equal(rule.condition.urlFilter, '/cached-rule');
});
