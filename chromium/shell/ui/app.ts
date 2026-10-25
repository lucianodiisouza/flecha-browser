import { devSuggestions } from './devCommands.js';
import { ICONS, type IconName } from './icons.js';
import { setupOnboarding } from './onboarding.js';
import { SPACE_COLORS, SPACE_EMOJIS } from './spaceChoices.js';
import type { DownloadInfo, DropTarget, FlechaApi, HistoryEntry, PaletteMode, PeekState, PinnedNode, Space, TabInfo, UiState } from '../../shared/types';

declare global {
  interface Window {
    flecha: FlechaApi;
  }
}

const api = window.flecha;
/** Where this page is shown: the Electron window (unset), or the Chromium build's side panel or new tab page. */
const surface = document.documentElement.dataset.surface as 'panel' | 'newtab' | undefined;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DRAG_TYPE = 'application/x-flecha-tab';

let state: UiState | undefined;

// ---- tiny DOM helper --------------------------------------------------------

type Props = Record<string, unknown> & { class?: string };
function h(tag: string, props: Props = {}, ...children: Array<Node | string | null | undefined>) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    // Native tooltips look out of place; `title` feeds Flecha's own tooltip instead.
    else if (key === 'title') el.dataset.tip = String(value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child != null) el.append(child);
  return el;
}

function svg(path: string) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.innerHTML = `<path d="${path}"/>`;
  return el;
}

function icon(name: IconName) {
  return svg(ICONS[name]);
}

// Static markup marks icons as <i data-icon="name">; swap them for the shared SVGs.
for (const el of document.querySelectorAll<HTMLElement>('i[data-icon]')) el.replaceWith(icon(el.dataset.icon as IconName));

