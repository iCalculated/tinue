// The flat-threat flag (scripts/apply-flat-threat.mjs, puzzles.flat_threat): the script selects, writes, is idempotent
// and clears; and the flag reaches no player. Every database here is built by this test in a temp dir (never
// data/tinue.db).   node --no-warnings scripts/test-flat-threat.mjs
//   1. selection from a results file: last line per id, needsFlat only, gaelet / skipped / inconsistent rows left out
//   2. the CLI: dry run writes nothing; --apply needs --backup, makes it, flags exactly the served selection, skips
//      missing / unserved / changed ids, refuses outside 200..250; a second run changes nothing; --clear empties it
//   3. no leak: the real server (production config, then judge shadow) and the players page, on a database whose every
//      puzzle is flagged, answer every route with no trace of the flag, and byte for byte what they answered before
//      the flag was written (written while the server ran, then again from a cold start); a static build (stubs from
//      the flagged database) holds no trace either, and its puzzle pages equal those built from the unflagged copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';
import { readResults, select, plan, write, clearAll, counts, hasColumn, backup, COLUMN } from './apply-flat-threat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'apply-flat-threat.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-flat-'));
const { env, base, boot, stop } = testServer(dir, { quiet: true });
const children = new Set(); // the other processes started here
process.on('exit', () => { for (const c of children) try { c.kill(); } catch {} });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fileHash = (f) => sha(Buffer.concat([f, f + '-wal'].map((x) => (fs.existsSync(x) ? fs.readFileSync(x) : Buffer.alloc(0))))); // the file and its WAL

// The real schema, once: boot the server on an empty file, stop it, and copy that (VACUUM INTO: WAL folded in).
const SCHEMA = path.join(dir, 'schema.db');
await stop(await boot(SCHEMA));
const fresh = (name) => { const f = path.join(dir, name); const s = new DatabaseSync(SCHEMA); s.prepare('VACUUM INTO ?').run(f); s.close(); return f; };
assert.equal(hasColumn(new DatabaseSync(SCHEMA, { readOnly: true })), false, 'the server does not add the column');

