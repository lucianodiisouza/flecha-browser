import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DetectedBrowser, HistoryEntry } from '../shared/types';
import { arcSidebarPath, readArcSidebar, type ArcImport, type ImportNode } from './arcImport';
import { parseBookmarksHtml } from './bookmarksHtml';
import type { BrowserImportData, ImportCookie } from '../shared/importApply';

/**
 * Brings bookmarks, history and cookies (so sites stay signed in) over from the other browsers
 * on this Mac. Their files are only ever read: databases are copied to a temporary folder first,
 * since the browser may have them open and locked. Passwords are left where they are.
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
  cookiesFile?: string;
}

interface BrowserSource {
  id: string;
  name: string;
  profiles(): Profile[];
  readBookmarks(profile: Profile): Promise<ImportNode[]>;
  readHistory(profile: Profile): Promise<HistoryEntry[]>;
  /** Called once per import, so a keychain prompt covers every profile. */
  cookieReader?(): (profile: Profile) => Promise<ImportCookie[]>;
  /** Where a Chromium browser keeps its profiles, so the scan for unlisted ones skips it. */
  root?: string;
  /** For browsers whose sidebar says more than bookmarks do (Arc): imported in their place. */
  sidebar?: { exists(): boolean; read(): ArcImport };
}

/** Electron's appData folder on macOS. */
const appSupport = (...parts: string[]) => path.join(os.homedir(), 'Library', 'Application Support', ...parts);

// ---- Chromium family -------------------------------------------------------

/** The last field is the keychain item the browser keeps its cookie key in. */
const CHROMIUM: Array<[id: string, name: string, dir: string, safeStorage: string]> = [
  ['chrome', 'Chrome', 'Google/Chrome', 'Chrome Safe Storage'],
  ['brave', 'Brave', 'BraveSoftware/Brave-Browser', 'Brave Safe Storage'],
  ['edge', 'Edge', 'Microsoft Edge', 'Microsoft Edge Safe Storage'],
  ['vivaldi', 'Vivaldi', 'Vivaldi', 'Vivaldi Safe Storage'],
  ['opera', 'Opera', 'com.operasoftware.Opera', 'Opera Safe Storage'],
  ['opera-gx', 'Opera GX', 'com.operasoftware.OperaGX', 'Opera Safe Storage'],
  ['chromium', 'Chromium', 'Chromium', 'Chromium Safe Storage'],
];

function chromiumSource(id: string, name: string, root: string, safeStorage = `${name} Safe Storage`): BrowserSource {
  return {
    id,
    name,
    root,
    profiles: () => chromiumProfiles(root),
    cookieReader: () => {
      const key = once(() => chromiumKey(safeStorage, keychainDenied(name, safeStorage)));
      return async (profile) => chromiumCookies(await querySqlite<ChromiumCookie>(profile.cookiesFile!, CHROMIUM_COOKIES), key);
    },
    readBookmarks: async (profile) => chromiumBookmarks(profile.bookmarkFiles.map((f) => fs.readFileSync(f, 'utf8'))),
    readHistory: (profile) =>
      // Chromium counts in microseconds since 1601.
      querySqlite<HistoryEntry>(
        profile.historyFile!,
        `SELECT url, title, visit_count AS visits, last_visit_time / 1000 - 11644473600000 AS lastVisit
         FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ${HISTORY_ROWS}`,
      ),
  };
}

/**
 * `Default` and `Profile N` folders (Opera keeps its one profile in the root itself). Chrome
 * keeps the bookmarks of a signed-in account in a file of their own, `AccountBookmarks`.
 */
