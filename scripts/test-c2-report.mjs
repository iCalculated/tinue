// The C2 comparison report (scripts/c2-report.mjs) on a throwaway in-memory database, with the real shadow routes
// (server/move.js) taking the plies.   node --no-warnings scripts/test-c2-report.mjs
//   1. The page's own /api/result lands BEFORE its first shadow ply (the order C2's outbox produces for a one-move
//      solve or miss): move.js stores 'repeat'; the report joins the pair by the move log and counts it as first.
//   2. A solve and a miss (Solution shown) each yield exactly one joined (shadow, legacy) pair with matching outcomes,
//      and G1's "server rated a miss the browser did not" stays empty.
//   3. A real repeat (an earlier load's result, a different log) stays 'repeat'; two tabs on one puzzle join by timing.
//   4. A legacy row with no log joins by time only; a server rated miss with no browser rated miss is reported.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initLog } from '../server/log.js';
import { createMoveApi } from '../server/move.js';
import { compare, logFits } from './c2-report.mjs';

const TPS4 = '2,2,2,x/x4/x4/1,1,1,x 1 4'; // white to play: d1 completes the road
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, token_hash TEXT NOT NULL, rating REAL, rd REAL, vol REAL, games INTEGER, wins INTEGER, created_at INTEGER);
    CREATE TABLE puzzles (id TEXT PRIMARY KEY, size INTEGER NOT NULL, tps TEXT NOT NULL, plies INTEGER NOT NULL, tree TEXT NOT NULL, themes TEXT NOT NULL DEFAULT '',
      rating REAL NOT NULL, rd REAL NOT NULL, vol REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, solves INTEGER NOT NULL DEFAULT 0, komi REAL NOT NULL DEFAULT 0);
    CREATE TABLE attempts (user_id INTEGER NOT NULL, puzzle_id TEXT NOT NULL, win INTEGER NOT NULL, rated INTEGER NOT NULL, ts INTEGER NOT NULL, ms INTEGER, log TEXT);`);
  initLog(db);
  for (const id of ['pa', 'pb', 'pc', 'pd', 'pe', 'pf'])
    db.prepare("INSERT INTO puzzles (id, size, tps, plies, tree, rating, rd, vol, rev) VALUES (?, 4, ?, 1, '\"win\"', 1500, 80, 0.06, 0)").run(id, TPS4);
  for (let u = 1; u <= 6; u++) db.prepare("INSERT INTO users (id, name, token_hash, rating, rd, vol, games, wins, created_at) VALUES (?, ?, 'h', 1500, 200, 0.06, 3, 1, 1)").run(u, 'u' + u);
  return db;
}
let clock = 1e12;
const db = freshDb();
const api = createMoveApi(db, { mode: 'shadow', now: () => clock });
let k = 0;
const nonce = () => 'n'.repeat(16) + String(++k).padStart(6, '0');
// /api/result as server.js writes it (the attempts row; only the columns the report reads).
const legacy = (user, pz, win, rated, log, ts = clock) => db.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, ts, ms, log) VALUES (?,?,?,?,?,?,?)')
  .run(user, pz, win ? 1 : 0, rated ? 1 : 0, ts, null, log == null ? null : JSON.stringify(log));
async function shadow(user, pz, plies) {
  const nc = nonce();
  for (let i = 0; i < plies.length; i++) {
    const r = await api.post({ id: user, name: 'u' + user }, { nonce: nc, puzzleId: pz, rev: 0, ply: i, ...plies[i] }, 'c');
    assert.equal(r.status, 200);
  }
  return db.prepare('SELECT a.id, a.state, a.result, a.why, m.would_rate, m.would_why FROM attempt a JOIN move_attempt m ON m.attempt_id = a.id WHERE a.nonce = ?').get(nc);
}
const at = (r, id) => r.serverMissBrowserNot.concat(r.browserMissServerSolved).find((x) => x.attempt === id);

// 1 + 2a. A one-move solve: result first (report() goes in the move's own turn), then the shadow ply on the outbox timer.
legacy(1, 'pa', true, true, [{ m: 'd1', ms: 4210, k: 'ok' }]);
clock += 300;
const solve = await shadow(1, 'pa', [{ move: 'd1', ms: 4210, clientVerdict: 'solved' }]);
assert.equal(solve.state, 'closed'); assert.equal(solve.result, 1);
assert.equal(solve.would_why, 'repeat', 'move.js alone takes a first try whose result landed first as a repeat (the finding)');
// 2b. A miss: Solution shown (legacy log entry {k:'view'}; the shadow act's ms is a separate elapsed() call).
clock += 1000;
legacy(2, 'pb', false, true, [{ ms: 9000, k: 'view' }]);
clock += 200;
const view = await shadow(2, 'pb', [{ act: 'view', ms: 9002, clientVerdict: 'missed' }]);
assert.equal(view.result, 0); assert.equal(view.would_why, 'repeat');
let r = compare(db);
assert.equal(r.attempts, 2); assert.equal(r.decided, 2);
assert.deepEqual(r.joined, { log: 2, time: 0, none: 0 });
assert.equal(r.repeatCorrected, 2);
assert.equal(r.pairs, 2); assert.equal(r.agree, 2); assert.equal(r.disagree, 0);
assert.deepEqual(r.serverMissBrowserNot, [], 'the rated view miss is the browser\'s own rated miss');
assert.deepEqual(r.browserMissServerSolved, []);
console.log('ok result-before-ply: joined by log, first restored (move.js said repeat), solve and miss pairs agree');

// The recomputed first is what makes G1 test anything: the same miss with the browser NOT rating it (casual) is caught.
clock += 1000;
legacy(3, 'pc', false, false, [{ ms: 5000, k: 'view' }]);
clock += 200;
const casual = await shadow(3, 'pc', [{ act: 'view', ms: 5001, clientVerdict: 'missed' }]);
r = compare(db);
assert.ok(at(r, casual.id), 'server would rate a miss the browser did not: reported');
assert.equal(r.serverMissBrowserNot.length, 1);
console.log('ok G1: a server rated miss the browser left unrated is reported (it would hide as a repeat without the fix)');

// 3. A real repeat: an earlier load's result (another log, long before) -> stays a repeat, not joined.
legacy(4, 'pd', true, true, [{ m: 'd1', ms: 800, k: 'ok' }], clock - 86400e3);
clock += 1000;
const rep = await shadow(4, 'pd', [{ act: 'view', ms: 3000, clientVerdict: 'missed' }]);
r = compare(db);
assert.equal(r.joined.none, 1);
assert.equal(at(r, rep.id), undefined, 'a repeat view is unrated: not a G1 case');
// Two tabs, one puzzle: tab A's result (first) and tab B's shadow attempt (its result was a repeat: no row) never join.
assert.equal(logFits([{ m: 'd1', ms: 4210, k: 'ok' }], [{ n: 0, move: 'd1', ms: 7712 }]), false);
assert.equal(logFits([{ m: 'd1', ms: 4210, k: 'ok' }], [{ n: 0, move: 'd1', ms: 4210 }]), true);
assert.equal(logFits([{ m: 'c2', ms: 10, k: 'miss' }, { ms: 900, k: 'view' }], [{ n: 0, move: 'c2', ms: 10 }, { n: 1, act: 'hint', ms: 500 }, { n: 2, act: 'view', ms: 901 }]), true);
assert.equal(logFits([{ ms: 900, k: 'view' }, { m: 'c2', ms: 10, k: 'miss' }], [{ n: 0, move: 'c2', ms: 10 }, { n: 1, act: 'view', ms: 900 }]), false, 'order counts');
assert.equal(logFits(null, [{ n: 0, move: 'd1', ms: 1 }]), false);
// the defender's replies in a play-out's log ('po' with a trailing '!', logged by the page since 2026-11-21) are no
// plies of the player's: skipped, so a play-out's log still fits its plies
assert.equal(logFits([{ m: 'b1', ms: 10, k: 'miss' }, { m: 'a1+!', ms: 600, k: 'po' }, { m: 'c1', ms: 1200, k: 'po' }],
  [{ n: 0, move: 'b1', ms: 10 }, { n: 1, move: 'c1', ms: 1200 }]), true);
console.log('ok repeat: an earlier load stays a repeat; timings keep two tabs apart');

// 4. No log (an older client, or cleanLog refused it): joined by time, within SLACK_MS only.
clock += 1000;
legacy(5, 'pe', true, true, null);
clock += 500;
await shadow(5, 'pe', [{ move: 'd1', ms: 100, clientVerdict: 'solved' }]);
clock += 1000;
legacy(6, 'pf', true, true, null, clock - 3600e3);
await shadow(6, 'pf', [{ move: 'd1', ms: 100, clientVerdict: 'solved' }]);
r = compare(db);
assert.equal(r.joined.time, 1); assert.equal(r.joined.none, 2);
console.log('ok no log: joined by time within a minute, not an hour later');

// Read-only: the report writes nothing.
const snap = JSON.stringify(['attempt', 'attempts', 'move_attempt', 'move_req', 'ply'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
compare(db);
assert.equal(JSON.stringify(['attempt', 'attempts', 'move_attempt', 'move_req', 'ply'].map((t) => db.prepare(`SELECT * FROM ${t}`).all())), snap);
console.log('ok c2-report');
