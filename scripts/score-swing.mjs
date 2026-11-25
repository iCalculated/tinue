// Score every mined puzzle for "did this tactic change the course of the game?" (docs/mining-options.md §3a/a2).
// Production version of scripts/archive/measure-swing.mjs: whole set, worker pool, per-puzzle timeout, resumable.
//
// Per puzzle, from the ATTACKER's view (the side that wins the puzzle), p = Tiltak (score+100)/200:
//   pre0/pre2/pre4 = attacker p right before the loser's mistake (meta.prevTps) and 2/4 plies earlier (loser to move)
//   puz            = attacker p at the puzzle position (sanity: ≈ 1)
//   lostBefore     = df-pn at pre0: 'proved' if every loser move still loses to a tinuë, else 'disproved'/'unknown'
//   alt, altMove   = attacker p after its best NON-winning first move (not a tree key, not an immediate win):
//                    every such move scanned at --scan-nodes, the top --shortlist re-evaluated at --nodes, max taken
//   altTinue       = (only when it could matter: alt ≥ 0.65, pre0 ≤ 0.75) is altMove itself a slower tinuë? (df-pn)
//   altNT, altNTMove = same case: best shortlisted alternative that is not a proven tinuë (null: all of them are)
//   turn           = 1 iff pre0 ≤ 0.6 && lostBefore ≠ 'proved' && (alt == null || alt < 0.65); 0 if scored otherwise;
//                    null if unscored (reason: size | komi | noprev | noeval | tiltak | timeout | crash | error)
//
// usage: node --no-warnings scripts/score-swing.mjs [--out data/swing/swing.jsonl] [--threads 4] [--timeout-ms 300000]
//          [--nodes 5000] [--scan-nodes 100] [--shortlist 6] [--pns-nodes 30000] [--progress 100]
//          [--ids <file|a,b,c>] [--sample N --seed 1] [--sizes 4,5,6,7,8] [--eval-komi calibrated|game] [--approx-komi] [--retry]
//          [--input a.jsonl,b.jsonl (default: data/puzzles/*.jsonl minus deep-jaffray)]
//
// --refine <first-pass.jsonl>: a stricter second pass over a first-pass sidecar (default out data/swing/swing-v2.jsonl).
// Every row starts as its first-pass row; then
//   alts    = (3+ ply puzzles) non-tree first moves that ALSO force a win: every Tak-threat move, df-pn, confirmed with
//             full defense. Such a puzzle has a second winning idea ("flaw"); the list lets the trainer accept the move
//             as a solve at once. Road-in-1s get no precomputed alts: the browser checks a non-finishing move there
//             live, and a proven forced win is a solve.
//   candidates (first-pass pre0 ≤ 0.6, lostBefore ≠ proved) are re-measured: pre0 at --refine-nodes (first-pass value
//   kept as pre0k5); alt = every non-tree move at --nodes (no 100-node prefilter: it once missed a winning b4), the top
//   3 at --refine-nodes, max (first-pass alt kept as altk5); esc = (4×4, and 5×5 multi-ply) exact check that the loser
//   had a move at pre0 that escapes (false = really lost before: df-pn's threat model misses quiet/flat-count wins).
//   turn = 1 iff pre0 ≤ 0.5 && lostBefore ≠ proved && esc ≠ false && alt < (1 ply ? 0.70 : 0.65) && no alts.
//   (0.5–0.6 failed stricter checks 45% of the time; 1-ply alt misses at 0.65–0.70 were noise. See docs/mining-options.md.)
//
// --patch <v2.jsonl>: a third pass over the refined sidecar (default out data/swing/swing-v3.jsonl), after a second
// adversarial check. It only adds slower wins and only ever demotes turn:
//   altsAt  = (5+ ply) the same as alts at later attacker moves, keyed by the space-joined moves played so far
//   alts   += (4×4, 5×5 3-ply) quiet slower first moves (exact Solver, win within plies+2): threatMoves can't see them
//   for turn = 1 rows:
//     slow1    = (road-in-1s) proven slower wins (game komi): another way to win, so not a turning point
//     pre0k0/altk0 = komi-0 games near a flat ending (≤ 4 reserve stones or ≤ 3 empty squares): re-evaluated at the
//                real komi (komi 2 flips flat-count endings); the max of both is used
//     esc      = horizon 5 for every 4×4 and near-flat 5×5 row (3 let loss-in-5 positions through as escapes)
//     pre0Deep/altDeep = near the cutoffs (pre0 > 0.4, alt ≥ 0.55) re-evaluated at --deep-nodes (top 5 alts); max used
//   turn = 1 iff it was 1 and still passes the v2 rule with these values and no alts / slow1.
// Output is NOT under data/puzzles/: import.mjs treats every *.jsonl there as puzzles.
// Resumable: ids already in --out are skipped (--retry re-runs timeout/crash/error/tiltak rows).
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RAW_DB = ROOT + 'data/raw/games_anon.db';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const PRE0_MAX = 0.6, ALT_MAX = 0.65;
const RETRYABLE = new Set(['timeout', 'crash', 'error', 'tiltak']);

