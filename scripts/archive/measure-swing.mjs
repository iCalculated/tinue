// Research: how many tinue puzzles "change the course of the game"?
//
// For a stratified sample of mined PlayTak puzzles (sizes 5/6 × plies 1/3/5), replay the source game
// and evaluate, from the ATTACKER's point of view (the side that wins the puzzle):
//   pre0  = position right before the loser's mistake (meta.prevTps, loser to move)
//   pre2  = 2 plies earlier (loser to move)       pre4 = 4 plies earlier (loser to move)
//   puz   = the puzzle position (attacker to move; sanity check, should be ≈ 1)
// with Tiltak (WASM, fixed node budget). For a loser-to-move position, attacker p = 1 − p(side to move).
//
// Plus a df-pn check (shared/pns.js, threat-restricted, unlimited depth, node budget):
//   lostBefore = at pre0, does EVERY loser move still lose to a tinuë? (i.e. the "mistake" changed nothing)
//   attTinue2  = at the attacker's previous turn (2 plies before the puzzle), did the attacker already have a tinuë?
//
// usage: node --no-warnings scripts/archive/measure-swing.mjs [--per-cell 50] [--nodes 20000]
//          [--pns-nodes 30000 (0 = skip df-pn)] [--positions pre0,pre2,pre4,puz] [--threads 10] [--seed 1] [--out <jsonl>]
import fs from 'node:fs';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

if (isMainThread) {
  const perCell = +arg('per-cell', 50);
  const nodes = +arg('nodes', 20000);
  const pnsNodes = +arg('pns-nodes', 30000);
  const threads = +arg('threads', Math.max(1, os.cpus().length - 4));
  const seed = +arg('seed', 1);
  const out = arg('out', 'mining/swing-sample.jsonl');
  const sizes = String(arg('sizes', '5,6')).split(',').map(Number);
  const pliesList = [1, 3, 5];

  // deterministic shuffle (mulberry32)
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const jobs = [];
  for (const size of sizes) {
    const all = fs.readFileSync(`${ROOT}data/puzzles/playtak-${size}.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const plies of pliesList) {
      const cell = all.filter((p) => p.plies === plies);
      for (let i = cell.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cell[i], cell[j]] = [cell[j], cell[i]]; }
      for (const p of cell.slice(0, perCell)) jobs.push({ id: p.id, size: p.size, komi: p.komi, plies: p.plies, tps: p.tps, rating: p.rating, meta: p.meta });
    }
  }
  console.error(`${jobs.length} puzzles, tiltak ${nodes} nodes, pns ${pnsNodes} nodes, ${threads} threads`);
  const fd = fs.openSync(out, 'w');
  let next = 0, done = 0; const t0 = Date.now();
  await new Promise((resolve) => {
    let alive = threads;
    for (let i = 0; i < threads; i++) {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { nodes, pnsNodes, positions: String(arg("positions", "pre0,pre2,pre4,puz")).split(",") } });
      const feed = () => { if (next < jobs.length) w.postMessage(jobs[next++]); else { w.terminate(); if (--alive === 0) resolve(); } };
      w.on('message', (m) => {
        if (m.ready) return feed();
        fs.writeSync(fd, JSON.stringify(m) + '\n');
        if (++done % 20 === 0) console.error(`${done}/${jobs.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        feed();
      });
      w.on('error', (e) => { console.error('worker error', e); if (--alive === 0) resolve(); });
    }
  });
  console.error(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${out}`);
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const { Game } = await import('../../shared/tak.js');
  const { ptnFromServer } = await import('../../shared/ptn.js');
  const { TinueSearch, proveTinue } = await import('../../shared/pns.js');
  const { Tiltak } = await import('../tiltak-node.mjs');
  const { nodes, pnsNodes, positions } = workerData;
  const db = new DatabaseSync(`${ROOT}data/raw/games_anon.db`, { readOnly: true });
  const q = db.prepare('SELECT notation, komi, result FROM games WHERE id = ?');
  let tiltak = await Tiltak.create();
  parentPort.postMessage({ ready: true });

  const cpu = () => { const u = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; };

  async function ev(tps, size, komi, attacker) {
    const komiUsed = komi < 1 ? 0 : 2;
    try {
      const r = await tiltak.evaluate({ tps, size, komi: komiUsed, nodes });
      if (r.pStm == null) return { pAtt: null, ms: r.ms, noInfo: true, best: r.bestmove };
      const stm = +tps.trim().split(/\s+/)[1];
      return { pAtt: stm === attacker ? r.pStm : 1 - r.pStm, cpu: Math.round(r.cpu), best: r.bestmove, ...(komiUsed !== komi ? { komiUsed } : {}) };
    } catch (e) {
      tiltak = await Tiltak.create().catch(() => null); // panic: fresh instance (shares the wasm, so may stay dead)
      return { pAtt: null, err: String(e.message).slice(0, 120) };
    }
  }

  parentPort.on('message', async (p) => {
    const out = { id: p.id, size: p.size, komi: p.komi, plies: p.plies, rating: p.rating, gameId: p.meta.gameId,
      white: p.meta.white, black: p.meta.black, rw: p.meta.ratingWhite, rb: p.meta.ratingBlack, idx: p.meta.ply, mistake: p.meta.lastMove };
    try {
      const row = q.get(p.meta.gameId);
      const moves = row.notation.split(',').map(ptnFromServer);
      const g = new Game(p.size); g.komi = row.komi / 2;
      const tps = [g.toTPS()];
      for (const m of moves) { g.play(m); tps.push(g.toTPS()); }
      const idx = p.meta.ply;
      out.replayOk = tps[idx] === p.tps && tps[idx - 1] === p.meta.prevTps;
      const attacker = +p.tps.trim().split(/\s+/)[1];
      out.attacker = attacker === 1 ? 'white' : 'black';
      out.gameLen = moves.length;
      const pos = { pre0: idx - 1, pre2: idx - 3, pre4: idx - 5, puz: idx };
      out.ev = {};
      for (const [k, i] of Object.entries(pos)) if (positions.includes(k)) out.ev[k] = i >= 1 ? await ev(tps[i], p.size, p.komi, attacker) : null;

      if (!pnsNodes) throw null;
      // df-pn: was the loser already lost at pre0 (every reply loses to a tinuë)?
      const c0 = cpu();
      const g0 = Game.fromTPS(p.meta.prevTps, p.komi);
      const s = new TinueSearch(g0, { maxNodes: pnsNodes });
      s.att = attacker; // defender (loser) to move at the root
      try { out.lostBefore = s.solve(Infinity) ? 'proved' : 'disproved'; }
      catch (e) { if (e.message === 'budget') out.lostBefore = 'unknown'; else throw e; }
      out.lostBeforeNodes = s.nodes; out.lostBeforeMs = Math.round(cpu() - c0);
      // did the attacker already have a tinuë on their previous turn?
      if (idx - 2 >= 1) {
        const c1 = cpu();
        const r = proveTinue(Game.fromTPS(tps[idx - 2], p.komi), { maxNodes: pnsNodes });
        out.attTinue2 = r.result; out.attTinue2Plies = r.plies || null; out.attTinue2Ms = Math.round(cpu() - c1);
      }
    } catch (e) { if (e !== null) out.error = String(e && e.stack || e).slice(0, 300); }
    parentPort.postMessage(out);
  });
}
