/**
 * The shell's side of Flecha's native messaging host (chromium/native-host): importing from
 * other browsers, reading the Electron spike's state, and the agent bridge for coding agents.
 *
 * The host reads files and serves MCP on 127.0.0.1; this side adds imports to the Store and
 * runs agents' tool calls on real tabs with chrome.tabs and chrome.debugger. The port to the
 * host opens on first use and stays open while the agent bridge is on (which also keeps the
 * background awake); otherwise it closes after a minute of quiet.
 *
 * Install the host with chromium/scripts/install-native-host.sh.
 */
import type { DetectedBrowser, HistoryEntry, ImportOptions, ImportPreview, ImportResult, UiState } from '../shared/types';
import { pinnedTabIds, type Store } from '../shared/store';
import type { AgentResult, AgentTab, AgentToolName } from '../shared/agentTools';
import { applyBrowserImport, importOptions, previewBrowserImport, type BrowserImportData } from '../shared/importApply';
import { HOST_NAME, TOOL_TIMEOUT, toolTimeout, type HostMethods, type ToHost, type ToShell } from '../native-host/protocol';
import { broadcast, handle } from './hub';
import { acquire, isHeld, release, send } from './features/debuggee';

export interface NativeHostContext {
  store: Store;
  /** This build can give a Space its own cookies and logins (Separate Cookies and Logins). */
  canIsolate: boolean;
  /** Sends every page the new state (the sidebar shows what an agent is doing). */
  broadcastState(): void;
  tabs: {
    /** Opens an address in a new background Today tab, in the agent's folder; returns its id. */
    open(url: string): string;
    /** The Chromium tab showing a Flecha tab, opened (in the background) if it has none yet. */
    chromeTab(tabId: string): Promise<number | undefined>;
    activate(tabId: string): void;
    close(tabId: string): void;
  };
  /** The agent started or stopped working in a tab (`agentTabsInUse` changed): tab sleep wakes it and lets it be. Settles once woken. */
  agentTabsChanged(): Promise<void>;
}

const NOT_INSTALLED =
  'Flecha’s helper is unavailable, so it can’t import from other browsers or run the agent bridge. Repair or reinstall Flecha, then try again.';
const IDLE_CLOSE = 60_000;
/** How long the agent bridge waits before starting the host again, doubling up to a minute. */
const RETRY_FIRST = 2_000;
const RETRY_MAX = 60_000;

/** Chromium's reasons for not starting a host at all (native_message_host.cc), as opposed to one that stopped. */
const isMissing = (reason: string) =>
  /host not found|host is forbidden|invalid native messaging host|failed to start native messaging host/i.test(reason);

/** Why the helper couldn't be used, in words for the person importing. */
function helperProblem(err: unknown) {
  const message = String(err instanceof Error ? err.message : err);
  return isMissing(message) ? NOT_INSTALLED : message;
}

