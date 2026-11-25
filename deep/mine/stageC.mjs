// Stage C (engine cliff + targeted search) and the node-count parts of stage D, per MINING.md.
//   node --no-warnings deep/mine/stageC.mjs --out=DIR --calibrate [--nodes=20000000]   CLIFF from known cooks
//   node --no-warnings deep/mine/stageC.mjs --out=DIR [--nodes=20000000] [--dnodes=20000000] [--secs=120] [--cliff=x]
// Needs SYN=<syntaks binary>. At most --procs processes at once (engines first, then deep).
//
// At each certified attacker node with R >= 5 (every key's branch):
//   1. MultiPV 5 at --nodes with every move of the key ideas excluded; bestAlt = line 1 (p = HumanWDL
//      win + draw/2 for the attacker; a mate score is p = 1). Reject if mate > 0 or p >= CLIFF.
//   2. Suspects: those five, the game's move at that node (when the game reached it), and every
//      undecided threat move from B. Each runs `deep prove and=1 q=1 secs=--secs dump=1`; any proof
//      is a cook (kept with its dump for check-proof.mjs). #Hybrid does not exist here: skipped.
//   3. Residual risk needs tak-human (not on this machine): left null.
// D parts: an unexcluded MultiPV 1 search at --dnodes per node; nodes until the engine first plays a key
// idea and keeps it (null = never within the budget).
import fs from 'node:fs';
import path from 'node:path';
import { Game } from '../../shared/tak.js';
import { arg, readJsonl, writeJsonl, Engine, pool, idea, canon, legalPTN, nodesToKey, proveSuspects } from './lib.mjs';

const OUT = arg('out'), PROCS = +arg('procs', 6), NODES = +arg('nodes', 2e7), DNODES = +arg('dnodes', 2e7), SECS = +arg('secs', 120);
const CAL = process.argv.includes('--calibrate');
const rows = new Map(readJsonl(path.join(OUT, 'rows.jsonl')).map((r) => [r.id, r]));
const t0 = Date.now();

const keyIdeasOf = (n) => new Set(n.keys.map(idea));
const excludeFor = (tps, ideas) => legalPTN(tps).filter((m) => ideas.has(idea(m)));
const afterMove = (tps, hk, mv) => { const g = Game.fromTPS(tps, hk / 2); g.play(mv); return g.toTPS(); };

async function engineJobs(jobs) {
  const engines = [...Array(Math.min(PROCS, jobs.length))].map(() => new Engine(process.env.SYN));
  let ms = 0, k = 0; const deadCpu = 0;
  // one worker per engine, so two searches never share a process
  await Promise.all(engines.map(async (e0, w) => {
    let e = e0;
    while (k < jobs.length) {
      const j = jobs[k++];
      try { const r = await e.search(j.tps, j.hk, j.opts); ms += r.ms; j.res = r; }
      catch (err) { j.res = { lines: [], trace: [], best: null, error: String(err.message || err) }; e = engines[w] = new Engine(process.env.SYN); } // a crashed engine is replaced
    }
  }));
  const cpu = engines.reduce((a, e) => a + e.cpuSec(), 0) + deadCpu;
  engines.forEach((e) => e.quit());
  return { wall: ms / 1000, cpu }; // ps CPU seconds of the engines (a replaced engine's time is lost: deadCpu = 0)
}

