// POST /api/move and GET /api/attempt (server/move.js, PLAN steps C1a and C1b). Throwaway databases in a temp dir
// (never data/tinue.db); a seeded generator, so every run is the same.   node --no-warnings scripts/test-move.mjs
//   1. The plan's acceptance test: 1,000 random ply streams with 30% duplicates (timing fields changed), 30% reordered,
//      some sent concurrently, a crash between receipt and judgement, and a restart mid-stream -> one attempt per nonce,
//      every ply stored once, the same plies and decisions as the streams sent once in order, timing-only retries
//      never conflict, a decided attempt never changes, every answer equals the stored one, nothing rated or minted.
//   2. A conflicting duplicate: undecided -> conflict (unrated), decided -> unchanged; both answered with the stored answer.
//   3. Malformed and oversized input; nonce identity; GET only for the owner; no user -> nothing written.
//   0. TINUE_JUDGE parsing (server/judge-mode.js, shared with server/shadow.js); veto = shadow.
//   5. Decide mode (C1b): per-nonce idempotent guest minting: lost-token retries, concurrent copies and a restart ->
//      one guest per nonce and the same token; never minted in shadow/veto; nothing rated; the token never stored.
//   6. Startup re-queue (C1b): a restart while a ply is `judging` -> resumed, or (stuck, pending) ended unrated.
//   4. The real server: TINUE_JUDGE off (default) -> the routes are inert (today's 404, no tables, today's CORS headers
//      and access-log line, no mint key); shadow over HTTP with a text/plain body; GET takes the nonce in a header;
//      decide over HTTP (one guest per nonce, the shared guest window); no token, IP or nonce in any log.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';
import { initLog } from '../server/log.js';
import { createMoveApi, moveInputs, parsePly, judgeMode, LIMITS, MAX_BODY, MAX_PLY, WINDOW, MAX_REQUEUES, MAX_TRIES, MINT_TTL } from '../server/move.js';
import { Game } from '../shared/tak.js';
import { parseJudgeMode } from '../server/judge-mode.js';
import { judgeMode as shadowJudgeMode } from '../server/shadow.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-move-'));
const t0 = performance.now();
let seed = 20261117;
const R = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pickR = (a) => a[Math.floor(R() * a.length)];

// Puzzles: 5x5 and 6x6 three-ply lines (6x6 is defended: an off-tree move is played out), a 4x4 one-ply puzzle at rev 2
// with rev 1 on record.
const PUZZLES = [
  { id: 'p5', size: 5, tps: '2,2,2,2,x/x5/x5/x5/1,1,1,1,x 1 5', tree: { a2: { r: 'b4', n: 'win' } }, rev: 0 },
  { id: 'p6', size: 6, tps: '2,2,2,2,2,x/x6/x6/x6/x6/1,1,1,1,1,x 1 6', tree: { a2: { r: 'b4', n: 'win' } }, rev: 0 },
  { id: 'p4', size: 4, tps: '2,2,2,x/x4/x4/1,1,1,x 1 4', tree: 'win', rev: 2 },
];
function freshDb(file) {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, token_hash TEXT NOT NULL, rating REAL, rd REAL, vol REAL, games INTEGER, wins INTEGER, created_at INTEGER);
    CREATE TABLE puzzles (id TEXT PRIMARY KEY, size INTEGER NOT NULL, tps TEXT NOT NULL, plies INTEGER NOT NULL, tree TEXT NOT NULL, themes TEXT NOT NULL DEFAULT '',
      rating REAL NOT NULL, rd REAL NOT NULL, vol REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, solves INTEGER NOT NULL DEFAULT 0, komi REAL NOT NULL DEFAULT 0);
    CREATE TABLE attempts (user_id INTEGER NOT NULL, puzzle_id TEXT NOT NULL, win INTEGER NOT NULL, rated INTEGER NOT NULL, ts INTEGER NOT NULL);`);
  initLog(db);
  const ins = db.prepare('INSERT INTO puzzles (id, size, tps, plies, tree, themes, rating, rd, vol, attempts, solves, rev) VALUES (?,?,?,3,?,?,1500,80,0.06,7,3,?)');
  for (const p of PUZZLES) ins.run(p.id, p.size, p.tps, JSON.stringify(p.tree), 'roadIn1,fork', p.rev);
  db.prepare("INSERT INTO puzzle_rev (id, rev, tree, komi, tps, ts) VALUES ('p4', 1, '{\"d1\":{\"r\":\"d4\",\"n\":\"win\"}}', 0, ?, 1)").run(PUZZLES[2].tps);
  for (let u = 1; u <= 40; u++) db.prepare('INSERT INTO users (id, name, token_hash, rating, rd, vol, games, wins, created_at) VALUES (?,?,?,1500,200,0.06,3,1,1)').run(u, u % 3 ? 'u' + u : null, 'h' + u);
  db.exec("INSERT INTO attempts (user_id, puzzle_id, win, rated, ts) VALUES (1, 'p5', 1, 1, 5), (2, 'p6', 0, 1, 6)"); // (named: initLog adds attempts.refund)
  db.exec(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, "commit", mode, opened, state, result, rated) VALUES ('legacy-x', 3, 'p5', 1, '', 'legacy', 1, 'closed', 1, 1);
    INSERT INTO rating_event (attempt_id, kind, ts, by, weight) VALUES (1, 'rate', 1, 'api/result', 1)`);
  return db;
}
// Everything the shadow routes must never touch, as one hash.
const untouched = (db) => crypto.createHash('sha256').update(JSON.stringify(['users', 'puzzles', 'attempts', 'rating_event', 'puzzle_rev']
  .map((t) => db.prepare(`SELECT * FROM ${t}`).all()))).update(JSON.stringify(db.prepare("SELECT * FROM attempt WHERE mode != 'shadow'").all())).digest('hex');
const userOf = (id) => ({ id, name: id % 3 ? 'u' + id : null });

// ---- 0. switch parsing; off creates nothing ----
{
  // Exact values only, trimmed, any case; unknown -> off with one warning per process (server/judge-mode.js).
  const warned = [];
  const jm = (v) => judgeMode(v, (m) => warned.push(m));
  for (const [v, m] of [[undefined, 'off'], ['', 'off'], ['  ', 'off'], ['off', 'off'], ['shadow', 'shadow'], [' shadow', 'shadow'],
    ['Shadow', 'shadow'], ['SHADOW\n', 'shadow'], ['veto', 'veto'], ['Decide ', 'decide']]) assert.equal(jm(v), m, JSON.stringify(v));
  assert.deepEqual(warned, []);
  for (const v of ['on', '1', 'true', 'shadwo', 'decide-now']) assert.equal(jm(v), 'off', v);
  assert.equal(warned.length, 1, 'one warning per process'); assert.match(warned[0], /TINUE_JUDGE="on".*stays off/);
  assert.deepEqual(parseJudgeMode('yes'), { mode: 'off', unknown: true });
  // shadow.js reads the same parser.
  assert.equal(shadowJudgeMode, judgeMode);
  // veto runs these routes exactly as shadow (S5 not built); an unknown mode passed in is off.
  assert.equal(createMoveApi(freshDb(':memory:'), { mode: 'veto' }).routes.size, 2);
  assert.equal(createMoveApi(freshDb(':memory:'), { mode: 'bogus' }).routes.size, 0);
  const db = freshDb(':memory:');
  const before = db.prepare('SELECT name FROM sqlite_master ORDER BY name').all().map((r) => r.name);
  const api = createMoveApi(db, { mode: 'off' });
  assert.equal(api.routes.size, 0);
  assert.equal(await api.handle({}, {}, { route: 'POST /api/move' }), false);
  assert.deepEqual(db.prepare('SELECT name FROM sqlite_master ORDER BY name').all().map((r) => r.name), before);
  console.log('ok switch: exact values, trimmed, any case; unset/unknown -> off (one warning); veto = shadow; off adds no route and no table');
}

