import type { ArchivedTab, DetectedBrowser, LinkRule, RecordedKey, SettingsApi, SettingsView } from '../../shared/types';
import { browserDetail, importSummary } from './browserImport.js';
import { ICONS, type IconName } from './icons.js';
import { setupTabsPane } from './tabsPane.js';
import { IS_MAC } from '../lib/shortcuts';
import { spaceTint } from '../lib/spaceTint';
import { askDialog } from '../settingsUi';

/** Yes or no in Settings' own dialog: the destructive button first, Cancel the default. */
const confirmed = async (message: string, detail: string, yes: string) =>
  (await askDialog({ message, detail, buttons: [yes, 'Cancel'], defaultId: 1, cancelId: 1 })) === 0;

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

// ---- console errors: hosts whose tabs get no badge ---------------------------------------

const consoleBadgeHiddenHosts = document.getElementById('consoleBadgeHiddenHosts') as HTMLTextAreaElement;
consoleBadgeHiddenHosts.addEventListener('change', async () => {
  const view = await api.set({ consoleBadgeHiddenHosts: consoleBadgeHiddenHosts.value });
  // Show what was kept: tidied, and without anything that isn't a host.
  consoleBadgeHiddenHosts.value = view.consoleBadgeHiddenHosts;
  render(view);
});

// ---- import: the tour's import step, for any time after it -----------------------------

const browserList = document.getElementById('browserList')!;
let browsers: DetectedBrowser[] | undefined;
/** What each finished import brought over, by browser id. */
const imported = new Map<string, string>();
const importing = new Set<string>();
/** Imports that brought nothing over, with why; their row offers to try again. */
const failed = new Map<string, string>();
/** Imports that came over without their cookies, since the keychain said no; their row offers to ask again. */
const refused = new Set<string>();
/** Why the native host, which reads the other browsers, last failed (SettingsView.hostError). */
let hostError: string | undefined;

function textRow(text: string, error = false) {
  const row = document.createElement('div');
  row.className = 'row';
  row.append(Object.assign(document.createElement('div'), { className: `row-text${error ? ' host-error' : ''}`, textContent: text }));
  return row;
}

function renderBrowsers() {
  if (!browsers) return browserList.replaceChildren(textRow('Looking for your browsers…'));
  if (!browsers.length && hostError) return browserList.replaceChildren(textRow(hostError, true));
  if (!browsers.length) return browserList.replaceChildren(textRow('No other browsers with bookmarks or history were found on this Mac.'));
  browserList.replaceChildren(
    ...browsers.map((b) => {
      const done = imported.get(b.id);
      const busy = importing.has(b.id);
      const row = document.createElement('div');
      row.className = 'row';
      const text = document.createElement('div');
      text.className = 'row-text';
      const why = failed.get(b.id);
      text.append(
        Object.assign(document.createElement('strong'), { textContent: b.name }),
        Object.assign(document.createElement('small'), { className: why || refused.has(b.id) ? 'host-error' : '', textContent: done ?? why ?? browserDetail(b) }),
      );
      const info = document.createElement('div');
      info.className = 'browser-info';
      info.append(Object.assign(document.createElement('span'), { className: 'browser-badge', textContent: b.name[0] }), text);
      if (done && !refused.has(b.id)) {
        const mark = Object.assign(document.createElement('span'), { className: 'browser-done', textContent: 'Imported' });
        mark.prepend(icon('check'));
        row.append(info, mark);
      } else {
        const button = Object.assign(document.createElement('button'), { className: 'button', disabled: busy, textContent: busy ? 'Importing…' : why || refused.has(b.id) ? 'Try Again' : 'Import' });
        button.addEventListener('click', () => runImport(b));
        row.append(info, button);
      }
      return row;
    }),
  );
}

