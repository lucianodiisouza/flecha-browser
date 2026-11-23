/**
 * Recent tab: a walk back through a Space's tabs in the order they were last used, the way
 * ⌃⇥ walks them in sidebar order. Each press within WALK_MS of the last goes one tab further
 * back; a pause ends the walk, and the next press starts again from the tab before this one.
 */
export const WALK_MS = 1000;

export interface RecentWalk {
  spaceId: string;
  /** The Space's tabs when the walk began, most recently used first; the first is where it began. */
  ids: string[];
  index: number;
  /** When each tab was last used before the walk went through it. */
  lastActive: Record<string, number>;
  /** When the walk's last step was taken. */
  at: number;
}

export interface RecentStep {
  walk: RecentWalk;
  /** The tab to show. */
  tabId: string;
  /** The tab the walk only passed through, and the time to give it back: it wasn't used. */
  passed?: { tabId: string; lastActive: number };
}

/**
 * The next step: `tabs` are the Space's tab ids with their last use, `activeTabId` the tab
 * showing, `walk` the walk so far. Null when there is no other tab to go to.
 */
export function stepRecent(
  walk: RecentWalk | undefined,
  spaceId: string,
  tabs: Array<{ id: string; lastActive: number }>,
  activeTabId: string | undefined,
  now: number,
): RecentStep | null {
  const live = new Set(tabs.map((t) => t.id));
  const going =
    walk && walk.spaceId === spaceId && now - walk.at < WALK_MS && walk.ids[walk.index] === activeTabId && walk.ids.every((id) => live.has(id))
      ? walk
      : undefined;
  let next: RecentWalk;
  if (going) {
    next = { ...going, at: now };
  } else {
    const ordered = [...tabs].sort((a, b) => b.lastActive - a.lastActive);
    // The tab showing is where the walk begins, whatever its time says.
    const ids = [...ordered.filter((t) => t.id === activeTabId), ...ordered.filter((t) => t.id !== activeTabId)].map((t) => t.id);
    next = { spaceId, ids, index: activeTabId && live.has(activeTabId) ? 0 : -1, lastActive: Object.fromEntries(tabs.map((t) => [t.id, t.lastActive])), at: now };
  }
  const count = next.ids.length;
  if (count === 0 || (count === 1 && next.index === 0)) return null;
  const from = next.index;
  next.index = from < 0 ? 0 : (from + 1) % count;
  const tabId = next.ids[next.index];
  // Where the walk began was in use; the tabs between were only on the way.
  const passed = going && from > 0 ? { tabId: next.ids[from], lastActive: next.lastActive[next.ids[from]] } : undefined;
  return { walk: next, tabId, passed };
}
