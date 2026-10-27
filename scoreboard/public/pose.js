// @ts-check
// Turns pose landmarks into held gestures. No camera and no timers in here, so it is unit-tested.
// Landmarks are MediaPipe Pose (33 points, normalised 0..1, y grows downwards, as the camera sees it).
//   circle: both hands joined above the head, elbows out — a big "O" over the head
//   cross:  forearms crossed in front of the chest or face — a big "X"
// Neither shape happens in normal play, and both must be held for `holdMs` before they count.

/** @typedef {{x: number, y: number, visibility?: number}} Point
 *  @typedef {'circle'|'cross'} Gesture */

export const DEFAULT_POSE = {holdMs: 1000, cooldownMs: 2500};

const I = {nose: 0, ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16};
const NEEDED = /** @type {(keyof typeof I)[]} */ (['nose', 'ls', 'rs', 'le', 're', 'lw', 'rw']);

/** Skeleton lines worth drawing for the upper body and arms. */
export const UPPER_BODY = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];

/** @param {Point[]} lm @returns {Gesture|null} */
export function classify(lm) {
  if (!lm || NEEDED.some(k => !lm[I[k]] || (lm[I[k]].visibility ?? 1) < 0.5)) return null;
  const [nose, ls, rs, le, re, lw, rw] = NEEDED.map(k => lm[I[k]]);
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y); // shoulder width: the unit for everything below
  if (sw < 0.025) return null; // too far away to judge
  const shoulderY = (ls.y + rs.y) / 2, midX = (ls.x + rs.x) / 2;
  const side = Math.sign(ls.x - rs.x) || 1; // which image direction the person's left points to
  const wristGap = Math.hypot(lw.x - rw.x, lw.y - rw.y);

  // X: each wrist well past the midline on the other side, hands between hip and just above the head.
  const lPast = (midX - lw.x) * side, rPast = (rw.x - midX) * side;
  const handsMid = [lw, rw].every(w => w.y < shoulderY + 1.6 * sw && w.y > nose.y - 1.4 * sw);
  if (lPast > 0.12 * sw && rPast > 0.12 * sw && handsMid) return 'cross';

  // O: both hands above the head and close together, elbows above the shoulders and out wide.
  const handsUp = lw.y < nose.y - 0.35 * sw && rw.y < nose.y - 0.35 * sw;
  const elbowsUpOut = le.y < shoulderY && re.y < shoulderY && Math.abs(le.x - re.x) > 1.15 * sw;
  if (handsUp && elbowsUpOut && wristGap < 0.9 * sw) return 'circle';
  return null;
}

/** Horizontal centre of the shoulders, 0..1 as the camera sees it. @param {Point[]} lm */
export function torsoX(lm) { return (lm[I.ls].x + lm[I.rs].x) / 2; }

/**
 * Fires a gesture once it has been held long enough by any one of the people in view.
 * Short dropouts (a missed frame) do not reset the hold. After firing, nothing fires again
 * until that gesture is let go and the cooldown has passed.
 */
export class GestureHold {
  /** @param {{holdMs: number, cooldownMs: number}} opts */
  constructor(opts) {
    this.opts = opts;
    /** @type {Gesture|null} */ this.current = null;
    this.since = 0;
    this.lastSeen = -Infinity;
    /** @type {Gesture|null} */ this.fired = null;
    this.firedAt = -Infinity;
  }

  /** @param {(Gesture|null)[]} gestures one per detected person @param {number} now ms
   *  @returns {{gesture: Gesture|null, progress: number, fire: Gesture|null}} */
  update(gestures, now) {
    const seen = gestures.filter(g => g !== null);
    if (this.fired && !seen.includes(this.fired) && now - this.lastSeen > 250) this.fired = null; // let go
    const g = this.current && seen.includes(this.current) ? this.current : seen[0] ?? null;
    if (g) {
      if (g !== this.current || now - this.lastSeen > 300) { this.current = g; this.since = now; }
      this.lastSeen = now;
    } else if (now - this.lastSeen > 300) {
      this.current = null;
    }
    const cur = this.current;
    if (!cur || this.fired === cur || now - this.firedAt < this.opts.cooldownMs) return {gesture: cur, progress: 0, fire: null};
    const progress = Math.min(1, (now - this.since) / this.opts.holdMs);
    if (progress < 1) return {gesture: cur, progress, fire: null};
    this.fired = cur; this.firedAt = now;
    return {gesture: cur, progress: 1, fire: cur};
  }

  reset() { this.current = null; this.fired = null; this.lastSeen = -Infinity; }
}
