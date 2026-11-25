// Stages A (threat uniqueness) and B (quiet uniqueness) with `deep cert`, per MINING.md.
//   node --no-warnings deep/mine/stageAB.mjs --stage=A|B --out=DIR [--procs=6] [--lp=22]
// A reads DIR/stage0.jsonl + rows.jsonl; B reads DIR/stageA.jsonl. Writes DIR/stage<X>.jsonl (deep's
// JSON per row plus tier/pass) and DIR/stage<X>.summary.json with CPU seconds.
//   A: deep cert 60000 lite=1 strict=1 tl=30; timeouts with L >= 15 retried once at tl=300.
//      pass: cutR = 0 (gold track) or L >= 15 and L - cutR >= 8 (silver track).
//   B: deep cert 150000 q=1 b2=20000 strict=1 tl=600, A's line as the hint.
//      pass: same rule; a timeout goes on to C with its undecided moves (C triages them).
import fs from 'node:fs';
import path from 'node:path';
import { arg, readJsonl, writeJsonl, runDeepSharded } from './lib.mjs';

const STAGE = arg('stage'), OUT = arg('out'), PROCS = +arg('procs', 6), LP = arg('lp', '22');
const rows = new Map(readJsonl(path.join(OUT, 'rows.jsonl')).map((r) => [r.id, r]));
const tierOf = (c) => (c.status === 'ok' || c.status === 'timeout') && c.L ? (c.cutR === 0 ? 'gold' : c.L >= 15 && c.L - c.cutR >= 8 ? 'silver' : null) : null;

async function run(items, extra, tag) {
  if (!items.length) return { res: [], cpu: 0 };
  const inFile = path.join(OUT, `stage${STAGE}${tag}.in`);
  fs.writeFileSync(inFile, items.map((x) => `${x.tps}|${x.hk}|${x.id}|${x.hint || ''}|${x.L}`).join('\n') + '\n');
  const { text, cpu } = await runDeepSharded('cert', inFile, Math.min(PROCS, items.length), extra, path.join(OUT, `stage${STAGE}${tag}.raw.jsonl`));
  return { res: text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), cpu };
}

const t0 = Date.now();
let items, out = [], cpu = 0, retried = 0;
if (STAGE === 'A') {
  items = readJsonl(path.join(OUT, 'stage0.jsonl')).filter((r) => r.keep).map((r) => { const p = rows.get(r.id); return { id: r.id, tps: p.tps, hk: Math.round(p.komi * 2), L: r.exact, hint: (p.meta.gameLine || [])[0] || '' }; });
  const a = await run(items, ['60000', 'lite=1', 'strict=1', 'tl=30', `lp=${LP}`], '');
  cpu += a.cpu;
  const retry = a.res.filter((c) => c.status === 'timeout' && c.L >= 15);
  retried = retry.length;
  const b = await run(retry.map((c) => items.find((x) => x.id === c.id)), ['60000', 'lite=1', 'strict=1', 'tl=300', `lp=${LP}`], '.retry');
  cpu += b.cpu;
  const re = new Map(b.res.map((c) => [c.id, c]));
  out = a.res.map((c) => re.get(c.id) || c);
} else if (STAGE === 'B') {
  const prev = readJsonl(path.join(OUT, 'stageA.jsonl')).filter((c) => c.pass);
  items = prev.map((c) => ({ id: c.id, tps: c.tps, hk: c.halfkomi, L: c.L, hint: [...new Set([...(c.line || []), (rows.get(c.id)?.meta.gameLine || [])[0]].filter(Boolean))].join(' ') }));
  const a = await run(items, ['150000', 'q=1', 'b2=20000', 'strict=1', 'tl=600', `lp=${LP}`], '');
  cpu += a.cpu; out = a.res;
} else throw new Error('--stage=A|B');

for (const c of out) { c.tier = tierOf(c); c.pass = !!c.tier && (c.status === 'ok' || STAGE === 'B'); c.stage = STAGE; }
writeJsonl(path.join(OUT, `stage${STAGE}.jsonl`), out);
const cnt = (f) => out.filter(f).length;
const summary = {
  stage: STAGE, in: items.length, out: cnt((c) => c.pass), gold: cnt((c) => c.pass && c.tier === 'gold'), silver: cnt((c) => c.pass && c.tier === 'silver'),
  cooked: cnt((c) => c.status === 'ok' && !c.tier), timeout: cnt((c) => c.status === 'timeout'), timeoutPassed: cnt((c) => c.status === 'timeout' && c.pass), retried,
  byL: Object.fromEntries([11, 13, 15, 17, 19, 21].map((L) => [L, `${cnt((c) => c.L === L && c.pass)}/${cnt((c) => c.L === L)}`])),
  cpuSec: +cpu.toFixed(1), wallSec: (Date.now() - t0) / 1000,
};
fs.writeFileSync(path.join(OUT, `stage${STAGE}.summary.json`), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
