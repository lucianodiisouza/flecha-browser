/**
 * The page side of the shell's messaging: what a Flecha page uses in place of Electron's
 * ipcRenderer. cmd() fires a command, invoke() awaits a reply, on() listens for events.
 */
import type { Message } from './protocol';

// Only the sidebar and new-tab surfaces consume the tab collection.
const page = location.pathname;
const port = chrome.runtime.connect({ name: document.documentElement.dataset.surface && page !== '/flechinha.html'
  ? 'flecha-sidebar' : page === '/flechinha.html' ? 'flecha-toolbar' : page === '/settings.html' ? 'flecha-settings' : 'flecha-page' });
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Array<(...args: any[]) => void>>();
let nextId = 1;

port.onMessage.addListener((message: Message) => {
  if (message.type === 'result') {
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call?.reject(new Error(message.error));
    else call?.resolve(message.value);
  } else if (message.type === 'event') {
    for (const fn of listeners.get(message.name) ?? []) fn(...message.args);
  }
});
setInterval(() => port.postMessage({ type: 'ping' } satisfies Message), 20_000);

export const cmd =
  (name: string) =>
  (...args: unknown[]) =>
    port.postMessage({ type: 'cmd', name, args } satisfies Message);

export function invoke<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  const id = nextId++;
  port.postMessage({ type: 'invoke', id, name, args } satisfies Message);
  return new Promise((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
}

export function on(name: string, fn: (...args: any[]) => void) {
  listeners.set(name, [...(listeners.get(name) ?? []), fn]);
}
