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

/** Turns whatever was typed in the command bar into a URL to load. */
export function resolveInput(raw: string, engine?: SearchEngineId): string {
  const input = raw.trim();
  if (!input) return 'about:blank';
  return webAddress(input) ?? searchUrl(input, engine);
}

/** What was typed as a URL, completed (`github.com` → `https://github.com`); undefined when it reads as a search. */
export function webAddress(raw: string): string | undefined {
  const input = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^(about|data|file|mailto):/i.test(input)) return input;
  if (/^(localhost|[a-z0-9.-]+\.localhost|(?:\d{1,3}\.){3}\d{1,3}|\[::1\])(?=[:/?#]|$)/i.test(input)) {
    if (/\s/.test(input)) return undefined;
    try {
      const url = new URL(`http://${input}`);
      if (!url.username && !url.password) return `http://${input}`;
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (!/\s/.test(input) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(input)) return `https://${input}`;
  return undefined;
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
