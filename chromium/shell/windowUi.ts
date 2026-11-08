/**
 * What the Electron spike drew natively over the sidebar and an extension page draws itself:
 * the tab and Space context menus, the "Delete Space?" question, and clipboard writes the
 * background asks for. The background builds menus as data (protocol.ts MenuRun); this page
 * shows them with settingsUi's in-page menu.
 *
 * In Flecha's own browser the frame page is only as wide as the sidebar, so while a menu or
 * a question is up it covers the whole window (an "overlay", like the command bar): clicks
 * on the page dismiss the menu, and the dialog has room.
 */
import type { UiState } from '../shared/types';
import { cmd, invoke, on } from './client';
import type { MenuRun } from './protocol';
import { askDialog, popupMenu, type MenuEntry } from './settingsUi';

const framed = typeof chrome.flechaPrivate?.setFrame === 'function';
const surface = document.documentElement.dataset.surface;
const windowId = framed && surface === 'window' ? chrome.flechaPrivate.getWindowId() : undefined;

let overlaid = false;
on('frame', (state: { overlay: boolean }) => (overlaid = state.overlay));

/** Resolves on the next resize (the frame growing), or after `ms` if none comes. */
const resized = (ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      removeEventListener('resize', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    addEventListener('resize', done);
  });

/** Covers the window with the frame while `fn` runs. */
async function overWindow<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!windowId) return fn();
  const grow = !overlaid;
  cmd('setOverlay')(name, true);
  if (grow) await resized(300);
  try {
    return await fn();
  } finally {
    cmd('setOverlay')(name, false);
  }
}

export interface WindowUiHooks {
  /** Starts the sidebar's inline rename of a tab. */
  rename(tabId: string): void;
  state(): UiState | undefined;
}

let hooks: WindowUiHooks | undefined;
export function setupWindowUi(h: WindowUiHooks) {
  hooks = h;
}

/** Asks for the background's menu `name` about `id`, shows it at the pointer and runs the pick. */
export async function showMenu(name: 'tabMenu' | 'spaceMenu' | 'extensionMenu', id: string) {
  const items = await invoke<MenuEntry<MenuRun>[] | undefined>(name, id);
  if (!items?.length) return;
  const picked = await overWindow('menu', () => popupMenu(items));
  if (picked) await runMenuItem(picked.run);
}

async function runMenuItem(run: MenuRun) {
  if ('cmd' in run) cmd(run.cmd)(...run.args);
  else if ('copy' in run) await copy(run.copy, run.message);
  else if ('rename' in run) {
    // The keys go to the sidebar's rename field, so the frame page takes keyboard focus.
    if (windowId) await chrome.flechaPrivate.focus('frame', await windowId);
    hooks?.rename(run.rename);
  }
  else if ('deleteSpace' in run) await confirmDeleteSpace(run.deleteSpace);
  else if ('clearSpaceData' in run) await confirmClearSpaceData(run.clearSpaceData);
  else if ('uninstallExtension' in run) await chrome.management.uninstall(run.uninstallExtension, { showConfirmDialog: true }).catch(() => undefined);
}

/** Electron's "Sign out of everything in “Space”?" message box, in the page. */
async function confirmClearSpaceData(spaceId: string) {
  const space = hooks?.state()?.spaces.find((s) => s.id === spaceId);
  if (!space?.isolated) return;
  const response = await overWindow('dialog', () =>
    askDialog({
      message: `Sign out of everything in “${space.name}”?`,
      detail: 'Clears cookies, storage and cache for this Space only.',
      buttons: ['Clear', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    }),
  );
  if (response === 0) cmd('clearSpaceData')(spaceId);
}

/** Electron's "Delete “Space”?" message box, in the page. */
export async function confirmDeleteSpace(spaceId: string) {
  const state = hooks?.state();
  const space = state?.spaces.find((s) => s.id === spaceId);
  if (!space || state!.spaces.length < 2) return;
  const response = await overWindow('dialog', () =>
    askDialog({
      message: `Delete “${space.name}”?`,
      detail: 'Its pinned and today tabs are closed. This can’t be undone.',
      buttons: ['Delete Space', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    }),
  );
  if (response === 0) cmd('deleteSpace')(spaceId);
}

/**
 * Writes the clipboard. A keyboard shortcut leaves the page focused, not this one, and the
 * clipboard only takes writes from the focused document, so the frame borrows focus for it.
 */
async function writeClipboard(item: string | Blob) {
  const write = () =>
    typeof item === 'string' ? navigator.clipboard.writeText(item) : navigator.clipboard.write([new ClipboardItem({ [item.type]: item })]);
  if (document.hasFocus() || !windowId) return write();
  const id = await windowId;
  await chrome.flechaPrivate.focus('frame', id);
  try {
    await write();
  } finally {
    await chrome.flechaPrivate.focus('page', id);
  }
}

/** A data: URL as a Blob, without fetch (the page's CSP keeps connect-src to 'self'). */
function pngBlob(dataUrl: string) {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

export async function copy(text: string, message: string) {
  try {
    await writeClipboard(text);
    cmd('flash')(message);
  } catch (err) {
    console.error('Flecha shell: copying failed', err);
  }
}

// The background's clipboard requests (copy link, screenshot from a shortcut) go to the frame
// page of the window they're for; stock Chromium's side panel takes them otherwise.
if (surface === 'window' || (surface === 'panel' && !framed)) {
  on('clipboard', async (target: number | undefined, data: { text?: string; png?: string; message: string }) => {
    if (windowId && target !== undefined && target !== (await windowId)) return;
    try {
      if (data.png) await writeClipboard(pngBlob(data.png));
      else if (data.text !== undefined) await writeClipboard(data.text);
      cmd('flash')(data.message);
    } catch (err) {
      console.error('Flecha shell: copying failed', err);
    }
  });
}
