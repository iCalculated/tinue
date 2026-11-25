// The Rush end screen's pictures in the player's board theme (public/rush-theme.js, rush-look.js) against what PTN
// Ninja's real embed drew for the same themes: scripts/ninja-themes.json, recorded from ptn.ninja on 2026-11-23 (each
// built-in theme's GET_THEME answer after SET_UI {themeID}, and the computed colours of its squares, stones and
// coordinates; the same for tinue felt, tinue classic and pasted themes, some missing colours PTN Ninja then derives).
// The pictures' custom properties for felt, classic, a pasted theme and every built-in one; checkered or not; the
// colours PTN Ninja derives; tinue's marks and the last move at 3:1 or better on every square of all 20 themes (the worst listed); the
// squares' classes under each of the board's orientations; no theme known: felt.   node scripts/test-rush-theme.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as T from '../public/rush-theme.js';
import { picture, pictureHTML } from '../public/rush-look.js';
import { parseLook, LEGACY } from '../public/ninja-look.js';
import * as R from '../public/rush-rules.js';

const FX = JSON.parse(fs.readFileSync(new URL('./ninja-themes.json', import.meta.url), 'utf8'));
const SAMPLE = JSON.parse(fs.readFileSync(new URL('./rush-sym-sample.json', import.meta.url), 'utf8'));
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const hex6 = (c) => T.hex(T.over(T.parse(c), { r: 0, g: 0, b: 0, a: 1 })).slice(0, 7);
// a colour as the properties write it (#hex or rgba()) or as recorded
const P = (c) => { const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(c); return m ? { r: +m[1], g: +m[2], b: +m[3], a: +m[4] } : T.parse(c); };
const same = (a, b, what) => assert.equal(T.hex(P(a)).slice(0, 7), T.hex(P(b)).slice(0, 7), what);
// a recorded theme: what to pass (a built-in one: its GET_THEME answer; any other: what was sent, through the paste box)
const PLUM = parseLook(JSON.stringify(FX.custom['custom-full'].sent)).look.theme;
const THEMES = { 'tinue-classic': LEGACY, custom: PLUM, ...Object.fromEntries(Object.entries(FX.builtin).map(([k, v]) => [k, v.theme])) };
const OBS = { 'tinue-classic': FX.custom.legacy.observed, custom: FX.custom['custom-full'].observed, ...Object.fromEntries(Object.entries(FX.builtin).map(([k, v]) => [k, v.observed])) };

test('tinue felt, or no theme at all: no properties (board.css\'s felt stays)', () => {
  assert.equal(T.pictureLook(null), null);
  assert.equal(T.pictureLook(undefined), null);
  // (felt comes as no theme at all; a pasted theme is drawn as pasted even when its id is felt's, as exported from
  // PTN Ninja's editor after starting from tinue's board)
  const mine = { id: 'tinue', name: 'mine', boardStyle: 'blank', boardChecker: true, colors: { primary: '#ff0000', secondary: '#ffffff', ui: '#ffffff', player1: '#ff4040', player2: '#2040ff', board1: '#ffffff', board2: '#202020' } };
  const v = T.pictureLook(parseLook(JSON.stringify(mine)).look.theme, 6)?.vars;
  assert.ok(v, 'a pasted theme with id tinue: its own colours');
  assert.equal(v['--rt-base-d'], '#202020'); assert.equal(v['--rt-p2'], T.hex(T.resolve(mine).C.player2flat));
  assert.equal(T.pictureLook({ id: 'x', colors: { primary: '#fff' } }), null, 'unusable: felt');
});

