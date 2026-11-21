/**
 * window.flecha for the Chromium build: the same API the Electron preload gives the sidebar,
 * over the shell's port. Imported before the sidebar code so it is there when that runs.
 */
import type { FlechaApi, PaletteMode, UiState } from '../shared/types';
import { spaceTint } from './lib/spaceTint';
import { SIDEBAR_DEFAULT_WIDTH, clampSidebarWidth } from '../shared/sidebarWidth';
import { cmd, invoke, on, onReconnect } from './client';
import { ConnectionError } from './protocol';
import { applyStateUpdate, type StateUpdate } from './stateUpdates';
import { toast } from './settingsUi';
import { confirmDeleteSpace, copy, hasWindowOverlay, setupWindowUi, showMenu } from './windowUi';
import { incognito } from './incognito';
import { fetchSuggestions, suggestable } from './lib/suggest';
import { chooseFlechaState } from './lib/flechaImport';

const surface = document.documentElement.dataset.surface;
const systemDark = matchMedia('(prefers-color-scheme: dark)');
/** Flecha's own browser draws the window frame from window.html; stock Chromium has the side panel. */
const framed = typeof chrome.flechaPrivate?.setFrame === 'function';
const windowFrame = surface === 'window' && framed;
if (framed) document.documentElement.dataset.frame = '';
// An incognito window's pages: one Space of tabs, always dark (shell.css, incognito.ts).
if (incognito) document.documentElement.dataset.incognito = '';

/**
 * The background sends the Space's light colour; dark mode darkens it here. Pages follow
 * Chromium's appearance (the system's), not Flecha's theme setting, until a native patch
 * applies that setting to Chromium; the tint follows the same thing so text stays readable.
 */
const stateListeners: Array<(state: UiState) => void> = [];
let lastState: UiState | undefined;
function emitState(state: UiState) {
  if (state.sidebarMode === 'docked') sidebarPeek = false;
  lastState = state;
  const shown = { ...state, tint: spaceTint(state.tint, systemDark.matches), faviconUrls: siteIcons };
  for (const cb of stateListeners) cb(shown);
  applyFrame();
}
on('state', (state: UiState) => {
  if (widthNeedsSnapshot) {
    widthNeedsSnapshot = false;
    resizing = undefined;
  }
  emitState(state);
});
on('state-update', (update: StateUpdate) => {
  if (lastState) emitState(applyStateUpdate(lastState, update));
});

/** Icons the background fetched from the sites themselves, by host; they arrive once each. */
let siteIcons: Record<string, string> = {};
on('site-icons', (icons: Record<string, string>) => {
  if (!Object.entries(icons).some(([host, url]) => siteIcons[host] !== url)) return;
  siteIcons = { ...siteIcons, ...icons };
  if (lastState) emitState(lastState);
});

// The frame page lays its window out: the background says how, this page adds the colour.
let frameState: { sidebar: chrome.flechaPrivate.SidebarMode; overlay: boolean; sidebarInPageFullscreen: boolean } | undefined;
/** The width the sidebar is being dragged to, until the saved state has it. */
let resizing: number | undefined;
let resizeRevision = 0;
let widthNeedsSnapshot = false;
let sidebarPeek = false;
const measure = typeof chrome.flechaPrivate?.setSplitRatio === 'function' ? () => void invoke('frame:resized').catch(() => undefined) : undefined;
let measuredLayout: string | undefined;
if (windowFrame && measure) {
  // The frame's viewport changes after Chromium lays out the sidebar and panes.
  window.addEventListener('resize', measure);
  // A new native split reports membership before the panes have both resized.
  on('split-layout', () => requestAnimationFrame(measure));
}
let windowId: Promise<number> | undefined;
function getWindowId() {
  return windowId ??= chrome.flechaPrivate.getWindowId().catch(error => {
    windowId = undefined;
    throw error;
  });
}
let appliedFrame: { background: string; sidebarWidth: number; sidebar: chrome.flechaPrivate.SidebarMode; overlay: boolean } | undefined;
let appliedFullscreen: { value: boolean } | undefined;
function applyFrame() {
  if (!windowFrame || !frameState || !lastState) return;
  const background = spaceTint(lastState.tint, systemDark.matches);
  const sidebarWidth = resizing ?? lastState.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
  const { sidebarInPageFullscreen, sidebar } = frameState;
  const overlay = frameState.overlay || hasWindowOverlay() || document.getElementById('split-drop')?.hidden === false;
  const layout = `${sidebar}:${sidebarWidth}:${sidebarInPageFullscreen}`;
  const requests: Promise<unknown>[] = [];
  if (appliedFrame?.sidebarWidth !== sidebarWidth) document.documentElement.style.setProperty('--sidebar', `${sidebarWidth}px`);
  if (!appliedFrame || appliedFrame.background !== background || appliedFrame.sidebarWidth !== sidebarWidth ||
      appliedFrame.sidebar !== sidebar || appliedFrame.overlay !== overlay) {
    const next = appliedFrame = { sidebar, overlay, background, sidebarWidth };
    requests.push(getWindowId().then(id => chrome.flechaPrivate.setFrame(next, id)).catch((error: unknown) => {
      if (appliedFrame === next) appliedFrame = undefined;
      throw error;
    }));
  }
  // Patch 0072; older browsers lay out fullscreen according to the sidebar's mode.
  if (appliedFullscreen?.value !== sidebarInPageFullscreen && typeof chrome.flechaPrivate.setSidebarInPageFullscreen === 'function') {
    const next = appliedFullscreen = { value: sidebarInPageFullscreen };
    requests.push(getWindowId().then(id => chrome.flechaPrivate.setSidebarInPageFullscreen(next.value, id)).catch((error: unknown) => {
      if (appliedFullscreen === next) appliedFullscreen = undefined;
      throw error;
    }));
  }
  if (!requests.length) return;
  void Promise.allSettled(requests).then((results) => {
    if (!measure || (!incognito && chrome.flechaPrivate.onSplitAreaResized) || measuredLayout === layout) return;
    if (!results.some(result => result.status === 'fulfilled')) return;
    if (results.every(result => result.status === 'fulfilled')) measuredLayout = layout;
    // Older builds invalidate native layout without reporting the new pane bounds.
    requestAnimationFrame(() => requestAnimationFrame(measure));
  });
}
on('frame', (state) => {
  frameState = state;
  applyFrame();
});

