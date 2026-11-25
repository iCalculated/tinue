// Play on after a miss (public/freeplay.js): when the button is offered, what each way out does, the game-over words,
// take back; and source-level checks that app.js's free game can't report, log, hold or rate anything, nor touch a
// rated play-out.   node scripts/test-freeplay.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freeOffer, freeFrom, freeExit, freeOverText, takeBack, freeDefender, freeFailKey, cardSplice, freeFocus } from '../public/freeplay.js';
import { holds, phaseKey } from '../public/settings.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

// A plain miss, decided and sent: c3 at the puzzle's first position.
const MISS = { p: { id: 'x' }, status: 'retry', resultSent: true, busy: false, view: null, moves: [], misses: [{ at: 0, ptn: 'c3' }],
  checkPending: null, quickCheck: null, held: null, playOn: null, free: null, checking: null, refutation: { miss: 'c3', kind: 'refuted', reply: 'd4' } };

test('offered on a plain miss, decided and sent, wherever an engine defends', () => {
  assert.equal(freeOffer(MISS, { defender: 'syntaks' }), 'syntaks');
  assert.equal(freeOffer(MISS, { defender: 'tiltak' }), 'tiltak');
  assert.equal(freeOffer({ ...MISS, hinted: true, casual: true, casualWhy: 'hint' }, { defender: 'tiltak' }), 'tiltak', 'a casual miss too');
  assert.equal(freeOffer({ ...MISS, refutation: { miss: 'c3', kind: 'thinking' } }, { defender: 'syntaks' }), 'syntaks', 'while the reason is still being worked out');
  assert.equal(freeFrom(MISS), 'c3');
  // deeper in the puzzle: the latest miss is at this position
  const deep = { ...MISS, moves: [{ ptn: 'a1' }, { ptn: 'b2' }], misses: [{ at: 0, ptn: 'c3' }, { at: 2, ptn: 'e5' }] };
  assert.equal(freeOffer(deep, { defender: 'syntaks' }), 'syntaks');
  assert.equal(freeFrom(deep), 'e5');
});

test('never without an engine, or while anything about the result is open, or with a play-out', () => {
  assert.equal(freeOffer(MISS, { defender: null }), null, '7×7 and 8×8: no engine defends');
  const no = [
    ['no puzzle', null, {}],
    ['placeholder', { ...MISS, placeholder: true }, {}],
    ['result not sent', { ...MISS, resultSent: false }, {}],
    ['held check', { ...MISS, checkPending: { miss: 'c3' } }, {}],
    ['quick check', { ...MISS, quickCheck: { miss: 'c3' } }, {}],
    ['held results waiting on a check', { ...MISS, held: [{ win: false }] }, {}],
    ['a check running (Checking …)', { ...MISS, checking: 'd5' }, {}],
    ['rated play-out', { ...MISS, status: 'playon', playOn: { line: ['c3'] } }, {}],
    ['rated play-out, retry status', { ...MISS, playOn: { line: ['c3'] } }, {}],
    ['already playing on', { ...MISS, free: { line: ['c3'] } }, {}],
    ['a lost play-out\'s card', { ...MISS, refutation: { miss: 'c3', kind: 'playon', how: 'road' } }, {}],
    ['busy (the reset after the miss)', { ...MISS, busy: true }, {}],
    ['browsing an earlier position', { ...MISS, view: 0 }, {}],
    ['solved', { ...MISS, status: 'solved' }, {}],
    ['viewing the solution', { ...MISS, status: 'viewing' }, {}],
    ['before any miss', { ...MISS, status: 'play', misses: [] }, {}],
    ['latest miss at an earlier position', { ...MISS, moves: [{ ptn: 'a1' }, { ptn: 'b2' }] }, {}],
    ['held record (a resend is owed)', MISS, { held: true }],
    ['upload in flight', MISS, { uploading: true }],
  ];
  for (const [why, s, o] of no) assert.equal(freeOffer(s, { defender: 'syntaks', ...o }), null, why);
});