// ---- 1. selection ----
const R = (id, o = {}) => {
  const hostile = o.hostile || 'high', friendly = hostile === 'high' ? 'low' : 'high';
  const r = { id, size: o.size ?? 5, komi: o.komi ?? 0, plies: o.plies ?? 5, gaelet: o.gaelet ?? false, hostile,
    [hostile]: { role: 'hostile', win: o.win === undefined ? false : o.win, exact: o.exact ?? true, ...(o.base === null ? {} : { baseline: { win: o.base ?? true } }) },
    [friendly]: { role: 'friendly', win: false, exact: true }, needsFlat: o.needsFlat ?? true, flatFaster: o.flatFaster ?? false };
  if (o.skipped) r.skipped = o.skipped;
  return r;
};
const lines = [];
for (let i = 0; i < 224; i++) lines.push(R(`v${i}`, { exact: i < 89, size: i % 7 ? 5 : 6, plies: i < 89 ? 3 + 2 * (i % 2) : 7 + 2 * (i % 5), komi: i % 11 ? 0 : 2, hostile: i % 2 ? 'high' : 'low' }));
lines.push(R('fskip', { exact: false, plies: 9, skipped: 'low (friendly, P=7, brute): budget' })); // friendly-side skip: kept
lines.push(R('hskip', { needsFlat: true, skipped: 'high (hostile, P=11, deep q1): budget' })); // hostile-side skip: out
for (let i = 0; i < 3; i++) lines.push(R(`gael${i}`, { gaelet: true }));
lines.push(R('incons', { win: null })); // needsFlat with no hostile "no": out
lines.push(R('nobase', { base: null })); // no game-komi win recorded: out
lines.push(R('dupA')); lines.push(R('dupA', { needsFlat: false })); // the last line wins: out
lines.push(R('dupB', { needsFlat: false })); lines.push(R('dupB', { exact: true })); // in
for (let i = 0; i < 20; i++) lines.push(R(`plain${i}`, { needsFlat: false, flatFaster: i % 2 === 0 })); // flatFaster alone is never stored
lines.push(R('gone1')); lines.push(R('paused1')); lines.push(R('moved1')); // selected, but missing / not served / changed in the DB
const RESULTS = path.join(dir, 'results.jsonl');
fs.writeFileSync(RESULTS, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
const { rows, lines: nLines } = readResults(RESULTS);
assert.equal(nLines, lines.length);
const { chosen, left } = select(rows);
const want = 224 + 1 + 1 + 3; // v*, fskip, dupB, gone1/paused1/moved1
assert.equal(chosen.length, want);
assert.deepEqual([left.gaelet, left.skipped, left.inconsistent.sort()], [3, 1, ['incons', 'nobase']]);
const ids = new Set(chosen.map((c) => c.id));
for (const id of ['dupB', 'fskip', 'v0']) assert.ok(ids.has(id), id);
for (const id of ['dupA', 'hskip', 'gael0', 'plain0', 'incons']) assert.ok(!ids.has(id), id);
const nExact = chosen.filter((c) => c.kind === 'exact').length;
assert.equal(nExact, 89 + 1 + 3); // v0..v88, dupB, gone1/paused1/moved1 (default exact)
assert.equal(chosen.find((c) => c.id === 'fskip').kind, 'model');
assert.throws(() => { fs.writeFileSync(path.join(dir, 'bad.jsonl'), '{"id":"a"}\n{"id":'); readResults(path.join(dir, 'bad.jsonl')); }, /not JSON/);
console.log('ok selection: last line per id, needsFlat && !gaelet, skips and inconsistent rows out, exact/model kinds');

// ---- 2. the CLI ----
const TPS5 = '2,2,2,2,x/x5/x5/x5/1,1,1,1,x 1 5', TPS6 = '2,2,2,2,2,x/x6/x6/x6/x6/1,1,1,1,1,x 1 6';
const TREE = JSON.stringify({ a2: { r: 'b4', n: 'win' } });
function seed(file, results, { skipIds = ['gone1'] } = {}) {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL'); // as production's
  const ins = d.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, komi, turn, grade) VALUES (?,?,?,?,?,?,'test',1500,1500,?,1,?)`);
  let i = 0;
  for (const r of results.values()) {
    if (skipIds.includes(r.id)) continue;
    const themes = `s${r.size},tinueIn3${r.gaelet ? ',gaelet' : ''}`;
    ins.run(r.id, r.size, (r.size === 6 ? TPS6 : TPS5).replace(/ 1 (\d+)$/, ` 1 ${10 + i++}`), r.id === 'moved1' ? r.plies + 2 : r.plies, TREE, themes, r.komi, r.id === 'paused1' ? 'D' : null);
  }
  d.close();
}
const run = (...args) => { const r = spawnSync(process.execPath, ['--no-warnings', SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, TINUE_DB: '' } }); return { code: r.status, out: r.stdout + r.stderr }; };
const flags = (file) => { const d = new DatabaseSync(file, { readOnly: true }); const o = hasColumn(d) ? d.prepare(`SELECT id, ${COLUMN} k FROM puzzles WHERE ${COLUMN} IS NOT NULL ORDER BY id`).all().map((r) => r.id + ':' + r.k) : null; d.close(); return o; };
{
  const DB = fresh('cli.db');
  seed(DB, rows);
  const h0 = fileHash(DB);
  let r = run(RESULTS, '--db', DB);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`selected ${want}: exact ${nExact}, model ${want - nExact}`));
  assert.match(r.out, /skipped: missing 1, not served 1, changed since the scan 1; flagged after: 226/);
  assert.match(r.out, /skipped missing: gone1\n/); assert.match(r.out, /skipped unserved: paused1 \(rejected\)/); assert.match(r.out, /skipped changed: moved1/);
  assert.match(r.out, /by size: 5x5 \d+, 6x6 \d+/); assert.match(r.out, /by length \(plies\): 3 \d+, 5 \d+, 7/); assert.match(r.out, /ids exact: .*\bv0\b/);
  assert.match(r.out, /dry run: nothing written/);
  assert.equal(fileHash(DB), h0, 'a dry run writes nothing'); assert.equal(flags(DB), null);
  assert.equal(run(RESULTS, '--db', DB, '--dry-run').code, 0);

  r = run(RESULTS, '--db', DB, '--apply');
  assert.equal(r.code, 2); assert.match(r.out, /--backup/); assert.equal(flags(DB), null, 'no backup, no write');

  const B1 = path.join(dir, 'b1.db');
  r = run(RESULTS, '--db', DB, '--apply', '--backup', B1);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /applied: \{"exact":\d+,"model":\d+\} \(226 written, 0 cleared\)/);
  assert.ok(r.out.includes(`undo: ${process.execPath} --no-warnings scripts/apply-flat-threat.mjs --clear --db ${DB} --backup ${B1}.pre-clear`), r.out); // the node that ran it, not a bare 'node'
  const f1 = flags(DB);
  assert.equal(f1.length, 226);
  const expect = chosen.filter((c) => !['gone1', 'paused1', 'moved1'].includes(c.id)).map((c) => c.id + ':' + c.kind); // chosen is in id order (binary, as SQLite's ORDER BY id)
  assert.deepEqual(f1, expect);
  assert.ok(!fs.existsSync(B1 + '-wal') && !fs.existsSync(B1 + '-shm'), 'the backup is one standalone file');
  const bk = new DatabaseSync(B1, { readOnly: true });
  assert.equal(bk.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.equal(hasColumn(bk), false, 'the backup is from before the write'); assert.equal(bk.prepare('SELECT COUNT(*) n FROM puzzles').get().n, rows.size - 1); bk.close();

  r = run(RESULTS, '--db', DB, '--apply', '--backup', B1);
  assert.notEqual(r.code, 0); assert.match(r.out, /exists/); assert.deepEqual(flags(DB), f1, 'an existing backup file is never overwritten');

  r = run(RESULTS, '--db', DB, '--apply', '--backup', path.join(dir, 'b2.db'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /plan: flag 0 \(exact 0, model 0\), already right 226, unflag 0/); assert.deepEqual(flags(DB), f1, 'idempotent');

  // a row flagged by hand (or by an older results file) and no longer selected is cleared; a changed kind is rewritten
  const d = new DatabaseSync(DB);
  d.exec(`UPDATE puzzles SET ${COLUMN} = 'model' WHERE id = 'plain3'; UPDATE puzzles SET ${COLUMN} = 'model' WHERE id = 'v0'`);
  assert.throws(() => d.exec(`UPDATE puzzles SET ${COLUMN} = 'maybe' WHERE id = 'v1'`), /CHECK/);
  d.close();
  r = run(RESULTS, '--db', DB, '--apply', '--backup', path.join(dir, 'b3.db'));
  assert.equal(r.code, 0, r.out); assert.match(r.out, /plan: flag 1 \(exact 1, model 0\), already right 225, unflag 1 \(plain3\)/); assert.deepEqual(flags(DB), f1);

  // outside 200..250: refused, nothing written (too few selected; too few left once the DB is consulted)
  const SMALL = path.join(dir, 'small.jsonl');
  fs.writeFileSync(SMALL, lines.filter((x) => !/^v\d+$/.test(x.id) || +x.id.slice(1) < 150).map((x) => JSON.stringify(x)).join('\n'));
  const h1 = fileHash(DB);
  r = run(SMALL, '--db', DB); // the dry run says so up front
  assert.equal(r.code, 0, r.out); assert.match(r.out, /dry run: --apply would refuse: 155 rows selected, 152 rows would be flagged, outside 200\.\.250/);
  assert.doesNotMatch(run(RESULTS, '--db', DB).out, /would refuse/);
  r = run(SMALL, '--db', DB, '--apply', '--backup', path.join(dir, 'b4.db'));
  assert.equal(r.code, 3, r.out); assert.match(r.out, /refusing: 155 rows selected/); assert.equal(fileHash(DB), h1); assert.ok(!fs.existsSync(path.join(dir, 'b4.db')));
  const HOLEY = fresh('holey.db');
  seed(HOLEY, rows, { skipIds: ['gone1', ...[...Array(40).keys()].map((i) => 'v' + i)] });
  assert.match(run(RESULTS, '--db', HOLEY).out, /dry run: --apply would refuse: 186 rows would be flagged/);
  r = run(RESULTS, '--db', HOLEY, '--apply', '--backup', path.join(dir, 'b5.db'));
  assert.equal(r.code, 3, r.out); assert.match(r.out, /refusing: 186 rows would be flagged/); assert.equal(flags(HOLEY), null);

  r = run('--clear', '--db', DB);
  assert.equal(r.code, 2); assert.deepEqual(flags(DB), f1, '--clear needs a backup too');
  r = run('--clear', '--db', DB, '--backup', path.join(dir, 'b6.db'));
  assert.equal(r.code, 0, r.out); assert.match(r.out, /cleared flat_threat on 226 rows; now flagged: \{\}/); assert.deepEqual(flags(DB), []);
  const b6 = new DatabaseSync(path.join(dir, 'b6.db'), { readOnly: true }); assert.equal(b6.prepare(`SELECT COUNT(*) n FROM puzzles WHERE ${COLUMN} IS NOT NULL`).get().n, 226); b6.close();
  assert.equal(run(RESULTS, '--db', DB, '--apply', '--backup', path.join(dir, 'b7.db')).code, 0); assert.deepEqual(flags(DB), f1, 'apply after clear restores it');

  // A publish (scripts/import.mjs upserting rows, themes and tree included) leaves the column alone.
  const IMP = path.join(dir, 'import'); fs.mkdirSync(IMP);
  const src = new DatabaseSync(DB, { readOnly: true }), row = (id) => src.prepare('SELECT * FROM puzzles WHERE id = ?').get(id);
  const ex = (r, o) => ({ id: r.id, size: r.size, tps: r.tps, komi: r.komi, plies: r.plies, tree: JSON.parse(r.tree), tags: r.themes.split(','), rating: r.init_rating,
    source: r.source, sourceRef: r.source_ref, meta: {}, turn: 1, swing: null, grade: null, ...o });
  fs.writeFileSync(path.join(IMP, 'rows.jsonl'), [ex(row('v0'), { tags: ['s5', 'tinueIn3', 'fork'] }), ex(row('v1'), { tree: { a2: { r: 'b5', n: 'win' } } })].map((x) => JSON.stringify(x)).join('\n') + '\n');
  src.close();
  const im = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/import.mjs'), IMP, '--no-overrides'], { cwd: dir, encoding: 'utf8', env: { ...env, TINUE_DB: DB } });
  assert.equal(im.status, 0, im.stdout + im.stderr);
  const after = new DatabaseSync(DB, { readOnly: true });
  assert.equal(after.prepare("SELECT themes FROM puzzles WHERE id = 'v0'").get().themes, 's5,tinueIn3,fork', 'the import ran');
  assert.equal(after.prepare("SELECT rev FROM puzzles WHERE id = 'v1'").get().rev, 1, 'the import changed v1');
  after.close();
  assert.deepEqual(flags(DB), f1, 'an import keeps every flag');
  // flags there before the apply: the undo line gives the command that puts them back from the backup
  { const d2 = new DatabaseSync(DB); d2.exec(`UPDATE puzzles SET ${COLUMN} = NULL WHERE id = 'v5'; UPDATE puzzles SET ${COLUMN} = 'model' WHERE id = 'plain4'`); d2.close(); }
  const before = flags(DB), B8 = path.join(dir, 'b8.db');
  r = run(RESULTS, '--db', DB, '--apply', '--backup', B8);
  assert.equal(r.code, 0, r.out); assert.deepEqual(flags(DB), f1);
  const undo = /put those back from the backup: sqlite3 (\S+) "([^"]+)"/.exec(r.out);
  assert.ok(undo && undo[1] === DB, r.out);
  const sq = spawnSync('/usr/bin/sqlite3', [undo[1], undo[2]], { encoding: 'utf8' });
  assert.equal(sq.status, 0, sq.stderr); assert.deepEqual(flags(DB), before, 'the printed restore puts the old flags back');
  assert.equal(run(RESULTS, '--db', DB, '--apply', '--backup', path.join(dir, 'b9.db')).code, 0); assert.deepEqual(flags(DB), f1);
  console.log('ok cli: dry run read-only; --apply needs and makes a backup, flags the served selection, skips missing/unserved/changed, idempotent, unflags strays, refuses outside 200..250; --clear; an import keeps it');
}

// ---- 2b. the backup finishes while another connection keeps writing (as the live server does) ----
{
  const BIG = fresh('big.db');
  const d = new DatabaseSync(BIG); d.exec('PRAGMA journal_mode = WAL');
  const ins = d.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, komi, turn, meta) VALUES (?,5,?,3,?,'s5','test',1500,1500,0,1,?)`);
  d.exec('BEGIN'); const pad = 'x'.repeat(3000);
  for (let i = 0; i < 8000; i++) ins.run(`big${i}`, TPS5.replace(/ 1 5$/, ` 1 ${5 + i}`), TREE, JSON.stringify({ pad }));
  d.exec('COMMIT'); d.close(); // about 30 MB: some 7,000 pages, 70 steps at the default 100 pages a step
  const WMS = 4000;
  const writer = spawn(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(process.argv[1]); d.exec('PRAGMA busy_timeout = 5000');
    const u = d.prepare("UPDATE puzzles SET rating = rating + 1 WHERE id = ?"); let i = 0; const end = Date.now() + ${WMS};
    const t = setInterval(() => { u.run('big' + (i++ % 8000)); if (i === 1) console.log('go'); if (Date.now() > end) { clearInterval(t); d.close(); } }, 5);`, BIG], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.add(writer);
  const wdone = new Promise((r) => writer.once('exit', r));
  await new Promise((r) => writer.stdout.once('data', r));
  const db = new DatabaseSync(BIG); db.exec('PRAGMA busy_timeout = 5000');
  const t0 = Date.now(), b = await backup(db, path.join(dir, 'big-backup.db')), ms = Date.now() - t0;
  const live = writer.exitCode == null; db.close();
  await wdone; children.delete(writer);
  assert.equal(b.puzzles, 8000);
  assert.ok(live && ms < WMS / 2, `the backup took ${ms} ms under writes every 5 ms (writer still running: ${live}); it must not wait for the writes to stop`);
  console.log(`ok backup under steady writes: ${ms} ms, ${b.bytes} bytes, while another connection committed every 5 ms`);
}

// ---- 3. no leak ----
const LEAK = /flat[_-]?threat/i;
// Every string in a JSON answer: no key or value naming the flag, and no value that is a flag kind.
function clean(name, ctype, body) {
  const text = body.toString('utf8');
  assert.ok(!LEAK.test(text), `${name}: names the flag`);
  if (!/json/.test(ctype)) return;
  const walk = (v, at) => {
    if (typeof v === 'string') assert.ok(v !== 'exact' && v !== 'model', `${name}: ${at} = ${v}`);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!LEAK.test(k) && k !== 'exact' && k !== 'model', `${name}: key ${at}.${k}`); walk(x, `${at}.${k}`); }
  };
  walk(JSON.parse(text), '$');
}
const DB = fresh('leak.db');
{
  const d = new DatabaseSync(DB);
  const ins = d.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, komi, turn, meta) VALUES (?,?,?,3,?,?,'test',?,?,250,?,1,?)`);
  for (let i = 0; i < 30; i++) ins.run(`f${i}`, 6, TPS6.replace(/ 1 6$/, ` 1 ${6 + i}`), TREE, i % 3 ? 's6,tinueIn2' : 's6,fork,tinueIn2', 1300 + i * 38, 1300 + i * 38, i % 4 ? 0 : 2, JSON.stringify({ moves: ['a1', 'f6'] }));
  for (let i = 0; i < 5; i++) ins.run(`g${i}`, 5, TPS5.replace(/ 1 5$/, ` 1 ${5 + i}`), TREE, 's5,tinueIn2,placement', 1400 + i * 50, 1400 + i * 50, 0, null);
  d.close();
}
const flagAll = () => {
  const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000');
  const all = d.prepare('SELECT id, size, plies, komi FROM puzzles ORDER BY id').all().map((r, i) => ({ ...r, kind: i % 2 ? 'model' : 'exact' }));
  const p = plan(d, all);
  assert.equal(p.final, 35);
  const c = write(d, p); d.close(); return c;
};

