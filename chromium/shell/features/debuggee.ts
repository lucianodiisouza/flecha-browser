/**
 * chrome.debugger, shared by the features that need the DevTools protocol on a tab (the
 * responsive phone, boost scripts on pages whose CSP forbids eval). Each feature holds the
 * tab by name and the attachment goes once nobody holds it, so tabs that don't need the
 * protocol never have it attached.
 */
const PROTOCOL = '1.3';

const holders = new Map<number, Map<string, symbol>>();
const attaching = new Map<number, Promise<void>>();
const detaching = new Map<number, Promise<void>>();
const detachListeners: Array<(tabId: number, reason: string) => void> = [];

chrome.debugger.onDetach.addListener((source, reason) => {
  // During a release Chromium can report detachment of the old session before its reply.
  if (source.tabId === undefined || detaching.has(source.tabId)) return;
  holders.delete(source.tabId);
  for (const fn of detachListeners) fn(source.tabId, reason);
});

/** Called when Chromium ends an attachment: the tab closed, or the user cancelled it. */
export function onDebuggerDetach(fn: (tabId: number, reason: string) => void) {
  detachListeners.push(fn);
}

/** Shares the attachment and preserves Chromium's error for callers that explain refusals. */
export async function acquire(tabId: number, holder: string): Promise<void> {
  let owners = holders.get(tabId);
  if (!owners) {
    const queued = new Map<string, symbol>();
    holders.set(tabId, queued);
    owners = queued;
    const attach = (detaching.get(tabId) ?? Promise.resolve())
      .then(() => {
        if (holders.get(tabId) !== queued) return;
        if (!queued.size) {
          holders.delete(tabId);
          return;
        }
        return chrome.debugger.attach({ tabId }, PROTOCOL).catch((err: Error) => {
          // Attached already by a previous background that went to sleep.
          if (!/already attached/i.test(String(err?.message ?? err))) throw err;
        });
      })
      .catch((err: unknown) => {
        if (holders.get(tabId) === queued) holders.delete(tabId);
        throw err;
      })
      .finally(() => {
        if (attaching.get(tabId) === attach) attaching.delete(tabId);
      });
    attaching.set(tabId, attach);
  }
  const claim = owners.get(holder) ?? Symbol(holder);
  owners.set(holder, claim);
  await attaching.get(tabId);
  if (holders.get(tabId) !== owners || owners.get(holder) !== claim) throw new Error('Debugger attachment was released');
}

/** Resolves false when Chromium refuses to attach. */
export const hold = (tabId: number, holder: string): Promise<boolean> => acquire(tabId, holder).then(() => true, () => false);

/** Lets go for `holder`; detaches once no feature holds the tab. */
export async function release(tabId: number, holder: string) {
  const set = holders.get(tabId);
  if (!set?.delete(holder) || set.size) return;
  const attach = attaching.get(tabId);
  if (attach) await attach.catch(() => undefined);
  if (holders.get(tabId) !== set || set.size) return;
  holders.delete(tabId);
  const detach = chrome.debugger.detach({ tabId }).catch(() => undefined);
  detaching.set(tabId, detach);
  await detach;
  detaching.delete(tabId);
}

export const isHeld = (tabId: number, holder: string) => !!holders.get(tabId)?.has(holder);

export function send<T = unknown>(tabId: number, method: string, params: object = {}): Promise<T | undefined> {
  return chrome.debugger.sendCommand({ tabId }, method, params as Record<string, unknown>).then(
    (r) => r as T,
    () => undefined,
  );
}
