// Puzzle state columns (server/puzzle-state.js, PLAN P1): import.mjs fills them for new rows, a re-import writes nothing,
// scripts/puzzle-state.mjs repairs a hand edit, and status = 'served' exactly where the old served predicate held. Throwaway databases in a temp dir only.
//   node --no-warnings scripts/test-puzzle-state.mjs
//   TINUE_STATE_DB=<a copy of the build DB> ... also checks every row of that copy (it is copied again first; never written)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-state-'));
const env = { ...process.env, TINUE_ACCESS_LOG: path.join(dir, 'access.log') };
const node = (args, opts = {}) => spawnSync(process.execPath, ['--no-warnings', ...args], { encoding: 'utf8', env, ...opts });

// The served pool as server.js defined it before it read status (PLAN P2; scripts/test-pstate.mjs compares the two)
const SERVED = (r) => r.turn === 1 || r.grade === 'A';
// status as defined: grade D is rejected, or paused when held (Q11); otherwise the old served pool, then holds.
const STATUS = (r, held) => (r.grade === 'D' ? (held.has(r.id) ? 'paused' : 'rejected') : SERVED(r) ? 'served' : held.has(r.id) ? 'paused' : 'reserve');

// Every row: status/kind/pre0/miner as defined. served: rows that should be 'served'; diff: rows where status says
// otherwise. Returns counts.
function checkAll(file, held = new Set()) {
  const db = new DatabaseSync(file, { readOnly: true });
  const n = { rows: 0, served: 0, diff: 0 };
  for (const r of db.prepare('SELECT id, turn, grade, swing, kind, status, pre0, miner, book FROM puzzles').iterate()) {
    n.rows++;
    const want = STATUS(r, held);
    if (want === 'served') n.served++;
    if ((want === 'served') !== (r.status === 'served')) n.diff++;
    assert.equal(r.status, want, r.id);
    assert.equal(r.kind, { 1: 'turning', 0: 'conversion' }[r.turn] ?? 'unscored', r.id);
    const sw = r.swing ? JSON.parse(r.swing) : {};
    assert.equal(r.pre0, sw.pre0 ?? null, r.id);
    assert.equal(r.miner, /^[a-z]+(?=\d)/.exec(r.id)?.[0] ?? null, r.id);
    assert.equal(r.book, null, r.id); // no book before B1
  }
  db.close();
  return n;
}

// Fixture: a deploy-export-shaped file (turn, swing, grade on each row) through the real import.
const I = path.join(dir, 'imp'), DB = path.join(I, 't.db');
fs.mkdirSync(path.join(I, 'p'), { recursive: true });
const tps = (i) => `x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 ${14 + i}`;
const sw = (pre0) => ({ pre0, pre2: 0.5, alts: [] });
const rows = [
  ['ps1', 1, sw(0.21), null], ['ps2', 0, sw(0.9), 'A'], ['ps3', 0, sw(0.8), 'B'], ['ps4', 0, sw(0.7), 'D'], // turning, A, B, held D
  ['pd5', null, null, null], ['pdg6-1', null, null, 'A'], ['p7', 1, sw(null), 'D'], ['pc8', 0, null, null], ['x', 1, sw(0), null],
  ['pd9', 0, null, 'D'], ['p10', 1, sw(0.1), 'D'], // D conversion, D turning point (Q11: both rejected)
];
fs.writeFileSync(path.join(I, 'p/a.jsonl'), rows.map(([id, turn, swing, grade], i) =>
  JSON.stringify({ id, size: 6, tps: tps(i), plies: 1, tree: { b1: 'win' }, source: 'test', rating: 1500, turn, swing, grade })).join('\n') + '\n');
