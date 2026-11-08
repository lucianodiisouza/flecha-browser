/**
 * The page side of the shell's messaging: what a Flecha page uses in place of Electron's
 * ipcRenderer. cmd() fires a command, invoke() awaits a reply, on() listens for events.
 *
 * The background is an MV3 service worker, and Chromium stops it when it thinks it is idle
 * (after a Mac sleeps, say, or when it restarts the worker). Its port goes with it, so the
 * page connects again: at once, so events keep coming (the background sends the current
 * state to every page that connects), and before sending, if the port is already gone.
 */
import type { Message } from './protocol';

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Array<(...args: any[]) => void>>();
let nextId = 1;

let port: chrome.runtime.Port | undefined;
let connectedAt = 0;
/** How long to wait before connecting again; grows while the background keeps dropping the port. */
let retryDelay = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** A port that lasts this long is a healthy one: the next drop reconnects at once. */
const STABLE_MS = 10_000;
const RETRY_MAX = 5_000;

function receive(message: Message) {
  if (message.type === 'result') {
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call?.reject(new Error(message.error));
    else call?.resolve(message.value);
  } else if (message.type === 'event') {
    for (const fn of listeners.get(message.name) ?? []) fn(...message.args);
  }
}

/** The open port, connecting first if there is none; undefined once this page's extension is gone (reloaded, say). */
function connect(): chrome.runtime.Port | undefined {
  if (port) return port;
  clearTimeout(retryTimer);
  let p: chrome.runtime.Port;
  try {
    p = chrome.runtime.connect({ name: 'flecha' });
  } catch (err) {
    console.warn('Flecha shell: could not reach the background', err);
    return undefined;
  }
  port = p;
  connectedAt = Date.now();
  p.onMessage.addListener(receive);
  p.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port !== p) return;
    port = undefined;
    // Their replies went with the old background; waiting would hang whoever asked.
    for (const call of pending.values()) call.reject(new Error('Flecha’s background restarted'));
    pending.clear();
    retryDelay = Date.now() - connectedAt >= STABLE_MS ? 0 : Math.min(Math.max(retryDelay * 2, 100), RETRY_MAX);
    retryTimer = setTimeout(connect, retryDelay);
  });
  return p;
}

/** Sends on the port, connecting again if it turns out to be dead; false if the background can't be reached. */
function post(message: Message): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = connect();
    if (!p) return false;
    try {
      p.postMessage(message);
      return true;
    } catch {
      // Disconnected, and onDisconnect hasn't run yet: drop it and try a new one.
      if (port === p) port = undefined;
    }
  }
  return false;
}

connect();
setInterval(() => post({ type: 'ping' }), 20_000);

export const cmd =
  (name: string) =>
  (...args: unknown[]) =>
    void post({ type: 'cmd', name, args });

export function invoke<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    if (!post({ type: 'invoke', id, name, args })) {
      pending.delete(id);
      reject(new Error('Flecha’s background can’t be reached'));
    }
  });
}

export function on(name: string, fn: (...args: any[]) => void) {
  listeners.set(name, [...(listeners.get(name) ?? []), fn]);
}
