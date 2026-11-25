// The in-memory picker (server/pool.js) against the SQL query it replaced (pickFrom's at d483a29, kept here only), on
// one database and the same random draws: every GET /api/next goes through the real handler twice, once with each
// ranking, and must give the same candidate lists (ids, order, scores to the bit) and the same answer, byte for byte.
// Between requests the state moves: rated results through the handler (this connection), and writes from another
// connection the way an import, a rerate or a hand fix would (ratings, deviations, flags, grades, themes, new and
// deleted rows, an rd of exactly 110, a VACUUM that renumbers rowids).
//   node --no-warnings scripts/test-picker-equiv.mjs              a synthetic database (in npm test)
//   node --no-warnings scripts/test-picker-equiv.mjs DB [steps] [users]   a copy of DB (never DB itself)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { UNSETTLED_SQL } from '../shared/rating.js';
import { THEMES } from '../shared/themes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [src, stepsArg, usersArg] = process.argv.slice(2);
const STEPS = +(stepsArg || (src ? 4000 : 1500)), USERS = +(usersArg || (src ? 2000 : 300));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-equiv-'));
const DB = path.join(dir, 'e.db');
let seed = 20261117; const R = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pickOf = (a) => a[Math.floor(R() * a.length)];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const t0 = performance.now();

if (src) { const s = new DatabaseSync(src, { readOnly: true }); s.exec(`VACUUM INTO '${DB.replace(/'/g, "''")}'`); s.close(); }
Object.assign(process.env, { TINUE_DB: DB, TINUE_SYNTAKS: '/nonexistent', TINUE_ACCESS_LOG: path.join(dir, 'access.log') });
const { api, pool, db } = await import('../server/server.js');
process.removeAllListeners('uncaughtException'); process.removeAllListeners('unhandledRejection'); // the server's keep-alive handlers would swallow a failure
const w = new DatabaseSync(DB); // "another connection": an import, a script, a hand fix
w.exec('PRAGMA busy_timeout = 5000');

// The old ranking, verbatim but for its inputs (pool.top's): the constants are read from server.js, so a change there
// is compared, not assumed.
const srcText = fs.readFileSync(path.join(ROOT, 'server/server.js'), 'utf8');
const K = Object.fromEntries(['UNSCORED', 'CONVERT', 'FLAW', 'REFUNDED', 'PLAYED'].map((n) => [n, +new RegExp(`\\b${n} = (\\d+)`).exec(srcText)[1]]));
const SERVED = "(turn = 1 OR grade = 'A')";
function oldTop({ target, servedOnly, theme, size, player, exclude }, limit) {
  const where = servedOnly ? [SERVED] : [], params = [];
  if (theme) { where.push("(',' || themes || ',') LIKE ?"); params.push(`%,${theme},%`); }
  if (size) { where.push('size = ?'); params.push(size); }
  if (player !== undefined) { where.push('id NOT IN (SELECT puzzle_id FROM attempts WHERE user_id = ?)'); params.push(player); }
  if (exclude?.length) { where.push(`id NOT IN (${exclude.map(() => '?').join(',')})`); params.push(...exclude); }
  const wh = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`SELECT *, ABS(rating - ?) + CASE WHEN ${SERVED} THEN 0 WHEN turn = 0 THEN ${K.CONVERT} ELSE ${K.UNSCORED} END + CASE WHEN flaw = 2 THEN ${K.REFUNDED} WHEN flaw THEN ${K.FLAW} ELSE 0 END
      - CASE WHEN attempts > 0 AND ${UNSETTLED_SQL} AND COALESCE(flaw, 0) <> 2 THEN ${K.PLAYED} ELSE 0 END AS score
    FROM puzzles ${wh} ORDER BY score LIMIT ${limit}`).all(target, ...params);
}
const newTop = pool.top;

