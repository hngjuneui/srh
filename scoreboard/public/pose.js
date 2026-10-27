// @ts-check
// Turns pose landmarks into held gestures. No camera and no timers in here, so it is unit-tested.
// Landmarks are MediaPipe Pose (33 points, normalised 0..1, y grows downwards, as the camera sees it).
//   circle: both hands joined above the head, elbows out — a big "O" over the head      → camera team +1
//   head:   one hand on top of the head, the other hand down ("아쉬움")              → other team +1
//   cross:  forearms crossed in front of the chest, face or overhead — a big "X"       → other team +1
//   tee:    both arms straight out to the sides at shoulder height — a "T" ("Time!")  → undo the last input
// None of these happen in normal play, and all must be held for `holdMs` before they count.

/** @typedef {{x: number, y: number, visibility?: number}} Point
 *  @typedef {'circle'|'head'|'cross'|'tee'} Gesture */

export const DEFAULT_POSE = {holdMs: 1000, cooldownMs: 2500};

const I = {nose: 0, ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16, lh: 23, rh: 24};
const CORE = /** @type {(keyof typeof I)[]} */ (['nose', 'ls', 'rs']);
const ARMS = /** @type {(keyof typeof I)[]} */ (['le', 're', 'lw', 'rw']);

/** Skeleton lines worth drawing for the upper body and arms. */
export const UPPER_BODY = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];

const seen = (/** @type {Point|undefined} */ p, /** @type {number} */ min) => Boolean(p) && (/** @type {Point} */ (p).visibility ?? 1) >= min;

/** Where segments ab and cd cross, or null. @param {Point} a @param {Point} b @param {Point} c @param {Point} d */
function crossing(a, b, c, d) {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? {x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y)} : null;
}

/** @param {Point[]} lm @returns {Gesture|null} */
export function classify(lm) {
  // Crossed or raised arms often hide a wrist behind the other arm, so arms only need to be half-seen.
  if (!lm || CORE.some(k => !seen(lm[I[k]], 0.5)) || ARMS.some(k => !seen(lm[I[k]], 0.3))) return null;
  const [nose, ls, rs, le, re, lw, rw] = [...CORE, ...ARMS].map(k => lm[I[k]]);
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y); // shoulder width: the unit for everything below
  if (sw < 0.025) return null; // too far away to judge
  const shoulderY = (ls.y + rs.y) / 2, midX = (ls.x + rs.x) / 2;
  const side = Math.sign(ls.x - rs.x) || 1; // which image direction the person's left points to
  const out = (/** @type {Point} */ p) => (p.x - midX) * side; // + toward the person's left
  const wristGap = Math.hypot(lw.x - rw.x, lw.y - rw.y);

  // O: both hands above the head and close together, elbows above the shoulders and out wide.
  const lUp = lw.y < nose.y - 0.35 * sw, rUp = rw.y < nose.y - 0.35 * sw;
  const elbowsUpOut = le.y < shoulderY && re.y < shoulderY && Math.abs(le.x - re.x) > 1.15 * sw;
  if (lUp && rUp && elbowsUpOut && wristGap < 0.9 * sw) return 'circle';

  // Head: one hand on the forehead or the top of the head, the other hanging down.
  // The hand may rest on the forehead or on top of the head; the elbow comes up to around shoulder height.
  const onHead = (/** @type {Point} */ w, /** @type {Point} */ e) => w.y < nose.y + 0.15 * sw && w.y > nose.y - 1.3 * sw && Math.abs(w.x - nose.x) < 0.9 * sw && e.y < shoulderY + 0.6 * sw;
  const down = (/** @type {Point} */ w) => w.y > shoulderY + 0.9 * sw;
  if ((onHead(lw, le) && down(rw)) || (onHead(rw, re) && down(lw))) return 'head';

  // T: arms level with the shoulders and straight, wrists far apart.
  const level = [le, re, lw, rw].every(p => Math.abs(p.y - shoulderY) < 0.5 * sw);
  const straight = out(lw) > out(le) && out(le) > out(ls) && -out(rw) > -out(re) && -out(re) > -out(rs);
  if (level && straight && Math.abs(lw.x - rw.x) > 2.2 * sw) return 'tee';

  // X: the forearms cross somewhere between the hips and well above the head,
  // or (if a forearm is hidden) each wrist is well past the middle on the other side.
  const meet = crossing(le, lw, re, rw);
  const band = (/** @type {number} */ y) => y < shoulderY + 1.6 * sw && y > nose.y - 1.8 * sw;
  if (meet && band(meet.y) && Math.abs(meet.x - midX) < 1.2 * sw) return 'cross';
  if (-out(lw) > 0.12 * sw && out(rw) > 0.12 * sw && band(lw.y) && band(rw.y)) return 'cross';
  return null;
}

/** Horizontal centre of the shoulders, 0..1 as the camera sees it. @param {Point[]} lm */
export function torsoX(lm) { return (lm[I.ls].x + lm[I.rs].x) / 2; }

/** Body size in the frame: shoulder width, or a share of the torso when turned sideways. Smaller = farther away.
 *  @param {Point[]} lm */
export function bodyScale(lm) {
  const ls = lm[I.ls], rs = lm[I.rs], lh = lm[I.lh], rh = lm[I.rh];
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (!seen(lh, 0.5) || !seen(rh, 0.5)) return sw;
  const torso = Math.hypot((ls.x + rs.x - lh.x - rh.x) / 2, (ls.y + rs.y - lh.y - rh.y) / 2);
  return Math.max(sw, torso * 0.6);
}

/**
 * Keeps the people near enough to be on our court. With a calibrated size (from the test) anyone under
 * 55% of it is taken to be much farther away, e.g. on the next court; without one, anyone under 55% of
 * the biggest person in view, and anyone tiny.
 * @param {Point[][]} people @param {number|null} ref
 */
export function nearPeople(people, ref) {
  const sizes = people.map(bodyScale);
  const floor = ref ? 0.55 * ref : Math.max(0.03, 0.55 * Math.max(0, ...sizes));
  return people.filter((_, i) => sizes[i] >= floor);
}

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
