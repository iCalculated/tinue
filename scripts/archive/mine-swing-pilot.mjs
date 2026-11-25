// Pilot of memo option b (docs/mining-options.md): lichess-style forward scan of whole games for tinuës
// that TURN the game. Measures yield/quality/cost before anyone commits a full run.
//
// Per game (sizes 5/6, rated, swap, default pieces, non-guest, both players ≥ --min-rating):
//   1. replay (shared/tak.js) and Tiltak-evaluate every position at --nodes (5k);
//   2. candidate i (solver S to move, right after the opponent's move) when the attacker was ≤ 0.6
//      before it (pre0 = 1 − p_stm(i−1)) and either
//        A: S's p jumped ≥ +0.30 (p_stm(i) − pre0), or
//        B: the loser's p dropped ≥ 0.30 from i−1 to i+1 (Tiltak blind at i; let the prover decide);
//   3. prove: df-pn shortestTinue (threat model, ≤15) → analyze.js (exact ≤5, incl. quiet wins) or
//      deep.js (7+, bounded); --quiet-nodes N adds a brute-force ≤5 check when df-pn finds nothing (off:
//      in the first pilot it found 2 of 169 proofs for ~40% of all CPU);
//   4. lostBefore (df-pn at pre0, loser to move), alt (Tiltak over every non-winning first move at
//      --alt-scan nodes, then the top --alt-k at --nodes; max attacker p), turn per the memo;
//   5. one puzzle per game: the first turn=1 candidate, else the first proven one (turn=0).
//
//   node --no-warnings scripts/archive/mine-swing-pilot.mjs [--road 1000] [--nonroad 1000] [--threads 4]
//        [--minutes 40] [--out <dir>] [--humans (no bot players)]          (resumable: games already in <dir>/pilot-games.jsonl are skipped)
//   node --no-warnings scripts/archive/mine-swing-pilot.mjs --report [--out <dir>]   (markdown summary)
import fs from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', 'mining');
const GAMES = `${OUT}/pilot-games.jsonl`, PUZ = `${OUT}/pilot-puzzles.jsonl`;
const NONROAD = { 'F-0': 'flat', '0-F': 'flat', '1-0': 'resign/time', '0-1': 'resign/time', '1/2-1/2': 'draw' };

if (isMainThread && process.argv.includes('--report')) await report();
else if (isMainThread) await main();
else await worker();