function chromiumProfiles(root: string, bookmarkNames = ['Bookmarks', 'AccountBookmarks']): Profile[] {
  const names = chromiumProfileNames(root);
  const dirs = [root, ...listDirs(root).filter((d) => /^(Default|Profile \d+)$/.test(d)).map((d) => path.join(root, d))];
  return dirs.flatMap((dir) => {
    const key = dir === root ? 'Default' : path.basename(dir);
    const bookmarkFiles = bookmarkNames.map((f) => path.join(dir, f)).filter(isFile);
    const history = path.join(dir, 'History');
    const cookies = [path.join(dir, 'Cookies'), path.join(dir, 'Network', 'Cookies')].find(isFile);
    const profile: Profile = { name: names[key] || key, bookmarkFiles, historyFile: isFile(history) ? history : undefined, cookiesFile: cookies };
    return profile.bookmarkFiles.length || profile.historyFile || profile.cookiesFile ? [profile] : [];
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
function chromiumBookmarks(documents: string[]): ImportNode[] {
  const bar: ImportNode[] = [];
  const other: ImportNode[] = [];
  const mobile: ImportNode[] = [];
  for (const json of documents) {
    const roots = JSON.parse(json)?.roots ?? {};
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
    ...chromiumSource('arc', 'Arc', appSupport('Arc', 'User Data'), 'Arc Safe Storage'),
    sidebar: { exists: () => isFile(arcSidebarPath()), read: () => readArcSidebar() },
  };
}

const DIA_KEYCHAIN =
  'Dia keeps its bookmarks encrypted, with the key in your keychain. Choose Allow when macOS asks about “Dia Safe Storage”, then import again.';

/**
 * Dia is Chromium underneath too. Newer versions write their bookmarks to EncryptedBookmarks2
 * and stop updating the plain Bookmarks file; older ones only have the plain file.
 */
function diaSource(): BrowserSource {
  const root = appSupport('Dia', 'User Data');
  return {
    ...chromiumSource('dia', 'Dia', root, 'Dia Safe Storage'),
    // Only the newest of the two, so bookmarks deleted since don't come back from the old file.
    profiles: () =>
      chromiumProfiles(root, ['EncryptedBookmarks2', 'Bookmarks']).map((p) => ({ ...p, bookmarkFiles: p.bookmarkFiles.slice(0, 1) })),
    readBookmarks: async ({ bookmarkFiles: [file] }) =>
      chromiumBookmarks([
        path.basename(file) === 'Bookmarks' ? fs.readFileSync(file, 'utf8') : await decryptChromium(file, 'Dia Safe Storage', DIA_KEYCHAIN),
      ]),
  };
}

/**
 * Chromium's "v10" encryption on macOS: AES-128-CBC, with a key made from a password the browser
 * keeps in the login keychain. macOS asks before handing that password over.
 */
async function decryptChromium(file: string, keychainService: string, denied: string): Promise<string> {
  const data = await fs.promises.readFile(file);
  if (data.subarray(0, 3).toString() !== 'v10') throw new Error(`${path.basename(file)} is encrypted in a way Flecha doesn’t know.`);
  return decryptV10(data, await chromiumKey(keychainService, denied)).toString('utf8');
}

async function chromiumKey(keychainService: string, denied: string): Promise<Buffer> {
  let password: string;
  try {
    password = (await run('/usr/bin/security', ['find-generic-password', '-w', '-s', keychainService])).stdout.trim();
  } catch {
    throw new Error(denied);
  }
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

/** `data` still starts with "v10". */
function decryptV10(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
}

const keychainDenied = (name: string, item: string) =>
  `${name} keeps its cookies encrypted, with the key in your keychain. Choose Allow when macOS asks about “${item}”, then import again to stay signed in to your sites.`;

interface ChromiumCookie {
  host: string;
  name: string;
  value: string;
  /** encrypted_value as hex, since the two ways of running SQL hand blobs back differently. */
  encrypted: string;
  path: string;
  /** Seconds since 1970, or 0 for a session cookie. */
  expires: number;
  secure: number;
  httpOnly: number;
  /** -1 unspecified, 0 none, 1 lax, 2 strict. */
  sameSite: number;
  partitionSite: string | null;
  /** The database's schema version; from 24 on, values start with a hash of their host. */
  version: string | null;
}

// Chromium counts in microseconds since 1601, past what a JavaScript number holds exactly,
// so the conversion happens in SQL.
const CHROMIUM_COOKIES = `SELECT host_key AS host, name, value, hex(encrypted_value) AS encrypted, path,
    CASE WHEN has_expires THEN expires_utc / 1000000 - 11644473600 ELSE 0 END AS expires,
    is_secure AS secure, is_httponly AS httpOnly, samesite AS sameSite, top_frame_site_key AS partitionSite,
    (SELECT value FROM meta WHERE key = 'version') AS version
  FROM cookies`;

const SAME_SITE: Record<number, ImportCookie['sameSite']> = { 0: 'no_restriction', 1: 'lax', 2: 'strict' };

async function chromiumCookies(rows: ChromiumCookie[], key: () => Promise<Buffer>): Promise<ImportCookie[]> {
  const now = Date.now() / 1000;
  const cookies: ImportCookie[] = [];
  for (const row of rows) {
    if (row.expires && row.expires < now) continue;
    let value = row.value ?? '';
    if (!value && row.encrypted) {
      const data = Buffer.from(row.encrypted, 'hex');
      if (data.subarray(0, 3).toString() !== 'v10') continue;
      let plain: Buffer;
      try {
        plain = decryptV10(data, await key());
      } catch (err) {
        // The keychain said no: nothing else will decrypt either.
        if (!(err instanceof Error) || !err.message.includes('keychain')) continue;
        throw err;
      }
      const hostHash = crypto.createHash('sha256').update(row.host).digest();
      if (Number(row.version) >= 24 && plain.subarray(0, 32).equals(hostHash)) plain = plain.subarray(32);
      value = plain.toString('utf8');
    }
    cookies.push({
      domain: row.host,
      name: row.name,
      value,
      path: row.path || '/',
      secure: !!row.secure,
      httpOnly: !!row.httpOnly,
      sameSite: SAME_SITE[row.sameSite] ?? 'unspecified',
      expires: row.expires || undefined,
      partitionSite: row.partitionSite || undefined,
    });
  }
  return cookies;
}

// ---- Chromium browsers not listed by name ------------------------------------

/** Folders with a `Local State` that are Flecha's own: its Chromium build's profile, and the Electron spike's. */
const FLECHA_FOLDERS = new Set(['Flecha Browser', 'Flecha']);
const PROFILE_DIR = /^(Default|Profile \d+)$/;

/**
 * Any other Chromium browser (Thorium, Chrome Beta, Sidekick…): a folder in Application Support,
 * or one level down (`X/User Data`, `Vendor/Product`), with a `Local State` and a `Default` or
 * `Profile N` profile that has bookmarks or history. Electron apps have a `Local State` too, but
 * keep no such profile. Browsers already listed by name are skipped.
 */
function otherChromiumSources(listed: BrowserSource[]): BrowserSource[] {
  const seen = new Set(listed.flatMap((s) => (s.root ? [realPath(s.root)] : [])));
  const apps = installedApps();
  const found: BrowserSource[] = [];
  for (const top of listDirs(appSupport())) {
    if (FLECHA_FOLDERS.has(top)) continue;
    const dir = appSupport(top);
    const roots = hasLocalState(dir) ? [dir] : listDirs(dir).map((d) => path.join(dir, d)).filter(hasLocalState);
    for (const root of roots) {
      const real = realPath(root);
      if (seen.has(real) || !hasChromiumProfile(root)) continue;
      seen.add(real);
      const rel = path.relative(appSupport(), root);
      const name = folderName(rel);
      found.push(unlistedChromiumSource(`chromium:${rel}`, appName(name, apps) ?? name, root));
    }
  }
  return found;
}

const ENCRYPTED = 'EncryptedBookmarks2';

/**
 * Some Chromium browsers (Dia) write their bookmarks to EncryptedBookmarks2 and stop updating
 * the plain Bookmarks file, so where both exist only the encrypted one is current. It's decrypted
 * like Dia's, with the "<name> Safe Storage" keychain item Chromium browsers usually keep; a
 * browser that names its item otherwise can still be imported from an exported HTML file.
 */
function unlistedChromiumSource(id: string, name: string, root: string): BrowserSource {
  const source = chromiumSource(id, name, root);
  return {
    ...source,
    profiles: () =>
      chromiumProfiles(root, [ENCRYPTED, 'Bookmarks', 'AccountBookmarks']).map((p) =>
        path.basename(p.bookmarkFiles[0] ?? '') === ENCRYPTED ? { ...p, bookmarkFiles: p.bookmarkFiles.slice(0, 1) } : p,
      ),
    readBookmarks: async (profile) => {
      const [file] = profile.bookmarkFiles;
      if (path.basename(file) !== ENCRYPTED) return source.readBookmarks(profile);
      const denied = `${name} keeps its bookmarks encrypted, with the key in your keychain. Choose Allow when macOS asks about “${name} Safe Storage”, or export them from ${name} as an HTML file and import that instead.`;
      return chromiumBookmarks([await decryptChromium(file, `${name} Safe Storage`, denied)]);
    },
  };
}

function hasLocalState(dir: string) {
  return isFile(path.join(dir, 'Local State'));
}

function hasChromiumProfile(root: string) {
  return listDirs(root).some((d) => PROFILE_DIR.test(d) && [ENCRYPTED, 'Bookmarks', 'History', 'Cookies'].some((f) => isFile(path.join(root, d, f))));
}

/** "BraveSoftware/Brave-Browser" → "Brave Browser", "Thorium/User Data" → "Thorium", "com.vendor.Name" → "Name". */
function folderName(rel: string) {
  const parts = rel.split(path.sep).filter((p) => p !== 'User Data');
  const last = parts[parts.length - 1] ?? rel;
  return (/^[a-z]+\.[^.]+\./i.test(last) ? last.slice(last.lastIndexOf('.') + 1) : last).replace(/[-_]+/g, ' ');
}

/** App names in /Applications and ~/Applications, without ".app". */
function installedApps() {
  return ['/Applications', path.join(os.homedir(), 'Applications')].flatMap((dir) => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.app')).map((f) => f.slice(0, -4));
    } catch {
      return [];
    }
  });
}

/**
 * The installed app a profile folder belongs to, for its proper name: "Chrome Beta" is
 * "Google Chrome Beta". The same letters, or the app's name ending in them; the shortest wins.
 */
function appName(folder: string, apps: string[]) {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = key(folder);
  if (want.length < 3) return undefined;
  const matches = apps.filter((a) => key(a) === want || key(a).endsWith(want));
  return matches.sort((a, b) => a.length - b.length)[0];
}

/** The real path, so a folder reached through a symlink or another case isn't listed twice. */
function realPath(dir: string) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

// ---- Firefox ---------------------------------------------------------------

/** Bookmarks and history both live in each profile's places.sqlite, cookies (unencrypted) in cookies.sqlite. */
function firefoxSource(): BrowserSource {
  const root = appSupport('Firefox', 'Profiles');
  return {
    id: 'firefox',
    name: 'Firefox',
    profiles: () =>
      listDirs(root).flatMap((dir) => {
        const places = path.join(root, dir, 'places.sqlite');
        const cookies = path.join(root, dir, 'cookies.sqlite');
        // Profile folders are named "<random>.<name>", e.g. "x1y2z3.default-release".
        return isFile(places)
          ? [{ name: dir.replace(/^[^.]+\./, ''), bookmarkFiles: [places], historyFile: places, cookiesFile: isFile(cookies) ? cookies : undefined }]
          : [];
      }),
    cookieReader: () => async (profile) => firefoxCookies(await querySqlite<FirefoxCookie>(profile.cookiesFile!, FIREFOX_COOKIES)),
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

interface FirefoxCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  /** Seconds since 1970 in older versions, milliseconds in newer ones. */
  expiry: number;
  secure: number;
  httpOnly: number;
  /** 0 none, 1 lax, 2 strict. */
  sameSite: number;
}

// Containers and partitioned cookies carry origin attributes; only the plain jar comes over.
const FIREFOX_COOKIES = `SELECT host, name, value, path, expiry, isSecure AS secure, isHttpOnly AS httpOnly, sameSite
  FROM moz_cookies WHERE originAttributes = ''`;

function firefoxCookies(rows: FirefoxCookie[]): ImportCookie[] {
  const now = Date.now() / 1000;
  return rows.flatMap((row): ImportCookie[] => {
    const expires = row.expiry > 1e11 ? Math.floor(row.expiry / 1000) : row.expiry;
    if (expires && expires < now) return [];
    // Firefox stores an unspecified SameSite as none, which Chromium refuses on a cookie that isn't secure.
    const sameSite = row.sameSite === 1 ? 'lax' : row.sameSite === 2 ? 'strict' : row.secure ? 'no_restriction' : 'unspecified';
    return [
      {
        domain: row.host,
        name: row.name,
        value: row.value ?? '',
        path: row.path || '/',
        secure: !!row.secure,
        httpOnly: !!row.httpOnly,
        sameSite,
        expires: expires || undefined,
      },
    ];
  });
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
  const listed = [
    ...CHROMIUM.map(([id, name, dir, safeStorage]) => chromiumSource(id, name, appSupport(dir), safeStorage)),
    arcSource(),
    diaSource(),
    firefoxSource(),
    safariSource(),
  ];
  return [...listed, ...otherChromiumSources(listed)];
}

/** Browsers on this Mac that have bookmarks or history to bring over. Only checks which files exist. */
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
          hasCookies: !!source.cookieReader && profiles.some((p) => !!p.cookiesFile),
        },
      ];
    } catch {
      return [];
    }
  });
}

