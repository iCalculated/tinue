// The book's position key and the walk over a puzzle's stored lines (docs/plan/PLAN.md §1.1). Pure: no I/O.
//
// A book row says: in this position (the attacker has just moved, the defender is to move) the attacker has a forced
// win. Its key is the TPS board and side to move, without the move number, then '|' and twice the komi:
//   "x2,1,x2,2/…/x,1,212,2,2,1 2|4"
// It names a position, not a move path, so transpositions share a row. Komi is in the key because flat wins depend on
// it. deep (Rust) writes the same string from Board::tps_board(); scripts/book-keycheck.mjs cross-checks the two.
import { Game } from './tak.js';

// Twice the komi as an integer string; komi is a multiple of 0.5 (puzzles.komi).
export function halfKomi(komi) {
  const h = 2 * (+komi || 0);
  if (!Number.isInteger(h) || h < 0) throw new Error('komi must be a non-negative multiple of 0.5: ' + komi);
  return String(h);
}

// bookKey(game, komi): the key of the game's current position. komi defaults to the game's own.
export function bookKey(game, komi = game.komi) {
  const tps = game.toTPS();
  return tps.slice(0, tps.lastIndexOf(' ')) + '|' + halfKomi(komi);
}

// The game a puzzle's stored lines start from. Game.fromTPS takes a missing move number as 1, so such a TPS starts at
// ply 0 or 1, where the opening rule gives each placement to the opponent. A board holding more pieces than that ply
// allows (ply 0: none, ply 1: one) was not reached under those rules, and replaying stored lines from it would key
// positions the puzzle never reaches; refused (book-init lists it as a walk error).
export function puzzleStart(tps, komi) {
  const g = Game.fromTPS(tps, komi);
  if (g.ply < 2) {
    const pieces = g.board.reduce((n, st) => n + st.length, 0);
    if (pieces > g.ply) throw new Error(`TPS at ply ${g.ply} (no move number, or move 1) holds ${pieces} pieces: opening rule would apply`);
  }
  return g;
}

// The key from a TPS string (with or without a move number). No moves are applied, so the opening rule does not matter.
export const bookKeyOfTPS = (tps, komi) => bookKey(Game.fromTPS(tps, komi), komi);

// Depth of a tree node in plies, the attacker's ply included: d('win') = 1; d({m: {r, n}}) = 2 + max d(n).
// A puzzle's plies equals d(tree). A key whose value is null (4 unserved rows in lyra's DB) counts as 1 ply.
export function treeDepth(node) {
  if (node === 'win') return 1;
  let d = 0;
  for (const m of Object.keys(node)) d = Math.max(d, node[m] ? 2 + treeDepth(node[m].n) : 1);
  return d;
}

// Every stored winning attacker move of a puzzle, with the position after it:
//   { kind: 'tree' | 'alt', path, move, pos, winLen }
// path: the moves played from the puzzle root before `move`, as the client records them (public/app.js S.moves):
//   attacker moves canonical, defender replies as stored in the tree. altsAt is keyed by path.join(' ').
// tree keys: winLen = plies left from pos, defender to move, the attacker's last ply included = 1 + d(next node);
//   so a puzzle's plies = 1 + its root key's winLen. 'win' nodes have no key (the move ends the game).
// alts (swing.alts at the root, swing.altsAt[path joined by ' '] deeper in): winLen = null (no stored length).
// A move that ends the game itself (a stored alt that wins at once) gets pos = null.
// Moves are replayed with the rules; an illegal or unparseable stored move throws.
export function puzzleWins(p) {
  const out = [];
  const g = puzzleStart(p.tps, p.komi);
  const tree = typeof p.tree === 'string' ? JSON.parse(p.tree) : p.tree;
  const swing = p.swing ? (typeof p.swing === 'string' ? JSON.parse(p.swing) : p.swing) : {};
  const after = (g0, mv) => {
    const g1 = g0.clone();
    g1.play(g1.canon(mv));
    return g1;
  };
  const posOf = (g1) => (g1.result() ? null : bookKey(g1, p.komi));
  const alts = (path, g0) => {
    const list = path.length ? swing.altsAt?.[path.join(' ')] : swing.alts;
    for (const a of list || []) {
      const g1 = after(g0, a);
      out.push({ kind: 'alt', path: path.slice(), move: g0.canon(a), pos: posOf(g1), winLen: null });
    }
  };
  const walk = (node, path, g0) => {
    alts(path, g0);
    if (node === 'win') return;
    for (const m of Object.keys(node)) {
      const g1 = after(g0, m);
      if (!node[m]) { // a key without a reply: only a move that ends the game may have none
        if (!g1.result()) throw new Error(`tree key ${m} at '${path.join(' ')}' has no reply and does not end the game`);
        continue;
      }
      const { r, n } = node[m];
      out.push({ kind: 'tree', path: path.slice(), move: g0.canon(m), pos: posOf(g1), winLen: 1 + treeDepth(n) });
      const g2 = after(g1, r);
      walk(n, [...path, g0.canon(m), r], g2);
    }
  };
  walk(tree, [], g);
  return out;
}
