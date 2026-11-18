import type { RecordedKey, SettingsApi, SettingsView } from '../../shared/types';
import { ICONS, type IconName } from './icons.js';
import { setupTabsPane } from './tabsPane.js';
import { setupVsrPane } from './vsrPane.js';
import { setupDebugPane } from './debugPane.js';
import { isEnter } from '../lib/keys';
import { importFromBrowser } from '../windowUi';
import { onReconnect } from '../client';
import { toast } from '../settingsUi';

declare global {
  interface Window {
    settings: SettingsApi;
  }
}

const api = window.settings;
setupVsrPane(api);
setupDebugPane(api);

function icon(name: IconName) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.innerHTML = `<path d="${ICONS[name]}"/>`;
  return el;
}

setupTabsPane(icon, toast);

for (const el of document.querySelectorAll<HTMLElement>('i[data-icon]')) el.replaceWith(icon(el.dataset.icon as IconName));

// ---- navigation: one pane at a time, like System Settings ----------------------

let lastShown = 'general';

function showPane(name: string) {
  closeSearch();
  const item = document.querySelector<HTMLElement>(`.nav-item[data-pane="${name}"]`) ?? document.querySelector<HTMLElement>('.nav-item')!;
  for (const el of document.querySelectorAll<HTMLElement>('.nav-item')) el.classList.toggle('selected', el === item);
  for (const pane of document.querySelectorAll<HTMLElement>('.pane')) pane.hidden = pane.dataset.pane !== item.dataset.pane;
  document.getElementById('pane-title')!.textContent = item.textContent!.trim();
  try {
    lastShown = item.dataset.pane!;
    localStorage.setItem('pane', item.dataset.pane!);
  } catch {
    // Remembering the pane is a nicety.
  }
}

for (const item of document.querySelectorAll<HTMLElement>('.nav-item')) item.addEventListener('click', () => showPane(item.dataset.pane!));
let lastPane = 'general';
try {
  lastPane = localStorage.getItem('pane') ?? lastPane;
} catch {
  // Private storage can be unavailable.
}
// A pane asked for by the menu (Help → Keyboard Shortcuts) wins over the last one used.
showPane(location.hash.slice(1) || lastPane);
api.onPane(showPane);

// ---- search: every setting, shortcut and pane, found by any word -------------------------

const search = document.getElementById('search') as HTMLInputElement;
const results = document.getElementById('search-results')!;

interface SearchHit {
  pane: HTMLElement;
  /** The row to scroll to and highlight; the pane itself when the pane's name matched. */
  target?: HTMLElement;
  title: string;
  detail: string;
}

/** Read from the page each time, so settings drawn later (shortcuts, projects) are found too. */
function searchIndex(): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const pane of document.querySelectorAll<HTMLElement>('.pane[data-pane]')) {
    const item = document.querySelector<HTMLElement>(`.nav-item[data-pane="${pane.dataset.pane}"]`);
    if (!item) continue;
    const about = [...pane.querySelectorAll('.lead, .footnote')].map((p) => p.textContent!.trim().replace(/\s+/g, ' ')).join(' ');
    hits.push({ pane: item, title: item.textContent!.trim(), detail: about });
    for (const row of pane.querySelectorAll<HTMLElement>('.row, .theme-card')) {
      const title = row.querySelector('strong, .shortcut-label')?.textContent?.trim() ?? row.textContent!.trim();
      const detail = row.querySelector('small')?.textContent?.trim() ?? row.querySelector('kbd, .keycap')?.textContent?.trim() ?? '';
      if (title) hits.push({ pane: item, target: row, title, detail });
    }
  }
  return hits;
}

