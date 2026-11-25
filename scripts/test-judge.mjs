// The judge (shared/judge.js, plan §1.2): every contract row, the I6 cases (one result per attempt, fixed by the
// earliest decisive ply), and I2 (a failure is never evidence for a miss).   node scripts/test-judge.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { judge, newAttempt, result, defended, TAK_COUNTDOWN } from '../shared/judge.js';
import * as playon from '../public/playon.js';
import * as J from '../shared/judge.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

const SIX = { size: 6, komi: 2, solver: 1 }, FIVE = { size: 5, komi: 0, solver: 1 }, SEVEN = { size: 7, komi: 2, solver: 2 };
// Run plies [ply, inputs] through judge from a fresh attempt; returns the last answer (with .attempt and .result) and all.
function run(spec, steps, opts = {}) {
  let a = newAttempt({ ...spec, ...opts });
  const answers = [];
  for (const [ply, inputs] of steps) { const r = judge(a, ply, inputs); answers.push(r); a = r.attempt; }
  return { last: answers.at(-1), answers, a, res: result(a) };
}
const decided = (res, outcome, rated) => {
  assert.equal(res.state, 'decided', JSON.stringify(res));
  assert.equal(res.outcome, outcome, JSON.stringify(res));
  assert.equal(res.rated, rated, JSON.stringify(res));
};
const WIN = { winner: 1, kind: 'road' }, LOSS = { winner: 2, kind: 'road' }, DRAW = { winner: 0, kind: 'draw' };
const BOOK = { pos: 'x6/x6/x6/x6/x6/2,x5 2|4', ver: 1, win_len: 7, exact: 1, checked: 1 };

test('the moved rules are the ones playon.js exports', () => {
  for (const k of ['capMoves', 'provenCap', 'proofMoves', 'isTak', 'countTak', 'outOfTak', 'takLeft', 'outOfMoves', 'TAK_COUNTDOWN', 'defender', 'gameRated', 'winRated', 'lossRated', 'lossWhy', 'stalls', 'STALL_MS', 'unratedWhy', 'ending', 'endsOnNo', 'REFUTED'])
    assert.equal(playon[k], J[k], k);
  assert.equal(defended(6, 2), true); assert.equal(defended(6, 4), false); assert.equal(defended(6, 1.25), false);
  assert.equal(defended(5, 0), false); assert.equal(defended(7, 2), false);
});

test('row 1: a key at the node is ok with the stored reply, never decisive by itself', () => {
  const { last, res } = run(SIX, [[{ n: 0, move: 'c3' }, { tree: { key: true, reply: 'd4' } }]]);
  assert.equal(last.verdict, 'ok'); assert.equal(last.reply, 'd4'); assert.equal(res.state, 'open');
});

test('row 2: a move that wins the game is solved and rated (first, unhinted); a key that wins too', () => {
  for (const tree of [undefined, { key: true }]) {
    const { last, res } = run(SIX, [[{ n: 0, move: 'c3' }, { tree: { key: true, reply: 'd4' } }], [{ n: 2, move: 'e4' }, { game: WIN, tree }]]);
    assert.equal(last.verdict, 'solved'); decided(res, 'solved', true); assert.equal(res.ply, 2);
  }
});

test('row 3: a move that ends the game without a win for the player is a rated miss (rules)', () => {
  for (const game of [LOSS, DRAW, { winner: 2, kind: 'flat' }]) {
    const { last, res } = run(SIX, [[{ n: 0, move: 'c3' }, { game, tree: { key: true } }]]); // (rules beat a key, as app.js)
    assert.equal(last.verdict, 'missed'); decided(res, 'missed', true); assert.equal(res.evidence.kind, 'rules');
  }
});

test('row 4: off-tree with a book row where Syntaks defends: a proven play-out under the Tak rule (no cap); the exact length is kept', () => {
  let { last, res, a } = run(SIX, [[{ n: 0, move: 'c3' }, { left: 9, book: BOOK, reply: { move: 'd4' } }]]);
  assert.equal(last.verdict, 'play'); assert.equal(last.proven, true); assert.equal(last.cap, null); assert.equal(last.reply, 'd4');
  assert.equal(a.playout.rule, 'tak'); assert.equal(a.playout.proofPlies, 7); assert.equal(a.playout.left, 9);
  assert.equal(res.state, 'blocked');
  for (const book of [{ ...BOOK, win_len: 31, exact: 0 }, { ...BOOK, win_len: null }]) {
    const r = run(SIX, [[{ n: 0, move: 'c3' }, { left: 9, book, reply: { move: 'd4' } }]]);
    assert.equal(r.last.cap, null); assert.equal(r.a.playout.proofPlies, null); // unknown length: 'out' is unrated (lossRated)
  }
});

