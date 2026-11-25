// Idea-level main-line walk: conversions (TURN=0, default) -> composer_ideas.<shard>.jsonl, turning points (TURN=1) ->
// composer_tpideas.<shard>.jsonl
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { threatMoves } from '../../shared/pns.js';
import { Game, winningMoves } from '../../shared/tak.js';
const SH = +process.argv[2], NS = +process.argv[3], TURN = +(process.env.TURN || 0);
const d = new DatabaseSync(process.env.DB || new URL('../../data/tinue.db', import.meta.url).pathname, { readOnly: true });
const out = fs.createWriteStream(`composer_${TURN ? 'tp' : ''}ideas.${SH}.jsonl`);
// idea: placement -> square; stack move -> origin+direction
const idea = (p) => { const m = p.match(/^(\d?)([a-h][1-8])([<>+-])/); if (m) return m[2] + m[3]; const q = p.match(/([a-h][1-8])/); return q ? q[1] : p; };
const uniq = (a) => [...new Set(a)];
let i = 0;
for (const r of d.prepare("SELECT id,tps,komi,plies,tree,swing FROM puzzles WHERE turn = ? AND source NOT LIKE 'Ditaktic%' ORDER BY id").iterate(TURN)) {
  if ((i++ % NS) !== SH) continue;
  const t = JSON.parse(r.tree), s = r.swing ? JSON.parse(r.swing) : {};
  const g = Game.fromTPS(r.tps, r.komi), a = g.toMove;
  const res = { id: r.id, reserves: g.stones[a] + g.caps[a], ideasAt: [], thrIdeasAt: [], decoyAt: [], path: [] };
  const altIdeas = uniq((s.alts || []).map(idea));
  let node = t, depth = 0, path = [];
  try {
    while (node && node !== 'win') {
      const ks = Object.keys(node), ki = uniq(ks.map(idea));
      const thr = threatMoves(g).map((m) => g.moveToPTN(m));
      const ti = uniq(thr.map(idea));
      // later-node slower wins (only computed for some 5-ply)
      const pk = path.join(' ');
      const laterAlts = depth === 0 ? altIdeas : uniq(((s.altsAt || {})[pk] || []).map(idea));
      const good = new Set([...ki, ...laterAlts]);
      res.ideasAt.push(ki.length); res.thrIdeasAt.push(ti.length);
      res.decoyAt.push(ti.filter((x) => !good.has(x)).length);
      if (depth === 0) { res.rootAltIdeas = altIdeas.filter((x) => !ki.includes(x)).length; res.rootThr = thr.length; }
      else res.laterAltIdeas = (res.laterAltIdeas || 0) + laterAlts.filter((x) => !ki.includes(x)).length;
      const k = ks[0]; g.play(k); path.push(k);
      if (!node[k]) { node = null; break; }
      g.play(node[k].r); path.push(node[k].r); node = node[k].n; depth++;
    }
    // ending
    let endKind = null, finIdeas = null, finMoves = null;
    if (node === 'win') { const w = winningMoves(g, 1).moves; finMoves = w.length; finIdeas = uniq(w.map(idea)).length;
      let road = 0; for (const m of w) { const h = g.clone(); h.play(m); const rr = h.result(); if (rr && rr.kind === 'road') road++; }
      endKind = road ? 'road' : 'flat'; res.finRoadMoves = road; }
    else { const rr = g.result(); endKind = rr ? rr.kind : '?'; }
    res.endKind = endKind; res.finIdeas = finIdeas; res.finMoves = finMoves;
    res.endReserves = g.stones[a] + g.caps[a];
    let emp = 0; for (let q = 0; q < g.n; q++) if (!g.board[q].length) emp++; res.endEmpty = emp;
  } catch (e) { res.err = String(e).slice(0, 120); }
  out.write(JSON.stringify(res) + '\n');
}
out.end();
