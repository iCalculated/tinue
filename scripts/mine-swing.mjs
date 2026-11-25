// Option b (docs/mining-options.md §3b, piloted in docs/research/mine-swing-pilot.md): scan whole PlayTak games
// forward, lichess-style, for tinuës that TURN the game, including in flat wins, resigns, timeouts and draws,
// which no other miner looks at.
//
// Per game (sizes --sizes 5,6; rated, swap, default pieces, non-guest, both players ≥ --min-rating 1500; any result):
//   1. replay (shared/tak.js) and Tiltak-evaluate every position at --nodes (5k), at komi 2 (the "calibrated"
//      baseline score-swing uses: komi-0 Tiltak gives white ~0.87 from the opening);
//   2. candidate i (solver S to move, right after the opponent's move) when the attacker was ≤ 0.6 before it
//      (pre0 = 1 − p_stm(i−1)) and either A: S's p jumped ≥ +0.30, or B: the loser's p dropped ≥ 0.30 i−1 → i+1;
//   3. prove: df-pn shortestTinue (threat model, ≤15) → analyze.js (exact ≤5, quiet wins included) or deep.js (7+);
//   4. cheap screen (lostBefore by df-pn, alt over the top --alt-k moves): turn per the first-pass rule;
//   5. one puzzle per game: the first screened turn = 1 candidate, else the first proven one.
// The screen only picks the position: the real turn/alts come from score-swing's three passes over the output
// (--input), exactly as for the live set. Output is OUTSIDE data/puzzles/ so nothing is served unscored.
//
//   node --no-warnings scripts/mine-swing.mjs [--out data/mined] [--threads 4] [--sizes 5,6] [--min-rating 1500]
//        [--only road|nonroad] [--limit N] [--game-ms 120000]
// Order: non-road games first (every puzzle there is new), then road wins. Resumable: games in
// <out>/swing-games.jsonl are skipped. Puzzles: <out>/swing-playtak.jsonl (ids 'ps' + gameId, miner format).
import fs from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', `${ROOT}data/mined`);
const GAMES = `${OUT}/swing-games.jsonl`, PUZ = `${OUT}/swing-playtak.jsonl`;
const NONROAD = { 'F-0': 'flat', '0-F': 'flat', '1-0': 'resign/time', '0-1': 'resign/time', '1/2-1/2': 'draw' };

if (isMainThread) await main();
else await worker();

