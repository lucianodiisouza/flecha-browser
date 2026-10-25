/**
 * Boosts in the Chromium shell: per-site TypeScript and CSS, as in Electron,
 * named the same way (`github.com.ts`, `github.com.css`, `all.css`; see lib/boostFiles.ts).
 *
 * An extension can't read ~/.flecha/boosts, so boosts live in chrome.storage.local and are
 * edited on Flecha's Boosts page (boosts.html) rather than in your editor.
 *
 * Applying them, like Electron:
 *  - styles go in as user styles when a page commits (chrome.scripting.insertCSS), and are
 *    swapped in place when you save, without a reload;
 *  - scripts run in the page's own world once its DOM is ready, and open pages of the site
 *    reload when you save. With chrome.userScripts allowed they are registered with Chromium
 *    and run even on pages whose CSP forbids eval; without it they are evaluated on each
 *    load, through the DevTools protocol where the page's CSP forbids eval.
 */
import { boostHostFor, boostMatches, boostName, parseBoostName, type BoostKind } from '../lib/boostFiles';
import { displayKeys } from '../lib/shortcuts';
import { hold, release, send } from './debuggee';

const STORE_KEY = 'boosts';
/** Compiled scripts, by boost name: compiling happens on save, not on every page load. */
const COMPILED_KEY = 'boostsCompiled';
export const BOOSTS_PAGE = 'boosts.html';

export interface BoostFile {
  name: string;
  host: string;
  kind: BoostKind;
  code: string;
  /** For scripts: why the last save didn't compile, if it didn't. */
  error?: string;
}

/** A script boost as it runs: the compiled code, or why it didn't compile. */
export interface CompiledBoost {
  code?: string;
  error?: string;
}

const TEMPLATES: Record<BoostKind, (host: string) => string> = {
  script: (host) => `// Boost for ${host}: runs on every page of this site once it has loaded.
// It's TypeScript; Flecha strips the types when you save (${displayKeys('CmdOrCtrl+S')}), and open ${host} tabs reload.

export {};

// document.querySelector('header')?.remove();
`,
  styles: (host) => `/* Boost for ${host}: these styles apply to every page of this site, live as you save (${displayKeys('CmdOrCtrl+S')}). */

/* body { font-family: ui-sans-serif, system-ui; } */
`,
};

let files: Record<string, string> = {};
let compiled: Record<string, CompiledBoost> = {};
const loaded = (async () => {
  const saved = await chrome.storage.local.get([STORE_KEY, COMPILED_KEY]);
  files = (saved[STORE_KEY] as typeof files | undefined) ?? {};
  compiled = (saved[COMPILED_KEY] as typeof compiled | undefined) ?? {};
})();

const persist = () => chrome.storage.local.set({ [STORE_KEY]: files, [COMPILED_KEY]: compiled });

const userScripts = () => {
  try {
    // Undefined until "Allow User Scripts" is on for the shell; getScripts throws then on some versions.
    return chrome.userScripts && typeof chrome.userScripts.getScripts === 'function' ? chrome.userScripts : undefined;
  } catch {
    return undefined;
  }
};

function matchPatterns(host: string) {
  return host === 'all' ? ['http://*/*', 'https://*/*'] : [`*://${host}/*`, `*://*.${host}/*`];
}

/** Keeps Chromium's registered user scripts in step with the stored boosts. */
async function registerUserScripts(): Promise<boolean> {
  const api = userScripts();
  if (!api) return false;
  try {
    await api.unregister();
    const scripts = Object.keys(files)
      .map((name) => ({ name, parsed: parseBoostName(name), code: compiled[name]?.code }))
      .filter((s) => s.parsed?.kind === 'script' && s.code)
      .map(({ name, parsed, code }) => ({
        id: name,
        matches: matchPatterns(parsed!.host),
        js: [{ code: code! }],
        world: 'MAIN' as chrome.userScripts.ExecutionWorld,
        runAt: 'document_end' as chrome.extensionTypes.RunAt,
      }));
    if (scripts.length) await api.register(scripts);
    return true;
  } catch (err) {
    console.warn('Flecha boosts: user scripts unavailable, evaluating on load instead', err);
    return false;
  }
}

let registered: Promise<boolean> = loaded.then(registerUserScripts);

const matching = (url: string, kind: BoostKind) =>
  Object.keys(files).filter((name) => {
    const parsed = parseBoostName(name);
    return parsed?.kind === kind && boostMatches(url, parsed.host);
  });

// ---- styles -----------------------------------------------------------------

/** What each tab was given, since removeCSS needs the very same text. */
const inserted = new Map<number, string[]>();

async function applyStyles(tabId: number, url: string) {
  for (const css of inserted.get(tabId) ?? []) {
    await chrome.scripting.removeCSS({ target: { tabId }, css, origin: 'USER' }).catch(() => undefined);
  }
  const sheets = matching(url, 'styles').map((name) => files[name]);
  inserted.set(tabId, sheets);
  for (const css of sheets) await chrome.scripting.insertCSS({ target: { tabId }, css, origin: 'USER' }).catch(() => undefined);
}

// ---- scripts ----------------------------------------------------------------

