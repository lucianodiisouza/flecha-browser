import { devSuggestions } from './devCommands.js';
import { ICONS, type IconName } from './icons.js';
import { setupOnboarding } from './onboarding.js';
import { SPACE_COLORS, SPACE_EMOJIS } from './spaceChoices.js';
import { setupWindowControls } from './windowControls.js';
import { displayKeys } from '../lib/shortcuts';
import { isMac } from '../lib/platform';
import { isEnter } from '../lib/keys';
import { isUndoKey } from '../lib/undo';
import { spaceDropBefore } from '../lib/spaceOrder';
import { canDropToSplit, pageSplitTarget } from '../lib/splitDrop';
import { onReconnect } from '../client';
import { EMPTY_ACTIONS, EMPTY_TABS, type Match, type ResultKind, displayUrl, historyQuery, inlineCompletion, matchQuality, rank, score } from '../lib/commandBar';
import { suggestable, suggestionRequests } from '../lib/suggest';
import { searchUrl, webAddress } from '../lib/url';
import type { MenuEntry } from '../settingsUi';
import { importFromBrowser, showPageMenu } from '../windowUi';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../shared/sidebarWidth';
import { inAgentFolder, todaySplit } from '../../shared/agentFolder';
import { blocksAdsOn, isSiteHost } from '../../shared/adBlockSites';
import { incognito } from '../incognito';
import type { DownloadInfo, DropTarget, FlechaApi, HistoryEntry, PaletteMode, PeekState, PinnedNode, Space, TabInfo, UiState } from '../../shared/types';

declare global {
  interface Window {
    flecha: FlechaApi;
  }
}

const api = window.flecha;
/** The window frame, side panel or new tab page. */
const surface = document.documentElement.dataset.surface;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DRAG_TYPE = 'application/x-flecha-tab';
const SPACE_DRAG_TYPE = 'application/x-flecha-space';
/** The Space whose button is being dragged: drag events only say what kind of thing it is. */
let draggedSpace: string | undefined;
let draggedTab: { id: string; spaceId: string } | undefined;
let incomingDrop: { element: HTMLElement; spaceId: string } | undefined;
let clearDropTarget: (() => void) | undefined;
let deferredRows = false;
let externalPinnedDrag = false;

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
  $('sidebar-resize').setAttribute('aria-valuenow', String(s.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH));
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
  renderLoading(s, active);
  // In the Chromium build the sidebar and the new tab page are separate pages: the sidebar
  // never draws the empty state, the new tab page always does.
  renderEmptyState(s, space, surface === 'newtab' || (!active && surface !== 'panel'));

  if (incomingDrop && incomingDrop.spaceId !== space.id) incomingDrop = undefined;
  const preserveRows = !!draggedTab || !!incomingDrop;
  if (!preserveRows) $('favorites').replaceChildren(
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

  // Keep the native drag source and any name being typed in place.
  if (!preserveRows && !document.querySelector('#scroll [contenteditable="true"]')) {
    $('pinned').replaceChildren(...space.pinned.map((node) => renderNode(node, space, undefined)));
    $('today').replaceChildren(...todayRows(s, space));
    renderAgentFolder(s, space);
    deferredRows = false;
  } else if (incomingDrop) {
    deferredRows = true;
  }
  $('pinned-header').hidden = incognito;
  $('scroll').style.visibility = draggedTab && draggedTab.spaceId !== space.id ? 'hidden' : '';
  updatePinnedVisibility(space);
  if (draggedTab) showSplitDrop(draggedTab.id);

  $('spaces').replaceChildren(
    ...s.spaces.map((sp) =>
      h(
        'button',
        {
          class: `space-dot${sp.id === space.id ? ' active' : ''}`,
          title: sp.name,
          draggable: 'true',
          onclick: () => api.switchSpace(sp.id),
          oncontextmenu: (e: Event) => {
            e.preventDefault();
            api.spaceMenu(sp.id);
          },
          ...spaceDrag(s, sp.id),
        },
        sp.emoji ? h('span', { class: 'space-emoji' }, sp.emoji) : h('span', { class: 'space-initial' }, sp.name[0]?.toUpperCase() ?? '•'),
      ),
    ),
  );

  // Tabs opening, closing or renaming in the background keep the selected result selected.
  if (!palette.hidden) refreshPalette();
  if (!spaceEditor.hidden) renderSpaceEditor();
  if (!sitePanel.hidden) renderSitePanel();
}

function updatePinnedVisibility(space: Space) {
  const expanded = !space.pinnedCollapsed || draggedTab?.spaceId === space.id || externalPinnedDrag;
  $('pinned').hidden = !expanded;
  $('btn-toggle-pinned').setAttribute('aria-expanded', String(expanded));
  $('pinned-count').hidden = expanded || !space.pinned.length;
  $('pinned-count').textContent = String(space.pinned.length);
}

/** What a blank Space offers: search, the sites you go back to most, and your dev servers. */
let topSitesFetched = 0;
let fetchingTopSites = false;
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
  if (!fetchingTopSites && (wasHidden || Date.now() - topSitesFetched > 60_000)) {
    fetchingTopSites = true;
    topSitesFetched = Date.now();
    void api.topSites().then((sites) => {
      topSites = sites;
      if (state) render(state);
    }, () => undefined).finally(() => { fetchingTopSites = false; });
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
    ...(s.environment ? [h('span', { class: `env-badge ${s.environment.tone}`, title: `${s.environment.name} · ${state?.shortcuts.nextEnvironment ?? displayKeys('Alt+CmdOrCtrl+E')} to switch` }, s.environment.label)] : []),
  );
}

// ---- loading --------------------------------------------------------------------

/** When each loading tab started, so the progress line picks up where it was after a tab switch. */
const loadStarts = new Map<string, number>();
/** The tab the progress line is running for. */
let progressTab: string | undefined;
/** Stop was clicked for it: its load ends without the line filling, which would read as loaded. */
let stoppedTab: string | undefined;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
/**
 * Chromium tells the shell only that a page is loading, not how far along it is, so the line
 * runs a curve instead: quickly to a third, then ever slower, never full until the page is.
 */
const PROGRESS: Keyframe[] = [
  { backgroundSize: '0% 2px' },
  { backgroundSize: '30% 2px', offset: 0.03, easing: 'cubic-bezier(0.2, 0.6, 0.35, 1)' },
  { backgroundSize: '90% 2px' },
];
const PROGRESS_MS = 10_000;

