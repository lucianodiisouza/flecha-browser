import type { PinnedNode, TabPlacement, TabsEdit, TabsView } from '../../shared/types';
import type { IconName } from './icons.js';
import { SPACE_COLORS, SPACE_EMOJIS } from './spaceChoices.js';
import { shownSpaceColor } from '../lib/spaceTint';

/**
 * Settings → Tabs & Spaces: favorites and every Space's pinned tree and Today tabs in one
 * editable list, like a bookmarks manager. Every change goes to the main process, which answers
 * with a fresh view; changes made in the sidebar arrive the same way, through `onTabs`.
 */

type Tab = TabsView['tabs'][string];
type Space = TabsView['spaces'][number];
type Folder = Extract<PinnedNode, { kind: 'folder' }>;

/** A row being edited in place. `add` is the new-tab row at the end of a list. */
type Editing =
  | { kind: 'tab'; id: string; focus: 'title' | 'url' }
  | { kind: 'folder'; id: string }
  | { kind: 'space'; id: string }
  | { kind: 'add'; list: string };

type Drag = { kind: 'tabs'; ids: string[] } | { kind: 'folder'; id: string } | { kind: 'space'; id: string };

type Props = Record<string, unknown>;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Array<Node | string | null | undefined | false>) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') node.style.cssText = String(value);
    else if (key === 'value') (node as HTMLInputElement).value = String(value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child != null && child !== false) node.append(child);
  return node;
}

function host(url: string) {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, '') || u.protocol.replace(':', '');
  } catch {
    return url;
  }
}

/** A stable colour per site, so placeholder icons are told apart at a glance (as in the sidebar). */
function hueFor(text: string) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function label(tab: Tab) {
  return tab.customTitle || tab.title || tab.url;
}

