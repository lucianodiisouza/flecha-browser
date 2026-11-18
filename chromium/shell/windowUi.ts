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
import type { DetectedBrowser, ImportOptions, ImportPreview, ImportResult, UiState } from '../shared/types';
import { hasImport, previewLines, resultLine } from '../shared/importText';
import { cmd, invoke, on, onReconnect } from './client';
import type { MenuRun } from './protocol';
import { askDialog, popupMenu, type MenuEntry, type MenuOptions } from './settingsUi';
import { DELETE_SPACE_DETAIL } from './lib/undo';

const framed = typeof chrome.flechaPrivate?.setFrame === 'function';
const surface = document.documentElement.dataset.surface;
const windowId = framed && surface === 'window' ? chrome.flechaPrivate.getWindowId() : undefined;

let overlaid = false;
const overlays = new Map<string, number>();
export const hasWindowOverlay = () => overlays.size > 0;
on('frame', (state: { overlay: boolean }) => (overlaid = state.overlay));
onReconnect(() => {
  for (const name of overlays.keys()) cmd('setOverlay')(name, true);
});

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
  const users = overlays.get(name) ?? 0;
  overlays.set(name, users + 1);
  if (!users) cmd('setOverlay')(name, true);
  if (grow) await resized(300);
  try {
    return await fn();
  } finally {
    const remaining = (overlays.get(name) ?? 1) - 1;
    if (remaining) overlays.set(name, remaining);
    else {
      overlays.delete(name);
      cmd('setOverlay')(name, false);
    }
  }
}

export interface WindowUiHooks {
  /** Starts the sidebar's inline rename of a tab. */
  rename(tabId: string): void;
  /** Starts the sidebar's inline edit of a pinned tab's or favorite's URL. */
  editHomeUrl(tabId: string): void;
  state(): UiState | undefined;
}

let hooks: WindowUiHooks | undefined;
export function setupWindowUi(h: WindowUiHooks) {
  hooks = h;
}

/** Asks for the background's menu `name` about `id`, shows it at the pointer and runs the pick. */
export async function showMenu(name: 'tabMenu' | 'spaceMenu', id: string) {
  const items = await invoke<MenuEntry<MenuRun>[] | undefined>(name, id);
  if (!items?.length) return;
  const picked = await overWindow('menu', () => popupMenu(items));
  if (picked) await runMenuItem(picked.run);
}

/** A menu of the page's own (the window menu on Linux and Windows), over the window. */
export function showPageMenu<T>(items: MenuEntry<T>[], options: MenuOptions) {
  return overWindow('menu', () => popupMenu(items, options));
}

async function runMenuItem(run: MenuRun) {
  if ('cmd' in run) cmd(run.cmd)(...run.args);
  else if ('copy' in run) await copy(run.copy, run.message);
  else if ('rename' in run || 'editHomeUrl' in run) {
    // The keys go to the sidebar's field, so the frame page takes keyboard focus.
    if (windowId) await chrome.flechaPrivate.focus('frame', await windowId);
    if ('rename' in run) hooks?.rename(run.rename);
    else hooks?.editHomeUrl(run.editHomeUrl);
  }
  else if ('deleteSpace' in run) await confirmDeleteSpace(run.deleteSpace);
  else if ('clearSpaceData' in run) await confirmClearSpaceData(run.clearSpaceData);
}

/** Where an import comes from: a browser the import helper found, or a bookmarks file one exported. */
interface ImportSource {
  name: string;
  preview(): Promise<ImportPreview>;
  run(options: ImportOptions): Promise<ImportResult>;
}

const BOOKMARKS_FILE = 'Bookmarks File…';

const browserSource = (b: DetectedBrowser): ImportSource => ({
  name: b.name,
  preview: () => invoke<ImportPreview>('previewImport', b.id),
  run: (options) => invoke<ImportResult>('importBrowser', b.id, options),
});

