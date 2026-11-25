// Summarise measure-swing.mjs output.  usage: node scripts/archive/report-swing.mjs <jsonl> [<jsonl at other budget> for stability]
import fs from 'node:fs';

const load = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rows = load(process.argv[2]).filter((r) => !r.error && r.ev?.pre0?.pAtt != null);
const errs = load(process.argv[2]).filter((r) => r.error || r.ev?.pre0?.pAtt == null);
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + '%' : '-');
const BUCKETS = [[0, 0.3], [0.3, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 0.95], [0.95, 1.0001]];
const bname = ([a, b]) => `${a.toFixed(2)}–${Math.min(b, 1).toFixed(2)}`;
const bucketOf = (p) => BUCKETS.findIndex(([a, b]) => p >= a && p < b);
const isBot = (n) => /bot$/i.test(n || '');

console.log(`n=${rows.length} (skipped ${errs.length}; replay mismatches: ${rows.filter((r) => !r.replayOk).length})`);
console.log(`puzzle-position sanity: attacker p at puzzle  median ${median(rows.map((r) => r.ev.puz?.pAtt))}, min ${Math.min(...rows.map((r) => r.ev.puz?.pAtt ?? 1))}, <0.9: ${rows.filter((r) => r.ev.puz?.pAtt < 0.9).length}`);

const groups = { all: rows };
for (const s of [5, 6]) for (const p of [1, 3, 5]) groups[`s${s} p${p}`] = rows.filter((r) => r.size === s && r.plies === p);
for (const p of [1, 3, 5]) groups[`p${p}`] = rows.filter((r) => r.plies === p);
for (const s of [5, 6]) groups[`s${s}`] = rows.filter((r) => r.size === s);
groups['loser=human'] = rows.filter((r) => !isBot(r.attacker === 'white' ? r.black : r.white));
groups['loser=bot'] = rows.filter((r) => isBot(r.attacker === 'white' ? r.black : r.white));

console.log('\nattacker win prob BEFORE the mistake (pre0), histogram:');
console.log('group'.padEnd(13) + 'n'.padStart(4) + BUCKETS.map((b) => bname(b).padStart(11)).join('') + '   ≤.5   ≤.6   ≤.7  median');
for (const [k, g] of Object.entries(groups)) {
  const h = BUCKETS.map(() => 0);
  for (const r of g) h[bucketOf(r.ev.pre0.pAtt)]++;
  const le = (t) => pct(g.filter((r) => r.ev.pre0.pAtt <= t).length, g.length).padStart(6);
  console.log(k.padEnd(13) + String(g.length).padStart(4) + h.map((x) => pct(x, g.length).padStart(11)).join('') + le(0.5) + le(0.6) + le(0.7) + '  ' + median(g.map((r) => r.ev.pre0.pAtt)));
}

console.log('\nwas the attacker already winning for a while? (fraction with p ≥ 0.7 / ≥ 0.9; positions are all loser-to-move)');
for (const [k, g] of Object.entries(groups)) {
  const f = (key, t) => { const v = g.filter((r) => r.ev[key]?.pAtt != null); return pct(v.filter((r) => r.ev[key].pAtt >= t).length, v.length).padStart(5); };
  console.log(k.padEnd(13), 'pre4', f('pre4', 0.7), f('pre4', 0.9), ' pre2', f('pre2', 0.7), f('pre2', 0.9), ' pre0', f('pre0', 0.7), f('pre0', 0.9),
    '  all three ≥0.7:', pct(g.filter((r) => ['pre0', 'pre2', 'pre4'].every((x) => (r.ev[x]?.pAtt ?? 1) >= 0.7)).length, g.length));
}

console.log('\n"swing" candidates: pre0 ≤ 0.6 (mistake turned it), and how many were ALSO ≤ 0.6 two and four plies earlier (steady, not a blip):');
for (const [k, g] of Object.entries(groups)) {
  const sw = g.filter((r) => r.ev.pre0.pAtt <= 0.6);
  const steady = sw.filter((r) => (r.ev.pre2?.pAtt ?? 0) <= 0.6 && (r.ev.pre4?.pAtt ?? 0) <= 0.6);
  console.log(k.padEnd(13), `swing ${sw.length}/${g.length} (${pct(sw.length, g.length)}), steady-before ${steady.length}`);
}

console.log('\ndf-pn: was the loser ALREADY lost before the "mistake"? (every reply at pre0 still loses to a tinuë; threat-restricted, 3e4-node budget)');
for (const [k, g] of Object.entries(groups)) {
  const c = (v) => g.filter((r) => r.lostBefore === v).length;
  const a = (v) => g.filter((r) => r.attTinue2 === v).length;
  console.log(k.padEnd(13), `lostBefore proved ${c('proved')} (${pct(c('proved'), g.length)}) disproved ${c('disproved')} unknown ${c('unknown')}`,
    `| attacker already had a tinuë on their previous turn: ${a('proved')} (${pct(a('proved'), g.length)}) unknown ${a('unknown')}`);
}
const lp = rows.filter((r) => r.lostBefore === 'proved');
console.log(`  pre0 p for lostBefore=proved: median ${median(lp.map((r) => r.ev.pre0.pAtt))}, min ${Math.min(...lp.map((r) => r.ev.pre0.pAtt))}`);
const ad = rows.filter((r) => r.attTinue2 === 'proved');
console.log(`  attTinue2 proved plies: ${JSON.stringify(count(ad.map((r) => r.attTinue2Plies)))}`);

