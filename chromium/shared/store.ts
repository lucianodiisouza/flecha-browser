import type { BrowserState, DropTarget, Environment, PinnedNode, SearchEngineId, Space, TabInfo, TabPlacement, WindowBounds } from './types';
import type { ArcImport, ImportNode } from './importApply';

const SPACE_COLORS = ['#cdd9f7', '#f6d6cc', '#d3ecd5', '#e8d6f3', '#f5e7c4', '#cfe8ec'];
const SPACE_EMOJIS = ['🏠', '💼', '🎨', '📚', '🧪', '🎮'];
const ARCHIVE_LIMIT = 500;

type Location = { space?: Space; zone: 'today' | 'pinned' | 'favorites' };

/** Where the state lives: a file in Electron, extension storage in the Chromium build. */
export interface StatePersistence {
  load(): BrowserState | undefined;
  save(json: string): void;
}

const randomUUID = () => crypto.randomUUID();

export class Store {
  state: BrowserState;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private listeners: Array<() => void> = [];

  constructor(private persistence: StatePersistence) {
    this.state = this.load() ?? this.initialState();
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  get activeSpace(): Space {
    return this.state.spaces.find((s) => s.id === this.state.activeSpaceId) ?? this.state.spaces[0];
  }

  get activeTab(): TabInfo | undefined {
    const id = this.activeSpace.activeTabId;
    return id ? this.state.tabs[id] : undefined;
  }

  allTabIds(space: Space): string[] {
    return [...this.state.favorites, ...pinnedTabIds(space.pinned), ...space.today];
  }

  locate(tabId: string): Location | undefined {
    if (this.state.favorites.includes(tabId)) return { zone: 'favorites' };
    for (const space of this.state.spaces) {
      if (space.today.includes(tabId)) return { space, zone: 'today' };
      if (pinnedTabIds(space.pinned).includes(tabId)) return { space, zone: 'pinned' };
    }
    return undefined;
  }

  addTab(url: string, opts: { activate?: boolean; afterTabId?: string } = {}): TabInfo {
    const tab: TabInfo = { id: randomUUID(), url, title: url, lastActive: Date.now() };
    this.state.tabs[tab.id] = tab;
    const space = this.activeSpace;
    const after = opts.afterTabId ? space.today.indexOf(opts.afterTabId) : -1;
    space.today.splice(after + 1, 0, tab.id);
    if (opts.activate !== false) space.activeTabId = tab.id;
    this.changed();
    return tab;
  }

  activate(tabId: string) {
    const tab = this.state.tabs[tabId];
    if (!tab) return;
    const loc = this.locate(tabId);
    if (loc?.space) this.state.activeSpaceId = loc.space.id;
    this.activeSpace.activeTabId = tabId;
    tab.lastActive = Date.now();
    this.changed();
  }

  updateTab(tabId: string, patch: Partial<TabInfo>) {
    const tab = this.state.tabs[tabId];
    if (!tab) return;
    const keys = Object.keys(patch) as Array<keyof TabInfo>;
    if (keys.every((k) => tab[k] === patch[k])) return;
    Object.assign(tab, patch);
    this.changed();
  }

  /**
   * Today tabs are archived and removed. Pinned tabs and favorites stay in the
   * sidebar and only unload, going back to their home URL (Arc's behaviour).
   */
  closeTab(tabId: string): 'removed' | 'unloaded' {
    const tab = this.state.tabs[tabId];
    const loc = this.locate(tabId);
    if (!tab || !loc) return 'removed';
    const space = loc.space ?? this.activeSpace;

    if (loc.zone !== 'today') {
      if (tab.homeUrl) tab.url = tab.homeUrl;
      delete tab.history;
      for (const s of this.state.spaces) if (s.activeTabId === tabId) s.activeTabId = undefined;
      this.changed();
      return 'unloaded';
    }

    const index = space.today.indexOf(tabId);
    space.today.splice(index, 1);
    this.archive(tab);
    delete this.state.tabs[tabId];
    if (space.activeTabId === tabId) {
      space.activeTabId = space.today[Math.min(index, space.today.length - 1)];
    }
    this.changed();
    return 'removed';
  }

  /** Moves a tab between favorites, pinned (optionally into a folder) and today. */
  moveTab(tabId: string, target: DropTarget) {
    const tab = this.state.tabs[tabId];
    const from = this.locate(tabId);
    if (!tab || !from || target.beforeTabId === tabId) return;
    const space = from.space ?? this.activeSpace;
    const targetSpace = this.activeSpace;

    // Moving a tab out of its split ends the split
    if (space.split?.includes(tabId)) {
      delete space.split;
      delete space.splitMode;
    }

    this.detach(tabId, space);
    const insert = (list: string[]) => {
      const i = target.beforeTabId ? list.indexOf(target.beforeTabId) : -1;
      list.splice(i < 0 ? list.length : i, 0, tabId);
    };

    if (target.zone === 'favorites') {
      insert(this.state.favorites);
    } else if (target.zone === 'today') {
      insert(targetSpace.today);
    } else {
      const parent = target.folderId ? findFolder(targetSpace.pinned, target.folderId)?.children : undefined;
      const list = parent ?? (target.beforeTabId ? findParentList(targetSpace.pinned, target.beforeTabId) : undefined) ?? targetSpace.pinned;
      const i = target.beforeTabId ? list.findIndex((n) => n.kind === 'tab' && n.tabId === target.beforeTabId) : -1;
      list.splice(i < 0 ? list.length : i, 0, { kind: 'tab', tabId });
    }

    if (target.zone === 'today') delete tab.homeUrl;
    else tab.homeUrl ??= tab.url;
    if (space.activeTabId === tabId && space !== targetSpace) space.activeTabId = undefined;
    this.changed();
  }

  /**
   * Moves a tab anywhere, in any Space (Settings' tab manager). Unlike `moveTab`, the target
   * names its Space. Returns whether it moved.
   */
  placeTab(tabId: string, to: TabPlacement): boolean {
    const tab = this.state.tabs[tabId];
    if (!tab || !this.locate(tabId) || to.beforeId === tabId || !this.placementExists(to)) return false;
    this.detachEverywhere(tabId);
    this.insert(tabId, to);
    if (to.zone === 'today') delete tab.homeUrl;
    else tab.homeUrl ??= tab.url;
    this.forgetMissingActive();
    this.changed();
    return true;
  }

  /** A new pinned tab, favorite or Today tab that isn't opened yet. */
  createTab(url: string, title: string, to: TabPlacement): TabInfo | undefined {
    if (!this.placementExists(to)) return undefined;
    const tab: TabInfo = { id: randomUUID(), url, title: title || url, lastActive: Date.now() };
    if (to.zone !== 'today') tab.homeUrl = url;
    this.state.tabs[tab.id] = tab;
    this.insert(tab.id, to);
    this.changed();
    return tab;
  }

  /**
   * Deletes tabs for good, wherever they are: pinned tabs and favorites too, which
   * `closeTab` only unloads. They go to the archive, so they can still be found. Returns the removed ids.
   */
  removeTabs(tabIds: string[]): string[] {
    const removed = tabIds.filter((id) => this.state.tabs[id] && this.locate(id));
    for (const id of removed) {
      this.detachEverywhere(id);
      this.archive(this.state.tabs[id]);
      delete this.state.tabs[id];
    }
    if (!removed.length) return [];
    this.forgetMissingActive();
    this.changed();
    return removed;
  }

  /** Puts `tabId` next to `withTabId` (or the active tab), on the right unless `side` says otherwise. */
  splitWith(tabId: string, side: 'left' | 'right' = 'right', withTabId?: string) {
    const space = this.activeSpace;
    const current = withTabId ?? space.activeTabId;
    if (!current || current === tabId || !this.allTabIds(space).includes(tabId) || !this.allTabIds(space).includes(current)) return;
    space.split = side === 'left' ? [tabId, current] : [current, tabId];
    delete space.splitMode;

    // Keep split tabs adjacent in today if current is in today
    if (space.today.includes(current)) {
      if (!space.today.includes(tabId)) {
        this.detach(tabId, space);
        const idx = space.today.indexOf(current);
        space.today.splice(side === 'left' ? idx : idx + 1, 0, tabId);
      } else {
        space.today = space.today.filter((id) => id !== tabId);
        const idx = space.today.indexOf(current);
        space.today.splice(side === 'left' ? idx : idx + 1, 0, tabId);
      }
    }
    space.activeTabId = tabId;
    this.state.tabs[tabId].lastActive = Date.now();
    this.changed();
  }

  /** Opens the active page again as a phone-sized mirror, side by side. Returns the mirror's id. */
  openResponsive(): string | undefined {
    const space = this.activeSpace;
    const source = this.activeTab;
    if (!source) return undefined;
    const mirror = this.addTab(source.url, { activate: false, afterTabId: space.today.includes(source.id) ? source.id : undefined });
    mirror.device = 'mobile';
    mirror.title = source.title;
    space.split = [source.id, mirror.id];
    space.splitMode = 'responsive';
    this.changed();
    return mirror.id;
  }

  setSplitRatio(ratio: number) {
    const space = this.activeSpace;
    if (!space.split) return;
    space.splitRatio = Math.min(0.8, Math.max(0.2, ratio));
    this.changed();
  }

  /** Ends the split. A responsive mirror has no life of its own, so its id is returned for closing. */
  unsplit(): string | undefined {
    const space = this.activeSpace;
    if (!space.split) return undefined;
    const mirror = space.splitMode === 'responsive' ? space.split[1] : undefined;
    delete space.split;
    delete space.splitMode;
    this.changed();
    return mirror;
  }

  /** The tabs on screen right now: the active tab, or both halves of its split. */
  visibleTabIds(): string[] {
    const space = this.activeSpace;
    const active = space.activeTabId;
    if (!active) return [];
    return space.split?.includes(active) ? [...space.split] : [active];
  }

  /** Moves a tab into another Space's today list (pinned tabs keep being pinned there). */
  moveToSpace(tabId: string, spaceId: string) {
    const from = this.locate(tabId);
    const to = this.state.spaces.find((s) => s.id === spaceId);
    if (!from?.space || !to || from.space === to) return;
    this.detach(tabId, from.space);
    if (from.zone === 'pinned') to.pinned.push({ kind: 'tab', tabId });
    else to.today.unshift(tabId);
    if (from.space.activeTabId === tabId) from.space.activeTabId = from.space.today[0];
    this.changed();
  }

  /** Closes the today tabs after `tabId`, or all others when `others` is set. Returns their ids. */
  closeTodayTabs(tabId: string, which: 'below' | 'others'): string[] {
    const space = this.locate(tabId)?.space;
    if (!space) return [];
    const index = space.today.indexOf(tabId);
    const ids = space.today.filter((id, i) => (which === 'below' ? i > index : id !== tabId));
    for (const id of ids) this.closeTab(id);
    return ids;
  }

  togglePin(tabId: string) {
    const loc = this.locate(tabId);
    this.moveTab(tabId, { zone: loc?.zone === 'today' ? 'pinned' : 'today' });
  }

  toggleFavorite(tabId: string) {
    const loc = this.locate(tabId);
    this.moveTab(tabId, { zone: loc?.zone === 'favorites' ? 'today' : 'favorites' });
  }

  /** In the active Space unless `where` names another, optionally inside a folder. Returns the new folder's id. */
  newFolder(name = 'New Folder', where: { spaceId?: string; parentId?: string } = {}): string | undefined {
    const space = where.spaceId ? this.state.spaces.find((s) => s.id === where.spaceId) : this.activeSpace;
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
    parent.splice(parent.indexOf(folder), 1, ...(keepTabs ? folder.children : []));
    const removed = keepTabs ? [] : pinnedTabIds(folder.children);
    for (const id of removed) {
      this.archive(this.state.tabs[id]);
      delete this.state.tabs[id];
    }
    this.forgetMissingActive();
    this.changed();
    return removed;
  }

  /** Moves a folder within the pinned tabs of any Space; never into itself. Returns whether it moved. */
  moveFolder(folderId: string, to: { spaceId: string; folderId?: string; beforeId?: string }): boolean {
    const found = this.findFolder(folderId);
    const space = this.state.spaces.find((s) => s.id === to.spaceId);
    if (!found || !space || to.beforeId === folderId) return false;
    if (to.folderId && (to.folderId === folderId || findFolder(found.folder.children, to.folderId))) return false;
    const list = to.folderId ? findFolder(space.pinned, to.folderId)?.children : space.pinned;
    if (!list) return false;
    found.parent.splice(found.parent.indexOf(found.folder), 1);
    const i = to.beforeId ? list.findIndex((n) => nodeId(n) === to.beforeId) : -1;
    list.splice(i < 0 ? list.length : i, 0, found.folder);
    this.forgetMissingActive();
    this.changed();
    return true;
  }

  /** Switches to the new Space unless `activate` is false (Settings adds one without leaving the current Space). */
  newSpace(activate = true): Space {
    const n = this.state.spaces.length;
    const space: Space = {
      id: randomUUID(),
      name: `Space ${n + 1}`,
      emoji: SPACE_EMOJIS[n % SPACE_EMOJIS.length],
      color: SPACE_COLORS[n % SPACE_COLORS.length],
      pinned: [],
      today: [],
    };
    this.state.spaces.push(space);
    if (activate) this.state.activeSpaceId = space.id;
    this.changed();
    return space;
  }

  /** Reorders the Spaces: `spaceId` goes before `beforeSpaceId`, or last. */
  moveSpace(spaceId: string, beforeSpaceId?: string) {
    const space = this.state.spaces.find((s) => s.id === spaceId);
    if (!space || beforeSpaceId === spaceId) return;
    const spaces = this.state.spaces.filter((s) => s !== space);
    const i = beforeSpaceId ? spaces.findIndex((s) => s.id === beforeSpaceId) : -1;
    spaces.splice(i < 0 ? spaces.length : i, 0, space);
    this.state.spaces = spaces;
    this.changed();
  }

  /** Name, emoji and colour. Invalid values are ignored rather than stored. */
  updateSpace(spaceId: string, patch: { name?: string; emoji?: string; color?: string }) {
    const space = this.state.spaces.find((s) => s.id === spaceId);
    if (!space) return;
    const name = typeof patch.name === 'string' ? patch.name.trim().slice(0, 40) : '';
    if (name) space.name = name;
    if (typeof patch.emoji === 'string') space.emoji = [...patch.emoji.trim()].slice(0, 2).join('') || undefined;
    if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) space.color = patch.color.toLowerCase();
    this.changed();
  }

