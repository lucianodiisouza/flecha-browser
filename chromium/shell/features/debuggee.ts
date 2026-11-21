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
type AttachmentReset = { done: Promise<void>; confirmDetach(): void; canceled?: boolean };
const attachmentResets = new Map<number, AttachmentReset>();
type SharedReset = { done: Promise<void>; canceled?: boolean };
const resetting = new Map<number, Map<symbol, SharedReset>>();
const detachListeners: Array<(tabId: number, reason: string) => void> = [];

function retireAttachment(tabId: number) {
  for (const reset of resetting.get(tabId)?.values() ?? []) reset.canceled = true;
  holders.delete(tabId);
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  const reset = attachmentResets.get(source.tabId);
  if (reset) {
    reset.canceled = true;
    reset.confirmDetach();
  }
  retireAttachment(source.tabId);
  for (const fn of detachListeners) fn(source.tabId, reason);
});

/** Called when Chromium ends an attachment: the tab closed, or the user cancelled it. */
export function onDebuggerDetach(fn: (tabId: number, reason: string) => void) {
  detachListeners.push(fn);
}

/** Shares the attachment and preserves Chromium's error for callers that explain refusals. */
export async function acquire(tabId: number, holder: Holder): Promise<void> {
  const reset = attachmentResets.get(tabId);
  if (reset) {
    await reset.done;
    if (reset.canceled) throw new Error('Debugger attachment was released');
    return acquire(tabId, holder);
  }
  let owners = holders.get(tabId);
  const existing = owners?.get(holder);
  const cleanup = existing && resetting.get(tabId)?.get(existing);
  if (cleanup) {
    await cleanup.done.catch(() => undefined);
    if (cleanup.canceled) throw new Error('Debugger attachment was released');
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
    const tabResets = resetting.get(tabId) ?? new Map<symbol, SharedReset>();
    const pending = tabResets.get(claim);
    if (pending) return pending.done;
    const cleanup = Promise.resolve().then(async () => {
      const attachment = attaching.get(tabId);
      if (attachment) await attachment.catch(() => undefined);
      const reset = attachmentResets.get(tabId);
      if (reset) await reset.done.catch(() => undefined);
      if (holders.get(tabId) === set && set.get(holder) === claim) await resetShared();
    }).finally(async () => {
      try {
        if (holders.get(tabId) === set && set.get(holder) === claim) await release(tabId, holder);
      } finally {
        tabResets.delete(claim);
        if (!tabResets.size) resetting.delete(tabId);
      }
    });
    tabResets.set(claim, { done: cleanup });
    resetting.set(tabId, tabResets);
    return cleanup;
  }
  if (!set?.delete(holder) || set.size) return;
  const reset = attachmentResets.get(tabId);
  if (reset) await reset.done.catch(() => undefined);
  const attach = attaching.get(tabId);
  if (attach) await attach.catch(() => undefined);
  if (holders.get(tabId) !== set || set.size) return;
  holders.delete(tabId);
  await detach(tabId);
}

/** Captures the session a stalled command used, so a retry cannot detach its replacement. */
export function captureDebuggerReset(tabId: number, holder: Holder): () => Promise<void> {
  const owners = holders.get(tabId);
  if (!owners?.has(holder)) return async () => {};
  return () => resetAttachment(tabId, owners);
}

async function resetAttachment(tabId: number, set: Map<Holder, symbol>) {
  if (holders.get(tabId) !== set) return;
  const inProgress = attachmentResets.get(tabId);
  if (inProgress) return inProgress.done;
  const pending = attaching.get(tabId);
  if (pending) await pending.catch(() => undefined);
  if (holders.get(tabId) !== set) return;
  const existing = attachmentResets.get(tabId);
  if (existing) return existing.done;
  for (const cleanup of resetting.get(tabId)?.values() ?? []) cleanup.canceled = true;
  let confirmDetach!: () => void;
  const confirmation = new Promise<void>((resolve) => { confirmDetach = resolve; });
  const detach = Promise.resolve().then(async () => {
    if (holders.get(tabId) !== set) return;
    try {
      await chrome.debugger.detach({ tabId });
    } catch (error) {
      if (holders.get(tabId) === set) throw error;
      return;
    }
    if (holders.get(tabId) !== set) return;
    retireAttachment(tabId);
    for (const fn of detachListeners) fn(tabId, 'reset');
  });
  const reset: AttachmentReset = {
    confirmDetach,
    done: Promise.race([detach, confirmation]).finally(() => {
      if (attachmentResets.get(tabId) === reset) attachmentResets.delete(tabId);
    }),
  };
  attachmentResets.set(tabId, reset);
  await reset.done;
}

async function detach(tabId: number) {
  const pending = chrome.debugger.detach({ tabId }).catch(() => undefined);
  detaching.set(tabId, pending);
  try {
    await pending;
  } finally {
    if (detaching.get(tabId) === pending) detaching.delete(tabId);
  }
}

export const isHeld = (tabId: number, holder: string) => !!holders.get(tabId)?.has(holder);

export function send<T = unknown>(tabId: number, method: string, params: object = {}): Promise<T | undefined> {
  return chrome.debugger.sendCommand({ tabId }, method, params as Record<string, unknown>).then(
    (r) => r as T,
    () => undefined,
  );
}
