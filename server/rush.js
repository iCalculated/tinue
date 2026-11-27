// Rush and Streak (Lichess Puzzle Storm / Puzzle Streak rules): runs of puzzles that climb in rating, judged in the
// browser (public/rush-rules.js; a move off the line as the puzzle page judges it, public/rush.js), never rated. Three routes and three tables of their own; nothing here writes to users,
// puzzles, attempts or the attempt ledger, and the normal picker never sees any of it.
//
// 6×6 only (Shy, 2026-11-18): every route takes size=6 and refuses anything else, a missing size included. The tables
// keep their size column; rows of other sizes from before stay, and nothing reads them.
//
//   GET  /api/rush/run?mode=rush|streak&size=6[&run=R&start=N&exclude=id,id]
//        -> { mode, size, start, run, sig, puzzles }   (no run: a new run R is minted; with one, its next page)
//   POST /api/rush/result  { mode, size, score, moves, errors, bestCombo, units, ms, build, run, pages: [{ start, ids, sig }],
//                            puzzles: [...], env?, abandoned?, guest: { gid } }  -> { id, best, newBest }
//        each puzzle may carry mv: [{ first, ms, held?, weight, correct }], hidden, unfinished, sym (see rush_moves below);
//        a move off the line also check, checkMs, final?, finalMs?, paused, path, open?, po: { proven, cap, end, paused, line } (rush_playouts),
//        and credit? (a solved one's combo credit: see "Combo credit" below);
//        the run, paused (its engine time in all). Older posts without them are still taken.
//        env: { input: touch|mouse|both, confirm, calm, width: phone|tablet|desktop }. A post without them is stored
//        with NULLs. abandoned: true for a run left unfinished (the player left the view or closed the tab after a move):
//        stored like any other, never counted for bests or the top list. A run token posts once, finished or not.
//   GET  /api/rush/best?size=6              -> { best: { rush: { today, week, all }, streak: {...} } }   (your own)
//   GET  /api/rush/top?mode=&size=6         -> { top: [{ name, score, ts, named, you? }] }   (every player's best run)
//   POST /api/rush/top?mode=&size=6  { guest: { gid } }   the same, for a tokenless visitor to have their row marked
//        (the gid goes in the body, never a URL). Guests (no name, or no token) are "Guest 1234" (see guestLabel).
//
// Who: a token (account or guest) is the player, as everywhere else. A visitor without one is NOT made a guest here
// (newGuest replays old guest results into attempts, which Rush must not cause): the run is kept under the browser's
// gid instead, and joins that player's runs once a token arrives (users.gid). Their best scores come back in each
// POST answer; GET /api/rush/best knows them only by token.
//
// What a post can claim (as Storm signs its puzzle set): every page of a run carries the server's signature over the
// run and its ids, the post sends the pages back, and only those puzzles, in the order handed out, can be in it; a run
// is posted once. Then cheap bounds (plausible): moves, errors and combo agree with the puzzles; a Rush lasts no longer
// than 3:00 plus the most bonus time its correct moves could earn; the puzzles' times fit in the run's.
//
// Reading the per-puzzle data (rush_puzzles: one row per puzzle shown in a finished, posted run). For later rating work:
//   puzzle_id, pos (0-based place in the run), mode, solved (1/0), skipped (streak's one skip), ms (from the puzzle
//   being playable to solved/failed), wrong (the first wrong move, canonical PTN, else NULL), clock_ms (rush: clock
//   left when the puzzle ended), combo (rush: combo after it, in combo units: from 2026-11-18 a correct stack move adds
//   the squares it drops on, up to 5, a placement 1; rows before count moves; from 2026-11-19 a puzzle solved by a move
//   off its line adds that move's credit, see "Combo credit"), puzzle_rating (puzzles.rating when the run was posted),
//   user_id / user_rating (NULL for a tokenless visitor; the player's rated-puzzle rating otherwise).
//   Times: ts, day and week are when the post arrived (best scores go by them), and user_rating and puzzle_rating are
//   as of then, not of play. A run may be posted long after it was played (a queued result, up to 30 days): rush_runs
//   has minted_at (the run token's mint time; a spare's may be days before play), played_at (when it ended on the
//   player's device, clamped between minted_at and ts; NULL in older rows) and late (1: posted over 10 minutes after
//   played_at). When mining, filter late rows, or re-join ratings by played_at's date. units: the combo units posted.
//   Per-move times are stored capped so a puzzle's together never exceed its ms (itself capped at a day).
//   E.g. solve rate and median time per puzzle, rush only, people with a rating:
//     SELECT puzzle_id, COUNT(*) n, AVG(solved) rate, AVG(ms) ms FROM rush_puzzles
//       WHERE mode = 'rush' AND user_rating IS NOT NULL AND NOT skipped GROUP BY puzzle_id HAVING n >= 5;
//   Also: hidden (1 when the page was hidden or lost focus while the puzzle was on screen: its times are unreliable),
//   nmoves (the player's moves in it), unfinished (1: the puzzle an abandoned run was left on). Per run (rush_runs):
//   abandoned, input (touch / mouse / both), confirm (Confirm moves on), calm (reduced motion), width (phone / tablet /
//   desktop by viewport width). Nothing that identifies a device: no user agent, no screen size.
//
// Per move (rush_moves: one row per move the player made in a posted puzzle; run_id, pos join rush_puzzles):
//   n (0-based, the player's moves only), first_ms (from the board taking input for this move, after the intro or once
//   the reply is on the board, to the first tap, click or key toward it; NULL if none was seen), ms (to the move being
//   made: with Confirm moves, to the confirmation), held_ms (Confirm moves: to the move being held, before confirming),
//   weight (squares it dropped on; 1 for a placement), correct (1/0; a miss is the last move of its puzzle), at_ms (from
//   the run's clock start, the player's first move of the run in either mode, to this move being made; non-decreasing
//   through the run), ptn (the move, canonical PTN), clock_ms (Rush: the clock left just after it, bonus or penalty
//   applied; NULL in Streak). NULL in rows posted before 2026-11-18's trajectory fields.
//   One run's trajectory, in order (combo is the puzzle's, after it):
//     SELECT m.run_id, m.pos, m.n, m.ptn, m.correct, m.first_ms, m.ms, m.at_ms, m.clock_ms, p.combo, p.puzzle_id, p.puzzle_rating
//       FROM rush_moves m JOIN rush_puzzles p ON p.run_id = m.run_id AND p.pos = m.pos
//       WHERE m.run_id = :run ORDER BY m.pos, m.n;
//   Every attempt at one puzzle across runs, with the player, their rating, the result and the first move's first input:
//     SELECT p.run_id, r.user_id, r.gid, p.user_rating, r.mode, r.abandoned, p.solved, p.skipped, p.unfinished, p.hidden,
//         p.wrong, p.ms, m.first_ms AS first_input_ms, p.ts
//       FROM rush_puzzles p JOIN rush_runs r ON r.id = p.run_id
//       LEFT JOIN rush_moves m ON m.run_id = p.run_id AND m.pos = p.pos AND m.n = 0
//       WHERE p.puzzle_id = :P ORDER BY p.ts;
//   E.g. median time to first input on the first move of puzzle P, solved attempts not hidden, by player rating band:
//     WITH t AS (
//       SELECT CAST(p.user_rating / 200 AS INTEGER) * 200 AS band, m.first_ms AS x
//       FROM rush_puzzles p JOIN rush_moves m ON m.run_id = p.run_id AND m.pos = p.pos AND m.n = 0
//       WHERE p.puzzle_id = :P AND p.solved AND p.hidden = 0 AND p.user_rating IS NOT NULL AND m.first_ms IS NOT NULL),
//     r AS (SELECT band, x, ROW_NUMBER() OVER (PARTITION BY band ORDER BY x) i, COUNT(*) OVER (PARTITION BY band) n FROM t)
//     SELECT band, n, x AS median_first_ms FROM r WHERE i = (n + 1) / 2 ORDER BY band;
//
// Moves off the line (2026-11-19; Sasha: "use the same adjudication flows for the main game"): a legal move that isn't in
// the puzzle's line and doesn't win on the spot is judged as the puzzle page judges it: a listed alternative (alts,
// altsAt) or the still-wins check's proof is a win to play out against Syntaks within a move limit (judge.js capMoves), its
// refutation a mistake, an undecided one played out (the game decides; a proof mid-game makes it a proven play-out).
// Two differences since 2026-11-21: Rush keeps the move cap, where the puzzle page has the Tak rule (shared/judge.js), and
// its own words.
// The Rush clock is paused while the engine works (the check, the defender thinking or loading, a wait at the limit) and
// runs whenever the player is to move. Per move (rush_moves, NULL where no check ran):
//   check_v ('wins' | 'no' | 'pending': the quick check's answer; 'unknown': the check's worker failed or was stopped;
//   'alt': a listed alternative, no check; 'checking': left before the check answered), check_ms (the quick check's
//   time), final_v / final_ms (the check's final answer, 'wins' | 'no' | 'unknown', and its time from the check's start,
//   when it came while the move was open: a proof or refutation mid-game, or the answer that decided a wait; NULL when it
//   didn't), paused_ms (engine time the clock was stopped for on this move, the check's included; a pause past its bound,
//   a page frozen meanwhile, is charged to the clock beyond it), open (1: left or out of time before it was decided: the
//   puzzle is unfinished, the move neither right nor wrong), path (the puzzle's moves before it, both sides,
//   space-joined). correct is how it was decided (a won play-out is correct). Times on a hidden puzzle are capped.
// Combo credit (2026-11-19; Sasha: "play out should get the intended solution combo (minus however many moves have already
// been made)"): a move off the line that counts as solved (a won or proved play-out, or a proof with no play-out) adds to
// the combo what the puzzle's own solution still had from where the player left it: the sum of weight over the solver's
// moves on the principal line (View solution's: the first-listed move at each node, then the first legal finisher at a
// 'win' node) from the node at path, that node's own move included (public/rush-rules.js lineCredit, computed in the
// puzzle's own orientation). The moves made on the line before it were counted as they were made; the play-out's own
// length is irrelevant. rush_moves.credit stores it, on that move only; weight stays the fact (the squares the move
// itself dropped on). The server recomputes credit from the stored tree and the posted path (which must be the puzzle's
// moves posted before it) and takes it when equal; where the stored tree was re-ordered or re-solved since the puzzle was
// handed out, a credit up to the most any line through it earns from there (or, the path gone from it, the solver's moves
// left at MAX_DROPS each) is taken as posted, the combo the run counted; past that the post is refused (cleanCredit). NULL credit: the move counted its weight (every move judged by the line, a mistake, a move
// winning on the spot, and solved off-line moves posted before this or by a client from before it). Combo units of a
// move, for mining: CASE WHEN correct THEN COALESCE(credit, weight) ELSE 0 END; e.g. per run (equal to rush_runs.units
// where every puzzle posted its moves):
//     SELECT run_id, SUM(CASE WHEN correct THEN COALESCE(credit, weight) ELSE 0 END) AS units FROM rush_moves GROUP BY run_id;
// Per play-out (rush_playouts; run_id, pos, n join rush_moves): proven (1: played out as a known win), cap (the move
// limit, the player's moves counting the one played out), ending (win | proved: solved; road | held | out | gaveup:
// a mistake; noengine: the check decided, or open if it hadn't yet; left | time: open), paused_ms (its part of the move's paused_ms), moves (JSON
// [{ m, ms }]: the defender's reply and its think time, then the player's move and the time to make it, and so on).
// Per run, rush_runs.paused_ms (NULL before; 0 when nothing paused); per puzzle, rush_puzzles.sym (0..7: the symmetry
// it was shown under, shared/sym.js; every move stored is in the puzzle's own orientation, so rows line up across runs).
// Clock time: ms and first_ms stay the time to make a move (the clock ran through them); at_ms stays real time since the
// run's clock start, so a Rush move's clock time is at_ms less the paused_ms of the moves decided before it, e.g.
//     SELECT m.pos, m.n, m.at_ms - COALESCE((SELECT SUM(x.paused_ms) FROM rush_moves x WHERE x.run_id = m.run_id
//         AND (x.pos < m.pos OR (x.pos = m.pos AND x.n < m.n))), 0) AS clock_at_ms
//       FROM rush_moves m WHERE m.run_id = :run ORDER BY m.pos, m.n;
//   and rush_runs.ms - paused_ms is a run's time on the clock (its ms stays real time). A puzzle's ms includes its pause.
//   Every off-line verdict is the browser's: the server bounds the times (each pause within the puzzle page's engine
//   limits plus slack by what the move went through, rush-rules.js pauseMax; the run's within the sum of its moves')
//   but can't re-judge; path, ptn, check_v and the play-out's
//   moves are kept so a verdict can be checked again offline. (credit, unlike the verdict, is recomputed: see above.)
//
//   Caveats on times: late in a Rush the clock presses (clock_ms says how much was left); ms - first_ms is entry time,
//   larger for a spread (weight) and on touch, so think-time is best read from first_ms; with Confirm moves ms
//   includes the confirming (use held_ms); hidden puzzles' times are unreliable; abandoned runs (rush_runs.abandoned)
//   end on a puzzle left half-done (unfinished); a first move's clock opens only once the intro has played.
//
//   Caveats: every row is the browser's word. The server checks that the puzzles were handed out to that run and that
//   the numbers are plausible, not that the moves were made: weigh rows by player, not one by one. A run is posted when
//   it ends by itself (the clock, or a streak's miss), or as abandoned when left after a move. Before 2026-11-19 judging
//   had no engine, so a "failed" row then may be a winning move outside the puzzle's tree (wrong says which), and
//   puzzles listing other winning moves were never in a run; late rush puzzles are played against the clock. Nothing
//   reads these rows to change a rating.
import crypto from 'node:crypto';
import { served, pickable, swingPublic } from './puzzle-state.js';
import { PTN_RE, GID_RE, pacificDay } from './common.js';
import { addColumns } from './schema.js';
import { bonusAt, RUSH_MS, MAX_DROPS, PAUSE_MS, pauseMax, CHECKS, FINALS, PO_ENDS, RUN_TTL_MS, SIZE, lineCredit, nodeAt, answerAt, weight } from '../public/rush-rules.js';
import { Game } from '../shared/tak.js';

