import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DetectedBrowser, HistoryEntry } from '../shared/types';
import { arcSidebarPath, readArcSidebar, type ArcImport, type ImportNode } from './arcImport';
import type { BrowserImportData } from '../shared/importApply';

/**
 * Brings bookmarks and history over from the other browsers on this computer (macOS or Linux). Their files are
 * only ever read: databases are copied to a temporary folder first, since the browser may
 * have them open and locked. Passwords and cookies are left where they are.
 *
 * Reading (`readBrowser`) is kept apart from adding to Flecha (`applyBrowserImport`), so the
 * Chromium build's native messaging host can read and its shell extension can add. Nothing
 * here needs Electron.
 */

const run = promisify(execFile);

/** Pages taken from each profile's history, newest first. Flecha keeps 5,000 in all. */
const HISTORY_ROWS = 5000;
/** Bookmarks past this many are left behind: no sidebar can usefully hold more. */
const MAX_BOOKMARKS = 2000;
/** Folders nested deeper than this are flattened into their parent. */
const MAX_DEPTH = 8;

/** One profile of a browser, with whichever of its files exist. */
interface Profile {
  name: string;
  bookmarkFiles: string[];
  historyFile?: string;
}

interface BrowserSource {
  id: string;
  name: string;
  profiles(): Profile[];
  readBookmarks(profile: Profile): Promise<ImportNode[]>;
  readHistory(profile: Profile): Promise<HistoryEntry[]>;
  /** For browsers whose sidebar says more than bookmarks do (Arc): imported in their place. */
  sidebar?: { exists(): boolean; read(): ArcImport };
}

const IS_MAC = process.platform === 'darwin';

const home = (...parts: string[]) => path.join(os.homedir(), ...parts);
/** Electron's appData folder: ~/Library/Application Support on macOS, ~/.config on Linux. */
export const appSupport = (...parts: string[]) =>
  IS_MAC ? home('Library', 'Application Support', ...parts) : path.join(process.env.XDG_CONFIG_HOME || home('.config'), ...parts);
/** A Flatpak app's own ~/.config. */
const flatpak = (appId: string, ...parts: string[]) => home('.var', 'app', appId, 'config', ...parts);

// ---- Chromium family -------------------------------------------------------

/**
 * Each browser's data folder, the first of its folders that exists. On Linux a browser may
 * come from the distro's package, a Flatpak or a Snap (Ubuntu's Chromium is a Snap).
 * shortcut: a browser installed twice imports only the first, add the rest if anyone asks.
 */
const CHROMIUM: Array<[id: string, name: string, dirs: string[]]> = IS_MAC
  ? [
      ['chrome', 'Chrome', [appSupport('Google/Chrome')]],
      ['brave', 'Brave', [appSupport('BraveSoftware/Brave-Browser')]],
      ['edge', 'Edge', [appSupport('Microsoft Edge')]],
      ['vivaldi', 'Vivaldi', [appSupport('Vivaldi')]],
      ['opera', 'Opera', [appSupport('com.operasoftware.Opera')]],
      ['opera-gx', 'Opera GX', [appSupport('com.operasoftware.OperaGX')]],
      ['chromium', 'Chromium', [appSupport('Chromium')]],
    ]
  : [
      ['chrome', 'Chrome', [appSupport('google-chrome'), flatpak('com.google.Chrome', 'google-chrome')]],
      ['brave', 'Brave', [appSupport('BraveSoftware/Brave-Browser'), flatpak('com.brave.Browser', 'BraveSoftware/Brave-Browser'), home('snap/brave/current/.config/BraveSoftware/Brave-Browser')]],
      ['edge', 'Edge', [appSupport('microsoft-edge'), flatpak('com.microsoft.Edge', 'microsoft-edge')]],
      ['vivaldi', 'Vivaldi', [appSupport('vivaldi'), flatpak('com.vivaldi.Vivaldi', 'vivaldi')]],
      ['opera', 'Opera', [appSupport('opera'), flatpak('com.opera.Opera', 'opera')]],
      ['chromium', 'Chromium', [appSupport('chromium'), flatpak('org.chromium.Chromium', 'chromium'), home('snap/chromium/common/chromium')]],
    ];

/** Firefox's profiles folder: the classic ~/.mozilla one first, then the XDG, Flatpak and Snap ones. */
const FIREFOX = IS_MAC
  ? [appSupport('Firefox', 'Profiles')]
  : [
      home('.mozilla/firefox'),
      appSupport('mozilla/firefox'),
      home('.var/app/org.mozilla.firefox/.mozilla/firefox'),
      home('snap/firefox/common/.mozilla/firefox'),
    ];

