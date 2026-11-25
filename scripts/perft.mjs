import { Game } from '../shared/tak.js';
function perft(g, d) { if (d === 0) return 1; let n = 0; for (const m of g.legalMoves()) { const u = g.apply(m); const r = g.result(); n += (r || d===1) ? 1 : perft(g, d - 1); g.undo(u); } return n; }
for (const [size, depth] of [[5,4],[6,3]]) {
  const g = new Game(size); const t = Date.now(); const h0 = g.key();
  const out = []; for (let d = 1; d <= depth; d++) out.push(perft(g, d));
  console.log(size, out.join(','), Date.now() - t, 'ms', g.key() === h0 ? 'hash-ok' : 'HASH-MISMATCH');
}
