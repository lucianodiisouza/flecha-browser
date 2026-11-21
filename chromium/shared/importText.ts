import type { ImportPreview, ImportResult } from './types';

/**
 * Words for an import's preview and result, shared by the tour and the Import dialog. Apart from
 * importApply.ts so the pages that show them don't also bundle the Store.
 */

/** What a preview lists, one line each: the Spaces with their tabs, then the rest. */
export function previewLines(p: ImportPreview): string[] {
  return [
    ...p.spaces.map((s) => `${s.emoji ? `${s.emoji} ` : ''}${s.name}: ${spaceCounts(s)}${s.matches ? ' (a Space of this name exists)' : ''}${s.profile ? ` · Arc Profile “${s.profile}”` : ''}`),
    p.favorites ? plural(p.favorites, 'favorite') : '',
    p.archived ? plural(p.archived, 'archived tab') : '',
    p.history ? `${plural(p.history, 'page')} of history` : '',
  ].filter(Boolean);
}

/** "12 pinned, 3 open, 1 split". */
export function spaceCounts(s: ImportPreview['spaces'][number]): string {
  return [s.pinned && `${s.pinned.toLocaleString()} pinned`, s.today && `${s.today.toLocaleString()} open`, s.splits && plural(s.splits, 'split')].filter(Boolean).join(', ') || 'empty';
}

/** Whether a preview found anything to bring over. */
export function hasImport(p: ImportPreview) {
  return p.spaces.length + p.favorites + p.archived + p.history > 0;
}

/** One line for what an import brought over: "1 new Space · 31 bookmarks · 5 pages". */
export function resultLine(r: ImportResult): string {
  if (!r.changed) return '';
  return [
    r.spaces && plural(r.spaces, 'new Space'),
    r.merged && `${plural(r.merged, 'Space')} merged`,
    r.bookmarks && plural(r.bookmarks, 'bookmark'),
    r.folders && plural(r.folders, 'folder'),
    r.splits && plural(r.splits, 'split view'),
    r.archived && plural(r.archived, 'archived tab'),
    r.history && plural(r.history, 'page'),
  ].filter(Boolean).join(' · ');
}

export function plural(n: number, word: string) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}
