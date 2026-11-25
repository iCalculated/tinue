// The PTN Ninja look string (public/ninja-look.js): what a paste gives, what is stored, the iframe's address (and
// index.html's early copy of it), and lz-string's decompress half.   node scripts/test-ninja-look.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LOOK, KEPT, THEMES, MAX, parseLook, encodeLook, cleanLook, lookUi, frameParams, lookReport, cleanTheme, frameBox, themeOf, withTheme, themeName, showLook, LEGACY, NO_LOOK_LINK } from '../public/ninja-look.js';
import { compressToEncodedURIComponent as lz, decompressFromEncodedURIComponent as unlz } from '../public/vendor/lz-string.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const root = new URL('..', import.meta.url).pathname;
const html = fs.readFileSync(root + 'public/index.html', 'utf8');
const ninja = fs.readFileSync(root + 'public/ninja.js', 'utf8');

// A custom theme as PTN Ninja exports one (the shape of its built-in "classic", other colours).
const CUSTOM = { id: 'mine', name: 'Mine', boardStyle: 'grid2', boardChecker: true, rings: 2, vars: { 'piece-border-width': 1, 'rings-opacity': 0.25 },
  colors: { primary: '#8bc34a', secondary: '#607d8b', ui: '#263238', accent: '#202a2f', panel: '#78909cc0', board1: '#90a4ae', board2: '#8a9faa',
    board3: '#78909c', player1: '#cfd8dc', player2: '#263238', textLight: '#fafafacd', textDark: '#212121cd', umbra: '#00000033' } };

test('lz-string decompress: round trips with the compressor, a real ptn.ninja theme id, junk gives null, output is capped', () => {
  for (const s of ['zen', 'classic', JSON.stringify(CUSTOM), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'é and ☃ past 255', 'x'.repeat(5000)])
    assert.equal(unlz(lz(s)), s);
  assert.equal(unlz('F4UwdkA'), 'zen', 'the id as lz-string 1.5.0 writes it');
  for (const junk of ['', '!!!!', 'G4Q', 'zen', 'classic', '$$$$$$$$', null, 7]) { const v = unlz(junk); assert.ok(v === null || typeof v === 'string'); }
  assert.equal(unlz(lz('ab'.repeat(30000))), null, 'past 20000 characters: refused');
  assert.equal(unlz(lz('ab'.repeat(30000)), 100000), 'ab'.repeat(30000));
});

test('lz-string.js: its header names both halves it exports and the test that checks them (this one)', () => {
  const src = fs.readFileSync(root + 'public/vendor/lz-string.js', 'utf8'), head = src.split('\n').slice(0, 4).join('\n');
  const exported = [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exported, ['compressToEncodedURIComponent', 'decompressFromEncodedURIComponent']);
  for (const f of exported) assert.ok(head.includes(f), f + ' named in the header');
  assert.doesNotMatch(head, /half\s*(\/\/\s*)?only/, 'not "the compress half only"');
  for (const [, t] of head.matchAll(/scripts\/([\w-]+\.mjs)/g)) assert.match(fs.readFileSync(root + 'scripts/' + t, 'utf8'), /vendor\/lz-string\.js/, t + ' imports it');
  assert.match(head, /scripts\/test-ninja-look\.mjs/);
});

// A real PTN Ninja game link, made by ptn.ninja itself (a 6x6 game).
const LINK = 'NoZQlgLgpgBARABQDYEMCeAVFBrAdAYwHsBbOAXQChgBRANygDsJ4B5BpMB2ZdcqgERTR4AJgAMIgCy4xAZlwiAHH2A80UAE4BGeAHEArlADOEAGyyRKtZpHws2CGHxgUDAEKEIKgMJJC+bFExAC4xGABqWTEVACVjfSRmOAAxAFpoylAwAC9YOFMVZNQII3gonxQAB1K4LRUWSsZOAHN4IwB3Kr4KLVwYFB0AMx0RPqhZGG8AE0kYeRh8CamJ6Rgp23xZgFY+-FsAI1nTMdsUWYB2Pu8oWagtmEU+wfup+4BOMdN+2y0xPpQJvsJlpejAoDplgA+GBaUYLWQAHn6klSMPmIiBSJQInCMNWICBMC2APCIlhMJ2MH2thE41RWmOax02Jhl36E2x0K0jypslRyxhHzm1PC5OWqPEuxGZwloOpMBE6wlcPWyIV8xZA1xUj6mOREspBImxL5FgVjOpSJEWoVbIJtlM2IlPIJEImIiF+y0SNdcz+MEdWlFIPJsimQbmoJA4bWXwsfXDuJjsnm4zmUBEqNkqwzYK2uNklMGXyhc0ZgwmdzmbMGNKgpmhsh59Zgg1msiFAtpfJgkn9abSYiAA';
test('lz-string: a real ptn.ninja link decompresses to a 6x6 PTN and compresses back byte for byte', () => {
  const ptn = unlz(LINK);
  assert.ok(ptn && ptn.includes('[Size "6"]'), ptn);
  assert.equal(lz(ptn), LINK);
});