function host(url: string) {
  try {
    // Flecha's own pages (Boosts, in the Chromium build) are named, not shown as an extension id.
    if (url.startsWith(location.origin + '/') && location.protocol === 'chrome-extension:') return 'Flecha';
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A stable colour per site, so placeholder icons are told apart at a glance. */
function hueFor(text: string) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function favicon(tab: TabInfo) {
  const site = host(tab.url);
  const letter = () =>
    h('span', { class: 'favicon letter', style: `--hue: ${hueFor(site)}` }, (site.replace(/^[^a-z0-9]+/i, '')[0] ?? '•').toUpperCase());
  let hostname = '';
  try {
    hostname = new URL(tab.url).hostname;
  } catch {
    // Not a web page.
  }
  // The page's own icon once it has loaded, else the icon Flecha fetched for the site.
  const cached = state?.faviconUrl ? state.faviconUrl.replace('%s', encodeURIComponent(tab.url)) : `favicon://${hostname}`;
  const src = tab.favicon || (state?.faviconHosts.includes(hostname) ? cached : state?.faviconUrls?.[hostname]);
  if (!src) return letter();
  const img = h('img', { class: 'favicon', src, draggable: 'false' }) as HTMLImageElement;
  img.onerror = () => img.replaceWith(letter());
  return img;
}

// ---- rendering ----------------------------------------------------------------

function render(s: UiState) {
  state = s;
  const space = s.spaces.find((sp) => sp.id === s.activeSpaceId) ?? s.spaces[0];
  const active = space.activeTabId ? s.tabs[space.activeTabId] : undefined;
  document.documentElement.style.setProperty('--space-color', s.tint);

  ($('btn-back') as HTMLButtonElement).disabled = !s.nav.canGoBack;
  ($('btn-forward') as HTMLButtonElement).disabled = !s.nav.canGoForward;

  document.body.dataset.sidebar = s.sidebarMode;
  if (s.sidebarMode !== 'floating') $('sidebar').classList.remove('peek-leaving');
  // Shortcuts can be changed in Settings; key caps and tooltips show the current ones.
  for (const el of document.querySelectorAll<HTMLElement>('[data-shortcut]')) {
    const keys = s.shortcuts[el.dataset.shortcut!] ?? '';
    if (el.tagName === 'KBD') {
      el.textContent = keys;
      el.hidden = !keys;
      if (el.parentElement?.parentElement?.classList.contains('empty-hints')) el.parentElement.hidden = !keys;
    } else if (keys) el.dataset.kbd = keys;
    else delete el.dataset.kbd;
  }
  const toggle = $('btn-sidebar');
  toggle.dataset.tip = s.sidebarMode === 'floating' ? 'Keep sidebar open' : 'Hide sidebar';
  renderUrlbar(s, active);
  // In the Chromium build the sidebar and the new tab page are separate pages: the sidebar
  // never draws the empty state, the new tab page always does.
  renderEmptyState(s, space, surface === 'newtab' || (!active && surface !== 'panel'));

  $('favorites').replaceChildren(
    ...s.favorites
      .map((id) => s.tabs[id])
      .filter(Boolean)
      .map((tab) => {
        const el = h('button', { class: `fav${tab.id === space.activeTabId ? ' active' : ''}`, title: tabTitle(tab) }, favicon(tab));
        wireTab(el, tab, { zone: 'favorites', beforeTabId: tab.id });
        return el;
      }),
  );

  renderLocalServers(s);
  renderAgent(s);

  const title = $('space-title');
  if (title.contentEditable !== 'true') title.textContent = space.name;
  $('space-emoji').textContent = space.emoji ?? '';
  $('space-emoji').hidden = !space.emoji;
  title.dataset.spaceId = space.id;
  $('space-isolated').hidden = !space.isolated;

  // Re-rendering would throw away a tab or folder name being typed in place.
  if (!document.querySelector('#scroll [contenteditable="true"]')) {
    $('pinned').replaceChildren(...space.pinned.map((node) => renderNode(node, space, undefined)));
    $('today').replaceChildren(...todayRows(s, space));
  }

  $('spaces').replaceChildren(
    ...s.spaces.map((sp) =>
      h(
        'button',
        {
          class: `space-dot${sp.id === space.id ? ' active' : ''}`,
          title: sp.name,
          onclick: () => api.switchSpace(sp.id),
          oncontextmenu: (e: Event) => {
            e.preventDefault();
            api.spaceMenu(sp.id);
          },
        },
        sp.emoji ? h('span', { class: 'space-emoji' }, sp.emoji) : h('span', { class: 'space-initial' }, sp.name[0]?.toUpperCase() ?? '•'),
      ),
    ),
  );

  if (!palette.hidden) updatePalette();
  if (!spaceEditor.hidden) renderSpaceEditor();
  if (!sitePanel.hidden) renderSitePanel();
}

/** What a blank Space offers: search, the sites you go back to most, and your dev servers. */
let topSitesFetched = 0;
let topSites: HistoryEntry[] = [];
function renderEmptyState(s: UiState, space: Space, show: boolean) {
  const empty = $('empty-state');
  const wasHidden = empty.hidden;
  empty.hidden = !show;
  if (!show) return;
  const hour = new Date().getHours();
  $('empty-title').textContent = hour < 5 ? 'Up late?' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('empty-space').replaceChildren(h('span', { class: 'empty-space-emoji' }, space.emoji ?? ''), h('span', {}, space.name));
  // History changes as you browse, so the tiles are fetched each time the page becomes empty.
  if (wasHidden || Date.now() - topSitesFetched > 60_000) {
    topSitesFetched = Date.now();
    api.topSites().then((sites) => {
      topSites = sites;
      if (state) render(state);
    });
  }
  // Drawn on every update so icons appear as they are fetched.
  $('empty-top').hidden = !topSites.length;
  $('empty-top-sites').replaceChildren(
        ...topSites.map((site) =>
          h(
            'button',
            { class: 'top-site', title: site.url, onclick: () => api.newTab(site.url) },
            h('span', { class: 'top-site-icon' }, favicon({ id: '', url: site.url, title: '', lastActive: 0 })),
            h('span', { class: 'top-site-name' }, siteName(site)),
          ),
        ),
  );
  $('empty-local').hidden = !s.localServers.length;
  $('empty-local-list').replaceChildren(
    ...s.localServers.map((server) =>
      h(
        'button',
        { class: 'local-chip', title: server.url, onclick: () => api.newTab(server.url) },
        h('span', { class: 'live-dot' }),
        h('span', {}, server.name),
        h('span', { class: 'port' }, `:${server.port}`),
      ),
    ),
  );
}

/** A short name for a tile: the site's own name from its title when it has one, else the host. */
function siteName(entry: HistoryEntry) {
  const full = host(entry.url);
  const site = full.replace(/\.(com|org|net|io|dev|app|co)(\.[a-z]{2})?$/, '');
  const parts = entry.title.split(/\s+[-|–—·:]\s+/).map((p) => p.trim()).filter(Boolean);
  const named = parts.find((p) => p.length <= 18 && p.toLowerCase().replace(/\s/g, '').includes(site.split('.').pop()!.toLowerCase()));
  // A bare domain reads as a name ("X", "Figma"); hosts with ports stay as they are.
  return named ?? (site === full ? site : site[0].toUpperCase() + site.slice(1));
}

/** Host, a padlock or code icon for the kind of connection, and the environment badge. */
function renderUrlbar(s: UiState, active: TabInfo | undefined) {
  const url = active && active.url !== 'about:blank' ? active.url : undefined;
  let kind: IconName = 'search';
  if (url) kind = isDevUrl(url) ? 'code' : url.startsWith('https:') ? 'lock' : url.startsWith('http:') ? 'unlocked' : 'globe';
  $('urlbar-icon').replaceChildren(icon(kind));
  $('urlbar-icon').className = url?.startsWith('http:') && !isDevUrl(url) ? 'insecure' : '';
  $('urlbar-text').textContent = url ? host(url) : 'Search or enter URL';
  $('urlbar').classList.toggle('empty', !url);
  $('urlbar-env').replaceChildren(
    ...(s.environment ? [h('span', { class: `env-badge ${s.environment.tone}`, title: `${s.environment.name} · ${s.shortcuts.nextEnvironment} to switch` }, s.environment.label)] : []),
  );
}

/** Shows when a coding agent is connected and what it is doing right now. */
function renderAgent(s: UiState) {
  const status = $('agent-status');
  status.hidden = !s.agent?.connected;
  status.classList.toggle('busy', !!s.agent?.busy);
  $('agent-status-text').textContent = s.agent?.busy ? `Agent is ${s.agent.action}` : 'Agent connected';
}

/** Dev servers on this machine; clicking one goes to its tab, or opens one. */
function renderLocalServers(s: UiState) {
  $('local-servers').hidden = !s.localServers.length;
  $('local-server-list').replaceChildren(
    ...s.localServers.map((server) => {
      const open = Object.values(s.tabs).find((t) => originOf(t.url) === originOf(server.url));
      return h(
        'button',
        {
          class: `row local-server${open ? ' open' : ''}`,
          title: server.url,
          onclick: () => (open ? api.activate(open.id) : api.newTab(server.url)),
        },
        h('span', { class: 'live-dot' }),
        h('span', { class: 'title' }, server.name),
        h('span', { class: 'port' }, `:${server.port}`),
      );
    }),
  );
}

function originOf(url: string) {
  try {
    // localhost and 127.0.0.1 are the same server.
    return new URL(url).origin.replace('127.0.0.1', 'localhost');
  } catch {
    return url;
  }
}

function renderNode(node: PinnedNode, space: Space, folderId: string | undefined): HTMLElement {
  if (node.kind === 'tab') {
    const tab = state!.tabs[node.tabId];
    return tab ? tabRow(tab, space, { zone: 'pinned', folderId, beforeTabId: tab.id }) : h('span');
  }
  const name = h('span', { class: 'title folder-name' }, node.name);
  const header = h(
    'button',
    {
      class: 'row',
      onclick: () => api.toggleFolder(node.id),
      ondblclick: (e: Event) => {
        e.stopPropagation();
        editInline(name, node.name, (value) => api.renameFolder(node.id, value));
      },
    },
    h('span', { class: 'row-icon folder-icon' }, icon(node.open ? 'folderOpen' : 'folder')),
    name,
    h('span', { class: 'chevron' }, icon('chevron')),
  );
  acceptDrops(header, { zone: 'pinned', folderId: node.id });
  return h(
    'div',
    { class: `folder${node.open ? ' open' : ''}` },
    header,
    h('div', { class: 'folder-children' }, ...node.children.map((child) => renderNode(child, space, node.id))),
  );
}

/** Today's tabs, with the two halves of a split drawn together as one row, as in Arc. */
function todayRows(s: UiState, space: Space): HTMLElement[] {
  const pair = space.split && space.split.every((id) => space.today.includes(id) && s.tabs[id]) ? space.split : undefined;
  const rows: HTMLElement[] = [];
  let pairDrawn = false;
  for (const id of space.today) {
    const tab = s.tabs[id];
    if (!tab) continue;
    // The row sits where whichever half comes first in the list is; the other half is skipped.
    if (pair && pair.includes(id)) {
      if (pairDrawn) continue;
      pairDrawn = true;
      const [left, right] = pair.map((pid) => s.tabs[pid]);
      const showing = !!space.activeTabId && pair.includes(space.activeTabId);
      rows.push(
        h(
          'div',
          { class: `split-row${showing ? ' showing' : ''}`, title: space.splitMode === 'responsive' ? 'Responsive view' : 'Split view' },
          tabRow(left, space, { zone: 'today', beforeTabId: left.id }),
          tabRow(right, space, { zone: 'today', beforeTabId: right.id }),
        ),
      );
      continue;
    }
    rows.push(tabRow(tab, space, { zone: 'today', beforeTabId: tab.id }));
  }
  return rows;
}

function tabRow(tab: TabInfo, space: Space, target: DropTarget) {
  const close = h(
    'span',
    {
      class: 'close',
      title: target.zone === 'today' ? 'Close tab' : 'Unload tab',
      onclick: (e: Event) => {
        e.stopPropagation();
        api.close(tab.id);
      },
    },
    icon('close'),
  );
  const inSplit = !!space.split?.includes(tab.id) && !!space.activeTabId && space.split.includes(space.activeTabId);
  const row = h(
    'button',
    {
      class: `row${tab.id === space.activeTabId ? ' active' : ''}${inSplit ? ' in-split' : ''}${tab.loading ? ' loading' : ''}${
        state?.agent?.busy && state.agent.tabId === tab.id ? ' agent-driving' : ''
      }`,
    },
    favicon(tab),
    h('span', { class: 'title' }, tabTitle(tab)),
    tab.audible || tab.muted
      ? h(
          'span',
          {
            class: `audio-mark${tab.muted ? ' muted' : ''}`,
            title: tab.muted ? 'Unmute' : 'Mute',
            onclick: (e: Event) => {
              e.stopPropagation();
              api.toggleMute(tab.id);
            },
          },
          icon(tab.muted ? 'muted' : 'volume'),
        )
      : null,
    errorBadge(tab),
    isBoosted(tab.url) ? h('span', { class: 'boost-mark', title: 'Boosted: a script or styles from ~/.flecha/boosts run here' }, icon('zap')) : null,
    tab.device === 'mobile'
      ? h('span', { class: 'device-badge', title: 'Phone-sized mirror' }, icon('phone'))
      : h('span', { class: 'split-badge', title: 'In split view' }, icon('columns')),
    close,
  );
  wireTab(row, tab, target);
  return row;
}

/** Red count of console errors, only on pages you're developing (local URLs). */
function errorBadge(tab: TabInfo) {
  const count = state?.consoleErrors[tab.id];
  if (!count || !isDevUrl(tab.url)) return null;
  return h(
    'span',
    {
      class: 'error-badge',
      title: `${count} console error${count === 1 ? '' : 's'} · click to open the Console`,
      onclick: (e: Event) => {
        e.stopPropagation();
        api.showConsole(tab.id);
      },
    },
    count > 99 ? '99+' : String(count),
  );
}

function isBoosted(url: string) {
  try {
    const { hostname } = new URL(url);
    return !!state?.boostedHosts.some((h) => h !== 'all' && (hostname === h || hostname.endsWith(`.${h}`)));
  } catch {
    return false;
  }
}

function isDevUrl(url: string) {
  try {
    const { hostname } = new URL(url);
    return /^(localhost|127\.0\.0\.1|\[::1\])$|\.(localhost|local|test)$/.test(hostname);
  } catch {
    return false;
  }
}

function tabTitle(tab: TabInfo) {
  return tab.customTitle || tab.title || host(tab.url);
}

/** Inline rename of a tab row, started from the tab's context menu. */
function renameTab(tabId: string) {
  const row = document.querySelector<HTMLElement>(`.row[data-tab-id="${CSS.escape(tabId)}"] .title`);
  const tab = state?.tabs[tabId];
  if (!row || !tab) return;
  editInline(row, tabTitle(tab), (title) => api.renameTab(tabId, title));
}

function wireTab(el: HTMLElement, tab: TabInfo, target: DropTarget) {
  el.dataset.tabId = tab.id;
  el.draggable = true;
  el.addEventListener('click', () => api.activate(tab.id));
  el.addEventListener('auxclick', (e) => e.button === 1 && api.close(tab.id));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.tabMenu(tab.id);
  });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData(DRAG_TYPE, tab.id);
    e.dataTransfer!.effectAllowed = 'move';
    $('favorites').classList.add('show-empty');
    showSplitDrop(tab.id);
  });
  el.addEventListener('dragend', () => {
    $('favorites').classList.remove('show-empty');
    hideSplitDrop();
  });
  acceptDrops(el, target, 'drop-before');
}

