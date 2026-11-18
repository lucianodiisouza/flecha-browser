import type { ArchivedTab, BrowserState, HistoryEntry, ImportOptions, ImportPreview, ImportResult } from './types';
import { ARCHIVE_LIMIT, mergeArchive, pristineSpace, type Store } from './store';
import { plural } from './importText';

export type ImportTab = { url: string; title: string };
export type ImportNode = ({ kind: 'tab' } & ImportTab) | { kind: 'folder'; name: string; children: ImportNode[] };

/** An Arc Profile: its folder under Arc's `User Data`, and the name it was given there. */
export interface ArcProfile {
  dir: string;
  name: string;
}

/** One Arc Space, as arcImport.ts reads it. */
export interface ArcSpace {
  /** Arc's id for it, which stays the same when it's renamed or moved. */
  id?: string;
  name: string;
  emoji?: string;
  /** Its theme colour, #rrggbb. */
  color?: string;
  /** The Arc Profile it used; absent for Arc's default profile. */
  profile?: ArcProfile;
  pinned: ImportNode[];
  today: ImportTab[];
  /** Split views, as the addresses of their tabs, which are in `pinned` or `today` too. */
  splits: string[][];
}

/** Arc's sidebar and archive, as arcImport.ts reads them. */
export interface ArcImport {
  spaces: ArcSpace[];
  favorites: ImportTab[];
  /** Tabs Arc archived, newest first. */
  archive: ArchivedTab[];
  /** Sidebar entries left behind, by what they are: "non-web tab", or the kind Arc gives an item. */
  skipped: Record<string, number>;
}

/** A Space to add to Flecha, or to merge into the one of the same name (Store.importSpaces). */
export interface ImportSpace {
  name: string;
  emoji?: string;
  color?: string;
  pinned: ImportNode[];
  today: ImportTab[];
  splits?: string[][];
  /** Separate Cookies and Logins. */
  isolated?: boolean;
}

/** What Store.importSpaces did. */
export interface ImportOutcome {
  folders: number;
  /** New Spaces, and existing ones merged into. */
  spaces: number;
  merged: number;
  /** Tabs added, favorites included. */
  tabs: number;
  /** Splits made, and splits left as their tabs side by side. */
  splits: number;
  pairs: number;
  /** Archived tabs added, and archived tabs past the archive's limit. */
  archived: number;
  archiveDropped: number;
}

/**
 * What `readBrowser` (browserImport.ts) found in another browser, before any of it is added
 * to Flecha. Plain data, so it can cross from the Chromium build's native host to the shell.
 */
export interface BrowserImportData {
  /** The browser's name, which the new Space of bookmarks takes. */
  name: string;
  /** Arc's sidebar: its Spaces, pinned tabs and favourites, in place of bookmarks. */
  arc?: ArcImport;
  /** Bookmarks for one new Space, already tidied (web pages only, each once). */
  bookmarks?: ImportNode[];
  bookmarkCount: number;
  history: HistoryEntry[];
  warnings: string[];
}

const NOTES =
  'Arc Notes aren’t in any file Flecha can read, so they don’t come over. If your Arc still has Help › Export Arc Notes, export them there before Arc stops working on 22 December 2026.';
const LITTLE_ARC = 'Little Arc windows don’t come over: no Arc importer has found where Arc keeps them.';

/** The Spaces an import brings, in the order the preview lists them. */
function spacesOf(data: BrowserImportData): Array<ArcSpace | ImportSpace> {
  if (data.arc) return data.arc.spaces;
  return data.bookmarks?.length ? [{ name: data.name, pinned: data.bookmarks, today: [] }] : [];
}

/** What an import would bring over, given the Spaces and archive Flecha has now. */
export function previewBrowserImport(
  data: BrowserImportData,
  flecha: Pick<BrowserState, 'spaces' | 'favorites' | 'windows' | 'closedWindows' | 'archive'>,
  canIsolate: boolean,
): ImportPreview {
  // A fresh install's untouched Space makes way for the import, so nothing joins it.
  const replaced = spacesOf(data).length ? pristineSpace(flecha) : undefined;
  const names = new Set(flecha.spaces.filter((s) => s !== replaced).map((s) => s.name.trim().toLowerCase()));
  const spaces = spacesOf(data).map((s) => ({
    name: s.name,
    emoji: s.emoji,
    color: s.color,
    pinned: countNodes(s.pinned),
    today: s.today.length,
    splits: s.splits?.length ?? 0,
    matches: names.has(s.name.trim().toLowerCase()),
    profile: 'profile' in s ? s.profile?.name : undefined,
  }));
  const archive = data.arc?.archive ?? [];
  // Splits that can't be Flecha's: past the first two-tab split of each Space, or of more than two tabs.
  const pairs = spacesOf(data).reduce((n, s) => n + Math.max(0, (s.splits?.length ?? 0) - (s.splits?.some((u) => u.length === 2) ? 1 : 0)), 0);
  return {
    name: data.name,
    spaces,
    favorites: data.arc?.favorites.length ?? 0,
    archived: archive.length,
    history: data.history.length,
    skipped: skippedLines(data, pairs, archive.length ? mergeArchive(flecha.archive, archive).dropped : 0),
    canIsolate,
    warnings: [...data.warnings],
    spacesKey: spacesKey(data),
  };
}