test('just the settings, with or without the leading &; booleans, the 3D perspective, a built-in theme', () => {
  for (const s of ['&axisLabels=false&theme=zen', 'axisLabels=false&theme=zen', '  &axisLabels=false&theme=zen  ']) {
    const r = parseLook(s);
    assert.deepEqual(r.look, { axisLabels: false, theme: 'zen' }, s);
    assert.deepEqual(r.applied, ['axisLabels', 'theme']);
    assert.equal(r.error, '');
  }
  assert.deepEqual(parseLook('&board3D=true&perspective=7&stackCounts=true').look, { board3D: true, perspective: 7, stackCounts: true });
  assert.deepEqual(parseLook('&themeID=luna').look, { theme: 'luna' }, 'themeID is the theme too');
  assert.deepEqual(parseLook('&theme=' + lz('terra')).look, { theme: 'terra' }, 'an id compressed, as ptn.ninja\'s Share writes it');
});

test('a full ptn.ninja link: the game in it is dropped without a word, the look kept', () => {
  const game = lz('[Size "6"]\n\n1. a1 f6\n2. c3 d4');
  for (const link of [`https://ptn.ninja/${game}&name=${lz('My game')}&ply=3!&targetBranch=${lz('x')}&axisLabels=false&theme=${lz('zen')}&showRoads=false`,
    `ptn.ninja/${game}&axisLabels=false&theme=zen&showRoads=false`, `HTTPS://www.ptn.ninja/${game}&axisLabels=false&theme=zen&showRoads=false`,
    `https://ptn.ninja/#/${game}&axisLabels=false&theme=zen&showRoads=false`]) {
    const r = parseLook(link);
    assert.deepEqual(r.look, { axisLabels: false, theme: 'zen' }, link);
    assert.deepEqual(r.kept, ['showRoads'], link);
    assert.deepEqual(r.unknown, [], link);
  }
  assert.deepEqual(parseLook(`https://ptn.ninja/${game}`).applied, [], 'a link with no settings: nothing');
  assert.deepEqual(parseLook(`${game}&axisLabels=false`).look, { axisLabels: false }, 'a game\'s PTN with settings after it');
});

test('what tinue keeps: input, navigation, panels, roads, square highlights, the tray; each named, never applied', () => {
  const r = parseLook('&disableBoard=false&showPTN=true&showRoads=true&highlightSquares=false&unplayedPieces=false&animateBoard=false&notifyGame=true&axisLabels=false');
  assert.deepEqual(r.look, { axisLabels: false });
  assert.deepEqual(r.kept, ['disableBoard', 'showPTN', 'showRoads', 'highlightSquares', 'unplayedPieces', 'animateBoard', 'notifyGame']);
  // the tables don't overlap, and ninja.js's own embed settings are all tinue's (except the few a look may change)
  for (const k of Object.keys(LOOK)) assert.ok(!KEPT.has(k), k);
  const ui = ninja.match(/const UI = \{([\s\S]*?)\};/)[1];
  for (const [, k] of ui.matchAll(/(\w+):/g)) assert.ok(k === 'theme' || KEPT.has(k) || k in LOOK, 'ninja.js UI key ' + k);
  for (const k of ['moveNumber', 'flatCounts', 'turnIndicator', 'stackCounts']) assert.ok(k in LOOK, k + ': ninja.js sets it, a look may change it');
});

