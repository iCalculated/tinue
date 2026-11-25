// scripts/refund-legacy-wins.mjs (the misses refunded by hand before the ledger, now counted as solves) and what reads a
// refund afterwards (REFUNDED_SQL, the players page, a later ledger refund, replay-ratings.mjs). Synthetic databases
// in a temp dir, schema made by server/server.js itself; made-up players only.   node --no-warnings scripts/test-refund.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { rate } from '../shared/rating.js';
import { REFUNDED_SQL, userState, puzzleState, ratedUser, ratedPuzzle, compensate } from '../server/log.js';
import { puzzleStats, isRefund } from './players-live/puzzle-stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-refund-'));
const node = (script, ...a) => spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, script), ...a], { encoding: 'utf8' });
const legacy = (F, ...a) => node('scripts/refund-legacy-wins.mjs', '--db', F, ...a);
const near = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);
const J = (s) => JSON.parse(s);
const r1x = (x) => x.toFixed(1), sg = (x) => (x >= 0 ? '+' : '') + r1x(x);

// A database with tinue's real schema (server.js's startup, ledger and attempts.refund included), nothing in it.
function empty(name) {
  const F = path.join(dir, name);
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/server.js')).href)}); process.exit(0)`],
    { env: { ...process.env, TINUE_DB: F, TINUE_SYNTAKS: '/nonexistent' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return F;
}
const DAY = 86400e3, T = Date.UTC(2026, 10, 12, 18), ELO_T = Date.UTC(2026, 10, 7); // the hand refunds' week; the Elo era
// A puzzle's results played through rate() (weight 1, the given deviations): the recorded path, and with asWin the
// truth of this made-up world had those misses been solves, which the splice can only approximate (it doesn't know
// the deviations).
function play(start, results, asWin = new Set()) {
  let p = { ...start }; const rows = [];
  results.forEach((x, i) => {
    const win = !!x.win || asWin.has(i), r = rate({ rating: x.ur, rd: x.urd, vol: 0.06 }, p, win, 1, 1);
    rows.push({ ...x, pr: p.rating, ud: r.userDelta }); p = { ...r.puzzle };
  });
  return { rows, p };
}
const FIVE = [{ uid: 2, ur: 2650, urd: 90, ref: 1 }, { uid: 3, ur: 2700, urd: 80, ref: 1 }, { uid: 4, ur: 2900, urd: 70, win: 1 }, { uid: 5, ur: 2600, urd: 80, ref: 1 }, { uid: 6, ur: 2750, urd: 70, win: 1 }];
const PAIR = [{ uid: 2, ur: 2650, urd: 90, ref: 1 }, { uid: 7, ur: 1900, urd: 90 }];
const START = (r) => ({ rating: r, rd: 250, vol: 0.09 }), refIdx = (xs) => new Set(xs.flatMap((x, i) => (x.ref ? [i] : [])));
// The legacy world: every attempts row is as the hand refunds left it (rated = 0, win = 0, user_delta = the miss's
// cost; the player's rating already has it back and one game fewer; the puzzle keeps or lost the miss's rise). A
// refunded player's users row (and bo's next row) is where the give-back put them: the rating before the miss.
function world(name) {
  const F = empty(name), d = new DatabaseSync(F);
  const U = d.prepare('INSERT INTO users (id, name, token_hash, gid, rating, rd, vol, games, wins, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const P = d.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, rd, vol, attempts, solves) VALUES (?, 6, 't', 3, '{}', 'test', ?,?,?,?,?,?)`);
  const A = d.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts) VALUES (?,?,?,?,?,?,?,?)');
  const users = [[1, 'ann', 1500, 100, 0.06, 3, 2], [2, 'bo', 2650, 90, 0.06, 0, 0], [3, 'cy', 2700, 80, 0.06, 0, 0], [4, 'dee', 2905, 70, 0.06, 1, 1],
    [5, 'eve', 2600, 80, 0.06, 0, 0], [6, 'fay', 2806, 70, 0.06, 1, 1], [7, 'gus', 1895, 90, 0.06, 1, 0], [8, 'hal', 2100, 120, 0.06, 0, 0],
    [9, null, 2100, 120, 0.06, 0, 0], [10, null, 1700, 300, 0.06, 1, 1], [11, 'ivy', 2200, 100, 0.06, 0, 0], [12, 'jo', 1500, 400, 0.06, 0, 0], [13, 'kit', 1600, 100, 0.06, 0, 0], [14, 'lu', 1700, 100, 0.06, 0, 0]];
  for (const [id, n, r, rd, vol, g, w] of users) U.run(id, n, 'h' + id, n ? null : 'g'.repeat(31) + id % 10, r, rd, vol, g, w, id === 10 ? T + 7 * 60e3 : T - DAY);
  // The refunded players' Elo-era results (before 2026-11-07 18:02 PST, on a puzzle of their own): the player-side replay
  // starts them at rdFromCount(that many, 250), about the deviation they are given here. jo (12) is a newcomer: none.
  P.run('elo', 1500, 1500, 250, 0.09, 0, 0);
  for (const [id, n] of [[1, 21], [2, 27], [3, 35], [5, 35], [8, 13], [9, 13], [11, 21], [14, 21]]) {
    const r = users.find((u) => u[0] === id)[2];
    for (let k = 0; k < n; k++) A.run(id, 'elo', k % 2, 1, r, 1500, 0, ELO_T - (n - k) * 60e3 - id * 3600e3);
  }
  // solo: one refunded miss, nothing else; equal ratings (the hand-checked case below). Kept its +40.
  P.run('solo', 1500, 1540, 240, 0.09, 1, 0);
  A.run(1, 'solo', 0, 0, 1500, 1500, -11, T);
  for (const [i, w] of [[1, 1], [2, 1], [3, 0]]) { P.run('o' + i, 1500, 1500, 200, 0.09, 1, w); A.run(1, 'o' + i, w, 1, 1500, 1500, w ? 5 : -5, T - DAY + i); } // ann's other games
  // five: pd528655's shape, five results, the 1st, 2nd and 4th refunded (each raised it), two solves after; pair: bo's
  // second refund, then gus's ordinary miss. Played through rate(): a path Glicko could have made.
  let t = T;
  for (const [id, xs, at] of [['five', FIVE, 1e3], ['pair', PAIR, -10e3]]) {
    const { rows, p } = play(START(id === 'five' ? 2564 : 1800), xs);
    P.run(id, xs === FIVE ? 2564 : 1800, p.rating, p.rd, p.vol, xs.length, xs.filter((x) => x.win).length);
    rows.forEach((x, i) => A.run(x.uid, id, x.win ? 1 : 0, x.ref ? 0 : 1, x.ur, x.pr, x.ud, (t = T + at + i * 1e3)));
  }
  // jmp: a refunded miss whose recorded rise (+400) is more than any one result can move a puzzle: a hand edit on top.
  P.run('jmp', 1700, 2100, 230, 0.09, 1, 0); A.run(14, 'jmp', 0, 0, 1700, 1700, -6, T + 13e3);
  // twins: an account and a guest, same ratings, the puzzle's rise taken back by hand (not to its start: rd 230).
  P.run('gA', 2000, 2000, 230, 0.09, 1, 0); P.run('gG', 2000, 2000, 230, 0.09, 1, 0);
  A.run(8, 'gA', 0, 0, 2100, 2000, -10, T + 7e3); A.run(9, 'gG', 0, 0, 2100, 2000, -10, T + 8e3);
  A.run(10, 'gG', 1, 1, 1500, 2000, 40, T - DAY); // a guest's result from before it had an account (replayed): never moved a puzzle
  // rst: put back to its start by hand. nwb: a newcomer's miss (clueless: moved nothing). acc: a page accident refunded
  // with user_delta 0 (not a refund mark). cas: a casual try.
  P.run('rst', 2000, 2000, 250, 0.09, 0, 0); A.run(11, 'rst', 0, 0, 2200, 2000, -15, T + 9e3);
  P.run('nwb', 1500, 1500, 200, 0.09, 1, 0); A.run(12, 'nwb', 0, 0, 1500, 1500, -200, T + 10e3);
  P.run('acc', 1600, 1600, 250, 0.09, 0, 0); A.run(13, 'acc', 0, 0, 1600, 1600, 0, T + 11e3);
  P.run('cas', 1600, 1600, 250, 0.09, 0, 0); A.run(13, 'cas', 1, 0, 1600, 1600, 0, T + 12e3);
  d.close();
  return F;
}
const N = 10; // refunded misses in the world: solo 1, five 3, pair 1, gA 1, gG 1, rst 1, nwb 1, jmp 1
const PUZZLES = ['five', 'gA', 'gG', 'jmp', 'nwb', 'pair', 'rst', 'solo'];
const snap = (F) => {
  const d = new DatabaseSync(F, { readOnly: true }), o = { schema: d.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all().map((r) => ({ ...r })) };
  for (const t of ['users', 'puzzles', 'attempts', 'attempt', 'rating_event']) o[t] = d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }));
  d.close(); return o;
};
const read = (F, sql, ...a) => { const d = new DatabaseSync(F, { readOnly: true }); const r = d.prepare(sql).all(...a).map((x) => ({ ...x })); d.close(); return r; };
const pz = (F, id) => read(F, 'SELECT * FROM puzzles WHERE id = ?', id)[0], us = (F, id) => read(F, 'SELECT * FROM users WHERE id = ?', id)[0];
const label = (id) => 'u' + id;
// The History's Δ on a refunded row is its net effect on the player's rating: what its refund event applied (after −
// before), plus the miss's cost (note.miss) when the refund gave no miss back (refund.mjs on a fresh miss; not an
// upgrade or the legacy one-off, whose misses were given back), never the solve then; with the database before (snap()),
// each player's refunded rows sum to their rating's whole change.
function historyIsApplied(G, before) {
  const evs = read(G, "SELECT e.user_before, e.user_after, e.note, a.user_id, a.puzzle_id FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE e.kind = 'refund'");
  assert.ok(evs.length, 'refund events');
  for (const e of evs) {
    const row = read(G, 'SELECT user_delta d, refund FROM attempts WHERE user_id = ? AND puzzle_id = ?', e.user_id, e.puzzle_id)[0];
    const n = J(e.note), stands = n.asWin && !n.upgrade && !n.legacy ? n.miss : 0;
    assert.equal(row.refund, 1); assert.equal(row.d, stands + (J(e.user_after).rating - J(e.user_before).rating), `History Δ of ${e.puzzle_id}: the net effect`);
    assert.ok(Number.isFinite(J(e.note).solve), 'the solve then stays in the note');
  }
  if (before) for (const uid of new Set(evs.map((e) => e.user_id))) {
    const sum = read(G, 'SELECT SUM(user_delta) s FROM attempts WHERE user_id = ? AND refund = 1', uid)[0].s, b = before.users.find((u) => u.id === uid);
    near(sum, us(G, uid).rating - b.rating, `#${uid}: refunded rows sum to the rating's change`, 1e-9);
  }
}

