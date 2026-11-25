// The felt board: tinue's board (board.css), its PTN Ninja theme (ninja.js THEME) and the share picture (server/share.js
// boardPng) draw one sage cloth with stitched seams in the same colours, and every mark drawn on the cloth still reads on
// it (WCAG contrast of the colours as board.css composites them).  node scripts/test-felt-board.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { boardPng, C, SEAM, LAST, STONE } from '../server/share.js';

const root = new URL('..', import.meta.url).pathname;
let fails = 0;
const test = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { fails++; console.log('FAIL', name, '\n', e.message.slice(0, 400)); } };

const css = fs.readFileSync(root + 'public/board.css', 'utf8');
const style = fs.readFileSync(root + 'public/style.css', 'utf8');
const v = (name, src = css) => { const m = src.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i')); assert.ok(m, `--${name}`); return m[1].toLowerCase(); };
const ninja = fs.readFileSync(root + 'public/ninja.js', 'utf8');
const THEME = vm.runInNewContext('(' + ninja.match(/\nconst THEME = (\{[\s\S]*?\n\});/)[1] + ')');
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (bg, c, a) => bg.map((x, i) => x * (1 - a) + c[i] * a);
// an opacity as board.css sets it, by the rule's selector
const op = (sel, what = sel) => {
  const m = css.match(new RegExp('\\n' + sel.replace(/[.()[\]]/g, '\\$&') + ' \\{[^}]*?opacity: ([.\\d]+);'));
  assert.ok(m, what); return +m[1];
};

test('board.css: one cloth with stitched seams, no tiles, no light/dark squares', () => {
  assert.equal(v('b1'), '#4a6761', 'the cloth');
  assert.match(css, /\.tb-board \{[^}]*background-color: var\(--b1\);[^}]*feTurbulence/, 'the cloth and its weave');
  assert.match(css, /\.tb-sq::before \{ content: ''; opacity: \.7;\s*background: repeating-linear-gradient\(to bottom, var\(--thread\) 0 5\.5%, transparent 5\.5% 10%\) left top[^;]*,\s*repeating-linear-gradient\(to right, var\(--thread\) 0 5\.5%, transparent 5\.5% 10%\) left bottom/, 'running stitches left and bottom');
  assert.match(css, /\.tb-sq:has\(\.tb-lr\):has\(\.tb-lc\)::before \{ background: none; \}/, "no seam on the board's corner square");
  assert.match(css, /\.tb-sq::before, \.tb-hl, \.tb-sq::after \{ position: absolute; inset: 0;/, 'marks cover the whole square');
  assert.doesNotMatch(css, /\.dk\b|\.lt\b|--tdk|inset: 3\.6%|data-look/);
});

test('stones: 52% of a square, 13% corners; walls 19% wide; the board, bar and tray keep their sizes', () => {
  assert.match(css, /\.tb-st \{[^}]*width: 52%; height: 52%; margin: 24%;[^}]*border-radius: 13%;/);
  assert.match(css, /\.tb-st\.S \{ width: 19%; left: 16\.5%; border-radius: 38% \/ 12%;/);
  assert.match(css, /\.tb-fc \{ display: flex; height: 22px;/, 'the bar is 22px');
  assert.match(css, /\.tb-tray \{ width: 100%; aspect-ratio: var\(--n\) \/ 1;/, 'the tray is a square tall');
  assert.match(css, /\.tb-board \{ position: relative; z-index: 1; width: 100%; aspect-ratio: 1;/);
  assert.equal(STONE.size, 0.52); assert.equal(STONE.radius, 0.13); assert.equal(STONE.wall, 0.19);
});

test('PTN Ninja theme: grid1 (the cloth ruled in thread), not checkered, no rings, in board.css colours', () => {
  assert.equal(THEME.id, 'tinue'); assert.equal(THEME.boardStyle, 'grid1'); assert.equal(THEME.boardChecker, false); assert.equal(THEME.rings, 0);
  const pairs = { board1: 'b1', board2: 'thread', board3: 'b3', primary: 'pri', player1: 'p1', player1flat: 'p1', player1special: 'p1s',
    player1border: 'p1b', player1road: 'p1r', player2: 'p2', player2flat: 'p2', player2special: 'p2s', player2border: 'p2b', player2road: 'p2r' };
  for (const [k, name] of Object.entries(pairs)) assert.equal(THEME.colors[k].toLowerCase(), v(name), k);
});

test("the page's board colours (style.css: the Rush turn stone and its square) are the board's", () => {
  for (const [page, board] of [['board-ground', 'b1'], ['p1', 'p1'], ['p1-edge', 'p1b'], ['p2', 'p2'], ['p2-edge', 'p2b']]) assert.equal(v(page, style), v(board), page);
});

test('share picture: board.css colours and measures', () => {
  for (const k of ['b1', 'b3', 'thread', 'pri', 'p1', 'p1s', 'p1b', 'p2', 'p2s', 'p2b']) assert.deepEqual(C[k], hex(v(k)), k);
  const pc = (x) => +(x * 100).toFixed(2);
  assert.match(css, new RegExp(`\\.tb-cur \\{ inset: ${pc(LAST.inset)}%; border-radius: ${pc(LAST.radius)}%;`));
  assert.match(css, new RegExp(`color-mix\\(in srgb, var\\(--pri\\) ${pc(LAST.wash)}%, transparent\\); box-shadow: inset 0 0 0 ${String(LAST.ring).replace(/^0/, '')}em var\\(--pri\\)`));
  assert.match(css, new RegExp(`\\.tb-sq\\.c \\.tb-cur \\{ opacity: ${String(LAST.faint).replace(/^0/, '')}; outline: ${String(LAST.dashed).replace(/^0/, '')}em dashed var\\(--pri\\); outline-offset: -${String(LAST.offset).replace(/^0/, '')}em;`));
  assert.equal(SEAM.dash, 0.055); assert.equal(SEAM.period, 0.1); assert.equal(SEAM.alpha, op('.tb-sq::before'));
});

test('every stone and mark reads on the cloth', () => {
  const cloth = hex(v('b1')), at = (c, a) => ratio(over(cloth, hex(v(c)), a), cloth);
  const r = (c, min, what) => { const x = ratio(hex(v(c)), cloth); assert.ok(x >= min, `${what}: ${x.toFixed(2)}`); };
  r('p1', 4.5, 'a white stone'); r('p2', 2.8, 'a black stone'); r('p2s', 2.5, "Black's walls and capstone");
  assert.ok(ratio(hex(v('p2s')), hex(v('p2'))) <= 1.2, "Black's walls and caps a shade off its flats, not a lighter grey");
  r('pri', 4, "the last move's thread"); r('hint', 3.3, "the hint's ring");
  assert.match(css, /--lab: #[0-9a-f]{6};/i, 'coordinates opaque'); r('lab', 3.4, 'coordinates');
  assert.match(css, /\.tb-lab \{[^}]*color: var\(--lab\);/, 'the coordinates are drawn in --lab');
  // outlines: they separate stacked stones of one colour (and the stones fanned in the tray); Black's stays near the
  // cloth's own luminance so a black stone's edge is no halo
  const s1 = ratio(hex(v('p1b')), hex(v('p1'))), s2 = ratio(hex(v('p2b')), hex(v('p2'))), s2s = ratio(hex(v('p2b')), hex(v('p2s')));
  assert.ok(s1 >= 2.4 && s2 >= 3 && s2s >= 2.5, `outlines on their stones: ${s1.toFixed(2)} / ${s2.toFixed(2)} / ${s2s.toFixed(2)}`);
  assert.ok(ratio(hex(v('p2b')), cloth) <= 1.3, "Black's outline is no halo on the cloth");
  // counts on a stone: dark on White, light on Black (--td / --tl carry alpha)
  const a8 = (name) => { const m = css.match(new RegExp(`--${name}: #([0-9a-f]{6})([0-9a-f]{2});`, 'i')); assert.ok(m, `--${name}`); return [hex('#' + m[1]), parseInt(m[2], 16) / 255]; };
  const [tl, tla] = a8('tl'), [td, tda] = a8('td');
  assert.ok(ratio(over(hex(v('p2')), tl, tla), hex(v('p2'))) >= 4.5 && ratio(over(hex(v('p1')), td, tda), hex(v('p1'))) >= 4.5, 'counts on stones');
  assert.match(css, /\.tb-cnt \{[^}]*color: var\(--td\);/); assert.match(css, /\.tb-st\.p2 \+ \.tb-cnt \{ color: var\(--tl\); \}/);
  // stones on the square moved to (the thread's 14% wash)
  const wash = over(cloth, hex(v('pri')), LAST.wash);
  assert.ok(ratio(hex(v('p1')), wash) >= 3.9 && ratio(hex(v('p2')), wash) >= 3.3, 'stones on the wash');
  assert.ok(at('pri', LAST.faint) >= 2.6, "the source square's thread, faint (dashed, at .65): " + at('pri', LAST.faint).toFixed(2));
  // marks at board.css's opacities
  const sel1 = op('.tb-sq.sel .tb-pl'), sel2 = op('.tb.t2 .tb-sq.sel .tb-pl'), orig1 = op('.tb-sq.sel.selp .tb-pl'), orig2 = op('.tb.t2 .tb-sq.sel.selp .tb-pl');
  assert.ok(at('p1r', sel1) >= 1.7 && at('p2r', sel2) >= 1.6, `selection ${at('p1r', sel1).toFixed(2)} / ${at('p2r', sel2).toFixed(2)}`);
  assert.ok(at('p1r', orig1) >= 1.3 && at('p2r', orig2) >= 1.3, `the origin once left ${at('p1r', orig1).toFixed(2)} / ${at('p2r', orig2).toFixed(2)}`);
  assert.ok(at('hint', op('.tb-sq.s .tb-pl')) >= 1.6, 'the hint fill');
  // a selection's ring, in the mover's colour at full strength (the stones left on the square can't hide it)
  assert.match(css, /\n\.tb-sq\.sel:not\(\.selp\):not\(\.s\)::after \{ content: ''; box-shadow: inset 0 0 0 \.03em var\(--p1r\); \}/, "White's selection ring");
  assert.match(css, /\n\.tb\.t2 \.tb-sq\.sel:not\(\.selp\):not\(\.s\)::after \{ box-shadow: inset 0 0 0 \.03em var\(--p2r\); \}/, "Black's selection ring");
  r('p1r', 4.5, "White's ring"); r('p2r', 2.8, "Black's ring");
  // winning roads: White's at .8; Black's at full strength with a cream edge along it
  assert.ok(at('p1r', op('.tb-rd > i.rd')) >= 3.5, "White's winning road");
  assert.ok(op('.tb-sq.o2 .tb-rd > i.rd') === 1 && at('p2r', 1) >= 2.8, "Black's winning road, full strength");
  const edge = +css.match(/\.tb-sq\.o2 \.tb-rd > i\.rd \{[^}]*--re: color-mix\(in srgb, var\(--p1\) (\d+)%, transparent\)/)[1] / 100;
  assert.ok(at('p1', edge) >= 2.8 && ratio(over(cloth, hex(v('p1')), edge), hex(v('p2r'))) >= 4.5, "Black's road's edge, on the cloth and on the road");
  for (const d of ['m', 'n', 's', 'e', 'w']) assert.match(css, new RegExp(`\\.tb-sq\\.o2 \\.tb-rd > [^{]*\\.${d}\\.rd[^{]*\\{ box-shadow: [^}]*var\\(--re\\)`), `the edge on ${d}`);
  // a flat win: a tint each side's stones still stand off
  const fw = op('.tb-sq.fw .tb-pl'), tint = (c) => over(cloth, hex(v(c)), fw);
  assert.ok(ratio(tint('p1r'), cloth) >= 1.6 && ratio(tint('p2r'), cloth) >= 1.35, 'a flat win\'s tint');
  assert.ok(ratio(tint('p1r'), hex(v('p1'))) >= 2.5 && ratio(tint('p2r'), hex(v('p2'))) >= 1.9, 'stones on their own flat-win tint');
  assert.ok(at('p1', op('.tb-ov .gh.p1')) >= 3.5 && at('p2', op('.tb-ov .gh.p2')) >= 1.9, 'faint stones');
  // the analysis overlay and the Rush pictures' marks
  // (the analysis arrows: every line's mark at 3:1 or better on the cloth, line 1 at 3.5, the selected line as strong;
  // across a cream stone the dark casing under each mark carries it: 4.5:1 or better against White's stone, and the
  // mark against its own casing 4.5:1 too)
  assert.ok(at('eng', op('.tb-ov .best')) >= 3.5, 'line 1'); assert.ok(at('eng', op('.tb-ov .alt')) >= 3.5, 'the selected line');
  assert.ok(at('yours', op('.tb-ov .yours')) >= 3.4, 'yours');
  assert.ok(at('threat', op('.tb-ov .threat')) >= 3, 'threats');
  const ca = +css.match(/\.tb-ov \.cs \{[^}]*stroke: var\(--case\); stroke-opacity: ([.\d]+);/)[1];
  for (const bg of [cloth, hex(v('p1'))]) {
    const cased = over(bg, hex(v('case')), ca);
    assert.ok(ratio(cased, hex(v('p1'))) >= 4.5, 'the casing against a cream stone');
    for (const c of ['eng', 'yours', 'threat']) assert.ok(ratio(hex(v(c)), cased) >= 4.5, `${c} on its casing`);
  }
  // line 1 solid, the selected line dashed (as yours): which arrow is the engine's best reads without comparing widths
  assert.match(css, /\.tb-ov \.alt \.rg, \.tb-ov \.alt \.sf \{ stroke-dasharray:/, 'the selected line dashed');
  assert.doesNotMatch(css, /\.tb-ov \.best [^{]*\{[^}]*dasharray/, 'line 1 solid');
  assert.ok(at('mk-good', op('.tb-ov .good')) >= 4 && at('mk-bad', op('.tb-ov .bad')) >= 3, 'the Rush marks');
  // the analysis count discs: dark figures and a dark ring on a light disc of the line's colour
  assert.match(css, /\.tb-ov \.dc, \.tb-ov \.dd \{ stroke: var\(--p2\);/, "the discs' ring");
  assert.match(css, /\.tb-ov text \{ fill: var\(--p2\);/, "the discs' figures");
  for (const c of ['eng', 'yours', 'threat']) assert.ok(ratio(hex(v('p2')), hex(v(c))) >= 4.5, `counts on a ${c} disc`);
  assert.equal(v('mk-bad'), hex2(style.match(/\.rush-key \.k\.bad \{ background: (#[0-9a-f]{6})/)[1]), "the key's red is the mark's");
  assert.equal(v('mk-good'), hex2(style.match(/\.rush-key \.k\.good \{ background: (#[0-9a-f]{6})/)[1]), "the key's green is the mark's");
});
function hex2(h) { return h.toLowerCase(); }

// PNG (8-bit RGB, filter 0 rows, as share.js writes it) to rows of pixels
function pixels(png) {
  let o = 8, idat = [], w = 0;
  while (o < png.length) {
    const len = png.readUInt32BE(o), type = png.toString('latin1', o + 4, o + 8), data = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') w = data.readUInt32BE(0);
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 3 + 1;
  return (x, y) => [...raw.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)];
}
test('share picture: the cloth, stitches between squares (none on the edge), the last move stitched round', () => {
  const p = { size: 6, tps: 'x6/x6/x6/x6/x6/x5,1 2 1', meta: JSON.stringify({ lastMove: 'f1' }) };
  const px = pixels(boardPng(p, 600)), q = 100, near = (a, b, d = 2) => a.every((x, i) => Math.abs(x - b[i]) <= d);
  assert.ok(near(px(150, 150), C.b1), 'b5, inside: the cloth ' + px(150, 150));
  const seam = over(C.b1, C.thread, SEAM.alpha).map(Math.round);
  assert.ok(near(px(100, 102), seam, 6), 'between a5 and b5, a stitch: ' + px(100, 102));
  assert.ok(near(px(100, 108), C.b1), '…and the gap between two stitches');
  assert.ok(near(px(0, 102), C.b1) && near(px(102, 0), C.b1), "no stitch on the board's edge");
  for (const [x, y, side] of [[9, 50, 'left'], [50, 9, 'top'], [91, 50, 'right'], [50, 91, 'bottom']])
    assert.ok(near(px(5 * q + x, 5 * q + y), C.pri, 6), `f1's thread, ${side}: ` + px(5 * q + x, 5 * q + y));
  assert.ok(near(px(5 * q + 15, 5 * q + 15), over(C.b1, C.pri, LAST.wash).map(Math.round)), "f1's wash, off the stone");
  assert.ok(near(px(5 * q + 3, 5 * q + 50), C.b1), 'the thread sits inside the square');
});

if (fails) { console.log(`${fails} failed`); process.exit(1); }
