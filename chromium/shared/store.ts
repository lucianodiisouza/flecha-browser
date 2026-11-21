import type {
  ArchivedTab,
  BrowserState,
  ClosedWindow,
  DropTarget,
  Environment,
  FlechaWindow,
  ImportMode,
  PinnedNode,
  SavedSpace,
  SearchEngineId,
  Space,
  TabInfo,
  TabPlacement,
  WindowBounds,
  WindowSpace,
} from './types';
import type { ImportNode, ImportOutcome, ImportSpace, ImportTab } from './importApply';
import { inAgentFolder } from './agentFolder';
import { withAdBlocking } from './adBlockSites';
import { STATE_VERSION } from './savedState';
import { clampSidebarWidth } from './sidebarWidth';

const SPACE_COLORS = ['#cdd9f7', '#f6d6cc', '#d3ecd5', '#e8d6f3', '#f5e7c4', '#cfe8ec'];
const SPACE_EMOJIS = ['🏠', '💼', '🎨', '📚', '🧪', '🎮'];
/** The Space a fresh install starts with. */
const INITIAL_SPACE = { name: 'Personal', emoji: SPACE_EMOJIS[0], color: SPACE_COLORS[0] };

/**
 * A fresh install's Space while still untouched (its first name, emoji and colour, nothing in it
 * and no favorites), which imported Spaces replace instead of joining.
 */
export function pristineSpace(s: Pick<BrowserState, 'spaces' | 'favorites' | 'windows' | 'closedWindows'>): SavedSpace | undefined {
  const only = s.spaces.length === 1 ? s.spaces[0] : undefined;
  const untouched =
    !!only &&
    only.name === INITIAL_SPACE.name &&
    only.emoji === INITIAL_SPACE.emoji &&
    only.color === INITIAL_SPACE.color &&
    !only.isolated &&
    !only.pinned.length &&
    !s.favorites.length &&
    [...s.windows, ...s.closedWindows].every((w) => !w.spaces[only.id]?.today.length);
  return untouched ? only : undefined;
}
export const ARCHIVE_LIMIT = 500;
/** Closed windows kept for reopening: as many entries as Chromium's tab restore keeps (TabRestoreServiceHelper::kMaxEntries). */
const CLOSED_WINDOW_LIMIT = 25;
/** Changes that can be undone, kept as many as closed windows (Chromium's tab restore entries). */
const UNDO_LIMIT = CLOSED_WINDOW_LIMIT;

/** Where a tab is: a favorite, pinned in a Space, or a Today tab of a Space in one window. */
type Location = { space?: SavedSpace; zone: 'today' | 'pinned' | 'favorites'; windowId?: string };

/** Where tabs and folders sit, without the tabs themselves. */
type Layout = Pick<BrowserState, 'spaces' | 'favorites' | 'windows' | 'closedWindows'>;

/** A change one undo takes back whole: delete a Space, close or move several tabs. */
interface UndoStep {
  label: string;
  before: Layout;
  /** The tabs it deleted, as they were. */
  removed: Record<string, TabInfo>;
  /** Their homes, which a move to Today forgets. */
  homes: Record<string, string | undefined>;
  /** The archive entries it made for the tabs it deleted, by tab. */
  archived: Map<string, ArchivedTab>;
  /** Older entries those pushed out of the archive. */
  dropped: ArchivedTab[];
  /** Tabs (`t:<id>`) and folders (`f:<id>`) it moved or deleted, to the list it left each in (none if deleted). */
  touched: Map<string, string | undefined>;
  /** The Spaces it deleted. */
  deletedSpaces: Set<string>;
  /** The splits it ended, as `<window>:<space>`. */
  endedSplits: Set<string>;
  /** The window Spaces it left with no tab on screen, as `<window>:<space>`. */
  leftEmpty: Set<string>;
  /** The windows it switched to another Space, to the Space it switched them to. */
  switched: Map<string, string>;
  /** The closed windows it dropped, as it deleted their last tabs. */
  droppedWindows: Set<string>;
}

/** Where the state lives: a file in Electron, extension storage in the Chromium build. */
export interface StatePersistence {
  load(): BrowserState | undefined;
  save(json: string): void | Promise<void>;
}

const randomUUID = () => crypto.randomUUID();

/** You used the tab just now: it is the most recent, and no longer unseen. */
function used(tab: TabInfo) {
  tab.lastActive = Date.now();
  delete tab.unseen;
}

/**
 * What a change touched: 'tab' is only what one tab shows (its title, icon, address, loading or
 * sound), which never changes which tabs are open or on screen; 'structure' is everything else.
 */
export type StoreChange = 'structure' | 'tab';
/** Only changes with known ownership can skip global layout reconciliation. */
type ChangeDetail =
  | { kind: 'metadata'; tabId: string; keys: (keyof TabInfo)[] }
  | { kind: 'activation'; windowId: string; tabId: string }
  | { kind: 'focus' };
type ChangeListener = (change: StoreChange, detail?: ChangeDetail) => void;

/**
 * Flecha's Spaces, tabs and windows. Spaces, their pinned tabs and the favorites are shared by
 * every window; each window has its own active Space and, per Space, its own Today tabs, tab on
 * screen and split (Arc's window-local temporary tabs). Methods about one window take its id and
 * default to the focused window: the one keyboard shortcuts, Settings and the agent act in.
 */
export class Store {
  state: BrowserState;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private listeners: ChangeListener[] = [];
  /** In memory only: a restart starts without undo. */
  private undoSteps: UndoStep[] = [];
  /** While an undoable change runs: the archive entries it makes, by tab, and what it moves. */
  private recording?: { archived: Map<string, ArchivedTab>; moved: Set<string> };

  constructor(private persistence: StatePersistence) {
    this.state = this.load() ?? this.initialState();
    if (!this.state.windows.length) this.state.windows.push(this.newWindow());
  }

  onChange(fn: ChangeListener) {
    this.listeners.push(fn);
  }

  // ---- windows ----------------------------------------------------------------

  /** The window shortcuts, Settings and the agent act in: the most recently focused one. */
  get focusedWindowId(): string {
    return this.state.windows[0].id;
  }

  /** A window by id, or the focused one. */
  window(windowId?: string): FlechaWindow {
    return (windowId !== undefined && this.state.windows.find((w) => w.id === windowId)) || this.state.windows[0];
  }

  /** Whether a window with this id is open. */
  hasWindow(windowId: string) {
    return this.state.windows.some((w) => w.id === windowId);
  }

  /** A new window, showing `spaceId` or the focused window's Space. It is not focused. */
  openWindow(spaceId?: string): FlechaWindow {
    const win = this.newWindow(spaceId && this.savedSpace(spaceId) ? spaceId : this.window().activeSpaceId);
    this.state.windows.push(win);
    this.changed();
    return win;
  }

  /** Makes a window the focused one. */
  focusWindow(windowId: string) {
    const i = this.state.windows.findIndex((w) => w.id === windowId);
    if (i <= 0) return;
    this.state.windows.unshift(...this.state.windows.splice(i, 1));
    this.changed('structure', true, { kind: 'focus' });
  }

  /**
   * A window closed: it goes to the closed windows with its Today tabs, to be reopened. The last
   * open window stays, so the next start shows it again (closing it quits the browser).
   * Returns the ids of tabs dropped for good because too many windows were closed.
   */
  closeWindow(windowId: string): string[] {
    const i = this.state.windows.findIndex((w) => w.id === windowId);
    if (i < 0 || this.state.windows.length === 1) return [];
    const [win] = this.state.windows.splice(i, 1);
    // Pinned tabs and favorites it showed stay in the other windows' sidebars; only its Today tabs go with it.
    const closed: ClosedWindow = { ...win, spaces: {}, closedAt: Date.now() };
    // It comes back on a Today tab of its own: the one it showed, or the one used last.
    const recent = (ids: string[]) => [...ids].sort((a, b) => (this.state.tabs[b]?.lastActive ?? 0) - (this.state.tabs[a]?.lastActive ?? 0))[0];
    for (const [spaceId, ws] of Object.entries(win.spaces)) {
      if (ws.today.length) closed.spaces[spaceId] = { today: ws.today, activeTabId: ws.today.includes(ws.activeTabId!) ? ws.activeTabId : recent(ws.today) };
    }
    const dropped: string[] = [];
    if (Object.keys(closed.spaces).length) {
      this.state.closedWindows.unshift(closed);
      for (const old of this.state.closedWindows.splice(CLOSED_WINDOW_LIMIT)) {
        for (const ws of Object.values(old.spaces)) for (const id of ws.today) dropped.push(id);
      }
      for (const id of dropped) {
        this.archive(this.state.tabs[id]);
        delete this.state.tabs[id];
      }
    }
    this.changed();
    return dropped;
  }

