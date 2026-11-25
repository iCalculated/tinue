// Compare our difficulty prior with the Ditaktic author's labels.
// usage: node --no-warnings scripts/calibrate-ditaktic.mjs [data/puzzles-local/ditaktic.jsonl] [--json]
import fs from 'node:fs';

const file = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'data/puzzles-local/ditaktic.jsonl';
const unFile = file.replace(/\.jsonl$/, '-unsolved.jsonl');
const LABELS = ['Trivial', 'Beginner', 'Easy', 'Medium', 'Hard', 'Impossible'];
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ps = read(file).filter((p) => LABELS.includes(p.meta?.difficulty));
const un = read(unFile);

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const ranks = (a) => { // average ranks for ties
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(a.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
};
const pearson = (x, y) => { const mx = mean(x), my = mean(y); let n = 0, dx = 0, dy = 0; for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; } return n / Math.sqrt(dx * dy); };
const spearman = (x, y) => pearson(ranks(x), ranks(y));

const rows = [];
for (const lab of LABELS) {
  const g = ps.filter((p) => p.meta.difficulty === lab);
  const u = un.filter((p) => p.difficulty === lab && !/avoidance|best-move|mistakes|variant|no TPS|unrecognized/.test(p.reason));
  if (!g.length && !u.length) continue;
  const r = g.map((p) => p.rating);
  rows.push({ label: lab, n: g.length, unsolved: u.length, meanRating: g.length ? Math.round(mean(r)) : null, medianRating: g.length ? median(r) : null,
    meanPlies: g.length ? +mean(g.map((p) => p.plies)).toFixed(2) : null, meanAuthorPlies: g.length ? +mean(g.map((p) => p.meta.authorPlies || 0)).toFixed(2) : null,
    pliesDist: Object.fromEntries(Object.entries(g.reduce((m, p) => ((m[p.plies] = (m[p.plies] || 0) + 1), m), {})).sort()) });
}
const lr = ps.map((p) => LABELS.indexOf(p.meta.difficulty));
const out = {
  solved: ps.length, unsolvedForcedWin: un.filter((p) => !/avoidance|best-move|mistakes|variant|no TPS|unrecognized/.test(p.reason)).length,
  skippedNonForcedWin: un.filter((p) => /avoidance|best-move|mistakes|variant|no TPS|unrecognized/.test(p.reason)).length,
  rows,
  spearman_label_vs_rating: +spearman(lr, ps.map((p) => p.rating)).toFixed(3),
  spearman_label_vs_plies: +spearman(lr, ps.map((p) => p.plies)).toFixed(3),
  spearman_label_vs_rating_within_plies: Object.fromEntries([1, 3, 5, 7].map((pl) => { const s = ps.filter((p) => p.plies === pl); return [pl, s.length > 5 ? { n: s.length, rho: +spearman(s.map((p) => LABELS.indexOf(p.meta.difficulty)), s.map((p) => p.rating)).toFixed(3) } : null]; })),
  authorFirstMoveAccepted: `${ps.filter((p) => p.meta.authorFirstAccepted).length}/${ps.filter((p) => p.meta.authorFirstAccepted != null).length}`,
  shorterThanAuthor: ps.filter((p) => p.meta.authorPlies && p.plies < p.meta.authorPlies).length,
  unsolvedReasons: un.reduce((m, p) => { const k = p.reason.replace(/:.*/, ''); m[k] = (m[k] || 0) + 1; return m; }, {}),
};
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`solved ${out.solved}, unsolved forced-win ${out.unsolvedForcedWin}, skipped ${out.skippedNonForcedWin}`);
  console.log('label        n  unsolved  meanR  medR  meanPlies  authorPlies  plies');
  for (const r of rows) console.log(`${r.label.padEnd(11)}${String(r.n).padStart(4)}${String(r.unsolved).padStart(9)}${String(r.meanRating).padStart(7)}${String(r.medianRating).padStart(7)}${String(r.meanPlies).padStart(10)}${String(r.meanAuthorPlies).padStart(12)}  ${JSON.stringify(r.pliesDist)}`);
  const { rows: _, ...rest } = out; console.log(JSON.stringify(rest, null, 1));
}