test('each way out: back and failed restore; hint and solution restore, then press; leaving restores nothing', () => {
  assert.deepEqual(freeExit('back', 'Syntaks'), { restore: true, press: null, note: null });
  assert.deepEqual(freeExit('hint', 'Syntaks'), { restore: true, press: 'hint', note: null });
  assert.deepEqual(freeExit('solution', 'Tiltak'), { restore: true, press: 'solution', note: null });
  assert.deepEqual(freeExit('failed', 'Syntaks'), { restore: true, press: null, note: 'Syntaks didn’t answer, so the game stopped.' });
  // the note sits on a card that says the miss counts: it mustn't read as a refund or a re-check
  for (const how of ['back', 'hint', 'solution', 'failed', 'left'])
    for (const t of [/record/i, /refund/i, /re-?check/i, /rating/i, /count/i]) assert.ok(!t.test(freeExit(how, 'Tiltak').note || ''), `${how}: ${t}`);
  assert.deepEqual(freeExit('left', 'Syntaks'), { restore: false, press: null, note: null });
  assert.throws(() => freeExit('gaveup'), /freeExit/, 'no other way out (Give up is the rated play-out\'s)');
});

test('the free game\'s engine runs in this browser: never crux\'s rated play-out lane', () => {
  assert.equal(freeDefender('syntaks', { syntaksHere: true, tiltakHere: true }), 'syntaks');
  assert.equal(freeDefender('syntaks', { syntaksHere: false, tiltakHere: true }), 'tiltak', 'no WASM SIMD (or no Worker): Tiltak, not crux');
  assert.equal(freeDefender('syntaks', { syntaksHere: false, tiltakHere: false }), null);
  assert.equal(freeDefender('tiltak', { syntaksHere: true, tiltakHere: true }), 'tiltak');
  assert.equal(freeDefender('tiltak', { tiltakHere: false }), null);
  assert.equal(freeDefender(null, { syntaksHere: true, tiltakHere: true }), null, '7×7 and 8×8');
  assert.equal(freeDefender('syntaks'), null);
});

test('the card names the engine that would really defend: not Syntaks once it has failed here', () => {
  const both = { syntaksHere: true, tiltakHere: true };
  for (const st of ['idle', 'loading', 'ready']) assert.equal(freeDefender('syntaks', { ...both, syntaksStatus: st }), 'syntaks', st);
  assert.equal(freeDefender('syntaks', { ...both, syntaksStatus: 'failed' }), 'tiltak', 'freeTurn swaps to Tiltak: the card says Tiltak');
  assert.equal(freeDefender('syntaks', { syntaksHere: true, tiltakHere: false, syntaksStatus: 'failed' }), null, 'none can: no button');
  assert.equal(freeDefender('tiltak', { ...both, syntaksStatus: 'failed' }), 'tiltak');
});

test('an engine that didn\'t answer this miss isn\'t offered for it again; another engine may be', () => {
  const both = { syntaksHere: true, tiltakHere: true };
  assert.equal(freeDefender('syntaks', { ...both, failed: ['syntaks'] }), 'tiltak');
  assert.equal(freeDefender('syntaks', { ...both, failed: ['syntaks', 'tiltak'] }), null);
  assert.equal(freeDefender('syntaks', { ...both, failed: ['tiltak'] }), 'syntaks', 'Tiltak failing doesn\'t take Syntaks away');
  assert.equal(freeDefender('syntaks', { syntaksHere: true, failed: ['syntaks'] }), null, 'Syntaks failed, no Tiltak here');
  assert.equal(freeDefender('tiltak', { ...both, failed: ['tiltak'] }), null);
  // keyed by puzzle, position and missed move: a later puzzle, or another miss, starts clean
  const k = freeFailKey('x', ['a1', 'f6'], 'c3');
  assert.notEqual(k, freeFailKey('y', ['a1', 'f6'], 'c3'));
  assert.notEqual(k, freeFailKey('x', ['a1', 'f6', 'c3', 'd4'], 'e5'));
  assert.notEqual(k, freeFailKey('x', ['a1', 'f6'], 'c4'));
  assert.equal(k, freeFailKey('x', ['a1', 'f6'], 'c3'));
});

test('the miss card isn\'t redrawn when only the Play on row appears (read out once)', () => {
  const acts = '<div class="actions"><button data-act="hint">Hint</button></div>';
  const body = '<div class="icon bad">✗</div><div class="body"><h2>That’s not the move</h2><p>d4 holds.</p></div>';
  const more = '<div class="more"><button data-act="free">Play on</button><span>…</span></div>';
  assert.deepEqual(cardSplice(body + acts, body + acts + more, acts), { before: null, after: more }, 'the row is added, the miss text stays');
  assert.deepEqual(cardSplice(body + acts + more, body + acts, acts), { before: null, after: '' }, 'and taken away');
  const body2 = body.replace('d4 holds.', 'd4 holds. It counts.');
  assert.deepEqual(cardSplice(body + acts + more, body2 + acts + more, acts), { before: body2, after: null }, 'the text changes: the row stays');
  assert.equal(cardSplice(undefined, body + acts, acts), null, 'first drawing: all of it');
  assert.equal(cardSplice(body, body + acts, acts), null, 'no buttons before: all of it');
  assert.equal(cardSplice(body + acts, body, acts), null);
});

