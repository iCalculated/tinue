// Cheap per-node search-structure features along the stored main line.
// usage: TURN=0 SHARD=i NSHARD=k LIMIT=n node --no-warnings search_cheap.mjs > out.jsonl
import { DatabaseSync } from 'node:sqlite';
import { threatMoves, defenderMoves, winMove } from '../../shared/pns.js';
import { Game } from '../../shared/tak.js';
const d = new DatabaseSync(process.env.DB || new URL('../../data/tinue.db', import.meta.url).pathname, { readOnly: true });
const TURN = +(process.env.TURN || 0), SH = +(process.env.SHARD || 0), NS = +(process.env.NSHARD || 1), LIMIT = +(process.env.LIMIT || 1e9);
// idea = what a human sees as "the same move": placement -> square; spread -> source square + direction
export const idea = (ptn) => { const m = ptn.match(/^([FSC]?)([a-h][1-8])$/); if (m) return m[2]; const s = ptn.match(/^\d*([a-h][1-8])([<>+-])/); return s ? s[1] + s[2] : ptn; };
let n = 0, i = 0;
for (const r of d.prepare("SELECT id,tps,komi,plies,tree FROM puzzles WHERE turn = ? AND source NOT LIKE 'Ditaktic%'").iterate(TURN)) {
  if ((i++ % NS) !== SH) continue; if (n >= LIMIT) break;
  const t = JSON.parse(r.tree); if (t === 'win') { console.log(JSON.stringify({ id: r.id, nodes: [] })); n++; continue; }
  const g = Game.fromTPS(r.tps, r.komi), att = g.toMove; const nodes = [];
  let node = t;
  while (node && node !== 'win') {
    const ks = Object.keys(node);
    const thr = threatMoves(g).map((m) => g.moveToPTN(m));
    const thrI = new Set(thr.map(idea)), keyI = new Set(ks.map(idea));
    // threat ideas whose every variant is a key? decoy ideas = threat ideas with no key variant
    const decoyI = [...thrI].filter((x) => !keyI.has(x)).length;
    const k = ks[0]; g.play(k);
    const rec = { thr: thr.length, thrI: thrI.size, keys: ks.length, keyI: keyI.size, decoyI, key: k };
    if (!node[k] || g.result()) { nodes.push(rec); break; }
    // defender: moves considered, real blocks (attacker has no road-in-1 afterwards and defender doesn't lose immediately)
    const dm = defenderMoves(g, att); let blocks = 0; const blockSq = new Set(); let dwin = 0;
    for (const mv of dm) { const u = g.apply(mv); const res = g.result();
      if (res) { if (res.winner !== att) dwin++; } else if (!winMove(g, att)) { blocks++; blockSq.add(idea(g.moveToPTN(mv))); }
      g.undo(u); }
    rec.defs = dm.length; rec.blocks = blocks; rec.blockI = blockSq.size; rec.reply = node[k].r;
    nodes.push(rec);
    g.play(node[k].r); node = node[k].n;
  }
  console.log(JSON.stringify({ id: r.id, nodes })); n++;
}