/** Reload turns into Stop, and the address fills along its bottom, while the shown page loads. */
function renderLoading(s: UiState, active: TabInfo | undefined) {
  const now = performance.now();
  for (const id of loadStarts.keys()) if (!s.tabs[id]?.loading) loadStarts.delete(id);
  for (const [id, tab] of Object.entries(s.tabs)) if (tab.loading && !loadStarts.has(id)) loadStarts.set(id, now);

  const loading = active?.loading ? active.id : undefined;
  const reload = $('btn-reload');
  reload.replaceChildren(icon(loading ? 'close' : 'reload'));
  reload.dataset.tip = loading ? 'Stop' : 'Reload';
  // The tooltip is Flecha's own, which screen readers don't see.
  reload.setAttribute('aria-label', loading ? 'Stop' : 'Reload');
  reload.dataset.action = loading ? 'stop' : 'reload';
  // The reload shortcut doesn't stop.
  if (loading) delete reload.dataset.kbd;

  if (loading === progressTab) return;
  const bar = $('urlbar-progress');
  // The page it ran for has loaded (rather than another tab being shown): the line fills, then fades.
  const loaded = progressTab !== undefined && progressTab === active?.id && progressTab !== stoppedTab;
  const from = getComputedStyle(bar).backgroundSize;
  for (const animation of bar.getAnimations()) animation.cancel();
  progressTab = loading;
  stoppedTab = undefined;
  const duration = (ms: number) => (reducedMotion.matches ? 0 : ms);
  if (loaded) {
    bar.animate([{ backgroundSize: from }, { backgroundSize: '100% 2px', opacity: 1, offset: 0.5 }, { backgroundSize: '100% 2px', opacity: 0 }], {
      duration: duration(400),
      easing: 'ease-out',
    });
  } else if (loading) {
    bar.animate(PROGRESS, { duration: duration(PROGRESS_MS), fill: 'forwards' }).currentTime = now - loadStarts.get(loading)!;
  }
}

function spinner() {
  // Named, so a screen reader reads the row as "Loading" and its title.
  const el = h('span', { class: 'favicon spinner', role: 'img', 'aria-label': 'Loading' });
  // Rows are redrawn on every change: every spinner's turn counts from the same start, so a
  // redrawn one carries on where the one it replaced was instead of jumping.
  if (!reducedMotion.matches) el.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 800, iterations: Infinity }).startTime = 0;
  return el;
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
  acceptDrops(header, { zone: 'pinned', spaceId: space.id, folderId: node.id });
  return h(
    'div',
    { class: `folder${node.open ? ' open' : ''}` },
    header,
    h('div', { class: 'folder-children' }, ...node.children.map((child) => renderNode(child, space, node.id))),
  );
}

/** The agent's folder in this Space (agentFolder.ts). */
const agentTabs = (s: UiState, space: Space) => space.today.filter((id) => inAgentFolder(s.tabs, space, id)).map((id) => s.tabs[id]);

let agentFolderOpen = true;

/**
 * The tabs a coding agent opened, in a folder of their own above Today. The agent works in them
 * in the background; dragging one out makes it an ordinary tab.
 */
function renderAgentFolder(s: UiState, space: Space) {
  const folder = $('agent-folder');
  const tabs = agentTabs(s, space);
  folder.hidden = !tabs.length;
  if (!tabs.length) return folder.replaceChildren();
  const busy = !!s.agent?.busy;
  folder.classList.toggle('open', agentFolderOpen);
  folder.classList.toggle('busy', busy);
  // The toggle and Clear are buttons side by side, as Today's header has them, so each is a
  // keyboard stop of its own.
  const toggle = h(
    'button',
    {
      class: 'row agent-folder-toggle',
      'aria-expanded': String(agentFolderOpen),
      onclick: () => {
        agentFolderOpen = !agentFolderOpen;
        renderAgentFolder(state!, space);
      },
    },
    h('span', { class: 'row-icon folder-icon' }, busy ? h('span', { class: 'agent-dot' }) : icon('sparkle')),
    h('span', { class: 'title folder-name' }, busy ? 'Agent is working…' : 'Agent’s tabs'),
    h('span', { class: 'chevron' }, icon('chevron')),
  );
  const clear = h('button', { class: 'text-button', title: 'Close the agent’s tabs', onclick: () => tabs.forEach((tab) => api.close(tab.id)) }, 'Clear');
  // Its rows take no drops: a tab dropped among them would land in Today and leave the folder.
  folder.replaceChildren(
    h('div', { class: 'agent-folder-header' }, toggle, clear),
    h('div', { class: 'folder-children' }, ...tabs.map((tab) => tabRow(tab, space, undefined))),
  );
}

