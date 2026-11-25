// Rating rules: start state, theme weights, the clueless-player rule, bounds.   node scripts/test-rating.mjs
import assert from 'node:assert/strict';
import { rate, themeWeight, THEME_WIN_WEIGHT, THEME_LOSS_WEIGHT, PLAYER_START, provisional, replayGuest } from '../shared/rating.js';
import { PUZZLE_START, RD_MIN, cap } from '../shared/glicko.js';
import { THEMES } from '../shared/themes.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const puzzle = (rating = 1500, rd = PUZZLE_START.rd) => ({ rating, rd, vol: PUZZLE_START.vol });

test('players start at 1500 ± 500, vol 0.06, provisional', () => {
  assert.deepEqual(PLAYER_START, { rating: 1500, rd: 500, vol: 0.06 });
  assert.ok(provisional(PLAYER_START));
});

test('puzzles start at ± 250, vol 0.09', () => assert.deepEqual(PUZZLE_START, { rd: 250, vol: 0.09 }));

test('a missing rd / vol means the start values', () => {
  const a = rate({ rating: 1500 }, { rating: 1500 }, true), b = rate(PLAYER_START, puzzle(), true);
  assert.deepEqual(a, b);
});

test('newcomer vs equal puzzle: a big symmetric jump', () => {
  const w = rate(PLAYER_START, puzzle(), true), l = rate(PLAYER_START, puzzle(), false);
  assert.ok(w.userDelta > 200 && w.userDelta < 300, String(w.userDelta));
  near(w.userDelta, -l.userDelta, 1e-6);
});

test('a near-total guess (rd ≥ 230) does not move the puzzle', () => {
  const r = rate({ rating: 1500, rd: 230, vol: 0.06 }, puzzle(), true);
  assert.equal(r.puzzleDelta, 0);
  const s = rate({ rating: 1500, rd: 229, vol: 0.06 }, puzzle(), true);
  assert.ok(s.puzzleDelta < 0);
});

test('theme weights: 0.1 for a win, 0.7 for a loss, 1 without a theme', () => {
  assert.equal(THEME_WIN_WEIGHT, 0.1); assert.equal(THEME_LOSS_WEIGHT, 0.7);
  assert.equal(themeWeight('fork', THEMES, true), 0.1);
  assert.equal(themeWeight('fork', THEMES, false), 0.7);
  assert.equal(themeWeight('', THEMES, true), 1);
  assert.equal(themeWeight('nope', THEMES, true), 1);
  // a challenge theme counts in full, both ways (Deep tinuë), and it is the only one
  assert.equal(themeWeight('deep', THEMES, true), 1); assert.equal(themeWeight('deep', THEMES, false), 1);
  assert.deepEqual(Object.keys(THEMES).filter((k) => THEMES[k].fullWeight), ['deep']);
  const u = { rating: 1600, rd: 80, vol: 0.06 };
  near(rate(u, puzzle(), true, 0.1).userDelta, 0.1 * rate(u, puzzle(), true).userDelta, 1e-6);
});

test('bounds: rd stays within [45, 500]', () => {
  let u = { ...PLAYER_START };
  for (let i = 0; i < 400; i++) u = rate(u, puzzle(u.rating, 60), i % 2 === 0).user;
  assert.ok(u.rd >= RD_MIN && u.rd < 100, String(u.rd));
  assert.equal(cap({ rating: 0, rd: 9999, vol: 1 }).rd, 500);
});

test('replayGuest: from PLAYER_START through unhinted results, oldest first', () => {
  const rows = [{ puzzle_rating: 1500, prd: 250, win: 1, hinted: 0 }, { puzzle_rating: 1600, prd: 200, win: 0, hinted: 1 }, { puzzle_rating: 1400, prd: 100, win: 0, hinted: 0 }];
  const r = replayGuest(rows);
  let u = rate(PLAYER_START, { rating: 1500, rd: 250, vol: 0.09 }, true).user;
  u = rate(u, { rating: 1400, rd: 100, vol: 0.09 }, false).user;
  assert.deepEqual(r.rating, u); assert.equal(r.games, 2); assert.equal(r.wins, 1);
  assert.deepEqual(r.attempts.map((a) => a.rated), [1, 0, 1]);
  near(r.attempts[0].user_rating + r.attempts[0].user_delta + r.attempts[2].user_delta, u.rating, 1e-9);
  assert.deepEqual(replayGuest([]).rating, PLAYER_START);
});

console.log(`\nOK: ${n} rating tests`);