fs.writeFileSync(path.join(I, 'ov.jsonl'), [{ id: 'ps4', tier: 'D', why: 'held', 'hold-20261116': true }, { id: 'p7', tier: 'D', why: 'held but turning', 'hold-20261116': true },
  { id: 'ps3', tier: 'B', why: 'not a hold' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
const held = new Set(['ps4', 'p7']);
const imp = () => node([path.join(ROOT, 'scripts/import.mjs'), 'p', '--overrides', 'ov.jsonl'], { cwd: I, env: { ...env, TINUE_DB: DB } });
let r = imp();
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /puzzle state \(kind, status, pre0, miner\): 11 of 11 rows updated/);
let n = checkAll(DB, held);
assert.deepEqual(n, { rows: 11, served: 4, diff: 0 });
const got = Object.fromEntries(new DatabaseSync(DB, { readOnly: true }).prepare('SELECT id, kind, status, pre0, miner FROM puzzles').all().map((x) => [x.id, `${x.kind} ${x.status} ${x.pre0} ${x.miner}`]));
assert.deepEqual(got, {
  ps1: 'turning served 0.21 ps', ps2: 'conversion served 0.9 ps', ps3: 'conversion reserve 0.8 ps', ps4: 'conversion paused 0.7 ps',
  pd5: 'unscored reserve null pd', 'pdg6-1': 'unscored served null pdg', p7: 'turning paused null p', pc8: 'conversion reserve null pc', x: 'turning served 0 null',
  pd9: 'conversion rejected null pd', p10: 'turning rejected 0.1 p',
});
console.log('ok import: new rows get kind, status, pre0, miner (grade D is rejected, or paused when held, even a turning point)');

r = imp();
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /0 of 11 rows updated/);
console.log('ok import: a re-import writes no state row');

// A hand fix that bypasses import (crux one-row update): --check sees it, the script repairs it, a re-run writes nothing.
{ const db = new DatabaseSync(DB); db.prepare("UPDATE puzzles SET grade = 'A' WHERE id = 'ps3'").run(); db.close(); }
const ps = (...a) => node([path.join(ROOT, 'scripts/puzzle-state.mjs'), DB, '--overrides', path.join(I, 'ov.jsonl'), ...a]);
r = ps('--check');
assert.equal(r.status, 1, r.stdout + r.stderr);
assert.match(r.stdout, /11 rows, 1 differ/);
r = ps();
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /11 rows, 1 updated/);
assert.equal(ps('--check').status, 0);
assert.match(ps().stdout, /11 rows, 0 updated/);
assert.deepEqual(checkAll(DB, held), { rows: 11, served: 5, diff: 0 });
console.log('ok puzzle-state.mjs: --check finds a hand edit, a run repairs it, a re-run writes nothing');