  /** When the most recently closed window was closed, if any is left to reopen. */
  lastClosedWindowAt(): number | undefined {
    return this.state.closedWindows[0]?.closedAt;
  }

  /** Opens the most recently closed window again, with its Today tabs, focused. */
  reopenWindow(): FlechaWindow | undefined {
    const closed = this.state.closedWindows.shift();
    if (!closed) return undefined;
    const { closedAt: _closedAt, ...win } = closed;
    // Its Spaces may have been deleted since.
    for (const spaceId of Object.keys(win.spaces)) if (!this.savedSpace(spaceId)) delete win.spaces[spaceId];
    if (!this.savedSpace(win.activeSpaceId)) win.activeSpaceId = this.state.spaces[0].id;
    this.state.windows.unshift(win);
    this.changed();
    return win;
  }

  /** A Space as `windowId` shows it. */
  view(space: SavedSpace, windowId?: string): Space {
    return { ...space, ...this.windowSpace(space.id, windowId) };
  }

  /** Every Space as one window shows it, and its active Space: what that window's pages draw. */
  windowView(windowId?: string): { windowId: string; activeSpaceId: string; spaces: Space[] } {
    const win = this.window(windowId);
    return { windowId: win.id, activeSpaceId: this.activeSpaceIn(win.id).id, spaces: this.state.spaces.map((s) => this.view(s, win.id)) };
  }

  // ---- what a window shows --------------------------------------------------------

  /** The focused window's active Space. */
  get activeSpace(): Space {
    return this.activeSpaceIn();
  }

  activeSpaceIn(windowId?: string): Space {
    const win = this.window(windowId);
    return this.view(this.savedSpace(win.activeSpaceId) ?? this.state.spaces[0], win.id);
  }

  /** The focused window's active tab. */
  get activeTab(): TabInfo | undefined {
    return this.activeTabIn();
  }

  activeTabIn(windowId?: string): TabInfo | undefined {
    const id = this.activeSpaceIn(windowId).activeTabId;
    return id ? this.state.tabs[id] : undefined;
  }

  /** Favorites, then the Space's pinned tabs, then its Today tabs in the window. */
  allTabIds(space: Pick<SavedSpace, 'id' | 'pinned'>, windowId?: string): string[] {
    return [...this.state.favorites, ...pinnedTabIds(space.pinned), ...this.windowSpace(space.id, windowId).today];
  }

  /** The tabs on screen in a window right now: the active tab, or both halves of its split. */
  visibleTabIds(windowId?: string): string[] {
    const space = this.activeSpaceIn(windowId);
    const active = space.activeTabId;
    if (!active) return [];
    return space.split?.includes(active) ? [...space.split] : [active];
  }

  /** The open window whose active Space has this tab on screen, if any. */
  windowShowing(tabId: string): string | undefined {
    return this.state.windows.find((w) => this.visibleTabIds(w.id).includes(tabId))?.id;
  }

  locate(tabId: string): Location | undefined {
    if (this.state.favorites.includes(tabId)) return { zone: 'favorites' };
    for (const space of this.state.spaces) if (pinnedTabIds(space.pinned).includes(tabId)) return { space, zone: 'pinned' };
    for (const win of this.state.windows) {
      for (const [spaceId, ws] of Object.entries(win.spaces)) {
        if (ws.today.includes(tabId)) return { space: this.savedSpace(spaceId), zone: 'today', windowId: win.id };
      }
    }
    return undefined;
  }

  /** The tabs a window can show or switch to: all but closed windows' Today tabs, which wait for their window to reopen. */
  openTabs(): Record<string, TabInfo> {
    const open = new Set(this.state.favorites);
    for (const space of this.state.spaces) {
      for (const id of pinnedTabIds(space.pinned)) open.add(id);
    }
    for (const win of this.state.windows) {
      for (const space of Object.values(win.spaces)) {
        for (const id of space.today) open.add(id);
      }
    }
    return Object.fromEntries(Object.entries(this.state.tabs).filter(([id]) => open.has(id)));
  }

  // ---- tabs -----------------------------------------------------------------

  addTab(url: string, opts: { activate?: boolean; afterTabId?: string; windowId?: string; agent?: boolean } = {}): TabInfo {
    const tab: TabInfo = { id: randomUUID(), url, title: url, lastActive: Date.now() };
    if (opts.activate === false) tab.unseen = true;
    if (opts.agent) tab.agent = true;
    this.state.tabs[tab.id] = tab;
    const win = this.window(opts.windowId);
    const ws = this.windowSpace(win.activeSpaceId, win.id);
    const after = opts.afterTabId ? ws.today.indexOf(opts.afterTabId) : -1;
    ws.today.splice(after + 1, 0, tab.id);
    if (opts.activate !== false) ws.activeTabId = tab.id;
    this.changed();
    return tab;
  }

  /**
   * Shows a tab. A Today tab shows in its own window; a pinned tab or favorite in the window that
   * asks (default: the focused one), leaving any other window that showed it. `recent: false`
   * passes through the tab without making it the most recently used. Returns the window it shows in.
   */
  activate(tabId: string, opts: { recent?: boolean; windowId?: string } = {}): string | undefined {
    const tab = this.state.tabs[tabId];
    const loc = this.locate(tabId);
    if (!tab || !loc) return undefined;
    const win = this.window(loc.windowId ?? opts.windowId);
    if (loc.space) win.activeSpaceId = loc.space.id;
    if (loc.zone !== 'today') this.claim(tabId, win);
    this.windowSpace(win.activeSpaceId, win.id).activeTabId = tabId;
    if (opts.recent !== false) used(tab);
    // Claiming a shared tab can end splits in other windows.
    this.changed('structure', true, loc.zone === 'today' ? { kind: 'activation', windowId: win.id, tabId } : undefined);
    return win.id;
  }

  /** Makes a tab the most recently used. */
  touch(tabId: string) {
    const tab = this.state.tabs[tabId];
    if (!tab) return;
    used(tab);
    this.changed('tab', true, { kind: 'metadata', tabId, keys: ['lastActive', 'unseen'] });
  }

  /**
   * `ids` from the most recently used, as Control-Tab goes through them. Tabs you haven't seen
   * yet (opened in the background) come after every tab you have used, newest first.
   */
  byRecency(ids: string[]): string[] {
    const tab = (id: string) => this.state.tabs[id];
    return [...ids].sort((a, b) => Number(!!tab(a)?.unseen) - Number(!!tab(b)?.unseen) || (tab(b)?.lastActive ?? 0) - (tab(a)?.lastActive ?? 0));
  }

  updateTab(tabId: string, patch: Partial<TabInfo>) {
    const tab = this.state.tabs[tabId];
    if (!tab) return;
    const keys = (Object.keys(patch) as Array<keyof TabInfo>).filter((k) => tab[k] !== patch[k]);
    if (!keys.length) return;
    const persist = keys.some((k) => k !== 'loading' && k !== 'audible');
    Object.assign(tab, patch);
    this.changed('tab', persist, { kind: 'metadata', tabId, keys });
  }