async function runImport(b: DetectedBrowser) {
  importing.add(b.id);
  renderBrowsers();
  failed.delete(b.id);
  try {
    const retrying = refused.has(b.id);
    const r = await (retrying ? api.importBrowserCookies(b.id) : api.importBrowser(b.id));
    if (!retrying && !r.spaces && !r.bookmarks && !r.history && !r.cookies && r.warnings.length) failed.set(b.id, r.warnings[0]);
    else {
      imported.set(b.id, importSummary(r));
      if (r.cookiesRefused) refused.add(b.id);
      else refused.delete(b.id);
    }
  } catch {
    failed.set(b.id, 'Couldn’t import this one');
  }
  importing.delete(b.id);
  renderBrowsers();
}

function detectBrowsers() {
  browsers = undefined;
  renderBrowsers();
  api.detectBrowsers().then(
    (found) => ((browsers = found), renderBrowsers()),
    () => ((browsers = []), renderBrowsers()),
  );
}
detectBrowsers();

// A bookmarks file exported from any browser, for the ones not found above.
const bookmarksFile = document.getElementById('bookmarksFile') as HTMLInputElement;
const chooseBookmarksFile = document.getElementById('chooseBookmarksFile') as HTMLButtonElement;
const bookmarksFileStatus = document.getElementById('bookmarksFileStatus')!;

