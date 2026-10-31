import type { DetectedBrowser, ImportResult } from '../../shared/types';

/** What a detected browser has to bring over, as the tour and Settings › Import list it. */
export function browserDetail(b: DetectedBrowser) {
  const parts = [b.hasBookmarks && 'Bookmarks', b.hasHistory && 'history', b.hasCookies && 'logins'].filter((p): p is string => !!p);
  const what = (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}` : parts[0]) ?? 'Data';
  return `${what[0].toUpperCase()}${what.slice(1)}${b.profiles > 1 ? ` · ${b.profiles} profiles` : ''}`;
}

/** What an import brought over and anything that went wrong along the way, or the first thing that went wrong. */
export function importSummary(r: ImportResult) {
  const parts = [
    r.bookmarks && `${r.bookmarks.toLocaleString()} bookmarks`,
    r.history && `${r.history.toLocaleString()} pages`,
    r.cookies && `${r.cookies.toLocaleString()} cookies`,
  ].filter(Boolean);
  if (!parts.length) return r.warnings[0] ?? 'Nothing to import';
  return r.warnings.length ? `${parts.join(' · ')}. ${r.warnings.join(' ')}` : parts.join(' · ');
}