  /**
   * Today tabs are archived and removed. Pinned tabs and favorites stay in the
   * sidebar and only unload, going back to their home URL (Arc's behaviour).
   */
  closeTab(tabId: string): 'removed' | 'unloaded' {
    const tab = this.state.tabs[tabId];
    const loc = this.locate(tabId);
    if (!tab || !loc) return 'removed';

    if (loc.zone !== 'today') {
      if (tab.homeUrl) tab.url = tab.homeUrl;
      delete tab.history;
      for (const win of this.state.windows) for (const ws of Object.values(win.spaces)) if (ws.activeTabId === tabId) ws.activeTabId = undefined;
      this.changed();
      return 'unloaded';
    }

    const ws = this.windowSpace(loc.space!.id, loc.windowId);
    const index = ws.today.indexOf(tabId);
    ws.today.splice(index, 1);
    this.archive(tab);
    delete this.state.tabs[tabId];
    if (ws.activeTabId === tabId) ws.activeTabId = ws.today[Math.min(index, ws.today.length - 1)];
    this.changed();
    return 'removed';
  }

  /** Moves a tab between favorites, pinned (optionally into a folder) and today, in a window's active Space. */
  moveTab(tabId: string, target: DropTarget, windowId?: string) {
    const tab = this.state.tabs[tabId];
    const from = this.locate(tabId);
    if (!tab || !from || target.beforeTabId === tabId) return;
    const win = this.window(windowId);
    const targetSpace = this.savedSpace(win.activeSpaceId) ?? this.state.spaces[0];

    this.detachEverywhere(tabId);
    const insert = (list: string[]) => {
      const i = target.beforeTabId ? list.indexOf(target.beforeTabId) : -1;
      list.splice(i < 0 ? list.length : i, 0, tabId);
    };

    if (target.zone === 'favorites') {
      insert(this.state.favorites);
    } else if (target.zone === 'today') {
      insert(this.windowSpace(targetSpace.id, win.id).today);
    } else {
      const parent = target.folderId ? findFolder(targetSpace.pinned, target.folderId)?.children : undefined;
      const list = parent ?? (target.beforeTabId ? findParentList(targetSpace.pinned, target.beforeTabId) : undefined) ?? targetSpace.pinned;
      const i = target.beforeTabId ? list.findIndex((n) => n.kind === 'tab' && n.tabId === target.beforeTabId) : -1;
      list.splice(i < 0 ? list.length : i, 0, { kind: 'tab', tabId });
    }

    if (target.zone === 'today') delete tab.homeUrl;
    else tab.homeUrl ??= tab.url;
    // A tab you moved yourself is yours now, out of the agent's folder.
    delete tab.agent;
    this.forgetMissingActive();
    this.changed();
  }

  /**
   * Moves a tab anywhere, in any Space (Settings' tab manager); a Today tab goes to that Space in
   * `windowId`. Unlike `moveTab`, the target names its Space. Returns whether it moved.
   */
  placeTab(tabId: string, to: TabPlacement, windowId?: string): boolean {
    const tab = this.state.tabs[tabId];
    if (!tab || !this.locate(tabId) || to.beforeId === tabId || !this.placementExists(to)) return false;
    this.detachEverywhere(tabId);
    this.insert(tabId, to, windowId);
    if (to.zone === 'today') delete tab.homeUrl;
    else tab.homeUrl ??= tab.url;
    delete tab.agent;
    this.forgetMissingActive();
    this.changed();
    return true;
  }

  /** A new pinned tab, favorite or Today tab (of `windowId`) that isn't opened yet. */
  createTab(url: string, title: string, to: TabPlacement, windowId?: string): TabInfo | undefined {
    if (!this.placementExists(to)) return undefined;
    const tab: TabInfo = { id: randomUUID(), url, title: title || url, lastActive: Date.now(), unseen: true };
    if (to.zone !== 'today') tab.homeUrl = url;
    this.state.tabs[tab.id] = tab;
    this.insert(tab.id, to, windowId);
    this.changed();
    return tab;
  }

  /**
   * Deletes tabs for good, wherever they are: pinned tabs and favorites too, which
   * `closeTab` only unloads. They go to the archive, so they can still be found. Returns the removed ids.
   */
  removeTabs(tabIds: string[]): string[] {
    const removed = tabIds.filter((id) => this.state.tabs[id] && this.locate(id));
    if (!removed.length) return [];
    return this.undoable(`Delete ${plural(removed.length, 'Tab')}`, () => {
      for (const id of removed) {
        this.detachEverywhere(id);
        this.archive(this.state.tabs[id]);
        delete this.state.tabs[id];
      }
      this.forgetMissingActive();
      this.changed();
      return removed;
    });
  }

  // ---- split view -----------------------------------------------------------------

  /** Puts `tabId` next to the window's active tab, on the right unless `side` says otherwise. */
  splitWith(tabId: string, side: 'left' | 'right' = 'right', windowId?: string) {
    const win = this.window(windowId);
    const ws = this.windowSpace(win.activeSpaceId, win.id);
    const current = ws.activeTabId;
    const space = this.savedSpace(win.activeSpaceId);
    if (!space || !current || current === tabId || !this.allTabIds(space, win.id).includes(tabId)) return;
    // A pinned tab or favorite on screen elsewhere comes here, as when it's activated.
    this.claim(tabId, win);
    ws.split = side === 'left' ? [tabId, current] : [current, tabId];
    delete ws.splitMode;
    ws.activeTabId = tabId;
    used(this.state.tabs[tabId]);
    this.changed();
  }

  /** Opens the active page again as a phone-sized mirror, side by side. Returns the mirror's id. */
  openResponsive(windowId?: string): string | undefined {
    const win = this.window(windowId);
    const ws = this.windowSpace(win.activeSpaceId, win.id);
    const source = this.activeTabIn(win.id);
    if (!source) return undefined;
    const mirror = this.addTab(source.url, { activate: false, afterTabId: ws.today.includes(source.id) ? source.id : undefined, windowId: win.id });
    mirror.device = 'mobile';
    mirror.title = source.title;
    ws.split = [source.id, mirror.id];
    ws.splitMode = 'responsive';
    this.changed();
    return mirror.id;
  }

  setSplitRatio(ratio: number, windowId?: string) {
    const win = this.window(windowId);
    const ws = this.windowSpace(win.activeSpaceId, win.id);
    if (!ws.split) return;
    ws.splitRatio = Math.min(0.8, Math.max(0.2, ratio));
    this.changed();
  }

  /** Ends the window's split. A responsive mirror has no life of its own, so its id is returned for closing. */
  unsplit(windowId?: string): string | undefined {
    const win = this.window(windowId);
    const ws = this.windowSpace(win.activeSpaceId, win.id);
    if (!ws.split) return undefined;
    const mirror = ws.splitMode === 'responsive' ? ws.split[1] : undefined;
    delete ws.split;
    delete ws.splitMode;
    this.changed();
    return mirror;
  }

  /** Moves a tab into another Space (pinned tabs keep being pinned there, Today tabs stay in their window). */
  moveToSpace(tabId: string, spaceId: string) {
    const from = this.locate(tabId);
    const to = this.savedSpace(spaceId);
    if (!from?.space || !to || from.space === to) return;
    const win = this.window(from.windowId);
    const fromWs = this.windowSpace(from.space.id, win.id);
    this.detachEverywhere(tabId);
    if (from.zone === 'pinned') to.pinned.push({ kind: 'tab', tabId });
    else this.windowSpace(to.id, win.id).today.unshift(tabId);
    delete this.state.tabs[tabId].agent;
    if (fromWs.activeTabId === tabId) fromWs.activeTabId = fromWs.today[0];
    this.forgetMissingActive();
    this.changed();
  }