test('row 5: off-tree with a book row and no rated defender: solved on the spot, rated', () => {
  for (const spec of [FIVE, SEVEN, { size: 6, komi: 4, solver: 1 }]) {
    const { last, res } = run(spec, [[{ n: 0, move: 'c3' }, { book: BOOK, pns: { kind: 'no' } }]]);
    assert.equal(last.verdict, 'solved'); decided(res, 'solved', true); assert.equal(res.evidence.kind, 'book');
  }
});

test('row 6: a live deep proof (checked) where Syntaks defends: a proven play-out; unchecked is not a proof', () => {
  let { last } = run(SIX, [[{ n: 0, move: 'c3' }, { left: 5, deep: { kind: 'proved', plies: 11, checked: true }, reply: { move: 'd4' } }]]);
  assert.equal(last.proven, true); assert.equal(last.cap, null);
  ({ last } = run(SIX, [[{ n: 0, move: 'c3' }, { left: 5, deep: { kind: 'proved', plies: 11 }, reply: { move: 'd4' } }]]));
  assert.equal(last.proven, false); assert.equal(last.cap, null);
});

test('row 7: anything else where Syntaks defends is an unproven play-out; a disproof never rates (card only)', () => {
  for (const inputs of [{ deep: { kind: 'disproved' } }, { deep: { kind: 'undecided', reason: 'budget' } }, { node: { model: 'full', refuted: true, pos: 'p', ver: 1 } },
    { pns: { kind: 'no' } }, {}, { fault: { reason: 'rev' }, book: BOOK }]) {
    const { last, res } = run(SIX, [[{ n: 0, move: 'c3' }, { left: 5, reply: { move: 'd4' }, ...inputs }]]);
    assert.equal(last.verdict, 'play', JSON.stringify(inputs)); assert.equal(last.proven, false); assert.equal(last.cap, null);
    assert.equal(res.state, 'blocked');
  }
  const { last } = run(SIX, [[{ n: 0, move: 'c3' }, { left: 5, reply: { move: 'd4' }, deep: { kind: 'disproved' } }]]);
  assert.deepEqual(last.refutation, { src: 'deep' });
});

test('row 8: off 6×6, a full-model book_node refutation is a rated miss; a threat-model one is not', () => {
  let r = run(FIVE, [[{ n: 0, move: 'c3' }, { node: { model: 'full', refuted: true, pos: 'p', ver: 2 } }]]);
  decided(r.res, 'missed', true); assert.equal(r.res.evidence.kind, 'refuted-full');
  r = run(FIVE, [[{ n: 0, move: 'c3' }, { node: { model: 'threat', refuted: true, pos: 'p', ver: 2 }, pns: { kind: 'pending' } }]]);
  assert.equal(r.last.verdict, 'pending');
});

test('row 9: off 6×6, a pns proof with full defence is solved, rated; a threat-only "wins" is no proof', () => {
  let r = run(SEVEN, [[{ n: 1, move: 'c3' }, { pns: { kind: 'wins', plies: 9, fullDefense: true } }]]);
  decided(r.res, 'solved', true);
  r = run(SEVEN, [[{ n: 1, move: 'c3' }, { pns: { kind: 'wins', plies: 9 } }]]);
  decided(r.res, 'missed', false); assert.equal(r.res.evidence.kind, 'undecided');
});

test('row 10: off 6×6, a completed threat-only "no" is a rated miss (refuted-threat, Q3)', () => {
  const r = run(FIVE, [[{ n: 0, move: 'c3' }, { pns: { kind: 'no' } }]]);
  decided(r.res, 'missed', true); assert.equal(r.res.evidence.kind, 'refuted-threat');
});

