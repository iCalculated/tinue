// Refund one rated miss from the attempt ledger (server/log.js, PLAN §1.3 L3). A dry run unless --apply.
//
//   node --no-warnings scripts/refund.mjs --db <path> (--attempt <ledger attempt id> | --user <name or id> --puzzle <id>)
//        [--why "<reason>"] [--apply]
//
// A refund counts as a solve (Sasha, 2026-11-20: "I think the refund can count as a win for the player"; docs/alt-wins.md,
// Refunds). What it does, in one transaction:
//   - the user: their own chain of ledger events is replayed from its first state with this attempt (and every earlier
//     refund counted as a solve) replayed as a solve, at the weights a solve would have had (the theme's win weight;
//     a guest's half on the puzzle side): rating, rd, vol, games and wins as if they had solved it (replayUser). Never
//     lower (Sasha, 2026-11-21): when that replay ends no higher than today, rating, rd and vol stay as they are and
//     only wins (and games, for an upgrade) change; the event's note says kept: true with that delta, which replayUser
//     and replay-ratings.mjs add where the event stands, the attempt itself replaying as the miss it was (neverLower);
//   - the puzzle: one compensating step that takes the miss's own move out and puts the solve's in, both computed from
//     the states logged on this attempt's rate event (compensateWin): attempts stay, solves + 1, rd and vol stay.
//     Other players' results are never rewritten;
//   - attempts: the row becomes the solve (win = 1, rated = 1) with refund = 1, so REFUND_MARK (import.mjs), the History
//     and the players page see a refund counted as solved; its user_delta (the History's Δ) is the row's net effect on the
//     player's rating: the miss's cost, which stands (no give-back here), plus what this refund applied (after − before:
//     0 when kept). So the History still sums to the rating and the chart's point lands where the rating went (a kept
//     first-ever miss reads ✓ refunded −1161: it did cost that). For an upgrade the older refund already gave the miss
//     back, so it is what was applied alone, as for the legacy one-off. Never the solve then, which can be far from it
//     (a first-ever result: +1097 to a rating that did not move). The mark itself is not set here: run REFUND_MARK by
//     hand or let the next import;
//   - a 'refund' rating_event records the before and after states, with {asWin, w, pw} in its note, and, for the
//     record, solve (what the solve gave then, from the logged before-states) and miss (the row's Δ as recorded).
// A miss refunded the older way by this script before 2026-11-20 (left out of the chain, its attempts row rated = 0) is
// upgraded the same way: the chain replayed with it as a solve, and the puzzle given the solve's move and the attempt
// back (compensateUpgrade: the older refund already took the miss's move out); note.upgrade marks it.
// It refuses: an attempt without a ledger row (before L2: no exact chain; scripts/refund-legacy-wins.mjs is for those),
// an unrated attempt or a solve, one already refunded (a refund event, attempts.refund, or the legacy signature on its
// attempts row; but an older refund of this script's is upgraded, as above), duplicate attempts rows for the pair, and a user chain with a gap (an event whose before is not the
// previous after, or a users row that is not the last after).
// The database is never data/tinue.db by default: --db is required. Prints no tokens.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { EVENTS, replayUser, neverLower, compensateWin, compensateUpgrade, winWeights, addRefundColumn, userState, puzzleState } from '../server/log.js';
import { rate } from '../shared/rating.js';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes('--apply');
const die = (msg, code = 2) => { console.error('refund: ' + msg); process.exit(code); };
const refuse = (msg) => die('refused: ' + msg, 3);
const VALUES = ['--db', '--attempt', '--user', '--puzzle', '--why'];
const unknown = args.filter((a, i) => a.startsWith('--') && a !== '--apply' && !VALUES.includes(a) && !VALUES.includes(args[i - 1]));
if (unknown.length) die('unknown option ' + unknown.join(' '));