/** Today's tabs, with the two halves of a split drawn together as one row, as in Arc. */
function todayRows(s: UiState, space: Space): HTMLElement[] {
  const pair = todaySplit(s.tabs, space);
  const rows: HTMLElement[] = [];
  let pairDrawn = false;
  for (const id of space.today) {
    const tab = s.tabs[id];
    if (!tab || inAgentFolder(s.tabs, space, id)) continue;
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

/** A tab's row; `target` is where a tab dropped on it goes, and a row without one takes no drops. */
function tabRow(tab: TabInfo, space: Space, target: DropTarget | undefined) {
  const close = h(
    'span',
    {
      class: 'close',
      title: !target || target.zone === 'today' ? 'Close tab' : 'Unload tab',
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
    tab.loading ? spinner() : favicon(tab),
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
  wireTab(row, tab, target && { ...target, spaceId: space.id });
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
    // The hosts manifest.json's console scripts run on: *.local and *.test include bare local and test.
    return /^(localhost|local|test|127\.0\.0\.1|\[::1\])$|\.(localhost|local|test)$/.test(hostname);
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

/** Inline edit of the URL a pinned tab or favorite goes back to, started from the tab's context menu. */
function editHomeUrl(tabId: string) {
  const tab = state?.tabs[tabId];
  if (!tab?.homeUrl) return;
  const commit = (input: string) => api.setHomeUrl(tabId, input);
  const title = document.querySelector<HTMLElement>(`#pinned .row[data-tab-id="${CSS.escape(tabId)}"] .title`);
  // The title comes back whether or not the URL was taken (a bad or blank one only shows a message).
  if (title) return editInline(title, tab.homeUrl, commit, { commitBlank: true, done: () => state && render(state) });
  // A favorite is just an icon, so its URL gets a field of its own under the favorites.
  if (!state?.favorites.includes(tabId)) return;
  document.querySelector('.url-edit')?.remove();
  const field = h('div', { class: 'url-edit', role: 'textbox', 'aria-label': `URL of ${tabTitle(tab)}` });
  $('favorites').after(field);
  editInline(field, tab.homeUrl, commit, { commitBlank: true, done: () => field.remove() });
}

/** A Space's button drags among the others to reorder the Spaces; the drop's side picks before or after. */
function spaceDrag(s: UiState, spaceId: string): Props {
  const order = () => s.spaces.map((sp) => sp.id);
  const after = (e: DragEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  };
  const mark = (e: DragEvent, cls?: string) => {
    const el = e.currentTarget as HTMLElement;
    el.classList.remove('space-drop-before', 'space-drop-after');
    if (cls) el.classList.add(cls);
  };
  return {
    ondragstart: (e: DragEvent) => {
      draggedSpace = spaceId;
      e.dataTransfer!.setData(SPACE_DRAG_TYPE, spaceId);
      e.dataTransfer!.effectAllowed = 'move';
    },
    ondragend: () => (draggedSpace = undefined),
    ondragover: (e: DragEvent) => {
      if (!draggedSpace || !e.dataTransfer?.types.includes(SPACE_DRAG_TYPE)) return;
      if (spaceDropBefore(order(), draggedSpace, spaceId, after(e)) === null) return mark(e);
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      mark(e, after(e) ? 'space-drop-after' : 'space-drop-before');
    },
    ondragleave: (e: DragEvent) => mark(e),
    ondrop: (e: DragEvent) => {
      mark(e);
      if (!draggedSpace) return;
      e.preventDefault();
      const before = spaceDropBefore(order(), draggedSpace, spaceId, after(e));
      if (before !== null) api.moveSpace(draggedSpace, before);
      draggedSpace = undefined;
    },
  };
}

function wireTab(el: HTMLElement, tab: TabInfo, target: DropTarget | undefined) {
  el.dataset.tabId = tab.id;
  el.draggable = tab.device !== 'mobile';
  el.addEventListener('click', () => api.activate(tab.id));
  el.addEventListener('auxclick', (e) => e.button === 1 && api.close(tab.id));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.tabMenu(tab.id);
  });
  el.addEventListener('dragstart', (e) => {
    const space = state?.spaces.find((item) => item.id === state?.activeSpaceId);
    if (!space || tab.device === 'mobile') return e.preventDefault();
    draggedTab = { id: tab.id, spaceId: space.id };
    e.dataTransfer!.setData(DRAG_TYPE, tab.id);
    e.dataTransfer!.effectAllowed = 'move';
    $('favorites').classList.add('show-empty');
    updatePinnedVisibility(space);
    showSplitDrop(tab.id);
  });
  el.addEventListener('dragend', () => {
    clearDropTarget?.();
    if (draggedTab?.id !== tab.id) return;
    draggedTab = undefined;
    $('favorites').classList.remove('show-empty');
    hideSplitDrop();
    if (state) render(state);
  });
  if (target) acceptDrops(el, target, 'drop-before', el.classList.contains('row') && tab.device !== 'mobile' ? tab.id : undefined);
}

function acceptDrops(el: HTMLElement, target: DropTarget, hoverClass = 'drag-over', splitTarget?: string) {
  let hoveredSpaceId: string | undefined;
  let hoveredSide: 'left' | 'right' | undefined;
  const endHover = () => {
    hoveredSpaceId = undefined;
    hoveredSide = undefined;
    if (clearDropTarget === endHover) clearDropTarget = undefined;
    el.classList.remove(hoverClass, 'drop-split-left', 'drop-split-right');
    if (incomingDrop?.element !== el) return;
    incomingDrop = undefined;
    queueMicrotask(() => {
      if (!incomingDrop && deferredRows && state) render(state);
    });
  };
  const currentTarget = () => (!draggedTab || draggedTab.spaceId === state?.activeSpaceId) &&
    (!target.spaceId || target.spaceId === state?.activeSpaceId);
  const splitSide = (e: DragEvent): 'left' | 'right' | undefined => {
    if (!draggedTab || !state || !canDropToSplit(state.tabs, draggedTab.id, splitTarget)) return;
    const rect = el.getBoundingClientRect();
    // The split zones follow upstream #13. Top and bottom remain available for moving tabs.
    if (e.clientY - rect.top <= 7 || rect.bottom - e.clientY <= 7) return;
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 0.25) return 'left';
    if (x >= 0.4) return 'right';
  };
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.stopPropagation();
    clearDropTarget?.();
    if (!currentTarget()) return;
    e.preventDefault();
    hoveredSpaceId = state?.activeSpaceId;
    if (!draggedTab && hoveredSpaceId) incomingDrop = { element: el, spaceId: hoveredSpaceId };
    hoveredSide = splitSide(e);
    clearDropTarget = endHover;
    el.classList.add(hoveredSide ? `drop-split-${hoveredSide}` : hoverClass);
  });
  el.addEventListener('dragleave', (e) => {
    if (!(e.relatedTarget instanceof Node) || !el.contains(e.relatedTarget)) endHover();
  });
  el.addEventListener('drop', (e) => {
    const spaceId = hoveredSpaceId;
    const side = hoveredSide;
    endHover();
    const id = e.dataTransfer?.getData(DRAG_TYPE);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (!spaceId || spaceId !== state?.activeSpaceId || !currentTarget()) return;
    if (side !== splitSide(e) || (side && id !== draggedTab?.id)) return;
    hideSplitDrop();
    if (side && splitTarget) api.dropToSplit(id, side, { kind: 'row', tabId: splitTarget, spaceId });
    else api.moveTab(id, { ...target, spaceId });
  });
}

/**
 * Without `done`, the next state draws what was saved, and a cancel redraws now. A blank value is
 * dropped unless `commitBlank`, for an edit whose commit says what's wrong with it.
 */
