import type { RecordedKey, SettingsApi, SettingsView } from '../../shared/types';
import { ICONS, type IconName } from './icons.js';
import { setupTabsPane } from './tabsPane.js';
import { IS_MAC } from '../lib/shortcuts';

declare global {
  interface Window {
    settings: SettingsApi;
  }
}

const api = window.settings;

function icon(name: IconName) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.innerHTML = `<path d="${ICONS[name]}"/>`;
  return el;
}

setupTabsPane(icon);

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
  if (e.key === 'Enter') results.querySelector<HTMLButtonElement>('.result')?.click();
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
let environments: EnvironmentDraft[] = [];
const environmentList = document.getElementById('environmentList')!;

function renderEnvironments() {
  environmentList.replaceChildren(
    ...environments.map((env, i) => {
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
      name.addEventListener('change', () => saveEnvironments({ ...env, name: name.value }, i));
      targets.addEventListener('change', () => saveEnvironments({ ...env, targetsText: targets.value }, i));
      remove.addEventListener('click', () => {
        environments.splice(i, 1);
        void persistEnvironments();
      });
      const header = document.createElement('div');
      header.className = 'env-header';
      header.append(name, remove);
      card.append(header, targets);
      return card;
    }),
  );
}

function saveEnvironments(updated: EnvironmentDraft, index: number) {
  environments[index] = updated;
  void persistEnvironments();
}

async function persistEnvironments() {
  // Drafts without a valid URL yet stay on screen; the main process only keeps complete ones.
  const drafts = environments;
  const view = await api.set({ environments: drafts });
  environments = drafts.map((d) => view.environments.find((e) => e.id === d.id) ?? d);
  renderEnvironments();
}

document.getElementById('addEnvironment')!.addEventListener('click', () => {
  environments.push({ id: crypto.randomUUID(), name: '', targetsText: '' });
  renderEnvironments();
  environmentList.querySelector<HTMLInputElement>('.env-card:last-child .env-name')?.focus();
});

// ---- appearance & tabs -------------------------------------------------------------

const archiveAfter = document.getElementById('archiveAfter') as HTMLSelectElement;
const peekPinnedLinks = document.getElementById('peekPinnedLinks') as HTMLInputElement;
const openLinksInFlechinha = document.getElementById('openLinksInFlechinha') as HTMLInputElement;

for (const card of document.querySelectorAll<HTMLElement>('.theme-card')) {
  card.addEventListener('click', async () => render(await api.set({ theme: card.dataset.theme as SettingsView['theme'] })));
}
archiveAfter.addEventListener('change', async () => render(await api.set({ archiveAfterHours: Number(archiveAfter.value) })));
peekPinnedLinks.addEventListener('change', async () => render(await api.set({ peekPinnedLinks: peekPinnedLinks.checked })));
openLinksInFlechinha.addEventListener('change', async () => render(await api.set({ openLinksInFlechinha: openLinksInFlechinha.checked })));

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
          reset.addEventListener('click', async () => applyShortcuts(await api.set({ shortcut: { id: item.id, keys: 'default' } })));
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
  if (keys === undefined) return showNotice(`Use at least one of ${IS_MAC ? '⌘ ⌃ ⌥' : 'Ctrl, Alt or Super'} with a key, or a function key.`);
  await startRecording(undefined);
  applyShortcuts(await api.set({ shortcut: { id, keys } }));
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

document.getElementById('resetShortcuts')!.addEventListener('click', async () => applyShortcuts(await api.set({ resetShortcuts: true })));
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

agentEnabled.addEventListener('change', async () => render(await api.set({ agentEnabled: agentEnabled.checked })));
document.getElementById('copyClaudeCommand')!.addEventListener('click', (e) => copied(e.currentTarget as HTMLButtonElement, claudeCommand()));
document.getElementById('copyAgentJson')!.addEventListener('click', (e) => copied(e.currentTarget as HTMLButtonElement, agentJson()));
document.getElementById('newAgentToken')!.addEventListener('click', async () => render(await api.newAgentToken()));

function render(view: SettingsView) {
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
  agent = view.agent;
  agentEnabled.checked = agent.enabled;
  for (const row of document.querySelectorAll<HTMLElement>('[data-agent-only]')) row.hidden = !agent.enabled;
  document.getElementById('agentEndpoint')!.textContent = agent.endpoint ?? 'Starting…';
  if (!environments.length) {
    environments = view.environments;
    renderEnvironments();
  }

  const { isDefault, canSet } = view.defaultBrowser;
  makeDefault.hidden = isDefault;
  makeDefault.disabled = !canSet;
  defaultStatus.textContent = isDefault
    ? 'Flecha is your default browser.'
    : canSet
      ? 'Links from other apps open in your current default browser.'
      : 'Not available in this build of Flecha.';
}

makeDefault.addEventListener('click', async () => render(await api.makeDefaultBrowser()));
// macOS asks for confirmation in its own dialog, so check again when the window regains focus.
window.addEventListener('focus', async () => render(await api.get()));

document.getElementById('openBoosts')!.addEventListener('click', () => api.openBoosts());
document.getElementById('showTour')!.addEventListener('click', () => api.showTour());
document.getElementById('chooseFolder')!.addEventListener('click', async () => render(await api.chooseDownloadsFolder()));
askWhereToSave.addEventListener('change', async () => render(await api.set({ askWhereToSave: askWhereToSave.checked })));

searchEngine.addEventListener('change', async () =>
  render(await api.set({ searchEngine: searchEngine.value as SettingsView['searchEngine'] })),
);
adBlock.addEventListener('change', async () => render(await api.set({ adBlock: adBlock.checked })));

api.get().then(render);
