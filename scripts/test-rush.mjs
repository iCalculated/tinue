// Rush and Streak: the pure rules (public/rush-rules.js: judging, clock, combo, summary), the server's run planning and
// post checks (server/rush.js), then the endpoints on a throwaway server and database (as test-server.mjs does).
// Also: a run never touches users, puzzles or attempts.   node scripts/test-rush.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';
import * as R from '../public/rush-rules.js';
import { guestLabel, planRun, cleanRun, cleanMoves, capMoves, rampTarget, weekOf, maxBonus, maxBonusFor, createRush, introOf, BEST_SQL, RUN_LEN, RUN_TTL, MAX_MV, lineMost, MAX_TAK_LINE } from '../server/rush.js';
import { Game } from '../shared/tak.js';
import * as SYM from '../shared/sym.js';
import { slowerWinsAt, pliesLeftOf, playOutOf, applyProofLength, capMoves as capOf, provenCap, quickOutcome, ending, defender } from '../public/playon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
let failed = 0; // every test runs, and the file fails at the end if any did
const test = async (name, fn) => { try { await fn(); n++; console.log('ok', name); } catch (e) { failed++; console.log('FAIL', name, '\n ', e.message.split('\n')[0]); } };

// Two real puzzles: a 6×6 three-move line (Black to play) and a 5×5 one-move road.
const P6 = { id: 'pd877899', size: 6, rating: 2300, komi: 2, tps: 'x,121,x,1,1,21/x,2,2221C,2,2,2/1,1,1112S,12,2,1/x,1,2,112C,1,1/x,1,1,2,2,2/x,1,x,2,x,1 2 28',
  tree: { 'b5+': { r: 'Sc6', n: { 'f5+': { r: 'c2>', n: { 'e2<': { r: 'e6>', n: 'win' } } } } } } };
// A short game on record (meta.history from the first move) and the puzzle position it reaches.
const HIST = ['a1', 'f6', 'c3', 'd4', 'c4'];
const histGame = (n) => { const g = new Game(6); for (const m of HIST.slice(0, n)) g.play(m); return g.toTPS(); };
const P5 = { id: 'ps878984', size: 5, rating: 700, komi: 0, tps: '1,1,1,2,x/x2,112211C,212C,x/x,22121S,212S,221S,1/2,x,11122,x,2/1,1S,11212S,x,2 1 38', tree: 'win' };

await test('combo bonuses: +3 s at 5, +5 at 12, +7 at 20, +10 at 30, then +10 every 10', () => {
  const got = [];
  for (let c = 1; c <= 70; c++) if (R.bonusAt(c)) got.push([c, R.bonusAt(c) / 1000]);
  assert.deepEqual(got, [[5, 3], [12, 5], [20, 7], [30, 10], [40, 10], [50, 10], [60, 10], [70, 10]]);
  assert.deepEqual(R.nextBonus(0), { at: 5, ms: 3000, frac: 0 });
  assert.deepEqual(R.nextBonus(5), { at: 12, ms: 5000, frac: 0 });
  assert.equal(R.nextBonus(8).frac, 3 / 7);
  assert.deepEqual(R.nextBonus(30), { at: 40, ms: 10000, frac: 0 });
  assert.deepEqual(R.nextBonus(45), { at: 50, ms: 10000, frac: 0.5 });
});

await test('combo weight: a stack move counts each square it drops on; anything else counts one', () => {
  for (const m of ['a1', 'Sc3', 'Cc3', 'b5+', 'a2>', '3c3<', '6f1+', '2b2-2']) assert.equal(R.weight(m), 1, m);
  assert.equal(R.weight('2a1>11'), 2); assert.equal(R.weight('4a2>112'), 3); assert.equal(R.weight('6a1>11112'), 5); assert.equal(R.weight('3c3<12*'), 2);
  assert.equal(R.weight(null), 1); assert.equal(R.weight('junk'), 1);
  assert.equal(R.MAX_DROPS, 5);
  // the weight counts toward the combo; a move crossing two bonus marks pays both
  const run = R.newRun('rush');
  for (let i = 0; i < 4; i++) R.correct(run);
  assert.equal(R.correct(run, 9), 3000 + 5000); // 4 -> 13: past 5 and 12
  assert.equal(run.combo, 13); assert.equal(run.bonusMs, 8000); assert.equal(run.moves, 5); assert.equal(run.units, 13); assert.equal(run.bestCombo, 13);
  assert.equal(R.correct(run, 2), 0); // 15
  assert.deepEqual(R.nextBonus(run.combo), { at: 20, ms: 7000, frac: 3 / 8 });
  R.wrong(run, 1000);
  assert.equal(run.combo, 0); assert.equal(run.units, 15); assert.equal(run.bestCombo, 15);
  assert.equal(R.summary(run).moves, 7); assert.equal(R.summary(run).accuracy, 6 / 7); // moves, not drops
  assert.equal(R.resultBody(run).units, 15); assert.equal(R.resultBody(run).bestCombo, 15);
  const st = R.newRun('streak'); assert.equal(R.correct(st, 5), 0); assert.equal(st.combo, 5); // no clock, no bonus
  // what the run screen says and pops is the weighted bonus: 4 -> 7 on one spread, past 5
  const w = R.newRun('rush'); for (let i = 0; i < 4; i++) R.correct(w);
  const b = R.correct(w, R.weight('4a2>112'));
  assert.equal(b, 3000); assert.equal(R.sayText({ r: { rating: 900, solved: true }, mode: 'rush', bonus: b, next: 'White to play.' }), 'White to play. Solved. 3 seconds added.');
});