// ---- 1. acceptance: 1,000 random streams ----
// A stream is what one page load would send: moves from a small pool (the tree's keys and replies, the winning
// moves, a few other legal moves) and acts, numbered 0..L-1.
function makeStream(i) {
  const p = pickR(PUZZLES), g = Game.fromTPS(p.tps, 0);
  const legal = g.legalMoves().map((m) => g.moveToPTN(m));
  const pool = ['a2', 'a2', 'e1', 'f1', 'd1', 'b4', 'Ce1', pickR(legal), pickR(legal), pickR(legal)].filter((m) => { const q = /([a-h])([1-8])/.exec(m); return q[1].charCodeAt(0) - 97 < p.size && +q[2] <= p.size; });
  const L = 1 + Math.floor(R() * 9), plies = [];
  for (let n = 0; n < L; n++) {
    const r = R();
    plies.push(r < 0.8 ? { move: pickR(pool) } : { act: pickR(['hint', 'hint', 'view', 'giveup', 'leave', 'unload']) });
  }
  const rv = R(), rev = p.id === 'p4' ? (rv < 0.4 ? 2 : rv < 0.7 ? 1 : rv < 0.85 ? undefined : 9) : rv < 0.2 ? undefined : 0;
  const nonce = crypto.createHash('sha256').update('n' + i + ':' + seed).digest('base64url').slice(0, 22);
  return { nonce, user: userOf(1 + (i % 40)), puzzleId: p.id, rev, plies };
}
const bodyOf = (s, n, timing) => ({ puzzleId: s.puzzleId, ...(s.rev === undefined ? {} : { rev: s.rev }), nonce: s.nonce, ply: n, ...s.plies[n],
  ms: timing.ms, ...(timing.seen != null ? { seen: timing.seen } : {}), ...(timing.cv ? { clientVerdict: timing.cv } : {}), ...(timing.b ? { b: timing.b } : {}) });
const timing = () => ({ ms: Math.floor(R() * 60000), seen: R() < 0.5 ? Math.floor(R() * 4) : null, cv: pickR([null, 'ok', 'off', 'win']), b: R() < 0.5 ? 1000 + Math.floor(R() * 99) : null });

// What a ledger says about one nonce, in a form two databases can compare (attempt ids differ between them).
function view(db, nonce) {
  const a = db.prepare('SELECT * FROM attempt WHERE nonce = ?').get(nonce);
  if (!a) return null;
  const st = db.prepare('SELECT next, would_rate, would_why, conflicts, judge FROM move_attempt WHERE attempt_id = ?').get(a.id);
  const plies = db.prepare('SELECT n, by, move, src, verdict, evidence, cap, answer FROM ply WHERE attempt_id = ? ORDER BY n').all(a.id)
    .map((p) => ({ ...p, answer: { ...JSON.parse(p.answer), attempt: 'A' } }));
  const reqs = db.prepare('SELECT n, sem, judged FROM move_req WHERE attempt_id = ? ORDER BY n').all(a.id).map((r) => ({ ...r }));
  return { attempt: { user_id: a.user_id, puzzle_id: a.puzzle_id, puzzle_rev: a.puzzle_rev, first: a.first, mode: a.mode, state: a.state,
    decided_ply: a.decided_ply, result: a.result, why: a.why, rated: a.rated, unrated_why: a.unrated_why }, st: { ...st, judge: JSON.parse(st.judge) }, plies, reqs };
}
const decision = (a) => a && { state: a.state, closed: a.closed, ms: a.ms, decided_ply: a.decided_ply, result: a.result, why: a.why, rated: a.rated, unrated_why: a.unrated_why };

