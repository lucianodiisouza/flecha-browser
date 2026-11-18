/**
 * chrome.flechaPrivate: what Flecha's browser (the native patches) gives the shell, and only
 * the shell. It is how the shell draws the whole window like the Electron spike did: the
 * frame page (window.html) is a transparent view over the window, and the browser lays the
 * page area and the traffic lights out around it.
 *
 * Absent in stock Chromium; the shell then falls back to the side panel.
 *
 * Layout, the same numbers as the Electron spike's Browser.layout():
 *  SIDEBAR is FrameState.sidebarWidth, 260 by default.
 *  - sidebar 'docked':   frame view = left strip SIDEBAR (260) wide; page area = x 260, y 8,
 *                        to 8 from the right and bottom edges. Traffic lights shown at (16, 18).
 *  - sidebar 'hidden':   frame view = left strip EDGE (8) wide, for the hover edge; page area
 *                        x 8. Traffic lights hidden.
 *  - sidebar 'floating': frame view = FLOAT_MARGIN + SIDEBAR + FLOAT_SHADOW (10 + 260 + 28)
 *                        wide, over the page; page area as 'hidden'. Traffic lights shown at
 *                        (16 + 10, 18 + 10).
 *  - overlay: true:      frame view covers the whole window (command bar, Peek, tour, tab
 *                        drag); the page area doesn't move.
 * The frame view stays above the page; its transparent pixels show the page beneath but
 * still take the mouse within the view's bounds, as in Electron.
 */
declare namespace chrome.flechaPrivate {
  type SidebarMode = 'docked' | 'hidden' | 'floating';

  interface FrameState {
    sidebar: SidebarMode;
    overlay: boolean;
    /** The window's colour behind the page area (the Space tint), as #rrggbb. */
    background: string;
    /**
     * The docked or floating sidebar's width (SIDEBAR above); the browser keeps it within
     * Chromium's vertical tab strip limits, 126 to 400 (patch 0061). 260 if left out.
     */
    sidebarWidth?: number;
  }

  /** Lays out a window's frame. Applies to every normal window when windowId is omitted. */
  function setFrame(state: FrameState, windowId?: number): Promise<void>;

  /**
   * Whether the sidebar stays beside a page in full screen (a video's button) in a window
   * (patch 0072). Off, the browser's default, the page fills the screen alone, whatever the
   * sidebar's mode: frame view 0 wide, page area edge to edge. The window's own full screen
   * (F11) keeps the sidebar's mode either way. Absent from older browsers.
   */
  function setSidebarInPageFullscreen(show: boolean, windowId?: number): Promise<void>;

  /** Moves keyboard focus to the frame page (command bar) or back to the active page. */
  function focus(target: 'frame' | 'page', windowId?: number): Promise<void>;

  /** The window a frame page belongs to; frame pages are opened by the browser, one per window. */
  function getWindowId(): Promise<number>;

  /**
   * Flecha's keyboard shortcuts (patch 0016): `shortcuts` maps Electron accelerators
   * ("CmdOrCtrl+Shift+T", "Alt+CmdOrCtrl+Left", "Ctrl+Tab", "CmdOrCtrl+[") to command ids.
   * Flecha windows take these keys before the page and before Chromium's own shortcuts and
   * menu items (so ⌘S no longer opens Save Page), and send them to onShortcut. Each call
   * replaces the whole map; keys left out go back to Chromium (⌘C, ⌘V, ⌘P…).
   *
   * Syntax: modifiers Cmd/Command/CmdOrCtrl/CommandOrControl/Super/Meta, Ctrl/Control,
   * Alt/Option, Shift, then one key: a letter, a digit, [ ] = - , . / ; ' ` \, Plus, Tab,
   * Space, Enter/Return, Escape/Esc, Backspace, Delete, Up/Down/Left/Right, Home, End,
   * PageUp, PageDown, F1–F24. Resolves with the accelerators it couldn't read (ignored).
   */
  function setShortcuts(shortcuts: Record<string, string>): Promise<string[]>;

  /**
   * The browser's colour scheme (patch 0018), like Electron's nativeTheme.themeSource:
   * Chromium's own UI (menus, dialogs, find bar, traffic lights) and every page's
   * prefers-color-scheme follow it, the frame page's included. 'system' follows macOS. Kept in
   * the profile (Chromium's Settings > Appearance > Mode).
   */
  function setTheme(theme: 'system' | 'light' | 'dark'): Promise<void>;