  /**
   * Closes the today tabs after `tabId`, or all others when `others` is set, among the tabs listed
   * with it: Today's or the agent's folder. Returns their ids.
   */
  closeTodayTabs(tabId: string, which: 'below' | 'others'): string[] {
    const loc = this.locate(tabId);
    if (loc?.zone !== 'today' || !loc.space) return [];
    const ws = this.windowSpace(loc.space.id, loc.windowId);
    const folder = inAgentFolder(this.state.tabs, ws, tabId);
    const today = ws.today.filter((id) => inAgentFolder(this.state.tabs, ws, id) === folder);
    const index = today.indexOf(tabId);
    const ids = today.filter((id, i) => (which === 'below' ? i > index : id !== tabId));
    if (!ids.length) return [];
    return this.undoable(which === 'below' ? 'Close Tabs Below' : 'Close Other Tabs', () => {
      for (const id of ids) this.closeTab(id);
      return ids;
    });
  }

  togglePin(tabId: string, windowId?: string) {
    const loc = this.locate(tabId);
    this.moveTab(tabId, { zone: loc?.zone === 'today' ? 'pinned' : 'today' }, loc?.windowId ?? windowId);
  }

  toggleFavorite(tabId: string, windowId?: string) {
    const loc = this.locate(tabId);
    this.moveTab(tabId, { zone: loc?.zone === 'favorites' ? 'today' : 'favorites' }, loc?.windowId ?? windowId);
  }

  // ---- folders --------------------------------------------------------------------

  /** In the window's active Space unless `where` names another, optionally inside a folder. Returns the new folder's id. */
  newFolder(name = 'New Folder', where: { spaceId?: string; parentId?: string } = {}, windowId?: string): string | undefined {
    const space = this.savedSpace(where.spaceId ?? this.window(windowId).activeSpaceId);
    const list = where.parentId ? (space && findFolder(space.pinned, where.parentId))?.children : space?.pinned;
    if (!list) return undefined;
    const id = randomUUID();
    list.push({ kind: 'folder', id, name: name.trim().slice(0, 80) || 'New Folder', open: true, children: [] });
    this.changed();
    return id;
  }

  toggleFolder(folderId: string) {
    const folder = this.findFolder(folderId)?.folder;
    if (!folder) return;
    folder.open = !folder.open;
    this.changed();
  }

  renameFolder(folderId: string, name: string) {
    const folder = this.findFolder(folderId)?.folder;
    if (!folder || !name.trim()) return;
    folder.name = name.trim();
    this.changed();
  }

  /**
   * Removes a folder. Its tabs (and subfolders) take its place when `keepTabs` is set;
   * otherwise they are deleted too. Returns the ids of deleted tabs.
   */
  deleteFolder(folderId: string, keepTabs: boolean): string[] {
    const found = this.findFolder(folderId);
    if (!found) return [];
    const { folder, parent } = found;
    return this.undoable(`Delete “${folder.name}”`, () => {
      parent.splice(parent.indexOf(folder), 1, ...(keepTabs ? folder.children : []));
      const removed = keepTabs ? [] : pinnedTabIds(folder.children);
      for (const id of removed) {
        this.archive(this.state.tabs[id]);
        delete this.state.tabs[id];
      }
      this.forgetMissingActive();
      this.changed();
      return removed;
    });
  }

  /** Moves a folder within the pinned tabs of any Space; never into itself. Returns whether it moved. */
  moveFolder(folderId: string, to: { spaceId: string; folderId?: string; beforeId?: string }): boolean {
    const found = this.findFolder(folderId);
    const space = this.savedSpace(to.spaceId);
    if (!found || !space || to.beforeId === folderId) return false;
    if (to.folderId && (to.folderId === folderId || findFolder(found.folder.children, to.folderId))) return false;
    const list = to.folderId ? findFolder(space.pinned, to.folderId)?.children : space.pinned;
    if (!list) return false;
    found.parent.splice(found.parent.indexOf(found.folder), 1);
    this.recording?.moved.add(`f:${folderId}`);
    const i = to.beforeId ? list.findIndex((n) => nodeId(n) === to.beforeId) : -1;
    list.splice(i < 0 ? list.length : i, 0, found.folder);
    this.forgetMissingActive();
    this.changed();
    return true;
  }

  // ---- Spaces ---------------------------------------------------------------------

  /** Switches the window to the new Space unless `activate` is false (Settings adds one without leaving the current Space). */
  newSpace(activate = true, windowId?: string): Space {
    const n = this.state.spaces.length;
    const space: SavedSpace = {
      id: randomUUID(),
      name: `Space ${n + 1}`,
      emoji: SPACE_EMOJIS[n % SPACE_EMOJIS.length],
      color: SPACE_COLORS[n % SPACE_COLORS.length],
      pinned: [],
    };
    this.state.spaces.push(space);
    if (activate) this.window(windowId).activeSpaceId = space.id;
    this.changed();
    return this.view(space, windowId);
  }

  /** Reorders the Spaces: `spaceId` goes before `beforeSpaceId`, or last. */
  moveSpace(spaceId: string, beforeSpaceId?: string) {
    const space = this.savedSpace(spaceId);
    if (!space || beforeSpaceId === spaceId) return;
    const spaces = this.state.spaces.filter((s) => s !== space);
    const i = beforeSpaceId ? spaces.findIndex((s) => s.id === beforeSpaceId) : -1;
    spaces.splice(i < 0 ? spaces.length : i, 0, space);
    this.state.spaces = spaces;
    this.changed();
  }

