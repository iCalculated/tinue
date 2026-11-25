#!/usr/bin/env node
// One-off (2026-11-15, Shy's call): existing accounts move to the new volatility 0.06, and each keeps the larger of
// its current deviation and the one it would have from replaying its rated attempts under the new start
// (1500 ± 500, vol 0.06). Ratings are untouched; nobody's deviation goes down.
// The replay uses each attempt's stored puzzle rating and the puzzle's current deviation, at full weight.
//   node scripts/migrate-vol-2026-11-15.mjs [--apply]     (default: dry run, prints the table)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { rate, PLAYER_START } from '../../shared/rating.js';

const DB = process.env.TINUE_DB || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'tinue.db');
const apply = process.argv.includes('--apply');
const db = new DatabaseSync(DB);
const users = db.prepare('SELECT id, name, rating, rd, vol, games FROM users').all();
const atts = db.prepare(`SELECT a.user_id u, a.win w, a.puzzle_rating pr, p.rd prd FROM attempts a
  LEFT JOIN puzzles p ON p.id = a.puzzle_id WHERE a.rated = 1 ORDER BY a.ts`).all();
const rows = [];
for (const u of users) {
  let r = { ...PLAYER_START }, n = 0;
  for (const a of atts) if (a.u === u.id) { r = rate(r, { rating: a.pr ?? 1500, rd: a.prd ?? 250, vol: 0.09 }, !!a.w).user; n++; }
  const rd = Math.max(u.rd, n ? r.rd : PLAYER_START.rd);
  rows.push({ id: u.id, name: u.name, n, rating: Math.round(u.rating), rdNow: +u.rd.toFixed(1), rdReplay: +r.rd.toFixed(1), rdNew: +rd.toFixed(1), volNow: u.vol, volNew: PLAYER_START.vol });
}
console.table(rows);
if (apply) {
  const set = db.prepare('UPDATE users SET rd = ?, vol = ? WHERE id = ?');
  db.exec('BEGIN');
  try { for (const r of rows) set.run(r.rdNew, r.volNew, r.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  console.log(`updated ${rows.length} users`);
} else console.log('dry run: pass --apply to write');
