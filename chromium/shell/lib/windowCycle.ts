/**
 * Next window (⌘`): macOS's own cycle stops at the edge of the desktop, so a window on another
 * desktop is out of reach. Flecha walks its windows itself, in the order they were opened, and
 * focusing one brings its desktop with it.
 */

/**
 * The window after (`step` 1) or before (-1) `current` among `ids`, round and round. A
 * `current` that isn't one of them (Settings) goes to the first, or the last going back.
 * Undefined when there is no other window to go to.
 */
export function nextWindowId(ids: number[], current: number | undefined, step: 1 | -1): number | undefined {
  const order = [...new Set(ids)].sort((a, b) => a - b);
  const i = current === undefined ? -1 : order.indexOf(current);
  if (i < 0) return step === 1 ? order[0] : order[order.length - 1];
  if (order.length < 2) return undefined;
  return order[(i + step + order.length) % order.length];
}
