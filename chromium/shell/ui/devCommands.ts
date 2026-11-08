/**
 * Developer shortcuts for the command bar: `gh`, `npm`, `mdn`, `caniuse`, `so`, plus
 * pasted JWTs and Unix timestamps, which are decoded right in the bar.
 */
export interface DevSuggestion {
  label: string;
  sub: string;
  /** A page to open, or… */
  url?: string;
  /** …text to copy, shown as a preview under the results. */
  copy?: string;
}

const SEARCHES: Record<string, { name: string; url: (q: string) => string }> = {
  npm: {
    name: 'npm',
    url: (q) => (/^\S+$/.test(q) ? `https://www.npmjs.com/package/${q}` : `https://www.npmjs.com/search?q=${encodeURIComponent(q)}`),
  },
  mdn: { name: 'MDN', url: (q) => `https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(q)}` },
  caniuse: { name: 'Can I use', url: (q) => `https://caniuse.com/?search=${encodeURIComponent(q)}` },
  so: { name: 'Stack Overflow', url: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}` },
};

export function devSuggestions(query: string, currentUrl?: string): DevSuggestion[] {
  const q = query.trim();
  const [keyword, ...rest] = q.split(/\s+/);
  const arg = rest.join(' ');

  if (keyword === 'gh' && arg) return [github(arg, currentUrl)];
  // hasOwn: `constructor x` is a search like any other, not Object.prototype's constructor.
  const name = keyword.toLowerCase();
  const search = Object.hasOwn(SEARCHES, name) ? SEARCHES[name] : undefined;
  if (search && arg) return [{ label: arg, sub: `Open in ${search.name}`, url: search.url(arg) }];

  const jwt = decodeJwt(q);
  if (jwt) return [jwt];
  const time = decodeTimestamp(q);
  if (time) return [time];
  return [];
}

/** `gh owner/repo`, `gh 123` (in the repo of the current tab) or a GitHub search. */
function github(arg: string, currentUrl?: string): DevSuggestion {
  if (/^[\w.-]+\/[\w.-]+$/.test(arg)) return { label: arg, sub: 'Open on GitHub', url: `https://github.com/${arg}` };
  const number = arg.match(/^#?(\d+)$/)?.[1];
  const repo = currentUrl?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/)?.[1];
  if (number && repo) {
    // GitHub redirects /pull/N to /issues/N when N is an issue, so one link covers both.
    return { label: `${repo}#${number}`, sub: 'Open pull request or issue', url: `https://github.com/${repo}/pull/${number}` };
  }
  return { label: arg, sub: 'Search GitHub', url: `https://github.com/search?q=${encodeURIComponent(arg)}` };
}

function decodeJwt(text: string): DevSuggestion | undefined {
  const parts = text.split('.');
  if (parts.length !== 3 || !/^eyJ/.test(parts[0])) return undefined;
  try {
    // atob gives one character per byte; a JWT's JSON is UTF-8.
    const decode = (part: string) =>
      JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    const facts = [header.alg && `alg ${header.alg}`, payload.sub && `sub ${payload.sub}`, expiry(payload.exp)].filter(Boolean);
    return {
      label: `JWT · ${facts.join(' · ') || 'decoded'}`,
      sub: 'Copy decoded JSON',
      copy: JSON.stringify({ header, payload }, null, 2),
    };
  } catch {
    return undefined;
  }
}

function expiry(exp: unknown) {
  if (typeof exp !== 'number') return undefined;
  const ms = exp * 1000 - Date.now();
  return ms < 0 ? `expired ${relative(-ms)} ago` : `expires in ${relative(ms)}`;
}

/** 10-digit (seconds) or 13-digit (milliseconds) Unix timestamps. */
function decodeTimestamp(text: string): DevSuggestion | undefined {
  if (!/^\d{10}(\d{3})?$/.test(text)) return undefined;
  const date = new Date(text.length === 10 ? Number(text) * 1000 : Number(text));
  const ms = date.getTime() - Date.now();
  return {
    label: `${date.toLocaleString()} · ${ms < 0 ? `${relative(-ms)} ago` : `in ${relative(ms)}`}`,
    sub: 'Copy ISO date',
    copy: date.toISOString(),
  };
}

function relative(ms: number) {
  const units: Array<[number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [size, unit] of units) if (ms >= size) return `${Math.floor(ms / size)}${unit}`;
  return `${Math.floor(ms / 1000)}s`;
}
