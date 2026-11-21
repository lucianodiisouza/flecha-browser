import type { FolderPlacement, PinnedNode, SavedSpace, TabPlacement, TabsEdit, TabsEditResult, TabsMenuAction, TabsView } from '../../shared/types';
import { findFolder, pinnedTabIds, type Store } from '../../shared/store';
import { pinnableAddress } from './url';
import { DELETE_SPACE_DETAIL } from './undo';

/** A question with buttons; resolves with the index of the button chosen. */
export interface AskOptions {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

/**
 * What the tab manager needs from the browser it runs in (the Chromium
 * shell's background): its tab pages, a way to ask, and a way to send the pane a fresh view.
 */
export interface TabManagerHost {
  /** Whether the tab's page is loaded. */
  isOpen(tabId: string): boolean;
  /** Points the tab's page, if it is loaded, at a new address. */
  load(tabId: string, url: string): void;
  destroyView(tabId: string): void;
  /** Activates the tab and brings the browser window forward. */
  show(tabId: string): void;
  faviconHosts(): string[];
  /** The cookie jar a Space's tabs use; a tab that lands in another one has to reopen. */
  sessionOf(space: SavedSpace | undefined): unknown;
  ask(options: AskOptions): Promise<number>;
  /** Sends the pane a fresh view (when Settings is open). */
  push(view: TabsView): void;
  hasView?(): boolean;
}

/** What a menu item does once picked: answer the page, make an edit, or open the tab. */
export type TabsMenuRun = { answer: TabsMenuAction } | { edit: TabsEdit } | { show: string };

/** The menu for tabs or a folder, as data; each browser draws it its own way. */
export type TabsMenuItem = { label: string; run: TabsMenuRun } | { label: string; submenu: TabsMenuItem[] } | { separator: true };

/** What the page asks a menu for: a selection of tabs or one folder, from a right-click or a button. */
export interface TabsMenuRequest {
  tabIds?: string[];
  folderId?: string;
  context?: boolean;
}

type Folder = Extract<PinnedNode, { kind: 'folder' }>;

const SEPARATOR: TabsMenuItem = { separator: true };

/**
 * Settings → Tabs & Spaces: favorites and every Space's pinned and Today tabs, edited like a
 * bookmarks manager. Every change goes through the Store, so the sidebar follows along, and the
 * pane is sent a fresh view whenever the Store changes for any other reason.
 */
export class TabManager {
  private pushTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private store: Store,
    /** The window whose Today tabs the pane shows (the one Settings is in); the focused one when undefined. */
    private windowId: () => string | undefined,
    private host: TabManagerHost,
  ) {
    // Titles and icons change while pages load; one redraw per burst is plenty.
    store.onChange((_change, detail) => {
      if (detail?.kind === 'metadata' && !detail.keys.some(k => ['url', 'title', 'customTitle', 'favicon', 'homeUrl'].includes(k))) return;
      this.refresh();
    });
  }

