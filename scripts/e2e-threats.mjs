// The analysis view's Threats toggle, end to end: the real server (server/server.js) on a new database with two
// fixture puzzles, and the real page in headless Chrome. The opponent's threats (the red line under the engine lines; the
// board is PTN Ninja's, served by a local stand-in, which draws no rings or arrows: line 1's squares are highlighted) are off by default, as on Lichess (Sasha, 2026-11-22); the Threats button or
// x shows them, x only while the analysis view is shown (not while solving, not in a field); they stay on while
// stepping through the puzzle, and the next puzzle starts with them off; turning them on or off moves nothing above the
// threat line (measured), beside the board and in the phone's dock; the production build (window.TINUE_ANALYSIS false)
// has no button, and x there changes nothing.
// Not part of npm test (it needs Chrome):  node scripts/e2e-threats.mjs [shots dir]
// Ports: $E2E_PORT (default 9351) for the server, +1 for DevTools. Its database and Chrome profile live in a new
// directory under $E2E_TMP (else the system's temporary directory), removed at the end. The server has no Syntaks
// (TINUE_SYNTAKS unset to a missing file): 6×6 lines come from the solver, the threats from the tactics worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standin, STANDIN_ARGS, STANDIN_PATTERN } from './e2e-standin.mjs'; // (PTN Ninja, the only board: a local stand-in)
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.argv[2] || null;
const PORT = +process.env.E2E_PORT || 9351, DT = PORT + 1, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'tinue-e2e-threats-'));
const DB = path.join(dir, 'e2e.db');
let n = 0;
const kids = [];
process.on('exit', () => { for (const k of kids) try { k.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const watchdog = setTimeout(() => { console.log('timed out after 300 s at step', n + 1); for (const k of kids) try { k.kill(); } catch {} process.exit(2); }, 300000);
const step = (s) => { n++; console.log('ok', s); };

// ---------- the server ----------
let server = null;
const boot = () => new Promise((resolve, reject) => {
  const env = { ...process.env, PORT: String(PORT), TINUE_DB: DB, TINUE_ACCESS_LOG: path.join(dir, 'access.log'), TINUE_SYNTAKS: '/nonexistent', TINUE_LOG: '0' };
  delete env.TINUE_ORIGINS;
  const c = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server/server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  c.stdout.on('data', (d) => { if (String(d).includes('tinue on')) resolve(c); });
  c.on('exit', (code) => reject(new Error('server exited ' + code)));
  server = c; kids.push(c);
});
await boot(); server.kill(); await new Promise((r) => server.once('exit', r)); // (the schema)
// Two 6×6 puzzles: thr19's first position has Black threatening four ways; thr12's has no threats.
const PUZZLES = [
  { id: 'thr19', tps: 'x2,1,2,x2/1,2,2,2,2,11/12,1,1,x2,1C/22,x,2,1,21,1/2,1111,11,2,x,2/2,2,12,2,2,1 1 25', tree: { '4b2>1111': { r: 'e1>', n: 'win' } }, turn: 1 },
  { id: 'thr12', tps: '1,x,1,x,1,1/2,2,1,2,12,x/1,2,2,1,x,1/2,2,1S,2,x2/1,x,2,2,2,x/2,2,1,x2,1 2 17', tree: { Cb2: { r: 'Sf2', n: 'win' }, Cf2: { r: 'Sb2', n: 'win' } }, turn: 2 },
];
{
  const db = new DatabaseSync(DB);
  const ins = db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, source_ref, init_rating, rating, komi, turn, grade) VALUES (?, 6, ?, 3, ?, '', 'playtak', '1', 1500, 1500, 0, ?, 'A')`);
  for (const p of PUZZLES) ins.run(p.id, p.tps, JSON.stringify(p.tree), p.turn);
  db.close();
}
await boot();

// ---------- Chrome ----------
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${path.join(dir, 'chrome')}`, '--no-first-run', '--no-default-browser-check', ...STANDIN_ARGS,
  '--mute-audio', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
kids.push(chrome);
let ws, id = 0;
const pending = new Map(), errors = [], paused = [];
for (let i = 0; i < 50 && !ws; i++) {
  try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch {}
  await sleep(200);
}
if (!ws) throw new Error('no Chrome page to drive');
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; setTimeout(() => j(new Error('DevTools socket never opened')), 10000); });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  else if (m.method === 'Fetch.requestPaused') paused.push(m.params);
};
const cdp = (method, params = {}) => new Promise((r, j) => { const i = ++id, t = setTimeout(() => { pending.delete(i); j(new Error('no answer to ' + method)); }, 15000); pending.set(i, (m) => { clearTimeout(t); if (m.error) j(new Error(method + ': ' + m.error.message)); else r(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' in ' + expr.slice(0, 120)); return r.result?.value; };
const until = async (expr, what, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return; await sleep(100); } throw new Error('timed out: ' + what + ' errors: ' + JSON.stringify(errors)); };
const size = (w, h, mobile = false) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await ev('(scrollTo(0, 0), true)'); await sleep(300); fs.writeFileSync(path.join(SHOTS, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
const key = async (k, code = 'Key' + k.toUpperCase(), vk = k.toUpperCase().charCodeAt(0)) => {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k.length === 1 ? k : undefined });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
const arrow = (dir) => key(dir === 1 ? 'ArrowRight' : 'ArrowLeft', dir === 1 ? 'ArrowRight' : 'ArrowLeft', dir === 1 ? 39 : 37);
const click = async (sel) => {
  const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; let b = e.getBoundingClientRect(); if (b.top < 0 || b.bottom > innerHeight) { e.scrollIntoView({ block: 'nearest' }); b = e.getBoundingClientRect(); } return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  assert.ok(r, 'nothing to click at ' + sel);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
await cdp('Runtime.enable'); await cdp('Page.enable');
// Read-only handles on the page's state (app.js's S and board), appended to the served app.js; the repository is untouched.
await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/app.js*', requestStage: 'Response' }, STANDIN_PATTERN] });
setInterval(async () => {
  for (const p of paused.splice(0)) {
    try {
      if (await standin(cdp, p, process.env.E2E_NINJA || 'ok')) continue;
      const body = await cdp('Fetch.getResponseBody', { requestId: p.requestId });
      const src = (body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body) + '\n;window.__e2e = { S: () => S, board: () => board };\n';
      await cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: p.responseStatusCode || 200, responseHeaders: (p.responseHeaders || []).filter((h) => !/^content-length$/i.test(h.name)), body: Buffer.from(src).toString('base64') });
    } catch (e) { cdp('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); }
  }
}, 20);
// The production build: config.js's TINUE_ANALYSIS held at false (its own assignment ignored)
let prodScript = null;
const production = async (on) => {
  if (on) prodScript = (await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'TINUE_ANALYSIS', { get: () => false, set() {}, configurable: false });` })).identifier;
  else if (prodScript) { await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: prodScript }); prodScript = null; }
};
const load = async (at) => {
  await cdp('Page.navigate', { url: BASE + '/LICENSE.txt' }); await sleep(150);
  await ev('(localStorage.clear(), sessionStorage.clear(), true)');
  await cdp('Page.navigate', { url: BASE + at });
  await until(`document.readyState === 'complete' && !!window.__e2e`, 'the page');
};

// ---------- what the page shows ----------
const S = 'window.__e2e.S()';
const ready = `${S} && !${S}.placeholder && ${S}.t0 != null && !${S}.busy`;
// Solve whatever puzzle is shown, in the page's own labels: the tree's first move, else a win in 1.
async function solve() {
  await until(ready, 'puzzle ready');
  await sleep(700);
  for (let k = 0; k < 6 && !(await ev(`${S}.status === 'solved'`)); k++) {
    const mv = await ev(`(async () => { const s = ${S}, T = await import('/shared/tak.js'); const g = T.Game.fromTPS(s.p.tps, s.p.komi || 0); for (const m of s.moves) g.play(m.ptn);
      if (s.node && typeof s.node === 'object') return Object.keys(s.node)[0]; return T.winningMoves(g, 1).moves[0]; })()`);
    const before = await ev(`${S}.moves.length`);
    assert.ok(await ev(`window.__e2e.board().play(${JSON.stringify(mv)})`), 'could not play ' + mv);
    await until(`(${S}.moves.length >= ${before + 2} && !${S}.busy) || ${S}.status === 'solved'`, 'the reply', 15000);
    await sleep(300);
  }
  await until(`${S}.status === 'solved' && !!document.querySelector('#moves .eng')`, 'solved');
}
// At the puzzle's first position (⏮), its analysis in (the solver's threats known)
const toFirst = async () => { await click('#moves button[data-step="first"]'); await until(`${S}.view === 0 && ${S}.sol && ${S}.evalKey === ''`, 'the first position analysed'); await sleep(400); };
const st = () => ev(`(() => { const b = document.querySelector('#moves [data-thr]'), t = document.querySelector('#moves .threat');
  return { thr: ${S}.thr ?? null, button: b ? { pressed: b.getAttribute('aria-pressed'), name: b.textContent.trim(), title: b.title } : null, text: t ? t.textContent : null,
    marks: document.querySelectorAll('#board svg, #board .tb-sq').length, best: (window.__e2e.board().shapeKey || '').split(' ').filter(Boolean).length, threats: (${S}.sol?.threats || []).length, ana: !!document.querySelector('#moves .eng.ana') }; })()`);
// Every box above the threat line (and the board, the step buttons), to the pixel
const rects = (sels) => ev(`scrollTo(0, 0), (${JSON.stringify(sels)}).flatMap((s) => [...document.querySelectorAll(s)].map((e, i) => { const r = e.getBoundingClientRect(); return s + '#' + i + ' ' + [r.left, r.top, r.width, r.height].map((v) => v.toFixed(1)).join(','); }))`);
const ABOVE = ['#board', '#moves .eng-h', '#moves .cbar', '#moves .rws', '#moves .ln', '#moves .thr-t', '#moves .nav'];
const ABOVE_DOCK = ['#board', '#moves .dock .eng-slot', '#moves .chips', '#moves .chip', '#moves .eng-b', '#moves .thr-t', '#moves .nav'];
const showsThreats = (s, where) => { assert.equal(s.marks, 0, where + ': nothing drawn over PTN Ninja ' + JSON.stringify(s)); assert.match(s.text || '', /^(Tak by|Tinuë by|\w+ threatens)/, where + ': the threat line'); };
const showsNone = (s, where) => { assert.equal(s.marks, 0, where + ': nothing drawn over PTN Ninja ' + JSON.stringify(s)); assert.equal(s.text, null, where + ': no threat line'); };

// ---------- 1. off by default; the button and x; nothing above the threat line moves ----------
await size(1280, 800);
await load('/#/puzzle/thr19');
await until(ready, 'puzzle ready');
await key('x'); await sleep(200);
let s = await st();
assert.equal(s.button, null, 'solving: no Threats button');
assert.equal(s.thr, null, 'solving: x does nothing');
step('while solving there is no Threats button and x does nothing');
await solve();
await toFirst();
s = await st();
assert.ok(s.threats > 0, 'the fixture has threats at its first position');
assert.deepEqual(s.button && [s.button.pressed, s.button.name], ['false', 'Threats'], 'the button, unpressed');
assert.match(s.button.title, /\(x\)/, 'its title names the key');
assert.ok(s.best > 0, 'line 1 is highlighted on PTN Ninja (its squares)');
showsNone(s, 'by default');
step('off by default: a Threats button (unpressed, titled with its key), no threat line; line 1 highlighted on PTN Ninja');
await shot('d-off.png');
const r0 = await rects(ABOVE);
await click('#moves [data-thr]'); await sleep(300);
s = await st();
assert.equal(s.button.pressed, 'true'); assert.equal(s.thr, true);
showsThreats(s, 'the button on');
assert.ok(s.best > 0, 'line 1 still highlighted on PTN Ninja with the threats on');
assert.equal(await ev(`document.activeElement?.matches('[data-thr]')`), true, 'the button keeps focus through the redraw');
assert.deepEqual(await rects(ABOVE), r0, 'nothing above the threat line moved');
step('the button: on shows the threat line (nothing drawn over the board); the button keeps focus; nothing above it moved');
await shot('d-on.png');
await ev('(document.activeElement.blur(), true)');
await key('x'); await sleep(300);
s = await st(); assert.equal(s.button.pressed, 'false'); showsNone(s, 'x off');
assert.deepEqual(await rects(ABOVE), r0, 'nothing moved (x off)');
await key('x'); await sleep(300);
s = await st(); assert.equal(s.button.pressed, 'true'); showsThreats(s, 'x on');
step('x toggles them in the analysis view, both ways, and nothing above the threat line moves');
// x in a field or with a modifier: nothing
await ev(`(() => { const i = document.createElement('input'); i.id = 'e2e-field'; document.body.append(i); i.focus(); return true; })()`);
await key('x'); await sleep(200);
assert.equal((await st()).thr, true, 'typing x in a field');
await ev(`(document.querySelector('#e2e-field').remove(), true)`);
await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, modifiers: 4 }); // (meta)
await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, modifiers: 4 });
await sleep(200);
assert.equal((await st()).thr, true, 'Cmd+x');
step('x in a text field, or with a modifier, does nothing');

// ---------- 2. kept while stepping ----------
for (const [dir, what] of [[1, 'forward'], [1, 'forward'], [-1, 'back'], [-1, 'back']]) {
  await arrow(dir);
  await until(`${S}.evalKey === ${S}.hist.concat(${S}.moves.map((m) => m.ptn)).slice(0, ${S}.view ?? 99).join(' ') && ${S}.sol`, 'analysed after ' + what);
  await sleep(400);
  s = await st();
  assert.equal(s.thr, true, 'still on after stepping ' + what);
  assert.equal(s.button?.pressed, 'true');
  if (s.threats) showsThreats(s, 'after ' + what); else assert.equal(s.marks, 0);
}
s = await st(); showsThreats(s, 'back at the first position');
step('on stays on while stepping through the puzzle (the line follows each position)');
// a position with no threats (the end, a won game): the button stays, on shows nothing more
await click('#moves button[data-step="last"]'); await sleep(1200);
s = await st();
assert.equal(s.button?.pressed, 'true'); assert.equal(s.marks, 0); assert.equal(s.text, null);
const rEnd = await ev(`JSON.stringify(document.querySelector('#moves .thr-t').getBoundingClientRect())`);
await key('x'); await sleep(250);
assert.equal(await ev(`JSON.stringify(document.querySelector('#moves .thr-t').getBoundingClientRect())`), rEnd, 'the button stays put');
await key('x'); await sleep(250);
step('a position without threats: the button stays in place, on adds nothing');
// x on another page (Settings, Rush): the solved puzzle's view is only hidden there, its button still in the DOM; x
// does nothing, and coming back to the puzzle finds the threats as they were
const viewShown = (v) => `!document.querySelector('#${v}').classList.contains('hidden') && document.querySelector('#view-puzzle').classList.contains('hidden')`;
for (const [hash, v] of [['#/settings', 'view-settings'], ['#/rush', 'view-rush']]) {
  await ev(`(location.hash = ${JSON.stringify(hash)}, true)`);
  await until(viewShown(v), hash + ' shown'); await sleep(300);
  assert.equal(await ev(`document.querySelector('#moves [data-thr]')?.getAttribute('aria-pressed')`), 'true', hash + ': the hidden button is still there');
  await key('x'); await sleep(250);
  assert.equal(await ev(`${S}.thr`), true, hash + ': x does nothing');
  assert.equal(await ev(`document.querySelector('#moves [data-thr]')?.getAttribute('aria-pressed')`), 'true', hash + ': the button unchanged');
}
await ev(`(location.hash = '#/puzzle/thr19', true)`);
await until(`!document.querySelector('#view-puzzle').classList.contains('hidden') && ${S}.status === 'solved' && !!document.querySelector('#moves [data-thr]')`, 'back at the puzzle');
await sleep(400);
s = await st(); assert.equal(s.thr, true, 'back at the puzzle: still on'); assert.equal(s.button?.pressed, 'true');
step('x on Settings and on Rush does nothing; back at the puzzle the threats are as they were');

// ---------- 3. the phone's dock ----------
await click('#moves button[data-step="first"]'); await sleep(300);
await size(390, 844, true); await sleep(900);
await until(`!!document.querySelector('#moves .dock .eng.ana.docked [data-thr]')`, 'the dock\'s Threats button');
s = await st(); assert.equal(s.button.pressed, 'true'); showsThreats(s, 'docked, still on');
const p1 = await rects(ABOVE_DOCK);
await click('#moves .dock [data-thr]'); await sleep(300);
s = await st(); assert.equal(s.button.pressed, 'false'); showsNone(s, 'docked off');
assert.deepEqual(await rects(ABOVE_DOCK), p1, 'docked: nothing above the threat line moved');
const bh = await ev(`document.querySelector('#moves .dock [data-thr]').getBoundingClientRect().height`);
assert.ok(bh >= 28, 'a finger-sized button in the dock: ' + bh);
// ... and wholly inside its row (.eng-b, 32 px, overflow hidden: a taller button would be cut) and on screen
const fit = await ev(`(() => { const b = document.querySelector('#moves .dock [data-thr]').getBoundingClientRect(), r = document.querySelector('#moves .dock .eng-b').getBoundingClientRect();
  return { b: [b.left, b.top, b.right, b.bottom], r: [r.left, r.top, r.right, r.bottom], w: innerWidth }; })()`);
assert.ok(fit.b[1] >= fit.r[1] - 0.5 && fit.b[3] <= fit.r[3] + 0.5 && fit.b[0] >= fit.r[0] - 0.5 && fit.b[2] <= Math.min(fit.r[2], fit.w) + 0.5, 'the dock\'s button inside its row and on screen ' + JSON.stringify(fit));
await shot('p-off.png');
await click('#moves .dock [data-thr]'); await sleep(300);
showsThreats(await st(), 'docked on');
assert.deepEqual(await rects(ABOVE_DOCK), p1, 'docked: nothing moved (on)');
await shot('p-on.png');
step('the phone\'s dock: its own button (28 px), the same toggle; the board, chips and the selected line\'s row never move');
await size(1280, 800); await sleep(600);

// ---------- 4. the next puzzle starts with them off ----------
const born = await ev(`${S}.born`);
await until(`!!document.querySelector('#feedback [data-act="next"]')`, 'Next');
await click('#feedback [data-act="next"]');
await until(`${S} && ${S}.born !== ${born} && !${S}.placeholder`, 'the next puzzle');
await until(ready, 'next puzzle ready');
s = await st(); assert.equal(s.thr, null, 'a new puzzle: off'); assert.equal(s.button, null); assert.equal(s.marks, 0);
await solve(); await toFirst();
s = await st();
assert.equal(s.button?.pressed, 'false', 'the next puzzle\'s analysis: unpressed');
showsNone(s, 'the next puzzle');
step('the next puzzle starts with the threats off');
// a reload: off as well (nothing stored)
await load('/#/puzzle/thr19'); await solve(); await toFirst();
showsNone(await st(), 'after a reload');
// (after a toggle: nothing of it in this browser's storage)
await click('#moves [data-thr]'); await sleep(300);
const stored = await ev(`Object.keys(localStorage).filter((k) => /\\bthr\\b|threat/i.test(k) || /"thr"|threat/i.test(localStorage.getItem(k)))`);
assert.deepEqual(stored, [], 'nothing stored');
await click('#moves [data-thr]'); await sleep(300);
step('a page load starts with them off; nothing is stored');

// ---------- 5. the production build ----------
await production(true);
await load('/#/puzzle/thr19');
assert.equal(await ev('window.TINUE_ANALYSIS'), false);
await solve();
await click('#moves button[data-step="first"]'); await sleep(2500);
const before = await ev(`document.querySelector('#moves').innerHTML`);
assert.equal(await ev(`!!document.querySelector('#moves [data-thr], #moves .eng.ana, #moves .threat')`), false, 'no Threats button, no analysis view');
await key('x'); await sleep(400);
assert.equal(await ev(`document.querySelector('#moves').innerHTML`), before, 'x changes nothing');
assert.equal(await ev(`${S}.thr ?? null`), null);
assert.equal(await ev(`document.querySelectorAll('#board svg, #board .tb-sq').length`), 0, 'no shapes on the board');
step('the production build: no Threats button, and x changes nothing');
await production(false);

assert.deepEqual(errors, [], 'page errors');
clearTimeout(watchdog);
console.log(`\nOK: ${n} threat toggle steps`);
process.exit(0);