export const RUN_LEN = 80; // puzzles per request: more than a very strong 3-minute run gets through
// The ramp (see rampTarget): from LO_Q to HI_Q of the pool's rating spread over RAMP_N puzzles. Rating-linear between
// two quantiles, not quantile-linear: a bimodal pool would spend half a run in its big mode. Quantile ends, not fixed
// ratings, as a 6×6 pool's easiest puzzles may already be 2000+ (a pd-only database).
export const RAMP = { rush: { n: 50, pow: 1.2 }, streak: { n: 70, pow: 1.1 } };
const LO_Q = 0.02, HI_Q = 0.98, JITTER = 0.04, NEAR = 6;
// SIZE: the only board size Rush plays
const sizeOk = (v) => String(v) === String(SIZE);
const MODES = new Set(['rush', 'streak']);
// A served pool with fewer puzzles than this gives way to every pickable 6×6 one (see pool).
export const MIN_SERVED = 300;

// A puzzle's intro, as the puzzle page plays it (public/app.js start: the game up to just before the opponent's last
// move, then that move, which stays tinted): { before: TPS, last: PTN } from meta.history. Only these two go out, not
// the game. Null with no history, or one that doesn't reach the puzzle's position (board and side to move).
export function introOf(meta, size, tps) {
  const h = Array.isArray(meta?.history) ? meta.history : [];
  if (!h.length || typeof h.at(-1) !== 'string') return null;
  try {
    const g = new Game(size);
    for (const m of h.slice(0, -1)) g.play(m);
    const before = g.toTPS();
    g.play(h.at(-1));
    const pos = (t) => t.split(' ').slice(0, 2).join(' ');
    return pos(g.toTPS()) === pos(Game.fromTPS(tps).toTPS()) ? { before, last: h.at(-1) } : null;
  } catch { return null; }
}