  /** Sends the pane a fresh view soon; also for changes outside the Store, like newly fetched icons. */
  refresh() {
    if (this.host.hasView?.() === false) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.host.push(this.view()), 120);
  }

  view(): TabsView {
    const s = this.store.state;
    const tabs: TabsView['tabs'] = {};
    for (const [id, t] of Object.entries(s.tabs)) {
      tabs[id] = { id, url: t.url, title: t.title, customTitle: t.customTitle, favicon: t.favicon, homeUrl: t.homeUrl, open: this.host.isOpen(id) };
    }
    const { activeSpaceId, spaces } = this.store.windowView(this.windowId());
    return {
      favorites: s.favorites,
      spaces: spaces.map(({ id, name, emoji, color, pinned, today, isolated }) => ({ id, name, emoji, color, pinned, today, isolated })),
      activeSpaceId,
      tabs,
      faviconHosts: this.host.faviconHosts(),
    };
  }

  /** Opens the tab in the browser, if it still exists. */
  show(tabId: string) {
    if (this.store.state.tabs[String(tabId)]) this.host.show(String(tabId));
  }

  async edit(raw: TabsEdit): Promise<TabsEditResult> {
    const result = await this.apply(raw && typeof raw === 'object' ? raw : ({} as TabsEdit)).catch((err) => {
      console.error('Tab manager edit failed', err);
      return {};
    });
    return { ...result, view: this.view() };
  }

  /** Does what a picked menu item says; resolves with what the page should do, if anything. */
  run(run: TabsMenuRun): TabsMenuAction | undefined {
    if ('answer' in run) return run.answer;
    if ('edit' in run) void this.edit(run.edit);
    else if ('show' in run) this.show(run.show);
    return undefined;
  }

  private async apply(e: TabsEdit): Promise<Omit<TabsEditResult, 'view'>> {
    switch (e.op) {
      case 'renameTab': {
        const id = this.tabId(e.tabId);
        if (id) this.store.updateTab(id, { customTitle: String(e.title ?? '').trim().slice(0, 200) || undefined });
        return {};
      }
      case 'setUrl': {
        const id = this.tabId(e.tabId);
        if (!id) return {};
        const url = pinnableAddress(e.url);
        if (!url) return { error: 'Enter a web address, like example.com.' };
        // Pinned tabs and favorites start over from the new address.
        const pinned = this.store.locate(id)?.zone !== 'today';
        this.store.updateTab(id, { url, ...(pinned ? { homeUrl: url } : {}), history: undefined });
        this.host.load(id, url);
        return {};
      }
      case 'move': {
        const to = tabPlacement(e.to);
        const ids = this.tabIds(e.tabIds);
        if (!to || !ids.length) return {};
        // Moving the tab it's dropped before would lose the spot; the end of the list it is, then.
        if (to.beforeId && ids.includes(to.beforeId)) delete to.beforeId;
        // One undo puts every tab back.
        this.keepingSessions(ids, () =>
          this.store.undoable(`Move ${ids.length === 1 ? 'Tab' : `${ids.length} Tabs`}`, () => {
            for (const id of ids) this.store.placeTab(id, to, this.windowId());
          }),
        );
        return {};
      }
      case 'delete':
        for (const id of this.store.removeTabs(this.tabIds(e.tabIds))) this.host.destroyView(id);
        return {};
      case 'add': {
        const to = tabPlacement(e.to);
        const url = pinnableAddress(e.url);
        if (!url) return { error: 'Enter a web address, like example.com.' };
        if (!to) return {};
        return { created: this.store.createTab(url, String(e.title ?? '').trim().slice(0, 200), to, this.windowId())?.id };
      }
      case 'newFolder':
        return { created: this.store.newFolder('New Folder', { spaceId: String(e.spaceId), parentId: optionalId(e.parentId) }) };
      case 'renameFolder':
        this.store.renameFolder(String(e.folderId), String(e.name ?? '').slice(0, 80));
        return {};
      case 'deleteFolder':
        await this.deleteFolder(String(e.folderId));
        return {};
      case 'moveFolder': {
        const folder = this.folder(String(e.folderId));
        const to = folderPlacement(e.to);
        if (!folder || !to) return {};
        this.keepingSessions(pinnedTabIds(folder.children), () => this.store.undoable(`Move “${folder.name}”`, () => this.store.moveFolder(folder.id, to)));
        return {};
      }
      case 'undo':
        // A tab back in a Space with other cookies reopens there, as after a move.
        this.keepingSessions(Object.keys(this.store.state.tabs), () => this.store.undo());
        return {};
      case 'newSpace':
        return { created: this.store.newSpace(false).id };
      case 'updateSpace':
        this.store.updateSpace(String(e.spaceId), {
          name: typeof e.name === 'string' ? e.name : undefined,
          emoji: typeof e.emoji === 'string' ? e.emoji : undefined,
          color: typeof e.color === 'string' ? e.color : undefined,
        });
        return {};
      case 'deleteSpace':
        await this.deleteSpace(String(e.spaceId));
        return {};
      case 'moveSpace':
        this.store.moveSpace(String(e.spaceId), optionalId(e.beforeSpaceId));
        return {};
      default:
        return {};
    }
  }

  /**
   * Runs a move, then closes the pages of tabs that ended up in a Space with other cookies:
   * they reopen in the right session next time, as with the sidebar's Move to Space.
   */
  private keepingSessions(tabIds: string[], move: () => void) {
    const before = new Map<string, unknown>(tabIds.map((id) => [id, this.sessionOf(id)]));
    move();
    for (const [id, ses] of before) if (this.sessionOf(id) !== ses) this.host.destroyView(id);
  }

  private sessionOf(tabId: string) {
    return this.host.sessionOf(this.store.locate(tabId)?.space);
  }

  private async deleteFolder(folderId: string) {
    const folder = this.folder(folderId);
    if (!folder) return;
    const count = pinnedTabIds(folder.children).length;
    // An empty folder has nothing to lose, so it goes without asking.
    let keepTabs = true;
    if (count || folder.children.length) {
      const response = await this.host.ask({
        message: `Delete “${folder.name}”?`,
        detail: count
          ? `It holds ${count === 1 ? 'one tab' : `${count} tabs`}. Keep them in its place, or delete them with the folder.`
          : 'It holds only empty folders.',
        buttons: [count ? 'Delete Tabs Too' : 'Delete', 'Keep Tabs', 'Cancel'],
        defaultId: 1,
        cancelId: 2,
      });
      if (response === 2) return;
      keepTabs = response === 1;
    }
    for (const id of this.store.deleteFolder(folderId, keepTabs)) this.host.destroyView(id);
  }

  private async deleteSpace(spaceId: string) {
    const space = this.store.state.spaces.find((s) => s.id === spaceId);
    if (!space || this.store.state.spaces.length < 2) return;
    const response = await this.host.ask({
      message: `Delete “${space.name}”?`,
      detail: DELETE_SPACE_DETAIL,
      buttons: ['Delete Space', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) for (const id of this.store.deleteSpace(spaceId)) this.host.destroyView(id);
  }

  /** The menu for a selection of tabs or one folder: Move to…, Delete and, with `context`, Rename and Edit Address. */
  menu(request: TabsMenuRequest): TabsMenuItem[] {
    if (!request || typeof request !== 'object') return [];
    const context = !!request.context;
    const folder = request.folderId ? this.folder(String(request.folderId)) : undefined;
    if (folder) {
      const moveTo = this.folderDestinations(folder);
      return [
        ...(context
          ? [
              { label: 'Rename', run: { answer: 'rename' as const } },
              { label: 'New Folder Inside', run: { edit: { op: 'newFolder' as const, spaceId: this.spaceOfFolder(folder.id)!, parentId: folder.id } } },
              SEPARATOR,
              { label: 'Move to', submenu: moveTo },
            ]
          : moveTo),
        SEPARATOR,
        { label: 'Delete Folder…', run: { edit: { op: 'deleteFolder', folderId: folder.id } } },
      ];
    }
    const tabIds = this.tabIds(request.tabIds);
    if (!tabIds.length) return [];
    const single = tabIds.length === 1;
    const moveTo = this.tabDestinations(tabIds);
    return [
      ...(context && single
        ? [
            { label: 'Open in Flecha', run: { show: tabIds[0] } },
            SEPARATOR,
            { label: 'Rename', run: { answer: 'rename' as const } },
            { label: 'Edit Address…', run: { answer: 'edit' as const } },
            SEPARATOR,
          ]
        : []),
      ...(context ? [{ label: 'Move to', submenu: moveTo }] : moveTo),
      SEPARATOR,
      { label: single ? 'Delete Tab' : `Delete ${tabIds.length} Tabs`, run: { edit: { op: 'delete', tabIds } } },
    ];
  }

  /** Favorites, then each Space's pinned tabs (with its folders) and Today. */
  private tabDestinations(tabIds: string[]): TabsMenuItem[] {
    const move = (to: TabPlacement): TabsMenuRun => ({ edit: { op: 'move', tabIds, to } });
    return [
      { label: 'Favorites', run: move({ zone: 'favorites' }) },
      SEPARATOR,
      ...this.store.state.spaces.map((space) => ({
        label: spaceLabel(space),
        submenu: [
          { label: 'Pinned', run: move({ zone: 'pinned', spaceId: space.id }) },
          ...folderItems(space.pinned, 1, (f) => move({ zone: 'pinned', spaceId: space.id, folderId: f.id })),
          SEPARATOR,
          { label: 'Today', run: move({ zone: 'today', spaceId: space.id }) },
        ],
      })),
    ];
  }

  /** Each Space's pinned tabs and folders, leaving out the folder itself and what's inside it. */
  private folderDestinations(folder: Folder): TabsMenuItem[] {
    const move = (to: FolderPlacement): TabsMenuRun => ({ edit: { op: 'moveFolder', folderId: folder.id, to } });
    return this.store.state.spaces.map((space) => ({
      label: spaceLabel(space),
      submenu: [
        { label: 'Pinned', run: move({ spaceId: space.id }) },
        ...folderItems(space.pinned, 1, (f) => move({ spaceId: space.id, folderId: f.id }), folder.id),
      ],
    }));
  }

  private tabId(raw: unknown) {
    const id = String(raw);
    return this.store.state.tabs[id] && this.store.locate(id) ? id : undefined;
  }

  private tabIds(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((id) => this.tabId(id)).filter((id): id is string => !!id))];
  }

  private folder(folderId: string): Folder | undefined {
    for (const space of this.store.state.spaces) {
      const found = findFolder(space.pinned, folderId);
      if (found) return found;
    }
    return undefined;
  }

  private spaceOfFolder(folderId: string) {
    return this.store.state.spaces.find((s) => findFolder(s.pinned, folderId))?.id;
  }
}

