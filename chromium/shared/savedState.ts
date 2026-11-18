/**
 * The saved BrowserState, one JSON blob in extension storage. A blob that no longer parses or
 * has lost its shape must not keep the shell from starting: loading falls back to the copy that
 * last started the shell, and sets the damaged blob aside so it can still be recovered by hand.
 */
import type { BrowserState, ClosedWindow, FlechaWindow, PinnedNode, SavedSpace, TabInfo, WindowSpace } from './types';
import { isSiteHost } from './adBlockSites';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './sidebarWidth';

/**
 * The schema `Store.saveNow` writes. Version 2 gave each window its own active Space and, per
 * Space, its own Today tabs and selection; version 1 kept those on the Space itself (one window),
 * and blobs from before versioning have no `version`. Both read as one window.
 */
export const STATE_VERSION = 2;

export const STATE_KEY = 'state';
/** The last blob the shell started from, copied once a start finishes. */
export const LAST_GOOD_KEY = 'state:last-good';
/** The most recent blob that failed to load, kept only for recovery by hand. */
export const DAMAGED_KEY = 'state:damaged';
/** The state the last import replaced, kept so it can be restored. */
export const BEFORE_IMPORT_KEY = 'state:before-import';

/** The part of chrome.storage.StorageArea that loading needs. */
export interface StateArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface LoadedState {
  state: BrowserState | undefined;
  /** Why the saved state was not used as it was, when it wasn't. */
  recovered?: 'last-good' | 'fresh';
  /** Call once the shell has started from `state`: it becomes the last good copy. */
  started(): Promise<void>;
}

/**
 * Reads the saved state, recovering from damage: the last good copy replaces an unreadable
 * state, and when neither reads the shell starts fresh. Storage writes that fail are logged and
 * never keep a readable state from loading.
 */
export async function loadSavedState(area: StateArea): Promise<LoadedState> {
  const write = (items: Record<string, unknown>) =>
    area.set(items).catch((error) => console.error('Flecha: could not save the state backup', error));
  const { [STATE_KEY]: saved, [LAST_GOOD_KEY]: lastGood } = await area.get([STATE_KEY, LAST_GOOD_KEY]);
  const state = decodeState(saved);
  if (state) {
    // As repaired, before the shell changes it. It becomes the last good copy only once the
    // shell has started from it, so a state that reads but still breaks startup never does.
    const repaired = JSON.stringify({ version: STATE_VERSION, ...state });
    return { state, started: async () => void (repaired !== lastGood && (await write({ [LAST_GOOD_KEY]: repaired }))) };
  }
  if (saved === undefined) return { state: undefined, started: async () => {} };
  await write({ [DAMAGED_KEY]: saved });
  const fallback = decodeState(lastGood);
  if (!fallback) return { state: undefined, recovered: 'fresh', started: async () => {} };
  await write({ [STATE_KEY]: lastGood });
  return { state: fallback, recovered: 'last-good', started: async () => {} };
}

/** Keeps the current state (`Store.serialize`) before an import replaces it. */
export async function setAsideBeforeImport(area: StateArea, current: string) {
  await area.set({ [BEFORE_IMPORT_KEY]: current });
}

/** The state the last import replaced, or undefined when there is none that reads. */
export async function stateBeforeImport(area: StateArea): Promise<BrowserState | undefined> {
  return decodeState((await area.get([BEFORE_IMPORT_KEY]))[BEFORE_IMPORT_KEY]);
}

/**
 * A saved state, or undefined when it doesn't parse or lacks the Spaces and tabs the shell
 * needs. Smaller damage is repaired: only the fields the shell knows are kept, lists drop
 * entries for missing tabs and for tabs already placed earlier (favorites, then each Space's
 * pinned and Today lists), settings of the wrong type are dropped, and missing lists and a
 * missing active Space take their defaults.
 */
export function decodeState(json: unknown): BrowserState | undefined {
  if (typeof json !== 'string') return undefined;
  try {
    const raw: unknown = JSON.parse(json);
    const state = isRecord(raw) ? repairState(raw) : undefined;
    // The state goes to every Flecha page as a message: one that can't be copied that way
    // (nested too deep) would leave them without it.
    if (state) structuredClone(state);
    return state;
  } catch {
    // Unparseable, or nested deeper than repairing or sending it can go.
    return undefined;
  }
}