test('every theme\'s properties: board, squares, stones and outlines as PTN Ninja drew them (classic, a pasted one, all 18 built-in)', () => {
  assert.equal(Object.keys(FX.builtin).length, 18);
  for (const [name, t] of Object.entries(THEMES)) {
    const v = T.pictureLook(t, 6).vars, o = OBS[name];
    // stones: a flat, a wall, and their outlines, each side
    same(v['--rt-p1'], o.stones.p1.bg, name + ' white flat'); same(v['--rt-p2'], o.stones.p2.bg, name + ' black flat');
    same(v['--rt-p1s'], o.stones['p1 S'].bg, name + ' white wall'); same(v['--rt-p2s'], o.stones['p2 C'].bg, name + ' black capstone');
    same(v['--rt-p1b'], o.stones.p1.border, name + ' white outline'); same(v['--rt-p2b'], o.stones.p2.border, name + ' black outline');
    // the squares: a1 (dark) and a2 (light), base and tile (transparent: the board shows through)
    for (const [sq, k] of [['a1', 'd'], ['a2', 'l']]) {
      const s = o.squares[sq], tile = v['--rt-tile-' + k];
      if (s.tile !== '#00000000') same(tile, T.hex(T.over(P(s.tile), P(v['--rt-base-' + k]))), `${name} ${sq} tile`); // (see-through ones over the base) else assert.equal(tile, 'transparent', `${name} ${sq}: no tile`);
      if (s.bg !== '#00000000') same(v['--rt-base-' + k], T.hex(T.over(P(s.bg), P(v['--rt-b1']))), `${name} ${sq} base`);
      else same(v['--rt-base-' + k], v['--rt-b1'], `${name} ${sq}: the board under it`);
    }
    // the board (see-through ones over the page's colour, as on the real embed: the pixels matched there)
    if (!/^#[0-9a-f]{6}$/.test(o.board)) continue;
    same(v['--rt-b1'], o.board, name + ' board');
  }
});

test('rings: each band\'s tint as PTN Ninja put it (its ring and the rings\' opacity), from the edge or from the centre', () => {
  for (const name of ['aaron', 'aer', 'aqua', 'atlas', 'bubbletron']) {
    const v = T.pictureLook(THEMES[name], 6).vars, o = OBS[name], ring = o.squares.a1.ring;
    // a1 is in band 0 (outermost), c3 in the middle band
    assert.ok(ring, name);
    const want = T.parse(ring.bg); want.a *= ring.op;
    assert.equal(v['--rt-ring-0'], T.css(want), name + ' band 0');
    const cls = (sq) => 'ring' + (THEMES[name].fromCenter ? 3 - T.bandOf(sq, 6) : T.bandOf(sq, 6) + 1);
    assert.equal(ring.cls.split(' ').at(-1), cls(0), name + ': a1\'s ring'); assert.equal(o.c3ring.split(' ').at(-1), cls(14), name + ': c3\'s ring');
  }
  for (const name of ['zen', 'paper', 'classic', 'aether']) assert.ok([0, 1, 2].every((k) => T.pictureLook(THEMES[name], 6).vars['--rt-ring-' + k] === 'transparent'), name + ': no rings');
});

test('checkered or not: the dark squares swap base and tile on a checkered board, and are the light ones\' on another', () => {
  for (const name of ['zen', 'aaron', 'aqua', 'terra', 'classic', 'tinue-classic', 'custom']) {
    const t = THEMES[name];
    for (const checker of [true, false]) {
      const v = T.pictureLook({ ...t, boardChecker: checker }, 6).vars;
      if (!checker) { assert.equal(v['--rt-base-d'], v['--rt-base-l'], name); assert.equal(v['--rt-tile-d'], v['--rt-tile-l'], name); assert.equal(v['--rt-lab-d'], v['--rt-lab-l'], name); }
      else assert.ok(v['--rt-base-d'] !== v['--rt-base-l'] || v['--rt-tile-d'] !== v['--rt-tile-l'], name + ': the two colours differ');
    }
  }
  // blank: no tile; grid and diamonds: the tile inset and rounded per style
  assert.deepEqual(['blank', 'grid1', 'grid2', 'grid3', 'diamonds1', 'diamonds3'].map((s) => { const v = T.pictureLook({ ...THEMES.zen, boardStyle: s }, 6).vars; return [v['--rt-gap'], v['--rt-rad'], v['--rt-tile-l'] === 'transparent']; }),
    [['0%', '0%', true], ['1%', '0%', false], ['3%', '5%', false], ['6%', '15%', false], ['0%', '10%', false], ['0%', '50%', false]]);
});

test('a pasted theme missing colours: derived as PTN Ninja derived them (board from secondary, stones from each player\'s colour)', () => {
  for (const name of ['custom-min', 'custom-board', 'custom-gridnc', 'custom-A', 'custom-B', 'custom-D']) {
    const { sent, observed: o } = FX.custom[name], Rz = T.resolve(sent), C = Rz.C;
    for (const [k, s] of [['player1flat', 'p1'], ['player1special', 'p1 S'], ['player2flat', 'p2'], ['player2special', 'p2 S']]) same(T.hex(C[k]), o.stones[s].bg, `${name} ${k}`);
    same(T.hex(C.player1border), o.stones.p1.border, name + ' player1border'); same(T.hex(C.player2border), o.stones.p2.border, name + ' player2border');
    same(T.hex(T.boardOf(Rz, 6).board), o.board, name + ' board1');
    for (const sq of ['a1', 'a2']) { const t = o.squares[sq].tile; if (t !== '#00000000') { const B = T.boardOf(Rz, 6), s = sq === 'a1' && Rz.checker ? B.d : B.l; same(T.hex(s.tile), t, `${name} ${sq} tile`); } }
  }
  // coordinates: the theme's text colour by the square's darkness; one PTN Ninja leaves out is tinue's readable one
  const C = T.pictureLook(FX.custom['custom-C'].sent, 6).vars;
  assert.equal(C['--rt-lab-l'], '#0000ff', 'its textDark on the light squares');
  assert.equal(C['--rt-lab-d'], 'rgba(250,250,250,0.804)', 'its textLight (red) reads 1.6:1 on the dark green: a readable light instead');
  const B = T.pictureLook(FX.custom['custom-B'].sent, 6).vars;
  assert.equal(B['--rt-lab-l'], 'rgba(33,33,33,0.804)', 'no textDark: a readable dark (PTN Ninja draws it white on the light green)');
});

test('coordinates read on their squares (3:1) in every theme', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    const v = T.pictureLook(t, 6).vars;
    for (const k of ['l', 'd']) {
      const on = P(v['--rt-tile-' + k] === 'transparent' ? v['--rt-base-' + k] : v['--rt-tile-' + k]);
      assert.ok(T.contrast(T.over(P(v['--rt-lab-' + k]), on), on) >= 3, `${name} ${k}`);
    }
  }
});

