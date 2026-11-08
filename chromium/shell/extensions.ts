/**
 * The installed extensions, for the site panel's Extensions section and the ones pinned to
 * the sidebar: chrome.management's list plus Flecha's own order, pins and collapsed state.
 * Pages open an extension with chrome.flechaPrivate.openExtensionAction (patch 0042).
 */
import type { ExtensionsView, InstalledExtension } from '../shared/types';
import { broadcast, handle, onConnect } from './hub';
import { incognito } from './incognito';
import type { MenuRun } from './protocol';
import type { MenuEntry } from './settingsUi';

const STORAGE_KEY = 'extensionsBar';
const ICON_SIZE = 48;

interface Saved {
  order: string[];
  pinned: string[];
  collapsed: boolean;
}

async function loadSaved(): Promise<Saved> {
  const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as Partial<Saved> | undefined;
  return { order: saved?.order ?? [], pinned: saved?.pinned ?? [], collapsed: saved?.collapsed ?? false };
}

/** chrome://extension-icon, which pages can show but the service worker can't fetch. */
function iconFor(info: chrome.management.ExtensionInfo) {
  const sizes = [...(info.icons ?? [])].sort((a, b) => a.size - b.size);
  return (sizes.find((icon) => icon.size >= ICON_SIZE) ?? sizes.at(-1))?.url;
}

async function view(): Promise<ExtensionsView> {
  const saved = await loadSaved();
  // The incognito copy of the shell leaves extensions out: most aren't enabled there.
  const all = incognito ? [] : await chrome.management.getAll();
  const rank = (id: string) => {
    const index = saved.order.indexOf(id);
    return index < 0 ? saved.order.length : index;
  };
  const installed = all
    .filter((info) => info.enabled && info.type === 'extension' && info.id !== chrome.runtime.id)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  const items = installed.map(
    (info): InstalledExtension => ({
      id: info.id,
      name: info.name,
      icon: iconFor(info),
      optionsUrl: info.optionsUrl || undefined,
      pinned: saved.pinned.includes(info.id),
    }),
  );
  return { items, collapsed: saved.collapsed };
}

const send = () =>
  view()
    .then((current) => broadcast('extensions', current))
    .catch((err) => console.error('Flecha shell: listing extensions failed', err));

async function save(change: (saved: Saved) => void) {
  const saved = await loadSaved();
  change(saved);
  await chrome.storage.local.set({ [STORAGE_KEY]: saved });
  await send();
}

export function registerExtensions(openTab: (url: string) => void) {
  for (const event of [chrome.management.onInstalled, chrome.management.onUninstalled, chrome.management.onEnabled, chrome.management.onDisabled]) {
    event.addListener(() => void send());
  }
  onConnect(() => void send());

  handle({
    extensionMenu: async (id: string): Promise<MenuEntry<MenuRun>[] | undefined> => {
      const extension = (await view()).items.find((item) => item.id === id);
      if (!extension) return undefined;
      return [
        { label: extension.pinned ? 'Unpin from Sidebar' : 'Pin to Sidebar', run: { cmd: 'pinExtension', args: [id, !extension.pinned] } },
        { separator: true },
        { label: 'Options', enabled: !!extension.optionsUrl, run: { cmd: 'openExtensionPage', args: [extension.optionsUrl] } },
        { label: 'Manage Extensions', run: { cmd: 'openExtensionPage', args: ['chrome://extensions/'] } },
        { separator: true },
        { label: 'Remove…', run: { uninstallExtension: id } },
      ];
    },
    openExtensionPage: (url: string) => openTab(String(url)),
    pinExtension: (id: string, pinned: boolean) =>
      save((saved) => {
        saved.pinned = saved.pinned.filter((other) => other !== id);
        if (pinned) saved.pinned.push(String(id));
      }),
    /** Puts `id` before `beforeId`, or last. Everything is ranked from here on, so the order holds. */
    moveExtension: async (id: string, beforeId?: string) => {
      const ids = (await view()).items.map((item) => item.id).filter((other) => other !== id);
      const at = beforeId ? ids.indexOf(beforeId) : -1;
      ids.splice(at < 0 ? ids.length : at, 0, String(id));
      await save((saved) => (saved.order = ids));
    },
    setExtensionsCollapsed: (collapsed: boolean) => save((saved) => (saved.collapsed = !!collapsed)),
  });
}
