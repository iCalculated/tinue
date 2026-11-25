#!/usr/bin/env node
// The flat-threat flag: puzzles.flat_threat, 'exact' | 'model' | NULL. A puzzle is flagged when its forced road win
// relies on a flat-win threat: at the komi hostile to the attacker (+100 or -100) no forced win of the same length
// exists, while at the game komi one does (scripts/flatwin-scan.mjs on branch flatwin-tool, field needsFlat).
//   exact  the hostile-komi "no" is proved exactly (wins of 5 plies or fewer: every defence searched)
//   model  the "no" is from the threat-only solver (exact within that model only)
// Stored only, read by nothing: no route, page, feed or build shows it (Sasha, 2026-11-23: show it, if ever, only after
// the attempt, and that is a later decision). scripts/test-flat-threat.mjs holds that: it boots the real server and
// the players page on a database with a flagged puzzle and checks every response, and builds the static site.
// Why a column and not a theme key: themes is what /api/themes counts, the puzzle JSON lists, History returns, the
// share and stub pages read, and scripts/import.mjs overwrites on every publish (themes=excluded.themes). A column of
// its own is read by none of them (every one selects or serializes named columns) and import.mjs's upsert names its
// columns, so a publish or a re-tag never touches it. needsFlat is the one signal stored; flatFaster is not.
//
//   node scripts/apply-flat-threat.mjs <results.jsonl> [--db <file>]                  dry run (the default): read-only
//   node scripts/apply-flat-threat.mjs <results.jsonl> --db <file> --apply --backup <new file>
//   node scripts/apply-flat-threat.mjs --clear --db <file> --backup <new file>          undo: every row back to NULL
// --db defaults to $TINUE_DB, else data/tinue.db. --apply and --clear make <backup> first (a consistent SQLite online
// backup, checked before anything is written) and refuse an existing file. --apply makes the column hold exactly the
// selection: flags the selected served rows, clears any other flagged row, all in one transaction; a second run
// changes nothing. It refuses unless 200 to 250 rows are selected and 200 to 250 would end up flagged.
// Selection, per id (the last line for an id wins, as the scan resumes by appending): needsFlat === true, not a gaelet
// puzzle, the hostile-komi check run (not skipped) with win === false and a game-komi win (baseline.win === true).
// A selected id that is missing from the database, not served (paused, rejected, reserve: puzzle-state.js), or
// whose size, plies or komi differ from the scan's (re-imported since) is skipped and reported, never flagged.
// Schema: the column is added by this script (ALTER TABLE ADD COLUMN, inside the write transaction). The server never
// reads it and runs the same with or without it: no restart, no deploy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as sqlite from 'node:sqlite';
import { statusOf } from '../server/puzzle-state.js';

export const COLUMN = 'flat_threat';
export const KINDS = ['exact', 'model'];
export const RANGE = [200, 250];
const COLUMN_SQL = `ALTER TABLE puzzles ADD COLUMN ${COLUMN} TEXT CHECK (${COLUMN} IN ('exact', 'model'))`;

