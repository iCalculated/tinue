// The words players read on the puzzle page, History and the themes (fixes from the 2026-11-20 site review), checked
// in app.js's and index.html's own source: each helper is cut out of app.js and run alone, as test-beta.mjs does.
//   node scripts/test-words.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { THEMES } from '../shared/themes.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const root = new URL('..', import.meta.url).pathname;
const app = fs.readFileSync(root + 'public/app.js', 'utf8'), lines = app.split('\n');
// `const NAME = ...` from app.js, up to the line that ends the statement, evaluated with ctx's globals
const def = (name, ctx = {}) => {
  const i = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(i >= 0, `const ${name} in app.js`);
  let j = i; while (!(/=> \{$/.test(lines[i]) ? lines[j] === '};' : lines[j].trimEnd().endsWith(';'))) j++; // (a body in braces: to its end)
  return vm.runInNewContext(lines.slice(i, j + 1).join('\n') + '\n' + name, ctx);
};
const colorName = (c) => (c === 1 ? 'White' : 'Black');

test('the card at a game\'s end: what happened, then how to explore (no "Game over here")', () => {
  const over = (fine) => def('overNote', { colorName, finePointer: { matches: fine } });
  assert.equal(over(true)({ winner: 2, kind: 'road' }), 'Black made a road. Step back (←) or click a move to explore.');
  assert.equal(over(false)({ winner: 1, kind: 'flats' }), 'White won on flats. Step back or click a move to explore.');
  assert.equal(over(true)({ winner: null }), 'A draw. Step back (←) or click a move to explore.');
  assert.match(over(true)({ winner: 1, kind: 'road', dragon: true }), /^White completed both roads at once, and the player who moved wins \(the dragon clause\)\. Step back/);
  assert.doesNotMatch(app, /Game over here:/);
});

test('the phone\'s dock says why a result isn\'t rated, as the card does, beside the slower win and the game\'s end', () => {
  const dock = (S, { unchecked = '', over = null } = {}) => {
    const ctx = { S, uncheckedText: () => unchecked, notCountedText: () => 'Not rated: the server didn’t record this result.', slowWinText: (w) => `${w.move} forces a win too, so it counts as solved`, shownOver: () => over };
    ctx.unratedNote = def('unratedNote', ctx);
    return def('dockNoteText', ctx)();
  };
  const slowWin = { move: 'c3' }, SLOW = 'c3 forces a win too, so it counts as solved.';
  assert.equal(dock({}), '');
  assert.equal(dock({ slowWin }), SLOW);
  assert.equal(dock({ slowWin, casual: true, casualWhy: 'hint' }), `${SLOW} Not rated: you used a hint.`);
  assert.equal(dock({ slowWin, casual: true, casualWhy: 'tiltak' }), `${SLOW} Not rated: Tiltak defended.`);
  assert.equal(dock({ slowWin, notCounted: 'error', casual: true, casualWhy: 'hint' }), `${SLOW} Not rated: the server didn’t record this result.`);
  assert.equal(dock({ casual: true, casualWhy: 'unchecked' }, { unchecked: 'Not rated: a1 might win, and there wasn’t time to check.' }), 'Not rated: a1 might win, and there wasn’t time to check.');
  assert.equal(dock({ casual: true, casualWhy: 'hint' }, { over: {} }), 'Not rated: you used a hint. Game over here. Step back with ◀ to explore.');
  // the card takes its reason from the same function
  assert.match(app, /const why = unratedNote\(\);\n {4}const note = slow \+ \(why && why \+ ' '\)/);
  assert.match(app, /const dockNote = notice \? esc\(notice\.body\) : dockNoteText\(\);/);
});

test('the card\'s title for a solve after a miss fits one line: "Solved on retry"', () => {
  const title = (outcome) => def('solvedTitle', { S: { outcome } })();
  assert.deepEqual(['clean', 'miss', 'viewed'].map(title), ['Solved', 'Solved on retry', 'Solution shown']);
});

test('History: real minus signs, "unrated", "refunded", the length as the themes name it, days and times without seconds', () => {
  const signed = def('signed'), change = def('histChange', { signed });
  assert.equal(change({ rated: 1, user_delta: -169.4 }), '<span class="delta down">−169</span>');
  assert.equal(change({ rated: 1, user_delta: 12.6 }), '<span class="delta up">+13</span>');
  assert.equal(change({ rated: 0, user_delta: 0 }), '<span class="muted">unrated</span>');
  assert.match(change({ rated: 1, refund: 1, user_delta: 0.2 }), /^<span class="muted"[^>]*>refunded<\/span>$/);
  assert.match(change({ rated: 1, refund: 1, user_delta: 5.2 }), />refunded<.*\+5</);
  assert.match(change({ rated: 0, refund: 1, user_delta: 5.2 }), /unrated/);
  const len = def('histLength', { String });
  assert.deepEqual([[1, ''], [3, 'capture'], [11, 'deep,tinueIn4'], [5, 'capture,gaelet'], [7, null]].map(([plies, themes]) => len({ plies, themes })), ['Road in 1', 'Road in 2', 'Road in 6', 'Flat win in 3', 'Road in 4']);
  const day = def('histDay', { Date, Math }), time = def('histTime', { Date });
  const at = new Date(2026, 10, 21, 14, 41, 27).getTime(), next = (d) => new Date(2026, 10, d, 9).getTime();
  assert.deepEqual([21, 22, 25].map((d) => day(at, next(d), 'en-US')), ['Today', 'Yesterday', 'Nov 21']);
  assert.equal(day(at, new Date(2027, 1, 1).getTime(), 'en-US'), 'Nov 21, 2026');
  assert.equal(time(at, 'en-US').replace(/\s/, ' '), '2:41 PM');
});

test('History\'s chart: the rating before the first puzzle, after each rated one, and now; none without a rated one', () => {
  const pts = def('chartPoints'), vs = (h, r) => Array.from(pts(h, r), (p) => p.v); // (from another realm)
  assert.deepEqual(vs([], 1500), []);
  assert.deepEqual(vs([{ rated: 0, user_rating: 1500, user_delta: 0 }], 1500), []);
  const h = [{ rated: 1, user_rating: 1520, user_delta: -30, ts: 3 }, { rated: 0, user_rating: 1520, user_delta: 0, ts: 2 }, { rated: 1, user_rating: 1500, user_delta: 20, ts: 1 }]; // newest first
  assert.deepEqual(vs(h, 1490), [1500, 1520, 1490]);
  assert.deepEqual(vs(h, 1510), [1500, 1520, 1490, 1510]); // (a refund moved it)
  const scale = def('chartScale', { Math });
  for (const v of [[1500, 1500], [1500, 1501], [1230, 1990], [900, 2600], [1494, 1506]]) {
    const { lo, hi, ticks } = scale(v);
    assert.ok(lo < Math.min(...v) && hi > Math.max(...v) && ticks.length >= 1 && ticks.length <= 5 && ticks.every((t) => t >= lo && t <= hi && t % 10 === 0), JSON.stringify([v, lo, hi, ticks]));
  }
});

test('the size filter is "Board size", not "Board" (the Settings page\'s board setting)', () => {
  const html = fs.readFileSync(root + 'public/index.html', 'utf8');
  assert.ok(/<span>Board size<\/span>\s*<select id="size">/.test(html), 'Board size');
});

test('a theme\'s Practice link: "Practice (290)", unbroken, after a space rather than a margin; no count when it isn\'t known', () => {
  const link = def('practiceLink');
  assert.equal(link('road1', 1), '<span class="gap"> </span><a href="#/" class="practice" data-theme="road1">Practice (1)</a>');
  assert.match(link('road1', 1290), />Practice \(1,290\)</);
  assert.match(link('road1', undefined), />Practice</);
  const css = fs.readFileSync(root + 'public/style.css', 'utf8');
  assert.match(css, /\.tag-def \.practice \{[^}]*white-space: nowrap/); assert.doesNotMatch(css, /\.tag-def \.practice \{[^}]*margin-left/);
});

test('every theme a player sees has one short definition, and claims nothing its tag doesn\'t test', () => {
  for (const [k, t] of Object.entries(THEMES)) {
    if (t.group === 'Board') { assert.ok(!t.desc, k); continue; }
    assert.ok(t.desc && t.desc.length <= 140 && /\.$/.test(t.desc) && !/—/.test(t.desc), k + ': ' + t.desc);
  }
  assert.doesNotMatch(THEMES.fork.desc, /only block one|road threats/); assert.doesNotMatch(THEMES.reveal.desc, /completes/); assert.doesNotMatch(THEMES.smash.desc, /path|opening/);
  assert.doesNotMatch(THEMES.capture.desc, /taking/); assert.match(THEMES.gaelet.desc, /komi/); assert.match(THEMES.gaelet.desc, /gaelet/);
  assert.match(THEMES.spread.desc, /^A regular spread/); assert.match(THEMES.throw.desc, /^An irregular spread/);
});

test('no Glossary page: its old links land on the puzzle page, at its address', () => {
  const html = fs.readFileSync(root + 'public/index.html', 'utf8');
  assert.doesNotMatch(html, /#\/glossary|view-glossary/);
  assert.match(app, /if \(page === 'glossary'\) showHashURL\('#\/'\);/);
  assert.match(app, /\(puzzle\\\/\[\^\/\]\+\|glossary\|me\|leaderboard\)/); // (…/glossary is still the app's directory)
  assert.doesNotMatch(app, /#\/glossary/);
});

// showTag, with a stand-in for the panel
test('a finished puzzle\'s tag: its definition and Practice link, one open at a time', () => {
  const i = app.indexOf('function showTag('), src = app.slice(i, app.indexOf('\n}\n', i) + 2);
  const tag = (t) => ({ dataset: { tag: t }, attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } }), tags = [tag('fork'), tag('smash')], d = { dataset: {}, hidden: true, innerHTML: '', scrollIntoView() {} };
  const ctx = vm.createContext({ S: { tag: 'fork' }, THEMES, themeCounts: { fork: 12 }, esc: (s) => s, $: () => d, document: { querySelectorAll: () => tags }, practiceLink: (k, n) => `[${k} ${n}]` });
  vm.runInContext(src + '\nshowTag();', ctx);
  assert.deepEqual([d.hidden, d.innerHTML, ...tags.map((t) => t.attrs['aria-expanded'])], [false, THEMES.fork.desc + '[fork 12]', 'true', 'false']);
  vm.runInContext("S.tag = 'smash'; showTag();", ctx);
  assert.deepEqual([d.innerHTML, ...tags.map((t) => t.attrs['aria-expanded'])], [THEMES.smash.desc + '[smash undefined]', 'false', 'true']);
  vm.runInContext('S.tag = null; showTag();', ctx);
  assert.deepEqual([d.hidden, d.innerHTML, ...tags.map((t) => t.attrs['aria-expanded'])], [true, '', 'false', 'false']);
});

test('the "…" on the side-to-move disc while a move is checked reads on both colours (contrast 4.5 or more)', () => {
  const css = fs.readFileSync(root + 'public/style.css', 'utf8');
  const v = (name) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))[1];
  const rule = (sel) => { const m = css.match(new RegExp(sel.replace(/\./g, '\\.') + ' \\{([^}]*)\\}')); assert.ok(m, sel); return m[1]; };
  const color = (decl) => { const m = decl.match(/(?:^|[ ;])color: (?:var\(--([a-z0-9-]+)\)|(#[0-9a-f]{6}))/); return m && (m[2] || v(m[1])); };
  const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const white = color(rule('.feedback .icon.turn')) || v('fg'), black = color(rule('.feedback .icon.turn.p2')) || white;
  assert.ok(contrast(white, v('p1')) >= 4.5, `on White's disc: ${white} on ${v('p1')}, ${contrast(white, v('p1')).toFixed(2)}`);
  assert.ok(contrast(black, v('p2')) >= 4.5, `on Black's disc: ${black} on ${v('p2')}, ${contrast(black, v('p2')).toFixed(2)}`);
  assert.match(app, /<div class="icon turn p\$\{S\.solver\}">…<\/div><div class="body"><h2>Checking/);
});

test('a refused typed move says so, in words a screen reader announces', () => {
  const err = def('typedErr');
  assert.equal(err('z9', false), 'Can’t play z9 here.'); assert.equal(err('c3', true), '');
  const html = fs.readFileSync(root + 'public/index.html', 'utf8');
  assert.ok(/<input id="ptn-in"[^\n]* aria-describedby="ptn-err"[^\n]*><p id="ptn-err" class="ptn-err" role="alert"><\/p><\/form>/.test(html), 'the message line, tied to the box');
  assert.match(app, /\$\('#ptn-err'\)\.textContent = typedErr\(ptn, ok\);/);
});

test('a refused typed move\'s message goes as the player types, and when they leave the box (it spoke of that position)', () => {
  const err = { textContent: 'Can’t play z9 here.' }, box = { attrs: { 'aria-invalid': 'true' }, removeAttribute(a) { delete this.attrs[a]; } };
  def('typedOk', { $: (sel) => (assert.equal(sel, '#ptn-err'), err) })({ target: box });
  assert.equal(err.textContent, ''); assert.deepEqual(box.attrs, {});
  assert.match(app, /\$\('#ptn-in'\)\.addEventListener\('input', typedOk\);/);
  assert.match(app, /\$\('#ptn-in'\)\.addEventListener\('blur', typedOk\);/); // else refocusing the box brought back a stale "Can’t play z9 here."
});

test('the account menu says "Sign out", matching "Sign in" and "sign back in", and folds its confirm when it closes', () => {
  assert.match(app, /id="logout" role="menuitem">Sign out<\/button>/); assert.match(app, /id="logout-yes">Sign out<\/button>/);
  assert.doesNotMatch(app, />Log out</);
  assert.match(app, /menu\.addEventListener\('mouseleave', fold\); menu\.addEventListener\('focusout', fold\);/); // (the fold itself: the browser check)
});

// The pages, run with a server that doesn't answer and one that answers an error.
const pageFn = (name) => { const i = app.indexOf(`async function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i) + 2); };
for (const [how, api] of [['no answer', async () => { throw new TypeError('fetch failed'); }], ['an error', async () => ({ error: 'busy' })]]) {
  const els = {}, el = (s) => (els[s] ||= { innerHTML: '' });
  const ctx = vm.createContext({ scrollY: 0, $: el, show() {}, api, withBuild: (p) => p, me: { name: 'x', rating: 1500 }, prefs: {}, esc: (s) => s, location: { hash: '#/me' }, renderUser() {}, settingsArrived() {}, });
  vm.runInContext([app.match(/^const pageError = [^\n]*/m)[0], ...['mePage', 'leaderPage', 'renderFilters'].map(pageFn)].join('\n'), ctx);
  for (const p of ['mePage', 'leaderPage']) await ctx[p]();
  test(`${how} from the server: History and Leaderboard say so`, () => {
    for (const [id, h1] of [['#view-me', 'History'], ['#view-leaderboard', 'Leaderboard']]) assert.match(els[id].innerHTML, new RegExp(`^<h1>${h1}</h1>.*Can’t reach the puzzle server`));
  });
  if (how === 'an error') await ctx.renderFilters(); // (the menus stay as they are, nothing thrown)
}

test('signing out, claiming and signing in say when the server does not answer; signed out only once it says so', () => {
  const out = app.slice(app.indexOf("$('#logout-yes').onclick"), app.indexOf('} else {', app.indexOf("$('#logout-yes').onclick")));
  assert.match(out, /catch \{ \$\('#logout-err'\)\?\.classList\.remove\('hidden'\); return; \}\s*authEpoch\+\+; signIn\+\+; setToken\(null\);/);
  assert.equal((app.match(/\.catch\(\(\) => NO_ANSWER\);/g) || []).length, 2);
});

console.log(`test-words: ${n} ok`);
