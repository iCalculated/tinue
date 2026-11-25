// The flat-count bar's turn marker (board-kit.js turnMark; tinue's own board, retired, drew it): it names the side to move of the position shown, the opening's
// swapped first stones included, and nobody once the game is over.  node scripts/test-turn-mark.mjs
import assert from 'node:assert/strict';
import { Game } from '../shared/tak.js';
import { readFileSync } from 'node:fs';
globalThis.window ??= { addEventListener() {} }; globalThis.document ??= { addEventListener() {} };
const { turnMark } = await import('../public/board-kit.js');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const after = (moves, g = new Game(5)) => { for (const m of moves) g.play(m); return g; };

test('White first, then Black, though each places the other colour on the first two plies', () => {
  assert.equal(turnMark(new Game(5)), 1);
  assert.equal(turnMark(after(['a1'])), 2);
  assert.equal(turnMark(after(['a1', 'e5'])), 1);
});
test('a TPS with Black to move marks Black', () => assert.equal(turnMark(Game.fromTPS('1,1,1,1,1,x/1,1,1,1,1,x/1,1,x4/x6/x6/2S,2S,2S,x3 2 13', 0)), 2));
test('a road ends the game: no marker', () => {
  const g = after(['e1', 'a1', 'a2', 'e4', 'a3', 'e3', 'a4', 'e2']);
  assert.equal(turnMark(g), 1);
  g.play('a5');
  assert.ok(g.result());
  assert.equal(turnMark(g), 0);
});
test('stepping back from the end marks the mover again (the board shows earlier snapshots\' games)', () => {
  const g = after(['e1', 'a1', 'a2', 'e4', 'a3', 'e3', 'a4']);
  assert.equal(turnMark(g), 2);
});
// The trim's colours, from board.css: contrast against each half of the bar and the stripe of its komi hatch, all read
// from board.css (the felt board's stones, --h1 / --h2), so a change to the stones or the hatch is held to the same floors.
const css = readFileSync(new URL('../public/board.css', import.meta.url), 'utf8');
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const v = (name) => { const m = css.match(new RegExp(`--${name}: (#[0-9a-f]{6});`)); assert.ok(m, `board.css --${name}`); return m[1]; };
const trim = (h) => { const m = css.match(new RegExp(`\\.tb-fc\\.tm${h} > \\.tb-f${h}::after \\{ background: (#[0-9a-f]{6}); \\}`)); assert.ok(m, `the half ${h} trim has its own colour`); return m[1]; };
test('one trim: the ::after on .tm1/.tm2, 3px, nothing else marks the mover on the bar', () => {
  assert.match(css, /\.tb-fc\.tm1 > \.tb-f1::after, \.tb-fc\.tm2 > \.tb-f2::after \{\s*content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; \}/);
  assert.doesNotMatch(css, /\.tb(:not\(\.t2\))? \.tb-f[12] \{[^}]*box-shadow/, 'no second trim drawn by box-shadow');
});
test('the light half\'s trim: 3.9:1 on White\'s cream, 3.0:1 on the hatch', () => {
  assert.ok(ratio(trim(1), v('p1')) >= 3.9 && ratio(trim(1), v('h1')) >= 3.0, `${trim(1)}: ${ratio(trim(1), v('p1')).toFixed(2)}, ${ratio(trim(1), v('h1')).toFixed(2)}`);
});
test('the dark half\'s trim: 4.5:1 on Black\'s near-black, 3.0:1 on the hatch', () => {
  assert.ok(ratio(trim(2), v('p2')) >= 4.5 && ratio(trim(2), v('h2')) >= 3.0, `${trim(2)}: ${ratio(trim(2), v('p2')).toFixed(2)}, ${ratio(trim(2), v('h2')).toFixed(2)}`);
});
// …and it is not the cloth's sage: a trim of the board's own hue runs into the board under the bar and reads as the bar
// ending early (luminance can't hold this: the light half's olive is 1.17:1 on the cloth, the rejected sage 1.35:1)
const hue = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255), mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  const x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (x * 60 + 360) % 360; };
test('each trim is the site\'s green, not the cloth\'s sage (30° of hue or more away)', () => {
  for (const h of [1, 2]) { const dh = Math.abs(hue(trim(h)) - hue(v('b1'))), d = Math.min(dh, 360 - dh); assert.ok(d >= 30, `${trim(h)}: ${d.toFixed(0)}°`); }
});
test('the hatch shows on each half', () => {
  assert.ok(ratio(v('h1'), v('p1')) >= 1.2 && ratio(v('h2'), v('p2')) >= 1.3);
});
console.log(`${n} ok`);
