/**
 * The shell's background: Flecha's Store, kept in step with real Chromium tabs.
 *
 * The Store is the source of truth, as in Electron. A Flecha tab only gets a Chromium tab
 * once it is opened (like Electron only made a view for it then), so a sidebar of a hundred
 * pinned tabs costs nothing until you use them. Chromium tabs that pages open themselves
 * (links to a new tab, window.open) become Flecha tabs.
 */
import { Store, type StatePersistence } from '../../src/main/store';
import { resolveInput, searchEngine } from '../../src/main/url';
import { shortcutHints } from '../../src/main/shortcuts';
import { describe as describeEnvironment } from '../../src/main/environments';
import type { BrowserState, DropTarget, SearchEngineId, UiState } from '../../src/shared/types';
import { broadcast, handle, listen, onConnect } from './hub';
import { openSettings, registerSettings } from './settingsHandlers';
import { registerFeatures, type Features } from './features';

const STATE_KEY = 'state';
/** Flecha tab id ↔ Chromium tab id, for the tabs that are open. Kept across background restarts. */
const LIVE_KEY = 'live';

const live = new Map<string, number>();
const flechaIdFor = (chromeId: number) => [...live].find(([, c]) => c === chromeId)?.[0];
/** Chromium tabs we're closing ourselves, so their events aren't taken as the user's. */
const ours = new Set<number>();
/** Tabs we're creating right now: Chromium may announce them before create() returns their id. */
let creating = 0;
/** A blank tab that keeps the window open while Flecha has no tab open in it. */
let placeholder: number | undefined;

