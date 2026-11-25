// Property-based tests: random inputs (seeded, reproducible), checking laws rather than examples.
//   node scripts/test-props.mjs [--seed N] [--runs N]
// Ratings: every result stays finite and in bounds, moves the right way, scales linearly with its weight, and gets
// bigger against stronger puzzles; the clueless rule; replays telescope. PTN: canonPTN and the PlayTak notation
// converter agree with the engine on every legal move of random games, in every spelling PTN allows.
// (The rules engine itself has its own randomized differential tests in test-engine.mjs.) On a failure it prints the
// seed and the smallest failing input it could shrink to.
import assert from 'node:assert/strict';
import { rate, replayGuest, PLAYER_START, provisional } from '../shared/rating.js';
import { RD_MIN, PROVISIONAL_RD, expected } from '../shared/glicko.js';
import { canonPTN, ptnFromServer, replay } from '../shared/ptn.js';
import { Game } from '../shared/tak.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const SEED = arg('--seed', 20261115), RUNS = arg('--runs', 3000);

// mulberry32: small seeded PRNG
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; }; }
const R = rng(SEED);
const uni = (lo, hi) => lo + (hi - lo) * R();
const pick = (xs) => xs[Math.floor(R() * xs.length)];
// Edges show up more often than uniform sampling would give them.
const rd = () => pick([RD_MIN, 500, 229.99, 230, PROVISIONAL_RD, uni(RD_MIN, 500), uni(RD_MIN, 500)]);
const player = () => ({ rating: pick([100, 3500, uni(100, 3500), uni(1000, 2500)]), rd: rd(), vol: pick([0.06, 0.09, 0.1, uni(0.02, 0.1)]) });

let checks = 0;
// forAll(name, gen, prop): prop returns nothing or throws. On failure, try to shrink each numeric field toward round
// values while it still fails, then report.
function forAll(name, gen, prop, runs = RUNS) {
  for (let i = 0; i < runs; i++) {
    const x = gen();
    try { prop(x); checks++; } catch (e) {
      const small = shrink(x, prop);
      console.error(`FAIL ${name} (seed ${SEED}, run ${i})\n  input: ${JSON.stringify(small)}\n  ${e.message.split('\n')[0]}`);
      process.exit(1);
    }
  }
  console.log(`ok ${name} (${runs})`);
}
function shrink(x, prop) {
  const fails = (y) => { try { prop(y); return false; } catch { return true; } };
  let cur = structuredClone(x);
  for (let pass = 0; pass < 4; pass++) {
    const walk = (o) => {
      for (const k of Object.keys(o)) {
        if (o[k] && typeof o[k] === 'object') walk(o[k]);
        else if (typeof o[k] === 'number') for (const v of [Math.round(o[k]), Math.round(o[k] / 10) * 10, Math.round(o[k] / 100) * 100]) {
          const old = o[k]; o[k] = v; if (!fails(cur)) o[k] = old; else break;
        }
      }
    };
    walk(cur);
  }
  return cur;
}
const finite = (r) => Number.isFinite(r.rating) && Number.isFinite(r.rd) && Number.isFinite(r.vol);
const inBounds = (r) => r.rd >= RD_MIN - 1e-9 && r.rd <= 500 + 1e-9 && r.vol > 0 && r.vol <= 0.1 + 1e-12;

// ---------- ratings ----------
forAll('rate: finite, in bounds, the right direction for both sides', () => ({ u: player(), p: player(), win: R() < 0.5, w: pick([1, 0.7, 0.1, R()]) }), ({ u, p, win, w }) => {
  const r = rate(u, p, win, w, w * pick([1, 0.5]));
  assert.ok(finite(r.user) && finite(r.puzzle), 'non-finite');
  assert.ok(inBounds(r.user) && inBounds(r.puzzle), `out of bounds ${JSON.stringify(r)}`);
  if (win) assert.ok(r.userDelta >= 0 && r.puzzleDelta <= 0, `win moved ${r.userDelta} / ${r.puzzleDelta}`);
  else assert.ok(r.userDelta <= 0 && r.puzzleDelta >= 0, `loss moved ${r.userDelta} / ${r.puzzleDelta}`);
});

forAll('rate: a weighted result moves exactly that fraction of a full one', () => ({ u: player(), p: player(), win: R() < 0.5, w: R() }), ({ u, p, win, w }) => {
  const full = rate(u, p, win), part = rate(u, p, win, w, w);
  assert.ok(Math.abs(part.userDelta - w * full.userDelta) < 1e-6, `${part.userDelta} vs ${w} × ${full.userDelta}`);
  assert.ok(Math.abs(part.puzzleDelta - w * full.puzzleDelta) < 1e-6);
});

forAll('rate: a stronger puzzle is worth more (win gains more, loss costs less)', () => ({ u: player(), p: player(), d: uni(1, 800), win: R() < 0.5 }), ({ u, p, d, win }) => {
  const weak = rate(u, p, win), strong = rate(u, { ...p, rating: p.rating + d }, win);
  assert.ok(strong.userDelta >= weak.userDelta - 1e-9, `${strong.userDelta} < ${weak.userDelta}`);
});

forAll('rate: a less certain player moves more on the same result', () => ({ u: player(), p: player(), d: uni(0, 300), win: R() < 0.5 }), ({ u, p, d, win }) => {
  const sure = rate(u, p, win), unsure = rate({ ...u, rd: Math.min(500, u.rd + d) }, p, win);
  assert.ok(Math.abs(unsure.userDelta) >= Math.abs(sure.userDelta) - 1e-9, `${unsure.userDelta} vs ${sure.userDelta}`);
});

