/**
 * `window.settings` for the Settings page in the Chromium shell: the same SettingsApi that
 * Electron's settings preload exposes, over the hub instead of ipcRenderer. It has to run
 * before ui/settings.ts, which reads `window.settings` as it loads.
 */
import type { RecordedKey, SettingsApi, SettingsView, TabsMenuAction, TabsView } from '../shared/types';
import type { AskOptions, TabsMenuItem } from './lib/tabManager';
import { cmd, invoke, on } from './client';
import type { NotYet } from './settingsHandlers';
import { askDialog, popupMenu, toast } from './settingsUi';
import { IS_MAC } from './lib/shortcuts';

/** A stub in the background says what isn't ported; the page shows it rather than doing nothing. */
function tellNotYet<T>(result: T): T {
  const note = (result as Partial<NotYet> | undefined)?.notYet;
  if (note) toast(note);
  return result;
}

// ---- recording shortcuts: Electron catches keys in before-input-event; here the page does ----

let recording = false;
const keyListeners: Array<(key: RecordedKey) => void> = [];
const findListeners: Array<() => void> = [];

// Capture on window, so neither the page's own handlers nor its defaults see a key being recorded.
// TODO(chromium): keys Chromium keeps for itself (⌘T, ⌘W, ⌘N, ⌘Q…) never reach a page; recording
// those needs a browser-side hook (a patch, or chrome.commands once Flecha's shortcuts move there).
window.addEventListener(
  'keydown',
  (e) => {
    if (recording) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const key: RecordedKey = { code: e.code, key: e.key, shift: e.shiftKey, control: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
      for (const fn of keyListeners) fn(key);
      return;
    }
    // ⌘F (Ctrl+F on Linux): Electron's Find menu item sends this to Settings; here the page catches it itself.
    if (e.code === 'KeyF' && (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      for (const fn of findListeners) fn();
    }
  },
  true,
);
window.addEventListener('blur', () => setRecording(false));

/** Recording also pauses Flecha's browser-wide shortcuts, so those keys reach this page. */
function setRecording(on: boolean) {
  if (recording === on) return;
  recording = on;
  cmd('settings:recording')(on);
}

// The background (Flecha's ⌘F, say) can ask for the search field too.
on('settings:find', () => {
  for (const fn of findListeners) fn();
});

// "Delete …?" questions from the tab manager, answered with the button's index.
on('settings:ask', async (id: number, options: AskOptions) => {
  cmd('settings:answer')(id, await askDialog(options));
});

const api: SettingsApi = {
  get: () => invoke<SettingsView>('settings:get'),
  set: (patch) => invoke<SettingsView>('settings:set', patch),
  chooseDownloadsFolder: () => invoke<SettingsView>('settings:choose-downloads-folder').then(tellNotYet),
  makeDefaultBrowser: () => invoke<SettingsView>('settings:make-default-browser').then(tellNotYet),
  newAgentToken: () => invoke<SettingsView>('settings:new-agent-token'),
  // Extension pages may write the clipboard themselves (the clipboardWrite permission).
  copy: (text) => navigator.clipboard.writeText(String(text)),
  openBoosts: () => invoke('settings:open-boosts').then(tellNotYet).then(() => undefined),
  showTour: () => invoke('settings:show-tour').then(tellNotYet).then(() => undefined),
  onPane: (cb) => {
    on('settings:pane', cb);
    window.addEventListener('hashchange', () => location.hash.length > 1 && cb(location.hash.slice(1)));
  },
  onFind: (cb) => void findListeners.push(cb),
  recordShortcut: async (on) => setRecording(!!on),
  onKey: (cb) => void keyListeners.push(cb),
  tabs: () => invoke<TabsView>('settings:tabs'),
  editTabs: (edit) => invoke('settings:edit-tabs', edit),
  // Electron pops up a native menu; an extension page draws its own, then the background runs the pick.
  tabsMenu: async (request) => {
    const items = await invoke<TabsMenuItem[]>('settings:tabs-menu', request);
    if (!items?.length) return undefined;
    const picked = await popupMenu(items);
    return picked ? invoke<TabsMenuAction | undefined>('settings:tabs-menu-run', picked.run) : undefined;
  },
  onTabs: (cb) => on('settings:tabs', cb),
  showTab: (tabId) => invoke('settings:show-tab', tabId).then(() => undefined),
  showEmojiPanel: () => invoke('settings:emoji-panel').then(tellNotYet).then(() => undefined),
};

window.settings = api;