  /** Returns the ids of tabs that were dropped, so their views can be destroyed. */
  deleteSpace(spaceId: string): string[] {
    if (this.state.spaces.length < 2) return [];
    const space = this.state.spaces.find((s) => s.id === spaceId);
    if (!space) return [];
    const ids = [...pinnedTabIds(space.pinned), ...space.today];
    for (const id of ids) delete this.state.tabs[id];
    this.state.spaces = this.state.spaces.filter((s) => s !== space);
    if (this.state.activeSpaceId === spaceId) this.state.activeSpaceId = this.state.spaces[0].id;
    this.changed();
    return ids;
  }

  /** Returns the space's tab ids: their pages must be reopened in the new session. */
  setIsolated(spaceId: string, isolated: boolean): string[] {
    const space = this.state.spaces.find((s) => s.id === spaceId);
    if (!space) return [];
    space.isolated = isolated;
    this.changed();
    return [...pinnedTabIds(space.pinned), ...space.today];
  }

  switchSpace(spaceId: string) {
    if (!this.state.spaces.some((s) => s.id === spaceId)) return;
    this.state.activeSpaceId = spaceId;
    this.changed();
  }

  /** Archives every today tab in the active space. Returns the removed ids. */
  clearToday(): string[] {
    const space = this.activeSpace;
    const ids = space.today.splice(0);
    for (const id of ids) {
      this.archive(this.state.tabs[id]);
      delete this.state.tabs[id];
    }
    if (space.activeTabId && ids.includes(space.activeTabId)) space.activeTabId = undefined;
    this.changed();
    return ids;
  }

