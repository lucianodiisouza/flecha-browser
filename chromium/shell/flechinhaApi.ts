/**
 * window.flechinha for the Chromium build: the Electron Flechinha toolbar's API, run on the
 * window's own page through chrome.tabs. The toolbar is this window's frame page
 * (window.html?kind=flechinha, sent on to flechinha.html); see native.ts for the window.
 */
import type { FlechinhaApi, FlechinhaState, UiState } from '../shared/types';
import { resolveInput } from './lib/url';
import { spaceTint } from './lib/spaceTint';
import { tabHistory, type TabHistory } from './lib/tabHistory';
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

let pageHistory: TabHistory = { canGoBack: false, canGoForward: false };
let historyAsked = 0;

function emit() {
  // Not before the page is known: an empty first state would open the address for editing.
  if (!ui || !tab) return;
  const space = ui.spaces.find((s) => s.id === ui!.activeSpaceId) ?? ui.spaces[0];
  const url = tab?.pendingUrl || tab?.url || '';
  const state: FlechinhaState = {
    url: isBlank(url) ? '' : url,
    title: isBlank(url) ? '' : tab?.title || url,
    favicon: tab?.favIconUrl,
    canGoBack: !isBlank(url) && pageHistory.canGoBack,
    canGoForward: !isBlank(url) && pageHistory.canGoForward,
    loading: tab?.status === 'loading',
    tint: spaceTint(ui.tint, systemDark.matches),
    space: { name: space.name, emoji: space.emoji },
    searchEngineName: ui.searchEngineName,
  };
  for (const cb of stateListeners) cb(state);
}

/** Asks the page where it is in its history; the last ask is the one that counts. */
async function refreshHistory() {
  const asked = ++historyAsked;
  if (tab?.id === undefined) return;
  const answer = await tabHistory(tab.id);
  if (asked !== historyAsked) return;
  pageHistory = answer;
  emit();
}

async function refresh() {
  [tab] = await chrome.tabs.query({ windowId: await windowId, active: true });
  emit();
  void refreshHistory();
}

on('state', (state: UiState) => {
  ui = state;
  emit();
});
systemDark.addEventListener('change', emit);
chrome.tabs.onUpdated.addListener(async (_id, info, updated) => {
  if (updated.windowId === (await windowId) && updated.active) {
    tab = updated;
    emit();
    if (info.status === 'complete' || info.url) void refreshHistory();
  }
});
chrome.tabs.onActivated.addListener(async (info) => info.windowId === (await windowId) && void refresh());

const flash = (message: string) => flashListeners.forEach((cb) => cb(message));

/** Runs fn on the window's page, if it has one. */
const onPage = (fn: (tabId: number) => unknown) => async () => {
  if (!tab) await refresh();
  if (tab?.id !== undefined) await fn(tab.id);
};

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
    if (url && !isBlank(url)) void navigator.clipboard.writeText(url).then(() => flash('Link copied'));
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
