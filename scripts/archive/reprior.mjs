// Recompute mined puzzles' prior ratings from their stored factors (meta.factors) under the current clamp, without
// re-mining. Rewrites the file in place unless an output path is given. Only touches the prior: import.mjs still keeps
// earned ratings for puzzles that have been played.
// usage: node scripts/archive/reprior.mjs data/puzzles/deep-playtak.jsonl [out.jsonl]
import fs from 'node:fs';
import { PRIOR_MIN, PRIOR_MAX } from '../../shared/analyze.js';
const [inp, out = inp] = process.argv.slice(2);
let changed = 0, n = 0, missing = 0;
const lines = fs.readFileSync(inp, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
  const p = JSON.parse(l); n++;
  const f = p.meta?.factors;
  if (!f) { missing++; return l; }
  const r = Math.round(Math.max(PRIOR_MIN, Math.min(PRIOR_MAX, Object.values(f).reduce((a, b) => a + b, 0))));
  if (r !== p.rating) { changed++; p.rating = r; }
  return JSON.stringify(p);
});
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`${n} puzzles, ${changed} priors changed, ${missing} without factors (left as is) → ${out}`);