async function start() {
  const saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] as string | undefined;
  const persistence: StatePersistence = {
    load: () => (saved ? (JSON.parse(saved) as BrowserState) : undefined),
    save: (json) => void chrome.storage.local.set({ [STATE_KEY]: json }),
  };
  const store = new Store(persistence);
  let features: Features | undefined;
  const restored = (await chrome.storage.session.get(LIVE_KEY))[LIVE_KEY] as Record<string, number> | undefined;
  const existing = new Set((await chrome.tabs.query({})).map((t) => t.id));
  for (const [id, chromeId] of Object.entries(restored ?? {})) if (existing.has(chromeId) && store.state.tabs[id]) live.set(id, chromeId);
  if (!restored) store.archiveStale();
  // Tabs Chromium opened before we were running: its start page shows the active Flecha tab
  // (closing it would close the window), anything else becomes a Flecha tab.
  for (const tab of await chrome.tabs.query({})) {
    if ([...live.values()].includes(tab.id!) || isShellPage(tab)) continue;
    const active = store.activeTab;
    if (isStartPage(tab) && active && !live.has(active.id)) {
      live.set(active.id, tab.id!);
      // A blank tab reloads the new tab page: Chromium drew its own before the shell was loaded.
      void chrome.tabs.update(tab.id!, { url: active.url === 'about:blank' ? 'chrome://newtab/' : active.url, active: true });
    } else if (isStartPage(tab) && !active) {
      placeholder = tab.id;
      void chrome.tabs.update(tab.id!, { url: 'chrome://newtab/' });
    } else if (isStartPage(tab)) {
      ours.add(tab.id!);
      void chrome.tabs.remove(tab.id!);
    } else live.set(addTab(url(tab), { activate: tab.active }).id, tab.id!);
  }

  /** A Flecha tab for an address; the new tab page and empty addresses make a blank "New Tab". */
  function addTab(address: string, opts: Parameters<Store['addTab']>[1]) {
    const blank = !address || address === 'about:blank' || isStartPage({ url: address } as chrome.tabs.Tab);
    const tab = store.addTab(blank ? 'about:blank' : address, opts);
    if (blank) store.updateTab(tab.id, { title: 'New Tab' });
    return tab;
  }

  const rememberLive = () => void chrome.storage.session.set({ [LIVE_KEY]: Object.fromEntries(live) });

  function uiState(): UiState {
    const tabs = Object.fromEntries(Object.entries(store.state.tabs).map(([id, { history, ...tab }]) => [id, tab]));
    return {
      ...store.state,
      tabs,
      searchEngineName: searchEngine(store.state.searchEngine).name,
      // The light tint; pages darken it themselves, since only they know the system appearance.
      tint: store.activeSpace.color,
      sidebarMode: store.state.sidebarVisible ? 'docked' : frame.sidebarPeek ? 'floating' : 'hidden',
      environment: store.activeTab ? describeEnvironment(store.activeTab.url, store.state.environments) : undefined,
      localServers: features?.localServers() ?? [],
      consoleErrors: features?.consoleErrors() ?? {},
      boostedHosts: features?.boostedHosts() ?? [],
      faviconHosts: [],
      shortcuts: shortcutHints(store.state),
      defaultBrowser: { isDefault: false, canSet: false },
      agent: undefined,
      nav: navState,
    };
  }

  let navState: UiState['nav'] = { canGoBack: false, canGoForward: false, zoom: 100 };
  const sendState = () => {
    broadcast('state', uiState());
    sendFrame();
  };

  // ---- the window frame, as the Electron spike's Browser.layout() --------------
  // The frame page applies it (chrome.flechaPrivate.setFrame), since only a page knows
  // whether the system is in dark mode for the background colour.
  const frame = { paletteOpen: false, sidebarPeek: false, tabDragging: false };
  function sendFrame() {
    const sidebar: chrome.flechaPrivate.SidebarMode = store.state.sidebarVisible ? 'docked' : frame.sidebarPeek ? 'floating' : 'hidden';
    // The frame covers the whole window while it draws over the page.
    const overlay = frame.paletteOpen || frame.tabDragging || !store.state.onboarded;
    broadcast('frame', { sidebar, overlay });
  }
  const hasFrame = () => typeof chrome.flechaPrivate?.setFrame === 'function';
  function openPalette(mode: string) {
    frame.paletteOpen = true;
    sendFrame();
    broadcast('palette', mode);
    if (hasFrame()) void chrome.flechaPrivate.focus('frame');
  }

  /** The window Flecha's tabs live in: the last focused normal window. */
  async function mainWindow() {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
    return win?.id ?? (await chrome.windows.create({ focused: true }))!.id!;
  }

  async function openChromeTab(id: string, active: boolean) {
    const tab = store.state.tabs[id];
    creating++;
    try {
      const created = await chrome.tabs.create({ windowId: await mainWindow(), url: tab.url === 'about:blank' ? undefined : tab.url, active });
      live.set(id, created.id!);
      rememberLive();
      return created.id!;
    } finally {
      creating--;
    }
  }

  /**
   * Closes the Chromium tabs of Flecha tabs that were closed or unloaded. Chromium closes a
   * window with its last tab, so when none would be left a blank placeholder takes its place
   * (Flecha shows its empty state over it), until a Flecha tab opens again.
   */
  async function unload(ids: string[]) {
    const closing = ids.map((id) => live.get(id)).filter((c): c is number => c !== undefined);
    for (const id of ids) live.delete(id);
    rememberLive();
    if (!closing.length) return;
    const left = (await chrome.tabs.query({ windowId: await mainWindow() })).filter((t) => !closing.includes(t.id!));
    if (!left.length && placeholder === undefined) {
      creating++;
      try {
        placeholder = (await chrome.tabs.create({ windowId: await mainWindow(), active: true })).id;
      } finally {
        creating--;
      }
    }
    for (const chromeId of closing) {
      ours.add(chromeId);
      void chrome.tabs.remove(chromeId).catch(() => ours.delete(chromeId));
    }
  }

  /** The placeholder goes once a real tab is showing. */
  function dropPlaceholder() {
    if (placeholder === undefined) return;
    ours.add(placeholder);
    void chrome.tabs.remove(placeholder).catch(() => undefined);
    placeholder = undefined;
  }

  /** Shows the active Flecha tab, opening its Chromium tab if it has none yet. */
  let syncing = Promise.resolve();
  function sync() {
    syncing = syncing.then(async () => {
      await unload([...live.keys()].filter((id) => !store.state.tabs[id]));
      const active = store.activeTab;
      if (!active) return;
      const chromeId = live.get(active.id);
      if (chromeId === undefined) await openChromeTab(active.id, true);
      else await chrome.tabs.update(chromeId, { active: true }).catch(() => openChromeTab(active.id, true));
      dropPlaceholder();
      await refreshNav();
    });
  }

  async function refreshNav() {
    const chromeId = store.activeTab && live.get(store.activeTab.id);
    const zoom = chromeId === undefined ? 1 : await chrome.tabs.getZoom(chromeId).catch(() => 1);
    // Chromium doesn't tell extensions whether a tab can go back; the buttons stay enabled.
    navState = { canGoBack: true, canGoForward: true, zoom: Math.round(zoom * 100) };
  }

  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  store.onChange(() => {
    sync();
    clearTimeout(stateTimer);
    stateTimer = setTimeout(sendState, 16);
  });

  // ---- Chromium → Flecha ----------------------------------------------------

  function onCreated(tab: chrome.tabs.Tab) {
    if (creating || flechaIdFor(tab.id!) || tab.id === placeholder || isShellPage(tab)) return;
    const opener = tab.openerTabId !== undefined ? flechaIdFor(tab.openerTabId) : undefined;
    const added = addTab(url(tab), { activate: tab.active, afterTabId: opener });
    live.set(added.id, tab.id!);
    rememberLive();
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
    if (info.status === 'complete' && tab.active) void refreshNav().then(sendState);
  }

  function onActivated({ tabId }: { tabId: number }) {
    const id = flechaIdFor(tabId);
    if (id && store.activeSpace.activeTabId !== id) store.activate(id);
  }

  function onRemoved(chromeId: number) {
    if (ours.delete(chromeId)) return;
    if (chromeId === placeholder) placeholder = undefined;
    const id = flechaIdFor(chromeId);
    if (!id) return;
    live.delete(id);
    rememberLive();
    store.closeTab(id);
  }

  // ---- commands from Flecha pages -------------------------------------------

  const activeChromeId = () => (store.activeTab ? live.get(store.activeTab.id) : undefined);
  const onActive = (fn: (chromeId: number) => unknown) => () => {
    const chromeId = activeChromeId();
    if (chromeId !== undefined) void fn(chromeId);
  };
  const openTab = (input: string, activate = true) =>
    addTab(resolveInput(input, store.state.searchEngine), {
      activate,
      afterTabId: activate ? undefined : store.activeSpace.activeTabId,
    });

  handle({
    ready: sendState,
    newTab: (input: string) => openTab(input),
    navigate: (input: string) => {
      const chromeId = activeChromeId();
      if (chromeId === undefined) return openTab(input);
      void chrome.tabs.update(chromeId, { url: resolveInput(input, store.state.searchEngine) });
    },
    activate: (id: string) => store.activate(id),
    close: (id: string) => {
      store.closeTab(id);
      void unload([id]);
    },
    back: onActive((id) => chrome.tabs.goBack(id).catch(() => undefined)),
    forward: onActive((id) => chrome.tabs.goForward(id).catch(() => undefined)),
    reload: onActive((id) => chrome.tabs.reload(id)),
    switchSpace: (id: string) => store.switchSpace(id),
    newSpace: () => {
      const space = store.newSpace();
      broadcast('edit-space', space.id);
    },
    updateSpace: (id: string, patch: { name?: string; emoji?: string; color?: string }) => store.updateSpace(id, patch ?? {}),
    // Spaces with their own cookies need a separate Chromium profile; not in this build yet.
    setSpaceIsolated: () => broadcast('flash', 'Separate cookies aren’t in this build yet'),
    deleteSpace: (id: string) => {
      if (store.state.spaces.length > 1) void unload(store.deleteSpace(id));
    },
    toggleFolder: (id: string) => store.toggleFolder(id),
    renameFolder: (id: string, name: string) => store.renameFolder(id, name),
    moveTab: (id: string, target: DropTarget) => store.moveTab(id, target),
    clearToday: () => void unload(store.clearToday()),
    renameTab: (id: string, title: string) => store.updateTab(id, { customTitle: String(title).trim() || undefined }),
    toggleMute: (id: string) => {
      const chromeId = live.get(id);
      if (chromeId !== undefined) void chrome.tabs.update(chromeId, { muted: !store.state.tabs[id]?.muted });
    },
    flash: (message: string) => broadcast('flash', String(message)),
    openPalette: (mode: string) => openPalette(mode),
    closePalette: () => {
      frame.paletteOpen = false;
      sendFrame();
      if (hasFrame()) void chrome.flechaPrivate.focus('page');
    },
    toggleSidebar: () => {
      frame.sidebarPeek = false;
      store.setSidebarVisible(!store.state.sidebarVisible);
    },
    setSidebarPeek: (peek: boolean) => {
      if (store.state.sidebarVisible || frame.sidebarPeek === !!peek) return;
      frame.sidebarPeek = !!peek;
      sendState();
    },
    setTabDragging: (dragging: boolean) => {
      frame.tabDragging = !!dragging;
      sendFrame();
    },
    zoom: (step: number) => {
      const chromeId = activeChromeId();
      if (chromeId === undefined) return;
      void chrome.tabs.getZoom(chromeId).then((zoom) => {
        const next = step === 0 ? 1 : Math.min(5, Math.max(0.25, zoom + (step > 0 ? 0.1 : -0.1)));
        return chrome.tabs.setZoom(chromeId, next).then(() => refreshNav().then(sendState));
      });
    },
    splitWith: (id: string) => store.splitWith(id),
    splitNew: (input: string) => store.splitWith(openTab(input, false).id),
    openSettings: (pane?: string) => openSettings(typeof pane === 'string' ? pane : undefined),
    finishOnboarding: () => store.setOnboarded(true),
    setPreferences: (prefs: { theme?: string; searchEngine?: string }) => {
      if (prefs?.theme === 'system' || prefs?.theme === 'light' || prefs?.theme === 'dark') store.setPreferences({ theme: prefs.theme });
      if (prefs?.searchEngine) store.setSearchEngine(prefs.searchEngine as SearchEngineId);
    },
    searchHistory: async (query: string) =>
      (await chrome.history.search({ text: String(query), maxResults: 50, startTime: 0 })).filter((h) => isWebPage(h.url)).map((h) => ({
        url: h.url ?? '',
        title: h.title || h.url || '',
        visits: h.visitCount ?? 0,
        lastVisit: h.lastVisitTime ?? 0,
      })),
    topSites: async () =>
      (await chrome.topSites.get())
        .filter((s) => isWebPage(s.url))
        .map((s) => ({ url: s.url, title: s.title || s.url, visits: 0, lastVisit: 0 })),
    detectBrowsers: () => [],
    importFlechaState: (json: string) => {
      let state: BrowserState | undefined;
      try {
        state = JSON.parse(String(json)) as BrowserState;
      } catch {
        // Reported below.
      }
      // The tab ids change, so every open Chromium tab is closed and reopens on demand.
      const open = [...live.keys()];
      if (!state || !store.replaceState(state)) return broadcast('flash', 'That isn’t a Flecha state file');
      void unload(open);
      const tabs = Object.keys(state.tabs).length;
      broadcast('flash', `Imported ${state.spaces.length} Spaces and ${tabs} tabs`);
    },
  });

  registerSettings({
    store,
    unload: (ids) => void unload(ids),
    broadcastState: sendState,
    isOpen: (id) => live.has(id),
    load: (id, url) => {
      const chromeId = live.get(id);
      if (chromeId !== undefined) void chrome.tabs.update(chromeId, { url });
    },
  });

  features = registerFeatures({ store, broadcastState: sendState, liveTabId: (id) => live.get(id), activeChromeTabId: activeChromeId });

  onConnect(() => sendState());
  sync();
  return { onCreated, onUpdated, onActivated, onRemoved, openPalette };
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
chrome.tabs.onCreated.addListener((tab) => void ready.then((r) => r.onCreated(tab)));
chrome.tabs.onUpdated.addListener((id, info, tab) => void ready.then((r) => r.onUpdated(id, info, tab)));
chrome.tabs.onActivated.addListener((info) => void ready.then((r) => r.onActivated(info)));
chrome.tabs.onRemoved.addListener((id) => void ready.then((r) => r.onRemoved(id)));

// Until the native patch opens it on its own, the toolbar button opens the sidebar.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ⌘L: the browser sends this instead of focusing its hidden address bar (patch 0009).
chrome.commands.onCommand.addListener((command) => {
  if (command === 'flecha-open-location') void ready.then((r) => r.openPalette('navigate'));
});