function runSearch() {
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return closeSearch();
  // Settings whose name matches come first, then those whose description does, then whole panes.
  const rank = (hit: SearchHit) => (words.every((w) => hit.title.toLowerCase().includes(w)) ? 0 : hit.target ? 1 : 2);
  const matches = searchIndex()
    .filter((hit) => {
      const text = `${hit.title} ${hit.detail} ${hit.pane.textContent}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => rank(a) - rank(b));
  // Panes without a match fade, like System Settings.
  for (const item of document.querySelectorAll<HTMLElement>('.nav-item')) {
    item.classList.toggle('no-match', !matches.some((m) => m.pane === item));
    item.classList.remove('selected');
  }
  for (const pane of document.querySelectorAll<HTMLElement>('.pane')) pane.hidden = pane !== results;
  document.getElementById('pane-title')!.textContent = 'Search';
  results.replaceChildren(
    ...(matches.length
      ? matches.slice(0, 40).map((hit, i) => {
          const row = document.createElement('button');
          row.className = `result${i === 0 ? ' first' : ''}`;
          const icon = hit.pane.querySelector('.nav-icon')!.cloneNode(true);
          const text = document.createElement('span');
          text.className = 'result-text';
          const title = Object.assign(document.createElement('strong'), { textContent: hit.title });
          const where = Object.assign(document.createElement('small'), {
            textContent: hit.target ? `${hit.pane.textContent!.trim()}${hit.detail ? ` · ${hit.detail}` : ''}` : `${hit.title} pane${hit.detail ? ` · ${hit.detail}` : ''}`,
          });
          text.append(title, where);
          row.append(icon, text);
          row.addEventListener('click', () => reveal(hit));
          return row;
        })
      : [Object.assign(document.createElement('p'), { className: 'no-results', textContent: `No settings match “${search.value.trim()}”.` })]),
  );
  results.hidden = false;
}

function closeSearch() {
  // Runs from showPane at startup too, before `results` above is set.
  const results = document.getElementById('search-results')!;
  if (results.hidden) return;
  results.hidden = true;
  for (const item of document.querySelectorAll<HTMLElement>('.nav-item')) item.classList.remove('no-match');
}

/** Goes to the setting and points it out for a moment. */
function reveal(hit: SearchHit) {
  showPane(hit.pane.dataset.pane!);
  if (!hit.target) return;
  hit.target.scrollIntoView({ block: 'center' });
  hit.target.classList.remove('found');
  void hit.target.offsetWidth;
  hit.target.classList.add('found');
}

search.addEventListener('input', runSearch);
search.addEventListener('keydown', (e) => {
  if (isEnter(e)) results.querySelector<HTMLButtonElement>('.result')?.click();
  if (e.key === 'Escape') {
    search.value = '';
    closeSearch();
    showPane(lastShown);
  }
});
// ⌘F, as in System Settings (the app menu's Find sends it here while Settings is in front).
api.onFind(() => {
  // On Tabs & Spaces, ⌘F searches the tabs instead.
  const tabSearch = document.getElementById('tm-search') as HTMLInputElement | null;
  const field = tabSearch && tabSearch.offsetParent ? tabSearch : search;
  field.focus();
  field.select();
});
const adBlock = document.getElementById('adBlock') as HTMLInputElement;
const searchEngine = document.getElementById('searchEngine') as HTMLSelectElement;
const downloadsFolder = document.getElementById('downloadsFolder')!;
const askWhereToSave = document.getElementById('askWhereToSave') as HTMLInputElement;
const makeDefault = document.getElementById('makeDefault') as HTMLButtonElement;
const defaultStatus = document.getElementById('defaultBrowserStatus')!;

type EnvironmentDraft = SettingsView['environments'][number];
type EnvironmentField = 'name' | 'targetsText';
let environments: EnvironmentDraft[] = [];
let savedEnvironments: EnvironmentDraft[] = [];
const environmentDrafts = new Map<string, Partial<EnvironmentDraft>>();
const incompleteEnvironments = new Map<string, EnvironmentDraft>();
const removingEnvironments = new Set<string>();
let environmentWrites = Promise.resolve();
const environmentList = document.getElementById('environmentList')!;

function reconcileEnvironments(saved: EnvironmentDraft[]) {
  savedEnvironments = saved;
  for (const env of saved) incompleteEnvironments.delete(env.id);
  const visible = [...saved, ...incompleteEnvironments.values()]
    .filter((env) => !removingEnvironments.has(env.id))
    .map((env) => ({ ...env, ...environmentDrafts.get(env.id) }));
  if (JSON.stringify(environments) === JSON.stringify(visible)) return;
  environments = visible;
  renderEnvironments();
}

function renderEnvironments() {
  environmentList.replaceChildren(
    ...environments.map((env) => {
      const card = document.createElement('div');
      card.className = 'card env-card';
      const name = Object.assign(document.createElement('input'), { value: env.name, placeholder: 'Project name', className: 'env-name' });
      const targets = Object.assign(document.createElement('textarea'), {
        value: env.targetsText,
        placeholder: 'local http://localhost:3000\nstaging https://staging.example.com\nprod https://example.com',
        rows: 3,
        spellcheck: false,
        className: 'env-targets',
      });
      const remove = Object.assign(document.createElement('button'), { className: 'icon-button', title: 'Remove project' });
      remove.append(icon('close'));
      wireEnvironmentField(env.id, 'name', name);
      wireEnvironmentField(env.id, 'targetsText', targets);
      remove.addEventListener('click', () => removeEnvironment(env.id));
      const header = document.createElement('div');
      header.className = 'env-header';
      header.append(name, remove);
      card.append(header, targets);
      return card;
    }),
  );
}

function wireEnvironmentField(id: string, field: EnvironmentField, input: HTMLInputElement | HTMLTextAreaElement) {
  input.addEventListener('input', () => {
    environmentDrafts.set(id, { ...environmentDrafts.get(id), [field]: input.value });
    const visible = environments.find((env) => env.id === id);
    if (visible) visible[field] = input.value;
  });
  input.addEventListener('change', () => {
    const value = input.value;
    const draft = environmentDrafts.get(id);
    if (draft) {
      delete draft[field];
      if (!Object.keys(draft).length) environmentDrafts.delete(id);
    }
    const local = environments.find((env) => env.id === id);
    queueEnvironmentWrite(async () => {
      if (removingEnvironments.has(id)) return;
      const previous = savedEnvironments.find((env) => env.id === id);
      const edited = { id, name: '', targetsText: '', ...(previous ?? local), [field]: value };
      const submitted = previous
        ? savedEnvironments.map((env) => env.id === id ? edited : env)
        : [...savedEnvironments, edited];
      const view = await api.set({ environments: submitted });
      if (!removingEnvironments.has(id) && !view.environments.some((env) => env.id === id)) {
        incompleteEnvironments.set(id, edited);
      }
      render(view);
    });
  });
}

function queueEnvironmentWrite(write: () => Promise<void>) {
  environmentWrites = environmentWrites.then(write).catch(showLoadError);
}

function removeEnvironment(id: string) {
  environmentDrafts.delete(id);
  incompleteEnvironments.delete(id);
  removingEnvironments.add(id);
  reconcileEnvironments(savedEnvironments);
  queueEnvironmentWrite(async () => {
    try {
      const remaining = savedEnvironments.filter((env) => env.id !== id);
      if (remaining.length !== savedEnvironments.length) render(await api.set({ environments: remaining }));
    } finally {
      removingEnvironments.delete(id);
      reconcileEnvironments(savedEnvironments);
    }
  });
}

document.getElementById('addEnvironment')!.addEventListener('click', () => {
  const id = crypto.randomUUID();
  incompleteEnvironments.set(id, { id, name: '', targetsText: '' });
  reconcileEnvironments(savedEnvironments);
  environmentList.querySelector<HTMLInputElement>('.env-card:last-child .env-name')?.focus();
});

// ---- appearance & tabs -------------------------------------------------------------

const archiveAfter = document.getElementById('archiveAfter') as HTMLSelectElement;
const peekPinnedLinks = document.getElementById('peekPinnedLinks') as HTMLInputElement;
const openLinksInFlechinha = document.getElementById('openLinksInFlechinha') as HTMLInputElement;
const sidebarInPageFullscreen = document.getElementById('sidebarInPageFullscreen') as HTMLInputElement;

for (const card of document.querySelectorAll<HTMLElement>('.theme-card')) {
  card.addEventListener('click', () => void setPreference({ theme: card.dataset.theme as SettingsView['theme'] }));
}
archiveAfter.addEventListener('change', () => void setPreference({ archiveAfterHours: Number(archiveAfter.value) }));
peekPinnedLinks.addEventListener('change', () => void setPreference({ peekPinnedLinks: peekPinnedLinks.checked }));
openLinksInFlechinha.addEventListener('change', () => void setPreference({ openLinksInFlechinha: openLinksInFlechinha.checked }));
sidebarInPageFullscreen.addEventListener('change', () => void setPreference({ sidebarInPageFullscreen: sidebarInPageFullscreen.checked }));

// ---- keyboard shortcuts: click a key cap, press the new keys --------------------------

const shortcutGroups = document.getElementById('shortcut-groups')!;
const shortcutNotice = document.getElementById('shortcut-notice')!;
let shortcuts: SettingsView['shortcuts'] = [];
let recordingId: string | undefined;

/** e.code names the physical key, so ⌥ combinations don't turn into "å" or "∂". */
const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  Backquote: '`', Minus: '-', Equal: '=', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Enter: 'Return', Tab: 'Tab', Space: 'Space', Backspace: 'Backspace', Delete: 'Delete',
};

function acceleratorFor(key: RecordedKey): string | undefined {
  const base = /^Key([A-Z])$/.exec(key.code)?.[1] ?? /^Digit(\d)$/.exec(key.code)?.[1] ?? /^(F\d{1,2})$/.exec(key.code)?.[1] ?? CODE_KEYS[key.code];
  if (!base) return undefined;
  const mods = [key.control && 'Ctrl', key.alt && 'Alt', key.shift && 'Shift', key.meta && 'Cmd'].filter(Boolean);
  // Plain keys belong to the page you're typing in; only function keys work alone.
  if (!mods.length && !/^F\d/.test(base)) return undefined;
  return [...mods, base].join('+');
}

function renderShortcuts() {
  const groups = [...new Set(shortcuts.map((s) => s.group))];
  shortcutGroups.replaceChildren(
    ...groups.map((title) => {
      const group = document.createElement('div');
      group.className = 'shortcut-group';
      const card = document.createElement('div');
      card.className = 'card';
      for (const item of shortcuts.filter((s) => s.group === title)) {
        const row = document.createElement('div');
        row.className = `row shortcut-row${item.changed ? ' changed' : ''}`;
        const label = Object.assign(document.createElement('span'), { className: 'shortcut-label', textContent: item.label });
        const actions = document.createElement('span');
        actions.className = 'shortcut-actions';
        if (item.changed) {
          const reset = Object.assign(document.createElement('button'), { className: 'shortcut-reset', title: 'Back to the default' });
          reset.append(icon('reload'));
          reset.addEventListener('click', () => void setPreference({ shortcut: { id: item.id, keys: 'default' } }, applyShortcuts));
          actions.append(reset);
        }
        if (item.fixed) {
          actions.append(Object.assign(document.createElement('kbd'), { textContent: item.keys }));
        } else {
          const cap = Object.assign(document.createElement('button'), { className: 'keycap' });
          const recording = recordingId === item.id;
          cap.classList.toggle('recording', recording);
          cap.classList.toggle('empty', !item.keys);
          cap.textContent = recording ? 'Press keys…' : item.keys || 'None';
          cap.title = recording ? 'Esc cancels · ⌫ removes the shortcut' : 'Click to record a new shortcut';
          cap.addEventListener('click', () => void startRecording(recording ? undefined : item.id));
          actions.append(cap);
        }
        row.append(label, actions);
        card.append(row);
      }
      group.append(Object.assign(document.createElement('h2'), { textContent: title }), card);
      return group;
    }),
  );
}

async function startRecording(id: string | undefined) {
  recordingId = id;
  await api.recordShortcut(!!id);
  renderShortcuts();
}

api.onKey(async (key) => {
  if (!recordingId) return;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(key.key)) return;
  const id = recordingId;
  if (key.code === 'Escape' && !key.shift && !key.control && !key.alt && !key.meta) return startRecording(undefined);
  const removing = (key.code === 'Backspace' || key.code === 'Delete') && !key.shift && !key.control && !key.alt && !key.meta;
  const keys = removing ? null : acceleratorFor(key);
  if (keys === undefined) return showNotice('Use a modifier with a key, or a function key.');
  await startRecording(undefined);
  await setPreference({ shortcut: { id, keys } }, applyShortcuts);
});

function applyShortcuts(view: SettingsView) {
  shortcuts = view.shortcuts;
  renderShortcuts();
  showNotice(view.notice);
}

let noticeTimer: number | undefined;
function showNotice(text: string | undefined) {
  shortcutNotice.textContent = text ?? '';
  shortcutNotice.hidden = !text;
  clearTimeout(noticeTimer);
  if (text) noticeTimer = window.setTimeout(() => (shortcutNotice.hidden = true), 5000);
}

document.getElementById('resetShortcuts')!.addEventListener('click', () => void setPreference({ resetShortcuts: true }, applyShortcuts));
// Leaving the pane or the window ends recording.
window.addEventListener('blur', () => recordingId && void startRecording(undefined));
for (const item of document.querySelectorAll<HTMLElement>('.nav-item')) item.addEventListener('click', () => recordingId && void startRecording(undefined));

const agentEnabled = document.getElementById('agentEnabled') as HTMLInputElement;
let agent: SettingsView['agent'] = { enabled: false };

function claudeCommand() {
  return `claude mcp add --transport http flecha ${agent.endpoint} --header "Authorization: Bearer ${agent.token}"`;
}

function agentJson() {
  return JSON.stringify(
    { mcpServers: { flecha: { type: 'http', url: agent.endpoint, headers: { Authorization: `Bearer ${agent.token}` } } } },
    null,
    2,
  );
}

async function copied(button: HTMLButtonElement, text: string) {
  await api.copy(text);
  const label = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => (button.textContent = label), 1200);
}