/** The first folder that exists, else the first one (whose profiles are then simply none). */
const firstDir = (dirs: string[]) => dirs.find((dir) => listDirs(dir).length > 0) ?? dirs[0];

function chromiumSource(id: string, name: string, root: string): BrowserSource {
  return {
    id,
    name,
    profiles: () => chromiumProfiles(root),
    readBookmarks: async (profile) => chromiumBookmarks(profile.bookmarkFiles),
    readHistory: (profile) =>
      // Chromium counts in microseconds since 1601.
      querySqlite<HistoryEntry>(
        profile.historyFile!,
        `SELECT url, title, visit_count AS visits, last_visit_time / 1000 - 11644473600000 AS lastVisit
         FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ${HISTORY_ROWS}`,
      ),
  };
}

/** `Default` and `Profile N` folders (Opera keeps its one profile in the root itself). */
function chromiumProfiles(root: string): Profile[] {
  const names = chromiumProfileNames(root);
  const dirs = [root, ...listDirs(root).filter((d) => /^(Default|Profile \d+)$/.test(d)).map((d) => path.join(root, d))];
  return dirs.flatMap((dir) => {
    const key = dir === root ? 'Default' : path.basename(dir);
    // Chrome keeps the bookmarks of a signed-in account in a file of their own.
    const bookmarkFiles = ['Bookmarks', 'AccountBookmarks'].map((f) => path.join(dir, f)).filter(isFile);
    const history = path.join(dir, 'History');
    const profile: Profile = { name: names[key] || key, bookmarkFiles, historyFile: isFile(history) ? history : undefined };
    return profile.bookmarkFiles.length || profile.historyFile ? [profile] : [];
  });
}

/** The names people gave their profiles, from `Local State`. */
function chromiumProfileNames(root: string): Record<string, string> {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'))?.profile?.info_cache ?? {};
    return Object.fromEntries(Object.entries(cache).map(([dir, info]: [string, any]) => [dir, String(info?.name ?? '')]));
  } catch {
    return {};
  }
}

/** The bookmarks bar becomes the top level; "Other" and "Mobile" bookmarks get folders of their own. */
function chromiumBookmarks(files: string[]): ImportNode[] {
  const bar: ImportNode[] = [];
  const other: ImportNode[] = [];
  const mobile: ImportNode[] = [];
  for (const file of files) {
    const roots = JSON.parse(fs.readFileSync(file, 'utf8'))?.roots ?? {};
    bar.push(...chromiumChildren(roots.bookmark_bar));
    other.push(...chromiumChildren(roots.other));
    mobile.push(...chromiumChildren(roots.synced));
  }
  return [...bar, folder('Other Bookmarks', other), folder('Mobile Bookmarks', mobile)];
}

function chromiumChildren(node: any): ImportNode[] {
  return Array.isArray(node?.children) ? node.children.flatMap(chromiumNode) : [];
}

function chromiumNode(node: any): ImportNode[] {
  if (node?.type === 'url' && typeof node.url === 'string') return [{ kind: 'tab', url: node.url, title: String(node.name || node.url) }];
  if (node?.type === 'folder') return [folder(String(node.name || 'Untitled folder'), chromiumChildren(node))];
  return [];
}

/** Arc is Chromium underneath, but its Spaces and pinned tabs live in its own sidebar file. */
function arcSource(): BrowserSource {
  return {
    ...chromiumSource('arc', 'Arc', appSupport('Arc', 'User Data')),
    sidebar: { exists: () => isFile(arcSidebarPath()), read: () => readArcSidebar() },
  };
}

// ---- Firefox ---------------------------------------------------------------

/** Bookmarks and history both live in each profile's places.sqlite. */
function firefoxSource(root: string): BrowserSource {
  return {
    id: 'firefox',
    name: 'Firefox',
    profiles: () =>
      listDirs(root).flatMap((dir) => {
        const places = path.join(root, dir, 'places.sqlite');
        // Profile folders are named "<random>.<name>", e.g. "x1y2z3.default-release".
        return isFile(places) ? [{ name: dir.replace(/^[^.]+\./, ''), bookmarkFiles: [places], historyFile: places }] : [];
      }),
    readBookmarks: async (profile) => firefoxBookmarks(await querySqlite<FirefoxBookmark>(profile.bookmarkFiles[0], FIREFOX_BOOKMARKS)),
    readHistory: (profile) =>
      // Firefox counts in microseconds since 1970.
      querySqlite<HistoryEntry>(
        profile.historyFile!,
        `SELECT url, title, visit_count AS visits, last_visit_date / 1000 AS lastVisit
         FROM moz_places WHERE hidden = 0 AND visit_count > 0 AND last_visit_date IS NOT NULL
         ORDER BY last_visit_date DESC LIMIT ${HISTORY_ROWS}`,
      ),
  };
}