const paletteListeners: Array<(mode: PaletteMode) => void> = [];
const closePaletteListeners: Array<() => void> = [];
let paletteId: string | undefined;
let dismissedPalette: string | undefined;
on('palette', (mode: PaletteMode, id: string) => {
  if (id === paletteId || id === dismissedPalette) return;
  paletteId = id;
  for (const listen of paletteListeners) listen(mode);
});
function hideWorkerPalette() {
  paletteId = undefined;
  for (const listen of closePaletteListeners) listen();
}
on('close-palette', hideWorkerPalette);
on('palette-closed', () => { if (paletteId !== undefined) hideWorkerPalette(); });
onReconnect(() => {
  if (!windowFrame) return;
  if (dismissedPalette) cmd('closePalette')(dismissedPalette);
  cmd('setSidebarPeek')(sidebarPeek);
});
const renameListeners: Array<(tabId: string) => void> = [];
const editHomeUrlListeners: Array<(tabId: string) => void> = [];
setupWindowUi({
  rename: (tabId) => renameListeners.forEach((cb) => cb(tabId)),
  editHomeUrl: (tabId) => editHomeUrlListeners.forEach((cb) => cb(tabId)),
  state: () => lastState,
});
systemDark.addEventListener('change', () => lastState && emitState(lastState));

