// Offline puzzle analysis: solution tree, tactic tags, and a difficulty prior.
// Shared so the browser could run it too (e.g. for user-submitted positions), but normally run at ingest.
import { Game, Solver, winningMoves, colorOf, typeOf, FLAT, WALL, DIRS } from './tak.js';

const immediateWins = (g) => {
  const me = g.toMove, out = [];
  for (const m of g.legalMoves()) {
    const u = g.apply(m); const r = g.result(); g.undo(u);
    if (r && r.winner === me) out.push(m);
  }
  return out;
};

// Immediate wins for `color` as if it were their turn (null-move "is it Tak?" test).
export function threats(g, color) {
  if (g.toMove === color) return immediateWins(g);
  const h = g.clone(); h.toMove = color; return immediateWins(h);
}

// Distance (plies) to a forced win for side to move, up to `max`; 0 if none found. Also returns nodes used.
export function mateIn(g, max, maxNodes = 4e7) {
  const s = new Solver(g, { maxNodes });
  try { for (let p = 1; p <= max; p += 2) if (s.winIn(p)) return { plies: p, nodes: s.nodes }; }
  catch (e) { if (e.message === 'budget') return { plies: -1, nodes: s.nodes }; throw e; }
  return { plies: 0, nodes: s.nodes };
}

// Pick the defender's reply: resist longest, then leave the attacker the fewest winning options,
// then prefer the move the real game (source line) played, then walls/caps (the "just block it" convention).
function chooseReply(g, attPlies, sourceReply, maxNodes) {
  const replies = g.legalMoves();
  const scored = [];
  for (const r of replies) {
    const u = g.apply(r);
    const res = g.result();
    let fast = 0, nWins = 0;
    if (!res) {
      const w1 = immediateWins(g).length;
      fast = w1 ? 1 : 3;
      nWins = w1;
    }
    g.undo(u);
    if (res) continue; // a reply that ends the game would be a loss for defender by construction
    scored.push({ r, ptn: g.moveToPTN(r), fast, nWins });
  }
  const maxFast = Math.max(...scored.map((s) => s.fast));
  let pool = scored.filter((s) => s.fast === maxFast);
  if (maxFast >= 3 && attPlies >= 3) {
    // count attacker's winning continuations for (up to) 30 candidates — expensive, so cap it.
    const cand = pool.slice(0, 30);
    for (const c of cand) {
      const u = g.apply(c.r);
      try { c.nWins = winningMoves(g, attPlies, { maxNodes }).moves.length; } catch { c.nWins = 99; }
      g.undo(u);
    }
    pool = cand;
  }
  const typeScore = (s) => (s.r.kind === 'p' ? (s.r.type === WALL ? 0 : s.r.type === 2 ? 1 : 2) : 3);
  pool.sort((a, b) => a.nWins - b.nWins || (b.ptn === sourceReply) - (a.ptn === sourceReply) || typeScore(a) - typeScore(b));
  if (!pool.length) throw new Error('budget'); // every reply ends the game — degenerate, skip
  return pool[0].ptn;
}

// Tree: 'win' (any immediate win accepted) or { ptn: null | {r: reply, n: subtree} }.
// Every move that still forces a win within the remaining plies is a key, so alternates are accepted.
export function buildTree(g, plies, line = [], maxNodes = 2e7) {
  if (plies <= 1) return 'win';
  const { moves } = winningMoves(g, plies, { maxNodes });
  if (!moves.length) throw new Error('no winning moves at ' + g.toTPS());
  const want = line[0] && moves.includes(g.canon(line[0])) ? g.canon(line[0]) : null;
  if (want) moves.sort((a, b) => (b === want) - (a === want));
  const node = {};
  for (const m of moves) {
    const u = g.apply(g.parseMove(m));
    const res = g.result();
    if (res) { node[m] = null; g.undo(u); continue; }
    const onLine = m === want;
    let srcReply = null;
    if (onLine && line[1]) { try { srcReply = g.canon(line[1]); } catch {} }
    const reply = chooseReply(g, plies - 2, srcReply, maxNodes);
    const u2 = g.apply(g.parseMove(reply));
    node[m] = { r: reply, n: buildTree(g, plies - 2, onLine && reply === srcReply ? line.slice(2) : [], maxNodes) };
    g.undo(u2);
    g.undo(u);
  }
  // put immediate wins last unless they're the only thing (so the main line is the "real" tinue)
  return node;
}