agentEnabled.addEventListener('change', () => void setPreference({ agentEnabled: agentEnabled.checked }));
document.getElementById('copyClaudeCommand')!.addEventListener('click', (e) => copied(e.currentTarget as HTMLButtonElement, claudeCommand()));
document.getElementById('copyAgentJson')!.addEventListener('click', (e) => copied(e.currentTarget as HTMLButtonElement, agentJson()));
document.getElementById('newAgentToken')!.addEventListener('click', async () => render(await api.newAgentToken()));

function render(view: SettingsView) {
  lastPreferences = view;
  adBlock.checked = view.adBlock;
  if (searchEngine.options.length !== view.searchEngines.length) {
    searchEngine.replaceChildren(...view.searchEngines.map((e) => new Option(e.name, e.id)));
  }
  searchEngine.value = view.searchEngine;
  downloadsFolder.textContent = view.downloadsFolder;
  downloadsFolder.title = view.downloadsFolder;
  askWhereToSave.checked = view.askWhereToSave;
  for (const card of document.querySelectorAll<HTMLElement>('.theme-card')) {
    card.classList.toggle('selected', card.dataset.theme === view.theme);
    card.setAttribute('aria-checked', String(card.dataset.theme === view.theme));
  }
  archiveAfter.value = String(view.archiveAfterHours);
  peekPinnedLinks.checked = view.peekPinnedLinks;
  if (!recordingId) {
    shortcuts = view.shortcuts;
    renderShortcuts();
  }
  openLinksInFlechinha.checked = view.openLinksInFlechinha;
  sidebarInPageFullscreen.checked = view.sidebarInPageFullscreen;
  renderAgent(view);
  reconcileEnvironments(view.environments);

  const { isDefault, canSet } = view.defaultBrowser;
  makeDefault.hidden = isDefault;
  makeDefault.disabled = !canSet;
  defaultStatus.textContent = isDefault
    ? 'Flecha is your default browser.'
    : canSet
      ? 'Links from other apps open in your current default browser.'
      : 'Not available in this build of Flecha.';
}

