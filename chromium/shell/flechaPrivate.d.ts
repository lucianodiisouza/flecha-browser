/**
 * chrome.flechaPrivate: what Flecha's browser (the native patches) gives the shell, and only
 * the shell. It is how the shell draws the whole window like the Electron spike did: the
 * frame page (window.html) is a transparent view over the window, and the browser lays the
 * page area and the traffic lights out around it.
 *
 * Absent in stock Chromium; the shell then falls back to the side panel.
 *
 * Layout, the same numbers as the Electron spike's Browser.layout():
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
  }

  /** Lays out a window's frame. Applies to every normal window when windowId is omitted. */
  function setFrame(state: FrameState, windowId?: number): Promise<void>;

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
   * setSplitRatio sets the left pane's share (clamped to 0.1–0.9); `tabId` is either tab of
   * the split. Rejects while the tab isn't in a split yet.
   */
  function setSplitRatio(tabId: number, ratio: number): Promise<void>;

  /** The user finished dragging the gap: `tabId` is the left pane's tab. */
  const onSplitRatioChanged: chrome.events.Event<(tabId: number, ratio: number) => void>;

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

  /** A window's place and size, in screen coordinates (as chrome.windows has them). */
  interface FlechinhaBounds {
    left: number;
    top: number;
    width: number;
    height: number;
  }

  /**
   * Where new Flechinhas open (patch 0046): at `bounds`, fitted to the screen it is on, each
   * one a step down and right of those already open, instead of centred under the pointer.
   * For openFlechinha() and for links from other apps alike. Without `bounds`, back to the
   * default. Not kept by the browser: the shell sets it again at startup.
   */
  function setFlechinhaBounds(bounds?: FlechinhaBounds): Promise<void>;

  /**
   * Whether a press in a drag area of a window's frame page (-webkit-app-region: drag) that
   * is let go without moving reaches the page as an ordinary click (patch 0047). A drag still
   * moves the window and a double click still zooms it. Off by default: a drag area takes
   * every press. Without `windowId`, the window whose frame page calls. macOS only.
   */
  function setDragAreasClickable(clickable: boolean, windowId?: number): Promise<void>;

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
  /**
   * Whether a tab has a page to go back to and one to go forward to (patch 0056): what the
   * Back and Forward buttons show. tabs.goBack() and goForward() don't say.
   */
  function getTabHistory(tabId: number): Promise<{ canGoBack: boolean; canGoForward: boolean }>;
  /**
   * Takes a tab to an address the user typed or picked, as the omnibox does (patch 0061): a
   * typed navigation by the browser, so Back still goes to the page left behind. Rejects
   * javascript: URLs. See lib/navigate.ts.
   */
  function navigate(tabId: number, url: string): Promise<void>;
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
   * openPeek(url, windowId?) replaces any Peek in that window (default: the main window).
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
  function openPeek(url: string, windowId?: number): Promise<void>;
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
   * What clicking an extension's toolbar button does in Chromium, its popup or
   * action.onClicked (patch 0042). The toolbar being hidden, the popup opens beside `anchor`,
   * a rect in the frame page's coordinates. Rejects while the action is disabled on the
   * active tab.
   */
  function openExtensionAction(
    extensionId: string,
    anchor: { x: number; y: number; width: number; height: number },
    windowId?: number,
  ): Promise<void>;

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
   * Flecha's menus in the macOS menu bar (patch 0045), in place of the ones set before: they
   * go before the Window menu, and a menu titled like one already there ("Window") puts its
   * items at the top of that one. Chromium's Tab and Bookmarks menus are hidden. Choosing an
   * item sends its command to onShortcut(command, windowId) for the window in front.
   * `accelerator` is only shown; the keys work through setShortcuts(). No text: a separator.
   */
  interface MenuItem {
    text?: string;
    command?: string;
    accelerator?: string;
    checked?: boolean;
    /** Default: true. */
    enabled?: boolean;
  }
  interface Menu {
    title: string;
    items: MenuItem[];
  }
  function setMenus(menus: Menu[]): Promise<void>;

  /** Keeps a window above other apps' windows (Stay On Top), or not (patch 0045): a Flecha window, or any other of this profile by id (the Settings popup). */
  function setAlwaysOnTop(onTop: boolean, windowId?: number): Promise<void>;
  /**
   * Colours the system title bar of a window of this profile and takes the line under it away
   * (patch 0057): the Settings popup's, so it is one surface with the page. `color` is #rrggbb.
   * macOS only; elsewhere it resolves and does nothing.
   */
  function setTitlebarColor(color: string, windowId: number): Promise<void>;

  /**
   * A shortcut from setShortcuts() was pressed in window `windowId` (-1: a command from
   * runInRegularProfile, no window in particular).
   */
  const onShortcut: chrome.events.Event<(command: string, windowId: number) => void>;
}
