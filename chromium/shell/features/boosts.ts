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
 *    and use the same API to cover documents that missed registration. With User Scripts
 *    unavailable, the DevTools compatibility path binds execution to the original document.
 */
import { boostHostFor, boostMatches, boostName, parseBoostName, type BoostKind } from '../lib/boostFiles';
import { hold, release, send } from './debuggee';
import { incognito } from '../incognito';

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
// It's TypeScript; Flecha strips the types when you save (⌘S), and open ${host} tabs reload.

export {};

// document.querySelector('header')?.remove();
`,
  styles: (host) => `/* Boost for ${host}: these styles apply to every page of this site, live as you save (⌘S). */

/* body { font-family: ui-sans-serif, system-ui; } */
`,
};

let files: Record<string, string> = {};
let compiled: Record<string, CompiledBoost> = {};
let loading: Promise<void> | undefined;
let notifySavedBoostsLoaded: () => void;
const savedBoostsLoaded = new Promise<void>((resolve) => { notifySavedBoostsLoaded = resolve; });
async function readStoredBoosts() {
  const saved = await chrome.storage.local.get([STORE_KEY, COMPILED_KEY]);
  files = (saved[STORE_KEY] as typeof files | undefined) ?? {};
  compiled = (saved[COMPILED_KEY] as typeof compiled | undefined) ?? {};
  registered = registerUserScripts();
  notifySavedBoostsLoaded();
}

function loadBoosts() {
  return loading ??= readStoredBoosts().catch((error) => {
    loading = undefined;
    throw error;
  });
}

let commits = Promise.resolve();
let effects = Promise.resolve();

function writeBoosts(
  name: string,
  parsed: { host: string; kind: BoostKind },
  reload: boolean,
  change: (nextFiles: typeof files, nextCompiled: typeof compiled) => boolean,
) {
  const commit = commits.then(async () => {
    await loadBoosts();
    const nextFiles = { ...files };
    const nextCompiled = { ...compiled };
    const changed = change(nextFiles, nextCompiled);
    if (changed) {
      await chrome.storage.local.set({ [STORE_KEY]: nextFiles, [COMPILED_KEY]: nextCompiled });
      files = nextFiles;
      compiled = nextCompiled;
    }
    return { changed, saved: get(name) };
  });
  commits = commit.then(() => undefined, () => undefined);
  return commit.then(async ({ changed, saved }) => {
    if (changed) {
      const apply = effects.then(async () => {
        if (parsed.kind === 'script') {
          registered = registered.then(registerUserScripts);
          await registered;
        }
        await refreshPages(parsed, reload);
      });
      effects = apply.catch((error) => console.warn('Flecha boosts: couldn’t refresh pages', error));
      await effects;
    }
    return saved;
  });
}

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

const boostMarker = (name: string) => `flecha.boost/${name}`;
const legacyDocumentMarker = 'flecha.boost.legacyDocument';

/** Both injection paths can reach the same document while registrations are changing. */
function oncePerDocument(name: string, code: string): string {
  const marker = `Symbol.for(${JSON.stringify(boostMarker(name))})`;
  return `if (!Object.hasOwn(globalThis, ${marker})) {
  Object.defineProperty(globalThis, ${marker}, { value: true });
${code}
}`;
}

/** Keeps Chromium's registered user scripts in step with the stored boosts. */
async function registerUserScripts(): Promise<void> {
  const api = userScripts();
  if (!api) return;
  try {
    const scripts = Object.keys(files)
      .map((name) => ({ name, parsed: parseBoostName(name), code: compiled[name]?.code }))
      .filter((s) => s.parsed?.kind === 'script' && s.code)
      .map(({ name, parsed, code }) => ({
        id: name,
        matches: matchPatterns(parsed!.host),
        js: [{ code: oncePerDocument(name, code!) }],
        world: 'MAIN' as chrome.userScripts.ExecutionWorld,
        runAt: 'document_end' as chrome.extensionTypes.RunAt,
      }));
    await api.unregister();
    if (scripts.length) await api.register(scripts);
  } catch (err) {
    console.warn('Flecha boosts: could not register user scripts for future navigations', err);
  }
}

let registered = Promise.resolve();

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

async function runScript(tabId: number, documentId: string, name: string, code: string): Promise<void> {
  const source = oncePerDocument(name, code);
  const api = userScripts();
  if (typeof api?.execute === 'function') {
    const [result] = await api.execute({ target: { tabId, documentIds: [documentId] }, world: 'MAIN', js: [{ code: source }] });
    if (result?.error) reportError(tabId, documentId, name, result.error);
    return;
  }
  await runScriptWithDebugger(tabId, documentId, name, source);
}

/** Compatibility for profiles without access to chrome.userScripts.execute. */
async function runScriptWithDebugger(tabId: number, documentId: string, name: string, source: string) {
  const claim = crypto.randomUUID();
  const [bound] = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    world: 'MAIN',
    args: [boostMarker(name), legacyDocumentMarker, claim],
    func: (scriptKey: string, documentKey: string, claim: string) => {
      if (Object.hasOwn(globalThis, Symbol.for(scriptKey))) return false;
      Object.defineProperty(document, Symbol.for(documentKey), { value: claim, configurable: true });
      return true;
    },
  });
  if (!bound?.result) return;
  const holder = Symbol('boost');
  if (!(await hold(tabId, holder))) {
    return reportError(tabId, documentId, name, 'the debugger could not attach. Enable Allow User Scripts for the Flecha shell to run script Boosts without the debugger.');
  }
  let objectId: string | undefined;
  try {
    // Capture the renderer's document object before checking Chromium's current document ID.
    // A navigation after the check cannot transfer this object handle to the replacement page.
    const marker = `Symbol.for(${JSON.stringify(legacyDocumentMarker)})`;
    const handle = await send<{ result?: { objectId?: string } }>(tabId, 'Runtime.evaluate', {
      expression: `document[${marker}] === ${JSON.stringify(claim)} ? document : null`,
    });
    objectId = handle?.result?.objectId;
    if (!objectId) return;
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => undefined);
    if (frame?.documentId !== documentId || frame.documentLifecycle !== 'active') return;
    const out = await send<{ exceptionDetails?: { exception?: { description?: string }; text?: string } }>(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (claim) {
        if (this !== document || this[${marker}] !== claim) return;
        delete this[${marker}];
        (function () {
          ${source}
        }).call(globalThis);
      }`,
      arguments: [{ value: claim }],
      userGesture: false,
    });
    if (out?.exceptionDetails) reportError(tabId, documentId, name, out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? 'failed');
  } finally {
    if (objectId) await send(tabId, 'Runtime.releaseObject', { objectId });
    await release(tabId, holder);
  }
}