function editInline(el: HTMLElement, current: string, commit: (value: string) => void, { done, commitBlank = false }: { done?: () => void; commitBlank?: boolean } = {}) {
  el.contentEditable = 'true';
  el.textContent = current;
  el.focus();
  document.getSelection()?.selectAllChildren(el);
  const finish = (save: boolean) => {
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    el.contentEditable = 'false';
    const value = el.textContent?.trim() ?? '';
    const changed = save && (!!value || commitBlank) && value !== current;
    if (changed) commit(value);
    if (done) done();
    else if (!changed && state) render(state);
  };
  const onKey = (e: KeyboardEvent) => {
    if (isEnter(e)) e.preventDefault(), finish(true);
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
  renderSiteShield(tab.url);
  $('zoom-reset').textContent = `${state.nav.zoom}%`;
  for (const id of ['site-copy', 'site-shot', 'site-boost', 'site-devtools', 'site-clear', 'zoom-in', 'zoom-out', 'zoom-reset']) {
    ($(id) as HTMLButtonElement).disabled = !origin;
  }
}

/** The shield: ad and tracker blocking for this page's site, as uBlock Origin's power button. */
function renderSiteShield(url: string) {
  let hostname = '';
  try {
    const parsed = new URL(url);
    if (/^https?:$/.test(parsed.protocol) && isSiteHost(parsed.hostname)) hostname = parsed.hostname;
  } catch {
    // Not a web page.
  }
  const everywhere = state!.adBlock !== false;
  const on = everywhere && !!hostname && blocksAdsOn(state!.adBlockAllowed, hostname);
  const toggle = $<HTMLInputElement>('site-adblock');
  toggle.checked = on;
  toggle.disabled = !everywhere || !hostname || incognito;
  toggle.dataset.host = hostname;
  $('site-shield').classList.toggle('off', !on);
  $('site-shield-note').textContent = !everywhere
    ? 'Off for every site in Settings'
    : !hostname
      ? 'Not for this page'
      : incognito
        ? 'Change it in a regular window'
        : on
          ? `On for ${hostname}`
          : `Off for ${hostname}`;
}

$('site-adblock').addEventListener('change', (e) => {
  const toggle = e.currentTarget as HTMLInputElement;
  if (toggle.dataset.host) api.setSiteAdBlock(toggle.dataset.host, toggle.checked);
});
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
// ⌘Z (Ctrl+Z) in the sidebar takes back a Space deletion, bulk close or move; text fields keep their own undo.
document.addEventListener('keydown', (e) => {
  if (!isUndoKey(e) || (e.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"]')) return;
  e.preventDefault();
  api.undo();
});
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
spaceName.addEventListener('keydown', (e) => (isEnter(e) || e.key === 'Escape') && closeSpaceEditor());
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

// One ranked list, the way Arc's Command Bar shows its results (lib/commandBar.ts says how it ranks).

interface PaletteItem {
  kind: ResultKind;
  /** An icon name, a tab (its favicon) or a URL (that site's icon). */
  icon: IconName | TabInfo | string;
  label: string;
  /** After the label, muted: the page's address ("1password.com"), or what a developer command does. */
  sub?: string;
  /** A keyboard shortcut for the same command, shown on the right. */
  hint?: string;
  /** On the right with an arrow: "Switch to Tab" on an open tab. */
  go?: string;
  /** What a screen reader says for the row. */
  speak: string;
  run: () => void;
  /** Shown under the results while this item is selected, e.g. a decoded JWT. */
  detail?: string;
  score: number;
  recency?: number;
  url?: string;
}

const palette = $('palette');
const paletteInput = $<HTMLInputElement>('palette-input');
const paletteList = $('palette-results');
let paletteMode: PaletteMode = 'new-tab';
let paletteItems: PaletteItem[] = [];
let selected = 0;
/** Arrow keys or the mouse moved the selection since the last keystroke. */
let selectionMoved = false;
/** Tab in an empty bar: the list is Flecha's actions only, as in Arc. */
let actionMode = false;
/** What was typed; the field may show more, the inline completion after it. */
let typed = '';
let completion: ReturnType<typeof inlineCompletion>;
/** The last keystroke added text at the end, so the address may be completed. */
let mayComplete = false;

function looksLikeUrl(q: string) {
  return webAddress(q) !== undefined;
}

function openPalette(mode: PaletteMode) {
  // As in Arc, the same shortcut again closes the bar.
  if (!palette.hidden && paletteMode === mode) return closePalette();
  paletteMode = mode;
  palette.hidden = false;
  showWhenFrameGrown();
  actionMode = false;
  const space = state?.spaces.find((s) => s.id === state!.activeSpaceId);
  const active = space?.activeTabId ? state?.tabs[space.activeTabId] : undefined;
  paletteInput.value = typed = mode === 'navigate' && active ? active.url : '';
  completion = undefined;
  paletteInput.focus();
  paletteInput.select();
  selected = 0;
  selectionMoved = false;
  historyResults = [];
  updatePalette();
  refreshHistory();
  refreshSuggestions();
}

function closePalette() {
  if (palette.hidden) return;
  hidePalette();
  api.closePalette();
}

/**
 * In a window's frame page the bar opens as the frame grows from the sidebar to the whole window,
 * and the growth can land after the bar is laid out: one frame on a busy machine, a whole typed
 * query in a loaded test run (2026-10-26). Until then the bar stays transparent, so it appears
 * once, at the window's centre, with its opening animation. Grown: wider than the widest frame
 * before it grows, the floating sidebar's, or as wide as the window. Only frame pages wait.
 */
let revealWhenGrown: (() => void) | undefined;
/** The floating sidebar's frame is wider than the sidebar by kFlechaFloatMargin + kFlechaFloatShadow (patch 0010). */
const FLOATING_FRAME_EXTRA = 10 + 28;
function showWhenFrameGrown() {
  stopWaitingForFrame();
  const sidebar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar'));
  const grown = () =>
    !('frame' in document.documentElement.dataset) || innerWidth > sidebar + FLOATING_FRAME_EXTRA || innerWidth >= outerWidth;
  if (grown()) return;
  palette.classList.add('opening');
  revealWhenGrown = () => grown() && stopWaitingForFrame();
  addEventListener('resize', revealWhenGrown);
}
function stopWaitingForFrame() {
  if (revealWhenGrown) removeEventListener('resize', revealWhenGrown);
  revealWhenGrown = undefined;
  palette.classList.remove('opening');
}

/** Hides the bar here; main already knows when it closed the bar itself (a tab switch, say). */
function hidePalette() {
  stopWaitingForFrame();
  palette.hidden = true;
  actionMode = false;
  requestSuggestions(undefined);
  // The next opening asks again: an answer kept from this one could be shown in its place.
  suggestions = undefined;
}

/**
 * Commands the bar can run, found by typing any word of their label or keywords. `emptyBar`
 * ones fill an empty bar after the recent tabs, as Arc's shows two actions there.
 */
const ACTIONS: Array<{ label: string; keywords: string; icon: IconName; shortcut?: string; emptyBar?: true; available?: () => boolean; run: () => void }> = [
  { label: 'New Space', keywords: 'space create add', icon: 'space', shortcut: 'newSpace', emptyBar: true, run: () => api.newSpace() },
  { label: 'Edit Space', keywords: 'space rename emoji colour color icon', icon: 'space', run: () => state && openSpaceEditor(state.activeSpaceId) },
  {
    label: 'New Flechinha Window',
    keywords: 'flechinha little mini small window quick lookup',
    icon: 'miniWindow',
    shortcut: 'newFlechinha',
    emptyBar: true,
    run: () => api.newFlechinha(),
  },
  { label: 'Settings', keywords: 'preferences settings config options', icon: 'settings', shortcut: 'settings', run: () => api.openSettings() },
  { label: 'Responsive View', keywords: 'mobile phone responsive device split', icon: 'phone', shortcut: 'responsive', run: () => api.toggleResponsive() },
  { label: 'Toggle Sidebar', keywords: 'sidebar hide show', icon: 'sidebar', shortcut: 'toggleSidebar', run: () => api.toggleSidebar() },
  { label: 'Clear Today Tabs', keywords: 'clear archive today close', icon: 'archive', shortcut: 'clearToday', run: () => api.clearToday() },
  { label: 'Show Downloads', keywords: 'downloads files', icon: 'download', run: () => (downloadsPanel.hidden = false) },
  { label: 'Show History', keywords: 'history visited pages clear', icon: 'history', shortcut: 'history', run: () => api.openHistory() },
  {
    label: 'Import from another browser',
    keywords: 'import migrate bookmarks history arc chrome safari firefox brave edge vivaldi opera',
    icon: 'import',
    run: () => void importFromBrowser(),
  },
  { label: 'Import from Flecha (Electron)', keywords: 'import migrate electron flecha state', icon: 'import', run: () => api.importMenu() },
  {
    label: 'Restore Spaces From Before Import',
    keywords: 'undo restore revert backup import flecha electron state',
    icon: 'import',
    run: () => api.restoreBeforeImport(),
  },
  { label: 'Open Boosts Folder', keywords: 'boosts folder scripts css', icon: 'zap', run: () => api.openBoostsFolder() },
  {
    // Names what it takes back: "Undo Delete “Work”".
    get label() {
      return `Undo ${state?.undo ?? ''}`.trim();
    },
    keywords: 'undo restore deleted closed moved space tabs',
    icon: 'history',
    available: () => !!state?.undo,
    run: () => api.undo(),
  },
];

/** The actions that can run now. */
const offeredActions = () => ACTIONS.filter((a) => a.available?.() ?? true);

/** Among all results, one letter matches too much to offer actions; on their own (after Tab), it doesn't. */
function matchingActions(q: string, minLength = 2) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || q.length < minLength) return [];
  return offeredActions().filter((a) => {
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

/** An open tab; picking it goes to it ("Switch to Tab") rather than opening the page again. */
function tabItem(tab: TabInfo, place: number): PaletteItem {
  const split = paletteMode === 'split';
  return {
    kind: 'tab',
    icon: tab,
    label: tabTitle(tab),
    go: split ? 'Split with Tab' : 'Switch to Tab',
    speak: `${split ? 'Split with tab' : 'Switch to tab'}: ${tabTitle(tab)}`,
    run: split ? () => api.splitWith(tab.id) : () => api.activate(tab.id),
    score: place,
    recency: tab.lastActive,
    url: tab.url,
  };
}

function actionItem(action: (typeof ACTIONS)[number], place: number): PaletteItem {
  const hint = action.shortcut && state?.shortcuts[action.shortcut];
  return { kind: 'action', icon: action.icon, label: action.label, hint, speak: `Action: ${action.label}`, run: action.run, score: place };
}

/** Tabs the bar may switch to: not the one you are on, as Chromium's omnibox doesn't offer it either. */
function offeredTabs() {
  const activeId = state?.spaces.find((s) => s.id === state!.activeSpaceId)?.activeTabId;
  return Object.values(state?.tabs ?? {}).filter((t) => t.id !== activeId);
}

/** An empty bar, as Arc's: the most recent other tabs, then two actions. */
function emptyBarItems(): PaletteItem[] {
  const recent = offeredTabs()
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, EMPTY_TABS)
    .map((tab) => tabItem(tab, 0));
  return [...recent, ...offeredActions().filter((a) => a.emptyBar).slice(0, EMPTY_ACTIONS).map((a) => actionItem(a, 0))];
}

function actionItems(q: string, minLength?: number): PaletteItem[] {
  if (!q) return offeredActions().map((a) => actionItem(a, 0));
  return rank(matchingActions(q, minLength).map((a) => actionItem(a, score('action', matchQuality(q, a.label) === 'start' ? 'start' : 'word')!)));
}

function queryItems(q: string): PaletteItem[] {
  const s = state!;
  const items: PaletteItem[] = [];
  const open = { navigate: api.navigate, 'new-tab': api.newTab, split: api.splitNew }[paletteMode];
  const reopen = paletteMode === 'split' ? api.splitNew : api.newTab;
  const activeId = s.spaces.find((sp) => sp.id === s.activeSpaceId)?.activeTabId;
  const activeUrl = activeId ? s.tabs[activeId]?.url : undefined;
  const isUrl = looksLikeUrl(q);
  const add = (item: Omit<PaletteItem, 'score'>, kind: ResultKind, match?: Match) => {
    const value = score(kind, match);
    if (value !== undefined) items.push({ ...item, score: value });
  };

  if (isUrl) add({ kind: 'address', icon: 'globe', label: q, speak: `Open ${q}`, run: () => open(q) }, 'address');
  else add({ kind: 'search', icon: 'search', label: q, speak: `Search ${s.searchEngineName}: ${q}`, run: () => open(q) }, 'search');

  // The page the address completes to, which the field shows (inline autocomplete).
  if (completion) {
    const done = completion;
    const tab = offeredTabs().find((t) => t.url === done.url);
    if (tab) items.push(tabItem(tab, score('completion')!));
    else add({ kind: 'completion', icon: done.url, label: done.title || done.text, sub: done.title ? done.text : undefined, speak: `Open ${done.text}`, run: () => open(done.url), url: done.url }, 'completion');
  }

  // `env` lists the current page on the project's other environments.
  if (/^env\b/i.test(q) && s.environment) {
    for (const target of s.environment.switches) {
      add({ kind: 'developer', icon: 'code', label: `Switch to ${target.label}`, sub: host(target.url), speak: `Switch to ${target.label}`, run: () => api.navigate(target.url) }, 'developer');
    }
  }
  // `boost` edits this site's boost files.
  if (/^boost/i.test(q) && activeUrl) {
    const site = host(activeUrl);
    add({ kind: 'developer', icon: 'zap', label: `Edit boost script for ${site}`, sub: 'TypeScript', speak: `Edit boost script for ${site}`, run: () => api.editBoost('script') }, 'developer');
    add({ kind: 'developer', icon: 'zap', label: `Edit boost styles for ${site}`, sub: 'CSS, live', speak: `Edit boost styles for ${site}`, run: () => api.editBoost('styles') }, 'developer');
  }
  for (const dev of devSuggestions(q, activeUrl)) {
    const run = () => (dev.url ? open(dev.url) : api.copyText(dev.copy ?? '', 'Copied'));
    add({ kind: 'developer', icon: dev.url ? dev.url : 'code', label: dev.label, sub: dev.sub, speak: dev.label, detail: dev.copy, run }, 'developer');
  }
  items.push(...actionItems(q).slice(0, 4));

  // The engine's suggestions for exactly what is typed now, in its order, after the typed search.
  if (!isUrl && suggestions?.query === q) {
    const engine = s.searchEngine;
    for (const text of suggestions.list) {
      add({ kind: 'suggestion', icon: 'search', label: text, speak: `Search suggestion: ${text}`, run: () => open(searchUrl(text, engine)) }, 'suggestion');
    }
  }

  const tabs = offeredTabs()
    .map((tab) => ({ tab, match: matchQuality(q, tabTitle(tab), displayUrl(tab.url)) }))
    .filter(({ match }) => match)
    .sort((a, b) => score('tab', b.match)! - score('tab', a.match)! || b.tab.lastActive - a.tab.lastActive)
    .slice(0, 6);
  for (const { tab, match } of tabs) items.push(tabItem(tab, score('tab', match)!));
  // Until the history for this query arrives, the last query's shows only where it still matches.
  const visited = historyResults.map((entry) => ({ entry, match: matchQuality(q, entry.title, displayUrl(entry.url)) })).filter(({ match }) => match);
  for (const { entry, match } of visited.slice(0, 6)) {
    const address = displayUrl(entry.url);
    const titled = entry.title && entry.title !== entry.url;
    const page = { kind: 'history' as const, icon: entry.url, label: titled ? entry.title : address, sub: titled ? address : undefined, url: entry.url, recency: entry.lastVisit };
    add({ ...page, speak: `History: ${page.label}${page.sub ? `, ${page.sub}` : ''}`, run: () => open(entry.url) }, 'history', match);
  }
  const archived = s.archive.map((a) => ({ a, match: matchQuality(q, a.title, displayUrl(a.url)) })).filter(({ match }) => match);
  for (const { a, match } of archived.slice(0, 5)) {
    const address = displayUrl(a.url);
    const page = { kind: 'archive' as const, icon: a.url, label: a.title || address, sub: a.title ? address : undefined, url: a.url };
    add({ ...page, speak: `Archived tab: ${page.label}${page.sub ? `, ${page.sub}` : ''}`, run: () => reopen(a.url) }, 'archive', match);
  }
  return rank(items);
}

function updatePalette() {
  if (!state) return;
  const q = typed.trim();
  $('palette-mode').textContent = actionMode ? 'Actions' : { navigate: 'Current Tab', split: 'Split View', 'new-tab': '' }[paletteMode];
  paletteInput.placeholder = actionMode ? 'Search actions…' : 'Search or Enter URL…';
  const items = actionMode ? actionItems(q, 1) : q ? queryItems(q) : emptyBarItems();

  paletteItems = items;
  selected = Math.min(selected, Math.max(items.length - 1, 0));
  const rows = items.map((item, i) =>
    h(
      'li',
      {
        id: `palette-option-${i}`,
        role: 'option',
        'aria-selected': String(i === selected),
        'aria-label': item.speak,
        class: `item${i === selected ? ' selected' : ''}`,
        dataset: { index: String(i), kind: item.kind },
        onmousemove: () => {
          if (selected !== i) moveSelection(i);
        },
        onmousedown: (e: Event) => {
          e.preventDefault();
          runItem(i);
        },
      },
      h('span', { class: 'item-icon' }, itemIcon(item.icon)),
      h('span', { class: 'label' }, h('span', { class: 'title' }, item.label), item.sub ? h('span', { class: 'sub' }, ` — ${item.sub}`) : null),
      item.hint ? h('kbd', {}, item.hint) : null,
      item.go ? h('span', { class: 'go' }, item.go, h('span', { class: 'go-arrow' }, icon('arrowRight'))) : null,
    ),
  );
  paletteList.replaceChildren(...rows);
  paletteList.querySelector('.item.selected')?.scrollIntoView({ block: 'nearest' });
  if (items.length) paletteInput.setAttribute('aria-activedescendant', `palette-option-${selected}`);
  else paletteInput.removeAttribute('aria-activedescendant');
  // The field's icon is the selected result's, as Arc's shows the top hit's.
  $('palette-icon').replaceChildren(itemIcon(items[selected]?.icon ?? (actionMode ? 'zap' : 'search')));
  const detail = $('palette-detail');
  detail.hidden = !items[selected]?.detail;
  detail.textContent = items[selected]?.detail ?? '';
}

/** The same result after a redraw: a page by its address (its title may have changed), anything else by its label. */
function sameItem(a: PaletteItem, b: PaletteItem) {
  return a.kind === b.kind && (a.url ? a.url === b.url : a.label === b.label);
}

/**
 * Selects row `i`, by arrow key or mouse. The completed page's row stays where it is, so nothing
 * moves under the pointer; the field shows the completion only while that row is selected, as
 * Chromium's omnibox does.
 */
function moveSelection(i: number) {
  selected = i;
  selectionMoved = true;
  if (completion) showCompletion(paletteItems[i]?.url === completion.url);
  updatePalette();
}

/** The field with the inline completion after what was typed, the added part selected; or just what was typed. */
function showCompletion(shown: boolean) {
  paletteInput.value = shown && completion ? typed + completion.text.slice(typed.length) : typed;
  paletteInput.setSelectionRange(shown ? typed.length : paletteInput.value.length, paletteInput.value.length);
}

/**
 * Redraws after history, suggestions or tabs change. Until the arrows or mouse move the
 * selection, the top hit stays selected; after, the same item does.
 */
function refreshPalette() {
  const target = selectionMoved ? paletteItems[selected] : undefined;
  updatePalette();
  const at = target ? paletteItems.findIndex((item) => sameItem(item, target)) : -1;
  if (at >= 0 && at !== selected) (selected = at), updatePalette();
}

function runItem(i: number) {
  const item = paletteItems[i];
  if (!item) return;
  // Closed first, so a run that fails or opens the bar again doesn't leave it over the sidebar.
  closePalette();
  item.run();
}

/**
 * Completes the typed address in the field from open tabs and history, with the added part
 * selected. Only while the caret is still at the end and no other row was chosen: history may
 * arrive after either.
 */
function completeInline() {
  if (!mayComplete || selectionMoved || actionMode || paletteInput.value !== typed || !state) return;
  if (paletteInput.selectionStart !== typed.length || paletteInput.selectionEnd !== typed.length) return;
  const visited = [
    ...Object.values(state.tabs).map((t) => ({ url: t.url, title: tabTitle(t), weight: t.lastActive })),
    ...historyResults.map((e) => ({ url: e.url, title: e.title, weight: e.visits })),
  ];
  completion = inlineCompletion(typed, visited);
  if (completion) showCompletion(true);
}

// History lives in the main process; results arrive asynchronously and are dropped if stale.
let historyResults: HistoryEntry[] = [];
function refreshHistory() {
  const q = typed.trim();
  if (!q || actionMode) {
    historyResults = [];
    return;
  }
  api.searchHistory(historyQuery(q)).then((results) => {
    if (typed.trim() !== q || palette.hidden || actionMode) return;
    historyResults = results;
    completeInline();
    refreshPalette();
  });
}

// Search suggestions, for the query they were asked for only; requests for older queries are aborted.
let suggestions: { query: string; list: string[] } | undefined;
const requestSuggestions = suggestionRequests(
  (query, signal) => api.searchSuggestions(query, signal),
  (query, list) => {
    if (palette.hidden || actionMode || typed.trim() !== query) return;
    suggestions = { query, list };
    refreshPalette();
  },
);
function refreshSuggestions() {
  const q = typed.trim();
  requestSuggestions(q && !actionMode && !looksLikeUrl(q) && suggestable(q) ? q : undefined);
}

paletteInput.addEventListener('input', (e) => {
  typed = paletteInput.value;
  completion = undefined;
  // Only typing at the end completes; deleting the completion leaves what was typed.
  mayComplete = (e as InputEvent).inputType?.startsWith('insert') && paletteInput.selectionEnd === typed.length;
  selected = 0;
  selectionMoved = false;
  completeInline();
  updatePalette();
  refreshHistory();
  refreshSuggestions();
});
paletteInput.addEventListener('keydown', (e) => {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (e.key === 'Escape') closePalette();
  // Shift+Enter is Enter: Arc's Shift+Enter (Instant Links) is an Arc Max AI feature.
  else if (isEnter(e)) runItem(selected);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = paletteItems.length;
    if (n) moveSelection((selected + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
  } else if (e.key === 'Tab' && plain && !e.shiftKey) {
    // Tab keeps focus in the bar; in an empty bar it searches actions, as Arc's does.
    e.preventDefault();
    if (!typed && !actionMode) {
      actionMode = true;
      selected = 0;
      updatePalette();
    }
  } else if (e.key === 'Backspace' && actionMode && !paletteInput.value) {
    actionMode = false;
    selected = 0;
    updatePalette();
  } else return;
});
palette.addEventListener('mousedown', (e) => {
  if (e.target === palette) closePalette();
});
// Focus going to the page or another window (a tab switch, a click in the page) leaves the field
// the active element of a document that has lost focus, so that closes the bar too.
paletteInput.addEventListener('blur', () =>
  setTimeout(() => (!document.hasFocus() || document.activeElement !== paletteInput) && closePalette(), 0),
);

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
$('peek-open').dataset.kbd = displayKeys('CmdOrCtrl+O');
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
  if (d.warning === 'dangerous') return 'This file may harm your computer';
  if (d.warning === 'insecure') return 'Sent without encryption (HTTP)';
  if (d.state === 'completed') return formatBytes(d.received);
  if (d.state === 'cancelled') return 'Cancelled';
  if (d.state === 'interrupted') return d.canResume ? 'Stopped' : 'Failed';
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
        d.state === 'progressing' && !d.warning
          ? h('span', { class: 'bar' }, h('span', { class: 'fill', style: `width: ${Math.round(progress * 100)}%` }))
          : null,
        downloadActions(d),
      );
    }),
  );
  if (!items.length) $('downloads-list').append(h('li', { class: 'empty' }, 'No downloads yet'));
}

