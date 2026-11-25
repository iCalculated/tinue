// One-off: the misses refunded BY HAND on 2026-11-10..16, before scripts/refund.mjs and the ledger existed, now count as
// solves, as every refund does since 2026-11-20 (Sasha: "I think the refund can count as a win for the player";
// docs/alt-wins.md, Refunds). A dry run unless --apply.
//
//   node --no-warnings scripts/refund-legacy-wins.mjs --db <path> [--expect 34] [--apply] [--no-deploy-check]
//
// Win, never lower (Sasha, 2026-11-21): every refunded miss becomes a solve (the attempts row, the player's games and
// wins, the refund mark), whatever happens to the rating; the player's rating, rd and vol change only when the
// correction computed below, summed over all of that player's refunds, is above zero AND their replay can be trusted
// (it reproduces the record, each refunded miss cost what the replay's weight-1 miss does, every give-back was found,
// every correction so far lies in its bound). Otherwise they stay exactly as they are, and the dry run says why:
// "computed −16.9, never lowered", or the replay's flaw. Untrusted means unchanged, never a guess, and never blocks the
// run or other players; only for a player who would be raised but for it (above zero, no drift, no refunded row off the
// replay) does a give-back not found or a bound overrun still refuse the whole run (a sign the replay is wrong).
//
// Stop tinue (or at least POST /api/result) for the --apply, after a backup: the server reads a user and a puzzle before
// its transaction and writes absolute values after, so a result submitted while this holds its lock would overwrite the
// correction with a stale one (and log a stale before). Run the dry run on a snapshot, not the live file (it takes the
// same lock). Run scripts/replay-ratings.mjs right after: a clobbered write shows up as a gap.
//
// Deploy this change (and restart tinue and tinue-players) before --apply: the older code reads a refund only by the
// legacy signature, so after an --apply its import.mjs would clear the puzzles' flaw = 2 and its players page would
// show plain solves. --apply refuses while attempts.refund is missing (the new server adds it at startup);
// --no-deploy-check overrides that, for a copy.
//
// What there is to go on. Such a miss left only its attempts row: user_id, puzzle_id, ts, win = 0, rated = 0 (set by
// hand), user_rating (the player's rating before), user_delta (what the miss cost then, given back by hand with
// games - 1) and puzzle_rating (the puzzle's rating before). Each later attempt on the puzzle records the puzzle's rating
// before it too, so the puzzle's whole rating path is on record; deviations, themes and guest weights are not. Exact
// history can't be rebuilt (ratings are path dependent, and later results started from the raised values), so:
//
// Deviations. Every rated row records two moves: the player's (user_delta) and the puzzle's (the step from its
//   puzzle_rating to the next row's, or to today's rating after the last). rate() at weight 1 reproduces both for one
//   pair of deviations, found by bisection (the player's in [45, 500], the puzzle's in [45, 250], a few alternating
//   rounds: they meet only through g()). Themes can't be known for these rows (attempts has no theme column, and the
//   ledger began on 2026-11-17), so a themed result's weight comes out as a smaller deviation; a guest's half weight on
//   the puzzle is known (its users row has no name) and used. The puzzle's deviation starts from, and without a fit
//   stays at, the one carried forward from the rows before (facing(), computed oldest row first); across the Elo era
//   that is the deviation the Glicko migration gave the puzzle (server.js: rdFromCount(its rated rows, 250)), not a fit of
//   Elo steps; whether the player was a newcomer comes from replaying their own rows (isNewcomer()).
// The player: the difference a counterfactual makes, not the at-the-time solve added to today's rating (the first
//   dry run on crux did that: a first-ever result, worth +1097 to a 1500 ± 500 newcomer, put on top of a rating settled
//   159 games later). Their own history (attempts rows, oldest first) is replayed twice from their start, once as it
//   happened and once with their refunded misses as solves; today's rating, rd and vol get the difference between the
//   two end states (games + 1, wins + 1 per refund). Between the two, the difference D is carried through every later
//   result by Glicko-2 itself, so an early refund fades as later results pull the rating to where the player is
//   (Glicko-2 is a Bayesian update: one result's weight in today's estimate is about φ_today²·g), and a refund of a
//   player who was settled then and played little since stays close to the solve then.
//   - Each row's opponent: the puzzle at its recorded rating, with the deviation facing() infers or carries for it
//     (every puzzle the player played, not only the refunded ones); 150 where it has none (a deleted puzzle). A
//     newcomer's row (rd >= 230) left its puzzle exactly as it was, so it can't be fitted, but the deviation is the one
//     fitted at the next row that moved the puzzle (only newcomers' or unmoving rows between): exact, and used.
//   - The as-it-happened run is anchored: each row starts from its recorded user_rating; the deviation and volatility
//     come from the replay. A change between rows that no result explains (J: next user_rating − this one − its
//     user_delta, and today's rating − the last row's after) is a hand edit, carried in both runs alike, except a
//     refunded miss's give-back (+|miss|, by hand): it is found as the first such jump after the miss that a set of the
//     pending give-backs sums to (within 0.51: a give-back typed rounded to whole points is still found; what is left
//     over stays a hand edit), and left out of the solves' run (a solve has no give-back). A give-back not found is a
//     hard refusal, every mode: taking it as never given back would credit the miss's cost twice.
//   - D's update: at a refunded miss, the solve (rate() from the counterfactual's state, weight 1, themes unknown as
//     before) minus the miss as recorded; at any other row, the counterfactual's step minus the as-played run's, both by
//     rate() at that row's weight. A themed result's weight is not stored: a recorded delta well under the replay's (a
//     solve below 0.32 of it, a miss below 0.84: the geometric midpoints of 0.1/1 and 0.7/1) is taken as themed.
//   - The start: the first Glicko row (2026-11-07 18:02 PST, d1bad22; earlier rows were Elo's and are not replayed,
//     their count only sets a converted account's rd). The server's starts were 1500 ± 250, vol 0.09 (to 2026-11-15),
//     1500 ± 500, vol 0.06 (since), and for a pre-Glicko account rdFromCount(games, 250), vol 0.09; deploy times are not
//     recorded, so every documented rd is tried with today's volatility, 0.06 and 0.09 (one result per rating period
//     moves volatility < 1% in 150 results, so today's is the best single guess), and the start whose run reproduces the
//     recorded user_deltas best (least squares) is taken. The rating is the first row's recorded one.
//   - The check (printed per player): the as-played run without anchoring (jumps carried) against today's rating, its
//     end rd against today's rd, and each row's replayed delta against the recorded user_delta (median and max). The
//     replay drifts when today's rating is off by more than 25 (about two and a half settled results, well above the
//     few tenths a consistent history shows and far below the errors this replaces), today's rd by more than 15 (the
//     rd sets how fast D fades), or the rows' median miss exceeds a quarter of their median |delta| + 1. A drifting
//     player is left unchanged (their refunds still become solves), named in the dry run and the totals; it no longer
//     stops the run (it did until 2026-11-21, with an --allow-drift override that then raised them anyway: gone).
//   - The bound (no override): after a player's first k refunds the correction lies in [−Σ|miss| − 10, +Σ solve + 10], each solve as the
//       counterfactual made it at its row. Why: D gains solve + |miss| at the refunded row, loses |miss| at the
//       give-back, and every later result shrinks D by a factor in (0, 1) (linearised Glicko-2: 1 − φ'²g²E(1−E), and
//       φ'²g²E(1−E) = (1/v)/(1/φ*² + 1/v) < 1). Nothing about today's deviation is assumed: an early refund may stay large
//       for dozens of results (a first-ever refund, 20 results on: +216.4 in test-refund.mjs, against ±42.3 for one result
//       today), which is why the earlier bound (one result's swing at today's rd) refused correct corrections. This one
//       catches a sign error, a blow-up or a non-contracting replay; a replay that does not fit the record is the drift
//       check's to catch. Over it, a player who would be raised but for it stops the run (dry run included, naming the
//       attempts row), as does a give-back not found for them; for anyone else (not above zero, drifting, a refunded row
//       off the replay) either one only marks the replay untrusted (they are left unchanged anyway), printed.
//   - The refunded row itself: its recorded miss over the replay's weight-1 miss there must lie in [0.837, 1/0.837]
//     (√0.7: the themed-miss test's midpoint). Below, the miss was themed (0.7; attempts has no theme column), and the
//     solve's weight is unknown (the live path credits a themed solve 0.1, this replay 1): up to +339 apart in the review's
//     worlds. Either side, the replay is off at the row the correction comes from (an off-list start of rd 400 crediting a
//     first-ever refund +68 over its truth, in review). Such a player is left unchanged; the ratio is printed per attempt.
//   - A correction can be negative: the higher path loses more on later misses (and the give-back, later, fades less
//     than the solve). Such a player is left unchanged: never lowered by a refund (Sasha, 2026-11-21).
//   - Where the change goes: a player's correction is one decision (their refunds' sum), so it is written once, on their
//     last refund's event; their earlier refunds' events change games and wins only. The ledger's 'refund' event for an
//     unchanged player has before = after but for games and wins (+1 each), so replayUser and replay-ratings.mjs, which
//     add a legacy event's delta where it stands, still reproduce the users row; the note keeps the computed figures
//     (step, so, total) beside what was applied (rating: 'raised' or 'unchanged', why).
//   - The attempts row's user_delta (the History's Δ) is what the refund did to the player's rating: the whole raise on
//     a raised player's last refund, 0 on every other refunded row (an unchanged player's included). Not the solve then
//     (rate() with the recorded ratings and the inferred deviations): a first-ever result's solve then reads +1097 for
//     a player whose rating did not move. The solve then stays in the event's note (solve) and the dry run's lines.
//   At equal ratings a Glicko-2 solve is the miss's mirror (E = ½; the deviation and volatility steps see only Δ²), so a
//   settled player's last result refunded and given back gains exactly the miss's cost: the test's hand-checked case.
// The puzzle, the splice: up to the first refunded miss its path is the recorded one, exactly. From there it is
//   replayed in order: each later rated result makes its own move again with rate(), from the replayed rating and with
//   the deviations inferred for it (so replaying with nothing changed gives back today's rating), and a refunded miss
//   makes a solve's move instead of its miss's. A guest's rows from before its account never moved the puzzle and move
//   nothing here either. Other players' ratings are not touched. Where a recorded step can't be
//   matched: a refunded miss whose rise was already taken back by hand counts its solve from rate() with the puzzle's
//   deviation carried forward from the rows before it; a newcomer (rd >= 230) moves nothing, as then; a
//   step bigger than any one result can make (a hand edit on top) has its rate() part swapped and the rest carried.
//   The puzzle's rd and vol stay: the miss narrowed them as the solve would have. A puzzle that was put back to its
//   start by hand (rating = init_rating, rd 250, vol 0.09, no rated result left) starts there instead and rates its
//   refunded solves with rate(), rd and vol included.
//   This beats replaying every result from init_rating (the coordinator's first proposal): that would replace the
//   recorded path before the refund with a model of it, and add the model's error on results nobody disputes. In a
//   made-up world played through rate() (scripts/test-refund.mjs, pd528655's shape) it lands within 15 points of the
//   world's own truth after three swapped results moving the puzzle ~350.
//   The "gives back today's rating" figure holds by construction (the deviations are fitted to make it so), so the dry
//   run prints it as a consistency figure only; what it prints as a measure of the estimates: the rows with no fitted
//   deviation, and how far the corrected ratings move with every inferred deviation 20% lower or higher.
// Counters: the puzzle's attempts and solves are recounted from its attempts rows (rated ones and every refunded miss,
//   but not a guest's rows from before it had an account: those never moved puzzles; solves: the solves and the refunded
//   misses counted so far); the hand refunds left them uneven. The player's games and wins + 1 each (the hand refund took the game off).
// The attempts row becomes the solve: win = 1, rated = 1, user_delta = the change applied (above), refund = 1 (the mark
//   REFUND_MARK, the History and the players page read). There is no ledger row to hang a rating_event on, so each gets a ledger attempt of its
//   own (nonce refund-legacy-<attempts rowid>, mode legacy, opened/closed at the attempt's time, result 0: it was a
//   miss at the board; rated 0, unrated_why 'refund-legacy', so the reports looking for rated misses skip it) and a 'refund' rating_event with the before and after states and a note {legacy, asWin, delta,
//   …} (delta: rating, rd, vol, games and wins, each after − before): replayUser adds the delta where the event stands,
//   so later ledger refunds and replay-ratings.mjs see it.
//
// One transaction, oldest attempt first. Idempotent: a refunded miss that is already a solve has refund = 1 and is not
// picked again, so a second --apply finds nothing to do. It refuses a database that doesn't look like the one it was
// written for: no ledger tables, a candidate count (with the ones already done) other than --expect (34 on crux on
// 2026-11-20), a candidate outside 2026-11-09..17, without recorded ratings, with a ledger attempt, or a duplicate pair;
// and, as above, for a player who would be raised but for it, a give-back not found or a correction out of its bound
// (every mode).
// A miss refunded by the older scripts/refund.mjs (a 'refund' event on its pair) is not a candidate: refund.mjs counts
// it as a solve from its exact chain.
// The dry run prints one line per attempt (ids only: never a name, token or gid): the computed step of the replays'
// difference, the correction so far and its bound (OUT OF BOUND if so), the solve then and the miss's cost; what is
// applied (the player's before -> after, rd before -> after); the refunded miss over the replay's weight-1 miss; and the
// puzzle's line; then one line per player (the start
// taken, how closely the as-played replay reproduces today's rating, rd and the rows' deltas, rows taken as themed,
// puzzle deviations estimated (from an Elo conversion) or taken from the next fitted row, give-backs found (NOT FOUND
// rows), other jumps (each with where it is), the computed correction and how much it moves with the puzzle deviations 20% lower or higher,
// DRIFT if any, and then "raised by" or "left unchanged: why"), and totals (computed and applied in all, how many
// players raised and how many left unchanged and why, the puzzle-side figures). --db is required.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { rate, rdFromCount } from '../shared/rating.js';
import { PUZZLE_START, PLAYER_START, LEGACY_START, RD_MIN } from '../shared/glicko.js';
import { addRefundColumn, userState, puzzleState } from '../server/log.js';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes('--apply'), EXPECT = +(opt('expect') ?? 34), NO_DEPLOY_CHECK = args.includes('--no-deploy-check');
const die = (msg, code = 2) => { console.error('refund-legacy-wins: ' + msg); process.exit(code); };
if (args.includes('--allow-drift')) die('--allow-drift is gone (2026-11-21): a drifting player is left unchanged and no longer stops the run');
const unknown = args.filter((a, i) => a.startsWith('--') && !['--db', '--expect', '--apply', '--no-deploy-check'].includes(a) && !['--db', '--expect'].includes(args[i - 1]));
if (unknown.length) die('unknown option ' + unknown.join(' '));
const refuse = (msg) => die('refused: ' + msg, 3);
const file = opt('db') || die('--db <path> is required');
if (!fs.existsSync(file)) die(`no database at ${file}`);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000');
const T0 = Date.UTC(2026, 10, 9), T1 = Date.UTC(2026, 10, 18); // the hand refunds' attempts: 2026-11-10..16
const CLUELESS_RD = 230; // shared/rating.js: a player this unsure moves no puzzle
const GLICKO_T = Date.UTC(2026, 10, 8, 2, 2); // d1bad22, 2026-11-07 18:02 PST: Glicko-2 replaced Elo; rows before are Elo's
const NONCE = 'refund-legacy-';
const r1 = (x) => (Math.round(x * 10) / 10 + 0).toFixed(1), sg = (x) => (Math.round(x * 10) >= 0 ? '+' : '') + r1(x); // (+ 0: no "-0.0")

