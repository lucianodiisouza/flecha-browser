import type { DetectedBrowser, ImportResult } from '../../shared/types';

/** What a detected browser has to bring over, as the tour and Settings › Import list it. */
export function browserDetail(b: DetectedBrowser) {
  const what = [b.hasBookmarks && 'Bookmarks', b.hasHistory && 'history'].filter(Boolean).join(' & ') || 'Data';
  return `${what}${b.profiles > 1 ? ` · ${b.profiles} profiles` : ''}`;
}

/** One line on what an import brought over, or the first thing that went wrong. */
export function importSummary(r: ImportResult) {
  const parts = [r.bookmarks && `${r.bookmarks.toLocaleString()} bookmarks`, r.history && `${r.history.toLocaleString()} pages`].filter(Boolean);
  return parts.length ? parts.join(' · ') : (r.warnings[0] ?? 'Nothing to import');
}
