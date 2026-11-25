// Mine puzzles from the PlayTak games DB (https://playtak.com/games_anon.db.gz).
// For each road-win game we walk back from the end and take the EARLIEST position (winner to move,
// up to MAX_UNDO plies before the end) that is already a forced win — the moment the tinue appeared.
// The puzzle starts right after the loser's mistake; we keep that move to animate it, Lichess-style.
//
// usage: node scripts/mine-playtak.mjs [--limit N] [--size S] [--max-undo 5] [--out data/puzzles/playtak.jsonl]
import fs from 'node:fs';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ptnFromServer } from '../shared/ptn.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

if (isMainThread) {
  const DB = arg('db', 'data/raw/games_anon.db');
  const limit = +arg('limit', 2000);
  const size = arg('size', null);
  const out = arg('out', 'data/puzzles/playtak.jsonl');
  const threads = +arg('threads', Math.max(1, os.cpus().length - 2));
  const db = new DatabaseSync(DB, { readOnly: true });
  const done = new Set();
  if (fs.existsSync(out)) for (const l of fs.readFileSync(out, 'utf8').split('\n')) if (l) { const p = JSON.parse(l); done.add(p.meta.gameId); }
  const skipFile = out + '.skipped';
  if (fs.existsSync(skipFile)) for (const l of fs.readFileSync(skipFile, 'utf8').split('\n')) if (l) done.add(+l);
  // Rated, non-guest, default pieces, swap opening, road wins. Most recent first.
  const rows = db.prepare(`SELECT id, date, size, player_white, player_black, notation, result, komi, rating_white, rating_black
    FROM games WHERE result IN ('R-0','0-R') AND notation != '' AND unrated = 0 AND opening = 'swap'
      AND pieces IN (-1, CASE size WHEN 3 THEN 10 WHEN 4 THEN 15 WHEN 5 THEN 21 WHEN 6 THEN 30 WHEN 7 THEN 40 ELSE 50 END)
      AND capstones IN (-1, CASE size WHEN 3 THEN 0 WHEN 4 THEN 0 WHEN 5 THEN 1 WHEN 6 THEN 1 WHEN 7 THEN 2 ELSE 2 END)
      AND player_white NOT LIKE 'Guest%' AND player_black NOT LIKE 'Guest%'
      AND size BETWEEN 4 AND 8 ${size ? 'AND size = ' + +size : ''}
    ORDER BY id DESC LIMIT ?`).all(limit * 3 + done.size).filter((r) => !done.has(r.id)).slice(0, limit);
  console.error(`${rows.length} games to mine with ${threads} threads (${done.size} already done)`);
  const outFd = fs.openSync(out, 'a'), skipFd = fs.openSync(skipFile, 'a');
  let next = 0, finished = 0, found = 0; const t0 = Date.now();
  const byPly = {};
  const maxUndo = +arg('max-undo', 5);
  await new Promise((resolve) => {
    let alive = 0;
    // A worker that dies (out of memory) marks its game skipped and is replaced, as in mine-deep.mjs.
    const spawn = () => {
      alive++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { maxUndo } });
      let cur = null, dead = false;
      const feed = () => { if (next < rows.length) w.postMessage(cur = rows[next++]); else { cur = null; w.terminate(); if (--alive === 0) resolve(); } };
      w.on('message', (m) => {
        finished++; cur = null;
        if (m.puzzle) { fs.writeSync(outFd, JSON.stringify(m.puzzle) + '\n'); found++; byPly[m.puzzle.plies] = (byPly[m.puzzle.plies] || 0) + 1; }
        else fs.writeSync(skipFd, m.gameId + '\n');
        if (finished % 100 === 0) console.error(`${finished}/${rows.length} games, ${found} puzzles ${JSON.stringify(byPly)}, ${((Date.now() - t0) / finished).toFixed(0)}ms/game`);
        feed();
      });
      w.on('error', (e) => {
        if (dead) return; dead = true;
        console.error('worker error', cur?.id, e);
        if (cur) { finished++; fs.writeSync(skipFd, cur.id + '\n'); }
        alive--;
        if (next < rows.length) spawn(); else if (alive === 0) resolve();
      });
      feed();
    };
    for (let i = 0; i < threads; i++) spawn();
  });
  console.error(`done: ${found} puzzles from ${finished} games in ${((Date.now() - t0) / 1000).toFixed(0)}s ${JSON.stringify(byPly)}`);
} else {
  const { Game } = await import('../shared/tak.js');
  const { analyze, mateIn } = await import('../shared/analyze.js');
  const { maxUndo } = workerData;
  parentPort.on('message', (row) => {
    let puzzle = null;
    try { puzzle = mine(row); } catch (e) { /* malformed game */ }
    parentPort.postMessage({ gameId: row.id, puzzle });
  });
  function mine(row) {
    const moves = row.notation.split(',').map(ptnFromServer);
    const komi = row.komi / 2;
    const g = new Game(row.size); g.komi = komi;
    const tps = [g.toTPS()];
    for (const m of moves) { g.play(m); tps.push(g.toTPS()); }
    const res = g.result();
    const winner = row.result === 'R-0' ? 1 : 2;
    if (!res || res.kind !== 'road' || res.winner !== winner) return null;
    const n = moves.length;
    // earliest winner-to-move position (n-1, n-3, ..., n-maxUndo) with a forced win in <= maxUndo plies
    let pick = null;
    for (let u = maxUndo; u >= 1; u -= 2) {
      const idx = n - u; // position index (before move idx)
      if (idx < 2) continue;
      const pos = Game.fromTPS(tps[idx], komi);
      if (pos.toMove !== winner) continue;
      const d = mateIn(pos, Math.min(u, maxUndo), 4e6);
      if (d.plies > 0) { pick = { idx, plies: d.plies }; break; }
      if (d.plies < 0) return null; // too expensive — skip game
    }
    if (!pick) return null;
    const { idx } = pick;
    const a = analyze(tps[idx], { plies: pick.plies, line: moves.slice(idx), maxPlies: pick.plies, komi, maxNodes: 1.5e7 });
    if (!a.ok) return null;
    return {
      id: 'p' + row.id,
      size: row.size, tps: tps[idx], komi, plies: a.plies, tree: a.tree, tags: a.tags, rating: a.rating,
      source: 'PlayTak', sourceRef: `https://api.playtak.com/v1/games-history/ptn/${row.id}`,
      meta: {
        gameId: row.id, date: row.date, white: row.player_white, black: row.player_black,
        ratingWhite: row.rating_white, ratingBlack: row.rating_black, ply: idx,
        prevTps: tps[idx - 1], lastMove: moves[idx - 1], gameLine: moves.slice(idx, idx + a.plies),
        rootWins: a.rootWins, nodes: a.nodes, factors: a.factors, mainLine: a.mainLine,
      },
    };
  }
}