  /**
   * Split views (patch 0019). In Flecha windows Chromium's split has none of its own chrome:
   * the panes sit straight in the page area, 8px apart (the spike's GAP, which is also the
   * drag handle), each with 10px round corners; no inset, padding, outline or mini toolbar.
   * The left pane is round((width − 8) × ratio) wide, as in Electron's layout().
   *
   * setSplitRatio sets the left pane's share (clamped to 0.1–0.9). Patch 0084 supports a
   * higher ratio for Responsive View. `tabId` is either tab of the split.
   */
  function setSplitRatio(tabId: number, ratio: number, responsive?: boolean): Promise<void>;

  /** The user finished dragging the gap: `tabId` is the left pane's tab. */
  const onSplitRatioChanged: chrome.events.Event<(tabId: number, ratio: number) => void>;
  /** The browser laid out a different width for a visible split. */
  const onSplitAreaResized: chrome.events.Event<(windowId: number) => void> | undefined;

  /**
   * Flechinha (patch 0023), Flecha's small window for one page, as the Electron version had:
   * a normal Chromium window (900×700 at most, centred on the display under the pointer, each
   * new one a step down and right) whose frame page is window.html?window=<id>&kind=flechinha.
   * The frame draws a toolbar FLECHINHA_TOOLBAR (44) tall across the whole width; the page
   * sits under it at x 8, y 44, to 8 from the right and bottom (round corners). Traffic lights
   * at (16, 16). setFrame() with overlay: true makes the frame cover the whole window (for
   * menus); its sidebar mode is ignored. -webkit-app-region: drag moves the window.
   * Links the page opens in new tabs (target=_blank, ⌘-click) open in Flecha's main window;
   * real popups stay popups. Not restored with the session.
   *
   * openFlechinha({ url }) opens a page (default: the new tab page); openFlechinha({ tabId })
   * moves that tab into the new window instead. Resolves with the window id.
   */
  function openFlechinha(options?: { url?: string; tabId?: number }): Promise<number>;

  /**
   * "Open in Flecha": moves the Flechinha's page into Flecha's main window (the last active
   * window that isn't a Flechinha), activates it there and brings that window to the front;
   * the emptied Flechinha closes. Resolves with the tab id (Chromium fires tabs.onDetached /
   * onAttached for it, not onCreated).
   */
  function openInFlecha(windowId: number): Promise<number>;

  /**
   * Whether links from other apps (Flecha as the default browser) open in a new Flechinha,
   * like the spike's state.openLinksInFlechinha. On by default; applies once a Flecha window
   * is up (a link that launches Flecha opens as a normal tab).
   */
  function setOpenLinksInFlechinha(enabled: boolean): Promise<void>;

  /** The open Flechinhas' window ids (e.g. after the background restarts). */
  function getFlechinhas(): Promise<number[]>;

  /**
   * Incognito windows (patch 0032). The shell runs in split incognito mode: incognito windows
   * get their frame page from a second copy of the shell, in the incognito profile, and every
   * call above made by that copy is about incognito windows and tabs only (and the regular
   * copy's never reach them). Events go to the copy of the window they're about. The
   * shortcut map (setShortcuts), setTheme, setPeekTabs and setOpenLinksInFlechinha are the
   * browser's, one for every window: the regular copy sets them.
   *
   * runInRegularProfile(command) is for the incognito copy: the regular copy gets `command`
   * as onShortcut(command, -1). Settings keep one state, the regular profile's, so incognito
   * windows open them this way ("settings", or "openSettings:<pane>").
   */
  function runInRegularProfile(command: string): Promise<void>;

  /**
   * Spaces with separate cookies and logins (patch 0034), like the spike's
   * persist:space-<id> session partitions. A tab of such a Space lives in a storage partition
   * of its own, named by the shell (the Space's id): cookies, localStorage, IndexedDB, service
   * workers and cache, kept on disk across restarts (in memory in incognito). A tab's
   * partition is fixed for its life, across every navigation; tabs and Peeks its pages open
   * inherit it. To move a tab to another partition, close it and create it again.
   *
   * createTab(options) is tabs.create() with a `partition` ("" or none: the profile's own
   * storage); it resolves with the new tab's id (tabs.onCreated fires first).
   * getTabPartition(tabId) says which partition a tab is in ("" for the profile's own).
   * clearPartition(partition) removes everything in a Space's partition (the spike's "Clear
   * Cookies and Site Data…"); its pages keep running, so reload them.
   */
  interface CreateTabOptions {
    /** Default: Flecha's main window. */
    windowId?: number;
    /** Default: the new tab page. */
    url?: string;
    /** Default: true. */
    active?: boolean;
    partition?: string;
  }
  function createTab(options: CreateTabOptions): Promise<number>;
  function getTabPartition(tabId: number): Promise<string>;
  function clearPartition(partition: string): Promise<void>;