  /** Arc's auto-archive: today tabs untouched for a while go away on their own. */
  archiveStale(): string[] {
    const hours = this.state.archiveAfterHours ?? 12;
    if (hours === 0) return [];
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const removed: string[] = [];
    for (const space of this.state.spaces) {
      space.today = space.today.filter((id) => {
        const tab = this.state.tabs[id];
        if (!tab || id === space.activeTabId || tab.lastActive >= cutoff) return true;
        this.archive(tab);
        delete this.state.tabs[id];
        removed.push(id);
        return false;
      });
    }
    if (removed.length) this.changed();
    return removed;
  }

  popArchive() {
    const item = this.state.archive.shift();
    if (item) this.changed();
    return item;
  }

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

  /** Saved without notifying listeners: nothing on screen depends on it. */
  setWindowBounds(bounds: WindowBounds) {
    this.state.window = bounds;
    this.scheduleSave();
  }

  setSidebarVisible(visible: boolean) {
    this.state.sidebarVisible = visible;
    this.changed();
  }

  importArc(data: ArcImport) {
    const s = this.state;
    const pristine = this.dropPristineSpace();

    for (const imported of data.spaces) {
      const n = s.spaces.length;
      s.spaces.push({
        id: randomUUID(),
        name: imported.name,
        emoji: imported.emoji,
        color: SPACE_COLORS[n % SPACE_COLORS.length],
        pinned: this.importNodes(imported.pinned),
        today: imported.today.map((t) => this.importTab(t, false)),
      });
    }
    for (const fav of data.favorites) s.favorites.push(this.importTab(fav, true));
    if (pristine || !s.spaces.some((sp) => sp.id === s.activeSpaceId)) s.activeSpaceId = s.spaces[0].id;
    this.changed();
  }

