/**
 * The shell's background: Flecha's Store, kept in step with real Chromium tabs and windows.
 *
 * The Store is the source of truth, as in Electron. A Flecha tab only gets a Chromium tab
 * once it is opened (like Electron only made a view for it then), so a sidebar of a hundred
 * pinned tabs costs nothing until you use them. Chromium tabs that pages open themselves
 * (links to a new tab, window.open) become Flecha tabs.
 *
 * Each normal Chromium window (not a Flechinha) is one of the Store's windows, with its own
 * active Space and Today tabs. Pinned tabs and favorites are shared: one opened in a window
 * moves there, page and all, from whichever window had it.
 */
import { Store, pinnedTabIds, type StatePersistence } from '../shared/store';
import { decodeState, loadSavedState, setAsideBeforeImport, stateBeforeImport, STATE_KEY } from '../shared/savedState';
import { pinnableAddress, resolveInput, sameAddress, searchEngine } from './lib/url';
import { canDropToSplit, pageSplitTarget } from './lib/splitDrop';
import { shortcutHints, type ShortcutId } from './lib/shortcuts';
import { describe as describeEnvironment } from './lib/environments';
import type { BrowserState, DropTarget, FlechaApi, SearchEngineId, UiState } from '../shared/types';
import { asWindow, broadcast, broadcastTo, call, callerWindow, handle, listen, onConnect, sendTo, statePages } from './hub';
import { changedFields, OpenTabSnapshot } from './stateUpdates';
import { LiveTabs } from './liveTabs';
import type { MenuRun } from './protocol';
import type { MenuEntry } from './settingsUi';
import { openSettings, registerSettings } from './settingsHandlers';
import { registerNativeHost } from './nativeHost';
import { SiteIcons } from './siteIcons';
// Loaded on the first turn: its modules add webNavigation and message listeners as they load.
import { registerFeatures, type Features } from './features';
// Also loaded on the first turn, for the shortcut event that may have woken the background.
import { currentPeek, defaultBrowserState, frameResized, isFlechinha, isFlechinhaWindow, registerNative, runInPeek } from './native';
import { registerDownloads } from './downloads';
import { registerSiteControls } from './siteControls';
import { Favicons } from './favicons';
import { TAB_SLEEP_ALARM, createTabSleep, tabSleepSupported } from './tabSleep';
import { EVALUATE_EVERY } from '../shared/tabSleep';
import { followedPreferences, incognito, incognitoState, sessionKey } from './incognito';

/** Flecha tab id ↔ Chromium tab id, for the tabs that are open. Kept across background restarts. */
const LIVE_KEY = 'live';
/** Chromium window id → Flecha window id, for this browser session. Kept across background restarts. */
const WINDOWS_KEY = 'windows';
const ARCHIVE_ALARM = 'archive-stale';
/** Help: the project's page (README.md's own clone URL). */
const HELP_URL = 'https://github.com/lucianodiisouza/flecha-browser#readme';

const live = new LiveTabs();
const flechaIdFor = (chromeId: number) => [...live].find(([, c]) => c === chromeId)?.[0];
/** Chromium tabs we're closing ourselves, so their events aren't taken as the user's. */
const ours = new Set<number>();
/** Tabs we're creating right now: Chromium may announce them before create() returns their id. */
let creating = 0;
/** Windows we're creating right now (reopening one): mapped once create() returns. */
let creatingWindows = 0;
/** Settles when the windows being created are mapped; their first tabs wait for it. */
let windowsCreated: Promise<unknown> = Promise.resolve();
/** Per Chromium window, a blank tab that keeps it open while Flecha has no tab open in it. */
const placeholders = new Map<number, number>();
/** Chromium window → Flecha window. */
const windowMap = new Map<number, string>();
/** Windows a tab is being moved out of: Chromium activates a neighbour there, which isn't the user's choice. */
const movingFrom = new Set<number>();
/**
 * Chromium tabs we just activated ourselves. Their tabs.onActivated can arrive after the Store
 * has moved on to another tab, and must not be taken as you choosing them again.
 */
const ourActivations = new Set<number>();
let startupUnsplits: Array<{ tabId: number; windowId: number }> | undefined = [];

