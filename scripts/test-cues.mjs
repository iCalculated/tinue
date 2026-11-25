// Which cue plays when, on the puzzle page and in Rush (public/app.js, public/rush.js, public/ninja.js with sound.js):
// a board out of sight is silent; a wrong move's cue waits for the move's own sounds; Rush's reply sounds after a
// hand-built smash; Rush's cues stay in the run; rushEnd follows the last correct cue; the ten-second warning waits
// for a miss's cue; Forward sounds its move as → does; a PTN Ninja load that changes the position shown cuts.
// app.js and rush.js are browser modules: their lines are checked as written; ninja.js's load is driven.
//   node --no-warnings scripts/test-cues.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPTN, hooks } from '../public/board-kit.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const root = new URL('..', import.meta.url).pathname;
const code = (f) => fs.readFileSync(root + f, 'utf8').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const app = code('public/app.js'), rush = code('public/rush.js');
const body = (src, head) => { const i = src.indexOf(head); assert.ok(i >= 0, head); let d = 0; const j = src.indexOf('{', i + head.length - 1);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } throw new Error(head); };

await test('a board out of sight makes no sound and cuts nothing (the puzzle page\'s, under Rush or History)', () => {
  const m = /const inSight = (\(b\) => [^;]*);/.exec(app);
  assert.ok(m);
  const inSight = eval(m[1]);
  assert.equal(inSight({ el: { getClientRects: () => [] } }), false, 'a hidden view: no boxes');
  assert.equal(inSight({ el: { getClientRects: () => [{}] } }), true);
  assert.equal(inSight(undefined), true, 'a hook called without its board (older callers) still sounds');
  assert.equal(inSight({ away: true, el: { getClientRects: () => [{}] } }), false, 'the puzzle page\'s PTN Ninja board, laid out under Rush while Rush has its frame: silent');
  for (const h of ['onPly', 'onLand', 'onCut']) assert.match(app, new RegExp(`hooks\\.${h} = \\([^)]*\\bb\\) => \\{ if \\(inSight\\(b\\)\\)`), h);
  const ninja = code('public/ninja.js');
  assert.equal((ninja.match(/hooks\.onPly\?\.\([^;]*, this\)/g) || []).length, 2); assert.equal((ninja.match(/hooks\.onCut\?\.\(this\)/g) || []).length, 2);
  assert.doesNotMatch(ninja, /Board\.on/);
});

await test('the puzzle page\'s wrong cue waits for the move\'s own sounds (verdict, not a fixed 120 ms)', () => {
  assert.match(body(app, 'function fail('), /sound\.verdict\('wrong', 120\)/);
  assert.doesNotMatch(app, /sound\.later\('wrong'/);
});

await test('Forward (▶) steps as → does: through navStep, so its move sounds', () => {
  assert.match(app, /if \(n === 'next'\) return navStep\(1, false\);/);
});

await test('Rush: the reply\'s sound waits for the move\'s own (holdMoves(tail())), its board does not', () => {
  const r = body(rush, 'function reply(');
  assert.ok(r.indexOf('sound.holdMoves(sound.tail())') >= 0 && r.indexOf('sound.holdMoves(sound.tail())') < r.indexOf('board.append('));
});

await test('Rush: the verdict is scheduled before mark() renders the clock, so a penalty that crosses 10 s waits for the miss\'s cue', () => {
  const d = body(rush, 'function done(');
  const v = d.indexOf("s.wrongAt = performance.now() + sound.verdict('wrong'"), mk = d.indexOf('mark(solved');
  assert.ok(v > 0 && mk > v, 'verdict, then mark');
  // renderClock's warning is timed from st.wrongAt: with the miss just scheduled it lands 250 ms after the cue's start
  assert.match(body(rush, 'function renderClock('), /sound\.later\('lowTime', Math\.max\(0, \(st\.wrongAt \?\? -1e9\) \+ 250 - performance\.now\(\)\)\)/);
});

await test('Rush: the run\'s end cue follows the last correct cue too (s.goodAt), not only a miss', () => {
  assert.match(body(rush, 'function done('), /s\.goodAt = performance\.now\(\) \+ sound\.verdict\('rushGood', 45, 55\)/);
  assert.match(rush, /sound\.later\('rushEnd', Math\.max\(0, \(s\.wrongAt \?\? -1e9\) \+ 250 - performance\.now\(\), \(s\.goodAt \?\? -1e9\) \+ 80 - performance\.now\(\)\)\)/);
});

await test('Rush: leaving drops its cues still due (sound.dropLater), only when a run was on screen', () => {
  assert.match(body(rush, 'export function leave('), /if \(st\) sound\.dropLater\(\);/);
});

await test('PTN Ninja: a load that changes the position shown cuts the drops still sounding, even with the same PTN (a cancelled spread)', async () => {
  const { NinjaBoard } = await import('../public/ninja.js');
  let cuts = 0;
  hooks.onCut = () => cuts++;
  const P = buildPTN({ size: 5, tps: 'x5/x5/111,x4/x5/x5 1 6' });
  const fake = Object.assign(Object.create(NinjaBoard.prototype), { opts: {}, hl: [], iframe: { dataset: { up: '1' } }, _send: async () => {}, _post() {}, _settle() {}, _shape() {}, _afterDraw() {} });
  await fake.load(P);
  assert.equal(cuts, 1, 'the first load');
  await fake.load(P);
  assert.equal(cuts, 1, 'the same position again: nothing to cut');
  fake._played('3a3>111'); // a spread made on PTN Ninja (its drops are sounding), then Cancel reloads the same PTN
  await fake.load(P);
  assert.equal(cuts, 2, 'the restored position is another one: the drops stop');
  hooks.onCut = null;
});

console.log(`all ${n} passed`);
process.exit(0);
