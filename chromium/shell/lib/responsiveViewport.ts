/** The existing phone viewport and its share of a native split. */
export const PHONE_WIDTH = 393;

export function phoneSplitRatio(total: number): number {
  // Chromium clamps to 0.1–0.9.
  return Math.min(0.9, Math.max(0.1, (total - PHONE_WIDTH) / total));
}
