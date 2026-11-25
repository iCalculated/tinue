// API smoke test: boots server/server.js on a throwaway database in a temp dir (never data/tinue.db) and plays
// through register, results, guests, the daily puzzle and the bot API.   node scripts/test-server.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';
import { rate, PLAYER_START, replayGuest, GUEST_PUZZLE_WEIGHT, provisional, settled, UNSETTLED_SQL } from '../shared/rating.js';
import { PROVISIONAL_RD, RD_MIN } from '../shared/glicko.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-test-'));
const DB = path.join(dir, 't.db'), { PORT, base, env, boot: bootOn, stop } = testServer(dir);
const boot = (db = DB, extra = {}) => bootOn(db, extra);

// Boot once to create the schema, then add puzzles: 6x6 around 1500 and a hard band for the daily puzzle.

// One RD comparison: the "?" (provisional), the picker's JS test (settled) and its SQL test (UNSETTLED_SQL) agree on
// every rd, and match the two comparisons they replaced (provisional: rd >= 110; picker: rd > 110) everywhere except
// at exactly 110.0, where those two disagreed (the picker now follows the "?"). Puzzles start at 250 and move by
// Glicko arithmetic, so an rd of exactly 110.0 does not occur in practice (none in data/tinue.db).
{
  const m = new DatabaseSync(':memory:');
  m.exec('CREATE TABLE t (rd REAL)');
  const near = [PROVISIONAL_RD, PROVISIONAL_RD + 1e-9, PROVISIONAL_RD - 1e-9, PROVISIONAL_RD + 1e-12];
  let seed = 11; const R = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const rds = [...near, RD_MIN, 500, 250, 109, 111, ...Array.from({ length: 2000 }, () => RD_MIN + R() * (500 - RD_MIN))];
  const ins = m.prepare('INSERT INTO t VALUES (?)');
  for (const rd of rds) ins.run(rd);
  for (const { rd, u } of m.prepare(`SELECT rd, (${UNSETTLED_SQL}) u FROM t`).all()) {
    assert.equal(!!u, !settled({ rd }), 'SQL vs JS at ' + rd);
    assert.equal(!settled({ rd }), provisional({ rd }), 'settled vs provisional at ' + rd);
    if (rd !== PROVISIONAL_RD) assert.equal(!settled({ rd }), rd > PROVISIONAL_RD, 'old picker test at ' + rd);
  }
  assert.equal(settled({ rd: PROVISIONAL_RD }), false); // the one changed point: provisional, so not settled
  m.close();
  console.log('ok rd: one settled test for the "?" and the picker, in JS and SQL');
}

// Migration: a database from before guests were users (name NOT NULL, no gid) keeps its users, ids and attempts.
{
  const OLD = path.join(dir, 'old.db'), o = new DatabaseSync(OLD);
  o.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, token_hash TEXT NOT NULL,
      rating REAL NOT NULL DEFAULT 1500, rd REAL NOT NULL DEFAULT 500, vol REAL NOT NULL DEFAULT 0.06, games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES (7, 'Bob', 'h7', 1720, 80, 0.06, 40, 25, 1);
    CREATE TABLE attempts (user_id INTEGER NOT NULL, puzzle_id TEXT NOT NULL, win INTEGER NOT NULL, rated INTEGER NOT NULL,
      user_rating REAL, puzzle_rating REAL, user_delta REAL, ts INTEGER NOT NULL);
    INSERT INTO attempts VALUES (7, 'x1', 1, 1, 1700, 1650, 20, 5);`);
  o.close();
  await stop(await boot(OLD));
  const m = new DatabaseSync(OLD, { readOnly: true });
  const cols = m.prepare('PRAGMA table_info(users)').all();
  assert.equal(cols.find((c) => c.name === 'name').notnull, 0);
  assert.ok(cols.some((c) => c.name === 'gid'));
  assert.deepEqual({ ...m.prepare('SELECT id, name, rating, games, wins FROM users').get() }, { id: 7, name: 'Bob', rating: 1720, games: 40, wins: 25 });
  assert.equal(m.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id = 7').get().n, 1);
  m.close();
  console.log('ok migration: users rebuilt with optional name + gid, data kept');
}

// votes (no API since 2026-11-07): an empty table is dropped at startup, one with rows is kept; a new DB has none.
{
  const hasVotes = (f) => { const d = new DatabaseSync(f, { readOnly: true }); const v = !!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'votes'").get(); d.close(); return v; };
  for (const [name, rows, kept] of [['votes-empty.db', 0, false], ['votes-rows.db', 1, true]]) {
    const f = path.join(dir, name), o = new DatabaseSync(f);
    o.exec('CREATE TABLE votes (user_id INTEGER NOT NULL, puzzle_id TEXT NOT NULL, vote INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (user_id, puzzle_id))');
    if (rows) o.exec("INSERT INTO votes VALUES (1, 'x1', 1, 5)");
    o.close();
    await stop(await boot(f));
    assert.equal(hasVotes(f), kept, name);
  }
  const f = path.join(dir, 'votes-new.db');
  await stop(await boot(f));
  assert.equal(hasVotes(f), false);
  console.log('ok votes: an empty table is dropped, one with rows kept, none created');
}

// WAL housekeeping: a WAL another process grew (an import) is emptied by the next periodic checkpoint.
{
  const W = path.join(dir, 'wal.db'), wal = () => fs.statSync(W + '-wal', { throwIfNoEntry: false })?.size ?? 0;
  const s = await boot(W, { TINUE_CHECKPOINT_MS: '100' });
  const w = new DatabaseSync(W);
  w.exec('CREATE TABLE junk (b BLOB); BEGIN');
  const ins = w.prepare('INSERT INTO junk VALUES (randomblob(4000))');
  for (let i = 0; i < 3000; i++) ins.run();
  w.exec('COMMIT'); w.close();
  const grown = wal();
  let left = grown;
  for (let i = 0; i < 50 && left; i++) { await new Promise((r) => setTimeout(r, 50)); left = wal(); }
  await stop(s);
  assert.ok(grown > 8e6, String(grown)); assert.equal(left, 0);
  console.log(`ok wal: a ${(grown / 1e6).toFixed(0)} MB WAL is truncated by the periodic checkpoint`);
}

// Daily puzzle: a refunded, unfixed puzzle (flaw = 2, the refund mark) is passed over while the band holds any other
// scored puzzle. Six marked turning points and one conversion: the conversion is the day's puzzle.
{
  const RDB = path.join(dir, 'refund-daily.db');
  await stop(await boot(RDB));
  const r = new DatabaseSync(RDB);
  const ins = r.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, turn, flaw) VALUES (?,6,?,1,?,'s6','test',2200,2200,250,?,?)`);
  const tps = 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14', tree = JSON.stringify({ b1: 'win' });
  for (let i = 0; i < 6; i++) ins.run(`rf${i}`, tps, tree, 1, 2);
  ins.run('conv', tps, tree, 0, null);
  r.close();
  const s = await boot(RDB);
  const d = await (await fetch(base + '/api/daily')).json();
  await stop(s);
  assert.equal(d.puzzle.id, 'conv');
  console.log('ok daily: refunded, unfixed puzzles are passed over');
}

// Import: a grade override wins over the grades file; a bad override aborts before the DB is written.
{
  const I = path.join(dir, 'imp'), IDB = path.join(I, 'i.db');
  fs.mkdirSync(path.join(I, 'p'), { recursive: true });
  const w = (f, rows) => fs.writeFileSync(path.join(I, f), rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  const tps = 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14';
  w('p/a.jsonl', ['g1', 'g2'].map((id, i) => ({ id, size: 6, tps: tps.replace('2 1 14', `2 1 ${14 + i}`), plies: 1, tree: { b1: 'win' }, source: 'test', rating: 1500 })));
  w('grades.jsonl', [{ id: 'g1', tier: 'B', score: 1, why: '' }, { id: 'g2', tier: 'A', score: 2, why: '' }]);
  w('ov.jsonl', ['# hand grades', '', { id: 'g1', tier: 'D', why: 'test hold' }, { id: 'pdg1', tier: 'A', why: 'not imported yet' }]);
  w('bad.jsonl', [{ id: 'g2', tier: 'D', why: 'ok' }, { id: 'g1', tier: 'E', why: 'bad tier' }]);
  const imp = (...a) => spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/import.mjs'), 'p', '--grades', 'grades.jsonl', ...a],
    { cwd: I, env: { ...env, TINUE_DB: IDB }, encoding: 'utf8' });
  const grades = () => { const g = new DatabaseSync(IDB, { readOnly: true }); const r = Object.fromEntries(g.prepare('SELECT id, grade FROM puzzles').all().map((x) => [x.id, x.grade])); g.close(); return r; };
  let r = imp('--overrides', 'ov.jsonl');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(grades(), { g1: 'D', g2: 'A' });
  assert.match(r.stdout, /1 applied, 1 changed a grade, 1 not in the DB/);
  r = imp('--overrides', 'bad.jsonl');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /tier "E"/);
  assert.deepEqual(grades(), { g1: 'D', g2: 'A' });
  assert.equal(imp('--no-overrides').status, 0);
  assert.deepEqual(grades(), { g1: 'B', g2: 'A' });
  console.log('ok import: grade overrides win, a bad one aborts the import');
}