// The results file as a Map id -> row, the last line per id winning. A line that isn't JSON or has no id stops the
// run (a cut-off file would otherwise flag a subset without anyone noticing).
export function readResults(file) {
  const m = new Map();
  let n = 0;
  for (const [i, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { throw new Error(`${file}:${i + 1}: not JSON`); }
    if (typeof r?.id !== 'string' || !r.id) throw new Error(`${file}:${i + 1}: no id`);
    m.set(r.id, r); n++;
  }
  return { rows: m, lines: n };
}

// The rows to flag, from the results alone: [{ id, kind, size, plies, komi }] sorted by id, and why others were left out.
export function select(rows) {
  const chosen = [], left = { gaelet: 0, skipped: 0, inconsistent: [] };
  for (const r of rows.values()) {
    if (r.needsFlat !== true) continue;
    if (r.gaelet !== false) { left.gaelet++; continue; }
    const h = r.hostile === 'high' || r.hostile === 'low' ? r[r.hostile] : null;
    const friendly = r.hostile === 'high' ? 'low' : 'high';
    // a skip of the friendly-side check doesn't touch needsFlat; any other skip does
    if (r.skipped && !(typeof r.skipped === 'string' && r.skipped.startsWith(friendly + ' '))) { left.skipped++; continue; }
    if (!h || h.win !== false || h.baseline?.win !== true) { left.inconsistent.push(r.id); continue; }
    chosen.push({ id: r.id, kind: h.exact === true ? 'exact' : 'model', size: r.size, plies: r.plies, komi: r.komi });
  }
  chosen.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { chosen, left };
}

export const hasColumn = (db) => db.prepare('PRAGMA table_info(puzzles)').all().some((c) => c.name === COLUMN);
// Idempotent; joins the caller's transaction (ALTER TABLE is transactional in SQLite).
export function addColumn(db) { if (hasColumn(db)) return false; db.exec(COLUMN_SQL); return true; }

// What --apply would do to db: { flag: [{id, kind}] (rows to set or change), same, unflag: [ids], skip: {missing, unserved, changed}, final }
export function plan(db, chosen) {
  const col = hasColumn(db);
  const get = db.prepare(`SELECT id, size, plies, komi, themes, turn, grade, status${col ? `, ${COLUMN}` : ''} FROM puzzles WHERE id = ?`);
  const flag = [], same = [], skip = { missing: [], unserved: [], changed: [] }, want = new Map();
  for (const c of chosen) {
    const p = get.get(c.id);
    if (!p) { skip.missing.push(c.id); continue; }
    if (statusOf(p) !== 'served') { skip.unserved.push(`${c.id} (${statusOf(p)})`); continue; }
    if (p.size !== c.size || p.plies !== c.plies || (p.komi || 0) !== (c.komi || 0) || (p.themes || '').split(',').includes('gaelet')) { skip.changed.push(c.id); continue; }
    want.set(c.id, c.kind);
    (col && p[COLUMN] === c.kind ? same : flag).push({ id: c.id, kind: c.kind });
  }
  const unflag = col ? db.prepare(`SELECT id FROM puzzles WHERE ${COLUMN} IS NOT NULL ORDER BY id`).all().map((r) => r.id).filter((id) => !want.has(id)) : [];
  return { column: col, flag, same, unflag, skip, final: want.size };
}

export const counts = (db) => hasColumn(db)
  ? Object.fromEntries(db.prepare(`SELECT ${COLUMN} k, COUNT(*) n FROM puzzles WHERE ${COLUMN} IS NOT NULL GROUP BY k ORDER BY k`).all().map((r) => [r.k, r.n]))
  : null;

// Writes the plan in one transaction: the column (if missing), the unflags, the flags. Returns the counts after.
export function write(db, p) {
  db.exec('BEGIN IMMEDIATE');
  try {
    addColumn(db);
    const clear = db.prepare(`UPDATE puzzles SET ${COLUMN} = NULL WHERE id = ?`), set = db.prepare(`UPDATE puzzles SET ${COLUMN} = ? WHERE id = ?`);
    for (const id of p.unflag) clear.run(id);
    for (const { id, kind } of p.flag) if (set.run(kind, id).changes !== 1) throw new Error(`no row ${id}`);
    const n = db.prepare(`SELECT COUNT(*) n FROM puzzles WHERE ${COLUMN} IS NOT NULL`).get().n;
    if (n !== p.final) throw new Error(`${n} rows flagged, expected ${p.final}`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return counts(db);
}
export function clearAll(db) {
  if (!hasColumn(db)) return 0;
  db.exec('BEGIN IMMEDIATE');
  try { const n = db.prepare(`UPDATE puzzles SET ${COLUMN} = NULL WHERE ${COLUMN} IS NOT NULL`).run().changes; db.exec('COMMIT'); return Number(n); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// A consistent copy of a live database (WAL and all): SQLite's online backup, else VACUUM INTO. Checked before return.
// Restoring it over the live file would also undo every result since; the undo is --clear, the backup is the safety net.
export async function backup(db, file) {
  if (fs.existsSync(file)) throw new Error(`backup ${file} exists; give a new file`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  // rate -1: every page in one step, under one read snapshot. The default (100 pages a step) restarts whenever another
  // connection commits between steps, so under the live server's steady writes it would not finish until they paused.
  if (typeof sqlite.backup === 'function') await sqlite.backup(db, file, { rate: -1 });
  else db.prepare('VACUUM INTO ?').run(file);
  // a standalone file, like publish-puzzles.sh's snapshots: out of WAL mode (it checkpoints first), no -wal/-shm left
  const b = new DatabaseSync(file);
  try {
    if (Object.values(b.prepare('PRAGMA journal_mode = DELETE').get())[0] !== 'delete') throw new Error(`backup ${file}: could not leave WAL mode`);
    const ok = b.prepare('PRAGMA quick_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error(`backup ${file} fails quick_check`);
    const n = b.prepare('SELECT COUNT(*) n FROM puzzles').get().n, m = db.prepare('SELECT COUNT(*) n FROM puzzles').get().n;
    if (n !== m) throw new Error(`backup ${file} has ${n} puzzles, the database ${m}`);
    return { file, puzzles: n, bytes: fs.statSync(file).size };
  } finally { b.close(); }
}

// [[key, count]] sorted by key; keys compare as [size, plies] arrays
const tally = (xs, f) => { const m = new Map(); for (const x of xs) { const k = JSON.stringify(f(x)); m.set(k, (m.get(k) || 0) + 1); }
  return [...m].map(([k, n]) => [JSON.parse(k), n]).sort(([a], [b]) => [].concat(a).reduce((d, v, i) => d || v - [].concat(b)[i], 0)); };
export function report(chosen) {
  const lines = [`selected ${chosen.length}: ` + KINDS.map((k) => `${k} ${chosen.filter((c) => c.kind === k).length}`).join(', ')];
  lines.push('by size: ' + tally(chosen, (c) => c.size).map(([k, n]) => `${k}x${k} ${n}`).join(', '));
  lines.push('by length (plies): ' + tally(chosen, (c) => c.plies).map(([k, n]) => `${k} ${n}`).join(', '));
  for (const k of KINDS) {
    const xs = chosen.filter((c) => c.kind === k);
    lines.push(`${k} by size/plies: ` + tally(xs, (c) => [c.size, c.plies]).map(([[s, p], n]) => `${s}x${s}/${p} ${n}`).join(', '));
  }
  for (const k of KINDS) lines.push(`ids ${k}: ` + chosen.filter((c) => c.kind === k).map((c) => c.id).join(' '));
  return lines.join('\n');
}

async function main(argv) {
  const args = [...argv];
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
  const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; if (v == null || v.startsWith('--')) die(`${n} needs a value`); args.splice(i, 2); return v; };
  const apply = flag('--apply'), clear = flag('--clear'); flag('--dry-run');
  const dbFile = opt('--db') || process.env.TINUE_DB || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tinue.db');
  const backupFile = opt('--backup');
  if (args.some((a) => a.startsWith('--'))) die(`unknown option ${args.find((a) => a.startsWith('--'))}`);
  if (apply && clear) die('--apply or --clear, not both');
  const self = `${process.execPath} --no-warnings scripts/apply-flat-threat.mjs`; // the node that ran this: a bare 'node' may not be on PATH
  if ((apply || clear) && !backupFile) die(`--${apply ? 'apply' : 'clear'} writes: give --backup <new file> (it makes the backup itself first)`);
  if ((apply || clear) && !fs.existsSync(dbFile)) die(`no database at ${dbFile}`);

  if (clear) {
    const db = new DatabaseSync(dbFile); db.exec('PRAGMA busy_timeout = 5000');
    const b = await backup(db, backupFile);
    console.log(`backup: ${b.file} (${b.puzzles} puzzles, ${b.bytes} bytes)`);
    const n = clearAll(db);
    console.log(`cleared ${COLUMN} on ${n} rows; now flagged: ${JSON.stringify(counts(db) ?? 'no column')}`);
    db.close();
    return;
  }

  const resultsFile = args[0] || die('usage: apply-flat-threat.mjs <results.jsonl> [--db f] [--apply --backup f] | --clear --db f --backup f');
  const { rows, lines } = readResults(resultsFile);
  const { chosen, left } = select(rows);
  console.log(`results: ${lines} lines, ${rows.size} ids; needsFlat left out: ${left.gaelet} gaelet, ${left.skipped} skipped, ${left.inconsistent.length} inconsistent${left.inconsistent.length ? ' (' + left.inconsistent.join(' ') + ')' : ''}`);
  console.log(report(chosen));
  const inRange = (n) => n >= RANGE[0] && n <= RANGE[1];

  if (!fs.existsSync(dbFile)) {
    if (apply) die(`no database at ${dbFile}`);
    console.log(`dry run: no database at ${dbFile}, so nothing compared`);
    return;
  }
  const db = new DatabaseSync(dbFile, { readOnly: !apply });
  db.exec('PRAGMA busy_timeout = 5000');
  const p = plan(db, chosen);
  const sk = p.skip;
  console.log(`database ${dbFile}: column ${p.column ? 'present' : 'absent (--apply adds it)'}; flagged now: ${JSON.stringify(counts(db) ?? {})}`);
  console.log(`plan: flag ${p.flag.length} (${KINDS.map((k) => `${k} ${p.flag.filter((f) => f.kind === k).length}`).join(', ')}), already right ${p.same.length}, unflag ${p.unflag.length}` +
    `${p.unflag.length ? ' (' + p.unflag.join(' ') + ')' : ''}; skipped: missing ${sk.missing.length}, not served ${sk.unserved.length}, changed since the scan ${sk.changed.length}; flagged after: ${p.final}`);
  for (const [k, v] of Object.entries(sk)) if (v.length) console.log(`  skipped ${k}: ${v.join(' ')}`);
  const refuse = [!inRange(chosen.length) && `${chosen.length} rows selected`, !inRange(p.final) && `${p.final} rows would be flagged`].filter(Boolean);
  if (!apply && refuse.length) console.log(`dry run: --apply would refuse: ${refuse.join(', ')}, outside ${RANGE[0]}..${RANGE[1]}`);
  if (!apply) { console.log(`dry run: nothing written. To write: ${self} ${resultsFile} --db ${dbFile} --apply --backup <new file>`); db.close(); return; }

  if (!inRange(chosen.length)) die(`refusing: ${chosen.length} rows selected, outside ${RANGE[0]}..${RANGE[1]} (a different results file?)`, 3);
  if (!inRange(p.final)) die(`refusing: ${p.final} rows would be flagged, outside ${RANGE[0]}..${RANGE[1]} (a different database?)`, 3);
  const before = counts(db);
  const b = await backup(db, backupFile);
  console.log(`backup: ${b.file} (${b.puzzles} puzzles, ${b.bytes} bytes)`);
  const after = write(db, p);
  console.log(`applied: ${JSON.stringify(after)} (${p.flag.length} written, ${p.unflag.length} cleared)`);
  console.log(before && Object.keys(before).length
    ? `undo: the column held ${JSON.stringify(before)} before; put those back from the backup: sqlite3 ${dbFile} "ATTACH '${b.file}' AS b; UPDATE puzzles SET ${COLUMN} = (SELECT o.${COLUMN} FROM b.puzzles o WHERE o.id = puzzles.id)"; or clear all: ${self} --clear --db ${dbFile} --backup ${b.file}.pre-clear`
    : `undo: ${self} --clear --db ${dbFile} --backup ${b.file}.pre-clear`);
  db.close();
}

function die(msg, code = 2) { console.error('apply-flat-threat: ' + msg); process.exit(code); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