// A puzzle whose solution ends on the flat count (shared/themes.js gaelet). Rush and Streak are roads only.
export const flatWin = (p) => (p.themes || '').split(',').includes('gaelet');

// Target rating of puzzle i, before jitter.
export function rampTarget(mode, i, lo, hi) {
  const { n, pow } = RAMP[mode];
  return lo + (hi - lo) * Math.min(1, i / n) ** pow;
}

// A run's puzzles from sorted [{id, rating}] (ascending): for each place, the target plus a little noise, then one of
// the NEAR closest puzzles not used yet. rnd: () => [0, 1). Exported for tests.
export function planRun(rows, mode, start, count, used, rnd = Math.random) {
  if (!rows.length) return [];
  const q = (x) => rows[Math.min(rows.length - 1, Math.floor(x * (rows.length - 1)))].rating;
  const lo = q(LO_Q), hi = q(HI_Q), out = [];
  const taken = new Set(used);
  for (let i = start; i < start + count && taken.size < rows.length; i++) {
    const t = rampTarget(mode, i, lo, hi) + (hi - lo) * JITTER * (2 * rnd() - 1);
    // first row with rating >= t, then walk outward collecting unused rows
    let a = 0, b = rows.length;
    while (a < b) { const m = (a + b) >> 1; if (rows[m].rating < t) a = m + 1; else b = m; }
    const near = [];
    for (let l = a - 1, r = a; near.length < NEAR && (l >= 0 || r < rows.length);) {
      const dl = l >= 0 ? t - rows[l].rating : Infinity, dr = r < rows.length ? rows[r].rating - t : Infinity;
      const k = dl <= dr ? l-- : r++;
      if (!taken.has(rows[k].id)) near.push(rows[k]);
    }
    if (!near.length) break;
    const pick = near[Math.floor(rnd() * near.length)];
    taken.add(pick.id); out.push(pick);
  }
  return out;
}

// The Monday that starts a Pacific date's week (the dates are the daily puzzle's: common.js pacificDay).
export function weekOf(day) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const HOUR = 3600e3, DAY = 24 * HOUR;
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const ID = /^[\w.-]{1,40}$/;
const MAX_PUZZLES = 400, MAX_PAGES = 12;
// Streak has no clock: a long run, or a puzzle left open over lunch, is kept with its times capped at a day, not refused.
const STREAK_MS = 1e10;
// A puzzle's board takes no move for its first LOCK_MS (public/rush.js, 250 ms): a played puzzle took at least that.
const MIN_PLAY_MS = 200;
// A run token older than this can't be posted (or paged). 30 days: the browser keeps spare runs fetched ahead to start
// with no connection, and results that couldn't be sent, and both may wait a while.
export const RUN_TTL = RUN_TTL_MS;
const LATE_MS = 10 * 60e3; // a post this long after the run ended is late (a spare's or the queue's: see the top)
// The most bonus time c correct moves can earn: all of them one combo.
export function maxBonus(c) { let t = 0; for (let i = 1; i <= c; i++) t += bonusAt(i); return t; }
// At least the most bonus time `units` combo units can earn in combos of at most `best` each. A run's combos split its
// units, and two combos of 12 earn more than one of 24, so not maxBonus(units): a combo of L ending on a bonus earns
// maxBonus(L), whose rate per unit only grows with L (0.6 s at 5, 0.83 at 30, toward 1 s), so no split beats every
// unit at the rate of the longest combo allowed. Linear in best: a forged post can't make it slow.
export function maxBonusFor(units, best) {
  let t = 0, rate = 0;
  for (let L = 1; L <= Math.min(best, units); L++) { const b = bonusAt(L); if (b) { t += b; rate = t / L; } }
  return Math.ceil(units * rate);
}

// The signed parts (see the top): a run token binds its mode and size; a page's signature binds the run and its ids.
export function signer(key) {
  const mac = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url').slice(0, 22);
  const eq = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return {
    run(mode, size, t) { const r = t.toString(36) + '.' + crypto.randomBytes(9).toString('base64url'); return r + '.' + mac(`run|${r}|${mode}|${size}`); },
    // the run's start time when the token is genuine for this mode and size, else null
    runOk(tok, mode, size) {
      const m = typeof tok === 'string' && tok.length <= 80 && /^([0-9a-z]{1,12}\.[\w-]{12})\.([\w-]{22})$/.exec(tok);
      return m && eq(m[2], mac(`run|${m[1]}|${mode}|${size}`)) ? parseInt(m[1].split('.')[0], 36) : null;
    },
    page: (tok, start, ids) => mac(`page|${tok}|${start}|${ids.join(',')}`),
    pageOk(tok, start, ids, sig) { return eq(sig, mac(`page|${tok}|${start}|${ids.join(',')}`)); },
  };
}

