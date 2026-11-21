/**
 * The shell's side of Flecha's native patches (0016+): what chrome.flechaPrivate does beyond
 * the window frame. background.ts calls registerNative(ctx) once, after the Store is loaded.
 *
 * Every call checks that the API is there, so the shell still runs on a Chromium without the
 * patch (stock Chromium, or a build older than the shell).
 */
import type { Store } from '../shared/store';
import { pinnedTabIds } from '../shared/store';
import { SHORTCUTS, fixedShortcuts, keysFor } from './lib/shortcuts';
import { broadcast, broadcastTo, callerPort, callerWindow, handle } from './hub';
import { incognito, sessionKey } from './incognito';
import { phoneSplitRatio } from './lib/responsiveViewport';

export interface NativeContext {
  store: Store;
  /**
   * Runs one of Flecha's commands, by id: every id in lib/shortcuts.ts (newTab,
   * toggleSidebar, …), plus `selectTab:1`…`selectTab:9` (⌘1…⌘9; 9 is the last tab) and
   * `selectSpace:1`…`selectSpace:9` (⌃1…⌃9). `windowId` is the window the key was pressed in.
   */
  run(command: string, windowId?: number): void;
  /** The modifier keys held for `command` were released (patch 0057's onShortcutReleased). */
  released?(command: string, windowId: number): void;
  /** The Chromium tab of an open Flecha tab (background.ts's `live` map). */
  chromeTabId?(flechaId: string): number | undefined;
  /** The Flecha tab of a Chromium tab. */
  flechaTabId?(chromeId: number): string | undefined;
  /** The Flecha window of a Chromium window. */
  flechaWindowId?(chromeId: number): string | undefined;
  /**
   * Forgets a Flecha tab's Chromium tab without closing it (it moved into a Flechinha), then
   * closes the Flecha tab. background.ts: `live.delete(id); rememberLive(); store.closeTab(id)`.
   */
  releaseTab?(flechaId: string): void;
  /**
   * A Chromium tab that moved into the main window ("Open in Flecha" from a Flechinha)
   * becomes an active Today tab in the active Space, like onCreated does for new tabs.
   */
  adoptTab?(chromeId: number): void;
}

const api = () => (chrome as { flechaPrivate?: typeof chrome.flechaPrivate }).flechaPrivate;
const has = <K extends keyof typeof chrome.flechaPrivate>(name: K) => typeof api()?.[name] === 'function';

/**
 * The last Peek in each window, from onPeekChanged. The browser can't be asked (patch 0026).
 */
const PEEKS_KEY = sessionKey('peeks');
const peeks = new Map<number, chrome.flechaPrivate.PeekState>();
const legacyPeeks = new Set<number>();
const savePeeks = () => chrome.storage.session.set({ [PEEKS_KEY]: [...legacyPeeks, ...peeks] })
  .catch((error) => console.warn('Flecha shell: couldn’t save Peek state', error));
const peeksLoaded = has('openPeek')
  ? chrome.storage.session.get(PEEKS_KEY).then(async (saved) => {
    const entries = saved[PEEKS_KEY];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry === 'number') {
        try { await chrome.flechaPrivate.closePeek(entry); }
        catch { legacyPeeks.add(entry); }
      }
      else if (Array.isArray(entry) && typeof entry[0] === 'number' && entry[1]) peeks.set(entry[0], entry[1]);
    }
    if (entries.some((entry) => typeof entry === 'number')) await savePeeks();
  }).catch((error) => console.warn('Flecha shell: couldn’t recover saved Peek state', error))
  : Promise.resolve();

// Events go on in the module's first turn, or Chromium drops the one that woke the
// background; they wait here until registerNative() hands over the context and the
// saved Peeks are back.
let resolveCtx!: (ctx: NativeContext) => void;
const ready = Promise.all([new Promise<NativeContext>((resolve) => (resolveCtx = resolve)), peeksLoaded]).then(([ctx]) => ctx);
const when =
  <A extends unknown[]>(fn: (ctx: NativeContext, ...args: A) => void) =>
  (...args: A) =>
    void ready.then((ctx) => fn(ctx, ...args));

if (has('setShortcuts')) chrome.flechaPrivate.onShortcut.addListener(when((ctx, command: string, windowId: number) => ctx.run(command, windowId)));
if (typeof chrome.flechaPrivate?.onShortcutReleased?.addListener === 'function') {
  chrome.flechaPrivate.onShortcutReleased.addListener(when((ctx, command: string, windowId: number) => ctx.released?.(command, windowId)));
}