/** What a download's row offers: a decision for a held one, resume or retry for a stopped one. */
function downloadActions(d: DownloadInfo) {
  const button = (label: string, run: () => void, kind = 'text-button') =>
    h('button', { class: kind, onclick: (e: Event) => (e.stopPropagation(), run()) }, label);
  if (d.warning) return h('span', { class: 'actions' }, button('Discard', () => api.discardDownload(d.id)), button('Keep', () => api.keepDownload(d.id), 'text-button keep'));
  if (d.state === 'interrupted') {
    return h('span', { class: 'actions' }, d.canResume ? button('Resume', () => api.resumeDownload(d.id)) : button('Retry', () => api.retryDownload(d.id)));
  }
  const progressing = d.state === 'progressing';
  return h(
    'button',
    {
      class: 'icon-button',
      title: progressing ? 'Cancel' : isMac ? 'Show in Finder' : 'Show in Folder',
      onclick: (e: Event) => {
        e.stopPropagation();
        if (progressing) api.cancelDownload(d.id);
        else api.revealDownload(d.id);
      },
    },
    progressing ? icon('close') : icon('folder'),
  );
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
let hoveredPageDrop: { half: HTMLElement; target: Parameters<FlechaApi['dropToSplit']>[2] } | undefined;

/** Drop zones over the page while a tab is dragged, unless it's the tab already on screen. */
function showSplitDrop(tabId: string) {
  const space = state?.spaces.find((s) => s.id === state!.activeSpaceId);
  if (surface !== 'window' || !state || !space || draggedTab?.spaceId !== space.id || !canDropToSplit(state.tabs, tabId, pageSplitTarget(space, tabId))) return hideSplitDrop();
  if (!splitDrop.hidden) return;
  splitDrop.hidden = false;
  api.setTabDragging(true);
}

function hideSplitDrop() {
  if (splitDrop.hidden) return;
  hoveredPageDrop = undefined;
  splitDrop.hidden = true;
  for (const half of splitDrop.children) half.classList.remove('over');
  api.setTabDragging(false);
}

for (const half of splitDrop.querySelectorAll<HTMLElement>('.drop-half')) {
  half.addEventListener('dragover', (e) => {
    if (splitDrop.hidden || !draggedTab || !e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    const space = state?.spaces.find((s) => s.id === draggedTab?.spaceId);
    const target = space && pageSplitTarget(space, draggedTab.id);
    if (!space || !target || space.id !== state?.activeSpaceId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    half.classList.add('over');
    hoveredPageDrop = { half, target: { kind: 'page', tabId: target, spaceId: space.id } };
  });
  half.addEventListener('dragleave', () => {
    half.classList.remove('over');
    if (hoveredPageDrop?.half === half) hoveredPageDrop = undefined;
  });
  half.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData(DRAG_TYPE);
    e.preventDefault();
    if (splitDrop.hidden) return;
    const hovered = hoveredPageDrop;
    hideSplitDrop();
    if (id && hovered?.half === half) api.dropToSplit(id, half.dataset.side as 'left' | 'right', hovered.target);
  });
}

// ---- hidden sidebar: reveal at the edge, hide again when the mouse leaves -------------

// The edge strip stays under the pointer while the floating sidebar is out (it covers the gap
// between the window's edge and the card, styles.css), so the card sliding in under a pointer
// ---- resizing the sidebar --------------------------------------------------------
// Drag its right edge: the window's layout follows as you go, and the width is kept for every
// window when you let go.
const resizeHandle = $('sidebar-resize');
resizeHandle.setAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH));
resizeHandle.setAttribute('aria-valuemax', String(SIDEBAR_MAX_WIDTH));
resizeHandle.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizeHandle.setPointerCapture(e.pointerId);
  const start = { x: e.clientX, width: $('sidebar').offsetWidth };
  let width = start.width;
  const move = (ev: PointerEvent) => {
    width = start.width + ev.clientX - start.x;
    api.resizeSidebar(width, false);
  };
  const end = () => {
    resizeHandle.removeEventListener('pointermove', move);
    resizeHandle.removeEventListener('pointerup', end);
    resizeHandle.removeEventListener('pointercancel', end);
    api.resizeSidebar(width, true);
  };
  resizeHandle.addEventListener('pointermove', move);
  resizeHandle.addEventListener('pointerup', end);
  resizeHandle.addEventListener('pointercancel', end);
});

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