  /** Another browser's bookmarks become the pinned tabs and folders of a new Space named `name`. */
  importBookmarks(name: string, nodes: ImportNode[]): Space {
    const s = this.state;
    const pristine = this.dropPristineSpace();
    const n = s.spaces.length;
    const space: Space = {
      id: randomUUID(),
      name,
      emoji: SPACE_EMOJIS[n % SPACE_EMOJIS.length],
      color: SPACE_COLORS[n % SPACE_COLORS.length],
      pinned: this.importNodes(nodes),
      today: [],
    };
    s.spaces.push(space);
    if (pristine || !s.spaces.some((sp) => sp.id === s.activeSpaceId)) s.activeSpaceId = space.id;
    this.changed();
    return space;
  }

  /** Takes over another Flecha's whole state (its Spaces, tabs and settings), as if it had been loaded. */
  replaceState(state: BrowserState): boolean {
    if (!state?.spaces?.length || !state.tabs) return false;
    this.state = state;
    this.changed();
    return true;
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const tabs = Object.fromEntries(
      Object.entries(this.state.tabs).map(([id, { loading, audible, ...tab }]) => [id, tab]),
    );
    this.persistence.save(JSON.stringify({ ...this.state, tabs }, null, 2));
  }

  private changed() {
    for (const space of this.state.spaces) {
      // A split ends as soon as either half leaves the space.
      if (space.split && !space.split.every((id) => this.allTabIds(space).includes(id))) {
        delete space.split;
        delete space.splitMode;
      }
    }
    this.scheduleSave();
    for (const fn of this.listeners) fn();
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
    const space = this.state.spaces.find((s) => s.id === to.spaceId);
    if (!space) return false;
    return to.zone === 'today' || !to.folderId || !!findFolder(space.pinned, to.folderId);
  }