let server = await boot(DB);
const call = async (p, { method = 'GET', body, token, headers = {} } = {}) => {
  const r = await fetch(base + p, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, ctype: r.headers.get('content-type') || '', body: Buffer.from(await r.arrayBuffer()), location: r.headers.get('location') };
};
// Setup (before any flag): two named players with rated results, a guest's result, settings, a daily, a Rush run.
const reg = async (name) => JSON.parse((await call('/api/register', { method: 'POST', body: { name } })).body).token;
const tokA = await reg('flatA'), tokB = await reg('flatB');
for (const [t, id, win] of [[tokA, 'f3', true], [tokA, 'f7', false], [tokA, 'g1', true], [tokB, 'f3', false], [tokB, 'f12', true]])
  assert.equal((await call('/api/result', { method: 'POST', token: t, body: { puzzleId: id, win, ms: 4000, log: [{ m: 'a2', ms: 900, k: 'ok' }] } })).status, 200);
assert.equal((await call('/api/settings', { method: 'POST', token: tokA, body: { settings: { sound: false } } })).status, 200);
assert.equal((await call('/api/daily')).status, 200);
{
  const r = JSON.parse((await call('/api/rush/run?mode=rush&size=6', { token: tokA })).body);
  assert.ok(r.puzzles.length > 0);
  const post = await call('/api/rush/result', { method: 'POST', token: tokA, body: { mode: 'rush', size: 6, score: 2, moves: 2, errors: 0, bestCombo: 2, ms: 60000, build: 1, run: r.run,
    pages: [{ start: r.start, ids: r.puzzles.map((p) => p.id), sig: r.sig }], puzzles: [{ id: r.puzzles[0].id, solved: true, ms: 1000 }, { id: r.puzzles[1].id, solved: true, ms: 2000 }] } });
  assert.equal(post.status, 200, post.body.toString());
  var rushRun = r;
}