// ---- window controls and menu (Linux, Windows) ------------------------------------
// Flecha's own window has no title bar there: its close, minimize and maximize circles sit
// where macOS draws the traffic lights, and the menu button holds what the macOS menu bar
// does (styles.css, "window controls and menu").

document.documentElement.dataset.platform = isMac ? 'mac' : 'other';
const ownWindow = !isMac && document.documentElement.dataset.frame !== undefined && typeof chrome.flechaPrivate?.getWindowId === 'function';

if (ownWindow) {
  setupWindowControls(chrome.flechaPrivate.getWindowId());

  const menuButton = $('btn-menu');
  const openMenu = async (keyboard: boolean) => {
    menuButton.setAttribute('aria-expanded', 'true');
    try {
      const picked = await showPageMenu(windowMenu(), { anchor: menuButton, keyboard });
      if (picked) picked.run();
      else menuButton.focus();
    } finally {
      menuButton.setAttribute('aria-expanded', 'false');
    }
  };
  // A click from the keyboard (Enter, Space) has no pointer position: detail 0.
  menuButton.onclick = (e) => void openMenu(e.detail === 0);
  menuButton.onkeydown = (e) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    void openMenu(true);
  };
}

/**
 * What the macOS app menu and menu bar give you that Linux and Windows would otherwise have no
 * way to reach. The rest of the menu bar is elsewhere already: editing in the page's own menu
 * and keys, tabs and Spaces in the sidebar's menus, the window's own controls beside this.
 */