  /** Inserts a tab that is in no list at a placement `placementExists` accepted. */
  private insert(tabId: string, to: TabPlacement) {
    const before = (list: string[]) => {
      const i = to.beforeId ? list.indexOf(to.beforeId) : -1;
      return i < 0 ? list.length : i;
    };
    if (to.zone === 'favorites') return void this.state.favorites.splice(before(this.state.favorites), 0, tabId);
    const space = this.state.spaces.find((s) => s.id === to.spaceId)!;
    if (to.zone === 'today') return void space.today.splice(before(space.today), 0, tabId);
    const list = to.folderId ? findFolder(space.pinned, to.folderId)!.children : space.pinned;
    const i = to.beforeId ? list.findIndex((n) => nodeId(n) === to.beforeId) : -1;
    list.splice(i < 0 ? list.length : i, 0, { kind: 'tab', tabId });
  }

  /** Takes a tab out of favorites and every Space, editing the lists in place. */
  private detachEverywhere(tabId: string) {
    const drop = (list: string[]) => {
      const i = list.indexOf(tabId);
      if (i >= 0) list.splice(i, 1);
    };
    drop(this.state.favorites);
    for (const space of this.state.spaces) {
      drop(space.today);
      removePinned(space.pinned, tabId);
    }
  }

  /** A Space whose active tab went elsewhere shows nothing until you pick a tab. */
  private forgetMissingActive() {
    for (const space of this.state.spaces) {
      if (space.activeTabId && !this.allTabIds(space).includes(space.activeTabId)) space.activeTabId = undefined;
    }
  }

