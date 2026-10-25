import type { BrowserState, ShortcutInfo } from '../../shared/types';

/**
 * Every command with a keyboard shortcut. Menus, tooltips and Settings all read keys from
 * here, so a shortcut you record in Settings changes everywhere at once. Keys are Electron
 * accelerators ("CmdOrCtrl+Shift+T").
 */
export const SHORTCUTS = [
  { id: 'newTab', group: 'Getting around', label: 'New tab', keys: 'CmdOrCtrl+T' },
  { id: 'openLocation', group: 'Getting around', label: 'Open location', keys: 'CmdOrCtrl+L' },
  { id: 'back', group: 'Getting around', label: 'Back', keys: 'CmdOrCtrl+[' },
  { id: 'forward', group: 'Getting around', label: 'Forward', keys: 'CmdOrCtrl+]' },
  { id: 'reload', group: 'Getting around', label: 'Reload', keys: 'CmdOrCtrl+R' },
  { id: 'hardReload', group: 'Getting around', label: 'Hard reload', keys: 'CmdOrCtrl+Shift+R' },
  { id: 'find', group: 'Getting around', label: 'Find in page', keys: 'CmdOrCtrl+F' },
  { id: 'toggleSidebar', group: 'Getting around', label: 'Show or hide the sidebar', keys: 'CmdOrCtrl+S' },
  { id: 'settings', group: 'Getting around', label: 'Settings', keys: 'CmdOrCtrl+,' },
  { id: 'newFlechinha', group: 'Tabs', label: 'New Flechinha window', keys: 'Alt+CmdOrCtrl+N' },
  { id: 'closeTab', group: 'Tabs', label: 'Close tab', keys: 'CmdOrCtrl+W' },
  { id: 'reopenTab', group: 'Tabs', label: 'Reopen closed tab', keys: 'CmdOrCtrl+Shift+T' },
  { id: 'nextTab', group: 'Tabs', label: 'Next tab', keys: 'Ctrl+Tab' },
  { id: 'previousTab', group: 'Tabs', label: 'Previous tab', keys: 'Ctrl+Shift+Tab' },
  { id: 'pinTab', group: 'Tabs', label: 'Pin or unpin tab', keys: 'CmdOrCtrl+D' },
  { id: 'duplicateTab', group: 'Tabs', label: 'Duplicate tab', keys: 'Alt+CmdOrCtrl+D' },
  { id: 'muteTab', group: 'Tabs', label: 'Mute or unmute tab', keys: 'Ctrl+M' },
  { id: 'clearToday', group: 'Tabs', label: 'Clear Today', keys: 'CmdOrCtrl+Shift+K' },
  { id: 'copyLink', group: 'Tabs', label: 'Copy link', keys: 'CmdOrCtrl+Shift+C' },
  { id: 'copyMarkdown', group: 'Tabs', label: 'Copy as Markdown link', keys: 'Alt+CmdOrCtrl+C' },
  { id: 'screenshot', group: 'Tabs', label: 'Copy screenshot', keys: 'CmdOrCtrl+Shift+2' },
  { id: 'nextSpace', group: 'Spaces', label: 'Next Space', keys: 'Alt+CmdOrCtrl+Right' },
  { id: 'previousSpace', group: 'Spaces', label: 'Previous Space', keys: 'Alt+CmdOrCtrl+Left' },
  { id: 'newSpace', group: 'Spaces', label: 'New Space', keys: 'Ctrl+Shift+N' },
  { id: 'splitNew', group: 'Split & Peek', label: 'Split with a new tab', keys: 'Ctrl+Shift+=' },
  { id: 'exitSplit', group: 'Split & Peek', label: 'Exit split view', keys: 'Ctrl+Shift+-' },
  { id: 'zoomIn', group: 'View', label: 'Zoom in', keys: 'CmdOrCtrl+=' },
  { id: 'zoomOut', group: 'View', label: 'Zoom out', keys: 'CmdOrCtrl+-' },
  { id: 'actualSize', group: 'View', label: 'Actual size', keys: 'CmdOrCtrl+0' },
  { id: 'devTools', group: 'Developer', label: 'Developer Tools', keys: 'Alt+CmdOrCtrl+I' },
  { id: 'responsive', group: 'Developer', label: 'Responsive view', keys: 'Alt+CmdOrCtrl+M' },
  { id: 'nextEnvironment', group: 'Developer', label: 'Next environment', keys: 'Alt+CmdOrCtrl+E' },
  { id: 'editBoost', group: 'Developer', label: 'Edit boost for this site', keys: 'Alt+CmdOrCtrl+B' },
  { id: 'viewSource', group: 'Developer', label: 'View source', keys: 'Alt+CmdOrCtrl+U' },
  { id: 'shortcuts', group: 'Getting around', label: 'Keyboard shortcuts', keys: 'CmdOrCtrl+/' },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

/** macOS shows keys as symbols (⌥⌘T); Linux spells them out (Ctrl+Alt+T). */
export const IS_MAC = navigator.userAgent.includes('Mac');
/** The modifier that picks a Space by number: Ctrl+1 on Linux is already the tab's. */
export const SPACE_MODIFIER = IS_MAC ? 'Ctrl' : 'Alt';

/** Shortcuts that are a family of keys (⌘1…⌘9) and can't be recorded as one. */
const FIXED: ShortcutInfo[] = [
  { id: 'tabN', group: 'Tabs', label: 'Go to tab · last tab', keys: `${displayKeys('CmdOrCtrl+1')} … ${displayKeys('CmdOrCtrl+9')}`, fixed: true },
  { id: 'spaceN', group: 'Spaces', label: 'Go to Space', keys: `${displayKeys(`${SPACE_MODIFIER}+1`)} … ${displayKeys(`${SPACE_MODIFIER}+9`)}`, fixed: true },
  { id: 'closePeek', group: 'Split & Peek', label: 'Close Peek', keys: 'Esc', fixed: true },
];

/** The accelerator for a command: yours if you set one, none if you removed it, else the default. */
export function keysFor(state: BrowserState, id: ShortcutId): string | undefined {
  const own = state.keybindings?.[id];
  if (own === null) return undefined;
  return own ?? SHORTCUTS.find((s) => s.id === id)?.keys;
}

export function isShortcutId(id: string): id is ShortcutId {
  return SHORTCUTS.some((s) => s.id === id);
}

/** Two accelerators that press the same keys ("CmdOrCtrl+T" and "Cmd+T") compare equal. */
export function sameKeys(a: string, b: string) {
  const norm = (keys: string) =>
    keys
      .replace(/CmdOrCtrl|CommandOrControl|Command/g, 'Cmd')
      .replace(/Option/g, 'Alt')
      .replace(/Control/g, 'Ctrl')
      .split('+')
      .sort()
      .join('+')
      .toLowerCase();
  return norm(a) === norm(b);
}

/** "Alt+CmdOrCtrl+Shift+T" → "⌥⇧⌘T" on macOS, "Ctrl+Alt+Shift+T" on Linux. */
export function displayKeys(keys: string | undefined) {
  if (!keys) return '';
  const parts = keys.split('+');
  const mods = new Set(
    parts.slice(0, -1).map((m) => m.replace(/CmdOrCtrl|CommandOrControl/, IS_MAC ? 'Cmd' : 'Ctrl').replace('Command', 'Cmd').replace('Option', 'Alt').replace('Control', 'Ctrl')),
  );
  const key = parts[parts.length - 1];
  if (!IS_MAC) {
    const named = ['Ctrl', 'Alt', 'Shift', 'Cmd'].filter((m) => mods.has(m)).map((m) => (m === 'Cmd' ? 'Super' : m));
    const keyName = ({ Escape: 'Esc', CmdOrCtrl: 'Ctrl', CommandOrControl: 'Ctrl' } as Record<string, string>)[key] ?? (key.length === 1 ? key.toUpperCase() : key);
    return [...named, keyName].join('+');
  }
  const names: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓', Return: '↩', Enter: '↩', Tab: '⇥', Space: 'Space', Escape: 'Esc', Backspace: '⌫', Delete: '⌦', '-': '−' };
  return (
    (mods.has('Ctrl') ? '⌃' : '') + (mods.has('Alt') ? '⌥' : '') + (mods.has('Shift') ? '⇧' : '') + (mods.has('Cmd') ? '⌘' : '') + (names[key] ?? key.toUpperCase())
  );
}

/** Everything Settings shows, in order, with your keys applied. */
export function shortcutList(state: BrowserState): ShortcutInfo[] {
  const editable = SHORTCUTS.map((s): ShortcutInfo => {
    const keys = keysFor(state, s.id);
    return { id: s.id, group: s.group, label: s.label, keys: displayKeys(keys), changed: state.keybindings?.[s.id] !== undefined };
  });
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return groups.flatMap((g) => [...editable.filter((s) => s.group === g), ...FIXED.filter((s) => s.group === g)]);
}

/** The sidebar's tooltips and hints, by command: { newTab: '⌘T', … }, plus the first Space's key. */
export function shortcutHints(state: BrowserState): Record<string, string> {
  return { ...Object.fromEntries(SHORTCUTS.map((s) => [s.id, displayKeys(keysFor(state, s.id))])), selectSpace: displayKeys(`${SPACE_MODIFIER}+1`) };
}

/** Pages keep macOS key caps in their HTML; on Linux each `<kbd data-keys="Alt+CmdOrCtrl+B">` is rewritten. */
export function showKeys() {
  if (IS_MAC) return;
  for (const el of document.querySelectorAll<HTMLElement>('[data-keys]')) el.textContent = displayKeys(el.dataset.keys);
}
