// @ts-check
import {newMatch, derive, scorePoint, cancelTeamPoint, undoLast, startNextGame, swapSides,
  isDecidingInterval, gameWinner, longestRuns, toCsv, other} from './core.js';
import {RemoteInput, DEFAULT_REMOTE, keyId} from './remote.js';
import {classify, torsoX, GestureHold, DEFAULT_POSE, UPPER_BODY} from './pose.js';

/** @typedef {'A'|'B'} Team */
const $ = (/** @type {string} */ s) => /** @type {HTMLElement} */ (document.querySelector(s));
const $$ = (/** @type {string} */ s) => /** @type {HTMLElement[]} */ ([...document.querySelectorAll(s)]);

// ---------- storage: every event is written to this device before the screen updates ----------
const KEY = {current: 'sb.v1.current', index: 'sb.v1.index', prefs: 'sb.v1.prefs', match: (/** @type {string} */ id) => `sb.v1.match.${id}`};
const store = {
  get(/** @type {string} */ k) { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } },
  set(/** @type {string} */ k, /** @type {any} */ v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
// Side background colours. Each pair is chosen for the strongest difference between the two teams.
const PALETTES = /** @type {Record<string, {label: string, A: string, B: string, dark?: boolean}>} */ ({
  dark: {label: '다크 · 검은 배경에 은은한 색', A: '#36e0a2', B: '#ff8f5a', dark: true},
  contrast: {label: '고대비 · 블루 × 오렌지', A: '#1450ff', B: '#ff7a00'},
  primary: {label: '원색 · 레드 × 블루', A: '#e3001b', B: '#0057ff'},
  primary2: {label: '원색 · 그린 × 레드', A: '#00a651', B: '#e3001b'},
  neon: {label: '형광 · 라임 × 핑크', A: '#b6ff00', B: '#ff2ec4'},
  neon2: {label: '형광 · 옐로 × 바이올렛', A: '#eaff00', B: '#8a2bff'},
  pastel: {label: '파스텔 · 민트 × 피치', A: '#9ee6c9', B: '#ffb5a7'},
  pastel2: {label: '파스텔 · 라벤더 × 레몬', A: '#c3b5ff', B: '#ffe98a'},
});
const DEFAULT_PREFS = {ourTeam: /** @type {Team} */ ('A'), reverseSwipe: false, sound: true, idleDim: true, light: false, autoSwap: true, intro: true,
  colors: {preset: 'dark', A: PALETTES.dark.A, B: PALETTES.dark.B}, colorsV: 2, remote: {...DEFAULT_REMOTE},
  // team: the team the camera faces (set by the test). O = that team +1, X = the other team +1.
  pose: {enabled: false, team: /** @type {Team|null} */ (null), holdMs: DEFAULT_POSE.holdMs}};
const savedPrefs = store.get(KEY.prefs) ?? {};
// The default used to be the blue × orange set; devices still on it move to the new dark default once.
if (!savedPrefs.colorsV && savedPrefs.colors?.preset === 'contrast') delete savedPrefs.colors;
const prefs = {...DEFAULT_PREFS, ...savedPrefs, colorsV: 2, remote: {...DEFAULT_REMOTE, ...savedPrefs.remote}, colors: {...DEFAULT_PREFS.colors, ...savedPrefs.colors},
  pose: {...DEFAULT_PREFS.pose, ...savedPrefs.pose}};
const savePrefs = () => store.set(KEY.prefs, prefs);

/** @type {any} */
let match = (() => {
  const id = store.get(KEY.current);
  const saved = id && store.get(KEY.match(id));
  // Matches from the first version used placeholder names.
  if (saved?.settings?.names?.A === 'A팀' && saved.settings.names.B === 'B팀') saved.settings.names = {A: '우리 팀', B: '상대 팀'};
  if (saved?.events?.length) { setTimeout(() => saved.events.length > 1 && toast('이전 경기 기록을 불러와 이어서 진행합니다.'), 300); return saved; }
  return newMatch();
})();

function saveMatch() {
  const state = derive(match);
  const ok = store.set(KEY.match(match.id), match) && store.set(KEY.current, match.id);
  const index = (store.get(KEY.index) ?? []).filter((/** @type {any} */ m) => m.id !== match.id);
  index.unshift({id: match.id, createdAt: match.createdAt, updatedAt: Date.now(), names: match.settings.names,
    gamesWon: state.gamesWon, scores: state.scores, winner: state.matchWinner, points: state.active.length});
  // Keep the newest 60 matches; older ones are removed from this device.
  for (const old of index.splice(60)) { try { localStorage.removeItem(KEY.match(old.id)); } catch {} }
  const indexOk = store.set(KEY.index, index);
  const el = $('#saveState');
  el.classList.toggle('error', !(ok && indexOk));
  el.textContent = ok && indexOk ? `기기에 저장됨 ${new Date().toTimeString().slice(0, 8)}` : '저장 실패 · 저장 공간 확인';
}

// ---------- feedback ----------
/** @type {AudioContext|null} */ let audio = null;
function tone(/** @type {number[]} */ freqs, gap = 0.11) {
  if (!prefs.sound) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    freqs.forEach((f, i) => {
      const ctx = /** @type {AudioContext} */ (audio), t = ctx.currentTime + i * gap;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = f; osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain).connect(ctx.destination); osc.start(t); osc.stop(t + 0.14);
    });
  } catch {}
}
const SOUND = {A: [988], B: [740, 740], cancel: [520, 392], end: [784, 988, 1319]};
const teamSound = (/** @type {Team} */ t) => (t === prefs.ourTeam ? SOUND.A : SOUND.B);

