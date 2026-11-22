import type { SettingsPatch, SettingsView } from '../../shared/types';
import type { Store } from '../../shared/store';
import { SEARCH_ENGINES } from './url';
import { formatTargets, parseTargets } from './environments';
import { SHORTCUTS, defaultKeys, displayKeys, fixedShortcuts, isShortcutId, keysFor, sameKeys, shortcutList } from './shortcuts';

/** A modifier and a key, or a function key alone: "Alt+Cmd+K", "F5". */
const ACCELERATOR = /^((Ctrl|Alt|Shift|Cmd|CmdOrCtrl)\+){1,4}[^+]+$|^F\d{1,2}$/;

/** What the view needs from the browser it runs in. */
export interface SettingsEnvironment {
  /** For display only, with the home folder shortened to ~. */
  downloadsFolder: string;
  defaultBrowser: SettingsView['defaultBrowser'];
  agentEndpoint?: string;
  /** Why Flecha's native host last failed to start or stopped. */
  hostError?: string;
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
    sidebarInPageFullscreen: !!s.sidebarInPageFullscreen,
    agent: {
      enabled: !!s.agent?.enabled,
      endpoint: env.agentEndpoint,
      token: s.agent?.enabled ? s.agent.token : undefined,
    },
    hostError: env.hostError,
    environments: (s.environments ?? []).map((e) => ({
      id: e.id,
      name: e.name,
      targetsText: formatTargets(e.targets),
    })),
    searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id: id as keyof typeof SEARCH_ENGINES, name: e.name })),
  };
}

/** Records one shortcut. A command that had the same keys loses them, and the notice says so. */
export function setShortcut(store: Store, id: string, keys: string | null): string | undefined {
  if (!isShortcutId(id)) return undefined;
  if (keys === 'default') keys = defaultKeys(id);
  if (keys !== null && !ACCELERATOR.test(keys)) return undefined;
  if (keys && Object.keys(fixedShortcuts()).some((fixed) => sameKeys(fixed, keys))) return `${displayKeys(keys)} is reserved for tab, Space or Flechinha navigation.`;
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
  const fallback = defaultKeys(id);
  store.setKeybinding(id, keys && sameKeys(keys, fallback) ? undefined : keys);
  return notice;
}

function editEnvironment(store: Store, edit: NonNullable<SettingsPatch['environment']>): string | undefined {
  if (typeof edit.id !== 'string' || !edit.id) return 'Invalid Environment project.';
  const projects = store.state.environments ?? [];
  const previous = projects.find((project) => project.id === edit.id);
  if (edit.op === 'remove') {
    if (previous) store.setEnvironments(projects.filter((project) => project !== previous));
    return;
  }
  if (edit.op === 'create' && typeof edit.name === 'string' && typeof edit.targetsText === 'string') {
    if (previous) return 'This project already exists.';
    const targets = parseTargets(edit.targetsText);
    if (!targets.length) return 'Enter at least one valid target.';
    store.setEnvironments([...projects, { id: edit.id, name: edit.name.trim() || 'Project', targets }]);
    return;
  }
  if (edit.op !== 'edit' || typeof edit.value !== 'string') return 'Invalid Environment project edit.';
  if (!previous) return 'This project was removed.';
  const next = { ...previous };
  if (edit.field === 'name') next.name = edit.value.trim() || 'Project';
  else if (edit.field === 'targetsText') {
    next.targets = parseTargets(edit.value);
    if (!next.targets.length) return 'Enter at least one valid target, or use Remove project.';
  } else return 'Invalid Environment project edit.';
  store.setEnvironments(projects.map((project) => project === previous ? next : project));
}

/** Returns the notice to show for a rejected or adjusted setting. */
export function applySettings(store: Store, patch: SettingsPatch): string | undefined {
  let notice: string | undefined;
  if (patch.resetShortcuts) store.resetKeybindings();
  if (patch.shortcut) notice = setShortcut(store, String(patch.shortcut.id), patch.shortcut.keys === null ? null : String(patch.shortcut.keys));
  // Ignore ids that aren't in the list rather than storing garbage.
  if (patch.searchEngine && patch.searchEngine in SEARCH_ENGINES) {
    store.setSearchEngine(patch.searchEngine);
  }
  if (patch.environment && typeof patch.environment === 'object') notice = editEnvironment(store, patch.environment) ?? notice;
  if (patch.askWhereToSave !== undefined) store.setDownloads({ askWhereToSave: patch.askWhereToSave });
  if (patch.theme || patch.peekPinnedLinks !== undefined) {
    store.setPreferences({ theme: patch.theme, peekPinnedLinks: patch.peekPinnedLinks });
  }
  if (patch.openLinksInFlechinha !== undefined) store.setOpenLinksInFlechinha(patch.openLinksInFlechinha);
  if (patch.sidebarInPageFullscreen !== undefined) store.setSidebarInPageFullscreen(patch.sidebarInPageFullscreen);
  if (typeof patch.archiveAfterHours === 'number') store.setArchiveAfter(patch.archiveAfterHours);
  if (patch.agentEnabled !== undefined) {
    store.setAgent({ enabled: patch.agentEnabled, token: store.state.agent?.token || newToken() });
  }
  if (patch.adBlock !== undefined) store.setAdBlock(patch.adBlock);
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