/** The same checks for a state that arrives already parsed, such as an imported state file. */
export function repairState(raw: Record<string, unknown>): BrowserState | undefined {
  if (!isRecord(raw.tabs) || !Array.isArray(raw.spaces)) return undefined;
  // fromEntries makes own properties, so no tab id can reach Object.prototype.
  const tabs: Record<string, TabInfo> = Object.fromEntries(
    Object.entries(raw.tabs).flatMap(([id, tab]) => (isRecord(tab) && typeof tab.url === 'string' ? [[id, repairTab(id, tab)]] : [])),
  );
  // Each tab sits in one place: the first list to claim it keeps it (favorites, then pinned
  // tabs, then each window's Today tabs).
  const placed = new Set<string>();
  const claim = (id: unknown): id is string => typeof id === 'string' && Object.hasOwn(tabs, id) && !placed.has(id) && !!placed.add(id);
  const favorites = Array.isArray(raw.favorites) ? raw.favorites.filter(claim) : [];
  const rawSpaces = raw.spaces.filter(isRecord).filter((s) => typeof s.id === 'string');
  const spaces = rawSpaces.map((s) => repairSpace(s, claim));
  if (!spaces.length) return undefined;
  const spaceIds = new Set(spaces.map((s) => s.id));
  const window = (w: Record<string, unknown>) => repairWindow(w, spaceIds, spaces[0].id, claim, (id) => placed.has(id as string));
  // Before version 2 each Space held the Today tabs and selection of the one window.
  const rawWindows = Array.isArray(raw.windows)
    ? raw.windows.filter(isRecord)
    : [{ id: crypto.randomUUID(), activeSpaceId: raw.activeSpaceId, spaces: Object.fromEntries(rawSpaces.map((s) => [s.id, s])) }];
  const windows = rawWindows.map(window);
  if (!windows.length) windows.push({ id: crypto.randomUUID(), activeSpaceId: spaces[0].id, spaces: {} });
  const closedWindows: ClosedWindow[] = (Array.isArray(raw.closedWindows) ? raw.closedWindows.filter(isRecord) : [])
    .filter((w) => isNumber(w.closedAt))
    .map((w) => ({ ...window(w), closedAt: w.closedAt as number }))
    .filter((w) => Object.keys(w.spaces).length);
  const settings = pick(raw, Object.keys(SETTINGS));
  dropInvalid(settings, SETTINGS);
  if (Array.isArray(settings.environments)) {
    settings.environments = settings.environments.map((env) => ({
      id: env.id,
      name: env.name,
      targets: env.targets.map(({ label, origin, autoLabel }: Record<string, unknown>) =>
        ({ label, origin, ...(typeof autoLabel === 'boolean' ? { autoLabel } : {}) })),
    }));
  }
  return {
    ...settings,
    spaces,
    windows,
    closedWindows,
    tabs,
    favorites,
    archive: Array.isArray(raw.archive)
      ? raw.archive.filter((a) => isRecord(a) && typeof a.url === 'string' && typeof a.title === 'string' && typeof a.closedAt === 'number').map((a) => pick(a, ['url', 'title', 'closedAt']))
      : [],
    sidebarVisible: typeof raw.sidebarVisible === 'boolean' ? raw.sidebarVisible : true,
  } as unknown as BrowserState;
}

type Check = (value: unknown) => boolean;
const isString: Check = (v) => typeof v === 'string';
const isBoolean: Check = (v) => typeof v === 'boolean';
const isNumber: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const oneOf = (...values: unknown[]): Check => (v) => values.includes(v);
const recordOf = (check: Check): Check => (v) => isRecord(v) && Object.values(v).every(check);
const fields = (shape: Record<string, Check>, optional: string[] = []): Check => (v) =>
  isRecord(v) && Object.entries(shape).every(([k, check]) => (optional.includes(k) && v[k] === undefined) || check(v[k]));

/** Optional settings, by the type the shell reads them as (types.d.ts BrowserState). */
const SETTINGS: Record<string, Check> = {
  window: fields({ x: isNumber, y: isNumber, width: isNumber, height: isNumber, maximized: isBoolean }, ['maximized']),
  theme: oneOf('system', 'light', 'dark'),
  sidebarWidth: (v) => isNumber(v) && (v as number) >= SIDEBAR_MIN_WIDTH && (v as number) <= SIDEBAR_MAX_WIDTH,
  peekPinnedLinks: isBoolean,
  openLinksInFlechinha: isBoolean,
  sidebarInPageFullscreen: isBoolean,
  archiveAfterHours: (v) => isNumber(v) && (v as number) >= 0,
  sitePermissions: recordOf(recordOf(oneOf('allow', 'block'))),
  searchEngine: oneOf('google', 'duckduckgo', 'bing', 'brave', 'kagi', 'ecosia'),
  downloadsFolder: isString,
  askWhereToSave: isBoolean,
  environments: (v) => Array.isArray(v) && v.every(fields({ id: isString, name: isString, targets: (t) => Array.isArray(t) && t.every(fields({ label: isString, origin: isString })) })),
  adBlock: isBoolean,
  // One bad hostname would make Chromium refuse the whole allow rule (features/adblock.ts).
  adBlockAllowed: (v) => Array.isArray(v) && v.every((host) => isString(host) && isSiteHost(host)),
  agent: fields({ enabled: isBoolean, token: isString }),
  onboarded: isBoolean,
  keybindings: recordOf((v) => v === null || isString(v)),
};

