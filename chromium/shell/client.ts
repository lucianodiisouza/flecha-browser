/**
 * The page side of the shell's messaging: what a Flecha page uses in place of Electron's
 * ipcRenderer. cmd() fires a command, invoke() awaits a reply, on() listens for events.
 */
import type { Message } from './protocol';

type Reply = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Connection = { port: chrome.runtime.Port; replies: Map<number, Reply>; openedAt: number };
const listeners = new Map<string, Array<(...args: any[]) => void>>();
let nextId = 1;
let current: Connection | undefined;
let retryDelay = 0;
// Use upstream's backoff when the service worker repeatedly drops the connection.
const STABLE_MS = 10_000;
const RETRY_MAX_MS = 5_000;

function scheduleRetry(wasStable = false) {
  retryDelay = wasStable ? 0 : Math.min(Math.max(retryDelay * 2, 100), RETRY_MAX_MS);
  setTimeout(connect, retryDelay);
}

function disconnected(connection: Connection) {
  if (current !== connection) return;
  current = undefined;
  for (const reply of connection.replies.values()) reply.reject(new Error('Flecha’s background restarted'));
  connection.replies.clear();
  scheduleRetry(Date.now() - connection.openedAt >= STABLE_MS);
}

function connect() {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: 'flecha' });
  } catch {
    scheduleRetry();
    return;
  }
  const connection: Connection = { port, replies: new Map(), openedAt: Date.now() };
  current = connection;
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    disconnected(connection);
  });
  port.onMessage.addListener((message: Message) => {
    if (current !== connection) return;
    if (message.type === 'result') {
      const reply = connection.replies.get(message.id);
      connection.replies.delete(message.id);
      if (message.error) reply?.reject(new Error(message.error));
      else reply?.resolve(message.value);
    } else if (message.type === 'event') {
      for (const fn of listeners.get(message.name) ?? []) fn(...message.args);
    }
  });
}

function post(message: Message, reply?: Reply) {
  const connection = current;
  if (!connection) {
    reply?.reject(new Error('Flecha’s background can’t be reached'));
    return;
  }
  if (message.type === 'invoke' && reply) connection.replies.set(message.id, reply);
  try {
    connection.port.postMessage(message);
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    // GinPort also throws for serialization failures, which leave the port usable.
    if (reason.message === 'Attempting to use a disconnected port object' || reason.message === 'Extension context invalidated.') {
      disconnected(connection);
      try {
        connection.port.disconnect();
      } catch {
        // The extension context may already be gone.
      }
    } else {
      if (message.type === 'invoke') connection.replies.delete(message.id);
      reply?.reject(reason);
    }
  }
}

connect();
setInterval(() => post({ type: 'ping' }), 20_000);

export const cmd =
  (name: string) =>
  (...args: unknown[]) =>
    post({ type: 'cmd', name, args });

export function invoke<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => post({ type: 'invoke', id, name, args }, { resolve: resolve as (value: unknown) => void, reject }));
}

export function on(name: string, fn: (...args: any[]) => void) {
  listeners.set(name, [...(listeners.get(name) ?? []), fn]);
}
