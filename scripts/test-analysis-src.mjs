// The analysis page's engine plumbing in app.js, at source level (app.js runs only in a browser): a position's old
// lines and arrows go before anything is awaited, and no answer is written for a position no longer shown.
//   node scripts/test-analysis-src.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { threatGroups, mergeLines, chipLabel, numberedPV, ptnParts } from '../public/analysis.js';
import { moveSquares } from '../public/lines.js';
import { Game } from '../shared/tak.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// Code only: comments (which may name what the code must not do) are dropped before the checks.
const code = (src) => src.replace(/(^|\s)\/\/[^\n]*/g, '$1');
// A function's source, by brace matching from its first '{' after the parameter list (as test-freeplay.mjs).
function fn(name) {
  const i = app.search(new RegExp(`(?<=^|\\n)(async )?function ${name}\\(`));
  assert.ok(i >= 0, `function ${name} in app.js`);
  let d = 0;
  const j = app.indexOf('{', app.indexOf(')', i));
  for (let k = j; k < app.length; k++) { if (app[k] === '{') d++; else if (app[k] === '}' && --d === 0) return code(app.slice(i, k + 1)); }
  throw new Error(name);
}
const ENGINE = ['runEngine', 'runServer', 'runTiltak', 'runSolver', 'setLines', 'paintShapes'];
const GUARD = /live\(\)|S\.evalKey !== /;
const firstAsync = (src) => Math.min(...[/\bawait\b/, /\bfetch\(/, /\.then\(/, /setTimeout\(/].map((r) => { const m = r.exec(src); return m ? m.index : Infinity; }));

test('runEngine clears the shapes and the lines before its first await, fetch or .then', () => {
  const src = fn('runEngine'), a = firstAsync(src);
  for (const s of ['board.shapes?.([])', 'S.lines = []', 'S.sol = null', 'anaCtl?.abort()', 'tiltak.stop()']) {
    const i = src.indexOf(s);
    assert.ok(i >= 0 && i < a, `${s} before the first async step`);
  }
});

test('every write of the lines (S.lines, S.sol, S.eng) after an async step is preceded by a live() check', () => {
  for (const name of ENGINE) {
    const src = fn(name);
    const a = firstAsync(src);
    for (const m of src.matchAll(/S\.(lines|sol|eng) = /g)) {
      if (m.index < a && name === 'runEngine') continue; // synchronous: the position is the one shown
      // the nearest start of a block callback, resumption point or function before the write
      const before = src.slice(0, m.index);
      const j = Math.max(before.lastIndexOf('=> {'), before.lastIndexOf('await '), before.lastIndexOf('function '));
      assert.ok(GUARD.test(before.slice(j)), `${name}: ${src.slice(m.index, m.index + 30)}… without a live() check before it`);
    }
  }
});

test('board.shapes is called only from runEngine (to clear, synchronously) and paintShapes (after a live check)', () => {
  const calls = [...code(app).matchAll(/board\.shapes\?*\.?\(/g)];
  assert.ok(calls.length >= 2, 'both calls exist');
  const ps = fn('paintShapes');
  const k = ps.search(/board\.shapes\?*\.?\(/);
  assert.ok(k > 0 && GUARD.test(ps.slice(0, k)), 'paintShapes checks the position before drawing');
  const allowed = fn('runEngine').split(/board\.shapes\?*\.?\(/).length - 1 + ps.split(/board\.shapes\?*\.?\(/).length - 1;
  assert.equal(calls.length, allowed, 'no other caller');
});

test('6×6: runServer (Syntaks on the server) falls back to the solver, never to Tiltak (Sasha, 2026-11-21)', () => {
  const src = fn('runServer');
  assert.doesNotMatch(src, /runTiltak\(|tiltak\./, 'no Tiltak from the 6×6 path');
  assert.match(src, /const fallback = \(\) => \{ if \(live\(\)\) runSolver\(s, key, plies\); \}/);
  assert.match(fn('runTiltak'), /if \(!tiltak\.supports\(S\.p\.size, S\.p\.komi \|\| 0\)\) \{ tiltak\.stop\(\); return runSolver\(/, 'runTiltak asks supports() first (false on 6×6)');
});

test('Tiltak searches here are by time: no nodes: key in a tiltak.analyze call', () => {
  for (const name of ENGINE) {
    const src = fn(name);
    for (const m of src.matchAll(/tiltak\.analyze\(\{/g)) {
      let d = 0, k = m.index + 'tiltak.analyze('.length;
      for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) break; }
      const arg = src.slice(m.index, k + 1).replace(/onInfo: \(r\) => \{[\s\S]*$/, '');
      assert.ok(!/\bnodes\s*:/.test(arg), `${name}: ${arg}`);
      assert.match(arg, /\bms: \d+/, `${name}: a time limit`);
    }
  }
});

test('the server is asked for three lines, and the client reads r.lines ?? [r] (a server without lines answers one)', () => {
  // (the position as the puzzle's own orientation writes it, and the answer turned to the page's labels before it is
  // read: pagesym.js toServer, identities at s = 0; scripts/test-pagesym.mjs runs these functions under every symmetry)
  assert.match(fn('runServer'), /serverAnalyze\(s\.x\.tps\(g\.toTPS\(\), komi\), komi, ANALYSIS \? 3 : 1, ctl\)\.then\(\(r\) => \{\s*if \(!live\(\)\) return;\s*r = s\.x\.analysis\(r\);/);
  assert.match(fn('runServer'), /\(r\.lines \?\? \[r\]\)/);
  assert.match(fn('serverAnalyze'), /lines > 1 \? '&lines=' \+ lines : ''/, 'one line: the old URL');
});

test('the server\'s lines carry their index (mpv), and a miss that ends the game is a line, not a silence', () => {
  assert.match(fn('runServer'), /\(r\.lines \?\? \[r\]\)\.map\(\(l, i\) => fromSyntaks\(l, mover, i\)\)/);
  const rs = fn('runServer');
  assert.ok(!/if \(c\.result\(\)\) return;/.test(rs), 'no early return on a finished game');
  // (quickLine: the game's end, or a win in 1 handed over, judged exactly before any search; Tiltak never says mate)
  // every miss the lines don't have is judged exactly (a second miss too: tour19 a6 then f1+ said "no win ≤2")
  assert.match(rs, /for \(const p of S\.pins\.filter\(\(x\) => x\.tags\.includes\('yours'\) && !lines\.some\(\(l\) => l\.move === x\.move\)\)\) \{/);
  assert.match(rs, /const q = quickLine\(pc, p\.move, mover, s\.x\.back\);\s*if \(q\) \{ S\.eng = \{ \.\.\.S\.eng, lines: \[\.\.\.S\.eng\.lines, q\] \}; setLines\(s, key\); \} else ask \|\|= \{ p, pc \};/);
  assert.match(fn('runTiltak'), /let cl = quickLine\(c, m, mover, s\.x\.back\);[^\n]*\n\s*if \(!cl\) \{/);
});

test('the puzzle pins come from the tree (treePlies), not from how the played line ends', () => {
  const re = fn('runEngine');
  assert.match(re, /tree: treePlies\(\)/);
  assert.ok(!/wins:/.test(re), 'no "ends in a win" shortcut');
  // treePlies on a puzzle with a play-on game won after one tree move pair: [left at Sb4, null], nothing after
  const make = new Function('S', 'gameAt', 'officialLine', 'pliesLeftOf', fn('treePlies') + '; return treePlies;');
  const tree = { Sb4: { r: 'c4', n: { b5: { r: 'e1', n: 'win' } } } };
  const left = (node) => { const d = (x) => (x === 'win' ? 1 : x == null ? 0 : 2 + Math.max(...Object.values(x).map((v) => d(v.n)))); return d(node); };
  const S = { p: { tree }, solver: 1, hist: [], moves: ['Sb4', 'c4', 'a3', 'a4', 'b4'].map((ptn) => ({ ptn })) };
  const won = { result: () => ({ winner: 1 }) };
  assert.deepEqual(make(S, () => won, () => S.moves.map((m) => m.ptn), left)(), [5, null]);
  // the tree's own line to its road: every ply, the last a win in 1
  S.moves = ['Sb4', 'c4', 'b5', 'e1', 'a5'].map((ptn) => ({ ptn }));
  assert.deepEqual(make(S, () => won, () => S.moves.map((m) => m.ptn), left)(), [5, null, 3, null, 1]);
  // a slow win (off the tree, not over): nothing from there
  S.moves = ['Sb4', 'c4', 'd5'].map((ptn) => ({ ptn }));
  assert.deepEqual(make(S, () => ({ result: () => null }), () => S.moves.map((m) => m.ptn), left)(), [5, null]);
});

test('playPV acts only on lines made for the position shown (PTN Ninja loads a line in 60 ms)', () => {
  const src = fn('playPV');
  const k = src.indexOf('S.evalKey !== line.slice(0, at).join(\' \')');
  assert.ok(k > 0 && k < src.indexOf('S.lines'), 'the key check comes before S.lines is read');
});

// paintShapes, run on a stand-in S: what it hands the board
test('paintShapes: line 1\'s squares, whichever line is selected and whatever threatens; none without a line or for another position', () => {
  const run = (S, line = []) => {
    let got = null;
    new Function('S', 'shownLine', 'moveSquares', 'board', 'ANALYSIS', fn('paintShapes') + '; return paintShapes;')(S, () => line, moveSquares, { shapes: (l) => { got = l; } }, true)();
    return got;
  };
  const S = { status: 'solved', view: null, evalKey: '', posG: {}, sol: { threats: ['d1'] }, thr: true, sel: 1, lines: [{ move: '3a1>111' }, { move: 'Sc3' }] };
  assert.deepEqual(run(S), [{ role: 'best', sqs: ['a1', 'b1', 'c1', 'd1'] }]);
  assert.deepEqual(run({ ...S, lines: [] }), []);
  assert.equal(run({ ...S, evalKey: 'a1' }), null);
});
// setLines, run on a stand-in S
const setRun = (S, eng) => {
  const f = new Function('S', 'canonG', 'Game', 'mergeLines', 'renderEngine', 'paintShapes', fn('setLines') + '; return setLines;');
  S.eng = eng; f(S, new Map(), Game, mergeLines, () => {}, () => {})(S, 'k');
  return S;
};
test('setLines: a line you picked stays picked by its move; one nobody picked does not (five1: the puzzle pin moved to row 2)', () => {
  const P = (move, p) => ({ move, pv: [move], ev: { kind: 'prob', p }, src: 'tiltak', tags: [] });
  const base = () => ({ evalKey: 'k', p: { size: 5 }, sol: null, pins: [], lines: [P('a1', 0.6), P('b2', 0.5)], sel: 1, selUser: false });
  // nobody picked row 2: when the rows reorder, the selection goes back to line 1
  assert.equal(setRun(base(), { lines: [P('c3', 0.9), P('a1', 0.6), P('b2', 0.5)] }).sel, 0);
  // you picked b2: it stays picked, wherever it moves
  const S = setRun({ ...base(), selUser: true }, { lines: [P('c3', 0.9), P('a1', 0.6), P('b2', 0.5)] });
  assert.equal(S.lines[S.sel].move, 'b2');
  assert.match(fn('runEngine'), /S\.sel = 0; S\.selUser = false;/);
  assert.match(code(app), /S\.sel = L; S\.selUser = true;/);
});
// engineMarkup, run on a stand-in S (beside the board, not docked)
const markup = (S) => {
  const names = ['S', 'ANALYSIS', 'engineRow', 'colorName', 'esc', 'threatGroups', 'chipLabel', 'numberedPV', 'ptnParts', 'SRC', 'TAG_WORDS', 'DOCK_MQ'];
  const helpers = ['listAnd', 'whiteChance', 'mvHtml'].map((h) => app.match(new RegExp(`^const ${h} = [^\\n]*(\\n  [^\\n]*)*`, 'm'))[0]).join('\n');
  const f = new Function(...names, helpers + '\n' + fn('threatText') + '\n' + fn('engineMarkup') + '; return engineMarkup;');
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return f(S, true, () => 'row', (c) => (c === 1 ? 'White' : 'Black'), esc, threatGroups, chipLabel, numberedPV, ptnParts, { syntaks: () => '<a class="src">Syntaks</a>' }, {}, { matches: false })(false);
};
test('engineMarkup: the chance bar only for a chance; the threat line names the side; it sits outside the rows\' scroller', () => {
  const T19 = 'x2,1,2,x2/1,2,2,2,2,11/12,1,1,x2,1C/22,x,2,1,21,1/2,1111,11,2,x,2/2,2,12,2,2,1 1 25';
  const g = Game.fromTPS(T19, 0);
  const S = (ev) => ({ status: 'solved', posG: g, eng: { src: 'syntaks' }, eval: null, sel: 0, thr: true, sol: { threats: ['e1+', 'd2>', 'e2', 'f2-'], tinue: false },
    lines: [{ move: '4b2>1111', pv: ['4b2>1111'], ev, tags: [] }] });
  const prob = markup(S({ kind: 'prob', p: 0.64 })), won = markup(S({ kind: 'win', n: 2, proven: true }));
  assert.match(prob, /class="cbar"/, 'a chance: the bar');
  assert.doesNotMatch(won, /class="cbar"/, 'a proven win: no bar');
  assert.match(prob, /<p class="threat"[^>]*>Tak by Black: e1\+ d2&gt; e2 f2-<\/p>/);
  assert.match(prob, /<div class="lns"><div class="rws" role="group"[^>]*>.*<\/div><div class="thr"><button type="button" class="thr-t" data-thr aria-pressed="true"[^>]*>Threats<\/button><p class="threat"/,
    'the threat line (its button, then the threats) after the rows\' scroller, not in it');
  const flat = { ...S({ kind: 'prob', p: 0.5 }), posG: Game.fromTPS('1,2,1,2/2,1,2,1/1,2,1,2/2,1,2,x 1 9'), sol: { threats: ['d1'], tinue: false } };
  assert.match(markup(flat), />Black threatens: d1</);
});
test('engineMarkup: the threats off by default (a new puzzle\'s S has no thr); the button is there either way, pressed or not', () => {
  const T19 = 'x2,1,2,x2/1,2,2,2,2,11/12,1,1,x2,1C/22,x,2,1,21,1/2,1111,11,2,x,2/2,2,12,2,2,1 1 25';
  const g = Game.fromTPS(T19, 0);
  const S = (thr, threats = ['e1+', 'd2>', 'e2', 'f2-']) => ({ status: 'solved', posG: g, eng: { src: 'syntaks' }, eval: null, sel: 0, ...(thr == null ? {} : { thr }),
    sol: { threats, tinue: false }, lines: [{ move: '4b2>1111', pv: ['4b2>1111'], ev: { kind: 'prob', p: 0.64 }, tags: [] }] });
  const btn = (on) => new RegExp(`<div class="thr"><button type="button" class="thr-t" data-thr aria-pressed="${on}" title="[^"]*\\(x\\)">Threats</button>`);
  for (const off of [markup(S()), markup(S(false))]) {
    assert.match(off, btn(false), 'unpressed, its title naming the key');
    assert.doesNotMatch(off, /class="threat"|Tak by/, 'no threat line');
  }
  assert.match(markup(S(true)), btn(true));
  assert.match(markup(S(true)), /Tak by Black/);
  // no threats in the position: the button stays, and on shows nothing more
  const none = markup(S(true, []));
  assert.match(none, btn(true));
  assert.doesNotMatch(none, /class="threat"/);
  // a finished game's position: still there, in the same place
  assert.match(markup({ ...S(), eval: { kind: 'over', winner: 1 }, lines: [] }), btn(false));
});
test('the Threats toggle: the button or x flips S.thr and redraws the panel; only in the analysis view; each puzzle starts with it off', () => {
  const tog = fn('toggleThreats');
  assert.match(tog, /if \(!ANALYSIS \|\| !S \|\| S\.placeholder \|\| S\.status !== 'solved'\) return;/);
  assert.match(tog, /S\.thr = !S\.thr;\s*renderEngine\(\);/);
  // the only writer of S.thr; start()'s new S has none (off), and nothing between puzzles' steps resets it
  assert.equal([...code(app).matchAll(/\bS\.thr = /g)].length, 1, 'S.thr is written only by toggleThreats');
  assert.doesNotMatch(app.match(/const s = S = \{[^\n]*\n[^\n]*\n[^\n]*/)[0], /\bthr\b/, 'a new puzzle: off');
  assert.match(code(app), /if \(ANALYSIS && e\.target\.closest\('\[data-thr\]'\)\) return toggleThreats\(\);/, 'the button');
  // x: on only in the analysis view, never in a field, with a modifier or while a move waits for Confirm
  const key = code(app).match(/window\.addEventListener\('keydown', \(e\) => \{\n {2}if \(!ANALYSIS \|\| e\.key !== 'x'[^]*?\n\}\);/);
  assert.ok(key, 'the x handler, off without the analysis view (production)');
  assert.match(key[0], /e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey \|\| e\.repeat \|\| pend\) return;/);
  assert.match(key[0], /closest\?\.\('input, select, textarea, \[contenteditable\]'\) \|\| \$\('#view-puzzle'\)\.classList\.contains\('hidden'\)\) return;/,
    'never on another page (Settings, Rush), where the solved puzzle\'s button is still in the hidden view');
  assert.match(key[0], /S\.status !== 'solved' \|\| !\$\('#moves \[data-thr\]'\)\) return;/);
  assert.match(key[0], /e\.preventDefault\(\); toggleThreats\(\);/);
  // the button keeps keyboard focus through the redraw
  assert.match(app, /a\.matches\('\[data-thr\]'\) \? 'thr'/);
  assert.match(app, /if \(was === 'thr'\) return \$\('#moves \[data-thr\]'\)\?\.focus\(\);/);
});

test('the lines\' room is one height through the analysis; the dock carries the threat sentence', () => {
  const em = fn('engineMarkup');
  assert.ok(!/kind === 'over' \? ''/.test(em), 'a finished game\'s position keeps the lines\' room');
  assert.match(em, /<div class="lns">/);
  assert.match(em, /<div class="eng-b">[^\n]*\$\{src\}\$\{thrB\}<\/div>\$\{threatP\}<\/div>/, 'the dock\'s third row; the button ends the second');
  assert.ok(!/threat-slot/.test(app), 'no threat sentence at the top of the move list (behind the dock on phones)');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.moves \.threat \{[^}]*height: 17px;[^}]*white-space: nowrap;/);
  assert.match(css, /\.moves \.dock \.eng-slot \{ height: 95px;/);
  assert.doesNotMatch(css, /\.chip\b|\.lns\b/, 'the chips and the lines\' room are analysis.css\'s alone');
  assert.match(css, /\.moves \.eng \.pvline \{[^}]*mask-image: linear-gradient/, 'a long line fades at its edge');
  // the analysis view's own sheet: its room held as well, and loaded only with the view on
  const ana = readFileSync(new URL('../public/analysis.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // (four rows held: three lines and one of yours; the rows scroll past that, the threat line never does)
  assert.match(ana, /\.moves \.eng\.ana \.lns \{ display: flex; flex-direction: column; height: calc\(4 \* 36px \+ 23px\); overflow: hidden; \}/);
  assert.match(ana, /\.moves \.eng\.ana \.lns > \.rws \{[^}]*overflow-y: auto;/);
  // (the threat line: 5 + 18 px, its button's height, held whether the threats show or not; 26 px for a finger)
  assert.match(ana, /\.moves \.eng\.ana \.lns > \.thr \{ flex: none; display: flex;[^}]* height: 18px; margin-top: 5px;/);
  assert.match(ana, /\.moves \.eng\.ana \.thr-t \{[^}]* height: 18px;/);
  assert.match(ana, /@media \(pointer: coarse\) \{[^}]*\}[\s\S]*?\.moves \.eng\.ana \.lns \{ height: calc\(4 \* 44px \+ 31px\); \}\n {2}\.moves \.eng\.ana \.lns > \.thr, \.moves \.eng\.ana \.thr-t \{ height: 26px; \}/);
  assert.match(ana, /\.thr-t\[aria-pressed="true"\] \{[^}]*color: var\(--bad\)/, 'pressed: in the threats\' red');
  assert.doesNotMatch(ana, /\.row\b/, 'no rule for production\'s row');
  for (const sel of ana.match(/^[^@/\s}][^{]*(?=\{)/gm)) assert.match(sel, /\.eng\.ana/, `every rule under .eng.ana: ${sel}`);
  assert.match(app, /\nif \(ANALYSIS\) document\.head\.append\([^\n]*'\.\/analysis\.css'/);
  assert.match(fn('engineMarkup'), /<div class="eng ana">/);
});

test('a position already analysed marks its board again (back to the solution reloads the board, which drops them)', () => {
  const src = fn('runEngine');
  assert.match(src, /if \(S\.evalKey === key\) return paintShapes\(\);/);
});
test('a miss search from a visit left (its ctl aborted) is never sent, even after stepping back within 400 ms', () => {
  const rs = fn('runServer'), sa = fn('serverAnalyze');
  assert.match(rs, /setTimeout\(\(\) => \{\s*if \(!live\(\) \|\| ctl\.signal\.aborted\) return;/);
  assert.match(sa, /if \(ctl\.signal\.aborted\) stop\(\);/, 'an already-aborted ctl aborts the fetch at once');
});

test('the analysis view off (window.TINUE_ANALYSIS false, the production build): production\'s engine row, nothing more', () => {
  // fail closed: on only where config.js says true (development, the beta build). A config.js without the line, such
  // as production's before this release (a browser may still hold it, cached, beside the new app.js), means off.
  const decl = app.match(/^const ANALYSIS = ([^\n]*);$/m);
  assert.ok(decl, 'const ANALYSIS in app.js');
  const on = (cfg) => new Function('window', `return (${decl[1]});`)(cfg);
  assert.equal(on({}), false, 'no TINUE_ANALYSIS in config.js: off');
  assert.equal(on({ TINUE_ANALYSIS: false }), false);
  assert.equal(on({ TINUE_ANALYSIS: 'false' }), false);
  assert.equal(on({ TINUE_ANALYSIS: true }), true);
  const re = fn('runEngine');
  const off = re.indexOf('if (!ANALYSIS)');
  assert.ok(off > 0 && off < re.indexOf('engine.lines(') && off < re.indexOf('pinnedAt('), 'off: no tactics facts, no pinned moves');
  const offPart = re.slice(off, re.indexOf('}', re.indexOf('return runTiltak(', off)));
  assert.doesNotMatch(offPart, /engine\.lines|pinnedAt|pickCandidates/);
  const rs = fn('runServer');
  assert.match(rs, /serverAnalyze\(s\.x\.tps\(g\.toTPS\(\), komi\), komi, ANALYSIS \? 3 : 1, ctl\)/, 'off: one line, production\'s URL (no &lines=)');
  assert.ok(rs.indexOf('if (!ANALYSIS) return;') > 0 && rs.indexOf('if (!ANALYSIS) return;') < rs.indexOf('serverAnalyze(s.x.tps(c.toTPS()'), 'off: no search of your miss');
  assert.match(fn('runTiltak'), /const cands = ANALYSIS \? pickCandidates\([^\n]*\) : \[\];/, 'off: no candidate searches');
  assert.match(fn('paintShapes'), /^function paintShapes\(\) \{\n {2}if \(!ANALYSIS \|\| /, 'off: no arrows, rings or ghosts');
  assert.match(fn('engineMarkup'), /if \(!ANALYSIS\) return engineRow\(\);/);
  const row = fn('engineRow');
  assert.doesNotMatch(row, /chip|data-line|threat|thr|tag/, 'one row: no chips, no line rows, no threats or Threats button, no tags');
  assert.match(row, /data-pv="0\.\$\{k\}"/, 'line 1\'s moves play as before (playPV(0, k))');
  assert.match(app, /const ln = ANALYSIS && e\.target\.closest\('\[data-line\]'\);/);
  // PTN Ninja ↗: the nav button is production's too (Sasha, 2026-11-22), once the puzzle is over and only then (the link
  // carries the solution); the info row's link stays the analysis view's
  const nav = app.match(/const nav = `<div class="nav">[^\n]*/)[0];
  assert.match(nav, /\$\{S\.status === 'solved' \? '<a class="navlink" data-ninja target="_blank" rel="noopener"/, 'the ↗ in the nav, after the puzzle only');
  assert.doesNotMatch(nav, /ANALYSIS/);
  assert.match(app, /\$\{ANALYSIS \? ' · <a data-ninja [^\n]*PTN Ninja ↗<\/a>' : ''\}<\/dd>/, 'off: no PTN Ninja ↗ in the info row');
  assert.match(app, /\n {4}loadLz\(\); \/\/ \(for the ↗ by the step buttons\)\n/, 'lz-string loads once a puzzle is over, view on or off');
  assert.match(fn('refreshNinja'), /if \(!S \|\| S\.placeholder \|\| S\.status !== 'solved'\) return;/, 'no href while the puzzle is on');
  // the serverAnalyze URL for one line is production's, byte for byte (main's: ?tps=&komi=)
  assert.match(fn('serverAnalyze'), /\/api\/analyze\?tps=\$\{encodeURIComponent\(tps\)\}&komi=\$\{komi\}\$\{lines > 1 \? '&lines=' \+ lines : ''\}/);
  // local development: on; the static build writes it
  assert.match(readFileSync(new URL('../public/config.js', import.meta.url), 'utf8'), /^window\.TINUE_ANALYSIS = true;$/m);
  const sh = readFileSync(new URL('./build-static.sh', import.meta.url), 'utf8');
  assert.match(sh, /^if \[ "\$\{ANALYSIS:-0\}" = 1 \]; then printf "window\.TINUE_ANALYSIS = true;\\n" >> "\$OUT\/config\.js"; else printf "window\.TINUE_ANALYSIS = false;\\n" >> "\$OUT\/config\.js"; fi$/m);
  assert.match(readFileSync(new URL('./build-beta.sh', import.meta.url), 'utf8'), / ANALYSIS=1 SITE="\$SITE" sh scripts\/build-static\.sh/);
});

console.log(`\nOK: ${n} analysis source tests`);