test('row 11: off 6×6, pending until the final search: wins solved, "no" missed (rated), unknown missed unrated; Tiltak endings unrated', () => {
  const p = [{ n: 0, move: 'c3' }, { pns: { kind: 'pending' } }];
  let r = run(SEVEN, [p]);
  assert.equal(r.last.verdict, 'pending'); assert.equal(r.res.state, 'blocked');
  decided(run(SEVEN, [p, [{ n: 0, final: { kind: 'wins', fullDefense: true } }]]).res, 'solved', true);
  decided(run(SEVEN, [p, [{ n: 0, final: 'no' }]]).res, 'missed', true);
  for (const f of ['unknown', 'timeout', null, { kind: 'wins' }, 42])
    decided(run(SEVEN, [p, [{ n: 0, final: f }]]).res, 'missed', false);
  r = run(FIVE, [p, [{ n: 0, final: 'tiltak-loss' }], [{ n: 0, final: 'no' }]]); // a Tiltak game ended it first: unrated, as today
  decided(r.res, 'missed', false); assert.equal(r.res.unratedWhy, 'tiltak'); assert.equal(r.last.verdict, 'stale');
  decided(run(FIVE, [p, [{ n: 0, final: 'tiltak-win' }]]).res, 'solved', false);
});

test('row 12: a hint makes results decided from that ply on unrated', () => {
  const r = run(SIX, [[{ n: 0, act: 'hint' }, { hint: 'c3' }], [{ n: 1, move: 'c3' }, { game: WIN }]]);
  assert.equal(r.answers[0].verdict, 'hint'); assert.equal(r.answers[0].hint, 'c3');
  decided(r.res, 'solved', false); assert.equal(r.res.unratedWhy, 'hint');
});

test('row 13: Solution is a rated miss unless hinted earlier', () => {
  decided(run(SIX, [[{ n: 0, act: 'view' }]]).res, 'missed', true);
  decided(run(SIX, [[{ n: 0, act: 'hint' }], [{ n: 1, act: 'view' }]]).res, 'missed', false);
});

test('row 14: leave/unload outside a play-out close an undecided attempt unrated; with no move, nothing is recorded', () => {
  for (const act of ['leave', 'unload', 'expire']) {
    const r = run(SIX, [[{ n: 0, move: 'c3' }, { tree: { key: true, reply: 'd4' } }], [{ n: 2, act }]]);
    decided(r.res, 'missed', false);
    assert.equal(run(SIX, [[{ n: 0, act }]]).res.state, 'open');
  }
});

test('row 15: not the first attempt, or a paused/rejected puzzle: judged normally, never rated', () => {
  let r = run(SIX, [[{ n: 0, move: 'c3' }, { game: LOSS }]], { first: false });
  decided(r.res, 'missed', false); assert.equal(r.res.unratedWhy, 'repeat');
  for (const status of ['paused', 'rejected']) {
    r = run(SIX, [[{ n: 0, move: 'c3' }, { game: WIN }]], { status });
    decided(r.res, 'solved', false); assert.equal(r.res.unratedWhy, status);
  }
  decided(run(SIX, [[{ n: 0, move: 'c3' }, { game: WIN }]], { status: 'served' }).res, 'solved', true);
});

test('play-out table: win, out, the defender\'s road, flats or draw, give up, leave, unload, expire, noengine', () => {
  const start = [{ n: 0, move: 'c3' }, { left: 1, tak: false, reply: { move: 'd4' }, now: 0 }]; // a quiet move played out
  const unproven = (steps) => run(SIX, [start, ...steps]);
  // the player's road: solved, rated (Syntaks defended throughout)
  let r = unproven([[{ n: 2, move: 'e4' }, { game: WIN }]]);
  assert.equal(r.last.verdict, 'solved'); assert.equal(r.last.why, 'win'); decided(r.res, 'solved', true); assert.equal(r.res.ply, 0);
  // out: the move played out and the two after it all quiet (the countdown ran down)
  r = unproven([[{ n: 2, move: 'a1' }, { tak: false, reply: { move: 'a2' } }], [{ n: 4, move: 'b1' }, { tak: false }]]);
  assert.equal(r.last.why, 'out'); decided(r.res, 'missed', true); assert.equal(r.res.evidence.playout.quiet, 3);
  // Syntaks's road, flats, a draw (after its reply), and a move that completes only its road
  for (const game of [LOSS, { winner: 2, kind: 'flat' }, DRAW]) decided(unproven([[{ n: 2, move: 'a1' }, { reply: { move: 'a2', game } }]]).res, 'missed', true);
  decided(unproven([[{ n: 2, move: 'a1' }, { game: LOSS }]]).res, 'missed', true);
  // give up / Solution / leave with the reply shown: rated; overdue past STALL_MS: unrated; unload: rated (unproven)
  for (const act of ['giveup', 'view', 'leave', 'unload']) {
    decided(unproven([[{ n: 2, act, seen: 1 }, { now: 60e3 }]]).res, 'missed', true);
    r = unproven([[{ n: 2, act, seen: 0 }, { now: 6001 }]]);
    decided(r.res, 'missed', false); assert.equal(r.res.unratedWhy, 'stalled');
    decided(unproven([[{ n: 2, act, seen: 0 }, { now: 6000 }]]).res, 'missed', true); // overdue means past it
    decided(unproven([[{ n: 2, act, seen: 0 }, {}]]).res, 'missed', false); // no clock: as if overdue
  }
  // expiry and no engine: unrated
  r = unproven([[{ n: 2, act: 'expire', seen: 1 }, {}]]); decided(r.res, 'missed', false); assert.equal(r.res.unratedWhy, 'expired');
  r = run(SIX, [[{ n: 0, move: 'c3' }, { left: 1 }]]); assert.equal(r.last.verdict, 'missed'); decided(r.res, 'missed', false); assert.equal(r.res.unratedWhy, 'noengine');
  // given up before Syntaks moved (its first reply missing is noengine; a give-up needs a reply first): see gameRated
});

