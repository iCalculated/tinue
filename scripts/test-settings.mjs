// Confirm moves and Sound (public/settings.js, set on the Settings page), Confirm moves' held-move rules, and that there
// is no board to choose (PTN Ninja is the only board, whatever is stored or in the address); plus how app.js and
// index.html use them.   node scripts/test-settings.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BUSY_MS } from '../public/busy.js';
import * as SETTINGS from '../public/settings.js';
import { confirmOn, soundOn, soundOf, SOUND_DEFAULT, holds, phaseKey, pending, pendingAct, settingsNote, takesHeldKey } from '../public/settings.js';
import * as soundMod from '../public/sound.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const root = new URL('..', import.meta.url).pathname;
const app = fs.readFileSync(root + 'public/app.js', 'utf8');
const html = fs.readFileSync(root + 'public/index.html', 'utf8');

test('one board for everyone: PTN Ninja, whatever is stored, synced or in the address; no Board setting left', () => {
  for (const gone of ['boardFrom', 'withoutBoardFlag', 'switchNow', 'switchAtNext', 'boardSaved']) assert.ok(!(gone in SETTINGS), gone);
  for (const p of [undefined, null, {}, { confirm: 'true' }, { confirm: 1 }, { confirm: 'on' }, { confirm: false }]) assert.equal(confirmOn(p), false, JSON.stringify(p));
  assert.equal(confirmOn({ confirm: true }), true);
  // app.js makes one board, PTN Ninja's, always; nothing reads prefs.board or ?board=, and nothing switches or reloads for it
  assert.match(app, /^const board = new NinjaBoard\(\$\('#board'\), \{ onMove: \(ptn\) => moveIn\(ptn\), look: prefs\.ninja, onState: /m);
  assert.match(app, /^import \{ NinjaBoard \} from '\.\/ninja\.js';$/m, 'loaded for everyone, not on request');
  assert.doesNotMatch(app, /\bNINJA\b|boardFrom|prefs\.board|\.get\('board'\)|boardSwitch|LINK_BOARD|withoutBoardFlag|import\('\.\/ninja\.js'\)/);
  assert.ok(!/prefs\.(board|confirm|sound)\s*(\?\?|\|\|)?=(?!=)/.test(app), 'app.js writes no default into the stored prefs');
  // index.html: the preconnect and the early frame for every visit, whatever the address or the stored prefs say
  assert.match(html, /<link rel="preconnect" href="https:\/\/ptn\.ninja">/);
  assert.doesNotMatch(html, /__tinueNinja|board=ninja|\.board\b/);
  const early = html.match(/<div id="board" class="board-host"><\/div><\/div>\n {4}<script>([\s\S]*?)<\/script>/)[1];
  for (const search of ['', '?board=tinue', '?board=ninja', '?board=x', '?board=']) for (const p of [null, 'not json', {}, { board: 'tinue' }, { board: 'ninja' }, { board: 'Ninja', v2: true }]) {
    const made = [];
    const frame = { style: {}, dataset: {}, addEventListener() {} };
    const ctx = { URLSearchParams, JSON, location: { search }, performance: { now: () => 1 }, addEventListener() {}, removeEventListener() {},
      localStorage: { getItem: (k) => (k === 'tinue.prefs' ? (typeof p === 'string' ? p : p == null ? null : JSON.stringify(p)) : null) },
      document: { getElementById: () => ({ style: {}, append: (x) => made.push(x) }), createElement: () => frame } };
    ctx.window = ctx;
    vm.runInNewContext(early, ctx);
    assert.equal(made.length, 1, `the frame starts: ${search} ${JSON.stringify(p)}`);
    assert.match(frame.src, /^https:\/\/ptn\.ninja\/&/);
  }
});

test('the Settings page\'s note: only when settings can\'t be saved', () => {
  assert.equal(settingsNote({ unsaved: true }), "Settings can't be saved in this browser.");
  assert.equal(settingsNote({}), '');
  assert.equal(settingsNote(), '');
  // a setting storage didn't keep is put back, and the page says so (no reload any more: no setting needs one)
  const on = app.slice(app.indexOf('function setSetting('), app.indexOf('// ---- settings saved to the account'));
  assert.match(on, /if \(syncedOf\(store\.get\('prefs', \{\}\)\)\[key\] !== syncedOf\(prefs\)\[key\]\) \{/);
  assert.doesNotMatch(on, /reloadInto/);
});

test('keys while a move is held: Esc cancels from anywhere but a field, the Confirm and Cancel buttons included', () => {
  const k = (key, o = {}) => takesHeldKey({ key, typed: false, field: false, bar: false, control: false, ...o });
  assert.equal(k('Escape', { bar: true, control: true }), true, 'keyboard focus on Confirm');
  assert.equal(k('Escape', { control: true }), true);
  assert.equal(k('Escape', { field: true }), false);
  assert.equal(k('Enter', { bar: true, control: true }), false, 'Enter presses the focused button');
  assert.equal(k('Enter', { control: true }), false);
  assert.equal(k('Enter'), true);
  assert.equal(k('ArrowLeft'), true);
  assert.equal(k('1', { field: true }), false);
  assert.equal(k('Enter', { typed: true }), true);
  assert.equal(k('Escape', { typed: true }), true);
  assert.equal(k('3', { typed: true }), false, 'typing a move goes on');
  assert.equal(k('a'), false);
  assert.equal(k('Tab', { bar: true }), false);
});

const S0 = { p: { id: 'p1', size: 6 }, born: 0, status: 'play', moves: [], misses: [], busy: false, view: null, playOn: null, placeholder: false };
test('which moves are held: puzzle and play-out moves the flow would take now; never with the setting off', () => {
  assert.equal(holds(true, S0, false), true);
  assert.equal(holds(true, { ...S0, status: 'retry' }, false), true);
  assert.equal(holds(true, { ...S0, status: 'playon', playOn: { line: ['a1', 'b2'], end: null, thinking: false } }, false), true);
  for (const s of [null, { ...S0, placeholder: true }, { ...S0, busy: true }, { ...S0, view: 3 }, { ...S0, status: 'solved' }, { ...S0, status: 'viewing' },
    { ...S0, status: 'playon', playOn: { line: ['a1'], end: null, thinking: true } }, { ...S0, status: 'playon', playOn: { line: ['a1'], end: 'win' } }])
    assert.equal(holds(true, s, false), false, JSON.stringify(s));
  assert.equal(holds(true, S0, true), false, 'the new puzzle\'s first 700 ms: the flow drops it, as before');
  for (const s of [S0, { ...S0, status: 'retry' }, { ...S0, status: 'solved' }, { ...S0, status: 'playon', playOn: { line: ['a1', 'b2'], end: null } }])
    for (const soon of [false, true]) assert.equal(holds(false, s, soon), false, 'off: every move goes straight to the flow');
  // app.js: both boards report through moveIn, which hands over untouched when nothing is held
  assert.equal(app.split('onMove: (ptn) => moveIn(ptn)').length - 1, 1, 'the one board reports through moveIn');
  assert.equal(app.split('onMove: (ptn) => userMove(ptn)').length - 1, 0);
  assert.match(app, /function moveIn\(ptn\) \{\n {2}if \(!holds\(confirmOn\(prefs\), S, S && !S\.placeholder && tooSoon\(S\)\)\) return userMove\(ptn\);/);
});

test('a held move: a tap elsewhere, Esc, Enter, the buttons', () => {
  const t = 10000, p = pending('4b2>22', { ...S0, born: 0 }, t);
  const at = (ms) => t + ms, C = BUSY_MS.confirm;
  // a tap anywhere else: cancels, at once
  assert.equal(pendingAct(p, { type: 'elsewhere' }, at(1)), 'cancel');
  // keys
  assert.equal(pendingAct(p, { type: 'key', key: 'Enter' }, at(C)), 'confirm');
  assert.equal(pendingAct(p, { type: 'key', key: 'Enter' }, at(C - 1)), 'ignore');
  assert.equal(pendingAct(p, { type: 'key', key: 'Enter', repeat: true }, at(5000)), 'ignore', 'a held Enter never confirms');
  assert.equal(pendingAct(p, { type: 'key', key: 'Escape' }, at(1)), 'cancel');
  for (const key of ['1', '2', 'ArrowLeft', 'Home', '`']) assert.equal(pendingAct(p, { type: 'key', key }, at(5000)), 'ignore', key);
  // Enter in the typed-move box: confirms the held move only when the box is empty; with a move typed there, the held
  // move is dropped and the typed one is held instead (never confirmed: c3 held, d4 typed + Enter judged c3 before)
  assert.equal(pendingAct(p, { type: 'key', key: 'Enter', text: '' }, at(C)), 'confirm', 'empty box');
  for (const ms of [1, C, 5000]) assert.equal(pendingAct(p, { type: 'key', key: 'Enter', text: 'd4' }, at(ms)), 'replace', 'typed d4');
  assert.equal(pendingAct(p, { type: 'key', key: 'Enter', text: '4b2>22' }, at(C)), 'replace', 'the same move typed is held afresh, not confirmed');
  assert.equal(pendingAct(p, { type: 'key', key: 'Enter', text: 'd4', repeat: true }, at(5000)), 'ignore', 'a held Enter does nothing');
  assert.equal(pendingAct(p, { type: 'key', key: 'Escape', text: 'd4' }, at(1)), 'cancel');
  // app.js: the box's text reaches pendingAct, and a replacement is only ever held (holds(), else the text stays)
  assert.match(app, /pendingEvent\(\{ type: 'key', key: e\.key, repeat: e\.repeat, text: typed \? t\.value\.trim\(\) : '' \}\)/);
  assert.match(app, /if \(!holds\(confirmOn\(prefs\), S, S && !S\.placeholder && tooSoon\(S\)\)\) return; \/\/ only ever held/);
  // buttons
  assert.equal(pendingAct(p, { type: 'button', which: 'confirm' }, at(C)), 'confirm');
  assert.equal(pendingAct(p, { type: 'button', which: 'confirm' }, at(10)), 'ignore');
  assert.equal(pendingAct(p, { type: 'button', which: 'cancel' }, at(1)), 'cancel');
  // nothing held: nothing to do
  for (const ev of [{ type: 'elsewhere' }, { type: 'key', key: 'Enter' }, { type: 'button', which: 'confirm' }, { type: 'leave' }])
    assert.equal(pendingAct(null, ev, at(5000)), 'ignore');
});

test('a held move when the puzzle changes, a play-out ends, a check settles it, or the page is hidden: cancelled', () => {
  const t = 5000;
  const live = { ...S0, status: 'playon', moves: [{ ptn: 'a1' }], playOn: { line: ['b3', 'c4'], end: null, thinking: false } };
  const p = pending('d5', live, t);
  assert.equal(pendingAct(p, { type: 'phase', key: phaseKey(live) }, t + 10), 'ignore', 'a render with nothing changed');
  assert.equal(pendingAct(p, { type: 'phase', key: phaseKey({ ...live, delta: 12, notCounted: null }) }, t + 10), 'ignore', 'a result arriving for an earlier miss');
  for (const next of [
    { ...live, playOn: { ...live.playOn, end: 'proved' } }, // the check proved the move: the play-out ends
    { ...live, status: 'solved', playOn: null, moves: [...live.moves, { ptn: 'b3' }, { ptn: 'c4' }] },
    { ...live, status: 'retry', playOn: null },
    { ...live, busy: true },
    { ...live, p: { id: 'p2', size: 6 } }, // another puzzle
  ]) assert.equal(pendingAct(p, { type: 'phase', key: phaseKey(next) }, t + 10), 'cancel', JSON.stringify(next));
  assert.equal(pendingAct(p, { type: 'phase', key: null }, t + 10), 'cancel', 'S is another puzzle object');
  const q = pending('c3', { ...S0, status: 'retry', misses: [{ at: 0, ptn: 'a1' }] }, t);
  assert.equal(pendingAct(q, { type: 'phase', key: phaseKey({ ...S0, status: 'solved', misses: [] }) }, t + 10), 'cancel', 'a held check proved the earlier move');
  assert.equal(pendingAct(q, { type: 'leave' }, t + 10), 'cancel', 'page hidden, another page, setting off');
  // app.js: each of those reaches it
  assert.match(app, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(document\.hidden\) pendingEvent\(\{ type: 'leave' \}\); \}\);/);
  // the board down or loading again (PTN Ninja hung, Retry pressed): app.js's own onState, run
  {
    const src = app.match(/onState: (\(\) => \{[^\n]*\}) \}\);\n/)[1], got = [];
    const run = (available, S) => { got.length = 0; new Function('syncClock', 'S', 'board', 'pendingEvent', 'renderAll', `(${src})()`)(() => {}, S, { available }, (e) => got.push(e.type), () => got.push('render')); return [...got]; };
    assert.deepEqual(run(false, {}), ['leave', 'render'], 'down: the held move goes, so Confirm or Enter judges nothing');
    assert.deepEqual(run(true, {}), ['render'], 'up: nothing dropped');
    assert.deepEqual(run(false, null), [], 'before the first puzzle (the held-move code may not have run yet)');
  }
  // any tap outside the confirm bar cancels, #board's own edge included (PTN Ninja's taps stay in its frame)
  assert.match(app, /if \(!pend \|\| e\.target\.closest\?\.\('#confirm-bar'\)\) return;/);
  assert.match(app, /if \(id !== 'view-puzzle'\) pendingEvent\(\{ type: 'leave' \}\);/);
  assert.match(app, /if \(pend\) pendingEvent\(\{ type: 'phase', key: S === pend\.s \? phaseKey\(S\) : null \}\);/);
  assert.match(app, /board\.forget\(\);[^\n]*\n {2}dropPending\(\);/, 'start(): a new puzzle drops it');
});