  /**
   * Peek (patch 0026), like the spike's openPeek(): a page in a floating card over the page
   * area, at peekBounds() = page area inset round(8% of its width) on each side, 48 from its
   * top (room for the frame page's Peek toolbar) and 24 from its bottom; 12px corners.
   * While a Peek is open the frame view covers the whole window (as with overlay: true), so
   * the frame page draws the dimmed backdrop and the toolbar from onPeekChanged's bounds; the
   * page area doesn't move. Escape in the Peek closes it; its links to new tabs open as tabs
   * of the window; window.open popups stay popups.
   *
   * openPeek(url, windowId?, sourceTabId?) replaces any Peek in that window (default: the main
   * window); with `sourceTabId`, the tab whose link it is, the Peek opens in that tab's Space
   * partition (patch 0055; older builds reject the third argument).
   * promotePeek() moves the page, as it is, into the window's tab strip as the active tab (the
   * shell adopts it through tabs.onCreated). setPeekTabs(tabIds): those tabs' links to a new
   * foreground tab (target=_blank, window.open without a popup) open in Peek instead.
   */
  interface PeekState {
    url: string;
    title: string;
    /** Where the Peek's page sits, in the frame page's coordinates. */
    bounds: { x: number; y: number; width: number; height: number };
  }
  function openPeek(url: string, windowId?: number, sourceTabId?: number): Promise<void>;
  function closePeek(windowId?: number): Promise<void>;
  function promotePeek(windowId?: number): Promise<void>;
  function setPeekTabs(tabIds: number[]): Promise<void>;
  /** A window's Peek opened, moved, navigated or closed (`peek` undefined). */
  const onPeekChanged: chrome.events.Event<(windowId: number, peek?: PeekState) => void>;

  /**
   * Developer Tools for a tab (patch 0027), docked or in their own window as last time.
   * `toggle` closes them if open (⌥⌘I); `console` opens them on the Console panel.
   */
  interface DevToolsOptions {
    toggle?: boolean;
    console?: boolean;
  }
  function openDevTools(tabId: number, options?: DevToolsOptions): Promise<void>;

  /**
   * Chromium's find bar (find in page) in `windowId` or the main window (patch 0030). With
   * the toolbar hidden it floats at the page area's top right, just inside it.
   */
  function showFindBar(windowId?: number): Promise<void>;

  /** Whether Flecha is the default browser, and whether it can make itself so (patch 0027). */
  interface DefaultBrowserState {
    isDefault: boolean;
    canSet: boolean;
  }
  function isDefaultBrowser(): Promise<DefaultBrowserState>;
  /** Asks macOS to make Flecha the default browser (macOS confirms), then reports the result. */
  function makeDefaultBrowser(): Promise<DefaultBrowserState>;