await test('rush.js: weighted combo, and the move timer opens when input does (the reply beat, the end beat)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  assert.match(src, /R\.correct\(s\.run, R\.weight\(v\.canon\)\)/);
  assert.doesNotMatch(src, /R\.correct\(s\.run\)/);
  const ms = +/const REPLY_MS = (\d+)/.exec(src)[1];
  assert.ok(ms <= 80, 'the reply waits at most 80 ms: ' + ms);
  assert.doesNotMatch(src, /REPLY_LOCK_MS/); // no lock past the reply
  const reply = /function reply\(c, ptn\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.match(reply, /c\.ready = t; board\.lock\(t\)/); assert.match(reply, /R\.openMove\(c, t\)/);
  assert.match(src, /if \(calm\(\)\) reply\(c, v\.reply\)/); // reduced motion: at once
  assert.match(src, /R\.openMove\(c, Math\.max\(performance\.now\(\), c\.ready\)\)/); // a new puzzle: when the board takes input
  assert.match(src, /pointerdown', \(e\) => \{ if \(!st\?\.cur \|\| st\.ended\) return;/); // no input timed during the end beat
});

await test('judge: tree moves get their reply, a road wins on the spot, the rest goes to adjudication, illegal is refused', () => {
  assert.deepEqual(R.judge(P6, [], 'b5+'), { kind: 'ok', canon: 'b5+', reply: 'Sc6' });
  assert.deepEqual(R.judge(P6, [], '1b5+'), { kind: 'ok', canon: 'b5+', reply: 'Sc6' }); // canonical PTN
  assert.deepEqual(R.judge(P6, [], 'a1'), { kind: 'off', canon: 'a1' });
  assert.equal(R.judge(P6, [], 'zz9').kind, 'illegal');
  assert.equal(R.judge(P6, [], 'b6').kind, 'illegal'); // occupied
  assert.deepEqual(R.judge(P6, ['b5+', 'Sc6'], 'f5+'), { kind: 'ok', canon: 'f5+', reply: 'c2>' });
  assert.equal(R.judge(P6, ['b5+', 'Sc6', 'f5+', 'c2>', 'e2<', 'e6>'], 'a1').kind, 'off'); // a 'win' node: anything but a win is checked too
  // the last attacker move of the line wins on the spot (whatever the tree says there)
  const g = R.startGame(P6, ['b5+', 'Sc6', 'f5+', 'c2>', 'e2<', 'e6>']);
  const wins = g.legalMoves().map((m) => g.moveToPTN(m)).filter((m) => { const h = g.clone(); h.play(m); return h.result()?.winner === 2; });
  assert.ok(wins.length > 0);
  assert.deepEqual(R.judge(P6, ['b5+', 'Sc6', 'f5+', 'c2>', 'e2<', 'e6>'], wins[0]), { kind: 'solved', canon: wins[0], how: 'road' });
  // one-move road
  const g5 = R.startGame(P5), road = g5.legalMoves().map((m) => g5.moveToPTN(m)).find((m) => { const h = g5.clone(); h.play(m); return h.result()?.winner === 1; });
  assert.equal(R.judge(P5, [], road).kind, 'solved');
});

await test('judge: a move off the line, listed alternatives included, goes to adjudication; one that loses on the spot is a mistake', () => {
  const p = { ...P6, alts: ['a1'], altsAt: { 'b5+ Sc6': ['a2'] } };
  assert.equal(R.judge(p, [], 'a1').kind, 'off');
  assert.equal(R.judge(p, ['b5+', 'Sc6'], 'a2').kind, 'off');
  assert.deepEqual(R.judge(p, [], 'b5+'), { kind: 'ok', canon: 'b5+', reply: 'Sc6' }); // the tree still counts
  // the puzzle page's own lists say which are known wins (playon.js slowerWinsAt, moved from app.js slowerWins)
  assert.deepEqual(slowerWinsAt(p, []), ['a1']); assert.deepEqual(slowerWinsAt(p, ['b5+', 'Sc6']), ['a2']); assert.deepEqual(slowerWinsAt(p, ['b5+', 'Sc6', 'f5+', 'c2>']), []);
  // a move that ends the game without the player's win is still a mistake on the spot (no check, as on the puzzle page)
  const g = R.startGame(P6), lose = g.legalMoves().map((m) => g.moveToPTN(m)).find((m) => { const h = g.clone(); h.play(m); return h.result() && h.result().winner !== 2; });
  if (lose) assert.equal(R.judge(P6, [], lose).kind, 'wrong');
});

await test('clock: 3:00 from the first move, bonuses add, a mistake costs 10 s and resets the combo', () => {
  const run = R.newRun('rush');
  assert.equal(R.timeLeft(run, 5000), 180e3); // not started
  R.startClock(run, 1000);
  assert.equal(R.timeLeft(run, 11000), 170e3);
  for (let i = 0; i < 5; i++) R.correct(run);
  assert.equal(run.bonusMs, 3000); assert.equal(R.timeLeft(run, 11000), 173e3);
  R.wrong(run, 11000);
  assert.equal(run.combo, 0); assert.equal(run.errors, 1); assert.equal(R.timeLeft(run, 11000), 163e3); assert.equal(run.bestCombo, 5);
  assert.equal(R.expired(run, 1000 + 183e3 - 10e3 - 1), false);
  assert.equal(R.expired(run, 1000 + 173e3), true); // a move made at 0:00 doesn't count: the run is over
  assert.equal(run.endedAt, 1000 + 173e3);
  // a penalty that empties the clock ends the run
  const r2 = R.newRun('rush'); R.startClock(r2, 0); R.wrong(r2, 175e3);
  assert.equal(r2.over, true);
});

await test('streak: no clock, the first wrong move ends it', () => {
  const run = R.newRun('streak');
  R.startClock(run, 0);
  assert.equal(R.timeLeft(run, 1e9), Infinity);
  assert.equal(R.expired(run, 1e9), false);
  R.correct(run); assert.equal(run.bonusMs, 0);
  R.wrong(run, 5000); assert.equal(run.over, true); assert.equal(run.endedAt, 5000);
});

await test('summary and the posted body', () => {
  const run = R.newRun('rush');
  R.startClock(run, 0);
  R.correct(run); R.finish(run, { id: 'a', rating: 900, solved: true, ms: 2000, clock: 178e3, combo: 1 });
  R.correct(run); R.correct(run); R.finish(run, { id: 'b', rating: 1400, solved: true, ms: 3000.4, clock: 175e3, combo: 3 });
  R.wrong(run, 9000); R.finish(run, { id: 'c', rating: 1600, solved: false, wrong: 'a1', ms: 4000, clock: 161e3, combo: 0 });
  R.end(run, 20000);
  const s = R.summary(run);
  assert.deepEqual(s, { score: 2, moves: 4, errors: 1, bestCombo: 3, accuracy: 0.75, ms: 20000, clockMs: 20000, perMove: 5000, highest: 1400 });
  const b = R.resultBody(run, 7);
  assert.equal(b.size, 6); assert.equal(R.SIZE, 6); // Rush is 6×6 only
  assert.equal(b.puzzles[1].ms, 3000);
  assert.deepEqual(b.puzzles[2], { id: 'c', solved: false, ms: 4000, wrong: 'a1', clock: 161000, combo: 0 });
  assert.equal(R.clockText(180e3), '3:00'); assert.equal(R.clockText(59001), '1:00'); assert.equal(R.clockText(500), '0:01');
});

await test('time played: Rush shows its clock; Streak the puzzles\' own times, the first puzzle\'s thinking included', () => {
  // Streak: puzzle 1 shown at 0 and solved at 1.3 s (its first move starts the clock), puzzle 2 missed at 7.6 s
  const run = R.newRun('streak');
  R.startClock(run, 1300); R.correct(run); R.finish(run, { id: 'a', rating: 900, solved: true, ms: 1300 });
  R.wrong(run, 7600); R.finish(run, { id: 'b', rating: 1000, solved: false, wrong: 'a1', ms: 6300 });
  const rec = R.recordOf(run, [], 1);
  assert.equal(rec.sum.clockMs, 6300); // the clock alone left puzzle 1 out
  assert.equal(R.timePlayed(rec), 7600, 'the sum of the times listed');
  // a miss on puzzle 1 (its only move starts and ends the clock): its time, not 0.0 s
  const one = R.newRun('streak'); R.startClock(one, 4200); R.wrong(one, 4200); R.finish(one, { id: 'a', rating: 900, solved: false, wrong: 'a1', ms: 4200 });
  assert.equal(R.timePlayed(R.recordOf(one, [], 1)), 4200);
  // the engine's pauses come off, as on the clock
  const p = R.newRun('streak'); R.startClock(p, 1000); R.pause(p, 2000); R.resume(p, 5000); R.wrong(p, 6000); R.finish(p, { id: 'a', rating: 900, solved: false, ms: 6000 });
  assert.equal(R.timePlayed(R.recordOf(p, [], 1)), 3000);
  // Rush: the clock, unchanged
  const r = R.newRun('rush'); R.startClock(r, 1300); R.correct(r); R.finish(r, { id: 'a', rating: 900, solved: true, ms: 1300 }); R.end(r, 9000);
  assert.equal(R.timePlayed(R.recordOf(r, [], 1)), 7700);
});

await test('a new best is named plainly, the same in Rush and Streak', () => {
  assert.deepEqual(['all', 'week', 'today', null, 'x'].map(R.newBestText), ['New all-time best', 'New best this week', 'New best today', '', '']);
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  assert.match(src, /el\.textContent = nb \? R\.newBestText\(nb\)/); assert.doesNotMatch(src, /best score!|Your best (this week|today)!/);
});

await test('run screen: the colour to move and whether it changed; the last puzzle as a mark and a whole rating', () => {
  assert.deepEqual(R.turn(1), { color: 'white', name: 'White', text: 'White to play.', changed: false }); // the first puzzle: nothing to change from
  assert.deepEqual(R.turn(2, 1), { color: 'black', name: 'Black', text: 'Black to play.', changed: true });
  // the line under the board: the side to move first, the last puzzle's ending after it; a move being checked has the card's words
  const head = R.endingHead({ end: 'win', engine: 'Syntaks', proven: true }, 'a3');
  assert.equal(R.noteText({ toMove: 'Black to play.', head }), 'Black to play. Last puzzle: a3 forces a win, and you played it out against Syntaks, so it counts as solved.');
  assert.ok(R.noteText({ toMove: 'White to play.', head: 'Syntaks held', waiting: true }).startsWith('White to play.'));
  assert.equal(R.noteText({ toMove: 'White to play.', waiting: true }), 'White to play. The clock starts with your first move.');
  assert.equal(R.noteText({ toMove: 'Black to play.' }), 'Black to play.');
  assert.equal(R.noteText({ toMove: 'Black to play.', head, adj: 'Checking a3' }), 'Checking a3');
  assert.equal(R.turn(2, 2).changed, false);
  // the bar above the board: the stone only, no words (Sasha, 2026-11-21: the board's to-move trim says it too)
  const rsrc = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  assert.match(rsrc, /<div class="rush-side" aria-hidden="true"><div class="rush-turn" id="rush-turn"><i><\/i><\/div><\/div>/);
  assert.doesNotMatch(rsrc, /rush-side-name|rush-side-txt|>to play</);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8'), /rush-side-txt/);
  assert.equal(R.turn(R.startGame(P6).toMove).color, 'black');
  assert.equal(R.lastText(null), null);
  assert.deepEqual(R.lastText({ rating: 947.6, solved: true }), { text: '✓ 948', cls: 'good', label: 'Last puzzle solved, rated 948' });
  assert.deepEqual(R.lastText({ rating: 1012.2, solved: false, wrong: 'a1' }), { text: '✗ 1012', cls: 'bad', label: 'Last puzzle failed, rated 1012' });
  assert.deepEqual(R.lastText({ rating: 1200, solved: false, skipped: true }), { text: 'Skipped 1200', cls: 'skip', label: 'Last puzzle skipped, rated 1200' });
});

await test('run screen: one spoken message per puzzle, and at the end', () => {
  const ok = { rating: 900, solved: true }, bad = { rating: 900, solved: false, wrong: 'a1' }, sk = { rating: 900, solved: false, skipped: true };
  assert.equal(R.sayText({ r: ok, mode: 'rush', bonus: 3000, next: 'Black to play.' }), 'Black to play. Solved. 3 seconds added.');
  assert.equal(R.sayText({ r: ok, mode: 'rush', next: 'White to play.' }), 'White to play. Solved.');
  assert.equal(R.sayText({ r: bad, mode: 'rush', next: 'White to play.' }), 'White to play. Wrong. 10 seconds lost.');
  assert.equal(R.sayText({ r: bad, mode: 'rush', over: true }), 'Wrong. 10 seconds lost. Time’s up.');
  assert.equal(R.sayText({ mode: 'rush', over: true }), 'Time’s up.'); // the clock ran out between puzzles
  // Streak: no seconds, ever; its end is 'Streak over'
  assert.equal(R.sayText({ r: ok, mode: 'streak', bonus: 3000, next: 'White to play.' }), 'White to play. Solved.');
  assert.equal(R.sayText({ r: sk, mode: 'streak', next: 'White to play.' }), 'White to play. Skipped.');
  assert.equal(R.sayText({ r: bad, mode: 'streak', over: true }), 'Wrong. Streak over.');
  // after a play-out: the side to move still first, the last puzzle's ending next, as the line under the board reads
  assert.equal(R.sayText({ r: ok, mode: 'rush', bonus: 3000, next: 'Black to play.', head: 'Syntaks held' }), 'Black to play. Last puzzle: Syntaks held. Solved. 3 seconds added.');
  assert.equal(R.sayText({ r: ok, mode: 'rush', over: true, head: 'Syntaks held' }), 'Syntaks held. Solved. Time’s up.'); // the end: no side to move
});

await test('recent runs: short dates (today, yesterday, the year only when not this one) and spoken rows', () => {
  const now = new Date(2026, 10, 18, 21, 0).getTime();
  const W = (t, n = now) => R.whenText(t, n, "en-US").replace(/\s/g, " "); // (ICU puts a narrow no-break space before PM)
  assert.equal(W(new Date(2026, 10, 18, 20, 5).getTime(), now), 'Today, 8:05 PM');
  assert.equal(W(new Date(2026, 10, 17, 20, 5).getTime(), now), 'Yesterday, 8:05 PM');
  assert.equal(W(new Date(2026, 10, 16, 20, 5).getTime(), now), 'Nov 16, 8:05 PM');
  assert.equal(W(new Date(2025, 11, 30, 20, 5).getTime(), now), 'Dec 30, 2025, 8:05 PM');
  assert.equal(W(new Date(2026, 0, 1, 0, 5).getTime(), new Date(2026, 0, 1, 23, 0).getTime()), 'Today, 12:05 AM');
  assert.equal(R.recentLabel({ mode: 'rush', score: 12, sum: { accuracy: 0.8 } }, 'Today, 8:05 PM'), 'Rush, 12 solved, 80% accuracy, Today, 8:05 PM');
  assert.equal(R.recentLabel({ mode: 'streak', score: 3, sum: {} }, 'Nov 16, 8:05 PM'), 'Streak, 3, Nov 16, 8:05 PM');
});

// A look-back's words together, where its marks end (a placement's square, a spread's last), and the squares tinted
const text = (v) => [v.you, v.want].filter(Boolean).join(' · ');
const sq6 = (i) => 'abcdef'[i % 6] + (Math.floor(i / 6) + 1);
const marks = (v) => v.marks.map((m) => [m.role, sq6(m.shape.kind === 'place' ? m.shape.sq : m.shape.to)]);
const led = (p, r) => R.review(p, r).tint?.sqs.map(sq6) ?? null;
await test('looking back: the position, the side to move, the move played against the puzzle\'s, its squares', () => {
  let v = R.review(P6, { solved: false, wrong: 'a1', at: [] });
  assert.equal(text(v), 'You played a1 · The move was b5+');
  assert.equal(v.toMove, 2); assert.deepEqual(marks(v), [['bad', 'a1'], ['good', 'b6']]);
  assert.equal(v.cells.length, 36); assert.equal(v.cells[0].sq, 'a6'); assert.equal(v.cells[35].sq, 'f1');
  assert.deepEqual(v.cells[1], { sq: 'b6', stack: [{ color: 1, type: 0 }, { color: 2, type: 0 }, { color: 1, type: 0 }] }); // 121
  assert.deepEqual(v.cells[8].stack.at(-1), { color: 1, type: 2 }); assert.equal(v.cells[8].stack.length, 4); // c5 2221C
  // a miss further down the line shows the position it was made in, and the move wanted there
  v = R.review(P6, { solved: false, wrong: 'a1', at: ['b5+', 'Sc6'] });
  assert.equal(text(v), 'After b5+ Sc6, you played a1 · The move was f5+');
  assert.equal(v.toMove, 2); assert.equal(v.cells[2].stack.at(-1).type, 1); // the Sc6 reply is on the board
  v = R.review(P6, { solved: true, at: ['b5+'] }); // a solve: the start and its first move, whatever `at` says
  assert.equal(v.want, 'The first move was b5+'); assert.equal(v.you, ''); assert.deepEqual(marks(v), [['good', 'b6']]); assert.deepEqual(v.cells[2].stack, []);
  assert.equal(text(R.review(P6, { solved: false, skipped: true })), 'Skipped · The first move was b5+');
  // a 'win' tree: the move shown is one that wins on the spot
  const ans = R.answerAt(P5), g = R.startGame(P5);
  g.play(ans); assert.equal(g.result()?.winner, 1);
  assert.equal(text(R.review(P5, { solved: false, wrong: 'e5' })), `You played e5 · The move was ${ans}`);
});

await test('rush.js: no typed moves; the board is the only way a move comes in', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  assert.doesNotMatch(src, /<input|<form|rush-ptn|board\.play\(/);
  assert.match(src, /board = frame\.lend\(\$\('#rush-board'\), \{ onMove: \(ptn\) => moveIn\(ptn\), onDead: boardDied \}\);/, 'PTN Ninja\'s frame, borrowed: the only board');
  assert.doesNotMatch(src, /new Board\(|from '\.\/board\.js'/);
});

await test('the intro: the position before the opponent\'s last move, then that move; none without a game on record', () => {
  assert.deepEqual(introOf({ history: HIST }, 6, histGame(5)), { before: histGame(4), last: 'c4' });
  assert.equal(introOf({ history: HIST }, 6, histGame(4)), null, 'a history that doesn\'t reach the puzzle');
  for (const m of [null, {}, { history: [] }, { history: 'a1' }, { history: ['a1', 'zz9'] }, { history: [1] }]) assert.equal(introOf(m, 6, histGame(5)), null, JSON.stringify(m));
  // the board: from `before` with the move on it, or the puzzle's own position
  const p = { ...P6, before: 'B', last: 'c2' };
  assert.deepEqual(R.boardFrom(p), { tps: 'B', moves: ['c2'] });
  assert.deepEqual(R.boardFrom(p, ['b5+', 'Sc6']), { tps: 'B', moves: ['c2', 'b5+', 'Sc6'] });
  assert.deepEqual(R.boardFrom(P6, ['b5+']), { tps: P6.tps, moves: ['b5+'] });
  // the look-back tints the move that led to the position shown
  assert.deepEqual(led(p, { solved: true }), ['c2']);
  assert.deepEqual(led(p, { solved: false, wrong: 'a1', at: ['b5+', 'Sc6'] }), ['c6']);
  assert.equal(led(P6, { solved: true }), null);
});

await test('recent runs: what a run keeps, what a stored list must look like, and its limits', () => {
  const run = R.newRun('rush');
  R.startClock(run, 0);
  R.correct(run); R.finish(run, { id: P6.id, rating: 2300.4, solved: true, ms: 2000.6 });
  R.wrong(run, 5000); R.finish(run, { id: 'pd2', rating: 900, solved: false, wrong: 'a1', at: ['b5+', 'Sc6'], ms: 3000 });
  R.end(run, 9000);
  const rec = R.recordOf(run, [{ ...P6, before: 'B', last: 'c2' }, { ...P6, id: 'pd2' }], 1700000000000);
  assert.equal(rec.v, R.HIST_V); assert.equal(rec.mode, 'rush'); assert.equal(rec.score, 1); assert.deepEqual(rec.sum, R.summary(run));
  assert.deepEqual(rec.puzzles[0], { id: P6.id, rating: 2300, solved: true, ms: 2001, answer: 'b5+', size: 6, tps: P6.tps, komi: 2, last: 'c2' });
  assert.deepEqual(rec.puzzles[1], { id: 'pd2', rating: 900, solved: false, ms: 3000, wrong: 'a1', at: ['b5+', 'Sc6'], answer: 'f5+', size: 6, tps: P6.tps, komi: 2 });
  assert.ok(R.validRecord(rec)); assert.ok(R.validRecord(JSON.parse(JSON.stringify(rec))));
  // the look-back draws a stored puzzle without its tree
  assert.equal(text(R.review(rec.puzzles[1], rec.puzzles[1])), 'After b5+ Sc6, you played a1 · The move was f5+');
  // corrupt or older stored values are skipped, never thrown on
  for (const raw of [null, undefined, 'x', 42, {}, { 0: rec }]) assert.deepEqual(R.historyOf(raw), [], String(raw));
  const old = { t: 1, mode: 'rush', score: 3, results: [] }; // an older shape (no v, no puzzles)
  const broken = [{ ...rec, v: 0 }, { ...rec, mode: 'storm' }, { ...rec, t: 'yesterday' }, { ...rec, sum: null }, { ...rec, sum: { ...rec.sum, score: 'x' } },
    { ...rec, puzzles: [{ ...rec.puzzles[0], tps: 42 }] }, { ...rec, puzzles: [{ ...rec.puzzles[0], at: 'b5+' }] }, { ...rec, puzzles: [{ ...rec.puzzles[0], solved: 1 }] },
    { ...rec, puzzles: [{ ...rec.puzzles[0], size: 99 }] }, { ...rec, puzzles: [null] }, { ...rec, puzzles: 'x' }];
  for (const b of broken) assert.equal(R.validRecord(b), false, JSON.stringify(b).slice(0, 100));
  assert.deepEqual(R.historyOf([old, ...broken, rec, null, 'x']), [rec]);
  assert.deepEqual(R.addRun('corrupt', rec), [rec]);
  // newest first; at most HIST_MAX; at most HIST_CHARS of JSON, the oldest dropped first
  const at = (t) => ({ ...rec, t });
  let list = [];
  for (let t = 1; t <= 40; t++) list = R.addRun(list, at(t));
  assert.equal(list.length, R.HIST_MAX); assert.equal(list[0].t, 40); assert.equal(list.at(-1).t, 11);
  const one = JSON.stringify([rec]).length;
  const small = R.trimHistory(list, 30, one * 5);
  assert.ok(JSON.stringify(small).length <= one * 5 && small.length >= 4); assert.equal(small[0].t, 40);
  assert.deepEqual(R.trimHistory([rec], 30, 10), []); // one run too big for the limit: nothing kept
  const big = { ...rec, puzzles: Array.from({ length: 400 }, (_, i) => ({ ...rec.puzzles[1], id: 'p' + i })) };
  assert.ok(R.validRecord(big)); list = [];
  for (let t = 1; t <= 30; t++) list = R.addRun(list, { ...big, t });
  assert.ok(JSON.stringify(list).length <= R.HIST_CHARS, 'under the size limit'); assert.equal(list[0].t, 30);
});

await test('recent runs stay local: rush.js sends nothing new, and keeps a run whether or not its post works', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  const calls = src.match(/\bapi\(['`][^'`]*/g);
  assert.ok(calls.length >= 5 && calls.every((c) => /^api\(['`]\/api\/rush\/(run|top|best|result)\b/.test(c)), 'only the rush routes: ' + calls.join(' '));
  assert.ok(src.indexOf('saveRun(rec)') < src.indexOf("api('/api/rush/result', body, { quiet: true }); }"), 'saved before the post');
  assert.doesNotMatch(src, /confirm\(/); // asks in the page
});

await test('offline: spare runs (age, per-mode count, size), the result queue (retry rule, expiry)', () => {
  const D = 864e5, now = 100 * D;
  const tok = (t) => t.toString(36) + '.aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(R.tokenTime(tok(now)), now); assert.equal(R.tokenTime('x'), null); assert.equal(R.tokenTime(null), null);
  const spare = (mode, t, extra = {}) => ({ v: 1, mode, token: tok(t), pages: [{ start: 0, ids: [P6.id], sig: 'x'.repeat(22) }], puzzles: [P6], ...extra });
  assert.ok(R.validSpare(spare('rush', now)));
  for (const b of [spare('storm', now), spare('rush', now, { token: 'nope' }), spare('rush', now, { pages: [] }), spare('rush', now, { puzzles: [] }),
    spare('rush', now, { puzzles: [{ ...P6, size: 5 }] }), spare('rush', now, { puzzles: [{ ...P6, tree: null }] }), spare('rush', now, { v: 0 }), null, 'x'])
    assert.equal(R.validSpare(b), false, JSON.stringify(b)?.slice(0, 80));
  // too old to start (under 5 days left to post), corrupt, or of another shape: skipped; oldest first
  const list = [spare('rush', now - 2 * D), spare('rush', now - 26 * D), spare('streak', now - 1 * D), spare('rush', now - 3 * D), 'junk', { v: 2 }];
  assert.deepEqual(R.sparesOf(list, now).map((x) => [x.mode, R.tokenTime(x.token)]), [['rush', now - 3 * D], ['rush', now - 2 * D], ['streak', now - D]]);
  assert.deepEqual(R.sparesOf('corrupt', now), []);
  const t = R.takeSpare(list, 'rush', now);
  assert.equal(R.tokenTime(t.spare.token), now - 3 * D); assert.equal(t.rest.length, 2);
  assert.equal(R.takeSpare([], 'rush', now).spare, null);
  assert.equal(R.spareNeed(list, 'rush', now), R.SPARE_KEEP - 2); assert.equal(R.spareNeed(list, 'streak', now), R.SPARE_KEEP - 1);
  // at most SPARE_KEEP per mode, and the size limit drops the newest first
  const many = Array.from({ length: 6 }, (_, i) => spare('rush', now - i * D));
  assert.equal(R.trimSpares(many, now).length, R.SPARE_KEEP);
  assert.deepEqual(R.trimSpares(many, now).map((x) => R.tokenTime(x.token)), [now - 5 * D, now - 4 * D, now - 3 * D]);
  const one = JSON.stringify([spare('rush', now)]).length;
  assert.equal(R.trimSpares(many, now, 6, one * 2 + 10).length, 2);
  // what a post settles
  assert.equal(R.postOutcome({ id: 7, best: {} }), 'sent');
  for (const e of ['bad run', 'run already posted', 'no player', 'too big']) assert.equal(R.postOutcome({ error: e }), 'drop', e);
  assert.equal(R.postOutcome(null, true), 'keep'); // offline, a timeout, a 5xx page that isn't JSON
  assert.equal(R.postOutcome({ error: 'Too many requests. Try again later.' }), 'keep'); // 429
  assert.equal(R.postOutcome(undefined), 'keep');
  // the queue: oldest first, one per run, none past the token's lifetime, at most QUEUE_MAX
  const item = (t, run = tok(t)) => ({ t, body: { run, mode: 'rush' } });
  const q = R.queueOf([item(now - D), item(now - 3 * D), item(now - 31 * D), item(now - D), null, { t: 'x' }, { t: now }], now);
  assert.deepEqual(q.map((x) => x.t), [now - 3 * D, now - D]);
  assert.deepEqual(R.queueOf('corrupt', now), []);
  const full = R.queueOf(Array.from({ length: 30 }, (_, i) => item(now - i * 1000)), now);
  assert.equal(full.length, R.QUEUE_MAX); assert.equal(R.queueOf([...Array.from({ length: 20 }, (_, i) => item(now - (i + 1) * 1000)), { ...item(now), snap: now }], now).length, R.QUEUE_MAX + 1, 'a run being posted pushes none out'); assert.equal(full.at(-1).t, now); assert.equal(full[0].t, now - 19000);
});

await test('timing: per move, from the board taking it to the first input and to the move; the run\'s setting; abandoning', () => {
  const c = {};
  R.openMove(c, 1000);
  R.touchMove(c, 900); // before the board took it: not this move's
  R.touchMove(c, 1450.4); R.touchMove(c, 1600); // only the first counts
  R.holdMove(c, 2100.6);
  R.closeMove(c, 2500.2, 3, true);
  assert.deepEqual(c.moves, [{ first: 450, ms: 1500, held: 1101, weight: 3, correct: true }]);
  assert.equal(c.mv, null);
  R.openMove(c, 3000); R.closeMove(c, 3200, 1, false); // no input seen (a key the page didn't get): first is null
  assert.deepEqual(c.moves[1], { first: null, ms: 200, weight: 1, correct: false });
  assert.deepEqual(['phone', 'tablet', 'desktop'], [375, 800, 1440].map(R.widthClass));
  assert.equal(R.inputKind(new Set(['touch'])), 'touch'); assert.equal(R.inputKind(new Set(['mouse', 'touch'])), 'both'); assert.equal(R.inputKind(new Set()), undefined);
  // abandoning: only after a move, with the puzzle it was left on when a move was made there
  const run = R.newRun('rush');
  assert.equal(R.canAbandon(run), false);
  R.startClock(run, 0); R.correct(run); R.finish(run, { id: 'a', rating: 900, solved: true, ms: 2000, mv: [{ first: 300, ms: 900, weight: 1, correct: true }], hidden: false, clock: 178e3, combo: 1 });
  R.correct(run, 2);
  assert.equal(R.canAbandon(run), true);
  const cur = { p: { id: 'b', rating: 950 }, born: 2500, moves: [{ first: 100, ms: 400, weight: 2, correct: true }], hidden: true };
  const b = R.abandonBody(run, cur, 5000, 7, { input: 'touch', confirm: false, calm: false, width: 'phone' });
  assert.equal(b.abandoned, true); assert.equal(b.ms, 5000); assert.equal(b.moves, 2); assert.equal(b.units, 3);
  assert.deepEqual(b.env, { input: 'touch', confirm: false, calm: false, width: 'phone' });
  assert.deepEqual(b.puzzles[1], { id: 'b', solved: false, unfinished: true, ms: 2500, mv: cur.moves, hidden: true });
  assert.equal(run.over, false, 'the run itself is untouched'); assert.equal(run.results.length, 1);
  assert.equal(R.abandonBody(run, { ...cur, moves: [] }, 5000).puzzles.length, 1); // no move on it: not sent
  R.end(run, 6000); assert.equal(R.canAbandon(run), false); // a run that ended is posted as itself
  assert.deepEqual(R.resultBody(run).puzzles[0].mv, [{ first: 300, ms: 900, weight: 1, correct: true }]);
});

await test('cleanRun: per-move times, the setting and abandoned runs are checked and capped', () => {
  const mvOk = [{ first: 300, ms: 900, weight: 1, correct: true }], miss = [{ first: 100, ms: 400, held: 300, weight: 2, correct: false }];
  const ok = { mode: 'rush', size: '6', score: 1, moves: 2, errors: 1, bestCombo: 1, ms: 180000, build: 3, env: { input: 'mouse', confirm: true, calm: false, width: 'desktop' },
    puzzles: [{ id: 'a', solved: true, ms: 1000, clock: 170000, combo: 1, mv: mvOk, hidden: false }, { id: 'b', solved: false, ms: 900, wrong: 'c3', clock: 160000, combo: 0, mv: miss, hidden: true }] };
  const has = () => true, c = cleanRun(ok, has);
  assert.ok(c); assert.equal(c.abandoned, false); assert.deepEqual(c.env, ok.env);
  assert.deepEqual(c.rows[1].mv, [{ first: 100, ms: 400, held: 300, weight: 2, correct: false, at: null, ptn: null, clock: null }]); assert.equal(c.rows[1].hidden, true);
  // an old-shape post: no mv, hidden or env; all NULL
  const old = cleanRun({ ...ok, env: undefined, puzzles: ok.puzzles.map(({ mv, hidden, ...p }) => p) }, has);
  assert.deepEqual(old.env, { input: null, confirm: null, calm: null, width: null }); assert.equal(old.rows[0].mv, null); assert.equal(old.rows[0].hidden, null);
  const P = (i, x) => ({ ...ok, puzzles: ok.puzzles.map((p, j) => (j === i ? { ...p, ...x } : p)) });
  const bad = {
    'too many moves': P(0, { mv: Array.from({ length: MAX_MV + 1 }, () => ({ ms: 1, weight: 1, correct: true })) }),
    'first after the move': P(0, { mv: [{ first: 950, ms: 900, weight: 1, correct: true }] }),
    'held before first': P(1, { mv: [{ first: 300, held: 200, ms: 400, weight: 1, correct: false }] }),
    'longer than the puzzle': P(0, { mv: [{ ms: 1002, weight: 1, correct: true }] }),
    'moves longer than the puzzle together': P(0, { mv: [{ ms: 600, weight: 1, correct: true }, { ms: 600, weight: 1, correct: true }] }),
    'weight 6': P(0, { mv: [{ ms: 900, weight: 6, correct: true }] }),
    'a miss in a solve': P(0, { mv: [{ ms: 900, weight: 1, correct: false }] }),
    'a failed puzzle ending on a correct move': P(1, { mv: [{ ms: 100, weight: 1, correct: false }, { ms: 100, weight: 1, correct: true }] }),
    'a solve with no moves': P(0, { mv: [] }),
    'fractional ms': P(0, { mv: [{ ms: 900.5, weight: 1, correct: true }] }),
    'hidden not a boolean': P(0, { hidden: 1 }),
    'more moves than the run': { ...ok, moves: 2, errors: 1, puzzles: [ok.puzzles[0], { ...ok.puzzles[1], mv: [{ ms: 100, weight: 1, correct: true }, ...miss] }] },
    'unfinished in a finished run': P(1, { unfinished: true, wrong: undefined, mv: [{ ms: 100, weight: 1, correct: true }] }),
    'abandoned not a boolean': { ...ok, abandoned: 'yes' },
    'env input': { ...ok, env: { ...ok.env, input: 'pen' } }, 'env width': { ...ok, env: { ...ok.env, width: 1440 } },
    'env confirm': { ...ok, env: { ...ok.env, confirm: 'on' } }, 'env not an object': { ...ok, env: 'x' },
  };
  for (const [k, b] of Object.entries(bad)) assert.equal(cleanRun(b, has), null, k);
  assert.equal(cleanMoves([{ ms: 5, weight: 1, correct: true }], 10, 'none').length, 1);
  // abandoned: its last puzzle may be unfinished (correct moves only, no miss); everything else as before
  const ab = { ...ok, abandoned: true, moves: 2, errors: 0, puzzles: [ok.puzzles[0], { id: 'b', solved: false, unfinished: true, ms: 900, mv: [{ first: 50, ms: 300, weight: 1, correct: true }] }] };
  assert.ok(cleanRun(ab, has)?.abandoned);
  assert.equal(cleanRun({ ...ab, puzzles: [ab.puzzles[1], ok.puzzles[0]] }, has), null, 'unfinished, then more');
  assert.equal(cleanRun({ ...ab, puzzles: [ok.puzzles[0], { ...ab.puzzles[1], mv: [{ ms: 300, weight: 1, correct: false }] }] }, has), null, 'a miss in the unfinished one');
  assert.equal(cleanRun({ ...ab, score: 2 }, has), null, 'still: the score is the puzzles solved');
});

await test('trajectory: each move\'s time from the run\'s clock start, its PTN, the clock after it; queued posts keep who played', () => {
  const run = R.newRun('rush'), c = {};
  R.openMove(c, 100); R.closeMove(c, 400, 1, true, 'c3');
  R.stampMove(c, run, 400); // the run's clock hasn't started: nothing to stamp
  assert.equal(c.moves[0].at, undefined);
  R.startClock(run, 400); R.correct(run); R.stampMove(c, run, 400);
  assert.deepEqual(c.moves[0], { first: null, ms: 300, weight: 1, correct: true, ptn: 'c3', at: 0, clock: 180000 });
  for (let i = 0; i < 3; i++) R.correct(run);
  R.openMove(c, 1000); R.closeMove(c, 2400.6, 3, true, '4a2>112');
  R.correct(run, 3); R.stampMove(c, run, 2400.6); // 4 -> 7: +3 s
  assert.deepEqual([c.moves[1].at, c.moves[1].clock, c.moves[1].ptn], [2001, 180000 - 2001 + 3000, '4a2>112']);
  R.openMove(c, 3000); R.closeMove(c, 3500, 1, false, 'a1'); R.wrong(run, 3500); R.stampMove(c, run, 3500);
  assert.equal(c.moves[2].clock, 180000 - 3100 + 3000 - 10000); // the penalty applied
  const st = R.newRun('streak'), d = {};
  R.startClock(st, 50); R.openMove(d, 50); R.closeMove(d, 900, 1, true, 'b2'); R.correct(st); R.stampMove(d, st, 900);
  assert.deepEqual([d.moves[0].at, 'clock' in d.moves[0]], [850, false]); // no clock in Streak
  // who played: a fingerprint of the token, never the token
  assert.equal(R.who(null), null); assert.equal(R.who(''), null);
  assert.equal(R.who('tok-a'), R.who('tok-a')); assert.notEqual(R.who('tok-a'), R.who('tok-b'));
  assert.ok(!R.who('secret-token-123').includes('secret'));
  assert.equal(R.queueOf([{ t: 5, body: { run: 'r' }, who: 'x1' }], 10)[0].who, 'x1');
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  assert.match(src, /if \(!R\.sendable\(it, Date\.now\(\), R\.who\(token\), /, 'the queue sends only as the player who played');
});

await test('cleanRun: the trajectory goes forward through the run, within its time and clock; old posts without it pass', () => {
  const mv = (x) => [{ first: 300, ms: 900, weight: 1, correct: true, ...x }];
  const ok = { mode: 'rush', size: '6', score: 1, moves: 2, errors: 1, bestCombo: 1, ms: 20000, build: 3,
    puzzles: [{ id: 'a', solved: true, ms: 1000, clock: 170000, combo: 1, mv: mv({ at: 0, ptn: 'c3', clock: 180000 }) },
      { id: 'b', solved: false, ms: 900, wrong: 'a1', clock: 160000, combo: 0, mv: [{ first: 100, ms: 400, weight: 1, correct: false, at: 15000, ptn: 'a1', clock: 160000 }] }] };
  const has = () => true;
  assert.deepEqual(cleanRun(ok, has).rows[1].mv[0], { first: 100, ms: 400, held: null, weight: 1, correct: false, at: 15000, ptn: 'a1', clock: 160000 });
  const P = (i, x) => ({ ...ok, puzzles: ok.puzzles.map((p, j) => (j === i ? { ...p, mv: p.mv.map((m) => ({ ...m, ...x })) } : p)) });
  const bad = {
    'after the run': P(1, { at: 22001 }), 'fractional at': P(0, { at: 0.5 }),
    'a ptn that isn\'t one': P(0, { ptn: 'DROP TABLE' }), 'a long ptn': P(0, { ptn: 'a1'.repeat(13) }), 'ptn not a string': P(0, { ptn: 3 }),
    'more clock than it could have': P(0, { clock: 180000 + 1 }), 'negative clock': P(0, { clock: -1 }),
    'a clock in Streak': { ...P(0, { clock: 1000 }), mode: 'streak', puzzles: P(0, { clock: 1000 }).puzzles.map(({ clock, combo, ...p }) => p) },
  };
  bad['going back in time'] = { ...ok, puzzles: [P(0, { at: 5000 }).puzzles[0], P(1, { at: 4000 }).puzzles[1]] };
  for (const [k, b] of Object.entries(bad)) assert.equal(cleanRun(b, has), null, k);
  assert.ok(cleanRun({ ...ok, puzzles: [P(0, { at: 0 }).puzzles[0], P(1, { at: 0 }).puzzles[1]] }, has), 'equal times are fine');
  assert.ok(cleanRun({ ...P(0, { at: undefined, ptn: undefined, clock: undefined }) }, has), 'a move without the trajectory');
});

await test('review fixes: played time; a Rush left past its clock goes as finished; snapshots of other tabs wait; move times capped', () => {
  assert.equal(R.playedAtOf(1000, 4000, 1e12), 1e12 - 3000); assert.equal(R.playedAtOf(5000, 4000, 1e12), 1e12);
  // left before the clock ran out: abandoned, with the open puzzle, and when it ended
  const run = R.newRun('rush');
  R.startClock(run, 0); R.correct(run); R.finish(run, { id: 'a', rating: 900, solved: true, ms: 2000, mv: [{ ms: 900, weight: 1, correct: true }] });
  R.correct(run);
  const cur = { p: { id: 'b', rating: 950 }, born: 2500, moves: [{ ms: 400, weight: 1, correct: true }] };
  let b = R.abandonBody(run, cur, 100000, 1, null, 1e12);
  assert.equal(b.abandoned, true); assert.equal(b.ms, 100000); assert.equal(b.puzzles.length, 2); assert.equal(b.playedAt, 1e12);
  // hidden or closed past it: a finished run ending where the clock did, the puzzle open then kept as unfinished
  b = R.abandonBody(run, cur, 250000, 1, null, 1e12);
  assert.equal(b.abandoned, undefined); assert.equal(b.ms, 180000); assert.deepEqual(b.puzzles.map((p) => [p.id, !!p.unfinished, p.ms]), [['a', false], ['b', true, 177500]].map(([i, u, m]) => [i, u, m ?? 2000]));
  assert.equal(b.playedAt, 1e12 - 70000);
  assert.ok(cleanRun({ ...b, size: '6' }, () => true), 'the server takes it');
  assert.equal(run.over, false, 'the run itself is untouched');
  const early = R.newRun('rush'); R.startClock(early, 0); R.correct(early);
  assert.deepEqual(R.abandonBody(early, cur, 250000).puzzles.map((p) => p.id), ['b'], 'only the open puzzle, unfinished');
  assert.equal(R.abandonBody(early, null, 250000), null, 'nothing at all: nothing to send (a snapshot stays)');
  // the queue: fresh snapshots (another tab still playing) wait two minutes; the run being played here never goes
  const it = (x) => ({ who: 'w', body: { run: 'r1' }, ...x });
  assert.equal(R.sendable(it(), 1e6, 'w', null), true);
  assert.equal(R.sendable(it(), 1e6, 'v', null), false);
  assert.equal(R.sendable(it(), 1e6, 'w', 'r1'), false);
  assert.equal(R.sendable(it({ snap: 1e6 - 60e3 }), 1e6, 'w', null), false);
  assert.equal(R.sendable(it({ snap: 1e6 - 121e3 }), 1e6, 'w', null), true);
  // move times stored within the puzzle's stored time
  const D = 864e5;
  assert.deepEqual(capMoves([{ first: 10, ms: 0.8 * D, held: null }, { first: 0.5 * D, ms: 0.8 * D, held: 0.6 * D }], D),
    [{ first: 10, ms: 0.8 * D, held: null }, { first: 0.2 * D, ms: 0.2 * D, held: 0.2 * D }]);
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  assert.match(src, /addEventListener\('pageshow', \(e\) => \{ if \(e\.persisted && st\?\.gone && !st\.ended\) endRun\(\); \}\)/);
  assert.match(src, /'Saved as left unfinished\.'/);
});

await test('a Rush out of time keeps the puzzle on the board, last, as unfinished: on screen, in history, posted', () => {
  const run = R.newRun('rush');
  R.startClock(run, 0);
  R.correct(run); R.finish(run, { id: 'a', rating: 900, solved: true, ms: 2000, mv: [{ ms: 900, weight: 1, correct: true }], clock: 178e3, combo: 1 });
  R.correct(run, 2);
  const cur = { p: { ...P6, id: 'b' }, born: 5000, line: ['b5+', 'Sc6'], moves: [{ first: 100, ms: 700, weight: 2, correct: true, ptn: 'b5+', at: 4900 }], hidden: false };
  assert.equal(R.expired(run, 200000), true);
  R.closeOpen(run, cur);
  const u = run.results.at(-1);
  assert.deepEqual({ ...u, mv: u.mv.length }, { id: 'b', rating: 2300, solved: false, unfinished: true, ms: 180000 - 5000, mv: 1, hidden: false, at: ['b5+', 'Sc6'], clock: 0, combo: 3 });
  assert.equal(run.score, 1); assert.equal(R.summary(run).highest, 900); assert.equal(R.summary(run).moves, 2); // not a solve
  R.closeOpen(run, cur); assert.equal(run.results.length, 2, 'once');
  // a puzzle already finished, or a Streak: nothing added
  const r2 = R.newRun('rush'); R.finish(r2, { id: 'b', rating: 1, solved: false, wrong: 'a1', ms: 1 }); R.closeOpen(r2, cur); assert.equal(r2.results.length, 1);
  const s2 = R.newRun('streak'); R.closeOpen(s2, cur); assert.equal(s2.results.length, 0);
  // just appeared, no move: listed all the same, with no move rows
  const r3 = R.newRun('rush'); R.startClock(r3, 0); R.expired(r3, 181000); R.closeOpen(r3, { p: { ...P6, id: 'c' }, born: 179990 });
  assert.deepEqual([r3.results[0].unfinished, r3.results[0].mv, r3.results[0].ms, r3.results[0].at], [true, [], 10, []]);
  // history and the look-back: the position reached, the moves made, the puzzle's next move
  const rec = R.recordOf(run, [{ ...P6, id: 'a' }, { ...P6, id: 'b' }], 1);
  assert.ok(R.validRecord(rec)); assert.equal(rec.puzzles[1].unfinished, true); assert.deepEqual(rec.puzzles[1].at, ['b5+', 'Sc6']);
  assert.equal(text(R.review(rec.puzzles[1], rec.puzzles[1])), 'After b5+ Sc6, time ran out · The move was f5+');
  assert.equal(text(R.review({ ...P6 }, { solved: false, unfinished: true, at: [] })), 'Time ran out · The move was b5+');
  assert.ok(R.validRecord({ ...rec, puzzles: rec.puzzles.map(({ unfinished, ...q }) => q) }), 'older entries without it');
  // its mark on the list
  assert.deepEqual(R.resultMark(u), { cls: 'muted', glyph: '·', sr: 'unfinished', text: 'unfinished' });
  assert.deepEqual(R.resultMark({ solved: true }), { cls: 'good', glyph: '✓', sr: 'solved', text: 'solved' });
  assert.deepEqual(R.resultMark({ solved: false, wrong: 'a1' }), { cls: 'bad', glyph: '✗', sr: 'failed, played', text: 'a1' });
  assert.deepEqual(R.resultMark({ solved: false, played: 'b2', po: null }), { cls: 'bad', glyph: '✗', sr: 'failed, played', text: 'b2' }); // a play-out lost
  assert.deepEqual(R.resultMark({ solved: false, skipped: true }), { cls: 'muted', glyph: '–', sr: 'skipped', text: 'skipped' });
  // posted: last, unfinished, with its moves; the run's moves all accounted for
  const b = R.resultBody(run);
  assert.deepEqual(b.puzzles[1], { id: 'b', solved: false, unfinished: true, ms: 175000, clock: 0, combo: 3, mv: cur.moves, hidden: false });
  assert.equal(b.puzzles.reduce((t, p) => t + p.mv.length, 0), b.moves);
  assert.ok(cleanRun(b, () => true), 'the server takes it');
});

await test('cleanRun: a finished Rush may end on one unfinished puzzle; everything else about it is refused as before', () => {
  const ok = { mode: 'rush', size: '6', score: 1, moves: 2, errors: 0, bestCombo: 2, ms: 180000, build: 3,
    puzzles: [{ id: 'a', solved: true, ms: 1000, clock: 170000, combo: 1, mv: [{ ms: 900, weight: 1, correct: true }] },
      { id: 'b', solved: false, unfinished: true, ms: 900, clock: 0, combo: 2, mv: [{ ms: 400, weight: 1, correct: true }] }] };
  const has = () => true;
  assert.ok(cleanRun(ok, has)); assert.equal(cleanRun(ok, has).rows[1].unfinished, true);
  assert.ok(cleanRun({ ...ok, moves: 1, bestCombo: 1, puzzles: [ok.puzzles[0], { ...ok.puzzles[1], ms: 40, combo: 1, mv: [] }] }, has), 'just appeared: no moves, a few ms');
  const u = ok.puzzles[1];
  const bad = {
    'not last': { ...ok, puzzles: [u, ok.puzzles[0]] },
    'two': { ...ok, moves: 3, bestCombo: 3, puzzles: [ok.puzzles[0], { ...u, id: 'c' }, u] },
    'solved': { ...ok, puzzles: [ok.puzzles[0], { ...u, solved: true }] },
    'skipped': { ...ok, puzzles: [ok.puzzles[0], { ...u, skipped: true }] },
    'with a wrong move': { ...ok, errors: 1, puzzles: [ok.puzzles[0], { ...u, wrong: 'a1' }] },
    'a miss among its moves': { ...ok, errors: 1, puzzles: [ok.puzzles[0], { ...u, mv: [{ ms: 400, weight: 1, correct: false }] }] },
    'in a finished Streak': { ...ok, mode: 'streak', puzzles: ok.puzzles.map(({ clock, combo, ...p }) => p) },
    'more moves than the run': { ...ok, moves: 1, bestCombo: 1 },
  };
  for (const [k, b] of Object.entries(bad)) assert.equal(cleanRun(b, has), null, k);
});

// ---------- random orientation (shared/sym.js) ----------
// Real puzzles (scripts/rush-sym-sample.json: 20 6×6 ones from deep-playtak, 4 at each length; before/last are their
// games' position before the opponent's last move and that move).
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rush-sym-sample.json'), 'utf8'));
const roadNow = (g) => g.legalMoves().map((m) => g.moveToPTN(m)).filter((m) => { const h = g.clone(); h.play(m); return h.result()?.winner === g.toMove; });

await test('sym: squares, moves and TPS under the 8 symmetries; a1 stays at the bottom left; each has its inverse', () => {
  // a1 goes to each corner twice (with and without the mirror); the centre-ish c3 never leaves the board
  assert.deepEqual(SYM.SYMS.map((s) => SYM.square(s, 6, 'a1')), ['a1', 'a6', 'f6', 'f1', 'f1', 'a1', 'a6', 'f6']);
  assert.deepEqual(SYM.SYMS.map((s) => SYM.square(s, 6, 'b1')), ['b1', 'a5', 'e6', 'f2', 'e1', 'a2', 'b6', 'f5']);
  // a stack move turns its direction with the board and keeps its count and drops; a placement keeps its piece
  assert.equal(SYM.move(1, 6, '3a1>12'), '3a6-12'); assert.equal(SYM.move(4, 6, '3a1>12'), '3f1<12'); assert.equal(SYM.move(2, 6, 'b2+'), 'e5-');
  assert.equal(SYM.move(3, 6, 'Sc3'), 'Sd3'); assert.equal(SYM.move(5, 6, 'Cf6'), 'Cf6'); assert.equal(SYM.move(2, 6, '2d4<11*'), '2c3>11*');
  for (const s of SYM.SYMS) {
    assert.equal(SYM.inverse(SYM.inverse(s)), s);
    for (const sq of ['a1', 'c4', 'f2', 'e6']) assert.equal(SYM.square(SYM.inverse(s), 6, SYM.square(s, 6, sq)), sq, `${s} ${sq}`);
  }
  assert.equal(new Set(SYM.SYMS.map((s) => SYM.square(s, 6, 'b1') + SYM.square(s, 6, 'a2'))).size, 8, 'eight different maps');
  // TPS as Game.toTPS writes it; colours, side to move and move number unchanged
  const t = SAMPLE[0].tps;
  for (const s of SYM.SYMS) {
    const u = SYM.tps(s, t), g = Game.fromTPS(u);
    assert.equal(g.toTPS(), u); assert.equal(u.split(' ').slice(1).join(' '), t.split(' ').slice(1).join(' '));
    assert.deepEqual([g.stones, g.caps], [Game.fromTPS(t).stones, Game.fromTPS(t).caps]);
    assert.equal(SYM.tps(SYM.inverse(s), u), t);
  }
  assert.ok(SYM.SYMS.every((s) => SYM.pick(() => s / 8 + 0.01) === s) && SYM.pick(() => 0.99999) === 7);
});

await test('sym: every sampled puzzle under all 8 symmetries replays its whole tree legally, wins where it wins, and turns back exactly', () => {
  let edges = 0;
  for (const p0 of SAMPLE) {
    const p = { ...p0, alts: [], altsAt: {} };
    // alternatives as a puzzle lists them (any legal move will do for the mapping): the first legal move off the tree
    const g0 = Game.fromTPS(p.tps, p.komi), off = g0.legalMoves().map((m) => g0.moveToPTN(m)).find((m) => !(m in p.tree));
    p.alts = [off];
    const k1 = Object.keys(p.tree)[0], r1 = p.tree[k1].r;
    if (p.tree[k1].n !== 'win') { const g1 = Game.fromTPS(p.tps, p.komi); g1.play(k1); g1.play(r1); p.altsAt[`${k1} ${r1}`] = [g1.moveToPTN(g1.legalMoves()[0])]; }
    for (const s of SYM.SYMS) {
      const q = SYM.orient(p, s);
      assert.equal(q.sym, s);
      // the tree, edge by edge, in both orientations at once: each move legal, the positions each other's image
      const walk = (g, h, t, u) => {
        if (t === 'win') { assert.equal(u, 'win'); assert.equal(roadNow(g).length > 0, roadNow(h).length > 0, `${p.id} ${s}: a road in one`); return; }
        assert.deepEqual(Object.keys(u), Object.keys(t).map((k) => SYM.move(s, 6, k)));
        for (const [k, e] of Object.entries(t)) {
          const sk = SYM.move(s, 6, k), f = u[sk];
          const g2 = g.clone(), h2 = h.clone();
          g2.play(k); h2.play(sk); // (throws if illegal)
          assert.equal(SYM.tps(s, g2.toTPS()), h2.toTPS(), `${p.id} ${s} ${k}`);
          assert.deepEqual(h2.result(), g2.result());
          edges++;
          if (e.r) { assert.equal(f.r, SYM.move(s, 6, e.r)); g2.play(e.r); h2.play(f.r); assert.equal(SYM.tps(s, g2.toTPS()), h2.toTPS()); }
          walk(g2, h2, e.n, f.n);
        }
      };
      walk(Game.fromTPS(p.tps, p.komi), Game.fromTPS(q.tps, p.komi), p.tree, q.tree);
      // the line's judge agrees under the symmetry, move for move
      const line = [], lineQ = [];
      for (let node = p.tree; node && node !== 'win';) {
        const [k, e] = Object.entries(node)[0];
        assert.deepEqual(R.judge(q, lineQ, SYM.move(s, 6, k)), { kind: 'ok', canon: SYM.move(s, 6, k), reply: SYM.move(s, 6, e.r) });
        line.push(k, e.r); lineQ.push(SYM.move(s, 6, k), SYM.move(s, 6, e.r)); node = e.n;
      }
      const w = roadNow(R.startGame(p, line))[0];
      assert.equal(R.judge(q, lineQ, SYM.move(s, 6, w)).kind, 'solved');
      // the alternatives, keyed by the turned line; the intro reaches the turned position
      assert.deepEqual(slowerWinsAt(q, []), [SYM.move(s, 6, off)]);
      for (const [k, v] of Object.entries(p.altsAt)) assert.deepEqual(slowerWinsAt(q, k.split(' ').map((m) => SYM.move(s, 6, m))), v.map((m) => SYM.move(s, 6, m)));
      if (p.before) { const b = Game.fromTPS(q.before); b.play(q.last); assert.equal(b.toTPS().split(' ')[0], q.tps.split(' ')[0]); }
      assert.deepEqual(SYM.unorient(q), p, `${p.id} ${s}: back exactly`);
      assert.equal(JSON.stringify(SYM.unorient(q)), JSON.stringify(p), 'key order too');
    }
  }
  assert.ok(edges > 1000, String(edges));
});

await test('sym: what is posted is in the puzzle\'s own orientation, with the symmetry used', () => {
  const s = 3, q = SYM.orient(P6, s), run = R.newRun('rush');
  R.startClock(run, 0);
  const k = SYM.move(s, 6, 'b5+'), off = SYM.move(s, 6, 'a1');
  R.correct(run); R.wrong(run, 5000);
  R.finish(run, { id: P6.id, rating: 2300, solved: false, ms: 5000, sym: s, wrong: off, at: [k, SYM.move(s, 6, 'Sc6')],
    mv: [{ ms: 900, weight: 1, correct: true, ptn: k }, { ms: 800, weight: 1, correct: false, ptn: off, check: 'pending', path: [k, SYM.move(s, 6, 'Sc6')],
      po: { proven: false, cap: 4, end: 'held', paused: 3000, line: [{ m: SYM.move(s, 6, 'a2'), ms: 1500 }, { m: SYM.move(s, 6, 'b1'), ms: 700 }, { m: SYM.move(s, 6, 'a3'), ms: 1500 }] }, paused: 5000 }] });
  const b = R.resultBody(run).puzzles[0];
  assert.equal(b.sym, s); assert.equal(b.wrong, 'a1');
  assert.deepEqual(b.mv.map((m) => m.ptn), ['b5+', 'a1']); assert.deepEqual(b.mv[1].path, ['b5+', 'Sc6']);
  assert.deepEqual(b.mv[1].po.line.map((x) => x.m), ['a2', 'b1', 'a3']);
  assert.equal(R.recordOf(run, [q], 1).puzzles[0].tps, q.tps, 'the look-back shows what the player saw');
  assert.equal(R.resultBody(run).puzzles[0].id, P6.id); // the link opens the puzzle page as it is
});

// ---------- moves off the line: the puzzle page's adjudication, Rush's clock ----------
await test('route: each verdict goes where the puzzle page sends it', () => {
  // a refutation is a mistake; a proof is a proven play-out where Syntaks defends, else solved on the spot (slowSolve)
  assert.equal(R.route({ quick: 'no', def: 'syntaks' }), 'mistake');
  assert.equal(R.route({ quick: 'wins', def: 'syntaks' }), 'proven');
  assert.equal(R.route({ quick: 'wins', def: 'tiltak' }), 'solved');
  assert.equal(R.route({ quick: 'wins', def: null }), 'solved');
  // undecided: played out against whoever defends; with no engine, the check's final answer decides
  assert.equal(R.route({ quick: 'pending', def: 'syntaks' }), 'playout');
  assert.equal(R.route({ quick: 'pending', def: 'tiltak' }), 'playout');
  assert.equal(R.route({ quick: 'pending', def: null }), 'wait');
  // a listed alternative needs no check: a known win
  assert.equal(R.route({ alt: true, def: 'syntaks' }), 'proven'); assert.equal(R.route({ alt: true, def: null }), 'solved');
  // the same answers as the puzzle page's quickOutcome (first check, not minor)
  for (const q of ['wins', 'no', 'pending', 'unknown']) assert.equal(quickOutcome(q, false), q === 'unknown' ? 'pending' : q);
  // who defends a Rush board: Syntaks on 6×6 at any half-point komi it knows
  for (const k of [0, 0.5, 2, 2.5, 3.5]) assert.equal(defender(6, k, () => true), 'syntaks');
});

await test('play-out endings: a win or a proof is solved; the defender, the limit or Give up a mistake; no engine waits on the check', () => {
  assert.equal(R.playOutOutcome('win'), 'solved'); assert.equal(R.playOutOutcome('proved', true), 'solved'); assert.equal(R.playOutOutcome('proved', false), 'solved');
  for (const k of ['road', 'held', 'out', 'gaveup']) for (const pr of [true, false]) assert.equal(R.playOutOutcome(k, pr), 'mistake', k);
  assert.equal(R.playOutOutcome('noengine', false), 'wait'); assert.equal(R.playOutOutcome('noengine', true), 'solved'); // (defenderTurn: a proven one is the solve)
  assert.equal(R.playOutOutcome('left'), 'open'); assert.equal(R.playOutOutcome('time'), 'open');
  assert.equal(R.finalOutcome('wins'), 'solved'); for (const v of ['no', 'unknown', undefined]) assert.equal(R.finalOutcome(v), 'mistake');
  // the endings as the game gives them (playon.js ending)
  assert.equal(ending({ winner: 2, kind: 'road' }, 2), 'win'); assert.equal(ending({ winner: 1, kind: 'road' }, 2), 'road'); assert.equal(ending({ winner: 1, kind: 'flat' }, 2), 'held');
  // the move limit is the puzzle page's: the plies left at the node, plus the spare; a proof's length can raise it
  const node = R.nodeAt(P6, []);
  assert.equal(pliesLeftOf(node), 7); assert.equal(pliesLeftOf('win'), 1); assert.equal(pliesLeftOf(null), 0); assert.equal(pliesLeftOf({}), 2); assert.equal(pliesLeftOf({ a1: { r: 'b1' } }), 2);
  const po = playOutOf({ miss: 'a1', at: 0, base: [], g: R.startGame(P6, ['a1']), proven: true, left: 5, key: 'a1', engine: 'syntaks' });
  assert.equal(po.cap, capOf(5)); assert.deepEqual([po.mine, po.line, po.end], [1, ['a1'], null]);
  assert.equal(applyProofLength(po, undefined), false); assert.equal(po.cap, capOf(5));
  assert.equal(applyProofLength(po, 15), true); assert.equal(po.cap, provenCap(5, 15)); assert.equal(po.cap, 9);
});

await test('the clock pauses for the engine: frozen while paused, running on the player\'s turn, never charged', () => {
  const run = R.newRun('rush');
  R.startClock(run, 1000);
  assert.equal(R.timeLeft(run, 11000), 170e3);
  R.pause(run, 11000);
  assert.equal(R.timeLeft(run, 50000), 170e3, 'frozen');
  assert.equal(R.expired(run, 1e6), false, 'a paused clock never runs out');
  R.pause(run, 20000); // (already paused: the start stays)
  assert.equal(R.resume(run, 14500), 3500); assert.equal(R.resume(run, 15000), 0, 'nothing to end');
  assert.equal(run.pausedMs, 3500); assert.equal(R.timeLeft(run, 24500), 160e3);
  assert.equal(R.clockUsed(run, 24500), 20e3); assert.equal(R.pausedTo(run, 24500), 3500);
  // two pauses add up; a mistake after one still costs its 10 s
  R.pause(run, 30000); R.resume(run, 32000);
  assert.equal(R.timeLeft(run, 32000), 180e3 - (32000 - 1000 - 5500));
  R.wrong(run, 32000); assert.equal(R.timeLeft(run, 32000), 180e3 - 25500 - 10e3);
  // running out: at the clock's end, the pauses added to it
  assert.equal(R.expired(run, 1000 + 5500 + 170e3 - 1), false);
  assert.equal(R.expired(run, 1000 + 5500 + 170e3 + 1), true); assert.equal(run.endedAt, 1000 + 5500 + 170e3);
  // a run ending mid-pause (left) ends its pause there
  const r2 = R.newRun('rush'); R.startClock(r2, 0); R.pause(r2, 1000); R.end(r2, 4000);
  assert.deepEqual([r2.pausedMs, r2.pausedAt, R.summary(r2).ms], [3000, null, 4000]);
  assert.equal(R.resultBody(r2).paused, 3000);
  // Streak: no clock, the pauses still counted
  const sk = R.newRun('streak'); R.startClock(sk, 0); R.pause(sk, 10); R.resume(sk, 510);
  assert.equal(sk.pausedMs, 500); assert.equal(R.timeLeft(sk, 1e9), Infinity);
});

await test('a move during a pause is ignored: the board takes nothing until the player is to move again', () => {
  const c = { ready: 100 };
  assert.equal(R.takesMove(c, 99), false); assert.equal(R.takesMove(c, 100), true);
  c.adj = { phase: 'check', turn: false }; c.ready = Infinity;
  assert.equal(R.takesMove(c, 1e9), false, 'during the check');
  c.adj.phase = 'play'; assert.equal(R.takesMove(c, 1e9), false, 'while the defender thinks');
  c.adj.turn = true; c.ready = 5000;
  assert.equal(R.takesMove(c, 4999), false); assert.equal(R.takesMove(c, 5000), true, "the player's turn in the play-out");
  assert.equal(R.takesMove(null, 1), false);
  // rush.js asks before anything else, and nothing but an adjudicated move pauses the clock
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  assert.match(src, /if \(!R\.takesMove\(s\.cur, now\)\) return restore\(\);/);
  assert.deepEqual([...src.matchAll(/R\.pause\(/g)].length, 2, 'hold() and the play-out split');
  assert.match(src, /function hold\(s, c, now\) \{[^}]*R\.pause\(s\.run, now\);\n\s*c\.ready = Infinity; board\.lock\(Infinity\)/);
});

await test('rush.js uses the puzzle page\'s own engines and rules: no engine path of its own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  assert.doesNotMatch(src, /\/api\/defend|syntaks\.search|tiltak\.analyze|\bapi\(`\/api\/analyze/, 'the defender only through defend.js');
  assert.match(src, /await defenderMove\(po, \{ size: c\.p\.size, komi: komiOf\(c\.p\), tps: po\.g\.toTPS\(\), live, onFallback: render \}\)/);
  assert.match(src, /engine\.checkStill\(\{ size: p\.size, komi: komiOf\(p\), tps: p\.tps, plies, attacker: c\.solver \}\)/, "the first check's budgets");
  for (const f of ['playOutOf(', 'applyProofLength(', 'pliesLeftOf(', 'slowerWinsAt(', 'capWait(', 'ending(', 'defender(', 'warmDefender(', 'waitAtCap(', 'upgradeToProven(', 'measureProof(', "busy('giveup', po.t0)"])
    assert.ok(src.includes(f), f);
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.match(app, /defend\.defenderMove\(po, \{/); assert.match(app, /return defend\.syntaksReply\(po, tps, komi, live, s\.x\);/);
  assert.match(app, /playOutOf\(\{ miss: canon/); assert.match(app, /const pliesLeft = \(\) => pliesLeftOf\(S\.node\);/);
});

await test('abandoned mid-adjudication: the open puzzle goes as unfinished, its move open, the pause so far on it; the server takes it', () => {
  const run = R.newRun('rush');
  R.startClock(run, 0);
  R.correct(run); R.finish(run, { id: 'a', rating: 900, solved: true, ms: 2000, mv: [{ ms: 900, weight: 1, correct: true, at: 900 }], clock: 178e3, combo: 1 });
  // puzzle b: a move off the line at 3000, its play-out going, the defender thinking since 6000
  const cur = { p: { ...P6, id: 'b', sym: 5 }, born: 2100, line: [], moves: [], adj: { canon: 'a1' } };
  R.openMove(cur, 2200); R.closeMove(cur, 3000, 1, null, SYM.move(5, 6, 'a1'));
  const m = cur.moves[0];
  assert.deepEqual([m.correct, m.open], [false, true]);
  Object.assign(m, { check: 'pending', checkMs: 2500, paused: 2600, path: [], po: { proven: false, cap: 4, end: null, paused: 1500, line: [{ m: SYM.move(5, 6, 'a2'), ms: 1500 }, { m: SYM.move(5, 6, 'b1'), ms: 700 }] } });
  R.pause(run, 6000);
  assert.equal(R.canAbandon(run, cur), true);
  const b = R.abandonBody(run, cur, 8000, 1, null, Date.now());
  assert.equal(b.abandoned, true);
  const u = b.puzzles.at(-1);
  assert.deepEqual([u.id, u.unfinished, u.sym, u.mv[0].open, u.mv[0].ptn, u.mv[0].paused, u.mv[0].po.line.map((x) => x.m)], ['b', true, 5, true, 'a1', 4600, ['a2', 'b1']]);
  assert.equal(b.paused, 2000, 'the running pause ended where the run did');
  assert.equal(run.pausedAt, 6000, 'the run itself is untouched');
  const c = cleanRun({ ...b, paused: 4600 }, () => true);
  assert.ok(c, 'the server takes it');
  assert.deepEqual([c.rows[1].unfinished, c.rows[1].mv[0].open, c.rows[1].sym], [true, true, 5]);
  // the first move of a run, still being checked, is worth posting
  const r0 = R.newRun('rush'); R.startClock(r0, 0); R.pause(r0, 0);
  const c0 = { p: { ...P6, id: 'z' }, born: 0, line: [], moves: [], adj: { canon: 'a1' } }; R.closeMove(c0, 500, 1, null, 'a1'); Object.assign(c0.moves[0], { check: 'pending', path: [] });
  assert.equal(R.canAbandon(r0), false); assert.equal(R.canAbandon(r0, c0), true);
  const b0 = R.abandonBody(r0, c0, 2000, 1);
  assert.ok(cleanRun(b0, () => true), 'one open move and nothing else');
  // a Rush out of time on the player's turn in a play-out: unfinished, the move open, how far it got in the look-back
  const r3 = R.newRun('rush'); R.startClock(r3, 0);
  const po = playOutOf({ miss: 'a1', at: 0, base: [], g: R.startGame(P6, ['a1']), proven: true, left: 5, key: 'a1', engine: 'syntaks' });
  po.line.push('a2', 'b1'); po.mine = 2; po.end = 'time';
  const c3 = { p: { ...P6, id: 'y' }, born: 0, line: [], moves: [{ ms: 300, weight: 1, correct: false, open: true, ptn: 'a1', check: 'alt', path: [], po: { proven: true, cap: po.cap, end: 'time', paused: 1500, line: [{ m: 'a2', ms: 1500 }, { m: 'b1', ms: 900 }] }, paused: 1500 }],
    adj: { canon: 'a1', look: R.playOutLook(po, 'Syntaks') } };
  assert.equal(R.expired(r3, 200000), true); R.closeOpen(r3, c3);
  const u3 = r3.results[0];
  assert.deepEqual([u3.unfinished, u3.played, u3.po.end, u3.po.n], [true, 'a1', 'time', 2]);
  assert.equal(R.review(P6, u3).you, 'You played a1 (move 2 of 8); time ran out'.replace('8', String(po.cap)));
  assert.ok(R.validRecord(R.recordOf(r3, [{ ...P6, id: 'y' }], 1)));
});

await test('look-back: a puzzle decided by a play-out shows the move and how the game ended, in the puzzle page\'s words', () => {
  const look = (end, extra = {}) => ({ end, engine: 'Syntaks', proven: false, n: 3, cap: 8, byYou: false, ...extra });
  const r = (solved, po) => ({ solved, played: 'a1', at: [], po, ...(solved ? {} : { wrong: 'a1' }) });
  assert.equal(R.review(P6, r(true, look('win'))).you, 'You played a1. a1 won against Syntaks, so it counts as solved.');
  assert.equal(R.review(P6, r(true, look('win', { proven: true }))).you, 'You played a1. a1 forces a win, and you played it out against Syntaks, so it counts as solved.');
  assert.equal(R.review(P6, r(true, look('proved'))).you, 'You played a1. a1 forces a win too, so it counts as solved.');
  assert.equal(R.review(P6, r(true, null)).you, 'You played a1. a1 forces a win too, so it counts as solved.');
  assert.equal(R.review(P6, r(false, look('held'))).you, 'You played a1. Syntaks defended a1 for 3 moves.');
  assert.equal(R.review(P6, r(false, look('gaveup'))).you, 'You played a1. You gave up on a1 after 3 moves.');
  assert.equal(R.review(P6, r(false, look('out', { proven: true }))).you, 'You played a1. a1 wins, but you didn’t finish it in 3 moves: Syntaks held.');
  assert.equal(R.review(P6, r(false, look('road', { proven: true, byYou: true }))).you, 'You played a1. a1 wins, but your move 3 completed Syntaks’s road.');
  assert.equal(R.review(P6, r(false, null)).you, 'You played a1. a1 doesn’t force the win.');
  const v = R.review(P6, r(true, look('win')));
  assert.deepEqual([marks(v), v.want], [[['good', 'a1']], 'The puzzle’s line plays b5+']); // (the winning move is the one marked good)
  assert.deepEqual(marks(R.review(P6, r(false, look('held'))))[0], ['bad', 'a1']);
  // the turn line's words: the card headings and status lines
  assert.equal(R.cardHead('checking', { move: 'a1' }), 'Checking a1');
  assert.equal(R.cardHead('play', { proven: true }), 'That wins: play it out'); assert.equal(R.cardHead('play', { proven: true, late: true }), 'Proved: play it out'); assert.equal(R.cardHead('play'), 'Play it out');
  assert.equal(R.playOutStatus({ mine: 1, cap: 8, thinking: true }, 'Syntaks'), 'Move 1 of 8 · Syntaks is thinking…');
  assert.equal(R.playOutStatus({ mine: 1, cap: 8, thinking: false }, 'Syntaks'), 'Move 2 of 8');
  assert.equal(R.playOutStatus({ mine: 8, cap: 8, waiting: 'length' }, 'Syntaks'), 'Out of moves at 8 unless the proven win is longer: measuring it…');
  for (const [end, h] of [['gaveup', 'You gave up'], ['out', 'Out of moves'], ['held', 'Syntaks held'], ['road', 'Syntaks made a road']]) assert.equal(R.endingHead(look(end), 'a1'), h);
  assert.equal(R.endingHead(look('road', { byYou: true }), 'a1'), 'Your move completed Syntaks’s road');
  // each of those strings is the puzzle page's own (app.js renderFeedback / slowWinText, playon-copy.js), except the move
  // cap's: the puzzle page has the Tak rule since 2026-11-21 and Rush keeps the cap (and its words) until its server
  // takes longer play-outs. Neon's copy for the Tak rule (playon-copy.js, 2026-11-21) is the puzzle page's alone, so
  // Rush keeps its own "Proved: play it out", "· Syntaks is thinking…" and "won against Syntaks" (rush-rules.js).
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public/playon-copy.js'), 'utf8');
  for (const s of ['That wins: play it out', "'Play it out'", 'Checking ${esc(S.checking)}', "'You gave up'", "'Out of moves'", '`${E} held`', '`${E} made a road`', '`Your move completed ${E}’s road`',
    'forces a win, and you played it out against {E}, so it counts as solved',
    'forces a win too, so it counts as solved', 'wins, but you didn’t finish it in ${mv}: ${E} held', 'defended ${esc(r.miss)} for ${mv}', 'You gave up on ${esc(r.miss)} after ${mv}', 'doesn’t force the win.', 'data-act="giveup"', '>Give up</button>'])
    assert.ok(app.includes(s), s);
});

await test('cleanRun: a play-out under the Tak rule (rule tak, no cap) is taken with any line (kept to MAX_TAK_LINE plies), stored with cap 0', () => {
  const line = (n) => Array.from({ length: n }, (_, j) => ({ m: j % 2 ? 'a2' : 'a3', ms: j % 2 ? 1500 : 500 }));
  const post = (po) => ({ mode: 'rush', size: '6', score: 1, moves: 1, errors: 0, bestCombo: 1, ms: 187000, paused: 9e4, build: 3,
    puzzles: [{ id: 'a', solved: true, ms: 180000, clock: 175000, combo: 1, sym: 0, mv: [{ ms: 180000, weight: 1, correct: true, ptn: 'a1', check: 'pending', checkMs: 2500, paused: 9e4, path: [], po }] }] });
  const tak = (n, extra = {}) => ({ proven: false, rule: 'tak', end: 'win', paused: 9e4, line: line(n), ...extra });
  let c = cleanRun(post(tak(100)), () => true); // 50 of the player's moves: past any cap Rush allows today
  assert.ok(c); assert.equal(c.rows[0].mv[0].po.cap, 0); assert.equal(c.rows[0].mv[0].po.line.length, 100);
  assert.ok(cleanRun(post(tak(10)), () => true));
  // past MAX_TAK_LINE: the run is taken, the line kept to its first MAX_TAK_LINE plies (refusing would lose the run)
  const quick = (n) => line(n).map((x, j) => (j % 2 ? x : { ...x, ms: 0 })); // (the defender's replies instant: within the pause)
  for (const n of [MAX_TAK_LINE + 2, 2000]) { c = cleanRun(post(tak(n, { line: quick(n) })), () => true); assert.ok(c, `${n} plies`); assert.equal(c.rows[0].mv[0].po.line.length, MAX_TAK_LINE); }
  assert.equal(cleanRun(post(tak(10, { line: [...line(9), { m: 'not a move', ms: 1 }] })), () => true), null, 'a bad ply');
  assert.equal(cleanRun(post(tak(10, { line: [...quick(MAX_TAK_LINE + 1), { m: 'not a move', ms: 1 }] })), () => true), null, 'a bad ply past the stored part (all of it is checked)');
  assert.equal(cleanRun(post(tak(10, { cap: 8 })), () => true), null, 'a cap with the Tak rule');
  assert.equal(cleanRun(post(tak(10, { rule: 'other', cap: 8 })), () => true), null, 'an unknown rule');
  assert.equal(cleanRun(post({ proven: false, cap: 40, end: 'win', paused: 9e4, line: line(100) }), () => true), null, 'the cap rule as before: 78 plies at most');
  // a proven play-out's cap is as long as its proof (provenCap): past 40 moves too
  const cap = provenCap(5, 85);
  assert.equal(cap, 44); c = cleanRun(post({ proven: true, cap, end: 'win', paused: 9e4, line: line(86) }), () => true);
  assert.ok(c); assert.equal(c.rows[0].mv[0].po.cap, 44);
});

await test('cleanRun: the adjudication fields: accepted within the engine limits, refused past them; old posts as before', () => {
  const has = () => true;
  const playout = { proven: false, cap: 8, end: 'win', paused: 3000, line: [{ m: 'a2', ms: 1500 }, { m: 'b1', ms: 700 }, { m: 'a3', ms: 1500 }] };
  const adj = { ms: 800, weight: 1, correct: true, ptn: 'a1', check: 'pending', checkMs: 2500, paused: 5500, path: ['b5+', 'Sc6'], po: playout };
  const ok = { mode: 'rush', size: '6', score: 2, moves: 4, errors: 1, bestCombo: 3, ms: 187000, paused: 5500, build: 3,
    puzzles: [{ id: 'a', solved: true, ms: 9000, clock: 175000, combo: 2, sym: 3, mv: [{ ms: 900, weight: 1, correct: true, ptn: 'b5+' }, adj] },
      { id: 'b', solved: true, ms: 1000, clock: 170000, combo: 2, sym: 0, mv: [] },
      { id: 'c', solved: false, ms: 900, wrong: 'a1', clock: 1000, combo: 0, mv: [{ ms: 400, weight: 1, correct: false, ptn: 'a1', check: 'no', checkMs: 2400, paused: 2400, path: [] }] }] };
  ok.puzzles[1].mv = [{ ms: 500, weight: 1, correct: true, ptn: 'c3', check: 'alt', paused: 0, path: [] }]; // (a proof with no play-out: solved on the spot)
  ok.paused = 5500 + 2400;
  const c = cleanRun(ok, has);
  assert.ok(c);
  assert.equal(c.paused, 7900); assert.deepEqual([c.rows[0].sym, c.rows[0].mv[1].po.end, c.rows[0].mv[1].check, c.rows[2].mv[0].check], [3, 'win', 'pending', 'no']);
  // the Rush bound is on time on the clock: 187 s real is fine with 7.9 s paused, not without
  assert.equal(cleanRun({ ...ok, paused: 0 }, has), null, 'over 3:00 on the clock');
  // an old post (no paused, no sym, no adjudication) is taken as before
  const old = { ...ok, ms: 180000, paused: undefined, puzzles: ok.puzzles.map(({ sym, mv, ...p }) => ({ ...p, mv: mv.map(({ ms, weight, correct }) => ({ ms, weight, correct })) })) };
  assert.ok(cleanRun(old, has), 'old shape');
  const at = (i, f) => ({ ...ok, puzzles: ok.puzzles.map((p, j) => (j === i ? f(p) : p)) });
  const mvAt = (i, f) => at(i, (p) => ({ ...p, mv: p.mv.map((m, k) => (k === p.mv.length - 1 ? f(m) : m)) }));
  const bad = {
    'paused over its parts': { ...ok, paused: 7900 + 1001 },
    'paused negative': { ...ok, paused: -1 },
    'paused over the run': { ...ok, paused: 188000 },
    'sym out of range': at(0, (p) => ({ ...p, sym: 8 })),
    'sym not a number': at(0, (p) => ({ ...p, sym: '3' })),
    'unknown check': mvAt(0, (m) => ({ ...m, check: 'maybe' })),
    'check on a move before the last': at(0, (p) => ({ ...p, mv: [{ ...p.mv[0], check: 'no' }, p.mv[1]] })),
    'check too long': mvAt(2, (m) => ({ ...m, checkMs: 9000 })),
    'a check time on an alternative': mvAt(1, (m) => ({ ...m, checkMs: 10 })),
    'a pause past the engine limits': mvAt(2, (m) => ({ ...m, paused: 80000 })),
    'a play-out after a refutation': mvAt(2, (m) => ({ ...m, po: { ...playout, end: 'held' } })),
    'a won play-out on a failed move': mvAt(2, (m) => ({ ...m, check: 'pending', po: playout })),
    'a lost play-out on a solved move': mvAt(0, (m) => ({ ...m, po: { ...playout, end: 'held' } })),
    'an ending it can\'t have': mvAt(0, (m) => ({ ...m, po: { ...playout, end: 'resigned' } })),
    'more moves than the limit': mvAt(0, (m) => ({ ...m, po: { ...playout, cap: 2 } })),
    'a limit past any': mvAt(0, (m) => ({ ...m, po: { ...playout, cap: MAX_TAK_LINE / 2 + 1 } })),
    'a reply past the engine limits': mvAt(0, (m) => ({ ...m, paused: 200000, po: { ...playout, paused: 100000, line: [{ m: 'a2', ms: 90000 }] } })),
    'replies longer than the pause': mvAt(0, (m) => ({ ...m, po: { ...playout, paused: 1000 } })),
    'the play-out paused more than its move': mvAt(0, (m) => ({ ...m, po: { ...playout, paused: 6000 } })),
    'a bad move in it': mvAt(0, (m) => ({ ...m, po: { ...playout, line: [{ m: 'zz9', ms: 1 }] } })),
    'open on a finished puzzle': mvAt(2, (m) => ({ ...m, open: true })),
    'a solve with no proof and no game': mvAt(1, (m) => ({ ...m, check: 'no' })),
    'a bad path': mvAt(0, (m) => ({ ...m, path: ['x9'] })),
  };
  for (const [k, b] of Object.entries(bad)) assert.equal(cleanRun(b, has), null, k);
  // a hidden puzzle's pauses get slack (the engines' clocks count visible time only)
  assert.equal(cleanRun(mvAt(2, (m) => ({ ...m, paused: 80000 })), has), null);
  assert.ok(cleanRun({ ...mvAt(2, (m) => ({ ...m, paused: 80000 })), paused: 5500 + 80000, ms: 260000 }, has) == null, 'not hidden: refused');
  assert.ok(cleanRun({ ...at(2, (p) => ({ ...p, hidden: true, mv: [{ ...p.mv[0], paused: 80000 }] })), paused: 5500 + 80000, ms: 260000 }, has), 'hidden: taken');
});

// ---------- review fixes (2026-11-19): a run left during the check, an 'unknown' answer, pauses by verdict, a frozen
// page, the turn line in a wait, time played, a play-out left, the final answer, the shared rules ----------
// A run as rush.js builds it: one puzzle solved, then a move off the line on the next (R.openAdj, the clock paused).
const offLine = ({ mode = 'rush', hidden = false } = {}) => {
  const run = R.newRun(mode);
  R.startClock(run, 0);
  R.correct(run); R.finish(run, { id: 'a', rating: 900, solved: true, ms: 2000, mv: [{ ms: 900, weight: 1, correct: true, at: 900 }], ...(mode === 'rush' ? { clock: 178e3, combo: 1 } : {}) });
  const cur = { p: { ...P6, id: 'b', sym: 2 }, born: 2100, line: [], moves: [], hidden };
  R.openMove(cur, 2200);
  const m = R.openAdj(cur, 3000, 1, 'c3');
  R.pause(run, 3000);
  return { run, cur, m };
};

await test('a run left while the check runs posts the open move as checking, and the server takes it', () => {
  const { run, cur, m } = offLine();
  assert.deepEqual([m.check, m.open, m.path, m.ptn], ['checking', true, [], 'c3']);
  const b = R.abandonBody(run, cur, 4500, 1, null, Date.now());
  const u = b.puzzles.at(-1);
  assert.deepEqual([u.unfinished, u.mv[0].check, u.mv[0].paused, b.paused], [true, 'checking', 1500, 1500]);
  assert.ok(cleanRun(b, () => true), 'the server takes a run left during the check');
  // in Streak too
  const st = offLine({ mode: 'streak' });
  assert.ok(cleanRun(R.abandonBody(st.run, st.cur, 4000, 1), () => true));
  // 'checking' is only ever an open move with no answer and no game
  const one = (mv, extra = {}) => ({ mode: 'rush', size: 6, score: 0, moves: 0, errors: 0, bestCombo: 0, ms: 4000, paused: mv.paused ?? 0, abandoned: true,
    puzzles: [{ id: 'b', solved: false, unfinished: true, ms: 3000, mv: [mv], ...extra }] });
  const open = { ms: 800, weight: 1, correct: false, open: true, ptn: 'c3', check: 'checking', paused: 1500, path: [] };
  assert.ok(cleanRun(one(open), () => true));
  assert.equal(cleanRun(one({ ...open, checkMs: 900 }), () => true), null, 'a time for a check that never answered');
  assert.equal(cleanRun(one({ ...open, po: { proven: false, cap: 4, end: 'left', paused: 0, line: [] } }), () => true), null, 'a game before the check answered');
  assert.equal(cleanRun(one({ ...open, paused: 9000 }), () => true), null, 'past the quick check\'s bound');
  assert.equal(cleanRun({ ...one({ ...open, open: undefined }), abandoned: false, moves: 1, errors: 1, puzzles: [{ id: 'b', solved: false, ms: 3000, wrong: 'c3', mv: [{ ...open, open: undefined }] }] }, () => true), null, 'decided while checking');
});

await test('a quick answer of unknown (the worker failed) is posted as it came and taken, the move played out as pending', () => {
  const { run, cur, m } = offLine();
  R.checked(m, 'unknown', 40);
  assert.deepEqual([m.check, m.checkMs, R.route({ quick: 'unknown', def: 'syntaks' })], ['unknown', 40, 'playout']);
  R.finalAnswer(m, 'unknown', 41);
  m.po = { proven: false, cap: 8, end: 'held', paused: 2000, line: [{ m: 'a2', ms: 1500 }, { m: 'b1', ms: 700 }, { m: 'a3', ms: 400 }] };
  R.resume(run, 5100); m.paused = 2100;
  R.decide(cur, false); R.wrong(run, 6000); R.stampMove(cur, run, 6000, 3000);
  R.finish(run, { id: 'b', rating: 1000, solved: false, wrong: 'c3', ms: 3900, mv: cur.moves, sym: 2, clock: R.timeLeft(run, 6000), combo: 0 });
  R.end(run, 6000);
  const b = R.resultBody(run, 1);
  assert.deepEqual([b.puzzles[1].mv[0].check, b.puzzles[1].mv[0].final], ['unknown', 'unknown']);
  const c = cleanRun(b, () => true);
  assert.ok(c, 'taken');
  assert.deepEqual([c.rows[1].mv[0].check, c.rows[1].mv[0].final, c.rows[1].mv[0].finalMs], ['unknown', 'unknown', 41]);
});

await test('pauses are bounded by what the move went through: a quick no can\'t claim the final check\'s minute', () => {
  const has = () => true;
  const miss = (mv, ms = 250000) => ({ mode: 'rush', size: 6, score: 1, moves: 2, errors: 1, bestCombo: 1, ms, paused: mv.paused,
    puzzles: [{ id: 'a', solved: true, ms: 2000, mv: [{ ms: 900, weight: 1, correct: true }] }, { id: 'b', solved: false, wrong: 'c3', ms: mv.paused + 1000, mv: [mv] }] });
  const no = { ms: 400, weight: 1, correct: false, ptn: 'c3', check: 'no', checkMs: 300, path: [] };
  assert.equal(cleanRun(miss({ ...no, paused: 70000 }), has), null, 'a quick no, 70 s paused');
  assert.ok(cleanRun(miss({ ...no, paused: 2500 }, 182000), has), 'a quick no within the quick check');
  assert.equal(cleanRun(miss({ ...no, checkMs: 2400, paused: 0 }, 180500), has), null, 'a check longer than the pause');
  // the final answer decided a wait: its minute is allowed
  const waited = { ms: 400, weight: 1, correct: false, ptn: 'c3', check: 'pending', checkMs: 2500, final: 'no', finalMs: 50000, path: [] };
  assert.ok(cleanRun(miss({ ...waited, paused: 50000 }, 230000), has), 'a wait decided by the final answer');
  assert.equal(cleanRun(miss({ ...waited, final: undefined, finalMs: undefined, paused: 50000 }, 230000), has), null, 'a wait with no answer');
  assert.equal(cleanRun(miss({ ...waited, final: 'wins', paused: 50000 }, 230000), has), null, 'a miss the final answer proved');
  // a known alternative solved on the spot pauses for next to nothing
  const solve = (mv, ms) => ({ mode: 'rush', size: 6, score: 1, moves: 1, errors: 0, bestCombo: 1, ms, paused: mv.paused, puzzles: [{ id: 'a', solved: true, ms: mv.paused + 1000, mv: [mv] }] });
  const alt = { ms: 400, weight: 1, correct: true, ptn: 'c3', check: 'alt', path: [] };
  assert.ok(cleanRun(solve({ ...alt, paused: 100 }, 2000), has)); assert.equal(cleanRun(solve({ ...alt, paused: 20000 }, 30000), has), null);
  assert.equal(cleanRun(solve({ ...alt, check: 'wins', checkMs: 1000, paused: 60000 }, 70000), has), null, 'a quick proof solved on the spot');
  // the forged run: 40 quick misses each claiming 72.5 s, a 49-minute Rush
  const forged = { mode: 'rush', size: 6, score: 1, moves: 41, errors: 40, bestCombo: 1, ms: 2945000, paused: 2900000,
    puzzles: [{ id: 'p0', solved: true, ms: 1000, mv: [{ ms: 500, weight: 1, correct: true }] },
      ...Array.from({ length: 40 }, (_, i) => ({ id: 'p' + (i + 1), solved: false, wrong: 'a1', ms: 73000, mv: [{ ms: 400, weight: 1, correct: false, ptn: 'a1', check: 'no', checkMs: 10, paused: 72500, path: [] }] }))] };
  assert.equal(cleanRun(forged, has), null, 'the forged run');
  // the bounds, from the engines' own limits
  assert.equal(R.PAUSE_MS.reply, 4500 + 8000 + 24500 + 20e3 + 6000 + 5000);
  assert.equal(R.pauseMax({ check: 'no' }), 7500); assert.equal(R.pauseMax({ check: 'alt' }), 5000); assert.equal(R.pauseMax({ check: 'pending' }), 65000);
  assert.equal(R.pauseMax({ check: 'pending', po: { line: [1, 2, 3], end: 'held' } }), 7500 + 3 * R.PAUSE_MS.reply + 55000);
  assert.equal(R.pauseMax({ check: 'pending', po: { line: [1], end: 'noengine' } }), 65000 + 2 * R.PAUSE_MS.reply + 55000);
  assert.equal(R.pauseMax({ check: 'no' }, true), 7500 + 600000);
});

await test('a pause past its bound (a page frozen while the engine worked) is charged to the clock, and the run is still taken', () => {
  // a phone locked during the check for 30 minutes: the check's time and the pause are credited up to the bound
  const { run, cur, m } = offLine({ hidden: true });
  const wake = 3000 + 30 * 60e3;
  R.checked(m, 'no', wake - 3000, true);
  assert.equal(m.checkMs, R.PAUSE_MS.check + R.PAUSE_MS.hidden);
  const d = R.resume(run, wake, R.pauseMax(m, true) - (m.paused || 0));
  m.paused = d;
  assert.equal(d, R.pauseMax(m, true)); assert.equal(run.pausedMs, d);
  // the rest went on the clock, which ran out: the run ends where it did (rush.js: endRun, the move left open)
  assert.equal(R.expired(run, wake), true);
  assert.ok(run.endedAt < wake);
  R.closeOpen(run, cur);
  const b = R.resultBody(run, 1);
  assert.deepEqual([b.puzzles[1].unfinished, b.puzzles[1].mv[0].open, b.puzzles[1].mv[0].check], [true, true, 'no']);
  assert.ok(cleanRun(b, () => true), 'taken');
  // without the bound the post claims more than the server takes
  const r2 = offLine({ hidden: true });
  r2.m.check = 'no'; r2.m.checkMs = 2500;
  r2.m.paused = R.resume(r2.run, wake);
  R.closeOpen(r2.run, r2.cur); R.end(r2.run, wake);
  assert.equal(cleanRun(R.resultBody(r2.run, 1), () => true), null);
  // abandoned while frozen: the running pause is credited within the bound too
  const r3 = offLine({ hidden: true });
  const b3 = R.abandonBody(r3.run, r3.cur, wake, 1);
  assert.equal(b3.puzzles[1].mv[0].paused, R.pauseMax({ check: 'checking' }, true));
  assert.ok(cleanRun(b3, () => true), 'abandoned after a frozen check: taken');
});

await test('the turn line in a wait after no engine could answer says the check, as the screen reader hears it', () => {
  const po = playOutOf({ miss: 'a1', at: 0, base: [], g: R.startGame(P6, ['a1']), proven: false, left: 5, key: 'a1', engine: 'syntaks' });
  assert.equal(R.adjHead({ canon: 'a1', phase: 'check' }), 'Checking a1');
  assert.equal(R.adjHead({ canon: 'a1', phase: 'play', po }, 'Syntaks'), `Play it out. Move 2 of ${po.cap}`);
  po.end = 'noengine';
  assert.equal(R.adjHead({ canon: 'a1', phase: 'wait', po }, 'Tiltak'), R.cardHead('wait', { move: 'a1' }));
});

await test('the end screen\'s time played and per move leave out the engine\'s pauses; the post keeps real time', () => {
  const run = R.newRun('rush');
  R.startClock(run, 0);
  R.correct(run); R.correct(run);
  R.pause(run, 10e3); R.resume(run, 50e3);
  R.end(run, 220e3);
  const s = R.summary(run);
  assert.deepEqual([s.ms, s.clockMs, s.perMove], [220e3, 180e3, 90e3]);
  assert.equal(R.resultBody(run).ms, 220e3);
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  assert.match(src, /played = R\.timePlayed\(rec\)/); assert.equal(R.timePlayed(R.recordOf(run, [], 1)), 180e3); assert.doesNotMatch(src, /sec\(sum\.ms\)/);
});

await test('a play-out left mid-game is posted as left, with the running pause on the play-out as on the move', () => {
  const { run, cur, m } = offLine();
  R.checked(m, 'pending', 2500);
  // the play-out: the defender replied, the player moved, the defender is thinking again since 9000
  m.paused = 2600; R.resume(run, 5600);
  m.po = { proven: false, cap: 8, end: null, paused: 1500, line: [{ m: 'a2', ms: 1500 }, { m: 'b1', ms: 900 }] };
  R.pause(run, 9000);
  const b = R.abandonBody(run, cur, 11000, 1);
  const mv = b.puzzles[1].mv[0];
  assert.deepEqual([mv.po.end, mv.po.paused, mv.paused], ['left', 3500, 4600]);
  assert.equal(m.po.end, null, 'the run itself is untouched');
  assert.ok(cleanRun(b, () => true));
  // left while the check decides after a game no engine could play: open, the game's end kept
  const w = offLine();
  R.checked(w.m, 'pending', 2500); w.m.paused = 2600; R.resume(w.run, 5600);
  w.m.po = { proven: false, cap: 8, end: 'noengine', paused: 500, line: [] };
  R.pause(w.run, 6100);
  const bw = R.abandonBody(w.run, w.cur, 9000, 1);
  assert.deepEqual([bw.puzzles[1].mv[0].po.end, bw.puzzles[1].mv[0].po.paused, bw.puzzles[1].mv[0].paused], ['noengine', 500, 5500]);
  assert.ok(cleanRun(bw, () => true), 'taken');
});

await test('the check\'s final answer is kept on the move and posted; the server takes it only after an undecided quick one', () => {
  const m = { check: 'pending' };
  R.finalAnswer(m, 'wins', 12000.4); assert.deepEqual([m.final, m.finalMs], ['wins', 12000]);
  R.finalAnswer(m, 'late', 1); assert.equal(m.final, 'unknown');
  const one = (mv) => ({ mode: 'streak', size: 6, score: 1, moves: 1, errors: 0, bestCombo: 1, ms: 60000, paused: mv.paused, puzzles: [{ id: 'a', solved: true, ms: 60000, mv: [mv] }] });
  const solved = { ms: 400, weight: 1, correct: true, ptn: 'c3', check: 'pending', checkMs: 2500, final: 'wins', finalMs: 40000, paused: 40000, path: [] };
  assert.ok(cleanRun(one(solved), () => true));
  assert.equal(cleanRun(one({ ...solved, check: 'no', po: undefined }), () => true), null, 'a final answer after a quick no');
  assert.equal(cleanRun(one({ ...solved, final: 'maybe' }), () => true), null);
  assert.equal(cleanRun(one({ ...solved, finalMs: 70000, paused: 70000 }), () => true), null, 'past the final check\'s bound');
  assert.equal(cleanRun(one({ ...solved, final: undefined, finalMs: undefined }), () => true), null, 'a wait solved with no proof');
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  assert.match(src, /noteFinal\(c, a, v\);\n\s*settle\(s, c, R\.finalOutcome\(v\)\)/, 'a wait keeps the answer that decided it');
  assert.match(src, /a\.chk\.final\.then\(\(v\) => \{ if \(!adjLive\(s, c, a\)\) return; noteFinal\(c, a, v\);/, 'a play-out keeps the answer that came mid-game');
});

await test('the rules Rush shared with the puzzle page are the same functions, and the server bounds come from the engines\' own limits', async () => {
  const { ENGINE_MS, upgradeToProven, measureProof } = await import('../public/playon.js');
  const eng = fs.readFileSync(path.join(ROOT, 'public/engine.js'), 'utf8');
  const m = /export function checkStill\(pos, \{ quickMs = ([^,]+), maxMs = ([^,]+),/.exec(eng);
  assert.deepEqual([Number(m[1]), Number(m[2])], [ENGINE_MS.quick, ENGINE_MS.final], 'engine.js checkStill defaults');
  const def = fs.readFileSync(path.join(ROOT, 'public/defend.js'), 'utf8');
  for (const k of ['local', 'crux', 'download', 'tiltakUp', 'tiltak']) assert.ok(def.includes(`ENGINE_MS.${k}`), k);
  assert.doesNotMatch(def, /4500|8000|20e3|6000\b/, 'no literal limits left in defend.js');
  const srv = fs.readFileSync(path.join(ROOT, 'server/rush.js'), 'utf8');
  assert.doesNotMatch(srv, /2500 \+ SLACK|60e3 \+ SLACK|4500 \+ 8000/, 'the server reads the limits, not copies');
  // a proof mid-game: Syntaks plays on proven, Tiltak (or Syntaks dropped out) ends it as a solve
  const po = (engine, fallback = false) => ({ engine, fallback, proven: false });
  const a = po('syntaks'); assert.equal(upgradeToProven(a), true); assert.deepEqual([a.proven, a.provedLate], [true, true]);
  const b = po('tiltak'); assert.equal(upgradeToProven(b), false); assert.equal(b.proven, false);
  assert.equal(upgradeToProven(po('syntaks', true)), false);
  // measuring a proof's length: lengthP while it runs, cleared after
  const q = { lengthP: null }; let got;
  const lp = measureProof(q, () => Promise.resolve({ plies: 9 }), (r) => { got = r; });
  assert.equal(q.lengthP, lp); await lp; assert.deepEqual([q.lengthP, got], [null, { plies: 9 }]);
  const q2 = {}; await measureProof(q2, () => Promise.reject(new Error('x')), () => assert.fail()); assert.equal(q2.lengthP, null);
  // both pages call them
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), rush = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
  for (const f of ['upgradeToProven(po)', 'measureProof(po, () => engine.proofLength(', 'waitAtCap(po, why, ']) { assert.ok(app.includes(f), 'app.js ' + f); assert.ok(rush.includes(f), 'rush.js ' + f); }
  assert.doesNotMatch(rush, /provenPlayOut\(|visibleTimeout\(|po\.lengthP = /, 'no copies left in rush.js');
});

// ---------- server side, pure ----------
await test('planRun: climbs from the easy end to the hard end, no repeats, excludes honoured', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: 'x' + i, rating: 500 + i })).sort((a, b) => a.rating - b.rating);
  const plan = planRun(rows, 'rush', 0, RUN_LEN, ['x0', 'x1'], rnd);
  assert.equal(plan.length, RUN_LEN);
  assert.equal(new Set(plan.map((r) => r.id)).size, RUN_LEN);
  assert.ok(!plan.some((r) => r.id === 'x0' || r.id === 'x1'));
  assert.ok(plan[0].rating < 700, 'starts near the bottom: ' + plan[0].rating);
  assert.ok(plan[50].rating > 3200, 'reaches the top by 50: ' + plan[50].rating);
  const avg = (a) => a.reduce((t, r) => t + r.rating, 0) / a.length;
  for (let i = 0; i + 20 <= 50; i += 10) assert.ok(avg(plan.slice(i + 10, i + 20)) > avg(plan.slice(i, i + 10)), 'rising at ' + i);
  assert.ok(rampTarget('streak', 30, 0, 1000) < rampTarget('rush', 30, 0, 1000), 'streak climbs slower');
  assert.deepEqual(planRun([], 'rush', 0, 10, []), []);
  assert.equal(planRun(rows.slice(0, 5), 'rush', 0, 10, []).length, 5); // a tiny pool runs out instead of repeating
});

await test('weekOf: the Monday of a Pacific date', () => {
  assert.equal(weekOf('2026-11-18'), '2026-11-16'); // Wednesday
  assert.equal(weekOf('2026-11-16'), '2026-11-16'); // Monday
  assert.equal(weekOf('2026-11-22'), '2026-11-16'); // Sunday
});

await test('cleanRun: refuses anything malformed, inconsistent or oversized', () => {
  const ok = { mode: 'rush', size: '6', score: 1, moves: 2, errors: 1, bestCombo: 1, ms: 180000, build: 3,
    puzzles: [{ id: 'a', solved: true, ms: 1000, clock: 170000, combo: 1 }, { id: 'b', solved: false, ms: 900, wrong: 'c3', clock: 160000, combo: 0 }] };
  const has = (id) => id === 'a' || id === 'b' || id === 'c';
  const c = cleanRun(ok, has);
  assert.equal(c.size, 6); assert.equal(c.rows.length, 2); assert.equal(c.rows[1].wrong, 'c3');
  assert.equal(cleanRun({ ...ok, size: 6 }, has).size, 6);
  const bad = [null, [], 'x', { ...ok, mode: 'storm' }, { ...ok, size: 7 }, { ...ok, size: 5 }, { ...ok, size: 'any' }, { ...ok, size: undefined }, { ...ok, score: 2 }, { ...ok, score: -1 }, { ...ok, moves: 1.5 },
    { ...ok, bestCombo: 9 }, { ...ok, ms: 1e12 }, { ...ok, puzzles: 'x' }, { ...ok, puzzles: [...ok.puzzles, { id: 'zz', solved: false, ms: 1 }] },
    { ...ok, puzzles: [ok.puzzles[0], ok.puzzles[0]] }, { ...ok, puzzles: [{ ...ok.puzzles[0], ms: -1 }, ok.puzzles[1]] },
    { ...ok, puzzles: [ok.puzzles[0], { ...ok.puzzles[1], wrong: 'DROP TABLE' }] }, { ...ok, puzzles: [{ ...ok.puzzles[0], solved: 'yes' }, ok.puzzles[1]] },
    { ...ok, puzzles: [{ ...ok.puzzles[0], skipped: true }, ok.puzzles[1]] }, // a skip in rush
    { ...ok, puzzles: Array.from({ length: 401 }, (_, i) => ({ id: 'a' + i, solved: false, ms: 1 })) },
    { ...ok, mode: 'streak', score: 0, puzzles: [{ id: 'a', solved: false, ms: 1 }, { id: 'b', solved: false, ms: 1 }] }, // two misses
    { ...ok, mode: 'streak', score: 0, puzzles: [{ id: 'a', solved: false, skipped: true, ms: 1 }, { id: 'b', solved: false, skipped: true, ms: 1 }] }];
  for (const b of bad) assert.equal(cleanRun(b, has), null, JSON.stringify(b)?.slice(0, 120));
  assert.ok(cleanRun({ ...ok, mode: 'streak', score: 1, puzzles: [{ id: 'a', solved: false, skipped: true, ms: 1 }, { id: 'b', solved: true, ms: 300 }, { id: 'c', solved: false, ms: 300, wrong: 'a1' }] }, has));
});

await test('cleanRun: implausible runs are refused (forged scores, impossible times)', () => {
  const ok = { mode: 'rush', size: '6', score: 1, moves: 2, errors: 1, bestCombo: 1, ms: 180000, build: 3,
    puzzles: [{ id: 'a', solved: true, ms: 1000, clock: 170000, combo: 1 }, { id: 'b', solved: false, ms: 900, wrong: 'c3', clock: 160000, combo: 0 }] };
  const ids = Array.from({ length: 400 }, (_, i) => 'q' + i), has = () => true;
  const many = (k, ms) => ids.slice(0, k).map((id) => ({ id, solved: true, ms }));
  const bad = [
    { ...ok, mode: 'rush', score: 80, moves: 0, errors: 0, bestCombo: 0, ms: 0, puzzles: many(80, 0) }, // no moves, no time
    { ...ok, mode: 'rush', score: 80, moves: 0, errors: 0, bestCombo: 0, ms: 180000, puzzles: many(80, 1000) }, // no moves
    { ...ok, mode: 'rush', score: 400, moves: 400, errors: 0, bestCombo: 400, ms: 3600000, puzzles: many(400, 1000) }, // an hour of Rush
    { ...ok, moves: 2, errors: 0, puzzles: ok.puzzles }, // a miss with no wrong move
    { ...ok, bestCombo: 2 }, // a combo longer than the correct moves
    { ...ok, ms: 10, puzzles: [ok.puzzles[0], { ...ok.puzzles[1], ms: 3600000 }] }, // a puzzle longer than the run
    { ...ok, puzzles: [{ ...ok.puzzles[0], ms: 0 }, ok.puzzles[1]] }, // solved in no time (the board's lock is 250 ms)
    { ...ok, puzzles: [{ ...ok.puzzles[0], clock: 3600000 }, ok.puzzles[1]] }, // more clock than it could have had
  ];
  for (const b of bad) assert.equal(cleanRun(b, has), null, JSON.stringify(b).slice(0, 140));
  // A fast honest 3-minute Rush with its bonuses fits: 30 in a row earn 3 + 5 + 7 + 10 s.
  assert.ok(cleanRun({ ...ok, score: 30, moves: 30, errors: 0, bestCombo: 30, ms: 180000 + 25000, puzzles: many(30, 6000) }, has));
  assert.equal(maxBonus(30), 25000); assert.equal(maxBonus(4), 0); assert.equal(maxBonus(50), 45000);
});

await test('cleanRun: combo units (a stack move counts its squares) are bounded by the moves, and bound the bonus time', () => {
  // the bonus a run's combos could earn: every unit at the rate of the longest combo allowed (two 12s beat one 24)
  assert.equal(maxBonusFor(30, 30), 25000); assert.equal(maxBonusFor(10, 4), 0); assert.equal(maxBonusFor(100, 5), 60000);
  assert.ok(maxBonusFor(24, 24) >= 2 * maxBonus(12) && maxBonusFor(24, 24) <= 24000);
  assert.equal(maxBonusFor(90, 90), 85000);
  const ok = { mode: 'rush', size: '6', score: 1, moves: 2, errors: 1, bestCombo: 3, units: 3, ms: 180000, build: 3,
    puzzles: [{ id: 'a', solved: true, ms: 1000, clock: 170000, combo: 3 }, { id: 'b', solved: false, ms: 900, wrong: 'c3', clock: 160000, combo: 0 }] };
  const has = () => true;
  assert.ok(cleanRun(ok, has), 'one correct spread over three squares');
  for (const b of [{ ...ok, units: 6 }, { ...ok, units: 0 }, { ...ok, units: 'x' }, { ...ok, units: -1 }, { ...ok, bestCombo: 4 },
    { ...ok, units: undefined }, // without units a combo is moves, as before: 3 > 1
    { ...ok, puzzles: [{ ...ok.puzzles[0], combo: 4 }, ok.puzzles[1]] }]) // a puzzle's combo above the best
    assert.equal(cleanRun(b, has), null, JSON.stringify(b).slice(0, 120));
  // 30 correct moves, all spreads of three, one combo of 90: 3:00 plus at most 85 s of bonus
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 'q' + i, solved: true, ms: 6000 }));
  const fast = { mode: 'rush', size: '6', score: 30, moves: 30, errors: 0, bestCombo: 90, units: 90, ms: 180000 + 85000, build: 3, puzzles: many };
  assert.ok(cleanRun(fast, has));
  assert.equal(cleanRun({ ...fast, ms: 180000 + 85000 + 2001 }, has), null);
  assert.equal(cleanRun({ ...fast, units: 151 }, has), null); // more than 5 a move
  // a post without units keeps the old bound: 30 moves, one combo, 25 s
  assert.equal(cleanRun({ ...fast, bestCombo: 30, units: undefined, ms: 180000 + 25000 + 2001 }, has), null);
});

await test('cleanRun: only puzzles handed out to the run, in that order', () => {
  const b = { mode: 'rush', size: '6', score: 2, moves: 2, errors: 0, bestCombo: 2, ms: 60000, build: 3,
    puzzles: [{ id: 'a', solved: true, ms: 1000 }, { id: 'c', solved: true, ms: 1000 }] };
  const has = () => true;
  assert.ok(cleanRun(b, has, ['a', 'b', 'c']));
  assert.equal(cleanRun(b, has, ['a', 'b']), null); // c never handed out
  assert.equal(cleanRun(b, has, ['c', 'a']), null); // out of order
});

await test('cleanRun: a long streak is kept, its times capped, not refused', () => {
  const H = 3600e3;
  const s = { mode: 'streak', size: '6', score: 12, moves: 40, errors: 1, bestCombo: 39, ms: 2 * H, build: 1,
    puzzles: [...Array.from({ length: 12 }, (_, i) => ({ id: 'q' + i, solved: true, ms: i === 3 ? 61 * 60e3 : 60e3 })), { id: 'z', solved: false, ms: 5000, wrong: 'a1' }] };
  const c = cleanRun(s, () => true);
  assert.ok(c, 'a 2-hour streak with one puzzle open 61 minutes');
  assert.equal(c.ms, 2 * H);
  const d = cleanRun({ ...s, ms: 40 * 24 * H, puzzles: s.puzzles.map((p, i) => (i === 3 ? { ...p, ms: 30 * 24 * H } : p)) }, () => true);
  assert.ok(d, 'over a month');
  assert.equal(d.rows[3].ms, 24 * H); assert.equal(d.ms, 7 * 24 * H);
});

// ---------- the pool, on a database of its own ----------
await test('pool: 6×6 only; served puzzles first, every pickable one when too few are served; never a flawed puzzle; checked again on the way out', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE puzzles (id TEXT PRIMARY KEY, size INTEGER, tps TEXT, komi REAL, plies INTEGER, tree TEXT, rating REAL, swing TEXT, turn INTEGER, grade TEXT, kind TEXT, status TEXT, flaw INTEGER, meta TEXT); CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, gid TEXT UNIQUE)');
  const ins = db.prepare('INSERT INTO puzzles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)');
  // 6×6: 20 served, 200 reserve conversions (one flawed); minServed 10 -> the served ones only. 5×5 ones are never used.
  for (let i = 0; i < 20; i++) ins.run('s6_' + i, 6, P6.tps, 2, 7, JSON.stringify(P6.tree), 1000 + i * 50, null, 1, null, null, 'served', null);
  for (let i = 0; i < 200; i++) ins.run('r6_' + i, 6, P6.tps, 2, 7, JSON.stringify(P6.tree), 1000 + i * 5, null, 0, null, null, 'reserve', i === 0 ? 2 : null);
  for (let i = 0; i < 5; i++) ins.run('s5_' + i, 5, P5.tps, 0, 1, '"win"', 700 + i, null, 1, null, null, 'served', null);
  for (let i = 0; i < 30; i++) ins.run('r5_' + i, 5, P5.tps, 0, 1, '"win"', 700 + i, null, 0, null, null, 'reserve', i === 0 ? 1 : null);
  ins.run('alt6', 6, P6.tps, 2, 7, JSON.stringify(P6.tree), 1100, JSON.stringify({ alts: ['a1'] }), 1, null, null, 'served', 1);
  let t = 0;
  const rush = createRush(db, { now: () => t, minServed: 10 });
  const get = async (q) => { let out; await rush.handle(null, null, new URL('http://x/api/rush/run?' + q), 'GET /api/rush/run',
    { user: null, json: (_, s, o) => { out = { s, o }; }, refuse: () => false, ip: '1' }); return out; };
  // one with its game on record: its intro goes out (before, last), and nothing else of the game
  db.prepare('UPDATE puzzles SET tps = ?, meta = ? WHERE id = ?').run(histGame(5), JSON.stringify({ history: HIST, white: 'w' }), 's6_0');
  let r = (await get('mode=rush&size=6')).o.puzzles;
  assert.equal(r.length, 21); assert.ok(r.every((p) => p.id.startsWith('s6_') || p.id === 'alt6'), 'served only (alt6 is served and lists other wins)');
  const s0 = r.find((p) => p.id === 's6_0');
  assert.equal(s0.before, histGame(4)); assert.equal(s0.last, 'c4'); assert.equal(s0.meta, undefined); assert.equal(s0.history, undefined);
  assert.ok(r.filter((p) => p.id !== 's6_0').every((p) => !('before' in p) && !('last' in p)));
  for (const q of ['mode=rush&size=5', 'mode=rush&size=any', 'mode=streak&size=5', 'mode=rush']) assert.equal((await get(q)).s, 400, q);
  // listing other wins (flaw 1) is no bar now: alt6 goes out with its alternatives, as the puzzle endpoint sends them
  const a6 = (await get('mode=rush&size=6&exclude=' + Array.from({ length: 20 }, (_, i) => 's6_' + i).join(','))).o.puzzles;
  assert.deepEqual(a6.map((p) => [p.id, p.alts]), [['alt6', ['a1']]]);
  // too few served (minServed 30): every pickable 6×6 one, still never a refunded one (r6_0, flaw 2) nor a 5×5 one
  const all = createRush(db, { now: () => t, minServed: 30 });
  let out;
  await all.handle(null, null, new URL('http://x/api/rush/run?mode=rush&size=6&exclude=' + Array.from({ length: 20 }, (_, i) => 's6_' + i).join(',')), 'GET /api/rush/run',
    { user: null, json: (_, st, o) => { out = o; }, refuse: () => false, ip: '1' });
  assert.equal(out.puzzles.length, RUN_LEN); assert.ok(out.puzzles.every((p) => (p.id.startsWith('r6_') || p.id === 'alt6') && p.id !== 'r6_0' && p.size === 6));
  // paused after the pool was built: not handed out, though the pool is still the old one
  db.prepare("UPDATE puzzles SET status = 'paused' WHERE id = 's6_3'").run();
  db.prepare("UPDATE puzzles SET grade = 'D' WHERE id = 's6_4'").run();
  r = (await get('mode=rush&size=6')).o.puzzles;
  assert.equal(r.length, 19); assert.ok(!r.some((p) => p.id === 's6_3' || p.id === 's6_4'));
  assert.equal((await get('mode=rush&size=6&run=forged.aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb')).s, 400);
  // GET /api/rush/<anything else> isn't Rush's
  for (const route of ['GET /api/rush/foo', 'GET /api/rush/result', 'GET /api/rush/', 'POST /api/rush/run'])
    assert.equal(await rush.handle(null, null, new URL('http://x/' + route.split(' ')[1]), route, {}), false, route);
  db.close();
});

await test('a run token lives 30 days: paged and posted after 29, refused after 31', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE puzzles (id TEXT PRIMARY KEY, size INTEGER, tps TEXT, komi REAL, plies INTEGER, tree TEXT, rating REAL, swing TEXT, turn INTEGER, grade TEXT, kind TEXT, status TEXT, flaw INTEGER, meta TEXT); CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, rating REAL, gid TEXT)');
  const ins = db.prepare("INSERT INTO puzzles VALUES (?,6,?,2,7,?,?,NULL,1,NULL,NULL,'served',NULL,NULL)");
  for (let i = 0; i < 200; i++) ins.run('q' + i, P6.tps, JSON.stringify(P6.tree), 1000 + i * 10);
  let t = 1e12;
  const rush = createRush(db, { now: () => t, minServed: 10 });
  const call = async (route, q, body) => { let out; await rush.handle(null, null, new URL('http://x/api/rush/' + route.split('/').pop() + '?' + q), route,
    { user: null, body: async () => body, json: (_, st, o) => { out = { st, o }; }, refuse: () => false, ip: '1' }); return out; };
  const issue = async () => { const r = (await call('GET /api/rush/run', 'mode=rush&size=6')).o; return { ...r, pages: [{ start: r.start, ids: r.puzzles.map((p) => p.id), sig: r.sig }] }; };
  const post = (iss) => call('POST /api/rush/result', '', { mode: 'rush', size: 6, score: 1, moves: 1, errors: 0, bestCombo: 1, ms: 60000, build: 1, run: iss.run, pages: iss.pages,
    puzzles: [{ id: iss.puzzles[0].id, solved: true, ms: 1000 }], guest: { gid: 'd'.repeat(32) } });
  const DAY = 864e5, t0 = t;
  const a = await issue(), b = await issue();
  t = t0 + 29 * DAY;
  assert.equal((await call('GET /api/rush/run', `mode=rush&size=6&run=${encodeURIComponent(a.run)}&start=80`)).st, 200, 'paged at 29 days');
  assert.equal((await post(a)).st, 200, 'posted at 29 days');
  t = t0 + 31 * DAY;
  assert.equal((await call('GET /api/rush/run', `mode=rush&size=6&run=${encodeURIComponent(b.run)}&start=80`)).st, 400, 'paged at 31 days');
  assert.equal((await post(b)).st, 400, 'posted at 31 days');
  assert.equal(RUN_TTL, 30 * DAY);
  await new Promise((r) => setTimeout(r, 20)); // the pool's rebuild (the clock moved past 10 minutes) runs first
  db.close();
});

await test('played time: minted_at, played_at clamped between it and the post, late after 10 minutes; units stored', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE puzzles (id TEXT PRIMARY KEY, size INTEGER, tps TEXT, komi REAL, plies INTEGER, tree TEXT, rating REAL, swing TEXT, turn INTEGER, grade TEXT, kind TEXT, status TEXT, flaw INTEGER, meta TEXT); CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, rating REAL, gid TEXT)');
  const ins = db.prepare("INSERT INTO puzzles VALUES (?,6,?,2,7,?,?,NULL,1,NULL,NULL,'served',NULL,NULL)");
  for (let i = 0; i < 100; i++) ins.run('q' + i, P6.tps, JSON.stringify(P6.tree), 1000 + i * 10);
  let t = 1e12;
  const rush = createRush(db, { now: () => t, minServed: 10 });
  const call = async (route, q, body) => { let out; await rush.handle(null, null, new URL('http://x/api/rush/' + route.split('/').pop() + '?' + q), route,
    { user: null, body: async () => body, json: (_, st, o) => { out = { st, o }; }, refuse: () => false, ip: '1' }); return out; };
  const issue = async () => { const r = (await call('GET /api/rush/run', 'mode=rush&size=6')).o; return { ...r, pages: [{ start: r.start, ids: r.puzzles.map((p) => p.id), sig: r.sig }] }; };
  const post = (iss, x) => call('POST /api/rush/result', '', { mode: 'rush', size: 6, score: 1, moves: 1, errors: 0, bestCombo: 3, units: 3, ms: 60000, build: 1, run: iss.run, pages: iss.pages,
    puzzles: [{ id: iss.puzzles[0].id, solved: true, ms: 1000, mv: [{ ms: 900, weight: 3, correct: true }] }], guest: { gid: 'd'.repeat(32) }, ...x });
  const row = (r) => db.prepare('SELECT ts, minted_at, played_at, late, units FROM rush_runs WHERE id = ?').get(r.o.id);
  const H = 3600e3, t0 = t, runs = [await issue(), await issue(), await issue(), await issue(), await issue()];
  t = t0 + 24 * H; // posted a day later (a spare played an hour after it was fetched, sent from the queue)
  let r = await post(runs[0], { playedAt: t0 + H });
  assert.equal(r.st, 200, JSON.stringify(r.o));
  assert.deepEqual({ ...row(r) }, { ts: t, minted_at: t0, played_at: t0 + H, late: 1, units: 3 });
  r = await post(runs[1], { playedAt: t - 60e3 }); assert.equal(row(r).late, 0);
  r = await post(runs[2], { playedAt: t0 - 5 * H }); assert.equal(row(r).played_at, t0, 'clamped to the mint');
  r = await post(runs[3], { playedAt: t + 5 * H }); assert.deepEqual([row(r).played_at, row(r).late], [t, 0], 'clamped to the post');
  assert.equal((await post(runs[4], { playedAt: 'yesterday' })).st, 400);
  r = await post(runs[4], { playedAt: undefined, units: undefined, bestCombo: 1, puzzles: [{ id: runs[4].puzzles[0].id, solved: true, ms: 1000 }] }); // an old shape
  assert.equal(r.st, 200, JSON.stringify(r.o));
  assert.deepEqual({ ...row(r), ts: 0 }, { ts: 0, minted_at: t0, played_at: null, late: null, units: null });
  await new Promise((res) => setTimeout(res, 20)); // (the pool's rebuild, the clock having moved)
  db.close();
});