const file = opt('db') || die('--db <path> is required');
if (!fs.existsSync(file)) die(`no database at ${file}`);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000');
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rating_event'").get()) refuse('no ledger tables in this database (the server adds them at startup since L1)');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
db.exec('BEGIN IMMEDIATE'); // reads and writes see one state; a dry run rolls back
try {
  addRefundColumn(db); // (rolled back with a dry run)
  let att;
  if (opt('attempt')) att = db.prepare('SELECT * FROM attempt WHERE id = ?').get(+opt('attempt'));
  else {
    const who = opt('user') ?? die('--attempt, or --user and --puzzle');
    const pid = opt('puzzle') ?? die('--puzzle <id>');
    const u = /^\d+$/.test(who) ? db.prepare('SELECT id FROM users WHERE id = ?').get(+who) : db.prepare('SELECT id FROM users WHERE name = ?').get(who);
    if (!u) refuse(`no user ${who}`);
    att = db.prepare('SELECT * FROM attempt WHERE user_id = ? AND puzzle_id = ? AND first = 1').get(u.id, pid);
  }
  if (!att) refuse('no ledger attempt (attempts from before L2 have no exact chain to replay)');
  const rows = db.prepare('SELECT rowid, * FROM attempts WHERE user_id = ? AND puzzle_id = ?').all(att.user_id, att.puzzle_id);
  if (rows.length !== 1) refuse(`${rows.length} attempts rows for this user and puzzle (expected 1)`);
  const row = rows[0];
  if (row.refund != null) refuse('already refunded (attempts.refund is set)');
  const done = db.prepare("SELECT id, note FROM rating_event WHERE attempt_id = ? AND kind = 'refund' ORDER BY id").all(att.id);
  // An older refund (refund.mjs before 2026-11-20: the attempt left out, its attempts row rated = 0) is upgraded to a
  // solve: one older refund event and nothing newer, the legacy signature on its row. Anything else already refunded
  // is refused.
  const noteOf = (e) => (e.note ? JSON.parse(e.note) : {});
  const upgrade = done.length === 1 && !noteOf(done[0]).asWin && !noteOf(done[0]).legacy && row.rated === 0 && !row.win && !!row.user_delta;
  if (!upgrade && row.rated === 0 && row.user_delta) refuse('already refunded (legacy signature on its attempts row: rated = 0, user_delta <> 0)');
  if (!upgrade && done.length) refuse(`already refunded (rating_event ${done[0].id})`);
  const ev = db.prepare(`${EVENTS} WHERE e.attempt_id = ? AND e.kind = 'rate'`).get(att.id);
  if (!ev) refuse('no rate event for this attempt');
  if (!att.rated || !(row.rated || upgrade) || !ev.weight) refuse('not rated: nothing to refund');
  if (att.result || row.win) refuse('a solve: refunds are for rated misses');

  // The user's chain, checked link by link and against the users row.
  const chain = db.prepare(`${EVENTS} WHERE a.user_id = ? ORDER BY e.id`).all(att.user_id);
  for (let i = 1; i < chain.length; i++)
    if (!same(JSON.parse(chain[i].user_before), JSON.parse(chain[i - 1].user_after))) refuse(`user chain gap at rating_event ${chain[i].id} (its before is not event ${chain[i - 1].id}'s after)`);
  const user = db.prepare('SELECT id, name, rating, rd, vol, games, wins FROM users WHERE id = ?').get(att.user_id);
  const uNow = userState(user);
  if (!same(uNow, JSON.parse(chain.at(-1).user_after))) refuse(`the users row differs from the chain's last state (event ${chain.at(-1).id}): changed outside the ledger`);
  if (chain.some((e) => e.kind !== 'rate' && e.kind !== 'refund')) refuse(`user chain has an event kind this script does not replay (${[...new Set(chain.map((e) => e.kind))]})`);
  // Win, never lower (2026-11-21): when the chain with this attempt as a solve ends no higher, the player keeps rating,
  // rd and vol; the attempt still counts as a solve in wins (neverLower, log.js).
  const ww = winWeights(att), uWin = replayUser(chain, { attempt_id: att.id, asWin: true, ...ww }), { u: uNew, kept, delta } = neverLower(uNow, uWin, upgrade);
  const solveDelta = rate(JSON.parse(ev.user_before), JSON.parse(ev.puzzle_before), true, ww.w, ww.pw).userDelta; // the solve then (note only)
  const applied = uNew.rating - uNow.rating; // what the refund did to the rating (0 when kept)
  const shown = (upgrade ? 0 : row.user_delta) + applied; // the History's Δ: the row's net effect (the miss stands unless an older refund gave it back)

  const puzzle = db.prepare('SELECT * FROM puzzles WHERE id = ?').get(att.puzzle_id);
  if (!puzzle) refuse(`puzzle ${att.puzzle_id} is gone`);
  const pNow = puzzleState(puzzle), pNew = (upgrade ? compensateUpgrade : compensateWin)(pNow, ev, ww);

  const r1 = (x) => Math.round(x * 10) / 10;
  console.log(`${APPLY ? 'refunding' : 'dry run:'} attempt ${att.id}: user ${user.name ?? '(guest)'} #${user.id}, puzzle ${att.puzzle_id}, rated miss of ${new Date(row.ts).toISOString()} (user_delta ${r1(row.user_delta)})`);
  if (upgrade) console.log(`  refunded before 2026-11-20 the older way (rating_event ${done[0].id}: the miss left out); now counted as a solve too`);
  console.log(`  counted as a solve (weight ${ww.w}, puzzle ${ww.pw}): the solve gives ${r1(solveDelta)} where the miss cost ${r1(row.user_delta)}`);
  const sgn = (x) => (x >= 0 ? '+' : '') + r1(x);
  console.log(`  user   computed: rating ${r1(uNow.rating)} -> ${r1(uWin.rating)} (${sgn(uWin.rating - uNow.rating)}), rd ${r1(uNow.rd)} -> ${r1(uWin.rd)}; ${chain.length} chain events replayed`);
  console.log(`  user   applied: rating ${r1(uNow.rating)} -> ${r1(uNew.rating)} (${sgn(uNew.rating - uNow.rating)}), rd ${r1(uNow.rd)} -> ${r1(uNew.rd)}, games ${uNow.games} -> ${uNew.games}, wins ${uNow.wins} -> ${uNew.wins}`
    + (kept ? `; left unchanged: computed ${sgn(uWin.rating - uNow.rating)}, never lowered` : ''));
  console.log(`  History: the row reads refunded, counted as solved, ${sgn(shown)} (${upgrade ? 'the change applied' : `the miss ${sgn(row.user_delta)} and the change applied ${sgn(applied)}`}; the solve then stays in the event's note)`);
  console.log(`  puzzle rating ${r1(pNow.rating)} -> ${r1(pNew.rating)}, attempts ${pNow.attempts} -> ${pNew.attempts}, solves ${pNow.solves} -> ${pNew.solves}`);
  if (!APPLY) { db.exec('ROLLBACK'); console.log('dry run: nothing written (--apply to write)'); process.exit(0); }

  db.prepare('UPDATE users SET rating = ?, rd = ?, vol = ?, games = ?, wins = ? WHERE id = ?').run(uNew.rating, uNew.rd, uNew.vol, uNew.games, uNew.wins, user.id);
  db.prepare('UPDATE puzzles SET rating = ?, attempts = ?, solves = ? WHERE id = ?').run(pNew.rating, pNew.attempts, pNew.solves, puzzle.id);
  db.prepare('UPDATE attempts SET win = 1, rated = 1, user_delta = ?, refund = 1 WHERE rowid = ?').run(shown, row.rowid);
  db.prepare(`INSERT INTO rating_event (attempt_id, kind, ts, by, weight, user_before, user_after, puzzle_before, puzzle_after, note)
    VALUES (?, 'refund', ?, 'refund.mjs', ?, ?, ?, ?, ?, ?)`).run(att.id, Date.now(), ev.weight, JSON.stringify(uNow), JSON.stringify(uNew),
    JSON.stringify(pNow), JSON.stringify(pNew), JSON.stringify({ why: opt('why') ?? null, asWin: true, w: ww.w, pw: ww.pw, solve: solveDelta, miss: row.user_delta, ...(upgrade ? { upgrade: true } : {}),
      ...(kept ? { kept: true, delta, computed: uWin.rating - uNow.rating } : {}),
      note: (upgrade ? 'an older refund, now counted as a solve' : 'counted as a solve') + (kept ? '; rating kept (the solve would have lowered it)' : '') }));
  db.exec('COMMIT');
  console.log('written. REFUND_MARK (scripts/import.mjs) marks the puzzle at the next import, or run it by hand now.');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  throw e;
}
