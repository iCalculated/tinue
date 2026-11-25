// Puzzle status decides serving (PLAN P2, Q11): the picker's served pool, its fallback stage and the daily tiers read
// status/kind (server/puzzle-state.js) instead of turn/grade. On a mixed fixture (every size, kind, grade, flaw and
// band; backfilled rows, rows the backfill hasn't reached, holds, D rows backfilled before Q11) the served id set, the
// fallback set and every daily tier's membership equal what the predicates before P2 (kept here verbatim) select,
// minus the paused and rejected rows (Q11: grade D is never served). In-process, a throwaway database in a temp dir.   node --no-warnings scripts/test-pstate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { rate } from '../shared/rating.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-pstate-'));
const DB = path.join(dir, 's.db');
Object.assign(process.env, { TINUE_DB: DB, TINUE_SYNTAKS: '/nonexistent', TINUE_ACCESS_LOG: path.join(dir, 'access.log') });
const { api, pool, db, DAILY_TIERS } = await import('../server/server.js');
const { backfillPuzzleState, statusOf, kindOf, served, pickable, STATUS_SQL, KIND_SQL, PICKABLE_SQL } = await import('../server/puzzle-state.js');
process.removeAllListeners('uncaughtException'); process.removeAllListeners('unhandledRejection');
const w = new DatabaseSync(DB); // another connection, as an import would be
w.exec('PRAGMA busy_timeout = 5000');