function acceptDrops(el: HTMLElement, target: DropTarget, hoverClass = 'drag-over') {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add(hoverClass);
  });
  el.addEventListener('dragleave', () => el.classList.remove(hoverClass));
  el.addEventListener('drop', (e) => {
    el.classList.remove(hoverClass);
    const id = e.dataTransfer?.getData(DRAG_TYPE);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    api.moveTab(id, target);
  });
}

function editInline(el: HTMLElement, current: string, commit: (value: string) => void) {
  el.contentEditable = 'true';
  el.textContent = current;
  el.focus();
  document.getSelection()?.selectAllChildren(el);
  const finish = (save: boolean) => {
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    el.contentEditable = 'false';
    const value = el.textContent?.trim() ?? '';
    if (save && value && value !== current) commit(value);
    else if (state) render(state);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') e.preventDefault(), finish(true);
    if (e.key === 'Escape') finish(false);
  };
  const onBlur = () => finish(true);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
}

// ---- site panel (the sliders button in the address bar) ------------------------------

const sitePanel = $('site-panel');
const SITE_PERMISSIONS: Array<[string, string]> = [
  ['geolocation', 'Location'],
  ['media', 'Camera & microphone'],
  ['notifications', 'Notifications'],
  ['clipboard-read', 'Clipboard'],
];