function renderAgent(view: SettingsView) {
  agent = view.agent;
  agentEnabled.checked = agent.enabled;
  for (const row of document.querySelectorAll<HTMLElement>('[data-agent-only]')) row.hidden = !agent.enabled;
  // Without the native host the bridge never starts; say why rather than "Starting…".
  const endpoint = document.getElementById('agentEndpoint')!;
  endpoint.textContent = agent.endpoint ?? (agent.enabled ? view.hostError : undefined) ?? 'Starting…';
  endpoint.classList.toggle('host-error', !agent.endpoint && !!view.hostError);
  for (const id of ['copyClaudeCommand', 'copyAgentJson']) (document.getElementById(id) as HTMLButtonElement).disabled = !agent.endpoint;
}

makeDefault.addEventListener('click', async () => render(await api.makeDefaultBrowser()));
// macOS asks for confirmation in its own dialog, so check again when the window regains focus.
window.addEventListener('focus', refresh);
// The agent bridge's address and the native host's errors come later than the change that asked for them.
// Only the agent card redraws, so a shortcut keycap with focus keeps it.
api.onChange(() => void api.get().then(renderAgent, console.error));

document.getElementById('openBoosts')!.addEventListener('click', () => api.openBoosts());
document.getElementById('showTour')!.addEventListener('click', () => api.showTour());
const importButton = document.querySelector<HTMLButtonElement>('#import-browser')!;
let importing = false;
importButton.addEventListener('click', async () => {
  if (importing) return;
  importing = true;
  importButton.setAttribute('aria-disabled', 'true');
  try {
    await importFromBrowser();
  } finally {
    importing = false;
    importButton.removeAttribute('aria-disabled');
  }
});
document.getElementById('chooseFolder')!.addEventListener('click', async () => render(await api.chooseDownloadsFolder()));
askWhereToSave.addEventListener('change', () => void setPreference({ askWhereToSave: askWhereToSave.checked }));