// The fixture: every combination, three ratings (below, in and above the daily band).
const TPS = 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14';
const ins = w.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, attempts, turn, flaw, grade, swing)
  VALUES (?,?,?,1,'{"b1":"win"}',?,'test',?,?,250,0,?,?,?,?)`);
const ids = [];
w.exec('BEGIN');
for (const size of [4, 5, 6, 7]) for (const turn of [1, 0, null]) for (const grade of ['A', 'B', 'C', 'D', null])
  for (const flaw of [null, 0, 1, 2]) for (const rating of [1500, 2200, 2600]) {
    const id = `ps${ids.length + 1}`;
    ins.run(id, size, TPS, `s${size},fork`, rating, rating, turn, flaw, grade, turn == null ? null : JSON.stringify({ pre0: 0.2 }));
    ids.push(id);
  }
w.exec('COMMIT');
// Holds (hold-YYYYMMDD overrides): D conversions as in production, plus a D turning point and a B one.
const held = new Set(w.prepare(`SELECT id FROM puzzles WHERE (grade = 'D' AND rowid % 17 = 0) OR (grade = 'B' AND turn = 0 AND rowid % 23 = 0)`).all().map((r) => r.id));
backfillPuzzleState(w, { held, pause: 0 });
// Rows the backfill hasn't reached (status/kind NULL): every 7th.
w.exec('UPDATE puzzles SET status = NULL, kind = NULL WHERE rowid % 7 = 0');
// Signed-in players' attempts (the daily's UNPLAYED), and a guest's (doesn't count there).
w.exec(`INSERT INTO users (name, token_hash, created_at) VALUES ('ann', 'h1', 1); INSERT INTO users (name, token_hash, created_at) VALUES (NULL, 'h2', 1);
  INSERT INTO attempts (user_id, puzzle_id, win, rated, ts) SELECT 1, id, 1, 1, 1 FROM puzzles WHERE rowid % 5 = 0;
  INSERT INTO attempts (user_id, puzzle_id, win, rated, ts) SELECT 2, id, 1, 1, 1 FROM puzzles WHERE rowid % 3 = 0;`);
const rows = w.prepare('SELECT * FROM puzzles').all();
const set = (a) => new Set(a);
const sorted = (s) => [...s].sort();
const sqlIds = (where) => set(w.prepare(`SELECT id FROM puzzles WHERE ${where}`).all().map((r) => r.id));

// JS and SQL forms agree on every row.
const sqlState = new Map(w.prepare(`SELECT id, ${STATUS_SQL} s, ${KIND_SQL} k FROM puzzles`).all().map((r) => [r.id, r]));
for (const r of rows) {
  assert.equal(sqlState.get(r.id).s, statusOf(r), r.id);
  assert.equal(sqlState.get(r.id).k, kindOf(r), r.id);
}
assert.ok(rows.some((r) => r.status == null) && rows.some((r) => r.status === 'paused'));
console.log(`ok status/kind: the JS and SQL forms agree on ${rows.length} rows (${rows.filter((r) => r.status == null).length} not yet backfilled)`);

// Before P2 (e076797), verbatim.
const OLD_SERVED = (r) => r.turn === 1 || r.grade === 'A';
const BAND = 'size = 6 AND rating BETWEEN 2000 AND 2400', UNPLAYED = 'id NOT IN (SELECT puzzle_id FROM attempts JOIN users ON users.id = user_id WHERE name IS NOT NULL)';
const NOT_REFUNDED = 'COALESCE(flaw, 0) <> 2';
const OLD_TIERS = [
  `turn = 1 AND NOT COALESCE(flaw, 0) AND ${BAND} AND ${UNPLAYED}`,
  `turn = 1 AND ${NOT_REFUNDED} AND ${BAND} AND ${UNPLAYED}`,
  `turn = 1 AND ${NOT_REFUNDED} AND ${BAND}`,
  `turn IS NOT NULL AND ${NOT_REFUNDED} AND ${BAND}`,
  'size = 6 AND rating >= 2000',
  'size = 6',
  '1',
];
// Rows no picker may return (Q11): grade D ('rejected', or 'paused' when held) and every hold. Some D rows still say
// 'served'/'reserve' (the backfill before Q11 wrote them): the server goes by the grade until the backfill runs again.
w.exec("UPDATE puzzles SET status = CASE WHEN turn = 1 THEN 'served' ELSE 'reserve' END WHERE grade = 'D' AND rowid % 4 = 1 AND status IS NOT NULL");
const never = set(w.prepare('SELECT * FROM puzzles').all().filter((r) => !pickable(r)).map((r) => r.id));
assert.deepEqual(sorted(never), sorted(set(rows.filter((r) => r.grade === 'D' || (held.has(r.id) && r.status != null && !OLD_SERVED(r))).map((r) => r.id))));
assert.deepEqual(sorted(sqlIds(`NOT ${PICKABLE_SQL}`)), sorted(never));
for (const r of w.prepare(`SELECT *, ${STATUS_SQL} sq FROM puzzles`).all()) {
  assert.equal(r.sq, statusOf(r), r.id);
  if (r.grade === 'D') assert.ok(['paused', 'rejected'].includes(statusOf(r)), r.id);
}
const minus = (s) => set([...s].filter((id) => !never.has(id)));

const oldServed = set(rows.filter(OLD_SERVED).map((r) => r.id));
assert.deepEqual(sorted(set(rows.filter(served).map((r) => r.id))), sorted(minus(oldServed)));
const top = (servedOnly) => set(pool.top({ target: 1500, servedOnly }, rows.length + 10).map((r) => r.id));
assert.deepEqual(sorted(top(true)), sorted(minus(oldServed)), 'served stage');
assert.deepEqual(sorted(top(false)), sorted(minus(set(ids))), 'fallback stage');
console.log(`ok picker: the served stage's set (${top(true).size}) and the fallback's (${top(false).size}) are the old ones minus the ${never.size} paused/rejected`);

assert.equal(DAILY_TIERS.length, OLD_TIERS.length);
const sizes = [];
for (let i = 0; i < OLD_TIERS.length; i++) {
  const a = minus(sqlIds(OLD_TIERS[i])), b = sqlIds(DAILY_TIERS[i]);
  assert.deepEqual(sorted(b), sorted(a), `daily tier ${i + 1}`);
  sizes.push(b.size);
}
console.log(`ok daily: every tier's membership is the old one minus paused/rejected, last resorts included (${sizes.join(' / ')})`);

