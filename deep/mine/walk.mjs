// Uncapped stage-0 walk over PlayTak 6x6 road wins (MINING.md 0.2), read-only on the dump.
//   node --no-warnings deep/mine/walk.mjs --raw=~/Projects/tinue/data/raw/games_anon.db --out=DIR [--limit=500] [--offset=0] [--procs=6]
// Games with both ratings >= 1500 first, then the rest (each group by id). Standard pieces only.
// For each game, every position where the eventual road winner is to move, latest first, goes to
// `deep walk` (prove secs=10, then exact length at 3M nodes; past one failure, stop after two).
// Writes DIR/walk.jsonl (one row per kept position: gameId, ply, len, tps, komi, ratings) and
// DIR/walk.summary.json (games, positions tried, kept by length, CPU seconds).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Game } from '../../shared/tak.js';
import { ptnFromServer } from '../../shared/ptn.js';
import { arg, runDeepSharded, writeJsonl } from './lib.mjs';

const RAW = arg('raw'), OUT = arg('out'), LIMIT = +arg('limit', 500), OFFSET = +arg('offset', 0), PROCS = +arg('procs', 6);
const t0 = Date.now();
fs.mkdirSync(OUT, { recursive: true });
const db = new DatabaseSync(RAW, { readOnly: true });
const games = db.prepare(`SELECT id, notation, result, komi, rating_white rw, rating_black rb, player_white pw, player_black pb FROM games
  WHERE size = 6 AND result IN ('R-0', '0-R') AND pieces IN (-1, 30) AND capstones IN (-1, 1)
  ORDER BY (rating_white >= 1500 AND rating_black >= 1500) DESC, id LIMIT ? OFFSET ?`).all(LIMIT, OFFSET);
const lines = [], info = new Map();
let skipped = 0;
for (const r of games) {
  try {
    const moves = r.notation.split(',').map(ptnFromServer), winner = r.result === 'R-0' ? 1 : 2;
    const g = new Game(6); g.komi = r.komi / 2;
    const pos = [];
    for (let i = 0; i < moves.length; i++) { if (g.toMove === winner) pos.push({ ply: i, tps: g.toTPS() }); g.play(moves[i]); }
    const res = g.result();
    if (!res || res.winner !== winner) { skipped++; continue; }
    pos.reverse();
    info.set(String(r.id), { r, pos });
    lines.push(`${r.id}|${r.komi}|${pos.map((p) => p.tps).join(';')}`);
  } catch { skipped++; }
}
const inFile = path.join(OUT, `walk.${OFFSET}.in`);
fs.writeFileSync(inFile, lines.join('\n') + '\n');
const { text, cpu } = await runDeepSharded('walk', inFile, PROCS, ['secs=10', 'nodes=3000000', 'min=11', 'fails=2'], path.join(OUT, `walk.${OFFSET}.tsv`));
const kept = [], perGame = [];
for (const l of text.trim().split('\n')) {
  const f = l.split('\t');
  if (f[0] === 'P') { const g = info.get(f[1]); const p = g.pos[+f[2]]; kept.push({ gameId: +f[1], ply: p.ply, len: f[3] === '?' ? null : +f[3], tps: f[4], komi: g.r.komi / 2, ratingWhite: g.r.rw, ratingBlack: g.r.rb, both1500: g.r.rw >= 1500 && g.r.rb >= 1500 }); }
  else if (f[0] === 'G') perGame.push({ id: +f[1], tried: +f[2], proved: +f[3], fails: +f[4], ms: +f[5] });
}
writeJsonl(path.join(OUT, `walk.${OFFSET}.jsonl`), kept);
const byLen = {}; for (const k of kept) byLen[k.len ?? '?'] = (byLen[k.len ?? '?'] || 0) + 1;
const s = { games: games.length, walked: perGame.length, skipped, positionsTried: perGame.reduce((a, g) => a + g.tried, 0), kept: kept.length, gamesWithKept: new Set(kept.map((k) => k.gameId)).size, byLen, cpuSec: +cpu.toFixed(1), cpuPerGame: +(cpu / Math.max(1, perGame.length)).toFixed(2), wallSec: (Date.now() - t0) / 1000 };
fs.writeFileSync(path.join(OUT, `walk.${OFFSET}.summary.json`), JSON.stringify(s, null, 1));
console.log(JSON.stringify(s));