  /** Name, emoji and colour. Invalid values are ignored rather than stored. */
  updateSpace(spaceId: string, patch: { name?: string; emoji?: string; color?: string }) {
    const space = this.savedSpace(spaceId);
    if (!space) return;
    const name = typeof patch.name === 'string' ? patch.name.trim().slice(0, 40) : '';
    if (name) space.name = name;
    if (typeof patch.emoji === 'string') space.emoji = [...patch.emoji.trim()].slice(0, 2).join('') || undefined;
    if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) space.color = patch.color.toLowerCase();
    this.changed();
  }

  /** Deletes a Space, archiving its pinned tabs and every window's Today tabs in it. Returns the ids of those tabs, so their views can be destroyed. */
  deleteSpace(spaceId: string): string[] {
    if (this.state.spaces.length < 2) return [];
    const space = this.savedSpace(spaceId);
    if (!space) return [];
    return this.undoable(`Delete “${space.name}”`, () => {
      const ids = [...pinnedTabIds(space.pinned)];
      for (const win of [...this.state.windows, ...this.state.closedWindows]) {
        ids.push(...(win.spaces[spaceId]?.today ?? []));
        delete win.spaces[spaceId];
      }
      for (const id of ids) {
        this.archive(this.state.tabs[id]);
        delete this.state.tabs[id];
      }
      this.state.spaces = this.state.spaces.filter((s) => s !== space);
      for (const win of [...this.state.windows, ...this.state.closedWindows]) if (win.activeSpaceId === spaceId) win.activeSpaceId = this.state.spaces[0].id;
      this.state.closedWindows = this.state.closedWindows.filter((w) => Object.keys(w.spaces).length);
      this.changed();
      return ids;
    });
  }

  /** Returns the Space's tab ids in every open window: their pages must be reopened in the new session. */
  setIsolated(spaceId: string, isolated: boolean): string[] {
    const space = this.savedSpace(spaceId);
    if (!space) return [];
    space.isolated = isolated;
    this.changed();
    return [...pinnedTabIds(space.pinned), ...this.state.windows.flatMap((w) => w.spaces[spaceId]?.today ?? [])];
  }

  switchSpace(spaceId: string, windowId?: string) {
    if (!this.savedSpace(spaceId)) return;
    this.window(windowId).activeSpaceId = spaceId;
    this.changed();
  }

  /**
   * Archives every Today tab in the window's active Space, leaving the agent's folder, which has a
   * Clear of its own. Returns the removed ids.
   */
  clearToday(windowId?: string): string[] {
    const win = this.window(windowId);
    const ws = this.windowSpace(win.activeSpaceId, win.id);
    const ids = ws.today.filter((id) => !inAgentFolder(this.state.tabs, ws, id));
    if (!ids.length) return [];
    return this.undoable('Clear Today Tabs', () => {
      ws.today = ws.today.filter((id) => !ids.includes(id));
      for (const id of ids) {
        this.archive(this.state.tabs[id]);
        delete this.state.tabs[id];
      }
      if (ws.activeTabId && ids.includes(ws.activeTabId)) ws.activeTabId = undefined;
      this.forgetMissingActive();
      this.changed();
      return ids;
    });
  }

  /** Arc's auto-archive: Today tabs untouched for a while go away on their own, in every open window. */
  archiveStale(): string[] {
    const hours = this.state.archiveAfterHours ?? 12;
    if (hours === 0) return [];
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const removed: string[] = [];
    for (const win of this.state.windows) {
      for (const ws of Object.values(win.spaces)) {
        ws.today = ws.today.filter((id) => {
          const tab = this.state.tabs[id];
          if (!tab || id === ws.activeTabId || tab.lastActive >= cutoff) return true;
          this.archive(tab);
          delete this.state.tabs[id];
          removed.push(id);
          return false;
        });
      }
    }
    if (removed.length) {
      this.forgetMissingActive();
      this.changed();
    }
    return removed;
  }

  popArchive() {
    const item = this.state.archive.shift();
    if (!item) return item;
    // Reopening a closed tab takes it out of what undo would bring back, so it isn't open twice.
    for (const step of this.undoSteps) {
      for (const [id, entry] of step.archived) {
        if (entry !== item) continue;
        delete step.removed[id];
        step.archived.delete(id);
      }
    }
    this.changed();
    return item;
  }

  // ---- preferences ----------------------------------------------------------------

  setSearchEngine(id: SearchEngineId) {
    this.state.searchEngine = id;
    this.changed();
  }

  setEnvironments(environments: Environment[]) {
    this.state.environments = environments;
    this.changed();
  }

  setDownloads(options: { folder?: string; askWhereToSave?: boolean }) {
    if (options.folder !== undefined) this.state.downloadsFolder = options.folder;
    if (options.askWhereToSave !== undefined) this.state.askWhereToSave = options.askWhereToSave;
    this.changed();
  }

  setAgent(agent: { enabled: boolean; token: string }) {
    this.state.agent = agent;
    this.changed();
  }

  sitePermission(origin: string, permission: string) {
    return this.state.sitePermissions?.[origin]?.[permission];
  }

  /** `undefined` forgets the decision, so the site asks again next time. */
  setSitePermission(origin: string, permission: string, decision: 'allow' | 'block' | undefined) {
    const all = (this.state.sitePermissions ??= {});
    const site = (all[origin] ??= {});
    if (decision) site[permission] = decision;
    else delete site[permission];
    if (!Object.keys(site).length) delete all[origin];
    this.changed();
  }

  setPreferences(prefs: { theme?: 'system' | 'light' | 'dark'; peekPinnedLinks?: boolean }) {
    if (prefs.theme && ['system', 'light', 'dark'].includes(prefs.theme)) this.state.theme = prefs.theme;
    if (typeof prefs.peekPinnedLinks === 'boolean') this.state.peekPinnedLinks = prefs.peekPinnedLinks;
    this.changed();
  }

  setOnboarded(done: boolean) {
    this.state.onboarded = done;
    this.changed();
  }

  setOpenLinksInFlechinha(enabled: boolean) {
    if (typeof enabled === 'boolean') this.state.openLinksInFlechinha = enabled;
    this.changed();
  }

  setSidebarInPageFullscreen(show: boolean) {
    if (typeof show === 'boolean') this.state.sidebarInPageFullscreen = show;
    this.changed();
  }

  setArchiveAfter(hours: number) {
    this.state.archiveAfterHours = Math.max(0, hours);
    this.changed();
  }

  /** `keys`: an accelerator, null for none, or undefined to go back to the default. */
  setKeybinding(id: string, keys: string | null | undefined) {
    const all = (this.state.keybindings ??= {});
    if (keys === undefined) delete all[id];
    else all[id] = keys;
    this.changed();
  }

  resetKeybindings() {
    delete this.state.keybindings;
    this.changed();
  }

  setAdBlock(enabled: boolean) {
    this.state.adBlock = enabled;
    this.changed();
  }

  /** The site panel's shield: blocking on or off for one hostname (adBlockSites.ts). */
  setAdBlockOn(host: string, block: boolean) {
    // Kept as [] when empty: incognito windows follow only the keys the regular state has.
    this.state.adBlockAllowed = withAdBlocking(this.state.adBlockAllowed, host, block);
    this.changed();
  }

  /** Saved without notifying listeners: nothing on screen depends on it. */
  setWindowBounds(bounds: WindowBounds) {
    this.state.window = bounds;
    this.scheduleSave();
  }

  /** Shows or hides one window's sidebar; windows opened later start the same way. */
  setSidebarVisible(visible: boolean, windowId?: string) {
    // The other windows keep what they showed.
    for (const win of this.state.windows) win.sidebarVisible ??= this.state.sidebarVisible;
    this.window(windowId).sidebarVisible = visible;
    this.state.sidebarVisible = visible;
    this.changed();
  }

  sidebarVisibleIn(windowId?: string): boolean {
    return this.window(windowId).sidebarVisible ?? this.state.sidebarVisible;
  }

  /** The sidebar's width, the same in every window. */
  setSidebarWidth(width: number) {
    this.state.sidebarWidth = clampSidebarWidth(width);
    this.changed();
  }

  // ---- imports --------------------------------------------------------------------

  /**
   * Another browser's Spaces (Arc's, or one Space of bookmarks) come over; their Today tabs open
   * in `windowId`. With `merge`, a Space joins the Space of the same name Flecha already had, and tabs
   * whose address that Space (or the favorites) had are left out; with `append`, each is new.
   * Favorites already there are never added twice. A split of two tabs becomes the Space's split
   * when it has none yet; other splits stay as their tabs, side by side.
   */
  importSpaces(spaces: ImportSpace[], opts: { mode: ImportMode; favorites?: ImportTab[]; archive?: ArchivedTab[]; windowId?: string }): ImportOutcome {
    const s = this.state;
    const pristine = spaces.length > 0 && this.dropPristineSpace();
    const win = this.window(opts.windowId);
    const out: ImportOutcome = { spaces: 0, merged: 0, tabs: 0, splits: 0, pairs: 0, archived: 0, archiveDropped: 0 };
    // Where a favorite is and where it started, as for pinned tabs.
    const favoriteUrls = new Set(s.favorites.flatMap((id) => (s.tabs[id] ? [s.tabs[id].url, s.tabs[id].homeUrl] : [])));
    let first: string | undefined;

    // Favorites first, so a merged Space leaves out the tabs they already hold.
    for (const fav of opts.favorites ?? []) {
      if (favoriteUrls.has(fav.url)) continue;
      favoriteUrls.add(fav.url);
      s.favorites.push(this.importTab(fav, true));
      out.tabs++;
    }

    // Merge joins Spaces Flecha had before the import, and leaves out the addresses they had then.
    // Imported Spaces never join each other, so two of the same name stay two, as in the other browser.
    const before = new Map<string, { space: SavedSpace; urls: string[] }>();
    if (opts.mode === 'merge') {
      for (const sp of s.spaces) {
        const key = sp.name.trim().toLowerCase();
        if (!before.has(key)) before.set(key, { space: sp, urls: this.spaceTabUrls(sp) });
      }
    }

    for (const imported of spaces) {
      const match = before.get(imported.name.trim().toLowerCase());
      let space = match?.space;
      if (space) out.merged++;
      else {
        const n = s.spaces.length;
        space = {
          id: randomUUID(),
          name: imported.name,
          emoji: imported.emoji ?? SPACE_EMOJIS[n % SPACE_EMOJIS.length],
          color: imported.color ?? SPACE_COLORS[n % SPACE_COLORS.length],
          pinned: [],
          // Only a new Space: an existing one keeps its cookies and logins as they are.
          ...(imported.isolated ? { isolated: true } : {}),
        };
        s.spaces.push(space);
        out.spaces++;
      }
      first ??= space.id;
      // Repeats within the import stay, as Append keeps them.
      const known = opts.mode === 'merge' ? new Set([...favoriteUrls, ...(match?.urls ?? [])]) : undefined;
      const add = (t: ImportTab) => {
        if (known?.has(t.url)) return false;
        out.tabs++;
        return true;
      };
      const had = new Set(this.allTabIds(space, win.id));
      // Folders join only inside a Space Flecha had; a new Space keeps the other browser's folders as they were.
      this.mergeNodes(space.pinned, imported.pinned, add, !!match);
      const ws = this.windowSpace(space.id, win.id);
      for (const t of imported.today) if (add(t)) ws.today.push(this.importTab(t, false));

      // Each half is a different tab with that address, one this import added when there is one.
      // A pinned tab or favorite on screen in another window stays there; the split stays as tabs.
      const shownElsewhere = (id: string) =>
        s.windows.some((w) => w !== win && Object.values(w.spaces).some((o) => o.activeTabId === id || o.split?.includes(id)));
      const tabByUrl = (url: string, taken?: string) => {
        const ids = this.allTabIds(space, win.id).filter((id) => id !== taken && s.tabs[id]?.url === url && !shownElsewhere(id));
        return ids.find((id) => !had.has(id)) ?? ids[0];
      };
      for (const urls of imported.splits ?? []) {
        const left = tabByUrl(urls[0]);
        const right = urls.length === 2 ? tabByUrl(urls[1], left) : undefined;
        if (urls.length === 2 && !ws.split && left && right) {
          ws.split = [left, right];
          out.splits++;
        } else out.pairs++;
      }
    }

    if (opts.archive?.length) {
      const merged = mergeArchive(s.archive, opts.archive);
      s.archive = merged.archive;
      out.archived = merged.added;
      out.archiveDropped = merged.dropped;
    }
    if (first) this.afterImport(pristine, first);
    this.changed();
    return out;
  }

  /** Takes on preferences (theme, search engine…) changed elsewhere, keeping the tabs and undo. */
  followPreferences(prefs: Partial<BrowserState>) {
    Object.assign(this.state, prefs);
    this.changed();
  }

  /** Takes over another Flecha's whole state (its Spaces, tabs and settings), as if it had been loaded. */
  replaceState(state: BrowserState): boolean {
    if (!state?.spaces?.length || !state.tabs || !state.windows?.length) return false;
    this.state = state;
    // Undo steps name places in the state they came from.
    this.undoSteps = [];
    this.changed();
    return true;
  }

  // ---- undo -----------------------------------------------------------------------

  /** What `undo` would take back ("Delete “Work”"), if anything. */
  get undoLabel(): string | undefined {
    return this.undoSteps.at(-1)?.label;
  }

  /** Runs a change that one undo takes back whole. A change inside another one joins it. */
  undoable<T>(label: string, change: () => T): T {
    if (this.recording) return change();
    const before = structuredClone({ spaces: this.state.spaces, favorites: this.state.favorites, windows: this.state.windows, closedWindows: this.state.closedWindows });
    const tabs = { ...this.state.tabs };
    // Moving a tab to Today forgets its home, so keep each one.
    const homes = Object.fromEntries(Object.entries(tabs).map(([id, tab]) => [id, tab.homeUrl]));
    const archive = [...this.state.archive];
    const { archived, moved } = (this.recording = { archived: new Map(), moved: new Set() });
    let result: T;
    try {
      result = change();
    } finally {
      this.recording = undefined;
    }
    const after = listsOf(this.state);
    const leftIn = listOfEach(after);
    const touched = new Map([...changedPlaces(listsOf(before), after, moved)].map((key) => [key, leftIn.get(key)]));
    const deletedSpaces = new Set(before.spaces.filter((s) => !this.savedSpace(s.id)).map((s) => s.id));
    if (touched.size || deletedSpaces.size) {
      const removed = Object.fromEntries(Object.entries(tabs).filter(([id]) => !this.state.tabs[id]));
      const kept = new Set(this.state.archive);
      const dropped = archive.filter((a) => !kept.has(a));
      const endedSplits = new Set<string>();
      const leftEmpty = new Set<string>();
      const switched = new Map<string, string>();
      for (const win of [...before.windows, ...before.closedWindows]) {
        const now = windowIn(this.state, win.id);
        if (now && now.activeSpaceId !== win.activeSpaceId) switched.set(win.id, now.activeSpaceId);
        for (const [spaceId, ws] of Object.entries(win.spaces)) {
          if (ws.split && !now?.spaces[spaceId]?.split) endedSplits.add(`${win.id}:${spaceId}`);
          if (ws.activeTabId && !now?.spaces[spaceId]?.activeTabId) leftEmpty.add(`${win.id}:${spaceId}`);
        }
      }
      const droppedWindows = new Set(before.closedWindows.filter((w) => !windowIn(this.state, w.id)).map((w) => w.id));
      this.undoSteps.push({ label, before, removed, homes, archived, dropped, touched, deletedSpaces, endedSplits, leftEmpty, switched, droppedWindows });
      this.undoSteps.splice(0, this.undoSteps.length - UNDO_LIMIT);
      this.changed();
    }
    return result;
  }

  /**
   * Takes back the last undoable change: deleted Spaces, folders and tabs come back, and what it
   * moved goes back, each after what it followed before. Changes made since stay. Returns its label.
   */
  undo(): string | undefined {
    const step = this.undoSteps.pop();
    if (!step) return undefined;
    const { before } = step;
    // Their pages closed with them: nothing is loading or playing.
    for (const [id, { loading, audible, ...tab }] of Object.entries(step.removed)) this.state.tabs[id] ??= tab;

    const restoredSpaces = new Set<string>();
    before.spaces.forEach((space, i) => {
      if (!step.deletedSpaces.has(space.id) || this.savedSpace(space.id)) return;
      const previous = before.spaces.slice(0, i).map((s) => this.state.spaces.findIndex((n) => n.id === s.id));
      this.state.spaces.splice(Math.max(-1, ...previous) + 1, 0, { ...space, pinned: [] });
      restoredSpaces.add(space.id);
    });
    const windowNow = (id: string) => [...this.state.windows, ...this.state.closedWindows].find((w) => w.id === id);
    // A closed window the change dropped, unless it has been reopened since.
    for (const win of before.closedWindows) {
      if (step.droppedWindows.has(win.id) && !windowNow(win.id)) this.state.closedWindows.push({ ...win, spaces: {} });
    }
    this.state.closedWindows.sort((a, b) => b.closedAt - a.closedAt);
    for (const win of [...before.windows, ...before.closedWindows]) {
      const now = windowNow(win.id);
      if (!now) continue;
      for (const [spaceId, { today, activeTabId, split, splitMode, ...rest }] of Object.entries(win.spaces)) {
        if (this.savedSpace(spaceId)) now.spaces[spaceId] ??= { ...rest, today: [] };
      }
      // Back to the Space it showed, unless you have switched Spaces since.
      if (restoredSpaces.has(win.activeSpaceId) && step.switched.get(win.id) === now.activeSpaceId) now.activeSpaceId = win.activeSpaceId;
    }

    // Folders, then tabs, back in their lists, in the order they had there: those still where the
    // change left them, not those you have moved again since.
    const where = listOfEach(listsOf(this.state));
    for (const [list, keys] of listsOf(before)) {
      keys.forEach((key, i) => {
        if (step.touched.has(key) && where.get(key) === step.touched.get(key)) this.putBack(key, list, keys.slice(0, i), before, step.homes);
      });
    }

    // A deleted tab with nowhere to go back to (its window has closed since) stays archived.
    const placed = new Set([...listsOf(this.state).values()].flat());
    for (const id of Object.keys(step.removed)) {
      if (!placed.has(`t:${id}`)) delete this.state.tabs[id];
      else if (step.archived.has(id)) this.state.archive = this.state.archive.filter((a) => a !== step.archived.get(id));
    }
    // And what the step pushed out of the archive comes back, oldest last.
    const archive = new Set(this.state.archive);
    this.state.archive.push(...step.dropped.filter((a) => !archive.has(a)));
    this.state.archive.length = Math.min(this.state.archive.length, ARCHIVE_LIMIT);

    // The tab and split the change took off screen, unless the tab has gone on screen in another
    // window since (claim), or you have picked or closed one since.
    const heldElsewhere = (tabId: string, windowId: string) =>
      this.state.windows.some((w) => w.id !== windowId && Object.values(w.spaces).some((ws) => ws.activeTabId === tabId || ws.split?.includes(tabId)));
    for (const win of [...before.windows, ...before.closedWindows]) {
      const now = windowNow(win.id);
      for (const [spaceId, ws] of Object.entries(win.spaces)) {
        const current = now?.spaces[spaceId];
        if (!current) continue;
        const shown = (this.hasWindow(win.id) ? this.allTabIds({ id: spaceId, pinned: this.savedSpace(spaceId)?.pinned ?? [] }, win.id) : current.today).filter(
          (id) => !heldElsewhere(id, win.id),
        );
        if (step.leftEmpty.has(`${win.id}:${spaceId}`) && !current.activeTabId && shown.includes(ws.activeTabId!)) current.activeTabId = ws.activeTabId;
        if (step.endedSplits.has(`${win.id}:${spaceId}`) && !current.split && ws.split?.every((id) => shown.includes(id))) {
          current.split = ws.split;
          if (ws.splitMode) current.splitMode = ws.splitMode;
        }
      }
    }
    this.forgetMissingActive();
    this.changed();
    return step.label;
  }

  /** Puts a tab or folder back into `list`, after the last of `previous` that is there now. */
  private putBack(key: string, list: string, previous: string[], before: Layout, homes: UndoStep['homes']) {
    const [kind, a, b] = list.split(':');
    const pinned = kind === 'pinned' || kind === 'folder';
    const target: string[] | PinnedNode[] | undefined =
      kind === 'favorites'
        ? this.state.favorites
        : kind === 'pinned'
          ? this.savedSpace(a)?.pinned
          : kind === 'folder'
            ? this.findFolder(a)?.folder.children
            : this.savedSpace(b) && windowIn(this.state, a)
              ? (windowIn(this.state, a)!.spaces[b] ??= { today: [] }).today
              : undefined;
    if (!target) return;
    const id = key.slice(2);
    let node: PinnedNode;
    if (key.startsWith('t:')) {
      const tab = this.state.tabs[id];
      if (!tab) return;
      this.detachEverywhere(id);
      if (pinned || kind === 'favorites') tab.homeUrl ??= homes[id] ?? tab.url;
      else delete tab.homeUrl;
      node = { kind: 'tab', tabId: id };
    } else {
      const found = this.findFolder(id);
      if (found) found.parent.splice(found.parent.indexOf(found.folder), 1);
      const old = before.spaces.map((s) => findFolder(s.pinned, id)).find(Boolean)!;
      node = found?.folder ?? { ...old, children: [] };
    }
    const keysNow = (target as Array<string | PinnedNode>).map((item) => (typeof item === 'string' ? `t:${item}` : nodeKey(item)));
    const after = previous.reverse().find((k) => keysNow.includes(k));
    const at = after ? keysNow.indexOf(after) + 1 : 0;
    if (pinned) (target as PinnedNode[]).splice(at, 0, node);
    else (target as string[]).splice(at, 0, id);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    return this.persistence.save(this.serialize());
  }

  /** The state as it is saved, without what only a live page has (loading, audible). */
  serialize(): string {
    const tabs = Object.fromEntries(
      Object.entries(this.state.tabs).map(([id, { loading, audible, ...tab }]) => [id, tab]),
    );
    return JSON.stringify({ version: STATE_VERSION, ...this.state, tabs }, null, 2);
  }

  // ---- internals ------------------------------------------------------------------

  /** A shared tab (pinned or favorite) shows in one window at a time: `win` takes it from the others. */
  private claim(tabId: string, win: FlechaWindow) {
    for (const other of this.state.windows) {
      if (other === win) continue;
      for (const ws of Object.values(other.spaces)) {
        if (ws.activeTabId === tabId) ws.activeTabId = undefined;
        if (ws.split?.includes(tabId)) {
          delete ws.split;
          delete ws.splitMode;
        }
      }
    }
  }

  private savedSpace(spaceId: string): SavedSpace | undefined {
    return this.state.spaces.find((s) => s.id === spaceId);
  }

  /** A Space's Today tabs and selection in a window (the focused one by default), made on first use. */
  private windowSpace(spaceId: string, windowId?: string): WindowSpace {
    const win = this.window(windowId);
    return (win.spaces[spaceId] ??= { today: [] });
  }

  private newWindow(spaceId = this.state?.spaces[0]?.id): FlechaWindow {
    return { id: randomUUID(), activeSpaceId: spaceId ?? '', spaces: {} };
  }

  private changed(change: StoreChange = 'structure', persist = true, detail?: ChangeDetail) {
    for (const win of this.state.windows) {
      for (const [spaceId, ws] of Object.entries(win.spaces)) {
        if (!ws.split) continue;
        // Repair even on a metadata event: restored or externally changed layout
        // may already be inconsistent. Most pairs are local Today tabs.
        let pinned: string[] | undefined;
        if (!ws.split.every(id => ws.today.includes(id) || this.state.favorites.includes(id) ||
            (pinned ??= pinnedTabIds(this.savedSpace(spaceId)?.pinned ?? [])).includes(id))) {
          delete ws.split;
          delete ws.splitMode;
          persist = true;
          change = 'structure';
          detail = undefined;
        }
      }
    }
    if (persist) this.scheduleSave();
    for (const fn of this.listeners) fn(change, detail);
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  /** A folder in any Space, with the list it sits in. */
  private findFolder(folderId: string) {
    for (const space of this.state.spaces) {
      const folder = findFolder(space.pinned, folderId);
      if (folder) return { space, folder, parent: findParentList(space.pinned, folderId)! };
    }
    return undefined;
  }

  private placementExists(to: TabPlacement) {
    if (to.zone === 'favorites') return true;
    const space = this.savedSpace(to.spaceId);
    if (!space) return false;
    return to.zone === 'today' || !to.folderId || !!findFolder(space.pinned, to.folderId);
  }

  /** Inserts a tab that is in no list at a placement `placementExists` accepted. */
  private insert(tabId: string, to: TabPlacement, windowId?: string) {
    const before = (list: string[]) => {
      const i = to.beforeId ? list.indexOf(to.beforeId) : -1;
      return i < 0 ? list.length : i;
    };
    if (to.zone === 'favorites') return void this.state.favorites.splice(before(this.state.favorites), 0, tabId);
    const space = this.savedSpace(to.spaceId)!;
    if (to.zone === 'today') {
      const today = this.windowSpace(space.id, windowId).today;
      return void today.splice(before(today), 0, tabId);
    }
    const list = to.folderId ? findFolder(space.pinned, to.folderId)!.children : space.pinned;
    const i = to.beforeId ? list.findIndex((n) => nodeId(n) === to.beforeId) : -1;
    list.splice(i < 0 ? list.length : i, 0, { kind: 'tab', tabId });
  }

  /** Takes a tab out of favorites, every Space and every window, editing the lists in place. */
  private detachEverywhere(tabId: string) {
    const drop = (list: string[]) => {
      const i = list.indexOf(tabId);
      if (i >= 0) list.splice(i, 1);
    };
    this.recording?.moved.add(`t:${tabId}`);
    drop(this.state.favorites);
    for (const space of this.state.spaces) removePinned(space.pinned, tabId);
    for (const win of [...this.state.windows, ...this.state.closedWindows]) for (const ws of Object.values(win.spaces)) drop(ws.today);
  }

  /** A window's Space whose active tab went elsewhere shows nothing until you pick a tab. */
  private forgetMissingActive() {
    for (const win of this.state.windows) {
      for (const space of this.state.spaces) {
        const ws = win.spaces[space.id];
        if (ws?.activeTabId && !this.allTabIds(space, win.id).includes(ws.activeTabId)) ws.activeTabId = undefined;
      }
    }
  }

  /** A fresh install's single Space, untouched, gives way to imported ones. Returns whether it did. */
  private dropPristineSpace() {
    const s = this.state;
    const only = pristineSpace(s);
    if (only) {
      s.spaces = [];
      for (const win of s.windows) delete win.spaces[only.id];
    }
    return !!only;
  }

  /** Windows whose Space went away (the pristine one), or every window after a fresh start, show `spaceId`. */
  private afterImport(pristine: boolean, spaceId: string) {
    for (const win of this.state.windows) if (pristine || !this.savedSpace(win.activeSpaceId)) win.activeSpaceId = spaceId;
  }

  private importTab(t: { url: string; title: string }, pinned: boolean) {
    const tab: TabInfo = { id: randomUUID(), url: t.url, title: t.title || t.url, lastActive: Date.now(), unseen: true };
    if (pinned) tab.homeUrl = t.url;
    this.state.tabs[tab.id] = tab;
    return tab.id;
  }

  /**
   * Adds imported pinned tabs and folders to `list`; with `merge`, a folder joins one of the same
   * name already there. `add` says whether a tab comes over. A folder all of whose tabs were already
   * there isn't added.
   */
  private mergeNodes(list: PinnedNode[], nodes: ImportNode[], add: (t: ImportTab) => boolean, merge: boolean) {
    for (const n of nodes) {
      if (n.kind === 'tab') {
        if (add(n)) list.push({ kind: 'tab', tabId: this.importTab(n, true) });
        continue;
      }
      const name = n.name.trim().toLowerCase();
      const same = merge ? list.find((f): f is Extract<PinnedNode, { kind: 'folder' }> => f.kind === 'folder' && f.name.trim().toLowerCase() === name) : undefined;
      const folder: Extract<PinnedNode, { kind: 'folder' }> = same ?? { kind: 'folder', id: randomUUID(), name: n.name, open: false, children: [] };
      this.mergeNodes(folder.children, n.children, add, merge);
      if (!same && (folder.children.length || !n.children.length)) list.push(folder);
    }
  }

  /** Addresses of a Space's pinned tabs (where they are and where they started) and its Today tabs in every window. */
  private spaceTabUrls(space: SavedSpace): string[] {
    const ids = [...pinnedTabIds(space.pinned), ...[...this.state.windows, ...this.state.closedWindows].flatMap((w) => w.spaces[space.id]?.today ?? [])];
    return ids.flatMap((id) => {
      const tab = this.state.tabs[id];
      return tab ? [tab.url, ...(tab.homeUrl ? [tab.homeUrl] : [])] : [];
    });
  }

  private archive(tab: TabInfo | undefined) {
    if (!tab || tab.url === 'about:blank') return;
    const entry = { url: tab.url, title: tab.title, closedAt: Date.now() };
    this.state.archive.unshift(entry);
    this.recording?.archived.set(tab.id, entry);
    this.state.archive.length = Math.min(this.state.archive.length, ARCHIVE_LIMIT);
  }

  private load(): BrowserState | undefined {
    const state = this.persistence.load();
    return state?.spaces?.length ? state : undefined;
  }

  private initialState(): BrowserState {
    const space: SavedSpace = { id: randomUUID(), ...INITIAL_SPACE, pinned: [] };
    return { spaces: [space], windows: [{ id: randomUUID(), activeSpaceId: space.id, spaces: {} }], closedWindows: [], favorites: [], tabs: {}, archive: [], sidebarVisible: true };
  }
}

