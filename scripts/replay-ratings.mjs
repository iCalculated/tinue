// Replays the attempt ledger (server/log.js, PLAN §1.3 L4, acceptance A8): every rating_event in id order, from each
// user's and puzzle's first logged state, and checks that it reproduces each event's logged after-state and, at the
// end, today's users and puzzles rows, to |delta| < 1e-9. Read-only.
//
//   node --no-warnings scripts/replay-ratings.mjs --db <path> [--verbose]
//
// rate: shared/rating.js rate() on the running states (applyRate). refund: the user's chain replayed (replayUser: a
// refund counted as a solve replays its attempt as one, unless that would have lowered the player (kept: the attempt
// as played, the note's counts added at the event); one from before 2026-11-20 leaves it out), the puzzle
// compensated as refund.mjs does (compensateWin, or compensate for the older kind, then compensateUpgrade when
// refund.mjs later counted that older refund as a solve). A legacy refund (by hand, before
// the ledger: refund-legacy-wins.mjs) adds its logged delta to the user; its puzzle state was rebuilt from attempts
// rows, which the ledger can't replay, so the replay takes its logged after for the puzzle and checks the user only.
// A gap (an event whose before is not the running state: a write outside the ledger, a TINUE_LOG=0 window, an import
// resetting an unplayed puzzle) is listed and replay continues from the logged state. Exit 0 only when every event and
// every row matches and there is no gap; 1 otherwise.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { EVENTS, applyRate, replayUser, compensate, compensateWin, compensateUpgrade, userState, puzzleState } from '../server/log.js';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const file = opt('db');
if (!file || !fs.existsSync(file)) { console.error('replay-ratings: --db <existing path> is required'); process.exit(2); }
const db = new DatabaseSync(file, { readOnly: true });
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rating_event'").get()) { console.log('no ledger tables: nothing to replay'); process.exit(0); }

const TOL = 1e-9;
const diff = (a, b) => Math.max(...Object.keys(a).map((k) => Math.abs(a[k] - b[k])), Object.keys(a).length === Object.keys(b).length ? 0 : Infinity);
const U = new Map(), P = new Map(), chains = new Map(), rateOf = new Map();
const gaps = [], bad = [];
let maxEvent = 0, n = 0;
const note = (list, msg) => { list.push(msg); if (args.includes('--verbose') || list.length <= 20) console.log('  ' + msg); };
const anchor = (map, id, logged, what, e) => {
  if (!map.has(id)) return logged;
  const d = diff(map.get(id), logged);
  if (d >= TOL) { note(gaps, `gap: ${what} ${id} at rating_event ${e.id} (${e.kind}): running state differs from its before by ${d}`); return logged; }
  return map.get(id);
};
const check = (got, logged, what, e) => {
  const d = diff(got, logged);
  maxEvent = Math.max(maxEvent, d);
  if (d >= TOL) note(bad, `mismatch: ${what} after rating_event ${e.id} (${e.kind}): replay differs from the logged after by ${d}`);
};

for (const e of db.prepare(`${EVENTS} ORDER BY e.id`).iterate()) {
  n++;
  const chain = chains.get(e.user_id) ?? chains.set(e.user_id, []).get(e.user_id);
  chain.push(e);
  const ub = anchor(U, e.user_id, JSON.parse(e.user_before), 'user', e), pb = anchor(P, e.puzzle_id, JSON.parse(e.puzzle_before), 'puzzle', e);
  let u, p;
  if (e.kind === 'rate') {
    ({ u, p } = applyRate(ub, pb, e));
    rateOf.set(e.attempt_id, e);
  } else if (e.kind === 'refund') {
    const n = e.note ? JSON.parse(e.note) : {};
    if (n.legacy) { u = replayUser(chain); p = JSON.parse(e.puzzle_after); }
    else if (!rateOf.has(e.attempt_id)) { note(bad, `refund ${e.id} of attempt ${e.attempt_id} with no earlier rate event`); u = JSON.parse(e.user_after); p = JSON.parse(e.puzzle_after); }
    else { u = replayUser(chain); p = n.upgrade ? compensateUpgrade(pb, rateOf.get(e.attempt_id), n) : n.asWin ? compensateWin(pb, rateOf.get(e.attempt_id), n) : compensate(pb, rateOf.get(e.attempt_id)); }
  } else {
    note(bad, `rating_event ${e.id}: kind ${e.kind} is not replayed by this script`);
    u = JSON.parse(e.user_after); p = JSON.parse(e.puzzle_after);
  }
  check(u, JSON.parse(e.user_after), `user ${e.user_id}`, e);
  check(p, JSON.parse(e.puzzle_after), `puzzle ${e.puzzle_id}`, e);
  U.set(e.user_id, u); P.set(e.puzzle_id, p);
}

let maxRow = 0;
const rowCheck = (map, sql, state, what) => {
  const get = db.prepare(sql);
  for (const [id, s] of map) {
    const row = get.get(id);
    if (!row) { note(bad, `${what} ${id} is gone`); continue; }
    const d = diff(s, state(row));
    maxRow = Math.max(maxRow, d);
    if (d >= TOL) note(bad, `mismatch: ${what} ${id} row differs from the replay by ${d}`);
  }
};
rowCheck(U, 'SELECT * FROM users WHERE id = ?', userState, 'user');
rowCheck(P, 'SELECT * FROM puzzles WHERE id = ?', puzzleState, 'puzzle');
console.log(`replayed ${n} events over ${U.size} users and ${P.size} puzzles: max |delta| vs logged after ${maxEvent}, vs users/puzzles rows ${maxRow}; ${gaps.length} gaps, ${bad.length} mismatches`);
process.exit(gaps.length || bad.length ? 1 : 0);
