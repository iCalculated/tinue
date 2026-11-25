// v2 main-line walk (conversions TURN=0, turning points TURN=1) -> v2_walk.<turn>.<shard>.jsonl
// Per attacker node: key moves/ideas, threat moves/ideas, per-key motif, and (below the root, rem >= 5) the threat
// ideas that ALSO win within rem+2 plies (later slower alternatives, same budgeted threat search as allTinueMoves).
// Root: precision decoys (threat moves sharing a key's idea that are neither keys nor slower wins) and, per stored
// slower root alternative, whether it is a Tak threat and whether a threat-only tinue follows within plies+4.
// usage: DB=t.db TURN=0 SHARD=i NSHARD=k [IDS=a,b] node --no-warnings v2_walk.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { threatMoves, TinueSearch } from '../../shared/pns.js';
import { Game, colorOf } from '../../shared/tak.js';
const DB = process.env.DB || new URL('../../data/tinue.db', import.meta.url).pathname;
const d = new DatabaseSync(DB, { readOnly: true });
const TURN = +(process.env.TURN || 0), SH = +(process.env.SHARD || 0), NS = +(process.env.NSHARD || 1);
const BUD = +(process.env.BUD || 3e4);
const IDS = process.env.IDS ? new Set(process.env.IDS.split(',')) : null;
const ONLY = process.env.ONLY ? new Set(fs.readFileSync(process.env.ONLY, 'utf8').split(/\s+/).filter(Boolean)) : null;
const fd = IDS ? 1 : fs.openSync(`v2_walk.${TURN}.${SH}.jsonl`, 'w');
const out = { write: (x) => fs.writeSync(fd, x) };
const idea = (p) => { const m = p.match(/^([FSC]?)([a-h][1-8])$/); if (m) return m[2]; const s = p.match(/^\d*([a-h][1-8])([<>+-])/); return s ? s[1] + s[2] : p; };
const uniq = (a) => [...new Set(a)];
const DIRS = { '+': [1, 0], '-': [-1, 0], '>': [0, 1], '<': [0, -1] };

function motif(g, ptn, A) {
  const mv = g.parseMove(ptn);
  if (mv.kind !== 'm') return { k: 'p' };
  const size = g.size, before = g.board.map((s) => (s.length ? s[s.length - 1] : -1));
  const [dr, dc] = DIRS[mv.dir]; const sqs = []; let r = Math.floor(mv.sq / size), c = mv.sq % size;
  for (let k = 0; k < mv.drops.length; k++) { r += dr; c += dc; sqs.push(r * size + c); }
  const h = g.clone(); h.apply(h.parseMove(ptn));
  const tops = sqs.map((s) => h.top(s));
  const o = { k: 'm', n: mv.drops.length };
  if (before[sqs[0]] >= 0 && colorOf(before[sqs[0]]) !== A) o.cap = 1;
  if (mv.drops.length >= 2) { if (tops.every((t) => colorOf(t) === A)) o.spread = 1; else o.throw = 1; }
  const hm = h.board[sqs[sqs.length - 1]]; // smash: cap lands on a square that held a wall
  if (before[sqs[sqs.length - 1]] >= 0 && (before[sqs[sqs.length - 1]] >> 1) === 1) o.smash = 1;
  return o;
}

// does `ptn` (attacker to move in g) force a threat-only win within `plies` total? true/false/null(budget)
function winsWithin(g, ptn, plies, bud) {
  const h = g.clone(); const s = new TinueSearch(h, { maxNodes: bud });
  h.play(ptn); const r = h.result();
  if (r) return r.winner === s.att;
  try { return !!s.solve(plies - 1); } catch (e) { if (e.message === 'budget') return null; throw e; }
}

let i = 0;
const q = "SELECT id,tps,komi,plies,tree,swing FROM puzzles WHERE turn = ? AND source NOT LIKE 'Ditaktic%' ORDER BY id";
for (const row of d.prepare(q).iterate(TURN)) {
  if (IDS && !IDS.has(row.id)) continue;
  if (ONLY && !ONLY.has(row.id)) continue;
  if (!IDS && (i++ % NS) !== SH) continue;
  const t0 = Date.now();
  const t = JSON.parse(row.tree), s = row.swing ? JSON.parse(row.swing) : {};
  const g = Game.fromTPS(row.tps, row.komi), A = g.toMove;
  const res = { id: row.id, plies: row.plies, nodes: [] };
  try {
    let node = t, R = row.plies, j = 0;
    while (node && node !== 'win') {
      const ks = Object.keys(node), kI = uniq(ks.map(idea));
      const thr = threatMoves(g).map((m) => g.moveToPTN(m)), thrI = uniq(thr.map(idea));
      const rec = { R, keys: ks, kI, thr: thr.length, thrI: thrI.length, mot: motif(g, ks[0], A) };
      // all key motifs (for "motif is forced": every key idea uses it)
      rec.motAll = ks.map((k) => motif(g, k, A));
      if (j === 0) {
        const alts = (s.alts || []).map((x) => g.canon ? g.canon(x) : x);
        const altSet = new Set(alts), keySet = new Set(ks);
        rec.pdec = thr.filter((m) => kI.includes(idea(m)) && !keySet.has(m) && !altSet.has(m)).length;
        const thrSet = new Set(thr);
        rec.rootAlts = alts.map((a) => {
          const o = { m: a, thr: thrSet.has(a) ? 1 : 0 };
          if (row.plies >= 3 && row.plies <= 9) o.tin = winsWithin(g, a, row.plies + 4, BUD);
          return o;
        });
      } else if (R >= 5) {
        // later slower alternatives within R+2 (threat search), one proof per idea
        const altI = [], unkI = [];
        const byIdea = {};
        for (const m of thr) { const x = idea(m); if (kI.includes(x)) continue; (byIdea[x] ||= []).push(m); }
        for (const [x, ms] of Object.entries(byIdea)) {
          let unk = false, won = false;
          for (const m of ms) { const w = winsWithin(g, m, R + 2, BUD); if (w) { won = true; break; } if (w === null) unk = true; }
          if (won) altI.push(x); else if (unk) unkI.push(x);
        }
        rec.altI = altI; rec.unkI = unkI.length;
      }
      res.nodes.push(rec);
      const k = ks[0]; g.play(k);
      if (!node[k]) break;
      g.play(node[k].r); node = node[k].n; R -= 2; j++;
    }
  } catch (e) { res.err = String(e).slice(0, 160); }
  res.ms = Date.now() - t0;
  out.write(JSON.stringify(res) + '\n');
}
if (!IDS) fs.closeSync(fd);