interface FirefoxBookmark {
  id: number;
  parent: number;
  /** 1 bookmark, 2 folder, 3 separator. */
  type: number;
  title: string | null;
  guid: string;
  url: string | null;
}

const FIREFOX_BOOKMARKS = `SELECT b.id AS id, b.parent AS parent, b.type AS type, b.title AS title, b.guid AS guid, p.url AS url
  FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position`;

/** The toolbar becomes the top level; the menu, unsorted and mobile roots get folders. Tags are skipped. */
function firefoxBookmarks(rows: FirefoxBookmark[]): ImportNode[] {
  const children = new Map<number, FirefoxBookmark[]>();
  for (const row of rows) {
    const list = children.get(row.parent) ?? [];
    list.push(row);
    children.set(row.parent, list);
  }
  const nodes = (parent: number): ImportNode[] =>
    (children.get(parent) ?? []).flatMap((row): ImportNode[] => {
      if (row.type === 1 && row.url) return [{ kind: 'tab', url: row.url, title: row.title || row.url }];
      if (row.type === 2) return [folder(row.title || 'Untitled folder', nodes(row.id))];
      return [];
    });
  const root = (guid: string) => {
    const row = rows.find((r) => r.guid === guid);
    return row ? nodes(row.id) : [];
  };
  return [
    ...root('toolbar_____'),
    folder('Bookmarks Menu', root('menu________')),
    folder('Other Bookmarks', root('unfiled_____')),
    folder('Mobile Bookmarks', root('mobile______')),
  ];
}

// ---- Safari ----------------------------------------------------------------

const FULL_DISK_ACCESS =
  'macOS only lets apps read Safari’s data with Full Disk Access. Turn it on for Flecha in System Settings › Privacy & Security › Full Disk Access, then import again.';

function safariSource(): BrowserSource {
  const root = path.join(os.homedir(), 'Library', 'Safari');
  const bookmarks = path.join(root, 'Bookmarks.plist');
  const history = path.join(root, 'History.db');
  return {
    id: 'safari',
    name: 'Safari',
    profiles: () => {
      // Without Full Disk Access the files can't even be looked at; list Safari anyway so the
      // import can explain what's needed.
      const profile: Profile = {
        name: 'Safari',
        bookmarkFiles: mayExist(bookmarks) ? [bookmarks] : [],
        historyFile: mayExist(history) ? history : undefined,
      };
      return profile.bookmarkFiles.length || profile.historyFile ? [profile] : [];
    },
    readBookmarks: (profile) => needsFullDiskAccess(async () => safariBookmarks(await readPlist(profile.bookmarkFiles[0]))),
    readHistory: (profile) =>
      needsFullDiskAccess(() =>
        // Safari counts in seconds since 2001; each visit has its own row and title.
        querySqlite<HistoryEntry>(
          profile.historyFile!,
          `SELECT i.url AS url, v.title AS title, i.visit_count AS visits,
             CAST((MAX(v.visit_time) + 978307200) * 1000 AS INTEGER) AS lastVisit
           FROM history_items i JOIN history_visits v ON v.history_item = i.id
           GROUP BY i.id ORDER BY lastVisit DESC LIMIT ${HISTORY_ROWS}`,
        ),
      ),
  };
}

const SAFARI_FOLDERS: Record<string, string> = { BookmarksMenu: 'Bookmarks Menu', 'com.apple.ReadingList': 'Reading List' };

/** The Favourites bar becomes the top level; the menu, Reading List and other folders stay folders. */
function safariBookmarks(plist: any): ImportNode[] {
  const top: any[] = Array.isArray(plist?.Children) ? plist.Children : [];
  return top.flatMap((item): ImportNode[] => (item?.Title === 'BookmarksBar' ? safariNodes(item.Children) : safariNodes([item])));
}

function safariNodes(items: unknown): ImportNode[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): ImportNode[] => {
    if (item?.WebBookmarkType === 'WebBookmarkTypeLeaf' && typeof item.URLString === 'string') {
      return [{ kind: 'tab', url: item.URLString, title: String(item.URIDictionary?.title || item.URLString) }];
    }
    if (item?.WebBookmarkType === 'WebBookmarkTypeList') {
      const title = String(item.Title || 'Untitled folder');
      return [folder(SAFARI_FOLDERS[title] ?? title, safariNodes(item.Children))];
    }
    // The "History" proxy entry and anything else that isn't a bookmark.
    return [];
  });
}

