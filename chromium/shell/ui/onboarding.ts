import type { IconName } from './icons.js';
import type { FlechaApi, UiState } from '../../shared/types';
import { browserDetail, importSummary } from './browserImport.js';

/**
 * The first-run tour, full window: steps on the left, a live miniature Flecha on the right
 * that reacts to what you choose and to the real shortcuts you press. Your first Space is
 * set up for real as you go. It comes back from Help → Welcome to Flecha.
 */

type H = (tag: string, props?: Record<string, unknown>, ...children: Array<Node | string | null | undefined>) => HTMLElement;
type DetectedBrowser = Awaited<ReturnType<FlechaApi['detectBrowsers']>>[number];

const STEPS = ['welcome', 'space', 'import', 'try', 'dev', 'done'] as const;
type Step = (typeof STEPS)[number];

const EMOJIS = ['🏠', '💼', '🚀', '🧪', '🛠️', '🎨', '📚', '🧠', '🎮', '🌱', '☕️', '⚡️'];
const COLORS = ['#cdd9f7', '#c9e3f5', '#cfe8ec', '#d3ecd5', '#f5e7c4', '#f7dcc0', '#f4cfdc', '#e8d6f3'];

/** Shortcuts to try in the tour, in order. */
const CHALLENGES: Array<{ id: string; label: string; done: string }> = [
  { id: 'newTab', label: 'Open the command bar', done: 'Tabs, history, actions: one box.' },
  { id: 'toggleSidebar', label: 'Hide the sidebar', done: 'Hover the left edge to bring it back.' },
  { id: 'splitNew', label: 'Split the view', done: 'Or drag any tab onto the page.' },
];

/** Where Flecha looks for each browser's app icon, by the name the importer reports. */
const APP_NAMES: Record<string, string> = {
  Chrome: 'Google Chrome',
  'Google Chrome': 'Google Chrome',
  Brave: 'Brave Browser',
  Edge: 'Microsoft Edge',
  'Microsoft Edge': 'Microsoft Edge',
  Firefox: 'Firefox',
  Safari: 'Safari',
  Arc: 'Arc',
  Vivaldi: 'Vivaldi',
  Opera: 'Opera',
  Chromium: 'Chromium',
};

const MARK = `<svg viewBox="0 0 100 100"><rect width="100" height="100" rx="30" fill="#0b2545"/><path d="M50 10 80 76 50 61 20 76Z" fill="#eef2f6" transform="translate(50 50) scale(0.62) rotate(45) translate(-50 -50)"/></svg>`;