// Main line through the tree: first key at each node, ending with a winning move.
export function mainLine(g0, tree, src = []) {
  const g = g0.clone(), line = [];
  let node = tree;
  for (;;) {
    let mv;
    if (node === 'win') {
      const w = immediateWins(g);
      // prefer the most "interesting" finisher: stack moves first
      const want = src[line.length] && (() => { try { return g.canon(src[line.length]); } catch { return null; } })();
      w.sort((a, b) => (g.moveToPTN(b) === want) - (g.moveToPTN(a) === want) || (b.kind === 'm') - (a.kind === 'm'));
      mv = w[0] && g.moveToPTN(w[0]);
      if (!mv) break;
      g.play(mv); line.push(mv); break;
    }
    mv = Object.keys(node)[0];
    g.play(mv); line.push(mv);
    if (!node[mv]) break;
    g.play(node[mv].r); line.push(node[mv].r);
    node = node[mv].n;
  }
  return line;
}

// The dragon clause decides this position: the side to move has an immediate win and every one of them also
// completes the opponent's road (no plain road, no flat win), so it only wins because the mover takes a double road.
// A double road that sits beside a plain one is no motif: on p654631 2d3-11 makes both roads, but carrying one more
// stone (3d3-12) keeps the opponent's flat covered and wins plainly.
export function dragonForced(g) {
  const A = g.toMove;
  let n = 0;
  for (const m of g.legalMoves()) {
    const u = g.apply(m); const r = g.result();
    const win = r && r.winner === A, plain = win && !(r.kind === 'road' && g.hasRoad(3 - A));
    g.undo(u);
    if (plain) return false;
    if (win) n++;
  }
  return n > 0;
}

// Every way to win through the tree ends in a forced dragon: at each 'win' leaf all road-in-1s are double roads,
// and every immediate-win key (null) is one. A tree where some attacker key reaches a plain finish isn't a dragon
// puzzle, even if its main line is (p869796: 3a4> leads to a forced dragon, c4< to a plain road).
function dragonEveryPath(g, node) {
  if (node === 'win') return dragonForced(g);
  for (const [k, v] of Object.entries(node)) {
    const u = g.apply(g.parseMove(k));
    let ok;
    if (!v) { const r = g.result(); ok = !!r && r.kind === 'road' && g.hasRoad(g.toMove); }
    else { const u2 = g.apply(g.parseMove(v.r)); ok = dragonEveryPath(g, v.n); g.undo(u2); }
    g.undo(u);
    if (!ok) return false;
  }
  return true;
}

// Tags from the main line (Lichess cook.py style: predicates over the solution). `tree` (optional) lets 'dragon'
// require the clause on every winning path, not just the main line's.
export function tagPuzzle(g0, line, plies, tree = null) {
  const tags = new Set();
  const A = g0.toMove, D = 3 - A;
  tags.add('s' + g0.size);
  const g = g0.clone();
  if (plies > 1 && threats(g, D).length) tags.add('wallBlock');
  let anyQuiet = false, allPlace = true;
  let final = null, finalMv = null, finalRoad = null;
  const attMoves = [];
  for (let i = 0; i < line.length; i++) {
    const mine = i % 2 === 0;
    const mv = g.parseMove(line[i]);
    const before = mine && mv.kind === 'm' ? g.board.map((s) => s.slice()) : null;
    // dragon: decided before the final move, over all the finishes available there (the main line's is just one)
    if (mine && i === line.length - 1 && dragonForced(g) && (!tree || dragonEveryPath(g0.clone(), tree))) tags.add('dragon');
    g.apply(mv);
    if (!mine) continue;
    attMoves.push({ mv, before });
    if (mv.kind === 'm') allPlace = false;
    if (mv.smash) tags.add('smash');
    if (i === line.length - 1) { final = g.result(); finalMv = mv; finalRoad = g.roadSquares(A); break; }
    const t = threats(g, A);
    if (!t.length) anyQuiet = true;
    else {
      // double Tak: road-completing placements on two different empty squares
      const holes = new Set(t.filter((m) => m.kind === 'p').map((m) => m.sq));
      if (holes.size >= 2) tags.add('fork');
    }
  }
  if (plies === 1) tags.add(final?.kind === 'flat' ? 'gaelet' : 'roadIn1');
  else if (final?.kind === 'flat') tags.add('gaelet');
  else tags.add(plies === 3 ? 'tinueIn2' : plies === 5 ? 'tinueIn3' : 'tinueIn4');
  // A non-Tak tinuë is a forced ROAD whose line includes a move that threatens no road. A forced flat win
  // (gaelet) threatens no road on almost every move, so it never gets this tag.
  if (anyQuiet && final?.kind !== 'flat') tags.add('quietMove');
  if (allPlace) tags.add('placement');
  // stack-move motifs
  const size = g0.size;
  // replay to inspect each attacker stack move's after-state
  const h = g0.clone();
  for (let i = 0; i < line.length; i++) {
    const mv = h.parseMove(line[i]);
    const mine = i % 2 === 0;
    const beforeTops = mine && mv.kind === 'm' ? h.board.map((s) => (s.length ? s[s.length - 1] : -1)) : null;
    h.apply(mv);
    if (!beforeTops) continue;
    const [dr, dc] = DIRS[mv.dir];
    const sqs = []; let r = Math.floor(mv.sq / size), c = mv.sq % size;
    for (let k = 0; k < mv.drops.length; k++) { r += dr; c += dc; sqs.push(r * size + c); }
    const topsAfter = sqs.map((s) => h.top(s));
    if (i === 0 && beforeTops[sqs[0]] >= 0 && colorOf(beforeTops[sqs[0]]) === D) tags.add('capture');
    if (mv.drops.length >= 2) {
      if (topsAfter.every((t) => colorOf(t) === A)) tags.add('spread');
      else tags.add('throw');
    }
    const srcTop = h.top(mv.sq);
    if (i === line.length - 1 && finalRoad && sqs.filter((s) => finalRoad.includes(s)).length >= 2 && mv.drops.length >= 2) tags.add('stackRoad');
    // reveal (drawbridge): a wall walks off its stack and uncovers our own flat, which joins the road
    if (typeOf(beforeTops[mv.sq]) === WALL && srcTop >= 0 && colorOf(srcTop) === A && typeOf(srcTop) === FLAT && finalRoad?.includes(mv.sq)) tags.add('reveal');
  }
  return [...tags];
}

