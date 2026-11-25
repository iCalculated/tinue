// Database steps of the move and of the backups. node:sqlite only (never the sqlite3 CLI on a live database).
//   backup SRC DST      a consistent copy of a live WAL database, as a standalone file; quick_check must pass
//   checkpoint DB       fold the WAL in and leave none behind; fails if anything else has the database open
//   manifest DB         print what the file holds, as JSON (below)
//   verify DB MANIFEST  exit 1 unless DB is that file and holds exactly that (before any server opens it)
//   stats-eq A B        exit 1 unless two /api/stats answers agree (counts exactly, averages to 1e-9)
//   count DB            the number of puzzles
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

export async function copyDb(src, dst) {
  if (!fs.existsSync(src)) throw new Error('no database at ' + src); // (opening one would create it)
  const tmp = dst + '.part';
  for (const f of [tmp, tmp + '-wal', tmp + '-shm', tmp + '-journal']) fs.rmSync(f, { force: true });
  const s = new DatabaseSync(src);
  try { s.exec('PRAGMA busy_timeout = 10000'); await backup(s, tmp, { rate: 2 ** 30 }); } finally { s.close(); }
  const d = new DatabaseSync(tmp);
  try {
    d.exec('PRAGMA journal_mode = DELETE'); // no -wal or -shm beside the copy; the server sets WAL again when it opens it
    const q = d.prepare('PRAGMA quick_check').get().quick_check;
    if (q !== 'ok') throw new Error('quick_check: ' + q);
  } finally { d.close(); }
  fs.renameSync(tmp, dst);
}
export function checkpoint(file) {
  if (!fs.existsSync(file)) throw new Error('no database at ' + file);
  const d = new DatabaseSync(file);
  try {
    const r = d.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (r.busy) throw new Error('the database is in use');
    if (d.prepare('PRAGMA journal_mode = DELETE').get().journal_mode !== 'delete') throw new Error('the database is in use'); // needs it to itself
  } finally { d.close(); }
  if (fs.existsSync(file + '-wal')) throw new Error('a WAL file is left');
}
export function sha256(file) {
  const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), b = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, b, 0, b.length, null));) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
// Every table's row count and largest rowid, the newest attempt, and the signing key by hash only.
const NEED = ['users', 'puzzles', 'attempts', 'attempt', 'rush_runs', 'rush_puzzles', 'rush_moves', 'rush_key', 'guest_attempts', 'daily'];
export function manifest(file) {
  const sha = sha256(file), size = fs.statSync(file).size, d = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = d.prepare('PRAGMA integrity_check').get().integrity_check, tables = {};
    for (const { name } of d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all()) {
      const t = { n: d.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n };
      try { t.max = d.prepare(`SELECT MAX(rowid) m FROM "${name}"`).get().m; } catch {} // WITHOUT ROWID
      tables[name] = t;
    }
    const missing = NEED.filter((t) => !tables[t]);
    return { sha, size, integrity, tables, missing, lastAttempt: tables.attempts ? d.prepare('SELECT MAX(ts) t FROM attempts').get().t : null,
      rushKey: tables.rush_key ? crypto.createHash('sha256').update(JSON.stringify(d.prepare('SELECT k FROM rush_key ORDER BY k').all())).digest('hex') : null };
  } finally { d.close(); }
}
export function verify(file, want) {
  const got = manifest(file);
  if (got.integrity !== 'ok' || got.missing.length) throw new Error(`integrity ${got.integrity}, missing ${got.missing}`);
  assert.deepEqual(got, want);
  return got;
}
export function statsEq(a, b, at = 'stats') {
  if (typeof a === 'number' && typeof b === 'number') { if (Number.isInteger(a) && Number.isInteger(b) ? a !== b : Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a))) throw new Error(`${at}: ${a} is not ${b}`); return; }
  if (a && b && typeof a === 'object' && typeof b === 'object') { assert.deepEqual(Object.keys(a), Object.keys(b), at); for (const k of Object.keys(a)) statsEq(a[k], b[k], `${at}.${k}`); return; }
  assert.deepEqual(a, b, at);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2), read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  try {
    if (cmd === 'backup' && b) await copyDb(a, b);
    else if (cmd === 'checkpoint' && a) checkpoint(a);
    else if (cmd === 'manifest' && a) console.log(JSON.stringify(manifest(a)));
    else if (cmd === 'verify' && b) { const m = verify(a, read(b)); console.log(`verify: ok ${m.sha.slice(0, 12)} ${m.size} bytes, ${m.tables.attempts.n} attempts, ${m.tables.users.n} users, ${m.tables.rush_runs.n} rush runs`); }
    else if (cmd === 'stats-eq' && b) { statsEq(read(a), read(b)); console.log('stats: equal'); }
    else if (cmd === 'count' && a) { const d = new DatabaseSync(a, { readOnly: true }); console.log(d.prepare('SELECT COUNT(*) n FROM puzzles').get().n); d.close(); }
    else { console.error('usage: db.mjs backup SRC DST | checkpoint DB | manifest DB | verify DB MANIFEST | stats-eq A B | count DB'); process.exitCode = 2; }
  } catch (e) { console.error(`db ${cmd}: ${e.message}`); process.exitCode = 1; }
}
