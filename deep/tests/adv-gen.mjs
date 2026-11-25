// Adversarial rules data from shared/tak.js for `cargo run --release --example advcheck`.
//   node --no-warnings deep/tests/adv-gen.mjs <positions> [seed] > adv.txt
// Positions are biased to the hard cases: built directly (tall stacks, near-full or full boards,
// one to three pieces in reserve, walls and capstones on road squares, komi near the flat margin)
// or taken late from random playouts that dodge game-ending moves. One line per position:
//   tps|halfkomi|moves
// where moves lists every legal move of the side to move as `ptn:end:opp:self`:
//   end  - r1/r2 road win, f1/f2 flat win, d draw, '-' game goes on
//   opp  - 1 if, after the move, the opponent (now to move) has a winning move, else 0 ('-' if ended)
//   self - 1 if, after the move, the mover could win at once if it were their turn again ('-' if ended)
// and then `|R1:ptn,ptn|R2:ptn,...`: moves by colour 1 (2) that give it a road, played as if it were
// its turn. Positions where either side already has a road or has no reserves are skipped.
import { Game, WALL, CAP, FLAT, pieceOf, colorOf } from '../../shared/tak.js';

const want = +(process.argv[2] || 500);
let seed = BigInt(process.argv[3] || 1) * 0x2545f4914f6cdd1dn + 77n;
const M64 = (1n << 64n) - 1n;
function rnd() {
  seed = (seed + 0x9e3779b97f4a7c15n) & M64;
  let z = seed;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  z ^= z >> 31n;
  return Number(z >> 11n) / 2 ** 53;
}
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = ri(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function code(r) { return r ? (r.kind === 'draw' ? 'd' : (r.kind === 'road' ? 'r' : 'f') + r.winner) : '-'; }
function canWin(g, c) {
  const save = g.toMove;
  g.toMove = c;
  let w = false;
  for (const m of g.legalMoves()) { const u = g.apply(m); const r = g.result(); g.undo(u); if (r && r.winner === c) { w = true; break; } }
  g.toMove = save;
  return w;
}
function roadMoves(g, c) {
  const save = g.toMove;
  g.toMove = c;
  const out = [];
  for (const m of g.legalMoves()) { const u = g.apply(m); const r = g.result(); g.undo(u); if (r && r.kind === 'road' && r.winner === c) out.push(g.moveToPTN(m)); }
  g.toMove = save;
  return out;
}
function komiFor(g) {
  const f = g.flatCounts();
  const d = f[1] - f[2];
  const k = pick([d - 1, d - 0.5, d, d + 0.5, d + 1, d + 1.5, d - 1.5, 0, 2, 2.5]);
  return Math.max(-6, Math.min(6, k));
}

// A position built square by square: `occ` occupied squares sharing t1 + t2 pieces.
function built() {
  for (let tries = 0; tries < 200; tries++) {
    const g = new Game(6);
    const empties = pick([0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 9, 12, 18, 26]);
    const occ = 36 - empties;
    const low = rnd() < 0.6; // few reserves
    const t1 = low ? 31 - ri(4) : 8 + ri(23), t2 = low ? 31 - ri(4) : 8 + ri(23);
    if (t1 + t2 < occ) continue;
    const sqs = shuffle([...Array(36).keys()]).slice(0, occ);
    const pieces = shuffle([...Array(t1).fill(1), ...Array(t2).fill(2)]);
    const stacks = sqs.map(() => []);
    for (let i = 0; i < occ; i++) stacks[i].push(pieces[i]);
    const tall = rnd() < 0.5 ? 1 + ri(3) : occ; // clump the rest on a few squares, or spread it
    for (let i = occ; i < pieces.length; i++) stacks[rnd() < 0.7 ? ri(Math.min(tall, occ)) : ri(occ)].unshift(pieces[i]);
    const pw = pick([0, 0.05, 0.15, 0.35]);
    const used = { 1: [0, 0], 2: [0, 0] }; // [stones, caps]
    const types = stacks.map(() => FLAT);
    for (const c of [1, 2]) {
      if (rnd() < 0.7) {
        const mine = stacks.map((s, i) => (s.at(-1) === c ? i : -1)).filter((i) => i >= 0);
        if (mine.length) types[pick(mine)] = CAP;
      }
    }
    stacks.forEach((s, i) => { if (types[i] === FLAT && rnd() < pw) types[i] = WALL; });
    stacks.forEach((s, i) => s.forEach((c, j) => { if (j === s.length - 1 && types[i] === CAP) used[c][1]++; else used[c][0]++; }));
    if (used[1][0] > 30 || used[2][0] > 30) continue;
    stacks.forEach((s, i) => {
      s.forEach((c, j) => g.board[sqs[i]].push(pieceOf(c, j === s.length - 1 ? types[i] : FLAT)));
    });
    g.stones = [0, 30 - used[1][0], 30 - used[2][0]];
    g.caps = [0, 1 - used[1][1], 1 - used[2][1]];
    if (g.stones[1] + g.caps[1] === 0 || g.stones[2] + g.caps[2] === 0) continue;
    if (g.hasRoad(1) || g.hasRoad(2)) continue;
    g.toMove = 1 + ri(2);
    g.ply = 2 * (10 + ri(30)) + g.toMove - 1;
    const h = Game.fromTPS(g.toTPS()); // recompute hashes through the parser
    h.komi = komiFor(h);
    return h;
  }
  return null;
}

// Late position from a random playout that dodges game ends (walls, spreads or placements favoured).
function played() {
  const g = new Game(6);
  const style = ri(4);
  const stop = 20 + ri(140);
  for (let ply = 0; ply < stop; ply++) {
    const moves = g.legalMoves();
    const ok = moves.filter((m) => { const u = g.apply(m); const r = g.result(); g.undo(u); return !r; });
    if (!ok.length) break;
    let pool = ok;
    if (style === 1) { const s = ok.filter((m) => m.kind === 'm'); if (s.length && rnd() < 0.7) pool = s; }
    if (style === 2) { const w = ok.filter((m) => m.kind === 'p' && m.type === WALL); if (w.length && rnd() < 0.4) pool = w; }
    if (style === 3) { const p = ok.filter((m) => m.kind === 'p'); if (p.length && rnd() < 0.8) pool = p; }
    g.apply(pick(pool));
  }
  if (g.ply < 2 || g.hasRoad(1) || g.hasRoad(2) || g.result()) return null;
  g.komi = komiFor(g);
  return g;
}

const out = [];
let made = 0;
while (made < want) {
  const g = rnd() < 0.7 ? built() : played();
  if (!g) continue;
  const me = g.toMove;
  const cells = [];
  for (const m of g.legalMoves()) {
    const u = g.apply(m);
    const r = g.result();
    let opp = '-', self = '-';
    if (!r) { opp = canWin(g, 3 - me) ? '1' : '0'; self = canWin(g, me) ? '1' : '0'; }
    g.undo(u);
    cells.push(`${g.moveToPTN(m)}:${code(r)}:${opp}:${self}`);
  }
  out.push(`${g.toTPS()}|${Math.round(g.komi * 2)}|${cells.join(' ')}|R1:${roadMoves(g, 1).join(',')}|R2:${roadMoves(g, 2).join(',')}`);
  made++;
  if (out.length >= 50) { process.stdout.write(out.join('\n') + '\n'); out.length = 0; }
}
if (out.length) process.stdout.write(out.join('\n') + '\n');