/** Turns macOS's "operation not permitted" into instructions. */
async function needsFullDiskAccess<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (isPermissionError(err)) throw new Error(FULL_DISK_ACCESS);
    throw err;
  }
}

/**
 * Binary property lists can hold dates and data, which `plutil` refuses to turn into JSON,
 * so they go through XML and a small parser instead.
 */
async function readPlist(file: string): Promise<unknown> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flecha-import-'));
  try {
    const copy = path.join(dir, path.basename(file));
    await fs.promises.copyFile(file, copy);
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', copy], { maxBuffer: 64 * 1024 * 1024 });
    return parseXmlPlist(stdout);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/** Just enough of the XML property list format: dates, data and numbers stay strings. */
function parseXmlPlist(xml: string): unknown {
  const tag = /<(\/?)(dict|array|key|string|integer|real|true|false|date|data)\s*(\/?)>/g;
  const next = () => {
    const m = tag.exec(xml);
    if (!m) throw new Error('The property list ended unexpectedly.');
    return { closing: !!m[1], name: m[2], empty: !!m[3], end: tag.lastIndex };
  };
  const text = (name: string, from: number) => {
    const close = xml.indexOf(`</${name}>`, from);
    if (close < 0) throw new Error(`Unclosed <${name}> in the property list.`);
    tag.lastIndex = close + name.length + 3;
    return decodeXml(xml.slice(from, close));
  };
  const value = (t: ReturnType<typeof next>): unknown => {
    if (t.name === 'true' || t.name === 'false') {
      if (!t.empty) next();
      return t.name === 'true';
    }
    if (t.name === 'dict') {
      const dict: Record<string, unknown> = {};
      if (t.empty) return dict;
      for (let k = next(); !k.closing; k = next()) {
        const key = k.name === 'key' ? text('key', k.end) : '';
        dict[key] = value(next());
      }
      return dict;
    }
    if (t.name === 'array') {
      const list: unknown[] = [];
      if (t.empty) return list;
      for (let v = next(); !v.closing; v = next()) list.push(value(v));
      return list;
    }
    return t.empty ? '' : text(t.name, t.end);
  };
  return value(next());
}

function decodeXml(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(parseInt(e[1].toLowerCase() === 'x' ? e.slice(2) : e.slice(1), e[1].toLowerCase() === 'x' ? 16 : 10));
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()];
  });
}

// ---- detecting and importing -------------------------------------------------

function sources(): BrowserSource[] {
  return [
    ...CHROMIUM.map(([id, name, dirs]) => chromiumSource(id, name, firstDir(dirs))),
    // Arc and Safari are Mac apps.
    ...(IS_MAC ? [arcSource()] : []),
    firefoxSource(firstDir(FIREFOX)),
    ...(IS_MAC ? [safariSource()] : []),
  ];
}

/** Browsers on this computer that have bookmarks or history to bring over. Only checks which files exist. */
export async function detectBrowsers(): Promise<DetectedBrowser[]> {
  return sources().flatMap((source) => {
    try {
      const profiles = source.profiles();
      const sidebar = !!source.sidebar?.exists();
      if (!profiles.length && !sidebar) return [];
      return [
        {
          id: source.id,
          name: source.name,
          profiles: Math.max(profiles.length, 1),
          hasBookmarks: sidebar || profiles.some((p) => p.bookmarkFiles.length > 0),
          hasHistory: profiles.some((p) => !!p.historyFile),
        },
      ];
    } catch {
      return [];
    }
  });
}