async function start() {
  const saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  // An incognito window's tabs live in session storage, under keys of its own (incognito.ts);
  // the regular state only gives it your preferences. Only the regular copy keeps a last good
  // state and recovers from damage (savedState.ts).
  const own = incognito ? (await chrome.storage.session.get(sessionKey(STATE_KEY)))[sessionKey(STATE_KEY)] : undefined;
  const regular = incognito ? undefined : await loadSavedState(chrome.storage.local);
  if (regular?.recovered) console.error(`Flecha: the saved state could not be read; started from ${regular.recovered === 'last-good' ? 'the last good copy' : 'a fresh state'}`);
  const persistence: StatePersistence = incognito
    ? {
        load: () => decodeState(own) ?? incognitoState(decodeState(saved)),
        save: (json) => chrome.storage.session.set({ [sessionKey(STATE_KEY)]: json }),
      }
    : {
        load: () => regular?.state,
        save: (json) => chrome.storage.local.set({ [STATE_KEY]: json }),
      };
  const store = new Store(persistence);
  /** Physical tabs can be mapped before they are ready; consumers share their pending setup. */
  const tabSetups = new Map<string, { promise: Promise<number>; transferred: boolean }>();
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
  const session = await chrome.storage.session.get([sessionKey(LIVE_KEY), sessionKey(WINDOWS_KEY)]);
  const restored = session[sessionKey(LIVE_KEY)] as Record<string, number> | undefined;
  const existing = new Set((await chrome.tabs.query({})).map((t) => t.id));
  for (const [id, chromeId] of Object.entries(restored ?? {})) if (existing.has(chromeId) && store.state.tabs[id]) live.set(id, chromeId);
  const openWindows = new Set((await chrome.windows.getAll()).map((w) => w.id));
  for (const [chromeId, id] of Object.entries((session[sessionKey(WINDOWS_KEY)] as Record<string, string> | undefined) ?? {})) {
    if (openWindows.has(Number(chromeId)) && store.hasWindow(id)) windowMap.set(Number(chromeId), id);
  }
  // A fresh browser session (not a background restart): Chromium has new window ids.
  const freshSession = !restored;
  if (freshSession) store.archiveStale();
  // None of an earlier incognito session's tabs are left: this is a new one, which starts empty.
  if (incognito && !live.size && (Object.keys(store.state.tabs).length || store.state.archive.length)) {
    store.replaceState(incognitoState(decodeState(saved)));
  }
  if (incognito) {
    // Settings change the regular state; incognito windows follow your preferences.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STATE_KEY]) return;
      const prefs = followedPreferences(decodeState(changes[STATE_KEY].newValue));
      const keys = Object.keys(prefs) as Array<keyof BrowserState>;
      if (keys.some((k) => JSON.stringify(prefs[k]) !== JSON.stringify(store.state[k]))) store.followPreferences(prefs);
    });
    // The last incognito window closed: its tabs are forgotten.
    chrome.windows.onRemoved.addListener(async () => {
      if ((await chrome.windows.getAll()).length) return;
      await chrome.storage.session.remove([sessionKey(STATE_KEY), sessionKey(LIVE_KEY), sessionKey(WINDOWS_KEY)]);
    });
  }

  // ---- windows ----------------------------------------------------------------

  const rememberWindows = () => void chrome.storage.session.set({ [sessionKey(WINDOWS_KEY)]: Object.fromEntries(windowMap) });
  const chromeWindowOf = (windowId: string) => [...windowMap].find(([, id]) => id === windowId)?.[0];
  /** Whether a Chromium window is one of Flecha's: a normal window that isn't a Flechinha. */
  async function isFlechaWindow(chromeWindowId: number) {
    const win = await chrome.windows.get(chromeWindowId).catch(() => undefined);
    return win?.type === 'normal' && !(await isFlechinhaWindow(chromeWindowId));
  }
  /**
   * The Flecha window a Chromium window is. One seen for the first time takes a saved window no
   * other Chromium window has (at start, the windows of the last session), or a new one showing
   * the focused window's Space.
   */
  function attachWindow(chromeWindowId: number): string {
    const known = windowMap.get(chromeWindowId);
    if (known) return known;
    const taken = new Set(windowMap.values());
    const id = store.state.windows.find((w) => !taken.has(w.id))?.id ?? store.openWindow().id;
    windowMap.set(chromeWindowId, id);
    rememberWindows();
    return id;
  }
  /** The Flecha window of a Chromium window, if it is one of Flecha's. */
  const windowOf = (chromeWindowId: number | undefined) => (chromeWindowId === undefined ? undefined : windowMap.get(chromeWindowId));
  /** The window a command acts in: the calling page's, else the focused one. */
  const here = () => windowOf(callerWindow()) ?? store.focusedWindowId;

  // Chromium's own windows at start: the last focused takes the window you last used.
  const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  const normal = (await chrome.windows.getAll({ windowTypes: ['normal'] })).sort((a, b) => Number(b.id === focused?.id) - Number(a.id === focused?.id));
  for (const win of normal) if (await isFlechaWindow(win.id!)) attachWindow(win.id!);
  const focusedWindow = windowOf(focused?.id);
  if (focusedWindow) store.focusWindow(focusedWindow);

  // Tabs Chromium opened before we were running: its start page shows its window's active Flecha
  // tab (closing it would close the window), anything else becomes a Flecha tab.
  for (const tab of await chrome.tabs.query({})) {
    const windowId = windowOf(tab.windowId);
    if ([...live.values()].includes(tab.id!) || isShellPage(tab) || !windowId) continue;
    const active = store.activeTabIn(windowId);
    if (isStartPage(tab) && active && !live.has(active.id)) {
      // A blank tab reloads the new tab page: Chromium drew its own before the shell was loaded.
      void adoptChromeTab(active.id, tab.id!, active.url === 'about:blank' ? 'chrome://newtab/' : active.url, true)
        .catch((err) => console.error('Flecha shell: restoring a tab failed', err));
    } else if (isStartPage(tab) && !active && !placeholders.has(tab.windowId)) {
      placeholders.set(tab.windowId, tab.id!);
      void chrome.tabs.update(tab.id!, { url: 'chrome://newtab/' });
    } else if (isStartPage(tab)) {
      ours.add(tab.id!);
      void chrome.tabs.remove(tab.id!);
    } else {
      live.set(addTab(url(tab), { activate: tab.active, windowId }).id, tab.id!);
      // An address Chromium was launched with started loading before the shell did; loading the
      // shell (it has declarativeNetRequest) cancelled requests already in flight, before this code
      // runs, which leaves the tab blank with the address still pending. The tab doesn't reliably
      // say it has stopped, so any address that hasn't committed is loaded again.
      if (!tab.url && tab.pendingUrl) void chrome.tabs.update(tab.id!, { url: tab.pendingUrl });
    }
  }

  /** A Flecha tab for an address; the new tab page and empty addresses make a blank "New Tab". */
  function addTab(address: string, opts: Parameters<Store['addTab']>[1]) {
    const blank = !address || address === 'about:blank' || isStartPage({ url: address } as chrome.tabs.Tab);
    const tab = store.addTab(blank ? 'about:blank' : address, opts);
    if (blank) store.updateTab(tab.id, { title: 'New Tab' });
    return tab;
  }

  // Icons fetched from the sites themselves, for those Chromium has none of yet.
  const siteIcons = new SiteIcons((icons) => broadcast('site-icons', icons));
  const favicons = new Favicons(
    () => sendStateSoon(),
    (hosts) => void siteIcons.want(hosts),
  );
  const rememberLive = () => void chrome.storage.session.set({ [sessionKey(LIVE_KEY)]: Object.fromEntries(live) });

  /** What the pages of a Flecha window draw. */
  function uiFields(windowId: string, chromeWindowId: number | undefined): Omit<UiState, 'tabs'> {
    const { windows: _windows, closedWindows: _closed, spaces: _spaces, tabs: _tabs, ...shared } = store.state;
    const active = store.activeTabIn(windowId);
    const frame = frameOf(chromeWindowId);
    return {
      ...shared,
      ...store.windowView(windowId),
      searchEngineName: searchEngine(store.state.searchEngine).name,
      // The light tint; pages darken it themselves, since only they know the system appearance.
      tint: store.activeSpaceIn(windowId).color,
      sidebarVisible: store.sidebarVisibleIn(windowId),
      sidebarMode: store.sidebarVisibleIn(windowId) ? 'docked' : frame.sidebarPeek ? 'floating' : 'hidden',
      environment: active ? describeEnvironment(active.url, store.state.environments) : undefined,
      localServers: features?.localServers() ?? [],
      consoleErrors: features?.consoleErrors() ?? {},
      boostedHosts: features?.boostedHosts() ?? [],
      faviconHosts: favicons.list(),
      faviconUrl: favicons.url,
      shortcuts: shortcutHints(store.state),
      undo: store.undoLabel,
      defaultBrowser,
      agent: nativeHost?.agentActivity(),
      nav: navStates.get(windowId) ?? { canGoBack: true, canGoForward: true, zoom: 100 },
    };
  }

  const navStates = new Map<string, UiState['nav']>();
  /** Every window's pages get their own window's state; pages in no Flecha window (a Flechinha's) the focused one's. */
  const snapshot = new OpenTabSnapshot();
  const sentFields = new Map<number | undefined, Map<string, string>>();
  const initialized = new WeakSet<chrome.runtime.Port>();
  const toolbarState = new WeakMap<chrome.runtime.Port, string>();
  function publish(dirty?: ReadonlySet<string>, layouts?: ReadonlySet<string>) {
    const windows = statePages();
    for (const id of sentFields.keys()) if (!windows.has(id)) sentFields.delete(id);
    if (!windows.size) return;
    const changes = snapshot.update(dirty ? store.state.tabs : store.openTabs(), dirty);
    const tabsChanged = !!(changes.removed.length || Object.keys(changes.tabs).length);
    for (const [chromeWindowId, ports] of windows) {
      const windowId = windowOf(chromeWindowId) ?? store.focusedWindowId;
      const active = store.activeTabIn(windowId);
      let full = !dirty ? uiFields(windowId, chromeWindowId) : undefined;
      const previous = sentFields.get(chromeWindowId) ?? new Map<string, string>();
      sentFields.set(chromeWindowId, previous);
      const layoutChanged = layouts?.has(windowId);
      const fields = full ?? {
        ...(layoutChanged ? { ...store.windowView(windowId), tint: store.activeSpaceIn(windowId).color,
          nav: navStates.get(windowId) ?? { canGoBack: true, canGoForward: true, zoom: 100 } } : {}),
        ...(layoutChanged || (active && dirty?.has(active.id))
          ? { environment: active && describeEnvironment(active.url, store.state.environments) } : {}),
      };
      const delta = changedFields(previous, fields, !!full);
      const changed = tabsChanged || delta.cleared.length || Object.keys(delta.fields).length;
      for (const port of ports) {
        if (port.name === 'flecha-toolbar') {
          if (dirty && !layoutChanged) continue;
          const space = store.activeSpaceIn(windowId);
          const data = { tint: space.color, space: { name: space.name, emoji: space.emoji }, searchEngine: store.state.searchEngine,
            searchEngineName: searchEngine(store.state.searchEngine).name };
          const key = JSON.stringify(data);
          if (toolbarState.get(port) !== key && sendTo(port, 'toolbar-state', data)) {
            toolbarState.set(port, key);
          }
        } else if (port.name === 'flecha' || !initialized.has(port)) {
          full ??= uiFields(windowId, chromeWindowId);
          if (sendTo(port, 'state', { ...full, tabs: snapshot.tabs })) initialized.add(port);
        } else if (changed) {
          if (!sendTo(port, 'state-update', { ...changes, ...delta })) initialized.delete(port);
        }
      }
      if (!dirty) sendFrame(chromeWindowId);
    }
  }
  const sendState = () => publish();

  // ---- the window frame, as the Electron spike's Browser.layout() --------------
  // The frame page applies it (chrome.flechaPrivate.setFrame), since only a page knows
  // whether the system is in dark mode for the background colour. Each window has its own.
  type Frame = { palette?: { mode: string; id: string }; sidebarPeek: boolean; tabDragging: boolean; overlays: Set<string>; sent?: string };
  const frames = new Map<number | undefined, Frame>();
  function frameOf(chromeWindowId: number | undefined): Frame {
    let frame = frames.get(chromeWindowId);
    if (!frame) frames.set(chromeWindowId, (frame = { sidebarPeek: false, tabDragging: false, overlays: new Set() }));
    return frame;
  }
  function sendFrame(chromeWindowId: number | undefined, joining?: chrome.runtime.Port) {
    const frame = frameOf(chromeWindowId);
    const docked = store.sidebarVisibleIn(windowOf(chromeWindowId) ?? store.focusedWindowId);
    const sidebar: chrome.flechaPrivate.SidebarMode = docked ? 'docked' : frame.sidebarPeek ? 'floating' : 'hidden';
    // The frame covers the whole window while it draws over the page.
    const overlay = !!frame.palette || frame.tabDragging || frame.overlays.size > 0 || !store.state.onboarded;
    const data = { sidebar, overlay, sidebarInPageFullscreen: !!store.state.sidebarInPageFullscreen };
    const key = JSON.stringify(data);
    if (frame.sent === key) {
      if (joining) sendTo(joining, 'frame', data);
      return;
    }
    frame.sent = key;
    broadcastTo(chromeWindowId, 'frame', data);
  }
  const hasFrame = () => typeof chrome.flechaPrivate?.setFrame === 'function';
  /** The Chromium window a command acts in: the calling page's, else the focused Flecha window's. */
  const hereChrome = () => callerWindow() ?? chromeWindowOf(store.focusedWindowId);
  /** During the welcome tour, a shortcut is reported to it instead of acting. Returns whether it was. */
  function tourKey(command: string | undefined) {
    if (store.state.onboarded || !command) return false;
    broadcastTo(hereChrome(), 'tour-key', command);
    return true;
  }

  function openPalette(mode: string) {
    // The tour asks you to try the real shortcuts and shows what they do.
    if (tourKey(({ 'new-tab': 'newTab', navigate: 'openLocation', split: 'splitNew' } as Record<string, string>)[mode])) return;
    const chromeWindowId = hereChrome();
    const palette = { mode, id: crypto.randomUUID() };
    frameOf(chromeWindowId).palette = palette;
    sendFrame(chromeWindowId);
    broadcastTo(chromeWindowId, 'palette', palette.mode, palette.id);
    if (hasFrame()) void chrome.flechaPrivate.focus('frame', chromeWindowId);
  }

  /** Closes a window's command bar, in its frame page too: a bar left there covers the sidebar. */
  function closePaletteIn(chromeWindowId: number | undefined) {
    const frame = frames.get(chromeWindowId);
    if (!frame?.palette) return;
    const { id } = frame.palette;
    delete frame.palette;
    sendFrame(chromeWindowId);
    broadcastTo(chromeWindowId, 'close-palette', id);
  }

  /** Windows being made, by Flecha window: a second ask while one is made waits for it. */
  const makingWindows = new Map<string, Promise<number>>();
  /** The Chromium window of a Flecha window, made again if it has none (it was closed, or is being reopened). */
  function chromeWindowFor(windowId: string): Promise<number> {
    const known = chromeWindowOf(windowId);
    if (known !== undefined) return Promise.resolve(known);
    let making = makingWindows.get(windowId);
    if (!making) {
      making = makeChromeWindow(windowId).finally(() => makingWindows.delete(windowId));
      makingWindows.set(windowId, making);
    }
    return making;
  }
  async function makeChromeWindow(windowId: string): Promise<number> {
    creatingWindows++;
    const created = chrome.windows.create({ focused: windowId === store.focusedWindowId }).then((win) => {
      windowMap.set(win!.id!, windowId);
      rememberWindows();
      return win!.id!;
    });
    windowsCreated = Promise.allSettled([windowsCreated, created]);
    try {
      return await created;
    } finally {
      creatingWindows--;
    }
  }
  /** The focused Flecha window's Chromium window: where tabs from no window in particular go. */
  const focusedChromeWindow = () => chromeWindowFor(store.focusedWindowId);

  /**
   * A coding agent's tab keeps other extensions' scripts out (patch 0080): a password manager's
   * frames there stop the agent from driving the page. The mark has to be on the Chromium tab
   * before it loads the page, so call this first.
   */
  async function markAgentTab(id: string, chromeId: number) {
    if (!store.state.tabs[id]?.agent || typeof chrome.flechaPrivate?.setAgentTab !== 'function') return;
    await chrome.flechaPrivate.setAgentTab(chromeId, true);
  }
  /** Starts setup once per logical tab, before its first asynchronous operation can yield. */
  function setupTab(id: string, setup: () => Promise<number>): Promise<number> {
    const pending = tabSetups.get(id);
    if (pending) return pending.promise;
    const entry = {
      transferred: false,
      promise: Promise.resolve().then(setup).finally(() => {
        if (tabSetups.get(id) === entry) tabSetups.delete(id);
      }),
    };
    tabSetups.set(id, entry);
    return entry.promise;
  }
  /** Marks before navigating, and leaves a tab taken by the user to its new owner. */
  async function prepareChromeTab(id: string, chromeId: number, url?: string, active?: boolean) {
    const agent = !!store.state.tabs[id]?.agent;
    await markAgentTab(id, chromeId);
    if (tabSetups.get(id)?.transferred) {
      // A late mark must not restrict the page after it has moved into a Flechinha.
      await chrome.flechaPrivate.setAgentTab(chromeId, false);
      throw new Error('Tab transferred during setup');
    }
    if (!store.state.tabs[id] || live.get(id) !== chromeId) throw new Error('Tab ownership changed during setup');
    if (agent && !store.state.tabs[id].agent) {
      await chrome.flechaPrivate.setAgentTab(chromeId, false);
    }
    if (url) await chrome.tabs.update(chromeId, { url, ...(active === undefined ? {} : { active }) });
  }
  /** A window's start tab follows the same readiness and failure rules as a newly created tab. */
  function adoptChromeTab(id: string, chromeId: number, url?: string, active?: boolean) {
    const pending = tabSetups.get(id);
    if (pending) return pending.promise;
    // Startup can visit several blank tabs in one turn; reserve the first before yielding.
    live.set(id, chromeId);
    return setupTab(id, async () => {
      try {
        await prepareChromeTab(id, chromeId, url, active);
        rememberLive();
        return chromeId;
      } catch (error) {
        await removeFailedTab(id, chromeId);
        throw error;
      }
    });
  }
  /** The agent's tabs as of the last change: see unmarkAgentTabs(). */
  let agentTabIds = new Set(Object.keys(store.state.tabs).filter((id) => store.state.tabs[id].agent));
  /**
   * A tab you moved out of the agent's folder is yours: other extensions run in it again, from
   * its next page on.
   */
  function unmarkAgentTabs() {
    const now = new Set(Object.keys(store.state.tabs).filter((id) => store.state.tabs[id].agent));
    for (const id of agentTabIds) if (!now.has(id)) unmarkAgentTab(id);
    agentTabIds = now;
  }
  function unmarkAgentTab(id: string) {
    const chromeId = live.get(id);
    if (chromeId === undefined || typeof chrome.flechaPrivate?.setAgentTab !== 'function') return;
    void chrome.flechaPrivate.setAgentTab(chromeId, false).catch(() => undefined);
  }

  function openChromeTab(id: string, active: boolean, windowId: string) {
    return setupTab(id, async () => {
      const tab = store.state.tabs[id];
      if (!tab) throw new Error('Tab closed before setup');
      const partition = partitionFor(id);
      const url = tab.url === 'about:blank' ? undefined : tab.url;
      // An agent's tab opens blank and loads its page once marked.
      const agent = !!tab.agent && typeof chrome.flechaPrivate?.setAgentTab === 'function';
      creating++;
      let chromeId: number | undefined;
      try {
        const options = { windowId: await chromeWindowFor(windowId), url: agent ? 'about:blank' : url, active };
        // A Space with separate cookies and logins: its own storage partition (patch 0034).
        chromeId = partition
          ? await chrome.flechaPrivate.createTab({ ...options, partition })
          : (await chrome.tabs.create(options)).id!;
        live.set(id, chromeId);
        livePartition.set(id, partition);
        if (agent) await prepareChromeTab(id, chromeId, url);
        if (tab.muted) void chrome.tabs.update(chromeId, { muted: true });
        rememberLive();
        return chromeId;
      } catch (error) {
        if (chromeId !== undefined) await removeFailedTab(id, chromeId);
        throw error;
      } finally {
        creating--;
      }
    });
  }

  /**
   * Brings an open tab into a Chromium window (a pinned tab or favorite opened in another
   * window), page and all. The window it leaves keeps a blank tab if it would be left empty,
   * since Chromium closes a window with its last tab.
   */
  async function moveChromeTab(chromeId: number, chromeWindowId: number) {
    const tab = await chrome.tabs.get(chromeId).catch(() => undefined);
    if (!tab || tab.windowId === chromeWindowId) return;
    const from = tab.windowId;
    const source = windowOf(from);
    const id = flechaIdFor(chromeId);
    if (source && id) {
      for (const space of store.windowView(source).spaces) {
        if (space.split?.includes(id)) nativePairs.delete(space.split);
      }
    }
    movingFrom.add(from);
    try {
      if ((await chrome.tabs.query({ windowId: from })).length === 1 && !placeholders.has(from)) await makePlaceholder(from);
      await chrome.tabs.move(chromeId, { windowId: chromeWindowId, index: -1 });
    } catch (error) {
      if (source) sync(source);
      throw error;
    } finally {
      movingFrom.delete(from);
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
  /** Open tabs in another partition than their Space's. */
  const inWrongPartition = () =>
    [...live.keys()].filter((id) => store.state.tabs[id] && livePartition.has(id) && livePartition.get(id) !== partitionFor(id));
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
    const old: number[] = [];
    const hidden: string[] = [];
    for (const id of ids) {
      const chromeId = live.get(id);
      const windowId = store.windowShowing(id);
      if (chromeId === undefined) continue;
      if (!windowId) {
        hidden.push(id);
        continue;
      }
      for (const space of store.windowView(windowId).spaces) {
        if (space.split?.includes(id)) nativePairs.delete(space.split);
      }
      live.delete(id);
      await openChromeTab(id, id === store.activeTabIn(windowId)?.id, windowId);
      old.push(chromeId);
    }
    for (const chromeId of old) {
      ours.add(chromeId);
      void chrome.tabs.remove(chromeId).catch(() => ours.delete(chromeId));
    }
    await unload(hidden);
  }
  // The tabs that were open before the background (re)started.
  const partitionsKnown = Promise.all([...live].map(([id, chromeId]) => learnPartition(id, chromeId)));

  async function makePlaceholder(chromeWindowId: number) {
    creating++;
    try {
      placeholders.set(chromeWindowId, (await chrome.tabs.create({ windowId: chromeWindowId, active: true })).id!);
    } finally {
      creating--;
    }
  }

  /** Removes a failed setup's physical tab without closing its window or forgetting a newer tab. */
  async function removeFailedTab(id: string, chromeId: number) {
    if (tabSetups.get(id)?.transferred) return;
    if (live.get(id) === chromeId) {
      live.delete(id);
      livePartition.delete(id);
      rememberLive();
    }
    // Another owner may have claimed the physical tab while setup was pending.
    if (flechaIdFor(chromeId)) return;
    try {
      const tab = await chrome.tabs.get(chromeId).catch(() => undefined);
      if (!tab) return;
      const tabs = await chrome.tabs.query({ windowId: tab.windowId });
      if (tabs.length === 1 && !placeholders.has(tab.windowId)) await makePlaceholder(tab.windowId);
      if (tabSetups.get(id)?.transferred) return;
      ours.add(chromeId);
      await chrome.tabs.remove(chromeId).catch((error) => {
        ours.delete(chromeId);
        throw error;
      });
    } catch (error) {
      console.error('Flecha shell: removing a failed tab failed', error);
    }
  }

  /**
   * Closes the Chromium tabs of Flecha tabs that were closed or unloaded. Chromium closes a
   * window with its last tab, so when none would be left a blank placeholder takes its place
   * (Flecha shows its empty state over it), until a Flecha tab opens there again.
   */
  async function unload(ids: string[]) {
    if (!ids.length) return;
    const closing = ids.map((id) => live.get(id)).filter((c): c is number => c !== undefined);
    for (const id of ids) {
      live.delete(id);
      livePartition.delete(id);
    }
    rememberLive();
    if (!closing.length) return;
    const windows = new Set((await Promise.all(closing.map((c) => chrome.tabs.get(c).catch(() => undefined)))).map((t) => t?.windowId));
    for (const chromeWindowId of windows) {
      if (chromeWindowId === undefined) continue;
      const tabs = await chrome.tabs.query({ windowId: chromeWindowId });
      const left = tabs.filter((t) => !closing.includes(t.id!));
      if (!left.length && !placeholders.has(chromeWindowId)) await makePlaceholder(chromeWindowId);
      else if (tabs.some((t) => t.active && closing.includes(t.id!))) await showBeforeClosing(chromeWindowId, left);
    }
    await Promise.all(closing.map((chromeId) => {
      ours.add(chromeId);
      return chrome.tabs.remove(chromeId).catch(() => {
        ours.delete(chromeId);
      });
    }));
  }

  /**
   * Before a window's active Chromium tab closes, shows the window's own active tab if it is open
   * there, or else its placeholder until sync opens that tab. Closing the active tab would have
   * Chromium activate a neighbour, which Flecha would take as you picking it, even after you
   * picked another tab.
   */
  async function showBeforeClosing(chromeWindowId: number, left: chrome.tabs.Tab[]) {
    const windowId = windowOf(chromeWindowId);
    if (!windowId) return;
    const wanted = live.get(store.activeTabIn(windowId)?.id ?? '');
    if (wanted === undefined || !left.some((t) => t.id === wanted)) return showPlaceholder(chromeWindowId);
    ourActivations.add(wanted);
    await chrome.tabs.update(wanted, { active: true }).catch(() => ourActivations.delete(wanted));
  }

  async function showPlaceholder(chromeWindowId: number) {
    const placeholder = placeholders.get(chromeWindowId);
    if (placeholder === undefined) return makePlaceholder(chromeWindowId);
    ourActivations.add(placeholder);
    await chrome.tabs.update(placeholder, { active: true }).catch(() => {
      ourActivations.delete(placeholder);
      placeholders.delete(chromeWindowId);
    });
  }

  /** A window's placeholder goes once a real tab is showing there. */
  function dropPlaceholder(chromeWindowId: number) {
    const placeholder = placeholders.get(chromeWindowId);
    if (placeholder === undefined) return;
    placeholders.delete(chromeWindowId);
    ours.add(placeholder);
    void chrome.tabs.remove(placeholder).catch(() => undefined);
  }

  /** Shows each window's active Flecha tab, opening its Chromium tab or bringing it over if needed. */
  let syncing = Promise.resolve();
  let scheduled = false;
  let fullSync = false;
  const dirtyWindows = new Set<string>();
  function sync(windowId?: string) {
    if (startupUnsplits) return;
    if (windowId === undefined) fullSync = true;
    else dirtyWindows.add(windowId);
    if (scheduled) return;
    scheduled = true;
    syncing = syncing
      .then(async () => {
        scheduled = false;
        const full = fullSync;
        const windows = new Set(dirtyWindows);
        fullSync = false;
        dirtyWindows.clear();
        await partitionsKnown;
        if (full) {
          await unload([...live.keys()].filter((id) => !store.state.tabs[id]));
          await reopenInPartition(inWrongPartition());
        }
        for (const [chromeWindowId, id] of [...windowMap]) {
          if (full || windows.has(id)) await syncWindow(id, chromeWindowId, full);
        }
        // Tab sleep's rules run on their schedule; a tab now on screen wakes at once.
        void tabSleep?.shownChanged();
      })
      .catch((err) => console.error('Flecha shell: sync failed', err));
  }

  // Tab sleep, as Dia does it (tabSleep.ts). An incognito window's tabs are left alone. A tab a
  // coding agent is working in counts as on screen: it is in use, though in the background.
  const tabsInUse = () => {
    const agent = nativeHost?.agentTabsInUse() ?? new Set<number>();
    const ids = new Set(store.state.windows.flatMap((win) => store.visibleTabIds(win.id)));
    for (const [id, chromeId] of live) if (agent.has(chromeId)) ids.add(id);
    return ids;
  };
  const tabSleep = !incognito && tabSleepSupported() ? createTabSleep(store, live, tabsInUse) : undefined;

  async function syncWindow(windowId: string, chromeWindowId: number, full: boolean) {
    const active = store.activeTabIn(windowId);
    // A Space with nothing open shows Flecha's empty state (the new tab page in the placeholder),
    // not the page of the Space before.
    if (!active) {
      if (full) await syncSplits(windowId, chromeWindowId);
      return showPlaceholder(chromeWindowId);
    }
    // Both halves of a split are on screen, so both need a page, here.
    for (const id of store.visibleTabIds(windowId)) {
      await tabSetups.get(id)?.promise;
      const chromeId = live.get(id);
      if (chromeId === undefined) await openChromeTab(id, id === active.id, windowId);
      else await moveChromeTab(chromeId, chromeWindowId);
    }
    if (full || store.activeSpaceIn(windowId).split?.includes(active.id)) await syncSplits(windowId, chromeWindowId);
    const chromeId = live.get(active.id)!;
    const shown = await chrome.tabs.get(chromeId).catch(() => undefined);
    if (!shown?.active) {
      ourActivations.add(chromeId);
      await chrome.tabs.update(chromeId, { active: true }).catch(() => {
        ourActivations.delete(chromeId);
        return openChromeTab(active.id, true, windowId);
      });
    }
    dropPlaceholder(chromeWindowId);
    await refreshNav(windowId);
  }

  // ---- split view: the Store's splits as Chromium's own split view ---------------
  // Chromium shows both tabs of a split whenever either is active, which is how a Space's
  // split behaves in the Store too. Chromium places the halves by tab order.

  type NativeSplit = { id: number; left: number; right: number };
  /** The native group last confirmed for each Store pair. Teardown invalidates the confirmation. */
  const nativePairs = new WeakMap<[string, string], NativeSplit>();
  const creatingSplits = new Map<number, [number, number]>();

  function confirmSplit(pair: [string, string], id: number, left: number, right: number) {
    const previous = nativePairs.get(pair);
    if (previous?.id === id && previous.left === left && previous.right === right) return;
    nativePairs.set(pair, { id, left, right });
  }

  async function syncSplits(windowId: string, chromeWindowId: number) {
    const tabs = await chrome.tabs.query({ windowId: chromeWindowId });
    if (!store.hasWindow(windowId)) return;
    const wanted = new Map<string, { native: [number, number]; store: [string, string] }>();
    for (const space of store.windowView(windowId).spaces) {
      const pair = space.split?.map((id) => live.get(id));
      if (space.split && pair?.[0] !== undefined && pair[1] !== undefined) wanted.set(pair.join(','), { store: space.split, native: [pair[0], pair[1]] });
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
      const pair = wanted.get(key);
      if (pair) {
        have.add(key);
        confirmSplit(pair.store, splitId, ...pair.native);
      } else {
        for (const { native, store: pair } of wanted.values()) {
          if (native.some((id) => members.some((tab) => tab.id === id))) nativePairs.delete(pair);
        }
        await chrome.tabs.unsplit(splitId).catch(() => undefined);
      }
    }
    const here = new Set(tabs.map((t) => t.id));
    for (const [key, { native: [left, right], store: pair }] of wanted) {
      if (have.has(key) || !here.has(left) || !here.has(right)) continue;
      const stillWanted = () => store.hasWindow(windowId) && live.get(pair[0]) === left && live.get(pair[1]) === right &&
        store.windowView(windowId).spaces.some((space) => space.split === pair);
      const sameWindow = (...tabs: chrome.tabs.Tab[]) => tabs.every((tab) => tab.windowId === chromeWindowId);
      const currentTabs = () => Promise.all([chrome.tabs.get(left), chrome.tabs.get(right)]);
      const adjacent = ([first, second]: [chrome.tabs.Tab, chrome.tabs.Tab]) => second.index === first.index + 1;
      const position = async () => {
        if (!stillWanted()) return 'abandoned';
        try {
          const before = await currentTabs();
          if (!sameWindow(...before) || !stillWanted()) return 'abandoned';
          if (adjacent(before)) return 'ready';
          await chrome.tabs.move(left, { index: -1 });
          if (!stillWanted() || !sameWindow(await chrome.tabs.get(right)) || !stillWanted()) return 'abandoned';
          await chrome.tabs.move(right, { index: -1 });
          const after = await currentTabs();
          if (!sameWindow(...after)) return 'abandoned';
          return adjacent(after) ? 'ready' : 'retry';
        } catch (error) {
          console.warn('Flecha shell: could not position split tabs', error);
          return 'retry';
        }
      };
      let positioned = await position();
      // A native reorder can invalidate the first positioning pass. Re-read both tabs before retrying.
      if (positioned === 'retry') positioned = await position();
      if (positioned !== 'ready') continue;
      if (!stillWanted()) continue;
      creatingSplits.set(chromeWindowId, [left, right]);
      try {
        const splitId = await chrome.tabs.createSplit([left, right]);
        if (!stillWanted()) {
          await chrome.tabs.unsplit(splitId).catch(() => undefined);
          continue;
        }
        confirmSplit(pair, splitId, left, right);
        if (store.activeSpaceIn(windowId).splitMode === 'responsive') broadcastTo(chromeWindowId, 'split-layout');
      } catch (err) {
        console.warn('Flecha shell: split failed', err);
      } finally {
        creatingSplits.delete(chromeWindowId);
      }
    }
  }

  /** A split made or ended in Chromium itself (its split menu, the close button) goes to the Store. */
  async function splitChanged(chromeId: number, splitViewId: number, chromeWindowId: number, startup = false) {
    const id = flechaIdFor(chromeId);
    const windowId = windowOf(chromeWindowId);
    if (!id || !windowId) return;
    const pair = store.activeSpaceIn(windowId).split;
    const creating = creatingSplits.get(chromeWindowId);
    const confirmed = pair && nativePairs.get(pair);
    const restoredPair = startup && pair?.every((id) => live.has(id) && live.get(id) === restored?.[id]);
    const leftId = confirmed?.left ?? (restoredPair && pair ? live.get(pair[0]) : undefined);
    const rightId = confirmed?.right ?? (restoredPair && pair ? live.get(pair[1]) : undefined);
    // An old pane can report removal before its replacement exists in Chromium.
    if (splitViewId < 0 && (chromeId !== leftId && chromeId !== rightId)) return;
    const tabs = await chrome.tabs.query({ windowId: chromeWindowId }).catch(() => undefined);
    if (!tabs || !store.hasWindow(windowId) || store.activeSpaceIn(windowId).split !== pair) return;
    if (splitViewId < 0 && pair) {
      if (nativePairs.get(pair) !== confirmed) return;
      const left = tabs.find((tab) => tab.id === leftId);
      const right = tabs.find((tab) => tab.id === rightId);
      if (!left || !right) {
        nativePairs.delete(pair);
        sync(windowId);
        return;
      }
      if (left.splitViewId !== undefined && left.splitViewId >= 0 && left.splitViewId === right.splitViewId) return;
      exitSplit(windowId);
      return;
    }
    const nativeMembers = tabs
      .filter((t) => t.splitViewId === splitViewId)
      .sort((a, b) => a.index - b.index);
    const members = nativeMembers.map((t) => flechaIdFor(t.id!));
    const active = store.activeSpaceIn(windowId).activeTabId;
    if (members.length !== 2 || !members.every(Boolean) || !active || !members.includes(active)) return;
    if (pair && members.every((m) => pair.includes(m!))) {
      if (!nativePairs.has(pair) && members[0] === pair[0] && members[1] === pair[1]) {
        confirmSplit(pair, splitViewId, nativeMembers[0].id!, nativeMembers[1].id!);
      }
      return;
    }
    if (creating && nativeMembers.every((tab) => creating.includes(tab.id!))) return;
    if (pair && !nativePairs.has(pair)) return;
    const other = members.find((m) => m !== active)!;
    store.splitWith(other, members[0] === other ? 'left' : 'right', windowId, active);
    const adopted = store.activeSpaceIn(windowId).split;
    if (adopted && adopted[0] === members[0] && adopted[1] === members[1]) {
      confirmSplit(adopted, splitViewId, nativeMembers[0].id!, nativeMembers[1].id!);
    }
  }

  function exitSplit(windowId = here()) {
    const mirror = store.unsplit(windowId);
    if (mirror) {
      store.closeTab(mirror);
      void unload([mirror]);
    }
  }

  /** A tab dropped on the page: show it beside the page, on the side it was dropped. */
  function dropToSplit(tabId: string, side: 'left' | 'right', destination: Parameters<FlechaApi['dropToSplit']>[2]) {
    const windowId = here();
    const chromeWindowId = hereChrome();
    frameOf(chromeWindowId).tabDragging = false;
    sendFrame(chromeWindowId);
    const space = store.activeSpaceIn(windowId);
    if (destination?.spaceId !== space.id) return;
    const target = destination.tabId;
    if (destination.kind === 'page') {
      if (target !== pageSplitTarget(space, tabId)) return;
    } else if (destination.kind === 'row') {
      if (!space.today.includes(target) && !pinnedTabIds(space.pinned).includes(target)) return;
    } else return;
    if (!canDropToSplit(store.state.tabs, tabId, target)) return;
    const ids = store.allTabIds(space, windowId);
    if (!ids.includes(tabId) || !ids.includes(target)) return;
    store.splitWith(tabId, side, windowId, target);
  }

  async function refreshNav(windowId: string) {
    const active = store.activeTabIn(windowId);
    const chromeId = active && live.get(active.id);
    const zoom = chromeId === undefined ? 1 : await chrome.tabs.getZoom(chromeId).catch(() => 1);
    // Chromium doesn't tell extensions whether a tab can go back; the buttons stay enabled.
    const percent = Math.round(zoom * 100);
    if (store.activeTabIn(windowId)?.id !== active?.id || (navStates.get(windowId)?.zoom ?? 100) === percent) return;
    navStates.set(windowId, { canGoBack: true, canGoForward: true, zoom: percent });
    sendWindowSoon(windowId);
  }

  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  let fullStateDue = false;
  const dirtyTabs = new Set<string>();
  const dirtyLayouts = new Set<string>();
  const scheduleState = () => {
    stateTimer ??= setTimeout(() => {
      stateTimer = undefined;
      publish(fullStateDue ? undefined : dirtyTabs, dirtyLayouts);
      fullStateDue = false;
      dirtyTabs.clear();
      dirtyLayouts.clear();
    }, 16);
  };
  const sendTabSoon = (id: string) => {
    dirtyTabs.add(id);
    scheduleState();
  };
  const sendWindowSoon = (id: string) => {
    dirtyLayouts.add(id);
    scheduleState();
  };
  const sendStateSoon = () => {
    fullStateDue = true;
    scheduleState();
  };
  // Icons for tabs that haven't loaded their own yet.
  const wantFavicons = () => void favicons.want(Object.values(store.state.tabs).filter((t) => !t.favicon).map((t) => t.url));
  store.onChange((change, detail) => {
    // A page's own title, icon or loading state leaves the open tabs as they are.
    if (detail?.kind === 'activation') sync(detail.windowId);
    else if (change === 'structure' && !detail) {
      unmarkAgentTabs();
      sync();
    }
    if (detail?.kind === 'activation') {
      sendTabSoon(detail.tabId);
      sendWindowSoon(detail.windowId);
    } else if (detail?.kind === 'metadata') {
      sendTabSoon(detail.tabId);
      const tab = store.state.tabs[detail.tabId];
      if (!tab.favicon && (detail.keys.includes('url') || detail.keys.includes('favicon'))) void favicons.want([tab.url]);
    } else {
      sendStateSoon();
      if (!detail) wantFavicons();
    }
  });

  // ---- Chromium → Flecha ----------------------------------------------------

  async function onCreated(tab: chrome.tabs.Tab) {
    if (creating || flechaIdFor(tab.id!) || [...placeholders.values()].includes(tab.id!) || isShellPage(tab)) return;
    // A Flechinha's page isn't one of Flecha's tabs. Asked of the browser: a new Flechinha's
    // first tab arrives before openFlechinha() has told us its window.
    if (!(await isFlechaWindow(tab.windowId))) return;
    // The first tab of a window we're opening: its window is mapped once create() returns.
    await windowsCreated;
    const windowId = attachWindow(tab.windowId);
    // A new or reopened window's start page shows its active tab, or Flecha's empty state.
    if (isStartPage(tab)) {
      const active = store.activeTabIn(windowId);
      if (active && !live.has(active.id)) {
        // Marked even when blank: the agent's next page loads in this tab.
        void adoptChromeTab(active.id, tab.id!, active.url === 'about:blank' ? undefined : active.url)
          .catch((err) => console.error('Flecha shell: reopening a tab failed', err));
        return;
      }
      if (!active && !placeholders.has(tab.windowId)) return void placeholders.set(tab.windowId, tab.id!);
    }
    const opener = tab.openerTabId !== undefined ? flechaIdFor(tab.openerTabId) : undefined;
    const added = addTab(url(tab), { activate: tab.active, afterTabId: opener, windowId });
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
    if (info.audible !== undefined) patch.audible = info.audible;
    if (info.mutedInfo) patch.muted = info.mutedInfo.muted;
    store.updateTab(id, patch);
    const windowId = windowOf(tab.windowId);
    if (info.status === 'complete' && tab.active && windowId) void refreshNav(windowId);
    if (info.splitViewId !== undefined) void splitChanged(chromeId, info.splitViewId, tab.windowId);
  }

  function onActivated({ tabId, windowId: chromeWindowId }: { tabId: number; windowId: number }) {
    // Any tab switch (Control-Tab, a click, Flecha's own) closes the window's command bar, as in Arc.
    closePaletteIn(chromeWindowId);
    const ours = ourActivations.delete(tabId);
    const id = flechaIdFor(tabId);
    const windowId = windowOf(chromeWindowId);
    if (!id || !windowId || movingFrom.has(chromeWindowId)) return;
    if (!ours && store.activeSpaceIn(windowId).activeTabId !== id) store.activate(id, { windowId });
    const space = store.activeSpaceIn(windowId);
    if (space.splitMode === 'responsive' && space.split?.includes(id)) broadcastTo(chromeWindowId, 'split-layout');
  }

  function onRemoved(chromeId: number, info: { isWindowClosing: boolean }) {
    if (ours.delete(chromeId)) return;
    for (const [chromeWindowId, placeholder] of placeholders) if (placeholder === chromeId) placeholders.delete(chromeWindowId);
    const id = flechaIdFor(chromeId);
    if (!id) return;
    live.delete(id);
    livePartition.delete(id);
    rememberLive();
    // A closing window keeps its tabs: they go to the closed windows, to be reopened.
    if (!info.isWindowClosing) store.closeTab(id);
  }

  async function onWindowCreated(win: chrome.windows.Window) {
    if (creatingWindows || win.type !== 'normal' || !(await isFlechaWindow(win.id!))) return;
    attachWindow(win.id!);
    // A window Chromium opened (its own Ctrl+N) is saved at once, as newWindow's are.
    await store.saveNow();
  }

  async function onWindowRemoved(chromeWindowId: number) {
    const windowId = windowMap.get(chromeWindowId);
    placeholders.delete(chromeWindowId);
    frames.delete(chromeWindowId);
    if (!windowId) return;
    windowMap.delete(chromeWindowId);
    rememberWindows();
    // Another Chromium window still shows it.
    if (chromeWindowOf(windowId) !== undefined) return;
    // Quitting closes every window, and they all come back next time: none of them is closed
    // for good. A browser too far into shutting down to answer is quitting too. What the Store
    // has not saved yet (its debounce) is saved now, while it still can be. A window you closed
    // just before a quit began is closed for good: the browser answers for that window.
    if (typeof chrome.flechaPrivate?.isQuitting === 'function' && (await chrome.flechaPrivate.isQuitting(chromeWindowId).catch(() => true))) {
      return void (await store.saveNow());
    }
    store.closeWindow(windowId);
    // Saved now: closing the last window next quits the browser before the Store's debounce.
    await store.saveNow();
  }

  /** Window closes still being taken in (onWindowRemoved asks the browser first). */
  const windowsClosing = new Set<Promise<void>>();
  function takeWindowRemoval(chromeWindowId: number) {
    const done = onWindowRemoved(chromeWindowId).finally(() => windowsClosing.delete(done));
    windowsClosing.add(done);
    return done;
  }

  function onWindowFocused(chromeWindowId: number) {
    const windowId = windowOf(chromeWindowId);
    if (windowId && windowId !== store.focusedWindowId) store.focusWindow(windowId);
  }

  /** Reopens the most recently closed window, with its Today tabs. */
  async function reopenWindow() {
    const win = store.reopenWindow();
    // Saved now, as closing is: a quit right after must not lose the window to the Store's debounce.
    await store.saveNow();
    if (win) await chromeWindowFor(win.id);
    sync();
  }

  // ---- commands from Flecha pages -------------------------------------------

  const activeChromeId = (windowId = here()) => {
    const active = store.activeTabIn(windowId);
    return active ? live.get(active.id) : undefined;
  };
  const onActive = (fn: (chromeId: number) => unknown) => () => {
    const chromeId = activeChromeId();
    if (chromeId !== undefined) void fn(chromeId);
  };
  const openTab = (input: string, activate = true, windowId = here()) =>
    addTab(resolveInput(input, store.state.searchEngine), {
      activate,
      afterTabId: activate ? undefined : store.activeSpaceIn(windowId).activeTabId,
      windowId,
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
    const space = store.activeSpaceIn(here());
    const split: MenuEntry<MenuRun>[] = [];
    if (space.split?.includes(tabId)) split.push({ label: 'Exit Split View', run: does('exitSplit') });
    else if (space.activeTabId && space.activeTabId !== tabId) split.push({ label: 'Open in Split View', run: does('splitWith', tabId) });
    const name = tab.customTitle ?? tab.title;
    const otherSpaces = store.state.spaces.filter((s) => s.id !== store.locate(tabId)?.space?.id);
    // Pinned tabs and favorites keep the URL they go back to.
    const pinned = zone !== 'today' && !!tab.homeUrl;
    return [
      ...split,
      ...(split.length ? [SEPARATOR] : []),
      { label: 'Copy Link', run: { copy: tab.url, message: 'Link copied' } },
      { label: 'Copy as Markdown Link', run: { copy: `[${name}](${tab.url})`, message: 'Markdown link copied' } },
      { label: 'Rename…', run: { rename: tabId } },
      ...(pinned ? [{ label: 'Edit Pinned URL…', run: { editHomeUrl: tabId } }] : []),
      { label: 'Duplicate', run: does('newTab', tab.url) },
      // A Flechinha window of its own; the window code lives in another shell module.
      { label: 'Open in Flechinha', run: does('openFlechinha', tab.url, tabId) },
      SEPARATOR,
      // An incognito window has just its tabs: nothing to pin, no other Space.
      ...(incognito || tab.device === 'mobile'
        ? []
        : [
            { label: zone === 'today' ? 'Pin Tab' : 'Unpin Tab', run: does('togglePin', tabId) },
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
      ...(pinned && !sameAddress(tab.homeUrl!, tab.url)
        ? [
            { label: 'Go Back to Pinned URL', run: does('goHome', tabId) },
            ...(pinnableAddress(tab.url) ? [{ label: 'Set Pinned URL to Current Page', run: does('setHomeUrl', tabId, tab.url) }] : []),
          ]
        : []),
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
      { label: 'Open in New Window', run: does('newWindow', spaceId) },
      SEPARATOR,
      { label: 'Separate Cookies and Logins', checked: !!space.isolated, run: does('setSpaceIsolated', spaceId, !space.isolated) },
      ...(space.isolated && canIsolate ? [{ label: 'Clear Cookies and Site Data…', run: { clearSpaceData: spaceId } }] : []),
      SEPARATOR,
      { label: 'Delete Space…', enabled: store.state.spaces.length > 1, run: { deleteSpace: spaceId } },
    ];
  }

  /** Opens the sidebar's Space editor (name, emoji, colour), in that Space. */
  function editSpace(spaceId: string) {
    const windowId = here();
    if (store.activeSpaceIn(windowId).id !== spaceId) store.switchSpace(spaceId, windowId);
    broadcastTo(hereChrome(), 'edit-space', spaceId);
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

  /** Replaces the whole state with an imported (or restored) one, and fits the open windows to it. */
  function takeOverState(state: BrowserState): boolean {
    // The tab ids change, so every open Chromium tab is closed and reopens on demand.
    const open = [...live.keys()];
    if (!store.replaceState(state)) return false;
    // The imported windows are taken by the open Chromium windows, in order; the rest open. Open
    // Chromium windows beyond the imported ones get a new window each.
    const chromeWindows = [...windowMap.keys()];
    windowMap.clear();
    state.windows.forEach((win, i) => chromeWindows[i] !== undefined && windowMap.set(chromeWindows[i], win.id));
    for (const chromeId of chromeWindows.slice(state.windows.length)) attachWindow(chromeId);
    rememberWindows();
    for (const win of state.windows) if (chromeWindowOf(win.id) === undefined) void chromeWindowFor(win.id);
    void unload(open);
    return true;
  }

  /** Settings show the regular profile's state, so an incognito window opens them over there. */
  function showSettings(pane?: string) {
    if (!incognito) return openSettings(pane);
    if (typeof chrome.flechaPrivate?.runInRegularProfile === 'function') {
      void chrome.flechaPrivate.runInRegularProfile(pane ? `openSettings:${pane}` : 'settings');
    }
  }

  /** The History page as a tab in this window: the one already there, or a new one. Incognito keeps no history, so it opens in the regular profile. */
  function showHistory() {
    if (incognito) {
      if (typeof chrome.flechaPrivate?.runInRegularProfile === 'function') void chrome.flechaPrivate.runInRegularProfile('history');
      return;
    }
    const url = chrome.runtime.getURL('history.html');
    const windowId = here();
    const isHistory = (id: string) => !!store.state.tabs[id]?.url.startsWith(url);
    // The one in view, else one in another Space (going there): a pinned tab or Favorite, which
    // every window shares, or a Today tab of this window. Another window's Today tab is its own.
    const ours = (id: string) => {
      const at = store.locate(id);
      return !!at && (at.zone !== 'today' || at.windowId === windowId);
    };
    const open = store.visibleTabIds(windowId).find(isHistory) ?? Object.keys(store.state.tabs).find((id) => isHistory(id) && ours(id));
    if (open) store.activate(open, { windowId });
    else addTab(url, { activate: true, windowId });
  }

  /** Prints the active tab: with Chromium's print preview where the browser can (patch 0070), else from the page. */
  async function printPage() {
    const chromeId = activeChromeId();
    if (chromeId === undefined) return;
    if (typeof chrome.flechaPrivate?.print === 'function') return chrome.flechaPrivate.print(chromeId);
    await chrome.scripting.executeScript({ target: { tabId: chromeId }, func: () => print() });
  }

  /** Quits as the macOS app menu does (patch 0070); an older browser can't. */
  function quit() {
    if (typeof chrome.flechaPrivate?.quit === 'function') void chrome.flechaPrivate.quit();
  }

  /** A new Chromium window showing `spaceId` (or the current Space), with no Today tabs yet. */
  async function newWindow(spaceId?: string) {
    const win = store.openWindow(spaceId ?? store.activeSpaceIn(here()).id);
    store.focusWindow(win.id);
    // Saved now, as closing is (reopenWindow).
    await store.saveNow();
    await chromeWindowFor(win.id);
  }

  handle({
    ready: sendState,
    newTab: (input: string) => openTab(input),
    newWindow: spacesOnly((spaceId?: string) => newWindow(typeof spaceId === 'string' ? spaceId : undefined)),
    // The window menu's items (ui/app.ts) that Linux and Windows have no menu bar for.
    newIncognitoWindow: () => chrome.windows.create({ incognito: true }),
    openExtensions: () => openTab('chrome://extensions'),
    openAbout: () => openTab('chrome://settings/help'),
    openHelp: () => openTab(HELP_URL),
    print: printPage,
    quit,
    navigate: async (input: string) => {
      const id = store.activeTabIn(here())?.id;
      if (id) await tabSetups.get(id)?.promise;
      const chromeId = id ? live.get(id) : undefined;
      if (chromeId === undefined) return openTab(input);
      await chrome.tabs.update(chromeId, { url: resolveInput(input, store.state.searchEngine) });
    },
    activate: (id: string) => focusShown(store.activate(id, { windowId: here() })),
    close: (id: string) => {
      store.closeTab(id);
      void unload([id]);
    },
    back: onActive((id) => chrome.tabs.goBack(id).catch(() => undefined)),
    forward: onActive((id) => chrome.tabs.goForward(id).catch(() => undefined)),
    reload: onActive((id) => chrome.tabs.reload(id)),
    // At once: by default a script waits for the page to be idle, which a loading page isn't.
    stop: onActive((id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => window.stop(), injectImmediately: true }).catch(() => undefined)),
    switchSpace: (id: string) => store.switchSpace(id, here()),
    newSpace: spacesOnly(() => editSpace(store.newSpace(true, here()).id)),
    editSpace: spacesOnly((id: string) => editSpace(String(id))),
    newFolder: spacesOnly(() => store.newFolder(undefined, undefined, here())),
    tabMenu: (id: string) => tabMenu(String(id)),
    spaceMenu: (id: string) => spaceMenu(String(id)),
    setOverlay: (name: string, on: boolean) => {
      const chromeWindowId = hereChrome();
      const frame = frameOf(chromeWindowId);
      if (on) frame.overlays.add(String(name));
      else frame.overlays.delete(String(name));
      sendFrame(chromeWindowId);
    },
    'frame:reconnect': (overlays: unknown) => {
      const chromeWindowId = callerWindow();
      if (chromeWindowId === undefined || !windowOf(chromeWindowId) || !Array.isArray(overlays)) return;
      const frame = frameOf(chromeWindowId);
      frame.overlays = new Set(overlays.filter((name): name is string => typeof name === 'string'));
      sendFrame(chromeWindowId);
    },
    togglePin: spacesOnly((id: string) => store.togglePin(id, here())),
    toggleFavorite: spacesOnly((id: string) => store.toggleFavorite(id, here())),
    moveToSpace: spacesOnly((id: string, spaceId: string) => store.moveToSpace(id, spaceId)),
    reloadTab: (id: string) => {
      const chromeId = live.get(id);
      if (chromeId !== undefined) void chrome.tabs.reload(chromeId);
    },
    goHome: (id: string) => {
      const home = store.state.tabs[id]?.homeUrl;
      const chromeId = live.get(id);
      if (!home) return;
      // A home from older or imported state can be a page Chromium won't open for the shell (file:).
      const asking = hereChrome();
      const refused = () => broadcastTo(asking, 'flash', 'Flecha can’t open the pinned URL; edit it to a web address.');
      if (chromeId !== undefined) chrome.tabs.update(chromeId, { url: home }).catch(refused);
      // An unloaded tab opens its URL later, where a refusal would go unseen: only web and Chromium pages.
      else if (pinnableAddress(home) || /^(about|chrome):/i.test(home)) store.updateTab(id, { url: home });
      else refused();
    },
    // A tab showing its pinned page follows the new URL; one browsed away stays, and goes back to it.
    setHomeUrl: spacesOnly((id: string, input: string) => {
      const tab = store.state.tabs[id];
      if (!tab?.homeUrl || store.locate(id)?.zone === 'today') return;
      const url = pinnableAddress(input);
      if (!url) return broadcastTo(hereChrome(), 'flash', 'Enter a web address, like example.com.');
      if (sameAddress(url, tab.homeUrl)) return;
      const atHome = sameAddress(tab.url, tab.homeUrl);
      store.updateTab(id, { homeUrl: url, ...(atHome ? { url, history: undefined } : {}) });
      const chromeId = live.get(id);
      if (atHome && chromeId !== undefined) void chrome.tabs.update(chromeId, { url });
    }),
    closeTabs: (id: string, which: string) => void unload(store.closeTodayTabs(id, which === 'others' ? 'others' : 'below')),
    updateSpace: (id: string, patch: Parameters<Store['updateSpace']>[1]) => store.updateSpace(id, patch ?? {}),
    // Its open tabs reopen in the other partition (sync() finds them in the wrong one).
    setSpaceIsolated: spacesOnly((id: string, isolated: boolean) => {
      if (!canIsolate) return broadcastTo(hereChrome(), 'flash', 'Separate cookies aren’t in this build yet');
      store.setIsolated(String(id), !!isolated);
    }),
    // The spike's clearSpaceData(): signs out of everything in the Space, then reloads its pages.
    clearSpaceData: spacesOnly(async (id: string) => {
      const space = store.state.spaces.find((s) => s.id === id);
      if (!space?.isolated || !canIsolate) return;
      await chrome.flechaPrivate.clearPartition(space.id);
      for (const tabId of store.state.windows.flatMap((w) => store.allTabIds(space, w.id))) {
        const chromeId = live.get(tabId);
        if (chromeId !== undefined && livePartition.get(tabId) === space.id) void chrome.tabs.reload(chromeId);
      }
    }),
    deleteSpace: spacesOnly((id: string) => {
      if (store.state.spaces.length > 1) void unload(store.deleteSpace(id));
    }),
    moveSpace: spacesOnly((id: string, beforeId?: string) => store.moveSpace(String(id), typeof beforeId === 'string' ? beforeId : undefined)),
    // Restored tabs open on demand; sync() reopens any whose Space now has other cookies.
    // Incognito too: Clear Today Tabs and closing tabs there record undo steps.
    undo: () => {
      const label = store.undo();
      broadcastTo(hereChrome(), 'flash', label ? `Undid ${label}` : 'Nothing to undo');
    },
    toggleFolder: (id: string) => store.toggleFolder(id),
    renameFolder: (id: string, name: string) => store.renameFolder(id, name),
    moveTab: (id: string, target: DropTarget) => store.moveTab(id, target, here()),
    clearToday: () => void unload(store.clearToday(here())),
    renameTab: (id: string, title: string) => store.updateTab(id, { customTitle: String(title).trim() || undefined }),
    toggleMute: (id: string) => toggleMute(String(id)),
    flash: (message: string) => broadcastTo(hereChrome(), 'flash', String(message)),
    openPalette: (mode: string) => openPalette(mode),
    closePalette: (id?: string) => {
      const chromeWindowId = hereChrome();
      if (id !== undefined && frameOf(chromeWindowId).palette?.id !== id) return;
      closePaletteIn(chromeWindowId);
      if (hasFrame()) void chrome.flechaPrivate.focus('page', chromeWindowId);
    },
    toggleSidebar: () => {
      if (tourKey('toggleSidebar')) return;
      frameOf(hereChrome()).sidebarPeek = false;
      const windowId = here();
      store.setSidebarVisible(!store.sidebarVisibleIn(windowId), windowId);
    },
    setSidebarWidth: (width: number) => {
      if (!Number.isFinite(width)) return store.state.sidebarWidth;
      return store.setSidebarWidth(width);
    },
    'frame:resized': () => {
      const windowId = windowOf(callerWindow());
      if (windowId && store.activeSpaceIn(windowId).splitMode === 'responsive') frameResized(windowId);
    },
    setSidebarPeek: (peek: boolean) => {
      const frame = frameOf(hereChrome());
      if (store.sidebarVisibleIn(here()) || frame.sidebarPeek === !!peek) return;
      frame.sidebarPeek = !!peek;
      sendState();
    },
    setTabDragging: (dragging: boolean) => {
      const chromeWindowId = hereChrome();
      frameOf(chromeWindowId).tabDragging = !!dragging;
      sendFrame(chromeWindowId);
    },
    zoom: (step: number) => {
      const windowId = here();
      const chromeId = activeChromeId(windowId);
      if (chromeId === undefined) return;
      void chrome.tabs.getZoom(chromeId).then((zoom) => {
        const next = step === 0 ? 1 : Math.min(5, Math.max(0.25, zoom + (step > 0 ? 0.1 : -0.1)));
        return chrome.tabs.setZoom(chromeId, next).then(() => refreshNav(windowId));
      });
    },
    splitWith: (id: string) => store.splitWith(id, 'right', here()),
    exitSplit: () => exitSplit(),
    dropToSplit: (id: string, side: string, destination: Parameters<FlechaApi['dropToSplit']>[2]) =>
      dropToSplit(String(id), side === 'left' ? 'left' : 'right', destination),
    splitNew: (input: string) => {
      const windowId = here();
      store.splitWith(openTab(input, false, windowId).id, 'right', windowId);
    },
    openSettings: (pane?: string) => showSettings(typeof pane === 'string' ? pane : undefined),
    openHistory: () => showHistory(),
    finishOnboarding: () => {
      store.setOnboarded(true);
      // The user can close the window as soon as the tour ends. Commit before
      // answering, rather than leaving this transition in the Store's debounce.
      return store.saveNow();
    },
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
    importFlechaState: spacesOnly(async (json: string) => {
      const chromeWindowId = hereChrome();
      const state = decodeState(String(json));
      if (!state) return broadcastTo(chromeWindowId, 'flash', 'That isn’t a Flecha state file');
      // Yours is kept first, so restoreBeforeImport can bring it back.
      await setAsideBeforeImport(chrome.storage.local, store.serialize());
      if (!takeOverState(state)) return broadcastTo(chromeWindowId, 'flash', 'That isn’t a Flecha state file');
      broadcastTo(chromeWindowId, 'flash', `Imported ${state.spaces.length} Spaces and ${Object.keys(state.tabs).length} tabs`);
    }),
    restoreBeforeImport: spacesOnly(async () => {
      const chromeWindowId = hereChrome();
      const state = await stateBeforeImport(chrome.storage.local);
      if (!state || !takeOverState(state)) return broadcastTo(chromeWindowId, 'flash', 'There are no Spaces from before an import');
      broadcastTo(chromeWindowId, 'flash', `Restored ${state.spaces.length} Spaces and ${Object.keys(state.tabs).length} tabs`);
    }),
  });

  /** A tab shown in another window than the caller's (a Today tab of that window): that window comes forward. */
  function focusShown(windowId: string | undefined) {
    const chromeWindowId = windowId ? chromeWindowOf(windowId) : undefined;
    if (chromeWindowId !== undefined && chromeWindowId !== callerWindow() && windowId !== here()) void chrome.windows.update(chromeWindowId, { focused: true });
  }

  registerSiteControls({ store, activeChromeId: () => activeChromeId(), mainWindow: async () => hereChrome() ?? focusedChromeWindow() });

  // ---- commands by id, for keyboard shortcuts (the Electron spike's buildMenu) ----

  /** Copies through the window's frame page: the background has no document for the clipboard. */
  async function copyToClipboard(text: string, message: string) {
    broadcast('clipboard', hereChrome() ?? (await focusedChromeWindow()), { text, message });
  }

  /** ⌘1–⌘8 pick a tab by position (favorites, then pinned, then today); ⌘9 the last one. */
  function selectTabIndex(index: number) {
    const windowId = here();
    const ids = store.allTabIds(store.activeSpaceIn(windowId), windowId);
    const id = index < 0 ? ids[ids.length - 1] : ids[index];
    if (id) store.activate(id, { windowId });
  }

  /**
   * Control-Tab goes through the Space's tabs by when you last used them, like Arc's and an app
   * switcher; tabs opened in the background and not seen yet come last. The order is the one at
   * the first press: while Control is held each press moves
   * one further along it, and releasing Control (onShortcutReleased) makes the tab it stopped on
   * the most recent. A browser that doesn't report the release ends the run at every press, so
   * Control-Tab then switches between the two most recent tabs.
   */
  let recentRun: { windowId: string; ids: string[]; index: number } | undefined;
  const reportsRelease = typeof chrome.flechaPrivate?.onShortcutReleased?.addListener === 'function';
  function cycleRecent(step: 1 | -1) {
    const windowId = here();
    if (recentRun?.windowId !== windowId) {
      const space = store.activeSpaceIn(windowId);
      const ids = store.byRecency(store.allTabIds(space, windowId).filter((id) => id !== space.activeTabId));
      recentRun = { windowId, ids: space.activeTabId ? [space.activeTabId, ...ids] : ids, index: space.activeTabId ? 0 : -1 };
    }
    const { ids } = recentRun;
    if (!ids.length) return void (recentRun = undefined);
    recentRun.index = (recentRun.index + step + ids.length) % ids.length;
    store.activate(ids[recentRun.index], { recent: false, windowId });
    if (!reportsRelease) endRecentRun();
  }
  function endRecentRun() {
    const id = recentRun && recentRun.ids[recentRun.index];
    recentRun = undefined;
    if (id) store.touch(id);
  }

  function cycleSpace(step: 1 | -1) {
    const windowId = here();
    const spaces = store.state.spaces;
    const i = spaces.findIndex((sp) => sp.id === store.activeSpaceIn(windowId).id);
    store.switchSpace(spaces[(i + step + spaces.length) % spaces.length].id, windowId);
  }

  /** A command on the active tab, if there is one. */
  const withTab = (fn: (tab: NonNullable<Store['activeTab']>) => unknown) => () => {
    const tab = store.activeTabIn(here());
    if (tab) return fn(tab);
  };

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
    history: () => showHistory(),
    newFlechinha: () => call('newFlechinha'),
    closeTab: withTab((tab) => call('close', tab.id)),
    // The most recent of a closed tab and a closed window comes back.
    reopenTab: async () => {
      // A window closed just before counts, even while the shell is still taking its close in.
      await Promise.all(windowsClosing);
      const tabAt = store.state.archive[0]?.closedAt ?? -1;
      if ((store.lastClosedWindowAt() ?? -1) > tabAt) return reopenWindow();
      const item = store.popArchive();
      if (item) openTab(item.url);
    },
    nextTab: () => cycleRecent(1),
    previousTab: () => cycleRecent(-1),
    pinTab: spacesOnly(withTab((tab) => store.togglePin(tab.id, here()))),
    duplicateTab: withTab((tab) => openTab(tab.url)),
    muteTab: withTab((tab) => toggleMute(tab.id)),
    clearToday: () => call('clearToday'),
    copyLink: withTab((tab) => copyToClipboard(tab.url, 'Link copied')),
    copyMarkdown: withTab((tab) => copyToClipboard(`[${tab.customTitle ?? tab.title}](${tab.url})`, 'Markdown link copied')),
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
    viewSource: withTab((tab) => isWebPage(tab.url) && addTab(`view-source:${tab.url}`, { activate: true, windowId: here() })),
    shortcuts: () => showSettings('shortcuts'),
    quit: () => quit(),
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
      else if (store.state.spaces[i - 1]) store.switchSpace(store.state.spaces[i - 1].id, here());
      return true;
    }
    if (!Object.hasOwn(commands, id)) return false;
    void Promise.resolve(commands[id as keyof typeof commands]()).catch((err) => console.error(`Flecha shell: "${id}" failed`, err));
    return true;
  }
  handle({ run: (id: string, n?: number) => runCommand(String(id), n) });

  registerSettings({
    store,
    windowId: here,
    unload: (ids) => void unload(ids),
    broadcastState: sendState,
    liveTabs: live,
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
  });
  void refreshDefaultBrowser();

  // Boosts, environments, local servers, the responsive view, console errors and ad blocking.
  features = registerFeatures({ store, broadcastState: sendState, liveTabId: (id) => live.get(id), activeChromeTabId: () => activeChromeId(), windowId: here });

  // Imports and the coding-agent bridge, through Flecha's native messaging host. Both are
  // about your regular Spaces, so incognito windows have neither.
  if (!incognito) nativeHost = registerNativeHost({
    store,
    canIsolate,
    broadcastState: sendState,
    tabs: {
      open: (url) => addTab(resolveInput(url, store.state.searchEngine), { activate: false, agent: true }).id,
      chromeTab: async (id) => {
        await syncing;
        const pending = tabSetups.get(id);
        if (pending) return pending.promise;
        return live.get(id) ?? (store.state.tabs[id] ? openChromeTab(id, false, store.locate(id)?.windowId ?? store.focusedWindowId) : undefined);
      },
      liveId: (id) => live.get(id),
      activate: (id) => void store.activate(id),
      close: (id) => {
        store.closeTab(id);
        void unload([id]);
      },
    },
    agentTabsChanged: async () => void (await tabSleep?.shownChanged()),
  });

  onConnect((port, chromeWindowId) => {
    if (port.name === 'flecha-page' || port.name === 'flecha-settings') return;
    sendFrame(chromeWindowId, port);
    sendState();
    if (port.name === 'flecha-toolbar') return;
    const palette = frameOf(chromeWindowId).palette;
    if (palette) sendTo(port, 'palette', palette.mode, palette.id);
    else sendTo(port, 'palette-closed');
    if (chromeWindowId !== undefined) {
      currentPeek(chromeWindowId, (peek) => sendTo(port, 'peek', peek, chromeWindowId));
    }
    void siteIcons.all().then((icons) => sendTo(port, 'site-icons', icons));
  });

  /** A shortcut pressed in `windowId`, once it is known whether that window is a Flechinha. */
  const runShortcut = (command: string, windowId?: number) => {
    // In a Flechinha, its own toolbar answers the few shortcuts it has.
    if (isFlechinha(windowId)) return broadcast('flechinha:command', windowId, command);
    if (runInPeek(command, windowId)) return;
    // Settings on a pane, asked for by an incognito window (runInRegularProfile).
    const pane = /^openSettings:(\w+)$/.exec(command);
    if (pane) return void openSettings(pane[1]);
    // The Boosts page, asked for by an incognito window, which writes no boosts.
    if (command === 'boosts') return void call('openBoostsFolder');
    const numbered = /^select(Tab|Space):(\d)$/.exec(command);
    // The shortcut acts in the window it was pressed in.
    asWindow(windowId !== undefined && windowId >= 0 ? windowId : undefined, () => runCommand(numbered ? `${numbered[1].toLowerCase()}${numbered[2]}` : command));
  };

  // Flecha's keyboard shortcuts, taken by the browser before the page (patch 0016).
  registerNative({
    store,
    // Releasing the held keys ends a Control-Tab run, whichever shortcut the hold began with
    // (Control-L, then Tab, say).
    released: () => endRecentRun(),
    chromeTabId: (id) => live.get(id),
    flechaTabId: (chromeId) => flechaIdFor(chromeId),
    flechaWindowId: windowOf,
    run: (command, windowId) => {
      // A window that isn't one of Flecha's may be a Flechinha the browser opened (a link from
      // another app) that this background hasn't seen yet, so the browser is asked first.
      // Flecha's own windows go on at once, so a held ⌃Tab stays in step with its release.
      if (windowId !== undefined && windowId >= 0 && !windowMap.has(windowId) && !isFlechinha(windowId)) {
        return void isFlechinhaWindow(windowId).then(() => runShortcut(command, windowId));
      }
      runShortcut(command, windowId);
    },
    // Into a Flechinha: the page leaves its Space without closing.
    releaseTab: (id) => {
      const setup = tabSetups.get(id);
      if (setup) setup.transferred = true;
      // The page stays open in the Flechinha, as yours: other extensions run in it again.
      if (store.state.tabs[id]?.agent) unmarkAgentTab(id);
      live.delete(id);
      livePartition.delete(id);
      rememberLive();
      store.closeTab(id);
    },
    // Back from a Flechinha ("Open in Flecha"): an active Today tab in the current Space of the window it went to.
    adoptTab: (chromeId) => {
      void chrome.tabs.get(chromeId).then((tab) => {
        if (flechaIdFor(chromeId)) return;
        const id = addTab(url(tab), { activate: true, windowId: windowOf(tab.windowId) }).id;
        live.set(id, chromeId);
        rememberLive();
        void checkOpenedTab(id, chromeId);
      });
    },
  });
  // Windows of the last session that Chromium didn't open again come back, with their Today tabs.
  if (freshSession) for (const win of store.state.windows) if (chromeWindowOf(win.id) === undefined) await chromeWindowFor(win.id);
  // An unsplit can wake the worker. Apply it before reconciliation recreates a saved pair.
  for (const { tabId, windowId } of startupUnsplits ?? []) await splitChanged(tabId, -1, windowId, true);
  startupUnsplits = undefined;
  sync();
  wantFavicons();
  // Arc's auto-archive, hourly as in Electron. An alarm, since the background sleeps.
  // Made once: making it again on every wake would restart the hour.
  // (Incognito tabs are never archived: they go with their window.)
  if (!incognito) void chrome.alarms.get(ARCHIVE_ALARM).then((alarm) => void (alarm ?? chrome.alarms.create(ARCHIVE_ALARM, { periodInMinutes: 60 })));
  const archiveStale = () => void unload(store.archiveStale());
  // Tab sleep runs every sampling period too, made once like the archive's.
  if (tabSleep) void chrome.alarms.get(TAB_SLEEP_ALARM).then((alarm) => void (alarm ?? chrome.alarms.create(TAB_SLEEP_ALARM, { periodInMinutes: EVALUATE_EVERY / 60_000 })));
  // The shell started from this state: it is the copy to fall back to from now on.
  void regular?.started();

  return {
    onCreated,
    onUpdated,
    onActivated,
    onRemoved,
    onWindowCreated,
    onWindowRemoved: takeWindowRemoval,
    onWindowFocused: (chromeWindowId: number) => {
      onWindowFocused(chromeWindowId);
      void refreshDefaultBrowser();
    },
    openPalette: (mode: string, chromeWindowId?: number) => asWindow(chromeWindowId, () => openPalette(mode)),
    runCommand,
    archiveStale,
    tabSleep,
  };
}

const url = (tab: chrome.tabs.Tab) => tab.pendingUrl || tab.url || '';
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
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.splitViewId !== undefined && info.splitViewId < 0) startupUnsplits?.push({ tabId: id, windowId: tab.windowId });
  void ready.then((r) => r.onUpdated(id, info, tab));
});
chrome.tabs.onActivated.addListener((info) => void ready.then((r) => r.onActivated(info)));
chrome.tabs.onRemoved.addListener((id, info) => void ready.then((r) => r.onRemoved(id, info)));
chrome.windows.onCreated.addListener((win) => void ready.then((r) => r.onWindowCreated(win)));
chrome.windows.onRemoved.addListener((id) => void ready.then((r) => r.onWindowRemoved(id)));
chrome.windows.onFocusChanged.addListener((id) => id !== chrome.windows.WINDOW_ID_NONE && void ready.then((r) => r.onWindowFocused(id)));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ARCHIVE_ALARM) void ready.then((r) => r.archiveStale());
  if (alarm.name === TAB_SLEEP_ALARM) void ready.then((r) => r.tabSleep?.evaluate());
});
chrome.idle.onStateChanged.addListener(() => void ready.then((r) => r.tabSleep?.idleChanged()));

// Until the native patch opens it on its own, the toolbar button opens the sidebar.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ⌘L: the browser sends this instead of focusing its hidden address bar (patch 0009).
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'flecha-open-location') void ready.then((r) => r.openPalette('navigate', tab?.windowId));
});
