/**
 * The shell's background: Flecha's Store, kept in step with real Chromium tabs.
 *
 * The Store is the source of truth, as in Electron. A Flecha tab only gets a Chromium tab
 * once it is opened (like Electron only made a view for it then), so a sidebar of a hundred
 * pinned tabs costs nothing until you use them. Chromium tabs that pages open themselves
 * (links to a new tab, window.open) become Flecha tabs.
 */
import { Store, findFolder, linkRuleSpace, pinnedTabIds, type StatePersistence } from '../shared/store';
import { isBrowserPage, resolveInput, searchEngine } from './lib/url';
import { shortcutHints, type ShortcutId } from './lib/shortcuts';
import { describe as describeEnvironment } from './lib/environments';
import type { BrowserState, DropTarget, PinnedNode, SearchEngineId, TabInfo, UiState, WindowView } from '../shared/types';
import { broadcast, broadcastEach, call, callAs, caller, flashIn, handle, listen, onConnect, sendToWindow, type Page } from './hub';
import { drmSite } from './lib/drm';
import { hold, release, send } from './features/debuggee';
import type { MenuRun } from './protocol';
import type { MenuEntry } from './settingsUi';
import { openSettings, registerSettings } from './settingsHandlers';
import { registerNativeHost } from './nativeHost';
import { SiteIcons } from './siteIcons';
// Loaded on the first turn: its modules add webNavigation and message listeners as they load.
import { registerFeatures, type Features } from './features';
// Also loaded on the first turn, for the shortcut event that may have woken the background.
import { defaultBrowserState, flechinhaWindows, isFlechinhaWindow, registerNative } from './native';
import { registerDownloads } from './downloads';
// Loaded on the first turn too: it listens for the other copy of the shell.
import { cycleWindow } from './windowCycle';
import { stepRecent, type RecentWalk } from './lib/recentTabs';
import { registerExtensions } from './extensions';
import { registerSiteControls } from './siteControls';
import { Favicons } from './favicons';
import { tabHistory } from './lib/tabHistory';
import { navigateTab } from './lib/navigate';
import { followedPreferences, incognito, incognitoState, sessionKey } from './incognito';

const STATE_KEY = 'state';
/** Flecha tab id ↔ Chromium tab id, for the tabs that are open. Kept across background restarts. */
const LIVE_KEY = 'live';
/** Each window's view of the Store, by window id, the window last in front first. Kept across background restarts. */
const VIEWS_KEY = 'views';
const ARCHIVE_ALARM = 'archive-stale';

const live = new Map<string, number>();
const flechaIdFor = (chromeId: number) => [...live].find(([, c]) => c === chromeId)?.[0];
/** Chromium tabs we're closing ourselves, so their events aren't taken as the user's. */
const ours = new Set<number>();
/** Tabs we're creating right now: Chromium may announce them before create() returns their id. */
let creating = 0;

/**
 * One of Flecha's main windows. The Spaces and tabs are everyone's (the Store); a window has
 * its own view of them, its own command bar and overlays, and its own page history buttons.
 */
interface Win {
  /** The Chromium window. -1: not open yet (a tab was asked for while Flecha had no window). */
  id: number;
  view: WindowView;
  frame: { paletteOpen: boolean; sidebarPeek: boolean; tabDragging: boolean; overlays: Set<string> };
  nav: UiState['nav'];
  navAsked: number;
  /** Tabs selected in its sidebar (⌘- or ⇧-click), in sidebar order. Not saved. */
  selected: string[];
  /** A blank tab that keeps the window open while it shows none of Flecha's tabs. */
  placeholder?: number;
  /** Recent tab (lib/recentTabs.ts): where its walk back through this window's tabs is. */
  recentWalk?: RecentWalk;
}

/** The window each Chromium tab is in, for pages that are tabs (a new tab page) to know theirs. */
const tabWindows = new Map<number, number>();
chrome.tabs.onCreated.addListener((tab) => tab.id !== undefined && void tabWindows.set(tab.id, tab.windowId));
chrome.tabs.onAttached.addListener((tabId, info) => void tabWindows.set(tabId, info.newWindowId));
chrome.tabs.onRemoved.addListener((tabId) => void tabWindows.delete(tabId));

const parseState = (json: unknown) => {
  try {
    return typeof json === 'string' ? (JSON.parse(json) as BrowserState) : undefined;
  } catch {
    return undefined;
  }
};