console.log('\nexamples per bucket (pre0 / pre2 / pre4 attacker p; lostBefore) — https://shydrie.xyz/tinue/#/puzzle/<id>');
for (const b of BUCKETS) {
  const inB = rows.filter((r) => bucketOf(r.ev.pre0.pAtt) === BUCKETS.indexOf(b));
  const ex = spread(inB, 5);
  console.log(`  ${bname(b)} (${inB.length}): ` + ex.map((r) => `${r.id} s${r.size}p${r.plies} ${f2(r.ev.pre0.pAtt)}/${f2(r.ev.pre2?.pAtt)}/${f2(r.ev.pre4?.pAtt)}${r.lostBefore === 'proved' ? ' LOST' : ''}`).join(', '));
}

const cpu = (key) => { const o = {}; for (const s of [5, 6]) { const v = rows.filter((r) => r.size === s && r.ev[key]?.cpu != null).map((r) => r.ev[key].cpu); o['s' + s] = `${mean(v).toFixed(0)}ms (p90 ${quant(v, 0.9)})`; } return o; };
console.log('\nTiltak thread-CPU per eval:', JSON.stringify({ pre0: cpu('pre0'), pre2: cpu('pre2'), puz: cpu('puz') }));
const pn = rows.map((r) => r.lostBeforeMs || 0), pa = rows.map((r) => r.attTinue2Ms || 0);
console.log(`df-pn thread-CPU per check: lostBefore mean ${mean(pn).toFixed(0)}ms p90 ${quant(pn, 0.9)}; attTinue2 mean ${mean(pa).toFixed(0)}ms p90 ${quant(pa, 0.9)}`);

if (process.argv[3]) {
  const other = new Map(load(process.argv[3]).filter((r) => r.ev?.pre0?.pAtt != null).map((r) => [r.id, r]));
  const pairs = rows.filter((r) => other.has(r.id)).map((r) => [r.ev.pre0.pAtt, other.get(r.id).ev.pre0.pAtt]);
  const d = pairs.map(([a, b]) => Math.abs(a - b));
  const flip = (t) => pairs.filter(([a, b]) => (a <= t) !== (b <= t)).length;
  console.log(`\nstability vs ${process.argv[3]}: n=${pairs.length}, |Δp| mean ${mean(d).toFixed(3)} p90 ${quant(d, 0.9)} max ${Math.max(...d).toFixed(3)}; threshold flips @0.5 ${flip(0.5)} @0.6 ${flip(0.6)} @0.7 ${flip(0.7)}`);
  const cpuO = [...other.values()].map((r) => r.ev.pre0.cpu).filter((x) => x != null);
  console.log(`  other-budget pre0 CPU mean ${mean(cpuO).toFixed(0)}ms`);
}

function f2(x) { return x == null ? '—' : x.toFixed(2); }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
function quant(a, q) { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(3) : null; }
function median(a) { return quant(a, 0.5); }
function count(a) { const o = {}; for (const x of a) o[x] = (o[x] || 0) + 1; return o; }
function spread(a, k) { const s = a.slice().sort((x, y) => x.id.localeCompare(y.id)); if (s.length <= k) return s; return Array.from({ length: k }, (_, i) => s[Math.floor((i * s.length) / k)]); }

// Low pre0 = the LOSER was winning. How often did the loser have a win of their own at pre0 (missed road / tinuë)?
{
  const { Game } = await import('../../shared/tak.js');
  const { winMove, proveTinue } = await import('../../shared/pns.js');
  const prev = new Map();
  for (const s of [5, 6]) for (const l of fs.readFileSync(new URL(`../../data/puzzles/playtak-${s}.jsonl`, import.meta.url), 'utf8').split('\n')) if (l) { const p = JSON.parse(l); prev.set(p.id, p.meta.prevTps); }
  console.log('\nloser\'s own chances at pre0 (loser to move): immediate road / threat-tinuë (df-pn 2e4 nodes)');
  const tag = new Map();
  for (const r of rows) {
    const g = Game.fromTPS(prev.get(r.id), r.komi);
    const w1 = !!winMove(g, g.toMove);
    const t = w1 ? 'proved' : proveTinue(g, { maxNodes: 2e4 }).result;
    tag.set(r.id, w1 ? 'win1' : t === 'proved' ? 'tinue' : t === 'unknown' ? '?' : 'none');
  }
  for (const b of [[0, 0.3], [0.3, 0.6], [0.6, 0.8], [0.8, 1.0001]]) {
    const g = rows.filter((r) => r.ev.pre0.pAtt >= b[0] && r.ev.pre0.pAtt < b[1]);
    const c = count(g.map((r) => tag.get(r.id)));
    console.log(`  pre0 ∈ [${b[0]}, ${Math.min(1, b[1])}) n=${g.length}: loser had road-in-1 ${c.win1 || 0}, had a tinuë ${c.tinue || 0}, neither ${c.none || 0}, unknown ${c['?'] || 0}`);
  }
  for (const p of [1, 3, 5]) {
    const g = rows.filter((r) => r.plies === p);
    const c = count(g.map((r) => tag.get(r.id)));
    console.log(`  p${p}: loser missed own road-in-1 ${pct(c.win1 || 0, g.length)}, missed own tinuë ${pct(c.tinue || 0, g.length)}`);
  }
  const ex = rows.filter((r) => tag.get(r.id) === 'none' && r.ev.pre0.pAtt <= 0.6);
  console.log(`  "quiet swing" (pre0 ≤ 0.6, loser had no immediate win/tinuë): ${ex.length}/${rows.length} — e.g. ${spread(ex, 8).map((r) => `${r.id} s${r.size}p${r.plies} ${f2(r.ev.pre0.pAtt)}`).join(', ')}`);
}
