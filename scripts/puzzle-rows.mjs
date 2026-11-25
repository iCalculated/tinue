#!/usr/bin/env node
// Puzzle rows as content, for scripts/publish-puzzles.sh: a per-row fingerprint of what an import would store, so a
// publish ships only rows that are new or changed instead of all of them. Reads databases read-only; writes only files
// it is told to. No server code is loaded, so it also runs on crux from deploy/bin/ before any code is shipped.
//   manifest <db>                 print "id<TAB>hash" for every puzzle in <db>
//   manifest-export <jsonl>       the same for an old deploy export (deploy/puzzles/puzzles.jsonl): a first baseline
//   delta <local db> <remote manifest> <out dir> [--published <manifest>] [--overwrite-remote-edits] [--all]
//                                 write <out>/rows/puzzles.jsonl (the rows to ship, in scripts/import.mjs's format),
//                                 <out>/local.tsv (the local manifest) and <out>/shipped.txt (their ids)
//   verify <local.tsv> <remote manifest> <shipped.txt>
//                                 after a publish: every shipped row now has the local fingerprint on crux (exit 3 if not)
// The fingerprint covers exactly what scripts/import.mjs writes from an export row, normalized the way it stores it
// ('tak' tag dropped, komi 0 for none, swing cut to its keys, turn as 1/0/null), so a row that round-trips through an
// import fingerprints the same on both sides. Columns the server owns (rating once played, rd, vol, attempts, solves,
// flaw) are not in it, so live play never makes a row look changed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// What an import stores of a row's swing and turn: scripts/import.mjs uses these same two. (The key order is part of every
// fingerprint: append only.) alts/altsAt: other attacker moves that also (more slowly) win.
export const SWING_KEYS = ['pre0', 'pre2', 'pre4', 'lostBefore', 'alt', 'alts', 'altsAt', 'esc'];
export const turnOf = (t) => (t === 1 || t === true ? 1 : t === 0 || t === false ? 0 : null);
const PUBLIC = "SELECT * FROM puzzles WHERE source NOT LIKE 'Ditaktic%'"; // the local-only Ditaktic set never ships

// A database row in the deploy export's shape (what deploy-crux.sh --legacy writes, field for field).
export function exportRow(r) {
  return { id: r.id, size: r.size, tps: r.tps, komi: r.komi, plies: r.plies, tree: JSON.parse(r.tree), tags: r.themes ? r.themes.split(',') : [],
    rating: r.init_rating, source: r.source, sourceRef: r.source_ref, meta: JSON.parse(r.meta || '{}'),
    turn: r.turn ?? null, swing: r.swing ? JSON.parse(r.swing) : null, grade: r.grade ?? null };
}
// What an import of export row e leaves in the database, as one canonical value.
export function canonical(e) {
  return { id: e.id, size: e.size, tps: e.tps, plies: e.plies, tree: e.tree ?? null, themes: (e.tags || []).filter((t) => t !== 'tak').join(','),
    source: e.source, sourceRef: e.sourceRef || null, rating: e.rating, komi: e.komi || 0, meta: e.meta || {},
    turn: Object.hasOwn(e, 'swing') ? turnOf(e.turn) : undefined,
    swing: Object.hasOwn(e, 'swing') ? (e.swing ? Object.fromEntries(SWING_KEYS.map((k) => [k, e.swing[k] ?? null])) : null) : undefined,
    grade: Object.hasOwn(e, 'grade') ? e.grade ?? null : undefined };
}
export const fingerprint = (e) => crypto.createHash('sha256').update(JSON.stringify(canonical(e))).digest('hex').slice(0, 16);

const open = (f) => { if (!fs.existsSync(f)) die(`no database at ${f}`); return new DatabaseSync(f, { readOnly: true }); };
function die(msg, code = 2) { console.error('puzzle-rows: ' + msg); process.exit(code); }
function readManifest(f) {
  const m = new Map();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line) continue; const [id, h] = line.split('\t'); if (!id || !h) die(`bad manifest line in ${f}: ${line.slice(0, 80)}`); m.set(id, h); }
  return m;
}
const writeManifest = (f, m) => fs.writeFileSync(f, [...m].map(([id, h]) => id + '\t' + h + '\n').join(''));

