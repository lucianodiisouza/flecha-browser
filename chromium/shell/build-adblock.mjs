// Builds the ad blocker's rules into dist/rules: EasyList and EasyPrivacy as declarativeNetRequest
// static rulesets (easylist.json, easyprivacy.json), plus EasyList's generic element hiding as a
// stylesheet (cosmetic.css) and the sites exempt from it (cosmetic-exclude.json).
//
// The lists are downloaded once and kept in chromium/shell/.cache for a few days, so most builds
// are offline and quick. A failed download requires a usable cached copy of that list.
// `node build-adblock.mjs --refresh` downloads them again.
//
// The converter covers the Adblock Plus syntax the lists actually use for network filters:
// `||host^`, `|` anchors, `*` and `^`, `@@` exceptions, and the options DNR has an equivalent
// for (resource types, third-party, domain=, match-case, document exceptions). Filters with
// anything else ($csp, $redirect, $removeparam, regular expressions…) are left out rather than
// approximated. Plain `||host^` filters are merged into requestDomains lists, which keeps the
// rule count far under Chromium's guaranteed 30,000 static rules.
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { get } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';
import { writeManifest } from './build-version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '.cache', 'adblock');
const MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

export function adblockCacheBucket() {
  return Math.floor(Date.now() / MAX_AGE_MS);
}

export const LISTS = {
  easylist: 'https://easylist.to/easylist/easylist.txt',
  easyprivacy: 'https://easylist.to/easylist/easyprivacy.txt',
};

/** Chromium guarantees an extension this many enabled static rules (GUARANTEED_MINIMUM_STATIC_RULES). */
const RULE_BUDGET = 30000;
const DOMAINS_PER_RULE = 2000;

const TYPES = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  ping: 'ping',
  beacon: 'ping',
  media: 'media',
  font: 'font',
  websocket: 'websocket',
  other: 'other',
  css: 'stylesheet',
};
/** Options that don't change what's matched here. */
const IGNORED = new Set(['important', 'all', 'webrtc']);

const decompress = new Map([
  ['gzip', promisify(gunzip)],
  ['deflate', promisify(inflate)],
  ['br', promisify(brotliDecompress)],
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// https://fetch.spec.whatwg.org/#http-redirect-fetch
const MAX_REDIRECTS = 20;

function requestList(url, options) {
  return new Promise((resolve, reject) => get(url, options, resolve).once('error', reject));
}

async function downloadList(url, download, options) {
  for (let redirects = 0; ; redirects++) {
    options.signal.throwIfAborted();
    const res = await download(url, options);
    if (!REDIRECT_STATUSES.has(res.statusCode) || res.headers.location === undefined) return res;
    res.destroy();
    if (redirects === MAX_REDIRECTS) throw new Error('too many HTTP redirects');
    const target = new URL(res.headers.location, url);
    if (target.protocol !== 'https:') throw new Error('filter list redirect requires HTTPS');
    url = target.href;
  }
}

async function readWireBytes(res, length) {
  if (length !== undefined && !/^\d+$/.test(length)) {
    res.destroy();
    throw new Error('could not verify Content-Length');
  }
  const expected = length === undefined ? undefined : BigInt(length);
  const chunks = [];
  let received = 0;
  for await (const chunk of res) {
    received += chunk.byteLength;
    if (expected !== undefined && BigInt(received) > expected) {
      throw new Error('response exceeded Content-Length');
    }
    chunks.push(chunk);
  }
  if (expected !== undefined && BigInt(received) !== expected) throw new Error('could not verify Content-Length');
  return Buffer.concat(chunks, received);
}

function checkedText(id, bytes, requireChecksum = false) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!/^\[Adblock Plus(?: \d+(?:\.\d+)*)?\]\r?\n/.test(text)) throw new Error('not a filter list');
  if (!new RegExp('^! Title: ' + id + '\\r?$', 'mi').test(text)) throw new Error('wrong filter list title');
  const checksumLine = /^![ \t]*checksum[ \t]*:[^\r\n]*/im.exec(text);
  if (checksumLine) {
    // ABP addChecksum normalizes CR and blank lines and omits the checksum line.
    const normalized = text.replaceAll('\r', '').replace(/\n+/g, '\n').replace(/^![ \t]*checksum[ \t]*:[^\n]*\n?/im, '');
    const checksum = createHash('md5').update(normalized).digest('base64').replace(/=+$/, '');
    if (checksum !== checksumLine[0].split(':')[1].trim()) throw new Error('ABP checksum mismatch');
  } else if (requireChecksum) {
    throw new Error('filter list has no verifiable length, compression framing or ABP checksum');
  }
  for (const [line] of text.matchAll(/[^\r\n]+/g)) {
    if (convertList(line).rules.length) return text;
  }
  throw new Error('filter list contains no supported network rules');
}

