// Numbers for the pilot report: funnel, CPU per stage, cooks found only at C or E, boards and lines.
//   node --no-warnings deep/mine/report.mjs --out=DIR > numbers.md
import fs from 'node:fs';
import path from 'node:path';
import { arg, readJsonl } from './lib.mjs';

const OUT = arg('out');
const J = (f) => (fs.existsSync(path.join(OUT, f)) ? JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) : null);
const s0 = J('stage0.summary.json'), sA = J('stageA.summary.json'), sB = J('stageB.summary.json'), cal = J('calib.summary.json'), sC = J('stageC.summary.json'), sE = J('stageE.summary.json');
const B = readJsonl(path.join(OUT, 'stageB.jsonl')), C = readJsonl(path.join(OUT, 'stageC.jsonl')), E = readJsonl(path.join(OUT, 'stageE.jsonl'));
const cand = readJsonl(path.join(OUT, 'candidates.jsonl'));
const p = (...a) => console.log(...a);
p('## funnel\n');
p('| stage | in | out | notes | CPU s |');
p('|---|---|---|---|---|');
p(`| 0 stored rows | ${s0?.rows} | ${s0?.kept} | mismatches: ${s0?.mismatches.join('; ') || 'none'} | ${s0?.cpuSec} |`);
p(`| A threat uniqueness | ${sA?.in} | ${sA?.out} | gold track ${sA?.gold}, silver track ${sA?.silver}, cooked ${sA?.cooked}, timeouts ${sA?.timeout}; by L ${JSON.stringify(sA?.byL)} | ${sA?.cpuSec} |`);
p(`| B quiet uniqueness | ${sB?.in} | ${sB?.out} | gold ${sB?.gold}, silver ${sB?.silver}, cooked ${sB?.cooked}, timeouts ${sB?.timeout} (passed on ${sB?.timeoutPassed}); by L ${JSON.stringify(sB?.byL)} | ${sB?.cpuSec} |`);
if (cal) p(`| C calibration | ${cal.sampled} cooked nodes | | cook p min ${cal.cookP.min}, p05 ${cal.cookP.p05}, median ${cal.cookP.median}; cook in top 5 at ${cal.top5} | ${cal.cpuSec} |`);
p(`| C engine cliff + targeted | ${sC?.in} | ${sC?.out} | cooked ${sC?.cooked}, mate ${sC?.mate}, no cliff ${sC?.noCliff}; CLIFF ${sC?.cliff} (${sC?.cliffFrom}) | ${sC ? JSON.stringify(sC.cpuSec) : ''} |`);
p(`| E verification | ${sE?.in} | ${sE?.out} | proofs ${sE?.proofs} (${sE?.proofFails} failed), playouts ${sE?.playouts} (${sE?.attackerWins} attacker wins), cooked at E ${JSON.stringify(sE?.cookedAtE)} | ${sE ? JSON.stringify(sE.cpuSec) : ''} |`);
p('\n## cooks found only at C or E\n');
for (const c of C) for (const n of c.nodes) for (const k of n.cooks || []) p(`- C ${c.id} R=${n.R} ${k.m} wins (${k.len} plies, check-proof ${k.checked}); key ${n.keys.join(',')}; bestAlt ${n.bestAlt?.m} p=${n.bestAlt?.p}`);
for (const e of E) for (const pr of e.problems) p(`- E ${e.id}: ${pr}`);
p('\n## C verdicts\n');
for (const c of C) p(`- ${c.id} L=${c.L} ${c.tier} ${c.pass ? 'PASS' : 'reject: ' + c.why} maxAltP=${c.maxAltP.toFixed(3)} rootNodesToKey=${c.d.rootNodesToKey} hardest=${c.d.hardestNodesToKey}@R${c.d.hardestR}`);
p('\n## candidates\n');
const board = (tps) => { const rows = tps.split(' ')[0].split('/'); return rows.map((r, i) => `${6 - i} ` + r.split(',').flatMap((c) => (/^x\d*$/.test(c) ? Array(+(c.slice(1) || 1)).fill('.') : [c])).map((c) => c.padEnd(9)).join('')).join('\n') + '\n  ' + 'abcdef'.split('').map((f) => f.padEnd(9)).join(''); };
for (const x of cand) {
  p(`### ${x.id} (${x.meta.from}, game ${x.meta.gameId ?? '-'}), ${x.cert.tier}, ${x.plies} plies, komi ${x.komi}, ${x.tps.split(' ')[1] === '1' ? 'white' : 'black'} to move\n`);
  p('```\n' + board(x.tps) + '\n```');
  p(`line: ${x.meta.mainLine.join(' ')}  `);
  p(`scores: ${JSON.stringify(x.cert.scores)}\n`);
}