if (CAL) {
  // cooked nodes from A and B: a failing node with a winning idea other than the key's
  const cooked = [];
  for (const st of ['A', 'B']) for (const c of readJsonl(path.join(OUT, `stage${st}.jsonl`))) {
    if (c.status !== 'ok' || c.tier) continue;
    for (const n of c.nodes || []) {
      if (!n.fail || !n.keys.length) continue;
      const ki = keyIdeasOf(n), cooks = n.listedWins.filter((w) => !ki.has(w.idea));
      if (cooks.length) { cooked.push({ id: c.id, stage: st, tps: n.tps, R: n.R, hk: c.halfkomi, keys: n.keys, cooks }); break; }
    }
  }
  // every B cook (quiet cooks, the kind C exists to catch), then A cooks up to --max
  const sample = [...cooked.filter((x) => x.stage === 'B'), ...cooked.filter((x) => x.stage === 'A')].slice(0, +arg('max', 80));
  const jobs = sample.map((x) => ({ x, tps: x.tps, hk: x.hk, opts: { nodes: NODES, multipv: 5, exclude: excludeFor(x.tps, keyIdeasOf(x)) } }));
  const cpu1 = (await engineJobs(jobs)).cpu;
  // cooks not among the five lines: a searchmoves run on the cook moves alone
  const extra = [];
  for (const j of jobs) {
    const lines = j.res.lines.map((l) => ({ m: canon(j.tps, l.pv[0]), p: l.p, mate: l.mate }));
    const cookIdeas = new Set(j.x.cooks.map((w) => w.idea));
    const hit = lines.filter((l) => cookIdeas.has(idea(l.m)));
    j.x.lines = lines; j.x.bestAlt = lines[0] || null;
    j.x.cookP = hit.length ? Math.max(...hit.map((l) => l.p)) : null; j.x.cookRank = hit.length ? lines.indexOf(hit[0]) + 1 : null;
    if (!hit.length) extra.push({ x: j.x, tps: j.tps, hk: j.hk, opts: { nodes: NODES, multipv: 1, searchmoves: legalPTN(j.tps).filter((m) => cookIdeas.has(idea(m))) } });
  }
  const cpu2 = (await engineJobs(extra)).cpu;
  for (const j of extra) { const l = j.res.lines[0]; j.x.cookP = l ? l.p : null; j.x.cookRank = '>5'; }
  writeJsonl(path.join(OUT, 'calib.jsonl'), sample);
  const ps = sample.map((x) => x.cookP).filter((p) => p != null).sort((a, b) => a - b);
  const q = (f) => ps[Math.floor((ps.length - 1) * f)];
  const s = { stage: 'C-calibrate', cookedNodes: cooked.length, sampled: sample.length, cookP: { min: ps[0], p05: q(0.05), p10: q(0.1), median: q(0.5) }, bestAltP: { min: Math.min(...sample.map((x) => x.bestAlt?.p ?? 1)) }, top5: sample.filter((x) => x.cookRank !== '>5').length, cpuSec: +(cpu1 + cpu2).toFixed(1), wallSec: (Date.now() - t0) / 1000 };
  fs.writeFileSync(path.join(OUT, 'calib.summary.json'), JSON.stringify(s, null, 1));
  console.log(JSON.stringify(s));
  process.exit(0);
}

