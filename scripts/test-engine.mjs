// Engine stress test for shared/tak.js.
//   node --no-warnings scripts/test-engine.mjs [--seed N] [--games N] [--quick]
// Exits non-zero on any failure.
//
// 1. Perft vs reference numbers (Tiltak / Topaz test suites, plus a closed-form depth-3 count for
//    every size) and symmetry invariance (8 dihedral transforms x color swap).
// 2. Randomized differential tests: an independent naive move generator, road finder, reserve
//    counter and result() are written below and compared against the engine on every ply of
//    thousands of random playouts; apply/undo, TPS, PTN and Zobrist are round-tripped.
// 3. Hand-built rules edge cases.

import { Game, RESERVES, FLAT, WALL, CAP, winningMoves, mateDistance } from '../shared/tak.js';
import { tagPuzzle, mainLine, dragonForced } from '../shared/analyze.js';

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const QUICK = args.includes('--quick');
const SEED = argVal('--seed', 20261107);
const GAMES = argVal('--games', QUICK ? 60 : 400); // playouts per size
const HEAVY = argVal('--heavy', QUICK ? 8 : 30); // of which this many get the full per-ply treatment (naive movegen diff + sampled round-trips)
const SAMPLE = 4; // random moves per position given the full apply/undo/hash/PTN round-trip treatment