await test('top lists: named accounts, token guests and tokenless visitors; one row each; never an abandoned run; "you"', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE puzzles (id TEXT PRIMARY KEY, size INTEGER, tps TEXT, komi REAL, plies INTEGER, tree TEXT, rating REAL, swing TEXT, turn INTEGER, grade TEXT, kind TEXT, status TEXT, flaw INTEGER, meta TEXT); CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE, rating REAL, gid TEXT UNIQUE)');
  const ins = db.prepare("INSERT INTO puzzles VALUES (?,6,?,2,7,?,?,NULL,1,NULL,NULL,'served',NULL,NULL)");
  for (let i = 0; i < 100; i++) ins.run('q' + i, P6.tps, JSON.stringify(P6.tree), 1000 + i * 10);
  db.exec("INSERT INTO users (id, name, rating, gid) VALUES (1, 'ann', 1500, NULL), (2, NULL, 1500, NULL), (3, 'cat', 1500, NULL)");
  let t = 1e12;
  const rush = createRush(db, { now: () => t, minServed: 10 });
  const G = 'a'.repeat(32), H = 'b'.repeat(32);
  const call = async (route, q, body, user = null) => { let out; await rush.handle(null, null, new URL('http://x/api/rush/' + route.split('/').pop() + '?' + q), route,
    { user, body: async () => body, json: (_, st, o) => { out = { st, o }; }, refuse: () => false, ip: '1' }); return out; };
  const play = async (score, user, gid, extra = {}) => {
    const r = (await call('GET /api/rush/run', 'mode=rush&size=6', null, user)).o;
    const puzzles = r.puzzles.slice(0, score).map((p) => ({ id: p.id, solved: true, ms: 1000 }));
    t += 1000;
    return call('POST /api/rush/result', '', { mode: 'rush', size: 6, score, moves: score, errors: 0, bestCombo: score, ms: 60000, build: 1, run: r.run,
      pages: [{ start: r.start, ids: r.puzzles.map((p) => p.id), sig: r.sig }], puzzles, ...(gid ? { guest: { gid } } : {}), ...extra }, user);
  };
  assert.equal((await play(3, { id: 1 })).st, 200); // ann, named
  await play(5, { id: 2 }); // a guest with a token
  await play(4, null, G); // a tokenless visitor
  await play(9, null, H, { abandoned: true }); // abandoned: stored, never listed
  await play(2, { id: 3 });
  await play(1, { id: 3 }); // under cat's best
  const list = async (user, gid) => (await call(gid ? 'POST /api/rush/top' : 'GET /api/rush/top', 'mode=rush&size=6', gid ? { guest: { gid } } : null, user)).o.top;
  let top = await list(null);
  const g2 = guestLabel(db.prepare('SELECT k FROM rush_key').get().k, 'u2'), gG = guestLabel(db.prepare('SELECT k FROM rush_key').get().k, 'g' + G);
  assert.deepEqual(top.map((r) => [r.name, r.score, r.named, !!r.you]), [[g2, 5, false, false], [gG, 4, false, false], ['ann', 3, true, false], ['cat', 2, true, false]]);
  // the label: stable, four digits, nothing of the id or gid in it or anywhere in the answer
  assert.match(g2, /^Guest \d{4}$/); assert.equal(guestLabel('k', 'gx'), guestLabel('k', 'gx')); assert.notEqual(guestLabel('k', 'gx'), guestLabel('k2', 'gx'));
  assert.ok(!JSON.stringify(top).includes(G) && !JSON.stringify(top).includes(H) && !JSON.stringify(top).includes('"key"'));
  // you: a named account, a token guest, a tokenless visitor (gid in the POST body)
  assert.deepEqual((await list({ id: 1 })).filter((r) => r.you).map((r) => r.name), ['ann']);
  assert.deepEqual((await list({ id: 2 })).filter((r) => r.you).map((r) => r.name), [g2]);
  assert.deepEqual((await list(null, G)).filter((r) => r.you).map((r) => r.name), [gG]);
  assert.deepEqual((await list(null, H)).filter((r) => r.you), []);
  // the tokenless visitor claims a name (users.gid): their runs count for the account, listed once, by name
  db.prepare("INSERT INTO users (id, name, rating, gid) VALUES (4, 'dee', 1500, ?)").run(G);
  t += 61e3; // (past the minute's cache)
  await play(2, { id: 4 });
  top = await list(null);
  assert.deepEqual(top.map((r) => [r.name, r.score]), [[g2, 5], ['dee', 4], ['ann', 3], ['cat', 2]]);
  assert.deepEqual((await list(null, G)).filter((r) => r.you).map((r) => r.name), ['dee']);
  // a guest's new best clears the cache at once
  await play(7, null, H);
  assert.deepEqual((await list(null)).map((r) => r.score), [7, 5, 4, 3, 2]);
  // the list walks the index from the top score
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT player, score, ts FROM rush_lead WHERE mode = 'rush' AND size = 6 AND score > 0 ORDER BY score DESC, ts ASC LIMIT 60").all().map((r) => r.detail).join('; ');
  assert.match(plan, /USING (COVERING )?INDEX rush_lead_top \(mode=\? AND size=\? AND score>\?\)/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, 'no sort');
  await new Promise((res) => setTimeout(res, 20));
  db.close();
});