// The whole History adds up: from the first rated row's rating before, every rated row's Δ sums to today's rating, and
// the chart's last row point (user_rating + user_delta, public/app.js) sits on it when a refund is the last row.
function historyAddsUp(G, uid) {
  const rows = read(G, 'SELECT user_rating r, user_delta d FROM attempts WHERE user_id = ? AND rated = 1 ORDER BY ts', uid);
  near(rows.reduce((s, x) => s + x.d, rows[0].r), us(G, uid).rating, `#${uid}: the History's Δs sum to the rating`, 1e-6);
}

const F = world('legacy.db'), before = snap(F);
const marked = (G) => read(G, `SELECT DISTINCT puzzle_id p FROM attempts WHERE ${REFUNDED_SQL('attempts')} ORDER BY p`).map((r) => r.p);
assert.deepEqual(marked(F), PUZZLES, 'the legacy signature, read through REFUNDED_SQL');
const statsBefore = (() => { const d = new DatabaseSync(F, { readOnly: true }); const s = puzzleStats(d, label); d.close(); return s; })();

// The dry run: one line per attempt, ids only, totals; nothing written, not even the column check's schema.
{
  const r = legacy(F, '--expect', String(N));
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => /^ {2}attempt \d+ /.test(l));
  assert.equal(lines.length, N, r.stdout);
  assert.match(r.stdout, /^totals: 10 attempts counted as solves, 9 players .* 8 puzzles/m);
  assert.ok(+/within ([\d.e+-]+)/.exec(r.stdout)[1] < 1e-3, 'the splice with nothing changed is the recorded path'); assert.match(r.stdout, /dry run: nothing written/);
  assert.match(r.stdout, /by construction: not a check of the corrections/); assert.match(r.stdout, /20% lower or higher, the corrected puzzle ratings move by up to [\d.]+ \(\w+\)/);
  for (const n of ['ann', 'bo', 'hal', 'ggg']) assert.ok(!new RegExp(`\\b${n}\\b`).test(r.stdout), 'no names or gids: ' + n);
  // these made-up players have no consistent history (one or two rows each, deviations set by hand): the replay says so
  assert.match(r.stdout, /player #1: .* DRIFT: .*; left unchanged: the replay does not reproduce the record \(.*\), so no change is made \(computed [+-]\d+\.\d\)$/m);
  assert.match(r.stdout, /left unchanged, .*as the replay can't be trusted \(#1: /); assert.doesNotMatch(r.stdout, /--apply will refuse/);
  assert.deepEqual(snap(F), before, 'a dry run writes nothing');
  console.log('ok dry run: one line per attempt (ids only) and totals; the database is byte-for-byte as it was');
}

// Refusals.
{
  assert.equal(node('scripts/refund-legacy-wins.mjs').status, 2, 'no --db');
  let r = legacy(F, '--apply');
  assert.equal(r.status, 3); assert.match(r.stderr, /10 refunded misses to count \(\+ 0 done\) where 34 were expected/);
  r = legacy(F, '--expect', '9', '--apply'); assert.equal(r.status, 3);
  const bare = path.join(dir, 'bare.db'); { const d = new DatabaseSync(bare); d.exec('CREATE TABLE users (id INTEGER)'); d.close(); }
  r = legacy(bare, '--apply'); assert.equal(r.status, 3); assert.match(r.stderr, /no puzzles table/);
  const late = path.join(dir, 'late.db'); fs.copyFileSync(F, late);
  { const d = new DatabaseSync(late); d.exec(`UPDATE attempts SET ts = ${Date.UTC(2026, 10, 19)} WHERE puzzle_id = 'solo'`); d.close(); }
  r = legacy(late, '--expect', String(N), '--apply'); assert.equal(r.status, 3); assert.match(r.stderr, /outside the hand refunds/);
  const led = path.join(dir, 'led.db'); fs.copyFileSync(F, led);
  { const d = new DatabaseSync(led); d.exec(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, "commit", mode, opened, state) VALUES ('x', 1, 'solo', 1, '', 'legacy', 1, 'closed')`); d.close(); }
  r = legacy(led, '--expect', String(N), '--apply'); assert.equal(r.status, 3); assert.match(r.stderr, /has a ledger attempt/);
  assert.deepEqual(snap(F), before);
  console.log('ok refusals: no --db, a count other than expected, no ledger tables, a candidate outside Nov 10–16, one with a ledger attempt');
}

// --apply. These players' histories are made up: most drift, and a drifting player is left unchanged (rating, rd and vol
// exactly as before; games and wins + 1 each refund) without stopping the run. --allow-drift is gone.
for (const o of [legacy(F, '--expect', String(N), '--apply', '--no-deploycheck'), node('scripts/refund.mjs', '--db', F, '--attempt', '1', '--aply')]) { assert.equal(o.status, 2); assert.match(o.stderr, /unknown option --/); assert.deepEqual(snap(F), before); }
{ const o = legacy(F, '--expect', String(N), '--apply', '--allow-drift'); assert.equal(o.status, 2); assert.match(o.stderr, /--allow-drift is gone/); assert.deepEqual(snap(F), before); }
const r = legacy(F, '--expect', String(N), '--apply');
assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^written/m);
const after = snap(F);
const driftIds = [...r.stdout.matchAll(/^ {2}player #(\d+): .* DRIFT: .*; left unchanged: /gm)].map((m) => +m[1]);
assert.ok(driftIds.length >= 4 && driftIds.includes(1), 'drifting players left unchanged: ' + driftIds);
for (const id of driftIds) {
  const b = before.users.find((u) => u.id === id), a = us(F, id), n = before.attempts.filter((x) => x.user_id === id && !x.rated && !x.win && x.user_delta).length;
  assert.deepEqual([a.rating, a.rd, a.vol], [b.rating, b.rd, b.vol], 'byte-equal: #' + id); assert.deepEqual([a.games, a.wins], [b.games + n, b.wins + n], 'counted: #' + id);
}
{
  // solo, by hand (the puzzle side; ann drifts, so she is left unchanged, and the
  // player-side hand check is the "hand-checked" world further down). ann missed solo (1500 vs 1500) for −11: the
  // solve then is the miss's mirror at E = 0.5: +11, kept in the event's note; the History's Δ is what was applied, 0
  // (ann is unchanged). Puzzle: it rose 40 on the miss (1500 → 1540); its
  // deviation then is the one that makes rate() give +40, and at E = 0.5 the puzzle's own update mirrors too, so the
  // solve's step is −40, taken from 1500 (the rating before the miss): 1460. rd 240 stays. attempts recounted 1, solves 1.
  assert.deepEqual([us(F, 1).games, us(F, 1).wins], [4, 3]);
  assert.deepEqual(userState(us(F, 1)), J(read(F, "SELECT e.user_after FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.user_id = 1")[0].user_after), 'ann: the event\'s after');
  near(pz(F, 'solo').rating, 1460, 'solo', 1e-6); assert.deepEqual([pz(F, 'solo').rd, pz(F, 'solo').attempts, pz(F, 'solo').solves], [240, 1, 1]);
  const row = read(F, "SELECT * FROM attempts WHERE puzzle_id = 'solo'")[0];
  assert.deepEqual([row.win, row.rated, row.refund, row.user_rating, row.puzzle_rating, row.user_delta], [1, 1, 1, 1500, 1500, 0], 'History Δ: nothing applied');
  near(J(read(F, "SELECT e.note FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.puzzle_id = 'solo'")[0].note).solve, 11, 'the solve then, in the note', 1e-6);

  // five: three events, each one lowering the puzzle; every result now a solve; the two ordinary rows untouched.
  const ev = read(F, "SELECT e.*, a.nonce FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.puzzle_id = 'five' ORDER BY e.id");
  assert.equal(ev.length, 3);
  ev.forEach((e, i) => { assert.ok(J(e.puzzle_after).rating < J(e.puzzle_before).rating, 'a solve lowers five'); if (i) assert.deepEqual(J(e.puzzle_before), J(ev[i - 1].puzzle_after), 'chained'); });
  assert.deepEqual(J(ev[0].puzzle_before), puzzleState(before.puzzles.find((p) => p.id === 'five')));
  const five = pz(F, 'five'), f0 = before.puzzles.find((p) => p.id === 'five');
  assert.deepEqual([five.attempts, five.solves, five.rd], [5, 5, f0.rd]);
  // against this world's truth (the same results played with those three as solves): close, not exact (the splice
  // doesn't know the deviations the results were played with)
  const truthFive = play(START(2564), FIVE, refIdx(FIVE)).p.rating, truthPair = play(START(1800), PAIR, refIdx(PAIR)).p.rating;
  near(five.rating, truthFive, 'five vs truth', 15); near(pz(F, 'pair').rating, truthPair, 'pair vs truth', 15);
  assert.ok(f0.rating - five.rating > 150, 'three misses replaced by solves');
  assert.deepEqual(read(F, "SELECT win, rated, refund FROM attempts WHERE puzzle_id = 'five' ORDER BY ts").map((a) => [a.win, a.rated, a.refund]), [[1, 1, 1], [1, 1, 1], [1, 1, null], [1, 1, 1], [1, 1, null]]);

  // bo: two refunds, oldest (pair) first; his events chain; games and wins + 2.
  const bo = read(F, 'SELECT e.* FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.user_id = 2 ORDER BY e.id');
  assert.equal(bo.length, 2); assert.equal(read(F, 'SELECT puzzle_id FROM attempt WHERE id = ?', bo[0].attempt_id)[0].puzzle_id, 'pair');
  assert.deepEqual(J(bo[1].user_before), J(bo[0].user_after));
  const b0 = before.users.find((u) => u.id === 2), b1 = us(F, 2);
  const gain = bo.reduce((s, e) => s + J(e.note).delta.rating, 0);
  near(b1.rating, b0.rating + gain, 'bo: the two events\' deltas'); assert.deepEqual([b1.games, b1.wins], [2, 2]);
  assert.ok(gain > 0); assert.deepEqual(userState(b1), J(bo[1].user_after));
  // bo's first refund (pair, the puzzle's first result: deviation 250 known) is exactly the truth's solve
  near(J(read(F, "SELECT e.note FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.user_id = 2 AND a.puzzle_id = 'pair'")[0].note).solve, rate({ rating: 2650, rd: 90, vol: 0.06 }, START(1800), true).userDelta, 'bo on pair', 1e-4);
  // pair: gus's later miss stays a miss, rescaled for the lower rating (a miss against an easier puzzle raises it more).
  assert.ok(pz(F, 'pair').rating < before.puzzles.find((p) => p.id === 'pair').rating); assert.deepEqual([pz(F, 'pair').attempts, pz(F, 'pair').solves], [2, 1]);

  // twins: the guest moves its puzzle by exactly half (blend is linear in the weight); both players (drifting: made-up histories) left as they were.
  const mA = pz(F, 'gA').rating - 2000, mG = pz(F, 'gG').rating - 2000;
  assert.ok(mA < 0); near(mG, mA / 2, 'guest half weight');
  near(us(F, 8).rating - 2100, us(F, 9).rating - 2100, 'same solve for the player');
  assert.deepEqual([pz(F, 'gG').attempts, pz(F, 'gG').solves], [1, 1], 'the pre-account guest row is not counted on the puzzle');
  assert.match(r.stdout, /gG player #9: .*solve step from rate\(\): its rise was taken back by hand/);

  // rst: from its start, rd and all. nwb: a newcomer's solve moves no puzzle, and gives him the mirror of his −200.
  const rst = pz(F, 'rst');
  assert.ok(rst.rating < 2000 && rst.rd < 250); assert.deepEqual([rst.attempts, rst.solves], [1, 1]); assert.match(r.stdout, /rst player #11: .*back at its start/);
  const nwbEv = read(F, "SELECT e.note FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.puzzle_id = 'nwb'")[0];
  assert.ok(J(nwbEv.note).urd >= 230, 'a newcomer: ' + J(nwbEv.note).urd);
  assert.equal(pz(F, 'nwb').rating, 1500); near(J(nwbEv.note).solve, 200, 'the solve then: equal ratings, the mirror of −200', 1e-6);
  // jmp: the rise beyond one result's reach stays (a hand edit, not this result's); the miss's own part is swapped.
  assert.match(r.stdout, /jmp player #14: .*more than one result can move it/);
  // At equal ratings the miss's own move and the solve's mirror each other (E = 0.5): 1700 + (400 − own) − own.
  const own = (2100 - pz(F, 'jmp').rating) / 2;
  assert.ok(own > 50 && own < 200, 'one result\'s move: ' + own);
  // acc, cas and every non-candidate row untouched.
  const untouched = (t, key) => before[t].filter((x) => !after[t].some((y) => JSON.stringify(y) === JSON.stringify(x))).map((x) => x[key]);
  assert.deepEqual(untouched('puzzles', 'id').sort(), PUZZLES);
  assert.deepEqual(untouched('users', 'id').sort((a, b) => a - b), [1, 2, 3, 5, 8, 9, 11, 12, 14]);
  assert.equal(untouched('attempts', 'puzzle_id').length, N);

  // The ledger: one synthetic attempt + one 'refund' event per attempt; the users rows are each chain's last state, and
  // replay-ratings.mjs reproduces them (the user side through the logged delta).
  assert.equal(after.attempt.length, N); assert.ok(after.attempt.every((a) => a.nonce.startsWith('refund-legacy-') && a.result === 0 && a.first === 1 && a.rated === 0 && a.unrated_why === 'refund-legacy'));
  // false-miss-report.mjs's and rejudge.mjs's rated-miss queries (their WHERE clauses) see none of them
  assert.equal(read(F, "SELECT COUNT(*) n FROM attempt a WHERE a.mode = 'legacy' AND a.first = 1 AND a.result = 0 AND a.rated = 1")[0].n, 0, 'no rated legacy misses for the reports');
  assert.equal(after.rating_event.length, N);
  for (const e of after.rating_event) { const n = J(e.note); assert.deepEqual([e.kind, n.legacy, n.asWin], ['refund', true, true]); assert.equal(n.delta.games, 1); }
  historyIsApplied(F, before);
  const x = node('scripts/replay-ratings.mjs', '--db', F); assert.equal(x.status, 0, x.stdout + x.stderr); assert.match(x.stdout, /0 gaps, 0 mismatches/);
  // REFUND_MARK still sees every refunded puzzle (by attempts.refund now), and nothing else.
  assert.deepEqual(marked(F), PUZZLES);
  console.log(`ok apply (made-up histories: drifting players left unchanged): solo by hand (History Δ +11, puzzle 1540 → 1460); five ${f0.rating.toFixed(1)} → ${five.rating.toFixed(1)} over three chained solves (truth ${truthFive.toFixed(1)}); bo's two refunds chain; a guest moves its puzzle half as far; a puzzle at its start rated from there; a newcomer moves nothing; others untouched; the ledger replays; the refund mark still holds`);
}

// Idempotent: a second --apply finds nothing and writes nothing.
{
  const r2 = legacy(F, '--apply');
  assert.equal(r2.status, 0, r2.stderr); assert.match(r2.stdout, /nothing to do/);
  assert.deepEqual(snap(F), after);
  console.log('ok idempotent: a second --apply has nothing to do');
}

// The players page: before, refunded misses with what they kept; after, refunded solves, nothing kept.
{
  const d = new DatabaseSync(F, { readOnly: true }), s = puzzleStats(d, label); d.close();
  const steps = (S, id) => S.puzzles.find((p) => p.id === id).steps;
  assert.deepEqual(steps(statsBefore, 'solo').map((x) => [x.refund, x.won, x.kept]), [[1, undefined, 40]]);
  const fr = play(START(2564), FIVE).rows, rise = (i) => Math.round(fr[i + 1].pr - fr[i].pr);
  assert.deepEqual(steps(statsBefore, 'five').map((x) => x.kept ?? null), [rise(0), rise(1), null, rise(3), null]);
  assert.ok(rise(0) > 0 && rise(1) > 0 && rise(3) > 0);
  // solo: the refunded step as played (the miss's +40, now marked a solve), then the refund's own move, −80, a step of
  // its own at the refund's time, ending at today's rating.
  const rt = after.rating_event[0].ts;
  assert.deepEqual(steps(s, 'solo').map((x) => [x.refund, x.won, x.kept, x.win, x.rt ?? null, x.fix ?? 0, x.after, x.rose ?? null, x.back]),
    [[1, 1, undefined, 1, rt, 0, 1540, 40, -80], [1, 1, undefined, 1, null, 1, 1460, null, -80]]);
  const real = (S, id) => steps(S, id).filter((x) => !x.fix);
  assert.deepEqual(real(s, 'five').map((x) => [x.refund ?? 0, x.won ?? 0, x.win]), [[1, 1, 1], [1, 1, 1], [0, 0, 1], [1, 1, 1], [0, 0, 1]]);
  // Every result's step is drawn as recorded: the corrections are not put on the last result (fay's solve on five,
  // gus's miss on pair), they are the fix steps, which end at today's rating.
  for (const id of ['five', 'pair']) {
    assert.deepEqual(real(s, id).map((x) => x.after), real(statsBefore, id).map((x) => x.after), id + ': results drawn as recorded');
    const fx = steps(s, id).filter((x) => x.fix), P = s.puzzles.find((q) => q.id === id);
    assert.equal(fx.length, id === 'five' ? 3 : 1); assert.equal(fx.at(-1).after, P.rating); assert.ok(fx.every((x) => x.back < 0), id + ': each solve lowers it');
    assert.equal(P.plays, real(s, id).length, 'fix steps are not plays');
  }
  assert.ok(real(s, 'pair')[1].win === 0 && real(s, 'pair')[1].after > real(s, 'pair')[0].after, "gus's miss is drawn raising the puzzle, as it did");
  assert.ok(s.puzzles.flatMap((p) => p.steps).every((x) => !(x.kept > 0)), 'nothing claims a rise is still kept');
  assert.equal(steps(s, 'acc')[0].refund, undefined, 'an accident refund (user_delta 0) is not a refund mark');
  assert.ok(isRefund({ rated: 1, win: 1, user_delta: 5, refund: 1 }) && isRefund({ rated: 0, win: 0, user_delta: -5 }) && !isRefund({ rated: 0, win: 0, user_delta: 0 }));
  console.log('ok players page: refunded misses with their kept rise before; refunded solves, nothing kept, after');
}

// A later ledger refund of a player whose chain starts with a legacy refund: refund.mjs replays the legacy delta in
// place and the new miss as a solve; replay-ratings.mjs agrees.
{
  const d = new DatabaseSync(F);
  const u = userState(us(F, 1)), p = { rating: 1600, rd: 200, vol: 0.09, attempts: 0, solves: 0 };
  d.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, rd, vol) VALUES ('late', 6, 't', 3, '{}', 'test', 1600, 1600, 200, 0.09)`).run();
  const m = rate(u, p, false, 1, 1), ts = Date.UTC(2026, 10, 19);
  const ua = { rating: m.user.rating, rd: m.user.rd, vol: m.user.vol, games: u.games + 1, wins: u.wins }, pa = { ...m.puzzle, attempts: 1, solves: 0 };
  d.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts) VALUES (1, ?, 0, 1, ?, ?, ?, ?)').run('late', u.rating, p.rating, m.userDelta, ts);
  const { lastInsertRowid: aid } = d.prepare(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, guest, "commit", mode, opened, closed, state, result, rated, weight) VALUES ('n-late', 1, 'late', 1, 0, '', 'legacy', ?, ?, 'closed', 0, 1, 1)`).run(ts, ts);
  d.prepare(`INSERT INTO rating_event (attempt_id, kind, ts, by, weight, user_before, user_after, puzzle_before, puzzle_after, note) VALUES (?, 'rate', ?, 'api/result', 1, ?, ?, ?, ?, '{"pw":1}')`)
    .run(aid, ts, JSON.stringify(u), JSON.stringify(ua), JSON.stringify(p), JSON.stringify(pa));
  d.prepare('UPDATE users SET rating = ?, rd = ?, vol = ?, games = ? WHERE id = 1').run(ua.rating, ua.rd, ua.vol, ua.games);
  d.prepare("UPDATE puzzles SET rating = ?, rd = ?, vol = ?, attempts = 1 WHERE id = 'late'").run(pa.rating, pa.rd, pa.vol);
  d.close();
  const rr = node('scripts/refund.mjs', '--db', F, '--attempt', String(aid), '--apply');
  assert.equal(rr.status, 0, rr.stdout + rr.stderr);
  const s = rate(u, p, true, 1, 1), want = { rating: s.user.rating, rd: s.user.rd, vol: s.user.vol, games: u.games + 1, wins: u.wins + 1 };
  for (const k of Object.keys(want)) near(us(F, 1)[k], want[k], 'ann after the ledger refund: ' + k);
  const x = node('scripts/replay-ratings.mjs', '--db', F); assert.equal(x.status, 0, x.stdout + x.stderr); assert.match(x.stdout, /0 gaps, 0 mismatches/);
  console.log('ok ledger after legacy: refund.mjs replays the legacy delta and counts the new miss as a solve; replay-ratings agrees');
}

