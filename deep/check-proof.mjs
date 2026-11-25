// Independent check of proofs dumped by `deep prove dump=1`, with shared/tak.js rules only.
//   deep/target/release/deep prove rows.txt dump=1 > out.txt && node --no-warnings deep/check-proof.mjs out.txt
// A dump is an `R|tps|halfkomi|and` line followed by `P|tps|move` lines (an attacker position and
// its move). From the root: at attacker positions play the stored move (tak.js checks legality);
// at defender positions try every legal reply. A reply must end the game with an attacker win, leave
// the attacker an immediate win (tried by brute force over every legal move), or reach a stored
// attacker position. Fails on a missing entry, an illegal move, a non-winning end, or a cycle.
import fs from 'node:fs';
import { Game } from '../shared/tak.js';

const text = fs.readFileSync(process.argv[2], 'utf8');
const proofs = [];
for (const line of text.split('\n')) {
  if (line.startsWith('R|')) { const [, tps, hk, and] = line.split('|'); proofs.push({ tps, komi: +hk / 2, and: and === '1', moves: new Map() }); }
  else if (line.startsWith('P|') && proofs.length) { const [, tps, mv] = line.split('|'); proofs.at(-1).moves.set(pkey(tps), mv); }
}
function pkey(tps) { return tps.trim().split(/\s+/).slice(0, 2).join(' '); }

function check(P) {
  const g = Game.fromTPS(P.tps, P.komi);
  const att = P.and ? 3 - g.toMove : g.toMove;
  const memo = new Map(), path = new Set();
  let visited = 0;
  const winsNow = () => {
    for (const mv of g.legalMoves()) { const u = g.apply(mv); const r = g.result(); g.undo(u); if (r && r.winner === att) return true; }
    return false;
  };
  const fail = (why) => { throw new Error(`${why} at ${g.toTPS()}`); };
  const attacker = () => {
    const k = pkey(g.toTPS());
    if (memo.has(k)) return memo.get(k);
    if (path.has(k)) fail('cycle');
    const mv = P.moves.get(k);
    if (!mv) fail('missing entry');
    visited++;
    path.add(k);
    let u;
    try { u = g.play(mv); } catch (e) { fail('illegal move ' + mv); }
    const r = g.result();
    let len;
    if (r) { if (r.winner !== att) fail(`non-winning end after ${mv}`); len = 1; } else len = 1 + defender();
    g.undo(u);
    path.delete(k);
    memo.set(k, len);
    return len;
  };
  const defender = () => {
    const k = pkey(g.toTPS());
    if (memo.has(k)) return memo.get(k);
    if (path.has(k)) fail('cycle');
    path.add(k);
    let worst = 1;
    for (const mv of g.legalMoves()) {
      const u = g.apply(mv);
      const r = g.result();
      let len;
      if (r) { if (r.winner !== att) fail(`reply ${g.moveToPTN(mv)} ends the game without an attacker win`); len = 1; }
      else if (P.moves.has(pkey(g.toTPS()))) len = attacker();
      else if (winsNow()) len = 1;
      else fail(`missing entry after reply ${g.moveToPTN(mv)}`);
      g.undo(u);
      worst = Math.max(worst, len);
    }
    path.delete(k);
    memo.set(k, worst + 1);
    return worst + 1;
  };
  const len = P.and ? defender() : attacker();
  return { len, visited };
}

let bad = 0;
proofs.forEach((P, i) => {
  try { const { len, visited } = check(P); console.log(`${i}\tok\t${len}\t${visited}/${P.moves.size}`); }
  catch (e) { bad++; console.log(`${i}\tFAIL\t${e.message}`); }
});
console.log(`${proofs.length} proofs, ${bad} failed`);
process.exit(bad ? 1 : 0);