// Every public route of server/server.js (api(), share(), serveStatic(), moved()) and server/rush.js, with a token and
// without. The POSTs repeat setup's writes, which change nothing the second time (same user, same puzzle, same name).
const ROUTES = (t) => [
  ['/api'], ['/api/'], ['/api/me', { token: t }], ['/api/me'],
  ['/api/next'], ['/api/next', { token: t }], ['/api/next?size=6&theme=fork'], ['/api/next?n=5&rating=1700'], ['/api/next?n=5', { token: t }], ['/api/next?for=f10&size=6', { token: t }], ['/api/next?for=f10&theme=fork'],
  ['/api/puzzle/f0'], ['/api/puzzle/f3', { token: t }], ['/api/puzzle/g1'], ['/api/puzzle/nope'],
  ['/api/daily'], ['/api/group?names=flatA,flatB,nobody'], ['/api/users?names=flatA,flatB'], ['/api/users/flatA'], ['/api/users'],
  ['/api/history', { token: t }], ['/api/history'],
  ['/api/themes'], ['/api/themes?size=6'], ['/api/themes?size=5'], ['/api/stats'], ['/api/leaderboard'],
  ['/api/analyze?tps=' + encodeURIComponent(TPS6)], ['/api/defend?tps=' + encodeURIComponent(TPS6)],
  ['/api/rush/run?mode=rush&size=6', { token: t }], ['/api/rush/run?mode=streak&size=6'], ['/api/rush/best?size=6', { token: t }], ['/api/rush/top?mode=rush&size=6'],
  ['/api/rush/top?mode=rush&size=6', { method: 'POST', body: { guest: { gid: 'e'.repeat(32) } } }], ['/api/rush/top?mode=streak&size=6', { token: t, method: 'POST', body: {} }],
  ['/api/rush/result', { method: 'POST', token: t, body: { mode: 'rush', size: 6, run: rushRun.run, pages: [{ start: rushRun.start, ids: rushRun.puzzles.map((p) => p.id), sig: rushRun.sig }], puzzles: [{ id: rushRun.puzzles[0].id, solved: true, ms: 1 }], score: 1, moves: 1, errors: 0, bestCombo: 1, ms: 1000 } }],
  ['/api/result', { method: 'POST', token: t, body: { puzzleId: 'f3', win: true, ms: 100 } }], ['/api/result', { method: 'POST', token: t, body: { puzzleId: 'nope', win: true } }],
  ['/api/register', { method: 'POST', body: { name: 'flatA' } }], ['/api/register', { method: 'POST', token: t, body: { name: 'other' } }], ['/api/login', { method: 'POST', body: { token: t } }],
  ['/api/settings', { method: 'POST', token: t, body: { settings: { sound: false } } }], ['/api/logout', { method: 'POST' }], ['/api/guest-result', { method: 'POST', body: {} }],
  ['/api/slow', { method: 'POST', body: { path: '/api/next', ms: 3000 } }], ['/api/move', { method: 'POST', body: {} }], ['/api/attempt'], ['/api/nope'],
  ['/p/f0'], ['/p/f0.png'], ['/p/g1'], ['/p/g1.png'], ['/p/nope'], ['/puzzle/f0'],
  ['/'], ['/index.html'], ['/me'], ['/leaderboard'], ['/glossary'], ['/app.js'], ['/shared/themes.js'], ['/nope.js'],
];
// Answers that differ from call to call by design (random picks, time-signed Rush tokens): not compared byte for byte.
// Instead every object with an id in them (each puzzle served) is kept, per route and place in the answer, and must be
// the same before and after the flag, field for field: a flag leaked as a number or a boolean shows up there too.
const VOLATILE = /^\/api\/next|^\/api\/rush\/run/;
const REPEAT = 4; // volatile routes are called this often per pass, so the same puzzles come up in every pass
const UNSIGNED = new Set(['run', 'sig', 'start']); // per-call Rush tokens, not puzzle fields
function harvest(into, route, body) {
  const walk = (v, at) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, at + '[]'));
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string') {
      const k = `${route}|${at}|${v.id}`, s = JSON.stringify(Object.fromEntries(Object.entries(v).filter(([f]) => !UNSIGNED.has(f))));
      into.set(k, into.has(k) && into.get(k) !== s ? null : s); // null: not stable even within one pass
    }
    for (const [f, x] of Object.entries(v)) walk(x, `${at}.${f}`);
  };
  walk(JSON.parse(body), '$');
}
async function collect(label) {
  const out = new Map(), objs = new Map();
  for (const [p, o] of ROUTES(tokA)) {
    const key = `${o?.method || 'GET'} ${p}${o?.token ? ' (token)' : ''}`;
    for (let i = 0; i < (VOLATILE.test(p) ? REPEAT : 1); i++) {
      const r = await call(p, o);
      assert.ok(r.status < 500 || p.startsWith('/api/analyze') || p.startsWith('/api/defend'), `${label} ${p}: ${r.status} ${r.body}`);
      clean(`${label} ${key}`, r.ctype, r.body);
      if (VOLATILE.test(p) && r.status === 200) harvest(objs, key, r.body);
      out.set(key, r);
    }
  }
  out.objs = objs;
  return out;
}
const same = (a, b, label) => {
  let n = 0;
  for (const [k, r] of a) {
    if (VOLATILE.test(k.split(' ')[1])) continue;
    const s = b.get(k);
    assert.equal(s.status, r.status, `${label} ${k}: status`);
    assert.ok(s.body.equals(r.body), `${label} ${k}: body differs\n${r.body.toString().slice(0, 300)}\n${s.body.toString().slice(0, 300)}`);
    n++;
  }
  // the volatile routes, puzzle by puzzle
  const per = new Map();
  for (const [k, v] of a.objs) {
    if (v == null || !b.objs.has(k) || b.objs.get(k) == null) continue;
    assert.equal(b.objs.get(k), v, `${label} ${k}: the puzzle as served differs\n${v}\n${b.objs.get(k)}`);
    const route = k.split('|')[0]; per.set(route, (per.get(route) || 0) + 1);
  }
  // enough of them came up in both passes to mean something (/api/next picks at random; Rush serves all 30 6x6 puzzles)
  const sum = (re) => [...per].filter(([r]) => re.test(r)).reduce((x, [, n]) => x + n, 0), got = JSON.stringify([...per]);
  assert.ok(sum(/\/api\/next/) >= 10, `${label} /api/next: too few puzzles served in both passes to compare: ${got}`);
  for (const r of ['GET /api/rush/run?mode=rush&size=6 (token)', 'GET /api/rush/run?mode=streak&size=6']) assert.ok((per.get(r) || 0) >= 20, `${label} ${r}: too few: ${got}`);
  return n + [...per.values()].reduce((x, y) => x + y, 0);
};
// The players page (scripts/players-live), on the same file.
const players = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/players-live/server.mjs')], { env: { ...env, TINUE_DB: DB, HOST: '127.0.0.1', PORT: '0', CHECK_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
children.add(players);
const pport = await new Promise((resolve, reject) => {
  players.stdout.on('data', (b) => { const m = /:(\d+)\s*$/m.exec(String(b)); if (m) resolve(+m[1]); });
  players.on('exit', (c) => reject(new Error('players exited ' + c)));
  setTimeout(() => reject(new Error('players did not start')), 10e3);
});
const feeds = async (label) => {
  const out = new Map();
  for (const p of ['/', '/data.json', '/rush.json']) {
    const r = await fetch(`http://127.0.0.1:${pport}${p}`);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 200, `${label} players ${p}`);
    clean(`${label} players ${p}`, r.headers.get('content-type'), body);
    out.set(p, body);
  }
  const data = JSON.parse(out.get('/data.json'));
  assert.ok(JSON.stringify(data).includes('"f3"') && JSON.parse(out.get('/rush.json')) && true, 'the feeds carry the flagged puzzles');
  return out;
};