test('proven play-out: the win counts; out with the length unknown and unload are unrated; Syntaks failing is a solve', () => {
  const start = (book) => [{ n: 0, move: 'c3' }, { left: 1, book, reply: { move: 'd4' }, now: 0 }];
  let r = run(SIX, [start(BOOK), [{ n: 2, move: 'e4' }, { game: WIN }]]); decided(r.res, 'solved', true);
  const quiet3 = [[{ n: 2, move: 'a1' }, { tak: false, reply: { move: 'a2' } }], [{ n: 4, move: 'b1' }, { tak: false, reply: { move: 'b2' } }], [{ n: 6, move: 'c1' }, { tak: false }]];
  r = run(SIX, [start({ ...BOOK, win_len: null }), ...quiet3]);
  assert.equal(r.last.why, 'out'); decided(r.res, 'missed', false); assert.equal(r.res.unratedWhy, 'proven-length');
  r = run(SIX, [start(BOOK), ...quiet3]); assert.equal(r.last.why, 'out'); decided(r.res, 'missed', true); // (the proven move itself was Tak: 3 quiet after it)
  r = run(SIX, [start(BOOK), [{ n: 2, act: 'unload', seen: 1 }, { now: 1 }]]); decided(r.res, 'missed', false); assert.equal(r.res.unratedWhy, 'proven-unload');
  r = run(SIX, [start(BOOK), [{ n: 2, act: 'leave', seen: 1 }, { now: 1 }]]); decided(r.res, 'missed', true);
  r = run(SIX, [[{ n: 0, move: 'c3' }, { left: 1, book: BOOK, reply: null }]]); assert.equal(r.last.why, 'proved'); decided(r.res, 'solved', true);
  r = run(SIX, [start(BOOK), [{ n: 2, move: 'a1' }, { reply: { move: 'zz-garbage-but-string' } }], [{ n: 4, move: 'b1' }, { reply: 7 }]]);
  assert.equal(r.last.why, 'proved'); decided(r.res, 'solved', true);
});

test('a proof landing mid-game makes it a proven play-out that goes on (makeProven); an unknown is noted, the game decides', () => {
  const start = [{ n: 0, move: 'c3' }, { left: 1, reply: { move: 'd4' }, now: 0 }];
  let r = run(SIX, [start, [{ n: 0, final: { kind: 'wins', plies: 13, fullDefense: true } }]]);
  assert.equal(r.last.verdict, 'proven'); assert.equal(r.last.cap, null); assert.equal(r.res.state, 'blocked'); assert.equal(r.a.playout.proofPlies, 13);
  // an unknown, or a 'wins' without full defence, never makes the play-out proven nor moves its cap, nor ends it
  for (const fin of ['unknown', { kind: 'wins', plies: 13 }, { kind: 'undecided', reason: 'timeout' }, null]) {
    r = run(SIX, [start, [{ n: 0, final: fin }]]);
    assert.equal(r.last.verdict, 'noted', JSON.stringify(fin)); assert.equal(r.a.playout.proven, false); assert.equal(r.a.playout.proofPlies, null);
    assert.equal(r.a.playout.end, null); assert.equal(r.res.state, 'blocked');
  }
  r = run(SIX, [start, [{ n: 0, final: 'unknown' }], [{ n: 2, move: 'e4' }, { game: WIN }]]); decided(r.res, 'solved', true); // (it goes on, and a win stands)
  r = run(SIX, [start, [{ n: 0, final: { kind: 'wins', fullDefense: true } }], [{ n: 2, act: 'unload', seen: 1 }, { now: 1 }]]);
  decided(r.res, 'missed', false); assert.equal(r.res.unratedWhy, 'proven-unload');
});