let server = await boot();
await stop(server);
{
  const db = new DatabaseSync(DB);
  const ins = db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, turn) VALUES (?,?,?,?,?,?,?,?,?,?,1)`);
  const tps = 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14', tree = JSON.stringify({ b1: 'win' });
  for (let i = 0; i < 30; i++) ins.run(`t${i}`, 6, tps, 1, tree, i % 3 ? 's6,tinueIn2' : 's6,fork,tinueIn2', 'test', 1300 + i * 15, 1300 + i * 15, 250);
  for (let i = 0; i < 5; i++) ins.run(`d${i}`, 6, tps, 1, tree, 's6,tinueIn3', 'test', 2100 + i * 50, 2100 + i * 50, 250);
  // 4x4: the refund mark's pool. rf sits on the target, played and unsettled (what PLAYED used to pull players onto).
  const ins4 = db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, turn, flaw, attempts) VALUES (?,4,?,1,?,'s4','test',?,?,250,1,?,?)`);
  for (let i = 0; i < 4; i++) ins4.run(`c${i}`, tps, tree, 1500 + 20 * i, 1500 + 20 * i, null, 0);
  ins4.run('cfar', tps, tree, 1890, 1890, null, 0); ins4.run('cout', tps, tree, 1980, 1980, null, 0); // cout: more than PICK_WINDOW past cfar, so never drawn with it
  ins4.run('rf', tps, tree, 1500, 1500, 2, 3);
  db.close();
}
server = await boot();

const call = async (p, body, token) => {
  const headers = { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) };
  const r = await fetch(base + p, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const text = await r.text();
  try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, text }; }
};
const db = new DatabaseSync(DB, { readOnly: true });
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

