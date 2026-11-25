// Play-on rules (public/playon.js): the move cap, who defends, how a game result ends it, and engine moves checked against our own rules.   node scripts/test-playon.mjs
import assert from 'node:assert/strict';
import { Game } from '../shared/tak.js';
import { capMoves, capNote, defender, ending, legalMove, gameRated, unratedWhy, winRated, stalls, heldResend, STALL_MS,
  lossRated, lossWhy, provenPlayOut, provenCap, provenCapNote, proofMoves, heldDisplaced, quickOutcome,
  capWait, CAP_WAIT_MS, provenLossLead, resendAfterUpload, deferredResendOk, answerOwnsToken, settledHeld,
  isTak, countTak, outOfMoves, takLeft, TAK_COUNTDOWN, playOutOf, applyProofLength, replyEntry, isReplyEntry, logOk, LOG, leftRunsOn, runOnHeld, noEnding, endsOnNo, REFUTED } from '../public/playon.js';
import { PTN_RE } from '../server/common.js';
import { COPY, copy } from '../public/playon-copy.js';
import fs from 'node:fs';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

test('cap: the puzzle\'s moves left plus the larger of 3 and 30% (rounded up)', () => {
  // plies left at an attacker node -> your moves left -> cap
  const cases = [[1, 4], [3, 5], [5, 6], [9, 8], [13, 10], [19, 13], [21, 15], [29, 20], [41, 28]];
  for (const [plies, cap] of cases) assert.equal(capMoves(plies), cap, `${plies} plies`);
  // 30% of exactly 10 moves is 3, not 4 (floating point: 0.3 * 10 = 3.0000000000000004)
  assert.equal(capMoves(19), 13);
  assert.equal(capNote(9), 'The puzzle had 5 of your moves left, and you get 3 spare.');
  assert.equal(capNote(3), 'The puzzle had 2 of your moves left, and you get 3 spare.');
  assert.equal(capNote(1), 'The puzzle had 1 move of yours left, and you get 3 spare.');
  assert.equal(capNote(29), 'The puzzle had 15 of your moves left, and you get 5 spare.');
});

test('defender: Syntaks on 6×6, Tiltak on 4×4/5×5, none elsewhere', () => {
  const tk = (size) => [4, 5, 6].includes(size);
  assert.equal(defender(6, 2, tk), 'syntaks');
  assert.equal(defender(6, 2.5, tk), 'syntaks');
  assert.equal(defender(6, 4, tk), null); // past Syntaks's komi range: never Tiltak on 6×6 (Sasha, 2026-11-21)
  assert.equal(defender(5, 0, tk), 'tiltak');
  assert.equal(defender(4, 0, tk), 'tiltak');
  assert.equal(defender(7, 0, tk), null);
  assert.equal(defender(8, 2, tk), null);
});

test('ending: your road or flat win is a win; the defender\'s road, flats or a draw holds', () => {
  assert.equal(ending(null, 1), null);
  assert.equal(ending({ winner: 1, kind: 'road' }, 1), 'win');
  assert.equal(ending({ winner: 2, kind: 'flat' }, 2), 'win');
  assert.equal(ending({ winner: 2, kind: 'road' }, 1), 'road');
  assert.equal(ending({ winner: 2, kind: 'flat' }, 1), 'held');
  assert.equal(ending({ winner: 0, kind: 'draw' }, 1), 'held');
});

test('legalMove: canonical when legal here, null otherwise', () => {
  const g = Game.fromTPS('x6/x6/x6/x6/x6/2,x5 1 2');
  assert.equal(legalMove(g, 'f6'), 'f6');
  assert.equal(legalMove(g, 'Ff6'), 'f6');
  assert.equal(legalMove(g, 'a1'), null); // occupied
  assert.equal(legalMove(g, 'a1+'), null); // not White's stone
  assert.equal(legalMove(g, 'zz'), null);
  assert.equal(legalMove(g, null), null);
  assert.equal(legalMove(g, ''), null);
});

test('rated or not: only a game Syntaks defended throughout counts, either way', () => {
  // Defender histories × outcomes. line: the player's move, then the defender's replies (and the player's moves).
  const L3 = ['f5', '2d3>', 'e4-'];
  const cases = [ // [name, po, win counts, loss counts, why a loss doesn't count]
    ['Syntaks throughout (browser or crux, or switching between them)', { engine: 'syntaks', fallback: false, line: L3 }, true, true, null],
    ['Tiltak from the start (4×4/5×5)', { engine: 'tiltak', fallback: false, line: L3 }, false, false, 'tiltak'],
    ['Syntaks dropped out mid-game', { engine: 'syntaks', fallback: true, line: L3 }, false, false, 'dropped'],
    ['Syntaks dropped out at its first reply, Tiltak moved', { engine: 'syntaks', fallback: true, line: ['f5', '2d3>'] }, false, false, 'dropped'],
    ['given up before any defender move', { engine: 'syntaks', fallback: false, line: ['f5'] }, false, false, 'nomove'],
    ['Tiltak, given up before it moved', { engine: 'tiltak', fallback: false, line: ['f5'] }, false, false, 'nomove'],
    ['no engine could move (noengine)', { engine: 'syntaks', fallback: true, line: ['f5'] }, false, false, 'nomove'],
    ['left while Syntaks was overdue', { engine: 'syntaks', fallback: false, line: L3, stalled: true }, true, false, 'stalled'],
  ];
  for (const [name, po, win, loss, why] of cases) {
    assert.equal(winRated(po, 'win'), win, `${name}: win`);
    assert.equal(winRated(po, 'proved'), true, `${name}: a proof always counts`);
    assert.equal(gameRated(po), loss, `${name}: a loss (held, out of moves, its road, give up, left)`);
    assert.equal(unratedWhy(po), why, `${name}: why`);
  }
  // nothing can only cost rating: wherever a loss counts, a win on the board counts too
  for (const [, po] of cases) if (gameRated(po)) assert.ok(winRated(po, 'win'));
});