test('a "no" mid-game ends the play-out there as a miss (F2, Sasha 2026-11-21), rated as any lost play-out; a win judged first stands', () => {
  const start = [{ n: 0, move: 'c3' }, { left: 1, tak: true, reply: { move: 'd4' }, now: 0 }];
  // the 'no' after a defender reply: ended 'refuted', a rated miss (Syntaks defended and moved: gameRated), decided at
  // the move played out; the play-out's moves are in the evidence
  for (const fin of ['no', { kind: 'no', plies: 13 }]) {
    const r = run(SIX, [start, [{ n: 2, move: 'e4' }, { tak: true, reply: { move: 'f4' } }], [{ n: 0, final: fin }]]);
    assert.equal(r.last.verdict, 'missed'); assert.equal(r.last.why, 'refuted'); assert.equal(r.a.playout.end, 'refuted');
    decided(r.res, 'missed', true); assert.equal(r.res.ply, 0); assert.deepEqual(r.res.evidence.playout.line, ['c3', 'd4', 'e4', 'f4']);
    assert.equal(r.res.evidence.playout.why, 'refuted');
  }
  // rated exactly as the play-out's other endings without a win: the same as Syntaks holding, or running out
  const same = (steps) => run(SIX, steps).res;
  const viaNo = same([start, [{ n: 0, final: 'no' }]]), viaHeld = same([start, [{ n: 2, move: 'e4' }, { game: LOSS }]]);
  assert.equal(viaNo.rated, viaHeld.rated); assert.equal(viaNo.outcome, viaHeld.outcome);
  // a win judged before the 'no' stands: the 'no' is stale then
  let r = run(SIX, [start, [{ n: 2, move: 'e4' }, { game: WIN }], [{ n: 0, final: 'no' }]]);
  assert.equal(r.last.verdict, 'stale'); decided(r.res, 'solved', true);
  // after the 'no', a later move is no longer a play-out move (the play-out is over); the result stays the miss
  r = run(SIX, [start, [{ n: 0, final: 'no' }], [{ n: 2, move: 'e4' }, { game: WIN }]]); decided(r.res, 'missed', true); assert.equal(r.res.ply, 0);
  // a proven play-out never ends on a 'no' (it has no check to answer; one would be noted and the game decides)
  r = run(SIX, [[{ n: 0, move: 'c3' }, { left: 1, book: BOOK, reply: { move: 'd4' }, now: 0 }], [{ n: 0, final: 'no' }]]);
  assert.equal(r.a.playout.end, null);
  // one already over keeps its ending: out under the Tak rule, then the 'no' settles it (rated as today)
  const quiet = (n) => [{ n, move: 'a' + n }, { tak: false, reply: { move: 'b' + n } }];
  r = run(SIX, [[{ n: 0, move: 'c3' }, { left: 1, tak: false, reply: { move: 'd4' }, now: 0 }], quiet(2), quiet(4), [{ n: 0, final: 'no' }]]);
  assert.equal(r.a.playout.end, 'out'); decided(r.res, 'missed', true);
  // with no defender move (the reply never came: 'noengine') it was already over, unrated, and stays so
  r = run(SIX, [[{ n: 0, move: 'c3' }, { left: 1, reply: null }], [{ n: 0, final: 'no' }]]); assert.equal(r.a.playout.end, 'noengine'); decided(r.res, 'missed', false);
  // the pure rule
  const po = { rule: 'tak', end: null, proven: false };
  assert.equal(J.endsOnNo(po, 'no'), true);
  for (const v of ['unknown', 'wins', undefined, null, 'tiltak-loss']) assert.equal(J.endsOnNo(po, v), false, String(v));
  assert.equal(J.endsOnNo({ ...po, proven: true }, 'no'), false); assert.equal(J.endsOnNo({ ...po, end: 'out' }, 'no'), false);
  assert.equal(J.endsOnNo({ ...po, rule: undefined, cap: 6 }, 'no'), false); // (Rush's cap play-outs: unchanged)
  assert.equal(J.endsOnNo(null, 'no'), false);
  assert.equal(J.lossRated({ engine: 'syntaks', fallback: false, stalled: false, line: ['a', 'b'] }, J.REFUTED), true);
  assert.equal(J.lossWhy({ engine: 'syntaks', fallback: true, stalled: false, line: ['a', 'b'] }, J.REFUTED), 'dropped');
});