{
  const N = 1000, streams = Array.from({ length: N }, (_, i) => makeStream(i));
  // Reference: each stream once, in order, one at a time.
  const ref = freshDb(':memory:');
  let clock = 1.8e12;
  const refApi = createMoveApi(ref, { mode: 'shadow', now: () => (clock += 1000) });
  for (const s of streams) for (let n = 0; n < s.plies.length; n++) {
    const r = await refApi.post(s.user, bodyOf(s, n, timing()), 'c' + s.user.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(r.body.verdict, 'queued');
  }
  const refViews = new Map(streams.map((s) => [s.nonce, view(ref, s.nonce)]));

  // The deliveries: every ply once, 30% of them again (other timing fields), then 30% moved later than their place
  // (within the window), streams interleaved at random.
  const deliveries = [];
  for (const s of streams) {
    const own = [];
    for (let n = 0; n < s.plies.length; n++) { own.push({ s, n, t: timing() }); if (R() < 0.3) own.push({ s, n, t: timing(), dup: true }); }
    for (let i = 0; i < own.length; i++) if (R() < 0.3) { const j = Math.min(own.length - 1, i + 1 + Math.floor(R() * 4)); [own[i], own[j]] = [own[j], own[i]]; }
    deliveries.push(own);
  }
  const order = [];
  const cursors = deliveries.map(() => 0);
  let live = deliveries.map((_, i) => i).filter((i) => deliveries[i].length);
  while (live.length) {
    const k = Math.floor(R() * live.length), i = live[k];
    order.push(deliveries[i][cursors[i]++]);
    if (cursors[i] >= deliveries[i].length) live.splice(k, 1);
  }
  const dups = order.filter((d) => d.dup).length, moved = deliveries.reduce((c, own) => c + own.filter((d, i) => i > 0 && d.n < own[i - 1].n).length, 0);

  const F = path.join(dir, 'accept.db');
  let db = freshDb(F);
  const before = untouched(db);
  let kills = 0, killOn = true;
  const KILL = new Error('killed');
  // An async judge-input layer (as a prover's would be), which sometimes dies between a ply's receipt and its
  // judgement (the process killed there): that request fails and the client sends it again later.
  const inputs = async (ctx) => {
    if (R() < 0.5) await new Promise((r) => setImmediate(r));
    if (killOn && R() < 0.02) { kills++; throw KILL; }
    return moveInputs(ctx);
  };
  let api = createMoveApi(db, { mode: 'shadow', now: () => (clock += 1000), inputs });
  const seenDecision = new Map(), answers = [];
  let i = 0, restarted = false, retried = 0;
  while (i < order.length) {
    if (!restarted && i >= order.length / 2) {
      // Restart mid-stream: a new process over the same file (in-memory chains, caches and limits gone).
      db.close(); db = new DatabaseSync(F); api = createMoveApi(db, { mode: 'shadow', now: () => (clock += 1000), inputs });
      restarted = true; killOn = false;
    }
    // Up to 6 deliveries in flight at once.
    const batch = order.slice(i, i + 1 + Math.floor(R() * 6)); i += batch.length;
    const got = await Promise.allSettled(batch.map((d) => api.post(d.s.user, bodyOf(d.s, d.n, d.t), 'c' + d.s.user.id)));
    got.forEach((g, k) => {
      const d = batch[k];
      if (g.status === 'rejected') { assert.equal(g.reason, KILL); order.push({ ...d, t: timing() }); retried++; return; }
      assert.equal(g.value.status, 200, JSON.stringify(g.value.body));
      answers.push({ d, body: g.value.body });
    });
    for (const d of batch) {
      const a = db.prepare('SELECT * FROM attempt WHERE nonce = ?').get(d.s.nonce);
      const prev = seenDecision.get(d.s.nonce);
      if (prev) assert.deepEqual(decision(a), prev, 'a decided attempt changed');
      else if (a && (a.state === 'closed' || a.state === 'conflict')) seenDecision.set(d.s.nonce, decision(a));
    }
  }
  assert.ok(restarted && kills > 0, 'the run restarted and crashed at least once');

  // One attempt per nonce, every ply stored once and judged, the same as the in-order run.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attempt WHERE mode = 'shadow'").get().c, N);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT nonce) c FROM attempt').get().c, db.prepare('SELECT COUNT(*) c FROM attempt').get().c);
  const total = streams.reduce((c, s) => c + s.plies.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ply').get().c, total);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM move_req').get().c, total);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM move_req WHERE judged = 0').get().c, 0);
  for (const s of streams) {
    const v = view(db, s.nonce);
    assert.deepEqual(v.plies.map((p) => p.n), s.plies.map((_, n) => n));
    // The would-rate depends on which of a user's attempts on a puzzle decided first (Decision 15), so on the order:
    // it may differ from the in-order run only by 'repeat'.
    const w = refViews.get(s.nonce), strip = (x) => ({ ...x, st: { ...x.st, would_rate: null, would_why: null } });
    assert.deepEqual(strip(v), strip(w), 'stream ' + s.nonce + ' differs from the in-order run');
    if (v.st.would_why !== w.st.would_why) assert.ok([v.st.would_why, w.st.would_why].includes('repeat'), s.nonce);
  }
  // At most one would-rated attempt per user and puzzle: the first to decide (two tabs, Decision 15).
  const twice = (d) => d.prepare(`SELECT m.user_id, a.puzzle_id, SUM(m.would_rate) r FROM move_attempt m JOIN attempt a ON a.id = m.attempt_id
    GROUP BY 1, 2 HAVING r > 1`).all();
  assert.deepEqual(twice(db), []); assert.deepEqual(twice(ref), []);
  // Timing-only retries never conflict; nothing was rated; nothing outside the shadow rows changed.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attempt WHERE state = 'conflict'").get().c, 0);
  assert.equal(db.prepare('SELECT SUM(conflicts) c FROM move_attempt').get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attempt WHERE mode = 'shadow' AND (rated != 0 OR first != 0)").get().c, 0);
  assert.equal(untouched(db), before);
  // Every answer given equals what is stored for that ply (or said 'queued' while it waited).
  let queued = 0;
  for (const { d, body } of answers) {
    if (body.verdict === 'queued') { queued++; continue; }
    const a = db.prepare('SELECT id FROM attempt WHERE nonce = ?').get(d.s.nonce);
    assert.deepEqual(body, JSON.parse(db.prepare('SELECT answer FROM ply WHERE attempt_id = ? AND n = ?').get(a.id, d.n).answer));
  }
  const states = Object.fromEntries(db.prepare("SELECT state || ':' || COALESCE(why, '-') k, COUNT(*) c FROM attempt WHERE mode = 'shadow' GROUP BY k").all().map((r) => [r.k, r.c]));
  const would = db.prepare('SELECT COUNT(*) c FROM move_attempt WHERE would_rate = 1').get().c;
  assert.ok(Object.keys(states).length >= 5, JSON.stringify(states)); // the streams reach many endings
  assert.ok(would > 0); // the judge would have rated some (rules, view, giveup) and the shadow rows still say rated 0
  db.close(); ref.close();
  console.log(`ok acceptance: ${N} streams, ${total} plies, ${order.length} deliveries (${dups} duplicates, ${moved} reordered, ${retried} resent after ${kills} crashes, a restart at the midpoint, ${queued} answered 'queued')`);
  console.log(`   -> one attempt each, every ply stored once, identical to the in-order run; 0 conflicts; decided attempts unchanged; nothing rated (judge would have rated ${would})`);
  console.log('   endings: ' + JSON.stringify(states));
}

// ---- 2. a conflicting duplicate ----
{
  const db = freshDb(':memory:');
  const before = untouched(db);
  const api = createMoveApi(db, { mode: 'shadow' });
  const u = userOf(5);
  const base = { puzzleId: 'p5', rev: 0 };
  // Undecided: a2 is on the tree (ok, the board goes on after b4); a2 again at ply 0 with other timing is a replay.
  const A = { ...base, nonce: 'conflict-undecided-1' };
  const ok = await api.post(u, { ...A, ply: 0, move: 'a2', ms: 10 }, 'x');
  assert.equal(ok.body.verdict, 'ok'); assert.equal(ok.body.reply, 'b4');
  assert.deepEqual((await api.post(u, { ...A, ply: 0, move: 'Fa2', ms: 999, clientVerdict: 'ok', seen: 3 }, 'x')).body, ok.body); // same move, canonically
  const errs = []; const ce = console.error; console.error = (m) => errs.push(m);
  const c1 = await api.post(u, { ...A, ply: 0, move: 'c3', ms: 10 }, 'x');
  console.error = ce;
  assert.deepEqual(c1.body, ok.body, 'a conflict is answered with the stored answer');
  let a = db.prepare('SELECT * FROM attempt WHERE nonce = ?').get(A.nonce);
  assert.equal(a.state, 'conflict'); assert.equal(a.rated, 0); assert.equal(a.unrated_why, 'conflict'); assert.equal(a.result, null);
  assert.match(errs[0], /^move: conflict a\d+ ply 0 \(attempt now conflict, unrated\)$/);
  // After a conflict nothing more is judged: a winning move later is logged, not a solve.
  const later = await api.post(u, { ...A, ply: 1, move: 'e1' }, 'x');
  assert.equal(later.body.verdict, 'logged');
  assert.equal(db.prepare('SELECT state FROM attempt WHERE id = ?').get(a.id).state, 'conflict');
  // Decided: e1 wins by the rules at ply 0 (solved); a different move or an act for ply 0 changes nothing.
  const B = { ...base, nonce: 'conflict-decided-01' };
  const win = await api.post(u, { ...B, ply: 0, move: 'e1', ms: 1200 }, 'x');
  assert.equal(win.body.verdict, 'solved');
  const dec = decision(db.prepare('SELECT * FROM attempt WHERE nonce = ?').get(B.nonce));
  assert.equal(dec.state, 'closed'); assert.equal(dec.result, 1); assert.equal(dec.why, 'rules'); assert.equal(dec.rated, 0); assert.equal(dec.unrated_why, 'shadow');
  console.error = (m) => errs.push(m);
  assert.deepEqual((await api.post(u, { ...B, ply: 0, move: 'c3' }, 'x')).body, win.body);
  assert.deepEqual((await api.post(u, { ...B, ply: 0, act: 'view' }, 'x')).body, win.body);
  console.error = ce;
  assert.match(errs.at(-1), /attempt already decided: unchanged/);
  assert.deepEqual(decision(db.prepare('SELECT * FROM attempt WHERE nonce = ?').get(B.nonce)), dec);
  assert.equal(db.prepare('SELECT conflicts FROM move_attempt WHERE attempt_id = (SELECT id FROM attempt WHERE nonce = ?)').get(B.nonce).conflicts, 2);
  // A conflicting duplicate of a ply still waiting for an earlier one: the attempt becomes conflict, as undecided.
  const C = { ...base, nonce: 'conflict-queued-001' };
  assert.equal((await api.post(u, { ...C, ply: 2, move: 'c3' }, 'x')).body.verdict, 'queued');
  console.error = () => {};
  assert.equal((await api.post(u, { ...C, ply: 2, move: 'c4' }, 'x')).body.verdict, 'queued');
  console.error = ce;
  assert.equal(db.prepare('SELECT state FROM attempt WHERE nonce = ?').get(C.nonce).state, 'conflict');
  assert.equal(untouched(db), before);
  console.log('ok conflict: undecided -> conflict (unrated, nothing judged after); decided -> unchanged; answered with the stored answer; logged without token/IP/nonce');
}

// ---- 3. input checks, identity, ownership, no user ----
{
  const db = freshDb(':memory:');
  const before = untouched(db);
  const api = createMoveApi(db, { mode: 'shadow' });
  const u = userOf(7), good = { puzzleId: 'p6', rev: 0, nonce: 'abcdefghijklmnop', ply: 0, move: 'a2' };
  const bad = (o) => assert.throws(() => parsePly(o), (e) => e.status === 400, JSON.stringify(o));
  for (const o of [{}, { ...good, nonce: 'short' }, { ...good, nonce: 'legacy-abcdefghijkl' }, { ...good, nonce: 'a'.repeat(65) }, { ...good, nonce: 'abc def ghij klmnop' },
    { ...good, ply: -1 }, { ...good, ply: MAX_PLY }, { ...good, ply: 1.5 }, { ...good, ply: '0' }, { ...good, puzzleId: 7 }, { ...good, puzzleId: '../x' },
    { ...good, rev: -1 }, { ...good, rev: '0' }, { ...good, act: 'hint' }, { ...good, move: undefined }, { ...good, move: 'z9' }, { ...good, move: 'a2'.repeat(13) },
    { ...good, move: undefined, act: 'resign' }, { ...good, move: undefined, act: 'expire' }, { ...good, move: { x: 1 } }]) bad(o);
  assert.equal(parsePly({ ...good, ms: -5, seen: 'x', clientVerdict: 'NO WAY', b: 'x', theme: 'nope' }).ms, null);
  // A move the board size can't hold is refused before anything is written.
  assert.equal((await api.post(u, { ...good, nonce: 'sizecheck-000001', puzzleId: 'p4', rev: 2, move: 'e5' }, 'x')).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attempt WHERE mode = 'shadow'").get().c, 0);
  // No user: nothing is written (shadow never mints).
  assert.deepEqual((await api.post(null, good, 'x')).body, { mode: 'shadow', stored: false });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attempt WHERE mode = 'shadow'").get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 40);
  // Unknown puzzle: 404, nothing written.
  assert.equal((await api.post(u, { ...good, puzzleId: 'nope' }, 'x')).status, 404);
  // Nonce identity: bound to its user and puzzle.
  const first = await api.post(u, good, 'x');
  assert.equal(first.status, 200); assert.equal(first.body.verdict, 'ok');
  assert.equal((await api.post(userOf(8), { ...good, ply: 1, move: 'f1' }, 'x')).status, 409);
  assert.equal((await api.post(u, { ...good, puzzleId: 'p5', ply: 1 }, 'x')).status, 409);
  await assert.rejects(api.post(u, { ...good, nonce: 'legacy-x'.padEnd(16, 'y') }, 'x'), (e) => e.status === 400); // never a legacy row's nonce
  // The window: a ply more than WINDOW ahead of the first unjudged one is refused (not stored).
  const far = await api.post(u, { ...good, ply: 1 + WINDOW, move: 'c3' }, 'x');
  assert.equal(far.status, 409); assert.equal(far.body.next, 1);
  // 6x6 off-tree after a2 b4: a play-out; with no engine reply in C1a it ends 'noengine', unrated (I2).
  const off = await api.post(u, { ...good, ply: 1, move: 'c3' }, 'x');
  assert.equal(off.body.verdict, 'missed'); assert.equal(off.body.why, 'noengine');
  const a = db.prepare('SELECT * FROM attempt WHERE nonce = ?').get(good.nonce);
  assert.deepEqual([a.state, a.result, a.why, a.rated, a.unrated_why, a.first, a.decided_ply], ['closed', 0, 'noengine', 0, 'shadow', 0, 1]);
  assert.deepEqual({ ...db.prepare('SELECT would_rate, would_why FROM move_attempt WHERE attempt_id = ?').get(a.id) }, { would_rate: 0, would_why: 'noengine' });
  // GET: the owner sees the plies; anyone else (or no one) gets 404; a bad nonce 400.
  const g = await api.get(u, good.nonce);
  assert.equal(g.status, 200); assert.equal(g.body.state, 'closed'); assert.equal(g.body.rated, false);
  assert.deepEqual(g.body.plies.map((p) => p.verdict), ['ok', 'missed']); assert.deepEqual(g.body.waiting, []);
  assert.equal((await api.get(userOf(8), good.nonce)).status, 404);
  assert.equal((await api.get(null, good.nonce)).status, 404);
  assert.equal((await api.get(u, 'zzzzzzzzzzzzzzzz')).status, 404);
  assert.equal((await api.get(u, 'bad')).status, 400);
  // An illegal move is stored as 'illegal' and changes nothing; the rev the client loaded is what counts.
  const r1 = { puzzleId: 'p4', rev: 1, nonce: 'rev-one-00000001' };
  assert.equal((await api.post(u, { ...r1, ply: 0, move: 'a1' }, 'x')).body.verdict, 'illegal');
  assert.equal((await api.post(u, { ...r1, ply: 1, move: 'd1' }, 'x')).body.verdict, 'solved'); // wins by the rules (rev 1's tree has d1)
  const unk = { puzzleId: 'p4', nonce: 'rev-unknown-0001' }; // no rev, and p4 has been revised: the move is undecided
  const u1 = await api.post(u, { ...unk, ply: 0, move: 'd1' }, 'x');
  assert.equal(u1.body.verdict, 'missed');
  assert.deepEqual({ ...db.prepare('SELECT puzzle_rev, why FROM attempt WHERE nonce = ?').get(unk.nonce) }, { puzzle_rev: -1, why: 'undecided' });
  // Per-user ply limit.
  let limited = 0;
  for (let k = 0; k < 300; k++) if ((await api.post(userOf(9), { ...good, nonce: 'limit-test-00001', puzzleId: 'p5', ply: 0 }, 'x')).status === 429) limited++;
  assert.ok(limited > 0);
  assert.equal(untouched(db), before);
  console.log('ok input: malformed fields 400; no user -> nothing written; nonce bound to user and puzzle; window; owner-only GET; illegal moves; rev; limits');
}

// ---- 3b. disk caps per user per day (kept across a restart); no limit one caller can use up for everyone ----
{
  const F = path.join(dir, 'caps.db');
  let db = freshDb(F);
  let clock = Date.UTC(2026, 10, 17, 1);
  const tick = () => (clock += 3000); // 3 s apart: under every per-minute limit
  let api = createMoveApi(db, { mode: 'shadow', now: tick });
  const u = userOf(10), stored = () => db.prepare('SELECT COUNT(*) c FROM move_req').get().c;
  // One user posting full-length attempts all day: the stored plies stop at the daily cap.
  let k = 0, refused = null;
  for (let tries = 0; tries < 4000 && !refused; k++) for (let n = 0; n < MAX_PLY && !refused; n++, tries++) {
    const r = await api.post(u, { puzzleId: 'p5', rev: 0, nonce: 'daycap-' + String(k).padStart(9, '0'), ply: n, act: 'hint' }, 'ip1');
    if (r.status === 429) refused = r; else assert.equal(r.status, 200);
  }
  assert.ok(refused && refused.wait > 3600, 'refused until the next UTC day');
  assert.equal(stored(), LIMITS.dayPlies);
  // A replay of a stored ply is still answered.
  assert.equal((await api.post(u, { puzzleId: 'p5', rev: 0, nonce: 'daycap-000000000', ply: 0, act: 'hint' }, 'ip1')).status, 200);
  // A restart does not reset it; another user is not affected; the next UTC day is.
  db.close(); db = new DatabaseSync(F); api = createMoveApi(db, { mode: 'shadow', now: tick });
  assert.equal((await api.post(u, { puzzleId: 'p5', rev: 0, nonce: 'daycap-after-restart', ply: 0, act: 'hint' }, 'ip1')).status, 429);
  assert.equal((await api.post(userOf(11), { puzzleId: 'p5', rev: 0, nonce: 'daycap-other-user', ply: 0, act: 'hint' }, 'ip2')).status, 200);
  clock = Date.UTC(2026, 10, 18, 0, 0, 5);
  assert.equal((await api.post(u, { puzzleId: 'p5', rev: 0, nonce: 'daycap-next-day-1', ply: 0, act: 'hint' }, 'ip1')).status, 200);
  // The daily attempt cap (small limits so it is quick) also survives a restart.
  const small = { dayAttempts: 3, newPer10Min: 1e6, ipNewPer10Min: 1e6 };
  api = createMoveApi(db, { mode: 'shadow', now: tick, limits: small });
  const open = (id, i) => api.post(userOf(id), { puzzleId: 'p6', rev: 0, nonce: 'att-cap-' + id + '-' + String(i).padStart(8, '0'), ply: 0, act: 'hint' }, 'ip' + id);
  for (let i = 0; i < 3; i++) assert.equal((await open(12, i)).status, 200);
  assert.equal((await open(12, 3)).status, 429);
  db.close(); db = new DatabaseSync(F); api = createMoveApi(db, { mode: 'shadow', now: tick, limits: small });
  assert.equal((await open(12, 4)).status, 429);
  db.close();
  // Many users opening attempts at once from many addresses do not block a newcomer (no limit shared by everyone); one
  // address is limited on its own; a request refused by one limit counts against no other.
  const db2 = freshDb(':memory:');
  let c2 = Date.UTC(2026, 10, 17, 1);
  const api2 = createMoveApi(db2, { mode: 'shadow', now: () => (c2 += 10) });
  const go = (id, nonce, ip) => api2.post(userOf(id), { puzzleId: 'p5', rev: 0, nonce, ply: 0, act: 'hint' }, ip);
  for (let id = 13; id <= 38; id++) for (let j = 0; j < LIMITS.newPer10Min; j++) assert.equal((await go(id, `flood-${id}-${j}`.padEnd(16, 'z'), 'ip' + id)).status, 200);
  assert.equal((await go(39, 'newcomer-0000001', 'ip39')).status, 200);
  for (let j = 0; j < LIMITS.ipNewPer10Min; j++) await go(1 + (j % 12), `nat-${j}`.padEnd(16, 'z'), 'nat');
  assert.equal((await go(40, 'nat-newcomer-001', 'nat')).status, 429, 'one address is limited');
  assert.equal((await go(40, 'own-address-0001', 'ip40')).status, 200, 'the refusal above did not count against user 40');
  console.log(`ok caps: one user's stored plies stop at ${LIMITS.dayPlies} a day (also after a restart; replays still answered); daily attempt cap kept across a restart; no shared limit; per-address limit`);
}

// ---- 5. decide mode: guest binding, per-nonce idempotent minting (C1b) ----
// mint() stands in for server.js's newGuest under its 10/h/IP guest window.
function minter(getDb, { limit = 1e9 } = {}) {
  const m = { calls: 0, made: [], refuse: false };
  m.fn = () => {
    m.calls++;
    if (m.refuse || m.made.length >= limit) return { wait: 1800 };
    const token = crypto.randomBytes(24).toString('hex');
    const { lastInsertRowid: id } = getDb().prepare('INSERT INTO users (name, token_hash, rating, rd, vol, games, wins, created_at) VALUES (NULL, ?, 1500, 350, 0.06, 0, 0, 1)')
      .run(crypto.createHash('sha256').update(token).digest('hex'));
    m.made.push(token);
    return { user: { id: Number(id), name: null }, token, headers: { 'set-cookie': 'tinue_token=' + token } };
  };
  return m;
}
const usersCount = (db) => db.prepare('SELECT COUNT(*) c FROM users').get().c;
const everything = (db) => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all()));
{
  const F = path.join(dir, 'decide.db'), KEY = path.join(dir, 'unit-mint-key');
  let db = freshDb(F);
  let clock = Date.UTC(2026, 10, 17, 2);
  const tick = () => (clock += 1000);
  let api = createMoveApi(db, { mode: 'decide', now: tick, mintKeyFile: KEY });
  assert.ok(fs.existsSync(KEY) && (fs.statSync(KEY).mode & 0o777) === 0o600, 'mint key made 0600');
  const ratingsBefore = JSON.stringify(['puzzles', 'attempts', 'rating_event'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()))
    + JSON.stringify(db.prepare('SELECT * FROM users').all());
  const m = minter(() => db);
  const n0 = usersCount(db);
  const P = { puzzleId: 'p5', rev: 0, nonce: 'decide-visitor-0001' };
  // Invalid plies, unknown puzzles and refused limits never mint.
  await assert.rejects(api.post(null, { ...P, ply: 'x', move: 'a2' }, 'v1', { mint: m.fn }), (e) => e.status === 400);
  assert.equal((await api.post(null, { ...P, puzzleId: 'nope', ply: 0, move: 'a2' }, 'v1', { mint: m.fn })).status, 404);
  assert.equal((await api.post(null, { ...P, ply: 0, move: 'h8' }, 'v1', { mint: m.fn })).status, 400);
  m.refuse = true;
  const lim = await api.post(null, { ...P, ply: 0, move: 'a2' }, 'v1', { mint: m.fn });
  assert.equal(lim.status, 429); assert.equal(lim.wait, 1800);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM attempt WHERE nonce = ?').get(P.nonce).c, 0);
  m.refuse = false;
  assert.equal(m.made.length, 0); assert.equal(usersCount(db), n0);
  // The first ply without a token mints; two copies of it at once and a lost-answer retry: one guest, one token.
  const [a1, a2] = await Promise.all([0, 1].map((k) => api.post(null, { ...P, ply: 0, move: 'a2', ms: 10 + k }, 'v1', { mint: m.fn })));
  assert.equal(a1.status, 200); assert.equal(a1.body.verdict, 'ok'); assert.equal(a1.body.mode, 'decide');
  assert.match(a1.body.token, /^[a-f0-9]{48}$/);
  assert.equal(a2.body.token, a1.body.token); assert.deepEqual(a2.body, a1.body);
  assert.equal(a1.headers['set-cookie'], 'tinue_token=' + a1.body.token);
  const retry = await api.post(null, { ...P, ply: 0, move: 'a2', ms: 99 }, 'v1', { mint: m.fn });
  assert.deepEqual(retry.body, a1.body, 'lost-token retry: the same answer and the same token');
  assert.equal(m.made.length, 1); assert.equal(usersCount(db), n0 + 1, 'exactly one guest');
  const guest = { id: db.prepare('SELECT user_id FROM attempt WHERE nonce = ?').get(P.nonce).user_id, name: null };
  assert.equal(guest.id, Math.max(...db.prepare('SELECT id FROM users').all().map((r) => r.id)));
  // The token is never stored in the clear (only its hash in users, as today; the seal in move_mint).
  assert.ok(!everything(db).includes(a1.body.token));
  assert.ok(!db.prepare('SELECT answer FROM ply').all().some((r) => r.answer.includes('token')));
  // A restart with the same key: the retry still gets the same token. Another key: bound to the same guest, no token.
  db.close(); db = new DatabaseSync(F); api = createMoveApi(db, { mode: 'decide', now: tick, mintKeyFile: KEY });
  assert.deepEqual((await api.post(null, { ...P, ply: 0, move: 'a2' }, 'v1', { mint: m.fn })).body, a1.body);
  const other = createMoveApi(db, { mode: 'decide', now: tick, requeue: false });
  const nokey = await other.post(null, { ...P, ply: 0, move: 'a2' }, 'v1', { mint: m.fn });
  assert.equal(nokey.status, 200); assert.equal(nokey.body.token, undefined); assert.equal(nokey.body.attempt, a1.body.attempt);
  assert.equal(m.made.length, 1);
  // The next ply, still without a token (one ply at a time until it holds one): the same guest; a win by the rules.
  const w = await api.post(null, { ...P, ply: 1, move: 'e1' }, 'v1', { mint: m.fn });
  assert.equal(w.body.verdict, 'solved'); assert.equal(w.body.token, a1.body.token);
  // With the token as a Bearer header the seal is dropped; a later tokenless request (a beacon) stays bound, no token.
  const auth = await api.post(guest, { ...P, ply: 1, move: 'e1' }, 'v1', { bearer: true, mint: m.fn });
  assert.equal(auth.body.token, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM move_mint').get().c, 0);
  const beacon = await api.post(null, { ...P, ply: 2, act: 'unload' }, 'v1', { mint: m.fn });
  assert.equal(beacon.status, 200); assert.equal(beacon.body.verdict, 'logged'); assert.equal(beacon.body.token, undefined);
  assert.equal(m.made.length, 1); assert.equal(usersCount(db), n0 + 1);
  // Another user's token on this nonce: 409, nothing stored. A signed-in user never mints.
  assert.equal((await api.post(userOf(7), { ...P, ply: 3, act: 'hint' }, 'v1', { bearer: true, mint: m.fn })).status, 409);
  const signed = await api.post(userOf(7), { ...P, nonce: 'decide-signed-in-01', ply: 0, move: 'a2' }, 'v1', { bearer: true, mint: m.fn });
  assert.equal(signed.status, 200); assert.equal(signed.body.token, undefined); assert.equal(m.calls, 2, "mint called only for the refused try and the one guest");
  // The nonce is a capability only for the guest it minted: a tokenless ply on a signed-in account's nonce (another
  // caller, another address) is refused and changes nothing; it never decides the account's attempt.
  const acct = () => everything(db);
  const acct0 = acct();
  for (const body of [{ ply: 1, act: 'view' }, { ply: 1, act: 'unload' }, { ply: 0, move: 'a2' }]) {
    const r = await api.post(null, { ...P, nonce: 'decide-signed-in-01', ...body }, 'v9', { mint: m.fn });
    assert.equal(r.status, 409, JSON.stringify(body)); assert.equal(r.body.token, undefined);
  }
  assert.equal(acct(), acct0, 'a tokenless ply on an account nonce wrote nothing');
  assert.equal(db.prepare("SELECT state FROM attempt WHERE nonce = 'decide-signed-in-01'").get().state, 'open');
  assert.equal(m.calls, 2, 'a tokenless ply on a known nonce never mints');
  // A new nonce without a token is a new page load of a visitor without one: a new guest (the shared limit caps it).
  const v2 = await api.post(null, { ...P, nonce: 'decide-visitor-0002', ply: 0, act: 'hint' }, 'v2', { mint: m.fn });
  assert.notEqual(v2.body.token, a1.body.token); assert.equal(m.made.length, 2);
  // The seal expires after MINT_TTL: a retry is still bound, without a token.
  clock += MINT_TTL + 1;
  const late = await api.post(null, { ...P, nonce: 'decide-visitor-0002', ply: 0, act: 'hint' }, 'v2', { mint: m.fn });
  assert.equal(late.status, 200); assert.equal(late.body.token, undefined); assert.equal(m.made.length, 2);
  // Nothing rated: today's tables unchanged but for the two new guest rows; every row unrated.
  assert.equal(JSON.stringify(['puzzles', 'attempts', 'rating_event'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()))
    + JSON.stringify(db.prepare('SELECT * FROM users WHERE id <= 40').all()), ratingsBefore);
  assert.deepEqual(db.prepare("SELECT DISTINCT mode, rated FROM attempt WHERE mode != 'legacy'").all().map((r) => ({ ...r })), [{ mode: 'decide', rated: 0 }]);
  // Shadow (and veto) never mint: a tokenless ply is not stored.
  for (const md of ['shadow', 'veto']) {
    const s = createMoveApi(db, { mode: md, requeue: false });
    assert.deepEqual((await s.post(null, { ...P, nonce: 'shadow-tokenless-01', ply: 0, move: 'a2' }, 'v3', { mint: m.fn })).body, { mode: 'shadow', stored: false });
    assert.deepEqual((await s.post(null, { ...P, ply: 0, move: 'a2' }, 'v3', { mint: m.fn })).body, { mode: 'shadow', stored: false });
  }
  assert.equal(m.made.length, 2);
  db.close();
  // 200 lost-answer retries over 50 visitors, some concurrent, with a restart in the middle: one guest per nonce.
  const F2 = path.join(dir, 'decide2.db');
  let d2 = freshDb(F2);
  const n2 = usersCount(d2), m2 = minter(() => d2);
  let api2 = createMoveApi(d2, { mode: 'decide', now: tick, mintKeyFile: KEY });
  const tokens = new Map();
  for (let k = 0; k < 200; k++) {
    if (k === 100) { d2.close(); d2 = new DatabaseSync(F2); api2 = createMoveApi(d2, { mode: 'decide', now: tick, mintKeyFile: KEY }); }
    const v = k % 50, nonce = ('retry-visitor-' + v).padEnd(20, 'q');
    const mint = m2.fn;
    const rs = await Promise.all(Array.from({ length: 1 + (k % 3) }, () => api2.post(null, { puzzleId: 'p6', rev: 0, nonce, ply: 0, move: 'a2' }, 'ip' + v, { mint })));
    for (const r of rs) {
      assert.equal(r.status, 200);
      if (!tokens.has(nonce)) tokens.set(nonce, r.body.token);
      assert.equal(r.body.token, tokens.get(nonce));
    }
  }
  assert.equal(m2.made.length, 50); assert.equal(usersCount(d2), n2 + 50);
  d2.close();
  console.log('ok decide: tokenless first ply mints once per nonce (concurrent copies, lost-answer retries, a restart: 50 visitors x 200 retries -> 50 guests); same token back while sealed; bound without it; never minted in shadow/veto; nothing rated; token never stored');
}

// ---- 6. startup re-queue (C1b): a restart while a ply is `judging` -> it resumes, or ends unrated ----
{
  const F = path.join(dir, 'requeue.db');
  let db = freshDb(F);
  let clock = Date.UTC(2026, 10, 17, 3);
  const tick = () => (clock += 1000);
  const hang = () => new Promise(() => {}); // the process dies while the inputs are awaited
  const u = userOf(4);
  const logs = [], cl = console.log;
  const quiet = (f) => async (...a) => { console.log = (x) => logs.push(String(x)); try { return await f(...a); } finally { console.log = cl; } };
  const boot = (inputs) => createMoveApi(db, { mode: 'shadow', now: tick, inputs });
  const reopen = () => { db.close(); db = new DatabaseSync(F); };
  // Resumes: ply 0 hangs in `judging`; the next process judges it from its stored body (no client retry needed).
  let api = boot(hang);
  const R1 = { puzzleId: 'p5', rev: 0, nonce: 'requeue-resume-001' };
  api.post(u, { ...R1, ply: 0, move: 'a2', ms: 5 }, 'x');
  api.post(u, { ...R1, ply: 1, move: 'e1', ms: 6 }, 'x'); // waits behind it in the nonce's chain: lost with the process
  await new Promise((r) => setTimeout(r, 20));
  const att = () => db.prepare('SELECT * FROM attempt WHERE nonce = ?').get(R1.nonce);
  assert.equal(att().state, 'judging');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM move_req WHERE attempt_id = ? AND judged = 0').get(att().id).c, 1);
  reopen();
  let res = await quiet(async () => { api = boot(moveInputs); return api.requeued; })();
  assert.deepEqual({ ...res }, { stuck: 1, resumed: 1, unrated: 0, failed: 0 });
  let a = att();
  assert.equal(a.state, 'open');
  assert.deepEqual(db.prepare('SELECT n, verdict FROM ply WHERE attempt_id = ?').all(a.id).map((r) => [r.n, r.verdict]), [[0, 'ok']]);
  // The client's retries: the stored answer, then the next ply goes on from the resumed board.
  assert.equal((await api.post(u, { ...R1, ply: 0, move: 'a2', ms: 50 }, 'x')).body.verdict, 'ok');
  assert.equal((await api.post(u, { ...R1, ply: 1, move: 'e1', ms: 6 }, 'x')).body.verdict, 'solved');
  a = att();
  assert.equal(a.state, 'closed'); assert.equal(a.result, 1); assert.equal(a.why, 'rules'); assert.equal(a.decided_ply, 1); assert.equal(a.rated, 0);
  // Ends unrated: a ply that hangs (or kills the process) at every startup is judged as a fault after MAX_REQUEUES.
  const R2 = { puzzleId: 'p6', rev: 0, nonce: 'requeue-unrated-01' };
  api = boot(hang);
  api.post(u, { ...R2, ply: 0, move: 'a2', ms: 5 }, 'x');
  await new Promise((r) => setTimeout(r, 20));
  for (let k = 0; k < MAX_REQUEUES; k++) { reopen(); await quiet(async () => { api = boot(hang); await new Promise((r) => setTimeout(r, 20)); })(); }
  const att2 = () => db.prepare('SELECT * FROM attempt WHERE nonce = ?').get(R2.nonce);
  assert.equal(att2().state, 'judging');
  reopen();
  res = await quiet(async () => { api = boot(moveInputs); return api.requeued; })();
  assert.deepEqual({ ...res }, { stuck: 1, resumed: 0, unrated: 1, failed: 0 });
  a = att2();
  assert.equal(a.state, 'closed'); assert.equal(a.result, 0); assert.equal(a.rated, 0); assert.equal(a.why, 'undecided');
  assert.equal(db.prepare('SELECT would_rate FROM move_attempt WHERE attempt_id = ?').get(a.id).would_rate, 0, 'not even the judge would rate it');
  assert.match(db.prepare('SELECT evidence FROM ply WHERE attempt_id = ? AND n = 0').get(a.id).evidence, /"reason":"restart"/);
  // A pending search (a prover's; none exists before S2/D3) cannot be re-run: missed, unrated.
  const R3 = { puzzleId: 'p5', rev: 0, nonce: 'requeue-pending-01' };
  api = boot(async (ctx) => { const r = moveInputs(ctx); return r.illegal ? r : { inputs: { ...r.inputs, pns: { kind: 'pending' } } }; });
  assert.equal((await api.post(u, { ...R3, ply: 0, move: 'c3', ms: 5 }, 'x')).body.verdict, 'pending');
  const att3 = () => db.prepare('SELECT * FROM attempt WHERE nonce = ?').get(R3.nonce);
  assert.equal(att3().state, 'pending');
  reopen();
  res = await quiet(async () => { api = boot(moveInputs); return api.requeued; })();
  assert.deepEqual({ ...res }, { stuck: 1, resumed: 0, unrated: 1, failed: 0 });
  a = att3();
  assert.equal(a.state, 'closed'); assert.equal(a.result, 0); assert.equal(a.rated, 0); assert.equal(a.why, 'undecided');
  assert.deepEqual(JSON.parse(db.prepare('SELECT answer FROM ply WHERE attempt_id = ? AND n = 0').get(a.id).answer).verdict, 'missed');
  // A clean restart re-queues nothing; inputs that throw MAX_TRIES times in one process end the ply as a fault.
  reopen();
  res = await quiet(async () => { api = boot(moveInputs); return api.requeued; })();
  assert.equal(res.stuck, 0);
  const R4 = { puzzleId: 'p6', rev: 0, nonce: 'requeue-throws-001' };
  api = boot(async () => { throw new Error('boom'); });
  for (let k = 0; k < MAX_TRIES; k++) await assert.rejects(api.post(u, { ...R4, ply: 0, move: 'a2' }, 'x'), /boom/);
  assert.equal((await api.post(u, { ...R4, ply: 0, move: 'a2' }, 'x')).body.verdict, 'missed');
  a = db.prepare('SELECT * FROM attempt WHERE nonce = ?').get(R4.nonce);
  assert.equal(a.rated, 0); assert.equal(a.why, 'undecided');
  // The re-queue prints counts only: no nonce.
  assert.ok(logs.some((l) => /^move: re-queued 1 attempt after restart: 1 resumed, 0 closed unrated, 0 still waiting$/.test(l)), JSON.stringify(logs));
  for (const n of [R1, R2, R3, R4]) assert.ok(!logs.join('\n').includes(n.nonce));
  db.close();
  console.log(`ok requeue: restart while judging -> resumed from the stored plies; stuck past ${MAX_REQUEUES} restarts or ${MAX_TRIES} throws -> missed unrated (fault); pending -> missed unrated; counts-only log`);
}

// ---- 4. the real server ----
const { base, boot, stop } = testServer(dir, { quiet: true });
const LOG = path.join(dir, 'access.log');
const send = async (p, { method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(base + p, { method, headers, ...(body != null ? { body } : {}) });
  return { status: r.status, text: await r.text(), type: r.headers.get('content-type'), h: r.headers };
};
const NH = 'x-tinue-nonce';
const preflight = () => send('/api/attempt', { method: 'OPTIONS', headers: { origin: 'https://shydrie.xyz', 'access-control-request-method': 'GET', 'access-control-request-headers': NH } });
{
  const F = path.join(dir, 'server.db');
  const token = crypto.randomBytes(24).toString('hex');
  const auth = { authorization: 'Bearer ' + token, 'content-type': 'text/plain;charset=UTF-8' };
  const ply = (o) => JSON.stringify({ puzzleId: 'p6', rev: 0, nonce: 'http-nonce-000001', ply: 0, move: 'a2', ms: 5, ...o });
  // Off (TINUE_JUDGE unset): exactly what an unknown route gets; no table is created.
  let s = await boot(F);
  const d = new DatabaseSync(F);
  d.prepare("INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating) VALUES ('p6', 6, ?, 3, ?, 'test', 1500, 1500)").run(PUZZLES[1].tps, JSON.stringify(PUZZLES[1].tree));
  d.prepare('INSERT INTO users (name, token_hash, created_at) VALUES (?, ?, 1)').run('tester', crypto.createHash('sha256').update(token).digest('hex'));
  const snap = () => JSON.stringify(['users', 'puzzles', 'attempts', 'attempt', 'ply', 'rating_event'].map((t) => d.prepare(`SELECT * FROM ${t}`).all()));
  const unknown = await send('/api/nope', { method: 'POST', body: ply(), headers: auth });
  assert.equal(unknown.status, 404); assert.equal(unknown.text, '{"error":"unknown route"}');
  for (const [p, m] of [['/api/move', 'POST'], ['/api/attempt?nonce=http-nonce-000001', 'GET'], ['/api/attempt', 'GET']]) {
    for (const body of [ply(), 'x'.repeat(5000), '{bad', undefined]) {
      if (m === 'GET' && body !== undefined) continue;
      const r = await send(p, { method: m, body, headers: auth });
      assert.deepEqual([r.status, r.text, r.type], [unknown.status, unknown.text, unknown.type], `${m} ${p} off`);
    }
  }
  assert.equal(d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE 'move_%'").get().c, 0);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM attempt').get().c, 0);
  // Off: today's preflight headers (no nonce header allowed), no mint key, today's access-log line (query kept as sent).
  assert.equal((await preflight()).h.get('access-control-allow-headers'), 'content-type, authorization');
  assert.ok(!fs.existsSync(path.join(path.dirname(F), 'mint-key')), 'off makes no mint key');
  await stop(s);
  assert.ok(fs.readFileSync(LOG, 'utf8').includes('GET /api/attempt?nonce=http-nonce-000001 404'), 'off: the access log line is as today');
  fs.rmSync(LOG);
  const keyBefore = fs.existsSync(path.join(dir, 'mint-key'));
  // Shadow.
  s = await boot(F, { TINUE_JUDGE: 'shadow' });
  const before = JSON.stringify(['users', 'puzzles', 'attempts', 'rating_event'].map((t) => d.prepare(`SELECT * FROM ${t}`).all()));
  const r0 = await send('/api/move', { method: 'POST', body: ply(), headers: auth });
  assert.equal(r0.status, 200, r0.text);
  const a0 = JSON.parse(r0.text);
  assert.deepEqual([a0.verdict, a0.reply, a0.mode], ['ok', 'b4', 'shadow']);
  // timing-only replay over HTTP: the same answer
  assert.equal((await send('/api/move', { method: 'POST', body: ply({ ms: 77, clientVerdict: 'ok' }), headers: auth })).text, r0.text);
  const r1 = await send('/api/move', { method: 'POST', body: ply({ ply: 1, move: 'f1' }), headers: auth });
  assert.equal(JSON.parse(r1.text).verdict, 'solved');
  const g = await send('/api/attempt', { headers: { authorization: 'Bearer ' + token, [NH]: 'http-nonce-000001' } });
  assert.equal(g.status, 200); assert.equal(JSON.parse(g.text).state, 'closed');
  // The nonce is taken from the header only: in a query string it is not read (400) and is blanked in the access log.
  assert.equal((await send('/api/attempt?nonce=http-nonce-000001', { headers: { authorization: 'Bearer ' + token } })).status, 400);
  assert.equal((await preflight()).h.get('access-control-allow-headers'), 'content-type, authorization, x-tinue-nonce');
  // Oversized (by header and by stream), malformed, no user.
  assert.equal((await send('/api/move', { method: 'POST', body: 'x'.repeat(MAX_BODY + 1), headers: auth })).status, 413);
  const chunked = await new Promise((resolve, reject) => { // no content-length: the cap applies while reading
    const rq = http.request(base + '/api/move', { method: 'POST', headers: auth }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    rq.on('error', reject); rq.write('{"a":"' + 'x'.repeat(MAX_BODY)); rq.end('"}');
  });
  assert.equal(chunked, 413);
  for (const body of ['{bad', '[]', '"x"', '', ply({ ply: 'one' }), ply({ move: 'q9' })]) assert.equal((await send('/api/move', { method: 'POST', body, headers: auth })).status, 400, body);
  const anon = await send('/api/move', { method: 'POST', body: ply({ nonce: 'anon-nonce-000001' }), headers: { 'content-type': 'text/plain' } });
  assert.deepEqual(JSON.parse(anon.text), { mode: 'shadow', stored: false });
  assert.equal((await send('/api/attempt', { headers: { [NH]: 'http-nonce-000001' } })).status, 404);
  // Today's routes are as before.
  assert.equal((await send('/api/nope', { method: 'POST', body: ply(), headers: auth })).text, '{"error":"unknown route"}');
  assert.equal((await send('/api/me', { headers: { authorization: 'Bearer ' + token } })).status, 200);
  await stop(s);
  assert.equal(JSON.stringify(['users', 'puzzles', 'attempts', 'rating_event'].map((t) => d.prepare(`SELECT * FROM ${t}`).all())), before);
  assert.equal(d.prepare("SELECT COUNT(*) c FROM attempt WHERE mode = 'shadow'").get().c, 1);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM ply').get().c, 2);
  assert.ok(snap());
  d.close();
  const log = fs.readFileSync(LOG, 'utf8');
  assert.ok(log.includes('POST /api/move 200'));
  assert.ok(!log.includes(token) && !log.includes('127.0.0.1') && !/::1\b/.test(log), 'no token or IP in the access log');
  assert.ok(!s.err().includes(token));
  // No nonce in any log line (access log, stdout, stderr); shadow makes no mint key.
  for (const text of [log, s.out(), s.err()]) for (const n of ['http-nonce-000001', 'anon-nonce-000001']) assert.ok(!text.includes(n), 'a nonce was logged');
  assert.ok(log.includes('GET /api/attempt?nonce=- 400'));
  assert.equal(fs.existsSync(path.join(dir, 'mint-key')), keyBefore);
  fs.rmSync(LOG);

  // Decide: a tokenless first ply makes one guest; a lost-answer retry gets the same token and no second guest.
  const F2 = path.join(dir, 'srv-decide', 'decide.db');
  fs.mkdirSync(path.dirname(F2));
  s = await boot(F2, { TINUE_JUDGE: 'Decide' });
  const d2 = new DatabaseSync(F2);
  d2.prepare("INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating) VALUES ('p6', 6, ?, 3, ?, 'test', 1500, 1500)").run(PUZZLES[1].tps, JSON.stringify(PUZZLES[1].tree));
  const KEYF = path.join(path.dirname(F2), 'mint-key');
  assert.equal(fs.statSync(KEYF).mode & 0o777, 0o600);
  const users0 = d2.prepare('SELECT COUNT(*) c FROM users').get().c;
  const vis = (o) => ply({ nonce: 'decide-http-00001', ...o });
  const plain = { 'content-type': 'text/plain;charset=UTF-8' };
  const m1 = await send('/api/move', { method: 'POST', body: vis(), headers: plain });
  assert.equal(m1.status, 200, m1.text);
  const b1 = JSON.parse(m1.text);
  assert.equal(b1.verdict, 'ok'); assert.equal(b1.mode, 'decide'); assert.match(b1.token, /^[a-f0-9]{48}$/);
  assert.match(m1.h.get('set-cookie') || '', /^tinue_token=[a-f0-9]{48};/);
  const m2 = await send('/api/move', { method: 'POST', body: vis({ ms: 99 }), headers: plain }); // the answer above was "lost"
  assert.equal(m2.text, m1.text);
  assert.equal(d2.prepare('SELECT COUNT(*) c FROM users').get().c, users0 + 1, 'exactly one guest');
  const gauth = { authorization: 'Bearer ' + b1.token };
  const me = JSON.parse((await send('/api/me', { headers: gauth })).text);
  assert.equal(me.user.name, null);
  const gg = await send('/api/attempt', { headers: { ...gauth, [NH]: 'decide-http-00001' } });
  assert.equal(gg.status, 200); assert.equal(JSON.parse(gg.text).mode, 'decide');
  // The same 10/h/IP guest window as /api/result: 9 more new visitors, then refused.
  for (let k = 2; k <= 10; k++) assert.equal((await send('/api/move', { method: 'POST', body: ply({ nonce: 'decide-http-' + String(k).padStart(5, '0') }), headers: plain })).status, 200);
  const over = await send('/api/move', { method: 'POST', body: ply({ nonce: 'decide-http-00011' }), headers: plain });
  assert.equal(over.status, 429);
  assert.equal(d2.prepare('SELECT COUNT(*) c FROM users').get().c, users0 + 10);
  assert.equal(d2.prepare("SELECT COUNT(*) c FROM attempt WHERE mode = 'decide' AND rated = 0").get().c, 10);
  assert.equal(d2.prepare('SELECT COUNT(*) c FROM attempts').get().c + d2.prepare('SELECT COUNT(*) c FROM rating_event').get().c, 0, 'nothing rated');
  await stop(s);
  d2.close();
  const log2 = fs.readFileSync(LOG, 'utf8');
  for (const text of [log2, s.out(), s.err()]) {
    assert.ok(!/decide-http-\d/.test(text), 'a nonce was logged');
    assert.ok(!text.includes(b1.token), 'a token was logged');
  }
  assert.ok(!s.err().includes('TINUE_JUDGE'), "'Decide' is decide, no warning");
  console.log('ok server: off -> POST /api/move and GET /api/attempt answer 404 {"error":"unknown route"} like any unknown route, body unread, no table, today\'s CORS and log line; shadow over text/plain; 413/400; GET nonce in a header only; no token, IP or nonce logged; decide: lost-token retry -> one guest, same token; guest window shared');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nOK: move tests (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
