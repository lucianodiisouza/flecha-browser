import type { HistoryEntry, ImportResult } from './types';
import type { Store } from './store';

export type ImportTab = { url: string; title: string };
export type ImportNode = ({ kind: 'tab' } & ImportTab) | { kind: 'folder'; name: string; children: ImportNode[] };

/** A cookie from another browser, already decrypted, in the terms chrome.cookies.set uses. */
export interface ImportCookie {
  /** With a leading dot for a cookie the whole domain shares, without one for a host-only cookie. */
  domain: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  /** Seconds since 1970; none for a session cookie. */
  expires?: number;
  /** The top-level site of a partitioned (CHIPS) cookie. */
  partitionSite?: string;
}

/** Arc's sidebar, as arcImport.ts reads it. */
export interface ArcImport {
  spaces: Array<{ name: string; emoji?: string; pinned: ImportNode[]; today: ImportTab[] }>;
  favorites: ImportTab[];
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
  /** So sites stay signed in. */
  cookies: ImportCookie[];
  warnings: string[];
}

/**
 * Adds what was read to Flecha: Arc's Spaces, or a Space of bookmarks, and the history.
 * Kept free of Node so the shell extension can run it too.
 */
export async function applyBrowserImport(
  data: BrowserImportData,
  store: Pick<Store, 'importArc' | 'importBookmarks'>,
  history: { merge(entries: HistoryEntry[]): number | Promise<number> },
  cookies: { set(cookies: ImportCookie[]): number | Promise<number> },
): Promise<ImportResult> {
  const result: ImportResult = { spaces: 0, bookmarks: 0, history: 0, cookies: 0, warnings: [...data.warnings] };
  if (data.arc) {
    store.importArc(data.arc);
    result.spaces = data.arc.spaces.length;
    result.bookmarks = data.arc.spaces.reduce((n, s) => n + countNodes(s.pinned) + s.today.length, data.arc.favorites.length);
  }
  if (data.bookmarks?.length) {
    store.importBookmarks(data.name, data.bookmarks);
    result.spaces = 1;
    result.bookmarks = data.bookmarkCount;
  }
  if (data.history.length) result.history = await history.merge(data.history);
  if (data.cookies?.length) result.cookies = await cookies.set(data.cookies);
  return result;
}

function countNodes(nodes: ImportNode[]): number {
  return nodes.reduce((n, node) => n + (node.kind === 'tab' ? 1 : countNodes(node.children)), 0);
}
