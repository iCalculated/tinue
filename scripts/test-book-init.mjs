// scripts/book-init.mjs on a fixture database (rows copied from lyra's build DB; ps505288 made served to test the
// exclusion list; p880472 is a C conversion, not served; p880446's slow altsAt d2< dropped): A2 passes, a re-run adds nothing, --dry-run writes nothing,
// only the three book tables are written. No 6x6 alt, so deep is not needed (one test uses a stand-in deep script).
// Also: live-DB safety (held write lock, chunks, killed version), exclusions, the proof resume file.
//   node scripts/test-book-init.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { bookLookup, initBook } from '../server/book.js';
import { puzzleWins } from '../shared/book.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROWS = [{"id":"p335067","size":4,"tps":"2,x,1,x/221,x,1,x/x,21,2212,x/2,x2,1 1 12","plies":3,"tree":"{\"2b2>\":{\"r\":\"Sc1\",\"n\":\"win\"}}","komi":0,"swing":"{\"pre0\":0,\"pre2\":0.005,\"pre4\":0.02,\"lostBefore\":\"disproved\",\"alt\":0.445,\"alts\":[],\"altsAt\":null,\"esc\":true}","turn":1,"grade":null},{"id":"p345033","size":4,"tps":"2,x,1212,x/2,1,1,x/21S,x,21,x/12,x,2,x 2 14","plies":5,"tree":"{\"4c4-22\":{\"r\":\"b3>\",\"n\":{\"3c2+\":{\"r\":\"Sb3\",\"n\":\"win\"}}}}","komi":0,"swing":"{\"pre0\":0.945,\"pre2\":0.88,\"pre4\":0.03,\"lostBefore\":\"disproved\",\"alt\":0.97,\"alts\":[\"d1\"],\"altsAt\":{\"4c4-22 b3>\":[\"4c2+13\"]},\"esc\":null}","turn":0,"grade":"A"},{"id":"p875446","size":7,"tps":"1,x6/1,x2,1,x3/2,2,x4,21/2,2,2,212,21,212,x/1,x5,2/1,x6/21,1,x5 2 16","plies":3,"tree":"{\"2d4>\":{\"r\":\"Sg4\",\"n\":\"win\"},\"2f4<\":{\"r\":\"Sg4\",\"n\":\"win\"}}","komi":0,"swing":"{\"pre0\":null,\"pre2\":null,\"pre4\":null,\"lostBefore\":null,\"alt\":null,\"alts\":null,\"altsAt\":null,\"esc\":null}","turn":null,"grade":null},{"id":"p880446","size":5,"tps":"1,x3,2/2,1,211221C,2,x/x,2,1,2C,x/x2,12,1,x/x,2,1,1,1 1 15","plies":5,"tree":"{\"b5\":{\"r\":\"a4>\",\"n\":{\"c5\":{\"r\":\"d3<\",\"n\":\"win\"}}}}","komi":0,"swing":"{\"pre0\":0.945,\"pre2\":0.935,\"pre4\":0.935,\"lostBefore\":\"unknown\",\"alt\":0.965,\"alts\":[\"a5-\"],\"altsAt\":{\"b5 a4>\":[\"c1+\",\"5c4+\",\"4c4<\"]},\"esc\":null}","turn":0,"grade":"A"},{"id":"p880472","size":5,"tps":"1,x3,2/x4,2/1,1,1C,x,21/21,2,x,1,2121212C/2,1,x,12,x 2 17","plies":3,"tree":"{\"4e2+\":{\"r\":\"Se1\",\"n\":\"win\"}}","komi":0,"swing":"{\"pre0\":0.955,\"pre2\":0.945,\"pre4\":0.75,\"lostBefore\":\"proved\",\"alt\":0.97,\"alts\":[\"2e2+\",\"4e2+22\"],\"altsAt\":null,\"esc\":null}","turn":0,"grade":"C"},{"id":"pc852148-31","size":6,"tps":"2,2,212S,1S,2,2/x2,1,1,12S,x/1,1,1C,12C,x2/x,1,2,1,x2/x3,12,x2/x2,2,1,1,1 2 16","plies":5,"tree":"{\"2d4+11\":{\"r\":\"c4+\",\"n\":{\"d6<\":{\"r\":\"d6>\",\"n\":\"win\"}}}}","komi":2,"swing":"{\"pre0\":0.1525,\"pre2\":null,\"pre4\":null,\"lostBefore\":null,\"alt\":0.3275,\"alts\":null,\"altsAt\":null,\"esc\":null}","turn":1,"grade":null},{"id":"ps505288","size":6,"tps":"2,x2,2,x,1/x,2,2,2S,x2/1,11221C,11,11221S,1,1/21S,x,122,21112C,x2/2,x,2,21S,12,x/2,x3,2,x 1 37","plies":5,"tree":"{\"2b4>11\":{\"r\":\"2e2+11\",\"n\":{\"e3+\":{\"r\":\"b4<\",\"n\":\"win\"}}},\"3b4>21\":{\"r\":\"2e2+11\",\"n\":{\"e3+\":{\"r\":\"2c4<11\",\"n\":\"win\"}}},\"4b4>31\":{\"r\":\"2e2+11\",\"n\":{\"e3+\":{\"r\":\"3c4<21\",\"n\":\"win\"}}},\"5b4>41\":{\"r\":\"2e2+11\",\"n\":{\"e3+\":{\"r\":\"4c4<13\",\"n\":\"win\"}}}}","komi":2.5,"swing":"{\"pre0\":0.16,\"pre2\":0.23,\"pre4\":0.12,\"lostBefore\":\"disproved\",\"alt\":0.115,\"alts\":[\"c4-\"],\"esc\":null}","turn":1,"grade":null}];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-book-init-'));
const DB = path.join(dir, 'b.db');
{
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE puzzles (id TEXT PRIMARY KEY, size INTEGER NOT NULL, tps TEXT NOT NULL, plies INTEGER NOT NULL, tree TEXT NOT NULL,
    komi REAL NOT NULL DEFAULT 0, swing TEXT, turn INTEGER, grade TEXT); CREATE TABLE other (x INTEGER); INSERT INTO other VALUES (1);`);
  const ins = db.prepare('INSERT INTO puzzles (id, size, tps, plies, tree, komi, swing, turn, grade) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const r of ROWS) ins.run(r.id, r.size, r.tps, r.plies, r.tree, r.komi, r.swing, r.turn, r.grade);
  db.close();
}
const DB0 = path.join(dir, 'b0.db'); fs.copyFileSync(DB, DB0); // the fixture before any run
const run = (...a) => spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/book-init.mjs'), DB, '--commit', 'test', '--deep', '/nonexistent', '--jobs', '2', '--server-has-busy-timeout', '--report', path.join(dir, 'r.json'), ...a], { encoding: 'utf8' });
const snapshot = () => { const db = new DatabaseSync(DB, { readOnly: true }); const s = { tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name), puzzles: JSON.stringify(db.prepare('SELECT * FROM puzzles ORDER BY id').all()), other: db.prepare('SELECT * FROM other').all() }; db.close(); return s; };
const before = snapshot();

const dry = run('--dry-run');
assert.equal(dry.status, 0, dry.stdout + dry.stderr);
assert.match(dry.stdout, /A2 pass \(dry run/);
assert.deepEqual(snapshot(), before, 'dry run writes nothing');

const r1 = run();
assert.equal(r1.status, 0, r1.stdout + r1.stderr);
const rep = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
assert.equal(rep.ver, 1); assert.equal(rep.a2.pass, true); assert.equal(rep.a2.conflicts, 0);
assert.equal(rep.servedPuzzles, 5); assert.equal(rep.puzzles, 6, 'served + 7x7; the C conversion is left out');
assert.equal(rep.a2.servedKeyCoverage, `${rep.servedTreePositions}/${rep.servedTreePositions}`);
assert.ok(rep.altPositions >= 6 && rep.a2.altsPresent === `${rep.altEntries}/${rep.altEntries}`);
const ex = rep.a2.excluded.find((e) => e.puzzle === 'ps505288');
assert.ok(ex && ex.pos && ex.absent && !ex.notLoaded, 'ps505288 c4- reached and left out');
const after = snapshot();
assert.deepEqual(after.tables, [...before.tables, 'book', 'book_node', 'book_ver'].sort());
assert.equal(after.puzzles, before.puzzles); assert.deepEqual(after.other, before.other);
{
  const db = new DatabaseSync(DB, { readOnly: true });
  assert.equal(bookLookup(db, ex.pos, 99), null);
  const rows = db.prepare('SELECT * FROM book').all();
  assert.equal(rows.length, rep.rows.book);
  assert.ok(rows.every((r) => r.ver === 1 && r.commit_sha === 'test' && r.retired_ver === null));
  assert.ok(rows.filter((r) => r.proof === 'tree').every((r) => r.win_len % 2 === 0 && r.checked === 0 && r.exact === 0 && r.model === 'threat'));
  assert.ok(rows.filter((r) => r.proof === 'alt').every((r) => r.checked === 1 && r.win_len > 0), 'fixture alts all re-prove');
  db.close();
}
const r2 = run();
assert.equal(r2.status, 0, r2.stdout + r2.stderr);
const rep2 = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
assert.equal(rep2.publish.added, 0); assert.equal(rep2.rows.book_ver, 1, 're-run: no new version');
assert.deepEqual(snapshot(), after);

// Live-DB safety: with the server holding the write lock (WAL, as in production) the run waits for it instead of
// failing, and writes in chunks; a run killed while writing (a version without its book_ver row) is continued.
const fresh = (name) => { const f = path.join(dir, name); fs.copyFileSync(DB0, f); return f; };
const runOn = (file, ...a) => spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/book-init.mjs'), file, '--commit', 'test', '--deep', '/nonexistent', '--jobs', '2', '--server-has-busy-timeout', '--report', path.join(dir, 'r.json'), ...a], { encoding: 'utf8' });
const bookCount = (file) => { const d = new DatabaseSync(file, { readOnly: true }); const n = { book: d.prepare('SELECT COUNT(*) n FROM book').get().n, vers: d.prepare('SELECT ver, added FROM book_ver').all().map((r) => ({ ...r })) }; d.close(); return n; };
{
  const f = fresh('busy.db');
  const server = new DatabaseSync(f); server.exec('PRAGMA journal_mode = WAL'); server.exec('BEGIN IMMEDIATE'); server.prepare('INSERT INTO other VALUES (2)').run();
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/book-init.mjs'), f, '--commit', 'test', '--deep', '/nonexistent', '--jobs', '2', '--server-has-busy-timeout', '--chunk', '2', '--pause-ms', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  setTimeout(() => server.exec('COMMIT'), 1500);
  const code = await new Promise((res) => child.on('exit', res));
  server.close();
  assert.equal(code, 0, out);
  assert.match(out, /written \d+\/\d+/, 'progress on stderr');
  assert.deepEqual(bookCount(f), { book: rep.rows.book, vers: [{ ver: 1, added: rep.rows.book }] });
}
{
  const f = fresh('killed.db');
  const d = new DatabaseSync(f); initBook(d);
  const p = ROWS.find((r) => r.id === 'p345033'), w = puzzleWins(p).find((x) => x.kind === 'tree' && !x.path.length);
  d.prepare("INSERT INTO book (pos, ver, win_len, exact, model, proof, checked, puzzle_id, commit_sha, ts) VALUES (?, 1, ?, 0, 'threat', 'tree', 0, ?, 'test', 1)").run(w.pos, w.winLen, p.id);
  // ... and a row the plan no longer wants (the killed run wrote it before the alt went on the exclusion list).
  d.prepare("INSERT INTO book (pos, ver, win_len, exact, model, proof, checked, puzzle_id, commit_sha, ts) VALUES (?, 1, NULL, 0, 'threat', 'alt', 0, 'ps505288', 'test', 1)").run(ex.pos);
  d.close();
  const k = runOn(f, '--chunk', '3');
  assert.equal(k.status, 0, k.stdout + k.stderr);
  const kr = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
  assert.equal(kr.ver, 1, 'the incomplete version is continued, not a new one');
  assert.deepEqual(bookCount(f), { book: rep.rows.book, vers: [{ ver: 1, added: rep.rows.book }] });
  const d2 = new DatabaseSync(f, { readOnly: true });
  assert.equal(d2.prepare('SELECT COUNT(*) n FROM book WHERE pos = ?').get(ex.pos).n, 0, 'the excluded row was taken back'); d2.close();
}
// One run per database: a held lock (live pid) or a stale one (dead pid) stops the run before it reads anything; a
// finished run leaves no lock.
{
  const f = fresh('lock.db'), lock = f + '.book-init.lock';
  assert.equal(fs.existsSync(DB + '.book-init.lock'), false, 'a finished run removes its lock');
  for (const [pid, why] of [[process.pid, /another book-init/], [2 ** 30, /not running/]]) {
    fs.writeFileSync(lock, String(pid));
    const l = runOn(f);
    assert.equal(l.status, 2, l.stdout + l.stderr); assert.match(l.stderr, why);
    assert.equal(fs.readFileSync(lock, 'utf8'), String(pid), 'another run\'s lock is left alone');
  }
  fs.rmSync(lock);
  // A write run must say the server waits for the lock (busy timeout) or is stopped.
  const u = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/book-init.mjs'), f, '--commit', 'test', '--deep', '/nonexistent'], { encoding: 'utf8' });
  assert.equal(u.status, 2, u.stdout + u.stderr); assert.match(u.stderr, /--server-has-busy-timeout/);
  assert.equal(fs.existsSync(lock), false);
  const d = new DatabaseSync(f, { readOnly: true });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'book'").get().n, 0, 'nothing written'); d.close();
}
// A signal during the (synchronous) write stops the run at once: no book_ver row, part of the rows, the lock left behind
// as stale; the next run says so, and once the lock is removed it continues the version.
{
  const f = fresh('sigterm.db'), lock = f + '.book-init.lock';
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/book-init.mjs'), f, '--commit', 'test', '--deep', '/nonexistent', '--jobs', '2', '--server-stopped', '--chunk', '1', '--pause-ms', '300'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', sent = 0; const t0 = Date.now();
  const on = (d) => { out += d; if (!sent && /A2 holds on the plan/.test(out)) { sent = 1; setTimeout(() => { sent = Date.now(); child.kill('SIGTERM'); }, 700); } };
  child.stdout.on('data', on); child.stderr.on('data', on);
  const [code, sig] = await new Promise((res) => child.on('exit', (c, s) => res([c, s])));
  assert.ok(sent > 1, 'signal sent during the write: ' + out);
  assert.ok(Date.now() - sent < 1000, `stopped at once, not after the write (${Date.now() - t0} ms): ` + out);
  assert.equal(sig, 'SIGTERM', `killed by the signal (code ${code}): ` + out);
  const n = bookCount(f);
  assert.deepEqual(n.vers, [], 'no book_ver row: the version is incomplete');
  assert.ok(n.book > 0 && n.book < rep.rows.book, `part of the rows written (${n.book}/${rep.rows.book})`);
  assert.ok(fs.existsSync(lock), 'the lock is left');
  const l = runOn(f);
  assert.equal(l.status, 2, l.stdout + l.stderr); assert.match(l.stderr, /not running/);
  fs.rmSync(lock);
  const k = runOn(f, '--chunk', '5');
  assert.equal(k.status, 0, k.stdout + k.stderr);
  assert.deepEqual(bookCount(f), { book: rep.rows.book, vers: [{ ver: 1, added: rep.rows.book }] }, 'the next run continues the version');
}
// Exclusions: resolved by position (any spelling), applied to every puzzle that reaches the position; an entry that
// does not resolve stops the run before anything is written (exit 2).
{
  const f = fresh('ex.db');
  const d = new DatabaseSync(f);
  const ps = ROWS.find((r) => r.id === 'ps505288');
  d.prepare('INSERT INTO puzzles (id, size, tps, plies, tree, komi, swing, turn, grade) VALUES (?,?,?,?,?,?,?,?,?)').run('ps505288-dup', ps.size, ps.tps.replace(/ 37$/, ' 41'), ps.plies, ps.tree, ps.komi, ps.swing, 1, null);
  d.close();
  const exf = path.join(dir, 'ex.json');
  fs.writeFileSync(exf, JSON.stringify([{ puzzle: 'ps505288', path: '', move: '1c4-', why: 'test spelling' }]));
  const e1 = runOn(f, '--exclude', exf);
  assert.equal(e1.status, 0, e1.stdout + e1.stderr);
  const er = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
  assert.equal(er.a2.excluded.length, 1); assert.ok(er.a2.excluded[0].absent && er.a2.excluded[0].pos);
  assert.deepEqual(er.a2.excludedReached.map((x) => x.puzzle).sort(), ['ps505288', 'ps505288-dup'], 'by position, from every puzzle');
  const d2 = new DatabaseSync(f, { readOnly: true });
  assert.equal(bookLookup(d2, er.a2.excluded[0].pos, 99), null); d2.close();
  for (const bad of [{ puzzle: 'ps505288x', path: '', move: 'c4-' }, { puzzle: 'ps505288', path: '', move: 'c3' }, { puzzle: 'ps505288', path: '', move: 'zz' }]) {
    const g = fresh('bad.db');
    fs.writeFileSync(exf, JSON.stringify([bad]));
    const b = runOn(g, '--exclude', exf);
    assert.equal(b.status, 2, JSON.stringify(bad) + b.stdout + b.stderr);
    assert.match(b.stderr, /does not resolve/);
    const d3 = new DatabaseSync(g, { readOnly: true });
    const has = d3.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'book'").get().n; d3.close();
    if (has) assert.deepEqual(bookCount(g), { book: 0, vers: [] }, 'nothing written (empty tables at most)');
  }
}
// A2 is checked on the plan: a failing A2 (here a walk error) writes nothing at all.
{
  const f = fresh('fail.db');
  const d = new DatabaseSync(f);
  d.prepare('INSERT INTO puzzles (id, size, tps, plies, tree, komi, swing, turn, grade) VALUES (?,?,?,?,?,?,?,?,?)').run('pbad', 4, '2,x,1,x/221,x,1,x/x,21,2212,x/2,x2,1 1 12', 3, '{"a4":{"r":"zz","n":"win"}}', 0, null, 1, null);
  d.close();
  const r = runOn(f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /A2 FAIL \(nothing written\)/);
  assert.deepEqual(bookCount(f), { book: 0, vers: [] });
}
// Proofs survive the run in the resume file: a fresh database takes them from it; a recorded failure becomes an
// unchecked placeholder row, which a later run with --retry-failed replaces with the proof; a run with no file skips
// alts the book already holds with a checked length.
{
  const rf = path.join(dir, 'proofs.jsonl');
  const a = runOn(fresh('res1.db'), '--resume', rf);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  const ra = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
  const lines = fs.readFileSync(rf, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, ra.altPositions); assert.equal(ra.proofsResumed, 0);
  const f = fresh('res2.db');
  const failed = lines[0].pos;
  fs.writeFileSync(rf, lines.map((l) => JSON.stringify(l.pos === failed ? { pos: l.pos, fail: 'test: budget' } : l)).join('\n') + '\n{"pos": "cut by a ki');
  const b = runOn(f, '--resume', rf);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const rb = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
  assert.equal(rb.proofsResumed, ra.altPositions, 'every proof from the file'); assert.equal(rb.proofsBy.resume ?? 0, 0);
  assert.equal(rb.reproofFailurePositions, 1);
  let d = new DatabaseSync(f, { readOnly: true });
  assert.deepEqual({ ...bookLookup(d, failed, 1) }.checked, 0); d.close();
  const c = runOn(f, '--resume', rf, '--retry-failed');
  assert.equal(c.status, 0, c.stdout + c.stderr);
  const rc = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
  assert.deepEqual([rc.ver, rc.publish.added, rc.publish.retired, rc.reproofFailures], [2, 1, 1, 0]);
  d = new DatabaseSync(f, { readOnly: true });
  const now = bookLookup(d, failed, 2); assert.ok(now.checked === 1 && now.win_len > 0, 'the proof replaced the placeholder'); d.close();
  const e = runOn(f, '--resume', 'none');
  assert.equal(e.status, 0, e.stdout + e.stderr);
  const re = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
  assert.deepEqual([re.alreadyProvedInBook, re.publish.added, re.rows.book_ver], [ra.altPositions, 0, 2]);
}
// 6x6 alts go to deep, read line by line as it prints (a stand-in deep here: q=0 disproves, q=1 proves in 5); the q=0
// failure is recorded, and a re-run from the resume file calls deep for nothing.
{
  const fake = path.join(dir, 'fake-deep.sh'), calls = path.join(dir, 'calls.txt');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$4" >> '${calls}'\ncase "$4" in q=0) r=disproved; n=0;; *) r=proved; n=5;; esac\nawk -v r=$r -v n=$n '{ printf "%d\\t%s\\t%d\\t%d\\t1\\t1\\t-\\n", NR-1, r, n, n }' "$2"\n`, { mode: 0o755 });
  const exf = path.join(dir, 'none.json'); fs.writeFileSync(exf, '[]'); // ps505288 c4- becomes an ordinary 6x6 alt
  const rf = path.join(dir, 'six.jsonl');
  const go = (f) => spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/book-init.mjs'), f, '--commit', 'test', '--deep', fake, '--jobs', '2', '--server-has-busy-timeout', '--exclude', exf, '--resume', rf, '--report', path.join(dir, 'r.json')], { encoding: 'utf8' });
  const f = fresh('six.db'), a = go(f);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean), ['q=0', 'q=1']);
  const ra = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
  assert.equal(ra.proofsBy['deep q=1'], 1);
  const rec = fs.readFileSync(rf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.q0fail || x.how?.startsWith('deep'));
  assert.deepEqual(rec.map((x) => x.q0fail ? 'q0fail' : x.how), ['q0fail', 'deep q=1']);
  const d = new DatabaseSync(f, { readOnly: true });
  const row = bookLookup(d, rec[1].pos, 1); d.close();
  assert.deepEqual([row.win_len, row.model, row.checked, row.exact], [5, 'threat+1quiet', 1, 0]);
  fs.rmSync(calls);
  const b = go(fresh('six2.db'));
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.equal(fs.existsSync(calls), false, 'deep not called: every proof resumed');
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('ok book-init: deep output read as it comes, q=0 failures recorded, resumed run calls deep for nothing');
console.log('ok book-init: proofs resume from the file, --retry-failed replaces a placeholder, proved alts skipped');
console.log('ok book-init: exclusions by position, unresolved entries stop the run, failing A2 writes nothing');
console.log('ok book-init: write runs need --server-has-busy-timeout or --server-stopped, one run per database (lock file), a signal during the write stops it at once, waits for a held write lock, chunked, continues a killed version, takes back rows the plan dropped');
console.log(`ok book-init: fixture A2 pass (${rep.rows.book} rows), idempotent, dry run writes nothing, exclusion applied`);
