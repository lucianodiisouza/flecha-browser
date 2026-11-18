/**
 * chrome.debugger, shared by the features that need the DevTools protocol on a tab (the
 * responsive phone, boost scripts on pages whose CSP forbids eval). Each feature holds the
 * tab by name and the attachment goes once nobody holds it, so tabs that don't need the
 * protocol never have it attached.
 */
const PROTOCOL = '1.3';

type Holder = string | symbol;
const holders = new Map<number, Map<Holder, symbol>>();
const attaching = new Map<number, Promise<void>>();
const detaching = new Map<number, Promise<void>>();
const resetting = new Map<symbol, Promise<void>>();
const detachListeners: Array<(tabId: number, reason: string) => void> = [];

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  holders.delete(source.tabId);
  for (const fn of detachListeners) fn(source.tabId, reason);
});

/** Called when Chromium ends an attachment: the tab closed, or the user cancelled it. */
export function onDebuggerDetach(fn: (tabId: number, reason: string) => void) {
  detachListeners.push(fn);
}

/** Shares the attachment and preserves Chromium's error for callers that explain refusals. */
export async function acquire(tabId: number, holder: Holder): Promise<void> {
  let owners = holders.get(tabId);
  const existing = owners?.get(holder);
  const cleanup = existing && resetting.get(existing);
  if (cleanup) {
    await cleanup.catch(() => undefined);
    return acquire(tabId, holder);
  }
  if (!owners) {
    const queued = new Map<Holder, symbol>();
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
  const claim = owners.get(holder) ?? Symbol();
  owners.set(holder, claim);
  await attaching.get(tabId);
  if (holders.get(tabId) !== owners || owners.get(holder) !== claim) throw new Error('Debugger attachment was released');
}

/** Resolves false when Chromium refuses to attach. */
export const hold = (tabId: number, holder: Holder): Promise<boolean> => acquire(tabId, holder).then(() => true, () => false);

/** Lets go for `holder`; detaches once no feature holds the tab. */
export async function release(tabId: number, holder: Holder, resetShared?: () => Promise<unknown>) {
  const set = holders.get(tabId);
  const claim = set?.get(holder);
  if (resetShared && set && claim && set.size > 1) {
    const pending = resetting.get(claim);
    if (pending) return pending;
    const cleanup = Promise.resolve().then(resetShared).then(() => undefined).finally(async () => {
      try {
        if (holders.get(tabId) === set && set.get(holder) === claim) await release(tabId, holder);
      } finally {
        resetting.delete(claim);
      }
    });
    resetting.set(claim, cleanup);
    return cleanup;
  }
  if (!set?.delete(holder) || set.size) return;
  const attach = attaching.get(tabId);
  if (attach) await attach.catch(() => undefined);
  if (holders.get(tabId) !== set || set.size) return;
  holders.delete(tabId);
  await detach(tabId);
}

/** Ends a stalled command's session before any holder can attach again. */
export async function resetDebugger(tabId: number, holder: Holder) {
  const set = holders.get(tabId);
  const claim = set?.get(holder);
  if (!set || !claim) return;
  const pending = attaching.get(tabId);
  if (pending) await pending.catch(() => undefined);
  if (holders.get(tabId) !== set || set.get(holder) !== claim) return;
  holders.delete(tabId);
  await detach(tabId);
  for (const fn of detachListeners) fn(tabId, 'reset');
}

async function detach(tabId: number) {
  const pending = chrome.debugger.detach({ tabId }).catch(() => undefined);
  detaching.set(tabId, pending);
  await pending;
  if (detaching.get(tabId) === pending) detaching.delete(tabId);
}

export const isHeld = (tabId: number, holder: string) => !!holders.get(tabId)?.has(holder);

export function send<T = unknown>(tabId: number, method: string, params: object = {}): Promise<T | undefined> {
  return chrome.debugger.sendCommand({ tabId }, method, params as Record<string, unknown>).then(
    (r) => r as T,
    () => undefined,
  );
}
