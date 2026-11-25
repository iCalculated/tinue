// Stage 0 on stored rows: pick 6x6 pd/ps rows with plies >= MIN, measure the exact threat-only length
// with `deep up`, keep rows whose exact length is >= MIN. Read-only on the DB.
//   node --no-warnings deep/mine/stage0.mjs --db=~/Projects/tinue/data/tinue.db --out=DIR [--n=300] [--min=11] [--seed=1] [--procs=6]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { arg, runDeepSharded, writeJsonl } from './lib.mjs';

const DB = arg('db'), OUT = arg('out'), N = +arg('n', 300), MIN = +arg('min', 11), SEED = +arg('seed', 1), PROCS = +arg('procs', 6), LP = arg('lp', '22');
fs.mkdirSync(OUT, { recursive: true });
const db = new DatabaseSync(DB, { readOnly: true });
const all = db.prepare(`SELECT id, tps, plies, komi, tree, meta, source, source_ref FROM puzzles
  WHERE size = 6 AND plies >= ? AND (id LIKE 'pd%' OR id LIKE 'ps%') ORDER BY id`).all(MIN);
// deterministic shuffle (mulberry32)
let s = SEED >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
const pick = N > 0 ? all.slice(0, N) : all;
writeJsonl(path.join(OUT, 'rows.jsonl'), pick.map((r) => ({ ...r, meta: JSON.parse(r.meta || '{}'), tree: JSON.parse(r.tree) })));
const inFile = path.join(OUT, 'stage0.in');
fs.writeFileSync(inFile, pick.map((r) => `${r.tps}|${Math.round(r.komi * 2)}|${r.id}`).join('\n') + '\n');
const t0 = Date.now();
const { text, cpu } = await runDeepSharded('up', inFile, PROCS, ['3000000', `lp=${LP}`], path.join(OUT, 'stage0.up.tsv'));
const byRow = new Map(text.trim().split('\n').map((l) => l.split('\t')).map((f) => [+f[0], f]));
const res = pick.map((r, i) => {
  const f = byRow.get(i) || [];
  const exact = /^\d+$/.test(f[1] || '') ? +f[1] : null;
  return { id: r.id, plies: r.plies, exact, nodes: +f[2] || 0, ms: +f[3] || 0, key: f[5] || null, check: f[4] || null, match: exact === r.plies, keep: exact != null && exact >= MIN };
});
writeJsonl(path.join(OUT, 'stage0.jsonl'), res);
const mism = res.filter((r) => !r.match);
const summary = { stage: '0', rows: res.length, kept: res.filter((r) => r.keep).length, mismatches: mism.map((r) => `${r.id} stored ${r.plies} exact ${r.exact}`), cpuSec: +cpu.toFixed(1), wallSec: (Date.now() - t0) / 1000, available: all.length };
fs.writeFileSync(path.join(OUT, 'stage0.summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