forAll('rate: the clueless rule (rd >= 230 never moves a puzzle; below it, a decisive result does)', () => ({ u: player(), p: player(), win: R() < 0.5 }), ({ u, p, win }) => {
  const r = rate(u, p, win);
  if (u.rd >= 230) assert.equal(r.puzzleDelta, 0);
  else assert.ok(r.puzzleDelta !== 0, 'a settled player left the puzzle where it was');
});

forAll('expected score: in (0, 1), and higher the stronger you are', () => ({ a: player(), b: player(), d: uni(1, 500) }), ({ a, b, d }) => {
  const e = expected(a, b), e2 = expected({ ...a, rating: a.rating + d }, b);
  assert.ok(e > 0 && e < 1 && e2 > e);
});

forAll('provisional exactly at rd >= 110', () => ({ r: player() }), ({ r }) => assert.equal(provisional(r), r.rd >= PROVISIONAL_RD));

forAll('replayGuest: a fold of rate() whose deltas telescope to the final rating', () => ({
  rows: Array.from({ length: Math.floor(R() * 25) }, () => ({ puzzle_rating: R() < 0.05 ? null : uni(400, 3000), prd: rd(), win: R() < 0.5 ? 1 : 0, hinted: R() < 0.15 ? 1 : 0 })),
}), ({ rows }) => {
  const g = replayGuest(rows);
  const sum = g.attempts.reduce((s, a) => s + a.user_delta, PLAYER_START.rating);
  assert.ok(Math.abs(sum - g.rating.rating) < 1e-6, `${sum} vs ${g.rating.rating}`);
  assert.equal(g.games, rows.filter((a) => !a.hinted && a.puzzle_rating != null).length);
  assert.ok(g.wins <= g.games && finite(g.rating) && inBounds(g.rating));
}, 600);

// ---------- PTN ----------
// Random positions from random playouts on every size, as TPS (readable when a property fails).
function randomTPS() {
  const g = new Game(pick([3, 4, 5, 6, 7, 8]));
  for (let n = Math.floor(R() * 60); n > 0 && !g.result(); n--) g.apply(pick(g.legalMoves()));
  return g.toTPS();
}
// Every way PTN lets you write the same move (F prefix, explicit count of 1, a lone drop equal to the count, marks).
function spellings(g, mv) {
  const c = g.moveToPTN(mv), out = [c, c + "'", c + '!', c + '?', c + "''", c + "'!"];
  if (mv.kind === 'p' && !/^[SC]/.test(c)) out.push('F' + c);
  if (mv.kind === 'm') { // ('*' marks a stack move that flattens a wall; placements can't carry it)
    out.push(c + '*', c + "*'");
    const count = mv.drops.reduce((a, b) => a + b, 0), sq = g.sqName(mv.sq);
    out.push(`${count}${sq}${mv.dir}${mv.drops.join('')}`);
    if (count === 1) out.push(`1${sq}${mv.dir}`, `${sq}${mv.dir}1`);
  }
  return out;
}
// PlayTak's server notation for a move: "P A1 [W|C]" / "M A1 C1 2 1".
function serverNotation(g, mv) {
  const sq = g.sqName(mv.sq).toUpperCase();
  if (mv.kind === 'p') return `P ${sq}${mv.type === 1 ? ' W' : mv.type === 2 ? ' C' : ''}`;
  const [dr, dc] = { '+': [1, 0], '-': [-1, 0], '>': [0, 1], '<': [0, -1] }[mv.dir];
  const r = Math.floor(mv.sq / g.size) + dr * mv.drops.length, c = (mv.sq % g.size) + dc * mv.drops.length;
  return `M ${sq} ${g.sqName(r * g.size + c).toUpperCase()} ${mv.drops.join(' ')}`;
}

forAll('canonPTN and Game.canon agree on every spelling of every legal move, and canonPTN is idempotent', () => ({ tps: randomTPS() }), ({ tps }) => {
  const g = Game.fromTPS(tps);
  for (const mv of g.legalMoves()) {
    const want = g.moveToPTN(mv);
    for (const s of spellings(g, mv)) {
      assert.equal(canonPTN(s), want, `canonPTN(${s})`);
      assert.equal(g.canon(s), want, `Game.canon(${s})`);
      assert.equal(canonPTN(canonPTN(s)), canonPTN(s));
    }
  }
}, 300);

forAll('ptnFromServer inverts PlayTak notation for every legal move', () => ({ tps: randomTPS() }), ({ tps }) => {
  const g = Game.fromTPS(tps);
  for (const mv of g.legalMoves()) assert.equal(ptnFromServer(serverNotation(g, mv)), g.moveToPTN(mv), serverNotation(g, mv));
}, 300);

forAll('replay(PTN text) reproduces a random game from its TPS start', () => ({ seedPly: Math.floor(R() * 20), len: Math.floor(R() * 25), size: pick([4, 5, 6, 7]) }), ({ seedPly, len, size }) => {
  const g = new Game(size);
  for (let i = 0; i < seedPly && !g.result(); i++) g.apply(pick(g.legalMoves()));
  const start = g.toTPS(), moves = [];
  for (let i = 0; i < len && !g.result(); i++) { const mv = pick(g.legalMoves()); moves.push(g.moveToPTN(mv)); g.apply(mv); }
  const text = `[Size "${size}"]\n[TPS "${start}"]\n[Komi "2"]\n\n` + moves.map((m, i) => (i % 2 ? m : `${i / 2 + 1}. ${m}`)).join(' ');
  const r = replay(text);
  assert.equal(r.g.toTPS(), g.toTPS()); assert.equal(r.g.komi, 2); assert.deepEqual(r.moves, moves);
}, 500);

console.log(`\nOK: ${checks} property checks (seed ${SEED})`);