test('keyboard focus: Play on and Back to the puzzle hand it to each other', () => {
  assert.equal(freeFocus('free'), 'free-back');
  assert.equal(freeFocus('free-back'), 'free');
  for (const a of ['hint', 'solution', 'next', 'free-undo', null, undefined]) assert.equal(freeFocus(a), null, String(a));
});

test('game over, plainly', () => {
  assert.equal(freeOverText({ winner: 2, kind: 'road' }, 1, 'Syntaks', false), 'Black made a road.');
  assert.equal(freeOverText({ winner: 1, kind: 'road' }, 2, 'Tiltak', false), 'White made a road.');
  assert.equal(freeOverText({ winner: 1, kind: 'road' }, 1, 'Syntaks', true), 'You made a road against Syntaks.');
  assert.equal(freeOverText({ winner: 2, kind: 'road' }, 1, 'Syntaks', true), 'Your move completed Black’s road.');
  assert.equal(freeOverText({ winner: 2, kind: 'flat' }, 1, 'Syntaks', false), 'Black won on flats.');
  assert.equal(freeOverText({ winner: 1, kind: 'flat' }, 1, 'Tiltak', true), 'You won on flats against Tiltak.');
  assert.equal(freeOverText({ winner: 0, kind: 'draw' }, 1, 'Syntaks', true), 'The game ended in a draw.');
  assert.equal(freeOverText(null, 1, 'Syntaks'), '');
  for (const t of ['re-check', 'recheck', 'refund', 'solved', 'rating']) assert.ok(!freeOverText({ winner: 1, kind: 'road' }, 1, 'Syntaks', true).includes(t));
});

test('take back: to the player\'s last turn, never past the engine\'s first answer', () => {
  // line: the missed move, the engine's answer, then the player's moves and the engine's
  assert.equal(takeBack(1), null); // the engine hasn't answered yet
  assert.equal(takeBack(2), null); // the free game's first position: Back to the puzzle instead
  assert.equal(takeBack(3), 2); // the player's move ended the game: take back only it
  assert.equal(takeBack(4), 2);
  assert.equal(takeBack(7), 6);
  assert.equal(takeBack(8), 6);
  assert.equal(takeBack(undefined), null);
});

test('Confirm moves: a free game\'s move is held like a play-out\'s, and a change drops it', () => {
  const s = { ...MISS, free: { line: ['c3', 'd4'], over: null, thinking: false } };
  assert.equal(holds(true, s, false), true);
  assert.equal(holds(true, { ...s, free: { ...s.free, thinking: true } }, false), false);
  assert.equal(holds(true, { ...s, free: { ...s.free, over: { winner: 2 } } }, false), false);
  assert.equal(holds(true, { ...s, busy: true }, false), false);
  assert.equal(holds(false, s, false), false);
  assert.notEqual(phaseKey(s), phaseKey(MISS), 'starting it');
  assert.notEqual(phaseKey(s), phaseKey({ ...s, free: { ...s.free, line: ['c3', 'd4', 'e5'] } }), 'a move');
  assert.notEqual(phaseKey(s), phaseKey({ ...s, free: { ...s.free, thinking: true } }), 'the engine thinking');
  assert.notEqual(phaseKey(s), phaseKey({ ...s, free: { ...s.free, over: {} } }), 'game over');
  assert.equal(phaseKey(MISS), phaseKey({ ...MISS }), 'unused, nothing changes');
});

