/**
 * Sideways scrolling over the sidebar (a two-finger trackpad swipe, a mouse's thumb wheel)
 * changes Space, one per swipe: the scroll adds up to a step, then the rest of the swipe is
 * ignored.
 *
 * A page is never told when a trackpad swipe ends. After the fingers lift, macOS keeps
 * sending momentum events, each smaller than the last, for up to a second. Waiting for the
 * events to stop meant a swipe made while the last one was still coasting was taken as part
 * of it and ignored. So a swipe that has switched also ends when the events turn the other
 * way, or when, having slowed down for a few events, they speed up again: momentum only
 * slows down, so the fingers are moving on the trackpad again.
 */
export const SPACE_SWIPE_STEP = 60;
/** A pause (ms) between events that ends a swipe. Momentum events come every frame. */
const SWIPE_GAP = 150;
/** How many events in a row must slow down before a speed-up counts as a new swipe. */
const COASTING = 3;
/** A speed-up (px/ms) smaller than this, or than half the last speed, is momentum's jitter. */
const SPEED_UP = 0.1;
/** Speed is measured over at least a frame, so two events close together don't look fast. */
const MIN_INTERVAL = 8;

export class SpaceSwipe {
  private sum = 0;
  private switched = false;
  private lastAt = -Infinity;
  private lastSpeed = 0;
  private lastSign = 0;
  private slowing = 0;

  /**
   * Takes one sideways wheel event (its deltaX and timeStamp). Returns 1 or -1 when the
   * sidebar should switch to the next or previous Space, 0 otherwise.
   */
  feed(deltaX: number, time: number): -1 | 0 | 1 {
    const interval = time - this.lastAt;
    // Speed rather than the delta: events merged while the page is busy carry a bigger
    // delta over a longer interval, the same speed.
    const speed = Math.abs(deltaX) / Math.max(interval, MIN_INTERVAL);
    const sign = Math.sign(deltaX);
    if (interval > SWIPE_GAP || (this.switched && this.isNewSwipe(speed, sign))) {
      this.sum = 0;
      this.switched = false;
      this.slowing = 0;
    } else if (speed < this.lastSpeed) this.slowing++;
    else if (speed > this.lastSpeed) this.slowing = 0;
    this.lastAt = time;
    this.lastSpeed = speed;
    if (sign) this.lastSign = sign;

    if (this.switched) return 0;
    this.sum += deltaX;
    if (Math.abs(this.sum) < SPACE_SWIPE_STEP) return 0;
    this.switched = true;
    return this.sum > 0 ? 1 : -1;
  }

  private isNewSwipe(speed: number, sign: number) {
    if (sign && this.lastSign && sign !== this.lastSign) return true;
    return this.slowing >= COASTING && speed - this.lastSpeed > Math.max(SPEED_UP, this.lastSpeed * 0.5);
  }
}