let failures = 0, passes = 0;
const fail = (name, detail) => { failures++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); };
const check = (name, cond, detail) => { if (cond) passes++; else fail(name, typeof detail === 'function' ? detail() : detail); return cond; };
const eq = (name, got, want) => check(name, got === want, () => `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const section = (title) => { console.log(`\n== ${title}`); return Date.now(); };
const done = (t0) => console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// deterministic PRNG
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---------- independent helpers (do not use engine logic beyond reading g.board / g.toMove / g.ply) ----------
const FILES = 'abcdefgh';
const pColor = (p) => (p & 1) + 1, pType = (p) => p >> 1; // engine piece encoding (data format, not logic)
const name = (S, sq) => FILES[sq % S] + (Math.floor(sq / S) + 1);
const STEP = { '+': [1, 0], '-': [-1, 0], '>': [0, 1], '<': [0, -1] };
const topOf = (g, sq) => { const s = g.board[sq]; return s.length ? s[s.length - 1] : null; };

// Fully explicit move string: always count prefix + drop list, e.g. "1a1+1", "3c3>21", "Sa1".
function fmtEngineMove(S, mv) {
  if (mv.kind === 'p') return (mv.type === WALL ? 'S' : mv.type === CAP ? 'C' : 'F') + name(S, mv.sq);
  return mv.drops.reduce((a, b) => a + b, 0) + name(S, mv.sq) + mv.dir + mv.drops.join('');
}

function naiveReserves(g) {
  const S = g.size, used = { 1: [0, 0], 2: [0, 0] };
  for (const st of g.board) for (const p of st) used[pColor(p)][pType(p) === CAP ? 1 : 0]++;
  const [st, cp] = RESERVES[S];
  return { stones: [0, st - used[1][0], st - used[2][0]], caps: [0, cp - used[1][1], cp - used[2][1]] };
}

// Returns Map<explicitMoveString, isSmash>.
function naiveMoves(g) {
  const S = g.size, me = g.toMove, opening = g.ply < 2, out = new Map();
  const res = naiveReserves(g);
  for (let sq = 0; sq < S * S; sq++) {
    const st = g.board[sq];
    if (st.length === 0) {
      if (opening) { out.set('F' + name(S, sq), false); continue; }
      if (res.stones[me] > 0) { out.set('F' + name(S, sq), false); out.set('S' + name(S, sq), false); }
      if (res.caps[me] > 0) out.set('C' + name(S, sq), false);
      continue;
    }
    if (opening || pColor(st[st.length - 1]) !== me) continue;
    for (let n = 1; n <= Math.min(S, st.length); n++) {
      const hand0 = st.slice(st.length - n); // bottom -> top
      for (const dir of '+-><') {
        const [dr, dc] = STEP[dir];
        const walk = (r, c, hand, drops) => {
          r += dr; c += dc;
          if (r < 0 || r >= S || c < 0 || c >= S) return;
          const t = topOf(g, r * S + c);
          if (t !== null && pType(t) === CAP) return;
          if (t !== null && pType(t) === WALL) {
            if (hand.length === 1 && pType(hand[0]) === CAP) out.set(n + name(S, sq) + dir + [...drops, 1].join(''), true);
            return;
          }
          for (let k = 1; k <= hand.length; k++) {
            if (k === hand.length) out.set(n + name(S, sq) + dir + [...drops, k].join(''), false);
            else walk(r, c, hand.slice(k), [...drops, k]);
          }
        };
        walk(Math.floor(sq / S), sq % S, hand0, []);
      }
    }
  }
  return out;
}

function naiveRoad(g, color) {
  const S = g.size;
  const ok = (r, c) => { const t = topOf(g, r * S + c); return t !== null && pColor(t) === color && pType(t) !== WALL; };
  for (const horiz of [true, false]) {
    const seen = new Set(), q = [];
    for (let i = 0; i < S; i++) { const [r, c] = horiz ? [i, 0] : [0, i]; if (ok(r, c)) { seen.add(r * S + c); q.push([r, c]); } }
    while (q.length) {
      const [r, c] = q.shift();
      if (horiz ? c === S - 1 : r === S - 1) return true;
      for (const [dr, dc] of Object.values(STEP)) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < S && cc >= 0 && cc < S && !seen.has(rr * S + cc) && ok(rr, cc)) { seen.add(rr * S + cc); q.push([rr, cc]); }
      }
    }
  }
  return false;
}

function naiveResult(g) {
  const mover = 3 - g.toMove;
  if (naiveRoad(g, mover)) return { winner: mover, kind: 'road' };
  if (naiveRoad(g, 3 - mover)) return { winner: 3 - mover, kind: 'road' };
  const full = g.board.every((s) => s.length > 0);
  const r = naiveReserves(g);
  const out = (c) => r.stones[c] + r.caps[c] === 0;
  if (!full && !out(1) && !out(2)) return null;
  const f = [0, 0, 0];
  for (const s of g.board) if (s.length && pType(s[s.length - 1]) === FLAT) f[pColor(s[s.length - 1])]++;
  const d = f[1] - f[2] - g.komi;
  return d > 0 ? { winner: 1, kind: 'flat' } : d < 0 ? { winner: 2, kind: 'flat' } : { winner: 0, kind: 'draw' };
}

const snap = (g) => g.board.map((st) => st.join('.')).join('|') + `#${g.stones}#${g.caps}#${g.toMove}#${g.ply}#${g.ha}#${g.hb}#${g.komi}`;
const tpsBody = (tps) => tps.split(' ').slice(0, 2).join(' '); // board + side to move (no move number)

// ---------- perft ----------
// Tiltak convention: a terminal position contributes 0 at depth > 0 (1 at depth 0).
function perft(g, d) {
  if (d === 0) return 1;
  const ms = g.legalMoves();
  if (d === 1) return ms.length;
  let n = 0;
  for (const m of ms) { const u = g.apply(m); if (!g.result()) n += perft(g, d - 1); g.undo(u); }
  return n;
}
const perftRoot = (g, d) => (d > 0 && g.ply > 0 && g.result() ? 0 : perft(g, d));
// Topaz convention: never stops at terminal positions.
function perftNoStop(g, d) {
  if (d === 0) return 1;
  const ms = g.legalMoves();
  if (d === 1) return ms.length;
  let n = 0;
  for (const m of ms) { const u = g.apply(m); n += perftNoStop(g, d - 1); g.undo(u); }
  return n;
}
// Closed form for depth 3 from the empty board (no game can end within 3 plies on S>=3):
//   S²(S²-1) opening pairs x [(2 + hasCap)(S²-2) placements + deg(white flat) moves].
const perft3 = (S) => { const n = S * S, cap = RESERVES[S][1] > 0 ? 1 : 0; return n * (n - 1) * (2 + cap) * (n - 2) + (n - 1) * 4 * S * (S - 1); };

// Dihedral transforms + color swap on TPS text, to check perft symmetry invariance.
function parseGrid(tps) {
  const [b, side, mv] = tps.trim().split(/\s+/);
  const rows = b.split('/'), S = rows.length, grid = [];
  rows.forEach((row, ri) => { const r = S - 1 - ri; let c = 0; for (const cell of row.split(',')) { if (/^x\d*$/.test(cell)) { const k = cell.length > 1 ? +cell.slice(1) : 1; for (let i = 0; i < k; i++) grid[r * S + c++] = ''; } else grid[r * S + c++] = cell; } });
  return { S, grid, side: +side, mv: +mv };
}
function gridToTPS({ S, grid, side, mv }) {
  const rows = [];
  for (let r = S - 1; r >= 0; r--) rows.push(Array.from({ length: S }, (_, c) => grid[r * S + c] || 'x').join(','));
  return `${rows.join('/')} ${side} ${mv}`;
}
function variants(tps) {
  const P = parseGrid(tps), S = P.S, out = [];
  const maps = [
    (r, c) => [r, c], (r, c) => [c, S - 1 - r], (r, c) => [S - 1 - r, S - 1 - c], (r, c) => [S - 1 - c, r],
    (r, c) => [r, S - 1 - c], (r, c) => [S - 1 - r, c], (r, c) => [c, r], (r, c) => [S - 1 - c, S - 1 - r],
  ];
  for (const f of maps) for (const swap of [false, true]) {
    const grid = [];
    for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
      const [r2, c2] = f(r, c); let cell = P.grid[r * S + c];
      if (swap) cell = cell.replace(/[12]/g, (d) => (d === '1' ? '2' : '1'));
      grid[r2 * S + c2] = cell;
    }
    const side = swap ? 3 - P.side : P.side;
    const mv = swap && P.side === 2 ? P.mv + 1 : P.mv; // keep ply count >= original (stay out of the opening)
    out.push(gridToTPS({ S, grid, side, mv }));
  }
  return out;
}