/** Reads what the shell's `importBrowser` brings over, without adding it anywhere. */
export async function readBrowser(id: string): Promise<BrowserImportData> {
  const result: BrowserImportData = { name: id, bookmarkCount: 0, history: [], cookies: [], warnings: [] };
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
    const warning = message === FULL_DISK_ACCESS || message.includes('keychain') ? message : `Couldn’t read ${what}: ${message}`;
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
  const readCookies = source.cookieReader?.();
  // A browser's profiles are often signed in as different people; the first profile's login to a site wins.
  const cookies = new Map<string, ImportCookie>();
  let cookieProfiles = 0;
  let keychainRefused = false;
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
    if (profile.cookiesFile && readCookies && !keychainRefused) {
      try {
        const found = await readCookies(profile);
        if (found.length) cookieProfiles++;
        for (const c of found) {
          const id = [c.domain, c.name, c.path, c.partitionSite ?? ''].join('\n');
          if (!cookies.has(id)) cookies.set(id, c);
        }
      } catch (err) {
        // A refused keychain prompt is the same answer for every profile: don't ask again.
        keychainRefused = reason(err).includes('keychain');
        warn(keychainRefused ? 'cookies' : `cookies from ${label(profile)}`, err);
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
  result.cookies = [...cookies.values()];
  if (cookieProfiles > 1) {
    result.warnings.push(`Where more than one ${source.name} profile was signed in to the same site, the ${profiles[0].name} profile’s login was kept.`);
  }
  return result;
}

/**
 * Reads a bookmarks file exported from any browser as HTML, for browsers Flecha can't read
 * directly. The shell picks the file and sends its text. History has no such format.
 */
export function readBookmarksHtml(html: string, fileName = 'the file'): BrowserImportData {
  const result: BrowserImportData = { name: 'Imported Bookmarks', bookmarkCount: 0, history: [], cookies: [], warnings: [] };
  const tidy = newTidy();
  const nodes = tidy.run(parseBookmarksHtml(html));
  if (tidy.skipped) result.warnings.push(`Only the first ${MAX_BOOKMARKS} bookmarks were imported; ${tidy.skipped} more were left out.`);
  if (nodes.length) {
    result.bookmarks = nodes;
    result.bookmarkCount = tidy.count;
  } else {
    result.warnings.push(`No bookmarks were found in ${fileName}. Choose the HTML file a browser saves when it exports its bookmarks.`);
  }
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

/** Runs `make` the first time it's asked for, then hands back the same promise. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
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
