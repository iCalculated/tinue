// Stage E (independent verification), per MINING.md, on stage C survivors (or --from=B for B survivors).
//   node --no-warnings deep/mine/stageE.mjs --out=DIR [--procs=6] [--playouts=1] [--anodes=5000000] [--dnodes=1000000]
// 1. Every listed win at every certified node is proved again by `deep prove and=1 dump=1` (a key at
//    p = R-1, q = 0; a slower win unlimited at q = 0; a quiet win unlimited at q = 1) and the dump is
//    walked by check-proof.mjs (shared/tak.js only). A key must check at <= R-1 plies.
// 2. The root is replayed from the game record (meta.history) with tak.js and must equal the stored TPS.
// 3. Playouts: the root's top five non-key alternatives (stage C lines), 3 times each, Syntaks at
//    --anodes (x1, x1.1, x1.2 so the three games differ) attacking against --dnodes defending, 12 moves
//    a side. An attacker win sends the move back to `deep prove and=1 q=1 secs=1200` (10x stage C).
import fs from 'node:fs';
import path from 'node:path';
import { Game } from '../../shared/tak.js';
import { arg, readJsonl, writeJsonl, Engine, pool, idea, canon, runOne, DEEP, CHECK_PROOF } from './lib.mjs';

const OUT = arg('out'), PROCS = +arg('procs', 6), FROM = arg('from', 'C'), PLAY = arg('playouts', '1') === '1';
const ANODES = +arg('anodes', 5e6), DNODES = +arg('dnodes', 1e6);
const t0 = Date.now();
const rows = new Map(readJsonl(path.join(OUT, 'rows.jsonl')).map((r) => [r.id, r]));
const B = new Map(readJsonl(path.join(OUT, 'stageB.jsonl')).map((c) => [c.id, c]));
const A = new Map(readJsonl(path.join(OUT, 'stageA.jsonl')).map((c) => [c.id, c]));
const C = new Map(readJsonl(path.join(OUT, 'stageC.jsonl')).map((c) => [c.id, c]));
const ids = FROM === 'C' ? [...C.values()].filter((c) => c.pass).map((c) => c.id) : [...B.values()].filter((c) => c.pass).map((c) => c.id);
const dir = path.join(OUT, 'stageE'); fs.mkdirSync(dir, { recursive: true });
const after = (tps, hk, mv) => { const g = Game.fromTPS(tps, hk / 2); g.play(mv); return g.toTPS(); };
let cpu = { prove: 0, check: 0, engine: 0, reprove: 0 };