test('tinue\'s marks: 3:1 or better on every square of all 20 themes (the mark, or its casing where the mark alone can\'t); felt\'s own shades kept where they read', () => {
  const all = { felt: { ...FX.custom.felt.sent, id: 'felt-as-theme' }, ...THEMES }, rows = [];
  assert.equal(Object.keys(all).length, 21); // (20 + a pasted one)
  for (const [name, t] of Object.entries(all)) {
    const look = T.pictureLook(t, 6), B = T.boardOf(T.resolve(t), 6);
    for (const role of ['good', 'bad']) {
      const m = look.marks[role];
      const edge = m.casing ? Math.max(m.min, m.casing.min) : m.min;
      assert.ok(Math.abs(edge - m.floor) < 1e-9);
      assert.ok(m.floor >= Math.min(T.FLOOR, T.best(B.seen)) - 1e-9, `${name} ${role}: ${m.floor}`);
      if (m.casing) assert.ok(m.casing.onMark >= T.FLOOR, `${name} ${role}: the casing stands off the mark`);
      assert.equal(look.vars['--rt-' + role], m.color); assert.equal(look.vars['--rt-case-' + role], m.casing ? m.casing.color : 'transparent');
      rows.push([m.floor, name, role, m.color, m.casing?.color]);
    }
  }
  assert.ok(rows.every((r) => r[0] >= T.FLOOR), 'every theme allows 3:1, and gets it');
  assert.equal(T.pictureLook(all.felt, 6).marks.good.color, T.FELT_MARKS.good, 'felt\'s green as before');
  assert.equal(T.pictureLook(all.felt, 6).marks.bad.color, T.FELT_MARKS.bad, 'felt\'s red as before');
  rows.sort((a, b) => a[0] - b[0]);
  console.log('   worst: ' + rows.slice(0, 4).map((r) => `${r[1]} ${r[2]} ${r[3]}${r[4] ? ' on ' + r[4] : ''} ${r[0].toFixed(2)}:1`).join(', '));
});

