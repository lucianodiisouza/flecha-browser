/** What Flecha pages and the shell's background say to each other over the "flecha" port. */
export type Message =
  | { type: 'cmd'; name: string; args: unknown[] }
  | { type: 'invoke'; id: number; name: string; args: unknown[] }
  | { type: 'result'; id: number; value?: unknown; error?: string }
  | { type: 'event'; name: string; args: unknown[] }
  /** Keeps the background awake while a page is open (it sleeps after 30s of silence). */
  | { type: 'ping' };

/**
 * What a context menu item does once picked, for menus the background builds and a page draws
 * (settingsUi's popupMenu): a background command, or something only the page can do.
 */
export type MenuRun =
  | { cmd: string; args: unknown[] }
  /** The page writes the clipboard; the background has no document to do it from. */
  | { copy: string; message: string }
  /** The sidebar's inline rename of a tab row. */
  | { rename: string }
  /** Asks first, in the page, then deletes the Space. */
  | { deleteSpace: string }
  /** Asks first, in the page, then signs out of everything in the Space (separate cookies). */
  | { clearSpaceData: string }
  /** chrome.management.uninstall wants the click's user gesture, which only the page has. */
  | { uninstallExtension: string };
