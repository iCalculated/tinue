// is the motif on the final road move forced? every road-in-1 at the end of the main line is a multi-drop or smash
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { Game, winningMoves } from '../../shared/tak.js';
const d = new DatabaseSync(process.env.DB || new URL('../../data/tinue.db', import.meta.url).pathname, { readOnly: true });
const out = [];
for (const r of d.prepare("SELECT id,tps,komi,tree FROM puzzles WHERE source NOT LIKE 'Ditaktic%'").iterate()) {
  const g = Game.fromTPS(r.tps, r.komi); let node = JSON.parse(r.tree);
  while (node && node !== 'win') { const k = Object.keys(node)[0]; g.play(k); if (!node[k]) { node = null; break; } g.play(node[k].r); node = node[k].n; }
  if (node !== 'win') { out.push({ id: r.id, fin: null }); continue; }
  const w = winningMoves(g, 1).moves; let mot = 0;
  for (const m of w) { const mv = g.parseMove(m); const h = g.clone(); const u = h.apply(h.parseMove(m)); if (mv.kind === 'm' && (mv.drops.length >= 2 || u.smashed)) mot++; }
  out.push({ id: r.id, n: w.length, mot });
}
fs.writeFileSync('v2_fin.jsonl', out.map((x) => JSON.stringify(x)).join('\n') + '\n');