/** The Spaces an import brings, in order, by Arc's id, name and Profile: what `isolate`'s indexes point at. */
function spacesKey(data: BrowserImportData): string {
  return JSON.stringify(spacesOf(data).map((s) => ['id' in s ? s.id ?? '' : '', s.name, 'profile' in s ? s.profile?.dir ?? '' : '']));
}

/**
 * Adds what was read to Flecha: Arc's Spaces, favorites and archive, or a Space of bookmarks,
 * and the history. Kept free of Node so the shell extension can run it too.
 */
export async function applyBrowserImport(
  data: BrowserImportData,
  options: ImportOptions,
  store: Pick<Store, 'importSpaces'>,
  history: { merge(entries: HistoryEntry[]): number | Promise<number> },
): Promise<ImportResult> {
  const result: ImportResult = { changed: false, spaces: 0, merged: 0, bookmarks: 0, history: 0, archived: 0, warnings: [...data.warnings], details: [] };
  if (options.spacesKey !== undefined && options.spacesKey !== spacesKey(data)) {
    result.warnings.push(`${data.name}’s Spaces changed since the preview, so nothing was imported. Look at the preview again.`);
    return result;
  }
  const spaces = spacesOf(data).map((s, i): ImportSpace => ({ ...s, isolated: options.isolate.includes(i) }));
  if (spaces.length || data.arc) {
    const out = store.importSpaces(spaces, { mode: options.mode, favorites: data.arc?.favorites, archive: data.arc?.archive });
    Object.assign(result, { spaces: out.spaces, merged: out.merged, bookmarks: out.tabs, archived: out.archived });
    result.changed = out.spaces + out.tabs + out.folders + out.splits + out.archived > 0;
    result.details = skippedLines(data, out.pairs, out.archiveDropped);
  }
  if (data.history.length) result.history = await history.merge(data.history);
  result.changed ||= result.history > 0;
  return result;
}

/** Options as a page sent them: anything unexpected falls back to merging, without isolation. */
export function importOptions(raw: unknown, canIsolate: boolean): ImportOptions {
  const options: Partial<ImportOptions> = typeof raw === 'object' && raw ? raw : {};
  return {
    mode: options.mode === 'append' ? 'append' : 'merge',
    isolate: canIsolate && Array.isArray(options.isolate) ? options.isolate.filter((i) => Number.isInteger(i) && i >= 0) : [],
    spacesKey: typeof options.spacesKey === 'string' ? options.spacesKey : undefined,
  };
}

/** What doesn't come over, one line each, for the preview and the summary. */
function skippedLines(data: BrowserImportData, pairs: number, archiveDropped: number): string[] {
  const arc = data.arc;
  if (!arc) return [];
  const lines: string[] = [];
  const { 'non-web tab': nonWeb = 0, 'tab without address': noAddress = 0, 'partial split': partial = 0, ...kinds } = arc.skipped;
  if (nonWeb) lines.push(`${plural(nonWeb, 'tab')} with an address other than a web page (such as arc:)`);
  if (noAddress) lines.push(`${plural(noAddress, 'tab')} with no saved address`);
  for (const [kind, n] of Object.entries(kinds)) lines.push(`${plural(n, 'sidebar item')} of a kind Flecha doesn’t have (Arc calls it “${kind}”)`);
  if (pairs) lines.push(`${plural(pairs, 'split view')} kept as tabs side by side: Flecha shows one split of two tabs per Space`);
  if (partial) lines.push(`${plural(partial, 'split view')} that lost a tab, kept as the tabs that came over`);
  if (archiveDropped) lines.push(`${plural(archiveDropped, 'archived tab')}, Arc’s or Flecha’s own, past the ${ARCHIVE_LIMIT} most recent, which is all Flecha’s archive keeps`);
  const profiles = [...new Set(arc.spaces.flatMap((s) => (s.profile ? [s.profile.name] : [])))];
  if (profiles.length) {
    lines.push(`Arc Profiles (${profiles.map((p) => `“${p}”`).join(', ')}): Flecha has no Profiles yet. Their Spaces can have Separate Cookies and Logins instead`);
  }
  lines.push(LITTLE_ARC, NOTES);
  return lines;
}

function countNodes(nodes: ImportNode[]): number {
  return nodes.reduce((n, node) => n + (node.kind === 'tab' ? 1 : countNodes(node.children)), 0);
}