// Difficulty prior (chess-puzzle-like scale). Base by length, then nudges for things that make Tak
// tactics harder to see. Calibrate later by regressing observed puzzle ratings on these features.
export const BASE_BY_PLIES = { 1: 900, 3: 1500, 5: 2100, 7: 2450, 9: 2700 };
// Clamp for priors. Was 2900, a guess made when puzzles were ≤5 ply (max prior ~2600); deep 7–15 ply priors reach
// ~3430, and a 2900 ceiling tied 16% of them. Glicko itself has no upper bound.
export const PRIOR_MIN = 500, PRIOR_MAX = 3500;
export function priorRating({ plies, size, rootWins, tags, nodes, firstMoveKind, firstMoveDrops }) {
  let r = BASE_BY_PLIES[plies] ?? 2700;
  const f = { base: r };
  const adj = (k, v) => { r += v; f[k] = Math.round(v); };
  adj('options', -Math.min(300, 110 * Math.log2(Math.max(1, rootWins))));
  if (firstMoveKind === 'm') adj('stackMove', firstMoveDrops >= 2 ? 160 : 90);
  if (tags.includes('smash')) adj('smash', 60);
  if (tags.includes('quietMove')) adj('quiet', 140);
  if (tags.includes('wallBlock')) adj('defendFirst', 110);
  if (tags.includes('throw')) adj('throw', 80);
  if (tags.includes('reveal')) adj('reveal', 80);
  adj('size', { 3: -150, 4: -90, 5: 0, 6: 50, 7: 100, 8: 150 }[size] ?? 0);
  if (nodes) adj('search', Math.max(-120, Math.min(160, 55 * (Math.log10(nodes) - (plies <= 1 ? 2 : plies === 3 ? 3.5 : 5)))));
  return { rating: Math.round(Math.max(PRIOR_MIN, Math.min(PRIOR_MAX, r))), factors: f };
}

// Full analysis for one position. `line` = source solution moves (optional).
export function analyze(tps, { plies: hintPlies, line = [], maxPlies = 5, komi = 0, maxNodes = 2e7 } = {}) {
  const g = Game.fromTPS(tps, komi);
  const { plies, nodes } = mateIn(g, Math.max(hintPlies || 0, maxPlies), maxNodes * 2);
  if (plies <= 0) return { ok: false, reason: plies < 0 ? 'search budget exceeded' : 'no forced win found', nodes };
  let tree;
  try { tree = buildTree(g, plies, line, maxNodes); }
  catch (e) { if (e.message === 'budget') return { ok: false, reason: 'tree budget exceeded', plies, nodes }; throw e; }
  const rootWins = tree === 'win' ? immediateWins(g).length : Object.keys(tree).length;
  const ml = mainLine(g, tree, line);
  const tags = tagPuzzle(g, ml, plies, tree);
  const first = g.parseMove(ml[0]);
  const { rating, factors } = priorRating({ plies, size: g.size, rootWins, tags, nodes, firstMoveKind: first.kind, firstMoveDrops: first.kind === 'm' ? first.drops.length : 0 });
  return { ok: true, plies, tree, rootWins, mainLine: ml, tags, rating, factors, nodes, shorterThanSource: hintPlies && plies < hintPlies };
}