// ---- Through the API (in-process: the handler with a fake request and response).
let ipn = 0;
async function call(method, pathq, { token, body } = {}) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  Object.assign(req, { method, url: pathq, headers: { host: 'x', 'x-forwarded-for': `10.9.${ipn >> 8 & 255}.${ipn++ & 255}`, ...(token ? { authorization: 'Bearer ' + token } : {}) }, socket: { remoteAddress: '127.0.0.1' } });
  let out;
  const res = { setHeader() {}, on() {}, writableEnded: false, writeHead(code) { this.statusCode = code; return this; }, end(s) { out = { status: this.statusCode, body: JSON.parse(String(s)) }; this.writableEnded = true; } };
  await api(req, res, new URL(pathq, 'http://x'));
  return out;
}
// 8x8: smash only on a rejected (D) and a paused puzzle, throw on a servable one.
{
  const ins8 = w.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, turn, grade, status)
    VALUES (?,8,'x8/x8/x8/x8/x8/x8/x8/x8 1 1',1,'{"a1":"win"}',?,'test',1500,1500,250,?,?,?)`);
  ins8.run('q8d', 's8,smash', 1, 'D', 'served'); // backfilled before Q11: still says served
  ins8.run('q8p', 's8,smash', 0, 'B', 'paused');
  ins8.run('q8ok', 's8,throw', null, null, null);
}
const th8 = (await call('GET', '/api/themes?size=8')).body;
assert.equal(th8.total, 1); assert.deepEqual(th8.themes, { s8: 1, throw: 1 }); assert.equal(th8.sizes['8'], 1);
const thAll = (await call('GET', '/api/themes')).body;
const pickableN = w.prepare(`SELECT COUNT(*) n FROM puzzles WHERE ${PICKABLE_SQL}`).get().n;
assert.equal(thAll.total, pickableN); assert.equal(Object.values(thAll.sizes).reduce((a, b) => a + b, 0), pickableN);
assert.equal(thAll.themes.fork, w.prepare(`SELECT COUNT(*) n FROM puzzles WHERE themes LIKE '%fork%' AND ${PICKABLE_SQL}`).get().n);
// another connection's write (a hand fix) shows at once, and is gone with it
for (const [status, n] of [['reserve', 1], ['paused', undefined]]) {
  w.prepare("UPDATE puzzles SET status = ? WHERE id = 'q8p'").run(status);
  assert.equal((await call('GET', '/api/themes?size=8')).body.themes.smash, n, status);
}
console.log('ok themes: paused/rejected puzzles are not counted (8x8 smash, only on those, is not offered)');
// A filter with nothing servable: the same empty answers as any filter that matches nothing (the client's "No puzzles
// match"), for one, a batch and a pair.
for (let i = 0; i < 30; i++) assert.equal((await call('GET', '/api/next?size=8&rating=' + 100 * i)).body.puzzle.id, 'q8ok');
assert.deepEqual((await call('GET', '/api/next?size=8&theme=smash')).body, { puzzle: null });
assert.deepEqual((await call('GET', '/api/next?size=8&theme=nosuchtheme')).body, { puzzle: null }); // (as before Q11)
assert.deepEqual((await call('GET', '/api/next?size=8&theme=smash&n=5')).body, { rating: 1500, puzzles: [] });
assert.deepEqual((await call('GET', '/api/next?size=8&theme=smash&for=q8ok')).body, { win: null, loss: null });
assert.deepEqual((await call('GET', '/api/next?size=8&n=5')).body.puzzles.map((p) => p.id), ['q8ok']);
console.log('ok next: a filter that only paused/rejected puzzles match answers "no puzzle", as any empty filter does');
// Daily: today's pick is never paused/rejected.
const day = (await call('GET', '/api/daily')).body.puzzle;
assert.ok(pickable(w.prepare('SELECT * FROM puzzles WHERE id = ?').get(day.id)), day.id);
assert.equal((await call('GET', '/api/group?names=ann')).body.puzzle.id, day.id);
console.log('ok daily: a servable puzzle');

// P3 / V8: a result on a paused or rejected puzzle is recorded, unrated, unrated_why = its status, and moves nothing.
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const tok = 'ab'.repeat(24);
w.prepare("INSERT INTO users (name, token_hash, rating, rd, vol, games, wins, created_at) VALUES ('bob', ?, 1600, 90, 0.06, 40, 20, 1)").run(sha(tok));
const bob = () => ({ ...w.prepare("SELECT id, rating, rd, vol, games, wins FROM users WHERE name = 'bob'").get() });
const pz = (id) => ({ ...w.prepare('SELECT rating, rd, vol, attempts, solves FROM puzzles WHERE id = ?').get(id) });
const ledger = (uid, id) => ({ ...w.prepare('SELECT a.rated, a.unrated_why, a.result, e.weight, e.user_before = e.user_after su, e.puzzle_before = e.puzzle_after sp FROM attempt a JOIN rating_event e ON e.attempt_id = a.id WHERE a.user_id = ? AND a.puzzle_id = ?').get(uid, id) });
for (const [id, win, why] of [['q8d', true, 'rejected'], ['q8p', false, 'paused']]) {
  const u0 = bob(), p0 = pz(id);
  const r = await call('POST', '/api/result', { token: tok, body: { puzzleId: id, win, theme: 'smash' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.rated, false); assert.equal(r.body.userDelta, 0); assert.equal(r.body.puzzleRating, Math.round(p0.rating));
  assert.deepEqual(bob(), u0, id); assert.deepEqual(pz(id), p0, id);
  assert.deepEqual({ ...w.prepare('SELECT win, rated, user_delta FROM attempts WHERE user_id = ? AND puzzle_id = ?').get(u0.id, id) }, { win: win ? 1 : 0, rated: 0, user_delta: 0 });
  assert.deepEqual(ledger(u0.id, id), { rated: 0, unrated_why: why, result: win ? 1 : 0, weight: 0, su: 1, sp: 1 });
}
{ // a first-time visitor's result on one: a guest is made (as for any first result), unrated
  const p0 = pz('q8d');
  const r = await call('POST', '/api/result', { body: { puzzleId: 'q8d', win: false } });
  assert.equal(r.body.rated, false); assert.ok(r.body.token); assert.equal(r.body.user.games, 0); assert.deepEqual(pz('q8d'), p0);
  assert.equal(ledger(r.body.user.id, 'q8d').unrated_why, 'rejected');
}
{ // control: a servable puzzle is rated, with no unrated_why
  const r = await call('POST', '/api/result', { token: tok, body: { puzzleId: 'q8ok', win: true } });
  assert.equal(r.body.rated, true); assert.equal(bob().games, 41);
  assert.equal(ledger(bob().id, 'q8ok').unrated_why, null);
}
console.log('ok result: paused/rejected puzzles are recorded unrated (unrated_why = status), no rating moves; others rated');
// Today's daily, made before its puzzle was rejected, stays today's (reachable by /api/daily, /api/group, its id), and
// results on it are unrated like any rejected puzzle's. Tomorrow's pick passes over it.
{
  w.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, turn, grade, status)
    VALUES ('q6d', 6, ?, 1, '{"b1":"win"}', 's6', 'test', 2200, 2200, 250, 1, 'D', 'served')`).run(TPS);
  w.prepare('UPDATE daily SET puzzle_id = ? WHERE puzzle_id = ?').run('q6d', day.id);
  assert.equal((await call('GET', '/api/daily')).body.puzzle.id, 'q6d');
  assert.equal((await call('GET', '/api/group?names=bob')).body.puzzle.id, 'q6d');
  assert.equal((await call('GET', '/api/puzzle/q6d')).body.puzzle.id, 'q6d');
  const u0 = bob(), r = await call('POST', '/api/result', { token: tok, body: { puzzleId: 'q6d', win: false } });
  assert.equal(r.body.rated, false); assert.deepEqual(bob(), u0);
  assert.equal(ledger(u0.id, 'q6d').unrated_why, 'rejected');
}
console.log("ok daily: today's puzzle stays today's after it is rejected; its results are unrated");

