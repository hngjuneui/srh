import test from 'node:test';
import assert from 'node:assert/strict';
import {classify, torsoX, bodyScale, nearPeople, GestureHold} from '../public/pose.js';

// A person facing the camera: their left shoulder shows on the image's right. Shoulder width 0.1.
function person({lw, rw, le = [0.6, 0.65], re = [0.4, 0.65], vis = 1}) {
  const lm = Array.from({length: 33}, () => ({x: 0.5, y: 0.9, visibility: vis}));
  const set = (i, [x, y]) => { lm[i] = {x, y, visibility: vis}; };
  set(0, [0.5, 0.38]); set(11, [0.55, 0.5]); set(12, [0.45, 0.5]);
  set(13, le); set(14, re); set(15, lw); set(16, rw);
  return lm;
}
const O = person({lw: [0.52, 0.22], rw: [0.48, 0.22], le: [0.62, 0.36], re: [0.38, 0.36]});
const X = person({lw: [0.42, 0.45], rw: [0.58, 0.45], le: [0.6, 0.6], re: [0.4, 0.6]});
const REST = person({lw: [0.58, 0.8], rw: [0.42, 0.8]});
const SMASH = person({lw: [0.6, 0.2], rw: [0.4, 0.62], le: [0.6, 0.35]});
const READY = person({lw: [0.62, 0.55], rw: [0.38, 0.55], le: [0.62, 0.6], re: [0.38, 0.6]});

test('pose: O over the head', () => assert.equal(classify(O), 'circle'));
test('pose: crossed forearms = X', () => assert.equal(classify(X), 'cross'));
test('pose: ordinary play is nothing', () => {
  for (const p of [REST, SMASH, READY]) assert.equal(classify(p), null);
});
test('pose: unsure joints are ignored', () => assert.equal(classify(person({lw: [0.52, 0.22], rw: [0.48, 0.22], le: [0.62, 0.36], re: [0.38, 0.36], vis: 0.3})), null));
test('pose: a mirrored body (back to camera) still reads', () => {
  const flip = O.map(p => ({...p, x: 1 - p.x}));
  assert.equal(classify(flip), 'circle');
});
test('pose: torso position', () => assert.equal(torsoX(O), 0.5));

/** Feeds frames every 80 ms; `who(t)` returns the gestures seen at time t. */
function run(h, from, to, who) {
  const fired = [];
  for (let t = from; t <= to; t += 80) { const r = h.update(who(t), t); if (r.fire) fired.push([r.fire, t]); }
  return fired;
}

test('hold: fires once after the hold time, not again while still held', () => {
  const h = new GestureHold({holdMs: 1000, cooldownMs: 2500});
  const fired = run(h, 0, 4000, () => ['circle']);
  assert.equal(fired.length, 1);
  assert.ok(fired[0][1] >= 1000 && fired[0][1] < 1100);
});

test('hold: a short pose does nothing; a missed frame does not reset', () => {
  const h = new GestureHold({holdMs: 1000, cooldownMs: 2500});
  assert.deepEqual(run(h, 0, 700, () => ['cross']), []);
  assert.deepEqual(run(h, 800, 1500, () => [null]), []);
  const h2 = new GestureHold({holdMs: 1000, cooldownMs: 2500});
  const fired = run(h2, 0, 1600, t => (t === 480 ? [null] : ['cross']));
  assert.deepEqual(fired.map(f => f[0]), ['cross']);
});

test('hold: let go, cooldown, do it again = second point', () => {
  const h = new GestureHold({holdMs: 1000, cooldownMs: 2500});
  const fired = run(h, 0, 6000, t => (t < 1500 || t > 3000 ? ['circle'] : [null]));
  assert.equal(fired.length, 2);
});

test('hold: dropping the pose just before the end never fires', () => {
  const h = new GestureHold({holdMs: 1000, cooldownMs: 2500});
  assert.deepEqual(run(h, 0, 2000, t => (t < 950 ? ['circle'] : [null])), []);
});

test('hold: either of two players counts', () => {
  const h = new GestureHold({holdMs: 1000, cooldownMs: 2500});
  const fired = run(h, 0, 1500, () => [null, 'circle']);
  assert.deepEqual(fired.map(f => f[0]), ['circle']);
});

// New gestures. Same person as above: shoulders at y 0.5 (x 0.45..0.55), nose at y 0.38.
const TEE = person({lw: [0.8, 0.5], rw: [0.2, 0.5], le: [0.68, 0.5], re: [0.32, 0.5]});
const X_OVERHEAD = person({lw: [0.42, 0.18], rw: [0.58, 0.18], le: [0.62, 0.3], re: [0.38, 0.3]});
const HEAD = person({lw: [0.53, 0.3], rw: [0.42, 0.68], le: [0.62, 0.42], re: [0.4, 0.62]});
const FOREHEAD = person({lw: [0.52, 0.35], rw: [0.42, 0.68], le: [0.6, 0.55], re: [0.4, 0.62]});
const HEAD_OTHER_HAND = person({rw: [0.47, 0.3], lw: [0.58, 0.68], re: [0.38, 0.42], le: [0.6, 0.62]});
const SERVE = person({lw: [0.52, 0.62], rw: [0.38, 0.75], le: [0.6, 0.6], re: [0.4, 0.62]});
const OVERHEAD_SMASH = person({lw: [0.62, 0.62], rw: [0.4, 0.12], re: [0.4, 0.3]});

test('pose: T = arms straight out at shoulder height', () => assert.equal(classify(TEE), 'tee'));
test('pose: X held overhead still reads as X', () => assert.equal(classify(X_OVERHEAD), 'cross'));
test('pose: X with a half-hidden wrist still reads as X', () => {
  const lm = X.map(p => ({...p})); lm[15].visibility = 0.35;
  assert.equal(classify(lm), 'cross');
});
test('pose: one hand on the head, the other down (either hand)', () => {
  assert.equal(classify(HEAD), 'head');
  assert.equal(classify(HEAD_OTHER_HAND), 'head');
  assert.equal(classify(FOREHEAD), 'head', 'a hand on the forehead counts too');
});
test('pose: serve, overhead smash and ready stance are nothing', () => {
  for (const p of [SERVE, OVERHEAD_SMASH, READY]) assert.equal(classify(p), null);
});
test('pose: O, hand-on-head, X and T never read as each other', () => {
  assert.deepEqual([O, HEAD, X, TEE].map(classify), ['circle', 'head', 'cross', 'tee']);
});

const shrink = (lm, k) => lm.map(p => ({...p, x: 0.5 + (p.x - 0.5) * k, y: 0.5 + (p.y - 0.5) * k}));
test('near: people much smaller than the calibrated size are ignored', () => {
  const far = shrink(O, 0.4);
  assert.equal(nearPeople([O, far], bodyScale(O)).length, 1);
  assert.equal(nearPeople([shrink(O, 0.7)], bodyScale(O)).length, 1, 'a step back is still us');
});
test('near: without calibration, keep the biggest people', () => {
  assert.deepEqual(nearPeople([shrink(O, 0.3), O], null), [O]);
});