{
  const t0 = section('perft');
  // empty boards, every size
  const maxDepth = { 3: 4, 4: 4, 5: QUICK ? 3 : 4, 6: 3, 7: 3, 8: 3 };
  for (let S = 3; S <= 8; S++) {
    const g = new Game(S), n = S * S, h0 = snap(g);
    const want = [1, n, n * (n - 1), perft3(S)];
    for (let d = 0; d <= Math.min(3, maxDepth[S]); d++) eq(`perft ${S}x${S} start d${d}`, perftRoot(g, d), want[d]);
    eq(`perft ${S}x${S} leaves board untouched`, snap(g), h0);
  }
  // Tiltak src/tests/move_gen_5s_tests.rs, move_gen_6s_tests.rs
  if (!QUICK) eq('perft 5x5 start d4 (tiltak)', perftRoot(new Game(5), 4), 2999784);
  const fromMoves = (S, moves) => { const g = new Game(S); for (const m of moves) g.play(m); return g; };
  const refs = [
    ['tiltak 5s perf_test2', 5, ['d3', 'c3', 'c4', '1d3<', '1c4-', 'Sc4'], [1, 87, 6155, 461800]],
    ['tiltak 5s perf_test3', 5, ['c2', 'c3', 'd3', 'b3', 'c4', '1c2+', '1d3<', '1b3>', '1c4-', 'Cc2', 'a1', '1c2+', 'a2'], [1, 104, 7743, 592645]],
    ['tiltak 5s suicide_perf_test', 5, ['c4', 'c2', 'd2', 'c3', 'b2', 'd3', '1d2+', 'b3', 'd2', 'b4', '1c2+', '1b3>', '2d3<', '1c4-', 'd4', '5c3<23', 'c2', 'c4', '1d4<', 'd3', '1d2+', '1c3+', 'Cc3', '2c4>', '1c3<', 'd2', 'c3', '1d2+', '1c3+', '1b4>', '2b3>11', '3c4-12', 'd2', 'c4', 'b4', 'c5', '1b3>', '1c4<', '3c3-', 'e5', 'e2'], [1, 85, 11204, 956736]],
    ['tiltak 6s endgame (playtak #636814)', 6, '2,2,21S,2,2,2/2,x,222221,2,2,x/1,1,2221C,x,111112C,2S/x,1,2S,x2,121211212/1,1,1212S,1S,2,1S/x2,2,1,21,1 1 42', [1, 140, 21402, 2774593]],
  ];
  for (const [label, S, src, want] of refs) {
    const g = typeof src === 'string' ? Game.fromTPS(src) : fromMoves(S, src);
    const dmax = QUICK ? 2 : 3;
    for (let d = 1; d <= dmax; d++) eq(`perft ${label} d${d}`, perftRoot(g, d), want[d]);
    // symmetry: all 16 variants must agree at depth 2 (Tiltak checks the same invariance)
    const tps = g.toTPS();
    const vs = variants(tps).map((v) => perftRoot(Game.fromTPS(v), 2));
    check(`perft ${label} symmetry-invariant d2`, vs.every((x) => x === want[2]), () => `${vs.join(',')} want ${want[2]}`);
  }
  // Topaz src/board.rs basic_perft (6x6, no terminal cut-off)
  {
    const g = fromMoves(6, ['c2', 'c3', 'd3', 'b3', 'c4', '1c2+', '1d3<', '1b3>', '1c4-', 'Cc2', 'a1', '1c2+', 'a2']);
    eq('perft topaz 6s basic d1', perftNoStop(g, 1), 190);
    eq('perft topaz 6s basic d2', perftNoStop(g, 2), 20698);
  }
  done(t0);
}