function activeTab() {
  const space = state?.spaces.find((s) => s.id === state!.activeSpaceId);
  return space?.activeTabId ? state?.tabs[space.activeTabId] : undefined;
}

function toggleSitePanel(open = sitePanel.hidden) {
  sitePanel.hidden = !open || !activeTab();
  if (!sitePanel.hidden) {
    spaceEditor.hidden = true;
    downloadsPanel.hidden = true;
    renderSitePanel();
  }
}

function renderSitePanel() {
  const tab = activeTab();
  if (!tab || !state) return toggleSitePanel(false);
  let origin = '';
  try {
    origin = new URL(tab.url).origin;
  } catch {
    // Not a web page.
  }
  $('site-favicon').replaceChildren(favicon(tab));
  $('site-host').textContent = host(tab.url);
  $('site-security').textContent = isDevUrl(tab.url)
    ? 'Local development server'
    : tab.url.startsWith('https:')
      ? 'Connection is secure'
      : tab.url.startsWith('http:')
        ? 'Connection is not secure'
        : 'Not a web page';
  $('site-security').className = tab.url.startsWith('http:') && !isDevUrl(tab.url) ? 'insecure' : '';

  const saved = state.sitePermissions?.[origin] ?? {};
  $('site-permissions').replaceChildren(
    ...SITE_PERMISSIONS.map(([permission, label]) => {
      const select = h('select', { class: 'mini-select', 'aria-label': label }) as HTMLSelectElement;
      select.append(new Option('Ask', 'ask'), new Option('Allow', 'allow'), new Option('Block', 'block'));
      select.value = saved[permission] ?? 'ask';
      select.addEventListener('change', () => api.setSitePermission(origin, permission, select.value as 'allow' | 'block' | 'ask'));
      return h('label', { class: 'site-row' }, h('span', {}, label), select);
    }),
  );
  $('zoom-reset').textContent = `${state.nav.zoom}%`;
  for (const id of ['site-copy', 'site-shot', 'site-boost', 'site-devtools', 'site-clear', 'zoom-in', 'zoom-out', 'zoom-reset']) {
    ($(id) as HTMLButtonElement).disabled = !origin;
  }
}

$('btn-site').onclick = () => toggleSitePanel();
$('btn-copy-link').onclick = () => {
  const tab = activeTab();
  if (tab) api.copyText(tab.url);
};
$('site-copy').onclick = () => {
  const tab = activeTab();
  if (tab) api.copyText(tab.url);
  toggleSitePanel(false);
};
$('site-shot').onclick = () => {
  toggleSitePanel(false);
  api.capturePage();
};
$('site-boost').onclick = () => {
  toggleSitePanel(false);
  api.editBoost('script');
};
$('site-devtools').onclick = () => {
  toggleSitePanel(false);
  api.openDevTools();
};
$('site-clear').onclick = () => {
  const tab = activeTab();
  if (tab) api.clearSiteData(new URL(tab.url).origin);
  toggleSitePanel(false);
};
$('zoom-in').onclick = () => api.zoom(1);
$('zoom-out').onclick = () => api.zoom(-1);
$('zoom-reset').onclick = () => api.zoom(0);
document.addEventListener('mousedown', (e) => {
  const target = e.target as Node;
  if (!sitePanel.hidden && !sitePanel.contains(target) && !$('btn-site').contains(target)) toggleSitePanel(false);
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && !sitePanel.hidden && toggleSitePanel(false));
// Scrolling sideways over the sidebar (a trackpad swipe, a mouse's thumb wheel) changes
// Space, one per gesture: the scroll adds up to a step, then waits for the gesture to end.
const SPACE_SWIPE_STEP = 60;
let swipe = 0;
let swipeDone = false;
let swipeEnd: number | undefined;
$('sidebar').addEventListener(
  'wheel',
  (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || !state) return;
    e.preventDefault();
    clearTimeout(swipeEnd);
    swipeEnd = window.setTimeout(() => {
      swipe = 0;
      swipeDone = false;
    }, 250);
    if (swipeDone) return;
    swipe += e.deltaX;
    if (Math.abs(swipe) < SPACE_SWIPE_STEP) return;
    swipeDone = true;
    const spaces = state.spaces;
    const i = spaces.findIndex((sp) => sp.id === state!.activeSpaceId);
    const next = spaces[i + (swipe > 0 ? 1 : -1)];
    if (next) api.switchSpace(next.id);
  },
  { passive: false },
);