test('junk and wrong types: nothing applied, each named; a sentence for the whole paste where it is no use at all', () => {
  const r = parseLook('&axisLabels=yes&perspective=11&perspective2=3&stackCounts=1&theme=nope&board3D=true');
  assert.deepEqual(r.look, { board3D: true });
  assert.deepEqual(r.bad, ['axisLabels', 'perspective', 'stackCounts', 'theme']);
  assert.deepEqual(r.unknown, ['perspective2']);
  assert.deepEqual(parseLook('hello world').applied, []);
  assert.equal(parseLook('').error, '');
  assert.equal(parseLook(null).applied.length, 0);
  assert.match(lookReport(parseLook('hello world')), /^No PTN Ninja look settings found in that, so nothing changed\.$/);
  assert.equal(lookReport(parseLook('&axisLabels=false&theme=zen&showRoads=true&foo=1')),
    'Using axis labels off, theme zen. Left out, because tinue sets these itself: showRoads. Not PTN Ninja board settings: foo.');
});

test('hostile input: other sites, javascript:, data:, huge, HTML, duplicate keys, prototype names', () => {
  for (const s of ['javascript:alert(1)//&axisLabels=false', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>&axisLabels=false', 'https://evil.example/&axisLabels=false',
    'https://ptn.ninja.evil.example/&axisLabels=false', 'https://evil.example/ptn.ninja/&axisLabels=false', '//evil.example/&axisLabels=false',
    'https://user:pw@ptn.ninja/&axisLabels=false', 'https://ptn.ninja:8080/&axisLabels=false', 'evil.example/x&axisLabels=false']) {
    const r = parseLook(s);
    assert.deepEqual(r.look, {}, s);
    assert.ok(r.error, s);
  }
  assert.equal(parseLook('&axisLabels=false'.repeat(2000)).error, 'That is too long to be PTN Ninja settings.');
  const tags = parseLook('&<img src=x onerror=alert(1)>=1&axisLabels=<script>&theme=<b>zen</b>&a"b=1');
  assert.deepEqual(tags.look, {});
  assert.deepEqual(tags.unknown, [], 'keys that aren\'t plain words aren\'t even repeated back');
  assert.ok(!/[<>"&]/.test(lookReport(tags).replace(/&/g, '')), 'the report holds no markup');
  // the last of a repeated key counts, as in PTN Ninja
  assert.deepEqual(parseLook('&axisLabels=false&axisLabels=true').look, { axisLabels: true });
  assert.deepEqual(parseLook('&axisLabels=false&axisLabels=junk').look, {}, 'the last one, unreadable: none');
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const r = parseLook(`&${k}=true&axisLabels=false`);
    assert.deepEqual(r.look, { axisLabels: false }, k);
    assert.equal(Object.getPrototypeOf(r.look), Object.prototype);
  }
  // a stored string of the wrong type, or too long, is no look at all
  for (const v of [undefined, null, 7, true, {}, [], '&axisLabels=false'.repeat(100)]) assert.equal(cleanLook(v), '', String(v));
});

test('a custom theme as JSON: plain, percent-encoded or compressed; kept only in its shape, colours only as #hex', () => {
  const json = JSON.stringify(CUSTOM);
  for (const v of [json, encodeURIComponent(json), lz(json)]) {
    const r = parseLook('&theme=' + v);
    assert.equal(r.applied[0], 'theme', v.slice(0, 30));
    assert.equal(r.look.theme.colors.primary, '#8bc34a');
    assert.equal(r.look.theme.id, 'mine');
  }
  const evil = cleanTheme({ ...CUSTOM, id: 'classic', name: '<img src=x onerror=1>', onload: 'x', boardStyle: 'url(javascript:1)',
    vars: { 'piece-border-width': 'expression(alert(1))', 'x;y': 1, ok: 2 }, colors: { ...CUSTOM.colors, board1: 'red;background:url(x)', 'a b': '#fff' } });
  assert.equal(evil.id, 'custom', 'never a built-in\'s id');
  assert.equal(evil.name, 'img srcx onerror1', 'no markup characters');
  assert.equal(evil.boardStyle, undefined);
  assert.equal(evil.onload, undefined);
  assert.deepEqual(evil.vars, { ok: 2 });
  assert.equal(evil.colors.board1, undefined);
  assert.equal(evil.colors['a b'], undefined);
  assert.equal(cleanTheme({ colors: { primary: '#fff' } }), null, 'without the colours PTN Ninja works the rest from: no theme');
  assert.equal(cleanTheme([]), null);
  assert.equal(parseLook('&theme={"colors":5}').bad[0], 'theme');
  assert.equal(parseLook('&theme={broken').bad[0], 'theme');
  // too big to store: the theme is left out, the rest kept
  const big = { ...CUSTOM, colors: Object.fromEntries(Array.from({ length: 400 }, (_, i) => ['c' + i, '#' + (i * 2654435761 % 0xffffff).toString(16).padStart(6, '0')])) };
  Object.assign(big.colors, CUSTOM.colors);
  const r = parseLook('&axisLabels=false&theme=' + encodeURIComponent(JSON.stringify(big)));
  assert.deepEqual(r.look, { axisLabels: false });
  assert.ok(r.bad.includes('theme'));
});

test('the stored form: canonical, in a fixed order, the theme compressed; read back the same; at most MAX', () => {
  const r = parseLook('&theme=zen&stackCounts=true&axisLabels=false&perspective=3');
  const s = encodeLook(r.look);
  assert.equal(s, `&axisLabels=false&perspective=3&stackCounts=true&theme=${lz('zen')}`);
  assert.equal(cleanLook(s), s, 'stable');
  assert.deepEqual(lookUi(s), { axisLabels: false, perspective: 3, stackCounts: true, theme: 'zen' }, 'SET_UI values: an id');
  const c = encodeLook(parseLook('&theme=' + lz(JSON.stringify(CUSTOM))).look);
  assert.ok(c.length <= MAX);
  assert.equal(cleanLook(c), c);
  assert.equal(typeof lookUi(c).theme, 'object', 'SET_UI values: a theme object');
  assert.equal(cleanLook('&axisLabels=junk&theme=zen'), `&theme=${lz('zen')}`, 'a stored string edited by hand: what is usable of it');
});

// index.html's early iframe start (before the modules load) against ninja-look.js frameParams
const early = html.match(/\n {6}\{\n([\s\S]*?)\n {6}\}\n/)[1]; // (always: PTN Ninja is the only board)
function earlySrc(stored) {
  const made = [];
  const iframe = { style: {}, dataset: {}, addEventListener: () => {} };
  const ctx = { window: {}, document: { getElementById: () => ({ style: {}, append: () => {} }), createElement: () => iframe },
    addEventListener: () => {}, removeEventListener: () => {}, performance: { now: () => 5 }, localStorage: { getItem: () => (stored === undefined ? null : JSON.stringify({ size: '6', ninja: stored })) }, made };
  vm.runInNewContext(early, ctx);
  return iframe.src;
}
const BASE = ninja.match(/^const PARAMS = /m) && (() => { // tinue's own embed settings, as ninja.js builds them
  const ui = ninja.match(/const UI = \{([\s\S]*?)\};/)[1].replace(/theme: THEME,\s*/, '');
  return '&' + [...ui.matchAll(/(\w+): (true|false)/g)].map((m) => `${m[1]}=${m[2]}`).join('&');
})();

test('the iframe\'s address: tinue\'s settings with the look laid over, only allowed keys and values; index.html agrees', () => {
  // (with reduced motion, both turn PTN Ninja's animation off in the address: the same replace)
  assert.match(ninja, /_src\(\) \{ return ORIGIN \+ '\/' \+ frameParams\(still\(\) \? PARAMS\.replace\('&animateBoard=true', '&animateBoard=false'\) : PARAMS, this\.lookStored\); \}/);
  assert.ok(html.includes("src = src.replace('&animateBoard=true', '&animateBoard=false');"), 'index.html: the same');
  assert.equal(earlySrc(undefined), 'https://ptn.ninja/' + BASE, 'no look: exactly tinue\'s settings, as before');
  const zen = lz('zen');
  const corpus = [undefined, '', `&axisLabels=false&moveNumber=true&theme=${zen}`, '&perspective=10&board3D=true', '&perspective=11', '&axisLabels=maybe',
    '&disableBoard=false&axisLabels=false', '&theme=<script>', `&theme=${zen}&theme=${zen}`, '&__proto__=true', '&constructor=true', '=x&&&axisLabels',
    '&axisLabels=false#x', 7, null, ['&axisLabels=false'], '&axisLabels=false'.repeat(200), encodeLook(parseLook('&theme=' + lz(JSON.stringify(CUSTOM))).look),
    '&turnIndicator=false&flatCounts=false&stackCounts=true'];
  for (const stored of corpus) {
    const src = earlySrc(stored), want = 'https://ptn.ninja/' + frameParams(BASE, stored);
    assert.equal(src, want, JSON.stringify(stored)?.slice(0, 60));
    assert.ok(src.startsWith('https://ptn.ninja/&'));
    const keys = src.slice('https://ptn.ninja/&'.length).split('&').map((x) => x.split('=')[0]);
    assert.equal(new Set(keys).size, keys.length, 'each key once');
    for (const k of keys) assert.ok(k in LOOK || BASE.includes('&' + k + '='), k);
    assert.ok(!/disableBoard=false|<|#|__proto__|constructor/.test(src), src);
  }
  assert.equal(earlySrc(`&axisLabels=false&moveNumber=true&theme=${zen}`), 'https://ptn.ninja/' + BASE.replace('&moveNumber=false', '') + `&axisLabels=false&moveNumber=true&theme=${zen}`);
  // index.html's table of keys is ninja-look.js's
  const K = Function('return ' + early.match(/K = (\{[^}]*\})/)[1])();
  assert.deepEqual(K, LOOK);
});

test('ninja.js: the look over tinue\'s settings once PTN Ninja is up, a new look puts back what the old one set', () => {
  assert.match(ninja, /this\._post\('SET_UI', \{ \.\.\.withLook\(this\.look\), animateBoard: this\._anim\(\), boardTransform:/);
  assert.match(ninja, /const withLook = \(look\) => \(\{ \.\.\.LOOK_BASE, \.\.\.UI, \.\.\.look, \.\.\.themeId\(look\) \}\);/);
  // (a built-in theme also goes as themeID, so the embed's GET_THEME answers with it: Rush's pictures, rush-theme.js)
  assert.match(ninja, /const themeId = \(look\) => \(typeof look\.theme === 'string' \? \{ themeID: look\.theme \} : \{\}\);/);
  assert.match(ninja, /for \(const k of Object\.keys\(prev\)\) if \(!\(k in look\)\) out\[k\] = k in UI \? UI\[k\] : LOOK_BASE\[k\];/);
  const base = Function('return ' + ninja.match(/const LOOK_BASE = (\{[^}]*\})/)[1])();
  const ui = ninja.match(/const UI = \{([\s\S]*?)\};/)[1];
  for (const k of Object.keys(LOOK)) assert.ok(k in base || new RegExp('\\b' + k + ':').test(ui), k + ' has a value to go back to');
  assert.ok(THEMES.includes('zen') && THEMES.length === 18);
});

test('the frame\'s shape: cut to PTN Ninja\'s board, so its squares are the host\'s width over the size; no permissions asked', () => {
  const EM = 0.04375, b = frameBox({}, 6);
  // the default look: flat-count row (2.25 em), the squares, the tray under them (one square's height over 6... of the width)
  assert.equal(b.ratio, +(1 / (2.25 * EM + 1 + 1 / 6)).toFixed(5));
  const pct = (re) => +b.frame.match(re)[1];
  assert.ok(Math.abs(pct(/width:([\d.]+)%/) * 0.9 - 100) < 1e-4, 'PTN Ninja keeps 10% of the frame\'s width as margin: the board is the host\'s width');
  assert.ok(Math.abs(pct(/ ([-\d.]+)%;aspect/) + 100 / 0.9 * 0.05) < 1e-4, 'half the margin cut each side');
  const fr = pct(/aspect-ratio:([\d.]+)$/);
  assert.ok(fr < b.ratio && fr > b.ratio * 0.98, 'the frame just taller than the board: PTN Ninja fits its width, with no button row');
  // the cut on top is half of what the frame has beyond the board's height
  const boardH = 100 / b.ratio, frameH = (100 / 0.9) / fr;
  assert.ok(Math.abs(-pct(/margin:([-\d.]+)%/) - (frameH - boardH) / 2) < 0.01);
  assert.match(b.host, /^aspect-ratio:0\.79045;overflow:hidden$/);
  assert.ok(frameBox({}, 4).ratio < frameBox({}, 8).ratio, 'a smaller size has a taller tray row');
  assert.ok(frameBox({ turnIndicator: false }, 6).ratio > b.ratio && frameBox({ axisLabels: true, axisLabelsSmall: false }, 6).ratio !== b.ratio);
  assert.ok(frameBox({ verticalLayout: false }, 6).ratio > 1, 'the tray beside the board: wider than tall');
  assert.equal(frameBox({ board3D: true }, 6), null, '3D: the whole frame, as before');
  // index.html's placeholder and early frame have the 6×6 default shape
  assert.ok(early.includes(b.host) && early.includes(b.frame), 'index.html in step with frameBox({}, 6)');
  assert.ok(!/allow/.test(early) && !/\.allow\b/.test(ninja), 'no fullscreen (so no button for it) and no clipboard');
  assert.match(early, /showBoardTransformBtn=false/);
});

test('the theme select: one setting with the paste box (the stored look), its other settings kept; a pasted theme shows as Custom', () => {
  assert.equal(themeOf(''), ''); assert.equal(themeOf(undefined), '');
  const zen = withTheme('', 'zen');
  assert.equal(zen, `&theme=${lz('zen')}`, 'stored as the paste box stores a pasted &theme=zen');
  assert.equal(zen, encodeLook(parseLook('&theme=zen').look));
  assert.equal(themeOf(zen), 'zen');
  const mixed = encodeLook(parseLook('&axisLabels=false&board3D=true&theme=aqua').look);
  assert.equal(themeOf(mixed), 'aqua', 'a pasted string with a built-in id shows it');
  assert.equal(withTheme(mixed, 'retro'), encodeLook(parseLook('&axisLabels=false&board3D=true&theme=retro').look));
  assert.equal(withTheme(mixed, ''), encodeLook(parseLook('&axisLabels=false&board3D=true').look), 'tinue\'s own: only the theme goes');
  const custom = encodeLook(parseLook('&axisLabels=false&theme=' + lz(JSON.stringify(CUSTOM))).look);
  assert.equal(themeOf(custom), 'custom');
  assert.equal(withTheme(custom, 'custom'), custom, 'Custom again changes nothing');
  assert.equal(withTheme(custom, '<x>'), custom);
  assert.equal(themeOf(withTheme(custom, 'zen')), 'zen');
  for (const id of THEMES) { assert.equal(themeOf(withTheme('', id)), id); assert.match(themeName(id), /^[A-Z][A-Za-z]+$/); }
  assert.equal(themeName('bubbletron'), 'BubbleTron');
});

// Every way a theme reaches the look field (Sasha 2026-11-22: "theme links don't work properly"), each of which the
// field refused before: PTN Ninja's theme code (its theme editor's Share and Import: the theme as JSON), a built-in's name as
// PTN Ninja writes it, a bare compressed theme value, and its game links (Share, short links), which carry no look at all.
test('theme links: a theme\'s code (JSON, pretty-printed too), a name in any case, a bare compressed value', () => {
  for (const v of [JSON.stringify(CUSTOM), JSON.stringify(CUSTOM, null, 2), '  ' + JSON.stringify(CUSTOM, null, '\t') + '\n', lz(JSON.stringify(CUSTOM))]) {
    const r = parseLook(v);
    assert.deepEqual(r.applied, ['theme'], v.slice(0, 30));
    assert.equal(r.look.theme.colors.primary, '#8bc34a');
    assert.equal(lookReport(r), 'Using a custom theme.');
    assert.equal(themeOf(encodeLook(r.look)), 'custom');
  }
  // a built-in theme as PTN Ninja shares it (its id inside): a theme of the player's own, as for any theme object
  assert.equal(themeOf(encodeLook(parseLook(JSON.stringify({ ...CUSTOM, id: 'classic', name: 'Classic' })).look)), 'custom');
  assert.equal(parseLook('{"id":"x","colors":{"primary":"#fff"}}').error, 'That theme’s code could not be read.');
  assert.equal(parseLook('{broken').error, 'That theme’s code could not be read.');
  for (const id of THEMES) for (const v of [id, id.toUpperCase(), themeName(id), lz(id), '&theme=' + themeName(id), '&themeID=' + themeName(id), 'theme=' + id.toUpperCase()])
    assert.deepEqual(parseLook(v).look, { theme: id }, v);
  assert.deepEqual(parseLook(`https://ptn.ninja/${lz('[Size "6"]')}&theme=Zen&axisLabels=false`).look, { axisLabels: false, theme: 'zen' });
  for (const v of ['hello', 'axisLabels', 'zenn', lz('hello')]) assert.deepEqual(parseLook(v).look, {}, v);
});

test('theme links: PTN Ninja\'s own game links (Share, short links) carry no look, and the field says what does', () => {
  const game = lz('[Size "6"]\n\n1. a1 f6');
  for (const v of [`https://ptn.ninja/${game}&name=${lz('My game')}&ply=3!`, `https://ptn.ninja/${game}&name=${lz('x')}&ply=2&targetBranch=${lz('1')}`,
    'https://ptn.ninja/s/AbCd1234', 'ptn.ninja/s/AbCd1234', 'https://ptn.ninja/', 'https://ptn.ninja/#/' + game]) {
    const r = parseLook(v);
    assert.deepEqual(r.look, {}, v);
    assert.equal(r.error, NO_LOOK_LINK, v);
    assert.equal(lookReport(r), NO_LOOK_LINK);
  }
  assert.match(NO_LOOK_LINK, /theme’s code/);
  assert.equal(parseLook(`https://ptn.ninja/${game}&showRoads=true`).error, '', 'a link with settings: what is in it is reported as before');
  // settings written as a query read like the path's: never "no look" for a link whose look the player can see
  assert.deepEqual(parseLook('https://ptn.ninja/?theme=zen').look, { theme: 'zen' });
  assert.deepEqual(parseLook(`https://ptn.ninja/${game}&name=${lz('x')}?axisLabels=false&theme=Luna`).look, { axisLabels: false, theme: 'luna' });
  const q = parseLook('https://ptn.ninja/?foo=1');
  assert.equal(q.error, ''); assert.deepEqual(q.unknown, ['foo'], 'a query of other things: named, as in the path');
});

test('the paste box shows the look readably: a built-in by its id, tinue classic as tinue-classic, and reads back the same', () => {
  assert.equal(showLook(withTheme('', 'classic')), '&theme=classic');
  assert.equal(showLook(encodeLook(parseLook('&theme=zen&axisLabels=false').look)), '&axisLabels=false&theme=zen');
  assert.equal(showLook(withTheme('', 'legacy')), '&theme=tinue-classic');
  assert.equal(showLook(''), '');
  for (const st of [withTheme('', 'classic'), withTheme('&axisLabels=false', 'legacy'), encodeLook(parseLook('&theme=' + lz(JSON.stringify(CUSTOM))).look)])
    assert.equal(encodeLook(parseLook(showLook(st)).look), st, st);
});

test('tinue classic (was "tinue legacy"): the board before the felt, as a PTN Ninja theme, picked and stored like any theme', () => {
  assert.equal(LEGACY.id, 'tinue-legacy');
  assert.equal(LEGACY.boardStyle, 'blank'); assert.equal(LEGACY.boardChecker, true);
  assert.equal(LEGACY.colors.board1, '#f0d9b5'); assert.equal(LEGACY.colors.board2, '#b58863'); assert.equal(LEGACY.colors.primary, '#9cb83a');
  const st = withTheme('&axisLabels=false', 'legacy');
  assert.ok(st.length <= MAX && st.startsWith('&axisLabels=false&theme='));
  assert.equal(themeOf(st), 'legacy');
  assert.deepEqual(lookUi(st).theme, LEGACY, 'SET_UI: the theme object');
  assert.equal(cleanLook(st), st);
  assert.ok(frameParams('&x=1', st).includes('&theme=' + st.split('&theme=')[1]), 'the iframe\'s address carries it too');
  assert.equal(lookReport(parseLook(st)), 'Using axis labels off, theme tinue classic.');
  assert.equal(LEGACY.name, 'tinue classic');
  assert.equal(themeOf(withTheme(st, 'zen')), 'zen');
  assert.equal(themeOf(withTheme(st, '')), '');
  // typed: its old name, its new one either way round, any case and spacing; 'classic' alone is PTN Ninja's Classic
  for (const t of ['legacy', 'tinue-legacy', 'tinue legacy', 'tinue classic', 'Tinue Classic', 'classic tinue', '  tinue   classic ', 'tinue-classic'])
    assert.deepEqual(parseLook(t).look, { theme: LEGACY }, t);
  assert.deepEqual(parseLook('classic').look, { theme: 'classic' }); assert.deepEqual(parseLook('Classic').look, { theme: 'classic' });
  assert.equal(lookReport(parseLook('tinue classic')), 'Using theme tinue classic.');
  // a look stored while it was "tinue legacy" (by that name, compressed, on this device or the account): still it, and
  // read as today's, so later changes to it reach the player (never "Custom")
  const old = encodeLook({ axisLabels: false, theme: { ...LEGACY, name: 'tinue legacy' } });
  assert.equal(themeOf(old), 'legacy'); assert.deepEqual(lookUi(old).theme, LEGACY); assert.equal(cleanLook(old), st);
  assert.equal(showLook(old), '&axisLabels=false&theme=tinue-classic');
  // a look stored before LEGACY's colours changed: still tinue classic (select and paste box), and read as today's LEGACY
  const before = encodeLook({ axisLabels: false, theme: { ...LEGACY, colors: { ...LEGACY.colors, board1: '#eeeeee' } } });
  assert.equal(themeOf(before), 'legacy');
  assert.equal(showLook(before), '&axisLabels=false&theme=tinue-classic');
  assert.deepEqual(lookUi(before).theme, LEGACY, 'SET_UI: today\'s colours');
  assert.equal(cleanLook(before), st);
  assert.equal(themeOf(encodeLook({ theme: { ...LEGACY, name: 'Mine' } })), 'custom', 'a theme of the player\'s own stays theirs');
  // the select: tinue felt first (the default), then tinue classic, then all of PTN Ninja's built-ins by PTN Ninja's names
  const app = fs.readFileSync(root + 'public/app.js', 'utf8');
  assert.match(app, /<option value="">tinue felt<\/option><option value="legacy">tinue classic<\/option>\$\{NINJA_THEMES\.map/);
  // PTN Ninja's built-ins, ids and names as its theme list showed them on 2026-11-22
  assert.deepEqual(THEMES.map(themeName), ['Aaron', 'Aer', 'Aether', 'Aqua', 'Atlas', 'Backlit', 'BubbleTron', 'Classic', 'Discord', 'Essence', 'Fresh',
    'Ignis', 'Luna', 'Paper', 'Retro', 'Stealth', 'Terra', 'Zen']);
});

console.log(`all ${n} passed`);

test('a theme pasted on its own, as PTN Ninja\'s theme editor copies it, is taken as is (Sasha, 2026-11-22)', () => {
  const t = { id: 'tinue-classic', name: 'tinue classic', boardStyle: 'blank', boardChecker: true, vars: { 'piece-border-width': 1 },
    colors: { primary: '#9cb83a', secondary: '#161512', ui: '#262421', accent: '#302e2c', panel: '#262421c0', board1: '#f0d9b5', board2: '#b58863', board3: '#262421',
      player1: '#f6f1e7', player1road: '#f6f1e7', player1flat: '#f6f1e7', player1special: '#ffffff', player1border: '#8f8473',
      player2: '#2f2c29', player2road: '#4a4540', player2flat: '#2f2c29', player2special: '#3d3935', player2border: '#0d0c0b', textLight: '#fafafacd', textDark: '#212121cd', umbra: '#00000033' } };
  for (const s of [JSON.stringify(t), JSON.stringify(t, null, 2), '\n  ' + JSON.stringify(t, null, '\t') + '\n']) {
    const r = parseLook(s);
    assert.equal(r.error, ''); assert.deepEqual(r.applied, ['theme']);
    assert.equal(r.look.theme.id, 'tinue-classic'); assert.equal(r.look.theme.colors.board2, '#b58863'); assert.equal(r.look.theme.boardChecker, true);
    assert.deepEqual(parseLook(encodeLook(r.look)).look, r.look, 'and it survives being stored');
  }
  assert.deepEqual(parseLook('classic').look, { theme: 'classic' }, 'a built-in theme\'s name alone');
  assert.deepEqual(parseLook(' Zen ').look, { theme: 'zen' });
  for (const bad of ['{', '{"colors":{}}', '{"id":"x","colors":{"primary":"red"}}', '{"a":"&theme=zen"}']) {
    const r = parseLook(bad); assert.ok(r.error, bad + ' says why'); assert.deepEqual(r.look, {});
  }
  assert.ok(lookReport(parseLook('{')).length > 10);
});