function optionalId(raw: unknown) {
  return typeof raw === 'string' && raw ? raw : undefined;
}

/** Only the fields a placement may have, as strings; whether they exist is the Store's check. */
function tabPlacement(raw: unknown): TabPlacement | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const beforeId = optionalId(r.beforeId);
  if (r.zone === 'favorites') return { zone: 'favorites', beforeId };
  const spaceId = optionalId(r.spaceId);
  if (!spaceId) return undefined;
  if (r.zone === 'today') return { zone: 'today', spaceId, beforeId };
  if (r.zone === 'pinned') return { zone: 'pinned', spaceId, folderId: optionalId(r.folderId), beforeId };
  return undefined;
}

function folderPlacement(raw: unknown): FolderPlacement | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const spaceId = optionalId(r.spaceId);
  return spaceId ? { spaceId, folderId: optionalId(r.folderId), beforeId: optionalId(r.beforeId) } : undefined;
}

function spaceLabel(space: { name: string; emoji?: string }) {
  return `${space.emoji ? space.emoji + '  ' : ''}${space.name}`;
}

/** Folders as indented menu items, skipping `except` and everything inside it. */
function folderItems(nodes: PinnedNode[], depth: number, run: (f: Folder) => TabsMenuRun, except?: string): TabsMenuItem[] {
  return nodes.flatMap((n) =>
    n.kind !== 'folder' || n.id === except
      ? []
      : [{ label: `${' '.repeat(depth)}${n.name}`, run: run(n) }, ...folderItems(n.children, depth + 1, run, except)],
  );
}