export function registerNative(ctx: NativeContext) {
  registerShortcuts(ctx);
  registerTheme(ctx);
  registerSplitRatio(ctx);
  registerFlechinha(ctx);
  registerPeek(ctx);
  registerDevToolsAndDefaultBrowser();
  resolveCtx(ctx);
}

// ---- DevTools and the default browser (patch 0027) -----------------------------------------

const activeTabId = async () =>
  (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ??
  (await chrome.tabs.query({ active: true, windowType: 'normal' }))[0]?.id;

/** { isDefault, canSet }, as UiState.defaultBrowser and Settings want it. */
export async function defaultBrowserState() {
  if (!has('isDefaultBrowser')) return { isDefault: false, canSet: false };
  return chrome.flechaPrivate.isDefaultBrowser();
}

/**
 * Hub commands: openDevTools(options?) on the active tab (options.console: the Console
 * panel), devTools() toggles them (⌥⌘I), makeDefaultBrowser() asks macOS and resolves with the
 * new state; isDefaultBrowser() resolves with it.
 */
function registerDevToolsAndDefaultBrowser() {
  if (!has('openDevTools')) return;
  const devTools = async (options: chrome.flechaPrivate.DevToolsOptions) => {
    const tabId = await activeTabId();
    if (tabId !== undefined) await chrome.flechaPrivate.openDevTools(tabId, options);
  };
  handle({
    openDevTools: (options?: { console?: boolean }) => devTools({ console: !!options?.console }),
    devTools: () => devTools({ toggle: true }),
    isDefaultBrowser: () => defaultBrowserState(),
    // ⌘F: Chromium's find bar, at the page area's top right (patch 0030).
    ...(has('showFindBar') ? { find: () => chrome.flechaPrivate.showFindBar() } : {}),
    makeDefaultBrowser: () => chrome.flechaPrivate.makeDefaultBrowser(),
  });
}

// ---- Peek (patch 0026) -------------------------------------------------------------------

/**
 * A Peek answers ⌘W (closes it) and ⌘O (keeps its page as a tab) as a Flechinha does, not the
 * tab behind it. Returns whether `command` was the Peek's.
 */
export function runInPeek(command: string, windowId: number | undefined) {
  if (windowId === undefined || (!peeks.has(windowId) && !legacyPeeks.has(windowId))) return false;
  let action: Promise<unknown>;
  if (command === 'closeTab') action = chrome.flechaPrivate.closePeek(windowId);
  else if (command === 'openInFlecha') action = chrome.flechaPrivate.promotePeek(windowId);
  else return false;
  void action.then(() => {
    if (legacyPeeks.delete(windowId)) return savePeeks();
  }).catch((error) => console.warn('Flecha shell: couldn’t finish Peek action', error));
  return true;
}

export function currentPeek(windowId: number, send: (peek: chrome.flechaPrivate.PeekState | null) => void) {
  void ready.then(() => send(peeks.get(windowId) ?? null));
}

// The frame pages draw Peek's backdrop and toolbar from the 'peek' event, as in Electron's
// sendPeek(); while a Peek is open the browser keeps the frame over the whole window.
if (has('openPeek')) {
  const rememberPeek = (windowId: number, peek?: chrome.flechaPrivate.PeekState) => {
    const wasLegacy = legacyPeeks.delete(windowId);
    if (peek) peeks.set(windowId, peek);
    else if (!peeks.delete(windowId) && !wasLegacy) return;
    void savePeeks();
  };
  chrome.flechaPrivate.onPeekChanged.addListener(
    when((_ctx, windowId: number, peek?: chrome.flechaPrivate.PeekState) => {
      rememberPeek(windowId, peek);
      // Each window has its own Peek, and its own toolbar for it.
      broadcastTo(windowId, 'peek', peek ?? null, windowId);
    }),
  );
  // A window closes without saying its Peek did.
  chrome.windows.onRemoved.addListener(when((_ctx, windowId: number) => rememberPeek(windowId)));
  chrome.contextMenus.onClicked.addListener(
    when((_ctx, info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
      if (info.menuItemId === PEEK_MENU_ID && info.linkUrl) void openLinkInPeek(info.linkUrl, tab);
    }),
  );
}

/** "Open in Peek" on every web link's context menu. */
const PEEK_MENU_ID = 'flecha-open-in-peek';

/**
 * A link's Peek: in the window the link is in (a Flechinha has no Peek, so Flecha's main
 * window), and in the storage partition of the tab it is on, so a Space with separate cookies
 * keeps its logins. A link inside a Peek has no tab; it replaces that Peek.
 */
async function openLinkInPeek(url: string, tab?: chrome.tabs.Tab) {
  const windowId = tab?.windowId !== undefined && tab.windowId >= 0 && !(await isFlechinhaWindow(tab.windowId)) ? tab.windowId : undefined;
  const source = tab?.id !== undefined && tab.id >= 0 ? tab.id : undefined;
  // A browser without patch 0055 takes no source tab; the Peek then has the profile's storage.
  await chrome.flechaPrivate.openPeek(url, windowId, source).catch(() => chrome.flechaPrivate.openPeek(url, windowId));
}

/**
 * Hub commands openPeek(url), closePeek(), promotePeek() (the shell then adopts the new tab
 * through tabs.onCreated). Links leaving pinned tabs and favorites open in Peek while
 * state.peekPinnedLinks isn't false, natively (setPeekTabs).
 */
function registerPeek(ctx: NativeContext) {
  if (!has('openPeek')) return;
  // Made again on every start: menu items outlive the background, and creating one twice fails.
  chrome.contextMenus.removeAll(() =>
    chrome.contextMenus.create({ id: PEEK_MENU_ID, title: 'Open in Peek', contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] }),
  );
  handle({
    // In the window of the page that asks (a keyboard shortcut's window); the last active one otherwise.
    openPeek: (url: string) => void chrome.flechaPrivate.openPeek(String(url), callerWindow()),
    // The context menu item's action, for tests: `tabId` is the tab whose link it is.
    openLinkInPeek: async (url: string, tabId?: number) => openLinkInPeek(String(url), tabId === undefined ? undefined : await chrome.tabs.get(tabId)),
    closePeek: () => void chrome.flechaPrivate.closePeek(callerWindow()),
    promotePeek: () => void chrome.flechaPrivate.promotePeek(callerWindow()),
  });

  // The browser keeps one list for every window; an incognito window has no pinned tabs.
  if (!ctx.chromeTabId || incognito) return;
  let sent = '';
  const apply = () => {
    const { state } = ctx.store;
    const ids =
      state.peekPinnedLinks === false
        ? []
        : [...state.favorites, ...state.spaces.flatMap(space => pinnedTabIds(space.pinned))]
            .map((id) => ctx.chromeTabId!(id))
            .filter((id): id is number => id !== undefined)
            .sort((a, b) => a - b);
    const key = ids.join(',');
    if (key === sent) return;
    sent = key;
    void chrome.flechaPrivate.setPeekTabs(ids);
  };
  apply();
  ctx.store.onChange((_change, detail) => { if (!detail) apply(); });
  // A pinned tab gets its Chromium tab when it's first opened.
  const soon = () => setTimeout(apply, 0);
  chrome.tabs.onCreated.addListener(soon);
  chrome.tabs.onRemoved.addListener(soon);
}