async function main() {
  const threads = Math.min(4, +arg('threads', 4)); // shared laptop: never more than 4
  const minutes = +arg('minutes', 40);
  const db = new DatabaseSync(`${ROOT}data/raw/games_anon.db`, { readOnly: true });
  // mine-playtak.mjs's filters (any result) + both players ≥ min-rating; hash order spreads the sample over all years
  const pick = (where, n) => db.prepare(`SELECT id, date, size, player_white, player_black, notation, result, komi, rating_white, rating_black
    FROM games WHERE ${where} AND notation != '' AND unrated = 0 AND opening = 'swap'
      AND pieces IN (-1, CASE size WHEN 5 THEN 21 ELSE 30 END) AND capstones IN (-1, 1)
      AND player_white NOT LIKE 'Guest%' AND player_black NOT LIKE 'Guest%'
      AND size IN (5, 6) AND MIN(rating_white, rating_black) >= ? ${process.argv.includes('--humans') ? "AND player_white NOT LIKE '%bot%' AND player_black NOT LIKE '%bot%'" : ''}
    ORDER BY (id * 2654435761) % 1000003 LIMIT ?`).all(+arg('min-rating', 1500), n);
  const road = pick(`result IN ('R-0','0-R')`, +arg('road', 1000)).map((r) => ({ ...r, bucket: 'road' }));
  const non = pick(`result IN ('F-0','0-F','1-0','0-1','1/2-1/2')`, +arg('nonroad', 1000)).map((r) => ({ ...r, bucket: 'nonroad' }));
  const done = new Set();
  if (fs.existsSync(GAMES)) for (const l of fs.readFileSync(GAMES, 'utf8').split('\n')) if (l) done.add(JSON.parse(l).gameId);
  const jobs = [];
  for (let i = 0; i < Math.max(road.length, non.length); i++) for (const r of [non[i], road[i]]) if (r && !done.has(r.id)) jobs.push(r); // interleaved: a time cap keeps both buckets
  console.error(`${jobs.length} games (${done.size} done), ${threads} threads, cap ${minutes} min → ${OUT}`);
  const gfd = fs.openSync(GAMES, 'a'), pfd = fs.openSync(PUZ, 'a');
  const opts = { nodes: +arg('nodes', 5000), pnsNodes: +arg('pns-nodes', 3e4), quietNodes: +arg('quiet-nodes', 0), altScan: +arg('alt-scan', 200),
    altK: +arg('alt-k', 5), maxCands: +arg('max-cands', 8), gameMs: +arg('game-ms', 120e3), deep: !process.argv.includes('--no-deep') };
  const t0 = Date.now(); let next = 0, fin = 0, puz = 0, turn = 0;
  await new Promise((resolve) => {
    let alive = 0;
    const spawn = () => {
      alive++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: opts });
      let cur = null, dead = false;
      const feed = () => {
        if (next < jobs.length && Date.now() - t0 < minutes * 60e3) { cur = jobs[next++]; w.postMessage(cur); }
        else { cur = null; w.terminate(); if (--alive === 0) resolve(); }
      };
      w.on('message', (m) => {
        if (m.ready) return feed();
        fin++; cur = null;
        fs.writeSync(gfd, JSON.stringify(m.game) + '\n');
        if (m.puzzle) { fs.writeSync(pfd, JSON.stringify(m.puzzle) + '\n'); puz++; turn += m.puzzle.meta.swing.turn; }
        if (fin % 25 === 0) console.error(`${fin}/${jobs.length} games, ${puz} puzzles (${turn} turning), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        feed();
      });
      w.on('error', (e) => { // OOM etc.: log the game as crashed, replace the worker
        if (dead) return; dead = true;
        console.error('worker error', cur?.id, e?.message || e);
        if (cur) { fin++; fs.writeSync(gfd, JSON.stringify({ gameId: cur.id, bucket: cur.bucket, result: cur.result, size: cur.size, error: 'crash: ' + (e?.message || e) }) + '\n'); }
        alive--;
        if (next < jobs.length) spawn(); else if (alive === 0) resolve();
      });
    };
    for (let i = 0; i < threads; i++) spawn();
  });
  console.error(`done: ${fin} games, ${puz} puzzles (${turn} turning) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

async function worker() {
  const { Game } = await import('../../shared/tak.js');
  const { ptnFromServer } = await import('../../shared/ptn.js');
  const { analyze, mateIn } = await import('../../shared/analyze.js');
  const { analyzeDeep } = await import('../../shared/deep.js');
  const { TinueSearch, shortestTinue } = await import('../../shared/pns.js');
  const { Tiltak } = await import('../tiltak-node.mjs');
  const O = workerData;
  const cpu = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
  let tiltak = await Tiltak.create();
  parentPort.postMessage({ ready: true });

  // p for the side to move, or null (Tiltak panics on komi/size it can't do; recreate and move on)
  const ev = async (tps, size, komi, nodes) => {
    try { return (await tiltak.evaluate({ tps, size, komi, nodes })); }
    catch (e) { tiltak = await Tiltak.create().catch(() => null); return null; }
  };

  parentPort.on('message', async (row) => {
    let out;
    try { out = await mine(row); } catch (e) { out = { game: { gameId: row.id, bucket: row.bucket, result: row.result, size: row.size, error: String(e?.stack || e).slice(0, 300) } }; }
    parentPort.postMessage(out);
  });

  async function mine(row) {
    const c0 = cpu(), w0 = Date.now();
    // Without this, ~60% of the first 4-thread run's komi-0 games were evaluated as komi 2 (komi state leaked
    // across games; not reproduced single-threaded). Force teinewgame + an explicit HalfKomi every game.
    if (tiltak) { tiltak.size = null; tiltak.halfKomi = -1; }
    const moves = row.notation.split(',').map(ptnFromServer);
    const komi = row.komi / 2, tk = komi < 1 ? 0 : 2; // Tiltak: komi 0 or 2 only (2.5/3 → 2, approximate)
    const g = new Game(row.size); g.komi = komi;
    const tps = [g.toTPS()], over = [false];
    for (const m of moves) { g.play(m); tps.push(g.toTPS()); over.push(!!g.result()); }
    const n = moves.length;
    const winner = /^(R|F|1)-0$/.test(row.result) ? 1 : /^0-(R|F|1)$/.test(row.result) ? 2 : 0;
    const game = { gameId: row.id, bucket: row.bucket, result: row.result, kind: NONROAD[row.result] || 'road', size: row.size, komi, tiltakKomi: tk,
      rw: row.rating_white, rb: row.rating_black, white: row.player_white, black: row.player_black, plies: n };

    // 1. Tiltak every position (p for side to move)
    const p = new Array(n + 1).fill(null);
    const ce = cpu();
    for (let i = 2; i <= n; i++) if (!over[i]) { const r = await ev(tps[i], row.size, tk, O.nodes); p[i] = r?.pStm ?? null; }
    game.evalCpu = Math.round(cpu() - ce); game.evals = p.filter((x) => x != null).length;
    game.p = p.map((x) => (x == null ? null : Math.round(x * 100) / 100));

    // 2. candidates
    const cands = [];
    for (let i = 3; i <= n; i++) {
      if (p[i] == null || p[i - 1] == null) continue;
      const pre0 = 1 - p[i - 1], jump = p[i] - pre0;
      const drop = p[i + 1] != null ? p[i - 1] - p[i + 1] : null;
      if (pre0 > 0.6) continue;
      const trig = (jump >= 0.3 ? 'A' : '') + (drop != null && drop >= 0.3 ? 'B' : '');
      if (trig) cands.push({ i, trig, pre0: r2(pre0), pS: r2(p[i]), drop: drop == null ? null : r2(drop) });
    }
    game.nCands = cands.length;

    // 3–5. prove in order; first turning point wins
    const tried = [];
    let best = null;
    const cp = cpu();
    for (const c of cands.slice(0, O.maxCands)) {
      if (Date.now() - w0 > O.gameMs) { game.timeout = true; break; }
      const t = await tryCand(c, row, moves, tps, komi, tk, winner);
      tried.push(t.rec);
      if (t.puzzle && !best) best = t;
      if (t.puzzle && t.rec.turn === 1) { if (best.rec.turn !== 1) best = t; break; }
    }
    game.proveCpu = Math.round(cpu() - cp);
    game.cands = tried;
    game.cpu = Math.round(cpu() - c0);
    game.puzzleIdx = best ? best.rec.i : null; game.turn = best ? best.rec.turn : null;
    return { game, puzzle: best?.puzzle || null };
  }

  async function tryCand(c, row, moves, tps, komi, tk, winner) {
    const { i } = c, rec = { ...c };
    const c0 = cpu();
    const g = Game.fromTPS(tps[i], komi), S = g.toMove;
    // threat-model df-pn first (cheap, finds deep ones); brute force decides ≤5 exactly
    const st = shortestTinue(g, 15, { maxNodes: O.pnsNodes, pv: false });
    rec.pns = st.result === 'proved' ? st.plies + (st.exact ? '' : '≤') : st.result;
    let a = null;
    if (st.result === 'proved' && st.plies <= 5) a = analyze(tps[i], { plies: st.plies, maxPlies: st.plies, line: moves.slice(i), komi, maxNodes: 1.5e7 });
    else if (st.result === 'proved' && st.exact) {
      if (O.deep) a = analyzeDeep(tps[i], { komi, line: moves.slice(i), maxPlies: 15, rootNodes: O.pnsNodes, totalNodes: 1e6, quietCheckNodes: 2e6, quietFinalNodes: 1e7, deadline: Date.now() + 60e3 });
      else a = { ok: false, reason: 'deep skipped' };
      if (!a.ok && /shallow \(quiet\)/.test(a.reason)) a = analyze(tps[i], { plies: a.quietPlies, maxPlies: 5, line: moves.slice(i), komi, maxNodes: 1.5e7 });
    } else if (O.quietNodes) {
      const q = mateIn(g, 5, O.quietNodes); // quiet tinuë the threat model can't see
      rec.quiet = q.plies;
      if (q.plies > 0) a = analyze(tps[i], { plies: q.plies, maxPlies: q.plies, line: moves.slice(i), komi, maxNodes: 1.5e7 });
    }
    rec.solveCpu = Math.round(cpu() - c0);
    if (!a?.ok) { rec.ok = false; rec.reason = a?.reason || (rec.pns === 'unknown' ? 'pns budget' : 'no tinue'); return { rec }; }
    rec.ok = true; rec.plies = a.plies; rec.rootWins = a.rootWins;
    const u = treeUniq(a.tree); rec.maxKeys = u.maxKeys; rec.uniqAll = u.uniq;
    const wins = new Set(a.tree === 'win' ? immediateWinPtns(g) : Object.keys(a.tree));
    try { rec.found = wins.has(g.canon(moves[i])); } catch { rec.found = false; }
    rec.wonGame = winner === S ? 1 : winner ? 0 : 0.5;

    // lostBefore at pre0 (loser to move): does every loser move still lose to a tinuë?
    const c1 = cpu();
    const s = new TinueSearch(Game.fromTPS(tps[i - 1], komi), { maxNodes: O.pnsNodes });
    s.att = S;
    try { rec.lostBefore = s.solve(Infinity) ? 'proved' : 'disproved'; }
    catch (e) { if (e.message === 'budget') rec.lostBefore = 'unknown'; else throw e; }
    rec.lostCpu = Math.round(cpu() - c1);

    // alt: attacker's best NON-winning first move. Scan every one cheaply, re-check the top few at full nodes.
    const c2 = cpu();
    const kids = [];
    for (const mv of g.legalMoves()) {
      const ptn = g.moveToPTN(mv);
      if (wins.has(ptn)) continue;
      const un = g.apply(mv); const res = g.result(); const ctps = g.toTPS(); g.undo(un);
      if (res) { kids.push({ ptn, pAtt: res.winner === S ? 1 : res.winner ? 0 : 0.5, final: true }); continue; }
      kids.push({ ptn, tps: ctps });
    }
    for (const k of kids.slice(0, 300)) if (!k.final) { const r = await ev(k.tps, row.size, tk, O.altScan); k.pAtt = r?.pStm == null ? null : 1 - r.pStm; }
    const ranked = kids.filter((k) => k.pAtt != null).sort((x, y) => y.pAtt - x.pAtt);
    let alt = null, altMove = null;
    for (const k of ranked.slice(0, O.altK)) {
      let pa = k.pAtt;
      if (!k.final) { const r = await ev(k.tps, row.size, tk, O.nodes); pa = r?.pStm == null ? null : 1 - r.pStm; }
      if (pa != null && (alt == null || pa > alt)) { alt = pa; altMove = k.ptn; }
    }
    rec.alt = alt == null ? null : r2(alt); rec.altMove = altMove; rec.altScanTop = ranked[0] ? r2(ranked[0].pAtt) : null; rec.nonWinning = kids.length;
    rec.altCpu = Math.round(cpu() - c2);
    rec.turn = c.pre0 <= 0.6 && rec.lostBefore !== 'proved' && (alt == null || alt < 0.65) ? 1 : 0;
    rec.cpu = Math.round(cpu() - c0);

    const puzzle = {
      id: 'ps' + row.id, size: row.size, tps: tps[i], komi, plies: a.plies, tree: a.tree, tags: a.tags, rating: a.rating,
      source: 'PlayTak', sourceRef: `https://api.playtak.com/v1/games-history/ptn/${row.id}`,
      meta: {
        gameId: row.id, date: row.date, white: row.player_white, black: row.player_black,
        ratingWhite: row.rating_white, ratingBlack: row.rating_black, ply: i,
        prevTps: tps[i - 1], lastMove: moves[i - 1], gameLine: moves.slice(i, i + a.plies),
        rootWins: a.rootWins, nodes: a.nodes, factors: a.factors, mainLine: a.mainLine, ...(a.prover ? { prover: a.prover, attNodes: a.attNodes } : {}),
        swing: { pre0: c.pre0, lostBefore: rec.lostBefore, alt: rec.alt, altMove, turn: rec.turn, trigger: c.trig, pS: c.pS,
          found: rec.found, wonGame: rec.wonGame, gameResult: row.result, nodes: O.nodes, ...(tk !== komi ? { tiltakKomi: tk } : {}) },
      },
    };
    return { rec, puzzle };
  }

  function immediateWinPtns(g) {
    const me = g.toMove, out = [];
    for (const m of g.legalMoves()) { const u = g.apply(m); const r = g.result(); g.undo(u); if (r && r.winner === me) out.push(g.moveToPTN(m)); }
    return out;
  }
}

const r2 = (x) => Math.round(x * 100) / 100;

// keys at every non-final attacker node of the solution tree (lichess: any alternative at any ply kills a mate line)
function treeUniq(t) {
  if (t === 'win') return { maxKeys: 1, uniq: true };
  let maxKeys = Object.keys(t).length, uniq = maxKeys === 1;
  for (const v of Object.values(t)) if (v && v.n !== 'win') { const u = treeUniq(v.n); maxKeys = Math.max(maxKeys, u.maxKeys); uniq &&= u.uniq; }
  return { maxKeys, uniq };
}

async function report() {
  const games = fs.readFileSync(GAMES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const puzzles = fs.existsSync(PUZ) ? fs.readFileSync(PUZ, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  // live set: data/puzzles/*.jsonl (+ the DB, in case it holds more) by TPS and by game; miner's processed games incl. skips
  const liveTps = new Set(), liveGame = new Map(), processed = new Set();
  for (const f of fs.readdirSync(`${ROOT}data/puzzles`)) {
    const txt = fs.readFileSync(`${ROOT}data/puzzles/${f}`, 'utf8');
    if (f.endsWith('.jsonl')) for (const l of txt.split('\n')) if (l) { const q = JSON.parse(l); liveTps.add(q.tps); if (q.meta?.gameId) { processed.add(q.meta.gameId); (liveGame.get(q.meta.gameId) || liveGame.set(q.meta.gameId, []).get(q.meta.gameId)).push(q); } }
    if (f.endsWith('.skipped')) for (const l of txt.split('\n')) if (l.trim()) processed.add(+l);
  }
  try { const d = new DatabaseSync(`${ROOT}data/tinue.db`, { readOnly: true }); for (const r of d.prepare('SELECT tps FROM puzzles').all()) liveTps.add(r.tps); } catch {}

  // --sim-live: re-run mine-playtak's pick (earliest winner-to-move forced win ≤5 plies in the last 5) on each road game
  let simLive = null;
  if (process.argv.includes('--sim-live')) {
    const { Game } = await import('../../shared/tak.js');
    const { mateIn } = await import('../../shared/analyze.js');
    const { ptnFromServer } = await import('../../shared/ptn.js');
    const raw = new DatabaseSync(`${ROOT}data/raw/games_anon.db`, { readOnly: true }).prepare('SELECT notation, komi, result FROM games WHERE id = ?');
    const memo = new Map();
    simLive = (q) => {
      if (memo.has(q.meta.gameId)) return memo.get(q.meta.gameId);
      const r = raw.get(q.meta.gameId), moves = r.notation.split(',').map(ptnFromServer), g = new Game(q.size); g.komi = r.komi / 2;
      const tps = [g.toTPS()]; for (const m of moves) { g.play(m); tps.push(g.toTPS()); }
      const winner = r.result === 'R-0' ? 1 : 2, n = moves.length;
      let pick = null;
      for (let u = 5; u >= 1 && pick == null; u -= 2) {
        const idx = n - u; if (idx < 2) continue;
        const pos = Game.fromTPS(tps[idx], r.komi / 2); if (pos.toMove !== winner) continue;
        const d = mateIn(pos, u, 4e6); if (d.plies > 0) pick = idx; else if (d.plies < 0) pick = -1;
      }
      memo.set(q.meta.gameId, pick); return pick;
    };
  }
  const L = [], pct =(a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '–'), per1k = (a, b) => (b ? (1000 * a / b).toFixed(0) : '–');
  const ok = games.filter((g) => !g.error);
  const pz = new Map(puzzles.map((q) => [q.meta.gameId, q]));
  const buckets = { road: ok.filter((g) => g.bucket === 'road'), nonroad: ok.filter((g) => g.bucket === 'nonroad') };
  for (const k of ['flat', 'resign/time', 'draw']) buckets['  ' + k] = ok.filter((g) => g.kind === k);
  L.push(`games: ${games.length} (${games.length - ok.length} errors), puzzles: ${puzzles.length}`);
  L.push('', '| bucket | games | cand/game | any tinuë proven | turn=1 | per 1k games (turn=1) | conversion only |', '|---|---|---|---|---|---|---|');
  for (const [k, gs] of Object.entries(buckets)) {
    const any = gs.filter((g) => g.puzzleIdx != null).length, t1 = gs.filter((g) => g.turn === 1).length;
    L.push(`| ${k} | ${gs.length} | ${(gs.reduce((s, g) => s + g.nCands, 0) / (gs.length || 1)).toFixed(1)} | ${any} (${pct(any, gs.length)}) | ${t1} (${pct(t1, gs.length)}) | ${per1k(t1, gs.length)} | ${any - t1} |`);
  }
  // candidate outcomes
  const cs = ok.flatMap((g) => g.cands || []);
  const tally = (xs, f) => { const m = {}; for (const x of xs) { const k = f(x); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', '); };
  L.push('', `candidates tried: ${cs.length} (of ${ok.reduce((s, g) => s + g.nCands, 0)} flagged); trigger ${tally(cs, (c) => c.trig)}`);
  L.push(`proved: ${cs.filter((c) => c.ok).length}; fail reasons: ${tally(cs.filter((c) => !c.ok), (c) => c.reason)}`);
  const pc = cs.filter((c) => c.ok);
  L.push(`proven candidates by trigger: ${tally(pc, (c) => c.trig)}; turn=1 by trigger: ${tally(pc.filter((c) => c.turn), (c) => c.trig)}`);
  L.push(`proven → why not turn: lostBefore proved ${pc.filter((c) => c.lostBefore === 'proved').length}, alt ≥ 0.65 ${pc.filter((c) => c.alt != null && c.alt >= 0.65).length}, both ${pc.filter((c) => c.lostBefore === 'proved' && c.alt >= 0.65).length}`);
  L.push(`lostBefore (proven cands): ${tally(pc, (c) => c.lostBefore)}; alt null: ${pc.filter((c) => c.alt == null).length}`);
  // puzzles (one per game)
  const P = puzzles.filter((q) => ok.some((g) => g.gameId === q.meta.gameId));
  for (const [lab, set] of [['turn=1', P.filter((q) => q.meta.swing.turn === 1)], ['turn=0', P.filter((q) => q.meta.swing.turn === 0)]]) {
    const b = (q) => ok.find((g) => g.gameId === q.meta.gameId);
    L.push('', `### ${lab} puzzles: ${set.length}`);
    L.push(`plies: ${tally(set, (q) => q.plies)}`);
    L.push(`rootWins: ${tally(set, (q) => (q.meta.rootWins >= 4 ? '4+' : q.meta.rootWins))}; unique at every attacker ply (lichess): ${set.filter((q) => treeUniq(q.tree).uniq).length}/${set.length}`);
    L.push(`by bucket: ${tally(set, (q) => b(q).kind)}; by size: ${tally(set, (q) => 's' + q.size)}`);
    L.push(`solver found it in the game: ${set.filter((q) => q.meta.swing.found).length}; solver's side won the game: ${set.filter((q) => q.meta.swing.wonGame === 1).length}, drew ${set.filter((q) => q.meta.swing.wonGame === 0.5).length}`);
    L.push(`pre0: ${tally(set, (q) => (q.meta.swing.pre0 < 0.3 ? '<0.3' : q.meta.swing.pre0 < 0.5 ? '0.3–0.5' : '0.5–0.6'))}; alt: ${tally(set, (q) => (q.meta.swing.alt == null ? 'null' : q.meta.swing.alt < 0.35 ? '<0.35' : q.meta.swing.alt < 0.5 ? '0.35–0.5' : q.meta.swing.alt < 0.65 ? '0.5–0.65' : '≥0.65'))}`);
    const isNew = set.filter((q) => !liveTps.has(q.tps)), sameGame = set.filter((q) => liveGame.has(q.meta.gameId));
    const proc = set.filter((q) => processed.has(q.meta.gameId));
    L.push(`NEW (TPS not live): ${isNew.length}/${set.length}; game already has a live puzzle: ${sameGame.length}; game was processed by mine-playtak: ${proc.length} (of which TPS identical: ${proc.filter((q) => liveTps.has(q.tps)).length})`);
    L.push(`bot involved: ${set.filter((q) => /bot/i.test(q.meta.white + q.meta.black)).length}; rating median ${median(set.map((q) => q.rating))}`);
    // road games: would the end-walking miners have reached this position? (mine-playtak: last 5 plies, mine-deep: last 15)
    const rd = set.filter((q) => b(q).bucket === 'road'), back = (q) => b(q).plies - q.meta.ply;
    L.push(`road puzzles by distance from game end: ≤5 plies ${rd.filter((q) => back(q) <= 5).length}, 6–15 ${rd.filter((q) => back(q) > 5 && back(q) <= 15).length}, >15 ${rd.filter((q) => back(q) > 15).length}`);
    if (simLive) { const same = rd.filter((q) => simLive(q) === q.meta.ply).length; L.push(`road puzzles mine-playtak would also produce (same position, simulated): ${same}/${rd.length}`); }
    const att = (q) => +q.tps.trim().split(/\s+/)[1], bot = (s) => (/bot/i.test(s) ? 'bot' : 'human');
    L.push(`attacker→loser: ${tally(set, (q) => bot(att(q) === 1 ? q.meta.white : q.meta.black) + '→' + bot(att(q) === 1 ? q.meta.black : q.meta.white))}; attacker colour×komi: ${tally(set, (q) => (att(q) === 1 ? 'W' : 'B') + ' k' + q.komi)}`);
    L.push(`trigger: ${tally(set,(q) => q.meta.swing.trigger)}; Tiltak p at puzzle (pS): ${tally(set, (q) => (q.meta.swing.pS >= 0.9 ? '≥0.9' : q.meta.swing.pS >= 0.6 ? '0.6–0.9' : '<0.6'))}`);
    L.push('', '| id | game | kind | size | plies | rootWins | pre0 | alt | found | won | back | tps |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const q of set.slice(0, +arg('examples', 40))) L.push(`| ${q.id} | ${q.meta.gameId} | ${b(q).kind} | ${q.size} | ${q.plies} | ${q.meta.rootWins} | ${q.meta.swing.pre0} | ${q.meta.swing.alt} | ${q.meta.swing.found ? 'y' : 'n'} | ${q.meta.swing.wonGame} | ${back(q)} | \`${q.tps}\` |`);
  }
  // Tiltak's view of the opening (white p, plies 2–12) by komi: at komi 0 it may call white "winning" from move 1
  const byK = {};
  for (const g of ok) for (let i = 2; i <= 12; i++) if (g.p?.[i] != null) (byK[g.komi] ||= []).push(i % 2 ? 1 - g.p[i] : g.p[i]);
  L.push('', `opening white p (plies 2–12) median by komi: ${Object.entries(byK).map(([k, xs]) => `k${k} ${median(xs)} (n=${xs.length})`).join(', ')}`);
  // sample games processed by the live miner
  const procGames = ok.filter((g) => processed.has(g.gameId));
  L.push('', `sampled games the live miner processed: ${procGames.length} (road ${procGames.filter((g) => g.bucket === 'road').length})`);
  // cost
  const sum = (f) => ok.reduce((s, g) => s + (f(g) || 0), 0);
  L.push('', `cost: ${(sum((g) => g.cpu) / ok.length / 1000).toFixed(2)} s CPU/game (Tiltak ${(sum((g) => g.evalCpu) / ok.length / 1000).toFixed(2)} s over ${(sum((g) => g.evals) / ok.length).toFixed(0)} evals = ${(sum((g) => g.evalCpu) / sum((g) => g.evals)).toFixed(1)} ms/eval; proving+alt ${(sum((g) => g.proveCpu) / ok.length / 1000).toFixed(2)} s)`);
  for (const k of ['road', 'nonroad']) { const gs = buckets[k]; L.push(`  ${k}: ${(gs.reduce((s, g) => s + g.cpu, 0) / gs.length / 1000).toFixed(2)} s/game, p90 ${(pctl(gs.map((g) => g.cpu), 0.9) / 1000).toFixed(1)} s, max ${(Math.max(...gs.map((g) => g.cpu)) / 1000).toFixed(0)} s, timeouts ${gs.filter((g) => g.timeout).length}`); }
  L.push(`per proven candidate: solve ${median(pc.map((c) => c.solveCpu))} ms, lostBefore ${median(pc.map((c) => c.lostCpu))} ms, alt ${median(pc.map((c) => c.altCpu))} ms (medians); failed cands solve median ${median(cs.filter((c) => !c.ok).map((c) => c.solveCpu))} ms`);
  console.log(L.join('\n'));
}
function median(xs) { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; }
function pctl(xs, q) { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] || 0; }
