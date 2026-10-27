// @ts-check
// Pure match logic. The score is never stored directly: it is always rebuilt
// from the ordered event log, so cancelling any point restores serve/game state too.

export const DEFAULT_RULES = {target: 21, winBy: 2, cap: 30, gamesToWin: 2};
export const TEAMS = /** @type {const} */ (['A', 'B']);
export const other = (/** @type {'A'|'B'} */ team) => (team === 'A' ? 'B' : 'A');

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/** @param {{names?: {A: string, B: string}, rules?: Partial<typeof DEFAULT_RULES>, firstServer?: 'A'|'B'}} [options] @param {number} [now] */
export function newMatch(options = {}, now = Date.now()) {
  return {
    id: uid(), version: 1, createdAt: now,
    settings: {
      names: {A: '우리 팀', B: '상대 팀', ...options.names},
      rules: {...DEFAULT_RULES, ...options.rules},
      firstServer: options.firstServer ?? 'A',
    },
    events: [{id: uid(), seq: 1, type: 'start', t: now, elapsed: 0, source: 'app'}],
  };
}

/** @param {any} match @param {Record<string, any>} event @param {number} [now] */
function append(match, event, now = Date.now()) {
  const last = match.events[match.events.length - 1];
  const t = Math.max(now, last.t);
  const record = {id: uid(), seq: last.seq + 1, t, elapsed: t - match.events[0].t, ...event};
  match.events.push(record);
  return record;
}

/** @param {{A: number, B: number}} s @param {typeof DEFAULT_RULES} r @returns {'A'|'B'|null} */
export function gameWinner(s, r) {
  for (const team of TEAMS) {
    const mine = s[team], theirs = s[other(team)];
    if (mine >= r.cap || (mine >= r.target && mine - theirs >= r.winBy)) return team;
  }
  return null;
}

/** Rebuilds every derived value from the event log. @param {any} match */
export function derive(match) {
  const rules = match.settings.rules;
  const cancelled = new Set(match.events.filter((/** @type {any} */ e) => e.type === 'cancel').map((/** @type {any} */ e) => e.target));
  const newGame = (/** @type {'A'|'B'} */ server, /** @type {number} */ t) => ({scores: {A: 0, B: 0}, winner: /** @type {'A'|'B'|null} */ (null), server, startServer: server, startT: t, endT: /** @type {number|null} */ (null), points: /** @type {any[]} */ ([])});
  const games = [newGame(match.settings.firstServer, match.events[0].t)];
  const gamesWon = {A: 0, B: 0};
  const rows = [];
  /** @type {any[]} */ const active = [];
  let swapped = false;
  let matchWinner = /** @type {'A'|'B'|null} */ (null);
  for (const e of match.events) {
    const game = games[games.length - 1];
    const live = !cancelled.has(e.seq);
    let applied = false;
    if (live && e.type === 'point' && !game.winner && !matchWinner) {
      game.scores[/** @type {'A'|'B'} */ (e.team)] += 1;
      game.server = e.team;
      game.points.push(e);
      applied = true;
      const winner = gameWinner(game.scores, rules);
      if (winner) {
        game.winner = winner; game.endT = e.t; gamesWon[winner] += 1;
        if (gamesWon[winner] >= rules.gamesToWin) matchWinner = winner;
      }
    } else if (live && e.type === 'nextGame' && game.winner && !matchWinner) {
      games.push(newGame(game.winner, e.t));
      if (e.swap) swapped = !swapped;
      applied = true;
    } else if (e.type === 'swap') {
      swapped = !swapped;
      applied = true;
    }
    if (applied && e.type !== 'swap') active.push(e);
    const current = games[games.length - 1];
    rows.push({event: e, cancelled: cancelled.has(e.seq), applied: applied || e.type === 'cancel' || e.type === 'start',
      game: games.length, score: {...current.scores}});
  }
  const game = games[games.length - 1];
  return {games, game, gameNo: games.length, scores: game.scores, server: game.server, gamesWon, matchWinner,
    gameOver: Boolean(game.winner), swapped, rows, active, rules, started: games.length > 1 || game.points.length > 0};
}

