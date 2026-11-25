// Mine DEEP puzzles (tinuë in 4+ moves = 7+ plies) with the df-pn prover (shared/deep.js).
//
//   node --no-warnings scripts/mine-deep.mjs [--source playtak] [--limit 150] [--size 5,6] [--threads 4]
//
// Source: PlayTak (the only one): rated, non-guest, default-pieces, swap-opening road wins (sizes 5/6 by default).
//   Walk back from the end over winner-to-move positions at undo = 7, 9, …, --max-undo (15), stopping
//   at the first position that is not a (threat-model) tinuë, and take the EARLIEST position whose
//   exact shortest tinuë is ≥ 7 plies — the moment the long tinuë appeared. id = 'pd' + gameId.
//
// Resumable: ids already in --out or --out.skipped are not redone. Per-position diagnostics (reason,
// CPU ms, tree size) go to --out.stats (JSON lines). Times are thread-CPU ms (wall time is noise on a busy box).
import fs from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const RAW_DB = 'data/raw/games_anon.db';

if (isMainThread) {
  const source = arg('source', 'playtak');
  if (source !== 'playtak') throw new Error('--source playtak (the only source)');
  const limit = +arg('limit', 150);
  const threads = Math.min(6, +arg('threads', 4));
  const out = arg('out', `data/puzzles/deep-${source}.jsonl`);
  const opts = {
    maxUndo: +arg('max-undo', 15), maxPlies: +arg('max-plies', 15),
    walkNodes: +arg('walk-nodes', 1e5), rootNodes: +arg('root-nodes', 2e5), maxNodes: +arg('nodes', 4e4),
    totalNodes: +arg('total-nodes', 2e6), maxTree: +arg('max-tree', 300), bruteNodes: +arg('brute-nodes', 1.5e7),
    quietCheckNodes: +arg('quiet-nodes', 3e6), quietFinalNodes: +arg('quiet-final-nodes', 3e7), deadlineMs: +arg('deadline', 30 * 60e3),
  };
  const done = new Set();
  if (fs.existsSync(out)) for (const l of fs.readFileSync(out, 'utf8').split('\n')) if (l) done.add(JSON.parse(l).id);
  const skipFile = out + '.skipped', statsFile = out + '.stats'; // not *.jsonl: import.mjs globs those
  if (fs.existsSync(skipFile)) for (const l of fs.readFileSync(skipFile, 'utf8').split('\n')) if (l) done.add(l.trim());

  const db = new DatabaseSync(arg('db', RAW_DB), { readOnly: true });
  const sizes = String(arg('size', '5,6')).split(',').map(Number).filter((n) => n >= 3 && n <= 8);
  const minRating = +arg('min-rating', 0);
  const jobs = db.prepare(`SELECT id, date, size, player_white, player_black, notation, result, komi, rating_white, rating_black
    FROM games WHERE result IN ('R-0','0-R') AND notation != '' AND unrated = 0 AND opening = 'swap'
      AND pieces IN (-1, CASE size WHEN 3 THEN 10 WHEN 4 THEN 15 WHEN 5 THEN 21 WHEN 6 THEN 30 WHEN 7 THEN 40 ELSE 50 END)
      AND capstones IN (-1, CASE size WHEN 3 THEN 0 WHEN 4 THEN 0 WHEN 5 THEN 1 WHEN 6 THEN 1 WHEN 7 THEN 2 ELSE 2 END)
      AND player_white NOT LIKE 'Guest%' AND player_black NOT LIKE 'Guest%'
      AND size IN (${sizes.join(',')}) AND MIN(rating_white, rating_black) >= ?
    ORDER BY id DESC LIMIT ?`).all(minRating, limit * 3 + done.size)
    .map((r) => ({ ...r, key: 'pd' + r.id })).filter((r) => !done.has(r.key)).slice(0, limit);
  console.error(`${source}: ${jobs.length} jobs, ${threads} threads (${done.size} already done) → ${out}`);
  const outFd = fs.openSync(out, 'a'), skipFd = fs.openSync(skipFile, 'a'), statFd = fs.openSync(statsFile, 'a');
  let next = 0, finished = 0, found = 0; const t0 = Date.now(), byPly = {};
  await new Promise((resolve) => {
    let alive = 0;
    // A worker that dies (e.g. out of memory on a huge proof) marks its job skipped — so a resumed run
    // doesn't hit it again — and is replaced, so a long run keeps all its threads.
    const spawn = () => {
      alive++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: opts });
      let cur = null, dead = false;
      const feed = () => {
        if (next < jobs.length) { cur = jobs[next++]; w.postMessage(cur); }
        else { cur = null; w.terminate(); if (--alive === 0) resolve(); }
      };
      w.on('message', (m) => {
        finished++; cur = null;
        fs.writeSync(statFd, JSON.stringify(m.stats) + '\n');
        if (m.puzzle) { fs.writeSync(outFd, JSON.stringify(m.puzzle) + '\n'); found++; byPly[m.puzzle.plies] = (byPly[m.puzzle.plies] || 0) + 1; }
        else fs.writeSync(skipFd, m.key + '\n');
        if (finished % 10 === 0 || finished === jobs.length) console.error(`${finished}/${jobs.length}, ${found} puzzles ${JSON.stringify(byPly)}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        feed();
      });
      w.on('error', (e) => {
        if (dead) return; dead = true;
        console.error('worker error', cur?.key, e?.message || e);
        if (cur) { finished++; fs.writeSync(skipFd, cur.key + '\n'); fs.writeSync(statFd, JSON.stringify({ key: cur.key, reason: 'worker crash: ' + (e?.message || e) }) + '\n'); }
        alive--;
        if (next < jobs.length) spawn(); else if (alive === 0) resolve();
      });
      feed(); // first job; later ones go out as each result comes back
    };
    for (let i = 0; i < threads; i++) spawn();
  });
  console.error(`done: ${found} puzzles from ${finished} jobs in ${((Date.now() - t0) / 1000).toFixed(0)}s ${JSON.stringify(byPly)}`);
} else {
  const { Game } = await import('../shared/tak.js');
  const { ptnFromServer } = await import('../shared/ptn.js');
  const { shortestTinue } = await import('../shared/pns.js');
  const { analyzeDeep } = await import('../shared/deep.js');
  const O = workerData;
  const cpuMs = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
  const deepOpts = (komi, line) => ({
    komi, line, maxPlies: O.maxPlies, maxNodes: O.maxNodes, rootNodes: O.rootNodes, totalNodes: O.totalNodes,
    maxTree: O.maxTree, bruteNodes: O.bruteNodes, quietCheckNodes: O.quietCheckNodes, quietFinalNodes: O.quietFinalNodes, deadline: Date.now() + O.deadlineMs,
  });

  parentPort.on('message', (job) => {
    const c0 = cpuMs();
    let res;
    try { res = minePlaytak(job); }
    catch (e) { res = { puzzle: null, stats: { reason: 'error: ' + e.message } }; }
    res.stats = { key: job.key, cpuMs: Math.round(cpuMs() - c0), ...res.stats };
    parentPort.postMessage({ key: job.key, ...res });
  });

  const replayGame = (row) => {
    const moves = row.notation.split(',').map(ptnFromServer);
    const g = new Game(row.size); g.komi = row.komi / 2;
    const tps = [g.toTPS()];
    for (const m of moves) { g.play(m); tps.push(g.toTPS()); }
    return { moves, tps, g };
  };
  const gameMeta = (row, moves, tps, idx, plies) => ({
    gameId: row.id, date: row.date, white: row.player_white, black: row.player_black,
    ratingWhite: row.rating_white, ratingBlack: row.rating_black, ply: idx,
    prevTps: tps[idx - 1], lastMove: moves[idx - 1], gameLine: moves.slice(idx, idx + plies),
  });
  const deepMeta = (a) => ({ rootWins: a.rootWins, nodes: a.nodes, factors: a.factors, mainLine: a.mainLine, prover: 'pns', attNodes: a.attNodes });
  const statsOf = (a) => ({ ok: a.ok, reason: a.reason, plies: a.plies, attNodes: a.attNodes, nodes: a.nodes, quietPlies: a.quietPlies, cpu: a.cpu });

  function minePlaytak(row) {
    const { moves, tps, g } = replayGame(row);
    const komi = row.komi / 2;
    const res = g.result();
    const winner = row.result === 'R-0' ? 1 : 2;
    if (!res || res.kind !== 'road' || res.winner !== winner) return { puzzle: null, stats: { reason: 'not a road win' } };
    const n = moves.length;
    // walk back: earliest winner-to-move position with an exact shortest tinuë ≥ 7
    const walk = [], cands = [];
    for (let u = 7; u <= O.maxUndo; u += 2) {
      const idx = n - u;
      if (idx < 2) break;
      const pos = Game.fromTPS(tps[idx], komi);
      if (pos.toMove !== winner) break;
      const st = shortestTinue(pos, O.maxPlies, { maxNodes: O.walkNodes, pv: false });
      walk.push(st.result === 'proved' ? st.plies + (st.exact ? '' : '≤') : st.result[0]);
      if (st.result !== 'proved') break;
      if (st.exact && st.plies >= 7 && st.plies <= O.maxPlies) cands.unshift(idx); // earliest first
    }
    if (!cands.length) return { puzzle: null, stats: { reason: 'no deep tinue in walk', walk } };
    let a = null, idx = null;
    for (const c of cands.slice(0, 2)) {
      a = analyzeDeep(tps[c], deepOpts(komi, moves.slice(c)));
      if (a.ok) { idx = c; break; }
    }
    if (!a.ok) return { puzzle: null, stats: { walk, ...statsOf(a) } };
    return {
      puzzle: {
        id: 'pd' + row.id, size: row.size, tps: tps[idx], komi, plies: a.plies, tree: a.tree, tags: a.tags, rating: a.rating,
        source: 'PlayTak', sourceRef: `https://api.playtak.com/v1/games-history/ptn/${row.id}`,
        meta: { ...gameMeta(row, moves, tps, idx, a.plies), ...deepMeta(a) },
      },
      stats: { walk, undo: n - idx, ...statsOf(a) },
    };
  }
}