export function setupOnboarding(api: FlechaApi, h: H, icon: (name: IconName) => SVGElement) {
  const root = document.getElementById('onboarding')!;
  let step: Step = 'welcome';
  let state: UiState | undefined;
  let browsers: DetectedBrowser[] | undefined;
  const appIcons = new Map<string, string | undefined>();
  const imported = new Map<string, string>();
  const importing = new Set<string>();
  const tried = new Set<string>();
  let drawn = '';
  /** The step the last draw showed; its entrance animation only plays when the step changes. */
  let shownStep: Step | undefined;

  // ---- the live miniature -----------------------------------------------------------

  const mockTabs = h(
    'div',
    { class: 'mock-tabs' },
    ...[
      ['#e4572e', 62],
      ['#3aa6d9', 78],
      ['#1f9d5b', 54],
      ['#6d5bd0', 70],
    ].map(([color, width], i) =>
      h('div', { class: `mock-row${i === 0 ? ' active' : ''}` }, h('i', { style: `background:${color}` }), h('b', { style: `width:${width}%` })),
    ),
  );
  const mockServers = h('div', { class: 'mock-servers' });
  const typed = h('span', { class: 'mock-typed' });
  const mock = h(
    'div',
    { class: 'mock' },
    h(
      'div',
      { class: 'mock-side' },
      h('div', { class: 'mock-lights' }, h('i'), h('i'), h('i')),
      h('div', { class: 'mock-url' }, h('b')),
      mockServers,
      h('div', { class: 'mock-space' }, h('span', { class: 'mock-emoji' }), h('span', { class: 'mock-name' })),
      mockTabs,
    ),
    h(
      'div',
      { class: 'mock-pages' },
      ...['a', 'b'].map((side) =>
        h('div', { class: `mock-page ${side}` }, h('div', { class: 'mock-hero' }), h('b', { style: 'width:72%' }), h('b', { style: 'width:88%' }), h('b', { style: 'width:64%' }), h('div', { class: 'mock-cards' }, h('i'), h('i'), h('i'))),
      ),
    ),
    h(
      'div',
      { class: 'mock-palette' },
      h('div', { class: 'mock-input' }, icon('search'), typed, h('i', { class: 'mock-caret' })),
      h('div', { class: 'mock-results' }, h('b', { class: 'on' }), h('b'), h('b')),
    ),
  );

  const left = h('section', { class: 'tour-left' });
  const progress = h('i');
  const progressBar = h('div', { class: 'tour-progress' }, progress);

  let typingTimer: number | undefined;
  /** Plays what a shortcut does in the miniature. */
  function play(command: string) {
    if (command === 'newTab' || command === 'openLocation') {
      mock.classList.add('palette');
      const text = 'flecha.oprimo.dev';
      let i = 0;
      typed.textContent = '';
      clearInterval(typingTimer);
      typingTimer = window.setInterval(() => {
        typed.textContent = text.slice(0, ++i);
        if (i >= text.length) {
          clearInterval(typingTimer);
          setTimeout(() => mock.classList.remove('palette'), 900);
        }
      }, 55);
    } else if (command === 'toggleSidebar') {
      mock.classList.toggle('no-sidebar');
    } else if (command === 'splitNew') {
      mock.classList.add('split');
    }
  }

  function updateMock() {
    if (!state) return;
    const space = state.spaces.find((s) => s.id === state!.activeSpaceId);
    mock.style.setProperty('--mock-tint', state.tint);
    mock.querySelector('.mock-emoji')!.textContent = space?.emoji ?? '';
    mock.querySelector('.mock-name')!.textContent = space?.name ?? '';
    mockServers.replaceChildren(
      ...(step === 'dev' ? state.localServers.slice(0, 3) : []).map((s) =>
        h('div', { class: 'mock-server' }, h('i'), h('span', {}, s.name), h('small', {}, `:${s.port}`)),
      ),
    );
    mock.dataset.step = step;
  }

  // ---- steps ---------------------------------------------------------------------

  const go = (next: Step) => {
    step = next;
    mock.classList.remove('palette', 'no-sidebar', 'split');
    if (next === 'try') for (const id of tried) play(id);
    draw();
  };
  const next = () => go(STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)]);
  const back = () => go(STEPS[Math.max(STEPS.indexOf(step) - 1, 0)]);
  const finish = () => {
    root.classList.add('leaving');
    setTimeout(() => {
      root.classList.remove('leaving');
      api.finishOnboarding();
    }, 380);
  };

  const keys = (id: string) => state?.shortcuts[id] || '';
  const space = () => state?.spaces.find((s) => s.id === state!.activeSpaceId);

  function heading(kicker: string, title: string, lead: string) {
    return h('header', { class: 'tour-head' }, h('span', { class: 'tour-kicker' }, kicker), h('h2', {}, title), h('p', { class: 'tour-lead' }, lead));
  }

  function welcome() {
    return h(
      'div',
      { class: 'tour-step tour-welcome' },
      h('h1', {}, 'Your browser,', h('br'), h('em', {}, 'sharpened.')),
      h(
        'p',
        { class: 'tour-lead' },
        'Flecha keeps tabs tidy in Spaces, puts everything behind one command bar, and comes with real tools for the web you build. Two minutes and it’s yours.',
      ),
    );
  }

  function spaceStep() {
    const sp = space();
    if (!sp) return h('div');
    const name = h('input', { class: 'tour-input', value: sp.name, maxlength: '40', spellcheck: 'false', placeholder: 'Personal, Work, Side project…' }) as HTMLInputElement;
    name.addEventListener('input', () => name.value.trim() && api.updateSpace(sp.id, { name: name.value }));
    name.addEventListener('keydown', (e) => e.key === 'Enter' && next());
    const theme = state?.theme ?? 'system';
    return h(
      'div',
      { class: 'tour-step' },
      heading('Your first Space', 'Give it a name and a colour', 'Spaces keep work, personal and side projects apart, each with its own tabs and colour. Make more anytime.'),
      name,
      h(
        'div',
        { class: 'tour-emojis' },
        ...EMOJIS.map((emoji) => h('button', { class: `tour-emoji${sp.emoji === emoji ? ' on' : ''}`, onclick: () => api.updateSpace(sp.id, { emoji }) }, emoji)),
      ),
      h(
        'div',
        { class: 'tour-swatches' },
        ...COLORS.map((color) => h('button', { class: `tour-swatch${sp.color === color ? ' on' : ''}`, style: `--swatch:${color}`, onclick: () => api.updateSpace(sp.id, { color }) })),
      ),
      h(
        'div',
        { class: 'tour-segmented' },
        ...(['system', 'light', 'dark'] as const).map((t) =>
          h('button', { class: theme === t ? 'on' : '', onclick: () => api.setPreferences({ theme: t }) }, t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'),
        ),
      ),
    );
  }

  function browserIcon(b: DetectedBrowser) {
    const appName = APP_NAMES[b.name] ?? b.name;
    if (!appIcons.has(appName)) {
      appIcons.set(appName, undefined);
      api.appIcon(appName).then((url) => {
        appIcons.set(appName, url);
        if (step === 'import') draw();
      });
    }
    const url = appIcons.get(appName);
    return url ? h('img', { class: 'tour-app-icon', src: url, alt: '' }) : h('span', { class: 'tour-app-icon letter' }, b.name[0]);
  }

  async function runImport(b: DetectedBrowser) {
    importing.add(b.id);
    draw();
    try {
      imported.set(b.id, importSummary(await api.importBrowser(b.id)));
    } catch {
      imported.set(b.id, 'Couldn’t import this one');
    }
    importing.delete(b.id);
    draw();
  }

  function importStep() {
    if (!browsers) {
      api.detectBrowsers().then(
        (found) => ((browsers = found), step === 'import' && draw()),
        () => ((browsers = []), step === 'import' && draw()),
      );
    }
    const list = !browsers
      ? h('div', { class: 'tour-note' }, h('span', { class: 'tour-spinner' }), 'Looking for your browsers…')
      : !browsers.length
        ? h('div', { class: 'tour-note' }, 'No other browsers with data on this Mac. You can import later from Settings › Import.')
        : h(
            'div',
            { class: 'tour-browsers' },
            ...browsers.map((b) => {
              const done = imported.get(b.id);
              const busy = importing.has(b.id);
              return h(
                'div',
                { class: `tour-browser${done ? ' done' : ''}${busy ? ' busy' : ''}` },
                browserIcon(b),
                h('span', { class: 'tour-browser-text' }, h('strong', {}, b.name), h('small', {}, done ?? browserDetail(b))),
                done
                  ? h('span', { class: 'tour-done' }, icon('check'))
                  : h('button', { class: 'tour-ghost', disabled: busy, onclick: () => runImport(b) }, busy ? 'Importing…' : 'Import'),
              );
            }),
          );
    return h(
      'div',
      { class: 'tour-step' },
      heading('Move in', 'Bring your stuff over', 'Bookmarks become pinned tabs in a Space of their own; history makes the command bar smart from day one. Passwords stay put.'),
      list,
    );
  }

  function tryStep() {
    const current = CHALLENGES.find((c) => !tried.has(c.id));
    return h(
      'div',
      { class: 'tour-step' },
      heading('Muscle memory', 'Try it for real', 'Press the keys. The preview on the right does what Flecha does. (You can change every shortcut in Settings.)'),
      h(
        'div',
        { class: 'tour-challenges' },
        ...CHALLENGES.map((c) => {
          const done = tried.has(c.id);
          return h(
            'button',
            { class: `tour-challenge${done ? ' done' : ''}${c === current ? ' current' : ''}`, onclick: () => tourKey(c.id) },
            h('kbd', { class: 'tour-key' }, keys(c.id) || '—'),
            h('span', { class: 'tour-challenge-text' }, h('strong', {}, c.label), h('small', {}, done ? c.done : c === current ? 'Press the keys now' : '')),
            done ? h('span', { class: 'tour-done' }, icon('check')) : null,
          );
        }),
      ),
    );
  }

  function devStep() {
    const servers = state?.localServers ?? [];
    return h(
      'div',
      { class: 'tour-step' },
      heading('For developers', 'Built for the web you build', servers.length ? `Flecha already found ${servers.length} dev server${servers.length === 1 ? '' : 's'} running on this Mac. They live at the top of the sidebar.` : 'Start a dev server and it shows up at the top of the sidebar, with its console errors.'),
      h(
        'div',
        { class: 'tour-features' },
        feature('sparkle', 'Coding agents', 'Claude Code and Cursor can read, click and debug your tabs over MCP.', h('button', { class: 'tour-ghost', onclick: () => api.openSettings('agents') }, 'Connect')),
        feature('zap', 'Boosts', 'Your own TypeScript and CSS for any site, edited right in Flecha.', h('kbd', {}, keys('editBoost'))),
        feature('phone', 'Responsive view', 'Desktop and phone side by side, following each other.', h('kbd', {}, keys('responsive'))),
        feature('code', 'Environments', 'Local → staging → prod for the same page, with a badge so prod never looks safe.', h('kbd', {}, keys('nextEnvironment'))),
      ),
    );
  }

  function feature(name: IconName, title: string, text: string, action: HTMLElement) {
    return h('div', { class: 'tour-feature' }, h('span', { class: 'tour-feature-icon' }, icon(name)), h('span', { class: 'tour-feature-text' }, h('strong', {}, title), h('small', {}, text)), action);
  }

  function doneStep() {
    const d = state?.defaultBrowser;
    return h(
      'div',
      { class: 'tour-step' },
      heading('Last thing', d?.isDefault ? 'You’re all set' : 'Make it the default?', d?.isDefault ? 'Links from Slack, Mail and your terminal open in Flecha.' : 'So links from Slack, Mail and your terminal open here instead of somewhere else.'),
      d?.isDefault
        ? h('div', { class: 'tour-note ok' }, h('span', { class: 'tour-done' }, icon('check')), 'Flecha is your default browser')
        : d?.canSet
          ? h('button', { class: 'tour-ghost big', onclick: () => api.makeDefaultBrowser() }, icon('link'), 'Make Flecha the default browser')
          : null,
      h('div', { class: 'tour-tips' }, h('span', {}, h('kbd', {}, keys('newTab')), ' Command bar'), h('span', {}, h('kbd', {}, keys('shortcuts')), ' All shortcuts'), h('span', {}, h('kbd', {}, keys('settings')), ' Settings')),
    );
  }

  function primaryLabel() {
    if (step === 'welcome') return 'Let’s go';
    if (step === 'import') return imported.size ? 'Continue' : 'Skip';
    if (step === 'try') return tried.size === CHALLENGES.length ? 'Nice. Continue' : 'Skip';
    if (step === 'done') return 'Start browsing';
    return 'Continue';
  }

  function draw() {
    const body = { welcome, space: spaceStep, import: importStep, try: tryStep, dev: devStep, done: doneStep }[step]();
    body.classList.toggle('enter', shownStep !== step);
    shownStep = step;
    const index = STEPS.indexOf(step);
    const focused = document.activeElement as HTMLElement | null;
    const keepCaret = focused?.classList.contains('tour-input') ? (focused as HTMLInputElement).selectionStart : null;
    const brand = h('div', { class: 'tour-brand' }, h('span', { class: 'tour-mark' }), h('span', {}, 'Flecha'));
    brand.firstElementChild!.innerHTML = MARK;
    // The frame (grid, miniature, progress bar) is built once so its animations run on;
    // only the step's own content is redrawn.
    if (!root.firstChild) root.append(h('div', { class: 'tour-grid' }), h('div', { class: 'tour' }, left, h('section', { class: 'tour-stage' }, mock)));
    progress.style.width = `${((index + 1) / STEPS.length) * 100}%`;
    left.replaceChildren(
      h('div', { class: 'tour-top' }, brand, step === 'done' ? null : h('button', { class: 'tour-skip', onclick: finish }, 'Skip tour')),
      body,
      h(
        'footer',
        { class: 'tour-footer' },
        progressBar,
        h(
          'div',
          { class: 'tour-buttons' },
          index ? h('button', { class: 'tour-back', onclick: back }, 'Back') : h('span'),
          h('button', { class: 'tour-primary', onclick: step === 'done' ? finish : next }, primaryLabel(), h('kbd', {}, '↩')),
        ),
      ),
    );
    updateMock();
    // Redrawing replaces the name field; keep typing where you were.
    if (keepCaret !== null) {
      const input = root.querySelector<HTMLInputElement>('.tour-input');
      input?.focus();
      input?.setSelectionRange(keepCaret, keepCaret);
    }
  }

  function tourKey(command: string) {
    if (root.hidden) return;
    play(command);
    const challenge = CHALLENGES.find((c) => c.id === command);
    if (step === 'try' && challenge) {
      tried.add(command);
      draw();
    }
  }

  api.onTourKey(tourKey);
  document.addEventListener('keydown', (e) => {
    if (root.hidden || e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    root.querySelector<HTMLButtonElement>('.tour-primary')?.click();
  });

  return function render(s: UiState) {
    state = s;
    const show = !s.onboarded;
    if (show && root.hidden) {
      step = 'welcome';
      tried.clear();
    }
    root.hidden = !show;
    if (!show) return;
    // Only what the steps show; other updates (pages loading) would restart the animations.
    const sp = s.spaces.find((x) => x.id === s.activeSpaceId);
    // The name isn't in it: the field already shows what you type, and the miniature follows below.
    const key = JSON.stringify([s.theme, sp?.emoji, sp?.color, s.defaultBrowser, s.shortcuts, s.localServers.length]);
    if (key !== drawn || !root.firstChild) draw();
    else updateMock();
    drawn = key;
  };
}
