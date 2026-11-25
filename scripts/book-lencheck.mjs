// B3 (docs/plan/PLAN.md): deep's exact threat-only length (`deep up`) against stored `plies` on a sample of pd 6x6
// rows. Every mismatch is a finding to report; nothing is changed (the database is opened read-only).
//   node --no-warnings scripts/book-lencheck.mjs <db> [--n 200] [--seed 1] [--ids id,id,...] [--nodes 4000000]
//        [--deep deep/target/release/deep]
// The sample: pd rows of size 6 ordered by a seeded hash of the id (deterministic for a given seed and table).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { halfKomi, treeDepth } from '../shared/book.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const n = +flag('--n', 200), seed = +flag('--seed', 1), nodes = +flag('--nodes', 4e6), ids = flag('--ids', '');
const DEEP = flag('--deep', path.join(ROOT, 'deep/target/release/deep'));
if (!args[0]) { console.error('usage: book-lencheck.mjs <db> [--n 200] [--seed 1] [--ids ...]'); process.exit(2); }
const db = new DatabaseSync(args[0], { readOnly: true });
const hash = (s) => { let h = 0x811c9dc5 ^ seed; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
let rows = db.prepare("SELECT id, tps, komi, plies, tree, turn, grade FROM puzzles WHERE size = 6 AND id LIKE 'pd%'").all();
const total = rows.length;
if (ids) { const want = new Set(ids.split(',')); rows = rows.filter((r) => want.has(r.id)); }
else rows = rows.sort((a, b) => hash(a.id) - hash(b.id) || (a.id < b.id ? -1 : 1)).slice(0, n);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'book-lencheck-'));
const f = path.join(tmp, 'in.txt');
fs.writeFileSync(f, rows.map((r) => `${r.tps}|${halfKomi(r.komi)}`).join('\n') + '\n');
const t0 = Date.now();
const r = spawnSync(DEEP, ['up', f, '0', '1', String(nodes)], { encoding: 'utf8', maxBuffer: 1 << 28 });
fs.rmSync(tmp, { recursive: true, force: true });
if (r.status !== 0 && r.status !== 1) { console.error(r.stderr); process.exit(2); }
const out = new Map(r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')).map((x) => [+x[0], x]));
const bad = [];
rows.forEach((row, i) => {
  const x = out.get(i), len = x?.[1];
  if (String(row.plies) !== len) bad.push({ id: row.id, plies: row.plies, deep: len ?? 'none', check: x?.[4], treeDepth: treeDepth(JSON.parse(row.tree)), served: row.turn === 1 || row.grade === 'A' }); // (book-init's set, a superset of the served pool)
});
console.log(`book-lencheck: ${rows.length} of ${total} pd 6x6 rows (seed ${seed}), deep up ${nodes} nodes: ${rows.length - bad.length}/${rows.length} match plies, ${Date.now() - t0} ms`);
for (const b of bad) console.log('MISMATCH', b.id, 'stored plies', b.plies, 'deep', b.deep, 'checker', b.check, 'tree depth', b.treeDepth, b.served ? 'served' : 'not served');
process.exit(bad.length ? 1 : 0);
