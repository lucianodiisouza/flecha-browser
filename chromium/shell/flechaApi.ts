/**
 * window.flecha for the Chromium build: the same API the Electron preload gives the sidebar,
 * over the shell's port. Imported before the sidebar code so it is there when that runs.
 */
import type { FlechaApi, PaletteMode, UiState } from '../shared/types';
import { spaceTint } from './lib/spaceTint';
import { cmd, invoke, on } from './client';
import { confirmDeleteSpace, copy, setupWindowUi, showMenu } from './windowUi';
import { incognito } from './incognito';

const surface = document.documentElement.dataset.surface;
const systemDark = matchMedia('(prefers-color-scheme: dark)');
/** Flecha's own browser draws the window frame from window.html; stock Chromium has the side panel. */
const framed = typeof chrome.flechaPrivate?.setFrame === 'function';
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
  lastState = state;
  const shown = { ...state, tint: spaceTint(state.tint, systemDark.matches), faviconUrls: siteIcons };
  for (const cb of stateListeners) cb(shown);
  applyFrame();
}
on('state', emitState);

/** Icons the background fetched from the sites themselves, by host; they arrive once each. */
const siteIcons: Record<string, string> = {};
on('site-icons', (icons: Record<string, string>) => {
  Object.assign(siteIcons, icons);
  if (lastState) emitState(lastState);
});

// The frame page lays its window out: the background says how, this page adds the colour.
let frameState: { sidebar: chrome.flechaPrivate.SidebarMode; overlay: boolean } | undefined;
const windowId = surface === 'window' && framed ? chrome.flechaPrivate.getWindowId() : undefined;
function applyFrame() {
  if (!windowId || !frameState || !lastState) return;
  const background = spaceTint(lastState.tint, systemDark.matches);
  void windowId.then((id) => chrome.flechaPrivate.setFrame({ ...frameState!, background }, id));
}
on('frame', (state) => {
  frameState = state;
  applyFrame();
});

const paletteListeners: Array<(mode: PaletteMode) => void> = [];
const renameListeners: Array<(tabId: string) => void> = [];
setupWindowUi({ rename: (tabId) => renameListeners.forEach((cb) => cb(tabId)), state: () => lastState });
systemDark.addEventListener('change', () => lastState && emitState(lastState));

const api: FlechaApi = {
  onState: (cb) => void stateListeners.push(cb),
  // The command bar lives in the sidebar; new tab pages have their own search.
  onPalette: (cb) => {
    if (surface !== 'panel' && surface !== 'window') return;
    paletteListeners.push(cb);
    on('palette', cb);
  },
  onEditSpace: (cb) => on('edit-space', cb),
  onRenameTab: (cb) => {
    renameListeners.push(cb);
    on('rename-tab', cb);
  },
  onPeek: (cb) => on('peek', cb),
  onDownloads: (cb) => on('downloads', cb),
  onTourKey: (cb) => on('tour-key', cb),
  onFlash: (cb) => on('flash', cb),
  ready: cmd('ready'),
  searchHistory: (query) => invoke('searchHistory', query),
  topSites: () => invoke('topSites'),
  // Extensions can't read other apps' icons; the onboarding falls back to the name.
  appIcon: async () => undefined,
  detectBrowsers: () => invoke('detectBrowsers'),
  importBrowser: (id) => invoke('importBrowser', id),
  importBrowserCookies: (id) => invoke('importBrowserCookies', id),
  // On the new tab page, what you type opens in this tab.
  newTab: surface === 'newtab' ? cmd('navigate') : cmd('newTab'),
  navigate: cmd('navigate'),
  activate: cmd('activate'),
  close: cmd('close'),
  back: cmd('back'),
  forward: cmd('forward'),
  reload: cmd('reload'),
  switchSpace: cmd('switchSpace'),
  newSpace: cmd('newSpace'),
  updateSpace: cmd('updateSpace'),
  setSpaceIsolated: cmd('setSpaceIsolated'),
  // Electron asks first, in a message box; the page asks in its own dialog.
  deleteSpace: (id) => void confirmDeleteSpace(id),
  // Electron pops native menus; the page draws them, from items the background builds.
  tabMenu: (id) => void showMenu('tabMenu', id),
  spaceMenu: (id) => void showMenu('spaceMenu', id),
  toggleFolder: cmd('toggleFolder'),
  renameFolder: cmd('renameFolder'),
  moveTab: cmd('moveTab'),
  clearToday: cmd('clearToday'),
  // Brings over Flecha's own Electron state (~/Library/Application Support/Flecha/flecha-state.json).
  importMenu: async () => {
    // Flecha's native host reads it straight from disk; the file picker is for when it isn't installed.
    const json = await invoke<string | undefined>('nativeHost:flechaState').catch(() => undefined);
    if (json) {
      if (confirm('Replace your Spaces and tabs with those of Flecha (Electron)?')) cmd('importFlechaState')(json);
      return;
    }
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) cmd('importFlechaState')(await file.text());
    };
    input.click();
  },
  // The frame grows over the page first, as in Electron; the side panel just opens it.
  openPalette: surface === 'window' ? cmd('openPalette') : (mode) => paletteListeners.forEach((cb) => cb(mode)),
  closePalette: surface === 'window' ? cmd('closePalette') : () => undefined,
  toggleSidebar: cmd('toggleSidebar'),
  setSidebarPeek: cmd('setSidebarPeek'),
  // The page can write the clipboard itself; the background has no document to do it from.
  copyText: (text, message) => void copy(String(text), typeof message === 'string' ? message : 'Link copied'),
  renameTab: cmd('renameTab'),
  toggleMute: cmd('toggleMute'),
  capturePage: cmd('capturePage'),
  clearSiteData: cmd('clearSiteData'),
  setSitePermission: cmd('setSitePermission'),
  zoom: cmd('zoom'),
  openDevTools: cmd('openDevTools'),
  openSettings: cmd('openSettings'),
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
  clearDownloads: cmd('clearDownloads'),
  promotePeek: cmd('promotePeek'),
  finishOnboarding: cmd('finishOnboarding'),
  setPreferences: cmd('setPreferences'),
  makeDefaultBrowser: cmd('makeDefaultBrowser'),
  newFlechinha: cmd('newFlechinha'),
};

window.flecha = api;