const results = new Map(ids.map((id) => [id, { id, proofs: [], replay: null, playouts: [], ok: true, problems: [] }]));
// 1. proofs
await pool(ids, PROCS, async (id) => {
  const cB = B.get(id), cA = A.get(id), R = results.get(id);
  const nodes = new Map((cA?.nodes || []).map((n) => [n.tps, n])); for (const n of cB?.nodes || []) nodes.set(n.tps, n);
  const groups = {}; // "p|q" -> [{tps after, node, win}]
  for (const n of nodes.values()) for (const w of n.listedWins) {
    const key = w.kind === 'key' ? `${n.R - 1}|0` : w.kind === 'slower' ? `255|0` : `255|1`;
    let t; try { t = after(n.tps, cB.halfkomi, w.m); } catch (e) { R.problems.push(`illegal ${w.m} at ${n.tps}`); continue; }
    const g = Game.fromTPS(t, cB.halfkomi / 2);
    if (g.result()) { R.proofs.push({ tps: n.tps, R: n.R, m: w.m, kind: w.kind, ok: g.result().winner !== g.toMove, len: 1, how: 'ends game' }); continue; }
    (groups[key] ||= []).push({ t, n, w });
  }
  for (const [k, list] of Object.entries(groups)) {
    const [p, q] = k.split('|');
    const f = path.join(dir, `${id}.p${p}q${q}.in`), o = f.replace(/\.in$/, '.out');
    fs.writeFileSync(f, list.map((x) => `${x.t}|${cB.halfkomi}`).join('\n') + '\n');
    const r = await runOne(DEEP, ['prove', f, 'and=1', `q=${q}`, `p=${p}`, 'secs=300', 'dump=1', 'lp=21'], { stdoutFile: o });
    cpu.prove += r.cpu;
    const res = fs.readFileSync(o, 'utf8').split('\n').filter((l) => /^\d+\t/.test(l)).map((l) => l.split('\t'));
    const ck = await runOne('node', ['--no-warnings', CHECK_PROOF, o]); cpu.check += ck.cpu;
    const ckl = ck.out.split('\n').map((l) => l.match(/^(\d+)\t(ok|FAIL)\t?(\d+)?/)).filter(Boolean);
    let pi = 0;
    for (const fld of res) {
      const x = list[+fld[0]];
      const rec = { tps: x.n.tps, R: x.n.R, m: x.w.m, kind: x.w.kind, deep: fld[1], deepLen: +fld[2] };
      if (fld[1] === 'proved') { const c = ckl[pi++]; rec.check = c ? c[2] : 'missing'; rec.checkLen = c?.[3] ? +c[3] : null; }
      rec.ok = rec.deep === 'proved' && rec.check === 'ok' && rec.checkLen === rec.deepLen && (x.w.kind !== 'key' || rec.deepLen + 1 <= x.n.R);
      R.proofs.push(rec);
    }
  }
  for (const pr of R.proofs) if (!pr.ok) { R.ok = false; R.problems.push(`proof ${pr.kind} ${pr.m} at R=${pr.R}: ${pr.deep || pr.how} check=${pr.check} len ${pr.deepLen}/${pr.checkLen}`); }
});
// 2. replay from the game record
for (const id of ids) {
  const R = results.get(id), row = rows.get(id), hist = row?.meta?.history;
  if (!hist) { R.replay = 'no history'; continue; }
  try {
    const g = new Game(6); g.komi = row.komi; for (const mv of hist) g.play(mv);
    const a = g.toTPS().split(' '), b = row.tps.split(' ');
    R.replay = a[0] === b[0] && a[1] === b[1] && a[2] === b[2] ? 'ok' : `differs: ${g.toTPS()}`;
  } catch (e) { R.replay = 'error ' + e.message; }
  if (R.replay !== 'ok') { R.ok = false; R.problems.push('replay ' + R.replay); }
}
// 3. playouts
if (PLAY) {
  const jobs = [];
  for (const id of ids) {
    const c = C.get(id), root = c?.nodes?.find((n) => n.tps === B.get(id).tps) || c?.nodes?.[0];
    if (!root) continue;
    for (const l of (root.lines || []).slice(0, 5)) for (let k = 0; k < 3; k++) jobs.push({ id, tps: root.tps, hk: B.get(id).halfkomi, m: l.m, k });
  }
  const engines = [...Array(Math.min(PROCS, jobs.length))].map(() => new Engine(process.env.SYN));
  let j = 0;
  await Promise.all(engines.map(async (e0) => {
    let e = e0;
    while (j < jobs.length) {
      const x = jobs[j++];
      const g = Game.fromTPS(x.tps, x.hk / 2), att = g.toMove, moves = [x.m];
      g.play(x.m);
      for (let ply = 0; ply < 23 && !g.result(); ply++) {
        const attacking = g.toMove === att;
        let r;
        try { r = await e.search(g.toTPS(), x.hk, { nodes: attacking ? ANODES * (1 + 0.1 * x.k) : DNODES }); }
        catch { e = new Engine(process.env.SYN); x.error = 'engine crashed'; break; }
        cpu.engine += r.ms / 1000;
        if (!r.best) break;
        moves.push(canon(g.toTPS(), r.best)); g.play(r.best);
      }
      const res = g.result();
      x.result = res ? (res.winner === att ? 'attacker' : res.winner ? 'defender' : 'draw') : 'unfinished';
      x.moves = moves;
      results.get(x.id).playouts.push({ m: x.m, k: x.k, result: x.result, moves: moves.join(' ') });
    }
  }));
  engines.forEach((e) => e.quit()); // a replaced engine quits when the script exits
  // attacker wins go back to deep at 10x the stage C budget
  const back = [...new Map(jobs.filter((x) => x.result === 'attacker').map((x) => [x.id + ' ' + x.m, x])).values()];
  await pool(back, PROCS, async (x) => {
    const f = path.join(dir, `${x.id}.back.${x.m.replace(/[^a-z0-9]/gi, '_')}.in`), o = f.replace(/\.in$/, '.out');
    fs.writeFileSync(f, `${after(x.tps, x.hk, x.m)}|${x.hk}\n`);
    const r = await runOne(DEEP, ['prove', f, 'and=1', 'q=1', 'secs=1200', 'dump=1', 'lp=21'], { stdoutFile: o });
    cpu.reprove += r.cpu;
    const fld = (fs.readFileSync(o, 'utf8').split('\n').find((l) => /^\d+\t/.test(l)) || '').split('\t');
    const R = results.get(x.id);
    R.backToC = (R.backToC || []).concat({ m: x.m, deep: fld[1] || 'none', len: +fld[2] || null });
    if (fld[1] === 'proved') { R.ok = false; R.problems.push(`cook at E: ${x.m} wins (deep q=1, ${+fld[2] + 1} plies)`); }
  });
}
const out = [...results.values()];
writeJsonl(path.join(OUT, 'stageE.jsonl'), out);
const s = { stage: 'E', in: ids.length, out: out.filter((r) => r.ok).length, proofs: out.reduce((a, r) => a + r.proofs.length, 0), proofFails: out.reduce((a, r) => a + r.proofs.filter((p) => !p.ok).length, 0),
  playouts: out.reduce((a, r) => a + r.playouts.length, 0), attackerWins: out.reduce((a, r) => a + r.playouts.filter((p) => p.result === 'attacker').length, 0),
  cookedAtE: out.filter((r) => r.problems.some((p) => p.startsWith('cook at E'))).map((r) => r.id), cpuSec: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, +v.toFixed(1)])), wallSec: (Date.now() - t0) / 1000 };
fs.writeFileSync(path.join(OUT, 'stageE.summary.json'), JSON.stringify(s, null, 1));
console.log(JSON.stringify(s));