let toastTimer = 0;
function toast(/** @type {string} */ text, ms = 2200) {
  const el = $('#toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, ms);
}
function flash(/** @type {Team} */ team, cls = 'flash') {
  const side = sideOf(team);
  if (!side) return;
  side.classList.remove('flash', 'unflash');
  void side.offsetWidth;
  side.classList.add(cls);
}

// ---------- actions (every input path ends here) ----------
const sides = $$('.side');
const sideOf = (/** @type {Team} */ team) => sides.find(s => s.dataset.team === team);
const name = (/** @type {Team} */ t) => match.settings.names[t];

function point(/** @type {Team} */ team, /** @type {string} */ source) {
  const before = derive(match);
  if (before.gameOver) { toast(before.matchWinner ? '경기가 끝났습니다. 되돌리기 또는 새 경기를 선택하세요.' : '게임이 끝났습니다. ‘다음 게임’을 누르세요.'); return; }
  scorePoint(match, team, source);
  saveMatch();
  const state = derive(match);
  render();
  flash(team);
  if (state.gameOver) tone(SOUND.end, 0.13); else tone(teamSound(team));
  if (isDecidingInterval(state)) toast(`${Math.max(state.scores.A, state.scores.B)}점 · 마지막 게임 코트 교대 시점입니다`, 3500);
}
function cancelTeam(/** @type {Team} */ team, /** @type {string} */ source) {
  if (!cancelTeamPoint(match, team, source)) { toast(`${name(team)}: 이번 게임에서 취소할 득점이 없습니다.`); return; }
  saveMatch(); render(); flash(team, 'unflash'); tone(SOUND.cancel);
  toast(`${name(team)} 1점 취소`);
}
function undo(/** @type {string} */ source) {
  const ev = undoLast(match, source);
  if (!ev) { toast('되돌릴 입력이 없습니다.'); return; }
  saveMatch(); render(); tone(SOUND.cancel);
  if (ev.team) { flash(ev.team, 'unflash'); toast(`되돌리기: ${name(ev.team)} 득점 취소`); }
  else toast('되돌리기: 이전 게임 종료 상태로 돌아갑니다.');
}
function nextGame() {
  const state = derive(match);
  if (state.matchWinner) { archiveAndStart(); return; }
  if (!startNextGame(match, 'button', prefs.autoSwap)) return;
  saveMatch(); render();
  toast(prefs.autoSwap ? `${derive(match).gameNo}게임 시작 · 좌우를 바꿨습니다` : `${derive(match).gameNo}게임 시작`);
}
function swap() { swapSides(match, 'button'); saveMatch(); render(); toast('코트 교대: 좌우를 바꿨습니다'); }
function archiveAndStart() {
  const {names, rules, firstServer} = match.settings;
  saveMatch();
  match = newMatch({names, rules, firstServer});
  saveMatch(); render();
  toast('새 경기를 시작합니다. 이전 경기는 기록에 남아 있습니다.');
}

// ---------- score size: both halves use the size that fits the smaller one, so the teams always match ----------
// Same limits as the CSS fallback: 1.18 × box height, 1 × box width (two digits are under 0.92 em wide).
const scoreBoxes = $$('.score-box');
function fitScores() {
  const fit = Math.min(...scoreBoxes.map(b => Math.min(b.clientHeight * 1.18, b.clientWidth)));
  if (fit > 0) document.documentElement.style.setProperty('--score-fs', `${Math.floor(fit)}px`);
}
// Browser bars appearing, rotation and font loading all change the boxes; resize/orientation cover pages that are not painting.
const scoreObserver = new ResizeObserver(fitScores);
scoreBoxes.forEach(b => scoreObserver.observe(b));
window.addEventListener('resize', fitScores);
document.fonts?.ready.then(fitScores);

// ---------- rendering ----------
function render() {
  const state = derive(match);
  const left = /** @type {Team} */ (state.swapped ? 'B' : 'A');
  sides.forEach((side, i) => {
    const team = /** @type {Team} */ (i === 0 ? left : other(left));
    side.dataset.team = team;
    paintSide(side, team);
    /** @type {HTMLElement} */ (side.querySelector('.team-name')).textContent = name(team);
    /** @type {HTMLElement} */ (side.querySelector('.score')).textContent = String(state.scores[team]);
    side.classList.toggle('serving', !state.gameOver && state.server === team);
    side.classList.toggle('winner', state.game.winner === team);
  });
  $('#gameLabel').textContent = state.matchWinner ? '경기 종료' : `${state.gameNo}게임`;
  const hint = pointHint(state);
  $('#hintWrap').hidden = !hint;
  $('#hint').textContent = hint;
  const banner = $('#banner');
  banner.hidden = !state.gameOver;
  if (state.gameOver) {
    const w = /** @type {Team} */ (state.game.winner);
    $('#bannerTitle').textContent = state.matchWinner ? `${name(state.matchWinner)} 경기 승리` : `${name(w)} ${state.gameNo}게임 승리`;
    $('#bannerText').textContent = state.games.map(g => `${g.scores.A}–${g.scores.B}`).join(' · ') + (state.matchWinner ? ` (${state.gamesWon.A}:${state.gamesWon.B})` : '');
    $('#bannerNext').textContent = state.matchWinner ? '새 경기' : '다음 게임';
  }
  tick();
  if ($('#timelineSheet').hasAttribute('open')) renderTimeline();
}

/** Black or white digits, whichever stands out more on the background. @param {string} hex */
function inkFor(hex) {
  const lum = (/** @type {number} */ c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const n = parseInt(hex.slice(1), 16);
  const L = 0.2126 * lum(n >> 16 & 255) + 0.7152 * lum(n >> 8 & 255) + 0.0722 * lum(n & 255);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#0b0d10' : '#ffffff';
}
function paintSide(/** @type {HTMLElement} */ side, /** @type {Team} */ team) {
  const dark = PALETTES[prefs.colors.preset]?.dark;
  if (dark && prefs.light) { side.style.removeProperty('--team'); side.style.removeProperty('--ink'); return; }
  const color = prefs.colors[team];
  side.style.setProperty('--team', color);
  side.style.setProperty('--ink', inkFor(color));
}
function applyColors() {
  document.body.classList.toggle('colored', !PALETTES[prefs.colors.preset]?.dark);
  sides.forEach(side => { if (side.dataset.team) paintSide(side, /** @type {Team} */ (side.dataset.team)); });
}

function pointHint(/** @type {any} */ state) {
  if (state.gameOver) return '';
  const {A, B} = state.scores, r = state.rules;
  for (const team of /** @type {Team[]} */ (['A', 'B'])) {
    const next = {...state.scores, [team]: state.scores[team] + 1};
    if (gameWinner(next, r) === team) return `${state.gamesWon[team] + 1 >= r.gamesToWin ? '매치' : '게임'} 포인트 · ${name(team)}`;
  }
  return A === B && A >= r.target - 1 ? '듀스' : '';
}

function fmt(/** @type {number} */ ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function tick() {
  const state = derive(match);
  const end = state.matchWinner ? state.game.endT : Date.now();
  $('#clock').textContent = fmt(end - match.events[0].t);
}
setInterval(tick, 1000);

// ---------- touch: tap or swipe down = +1, swipe up = cancel that team's last point ----------
/** @type {Map<number, {x: number, y: number, t: number, team: Team}>} */
const pointers = new Map();
const lastTouchPoint = {A: -Infinity, B: -Infinity};
const court = $('#court');
court.addEventListener('pointerdown', e => {
  const side = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.side'));
  if (!side || !e.isPrimary && pointers.size) return; // ignore a second finger or palm while one is down
  if (/** @type {HTMLElement} */ (e.target).closest('.team-name, .name-edit')) return; // renaming, not scoring
  pointers.set(e.pointerId, {x: e.clientX, y: e.clientY, t: performance.now(), team: /** @type {Team} */ (side.dataset.team)});
  try { side.setPointerCapture(e.pointerId); } catch {}
});
court.addEventListener('pointerup', e => {
  const start = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (!start) return;
  const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = performance.now() - start.t;
  const swipeMin = Math.max(48, Math.min(innerHeight, innerWidth) * 0.08);
  const vertical = Math.abs(dy) >= swipeMin && Math.abs(dy) > Math.abs(dx) * 1.3;
  const down = prefs.reverseSwipe ? dy < 0 : dy > 0;
  let kind = '';
  if (vertical) kind = down ? 'swipe-down' : 'swipe-up';
  else if (Math.hypot(dx, dy) < 22 && dt < 650) kind = 'tap';
  if (!kind) return; // long press or ambiguous drag: do nothing rather than guess
  if (kind === 'swipe-up') { cancelTeam(start.team, 'swipe-up'); return; }
  const now = performance.now();
  if (now - lastTouchPoint[start.team] < 260) return; // one gesture can never become two points
  lastTouchPoint[start.team] = now;
  point(start.team, kind);
});
court.addEventListener('pointercancel', e => pointers.delete(e.pointerId));
// No long-press menus, magnifier or pinch/double-tap zoom anywhere but text fields.
document.addEventListener('contextmenu', e => { if (!(/** @type {HTMLElement} */ (e.target).closest('input, textarea'))) e.preventDefault(); });
document.addEventListener('dblclick', e => e.preventDefault(), {passive: false});
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, e => e.preventDefault(), {passive: false});
document.addEventListener('touchmove', e => { if (/** @type {TouchEvent} */ (e).touches.length > 1) e.preventDefault(); }, {passive: false});

// ---------- buttons ----------
document.addEventListener('click', e => {
  const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-act]'));
  if (!btn) return;
  btn.blur(); // a remote that sends Enter must never "click" a focused button
  const act = btn.dataset.act;
  if (act === 'undo') undo('button');
  else if (act === 'swap') swap();
  else if (act === 'timeline') openSheet('#timelineSheet');
  else if (act === 'remote') openSheet('#remoteSheet');
  else if (act === 'settings') openSheet('#settingsSheet');
  else if (act === 'fullscreen') toggleFullscreen();
  if (act === 'more') setToolbarOpen(!toolbar.classList.contains('open'));
  else if (btn.closest('#toolbarMore')) setToolbarOpen(false);
});

// ---------- toolbar: 되돌리기 · 코트 교대 always; the rest behind the chevron ----------
const toolbar = $('#toolbar');
let toolbarTimer = 0;
function setToolbarOpen(/** @type {boolean} */ open) {
  toolbar.classList.toggle('open', open);
  $('#moreBtn').setAttribute('aria-expanded', String(open));
  $('#toolbarMore').inert = !open;
  clearTimeout(toolbarTimer);
  if (open) toolbarTimer = window.setTimeout(() => setToolbarOpen(false), 5000);
}
toolbar.addEventListener('pointerdown', () => { if (toolbar.classList.contains('open')) setToolbarOpen(true); }); // any touch restarts the timer
// ---------- 새 경기 on the toolbar: hold ~1 s so a stray tap never wipes the board ----------
const NEW_HOLD_MS = 1000;
let newHoldTimer = 0, newHoldDone = false;
const newBar = $('#newMatchBar');
newBar.addEventListener('pointerdown', e => {
  newHoldDone = false;
  newBar.setPointerCapture?.(e.pointerId);
  newBar.classList.add('holding');
  clearTimeout(newHoldTimer);
  newHoldTimer = window.setTimeout(() => {
    newHoldDone = true; newBar.classList.remove('holding');
    navigator.vibrate?.(40);
    archiveAndStart();
  }, NEW_HOLD_MS);
});
const endNewHold = () => {
  if (!newBar.classList.contains('holding')) return;
  clearTimeout(newHoldTimer); newBar.classList.remove('holding');
  if (!newHoldDone) toast('새 경기는 버튼을 1초 동안 길게 누르세요');
};
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) newBar.addEventListener(type, endNewHold);