await test('top lists: an older database is filled from its runs once (best per player, abandoned runs left out)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE puzzles (id TEXT PRIMARY KEY, size INTEGER, tps TEXT, komi REAL, plies INTEGER, tree TEXT, rating REAL, swing TEXT, turn INTEGER, grade TEXT, kind TEXT, status TEXT, flaw INTEGER, meta TEXT); CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, rating REAL, gid TEXT UNIQUE)');
  createRush(db);
  db.exec('DROP TABLE rush_lead');
  const run = db.prepare("INSERT INTO rush_runs (user_id, gid, mode, size, score, moves, errors, best_combo, ms, day, week, ts, abandoned) VALUES (?,?,'rush',6,?,0,0,0,0,'d','w',?,?)");
  run.run(1, null, 3, 10, 0); run.run(1, null, 5, 20, 0); run.run(1, null, 5, 30, 0); run.run(null, 'a'.repeat(32), 4, 5, 0); run.run(null, 'b'.repeat(32), 9, 5, 1);
  createRush(db);
  assert.deepEqual(db.prepare('SELECT player, score, ts FROM rush_lead ORDER BY score DESC').all().map((r) => [r.player, r.score, r.ts]), [['u1', 5, 20], ['g' + 'a'.repeat(32), 4, 5]]);
  db.close();
});