async function fetchList(id, url, refresh, cache, download) {
  const file = path.join(cache, `${id}.txt`);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  const cached = () => checkedText(id, fs.readFileSync(file));
  if (stat && !refresh && Date.now() - stat.mtimeMs < MAX_AGE_MS) {
    try { return cached(); } catch (error) { console.warn(`adblock: invalid cached ${id}: ${error.message}`); }
  }
  let text;
  try {
    const res = await downloadList(url, download, { headers: { 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(30000) });
    if (res.statusCode !== 200) {
      res.destroy();
      throw new Error(`HTTP ${res.statusCode}`);
    }
    // Read the wire bytes. Strict zlib defaults require complete compression framing.
    const encoding = res.headers['content-encoding']?.trim().toLowerCase() ?? 'identity';
    const decode = decompress.get(encoding);
    if (encoding !== 'identity' && !decode) {
      res.destroy();
      throw new Error(`unsupported Content-Encoding: ${encoding}`);
    }
    const length = res.headers['content-length'];
    const bytes = await readWireBytes(res, length);
    text = checkedText(id, decode ? await decode(bytes) : bytes, !decode && length === undefined);
  } catch (err) {
    if (stat) {
      let fallback;
      try { fallback = cached(); } catch (cacheError) {
        throw new AggregateError([err, cacheError], `adblock: could not refresh ${id} (${err.message}); invalid cache (${cacheError.message})`);
      }
      console.warn(`adblock: couldn't refresh ${id} (${err.message}); using the cached copy`);
      return fallback;
    }
    throw new Error(`adblock: could not download ${id} and no cache exists`, { cause: err });
  }
  fs.mkdirSync(cache, { recursive: true });
  const temp = file + '.' + randomUUID();
  try {
    fs.writeFileSync(temp, text, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return text;
}

const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
const PLAIN_HOST = /^\|\|([a-z0-9-]+(?:\.[a-z0-9-]+)+)\^$/;

/** One network filter as a DNR rule without an id, or undefined when DNR can't say it. */
export function convertFilter(line) {
  let text = line;
  const exception = text.startsWith('@@');
  if (exception) text = text.slice(2);

  let options = [];
  const dollar = text.lastIndexOf('$');
  if (dollar >= 0 && /^[a-z~_-]+(=[^,]*)?(,[a-z~_-]+(=[^,]*)?)*$/i.test(text.slice(dollar + 1))) {
    options = text.slice(dollar + 1).split(',');
    text = text.slice(0, dollar);
  }
  // Regular expressions: Chromium allows only 1,000 and wants RE2; leave them out.
  if (text.startsWith('/') && text.endsWith('/') && text.length > 2) return undefined;
  // DNR takes `|` only as an anchor at either end.
  if (!isAscii(text) || text.startsWith('||*') || text.replace(/^\|\|?/, '').replace(/\|$/, '').includes('|')) return undefined;

  const condition = {};
  const types = [];
  const notTypes = [];
  let document = false;
  for (const raw of options) {
    const [name, value] = raw.split('=');
    const option = name.toLowerCase();
    const negated = option.startsWith('~');
    const key = negated ? option.slice(1) : option;
    if (TYPES[key]) (negated ? notTypes : types).push(TYPES[key]);
    else if (key === 'third-party' || key === '3p') condition.domainType = negated ? 'firstParty' : 'thirdParty';
    else if (key === 'first-party' || key === '1p') condition.domainType = negated ? 'thirdParty' : 'firstParty';
    else if (key === 'match-case' && !negated) condition.isUrlFilterCaseSensitive = true;
    else if (key === 'domain' && value) {
      const include = [];
      const exclude = [];
      for (const d of value.toLowerCase().split('|')) {
        const domain = d.replace(/^~/, '');
        // `example.*` has no DNR form; that domain is dropped.
        if (!domain || domain.includes('*') || !isAscii(domain)) continue;
        (d.startsWith('~') ? exclude : include).push(domain);
      }
      if (!include.length && value.split('|').some((d) => !d.startsWith('~'))) return undefined;
      if (include.length) condition.initiatorDomains = include;
      if (exclude.length) condition.excludedInitiatorDomains = exclude;
    } else if (key === 'document' && !negated) document = true;
    else if (IGNORED.has(key)) continue;
    else return undefined;
  }

  if (document && !exception) return undefined; // Blocking whole sites: not ours to do.
  if (document && (types.length || notTypes.length)) return undefined;

  const pattern = text;
  if (pattern && pattern !== '*') condition.urlFilter = pattern;
  else if (!condition.initiatorDomains) return undefined; // Would match everything.

  if (document) condition.resourceTypes = ['main_frame', 'sub_frame'];
  else if (types.length) condition.resourceTypes = [...new Set(types)];
  else if (notTypes.length) condition.excludedResourceTypes = [...new Set(notTypes)];

  const action = { type: document ? 'allowAllRequests' : exception ? 'allow' : 'block' };
  return { priority: exception ? (document ? 3 : 2) : 1, action, condition };
}

function convertList(text) {
  const rules = [];
  /** `||host^` filters with the same options, merged: key → { rule, domains }. */
  const merged = new Map();
  const genericHide = new Set();
  const hideExceptions = new Set();
  const exemptSites = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;

    // Element hiding: `##sel` everywhere, `site##sel` (skipped), `#@#sel` exceptions.
    const hide = line.match(/^([^#]*)#([@?$%]?)#(.+)$/);
    if (hide) {
      const [, domains, kind, selector] = hide;
      if (kind === '@') hideExceptions.add(selector);
      else if (kind === '' && !domains && !/:-abp-|:has-text|:contains\(|:xpath|:matches-|:upward|:remove/.test(selector)) genericHide.add(selector);
      continue;
    }

    // Sites EasyList exempts from element hiding.
    const exempt = line.match(/^@@\|\|([a-z0-9.-]+)\^\$(.+)$/i);
    if (exempt && exempt[2].split(',').some((o) => o === 'elemhide' || o === 'generichide' || o === 'ehide' || o === 'ghide')) {
      exemptSites.add(exempt[1].toLowerCase());
      continue;
    }

    const rule = convertFilter(line);
    if (!rule) continue;
    const host = rule.condition.urlFilter?.match(PLAIN_HOST)?.[1];
    if (host && !rule.condition.isUrlFilterCaseSensitive) {
      const { urlFilter, ...rest } = rule.condition;
      const key = JSON.stringify([rule.action, rule.priority, rest]);
      if (!merged.has(key)) merged.set(key, { rule: { ...rule, condition: rest }, domains: [] });
      merged.get(key).domains.push(host);
    } else rules.push(rule);
  }

  for (const { rule, domains } of merged.values()) {
    const unique = [...new Set(domains)].sort();
    for (let i = 0; i < unique.length; i += DOMAINS_PER_RULE) {
      rules.push({ ...rule, condition: { requestDomains: unique.slice(i, i + DOMAINS_PER_RULE), ...rule.condition } });
    }
  }
  return { rules, genericHide, hideExceptions, exemptSites };
}

/** Writes dist/rules. Exported for build.mjs; also runs on its own. */
export async function buildAdblock(out, { refresh = false, cache = cacheDir, download = requestList } = {}) {
  const rulesDir = path.join(out, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  const hide = new Set();
  const hideExceptions = new Set();
  const exempt = new Set();
  let budget = RULE_BUDGET;
  const counts = {};

  const lists = await Promise.all(Object.entries(LISTS).map(async ([id, url]) =>
    [id, await fetchList(id, url, refresh, cache, download)]));
  for (const [id, text] of lists) {
    const converted = convertList(text);
    // Exceptions first, so a list cut short for the budget never blocks what it meant to allow.
    const rules = converted.rules.sort((a, b) => b.priority - a.priority).slice(0, Math.max(0, budget));
    if (rules.length < converted.rules.length) console.warn(`adblock: ${id} cut to ${rules.length} of ${converted.rules.length} rules`);
    budget -= rules.length;
    rules.forEach((r, i) => (r.id = i + 1));
    fs.writeFileSync(path.join(rulesDir, `${id}.json`), JSON.stringify(rules));
    counts[id] = rules.length;
    for (const s of converted.genericHide) hide.add(s);
    for (const s of converted.hideExceptions) hideExceptions.add(s);
    for (const s of converted.exemptSites) exempt.add(s);
  }

  // Generic hiding, except selectors any site has an exception for: those need per-site rules.
  // One rule per selector: a selector Chromium doesn't know drops only its own rule, and Blink
  // files each rule under its id, class or tag. Inside :is() lists every selector was checked
  // against every element on each style recalc (perf findings, 2026-10-26).
  const selectors = [...hide].filter((s) => !hideExceptions.has(s) && !s.includes('{') && !s.includes('}'));
  const rules = selectors.map((s) => `${s} { display: none !important; }`);
  fs.writeFileSync(path.join(rulesDir, 'cosmetic.css'), `/* Generated from EasyList by build-adblock.mjs. */\n${rules.join('\n')}\n`);
  const excludeMatches = [...exempt].sort().flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
  fs.writeFileSync(path.join(rulesDir, 'cosmetic-exclude.json'), JSON.stringify(excludeMatches));

  console.log(
    `adblock: ${Object.entries(counts)
      .map(([id, n]) => `${id} ${n} rules`)
      .join(', ')}, ${selectors.length} hiding selectors`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.join(here, 'dist');
  // Rules alone aren't a shell; the full build (npm run shell:build) makes them too.
  const built = path.join(out, 'manifest.json');
  if (!fs.existsSync(built)) throw new Error(`No built shell in ${out}: run npm run shell:build.`);
  await buildAdblock(out, { refresh: process.argv.includes('--refresh') });
  // New rules are a new shell: without a new version Chromium keeps the rules it indexed. The
  // built manifest, not the source one, matches the rest of dist.
  writeManifest(built, out);
}