/** A bookmarks file exported as HTML, which any browser can save; undefined when none is chosen. */
async function bookmarksFileSource(): Promise<ImportSource | undefined> {
  const file = await new Promise<File | undefined>((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.html,.htm,text/html' });
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
  if (!file) return;
  // The page keeps the text and sends it again to import, as a browser is read again. It's awaited
  // in preview, so a file that can't be read ends as a failed import.
  const html = file.text();
  return {
    name: `“${file.name}”`,
    preview: async () => invoke<ImportPreview>('previewBookmarksFile', await html, file.name),
    run: async (options) => invoke<ImportResult>('importBookmarksFile', await html, file.name, options),
  };
}

/**
 * Import from another browser, from the window menu or the command bar: one of the browsers the
 * import helper finds (as the onboarding tour lists them) or a bookmarks file, then what came over.
 */
export async function importFromBrowser() {
  await overWindow('dialog', async () => {
    const note = (message: string, detail: string) => askDialog({ message, detail, buttons: ['OK'], defaultId: 0, cancelId: 0 });
    let browsers: DetectedBrowser[];
    try {
      browsers = await invoke<DetectedBrowser[]>('detectBrowsers');
      if (!Array.isArray(browsers)) throw new Error('Browser discovery is unavailable.');
    } catch (error) {
      return note('Couldn’t look for your browsers', error instanceof Error ? error.message : 'Browser discovery failed.');
    }
    const fileDetail = 'A bookmarks file exported from any browser as HTML brings its bookmarks; history can’t come in a file.';
    const buttons = [...browsers.map((b) => b.name), BOOKMARKS_FILE, 'Cancel'];
    const answer = await askDialog({
      ...(browsers.length
        ? { message: 'Import from which browser?', detail: `Its bookmarks and history come over to Flecha. ${fileDetail}` }
        : {
            message: 'No browsers to import from',
            detail: `No supported browser data found in the standard profile folders on this computer. Custom locations and sandboxed installations may not be detected. ${fileDetail}`,
          }),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    });
    try {
      const picked = answer < browsers.length ? browserSource(browsers[answer]) : buttons[answer] === BOOKMARKS_FILE ? await bookmarksFileSource() : undefined;
      if (!picked) return;
      const preview = await picked.preview();
      if (!hasImport(preview)) return note(`Nothing to import from ${picked.name}`, preview.warnings.join('\n') || 'No bookmarks or history were found.');
      const detail = [
        ...previewLines(preview),
        ...(preview.skipped.length ? ['', 'Won’t come over:', ...preview.skipped] : []),
        ...preview.warnings,
      ].join('\n');
      // Merge joins Spaces of the same name and leaves out tabs you or the favorites have; Add as New keeps everything.
      const choices = preview.spaces.length ? ['Merge', 'Add as New', 'Cancel'] : ['Import', 'Cancel'];
      const choice = await askDialog({ message: `Import from ${picked.name}?`, detail, buttons: choices, defaultId: 0, cancelId: choices.length - 1 });
      if (choice === choices.length - 1) return;
      const mode = choices[choice] === 'Add as New' ? 'append' : 'merge';
      // New Spaces from other Arc Profiles can have Separate Cookies and Logins; one that joins yours keeps its own.
      let isolate = preview.canIsolate ? preview.spaces.flatMap((s, i) => (s.profile && !(s.matches && mode === 'merge') ? [i] : [])) : [];
      if (isolate.length) {
        const separate = await askDialog({
          message: 'Separate Cookies and Logins for Spaces from other Arc Profiles?',
          detail: `${isolate.map((i) => `“${preview.spaces[i].name}”`).join(', ')} used another Arc Profile. With Separate Cookies and Logins, each is signed in on its own, as in Arc.`,
          buttons: ['Separate', 'Share with Other Spaces', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
        });
        if (separate === 2) return;
        if (separate !== 0) isolate = [];
      }
      const r = await picked.run({ mode, isolate, spacesKey: preview.spacesKey });
      const result = resultLine(r);
      return note(r.changed ? `Imported from ${picked.name}` : `Nothing imported from ${picked.name}`, [result, ...r.warnings, ...r.details].filter(Boolean).join('\n') || 'Nothing to import');
    } catch {
      return note('Couldn’t import', 'Try again.');
    }
  });
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
      detail: DELETE_SPACE_DETAIL,
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
