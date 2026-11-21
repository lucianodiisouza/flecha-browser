/**
 * Which tabs get the sidebar's console error badge: pages you're developing (local URLs),
 * minus the hosts Settings says to leave alone. A `.local` name is as often a NAS or a
 * router as a dev server, and their errors aren't yours to fix.
 */

const DEV_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.(localhost|local|test)$/;

/** Settings' text as host patterns: one per line (or space, or comma), `*` for any run of characters. */
export function parseHostPatterns(text: string): string[] {
  const patterns = text
    .toLowerCase()
    .split(/[\s,]+/)
    // A pasted address counts as its host: no scheme, port or path.
    .map((entry) => entry.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d*$/, ''))
    .filter((entry) => /^[a-z0-9.*\-[\]:]+$/.test(entry));
  return [...new Set(patterns)].slice(0, 200);
}

/** `*.local` covers `nas.local` and `a.b.local`, not `local` itself. */
export function hostMatches(hostname: string, pattern: string) {
  const source = pattern.split('*').map((part) => part.replace(/[.[\]\\^$+?(){}|-]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`).test(hostname.toLowerCase());
}

/** A page you're developing, by its address: the address bar and the badge both go by this. */
export function isDevUrl(url: string) {
  try {
    return DEV_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function showsErrorBadge(url: string, hiddenHosts: string[] = []) {
  if (!isDevUrl(url)) return false;
  const { hostname } = new URL(url);
  return !hiddenHosts.some((pattern) => hostMatches(hostname, pattern));
}