/** Boost errors go to the page's own console, where the developer is already looking. */
function reportError(tabId: number, documentId: string, name: string, message: string) {
  void chrome.scripting
    .executeScript({ target: { tabId, documentIds: [documentId] }, world: 'MAIN', args: [`[Flecha boost ${name}] ${message}`], func: (m: string) => console.error(m) })
    .catch(() => undefined);
}

async function runScripts(tabId: number, url: string, documentId: string) {
  for (const name of matching(url, 'script')) {
    const script = compiled[name];
    if (script?.code) {
      await runScript(tabId, documentId, name, script.code).catch((error) => {
        console.warn(`Flecha boosts: couldn’t run ${name} in document ${documentId}`, error);
      });
    } else if (script?.error) reportError(tabId, documentId, name, script.error);
  }
}

// Listeners go on as the background starts, so the event that woke it isn't lost.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  void loadBoosts().then(() => applyStyles(tabId, url)).catch(logBoostError);
});
chrome.webNavigation.onDOMContentLoaded.addListener(({ tabId, frameId, url, documentId }) => {
  if (frameId !== 0 || !documentId) return;
  void loadBoosts().then(() => runScripts(tabId, url, documentId)).catch(logBoostError);
});
chrome.tabs.onRemoved.addListener((tabId) => inserted.delete(tabId));

function logBoostError(error: unknown) {
  console.warn('Flecha boosts: couldn’t apply saved boosts', error);
}

// ---- what the rest of the shell uses ----------------------------------------

export async function ready(onLoaded?: () => void) {
  if (onLoaded) void savedBoostsLoaded.then(onLoaded).catch(logBoostError);
  await loadBoosts();
}

/** Hosts with at least one boost, for the sidebar's ⚡ marker. */
export function boostedHosts(): string[] {
  return [...new Set(Object.keys(files).flatMap((name) => parseBoostName(name)?.host ?? []))];
}

export async function list(): Promise<BoostFile[]> {
  await commits;
  await loadBoosts();
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

/** A reconnect read may arrive while a previous port's write is still committing. */
export async function getCommitted(name: string) {
  await commits;
  await loadBoosts();
  return get(name);
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
  await commits;
  await loadBoosts();
  if (files[name] !== undefined) return name;
  return (await save(name, TEMPLATES[kind](host), { reload: false, onlyIfMissing: true })) && name;
}

/**
 * Stores a boost and applies it to open pages: styles in place, scripts by reloading. An
 * incognito window applies your boosts but writes none: a boost names its site, and both copies
 * of the shell share chrome.storage.local.
 */
export async function save(name: string, code: string, { reload = true, build, onlyIfMissing }: { reload?: boolean; build?: CompiledBoost; onlyIfMissing?: boolean } = {}): Promise<BoostFile | undefined> {
  const parsed = parseBoostName(name);
  if (incognito || !parsed || !/^[a-z0-9.-]+$/i.test(parsed.host)) return undefined;
  return writeBoosts(name, parsed, reload, (nextFiles, nextCompiled) => {
    if (onlyIfMissing && Object.hasOwn(nextFiles, name)) return false;
    nextFiles[name] = String(code);
    // The editor sends the compiled output; a new template has nothing to run.
    if (parsed.kind === 'script') nextCompiled[name] = build ? { code: build.code && String(build.code), error: build.error && String(build.error) } : {};
    return true;
  });
}

export async function remove(name: string) {
  const parsed = parseBoostName(name);
  if (incognito || !parsed) return;
  // Unstyle pages now; a removed script stays until the page reloads, as in Electron.
  await writeBoosts(name, parsed, false, (nextFiles, nextCompiled) => {
    if (!Object.hasOwn(nextFiles, name)) return false;
    delete nextFiles[name];
    delete nextCompiled[name];
    return true;
  });
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
