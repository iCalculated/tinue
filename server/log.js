// The attempt ledger (docs/plan/PLAN.md §1.3): attempt, ply, rating_event and puzzle_rev. Dark: nothing a player sees
// reads it. Created idempotently at startup (initLog, called once from server.js); nothing else in the schema changes.
// "commit" is an SQL keyword, so that column is always written quoted.
import crypto from 'node:crypto';
import { rate, themeWeight, GUEST_PUZZLE_WEIGHT } from '../shared/rating.js';
import { THEMES } from '../shared/themes.js';
import { COMMIT } from './revision.js';
import { addColumns } from './schema.js';

export function initLog(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS attempt (
  id INTEGER PRIMARY KEY,
  nonce TEXT NOT NULL UNIQUE,
  user_id INTEGER, puzzle_id TEXT NOT NULL,
  first INTEGER NOT NULL DEFAULT 0,
  guest INTEGER,
  puzzle_rev INTEGER NOT NULL DEFAULT 0, book_ver INTEGER NOT NULL DEFAULT 0,
  build INTEGER, "commit" TEXT NOT NULL,
  mode TEXT NOT NULL,          -- legacy | shadow | decide
  theme TEXT, weight REAL,
  opened INTEGER NOT NULL, closed INTEGER, ms INTEGER,
  state TEXT NOT NULL,         -- open | judging | pending | playout | closed | conflict
  decided_ply INTEGER,
  result INTEGER,              -- 1 solved, 0 not
  why TEXT,
  rated INTEGER NOT NULL DEFAULT 0,
  unrated_why TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS attempt_first ON attempt(user_id, puzzle_id) WHERE first = 1;
CREATE TABLE IF NOT EXISTS ply (
  attempt_id INTEGER NOT NULL, n INTEGER NOT NULL, by TEXT NOT NULL,
  move TEXT, src TEXT NOT NULL, verdict TEXT, evidence TEXT, cap INTEGER, ts INTEGER NOT NULL, client_ms INTEGER,
  answer TEXT, PRIMARY KEY (attempt_id, n)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rating_event (
  id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- rate | refund | rejudge
  ts INTEGER NOT NULL, by TEXT NOT NULL, weight REAL NOT NULL,
  user_before TEXT, user_after TEXT,     -- JSON {rating, rd, vol, games, wins}
  puzzle_before TEXT, puzzle_after TEXT, -- JSON {rating, rd, vol, attempts, solves}
  note TEXT
);
CREATE INDEX IF NOT EXISTS rating_event_attempt ON rating_event(attempt_id);
CREATE TABLE IF NOT EXISTS puzzle_rev (
  id TEXT NOT NULL, rev INTEGER NOT NULL, tree TEXT NOT NULL, komi REAL, tps TEXT, ts INTEGER NOT NULL,
  PRIMARY KEY (id, rev)
) WITHOUT ROWID;
`);
  addColumns(db, 'puzzles', [['rev', 'INTEGER NOT NULL DEFAULT 0']]);
  addRefundColumn(db);
  // CLEANUP §1's unique index on attempts(user_id, puzzle_id) (L1b) waits until this is 0 or each pair is resolved.
  return db.prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM attempts GROUP BY user_id, puzzle_id HAVING COUNT(*) > 1)').get().n;
}

// A refund counts as a solve (Sasha, 2026-11-20: "I think the refund can count as a win for the player"). The attempts
// row of a refunded miss becomes the solve it is now counted as (win = 1, rated = 1, user_delta = the row's net effect on
// the player's rating: what the refund applied, 0 when left as it was, plus the miss's cost where no refund gave it back
// (refund.mjs on a fresh miss), so the History sums to the rating; the solve then is only in the refund event's note), and refund = 1
// keeps it visibly a refund: import.mjs's REFUND_MARK, the History (/api/history) and the players page key on it. Before this, a refund left rated = 0, win = 0, user_delta <> 0 (the legacy signature, which
// an attempt recorded unrated never has: its user_delta is 0); scripts/refund-legacy-wins.mjs turns those into solves
// too, and every reader except the History accepts both until it has run (REFUNDED_SQL). NULL: not refunded. Added idempotently here
// (server startup) and by the refund scripts, which may run on a database the server has not opened since.
// (They call it inside their own transaction, which addColumns joins: a dry run rolls it back.)
export function addRefundColumn(db) { addColumns(db, 'attempts', [['refund', 'INTEGER']]); }
// An attempts row (alias a) that was refunded: the mark, or the legacy signature.
export const REFUNDED_SQL = (a = 'attempts') => `(${a}.refund IS NOT NULL OR (${a}.rated = 0 AND ${a}.win = 0 AND COALESCE(${a}.user_delta, 0) <> 0))`;
// The weights a solve of this ledger attempt would have been rated with (/api/result's: the theme's win weight, a guest's
// half on the puzzle side).
export const winWeights = (att) => { const w = themeWeight(att.theme ?? undefined, THEMES, true); return { w, pw: att.guest ? w * GUEST_PUZZLE_WEIGHT : w }; };

// L2: /api/result's first attempts, logged beside today's attempts row (mode 'legacy'). TINUE_LOG=0 turns it off.
export const LOG_ON = process.env.TINUE_LOG !== '0';
export const userState = (u) => ({ rating: u.rating, rd: u.rd, vol: u.vol, games: u.games, wins: u.wins });
export const puzzleState = (p) => ({ rating: p.rating, rd: p.rd, vol: p.vol, attempts: p.attempts, solves: p.solves });
// A rated result's states after rate() (shared/rating.js) returned r: what /api/result's two UPDATEs write.
export const ratedUser = (b, r, win) => ({ rating: r.user.rating, rd: r.user.rd, vol: r.user.vol, games: b.games + 1, wins: b.wins + (win ? 1 : 0) });
export const ratedPuzzle = (b, r, win) => ({ rating: r.puzzle.rating, rd: r.puzzle.rd, vol: r.puzzle.vol, attempts: b.attempts + 1, solves: b.solves + (win ? 1 : 0) });

// Called inside /api/result's open transaction, after its own writes and before its COMMIT. The ledger rows go in a
// SAVEPOINT: any error rolls back to it and the rating commits as if the ledger did not exist. Never throws.
// user, puzzle: the rows as read before the result; r: rate()'s answer (null when unrated); weight/puzzleWeight: the
// weights given to rate(); unratedWhy: 'casual' (the client said so: a hint, an unchecked move or a Tiltak play-on) or
// 'stale-build' (a miss from a build older than TINUE_MIN_BUILD), or the puzzle's status, 'paused' or 'rejected' (PLAN P3).
export function logLegacyResult(db, { user, puzzle, win, rated, unratedWhy, theme, weight, puzzleWeight, r, build, ms, ts }) {
  if (!LOG_ON) return false;
  try {
    db.exec('SAVEPOINT ledger');
  } catch (e) { console.error('ledger: savepoint failed (rating kept):', e.message); return false; }
  try {
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, guest, puzzle_rev, book_ver, build, "commit",
        mode, theme, weight, opened, closed, ms, state, result, why, rated, unrated_why) VALUES (?,?,?,1,?,?,0,?,?,'legacy',?,?,?,?,?,'closed',?,?,?,?)`)
      .run('legacy-' + crypto.randomUUID(), user.id, puzzle.id, user.name == null ? 1 : 0, puzzle.rev ?? 0, Number.isInteger(build) && build > 0 ? build : null, COMMIT,
        theme ?? null, weight, ts, ts, ms ?? null, win ? 1 : 0, win ? 'win' : null, rated ? 1 : 0, rated ? null : unratedWhy ?? null);
    const ub = userState(user), pb = puzzleState(puzzle);
    db.prepare(`INSERT INTO rating_event (attempt_id, kind, ts, by, weight, user_before, user_after, puzzle_before, puzzle_after, note)
        VALUES (?, 'rate', ?, 'api/result', ?, ?, ?, ?, ?, ?)`)
      .run(id, ts, rated ? weight : 0, JSON.stringify(ub), JSON.stringify(rated ? ratedUser(ub, r, win) : ub),
        JSON.stringify(pb), JSON.stringify(rated ? ratedPuzzle(pb, r, win) : pb), JSON.stringify({ pw: rated ? puzzleWeight : 0 }));
    db.exec('RELEASE ledger');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK TO ledger'); db.exec('RELEASE ledger'); } catch (e2) { console.error('ledger: rollback to savepoint failed:', e2.message); }
    console.error('ledger: write failed (rating kept):', e.message);
    return false;
  }
}