/** @param {any} match @param {'A'|'B'} team @param {string} source @param {number} [now] */
export function scorePoint(match, team, source, now) {
  const state = derive(match);
  if (state.gameOver || state.matchWinner) return null;
  return append(match, {type: 'point', team, source}, now);
}

/** Cancels this team's most recent point in the current game. @param {any} match @param {'A'|'B'} team @param {string} source @param {number} [now] */
export function cancelTeamPoint(match, team, source, now) {
  const state = derive(match);
  const target = [...state.game.points].reverse().find(p => p.team === team);
  if (!target) return null;
  return append(match, {type: 'cancel', target: target.seq, team, reason: 'team', source}, now);
}

/** Cancels the latest point (or the move to a new game) across both teams. @param {any} match @param {string} source @param {number} [now] */
export function undoLast(match, source, now) {
  const target = derive(match).active.at(-1);
  if (!target) return null;
  return append(match, {type: 'cancel', target: target.seq, team: target.team ?? null, reason: 'undo', source}, now);
}

/** Players change ends between games, so the display can swap with it (undone together). @param {any} match @param {string} source @param {boolean} swap @param {number} [now] */
export function startNextGame(match, source, swap, now) {
  const state = derive(match);
  if (!state.gameOver || state.matchWinner) return null;
  return append(match, {type: 'nextGame', source, swap}, now);
}

/** @param {any} match @param {string} source @param {number} [now] */
export function swapSides(match, source, now) {
  return append(match, {type: 'swap', source}, now);
}

/** Right service court on an even score, left on odd (rally-point scoring). @param {any} state */
export function serviceCourt(state) {
  return state.scores[state.server] % 2 === 0 ? '오른쪽' : '왼쪽';
}

/** True right when the leader reaches the mid-game interval of a deciding game. @param {any} state */
export function isDecidingInterval(state) {
  const {rules, gamesWon, scores} = state;
  const deciding = gamesWon.A === rules.gamesToWin - 1 && gamesWon.B === rules.gamesToWin - 1;
  const mid = Math.ceil(rules.target / 2);
  const top = Math.max(scores.A, scores.B);
  return deciding && top === mid && Math.min(scores.A, scores.B) < mid;
}

/** Longest run of consecutive points per team in a list of points. @param {any[]} points */
export function longestRuns(points) {
  const best = {A: 0, B: 0};
  let team = null, run = 0;
  for (const p of points) {
    run = p.team === team ? run + 1 : 1;
    team = p.team;
    best[/** @type {'A'|'B'} */ (team)] = Math.max(best[/** @type {'A'|'B'} */ (team)], run);
  }
  return best;
}

/** Flat CSV of the whole timeline for spreadsheets. @param {any} match */
export function toCsv(match) {
  const {names} = match.settings;
  const label = {start: '경기 시작', point: '득점', cancel: '취소', nextGame: '다음 게임', swap: '코트 교대', end: '경기 종료'};
  const lines = [['순서', '시각', '경과(초)', '게임', '입력', '팀', '입력 수단', '취소 대상', '무효', `${names.A}`, `${names.B}`].join(',')];
  for (const r of derive(match).rows) {
    const e = r.event;
    const cells = [e.seq, new Date(e.t).toISOString(), (e.elapsed / 1000).toFixed(1), r.game,
      /** @type {any} */ (label)[e.type] ?? e.type, e.team ? names[e.team] : '', e.source ?? '', e.target ?? '', r.cancelled ? 'Y' : '', r.score.A, r.score.B];
    lines.push(cells.map(c => /[",\n]/.test(String(c)) ? `"${String(c).replaceAll('"', '""')}"` : String(c)).join(','));
  }
  return lines.join('\n');
}