const A = await collect('before'), PA = await feeds('before');
// the routes answer for real (a 404 everywhere would pass the leak check vacuously)
for (const k of ['GET /api/puzzle/f0', 'GET /api/daily', 'GET /api/history (token)', 'GET /api/themes', 'GET /api/next', 'GET /api/next?n=5 (token)', 'GET /api/rush/run?mode=rush&size=6 (token)',
  'GET /api/users?names=flatA,flatB', 'GET /api/leaderboard', 'GET /api/stats', 'GET /p/f0', 'GET /p/f0.png', 'GET /', 'POST /api/login']) assert.equal(A.get(k)?.status, 200, k);
assert.equal(JSON.parse(A.get('GET /api/history (token)').body).history.length, 3);
assert.equal(JSON.parse(A.get('GET /api/next?n=5 (token)').body).puzzles.length, 5);
const kinds = flagAll(); // while both servers run, as on production
assert.deepEqual(kinds, { exact: 18, model: 17 });
const B = await collect('flagged, live'), PB = await feeds('flagged, live');
await stop(server);
server = await boot(DB); // a cold start on the flagged file: no cache from before
const C = await collect('flagged, cold'), PC = await feeds('flagged, cold');
const n1 = same(A, B, 'live'), n2 = same(A, C, 'cold');
for (const p of PA.keys()) { assert.ok(PA.get(p).equals(PB.get(p)), `players ${p} live`); assert.ok(PA.get(p).equals(PC.get(p)), `players ${p} cold`); }
await stop(server); await stop(players);
console.log(`ok no leak: ${ROUTES(tokA).length} server routes x 3 passes and 3 players-page feeds carry no flag; ${n1} + ${n2} deterministic answers and volatile-route puzzles identical before and after (live, cold)`);

