// players-live server: malformed and odd requests never kill it; ETag/304, gzip negotiation, change detection
// (a re-rated played puzzle with no new attempt is a new body), and errors don't leak details; /rush.json (Rush and
// Streak runs): labels, the arrays' shape, its own ETag, nothing private. Synthetic DB only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'players-live', 'server.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-players-test-'));
const dbPath = path.join(dir, 'synthetic.db');
// ---- helpers ----
function start(env) {
  const proc = spawn(process.execPath, ['--no-warnings', SERVER], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', CHECK_MS: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (b) => (err += b));
  const port = new Promise((resolve, reject) => {
    proc.stdout.on('data', (b) => { const m = /:(\d+)\s*$/m.exec(String(b)); if (m) resolve(+m[1]); });
    proc.on('exit', (c) => reject(new Error(`server exited ${c}: ${err}`)));
  });
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { proc.kill(); reject(new Error(`server did not start in 10 s: ${err}`)); }, 10e3); });
  port.then(() => clearTimeout(timer), () => clearTimeout(timer)); // only the start is timed, not the test
  return { proc, port: Promise.race([port, timeout]), stderr: () => err };
}
// raw HTTP over a socket, so malformed request lines reach the server as written
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.end(text));
    const chunks = [];
    sock.on('data', (b) => chunks.push(b));
    sock.on('error', reject);
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout: ' + JSON.stringify(text.slice(0, 40)))); });
    sock.on('close', () => {
      const buf = Buffer.concat(chunks), at = buf.indexOf('\r\n\r\n');
      const head = buf.subarray(0, at < 0 ? buf.length : at).toString(), lines = head.split('\r\n');
      const headers = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      resolve({ status: +lines[0].split(' ')[1], headers, body: at < 0 ? Buffer.alloc(0) : buf.subarray(at + 4) });
    });
  });
}
const get = (port, target, extra = '', method = 'GET') => raw(port, `${method} ${target} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n${extra}\r\n`);
// raw() does not decode chunked bodies; the server always sends Content-Length, and this checks it
const json = (r) => {
  assert.equal(r.headers['transfer-encoding'], undefined, 'data.json must not be chunked (the server sets Content-Length)');
  assert.equal(+r.headers['content-length'], r.body.length, 'Content-Length must match the body');
  return JSON.parse((r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body).toString());
};

