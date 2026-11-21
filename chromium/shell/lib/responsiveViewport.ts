/** The existing phone viewport and its share of a native split. */
export const PHONE_WIDTH = 393;

export function phoneSplitRatio(total: number): number {
  return Math.max(0.1, (total - PHONE_WIDTH) / total);
}