  private detach(tabId: string, space: Space) {
    this.state.favorites = this.state.favorites.filter((id) => id !== tabId);
    space.today = space.today.filter((id) => id !== tabId);
    removePinned(space.pinned, tabId);
  }

  /** A fresh install's single empty Space gives way to imported ones. Returns whether it did. */
  private dropPristineSpace() {
    const s = this.state;
    const pristine = s.spaces.length === 1 && this.allTabIds(s.spaces[0]).length === 0;
    if (pristine) s.spaces = [];
    return pristine;
  }

  private importTab(t: { url: string; title: string }, pinned: boolean) {
    const tab: TabInfo = { id: randomUUID(), url: t.url, title: t.title || t.url, lastActive: Date.now() };
    if (pinned) tab.homeUrl = t.url;
    this.state.tabs[tab.id] = tab;
    return tab.id;
  }

  private importNodes(nodes: ImportNode[]): PinnedNode[] {
    return nodes.map((n) =>
      n.kind === 'tab'
        ? { kind: 'tab', tabId: this.importTab(n, true) }
        : { kind: 'folder', id: randomUUID(), name: n.name, open: false, children: this.importNodes(n.children) },
    );
  }

  private archive(tab: TabInfo | undefined) {
    if (!tab || tab.url === 'about:blank') return;
    this.state.archive.unshift({ url: tab.url, title: tab.title, closedAt: Date.now() });
    this.state.archive.length = Math.min(this.state.archive.length, ARCHIVE_LIMIT);
  }

  private load(): BrowserState | undefined {
    const state = this.persistence.load();
    return state?.spaces?.length ? state : undefined;
  }

  private initialState(): BrowserState {
    const space: Space = { id: randomUUID(), name: 'Personal', emoji: '🏠', color: SPACE_COLORS[0], pinned: [], today: [] };
    return { spaces: [space], activeSpaceId: space.id, favorites: [], tabs: {}, archive: [], sidebarVisible: true };
  }
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

function removePinned(nodes: PinnedNode[], tabId: string) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind === 'tab' && n.tabId === tabId) nodes.splice(i, 1);
    else if (n.kind === 'folder') removePinned(n.children, tabId);
  }
}
