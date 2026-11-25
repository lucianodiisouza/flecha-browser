/**
 * The background side of the shell's messaging. Every Flecha page (sidebar, Settings, …)
 * connects a port named "flecha"; commands are fire-and-forget, invokes get a reply, and
 * events go out to every connected page, or to those of one window. Feature modules register
 * their own handlers, so they never need to touch one shared switch.
 *
 * Each window has a frame page of its own, and what a command does depends on the window it
 * came from: a handler asks caller() for it.
 */
import type { Message } from './protocol';

type Handler = (...args: any[]) => unknown;

/** Where a connected page is. */
export interface Page {
  /** The window whose frame page it is (window.html?window=<id>): a main window's sidebar, or a Flechinha's toolbar. */
  windowId?: number;
  /** The frame page of a Flechinha. */
  flechinha?: boolean;
  /** The tab it is the page of (a new tab page, Settings). */
  tabId?: number;
}

const commands = new Map<string, Handler>();
const ports = new Map<chrome.runtime.Port, Page>();

function pageOf(port: chrome.runtime.Port): Page {
  const page: Page = { tabId: port.sender?.tab?.id };
  try {
    const params = new URL(port.sender?.url ?? '').searchParams;
    // The browser opens a window's frame page with the window's id in its address.
    const windowId = params.get('window');
    if (windowId !== null && /^\d+$/.test(windowId)) {
      page.windowId = Number(windowId);
      page.flechinha = params.get('kind') === 'flechinha';
    }
  } catch {
    // No address: a page of no window.
  }
  return page;
}

let calling: Page | undefined;

/**
 * The page whose command is running, for a handler to know its window. Only in the handler's
 * first turn: after an `await` another command may be running, so ask before the first one.
 * Undefined for commands nobody sent (an alarm, a link from another app).
 */
export function caller(): Page | undefined {
  return calling;
}

/** Runs `fn` as if `page` had asked for it: a shortcut pressed in its window, say. */
export function callAs<T>(page: Page | undefined, fn: () => T): T {
  const before = calling;
  calling = page;
  try {
    return fn();
  } finally {
    calling = before;
  }
}

/** Adds handlers by name; a name registered twice is a bug, so it throws. */
export function handle(handlers: Record<string, Handler>) {
  for (const [name, fn] of Object.entries(handlers)) {
    if (commands.has(name)) throw new Error(`Flecha shell: "${name}" is handled twice`);
    commands.set(name, fn);
  }
}

/**
 * Runs a registered command from the background itself (a keyboard shortcut, say), as if a
 * page had sent it. A command nobody handles yet is reported, not thrown.
 */
export function call(name: string, ...args: unknown[]): unknown {
  const fn = commands.get(name);
  if (!fn) return void console.warn(`Flecha shell: "${name}" isn't in the Chromium build yet`);
  return fn(...args);
}

/**
 * Runs a command another module registered, as if a page had sent it (a feature asking for
 * DevTools, say). Returns false when nothing handles that name yet.
 */
export function run(name: string, ...args: unknown[]) {
  const fn = commands.get(name);
  if (!fn) return false;
  // For the same window as whoever asks.
  const page = calling;
  void Promise.resolve()
    .then(() => callAs(page, () => fn(...args)))
    .catch((err) => console.error(`Flecha shell: "${name}" failed`, err));
  return true;
}

/** Sends an event to every open Flecha page. */
export function broadcast(name: string, ...args: unknown[]) {
  const message: Message = { type: 'event', name, args };
  for (const port of ports.keys()) port.postMessage(message);
}

/** Sends each open page an event of its own: `argsFor` gives its arguments, or nothing to leave it out. */
export function broadcastEach(name: string, argsFor: (page: Page) => unknown[] | undefined) {
  for (const [port, page] of ports) {
    const args = argsFor(page);
    if (args) port.postMessage({ type: 'event', name, args } satisfies Message);
  }
}

/** Sends an event to one window's frame page. */
export function sendToWindow(windowId: number, name: string, ...args: unknown[]) {
  broadcastEach(name, (page) => (page.windowId === windowId ? args : undefined));
}

/** The main window a page is the sidebar of, if it is one. */
export const windowOf = (page: Page | undefined) => (page?.flechinha ? undefined : page?.windowId);

/**
 * A short message in one window's sidebar: `windowId`'s. Every sidebar shows it when that
 * isn't a window with one (a Flechinha, stock Chromium's side panel, nobody asking).
 */
export function flashIn(windowId: number | undefined, message: string) {
  const has = windowId !== undefined && [...ports.values()].some((page) => windowOf(page) === windowId);
  if (has) sendToWindow(windowId, 'flash', message);
  else broadcast('flash', message);
}

/** Calls fn whenever a page connects (to send it the current state, say). */
const connectListeners: Array<(page: Page) => void> = [];
export function onConnect(fn: (page: Page) => void) {
  connectListeners.push(fn);
}

/** Starts taking connections; messages wait until `ready` (handlers registered) resolves. */
export function listen(ready: Promise<unknown>) {
  chrome.runtime.onConnect.addListener(async (port) => {
    if (port.name !== 'flecha') return;
    // Buffer what arrives while the background is still loading.
    const early: Message[] = [];
    const buffer = (m: Message) => void early.push(m);
    port.onMessage.addListener(buffer);
    await ready;
    port.onMessage.removeListener(buffer);
    const page = pageOf(port);
    ports.set(port, page);
    port.onDisconnect.addListener(() => ports.delete(port));
    const dispatch = async (message: Message) => {
      if (message.type === 'ping') return;
      if (message.type !== 'cmd' && message.type !== 'invoke') return;
      const fn = commands.get(message.name);
      if (!fn) {
        console.warn(`Flecha shell: "${message.name}" isn't in the Chromium build yet`);
        if (message.type === 'invoke') port.postMessage({ type: 'result', id: message.id, value: undefined } satisfies Message);
        return;
      }
      try {
        const value = await callAs(page, () => fn(...message.args));
        if (message.type === 'invoke') port.postMessage({ type: 'result', id: message.id, value } satisfies Message);
      } catch (err) {
        console.error(`Flecha shell: "${message.name}" failed`, err);
        if (message.type === 'invoke') port.postMessage({ type: 'result', id: message.id, error: String(err) } satisfies Message);
      }
    };
    port.onMessage.addListener(dispatch);
    for (const fn of connectListeners) callAs(page, () => fn(page));
    for (const m of early) void dispatch(m);
  });
}