// ---- Flechinha (patch 0023) --------------------------------------------------------------

/**
 * Flechinha, the small window for one page, as in the Electron version. Its frame page is
 * window.html?window=<id>&kind=flechinha. Hub commands:
 *  - newFlechinha(): an empty one (the new tab page), ⌥⌘N.
 *  - openFlechinha(url?, tabId?): with a Flecha tab id, that tab's page moves into it and the
 *    Flecha tab closes; otherwise it opens `url`.
 *  - flechinha:openInFlecha(windowId): its page moves back as an active Today tab.
 * Windows that are Flechinhas aren't Flecha's: isFlechinha(windowId) tells them apart.
 */
const flechinhas = new Set<number>();
/** Whether a window is a Flechinha, from what this module has seen (synchronous, may lag). */
export const isFlechinha = (windowId: number | undefined) => windowId !== undefined && flechinhas.has(windowId);
/**
 * Whether a window is a Flechinha, asking the browser. Use this in tabs.onCreated: the event
 * for a new Flechinha's first tab arrives before openFlechinha() resolves. The browser also
 * opens Flechinhas of its own (links from other apps), which only this finds.
 */
export async function isFlechinhaWindow(windowId: number | undefined) {
  if (windowId === undefined || !has('getFlechinhas')) return false;
  if (flechinhas.has(windowId)) return true;
  const ids = await chrome.flechaPrivate.getFlechinhas();
  ids.forEach((id) => flechinhas.add(id));
  return flechinhas.has(windowId);
}

