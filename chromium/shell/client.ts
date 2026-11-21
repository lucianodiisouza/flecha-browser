/**
 * The page side of the shell's messaging: what a Flecha page uses in place of Electron's
 * ipcRenderer. cmd() fires a command, invoke() awaits a reply, on() listens for events.
 */
import { ConnectionError, type Message } from './protocol';
import { toast } from './settingsUi';

type Reply = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Connection = { port: chrome.runtime.Port; replies: Map<number, Reply>; openedAt: number };
export function portForPage(path: string, surface: string | undefined): string {
  if (path === '/flechinha.html') return 'flecha-toolbar';
  // The window, side panel and new-tab surfaces consume the tab collection.
  if (surface) return 'flecha-sidebar';
  if (path === '/settings.html') return 'flecha-settings';
  return 'flecha-page';
}

const listeners = new Map<string, Array<(...args: any[]) => void>>();
const reconnectListeners = new Set<() => void>();
let nextId = 1;
let current: Connection | undefined;
let retryDelay = 0;
let invalidated = false;
let startupFailure: string | undefined;
const heartbeat = setInterval(() => post({ type: 'ping' }), 20_000);
const contextInvalidated = (message?: string) => message === 'Extension context invalidated.';
// Use upstream's backoff when the service worker repeatedly drops the connection.
const STABLE_MS = 10_000;
const RETRY_MAX_MS = 5_000;

function scheduleRetry(wasStable = false) {
  retryDelay = wasStable ? 0 : Math.min(Math.max(retryDelay * 2, 100), RETRY_MAX_MS);
  setTimeout(connect, retryDelay);
}

function stop() {
  invalidated = true;
  clearInterval(heartbeat);
}

function disconnected(connection: Connection, terminal = false) {
  if (current !== connection) return;
  current = undefined;
  for (const reply of connection.replies.values()) {
    reply.reject(new ConnectionError(!startupFailure, startupFailure ?? 'Flecha’s background restarted'));
  }
  connection.replies.clear();
  if (terminal) stop();
  else scheduleRetry(Date.now() - connection.openedAt >= STABLE_MS);
}

function connect() {
  if (typeof chrome.runtime?.connect !== 'function') return stop();
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: portForPage(location.pathname, document.documentElement.dataset.surface) });
  } catch (error) {
    if (error instanceof Error && contextInvalidated(error.message)) stop();
    else scheduleRetry();
    return;
  }
  const connection: Connection = { port, replies: new Map(), openedAt: Date.now() };
  current = connection;
  port.onDisconnect.addListener(() => {
    disconnected(connection, contextInvalidated(chrome.runtime?.lastError?.message));
  });
  port.onMessage.addListener((message: Message) => {
    if (current !== connection) return;
    if (message.type === 'startup-failed') {
      startupFailure = 'Flecha’s background couldn’t start. Restart Flecha and try again.';
      disconnected(connection, true);
      port.disconnect();
      toast(startupFailure);
    } else if (message.type === 'result') {
      const reply = connection.replies.get(message.id);
      connection.replies.delete(message.id);
      if (message.error) reply?.reject(new Error(message.error));
      else reply?.resolve(message.value);
    } else if (message.type === 'event') {
      for (const fn of listeners.get(message.name) ?? []) fn(...message.args);
    }
  });
  for (const cb of reconnectListeners) cb();
}

function post(message: Message, reply?: Reply) {
  const connection = current;
  if (!connection) {
    reply?.reject(new ConnectionError(false, startupFailure ?? 'Flecha’s background can’t be reached'));
    return false;
  }
  if (message.type === 'invoke' && reply) connection.replies.set(message.id, reply);
  try {
    connection.port.postMessage(message);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    // GinPort also throws for serialization failures, which leave the port usable.
    const terminal = contextInvalidated(reason.message);
    if (terminal || reason.message === 'Attempting to use a disconnected port object') {
      if (message.type === 'invoke' && reply) {
        connection.replies.delete(message.id);
        reply.reject(new ConnectionError(false, reason.message));
      }
      disconnected(connection, terminal);
      try {
        connection.port.disconnect();
      } catch {
        // The extension context may already be gone.
      }
    } else {
      if (message.type === 'invoke') connection.replies.delete(message.id);
      reply?.reject(reason);
    }
    return false;
  }
}

connect();

/** A new connection can refresh reads. Mutations may already have run before a port closed. */
export function onReconnect(listener: () => void) {
  reconnectListeners.add(listener);
}

export const cmd =
  (name: string) =>
  (...args: unknown[]) => {
    const sent = post({ type: 'cmd', name, args });
    if (!sent) toast(startupFailure ?? (invalidated ? 'Flecha didn’t send this command. Reload this page.' : 'Flecha didn’t send this command. Try again.'));
    return sent;
  };

export function invoke<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => post({ type: 'invoke', id, name, args }, { resolve: resolve as (value: unknown) => void, reject }));
}

export function on(name: string, fn: (...args: any[]) => void) {
  listeners.set(name, [...(listeners.get(name) ?? []), fn]);
}
