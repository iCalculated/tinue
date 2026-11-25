// TEI engine output (shared/tei.js): info lines, and a MultiPV search's lines.   node scripts/test-tei.mjs
import assert from 'node:assert/strict';
import { parseInfo, keepLine, bestLines } from '../shared/tei.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const feed = (lines) => { const m = new Map(); for (const l of lines) { const i = parseInfo(l); if (i) keepLine(m, i); } return m; };

// Syntaks (wasm build) with MultiPV 3, 1.5 s on x6/x6/x2,1,2,x2/x2,2,1,x2/x6/x6 1 3 at komi 2: the last iteration
// (depth 13) was cut short after two lines, so line 3 is still depth 12's, and plays depth 13's best move.
const RUN = `info multipv 1 depth 11 seldepth 14 time 438 nodes 239854 nps 546627 score cp 34 wdl 541 63 396 hashfull 67 pv b3 c2 e4 d5 b4 Cc5 e3 c5- f4 d6 Cc1
info multipv 2 depth 11 seldepth 15 time 438 nodes 239854 nps 546627 score cp 31 wdl 534 63 403 hashfull 67 pv b4 b3 d5 e4 c5 e5 d6 a3 Cc2 e2 d2
info multipv 3 depth 11 seldepth 15 time 438 nodes 239854 nps 546627 score cp 28 wdl 526 63 411 hashfull 67 pv e4 d5 e3 e5 b3 b4 f4 Cd2 e2
info multipv 1 depth 12 seldepth 17 time 670 nodes 362819 nps 540943 score cp 42 wdl 557 62 381 hashfull 115 pv b3 c2 e3 e4 b4 b2 a3 Cd2 f3 d2+ Cd5 a2 f4 Sb5 d5-
info multipv 2 depth 12 seldepth 16 time 670 nodes 362819 nps 540943 score cp 32 wdl 536 63 401 hashfull 115 pv b4 b3 e4 e3 d5 f3 Cc2 Cc5 f4 c5- d2 b5 b2
info multipv 3 depth 12 seldepth 16 time 670 nodes 362819 nps 540943 score cp 27 wdl 525 64 411 hashfull 115 pv e4 d5 b4 b3 f4 Ce3 a4 e3< e5 c5 a3 f3 e3 d6
info multipv 1 depth 13 seldepth 19 time 1420 nodes 755960 nps 532205 score cp 59 wdl 592 61 347 hashfull 259 pv e4 d5 e3 c2 b4 Cd2 e2 e5 a4 d2+ Cd6 b3
info multipv 2 depth 13 seldepth 19 time 1420 nodes 755960 nps 532205 score cp 58 wdl 590 60 350 hashfull 259 pv b3 c2 b4 e4 c5 Cb5 b2 a4 Cd5 b5- d5-
info multipv 1 depth 13 seldepth 19 time 1509 nodes 802816 nps 532012 score cp 59 wdl 592 61 347 hashfull 273 pv e4 d5 e3 c2 b4 Cd2 e2 e5 a4 d2+ Cd6 b3
info multipv 2 depth 13 seldepth 19 time 1509 nodes 802816 nps 532012 score cp 58 wdl 590 60 350 hashfull 273 pv b3 c2 b4 e4 c5 Cb5 b2 a4 Cd5 b5- d5-
bestmove e4`.split('\n');

