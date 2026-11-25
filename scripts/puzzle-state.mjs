#!/usr/bin/env node
// Recompute the puzzle state columns (kind, status, pre0, miner; server/puzzle-state.js) on every row, writing only rows
// whose value differs, in transactions of 2,000 rows (~40 ms each) with 25 ms between them. The server waits up to 5 s
// on a busy lock (server.js BUSY_MS), so a result posted while a chunk holds it waits that chunk out rather than failing.
// Smaller chunks shorten each wait but lengthen the total (500 rows: ~1.8 s). A re-run writes nothing. Run it after
// the first deploy of new state rules (the server only adds the columns), and after any hand edit of turn/grade/swing
// on crux; scripts/import.mjs does the same right after every import commits, so a publish keeps them right. Measured
// on lyra on a copy of the build DB (71,112 rows): first run ~2.8 s wall, 36 transactions, ~1.4 s holding the lock
// (longest ~58 ms); re-run ~0.3 s, nothing written. The picker and the daily read status/kind (PLAN P2).
// Q11 (grade D -> 'rejected', or 'paused' when held): the first run after that deploy moves every D row; the server
// already treats D as rejected before it does (server/puzzle-state.js statusOf), so it can run whenever convenient.
// It waits up to 10 s for a lock itself.
// usage: node --no-warnings scripts/puzzle-state.mjs [db] [--check | --dry-run] [--overrides f]
//   db           default $TINUE_DB or data/tinue.db
//   --check      write nothing; print how many rows differ and exit 1 if any do
//   --dry-run    write nothing (read-only); print every old status -> new status with its count, and how many rows
//                a run would write (exit 0)
//   --overrides  the hand-grade file whose hold-YYYYMMDD rows are 'paused' (default scripts/grade-overrides.jsonl)
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { addPuzzleState, backfillPuzzleState, derive, heldIds, OVERRIDES } from '../server/puzzle-state.js';

const argv = process.argv.slice(2);
const check = argv.includes('--check'), dry = argv.includes('--dry-run');
const oi = argv.indexOf('--overrides');
const overrides = oi >= 0 ? argv.splice(oi, 2)[1] : OVERRIDES;
const unknown = argv.filter((a) => a.startsWith('--') && a !== '--check' && a !== '--dry-run');
if (unknown.length) { console.error(`puzzle-state: unknown option ${unknown.join(' ')}`); process.exit(2); } // (a mistyped --dry-run must not write)
const file = argv.filter((a) => !a.startsWith('--'))[0] || process.env.TINUE_DB || 'data/tinue.db';
if (!fs.existsSync(file)) { console.error(`puzzle-state: no database at ${file}`); process.exit(2); }
if (oi >= 0 && !fs.existsSync(overrides)) { console.error(`puzzle-state: no overrides file ${overrides}`); process.exit(2); }
const held = heldIds(overrides);

// timeout: wait for a writer (the server, an import) instead of failing at once
const db = new DatabaseSync(file, { timeout: 10e3, readOnly: check || dry });
if (dry) {
  const cols = new Set(db.prepare('PRAGMA table_info(puzzles)').all().map((c) => c.name));
  const has = cols.has('status');
  const moves = new Map();
  let rows = 0, write = 0;
  for (const r of db.prepare(`SELECT id, turn, grade, swing, ${has ? 'kind, status, pre0, miner' : 'NULL kind, NULL status, NULL pre0, NULL miner'} FROM puzzles`).iterate()) {
    rows++; const d = derive(r, held);
    if (d.kind !== r.kind || d.status !== r.status || d.pre0 !== r.pre0 || d.miner !== r.miner) write++;
    const k = `${r.status ?? 'NULL'} -> ${d.status}`;
    moves.set(k, (moves.get(k) || 0) + 1);
  }
  console.log(`puzzle-state --dry-run: ${rows} rows, ${write} would be written${has ? '' : ' (the columns are not there yet)'} (${held.size} held ids)`);
  for (const [k, n] of [...moves].sort()) console.log(`  ${k}${k.split(' -> ')[0] === k.split(' -> ')[1] ? '' : ' *'}  ${n}`);
  process.exit(0);
}
if (check) {
  const cols = new Set(db.prepare('PRAGMA table_info(puzzles)').all().map((c) => c.name));
  if (!cols.has('status')) { console.log('puzzle-state: the columns are not there yet (the server adds them at startup)'); process.exit(1); }
  let rows = 0, diff = 0;
  for (const r of db.prepare('SELECT id, turn, grade, swing, kind, status, pre0, miner FROM puzzles').iterate()) {
    rows++; const d = derive(r, held);
    if (d.kind !== r.kind || d.status !== r.status || d.pre0 !== r.pre0 || d.miner !== r.miner) diff++;
  }
  console.log(`puzzle-state: ${rows} rows, ${diff} differ from what they should be`);
  process.exit(diff ? 1 : 0);
}
const added = addPuzzleState(db);
const r = backfillPuzzleState(db, { held });
console.log(`puzzle-state: ${added ? `added ${added} columns; ` : ''}${r.rows} rows, ${r.changed} updated in ${r.ms} ms (${held.size} held ids)`);
console.log(db.prepare('SELECT status, kind, COUNT(*) n FROM puzzles GROUP BY status, kind ORDER BY status, kind').all().map((x) => `${x.status}/${x.kind} ${x.n}`).join(', '));