// ---------------- main C/D run ----------------
const calib = fs.existsSync(path.join(OUT, 'calib.summary.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'calib.summary.json'))) : null;
const MARGIN = +arg('margin', 0.05);
const CLIFF = arg('cliff') != null ? +arg('cliff') : calib?.cookP?.min != null ? +(calib.cookP.min - MARGIN).toFixed(3) : 0.5;
const A = new Map(readJsonl(path.join(OUT, 'stageA.jsonl')).map((c) => [c.id, c]));
const surv = readJsonl(path.join(OUT, 'stageB.jsonl')).filter((c) => c.pass);
// a B timeout keeps A's nodes for any node B did not reach
const items = [];
for (const c of surv) {
  const nodes = new Map((A.get(c.id)?.nodes || []).map((n) => [n.tps, { ...n, from: 'A' }]));
  for (const n of c.nodes) nodes.set(n.tps, { ...n, from: 'B' });
  const row = rows.get(c.id);
  // the game's moves from the root, to find the game's move at each node it reached
  const gameAt = new Map();
  try { const g = Game.fromTPS(c.tps, c.halfkomi / 2); for (const mv of row?.meta?.gameLine || []) { const t = g.toTPS(); const p = g.moveToPTN(g.parseMove(mv)); if (!gameAt.has(t)) gameAt.set(t, p); g.play(mv); if (g.result()) break; } } catch {}
  const list = [...nodes.values()].filter((n) => n.R >= 5 && n.keys.length);
  items.push({ c, list, gameAt });
}
const jobs = [];
for (const it of items) for (const n of it.list) {
  const ki = keyIdeasOf(n);
  jobs.push({ it, n, tps: n.tps, hk: it.c.halfkomi, opts: { nodes: NODES, multipv: 5, exclude: excludeFor(n.tps, ki) } });
}
const cpuC1 = (await engineJobs(jobs)).cpu;
for (const j of jobs) {
  const n = j.n;
  n.lines = j.res.lines.map((l) => ({ m: canon(n.tps, l.pv[0]), p: l.p, mate: l.mate, cp: l.cp }));
  n.bestAlt = n.lines[0] || null;
  n.engineError = j.res.error || null;
}
// silver rows: nodes at or below B's cutR already have listed alternatives; gold rules apply above it
const strictR = (c, n) => n.R >= 7 && n.R > (c.cutR || 0);
const engineVerdict = (it) => {
  const s = it.list.filter((n) => strictR(it.c, n));
  return it.list.some((n) => n.engineError) ? 'engine error' : s.some((n) => n.bestAlt?.mate > 0) ? 'mate' : s.some((n) => (n.bestAlt?.p ?? 0) >= CLIFF) ? 'no cliff' : null;
};
// suspects, only where the cliff passed and only at nodes where a cook rejects (R >= 7 above cutR)
const proveJobs = [];
for (const it of items) {
  if (engineVerdict(it)) continue;
  for (const n of it.list) {
    if (!strictR(it.c, n)) continue;
    const ki = keyIdeasOf(n);
    const sus = new Set(n.lines.map((l) => l.m));
    const gm = it.gameAt.get(n.tps); if (gm && !ki.has(idea(gm))) sus.add(gm);
    for (const m of n.undecidedThreat || []) sus.add(canon(n.tps, m));
    n.suspects = [...sus].filter((m) => !ki.has(idea(m)));
    for (const m of n.suspects) { try { proveJobs.push({ it, n, m, tps: afterMove(n.tps, it.c.halfkomi, m) }); } catch (e) { n.badSuspect = (n.badSuspect || []).concat(m); } }
  }
}
// deep prove: one process per suspect, PROCS at once, rows taking turns; a row stops at its first checked cook
// (one process per row left the longest row running alone on one core, and kept proving after its first cook)
for (const p of proveJobs) { p.id = p.it.c.id; p.hk = p.it.c.halfkomi; }
const pr = await proveSuspects(proveJobs, { dir: path.join(OUT, 'stageC-prove'), procs: PROCS, secs: SECS, lp: arg('lp', '22') });
const cpuProve = pr.cpu;
for (const p of proveJobs) { if (p.result === 'proved') { (p.n.cooks ||= []).push({ m: p.m, len: p.len + 1, checked: p.checked || null }); } else (p.n.suspectRes ||= {})[p.m] = p.result; }
// D: node counts until the engine plays a key, only for rows still alive
const djobs = [];
for (const it of items) if (!engineVerdict(it) && !it.list.some((n) => (n.cooks || []).length && strictR(it.c, n))) for (const n of it.list) djobs.push({ it, n, tps: n.tps, hk: it.c.halfkomi, opts: { nodes: DNODES, multipv: 1 } });
const cpuD = (await engineJobs(djobs)).cpu;
for (const j of djobs) { j.n.nodesToKey = j.res.error ? undefined : nodesToKey(j.res.trace, j.n.tps, keyIdeasOf(j.n)); j.n.engineBest = j.res.best ? canon(j.n.tps, j.res.best) : null; }
// verdicts
const out = [];
for (const it of items) {
  const c = it.c;
  const ns = it.list.map((n) => ({ tps: n.tps, R: n.R, from: n.from, keys: n.keys, listedWins: n.listedWins, undecided: n.undecided, bestAlt: n.bestAlt, lines: n.lines, suspects: n.suspects, suspectRes: n.suspectRes || {}, cooks: n.cooks || [], nodesToKey: n.nodesToKey, engineBest: n.engineBest, defIdeas: n.defIdeas, engineError: n.engineError || null, p: null }));
  const ev = engineVerdict(it);
  const cookNodes = ns.filter((n) => n.cooks.length && strictR(c, n));
  const maxAlt = Math.max(0, ...ns.filter((n) => strictR(c, n)).map((n) => n.bestAlt?.p ?? 0));
  const why = ev === 'engine error' ? ev : cookNodes.length ? 'cook' : ev;
  const root = ns.find((n) => n.tps === c.nodes[0]?.tps) || ns[0];
  const hardest = ns.reduce((a, n) => ((n.nodesToKey ?? Infinity) > (a?.nodesToKey ?? -1) ? n : a), null);
  out.push({ id: c.id, L: c.L, tier: c.tier, bStatus: c.status, pass: !why, why, cliff: CLIFF, maxAltP: maxAlt, nodes: ns,
    d: { rootNodesToKey: root?.nodesToKey ?? null, hardestNodesToKey: hardest?.nodesToKey ?? null, hardestR: hardest?.R ?? null, missed: null }, risk: null, riskNote: 'tak-human not available on this machine' });
}
writeJsonl(path.join(OUT, 'stageC.jsonl'), out);
const s = { stage: 'C', in: items.length, out: out.filter((x) => x.pass).length, cooked: out.filter((x) => x.why === 'cook').length, mate: out.filter((x) => x.why === 'mate').length, noCliff: out.filter((x) => x.why === 'no cliff').length,
  cliff: CLIFF, cliffFrom: arg('cliff') != null ? 'arg' : calib ? `calib min ${calib.cookP?.min} - ${MARGIN}` : 'default 0.5', cliffSearches: jobs.length, dSearches: djobs.length, proveJobs: proveJobs.length,
  cpuSec: { engineCliff: +cpuC1.toFixed(1), engineD: +cpuD.toFixed(1), prove: +cpuProve.toFixed(1) }, proveSkipped: pr.skipped, wallSec: (Date.now() - t0) / 1000 };
fs.writeFileSync(path.join(OUT, 'stageC.summary.json'), JSON.stringify(s, null, 1));
console.log(JSON.stringify(s));