// ---- app.js, source level ----
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const START = '// ---------- free game', END = '// ---------- end free game ----------';
// Code only: comments (which may name what the code must not call) are dropped before the checks.
const code = (src) => src.replace(/(^|\s)\/\/[^\n]*/g, '$1');
const section = code(app.slice(app.indexOf(START), app.indexOf(END)));
// A function's source, by brace matching from its first '{' (app.js's own code: balanced braces in strings too).
function fn(name) {
  const i = app.search(new RegExp(`(?<=^|\\n)(async )?function ${name}\\(`));
  assert.ok(i >= 0, `function ${name} in app.js`);
  let d = 0, j = app.indexOf('{', app.indexOf(')', i));
  for (let k = j; k < app.length; k++) { if (app[k] === '{') d++; else if (app[k] === '}' && --d === 0) return code(app.slice(i, k + 1)); }
  throw new Error(name);
}
const FORBIDDEN = [/\breport\(/, /settleCheck/, /abandonCheck/, /abandonQuick/, /\blogMove\(/, /\bshadow/, /heldRec\.(set|del)/, /\bstore\./,
  /startPlayOn/, /endPlayOn/, /playOnMove/, /defenderTurn/, /makeProven/, /\.playOn\s*=[^=]/, /checkPending\s*=[^=]/, /quickCheck\s*=[^=]/,
  /resultSent\s*=[^=]/, /\.misses\.(push|splice|length\s*=)/, /\.log\.(push|length\s*=)/, /decidedMs/, /\.held\b/, /\bapi\(/, /\bfetch\(/,
  /\/api\//, /nextQ/, /session\.push/, /\.unchecked/, /\.casual/, /\.outcome\s*=/, /\.status\s*=[^=]/, /\.delta\s*=/, /\.slowWin/, /\.proven/,
  /sendBeacon/, /\boutbox\b/, /syntaksReply/, /\.ctl\b/];

test('the free game section exists and calls nothing that reports, logs to the server or touches a held record', () => {
  assert.ok(app.includes(START) && app.includes(END) && app.indexOf(START) < app.indexOf(END) && section.length > 1000);
  for (const re of FORBIDDEN) assert.ok(!re.test(section), `free game section: ${re}`);
  // heldRec is only read (to keep the button away while a resend is owed)
  assert.deepEqual([...section.matchAll(/heldRec\.(\w+)/g)].map((m) => m[1]), ['get']);
});

test('it shares no engine code with the rated play-out: in-browser engines only, nothing over the network', () => {
  // (syntaksReply asks crux's /api/defend, a priority job that rated play-outs queue behind: FORBIDDEN has it)
  assert.match(section, /syntaks\.search\(/);
  assert.match(section, /tiltak\.analyze\(/);
  assert.match(fn('freeEngine'), /freeDefender\(playOnDefender\(\), here\)/, 'the offered engine runs here');
  // and everything the free section calls by name outside itself is known
  const called = new Set([...section.matchAll(/\b([a-zA-Z_]\w*)\(/g)].map((m) => m[1]));
  const defined = new Set([...section.matchAll(/(?:function (\w+)\(|const (\w+) = \()/g)].map((m) => m[1] || m[2]));
  const allowed = new Set(['freeOffer', 'freeFrom', 'freeExit', 'takeBack', 'playOnDefender', 'gameAt', 'elapsed', 'dropPending', 'ptnFor',
    'syntaksReply', 'legalMove', 'renderAll', 'restoreBoard', 'flushHint', 'setTimeout', 'Promise', '$', 'then', 'catch', 'finally', 'race',
    'resolve', 'map', 'has', 'get', 'add', 'result', 'play', 'toTPS', 'load', 'last', 'append', 'ui', 'setPlayer', 'highlight', 'focus',
    'supports', 'warmup', 'analyze', 'stop', 'if', 'return', 'WeakSet', 'freeOverText', 'push', 'freeDefender', 'search', 'status',
    'Map', 'set', 'freeFailKey']);
  for (const c of called) assert.ok(defined.has(c) || allowed.has(c), `free game calls ${c}()`);
});

test('the rated play-out never reaches the free game, and the free game is entered only by its button', () => {
  for (const name of ['startPlayOn', 'defenderTurn', 'playOnMove', 'showPlayOn', 'endPlayOn', 'makeProven', 'settleCheck', 'report',
    'abandonCheck', 'abandonQuick', 'flushHeld', 'syntaksReply', 'fail', 'solved', 'slowSolve'])
    assert.ok(!/free|Free/.test(fn(name)), `${name} mentions the free game`);
  assert.equal(app.match(/\bstartFree\(/g).length, 2, 'startFree: defined, and called once');
  assert.match(app, /if \(act === 'free'\) return startFree\(\);/);
  assert.match(fn('startFree'), /^function startFree\(\) \{\n {2}const s = S, engine = freeEngine\(s\);\n {2}if \(!engine\) return;/, 'startFree asks freeOffer first');
  assert.match(fn('freeEngine'), /freeOffer\(s, \{ defender: freeDefender\(playOnDefender\(\), here\), held: heldRec\.get\(\)\?\.id === s\.p\.id, uploading: !!up \}\)/);

  // what the card names is what freeTurn would play: Syntaks's state on this page, and engines that failed this miss
  assert.match(fn('freeEngine'), /syntaksStatus: syntaks\.status\(\)/);
  assert.match(fn('freeEngine'), /failed: s\.misses\?\.length \? freeFails\.get\(freeFailKey\(s\.p\.id, freeBase\(s\), freeFrom\(s\)\)\) \?\? \[\] : \[\]/);
  const ft = fn('freeTurn');
  assert.match(ft, /if \(!mv\) freeFailed\(s, fg, 'syntaks'\);\n\s*if \(!mv && tiltak\.supports/, 'Syntaks not answering is remembered');
  assert.match(ft, /if \(!mv\) \{ if \(fg\.engine === 'tiltak'\) freeFailed\(s, fg, 'tiltak'\); return leaveFree\(s, 'failed'\); \}/, 'Tiltak too');
  assert.equal(app.match(/\bfreeFails\.set\(/g).length, 1, 'remembered in one place, in memory only');
});

test('every way out of the free game goes through leaveFree before anything else happens', () => {
  assert.match(fn('userMove'), /if \(S\.status === 'solved'\) return explore\(ptn\);\n {2}if \(S\.free\) return freeMove\(ptn\);/, 'userMove: a free game\'s move goes to freeMove before anything judges it');
  assert.match(fn('showHint'), /^function showHint\(\) \{\n {2}if \(S\?\.free\) return leaveFree\(S, 'hint'\);/);
  assert.match(fn('showSolution'), /^async function showSolution\(\) \{\n(\s*\/\/.*\n)*\s*if \(S\?\.free\) return leaveFree\(S, 'solution'\);/);
  assert.match(fn('start'), /^async function start\(p, theme = '', p0 = p\) \{\n {2}if \(S\?\.free\) leaveFree\(S, 'left'\);/);
  assert.match(fn('viewPly'), /if \(S\.playOn \|\| S\.free\) return;/);
  assert.match(fn('leaveFree'), /s\.free = null;/);
});

test('the miss card is drawn once when the result is answered (an aria-live card read out once)', () => {
  // report() marks its upload done before its own renderAll, so that drawing already has Play on: the freeWake redraw
  // a tick later is then the same HTML and skipped (renderFeedback compares fb._html)
  const src = fn('report'), del = src.indexOf('uploading.delete(p.id)', src.indexOf('await req')), draw = src.lastIndexOf('renderAll()');
  assert.ok(del > 0 && del < draw, 'report: the upload is marked done before the card is drawn');
  assert.match(src, /if \(uploading\.get\(p\.id\) === req\) uploading\.delete\(p\.id\);/, 'only its own upload');
});

test('the card keeps Hint | Solution first and keyboard focus moves across the switch', () => {
  const rf = fn('renderFeedback');
  for (const m of rf.matchAll(/\$\{(more|playActions)\}\$\{(more|playActions)\}/g)) assert.deepEqual([m[1], m[2]], ['playActions', 'more'], 'Tab order follows the screen');
  assert.equal([...rf.matchAll(/\$\{playActions\}\$\{more\}/g)].length, 3);
  assert.match(rf, /pick\(fbFocus\) \|\| pick\(freeFocus\(fbFocus\)\)/);
  assert.match(rf, /cardSplice\(fb\._html, fbHtml, playActions\)/, 'the text-only redraw redraws only the side that changed');
  assert.match(rf, /if \(part\.before != null\) \{ kids\.slice\(0, k\)\.forEach\(\(el\) => el\.remove\(\)\); acts\.insertAdjacentHTML\('beforebegin', part\.before\); \}/);
  assert.match(rf, /if \(part\.after != null\) \{ kids\.slice\(k \+ 1\)\.forEach\(\(el\) => el\.remove\(\)\); acts\.insertAdjacentHTML\('afterend', part\.after\); \}/);
  assert.ok(!/el !== acts\) el\.remove\(\)/.test(rf), 'not everything but the buttons');
});

console.log(`${n} free-game tests passed`);