function tabCount(nodes: PinnedNode[]): number {
  return nodes.reduce((n, node) => n + (node.kind === 'tab' ? 1 : tabCount(node.children)), 0);
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function setupTabsPane(icon: (name: IconName) => SVGSVGElement) {
  const api = window.settings;
  const pane = document.querySelector<HTMLElement>('.pane[data-pane="tabs-spaces"]')!;
  const tree = document.getElementById('tm-tree')!;
  const search = document.getElementById('tm-search') as HTMLInputElement;
  const selectionBar = document.getElementById('tm-selection')!;
  const selectionCount = document.getElementById('tm-selection-count')!;

  let view: TabsView | undefined;
  /** A view that arrived mid-edit or mid-drag; drawn once that's over. */
  let pending: TabsView | undefined;
  let query = '';
  /** Row keys: `t:<tabId>` or `f:<folderId>`. A folder is only ever selected on its own. */
  let selected = new Set<string>();
  let anchor: string | undefined;
  /** Where the arrow keys are; differs from the anchor while ⇧ grows a range. */
  let cursor: string | undefined;
  let editing: Editing | undefined;
  let drag: Drag | undefined;
  let drop: { edit: TabsEdit; target: HTMLElement; cls: string } | undefined;
  /** Collapsed folders and Spaces. Folders start as they are in the sidebar. */
  const collapsed = new Set<string>();
  const seenFolders = new Set<string>();
  /** Visible rows in order, for ⇧-click ranges and the arrow keys. */
  let order: string[] = [];
  /** Each rendered list's placement, by its key. */
  const lists = new Map<string, TabPlacement>();

  const iconButton = (name: IconName, title: string, onclick: (e: MouseEvent) => void, cls = '') =>
    el('button', { class: `tm-icon-button ${cls}`, title, 'aria-label': title, onclick }, icon(name));

  function favicon(tab: Tab) {
    const site = host(tab.homeUrl ?? tab.url);
    const letter = () => el('span', { class: 'tm-favicon letter', style: `--hue: ${hueFor(site)}` }, (site.replace(/^[^a-z0-9]+/i, '')[0] ?? '•').toUpperCase());
    let hostname = '';
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      // Not a web page.
    }
    // The page's own icon once it has loaded, else the icon Flecha fetched for the site.
    const src = tab.favicon || (view?.faviconHosts.includes(hostname) ? `favicon://${hostname}` : undefined);
    if (!src) return letter();
    const img = el('img', { class: 'tm-favicon', src, draggable: 'false', alt: '' });
    img.onerror = () => img.replaceWith(letter());
    return img;
  }

  // ---- rendering --------------------------------------------------------------------

  function matches(id: string) {
    const tab = view?.tabs[id];
    if (!tab) return false;
    const q = query.trim().toLowerCase();
    return !q || [tab.customTitle, tab.title, tab.url, tab.homeUrl].some((s) => s?.toLowerCase().includes(q));
  }

  function render() {
    if (!view) return;
    const hadFocus = tree.contains(document.activeElement);
    const scroll = pane.parentElement!.scrollTop;
    order = [];
    lists.clear();
    const searching = !!query.trim();
    const groups: HTMLElement[] = [];

    const favorites = view.favorites.filter(matches);
    if (!searching || favorites.length) {
      groups.push(
        el(
          'div',
          { class: 'tm-group favorites' },
          el(
            'div',
            { class: 'tm-group-head' },
            el('span', { class: 'tm-group-icon' }, icon('star')),
            el('h2', {}, 'Favorites'),
            el('span', { class: 'tm-count' }, String(view.favorites.length)),
            el('span', { class: 'tm-head-actions' }, iconButton('plus', 'Add a favorite', () => startAdd('favorites'))),
          ),
          el('div', { class: 'card tm-card' }, list('favorites', { zone: 'favorites' }, favorites.map((id) => tabRow(id, 0)), 0, 'Favorites stay in every Space. Drag tabs here.')),
        ),
      );
    }

    for (const space of view.spaces) {
      const pinned = pinnedRows(space, space.pinned, 0);
      const today = space.today.filter(matches).map((id) => tabRow(id, 0));
      if (searching && !pinned.length && !today.length) continue;
      groups.push(spaceGroup(space, pinned, today));
    }

    if (searching && !groups.length) groups.push(el('p', { class: 'tm-none' }, `No tabs match “${query.trim()}”.`));
    tree.replaceChildren(...groups);
    pane.parentElement!.scrollTop = scroll;

    // Forget selected rows that are gone (deleted here or in the sidebar).
    selected = new Set([...selected].filter((key) => order.includes(key)));
    if (anchor && !order.includes(anchor)) anchor = undefined;
    updateSelection();
    if (hadFocus && !editing) rowFor(anchor ?? [...selected][0])?.focus({ preventScroll: true });
    focusEditor();
  }

  function spaceGroup(space: Space, pinned: HTMLElement[], today: HTMLElement[]) {
    const open = !collapsed.has(space.id) || !!query.trim();
    const pinnedCount = tabCount(space.pinned);
    const name =
      editing?.kind === 'space' && editing.id === space.id
        ? nameEditor(space.name, 'Space name', 40, (value) => send({ op: 'updateSpace', spaceId: space.id, name: value }))
        : el('h2', { class: 'tm-space-name', ondblclick: () => startEditing({ kind: 'space', id: space.id }) }, space.name);
    const head = el(
      'div',
      { class: 'tm-group-head tm-space-head', draggable: 'true', dataset: { space: space.id } },
      el('button', { class: `tm-disclosure${open ? ' open' : ''}`, title: open ? 'Collapse' : 'Expand', onclick: () => toggle(space.id) }, icon('chevron')),
      el(
        'button',
        { class: 'tm-space-badge', style: `--space: ${shownSpaceColor(space.color)}`, title: 'Icon and colour', onclick: (e: MouseEvent) => openSpaceEditor(space.id, e.currentTarget as HTMLElement) },
        space.emoji || space.name[0]?.toUpperCase() || '•',
      ),
      name,
      space.isolated ? el('span', { class: 'tm-tag', title: 'Separate cookies and logins' }, icon('lock')) : null,
      space.id === view!.activeSpaceId ? el('span', { class: 'tm-tag text' }, 'Current') : null,
      el('span', { class: 'tm-count' }, String(pinnedCount + space.today.length)),
      el(
        'span',
        { class: 'tm-head-actions' },
        iconButton('pencil', 'Edit Space', (e) => openSpaceEditor(space.id, (e.currentTarget as HTMLElement).closest('.tm-space-head')!.querySelector('.tm-space-badge')!)),
        iconButton('trash', 'Delete Space…', () => send({ op: 'deleteSpace', spaceId: space.id }), view!.spaces.length < 2 ? 'hidden' : ''),
      ),
    );
    // While searching, a section without matches would only be an empty heading.
    const searching = !!query.trim();
    const body = open
      ? el(
          'div',
          { class: 'card tm-card' },
          (!searching || pinned.length > 0) &&
            sectionLabel(
              'Pinned',
              pinnedCount,
              `p:${space.id}`,
              iconButton('folderPlus', 'New folder', () => newFolder(space.id)),
              iconButton('plus', 'Add a pinned tab', () => startAdd(`p:${space.id}`)),
            ),
          (!searching || pinned.length > 0) &&
            list(`p:${space.id}`, { zone: 'pinned', spaceId: space.id }, pinned, 0, 'Pinned tabs stay put and come back to their address. Drag tabs here.'),
          (!searching || today.length > 0) &&
            sectionLabel('Today', space.today.length, `d:${space.id}`, iconButton('plus', 'Add a Today tab', () => startAdd(`d:${space.id}`))),
          (!searching || today.length > 0) && list(`d:${space.id}`, { zone: 'today', spaceId: space.id }, today, 0, 'No Today tabs.'),
        )
      : null;
    return el('div', { class: `tm-group space${open ? '' : ' collapsed'}`, dataset: { space: space.id } }, head, body);
  }

  function sectionLabel(text: string, count: number, listKey: string, ...actions: HTMLElement[]) {
    return el(
      'div',
      { class: 'tm-label', dataset: { list: listKey } },
      el('span', {}, text),
      el('span', { class: 'tm-count' }, String(count)),
      el('span', { class: 'tm-head-actions' }, ...actions),
    );
  }

  function list(key: string, to: TabPlacement, rows: HTMLElement[], depth: number, empty: string) {
    lists.set(key, to);
    const node = el('div', { class: 'tm-list', dataset: { list: key, ...(to.zone === 'pinned' && to.folderId ? { folder: to.folderId } : {}) } }, ...rows);
    if (!rows.length && !query.trim()) node.append(el('div', { class: 'tm-empty', style: `--depth: ${depth}` }, empty));
    if (editing?.kind === 'add' && editing.list === key) node.append(addRow(to, depth));
    return node;
  }

  function pinnedRows(space: Space, nodes: PinnedNode[], depth: number, all = false): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const node of nodes) {
      if (node.kind === 'tab') {
        if (all || matches(node.tabId)) rows.push(tabRow(node.tabId, depth));
        continue;
      }
      if (!seenFolders.has(node.id)) {
        seenFolders.add(node.id);
        if (!node.open) collapsed.add(node.id);
      }
      const q = query.trim().toLowerCase();
      const nameMatches = !!q && node.name.toLowerCase().includes(q);
      // Searching opens folders that hold a match; a folder whose name matches shows everything in it.
      const key = `f:${node.id}`;
      order.push(key);
      const children = q ? pinnedRows(space, node.children, depth + 1, all || nameMatches) : [];
      if (q && !all && !nameMatches && !children.length) {
        order.pop();
        continue;
      }
      const open = q ? true : !collapsed.has(node.id);
      rows.push(folderRow(node, depth, open));
      if (open) {
        const inner = q ? children : pinnedRows(space, node.children, depth + 1);
        rows.push(list(key, { zone: 'pinned', spaceId: space.id, folderId: node.id }, inner, depth + 1, 'Empty folder'));
      }
    }
    return rows;
  }

  function folderRow(folder: Folder, depth: number, open: boolean) {
    const key = `f:${folder.id}`;
    const count = tabCount(folder.children);
    const name =
      editing?.kind === 'folder' && editing.id === folder.id
        ? nameEditor(folder.name, 'Folder name', 80, (value) => send({ op: 'renameFolder', folderId: folder.id, name: value }))
        : el('span', { class: 'tm-title' }, folder.name);
    return el(
      'div',
      { class: `tm-row folder${selected.has(key) ? ' selected' : ''}`, tabindex: '-1', draggable: 'true', dataset: { key, id: folder.id }, style: `--depth: ${depth}` },
      el('button', { class: `tm-disclosure${open ? ' open' : ''}`, title: open ? 'Collapse' : 'Expand', onclick: () => toggle(folder.id) }, icon('chevron')),
      el('span', { class: 'tm-folder-icon' }, icon(open ? 'folderOpen' : 'folder')),
      name,
      el('span', { class: 'tm-host' }, plural(count, 'tab')),
      el(
        'span',
        { class: 'tm-actions' },
        iconButton('plus', 'Add a tab to this folder', () => {
          collapsed.delete(folder.id);
          startAdd(key);
        }),
        iconButton('pencil', 'Rename', () => startEditing({ kind: 'folder', id: folder.id })),
        iconButton('trash', 'Delete folder…', () => send({ op: 'deleteFolder', folderId: folder.id })),
      ),
    );
  }

  function tabRow(id: string, depth: number) {
    const tab = view!.tabs[id];
    const key = `t:${id}`;
    order.push(key);
    if (editing?.kind === 'tab' && editing.id === id) return tabEditor(tab, depth);
    return el(
      'div',
      { class: `tm-row tab${selected.has(key) ? ' selected' : ''}`, tabindex: '-1', draggable: 'true', dataset: { key, id }, style: `--depth: ${depth}`, title: tab.url },
      el('span', { class: 'tm-disclosure-space' }),
      favicon(tab),
      el('span', { class: 'tm-title' }, label(tab)),
      el('span', { class: 'tm-host' }, host(tab.homeUrl ?? tab.url)),
      tab.open ? el('span', { class: 'tm-open', title: 'Open in the browser' }) : null,
      el(
        'span',
        { class: 'tm-actions' },
        iconButton('external', 'Show in Flecha', () => api.showTab(id)),
        iconButton('pencil', 'Edit', () => startEditing({ kind: 'tab', id, focus: 'title' })),
        iconButton('trash', 'Delete', () => send({ op: 'delete', tabIds: [id] })),
      ),
    );
  }

  // ---- editing in place -------------------------------------------------------------

  /** Enter or leaving the fields saves; Esc puts things back. */
  function wireEditor(inputs: HTMLInputElement[], save: () => Promise<string | undefined | void>) {
    let done = false;
    const finish = async (keep: boolean) => {
      if (done) return;
      done = true;
      const error = keep ? await save() : undefined;
      if (error) {
        done = false;
        const row = inputs[0].closest('.tm-editor')!;
        row.classList.add('invalid');
        row.querySelector('.tm-error')?.remove();
        row.append(el('span', { class: 'tm-error' }, error));
        inputs[inputs.length > 1 ? 1 : 0].focus();
        return;
      }
      editing = undefined;
      flushPending();
    };
    for (const input of inputs) {
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') void finish(true);
        else if (e.key === 'Escape') void finish(false);
      });
      input.addEventListener('blur', (e) => {
        // Moving between the fields of the same row isn't leaving it.
        if (!inputs.includes(e.relatedTarget as HTMLInputElement)) void finish(true);
      });
      input.addEventListener('input', () => input.closest('.tm-editor')?.classList.remove('invalid'));
    }
  }

  function nameEditor(value: string, placeholder: string, max: number, save: (value: string) => Promise<unknown>) {
    const input = el('input', { class: 'tm-input name', value, placeholder, maxlength: String(max), spellcheck: 'false', 'data-autofocus': '' });
    wireEditor([input], async () => {
      if (input.value.trim() && input.value.trim() !== value) await save(input.value.trim());
    });
    return el('span', { class: 'tm-editor inline' }, input);
  }

  function tabEditor(tab: Tab, depth: number) {
    const address = tab.homeUrl ?? tab.url;
    const focus = editing?.kind === 'tab' ? editing.focus : 'title';
    const title = el('input', { class: 'tm-input', value: label(tab), placeholder: 'Title', spellcheck: 'false', ...(focus === 'title' ? { 'data-autofocus': '' } : {}) });
    const url = el('input', { class: 'tm-input url', value: address, placeholder: 'example.com', spellcheck: 'false', ...(focus === 'url' ? { 'data-autofocus': '' } : {}) });
    wireEditor([title, url], async () => {
      if (url.value.trim() !== address) {
        const result = await api.editTabs({ op: 'setUrl', tabId: tab.id, url: url.value });
        if (result.error) return result.error;
      }
      if (title.value.trim() !== label(tab)) await api.editTabs({ op: 'renameTab', tabId: tab.id, title: title.value });
      pending = (await api.tabs()) ?? pending;
    });
    return el('div', { class: 'tm-row tm-editor', style: `--depth: ${depth}` }, el('span', { class: 'tm-disclosure-space' }), favicon(tab), title, url);
  }

  function addRow(to: TabPlacement, depth: number) {
    const url = el('input', { class: 'tm-input url', placeholder: 'example.com', spellcheck: 'false', 'data-autofocus': '' });
    const title = el('input', { class: 'tm-input', placeholder: 'Title (optional)', spellcheck: 'false' });
    wireEditor([url, title], async () => {
      if (!url.value.trim()) return;
      const result = await api.editTabs({ op: 'add', url: url.value, title: title.value, to });
      if (result.error) return result.error;
      if (result.created) {
        selected = new Set([`t:${result.created}`]);
        anchor = `t:${result.created}`;
      }
      pending = result.view;
    });
    return el(
      'div',
      { class: 'tm-row tm-editor adding', style: `--depth: ${depth}` },
      el('span', { class: 'tm-disclosure-space' }),
      el('span', { class: 'tm-favicon placeholder' }, icon('globe')),
      url,
      title,
    );
  }

  function focusEditor() {
    const input = tree.querySelector<HTMLInputElement>('[data-autofocus]');
    if (!input || document.activeElement === input) return;
    input.focus();
    input.select();
    input.closest('.tm-row, .tm-group-head')?.scrollIntoView({ block: 'nearest' });
  }

  function startEditing(next: Editing) {
    editing = next;
    render();
  }

  function startAdd(listKey: string) {
    if (listKey.startsWith('p:') || listKey.startsWith('d:')) collapsed.delete(listKey.slice(2));
    startEditing({ kind: 'add', list: listKey });
  }

  async function newFolder(spaceId: string, parentId?: string) {
    const result = await api.editTabs({ op: 'newFolder', spaceId, parentId });
    view = result.view;
    if (result.created) startEditing({ kind: 'folder', id: result.created });
    else render();
  }

  function toggle(id: string) {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    render();
  }

  // ---- talking to main --------------------------------------------------------------

  async function send(edit: TabsEdit) {
    const result = await api.editTabs(edit);
    show(result.view);
    return result;
  }

  function show(next: TabsView) {
    if (editing || drag) {
      pending = next;
      return;
    }
    view = next;
    pending = undefined;
    render();
    refreshSpaceEditor();
  }

  function flushPending() {
    if (pending) {
      const next = pending;
      pending = undefined;
      show(next);
    } else render();
  }

  // ---- selection ----------------------------------------------------------------------

  function rowFor(key: string | undefined) {
    return key ? tree.querySelector<HTMLElement>(`.tm-row[data-key="${CSS.escape(key)}"]`) : null;
  }

  function selectedTabIds() {
    return order.filter((key) => selected.has(key) && key.startsWith('t:')).map((key) => key.slice(2));
  }

  function selectedFolder() {
    const key = [...selected].find((k) => k.startsWith('f:'));
    return key?.slice(2);
  }

  function updateSelection() {
    for (const row of tree.querySelectorAll<HTMLElement>('.tm-row[data-key]')) row.classList.toggle('selected', selected.has(row.dataset.key!));
    const tabs = selectedTabIds().length;
    const folder = selectedFolder();
    selectionBar.hidden = !tabs && !folder;
    selectionCount.textContent = folder ? '1 folder' : plural(tabs, 'tab');
  }

  function select(key: string, e: { metaKey?: boolean; shiftKey?: boolean }) {
    const isTab = key.startsWith('t:');
    if (isTab && e.shiftKey && anchor?.startsWith('t:')) {
      const [a, b] = [order.indexOf(anchor), order.indexOf(key)].sort((x, y) => x - y);
      selected = new Set(order.slice(a, b + 1).filter((k) => k.startsWith('t:')));
    } else if (isTab && e.metaKey) {
      if (selectedFolder()) selected.clear();
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      anchor = key;
    } else {
      selected = new Set([key]);
      anchor = key;
    }
    cursor = key;
    updateSelection();
  }

  function clearSelection() {
    selected.clear();
    anchor = cursor = undefined;
    updateSelection();
  }

  function deleteSelection() {
    const folder = selectedFolder();
    if (folder) return void send({ op: 'deleteFolder', folderId: folder });
    const ids = selectedTabIds();
    if (!ids.length) return;
    // Keep the place in the list: the row after the deleted ones becomes the selection.
    const last = order.indexOf(`t:${ids[ids.length - 1]}`);
    const next = order.slice(last + 1).find((k) => k.startsWith('t:') && !ids.includes(k.slice(2)));
    selected = new Set(next ? [next] : []);
    anchor = next;
    void send({ op: 'delete', tabIds: ids });
  }

  async function contextMenu(request: { tabIds?: string[]; folderId?: string; context?: boolean }) {
    const action = await api.tabsMenu(request);
    if (!action) return;
    if (request.folderId) startEditing({ kind: 'folder', id: request.folderId });
    else if (request.tabIds?.length === 1) startEditing({ kind: 'tab', id: request.tabIds[0], focus: action === 'edit' ? 'url' : 'title' });
  }

  tree.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input')) return;
    const row = target.closest<HTMLElement>('.tm-row[data-key]');
    if (row) select(row.dataset.key!, e);
    else if (!e.metaKey && !e.shiftKey) clearSelection();
  });

  tree.addEventListener('dblclick', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.tm-row[data-key]');
    if (!row || (e.target as HTMLElement).closest('button, input')) return;
    const id = row.dataset.id!;
    startEditing(row.classList.contains('folder') ? { kind: 'folder', id } : { kind: 'tab', id, focus: 'title' });
  });

  tree.addEventListener('contextmenu', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.tm-row[data-key]');
    if (!row) return;
    e.preventDefault();
    const key = row.dataset.key!;
    if (!selected.has(key)) select(key, {});
    const folder = selectedFolder();
    void contextMenu(folder ? { folderId: folder, context: true } : { tabIds: selectedTabIds(), context: true });
  });

  document.getElementById('tm-move')!.addEventListener('click', () => {
    const folder = selectedFolder();
    void contextMenu(folder ? { folderId: folder } : { tabIds: selectedTabIds() });
  });
  document.getElementById('tm-delete')!.addEventListener('click', deleteSelection);
  document.getElementById('tm-new-space')!.addEventListener('click', async () => {
    const result = await api.editTabs({ op: 'newSpace' });
    view = result.view;
    query = search.value = '';
    if (result.created) {
      startEditing({ kind: 'space', id: result.created });
      tree.querySelector(`.tm-group.space[data-space="${CSS.escape(result.created)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else render();
  });

  search.addEventListener('input', () => {
    query = search.value;
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      query = search.value = '';
      render();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = order[0];
      if (first) {
        select(first, {});
        rowFor(first)?.focus();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (pane.hidden || editing || spaceEditor) return;
    if (e.metaKey && e.key === 'f') {
      e.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.metaKey && e.key === 'a') {
      e.preventDefault();
      selected = new Set(order.filter((k) => k.startsWith('t:')));
      updateSelection();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === 'Enter' && selected.size === 1) {
      e.preventDefault();
      const key = [...selected][0];
      const id = key.slice(2);
      startEditing(key.startsWith('f:') ? { kind: 'folder', id } : { kind: 'tab', id, focus: 'title' });
    } else if (e.key === 'Escape' && selected.size) {
      clearSelection();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = order.indexOf(cursor ?? anchor ?? '');
      const next = order[at < 0 ? 0 : Math.min(order.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (!next) return;
      // ⇧ grows the selection from the anchor; the cursor is the end that moves.
      if (e.shiftKey && next.startsWith('t:') && anchor?.startsWith('t:')) {
        const [a, b] = [order.indexOf(anchor), order.indexOf(next)].sort((x, y) => x - y);
        selected = new Set(order.slice(a, b + 1).filter((k) => k.startsWith('t:')));
        updateSelection();
      } else select(next, {});
      cursor = next;
      const row = rowFor(next);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: 'nearest' });
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && anchor?.startsWith('f:')) {
      const id = anchor.slice(2);
      if (collapsed.has(id) === (e.key === 'ArrowRight')) toggle(id);
    }
  });

  // ---- drag and drop ------------------------------------------------------------------

  function clearDrop() {
    drop?.target.classList.remove(drop.cls);
    drop = undefined;
  }

  /** The next row in the same list that isn't being dragged: what to insert before when dropping after `row`. */
  function nextRowId(row: HTMLElement): string | undefined {
    const dragged = drag?.kind === 'tabs' ? drag.ids : drag?.kind === 'folder' ? [drag.id] : [];
    for (let next = row.nextElementSibling as HTMLElement | null; next; next = next.nextElementSibling as HTMLElement | null) {
      if (next.classList.contains('tm-row') && next.dataset.id && !dragged.includes(next.dataset.id)) return next.dataset.id;
    }
    return undefined;
  }

  function firstRowId(listEl: HTMLElement | null) {
    const first = listEl?.querySelector<HTMLElement>(':scope > .tm-row[data-id]');
    if (!first) return undefined;
    return drag?.kind === 'tabs' && drag.ids.includes(first.dataset.id!) ? nextRowId(first) : first.dataset.id;
  }

  /** The move that dropping into `listKey` before `beforeId` makes; folders only go into pinned lists. */
  function moveInto(listKey: string, beforeId?: string): TabsEdit | undefined {
    const to = lists.get(listKey);
    if (!to || !drag) return undefined;
    if (drag.kind === 'tabs') return { op: 'move', tabIds: drag.ids, to: { ...to, beforeId } };
    if (drag.kind !== 'folder' || to.zone !== 'pinned') return undefined;
    // Never into itself.
    if (to.folderId === drag.id || tree.querySelector(`.tm-list[data-folder="${CSS.escape(drag.id)}"] .tm-list[data-list="f:${CSS.escape(to.folderId ?? '')}"]`)) return undefined;
    return { op: 'moveFolder', folderId: drag.id, to: { spaceId: to.spaceId, folderId: to.folderId, beforeId } };
  }

  function dropFor(e: DragEvent): typeof drop {
    if (!drag) return undefined;
    const target = e.target as HTMLElement;

    if (drag.kind === 'space') {
      const group = target.closest<HTMLElement>('.tm-group.space');
      if (!group || group.dataset.space === drag.id) return undefined;
      const r = group.getBoundingClientRect();
      const after = e.clientY > r.top + Math.min(r.height / 2, 40);
      const spaces = view!.spaces.map((s) => s.id);
      const beforeSpaceId = after ? spaces[spaces.indexOf(group.dataset.space!) + 1] : group.dataset.space;
      return { edit: { op: 'moveSpace', spaceId: drag.id, beforeSpaceId }, target: group, cls: after ? 'drop-after' : 'drop-before' };
    }

    const head = target.closest<HTMLElement>('.tm-space-head');
    if (head) {
      // Dropped on a Space's name: Today for tabs, the end of its pinned tabs for a folder.
      const spaceId = head.dataset.space!;
      const edit: TabsEdit =
        drag.kind === 'tabs' ? { op: 'move', tabIds: drag.ids, to: { zone: 'today', spaceId } } : { op: 'moveFolder', folderId: drag.id, to: { spaceId } };
      return { edit, target: head, cls: 'drop-into' };
    }

    const sectionLabel = target.closest<HTMLElement>('.tm-label');
    if (sectionLabel) {
      const key = sectionLabel.dataset.list!;
      const edit = moveInto(key, firstRowId(tree.querySelector(`.tm-list[data-list="${CSS.escape(key)}"]`)));
      return edit && { edit, target: sectionLabel, cls: 'drop-after' };
    }

    const empty = target.closest<HTMLElement>('.tm-empty');
    if (empty) {
      const edit = moveInto(empty.closest<HTMLElement>('.tm-list')!.dataset.list!);
      return edit && { edit, target: empty, cls: 'drop-into' };
    }

    const groupHead = target.closest<HTMLElement>('.tm-group.favorites .tm-group-head');
    if (groupHead) {
      const edit = moveInto('favorites', firstRowId(tree.querySelector('.tm-list[data-list="favorites"]')));
      return edit && { edit, target: groupHead, cls: 'drop-into' };
    }

    const row = target.closest<HTMLElement>('.tm-row[data-key]');
    if (!row) return undefined;
    const listEl = row.parentElement!;
    const key = listEl.dataset.list!;
    const id = row.dataset.id!;
    if (drag.kind === 'folder' && (id === drag.id || row.closest(`.tm-list[data-folder="${CSS.escape(drag.id)}"]`))) return undefined;
    if (drag.kind === 'tabs' && drag.ids.includes(id)) return undefined;
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (row.classList.contains('folder') && y > 0.25 && y < 0.75) {
      const edit = moveInto(`f:${id}`) ?? (lists.has(`f:${id}`) ? undefined : intoClosedFolder(id));
      return edit && { edit, target: row, cls: 'drop-into' };
    }
    const before = y < 0.5;
    const edit = moveInto(key, before ? id : nextRowId(row));
    return edit && { edit, target: row, cls: before ? 'drop-before' : 'drop-after' };
  }

  /** A collapsed folder has no rendered list; its placement is built from its row. */
  function intoClosedFolder(folderId: string): TabsEdit | undefined {
    const spaceId = tree.querySelector<HTMLElement>(`.tm-row[data-key="f:${CSS.escape(folderId)}"]`)?.closest<HTMLElement>('.tm-group.space')?.dataset.space;
    if (!spaceId || !drag) return undefined;
    if (drag.kind === 'tabs') return { op: 'move', tabIds: drag.ids, to: { zone: 'pinned', spaceId, folderId } };
    if (drag.kind === 'folder' && drag.id !== folderId) return { op: 'moveFolder', folderId: drag.id, to: { spaceId, folderId } };
    return undefined;
  }

  tree.addEventListener('dragstart', (e) => {
    const target = e.target as HTMLElement;
    if (editing || target.closest('input')) return e.preventDefault();
    const head = target.closest<HTMLElement>('.tm-space-head');
    const row = target.closest<HTMLElement>('.tm-row[data-key]');
    if (head) drag = { kind: 'space', id: head.dataset.space! };
    else if (row?.classList.contains('folder')) {
      select(row.dataset.key!, {});
      drag = { kind: 'folder', id: row.dataset.id! };
    } else if (row) {
      if (!selected.has(row.dataset.key!)) select(row.dataset.key!, {});
      drag = { kind: 'tabs', ids: selectedTabIds() };
    } else return;
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', '');
    if (drag.kind === 'tabs' && drag.ids.length > 1) {
      // Several tabs travel as one small badge rather than a picture of a single row.
      const badge = el('div', { class: 'tm-drag-badge' }, plural(drag.ids.length, 'tab'));
      document.body.append(badge);
      e.dataTransfer!.setDragImage(badge, 12, 12);
      setTimeout(() => badge.remove());
    }
    tree.classList.add('dragging');
    // After the drag image is taken, dim what's moving.
    requestAnimationFrame(() => {
      if (drag?.kind === 'tabs') for (const id of drag.ids) rowFor(`t:${id}`)?.classList.add('dragged');
      else if (drag?.kind === 'folder') rowFor(`f:${drag.id}`)?.classList.add('dragged');
      else if (drag?.kind === 'space') tree.querySelector(`.tm-group.space[data-space="${CSS.escape(drag.id)}"]`)?.classList.add('dragged');
    });
  });

  tree.addEventListener('dragover', (e) => {
    const next = dropFor(e);
    if (next?.target !== drop?.target || next?.cls !== drop?.cls) {
      clearDrop();
      if (next) next.target.classList.add(next.cls);
    }
    drop = next;
    if (!next) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
  });

  tree.addEventListener('dragleave', (e) => {
    if (!tree.contains(e.relatedTarget as Node)) clearDrop();
  });

  tree.addEventListener('drop', (e) => {
    e.preventDefault();
    const edit = drop?.edit;
    clearDrop();
    endDrag();
    if (edit) void send(edit);
  });

  tree.addEventListener('dragend', () => {
    clearDrop();
    endDrag();
  });

  function endDrag() {
    if (!drag) return;
    drag = undefined;
    tree.classList.remove('dragging');
    for (const node of tree.querySelectorAll('.dragged')) node.classList.remove('dragged');
    if (pending) flushPending();
  }

  // ---- Space editor: name, icon and colour -----------------------------------------------

  let spaceEditor: { spaceId: string; anchor: HTMLElement; node: HTMLElement } | undefined;

  function openSpaceEditor(spaceId: string, anchorEl: HTMLElement) {
    closeSpaceEditor();
    const node = el('div', { class: 'tm-popover', role: 'dialog', 'aria-label': 'Edit Space' });
    document.body.append(node);
    spaceEditor = { spaceId, anchor: anchorEl, node };
    refreshSpaceEditor();
    node.querySelector<HTMLInputElement>('.tm-pop-name')?.select();
    node.querySelector<HTMLInputElement>('.tm-pop-name')?.focus();
  }

  function closeSpaceEditor() {
    spaceEditor?.node.remove();
    spaceEditor = undefined;
  }

  function refreshSpaceEditor() {
    if (!spaceEditor) return;
    const { node, spaceId } = spaceEditor;
    const space = view?.spaces.find((s) => s.id === spaceId);
    if (!space) return closeSpaceEditor();
    const update = (patch: { name?: string; emoji?: string; color?: string }) => send({ op: 'updateSpace', spaceId, ...patch });

    let name = node.querySelector<HTMLInputElement>('.tm-pop-name');
    let emoji = node.querySelector<HTMLInputElement>('.tm-pop-emoji');
    if (!name || !emoji) {
      name = el('input', { class: 'tm-pop-name', maxlength: '40', placeholder: 'Space name', spellcheck: 'false' });
      emoji = el('input', { class: 'tm-pop-emoji', title: 'Choose any emoji', spellcheck: 'false' });
      name.addEventListener('change', () => name!.value.trim() && update({ name: name!.value }));
      name.addEventListener('keydown', (e) => e.key === 'Enter' && name!.blur());
      // The macOS emoji picker types into this field; keep its last emoji.
      emoji.addEventListener('focus', () => void api.showEmojiPanel());
      emoji.addEventListener('input', () => {
        const chars = [...emoji!.value.trim()];
        void update({ emoji: chars.slice(-1).join('') });
      });
      node.append(
        el('div', { class: 'tm-pop-row' }, emoji, name),
        el('div', { class: 'tm-pop-label' }, 'Icon'),
        el('div', { class: 'tm-pop-emojis' }),
        el('div', { class: 'tm-pop-label' }, 'Colour'),
        el('div', { class: 'tm-pop-swatches' }),
        el(
          'footer',
          { class: 'tm-pop-footer' },
          el('button', { class: 'button danger tm-pop-delete', onclick: () => send({ op: 'deleteSpace', spaceId }) }, 'Delete Space…'),
          el('button', { class: 'button primary', onclick: closeSpaceEditor }, 'Done'),
        ),
      );
    }
    if (document.activeElement !== name) name.value = space.name;
    if (document.activeElement !== emoji) emoji.value = space.emoji ?? '';
    node.querySelector('.tm-pop-emojis')!.replaceChildren(
      el('button', { class: `tm-emoji${space.emoji ? '' : ' selected'}`, title: 'No icon', onclick: () => update({ emoji: '' }) }, icon('close')),
      ...SPACE_EMOJIS.map((e) => el('button', { class: `tm-emoji${space.emoji === e ? ' selected' : ''}`, onclick: () => update({ emoji: e }) }, e)),
    );
    // The custom swatch and its input stay across renders: replacing the input closed its
    // colour picker at the first click (see the sidebar's Space editor).
    const swatches = node.querySelector<HTMLElement>('.tm-pop-swatches')!;
    let customSwatch = swatches.querySelector<HTMLLabelElement>('label.custom');
    if (!customSwatch) {
      const input = el('input', { type: 'color', value: space.color, title: 'Custom colour' });
      input.addEventListener('input', () => update({ color: input.value }));
      customSwatch = el('label', { title: 'Custom colour' }, input) as HTMLLabelElement;
      swatches.append(customSwatch);
    }
    customSwatch.className = `tm-swatch custom${SPACE_COLORS.includes(space.color) ? '' : ' selected'}`;
    customSwatch.style.setProperty('--swatch', shownSpaceColor(space.color));
    const customInput = customSwatch.querySelector('input')!;
    if (document.activeElement !== customInput && customInput.value !== space.color) customInput.value = space.color;
    for (const swatch of swatches.querySelectorAll('button.tm-swatch')) swatch.remove();
    customSwatch.before(
      ...SPACE_COLORS.map((color) =>
        el('button', { class: `tm-swatch${space.color === color ? ' selected' : ''}`, style: `--swatch: ${shownSpaceColor(color)}`, title: color, onclick: () => update({ color }) }),
      ),
    );
    (node.querySelector('.tm-pop-delete') as HTMLButtonElement).disabled = view!.spaces.length < 2;
    placeSpaceEditor();
  }

  /** Under the Space's badge, kept inside the window. The badge is redrawn with the tree, so find it again. */
  function placeSpaceEditor() {
    if (!spaceEditor) return;
    const { node, spaceId } = spaceEditor;
    const anchorEl = spaceEditor.anchor.isConnected
      ? spaceEditor.anchor
      : tree.querySelector<HTMLElement>(`.tm-space-head[data-space="${CSS.escape(spaceId)}"] .tm-space-badge`);
    if (!anchorEl) return;
    spaceEditor.anchor = anchorEl;
    const r = anchorEl.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    node.style.left = `${Math.max(12, Math.min(r.left - 8, innerWidth - width - 12))}px`;
    node.style.top = `${r.bottom + 8 + height > innerHeight - 12 ? Math.max(12, r.top - height - 8) : r.bottom + 8}px`;
  }

  document.addEventListener('mousedown', (e) => {
    if (spaceEditor && !spaceEditor.node.contains(e.target as Node) && !(e.target as HTMLElement).closest('.tm-space-badge, .tm-head-actions')) closeSpaceEditor();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && spaceEditor) {
      e.stopPropagation();
      closeSpaceEditor();
    }
  });
  pane.parentElement!.addEventListener('scroll', placeSpaceEditor);
  window.addEventListener('resize', placeSpaceEditor);
  for (const item of document.querySelectorAll<HTMLElement>('.nav-item')) item.addEventListener('click', closeSpaceEditor);

  api.onTabs(show);
  void api.tabs().then(show);
}
