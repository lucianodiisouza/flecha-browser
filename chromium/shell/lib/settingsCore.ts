/**
 * What Settings shows and how it changes the Store, without Node, as the Electron
 * version's Settings window had them, for the Chromium shell's background.
 */
import type { SettingsPatch, SettingsView } from '../../shared/types';
import type { Store } from '../../shared/store';
import { SEARCH_ENGINES } from './url';
import { sanitize as sanitizeEnvironments } from './environments';
import { SHORTCUTS, SPACE_MODIFIER, displayKeys, isShortcutId, keysFor, sameKeys, shortcutList } from './shortcuts';

/** A modifier and a key, or a function key alone: "Alt+Cmd+K", "F5". */
const ACCELERATOR = /^((Ctrl|Alt|Shift|Cmd)\+){1,4}[^+]+$|^F\d{1,2}$/;

/** What the view needs from the browser it runs in. */
export interface SettingsEnvironment {
  /** For display only, with the home folder shortened to ~. */
  downloadsFolder: string;
  defaultBrowser: SettingsView['defaultBrowser'];
  agentEndpoint?: string;
}

/** What a change does outside the Store; each browser does these its own way. */
export interface SettingsEffects {
  theme(theme: NonNullable<SettingsView['theme']>): void;
  agent(enabled: boolean): Promise<void>;
  adBlock(enabled: boolean): Promise<void>;
}

export function settingsView(store: Store, env: SettingsEnvironment): SettingsView {
  const s = store.state;
  return {
    adBlock: s.adBlock !== false,
    searchEngine: s.searchEngine ?? 'google',
    downloadsFolder: env.downloadsFolder,
    askWhereToSave: !!s.askWhereToSave,
    defaultBrowser: env.defaultBrowser,
    theme: s.theme ?? 'system',
    archiveAfterHours: s.archiveAfterHours ?? 12,
    peekPinnedLinks: s.peekPinnedLinks !== false,
    shortcuts: shortcutList(s),
    openLinksInFlechinha: s.openLinksInFlechinha !== false,
    agent: {
      enabled: !!s.agent?.enabled,
      endpoint: env.agentEndpoint,
      token: s.agent?.enabled ? s.agent.token : undefined,
    },
    environments: (s.environments ?? []).map((e) => ({
      id: e.id,
      name: e.name,
      targetsText: e.targets.map((t) => `${t.label} ${t.origin}`).join('\n'),
    })),
    searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id: id as keyof typeof SEARCH_ENGINES, name: e.name })),
  };
}

/** Records one shortcut. A command that had the same keys loses them, and the notice says so. */
export function setShortcut(store: Store, id: string, keys: string | null): string | undefined {
  if (!isShortcutId(id)) return undefined;
  if (keys === 'default') {
    store.setKeybinding(id, undefined);
    return undefined;
  }
  if (keys !== null && !ACCELERATOR.test(keys)) return undefined;
  // ⌘1…⌘9 and ⌃1…⌃9 (Ctrl and Alt on Linux) pick tabs and Spaces.
  if (keys && new RegExp(`^(Cmd|Ctrl|${SPACE_MODIFIER})\\+\\d$`).test(keys)) return `${displayKeys(keys)} already goes to a tab or Space.`;
  let notice: string | undefined;
  if (keys) {
    for (const other of SHORTCUTS) {
      const otherKeys = keysFor(store.state, other.id);
      if (other.id !== id && otherKeys && sameKeys(otherKeys, keys)) {
        store.setKeybinding(other.id, null);
        notice = `${displayKeys(keys)} was “${other.label}”, which now has no shortcut.`;
      }
    }
  }
  const fallback = SHORTCUTS.find((s) => s.id === id)!.keys;
  store.setKeybinding(id, keys && sameKeys(keys, fallback) ? undefined : keys);
  return notice;
}

/** Applies a change from the page. Resolves with a notice to show, if any. */
export async function applySettings(store: Store, patch: SettingsPatch, effects: SettingsEffects): Promise<string | undefined> {
  let notice: string | undefined;
  if (patch.resetShortcuts) store.resetKeybindings();
  if (patch.shortcut) notice = setShortcut(store, String(patch.shortcut.id), patch.shortcut.keys === null ? null : String(patch.shortcut.keys));
  // Ignore ids that aren't in the list rather than storing garbage.
  if (patch.searchEngine && patch.searchEngine in SEARCH_ENGINES) {
    store.setSearchEngine(patch.searchEngine);
  }
  if (patch.environments !== undefined) store.setEnvironments(sanitizeEnvironments(patch.environments));
  if (patch.askWhereToSave !== undefined) store.setDownloads({ askWhereToSave: patch.askWhereToSave });
  if (patch.theme || patch.peekPinnedLinks !== undefined) {
    store.setPreferences({ theme: patch.theme, peekPinnedLinks: patch.peekPinnedLinks });
    effects.theme(store.state.theme ?? 'system');
  }
  if (patch.openLinksInFlechinha !== undefined) store.setOpenLinksInFlechinha(patch.openLinksInFlechinha);
  if (typeof patch.archiveAfterHours === 'number') store.setArchiveAfter(patch.archiveAfterHours);
  if (patch.agentEnabled !== undefined) {
    store.setAgent({ enabled: patch.agentEnabled, token: store.state.agent?.token || newToken() });
    await effects.agent(patch.agentEnabled).catch((err) => console.error('Agent bridge failed', err));
  }
  if (patch.adBlock !== undefined) {
    store.setAdBlock(patch.adBlock);
    await effects.adBlock(patch.adBlock).catch((err) => console.error('Ad blocker failed', err));
  }
  return notice;
}

/** A fresh agent token. The bridge reads the token on every request, so the old one stops working right away. */
export function renewAgentToken(store: Store) {
  store.setAgent({ enabled: !!store.state.agent?.enabled, token: newToken() });
}

/** 24 random bytes, base64url, as Node's `randomBytes(24).toString('base64url')` gave. */
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