function windowMenu(): MenuEntry<() => void>[] {
  const keys = (id: string) => state?.shortcuts[id] || undefined;
  const item = (label: string, run: () => void, accel?: string) => ({ label, run, accel });
  const regular = !chrome.extension.inIncognitoContext;
  const canQuit = typeof chrome.flechaPrivate?.quit === 'function';
  return [
    // An incognito window can't open a regular one from here; Chromium's own Ctrl+N does.
    ...(regular ? [item('New window', () => api.newWindow(), 'Ctrl+N')] : []),
    item('New incognito window', () => api.newIncognitoWindow(), 'Ctrl+Shift+N'),
    item('New Flechinha window', () => api.newFlechinha(), keys('newFlechinha')),
    { separator: true },
    item('History', () => api.openHistory(), keys('history')),
    item('Downloads', () => ($('downloads-panel').hidden = false)),
    item('Boosts', () => api.openSettings('boosts')),
    ...(regular ? [item('Extensions', () => api.openExtensions())] : []),
    { separator: true },
    item('Find in page…', () => api.runCommand('find'), keys('find')),
    {
      label: 'Zoom',
      submenu: [item('Zoom in', () => api.zoom(1), keys('zoomIn')), item('Zoom out', () => api.zoom(-1), keys('zoomOut')), item('Actual size', () => api.zoom(0), keys('actualSize'))],
    },
    item('Print…', () => api.print(), 'Ctrl+P'),
    item('Developer tools', () => api.openDevTools(), keys('devTools')),
    { separator: true },
    item('Import from another browser…', () => void importFromBrowser()),
    item('Settings', () => api.openSettings(), keys('settings')),
    { label: 'Help', submenu: [item('Keyboard shortcuts', () => api.openSettings('shortcuts'), keys('shortcuts')), item('Flecha help', () => api.openHelp())] },
    item('About Flecha', () => api.openAbout()),
    // Quitting so that every window comes back takes the browser's own Quit (patch 0070).
    ...(canQuit ? [{ separator: true } as const, item('Quit Flecha', () => api.quit(), keys('quit'))] : []),
  ];
}

