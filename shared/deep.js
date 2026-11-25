// Deep puzzle analysis (tinuë in 4+ of the attacker's moves, i.e. 7+ plies) on top of the df-pn
// prover in pns.js. Same output shape as analyze() in analyze.js, so miners and the importer treat
// deep and shallow puzzles alike.
//
//   analyzeDeep(tps, {komi, line, maxPlies = 15, maxNodes, ...}) →
//     {ok:true, plies, tree, rootWins, mainLine, tags, rating, factors, nodes, attNodes, prover:'pns', ...}
//   | {ok:false, reason, ...}
//
// Tree construction (attacker node with R plies left):
//   R ≤ 5  → analyze.js buildTree: exact brute force, every winning move (quiet ones included).
//   R ≥ 7  → keys = every attacker move that still forces a road within R under the prover's model
//            (Tak threats + immediate wins). Each key gets ONE defender reply, chosen to
//            (a) resist longest, (b) leave the fewest winning continuations, (c) match the real game,
//            (d) prefer walls/caps — the same policy as analyze.js's chooseReply.
//
// CAVEAT: at R ≥ 7 only Tak-threat moves are proven, so a (rare) quiet attacker move that also wins
// within R is NOT a key and the browser would mark it wrong. At R ≤ 5 the brute-force tree accepts
// everything. Positions whose real shortest win is ≤ 5 plies (including via a quiet move — checked by
// brute force at the root when affordable) are rejected: the shallow pipeline owns them.
//
// Any budget overrun anywhere → ok:false. A partial tree is never returned, because a missing key
// would mark a correct move wrong.
import { Game, Solver, colorOf, WALL, CAP } from './tak.js';
import { buildTree, mainLine, tagPuzzle, priorRating, PRIOR_MIN, PRIOR_MAX } from './analyze.js';
import { TinueSearch, shortestTinue, threatMoves, defenderMoves } from './pns.js';

// Base prior for long tinuës (analyze.js's BASE_BY_PLIES stops at 9 and is tuned for brute-force node counts).
export const DEEP_BASE = { 7: 2400, 9: 2600, 11: 2750, 13: 2850 };
const deepBase = (p) => DEEP_BASE[p] ?? (p > 13 ? 2850 : 2400);

class Fail extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const isBudget = (e) => e && e.message === 'budget';
// thread CPU ms where available (wall time is meaningless on a loaded box), else wall ms
const cpuMs = () => { const u = globalThis.process?.threadCpuUsage?.(); return u ? (u.user + u.system) / 1000 : Date.now(); };

const typeScore = (mv) => (mv.kind === 'p' ? (mv.type === WALL ? 0 : mv.type === CAP ? 1 : 2) : 3);
const canonOr = (g, ptn) => { try { return ptn ? g.canon(ptn) : null; } catch { return null; } };

// Attacker nodes in a tree ('win' leaves count as one node: the player still has to find the move).
export function countAttackerNodes(t) {
  if (t === 'win') return 1;
  let n = 1;
  for (const v of Object.values(t)) if (v) n += countAttackerNodes(v.n);
  return n;
}