test('stalls: only leaving while Syntaks owes a reply past STALL_MS', () => {
  const t0 = 1000, po = (thinking) => ({ engine: 'syntaks', fallback: false, line: ['f5', '2d3>', 'e4-', 'c3'], thinking, thinkingSince: t0 });
  // a slow reply (browser search timed out, then crux) that completes Syntaks's road, or ends on flats or a draw: the
  // reply is in hand (thinking cleared before it is played), so the game is a rated miss
  for (const kind of ['road', 'held']) {
    const p = po(false);
    p.stalled = stalls(p, kind, t0 + 9000);
    assert.equal(p.stalled, false, kind);
    assert.equal(gameRated(p), true, kind);
    assert.equal(unratedWhy(p), null, kind);
    // even with the flag still up, the defender's own ending is never a stall
    assert.equal(stalls(po(true), kind, t0 + 9000), false, kind + ' (thinking)');
  }
  assert.equal(stalls(po(true), 'noengine', t0 + 9000), false);
  // Give up (or Solution, or leaving) while the reply is more than 6 s overdue: unrated
  for (const kind of ['gaveup', 'left']) {
    const p = po(true);
    p.stalled = stalls(p, kind, t0 + STALL_MS + 1);
    assert.equal(p.stalled, true, kind);
    assert.equal(gameRated(p), false, kind);
    assert.equal(unratedWhy(p), 'stalled', kind);
    assert.equal(stalls(po(true), kind, t0 + STALL_MS - 1), false, kind + ' within STALL_MS');
    assert.equal(stalls(po(true), kind, t0 + STALL_MS), false, kind + ' at exactly STALL_MS'); // overdue means past it
  }
  // Give up after the reply arrived (during the board's animation, or on the player's own turn): rated
  const p = po(false);
  p.stalled = stalls(p, 'gaveup', t0 + 20000);
  assert.equal(p.stalled, false);
  assert.equal(gameRated(p), true);
});

test('heldResend: what a held record found on a later load is sent as', () => {
  const base = { id: 'p1', ms: 4200, owner: 'abc', b: 1800000000, page: 'x' };
  // never settled (the page died mid-check): an unrated miss
  assert.deepEqual(heldResend(base, 'abc', false), { build: 1800000000, body: { puzzleId: 'p1', win: false, casual: true, ms: 4200 } });
  // settled: as settled, with the build that settled it
  assert.deepEqual(heldResend({ ...base, win: false, casual: false, theme: 'road' }, 'abc', false),
    { build: 1800000000, body: { puzzleId: 'p1', win: false, theme: 'road', ms: 4200 } });
  assert.deepEqual(heldResend({ ...base, win: true, casual: true }, 'abc', false), { build: 1800000000, body: { puzzleId: 'p1', win: true, casual: true, ms: 4200 } });
  // no build stamp (dev server, or a record from before builds were kept): sent with none, so the server's stale-miss
  // guard treats a miss as old
  assert.equal(heldResend({ ...base, b: undefined, win: false, casual: false }, 'abc', false).build, 0);
  // another account's (logged out, or signed in as someone else), or one with no owner: dropped
  assert.equal(heldResend({ ...base, win: false, casual: false }, 'def', false), null);
  assert.equal(heldResend({ ...base, win: false, casual: false }, '', false), null);
  assert.equal(heldResend({ ...base, owner: undefined }, '', false), null);
  // a guest with no token yet, still none: theirs
  assert.deepEqual(heldResend({ ...base, owner: '' }, '', false).body.casual, true);
  // its page is still open (a duplicated tab): that page sends it
  assert.equal(heldResend({ ...base, win: false, casual: false }, 'abc', true), null);
  assert.equal(heldResend(null, 'abc', false), null);
  assert.equal(heldResend({}, 'abc', false), null);
});

test('a settled result held after a failed upload is resent with its move log (the server keeps only the first result)', () => {
  const log = [{ m: 'c3', ms: 900, k: 'tree' }, { m: 'd4', ms: 2100, k: 'miss' }];
  const rec = { ...settledHeld('p1', { ms: 2100, log }, false, false, 'road'), owner: 'abc', b: 1800000000, page: 'x' };
  const stored = JSON.parse(JSON.stringify(rec)); // (sessionStorage)
  assert.deepEqual(heldResend(stored, 'abc', false), { build: 1800000000, body: { puzzleId: 'p1', win: false, theme: 'road', ms: 2100, log } });
  assert.deepEqual(heldDisplaced(stored, 'p2', 'abc').body.log, log); // displaced by the next puzzle: the same body
  // casual: no theme, as before; no log: no log field
  assert.deepEqual(heldResend({ ...settledHeld('p1', { ms: 5 }, true, true, 'road'), owner: 'abc', b: 1 }, 'abc', false),
    { build: 1, body: { puzzleId: 'p1', win: true, casual: true, ms: 5 } });
  // never settled, without a log (the page died mid-check or mid-game): the unrated miss carries none
  assert.equal(heldResend({ id: 'p1', ms: 5, owner: 'abc' }, 'abc', false).body.log, undefined);
});