const TAB_FIELDS: Record<string, Check> = {
  favicon: isString,
  customTitle: isString,
  muted: isBoolean,
  device: oneOf('mobile'),
  homeUrl: isString,
  unseen: isBoolean,
  agent: isBoolean,
  history: fields({ index: isNumber, entries: (e) => Array.isArray(e) && e.every(fields({ url: isString, title: isString, pageState: isString }, ['pageState'])) }),
};

const SPACE_FIELDS: Record<string, Check> = {
  emoji: isString,
  isolated: isBoolean,
  pinnedCollapsed: isBoolean,
};

const WINDOW_SPACE_FIELDS: Record<string, Check> = {
  splitMode: oneOf('responsive'),
  splitRatio: (v) => isNumber(v) && (v as number) > 0 && (v as number) < 1,
};

/** The `keys` of `raw` that it has. */
function pick(raw: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
}

/** Deletes the keys of `checks` whose value is present and fails its check. */
function dropInvalid(target: Record<string, unknown>, checks: Record<string, Check>) {
  for (const [key, check] of Object.entries(checks)) if (target[key] !== undefined && !check(target[key])) delete target[key];
}

function repairTab(id: string, raw: Record<string, unknown>): TabInfo {
  const tab: Record<string, unknown> = { ...pick(raw, Object.keys(TAB_FIELDS)), id, url: raw.url, title: typeof raw.title === 'string' ? raw.title : raw.url, lastActive: Number(raw.lastActive) || 0 };
  dropInvalid(tab, TAB_FIELDS);
  if (isRecord(tab.history)) tab.history = { index: tab.history.index, entries: (tab.history.entries as Record<string, unknown>[]).map((e) => pick(e, ['url', 'title', 'pageState'])) };
  return tab as unknown as TabInfo;
}

function repairSpace(raw: Record<string, unknown>, claim: (id: unknown) => id is string): SavedSpace {
  const space = {
    ...pick(raw, ['id', ...Object.keys(SPACE_FIELDS)]),
    name: typeof raw.name === 'string' ? raw.name : 'Space',
    color: typeof raw.color === 'string' ? raw.color : '#cdd9f7',
    pinned: Array.isArray(raw.pinned) ? repairPinned(raw.pinned, claim) : [],
  };
  dropInvalid(space, SPACE_FIELDS);
  return space as unknown as SavedSpace;
}

function repairWindow(
  raw: Record<string, unknown>,
  spaceIds: Set<string>,
  firstSpaceId: string,
  claim: (id: unknown) => id is string,
  placed: (id: unknown) => boolean,
): FlechaWindow {
  const spaces: Record<string, WindowSpace> = {};
  for (const [spaceId, ws] of isRecord(raw.spaces) ? Object.entries(raw.spaces) : []) {
    if (spaceIds.has(spaceId) && isRecord(ws)) spaces[spaceId] = repairWindowSpace(ws, claim, placed);
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
    activeSpaceId: typeof raw.activeSpaceId === 'string' && spaceIds.has(raw.activeSpaceId) ? raw.activeSpaceId : firstSpaceId,
    spaces,
    ...(typeof raw.sidebarVisible === 'boolean' ? { sidebarVisible: raw.sidebarVisible } : {}),
  };
}

function repairWindowSpace(raw: Record<string, unknown>, claim: (id: unknown) => id is string, placed: (id: unknown) => boolean): WindowSpace {
  const ws = { ...pick(raw, ['activeTabId', 'split', ...Object.keys(WINDOW_SPACE_FIELDS)]), today: Array.isArray(raw.today) ? raw.today.filter(claim) : [] } as WindowSpace;
  dropInvalid(ws as unknown as Record<string, unknown>, WINDOW_SPACE_FIELDS);
  if (ws.activeTabId !== undefined && !placed(ws.activeTabId)) delete ws.activeTabId;
  if (ws.split && !(Array.isArray(ws.split) && ws.split.length === 2 && ws.split.every(placed))) {
    delete ws.split;
    delete ws.splitMode;
  }
  return ws;
}

function repairPinned(nodes: unknown[], claim: (id: unknown) => id is string): PinnedNode[] {
  return nodes.flatMap((n): PinnedNode[] => {
    if (!isRecord(n)) return [];
    if (n.kind === 'tab') return claim(n.tabId) ? [{ kind: 'tab', tabId: n.tabId }] : [];
    if (n.kind !== 'folder' || typeof n.id !== 'string') return [];
    const children = Array.isArray(n.children) ? repairPinned(n.children, claim) : [];
    return [{ kind: 'folder', id: n.id, name: typeof n.name === 'string' ? n.name : 'Folder', open: n.open === true, children }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