async function start() {
  const saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] as string | undefined;
  // An incognito window's tabs live in session storage, under keys of its own (incognito.ts);
  // the regular state only gives it your preferences.
  const own = incognito ? ((await chrome.storage.session.get(sessionKey(STATE_KEY)))[sessionKey(STATE_KEY)] as string | undefined) : saved;
  const persistence: StatePersistence = incognito
    ? {
        load: () => parseState(own) ?? incognitoState(parseState(saved)),
        save: (json) => void chrome.storage.session.set({ [sessionKey(STATE_KEY)]: json }),
      }
    : {
        load: () => (saved ? (JSON.parse(saved) as BrowserState) : undefined),
        save: (json) => void chrome.storage.local.set({ [STATE_KEY]: json }),
      };
  const store = new Store(persistence);
  for (const tab of await chrome.tabs.query({})) if (tab.id !== undefined) tabWindows.set(tab.id, tab.windowId);

  // ---- the windows --------------------------------------------------------------------
  // The Store is one, for every window; each main window has a view of it (store.ts,
  // WindowView). A command acts on the window it came from (here()), a Chromium event on the
  // window it happened in. Flechinhas and popups aren't main windows.

  const wins = new Map<number, Win>();
  /** Stands in while Flecha has no window: a tab opened into it opens a window. */
  let limbo: Win | undefined;
  const makeWin = (id: number, view: WindowView): Win => ({
    id,
    view,
    frame: { paletteOpen: false, sidebarPeek: false, tabDragging: false, overlays: new Set() },
    nav: { canGoBack: false, canGoForward: false, zoom: 100 },
    navAsked: 0,
    selected: [],
  });
  const winOf = (view: WindowView | undefined) => (limbo?.view === view ? limbo : [...wins.values()].find((w) => w.view === view));
  const rememberViews = () =>
    void chrome.storage.session.set({
      [sessionKey(VIEWS_KEY)]: store.views.flatMap((view) => {
        const win = winOf(view);
        return win && win.id >= 0 ? [[win.id, view]] : [];
      }),
    });

  /** The window last in front. */
  function focused(): Win {
    const front = winOf(store.views[0]);
    if (front) return front;
    limbo = makeWin(-1, store.createView());
    store.attachView(limbo.view);
    return limbo;
  }
  const winFor = (page: Page | undefined) => {
    const id = page?.windowId ?? (page?.tabId !== undefined ? tabWindows.get(page.tabId) : undefined);
    return (id !== undefined ? wins.get(id) : undefined) ?? focused();
  };
  /**
   * The window a command is for: the one whose page sent it or whose keys were pressed, else
   * the window last in front (Settings, a Flechinha, the coding agent). Ask in the handler's
   * first turn (hub.ts caller()), and keep the answer across an `await`.
   */
  const here = () => winFor(caller());

  /** Whether this session's first window has taken up where the last session left off. */
  let resumed = false;
  /** A window being opened for the tabs in limbo. */
  let opening: Promise<unknown> | undefined;
  const winsOpening = new Map<number, Promise<Win | undefined>>();
  /** The main window with this id, known from now on; undefined for a Flechinha, a popup or a window that is gone. */
  function ensureWin(windowId: number | undefined): Promise<Win | undefined> {
    if (windowId === undefined || windowId < 0) return Promise.resolve(undefined);
    const have = wins.get(windowId) ?? winsOpening.get(windowId);
    if (have) return Promise.resolve(have);
    const pending = (async () => {
      await opening;
      const window = wins.has(windowId) ? undefined : await chrome.windows.get(windowId).catch(() => undefined);
      if (!window || window.type !== 'normal' || (await isFlechinhaWindow(windowId))) return wins.get(windowId);
      await opening;
      if (wins.has(windowId)) return wins.get(windowId);
      // Flecha's first window after having none takes limbo's place; another one opens in the
      // Space of the window it was opened from, which is the one in front.
      let view: WindowView;
      if (limbo && !store.activeTabOf(limbo.view)) {
        view = limbo.view;
        limbo = undefined;
      } else view = store.createView(resumed ? { from: store.views[0] } : { resume: true });
      resumed = true;
      const win = makeWin(windowId, view);
      wins.set(windowId, win);
      store.attachView(view);
      if (window.focused) store.focusView(view);
      rememberViews();
      return win;
    })().finally(() => winsOpening.delete(windowId));
    winsOpening.set(windowId, pending);
    return pending;
  }

  /** A window closed: its tabs stay in the sidebar, and no window shows them. */
  function closeWin(windowId: number) {
    const win = wins.get(windowId);
    if (!win) return;
    wins.delete(windowId);
    store.detachView(win.view);
    rememberViews();
    // At once: with Flecha's last window the background may go before the usual save.
    store.saveNow();
  }

  /** A window came to the front: Settings, Flechinhas and the menu bar follow it. */
  function onFocus(windowId: number) {
    const win = wins.get(windowId);
    if (!win || store.views[0] === win.view) return;
    store.focusView(win.view);
    rememberViews();
  }

  {
    const saved = new Map(((await chrome.storage.session.get(sessionKey(VIEWS_KEY)))[sessionKey(VIEWS_KEY)] as Array<[number, WindowView]> | undefined) ?? []);
    const flechinhas = new Set(await flechinhaWindows());
    const open = (await chrome.windows.getAll({ windowTypes: ['normal'] })).flatMap((w) => (w.id !== undefined && !flechinhas.has(w.id) ? [w.id] : []));
    const front = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined))?.id;
    // As they were last in front; after a background restart that is the order they were saved in.
    const order = [...new Set([...[...saved.keys()].filter((id) => open.includes(id)), ...open.filter((id) => id === front), ...open])];
    resumed = saved.size > 0;
    for (const id of order) {
      const view = saved.get(id) ?? store.createView(resumed ? { from: store.views[0] } : { resume: true });
      resumed = true;
      wins.set(id, makeWin(id, view));
      store.attachView(view);
    }
    rememberViews();
  }
  const isPlaceholder = (chromeId: number | undefined) => chromeId !== undefined && [...wins.values()].some((w) => w.placeholder === chromeId);

  let nativeHost: ReturnType<typeof registerNativeHost> | undefined;
  let features: Features | undefined;
  // Asked of macOS on start and whenever a window takes focus (the user may have changed it in System Settings).
  let defaultBrowser: UiState['defaultBrowser'] = { isDefault: false, canSet: false };
  const refreshDefaultBrowser = async () => {
    const next = await defaultBrowserState().catch(() => defaultBrowser);
    if (next.isDefault === defaultBrowser.isDefault && next.canSet === defaultBrowser.canSet) return;
    defaultBrowser = next;
    sendState();
  };
  const restored = (await chrome.storage.session.get(sessionKey(LIVE_KEY)))[sessionKey(LIVE_KEY)] as Record<string, number> | undefined;
  const existing = new Set((await chrome.tabs.query({})).map((t) => t.id));
  for (const [id, chromeId] of Object.entries(restored ?? {})) if (existing.has(chromeId) && store.state.tabs[id]) live.set(id, chromeId);
  if (!restored) store.archiveStale();
  // None of an earlier incognito session's tabs are left: this is a new one, which starts empty.
  if (incognito && !live.size && (Object.keys(store.state.tabs).length || store.state.archive.length)) {
    store.replaceState(incognitoState(parseState(saved)));
  }
  if (incognito) {
    // Settings change the regular state; incognito windows follow your preferences.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STATE_KEY]) return;
      const prefs = followedPreferences(parseState(changes[STATE_KEY].newValue));
      const keys = Object.keys(prefs) as Array<keyof BrowserState>;
      if (keys.some((k) => JSON.stringify(prefs[k]) !== JSON.stringify(store.state[k]))) store.replaceState({ ...store.state, ...prefs });
    });
    // The last incognito window closed: its tabs are forgotten.
    chrome.windows.onRemoved.addListener(async () => {
      if ((await chrome.windows.getAll()).length) return;
      await chrome.storage.session.remove([sessionKey(STATE_KEY), sessionKey(LIVE_KEY)]);
    });
  }
  // Tabs Chromium opened before we were running: its start page shows the active Flecha tab
  // (closing it would close the window), anything else becomes a Flecha tab.
  for (const tab of await chrome.tabs.query({})) {
    if ([...live.values()].includes(tab.id!) || isShellPage(tab)) continue;
    const win = wins.get(tab.windowId);
    if (!win) {
      // A popup's page is a tab too, kept where it is; a Flechinha's isn't one of Flecha's tabs.
      if (!(await isFlechinhaWindow(tab.windowId))) live.set(addTab(focused().view, url(tab), { activate: false }).id, tab.id!);
      continue;
    }
    const active = store.activeTabOf(win.view);
    // In a Space with its own cookies the start page is in the wrong partition: it only holds the
    // window open until sync() opens the tab in its Space's partition. Taken over, it would report
    // the new tab page first, and the tab would reopen there blank, its address lost.
    const isolated = !!active && !!store.locate(active.id)?.space?.isolated && typeof chrome.flechaPrivate?.createTab === 'function';
    if (isStartPage(tab) && active && isolated && win.placeholder === undefined) win.placeholder = tab.id;
    else if (isStartPage(tab) && active && isolated) {
      ours.add(tab.id!);
      void chrome.tabs.remove(tab.id!);
    } else if (isStartPage(tab) && active && !live.has(active.id)) {
      live.set(active.id, tab.id!);
      // A blank tab reloads the new tab page: Chromium drew its own before the shell was loaded.
      void chrome.tabs.update(tab.id!, { url: active.url === 'about:blank' ? 'chrome://newtab/' : active.url, active: true });
    } else if (isStartPage(tab) && !active && win.placeholder === undefined) {
      win.placeholder = tab.id;
      void chrome.tabs.update(tab.id!, { url: 'chrome://newtab/' });
    } else if (isStartPage(tab)) {
      ours.add(tab.id!);
      void chrome.tabs.remove(tab.id!);
    } else live.set(addTab(win.view, url(tab), { activate: tab.active }).id, tab.id!);
  }

  /** A Flecha tab for an address; the new tab page and empty addresses make a blank "New Tab". */
  function addTab(view: WindowView, address: string, opts: Parameters<Store['addTab']>[2]) {
    const blank = !address || address === 'about:blank' || isStartPage({ url: address } as chrome.tabs.Tab);
    const tab = store.addTab(view, blank ? 'about:blank' : address, opts);
    if (blank) store.updateTab(tab.id, { title: 'New Tab' });
    return tab;
  }

  // Icons fetched from the sites themselves, for those Chromium has none of yet.
  const siteIcons = new SiteIcons((icons) => broadcast('site-icons', icons));
  // Widevine streaming sites can't play here: the sidebar says so, once per site and session.
  const drmNoted = new Set<string>();
  chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
    const site = frameId === 0 ? drmSite(url) : undefined;
    if (!site || drmNoted.has(site)) return;
    drmNoted.add(site);
    void chrome.tabs.get(tabId).then(
      (tab) => tab.active && toWindow(tab.windowId, 'drm-site', { site, url }),
      () => undefined,
    );
  });
  const favicons = new Favicons(
    () => sendStateSoon(),
    (hosts) => void siteIcons.want(hosts),
  );
  const rememberLive = () => void chrome.storage.session.set({ [sessionKey(LIVE_KEY)]: Object.fromEntries(live) });

  /** The tab that last played sound, for the sidebar's media card (not saved). */
  let media: UiState['media'];

  /** The state as a window shows it: everyone's Spaces and tabs, with its own Space, active tabs and sidebar. */
  function uiState(win: Win): UiState {
    const tabs = Object.fromEntries(Object.entries(store.state.tabs).map(([id, { history, ...tab }]) => [id, tab]));
    const active = store.activeTabOf(win.view);
    return {
      ...store.stateFor(win.view),
      tabs,
      searchEngineName: searchEngine(store.state.searchEngine).name,
      // The light tint; pages darken it themselves, since only they know the system appearance.
      tint: store.activeSpaceOf(win.view).color,
      sidebarMode: sidebarMode(win),
      environment: active ? describeEnvironment(active.url, store.state.environments) : undefined,
      localServers: (features?.localServers() ?? []).filter((s) => !store.state.ignoredLocalPorts?.includes(s.port)),
      consoleErrors: features?.consoleErrors() ?? {},
      boostedHosts: features?.boostedHosts() ?? [],
      faviconHosts: favicons.list(),
      faviconUrl: favicons.url,
      shortcuts: shortcutHints(store.state),
      defaultBrowser,
      agent: nativeHost?.agentActivity(),
      // Only while it's still a tab, and it isn't the one on screen.
      media: media && store.state.tabs[media.tabId] && live.has(media.tabId) ? media : undefined,
      nav: win.nav,
    };
  }

  /** Every page gets the state of its window; pages of no window that of the window in front. */
  const sendState = () => {
    const states = new Map<Win, UiState>();
    broadcastEach('state', (page) => {
      const win = winFor(page);
      if (!states.has(win)) states.set(win, uiState(win));
      return [states.get(win)];
    });
    for (const win of wins.values()) sendFrame(win);
  };

  // ---- the window frame, as the Electron spike's Browser.layout() --------------
  // The frame page applies it (chrome.flechaPrivate.setFrame), since only a page knows
  // whether the system is in dark mode for the background colour.
  const sidebarMode = (win: Win): chrome.flechaPrivate.SidebarMode => (win.view.sidebarVisible ? 'docked' : win.frame.sidebarPeek ? 'floating' : 'hidden');
  function sendFrame(win: Win) {
    // The frame covers the whole window while it draws over the page.
    const overlay = win.frame.paletteOpen || win.frame.tabDragging || win.frame.overlays.size > 0 || !store.state.onboarded;
    toWindow(win.id, 'frame', { sidebar: sidebarMode(win), overlay });
  }
  const hasFrame = () => typeof chrome.flechaPrivate?.setFrame === 'function';
  /**
   * An event for one window's sidebar. Stock Chromium has no frame pages, and its side panels
   * don't say which window they are in: there, every page gets it.
   */
  function toWindow(windowId: number, name: string, ...args: unknown[]) {
    if (hasFrame()) sendToWindow(windowId, name, ...args);
    else broadcast(name, ...args);
  }
  /** A short message in a window's sidebar. */
  const flash = (win: Win, message: string) => flashIn(win.id, message);
  /** During the welcome tour, a shortcut is reported to it instead of acting. Returns whether it was. */
  function tourKey(command: string | undefined) {
    if (store.state.onboarded || !command) return false;
    broadcast('tour-key', command);
    return true;
  }

  function openPalette(mode: string, win = here()) {
    // The tour asks you to try the real shortcuts and shows what they do.
    if (tourKey(({ 'new-tab': 'newTab', navigate: 'openLocation', split: 'splitNew' } as Record<string, string>)[mode])) return;
    win.frame.paletteOpen = true;
    sendFrame(win);
    toWindow(win.id, 'palette', mode);
    if (hasFrame() && win.id >= 0) void chrome.flechaPrivate.focus('frame', win.id);
  }

  /** A window's Chromium window, opened first if it is still in limbo. */
  async function windowIdOf(win: Win) {
    if (win.id >= 0) return win.id;
    await (opening ??= (async () => {
      creating++;
      try {
        const window = (await chrome.windows.create({ focused: true }))!;
        win.id = window.id!;
        // Its new tab page keeps it open until the tab it was opened for is there.
        win.placeholder = window.tabs?.[0]?.id;
        wins.set(win.id, win);
        if (limbo === win) limbo = undefined;
        rememberViews();
      } finally {
        creating--;
        opening = undefined;
      }
    })());
    return win.id;
  }

  async function openChromeTab(id: string, active: boolean, win: Win) {
    const tab = store.state.tabs[id];
    // Closed in the meantime (its window went, say): nothing to open.
    if (!tab) return undefined;
    // The browser's own pages stay in the profile's partition, as Chromium opens them itself.
    const partition = isBrowserPage(tab.url) ? '' : partitionFor(id);
    creating++;
    try {
      const options = { windowId: await windowIdOf(win), url: tab.url === 'about:blank' ? undefined : tab.url, active };
      // A Space with separate cookies and logins: its own storage partition (patch 0034).
      const chromeId = partition
        ? await chrome.flechaPrivate.createTab({ ...options, partition })
        : (await chrome.tabs.create(options)).id!;
      live.set(id, chromeId);
      livePartition.set(id, partition);
      if (tab.muted) void chrome.tabs.update(chromeId, { muted: true });
      rememberLive();
      return chromeId;
    } finally {
      creating--;
    }
  }

  // ---- Spaces with separate cookies and logins, as the spike's sessions.ts ----------
  // Their tabs live in a storage partition of their own, named after the Space (patch 0034);
  // favorites and the other Spaces share the profile's. A Chromium tab can't change partition,
  // so a tab whose Space changes partition (it moved, or its Space was isolated or joined the
  // rest again) is closed and reopens in the right one, as the spike destroys its view.

  const canIsolate = typeof chrome.flechaPrivate?.createTab === 'function';
  /** The partition a Flecha tab belongs in: its Space's id if that Space is isolated, else "". */
  function partitionFor(id: string) {
    const space = store.locate(id)?.space;
    return canIsolate && space?.isolated ? space.id : '';
  }
  /** The partition each open Chromium tab is in, by Flecha tab, once known. */
  const livePartition = new Map<string, string>();
  async function learnPartition(id: string, chromeId: number) {
    if (!canIsolate) return livePartition.set(id, '');
    const partition = await chrome.flechaPrivate.getTabPartition(chromeId).catch(() => undefined);
    if (partition !== undefined && live.get(id) === chromeId) livePartition.set(id, partition);
  }
  /**
   * Open tabs in another partition than their Space's. Never one showing a page of the browser
   * (Settings and the like): it has no place in a Space's partition, and Chromium opens it in
   * the profile's, so it stays in the tab it is in until it goes to a site.
   */
  const inWrongPartition = () =>
    [...live.keys()].filter((id) => {
      const tab = store.state.tabs[id];
      return tab && !isBrowserPage(tab.url) && livePartition.has(id) && livePartition.get(id) !== partitionFor(id);
    });
  /**
   * A tab a page opened is in that page's partition, which may not be its Space's (a favorite's
   * link, with an isolated Space showing): it then reopens there, at the address it was going to.
   */
  async function checkOpenedTab(id: string, chromeId: number) {
    await learnPartition(id, chromeId);
    if (!inWrongPartition().includes(id)) return;
    const tab = await chrome.tabs.get(chromeId).catch(() => undefined);
    const address = tab && url(tab);
    if (address && !isStartPage(tab) && store.state.tabs[id]?.url === 'about:blank') store.updateTab(id, { url: address, title: address });
    sync();
  }
  /**
   * Closes these tabs' Chromium tabs, which are in the wrong partition. Those on screen get
   * their new one first: closing the active tab first would have Chromium activate another,
   * which Flecha would take as you picking it.
   */
  async function reopenInPartition(ids: string[]) {
    const showing = (id: string) => winOf(store.views.find((view) => store.visibleTabIds(view).includes(id)));
    const old: number[] = [];
    for (const id of ids) {
      const chromeId = live.get(id);
      const win = showing(id);
      if (chromeId === undefined || !win) continue;
      live.delete(id);
      await openChromeTab(id, id === store.activeTabOf(win.view)?.id, win);
      old.push(chromeId);
    }
    for (const chromeId of old) {
      ours.add(chromeId);
      void chrome.tabs.remove(chromeId).catch(() => ours.delete(chromeId));
    }
    await unload(ids.filter((id) => !showing(id)));
  }
  // The tabs that were open before the background (re)started.
  const partitionsKnown = Promise.all([...live].map(([id, chromeId]) => learnPartition(id, chromeId)));

  /**
   * Closes the Chromium tabs of Flecha tabs that were closed or unloaded. Chromium closes a
   * window with its last tab, so when none would be left a blank placeholder takes its place
   * (Flecha shows its empty state over it), until a Flecha tab opens again.
   */
  async function unload(ids: string[]) {
    const closing = ids.map((id) => live.get(id)).filter((c): c is number => c !== undefined);
    for (const id of ids) {
      live.delete(id);
      livePartition.delete(id);
    }
    rememberLive();
    if (!closing.length) return;
    for (const win of wins.values()) await keepOpen(win, closing);
    for (const chromeId of closing) {
      ours.add(chromeId);
      void chrome.tabs.remove(chromeId).catch(() => ours.delete(chromeId));
    }
  }

  /** Gives a window its placeholder if `leaving`, tabs about to close or move away, are all it has. */
  async function keepOpen(win: Win, leaving: number[]) {
    if (win.id < 0 || win.placeholder !== undefined) return;
    const tabs = await chrome.tabs.query({ windowId: win.id });
    if (!tabs.length || tabs.some((t) => !leaving.includes(t.id!))) return;
    creating++;
    try {
      win.placeholder = (await chrome.tabs.create({ windowId: win.id, active: true })).id;
    } finally {
      creating--;
    }
  }

  /** The placeholder goes once a real tab is showing. */
  function dropPlaceholder(win: Win) {
    if (win.placeholder === undefined) return;
    ours.add(win.placeholder);
    void chrome.tabs.remove(win.placeholder).catch(() => undefined);
    win.placeholder = undefined;
  }

  /**
   * Shows in every window the tab its view has active, opening its Chromium tab if it has
   * none yet, or moving it over from the window it was in.
   */
  let syncing = Promise.resolve();
  function sync() {
    syncing = syncing
      .then(async () => {
        await partitionsKnown;
        await unload([...live.keys()].filter((id) => !store.state.tabs[id]));
        // Pages reopen in their Space's partition (separate cookies and logins).
        await reopenInPartition(inWrongPartition());
        // The window in front comes last: by then the windows it takes a tab from show another.
        const showing = new Set<Win>();
        for (const view of [...store.views].reverse()) {
          const win = winOf(view);
          // A window that closes while it is being shown mustn't keep the others waiting.
          if (win) await show(win, showing).catch((err) => console.warn('Flecha shell: showing a window failed', err));
        }
        rememberViews();
        sendStateSoon();
      })
      .catch((err) => console.error('Flecha shell: sync failed', err));
  }
  /** Resolves once sync() has nothing left to do. */
  async function settled() {
    let last;
    do {
      last = syncing;
      await last;
    } while (last !== syncing);
  }

  /** Brings one window in line with its view. `showing`: the windows this is already being done for. */
  async function show(win: Win, showing: Set<Win>) {
    if (showing.has(win)) return;
    showing.add(win);
    try {
      const active = store.activeTabOf(win.view);
      if (!active) return await cover(win);
      // Both halves of a split are on screen, so both need a page.
      for (const id of store.visibleTabIds(win.view)) if (id !== active.id) await bring(id, win, false, showing);
      await bring(active.id, win, true, showing);
      await syncSplits(win);
      await chrome.tabs.update(live.get(active.id)!, { active: true }).catch(() => openChromeTab(active.id, true, win));
      dropPlaceholder(win);
      await refreshNav(win);
    } finally {
      showing.delete(win);
    }
  }

  /**
   * A Flecha tab's page in `win`: opened there, or moved over from the window it is in. The
   * tab keeps its page as it is (a video goes on playing), which reopening it wouldn't.
   */
  async function bring(id: string, win: Win, active: boolean, showing: Set<Win>) {
    const chromeId = live.get(id);
    const tab = chromeId === undefined ? undefined : await chrome.tabs.get(chromeId).catch(() => undefined);
    if (chromeId === undefined || !tab) return void (await openChromeTab(id, active, win));
    const windowId = await windowIdOf(win);
    if (tab.windowId === windowId) return;
    const from = wins.get(tab.windowId);
    if (from) {
      // The window it leaves shows its own tab first: taken from under it, Chromium would
      // activate whichever tab is next, which Flecha would take as you picking it.
      if (tab.active) await show(from, showing);
      await keepOpen(from, [chromeId]);
    }
    // Chromium's split doesn't span windows: it is made again where its halves arrive.
    if (tab.splitViewId !== undefined && tab.splitViewId >= 0) {
      for (const half of await chrome.tabs.query({ windowId: tab.windowId })) if (half.splitViewId === tab.splitViewId) ourSplits.set(half.id!, 'unsplit');
      await chrome.tabs.unsplit(tab.splitViewId).catch(() => undefined);
    }
    await chrome.tabs.move(chromeId, { windowId, index: -1 }).catch(async (err) => {
      // It can't move: it opens again in the window that wants it.
      console.warn('Flecha shell: moving a tab between windows failed', err);
      await unload([id]);
      await openChromeTab(id, active, win);
    });
  }

  /**
   * A window whose view has no tab keeps showing what Chromium has active in it, unless that
   * is a tab another window shows now: then the empty state covers it, on a placeholder.
   */
  async function cover(win: Win) {
    if (win.id < 0) return;
    const [shown] = await chrome.tabs.query({ windowId: win.id, active: true });
    const id = shown?.id !== undefined ? flechaIdFor(shown.id) : undefined;
    if (!id || !store.shownElsewhere(id, win.view)) return;
    const have = win.placeholder !== undefined ? await chrome.tabs.update(win.placeholder, { active: true }).catch(() => undefined) : undefined;
    if (have) return;
    creating++;
    try {
      win.placeholder = (await chrome.tabs.create({ windowId: win.id, active: true })).id;
    } finally {
      creating--;
    }
  }

  // ---- split view: the Store's splits as Chromium's own split view ---------------
  // Chromium shows both tabs of a split whenever either is active, which is how a Space's
  // split behaves in the Store too. Chromium places the halves by tab order.
  // TODO(chromium): the split ratio (store.splitRatio, the divider) has no extension API; a
  // native patch would apply it, and report drags of Chromium's own divider back.

  /** Split changes we asked Chromium for, by tab: their events are ours, not the user's. */
  const ourSplits = new Map<number, 'split' | 'unsplit'>();

  /** One window's splits: those of the Spaces whose two pages are both in it. */
  async function syncSplits(win: Win) {
    const tabs = await chrome.tabs.query({ windowId: win.id });
    const inWindow = new Set(tabs.map((t) => t.id));
    const wanted = new Map<string, [number, number]>();
    for (const space of store.state.spaces) {
      const pair = space.split?.map((id) => live.get(id));
      if (pair?.length === 2 && pair.every((c) => c !== undefined && inWindow.has(c))) wanted.set(pair.join(','), pair as [number, number]);
    }
    const splits = new Map<number, chrome.tabs.Tab[]>();
    for (const tab of tabs) {
      if (tab.splitViewId === undefined || tab.splitViewId < 0) continue;
      splits.set(tab.splitViewId, [...(splits.get(tab.splitViewId) ?? []), tab]);
    }
    const have = new Set<string>();
    for (const [splitId, members] of splits) {
      const key = members
        .sort((a, b) => a.index - b.index)
        .map((t) => t.id)
        .join(',');
      if (wanted.has(key)) have.add(key);
      else {
        for (const t of members) ourSplits.set(t.id!, 'unsplit');
        await chrome.tabs.unsplit(splitId).catch(() => undefined);
      }
    }
    for (const [key, [left, right]] of wanted) {
      if (have.has(key)) continue;
      ourSplits.set(left, 'split');
      ourSplits.set(right, 'split');
      // Split tabs must be next to each other, left first.
      await chrome.tabs.move(left, { index: -1 }).catch(() => undefined);
      await chrome.tabs.move(right, { index: -1 }).catch(() => undefined);
      await chrome.tabs.createSplit([left, right]).catch((err) => {
        ourSplits.delete(left);
        ourSplits.delete(right);
        console.warn('Flecha shell: split failed', err);
      });
    }
  }

  /** A split made or ended in Chromium itself (its split menu, the close button) goes to the Store. */
  async function splitChanged(chromeId: number, splitViewId: number) {
    const ours = ourSplits.get(chromeId);
    if (ours && ours === (splitViewId < 0 ? 'unsplit' : 'split')) return void ourSplits.delete(chromeId);
    const id = flechaIdFor(chromeId);
    const win = wins.get((await chrome.tabs.get(chromeId).catch(() => undefined))?.windowId ?? -1);
    if (!id || !win) return;
    const space = store.activeSpaceOf(win.view);
    if (splitViewId < 0) {
      if (space.split?.includes(id)) exitSplit(win);
      return;
    }
    const members = (await chrome.tabs.query({ windowId: win.id }))
      .filter((t) => t.splitViewId === splitViewId)
      .sort((a, b) => a.index - b.index)
      .map((t) => flechaIdFor(t.id!));
    const active = store.activeTabIdIn(win.view, space);
    if (members.length !== 2 || !members.every(Boolean) || !active || !members.includes(active)) return;
    if (space.split && members.every((m) => space.split!.includes(m!))) return;
    const other = members.find((m) => m !== active)!;
    store.splitWith(win.view, other, members[0] === other ? 'left' : 'right');
  }

  function exitSplit(win = here()) {
    const mirror = store.unsplit(win.view);
    if (mirror) {
      store.closeTab(mirror);
      void unload([mirror]);
    }
  }

  /** A tab dropped on the page: show it beside the page, on the side it was dropped. */
  function dropToSplit(tabId: string, side: 'left' | 'right') {
    const win = here();
    const { view } = win;
    win.frame.tabDragging = false;
    sendFrame(win);
    const space = store.activeSpaceOf(view);
    const active = store.activeTabIdIn(view, space);
    // One half of the split dropped on the other side: they trade places.
    if (space.split?.includes(tabId) && space.splitMode !== 'responsive') {
      if (space.split[side === 'left' ? 0 : 1] !== tabId) store.swapSplit(view);
      return store.activate(view, tabId);
    }
    if (!active || active === tabId) return store.activate(view, tabId);
    // A responsive mirror only exists for its split; it goes away when something else takes its place.
    if (space.splitMode === 'responsive') exitSplit(win);
    store.splitWith(view, tabId, side);
  }

  async function refreshNav(win: Win) {
    const asked = ++win.navAsked;
    const chromeId = activeChromeId(win);
    const [zoom, history] =
      chromeId === undefined
        ? [1, { canGoBack: false, canGoForward: false }]
        : await Promise.all([chrome.tabs.getZoom(chromeId).catch(() => 1), tabHistory(chromeId)]);
    // A later ask, for another tab or page, has the answer that counts.
    if (asked === win.navAsked) win.nav = { ...history, zoom: Math.round(zoom * 100) };
  }

  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  const sendStateSoon = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(sendState, 16);
  };
  // Icons for tabs that haven't loaded their own yet.
  const wantFavicons = () => void favicons.want(Object.values(store.state.tabs).filter((t) => !t.favicon).map((t) => t.url));
  store.onChange(() => {
    sync();
    sendStateSoon();
    wantFavicons();
  });

  // ---- Chromium → Flecha ----------------------------------------------------

  /**
   * The window a tab for `spaceId` lands in: `win` if it shows that Space or no window does,
   * else a window that already shows it, which then comes to the front.
   */
  function landingWin(win: Win, spaceId: string | undefined) {
    if (!spaceId || win.view.activeSpaceId === spaceId) return win;
    const there = store.views.map(winOf).find((w) => w?.view.activeSpaceId === spaceId);
    if (!there) return win;
    if (there.id >= 0) void chrome.windows.update(there.id, { focused: true }).catch(() => undefined);
    return there;
  }

  async function onCreated(tab: chrome.tabs.Tab) {
    const known = () => creating || flechaIdFor(tab.id!) || isPlaceholder(tab.id) || isShellPage(tab);
    if (known()) return;
    // A Flechinha's page isn't one of Flecha's tabs. Asked of the browser: a new Flechinha's
    // first tab arrives before openFlechinha() has told us its window.
    if (await isFlechinhaWindow(tab.windowId)) return;
    const win = await ensureWin(tab.windowId);
    if (known()) return;
    const opener = tab.openerTabId !== undefined ? flechaIdFor(tab.openerTabId) : undefined;
    // A link from another app (no page opened it): Air Traffic Control may send it to a Space.
    const spaceId = opener === undefined ? linkRuleSpace(store.state.linkRules, url(tab)) : undefined;
    // In a popup it stays in the popup: no window shows it until you pick it in the sidebar.
    const added = win
      ? addTab(landingWin(win, tab.active ? spaceId : undefined).view, url(tab), { activate: tab.active, afterTabId: opener, spaceId })
      : addTab(focused().view, url(tab), { activate: false, afterTabId: opener });
    live.set(added.id, tab.id!);
    rememberLive();
    // Opened from a page, it is in that page's partition, which may not be its Space's.
    void checkOpenedTab(added.id, tab.id!);
  }

  function onUpdated(chromeId: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) {
    const id = flechaIdFor(chromeId);
    if (!id) return;
    const patch: Parameters<Store['updateTab']>[1] = {};
    // Chromium's new tab page is Flecha's empty state: the tab is still a blank one.
    if (info.url) patch.url = isStartPage({ url: info.url } as chrome.tabs.Tab) ? 'about:blank' : info.url;
    // A blank tab keeps its "New Tab" name: the new tab page's own title and icon aren't its.
    const blank = (patch.url ?? store.state.tabs[id]?.url) === 'about:blank';
    if (info.title && !blank) patch.title = info.title;
    if (blank) patch.title = 'New Tab';
    if (info.favIconUrl && !blank) patch.favicon = info.favIconUrl;
    if (blank) patch.favicon = undefined;
    if (info.status) patch.loading = info.status === 'loading';
    if (info.audible !== undefined) {
      patch.audible = info.audible;
      // The media card follows the last tab that played; pausing keeps it, so it can play again.
      if (info.audible) media = { tabId: id, playing: true };
      else if (media?.tabId === id) media = { tabId: id, playing: false };
    }
    if (info.mutedInfo) patch.muted = info.mutedInfo.muted;
    store.updateTab(id, patch);
    // A new address is a new place in the tab's history, also without a load (pushState).
    const win = wins.get(tab.windowId);
    if ((info.status === 'complete' || info.url) && tab.active && win) void refreshNav(win).then(sendState);
    if (info.splitViewId !== undefined) void splitChanged(chromeId, info.splitViewId);
  }

  /**
   * Chromium showed another tab in a window: one a page opened or focused, or the next one
   * after the active tab closed. sync() activates and moves tabs too, so what counts is what
   * the window still shows once it is done.
   */
  async function onActivated({ tabId, windowId }: { tabId: number; windowId: number }) {
    await settled();
    const win = await ensureWin(windowId);
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!win || !tab?.active || tab.windowId !== windowId) return;
    const id = flechaIdFor(tabId);
    if (!id || store.activeTabOf(win.view)?.id === id) return;
    // Another window's tab, on its way there: this window gets its own back.
    if (store.shownElsewhere(id, win.view)) return sync();
    store.activate(win.view, id);
  }

  function onRemoved(chromeId: number, info: { windowId: number; isWindowClosing: boolean }) {
    if (ours.delete(chromeId)) return;
    for (const win of wins.values()) if (win.placeholder === chromeId) win.placeholder = undefined;
    const id = flechaIdFor(chromeId);
    // One of Flecha's windows closed with the tab in it: no view shows its tabs any more.
    const withWindow = info.isWindowClosing && wins.has(info.windowId);
    if (withWindow) closeWin(info.windowId);
    if (!id) return;
    live.delete(id);
    livePartition.delete(id);
    rememberLive();
    // A tab that went with its window stays in the sidebar, to open again: closing a window
    // isn't closing each of its tabs. A blank one has nothing to come back to, and a popup's
    // page was only ever the popup's.
    if (!withWindow || store.state.tabs[id]?.url === 'about:blank') store.closeTab(id);
    else sendStateSoon();
    // Saved at once: with Flecha's last window the background may go before the usual save.
    if (withWindow) store.saveNow();
  }

  // ---- commands from Flecha pages -------------------------------------------

  const activeChromeId = (win = here()) => {
    const tab = store.activeTabOf(win.view);
    return tab ? live.get(tab.id) : undefined;
  };
  const onActive = (fn: (chromeId: number) => unknown) => () => {
    const chromeId = activeChromeId();
    if (chromeId !== undefined) void fn(chromeId);
  };
  const openTab = (input: string, activate = true, view = here().view) =>
    addTab(view, resolveInput(input, store.state.searchEngine), {
      activate,
      afterTabId: activate ? undefined : store.activeTabOf(view)?.id,
    });

  /** A page from a Flechinha becomes an active Today tab: in the Space of the window it is in now, or in `spaceId`'s. */
  function adoptTab(chromeId: number, spaceId?: string) {
    void chrome.tabs.get(chromeId).then(async (tab) => {
      const win = (await ensureWin(tab.windowId)) ?? focused();
      if (flechaIdFor(chromeId)) return;
      const id = addTab(landingWin(win, spaceId).view, url(tab), { activate: true, spaceId }).id;
      live.set(id, chromeId);
      rememberLive();
      void checkOpenedTab(id, chromeId);
    });
  }

  // Air Traffic Control for links from other apps that open in a Flechinha: the first page a
  // Flechinha loads goes to its rule's Space instead, as Arc sends it past Little Arc.
  const flechinhasSeen = new Set<number>();
  chrome.windows.onRemoved.addListener((id) => flechinhasSeen.delete(id));
  chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url: address }) => {
    if (frameId !== 0 || incognito || !store.state.linkRules?.length) return;
    void chrome.tabs.get(tabId).then(
      async (tab) => {
        if (flechinhasSeen.has(tab.windowId) || !(await isFlechinhaWindow(tab.windowId))) return;
        flechinhasSeen.add(tab.windowId);
        const spaceId = linkRuleSpace(store.state.linkRules, address);
        if (!spaceId || typeof chrome.flechaPrivate?.openInFlecha !== 'function') return;
        adoptTab(await chrome.flechaPrivate.openInFlecha(tab.windowId), spaceId);
        // Moved this early, the emptied Flechinha can stay behind as a blank window.
        void chrome.windows.remove(tab.windowId).catch(() => undefined);
      },
      () => undefined,
    );
  });

  // ---- context menus, as the Electron spike's tabMenu / spaceMenu ----------------
  // Built here, where the Store is; the page that asked draws them (windowUi.ts).

  const SEPARATOR = { separator: true } as const;
  const does = (name: string, ...args: unknown[]): MenuRun => ({ cmd: name, args });
  const spaceLabel = (s: { emoji?: string; name: string }) => `${s.emoji ? s.emoji + '  ' : ''}${s.name}`;

  function tabMenu(tabId: string): MenuEntry<MenuRun>[] | undefined {
    const tab = store.state.tabs[tabId];
    const zone = store.locate(tabId)?.zone;
    if (!tab || !zone) return undefined;
    const { view } = here();
    const space = store.activeSpaceOf(view);
    const active = store.activeTabIdIn(view, space);
    const split: MenuEntry<MenuRun>[] = [];
    if (space.split?.includes(tabId)) {
      if (space.splitMode !== 'responsive') split.push({ label: 'Swap Sides', run: does('swapSplit') });
      split.push({ label: 'Exit Split View', run: does('exitSplit') });
    }
    else if (active && active !== tabId) split.push({ label: 'Open in Split View', run: does('splitWith', tabId) });
    const name = tab.customTitle ?? tab.title;
    const otherSpaces = store.state.spaces.filter((s) => s.id !== store.locate(tabId)?.space?.id);
    const tabSpace = store.locate(tabId)?.space ?? space;
    return [
      ...split,
      ...(split.length ? [SEPARATOR] : []),
      { label: 'Copy Link', run: { copy: tab.url, message: 'Link copied' } },
      { label: 'Copy as Markdown Link', run: { copy: `[${name}](${tab.url})`, message: 'Markdown link copied' } },
      { label: 'Rename…', run: { rename: tabId } },
      ...(zone === 'pinned'
        ? [
            { label: 'Change Icon…', run: { rename: `tabicon:${tabId}` } },
            ...(tab.emoji ? [{ label: 'Remove Icon', run: does('setTabEmoji', tabId, '') }] : []),
          ]
        : []),
      { label: 'Duplicate', run: does('newTab', tab.url) },
      // A Flechinha window of its own; the window code lives in another shell module.
      { label: 'Open in Flechinha', run: does('openFlechinha', tab.url, tabId) },
      SEPARATOR,
      // An incognito window has just its tabs: nothing to pin, no other Space.
      ...(incognito
        ? []
        : [
            { label: zone === 'today' ? 'Pin Tab' : 'Unpin Tab', run: does('togglePin', tabId) },
            { label: 'Move to New Folder', enabled: zone !== 'favorites', run: does('moveToNewFolder', tabId) },
            ...(zone !== 'favorites' && folderChoices(tabSpace).length
              ? [{ label: 'Move to Folder', submenu: folderChoices(tabSpace).map((f) => ({ label: f.label, run: does('moveToFolder', tabId, f.id) })) }]
              : []),
            { label: zone === 'favorites' ? 'Remove from Favorites' : 'Add to Favorites', run: does('toggleFavorite', tabId) },
            {
              label: 'Move to Space',
              enabled: zone !== 'favorites' && otherSpaces.length > 0,
              submenu: otherSpaces.map((s) => ({ label: spaceLabel(s), run: does('moveToSpace', tabId, s.id) })),
            },
            SEPARATOR,
          ]),
      { label: 'Reload', enabled: live.has(tabId), run: does('reloadTab', tabId) },
      { label: tab.muted ? 'Unmute Tab' : 'Mute Tab', run: does('toggleMute', tabId) },
      ...(tab.homeUrl && tab.homeUrl !== tab.url ? [{ label: 'Go Back to Pinned URL', run: does('goHome', tabId) }] : []),
      SEPARATOR,
      { label: zone === 'today' ? 'Close Tab' : 'Unload Tab', run: does('close', tabId) },
      ...(zone === 'today'
        ? [
            { label: 'Close Tabs Below', run: does('closeTabs', tabId, 'below') },
            { label: 'Close Other Tabs', run: does('closeTabs', tabId, 'others') },
          ]
        : []),
    ];
  }

  function spaceMenu(spaceId: string): MenuEntry<MenuRun>[] | undefined {
    const space = store.state.spaces.find((s) => s.id === spaceId);
    if (!space || incognito) return undefined;
    return [
      { label: 'Edit Space…', run: does('editSpace', spaceId) },
      { label: 'New Folder', run: does('newFolder') },
      { label: 'Reset Pinned Tabs', run: does('resetSpaceTabs', spaceId) },
      SEPARATOR,
      { label: 'Separate Cookies and Logins', checked: !!space.isolated, run: does('setSpaceIsolated', spaceId, !space.isolated) },
      ...(space.isolated && canIsolate ? [{ label: 'Clear Cookies and Site Data…', run: { clearSpaceData: spaceId } }] : []),
      SEPARATOR,
      { label: 'Delete Space…', enabled: store.state.spaces.length > 1, run: { deleteSpace: spaceId } },
    ];
  }

  /** A Space's folders, nested ones as "Docs › Reading", for "Move to Folder". */
  function folderChoices(space: { pinned: PinnedNode[] }) {
    const out: Array<{ id: string; label: string }> = [];
    const walk = (nodes: PinnedNode[], path: string) => {
      for (const n of nodes) {
        if (n.kind !== 'folder') continue;
        const label = `${path}${n.emoji ? `${n.emoji} ` : ''}${n.name}`;
        out.push({ id: n.id, label });
        walk(n.children, `${label} › `);
      }
    };
    walk(space.pinned, '');
    return out.slice(0, 40);
  }

  function folderMenu(folderId: string): MenuEntry<MenuRun>[] | undefined {
    if (incognito) return undefined;
    const folder = findFolder(store.activeSpaceOf(here().view).pinned, folderId);
    if (!folder) return undefined;
    const tabs = pinnedTabIds(folder.children)
      .map((id) => store.state.tabs[id])
      .filter(Boolean);
    const links = tabs.map((t) => t.url);
    const markdown = tabs.map((t) => `- [${t.customTitle ?? t.title}](${t.url})`);
    return [
      { label: 'Rename…', run: { rename: folderId } },
      { label: 'Change Icon…', run: { rename: `icon:${folderId}` } },
      ...(folder.emoji ? [{ label: 'Remove Icon', run: does('setFolderEmoji', folderId, '') }] : []),
      { label: 'New Folder Inside', run: does('newFolderIn', folderId) },
      { label: folder.open ? 'Collapse' : 'Expand', run: does('toggleFolder', folderId) },
      SEPARATOR,
      { label: 'Copy Links', enabled: links.length > 0, run: { copy: links.join('\n'), message: links.length === 1 ? 'Link copied' : `${links.length} links copied` } },
      { label: 'Copy as Markdown List', enabled: links.length > 0, run: { copy: markdown.join('\n'), message: 'Markdown list copied' } },
      { label: 'Close Its Tabs', enabled: tabs.some((t) => live.has(t.id)), run: does('unloadFolder', folderId) },
      SEPARATOR,
      { label: 'Ungroup', run: does('deleteFolder', folderId, true) },
      { label: 'Delete Folder and Tabs…', enabled: links.length > 0, run: { deleteFolder: folderId } },
    ];
  }

  /** Opens the sidebar's Space editor (name, emoji, colour), in that Space. */
  function editSpace(spaceId: string, win = here()) {
    if (win.view.activeSpaceId !== spaceId) store.switchSpace(win.view, spaceId);
    toWindow(win.id, 'edit-space', spaceId);
  }

  function toggleMute(tabId: string) {
    const tab = store.state.tabs[tabId];
    if (!tab) return;
    const chromeId = live.get(tabId);
    // An unloaded tab remembers it, and opens muted.
    if (chromeId === undefined) store.updateTab(tabId, { muted: !tab.muted });
    else void chrome.tabs.update(chromeId, { muted: !tab.muted });
  }

  /** Spaces, pins and favorites: an incognito window has none of them, so these do nothing there. */
  const spacesOnly = <A extends unknown[]>(fn: (...args: A) => unknown) => (incognito ? () => undefined : fn);

  /** Settings show the regular profile's state, so an incognito window opens them over there. */
  function showSettings(pane?: string) {
    if (!incognito) return openSettings(pane);
    if (typeof chrome.flechaPrivate?.runInRegularProfile === 'function') {
      void chrome.flechaPrivate.runInRegularProfile(pane ? `openSettings:${pane}` : 'settings');
    }
  }

  handle({
    ready: sendState,
    newTab: (input: string) => openTab(input),
    navigate: (input: string) => {
      const chromeId = activeChromeId();
      if (chromeId === undefined) return openTab(input);
      void navigateTab(chromeId, resolveInput(input, store.state.searchEngine));
    },
    activate: (id: string) => store.activate(here().view, id),
    close: (id: string) => {
      store.closeTab(id);
      void unload([id]);
    },
    back: onActive((id) => chrome.tabs.goBack(id).catch(() => undefined)),
    forward: onActive((id) => chrome.tabs.goForward(id).catch(() => undefined)),
    reload: onActive((id) => chrome.tabs.reload(id)),
    switchSpace: (id: string) => store.switchSpace(here().view, id),
    newSpace: spacesOnly(() => {
      const win = here();
      editSpace(store.newSpace(win.view).id, win);
    }),
    editSpace: spacesOnly((id: string) => editSpace(String(id))),
    newFolder: spacesOnly(() => store.newFolder('New Folder', { view: here().view })),
    moveToNewFolder: spacesOnly((tabId: string) => {
      const { view } = here();
      const folderId = store.newFolder('New Folder', { view });
      if (folderId) store.moveTab(view, String(tabId), { zone: 'pinned', folderId });
    }),
    tabMenu: (id: string) => tabMenu(String(id)),
    spaceMenu: (id: string) => spaceMenu(String(id)),
    folderMenu: (id: string) => folderMenu(String(id)),
    moveFolder: spacesOnly((id: string, to: { folderId?: string; beforeId?: string }) =>
      store.moveFolder(String(id), { spaceId: store.activeSpaceOf(here().view).id, folderId: to?.folderId, beforeId: to?.beforeId }),
    ),
    newFolderIn: spacesOnly((parentId: string) => store.newFolder('New Folder', { parentId: String(parentId) })),
    moveToFolder: spacesOnly((tabId: string, folderId: string) => store.moveTab(here().view, String(tabId), { zone: 'pinned', folderId: String(folderId) })),
    setTabEmoji: spacesOnly((tabId: string, emoji: string) => store.setTabEmoji(String(tabId), typeof emoji === 'string' ? emoji : undefined)),
    setFolderEmoji: spacesOnly((folderId: string, emoji: string) => store.setFolderEmoji(String(folderId), typeof emoji === 'string' ? emoji : undefined)),
    revealTab: (tabId?: string) => {
      const win = here();
      const id = typeof tabId === 'string' ? tabId : store.activeTabOf(win.view)?.id;
      if (!id || !store.state.tabs[id]) return;
      store.revealTab(id);
      // A hidden sidebar slides out to show it.
      if (!win.view.sidebarVisible) {
        win.frame.sidebarPeek = true;
        sendState();
      }
      toWindow(win.id, 'reveal-tab', id);
    },
    resetSpaceTabs: spacesOnly((spaceId: string) => {
      const moved = store.resetPinned(String(spaceId));
      for (const { tabId, url: address } of moved) {
        const chromeId = live.get(tabId);
        if (chromeId !== undefined) void navigateTab(chromeId, address);
      }
      flash(here(), moved.length ? `${moved.length} pinned tab${moved.length === 1 ? '' : 's'} reset` : 'Pinned tabs are already home');
    }),
    mediaControl: (tabId: string, action: string) => {
      const win = here();
      const chromeId = live.get(String(tabId));
      if (action === 'dismiss' || chromeId === undefined) {
        media = undefined;
        return sendState();
      }
      void chrome.scripting
        .executeScript({ target: { tabId: chromeId, allFrames: true }, func: toggleMediaInPage })
        .then((results) => {
          const playing = results.some((r) => r.result === 'playing');
          media = { tabId: String(tabId), playing };
          sendState();
        })
        .catch(() => flash(win, 'This page’s media can’t be controlled from here'));
    },
    captureFullPage: () => {
      const win = here();
      return captureFullPage(win).catch((err) => {
        console.error('Flecha shell: full-page capture failed', err);
        flash(win, 'This page can’t be captured');
      });
    },
    copyQuote: async () => {
      const win = here();
      const tab = store.activeTabOf(win.view);
      const chromeId = activeChromeId(win);
      if (!tab || chromeId === undefined) return;
      const results = await chrome.scripting
        .executeScript({ target: { tabId: chromeId, allFrames: true }, func: () => String(getSelection() ?? '').trim() })
        .catch(() => []);
      const text = results.map((r) => r.result).find((t) => typeof t === 'string' && t);
      if (!text) return flash(win, 'Select some text on the page first');
      const quote = String(text).split(/\n+/).map((line) => `> ${line}`).join('\n');
      return copyToClipboard(`${quote}\n>\n> — [${tab.customTitle ?? tab.title}](${tab.url})`, 'Quote copied', win);
    },
    exportSpaces: spacesOnly(() => exportSpaces()),
    importSpaces: spacesOnly((json: string) => call('importFlechaState', String(json))),
    // Ungroup keeps its tabs where the folder was; otherwise they go to the archive.
    deleteFolder: spacesOnly((id: string, keepTabs: boolean) => void unload(store.deleteFolder(String(id), !!keepTabs))),
    unloadFolder: spacesOnly((id: string) => {
      const folder = findFolder(store.activeSpaceOf(here().view).pinned, String(id));
      if (folder) void unload(pinnedTabIds(folder.children));
    }),
    setOverlay: (name: string, on: boolean) => {
      const win = here();
      if (on) win.frame.overlays.add(String(name));
      else win.frame.overlays.delete(String(name));
      sendFrame(win);
    },
    togglePin: spacesOnly((id: string) => store.togglePin(here().view, id)),
    toggleFavorite: spacesOnly((id: string) => store.toggleFavorite(here().view, id)),
    moveToSpace: spacesOnly((id: string, spaceId: string) => store.moveToSpace(id, spaceId)),
    reloadTab: (id: string) => {
      const chromeId = live.get(id);
      if (chromeId !== undefined) void chrome.tabs.reload(chromeId);
    },
    goHome: (id: string) => {
      const tab = store.state.tabs[id];
      const home = tab?.homeUrl;
      const chromeId = live.get(id);
      // Already home: navigating to the same URL would reload the page (a double-click is easy to make by accident).
      if (!home || home === tab.url) return;
      if (chromeId !== undefined) void navigateTab(chromeId, home);
      else store.updateTab(id, { url: home });
    },
    closeTabs: (id: string, which: string) => void unload(store.closeTodayTabs(id, which === 'others' ? 'others' : 'below')),
    updateSpace: (id: string, patch: { name?: string; emoji?: string; color?: string }) => store.updateSpace(id, patch ?? {}),
    setPinnedCollapsed: (id: string, collapsed: boolean) => store.setPinnedCollapsed(String(id), !!collapsed),
    openInSafari: (url: string) => {
      const open = nativeHost?.openInSafari(String(url));
      // No helper (incognito, or it isn't installed): the link, to paste into another browser.
      if (!open) return copyToClipboard(String(url), 'Link copied: paste it into Safari or Chrome');
      return open.catch(() => copyToClipboard(String(url), 'Link copied: paste it into Safari or Chrome'));
    },
    setTabSelection: (ids: string[]) => {
      here().selected = Array.isArray(ids) ? ids.map(String).filter((id) => store.state.tabs[id]) : [];
    },
    setLocalServersCollapsed: (collapsed: boolean) => store.setLocalServers({ collapsed: !!collapsed }),
    ignoreLocalPort: (port: number) => store.setLocalServers({ ignoredPorts: [...(store.state.ignoredLocalPorts ?? []), Number(port)] }),
    // Its open tabs reopen in the other partition (sync() finds them in the wrong one).
    setSpaceIsolated: spacesOnly((id: string, isolated: boolean) => {
      if (!canIsolate) return flash(here(), 'Separate cookies aren’t in this build yet');
      store.setIsolated(String(id), !!isolated);
    }),
    // The spike's clearSpaceData(): signs out of everything in the Space, then reloads its pages.
    clearSpaceData: spacesOnly(async (id: string) => {
      const space = store.state.spaces.find((s) => s.id === id);
      if (!space?.isolated || !canIsolate) return;
      await chrome.flechaPrivate.clearPartition(space.id);
      for (const tabId of store.allTabIds(space)) {
        const chromeId = live.get(tabId);
        if (chromeId !== undefined && livePartition.get(tabId) === space.id) void chrome.tabs.reload(chromeId);
      }
    }),
    deleteSpace: spacesOnly((id: string) => {
      if (store.state.spaces.length > 1) void unload(store.deleteSpace(id));
    }),
    toggleFolder: (id: string) => store.toggleFolder(id),
    renameFolder: (id: string, name: string) => store.renameFolder(id, name),
    moveTab: (id: string, target: DropTarget) => store.moveTab(here().view, id, target),
    clearToday: () => void unload(store.clearToday(here().view)),
    renameTab: (id: string, title: string) => store.updateTab(id, { customTitle: String(title).trim() || undefined }),
    toggleMute: (id: string) => toggleMute(String(id)),
    flash: (message: string) => flash(here(), String(message)),
    openPalette: (mode: string) => openPalette(mode),
    closePalette: () => {
      const win = here();
      win.frame.paletteOpen = false;
      sendFrame(win);
      if (hasFrame() && win.id >= 0) void chrome.flechaPrivate.focus('page', win.id);
    },
    toggleSidebar: () => {
      if (tourKey('toggleSidebar')) return;
      const win = here();
      win.frame.sidebarPeek = false;
      store.setSidebarVisible(win.view, !win.view.sidebarVisible);
    },
    setSidebarPeek: (peek: boolean) => {
      const win = here();
      if (win.view.sidebarVisible || win.frame.sidebarPeek === !!peek) return;
      win.frame.sidebarPeek = !!peek;
      sendState();
    },
    setTabDragging: (dragging: boolean) => {
      const win = here();
      win.frame.tabDragging = !!dragging;
      sendFrame(win);
    },
    zoom: (step: number) => {
      const win = here();
      const chromeId = activeChromeId(win);
      if (chromeId === undefined) return;
      void chrome.tabs.get(chromeId).then(async (tab) => {
        // The new tab page is the shell's, as is the sidebar: zooming one zoomed both.
        if (isStartPage(tab) || isShellPage(tab)) return;
        const zoom = await chrome.tabs.getZoom(chromeId);
        const next = step === 0 ? 1 : Math.min(5, Math.max(0.25, zoom + (step > 0 ? 0.1 : -0.1)));
        return chrome.tabs.setZoom(chromeId, next).then(() => refreshNav(win).then(sendState));
      });
    },
    splitWith: (id: string, side?: string, withId?: string) =>
      store.splitWith(here().view, String(id), side === 'left' ? 'left' : 'right', withId ? String(withId) : undefined),
    exitSplit: () => exitSplit(),
    swapSplit: () => store.swapSplit(here().view),
    dropToSplit: (id: string, side: string) => dropToSplit(String(id), side === 'left' ? 'left' : 'right'),
    splitNew: (input: string) => {
      const { view } = here();
      store.splitWith(view, openTab(input, false, view).id);
    },
    openSettings: (pane?: string) => showSettings(typeof pane === 'string' ? pane : undefined),
    finishOnboarding: () => store.setOnboarded(true),
    setPreferences: (prefs: { theme?: string; searchEngine?: string; adBlock?: boolean }) => {
      if (prefs?.theme === 'system' || prefs?.theme === 'light' || prefs?.theme === 'dark') store.setPreferences({ theme: prefs.theme });
      if (prefs?.searchEngine) store.setSearchEngine(prefs.searchEngine as SearchEngineId);
      if (typeof prefs?.adBlock === 'boolean') store.setAdBlock(prefs.adBlock);
    },
    searchHistory: async (query: string) =>
      (await chrome.history.search({ text: String(query), maxResults: 50, startTime: 0 })).filter((h) => isWebPage(h.url)).map((h) => ({
        url: h.url ?? '',
        title: h.title || h.url || '',
        visits: h.visitCount ?? 0,
        lastVisit: h.lastVisitTime ?? 0,
      })),
    // An incognito window's new tab page doesn't show where you've been.
    topSites: async () => {
      if (incognito) return [];
      const sites = (await chrome.topSites.get()).filter((s) => isWebPage(s.url));
      void favicons.want(sites.map((s) => s.url));
      return sites.map((s) => ({ url: s.url, title: s.title || s.url, visits: 0, lastVisit: 0 }));
    },
    importFlechaState: spacesOnly((json: string) => {
      const win = here();
      let state: BrowserState | undefined;
      try {
        state = JSON.parse(String(json)) as BrowserState;
      } catch {
        // Reported below.
      }
      // The tab ids change, so every open Chromium tab is closed and reopens on demand.
      const open = [...live.keys()];
      if (!state || !store.replaceState(state)) return flash(win, 'That isn’t a Flecha state file');
      void unload(open);
      const tabs = Object.keys(state.tabs).length;
      flash(win, `Imported ${state.spaces.length} Spaces and ${tabs} tabs`);
    }),
  });

  registerSiteControls({ store, activeChromeId: () => activeChromeId(), window: () => windowIdOf(here()) });
  registerExtensions((url) => openTab(url));

  // ---- commands by id, for keyboard shortcuts (the Electron spike's buildMenu) ----

  /** Copies through the window's frame page: the background has no document for the clipboard. */
  async function copyToClipboard(text: string, message: string, win = here()) {
    broadcast('clipboard', await windowIdOf(win), { text, message });
  }

  /** The whole page as a PNG in Downloads, through the DevTools protocol (captureVisibleTab stops at the window). */
  async function captureFullPage(win: Win) {
    const tab = store.activeTabOf(win.view);
    const chromeId = activeChromeId(win);
    if (!tab || chromeId === undefined || !isWebPage(tab.url)) return flash(win, 'Open a web page to capture it');
    if (!(await hold(chromeId, 'capture'))) return flash(win, 'This page can’t be captured');
    try {
      flash(win, 'Capturing the page…');
      const metrics = await send<{ cssContentSize: { width: number; height: number } }>(chromeId, 'Page.getLayoutMetrics');
      const size = metrics?.cssContentSize;
      // Very tall pages are cut at 16384px, Chromium's largest image.
      const clip = size && { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 16384), scale: 1 };
      const shot = await send<{ data: string }>(chromeId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(clip ? { clip } : {}) });
      if (!shot?.data) throw new Error('no image');
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      // Local time, as the Mac's own screenshots are named.
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
      const name = `${host(tab.url) || 'page'} ${stamp}.png`;
      await chrome.downloads.download({ url: `data:image/png;base64,${shot.data}`, filename: name, saveAs: false });
      flash(win, 'Full-page screenshot saved to Downloads');
    } finally {
      await release(chromeId, 'capture');
    }
  }

  /** Every Space, pinned tab and favorite as a JSON file in Downloads; Today and the archive come along. */
  async function exportSpaces() {
    const win = here();
    // The agent token is a password to this browser: it stays out of files.
    const { agent, window: _bounds, ...state } = store.state;
    const tabs = Object.fromEntries(Object.entries(state.tabs).map(([id, { loading, audible, history, ...t }]) => [id, t]));
    const json = JSON.stringify({ ...state, tabs }, null, 2);
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    await chrome.downloads.download({
      url: `data:application/json;base64,${base64(new TextEncoder().encode(json))}`,
      filename: `Flecha Spaces ${date}.json`,
      saveAs: false,
    });
    flash(win, `${state.spaces.length} Spaces exported to Downloads`);
  }

  /** ⌘1–⌘8 pick a tab by position (favorites, then pinned, then today); ⌘9 the last one. */
  function selectTabIndex(index: number) {
    const { view } = here();
    const ids = store.allTabIds(store.activeSpaceOf(view));
    const id = index < 0 ? ids[ids.length - 1] : ids[index];
    if (id) store.activate(view, id);
  }

  /** Next and previous tab, in sidebar order. Tabs another window has on screen are passed over: stepping by them would take them from it. */
  function cycleTab(step: 1 | -1) {
    const { view } = here();
    const space = store.activeSpaceOf(view);
    const active = store.activeTabIdIn(view, space);
    const ids = store.allTabIds(space).filter((id) => id === active || !store.shownElsewhere(id, view));
    if (!ids.length) return;
    const i = active ? ids.indexOf(active) : -1;
    store.activate(view, ids[(i + step + ids.length) % ids.length]);
  }

  /**
   * Recent tab (lib/recentTabs.ts): back through the tabs this window has shown in its Space,
   * by when it last showed them. Each window has its own history; a tab that is on screen in
   * another window now isn't part of the walk.
   */
  function recentTab() {
    const win = here();
    const { view } = win;
    const space = store.activeSpaceOf(view);
    const active = store.activeTabIdIn(view, space);
    const tabs = store.allTabIds(space).flatMap((id) => {
      const lastActive = store.lastShown(view, id);
      return lastActive !== undefined && (id === active || !store.shownElsewhere(id, view)) ? [{ id, lastActive }] : [];
    });
    const next = stepRecent(win.recentWalk, space.id, tabs, active, Date.now());
    if (!next) return;
    win.recentWalk = next.walk;
    store.activate(view, next.tabId);
    // A tab the walk only passed through wasn't used: it keeps the time it had.
    if (next.passed) {
      view.recent[next.passed.tabId] = next.passed.lastActive;
      store.updateTab(next.passed.tabId, { lastActive: next.passed.lastActive });
    }
  }

  function cycleSpace(step: 1 | -1) {
    const { view } = here();
    const spaces = store.state.spaces;
    const i = spaces.findIndex((sp) => sp.id === view.activeSpaceId);
    store.switchSpace(view, spaces[(i + step + spaces.length) % spaces.length].id);
  }

  /** A command on the active tab, if there is one. */
  const withTab = (fn: (tab: TabInfo, win: Win) => unknown) => () => {
    const win = here();
    const tab = store.activeTabOf(win.view);
    if (tab) return fn(tab, win);
  };

  /** ⌘⇧C and ⌥⌘C: every selected tab when more than one is, else the active tab. */
  const copyTabs = (one: (tab: TabInfo) => string, many: (tabs: TabInfo[]) => string, noun: string) => () => {
    const win = here();
    const tabs = win.selected.map((id) => store.state.tabs[id]).filter((t): t is NonNullable<typeof t> => !!t);
    if (tabs.length > 1) return copyToClipboard(many(tabs), `${tabs.length} ${noun}s copied`, win);
    const tab = store.activeTabOf(win.view);
    if (tab) return copyToClipboard(one(tab), `${noun[0].toUpperCase()}${noun.slice(1)} copied`, win);
  };
  const markdownLink = (tab: TabInfo) => `[${tab.customTitle ?? tab.title}](${tab.url})`;

  const commands: Record<ShortcutId | 'closePeek', () => unknown> = {
    newTab: () => openPalette('new-tab'),
    openLocation: () => openPalette('navigate'),
    back: () => call('back'),
    forward: () => call('forward'),
    reload: () => call('reload'),
    hardReload: onActive((id) => chrome.tabs.reload(id, { bypassCache: true })),
    // TODO(chromium): Chromium's own find bar does find in page; when a native patch routes ⌘F
    // here instead, whatever module draws Flecha's find bar handles this command.
    find: () => call('find'),
    toggleSidebar: () => call('toggleSidebar'),
    settings: () => showSettings(),
    nextWindow: () => cycleWindow(1),
    previousWindow: () => cycleWindow(-1),
    newFlechinha: () => call('newFlechinha'),
    closeTab: withTab((tab) => call('close', tab.id)),
    reopenTab: () => {
      const item = store.popArchive();
      if (item) openTab(item.url);
    },
    nextTab: () => cycleTab(1),
    previousTab: () => cycleTab(-1),
    recentTab,
    pinTab: spacesOnly(withTab((tab, win) => store.togglePin(win.view, tab.id))),
    duplicateTab: withTab((tab) => openTab(tab.url)),
    muteTab: withTab((tab) => toggleMute(tab.id)),
    clearToday: () => call('clearToday'),
    copyLink: copyTabs((tab) => tab.url, (tabs) => tabs.map((t) => t.url).join('\n'), 'link'),
    copyMarkdown: copyTabs(markdownLink, (tabs) => tabs.map((t) => `- ${markdownLink(t)}`).join('\n'), 'Markdown link'),
    screenshot: () => call('capturePage'),
    nextSpace: () => cycleSpace(1),
    previousSpace: () => cycleSpace(-1),
    newSpace: () => call('newSpace'),
    splitNew: () => openPalette('split'),
    exitSplit: () => exitSplit(),
    zoomIn: () => call('zoom', 1),
    zoomOut: () => call('zoom', -1),
    actualSize: () => call('zoom', 0),
    // Owned by other shell modules, which handle a hub command of the same name.
    devTools: () => call('devTools'),
    responsive: () => call('toggleResponsive'),
    nextEnvironment: () => call('nextEnvironment'),
    editBoost: () => call('editBoost'),
    closePeek: () => call('closePeek'),
    viewSource: withTab((tab, win) => isWebPage(tab.url) && addTab(win.view, `view-source:${tab.url}`, { activate: true })),
    shortcuts: () => showSettings('shortcuts'),
  };

  /**
   * Runs a command by its id in lib/shortcuts.ts, plus "tab1"…"tab9" (⌘1…⌘9, 9 is the
   * last tab) and "space1"…"space9" (⌃1…⌃9). "tabN" / "spaceN" take the number as `n`.
   * Returns whether the id is a command.
   */
  function runCommand(id: string, n?: number): boolean {
    const numbered = /^(tab|space)(\d|N)$/.exec(id);
    if (numbered) {
      const i = numbered[2] === 'N' ? Number(n) : Number(numbered[2]);
      if (!Number.isInteger(i) || i < 1 || i > 9) return false;
      if (numbered[1] === 'tab') selectTabIndex(i === 9 ? -1 : i - 1);
      else if (store.state.spaces[i - 1]) store.switchSpace(here().view, store.state.spaces[i - 1].id);
      return true;
    }
    if (!Object.hasOwn(commands, id)) return false;
    void Promise.resolve(commands[id as keyof typeof commands]()).catch((err) => console.error(`Flecha shell: "${id}" failed`, err));
    return true;
  }
  handle({ run: (id: string, n?: number) => runCommand(String(id), n) });

  registerSettings({
    store,
    view: () => here().view,
    unload: (ids) => void unload(ids),
    broadcastState: sendState,
    isOpen: (id) => live.has(id),
    load: (id, url) => {
      const chromeId = live.get(id);
      if (chromeId !== undefined) void chrome.tabs.update(chromeId, { url });
    },
    agentEndpoint: () => nativeHost?.agentEndpoint(),
    hostError: () => nativeHost?.hostError(),
    defaultBrowser: () => defaultBrowser,
    makeDefaultBrowser: async () => {
      await call('makeDefaultBrowser');
      await refreshDefaultBrowser();
    },
    reopen: (address) => void openTab(address),
    clearIsolatedSpaces: async () => {
      if (!canIsolate) return;
      for (const space of store.state.spaces) if (space.isolated) await chrome.flechaPrivate.clearPartition(space.id).catch(() => undefined);
    },
  });
  void refreshDefaultBrowser();
  chrome.windows.onFocusChanged.addListener((id) => id !== chrome.windows.WINDOW_ID_NONE && void refreshDefaultBrowser());

  // Boosts, environments, local servers, the responsive view, console errors and ad blocking.
  features = registerFeatures({ store, view: () => here().view, broadcastState: sendState, liveTabId: (id) => live.get(id), activeChromeTabId: () => activeChromeId() });

  // Imports and the coding-agent bridge, through Flecha's native messaging host. Both are
  // about your regular Spaces, so incognito windows have neither.
  if (!incognito) nativeHost = registerNativeHost({
    store,
    // The agent works in the window in front.
    view: () => focused().view,
    broadcastState: sendState,
    tabs: {
      open: (url, background) => openTab(url, !background, focused().view).id,
      chromeTab: async (id) => {
        await syncing;
        return live.get(id) ?? (store.state.tabs[id] ? openChromeTab(id, false, focused()) : undefined);
      },
      activate: (id) => store.activate(focused().view, id),
      close: (id) => {
        store.closeTab(id);
        void unload([id]);
      },
    },
  });

  onConnect((page) => {
    // A new window's sidebar may be up before any of its tabs has said the window is there.
    if (page.windowId !== undefined && !page.flechinha && !wins.has(page.windowId)) void ensureWin(page.windowId).then(sendState);
    sendState();
    void siteIcons.all().then((icons) => broadcast('site-icons', icons));
  });

  // Flecha's keyboard shortcuts, taken by the browser before the page (patch 0016).
  registerNative({
    store,
    chromeTabId: (id) => live.get(id),
    flechaTabId: (chromeId) => flechaIdFor(chromeId),
    view: () => here().view,
    viewOfWindow: (windowId) => wins.get(windowId)?.view,
    run: async (command, windowId) => {
      // Next window is the same from any window, a Flechinha too.
      if (command === 'nextWindow' || command === 'previousWindow') return void cycleWindow(command === 'nextWindow' ? 1 : -1, windowId !== undefined && windowId >= 0 ? windowId : undefined);
      // In a Flechinha, its own toolbar answers the few shortcuts it has. The browser is asked:
      // it opens the Flechinhas for links from other apps itself, without telling the shell.
      if (await isFlechinhaWindow(windowId)) return broadcast('flechinha:command', windowId, command);
      // Settings on a pane, asked for by an incognito window (runInRegularProfile).
      const pane = /^openSettings:(\w+)$/.exec(command);
      if (pane) return void openSettings(pane[1]);
      const numbered = /^select(Tab|Space):(\d)$/.exec(command);
      // In the window the keys were pressed in (-1: none, so the window in front).
      const win = await ensureWin(windowId);
      callAs(win ? { windowId: win.id } : undefined, () => runCommand(numbered ? `${numbered[1].toLowerCase()}${numbered[2]}` : command));
    },
    // Into a Flechinha: the page leaves its Space without closing.
    releaseTab: (id) => {
      live.delete(id);
      livePartition.delete(id);
      rememberLive();
      store.closeTab(id);
    },
    // Back from a Flechinha ("Open in Flecha"): an active Today tab in the current Space.
    adoptTab: (chromeId) => adoptTab(chromeId),
  });
  sync();
  wantFavicons();
  // Arc's auto-archive, hourly as in Electron. An alarm, since the background sleeps.
  // Made once: making it again on every wake would restart the hour.
  // (Incognito tabs are never archived: they go with their window.)
  if (!incognito) void chrome.alarms.get(ARCHIVE_ALARM).then((alarm) => void (alarm ?? chrome.alarms.create(ARCHIVE_ALARM, { periodInMinutes: 60 })));
  const archiveStale = () => void unload(store.archiveStale());

  return { onCreated, onUpdated, onActivated, onRemoved, onFocus, closeWin, openPalette, runCommand, archiveStale };
}

