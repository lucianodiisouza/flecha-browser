export interface TabInfo {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  /** A name the user gave the tab; page titles no longer replace it. */
  customTitle?: string;
  /** Playing sound right now (not persisted). */
  audible?: boolean;
  muted?: boolean;
  /** A phone-sized mirror opened by the responsive split. */
  device?: 'mobile';
  /** Pinned and favorite tabs remember where they started, like Arc. */
  homeUrl?: string;
  loading?: boolean;
  lastActive: number;
  /** Back/forward entries (with scroll position) so a tab comes back as it was after a restart. */
  history?: { entries: Array<{ url: string; title: string; pageState?: string }>; index: number };
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export type PinnedNode =
  | { kind: 'tab'; tabId: string }
  | { kind: 'folder'; id: string; name: string; open: boolean; children: PinnedNode[] };

export interface Space {
  id: string;
  name: string;
  emoji?: string;
  color: string;
  pinned: PinnedNode[];
  today: string[];
  activeTabId?: string;
  /** Separate cookies, storage and logins from the other Spaces. */
  isolated?: boolean;
  /** Two tabs shown side by side (left, right) whenever either one is active. */
  split?: [string, string];
  /** `responsive`: the right side is a phone-sized mirror that follows the left side's navigation. */
  splitMode?: 'responsive';
  /** Share of the width the left pane takes, 0.2–0.8. Half and half when unset. */
  splitRatio?: number;
}

export interface ArchivedTab {
  url: string;
  title: string;
  closedAt: number;
}

export interface HistoryEntry {
  url: string;
  title: string;
  visits: number;
  lastVisit: number;
}

/** Another browser on this Mac with data Flecha can bring over. */
export interface DetectedBrowser {
  id: string;
  name: string;
  profiles: number;
  hasBookmarks: boolean;
  hasHistory: boolean;
  /** Cookies to bring over, so sites stay signed in. */
  hasCookies?: boolean;
}

/** What one import brought over. Problems that didn't stop it are listed in `warnings`. */
export interface ImportResult {
  spaces: number;
  bookmarks: number;
  history: number;
  /** Cookies set, so sites stay signed in. */
  cookies: number;
  warnings: string[];
}

export interface DownloadInfo {
  id: string;
  filename: string;
  path: string;
  url: string;
  received: number;
  total: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  startedAt: number;
}

export interface EnvironmentTarget {
  label: string;
  origin: string;
}

/** One project's origins, e.g. local → staging → production. */
export interface Environment {
  id: string;
  name: string;
  targets: EnvironmentTarget[];
}

export interface ActiveEnvironment {
  name: string;
  label: string;
  tone: 'local' | 'staging' | 'production';
  /** The same page on the project's other environments. */
  switches: Array<{ label: string; tone: ActiveEnvironment['tone']; url: string }>;
}

/** A dev server found listening on this machine. */
export interface LocalServer {
  port: number;
  url: string;
  /** The project folder it runs in, or the process name. */
  name: string;
}

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'brave' | 'kagi' | 'ecosia';

export interface BrowserState {
  spaces: Space[];
  activeSpaceId: string;
  favorites: string[];
  tabs: Record<string, TabInfo>;
  archive: ArchivedTab[];
  sidebarVisible: boolean;
  window?: WindowBounds;
  theme?: 'system' | 'light' | 'dark';
  /** Links that leave a pinned tab or favorite open in Peek. Default on. */
  peekPinnedLinks?: boolean;
  /** Links arriving from other apps open in a Flechinha instead of a tab. Default on. */
  openLinksInFlechinha?: boolean;
  /** Today tabs untouched this long are archived; 0 keeps them forever. Default 12. */
  archiveAfterHours?: number;
  /** Remembered answers to site permission prompts, by origin then permission. */
  sitePermissions?: Record<string, Record<string, 'allow' | 'block'>>;
  searchEngine?: SearchEngineId;
  /** Where downloads go; the system Downloads folder when unset. */
  downloadsFolder?: string;
  askWhereToSave?: boolean;
  environments?: Environment[];
  /** Built-in ad and tracker blocking; on unless turned off. */
  adBlock?: boolean;
  /** The MCP bridge for coding agents: off unless turned on in Settings. */
  agent?: { enabled: boolean; token: string };
  /** The welcome tour has been finished (or skipped). */
  onboarded?: boolean;
  /** Your own keyboard shortcuts by command id (Electron accelerators); null removes a shortcut. */
  keybindings?: Record<string, string | null>;
}

/** One row of Settings → Keyboard Shortcuts. */
export interface ShortcutInfo {
  id: string;
  group: string;
  label: string;
  /** For display ("⇧⌘T"); empty when the command has no shortcut. */
  keys: string;
  /** Differs from Flecha's default. */
  changed?: boolean;
  /** A family of keys like ⌘1…⌘9, shown but not recordable. */
  fixed?: boolean;
}

export interface UiState extends BrowserState {
  nav: { canGoBack: boolean; canGoForward: boolean; zoom: number };
  searchEngineName: string;
  /** The active Space's colour, darkened in dark mode. */
  tint: string;
  /** docked: always there. hidden: a hover strip at the left edge. floating: shown over the page until the mouse leaves. */
  sidebarMode: 'docked' | 'hidden' | 'floating';
  /** Set when the active tab is on one of the configured environments. */
  environment?: ActiveEnvironment;
  localServers: LocalServer[];
  /** Console errors since each tab's last page load (only tabs that have some). */
  consoleErrors: Record<string, number>;
  /** Hosts that have a boost (script or styles), for the sidebar's ⚡ marker. */
  boostedHosts: string[];
  /** Hosts whose icon is cached and served as `favicon://<host>`. */
  faviconHosts: string[];
  /**
   * Where those icons are served instead, with `%s` for the page's URL (encoded): the Chromium
   * build's `_favicon` endpoint. Absent in Electron, which uses `favicon://`.
   */
  faviconUrl?: string;
  /** Icons by host as data URLs, for sites the browser has none of (Chromium build). */
  faviconUrls?: Record<string, string>;
  /** What a coding agent is doing, for the sidebar. */
  agent?: { connected: boolean; tabId?: string; action?: string; busy: boolean };
  /** Current shortcut per command, for display ("⌘T"); empty when removed. */
  shortcuts: Record<string, string>;
  defaultBrowser: { isDefault: boolean; canSet: boolean };
}

export type PaletteMode = 'new-tab' | 'navigate' | 'split';

export interface PeekState {
  url: string;
  title: string;
  /** Where the peek page sits, so the sidebar UI can draw its toolbar right above it. */
  bounds: { x: number; y: number; width: number; height: number };
}

export type DropTarget =
  | { zone: 'favorites'; beforeTabId?: string }
  | { zone: 'today'; beforeTabId?: string }
  | { zone: 'pinned'; folderId?: string; beforeTabId?: string };

/**
 * A place in any Space, for Settings → Tabs & Spaces. `beforeId` is a tab (or, in pinned, a folder)
 * in that list; without it, or when it isn't there, the item goes at the end.
 */
export type TabPlacement =
  | { zone: 'favorites'; beforeId?: string }
  | { zone: 'today'; spaceId: string; beforeId?: string }
  | { zone: 'pinned'; spaceId: string; folderId?: string; beforeId?: string };

/** What a Flechinha's toolbar shows. */
export interface FlechinhaState {
  /** Empty until something has been opened. */
  url: string;
  title: string;
  favicon?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** The active Space's colour, darkened in dark mode; the toolbar wears it. */
  tint: string;
  /** Where "Open in Flecha" puts the page. */
  space: { name: string; emoji?: string };
  searchEngineName: string;
}

/** A Flechinha toolbar's bridge: the small window for links from other apps and quick lookups. */
export interface FlechinhaApi {
  onState(cb: (state: FlechinhaState) => void): void;
  /** ⌘L: start editing the address. */
  onEditAddress(cb: () => void): void;
  /** A short confirmation in place of the address ("Link copied"). */
  onFlash(cb: (message: string) => void): void;
  ready(): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  /** A URL or a search, resolved like the command bar. */
  navigate(input: string): void;
  copyLink(): void;
  /** Moves the page into the main window as a Today tab and closes the Flechinha. */
  openInFlecha(): void;
  close(): void;
}

/** What the settings page shows. */
export interface SettingsView {
  adBlock: boolean;
  searchEngine: SearchEngineId;
  searchEngines: Array<{ id: SearchEngineId; name: string }>;
  /** For display only, with the home folder shortened to ~. */
  downloadsFolder: string;
  askWhereToSave: boolean;
  defaultBrowser: { isDefault: boolean; canSet: boolean };
  /** Edited as text: one `label origin` per line. */
  environments: Array<{ id: string; name: string; targetsText: string }>;
  agent: { enabled: boolean; endpoint?: string; token?: string };
  /** Why Flecha's native host (imports, the agent bridge) last failed; undefined while it works. */
  hostError?: string;
  theme: 'system' | 'light' | 'dark';
  archiveAfterHours: number;
  peekPinnedLinks: boolean;
  shortcuts: ShortcutInfo[];
  /** Set after recording a shortcut another command had, which lost it. */
  notice?: string;
  openLinksInFlechinha: boolean;
}

/** The downloads folder is only changed through the folder picker, never set directly. */
export type SettingsPatch = Partial<Omit<SettingsView, 'searchEngines' | 'downloadsFolder' | 'defaultBrowser' | 'agent' | 'shortcuts' | 'notice'>> & {
  agentEnabled?: boolean;
  /** An accelerator, null for no shortcut, or 'default' to go back to Flecha's. */
  shortcut?: { id: string; keys: string | null };
  resetShortcuts?: boolean;
};

/** A key pressed while Settings records a shortcut. */
export interface RecordedKey {
  code: string;
  key: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/** Settings → Tabs & Spaces: favorites and every Space at once, for editing like a bookmarks manager. */
export interface TabsView {
  favorites: string[];
  spaces: Array<Pick<Space, 'id' | 'name' | 'emoji' | 'color' | 'pinned' | 'today' | 'isolated'>>;
  activeSpaceId: string;
  tabs: Record<string, Pick<TabInfo, 'id' | 'url' | 'title' | 'customTitle' | 'favicon' | 'homeUrl'> & { open: boolean }>;
  /** Hosts whose icon is cached and served as `favicon://<host>`. */
  faviconHosts: string[];
}

/** Where a folder can go: the pinned tabs of a Space, optionally inside another folder. */
export interface FolderPlacement {
  spaceId: string;
  folderId?: string;
  beforeId?: string;
}

/** One change made in Settings → Tabs & Spaces. Deleting a folder or a Space asks first, in a native dialog. */
export type TabsEdit =
  | { op: 'renameTab'; tabId: string; title: string }
  | { op: 'setUrl'; tabId: string; url: string }
  | { op: 'move'; tabIds: string[]; to: TabPlacement }
  | { op: 'delete'; tabIds: string[] }
  | { op: 'add'; url: string; title?: string; to: TabPlacement }
  | { op: 'newFolder'; spaceId: string; parentId?: string }
  | { op: 'renameFolder'; folderId: string; name: string }
  | { op: 'deleteFolder'; folderId: string }
  | { op: 'moveFolder'; folderId: string; to: FolderPlacement }
  | { op: 'newSpace' }
  | { op: 'updateSpace'; spaceId: string; name?: string; emoji?: string; color?: string }
  | { op: 'deleteSpace'; spaceId: string }
  | { op: 'moveSpace'; spaceId: string; beforeSpaceId?: string };

export interface TabsEditResult {
  view: TabsView;
  /** The folder or Space just made, so it can be named right away. */
  created?: string;
  /** Why nothing changed, e.g. an address that doesn't parse. */
  error?: string;
}

/** What a right-click on tabs or a folder asks the page to do; the rest happens in main. */
export type TabsMenuAction = 'rename' | 'edit';

export interface SettingsApi {
  get(): Promise<SettingsView>;
  set(patch: SettingsPatch): Promise<SettingsView>;
  chooseDownloadsFolder(): Promise<SettingsView>;
  makeDefaultBrowser(): Promise<SettingsView>;
  newAgentToken(): Promise<SettingsView>;
  copy(text: string): Promise<void>;
  openBoosts(): Promise<void>;
  /** Plays the welcome tour again in the browser window. */
  showTour(): Promise<void>;
  /** Other browsers on this Mac with bookmarks or history to bring over. */
  detectBrowsers(): Promise<DetectedBrowser[]>;
  /** Imports one of the browsers `detectBrowsers` found, by id. */
  importBrowser(id: string): Promise<ImportResult>;
  /** Imports the bookmarks in a file exported from any browser as HTML, given its text. */
  importBookmarksFile(html: string, fileName?: string): Promise<ImportResult>;
  onPane(cb: (pane: string) => void): void;
  /** ⌘F while Settings is in front: focus its search field. */
  onFind(cb: () => void): void;
  /** Something the background shows here changed on its own (the agent bridge, the native host); `get` again. */
  onChange(cb: () => void): void;
  /** While recording, every key goes to `onKey` instead of the page or the menus. */
  recordShortcut(recording: boolean): Promise<void>;
  onKey(cb: (key: RecordedKey) => void): void;
  tabs(): Promise<TabsView>;
  editTabs(edit: TabsEdit): Promise<TabsEditResult>;
  /** The native menu for tabs (`tabIds`) or one folder: Move to…, Delete and, with `context`, Rename and Edit Address. */
  tabsMenu(request: { tabIds?: string[]; folderId?: string; context?: boolean }): Promise<TabsMenuAction | undefined>;
  /** The pane redraws whenever the sidebar changes something. */
  onTabs(cb: (view: TabsView) => void): void;
  /** Opens a tab in the browser window. */
  showTab(tabId: string): Promise<void>;
  /** The macOS emoji picker, for a Space's icon. */
  showEmojiPanel(): Promise<void>;
}

export interface FlechaApi {
  onState(cb: (state: UiState) => void): void;
  onPalette(cb: (mode: PaletteMode) => void): void;
  /** Main asks the sidebar to open the Space editor (new Space, menu, shortcut). */
  onEditSpace(cb: (spaceId: string) => void): void;
  /** Main asks the sidebar to start renaming a tab in place. */
  onRenameTab(cb: (tabId: string) => void): void;
  onPeek(cb: (peek: PeekState | null) => void): void;
  /** `started` is set when this update is a new download beginning. */
  onDownloads(cb: (items: DownloadInfo[], started?: DownloadInfo) => void): void;
  ready(): void;
  searchHistory(query: string): Promise<HistoryEntry[]>;
  /** Most visited sites, one per host. */
  topSites(): Promise<HistoryEntry[]>;
  /** An installed app's icon as a data URL, by its name in /Applications. */
  appIcon(name: string): Promise<string | undefined>;
  /** During the welcome tour, shortcuts you press are reported here instead of acting. */
  onTourKey(cb: (command: string) => void): void;
  /** Other browsers with bookmarks or history to import. */
  detectBrowsers(): Promise<DetectedBrowser[]>;
  /** Imports one of the browsers `detectBrowsers` found, by id. */
  importBrowser(id: string): Promise<ImportResult>;
  newTab(input: string): void;
  navigate(input: string): void;
  activate(tabId: string): void;
  close(tabId: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  switchSpace(spaceId: string): void;
  newSpace(): void;
  updateSpace(spaceId: string, patch: { name?: string; emoji?: string; color?: string }): void;
  setSpaceIsolated(spaceId: string, isolated: boolean): void;
  deleteSpace(spaceId: string): void;
  tabMenu(tabId: string): void;
  spaceMenu(spaceId: string): void;
  toggleFolder(folderId: string): void;
  renameFolder(folderId: string, name: string): void;
  moveTab(tabId: string, target: DropTarget): void;
  clearToday(): void;
  /** Brings over the Spaces and tabs of Flecha's Electron version. */
  importMenu(): void;
  openPalette(mode: PaletteMode): void;
  closePalette(): void;
  toggleSidebar(): void;
  setSidebarPeek(peek: boolean): void;
  /** Copies text and says so in the address field: "Link copied" unless `message` says otherwise. */
  copyText(text: string, message?: string): void;
  renameTab(tabId: string, title: string): void;
  toggleMute(tabId: string): void;
  /** Screenshot of the active page, to the clipboard. */
  capturePage(): void;
  clearSiteData(origin: string): void;
  setSitePermission(origin: string, permission: string, decision: 'allow' | 'block' | 'ask'): void;
  zoom(step: 1 | -1 | 0): void;
  openDevTools(): void;
  /** A short confirmation shown in the address bar ("Link copied"). */
  onFlash(cb: (message: string) => void): void;
  openSettings(pane?: string): void;
  toggleResponsive(): void;
  showConsole(tabId: string): void;
  editBoost(kind: 'script' | 'styles'): void;
  openBoostsFolder(): void;
  splitWith(tabId: string): void;
  /** While a tab is dragged, the sidebar UI covers the page so it can be dropped there. */
  setTabDragging(dragging: boolean): void;
  dropToSplit(tabId: string, side: 'left' | 'right'): void;
  splitNew(input: string): void;
  closePeek(): void;
  openDownload(id: string): void;
  revealDownload(id: string): void;
  cancelDownload(id: string): void;
  clearDownloads(): void;
  promotePeek(): void;
  finishOnboarding(): void;
  setPreferences(prefs: { theme?: 'system' | 'light' | 'dark'; searchEngine?: SearchEngineId; adBlock?: boolean }): void;
  makeDefaultBrowser(): void;
  /** An empty Flechinha, for a quick lookup. */
  newFlechinha(): void;
}