/** Runs a compiled boost in the page's world; CSP that forbids eval falls back to the DevTools protocol. */
async function runScript(tabId: number, documentId: string | undefined, name: string, code: string, attempt = 0): Promise<void> {
  const target: chrome.scripting.InjectionTarget = documentId ? { tabId, documentIds: [documentId] } : { tabId };
  let outcome: unknown;
  try {
    [{ result: outcome }] = await chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      args: [code, name],
      func: (source: string, file: string) => {
        try {
          (0, eval)(source);
          return 'ran';
        } catch (err) {
          if (err instanceof EvalError) return 'csp';
          console.error(`[Flecha boost ${file}]`, err);
          return 'failed';
        }
      },
    });
  } catch (err) {
    // A page that only just loaded can still be settling in; try once more.
    if (attempt === 0) return void setTimeout(() => void runScript(tabId, documentId, name, code, 1), 150);
    return console.warn(`Flecha boosts: couldn't run ${name}`, err);
  }
  if (outcome !== 'csp') return;
  if (!(await hold(tabId, 'boosts'))) return reportError(tabId, name, 'this page doesn’t allow boost scripts');
  try {
    const out = await send<{ exceptionDetails?: { exception?: { description?: string }; text?: string } }>(tabId, 'Runtime.evaluate', {
      expression: code,
      userGesture: false,
    });
    if (out?.exceptionDetails) reportError(tabId, name, out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? 'failed');
  } finally {
    await release(tabId, 'boosts');
  }
}

/** Boost errors go to the page's own console, where the developer is already looking. */
function reportError(tabId: number, name: string, message: string) {
  void chrome.scripting
    .executeScript({ target: { tabId }, world: 'MAIN', args: [`[Flecha boost ${name}] ${message}`], func: (m: string) => console.error(m) })
    .catch(() => undefined);
}

async function runScripts(tabId: number, url: string, documentId?: string) {
  if (await registered) return; // Chromium runs them itself.
  for (const name of matching(url, 'script')) {
    const code = compiled[name]?.code;
    if (code) await runScript(tabId, documentId, name, code);
    else if (compiled[name]?.error) reportError(tabId, name, compiled[name].error!);
  }
}

// Listeners go on as the background starts, so the event that woke it isn't lost.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  void loaded.then(() => applyStyles(tabId, url));
});
chrome.webNavigation.onDOMContentLoaded.addListener(({ tabId, frameId, url, documentId }) => {
  if (frameId !== 0) return;
  void loaded.then(() => runScripts(tabId, url, documentId));
});
chrome.tabs.onRemoved.addListener((tabId) => inserted.delete(tabId));

// ---- what the rest of the shell uses ----------------------------------------

export async function ready() {
  await loaded;
}

/** Hosts with at least one boost, for the sidebar's ⚡ marker. */
export function boostedHosts(): string[] {
  return [...new Set(Object.keys(files).flatMap((name) => parseBoostName(name)?.host ?? []))];
}

export function list(): BoostFile[] {
  return Object.keys(files)
    .sort()
    .flatMap((name) => {
      const parsed = parseBoostName(name);
      return parsed ? [{ name, ...parsed, code: files[name], error: compiled[name]?.error }] : [];
    });
}

export function get(name: string): BoostFile | undefined {
  const parsed = parseBoostName(name);
  if (!parsed || files[name] === undefined) return undefined;
  return { name, ...parsed, code: files[name], error: compiled[name]?.error };
}

/** The boost for a page's site, created from the template the first time. */
export async function fileFor(url: string | undefined, kind: BoostKind) {
  const host = boostHostFor(url);
  return host ? create(host, kind) : undefined;
}

/** A boost for a host (`github.com`, or `all`), created from the template if it's new. */
export async function create(host: string, kind: BoostKind) {
  host = String(host).trim().toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) || (kind !== 'script' && kind !== 'styles')) return undefined;
  const name = boostName(host, kind);
  if (files[name] === undefined) await save(name, TEMPLATES[kind](host), { reload: false });
  return name;
}

/** Stores a boost and applies it to open pages: styles in place, scripts by reloading. */
export async function save(name: string, code: string, { reload = true, build }: { reload?: boolean; build?: CompiledBoost } = {}): Promise<BoostFile | undefined> {
  const parsed = parseBoostName(name);
  if (!parsed || !/^[a-z0-9.-]+$/i.test(parsed.host)) return undefined;
  files[name] = String(code);
  // The Boosts page compiles (compileBoost) and sends both; a new template has nothing to run.
  if (parsed.kind === 'script') compiled[name] = build ? { code: build.code && String(build.code), error: build.error && String(build.error) } : {};
  await persist();
  if (parsed.kind === 'script') registered = registerUserScripts();
  await refreshPages(parsed, reload);
  return get(name);
}

export async function remove(name: string) {
  const parsed = parseBoostName(name);
  if (!parsed || files[name] === undefined) return;
  delete files[name];
  delete compiled[name];
  await persist();
  if (parsed.kind === 'script') registered = registerUserScripts();
  // Unstyle pages now; a removed script stays until the page reloads, as in Electron.
  await refreshPages(parsed, false);
}

async function refreshPages({ host, kind }: { host: string; kind: BoostKind }, reload: boolean) {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined || !tab.url || !boostMatches(tab.url, host)) continue;
    if (kind === 'styles') await applyStyles(tab.id, tab.url);
    else if (reload) await chrome.tabs.reload(tab.id).catch(() => undefined);
  }
}

/** Opens the Boosts page (the list, or one boost's editor), or brings the open one forward. */
export async function openPage(name?: string) {
  const base = chrome.runtime.getURL(BOOSTS_PAGE);
  const url = name ? `${base}#${encodeURIComponent(name)}` : base;
  const open = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(base));
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { url, active: true });
    if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}