// A posted run, checked and capped; null when anything is off (the whole post is refused). puzzleExists: id -> bool;
// issued: the ids handed out to this run, in order (null: not checked here, as in the pure tests); puzzleOf: id ->
// { size, tps, komi, tree, plies } as stored (its own orientation), to check a move's combo credit by (none given: a
// post with a credit is refused).
export function cleanRun(b, puzzleExists, issued = null, puzzleOf = null) {
  if (!b || typeof b !== 'object' || !MODES.has(b.mode) || !sizeOk(b.size)) return null;
  const mode = b.mode, size = SIZE, streak = mode === 'streak';
  const msMax = streak ? STREAK_MS : HOUR;
  const score = int(b.score, 0, MAX_PUZZLES), moves = int(b.moves, 0, 20000), errors = int(b.errors, 0, MAX_PUZZLES);
  const bestCombo = int(b.bestCombo, 0, 20000), ms = int(b.ms, 0, msMax), build = int(b.build ?? 0, 0, 1e11);
  // units: the combo earned in all (a stack move counts the squares it drops on, rush-rules.js weight); a post without
  // it is read as one per correct move, the rule before.
  const units = b.units == null ? null : int(b.units, 0, 20000 * MAX_DROPS);
  // playedAt: when the run ended on the player's device (wall clock ms); clamped to the token and the post when stored
  const playedAt = b.playedAt == null ? null : Number.isFinite(b.playedAt) ? Math.round(b.playedAt) : undefined;
  if (playedAt === undefined) return null;
  const abandoned = b.abandoned == null ? false : b.abandoned === true ? true : b.abandoned === false ? false : null;
  const env = cleanEnv(b.env);
  // paused: the engine time the run's clock was stopped for (adjudicated moves); a post without it had none
  const paused = b.paused == null ? 0 : int(b.paused, 0, msMax);
  if (abandoned === null || env === null || paused == null) return null;
  if ([score, moves, errors, bestCombo, ms, build].includes(null) || (b.units != null && units == null) || !Array.isArray(b.puzzles) || b.puzzles.length > MAX_PUZZLES) return null;
  const rows = [], seen = new Set();
  let skips = 0, at = -1;
  for (const p of b.puzzles) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !ID.test(p.id) || seen.has(p.id) || !puzzleExists(p.id)) return null;
    if (issued) { const i = issued.indexOf(p.id, at + 1); if (i < 0) return null; at = i; } // handed out, in that order
    if (typeof p.solved !== 'boolean') return null;
    const skipped = p.skipped === true;
    const pms = int(p.ms, 0, msMax), clock = p.clock == null ? null : int(p.clock, 0, HOUR), combo = p.combo == null ? null : int(p.combo, 0, 20000);
    if (pms == null || (p.clock != null && clock == null) || (p.combo != null && combo == null)) return null;
    if (!skipped && p.unfinished !== true && pms < MIN_PLAY_MS) return null; // (an unfinished one may have just appeared)
    const wrong = p.wrong == null ? null : typeof p.wrong === 'string' && p.wrong.length <= 24 && PTN_RE.test(p.wrong) ? p.wrong : undefined;
    if (wrong === undefined || (skipped && p.solved)) return null;
    // the last puzzle may be unfinished: an abandoned run's, left half-done, or a Rush's on the board when time ran out
    const unfinished = p.unfinished === true;
    if ((p.unfinished != null && typeof p.unfinished !== 'boolean') || (unfinished && ((!abandoned && streak) || p.solved || skipped || wrong))) return null;
    const hidden = p.hidden == null ? null : typeof p.hidden === 'boolean' ? p.hidden : undefined;
    // (the stored puzzle only when a move claims a credit: it is recomputed from the tree)
    const credited = Array.isArray(p.mv) && p.mv.some((m) => m?.credit != null);
    const mv = p.mv == null ? null : cleanMoves(p.mv, pms, unfinished || skipped ? 'none' : p.solved ? 'none' : 'last', { open: unfinished, hidden: hidden === true, puzzle: credited && puzzleOf ? puzzleOf(p.id) : null });
    // sym: the symmetry the puzzle was shown under (shared/sym.js, 0..7); moves are posted turned back
    const sym = p.sym == null ? null : int(p.sym, 0, 7);
    if (hidden === undefined || mv === undefined || (mv && !mv.filter((m) => !m.open).length && !skipped && !unfinished) || (p.sym != null && sym == null)) return null;
    if (skipped) skips++;
    seen.add(p.id);
    rows.push({ id: p.id, solved: p.solved, skipped, ms: pms, wrong, clock, combo, unfinished, hidden, mv, sym });
  }
  if (rows.some((r, i) => r.unfinished && i !== rows.length - 1)) return null; // only the one it was left on
  // The per-move rows agree with the run: no more moves than it made, its misses, and no more combo than its units.
  // (an open move, still being adjudicated when the run was left, counts as neither)
  const withMv = rows.filter((r) => r.mv), decided = (r) => r.mv.filter((m) => !m.open);
  if (withMv.reduce((t, r) => t + decided(r).length, 0) > moves) return null;
  if (withMv.length === rows.length && withMv.reduce((t, r) => t + decided(r).filter((m) => !m.correct).length, 0) !== errors) return null;
  // (a solved move off the line counts its credit, the combo the puzzle's line had left, where it carries one)
  if (withMv.reduce((t, r) => t + r.mv.reduce((w, m) => w + (m.correct ? m.credit ?? m.weight : 0), 0), 0) > (units ?? moves - errors)) return null;
  if (rows.filter((r) => r.solved).length !== score) return null; // the score is the puzzles solved
  if (skips > (streak ? 1 : 0)) return null;
  const failed = rows.filter((r) => !r.solved && !r.skipped && !r.unfinished).length;
  if (streak && failed > 1) return null; // the first miss ends a streak
  // Every miss is one wrong move that ends its puzzle; every solve took at least one correct move; the combo units are
  // 1 to MAX_DROPS per correct move (a credited move: its credit, checked in cleanMoves, which may be more), and the best
  // combo is some of them.
  const right = moves - errors, earned = units ?? right;
  const over = rows.flatMap((r) => r.mv || []).reduce((t, m) => t + (m.correct && m.credit != null ? Math.max(0, m.credit - MAX_DROPS) : 0), 0);
  if (errors !== failed || right < score || earned < right || earned > right * MAX_DROPS + over || bestCombo > earned) return null;
  // the bonuses those combos could have earned (a post without units: the bound it always had)
  const most = streak ? 0 : units == null ? maxBonus(right) : maxBonusFor(earned, bestCombo);
  // The engine's pauses: the run's total is within the sum of its moves' (each bounded in cleanMoves) and its time; the
  // clock's own time (real time less the pauses) is within 3:00 and its bonuses.
  const parts = rows.flatMap((r) => r.mv || []).reduce((t, m) => t + (m.paused ?? 0), 0);
  if (paused > parts + 1000 || paused > ms) return null;
  if (!streak && ms - paused > RUSH_MS + most + 2000) return null; // 3:00 and its bonuses
  if (!streak && rows.some((r) => r.clock != null && (r.clock > RUSH_MS + most || (r.combo != null && r.combo > bestCombo)))) return null;
  // The trajectory: each move's time from the clock start goes forward through the run and ends within it; its clock
  // (Rush only) is within the clock's bounds.
  let last = -1;
  for (const m of rows.flatMap((r) => r.mv || [])) {
    if (m.at != null) { if (m.at < last || m.at > ms + 2000) return null; last = m.at; }
    if (m.clock != null && (streak || m.clock > RUSH_MS + most)) return null;
  }
  // The puzzles after the one the clock started on were all played inside the run's time (each rounded: 1 ms apiece).
  const first = rows.findIndex((r) => !r.skipped);
  if (first >= 0 && rows.slice(first + 1).reduce((t, r) => t + r.ms, 0) > ms + rows.length) return null;
  return { mode, size, score, moves, errors, bestCombo, units, playedAt, ms: Math.min(ms, 7 * DAY), paused: Math.min(paused, 7 * DAY), build, abandoned, env,
    rows: rows.map((r) => ({ ...r, ms: Math.min(r.ms, DAY), mv: r.mv && capMoves(r.mv, Math.min(r.ms, DAY)) })) };
}
// A puzzle's move times as stored: each within what is left of the puzzle's stored time (itself capped at a day), so
// together they never exceed it; first and held within their move.
export function capMoves(mv, pms) {
  let left = pms;
  return mv.map((m) => {
    const ms = Math.min(m.ms, left), cap = (v) => (v == null ? null : Math.min(v, ms));
    left -= ms;
    return { ...m, ms, first: cap(m.first), held: cap(m.held) };
  });
}
// A run's setting (env): null for none sent; null (refused) for anything but these values.
const ENV = { input: ['touch', 'mouse', 'both'], width: ['phone', 'tablet', 'desktop'] };
function cleanEnv(e) {
  if (e == null) return { input: null, confirm: null, calm: null, width: null };
  if (typeof e !== 'object' || Array.isArray(e)) return null;
  const out = {};
  for (const k of ['input', 'width']) { if (e[k] != null && !ENV[k].includes(e[k])) return null; out[k] = e[k] ?? null; }
  for (const k of ['confirm', 'calm']) { if (e[k] != null && typeof e[k] !== 'boolean') return null; out[k] = e[k] ?? null; }
  return out;
}
// A puzzle's moves (mv), each { first, ms, held?, weight, correct } in whole ms from the board taking it: within the
// puzzle's own time (pms; each opens after the last, so together too), first <= held <= ms, weight 1..MAX_DROPS.
// miss: 'last' (a failed puzzle: its last move, only it, is the wrong one) or 'none' (solved, skipped, unfinished).
// undefined when anything is off.
export const MAX_MV = 30; // far more of the player's moves than any puzzle has
// A move off the puzzle's line is adjudicated as above (public/rush.js): a check (check, checkMs; its
// final answer, final and finalMs, when it came while the move was open), maybe a play-out (po), and the engine time
// the clock was paused for (paused). The bounds are rush-rules.js pauseMax, by what the move went through: the puzzle
// page's own engine limits (playon.js ENGINE_MS, CAP_WAIT_MS) plus slack, the client crediting no more; a hidden puzzle
// gets PAUSE_MS.hidden more (the engines' clocks count visible time only). The server can't re-judge any of it; the
// move, the path before it, the check's verdicts and the play-out's moves are kept for a re-check offline.
export { PO_ENDS };
// A play-out under the Tak rule (judge.js TAK_COUNTDOWN, 2026-11-21: no cap): posted with rule 'tak' and no cap, stored
// with cap 0 (the column is NOT NULL). Its line has no ceiling of the game's own; only its first MAX_TAK_LINE plies are
// stored (the line is only kept for a re-check offline): all of it is still checked, and a longer one is cut rather
// than refusing the run, which would lose every puzzle in it. The whole run's body is still at most server.js MAX_BODY bytes (~25 bytes a
// ply): a Rush client posting rule 'tak' must keep its run under that itself (none does yet, 2026-11-21).
export const MAX_TAK_LINE = 600;
// The most moves a capped play-out may post: a proven one's cap grows with its proof (judge.js provenCap, no ceiling),
// so only a sanity bound, the same as a Tak-rule line's.
const MAX_CAP = MAX_TAK_LINE / 2;
// How a play-out's ending squares with the move's result (public/rush-rules.js playOutOutcome): a win or a proof is a
// solve, the defender's game, the limit or Give up a mistake, no engine either (the check decided); left or out of time
// leaves the move open.
// (open: a game left or out of time, or one that had ended but not yet counted: no engine could play it and the check
// hadn't answered, or the clock ran out over a frozen page's pause before it counted; null in posts that left it so)
const END_FOR = { true: new Set(['win', 'proved', 'noengine']), false: new Set(['road', 'held', 'out', 'gaveup', 'noengine']), open: new Set([...PO_ENDS, null]) };
const p0 = (v, max) => (v == null ? 0 : int(v, 0, max));
// opts: { open: an open move may end the list (the puzzle is unfinished), hidden: the puzzle was hidden at some point,
// puzzle: the stored puzzle, to check a credit by (see cleanAdj) }
export function cleanMoves(mv, pms, miss, { open: openOk = false, hidden = false, puzzle = null } = {}) {
  if (!Array.isArray(mv) || mv.length > MAX_MV || pms == null) return undefined;
  const out = [];
  for (const [i, m] of mv.entries()) {
    if (!m || typeof m !== 'object' || typeof m.correct !== 'boolean') return undefined;
    const ms = int(m.ms, 0, pms + 1), first = m.first == null ? null : int(m.first, 0, ms ?? 0), held = m.held == null ? null : int(m.held, first ?? 0, ms ?? 0);
    const weight = int(m.weight, 1, MAX_DROPS);
    // the trajectory (checked across the run in cleanRun): at from the run's clock start, the move, the clock after it
    const at = m.at == null ? null : int(m.at, 0, STREAK_MS), clock = m.clock == null ? null : int(m.clock, 0, HOUR);
    const ptn = m.ptn == null ? null : typeof m.ptn === 'string' && m.ptn.length <= 24 && PTN_RE.test(m.ptn) ? m.ptn : undefined;
    if (ms == null || weight == null || (m.first != null && first == null) || (m.held != null && held == null)
      || (m.at != null && at == null) || (m.clock != null && clock == null) || ptn === undefined) return undefined;
    const adj = cleanAdj(m, i === mv.length - 1, openOk, hidden, pms, puzzle, out);
    if (adj === undefined) return undefined;
    out.push({ first, ms, held, weight, correct: m.correct, at, ptn, clock, ...adj });
  }
  if (out.reduce((t, m) => t + m.ms, 0) > pms + out.length) return undefined;
  const wrongAt = out.findIndex((m) => !m.correct && !m.open);
  if (miss === 'none' ? wrongAt >= 0 : !out.length || wrongAt !== out.length - 1) return undefined;
  return out;
}