// ---------- randomized differential playouts ----------
{
  const t0 = section(`random playouts (${GAMES}/size, ${HEAVY} heavy, seed ${SEED})`);
  const stats = { positions: 0, applied: 0, smashes: 0, roads: 0, dragon: 0, flats: 0, draws: 0, maxH: 0 };
  const MAXFAIL = 25;
  for (let S = 3; S <= 8 && failures < MAXFAIL; S++) {
    const keyToBody = new Map();
    for (let gi = 0; gi < GAMES && failures < MAXFAIL; gi++) {
      const g = new Game(S), heavy = gi < HEAVY;
      g.komi = pick([0, 0, 2, 2.5, 0.5]);
      for (let plyN = 0; plyN < 300 && failures < MAXFAIL; plyN++) {
        stats.positions++;
        const tps = g.toTPS(), ctx = `size ${S} game ${gi} ply ${plyN} TPS "${tps}"`;
        // reserves
        const nr = naiveReserves(g);
        check('reserves match naive count', `${g.stones}|${g.caps}` === `${nr.stones}|${nr.caps}`, () => `${ctx}: ${JSON.stringify([g.stones, g.caps])} vs ${JSON.stringify(nr)}`);
        // roads / result
        for (const c of [1, 2]) check('hasRoad matches naive flood fill', g.hasRoad(c) === naiveRoad(g, c), () => `${ctx} color ${c}`);
        const rs = g.roadSquares(1);
        check('roadSquares(1) non-null iff hasRoad(1)', (rs !== null) === g.hasRoad(1), ctx);
        const res = g.result(), nres = plyN > 0 ? naiveResult(g) : null;
        if (plyN > 0) check('result() matches naive', JSON.stringify(res) === JSON.stringify(nres), () => `${ctx}: ${JSON.stringify(res)} vs ${JSON.stringify(nres)}`);
        // TPS round-trip + hash recompute
        const g2 = Game.fromTPS(tps, g.komi);
        if (heavy || plyN % 8 === 0) check('TPS round-trip (text, board, reserves, ply, hash)', g2.toTPS() === tps && snap(g2) === snap(g), () => `${ctx}\n       reparsed: ${g2.toTPS()}`);
        // hash collision detector (distinct positions must not share a key)
        const k = g.key(), body = tpsBody(tps), prev = keyToBody.get(k);
        if (prev === undefined) keyToBody.set(k, body); else check('Zobrist: no collision between distinct positions', prev === body, () => `${k}: "${prev}" vs "${body}"`);
        for (const st of g.board) if (st.length > stats.maxH) stats.maxH = st.length;
        if (res) { stats[res.kind === 'road' ? 'roads' : res.kind === 'flat' ? 'flats' : 'draws']++; if (res.kind === 'road' && g.hasRoad(1) && g.hasRoad(2)) stats.dragon++; break; }

        const moves = g.legalMoves();
        if (!heavy) {
          // light: apply the chosen move, check hash/reserves, undo, compare, redo
          const stack = moves.filter((m) => m.kind === 'm'), smash = stack.filter((m) => m.smash), r = rand();
          const mv = smash.length && r < 0.1 ? pick(smash) : stack.length && r < 0.35 ? pick(stack) : pick(moves);
          const before = snap(g), label = `${ctx} move ${fmtEngineMove(S, mv)}`;
          const u = g.apply(mv); stats.applied++; if (u.smashed) stats.smashes++;
          const g3 = Game.fromTPS(g.toTPS(), g.komi);
          check('incremental Zobrist == from-scratch', g3.ha === g.ha && g3.hb === g.hb, label);
          g.undo(u);
          check('undo restores board+reserves+hash+ply exactly', snap(g) === before, label);
          g.apply(mv);
          continue;
        }
        // legal move generation vs naive
        const eng = moves.map((m) => fmtEngineMove(S, m));
        const naive = naiveMoves(g);
        const engSet = new Set(eng);
        check('legalMoves has no duplicates', engSet.size === eng.length, ctx);
        const missing = [...naive.keys()].filter((m) => !engSet.has(m)), extra = eng.filter((m) => !naive.has(m));
        check('legalMoves == naive generator', !missing.length && !extra.length, () => `${ctx}\n       missing ${missing.slice(0, 8)} extra ${extra.slice(0, 8)}`);
        for (const m of moves) if (m.kind === 'm') check('engine smash flag matches naive', !!m.smash === naive.get(fmtEngineMove(S, m)), () => `${ctx} ${fmtEngineMove(S, m)}`);

        // per-move round-trips on a sample (all smashes + up to 12 others)
        const sample = moves.filter((m) => m.smash).slice(0, 4);
        for (let i = 0; i < SAMPLE && moves.length; i++) sample.push(pick(moves));
        for (const mv of sample) {
          const label = `${ctx} move ${fmtEngineMove(S, mv)}`;
          const ptn = g.moveToPTN(mv), ptnS = g.moveToPTN(mv, true);
          const back = g.parseMove(ptn);
          check('moveToPTN -> parseMove round-trip', fmtEngineMove(S, back) === fmtEngineMove(S, mv) && g.moveToPTN(back) === ptn, () => `${label}: "${ptn}"`);
          check('smash PTN carries * iff smash', ptnS.endsWith('*') === !!mv.smash && g.canon(ptnS) === ptn, () => `${label}: "${ptnS}"`);
          check('explicit PTN canonicalises', g.canon(fmtEngineMove(S, mv).replace(/^F/, '')) === ptn, label);
          const before = snap(g);
          const u = g.apply(mv); stats.applied++; if (u.smashed) stats.smashes++;
          check('apply: smash recorded iff naive smash', !!u.smashed === (mv.kind === 'm' && naive.get(fmtEngineMove(S, mv))), label);
          const after = g.toTPS();
          const g3 = Game.fromTPS(after, g.komi);
          check('incremental Zobrist == from-scratch', g3.ha === g.ha && g3.hb === g.hb, () => `${label} -> "${after}"`);
          const nr2 = naiveReserves(g);
          check('apply keeps reserves consistent', `${g.stones}|${g.caps}` === `${nr2.stones}|${nr2.caps}`, label);
          g.undo(u);
          check('undo restores board+reserves+hash+ply exactly', snap(g) === before, () => `${label}\n       after undo: ${g.toTPS()}`);
        }
        // advance: bias toward stack moves (and smashes) so tall stacks / carries get exercised
        const stack = moves.filter((m) => m.kind === 'm'), smash = stack.filter((m) => m.smash);
        const r = rand();
        const mv = smash.length && r < 0.2 ? pick(smash) : stack.length && r < 0.55 ? pick(stack) : pick(moves);
        g.apply(mv);
      }
    }
  }
  console.log(`   ${GAMES * 6} games (${HEAVY * 6} heavy), ${stats.positions} positions, ${stats.applied} apply/undo, ${stats.smashes} smashes, endings: ${stats.roads} road (${stats.dragon} double-road), ${stats.flats} flat, ${stats.draws} draw; tallest stack ${stats.maxH}`);
  check('playouts exercised smashes', stats.smashes > 0);
  check('playouts exercised flat endings', stats.flats + stats.draws > 0);
  done(t0);
}

// ---------- Solver vs naive minimax ----------
// Uses the (already differential-tested) engine primitives, but none of Solver's TT / ordering / pruning.
function naiveWinning(g, plies) {
  const me = g.toMove, out = [];
  const winsNow = (h) => { const r = h.result(); return r && r.winner === me; };
  for (const m of g.legalMoves()) {
    const u = g.apply(m); let ok;
    const r = g.result();
    if (r) ok = r.winner === me;
    else if (plies < 3) ok = false;
    else {
      ok = true;
      for (const d of g.legalMoves()) {
        const ud = g.apply(d); const rd = g.result(); let lost;
        if (rd) lost = rd.winner === me;
        else { lost = false; for (const a of g.legalMoves()) { const ua = g.apply(a); const w = winsNow(g); g.undo(ua); if (w) { lost = true; break; } } }
        g.undo(ud);
        if (!lost) { ok = false; break; }
      }
    }
    g.undo(u);
    if (ok) out.push(g.moveToPTN(m));
  }
  return out.sort();
}
{
  const t0 = section('solver vs naive minimax (win-in-1 / win-in-3)');
  const want = { 3: QUICK ? 15 : 40, 4: QUICK ? 6 : 20, 5: QUICK ? 2 : 6 };
  let tested = 0, withWin = 0;
  for (const S of [3, 4, 5]) {
    let got = 0;
    for (let tries = 0; got < want[S] && tries < 2000; tries++) {
      const g = new Game(S), hist = [];
      g.komi = pick([0, 0.5, 2]);
      while (g.ply === 0 || !g.result()) {
        hist.push(g.toTPS());
        const ms = g.legalMoves(); const st = ms.filter((m) => m.kind === 'm');
        g.apply(st.length && rand() < 0.4 ? pick(st) : pick(ms));
        if (g.ply > 200) break;
      }
      if (hist.length < 6) continue;
      const tps = hist[hist.length - 1 - Math.floor(rand() * 4)]; // 1–4 plies before the end
      const p = Game.fromTPS(tps, g.komi);
      if (p.ply < 2) continue;
      got++; tested++;
      const n1 = naiveWinning(p, 1), n3 = naiveWinning(p, 3);
      const s1 = winningMoves(p, 1, { maxNodes: 1e8 }).moves.sort(), s3 = winningMoves(p, 3, { maxNodes: 1e8 }).moves.sort();
      if (n3.length) withWin++;
      eq(`winningMoves(1) == naive  [${tps} komi ${g.komi}]`, s1.join(' '), n1.join(' '));
      eq(`winningMoves(3) == naive  [${tps} komi ${g.komi}]`, s3.join(' '), n3.join(' '));
      eq(`mateDistance(3) consistent [${tps}]`, mateDistance(p, 3, { maxNodes: 1e8 }), n1.length ? 1 : n3.length ? 3 : 0);
      eq(`solver leaves position untouched [${tps}]`, p.toTPS(), tps);
    }
  }
  console.log(`   ${tested} positions, ${withWin} with a forced win in ≤3`);
  check('solver test found positions with forced wins', withWin > 0);
  done(t0);
}