async function main() {
  const threads = Math.max(1, +arg('threads', 4));
  const sizes = String(arg('sizes', '5,6')).split(',').map(Number).filter((n) => [4, 5, 6].includes(n));
  fs.mkdirSync(OUT, { recursive: true });
  const db = new DatabaseSync(`${ROOT}data/raw/games_anon.db`, { readOnly: true });
  // mine-playtak.mjs's filters (any result) + both players ≥ min-rating
  const pick = (where) => db.prepare(`SELECT id, date, size, player_white, player_black, notation, result, komi, rating_white, rating_black
    FROM games WHERE ${where} AND notation != '' AND unrated = 0 AND opening = 'swap'
      AND pieces IN (-1, CASE size WHEN 4 THEN 15 WHEN 5 THEN 21 ELSE 30 END) AND capstones IN (-1, CASE size WHEN 4 THEN 0 ELSE 1 END)
      AND player_white NOT LIKE 'Guest%' AND player_black NOT LIKE 'Guest%'
      AND size IN (${sizes.join(',')}) AND MIN(rating_white, rating_black) >= ?
    ORDER BY id DESC`).all(+arg('min-rating', 1500));
  const only = arg('only');
  const non = only === 'road' ? [] : pick(`result IN ('F-0','0-F','1-0','0-1','1/2-1/2')`).map((r) => ({ ...r, bucket: 'nonroad' }));
  const road = only === 'nonroad' ? [] : pick(`result IN ('R-0','0-R')`).map((r) => ({ ...r, bucket: 'road' }));
  const done = new Set();
  if (fs.existsSync(GAMES)) {
    const keep = []; // drop a torn last line
    for (const l of fs.readFileSync(GAMES, 'utf8').split('\n')) { try { done.add(JSON.parse(l).gameId); keep.push(l); } catch {} }
    fs.writeFileSync(GAMES, keep.length ? keep.join('\n') + '\n' : '');
  }
  if (fs.existsSync(PUZ)) { // a puzzle whose game record didn't land is redone
    const keep = [];
    for (const l of fs.readFileSync(PUZ, 'utf8').split('\n')) { try { const q = JSON.parse(l); if (done.has(q.meta.gameId)) keep.push(l); } catch {} }
    fs.writeFileSync(PUZ, keep.length ? keep.join('\n') + '\n' : '');
  }
  let jobs = [...non, ...road].filter((r) => !done.has(r.id));
  if (arg('limit')) jobs = jobs.slice(0, +arg('limit'));
  console.error(`${non.length} non-road + ${road.length} road games (sizes ${sizes}); ${done.size} done; ${jobs.length} to scan; ${threads} threads → ${OUT}`);
  const gfd = fs.openSync(GAMES, 'a'), pfd = fs.openSync(PUZ, 'a');
  const opts = { nodes: +arg('nodes', 5000), pnsNodes: +arg('pns-nodes', 3e4), altScan: +arg('alt-scan', 200),
    altK: +arg('alt-k', 5), maxCands: +arg('max-cands', 8), gameMs: +arg('game-ms', 120e3), deep: !process.argv.includes('--no-deep') };
  // a game can overrun gameMs by one candidate's proof (deep.js has a 60 s deadline) plus Tiltak; past this the worker is killed
  const watchdogMs = opts.gameMs * 3 + 120e3;
  const t0 = Date.now(); let next = 0, fin = 0, puz = 0, turn = 0, alive = 0, initFails = 0;
  const logRec = (r) => fs.writeSync(gfd, JSON.stringify(r) + '\n');
  const tick = () => {
    if (++fin % 100 && next < jobs.length) return;
    const s = (Date.now() - t0) / 1000;
    console.error(`${fin}/${jobs.length} games, ${puz} puzzles (${turn} screened turning), ${s.toFixed(0)}s, eta ${((jobs.length - fin) * s / fin / 3600).toFixed(1)} h`);
  };
  await new Promise((resolve, reject) => {
    const spawn = () => {
      alive++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: opts, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
      const S = { cur: null, timer: null, ready: false, dying: false, err: null };
      const kill = (why) => { S.why = why; S.dying = true; w.terminate(); };
      S.timer = setTimeout(() => kill('init-timeout'), 180e3);
      const feed = () => {
        clearTimeout(S.timer);
        if (next >= jobs.length) { S.cur = null; return kill('idle'); }
        S.cur = jobs[next++];
        S.timer = setTimeout(() => kill('timeout'), watchdogMs);
        w.postMessage(S.cur);
      };
      w.on('message', (m) => {
        if (m.ready) { if (S.dying) return; S.ready = true; initFails = 0; return feed(); }
        clearTimeout(S.timer); S.cur = null;
        logRec(m.game);
        if (m.puzzle) { fs.writeSync(pfd, JSON.stringify(m.puzzle) + '\n'); puz++; turn += m.puzzle.meta.screen.turn; }
        tick();
        if (!S.dying) feed();
      });
      w.on('error', (e) => { S.err = String(e?.message || e).slice(0, 200); });
      w.on('exit', () => {
        clearTimeout(S.timer); alive--;
        if (S.cur) { logRec({ gameId: S.cur.id, bucket: S.cur.bucket, result: S.cur.result, size: S.cur.size, error: (S.why === 'timeout' ? 'timeout' : 'crash') + (S.err ? ': ' + S.err : '') }); S.cur = null; tick(); }
        if (!S.ready && ++initFails > 5) return reject(new Error('workers keep failing to start: ' + (S.err || S.why)));
        if (next < jobs.length) spawn(); else if (alive === 0) resolve();
      });
    };
    if (!jobs.length) return resolve();
    for (let i = 0; i < Math.min(threads, jobs.length); i++) spawn();
  });
  console.error(`done: ${fin} games, ${puz} puzzles (${turn} screened turning) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

async function worker() {
  const { Game } = await import('../shared/tak.js');
  const { ptnFromServer } = await import('../shared/ptn.js');
  const { analyze } = await import('../shared/analyze.js');
  const { analyzeDeep } = await import('../shared/deep.js');
  const { TinueSearch, shortestTinue } = await import('../shared/pns.js');
  const { Tiltak } = await import('./tiltak-node.mjs');
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
    const komi = row.komi / 2, tk = 2; // Tiltak at komi 2 for every game (calibrated baseline, as score-swing); proofs use the real komi
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
        screen: { pre0: c.pre0, lostBefore: rec.lostBefore, alt: rec.alt, altMove, turn: rec.turn, trigger: c.trig, pS: c.pS,
          found: rec.found, wonGame: rec.wonGame, gameResult: row.result, nodes: O.nodes },
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