test('out under the Tak rule with the check running on: the held record keeps the log, so a crash resends it (unrated)', () => {
  const log = [{ m: 'f5', ms: 900, k: 'miss' }, { m: 'f4+!', ms: 1500, k: 'po' }, { m: 'b1', ms: 2100, k: 'po' }];
  const prev = { id: 'p1', ms: 900, owner: 'abc', b: 1800000000, page: 'x' }; // (startPlayOn's record, as stored)
  const rec = { ...runOnHeld(prev, log), owner: 'abc', b: 1800000000, page: 'x' }; // (heldRec.set stamps these again)
  assert.deepEqual(runOnHeld(prev, log), { id: 'p1', ms: 900, log });
  assert.equal(typeof rec.win, 'undefined'); // still unsettled: a page that dies now never sends a rated miss
  assert.deepEqual(heldResend(JSON.parse(JSON.stringify(rec)), 'abc', false), { build: 1800000000, body: { puzzleId: 'p1', win: false, casual: true, ms: 900, log } });
  assert.deepEqual(runOnHeld(prev, null), { id: 'p1', ms: 900 });
  assert.equal(heldDisplaced(rec, 'p2', 'abc'), null); // (unsettled: never sent by the next puzzle's record, as before)
});

test('leftRunsOn: only an out under the Tak rule whose check still runs keeps running when the player goes to another puzzle', () => {
  const c = (po, final = null) => ({ playOn: { rule: 'tak', end: 'out', proven: false, ...po }, final });
  assert.equal(leftRunsOn(c({}), 'left'), true);
  // the page going away, or a log-out or log-in: settled now (a rated miss; the card says so)
  assert.equal(leftRunsOn(c({}), 'unload'), false); assert.equal(leftRunsOn(c({}), 'auth'), false); assert.equal(leftRunsOn(c({}), 'again'), false);
  // mid-game: leaving is giving up, as before; under the cap, or another ending: nothing runs on
  assert.equal(leftRunsOn(c({ end: null }), 'left'), false); assert.equal(leftRunsOn(c({ rule: undefined }), 'left'), false);
  assert.equal(leftRunsOn(c({ end: 'road' }), 'left'), false); assert.equal(leftRunsOn(c({ end: 'gaveup' }), 'left'), false);
  // proven, or the check already answered: nothing to wait for
  assert.equal(leftRunsOn(c({ proven: true }), 'left'), false); assert.equal(leftRunsOn(c({}, 'no'), 'left'), false);
  assert.equal(leftRunsOn(null, 'left'), false); assert.equal(leftRunsOn({}, 'left'), false);
  // the page wires it: abandonCheck asks leftRunsOn before stopping the check, and the page going away and a log-out
  // or log-in settle every puzzle left running (abandonAll); the card's note says what leaving does
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const ab = app.slice(app.indexOf('function abandonCheck('), app.indexOf('function abandonQuick('));
  assert.ok(ab.indexOf('leftRunsOn(') > 0 && ab.indexOf('leftRunsOn(') < ab.indexOf('.chk.cancel()'), 'abandonCheck asks leftRunsOn before cancelling');
  assert.match(app, /addEventListener\('pagehide', \(\) => \{ abandonAll\(\{ keepalive: true \}\)/);
  assert.equal((app.match(/await abandonAll\(\{ auth: true \}\)/g) || []).length, 3, 'log-out, log-in and switching players');
  assert.match(app, /runningOn\.delete\(s\)/);
  assert.match(app, /if \(r\.p\.id === p\.id\) abandonCheck\(r, \{ again: true \}\)/, 'the same puzzle opened again settles the old attempt first');
  assert.match(COPY['end.note.checking'], /switching puzzles is safe/i); assert.match(COPY['end.note.checking'], /reload/i);
});

test('proven play-out: Syntaks only; the win always counts; failing, giving up or leaving is a rated miss when Syntaks defended, the page going away isn\'t', () => {
  assert.equal(provenPlayOut('syntaks'), true); // 6×6
  assert.equal(provenPlayOut('tiltak'), false); // 4×4/5×5: "No play out w tiltak", solved on the spot
  assert.equal(provenPlayOut(null), false); // 7×7/8×8
  const L3 = ['c2', 'd3', 'e3'];
  const po = { engine: 'syntaks', fallback: false, line: L3, proven: true, proofPlies: 6 }; // (length known: see the cap test)
  for (const how of ['win', 'proved']) assert.equal(winRated(po, how), true, `a ${how} counts`);
  for (const kind of ['held', 'out', 'road']) { assert.equal(lossRated(po, kind), true, kind); assert.equal(lossWhy(po, kind), null); }
  // Give up, Solution and leaving for another puzzle count like failing it (else stopping would dodge the miss)
  for (const kind of ['gaveup', 'left']) { assert.equal(lossRated(po, kind), true, kind); assert.equal(lossWhy(po, kind), null); }
  // the page going away (reload, closed tab) is unrated in a proven play-out, and only there
  assert.equal(lossRated(po, 'unload'), false); assert.equal(lossWhy(po, 'unload'), 'proven-unload');
  assert.equal(lossRated({ ...po, proven: false }, 'unload'), true); // an ordinary play-on: as leaving, as before
  // the usual exceptions still hold: given up before Syntaks's first reply, or while it was overdue
  assert.equal(lossRated({ ...po, line: ['c2'] }, 'gaveup'), false); assert.equal(lossWhy({ ...po, line: ['c2'] }, 'gaveup'), 'nomove');
  assert.equal(lossRated({ ...po, stalled: true }, 'gaveup'), false); assert.equal(lossWhy({ ...po, stalled: true }, 'gaveup'), 'stalled');
  assert.equal(stalls({ thinking: true, thinkingSince: 0 }, 'unload', STALL_MS + 1), true);
  // an unproven play-on: lossRated = gameRated for every ending
  const plain = { engine: 'syntaks', fallback: false, line: L3 };
  for (const kind of ['held', 'out', 'road', 'gaveup', 'left']) assert.equal(lossRated(plain, kind), true, `unproven ${kind}`);
  assert.equal(lossRated({ ...plain, engine: 'tiltak' }, 'held'), false); assert.equal(lossWhy({ ...plain, engine: 'tiltak' }, 'held'), 'tiltak');
});

test('heldResend: a proven play-out the page died in goes as an unrated miss; one already settled as it was settled', () => {
  const base = { id: 'p9', ms: 900, b: 1800000000, owner: 'abc', page: 'x', proven: true };
  assert.deepEqual(heldResend(base, 'abc', false).body, { puzzleId: 'p9', win: false, casual: true, ms: 900 });
  assert.deepEqual(heldResend({ ...base, win: true, casual: false, theme: 'fork' }, 'abc', false).body, { puzzleId: 'p9', win: true, theme: 'fork', ms: 900 });
  assert.equal(heldResend(base, 'abc', true), null); // its page is still open: that page sends it
});

test('proven play-out cap: the spare moves apply once, to the puzzle\'s moves left; the proof is only a floor; never shrinks', () => {
  // proof plies are counted after the move (defender to move); the player's moves include the move itself
  assert.equal(proofMoves(12), 7); assert.equal(proofMoves(8), 5); assert.equal(proofMoves(2), 2);
  assert.equal(proofMoves(null), null); assert.equal(proofMoves(undefined), null);
  // pd563381 (Sasha, 2026-11-17): 3 plies left (2 moves, cap 5), d1's proof 8 plies (5 moves) -> 5, not 5 + 3 = 8
  assert.equal(provenCap(3, 8), 5);
  assert.equal(provenCapNote(3, 8, 'd1'), 'The puzzle had 2 of your moves left, and you get 3 spare.');
  // proof-bound: 3 plies left (cap 5), a 12-ply proof (7 moves) -> 7, no spare on top
  assert.equal(provenCap(3, 12), 7);
  assert.equal(provenCapNote(3, 12, 'd1'), 'Our proof that d1 wins needs at most 7 of your moves, counting d1, so you get 7.');
  // pd616580 38…f5: 9 plies left (cap 8), f5's proof 12 plies (7 moves) -> 8, the puzzle's bound
  assert.equal(provenCap(9, 12), 8); assert.equal(provenCapNote(9, 12, 'f5'), capNote(9));
  // a road-in-1 node (cap 4) whose winning move proves in 7 plies (5 moves) -> 5; a 3-ply root (cap 5), 13 plies -> 8
  assert.equal(provenCap(1, 7), 5); assert.equal(provenCap(3, 13), 8);
  assert.equal(provenCap(3, 30), 16); // a long proof: its own 16 moves, nothing added
  // a short proof doesn't lower the usual cap; proof length unknown: the usual cap and its note
  assert.equal(provenCap(9, 2), 8); assert.equal(provenCapNote(9, 2, 'f5'), capNote(9));
  assert.equal(provenCap(9, null), 8); assert.equal(provenCap(3, undefined), 5); assert.equal(provenCapNote(3, null, 'd1'), capNote(3));
  // a cap shown is never lowered by a proof arriving late, and the note doesn't claim a bound that didn't set it
  assert.equal(provenCap(9, 2, 10), 10); assert.equal(provenCap(3, 8, 8), 8); assert.equal(provenCap(3, 12, 5), 7);
  assert.equal(provenCapNote(3, 8, 'd1', 8), 'You keep the 8 moves you were already given.');
  assert.equal(provenCapNote(3, 12, 'd1', 5), provenCapNote(3, 12, 'd1')); // the usual cap shown, the proof raises it
  assert.equal(provenCapNote(3, 8, 'd1', 5), capNote(3));
  // rating with the length unknown / known
  const po = { engine: 'syntaks', fallback: false, line: ['f5', '2d3>', 'e4-'], proven: true, proofPlies: null };
  assert.equal(lossRated(po, 'out'), false); assert.equal(lossWhy(po, 'out'), 'proven-length');
  for (const kind of ['held', 'road', 'gaveup', 'left']) assert.equal(lossRated(po, kind), true, `length unknown, ${kind}`);
  const known = { ...po, proofPlies: 12 };
  for (const kind of ['out', 'held', 'road', 'gaveup', 'left']) assert.equal(lossRated(known, kind), true, `length known, ${kind}`);
  assert.equal(lossRated(known, 'unload'), false);
  assert.equal(lossRated({ ...po, proven: false }, 'out'), true); // an ordinary play-on: unchanged
});

test('heldDisplaced: a settled record of another puzzle is sent before a new one replaces it', () => {
  const settled = { id: 'pA', ms: 900, win: true, casual: false, theme: 'fork', b: 1800000000, owner: 'abc', page: 'x' };
  assert.deepEqual(heldDisplaced(settled, 'pB', 'abc'), { build: 1800000000, body: { puzzleId: 'pA', win: true, theme: 'fork', ms: 900 } });
  assert.equal(heldDisplaced(settled, 'pA', 'abc'), null); // the same puzzle: updated in place
  assert.equal(heldDisplaced({ ...settled, win: undefined, casual: undefined }, 'pB', 'abc'), null); // never settled: overwritten as before
  assert.equal(heldDisplaced(settled, 'pB', 'someone-else'), null); // another account's: not this one's to send
  assert.equal(heldDisplaced(null, 'pB', 'abc'), null);
});

test('quickOutcome: a refuted move is a miss, never played out or noted unchecked; only an undecided one is held or dropped', () => {
  for (const minor of [false, true]) {
    assert.equal(quickOutcome('wins', minor), 'wins');
    assert.equal(quickOutcome('no', minor), 'no'); // (b307d18 sent a first check's 'no' to play-on)
  }
  for (const q of ['pending', 'unknown']) { assert.equal(quickOutcome(q, false), 'pending'); assert.equal(quickOutcome(q, true), 'unchecked'); }
});

test('capWait: at the cap, wait only for what could raise it', () => {
  const at = { engine: 'syntaks', fallback: false, mine: 5, cap: 5, end: null };
  // a proven play-out whose length is being measured waits; one whose length is known, or not being measured, doesn't
  assert.equal(capWait({ ...at, proven: true, proofPlies: null }, { lengthPending: true }), 'length');
  assert.equal(capWait({ ...at, proven: true, proofPlies: 6 }, { lengthPending: true }), null);
  assert.equal(capWait({ ...at, proven: true, proofPlies: null }, { lengthPending: false }), null); // unknown: 'out' unrated
  // an unproven Syntaks play-on whose full check still runs waits for it; Tiltak, a fallback, or a check done don't
  assert.equal(capWait({ ...at }, { checkLive: true }), 'proof');
  assert.equal(capWait({ ...at }, { checkLive: false }), null);
  assert.equal(capWait({ ...at, engine: 'tiltak' }, { checkLive: true }), null);
  assert.equal(capWait({ ...at, fallback: true }, { checkLive: true }), null);
  // below the cap, or a game already over: no wait
  assert.equal(capWait({ ...at, mine: 4 }, { checkLive: true, lengthPending: true }), null);
  assert.equal(capWait({ ...at, end: 'gaveup' }, { checkLive: true }), null);
  assert.ok(CAP_WAIT_MS.length >= 20e3 && CAP_WAIT_MS.proof >= 15e3);
});

test('provenLossLead and resendAfterUpload', () => {
  assert.equal(provenLossLead('out', false), 'unfinished');
  assert.equal(provenLossLead('road', false), 'escaped');
  assert.equal(provenLossLead('held', false), 'escaped'); // flats or a draw
  assert.equal(provenLossLead('road', true), 'own-road');
  assert.equal(resendAfterUpload({ ok: true, r: { user: { id: 1 } } }), false); // recorded: no second send
  assert.equal(resendAfterUpload({ ok: true, r: { error: 'too many requests' } }), true);
  assert.equal(resendAfterUpload({ ok: false }), true);
});

test('deferredResendOk: a displaced result is resent only by the same player, and only if its upload failed', () => {
  const failed = { ok: false }, landed = { ok: true, r: { user: { id: 1 } } };
  assert.equal(deferredResendOk(failed, 3, 3), true);
  assert.equal(deferredResendOk(landed, 3, 3), false); // recorded already
  assert.equal(deferredResendOk(failed, 3, 4), false); // signed in, out, or switched accounts meanwhile: not theirs
  assert.equal(deferredResendOk({ ok: true, r: { error: 'x' } }, 0, 0), true);
});

test("answerOwnsToken: a late answer's minted guest token never replaces a sign-in made while it was on its way", () => {
  assert.equal(answerOwnsToken(0, 0), true); // nothing happened meanwhile: the first result makes this browser a guest
  assert.equal(answerOwnsToken(0, 1), false); // logged in (#tok), logged out, or claimed a name meanwhile
  assert.equal(answerOwnsToken(2, 2), true);
});

// ---- the Tak rule (Sasha, 2026-11-21: judge.js TAK_COUNTDOWN; the puzzle page's play-outs, no cap) ----
// A play-out as the page counts it: the move played out, then each of the player's moves (j even in `line`), Tak or not.
// Returns the Tak pattern ('T' / 'q'), the move it ran out at (or null) and the game.
function replay(tps, komi, onTree, line) {
  const g = Game.fromTPS(tps, komi), solver = g.toMove;
  for (const m of onTree) g.play(g.canon(m));
  let po = null, pat = '', out = null;
  line.forEach((m, j) => {
    if (out) return;
    g.play(g.canon(m));
    if (j % 2) return; // (the defender's reply)
    const tak = isTak(g, solver);
    pat += tak ? 'T' : 'q';
    if (!po) po = playOutOf({ miss: m, at: 0, base: [], g, proven: false, left: 5, key: m, engine: 'syntaks', tak });
    else { po.mine++; countTak(po, tak); }
    if (outOfMoves(po)) out = po.mine;
  });
  return { pat, out, po, g };
}
// The two reported attempts (2026-11-21), as reconstructed from their logs (the replies weren't logged then).
const PD871847 = { tps: '221,1,21,x,121,x/x,2,x,1,221,x/x,2C,x,1C,111,2S/2,2,2,21S,2S,x/x2,2,x2,1S/2,x5 1 23', komi: 0,
  onTree: '3e6<12 b5+ 2c6< Sf5 d4> f5<'.split(' '), line: 'f5 f4+ f4 2f5- f5 3f4+ f4 4f5- e4+ Sf5 f6'.split(' ') };
const PD544785 = { tps: '2,x2,1,1,1/2,21,21,112S,x,12/x,21,2,12,x,1/2122C,x,1,1,2,1/221S,x,1,1C,1,x/2,x2,1,x2 2 27', komi: 3,
  onTree: 'a4 2b5< 3a3+12 3a2+'.split(' '), mine: 'a2 a3 4a5>121 a6- 4d5>31 2f5< 3e5> 2a5>'.split(' ') };
const weave = (mine, replies) => mine.flatMap((m, i) => (i < replies.length ? [m, replies[i]] : [m]));

test('Tak rule: the countdown is one constant; Tak, Tak, Tak... never runs out; quiet, quiet, Tak goes on; quiet x3 is out at the third', () => {
  assert.equal(TAK_COUNTDOWN, 2);
  const po = (first) => playOutOf({ miss: 'a1', at: 0, base: [], g: null, proven: false, left: 5, key: 'a1', engine: 'syntaks', tak: first });
  const step = (p, tak) => { p.mine++; countTak(p, tak); return p; };
  let p = po(true);
  assert.equal(p.rule, 'tak'); assert.equal(p.cap, null); assert.equal(p.capNote, null); assert.equal(takLeft(p), null);
  for (let i = 0; i < 1000; i++) { step(p, true); assert.equal(outOfMoves(p), false); }
  assert.equal(p.mine, 1001); assert.equal(capWait(p, { checkLive: true }), null);
  // quiet, quiet, Tak resets (and again); the countdown says 2 then 1
  p = po(true); step(p, false); assert.equal(takLeft(p), 2); step(p, false); assert.equal(takLeft(p), 1);
  step(p, true); assert.equal(takLeft(p), null); assert.equal(outOfMoves(p), false);
  step(p, false); step(p, false); assert.equal(outOfMoves(p), false); step(p, true); assert.equal(p.quiet, 0);
  // quiet, quiet, quiet: out at the third, not before
  p = po(true); step(p, false); step(p, false); assert.equal(outOfMoves(p), false); step(p, false); assert.equal(outOfMoves(p), true); assert.equal(p.mine, 4);
  assert.equal(takLeft(p), null);
  // the move played out counts: a quiet one starts the countdown, so two more quiet moves end it (3 moves in all)
  p = po(false); assert.equal(p.quiet, 1); assert.equal(takLeft(p), 2); step(p, false); assert.equal(outOfMoves(p), false); step(p, false);
  assert.equal(outOfMoves(p), true); assert.equal(p.mine, 3);
  // a missing answer is never evidence for running out (I2)
  p = po(true); for (const t of [undefined, null, 'no', 0]) step(p, t); assert.equal(p.quiet, 0);
  // Rush keeps the cap: no tak given, no rule
  p = playOutOf({ miss: 'a1', at: 0, base: [], g: null, proven: false, left: 5, key: 'a1', engine: 'syntaks' });
  assert.equal(p.rule, undefined); assert.equal(p.cap, capMoves(5)); p.mine = p.cap - 1; assert.equal(outOfMoves(p), false); p.mine++; assert.equal(outOfMoves(p), true);
});

test('Tak rule: isTak on real positions (a road threat, a quiet move, a flat-count threat)', () => {
  // pd871847 after its on-tree moves: f5 (the move played out) makes Tak; a far-away placement doesn't
  const g = Game.fromTPS(PD871847.tps, 0); for (const m of PD871847.onTree) g.play(g.canon(m));
  const h = g.clone(); h.play('f5'); assert.equal(isTak(h, 1), true);
  const q = g.clone(); q.play('a2'); assert.equal(isTak(q, 1), false);
  // a flat-count win in one: the board one square from full, white ahead on flats
  const f = Game.fromTPS('1,2S,1,2S/1,2S,2S,1/1,2S,1,1/2S,1,2S,x 1 12', 0), wins = f.legalMoves().some((m) => { const u = f.apply(m); const r = f.result(); f.undo(u); return r?.winner === 1 && r.kind === 'flat'; });
  assert.equal(wins, true); assert.equal(isTak(f, 1), true);
});

test('Tak rule on the two reported attempts: pd871847 goes on past the old cap; pd544785 depends on the unlogged replies', () => {
  // pd871847: one reconstruction fits the log; all 6 of the player's moves are Tak. Today's cap (6) ended it; the Tak
  // rule doesn't (the checker: every reply at the cut-off lost to a road next move).
  let r = replay(PD871847.tps, 0, PD871847.onTree, PD871847.line);
  assert.equal(r.pat, 'TTTTTT'); assert.equal(r.out, null); assert.equal(r.g.result(), null); assert.equal(capMoves(5), 6);
  // pd544785, an all-Tak reconstruction (36 fit the log; one is enough here): never out, the game goes on past 8
  r = replay(PD544785.tps, 3, PD544785.onTree, weave(PD544785.mine, '4a3+ 4a4-112 a4+ f4+ e6- f6- 2b4+'.split(' ')));
  assert.equal(r.pat, 'TTTTTTTT'); assert.equal(r.out, null);
  // pd544785 with the replies Syntaks itself picks (the checker's line): a6- is quiet, 4d5>31 restarts, then three
  // quiet moves in a row: out at move 8, the same move today's cap ended it at
  r = replay(PD544785.tps, 3, PD544785.onTree, weave(PD544785.mine, '4a3+ 5a4-212 f6- d2+ 2d3+11 d5< d2'.split(' ')));
  assert.equal(r.pat, 'TTTqTqqq'); assert.equal(r.out, 8);
});

test('Tak rule: running out while a proof is still being worked out waits for it; a proof landing then is never a rated miss', () => {
  const out = { rule: 'tak', mine: 4, quiet: 3, engine: 'syntaks', fallback: false, proven: false, proofPlies: null, line: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] };
  assert.equal(capWait(out, { checkLive: true }), 'proof'); // the check still running: wait, as at the cap today
  assert.equal(capWait(out, { checkLive: false }), null);
  assert.equal(capWait({ ...out, quiet: 2 }, { checkLive: true }), null); // not out: nothing to wait for
  assert.equal(capWait({ ...out, proven: true }, { lengthPending: true }), 'length');
  assert.equal(capWait({ ...out, proven: true, proofPlies: 9 }, { lengthPending: true }), null);
  assert.equal(capWait({ ...out, fallback: true }, { checkLive: true }), null); // Tiltak: a proof ends it as a solve anyway
  // rated: an unproven out (Syntaks throughout), a proven one with its length known; not: proven only once out
  assert.equal(lossRated(out, 'out'), true);
  assert.equal(lossRated({ ...out, proven: true, proofPlies: 9 }, 'out'), true);
  assert.equal(lossRated({ ...out, proven: true, proofPlies: 9, provedAtOut: true }, 'out'), false);
  assert.equal(lossWhy({ ...out, proven: true, proofPlies: 9, provedAtOut: true }, 'out'), 'proven-late');
  assert.equal(lossWhy({ ...out, proven: true, proofPlies: null }, 'out'), 'proven-length');
  // applyProofLength under the Tak rule keeps the length (it decides lossRated) and touches no cap
  const po = { rule: 'tak', cap: null, capNote: null, left: 5, miss: 'a1', proofPlies: null };
  assert.equal(applyProofLength(po, 12), true); assert.equal(po.proofPlies, 12); assert.equal(po.cap, null); assert.equal(po.capNote, null);
});

test('Tak rule: the app wires it as specified (source checks: no cap on the page, an out never stops a live check)', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /playOutOf\(\{[^}]*tak: isTak\(g, s\.solver\) \}\)/); // the move played out is counted
  assert.match(app, /if \(po\.rule === 'tak'\) countTak\(po, isTak\(po\.g, s\.solver\)\);[^\n]*\n  if \(outOfMoves\(po\)\) \{/);
  assert.doesNotMatch(app, /po\.mine >= po\.cap/);
  assert.match(app, /const runOn = kind === 'noengine' \|\| \(kind === 'out' && po\.rule === 'tak'\);/);
  assert.match(app, /if \(c\.playOn\.end === 'out' && v === 'wins'\) \{ po\.proven = po\.provedAtOut = true; return settleCheck\(s, 'unknown'\); \}/);
  assert.match(app, /logMove\('po', replyEntry\(mv\)\)/);
});