chooseBookmarksFile.addEventListener('click', () => bookmarksFile.click());
bookmarksFile.addEventListener('change', async () => {
  const file = bookmarksFile.files?.[0];
  bookmarksFile.value = '';
  if (!file) return;
  chooseBookmarksFile.disabled = true;
  chooseBookmarksFile.textContent = 'Importing…';
  let summary: string;
  let ok = false;
  try {
    const r = await api.importBookmarksFile(await file.text(), file.name);
    ok = r.bookmarks > 0;
    summary = ok ? `${file.name}: ${importSummary(r)}` : (r.warnings[0] ?? `No bookmarks were found in ${file.name}.`);
  } catch {
    summary = `Couldn’t import ${file.name}`;
  }
  bookmarksFileStatus.textContent = summary;
  bookmarksFileStatus.classList.toggle('host-error', !ok);
  chooseBookmarksFile.disabled = false;
  chooseBookmarksFile.textContent = ok ? 'Choose Another…' : 'Choose File…';
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
const showLocalServers = document.getElementById('showLocalServers') as HTMLInputElement;
showLocalServers.addEventListener('change', async () => render(await api.set({ showLocalServers: showLocalServers.checked })));
document.getElementById('showIgnoredPorts')!.addEventListener('click', async () => render(await api.set({ ignoredLocalPorts: [] })));

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

// The sidebar wears the active Space's colour, like the browser window's.
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let tint: string | undefined;
function applyTint() {
  if (tint) document.documentElement.style.setProperty('--tint', spaceTint(tint, systemDark.matches));
}
systemDark.addEventListener('change', applyTint);

function render(view: SettingsView) {
  tint = view.tint;
  applyTint();
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
  blockThirdPartyCookies.checked = view.blockThirdPartyCookies;
  linkRules = view.linkRules;
  ruleSpaces = view.spaces;
  renderLinkRules();
  showLocalServers.checked = view.showLocalServers;
  document.getElementById('ignoredPortsRow')!.hidden = !view.ignoredLocalPorts.length;
  document.getElementById('ignoredPorts')!.textContent = view.ignoredLocalPorts.map((p) => `:${p}`).join(', ');
  agent = view.agent;
  agentEnabled.checked = agent.enabled;
  for (const row of document.querySelectorAll<HTMLElement>('[data-agent-only]')) row.hidden = !agent.enabled;
  // Without the native host the bridge never starts; say why rather than "Starting…".
  const endpoint = document.getElementById('agentEndpoint')!;
  endpoint.textContent = agent.endpoint ?? (agent.enabled ? view.hostError : undefined) ?? 'Starting…';
  endpoint.classList.toggle('host-error', !agent.endpoint && !!view.hostError);
  for (const id of ['copyClaudeCommand', 'copyAgentJson']) (document.getElementById(id) as HTMLButtonElement).disabled = !agent.endpoint;
  // Look for browsers again once the host works (Flecha was reopened, say).
  const hostWorksNow = !!hostError && !view.hostError;
  hostError = view.hostError;
  if (hostWorksNow && browsers && !browsers.length) detectBrowsers();
  else renderBrowsers();
  // Not while it's being typed in: a change elsewhere re-renders the page.
  if (document.activeElement !== consoleBadgeHiddenHosts) consoleBadgeHiddenHosts.value = view.consoleBadgeHiddenHosts;
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
// The agent bridge's address and the native host's errors come later than the change that asked for them.
api.onChange(async () => render(await api.get()));

document.getElementById('openBoosts')!.addEventListener('click', () => api.openBoosts());
document.getElementById('showTour')!.addEventListener('click', () => api.showTour());
document.getElementById('chooseFolder')!.addEventListener('click', async () => render(await api.chooseDownloadsFolder()));
askWhereToSave.addEventListener('change', async () => render(await api.set({ askWhereToSave: askWhereToSave.checked })));

searchEngine.addEventListener('change', async () =>
  render(await api.set({ searchEngine: searchEngine.value as SettingsView['searchEngine'] })),
);
adBlock.addEventListener('change', async () => render(await api.set({ adBlock: adBlock.checked })));

// ---- Privacy: third-party cookies and clearing browsing data -------------------------------

const blockThirdPartyCookies = document.getElementById('blockThirdPartyCookies') as HTMLInputElement;
blockThirdPartyCookies.addEventListener('change', async () => render(await api.set({ blockThirdPartyCookies: blockThirdPartyCookies.checked })));

const clearChecks = ['clearHistory', 'clearCookies', 'clearCache'].map((id) => document.getElementById(id) as HTMLInputElement);
const clearButton = document.getElementById('clearData') as HTMLButtonElement;
const clearStatus = document.getElementById('clearStatus')!;
const syncClearButton = () => (clearButton.disabled = !clearChecks.some((c) => c.checked));
for (const check of clearChecks) check.addEventListener('change', syncClearButton);
clearButton.addEventListener('click', async () => {
  const range = document.getElementById('clearRange') as HTMLSelectElement;
  const [history, cookies, cache] = clearChecks.map((c) => c.checked);
  const what = [history && 'history', cookies && 'cookies and site data', cache && 'cached files'].filter(Boolean).join(', ');
  if (!(await confirmed(`Clear ${what}?`, `From ${range.selectedOptions[0].textContent!.toLowerCase()}, in every Space. This can’t be undone.`, 'Clear'))) return;
  clearButton.disabled = true;
  clearStatus.textContent = 'Clearing…';
  try {
    await api.clearBrowsingData({ sinceHours: Number(range.value), history, cookies, cache });
    clearStatus.textContent = 'Cleared.';
  } catch {
    clearStatus.textContent = 'Couldn’t clear everything. Try again.';
  }
  syncClearButton();
});

// ---- Air Traffic Control ---------------------------------------------------------------

let linkRules: LinkRule[] = [];
let ruleSpaces: SettingsView['spaces'] = [];
const spaceName = (id: string) => {
  const space = ruleSpaces.find((s) => s.id === id);
  return space ? `${space.emoji ? `${space.emoji} ` : ''}${space.name}` : '';
};

function renderLinkRules() {
  const select = document.getElementById('linkRuleSpace') as HTMLSelectElement;
  const chosen = select.value;
  select.replaceChildren(...ruleSpaces.map((s) => new Option(spaceName(s.id), s.id)));
  if (ruleSpaces.some((s) => s.id === chosen)) select.value = chosen;
  document.getElementById('linkRules')!.replaceChildren(
    ...linkRules.map((rule) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      const match = Object.assign(document.createElement('span'), { className: 'grow mono', textContent: rule.match });
      const arrow = Object.assign(document.createElement('small'), { textContent: `→ ${spaceName(rule.spaceId)}` });
      const remove = Object.assign(document.createElement('button'), { className: 'icon-only', type: 'button', title: 'Remove rule' });
      remove.append(icon('close'));
      remove.onclick = async () => render(await api.set({ linkRules: linkRules.filter((r) => r.id !== rule.id) }));
      row.append(match, arrow, remove);
      return row;
    }),
  );
}

document.getElementById('linkRuleForm')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('linkRuleMatch') as HTMLInputElement;
  const spaceId = (document.getElementById('linkRuleSpace') as HTMLSelectElement).value;
  const match = input.value.trim();
  if (!match || !spaceId) return input.focus();
  render(await api.set({ linkRules: [...linkRules, { id: crypto.randomUUID(), match, spaceId }] }));
  input.value = '';
});