// A click on the page takes the focus from the sidebar's page: that closes the panel too.
window.addEventListener('blur', () => !sitePanel.hidden && toggleSitePanel(false));

// Confirmations ("Link copied") replace the address for a moment.
let flashTimer: number | undefined;
api.onFlash((message) => {
  const wrap = $('urlbar-wrap');
  wrap.dataset.flash = message;
  wrap.classList.add('flashing');
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => wrap.classList.remove('flashing'), 1400);
});

// ---- Space editor -------------------------------------------------------------------

const spaceEditor = $('space-editor');
const spaceName = $<HTMLInputElement>('space-name');
let editingSpace: string | undefined;

function openSpaceEditor(spaceId: string) {
  editingSpace = spaceId;
  downloadsPanel.hidden = true;
  spaceEditor.hidden = false;
  renderSpaceEditor();
  spaceName.focus();
  spaceName.select();
}

function closeSpaceEditor() {
  editingSpace = undefined;
  spaceEditor.hidden = true;
}

function renderSpaceEditor() {
  const space = state?.spaces.find((s) => s.id === editingSpace);
  if (!space) return closeSpaceEditor();
  if (document.activeElement !== spaceName) spaceName.value = space.name;
  $('space-emojis').replaceChildren(
    h('button', { class: `emoji${space.emoji ? '' : ' selected'}`, title: 'No icon', onclick: () => api.updateSpace(space.id, { emoji: '' }) }, icon('close')),
    ...SPACE_EMOJIS.map((emoji) =>
      h('button', { class: `emoji${space.emoji === emoji ? ' selected' : ''}`, onclick: () => api.updateSpace(space.id, { emoji }) }, emoji),
    ),
  );
  const custom = h('input', { type: 'color', value: space.color, title: 'Custom colour' }) as HTMLInputElement;
  custom.addEventListener('input', () => api.updateSpace(space.id, { color: custom.value }));
  $('space-colors').replaceChildren(
    ...SPACE_COLORS.map((color) =>
      h('button', {
        class: `swatch${space.color === color ? ' selected' : ''}`,
        style: `--swatch: ${color}`,
        title: color,
        onclick: () => api.updateSpace(space.id, { color }),
      }),
    ),
    h('label', { class: `swatch custom${SPACE_COLORS.includes(space.color) ? '' : ' selected'}`, style: `--swatch: ${space.color}`, title: 'Custom colour' }, custom),
  );
  $<HTMLInputElement>('space-isolated-toggle').checked = !!space.isolated;
  $<HTMLButtonElement>('space-delete').disabled = state!.spaces.length < 2;
}

spaceName.addEventListener('input', () => editingSpace && spaceName.value.trim() && api.updateSpace(editingSpace, { name: spaceName.value }));
spaceName.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === 'Escape') && closeSpaceEditor());
$('space-isolated-toggle').addEventListener('change', (e) => {
  if (editingSpace) api.setSpaceIsolated(editingSpace, (e.target as HTMLInputElement).checked);
});
$('space-delete').onclick = () => {
  if (!editingSpace) return;
  api.deleteSpace(editingSpace);
  closeSpaceEditor();
};
$('space-done').onclick = closeSpaceEditor;
document.addEventListener('mousedown', (e) => {
  const target = e.target as Node;
  if (!spaceEditor.hidden && !spaceEditor.contains(target) && !$('space-header').contains(target)) closeSpaceEditor();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && !spaceEditor.hidden && closeSpaceEditor());

// ---- command bar ----------------------------------------------------------------

interface PaletteItem {
  group: PaletteGroup;
  /** An icon name, a tab (its favicon) or a URL (that site's icon). */
  icon: IconName | TabInfo | string;
  label: string;
  sub: string;
  /** A keyboard shortcut for the same command, shown on the right. */
  hint?: string;
  run: () => void;
  /** Shown under the results while this item is selected, e.g. a decoded JWT. */
  detail?: string;
}

const palette = $('palette');
const paletteInput = $<HTMLInputElement>('palette-input');
const paletteList = $('palette-results');
let paletteMode: PaletteMode = 'new-tab';
let paletteItems: PaletteItem[] = [];
let selected = 0;

function looksLikeUrl(q: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || (!/\s/.test(q) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(q)) || /^localhost(:\d+)?/.test(q);
}

function openPalette(mode: PaletteMode) {
  paletteMode = mode;
  palette.hidden = false;
  const space = state?.spaces.find((s) => s.id === state!.activeSpaceId);
  const active = space?.activeTabId ? state?.tabs[space.activeTabId] : undefined;
  paletteInput.value = mode === 'navigate' && active ? active.url : '';
  paletteInput.focus();
  paletteInput.select();
  selected = 0;
  historyResults = [];
  updatePalette();
  refreshHistory();
}

function closePalette() {
  if (palette.hidden) return;
  palette.hidden = true;
  api.closePalette();
}

type PaletteGroup = '' | 'Developer' | 'Actions' | 'Tabs' | 'History' | 'Archive';

/** Commands the bar can run, found by typing any word of their label or keywords. */
const ACTIONS: Array<{ label: string; keywords: string; icon: IconName; shortcut?: string; run: () => void }> = [
  { label: 'New Space', keywords: 'space create add', icon: 'space', shortcut: 'newSpace', run: () => api.newSpace() },
  { label: 'Edit Space', keywords: 'space rename emoji colour color icon', icon: 'space', run: () => state && openSpaceEditor(state.activeSpaceId) },
  { label: 'New Flechinha Window', keywords: 'flechinha little mini small window quick lookup', icon: 'miniWindow', shortcut: 'newFlechinha', run: () => api.newFlechinha() },
  { label: 'Settings', keywords: 'preferences settings config options', icon: 'settings', shortcut: 'settings', run: () => api.openSettings() },
  { label: 'Responsive View', keywords: 'mobile phone responsive device split', icon: 'phone', shortcut: 'responsive', run: () => api.toggleResponsive() },
  { label: 'Toggle Sidebar', keywords: 'sidebar hide show', icon: 'sidebar', shortcut: 'toggleSidebar', run: () => api.toggleSidebar() },
  { label: 'Clear Today Tabs', keywords: 'clear archive today close', icon: 'archive', shortcut: 'clearToday', run: () => api.clearToday() },
  { label: 'Show Downloads', keywords: 'downloads files', icon: 'download', run: () => (downloadsPanel.hidden = false) },
  {
    label: 'Import from another browser',
    keywords: 'import migrate bookmarks history arc chrome safari firefox brave edge vivaldi opera',
    icon: 'import',
    run: () => api.importMenu(),
  },
  { label: 'Open Boosts Folder', keywords: 'boosts folder scripts css', icon: 'zap', run: () => api.openBoostsFolder() },
];

function matchingActions(q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || q.length < 2) return [];
  return ACTIONS.filter((a) => {
    const haystack = `${a.label} ${a.keywords}`.toLowerCase().split(/\s+/);
    return words.every((w) => haystack.some((h) => h.startsWith(w)));
  });
}