export function registerNativeHost(ctx: NativeHostContext) {
  const { store } = ctx;

  // ---- the port ---------------------------------------------------------------

  let port: chrome.runtime.Port | undefined;
  let nextCall = 1;
  const calls = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  const chunks = new Map<number, string[]>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let sentAgent = '';
  /** Why the host last failed, for Settings; cleared once it answers. */
  let hostError: string | undefined;
  /** Why the running host couldn't start the bridge; only the bridge's next report clears it. */
  let agentError: string | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = RETRY_FIRST;

  /** Tells the sidebar and an open Settings page that the host or bridge changed. */
  function changed() {
    ctx.broadcastState();
    broadcast('settings:changed');
  }

  function setHostError(error: string | undefined) {
    if (error === hostError) return;
    hostError = error;
    changed();
  }

  function connect() {
    if (port) return port;
    const p = chrome.runtime.connectNative(HOST_NAME);
    port = p;
    sentAgent = '';
    p.onMessage.addListener((message: ToShell) => receive(message));
    p.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message ?? 'The helper stopped';
      if (port === p) port = undefined;
      endpoint = undefined;
      agentError = undefined;
      for (const call of calls.values()) call.reject(new Error(reason));
      calls.clear();
      chunks.clear();
      console.warn('Flecha shell: native host disconnected:', reason);
      hostError = isMissing(reason) ? NOT_INSTALLED : `Flecha’s helper stopped: ${reason}`;
      changed();
      // The bridge should stay up while it's on: start the host again, a little later each time.
      if (store.state.agent?.enabled) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          sentAgent = '';
          syncAgent();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
      }
    });
    return p;
  }

  /** Closes the port after a quiet minute, unless the agent bridge needs it. */
  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!store.state.agent?.enabled && !calls.size) {
        port?.disconnect();
        port = undefined;
      }
    }, IDLE_CLOSE);
  }

  function post(message: ToHost) {
    connect().postMessage(message);
    touch();
  }

  function call<K extends keyof HostMethods>(method: K, ...params: Parameters<HostMethods[K]>): Promise<ReturnType<HostMethods[K]>> {
    return new Promise((resolve, reject) => {
      const id = nextCall++;
      calls.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        post({ type: 'call', id, method, params });
      } catch (err) {
        calls.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function receive(message: ToShell) {
    touch();
    retryDelay = RETRY_FIRST;
    if (message.type === 'chunk') {
      const parts = chunks.get(message.id) ?? [];
      parts[message.index] = message.data;
      chunks.set(message.id, parts);
      if (parts.filter((p) => p !== undefined).length < message.total) return;
      chunks.delete(message.id);
      return receive(JSON.parse(parts.join('')) as ToShell);
    }
    if (message.type === 'reply') {
      setHostError(undefined);
      const pending = calls.get(message.id);
      calls.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.value);
    } else if (message.type === 'agent') {
      endpoint = message.endpoint;
      hostError = undefined;
      agentError = message.error ? `The agent bridge couldn’t start: ${message.error}` : undefined;
      if (message.error) console.error('Flecha shell: agent bridge failed:', message.error);
      changed();
    } else if (message.type === 'tool') {
      void runTool(message.name as AgentToolName, message.args ?? {}).then((result) => {
        try {
          post({ type: 'toolResult', id: message.id, result });
        } catch {
          // The host went away; the agent's request went with it.
        }
      });
    }
  }

  // ---- importing --------------------------------------------------------------

  /**
   * Chromium's history API can add a page but not when it was visited or its title, so
   * imported pages count as visited now; the address bar still finds them.
   */
  const history = {
    async merge(entries: HistoryEntry[]) {
      const urls = [...new Set(entries.filter((e) => /^https?:/.test(e.url)).map((e) => e.url))];
      // Oldest first, so the most recent visit ends up newest.
      urls.reverse();
      let added = 0;
      for (let i = 0; i < urls.length; i += 50) {
        const writes = await Promise.allSettled(urls.slice(i, i + 50).map(async (url) => chrome.history.addUrl({ url })));
        added += writes.filter((write) => write.status === 'fulfilled').length;
      }
      return { added, failed: urls.length - added };
    },
  };

  /** What an import read by `read` would bring over; `name` stands in for the source when the helper fails. */
  async function preview(name: string, read: () => Promise<BrowserImportData>): Promise<ImportPreview> {
    try {
      return previewBrowserImport(await read(), store.state, ctx.canIsolate);
    } catch (err) {
      return { name, spaces: [], favorites: 0, archived: 0, history: 0, skipped: [], canIsolate: ctx.canIsolate, warnings: [helperProblem(err)], spacesKey: '' };
    }
  }

  async function apply(options: ImportOptions, read: () => Promise<BrowserImportData>): Promise<ImportResult> {
    try {
      return await applyBrowserImport(await read(), importOptions(options, ctx.canIsolate), store, history);
    } catch (err) {
      return { changed: false, spaces: 0, merged: 0, bookmarks: 0, folders: 0, splits: 0, history: 0, archived: 0, warnings: [helperProblem(err)], details: [] };
    }
  }

  handle({
    detectBrowsers: async (): Promise<DetectedBrowser[]> => {
      try {
        return await call('detectBrowsers');
      } catch (err) {
        console.warn('Flecha shell: browser discovery failed:', err);
        throw new Error('Browser import is unavailable because Flecha could not connect to its import helper.');
      }
    },
    previewImport: (id: string) => preview(String(id), () => call('readBrowser', String(id))),
    // The browser is read again rather than kept from the preview: the background may have slept since.
    // The preview's spacesKey makes sure the Spaces it showed are still the ones being imported.
    importBrowser: (id: string, options: ImportOptions) => apply(options, () => call('readBrowser', String(id))),
    /** A bookmarks file exported from any browser as HTML, by its text; the page sends it again to import. */
    previewBookmarksFile: (html: string, fileName: string) => preview(String(fileName), () => call('readBookmarksHtml', String(html), String(fileName))),
    importBookmarksFile: (html: string, fileName: string, options: ImportOptions) =>
      apply(options, () => call('readBookmarksHtml', String(html), String(fileName))),
    /** The Electron spike's saved state as text, or undefined when there's none or no helper. */
    'nativeHost:flechaState': async () => call('readFlechaState').catch(() => undefined),
  });

  // ---- the agent bridge ---------------------------------------------------------

  let endpoint: string | undefined;
  let activity: { tabId?: string; action: string; at: number } | undefined;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;

  /** Starts, stops or re-keys the bridge whenever Settings change it. */
  function syncAgent() {
    const agent = store.state.agent;
    const wanted = JSON.stringify({ enabled: !!agent?.enabled, token: agent?.token ?? '' });
    if (wanted === sentAgent) return;
    if (!agent?.enabled) clearTimeout(retryTimer);
    // Nothing to stop if the host isn't running.
    if (!agent?.enabled && !port) {
      sentAgent = wanted;
      return;
    }
    sentAgent = wanted;
    try {
      post({ type: 'agent', enabled: !!agent?.enabled, token: agent?.token ?? '' });
    } catch (err) {
      console.warn('Flecha shell: no agent bridge:', err);
      setHostError(NOT_INSTALLED);
    }
  }
  store.onChange(syncAgent);
  syncAgent();

  function showActivity(tabId: string | undefined, action: string) {
    activity = { tabId, action, at: Date.now() };
    ctx.broadcastState();
    // Drop the "busy" highlight once the agent has been quiet for a moment.
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => ctx.broadcastState(), 4000);
  }

  function listTabs(): AgentTab[] {
    const visible = new Set(store.state.windows.flatMap((w) => store.visibleTabIds(w.id)));
    const tabs: AgentTab[] = [];
    const add = (id: string, space: string, zone: AgentTab['zone']) => {
      const tab = store.state.tabs[id];
      if (tab) tabs.push({ id, title: tab.customTitle || tab.title, url: tab.url, space, zone, active: visible.has(id), agent: !!tab.agent });
    };
    for (const id of store.state.favorites) add(id, '', 'favorites');
    for (const space of store.state.spaces) {
      for (const id of pinnedTabIds(space.pinned)) add(id, space.name, 'pinned');
      // Today tabs of every window.
      for (const win of store.state.windows) for (const id of win.spaces[space.id]?.today ?? []) add(id, space.name, 'today');
    }
    return tabs;
  }

  type UseTab = { signal: AbortSignal; tab(chromeId: number): Promise<void>; track<T>(command: Promise<T>): Promise<T> };
  const tabOperations = new Map<number, Promise<void>>();

  async function runTool(name: AgentToolName, args: Record<string, any>): Promise<AgentResult> {
    const commands = new Set<Promise<unknown>>();
    let work: Promise<AgentResult> | undefined;
    let runningTab: number | undefined;
    let unlock: (() => void) | undefined;
    const timeout = toolTimeout(args.timeoutMs);
    try {
      return await withDeadline(timeout, (signal) => (work = tools[name](args, {
        signal,
        async tab(chromeId) {
          signal.throwIfAborted();
          const previous = tabOperations.get(chromeId) ?? Promise.resolve();
          const finished = new Promise<void>((resolve) => { unlock = resolve; });
          const tail = previous.then(() => finished);
          tabOperations.set(chromeId, tail);
          void tail.then(() => { if (tabOperations.get(chromeId) === tail) tabOperations.delete(chromeId); });
          await untilAborted(previous, signal);
          signal.throwIfAborted();
          runningTab = chromeId;
          working.add(chromeId);
          if (attached.has(chromeId)) keepAttached(chromeId);
        },
        track(command) {
          commands.add(command);
          const settled = () => commands.delete(command);
          void command.then(settled, settled);
          return command;
        },
      })));
    } catch (err) {
      if (err instanceof AgentTimeout) return fail(`Flecha didn’t answer ${name} within ${timeout / 1000}s`);
      return fail(err instanceof Error ? err.message : String(err));
    } finally {
      // A timeout stops the caller's wait. Chrome may still be running a command.
      void Promise.allSettled([work]).then(async () => {
        await Promise.allSettled(commands);
        if (runningTab !== undefined) {
          working.delete(runningTab);
          if (attached.has(runningTab)) keepAttached(runningTab);
        }
        unlock?.();
      });
    }
  }

  /**
   * The tool's tab with its Chromium tab, after telling the sidebar. It stays where it is: tools
   * drive tabs through chrome.debugger, which needs no tab on screen and no window focus.
   */
  async function target(tabId: string, action: string, use: UseTab) {
    if (!store.state.tabs[tabId]) throw new Error(`No tab with id ${tabId}`);
    showActivity(tabId, action);
    const chromeId = await ctx.tabs.chromeTab(tabId);
    if (chromeId === undefined) throw new Error(`Tab ${tabId} couldn’t be opened`);
    await use.tab(chromeId);
    // A tab tab sleep discarded needs nothing more: attaching the debugger brings its page back
    // (native-agent.mjs checks it).
    return { tabId, chromeId };
  }

  const tools: Record<AgentToolName, (args: Record<string, any>, use: UseTab) => Promise<AgentResult>> = {
    list_tabs: async () => {
      showActivity(undefined, 'listing tabs');
      return text(listTabs());
    },
    open_tab: async ({ url }) => {
      const tabId = ctx.tabs.open(String(url));
      showActivity(tabId, 'opening a tab');
      const chromeId = await ctx.tabs.chromeTab(tabId);
      if (chromeId !== undefined) await settle(chromeId);
      const tab = chromeId !== undefined ? await chrome.tabs.get(chromeId).catch(() => undefined) : undefined;
      return text({ tabId, url: tab?.pendingUrl || tab?.url || url });
    },
    activate_tab: async ({ tabId }) => {
      if (!store.state.tabs[tabId]) return fail(`No tab with id ${tabId}`);
      ctx.tabs.activate(tabId);
      showActivity(tabId, 'switching tab');
      return text('ok');
    },
    close_tab: async ({ tabId }) => {
      if (!store.state.tabs[tabId]) return fail(`No tab with id ${tabId}`);
      showActivity(tabId, 'closing a tab');
      ctx.tabs.close(tabId);
      return text('ok');
    },
    navigate: async ({ tabId, url, action }, use) => {
      const t = await target(tabId, url ? `opening ${url}` : (action ?? 'navigating'), use);
      if (url) await chrome.tabs.update(t.chromeId, { url: String(url) });
      else if (action === 'back') await chrome.tabs.goBack(t.chromeId).catch(() => undefined);
      else if (action === 'forward') await chrome.tabs.goForward(t.chromeId).catch(() => undefined);
      else if (action === 'reload') await chrome.tabs.reload(t.chromeId);
      await settle(t.chromeId);
      const tab = await chrome.tabs.get(t.chromeId);
      return text({ url: tab.url, title: tab.title });
    },
    read_page: async ({ tabId, format = 'text', maxChars = 40000 }, use) => {
      const t = await target(tabId, 'reading the page', use);
      const code = {
        text: 'document.body?.innerText ?? ""',
        html: 'document.documentElement.outerHTML',
        links: '[...document.links].map((a) => `${a.innerText.trim().slice(0, 80)} -> ${a.href}`).join("\\n")',
      }[format as 'text' | 'html' | 'links'];
      if (!code) return fail(`Unknown format ${format}`);
      const content = String(await evaluate(t.chromeId, code, use));
      const tab = await chrome.tabs.get(t.chromeId);
      return text(`# ${tab.title}\n${tab.url}\n\n${content.slice(0, maxChars)}`);
    },
    screenshot: async ({ tabId }, use) => {
      const t = await target(tabId, 'taking a screenshot', use);
      // Chromium has a tab that isn't on screen draw a frame for this (page_handler.cc).
      const shot = (await debug(t.chromeId, 'Page.captureScreenshot', { format: 'png' }, use)) as { data: string };
      return { content: [{ type: 'image', data: await shrink(shot.data, 1280), mimeType: 'image/png' }] };
    },
    console_logs: async ({ tabId, level, limit = 50 }, use) => {
      const t = await target(tabId, 'reading the console', use);
      await attach(t.chromeId, use);
      const entries = (consoleLogs.get(t.chromeId) ?? []).filter((e) => !level || e.level === level);
      return text(entries.slice(-limit).map((e) => `[${e.level}] ${e.message}${e.source ? `  (${e.source})` : ''}`).join('\n') || '(no messages)');
    },
    click: async ({ tabId, selector }, use) => {
      const t = await target(tabId, `clicking ${selector}`, use);
      const point = (await evaluate(t.chromeId, centerOf(String(selector)), use)) as { x: number; y: number } | undefined;
      if (!point) return fail(`No visible element matches ${selector}`);
      const button = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
      await dispatchInput(t.chromeId, 'Input.dispatchMouseEvent', { ...button, type: 'mousePressed' }, { ...button, type: 'mouseReleased' }, use);
      await settle(t.chromeId);
      return text({ clicked: selector, url: (await chrome.tabs.get(t.chromeId)).url });
    },
    type: async ({ tabId, selector, text: value, clear, submit }, use) => {
      const t = await target(tabId, `typing into ${selector ?? 'the page'}`, use);
      if (selector) {
        const found = await evaluate(
          t.chromeId,
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.focus();
            if (${!!clear} && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
            return true;
          })()`, use,
        );
        if (!found) return fail(`No element matches ${selector}`);
      }
      await debug(t.chromeId, 'Input.insertText', { text: String(value) }, use);
      if (submit) await pressKey(t.chromeId, 'Enter', use);
      await settle(t.chromeId);
      return text('ok');
    },
    press_key: async ({ tabId, key }, use) => {
      const t = await target(tabId, `pressing ${key}`, use);
      await pressKey(t.chromeId, String(key), use);
      await settle(t.chromeId);
      return text('ok');
    },
    evaluate: async ({ tabId, expression }, use) => {
      const t = await target(tabId, 'running JavaScript', use);
      const result = await evaluate(t.chromeId, String(expression), use);
      return text(result === undefined ? 'undefined' : result);
    },
    wait_for: async ({ tabId, selector, timeoutMs = 10000 }, use) => {
      const t = await target(tabId, `waiting for ${selector ?? 'the page'}`, use);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        use.signal.throwIfAborted();
        const ready = selector
          ? await evaluate(t.chromeId, `!!document.querySelector(${JSON.stringify(selector)})`, use).catch(() => false)
          : (await chrome.tabs.get(t.chromeId)).status !== 'loading';
        if (ready) return text('ready');
        await wait(200);
      }
      return fail(`Timed out after ${timeoutMs}ms`);
    },
  };

  // ---- chrome.debugger --------------------------------------------------------
  // Attached on first use and kept while the agent works, so console messages keep coming
  // (Runtime.enable replays the ones logged before); let go after two quiet minutes. While
  // attached, the page acts focused although its tab isn't on screen, and tab sleep leaves it be.

  const DEBUG_IDLE = 120_000;
  const DEBUG_HOLDER = 'agent';
  const attached = new Map<number, ReturnType<typeof setTimeout> | undefined>();
  const working = new Set<number>();
  const releasing = new Map<number, Promise<void>>();
  const consoleLogs = new Map<number, Array<{ level: string; message: string; source: string; time: number }>>();

  function keepAttached(chromeId: number) {
    clearTimeout(attached.get(chromeId));
    attached.set(
      chromeId,
      working.has(chromeId) ? undefined : setTimeout(() => void releaseAgent(chromeId), DEBUG_IDLE),
    );
  }

  function forget(chromeId: number) {
    clearTimeout(attached.get(chromeId));
    const was = attached.delete(chromeId);
    consoleLogs.delete(chromeId);
    if (was) void ctx.agentTabsChanged();
  }

  function releaseAgent(chromeId: number, reset = true) {
    // A responsive view can keep the session open. The next agent call must set up after these resets.
    const released = release(chromeId, DEBUG_HOLDER, reset ? () => Promise.all([
      send(chromeId, 'Emulation.setFocusEmulationEnabled', { enabled: false }),
      send(chromeId, 'Runtime.disable'),
      send(chromeId, 'Log.disable'),
    ]) : undefined)
      .finally(() => releasing.delete(chromeId));
    releasing.set(chromeId, released);
    forget(chromeId);
    return released;
  }

  /**
   * Chromium keeps one extension's debugger out of a tab that shows another extension's page,
   * such as the frames a password manager adds to sign-in forms. Agent tabs keep other
   * extensions out (patch 0080), but your own tabs don't: this names the extension in the way.
   */
  async function attachRefused(chromeId: number, error: unknown): Promise<unknown> {
    // Only Chromium's refusals and detaches: other errors say what went wrong themselves.
    const message = error instanceof Error ? error.message : String(error);
    if (!/Cannot access a chrome-extension:\/\/ URL of different extension|Cannot attach to this target|Detached while handling command/.test(message)) {
      return error;
    }
    // webNavigation leaves other extensions' frames out, so they are read from the page: the
    // frame elements, in closed shadow roots too, where password managers put theirs.
    const results = await chrome.scripting
      .executeScript({
        target: { tabId: chromeId, allFrames: true },
        func: () => {
          const sources: string[] = [];
          const walk = (root: ParentNode) => {
            for (const element of root.querySelectorAll('*')) {
              if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) sources.push(element.src);
              const shadow = element instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(element) : null;
              if (shadow) walk(shadow);
            }
          };
          walk(document);
          return sources;
        },
      })
      .catch(() => []);
    const others = new Set<string>();
    for (const url of results.flatMap((frame) => (frame.result as string[] | undefined) ?? [])) {
      const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(url)?.[1];
      if (id && id !== chrome.runtime.id) others.add(id);
    }
    if (!others.size) return error;
    const tab = await chrome.tabs.get(chromeId).catch(() => undefined);
    const actions =
      tab && typeof chrome.flechaPrivate?.getExtensionActions === 'function'
        ? await chrome.flechaPrivate.getExtensionActions(tab.windowId).catch(() => [])
        : [];
    const names = [...others].map((id) => actions.find((action) => action.id === id)?.name ?? id);
    return new Error(
      `This tab shows a page of another extension (${names.join(', ')}), and Chromium doesn't let Flecha drive a tab with another extension's page in it. ` +
        'Open the page with open_tab instead: other extensions stay out of the tabs Flecha opens for you.',
    );
  }

  async function attach(chromeId: number, use: UseTab) {
    const cleanup = releasing.get(chromeId);
    if (cleanup) await untilAborted(cleanup, use.signal);
    use.signal.throwIfAborted();
    if (attached.has(chromeId)) {
      keepAttached(chromeId);
      return;
    }
    let acquired = false;
    let settingUp: Promise<unknown> | undefined;
    try {
      await withDeadline(TOOL_TIMEOUT, async (deadline) => {
        const signal = AbortSignal.any([use.signal, deadline]);
        await untilAborted(acquire(chromeId, DEBUG_HOLDER), signal);
        signal.throwIfAborted();
        acquired = true;
        keepAttached(chromeId);
        consoleLogs.set(chromeId, []);
        const setup = (method: string, params?: object) => {
          signal.throwIfAborted();
          settingUp = use.track(chrome.debugger.sendCommand({ tabId: chromeId }, method, params));
          return untilAborted(settingUp, signal);
        };
        await untilAborted(ctx.agentTabsChanged(), signal);
        await setup('Emulation.setFocusEmulationEnabled', { enabled: true });
        await setup('Runtime.enable');
        await setup('Log.enable');
        await untilAborted(wait(100), signal);
      });
    } catch (error) {
      // Keep the old attachment owned while a command could still change its domains.
      const releaseWhenSafe = () => releaseAgent(chromeId, acquired);
      if (settingUp) void settingUp.then(releaseWhenSafe, releaseWhenSafe);
      else void releaseWhenSafe();
      throw await attachRefused(chromeId, error);
    }
  }

  async function debug(chromeId: number, method: string, params: object, use: UseTab) {
    await attach(chromeId, use);
    use.signal.throwIfAborted();
    // Chromium also lets go of a tab when another extension's frame loads in it mid-command.
    return untilAborted(use.track(chrome.debugger.sendCommand({ tabId: chromeId }, method, params)), use.signal).catch(async (error: unknown) => {
      throw await attachRefused(chromeId, error);
    });
  }

  async function evaluate(chromeId: number, expression: string, use: UseTab): Promise<unknown> {
    const result = (await debug(chromeId, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, use)) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'The script threw');
    }
    return result.result?.value;
  }

  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const log = source.tabId !== undefined ? consoleLogs.get(source.tabId) : undefined;
    if (!log) return;
    if (method === 'Runtime.consoleAPICalled') {
      const level = { warning: 'warning', error: 'error', assert: 'error', debug: 'debug' }[params.type as string] ?? 'info';
      const message = (params.args ?? []).map((a: any) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type))).join(' ');
      const frame = params.stackTrace?.callFrames?.[0];
      log.push({ level, message, source: frame ? `${frame.url}:${frame.lineNumber + 1}` : '', time: params.timestamp ?? Date.now() });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails ?? {};
      log.push({ level: 'error', message: d.exception?.description ?? d.text ?? 'Uncaught exception', source: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : '', time: params.timestamp ?? Date.now() });
    } else if (method === 'Log.entryAdded') {
      const e = params.entry ?? {};
      const level = e.level === 'verbose' ? 'debug' : e.level === 'warning' || e.level === 'error' ? e.level : 'info';
      log.push({ level, message: e.text ?? '', source: e.url ? `${e.url}${e.lineNumber !== undefined ? `:${e.lineNumber + 1}` : ''}` : '', time: e.timestamp ?? Date.now() });
    } else if (method === 'Runtime.executionContextsCleared') {
      // A new page; Electron's log kept going across navigations too, so leave it.
    }
    if (log.length > 500) log.splice(0, log.length - 500);
  });
  chrome.debugger.onDetach.addListener((source) => source.tabId !== undefined && forget(source.tabId));
  chrome.tabs.onRemoved.addListener((chromeId) => forget(chromeId));

  async function dispatchInput(chromeId: number, method: string, down: object, up: object, use: UseTab) {
    await attach(chromeId, use);
    use.signal.throwIfAborted();
    const target = { tabId: chromeId };
    const pressed = use.track(chrome.debugger.sendCommand(target, method, down));
    try {
      await untilAborted(pressed, use.signal);
    } finally {
      if (isHeld(chromeId, DEBUG_HOLDER)) {
        await withDeadline(TOOL_TIMEOUT, () => use.track(chrome.debugger.sendCommand(target, method, up)));
      }
    }
  }

  async function pressKey(chromeId: number, key: string, use: UseTab) {
    const named: Record<string, [code: string, keyCode: number, text?: string]> = {
      Enter: ['Enter', 13, '\r'],
      Tab: ['Tab', 9],
      Escape: ['Escape', 27],
      Backspace: ['Backspace', 8],
      Delete: ['Delete', 46],
      ArrowLeft: ['ArrowLeft', 37],
      ArrowUp: ['ArrowUp', 38],
      ArrowRight: ['ArrowRight', 39],
      ArrowDown: ['ArrowDown', 40],
      Home: ['Home', 36],
      End: ['End', 35],
      PageUp: ['PageUp', 33],
      PageDown: ['PageDown', 34],
      ' ': ['Space', 32, ' '],
    };
    const [code, keyCode, keyText] =
      named[key] ?? (key.length === 1 ? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), key] : [key, 0]);
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await dispatchInput(chromeId, 'Input.dispatchKeyEvent',
      { type: keyText ? 'keyDown' : 'rawKeyDown', ...base, text: keyText, unmodifiedText: keyText },
      { type: 'keyUp', ...base }, use);
  }

  return {
    /** For UiState.agent: what a coding agent is doing, for the sidebar. */
    agentActivity(): UiState['agent'] {
      return (
        activity && {
          connected: Date.now() - activity.at < 60_000,
          busy: Date.now() - activity.at < 3_500,
          tabId: activity.tabId,
          action: activity.action,
        }
      );
    },
    /** The Chromium tabs the agent is working in (debugger attached), which tab sleep treats as in use. */
    agentTabsInUse: (): Set<number> => new Set(attached.keys()),
    /** The bridge's address while it runs, for Settings. */
    agentEndpoint: () => endpoint,
    /** Why the host or its bridge last failed, for Settings; undefined once they work. */
    hostError: () => hostError ?? agentError,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, cancellation]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

class AgentTimeout extends Error {
  constructor() {
    super('Flecha’s debugger did not answer in time.');
  }
}

async function withDeadline<T>(milliseconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AgentTimeout()), milliseconds);
  try {
    return await untilAborted(work(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

const text = (value: unknown): AgentResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string): AgentResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** Waits for navigation the last action may have started, up to a few seconds. */
async function settle(chromeId: number) {
  await wait(150);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(chromeId).catch(() => undefined);
    if (!tab || tab.status !== 'loading') return;
    await wait(100);
  }
}

function centerOf(selector: string) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return undefined;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return undefined;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

/** Scales a base64 PNG down to `width` pixels wide, as Electron's bridge did. */
async function shrink(png: string, width: number): Promise<string> {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  if (image.width <= width) return png;
  const height = Math.round((image.height * width) / image.width);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
  const out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < out.length; i += 0x8000) binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(binary);
}
