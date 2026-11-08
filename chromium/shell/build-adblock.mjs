// Builds the ad blocker's rules into dist/rules: EasyList and EasyPrivacy as declarativeNetRequest
// static rulesets (easylist.json, easyprivacy.json), plus EasyList's generic element hiding as a
// stylesheet (cosmetic.css) and the sites exempt from it (cosmetic-exclude.json).
//
// The lists are downloaded once and kept in chromium/shell/.cache for a few days, so most builds
// are offline and quick. Without a network and a cache the rulesets come out empty (and the
// shell still loads). `node build-adblock.mjs --refresh` downloads them again.
//
// The converter covers the Adblock Plus syntax the lists actually use for network filters:
// `||host^`, `|` anchors, `*` and `^`, `@@` exceptions, and the options DNR has an equivalent
// for (resource types, third-party, domain=, match-case, document exceptions). Filters with
// anything else ($csp, $redirect, $removeparam, regular expressions…) are left out rather than
// approximated. Plain `||host^` filters are merged into requestDomains lists, which keeps the
// rule count far under Chromium's guaranteed 30,000 static rules.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const cacheDir = path.join(here, '.cache', 'adblock');
const MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

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

async function fetchList(id, url, refresh) {
  const file = path.join(cacheDir, `${id}.txt`);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat && !refresh && Date.now() - stat.mtimeMs < MAX_AGE_MS) return fs.readFileSync(file, 'utf8');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('[Adblock Plus')) throw new Error('not a filter list');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, text);
    return text;
  } catch (err) {
    if (stat) {
      console.warn(`adblock: couldn't refresh ${id} (${err.message}); using the cached copy`);
      return fs.readFileSync(file, 'utf8');
    }
    console.warn(`adblock: couldn't download ${id} (${err.message}); its ruleset is empty`);
    return '';
  }
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
export async function buildAdblock(out, { refresh = false } = {}) {
  const rulesDir = path.join(out, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  const hide = new Set();
  const hideExceptions = new Set();
  const exempt = new Set();
  let budget = RULE_BUDGET;
  const counts = {};

  for (const [id, url] of Object.entries(LISTS)) {
    const converted = convertList(await fetchList(id, url, refresh));
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
  // One rule per selector, so one Chromium doesn't know voids only itself. Not :is(), whose
  // selectors Chromium can't index by id or class: every element was matched against all of
  // them, which made style recalcs on news sites several times slower.
  // The :not() matches everything and adds the weight of three ids, so a page's own
  // `display: block !important` doesn't win back its ad (:is() lent each selector the weight
  // of the heaviest in its group, which varied).
  const selectors = [...hide].filter((s) => !hideExceptions.has(s) && !s.includes('{') && !s.includes('}'));
  const rules = selectors.map((s) => `${s}:not(#_f#_f#_f) { display: none !important; }`);
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
  await buildAdblock(path.join(here, 'dist'), { refresh: process.argv.includes('--refresh') });
}