// A move's adjudication fields, checked: {} for none (an old post, or a move judged by the line), undefined when
// anything is off. Only a puzzle's last move is ever adjudicated (it decides the puzzle); open only on an unfinished one.
// before: the puzzle's moves posted before it, as cleaned (its path must be theirs, see cleanCredit).
function cleanAdj(m, last, openOk, hidden, pms, puzzle = null, before = []) {
  const has = m.check != null || m.checkMs != null || m.paused != null || m.po != null || m.open != null || m.path != null || m.final != null || m.finalMs != null || m.credit != null;
  if (!has) return {};
  if (!last || !CHECKS.includes(m.check)) return undefined;
  const open = m.open == null ? false : m.open === true && openOk && m.correct === false ? true : undefined;
  const more = hidden ? PAUSE_MS.hidden : 0;
  const checkMs = m.checkMs == null ? null : int(m.checkMs, 0, PAUSE_MS.check + more);
  const path = m.path == null ? null : Array.isArray(m.path) && m.path.length <= 2 * MAX_MV && m.path.every((x) => typeof x === 'string' && x.length <= 24 && PTN_RE.test(x)) ? m.path : undefined;
  if (open === undefined || (m.checkMs != null && checkMs == null) || path === undefined || ((m.check === 'alt' || m.check === 'checking') && checkMs != null)) return undefined;
  // 'checking': left before the check answered, so open, with no game; the final answer only after an undecided quick one
  if (m.check === 'checking' && (!open || m.po != null)) return undefined;
  const final = m.final == null ? null : FINALS.includes(m.final) ? m.final : undefined, finalMs = m.finalMs == null ? null : int(m.finalMs, 0, PAUSE_MS.final + more);
  if (final === undefined || (m.finalMs != null && finalMs == null) || ((final != null || finalMs != null) && (m.check !== 'pending' && m.check !== 'unknown'))) return undefined;
  let po = null;
  if (m.po != null) {
    const p = m.po;
    if (!p || typeof p !== 'object' || m.check === 'no' || typeof p.proven !== 'boolean' || !Array.isArray(p.line)) return undefined;
    const tak = p.rule === 'tak', end = p.end == null ? null : PO_ENDS.includes(p.end) ? p.end : undefined;
    const cap = tak ? (p.cap == null ? 0 : null) : p.rule == null ? int(p.cap, 1, MAX_CAP) : null;
    // (the game stops at the player's cap-th move: at most cap - 1 replies and cap - 1 more moves of theirs)
    if (cap == null || end === undefined || (!tak && p.line.length > 2 * (cap - 1))) return undefined;
    // the defender replies first (line[0], [2], ...: its think time, paused), then the player (time to move)
    const line = [];
    for (const [j, x] of p.line.entries()) {
      const mine = j % 2 === 1, xms = x && typeof x === 'object' ? int(x.ms, 0, mine ? pms : PAUSE_MS.reply + more) : null;
      if (xms == null || typeof x.m !== 'string' || x.m.length > 24 || !PTN_RE.test(x.m)) return undefined;
      line.push({ m: x.m, ms: xms });
    }
    if (!END_FOR[open ? 'open' : String(m.correct)].has(end)) return undefined;
    po = { proven: p.proven, cap, end, line, paused: null };
  }
  // A solve without a game needs a proof: a listed alternative, the quick check's, or the final answer that decided it;
  // a miss without one, the quick refutation or the final answer that decided it.
  if (!po && !open) {
    if (m.correct ? !(m.check === 'wins' || m.check === 'alt' || final === 'wins') : !(m.check === 'no' || (final != null && final !== 'wins'))) return undefined;
  }
  // The pauses, bounded by what the move went through (pauseMax: the quick check alone after 'no', the run-on only where
  // the final answer was waited on); the check's time was paused time too.
  const bound = pauseMax({ check: m.check, po }, hidden);
  const paused = m.paused == null ? 0 : int(m.paused, 0, bound);
  if (po) { po.paused = p0(m.po.paused, bound); if (po.paused == null) return undefined; }
  if (paused == null || (checkMs != null && checkMs > paused + 1000) || (po && po.paused > paused + 1) || (po && po.line.filter((_, j) => j % 2 === 0).reduce((t, x) => t + x.ms, 0) > po.paused + po.line.length)) return undefined;
  const credit = cleanCredit(m, open, path, puzzle, before);
  if (credit === undefined) return undefined;
  // (a Tak-rule line is checked whole, its pauses bounded by all of it, and only stored cut: MAX_TAK_LINE)
  if (po?.cap === 0 && po.line.length > MAX_TAK_LINE) po.line = po.line.slice(0, MAX_TAK_LINE);
  return { check: m.check, checkMs, final, finalMs, paused, open, path, po, credit };
}
// A solved move off the line's combo credit (public/rush-rules.js lineCredit): null for none (the move counts its own
// weight, as every post before 2026-11-19 and the client live then did), undefined when it is off. Only on a decided,
// correct move whose path is the puzzle's moves posted before it (before: the solver's moves at path[0], [2], ..., all
// correct, so a path can't be rewound to earn line moves already counted again, nor be odd or made up), and then:
// - the line's remainder at that path, recomputed from the stored tree: taken as posted;
// - else, where the path still leads into the stored tree (its listed moves re-ordered or re-solved since the puzzle was
//   handed out, so the client followed another first-listed move): within the most any line through the stored tree
//   earns from there (lineMost), a real line's remainder, not refused for following the tree it was served;
// - else (the path no longer in the stored tree, re-solved since): within the solver's moves left in the stored
//   solution (plies) at MAX_DROPS each, no more than posting those moves as line moves of MAX_DROPS could claim.
const MAX_CREDIT = 40 * MAX_DROPS; // far more than any puzzle's line earns
function cleanCredit(m, open, path, puzzle, before = []) {
  if (m.credit == null) return null;
  const credit = int(m.credit, 1, MAX_CREDIT);
  if (credit == null || m.correct !== true || open || !path || !puzzle) return undefined;
  if (path.length !== 2 * before.length || before.some((b, k) => !b.correct || b.open || b.ptn == null || b.ptn !== path[2 * k])) return undefined;
  let want = null, most = null;
  try { want = lineCredit(puzzle, path); } catch {}
  if (want === credit) return credit;
  if (want != null) { try { most = lineMost(puzzle, path); } catch {} return most != null && credit <= most ? credit : undefined; }
  const left = Math.ceil(Math.max(1, (Number(puzzle.plies) || 1) - path.length) / 2);
  return credit <= left * MAX_DROPS ? credit : undefined;
}
// The most combo any line through the stored tree earns from the node at path (lineCredit's sum, taking at each node
// whichever listed move earns most rather than the first-listed one; a 'win' node's finisher as lineCredit finds it).
// null where no line can be followed. In the puzzle's own orientation, as stored.
export function lineMost(p, path = []) {
  let steps = 0;
  const walk = (node, line) => {
    if (++steps > 2000 || line.length > 4 * MAX_MV) return null;
    if (node === 'win') { let fin = null; try { fin = answerAt(p, line); } catch {} return fin ? weight(fin) : null; }
    if (!node || typeof node !== 'object') return null;
    let best = null;
    for (const [mv, e] of Object.entries(node)) {
      const rest = !e?.r || e.n == null ? 0 : walk(e.n, [...line, mv, e.r]);
      if (rest != null) best = Math.max(best ?? 0, weight(mv) + rest);
    }
    return best;
  };
  return path.length % 2 ? null : walk(nodeAt(p, path), [...path]);
}