test('parseInfo: every field, multipv defaulting to 1, null for lines without a score', () => {
  assert.deepEqual(parseInfo(RUN[7]), { multipv: 2, depth: 13, nodes: 755960, cp: 58, mate: null, bound: false, wdl: [590, 60, 350],
    pv: ['b3', 'c2', 'b4', 'e4', 'c5', 'Cb5', 'b2', 'a4', 'Cd5', 'b5-', 'd5-'] });
  const old = parseInfo('info depth 9 seldepth 12 time 40 nodes 20000 nps 494722 score cp -103 upperbound wdl 269 53 678 hashfull 3 pv f6 b3');
  assert.equal(old.multipv, 1); assert.equal(old.bound, true); assert.equal(old.cp, -103); assert.deepEqual(old.pv, ['f6', 'b3']);
  const m = parseInfo('info multipv 3 depth 7 score mate -2 nodes 99 pv a1');
  assert.equal(m.mate, -2); assert.equal(m.cp, null); assert.equal(m.wdl, null); assert.equal(m.multipv, 3);
  assert.equal(parseInfo('info string hello'), null);
  assert.equal(parseInfo('info string score mate 1 pv a1'), null); // free text, not a score
  for (const cut of ['info depth 11 multipv 1 score cp', 'info depth 11 multipv 1 score', 'info depth 11 score mate pv a1', 'info depth 11 score cp x pv a1', 'info depth 11 score wdl 1 2 3'])
    assert.equal(parseInfo(cut), null, cut);
  // so a cut line never replaces the line before it
  const kept = bestLines(feed(['info depth 10 multipv 1 score cp 30 pv a1 b2', 'info depth 11 multipv 1 score cp']));
  assert.deepEqual(kept.map((l) => [l.depth, l.cp, l.pv]), [[10, 30, ['a1', 'b2']]]);
  assert.equal(parseInfo('info depth 3 currmove a1'), null);
  assert.equal(parseInfo('bestmove a1'), null);
  assert.deepEqual(parseInfo('info depth 4 score cp 3').pv, []);
});

test('a real MultiPV 3 run: per index the last exact line; a stale line repeating line 1\'s move is dropped', () => {
  const m = feed(RUN);
  assert.equal(m.get(1).exact.depth, 13); assert.equal(m.get(2).exact.depth, 13); assert.equal(m.get(3).exact.depth, 12);
  const out = bestLines(m);
  assert.deepEqual(out.map((x) => [x.pv[0], x.depth, x.cp]), [['e4', 13, 59], ['b3', 13, 58]]);
  // up to depth 12 (complete iterations): three lines, best first
  assert.deepEqual(bestLines(feed(RUN.slice(0, 6))).map((x) => x.pv[0]), ['b3', 'b4', 'e4']);
});

test('a bound line (iteration cut short) never replaces an exact one; an index with only bounds uses its last', () => {
  const m = feed([...RUN.slice(0, 6),
    'info multipv 1 depth 13 score cp 70 lowerbound wdl 600 60 340 nodes 1 pv f4 c2',
    'info multipv 2 depth 13 score cp 10 upperbound wdl 500 60 440 nodes 1 pv a1 c2']);
  assert.deepEqual(bestLines(m).map((x) => [x.pv[0], x.depth, x.bound]), [['b3', 12, false], ['b4', 12, false], ['e4', 12, false]]);
  assert.equal(m.get(1).last.pv[0], 'f4'); // kept as `last`, not used while an exact line exists
  const b = feed(['info multipv 1 depth 2 score cp 5 upperbound nodes 3 pv c3']);
  assert.deepEqual(bestLines(b).map((x) => [x.pv[0], x.bound]), [['c3', true]]);
});

test('mate and wdl lines; an engine without MultiPV (no multipv field) is one line', () => {
  const m = feed(['info multipv 1 depth 5 score mate 2 nodes 9 pv a1 b1 a2', 'info multipv 2 depth 5 score cp -40 wdl 300 100 600 nodes 9 pv c3',
    'info multipv 3 depth 4 score mate -3 nodes 9 pv d4 e4']);
  const out = bestLines(m);
  assert.deepEqual(out.map((x) => [x.pv[0], x.mate, x.cp]), [['a1', 2, null], ['c3', null, -40], ['d4', -3, null]]);
  assert.deepEqual(out[1].wdl, [300, 100, 600]);
  const one = bestLines(feed(['info depth 3 score cp 1 nodes 1 pv a1', 'info depth 4 score cp 2 nodes 2 pv b1', 'info depth 5 score cp 3 upperbound nodes 3 pv c1']));
  assert.deepEqual(one.map((x) => x.pv[0]), ['b1']);
});

console.log(`\nOK: ${n} tei tests`);