$('#bannerNext').addEventListener('click', e => { /** @type {HTMLElement} */ (e.currentTarget).blur(); nextGame(); });
$$('[data-close]').forEach(b => b.addEventListener('click', () => /** @type {HTMLDialogElement} */ (b.closest('dialog')).close()));
$$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) /** @type {HTMLDialogElement} */ (d).close(); }));

function openSheet(/** @type {string} */ sel) {
  const d = /** @type {HTMLDialogElement} */ ($(sel));
  if (sel === '#timelineSheet') { viewId = match.id; renderTimeline(); }
  if (sel === '#remoteSheet') renderRemote();
  if (sel === '#settingsSheet') fillSettings();
  d.showModal();
  /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.();
}
const isOpen = (/** @type {string} */ sel) => $(sel).hasAttribute('open');

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await document.documentElement.requestFullscreen({navigationUI: 'hide'});
      // @ts-ignore orientation lock exists on Android Chrome only
      await screen.orientation?.lock?.('landscape').catch(() => {});
    }
  } catch { toast('이 브라우저에서는 전체 화면을 사용할 수 없습니다.'); }
}

// ---------- keep the screen on ----------
/** @type {any} */ let wakeLock = null;
async function keepAwake() {
  if (wakeLock || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try {
    // @ts-ignore
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); remote.reset(); } });