/**
 * The archive with `incoming` added: newest first, each archiving (address and time) once, and no
 * more than ARCHIVE_LIMIT. `added` counts incoming entries that were kept; `dropped`, entries of
 * either that didn't fit.
 */
export function mergeArchive(existing: ArchivedTab[], incoming: ArchivedTab[]): { archive: ArchivedTab[]; added: number; dropped: number } {
  const key = (a: ArchivedTab) => `${a.closedAt} ${a.url}`;
  const seen = new Set(existing.map(key));
  const fresh: ArchivedTab[] = [];
  for (const a of incoming) {
    if (seen.has(key(a))) continue;
    seen.add(key(a));
    fresh.push(a);
  }
  const all = [...existing, ...fresh].sort((a, b) => b.closedAt - a.closedAt);
  const archive = all.slice(0, ARCHIVE_LIMIT);
  const kept = new Set(archive);
  return { archive, added: fresh.filter((a) => kept.has(a)).length, dropped: all.length - archive.length };
}

export function pinnedTabIds(nodes: PinnedNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === 'tab' ? [n.tabId] : pinnedTabIds(n.children)));
}

export function findFolder(nodes: PinnedNode[], id: string): Extract<PinnedNode, { kind: 'folder' }> | undefined {
  for (const n of nodes) {
    if (n.kind !== 'folder') continue;
    if (n.id === id) return n;
    const inner = findFolder(n.children, id);
    if (inner) return inner;
  }
  return undefined;
}