const url = (tab: chrome.tabs.Tab) => tab.pendingUrl || tab.url || '';
const host = (address: string) => {
  try {
    return new URL(address).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Base64 in chunks: spreading a big state file into one call overflows the stack. */
function base64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Runs in the page (chrome.scripting): pauses whatever plays, or plays what was playing last.
 * Answers "playing" or "paused" for the frame that has media, nothing for frames without.
 */
function toggleMediaInPage(): 'playing' | 'paused' | undefined {
  const all = [...document.querySelectorAll<HTMLMediaElement>('video, audio')];
  if (!all.length) return undefined;
  const playing = all.filter((m) => !m.paused);
  if (playing.length) {
    for (const m of playing) {
      m.pause();
      m.dataset.flechaPaused = '1';
    }
    return 'paused';
  }
  const resume = all.filter((m) => m.dataset.flechaPaused);
  for (const m of resume.length ? resume : all.slice(0, 1)) {
    delete m.dataset.flechaPaused;
    void m.play().catch(() => undefined);
  }
  return 'playing';
}
/** Flecha's own pages (the sidebar opened in a tab while debugging, say) aren't browsing tabs. */
const isShellPage = (tab: chrome.tabs.Tab) => url(tab).startsWith(chrome.runtime.getURL(''));
/** Sites worth suggesting: not Flecha's or Chromium's own pages. */
const isWebPage = (address = '') => /^https?:/.test(address);
const isStartPage = (tab: chrome.tabs.Tab) => /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(url(tab));

// Listeners go on in the first turn, or Chromium drops the event that woke the background;
// each waits for the saved state to load.
const ready = start();
listen(ready);

/**
 * Runs a Flecha command by id (lib/shortcuts.ts, plus tab1…tab9 and space1…space9), as
 * the Electron spike's menu accelerators did: for keyboard shortcuts from the browser
 * (chrome.flechaPrivate.onShortcut). Resolves to whether the id is a command. The same is the
 * hub command "run", for pages.
 */
export function run(id: string, n?: number): Promise<boolean> {
  return ready.then((r) => r.runCommand(id, n));
}
registerDownloads();
chrome.tabs.onCreated.addListener((tab) => void ready.then((r) => r.onCreated(tab)));
chrome.tabs.onUpdated.addListener((id, info, tab) => void ready.then((r) => r.onUpdated(id, info, tab)));
chrome.tabs.onActivated.addListener((info) => void ready.then((r) => r.onActivated(info)));
chrome.tabs.onRemoved.addListener((id, info) => void ready.then((r) => r.onRemoved(id, info)));
chrome.windows.onFocusChanged.addListener((id) => id !== chrome.windows.WINDOW_ID_NONE && void ready.then((r) => r.onFocus(id)));
chrome.windows.onRemoved.addListener((id) => void ready.then((r) => r.closeWin(id)));
chrome.alarms.onAlarm.addListener((alarm) => alarm.name === ARCHIVE_ALARM && void ready.then((r) => r.archiveStale()));

// Until the native patch opens it on its own, the toolbar button opens the sidebar.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ⌘L: the browser sends this instead of focusing its hidden address bar (patch 0009).
chrome.commands.onCommand.addListener((command) => {
  if (command === 'flecha-open-location') void ready.then((r) => r.openPalette('navigate'));
});