// ---------- idle: dim the glass controls, never the scores ----------
let idleTimer = 0;
function active() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  if (prefs.idleDim) idleTimer = window.setTimeout(() => document.body.classList.add('idle'), 4000);
  keepAwake();
}
['pointerdown', 'pointermove'].forEach(t => window.addEventListener(t, active, {passive: true}));

// ---------- Bluetooth remote ----------
/** @type {string|null} */ let learning = null;
const keylog = /** @type {{type: string, key: string, code: string, repeat: boolean, dt: number}[]} */ ([]);
let lastKeyAt = 0;
const remote = new RemoteInput(prefs.remote, (action, info) => {
  const dot = $('#remoteDot');
  dot.classList.add('hit'); setTimeout(() => dot.classList.remove('hit'), 180);
  const ours = prefs.ourTeam, theirs = other(prefs.ourTeam);
  if (isOpen('#remoteSheet')) {
    const label = {single: `한 번 → ${name(ours)} +1`, double: `두 번 → ${name(theirs)} +1`, long: '길게 → 방금 입력 되돌리기',
      opponent: `상대 팀 버튼 → ${name(theirs)} +1`, cancel: '되돌리기 버튼 → 방금 입력 되돌리기'}[action];
    $('#verdict').textContent = `판정: ${label}  (테스트 중이라 점수는 그대로)`;
    tone(action === 'cancel' || action === 'long' ? SOUND.cancel : action === 'single' ? SOUND.A : SOUND.B);
    return;
  }
  hideIntro();
  if (document.querySelector('dialog[open]') || editingName || !$('#poseTest').hidden) return;
  if (action === 'single') point(ours, 'remote-single');
  else if (action === 'double') point(theirs, 'remote-double');
  else if (action === 'opponent') point(theirs, 'remote-key');
  else undo(action === 'long' ? 'remote-long' : 'remote');
});