/** The list holding the tab or folder with this id. */
function findParentList(nodes: PinnedNode[], id: string): PinnedNode[] | undefined {
  for (const n of nodes) {
    if (nodeId(n) === id) return nodes;
    if (n.kind === 'folder') {
      const inner = findParentList(n.children, id);
      if (inner) return inner;
    }
  }
  return undefined;
}

function nodeId(node: PinnedNode) {
  return node.kind === 'tab' ? node.tabId : node.id;
}

const nodeKey = (node: PinnedNode) => (node.kind === 'tab' ? `t:${node.tabId}` : `f:${node.id}`);

const plural = (n: number, one: string) => (n === 1 ? one : `${n} ${one}s`);

function windowIn(layout: Layout, windowId: string) {
  return [...layout.windows, ...layout.closedWindows].find((w) => w.id === windowId);
}

/**
 * Every list of tabs and folders, by name ('favorites', 'pinned:<space>', 'folder:<id>',
 * 'today:<window>:<space>'), with its items as `t:<tab>` or `f:<folder>`. A folder's own list
 * comes after the list that holds it.
 */
function listsOf(layout: Layout): Map<string, string[]> {
  const lists = new Map<string, string[]>([['favorites', layout.favorites.map((id) => `t:${id}`)]]);
  const tree = (name: string, nodes: PinnedNode[]) => {
    lists.set(name, nodes.map(nodeKey));
    for (const n of nodes) if (n.kind === 'folder') tree(`folder:${n.id}`, n.children);
  };
  for (const space of layout.spaces) tree(`pinned:${space.id}`, space.pinned);
  for (const win of [...layout.windows, ...layout.closedWindows]) {
    for (const [spaceId, ws] of Object.entries(win.spaces)) lists.set(`today:${win.id}:${spaceId}`, ws.today.map((id) => `t:${id}`));
  }
  return lists;
}

/** The list each item is in. */
function listOfEach(lists: Map<string, string[]>): Map<string, string> {
  const listOf = new Map<string, string>();
  for (const [name, keys] of lists) for (const key of keys) listOf.set(key, name);
  return listOf;
}

/**
 * The items that left their list, and the `moved` ones that changed places within it. Items a
 * move only shifted aren't counted: the order alone can't tell which of two swapped tabs moved.
 */
function changedPlaces(before: Map<string, string[]>, after: Map<string, string[]>, moved: Set<string>): Set<string> {
  const listOf = listOfEach(after);
  const changed = new Set<string>();
  for (const [name, keys] of before) {
    const stayed = keys.filter((key) => listOf.get(key) === name);
    const order = (after.get(name) ?? []).filter((key) => stayed.includes(key));
    for (const key of keys) if (listOf.get(key) !== name) changed.add(key);
    stayed.forEach((key, i) => key !== order[i] && moved.has(key) && changed.add(key));
  }
  return changed;
}

function removePinned(nodes: PinnedNode[], tabId: string) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind === 'tab' && n.tabId === tabId) nodes.splice(i, 1);
    else if (n.kind === 'folder') removePinned(n.children, tabId);
  }
}