await test('best scores: two indexed lookups, not a scan of every run', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE puzzles (id TEXT PRIMARY KEY, size INTEGER, tps TEXT, komi REAL, plies INTEGER, tree TEXT, rating REAL, swing TEXT, turn INTEGER, grade TEXT, kind TEXT, status TEXT, flaw INTEGER, meta TEXT); CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, gid TEXT UNIQUE)');
  createRush(db);
  const plan = (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join('; ');
  const args = (sql) => sql.replace(/\?/g, () => "''");
  assert.match(plan(args(BEST_SQL.user)), /USING (COVERING )?INDEX rush_runs_user \(user_id=\? AND mode=\? AND size=\?/);
  assert.match(plan(args(BEST_SQL.gid)), /USING (COVERING )?INDEX rush_runs_gid \(gid=\? AND mode=\? AND size=\?/);
  db.close();
});

// ---------- combo credit (2026-11-19; Sasha: "play out should get the intended solution combo (minus however many moves
// have already been made)"): a solved move off the line earns what the puzzle's own line had left from there ----------
const sample = (id) => SAMPLE.find((p) => p.id === id);
// The principal line (View solution's: first-listed move, then the finisher at a 'win' node) and its positions.
const mainPaths = (p) => {
  const out = [[]], line = [];
  for (let node = p.tree; node && node !== 'win';) { const mv = Object.keys(node)[0], e = node[mv]; line.push(mv, e.r); out.push([...line]); node = e.n; }
  return out;
};
// A Rush run as rush.js plays one: `depth` of the line's moves played, then a move off it whose play-out is won (or, with
// alt, solved with no game), settled as settle() does: the credit from R.lineCredit, R.correct by it. live: as the
// client live at 09317a1 settled it (no credit, the move's own weight).
const creditRun = (P, s, depth, { live = false, id = P.id, alt = false } = {}) => {
  const q = SYM.orient(P, s), run = R.newRun('rush'), cur = { p: q, born: 0, line: [], moves: [] };
  R.startClock(run, 0);
  let t = 100;
  for (let i = 0; i < depth; i++) {
    R.openMove(cur, t);
    const v = R.judge(q, cur.line, Object.keys(R.nodeAt(q, cur.line))[0]);
    assert.equal(v.kind, 'ok');
    R.closeMove(cur, t + 500, R.weight(v.canon), true, v.canon); R.correct(run, R.weight(v.canon)); R.stampMove(cur, run, t + 500);
    cur.line.push(v.canon, v.reply); t += 1000;
  }
  R.openMove(cur, t);
  const g = R.startGame(q, cur.line), off = g.legalMoves().map((m) => g.moveToPTN(m)).find((m) => R.judge(q, cur.line, m).kind === 'off');
  const m = R.openAdj(cur, t + 500, R.weight(off), off, alt);
  R.pause(run, t + 500);
  if (!alt) {
    R.checked(m, 'pending', 2000);
    m.po = { proven: false, cap: 8, end: 'win', paused: 2400, line: [{ m: SYM.move(s, 6, 'a2'), ms: 1500 }, { m: SYM.move(s, 6, 'b1'), ms: 700 }, { m: SYM.move(s, 6, 'a3'), ms: 800 }] };
  }
  m.paused = R.resume(run, t + (alt ? 600 : 5000));
  R.decide(cur, true);
  const credit = live ? null : R.lineCredit(q, m.path);
  if (credit != null) m.credit = credit;
  const bonus = R.correct(run, credit ?? m.weight);
  const now = t + 5000;
  R.stampMove(cur, run, now, t + 500);
  R.finish(run, { id, rating: 1000, solved: true, ms: now, mv: cur.moves, sym: s, clock: R.timeLeft(run, now), combo: run.combo });
  R.end(run, now + 100);
  return { run, body: R.resultBody(run, 1), credit, bonus, off, m };
};

await test('combo credit: a solved move off the line earns the line\'s remainder from where it left it, spreads by their drops', () => {
  const P6s = { ...P6, plies: 7 }, spread = sample('pd508613'), mixed = sample('pd417770');
  // P6: b5+ f5+ e2< then a finisher (e6), one each; off the line at move 1, 2, 3 and at the finisher
  assert.deepEqual(mainPaths(P6s).map((path) => R.lineCredit(P6s, path)), [4, 3, 2, 1]);
  // 5b2>311 (3) 3e2<12 (2) e1 4c2+1111 (4) c3- 4c6-112 (3) f2, then 3c3<: 16 at the start, then less what was played
  assert.deepEqual(mainPaths(spread).map((path) => R.lineCredit(spread, path)), [16, 13, 11, 10, 6, 5, 2, 1]);
  assert.deepEqual(mainPaths(mixed).map((path) => R.lineCredit(mixed, path)), [8, 6, 3, 2, 1]);
  // a 'win' tree (the root wins on the spot): the finisher's weight
  assert.equal(R.lineCredit({ ...P5, size: 5 }, []), 1);
  // a path off the tree, or between moves, can't be followed: null (the move then counts its own weight)
  assert.equal(R.lineCredit(P6s, ['a1', 'a2']), null); assert.equal(R.lineCredit(P6s, ['b5+']), null); assert.equal(R.lineCredit(null, []), null);
  // played through: the line's moves earned as made, the off-line solve the rest; together the line's whole combo
  for (const [P, whole] of [[P6s, 4], [spread, 16], [mixed, 8]]) for (let d = 0; d < mainPaths(P).length; d++) {
    const { run, credit } = creditRun(P, 0, d);
    assert.equal(run.combo, whole, `${P.id} at ${d}`); assert.equal(run.units, whole); assert.equal(run.moves, d + 1, 'one correct move for the solve');
    assert.equal(credit, R.lineCredit(P, mainPaths(P)[d]));
  }
  // the move's own weight is kept as the fact; credit beside it, on that move only
  const { body, off } = creditRun(spread, 0, 3);
  const mv = body.puzzles[0].mv;
  assert.deepEqual(mv.map((m) => [m.weight, m.credit]), [[3, undefined], [2, undefined], [1, undefined], [R.weight(SYM.move(0, 6, off)), 10]]);
  assert.equal(body.units, 3 + 2 + 1 + 10); assert.equal(body.puzzles[0].combo, 16);
});

await test('combo credit: the same under all 8 symmetries, at every point of the line (rush-sym-sample.json)', () => {
  for (const P of SAMPLE) for (const path of mainPaths(P)) {
    const want = R.lineCredit(P, path);
    assert.ok(Number.isInteger(want) && want >= 1, P.id);
    for (const s of SYM.SYMS) assert.equal(R.lineCredit(SYM.orient(P, s), path.map((m) => SYM.move(s, 6, m))), want, `${P.id} ${s} at ${path.length}`);
  }
  // and as rush.js settles it: the credit posted under any symmetry is the server's (the path turned back)
  for (const s of SYM.SYMS) {
    const P = sample('pd503388'), { body, credit } = creditRun(P, s, 3);
    assert.equal(credit, 4, `finisher 6e5-1122 under ${s}`);
    assert.ok(cleanRun(body, () => true, null, () => P), `taken under ${s}`);
  }
});

await test('combo credit: settle() credits the line\'s remainder; bonus thresholds a credit crosses pay', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8'), settle = src.slice(src.indexOf('function settle('), src.indexOf('function stopAdj('));
  assert.match(settle, /const credit = R\.lineCredit\(c\.p, a\.m\.path\);/);
  assert.match(settle, /if \(credit != null\) a\.m\.credit = credit;/);
  assert.match(settle, /R\.correct\(s\.run, credit \?\? a\.m\.weight\)/);
  // 0 -> 16 on one solve: past 5 and 12, both pay (+3 s, +5 s); still one move
  const { run, bonus } = creditRun(sample('pd508613'), 5, 0);
  assert.deepEqual([bonus, run.bonusMs, run.combo, run.bestCombo, run.units, run.moves], [8000, 8000, 16, 16, 16, 1]);
  // and the clock bound holds: the server takes it (its clock with the bonus within 3:00 plus maxBonusFor(units, best))
  assert.ok(R.timeLeft(run, run.endedAt) > R.RUSH_MS);
  assert.ok(cleanRun(R.resultBody(run, 1), () => true, null, () => sample('pd508613')));
  // a proof with no game (a listed alternative) is credited the same
  const a = creditRun(sample('pd508613'), 2, 1, { alt: true });
  assert.equal(a.credit, 13); assert.equal(a.m.check, 'alt');
  assert.ok(cleanRun(a.body, () => true, null, () => sample('pd508613')));
});

await test('cleanRun: a credit is taken only as the line\'s remainder at its path; old posts and the 09317a1 client\'s as before', () => {
  const P = sample('pd508613'), of = () => P, has = () => true;
  const { body } = creditRun(P, 3, 2);
  const last = (b) => b.puzzles[0].mv.at(-1);
  assert.equal(last(body).credit, 11);
  const c = cleanRun(body, has, null, of);
  assert.ok(c); assert.equal(c.rows[0].mv.at(-1).credit, 11); assert.equal(c.rows[0].mv[0].credit, undefined);
  const edit = (f, run = {}) => { const b = structuredClone(body); f(last(b), b); return { ...b, ...run }; };
  const bad = {
    'too high': edit((m) => { m.credit = 12; }, { units: body.units + 1, bestCombo: body.bestCombo + 1 }),
    'too low': edit((m) => { m.credit = 10; }, { units: body.units - 1 }),
    'on a move judged by the line': edit((m, b) => { b.puzzles[0].mv[0].credit = 1; }),
    'with no path': edit((m) => { delete m.path; }),
    'not a number': edit((m) => { m.credit = '11'; }),
    'zero': edit((m) => { m.credit = 0; }),
    'more units than posted': edit(() => {}, { units: body.units - 1 }),
    'no stored puzzle to check it by': body,
  };
  for (const [k, b] of Object.entries(bad)) assert.equal(cleanRun(b, has, null, k === 'no stored puzzle to check it by' ? null : of), null, k);
  // a credit on a miss
  const miss = structuredClone(body);
  Object.assign(miss, { score: 0, errors: 1, units: body.units - 11, bestCombo: body.units - 11 });
  Object.assign(miss.puzzles[0], { solved: false, wrong: last(body).ptn, combo: 0, clock: 160000 }); Object.assign(last(miss), { correct: false, po: { ...last(body).po, end: 'held' } });
  for (const m of miss.puzzles[0].mv) m.clock = 170000; // (without the credit's bonus)
  assert.equal(cleanRun(miss, has, null, of), null, 'a credit on a miss');
  delete last(miss).credit; assert.ok(cleanRun(miss, has, null, of), '(the same miss without it is taken)');
  // the client live at 09317a1: a won play-out with no credit, units grown by the move's own weight
  const live = creditRun(P, 3, 2, { live: true });
  assert.equal(last(live.body).credit, undefined); assert.equal(live.body.units, 3 + 2 + R.weight(last(live.body).ptn));
  assert.ok(cleanRun(live.body, has, null, of), 'the live client\'s post'); assert.ok(cleanRun(live.body, has), '(with no puzzle lookup too)');
  // an old post (2026-11-18's: units, no adjudication fields at all) as before
  const old = { ...live.body, paused: undefined, puzzles: live.body.puzzles.map(({ sym, mv, ...p }) => ({ ...p, mv: mv.map(({ ms, weight, correct }) => ({ ms, weight, correct })) })) };
  assert.ok(cleanRun(old, has, null, of), 'old shape');
  // a credit past MAX_DROPS per move: 16 on one move is fine where the line had it
  assert.ok(cleanRun(creditRun(P, 0, 0).body, has, null, of));
  // a path the stored tree no longer has (the puzzle re-solved since): bounded by the solver's moves left at MAX_DROPS
  const gone = { ...P, tree: { a1: { r: 'a2', n: 'win' } } }, far = edit((m) => { m.credit = 11; });
  assert.ok(cleanRun(far, has, null, () => gone), 'within (15 - 4) / 2 moves at 5');
  assert.equal(cleanRun(edit((m) => { m.credit = 31; }, { units: body.units + 20, bestCombo: body.bestCombo + 20 }), has, null, () => gone), null, 'past it');
});

await test('cleanRun: a credit\'s path must be the moves posted before it; a tree re-ordered since it was handed out doesn\'t lose the run', () => {
  const P = sample('pd508613'), of = () => P, has = () => true;
  const { body } = creditRun(P, 0, 3); // 3 line moves (3, 2, 1), then a won play-out: credit 10, units 16
  const last = (b) => b.puzzles[0].mv.at(-1);
  assert.ok(cleanRun(body, has, null, of));
  const forge = (f, more) => { const b = structuredClone(body); f(last(b), b); b.units += more; b.bestCombo += more; b.puzzles[0].combo += more; return b; };
  const whole = R.lineCredit(P, []), deep = Math.ceil((P.plies - 2) / 2) * R.MAX_DROPS;
  const bad = {
    // rewound to the start: the 3 line moves already counted would be counted again
    'rewound path': forge((m) => { m.path = []; m.credit = whole; }, whole - 10),
    // made up, or odd: the loose bound for a re-solved puzzle must not be reachable by them
    'path off the tree, not the moves before': forge((m) => { m.path = ['a1', 'a2']; m.credit = deep; }, deep - 10),
    'odd path': forge((m) => { m.path = m.path.slice(0, 1); m.credit = deep; }, deep - 10),
    'path a line move short': forge((m) => { m.path = m.path.slice(0, 4); m.credit = R.lineCredit(P, m.path); }, 1),
    'path not the moves posted': forge((m, b) => { b.puzzles[0].mv[1].ptn = 'a1'; }, 0),
  };
  for (const [k, b] of Object.entries(bad)) assert.equal(cleanRun(b, has, null, of), null, k);
  // pd503388's root lists 2c5- (line credit 7) then 3c5- (6): the client credits 7; the stored tree, re-ordered before the
  // post arrives, now says 6. Still taken, as posted (the run counted 7), and not past the most a line there earns.
  const Q = sample('pd503388'), q = creditRun(Q, 5, 0);
  assert.equal(q.credit, 7);
  const swapped = { ...Q, tree: Object.fromEntries(Object.entries(Q.tree).reverse()) };
  assert.equal(R.lineCredit(swapped, []), 6); assert.equal(lineMost(swapped, []), 7);
  const c = cleanRun(q.body, has, null, () => swapped);
  assert.ok(c, 'taken against the re-ordered tree'); assert.equal(c.rows[0].mv.at(-1).credit, 7);
  const over = structuredClone(q.body); last(over).credit = 8; over.units += 1; over.bestCombo += 1; over.puzzles[0].combo += 1;
  assert.equal(cleanRun(over, has, null, () => swapped), null, 'past the most any line there earns');
  // lineMost: the first-listed line where the tree doesn't branch on the solver's moves
  for (const p of SAMPLE) if (Object.keys(p.tree).length === 1) assert.ok(lineMost(p, []) >= R.lineCredit(p, []), p.id);
  assert.equal(lineMost(P, []), 16); assert.equal(lineMost(P, ['5b2>311']), null);
});

// ---------- endpoints ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-rush-'));
const DB = path.join(dir, 't.db'), { base, boot, stop } = testServer(dir);
const call = async (p, body, headers = {}) => {
  const r = await fetch(base + p, body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

await stop(await boot(DB)); // schema
{
  const db = new DatabaseSync(DB);
  const ins = db.prepare('INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, komi, turn, grade, swing, flaw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 120; i++) ins.run('p6_' + i, 6, P6.tps, 7, JSON.stringify(P6.tree), 'test', 800 + i * 20, 800 + i * 20, 2, 1, null, i === 0 ? JSON.stringify({ alts: ['a1'], altsAt: { 'b5+ Sc6': ['a2'] } }) : null, i === 0 ? 1 : null); // import.mjs sets flaw = 1 with alts
  for (let i = 0; i < 60; i++) ins.run('p5_' + i, 5, P5.tps, 1, '"win"', 'test', 600 + i * 30, 600 + i * 30, 0, 0, i === 1 ? 'D' : null, null, i === 2 ? 2 : null);
  db.close();
}
const server = await boot(DB);
try {
  const db = new DatabaseSync(DB, { readOnly: true });
  const snap = () => JSON.stringify([db.prepare('SELECT * FROM users ORDER BY id').all(), db.prepare('SELECT * FROM puzzles ORDER BY id').all(), db.prepare('SELECT * FROM attempts').all()]);
  // A run as the browser gets it: GET /api/rush/run, its signed page kept for the post.
  const issue = async (mode, size, headers) => {
    const r = (await call(`/api/rush/run?mode=${mode}&size=${size}`, undefined, headers)).body;
    return { ...r, pages: [{ start: r.start, ids: r.puzzles.map((p) => p.id), sig: r.sig }] };
  };
  // score solved, then one miss, from that run's puzzles
  const runOf = (iss, score, extra = {}) => ({ mode: iss.mode, size: String(iss.size), score, moves: score + 1, errors: 1, bestCombo: score, ms: 180000, build: 1,
    run: iss.run, pages: iss.pages,
    puzzles: [...iss.puzzles.slice(0, score).map((p, i) => ({ id: p.id, solved: true, ms: 1000 + i, clock: 170000 - i, combo: i + 1 })),
      { id: iss.puzzles[score].id, solved: false, ms: 500, wrong: 'a1', clock: 1000, combo: 0 }], ...extra });

  await test('GET /api/rush/run: an ordered, signed 6×6 run of pickable puzzles, with what the client judges by (alternatives too)', async () => {
    const r = await call('/api/rush/run?mode=rush&size=6');
    assert.equal(r.status, 200);
    assert.equal(r.body.puzzles.length, RUN_LEN);
    assert.ok(r.body.puzzles.every((p) => p.size === 6 && p.tps && p.tree && typeof p.rating === 'number' && (p.id === 'p6_0' || (!p.alts && !p.altsAt))));
    assert.ok(r.body.puzzles[0].rating < 1100 && r.body.puzzles[60].rating > 2600, `${r.body.puzzles[0].rating} .. ${r.body.puzzles[60].rating}`);
    assert.match(r.body.run, /^\w+\.[\w-]{12}\.[\w-]{22}$/); assert.match(r.body.sig, /^[\w-]{22}$/);
    assert.equal(r.body.size, 6);
    // p6_0 lists other winning moves: in a run now, with them (alts at the root, altsAt deeper in)
    const alt = (await call('/api/rush/run?mode=rush&size=6&exclude=' + Array.from({ length: 119 }, (_, i) => 'p6_' + (i + 1)).join(','))).body.puzzles;
    assert.deepEqual(alt.map((p) => [p.id, p.alts, p.altsAt]), [['p6_0', ['a1'], { 'b5+ Sc6': ['a2'] }]]);
    const page2 = await call(`/api/rush/run?mode=rush&size=6&run=${encodeURIComponent(r.body.run)}&start=80&exclude=` + r.body.puzzles.map((p) => p.id).join(','));
    assert.equal(page2.body.start, 80); assert.equal(page2.body.run, r.body.run);
    assert.ok(page2.body.puzzles.every((p) => !r.body.puzzles.some((q) => q.id === p.id)));
    assert.equal((await call(`/api/rush/run?mode=streak&size=6&run=${encodeURIComponent(r.body.run)}`)).status, 400); // a rush token
    for (const q of ['mode=storm&size=6', 'mode=rush&size=7', 'mode=rush', 'mode=rush&size=5', 'mode=streak&size=any']) assert.equal((await call('/api/rush/run?' + q)).status, 400, q);
  });

  await test('6×6 only: every other size, or none, is refused on all four routes', async () => {
    for (const q of ['', '?size=5', '?size=any', '?size=0']) {
      assert.equal((await call('/api/rush/best' + q)).status, 400, 'best' + q);
      assert.equal((await call('/api/rush/top' + (q ? q + '&' : '?') + 'mode=rush')).status, 400, 'top' + q);
    }
    assert.equal((await call('/api/rush/best?size=6')).status, 200); assert.equal((await call('/api/rush/top?mode=rush&size=6')).status, 200);
    const iss = await issue('rush', 6), good = { ...runOf(iss, 1), guest: { gid: 'c'.repeat(32) } };
    for (const size of [5, 'any', undefined]) assert.equal((await call('/api/rush/result', { ...good, size }, { 'x-forwarded-for': '10.0.0.4' })).status, 400, String(size));
  });

  await test('the client asks for and posts 6×6 only', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/rush.js'), 'utf8');
    const urls = src.match(/`\/api\/rush\/(run|best|top)[^`]*`/g);
    assert.ok(urls.length >= 4, urls.join(' '));
    for (const u of urls) assert.match(u, /[?&]size=\$\{R\.SIZE\}/, u);
    assert.match(src, /R\.resultBody\(s\.run, \+window\.TINUE_BUILD \|\| 0, envOf\(s\)\)/);
    assert.doesNotMatch(src, /rush-size|sizeChoice|prefs', \{\}\)\?\.size/);
  });

  await test('other /api/rush/ routes are unknown (404), and spend nothing', async () => {
    for (const p of ['/api/rush/foo', '/api/rush/result', '/api/rush/']) assert.equal((await call(p)).status, 404, p);
  });

  const before = snap();
  const G1 = 'a'.repeat(32), G2 = 'b'.repeat(32);

  await test('POST /api/rush/result: a tokenless visitor is kept by gid; new bests are named; nothing rated changes', async () => {
    let r = await call('/api/rush/result', { ...runOf(await issue('rush', 6), 3), guest: { gid: G1 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.newBest, 'all');
    assert.deepEqual(r.body.best.rush, { today: 3, week: 3, all: 3 });
    assert.deepEqual(r.body.best.streak, { today: null, week: null, all: null });
    assert.equal(r.body.token, undefined); // no guest made
    r = await call('/api/rush/result', { ...runOf(await issue('rush', 6), 2), guest: { gid: G1 } });
    assert.equal(r.body.newBest, null);
    r = await call('/api/rush/result', { ...runOf(await issue('rush', 6), 5), guest: { gid: G1 } });
    assert.equal(r.body.newBest, 'all');
    const iss = await issue('rush', 6);
    r = await call('/api/rush/result', { ...runOf(iss, 1), guest: { gid: G2 } }); // someone else
    assert.equal(r.body.newBest, 'all'); assert.equal(r.body.best.rush.all, 1);
    assert.equal(snap(), before, 'users, puzzles and attempts untouched');
    const rows = db.prepare('SELECT * FROM rush_puzzles WHERE run_id = ? ORDER BY pos').all(r.body.id);
    assert.deepEqual(rows.map((x) => [x.pos, x.puzzle_id, x.solved, x.mode, x.wrong, x.user_rating]),
      [[0, iss.puzzles[0].id, 1, 'rush', null, null], [1, iss.puzzles[1].id, 0, 'rush', 'a1', null]]);
    assert.equal(rows[0].puzzle_rating, iss.puzzles[0].rating);
  });

  await test('POST /api/rush/result: only the puzzles handed out to that run, once; forged and implausible runs refused', async () => {
    const iss = await issue('rush', 6), good = { ...runOf(iss, 2), guest: { gid: G2 } };
    const other = await issue('rush', 6);
    const swapped = (i, id) => ({ ...good, puzzles: good.puzzles.map((p, j) => (j === i ? { ...p, id } : p)) });
    const bad = {
      'not handed out': swapped(0, 'p5_0'),
      'rejected puzzle': swapped(0, 'p5_1'),
      'no pages': { ...good, pages: undefined },
      'no run': { ...good, run: undefined },
      'tampered page': { ...good, pages: [{ ...iss.pages[0], ids: [...iss.pages[0].ids.slice(0, -1), 'p5_0'] }] },
      'another run\'s pages': { ...good, pages: other.pages },
      'run for another size': { ...good, size: 'any' },
      'out of order': { ...good, puzzles: [good.puzzles[1], good.puzzles[0], good.puzzles[2]] },
      'forged score': { ...good, score: 80, moves: 0, errors: 0, bestCombo: 0, ms: 0, puzzles: iss.puzzles.slice(0, 80).map((p) => ({ id: p.id, solved: true, ms: 0 })) },
      'puzzle longer than the run': { ...good, ms: 10, puzzles: good.puzzles.map((p, i) => (i ? { ...p, ms: 3600000 } : p)) },
    };
    const from = { 'x-forwarded-for': '10.0.0.2' }; // its own post budget
    for (const [k, b] of Object.entries(bad)) assert.equal((await call('/api/rush/result', b, from)).status, 400, k);
    assert.equal((await call('/api/rush/result', good, from)).status, 200);
    assert.equal((await call('/api/rush/result', good, from)).status, 409, 'posted once');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM rush_puzzles WHERE puzzle_id IN ('p5_0', 'p5_1')").get().n, 0);
  });

  await test('POST /api/rush/result: malformed posts are refused without harm; no player is refused', async () => {
    const iss = await issue('rush', 6);
    for (const b of ['{', '[]', '"x"', JSON.stringify({ ...runOf(iss, 1), score: 9, guest: { gid: G1 } }), JSON.stringify({ ...runOf(iss, 1), size: 9, guest: { gid: G1 } }),
      JSON.stringify(runOf(iss, 1)), JSON.stringify({ ...runOf(iss, 1), guest: { gid: 'nothex' } }), JSON.stringify({ ...runOf(iss, 1), puzzles: [{ id: '../x', solved: true, ms: 1000 }], guest: { gid: G1 } }),
      JSON.stringify({ ...runOf(iss, 1), pages: [{ start: 0, ids: 'x', sig: 1 }], guest: { gid: G1 } }), JSON.stringify({ ...runOf(iss, 1), pages: Array(13).fill(iss.pages[0]), guest: { gid: G1 } })]) {
      const r = await call('/api/rush/result', b, { 'x-forwarded-for': '10.0.0.3' });
      assert.equal(r.status, 400, b.slice(0, 60) + ' -> ' + r.status + JSON.stringify(r.body));
    }
    assert.equal((await call('/api/rush/result', 'x'.repeat(2e5))).status, 413);
    assert.equal((await call('/api/me')).status, 200); // still up
  });

  await test('signed in: a token player, rating recorded per puzzle row, best by token, gid runs joined, top list named only', async () => {
    const reg = await call('/api/register', { name: 'rusher', guest: { gid: G1 } });
    assert.equal(reg.status, 200);
    const auth = { authorization: 'Bearer ' + reg.body.token };
    let b = await call('/api/rush/best?size=6', undefined, auth);
    assert.equal(b.body.best.rush.all, 5, 'runs made under this browser\'s gid count');
    assert.equal((await call('/api/rush/best?size=6')).body.best, null);
    const before2 = snap();
    const iss = await issue('streak', 6, auth), [a, s, c, d] = iss.puzzles;
    const r = await call('/api/rush/result', { mode: 'streak', size: 6, score: 2, moves: 4, errors: 1, bestCombo: 2, ms: 60000, build: 1, run: iss.run, pages: iss.pages,
      puzzles: [{ id: a.id, solved: true, ms: 1000 }, { id: s.id, solved: false, skipped: true, ms: 200 }, { id: c.id, solved: true, ms: 3000 }, { id: d.id, solved: false, ms: 900, wrong: 'c3' }] }, auth);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.newBest, 'all');
    assert.equal(snap(), before2);
    const row = db.prepare('SELECT * FROM rush_puzzles WHERE run_id = ? AND pos = 1').get(r.body.id);
    assert.equal(row.skipped, 1); assert.equal(row.user_rating, 1500); assert.equal(row.mode, 'streak');
    b = await call('/api/rush/best?size=6', undefined, auth);
    assert.deepEqual(b.body.best.streak, { today: 2, week: 2, all: 2 });
    // the browser's gid runs (5 at best) joined the account: listed once, by name; other guests by a label
    let top = (await call('/api/rush/top?mode=rush&size=6')).body.top;
    assert.deepEqual(top.filter((t) => t.named).map((t) => [t.name, t.score]), [['rusher', 5]]);
    assert.ok(top.length > 1 && top.filter((t) => !t.named).every((t) => /^Guest \d{4}$/.test(t.name)), JSON.stringify(top));
    await call('/api/rush/result', runOf(await issue('rush', 6, auth), 4), auth); // under its best: the list stays
    top = (await call('/api/rush/top?mode=rush&size=6', undefined, auth)).body.top;
    assert.deepEqual(top.filter((t) => t.name === 'rusher').map((t) => [t.score, t.you]), [[5, true]]);
    assert.equal((await call('/api/rush/top?mode=x&size=6')).status, 400);
  });

  await test('timing data stored per move; an abandoned run is stored, never a best, and its token posts once; old posts get NULLs', async () => {
    const reg = await call('/api/register', { name: 'quitter', guest: { gid: 'e'.repeat(32) } });
    const auth = { authorization: 'Bearer ' + reg.body.token };
    // a finished run with timings
    let iss = await issue('rush', 6, auth);
    const timed = runOf(iss, 2, { env: { input: 'touch', confirm: false, calm: true, width: 'phone' } });
    timed.puzzles = timed.puzzles.map((p) => ({ ...p, hidden: p.solved ? false : true, mv: [{ first: 120, ms: 400, weight: 1, correct: p.solved }] }));
    let r = await call('/api/rush/result', timed, auth);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const run = db.prepare('SELECT * FROM rush_runs WHERE id = ?').get(r.body.id);
    assert.deepEqual([run.abandoned, run.input, run.confirm, run.calm, run.width], [0, 'touch', 0, 1, 'phone']);
    assert.deepEqual(db.prepare('SELECT pos, n, first_ms, ms, held_ms, weight, correct FROM rush_moves WHERE run_id = ? ORDER BY pos, n').all(r.body.id).map((x) => ({ ...x })),
      [{ pos: 0, n: 0, first_ms: 120, ms: 400, held_ms: null, weight: 1, correct: 1 }, { pos: 1, n: 0, first_ms: 120, ms: 400, held_ms: null, weight: 1, correct: 1 },
        { pos: 2, n: 0, first_ms: 120, ms: 400, held_ms: null, weight: 1, correct: 0 }]);
    assert.deepEqual(db.prepare('SELECT hidden, nmoves, unfinished FROM rush_puzzles WHERE run_id = ? ORDER BY pos').all(r.body.id).map((x) => [x.hidden, x.nmoves, x.unfinished]), [[0, 1, 0], [0, 1, 0], [1, 1, 0]]);
    // the doc's example query runs
    const q = fs.readFileSync(path.join(ROOT, 'server/rush.js'), 'utf8').match(/WITH t AS \([\s\S]*?ORDER BY band;/)[0].replace(/\n\/\/\s*/g, ' ');
    assert.ok(Array.isArray(db.prepare(q).all({ P: iss.puzzles[0].id })));
    // abandoned, with a bigger score than any run of theirs: stored, but no best, no top list
    iss = await issue('rush', 6, auth);
    const ab = { ...runOf(iss, 5), abandoned: true, errors: 0, moves: 6, units: 6, bestCombo: 6 };
    ab.puzzles = [...ab.puzzles.slice(0, 5), { id: iss.puzzles[5].id, solved: false, unfinished: true, ms: 800, mv: [{ first: 100, ms: 300, weight: 1, correct: true }] }];
    r = await call('/api/rush/result', ab, auth);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.newBest, null);
    assert.equal(db.prepare('SELECT abandoned FROM rush_runs WHERE id = ?').get(r.body.id).abandoned, 1);
    assert.equal(db.prepare('SELECT unfinished FROM rush_puzzles WHERE run_id = ? AND pos = 5').get(r.body.id).unfinished, 1);
    assert.equal((await call('/api/rush/best?size=6', undefined, auth)).body.best.rush.all, 2, 'the finished run is the best');
    assert.equal(db.prepare("SELECT score FROM rush_lead l JOIN users u ON l.player = 'u' || u.id WHERE u.name = ?").get('quitter').score, 2);
    // the same token can't post again, finished this time
    assert.equal((await call('/api/rush/result', { ...runOf(iss, 5) }, auth)).status, 409);
    // an old-shape post: NULLs
    iss = await issue('rush', 6, auth);
    r = await call('/api/rush/result', runOf(iss, 1), auth);
    assert.equal(r.status, 200);
    const o = db.prepare('SELECT abandoned, input, confirm, calm, width FROM rush_runs WHERE id = ?').get(r.body.id);
    assert.deepEqual({ ...o }, { abandoned: 0, input: null, confirm: null, calm: null, width: null });
    assert.deepEqual({ ...db.prepare('SELECT hidden, nmoves FROM rush_puzzles WHERE run_id = ? AND pos = 0').get(r.body.id) }, { hidden: null, nmoves: null });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rush_moves WHERE run_id = ?').get(r.body.id).n, 0);
  });

  await test('trajectory stored per move, and the doc\'s trajectory and attempts queries run', async () => {
    const iss = await issue('rush', 6, { 'x-forwarded-for': '10.0.0.9' });
    const body = { ...runOf(iss, 2), guest: { gid: 'f'.repeat(32) } };
    body.puzzles = body.puzzles.map((p, i) => ({ ...p, mv: [{ first: 100, ms: 500, weight: 1, correct: p.solved, at: i * 3000, ptn: p.solved ? 'c3' : 'a1', clock: 175000 - i * 3000 }] }));
    const r = await call('/api/rush/result', body, { 'x-forwarded-for': '10.0.0.9' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const src = fs.readFileSync(path.join(ROOT, 'server/rush.js'), 'utf8');
    const doc = (re) => src.match(re)[0].replace(/\n\/\/\s*/g, ' ');
    const traj = db.prepare(doc(/SELECT m\.run_id[\s\S]*?;/)).all({ run: r.body.id });
    assert.deepEqual(traj.map((x) => [x.pos, x.n, x.ptn, x.correct, x.at_ms, x.clock_ms, x.puzzle_id]),
      [[0, 0, 'c3', 1, 0, 175000, iss.puzzles[0].id], [1, 0, 'c3', 1, 3000, 172000, iss.puzzles[1].id], [2, 0, 'a1', 0, 6000, 169000, iss.puzzles[2].id]]);
    assert.ok(traj.every((x) => 'first_ms' in x && 'ms' in x && 'combo' in x && 'puzzle_rating' in x));
    const att = db.prepare(doc(/SELECT p\.run_id[\s\S]*?;/)).all({ P: iss.puzzles[2].id });
    const mine = att.find((x) => x.run_id === r.body.id);
    assert.deepEqual([mine.gid, mine.user_id, mine.solved, mine.first_input_ms, mine.wrong], ['f'.repeat(32), null, 0, 100, 'a1']);
  });

  await test('adjudicated moves: the check, the pauses, the play-out and the symmetry are stored; the doc\'s clock-time query runs', async () => {
    const iss = await issue('rush', 6, { 'x-forwarded-for': '10.0.0.10' });
    const body = { ...runOf(iss, 2), guest: { gid: 'e'.repeat(32) }, paused: 7000 };
    body.puzzles = body.puzzles.map((p, i) => ({ ...p, sym: i, mv: [i === 1
      ? { first: 100, ms: 500, weight: 1, correct: true, at: 3000, ptn: 'a1', clock: 172000, check: 'pending', checkMs: 2500, final: 'wins', finalMs: 6000, paused: 7000, path: [],
        po: { proven: true, cap: 6, end: 'win', paused: 4500, line: [{ m: 'a2', ms: 2000 }, { m: 'b1', ms: 800 }, { m: 'a3', ms: 2500 }, { m: 'b2', ms: 900 }] } }
      : { first: 100, ms: 500, weight: 1, correct: p.solved, at: i * 3000 + (i > 1 ? 7000 : 0), ptn: p.solved ? 'c3' : 'a1', clock: 175000 - i * 3000 }] }));
    const r = await call('/api/rush/result', body, { 'x-forwarded-for': '10.0.0.10' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(db.prepare('SELECT paused_ms FROM rush_runs WHERE id = ?').get(r.body.id).paused_ms, 7000);
    assert.deepEqual(db.prepare('SELECT sym FROM rush_puzzles WHERE run_id = ? ORDER BY pos').all(r.body.id).map((x) => x.sym), [0, 1, 2]);
    const m = db.prepare('SELECT check_v, check_ms, final_v, final_ms, paused_ms, open, path, correct FROM rush_moves WHERE run_id = ? AND pos = 1').get(r.body.id);
    assert.deepEqual({ ...m }, { check_v: 'pending', check_ms: 2500, final_v: 'wins', final_ms: 6000, paused_ms: 7000, open: 0, path: '', correct: 1 });
    assert.deepEqual({ ...db.prepare('SELECT check_v, paused_ms, open FROM rush_moves WHERE run_id = ? AND pos = 0').get(r.body.id) }, { check_v: null, paused_ms: null, open: null });
    const po = db.prepare('SELECT * FROM rush_playouts WHERE run_id = ?').all(r.body.id);
    assert.equal(po.length, 1);
    assert.deepEqual([po[0].pos, po[0].n, po[0].proven, po[0].cap, po[0].ending, po[0].paused_ms, JSON.parse(po[0].moves).map((x) => x.m)], [1, 0, 1, 6, 'win', 4500, ['a2', 'b1', 'a3', 'b2']]);
    // the doc's clock time: at_ms less the pauses decided before it
    const src = fs.readFileSync(path.join(ROOT, 'server/rush.js'), 'utf8');
    const q = src.match(/SELECT m\.pos, m\.n, m\.at_ms - COALESCE[\s\S]*?;/)[0].replace(/\n\/\/\s*/g, ' ');
    assert.deepEqual(db.prepare(q).all({ run: r.body.id }).map((x) => x.clock_at_ms), [0, 3000, 6000]);
    // an old post: NULLs in the new columns, no play-out rows
    const iss2 = await issue('rush', 6, { 'x-forwarded-for': '10.0.0.11' });
    const r2 = await call('/api/rush/result', { ...runOf(iss2, 1), guest: { gid: 'd'.repeat(32) } }, { 'x-forwarded-for': '10.0.0.11' });
    assert.equal(r2.status, 200);
    assert.equal(db.prepare('SELECT paused_ms FROM rush_runs WHERE id = ?').get(r2.body.id).paused_ms, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rush_puzzles WHERE run_id = ? AND sym IS NOT NULL').get(r2.body.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rush_playouts WHERE run_id = ?').get(r2.body.id).n, 0);
    // a forged pause (more than its parts) is refused whole
    const iss3 = await issue('rush', 6, { 'x-forwarded-for': '10.0.0.12' });
    assert.equal((await call('/api/rush/result', { ...runOf(iss3, 1), paused: 60000, guest: { gid: 'c'.repeat(32) } }, { 'x-forwarded-for': '10.0.0.12' })).status, 400);
  });

  await test('combo credit stored: rush_moves.credit beside weight, rush_puzzles.combo credited; a wrong credit refused', async () => {
    const from = { 'x-forwarded-for': '10.0.0.13' };
    const iss = await issue('rush', 6, from), id = iss.puzzles[0].id;
    // the p6_ puzzles are P6 (b5+ f5+ e2< and a finisher): one line move, then off the line under symmetry 6, credit 3
    const { body } = creditRun({ ...P6, plies: 7 }, 6, 1, { id });
    const post = { ...body, run: iss.run, pages: iss.pages, guest: { gid: '9'.repeat(32) } };
    assert.equal((await call('/api/rush/result', { ...post, puzzles: [{ ...post.puzzles[0], mv: [post.puzzles[0].mv[0], { ...post.puzzles[0].mv[1], credit: 2 }] }], units: 3 }, from)).status, 400, 'too low');
    const r = await call('/api/rush/result', post, from);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mv = db.prepare('SELECT n, weight, credit, correct FROM rush_moves WHERE run_id = ? ORDER BY n').all(r.body.id).map((x) => ({ ...x }));
    assert.deepEqual(mv, [{ n: 0, weight: 1, credit: null, correct: 1 }, { n: 1, weight: R.weight(post.puzzles[0].mv[1].ptn), credit: 3, correct: 1 }]);
    assert.deepEqual({ ...db.prepare('SELECT combo, solved FROM rush_puzzles WHERE run_id = ?').get(r.body.id) }, { combo: 4, solved: 1 });
    assert.equal(db.prepare('SELECT units FROM rush_runs WHERE id = ?').get(r.body.id).units, 4);
    // the doc's units query agrees with the run's
    const q = fs.readFileSync(path.join(ROOT, 'server/rush.js'), 'utf8').match(/SELECT run_id, SUM\(CASE WHEN correct[\s\S]*?;/)[0];
    assert.equal(db.prepare(q).all().find((x) => x.run_id === r.body.id).units, 4);
  });

  await test('rate limits: posts are limited per player', async () => {
    const body = { ...runOf(await issue('rush', 6), 0), guest: { gid: G2 } };
    let last;
    for (let i = 0; i < 25; i++) last = await call('/api/rush/result', body);
    assert.equal(last.status, 429);
  });
  db.close();
} finally { await stop(server); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`test-rush: ${n} ok, ${failed} failed`);
if (failed) process.exit(1);