function logKey(/** @type {KeyboardEvent} */ e) {
  const now = performance.now();
  keylog.unshift({type: e.type, key: e.key, code: e.code || '—', repeat: e.repeat, dt: lastKeyAt ? now - lastKeyAt : 0});
  keylog.length = Math.min(keylog.length, 40);
  lastKeyAt = now;
  if (isOpen('#remoteSheet')) renderKeylog();
}
function typing(/** @type {EventTarget|null} */ t) {
  return t instanceof HTMLInputElement && !['checkbox', 'range'].includes(t.type) || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
}
window.addEventListener('keydown', e => {
  logKey(e);
  active();
  if (typing(e.target) || e.key === 'Escape') return;
  if (learning && !['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) {
    const id = keyId(e);
    for (const k of /** @type {const} */ (['primary', 'opponent', 'cancel'])) if (prefs.remote[k] === id) prefs.remote[k] = null;
    prefs.remote[/** @type {'primary'|'opponent'|'cancel'} */ (learning)] = id;
    learning = null; savePrefs(); renderRemote();
    $('#verdict').textContent = `등록 완료: ${id}`;
    e.preventDefault();
    return;
  }
  if (remote.keydown(e)) e.preventDefault();
}, true);
window.addEventListener('keyup', e => {
  logKey(e);
  if (typing(e.target)) return;
  if (remote.keyup(e)) e.preventDefault();
}, true);

const keyLabel = (/** @type {string|null} */ id, empty = '없음') => id ? id.replace(/^(code|key|keyCode):/, '') : empty;
function renderRemote() {
  $$('[data-key]').forEach(el => {
    const role = /** @type {'primary'|'opponent'|'cancel'} */ (el.dataset.key);
    el.textContent = keyLabel(prefs.remote[role], role === 'primary' ? '미등록 · 모든 키' : '없음');
  });
  $$('[data-learn]').forEach(b => { b.classList.toggle('learning', learning === b.dataset.learn); b.textContent = learning === b.dataset.learn ? '버튼을 누르세요' : '등록'; });
  const our = /** @type {HTMLSelectElement} */ ($('#ourTeam'));
  our.options[0].textContent = name('A'); our.options[1].textContent = name('B'); our.value = prefs.ourTeam;
  /** @type {HTMLInputElement} */ ($('#useLong')).checked = prefs.remote.useLong;
  /** @type {HTMLInputElement} */ ($('#longMs')).value = String(prefs.remote.longMs);
  /** @type {HTMLInputElement} */ ($('#releaseGrace')).value = String(prefs.remote.releaseGrace);
  /** @type {HTMLInputElement} */ ($('#doubleMs')).value = String(prefs.remote.doubleMs);
  $('#doubleOut').textContent = `${(prefs.remote.doubleMs / 1000).toFixed(2)}초`;
  $('#longMsOut').textContent = `${(prefs.remote.longMs / 1000).toFixed(2)}초`;
  $('#graceOut').textContent = `${prefs.remote.releaseGrace}ms`;
  renderKeylog();
  $('#remoteDot').classList.toggle('on', Boolean(prefs.remote.primary || prefs.remote.opponent));
}
function renderKeylog() {
  $('#keylog').innerHTML = keylog.map(k => `<tr><td>${k.type}</td><td>${esc(k.key)}</td><td>${esc(k.code)}</td><td>${k.repeat}</td><td>${k.dt ? `+${Math.round(k.dt)}ms` : ''}</td></tr>`).join('')
    || '<tr><td colspan="5">아직 받은 입력이 없습니다.</td></tr>';
}
$$('[data-learn]').forEach(b => b.addEventListener('click', () => { learning = learning === b.dataset.learn ? null : /** @type {string} */ (b.dataset.learn); b.blur(); renderRemote(); }));
$('#clearKeys').addEventListener('click', () => { prefs.remote.primary = prefs.remote.opponent = prefs.remote.cancel = null; savePrefs(); renderRemote(); });
$('#ourTeam').addEventListener('change', e => { prefs.ourTeam = /** @type {Team} */ (/** @type {HTMLSelectElement} */ (e.target).value); savePrefs(); /** @type {HTMLElement} */ (e.target).blur(); });
$('#useLong').addEventListener('change', e => { prefs.remote.useLong = /** @type {HTMLInputElement} */ (e.target).checked; savePrefs(); renderRemote(); });
$('#longMs').addEventListener('input', e => { prefs.remote.longMs = Number(/** @type {HTMLInputElement} */ (e.target).value); savePrefs(); renderRemote(); });
$('#releaseGrace').addEventListener('input', e => { prefs.remote.releaseGrace = Number(/** @type {HTMLInputElement} */ (e.target).value); savePrefs(); renderRemote(); });
$('#doubleMs').addEventListener('input', e => { prefs.remote.doubleMs = Number(/** @type {HTMLInputElement} */ (e.target).value); savePrefs(); renderRemote(); });
$('#remoteSheet').addEventListener('close', () => { learning = null; remote.reset(); });

// ---------- timeline ----------
const SOURCE = {'tap': '탭', 'pose-o': 'AI 포즈 O', 'pose-x': 'AI 포즈 X', 'swipe-down': '쓸기(득점)', 'swipe-up': '쓸기(취소)', 'remote-single': '리모컨 한 번', 'remote-double': '리모컨 두 번',
  'remote-short': '리모컨 짧게', 'remote-long': '리모컨 길게',
  'remote-key': '리모컨', 'remote': '리모컨', 'button': '버튼', 'app': ''};
const esc = (/** @type {any} */ s) => String(s).replace(/[&<>"']/g, c => /** @type {any} */ ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
let viewId = '';
function viewedMatch() { return viewId === match.id ? match : store.get(KEY.match(viewId)) ?? match; }
function renderTimeline() {
  const picker = /** @type {HTMLSelectElement} */ ($('#matchPicker'));
  const index = store.get(KEY.index) ?? [];
  picker.innerHTML = index.map((/** @type {any} */ m) => {
    const d = new Date(m.createdAt).toLocaleString('ko-KR', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});
    return `<option value="${esc(m.id)}">${m.id === match.id ? '진행 중 · ' : ''}${d} ${esc(m.names.A)} ${m.gamesWon.A}:${m.gamesWon.B} ${esc(m.names.B)}</option>`;
  }).join('');
  picker.value = viewId;
  const m = viewedMatch(), state = derive(m), n = m.settings.names;
  const all = state.games.flatMap(g => g.points);
  const runs = longestRuns(all);
  const cancels = m.events.filter((/** @type {any} */ e) => e.type === 'cancel').length;
  const end = state.matchWinner ? state.game.endT : (m === match ? Date.now() : m.events.at(-1).t);
  $('#summary').innerHTML = [
    ...state.games.map((g, i) => `<div><small>${i + 1}게임${g.winner ? ` · ${esc(n[g.winner])} 승` : ' · 진행 중'}</small><b>${g.scores.A} – ${g.scores.B}</b><small>${fmt((g.endT ?? end) - g.startT)}</small></div>`),
    `<div><small>최장 연속 득점</small><b>${runs.A} · ${runs.B}</b><small>${esc(n.A)} · ${esc(n.B)}</small></div>`,
    `<div><small>총 경기 시간</small><b>${fmt(end - m.events[0].t)}</b><small>취소 ${cancels}회</small></div>`,
  ].join('');
  const color = {A: 'var(--team-a)', B: 'var(--team-b)'};
  const items = [];
  let game = 0;
  for (const r of [...state.rows].reverse()) {
    const e = r.event;
    if (r.game !== game) { game = r.game; items.push(`<li class="game-sep">${r.game}게임</li>`); }
    let what = '';
    if (e.type === 'point') what = `<span class="tag" style="background:${color[/** @type {Team} */ (e.team)]}"></span>${esc(n[e.team])} 득점`;
    else if (e.type === 'cancel') { const t = m.events.find((/** @type {any} */ x) => x.seq === e.target); what = `↩ 취소 · ${t?.type === 'nextGame' ? '다음 게임 시작' : `${esc(n[t?.team] ?? '')} 득점`} (#${e.target})`; }
    else if (e.type === 'nextGame') what = `${r.game}게임 시작${e.swap ? ' · 좌우 교대' : ''}`;
    else if (e.type === 'swap') what = '코트 교대';
    else if (e.type === 'start') what = '경기 시작';
    items.push(`<li class="${r.cancelled || (!r.applied && e.type === 'point') ? 'off' : ''}"><span class="t">${fmt(e.elapsed)}</span><span>${what}</span><span class="src">${esc(/** @type {any} */ (SOURCE)[e.source] ?? e.source ?? '')}</span><span class="sc">${r.score.A}–${r.score.B}</span></li>`);
  }
  $('#timeline').innerHTML = items.join('');
}
$('#matchPicker').addEventListener('change', e => { viewId = /** @type {HTMLSelectElement} */ (e.target).value; renderTimeline(); });
function download(/** @type {string} */ text, /** @type {string} */ type, /** @type {string} */ ext) {
  const m = viewedMatch();
  const d = new Date(m.createdAt), pad = (/** @type {number} */ x) => String(x).padStart(2, '0');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = `badminton-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// The BOM makes Excel open Korean team names correctly.
$('#exportCsv').addEventListener('click', () => download('﻿' + toCsv(viewedMatch()), 'text/csv;charset=utf-8', 'csv'));
$('#exportJson').addEventListener('click', () => download(JSON.stringify(viewedMatch(), null, 2), 'application/json', 'json'));

// ---------- settings ----------
const form = /** @type {HTMLFormElement} */ ($('#settingsForm'));
const field = (/** @type {string} */ n) => /** @type {HTMLInputElement} */ (form.elements.namedItem(n));
function fillSettings() {
  const {names, rules, firstServer} = match.settings;
  field('nameA').value = names.A; field('nameB').value = names.B;
  field('firstServer').value = firstServer;
  field('firstServer').disabled = derive(match).started;
  field('target').value = rules.target; field('winBy').value = rules.winBy; field('cap').value = rules.cap;
  field('gamesToWin').value = String(rules.gamesToWin);
  for (const k of ['reverseSwipe', 'sound', 'idleDim', 'light', 'autoSwap', 'intro']) field(k).checked = /** @type {any} */ (prefs)[k];
  renderPoseSettings();
  $('#colorNameA').textContent = names.A; $('#colorNameB').textContent = names.B;
  fillColors();
  $('#wakeNote').textContent = 'wakeLock' in navigator ? `화면 켜짐 유지: ${wakeLock ? '사용 중' : '화면을 한 번 터치하면 켜집니다'}` : '이 브라우저는 화면 켜짐 유지를 지원하지 않습니다. 태블릿의 화면 꺼짐 시간을 길게 설정하세요.';
  resetArm();
}
form.addEventListener('submit', e => {
  e.preventDefault();
  const num = (/** @type {string} */ n, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ d) => { const v = Math.round(Number(field(n).value)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const target = num('target', 5, 50, 21);
  const rules = {target, winBy: num('winBy', 1, 5, 2), cap: Math.max(target, num('cap', 5, 60, 30)), gamesToWin: num('gamesToWin', 1, 3, 2)};
  match.settings.names = {A: field('nameA').value.trim() || '우리 팀', B: field('nameB').value.trim() || '상대 팀'};
  match.settings.rules = rules;
  if (!derive(match).started) match.settings.firstServer = /** @type {Team} */ (field('firstServer').value);
  for (const k of ['reverseSwipe', 'sound', 'idleDim', 'light', 'autoSwap', 'intro']) /** @type {any} */ (prefs)[k] = field(k).checked;
  savedColors = {...prefs.colors};
  savePrefs(); saveMatch(); applyTheme(); render(); active();
  /** @type {HTMLDialogElement} */ ($('#settingsSheet')).close();
});
let armTimer = 0;
function resetArm() { const b = $('#newMatch'); b.classList.remove('armed'); b.textContent = '새 경기 시작'; }
$('#newMatch').addEventListener('click', e => {
  const b = /** @type {HTMLElement} */ (e.currentTarget);
  if (!b.classList.contains('armed')) {
    b.classList.add('armed'); b.textContent = '한 번 더 누르면 새 경기';
    clearTimeout(armTimer); armTimer = window.setTimeout(resetArm, 3000);
    return;
  }
  resetArm();
  /** @type {HTMLDialogElement} */ ($('#settingsSheet')).close();
  archiveAndStart();
});

function applyTheme() {
  document.documentElement.dataset.theme = prefs.light ? 'light' : 'dark';
  /** @type {HTMLMetaElement} */ ($('meta[name=theme-color]')).content = prefs.light ? '#eef0ec' : '#06080b';
  applyColors();
}

// ---------- team colours: previewed live, kept only when settings are saved ----------
let savedColors = {...prefs.colors};
const palettePicker = /** @type {HTMLSelectElement} */ ($('#palette'));
palettePicker.innerHTML = Object.entries(PALETTES).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('') + '<option value="custom">직접 고르기</option>';
function fillColors() {
  palettePicker.value = prefs.colors.preset;
  field('colorA').value = prefs.colors.A; field('colorB').value = prefs.colors.B;
  $$('.swatches button').forEach(b => b.classList.toggle('on', b.dataset.preset === prefs.colors.preset));
}
$('.swatches').innerHTML = Object.entries(PALETTES).map(([k, p]) =>
  `<button type="button" data-preset="${k}" title="${p.label}" style="--a:${p.A};--b:${p.B}${p.dark ? ';--bg:#06080b' : ''}"><i></i><i></i></button>`).join('');
function choosePreset(/** @type {string} */ key) {
  const p = PALETTES[key];
  if (p) prefs.colors = {preset: key, A: p.A, B: p.B};
  else prefs.colors.preset = 'custom';
  fillColors(); applyColors();
}
palettePicker.addEventListener('change', () => choosePreset(palettePicker.value));
$('.swatches').addEventListener('click', e => { const b = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-preset]')); if (b) choosePreset(/** @type {string} */ (b.dataset.preset)); });
for (const t of /** @type {Team[]} */ (['A', 'B'])) field(`color${t}`).addEventListener('input', e => {
  prefs.colors = {...prefs.colors, preset: 'custom', [t]: /** @type {HTMLInputElement} */ (e.target).value};
  fillColors(); applyColors();
});
$('#settingsSheet').addEventListener('close', () => {
  // Closing without saving drops the colour preview.
  if (JSON.stringify(prefs.colors) !== JSON.stringify(savedColors)) { prefs.colors = {...savedColors}; applyColors(); }
});

// ---------- tap a team name to rename it in place ----------
let editingName = false;
$$('.team-name').forEach(el => el.addEventListener('click', () => {
  const side = /** @type {HTMLElement} */ (el.closest('.side'));
  const team = /** @type {Team} */ (side.dataset.team);
  const input = document.createElement('input');
  input.className = 'name-edit'; input.maxLength = 16; input.value = name(team); input.setAttribute('aria-label', '팀 이름');
  el.hidden = true; el.after(input); editingName = true;
  input.focus(); input.select();
  let done = false;
  const finish = (/** @type {boolean} */ keep) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (keep && v && v !== name(team)) { match.settings.names[team] = v; saveMatch(); }
    input.remove(); el.hidden = false; editingName = false; render();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); e.stopPropagation(); });
  input.addEventListener('blur', () => finish(true));
}));

// ---------- how-to popup on arrival: gone on the first touch or after a few seconds ----------
let introTimer = 0;
function showIntro() {
  const el = $('#intro');
  const [down, up] = prefs.reverseSwipe ? ['1점 취소', '+1'] : ['+1', '1점 취소'];
  $('#introDown').textContent = down; $('#introUp').textContent = up;
  $('#introDownTag').textContent = prefs.reverseSwipe ? '−1' : '+1';
  $('#introUpTag').textContent = prefs.reverseSwipe ? '+1' : '−1';
  $('#introOurs').textContent = name(prefs.ourTeam); $('#introTheirs').textContent = name(other(prefs.ourTeam));
  el.hidden = false; el.classList.remove('leaving');
  clearTimeout(introTimer);
  introTimer = window.setTimeout(hideIntro, 8000);
}
function hideIntro() {
  const el = $('#intro');
  if (el.hidden || el.classList.contains('leaving')) return;
  clearTimeout(introTimer);
  el.classList.add('leaving');
  setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); }, 250);
}
$('#intro').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); hideIntro(); });
$('#showIntro').addEventListener('click', () => { /** @type {HTMLDialogElement} */ ($('#settingsSheet')).close(); showIntro(); });

// ---------- AI pose scoring: the front camera faces one team; O = that team +1, X = the other team +1 ----------
// 'test' shows the camera and skeleton until an O is held; 'live' keeps the camera unseen and only shows pop-ups.
const poseVideo = /** @type {HTMLVideoElement} */ ($('#poseVideo'));
const poseCanvas = /** @type {HTMLCanvasElement} */ ($('#poseCanvas'));
const hold = new GestureHold({holdMs: prefs.pose.holdMs, cooldownMs: DEFAULT_POSE.cooldownMs});
/** @type {any} */ let camera = null;
let poseMode = /** @type {'off'|'test'|'live'} */ ('off');

async function startCamera() {
  if (!camera) { const {PoseCamera} = await import('./pose-camera.js'); camera = new PoseCamera(poseVideo, onPeople); }
  await camera.start();
}
function stopCamera() { camera?.stop(); poseMode = 'off'; clearPoseTint(); renderPoseToggle(); }
/** A video taken out of the page pauses, so it is moved between the test stage and its unseen spot and played again. */
function placeVideo(/** @type {boolean} */ onStage) {
  if (onStage) $('#poseStage').prepend(poseVideo); else document.body.append(poseVideo);
  poseVideo.className = onStage ? 'pose-video' : 'pose-video-hidden';
  poseVideo.play().catch(() => {});
}

function onPeople(/** @type {any[][]} */ people, /** @type {number} */ now) {
  const gestures = people.map(classify);
  const {gesture, progress, fire} = hold.update(gestures, now);
  if (poseMode === 'test') { drawPose(people, gestures); testStep(people, gestures, gesture, progress, fire); return; }
  if (poseMode !== 'live') return;
  const facing = prefs.pose.team ?? prefs.ourTeam;
  const teamFor = (/** @type {string} */ g) => /** @type {Team} */ (g === 'circle' ? facing : other(facing));
  const blocked = Boolean(document.querySelector('dialog[open]')) || editingName || !$('#intro').hidden;
  if (fire && !blocked) {
    const team = teamFor(fire);
    if (derive(match).gameOver) { clearPoseTint(); point(team, 'pose'); return; } // point() explains why nothing was added
    point(team, fire === 'circle' ? 'pose-o' : 'pose-x');
    showPoseTint(team, 1, `${fire === 'circle' ? 'O' : 'X'} · ${name(team)} +1`, true);
  } else if (gesture && progress > 0 && !blocked) {
    showPoseTint(teamFor(gesture), progress, `${gesture === 'circle' ? 'O' : 'X'} 인식 중`, false);
  } else if (!fireShowing) clearPoseTint();
}

// The whole board takes the scoring team's colour, deepening as the pose is held, then flashes on +1.
let fireShowing = false, fireTimer = 0;
function showPoseTint(/** @type {Team} */ team, /** @type {number} */ p, /** @type {string} */ label, /** @type {boolean} */ fired) {
  if (fireShowing && !fired) return;
  const tint = $('#poseTint'), pill = $('#posePill');
  for (const el of [tint, pill]) { el.style.setProperty('--tint-color', `var(--team-${team.toLowerCase()})`); el.style.setProperty('--p', String(p)); }
  $('#posePillText').textContent = label;
  pill.hidden = false;
  tint.classList.toggle('holding', !fired);
  pill.classList.toggle('fire', fired);
  if (fired) {
    tint.classList.remove('fire'); void tint.offsetWidth; tint.classList.add('fire');
    fireShowing = true; clearTimeout(fireTimer);
    fireTimer = window.setTimeout(() => { fireShowing = false; clearPoseTint(); }, 1400);
  }
}
function clearPoseTint() {
  $('#poseTint').classList.remove('holding', 'fire');
  const pill = $('#posePill'); pill.hidden = true; pill.classList.remove('fire');
}

function drawPose(/** @type {any[][]} */ people, /** @type {(string|null)[]} */ gestures) {
  const c = poseCanvas, ctx = c.getContext('2d');
  if (!ctx || !poseVideo.videoWidth) return;
  if (c.width !== poseVideo.videoWidth) { c.width = poseVideo.videoWidth; c.height = poseVideo.videoHeight; }
  ctx.clearRect(0, 0, c.width, c.height);
  const vis = (/** @type {any} */ p) => p && (p.visibility ?? 1) > 0.4;
  people.forEach((lm, i) => {
    const color = gestures[i] === 'circle' ? '#36e0a2' : gestures[i] === 'cross' ? '#ff8f5a' : '#ffffff';
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineWidth = Math.max(4, c.width / 110); ctx.lineCap = 'round';
    for (const [a, b] of UPPER_BODY) {
      if (!vis(lm[a]) || !vis(lm[b])) continue;
      ctx.beginPath(); ctx.moveTo(lm[a].x * c.width, lm[a].y * c.height); ctx.lineTo(lm[b].x * c.width, lm[b].y * c.height); ctx.stroke();
    }
    for (const k of [11, 12, 13, 14, 15, 16]) if (vis(lm[k])) { ctx.beginPath(); ctx.arc(lm[k].x * c.width, lm[k].y * c.height, ctx.lineWidth * 1.3, 0, 7); ctx.fill(); }
    if (vis(lm[0]) && vis(lm[11]) && vis(lm[12])) {
      const r = Math.hypot((lm[11].x - lm[12].x) * c.width, (lm[11].y - lm[12].y) * c.height) * 0.38;
      ctx.beginPath(); ctx.arc(lm[0].x * c.width, lm[0].y * c.height, r, 0, 7); ctx.stroke();
    }
  });
}

function testStep(/** @type {any[][]} */ people, /** @type {(string|null)[]} */ gestures, /** @type {string|null} */ gesture, /** @type {number} */ progress, /** @type {string|null} */ fire) {
  /** @type {HTMLElement} */ ($('#poseMeter')).style.transform = `scaleX(${gesture === 'circle' ? progress : 0})`;
  const status = $('#poseStatus');
  if (fire === 'circle') {
    const who = people[gestures.indexOf('circle')];
    // The preview is mirrored, so a player standing on the screen's left shows up on the camera's right.
    const onLeft = 1 - torsoX(who) < 0.5;
    finishPoseTest(/** @type {Team} */ (sides[onLeft ? 0 : 1].dataset.team));
  } else if (gesture === 'cross') status.textContent = 'X 동작이 보여요 — 경기 중엔 상대 팀 +1입니다. 테스트는 머리 위 O로 해 주세요.';
  else if (gesture === 'circle') status.textContent = 'O 인식 중… 그대로 유지하세요';
  else if (!people.length) status.textContent = '사람을 찾는 중… 상체와 두 팔이 화면에 다 보이게 서 주세요.';
  else status.textContent = `${people.length}명 보임 · 머리 위로 크게 O를 만들어 주세요.`;
}

function openPoseTest() {
  poseMode = 'test'; hold.reset();
  $('#poseHoldSec').textContent = String(prefs.pose.holdMs / 1000);
  $('#poseTest').hidden = false; clearPoseTint();
  $('#poseStatus').textContent = '카메라와 AI 모델을 준비하는 중… 처음에는 몇 초 걸려요.';
  /** @type {HTMLElement} */ ($('#poseMeter')).style.transform = 'scaleX(0)';
  placeVideo(true);
  startCamera().then(() => { if (poseMode === 'test') { placeVideo(true); $('#poseStatus').textContent = '사람을 찾는 중…'; } })
    .catch(e => { $('#poseStatus').textContent = e.message; });
}
function closePoseTest() { $('#poseTest').hidden = true; placeVideo(false); poseCanvas.getContext('2d')?.clearRect(0, 0, poseCanvas.width, poseCanvas.height); }
function goLive() { poseMode = 'live'; hold.reset(); renderPoseToggle(); }

// Top-right switch: off → run the test (which turns it on); on → camera off.
const poseToggle = $('#poseToggle');
function renderPoseToggle() {
  const on = poseMode === 'live';
  poseToggle.classList.toggle('on', on);
  poseToggle.setAttribute('aria-pressed', String(on));
  $('#poseToggleText').textContent = on ? 'AI 포즈 켜짐' : 'AI 포즈 꺼짐';
}
poseToggle.addEventListener('click', () => {
  poseToggle.blur();
  if (poseMode !== 'live') { openPoseTest(); return; }
  stopCamera(); prefs.pose.enabled = false; savePrefs();
  toast('AI 포즈 스코어링을 껐습니다. 다시 누르면 테스트 후 켜집니다.');
});

let poseDoneTimer = 0;
function finishPoseTest(/** @type {Team} */ team) {
  prefs.pose.enabled = true; savePrefs();
  closePoseTest(); goLive();
  setPoseTeam(team);
  tone(SOUND.end, 0.13);
}
/** The tested team is the one the camera faces, and serves first if the match has not started. */
function setPoseTeam(/** @type {Team} */ team) {
  prefs.pose.team = team; savePrefs();
  const fresh = !derive(match).started;
  if (fresh) { match.settings.firstServer = team; saveMatch(); }
  render();
  const side = sideOf(team) === sides[0] ? '왼쪽' : '오른쪽';
  $('#poseDoneText').textContent = `${side} · ${name(team)} 쪽을 보고 있어요.${fresh ? ` ${name(team)}이(가) 먼저 서브합니다.` : ''} 이제 경기를 시작하세요.`;
  const done = $('#poseDone');
  done.hidden = false;
  clearTimeout(poseDoneTimer);
  poseDoneTimer = window.setTimeout(() => { done.hidden = true; }, 4500);
}
$('#poseFlip').addEventListener('click', e => { /** @type {HTMLElement} */ (e.currentTarget).blur(); setPoseTeam(other(/** @type {Team} */ (prefs.pose.team))); });
$('#poseCancel').addEventListener('click', () => { closePoseTest(); stopCamera(); prefs.pose.enabled = false; savePrefs(); });
$('#poseSkip').addEventListener('click', () => {
  closePoseTest(); prefs.pose.enabled = true; prefs.pose.team ??= prefs.ourTeam; savePrefs(); goLive();
  toast(`AI 포즈 스코어링 켜짐 · 카메라 쪽 팀: ${name(/** @type {Team} */ (prefs.pose.team))}`);
});

function renderPoseSettings() {
  const on = prefs.pose.enabled;
  $('#poseState').textContent = on ? `켜짐 · 카메라 쪽 팀: ${name(/** @type {Team} */ (prefs.pose.team ?? prefs.ourTeam))}` : '꺼짐';
  $('#poseTestBtn').textContent = on ? '다시 테스트' : '켜고 테스트';
  $('#poseOffBtn').hidden = !on;
  /** @type {HTMLInputElement} */ ($('#poseHold')).value = String(prefs.pose.holdMs);
  $('#poseHoldOut').textContent = `${(prefs.pose.holdMs / 1000).toFixed(1)}초`;
}
$('#poseTestBtn').addEventListener('click', () => { /** @type {HTMLDialogElement} */ ($('#settingsSheet')).close(); openPoseTest(); });
$('#poseOffBtn').addEventListener('click', () => { stopCamera(); prefs.pose.enabled = false; savePrefs(); renderPoseSettings(); toast('AI 포즈 스코어링을 껐습니다. 카메라가 꺼졌어요.'); });
$('#poseHold').addEventListener('input', e => { prefs.pose.holdMs = hold.opts.holdMs = Number(/** @type {HTMLInputElement} */ (e.target).value); savePrefs(); renderPoseSettings(); });

applyTheme();
fitScores();
saveMatch();
render();
renderRemote();
active();
if (prefs.intro) showIntro();
if (prefs.pose.enabled) {
  goLive();
  startCamera().catch(e => { stopCamera(); toast(`AI 포즈 스코어링을 켜지 못했습니다. ${e.message}`, 4000); });
}
