/** The existing phone viewport and its share of a native split. */
export const PHONE_WIDTH = 393;

export function phoneSplitRatio(total: number): number {
  // Chromium clamps to 0.1–0.9. Upstream rounds to ignore subpixel noise.
  return Math.round(Math.min(0.9, Math.max(0.1, (total - PHONE_WIDTH) / total)) * 1000) / 1000;
}