// Run, not imported (realpath: crux's path, or a test's temp directory, may go through a symlink).
const main = (() => { try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };

if (!main) {
  // imported: nothing to run
} else if (cmd === 'manifest') {
  const db = open(args[0] || die('usage: manifest <db>'));
  let out = '';
  for (const r of db.prepare('SELECT * FROM puzzles ORDER BY id').iterate()) out += r.id + '\t' + fingerprint(exportRow(r)) + '\n';
  process.stdout.write(out);
} else if (cmd === 'manifest-export') {
  const f = args[0] || die('usage: manifest-export <jsonl>');
  let out = '';
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line.trim()) { const e = JSON.parse(line); out += e.id + '\t' + fingerprint(e) + '\n'; }
  process.stdout.write(out);
} else if (cmd === 'delta') {
  const published = opt('--published'), overwrite = flag('--overwrite-remote-edits'), all = flag('--all');
  const [dbFile, remoteFile, outDir] = args;
  if (!dbFile || !remoteFile || !outDir) die('usage: delta <local db> <remote manifest> <out dir> [--published f] [--overwrite-remote-edits] [--all]');
  const db = open(dbFile), remote = readManifest(remoteFile), last = published && fs.existsSync(published) ? readManifest(published) : null;
  fs.mkdirSync(path.join(outDir, 'rows'), { recursive: true });
  const rows = fs.openSync(path.join(outDir, 'rows', 'puzzles.jsonl'), 'w');
  const local = new Map(), shipped = [], held = [], both = [];
  let fresh = 0, changed = 0, same = 0;
  for (const r of db.prepare(PUBLIC + ' ORDER BY id').iterate()) {
    const e = exportRow(r), h = fingerprint(e);
    local.set(r.id, h);
    const there = remote.get(r.id);
    let ship = all;
    if (there === undefined) { fresh++; ship = true; }
    else if (there === h) same++;
    // Edited on crux since the last publish (crux no longer has what was published): held, whether or not it also
    // changed here, so a hand fix on crux is never overwritten without --overwrite-remote-edits.
    else if (last && last.has(r.id) && last.get(r.id) !== there && !overwrite) { ship = false; held.push(r.id); if (last.get(r.id) !== h) both.push(r.id); }
    else { changed++; ship = true; }
    if (ship) { fs.writeSync(rows, JSON.stringify(e) + '\n'); shipped.push(r.id); }
  }
  fs.closeSync(rows);
  writeManifest(path.join(outDir, 'local.tsv'), local);
  fs.writeFileSync(path.join(outDir, 'shipped.txt'), shipped.map((i) => i + '\n').join(''));
  fs.writeFileSync(path.join(outDir, 'held.txt'), held.map((i) => i + '\n').join(''));
  const remoteOnly = [...remote.keys()].filter((id) => !local.has(id)).length;
  console.log(`delta: ${local.size} local puzzles; crux has ${remote.size}. new ${fresh}, changed ${changed}, unchanged ${same}` +
    `${all ? ' (--all: shipping every row)' : ''}; shipping ${shipped.length}`);
  if (held.length) console.log(`delta: HELD ${held.length} rows that differ on crux but not here since the last publish (edited on crux?), e.g. ${held.slice(0, 5).join(' ')}; ` +
    `listed in ${path.join(outDir, 'held.txt')}. --overwrite-remote-edits ships them.`);
  if (both.length) console.log(`delta: of those, ${both.length} also changed here (a conflict: decide per row), e.g. ${both.slice(0, 5).join(' ')}`);
  if (!last) console.log(`delta: no record of the last publish${published ? ` (${published})` : ''}, so every row that differs counts as changed here`);
  if (remoteOnly) console.log(`delta: ${remoteOnly} puzzles exist only on crux (never deleted by a publish)`);
} else if (cmd === 'verify') {
  const [localFile, remoteFile, idsFile] = args;
  if (!localFile || !remoteFile || !idsFile) die('usage: verify <local.tsv> <remote manifest> <shipped.txt>');
  const local = readManifest(localFile), remote = readManifest(remoteFile);
  const ids = fs.readFileSync(idsFile, 'utf8').split('\n').filter(Boolean);
  const bad = ids.filter((id) => remote.get(id) !== local.get(id));
  console.log(`verify: ${ids.length - bad.length} of ${ids.length} shipped rows now match on crux`);
  if (bad.length) { console.log(`verify: MISMATCH ${bad.length}, e.g. ${bad.slice(0, 5).join(' ')} (a duplicate position the import skipped, or a grade override)`); process.exit(3); }
} else die('usage: puzzle-rows.mjs manifest|manifest-export|delta|verify …');
