/**
 * Flecha's menus in the macOS menu bar (patch 0045, chrome.flechaPrivate.setMenus): Spaces,
 * Tabs and Archive, as in Arc, plus Stay On Top and Next Window at the top of the Window
 * menu. Built from the state alone, so they're tested on their own; native.ts sends them
 * whenever they change.
 *
 * An item's command is a shortcut id (lib/shortcuts.ts, run as if its keys were pressed) or
 * `menu:<what>[:<argument>]`, which native.ts runs.
 */
import type { BrowserState, PinnedNode, Space } from '../../shared/types';
import type { ShortcutId } from './shortcuts';

export interface MenuItem {
  /** None: a separator. */
  text?: string;
  command?: string;
  accelerator?: string;
  checked?: boolean;
  enabled?: boolean;
}

export interface Menu {
  title: string;
  items: MenuItem[];
}

const SEPARATOR: MenuItem = {};
/** The Archive menu lists this many of the latest archived tabs. */
export const ARCHIVE_MENU_ITEMS = 10;

function inPinned(nodes: PinnedNode[], tabId: string): boolean {
  return nodes.some((n) => (n.kind === 'tab' ? n.tabId === tabId : inPinned(n.children, tabId)));
}

function shorten(text: string, max = 60) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface MenuOptions {
  stayOnTop: boolean;
  /** A shortcut's keys as the user has them (lib/shortcuts.ts keysFor). */
  keys(id: ShortcutId): string | undefined;
  /** The modifier of ⌃1…⌃9, which switch Spaces. */
  spaceModifier: string;
}

export function flechaMenus(state: BrowserState, options: MenuOptions): Menu[] {
  const space: Space | undefined = state.spaces.find((s) => s.id === state.activeSpaceId);
  const item = (id: ShortcutId, label: string, extra: Partial<MenuItem> = {}): MenuItem => ({
    text: label,
    command: id,
    accelerator: options.keys(id),
    ...extra,
  });
  const active = space?.activeTabId;
  const hasTab = !!active && !!state.tabs[active];
  const pinned = !!active && !!space && inPinned(space.pinned, active);
  const split = !!space?.split && !!active && space.split.includes(active);

  const spaces: Menu = {
    title: 'Spaces',
    items: [
      item('newSpace', 'New Space'),
      { text: 'Edit Space…', command: 'menu:editSpace', enabled: !!space },
      SEPARATOR,
      ...state.spaces.map((s, i) => ({
        text: `${s.emoji ? `${s.emoji}  ` : ''}${s.name}`,
        command: `menu:space:${s.id}`,
        accelerator: i < 9 ? `${options.spaceModifier}+${i + 1}` : undefined,
        checked: s.id === state.activeSpaceId,
      })),
      SEPARATOR,
      item('nextSpace', 'Next Space'),
      item('previousSpace', 'Previous Space'),
      SEPARATOR,
      { text: 'Separate Cookies and Logins', command: 'menu:isolate', checked: !!space?.isolated, enabled: !!space },
      { text: 'Reset Pinned Tabs', command: 'menu:resetPinned', enabled: !!space?.pinned.length },
    ],
  };

  const tabs: Menu = {
    title: 'Tabs',
    items: [
      item('pinTab', pinned ? 'Unpin Tab' : 'Pin Tab', { enabled: hasTab }),
      { text: 'New Folder', command: 'menu:newFolder', enabled: !!space },
      { text: 'Reveal Tab in Sidebar', command: 'menu:revealTab', enabled: hasTab },
      SEPARATOR,
      item('copyLink', 'Copy Link', { enabled: hasTab }),
      item('copyMarkdown', 'Copy as Markdown Link', { enabled: hasTab }),
      { text: 'Copy Selection as Quote', command: 'menu:copyQuote', enabled: hasTab },
      SEPARATOR,
      item('duplicateTab', 'Duplicate Tab', { enabled: hasTab }),
      item('muteTab', state.tabs[active ?? '']?.muted ? 'Unmute Tab' : 'Mute Tab', { enabled: hasTab }),
      SEPARATOR,
      item('splitNew', 'Split with New Tab', { enabled: hasTab }),
      { text: 'Swap Split Sides', command: 'menu:swapSplit', enabled: split && space?.splitMode !== 'responsive' },
      item('exitSplit', 'Exit Split View', { enabled: split }),
      SEPARATOR,
      item('clearToday', 'Clear Today', { enabled: !!space?.today.length }),
    ],
  };

  const recent = state.archive.slice(0, ARCHIVE_MENU_ITEMS);
  const archive: Menu = {
    title: 'Archive',
    items: [
      { text: 'View Archive', command: 'openSettings:archive' },
      SEPARATOR,
      ...(recent.length
        ? recent.map((a) => ({ text: shorten(a.title || a.url), command: `menu:reopen:${a.closedAt}` }))
        : [{ text: 'No Archived Tabs', enabled: false }]),
    ],
  };

  const window: Menu = {
    title: 'Window',
    items: [
      { text: 'Stay On Top', command: 'menu:stayOnTop', checked: options.stayOnTop },
      SEPARATOR,
      item('nextWindow', 'Next Window'),
      item('previousWindow', 'Previous Window'),
    ],
  };

  return [spaces, tabs, archive, window];
}