try {
  await test('anonymous /api/me', async () => assert.equal((await call('/api/me')).user, null));

  let token, user;
  await test('register starts at PLAYER_START', async () => {
    const r = await call('/api/register', { name: 'alice' });
    assert.equal(r.status, 200); ({ token, user } = r);
    assert.equal(user.rating, PLAYER_START.rating); assert.equal(user.rd, PLAYER_START.rd); assert.equal(user.provisional, true);
    assert.equal(db.prepare('SELECT vol FROM users WHERE name = ?').get('alice').vol, PLAYER_START.vol);
    assert.equal((await call('/api/register', { name: 'ALICE' })).status, 409);
    assert.equal((await call('/api/register', { name: 'x' })).status, 400);
  });

  let first;
  await test('next puzzle for an account', async () => {
    first = (await call('/api/next?size=6', null, token)).puzzle;
    assert.ok(first && first.size === 6);
  });

  await test('first result is rated with rate(); a repeat is not', async () => {
    const p = db.prepare('SELECT rating, rd, vol FROM puzzles WHERE id = ?').get(first.id);
    const want = rate(PLAYER_START, p, true);
    const r = await call('/api/result', { puzzleId: first.id, win: true, ms: 5000, log: [{ m: 'b1', ms: 5000, k: 'ok' }] }, token);
    assert.equal(r.rated, true);
    assert.ok(Math.abs(r.userDelta - want.userDelta) < 1e-9);
    assert.equal(r.user.games, 1); assert.equal(r.user.wins, 1);
    // the newcomer's rd is ≥ 230, so the puzzle doesn't move
    assert.equal(db.prepare('SELECT rating FROM puzzles WHERE id = ?').get(first.id).rating, p.rating);
    const again = await call('/api/result', { puzzleId: first.id, win: false }, token);
    assert.equal(again.rated, false); assert.equal(again.userDelta, 0);
  });

  await test('next for=<id>: one pick for a solve, one for a miss, at the rating each would leave', async () => {
    const cur = (await call('/api/next?size=6', null, token)).puzzle;
    const r = await call(`/api/next?size=6&for=${cur.id}`, null, token);
    assert.ok(r.win && r.loss); assert.notEqual(r.win.id, cur.id); assert.notEqual(r.loss.id, cur.id);
    // alice is provisional, so a solve moves her a lot: the solve's picks are rated above the miss's. Each pick is
    // random within a window, so compare averages over several asks.
    const avg = async (q, t) => { let w = 0, l = 0; for (let i = 0; i < 8; i++) { const x = await call(q, null, t); w += x.win.rating; l += x.loss.rating; } return [w / 8, l / 8]; };
    const [aw, al] = await avg(`/api/next?size=6&for=${cur.id}`, token);
    assert.ok(aw > al, `${aw} vs ${al}`);
    const [nw, nl] = await avg(`/api/next?size=6&rating=1500&for=${cur.id}`);
    assert.ok(nw > nl, `${nw} vs ${nl}`);
    // a puzzle already played doesn't move the rating: both picks sit at today's rating
    const played = await call(`/api/next?size=6&for=${first.id}`, null, token);
    assert.ok(Math.abs(played.win.rating - played.loss.rating) < 400);
    assert.equal((await call('/api/next?size=6&for=nope', null, token)).puzzle !== undefined, true); // unknown id: plain next
  });

  await test('next n=10: a batch of distinct unplayed puzzles at the rating it names', async () => {
    const r = await call('/api/next?size=6&n=10&exclude=t15,t16', null, token);
    const me = (await call('/api/me', null, token)).user;
    assert.equal(r.rating, Math.round(me.rating));
    assert.equal(r.puzzles.length, 10); assert.equal(new Set(r.puzzles.map((p) => p.id)).size, 10);
    assert.ok(!r.puzzles.some((p) => ['t15', 't16', first.id].includes(p.id)));
    assert.equal((await call('/api/next?size=6&n=99', null, token)).puzzles.length, 20); // capped
  });

  await test('picker property: random filters, ratings, excludes and batch sizes never break the rules', async () => {
    // seeded, so a failure reproduces
    let seed = 7; const R = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const played = new Set(db.prepare('SELECT puzzle_id FROM attempts a JOIN users u ON u.id = a.user_id WHERE u.name = ?').all('alice').map((r) => r.puzzle_id));
    const all = db.prepare('SELECT id FROM puzzles').all().map((r) => r.id);
    for (let i = 0; i < 60; i++) {
      const size = [6, 6, 5, ''][Math.floor(R() * 4)], theme = ['', '', 'fork', 'tinueIn3', 'smash'][Math.floor(R() * 5)];
      const difficulty = ['easiest', 'normal', 'hardest', 'bogus'][Math.floor(R() * 4)], n = [1, 2, 10, 20][Math.floor(R() * 4)];
      const exclude = all.filter(() => R() < 0.3), signed = R() < 0.5;
      const q = new URLSearchParams({ difficulty, rating: String(Math.round(R() * 3500)), ...(size ? { size } : {}), ...(theme ? { theme } : {}),
        ...(n > 1 ? { n } : {}), ...(exclude.length ? { exclude: exclude.join(',') } : {}) });
      const r = await call('/api/next?' + q, null, signed ? token : undefined);
      const got = n > 1 ? r.puzzles : r.puzzle ? [r.puzzle] : [];
      const label = `${q} ${signed ? 'alice' : 'anon'}`;
      assert.ok(got.length <= Math.max(n, 1), label);
      assert.equal(new Set(got.map((p) => p.id)).size, got.length, 'duplicates: ' + label);
      for (const p of got) {
        if (size) assert.equal(p.size, +size, label);
        if (theme) assert.ok(p.themes.includes(theme), label);
        assert.ok(!exclude.includes(p.id), 'excluded served: ' + label);
      }
      // a signed-in player gets puzzles they haven't played, unless every match is played (then repeats are allowed)
      const fresh = db.prepare(`SELECT COUNT(*) n FROM puzzles WHERE 1 ${size ? 'AND size = ' + +size : ''} ${theme ? `AND (',' || themes || ',') LIKE '%,${theme},%'` : ''}`).get().n;
      if (signed && fresh > played.size + exclude.length + 20) assert.ok(got.every((p) => !played.has(p.id)), 'played served: ' + label);
      if (fresh > exclude.length + played.size + 20) assert.ok(got.length === Math.max(n, 1), 'short batch: ' + label);
    }
  });

  await test('a refunded, unfixed puzzle (flaw = 2) is served only when nothing else is within REFUNDED of the target', async () => {
    const next = async (exclude = '') => (await call(`/api/next?size=4&rating=1500${exclude && '&exclude=' + exclude}`)).puzzle.id;
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(await next());
    assert.ok(!seen.has('rf') && seen.size > 1, [...seen].join());
    assert.ok(!(await call('/api/next?size=4&rating=1500&n=5')).puzzles.slice(0, 4).some((p) => p.id === 'rf'));
    assert.equal(await next('c0,c1,c2,c3'), 'cfar'); // 390 away beats the mark's 400
    assert.equal(await next('c0,c1,c2,c3,cfar'), 'rf'); // 480 away doesn't
    assert.equal(await next('c0,c1,c2,c3,cfar,cout'), 'rf'); // and it is still a puzzle when it is all there is
  });

  await test('a played puzzle is not served again', async () => {
    for (let i = 0; i < 10; i++) assert.notEqual((await call('/api/next?size=6', null, token)).puzzle.id, first.id);
  });

  await test('a hinted (casual) result is recorded but unrated', async () => {
    const p = (await call('/api/next?size=6', null, token)).puzzle;
    const r = await call('/api/result', { puzzleId: p.id, win: true, casual: true }, token);
    assert.equal(r.rated, false);
    assert.equal(db.prepare('SELECT rated FROM attempts a JOIN users u ON u.id = a.user_id WHERE u.name = ? AND puzzle_id = ?').get('alice', p.id).rated, 0);
  });

  await test('a themed win counts 0.1×', async () => {
    const before = (await call('/api/me', null, token)).user;
    const p = (await call('/api/next?size=6&theme=fork', null, token)).puzzle;
    assert.ok(p.themes.includes('fork'));
    const row = db.prepare('SELECT rating, rd, vol FROM users WHERE name = ?').get('alice');
    const pr = db.prepare('SELECT rating, rd, vol FROM puzzles WHERE id = ?').get(p.id);
    const r = await call('/api/result', { puzzleId: p.id, win: true, theme: 'fork' }, token);
    assert.ok(Math.abs(r.userDelta - rate(row, pr, true, 0.1).userDelta) < 1e-9);
    assert.ok(r.user.games === before.games + 1);
  });

  await test('history lists attempts', async () => {
    const h = (await call('/api/history', null, token)).history;
    assert.equal(h.length, 3);
  });

  await test('old clients: guest-result is gone (410) and records nothing', async () => {
    const r = await call('/api/guest-result', { gid: 'a'.repeat(32), puzzleId: 't5', win: true, hinted: false, rating: 1500, rd: 500, games: 0 });
    assert.equal(r.status, 410);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM guest_attempts').get().n, 0);
    assert.equal(db.prepare('SELECT attempts FROM puzzles WHERE id = ?').get('t5').attempts, 0);
  });

  await test('anonymous next honours rating and exclude', async () => {
    const p = (await call('/api/next?size=6&rating=1400&exclude=t5')).puzzle;
    assert.ok(p && p.id !== 't5');
  });

  let gtok, guest;
  await test("a new visitor's first result makes them a guest, rated like an account", async () => {
    const pr = db.prepare('SELECT rating, rd, vol FROM puzzles WHERE id = ?').get('t9');
    const r = await call('/api/result', { puzzleId: 't9', win: false, guest: { gid: 'b'.repeat(32) } });
    assert.equal(r.rated, true); assert.match(r.token, /^[a-f0-9]{48}$/);
    assert.equal(r.user.name, null); assert.equal(r.user.games, 1);
    assert.ok(Math.abs(r.userDelta - rate(PLAYER_START, pr, false).userDelta) < 1e-9);
    ({ token: gtok, user: guest } = r);
    assert.equal((await call('/api/me', null, gtok)).user.id, guest.id);
  });

  await test("a brand-new guest doesn't move puzzles yet; repeats and served puzzles work as for accounts", async () => {
    const u = db.prepare('SELECT rating, rd, vol FROM users WHERE id = ?').get(guest.id);
    assert.ok(u.rd >= 230, 'still clueless after one result');
    const pr = db.prepare('SELECT rating, rd, vol, attempts FROM puzzles WHERE id = ?').get('t10');
    const r = await call('/api/result', { puzzleId: 't10', win: true }, gtok);
    assert.equal(r.token, undefined);
    assert.ok(Math.abs(r.userDelta - rate(u, pr, true).userDelta) < 1e-9);
    const after = db.prepare('SELECT rating, attempts FROM puzzles WHERE id = ?').get('t10');
    assert.equal(after.rating, pr.rating); assert.equal(after.attempts, pr.attempts + 1);
    assert.equal((await call('/api/result', { puzzleId: 't10', win: false }, gtok)).rated, false);
    for (let i = 0; i < 10; i++) assert.ok(!['t9', 't10'].includes((await call('/api/next?size=6', null, gtok)).puzzle.id));
    assert.equal((await call('/api/history', null, gtok)).history.length, 2);
  });

  await test('a settled guest moves puzzles at half weight (times the theme weight)', async () => {
    const w = new DatabaseSync(DB); w.prepare('UPDATE users SET rd = 120 WHERE id = ?').run(guest.id); w.close();
    const u = db.prepare('SELECT rating, rd, vol FROM users WHERE id = ?').get(guest.id);
    const pr = db.prepare('SELECT rating, rd, vol FROM puzzles WHERE id = ?').get('t12');
    await call('/api/result', { puzzleId: 't12', win: false }, gtok);
    const got = db.prepare('SELECT rating FROM puzzles WHERE id = ?').get('t12').rating - pr.rating;
    const half = rate(u, pr, false, 1, GUEST_PUZZLE_WEIGHT).puzzleDelta, full = rate(u, pr, false).puzzleDelta;
    assert.ok(Math.abs(got - half) < 1e-9 && Math.abs(half - full / 2) < 1, `${got} vs ${half} (full ${full})`);
    const u2 = db.prepare('SELECT rating, rd, vol FROM users WHERE id = ?').get(guest.id);
    const pf = db.prepare('SELECT rating, rd, vol FROM puzzles WHERE id = ?').get('t0'); // t0: a fork puzzle
    await call('/api/result', { puzzleId: 't0', win: false, theme: 'fork' }, gtok);
    const gotF = db.prepare('SELECT rating FROM puzzles WHERE id = ?').get('t0').rating - pf.rating;
    assert.ok(Math.abs(gotF - rate(u2, pf, false, 0.7, 0.7 * GUEST_PUZZLE_WEIGHT).puzzleDelta) < 1e-9);
  });

  await test('stats: the kept answer is what the queries give now, after a rated result and after another connection writes', async () => {
    const want = () => ({ ...db.prepare('SELECT COUNT(*) n, MIN(rating) lo, MAX(rating) hi, AVG(rating) avg FROM puzzles').get(),
      byPly: db.prepare('SELECT plies, COUNT(*) n, AVG(rating) avg FROM puzzles GROUP BY plies ORDER BY plies').all(),
      byTurn: db.prepare('SELECT turn, COUNT(*) n, AVG(rating) avg FROM puzzles GROUP BY turn ORDER BY turn').all() });
    const got = async () => { const r = await fetch(`${base}/api/stats`); return r.text(); };
    assert.equal(await got(), JSON.stringify(want()));
    assert.equal(await got(), JSON.stringify(want())); // kept
    const before = await got();
    // the settled guest's result moves t14; undone after, so the tests below see the guest and puzzles as they were
    const uRow = db.prepare('SELECT rating, rd, vol, games, wins FROM users WHERE id = ?').get(guest.id);
    const pRow = db.prepare("SELECT rating, rd, vol, attempts, solves FROM puzzles WHERE id = 't14'").get();
    const r = await call('/api/result', { puzzleId: 't14', win: true }, gtok);
    assert.equal(r.rated, true);
    assert.notEqual(await got(), before);
    assert.equal(await got(), JSON.stringify(want()));
    const w = new DatabaseSync(DB);
    w.prepare("UPDATE puzzles SET rating = rating + 7 WHERE id = 't15'").run();
    assert.equal(await got(), JSON.stringify(want()));
    w.prepare("UPDATE puzzles SET rating = rating - 7 WHERE id = 't15'").run();
    w.prepare('UPDATE users SET rating = ?, rd = ?, vol = ?, games = ?, wins = ? WHERE id = ?').run(uRow.rating, uRow.rd, uRow.vol, uRow.games, uRow.wins, guest.id);
    w.prepare("UPDATE puzzles SET rating = ?, rd = ?, vol = ?, attempts = ?, solves = ? WHERE id = 't14'").run(pRow.rating, pRow.rd, pRow.vol, pRow.attempts, pRow.solves);
    w.prepare("DELETE FROM attempts WHERE user_id = ? AND puzzle_id = 't14'").run(guest.id);
    w.close();
    assert.equal(await got(), JSON.stringify(want()));
  });

  await test('the leaderboard skips guests and flags provisional players', async () => {
    const w = new DatabaseSync(DB); w.prepare('UPDATE users SET rd = 60 WHERE id = ?').run(guest.id); w.close();
    assert.equal((await call('/api/me', null, gtok)).user.provisional, false);
    // the settled guest is left out; alice (2 puzzles) is listed with her "?"
    assert.deepEqual((await call('/api/leaderboard')).leaders.map((l) => [l.name, l.provisional]), [['alice', true]]);
  });

  await test('claiming a name keeps the guest row, rating and history', async () => {
    const before = (await call('/api/me', null, gtok)).user;
    const r = await call('/api/register', { name: 'carol' }, gtok);
    assert.equal(r.status, 200); assert.equal(r.token, undefined);
    assert.equal(r.user.id, before.id); assert.equal(r.user.name, 'carol'); assert.equal(r.user.rating, before.rating);
    assert.equal((await call('/api/history', null, gtok)).history.length, 4);
    assert.equal((await call('/api/register', { name: 'carol2' }, gtok)).status, 409);
    assert.ok((await call('/api/leaderboard')).leaders.some((l) => l.name === 'carol' && !l.provisional));
    // named now: results move puzzles at full weight
    const before11 = db.prepare('SELECT attempts FROM puzzles WHERE id = ?').get('t11').attempts;
    await call('/api/result', { puzzleId: 't11', win: true }, gtok);
    assert.equal(db.prepare('SELECT attempts FROM puzzles WHERE id = ?').get('t11').attempts, before11 + 1);
  });

  await test("an older client's guest: its anonymous results are replayed into its rating and history", async () => {
    const gid = 'c'.repeat(32);
    // what the old browser claimed about itself (rating 3000) is ignored; only results count
    // (rows as /api/guest-result recorded them before it was removed: the puzzle's rating at the time, the claims kept as data)
    const w = new DatabaseSync(DB), ins = w.prepare(`INSERT INTO guest_attempts (gid, puzzle_id, win, hinted, guest_rating, guest_rd, guest_games, puzzle_rating, ms, log, ts)
      VALUES (?,?,?,?,3000,45,?,(SELECT rating FROM puzzles WHERE id = ?),NULL,NULL,?)`);
    for (const [id, win, hinted, games, ts] of [['t1', 1, 0, 0, 1], ['t2', 0, 1, 1, 2], ['t3', 0, 0, 1, 3]]) ins.run(gid, id, win, hinted, games, id, Date.now() - 1000 + ts);
    w.close();
    const rows = db.prepare('SELECT g.*, p.rd prd FROM guest_attempts g JOIN puzzles p ON p.id = g.puzzle_id WHERE gid = ? ORDER BY ts').all(gid);
    const want = replayGuest(rows);
    assert.equal(want.games, 2); assert.equal(want.wins, 1);
    const r = await call('/api/result', { puzzleId: 't3', win: true, guest: { gid, rating: 3000, rd: 45, games: 2 } });
    assert.equal(r.rated, false, 'already played (t3) before: a repeat');
    assert.ok(Math.abs(r.user.rating - want.rating.rating) < 1e-9); assert.equal(r.user.games, 2); assert.equal(r.user.wins, 1);
    const h = (await call('/api/history', null, r.token)).history.sort((a, b) => a.ts - b.ts);
    assert.deepEqual(h.map((x) => [x.puzzle_id, x.rated]), [['t1', 1], ['t2', 0], ['t3', 1]]);
    assert.ok(h[0].user_delta > 100 && h[1].user_delta === 0 && h[2].user_delta < 0);
    assert.equal(h[0].user_rating, PLAYER_START.rating);
    // the answer with its token was lost: the same browser gets the same row back, with a new token
    const again = await call('/api/result', { puzzleId: 't4', win: true, guest: { gid } });
    assert.equal(again.user.id, r.user.id); assert.notEqual(again.token, r.token);
    assert.equal((await call('/api/me', null, r.token)).user, null);
  });

  await test('making guests is limited per IP', async () => {
    let last;
    for (let i = 0; i < 12 && last?.status !== 429; i++) last = await call('/api/result', { puzzleId: 't20', win: true, guest: {} });
    assert.equal(last.status, 429);
    const r = await fetch(base + '/api/result', { method: 'POST', headers: { origin: 'https://shydrie.xyz', 'content-type': 'application/json' }, body: '{"puzzleId":"t20","win":true,"guest":{}}' });
    assert.equal(r.status, 429); assert.ok(+r.headers.get('retry-after') > 3500, r.headers.get('retry-after')); // the wait, readable by the page:
    assert.equal(r.headers.get('access-control-expose-headers'), 'retry-after');
  });

  await test('a first-time visitor claiming a name straight away gets an account at the start rating', async () => {
    const r = await call('/api/register', { name: 'dave', guest: { gid: 'd'.repeat(32) } });
    assert.equal(r.user.name, 'dave'); assert.equal(r.user.rating, PLAYER_START.rating); assert.match(r.token, /^[a-f0-9]{48}$/);
  });

  await test('daily puzzle is 6x6 in the hard band, stable, and documented', async () => {
    const a = await call('/api/daily'), b = await call('/api/daily');
    assert.equal(a.puzzle.id, b.puzzle.id); assert.equal(a.puzzle.size, 6);
    assert.ok(a.puzzle.rating >= 2000 && a.puzzle.rating <= 2400);
    const doc = (await call('/api')).text;
    assert.match(doc, /6x6 puzzle rated 2000-2400/);
    assert.match(doc, /rated as usual, signed in or as a guest/);
  });

  await test('bot lookups', async () => {
    assert.equal((await call('/api/users/CAROL')).user.name, 'carol');
    assert.equal((await call('/api/users/ALICE')).user.name, 'alice');
    assert.equal((await call('/api/users/nobody')).status, 404);
    const g = await call('/api/group?names=alice,bob');
    assert.deepEqual(g.missing, ['bob']); assert.equal(g.users.length, 1);
  });

  await test('bad input', async () => {
    assert.equal((await call('/api/result', { puzzleId: 1, win: true }, token)).status, 400);
    assert.equal((await call('/api/result', { puzzleId: 'nope', win: true }, token)).status, 404);
    assert.equal((await call('/api/nope')).status, 404);
  });

  const stored = (id) => db.prepare('SELECT a.rated, a.win, a.log FROM attempts a JOIN users u ON u.id = a.user_id WHERE u.name = ? AND puzzle_id = ?').get('alice', id);
  await test("an off-tree proven win ('slow' in the log) is a rated solve, and the log keeps 'slow'", async () => {
    const before = (await call('/api/me', null, token)).user, id = (await call('/api/next?size=6', null, token)).puzzle.id;
    const log = [{ m: 'b1', ms: 1, k: 'ok' }, { m: 'c2', ms: 2, k: 'slow' }];
    const r = await call('/api/result', { puzzleId: id, win: true, ms: 2, log }, token);
    assert.equal(r.rated, true); assert.ok(r.userDelta > 0);
    assert.equal(r.user.games, before.games + 1); assert.equal(r.user.wins, before.wins + 1);
    const a = stored(id);
    assert.equal(a.rated, 1); assert.equal(a.win, 1); assert.deepEqual(JSON.parse(a.log), log);
  });

  // A proven play-out (the client plays a proven off-tree win out to a road): what each ending sends, as recorded.
  await test('proven play-out: a road is a rated solve; a hold or give-up is a rated miss; a page that went away is an unrated miss; logs keep slow + po', async () => {
    const send = async (win, extra, log) => { const id = (await call('/api/next?size=6', null, token)).puzzle.id; return { id, r: await call('/api/result', { puzzleId: id, win, ms: 5, log, ...extra }, token) }; };
    const won = [{ m: 'c2', ms: 2, k: 'slow' }, { m: 'd3', ms: 3, k: 'po' }, { m: 'e3', ms: 4, k: 'po' }];
    let { id, r } = await send(true, {}, won);
    assert.equal(r.rated, true); assert.ok(r.userDelta > 0); assert.equal(stored(id).win, 1); assert.deepEqual(JSON.parse(stored(id).log), won);
    const held = [{ m: 'c2', ms: 2, k: 'slow' }, { m: 'd3', ms: 3, k: 'po' }];
    ({ id, r } = await send(false, {}, held)); // (Syntaks held throughout)
    assert.equal(r.rated, true); assert.ok(r.userDelta < 0); assert.equal(stored(id).rated, 1); assert.deepEqual(JSON.parse(stored(id).log), held);
    ({ id, r } = await send(false, { casual: true }, held)); // the page went away (reload, closed tab), or Tiltak/dropout
    assert.equal(r.rated, false); assert.equal(r.userDelta, 0); assert.equal(stored(id).rated, 0); assert.equal(stored(id).win, 0);
  });

  await test('a casual miss (an unsettled check) is recorded but moves nothing', async () => {
    const before = (await call('/api/me', null, token)).user, id = (await call('/api/next?size=6', null, token)).puzzle.id;
    const pr = db.prepare('SELECT rating, attempts, solves FROM puzzles WHERE id = ?').get(id);
    const r = await call('/api/result', { puzzleId: id, win: false, casual: true, log: [{ m: 'c2', ms: 3, k: 'miss' }] }, token);
    assert.equal(r.rated, false); assert.equal(r.userDelta, 0);
    assert.equal(r.user.games, before.games); assert.equal(r.user.wins, before.wins); assert.equal(r.user.rating, before.rating);
    assert.deepEqual({ ...db.prepare('SELECT rating, attempts, solves FROM puzzles WHERE id = ?').get(id) }, { ...pr });
    assert.equal(stored(id).rated, 0); assert.equal(stored(id).win, 0);
    const h = (await call('/api/history', null, token)).history.find((x) => x.puzzle_id === id);
    assert.equal(h.rated, 0); assert.equal(h.user_delta, 0);
  });

  await test('a refunded miss reads as solved, with the refund mark and the change it applied', async () => {
    const id = (await call('/api/next?size=6', null, token)).puzzle.id;
    const r = await call('/api/result', { puzzleId: id, win: false, log: [{ m: 'c2', ms: 3, k: 'miss' }] }, token);
    assert.equal(r.rated, true); assert.ok(r.userDelta < 0);
    // as scripts/refund.mjs leaves the row (its Δ: what the refund changed, here nothing)
    const w = new DatabaseSync(DB); w.exec('PRAGMA busy_timeout = 5000');
    w.prepare("UPDATE attempts SET win = 1, rated = 1, user_delta = 0, refund = 1 WHERE puzzle_id = ? AND user_id = (SELECT id FROM users WHERE name = 'alice')").run(id); w.close();
    const hist = (await call('/api/history', null, token)).history, h = hist.find((x) => x.puzzle_id === id);
    assert.deepEqual([h.win, h.rated, h.refund, h.user_delta], [1, 1, 1, 0]);
    assert.ok(hist.filter((x) => x.puzzle_id !== id).every((x) => x.refund == null), 'other rows carry no mark');
  });

  await test('a log with an unknown kind is stored as null', async () => {
    const id = (await call('/api/next?size=6', null, token)).puzzle.id;
    const r = await call('/api/result', { puzzleId: id, win: true, log: [{ m: 'b1', ms: 1, k: 'ok' }, { m: 'c2', ms: 2, k: 'wins-too' }] }, token);
    assert.equal(r.status, 200); assert.equal(r.rated, true);
    assert.equal(stored(id).log, null);
  });

  await test('with a minimum build set, a miss from an older build (or none) is unrated; wins and current misses count', async () => {
    await stop(server); server = await boot(DB, { TINUE_MIN_BUILD: '1000' });
    const next = async () => (await call('/api/next?size=6', null, token)).puzzle.id;
    const rating = () => db.prepare('SELECT rating FROM users WHERE name = ?').get('alice').rating;
    for (const [qs, win, rated] of [['', false, false], ['?b=999', false, false], ['?b=junk', false, false], ['?b=1000', false, true], ['?b=2000', false, true], ['', true, true], ['?b=999', true, true]]) {
      const id = await next(), before = rating();
      const r = await call('/api/result' + qs, { puzzleId: id, win }, token);
      assert.equal(r.status, 200); assert.equal(r.rated, rated, `${qs || 'no build'} win=${win}`);
      assert.equal(db.prepare('SELECT rated FROM attempts a JOIN users u ON u.id = a.user_id WHERE u.name = ? AND puzzle_id = ?').get('alice', id).rated, rated ? 1 : 0);
      if (rated) assert.notEqual(rating(), before); else { assert.equal(rating(), before); assert.equal(r.userDelta, 0); }
    }
  });

  // Only the first attempt is recorded (no unique index: the check and the insert run with no await between them, so
  // requests can't interleave there). Results sent at once, with the bodies held back until every request is open.
  await test('results sent at once for one puzzle: one attempt row, one rated', async () => {
    const id = (await call('/api/next?size=6', null, token)).puzzle.id, before = (await call('/api/me', null, token)).user;
    const http = await import('node:http');
    const reqs = [1, 2, 3, 4, 5].map(() => { const win = true; // (wins: this server rates misses only from a recent build)
      const b = JSON.stringify({ puzzleId: id, win });
      const rq = http.request(`${base}/api/result`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), authorization: 'Bearer ' + token } });
      rq.flushHeaders();
      return { rq, b, done: new Promise((ok, no) => rq.on('response', (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => ok(JSON.parse(s))); }).on('error', no)) };
    });
    await new Promise((r) => setTimeout(r, 100));
    for (const { rq, b } of reqs) rq.end(b);
    const out = await Promise.all(reqs.map((x) => x.done));
    assert.equal(out.filter((r) => r.rated).length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id = ? AND puzzle_id = ?').get(before.id, id).n, 1);
    assert.equal((await call('/api/me', null, token)).user.games, before.games + 1);
  });

  // Play-on's defender: a fake TEI engine (answers every search with one fixed line after ~150 ms) stands in for
  // Syntaks, so this runs anywhere. Same pool and cache as /api/analyze.
  // The API host (tinue-api.shydrie.xyz) is same-site with every *.shydrie.xyz page, so the token cookie rides along
  // on their requests. It counts, and is set or cleared, only for allowed origins, the API host itself, or no Origin.
  await test('the token cookie is honoured, set and cleared only for allowed origins', async () => {
    const raw = (p, { origin, cookie, body, type = 'application/json' } = {}) => fetch(base + p, {
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { ...(body ? { 'content-type': type } : {}), ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) } });
    const FOREIGN = 'https://pages.shydrie.xyz', OWN = 'https://shydrie.xyz', SAME = base, ck = 'tinue_token=' + token;
    for (const [origin, want] of [[undefined, 'alice'], [OWN, 'alice'], [SAME, 'alice'], [FOREIGN, null], ['null', null], ['not a url', null]]) {
      const r = await (await raw('/api/me', { origin, cookie: ck })).json();
      assert.equal(r.user?.name ?? null, want, 'cookie from origin ' + origin);
    }
    // a bearer token still works from anywhere (a page can only send one it already holds)
    assert.equal((await (await fetch(base + '/api/me', { headers: { origin: FOREIGN, authorization: 'Bearer ' + token } })).json()).user.name, 'alice');
    // a foreign page's no-preflight (text/plain) post can't act as the cookie's player...
    const before = db.prepare('SELECT COUNT(*) n FROM attempts a JOIN users u ON u.id = a.user_id WHERE u.name = ?').get('alice').n;
    const id = (await call('/api/next?size=6', null, token)).puzzle.id;
    const post = await raw('/api/result', { origin: FOREIGN, cookie: ck, type: 'text/plain', body: { puzzleId: id, win: false, theme: 'tinueIn2' } });
    assert.equal(post.headers.get('set-cookie'), null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM attempts a JOIN users u ON u.id = a.user_id WHERE u.name = ?').get('alice').n, before);
    // ...or plant or clear the cookie: login, register and logout answer without set-cookie
    const login = await raw('/api/login', { origin: FOREIGN, type: 'text/plain', body: { token } });
    assert.equal(login.status, 200); assert.equal(login.headers.get('set-cookie'), null);
    const reg = await raw('/api/register', { origin: FOREIGN, type: 'text/plain', body: { name: 'mallory' } });
    assert.equal(reg.status, 200); assert.equal(reg.headers.get('set-cookie'), null); assert.match((await reg.json()).token, /^[a-f0-9]{48}$/);
    assert.equal((await raw('/api/logout', { origin: FOREIGN, cookie: ck, type: 'text/plain', body: {} })).headers.get('set-cookie'), null);
    // the page itself, and a request with no Origin, still get the cookie set and cleared
    assert.match((await raw('/api/login', { origin: OWN, body: { token } })).headers.get('set-cookie'), /^tinue_token=[a-f0-9]{48}; .*Max-Age=315360000/);
    assert.match((await raw('/api/logout', { origin: OWN, body: {} })).headers.get('set-cookie'), /^tinue_token=; .*Max-Age=0/);
    assert.match((await raw('/api/logout', { body: {} })).headers.get('set-cookie'), /^tinue_token=; .*Max-Age=0/);
  });

  // POST /api/handoff-token is off unless TINUE_HANDOFF_ORIGIN is set (on: scripts/test-hosts.mjs)
  await test('handoff-token: no such route by default', async () => {
    const r = await fetch(base + '/api/handoff-token', { method: 'POST', headers: { origin: 'https://shydrie.xyz', cookie: 'tinue_token=' + token } });
    assert.equal(r.status, 404);
  });

  // POST /api/slow: one SLOW-CLIENT access-log line per report. The leading fields keep their order (an old client's
  // body logs as before); new fields are short key=value tokens, only when well-formed; the IP and other headers never.
  await test('slow reports: old and new shapes, user tag, cf headers, hostile values, batches capped and rate-limited', async () => {
    const slow = (b, headers = {}) => fetch(base + '/api/slow', { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: typeof b === 'string' ? b : JSON.stringify(b) });
    const lines = async (mark, want = 1) => {
      for (let i = 0; i < 100; i++) {
        const ls = fs.readFileSync(env.TINUE_ACCESS_LOG, 'utf8').split('\n').filter((l) => l.includes(' SLOW-CLIENT ' + mark));
        if (ls.length >= want) { await new Promise((r) => setTimeout(r, 30)); return fs.readFileSync(env.TINUE_ACCESS_LOG, 'utf8').split('\n').filter((l) => l.includes(' SLOW-CLIENT ' + mark)); }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('no SLOW-CLIENT line for ' + mark);
    };
    const rest = (l) => l.replace(/^\S+ SLOW-CLIENT /, ''); // without the timestamp
    const uid = db.prepare('SELECT id FROM users WHERE name = ?').get('alice').id;
    const TAG = '[a-f0-9]{8}', xff = (n) => ({ 'x-forwarded-for': '198.51.100.' + n });
    // an old client's body: exactly today's line
    assert.equal((await slow({ path: '/old/a?x=1', ms: 2345.6, outcome: 'retried', hidden: true }, xff(1))).status, 200);
    assert.match(rest((await lines('/old/a'))[0]), new RegExp(`^/old/a\\?x=1 2346ms retried ${TAG} hidden$`));
    await slow({ path: '/old/b', ms: 'x', outcome: 'weird' }, xff(1));
    assert.match(rest((await lines('/old/b'))[0]), new RegExp(`^/old/b -1ms ok ${TAG}$`));
    // the new shape, with the bearer token and Cloudflare's headers
    const full = { path: '/new/a', ms: 9000, outcome: 'failed', hidden: false, err: 'TypeError', online: false,
      conn: { effectiveType: '3g', rtt: 450, downlink: 1.234, saveData: true }, tries: 2, sinceOk: 61234.4, build: 1731800000, queued: 4200, extra: 'ignored' };
    await slow(full, { ...xff(2), authorization: 'Bearer ' + token, 'cf-ipcountry': 'NZ', 'cf-ray': '8c2f3a1b2c3d4e5f-AKL' });
    assert.match(rest((await lines('/new/a'))[0]), new RegExp(`^/new/a 9000ms failed ${TAG} u${uid} err=TypeError on=0 et=3g rtt=450 dl=1.23 sd=1 tries=2 sinceok=61234 build=1731800000 queued=4200 cc=NZ colo=AKL$`));
    // the cookie counts from the page's origin (a beacon carries it), not from a foreign one; no cf headers: no cc/colo
    await slow({ path: '/new/b', ms: 2500, outcome: 'ok', online: true, sinceOk: -1 }, { ...xff(2), origin: 'https://shydrie.xyz', cookie: 'tinue_token=' + token });
    assert.match(rest((await lines('/new/b'))[0]), new RegExp(`^/new/b 2500ms ok ${TAG} u${uid} on=1 sinceok=-1$`));
    await slow({ path: '/new/c', ms: 2500, outcome: 'ok' }, { ...xff(2), origin: 'https://pages.shydrie.xyz', cookie: 'tinue_token=' + token });
    assert.match(rest((await lines('/new/c'))[0]), new RegExp(`^/new/c 2500ms ok ${TAG}$`));
    // malformed cf headers are dropped
    for (const [cc, ray, i] of [['nz', '8c2f-akl', 'd'], ['NZL', '8c2f', 'e'], ['N\nZ', 'abc-SJC\r\nX: y', 'f'], ['', '-', 'g'], ['T1', '8c2f-SJCXX', 'h']]) {
      try { await slow({ path: '/cf/' + i, ms: 1, outcome: 'ok' }, { ...xff(3), 'cf-ipcountry': cc, 'cf-ray': ray }); } catch {} // fetch refuses a header with a newline
    }
    const cfl = await lines('/cf/', 4);
    for (const l of cfl) assert.match(rest(l), new RegExp(`^/cf/[a-z] 1ms ok ${TAG}$`), l);
    // hostile values: newlines, huge strings, wrong types; nothing outside the known tokens, one line per report
    const before = fs.readFileSync(env.TINUE_ACCESS_LOG, 'utf8').split('\n').length;
    await slow({ path: '/bad/a\n2026-01-01T00:00:00Z SLOW-CLIENT /forged 1ms ok deadbeef u1' + 'x'.repeat(5000), ms: 1e400, outcome: 'failed\nX', hidden: 'yes',
      err: 'Type Error\nu1', online: 'false', conn: { effectiveType: '5g\n', rtt: -5, downlink: 'fast', saveData: 'no' }, tries: 1e9, sinceOk: -7,
      build: '1731800000', queued: -1, 'cc': 'US', colo: 'SJC', ip: '1.2.3.4' }, xff(4));
    const bad = await lines('/bad/a');
    assert.equal(bad.length, 1);
    assert.equal(fs.readFileSync(env.TINUE_ACCESS_LOG, 'utf8').split('\n').filter((l) => l.includes('/forged')).length, 1); // only inside that one line
    assert.ok(bad[0].length < 300, bad[0].length);
    assert.match(rest(bad[0]), new RegExp(`^/bad/a2026-01-01T00:00:00ZSLOW-CLIENT/forged1msokdeadbeefu1x+ -1ms ok ${TAG} hidden$`));
    await slow({ path: '/bad/b', ms: 1, conn: [1, 2], err: 'x'.repeat(41), tries: 2.5, queued: 8 * 86400e3 }, xff(4));
    assert.match(rest((await lines('/bad/b'))[0]), new RegExp(`^/bad/b 1ms ok ${TAG} tries=3$`));
    for (const b of ['[1,2]', '"str"', 'null', '{bad']) assert.equal((await slow(b, xff(4))).status, 400);
    // control characters and Unicode line breaks some readers split on (NEL, LS), a terminal escape: all dropped
    await slow({ path: '/bad/c\u0085X\u2028Y\u001b[31mZ\u0000\u00e9', ms: 1 }, xff(4));
    assert.match(rest((await lines('/bad/c'))[0]), new RegExp(`^/bad/cXY\\[31mZ 1ms ok ${TAG}$`));
    const added = async () => { // three reports + their request lines + four 400s (request lines are written as each one finishes)
      for (let i = 0; i < 100 && fs.readFileSync(env.TINUE_ACCESS_LOG, 'utf8').split('\n').length - before < 10; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 50));
      return fs.readFileSync(env.TINUE_ACCESS_LOG, 'utf8').split('\n').length - before;
    };
    assert.equal(await added(), 3 + 3 + 4);
    // a batch: at most 10 lines, non-object entries skipped, each counted against the limit (30 a minute per client)
    const batch = Array.from({ length: 500 }, (_, i) => (i === 3 ? 'junk' : { path: '/batch/' + i, ms: 3000 + i, outcome: 'failed', queued: 1000 + i }));
    assert.equal((await slow({ batch }, xff(5))).status, 200);
    const bl = await lines('/batch/', 9);
    assert.equal(bl.length, 9);
    assert.deepEqual(bl.map((l) => rest(l).split(' ')[0]), ['/batch/0', '/batch/1', '/batch/2', ...[4, 5, 6, 7, 8, 9].map((i) => '/batch/' + i)]);
    assert.match(rest(bl[0]), new RegExp(`^/batch/0 3000ms failed ${TAG} queued=1000$`));
    for (let k = 0; k < 3; k++) await slow({ batch: batch.slice(10, 20).map((e) => ({ ...e, path: e.path + 'k' + k })) }, xff(5)); // 9 + 3×10 lines offered
    assert.equal((await lines('/batch/', 30)).length, 30); // a line counts once (the request counts as its first); the 31st is over
    assert.equal((await slow({ path: '/batch/late', ms: 1 }, xff(5))).status, 429);
  });

  // The old Funnel host: apps, bots and typed links are redirected to the new host; a page's fetch is still answered.
  await test('the old host redirects apps, bots and navigations, and still answers a page\'s fetch', async () => {
    const OLD = 'crux.tail5ed24.ts.net:8443', NEW = 'https://api.tinue.me';
    const raw = (p, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { host: OLD, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
        let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: s }));
      });
      r.on('error', reject); r.end(body);
    });
    const a = await raw('/api/daily?x=1%202');
    assert.equal(a.status, 301); assert.equal(a.headers.location, NEW + '/api/daily?x=1%202');
    assert.equal(JSON.parse(a.text).location, NEW + '/api/daily?x=1%202');
    assert.equal((await raw('/api/group?names=shy,hung')).headers.location, NEW + '/api/group?names=shy,hung');
    assert.equal((await raw('/', { 'sec-fetch-mode': 'navigate' })).headers.location, NEW + '/');
    assert.equal((await raw('/p/t0.png')).headers.location, NEW + '/p/t0.png');
    assert.equal((await raw('//evil.example/x')).headers.location.startsWith(NEW + '/'), true);
    const h = await raw('/api/stats', {}, 'HEAD'); assert.equal(h.status, 301); assert.equal(h.text, '');
    const before = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    const p = await raw('/api/register', {}, 'POST', JSON.stringify({ name: 'movedbot' }));
    assert.equal(p.status, 308); assert.equal(p.headers.location, NEW + '/api/register');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, before); // redirected, not acted on
    assert.equal((await raw('/api/stats', {}, 'OPTIONS')).status, 308);
    // a page's fetch: answered as before, with or without CORS, preflights included
    const own = await raw('/api/stats', { origin: 'https://shydrie.xyz', 'sec-fetch-mode': 'cors' });
    assert.equal(own.status, 200); assert.equal(own.headers['access-control-allow-origin'], 'https://shydrie.xyz');
    assert.equal((await raw('/api/analyze', { origin: 'https://shydrie.xyz', 'access-control-request-method': 'POST' }, 'OPTIONS')).status, 204);
    assert.equal((await raw('/api/stats', { 'sec-fetch-mode': 'same-origin' })).status, 200);
    assert.equal((await raw('/api/stats', { 'sec-fetch-mode': 'no-cors' })).status, 200);
    assert.equal((await raw('/api/me', { origin: 'https://' + OLD })).status, 200);
    // any other host is untouched, and the host match ignores case
    assert.equal((await raw('/api/stats', { host: 'tinue-api.shydrie.xyz' })).status, 200);
    assert.equal((await raw('/api/stats', { host: '127.0.0.1:' + PORT })).status, 200);
    assert.equal((await raw('/api/stats', { host: 'CRUX.tail5ed24.ts.net:8443' })).status, 301);
  });

  // Client keys (rate limits, log tags) come from the last x-forwarded-for entry: IPv6 by /64, IPv4-mapped as IPv4.
  await test('client keys: last x-forwarded-for entry, IPv6 by /64, IPv4-mapped as IPv4', async () => {
    const tag = async (xff, mark) => {
      await fetch(`${base}/api/stats?k=${mark}`, { headers: { 'x-forwarded-for': xff } });
      for (let i = 0; i < 50; i++) {
        const line = fs.readFileSync(env.TINUE_ACCESS_LOG, 'utf8').split('\n').find((l) => l.includes(`/api/stats?k=${mark} `));
        if (line) return line.trim().split(' ').pop();
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('no log line for ' + mark);
    };
    const a = await tag('2001:db8:1:2::1', 'v6a'), b = await tag('2001:DB8:1:2:ffff:0:0:9', 'v6b'), c = await tag('2001:db8:1:3::1', 'v6c');
    assert.match(a, /^[a-f0-9]{8}$/); assert.equal(a, b); assert.notEqual(a, c);
    const v4 = await tag('203.0.113.5', 'v4a');
    assert.equal(await tag('::ffff:203.0.113.5', 'v4b'), v4);
    assert.equal(await tag('198.51.100.7, 203.0.113.5', 'v4c'), v4); // a client-supplied first entry doesn't pick the key
    assert.notEqual(await tag('203.0.113.6', 'v4d'), v4);
  });

  // Failed logins are limited per client (20 an hour); good ones never count, and a right token always signs in (the
  // client shows any error as "That token doesn't match an account"). A limited failure gets 429 + Retry-After.
  await test('login: failures limited per client with Retry-After; a right token always signs in', async () => {
    const login = (t, xff) => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ token: t }) });
    for (let i = 0; i < 30; i++) assert.equal((await login(token, '203.0.113.40')).status, 200);
    for (let i = 0; i < 20; i++) assert.equal((await login('f'.repeat(48), '203.0.113.41')).status, 401);
    const r = await login('e'.repeat(48), '203.0.113.41');
    assert.equal(r.status, 429); assert.ok(+r.headers.get('retry-after') > 3500, r.headers.get('retry-after'));
    assert.equal((await login(token, '203.0.113.41')).status, 200); // the player's own token, from the limited client
    assert.equal((await login('e'.repeat(48), '203.0.113.41')).status, 429); // and that didn't reset the limit
    assert.equal((await login(token, '203.0.113.42')).status, 200); // another client is unaffected
  });

  // The fake engine logs every command it gets (pid, command) to ENGINE_LOG. With MultiPV 1 (its start) it answers a
  // search with one line and no multipv field, as before MultiPV; after `setoption name MultiPV value N` with N lines
  // `info multipv k ...` (line 1 the same as at MultiPV 1). IGNORE_MPV: an engine without the option (one line).
  const ENGINE_LOG = path.join(dir, 'engine.log');
  const fakeEngine = (file, ignoreMpv = false) => fs.writeFileSync(file, `#!${process.execPath}
const fs = await import('node:fs');
let n = 0, mpv = 1;
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    fs.appendFileSync(${JSON.stringify(ENGINE_LOG)}, process.pid + ' ' + line + '\\n');
    const m = line.match(/^setoption name MultiPV value (\\d+)$/);
    if (m && !${ignoreMpv}) mpv = +m[1];
    if (line.startsWith('go')) {
      const nodes = ++n;
      const out = mpv === 1 ? ['info depth 5 score mate -3 wdl 0 0 1000 nodes ' + nodes + ' pv f6 e6']
        : Array.from({ length: mpv }, (_, k) => 'info multipv ' + (k + 1) + ' depth ' + (5 - Math.min(k, 1)) + ' score '
          + (k ? 'cp ' + (-50 * k) + ' wdl 100 0 900' : 'mate -3 wdl 0 0 1000') + ' nodes ' + nodes + ' pv ' + ['f6', 'e5', 'd4'][k] + ' e6');
      setTimeout(() => process.stdout.write(out.join('\\n') + '\\nbestmove f6\\n'), 150);
    }
    if (line === 'quit') process.exit(0);
  }
});
`, { mode: 0o755 });
  const engineLog = () => (fs.existsSync(ENGINE_LOG) ? fs.readFileSync(ENGINE_LOG, 'utf8').trim().split('\n') : []).map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)]; });

  await test('defend: Syntaks reply, validation, one in flight per client', async () => {
    const FAKE = path.join(dir, 'fake-syntaks.mjs');
    fakeEngine(FAKE);
    await stop(server);
    server = await boot(DB, { TINUE_SYNTAKS: FAKE });
    const tps = 'x6/x6/x6/x6/x6/2,x5 1 2';
    const r = await call('/api/defend?tps=' + encodeURIComponent(tps) + '&komi=2');
    // a search without lines: exactly the commands Syntaks always got (no MultiPV), in the same order
    assert.deepEqual(engineLog().map((x) => x[1]), ['tei', 'setoption name Threads value 1', 'setoption name Hash value 64', 'setoption name MateScores value true',
      'setoption name HumanWDL value true', 'setoption name HalfKomi value 4', 'teinewgame 6', 'position tps ' + tps, 'go movetime 1200']);
    assert.equal(r.status, 200); assert.equal(r.move, 'f6');
    assert.equal(r.side, 'white'); assert.equal(r.mate, -3); assert.equal(r.winProb, 0); // mate from White's side
    assert.equal((await call('/api/defend?tps=' + encodeURIComponent(tps) + '&komi=2')).cached, true);
    // the cache is per komi: the same position at another komi is a new search
    const k0 = await call('/api/defend?tps=' + encodeURIComponent(tps) + '&komi=0');
    assert.equal(k0.status, 200); assert.equal(k0.cached, undefined);
    assert.equal((await call('/api/defend?tps=bad')).status, 400);
    assert.equal((await call('/api/defend?tps=' + encodeURIComponent(tps) + '&komi=9')).status, 400);
    // two different uncached positions at once: the second is refused while the first runs
    const a = 'x6/x6/x6/x6/x6/2,1,x4 1 2', b = 'x6/x6/x6/x6/x6/2,x,1,x3 1 2';
    const [ra, rb] = await Promise.all([call('/api/defend?tps=' + encodeURIComponent(a)), call('/api/defend?tps=' + encodeURIComponent(b))]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 429]);
    // the review panel has its own allowance: an analyze runs while a defend is in flight
    const c = 'x6/x6/x6/x6/x6/2,x2,1,x2 1 2', d = 'x6/x6/x6/x6/x6/2,x3,1,x 1 2';
    const [rc, rd] = await Promise.all([call('/api/defend?tps=' + encodeURIComponent(c)), call('/api/analyze?tps=' + encodeURIComponent(d))]);
    assert.equal(rc.status, 200); assert.equal(rd.status, 200); assert.deepEqual(rd.pv, ['f6', 'e6']);
    // an engine move that isn't legal here (Syntaks searches its last good position when it can't parse one) is refused
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await call('/api/defend?tps=' + encodeURIComponent('x5,1/x6/x6/x6/x6/2,x5 1 2'))).status, 503);
    // the same fields as always, and no MultiPV sent to any process (analyze without lines included)
    assert.deepEqual(Object.keys(rd).sort(), ['best', 'depth', 'engine', 'mate', 'ms', 'nodes', 'pv', 'scoreCp', 'side', 'status', 'wdl', 'winProb']);
    assert.deepEqual(Object.keys(r).sort(), ['depth', 'mate', 'move', 'ms', 'side', 'status', 'winProb']);
    assert.ok(!engineLog().some((x) => /MultiPV/.test(x[1])), 'no MultiPV without lines');
  });

  await test('analyze lines=3: MultiPV lines, its own cache entry, and defend back at MultiPV 1', async () => {
    const tps = 'x6/x6/x6/x6/x6/x,2,x4 1 2', q = '/api/analyze?tps=' + encodeURIComponent(tps) + '&komi=2';
    const r3 = await call(q + '&lines=3');
    assert.equal(r3.status, 200); assert.equal(r3.multipv, true);
    assert.deepEqual(r3.lines.map((l) => l.move), ['f6', 'e5', 'd4']);
    assert.deepEqual(r3.lines.map((l) => l.depth), [5, 4, 4]);
    assert.deepEqual(r3.lines[1], { move: 'e5', scoreCp: -50, mate: null, winProb: 0.1, wdl: [100, 0, 900], pv: ['e5', 'e6'], depth: 4 }); // White's side
    for (const k of ['scoreCp', 'mate', 'winProb', 'wdl', 'pv', 'depth']) assert.deepEqual(r3[k], r3.lines[0][k], k); // the top level is line 1
    assert.equal(r3.best, 'f6'); assert.equal(r3.mate, -3);
    // lines=1 and no lines are one entry; lines=3 is another
    const r1 = await call(q + '&lines=1');
    assert.equal(r1.cached, undefined); assert.equal(r1.lines, undefined); assert.equal(r1.multipv, undefined);
    assert.equal((await call(q)).cached, true);
    assert.equal((await call(q + '&lines=')).cached, true);
    assert.equal((await call(q + '&lines=3')).cached, true);
    assert.equal((await call(q + '&lines=2')).cached, undefined);
    for (const bad of ['0', '4', 'x', '1.5', '-1', '01', ' 3']) assert.equal((await call(q + '&lines=' + encodeURIComponent(bad))).status, 400, bad);
    // a defend after a lines-3 search, on the same process: MultiPV goes back to 1 before its position (lines ignored there)
    const before = engineLog().length;
    const d = 'x6/x6/x6/x6/x6/x2,2,x3 1 2', r3b = await call('/api/analyze?tps=' + encodeURIComponent(d) + '&komi=2&lines=3');
    assert.equal(r3b.lines.length, 3);
    const def = await call('/api/defend?tps=' + encodeURIComponent('x6/x6/x6/x6/x6/x3,2,x2 1 2') + '&komi=2&lines=3');
    assert.equal(def.status, 200); assert.equal(def.move, 'f6'); assert.equal(def.lines, undefined);
    const log = engineLog().slice(before);
    const pid = log.find((x) => x[1] === 'position tps ' + d)[0];
    const seq = log.filter((x) => x[0] === pid).map((x) => x[1]);
    // per process, the MultiPV each position was searched at (the engine starts at 1)
    const at = {}; let mpv = null;
    for (const [p, c] of engineLog()) {
      if (p !== pid) continue;
      const m = c.match(/^setoption name MultiPV value (\d+)$/); if (m) mpv = +m[1];
      if (c.startsWith('position tps ')) at[c.slice(13)] = mpv ?? 1;
    }
    assert.equal(at[d], 3); assert.equal(at['x6/x6/x6/x6/x6/x3,2,x2 1 2'], 1, seq.join(' | '));
    assert.ok(seq.indexOf('setoption name MultiPV value 1') > seq.indexOf('position tps ' + d), seq.join(' | '));
    assert.ok(!seq.includes('teinewgame 6'), 'MultiPV changes keep the hash'); // same komi throughout
  });

  await test('analyze lines=3 on an engine without MultiPV: one line, multipv false', async () => {
    const FAKE1 = path.join(dir, 'fake-syntaks-1pv.mjs');
    fakeEngine(FAKE1, true);
    await stop(server);
    server = await boot(DB, { TINUE_SYNTAKS: FAKE1 });
    const r = await call('/api/analyze?tps=' + encodeURIComponent('x6/x6/x6/x6/x6/x4,2,x 1 2') + '&komi=2&lines=3');
    assert.equal(r.status, 200); assert.equal(r.multipv, false);
    assert.deepEqual(r.lines, [{ move: 'f6', scoreCp: null, mate: -3, winProb: 0, wdl: [0, 0, 1000], pv: ['f6', 'e6'], depth: 5 }]);
    assert.equal(r.mate, -3); assert.deepEqual(r.pv, ['f6', 'e6']);
  });

  // server/syntaks.js on its own (in a child process, with the fake engine): a review search a game moved up goes back
  // behind the games once that game leaves, so it doesn't hold one of the 4 game slots (a fifth game would get 503).
  await test('defend: a promoted review search gives its priority slot back when the game leaves', async () => {
    const script = `const { analyze } = await import(process.argv[1]);
const st = (p) => p.then(() => 200, (e) => e.status);
const busy = [analyze('a 1 2', 2), analyze('b 1 2', 2)]; // both engine processes busy, so the next ones queue
const review = st(analyze('x 1 2', 2));
const ctl = new AbortController(), game = st(analyze('x 1 2', 2, { priority: true, signal: ctl.signal })); // moves it up
ctl.abort();
const games = ['p 1 2', 'q 1 2', 'r 1 2', 's 1 2'].map((t) => st(analyze(t, 2, { priority: true })));
console.log(JSON.stringify(await Promise.all([review, game, ...games, ...busy.map(st)]))); process.exit(0);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, new URL('../server/syntaks.js', import.meta.url).href],
      { env: { ...process.env, TINUE_SYNTAKS: path.join(dir, 'fake-syntaks.mjs') }, encoding: 'utf8', timeout: 20e3 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [200, 499, 200, 200, 200, 200, 200, 200]);
  });
  // ...but not while another game still waits on it (two games on the same position, e.g. the daily puzzle): it keeps
  // its slot, so with three more games a fifth gets 503.
  await test('defend: a promoted search keeps its priority slot while another game waits on it', async () => {
    const script = `const { analyze } = await import(process.argv[1]);
const st = (p) => p.then(() => 200, (e) => e.status);
const busy = [analyze('a 1 2', 2), analyze('b 1 2', 2)];
const review = st(analyze('x 1 2', 2));
const ctl = new AbortController(), game = st(analyze('x 1 2', 2, { priority: true, signal: ctl.signal }));
const other = st(analyze('x 1 2', 2, { priority: true })); // a second game on the same position
ctl.abort();
const games = ['p 1 2', 'q 1 2', 'r 1 2', 's 1 2'].map((t) => st(analyze(t, 2, { priority: true })));
console.log(JSON.stringify(await Promise.all([review, game, other, ...games, ...busy.map(st)]))); process.exit(0);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, new URL('../server/syntaks.js', import.meta.url).href],
      { env: { ...process.env, TINUE_SYNTAKS: path.join(dir, 'fake-syntaks.mjs') }, encoding: 'utf8', timeout: 20e3 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [200, 499, 200, 200, 200, 200, 503, 200, 200]);
  });

  console.log(`\nOK: ${n} server tests`);
} finally {
  server.kill();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