// ---------- hand-built rules edge cases ----------
{
  const t0 = section('rules edge cases');
  const legal = (g) => new Set(g.legalMoves().map((m) => g.moveToPTN(m)));
  const has = (tps, ptn) => { const g = Game.fromTPS(tps); return legal(g).has(g.canon(ptn)); };
  const after = (tps, ptn, komi = 0) => { const g = Game.fromTPS(tps, komi); g.play(ptn); return g; };
  const resStr = (g) => { const r = g.result(); return r ? `${r.winner}:${r.kind}` : 'none'; };

  // --- capstone smash ---
  const smashT = 'x5/x5/x,x,2S,x,x/x,x,1C,x,x/x5 1 5'; // white cap c2, black wall c3
  check('cap alone smashes adjacent wall', has(smashT, 'c2+'));
  const norm = (t) => Game.fromTPS(t).toTPS();
  { const g = after(smashT, 'c2+'); eq('smash flattens wall, cap on top', g.toTPS(), norm('x5/x5/x,x,21C,x,x/x5/x5 2 5')); }
  { const g = Game.fromTPS(smashT), h = snap(g); const u = g.apply(g.parseMove('c2+')); g.undo(u); eq('smash undo restores black wall + hash', snap(g), h); eq('smash undo TPS', g.toTPS(), norm(smashT)); }
  check('2-stack under cap cannot smash with 2 in last drop', !has('x5/x5/x,x,2S,x,x/x,x,21C,x,x/x5 1 5', '2c2+'));
  check('cap may smash after spreading: 2c1+11 onto wall at c3', has('x5/x5/x,x,2S,x,x/x5/x,x,21C,x,x 1 5', '2c1+11'));
  check('3c1+21 smash (cap alone last) legal', has('x5/x5/x,x,2S,x,x/x5/x,x,121C,x,x 1 5', '3c1+21'));
  check('3c1+12 (two pieces into the wall) illegal', !has('x5/x5/x,x,2S,x,x/x5/x,x,121C,x,x 1 5', '3c1+12'));
  check('cap smashes own wall too', has('x5/x5/x,x,1S,x,x/x,x,1C,x,x/x5 1 5', 'c2+'));
  check('cap cannot move onto a cap', !has('x5/x5/x,x,2C,x,x/x,x,1C,x,x/x5 1 5', 'c2+'));
  check('cap smashes a wall-topped stack', has('x5/x5/x,x,12S,x,x/x,x,1C,x,x/x5 1 5', 'c2+'));
  check('flat cannot move onto wall', !has('x5/x5/x,x,2S,x,x/x,x,1,x,x/x5 1 5', 'c2+'));
  check('wall cannot move onto wall', !has('x5/x5/x,x,2S,x,x/x,x,1S,x,x/x5 1 5', 'c2+'));
  check('wall cannot move onto cap', !has('x5/x5/x,x,2C,x,x/x,x,1S,x,x/x5 1 5', 'c2+'));
  check('wall can move onto flat', has('x5/x5/x,x,2,x,x/x,x,1S,x,x/x5 1 5', 'c2+'));
  check('cap can move onto flat', has('x5/x5/x,x,2,x,x/x,x,1C,x,x/x5 1 5', 'c2+'));
  check('smash beyond a flat: 2c1+11 over flat c2 into wall c3', has('x5/x5/x,x,2S,x,x/x,x,2,x,x/x,x,21C,x,x 1 5', '2c1+11'));
  { // exact smash sets + no duplicate moves, incl. boundaries where the stack is too short to reach the wall
    const smashes = (tps) => { const g = Game.fromTPS(tps), ms = g.legalMoves(), p = ms.map((m) => g.moveToPTN(m)); return { dup: new Set(p).size !== p.length, s: ms.filter((m) => m.smash).map((m) => g.moveToPTN(m)).sort().join(' ') }; };
    for (const [tps, want] of [
      ['x5/x5/x,x,2S,x,x/x5/x,x,121C,x,x 1 5', '2c1+11 3c1+21'], // wall 2 away, 3-stack
      ['x5/x5/x,x,2S,x,x/x5/x,x,1C,x,x 1 5', ''], // wall 2 away, lone cap can't reach
      ['x5/x5/x,x,2S,x,x/x5/x,x,21C,x,x 1 5', '2c1+11'], // exactly enough pieces
      ['x5/x5/x5/x,x,2S,x,x/x,x,1C,x,x 1 5', 'c1+'], // adjacent
      ['x5/x5/x5/x,x,2S,x,x/x,x,1121C,x,x 1 5', 'c1+'], // adjacent, tall stack: still only the lone cap
      ['x7/x7/x7/x,x,x,2S,x,x,x/x7/x7/x,x,x,1121C,x,x,x 1 10', '3d1+111 4d1+121 4d1+211'],
      ['2S,x4/x5/x5/x5/1111111C,x4 1 20', '4a1+1111 5a1+1121 5a1+1211 5a1+2111'], // 7-stack, carry 5, 3 free squares then wall
      ['2S,x4/x5/x5/x5/1111C,x4 1 20', '4a1+1111'], // 4-stack: exactly enough
      ['2S,x4/x5/x5/x5/111C,x4 1 20', ''], // 3-stack: one short
      ['2S,x5/x6/x6/x6/x6/111111C,x5 1 20', '5a1+11111 6a1+11121 6a1+11211 6a1+12111 6a1+21111'], // 6x6, carry 6, 4 free
    ]) { const r = smashes(tps); eq(`exact smash set [${tps}]`, r.s, want); eq(`no duplicate moves [${tps}]`, r.dup, false); }
  }
  eq('smash completing a road wins', resStr(after('x5/x5/1,1,2S,1,1/x,x,1C,x,x/x5 1 5', 'c2+')), '1:road');
  { const g = after('x5/x5/x,x,2S,x,x/x,x,1C,x,x/x5 1 5', 'c2+'); g.play('a5'); g.play('c3-'); eq('smashed wall stays a flat after the cap leaves', g.toTPS(), norm('2,x4/x5/x,x,2,x,x/x,x,1C,x,x/x5 2 6')); }
  { // smash on 7x7 with two caps and tall carry: 7-stack spread 1111111? limited by distance; 3 pieces 1+1+1 ending with cap on wall
    const t = 'x7/x7/x7/x,x,x,2S,x,x,x/x7/x7/x,x,x,1121C,x,x,x 1 10';
    check('7x7: 3d1+111 smash at d4', has(t, '3d1+111'));
    check('7x7: 4d1+211 smash at d4', has(t, '4d1+211'));
    check('7x7: 4d1+112 (2 into wall) illegal', !has(t, '4d1+112'));
    check('7x7: 4d1+13 (stops short of wall) legal, not a smash', has(t, '4d1+13') && !Game.fromTPS(t).legalMoves().find((m) => Game.fromTPS(t).moveToPTN(m) === '4d1+13').smash);
  }

  // --- carry limit ---
  const tall5 = 'x5/x5/x5/x5/1212121C,x4 1 10'; // 7-high stack, cap on top, a1
  check('carry limit: 5a1> legal on 5x5', has(tall5, '5a1>'));
  check('carry limit: 5a1>1112 legal', has(tall5, '5a1>1112'));
  check('carry limit: 6a1> illegal on 5x5', !has(tall5, '6a1>'));
  check('carry limit: 6a1+1113 illegal on 5x5', !has(tall5, '6a1+1113'));
  check('carry limit: 3x3 carries ≤3', has('x3/x3/2121,x,x 1 10', '3a1>21') && !has('x3/x3/2121,x,x 1 10', '4a1>22'));
  check('carry limit: 8x8 carries 8', has('x8/x8/x8/x8/x8/x8/x8/2121212121,x7 1 20', '8a1>1111112'));
  { const g = Game.fromTPS('x8/x8/x8/x8/x8/x8/x8/2121212121,x7 1 20'); eq('carry limit: max carried on 8x8 from 10-stack', Math.max(...g.legalMoves().filter((m) => m.kind === 'm').map((m) => m.drops.reduce((a, b) => a + b, 0))), 8); }
  { const g = Game.fromTPS(tall5); const mx = Math.max(...g.legalMoves().filter((m) => m.kind === 'm').map((m) => m.drops.reduce((a, b) => a + b, 0))); eq('carry limit: max carried on 5x5 from 7-stack', mx, 5); }
  check('cannot move a stack topped by opponent', !has('x5/x5/x5/x5/12,x4 1 10', 'a1>') && !has('x5/x5/x5/x5/12,x4 1 10', '2a1>'));

  // --- opening swap ---
  {
    const g = new Game(5);
    const m1 = g.legalMoves();
    check('ply 1: only flat placements (25)', m1.length === 25 && m1.every((m) => m.kind === 'p' && m.type === FLAT));
    eq('ply 1: Sa1 illegal', throws(() => g.play('Sa1')), true);
    eq('ply 1: Ca1 illegal', throws(() => g.play('Ca1')), true);
    g.play('a1');
    eq('ply 1: white places a BLACK flat', g.toTPS(), 'x5/x5/x5/x5/2,x4 2 1');
    eq('ply 1: black reserve decremented', `${g.stones[1]},${g.stones[2]}`, '21,20');
    const m2 = g.legalMoves();
    check('ply 2: 24 flat placements, no moving the black flat', m2.length === 24 && m2.every((m) => m.kind === 'p' && m.type === FLAT));
    g.play('e5');
    eq('ply 2: black places a WHITE flat', g.toTPS(), 'x4,1/x5/x5/x5/2,x4 1 2');
    eq('ply 2: white reserve decremented', `${g.stones[1]},${g.stones[2]}`, '20,20');
    const m3 = g.legalMoves();
    check('ply 3: walls/caps allowed, own flat movable', m3.some((m) => m.kind === 'p' && m.type === WALL) && m3.some((m) => m.kind === 'p' && m.type === CAP) && m3.some((m) => m.kind === 'm' && m.sq === 24));
    check('ply 3: cannot move the opponent flat at a1', !m3.some((m) => m.kind === 'm' && m.sq === 0));
    g.play('Sb1');
    eq('ply 3: white places own wall', g.toTPS(), 'x4,1/x5/x5/x5/2,1S,x3 2 2');
    // opening from TPS
    const t = Game.fromTPS('x5/x5/x5/x5/2,x4 2 1');
    eq('opening TPS "2 1" is ply 1', t.ply, 1);
    t.play('b1');
    eq('opening TPS: black places white flat', t.toTPS(), 'x5/x5/x5/x5/2,1,x3 1 2');
  }

  // --- dragon clause / suicide ---
  {
    const t = 'x5/x5/x5/2,2,2,2,21/1,1,1,1,x 1 10'; // e2 = black under white
    const g = after(t, 'e2-');
    check('double road after white move: both roads exist', g.hasRoad(1) && g.hasRoad(2));
    eq('dragon clause: mover (white) wins double road', resStr(g), '1:road');
    eq('suicide: uncovering only opponent road loses', resStr(after(t, 'e2+')), '2:road');
    // mirrored colors: black moves
    const tb = 'x5/x5/x5/1,1,1,1,12/2,2,2,2,x 2 10';
    eq('dragon clause: mover (black) wins double road', resStr(after(tb, 'e2-')), '2:road');
    eq('suicide (black): uncovering white road loses', resStr(after(tb, 'e2+')), '1:road');
    // road beats a simultaneous flat ending (board fills with road)
    eq('road takes precedence over board-full flat count', resStr(after('2,1,2/2,2,1/1,1,x 1 10', 'c1')), '1:road');
  }

  // --- dragon tag: only when the clause is forced (analyze.js dragonForced / tagPuzzle) ---
  {
    const tagsOf = (tps, tree, plies) => { const g = Game.fromTPS(tps); return tagPuzzle(g, mainLine(g, tree), plies, tree); };
    // ps852718: the only road-in-1 (2c4-11) also completes White's road
    const forced = '1,1,1,2C,x/1,x,12,2,x/1,11121,x,1,122221C/12,2,1,2,2/x,1,x2,2 2 25';
    check('dragonForced: only finish is a double road', dragonForced(Game.fromTPS(forced)));
    check('dragon tag: forced double road', tagsOf(forced, 'win', 1).includes('dragon'));
    // p372127: d2+ makes both roads, but 2d2+ wins plainly; whichever finish the main line shows, no tag
    const incidental = 'x4/2,2,2,1/x2,11,12/1,1,1,x 2 7';
    check('dragonForced: a plain road-in-1 exists', !dragonForced(Game.fromTPS(incidental)));
    { const g = Game.fromTPS(incidental); check('dragon tag: incidental double road (d2+) not tagged', !tagPuzzle(g, ['d2+'], 1).includes('dragon')); }
    // p869796: main line 2b4< b3+ 3a4> d2 ends in a forced dragon, but the tree's other key c4< finishes plainly
    const tps5 = 'x3,21S,1/12,121,11,21S,1/x,2,1,21C,2C/2,2,2,x2/x5 1 17';
    const both = { '2b4<': { r: 'b3+', n: { '3a4>': { r: 'd2', n: 'win' }, 'c4<': { r: 'Sa1', n: 'win' } } } };
    const only = { '2b4<': { r: 'b3+', n: { '3a4>': { r: 'd2', n: 'win' } } } };
    check('dragon tag: needs every path (c4< avoids it)', !tagsOf(tps5, both, 5).includes('dragon'));
    check('dragon tag: single path through a forced dragon', tagsOf(tps5, only, 5).includes('dragon'));
    { const g = Game.fromTPS(tps5); check('dragon tag: main line only, without a tree', tagPuzzle(g, mainLine(g, both), 5).includes('dragon')); }
    // no win at all: no tag, and the engine's double-road test position (white could also just place e1) isn't forced
    check('dragonForced: plain e1 beats e2-', !dragonForced(Game.fromTPS('x5/x5/x5/2,2,2,2,21/1,1,1,1,x 1 10')));
  }

  // --- roads: walls/caps/diagonals ---
  {
    eq('cap counts for roads', Game.fromTPS('x5/x5/1,1,1C,1,1/x5/x5 2 10').hasRoad(1), true);
    eq('wall does not count for roads', Game.fromTPS('x5/x5/1,1,1S,1,1/x5/x5 2 10').hasRoad(1), false);
    eq('vertical road', Game.fromTPS('x,1,x3/x,1,x3/x,1C,x3/x,1,x3/x,1,x3 2 10').hasRoad(1), true);
    eq('diagonal contact is not a road', Game.fromTPS('x4,1/x3,1,x/x,x,1,x,x/x,1,x3/1,x4 2 10').hasRoad(1), false);
    eq('snaking road', Game.fromTPS('1,1,x3/x,1,x3/x,1,1,1,x/x3,1,x/x3,1,1 2 10').hasRoad(1), true);
    eq('buried pieces do not count (only tops)', Game.fromTPS('x5/x5/1,1,12,1,1/x5/x5 2 10').hasRoad(1), false);
    eq('edge-to-same-edge is not a road', Game.fromTPS('x5/x5/x5/1,1,1,1,x/1,x,x,1,x 2 10').hasRoad(1), false);
    const rs = Game.fromTPS('x5/x5/1,1,1C,1,1/x5/x5 2 10').roadSquares(1);
    eq('roadSquares returns the road row', rs && rs.join(','), '10,11,12,13,14');
  }

  // --- flat wins: board full ---
  {
    const t = '1,2,1/2,1,2/1,2,x 1 10'; // white fills c1: W a3,c3,b2,a1,c1 =5 vs B 4, no roads
    eq('board full: white 5–4 wins on flats', resStr(after(t, 'c1')), '1:flat');
    eq('board full: komi 1 → draw', resStr(after(t, 'c1', 1)), '0:draw');
    eq('board full: komi 2 → black', resStr(after(t, 'c1', 2)), '2:flat');
    eq('board full: komi 0.5 → white', resStr(after(t, 'c1', 0.5)), '1:flat');
    eq('board full: komi 1.5 → black', resStr(after(t, 'c1', 1.5)), '2:flat');
    eq('walls do not count as flats (4–4 draw)', resStr(after('1S,2,1/2,1,2/1,2,x 1 10', 'c1')), '0:draw');
    eq('filling with a wall: wall not counted (4–4 draw)', resStr(after(t, 'Sc1')), '0:draw');
    eq('not full, reserves left → ongoing', resStr(after('1,2,1/2,1,2/x,2,x 1 10', 'c1')), 'none');
    // caps never count as flats (5x5)
    const c5 = '1C,2,1,2,1/2,1,2,1,2/1,2,1,2,1/2,1,2,1,2/1,2,1,2,x 2 20';
    eq('cap not counted: 5x5 board-full 11–13 incl. black filling', resStr(after(c5, 'e1')), '2:flat');
    eq('flatCounts excludes the cap', Game.fromTPS(c5).flatCounts().join(','), '0,11,12');
    eq('filling with own cap: cap not counted → 11–12 black', resStr(after(c5, 'Ce1')), '2:flat');
  }

  // --- flat wins: reserves exhausted ---
  {
    // 3x3: white has 9 stones on a1 stack (top black) + 0 reserves after placing the 10th
    const t = 'x3/x3/1111111112,x,x 1 10'; // white 9 on board (1 left), black 1
    eq('reserves: white has 1 stone left', Game.fromTPS(t).stones[1], 1);
    eq('reserves exhausted: 1–1 → draw', resStr(after(t, 'c3')), '0:draw');
    eq('reserves exhausted: komi 0.5 → black', resStr(after(t, 'c3', 0.5)), '2:flat');
    eq('reserves exhausted: black more flats', resStr(after('x3/x,2,x/1111111112,x,x 1 10', 'c3')), '2:flat');
    eq('reserves exhausted via wall: wall not counted (0–1 black)', resStr(after(t, 'Sc3')), '2:flat');
    // black exhausts its reserves
    eq('reserves exhausted by black', resStr(after('x3/x,1,x/2222222221,x,x 2 10', 'c3')), '1:flat');
    // 5x5: stones gone but cap left → game continues; placing the cap ends it
    const s5 = 'x5/x5/x5/x5/111111111111111111111,2,x3 1 30'; // 21 white stones used, cap in hand
    const g = Game.fromTPS(s5);
    eq('5x5: 0 stones + 1 cap → not over', `${g.stones[1]},${g.caps[1]}`, '0,1');
    check('5x5: only cap placements available for white', g.legalMoves().filter((m) => m.kind === 'p').every((m) => m.type === CAP));
    eq('5x5: placing last piece (cap) ends game; cap not counted', resStr(after(s5, 'Ce5')), '0:draw');
    eq('5x5: moving instead of placing does not end game', resStr(after(s5, 'a1>')), 'none');
    // reserves-exhaustion where the last placement makes a road → road wins
    eq('last stone completes a road → road, not flats', resStr(after('x3/x3/11111111,1,x 1 10', 'c1')), '1:road');
  }

  // --- Zobrist: every coloring of a stack up to height 10 (+ top type, + side to move) hashes distinctly ---
  {
    const keys = new Map(); let n = 0, clash = null;
    for (let h = 1; h <= 10; h++) for (let bits = 0; bits < 1 << h; bits++) for (const top of ['', 'S', 'C']) for (const side of [1, 2]) {
      const stack = Array.from({ length: h }, (_, i) => ((bits >> i) & 1) + 1).join('') + top;
      const t = `x6/x6/x6/x6/x6/${stack},x5 ${side} 30`;
      const k = Game.fromTPS(t).key(); n++;
      if (keys.has(k) && !clash) clash = `${keys.get(k)} vs ${t}`; else keys.set(k, t);
    }
    check(`Zobrist distinct over ${n} stack colorings`, !clash, clash);
  }

  // --- TPS / PTN parsing ---
  {
    check('TPS rejects wrong row length', throws(() => Game.fromTPS('x4/x5/x5/x5/x5 1 1')));
    check('TPS rejects too many pieces', throws(() => Game.fromTPS('x3/x3/11111111111,x,x 1 10')));
    eq('TPS accepts [TPS "…"] wrapper', Game.fromTPS('[TPS "x5/x5/x5/x5/2,x4 2 1"]').toTPS(), 'x5/x5/x5/x5/2,x4 2 1');
    const g = new Game(5);
    eq('PTN: 1a1>1 canonicalises to a1>', g.canon('1a1>1'), 'a1>');
    eq('PTN: 3c3+3 → 3c3+', g.canon('3c3+3'), '3c3+');
    eq('PTN: Fa1 → a1', g.canon('Fa1'), 'a1');
    eq('PTN: annotations stripped', g.canon("2c3>11*'!"), '2c3>11');
    check('PTN: drop sum mismatch throws', throws(() => g.parseMove('3a1>11')));
  }
  done(t0);
}

console.log(`\n${failures ? 'FAILED' : 'OK'}: ${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