/** Reads what the shell's `importBrowser` brings over, without adding it anywhere. */
export async function readBrowser(id: string): Promise<BrowserImportData> {
  const result: BrowserImportData = { name: id, bookmarkCount: 0, history: [], warnings: [] };
  const source = sources().find((s) => s.id === id);
  if (!source) {
    result.warnings.push(`No data from “${id}” was found on this Mac.`);
    return result;
  }
  result.name = source.name;

  let profiles: Profile[] = [];
  try {
    profiles = source.profiles();
  } catch (err) {
    result.warnings.push(`Couldn’t look for ${source.name} profiles: ${reason(err)}`);
  }
  const label = (p: Profile) => (profiles.length > 1 ? `${source.name} (${p.name})` : source.name);
  // Missing Full Disk Access blocks every file alike, so it is explained once.
  const warn = (what: string, err: unknown) => {
    const message = reason(err);
    const warning = message === FULL_DISK_ACCESS ? message : `Couldn’t read ${what}: ${message}`;
    if (!result.warnings.includes(warning)) result.warnings.push(warning);
  };

  if (source.sidebar) {
    try {
      result.arc = source.sidebar.read();
    } catch (err) {
      warn(`${source.name}’s sidebar`, err);
    }
  }

  const tidy = newTidy();
  const perProfile: Array<{ profile: Profile; nodes: ImportNode[] }> = [];
  const visits: HistoryEntry[] = [];
  for (const profile of profiles) {
    if (profile.bookmarkFiles.length && !source.sidebar) {
      try {
        const nodes = tidy.run(await source.readBookmarks(profile));
        if (nodes.length) perProfile.push({ profile, nodes });
      } catch (err) {
        warn(`bookmarks from ${label(profile)}`, err);
      }
    }
    if (profile.historyFile) {
      try {
        visits.push(...(await source.readHistory(profile)).map(cleanEntry));
      } catch (err) {
        warn(`history from ${label(profile)}`, err);
      }
    }
  }

  if (tidy.skipped) result.warnings.push(`Only the first ${MAX_BOOKMARKS} bookmarks were imported; ${tidy.skipped} more were left out.`);
  if (perProfile.length) {
    const nodes = perProfile.length > 1 ? perProfile.map(({ profile, nodes }) => folder(profile.name, nodes)) : perProfile[0].nodes;
    result.bookmarks = nodes;
    result.bookmarkCount = tidy.count;
  }
  result.history = visits;
  return result;
}

// ---- helpers ---------------------------------------------------------------

/**
 * Keeps web bookmarks only, each URL once, drops empty folders and stops at
 * MAX_BOOKMARKS. Shared across a browser's profiles so the cap covers them all.
 */
function newTidy() {
  const seen = new Set<string>();
  const tidy = {
    skipped: 0,
    get count() {
      return seen.size;
    },
    run(nodes: ImportNode[], depth = 0): ImportNode[] {
      return nodes.flatMap((n): ImportNode[] => {
        if (n.kind === 'tab') {
          if (!/^https?:/i.test(n.url) || seen.has(n.url)) return [];
          if (seen.size >= MAX_BOOKMARKS) {
            tidy.skipped++;
            return [];
          }
          seen.add(n.url);
          return [n];
        }
        if (depth >= MAX_DEPTH) return tidy.run(n.children, depth);
        const children = tidy.run(n.children, depth + 1);
        return children.length ? [{ ...n, children }] : [];
      });
    },
  };
  return tidy;
}

function folder(name: string, children: ImportNode[]): ImportNode {
  return { kind: 'folder', name, children };
}

/** Databases hand back nulls and odd types; History only wants plain values. */
function cleanEntry(row: HistoryEntry): HistoryEntry {
  const url = String(row.url ?? '');
  return { url, title: String(row.title || url), visits: Number(row.visits) || 1, lastVisit: Number(row.lastVisit) };
}

/** Runs `sql` against a copy of `file`, since the browser may have it open and locked. */
async function querySqlite<T>(file: string, sql: string): Promise<T[]> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flecha-import-'));
  try {
    const copy = path.join(dir, path.basename(file));
    await fs.promises.copyFile(file, copy);
    // Recent writes may still be in the write-ahead log rather than the database itself.
    await fs.promises.copyFile(`${file}-wal`, `${copy}-wal`).catch(() => {});
    return await runSql<T>(copy, sql);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/** Node's built-in SQLite when this runtime has it, macOS's sqlite3 tool otherwise. */
async function runSql<T>(file: string, sql: string): Promise<T[]> {
  let sqlite: typeof import('node:sqlite') | undefined;
  try {
    sqlite = require('node:sqlite');
  } catch {
    // Not built in; fall back to the command line tool below.
  }
  if (sqlite) {
    const db = new sqlite.DatabaseSync(file);
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  }
  const { stdout } = await run('/usr/bin/sqlite3', ['-json', file, sql], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function isFile(file: string) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A file that exists, or one macOS won't let us look at (which usually means it exists). */
function mayExist(file: string) {
  try {
    return fs.statSync(file).isFile();
  } catch (err) {
    return isPermissionError(err);
  }
}

function isPermissionError(err: unknown) {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EACCES' || /operation not permitted|authorization denied/i.test(reason(err));
}

function reason(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