// The judge on (shadow: the /api/move routes exist, puzzles carry rev).
server = await boot(DB, { TINUE_JUDGE: 'shadow' });
{
  const NH = 'x-tinue-nonce', nonce = 'flat-nonce-000001';
  const ply = (o) => ({ puzzleId: 'f0', rev: 0, nonce, ply: 0, move: 'a2', ms: 5, ...o });
  const rs = [await call('/api/move', { method: 'POST', token: tokA, body: ply() }), await call('/api/move', { method: 'POST', token: tokA, body: ply({ ply: 1, move: 'f1' }) }),
    await call('/api/attempt', { token: tokA, headers: { [NH]: nonce } }), await call('/api/puzzle/f0'), await call('/api/next', { token: tokA }), await call('/api/next?n=3')];
  assert.equal(rs[0].status, 200, String(rs[0].body));
  rs.forEach((r, i) => clean(`shadow #${i}`, r.ctype, r.body));
}
await stop(server);
console.log('ok no leak with the judge on: /api/move, /api/attempt, /api/puzzle, /api/next');

// The static build: build-static.sh with puzzle pages from the flagged database; and the puzzle pages alone, from the
// flagged and the cleared copy, byte for byte.
if (fs.existsSync(path.join(ROOT, 'public/syntaks/syntaks.wasm'))) {
  const SITE = path.join(dir, 'site');
  const b = spawnSync('sh', [path.join(ROOT, 'scripts/build-static.sh'), 'http://127.0.0.1:9'], { cwd: ROOT, encoding: 'utf8', env: { ...env, SITE, TINUE_DB: DB, STUBS: '', DRY_RUN: '' } });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  let files = 0;
  const scan = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) scan(f); else { files++; assert.ok(!LEAK.test(fs.readFileSync(f, 'latin1')), `static ${f}`); } } };
  scan(path.join(SITE, 'tinue'));
  assert.equal(fs.readdirSync(path.join(SITE, 'tinue', 'puzzle')).length, 35);
  const CLEARED = path.join(dir, 'cleared.db');
  { const s = new DatabaseSync(DB); s.prepare('VACUUM INTO ?').run(CLEARED); s.close(); const c = new DatabaseSync(CLEARED); assert.equal(clearAll(c), 35); assert.deepEqual(counts(c), {}); c.close(); }
  const stubs = (db, out) => { const r = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/build-stubs.mjs'), out, 'https://example.test/tinue/', 'http://127.0.0.1:9', '--all'], { encoding: 'utf8', env: { ...env, TINUE_DB: db } }); assert.equal(r.status, 0, r.stderr); };
  stubs(DB, path.join(dir, 'stubs-flagged')); stubs(CLEARED, path.join(dir, 'stubs-cleared'));
  const list = fs.readdirSync(path.join(dir, 'stubs-flagged', 'puzzle')).sort();
  assert.deepEqual(list, fs.readdirSync(path.join(dir, 'stubs-cleared', 'puzzle')).sort());
  for (const f of list) assert.ok(fs.readFileSync(path.join(dir, 'stubs-flagged', 'puzzle', f)).equals(fs.readFileSync(path.join(dir, 'stubs-cleared', 'puzzle', f))), f);
  console.log(`ok no leak in the static build: ${files} files, none names the flag; ${list.length} puzzle pages identical flagged or not`);
} else console.log('   (static build skipped: no public/syntaks/syntaks.wasm in this checkout)');

fs.rmSync(dir, { recursive: true, force: true });
console.log('flat-threat: all ok');