  /**
   * Extension toolbar actions (patch 0056): the window's hidden toolbar buttons, pinned ones
   * first, as they look on its active tab. `icon` is a PNG data URL of the 28px button image,
   * badge included, drawn for 2x. runExtensionAction() acts like a click on the button: a popup
   * opens below `anchor` (the sidebar button, in the frame page's coordinates), and running
   * it again while the popup is open closes it. Keyboard shortcuts and chrome.action.openPopup()
   * open popups at the page area's top right instead. Bubbles that would point at the hidden
   * toolbar (permissions, passwords, app install) drop into the page area from its top edge.
   */
  interface ExtensionAction {
    id: string;
    name: string;
    tooltip: string;
    icon: string;
    enabled: boolean;
    pinned: boolean;
  }
  interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
  }
  function getExtensionActions(windowId: number): Promise<ExtensionAction[]>;
  function runExtensionAction(windowId: number, id: string, anchor: Bounds): Promise<void>;
  function showExtensionActionMenu(windowId: number, id: string, anchor: Bounds): Promise<void>;
  /**
   * Chromium's extensions menu (every extension, with pinning and site access), below `anchor`
   * (the sidebar's puzzle button); called again while it is open, it closes it (patch 0071).
   * A popup started from it drops from `anchor` too, and a disabled action's button (no popup
   * to run) shows the extension's menu at that button.
   */
  function showExtensionsMenu(windowId: number, anchor: Bounds): Promise<void>;
  /** A window's actions were added, removed, or changed icon, badge or title. */
  const onExtensionActionsChanged: chrome.events.Event<(windowId: number) => void>;

  /**
   * Downloads Chromium holds for a decision (patch 0058): a dangerous file, or one sent over
   * plain HTTP (`insecure`, which chrome.downloads doesn't report). keepDownload() lets one
   * finish; discardDownload() cancels it and deletes what it saved. Chromium's download bubble,
   * which would ask, is off.
   */
  interface DownloadWarning {
    id: number;
    kind: 'dangerous' | 'insecure';
  }
  function getDownloadWarnings(): Promise<DownloadWarning[]>;
  function keepDownload(id: number): Promise<void>;
  function discardDownload(id: number): Promise<void>;
  /** Where downloads go and whether Chromium asks each time (download.default_directory, download.prompt_for_download). */
  // Native video controls, available in the VSR-enabled Chromium build.
  type VsrState = import('../shared/types').VsrState;
  function getVsrState(): Promise<VsrState>;
  function setVsrSettings(enabled: boolean, quality: 1 | 2 | 3 | 4, maxOutputHeight: number): Promise<VsrState>;

  /** Browser-wide debug preference, applied at startup without restarting automatically. */
  function getDebugSettings(): Promise<import('../shared/types').DebugSettings>;
  function setVideoBufferWorkaround(enabled: boolean): Promise<import('../shared/types').DebugSettings>;

  interface DownloadSettings {
    folder: string;
    askWhereToSave: boolean;
  }
  function getDownloadSettings(): Promise<DownloadSettings>;
  /** The platform's folder chooser, over the last active window; resolves with the settings after (unchanged if cancelled). */
  function chooseDownloadsFolder(): Promise<DownloadSettings>;
  function setAskWhereToSave(ask: boolean): Promise<DownloadSettings>;

  /**
   * Whether the browser is quitting, which closes every window at once (patch 0059). With the
   * id of a window that has closed: whether quitting closed it, false if you closed it before
   * the quit began (patch 0062).
   */
  function isQuitting(windowId?: number): Promise<boolean>;

  /**
   * Votes for the browser to freeze a tab, or takes the vote back (patch 0066). A frozen page
   * keeps its memory and state but runs nothing; the browser won't freeze one that plays sound,
   * captures or holds a call. The vote ends with the tab.
   */
  function setTabFreezing(tabId: number, canFreeze: boolean): Promise<void>;

  /**
   * Discards a background tab the way Memory Saver does (patch 0067): only if none of the
   * browser's protections apply (visible, audible, capturing, form input, PDF, notifications,
   * DevTools, not auto-discardable...). Resolves whether it was discarded.
   */
  function discardTab(tabId: number): Promise<boolean>;

  /** Milliseconds of a clock that doesn't advance while the device is suspended (patch 0067). */
  function getLiveTicks(): Promise<number>;

  /**
   * Marks a tab as Flecha's tab sleep's to discard, or takes the mark back (patch 0069): Memory
   * Saver leaves a marked tab alone. The mark ends with the page (a discard ends it).
   */
  function setTabSleepManaged(tabId: number, managed: boolean): Promise<void>;

  /**
   * Marks a tab as one a coding agent drives, or takes the mark back (patch 0080). Only the
   * shell's scripts run in a marked tab: other extensions' content scripts and executeScript()
   * calls don't. Mark it before its page loads. The mark stays with the tab when it is
   * discarded. Absent from older browsers.
   */
  function setAgentTab(tabId: number, agent: boolean): Promise<void>;

  /**
   * Quits the browser as the macOS app menu's Quit does, so every window comes back next time
   * (patch 0070; isQuitting() is true for them). Absent from older browsers.
   */
  function quit(): Promise<void>;

  /** Prints a tab with Chromium's print preview, as Ctrl+P does (patch 0070). */
  function print(tabId: number): Promise<void>;

  /**
   * A shortcut from setShortcuts() was pressed in window `windowId` (-1: a command from
   * runInRegularProfile, no window in particular).
   */
  const onShortcut: chrome.events.Event<(command: string, windowId: number) => void>;
  /**
   * The modifier keys held for a shortcut (Control, Alt, Command) were released, or the window
   * lost focus first (patch 0057). Shortcuts pressed while the same modifiers stay held share
   * one release, which names the first of them. Older builds don't have it.
   */
  const onShortcutReleased: chrome.events.Event<(command: string, windowId: number) => void> | undefined;
}