// A synthetic pool: every size, tier, flaw and theme mix, ratings on a 10-point grid (many exact ties) or not.
const TH = Object.keys(THEMES).filter((t) => !/^s\d$/.test(t));
const TPS = 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14';
const insP = w.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, attempts, turn, flaw, grade)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
let made = 0;
function newPuzzle(id = 'z' + made++) {
  const size = pickOf([4, 5, 5, 6, 6, 6, 7, 8]), r = R() < 0.5 ? 600 + 10 * Math.floor(R() * 230) : 600 + R() * 2300;
  const themes = [`s${size}`, ...TH.filter(() => R() < 0.15)].join(',');
  const rd = pickOf([250, 250, 110, 109.99, 80, 60 + R() * 200]), attempts = R() < 0.6 ? 0 : 1 + Math.floor(R() * 20);
  insP.run(id, size, TPS, 1, '{"b1":"win"}', themes, 'test', r, r, rd, attempts, pickOf([1, 1, 0, 0, null]), pickOf([null, null, null, 0, 1, 2]), pickOf([null, 'A', 'B', 'C']));
  return id;
}
if (!src) { w.exec('BEGIN'); for (let i = 0; i < 3000; i++) newPuzzle(); w.exec('COMMIT'); }

// Users: guests and accounts, provisional and settled, with histories from none to thousands, each played near its
// rating; one has played every 8x8 puzzle (so its 8x8 picks fall back to repeats).
const ids = () => w.prepare('SELECT id, rating, size FROM puzzles').all();
const users = [];
{
  const all = ids();
  const insU = w.prepare('INSERT INTO users (name, token_hash, rating, rd, vol, games, wins, created_at) VALUES (?,?,?,?,?,?,?,?)');
  const insA = w.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts) VALUES (?,?,?,?,?,?,?,?)');
  w.exec('BEGIN');
  for (let i = 0; i < USERS; i++) {
    const hist = i === 0 ? 0 : R() < 0.02 ? 1000 + Math.floor(R() * 4000) : R() < 0.2 ? Math.floor(R() * 300) : Math.floor(R() * 20);
    const rating = 700 + R() * 1900, rd = hist < 10 ? pickOf([500, 300, 200, 110]) : pickOf([109.9, 90, 70, 110]);
    const token = crypto.randomBytes(24).toString('hex');
    const id = Number(insU.run(R() < 0.6 ? `eq${i}` : null, sha(token), rating, rd, 0.06, hist, 0, 1).lastInsertRowid);
    const mine = i === 1 ? all.filter((p) => p.size === 8) : all.map((p) => [Math.abs(p.rating - rating) + R() * 200, p]).sort((a, b) => a[0] - b[0]).slice(0, hist).map((x) => x[1]);
    for (const p of mine) insA.run(id, p.id, R() < 0.5 ? 1 : 0, 1, rating, p.rating, 0, 1);
    users.push({ id, token, played: mine.map((p) => p.id) });
  }
  w.exec('COMMIT');
}

// The handler, called in-process with a fake request and response.
async function call(method, pathq, { token, body, ip = '10.0.0.1' } = {}) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  Object.assign(req, { method, url: pathq, headers: { host: 'x', 'x-forwarded-for': ip, ...(token ? { authorization: 'Bearer ' + token } : {}) }, socket: { remoteAddress: '127.0.0.1' } });
  let out;
  const res = { setHeader() {}, on() {}, writableEnded: false, writeHead(code) { this.statusCode = code; return this; }, end(s) { out = { status: this.statusCode, text: String(s) }; this.writableEnded = true; } };
  await api(req, res, new URL(pathq, 'http://x'));
  return out;
}
const daily = JSON.parse((await call('GET', '/api/daily')).text).puzzle?.id;

// One request, both ways, the same draws.
const realRandom = Math.random;
const prng = (s) => () => { s = (s * 1664525 + 1013904223) % 2 ** 32; return s / 2 ** 32; };
let calls = 0, ties = 0, picks = 0;
async function both(pathq, opt, step) {
  const run = async (top) => {
    const rec = [];
    pool.top = (o, limit) => { const r = top(o, limit); rec.push(r.map((x) => [x.id, x.score])); return r; };
    Math.random = prng(step);
    try { return { ...(await call('GET', pathq, opt)), rec }; } finally { pool.top = newTop; Math.random = realRandom; }
  };
  const a = await run(oldTop), b = await run(newTop);
  calls += a.rec.length;
  for (const r of a.rec) for (let i = 1; i < r.length; i++) if (r[i][1] === r[i - 1][1]) { ties++; break; }
  assert.deepEqual(b.rec, a.rec, `candidates differ: ${pathq}`);
  assert.equal(b.status, a.status, pathq);
  assert.equal(b.text, a.text, `answer differs: ${pathq}`);
  return JSON.parse(a.text);
}