// Review findings (2026-11-20), each on a small world of its own: a one-puzzle database, the recorded path played through
// rate() as in play(), and the truth (the refunded miss a solve) played alongside.
let smallN = 0;
function small(name, seq, { init = 1900, back = -1, guestRow = null } = {}) {
  const F = empty(++smallN + '-' + name), d = new DatabaseSync(F);
  const U = d.prepare('INSERT INTO users (id, name, token_hash, gid, rating, rd, vol, games, wins, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const A = d.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts) VALUES (?,?,?,?,?,?,?,?)');
  let p = START(init), t = START(init); const out = { rows: [] };
  seq.forEach((x, i) => {
    const u = { rating: x.r, rd: x.rd, vol: 0.06 }, m = rate(u, p, !!x.win), tr = rate(u, t, !!x.win || !!x.ref);
    if (x.ref) out.solve = rate(u, p, true);
    U.run(x.id, 'u' + x.id, 'h' + x.id, null, x.r + (x.ref ? 0 : m.userDelta), x.rd, 0.06, 5, 2, T - 30 * DAY);
    A.run(x.id, 'q', x.win ? 1 : 0, x.ref ? 0 : 1, x.r, p.rating, m.userDelta, T + i * 1e3);
    // a player's earlier results (Elo era), so the newcomer replay sees an established player (x.fresh: none, a
    // newcomer), as many as make the player-side replay start them at about their rd (rdFromCount(n, 250))
    if (!x.fresh) for (let k = 0, n = Math.max(4, Math.round(4 * ((250 / x.rd) ** 2 - 1))); k < n; k++) A.run(x.id, 'e' + x.id, k % 2, 1, x.r, x.r, 0, T - 20 * DAY + k);
    t = tr.puzzle; p = i === back ? { ...m.puzzle, rating: p.rating } : m.puzzle; // back: the rise taken back by hand at once
    if (guestRow && i === guestRow.after) { // a guest's row from before its account, replayed by the server: never moved the puzzle
      U.run(90, null, 'h90', 'g'.repeat(32), guestRow.r, 150, 0.06, 1, guestRow.win, T + 3600e3);
      A.run(90, 'q', guestRow.win, 1, guestRow.r, p.rating, guestRow.win ? 9 : -9, T + i * 1e3 + 500);
    }
  });
  d.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, rd, vol, attempts, solves) VALUES ('q', 6, 't', 3, '{}', 'test', ?, ?, ?, ?, ?, ?)`)
    .run(init, p.rating, p.rd, p.vol, seq.length, seq.filter((x) => x.win).length);
  d.close();
  return { F, ...out, today: p.rating, truth: t.rating };
}
{
  // (1) A guest's row from before its account sits after the refunded miss. It never moved the puzzle, so the truth is
  // exactly the start plus amy's solve move; the splice used to replay it as a result (+29 here).
  for (const [gr, gw] of [[2600, 1], [1800, 0]]) {
    const w = small('gpre.db', [{ id: 1, r: 2700, rd: 80, ref: 1 }], { init: 2500, guestRow: { after: 0, r: gr, win: gw } });
    const o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stderr);
    near(pz(w.F, 'q').rating, 2500 + w.solve.puzzleDelta, 'pre-account guest row: no move', 1e-6);
    assert.deepEqual([pz(w.F, 'q').attempts, pz(w.F, 'q').solves], [1, 1], 'nor counted');
  }
  // (2) A rise taken back by hand, with an earlier result and three later ones that narrowed the puzzle's deviation.
  // The solve step now starts from the deviation carried forward from the earlier result (~207), not today's (~141):
  // within 2 points of this world's truth, where it used to lose half of the −64 correction.
  {
    const seq = [{ id: 1, r: 1800, rd: 70 }, { id: 2, r: 1900, rd: 100, ref: 1 }, { id: 10, r: 1850, rd: 70 }, { id: 11, r: 1880, rd: 70, win: 1 }, { id: 12, r: 1910, rd: 70 }];
    const w = small('back.db', seq, { back: 1 });
    const o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stderr); assert.match(o.stdout, /its rise was taken back by hand/);
    near(pz(w.F, 'q').rating, w.truth, 'taken back, later results', 2);
    assert.ok(w.today - w.truth > 50, 'a correction worth checking: ' + (w.today - w.truth));
  }
  // (3) A newcomer (no rated result before: rd ≥ 230 by the replay) refunded on a puzzle with an earlier result and
  // later ones. rate() moves no puzzle for him, so the truth is the recorded path unchanged; his solve is the truth's.
  for (const [r, rd] of [[1500, 231], [2300, 236]]) {
    const seq = [{ id: 1, r: 1800, rd: 70 }, { id: 2, r, rd, ref: 1, fresh: 1 }, { id: 3, r: 1700, rd: 70 }, { id: 4, r: 2100, rd: 70, win: 1 }, { id: 5, r: 1750, rd: 70 }, { id: 6, r: 1850, rd: 70 }];
    const w = small('nwb2.db', seq), o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stderr);
    assert.match(o.stdout, /a newcomer: no move/); near(pz(w.F, 'q').rating, w.today, 'a newcomer moves nothing', 1e-9);
    near(J(read(w.F, "SELECT note FROM rating_event WHERE kind = 'refund'")[0].note).solve, w.solve.userDelta, 'the newcomer\'s solve', 0.05);
    historyIsApplied(w.F);
  }
  // An established player is never taken for a newcomer (the replay's "not a newcomer" is kept): at rd 150 he moves it.
  {
    const w = small('est.db', [{ id: 1, r: 1800, rd: 70 }, { id: 2, r: 2000, rd: 150, ref: 1 }, { id: 3, r: 1700, rd: 70 }]);
    const o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stderr); assert.doesNotMatch(o.stdout, /a newcomer: no move/);
    near(pz(w.F, 'q').rating, w.truth, 'established player', 2);
  }
  console.log('ok review fixes: a pre-account guest row moves nothing; a taken-back rise rated with the carried deviation (within 2 of truth); newcomers by replay move nothing, solves exact');
}

// The deploy check: without attempts.refund (the server reading this database predates the change, so its REFUND_MARK
// would lose the marks after an --apply) --apply refuses; the dry run says so and still runs.
{
  const G = world('undeployed.db'); { const d = new DatabaseSync(G); d.exec('ALTER TABLE attempts DROP COLUMN refund'); d.close(); }
  const b = snap(G);
  let o = legacy(G, '--expect', String(N), '--apply'); assert.equal(o.status, 3); assert.match(o.stderr, /Deploy and restart/); assert.deepEqual(snap(G), b);
  o = legacy(G, '--expect', String(N)); assert.equal(o.status, 0, o.stderr); assert.match(o.stdout, /--apply will refuse until it is deployed/); assert.deepEqual(snap(G), b);
  o = legacy(G, '--expect', String(N), '--apply', '--no-deploy-check'); assert.equal(o.status, 0, o.stderr); assert.equal(marked(G).length, PUZZLES.length);
  console.log('ok deploy check: --apply refuses on a database the new server has not opened; the dry run warns');
}

// A miss refunded by the older refund.mjs (ledger, before 2026-11-20: left out of the chain, attempts row rated = 0)
// carries the legacy signature too. refund-legacy-wins.mjs leaves it out (it used to refuse the whole run over it);
// refund.mjs counts it as a solve: the player as if solved, the puzzle given the solve's move and the attempt back.
{
  const G = world('older.db'), d = new DatabaseSync(G), ts = T + 20e3;
  const u0 = { rating: 1600, rd: 100, vol: 0.06, games: 0, wins: 0 }, p0 = { rating: 1600, rd: 200, vol: 0.09, attempts: 0, solves: 0 };
  const m = rate(u0, p0, false), ua = ratedUser(u0, m, false), pa = ratedPuzzle(p0, m, false);
  d.prepare("INSERT INTO users (id, name, token_hash, rating, rd, vol, games, wins, created_at) VALUES (20, 'olu', 'h20', 1600, 100, 0.06, 0, 0, ?)").run(T - DAY);
  d.prepare("INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, rd, vol, attempts, solves) VALUES ('old', 6, 't', 3, '{}', 'test', 1600, ?, ?, ?, 0, 0)").run(1600, pa.rd, pa.vol);
  d.prepare("INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts) VALUES (20, 'old', 0, 0, 1600, 1600, ?, ?)").run(m.userDelta, ts);
  const { lastInsertRowid: aid } = d.prepare(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, guest, "commit", mode, opened, closed, state, result, rated, weight) VALUES ('n-old', 20, 'old', 1, 0, '', 'legacy', ?, ?, 'closed', 0, 1, 1)`).run(ts, ts);
  const ev = (kind, ub, uaf, pb, paf, note) => d.prepare(`INSERT INTO rating_event (attempt_id, kind, ts, by, weight, user_before, user_after, puzzle_before, puzzle_after, note) VALUES (?, ?, ?, 'x', 1, ?, ?, ?, ?, ?)`)
    .run(aid, kind, ts, JSON.stringify(ub), JSON.stringify(uaf), JSON.stringify(pb), JSON.stringify(paf), note);
  ev('rate', u0, ua, p0, pa, '{"pw":1}');
  const rateEv = { puzzle_before: JSON.stringify(p0), puzzle_after: JSON.stringify(pa) }, pc = compensate(pa, rateEv);
  ev('refund', ua, u0, pa, pc, JSON.stringify({ why: null, skipped: [Number(aid)] }));
  d.close();
  let o = legacy(G, '--expect', String(N)); assert.equal(o.status, 0, o.stderr); assert.match(o.stdout, /1 older ledger refund left to scripts\/refund\.mjs/);
  assert.doesNotMatch(o.stdout, /player #20/);
  o = node('scripts/refund.mjs', '--db', G, '--attempt', String(aid), '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr); assert.match(o.stdout, /older way/);
  const s = rate(u0, p0, true, 1, 1);
  for (const [k, v] of Object.entries(ratedUser(u0, s, true))) near(us(G, 20)[k], v, 'olu as if solved: ' + k);
  const q = pz(G, 'old'); near(q.rating, 1600 + s.puzzleDelta, 'the puzzle: the start plus the solve move'); assert.deepEqual([q.attempts, q.solves, q.rd], [1, 1, pa.rd]);
  const row = read(G, "SELECT * FROM attempts WHERE puzzle_id = 'old'")[0]; assert.deepEqual([row.win, row.rated, row.refund], [1, 1, 1]);
  o = node('scripts/replay-ratings.mjs', '--db', G); assert.equal(o.status, 0, o.stdout + o.stderr); assert.match(o.stdout, /0 gaps, 0 mismatches/);
  o = node('scripts/refund.mjs', '--db', G, '--attempt', String(aid)); assert.equal(o.status, 3, 'a second refund is refused');
  o = legacy(G, '--expect', String(N), '--apply'); assert.equal(o.status, 0, o.stderr); assert.doesNotMatch(o.stdout, /player #20/);
  console.log('ok older ledger refund: left out of the legacy run, upgraded to a solve by refund.mjs; replay agrees');
}

// The player side (2026-11-20 dry run on crux: a first-ever result refunded for a player now settled 159 games later
// came out +1097, the at-the-time solve added to today's rating). Each world here is one player's whole history played
// through rate() from the server's start, every result on a puzzle of its own (so its recorded step pins the puzzle's
// deviation), then the refunded misses taken back by hand as on 2026-11-10..16: rated = 0, their cost given back to the
// rating at a later row (or after the last), a game fewer. truth: the same results played with those misses as solves
// and nothing given back; the correction should be truth − today.
// games: [{pr, win, ref, prd} | (state, i) => {...}]; gb: {refIndex: rowIndex the give-back lands before (n: after the last)}.
// into, uid: another player (uid) added to an existing world's database.
function hist(name, games, { guest = false, start = { rating: 1500, rd: 500, vol: 0.06 }, gb = {}, edit = null, into = null, uid = 40 } = {}) {
  const F = into ?? empty(++smallN + '-' + name), d = new DatabaseSync(F), pid = (i) => (uid === 40 ? 'h' + i : `h${uid}-${i}`);
  const A = d.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts) VALUES (?,?,?,?,?,?,?,?)');
  const P = d.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, rd, vol, attempts, solves) VALUES (?, 6, 't', 3, '{}', 'test', ?, ?, ?, ?, ?, ?)`);
  let real = { ...start }, cf = { ...start }, g = 0, w = 0, n = games.length;
  const refs = [], miss = new Map(), back = (i) => { for (const [j, at] of Object.entries(gb).concat(refs.filter((j) => !(j in gb)).map((j) => [j, j + 1]))) if (+at === i && miss.has(+j)) real.rating -= miss.get(+j); };
  const solveThen = [];
  for (let i = 0; i < n; i++) {
    back(i);
    const x = typeof games[i] === 'function' ? games[i](real, i) : games[i], p = { rating: x.pr, rd: x.prd ?? (real.rd >= 230 ? 250 : 150), vol: 0.09 };
    const r = rate(real, p, !!x.win, x.wt ?? 1, guest ? 0.5 : 1); // x.wt: a themed result's weight (0.7 a miss)
    if (x.ref) { refs.push(i); miss.set(i, r.userDelta); solveThen.push(rate(real, p, true).userDelta); }
    A.run(uid, pid(i), x.ref ? 0 : x.win ? 1 : 0, x.ref ? 0 : 1, real.rating, p.rating, r.userDelta, T + i * 60e3);
    P.run(pid(i), x.pr, r.puzzle.rating, r.puzzle.rd, r.puzzle.vol, 1, x.win ? 1 : 0);
    real = { ...r.user }; if (!x.ref) { g++; w += x.win ? 1 : 0; }
    cf = rate(cf, p, !!x.win || !!x.ref, 1).user;
  }
  back(n);
  d.prepare('INSERT INTO users (id, name, token_hash, gid, rating, rd, vol, games, wins, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(uid, guest ? null : uid === 40 ? 'pat' : 'pat' + uid, 'h' + uid, guest ? 'g'.repeat(32) : null, real.rating, real.rd, real.vol, g, w, T - DAY);
  edit?.(d);
  d.close();
  return { F, today: real, truth: cf, refs, solveThen, uid };
}
// A player of strength S: puzzles around their current rating (−200, 0, +200), solved when below S ± a fixed wobble.
const vs = (S) => (u, i) => { const pr = u.rating + [-200, 0, 200][i % 3]; return { pr, win: pr < S + ((i * 37) % 200) - 100 }; };
const events = (F) => read(F, "SELECT e.* FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.user_id = 40 ORDER BY e.id");
{
  // (1) The crux case: the first result ever is the refunded miss (1500 ± 500 against a puzzle 824 above), then 150
  // results that settle the player near 2950. At the time a solve was worth ~+985; today it is worth what one result is
  // worth to a settled player, and the replay says so (it must match this world's truth).
  const w = hist('first.db', [{ pr: 2324, ref: 1, prd: 250 }, ...Array.from({ length: 150 }, () => vs(2950))], { gb: { 0: 4 } });
  assert.ok(w.today.rd < 75 && w.today.rating > 2850, 'settled: ' + JSON.stringify(w.today));
  assert.ok(w.solveThen[0] > 900, 'a solve then: ' + w.solveThen[0]);
  const o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr); assert.doesNotMatch(o.stdout, /DRIFT|allow-drift/);
  const got = us(w.F, 40).rating - w.today.rating;
  near(us(w.F, 40).rating, w.truth.rating, 'first-ever refund: the truth', 0.5); assert.ok(Math.abs(got) < 30, 'small: ' + got);
  near(us(w.F, 40).rd, w.truth.rd, 'rd', 0.05); assert.deepEqual([us(w.F, 40).games, us(w.F, 40).wins], [151, read(w.F, 'SELECT SUM(win) s FROM attempts WHERE user_id = 40')[0].s]);
  assert.match(o.stdout, /player #40: 151 rated rows replayed from rd 500\.0, vol 0\.06; as played it ends at [\d.]+ \(today [\d.]+: [+-]0\.0\)/);
  console.log(`ok first-ever result refunded, 150 results since: ${sg(got)} (truth ${sg(w.truth.rating - w.today.rating)}; a solve then was ${sg(w.solveThen[0])})`);
}
{
  // (2) A settled player, refunded mid-week, given back at once, three results after: close to the old rule (the solve
  // then added to today's rating), and to the truth.
  const games = [...Array.from({ length: 80 }, () => vs(2200)), (u) => ({ pr: u.rating + 120, ref: 1 }), ...Array.from({ length: 3 }, () => vs(2200))];
  const w = hist('settled.db', games), o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr); assert.doesNotMatch(o.stdout, /DRIFT/);
  const got = us(w.F, 40).rating - w.today.rating;
  near(got, w.solveThen[0], 'settled: as the old rule', 1.5); near(us(w.F, 40).rating, w.truth.rating, 'settled: the truth', 0.5);
  console.log(`ok settled: ${sg(got)} (a solve then ${sg(w.solveThen[0])}, truth ${sg(w.truth.rating - w.today.rating)})`);
}
{
  // (3) A guest with 13 games: the 4th, a miss against a puzzle 150 above, refunded; nine results after.
  const games = Array.from({ length: 13 }, (_, i) => (i === 3 ? (u) => ({ pr: u.rating + 150, ref: 1 }) : vs(1800)));
  const w = hist('guest13.db', games, { guest: true }), cost = read(w.F, 'SELECT user_delta d FROM attempts WHERE rated = 0')[0].d, o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr); assert.doesNotMatch(o.stdout, /DRIFT/);
  const got = us(w.F, 40).rating - w.today.rating;
  near(us(w.F, 40).rating, w.truth.rating, 'guest: the truth', 0.5); assert.ok(got > 0 && got < w.solveThen[0], `less than the solve then: ${got} vs ${w.solveThen[0]}`);
  // The same guest's rows all from before its account (replayed at sign-up): the refunded row never moved its puzzle, and
  // the line says so (it used to read "solve step from undefined").
  const v = hist('guestpre.db', games, { guest: true, edit: (d) => d.exec(`UPDATE users SET created_at = ${T + 3600e3} WHERE id = 40`) }), ov = legacy(v.F, '--expect', '1');
  assert.equal(ov.status, 0, ov.stderr); assert.match(ov.stdout, /solve step from nothing: a guest's row from before its account/); assert.doesNotMatch(ov.stdout, /undefined/);
  console.log(`ok guest, 13 games: ${sg(got)} (a solve then ${sg(w.solveThen[0])}, the miss cost ${r1x(cost)}, truth ${sg(w.truth.rating - w.today.rating)})`);
}
{
  // (4) A history that began with a +970 solve, then five refunds early on against puzzles far above (cheap misses,
  // dear solves), then 100 results.
  const games = [{ pr: 2300, win: 1, prd: 250 }, vs(2500), vs(2500), ...Array.from({ length: 5 }, () => (u) => ({ pr: u.rating + 450, ref: 1 })), ...Array.from({ length: 100 }, () => vs(2500))];
  const w = hist('five.db', games, { gb: { 3: 10, 4: 10, 5: 10, 6: 10, 7: 10 } });
  const first = read(w.F, 'SELECT user_rating r, user_delta d FROM attempts WHERE user_id = 40 ORDER BY ts LIMIT 1')[0];
  assert.ok(first.r === 1500 && first.d > 950, 'first row: +' + first.d);
  const o = legacy(w.F, '--expect', '5', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr); assert.doesNotMatch(o.stdout, /DRIFT/);
  assert.match(o.stdout, /give-backs found 5\/5/);
  const ev = events(w.F), got = us(w.F, 40).rating - w.today.rating;
  assert.equal(ev.length, 5); near(us(w.F, 40).rating, w.truth.rating, 'five early refunds: the truth', 1);
  ev.forEach((e, i) => assert.ok(J(e.note).step < w.solveThen[i], `refund ${i}: ${J(e.note).step} vs a solve then ${w.solveThen[i]}`));
  // one decision per player: the earlier events change the counts only, the last carries the whole correction
  assert.deepEqual(ev.slice(0, -1).map((e) => J(e.note).delta.rating), [0, 0, 0, 0]); near(J(ev[4].note).delta.rating, got, 'the last event: the whole correction');
  assert.ok(ev.every((e) => J(e.note).rating === 'raised')); near(ev.reduce((s2, e) => s2 + J(e.note).step, 0), got, 'the steps sum to it');
  console.log(`ok five early refunds after a ${sg(first.d)} start: ${ev.map((e) => sg(J(e.note).step)).join(' ')} (solves then ${w.solveThen.map(sg).join(' ')}; truth in all ${sg(w.truth.rating - w.today.rating)})`);
}
{
  // (5) Drift: the same settled history, but today's rd is 150 (set outside the results). Its correction is positive,
  // but the replay doesn't reproduce the record, so the player is left unchanged (never a guess) and the run goes ahead.
  const games = [...Array.from({ length: 60 }, () => vs(2200)), (u) => ({ pr: u.rating, ref: 1 })];
  const w = hist('drift.db', games, { edit: (d) => d.exec('UPDATE users SET rd = 150 WHERE id = 40') }), b = snap(w.F);
  let o = legacy(w.F, '--expect', '1'); assert.equal(o.status, 0); assert.match(o.stdout, /player #40: .*DRIFT: today's rd off by -8\d\.\d/);
  assert.match(o.stdout, /correction \+\d+\.\d .*; left unchanged: the replay does not reproduce the record \(today's rd off by -8\d\.\d\), so no change is made \(computed \+\d+\.\d\)$/m);
  assert.deepEqual(snap(w.F), b);
  o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr);
  const u0 = b.users.find((x) => x.id === 40), u = us(w.F, 40);
  assert.deepEqual([u.rating, u.rd, u.vol, u.games, u.wins], [u0.rating, u0.rd, u0.vol, u0.games + 1, u0.wins + 1]);
  console.log('ok drift: a positive correction from a replay that does not reproduce the record is not applied; the solve is counted');
}
{
  // (6) Give-backs. The hand refund gave the miss's cost back by hand somewhere after it; the replay finds it among the
  // changes between rows that no result explains. Not found (here: never given back): counting the refund would credit
  // the cost twice, so for a player who would be raised the script refuses, dry run included, naming the attempts row.
  const games = [...Array.from({ length: 60 }, () => vs(2200)), (u) => ({ pr: u.rating, ref: 1 })];
  const w = hist('nogb.db', games, { gb: { 60: 99 } });
  const row = read(w.F, 'SELECT rowid FROM attempts WHERE rated = 0')[0].rowid, b = snap(w.F);
  for (const extra of [[], ['--apply']]) {
    const o = legacy(w.F, '--expect', '1', ...extra); assert.equal(o.status, 3, o.stdout);
    assert.match(o.stderr, new RegExp(`no give-back found for attempts row ${row} \\(player #40\\)`));
  }
  assert.deepEqual(snap(w.F), b);
  // Given back rounded to whole points (0.4 more than the cost): found (within 0.51); the 0.4 stays a hand edit, kept.
  const v = hist('gbround.db', games, { edit: (d) => d.exec('UPDATE users SET rating = rating + 0.4 WHERE id = 40') });
  const o = legacy(v.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr); assert.match(o.stdout, /give-backs found 1\/1/);
  near(us(v.F, 40).rating, v.truth.rating + 0.4, 'rounded give-back: the truth plus the 0.4 edit', 0.05);
  console.log('ok give-backs: one not found is refused in every mode, naming the row; one rounded to whole points is found');
}
{
  // (6b) Review finding 2: a settled player (2000 ± 70) whose only attempts row is the refunded miss (their earlier rows
  // missing). The replay starts them as a newcomer and would credit ~+120 where a solve then was ~+13. It drifts, so it
  // is not applied: rating, rd and vol stay exactly as they are (the old --allow-drift raised them within a swing bound).
  const w = hist('onlysettled.db', [(u) => ({ pr: u.rating + 100, ref: 1 })], { start: { rating: 2000, rd: 70, vol: 0.06 } });
  const row = read(w.F, 'SELECT rowid FROM attempts WHERE rated = 0')[0].rowid, b = snap(w.F);
  let o = legacy(w.F, '--expect', '1'); assert.equal(o.status, 0, o.stderr);
  assert.match(o.stdout, /player #40: .*correction \+1\d\d\.\d .*DRIFT: .*; left unchanged: the replay does not reproduce the record/);
  assert.match(o.stdout, new RegExp(`attempt ${row} .*applied: player 2000\\.0 -> 2000\\.0 \\(\\+0\\.0, rd ([\\d.]+) -> \\1, wins 0 -> 1: left unchanged: `));
  assert.deepEqual(snap(w.F), b);
  o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.deepEqual([us(w.F, 40).rating, us(w.F, 40).rd, us(w.F, 40).vol], [w.today.rating, w.today.rd, w.today.vol]);
  console.log(`ok drifting +1xx not applied: rating, rd and vol as they were (a solve then was ${sg(w.solveThen[0])})`);
}
{
  // (8) The first-ever result refunded, then 10, 20, 40 or 80 results (review finding 1: the old bound, one result's
  // swing at today's rd, refused these though they were right). Each must apply without --allow-drift and match the truth.
  for (const N of [10, 20, 40, 80]) {
    const w = hist(`first${N}.db`, [{ pr: 2324, ref: 1, prd: 250 }, ...Array.from({ length: N }, () => vs(2950))], { gb: { 0: 4 } });
    const o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr); assert.doesNotMatch(o.stdout, /DRIFT|OUT OF BOUND/);
    near(us(w.F, 40).rating, w.truth.rating, `first-ever, ${N} after: the truth`, 0.5); near(us(w.F, 40).rd, w.truth.rd, `first-ever, ${N} after: rd`, 0.05);
    const swing = rate(w.today, { rating: 2324, rd: 250, vol: 0.09 }, true).userDelta - rate(w.today, { rating: 2324, rd: 250, vol: 0.09 }, false).userDelta;
    console.log(`ok first-ever refund, ${N} results after: ${sg(us(w.F, 40).rating - w.today.rating)} = truth (one result's swing today: ±${r1x(swing)})`);
  }
}
{
  // (9) Puzzle deviations a newcomer's row can't fit (review finding 3: rate() moves no puzzle for them). A guest's first
  // three results are on puzzles with 40 Elo-era rows each (other players), converted at rdFromCount(40, 250) = 75.4 by
  // server.js; nothing played them since: the deviation is the conversion's, not a fit of Elo steps through rate().
  // Then the same with a later result by someone else on the first puzzle (and no Elo rows): its fitted deviation is the
  // one the newcomer met (their row left the puzzle as it was), not the 250 a puzzle with no earlier rows is carried at.
  const conv = 250 / Math.sqrt(1 + 40 / 4), games = Array.from({ length: 13 }, (_, i) => (i === 0 ? { pr: 2000, ref: 1, prd: conv } : i < 3 ? { pr: 1700 + 100 * i, win: i % 2, prd: conv } : vs(1900)));
  const elo = (d) => {
    const A = d.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts) VALUES (?,?,?,?,?,?,?,?)');
    d.prepare("INSERT INTO users (id, name, token_hash, rating, rd, vol, games, wins, created_at) VALUES (500, 'old', 'h500', 1600, 80, 0.09, 120, 60, ?)").run(ELO_T - 90 * DAY);
    for (const id of ['h0', 'h1', 'h2']) { const r = d.prepare('SELECT puzzle_rating r FROM attempts WHERE puzzle_id = ?').get(id).r; for (let k = 0; k < 40; k++) A.run(500, id, k % 2, 1, 1600, r + (k % 2 ? 8 : -8), k % 2 ? -8 : 8, ELO_T - (40 - k) * 3600e3); d.prepare("UPDATE puzzles SET attempts = attempts + 40, solves = solves + 20 WHERE id = ?").run(id); }
  };
  const w = hist('eloconv.db', games, { guest: true, edit: elo }), o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.match(o.stdout, /\d+ with an estimated puzzle deviation \(3 from an Elo conversion\)/); near(us(w.F, 40).rating, w.truth.rating, 'Elo-converted puzzles: the truth', 0.05);
  const later = (d) => { // another player (2100 ± 80) misses h0 after the newcomer, at the deviation the newcomer met
    const p = { rating: d.prepare("SELECT rating FROM puzzles WHERE id = 'h0'").get().rating, rd: 80, vol: 0.09 }, m = rate({ rating: 2100, rd: 80, vol: 0.06 }, p, false);
    d.prepare("INSERT INTO users (id, name, token_hash, rating, rd, vol, games, wins, created_at) VALUES (501, 'nat', 'h501', ?, ?, 0.06, 50, 25, ?)").run(m.user.rating, m.user.rd, T - DAY);
    d.prepare("INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts) VALUES (501, 'h0', 0, 1, 2100, ?, ?, ?)").run(p.rating, m.userDelta, T + 90 * 60e3);
    d.prepare("UPDATE puzzles SET rating = ?, rd = ?, vol = ?, attempts = 2 WHERE id = 'h0'").run(m.puzzle.rating, m.puzzle.rd, m.puzzle.vol);
  };
  const v = hist('lookahead.db', games.map((g, i) => (i === 0 ? { ...g, prd: 80 } : i < 3 ? { ...g, prd: 250 } : g)), { guest: true, edit: later }), ov = legacy(v.F, '--expect', '1', '--apply'); assert.equal(ov.status, 0, ov.stdout + ov.stderr);
  assert.match(ov.stdout, /1 newcomer rows with it from the next fitted row/); near(us(v.F, 40).rating, v.truth.rating, 'a newcomer row\'s puzzle deviation from the next fitted row: the truth', 0.05);
  console.log(`ok puzzle deviations a newcomer can't fit: Elo-converted ${sg(us(w.F, 40).rating - w.today.rating)} = truth; from the next fitted row ${sg(us(v.F, 40).rating - v.today.rating)} = truth`);
}
{
  // (10) A refund counted as a solve can lower a player (review finding 5): refunded early (rd ~300), given back only
  // after 11 more results. The solve's gain fades over those results; the give-back, applied later, fades less. The
  // truth is lower than today. Win, never lower (Sasha, 2026-11-21): the refund is counted as a solve (attempts row,
  // games and wins) and rating, rd and vol stay byte-equal; the dry run and the totals say so.
  const games = [vs(1900), (u) => ({ pr: u.rating + 150, ref: 1 }), ...Array.from({ length: 11 }, () => vs(1900))];
  const w = hist('lowered.db', games, { gb: { 1: 13 } }), o = legacy(w.F, '--expect', '1');
  assert.equal(o.status, 0, o.stdout + o.stderr);
  const t = w.truth.rating - w.today.rating;
  assert.ok(t < 0, 'this world lowers the player: ' + t);
  assert.match(o.stdout, /player #40: .*; correction -\d+\.\d .*; left unchanged: computed -\d+\.\d, never lowered$/m);
  assert.match(o.stdout, /totals: .*0 players raised, 1 left unchanged, 1 as the computed change is not above zero, never lowered \(#40 -\d+\.\d\)/);
  // one of each, said in the singular (review: "1 players", "1 attempts", "1 refunded misses")
  assert.match(o.stdout, /^dry run: 1 refunded miss as solves/m); assert.match(o.stdout, /^totals: 1 attempt counted as solves, 1 player \(.*\), 1 puzzle \(/m);
  const b = snap(w.F).users.find((x) => x.id === 40), a = legacy(w.F, '--expect', '1', '--apply'); assert.equal(a.status, 0, a.stdout + a.stderr);
  const u = us(w.F, 40); assert.deepEqual([u.rating, u.rd, u.vol, u.games, u.wins], [b.rating, b.rd, b.vol, b.games + 1, b.wins + 1]);
  const row = read(w.F, "SELECT * FROM attempts WHERE refund = 1")[0]; assert.deepEqual([row.win, row.rated, row.refund], [1, 1, 1]);
  const e = J(events(w.F)[0].note); assert.deepEqual([e.rating, e.delta], ['unchanged', { rating: 0, rd: 0, vol: 0, games: 1, wins: 1 }]); near(e.total, t, 'the computed correction, kept in the note', 0.5);
  const x = node('scripts/replay-ratings.mjs', '--db', w.F); assert.equal(x.status, 0, x.stdout + x.stderr); assert.match(x.stdout, /0 gaps, 0 mismatches/);
  console.log(`ok never lowered: computed ${sg(e.total)} (truth ${sg(t)}); counted as a solve, rating, rd and vol byte-equal, the ledger replays`);
}
{
  // (7) By hand. A settled player's last result is the refunded miss, against a puzzle at exactly their rating, and its
  // cost m (< 0) is given back after it. At equal ratings E = 1/2 whatever the deviations, so Glicko-2 moves μ by
  // φ'²·g·(s − ½) = ±φ'²g/2 (a solve is the miss's mirror: −m), and the deviation and volatility steps see only Δ² (the
  // same for s = 1 and s = 0). The replays agree up to this row, so D = 0 before it; the row adds the solve minus the
  // miss as recorded, −m − m = −2m; the give-back is in today's rating and has no place in the solve's world, so D loses
  // it: −2m + m = −m. Today's rating gains |m|, rd and vol stay (exactly, but for the replay's puzzle deviation, which
  // is fitted by bisection to the recorded puzzle step: a few millionths of a point).
  const games = [...Array.from({ length: 40 }, () => vs(2000)), (u) => ({ pr: u.rating, ref: 1 })];
  const w = hist('hand.db', games), m = read(w.F, 'SELECT user_delta d FROM attempts WHERE rated = 0')[0].d;
  // The bound: [−(the miss's cost) − 10, +(the counterfactual's solve) + 10], and here that solve is the miss's mirror,
  // |m|: [−(|m| + 10), +(|m| + 10)], printed to 0.1.
  const o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.ok(o.stdout.includes(`bound [${sg(m - 10)}, ${sg(-m + 10)}]`), 'the bound by hand: ' + o.stdout);
  const u = us(w.F, 40);
  near(u.rating, w.today.rating - m, 'today + |m|', 1e-4); near(u.rd, w.today.rd, 'rd', 1e-4); near(u.vol, w.today.vol, 'vol', 1e-9);
  assert.ok(m < -5 && m > -15, 'a settled miss: ' + m);
  console.log(`ok by hand: m = ${m.toFixed(3)} given back; counted as a solve, today's ${w.today.rating.toFixed(3)} gains exactly ${(-m).toFixed(3)}, rd and vol unchanged`);
}
{
  // (11) Win, never lower, a mixed run (Sasha, 2026-11-21): #40 settled and refunded late (raised, as computed: the
  // truth); #41 the same history with today's rd set outside the results (its replay drifts: left unchanged, named,
  // and the run still applies); #42 refunded early and given back late (computed below zero: left unchanged). All three
  // refunds become solves. Then the ledger replays clean, and a second --apply finds nothing and changes no byte.
  const settled = [...Array.from({ length: 80 }, () => vs(2200)), (u) => ({ pr: u.rating + 120, ref: 1 }), ...Array.from({ length: 3 }, () => vs(2200))];
  const w = hist('mixed.db', settled);
  const v = hist('', settled, { into: w.F, uid: 41, edit: (d) => d.exec('UPDATE users SET rd = 150 WHERE id = 41') });
  const x = hist('', [vs(1900), (u) => ({ pr: u.rating + 150, ref: 1 }), ...Array.from({ length: 11 }, () => vs(1900))], { into: w.F, uid: 42, gb: { 1: 13 } });
  const b = snap(w.F), was = (id) => b.users.find((u) => u.id === id);
  let o = legacy(w.F, '--expect', '3'); assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.match(o.stdout, /^ {2}player #40: .*; raised by \+\d+\.\d$/m);
  assert.match(o.stdout, /^ {2}player #41: .*DRIFT: today's rd off by .*; left unchanged: the replay does not reproduce the record \(today's rd off by -?\d+\.\d\), so no change is made \(computed \+\d+\.\d\)$/m);
  assert.match(o.stdout, /^ {2}player #42: .*; left unchanged: computed -\d+\.\d, never lowered$/m);
  assert.match(o.stdout, /^totals: 3 attempts counted as solves, 3 players \([+-]\d+\.\d rating computed in all, \+\d+\.\d applied\), .*; 1 player raised \(#40 \+\d+\.\d\), 2 left unchanged, 1 as the computed change is not above zero, never lowered \(#42 -\d+\.\d\), 1 as the replay can't be trusted \(#41: the replay does not reproduce the record/m);
  // per attempt: the computed step beside what is applied
  assert.match(o.stdout, /player #42: computed -\d+\.\d \(correction so far -\d+\.\d, .*\); applied: player [\d.]+ -> [\d.]+ \(\+0\.0, .*left unchanged: computed -\d+\.\d, never lowered\)/);
  assert.deepEqual(snap(w.F), b, 'a dry run writes nothing');
  o = legacy(w.F, '--expect', '3', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr); assert.match(o.stdout, /^written/m);
  near(us(w.F, 40).rating, w.truth.rating, '#40 raised: the truth', 0.5); near(us(w.F, 40).rd, w.truth.rd, '#40 rd', 0.05); assert.ok(us(w.F, 40).rating > w.today.rating);
  for (const id of [41, 42]) { const u = us(w.F, id), u0 = was(id); assert.deepEqual([u.rating, u.rd, u.vol, u.games, u.wins], [u0.rating, u0.rd, u0.vol, u0.games + 1, u0.wins + 1], '#' + id + ' unchanged, counted'); }
  for (const id of [40, 41, 42]) assert.deepEqual(read(w.F, 'SELECT win, rated, refund FROM attempts WHERE user_id = ? AND refund = 1', id).map((a) => [a.win, a.rated, a.refund]), [[1, 1, 1]]);
  const ev = (id) => J(read(w.F, "SELECT e.note FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.user_id = ? AND e.kind = 'refund'", id)[0].note);
  assert.deepEqual([40, 41, 42].map((id) => ev(id).rating), ['raised', 'unchanged', 'unchanged']);
  const shown = (id) => read(w.F, 'SELECT user_delta d FROM attempts WHERE user_id = ? AND refund = 1', id)[0].d;
  assert.equal(shown(40), us(w.F, 40).rating - was(40).rating, '#40: the History shows the raise'); assert.ok(shown(40) > 0 && shown(40) < ev(40).solve, '#40: less than the solve then');
  assert.deepEqual([shown(41), shown(42)], [0, 0], 'unchanged: the History shows 0, not the solve then');
  historyIsApplied(w.F, b);
  assert.ok(ev(41).total > 0 && ev(42).total < 0 && /does not reproduce/.test(ev(41).why) && /never lowered/.test(ev(42).why));
  let r = node('scripts/replay-ratings.mjs', '--db', w.F); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /0 gaps, 0 mismatches/);
  const bytes = fs.readFileSync(w.F), side = ['-wal', '-shm'].map((s2) => fs.existsSync(w.F + s2) && fs.readFileSync(w.F + s2));
  r = legacy(w.F, '--expect', '3', '--apply'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /nothing to do: no refunded miss left uncounted \(3 counted/);
  assert.ok(fs.readFileSync(w.F).equals(bytes), 'a second --apply leaves the file byte-identical');
  ['-wal', '-shm'].forEach((s2, i) => assert.deepEqual(fs.existsSync(w.F + s2) && fs.readFileSync(w.F + s2), side[i], s2));
  console.log(`ok never lower, mixed run: #40 ${sg(us(w.F, 40).rating - w.today.rating)} (truth ${sg(w.truth.rating - w.today.rating)}); #41 drifting and #42 computed ${sg(ev(42).total)} left unchanged, both counted; ledger 0 gaps 0 mismatches; a second --apply changes no byte`);
}
{
  // (13) Review of e026cd1: a player left unchanged for drift blocked everyone when their total was above zero and a
  // give-back was missing (the refusals were keyed on total > 0, not on "would be raised but for this"). #40 drifts
  // (today's rd set outside the results) and its give-back was never made: left unchanged, both flaws printed, no
  // refusal. #41 is clean but for a +20 hand edit after its last row: raised to the truth (+ the edit, carried), and the
  // jump is printed with where it is. Without #40's drift, its lost give-back still refuses (test 6).
  const settled = [...Array.from({ length: 80 }, () => vs(2200)), (u) => ({ pr: u.rating + 120, ref: 1 }), ...Array.from({ length: 3 }, () => vs(2200))];
  const w = hist('blockdrift.db', settled, { gb: { 80: 999 }, edit: (d) => d.exec('UPDATE users SET rd = 150 WHERE id = 40') });
  const v = hist('', settled, { into: w.F, uid: 41, edit: (d) => d.exec('UPDATE users SET rating = rating + 20 WHERE id = 41') });
  const lostRow = read(w.F, 'SELECT rowid FROM attempts WHERE user_id = 40 AND rated = 0')[0].rowid, b = snap(w.F);
  let o = legacy(w.F, '--expect', '2'); assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.match(o.stdout, new RegExp(`^ {2}player #40: .*NOT FOUND: attempts row ${lostRow}.*DRIFT: .*; left unchanged: the replay does not reproduce the record \\(today's rd off by -?\\d+\\.\\d\\); no give-back found for attempts row ${lostRow}, so no change is made \\(computed \\+\\d+\\.\\d\\)$`, 'm'));
  assert.match(o.stdout, /^ {2}player #41: .*other jumps 1 \(20\.0 in all: \+20\.0 after the last row\).*; raised by \+\d+\.\d$/m);
  assert.deepEqual(snap(w.F), b);
  o = legacy(w.F, '--expect', '2', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr);
  const u0 = b.users.find((x) => x.id === 40), u = us(w.F, 40);
  assert.deepEqual([u.rating, u.rd, u.vol, u.games, u.wins], [u0.rating, u0.rd, u0.vol, u0.games + 1, u0.wins + 1]);
  near(us(w.F, 41).rating, v.truth.rating + 20, '#41 raised: the truth plus its hand edit', 0.5);
  const x = node('scripts/replay-ratings.mjs', '--db', w.F); assert.equal(x.status, 0, x.stdout + x.stderr); assert.match(x.stdout, /0 gaps, 0 mismatches/);
  console.log(`ok a drifting player's lost give-back blocks no one: #40 left unchanged (both flaws printed), #41 ${sg(us(w.F, 41).rating - v.today.rating)} (truth ${sg(v.truth.rating - v.today.rating)} + its +20 edit, printed where it is)`);
}
{
  // (14) Review of e026cd1: a refunded miss on a themed puzzle (recorded at weight 0.7). attempts has no theme column, so
  // the counterfactual would credit a weight-1 solve (the live path credits a themed solve 0.1): a guess, and in the
  // review's worlds up to +339 over the live path's truth. The refunded row's recorded miss against the replay's
  // weight-1 miss (0.70 here, 1.00 for a plain one) marks it: the player is left unchanged, the ratio printed per row.
  const games = [...Array.from({ length: 30 }, () => vs(2200)), (u) => ({ pr: u.rating + 120, ref: 1, wt: 0.7 }), ...Array.from({ length: 3 }, () => vs(2200))];
  const w = hist('themedref.db', games), row = read(w.F, 'SELECT rowid FROM attempts WHERE rated = 0')[0].rowid, b = snap(w.F).users.find((x) => x.id === 40);
  const o = legacy(w.F, '--expect', '1', '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.match(o.stdout, new RegExp(`attempt ${row} .*the miss had cost -\\d+\\.\\d, 0\\.70 of the replay's weight-1 miss`));
  assert.match(o.stdout, new RegExp(`player #40: .*correction \\+\\d+\\.\\d .*; left unchanged: the refunded miss at attempts row ${row} cost 0\\.70 of the replay's \\(themed, or the replay is off there\\), so no change is made`));
  const u = us(w.F, 40); assert.deepEqual([u.rating, u.rd, u.vol, u.games, u.wins], [b.rating, b.rd, b.vol, b.games + 1, b.wins + 1]);
  // the same history unthemed: 1.00, raised
  const v = hist('plainref.db', games.map((g, i) => (i === 30 ? (s) => ({ pr: s.rating + 120, ref: 1 }) : g))), ov = legacy(v.F, '--expect', '1', '--apply'); assert.equal(ov.status, 0, ov.stdout + ov.stderr);
  assert.match(ov.stdout, /1\.00 of the replay's weight-1 miss/); assert.match(ov.stdout, /; raised by \+\d+\.\d$/m); near(us(v.F, 40).rating, v.truth.rating, 'plain: the truth', 0.5);
  console.log(`ok a themed refunded miss (0.70 of a full one) is not guessed at: left unchanged, counted; the same unthemed ${sg(us(v.F, 40).rating - v.today.rating)} = truth`);
}
{
  // (12) The live path (refund.mjs) never lowers either. A new player (1500 ± 500) misses a puzzle at 700, then solves
  // 1500 and 2200, then misses one at their rating. Counting the 700 miss as a solve ends ~204 lower (from the higher
  // path the two solves gain far less, the last miss costs more), so the player keeps rating, rd and vol and gains the win; the event says kept.
  // Then refunding the last miss raises them (the chain with the 700 row as played); replay-ratings agrees throughout.
  const G = empty(++smallN + '-live.db'), d = new DatabaseSync(G), uid = 60;
  let u = { rating: 1500, rd: 500, vol: 0.06, games: 0, wins: 0 }; const aids = [], states = [u];
  const plays = [{ pr: 700 }, { pr: 1500, win: 1 }, { pr: 2200, win: 1 }, { pr: null }];
  d.prepare("INSERT INTO users (id, name, token_hash, rating, rd, vol, games, wins, created_at) VALUES (?, 'liv', 'h60', 0, 0, 0, 0, 0, ?)").run(uid, T - DAY);
  plays.forEach((g, i) => {
    const id = 'L' + i, ts = Date.UTC(2026, 10, 21) + i * 60e3, p = { rating: g.pr ?? Math.round(u.rating), rd: 150, vol: 0.09, attempts: 0, solves: 0 };
    const m = rate(u, p, !!g.win), ua = ratedUser(u, m, !!g.win), pa = ratedPuzzle(p, m, !!g.win);
    d.prepare("INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, rd, vol, attempts, solves) VALUES (?, 6, 't', 3, '{}', 'test', ?, ?, ?, ?, ?, ?)").run(id, p.rating, pa.rating, pa.rd, pa.vol, pa.attempts, pa.solves);
    d.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts) VALUES (?, ?, ?, 1, ?, ?, ?, ?)').run(uid, id, g.win ? 1 : 0, u.rating, p.rating, m.userDelta, ts);
    const { lastInsertRowid: aid } = d.prepare(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, guest, "commit", mode, opened, closed, state, result, rated, weight) VALUES (?, ?, ?, 1, 0, '', 'legacy', ?, ?, 'closed', ?, 1, 1)`).run('n-live-' + i, uid, id, ts, ts, g.win ? 1 : 0);
    d.prepare(`INSERT INTO rating_event (attempt_id, kind, ts, by, weight, user_before, user_after, puzzle_before, puzzle_after, note) VALUES (?, 'rate', ?, 'api/result', 1, ?, ?, ?, ?, '{"pw":1}')`).run(aid, ts, JSON.stringify(u), JSON.stringify(ua), JSON.stringify(p), JSON.stringify(pa));
    aids.push(Number(aid)); u = ua; states.push(u);
  });
  d.prepare('UPDATE users SET rating = ?, rd = ?, vol = ?, games = ?, wins = ? WHERE id = ?').run(u.rating, u.rd, u.vol, u.games, u.wins, uid);
  d.close();
  // the computed change, by hand: the same four results with the first a solve
  let cf = states[0]; plays.forEach((g, i) => { const p = J(read(G, "SELECT e.puzzle_before FROM rating_event e WHERE e.attempt_id = ?", aids[i])[0].puzzle_before); cf = ratedUser(cf, rate(cf, p, i === 0 || !!g.win), i === 0 || !!g.win); });
  assert.ok(cf.rating - u.rating < -150, 'the solve would lower them: ' + (cf.rating - u.rating));
  const before = us(G, uid), before0L0 = read(G, "SELECT user_delta d FROM attempts WHERE puzzle_id = 'L0'")[0].d;
  let o = node('scripts/refund.mjs', '--db', G, '--attempt', String(aids[0])); assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.match(o.stdout, new RegExp(`left unchanged: computed ${sg(cf.rating - u.rating).replace('+', '\\+')}, never lowered`));
  o = node('scripts/refund.mjs', '--db', G, '--attempt', String(aids[0]), '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr);
  const a1 = us(G, uid);
  assert.deepEqual([a1.rating, a1.rd, a1.vol, a1.games, a1.wins], [before.rating, before.rd, before.vol, before.games, before.wins + 1], 'kept: rating, rd, vol byte-equal; the win counted');
  assert.deepEqual(Object.values(read(G, "SELECT win, rated, refund FROM attempts WHERE puzzle_id = 'L0'")[0]), [1, 1, 1]);
  const n1 = J(read(G, "SELECT note FROM rating_event WHERE kind = 'refund'")[0].note);
  assert.deepEqual([n1.asWin, n1.kept, n1.delta], [true, true, { rating: 0, rd: 0, vol: 0, games: 0, wins: 1 }]); near(n1.computed, cf.rating - u.rating, 'computed, in the note', 1e-6);
  // the History: refunded, counted as solved, Δ 0 (kept); the solve then and the miss as recorded in the note
  assert.equal(read(G, "SELECT user_delta d FROM attempts WHERE puzzle_id = 'L0'")[0].d, before0L0, 'kept: the History shows the miss, which stands (nothing applied)');
  near(n1.solve, rate(states[0], J(read(G, "SELECT puzzle_before FROM rating_event WHERE attempt_id = ? AND kind = 'rate'", aids[0])[0].puzzle_before), true).userDelta, 'the solve then, in the note', 1e-9);
  assert.ok(n1.solve > 0 && n1.miss === before0L0, 'the solve then above zero; the miss as recorded');
  assert.deepEqual([pz(G, 'L0').solves, pz(G, 'L0').attempts], [1, 1], 'the puzzle side as before: rated as solved');
  let x = node('scripts/replay-ratings.mjs', '--db', G); assert.equal(x.status, 0, x.stdout + x.stderr); assert.match(x.stdout, /0 gaps, 0 mismatches/);
  // the last miss: raised, from the chain with the kept refund's row as played
  o = node('scripts/refund.mjs', '--db', G, '--attempt', String(aids[3]), '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr); assert.doesNotMatch(o.stdout, /left unchanged/);
  const p3 = J(read(G, "SELECT puzzle_before FROM rating_event WHERE attempt_id = ? AND kind = 'rate'", aids[3])[0].puzzle_before), want = ratedUser(states[3], rate(states[3], p3, true), true);
  const a2 = us(G, uid); for (const k of ['rating', 'rd', 'vol']) near(a2[k], want[k], 'the last miss as a solve: ' + k); assert.deepEqual([a2.games, a2.wins], [4, 4]); assert.ok(a2.rating > a1.rating);
  const miss3 = J(read(G, "SELECT note FROM rating_event WHERE kind = 'refund' ORDER BY id DESC LIMIT 1")[0].note).miss; assert.ok(miss3 < 0);
  assert.equal(read(G, "SELECT user_delta d FROM attempts WHERE puzzle_id = 'L3'")[0].d, miss3 + (a2.rating - a1.rating), 'raised: the History shows the miss and the change applied');
  historyIsApplied(G); historyAddsUp(G, uid);
  x = node('scripts/replay-ratings.mjs', '--db', G); assert.equal(x.status, 0, x.stdout + x.stderr); assert.match(x.stdout, /0 gaps, 0 mismatches/);
  console.log(`ok live path never lowers: computed ${sg(cf.rating - u.rating)} kept (rating, rd, vol byte-equal, wins + 1); a later refund ${sg(a2.rating - a1.rating)} replays the kept row as played; replay-ratings agrees`);
}
{
  // (12b) The same through an upgrade: the 700 miss was refunded the older way (left out of the chain, its attempts row
  // rated = 0) after the two solves. Counting it as a solve now ends lower than the chain without it, so rating, rd and
  // vol stay and games and wins + 1 (the attempt comes back as a solve); the puzzle gets the solve's move as any upgrade.
  const G = empty(++smallN + '-liveup.db'), d = new DatabaseSync(G), uid = 61, ts0 = Date.UTC(2026, 10, 18);
  let u = { rating: 1500, rd: 500, vol: 0.06, games: 0, wins: 0 }; const aids = [], start = u;
  d.prepare("INSERT INTO users (id, name, token_hash, rating, rd, vol, games, wins, created_at) VALUES (?, 'lup', 'h61', 0, 0, 0, 0, 0, ?)").run(uid, T - DAY);
  const ev = (aid, kind, ts, ub, ua, pb, pa, note) => d.prepare(`INSERT INTO rating_event (attempt_id, kind, ts, by, weight, user_before, user_after, puzzle_before, puzzle_after, note) VALUES (?, ?, ?, 'x', 1, ?, ?, ?, ?, ?)`)
    .run(aid, kind, ts, JSON.stringify(ub), JSON.stringify(ua), JSON.stringify(pb), JSON.stringify(pa), note);
  const rows = [];
  [{ pr: 700 }, { pr: 1500, win: 1 }, { pr: 2200, win: 1 }].forEach((g, i) => {
    const id = 'U' + i, ts = ts0 + i * 60e3, p = { rating: g.pr, rd: 150, vol: 0.09, attempts: 0, solves: 0 }, m = rate(u, p, !!g.win), ua = ratedUser(u, m, !!g.win), pa = ratedPuzzle(p, m, !!g.win);
    d.prepare("INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, rd, vol, attempts, solves) VALUES (?, 6, 't', 3, '{}', 'test', ?, ?, ?, ?, ?, ?)").run(id, p.rating, pa.rating, pa.rd, pa.vol, pa.attempts, pa.solves);
    d.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts) VALUES (?, ?, ?, 1, ?, ?, ?, ?)').run(uid, id, g.win ? 1 : 0, u.rating, p.rating, m.userDelta, ts);
    const { lastInsertRowid: aid } = d.prepare(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, guest, "commit", mode, opened, closed, state, result, rated, weight) VALUES (?, ?, ?, 1, 0, '', 'legacy', ?, ?, 'closed', ?, 1, 1)`).run('n-up-' + i, uid, id, ts, ts, g.win ? 1 : 0);
    ev(aid, 'rate', ts, u, ua, p, pa, '{"pw":1}'); aids.push(Number(aid)); rows.push({ p, pa, m }); u = ua;
  });
  // the older refund of U0: the chain without it (start, then the two solves), the puzzle's move and attempt taken out
  let w = start; for (const i of [1, 2]) w = ratedUser(w, rate(w, rows[i].p, true), true);
  const pc = compensate(rows[0].pa, { puzzle_before: JSON.stringify(rows[0].p), puzzle_after: JSON.stringify(rows[0].pa) });
  ev(aids[0], 'refund', ts0 + 3 * 60e3, u, w, rows[0].pa, pc, JSON.stringify({ why: null, skipped: [aids[0]] }));
  d.prepare("UPDATE attempts SET rated = 0 WHERE puzzle_id = 'U0'").run();
  d.prepare('UPDATE users SET rating = ?, rd = ?, vol = ?, games = ?, wins = ? WHERE id = ?').run(w.rating, w.rd, w.vol, w.games, w.wins, uid);
  d.prepare("UPDATE puzzles SET rating = ?, attempts = ?, solves = ? WHERE id = 'U0'").run(pc.rating, pc.attempts, pc.solves);
  d.close();
  let x = node('scripts/replay-ratings.mjs', '--db', G); assert.equal(x.status, 0, x.stdout + x.stderr);
  const b = us(G, uid), o = node('scripts/refund.mjs', '--db', G, '--attempt', String(aids[0]), '--apply'); assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.match(o.stdout, /older way/); assert.match(o.stdout, /left unchanged: computed -\d+\.\d, never lowered/);
  const a = us(G, uid); assert.deepEqual([a.rating, a.rd, a.vol, a.games, a.wins], [b.rating, b.rd, b.vol, b.games + 1, b.wins + 1]);
  const n = J(read(G, "SELECT note FROM rating_event WHERE kind = 'refund' ORDER BY id DESC LIMIT 1")[0].note);
  assert.deepEqual([n.upgrade, n.kept, n.delta], [true, true, { rating: 0, rd: 0, vol: 0, games: 1, wins: 1 }]);
  assert.equal(read(G, "SELECT user_delta d FROM attempts WHERE puzzle_id = 'U0'")[0].d, 0, 'upgrade kept: the History shows 0');
  assert.deepEqual([pz(G, 'U0').attempts, pz(G, 'U0').solves], [1, 1]);
  x = node('scripts/replay-ratings.mjs', '--db', G); assert.equal(x.status, 0, x.stdout + x.stderr); assert.match(x.stdout, /0 gaps, 0 mismatches/);
  console.log(`ok live path, an older refund upgraded: computed ${sg(n.computed)} kept (rating, rd, vol byte-equal; games and wins + 1); replay-ratings agrees`);
}
fs.rmSync(dir, { recursive: true, force: true });