function itemIcon(source: IconName | TabInfo | string) {
  if (typeof source === 'object') return favicon(source);
  if (source in ICONS) return icon(source as IconName);
  // A URL: show its site's icon, as if it were a tab.
  return favicon({ id: '', url: source, title: '', lastActive: 0 });
}

function updatePalette() {
  if (!state) return;
  const q = paletteInput.value.trim();
  const lower = q.toLowerCase();
  const matches = (title: string, url: string) => !lower || title.toLowerCase().includes(lower) || url.toLowerCase().includes(lower);
  const items: PaletteItem[] = [];
  const open = { navigate: api.navigate, 'new-tab': api.newTab, split: api.splitNew }[paletteMode];
  const activeId = state.spaces.find((s) => s.id === state!.activeSpaceId)?.activeTabId;
  const activeUrl = activeId ? state.tabs[activeId]?.url : undefined;

  $('palette-mode').textContent = { navigate: 'Current Tab', split: 'Split View', 'new-tab': '' }[paletteMode];

  if (q) {
    const isUrl = looksLikeUrl(q);
    const searchItem: PaletteItem = {
      group: '',
      icon: isUrl ? 'globe' : 'search',
      label: q,
      sub: isUrl ? 'Open' : `Search ${state.searchEngineName}`,
      run: () => open(q),
    };

    // `env` lists the current page on the project's other environments.
    if (/^env\b/i.test(q) && state.environment) {
      for (const target of state.environment.switches) {
        items.push({ group: 'Developer', icon: 'code', label: `Switch to ${target.label}`, sub: host(target.url), run: () => api.navigate(target.url) });
      }
    }
    // `boost` edits this site's boost files.
    if (/^boost/i.test(q) && activeUrl) {
      const site = host(activeUrl);
      items.push({ group: 'Developer', icon: 'zap', label: `Edit boost script for ${site}`, sub: 'TypeScript', run: () => api.editBoost('script') });
      items.push({ group: 'Developer', icon: 'zap', label: `Edit boost styles for ${site}`, sub: 'CSS, live', run: () => api.editBoost('styles') });
    }
    for (const dev of devSuggestions(q, activeUrl)) {
      items.push({
        group: 'Developer',
        icon: dev.url ? dev.url : 'code',
        label: dev.label,
        sub: dev.sub,
        detail: dev.copy,
        run: () => (dev.url ? open(dev.url) : api.copyText(dev.copy ?? '')),
      });
    }
    for (const action of matchingActions(q).slice(0, 4)) {
      items.push({ group: 'Actions', icon: action.icon, label: action.label, sub: '', hint: action.shortcut && state.shortcuts[action.shortcut], run: action.run });
    }
    // A matching shortcut or action is what was meant (`gh 12`, `settings`); otherwise searching is.
    if (items.length && !isUrl) items.push(searchItem);
    else items.unshift(searchItem);
  }

  const openTabs = Object.values(state.tabs)
    .filter((t) => matches(t.title, t.url) && !(paletteMode === 'split' && t.id === activeId))
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, q ? 6 : 8);
  for (const tab of openTabs) {
    items.push({
      group: 'Tabs',
      icon: tab,
      label: tabTitle(tab),
      sub: host(tab.url),
      run: paletteMode === 'split' ? () => api.splitWith(tab.id) : () => api.activate(tab.id),
    });
  }

  if (q) {
    const seen = new Set(openTabs.map((t) => t.url));
    for (const entry of historyResults.filter((e) => !seen.has(e.url)).slice(0, 6)) {
      seen.add(entry.url);
      items.push({ group: 'History', icon: entry.url, label: entry.title || entry.url, sub: host(entry.url), run: () => open(entry.url) });
    }
    const reopen = paletteMode === 'split' ? api.splitNew : api.newTab;
    for (const item of state.archive.filter((a) => !seen.has(a.url) && matches(a.title, a.url)).slice(0, 5)) {
      seen.add(item.url);
      items.push({ group: 'Archive', icon: item.url, label: item.title || item.url, sub: host(item.url), run: () => reopen(item.url) });
    }
  }

  paletteItems = items;
  selected = Math.min(selected, Math.max(items.length - 1, 0));
  const rows: HTMLElement[] = [];
  let group: PaletteGroup | undefined;
  items.forEach((item, i) => {
    if (item.group !== group) {
      group = item.group;
      if (group) rows.push(h('li', { class: 'group-label' }, group));
    }
    rows.push(
      h(
        'li',
        {
          class: `item${i === selected ? ' selected' : ''}`,
          dataset: { index: String(i) },
          onmousemove: () => {
            if (selected !== i) (selected = i), updatePalette();
          },
          onmousedown: (e: Event) => {
            e.preventDefault();
            runItem(i);
          },
        },
        h('span', { class: 'item-icon' }, itemIcon(item.icon)),
        h('span', { class: 'label' }, item.label),
        item.sub ? h('span', { class: 'sub' }, item.sub) : null,
        item.hint ? h('kbd', {}, item.hint) : null,
        h('kbd', { class: 'enter' }, '↵'),
      ),
    );
  });
  paletteList.replaceChildren(...rows);
  paletteList.querySelector('.item.selected')?.scrollIntoView({ block: 'nearest' });
  const detail = $('palette-detail');
  detail.hidden = !items[selected]?.detail;
  detail.textContent = items[selected]?.detail ?? '';
}

