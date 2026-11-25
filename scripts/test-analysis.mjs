// The analysis page's pure parts (public/analysis.js) and the vendored lz-string compressor; the solver line's words
// (engine.js noWinText) and the legal prefix of an engine line the panel plays (playon.js legalPrefix).
//   node scripts/test-analysis.mjs
import assert from 'node:assert/strict';
import { THREAT_R, THREAT_ON, ALT_IN, ninjaUrl, solverLines, fromSyntaks, fromTiltak, fromChild, endLine, quickLine, evalLabel, mergeLines, pickCandidates, pinnedAt, moveShape, dispPoint, shapesSvg, threatGroups, chipLabel, numberedPV, ptnParts } from '../public/analysis.js';
import { Game, winningMoves } from '../shared/tak.js';
import { noWinText } from '../public/engine.js';
import { legalPrefix } from '../public/playon.js';
import { compressToEncodedURIComponent as lz } from '../public/vendor/lz-string.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

// lz-string's decompressFromEncodedURIComponent (MIT), test-only: the page never decompresses.
function unlz(input) {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';
  const at = (i) => ALPHA.indexOf(input.charAt(i));
  const d = { val: at(0), pos: 32, index: 1 };
  const read = (n) => {
    let bits = 0;
    for (let p = 1; p !== 1 << n; p <<= 1) {
      const b = d.val & d.pos;
      d.pos >>= 1;
      if (d.pos === 0) { d.pos = 32; d.val = at(d.index++); }
      if (b) bits |= p;
    }
    return bits;
  };
  const dict = [0, 1, 2], out = [];
  let enlargeIn = 4, size = 4, numBits = 3;
  const first = read(2);
  if (first === 2) return '';
  let w = String.fromCharCode(read(first ? 16 : 8));
  dict[3] = w; out.push(w);
  for (;;) {
    if (d.index > input.length) return '';
    let c = read(numBits);
    if (c === 2) return out.join('');
    if (c < 2) { dict[size++] = String.fromCharCode(read(c ? 16 : 8)); c = size - 1; enlargeIn--; }
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
    const entry = dict[c] ? dict[c] : c === size ? w + w.charAt(0) : null;
    if (entry == null) return null;
    out.push(entry);
    dict[size++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
  }
}

// A real PTN Ninja link (docs/tak-feedback-lessons.html:9 in the main checkout, made by ptn.ninja itself).
const NINJA = 'NoZQlgLgpgBARABQDYEMCeAVFBrAdAYwHsBbOAXQChgBRANygDsJ4B5BpMB2ZdcqgERTR4AJgAMIgCy4xAZlwiAHH2A80UAE4BGeAHEArlADOEAGyyRKtZpHws2CGHxgUDAEKEIKgMJJC+bFExAC4xGABqWTEVACVjfSRmOAAxAFpoylAwAC9YOFMVZNQII3gonxQAB1K4LRUWSsZOAHN4IwB3Kr4KLVwYFB0AMx0RPqhZGG8AE0kYeRh8CamJ6Rgp23xZgFY+-FsAI1nTMdsUWYB2Pu8oWagtmEU+wfup+4BOMdN+2y0xPpQJvsJlpejAoDplgA+GBaUYLWQAHn6klSMPmIiBSJQInCMNWICBMC2APCIlhMJ2MH2thE41RWmOax02Jhl36E2x0K0jypslRyxhHzm1PC5OWqPEuxGZwloOpMBE6wlcPWyIV8xZA1xUj6mOREspBImxL5FgVjOpSJEWoVbIJtlM2IlPIJEImIiF+y0SNdcz+MEdWlFIPJsimQbmoJA4bWXwsfXDuJjsnm4zmUBEqNkqwzYK2uNklMGXyhc0ZgwmdzmbMGNKgpmhsh59Zgg1msiFAtpfJgkn9abSYiAA';

test('lz-string: a real PTN Ninja link decompresses to a 6x6 PTN and recompresses byte for byte', () => {
  const ptn = unlz(NINJA);
  assert.ok(ptn && ptn.includes('[Size "6"]'), ptn);
  assert.equal(lz(ptn), NINJA);
});

test('lz-string: round trips, including characters past 255 and repeats that grow the code width', () => {
  const cases = ['', 'a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[Komi "2"]\n1. a1 f6 2. Sb4 3c3>12*', 'tinue #812 — 6×6 ✓ 🐢',
    Array.from({ length: 3000 }, (_, i) => String.fromCharCode(32 + ((i * 7919) % 400))).join('')];
  for (const s of cases) assert.equal(unlz(lz(s)), s, JSON.stringify(s.slice(0, 30)));
  assert.equal(lz(null), '');
  assert.match(lz('[Size "6"]\n\n1. a1 f6'), /^[A-Za-z0-9+\-$]+$/); // URI-safe alphabet only
});

test('ninjaUrl: ply omitted at the start, ply - 1 with "!" after it, name percent-encoded', () => {
  const id = (s) => s;
  assert.equal(ninjaUrl({ ptn: 'X', ply: 0 }, id), 'https://ptn.ninja/X');
  assert.equal(ninjaUrl({ ptn: 'X', ply: 5 }, id), 'https://ptn.ninja/X&ply=4!');
  assert.equal(ninjaUrl({ ptn: 'X', ply: 1, name: 'tinue #812' }, id), 'https://ptn.ninja/X&name=tinue%20%23812&ply=0!');
  assert.equal(ninjaUrl({ ptn: 'X' }, id), 'https://ptn.ninja/X'); // no ply given: the start
  const u = ninjaUrl({ ptn: '[Size "6"]\n\n1. a1 f6', ply: 2, name: 'tinue #a1' }, lz);
  assert.equal(unlz(u.slice('https://ptn.ninja/'.length).split('&')[0]), '[Size "6"]\n\n1. a1 f6');
  assert.ok(!u.includes('#'), u); // a raw # would end the URL's path
});

// ---- solverLines (the tactics worker's 'lines') ----
const OPEN5 = 'x6/x6/x6/x6/1,1,1,1,1,x/2,2,2,2,x2 1 6'; // White wins at once (f2)
const ONE_THREAT = 'x6/x6/x6/1,1,1,1,x2/x6/2,2,2,2,2,x 1 6'; // Black threatens f1 only; White can block it
const TWO_THREATS = '2,2,2,2,2,x/x6/1,1,x4/x6/x6/2,2,2,2,2,x 1 8'; // Black threatens f1 and f6: one move can't stop both
const WIN3 = '2,2,x4/x6/x6/x6/1,1,1,1,x2/x5,1 1 4'; // White: e2 threatens f2 and e1 (e1-f1) at once
// A wide middlegame (the design notes' wm.mjs position): the 3-ply search needs far more than 1e3 nodes
const WIDE = '2,2,21S,2,2,2/2,x,222221,2,2,x/1,1,2221C,x,111112C,2S/x,1,2S,x2,121211212/1,1,1212S,1S,2,1S/x2,2,1,21,1 1 42';

test('solverLines: wins1/wins3 are tak.js winningMoves (wins3 without the wins1 moves), and g is left as it was', () => {
  for (const tps of [OPEN5, ONE_THREAT, TWO_THREATS, WIN3, WIDE]) {
    const g = Game.fromTPS(tps, 2), r = solverLines(g);
    assert.equal(g.toTPS(), Game.fromTPS(tps, 2).toTPS(), tps);
    const w1 = winningMoves(g, 1).moves, w3 = winningMoves(g, 3, { maxNodes: 3e5 }).moves;
    assert.deepEqual(r.wins1, w1, tps); assert.deepEqual(r.wins3, w3.filter((m) => !w1.includes(m)), tps);
    assert.equal(r.partial, false); assert.equal(r.over, null);
  }
  assert.deepEqual(solverLines(Game.fromTPS(OPEN5)).wins1, ['f2', 'Cf2']);
  assert.deepEqual(solverLines(Game.fromTPS(WIN3)).wins3, ['e1', 'Ce1', 'e2', 'Ce2']);
});

test('solverLines: one road threat is not tinuë; two that one move cannot stop are', () => {
  const one = solverLines(Game.fromTPS(ONE_THREAT));
  assert.deepEqual(one.threats, ['f1']); assert.equal(one.tinue, false); assert.deepEqual(one.wins1, []);
  const two = solverLines(Game.fromTPS(TWO_THREATS));
  assert.deepEqual(two.threats, ['f1', 'f6']); assert.equal(two.tinue, true);
  const none = solverLines(Game.fromTPS(OPEN5)); // the side to move wins at once: no tinuë, whatever it faces
  assert.deepEqual(none.threats, []); assert.equal(none.tinue, false);
  // the same double threat, but White can win at once first (a3..e3, f3 empty): not tinuë
  const race = solverLines(Game.fromTPS('2,2,2,2,2,x/x6/x6/1,1,1,1,1,x/x6/2,2,2,2,2,x 1 8'));
  assert.deepEqual(race.wins1, ['f3', 'Cf3']); assert.equal(race.tinue, false); assert.deepEqual(race.threats, ['f1', 'f6']);
});

test('solverLines: pinned verdicts, by canonical move; unknown when partial or illegal', () => {
  const r = solverLines(Game.fromTPS(WIN3), { pinned: ['e2', 'Ce2', 'a5', 'a6', 'zz', 'f2'] });
  assert.deepEqual(r.pinned, { e2: 'win3', Ce2: 'win3', a5: 'no3', a6: '?', zz: '?', f2: 'no3' }); // a6: occupied
  assert.deepEqual(solverLines(Game.fromTPS(OPEN5), { pinned: ['f2', 'a6'] }).pinned, { f2: 'win1', a6: 'no3' });
  const p = solverLines(Game.fromTPS(OPEN5), { budget: 1e3, pinned: ['f2', 'a6'] });
  assert.equal(p.partial, true); assert.equal(p.wins3, null); assert.deepEqual(p.pinned, { f2: 'win1', a6: '?' }); // wins1 needs no budget
});

test('solverLines: budget 1e3 on a wide position is partial (wins3 null); 3e5 finishes', () => {
  const g = Game.fromTPS(WIDE, 2);
  const p = solverLines(g, { budget: 1e3 });
  assert.equal(p.partial, true); assert.equal(p.wins3, null); assert.deepEqual(p.wins1, []);
  const t = performance.now(), full = solverLines(g);
  const ms = performance.now() - t;
  assert.equal(full.partial, false); assert.deepEqual(full.wins3, []);
  console.log(`   (3e5 budget on the wide position: ${ms.toFixed(0)} ms)`);
});

test('solverLines: a finished game says so and nothing else', () => {
  const g = Game.fromTPS(OPEN5); g.play('f2');
  const r = solverLines(g, { pinned: ['a6'] });
  assert.deepEqual(r, { wins1: [], wins3: [], partial: false, threats: [], tinue: false, pinned: { a6: '?' }, over: { winner: 1, kind: 'road' } });
});


// ---------- the line model (step 4) ----------
const W = 1, B = 2;
test('fromSyntaks: mate is signed from White, read from the mover; winProb is White\'s', () => {
  const l = fromSyntaks({ move: 'Sb4', pv: ['Sb4', 'c4'], mate: -2, winProb: 0, depth: 9 }, B);
  assert.deepEqual(l.ev, { kind: 'win', n: 2, proven: false });
  assert.equal(evalLabel(l.ev), 'wins in 2');
  assert.equal(l.move, 'Sb4'); assert.equal(l.src, 'syntaks'); assert.equal(l.depth, 9);
  assert.deepEqual(fromSyntaks({ pv: ['a1'], mate: -3 }, W).ev, { kind: 'loss', n: 3, proven: false });
  assert.equal(evalLabel(fromSyntaks({ pv: ['a1'], mate: -3 }, W).ev), 'loses in 3');
  assert.equal(fromSyntaks({ pv: ['a1'], winProb: 0.58 }, W).ev.p, 0.58);
  assert.ok(Math.abs(fromSyntaks({ pv: ['a1'], winProb: 0.58 }, B).ev.p - 0.42) < 1e-9);
  assert.equal(fromSyntaks({ pv: [], best: 'c3', winProb: 0.5 }, W).move, 'c3');
});
test('fromTiltak / fromChild: White-view chances read from the mover; a child prepends the move', () => {
  assert.equal(fromTiltak({ pv: ['c3', 'd4'], winProb: 0.7 }, W).ev.p, 0.7);
  const c = fromChild({ winProb: 0.3, pv: ['d4', 'e5'] }, 'c3', B);
  assert.ok(Math.abs(c.ev.p - 0.7) < 1e-9); assert.equal(evalLabel(c.ev), '70%');
  assert.deepEqual(c.pv, ['c3', 'd4', 'e5']); assert.equal(c.src, 'tiltak'); assert.equal(c.move, 'c3');
  // a mate the mover gives from the child is one move longer from here; one the opponent gives is as long
  assert.deepEqual(fromChild({ engine: 'syntaks', mate: 2, pv: [] }, 'a1', W).ev, { kind: 'win', n: 3, proven: false });
  assert.deepEqual(fromChild({ engine: 'syntaks', mate: 2, pv: [] }, 'a1', B).ev, { kind: 'loss', n: 2, proven: false });
  assert.equal(fromChild({ engine: 'syntaks', mate: 2, pv: [] }, 'a1', W).src, 'syntaks');
});
test('evalLabel: the chip\'s words', () => {
  assert.equal(evalLabel({ kind: 'win', n: 1, proven: true }), 'wins in 1');
  assert.equal(evalLabel({ kind: 'prob', p: 0.53 }), 'even');
  assert.equal(evalLabel({ kind: 'prob', p: 0.42 }), '42%');
  assert.equal(evalLabel({ kind: 'nowin', n: 2 }), 'no win ≤2');
  assert.equal(evalLabel({ kind: 'pending' }), '…');
});
const L = (move, ev, extra = {}) => ({ move, pv: [move], ev, src: 'tiltak', tags: [], ...extra });
test('mergeLines: order is wins (fewest moves) > chances > no win > losses > pending', () => {
  const got = mergeLines([L('a1', { kind: 'prob', p: 0.4 }), L('b1', { kind: 'loss', n: 2, proven: false }), L('c1', { kind: 'pending' }),
    L('d1', { kind: 'win', n: 3, proven: false }), L('e1', { kind: 'prob', p: 0.6 }), L('f1', { kind: 'nowin', n: 2 }), L('a2', { kind: 'win', n: 2, proven: false })], null, [], 10);
  assert.deepEqual(got.map((l) => l.move), ['a2', 'd1', 'e1', 'a1', 'f1', 'b1', 'c1']);
  assert.deepEqual(mergeLines(got, null, [], 3).map((l) => l.move), ['a2', 'd1', 'e1']);
});
test('mergeLines: the same move from Syntaks and the solver is one line, proven, tags merged', () => {
  const sol = { wins1: [], wins3: ['Sb4'], pinned: {} };
  const got = mergeLines([fromSyntaks({ pv: ['c4'], winProb: 0.62 }, W), fromSyntaks({ pv: ['Sb4', 'c5'], winProb: 0.9 }, W)], sol,
    [{ move: 'Sb4', pv: ['Sb4'], ev: { kind: 'win', n: 3, proven: true }, src: 'puzzle', tags: ['puzzle'] }]);
  assert.equal(got.length, 2);
  assert.equal(got[0].move, 'Sb4'); assert.deepEqual(got[0].ev, { kind: 'win', n: 2, proven: true });
  assert.deepEqual(got[0].tags, ['puzzle']); assert.deepEqual(got[0].pv, ['Sb4', 'c5']);
  // a solver win nobody searched is a line of its own; canon makes '1a1>' and 'a1>' one move
  const g2 = mergeLines([L('a1>', { kind: 'prob', p: 0.5 })], { wins1: ['a1>'], wins3: ['b2'] }, [], 3, (m) => m.replace(/^1/, ''));
  assert.deepEqual(g2.map((l) => [l.move, l.ev.n, l.ev.proven]), [['a1>', 1, true], ['b2', 2, true]]);
  assert.deepEqual(mergeLines([L('1a1>', { kind: 'prob', p: 0.5 })], { wins1: ['a1>'], wins3: [] }, [], 3, (m) => m.replace(/^1/, '')).length, 1);
});
test('mergeLines: pinned lines are kept past the cap (the puzzle\'s move and one of yours, never more); the solver\'s verdict fills a pending one', () => {
  const eng = ['a1', 'b1', 'c1', 'd1'].map((m, i) => L(m, { kind: 'prob', p: 0.9 - i / 10 }));
  const pins = [{ move: 'e1', pv: ['e1'], ev: { kind: 'pending' }, src: 'puzzle', tags: ['yours'] },
    { move: 'e2', pv: ['e2'], ev: { kind: 'pending' }, src: 'puzzle', tags: ['played'] }];
  const got = mergeLines(eng, { wins1: [], wins3: [], pinned: { e1: 'no3' } }, pins, 3);
  assert.deepEqual(got.map((l) => l.move), ['a1', 'b1', 'c1', 'e1']);
  assert.deepEqual(got[3].ev, { kind: 'nowin', n: 2 }); assert.deepEqual(got[3].tags, ['yours']);
  // 'played' is a tag on a line, never a line of its own
  const p2 = mergeLines(eng, null, [{ ...pins[1], move: 'b1' }], 3);
  assert.deepEqual(p2[1].tags, ['played']);
  const many = Array.from({ length: 4 }, (_, i) => ({ move: 'f' + (i + 1), pv: [], ev: { kind: 'pending' }, src: 'puzzle', tags: ['yours'] }));
  assert.deepEqual(mergeLines(eng, null, many, 3).map((l) => l.move), ['a1', 'b1', 'c1', 'f1'], 'one of yours past three, not four (a fifth row scrolled)');
  const puz = { move: 'g1', pv: ['g1'], ev: { kind: 'prob', p: 0.1 }, src: 'puzzle', tags: ['puzzle'] };
  assert.deepEqual(mergeLines(eng, null, [...many, puz], 3).map((l) => l.move), ['a1', 'b1', 'c1', 'g1', 'f1'], 'the puzzle\'s move too');
});
test('pickCandidates: yours, then the solver\'s wins in 2, then runner-ups; never line 1, a win in 1 or the puzzle\'s move', () => {
  const pinned = [{ move: 'Sb4', tags: ['puzzle'] }, { move: 'd2', tags: ['yours'] }];
  const solver = { wins1: ['f1'], wins3: ['Sb4', 'c3', 'e2'] };
  assert.deepEqual(pickCandidates({ line1: 'c3', solver, pinned, runnerUps: ['a1', 'f1'], max: 2 }), ['d2', 'e2']);
  assert.deepEqual(pickCandidates({ line1: 'c3', solver, pinned, runnerUps: ['a1', 'f1'], max: 4 }), ['d2', 'e2', 'a1']);
  assert.deepEqual(pickCandidates({ line1: 'a1', solver: null, pinned: [], runnerUps: ['a1', 'b1', 'b1', 'c1'], max: 1 }), ['b1']);
});
test('pinnedAt: the puzzle\'s move (proven by its line), yours, the game\'s; nothing on your own line', () => {
  const official = ['a1', 'f6', 'c3', 'd4', 'Sb4', 'c4', 'b5'];
  const base = { official, histLen: 4, solver: 1, misses: [{ at: 0, ptn: 'b5' }], tree: [3, null, 1] };
  const at4 = pinnedAt({ ...base, at: 4, mover: 1, onBranch: false });
  assert.deepEqual(at4.map((p) => [p.move, p.tags[0], p.ev.kind, p.ev.n]), [['Sb4', 'puzzle', 'win', 2], ['b5', 'yours', 'pending', undefined]]);
  assert.deepEqual(at4[0].pv, ['Sb4', 'c4', 'b5']); assert.equal(at4[0].ev.proven, true);
  assert.deepEqual(pinnedAt({ ...base, at: 5, mover: 2, onBranch: false }), []); // the defender's move: no pin
  assert.deepEqual(pinnedAt({ ...base, at: 2, mover: 1, onBranch: false }).map((p) => p.tags[0]), ['played']);
  assert.deepEqual(pinnedAt({ ...base, at: 4, mover: 1, onBranch: true }), []);
  assert.deepEqual(pinnedAt({ ...base, at: 4, mover: 1, onBranch: false, tree: [] }).map((p) => p.tags[0]), ['yours']);
});
test('pinnedAt: a play-on game won (or a slow win) after the tree\'s moves is no puzzle move, and n is the tree\'s', () => {
  // history (2), the tree's Sb4 c4, then a play-on game: a3 (the player's unproven move) a4 b5 e2 b4 (a road)
  const official = ['a1', 'f6', 'Sb4', 'c4', 'a3', 'a4', 'b5', 'e2', 'b4'];
  const base = { official, histLen: 2, solver: 1, misses: [], onBranch: false, tree: [5, null] };
  const at2 = pinnedAt({ ...base, at: 2, mover: 1 });
  assert.deepEqual(at2.map((p) => [p.move, p.tags[0], p.ev.n, p.ev.proven]), [['Sb4', 'puzzle', 3, true]]);
  assert.deepEqual(at2[0].pv, ['Sb4', 'c4'], 'only the tree\'s moves as its line');
  for (const at of [4, 6, 8]) assert.deepEqual(pinnedAt({ ...base, at, mover: 1 }), [], `ply ${at}: the play-on game`);
});
test('mergeLines: one MultiPV search\'s lines keep the engine\'s order (a stale lower line never jumps a deeper one)', () => {
  // the real cut search (review-server/mpv2.mjs): d13 b3 59%, d13 d2 53.8%, d12 e4 55.7% (stale, shallower)
  const r = [{ pv: ['b3'], winProb: 0.59 }, { pv: ['d2'], winProb: 0.538 }, { pv: ['e4'], winProb: 0.557 }];
  const lines = r.map((l, i) => fromSyntaks(l, W, i));
  const got = mergeLines(lines, null, [], 3);
  assert.deepEqual(got.map((l) => l.move), ['b3', 'd2', 'e4']);
  assert.equal(evalLabel(got[2].ev), '56%', 'each shows its own chance');
  // even line 1 below a stale line 2 stays first (its arrow and the header are line 1's)
  assert.deepEqual(mergeLines([fromSyntaks({ pv: ['a1'], winProb: 0.4 }, W, 0), fromSyntaks({ pv: ['b1'], winProb: 0.6 }, W, 1)], null).map((l) => l.move), ['a1', 'b1']);
  // a line from another search (your miss, searched on its own) still ranks by its chance among them
  const yours = fromChild({ engine: 'syntaks', winProb: 0.45, pv: [] }, 'c1', B); // Black's view: 55%
  assert.deepEqual(mergeLines([...r.map((l, i) => fromSyntaks(l, W, i)), yours], null, [], 5).map((l) => l.move), ['b3', 'c1', 'd2', 'e4']);
  // without mpv (Tiltak, older callers) chances sort as before
  assert.deepEqual(mergeLines(r.map((l) => fromSyntaks(l, W)), null).map((l) => l.move), ['b3', 'e4', 'd2']);
});
test('quickLine: a move that hands over a win in 1 is a proven "loses in 1", not Tiltak\'s "0%"', () => {
  // Black to move; White's a1-e1 wants only f1. a6 leaves it (Tiltak on the child: cp 100, no mate, so fromChild said 0%).
  const g = Game.fromTPS('x6/x6/x6/2,2,2,2,x2/x6/1,1,1,1,1,x 2 6', 2), c = g.clone(); c.play('a6');
  const l = quickLine(c, 'a6', B);
  assert.deepEqual([l.move, l.pv, l.ev], ['a6', ['a6', 'f1'], { kind: 'loss', n: 1, proven: true }]);
  assert.equal(evalLabel(l.ev), 'loses in 1');
  assert.equal(evalLabel(fromChild({ winProb: 1, pv: ['f1'] }, 'a6', B).ev), '0%', 'what a search of it said');
  // a proof outranks a later engine opinion of the same move, so the chip stays red
  assert.deepEqual(mergeLines([l, fromChild({ winProb: 1, pv: ['f1'] }, 'a6', B)], null)[0].ev, l.ev);
  // f1 blocks: nothing exact, so it is searched; a move that ends the game is endLine's
  const b = g.clone(); b.play('f1'); assert.equal(quickLine(b, 'f1', B), null);
  const w = Game.fromTPS('x6/x6/x6/2,2,2,2,x2/x6/1,1,1,1,1,x 1 6', 2), e = w.clone(); e.play('f1');
  assert.deepEqual(quickLine(e, 'f1', W).ev, { kind: 'win', n: 1, proven: true });
  // several replies (a3, b2, f1 ...; Ca3, Cf1 their cap twins): the first in the puzzle's own orientation (back), never
  // a cap twin, so every turn of the board shows the same reply turned
  const two = Game.fromTPS('x6/x6/2,2,2,2,x2/x,1,1,1,1,1/x6/1,1,1,1,1,x 2 10', 2), t = two.clone(); t.play('a6');
  const ws = winningMoves(t, 1).moves.filter((m) => m[0] !== 'C').sort();
  assert.ok(ws.length >= 3 && winningMoves(t, 1).moves.includes('Cf1'));
  assert.equal(quickLine(t, 'a6', B).pv[1], ws[0]);
  assert.equal(quickLine(t, 'a6', B, (m) => (m === ws.at(-1) ? '' : m)).pv[1], ws.at(-1));
});
test('endLine: a move that ends the game: wins in 1, "loses at once", or a draw', () => {
  assert.deepEqual(endLine('a1', { winner: 1, kind: 'road' }, W).ev, { kind: 'win', n: 1, proven: true });
  const l = endLine('2b3>', { winner: 2, kind: 'road' }, W);
  assert.deepEqual([l.move, l.pv, l.ev], ['2b3>', ['2b3>'], { kind: 'loss', n: 0, proven: true }]);
  assert.equal(evalLabel(l.ev), 'loses at once');
  assert.equal(evalLabel({ kind: 'loss', n: 2, proven: false }), 'loses in 2');
  assert.deepEqual(endLine('a1', { winner: 0, kind: 'flat' }, W).ev, { kind: 'prob', p: 0.5 });
});
test('mergeLines: a win by a flat and by the capstone on one square is one line (f2 beside Cf2)', () => {
  const g = Game.fromTPS('1,1,1,1,x/x5/2,2,x3/x5/x5 1 6', 0), sol = solverLines(g);
  assert.deepEqual(sol.wins1, ['e5', 'Ce5'], 'the solver still lists both (pinned verdicts use them)');
  const got = mergeLines([], sol, [], 3);
  assert.deepEqual(got.map((l) => l.move), ['e5', 'd4', 'e4']);
  // an engine line on the capstone move keeps it (proven), and the flat twin adds nothing
  const e = mergeLines([L('Ce5', { kind: 'prob', p: 0.9 })], { wins1: ['e5', 'Ce5'], wins3: [] }, [], 3);
  assert.deepEqual(e.map((l) => [l.move, l.ev.kind, l.ev.n]), [['Ce5', 'win', 1]]);
  // a capstone win with no flat twin is a line
  assert.deepEqual(mergeLines([], { wins1: ['Ca1'], wins3: [] }, [], 3).map((l) => l.move), ['Ca1']);
});


// ---------- the board's shapes (step 5) ----------
const sq = (name, n) => (+name.slice(1) - 1) * n + name.charCodeAt(0) - 97;
test('moveShape: placements by type; spreads in all four directions with their drops', () => {
  assert.deepEqual(moveShape('c3', 6), { kind: 'place', sq: sq('c3', 6), type: 'F' });
  assert.deepEqual(moveShape('Sb4', 6), { kind: 'place', sq: sq('b4', 6), type: 'S' });
  assert.deepEqual(moveShape('Ce2', 5), { kind: 'place', sq: sq('e2', 5), type: 'C' });
  for (const [mv, to] of [['c3+', 'c4'], ['c3-', 'c2'], ['c3>', 'd3'], ['c3<', 'b3']]) {
    const s1 = moveShape(mv, 6);
    assert.deepEqual([s1.kind, s1.from, s1.to, s1.carry, s1.drops, s1.smash], ['spread', sq('c3', 6), sq(to, 6), 1, [{ sq: sq(to, 6), k: 1 }], false], mv);
  }
  const a = moveShape('3d3>12', 6), b = moveShape('3d3>21', 6);
  assert.deepEqual(a.drops, [{ sq: sq('e3', 6), k: 1 }, { sq: sq('f3', 6), k: 2 }]);
  assert.deepEqual(b.drops, [{ sq: sq('e3', 6), k: 2 }, { sq: sq('f3', 6), k: 1 }]);
  assert.equal(a.carry, 3); assert.equal(a.to, sq('f3', 6));
  const five = moveShape('5a1>11111', 6);
  assert.deepEqual(five.drops.map((d) => d.sq), ['b1', 'c1', 'd1', 'e1', 'f1'].map((x) => sq(x, 6)));
  assert.equal(five.carry, 5);
});
test('moveShape: a smash (by "*", or a last drop of 1 onto a wall); the board edges on 3x3 and 8x8', () => {
  assert.equal(moveShape('2c3-11*', 6).smash, true);
  const g = Game.fromTPS('x6/x6/x6/x6/x2,1S,x3/x2,2C,x3 1 5', 0);
  assert.equal(moveShape('c1+', 6, g).smash, true);
  assert.equal(moveShape('c1>', 6, g).smash, false);
  assert.equal(moveShape('3a1+111', 3), null, 'three squares up from a1 leaves a 3x3 board');
  assert.equal(moveShape('2a1+11', 3).to, sq('a3', 3));
  assert.equal(moveShape('c3<', 3).to, sq('b3', 3));
  assert.equal(moveShape('7a8-1111111', 8).to, sq('a1', 8));
  assert.equal(moveShape('h1<', 8).to, sq('g1', 8));
  assert.deepEqual(moveShape('h8', 8), { kind: 'place', sq: 63, type: 'F' });
});
// The 8 orientations: board.js OPS turns ']' and mirror ';' composed (its mul).
const OPS = { ']': [0, 1, -1, 0], ';': [-1, 0, 0, 1] };
const mul = ([p, q, r, t], [a, b, c, d]) => [p * a + q * c, p * b + q * d, r * a + t * c, r * b + t * d];
const ORIENTS = [];
for (const m of [false, true]) { let M = m ? OPS[';'] : [1, 0, 0, 1]; for (let k = 0; k < 4; k++) { ORIENTS.push(M); M = mul(OPS[']'], M); } }
test('dispPoint: identity is (file, rank); every orientation is a bijection of the board that keeps neighbours adjacent', () => {
  assert.deepEqual(dispPoint(sq('c2', 5), 5, [1, 0, 0, 1]), [2, 1]);
  assert.equal(new Set(ORIENTS.map(String)).size, 8);
  for (const n of [3, 6, 8]) for (const M of ORIENTS) {
    const seen = new Set();
    for (let s1 = 0; s1 < n * n; s1++) {
      const [x, y] = dispPoint(s1, n, M);
      assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < n && y < n);
      seen.add(x + ',' + y);
      if (s1 % n < n - 1) { const [x2, y2] = dispPoint(s1 + 1, n, M); assert.equal(Math.abs(x2 - x) + Math.abs(y2 - y), 1); }
    }
    assert.equal(seen.size, n * n);
  }
  // a quarter turn takes a1 (bottom left) to a corner other than the bottom left
  assert.notDeepEqual(dispPoint(0, 6, ORIENTS[1]), [0, 0]);
});
test('shapesSvg: one head per spread, drop counts only when the stones are split, a ring and ghost per placement', () => {
  const g = Game.fromTPS('x6/x6/x6/x6/x6/x6 1 1', 0);
  const one = shapesSvg([{ shape: moveShape('3d3>', 6, g), role: 'best', color: 1 }], 6, [1, 0, 0, 1]);
  assert.equal(one.match(/class="hd"/g).length, 1);
  assert.equal((one.match(/class="dd"/g) || []).length, 0);
  assert.match(one, /class="dc"[^>]*\/><text[^>]*>3</, 'the number carried at the tail');
  const split = shapesSvg([{ shape: moveShape('3d3>12', 6), role: 'alt', color: 2 }, { shape: moveShape('d3+', 6), role: 'threat', color: 2 }], 6, [1, 0, 0, 1]);
  assert.equal(split.match(/class="hd"/g).length, 2);
  assert.equal(split.match(/class="dd"/g).length, 2);
  assert.ok(split.indexOf('sh threat') > split.indexOf('sh alt'), 'threats drawn last (on top: the threat a line blocks is never under it)');
  const pl = shapesSvg([{ shape: moveShape('Sb4', 6), role: 'best', color: 2 }, { shape: moveShape('c4', 6), role: 'threat', color: 1 }], 6, [1, 0, 0, 1]);
  assert.equal(pl.match(/class="rg"/g).length, 2);
  assert.equal(pl.match(/class="gh p2"/g).length, 1, 'no ghost on a threat');
  assert.match(pl, /rotate\(45 /, 'a black wall leans as on the board');
  // geometry: b4 on 6x6 is display column 1, row 3 up: centre (1.5, 6 - 1 - 3 + .5)
  assert.match(pl, /cx="1.5" cy="2.5"/);
  assert.equal(shapesSvg([], 6, [1, 0, 0, 1]), '');
});
test('threatGroups: one threat per stack and direction (fewest stones carried), placements as they are', () => {
  assert.deepEqual(threatGroups(['f5', '2f6-', 'f6<', '2f6<11', '2f6<', '3f6<12', '3f6<21', '3f6<'], 6), ['f5', '2f6-', 'f6<']);
  assert.deepEqual(threatGroups(['3c5<', 'c5<', '2b6-'], 6), ['c5<', '2b6-']);
  assert.deepEqual(threatGroups([], 6), []);
});

// ---- the threat-arrows bug (scout, 2026-11-22): threats were painted first, under the engine's marks, with the same
// ring and the same head as an engine move, so the threat a move blocks vanished under that move's own ring or arrow,
// and several threats into one square stacked their heads on its centre. Each case below failed before the fix.
const TOUR19 = 'x2,1,2,x2/1,2,2,2,2,11/12,1,1,x2,1C/22,x,2,1,21,1/2,1111,11,2,x,2/2,2,12,2,2,1 1 25';
const groups = (svg) => [...svg.matchAll(/<g class="sh ([a-z]+)">(.*?)<\/g>/g)].map((m) => ({ role: m[1], body: m[2] }));
const circles = (body, cls) => [...body.matchAll(new RegExp(`<circle class="${cls}" cx="([\\d.]+)" cy="([\\d.]+)" r="([\\d.]+)"`, 'g'))].map((m) => m.slice(1).map(Number));
test('threat bug: a threat on the square line 1 places on (the block) is drawn above it, as a smaller ring', () => {
  // hist1 ◀1 (scout): "Black threatens to win: d1, e1<"; line 1 is d1, the block
  const g = Game.fromTPS('x6/x6/x6/x6/x6/x6 1 1', 0);
  const svg = shapesSvg([{ shape: moveShape('d1', 6, g), role: 'threat', color: 2 }, { shape: moveShape('d1', 6, g), role: 'best', color: 1 }], 6, [1, 0, 0, 1]);
  const gs = groups(svg);
  assert.deepEqual(gs.map((x) => x.role), ['best', 'threat'], 'line 1 first, the threat over it');
  const [[bx, by, br]] = circles(gs[0].body, 'rg'), [[tx, ty, tr]] = circles(gs[1].body, 'rg');
  assert.deepEqual([bx, by], [tx, ty], 'the same square');
  assert.ok(br - tr >= 0.1, `two rings apart (${br} and ${tr}), not one circle`);
});
test('threat bug: several threats into one square are one target ring, and their arrows stop at it (tour19 at its start)', () => {
  const g = Game.fromTPS(TOUR19, 0), threats = threatGroups(solverLines(g.clone()).threats, 6);
  assert.deepEqual(threats, ['e1+', 'd2>', 'e2', 'f2-']);
  const list = threats.map((t) => ({ shape: moveShape(t, 6, g), role: 'threat', color: 2 }));
  list.push({ shape: moveShape('4b2>1111', 6, g), role: 'best', color: 1 });
  const svg = shapesSvg(list, 6, [1, 0, 0, 1]), gs = groups(svg), th = gs.filter((x) => x.role === 'threat');
  assert.equal(th.length, 4, 'one group per threat');
  assert.ok(svg.lastIndexOf('sh best') < svg.indexOf('sh threat'), 'every threat over line 1\'s arrow');
  const rings = th.flatMap((x) => circles(x.body, 'rg'));
  // e2 (e1+, d2>, e2: one ring) and f1 (f2-)
  assert.deepEqual(rings.map(([x, y]) => x + ',' + y).sort(), ['4.5,4.5', '5.5,5.5']);
  // every threat head's tip stays outside the target's ring (the old heads met at .12 past its centre)
  for (const x of th) for (const m of x.body.matchAll(/<polygon class="hd" points="([\d.]+),([\d.]+) /g)) {
    const d = Math.min(...rings.map(([cx, cy]) => Math.hypot(+m[1] - cx, +m[2] - cy)));
    assert.ok(d >= THREAT_R, `a head ${d.toFixed(2)} from its target's centre`);
  }
});
test('threat bug: every analysis mark has a dark casing under it; the Rush pictures\' marks are as they were', () => {
  const g = Game.fromTPS(TOUR19, 0);
  for (const role of ['best', 'alt', 'yours', 'threat']) {
    const svg = shapesSvg([{ shape: moveShape('d2>', 6, g), role, color: 2 }, { shape: moveShape('a6', 6, g), role, color: 2 }], 6, [1, 0, 0, 1]);
    for (const x of groups(svg)) {
      assert.match(x.body, /^<(circle|line|polygon) class="cs"/, `${role}: the casing first`);
      assert.equal((x.body.match(/class="cs"/g) || []).length >= 1, true);
    }
  }
  const rush = shapesSvg([{ shape: moveShape('c3', 6), role: 'good', color: 1 }, { shape: moveShape('c3', 6), role: 'bad', color: 1, r: 0.3 }], 6, [1, 0, 0, 1]);
  assert.doesNotMatch(rush, /class="cs"|style=/);
  assert.equal(rush, '<g class="sh bad"><circle class="rg" cx="2.5" cy="3.5" r="0.3"/><rect class="gh p1" x="2.25" y="3.25" width=".5" height=".5" rx=".05"/></g><g class="sh good"><circle class="rg" cx="2.5" cy="3.5" r="0.42"/><rect class="gh p1" x="2.25" y="3.25" width=".5" height=".5" rx=".05"/></g>');
});
test('threat bug: a win on flats threatened on one square is one threat, not a flat and a wall (d1, Sd1)', () => {
  const sol = solverLines(Game.fromTPS('1,2,1,2/2,1,2,1/1,2,1,2/2,1,2,x 1 9'));
  assert.deepEqual(sol.threats, ['d1']);
  // a capstone on a road square is the flat's road too
  assert.deepEqual(solverLines(Game.fromTPS('x5/x5/x5/2,2,2,2,x/1,1,x3 1 5')).threats.filter((t) => /e2$/.test(t)), ['e2']);
});
// ---- the finisher's review fixes (2026-11-22) ----
const rings = (svg) => [...svg.matchAll(/<circle class="(cs|rg)" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" style="stroke-width:([\d.]+)"/g)]
  .map((m) => ({ cls: m[1], x: +m[2], y: +m[3], r: +m[4], w: +m[5] }));
test('rings on one square never share a band: line 1, the selected line inset, the threat (hist1 ◀1 with Sd1 picked)', () => {
  const svg = shapesSvg([{ shape: moveShape('d1', 6), role: 'threat', color: 2 }, { shape: moveShape('d1', 6), role: 'best', color: 1 },
    { shape: moveShape('Sd1', 6), role: 'alt', color: 1, r: ALT_IN }], 6, [1, 0, 0, 1]);
  // each ring's band: its casing's (the wider stroke), r ± w / 2
  const bands = rings(svg).filter((x) => x.cls === 'cs').map((x) => [x.r - x.w / 2, x.r + x.w / 2]).sort((a, b) => a[0] - b[0]);
  assert.equal(bands.length, 3);
  for (let i = 1; i < bands.length; i++) assert.ok(bands[i][0] >= bands[i - 1][1] - 0.005, `bands ${bands[i - 1]} and ${bands[i]} overlap`);
});
test('a threat ring around a stone sits outside its corners (a flat never reads as a capstone)', () => {
  // board.css: a flat is 52% of a square, its corners rounded 13% of that: its farthest point from the centre
  const half = 0.26, cr = 0.13 * 0.52, reach = (half - cr) * Math.SQRT2 + cr;
  const svg = shapesSvg([{ shape: moveShape('f2-', 6), role: 'threat', color: 2, r: THREAT_ON }], 6, [1, 0, 0, 1]);
  const cs = rings(svg).find((x) => x.cls === 'cs');
  assert.ok(cs.r - cs.w / 2 > reach, `inner edge ${cs.r - cs.w / 2} beyond the stone's ${reach.toFixed(3)}`);
  assert.ok(cs.r + cs.w / 2 <= 0.5, 'inside its own square');
  const [, hx, hy] = svg.match(/<polygon class="hd" points="([\d.]+),([\d.]+) /);
  assert.ok(Math.hypot(+hx - 5.5, +hy - 5.5) >= THREAT_ON, 'the head stops at that ring');
});
test('two spreads off one stack: each shows its own count, and along one line both shafts show (tour19 2b2- beside 4b2>1111)', () => {
  const g = Game.fromTPS(TOUR19, 0);
  const svg = shapesSvg([{ shape: moveShape('4b2>1111', 6, g), role: 'best', color: 1 }, { shape: moveShape('2b2-', 6, g), role: 'alt', color: 1, lead: 0.4 }], 6, [1, 0, 0, 1]);
  const dc = [...svg.matchAll(/class="dc" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
  assert.equal(dc.length, 2);
  assert.ok(Math.hypot(dc[0][0] - dc[1][0], dc[0][1] - dc[1][1]) >= dc[0][2] + dc[1][2], 'the two count discs apart');
  // collinear (tour13: a1+ beside 2a1+11): shafts side by side, and split drop counts beside each
  const two = shapesSvg([{ shape: moveShape('3a1+111', 6), role: 'best', color: 1, shift: -0.15 }, { shape: moveShape('2a1+11', 6), role: 'alt', color: 1, shift: 0.15, lead: 0.4 }], 6, [1, 0, 0, 1]);
  const xs = [...two.matchAll(/<line class="sf" x1="([\d.]+)"/g)].map((m) => +m[1]);
  assert.ok(Math.abs(xs[0] - xs[1]) >= 0.25, `two shafts apart: ${xs}`);
  const dd = [...two.matchAll(/class="dd" cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => m[1] + ',' + m[2]);
  assert.equal(new Set(dd).size, dd.length, 'no two drop counts on one point');
});
test('the count discs are drawn after every threat (no threat covers a number)', () => {
  const g = Game.fromTPS(TOUR19, 0), list = threatGroups(solverLines(g.clone()).threats, 6).map((t) => ({ shape: moveShape(t, 6, g), role: 'threat', color: 2 }));
  list.push({ shape: moveShape('4b2>1111', 6, g), role: 'best', color: 1 });
  const svg = shapesSvg(list, 6, [1, 0, 0, 1]), last = svg.lastIndexOf('sh threat');
  for (const m of svg.matchAll(/class="d[cd]"/g)) assert.ok(m.index > last, 'a count under a threat');
});
test('threatGroups: one placement per square, the flat before the wall before the capstone', () => {
  assert.deepEqual(threatGroups(['Sd1', 'd1'], 6), ['d1']);
  assert.deepEqual(threatGroups(['Cd1', 'Sd1'], 6), ['Sd1']);
  assert.deepEqual(threatGroups(['Cd1', 'd1', 'Sd1', 'e1'], 6), ['d1', 'e1']);
});
test('chipLabel: every number spoken for the side ahead, in its colour (never "1%" under "White 99%")', () => {
  assert.deepEqual(chipLabel({ kind: 'prob', p: 0.01 }, B), { text: '99%', side: W });
  assert.deepEqual(chipLabel({ kind: 'prob', p: 0.64 }, W), { text: '64%', side: W });
  assert.deepEqual(chipLabel({ kind: 'prob', p: 0.7 }, B), { text: '70%', side: B });
  assert.deepEqual(chipLabel({ kind: 'prob', p: 0.52 }, B), { text: 'even', side: 0 });
  assert.deepEqual(chipLabel({ kind: 'win', n: 2, proven: true }, B), { text: 'wins in 2', side: B });
  assert.deepEqual(chipLabel({ kind: 'loss', n: 1, proven: true }, W), { text: 'wins in 1', side: B });
  assert.deepEqual(chipLabel({ kind: 'loss', n: 0, proven: true }, W), { text: 'wins', side: B });
  assert.deepEqual(chipLabel({ kind: 'nowin', n: 2 }, W), { text: 'no win ≤2', side: 0 });
  assert.deepEqual(chipLabel({ kind: 'pending' }, W), { text: '…', side: 0 });
});
test('numberedPV / ptnParts: the move list\'s numbers; a spread\'s parts', () => {
  assert.deepEqual(numberedPV(['4b2>1111', 'e1>', '2c2<11'], 48).map((x) => x.num + x.ptn), ['25.4b2>1111', 'e1>', '26.2c2<11']);
  assert.deepEqual(numberedPV(['e1>', '2c2<11'], 49).map((x) => x.num + x.ptn), ['25…e1>', '26.2c2<11']);
  assert.deepEqual(ptnParts('4b2>1111').map((x) => x.c + x.t), ['n4', 'qb2', 'd>', 'n1111']);
  assert.deepEqual(ptnParts('Sc3').map((x) => x.c + x.t), ['kS', 'qc3']);
  assert.deepEqual(ptnParts('2a1+11*').map((x) => x.c + x.t), ['n2', 'qa1', 'd+', 'n11', 'k*']);
  assert.deepEqual(ptnParts('??'), [{ t: '??', c: 'q' }]);
});
test('mergeLines: a capstone and a flat on one square with the same proven result are one row (five1: Cc3 and c3)', () => {
  const got = mergeLines([{ move: 'Cc3', pv: ['Cc3', 'a1+'], ev: { kind: 'win', n: 2, proven: true }, src: 'tiltak', tags: [] }], null,
    [{ move: 'c3', pv: ['c3', 'a1+', 'c1'], ev: { kind: 'win', n: 2, proven: true }, src: 'puzzle', tags: ['puzzle'] }]);
  assert.deepEqual(got.map((l) => [l.move, l.tags.join()]), [['c3', 'puzzle']]);
  // different results: two rows
  assert.equal(mergeLines([{ move: 'Cc3', pv: ['Cc3'], ev: { kind: 'prob', p: 0.6 }, src: 'tiltak', tags: [] }, { move: 'c3', pv: ['c3'], ev: { kind: 'win', n: 2, proven: true }, src: 'solver', tags: [] }], null).length, 2);
});

// The tactics worker answers type 'lines' with solverLines of the position it is sent (tps or plies).
{
  const got = [];
  globalThis.self = { postMessage: (m) => got.push(m) };
  await import('../public/engine-worker.js');
  self.onmessage({ data: { id: 7, type: 'lines', size: 6, komi: 2, tps: ONE_THREAT, plies: ['f1'], pinned: ['a5'] } });
  self.onmessage({ data: { id: 8, type: 'lines', size: 5, komi: 0, tps: null, plies: ['a1', 'e5'], budget: 1e3 } });
  test('engine-worker: type lines posts { id, kind: "lines", ...solverLines }', () => {
    const g = Game.fromTPS(ONE_THREAT, 2); g.play('f1');
    assert.deepEqual(got[0], { id: 7, kind: 'lines', ...solverLines(g, { pinned: ['a5'] }) });
    assert.equal(got[1].id, 8); assert.equal(got[1].kind, 'lines'); assert.deepEqual(got[1].threats, []); assert.equal(got[1].over, null);
  });
}

// The solver line (boards Tiltak doesn't cover, or when it fails): an analyze search cut off by its budget must not read
// "No forced win" (engine-worker.js passes inconclusive on; engine.js noWinText words it; app.js runSolver shows it).
// The worker is already loaded above; its answers are collected here instead.
{
  const posted = [];
  self.postMessage = (m) => posted.push(m);
  const analyze = (pos) => { posted.length = 0; self.onmessage({ data: { id: 1, type: 'analyze', ...pos } }); return posted.at(-1); };
  const MID = 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14';
  test('analyze: a budget cut-off is posted as inconclusive, and the panel says so', () => {
    const r = analyze({ size: 6, tps: MID, plies: [], maxPlies: 9, budget: 5 });
    assert.equal(r.kind, 'none'); assert.equal(r.inconclusive, true);
    assert.equal(noWinText(r, 'White'), 'Search inconclusive');
  });
  test('analyze: a finished search with no win still says "No forced win", exhaustive or threats-only', () => {
    const r = analyze({ size: 3, tps: null, plies: ['a1', 'c3'], maxPlies: 3, budget: 4e5 }); // exhaustive, nothing forced
    assert.equal(r.kind, 'none'); assert.equal(r.inconclusive, false); assert.equal(r.exact, true);
    assert.equal(noWinText(r, 'White'), 'No forced win for White');
    // the page's analyze (maxPlies 9) finishes as { none, exact: false }: the wording players saw before stays
    assert.equal(noWinText({ kind: 'none', exact: false, inconclusive: false }, 'Black'), 'No forced win for Black');
  });
  test('legalPrefix: an engine line is kept up to its first illegal or unparseable move (app.js playPV)', () => {
    const g = Game.fromTPS(MID);
    const a = 'b1', h = g.clone(); h.play(a); // b1 is empty: a flat placement
    const b = h.legalMoves().map((m) => h.moveToPTN(m))[0];
    assert.deepEqual(legalPrefix(g, [a, b]), [a, b]);
    assert.deepEqual(legalPrefix(g, [a, '2c']), [a]); // a truncated move
    assert.deepEqual(legalPrefix(g, [a, 'g1', b]), [a]); // off the board (6x6)
    assert.deepEqual(legalPrefix(g, ['a1']), []); // a1 holds a stack: no placement there
    assert.deepEqual(legalPrefix(g, [a, a]), [a]); // b1 again: occupied now
    assert.deepEqual(legalPrefix(g, []), []);
    assert.deepEqual(g.toTPS(), Game.fromTPS(MID).toTPS()); // the game passed in is left as it was
  });
}

test('mergeLines: a proof comes with the line that proves it: the puzzle\'s line, not an engine\'s longer pv or the solver\'s one-move placeholder', () => {
  const eng = [{ move: 'e2', pv: ['e2', 'c6', 'a3', 'd6', 'f2'], ev: { kind: 'prob', p: 0.9 }, src: 'syntaks', tags: [] }];
  const sol = { wins1: [], wins3: ['e2'], pinned: {} };
  const pin = [{ move: 'e2', pv: ['e2', 'c6', 'f2'], ev: { kind: 'win', n: 2, proven: true }, src: 'puzzle', tags: ['puzzle'] }];
  for (const [what, got] of [['engine, solver, puzzle', mergeLines(eng, sol, pin)], ['engine, puzzle', mergeLines(eng, null, pin)], ['solver, puzzle', mergeLines([], sol, pin)]]) {
    assert.deepEqual(got[0].pv, ['e2', 'c6', 'f2'], what);
    assert.deepEqual(got[0].ev, { kind: 'win', n: 2, proven: true }, what);
    assert.deepEqual(got[0].tags, ['puzzle'], what);
  }
});
test('solverLines: a forced win on flats is a threat to win, not tinuë (tinuë is a road)', () => {
  const g = Game.fromTPS('2,2,x,x/2,x,2,x/x,x,x,1/x,2,1,x 1 10', 0);
  g.stones[1] = 5; g.stones[2] = 1; // Black has one stone left: any Black placement ends the game on flats
  const r = solverLines(g);
  assert.equal(r.tinue, false);
  assert.ok(r.threats.length > 0, 'still threats to win');
  // a real road tinuë is still one: two roads one square short, Black to move (5x5)
  const t = Game.fromTPS('2,2,x,2,x/x5/1,1,1,1,x/1,1,1,1,x/x,2,2,x,2 2 10', 0);
  assert.equal(solverLines(t).tinue, true);
});
{
  // engine.lines(): its final answer can say partial (the wins-in-2 search ran out of budget) and must still resolve
  let last;
  const was = globalThis.Worker;
  globalThis.Worker = class { constructor() { last = this; } postMessage(m) { this.sent = m; } terminate() {} };
  const engine = await import('../public/engine.js?lines-partial');
  let got = 'pending';
  const p = engine.lines({ size: 6, plies: [] }).then((r) => (got = r));
  last.onmessage({ data: { id: last.sent.id, kind: 'lines', wins1: ['f2'], wins3: null, partial: true, threats: ['d1+'], tinue: false, pinned: {}, over: null } });
  await p;
  test('engine.lines: a final answer marked partial (budget) resolves with its wins and threats', () => {
    assert.deepEqual(got.wins1, ['f2']); assert.deepEqual(got.threats, ['d1+']);
  });
  globalThis.Worker = was;
}

console.log(`\nOK: ${n} analysis tests`);
