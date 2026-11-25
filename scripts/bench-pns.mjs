// Benchmark the Tak-threat df-pn prover (shared/pns.js) against the brute-force Solver (shared/tak.js).
//
//   node --no-warnings scripts/bench-pns.mjs --sample <puzzles.jsonl> [--nodes 30000] [--json out.json]
//
// exegames sample puzzles (PTN games replayed to the puzzle position): brute-force mate distance
// (≤5 plies) vs threat-restricted shortest tinue — agreement + timing.
// Third-party inputs are read as data only.
import fs from 'node:fs';
import { replay } from '../shared/ptn.js';
import { mateIn } from '../shared/analyze.js';
import { shortestTinue, proveTinue } from '../shared/pns.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const NODES = +(args.nodes || 30000);
const SAMPLE = args.sample;
if (typeof SAMPLE !== 'string') { console.error('usage: bench-pns.mjs --sample <puzzles.jsonl> [--nodes N] [--json out.json]'); process.exit(2); }
const out = { a: [] };

// CPU ms (user+sys) — wall time is unreliable when the machine is loaded
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const pad = (s, n) => String(s).padEnd(n);
const timed = (f) => { const t = cpu(); const r = f(); return [r, Math.round(cpu() - t)]; };

{
  console.log(`\n## (a) exegames sample — brute force (≤5 plies, 4e7 nodes) vs threat df-pn (shortestTinue ≤9 / proveTinue, ${NODES} nodes); times are CPU ms\n`);
  console.log('| # (puzzleId) | size | brute plies | brute ms | pns plies | pns nodes | pns ms | prove plies | prove ms | note |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  const rows = fs.readFileSync(SAMPLE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const [i, p] of rows.entries()) {
    const { g } = replay(p.puzzleNotation);
    const [bf, bms] = timed(() => mateIn(g.clone(), 5, 4e7));
    const [st, sms] = timed(() => shortestTinue(g, 9, { maxNodes: NODES }));
    const [pr, pms] = timed(() => proveTinue(g, { maxNodes: NODES }));
    const bp = bf.plies < 0 ? '?' : bf.plies || '–';
    const sp = st.result === 'proved' ? st.plies + (st.exact ? '' : '≤') : st.result === 'unknown' ? '?' : '–';
    let note = '';
    if (bf.plies > 0 && st.result === 'proved' && st.plies !== bf.plies) note = st.plies > bf.plies ? 'pns longer (quiet/flat win missed)' : 'pns shorter??';
    else if (bf.plies > 0 && st.result !== 'proved') note = 'pns misses (needs quiet move / flat win)';
    else if (bf.plies === 0 && st.result === 'proved') note = st.plies > 5 ? 'deeper than 5' : 'pns only??';
    console.log(`| ${i + 1} (${p.puzzleId}) | ${p.puzzleSize} | ${bp} | ${bms} | ${sp} | ${st.nodes} | ${sms} | ${pr.result === 'proved' ? pr.plies : pr.result} | ${pms} | ${note} |`);
    out.a.push({ id: p.puzzleId, size: p.puzzleSize, tps: g.toTPS(), brute: bf.plies, bruteMs: bms, bruteNodes: bf.nodes, pns: st, pnsMs: sms, prove: pr, proveMs: pms, note });
  }
  const A = out.a;
  const both = A.filter((r) => r.brute > 0);
  const agree = both.filter((r) => r.pns.result === 'proved' && r.pns.plies === r.brute).length;
  const longer = both.filter((r) => r.pns.result === 'proved' && r.pns.plies > r.brute).length;
  const missed = both.filter((r) => r.pns.result !== 'proved').length;
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  console.log(`\nbrute-force wins ≤5: ${both.length}/${A.length}; pns same depth ${agree}, pns longer ${longer}, pns missed ${missed}; ` +
    `median ms brute ${med(A.map((r) => r.bruteMs))} vs pns ${med(A.map((r) => r.pnsMs))}; ` +
    `total ms brute ${A.reduce((s, r) => s + r.bruteMs, 0)} vs pns ${A.reduce((s, r) => s + r.pnsMs, 0)}`);
}

if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 1));