// ---- wiring ---------------------------------------------------------------------

$('btn-sidebar').onclick = () => api.toggleSidebar();
$('btn-back').onclick = () => api.back();
$('btn-forward').onclick = () => api.forward();
$('btn-reload').onclick = () => {
  if ($('btn-reload').dataset.action !== 'stop') return api.reload();
  stoppedTab = progressTab;
  api.stop();
};
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
  if ((e.target as Element).closest('button, a, input, textarea, select, label, [contenteditable], .row, .popover, #extensions, #urlbar-wrap, #agent-status')) return;
  e.preventDefault();
  api.spaceMenu(state.activeSpaceId);
});

acceptDrops($('favorites'), { zone: 'favorites' });
acceptDrops($('pinned'), { zone: 'pinned' });
acceptDrops($('pinned-header'), { zone: 'pinned' });
const pinnedSection = $('pinned-section');
function externalPinExpansion(expanded: boolean) {
  if (externalPinnedDrag === expanded) return;
  externalPinnedDrag = expanded;
  const space = state?.spaces.find((item) => item.id === state?.activeSpaceId);
  if (space) updatePinnedVisibility(space);
}
pinnedSection.addEventListener('dragenter', (event) => {
  if (!draggedTab && event.dataTransfer?.types.includes(DRAG_TYPE)) externalPinExpansion(true);
});
pinnedSection.addEventListener('dragleave', (event) => {
  if (!(event.relatedTarget instanceof Node) || !pinnedSection.contains(event.relatedTarget)) externalPinExpansion(false);
});
pinnedSection.addEventListener('drop', () => externalPinExpansion(false), true);
$('btn-toggle-pinned').onclick = () => {
  const space = state?.spaces.find((item) => item.id === state?.activeSpaceId);
  if (space) api.updateSpace(space.id, { pinnedCollapsed: !space.pinnedCollapsed });
};
acceptDrops($('today'), { zone: 'today' });
acceptDrops($('btn-newtab'), { zone: 'today' });

const renderOnboarding = setupOnboarding(api, h, icon);
api.onState((s) => {
  render(s);
  renderOnboarding(s);
});
api.onPalette(openPalette);
api.onClosePalette(hidePalette);
api.onEditSpace(openSpaceEditor);
api.onRenameTab(renameTab);
api.onEditHomeUrl(editHomeUrl);
api.onPeek(renderPeek);
api.onDownloads(renderDownloads);
onReconnect(() => {
  if (!palette.hidden) hidePalette();
  if (surface === 'window') api.setTabDragging(!splitDrop.hidden);
});
api.ready();