// The deviation that makes rate() give a player rated ur the recorded delta d against puzzle p (a miss, or a solve when
// win), at weight 1; clamped to [RD_MIN, 500]. |delta| grows with rd, so bisection.
function inferRd(ur, vol, p, d, win) {
  const at = (rd) => Math.abs(rate({ rating: ur, rd, vol }, p, win, 1).userDelta), t = Math.abs(d);
  let lo = RD_MIN, hi = 500;
  if (t <= at(lo)) return { rd: lo, clamped: true };
  if (t >= at(hi)) return { rd: hi, clamped: true };
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (at(m) < t) lo = m; else hi = m; }
  return { rd: (lo + hi) / 2, clamped: false };
}

for (const t of ['users', 'puzzles', 'attempts', 'attempt', 'rating_event'])
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) refuse(`no ${t} table (not tinue's database, or older than the ledger)`);

db.exec('BEGIN IMMEDIATE'); // one state for reads and writes; a dry run rolls everything back, the column included
try {
  // The deploy check. attempts.refund exists only once this branch's server has started on the database (initLog adds
  // it) or a refund script has written. Without it the code reading the database is the older one, whose REFUND_MARK
  // (import.mjs) and players page key on the legacy signature only: after an --apply they would see no refund at all
  // and the next import would clear the puzzles' flaw = 2. So --apply refuses until the server has been deployed and
  // restarted (--no-deploy-check to override, e.g. on a copy).
  const deployed = db.prepare('PRAGMA table_info(attempts)').all().some((c) => c.name === 'refund');
  if (!deployed && APPLY && !NO_DEPLOY_CHECK) refuse('attempts.refund is missing: the server reading this database predates refunds counted as solves. Deploy and restart tinue and tinue-players first (their REFUND_MARK and players page read attempts.refund), or pass --no-deploy-check on a copy');
  addRefundColumn(db);
  // A miss refunded by the older refund.mjs (ledger, before 2026-11-20) also has the legacy signature; refund.mjs
  // upgrades those itself (it has the exact chain), so they are left out here and counted apart.
  const LEDGER_REFUND = `EXISTS (SELECT 1 FROM attempt x JOIN rating_event e ON e.attempt_id = x.id AND e.kind = 'refund' WHERE x.user_id = attempts.user_id AND x.puzzle_id = attempts.puzzle_id)`;
  const sig = 'refund IS NULL AND rated = 0 AND win = 0 AND COALESCE(user_delta, 0) <> 0';
  const cands = db.prepare(`SELECT rowid, * FROM attempts WHERE ${sig} AND NOT ${LEDGER_REFUND} ORDER BY ts, rowid`).all();
  const ledgerOld = db.prepare(`SELECT COUNT(*) n FROM attempts WHERE ${sig} AND ${LEDGER_REFUND}`).get().n;
  if (ledgerOld) console.log(`(${ledgerOld} older ledger refund${ledgerOld === 1 ? '' : 's'} left to scripts/refund.mjs, which counts ${ledgerOld === 1 ? 'it' : 'them'} as solves from the chain)`);
  if (!deployed) console.log('note: attempts.refund is missing (the server reading this database predates this change): --apply will refuse until it is deployed and restarted');
  const candIds = new Set(cands.map((c) => c.rowid));
  const done = db.prepare(`SELECT COUNT(*) n FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE e.kind = 'refund' AND a.nonce LIKE '${NONCE}%'`).get().n;
  if (!cands.length) { db.exec('ROLLBACK'); console.log(`nothing to do: no refunded miss left uncounted (${done} counted as solves by this script)`); process.exit(0); }
  if (cands.length + done !== EXPECT) refuse(`${cands.length} refunded misses to count (+ ${done} done) where ${EXPECT} were expected: not the database this was written for (--expect to override after checking)`);
  const getUser = db.prepare('SELECT id, name, rating, rd, vol, games, wins, created_at FROM users WHERE id = ?'), getPuzzle = db.prepare('SELECT * FROM puzzles WHERE id = ?');
  const pairRows = db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id = ? AND puzzle_id = ?'), ledgerRow = db.prepare('SELECT id FROM attempt WHERE user_id = ? AND puzzle_id = ? AND first = 1');
  for (const c of cands) {
    const at = `attempts row ${c.rowid}`;
    if (!(c.ts >= T0 && c.ts < T1)) refuse(`${at} is from ${new Date(c.ts).toISOString()}, outside the hand refunds (2026-11-10..16)`);
    if (c.user_rating == null || c.puzzle_rating == null || !(c.user_delta < 0)) refuse(`${at} lacks a recorded rating or a miss's cost`);
    if (!getUser.get(c.user_id) || !getPuzzle.get(c.puzzle_id)) refuse(`${at}: its user or puzzle is gone`);
    if (pairRows.get(c.user_id, c.puzzle_id).n !== 1) refuse(`${at}: several attempts rows for its user and puzzle`);
    if (ledgerRow.get(c.user_id, c.puzzle_id)) refuse(`${at} has a ledger attempt: scripts/refund.mjs is for those`);
  }

  // Each affected puzzle, as it stands: its attempts in order, whether it was put back to its start by hand.
  const created = new Map(), users = new Map(), GONE = { name: '', vol: PLAYER_START.vol }; // GONE: a row whose users row was deleted
  const userOf = (id) => { if (!users.has(id)) { const u = getUser.get(id); users.set(id, u); created.set(id, u?.created_at ?? 0); } return users.get(id); };
  const puzzles = new Map();
  for (const id of new Set(cands.map((c) => c.puzzle_id))) {
    const P = getPuzzle.get(id), rows = db.prepare('SELECT rowid, * FROM attempts WHERE puzzle_id = ? ORDER BY ts, rowid').all(id);
    rows.forEach((a) => userOf(a.user_id));
    const reset = P.rating === P.init_rating && P.rd === PUZZLE_START.rd && P.vol === PUZZLE_START.vol && !rows.some((a) => a.rated && a.ts >= created.get(a.user_id));
    puzzles.set(id, { P, P0: { ...P }, rows, reset, cand: new Set(cands.filter((c) => c.puzzle_id === id).map((c) => c.rowid)) });
  }
  // (z.P moves as attempts are counted; z.P0 is the puzzle as it stood, which the splice replays from.)
  // The step recorded across row k: the next row's puzzle_rating (or today's rating) minus this one's.
  const recOf = (z, k) => (k + 1 < z.rows.length ? z.rows[k + 1].puzzle_rating : z.P0.rating) - z.rows[k].puzzle_rating;
  // A row that moved the puzzle when it was played: a rated one from an account or a guest's server rating, or a miss
  // refunded by hand later. A guest's rows from before its account (replayed into attempts when it signed up) never did.
  const moved = (z, a) => (!!a.rated || z.cand.has(a.rowid)) && a.ts >= created.get(a.user_id);
  // Whether the player was still a newcomer (rd >= 230: rate() then moves no puzzle) at their attempts row r: their rd
  // replayed from PLAYER_START over their own rows that rated them, in order (every rated row, a guest's replayed ones
  // included, and the refunded misses, which were rated when played), against a puzzle at rd 150 (as the players page
  // does). Counting games is what decides it: the rd falls 500 -> ~300 -> ~255 -> ~212 over the first three results
  // whatever the opponents, so a row is a newcomer's when the player had at most two rated results before it. One
  // delta's inferred deviation can't tell 235 from 225 when the puzzle's deviation is itself estimated. The replay can
  // only err towards "newcomer" (a player whose earlier results are missing from attempts looks newer than they are),
  // so "not a newcomer" is taken as it is, and "newcomer" only where the inferred deviation is near the line (>= 200).
  const newcomerAt = new Map();
  const isNewcomer = (a) => {
    if (!newcomerAt.has(a.rowid)) {
      let u = { ...PLAYER_START };
      for (const b of db.prepare('SELECT rowid, * FROM attempts WHERE user_id = ? ORDER BY ts, rowid').all(a.user_id)) {
        newcomerAt.set(b.rowid, u.rd >= CLUELESS_RD);
        if (b.rated || candIds.has(b.rowid)) u = rate({ ...u, rating: b.user_rating }, { rating: b.puzzle_rating, rd: 150, vol: 0.09 }, !!(b.rated && b.win)).user;
      }
    }
    return newcomerAt.get(a.rowid);
  };
  // The player and the puzzle as they met at row k: recorded ratings, and the deviations then, which are not stored, so
  // inferred: the player's from the row's user_delta, the puzzle's from the step recorded across it, each at weight 1,
  // alternating (they meet only through g(), so a few rounds settle it). fit: the recorded step was matched. The puzzle's
  // deviation starts from (and, without a fit, stays at) the one carried forward from the rows before: 250 before the
  // first row that moved it, else the deviation rate() leaves after the last such row, from that row's own deviations
  // (as played: a refunded miss as the miss). Not today's: later results have narrowed it since. Without a fit: no step
  // on record, a newcomer, or a step no single result at a deviation <= 250 makes. The player's inferred deviation is
  // kept on the side of 230 the newcomer replay says (isNewcomer, as qualified there), so rate()'s newcomer rule follows it.
  // Computed forward, oldest row first, each from the one before (cached): no recursion per earlier row (a puzzle with
  // thousands of rows used to overflow the stack). A row after the Elo era whose last earlier mover was an Elo row carries
  // the deviation the Glicko migration gave the puzzle (server.js: rdFromCount(its attempts, 250)), not a fit of Elo steps
  // through rate() (elo: true, printed in the player line).
  const facing = (z, k) => {
    z.f ??= [];
    for (let j = z.f.length; j < k; j++) facingAt(z, j);
    return z.f[k] ?? facingAt(z, k);
  };
  const facingAt = (z, k) => {
    const a = z.rows[k], u = userOf(a.user_id) ?? GONE, win = !!(a.rated && a.win), pw = u.name == null ? 0.5 : 1, rec = recOf(z, k);
    let prd = PUZZLE_START.rd, elo = false;
    for (let j = k - 1; j >= 0; j--) if (moved(z, z.rows[j])) {
      if (z.rows[j].ts < GLICKO_T && a.ts >= GLICKO_T) { prd = rdFromCount(z.rows.slice(0, j + 1).filter((b) => b.rated && b.ts < GLICKO_T).length, PUZZLE_START.rd); elo = true; break; }
      const g = z.f[j]; prd = rate(g.u, g.p, !!(z.rows[j].rated && z.rows[j].win), 1, g.pw).puzzle.rd; break;
    }
    const nb = isNewcomer(a), side = (rd) => (!nb ? Math.min(rd, CLUELESS_RD - 0.01) : rd >= 200 ? Math.max(rd, CLUELESS_RD) : rd);
    let ur, clamped, fit = false;
    for (let i = 0; i < 4; i++) {
      ({ rd: ur, clamped } = inferRd(a.user_rating, u.vol, { rating: a.puzzle_rating, rd: prd, vol: z.P0.vol }, a.user_delta, win));
      ur = side(ur);
      const q = rec > 0 === !win && rec !== 0 ? inferPrd({ rating: a.user_rating, rd: ur, vol: u.vol }, { rating: a.puzzle_rating, vol: z.P0.vol }, rec, win, pw) : null;
      if (q == null) break;
      prd = q; fit = true;
    }
    return (z.f[k] = { u: { rating: a.user_rating, rd: ur, vol: u.vol }, p: { rating: a.puzzle_rating, rd: prd, vol: z.P0.vol }, clamped, pw, fit, elo: elo && !fit });
  };
  // The puzzle deviation in [RD_MIN, 250] with which rate() moves the puzzle by rec (sign included) at weight 1 (pw for
  // a guest); null when none does (a newcomer moves nothing).
  function inferPrd(u, p, rec, win, pw) {
    if (u.rd >= CLUELESS_RD) return null;
    const at = (rd) => Math.abs(rate(u, { ...p, rd }, win, 1, pw).puzzleDelta), t = Math.abs(rec);
    let lo = RD_MIN, hi = PUZZLE_START.rd;
    if (t < at(lo) || t > at(hi) * 1.02) return null;
    if (t >= at(hi)) return hi;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (at(m) < t) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  // The splice (header): the puzzle's state with the refunded misses in `won` counted as solves. src: per row, where its
  // solve step came from.
  // scale: every inferred deviation multiplied by it (the sensitivity check below; 1 otherwise; a newcomer stays one).
  const scaled = (f, s) => (s === 1 ? f : { ...f, u: { ...f.u, rd: f.u.rd >= CLUELESS_RD ? f.u.rd : Math.min(CLUELESS_RD - 0.01, f.u.rd * s) }, p: { ...f.p, rd: Math.min(350, f.p.rd * s) } });
  const PRE_ACCOUNT = "nothing: a guest's row from before its account, which never moved the puzzle"; // (was "undefined")
  function splice(z, won, s = 1) {
    const { P0: P, rows } = z, src = new Map();
    if (z.reset) {
      let st = { rating: P.init_rating, rd: PUZZLE_START.rd, vol: PUZZLE_START.vol };
      rows.forEach((a, k) => { if (won.has(a.rowid) && !moved(z, a)) src.set(a.rowid, PRE_ACCOUNT); else if (won.has(a.rowid)) { const f = scaled(facing(z, k), s); st = rate(f.u, st, true, 1, f.pw).puzzle; src.set(a.rowid, 'rate(), the puzzle back at its start'); } });
      return { st, src };
    }
    const k0 = rows.findIndex((a) => won.has(a.rowid) || (!won.size && z.cand.has(a.rowid))); // (none won: the check below)
    let r = rows[k0].puzzle_rating;
    for (let k = k0; k < rows.length; k++) {
      const a = rows[k], rec = recOf(z, k);
      // Unrated, or a guest's row from before its account (it never moved the puzzle): its recorded step (0, or a hand
      // edit between rows) carried as it was.
      if (!moved(z, a)) { r += rec; if (won.has(a.rowid)) src.set(a.rowid, PRE_ACCOUNT); continue; }
      const f = scaled(facing(z, k), s), userWin = won.has(a.rowid) || !!(a.rated && a.win);
      // The step this result makes from the replayed rating r, with the deviations as they met.
      const at = (x, w) => rate(f.u, { ...f.p, rating: x }, w, 1, f.pw).puzzleDelta;
      if (f.fit) { r += at(r, userWin); if (won.has(a.rowid)) src.set(a.rowid, 'its recorded rise'); continue; }
      // No fit: the recorded step is not this result's own move alone. A refunded miss whose rise was taken back by hand
      // (rec <= 0) counts its solve from rate(); otherwise rate()'s own move is swapped and the rest (a hand edit) carried.
      const taken = won.has(a.rowid) && rec <= 0, own = taken ? 0 : at(a.puzzle_rating, !!(a.rated && a.win));
      if (won.has(a.rowid)) src.set(a.rowid, f.u.rd >= CLUELESS_RD ? 'a newcomer: no move' : taken ? 'rate(): its rise was taken back by hand' : 'rate(): its recorded step is more than one result can move it (the rest, a hand edit, carried)');
      r += at(r, userWin) + (rec - own) * (taken ? 0 : 1);
    }
    return { st: { rating: r, rd: P.rd, vol: P.vol }, src };
  }
  const recount = (z, won) => {
    const n = (f) => z.rows.filter((a) => moved(z, a) && f(a)).length; // (every refunded miss was an attempt)
    return { attempts: n(() => true), solves: n((a) => a.win || won.has(a.rowid)) };
  };

  // Ledger chains that already disagree with their users row stay so (printed, not fixed).
  const lastAfter = db.prepare(`SELECT e.user_after FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.user_id = ? ORDER BY e.id DESC LIMIT 1`);
  // rated = 0, unrated_why 'refund-legacy': the reports that look for rated misses (false-miss-report, rejudge) must not
  // see these; replay-ratings reads them through the refund event's note, not through rated.
  const addAttempt = db.prepare(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, guest, "commit", mode, opened, closed, state, result, why, rated, unrated_why)
    VALUES (?, ?, ?, 1, ?, '', 'legacy', ?, ?, 'closed', 0, 'miss refunded by hand before the ledger', 0, 'refund-legacy')`);
  const addEvent = db.prepare(`INSERT INTO rating_event (attempt_id, kind, ts, by, weight, user_before, user_after, puzzle_before, puzzle_after, note)
    VALUES (?, 'refund', ?, 'refund-legacy-wins.mjs', 1, ?, ?, ?, ?, ?)`);
  // Two figures for the totals line. fits: the splice with nothing changed comes back to today's ratings, which says
  // only that the deviation fits reproduce the recorded steps (true by construction up to the bisection's tolerance);
  // it is not evidence that the corrections are right. sens: how much the corrections depend on the inferred
  // deviations: every one of them 20% lower, then 20% higher, and the largest change in a corrected puzzle rating.
  // fallbacks: rows whose deviation could not be fitted to their recorded step (estimated instead).
  const residual = Math.max(0, ...[...puzzles.values()].filter((z) => !z.reset).map((z) => Math.abs(splice(z, new Set()).st.rating - z.P0.rating)));
  let sens = { d: 0, id: null };
  for (const z of puzzles.values()) {
    const all = z.cand, base = splice(z, all).st.rating;
    for (const sc of [0.8, 1.2]) { const d = Math.abs(splice(z, all, sc).st.rating - base); if (d > sens.d) sens = { d, id: z.P.id }; }
  }
  const fallbacks = [...puzzles.values()].reduce((n, z) => n + z.rows.filter((a, k) => moved(z, a) && !facing(z, k).fit).length, 0);

  // ---- The player side (header): the player's own history replayed as it happened and with the refunded misses as
  // solves; today's state gets the difference. Everything is computed before anything is written. ----
  const DRIFT = { rating: 25, rd: 15 }, BOUND_MARGIN = 10, GB_TOL = 0.51, REF_Q = 0.837; // REF_Q: the themed-miss test's midpoint (√0.7)
  const zCache = new Map();
  const zOf = (id) => {
    if (puzzles.has(id)) return puzzles.get(id);
    if (!zCache.has(id)) {
      const P = getPuzzle.get(id);
      if (!P) zCache.set(id, null);
      else { const rows = db.prepare('SELECT rowid, * FROM attempts WHERE puzzle_id = ? ORDER BY ts, rowid').all(id); rows.forEach((a) => userOf(a.user_id)); zCache.set(id, { P, P0: { ...P }, rows, reset: false, cand: new Set() }); }
    }
    return zCache.get(id);
  };
  // Rated when played: a rated row, a refunded miss (candidate, or one refunded by the older refund.mjs: the legacy signature).
  const ratedThen = (a) => a.puzzle_rating != null && (!!a.rated || candIds.has(a.rowid) || (a.refund == null && !a.win && !!a.user_delta));
  const clampU = (s) => ({ rating: s.rating, rd: Math.min(500, Math.max(RD_MIN, s.rd)), vol: Math.min(0.1, s.vol) });
  // A newcomer's row (rd >= 230) left its puzzle exactly as it was (rate() moves nothing for them), so its puzzle's
  // deviation is not fitted at that row, but it is the one fitted at the next row that moved the puzzle, when only
  // newcomers' rows (or rows that moved nothing) lie between: exact, where carrying forward is an estimate.
  const lookAhead = (z, k) => {
    if (facing(z, k).fit || facing(z, k).u.rd < CLUELESS_RD) return null;
    for (let j = k + 1; j < z.rows.length; j++) {
      if (!moved(z, z.rows[j])) continue;
      const g = facing(z, j);
      if (g.fit) return g.p.rd;
      if (g.u.rd < CLUELESS_RD) return null;
    }
    return null;
  };
  const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function playerPlan(uid) {
    const u = userOf(uid), today = { rating: u.rating, rd: u.rd, vol: u.vol };
    const seq = db.prepare('SELECT rowid, * FROM attempts WHERE user_id = ? ORDER BY ts, rowid').all(uid).filter((a) => a.user_rating != null).map((a) => ({ a, moves: ratedThen(a) }));
    let estimated = 0, eloRows = 0, ahead = 0;
    for (const x of seq) if (x.moves) {
      const z = zOf(x.a.puzzle_id), k = z ? z.rows.findIndex((r) => r.rowid === x.a.rowid) : -1;
      let prd = k >= 0 ? facing(z, k).p.rd : NaN;
      const la = k >= 0 ? lookAhead(z, k) : null;
      if (la != null) { prd = la; ahead++; }
      else if (!(prd > 0) || !(k >= 0 && facing(z, k).fit)) estimated++;
      if (la == null && k >= 0 && facing(z, k).elo) eloRows++;
      if (!(prd > 0)) prd = 150;
      x.p = { rating: x.a.puzzle_rating, rd: prd, vol: PUZZLE_START.vol };
    }
    const n = seq.length, step = (x) => (x.moves ? x.a.user_delta : 0);
    // J[i]: the change between rows i-1 and i that no result explains (a hand edit: a refund's give-back, or else); J[n]:
    // between the last row and today's rating.
    const J = seq.map((x, i) => (i ? x.a.user_rating - (seq[i - 1].a.user_rating + step(seq[i - 1])) : 0));
    J.push(n ? today.rating - (seq[n - 1].a.user_rating + step(seq[n - 1])) : 0);
    // Where each refunded miss's give-back (+|miss|, by hand) went: the first jump after it that a set of the pending
    // give-backs sums to.
    const ci = seq.flatMap((x, i) => (candIds.has(x.a.rowid) ? [i] : [])), gbAt = new Map();
    let pending = [];
    for (let j = 1; j <= n; j++) {
      pending.push(...ci.filter((i) => i === j - 1));
      if (!pending.length || Math.abs(J[j]) < 0.05) continue;
      let hit = null;
      for (let m = 1; m < 1 << pending.length && !hit; m++) {
        const sub = pending.filter((_, b) => m >> b & 1);
        if (Math.abs(sub.reduce((s, i) => s - seq[i].a.user_delta, 0) - J[j]) <= GB_TOL) hit = sub;
      }
      if (hit) { hit.forEach((i) => gbAt.set(seq[i].a.rowid, j)); pending = pending.filter((i) => !hit.includes(i)); }
    }
    const lost = pending.map((i) => seq[i].a.rowid); // give-backs not found: a hard refusal (below)
    // The replay starts at the first Glicko row (s0); rows before were Elo's. Starting states the server has used: new
    // players 1500 ± 500 (since 2026-11-15) or ± 250 (before), a pre-Glicko account rdFromCount(games, 250); volatility
    // today's (one game per rating period moves it < 1% in 150 games), 0.06 or 0.09. The one whose replay reproduces the
    // recorded deltas best is taken.
    const s0 = Math.max(0, seq.findIndex((x) => x.a.ts >= GLICKO_T)), nBefore = seq.slice(0, s0).filter((x) => x.moves).length;
    const rds = nBefore ? [rdFromCount(nBefore, LEGACY_START.rd), PUZZLE_START.rd, PLAYER_START.rd] : [PLAYER_START.rd, PUZZLE_START.rd];
    const vols = [...new Set([today.vol, PLAYER_START.vol, LEGACY_START.vol])];
    // As it happened, from start st: each rated row from its recorded rating (anchored), the deviation and volatility from
    // the replay. A themed result's weight is not stored: a recorded delta well under the replay's (a solve < 0.32 of it,
    // a miss < 0.84: the geometric midpoints) is taken as themed (0.1, 0.7). free: the same without anchoring (recorded
    // jumps carried), to compare with today's rating.
    function asPlayed(st, scale = 1) {
      let a = { rating: 0, rd: st.rd, vol: st.vol }, free = n ? seq[s0].a.user_rating : today.rating;
      const w = new Map(), resid = [], recs = [], refQ = new Map();
      for (let i = s0; i < n; i++) {
        const x = seq[i];
        if (i > s0) free += J[i];
        a.rating = x.a.user_rating;
        if (!x.moves) continue;
        const p = scale === 1 ? x.p : { ...x.p, rd: Math.min(350, x.p.rd * scale) }, win = !!x.a.win, rec = x.a.user_delta;
        let wt = 1;
        const r1x = rate(a, p, win, 1);
        // A refunded miss keeps weight 1 here (the counterfactual's solve is weight 1), but its ratio is kept: below 0.837
        // it was themed (or the replay is off there), and the player's raise would rest on a guessed weight (refRatio).
        if (candIds.has(x.a.rowid)) refQ.set(x.a.rowid, r1x.userDelta ? rec / r1x.userDelta : NaN);
        else if (rec && r1x.userDelta) { const q = rec / r1x.userDelta; if (q > 0 && q < (win ? 0.316 : 0.837)) wt = win ? 0.1 : 0.7; }
        const r = wt === 1 ? r1x : rate(a, p, win, wt);
        w.set(i, wt); resid.push(r.userDelta - rec); recs.push(Math.abs(rec));
        free += rate({ ...a, rating: free }, p, win, wt).userDelta;
        a = { ...r.user };
      }
      if (n) free += J[n];
      return { end: a, free, w, resid, recs, refQ, themed: [...w.values()].filter((v) => v !== 1).length };
    }
    let best = null;
    for (const rd of rds) for (const vol of vols) {
      const A = asPlayed({ rd, vol }), e = A.resid.reduce((s, x) => s + x * x, 0);
      if (!best || e < best.e - 1e-9) best = { st: { rd, vol }, A, e };
    }
    const { st, A } = best;
    // The counterfactual: B = A + D, D carried through every later result by the same model (D's update is B's step
    // minus A's), a refunded miss in `won` played as a solve (D gains the solve minus the miss as recorded), its
    // give-back taken out of D where it was found (it is in today's rating, and a solve has no give-back).
    function counter(won, scale = 1) {
      let a = { rating: 0, rd: st.rd, vol: st.vol }, b = { ...a }, D = 0;
      const stepAt = new Map(), gb = (j) => { for (const [row, at] of gbAt) if (at === j && won.has(row)) D += seq.find((x) => x.a.rowid === row).a.user_delta; };
      for (let i = s0; i < n; i++) {
        const x = seq[i];
        if (i > s0) gb(i);
        if (!x.moves) continue;
        const p = scale === 1 ? x.p : { ...x.p, rd: Math.min(350, x.p.rd * scale) }, wt = A.w.get(i) ?? 1;
        a.rating = x.a.user_rating; b.rating = x.a.user_rating + D;
        let ra, rb;
        if (won.has(x.a.rowid)) { ra = rate(a, p, false, 1); rb = rate(b, p, true, 1); D += rb.userDelta - x.a.user_delta; stepAt.set(x.a.rowid, rb.userDelta); }
        else { ra = rate(a, p, !!x.a.win, wt); rb = rate(b, p, !!x.a.win, wt); D += rb.userDelta - ra.userDelta; }
        a = { ...ra.user }; b = { ...rb.user };
      }
      gb(n);
      return { rating: D, rd: b.rd - a.rd, vol: b.vol - a.vol, stepAt };
    }
    // Its refunds, oldest first: the state after the first k counted (k = 0: today's).
    const mine = cands.filter((c) => c.user_id === uid), states = [{ ...today }], corr = [{ rating: 0, rd: 0, vol: 0 }];
    for (let k = 1; k <= mine.length; k++) {
      const d = counter(new Set(mine.slice(0, k).map((c) => c.rowid)));
      corr.push(d); states.push(clampU({ rating: today.rating + d.rating, rd: today.rd + d.rd, vol: today.vol + d.vol }));
    }
    const all = new Set(mine.map((c) => c.rowid));
    const sens = Math.max(...[0.8, 1.2].map((s) => Math.abs(counter(all, s).rating - corr.at(-1).rating)));
    // The bound (header), after the first k refunds: the correction lies between −(their misses' costs) and +(their solves
    // as the counterfactual made them), ± BOUND_MARGIN. D gains solve + |miss| at the refunded row and loses |miss| at
    // the give-back; every later result shrinks it by a factor in (0, 1) (Glicko-2: φ'²g²E(1−E) = (1/v)/(1/φ*² + 1/v) < 1),
    // so the end lies between those. Nothing assumed about today's deviation: an early refund may stay large.
    const range = corr.map((d, k) => {
      const rows = mine.slice(0, k), solves = rows.reduce((s2, c) => s2 + (d.stepAt?.get(c.rowid) ?? 0), 0), misses = rows.reduce((s2, c) => s2 - c.user_delta, 0);
      return { lo: -misses - BOUND_MARGIN, hi: solves + BOUND_MARGIN };
    });
    const offR = A.free - today.rating, offRd = A.end.rd - today.rd, medRes = median(A.resid.map(Math.abs)), medRec = median(A.recs);
    const drift = [Math.abs(offR) > DRIFT.rating && `today's rating off by ${r1(offR)}`, Math.abs(offRd) > DRIFT.rd && `today's rd off by ${r1(offRd)}`,
      medRes > 0.25 * medRec + 1 && `rows' deltas off by a median ${r1(medRes)} (median |delta| ${r1(medRec)})`].filter(Boolean);
    // Win, never lower (header): raised only when the whole correction is above zero and the replay is trusted.
    const total = corr.at(-1).rating, over = mine.filter((c, k) => corr[k + 1].rating < range[k + 1].lo || corr[k + 1].rating > range[k + 1].hi).map((c) => c.rowid);
    // A refunded miss whose recorded cost is not the replay's weight-1 miss (ratio outside [0.837, 1/0.837]: below, it
    // was themed, 0.7, and its solve would have been 0.1 on the live path; either way the replay is off at the very row
    // that makes the correction): the solve's weight would be a guess, so the player is not raised.
    const offQ = mine.filter((c) => !(A.refQ.get(c.rowid) >= REF_Q && A.refQ.get(c.rowid) <= 1 / REF_Q));
    const flaws = [drift.length && `the replay does not reproduce the record (${drift.join('; ')})`,
      offQ.length && `the refunded miss at attempts row ${offQ.map((c) => `${c.rowid} cost ${(A.refQ.get(c.rowid) ?? NaN).toFixed(2)} of the replay's (themed, or the replay is off there)`).join(', ')}`,
      lost.length && `no give-back found for attempts row ${lost.join(', ')}`, over.length && `its correction leaves its bound at attempts row ${over.join(', ')}`].filter(Boolean);
    const raise = total > 0 && !flaws.length;
    // The hard refusals (a give-back not found, a bound overrun) are for a player who would be raised but for that flaw:
    // above zero, and nothing else (drift, a refunded row off the replay) already leaves them unchanged. For anyone
    // else they only mark the replay untrusted, printed, and block no one (rule 3). (A lost give-back pushes the total up
    // by the miss's cost, so "above zero" is the cautious reading there.)
    const blocks = total > 0 && !drift.length && !offQ.length;
    const why = raise ? null : flaws.length ? `${flaws.join('; ')}, so no change is made (computed ${sg(total)})` : `computed ${sg(total)}, never lowered`;
    return { uid, today, st, s0, nBefore, A, rows: A.resid.length, estimated, eloRows, ahead, offR, offRd, medRes, medRec, drift, lost, mine, states, corr, sens, range, gbFound: mine.length - lost.length,
      total, over, flaws, raise, blocks, why, refQ: A.refQ,
      // Other jumps, where they are (before which attempts row, or after the last row): a hand edit carried in both runs,
      // printed so each can be looked at on the snapshot before an --apply.
      jumps: J.map((j, k) => ({ j, k })).filter(({ j, k }) => k > s0 && Math.abs(j) >= 0.05 && ![...gbAt.values()].includes(k)).map(({ j, k }) => ({ j, at: k < n ? `before attempts row ${seq[k].a.rowid}` : 'after the last row' })) };
  }
  const plans = new Map();
  for (const c of cands) if (!plans.has(c.user_id)) plans.set(c.user_id, playerPlan(c.user_id));
  const overBound = [];

  const now = Date.now(), won = new Map(), tot = { user: 0, computed: 0, puzzle: 0, users: new Set(), clamped: 0 };
  if (APPLY) console.log('(tinue must be stopped, or POST /api/result blocked, while this runs: see the header)');
  console.log(`${APPLY ? 'counting' : 'dry run:'} ${cands.length} refunded miss${cands.length === 1 ? '' : 'es'} as solves, oldest first (computed for the player; applied: player and puzzle before -> after)`);
  for (const c of cands) {
    const z = puzzles.get(c.puzzle_id), k = z.rows.findIndex((a) => a.rowid === c.rowid), f = facing(z, k);
    const solve = rate(f.u, f.p, true, 1, f.pw).userDelta; // as a solve then, from the inferred deviations (printed and kept in the note only)
    const pl = plans.get(c.user_id), kk = pl.mine.findIndex((m) => m.rowid === c.rowid) + 1, last = kk === pl.mine.length;
    // Applied: the player's whole correction on their last refund when they are raised; else rating, rd and vol as they
    // are (the very values read, so the row is byte-equal), games and wins + 1 either way.
    const u = userOf(c.user_id), ub = userState(u), keep = { rating: ub.rating, rd: ub.rd, vol: ub.vol };
    const ua = { ...(pl.raise && last ? pl.states[kk] : keep), games: ub.games + 1, wins: ub.wins + 1 };
    const change = ua.rating - ub.rating, R = pl.range[kk], so = pl.corr[kk].rating, step = so - pl.corr[kk - 1].rating, outR = so < R.lo || so > R.hi;
    // Over the bound: a refusal only for a player who would be raised but for it (pl.blocks); else it marks the replay untrusted.
    if (outR && pl.blocks) overBound.push(`attempts row ${c.rowid} (player #${c.user_id}): correction so far ${sg(so)} outside [${sg(R.lo)}, ${sg(R.hi)}] (−misses' costs .. +solves, ± ${BOUND_MARGIN})`);
    const set = won.get(c.puzzle_id) ?? won.set(c.puzzle_id, new Set()).get(c.puzzle_id);
    set.add(c.rowid);
    const pb = puzzleState(z.P), { st, src } = splice(z, set), pa = { ...st, ...recount(z, set) };
    if (f.clamped) tot.clamped++;
    const chain = lastAfter.get(c.user_id), gap = chain && JSON.stringify(JSON.parse(chain.user_after)) !== JSON.stringify(ub);
    const applied = pl.raise ? (last ? `the player's whole correction, ${sg(pl.total)}, on their last refund` : `nothing yet: the player's correction goes on their last refund`) : `left unchanged: ${pl.why}`;
    console.log(`  attempt ${c.rowid} ${c.puzzle_id} player #${c.user_id}: computed ${sg(step)} (correction so far ${sg(so)}, bound [${sg(R.lo)}, ${sg(R.hi)}]${outR ? ' OUT OF BOUND' : ''}; as a solve then ${sg(solve)}, the miss had cost ${r1(c.user_delta)}, ${(pl.refQ.get(c.rowid) ?? NaN).toFixed(2)} of the replay's weight-1 miss${f.clamped ? ', rd clamped' : ''})`
      + `; applied: player ${r1(ub.rating)} -> ${r1(ua.rating)} (${sg(change)}, rd ${r1(ub.rd)} -> ${r1(ua.rd)}, wins ${ub.wins} -> ${ua.wins}: ${applied})`
      + ` · puzzle ${r1(pb.rating)} -> ${r1(pa.rating)} (${sg(pa.rating - pb.rating)}; rd ${r1(pb.rd)} -> ${r1(pa.rd)}; attempts ${pb.attempts} -> ${pa.attempts}, solves ${pb.solves} -> ${pa.solves}; solve step from ${src.get(c.rowid) ?? 'nothing recorded'})`
      + (gap ? ' [this player\'s ledger chain already differs from their row]' : ''));
    tot.user += change; tot.computed += step; tot.puzzle += pa.rating - pb.rating; tot.users.add(c.user_id);
    const { lastInsertRowid: aid } = addAttempt.run(NONCE + c.rowid, c.user_id, c.puzzle_id, u.name == null ? 1 : 0, c.ts, c.ts);
    db.prepare('UPDATE attempts SET win = 1, rated = 1, user_delta = ?, refund = 1 WHERE rowid = ?').run(change, c.rowid); // the History's Δ: applied, not the solve then
    db.prepare('UPDATE users SET rating = ?, rd = ?, vol = ?, games = ?, wins = ? WHERE id = ?').run(ua.rating, ua.rd, ua.vol, ua.games, ua.wins, u.id);
    db.prepare('UPDATE puzzles SET rating = ?, rd = ?, vol = ?, attempts = ?, solves = ? WHERE id = ?').run(pa.rating, pa.rd, pa.vol, pa.attempts, pa.solves, z.P.id);
    const delta = Object.fromEntries(Object.keys(ub).map((key) => [key, ua[key] - ub[key]]));
    addEvent.run(aid, now, JSON.stringify(ub), JSON.stringify(ua), JSON.stringify(pb), JSON.stringify(pa), JSON.stringify({ legacy: true, asWin: true, attempts_rowid: c.rowid,
      delta, miss: c.user_delta, solve, urd: f.u.rd, prd: f.p.rd, source: src.get(c.rowid) ?? null, method: 'replay difference', bound: [R.lo, R.hi], so, step,
      total: pl.total, rating: pl.raise ? 'raised' : 'unchanged', why: pl.why, start: pl.st, note: 'refunded by hand before the ledger; counted as a solve' }));
    Object.assign(u, ua); Object.assign(z.P, pa); // the next attempt starts from here
  }
  // Each player's replay, how closely its as-played run reproduces what is on record, and what is done with it.
  for (const pl of plans.values()) {
    const A = pl.A;
    console.log(`  player #${pl.uid}: ${pl.rows} rated rows replayed${pl.nBefore ? ` (after ${pl.nBefore} Elo rows)` : ''} from rd ${r1(pl.st.rd)}, vol ${pl.st.vol}`
      + `; as played it ends at ${r1(A.free)} (today ${r1(pl.today.rating)}: ${sg(pl.offR)}), rd ${r1(A.end.rd)} (today ${r1(pl.today.rd)}: ${sg(pl.offRd)})`
      + `; rows' deltas off by a median ${r1(pl.medRes)} (max ${r1(Math.max(0, ...A.resid.map(Math.abs)))}; median |delta| ${r1(pl.medRec)})`
      + `; ${A.themed} taken as themed, ${pl.estimated} with an estimated puzzle deviation (${pl.eloRows} from an Elo conversion), ${pl.ahead} newcomer rows with it from the next fitted row; give-backs found ${pl.gbFound}/${pl.mine.length}${pl.lost.length ? ` (NOT FOUND: attempts row ${pl.lost.join(', ')})` : ''}`
      + `; other jumps ${pl.jumps.length}${pl.jumps.length ? ` (${r1(pl.jumps.reduce((s, x) => s + Math.abs(x.j), 0))} in all: ${pl.jumps.map((x) => `${sg(x.j)} ${x.at}`).join(', ')})` : ''}`
      + `; correction ${sg(pl.total)} (±${r1(pl.sens)} with the puzzle deviations 20% lower or higher)`
      + (pl.drift.length ? ` DRIFT: ${pl.drift.join('; ')}` : '')
      + (pl.raise ? `; raised by ${sg(pl.total)}` : `; left unchanged: ${pl.why}`));
  }
  // Players' counters against their attempts rows (rated ones): a mismatch is printed, not fixed.
  const off = [...tot.users].filter((id) => { const u = getUser.get(id), n = db.prepare('SELECT COUNT(*) g, COALESCE(SUM(win), 0) w FROM attempts WHERE user_id = ? AND rated = 1').get(id); return u.games !== n.g || u.wins !== n.w; });
  const all = [...plans.values()], up = all.filter((pl) => pl.raise), low = all.filter((pl) => !pl.raise && !pl.flaws.length), bad = all.filter((pl) => pl.flaws.length);
  const ids = (xs) => xs.map((pl) => `#${pl.uid} ${sg(pl.total)}`).join(', ');
  const pl_ = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  console.log(`totals: ${pl_(cands.length, 'attempt')} counted as solves, ${pl_(tot.users.size, 'player')} (${sg(tot.computed)} rating computed in all, ${sg(tot.user)} applied), ${pl_(puzzles.size, 'puzzle')} (${sg(tot.puzzle)} in all)`
      + `; ${up.length} player${up.length === 1 ? '' : 's'} raised${up.length ? ` (${ids(up)})` : ''}, ${low.length + bad.length} left unchanged`
      + (low.length ? `, ${low.length} as the computed change is not above zero, never lowered (${ids(low)})` : '')
      + (bad.length ? `, ${bad.length} as the replay can't be trusted (${bad.map((pl) => `#${pl.uid}: ${pl.flaws.join('; ')}`).join(' / ')})` : '')
      + `; the deviation fits reproduce the recorded puzzle steps within ${residual.toExponential(1)} (by construction: not a check of the corrections)`
      + `; ${fallbacks} rated rows on these puzzles had no fitted deviation (estimated)`
      + `; with every inferred deviation 20% lower or higher, the corrected puzzle ratings move by up to ${r1(sens.d)}${sens.id ? ` (${sens.id})` : ''}${tot.clamped ? `; ${tot.clamped} player deviations clamped` : ''}${off.length ? `; players whose games/wins differ from their rated attempts rows: ${off.map((id) => '#' + id).join(' ')}` : ''}`);
  // The hard guards, for a player who would be raised but for them only (pl.blocks): anyone else is left unchanged anyway.
  const lostAll = all.filter((pl) => pl.blocks).flatMap((pl) => pl.lost.map((row) => `attempts row ${row} (player #${pl.uid})`));
  if (lostAll.length) { db.exec('ROLLBACK'); refuse(`no give-back found for ${lostAll.join(', ')}: no change between rows (or to today's rating) that no result explains matches its cost within ${GB_TOL}. Counting it as never given back would credit the miss's cost twice; find where it was given back first`); }
  if (overBound.length) { db.exec('ROLLBACK'); refuse(`a correction is out of bounds: ${overBound.join('; ')}`); }
  if (!APPLY) { db.exec('ROLLBACK'); console.log('dry run: nothing written (--apply to write)'); process.exit(0); }
  db.exec('COMMIT');
  console.log('written. The refund mark (flaw = 2) is unchanged: REFUND_MARK reads attempts.refund now.');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  throw e;
}