let w = null;
try { // the temp dir and synthetic DB are removed whether the test passes or not

// ---- synthetic data (seeded, nothing real) ----
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
w = new DatabaseSync(dbPath);
w.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, gid TEXT);
  CREATE TABLE puzzles (id TEXT PRIMARY KEY, size INTEGER, plies INTEGER, turn INTEGER, grade TEXT, themes TEXT, init_rating REAL, rating REAL, rd REAL);
  CREATE TABLE attempts (user_id INTEGER, puzzle_id TEXT, win INTEGER, rated INTEGER, user_rating REAL, user_delta REAL, puzzle_rating REAL, ts INTEGER, ms INTEGER);
  CREATE TABLE guest_attempts (gid TEXT, puzzle_id TEXT, win INTEGER, hinted INTEGER, guest_rating REAL, puzzle_rating REAL, ms INTEGER, ts INTEGER);`);
w.prepare('INSERT INTO users (id, name, gid) VALUES (?, ?, ?)').run(1, 'alpha', null);
w.prepare('INSERT INTO users (id, name, gid) VALUES (?, ?, ?)').run(2, 'beta', null);
w.prepare('INSERT INTO users (id, name, gid) VALUES (?, ?, ?)').run(3, null, 'g0000000aaaaaaaa');
const P = w.prepare('INSERT INTO puzzles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (let i = 0; i < 30; i++) P.run(`p${i}`, i % 3 ? 6 : 5, [3, 5, 7][i % 3], i % 2, 'A', '', 1400 + 20 * i, 1400 + 20 * i, 250);
const A = w.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const rating = { 1: 1500, 2: 1500, 3: 1500 };
let ts = Date.now() - 3 * 864e5;
for (let i = 0; i < 240; i++) {
  const u = 1 + (i % 3), pz = `p${Math.floor(rnd() * 30)}`, win = rnd() < 0.6 ? 1 : 0, d = win ? 12 : -12;
  A.run(u, pz, win, 1, rating[u], d, 1500, (ts += 60e3 + Math.floor(rnd() * 600e3)), 20000);
  rating[u] += d;
}
const G = w.prepare('INSERT INTO guest_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
for (let i = 0; i < 5; i++) G.run('legacy00bbbbbbbb', `p${i}`, i % 2, 0, 1500 + i, 1500, 9000, (ts += 60e3));

const srv = start({ TINUE_DB: dbPath });
try {
  const port = await srv.port;

  // data, ETag, 304
  const first = await get(port, '/data.json');
  assert.equal(first.status, 200);
  const d = json(first);
  assert.equal(d.rows.length, 245);
  assert.deepEqual(d.accounts, ['alpha', 'beta'], 'accounts in creation order, guests left out');
  assert.ok(d.puzzles.calib.live.length === 10 && d.puzzles.roll.length > 0, 'calibration and rolling log-loss present');
  const etag = first.headers.etag;
  assert.ok(etag);
  const same = await get(port, '/data.json', `If-None-Match: ${etag}\r\n`);
  assert.equal(same.status, 304);
  assert.equal(same.body.length, 0);
  assert.match(same.headers.vary || '', /accept-encoding/i);

  // gzip negotiation
  assert.equal((await get(port, '/data.json', 'Accept-Encoding: gzip, deflate\r\n')).headers['content-encoding'], 'gzip');
  assert.equal((await get(port, '/data.json', 'Accept-Encoding: gzip;q=0\r\n')).headers['content-encoding'], undefined);
  assert.equal((await get(port, '/data.json', 'Accept-Encoding: br, gzip;q=0.5\r\n')).headers['content-encoding'], 'gzip');
  assert.equal(json(await get(port, '/data.json', 'Accept-Encoding: gzip\r\n')).rows.length, 245);

  // malformed and odd requests: answered, never fatal
  const odd = [
    ['GET', 'http://[', [400]],
    ['GET', 'http://[::1', [400]],
    ['GET', '/data.json?%zz&x=%E0%A4%A&&=&a[]=1', [200]],
    ['GET', '/?' + 'q'.repeat(4000), [200]],
    ['GET', '//evil.example/data.json', [200, 404]],
    ['GET', '/nope', [404]],
    ['GET', '/../../etc/passwd', [404]],
    ['HEAD', '/', [200]],
    ['HEAD', '/data.json', [200]],
    ['POST', '/data.json', [405]],
    ['DELETE', '/', [405]],
  ];
  for (const [m, target, ok] of odd) {
    const r = await get(port, target, '', m);
    assert.ok(ok.includes(r.status), `${m} ${target} → ${r.status}`);
    if (m === 'HEAD') assert.equal(r.body.length, 0, `${m} ${target} has no body`);
  }
  for (const junk of ['BLAH\r\n\r\n', 'GET / HTTP/9.9\r\n\r\n', 'GET /data.json HTTP/1.1\r\nHost: t\r\nContent-Length: x\r\n\r\n', '\x00\x01\x02\r\n\r\n']) {
    const r = await raw(port, junk);
    assert.ok(!r.status || r.status >= 400, `junk ${JSON.stringify(junk.slice(0, 12))} → ${r.status}`);
  }
  assert.equal(srv.proc.exitCode, null, 'server survived the odd requests');
  assert.equal((await get(port, '/data.json', `If-None-Match: ${etag}\r\n`)).status, 304, 'still serving after the odd requests');

  // change detection: an unplayed puzzle doesn't matter; re-rating a played one with no new attempt does
  w.prepare('INSERT INTO puzzles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('unplayed', 6, 5, 0, 'A', '', 1500, 1500, 250);
  assert.equal((await get(port, '/data.json', `If-None-Match: ${etag}\r\n`)).status, 304, 'an unplayed puzzle does not change the body');
  const played = w.prepare('SELECT a.puzzle_id id, p.rating r FROM attempts a JOIN puzzles p ON p.id = a.puzzle_id LIMIT 1').get();
  w.prepare('UPDATE puzzles SET rating = rating + 37 WHERE id = ?').run(played.id);
  const moved = await get(port, '/data.json', `If-None-Match: ${etag}\r\n`);
  assert.equal(moved.status, 200, 'a re-rated played puzzle is a new body');
  assert.notEqual(moved.headers.etag, etag);
  assert.equal(json(moved).puzzles.puzzles.find((p) => p.id === played.id).rating, Math.round(played.r + 37));
  // in-place edits real writers make: a theme rename, a regrade, a same-length user rename, a refund-style attempt edit
  let tag = moved.headers.etag;
  const changed = async (what, sql, args, check) => {
    w.prepare(sql).run(...args);
    const r = await get(port, '/data.json', `If-None-Match: ${tag}\r\n`);
    assert.equal(r.status, 200, `${what} is a new body`);
    assert.notEqual(r.headers.etag, tag, `${what} changes the ETag`);
    check(json(r)); tag = r.headers.etag;
  };
  await changed('a theme change', 'UPDATE puzzles SET themes = ? WHERE id = ?', ['Fork', played.id], (d) => assert.equal(d.puzzles.puzzles.find((p) => p.id === played.id).themes, 'Fork'));
  await changed('a grade change', 'UPDATE puzzles SET grade = ? WHERE id = ?', ['B', played.id], (d) => assert.equal(d.puzzles.puzzles.find((p) => p.id === played.id).grade, 'B'));
  await changed('a same-length rename', 'UPDATE users SET name = ? WHERE id = ?', ['gamma', 1], (d) => { assert.ok(d.rows.some((r) => r.player === 'gamma') && !d.rows.some((r) => r.player === 'alpha')); assert.deepEqual(d.accounts, ['gamma', 'beta'], 'a rename keeps its place, so its colour'); });
  const one = w.prepare('SELECT rowid, ts FROM attempts WHERE win = 1 ORDER BY rowid LIMIT 1').get();
  await changed('an in-place attempt edit', 'UPDATE attempts SET win = 0, rated = 0, user_delta = -10 WHERE rowid = ?', [one.rowid],
    (d) => { const r = d.rows.find((x) => x.t === one.ts); assert.equal(r.win, 0); assert.equal(r.rated, 0);
      assert.equal(r.refund, 1, 'rated = 0, win = 0, user_delta <> 0 is a refunded miss');
      assert.equal(d.rows.filter((x) => x.refund).length, 1, 'and only that one');
      const st = d.puzzles.puzzles.flatMap((p) => p.steps).filter((x) => x.refund);
      assert.equal(st.length, 1); assert.equal(st[0].t, one.ts); assert.equal(typeof st[0].kept, 'number'); });
  // every other input the page reads: a legacy guest row, attempt ms and puzzle_rating, puzzle init_rating and turn, a guest's gid
  await changed('a legacy guest edit', 'UPDATE guest_attempts SET guest_rating = 1777 WHERE rowid = 1', [],
    (d) => assert.equal(d.rows.find((r) => r.player === 'guest legacy00' && r.n === 1).before, 1777));
  const two = w.prepare('SELECT rowid, ts FROM attempts ORDER BY rowid LIMIT 1 OFFSET 1').get();
  await changed('an attempt ms edit', 'UPDATE attempts SET ms = 4321 WHERE rowid = ?', [two.rowid], (d) => assert.equal(d.rows.find((r) => r.t === two.ts).ms, 4321));
  await changed('an attempt puzzle_rating edit', 'UPDATE attempts SET puzzle_rating = 1666 WHERE rowid = ?', [two.rowid], (d) => assert.equal(d.rows.find((r) => r.t === two.ts).puzzle_rating, 1666));
  await changed('a puzzle init_rating edit', 'UPDATE puzzles SET init_rating = 1234 WHERE id = ?', [played.id], (d) => assert.equal(d.puzzles.puzzles.find((p) => p.id === played.id).init, 1234));
  await changed('a puzzle turn edit', 'UPDATE puzzles SET turn = 1 - turn WHERE id = ?', [played.id], () => {});
  await changed('a guest gid edit', 'UPDATE users SET gid = ? WHERE id = 3', ['g1111111aaaaaaaa'], (d) => assert.ok(d.rows.some((r) => r.player === 'guest g1111111')));
  // NULL and Infinity both serialise to null in JSON; the stamp must still tell them apart
  await changed('ms set to NULL', 'UPDATE attempts SET ms = NULL WHERE rowid = ?', [two.rowid], () => {});
  await changed('ms NULL to Infinity', 'UPDATE attempts SET ms = 9e999 WHERE rowid = ?', [two.rowid], () => {});
  assert.equal((await get(port, '/data.json', `If-None-Match: ${tag}\r\n`)).status, 304, 'and unchanged again after that');
  A.run(1, 'p4', 1, 1, rating[1], 9, 1500, (ts += 60e3), 15000);
  assert.equal(json(await get(port, '/data.json', `If-None-Match: ${tag}\r\n`)).rows.length, 246, 'a new attempt shows up');

  // refunds: what is left of a refunded miss in its puzzle's rating
  const fresh = async () => { const r = await get(port, '/data.json'); tag = r.headers.etag; return json(r); };
  const pz = (d, id) => d.puzzles.puzzles.find((p) => p.id === id);
  P.run('kept', 6, 5, 1, 'A', '', 1500, 1520, 220); P.run('reset', 6, 5, 1, 'A', '', 1600, 1600, 250); P.run('plain', 6, 5, 1, 'A', '', 1700, 1700, 250);
  const tKept = (ts += 60e3), tNext = (ts += 60e3), tReset = (ts += 60e3), tPlain = (ts += 60e3);
  A.run(1, 'kept', 0, 0, 1500, -11, 1500, tKept, 9000); // refunded miss: the puzzle went 1500 → 1540 on it and stayed there
  A.run(2, 'kept', 1, 1, 1500, 12, 1540, tNext, 9000);
  A.run(1, 'reset', 0, 0, 1500, -11, 1600, tReset, 9000); // refunded miss on a puzzle put back to its start
  A.run(2, 'plain', 0, 0, 1500, 0, 1700, tPlain, 9000); // recorded unrated (a hint): no user_delta, not a refund
  let rd = await fresh();
  assert.deepEqual(pz(rd, 'kept').steps.map((x) => [x.refund ?? 0, x.kept ?? null]), [[1, 40], [0, null]], 'the rise across a refunded miss is what it kept');
  assert.deepEqual([pz(rd, 'reset').steps[0].refund, pz(rd, 'reset').steps[0].kept], [1, 0], 'a puzzle back at its start keeps nothing');
  assert.equal(pz(rd, 'plain').steps[0].refund, undefined, 'an attempt recorded unrated is not a refund');
  assert.equal(rd.rows.find((r) => r.t === tPlain).refund, undefined);
  assert.equal(rd.rows.find((r) => r.t === tKept).refund, 1);
  assert.equal(pz(rd, 'kept').flaw, undefined, 'no flaw column yet');
  w.exec('ALTER TABLE puzzles ADD COLUMN flaw INTEGER'); await fresh();
  await changed('a refund mark on a puzzle', "UPDATE puzzles SET flaw = 2 WHERE id = 'kept'", [], (d) => { assert.equal(pz(d, 'kept').flaw, 2); assert.equal(pz(d, 'reset').flaw, undefined); });
  // a ledger refund (scripts/refund.mjs): the miss's own rise and the compensating move come from the events, wherever they landed
  w.exec(`CREATE TABLE attempt (id INTEGER PRIMARY KEY, user_id INTEGER, puzzle_id TEXT NOT NULL, first INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE rating_event (id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL, by TEXT NOT NULL, weight REAL NOT NULL,
      user_before TEXT, user_after TEXT, puzzle_before TEXT, puzzle_after TEXT, note TEXT);
    INSERT INTO attempt (id, user_id, puzzle_id, first) VALUES (7, 1, 'kept', 1);
    INSERT INTO rating_event (attempt_id, kind, ts, by, weight, puzzle_before, puzzle_after) VALUES (7, 'rate', ${tKept}, 'server', 1, '{"rating":1500,"rd":250}', '{"rating":1540,"rd":220}');`);
  rd = await fresh();
  assert.deepEqual([pz(rd, 'kept').steps[0].kept, pz(rd, 'kept').steps[0].back, pz(rd, 'kept').steps[0].rt], [40, undefined, undefined], 'a rate event alone changes nothing');
  await changed('a ledger refund', `INSERT INTO rating_event (attempt_id, kind, ts, by, weight, puzzle_before, puzzle_after) VALUES (7, 'refund', ${tNext + 5}, 'refund.mjs', 1, '{"rating":1520}', '{"rating":1482.4}')`, [],
    (d) => { assert.deepEqual([pz(d, 'kept').steps[0].refund, pz(d, 'kept').steps[0].kept, pz(d, 'kept').steps[0].back, pz(d, 'kept').steps[0].rt], [1, 2, -38, tNext + 5]);
      // the refund's own move (1520 -> 1482.4 in puzzles.rating) is a step of its own at its time, not part of the solve before it
      assert.deepEqual(pz(d, 'kept').steps.map((x) => [x.fix ?? 0, x.t, x.after, x.back ?? null]), [[0, tKept, 1540, -38], [0, tNext, 1558, null], [1, tNext + 5, 1520, -38]]);
      assert.equal(pz(d, 'kept').plays, 2); });
  await changed('a ledger refund edit', "UPDATE rating_event SET puzzle_after = '{\"rating\":1480}' WHERE kind = 'refund'", [], (d) => assert.deepEqual([pz(d, 'kept').steps[0].kept, pz(d, 'kept').steps[0].back], [0, -40]));
  // a refund counted as a solve (2026-11-20): attempts.refund = 1 on a row that now reads as a solve; nothing is "kept"
  w.exec('ALTER TABLE attempts ADD COLUMN refund INTEGER'); rd = await fresh();
  assert.equal(rd.rows.find((r) => r.t === tKept).won, undefined, 'the legacy signature still reads as a refunded miss');
  await changed('a refund counted as a solve', 'UPDATE attempts SET win = 1, rated = 1, user_delta = 9, refund = 1 WHERE ts = ?', [tKept], (d) => {
    const row = d.rows.find((r) => r.t === tKept), st = pz(d, 'kept').steps[0];
    assert.deepEqual([row.refund, row.won, row.win, row.after - row.before], [1, 1, 1, 9]);
    assert.deepEqual([st.refund, st.won, st.kept, st.rt], [1, 1, undefined, tNext + 5]);
    assert.equal(d.rows.find((r) => r.t === tReset).won, undefined); });
  w.exec('ALTER TABLE attempts DROP COLUMN refund'); await fresh(); // (the fixture below inserts attempts by position)

  // ---- /rush.json: Rush and Streak runs (its own snapshot and ETag) ----
  const dataTag = (await get(port, '/data.json')).headers.etag;
  const none = await get(port, '/rush.json');
  assert.equal(none.status, 200, 'a database from before Rush still answers');
  assert.deepEqual([json(none).total, json(none).runs.length, json(none).players.length], [0, 0, 0]);
  // the tables as server/rush.js makes them (every column, so a read of a missing one would fail here)
  w.exec(`ALTER TABLE users ADD COLUMN token TEXT; ALTER TABLE users ADD COLUMN email TEXT;
    CREATE TABLE rush_runs (id INTEGER PRIMARY KEY, user_id INTEGER, gid TEXT, named INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL, size INTEGER NOT NULL,
      score INTEGER NOT NULL, moves INTEGER NOT NULL, errors INTEGER NOT NULL, best_combo INTEGER NOT NULL, ms INTEGER NOT NULL, build INTEGER, user_rating REAL,
      day TEXT NOT NULL, week TEXT NOT NULL, ts INTEGER NOT NULL, run TEXT, abandoned INTEGER NOT NULL DEFAULT 0, minted_at INTEGER, played_at INTEGER, late INTEGER,
      units INTEGER, input TEXT, confirm INTEGER, calm INTEGER, width TEXT, paused_ms INTEGER);
    CREATE TABLE rush_puzzles (run_id INTEGER NOT NULL, pos INTEGER NOT NULL, puzzle_id TEXT NOT NULL, mode TEXT NOT NULL, solved INTEGER NOT NULL,
      skipped INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL, wrong TEXT, clock_ms INTEGER, combo INTEGER, puzzle_rating REAL, user_id INTEGER, user_rating REAL,
      ts INTEGER NOT NULL, hidden INTEGER, nmoves INTEGER, unfinished INTEGER, sym INTEGER, PRIMARY KEY (run_id, pos));
    CREATE TABLE rush_moves (run_id INTEGER NOT NULL, pos INTEGER NOT NULL, n INTEGER NOT NULL, first_ms INTEGER, ms INTEGER NOT NULL, held_ms INTEGER,
      weight INTEGER NOT NULL, correct INTEGER NOT NULL, at_ms INTEGER, ptn TEXT, clock_ms INTEGER, check_v TEXT, check_ms INTEGER, paused_ms INTEGER, open INTEGER,
      path TEXT, final_v TEXT, final_ms INTEGER, credit INTEGER, PRIMARY KEY (run_id, pos, n));
    CREATE TABLE rush_playouts (run_id INTEGER NOT NULL, pos INTEGER NOT NULL, n INTEGER NOT NULL, proven INTEGER NOT NULL, cap INTEGER NOT NULL, ending TEXT,
      paused_ms INTEGER NOT NULL, moves TEXT NOT NULL, PRIMARY KEY (run_id, pos, n));`);
  w.prepare("UPDATE users SET token = 'TOKEN-SENTINEL-' || id, email = 'EMAIL-SENTINEL-' || id").run();
  const RR = w.prepare(`INSERT INTO rush_runs (user_id, gid, named, mode, size, score, moves, errors, best_combo, ms, user_rating, day, week, ts, run, abandoned, played_at, late, input, width, paused_ms)
    VALUES (?, ?, ?, ?, 6, ?, ?, ?, ?, ?, ?, '2026-01-01', '2025-12-29', ?, ?, ?, ?, ?, 'mouse', 'desktop', ?)`);
  const RP = w.prepare(`INSERT INTO rush_puzzles (run_id, pos, puzzle_id, mode, solved, skipped, ms, wrong, clock_ms, combo, puzzle_rating, user_id, user_rating, ts, hidden, nmoves, unfinished)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const RM = w.prepare(`INSERT INTO rush_moves (run_id, pos, n, first_ms, ms, weight, correct, at_ms, ptn, clock_ms, check_v, check_ms, paused_ms, open)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let runNo = 0;
  // a synthetic run: `n` puzzles, one move each, the last one wrong; returns its id
  function addRun({ user = null, gid = null, mode = 'rush', score = 3, n = 4, abandoned = 0, late = 0, paused = 0 }) {
    const t = (ts += 600e3), id = Number(RR.run(user, gid, user === 1 ? 1 : 0, mode, score, n, 1, n - 1, n * 4000, user ? 1600 : null, t, `run${++runNo}`, abandoned, t - 1000, late, paused).lastInsertRowid);
    for (let pos = 0; pos < n; pos++) {
      const last = pos === n - 1;
      RP.run(id, pos, `p${pos}`, mode, last ? 0 : 1, 0, 3500, last ? 'a1' : null, mode === 'rush' ? 180e3 - (pos + 1) * 4000 : null, last ? 0 : pos + 1, 1400 + 20 * pos, user, user ? 1600 : null, t, 0, 1, abandoned && last ? 1 : 0);
      RM.run(id, pos, 0, 900, 3000, 1, last ? 0 : 1, (pos + 1) * 4000, last ? 'a1' : 'b2', mode === 'rush' ? 180e3 - (pos + 1) * 4000 : null, last ? 'no' : null, last ? 120 : null, last ? 150 : null, null);
    }
    return id;
  }
  const r1 = addRun({ user: 1, score: 3, paused: 150 });
  addRun({ user: 1, score: 9, n: 10, abandoned: 1 });               // left early: never a best
  addRun({ user: 1, mode: 'streak', score: 5, n: 6 });
  addRun({ gid: 'g1111111aaaaaaaa', score: 2, n: 3 });              // a tokenless run whose gid now belongs to user 3
  addRun({ user: 3, score: 4, n: 5 });
  const lone = addRun({ gid: 'lonelygidSECRETTAIL', score: 1, n: 2 }); // a tokenless browser nobody claimed
  w.prepare("INSERT INTO rush_playouts VALUES (?, 3, 0, 1, 6, 'win', 800, ?)").run(r1, JSON.stringify([{ m: 'a1', ms: 5 }, { m: 'b1', ms: 6 }]));
  const rushed = await get(port, '/rush.json');
  const ru = json(rushed);
  assert.deepEqual([ru.total, ru.shown, ru.runs.length], [6, 6, 6]);
  const pl = Object.fromEntries(ru.players.map((p) => [p.player, p]));
  assert.deepEqual(Object.keys(pl).sort(), ['gamma', 'guest g1111111', 'guest lonelygi'], 'players labelled as on the rest of the page; a claimed gid joins its user');
  assert.deepEqual([pl.gamma.kind, pl.gamma.rush.runs, pl.gamma.rush.left, pl.gamma.rush.best, pl.gamma.streak.runs, pl.gamma.streak.best], ['account', 1, 1, 3, 1, 5], 'a run left early is counted apart and is never a best');
  assert.deepEqual([pl['guest g1111111'].rush.runs, pl['guest g1111111'].rush.best, pl['guest g1111111'].kind], [2, 4, 'guest']);
  const run1 = ru.runs.find((r) => r.id === r1);
  assert.deepEqual([run1.player, run1.mode, run1.score, run1.left, run1.late, run1.ur, run1.paused, run1.pz.length, run1.mv.length], ['gamma', 'rush', 3, 0, 0, 1600, 150, 4, 4]);
  assert.deepEqual(run1.pz[0], ['p0', 1400, 1, 3500, 176000, 1, 0, null]);
  assert.deepEqual(run1.pz[3].slice(0, 3).concat(run1.pz[3][7]), ['p3', 1460, 0, 'a1'], 'a missed puzzle carries its wrong move');
  assert.deepEqual(run1.mv[0], [0, 0, 900, 3000, 4000, 176000, 1, 1, 'b2'], 'trailing NULLs are dropped');
  assert.deepEqual(run1.mv[3], [3, 0, 900, 3000, 16000, 164000, 1, 0, 'a1', 'no', 150, null, null, null, 120]);
  assert.deepEqual(run1.po, [[3, 0, 1, 6, 'win', 800, 2]]);
  // what the score-against-real-time chart places a run by: when it ended on the player's device, how long it ran, each move's at_ms
  const row1 = w.prepare('SELECT ts, played_at, ms FROM rush_runs WHERE id = ?').get(r1);
  assert.deepEqual([run1.t, run1.posted, run1.ms], [row1.played_at, row1.ts, 16000]);
  assert.equal(row1.ts - row1.played_at, 1000);
  assert.deepEqual(run1.mv.map((m) => m[4]), [4000, 8000, 12000, 16000], 'at_ms, in the order played');
  assert.equal(ru.runs.find((r) => r.left).pz.at(-1)[2], 3, 'the puzzle an abandoned run was left on is unfinished');
  const text = JSON.stringify(ru) + JSON.stringify(json(await get(port, '/data.json')));
  assert.ok(!/SENTINEL|SECRETTAIL|g1111111a/.test(text), 'no token, no email, no whole gid in either body');
  assert.ok(ru.runs.find((r) => r.id === lone).player === 'guest lonelygi');
  // its own ETag: unchanged polls are 304; a rated attempt leaves it alone; a Rush run leaves /data.json alone
  let rtag = rushed.headers.etag;
  assert.equal((await get(port, '/rush.json', `If-None-Match: ${rtag}\r\n`)).status, 304);
  assert.equal((await get(port, '/rush.json', 'Accept-Encoding: gzip\r\n')).headers['content-encoding'], 'gzip');
  assert.equal((await get(port, '/data.json', `If-None-Match: ${dataTag}\r\n`)).status, 304, 'Rush runs do not rebuild /data.json');
  A.run(2, 'p5', 1, 1, rating[2], 9, 1500, (ts += 60e3), 15000);
  assert.equal((await get(port, '/rush.json', `If-None-Match: ${rtag}\r\n`)).status, 304, 'a rated attempt does not rebuild /rush.json');
  const rchanged = async (what, sql, args, check) => {
    w.prepare(sql).run(...args);
    const r = await get(port, '/rush.json', `If-None-Match: ${rtag}\r\n`);
    assert.equal(r.status, 200, `${what} is a new Rush body`);
    assert.notEqual(r.headers.etag, rtag);
    check(json(r)); rtag = r.headers.etag;
  };
  await rchanged('a move time edit', 'UPDATE rush_moves SET first_ms = 777 WHERE run_id = ? AND pos = 0', [r1], (d) => assert.equal(d.runs.find((r) => r.id === r1).mv[0][2], 777));
  await rchanged('a puzzle result edit', 'UPDATE rush_puzzles SET solved = 0, wrong = ? WHERE run_id = ? AND pos = 1', ['c3', r1], (d) => assert.deepEqual(d.runs.find((r) => r.id === r1).pz[1].slice(2, 3).concat(d.runs.find((r) => r.id === r1).pz[1][7]), [0, 'c3']));
  await rchanged('a run score edit', 'UPDATE rush_runs SET score = 2 WHERE id = ?', [r1], (d) => assert.equal(d.players.find((p) => p.player === 'gamma').rush.best, 2));
  await rchanged('a run length edit', 'UPDATE rush_runs SET ms = 17000 WHERE id = ?', [r1], (d) => assert.equal(d.runs.find((r) => r.id === r1).ms, 17000));
  await rchanged('a played_at edit', 'UPDATE rush_runs SET played_at = played_at - 5000 WHERE id = ?', [r1], (d) => assert.equal(d.runs.find((r) => r.id === r1).t, row1.played_at - 5000));
  await rchanged('a run from before played_at', 'UPDATE rush_runs SET played_at = NULL WHERE id = ?', [r1], (d) => assert.equal(d.runs.find((r) => r.id === r1).t, row1.ts, 'placed by when it was posted'));
  await rchanged('a move at_ms edit', 'UPDATE rush_moves SET at_ms = 4100 WHERE run_id = ? AND pos = 0', [r1], (d) => assert.equal(d.runs.find((r) => r.id === r1).mv[0][4], 4100));
  await rchanged('a play-out edit', "UPDATE rush_playouts SET ending = 'road', moves = 'not json' WHERE run_id = ?", [r1], (d) => assert.deepEqual(d.runs.find((r) => r.id === r1).po[0].slice(4), ['road', 800, null]));
  await rchanged('a rename', 'UPDATE users SET name = ? WHERE id = 1', ['delta'], (d) => assert.ok(d.runs.some((r) => r.player === 'delta') && !d.runs.some((r) => r.player === 'gamma')));
  // only the latest 200 runs travel in full; the players table still counts every one
  w.exec('BEGIN'); for (let i = 0; i < 210; i++) addRun({ user: 2, score: 1, n: 2 }); w.exec('COMMIT');
  const many = json(await get(port, '/rush.json'));
  assert.deepEqual([many.total, many.shown, many.runs.length], [216, 200, 200]);
  assert.ok(!many.runs.some((r) => r.id === r1) && many.runs.every((r) => r.pz.length === 2 && r.mv.length === 2), 'older runs drop out whole, the rest arrive whole');
  assert.equal(many.players.find((p) => p.player === 'beta').rush.runs, 210);
  assert.equal(many.players.find((p) => p.player === 'delta').rush.best, 2, 'a player whose runs all dropped out is still listed');
  for (const [m, target, ok] of [['HEAD', '/rush.json', 200], ['POST', '/rush.json', 405], ['GET', '/rush.json?x=%zz', 200]]) assert.equal((await get(port, target, '', m)).status, ok, `${m} ${target}`);
  assert.equal(srv.proc.exitCode, null);
} finally { srv.proc.kill(); }

// a broken DB is a 500 with a generic message: no path, no SQLite text
const missing = path.join(dir, 'no-such-dir', 'missing.db');
const bad = start({ TINUE_DB: missing });
try {
  const port = await bad.port;
  const r = await get(port, '/data.json');
  assert.equal(r.status, 500);
  assert.ok(!r.body.toString().includes(dir) && !/sqlite|open/i.test(r.body.toString()), 'error body leaks nothing: ' + r.body);
  assert.equal((await get(port, '/data.json')).status, 500, 'and it keeps answering');
  assert.equal((await get(port, '/rush.json')).status, 500);
  assert.equal(bad.proc.exitCode, null);
  assert.match(bad.stderr(), /unable to open|no such|SQLITE|cannot open/i, 'the real error goes to the server log');
} finally { bad.proc.kill(); }

// Served to the public: the DB is looked at CHECK_MS apart at most, however many requests come, and every answer
// carries the safety headers.
const held = start({ TINUE_DB: dbPath, CHECK_MS: '600' });
try {
  const port = await held.port;
  const a = await get(port, '/data.json');
  assert.equal(a.status, 200);
  w.prepare('UPDATE users SET name = ? WHERE id = 2').run('held-back');
  const b = await get(port, '/data.json');
  assert.equal(b.headers.etag, a.headers.etag, 'a change inside the interval is not read yet');
  assert.equal((await get(port, '/data.json', `If-None-Match: ${a.headers.etag}\r\n`)).status, 304);
  await new Promise((r) => setTimeout(r, 700));
  const c = await get(port, '/data.json');
  assert.notEqual(c.headers.etag, a.headers.etag, 'and is read once the interval has passed');
  assert.ok(json(c).rows.some((r) => r.player === 'held-back'));
  const page = await get(port, '/');
  assert.match(page.headers['content-security-policy'], /default-src 'none'.*connect-src 'self'.*frame-ancestors 'none'/);
  for (const r of [a, page, await get(port, '/nope'), await get(port, '/data.json', '', 'POST')]) {
    assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['referrer-policy'], 'no-referrer'); assert.equal(r.headers['x-frame-options'], 'DENY');
  }
} finally { held.proc.kill(); }
// a failing DB is tried, and logged, once an interval, not once a request
const quiet = start({ TINUE_DB: missing, CHECK_MS: '60000' });
try {
  const port = await quiet.port;
  for (let i = 0; i < 5; i++) assert.equal((await get(port, '/data.json')).status, 500);
  assert.equal(quiet.stderr().split('GET "/data.json"').length - 1, 1, 'one log entry for five failing requests: ' + quiet.stderr());
  assert.equal(quiet.proc.exitCode, null);
} finally { quiet.proc.kill(); }

// ---- percentile feedback: the page's own maths, cut out of index.html between its markers ----
{
  const html = fs.readFileSync(path.join(HERE, 'players-live', 'index.html'), 'utf8');
  const src = html.split('/* pf:begin */')[1]?.split('/* pf:end */')[0];
  assert.ok(src, 'the maths is between its markers');
  const PF = new Function(`${src}; return PF;`)();
  const tz = process.env.TZ, H = 36e5;
  const row = (t, player = 'a', win = 1) => ({ t: +t, player, win });
  const day = (d, hh = 0, mm = 0, mo = 5) => +new Date(2026, mo, d, hh, mm);
  const deep = (m) => JSON.stringify({ c: m.clock, t: m.today, p: m.past });
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), 480, 'the zone took');
    // rank: ties half; median
    assert.equal(PF.rank([1, 2, 3, 4], 3), 62.5); assert.equal(PF.rank([0, 0], 0), 50); assert.equal(PF.rank([], 1), null); assert.equal(PF.rank([1], null), null);
    assert.equal(PF.median([3, 1, 2]), 2); assert.equal(PF.median([4, 1]), 2.5); assert.equal(PF.median([]), null);
    // empty data
    let m = PF.days([], day(10, 12));
    assert.equal(m.past.length, 0);
    assert.deepEqual(PF.at(m, 'attempts', m.clock), { value: 0, days: 0, median: null, few: 'days', pr: null });
    assert.equal(PF.at(m, 'solved', m.clock).value, null); assert.equal(PF.hist(m, 'attempts', 9 * H, 10, 1), null);
    // only today; then the first, partial day is never compared with
    assert.equal(PF.days([row(day(10, 9))], day(10, 12)).past.length, 0);
    assert.equal(PF.days([row(day(9, 9)), row(day(10, 9))], day(10, 12)).past.length, 0);
    assert.equal(PF.days([row(day(8, 9)), row(day(10, 9))], day(10, 12)).past.length, 1, 'a day nobody played is a day');
    // since: earlier days are not compared with, but a player seen on one is not new
    {
      const rs = [row(day(5, 9)), row(day(6, 9), 'b'), row(day(8, 9), 'b'), row(day(9, 9), 'c')];
      const mm = PF.days(rs, day(10, 12), day(8));
      assert.deepEqual(mm.past.map((d) => d.t0), [day(8), day(9)]);
      assert.deepEqual(mm.past.map((d) => PF.valueAt(d.fresh, 12 * H)), [0, 1]);
      assert.equal(PF.days(rs, day(10, 12), day(1)).past.length, 4, 'since before the data changes nothing');
      assert.equal(deep(PF.days(rs, day(10, 12), 0)), deep(PF.days(rs, day(10, 12))));
      assert.equal(PF.days(rs, day(10, 12), day(20)).past.length, 0);
    }
    // seven whole days, day i with i attempts at 09:00 (all missed but the first) and one at 20:00; day 5 empty
    const rows = [row(day(1, 9), 'z')];
    for (let i = 2; i <= 8; i++) if (i !== 5) { for (let j = 0; j < i; j++) rows.push(row(day(i, 9, j), `p${j}`, j ? 0 : 1)); rows.push(row(day(i, 20), 'late')); }
    for (let j = 0; j < 5; j++) rows.push(row(day(9, 10, j), j ? 'p0' : 'new', j % 2));
    rows.push(row(day(9, 18), 'future'));
    m = PF.days(rows, day(9, 12));
    let q = PF.at(m, 'attempts', m.clock);
    // past by noon: 2 3 4 0 6 7 8; today 5 beats 4 of 7
    assert.equal(q.value, 5, 'a row ahead of now is not counted'); assert.equal(q.days, 7); assert.equal(q.median, 4); assert.equal(q.pr, 400 / 7);
    q = PF.at(m, 'solved', m.clock);
    assert.equal(q.value, 0.4); assert.equal(q.days, 6, 'an empty day has no solved share'); // 1/2 1/3 1/4 1/6 1/7 1/8
    assert.equal(q.pr, 500 / 6);
    q = PF.at(m, 'players', m.clock); assert.equal(q.value, 2); assert.equal(q.pr, 150 / 7, 'a tie counts half');
    q = PF.at(m, 'fresh', m.clock); assert.equal(q.value, 1); // past: p0 p1 | p2 | p3 | 0 | p4 p5 | p6 | p7
    assert.equal(q.pr, (100 * (1 + 4 / 2)) / 7);
    // earlier in the day; solved is withheld until five attempts, counts are not
    assert.equal(PF.at(m, 'attempts', 9.5 * H).value, 0); assert.equal(PF.at(m, 'attempts', 9.5 * H).pr, 100 * 0.5 / 7);
    assert.equal(PF.at(m, 'solved', 9.5 * H).value, null);
    assert.equal(PF.at(m, 'solved', 10 * H + 3 * 6e4).pr, null); assert.equal(PF.at(m, 'solved', 10 * H + 4 * 6e4).pr, 500 / 6);
    // the solved share can fall
    assert.ok(m.today.solved.v[1] > m.today.solved.v[2]);
    // at a step's own moment it counts; a moment before it does not
    assert.equal(PF.valueAt(m.past[0].attempts, 9 * H), 1); assert.equal(PF.valueAt(m.past[0].attempts, 9 * H - 1), 0);
    // four days are too few; five are enough
    for (const [n, some] of [[4, false], [5, true]]) {
      const mm = PF.days([row(day(1, 9)), row(day(2 + n, 8))], day(2 + n, 12));
      assert.equal(mm.past.length, n); assert.equal(PF.at(mm, 'attempts', mm.clock).pr != null, some);
    }
    assert.equal(PF.quantile([1, 2, 3, 4], 0.5), 2.5); assert.equal(PF.quantile([1, 2, 3, 4, 5], 0.25), 2); assert.equal(PF.quantile([7], 0.9), 7);
    // histograms: every past day with a value is in exactly one bin, today's bin is marked up to now and not after
    for (const k of PF.KEYS) for (let c = 0; c <= PF.DAY; c += H) {
      const hi = k === 'solved' ? 1 : 5, w = k === 'solved' ? 0.1 : 1, b = PF.hist(m, k, c, hi, w), a = PF.at(m, k, c);
      assert.equal(b === null, a.days < PF.MIN_DAYS);
      if (!b) continue;
      assert.equal(b.n.length, k === 'solved' ? 11 : 6); assert.equal(b.n.reduce((x, y) => x + y), a.days);
      assert.equal(b.me === -1, c > m.clock || a.value == null);
    }
    { // past by noon: 2 3 4 0 6 7 8, today 5
      let b = PF.hist(m, 'attempts', 12 * H, 10, 1); assert.deepEqual(b.n, [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0]); assert.equal(b.me, 5);
      b = PF.hist(m, 'attempts', 12 * H, 6, 2); assert.deepEqual(b.n, [1, 2, 1, 3], '6 and up is past the last bin'); assert.equal(b.me, 2);
      for (const [v, i] of [[0, 0], [0.1, 1], [0.3, 3], [0.6, 6], [0.7, 7], [0.999, 9], [1, 9]]) {
        const d = { solved: { c: [0], v: [v], before: null } }, mm = { today: d, past: Array(5).fill(d), clock: H };
        b = PF.hist(mm, 'solved', H, 1, 0.1); assert.equal(b.n[i], 5, `solved ${v}`); assert.equal(b.me, i); assert.equal(b.n[10], 0);
      }
      for (const [hi, step, w] of [[600, 200, 40], [30, 10, 2], [15, 5, 1], [2, 1, 1], [10, 5, 1], [40, 20, 4], [3, 1, 1], [1500, 500, 100]]) {
        assert.equal(PF.binWidth('attempts', hi, step), w, `${hi}`); assert.ok(hi / w <= 15 && Number.isInteger(hi / w));
      }
    }
    assert.equal(PF.hist({ ...m, past: m.past.slice(0, 4) }, 'attempts', 12 * H, 10, 1), null);
    // why there is no percentile
    assert.equal(PF.at(m, 'solved', 9.5 * H).few, 'tries'); assert.equal(PF.at(m, 'solved', m.clock).few, ''); assert.equal(PF.at(PF.days(rows, day(5, 12)), 'solved', 12 * H).few, 'days');
    // a row with no usable time makes no days, and its player is still not new
    for (const t of [0, null, undefined, NaN, -5, 1.78e9]) {
      const mm = PF.days([{ t, player: 'new', win: 1 }, ...rows], day(9, 12));
      assert.equal(mm.past.length, 7, `t ${t}`); assert.equal(PF.at(mm, 'attempts', mm.clock).pr, 400 / 7); assert.equal(PF.at(mm, 'fresh', mm.clock).value, 0);
    }
    assert.equal(PF.days([{ t: 0, player: 'x', win: 1 }], day(9, 12)).past.length, 0);
    // 0 and 100 are shown only when exact
    assert.deepEqual([0, 0.17, 0.5, 49.5, 99.4, 99.83, 100].map(PF.whole), [0, 1, 1, 50, 99, 99, 100]);
    assert.equal(PF.whole(PF.rank([...Array(299).fill(1), 9], 9)), 99);
    // the axis: today always fits, one freak day among many does not set it, quiet data keeps a floor
    const line = (v) => ({ attempts: { v: v ? [1, v] : [], before: 0 } });
    const top = (past, today) => PF.top({ past: past.map(line), today: line(today) }, 'attempts');
    assert.equal(top([...Array(10).fill(40), 900], 22), 40); assert.equal(top(Array(5).fill(40), 300), 300); assert.equal(top([], 0), 2); assert.equal(top([0, 0, 0, 0, 0], 0), 2);
    assert.equal(PF.quantile([...Array(10).fill(40), 900], 0.9), 40, 'a freak day among eleven');
    // DST: spring forward 2026-03-08 (23 h), back 2026-11-01 (25 h)
    const spring = PF.days([row(day(6, 9, 0, 2)), row(day(8, 1, 30, 2)), row(day(8, 3, 30, 2)), row(day(8, 9, 0, 2)), row(day(8, 23, 59, 2))], day(9, 9, 0, 2));
    assert.deepEqual(spring.past.map((d) => (d.t1 - d.t0) / H), [24, 23]);
    assert.deepEqual(spring.past[1].attempts.c.map((c) => c / H), [1.5, 3.5, 9, 23 + 59 / 60]);
    assert.equal(PF.valueAt(spring.past[1].attempts, 2.5 * H), 1, 'inside the skipped hour'); assert.equal(PF.valueAt(spring.past[1].attempts, spring.clock), 3);
    const n1 = day(1, 0, 0, 10), fall = PF.days([row(day(30, 9, 0, 9)), row(n1 + 1.25 * H), row(n1 + 1.75 * H), row(n1 + 2.1 * H), row(n1 + 2.9 * H), row(n1 + 3 * H), row(n1 + 10 * H)], day(2, 9, 0, 10));
    assert.equal((fall.past[1].t1 - fall.past[1].t0) / H, 25);
    assert.deepEqual(fall.past[1].attempts.c.map((c) => c / H), [1.25, 1.75, 2, 2, 2, 9], 'the second 1 o’clock is held at 2:00');
    assert.equal(PF.valueAt(fall.past[1].attempts, 9 * H), 6);
    for (const [mo, d] of [[2, 8], [10, 1]]) { // today on a clock-change day: never runs backwards, all of the day so far counted
      let last = -1;
      const t0 = day(d, 0, 0, mo), xs = [];
      for (let k = 0; k < 90; k++) { xs.push(row(t0 + k * 15 * 6e4)); if (xs.at(-1).t >= PF.dayStart(t0, 1)) break; const mm = PF.days(xs, xs.at(-1).t); const w = new Date(xs.at(-1).t), c = w.getHours() * H + w.getMinutes() * 6e4;
        assert.equal(mm.clock, c, 'today stands at the clock time'); assert.ok(c >= last || (mo === 10 && c === H), 'back only when the clock is'); last = c;
        assert.equal(PF.at(mm, 'attempts', mm.clock).value, xs.length);
        for (const k of PF.KEYS) assert.ok(mm.today[k].c.every((v, i, a) => v <= c && (!i || v >= a[i - 1])), 'the line never doubles back'); }
    }
    { // the second 01:06 of the autumn day meets every past 01:06, as "yesterday by now" does
      const back = [row(n1 - 7 * 864e5)];
      for (let i = 6; i >= 1; i--) back.push(row(day(32 - i, 1, 45, 9)));
      back.push(row(n1 + 5 * 6e4), row(n1 + 1.9 * H));
      for (const [plus, value] of [[1.1, 1], [2.1, 2]]) {
        const mm = PF.days(back, n1 + plus * H), z = PF.at(mm, 'attempts', mm.clock);
        assert.equal(mm.clock, 1 * H + 6 * 6e4); assert.equal(z.median, 0); assert.equal(z.value, value); assert.equal(z.pr, 100);
      }
      const mm = PF.days(back, n1 + 3.1 * H); assert.equal(mm.clock, 2 * H + 6 * 6e4); assert.equal(PF.at(mm, 'attempts', mm.clock).median, 1);
    }
    process.env.TZ = 'America/Sao_Paulo'; // put forward at midnight: the day starts at 01:00
    const sp = PF.days([row(new Date(2018, 10, 2, 9)), row(new Date(2018, 10, 4, 1, 30)), row(new Date(2018, 10, 4, 9))], +new Date(2018, 10, 5, 9));
    assert.deepEqual(sp.past.map((d) => (d.t1 - d.t0) / H), [24, 23]); assert.deepEqual(sp.past[1].attempts.c.map((c) => c / H), [1.5, 9]);
    // 20k rows over 400 days, quickly
    process.env.TZ = 'America/Los_Angeles';
    const many = []; for (let i = 0; i < 20000; i++) many.push(row(day(1) - 400 * 864e5 + i * 400 * 864 * 5 - 0, `p${i % 300}`, i % 2));
    const began = performance.now(), big = PF.days(many, day(2, 12)); for (const k of PF.KEYS) { PF.at(big, k, big.clock); PF.top(big, k); for (let c = 3 * H; c <= PF.DAY; c += 3 * H) PF.hist(big, k, c, 100, 10); }
    assert.ok(performance.now() - began < 1000, 'quick on 20k rows'); assert.ok(big.past.length >= 399);
    assert.equal(deep(PF.days(rows, day(9, 12))), deep(m), 'pure');
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
  assert.doesNotMatch(html, /innerHTML|insertAdjacentHTML|outerHTML|<script[^>]+src=/, 'textContent only, one inline script');
}

console.log('ok players-live: odd and malformed requests answered without crashing; 304/ETag, gzip q=0, in-place edits (re-rate, theme, grade, same-length rename, attempt edit) detected, generic 500; /rush.json labels, shape, own ETag, latest 200 runs; held snapshot, safety headers, quiet failures');
} finally {
  try { w?.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