function registerFlechinha(ctx: NativeContext) {
  if (!has('openFlechinha')) return;
  // Links from other apps (Flecha as the default browser) go to a Flechinha unless turned off.
  let linksSent: boolean | undefined;
  const applyLinks = () => {
    const enabled = ctx.store.state.openLinksInFlechinha !== false;
    if (enabled === linksSent) return;
    linksSent = enabled;
    void chrome.flechaPrivate.setOpenLinksInFlechinha(enabled);
  };
  // The regular shell's choice; links from other apps never go to an incognito window.
  if (!incognito) {
    applyLinks();
    ctx.store.onChange((_change, detail) => { if (!detail) applyLinks(); });
  }
  void chrome.flechaPrivate.getFlechinhas().then((ids) => ids.forEach((id) => flechinhas.add(id)));
  chrome.windows.onRemoved.addListener((id) => flechinhas.delete(id));

  async function open(url?: string, flechaId?: string) {
    const tabId = flechaId !== undefined ? ctx.chromeTabId?.(flechaId) : undefined;
    const windowId = await chrome.flechaPrivate.openFlechinha(tabId !== undefined ? { tabId } : url ? { url } : {});
    flechinhas.add(windowId);
    if (tabId !== undefined && flechaId !== undefined) ctx.releaseTab?.(flechaId);
    return windowId;
  }

  handle({
    newFlechinha: () => open(),
    openFlechinha: (url?: string, tabId?: string) => open(typeof url === 'string' ? url : undefined, typeof tabId === 'string' ? tabId : undefined),
    'flechinha:openInFlecha': async (windowId: number) => {
      const tabId = await chrome.flechaPrivate.openInFlecha(Number(windowId));
      ctx.adoptTab?.(tabId);
    },
  });
}

// ---- split ratio (patch 0019) ------------------------------------------------------------

let applySplitRatio: ((windowId: string, reset?: boolean) => void) | undefined;

export function frameResized(windowId: string) {
  applySplitRatio?.(windowId);
}

if (has('setSplitRatio')) {
  // Keep a user-selected ratio in a regular split and restore the phone width in a responsive split.
  chrome.flechaPrivate.onSplitRatioChanged.addListener(
    when((ctx, tabId: number, ratio: number) => {
      const id = ctx.flechaTabId?.(tabId);
      const windowId = id && ctx.store.windowShowing(id);
      if (!windowId) return;
      const space = ctx.store.activeSpaceIn(windowId);
      if (space.split?.[0] !== id) return;
      if (space.splitMode === 'responsive') applySplitRatio?.(windowId, true);
      else ctx.store.setSplitRatio(ratio, windowId);
    }),
  );
}

/** Each window's active Space's splitRatio on Chromium's split (patch 0019 also draws it flat, 8px apart). */
function registerSplitRatio(ctx: NativeContext) {
  const { store, chromeTabId } = ctx;
  if (!has('setSplitRatio') || !chromeTabId) return;
  const splitAreaResized = chrome.flechaPrivate.onSplitAreaResized;
  const measurements = new Map<string, {
    request?: symbol;
    needsReset?: boolean;
    applied?: { splitId: number; ratio: number };
    writing?: Promise<void>;
  }>();

  const applyWindow = async (windowId: string, reset = false) => {
    const measurement = measurements.get(windowId) ?? {};
    const request = Symbol();
    measurement.request = request;
    if (reset) measurement.needsReset = true;
    measurements.set(windowId, measurement);
    await measurement.writing;
    if (measurement.request !== request || !store.hasWindow(windowId)) return;
    if (measurement.needsReset) {
      measurement.applied = undefined;
      measurement.needsReset = false;
    }
    const space = store.activeSpaceIn(windowId);
    const split = space.split;
    if (space.splitMode === 'responsive' && (!space.activeTabId || !split?.includes(space.activeTabId))) return;
    const left = split && chromeTabId(split[0]);
    const right = split && chromeTabId(split[1]);
    if (left === undefined || right === undefined) {
      measurement.applied = undefined;
      return;
    }
    const [desktop, other] = await Promise.all([chrome.tabs.get(left), chrome.tabs.get(right)]).catch(() => []);
    if (measurement.request !== request || !store.hasWindow(windowId) ||
        store.activeSpaceIn(windowId).split !== split) return;
    const splitId = desktop?.splitViewId;
    if (splitId === undefined || splitId < 0 || other?.splitViewId !== splitId) return;
    let ratio = space.splitRatio ?? 0.5;
    if (space.splitMode === 'responsive') {
      if (!desktop.width || !other.width) return;
      ratio = phoneSplitRatio(desktop.width + other.width);
      if (!splitAreaResized) ratio = Math.min(0.9, ratio);
    }
    const previous = measurement.applied;
    if (previous?.splitId === splitId && previous.ratio === ratio) return;
    const write = ratio > 0.9 ? chrome.flechaPrivate.setSplitRatio(left, ratio, true) : chrome.flechaPrivate.setSplitRatio(left, ratio);
    measurement.writing = write
      .then(() => { measurement.applied = { splitId, ratio }; })
      .catch(() => { measurement.applied = undefined; })
      .finally(() => { measurement.writing = undefined; });
  };

  const apply = () => {
    for (const id of measurements.keys()) {
      if (!store.hasWindow(id)) measurements.delete(id);
    }
    for (const win of store.state.windows) void applyWindow(win.id);
  };
  applySplitRatio = applyWindow;
  apply();
  store.onChange((change) => {
    if (change === 'structure') apply();
  });
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if ('splitViewId' in info) apply();
  });
  chrome.windows.onBoundsChanged.addListener(apply);
}

