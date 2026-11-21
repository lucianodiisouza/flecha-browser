/**
 * window.flechinha for the Chromium build: the Electron Flechinha toolbar's API, run on the
 * window's own page through chrome.tabs. The toolbar is this window's frame page
 * (window.html?kind=flechinha, sent on to flechinha.html); see native.ts for the window.
 */
import type { FlechinhaApi, FlechinhaState, UiState } from '../shared/types';
import { resolveInput } from './lib/url';
import { spaceTint } from './lib/spaceTint';
import { cmd, on } from './client';

const windowId = chrome.flechaPrivate.getWindowId();
const systemDark = matchMedia('(prefers-color-scheme: dark)');

let ui: UiState | undefined;
let tab: chrome.tabs.Tab | undefined;
const stateListeners: Array<(state: FlechinhaState) => void> = [];
const flashListeners: Array<(message: string) => void> = [];
const editListeners: Array<() => void> = [];

/** The new tab page shows as an empty Flechinha, as in Electron. */
const isBlank = (url = '') => !url || /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(url) || url === 'about:blank';

function emit() {
  // Not before the page is known: an empty first state would open the address for editing.
  if (!ui || !tab) return;
  const space = ui.spaces.find((s) => s.id === ui!.activeSpaceId) ?? ui.spaces[0];
  const url = tab?.pendingUrl || tab?.url || '';
  const state: FlechinhaState = {
    url: isBlank(url) ? '' : url,
    title: isBlank(url) ? '' : tab?.title || url,
    favicon: tab?.favIconUrl,
    // Chromium doesn't tell extensions whether a tab can go back, so the buttons stay on.
    canGoBack: !isBlank(url),
    canGoForward: !isBlank(url),
    loading: tab?.status === 'loading',
    tint: spaceTint(ui.tint, systemDark.matches),
    space: { name: space.name, emoji: space.emoji },
    searchEngineName: ui.searchEngineName,
  };
  for (const cb of stateListeners) cb(state);
}

async function refresh() {
  [tab] = await chrome.tabs.query({ windowId: await windowId, active: true });
  emit();
}

on('state', (state: UiState) => {
  ui = state;
  emit();
});
systemDark.addEventListener('change', emit);
chrome.tabs.onUpdated.addListener(async (_id, _info, updated) => {
  if (updated.windowId === (await windowId) && updated.active) {
    tab = updated;
    emit();
  }
});
chrome.tabs.onActivated.addListener(async (info) => info.windowId === (await windowId) && void refresh());

const flash = (message: string) => flashListeners.forEach((cb) => cb(message));

/** Runs fn on the window's page, if it has one. */
const onPage = (fn: (tabId: number) => unknown) => async () => {
  if (!tab) await refresh();
  if (tab?.id !== undefined) await fn(tab.id);
};

/**
 * Writes the clipboard. ⇧⌘C leaves the page focused, not the toolbar, and the clipboard only
 * takes writes from the focused document, so the toolbar borrows focus for it (as windowUi does).
 */
async function writeClipboard(text: string) {
  if (document.hasFocus()) return navigator.clipboard.writeText(text);
  const id = await windowId;
  await chrome.flechaPrivate.focus('frame', id);
  try {
    await navigator.clipboard.writeText(text);
  } finally {
    await chrome.flechaPrivate.focus('page', id);
  }
}

const api: FlechinhaApi = {
  onState: (cb) => void stateListeners.push(cb),
  onEditAddress: (cb) => void editListeners.push(cb),
  onFlash: (cb) => void flashListeners.push(cb),
  ready: () => {
    cmd('ready')();
    void refresh();
  },
  back: onPage((id) => chrome.tabs.goBack(id).catch(() => undefined)),
  forward: onPage((id) => chrome.tabs.goForward(id).catch(() => undefined)),
  reload: onPage((id) => chrome.tabs.reload(id)),
  stop: onPage((id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => window.stop() }).catch(() => undefined)),
  navigate: (input) => void onPage((id) => chrome.tabs.update(id, { url: resolveInput(input, ui?.searchEngine) }))(),
  copyLink: () => {
    const url = tab?.url;
    if (url && !isBlank(url))
      void writeClipboard(url).then(
        () => flash('Link copied'),
        (err) => console.error('Flecha shell: copying failed', err),
      );
  },
  openInFlecha: () => void windowId.then((id) => cmd('flechinha:openInFlecha')(id)),
  close: () => void windowId.then((id) => chrome.windows.remove(id)),
};

// The few shortcuts a Flechinha answers itself; the background sends them to its window.
on('flechinha:command', async (target: number, command: string) => {
  if (target !== (await windowId)) return;
  if (command === 'openInFlecha') api.openInFlecha();
  else if (command === 'openLocation') editListeners.forEach((cb) => cb());
  else if (command === 'copyLink') api.copyLink();
  else if (command === 'closeTab') api.close();
  else if (command === 'reload') api.reload();
  else if (command === 'back') api.back();
  else if (command === 'forward') api.forward();
});

window.flechinha = api;