// Replay (scripts/refund.mjs, scripts/replay-ratings.mjs). EVENTS: every ledger event with its attempt's user, puzzle,
// result and rated flag, in id order.
export const EVENTS = `SELECT e.*, a.user_id, a.puzzle_id, a.result, a.rated FROM rating_event e JOIN attempt a ON a.id = e.attempt_id`;
// One logged rate event applied to states u (user) and p (puzzle): the states rate() gives, as /api/result wrote them.
// Unrated events change nothing.
export function applyRate(u, p, e) {
  if (!e.rated || !e.weight) return { u, p };
  const pw = e.note ? JSON.parse(e.note).pw ?? e.weight : e.weight;
  const r = rate(u, p, !!e.result, e.weight, pw);
  return { u: ratedUser(u, r, e.result), p: ratedPuzzle(p, r, e.result) };
}
// How a user's chain treats its refunded attempts, from its 'refund' events' notes (the latest per attempt wins: an
// upgrade follows an older refund): asWin (refund.mjs since 2026-11-20) replays the attempt as a solve with the note's
// weights; kept (refund.mjs since 2026-11-21: the solve would have lowered the player, so their rating, rd and vol were
// kept and only the counts changed) replays the attempt as it was played (as the miss; left out if it upgraded an older
// refund) and adds the note's delta where the event stands; legacy (refund-legacy-wins.mjs, a miss refunded by hand
// before the ledger, so no rate event to replay) adds the note's delta where the event stands; none of these (refund.mjs
// before 2026-11-20) leaves the attempt out.
const noteOf = (e) => (e.note ? JSON.parse(e.note) : {});
export function refundsOf(chain) {
  const m = new Map();
  for (const e of chain) if (e.kind === 'refund') {
    const n = noteOf(e);
    if (n.kept && !n.upgrade) m.delete(e.attempt_id); // its rate event replays as logged
    else m.set(e.attempt_id, n.legacy ? { legacy: true } : n.kept ? { skip: true } : n.asWin ? { asWin: true, w: n.w, pw: n.pw } : { skip: true });
  }
  return m;
}
// One rate event replayed as a solve with weights w (user) and pw (puzzle).
export const applyWin = (u, p, { w, pw }) => { const r = rate(u, p, true, w, pw); return { u: ratedUser(u, r, true), p: ratedPuzzle(p, r, true), r }; };
const addDelta = (u, d) => Object.fromEntries(Object.keys(u).map((k) => [k, u[k] + (d[k] ?? 0)]));
// A user's state from their chain (all their events, id order) replayed from its first state: rate events as logged,
// refunded attempts as refundsOf says, plus `now` ({attempt_id, asWin, w, pw}: the refund being computed, not yet in
// the chain). Puzzles' states are the logged ones: other players' results are never rewritten.
export function replayUser(chain, now = null) {
  const how = refundsOf(chain);
  if (now) how.set(now.attempt_id, now);
  let u = JSON.parse(chain[0].user_before);
  for (const e of chain) {
    // A legacy or kept refund's delta, at its own event (an attempt can carry an older refund and its kept upgrade).
    if (e.kind === 'refund') { const n = noteOf(e); if (n.legacy || n.kept) u = addDelta(u, n.delta); continue; }
    if (e.kind !== 'rate') continue;
    const h = how.get(e.attempt_id), pb = JSON.parse(e.puzzle_before);
    if (!h) u = applyRate(u, pb, e).u;
    else if (h.asWin) u = applyWin(u, pb, h).u;
  }
  return u;
}
// Win, never lower (Sasha, 2026-11-21): a refund counted as a solve never lowers the player. Replaying the chain with a
// miss as a solve can end lower than as played (a newcomer's miss far below them, then solves far above: from the higher
// path those solves gain less; 1500 ± 500, a miss at 700 then solves at 1500 and 2200 ends ~380 lower). Then the player
// keeps their rating, rd and vol, and only games and wins change: wins + 1, games + 1 when the attempt had been left out
// (an upgrade). uNow: today's state (the chain's last after); uWin: replayUser with the attempt as a solve.
export function neverLower(uNow, uWin, upgrade = false) {
  if (uWin.rating > uNow.rating) return { u: uWin, kept: false };
  const delta = { rating: 0, rd: 0, vol: 0, games: upgrade ? 1 : 0, wins: 1 };
  return { u: addDelta(uNow, delta), kept: true, delta };
}
// A puzzle with one rated result taken back: its rating moved back by that result's own delta, one attempt (and the
// solve, if it was one) fewer; rd and vol stay. (refund.mjs before 2026-11-20; replay-ratings.mjs replays those.)
export const compensate = (p, e) => {
  const b = JSON.parse(e.puzzle_before), a = JSON.parse(e.puzzle_after);
  return { ...p, rating: p.rating - (a.rating - b.rating), attempts: p.attempts - (a.attempts - b.attempts), solves: p.solves - (a.solves - b.solves) };
};
// A puzzle whose rated miss e is counted as a solve instead: one step that takes the miss's own move out and puts the
// solve's in, both from the states logged on e (the user and puzzle before it), so later results by others stay as
// they were. attempts stay (the miss counted one, so does the solve), solves + 1; rd and vol stay (a solve would have
// narrowed rd as the miss did, within ~0.1).
export const compensateWin = (p, e, ww) => {
  const b = JSON.parse(e.puzzle_before), a = JSON.parse(e.puzzle_after), s = rate(JSON.parse(e.user_before), b, true, ww.w, ww.pw).puzzle;
  return { ...p, rating: p.rating - (a.rating - b.rating) + (s.rating - b.rating), solves: p.solves + 1 };
};
// The same for a miss refunded the older way (compensate: its move and its attempt already taken out): only the solve's
// move goes in, and the attempt comes back with its solve. (refund.mjs upgrading an older refund; note.upgrade.)
export const compensateUpgrade = (p, e, ww) => {
  const b = JSON.parse(e.puzzle_before), s = rate(JSON.parse(e.user_before), b, true, ww.w, ww.pw).puzzle;
  return { ...p, rating: p.rating + (s.rating - b.rating), attempts: p.attempts + 1, solves: p.solves + 1 };
};