export function analyzeDeep(tps, {
  komi = 0, line = [], maxPlies = 15,
  maxNodes = 4e4,          // df-pn budget per solve() call (MID calls; ~0.2–0.5 ms each on 6x6)
  rootNodes = 2e5,         // budget for the root shortestTinue
  totalNodes = 2e6,        // df-pn budget for the whole tree
  maxTree = 300,           // cap on attacker nodes in the tree
  bruteNodes = 1.5e7,      // analyze.js buildTree budget for the R ≤ 5 tails
  quietCheckNodes = 3e6,   // brute-force "is there a ≤5-ply win (quiet move)?" at the root, first pass; 0 = skip
  quietFinalNodes = 3e7,   // ...resumed (same table) with this budget once the tree is built; still unknown → ok:false
  replyCountCap = 12,      // at most this many longest-resisting replies get their continuations counted
  deadline = Infinity,     // Date.now() cutoff
} = {}) {
  const g0 = Game.fromTPS(tps, komi);
  if (g0.result()) return { ok: false, reason: 'game over' };
  const T = { root: 0, quiet: 0, brute: 0, tree: 0 };
  let t0 = cpuMs();
  const A = g0.toMove;

  // 1. exact shortest threat-restricted tinuë
  const st = shortestTinue(g0, maxPlies, { maxNodes: rootNodes, pv: true });
  T.root = Math.round(cpuMs() - t0);
  const base = { nodes: st.nodes, pnsResult: st.result, pnsPlies: st.plies, cpu: T };
  if (st.result !== 'proved') return { ok: false, reason: st.result === 'unknown' ? 'root budget' : 'no tinue', ...base };
  if (!st.exact) return { ok: false, reason: 'inexact length', lowerBound: st.lowerBound, ...base };
  if (st.plies < 7) return { ok: false, reason: 'shallow', ...base };
  if (st.plies > maxPlies) return { ok: false, reason: 'too deep', ...base };
  const plies = st.plies;

  // 1b. a quiet-move win in ≤ 5 plies would make this a shallow puzzle (and the deep tree would miss it)
  //     An exhaustive 6x6 win-in-5 refutation often needs 3e6–1e7 Solver nodes, so a cheap first pass
  //     that runs out is resumed with a bigger budget after the tree is built (most candidates fail
  //     before that). A check that never finishes rejects the position: passing it silently would
  //     publish puzzles whose real solution (a ≤5-ply quiet win) is marked wrong.
  let quiet = null, qtt = null;
  const quietCheck = (budget) => {
    const t1 = cpuMs();
    const qs = new Solver(g0.clone(), { maxNodes: budget }); // fresh clone: a budget throw leaves moves applied
    if (qtt) qs.tt = qtt; qtt = qs.tt;                         // table is keyed by position, safe to reuse
    try { for (let p = 1; p <= 5; p += 2) if (qs.winIn(p)) return p; return 0; }
    catch (e) { if (e.message === 'budget') return -1; throw e; }
    finally { T.quiet += Math.round(cpuMs() - t1); }
  };
  if (quietCheckNodes) {
    quiet = quietCheck(quietCheckNodes);
    if (quiet > 0) return { ok: false, reason: 'shallow (quiet)', quietPlies: quiet, ...base };
  }

  // 2. tree. One df-pn search (attacker = A) shared across the whole tree: its table is keyed on
  //    (position, depth), so proofs found for one branch are reused by transposed branches.
  const h = g0.clone();
  const s = new TinueSearch(h, { maxNodes: 0 });
  let attNodes = 0;
  t0 = cpuMs();
  const solve = (d) => {
    if (Date.now() > deadline) throw new Fail('deadline');
    if (s.nodes > totalNodes) throw new Fail('tree node budget');
    s.maxNodes = s.nodes + maxNodes;
    try { return s.solve(d); } catch (e) { if (isBudget(e)) return null; throw e; }
  };
  const bump = (n) => { attNodes += n; if (attNodes > maxTree) throw new Fail('tree too large'); };

  // attacker keys at R ≥ 7: immediate wins + threat moves proven within R. Returns [{mv, ptn, end}].
  const keysAt = (R) => {
    const out = [], seen = new Set();
    for (const mv of h.legalMoves()) {
      const u = h.apply(mv); const r = h.result(); h.undo(u);
      if (r && r.winner === A) { const p = h.moveToPTN(mv); seen.add(p); out.push({ mv, ptn: p, end: true }); }
    }
    for (const mv of threatMoves(h)) {
      const p = h.moveToPTN(mv);
      if (seen.has(p)) continue;
      const u = h.apply(mv);
      try {
        if (h.result()) continue; // threatMoves keeps attacker wins only; those were caught above
        const ok = solve(R - 1);
        if (ok === null) throw new Fail('key budget');
        if (ok) out.push({ mv, ptn: p, end: false });
      } finally { h.undo(u); }
    }
    return out;
  };

  // number of attacker winning continuations within R (threat model; a ranking heuristic only)
  const countWins = (R) => {
    let n = 0;
    for (const mv of h.legalMoves()) { const u = h.apply(mv); const r = h.result(); h.undo(u); if (r && r.winner === A) n++; }
    if (R < 3) return n;
    for (const mv of threatMoves(h)) {
      const u = h.apply(mv);
      try { if (!h.result()) { const ok = solve(R - 1); if (ok === null) return n + 50; if (ok) n++; } }
      finally { h.undo(u); }
    }
    return n;
  };

  // defender to move (after attacker key), R = attacker's plies left after this reply.
  const chooseReply = (R, srcReply) => {
    let cands = defenderMoves(h, A);
    if (!cands.length) cands = h.legalMoves();
    const keep = [];
    for (const r of cands) {
      const u = h.apply(r);
      try {
        const res = h.result();
        if (res) { if (res.winner !== A) throw new Fail('defender escapes (prover bug?)'); continue; }
        const faster = R >= 3 ? solve(R - 2) : false; // does this reply allow a win within R-2?
        if (faster === null || faster) continue; // unknown or shorter: not a longest-resisting reply
        const within = solve(R);
        if (within !== true) throw new Fail(within === null ? 'reply budget' : 'reply escapes (prover bug?)');
        keep.push({ r, ptn: h.moveToPTN(r), nWins: 0 });
      } finally { h.undo(u); }
    }
    if (!keep.length) throw new Fail('no longest-resisting reply proven');
    keep.sort((x, y) => (y.ptn === srcReply) - (x.ptn === srcReply) || typeScore(x.r) - typeScore(y.r));
    const pool = keep.slice(0, replyCountCap);
    if (pool.length > 1) for (const c of pool) {
      const u = h.apply(c.r);
      try { c.nWins = countWins(R); } finally { h.undo(u); }
    }
    pool.sort((x, y) => x.nWins - y.nWins || (y.ptn === srcReply) - (x.ptn === srcReply) || typeScore(x.r) - typeScore(y.r));
    return pool[0].r;
  };

  const build = (R, ln) => {
    if (Date.now() > deadline) throw new Fail('deadline');
    if (R <= 5) {
      let t;
      const tb = cpuMs();
      try { t = buildTree(h, R, ln, bruteNodes); }
      catch (e) { if (isBudget(e)) throw new Fail('brute tail budget'); if (/no winning moves/.test(e.message)) throw new Fail('brute tail found no win'); throw e; }
      finally { T.brute += cpuMs() - tb; }
      bump(countAttackerNodes(t));
      return t;
    }
    bump(1);
    const keys = keysAt(R);
    if (!keys.length) throw new Fail('no keys at R=' + R);
    const want = canonOr(h, ln[0]);
    keys.sort((x, y) => (y.ptn === want) - (x.ptn === want));
    const node = {};
    for (const k of keys) {
      const u = h.apply(k.mv);
      try {
        if (k.end) { node[k.ptn] = null; continue; }
        const onLine = k.ptn === want;
        const src = onLine ? canonOr(h, ln[1]) : null;
        const r = chooseReply(R - 2, src);
        const rp = h.moveToPTN(r);
        const u2 = h.apply(r);
        try {
          if (h.result()) throw new Fail('reply ends game');
          node[k.ptn] = { r: rp, n: build(R - 2, onLine && rp === src ? ln.slice(2) : []) };
        } finally { h.undo(u2); }
      } finally { h.undo(u); }
    }
    return node;
  };

  let tree;
  try { tree = build(plies, line.slice()); }
  catch (e) {
    T.tree = Math.round(cpuMs() - t0); T.brute = Math.round(T.brute); if (e instanceof Fail) return { ok: false, reason: e.reason, plies, attNodes, ...base, nodes: st.nodes + s.nodes }; throw e; }
  const nodes = st.nodes + s.nodes;
  T.tree = Math.round(cpuMs() - t0); T.brute = Math.round(T.brute);

  // 2b. finish an inconclusive quiet check
  if (quiet === -1) {
    quiet = quietCheck(quietFinalNodes);
    if (quiet > 0) return { ok: false, reason: 'shallow (quiet)', quietPlies: quiet, plies, attNodes, ...base, nodes };
    if (quiet < 0) return { ok: false, reason: 'quiet check budget', plies, attNodes, ...base, nodes };
  }

  // 3. main line, sanity replay, tags, rating
  const ml = mainLine(g0, tree, line);
  const chk = g0.clone();
  for (const m of ml) chk.play(m);
  const fin = chk.result();
  if (!fin || fin.winner !== A || ml.length !== plies) return { ok: false, reason: `main line check failed (${ml.length} plies, ${fin ? fin.kind + ' ' + fin.winner : 'no result'})`, plies, nodes, cpu: T };
  const tags = tagPuzzle(g0, ml, plies, tree);
  const rootWins = Object.keys(tree).length;
  const first = g0.parseMove(ml[0]);
  // priorRating without `nodes` (its search adjustment is calibrated on brute-force node counts), then rebase.
  const pr = priorRating({ plies, size: g0.size, rootWins, tags, firstMoveKind: first.kind, firstMoveDrops: first.kind === 'm' ? first.drops.length : 0 });
  const factors = { ...pr.factors, base: deepBase(plies) };
  // df-pn effort: ~log of proof size relative to a typical deep proof (≈10^3.7 MID calls at the root)
  factors.search = Math.round(Math.max(-100, Math.min(120, 50 * (Math.log10(Math.max(1, st.nodes)) - 3.7))));
  const r = Object.values(factors).reduce((a, b) => a + b, 0);
  const rating = Math.round(Math.max(PRIOR_MIN, Math.min(PRIOR_MAX, r)));
  return { ok: true, plies, tree, rootWins, mainLine: ml, tags, rating, factors, nodes, attNodes, prover: 'pns', pnsPv: st.pv, quietCheck: quietCheckNodes ? 'none ≤5' : 'skipped', cpu: T };
}