test('the Tak rule in the judge: Tak forever never runs out; quiet, quiet, Tak goes on; a missing answer counts as Tak (I2)', () => {
  const start = (tak) => [{ n: 0, move: 'c3' }, { left: 1, tak, reply: { move: 'd4' }, now: 0 }];
  const ply = (n, tak) => [{ n, move: 'a' + n }, { tak, reply: { move: 'b' + n } }];
  let steps = [start(true)]; for (let i = 1; i <= 500; i++) steps.push(ply(2 * i, true));
  let r = run(SIX, steps); assert.equal(r.res.state, 'blocked'); assert.equal(r.a.playout.mine, 501); assert.equal(r.a.playout.end, null);
  r = run(SIX, [start(false), ply(2, false), ply(4, true), ply(6, false), ply(8, false), ply(10, true)]);
  assert.equal(r.a.playout.end, null); assert.equal(r.a.playout.quiet, 0);
  r = run(SIX, [start(false), ply(2, undefined), ply(4, 'yes'), ply(6, null)]); assert.equal(r.a.playout.end, null);
  r = run(SIX, [start(true), ply(2, false), ply(4, false), ply(6, false)]);
  assert.equal(r.last.why, 'out'); assert.equal(r.a.playout.mine, 4); assert.equal(TAK_COUNTDOWN + 1, 3);
});

// ---- I6 ----

test('I6: miss -> retry -> solve stays a miss (rated); the retry is logged, never rated', () => {
  const r = run(SIX, [[{ n: 0, move: 'a1' }, { game: LOSS }], [{ n: 1, move: 'c3' }, { tree: { key: true, reply: 'd4' } }], [{ n: 3, move: 'e4' }, { game: WIN }]]);
  assert.equal(r.last.verdict, 'solved'); decided(r.res, 'missed', true); assert.equal(r.res.ply, 0);
  const r7 = run(SEVEN, [[{ n: 0, move: 'a1' }, { pns: { kind: 'no' } }], [{ n: 1, move: 'e4' }, { game: { winner: 2, kind: 'road' } }]]);
  decided(r7.res, 'missed', true); assert.equal(r7.res.ply, 0);
});

test('I6: pending -> solve on the tree -> "no" is a miss; -> wins is a solve; -> unknown an unrated miss (as of the pending ply)', () => {
  const steps = [[{ n: 0, move: 'a1' }, { pns: { kind: 'pending' } }], [{ n: 1, move: 'c3' }, { tree: { key: true, reply: 'd4' } }], [{ n: 3, move: 'e4' }, { game: { winner: 2, kind: 'road' } }]];
  let r = run(SEVEN, steps);
  assert.equal(r.last.verdict, 'solved'); assert.equal(r.res.state, 'blocked'); assert.equal(r.res.ply, 0); // the solve can't decide yet
  r = run(SEVEN, [...steps, [{ n: 0, final: 'no' }]]); decided(r.res, 'missed', true); assert.equal(r.res.ply, 0);
  r = run(SEVEN, [...steps, [{ n: 0, final: { kind: 'wins', fullDefense: true } }]]); decided(r.res, 'solved', true); assert.equal(r.res.ply, 0);
  r = run(SEVEN, [...steps, [{ n: 0, final: 'unknown' }]]); decided(r.res, 'missed', false);
  // resolved twice: the first resolution stands
  r = run(SEVEN, [...steps, [{ n: 0, final: 'no' }], [{ n: 0, final: { kind: 'wins', fullDefense: true } }]]); decided(r.res, 'missed', true);
});