// A database backfilled before Q11 (D rows 'served'/'reserve'): --dry-run counts old -> new status and writes nothing;
// a run moves them; a second dry run has nothing to write.
{
  const db = new DatabaseSync(DB);
  db.exec("UPDATE puzzles SET status = 'reserve' WHERE id = 'pd9'; UPDATE puzzles SET status = 'served' WHERE id IN ('p10', 'p7')");
  db.close();
  r = ps('--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /11 rows, 3 would be written/);
  assert.match(r.stdout, /reserve -> rejected \*  1\n/); assert.match(r.stdout, /served -> rejected \*  1\n/); assert.match(r.stdout, /served -> paused \*  1\n/);
  assert.match(r.stdout, /served -> served  5\n/);
  const typo = ps('--dryrun');
  assert.equal(typo.status, 2); assert.match(typo.stderr, /unknown option --dryrun/);
  for (const [a, re] of [['--swing', /--swing needs a path/], ['--overide', /unknown option --overide/]]) {
    const x = node([path.join(ROOT, 'scripts/import.mjs'), 'p', '--no-overrides', a], { cwd: I, env: { ...env, TINUE_DB: DB } });
    assert.equal(x.status, 2); assert.match(x.stderr, re);
  }
  assert.equal(ps('--check').status, 1); // nothing written by the dry run, or by a mistyped one
  assert.match(ps().stdout, /11 rows, 3 updated/);
  assert.match(ps('--dry-run').stdout, /11 rows, 0 would be written/);
  assert.deepEqual(checkAll(DB, held), { rows: 11, served: 5, diff: 0 });
  console.log('ok puzzle-state.mjs --dry-run: old -> new status counts, nothing written; the run then moves D rows to rejected');
}

// A database from before P1: the script adds the columns itself (as the server does at startup).
{
  const OLD = path.join(dir, 'old.db'), o = new DatabaseSync(OLD);
  o.exec(`CREATE TABLE puzzles (id TEXT PRIMARY KEY, turn INTEGER, grade TEXT, swing TEXT); INSERT INTO puzzles VALUES ('ps1', 1, NULL, '{"pre0":0.3}'), ('pd2', 0, 'C', NULL);`);
  o.close();
  r = node([path.join(ROOT, 'scripts/puzzle-state.mjs'), OLD]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /added 5 columns; 2 rows, 2 updated/);
  assert.deepEqual(checkAll(OLD), { rows: 2, served: 1, diff: 0 });
  console.log('ok puzzle-state.mjs: adds the columns to an older database');
}

// The state pass runs after the import commits, never inside its transaction (inside, its scan of every row held the
// write lock ~250 ms per publish on 71k rows, while posted results wait). Seen from outside: a pass that throws
// (here an old row whose swing is not JSON) leaves the import committed, and exits 4 with a loud message (B2: the stored
// status decides serving, so a missed backfill must stop a publish before the restart).
{
  const J = path.join(dir, 'after'), JDB = path.join(J, 't.db');
  fs.mkdirSync(path.join(J, 'p'), { recursive: true });
  const line = (id, i) => JSON.stringify({ id, size: 6, tps: tps(20 + i), plies: 1, tree: 'win', source: 'test', rating: 1500, turn: 1, swing: sw(0.3), grade: null });
  fs.writeFileSync(path.join(J, 'p/a.jsonl'), line('ps90', 0) + '\n');
  const impJ = () => node([path.join(ROOT, 'scripts/import.mjs'), 'p', '--no-overrides'], { cwd: J, env: { ...env, TINUE_DB: JDB } });
  assert.equal(impJ().status, 0);
  { const db = new DatabaseSync(JDB); db.prepare("UPDATE puzzles SET swing = '{not json' WHERE id = 'ps90'").run(); db.close(); }
  fs.writeFileSync(path.join(J, 'p/a.jsonl'), line('ps91', 1) + '\n');
  r = impJ();
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stdout, /puzzle state: NOT updated/); assert.match(r.stderr, /FAILED AFTER COMMIT/);
  assert.equal(new DatabaseSync(JDB, { readOnly: true }).prepare("SELECT COUNT(*) n FROM puzzles WHERE id = 'ps91'").get().n, 1);
  console.log('ok import: the state pass runs after the commit (a failing pass exits 4, loudly; the imported rows stay)');
}

// Optional: every row of a real database copy.
if (process.env.TINUE_STATE_DB) {
  const C = path.join(dir, 'copy.db');
  const src = new DatabaseSync(process.env.TINUE_STATE_DB, { readOnly: true });
  src.exec(`VACUUM INTO '${C.replace(/'/g, "''")}'`); src.close();
  r = node([path.join(ROOT, 'scripts/puzzle-state.mjs'), C]);
  assert.equal(r.status, 0, r.stderr);
  console.log(r.stdout.trim());
  const { heldIds } = await import('../server/puzzle-state.js');
  n = checkAll(C, heldIds());
  assert.equal(n.diff, 0);
  console.log(`ok copy: ${n.rows} rows, ${n.served} served by server.js's predicate, ${n.diff} rows where status = 'served' disagrees`);
}
fs.rmSync(dir, { recursive: true, force: true });