// What a client might send.
const THEME_ASKS = [...TH, 'fork', 'FORK', 'Tinuein2', 's6', '%', 'road_n1', '_', 'fo%', 'nope', ''];
let lastIds = [];
function query(u) {
  const q = new URLSearchParams();
  if (R() < 0.8) q.set('difficulty', pickOf(['normal', 'normal', 'easiest', 'easier', 'harder', 'hardest', 'bogus']));
  if (R() < 0.85) q.set('size', String(pickOf([6, 6, 6, 5, 5, 4, 7, 8, 9, 'x'])));
  if (R() < 0.25) q.set('theme', pickOf(THEME_ASKS));
  if (!u || R() < 0.1) q.set('rating', String(pickOf([Math.round(R() * 3500), 1500, -50, 4000, 'abc'])));
  if (R() < 0.3) q.set('exclude', [...lastIds.filter(() => R() < 0.7), ...(u?.played || []).filter(() => R() < 0.05)].slice(0, 30).join(','));
  const k = R();
  if (k < 0.12) q.set('n', String(pickOf([2, 10, 10, 20, 99])));
  else if (k < 0.35) q.set('for', pickOf([...lastIds, ...(u?.played.slice(0, 3) || []), daily, 'nope'].filter(Boolean)));
  return q;
}

// External writes, as an import or a fix would make them.
function external() {
  const all = ids(), some = () => pickOf(all).id;
  const k = R();
  if (k < 0.3) w.prepare('UPDATE puzzles SET rating = ?, rd = ?, attempts = attempts + 1 WHERE id = ?').run(600 + R() * 2300, pickOf([110, 109, 200, 70]), some());
  else if (k < 0.45) w.prepare('UPDATE puzzles SET flaw = ? WHERE id = ?').run(pickOf([null, 1, 2]), some());
  else if (k < 0.55) w.prepare('UPDATE puzzles SET grade = ?, turn = ? WHERE id = ?').run(pickOf(['A', 'B', null]), pickOf([1, 0, null]), some());
  else if (k < 0.65) w.prepare('UPDATE puzzles SET themes = ? WHERE id = ?').run(pickOf(['s6,fork', 's5,roadIn1', 's6,FORK', '']), some());
  else if (k < 0.85) { w.exec('BEGIN'); for (let i = 0; i < 5; i++) newPuzzle(); w.exec('COMMIT'); }
  else if (k < 0.97) w.prepare('DELETE FROM puzzles WHERE id = ?').run(some());
  else w.exec('VACUUM');
}

let results = 0, rated = 0, ext = 0;
for (let step = 0; step < STEPS; step++) {
  const u = R() < 0.25 ? null : pickOf(users);
  const q = query(u);
  const got = await both('/api/next?' + q, { token: u?.token, ip: `10.1.${step & 255}.${(step >> 8) & 255}` }, step);
  const ps = got.puzzles || (got.puzzle ? [got.puzzle] : [got.win, got.loss].filter(Boolean));
  picks += ps.length;
  if (ps.length) lastIds = ps.map((p) => p.id);
  // a result for one of them (through the handler: rated results move the pool)
  if (ps.length && R() < 0.4) {
    const p = pickOf(ps), who = u ?? null;
    const r = await call('POST', '/api/result', { token: who?.token, body: { puzzleId: p.id, win: R() < 0.5, ...(R() < 0.1 ? { casual: true } : {}) }, ip: `10.2.${step & 255}.${step >> 8}` });
    results++;
    if (JSON.parse(r.text).rated) rated++;
    if (who && r.status === 200) who.played.push(p.id);
  }
  if (R() < 0.08) { external(); ext++; }
  if (step % 500 === 499) console.log(`  ${step + 1} steps, ${calls} rankings compared (${((performance.now() - t0) / 1e3).toFixed(0)} s)`);
}
console.log(`ok picker equivalence: ${STEPS} requests over ${USERS} users (${src ? 'copy of ' + path.basename(src) : 'synthetic'}), ${calls} rankings (${ties} with tied scores) and ${picks} picks identical; ${results} results (${rated} rated), ${ext} external writes`);
db.close(); w.close();
fs.rmSync(dir, { recursive: true, force: true });