test('I6: a hint after the move but before the verdict does not touch it; one before the move does', () => {
  const p = [{ n: 0, move: 'a1' }, { pns: { kind: 'pending' } }];
  decided(run(SEVEN, [p, [{ n: 1, act: 'hint' }], [{ n: 0, final: { kind: 'wins', fullDefense: true } }]]).res, 'solved', true);
  decided(run(SEVEN, [p, [{ n: 1, act: 'hint' }], [{ n: 0, final: 'no' }]]).res, 'missed', true);
  const h = run(SEVEN, [[{ n: 0, act: 'hint' }], [{ n: 1, move: 'a1' }, { pns: { kind: 'pending' } }], [{ n: 1, final: { kind: 'wins', fullDefense: true } }]]);
  decided(h.res, 'solved', false); assert.equal(h.res.unratedWhy, 'hint');
  // the same in a play-out: a hint can't arrive there (Give up replaces it), but the move's ply decides as of itself
});

test('judge is pure: the attempt passed in is never changed, and the same inputs give the same answer', () => {
  const a = newAttempt(SIX), snap = JSON.stringify(a);
  const r1 = judge(a, { n: 0, move: 'c3' }, { left: 5, reply: { move: 'd4' }, now: 3 }), r2 = judge(a, { n: 0, move: 'c3' }, { left: 5, reply: { move: 'd4' }, now: 3 });
  assert.equal(JSON.stringify(a), snap); assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify(r1.attempt), JSON.stringify(structuredClone(r1.attempt))); // plain data, storable
});

// ---- I2: failure is not evidence ----

test('I2: every failure input is undecided, never a rated miss (both sides of the 6×6 line, every stage)', () => {
  const failures = [
    {}, { pns: null }, { pns: { kind: 'undecided', reason: 'timeout' } }, { pns: { kind: 'undecided', reason: 'crash' } }, { pns: { kind: 'undecided', reason: 'oom' } },
    { pns: { kind: 'undecided', reason: 'killed' } }, { pns: { kind: 'undecided', reason: 'queue' } }, { pns: { kind: 'undecided', reason: 'garbage' } },
    { pns: { kind: 'unknown' } }, { pns: { kind: 'NO' } }, { pns: 'no' }, { pns: { kind: 'wins' } }, { pns: [] }, { pns: 0 },
    { deep: { kind: 'undecided', reason: 'budget' } }, { deep: { kind: 'disproved' } }, { deep: 'proved' }, { deep: { kind: 'proved' } },
    { book: { pos: 'p' } }, { book: { pos: '', ver: 1 } }, { book: { pos: 'p', ver: 1, win_len: -3 } }, { book: 'yes' },
    { node: { model: 'threat', refuted: true, pos: 'p', ver: 1 } }, { node: { model: 'full', refuted: 'yes', pos: 'p', ver: 1 } }, { node: { model: 'full', refuted: true } },
    ...['rev', 'bookver', 'queue', 'restart', 'network', '503', '429', 'crash', 'oom', 'binary-missing'].map((reason) => ({ fault: { reason } })),
    { fault: { reason: 'rev' }, pns: { kind: 'no' } }, { fault: { reason: 'rev' }, node: { model: 'full', refuted: true, pos: 'p', ver: 1 } },
    { fault: {}, deep: { kind: 'proved', checked: true, plies: 3 } }, { left: 0 }, { left: NaN }, { left: '9' }, { left: 9, reply: null }, { left: 9, reply: { move: '' } },
  ];
  let count = 0;
  for (const spec of [SIX, FIVE, SEVEN, { size: 4, komi: 0, solver: 2 }, { size: 6, komi: 5, solver: 1 }]) {
    for (const f of failures) {
      const inputs = 'left' in f ? f : { left: 9, ...f };
      const r = run(spec, [[{ n: 0, move: 'c3' }, inputs]]);
      assert.ok(!(r.res.state === 'decided' && r.res.outcome === 'missed' && r.res.rated), `${spec.size}/${spec.komi} ${JSON.stringify(f)}: ${JSON.stringify(r.res)}`);
      if (r.res.state === 'decided' && r.res.outcome === 'missed') assert.ok(['undecided', 'noengine'].includes(r.res.unratedWhy) || r.res.evidence.kind === 'undecided', JSON.stringify(r.res));
      if (spec === SIX && !('left' in f && !(f.left > 0))) assert.ok(['play', 'missed'].includes(r.last.verdict));
      // and a pending search that then fails is unrated too
      if (spec !== SIX) for (const fin of [f.pns?.kind === 'undecided' ? f.pns : null, f.fault, 'unknown', undefined, 'NO', { kind: 'wins' }, { kind: 'wins', plies: 3 }]) {
        const p = run(spec, [[{ n: 0, move: 'c3' }, { pns: { kind: 'pending' } }], [{ n: 0, final: fin }]]);
        assert.ok(!(p.res.outcome === 'missed' && p.res.rated), JSON.stringify([fin, p.res]));
      }
      count++;
    }
  }
  // garbage plies change nothing
  for (const ply of [null, {}, { n: 'x', move: 'c3' }, { n: 1 }, { n: 1, act: 'resign' }, { n: 1, move: '' }]) {
    const r = judge(newAttempt(SIX), ply, { game: LOSS });
    assert.equal(r.verdict, 'ignored'); assert.equal(r.result.state, 'open');
  }
  console.log(`  (${count} failure inputs)`);
});