searchEngine.addEventListener('change', () =>
  void setPreference({ searchEngine: searchEngine.value as SettingsView['searchEngine'] }),
);
adBlock.addEventListener('change', () => void setPreference({ adBlock: adBlock.checked }));

const loadError = document.getElementById('settings-load-error')!;
const loadStatus = document.getElementById('settings-load-status')!;
const preferencePanes = document.querySelectorAll<HTMLElement>('[data-preferences]');
let lastPreferences: SettingsView | undefined;
function showLoadError() {
  if (lastPreferences) render(lastPreferences);
  for (const pane of preferencePanes) pane.inert = true;
  loadError.hidden = false;
  loadStatus.textContent = 'Preferences are unavailable. Retry or reload Settings.';
}
function setPreference(patch: Parameters<SettingsApi['set']>[0], show = render) {
  return api.set(patch).then(show, showLoadError);
}
let refreshing: Promise<void> | undefined;
function refresh() {
  refreshing ??= api.get().then((view) => {
    render(view);
    for (const pane of preferencePanes) pane.inert = false;
    loadError.hidden = true;
    loadStatus.textContent = '';
  }, showLoadError).finally(() => { refreshing = undefined; });
}

loadError.querySelector('button')!.addEventListener('click', refresh);
onReconnect(refresh);
refresh();
