import { DatabaseSync } from 'node:sqlite';
import { threatMoves } from '../../shared/pns.js';
import { Game, winningMoves } from '../../shared/tak.js';
const d = new DatabaseSync(process.env.DB || new URL('../../data/tinue.db', import.meta.url).pathname, { readOnly: true });
const idea = (p) => { const m = p.match(/^(\d?)([a-h][1-8])([<>+-])/); if (m) return m[2] + m[3]; const q = p.match(/([a-h][1-8])/); return q ? q[1] : p; };
const P = ['w', 'b', 'W', 'B', 'C', 'D']; // flat w/b, wall W/B, cap C(white) D(black)
function board(g) {
  const rows = [];
  for (let r = g.size - 1; r >= 0; r--) {
    let line = (r + 1) + ' ';
    for (let c = 0; c < g.size; c++) { const st = g.board[r * g.size + c];
      line += (st.length ? st.map((p) => P[p]).join('') : '.').padEnd(6); }
    rows.push(line);
  }
  rows.push('  ' + [...'abcdefgh'].slice(0, g.size).map((f) => f.padEnd(6)).join(''));
  return rows.join('\n');
}
for (const id of process.argv.slice(2)) {
  const r = d.prepare('SELECT * FROM puzzles WHERE id=?').get(id);
  const t = JSON.parse(r.tree), m = JSON.parse(r.meta || '{}'), s = JSON.parse(r.swing || '{}');
  const g = Game.fromTPS(r.tps, r.komi), a = g.toMove;
  console.log(`\n=== ${id} ${r.size}x${r.size} komi ${r.komi} plies ${r.plies} rating ${Math.round(r.rating)} themes ${r.themes} turn ${r.turn}`);
  console.log(`attacker ${a === 1 ? 'white(w)' : 'black(b)'} reserves ${g.stones[a]}+${g.caps[a]}  opp ${g.stones[3 - a]}+${g.caps[3 - a]}  flats ${JSON.stringify(g.flatCounts())}  pre0 ${s.pre0} alt ${s.alt} alts ${JSON.stringify(s.alts)} altsAt ${JSON.stringify(s.altsAt)}`);
  console.log(`game ${m.white}(${m.ratingWhite}) vs ${m.black}(${m.ratingBlack}) ply ${m.ply} last ${m.lastMove}; gameLine ${(m.gameLine || []).join(' ')}`);
  console.log(board(g));
  let node = t, line = [];
  while (node && node !== 'win') {
    const ks = Object.keys(node);
    const thr = threatMoves(g).map((x) => g.moveToPTN(x));
    const ki = new Set(ks.map(idea));
    const dec = [...new Set(thr.map(idea))].filter((x) => !ki.has(x));
    const k = ks[0];
    let txt = `  ATT ${k}  keys[${ks.join(',')}]  decoyIdeas(${dec.length})[${dec.slice(0, 12).join(',')}]`;
    g.play(k);
    if (!node[k]) { console.log(txt + '  -> wins on spot ' + JSON.stringify(g.result())); node = null; break; }
    txt += `  | DEF ${node[k].r}`; console.log(txt);
    g.play(node[k].r); node = node[k].n;
  }
  if (node === 'win') { const w = winningMoves(g, 1).moves; const kinds = w.map((x) => { const h = g.clone(); h.play(x); return x + ':' + h.result().kind; }); console.log('  FINAL', kinds.join(' ')); }
  console.log(board(g));
}