const api: FlechaApi = {
  onState: (cb) => void stateListeners.push(cb),
  // The command bar lives in the sidebar; new tab pages have their own search.
  onPalette: (cb) => {
    if (surface !== 'panel' && surface !== 'window') return;
    paletteListeners.push(cb);
  },
  onClosePalette: (cb) => {
    if (surface === 'panel' || surface === 'window') closePaletteListeners.push(cb);
  },
  onEditSpace: (cb) => on('edit-space', cb),
  onRenameTab: (cb) => {
    renameListeners.push(cb);
    on('rename-tab', cb);
  },
  onEditHomeUrl: (cb) => void editHomeUrlListeners.push(cb),
  onPeek: (cb) => on('peek', cb),
  onDownloads: (cb) => on('downloads', cb),
  onTourKey: (cb) => on('tour-key', cb),
  onFlash: (cb) => on('flash', cb),
  ready: cmd('ready'),
  searchHistory: (query) => invoke('searchHistory', query),
  // Asked from this page, so a newer query can abort the request. Chromium's omnibox sends none
  // in incognito, nor while Settings > "Autocomplete searches and URLs" (search.suggest_enabled) is off.
  searchSuggestions: async (query, signal) => {
    if (incognito || !suggestable(query)) return [];
    if (!(await chrome.privacy.services.searchSuggestEnabled.get({})).value) return [];
    return fetchSuggestions(lastState?.searchEngine, query, signal);
  },
  topSites: () => invoke('topSites'),
  // Extensions can't read other apps' icons; the onboarding falls back to the name.
  appIcon: async () => undefined,
  detectBrowsers: () => invoke('detectBrowsers'),
  previewImport: (id) => invoke('previewImport', id),
  importBrowser: (id, options) => invoke('importBrowser', id, options),
  // On the new tab page, what you type opens in this tab.
  newTab: surface === 'newtab' ? cmd('navigate') : cmd('newTab'),
  navigate: cmd('navigate'),
  activate: cmd('activate'),
  close: cmd('close'),
  back: cmd('back'),
  forward: cmd('forward'),
  reload: cmd('reload'),
  stop: cmd('stop'),
  switchSpace: cmd('switchSpace'),
  newSpace: cmd('newSpace'),
  updateSpace: cmd('updateSpace'),
  setSpaceIsolated: cmd('setSpaceIsolated'),
  // Electron asks first, in a message box; the page asks in its own dialog.
  deleteSpace: (id) => void confirmDeleteSpace(id),
  moveSpace: cmd('moveSpace'),
  undo: cmd('undo'),
  // Electron pops native menus; the page draws them, from items the background builds.
  tabMenu: (id) => void showMenu('tabMenu', id),
  spaceMenu: (id) => void showMenu('spaceMenu', id),
  toggleFolder: cmd('toggleFolder'),
  renameFolder: cmd('renameFolder'),
  moveTab: cmd('moveTab'),
  clearToday: cmd('clearToday'),
  // Brings over Flecha's own Electron state (~/Library/Application Support/Flecha/flecha-state.json).
  importMenu: async () => {
    const json = await chooseFlechaState({
      readNative: () => invoke<string | undefined>('nativeHost:flechaState').catch(() => undefined),
      pickFile: () =>
        new Promise((resolve) => {
          const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
          input.onchange = () => resolve(input.files?.[0]?.text());
          input.oncancel = () => resolve(undefined);
          input.click();
        }),
      confirm: (message) => confirm(message),
    });
    if (json) cmd('importFlechaState')(json);
  },
  restoreBeforeImport: () => {
    if (confirm('Replace your Spaces and tabs with those you had before your last import?')) cmd('restoreBeforeImport')();
  },
  // The frame grows over the page first, as in Electron; the side panel just opens it.
  openPalette: surface === 'window' ? cmd('openPalette') : (mode) => {
    paletteId = undefined;
    paletteListeners.forEach((cb) => cb(mode));
  },
  closePalette: () => {
    if (surface !== 'window') {
      paletteId = undefined;
      return;
    }
    dismissedPalette = paletteId;
    cmd('closePalette')(paletteId);
  },
  toggleSidebar: cmd('toggleSidebar'),
  resizeSidebar: (width, done) => {
    const revision = ++resizeRevision;
    widthNeedsSnapshot = false;
    resizing = clampSidebarWidth(width);
    applyFrame();
    if (!done) return;
    void invoke<number>('setSidebarWidth', resizing).then((saved) => {
      if (revision === resizeRevision && lastState && Number.isFinite(saved)) {
        lastState = { ...lastState, sidebarWidth: saved };
      }
    }, (error: unknown) => {
      if (revision !== resizeRevision) return;
      if (error instanceof ConnectionError && error.sent) widthNeedsSnapshot = true;
      else toast('Couldn’t save the sidebar width. Try again.');
    }).finally(() => {
      if (revision !== resizeRevision || widthNeedsSnapshot) return;
      resizing = undefined;
      applyFrame();
    });
  },
  setSidebarPeek: (peek) => {
    sidebarPeek = peek;
    cmd('setSidebarPeek')(peek);
  },
  // The page can write the clipboard itself; the background has no document to do it from.
  copyText: (text, message) => void copy(String(text), typeof message === 'string' ? message : 'Link copied'),
  renameTab: cmd('renameTab'),
  setHomeUrl: cmd('setHomeUrl'),
  toggleMute: cmd('toggleMute'),
  capturePage: cmd('capturePage'),
  clearSiteData: cmd('clearSiteData'),
  setSitePermission: cmd('setSitePermission'),
  setSiteAdBlock: cmd('setSiteAdBlock'),
  zoom: cmd('zoom'),
  openDevTools: cmd('openDevTools'),
  openSettings: cmd('openSettings'),
  openHistory: cmd('openHistory'),
  toggleResponsive: cmd('toggleResponsive'),
  showConsole: cmd('showConsole'),
  editBoost: cmd('editBoost'),
  openBoostsFolder: cmd('openBoostsFolder'),
  splitWith: cmd('splitWith'),
  setTabDragging: cmd('setTabDragging'),
  dropToSplit: cmd('dropToSplit'),
  splitNew: cmd('splitNew'),
  closePeek: cmd('closePeek'),
  // Chromium opens a download only in answer to a click, which a message to the background loses.
  openDownload: (id) => {
    if (typeof chrome.downloads?.open !== 'function') return cmd('openDownload')(id);
    void chrome.downloads.search({ id: Number(id) }).then(([item]) => {
      if (item?.state === 'complete') return chrome.downloads.open(item.id);
    });
  },
  revealDownload: cmd('revealDownload'),
  cancelDownload: cmd('cancelDownload'),
  keepDownload: cmd('keepDownload'),
  discardDownload: cmd('discardDownload'),
  resumeDownload: cmd('resumeDownload'),
  retryDownload: cmd('retryDownload'),
  clearDownloads: cmd('clearDownloads'),
  promotePeek: cmd('promotePeek'),
  finishOnboarding: cmd('finishOnboarding'),
  setPreferences: cmd('setPreferences'),
  makeDefaultBrowser: cmd('makeDefaultBrowser'),
  newFlechinha: cmd('newFlechinha'),
  newWindow: cmd('newWindow'),
  newIncognitoWindow: cmd('newIncognitoWindow'),
  openExtensions: cmd('openExtensions'),
  openAbout: cmd('openAbout'),
  openHelp: cmd('openHelp'),
  print: cmd('print'),
  quit: cmd('quit'),
  runCommand: cmd('run'),
};

window.flecha = api;