test('the last move\'s thread: the theme\'s primary where it reads at 3:1 on every square, else its hue at the nearest lightness that does', () => {
  // (the loud colours of a pasted theme too, where the marks need black or white casings to reach what the board allows)
  const neon = parseLook(JSON.stringify({ id: 'neon', name: 'neon', boardStyle: 'diamonds2', boardChecker: true, rings: 3, vars: { 'rings-opacity': 0.6 }, colors: { primary: '#ff0000', secondary: '#00ff00', ui: '#ff00ff', player1: '#00ffff', player2: '#ffff00', board1: '#00ff00', board2: '#ff00ff', ring1: '#ff0000ff', ring2: '#0000ffff', ring3: '#ffff00ff' } })).look.theme;
  const all = { felt: { ...FX.custom.felt.sent, id: 'felt-as-theme' }, ...THEMES, neon }, rows = [];
  for (const [name, t] of Object.entries(all)) {
    const look = T.pictureLook(t, 6), B = T.boardOf(T.resolve(t), 6), want = Math.min(T.FLOOR, T.best(B.seen)) - 1e-9;
    const pri = P(look.vars['--rt-pri']), shown = Math.min(...B.seen.map((s) => T.contrast(T.over(pri, s), s)));
    assert.ok(shown >= want, `${name} last move: ${shown.toFixed(2)}`);
    for (const role of ['good', 'bad']) assert.ok(look.marks[role].floor >= want, `${name} ${role}: ${look.marks[role].floor}`);
    rows.push([shown, name, look.vars['--rt-pri']]);
  }
  assert.equal(T.pictureLook(all.felt, 6).vars['--rt-pri'], '#e3d3a1', 'felt\'s straw as it is');
  assert.equal(T.pictureLook(THEMES.ignis, 6).vars['--rt-pri'], T.hex(T.parse(THEMES.ignis.colors.primary)), 'a primary that reads: kept');
  const h = (c) => { const x = P(c), mx = Math.max(x.r, x.g, x.b), mn = Math.min(x.r, x.g, x.b); return mx === mn ? null : mx === x.r ? ((x.g - x.b) / (mx - mn) + 6) % 6 : mx === x.g ? (x.b - x.r) / (mx - mn) + 2 : (x.r - x.g) / (mx - mn) + 4; };
  for (const name of ['zen', 'aqua', 'classic', 'tinue-classic']) assert.ok(Math.abs(h(T.pictureLook(THEMES[name], 6).vars['--rt-pri']) - h(T.hex(T.resolve(THEMES[name]).C.primary))) < 0.15, name + ': the primary\'s hue');
  rows.sort((a, b) => a[0] - b[0]);
  console.log('   worst: ' + rows.slice(0, 3).map((r) => `${r[1]} ${r[2]} ${r[0].toFixed(2)}:1`).join(', '));
});

test('the squares\' classes (dark, band) follow the logical square under each of PTN Ninja\'s 8 orientations', () => {
  const p = SAMPLE[0], v = R.review(p, { solved: true });
  const MS = [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, -1, 0], [0, -1, -1, 0], [-1, 0, 0, -1], [1, 0, 0, -1], [0, -1, 1, 0], [0, 1, 1, 0]];
  for (const M of MS) {
    const pic = picture(v, M), html = pictureHTML(pic), cls = [...html.matchAll(/class="tb-sq ([^"]*)"/g)].map((x) => x[1].split(' '));
    assert.equal(cls.length, 36);
    pic.squares.forEach((s, i) => {
      assert.equal(cls[i].includes('d'), T.darkSq(s.sq, 6), `${M}: ${s.name} dark`);
      assert.ok(cls[i].includes('k' + T.bandOf(s.sq, 6)), `${M}: ${s.name} band`);
      const f = 'abcdef'.indexOf(s.name[0]), r = +s.name[1] - 1;
      assert.equal(T.darkSq(s.sq, 6), (f + r) % 2 === 0, 'a1 dark, as PTN Ninja\'s .square.dark');
    });
  }
});

test('a theme\'s properties don\'t depend on the picture: one set for the whole end screen, so a late theme recolours without redrawing', () => {
  const a = T.pictureLook(THEMES.zen, 6), b = T.pictureLook(THEMES.zen, 6);
  assert.deepEqual(a, b);
  assert.ok(Object.keys(a.vars).every((k) => k.startsWith('--rt-')));
});

test('the marks\' casings are drawn under them in every picture, hidden on the felt (board.css) and shown by a theme (style.css .rt)', () => {
  const p = SAMPLE[1], g = R.startGame(p), tree = p.tree === 'win' ? {} : p.tree;
  const wrong = g.legalMoves().map((m) => g.moveToPTN(m)).find((m) => !(m in tree) && /^[a-h]\d$/.test(m));
  const html = pictureHTML(picture(R.review(p, { solved: false, wrong, at: [] }), [1, 0, 0, 1]));
  for (const role of ['bad', 'good']) assert.match(html, new RegExp(`<g class="sh ${role}"><[a-z]+ class="cs"`), role);
  const board = fs.readFileSync(new URL('../public/board.css', import.meta.url), 'utf8'), style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(board, /\.tb-ov \.good \.cs, \.tb-ov \.bad \.cs \{ display: none; \}/);
  assert.match(style, /\.rt \.rush-pic \.tb-ov \.good \.cs \{ display: inline; stroke: var\(--rt-case-good\)/);
});

console.log(`test-rush-theme: all ${n} passed`);