// A guest's name on the top lists: "Guest" and four digits from a keyed hash of its player key ('u' + id or 'g' + gid),
// the same every time, telling nothing of the id or gid (two guests may share one).
export function guestLabel(key, player) {
  const h = crypto.createHmac('sha256', key).update('guest|' + player).digest();
  return 'Guest ' + String(h.readUInt32BE(0) % 10000).padStart(4, '0');
}

// Best scores (see bests): params (user_id or gid, mode, size, day from, week from).
export const BEST_SQL = {
  user: 'SELECT MAX(score) s FROM rush_runs WHERE user_id = ? AND mode = ? AND size = ? AND day >= ? AND week >= ? AND abandoned = 0',
  gid: 'SELECT MAX(score) s FROM rush_runs WHERE gid = ? AND user_id IS NULL AND mode = ? AND size = ? AND day >= ? AND week >= ? AND abandoned = 0',
};

export function createRush(db, { now = () => Date.now(), minServed = MIN_SERVED } = {}) {
  db.exec(`
CREATE TABLE IF NOT EXISTS rush_runs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, gid TEXT,       -- the player: a token's user, else a tokenless browser's gid (see server/rush.js)
  named INTEGER NOT NULL DEFAULT 0, -- the user had a name when the run was posted
  mode TEXT NOT NULL,               -- rush | streak
  size INTEGER NOT NULL,            -- 6 (5 and 0 = any in runs posted before Rush was 6×6 only)
  score INTEGER NOT NULL, moves INTEGER NOT NULL, errors INTEGER NOT NULL, best_combo INTEGER NOT NULL,
  ms INTEGER NOT NULL, build INTEGER, user_rating REAL,
  day TEXT NOT NULL, week TEXT NOT NULL, -- Pacific date, and the Monday of its week
  ts INTEGER NOT NULL,
  run TEXT                          -- the run token it was handed (posted once)
);
CREATE UNIQUE INDEX IF NOT EXISTS rush_runs_run ON rush_runs(run);
CREATE INDEX IF NOT EXISTS rush_runs_user ON rush_runs(user_id, mode, size, score);
CREATE INDEX IF NOT EXISTS rush_runs_gid ON rush_runs(gid, mode, size, score);
CREATE TABLE IF NOT EXISTS rush_puzzles (
  run_id INTEGER NOT NULL, pos INTEGER NOT NULL, puzzle_id TEXT NOT NULL, mode TEXT NOT NULL,
  solved INTEGER NOT NULL, skipped INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL, wrong TEXT,
  clock_ms INTEGER, combo INTEGER, puzzle_rating REAL,
  user_id INTEGER, user_rating REAL, ts INTEGER NOT NULL,
  PRIMARY KEY (run_id, pos)
);
CREATE INDEX IF NOT EXISTS rush_puzzles_puzzle ON rush_puzzles(puzzle_id, mode);
CREATE TABLE IF NOT EXISTS rush_key (k TEXT NOT NULL); -- signs run tokens and pages (one row, made once)
CREATE TABLE IF NOT EXISTS rush_moves ( -- one row per move the player made in a posted puzzle (see the top)
  run_id INTEGER NOT NULL, pos INTEGER NOT NULL, n INTEGER NOT NULL,
  first_ms INTEGER, ms INTEGER NOT NULL, held_ms INTEGER, weight INTEGER NOT NULL, correct INTEGER NOT NULL,
  PRIMARY KEY (run_id, pos, n)
);
`);
  // Columns added after the tables first shipped: added once, NULL (or 0) on older rows.
  const add = (table, ...cols) => addColumns(db, table, cols.map((c) => [c.slice(0, c.indexOf(' ')), c.slice(c.indexOf(' ') + 1)]));
  add('rush_runs', 'abandoned INTEGER NOT NULL DEFAULT 0', 'minted_at INTEGER', 'played_at INTEGER', 'late INTEGER', 'units INTEGER',
    'input TEXT', 'confirm INTEGER', 'calm INTEGER', 'width TEXT', 'paused_ms INTEGER');
  add('rush_puzzles', 'hidden INTEGER', 'nmoves INTEGER', 'unfinished INTEGER', 'sym INTEGER');
  // From check_v on: adjudication (2026-11-19; see the top), NULL in older rows and on moves judged by the line. credit:
  // a solved move off the line's combo credit, NULL where it counted its own weight.
  add('rush_moves', 'at_ms INTEGER', 'ptn TEXT', 'clock_ms INTEGER', 'check_v TEXT', 'check_ms INTEGER', 'paused_ms INTEGER',
    'open INTEGER', 'path TEXT', 'final_v TEXT', 'final_ms INTEGER', 'credit INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS rush_playouts ( -- one row per play-out (see the top); run_id, pos, n join rush_moves
  run_id INTEGER NOT NULL, pos INTEGER NOT NULL, n INTEGER NOT NULL,
  proven INTEGER NOT NULL, cap INTEGER NOT NULL, ending TEXT, paused_ms INTEGER NOT NULL,
  moves TEXT NOT NULL,             -- JSON [{ m, ms }]: the defender's reply and its think time, then the player's move and its time, ...
  PRIMARY KEY (run_id, pos, n));`);
  if (!db.prepare('SELECT 1 FROM rush_key').get()) db.prepare('INSERT INTO rush_key (k) VALUES (?)').run(crypto.randomBytes(32).toString('hex'));
  const key = db.prepare('SELECT k FROM rush_key').get().k, sign = signer(key);
  // The top lists' table: every player's best finished run per mode and size (player: 'u' + users.id for a token, or
  // 'g' + gid for a tokenless browser), its first run at that score; kept on insert. Filled from rush_runs once, when
  // it is first made (a database from before guests were listed).
  const leadNew = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rush_lead'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS rush_lead (
  player TEXT NOT NULL, mode TEXT NOT NULL, size INTEGER NOT NULL, score INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (player, mode, size));
CREATE INDEX IF NOT EXISTS rush_lead_top ON rush_lead(mode, size, score DESC, ts);`);
  if (leadNew) db.exec(`INSERT OR IGNORE INTO rush_lead (player, mode, size, score, ts)
    SELECT CASE WHEN user_id IS NOT NULL THEN 'u' || user_id ELSE 'g' || gid END, mode, size, score, ts FROM rush_runs
    WHERE abandoned = 0 AND score > 0 AND (user_id IS NOT NULL OR gid IS NOT NULL) ORDER BY score DESC, ts ASC`); // (the first per player is its best)

  // The puzzles a run may use, 6×6 only, sorted by rating: the served pool (as the Puzzles page's first stage), or,
  // with fewer than MIN_SERVED served puzzles, every pickable one (never paused or rejected: Q11).
  // Never a flat win (theme gaelet: Sasha, 2026-11-26), and never a refunded puzzle (flaw = 2: it called a winning move a miss). Puzzles that list other winning moves (flaw = 1:
  // alts / altsAt) are in (Sasha, 2026-11-19: "known alternatives seem fine to include"): Rush now plays a listed move
  // out as the puzzle page does (public/rush.js), so it no longer has to prove nothing.
  // Rebuilt every 10 minutes after the request that finds it stale (that request gets the old one): ratings drift with
  // rated play, and a few minutes' drift doesn't matter to a ramp. runPuzzle checks each puzzle again as it goes out.
  let cache = null, rebuilding = false;
  function build() {
    const all = [], srv = [];
    for (const r of db.prepare('SELECT id, size, rating, turn, grade, kind, status, flaw, themes FROM puzzles WHERE size = ?').iterate(SIZE)) {
      if (!pickable(r) || r.flaw === 2 || flatWin(r)) continue;
      const row = { id: r.id, rating: r.rating };
      all.push(row);
      if (served(r)) srv.push(row);
    }
    const rows = (srv.length >= minServed ? srv : all).sort((a, b) => a.rating - b.rating || (a.id < b.id ? -1 : 1));
    cache = { t: now(), rows };
  }
  function pool() {
    if (!cache) build();
    else if (now() - cache.t >= 10 * 60e3 && !rebuilding) { rebuilding = true; setImmediate(() => { try { build(); } finally { rebuilding = false; } }); }
    return cache.rows;
  }

  const byId = db.prepare('SELECT id, size, tps, komi, plies, tree, rating, swing, turn, grade, kind, status, flaw, themes, meta FROM puzzles WHERE id = ?');
  const intros = new Map(); // id -> introOf (a game's history doesn't change; one replay per puzzle per process)
  const exists = db.prepare('SELECT 1 FROM puzzles WHERE id = ?');
  // A puzzle as stored, its own orientation: what a combo credit is checked by (cleanRun, only for a credited move).
  const storedQ = db.prepare('SELECT id, size, tps, komi, plies, tree FROM puzzles WHERE id = ?');
  const storedPuzzle = (id) => { const p = storedQ.get(id); if (!p) return null; try { return { ...p, tree: JSON.parse(p.tree) }; } catch { return null; } };
  const ratingOf = db.prepare('SELECT rating FROM puzzles WHERE id = ?');
  // What the browser needs to judge a puzzle by itself: position and tree, the other known wins (alts at the root,
  // altsAt deeper in, as the puzzle endpoint sends them: swingPublic), and its
  // intro (before, last) when the game is on record. Null for a puzzle that has since been paused, rejected, refunded or tagged a flat win
  // (the pool is up to 10 minutes old). The page signature covers ids only, so the intro changes nothing signed.
  function runPuzzle(id) {
    const p = byId.get(id);
    if (!p || p.size !== SIZE || !pickable(p) || p.flaw === 2 || flatWin(p)) return null;
    let alts = {};
    try { const { pre0, ...rest } = swingPublic(p.swing); alts = rest; } catch {}
    if (!intros.has(p.id)) { let m = null; try { m = p.meta ? JSON.parse(p.meta) : null; } catch {} intros.set(p.id, introOf(m, p.size, p.tps)); }
    const intro = intros.get(p.id);
    return { id: p.id, size: p.size, tps: p.tps, komi: p.komi, plies: p.plies, tree: JSON.parse(p.tree), rating: Math.round(p.rating), ...alts, ...(intro || {}) };
  }

  // Best scores. Two indexed lookups, not one OR (which scans every run of the mode and size): the account's runs, and
  // the runs its browser made under its gid before it had a token.
  const bestUser = db.prepare(BEST_SQL.user), bestGid = db.prepare(BEST_SQL.gid);
  function bests(who, size, today, week) {
    if (!who) return null;
    const out = {};
    for (const mode of MODES) {
      const one = (d, w) => {
        const a = who.userId != null ? bestUser.get(who.userId, mode, size, d, w).s : null;
        const b = who.gid != null ? bestGid.get(who.gid, mode, size, d, w).s : null;
        return a == null && b == null ? null : Math.max(a ?? 0, b ?? 0);
      };
      out[mode] = { today: one(today, ''), week: one('', week), all: one('', '') };
    }
    return out;
  }

  // Top lists: every player's best (rush_lead), kept a minute; any change to rush_lead clears them. The index walks
  // down from the top score: 60 rows (room for a gid's runs that joined an account, listed once as that account), then
  // a primary-key or unique-index lookup in users for each. A gid that joined an account (users.gid) counts as it.
  const leadQ = db.prepare('SELECT player, score, ts FROM rush_lead WHERE mode = ? AND size = ? AND score > 0 ORDER BY score DESC, ts ASC LIMIT 60');
  const byUser = db.prepare('SELECT id, name FROM users WHERE id = ?'), byGid = db.prepare('SELECT id, name FROM users WHERE gid = ?');
  const keepLead = db.prepare(`INSERT INTO rush_lead (player, mode, size, score, ts) VALUES (?,?,?,?,?)
    ON CONFLICT (player, mode, size) DO UPDATE SET score = excluded.score, ts = excluded.ts WHERE excluded.score > rush_lead.score`);
  // the player a key stands for: an account's ('u' + id, with its name) when a gid has joined one
  const resolve = (p) => {
    const u = p[0] === 'u' ? byUser.get(+p.slice(1)) : byGid.get(p.slice(1));
    return u ? { key: 'u' + u.id, name: u.name } : { key: p, name: null };
  };
  const tops = new Map();
  function top(mode, size) {
    const k = mode + size, c = tops.get(k);
    if (c && now() - c.t < 60e3) return c.top;
    const seen = new Set(), t = [];
    for (const r of leadQ.all(mode, size)) {
      const who = resolve(r.player);
      if (seen.has(who.key)) continue; // (a gid's runs, joined to an account listed above them)
      seen.add(who.key);
      t.push({ key: who.key, name: who.name ?? guestLabel(key, who.key), named: who.name != null, score: r.score, ts: r.ts });
      if (t.length === 20) break;
    }
    tops.set(k, { t: now(), top: t });
    return t;
  }

  // ctx: { user, body, json, refuse, ip }; refuse(key, max, ms): true when over the limit (answered). Returns false for a route that isn't Rush's.
  async function handle(req, res, url, route, { user, body, json, refuse, ip }) {
    if (!['GET /api/rush/run', 'GET /api/rush/best', 'GET /api/rush/top', 'POST /api/rush/top', 'POST /api/rush/result'].includes(route)) return false;
    const q = Object.fromEntries(url.searchParams);
    const key = user ? 'u' + user.id : ip;

    if (route === 'GET /api/rush/run') {
      if (refuse('rushrun:' + key, 60, 60e3)) return true;
      const size = SIZE, start = Math.min(1000, Math.max(0, Math.trunc(+q.start) || 0));
      if (!MODES.has(q.mode) || !sizeOk(q.size)) return json(res, 400, { error: 'mode: rush or streak; size: 6' }), true;
      let run = q.run;
      if (run == null) run = sign.run(q.mode, size, now());
      else { const t0 = sign.runOk(run, q.mode, size); if (t0 == null || now() - t0 > RUN_TTL) return json(res, 400, { error: 'bad run' }), true; }
      const exclude = (q.exclude || '').split(',').filter((s) => ID.test(s)).slice(0, MAX_PUZZLES);
      const plan = planRun(pool(), q.mode, start, RUN_LEN, exclude);
      const puzzles = plan.map((r) => runPuzzle(r.id)).filter(Boolean);
      return json(res, 200, { mode: q.mode, size, start, run, sig: sign.page(run, start, puzzles.map((p) => p.id)), puzzles }), true;
    }

    if (route === 'GET /api/rush/best') {
      if (refuse('look:' + ip, 120, 60e3)) return true;
      if (!sizeOk(q.size)) return json(res, 400, { error: 'size: 6' }), true;
      const today = pacificDay(now());
      const gid = user ? db.prepare('SELECT gid FROM users WHERE id = ?').get(user.id)?.gid ?? null : null;
      return json(res, 200, { best: user ? bests({ userId: user.id, gid }, SIZE, today, weekOf(today)) : null }), true;
    }

    if (route === 'GET /api/rush/top' || route === 'POST /api/rush/top') {
      if (refuse('look:' + ip, 120, 60e3)) return true;
      if (!MODES.has(q.mode || 'rush') || !sizeOk(q.size)) return json(res, 400, { error: 'mode: rush or streak; size: 6' }), true;
      // the viewer, as the result post knows them: the token's account, else the body's gid (POST)
      let me = user ? 'u' + user.id : null;
      if (!me && route === 'POST /api/rush/top') {
        const g = (await body(req).catch(() => null))?.guest?.gid;
        if (typeof g === 'string' && GID_RE.test(g)) me = resolve('g' + g).key;
      }
      return json(res, 200, { top: top(q.mode || 'rush', SIZE).map(({ key: k, ...r }) => (k === me ? { ...r, you: true } : r)) }), true;
    }

    // POST /api/rush/result
    if (refuse('rushres:' + key, 20, 10 * 60e3)) return true;
    const b = await body(req);
    // The run's pages, as handed out: each signed for this run, together the ids the post may name, in order.
    const t0 = MODES.has(b.mode) && sizeOk(b.size) ? sign.runOk(b.run, b.mode, SIZE) : null;
    let issued = null;
    if (t0 != null && now() - t0 <= RUN_TTL && Array.isArray(b.pages) && b.pages.length <= MAX_PAGES) {
      issued = [];
      for (const pg of [...b.pages].sort((x, y) => (x?.start ?? 0) - (y?.start ?? 0))) {
        if (!pg || int(pg.start, 0, 1000) == null || !Array.isArray(pg.ids) || pg.ids.length > RUN_LEN || !pg.ids.every((i) => typeof i === 'string' && ID.test(i))
          || !sign.pageOk(b.run, pg.start, pg.ids, pg.sig)) { issued = null; break; }
        issued.push(...pg.ids);
      }
    }
    const run = issued && cleanRun(b, (id) => !!exists.get(id), issued, storedPuzzle);
    const gid = typeof b.guest?.gid === 'string' && GID_RE.test(b.guest.gid) ? b.guest.gid : null;
    if (!run) return json(res, 400, { error: 'bad run' }), true;
    if (!user && !gid) return json(res, 400, { error: 'no player' }), true;
    if (db.prepare('SELECT 1 FROM rush_runs WHERE run = ?').get(b.run)) return json(res, 409, { error: 'run already posted' }), true;
    const u = user && db.prepare('SELECT id, name, rating, gid FROM users WHERE id = ?').get(user.id);
    const who = u ? { userId: u.id, gid: u.gid ?? null } : { userId: null, gid };
    const t = now(), day = pacificDay(t), week = weekOf(day);
    const played = run.playedAt == null ? null : Math.min(t, Math.max(t0, run.playedAt)); // between the token and now
    const before = bests(who, run.size, day, week)[run.mode];
    let id;
    db.exec('BEGIN');
    try {
      const bit = (v) => (v == null ? null : v ? 1 : 0), e = run.env;
      ({ lastInsertRowid: id } = db.prepare(`INSERT INTO rush_runs (user_id, gid, named, mode, size, score, moves, errors, best_combo, ms, build, user_rating, day, week, ts, run,
        abandoned, input, confirm, calm, width, minted_at, played_at, late, units, paused_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(u?.id ?? null, u ? null : gid, u?.name ? 1 : 0, run.mode, run.size, run.score, run.moves, run.errors,
        run.bestCombo, run.ms, run.build || null, u?.rating ?? null, day, week, t, b.run, run.abandoned ? 1 : 0, e.input, bit(e.confirm), bit(e.calm), e.width,
        t0, played, played == null ? null : t - played > LATE_MS ? 1 : 0, run.units, b.paused == null ? null : run.paused));
      const ins = db.prepare(`INSERT INTO rush_puzzles (run_id, pos, puzzle_id, mode, solved, skipped, ms, wrong, clock_ms, combo, puzzle_rating, user_id, user_rating, ts,
        hidden, nmoves, unfinished, sym) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insMove = db.prepare(`INSERT INTO rush_moves (run_id, pos, n, first_ms, ms, held_ms, weight, correct, at_ms, ptn, clock_ms,
        check_v, check_ms, paused_ms, open, path, final_v, final_ms, credit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insPo = db.prepare('INSERT INTO rush_playouts (run_id, pos, n, proven, cap, ending, paused_ms, moves) VALUES (?,?,?,?,?,?,?,?)');
      run.rows.forEach((r, pos) => {
        ins.run(id, pos, r.id, run.mode, r.solved ? 1 : 0, r.skipped ? 1 : 0, r.ms, r.wrong, r.clock, r.combo,
          ratingOf.get(r.id)?.rating ?? null, u?.id ?? null, u?.rating ?? null, t, bit(r.hidden), r.mv ? r.mv.length : null, r.unfinished ? 1 : 0, r.sym);
        r.mv?.forEach((m, n) => {
          insMove.run(id, pos, n, m.first, m.ms, m.held, m.weight, m.correct ? 1 : 0, m.at, m.ptn, m.clock,
            m.check ?? null, m.checkMs ?? null, m.check ? m.paused : null, m.check ? (m.open ? 1 : 0) : null, m.path ? m.path.join(' ') : null,
            m.final ?? null, m.finalMs ?? null, m.credit ?? null);
          if (m.po) insPo.run(id, pos, n, m.po.proven ? 1 : 0, m.po.cap, m.po.end, m.po.paused, JSON.stringify(m.po.line));
        });
      });
      if (!run.abandoned && run.score > 0 && keepLead.run(u ? 'u' + u.id : 'g' + gid, run.mode, run.size, run.score, t).changes) tops.clear(); // an abandoned run is never a best
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const best = bests(who, run.size, day, week);
    const beat = (k) => !run.abandoned && run.score > 0 && run.score > (before[k] ?? 0);
    const newBest = beat('all') ? 'all' : beat('week') ? 'week' : beat('today') ? 'today' : null;
    return json(res, 200, { id: Number(id), best, newBest }), true;
  }

  return { handle };
}
