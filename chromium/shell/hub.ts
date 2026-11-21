/**
 * The background side of the shell's messaging. Every Flecha page (sidebar, Settings, …)
 * connects a port for its surface; commands are fire-and-forget, invokes get a reply, and
 * events go out to every connected page, or to the pages of one window. Feature modules
 * register their own handlers, so they never need to touch one shared switch.
 *
 * A page's window is the Chromium window it is in: its tab's window, or for a window's frame
 * page the `window` in its address (window.html?window=<id>). While a handler runs, its
 * synchronous part can ask for the calling page's window with callerWindow().
 */
import { isPortSerializationError, type Message } from './protocol';

type Handler = (...args: any[]) => unknown;

const commands = new Map<string, Handler>();
/** Each connected page, with its Chromium window if it has one. */
const ports = new Map<chrome.runtime.Port, number | undefined>();
let caller: number | undefined;
let portCalling: chrome.runtime.Port | undefined;

/** The Chromium window of the page whose command is running, read before the handler's first await. */
export const callerWindow = () => caller;
export const callerPort = () => portCalling;

/** Runs `fn` as if a page in `windowId` had sent it (a keyboard shortcut in that window, say). */
export function asWindow<T>(windowId: number | undefined, fn: () => T): T {
  const previous = caller;
  caller = windowId;
  try {
    return fn();
  } finally {
    caller = previous;
  }
}

/** The windows that have Flecha pages open, and undefined when some page has none. */
export function statePages() {
  const windows = new Map<number | undefined, chrome.runtime.Port[]>();
  for (const [port, id] of ports) {
    if (port.name !== 'flecha' && port.name !== 'flecha-sidebar' && port.name !== 'flecha-toolbar') continue;
    const list = windows.get(id);
    if (list) list.push(port);
    else windows.set(id, [port]);
  }
  return windows;
}

export const settingsOpen = () => [...ports.keys()].some(port => port.name === 'flecha-settings' || port.name === 'flecha');
export const connected = (port: chrome.runtime.Port) => ports.has(port);

function windowOf(port: chrome.runtime.Port): number | undefined {
  if (port.sender?.tab?.windowId !== undefined) return port.sender.tab.windowId;
  const id = Number(new URL(port.sender?.url ?? 'about:blank').searchParams.get('window'));
  return Number.isInteger(id) && id > 0 ? id : undefined;
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
  void Promise.resolve()
    .then(() => fn(...args))
    .catch((err) => console.error(`Flecha shell: "${name}" failed`, err));
  return true;
}

function post(port: chrome.runtime.Port, message: Message): boolean {
  if (!connected(port)) return false;
  try {
    port.postMessage(message);
    return true;
  } catch (error) {
    // Chromium reports serialization failures as ordinary errors without closing the port.
    if (error instanceof Error && isPortSerializationError(error)) {
      if (message.type === 'result' && message.error === undefined) {
        post(port, { type: 'result', id: message.id, error: error.message });
      }
      return false;
    }
    ports.delete(port);
    try { port.disconnect(); } catch { /* The port may already be closed. */ }
    return false;
  }
}

export function sendTo(port: chrome.runtime.Port, name: string, ...args: unknown[]) {
  return post(port, { type: 'event', name, args });
}

export function broadcast(name: string, ...args: unknown[]) {
  const message: Message = { type: 'event', name, args };
  for (const port of ports.keys()) {
    if (name === 'settings:tabs' && port.name !== 'flecha-settings' && port.name !== 'flecha') continue;
    post(port, message);
  }
}

/** Sends an event to the pages of one window (undefined: the pages that are in none). */
export function broadcastTo(windowId: number | undefined, name: string, ...args: unknown[]) {
  const message: Message = { type: 'event', name, args };
  for (const [port, id] of ports) if (id === windowId) post(port, message);
}

/** Calls fn whenever a page connects (to send it the current state, say), with its window. */
const connectListeners: Array<(port: chrome.runtime.Port, windowId: number | undefined) => void> = [];
export function onConnect(fn: (port: chrome.runtime.Port, windowId: number | undefined) => void) {
  connectListeners.push(fn);
}

/** Starts taking connections; messages wait until `ready` (handlers registered) resolves. */
export function listen(ready: Promise<unknown>) {
  const startup = ready.then(() => true, (error) => {
    console.error('Flecha shell: background startup failed', error);
    return false;
  });
  chrome.runtime.onConnect.addListener(async (port) => {
    if (!['flecha', 'flecha-sidebar', 'flecha-toolbar', 'flecha-settings', 'flecha-page'].includes(port.name)) return;
    let connected = true;
    port.onDisconnect.addListener(() => {
      connected = false;
      ports.delete(port);
    });
    // Buffer what arrives while the background is still loading.
    const early: Message[] = [];
    const buffer = (m: Message) => { if (m.type !== 'ping') early.push(m); };
    port.onMessage.addListener(buffer);
    const started = await startup;
    port.onMessage.removeListener(buffer);
    if (!connected) return;
    const windowId = windowOf(port);
    ports.set(port, windowId);
    if (!started) {
      post(port, { type: 'startup-failed' });
      ports.delete(port);
      return;
    }
    const dispatch = async (message: Message) => {
      if (!ports.has(port)) return;
      if (message.type === 'ping') return;
      if (message.type !== 'cmd' && message.type !== 'invoke') return;
      const fn = commands.get(message.name);
      if (!fn) {
        console.warn(`Flecha shell: "${message.name}" isn't in the Chromium build yet`);
        if (message.type === 'invoke') post(port, { type: 'result', id: message.id, value: undefined });
        return;
      }
      let value: unknown;
      try {
        const previousPort = portCalling;
        let result: unknown;
        portCalling = port;
        try { result = asWindow(windowId, () => fn(...message.args)); }
        finally { portCalling = previousPort; }
        value = await result;
      } catch (err) {
        console.error(`Flecha shell: "${message.name}" failed`, err);
        if (message.type === 'invoke') post(port, { type: 'result', id: message.id, error: String(err) });
        return;
      }
      if (message.type === 'invoke') post(port, { type: 'result', id: message.id, value });
    };
    port.onMessage.addListener(dispatch);
    for (const fn of connectListeners) fn(port, windowId);
    for (const m of early) void dispatch(m);
  });
}