function runItem(i: number) {
  const item = paletteItems[i];
  if (!item) return;
  item.run();
  closePalette();
}

// History lives in the main process; results arrive asynchronously and are dropped if stale.
let historyResults: HistoryEntry[] = [];
function refreshHistory() {
  const q = paletteInput.value.trim();
  if (!q) {
    historyResults = [];
    return;
  }
  api.searchHistory(q).then((results) => {
    if (paletteInput.value.trim() !== q || palette.hidden) return;
    historyResults = results;
    updatePalette();
  });
}

paletteInput.addEventListener('input', () => {
  selected = 0;
  updatePalette();
  refreshHistory();
});
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePalette();
  else if (e.key === 'Enter') runItem(selected);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = paletteItems.length;
    if (n) selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    updatePalette();
  } else return;
});
palette.addEventListener('mousedown', (e) => {
  if (e.target === palette) closePalette();
});
paletteInput.addEventListener('blur', () => setTimeout(() => document.activeElement !== paletteInput && closePalette(), 0));

// ---- peek -------------------------------------------------------------------------

const peek = $('peek');
const peekBar = peek.querySelector<HTMLElement>('.peek-bar')!;

function renderPeek(p: PeekState | null) {
  peek.hidden = !p;
  if (!p) return;
  const barHeight = 36;
  Object.assign(peekBar.style, {
    left: `${p.bounds.x}px`,
    top: `${p.bounds.y - barHeight - 6}px`,
    width: `${p.bounds.width}px`,
  });
  peekBar.querySelector('.peek-title')!.textContent = p.title || host(p.url);
}

peek.addEventListener('mousedown', (e) => {
  if (e.target === peek) api.closePeek();
});
$('peek-open').onclick = () => api.promotePeek();
$('peek-close').onclick = () => api.closePeek();

// ---- downloads --------------------------------------------------------------------

const downloadsPanel = $('downloads-panel');

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) (value /= 1024), unit++;
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function downloadStatus(d: DownloadInfo) {
  if (d.state === 'completed') return formatBytes(d.received);
  if (d.state === 'cancelled') return 'Cancelled';
  if (d.state === 'interrupted') return 'Failed';
  return d.total ? `${formatBytes(d.received)} of ${formatBytes(d.total)}` : formatBytes(d.received);
}

function renderDownloads(items: DownloadInfo[], started?: DownloadInfo) {
  const active = items.filter((d) => d.state === 'progressing').length;
  const badge = $('downloads-badge');
  badge.hidden = !active;
  badge.textContent = String(active);
  if (started) downloadsPanel.hidden = false;

  $('downloads-list').replaceChildren(
    ...items.map((d) => {
      const progress = d.state === 'progressing' && d.total ? d.received / d.total : d.state === 'completed' ? 1 : 0;
      return h(
        'li',
        {
          class: `download ${d.state}`,
          title: d.state === 'completed' ? 'Open' : d.url,
          onclick: () => api.openDownload(d.id),
        },
        h('span', { class: 'name' }, d.filename),
        h('span', { class: 'status' }, downloadStatus(d)),
        d.state === 'progressing'
          ? h('span', { class: 'bar' }, h('span', { class: 'fill', style: `width: ${Math.round(progress * 100)}%` }))
          : null,
        h(
          'button',
          {
            class: 'icon-button',
            title: d.state === 'progressing' ? 'Cancel' : 'Show in Finder',
            onclick: (e: Event) => {
              e.stopPropagation();
              if (d.state === 'progressing') api.cancelDownload(d.id);
              else api.revealDownload(d.id);
            },
          },
          d.state === 'progressing' ? icon('close') : icon('folder'),
        ),
      );
    }),
  );
  if (!items.length) $('downloads-list').append(h('li', { class: 'empty' }, 'No downloads yet'));
}

$('btn-downloads').onclick = () => (downloadsPanel.hidden = !downloadsPanel.hidden);
$('btn-clear-downloads').onclick = () => api.clearDownloads();
document.addEventListener('mousedown', (e) => {
  const target = e.target as Node;
  if (!downloadsPanel.hidden && !downloadsPanel.contains(target) && !$('btn-downloads').contains(target)) {
    downloadsPanel.hidden = true;
  }
});

// ---- drop a tab on the page to split ---------------------------------------------------

const splitDrop = $('split-drop');

/** Drop zones over the page while a tab is dragged, unless it's the tab already on screen. */
function showSplitDrop(tabId: string) {
  const space = state?.spaces.find((s) => s.id === state!.activeSpaceId);
  if (!space?.activeTabId || space.activeTabId === tabId || (space.split?.includes(tabId) && space.split.includes(space.activeTabId))) return;
  // Where the page is: right of the docked sidebar, else the whole window inside the gap.
  const left = document.body.dataset.sidebar === 'docked' ? $('sidebar').offsetWidth : 8;
  Object.assign(splitDrop.style, { left: `${left}px`, top: '8px', right: '8px', bottom: '8px' });
  splitDrop.hidden = false;
  api.setTabDragging(true);
}