test('I2: a malformed game result (not Game.result()\'s shape) is never a rated miss: on the move, in a play-out, after a reply', () => {
  const bad = [{}, { winner: undefined }, { winner: '1' }, { winner: null, kind: 'road' }, { kind: 'road' }, [], { winner: 3, kind: 'road' },
    { winner: NaN }, { winner: 2 }, { winner: 0, kind: 'road' }, { winner: 2, kind: 'draw' }, { winner: 2, kind: 'resign' }, 'road', 7];
  const rated = (r) => r.res.state === 'decided' && r.res.outcome === 'missed' && r.res.rated;
  for (const g of bad) {
    for (const spec of [SIX, FIVE, SEVEN]) assert.ok(!rated(run(spec, [[{ n: 0, move: 'c3' }, { left: 9, game: g }]])), `move ${spec.size} ${JSON.stringify(g)}`);
    for (const proven of [false, true]) {
      const first = { left: 9, reply: { move: 'd4' }, now: 0, ...(proven ? { book: BOOK } : {}) };
      const viaPly = run(SIX, [[{ n: 0, move: 'c3' }, first], [{ n: 1, move: 'c4' }, { game: g, now: 1 }]]);
      assert.ok(!rated(viaPly), `play-out ply ${proven} ${JSON.stringify(g)}`); assert.equal(viaPly.res.state, 'decided');
      const viaReply = run(SIX, [[{ n: 0, move: 'c3' }, first], [{ n: 1, move: 'c4' }, { reply: { move: 'd5', game: g }, now: 1 }]]);
      assert.ok(!rated(viaReply), `reply ${proven} ${JSON.stringify(g)}`); assert.equal(viaReply.res.state, 'decided');
      assert.equal(viaReply.res.outcome, proven ? 'solved' : 'missed');
    }
  }
  // the real shapes still decide as before
  decided(run(FIVE, [[{ n: 0, move: 'c3' }, { game: DRAW }]]).res, 'missed', true);
  decided(run(SIX, [[{ n: 0, move: 'c3' }, { left: 9, reply: { move: 'd4', game: LOSS }, now: 0 }]]).res, 'missed', true);
});

test('I6: a ply numbered at or before one already judged changes nothing (a decided result never moves earlier)', () => {
  const solved = run(FIVE, [[{ n: 4, move: 'c3' }, { game: WIN }]]);
  decided(solved.res, 'solved', true);
  for (const [ply, inputs] of [[{ n: 2, act: 'view' }, {}], [{ n: 4, act: 'giveup' }, {}], [{ n: 1, act: 'hint' }, {}], [{ n: 4, move: 'b1' }, { game: LOSS }], [{ n: -1, move: 'b1' }, { game: LOSS }]]) {
    const r = judge(solved.a, ply, inputs);
    assert.equal(r.verdict, 'stale', JSON.stringify(ply)); decided(r.result, 'solved', true);
  }
  // in order, a later ply is still judged (logged, never rated)
  const later = judge(solved.a, { n: 5, act: 'view' }, {});
  assert.notEqual(later.verdict, 'stale'); decided(later.result, 'solved', true);
});

test('every play-out ending is in the attempt.why vocabulary (docs/plan/PLAN.md), refuted included', () => {
  const plan = fs.readFileSync(new URL('../docs/plan/PLAN.md', import.meta.url), 'utf8');
  const line = plan.split('\n').find((l) => /^\s+why\s+TEXT,/.test(l));
  const whys = new Set(line.split('--')[1].trim().split('|'));
  const asWhy = { held: 'defended', gaveup: 'giveup', invalid: 'noengine' }; // server/move.js whyOf
  for (const k of [J.REFUTED, 'out', 'road', 'held', 'gaveup', 'invalid']) assert.ok(whys.has(asWhy[k] || k), k);
});

console.log(`\nOK: ${n} judge tests`);
