/**
 * Next window (⌘`, lib/windowCycle.ts) over every Flecha window: main windows and Flechinhas,
 * regular and incognito, on any desktop.
 *
 * Incognito windows belong to the other copy of the shell (incognito.ts), and neither copy can
 * see or focus the other's windows. So each copy keeps a list of its windows in
 * chrome.storage.session, which they share, and a copy whose next window is the other's hands
 * the step over there.
 */
import { incognito, sessionKey } from './incognito';
import { nextWindowId } from './lib/windowCycle';

const WINDOWS_KEY = 'cycleWindows';
const OWN_KEY = sessionKey(WINDOWS_KEY);
const OTHER_KEY = incognito ? WINDOWS_KEY : `incognito:${WINDOWS_KEY}`;
const HANDOFF_KEY = 'cycleWindowTo';
/** A handoff nobody took in this long had nobody to take it: the last incognito window closed. */
const HANDOFF_MS = 1000;

interface Handoff {
  id: number;
  step: 1 | -1;
  at: number;
}

const focus = (id: number) => chrome.windows.update(id, { focused: true });

/**
 * Goes to the window after (`step` 1) or before (-1) `from`, the window the keys were pressed
 * in (default: the one in front). Minimized windows are left alone, as macOS leaves them.
 */
export async function cycleWindow(step: 1 | -1, from?: number) {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const current = from ?? windows.find((w) => w.focused)?.id;
  const own = windows.flatMap((w) => (w.id !== undefined && (w.state !== 'minimized' || w.id === current) ? [w.id] : []));
  const other = ((await chrome.storage.session.get(OTHER_KEY))[OTHER_KEY] as number[] | undefined) ?? [];
  const next = nextWindowId([...own, ...other], current, step);
  if (next === undefined) return;
  if (own.includes(next)) return void (await focus(next));

  const handoff: Handoff = { id: next, step, at: Date.now() };
  await chrome.storage.session.set({ [HANDOFF_KEY]: handoff });
  setTimeout(async () => {
    const left = (await chrome.storage.session.get(HANDOFF_KEY))[HANDOFF_KEY] as Handoff | undefined;
    if (left?.at !== handoff.at) return;
    // The other copy is gone, and its list with it; it writes a new one when it is back.
    await chrome.storage.session.remove([HANDOFF_KEY, OTHER_KEY]);
    const mine = nextWindowId(own, current, step);
    if (mine !== undefined) await focus(mine);
  }, HANDOFF_MS);
}

/** The other copy's step lands on one of this copy's windows. */
async function take(handoff: Handoff) {
  const window = await chrome.windows.get(handoff.id).catch(() => undefined);
  if (!window) return;
  await chrome.storage.session.remove(HANDOFF_KEY);
  if (window.state === 'minimized') return cycleWindow(handoff.step, handoff.id);
  await focus(handoff.id);
}

function publish() {
  chrome.windows
    .getAll({ windowTypes: ['normal'] })
    .then((windows) => chrome.storage.session.set({ [OWN_KEY]: windows.flatMap((w) => (w.id !== undefined ? [w.id] : [])) }))
    // The last window closing as the browser quits: there is nobody left to tell.
    .catch(() => {});
}

// On the module's first turn, so that these also wake a sleeping background.
chrome.storage.session.onChanged.addListener((changes) => {
  const handoff = changes[HANDOFF_KEY]?.newValue as Handoff | undefined;
  if (handoff) void take(handoff);
});
chrome.windows.onCreated.addListener(publish);
chrome.windows.onRemoved.addListener(publish);
// Also when a window comes to the front: the list is back after the other copy dropped it.
chrome.windows.onFocusChanged.addListener(publish);
publish();