function hideSplitDrop() {
  if (splitDrop.hidden) return;
  splitDrop.hidden = true;
  for (const half of splitDrop.children) half.classList.remove('over');
  api.setTabDragging(false);
}

for (const half of splitDrop.querySelectorAll<HTMLElement>('.drop-half')) {
  half.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    half.classList.add('over');
  });
  half.addEventListener('dragleave', () => half.classList.remove('over'));
  half.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData(DRAG_TYPE);
    e.preventDefault();
    splitDrop.hidden = true;
    for (const h of splitDrop.children) h.classList.remove('over');
    if (id) api.dropToSplit(id, half.dataset.side as 'left' | 'right');
    else api.setTabDragging(false);
  });
}

// ---- hidden sidebar: reveal at the edge, hide again when the mouse leaves -------------

// The edge strip stays under the pointer while the floating sidebar is out (it covers the gap
// between the window's edge and the card, styles.css), so the card sliding in under a pointer
// resting at the edge never reads as leaving it: the sidebar shows once, and goes only after
// the pointer has left both the edge and the card for a moment, sliding out to the left.
let peekCloseTimer: number | undefined;
const peekSidebar = $('sidebar');
const peekEdge = $('edge');
const inPeek = (el: EventTarget | null) => el instanceof Node && (peekSidebar.contains(el) || peekEdge.contains(el));
function keepPeek() {
  clearTimeout(peekCloseTimer);
  peekSidebar.classList.remove('peek-leaving');
}
function leavePeek(e: MouseEvent) {
  if (document.body.dataset.sidebar !== 'floating' || inPeek(e.relatedTarget)) return;
  clearTimeout(peekCloseTimer);
  peekCloseTimer = window.setTimeout(() => {
    // Stay open while something inside it is being used.
    if (!palette.hidden || !spaceEditor.hidden || !downloadsPanel.hidden) return;
    peekSidebar.classList.add('peek-leaving');
  }, 300);
}
peekEdge.addEventListener('mouseenter', () => {
  keepPeek();
  api.setSidebarPeek(true);
});
peekSidebar.addEventListener('mouseenter', keepPeek);
peekEdge.addEventListener('mouseleave', leavePeek);
peekSidebar.addEventListener('mouseleave', leavePeek);
// Hidden once it has slid out.
peekSidebar.addEventListener('animationend', (e) => {
  if (e.target === peekSidebar && peekSidebar.classList.contains('peek-leaving')) api.setSidebarPeek(false);
});

// ---- tooltips ---------------------------------------------------------------------

const tooltip = $('tooltip');
let tipTimer: number | undefined;
let tipTarget: HTMLElement | undefined;

function showTip(target: HTMLElement) {
  $('tooltip-text').textContent = target.dataset.tip ?? '';
  const kbd = $('tooltip-kbd');
  kbd.textContent = target.dataset.kbd ?? '';
  kbd.hidden = !target.dataset.kbd;
  tooltip.hidden = false;
  const r = target.getBoundingClientRect();
  const t = tooltip.getBoundingClientRect();
  const below = r.bottom + 6 + t.height < window.innerHeight - 8;
  const left = Math.min(Math.max(r.left + r.width / 2 - t.width / 2, 6), window.innerWidth - t.width - 6);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${below ? r.bottom + 6 : r.top - t.height - 6}px`;
}

let tipHiddenAt = 0;

function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = undefined;
  if (!tooltip.hidden) tipHiddenAt = Date.now();
  tooltip.hidden = true;
}

document.addEventListener('pointerover', (e) => {
  const target = (e.target as Element).closest<HTMLElement>('[data-tip]');
  if (target === tipTarget) return;
  hideTip();
  if (!target || !target.dataset.tip) return;
  tipTarget = target;
  // Once one tooltip is showing, moving to the next button shows its tooltip right away.
  tipTimer = window.setTimeout(() => showTip(target), Date.now() - tipHiddenAt < 400 ? 0 : 550);
});
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('scroll', hideTip, true);
window.addEventListener('blur', hideTip);

// ---- wiring ---------------------------------------------------------------------

$('btn-sidebar').onclick = () => api.toggleSidebar();
$('btn-back').onclick = () => api.back();
$('btn-forward').onclick = () => api.forward();
$('btn-reload').onclick = () => api.reload();
$('urlbar').onclick = () => api.openPalette('navigate');
$('btn-newtab').onclick = () => api.openPalette('new-tab');
$('btn-clear').onclick = () => api.clearToday();
$('btn-newspace').onclick = () => api.newSpace();
$('empty-new-tab').onclick = () => api.openPalette('new-tab');
$('space-header').ondblclick = () => state && openSpaceEditor(state.activeSpaceId);
$('space-header').oncontextmenu = (e) => {
  e.preventDefault();
  if (state) api.spaceMenu(state.activeSpaceId);
};
// As in Arc, right-clicking the sidebar's empty background (between and below the tabs, the
// toolbar's gaps) opens the current Space's menu. Rows, buttons, fields and popovers aren't
// background: they have their own menu, the native edit menu, or none.
$('sidebar').addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented || !state) return;
  if ((e.target as Element).closest('button, a, input, textarea, select, label, [contenteditable], .row, .popover, browser-action-list, #urlbar-wrap, #agent-status')) return;
  e.preventDefault();
  api.spaceMenu(state.activeSpaceId);
});

acceptDrops($('favorites'), { zone: 'favorites' });
acceptDrops($('pinned'), { zone: 'pinned' });
acceptDrops($('today'), { zone: 'today' });
acceptDrops($('btn-newtab'), { zone: 'today' });

const renderOnboarding = setupOnboarding(api, h, icon);
api.onState((s) => {
  render(s);
  renderOnboarding(s);
});
api.onPalette(openPalette);
api.onEditSpace(openSpaceEditor);
api.onRenameTab(renameTab);
api.onPeek(renderPeek);
api.onDownloads(renderDownloads);
api.ready();