chrome.flechaPrivate?.onSplitAreaResized?.addListener(when((ctx, chromeWindowId: number) => {
  const windowId = ctx.flechaWindowId?.(chromeWindowId);
  if (windowId) frameResized(windowId);
}));

// ---- theme (patch 0018) ------------------------------------------------------------------

/** Settings' Appearance: Chromium's UI and pages' prefers-color-scheme follow state.theme. */
function registerTheme(ctx: NativeContext) {
  // The theme is the regular profile's; incognito windows are always dark (patch 0032).
  if (!has('setTheme') || incognito) return;
  let sent: string | undefined;
  const apply = () => {
    const theme = ctx.store.state.theme ?? 'system';
    if (theme === sent) return;
    sent = theme;
    void chrome.flechaPrivate.setTheme(theme);
  };
  apply();
  ctx.store.onChange((_change, detail) => { if (!detail) apply(); });
}

// ---- keyboard shortcuts (patch 0016) ----------------------------------------------------

/** Accelerator → command id, as setShortcuts() wants it: the fixed families, then yours. */
export function shortcutMap(state: Store['state']): Record<string, string> {
  const map = fixedShortcuts();
  for (const { id } of SHORTCUTS) {
    const keys = keysFor(state, id);
    if (keys) map[keys] = id;
  }
  return map;
}

function registerShortcuts(ctx: NativeContext) {
  if (!has('setShortcuts')) return;
  let sent = '';
  let applying = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  // Use the shell port's recovery cadence for another transient Chromium connection failure.
  let retryDelay = 100;
  // While Settings records a shortcut the keys go to its page, not to Flecha's commands.
  let recorder: chrome.runtime.Port | undefined;
  const apply = () => {
    // The browser keeps one map for every window; the regular shell sets it.
    if (incognito || applying || retry !== undefined) return;
    const map = recorder ? {} : shortcutMap(ctx.store.state);
    const json = JSON.stringify(map);
    if (json === sent) return;
    applying = true;
    void Promise.resolve().then(() => chrome.flechaPrivate.setShortcuts(map)).then((rejected) => {
      sent = json;
      retryDelay = 100;
      if (rejected.length) console.warn('Flecha shell: the browser could not read these shortcuts', rejected);
    }, (error: unknown) => {
      console.warn('Flecha shell: could not apply shortcuts', error);
      retry = setTimeout(() => {
        retry = undefined;
        apply();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    }).finally(() => {
      applying = false;
      apply();
    });
  };
  const stopRecording = () => {
    recorder?.onDisconnect.removeListener(stopRecording);
    recorder = undefined;
    apply();
  };
  apply();
  ctx.store.onChange((_change, detail) => { if (!detail) apply(); });
  handle({
    'settings:recording': (on: boolean) => {
      const port = callerPort();
      if (!port || (on ? recorder === port : recorder !== port)) return;
      if (!on) return stopRecording();
      recorder?.onDisconnect.removeListener(stopRecording);
      recorder = port;
      port.onDisconnect.addListener(stopRecording);
      apply();
    },
  });
}
