// B2 (docs/plan/PLAN.md §3.1): publish-puzzles ships book rows insert-only as crux's next book version, bumps
// puzzles.rev and writes puzzle_rev, against a fake crux (the shims of scripts/test-deploy.mjs: ssh, rsync, launchctl,
// curl, sqlite3 and node on PATH, a temp directory for crux's home). Acceptance: version N+1 adds rows; lowering the
// pointer hides them (and brings back what they retired); nothing on crux is ever updated or deleted in place (only a
// retired_ver goes from NULL to the new version). Also import.mjs alone: a book conflict rolls back the puzzles too, and
// a failed status backfill exits non-zero.   node --no-warnings scripts/test-publish-book.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { publishBook, bookLookup } from '../server/book.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-publish-book-test-'));
const SH = path.join(T, 'shims'), CRUX = path.join(T, 'crux'), LOG = path.join(T, 'log'), STATE = path.join(T, 'state');
const LOCAL_DB = path.join(T, 'local.db'), CRUX_DB = path.join(CRUX, 'Projects/tinue/data/tinue.db');
for (const d of [SH, CRUX, STATE, path.join(CRUX, 'Library/LaunchAgents'), path.join(CRUX, 'Library/Logs'), path.dirname(CRUX_DB), path.join(T, 'empty')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(LOG, '');
const shim = (name, body) => fs.writeFileSync(path.join(SH, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
shim('ssh', `while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
host=$1; shift
printf 'ssh %s %s\\n' "$host" "$(printf '%s' "$*" | tr '\\n' ' ' | cut -c1-400)" >> "$FAKE_LOG"
cd "$FAKE_CRUX" && exec env -i HOME="$FAKE_CRUX" PATH="$FAKE_SHIMS:/usr/bin:/bin" FAKE_LOG="$FAKE_LOG" FAKE_CRUX="$FAKE_CRUX" /bin/sh -c "$*"`);
shim('rsync', `n=$#; skip=
for a in "$@"; do
  if [ -n "$skip" ]; then skip=; continue; fi
  case "$a" in -e) skip=1 ;; --timeout=*) ;; *:*) set -- "$@" "$FAKE_CRUX/\${a#*:}" ;; *) set -- "$@" "$a" ;; esac
done
shift $n
echo "rsync $*" >> "$FAKE_LOG"
exec /usr/bin/rsync "$@"`);
shim('scp', 'echo "scp $*" >> "$FAKE_LOG"; exit 1');
shim('launchctl', `echo "launchctl $*" >> "$FAKE_LOG"
case "$1" in print) [ -f "$FAKE_CRUX/.loaded" ] ;; bootstrap) touch "$FAKE_CRUX/.loaded" ;; bootout) rm -f "$FAKE_CRUX/.loaded" ;; esac`);
shim('curl', `echo "curl $*" >> "$FAKE_LOG"; echo '{"n":1}'`);
shim('dig', 'echo "dig $*" >> "$FAKE_LOG"; echo 100.64.0.1');
shim('tailscale', 'echo "tailscale $*" >> "$FAKE_LOG"');
shim('sleep', 'exit 0');
shim('sqlite3', 'echo "sqlite3 $*" >> "$FAKE_LOG"; exec /usr/bin/sqlite3 "$@"');
shim('rnode', `echo "node $*" >> "$FAKE_LOG"; exec '${process.execPath}' "$@"`);
const log = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
const clearLog = () => fs.writeFileSync(LOG, '');
const ENV = { ...process.env, PATH: SH + ':' + process.env.PATH, FAKE_LOG: LOG, FAKE_CRUX: CRUX, FAKE_SHIMS: SH, CRUX: 'shy@crux',
  CRUX_NODE: path.join(SH, 'rnode'), CRUX_SQLITE: path.join(SH, 'sqlite3'), TINUE_DEPLOY_DIR: STATE, TINUE_DB: LOCAL_DB, DRY_RUN: '' };
const sh = (script, args = []) => { const r = spawnSync('sh', [path.join(ROOT, 'scripts', script), ...args], { env: ENV, encoding: 'utf8', timeout: 120e3 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const ok = (r, what) => assert.equal(r.code, 0, `${what} failed:\n${r.out}`);

const puzzle = (i, extra = {}) => ({ id: 'p' + i, size: 5, tps: `x5/x5/x5/x5/${i},x4 1 ${i}`, komi: 0, plies: 1, tree: { a1: 'win' }, tags: ['s5'],
  rating: 1000 + i, source: 'PlayTak', sourceRef: null, meta: { gameId: i }, turn: 1, swing: { pre0: 0.1, alt: null }, grade: null, ...extra });
function importRows(db, rows, args = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(T, 'rows-'));
  fs.writeFileSync(path.join(dir, 'p.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/import.mjs'), dir, ...args],
    { cwd: path.join(T, 'empty'), env: { ...process.env, TINUE_DB: db, TINUE_ACCESS_LOG: path.join(T, 'access.log'), ...env }, encoding: 'utf8' });
}
const load = (db, rows) => { const r = importRows(db, rows); assert.equal(r.status, 0, r.stderr + r.stdout); };
const withDb = (f, fn) => { const d = new DatabaseSync(f); try { return fn(d); } finally { d.close(); } };
const bookRows = (f) => withDb(f, (d) => d.prepare('SELECT * FROM book ORDER BY pos, ver').all().map((r) => ({ ...r })));
const snapshots = () => { const d = path.join(CRUX, 'Projects/tinue/data/snapshots'); return fs.existsSync(d) ? fs.readdirSync(d).length : 0; };

// Positions (bookKey format; the book never parses them) and rows.
const P = { A: 'x5/x5/x5/x5/1,x4 2|0', B: 'x5/x5/x5/x5/2,x4 2|0', C: 'x5/x5/x5/x5/3,x4 2|0', D: 'x5/x5/x5/x5/4,x4 2|0', E: 'x5/x5/x5/x5/5,x4 2|0' };
const tree = (pos, win_len) => ({ pos, win_len, exact: 0, model: 'threat', proof: 'tree', checked: 0, puzzle_id: 'p1' });
const cert = (pos, win_len) => ({ pos, win_len, exact: 1, model: 'full', proof: 'deep-cert', checked: 1, puzzle_id: 'p1' });

// crux: 4 puzzles (p1 played), book version 1 = A (threat 7), B (threat 5), D (full exact 7)
const v1 = [1, 2, 3, 4].map((i) => puzzle(i));
load(CRUX_DB, v1);
withDb(CRUX_DB, (d) => { d.exec("UPDATE puzzles SET attempts = 3, rating = 1234 WHERE id = 'p1'"); publishBook(d, { rows: [tree(P.A, 7), tree(P.B, 5), cert(P.D, 7)], commitSha: 'crux1' }); });
// local: p2's tree changed; book v1 = A, B; v2 = A' (full exact 5: stronger, retires A), C (new)
load(LOCAL_DB, v1.map((p) => (p.id === 'p2' ? { ...p, tree: { a1: 'win', b1: 'win' } } : p)));
withDb(LOCAL_DB, (d) => {
  publishBook(d, { rows: [tree(P.A, 7), tree(P.B, 5)], commitSha: 'local1' });
  const r = publishBook(d, { rows: [cert(P.A, 5), tree(P.C, 9)], commitSha: 'local2' });
  assert.equal(r.ver, 2); assert.equal(r.retired, 1);
});
ok(sh('deploy-crux.sh'), 'deploy-crux.sh (code onto the fake crux)');

// 1. version N+1 adds rows; the stronger row retires the weaker one; rev bumped, the old tree kept
{
  const before = bookRows(CRUX_DB), snaps = snapshots();
  clearLog(); const r = sh('publish-puzzles.sh'); ok(r, 'publish with book rows');
  assert.match(r.out, /new 0, changed 1, unchanged 3/);
  assert.match(r.out, /book: 3 live local rows .*new 1, stronger 1, already there or weaker 1; shipping 2/);
  assert.match(r.out, /book: version 2 added 2 rows, retired 1/);
  assert.match(r.out, /book verify: 2 of 2 shipped rows now live on crux \(book version 2\)/);
  assert.match(r.out, /puzzle rev: 1 puzzles/);
  assert.match(r.out, /Nothing is served from it until TINUE_BOOK_VER/);
  assert.equal(snapshots(), snaps + 1, 'one snapshot before the write');
  const L = log(), snap = L.findIndex((l) => /^sqlite3 data\/tinue\.db \.backup/.test(l)), imp = L.findIndex((l) => /import\.mjs rows --book book\/book\.jsonl --book-commit \w+ --book-note publish-/.test(l));
  assert.ok(snap >= 0 && imp > snap, 'snapshot, then the one import with --book:\n' + L.join('\n'));
  const after = bookRows(CRUX_DB);
  // insert-only: every earlier row is still there, every column the same except a retired_ver set NULL -> 2
  assert.equal(after.length, before.length + 2);
  for (const b of before) {
    const a = after.find((x) => x.pos === b.pos && x.ver === b.ver);
    assert.ok(a, 'row deleted: ' + b.pos);
    const { retired_ver: ra, ...restA } = a, { retired_ver: rb, ...restB } = b;
    assert.deepEqual(restA, restB, 'row edited in place: ' + b.pos);
    assert.ok(rb === null && (ra === null || ra === 2), 'retired_ver only ever set to the new version');
  }
  assert.equal(after.find((x) => x.pos === P.A && x.ver === 1).retired_ver, 2, 'A retired by the stronger A\'');
  assert.equal(after.find((x) => x.pos === P.B && x.ver === 1).retired_ver, null, 'B untouched');
  assert.equal(after.find((x) => x.pos === P.A && x.ver === 2).commit_sha, 'local2', 'row provenance kept');
  withDb(CRUX_DB, (d) => {
    const bv = d.prepare('SELECT * FROM book_ver WHERE ver = 2').get();
    assert.equal(bv.added, 2); assert.equal(bv.retired, 1); assert.match(bv.note, /^publish-/);
    // the pointer: 2 serves the new rows; 1 hides them and brings A back; 0 is the book off
    assert.equal(bookLookup(d, P.A, 2).win_len, 5); assert.equal(bookLookup(d, P.A, 2).model, 'full');
    assert.equal(bookLookup(d, P.A, 1).win_len, 7); assert.equal(bookLookup(d, P.A, 1).model, 'threat');
    assert.equal(bookLookup(d, P.C, 2).win_len, 9); assert.equal(bookLookup(d, P.C, 1), null);
    assert.equal(bookLookup(d, P.D, 2).win_len, 7, 'a crux row the local book lacks stays live');
    for (const p of Object.values(P)) assert.equal(bookLookup(d, p, 0), null);
    // rev: p2's tree changed -> rev 1, rev 0's tree in puzzle_rev; nothing else bumped; a played puzzle keeps its rating
    assert.deepEqual(d.prepare('SELECT id, rev FROM puzzles ORDER BY id').all().map((x) => [x.id, x.rev]), [['p1', 0], ['p2', 1], ['p3', 0], ['p4', 0]]);
    const pr = d.prepare('SELECT * FROM puzzle_rev').all();
    assert.equal(pr.length, 1); assert.equal(pr[0].id, 'p2'); assert.equal(pr[0].rev, 0); assert.deepEqual(JSON.parse(pr[0].tree), { a1: 'win' });
    assert.deepEqual({ ...d.prepare("SELECT rating, attempts FROM puzzles WHERE id = 'p1'").get() }, { rating: 1234, attempts: 3 });
  });
  // again: nothing to do
  clearLog(); const again = sh('publish-puzzles.sh'); ok(again, 'second publish');
  assert.match(again.out, /shipping 0\n/); assert.match(again.out, /nothing to publish/);
  assert.ok(!log().some((l) => /\.backup|import\.mjs|kickstart/.test(l)), 'an empty publish writes nothing');
  console.log('book publish: ok (version 2 adds 2 rows, retires 1 by setting retired_ver; pointer 1 hides them; rev + puzzle_rev; nothing edited or deleted)');
}

// 2. a length conflict with crux's book stops the publish before anything is written
{
  withDb(LOCAL_DB, (d) => publishBook(d, { rows: [cert(P.D, 9)], commitSha: 'local3' })); // crux: D full exact 7
  const before = bookRows(CRUX_DB), snaps = snapshots();
  clearLog(); const r = sh('publish-puzzles.sh');
  assert.notEqual(r.code, 0, 'a conflict must fail the publish'); assert.match(r.out, /1 LENGTH CONFLICTS with crux/);
  assert.equal(snapshots(), snaps); assert.deepEqual(bookRows(CRUX_DB), before);
  assert.ok(!log().some((l) => /\.backup|import\.mjs|kickstart/.test(l)), 'nothing written on a conflict');
  withDb(LOCAL_DB, (d) => { d.exec('DELETE FROM book WHERE ver = 3; DELETE FROM book_ver WHERE ver = 3'); }); // (the local test book only)
  console.log('book conflict: ok (refused before the snapshot; crux unchanged)');
}

// 3. crux's import.mjs predating B2 would skip --book: refused before anything is written
{
  withDb(LOCAL_DB, (d) => publishBook(d, { rows: [tree(P.E, 3)], commitSha: 'local3' }));
  const imp = path.join(CRUX, 'Projects/tinue/scripts/import.mjs'), src = fs.readFileSync(imp, 'utf8');
  fs.writeFileSync(imp, src.replaceAll('import-book-v1', 'old'));
  const before = bookRows(CRUX_DB), snaps = snapshots();
  const r = sh('publish-puzzles.sh');
  assert.notEqual(r.code, 0); assert.match(r.out, /predates book publishing/);
  assert.equal(snapshots(), snaps); assert.deepEqual(bookRows(CRUX_DB), before);
  fs.writeFileSync(imp, src);
  // dry run: estimated from the last manifest, prints, runs nothing
  clearLog(); const dry = sh('publish-puzzles.sh', ['--dry-run']); ok(dry, 'dry run');
  assert.match(dry.out, /shipping 1\n/); assert.match(dry.out, /\(1 book rows\)/); assert.deepEqual(log(), [], 'a dry run invoked a remote command');
  const ok3 = sh('publish-puzzles.sh'); ok(ok3, 'publish after the code is current');
  assert.match(ok3.out, /book: version 3 added 1 rows, retired 0/);
  withDb(CRUX_DB, (d) => { assert.equal(bookLookup(d, P.E, 3).win_len, 3); assert.equal(bookLookup(d, P.E, 2), null); });
  console.log('old import on crux: ok (refused, nothing written; publishes once current)');
}

// 3b. a row crux retired without a replacement (as rejudge would for a disproved alt) is not shipped back as new; a
// strictly stronger local row for that pos is
{
  withDb(CRUX_DB, (d) => { const r = publishBook(d, { retire: [P.B], commitSha: 'rejudge' }); assert.equal(r.ver, 4); assert.equal(bookLookup(d, P.B, 4), null); });
  const before = bookRows(CRUX_DB);
  clearLog(); const r = sh('publish-puzzles.sh'); ok(r, 'publish after a retirement on crux');
  assert.match(r.out, /shipping 0\n/); assert.match(r.out, /book: 1 rows crux retired without a replacement are held/);
  assert.deepEqual(bookRows(CRUX_DB), before, 'crux unchanged');
  withDb(CRUX_DB, (d) => assert.equal(bookLookup(d, P.B, 5), null));
  withDb(LOCAL_DB, (d) => publishBook(d, { rows: [cert(P.B, 5)], commitSha: 'local4' }));
  const s = sh('publish-puzzles.sh'); ok(s, 'publish a stronger row over a retired one');
  assert.match(s.out, /new 0, stronger 1, .*shipping 1\n/); assert.match(s.out, /book: version 5 added 1 rows, retired 0/);
  withDb(CRUX_DB, (d) => { assert.equal(bookLookup(d, P.B, 5).model, 'full'); assert.equal(bookLookup(d, P.B, 4), null); });
  console.log('crux-retired row: ok (held, not revived; a strictly stronger row ships)');
}

// 4. import.mjs alone: a book conflict rolls back the whole import (puzzles too); --book needs --book-commit
{
  const db = path.join(T, 'solo.db');
  load(db, [puzzle(1)]);
  withDb(db, (d) => publishBook(d, { rows: [cert(P.A, 5)], commitSha: 's1' }));
  const bf = path.join(T, 'book.jsonl');
  fs.writeFileSync(bf, JSON.stringify(cert(P.A, 7)) + '\n');
  const r = importRows(db, [puzzle(1, { tree: { a1: 'win', c1: 'win' } }), puzzle(9)], ['--book', bf, '--book-commit', 'x']);
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /REFUSED, nothing written/);
  withDb(db, (d) => {
    assert.equal(d.prepare("SELECT COUNT(*) n FROM puzzles WHERE id = 'p9'").get().n, 0, 'puzzle written despite the refusal');
    assert.equal(d.prepare("SELECT rev FROM puzzles WHERE id = 'p1'").get().rev, 0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM puzzle_rev').get().n, 0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM book').get().n, 1);
  });
  assert.equal(importRows(db, [puzzle(9)], ['--book', bf]).status, 2, '--book without --book-commit');
  // a rev bump twice: rev 0 and rev 1 both kept
  load(db, [puzzle(1, { tree: { a1: 'win', c1: 'win' } })]); load(db, [puzzle(1, { tps: 'x5/x5/x5/x5/1,x4 1 2' })]);
  withDb(db, (d) => {
    assert.equal(d.prepare("SELECT rev FROM puzzles WHERE id = 'p1'").get().rev, 2);
    assert.deepEqual(d.prepare('SELECT rev, tps FROM puzzle_rev ORDER BY rev').all().map((x) => [x.rev, x.tps]), [[0, 'x5/x5/x5/x5/1,x4 1 1'], [1, 'x5/x5/x5/x5/1,x4 1 1']]);
  });
  // themes/meta/grade only: no bump
  load(db, [puzzle(1, { tps: 'x5/x5/x5/x5/1,x4 1 2', tags: ['s5', 'quiet'], meta: { x: 1 } })]);
  withDb(db, (d) => assert.equal(d.prepare("SELECT rev FROM puzzles WHERE id = 'p1'").get().rev, 2));
  console.log('import --book: ok (a conflict rolls back the puzzles too; rev bumps only on tree/tps/komi)');
}

// 5. import.mjs: a failed status backfill after the commit exits non-zero, loudly
{
  const db = path.join(T, 'state.db');
  load(db, [puzzle(1)]);
  withDb(db, (d) => d.exec("CREATE TRIGGER no_status BEFORE UPDATE OF status ON puzzles BEGIN SELECT RAISE(ABORT, 'status write blocked'); END"));
  const r = importRows(db, [puzzle(2)]);
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stdout, /puzzle state: NOT updated/); assert.match(r.stderr, /FAILED AFTER COMMIT.*status write blocked/s); assert.match(r.stderr, /scripts\/puzzle-state\.mjs/);
  withDb(db, (d) => assert.equal(d.prepare("SELECT COUNT(*) n FROM puzzles WHERE id = 'p2'").get().n, 1, 'the import itself committed'));
  console.log('import status backfill failure: ok (exit 4, loud)');
}
fs.rmSync(T, { recursive: true, force: true });
console.log('publish book: all ok');