test('a "no" mid-game (F2, Sasha 2026-11-21): when the page ends the play-out (noEnding), and that it is wired so', () => {
  const g = Game.fromTPS(PD871847.tps, 0);
  const po = () => playOutOf({ miss: 'f5', at: 0, base: [], g, proven: false, left: 5, key: 'f5', engine: 'syntaks', tak: true });
  // the player's turn (board open; stones in hand, a held move or a hidden tab change nothing here): now
  assert.equal(noEnding(po(), 'no'), 'now'); assert.equal(noEnding(po(), 'no', { busy: false }), 'now');
  // the defender's reply being chosen (thinking) or played onto the board (busy): once it is on the board
  assert.equal(noEnding(Object.assign(po(), { thinking: true }), 'no'), 'reply');
  assert.equal(noEnding(po(), 'no', { busy: true }), 'reply');
  // waiting at the end of the countdown for this very check: the wait ends and it goes out as before
  assert.equal(noEnding(Object.assign(po(), { waiting: 'proof', quiet: 3 }), 'no', { busy: true }), 'wait');
  // nothing ends: an unknown (a timeout) or a proof, a proven play-out, one already over, Rush's cap play-outs
  for (const v of ['unknown', 'wins', undefined]) assert.equal(noEnding(po(), v), null, String(v));
  assert.equal(noEnding(Object.assign(po(), { proven: true }), 'no'), null);
  for (const end of ['out', 'win', 'road', 'held', 'gaveup', 'noengine', REFUTED]) assert.equal(noEnding(Object.assign(po(), { end }), 'no'), null, end);
  const rush = playOutOf({ miss: 'f5', at: 0, base: [], g, proven: false, left: 5, key: 'f5', engine: 'syntaks' });
  assert.equal(rush.rule, undefined); assert.equal(noEnding(rush, 'no'), null); assert.equal(endsOnNo(rush, 'no'), false);
  // rated as any lost play-out: the same as Syntaks holding or running out (and unrated for the same reasons)
  const played = Object.assign(po(), { line: ['f5', 'Sf6'] });
  for (const k of ['held', 'out', 'road']) { assert.equal(lossRated(played, REFUTED), lossRated(played, k)); assert.equal(lossWhy(played, REFUTED), lossWhy(played, k)); }
  assert.equal(lossRated(played, REFUTED), true);
  assert.equal(lossWhy(Object.assign(po(), { line: ['f5', 'Sf6'], fallback: true }), REFUTED), 'dropped');
  assert.equal(lossWhy(Object.assign(po(), { engine: 'tiltak', line: ['f5', 'Sf6'] }), REFUTED), 'tiltak');
  // the page: the handler ends it now only on 'now'; defenderTurn ends it once the reply is on the board, after the
  // reply's own ending and before the board opens; endPlayOn sends it as the 'no' it is and drops a move held for Confirm
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const h = app.slice(app.indexOf('function startPlayOn('), app.indexOf('function makeProven('));
  assert.match(h, /if \(v === 'wins'\) return makeProven\(s, po\);[^\n]*\n\s+c\.final = v;[^\n]*\n(\s+\/\/[^\n]*\n)*\s+if \(noEnding\(po, v, \{ busy: s\.busy \}\) === 'now'\) endPlayOn\(s, REFUTED\);/);
  const dt = app.slice(app.indexOf('async function defenderTurn('), app.indexOf('async function playOnMove('));
  const iEnd = dt.indexOf('if (end) return endPlayOn(s, end);'), iNo = dt.indexOf("noEnding(po, c.final) === 'now') return endPlayOn(s, REFUTED);"), iOpen = dt.indexOf('disableBoard: false');
  assert.ok(iEnd > 0 && iNo > iEnd && iOpen > iNo, 'the reply\'s ending, then the no, then the board opens');
  assert.match(app, /if \(kind === REFUTED\) \{ if \(pend\?\.s === s\) dropPending\(\); if \(c\?\.playOn === po\) sent = settleCheck\(s, 'no', opts\); \}\n\s+else if \(c\?\.playOn === po\) \{/);
  // the card says why, in one line of its own (playon-copy.js end.lead.refuted)
  assert.match(app, /refuted \? tc\('end\.lead\.refuted'\)/);
  // (the check only searches wins made of Tak threats, so a 'no' means none was found, not that none exists: review F1)
  assert.equal(copy('end.lead.refuted', { m: 'f5', E: 'Syntaks' }), 'Our check found no forced win after f5, and the game against Syntaks stops here');
  assert.doesNotMatch(copy('end.lead.refuted', { m: 'f5', E: 'Syntaks' }), /doesn’t force|does not force|no forced win exists/);
  // Rush is untouched by it
  const rushSrc = fs.readFileSync(new URL('../public/rush.js', import.meta.url), 'utf8');
  assert.doesNotMatch(rushSrc, /noEnding|endsOnNo|REFUTED/);
});

test('copy: every id the page asks for exists, every string fills all its slots, none breaks house style', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const used = new Set([...app.matchAll(/\b(?:c|tc|copy)\(\s*'([a-z]+\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]));
  for (const m of app.matchAll(/c\(`po\.wait\.\$\{po\.waiting\}`\)/g)) { used.add('po.wait.proof'); used.add('po.wait.length'); }
  for (const m of app.matchAll(/'(po\.status\.countdown1?|po\.title\.\w+|end\.lead\.\w+)'/g)) used.add(m[1]);
  for (const id of used) assert.ok(id in COPY, id);
  for (const id of Object.keys(COPY)) assert.ok(used.has(id), 'unused: ' + id);
  const v = { m: 'f5', E: 'Syntaks', n: 7, k: TAK_COUNTDOWN, k1: TAK_COUNTDOWN + 1, left: 2, mv: '7 moves', move: 'a3', orGiveUp: '' };
  for (const id of Object.keys(COPY)) {
    const t = copy(id, v);
    assert.doesNotMatch(t, /\{\w+\}/, id); assert.doesNotMatch(t, /!/, id); assert.doesNotMatch(COPY[id], /\b[23]\b/, id); // (numbers come from TAK_COUNTDOWN)
  }
  assert.equal(copy('po.status.countdown', v), 'a3 isn’t Tak · 2 moves left');
  assert.equal(copy('end.h2.out'), 'No threat', 'Sasha\'s choice');
  assert.equal(copy('po.status.tak', v) + copy('po.status.thinking', v), 'Move 7 · keep making Tak · thinking…');
});

test('a long play-out (1000 of your moves) breaks nothing: the rule, the log the server keeps, the held record, isTak on a real game', () => {
  // a real game: 1000 moves of each side's, stack moves where there are any (placements would end it on reserves),
  // never one that ends the game; isTak after each of the attacker's moves
  let seed = 11; const rnd = (k) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % k);
  const g = Game.fromTPS(PD871847.tps, 0), solver = g.toMove;
  const po = playOutOf({ miss: 'x', at: 0, base: [], g, proven: false, left: 5, key: 'x', engine: 'syntaks', tak: true });
  const log = [{ m: 'a1', ms: 1000, k: 'ok' }], t0 = Date.now(); let ms = 2000, ply = 0;
  while (po.mine < 1000) {
    const all = g.legalMoves().filter((m) => { const u = g.apply(m); const r = g.result(); g.undo(u); return !r; });
    const pool = all.filter((m) => m.kind === 'm').length ? all.filter((m) => m.kind === 'm') : all;
    assert.ok(pool.length, 'a move that keeps the game going');
    const mv = pool[rnd(pool.length)], ptn = g.moveToPTN(mv); g.apply(mv); ply++; ms += 1500;
    if (g.toMove !== solver) { po.mine++; countTak(po, isTak(g, solver)); }
    if (logOk(log, ms)) log.push(g.toMove !== solver ? { m: ptn, ms, k: 'po' } : { m: replyEntry(ptn), ms, k: 'po' });
  }
  assert.ok(Date.now() - t0 < 20e3, 'isTak and the game stay fast');
  assert.equal(ply, 2 * 999 - 1); assert.equal(log.length, LOG.max); // (999 of the attacker's moves past the first, the replies between) // the head is kept, nothing past the server's limit
  // what the server keeps of it (server.js cleanLog, as on main): every entry passes its PTN pattern, the size is small
  for (const e of log) { assert.ok(PTN_RE.test(e.m) && e.m.length <= 24, e.m); assert.ok(e.ms <= LOG.ms); }
  assert.equal(log.filter(isReplyEntry).length, LOG.max / 2 - 1);
  for (const e of log.filter(isReplyEntry)) assert.equal(new Game(6).canon(e.m), e.m.slice(0, -1)); // (parseMove drops the mark)
  // past an hour nothing more is logged (one entry over it and the server would keep no log at all)
  assert.equal(logOk([], LOG.ms + 1), false); assert.equal(logOk([], LOG.ms), true);
  // the held record and the result body stay far under sessionStorage's and the server's limits (1e5 bytes)
  const held = settledHeld('pd871847', { ms: 172875, log }, false, false, 'smash');
  const body = JSON.stringify(heldResend({ ...held, b: 1, owner: 'o' }, 'o', false).body);
  assert.ok(body.length < 20000, String(body.length));
});

console.log(`\nOK: ${n} play-on tests`);
