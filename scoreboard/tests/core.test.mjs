import test from 'node:test';
import assert from 'node:assert/strict';
import {newMatch, derive, scorePoint, cancelTeamPoint, undoLast, startNextGame, swapSides, serviceCourt, isDecidingInterval, toCsv} from '../public/core.js';
import {RemoteInput, DEFAULT_REMOTE} from '../public/remote.js';

const play = (match, seq) => { for (const t of seq) scorePoint(match, t, 'tap'); };

test('rally scoring, serve follows the rally winner', () => {
  const m = newMatch();
  play(m, 'AAB');
  const s = derive(m);
  assert.deepEqual(s.scores, {A: 2, B: 1});
  assert.equal(s.server, 'B');
  assert.equal(serviceCourt(s), '왼쪽');
});

test('win by two, capped at 30', () => {
  const m = newMatch();
  play(m, 'AB'.repeat(20)); // 20-20
  play(m, 'A');
  assert.equal(derive(m).gameOver, false);
  play(m, 'A');
  assert.equal(derive(m).game.winner, 'A');
  const c = newMatch();
  play(c, 'AB'.repeat(29));
  play(c, 'B');
  assert.deepEqual(derive(c).game.scores, {A: 29, B: 30});
  assert.equal(derive(c).game.winner, 'B');
});

test('no points after the game ends until next game; result stays visible', () => {
  const m = newMatch({rules: {target: 3}});
  play(m, 'AAA');
  assert.equal(scorePoint(m, 'B', 'tap'), null);
  assert.deepEqual(derive(m).scores, {A: 3, B: 0});
  startNextGame(m, 'button', true);
  const s = derive(m);
  assert.equal(s.gameNo, 2);
  assert.equal(s.server, 'A');
  assert.equal(s.swapped, true);
});

test('team cancel removes that team\'s latest point and rebuilds serve', () => {
  const m = newMatch();
  play(m, 'ABA');
  cancelTeamPoint(m, 'B', 'swipe-up');
  const s = derive(m);
  assert.deepEqual(s.scores, {A: 2, B: 0});
  assert.equal(s.server, 'A');
  assert.equal(cancelTeamPoint(m, 'B', 'swipe-up'), null);
});

test('undo walks back across a finished game and its side swap', () => {
  const m = newMatch({rules: {target: 2}});
  play(m, 'AA');
  startNextGame(m, 'button', true);
  play(m, 'B');
  undoLast(m, 'button');
  assert.equal(derive(m).gameNo, 2);
  undoLast(m, 'button');
  let s = derive(m);
  assert.equal(s.gameNo, 1);
  assert.equal(s.swapped, false);
  assert.equal(s.gameOver, true);
  undoLast(m, 'button');
  s = derive(m);
  assert.deepEqual(s.scores, {A: 1, B: 0});
  assert.equal(s.gameOver, false);
});

test('match ends after two games and the log keeps every input', () => {
  const m = newMatch({rules: {target: 2}});
  play(m, 'AA'); startNextGame(m, 'button', false); play(m, 'BAAA');
  swapSides(m, 'button');
  const s = derive(m);
  assert.equal(s.matchWinner, 'A');
  assert.equal(startNextGame(m, 'button', false), null);
  const csv = toCsv(m).split('\n');
  assert.equal(csv.length, m.events.length + 1);
});

test('deciding game interval at 11', () => {
  const d = newMatch();
  play(d, 'A'.repeat(21)); startNextGame(d, 'b', false); play(d, 'B'.repeat(21)); startNextGame(d, 'b', false);
  play(d, 'A'.repeat(10));
  assert.equal(isDecidingInterval(derive(d)), false);
  play(d, 'A');
  assert.equal(isDecidingInterval(derive(d)), true);
});

function fakeTimers() {
  let now = 0, id = 0;
  const queue = new Map();
  return {
    set: (fn, ms) => { queue.set(++id, {fn, at: now + ms}); return id; },
    clear: (k) => queue.delete(k),
    now: () => now,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...queue.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        queue.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}
const K = {key: 'Enter', code: 'Enter'};

test('remote: short press = one short action after release', () => {
  const t = fakeTimers(), got = [];
  const r = new RemoteInput({...DEFAULT_REMOTE}, a => got.push(a), t);
  r.keydown(K); t.advance(120); r.keyup(K); t.advance(400);
  assert.deepEqual(got, ['short']);
});

test('remote: held with auto-repeat = exactly one long action', () => {
  const t = fakeTimers(), got = [];
  const r = new RemoteInput({...DEFAULT_REMOTE}, a => got.push(a), t);
  r.keydown(K);
  for (let i = 0; i < 40; i++) { t.advance(50); r.keydown({...K, repeat: true}); }
  r.keyup(K); t.advance(1000);
  assert.deepEqual(got, ['long']);
});

test('remote: held as repeated down/up pairs = exactly one long action', () => {
  const t = fakeTimers(), got = [];
  const r = new RemoteInput({...DEFAULT_REMOTE}, a => got.push(a), t);
  for (let i = 0; i < 30; i++) { r.keydown(K); t.advance(10); r.keyup(K); t.advance(40); }
  t.advance(1000);
  assert.deepEqual(got, ['long']);
});

test('remote: two separate quick presses = two short actions', () => {
  const t = fakeTimers(), got = [];
  const r = new RemoteInput({...DEFAULT_REMOTE}, a => got.push(a), t);
  r.keydown(K); t.advance(80); r.keyup(K); t.advance(500);
  r.keydown(K); t.advance(80); r.keyup(K); t.advance(500);
  assert.deepEqual(got, ['short', 'short']);
});

test('remote: registered key only, dedicated buttons act once', () => {
  const t = fakeTimers(), got = [];
  const r = new RemoteInput({...DEFAULT_REMOTE, primary: 'code:Enter', cancel: 'code:KeyZ'}, a => got.push(a), t);
  assert.equal(r.keydown({key: 'a', code: 'KeyA'}), false);
  r.keydown({key: 'z', code: 'KeyZ'}); t.advance(900); r.keydown({key: 'z', code: 'KeyZ', repeat: true}); r.keyup({key: 'z', code: 'KeyZ'}); t.advance(500);
  assert.deepEqual(got, ['cancel']);
});

test('remote: a remote that never sends key-up does not lock input', () => {
  const t = fakeTimers(), got = [];
  const r = new RemoteInput({...DEFAULT_REMOTE, useLong: false}, a => got.push(a), t);
  r.keydown(K); t.advance(3000); r.keydown(K); t.advance(3000);
  assert.deepEqual(got, ['short', 'short']);
});