// ---- Tabs & Spaces: export and import ------------------------------------------------------

document.getElementById('tm-export')!.addEventListener('click', () => api.exportSpaces());
const importFile = document.getElementById('tm-import-file') as HTMLInputElement;
document.getElementById('tm-import')!.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  importFile.value = '';
  if (!file) return;
  if (!(await confirmed(`Replace your Spaces with those in “${file.name}”?`, 'Your Spaces, pinned tabs and favorites become those in the file. Export first to keep a copy of what you have now.', 'Replace'))) return;
  await api.importSpaces(await file.text());
});

// ---- Archive ---------------------------------------------------------------------------

let archive: ArchivedTab[] = [];
const archiveSearch = document.getElementById('archiveSearch') as HTMLInputElement;

function archiveIcon(url: string) {
  const img = document.createElement('img');
  img.className = 'favicon';
  img.alt = '';
  // The browser's own icon cache (the favicon permission), where there is one.
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    img.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
  }
  return img;
}

const dayLabel = (time: number) => {
  const day = new Date(time).toDateString();
  if (day === new Date().toDateString()) return 'Today';
  if (day === new Date(Date.now() - 86_400_000).toDateString()) return 'Yesterday';
  return new Date(time).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};

function renderArchive() {
  const q = archiveSearch.value.trim().toLowerCase();
  const items = archive.filter((a) => !q || a.title.toLowerCase().includes(q) || a.url.toLowerCase().includes(q));
  const list = document.getElementById('archiveList')!;
  (document.getElementById('clearArchive') as HTMLButtonElement).disabled = !archive.length;
  if (!items.length) {
    list.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: archive.length ? 'Nothing matches.' : 'The archive is empty.' }));
    return;
  }
  const rows: HTMLElement[] = [];
  let day = '';
  for (const item of items.slice(0, 500)) {
    const label = dayLabel(item.closedAt);
    if (label !== day) rows.push(Object.assign(document.createElement('div'), { className: 'day', textContent: (day = label) }));
    const row = document.createElement('div');
    row.className = 'list-row';
    row.title = item.url;
    let site = item.url;
    try {
      site = new URL(item.url).hostname.replace(/^www\./, '');
    } catch {
      // Not a web address; show it whole.
    }
    const title = Object.assign(document.createElement('span'), { className: 'grow', textContent: item.title || item.url });
    const sub = Object.assign(document.createElement('small'), {
      textContent: `${site} · ${new Date(item.closedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`,
    });
    const remove = Object.assign(document.createElement('button'), { className: 'icon-only', type: 'button', title: 'Remove from the archive' });
    remove.append(icon('close'));
    remove.onclick = async (e) => {
      e.stopPropagation();
      archive = await api.editArchive({ op: 'remove', closedAt: item.closedAt, url: item.url });
      renderArchive();
    };
    row.onclick = async () => {
      archive = await api.editArchive({ op: 'reopen', closedAt: item.closedAt, url: item.url });
      renderArchive();
    };
    row.append(archiveIcon(item.url), title, sub, remove);
    rows.push(row);
  }
  list.replaceChildren(...rows);
}

archiveSearch.addEventListener('input', renderArchive);
document.getElementById('clearArchive')!.addEventListener('click', async () => {
  if (!(await confirmed(archive.length === 1 ? 'Forget the archived tab?' : `Forget all ${archive.length} archived tabs?`, 'They won’t come up in the command bar any more. This can’t be undone.', 'Clear Archive'))) return;
  archive = await api.editArchive({ op: 'clear' });
  renderArchive();
});
api.onArchive((items) => {
  archive = items;
  renderArchive();
});
api.archive().then((items) => {
  archive = items;
  renderArchive();
});

api.get().then(render);