if (isMainThread) {
  const patchFrom = arg('patch'), refineFrom = arg('refine') || patchFrom, V = patchFrom ? 3 : 2;
  const out = path.resolve(arg('out', ROOT + (patchFrom ? 'data/swing/swing-v3.jsonl' : refineFrom ? 'data/swing/swing-v2.jsonl' : 'data/swing/swing.jsonl')));
  const threads = Math.max(1, +arg('threads', 4));
  // wall clock, so generous: the slowest rows (pre0 ≤ 0.75 with altTinue proofs: the borderline rows) take
  // ~10 s CPU and a busy laptop stretches that 3–10×; a timeout here would quietly drop exactly those rows
  const timeoutMs = +arg('timeout-ms', 300000);
  const every = +arg('progress', 100);
  const sizes = String(arg('sizes', '4,5,6,7,8')).split(',').map(Number);
  const opts = { nodes: +arg('nodes', 5000), scanNodes: +arg('scan-nodes', 100), shortlist: +arg('shortlist', 6),
    pnsNodes: +arg('pns-nodes', 30000), approxKomi: flag('approx-komi'), evalKomi: arg('eval-komi', 'calibrated'), refine: !!refineFrom, patch: !!patchFrom, refineNodes: +arg('refine-nodes', 50000), deepNodes: +arg('deep-nodes', 1000000), rawDb: fs.existsSync(RAW_DB) ? RAW_DB : null };
  if (!opts.rawDb) console.error(`no ${RAW_DB}: pre2/pre4 will be null`);

  // inputs: every puzzle file except unlicensed Jaffray positions and local scratch
  // --input a.jsonl,b.jsonl scores other puzzle files (e.g. data/mined/*, not yet served) instead
  const dir = ROOT + 'data/puzzles/';
  const files = arg('input') ? String(arg('input')).split(',').map((f) => path.resolve(f))
    : fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !/^(deep-jaffray|puzzles-local)/.test(f)).sort().map((f) => dir + f);
  const seen = new Set(); let all = [];
  for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const p = JSON.parse(l);
    if (seen.has(p.id) || !sizes.includes(p.size)) continue;
    seen.add(p.id);
    all.push({ id: p.id, size: p.size, komi: p.komi || 0, plies: p.plies, tps: p.tps, tree: p.tree,
      prevTps: p.meta?.prevTps || null, gameId: p.meta?.gameId || null, ply: p.meta?.ply || null });
  }
  if (refineFrom) {
    const prev = new Map();
    for (const l of fs.readFileSync(refineFrom, 'utf8').split('\n')) if (l.trim()) { const r = JSON.parse(l); prev.set(r.id, r); }
    all = all.filter((p) => prev.has(p.id));
    for (const p of all) p.prev = prev.get(p.id);
    console.error(`refining ${all.length} rows of ${refineFrom}`);
  }
  const idsArg = arg('ids');
  if (idsArg) {
    const want = new Set((fs.existsSync(idsArg) ? fs.readFileSync(idsArg, 'utf8') : idsArg).split(/[\s,]+/).filter(Boolean));
    all = all.filter((p) => want.has(p.id));
  }
  if (arg('sample')) { // seeded shuffle (mulberry32), then the first N
    let s = +arg('seed', 1) >>> 0;
    const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    all = all.slice(0, +arg('sample'));
  }

  // resume: drop a torn last line, keep finished ids (minus retryable failures with --retry)
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const done = new Set();
  if (fs.existsSync(out)) {
    const keep = [];
    for (const l of fs.readFileSync(out, 'utf8').split('\n')) {
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (flag('retry') && r.turn == null && RETRYABLE.has(r.reason)) continue;
      done.add(r.id); keep.push(l);
    }
    fs.writeFileSync(out, keep.length ? keep.join('\n') + '\n' : '');
  }
  const todo = all.filter((p) => !done.has(p.id));
  const fd = fs.openSync(out, 'a');
  const counts = { 1: 0, 0: 0, null: 0 };
  const write = (r) => { fs.writeSync(fd, JSON.stringify(r) + '\n'); counts[r.turn]++; };

  // sizes Tiltak can't play: a null row, no worker needed
  const jobs = [];
  for (const p of todo) if ([4, 5, 6].includes(p.size)) jobs.push(p);
    else write(p.prev ? { ...p.prev, v: V } : { id: p.id, size: p.size, plies: p.plies, turn: null, reason: 'size', ms: 0 });
  console.error(`${all.length} puzzles (${files.join(', ')}); ${done.size} already in ${out}; ${jobs.length} to score; ${threads} threads, ` +
    `tiltak ${opts.nodes} nodes (scan ${opts.scanNodes} × all, top ${opts.shortlist}), pns ${opts.pnsNodes}, timeout ${timeoutMs} ms`);

  const t0 = Date.now(); let next = 0, finished = 0, alive = 0, initFails = 0;
  const tick = () => {
    if (++finished % every && finished !== jobs.length) return;
    const s = (Date.now() - t0) / 1000, eta = ((jobs.length - finished) * s) / finished;
    console.error(`${finished}/${jobs.length}  ${s.toFixed(0)}s  ${(s / finished).toFixed(2)} s/puzzle  eta ${(eta / 60).toFixed(0)} min  turn 1/0/null ${counts[1]}/${counts[0]}/${counts.null}`);
  };
  const nullRow = (p, reason, err) => p.prev
    // refine failed: keep the first pass but never as a turning point (it wasn't confirmed)
    ? { ...p.prev, v: V, turn: p.prev.turn === 1 ? 0 : p.prev.turn, refineFail: reason, ...(err ? { err } : {}) }
    : { id: p.id, size: p.size, plies: p.plies, turn: null, reason, ...(err ? { err } : {}), ms: timeoutMs };

  await new Promise((resolve, reject) => {
    // Every worker, replacements included, says {ready} after loading Tiltak and is fed from that message;
    // a worker that exits for any reason is replaced while jobs remain, so the pool can't stall.
    const launch = () => {
      const S = { job: null, timer: null, reason: null, err: null, ready: false, dying: false };
      S.w = new Worker(fileURLToPath(import.meta.url), { workerData: opts, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
      alive++;
      // terminate() is async: a result can still arrive before 'exit', and must not be answered with a new job
      // (that job would be written off as a crash)
      const kill = (reason) => { S.reason = reason; S.dying = true; S.w.terminate(); };
      // init gets its own, longer limit: loading Tiltak on a loaded box can outlast a small --timeout-ms
      S.timer = setTimeout(() => kill('init-timeout'), Math.max(timeoutMs, 120000));
      const feed = () => {
        clearTimeout(S.timer);
        if (next >= jobs.length) { S.job = null; kill('idle'); return; }
        S.job = jobs[next++]; S.reason = null; S.err = null;
        S.timer = setTimeout(() => kill('timeout'), timeoutMs);
        S.w.postMessage(S.job);
      };
      S.w.on('message', (m) => {
        if (m.ready) { if (S.dying) return; S.ready = true; initFails = 0; return feed(); }
        clearTimeout(S.timer); S.job = null;
        const dead = m.dead; delete m.dead;
        write(m); tick();
        if (S.dying) return;
        if (dead) kill('tiltak'); else feed(); // a panicked Tiltak can't be trusted again: fresh worker
      });
      S.w.on('error', (e) => { S.err = String(e?.message || e).slice(0, 200); });
      S.w.on('exit', () => {
        clearTimeout(S.timer); alive--;
        if (S.job) { write(nullRow(S.job, S.reason === 'timeout' ? 'timeout' : 'crash', S.err)); S.job = null; tick(); }
        if (!S.ready && ++initFails > 5) return reject(new Error('workers keep failing to start: ' + (S.err || S.reason)));
        if (next < jobs.length) launch();
        else if (alive === 0) resolve();
      });
    };
    if (!jobs.length) return resolve();
    for (let i = 0; i < Math.min(threads, jobs.length); i++) launch();
  });
  fs.closeSync(fd);
  console.error(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${out}  turn 1/0/null ${counts[1]}/${counts[0]}/${counts.null}`);
} else {
  const { Game } = await import('../shared/tak.js');
  const { ptnFromServer } = await import('../shared/ptn.js');
  const { TinueSearch, threatMoves } = await import('../shared/pns.js');
  const { Solver } = await import('../shared/tak.js');
  const { Tiltak } = await import('./tiltak-node.mjs');
  const { nodes, scanNodes, shortlist, pnsNodes, approxKomi, evalKomi, rawDb, refine, patch, refineNodes, deepNodes } = workerData;
  let q = null;
  if (rawDb) { const { DatabaseSync } = await import('node:sqlite'); q = new DatabaseSync(rawDb, { readOnly: true }).prepare('SELECT notation, komi FROM games WHERE id = ?'); }
  const tiltak = await Tiltak.create();
  parentPort.postMessage({ ready: true });

  const cpu = () => { const u = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; };
  class TiltakDead extends Error {}
  // attacker p at `tps`; Tiltak scores from the side to move
  const ev = async (tps, size, komi, att, n = nodes) => {
    let r;
    try { r = await tiltak.evaluate({ tps, size, komi, nodes: n }); } catch (e) { throw new TiltakDead(e.message); }
    if (r.pStm == null) return null;
    return +tps.trim().split(/\s+/)[1] === att ? r.pStm : 1 - r.pStm;
  };
  // df-pn from a defender-to-move position: does every defender move lose to a tinuë?
  const allLose = (tps, komi, att) => {
    const s = new TinueSearch(Game.fromTPS(tps, komi), { maxNodes: pnsNodes });
    s.att = att;
    try { return s.solve(Infinity) ? 'proved' : 'disproved'; } catch (e) { if (e.message === 'budget') return 'unknown'; throw e; }
  };

  // df-pn on a defender-to-move position; full = every defender move considered (no pruning)
  const dfpn = (g, att, n, full = false) => {
    const s = new TinueSearch(g.clone(), { maxNodes: n, fullDefense: full }); s.att = att;
    try { return s.solve(Infinity) ? 'proved' : 'disproved'; } catch (e) { if (e.message === 'budget') return 'unknown'; throw e; }
  };
  // Non-tree first moves that also force a win (threat moves only, so a lower bound), each confirmed with full defense.
  const hiddenWins = (g, att, wins) => {
    const alts = []; let unk = 0;
    for (const mv of threatMoves(g)) {
      const m = g.moveToPTN(mv);
      if (wins.has(m)) continue;
      const u = g.apply(mv), res = g.result(), h = res ? null : g.clone();
      g.undo(u);
      if (!h) continue;
      let r = dfpn(h, att, pnsNodes);
      if (r === 'proved' && dfpn(h, att, 10 * pnsNodes, true) !== 'proved') r = 'unknown';
      if (r === 'proved') alts.push(m); else if (r === 'unknown') unk++;
    }
    return { alts, unk };
  };
  // Exact: does the loser have a move at prevTps after which the attacker has no forced win (within `hor` plies by
  // exhaustive search, or any length by df-pn confirmed with full defense)? true / false / null (undecided)
  const escapes = (tps, komi, att, hor) => {
    const g = Game.fromTPS(tps, komi); let undecided = false;
    for (const mv of g.legalMoves()) {
      const u = g.apply(mv), res = g.result();
      let lost;
      if (res) lost = res.winner === att;
      else {
        const h = g.clone();
        try { const s = new Solver(h.clone(), { maxNodes: 1e6 }); lost = false; for (let d = 1; d <= hor && !lost; d += 2) lost = s.winIn(d); }
        catch { lost = null; }
        if (lost === false) { const d = dfpn(h, att, pnsNodes); if (d !== 'disproved') lost = d === 'proved' && dfpn(h, att, 10 * pnsNodes, true) === 'proved' ? true : null; }
      }
      g.undo(u);
      if (lost === false) return true;
      if (lost == null) undecided = true;
    }
    return undecided ? null : false;
  };

  const refineOne = async (p) => {
    const o = { ...p.prev, v: 2 };
    delete o.ms; delete o.cpu;
    const kt = evalKomi === 'game' ? (p.komi < 1 ? 0 : 2) : 2;
    const g = Game.fromTPS(p.tps, p.komi), att = g.toMove;
    const wins = new Set(p.tree && typeof p.tree === 'object' ? Object.keys(p.tree).map((k) => g.canon(k)) : []);
    if (p.plies >= 3) { const h = hiddenWins(g, att, wins); o.alts = h.alts; if (h.unk) o.altsUnk = h.unk; }
    const cand = o.pre0 != null && o.pre0 <= PRE0_MAX && o.lostBefore !== 'proved' && p.prevTps;
    if (cand) {
      o.pre0k5 = o.pre0; o.pre0 = r3(await ev(p.prevTps, p.size, kt, att, refineNodes));
      const kids = []; let best = null;
      for (const mv of g.legalMoves()) {
        const m = g.moveToPTN(mv);
        if (wins.has(m)) continue;
        const u = g.apply(mv), res = g.result(), tps = g.toTPS();
        g.undo(u);
        if (res?.winner === att) continue;
        if (res) { const v = res.winner === 0 ? 0.5 : 0; if (!best || v > best.v) best = { v, m }; continue; }
        kids.push({ m, tps, v: (await ev(tps, p.size, kt, att, nodes)) ?? 0 });
      }
      kids.sort((a, b) => b.v - a.v);
      for (const k of kids.slice(0, 3)) k.v = (await ev(k.tps, p.size, kt, att, refineNodes)) ?? k.v;
      for (const k of kids) if (!best || k.v > best.v) best = k;
      o.altk5 = o.alt; o.alt = best ? r3(best.v) : null; o.altMove = best?.m ?? null; o.altN = kids.length;
      if (p.size === 4 || (p.size === 5 && p.plies >= 3)) o.esc = escapes(p.prevTps, p.komi, att, Math.min(5, p.plies + 2));
    }
    if (o.pre0 == null) o.turn = null;
    else o.turn = cand && o.pre0 <= 0.5 && o.esc !== false && (o.alt == null || o.alt < (p.plies === 1 ? 0.70 : 0.65)) && !o.alts?.length ? 1 : 0;
    return o;
  };

  // Exact: quiet (non-threat) first moves outside `skip` that win within plies + 2. Budgeted; a budget hit is skipped.
  const quietWins = (g, att, plies, skip) => {
    const threats = new Set(threatMoves(g).map((mv) => g.moveToPTN(mv))), out = [];
    for (const mv of g.legalMoves()) {
      const m = g.moveToPTN(mv);
      if (skip.has(m) || threats.has(m)) continue;
      const u = g.apply(mv), res = g.result();
      let won = false;
      if (!res) { try { won = new Solver(g.clone(), { maxNodes: 3e5 }).allLose(plies + 1); } catch { won = false; } }
      g.undo(u);
      if (won) out.push(m);
    }
    return out;
  };
  // Attacker nodes below the root with ≥ 3 plies left, as [path, node object, position] (tree: {move: {r, n}}),
  // in tree order, at most LATER_CAP (deep.js trees reach 300 attacker nodes; the rest stay unchecked).
  const LATER_CAP = 40;
  const laterNodes = (g0, tree, left) => {
    const out = [];
    const walk = (g, node, pathMoves, left) => {
      for (const [m, { r, n }] of Object.entries(node)) {
        if (out.length >= LATER_CAP) return;
        if (!n || n === 'win' || left - 2 < 3 || !r) continue;
        const h = g.clone(); h.play(m); h.play(r);
        out.push([[...pathMoves, m, r], n, h]);
        walk(h, n, [...pathMoves, m, r], left - 2);
      }
    };
    walk(g0, tree, [], left);
    return out;
  };
  const nearFlat = (g) => Math.min(g.stones[1] + g.caps[1], g.stones[2] + g.caps[2]) <= 4 || g.toTPS().split(' ')[0].split(/[\/,]/).reduce((t, c) => t + (c === 'x' ? 1 : /^x\d$/.test(c) ? +c[1] : 0), 0) <= 3;

  const patchOne = async (p) => {
    const o = { ...p.prev, v: 3 };
    delete o.ms; delete o.cpu;
    const g = Game.fromTPS(p.tps, p.komi), att = g.toMove;
    const tree = p.tree && typeof p.tree === 'object' ? p.tree : {};
    const wins = new Set(Object.keys(tree).map((k) => g.canon(k)));
    // slower wins deeper in the tree: 5-ply only. In deep (7+) lines nearly every move still wins, so the lists explode
    // (one 7-ply puzzle: ~70 moves, 400 s); the client proves an off-tree move live instead (engine 'still').
    if (p.plies === 5) {
      const at = {};
      const later = laterNodes(g, tree, p.plies);
      if (later.length >= LATER_CAP) o.altsAtCapped = true;
      for (const [pm, n, h] of later) {
        const nw = new Set(Object.keys(n).map((k) => h.canon(k)));
        const { alts, unk } = hiddenWins(h, att, nw);
        if (alts.length) at[pm.join(' ')] = alts;
        if (unk) o.altsAtUnk = (o.altsAtUnk || 0) + unk;
      }
      if (Object.keys(at).length) o.altsAt = at;
    }
    // quiet slower first moves (cheap boards only)
    if (p.plies >= 3 && (p.size === 4 || (p.size === 5 && p.plies === 3))) {
      const q = quietWins(g, att, p.plies, new Set([...wins, ...(o.alts || [])]));
      if (q.length) { o.alts = [...(o.alts || []), ...q]; o.altsQuiet = q; }
    }
    if (p.prev.turn !== 1) return o;
    // turning points: re-check what the second adversarial pass found wanting
    if (p.plies === 1) { const h = hiddenWins(g, att, wins); if (h.alts.length) o.slow1 = h.alts; }
    const pg = Game.fromTPS(p.prevTps, p.komi), flat = nearFlat(pg);
    const kids = [];
    for (const mv of g.legalMoves()) {
      const m = g.moveToPTN(mv);
      if (wins.has(m)) continue;
      const u = g.apply(mv), res = g.result(), tps = g.toTPS();
      g.undo(u);
      if (res) continue; // immediate results were already in alt
      kids.push({ m, tps });
    }
    const scan = async (komi) => { for (const k of kids) k.s = (await ev(k.tps, p.size, komi, att, nodes)) ?? 0; kids.sort((a, b) => b.s - a.s); };
    let pre0 = o.pre0, alt = o.alt ?? 0;
    if (p.komi === 0 && flat) {
      o.pre0k0 = r3(await ev(p.prevTps, p.size, 0, att, refineNodes));
      await scan(0);
      let a = 0; for (const k of kids.slice(0, 3)) a = Math.max(a, (await ev(k.tps, p.size, 0, att, refineNodes)) ?? 0);
      o.altk0 = r3(a);
      pre0 = Math.max(pre0, o.pre0k0 ?? 0); alt = Math.max(alt, a);
    }
    if (p.size === 4 || (p.size === 5 && flat)) o.esc = escapes(p.prevTps, p.komi, att, 5);
    const altMax = p.plies === 1 ? 0.70 : 0.65;
    if (o.pre0 > 0.4 || (o.alt ?? 0) >= 0.55) {
      o.pre0Deep = r3(await ev(p.prevTps, p.size, 2, att, deepNodes));
      await scan(2);
      let a = 0; for (const k of kids.slice(0, 5)) a = Math.max(a, (await ev(k.tps, p.size, 2, att, deepNodes)) ?? 0);
      o.altDeep = r3(a);
      pre0 = Math.max(pre0, o.pre0Deep ?? 0); alt = Math.max(alt, a);
    }
    o.turn = pre0 <= 0.5 && o.esc !== false && alt < altMax && !o.alts?.length && !o.slow1?.length ? 1 : 0;
    if (!o.turn) o.demoted = [pre0 > 0.5 && 'pre0', o.esc === false && 'esc', alt >= altMax && 'alt', o.alts?.length && 'alts', o.slow1?.length && 'slow1'].filter(Boolean);
    return o;
  };

  parentPort.on('message', async (p) => {
    const w0 = performance.now(), c0 = cpu();
    if (refine) {
      let o, dead = false;
      try { o = await (patch ? patchOne(p) : refineOne(p)); }
      catch (e) {
        dead = e instanceof TiltakDead;
        o = { ...p.prev, v: patch ? 3 : 2, turn: p.prev.turn === 1 ? 0 : p.prev.turn, refineFail: dead ? 'tiltak' : 'error', err: String(e?.stack || e).slice(0, 300) };
      }
      o.ms = Math.round(performance.now() - w0); o.cpu = Math.round(cpu() - c0);
      return parentPort.postMessage(dead ? { ...o, dead } : o);
    }
    const o = { id: p.id, size: p.size, plies: p.plies, pre0: null, pre2: null, pre4: null, puz: null, lostBefore: null, alt: null, altMove: null, turn: null };
    let dead = false;
    try {
      // Tiltak only knows komi 0 / 2. 'calibrated' (default) evaluates everything at 2: at komi 0 Tiltak gives
      // white ~0.87 from the opening while white really scores ~0.60 in these games, which made pre0 ≤ 0.6
      // nearly automatic for black attackers and rare for white ones. Komi 2 is much closer to real results.
      // Proofs (lostBefore, altTinue) always use the game's real komi.
      const kt = evalKomi === 'game' ? (p.komi < 1 ? 0 : 2) : 2;
      if (kt !== p.komi) o.komiUsed = kt;
      const g = Game.fromTPS(p.tps, p.komi), att = g.toMove;

      // pre2/pre4 need the game: replay it and check it lands on prevTps/tps
      let hist = null;
      const row = q && p.gameId && p.ply && p.prevTps ? q.get(p.gameId) : null;
      if (row) {
        try { // optional extras: a game that won't replay costs pre2/pre4, not the puzzle
          const h = new Game(p.size);
          hist = [h.toTPS()];
          for (const m of row.notation.split(',')) { h.play(ptnFromServer(m)); hist.push(h.toTPS()); }
        } catch { hist = []; }
        if (hist[p.ply] !== p.tps || hist[p.ply - 1] !== p.prevTps) { o.replayOk = false; hist = null; }
      }
      if (p.prevTps) o.pre0 = r3(await ev(p.prevTps, p.size, kt, att));
      if (hist && p.ply - 3 >= 1) o.pre2 = r3(await ev(hist[p.ply - 3], p.size, kt, att));
      if (hist && p.ply - 5 >= 1) o.pre4 = r3(await ev(hist[p.ply - 5], p.size, kt, att));
      o.puz = r3(await ev(p.tps, p.size, kt, att));
      if (p.prevTps && pnsNodes) o.lostBefore = allLose(p.prevTps, p.komi, att);

      // a2: best non-winning first move. Tiltak can't exclude moves, so evaluate children directly.
      const wins = new Set(p.tree && typeof p.tree === 'object' ? Object.keys(p.tree).map((k) => g.canon(k)) : []);
      let best = null; const kids = [];
      for (const mv of g.legalMoves()) {
        const m = g.moveToPTN(mv);
        if (wins.has(m)) continue;
        const u = g.apply(mv), res = g.result(), tps = g.toTPS();
        g.undo(u);
        if (res?.winner === att) continue; // immediate win (road, or flats) counts as winning
        if (res) { const v = res.winner === 0 ? 0.5 : 0; if (!best || v > best.v) best = { v, m }; continue; }
        kids.push({ m, tps });
      }
      if (kids.length > shortlist) {
        for (const k of kids) k.s = (await ev(k.tps, p.size, kt, att, scanNodes)) ?? 0;
        kids.sort((a, b) => b.s - a.s);
      }
      const cands = best ? [best] : [];
      for (const k of kids.slice(0, shortlist)) {
        const v = await ev(k.tps, p.size, kt, att);
        if (v != null) cands.push({ v, m: k.m, tps: k.tps });
      }
      cands.sort((a, b) => b.v - a.v); best = cands[0];
      o.altN = kids.length;
      if (best) { o.alt = r3(best.v); o.altMove = best.m; }
      // Often the "alternative" is just a slower tinuë (the tree only lists wins within `plies`). Where it could
      // decide turn (pre0 ≤ 0.75, alt ≥ 0.65), prove the high candidates: altTinue = verdict on altMove,
      // altNT = best candidate that is NOT a proven tinuë (null if every candidate ≥ 0.65 is one).
      if (best && best.v >= ALT_MAX && o.pre0 != null && o.pre0 <= 0.75 && pnsNodes) {
        o.altNT = null; o.altNTMove = null;
        for (const c of cands) {
          const t = c.v < ALT_MAX || !c.tps ? null : allLose(c.tps, p.komi, att);
          if (c === best) o.altTinue = t;
          if (t !== 'proved') { o.altNT = r3(c.v); o.altNTMove = c.m; break; }
        }
      }

      if (o.pre0 == null) o.reason = p.prevTps ? 'noeval' : 'noprev';
      else if (evalKomi === 'game' && kt !== p.komi && !approxKomi) o.reason = 'komi';
      else o.turn = o.pre0 <= PRE0_MAX && o.lostBefore !== 'proved' && (o.alt == null || o.alt < ALT_MAX) ? 1 : 0;
    } catch (e) {
      o.turn = null;
      if (e instanceof TiltakDead) { o.reason = 'tiltak'; dead = true; } else o.reason = 'error';
      o.err = String(e?.stack || e).slice(0, 300);
    }
    o.ms = Math.round(performance.now() - w0); o.cpu = Math.round(cpu() - c0);
    parentPort.postMessage(dead ? { ...o, dead } : o);
  });
}