test('confirming on a new puzzle: never inside its board lock (input-guard)', () => {
  const born = 1000, p = pending('c3', { ...S0, born }, born + 50);
  assert.equal(pendingAct(p, { type: 'button', which: 'confirm' }, born + BUSY_MS.board - 1), 'ignore');
  assert.equal(pendingAct(p, { type: 'key', key: 'Enter' }, born + BUSY_MS.board), 'confirm');
});

test('app.js: the held-move keys are registered before Enter = Continue; the bar keeps its room while the setting is on', () => {
  const held = app.indexOf("pendingEvent({ type: 'key', key: e.key, repeat: e.repeat, text: "), cont = app.indexOf('// Enter = Continue, unless');
  assert.ok(held > 0 && cont > 0 && held < cont);
  assert.match(html, /<div id="confirm-bar" class="confirm-bar idle" hidden>/, 'hidden until the setting is on');
  const css = fs.readFileSync(root + 'public/style.css', 'utf8');
  assert.match(css, /\.confirm-bar\.idle \{ visibility: hidden; \}/, 'idle: invisible but keeps its room');
  assert.match(css, /\.board-wrap\.pending \{ outline:/, 'the ring is an outline: no layout change');
  assert.doesNotMatch(app, /board: \{ opts: /, 'no Board select');
  assert.match(app, /confirm: \{ opts: \[\['off', 'Off'\], \['on', 'On'\]\], /);
  // the time is taken at confirmation: userMove runs only then (it reads elapsed() itself)
  assert.match(app, /board\.ui\(\{ disableBoard: false \}\);\n {2}userMove\(p\.ptn\);/);
});

test('the settings: the board\'s theme and look, Confirm moves and Sound, on the Settings page only (the puzzle page links there)', () => {
  const controls = html.slice(html.indexOf('<div class="panel controls">'), html.indexOf('</aside>'));
  assert.deepEqual([...controls.matchAll(/<select id="([a-z-]+)"/g)].map((m) => m[1]), ['theme', 'difficulty', 'size'], 'the puzzle page: its filters only');
  assert.match(controls, /<\/div>\n {6}<p class="set-link"><a href="#\/settings">Settings<\/a><\/p>\n {4}<\/div>/, 'and one link, under them');
  for (const gone of ['set-board', 'set-confirm', 'set-arrows', 'set-sound', 'settings-note', 'set-all', 'class="settings"']) { assert.ok(!html.includes(gone), gone); assert.ok(!app.includes(gone), gone); }
  const css = fs.readFileSync(root + 'public/style.css', 'utf8');
  assert.doesNotMatch(css, /^\.settings[ .{]|\.set-head|\.set-all/m, 'no CSS left for the block');
  assert.match(app, /const CTL = \{\n {2}confirm: [^\n]*\n {2}sound: [^\n]*\n\};/);
  // Confirm moves says what confirms on PTN Ninja's board (its taps stay in its frame: no second tap)
  assert.match(app, /sel\('confirm', 'Confirm moves', 'A move waits until you press Confirm or Enter\.'\)/);
});

test('Sound: Off / Light / Thunk / Deep, the default voice unless stored; the select, its handler, the hooks, the build', () => {
  // nothing stored, or a value from before the voices (true, 'on'), or junk: the default voice
  for (const p of [undefined, null, {}, { sound: true }, { sound: 'on' }, { sound: 0 }, { sound: null }, { sound: 'false' }, { sound: 'Thunk' }, { sound: 'loud' }]) {
    assert.equal(soundOf(p), SOUND_DEFAULT, JSON.stringify(p));
    assert.equal(soundOn(p), true, JSON.stringify(p));
  }
  for (const v of ['light', 'thunk', 'deep']) { assert.equal(soundOf({ sound: v }), v); assert.equal(soundOn({ sound: v }), true); }
  for (const off of [false, 'off']) { assert.equal(soundOf({ sound: off }), 'off'); assert.equal(soundOn({ sound: off }), false); }
  assert.equal(SOUND_DEFAULT, 'thunk');
  assert.equal(SOUND_DEFAULT, soundMod.DEFAULT_VOICE, 'settings.js and sound.js agree on the default voice');
  assert.deepEqual(soundMod.VOICES, ['light', 'thunk', 'deep']);
  assert.match(app, /sound: \{ opts: \[\['off', 'Off'\], \['light', 'Light'\], \['thunk', 'Thunk'\], \['deep', 'Deep'\]\], show: \(\) => soundOf\(prefs\), read: \(v\) => soundOf\(\{ sound: v \}\) \},/);
  assert.match(app, /\} else if \(key === 'sound'\) \{\n {4}sound\.setEnabled\(soundOn\(prefs\)\); sound\.setVoice\(soundOf\(prefs\)\);\n {4}if \(from === 'here' && soundOn\(prefs\)\) \{ sound\.unlock\(\); setTimeout\(\(\) => sound\.play\('flatBoard'\), 60\); \}/, 'a change applies at once and previews one place (not one from the account)');
  assert.equal((app.match(/sound\.play\('flatBoard'\)/g) || []).length, 1, 'the preview is only in the change handler, never at load');
  assert.match(app, /sound\.setEnabled\(soundOn\(prefs\)\); sound\.setVoice\(soundOf\(prefs\)\);\nsound\.listen\(\);/, 'applied at boot, gestures unlock');
  assert.match(app, /^hooks\.onPly = \(ptn, smash, info, b\) => \{ if \(inSight\(b\)\) sound\.playMove\(ptn, smash, info\); \};$/m, 'every board\'s moves click through one hook, a board out of sight silent');
  assert.match(app, /^hooks\.onCut = \(b\) => \{ if \(inSight\(b\)\) sound\.cut\(\); \};$/m, 'and a board out of sight cuts nothing (Rush\'s drops)');
  assert.match(app, /^const inSight = \(b\) => !b\?\.away && \(!b\?\.el\?\.getClientRects \|\| b\.el\.getClientRects\(\)\.length > 0\);/m); // (away: the puzzle page's PTN Ninja board while Rush has its frame)
  for (const f of ['public/board-kit.js', 'public/ninja.js']) assert.doesNotMatch(fs.readFileSync(root + f, 'utf8'), /import[^;]*sound\.js/, f + ' stays free of audio (node tests import it)');
});

test('engine arrows: no setting and no key (Sasha, 2026-11-21): nothing reads one', () => {
  assert.ok(!('arrowsOn' in SETTINGS), 'settings.js has no arrows setting');
  assert.doesNotMatch(app, /arrowsOn|prefs\.arrows|'arrows'|st-arrows|Engine arrows<|A key/);
  assert.doesNotMatch(app, /e\.key !== 'a'/, 'no A shortcut');
});

console.log(`all ${n} passed`);
