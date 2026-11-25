// Differential test data from shared/tak.js (the rules ground truth) for `deep diff`.
//   node --no-warnings deep/tests/gen-diff.mjs <games> [seed] > diff.txt
// One line per position of a random 6x6 playout:  tps|halfkomi|played|legal moves|ending moves
// where ending moves are `ptn:code` (r1/r2 road win, f1/f2 flat win, d draw) for every legal move
// that ends the game. `#game` separates playouts. Policies vary placement and wall bias, and half of
// the games dodge game-ending moves so threats, full boards and empty reserves pile up.
import { Game, WALL } from '../../shared/tak.js';

const games = +(process.argv[2] || 200);
let seed = BigInt(process.argv[3] || 1) * 0x9e3779b97f4a7c15n;
const M64 = (1n << 64n) - 1n;
function rnd() { // splitmix64 -> [0,1)
  seed = (seed + 0x9e3779b97f4a7c15n) & M64;
  let z = seed;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  z ^= z >> 31n;
  return Number(z >> 11n) / 2 ** 53;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const STYLES = [[0, 0], [0.6, 0.2], [0.9, 0.4], [0.97, 0.1]];

const out = [];
const flush = () => { process.stdout.write(out.join('\n') + '\n'); out.length = 0; };
for (let gi = 0; gi < games; gi++) {
  const g = new Game(6);
  g.komi = Math.floor(rnd() * 9) / 2;
  const [pp, pw] = STYLES[gi % 4];
  const dodge = Math.floor(gi / 4) % 2 === 1;
  out.push('#game');
  for (let ply = 0; ply < 400; ply++) {
    const moves = g.legalMoves();
    const ptns = [], ends = [];
    for (const m of moves) {
      const p = g.moveToPTN(m);
      ptns.push(p);
      const u = g.apply(m);
      const r = g.result();
      g.undo(u);
      if (r) ends.push(`${p}:${r.kind === 'draw' ? 'd' : (r.kind === 'road' ? 'r' : 'f') + r.winner}`);
    }
    const choose = () => {
      if (rnd() <= pp) {
        const pl = moves.filter((m) => m.kind === 'p');
        if (pl.length) {
          if (rnd() <= pw) { const w = pl.filter((m) => m.type === WALL); if (w.length) return pick(w); }
          return pick(pl);
        }
      }
      return pick(moves);
    };
    let mv = choose();
    if (dodge) for (let i = 0; i < 12 && ends.some((e) => e.startsWith(g.moveToPTN(mv) + ':')); i++) mv = choose();
    const ptn = g.moveToPTN(mv);
    const over = ends.some((e) => e.startsWith(ptn + ':'));
    out.push(`${g.toTPS()}|${Math.round(g.komi * 2)}|${over ? '' : ptn}|${ptns.join(' ')}|${ends.join(' ')}`);
    if (over) break;
    g.apply(mv);
  }
  if (out.length > 2000) flush();
}
flush();