// V20: the theme weight applies only when the theme sent is one of the puzzle's own; any other valid theme (or none)
// is the normal weight, for player and puzzle alike.
{
  const ins = w.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, turn)
    VALUES (?, 8, 'x8/x8/x8/x8/x8/x8/x8/x8 1 1', 1, '{"a1":"win"}', 's8,throw', 'test', 1700, 1700, 200, 1)`);
  for (const [id, theme, win, weight] of [['v1', 'fork', true, 1], ['v2', 'smash', false, 1], ['v3', 'throw', true, 0.1], ['v4', 'throw', false, 0.7], ['v5', undefined, true, 1]]) {
    ins.run(id);
    const u0 = w.prepare("SELECT rating, rd, vol FROM users WHERE name = 'bob'").get(), p0 = w.prepare('SELECT rating, rd, vol FROM puzzles WHERE id = ?').get(id);
    const r = await call('POST', '/api/result', { token: tok, body: { puzzleId: id, win, theme } });
    const want = rate(u0, p0, win, weight);
    assert.equal(r.body.rated, true, id);
    assert.ok(Math.abs(r.body.userDelta - want.userDelta) < 1e-9, `${id} ${theme}: ${r.body.userDelta} vs ${want.userDelta}`);
    assert.ok(Math.abs(w.prepare('SELECT rating FROM puzzles WHERE id = ?').get(id).rating - want.puzzle.rating) < 1e-9, id);
    const e = w.prepare('SELECT a.theme, e.weight FROM attempt a JOIN rating_event e ON e.attempt_id = a.id WHERE a.puzzle_id = ?').get(id);
    assert.deepEqual({ ...e }, { theme: weight === 1 ? null : theme, weight }, id);
  }
}
console.log("ok theme weight: only for the puzzle's own themes (fork/smash on a throw puzzle count fully; throw counts 0.1/0.7)");

// P3 for a legacy guest's replay: a browser from before 2026-11-15 whose guest_attempts include a rejected or paused
// puzzle gets those rows as unrated attempts when its users row is made (newGuest); the rest replay rated as before.
{
  const ins = w.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, turn, grade, status)
    VALUES (?, 8, 'x8/x8/x8/x8/x8/x8/x8/x8 1 1', 1, '{"a1":"win"}', 's8', 'test', 1500, 1500, 250, 1, ?, ?)`);
  ins.run('g8d', 'D', 'served'); ins.run('g8p', 'A', 'paused'); ins.run('g8a', 'A', 'served'); ins.run('g8b', 'B', null);
  const gid = 'c'.repeat(32), ga = w.prepare('INSERT INTO guest_attempts (gid, puzzle_id, win, hinted, puzzle_rating, ts) VALUES (?,?,?,?,?,?)');
  ga.run(gid, 'g8d', 1, 0, 1500, 1); ga.run(gid, 'g8p', 1, 0, 1500, 2); ga.run(gid, 'g8a', 1, 0, 1500, 3);
  const p0 = pz('g8d');
  const r = await call('POST', '/api/result', { body: { puzzleId: 'g8b', win: true, guest: { gid } } });
  const got = Object.fromEntries(w.prepare('SELECT puzzle_id, rated, user_delta FROM attempts WHERE user_id = ?').all(r.body.user.id).map((a) => [a.puzzle_id, [a.rated, a.user_delta === 0]]));
  assert.deepEqual(got, { g8d: [0, true], g8p: [0, true], g8a: [1, false], g8b: [1, false] });
  assert.equal(r.body.user.games, 2); assert.deepEqual(pz('g8d'), p0);
}
console.log("ok guest replay: a legacy guest's results on paused/rejected puzzles become unrated attempts");

db.close(); w.close();
fs.rmSync(dir, { recursive: true, force: true });
