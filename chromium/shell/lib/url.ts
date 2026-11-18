import type { SearchEngineId } from '../../shared/types';

/**
 * `suggest` is each engine's query-suggestion endpoint, as Chromium 158's prepopulated engines
 * have it (third_party/search_engines_data/resources/definitions/prepopulated_engines.json), less
 * the parameters only Chromium fills in. Each answers `["query", ["suggestion", …], …]`.
 */
export const SEARCH_ENGINES: Record<SearchEngineId, { name: string; url: string; suggest: string }> = {
  // Chromium's desktop omnibox asks as client chrome-omni (TemplateURL::GetSuggestionClient).
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s', suggest: 'https://www.google.com/complete/search?client=chrome-omni&q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?q=%s&type=list' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s', suggest: 'https://www.bing.com/osjson.aspx?query=%s' },
  // Without Chromium's rich=true, which answers with objects instead of strings.
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s' },
  kagi: { name: 'Kagi', url: 'https://kagi.com/search?q=%s', suggest: 'https://kagisuggest.com/api/autosuggest?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s', suggest: 'https://ac.ecosia.org/?q=%s&type=list' },
};

export function searchEngine(id: SearchEngineId | undefined) {
  return SEARCH_ENGINES[id ?? 'google'] ?? SEARCH_ENGINES.google;
}

/** The engine's results page for `terms`, even when they look like an address. */
export function searchUrl(terms: string, engine?: SearchEngineId): string {
  return searchEngine(engine).url.replace('%s', encodeURIComponent(terms));
}

export function hasAddressCredentials(input: string): boolean {
  return /^[^:\s/?#@]+(?::[^@]*)?@/.test(input.trim());
}

/** Turns whatever was typed in the command bar into a URL to load. */
export function resolveInput(raw: string, engine?: SearchEngineId): string {
  const input = raw.trim();
  if (!input) return 'about:blank';
  const address = webAddress(input);
  if (address) return address;
  // Never send apparent URL credentials to the search engine.
  if (hasAddressCredentials(input)) return 'about:blank';
  return searchUrl(input, engine);
}

/** What was typed as a URL, completed (`github.com` → `https://github.com`); undefined when it reads as a search. */
export function webAddress(raw: string, { allowBareHost = false } = {}): string | undefined {
  const input = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^(about|data|file|mailto):/i.test(input)) return input;
  const [authority] = input.split(/[/?#]/, 1);
  const bare = /^(\[[\da-f:.]+\]|[^:\s\\@%\[\]]+)(?::(\d+))?$/i.exec(authority);
  if (!bare) return undefined;
  const [, host, port] = bare;
  // In Settings the input is an address. Reserve recognized URI schemes when a single label has a port.
  if (port && /^(blob|ftp|http|https|news|sms|tel|urn)$/i.test(host)) return undefined;
  try {
    const url = new URL(`https://${input}`);
    const hostname = url.hostname.replace(/\.$/, '');
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
    const ipv6 = hostname.startsWith('[');
    // WHATWG URL also accepts numeric shorthand and octal IPv4. Keep the typed endpoint unambiguous.
    if (ipv4 && hostname !== host.replace(/\.$/, '')) return undefined;
    const localHost = hostname === '[::1]' || /^(?:[a-z0-9.-]+\.)?localhost$/i.test(hostname);
    const idn = /\.xn--[a-z0-9-]+$/i.test(hostname) && /[.。．｡][\p{L}\p{M}\p{N}-]+[.。．｡]?$/u.test(host);
    const domain = /\.[a-z]{2,}$/i.test(hostname) || idn;
    if (!localHost && !ipv4 && (/\s/.test(input) || (!domain && !ipv6 && !allowBareHost))) return undefined;
    const [first, second] = ipv4 ? hostname.split('.').map(Number) : [];
    // Implicit HTTP is for loopback, the wildcard bind address and RFC 1918 networks.
    const localIp = ipv4 && (first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) || hostname === '0.0.0.0');
    const address = `${localHost || localIp ? 'http' : 'https'}://${input}`;
    return /\s/.test(input) ? new URL(address).href : address;
  } catch {
    return undefined;
  }
}

/**
 * A URL to keep, for a pinned tab or favorite: typed like the address bar (`github.com` works), never
 * a search. Written the way the tab reports its page (`https://github.com/`), so the two compare.
 * Only web pages and about:blank: the shell can't open a file: page (Chromium refuses file URLs to
 * an extension without file access), and other about: pages are Chromium's chrome:// pages.
 */
export function pinnableAddress(raw: unknown): string | undefined {
  const url = webAddress(String(raw ?? ''));
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) || parsed.href === 'about:blank' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether two addresses are the same page, however each is written (`https://a.com`, `https://a.com/`).
 * Chromium opens `about:version#x` as `chrome://version/#x`, so a home saved either way matches the other.
 */
export function sameAddress(a: string, b: string): boolean {
  const comparable = (url: string) =>
    pinnableAddress(url) ?? url.replace(/^about:(?!(?:blank|srcdoc)(?:[?#]|$))([a-z0-9-]+)([?#].*)?$/i, (_, page: string, rest?: string) => `chrome://${page.toLowerCase()}/${rest ?? ''}`);
  return comparable(a) === comparable(b);
}
