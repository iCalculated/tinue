// Live numbers for the docs: what a puzzle database holds, instead of counts written into prose that go stale.
// Read-only. usage: node --no-warnings scripts/data-stats.mjs [db (default data/tinue.db)] [--raw data/raw/games_anon.db]
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { STATUS_SQL } from '../server/puzzle-state.js';

const argv = process.argv.slice(2), ri = argv.indexOf('--raw');
const RAW = ri >= 0 ? argv.splice(ri, 2)[1] : null;
const DB = argv[0] || 'data/tinue.db';
if (!fs.existsSync(DB)) { console.error(`no such database: ${DB}`); process.exit(2); }
const db = new DatabaseSync(DB, { readOnly: true });
const all = (sql) => db.prepare(sql).all();
const one = (sql) => Object.values(db.prepare(sql).get())[0];
const n = (x) => Number(x ?? 0).toLocaleString('en-US');
const SERVED = `((${STATUS_SQL}) = 'served')`; // the served pool, as the server picks from it (server/puzzle-state.js)

console.log(`${DB}`);
console.log(`puzzles: ${n(one('SELECT COUNT(*) FROM puzzles'))}, served pool ${n(one(`SELECT COUNT(*) FROM puzzles WHERE ${SERVED}`))}`);

// id prefixes name the miner: p = mine-playtak, pd = mine-deep, ps = mine-swing, …
const bySrc = {};
for (const r of all(`SELECT id, ${SERVED} AS s FROM puzzles`)) {
  const k = r.id.match(/^[a-z]+/)?.[0] || '?';
  (bySrc[k] ||= [0, 0])[0]++; if (r.s) bySrc[k][1]++;
}
console.log('by id prefix (all / served):', Object.entries(bySrc).sort().map(([k, [a, s]]) => `${k} ${n(a)}/${n(s)}`).join(', '));

const sizes = all('SELECT DISTINCT size FROM puzzles ORDER BY size').map((r) => r.size);
const bucket = (p) => (p <= 5 ? String(p) : '7+');
const cells = {};
for (const r of all(`SELECT size, plies, COUNT(*) c FROM puzzles GROUP BY size, plies`)) {
  const k = `${r.size}|${bucket(r.plies)}`; cells[k] = (cells[k] || 0) + r.c;
}
const cols = ['1', '3', '5', '7+'];
console.log(`\n| plies | ${sizes.map((s) => `${s}×${s}`).join(' | ')} |\n|---|${sizes.map(() => '---').join('|')}|`);
for (const c of cols) console.log(`| ${c} | ${sizes.map((s) => n(cells[`${s}|${c}`])).join(' | ')} |`);

console.log('\nturn (1 = turning point, 0 = conversion, null = unscored):', all('SELECT turn, COUNT(*) c FROM puzzles GROUP BY turn ORDER BY turn').map((r) => `${r.turn}: ${n(r.c)}`).join(', '));
console.log('conversion grades:', all('SELECT grade, COUNT(*) c FROM puzzles WHERE turn = 0 GROUP BY grade ORDER BY grade').map((r) => `${r.grade}: ${n(r.c)}`).join(', '));
console.log('flaw (1 = stored alternatives, 2 = refund mark):', all('SELECT flaw, COUNT(*) c FROM puzzles GROUP BY flaw ORDER BY flaw').map((r) => `${r.flaw}: ${n(r.c)}`).join(', '));

const att = db.prepare('SELECT COUNT(*) c, SUM(rated) r, COUNT(DISTINCT user_id) u, MIN(ts) a, MAX(ts) b FROM attempts').get();
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '-');
console.log(`\nattempts: ${n(att.c)} (${n(att.r)} rated) by ${n(att.u)} players, ${day(att.a)} to ${day(att.b)}`);
console.log(`named players: ${n(one("SELECT COUNT(*) FROM users WHERE name IS NOT NULL AND name <> ''"))}`);

if (RAW) {
  const raw = new DatabaseSync(RAW, { readOnly: true });
  const g = raw.prepare('SELECT COUNT(*) c, MAX(date) d FROM games').get();
  console.log(`\n${RAW}: ${n(g.c)} games, newest ${day(g.d)}`);
}
