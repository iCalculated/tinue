// PTN Ninja is the only board (Sasha, 2026-11-22: "switch entirely to ptn ninja with no fallback ... keep the code for
// our board for now but please have it hard fail if loaded"), end to end on the puzzle page: the real server
// (server/server.js) on a new database with two fixture puzzles, the real page in headless Chrome, and a local stand-in
// for https://ptn.ninja (scripts/e2e-standin.mjs; E2E_REAL=1 adds a last phase of pictures on the real embed).
//   board    every old stored, synced or address value of the Board setting gets PTN Ninja's board, playable
//   retired  new Board() throws at once, with its message, on the dev page and on the built production and beta pages
//            (SITE=<dir> holding tinue/ and tinue-beta/ built with this server's address as their API, see below);
//            no page loads board.js by itself
//   oldhtml  an index.html cached from before (33228e6: it starts no frame unless the old setting said PTN Ninja) with
//            this app.js: the page starts the frame itself, and the puzzle plays on it
//   never    a frame that never comes up: the message with Retry in the board's place; nothing judged, nothing posted,
//            no clock, Hint/Solution/the move box off, Enter is not Next; Retry (PTN Ninja up now): the puzzle plays
//   block    ptn.ninja refusing the connection: the same message
//   died     a frame that stops answering after the first move: the message ('stopped'); nothing posted for the
//            puzzle meanwhile; Retry puts the position back as it was and the puzzle is solved from there
//   slow     a frame whose page arrives only after 20 s (a slow first visit), one up 6 s late (slow but healthy): no message at any time, then playable; one 300 ms slow to answer
//            each position: never declared dead
// Not part of npm test (it needs Chrome):  node scripts/e2e-ptn-only.mjs [shots dir]
// Builds for 'retired' (optional; skipped without SITE):  SITE=<dir> STUBS=none sh scripts/build-static.sh http://127.0.0.1:<E2E_PORT>
//   and SITE=<dir> sh scripts/build-beta.sh http://127.0.0.1:<E2E_PORT>
// Ports: $E2E_PORT (default 9761) for the server, +1 for DevTools, +2 for the built pages. Its database and Chrome
// profile live in a new directory under $E2E_TMP (else the system's temporary directory), removed at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { standin, STANDIN_ARGS, STANDIN_PATTERN, stats } from './e2e-standin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.argv[2] || null;
const SITE = process.env.SITE || null, REAL = !!process.env.E2E_REAL;
const PORT = +process.env.E2E_PORT || 9761, DT = PORT + 1, SP = PORT + 2, BASE = `http://127.0.0.1:${PORT}`;
const MSG = "tinue's own board is retired: PTN Ninja is the only board";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'tinue-e2e-ptn-only-'));
const DB = path.join(dir, 'e2e.db');
let n = 0;
const kids = [];
process.on('exit', () => { for (const k of kids) try { k.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const watchdog = setTimeout(() => { console.log('timed out after 400 s at step', n + 1); process.exit(2); }, 400000);
const step = (s) => { n++; console.log('ok', s); };
const timings = {};

// ---------- the server ----------
const boot = () => new Promise((resolve, reject) => {
  const env = { ...process.env, PORT: String(PORT), TINUE_DB: DB, TINUE_ACCESS_LOG: path.join(dir, 'access.log'), TINUE_SYNTAKS: '/nonexistent', TINUE_LOG: '0' };
  env.TINUE_ORIGINS = `http://127.0.0.1:${SP}`; // (the built pages call this API from their own origin; no dev pages needed)
  const c = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server/server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  c.stdout.on('data', (d) => { if (String(d).includes('tinue on')) resolve(c); });
  c.on('exit', (code) => reject(new Error('server exited ' + code)));
  kids.push(c);
});
{ const c = await boot(); c.kill(); await new Promise((r) => c.once('exit', r)); } // (the schema)
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
// the built pages (SITE/tinue, SITE/tinue-beta), served as files
if (SITE) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(SITE, path.normalize(p));
    if (!f.startsWith(path.resolve(SITE)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(SP, '127.0.0.1', r));
  process.on('exit', () => srv.close());
}

// ---------- Chrome ----------
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${path.join(dir, 'chrome')}`, '--no-first-run', '--no-default-browser-check',
  ...STANDIN_ARGS, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
kids.push(chrome);
let ws, id = 0, mode = 'ok', oldHtml = null;
const pending = new Map(), errors = [], posts = [];
for (let i = 0; i < 50 && !ws; i++) {
  try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch {}
  await sleep(200);
}
if (!ws) throw new Error('no Chrome page to drive');
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; setTimeout(() => j(new Error('DevTools socket never opened')), 10000); });
const cdp = (method, params = {}) => new Promise((r, j) => { const i = ++id, t = setTimeout(() => { pending.delete(i); j(new Error('no answer to ' + method)); }, 20000); pending.set(i, (m) => { clearTimeout(t); m.error ? j(new Error(method + ': ' + m.error.message)) : r(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
// Requests: ptn.ninja is the stand-in (or blocked, or the real one); app.js gets read-only handles on the page's state
// appended (the repository is untouched).
async function paused(p) {
  if (await standin(cdp, p, () => mode)) return;
  if (p.resourceType === 'Document' && p.responseStatusCode == null) {
    const u = new URL(p.request.url);
    if (oldHtml && u.origin === BASE && u.pathname === '/') return cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }, { name: 'cache-control', value: 'no-store' }], body: Buffer.from(oldHtml).toString('base64') }).catch(() => {});
    return cdp('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  }
  try {
    const b = await cdp('Fetch.getResponseBody', { requestId: p.requestId });
    const src = (b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body) + '\n;window.__e2e = { S: () => S, board: () => board };\n';
    await cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: p.responseStatusCode || 200, responseHeaders: (p.responseHeaders || []).filter((h) => !/^content-length$/i.test(h.name)), body: Buffer.from(src).toString('base64') });
  } catch { cdp('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); }
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  else if (m.method === 'Fetch.requestPaused') paused(m.params);
  else if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'POST' && /\/api\/(move|result)\b/.test(m.params.request.url)) { posts.push(new URL(m.params.request.url).pathname); try { results.push({ path: new URL(m.params.request.url).pathname, body: JSON.parse(m.params.request.postData || 'null') }); } catch {} }
};
const results = []; // (what was posted: the solve time's check)
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' in ' + expr.slice(0, 120)); return r.result?.value; };
const until = async (expr, what, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return Date.now() - t; await sleep(100); } throw new Error('timed out: ' + what + ' errors: ' + JSON.stringify(errors)); };
const size = (w, h, mobile = false) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await ev('(scrollTo(0, 0), true)'); await sleep(350); fs.writeFileSync(path.join(SHOTS, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); };
await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
await cdp('Fetch.enable', { patterns: [STANDIN_PATTERN, { urlPattern: `${BASE}/app.js*`, requestStage: 'Response' }, { urlPattern: `${BASE}/*`, resourceType: 'Document' }] });
await size(1280, 800);
// The production build: config.js's TINUE_ANALYSIS held at false
let prodScript = null;
const production = async (on) => {
  if (on && !prodScript) prodScript = (await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'TINUE_ANALYSIS', { get: () => false, set() {}, configurable: false });` })).identifier;
  if (!on && prodScript) { await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: prodScript }); prodScript = null; }
};
// A fresh load with this browser's storage set to exactly ls, at the address `at`
async function load(at, ls = {}, base = BASE) {
  await cdp('Page.navigate', { url: base + '/LICENSE.txt' }); await sleep(150);
  await ev(`(localStorage.clear(), sessionStorage.clear(), ${JSON.stringify(Object.entries(ls))}.forEach(([k, v]) => localStorage.setItem('tinue.' + k, JSON.stringify(v))), true)`);
  const t0 = Date.now();
  await cdp('Page.navigate', { url: base + at });
  await until(`document.readyState !== 'loading' && !!document.querySelector('#board')`, 'the page');
  return t0;
}

// ---------- what the page shows ----------
const S = 'window.__e2e.S()';
const playable = `!!window.__e2e && ${S} && !${S}.placeholder && ${S}.t0 != null && !${S}.busy && !document.querySelector('#ptn-in').disabled`;
const onlyNinja = `!!document.querySelector('#board iframe[src^="https://ptn.ninja/"]') && !document.querySelector('.tb-sq, #board .tb, #rush-board .tb')`;
const down = (kind) => `document.querySelector('#board .board-down')?.dataset.kind === '${kind}' && !document.querySelector('#board .board-down button').hidden`;
const card = () => ev(`document.querySelector('#feedback')?.textContent.trim().replace(/\\s+/g, ' ')`);
// The state of a puzzle the player can't play: nothing timed, judged or open to input
async function nothingOpen(where) {
  const st = await ev(`(() => { const s = ${S}, f = document.querySelector('#feedback'); return { t0: s?.t0 ?? null, moves: s?.moves?.length ?? 0, status: s?.status, input: document.querySelector('#ptn-in').disabled,
    hint: f.querySelector('[data-act="hint"]')?.disabled ?? true, sol: f.querySelector('[data-act="solution"]')?.disabled ?? true, avail: window.__e2e.board().available }; })()`);
  assert.equal(st.input, true, where + ': the move box is off ' + JSON.stringify(st));
  assert.equal(st.hint && st.sol, true, where + ': Hint and Solution are off ' + JSON.stringify(st));
  assert.equal(st.avail, false, where + ': the board says it is not available');
  return st;
}
// Plays the puzzle out from where it is: the tree's move, else a win in 1 (in the page's labels)
async function solve() {
  await until(playable, 'puzzle playable', 30000);
  await sleep(750);
  for (let k = 0; k < 6 && !(await ev(`${S}.status === 'solved'`)); k++) {
    const mv = await ev(`(async () => { const s = ${S}, T = await import('/shared/tak.js'); const g = T.Game.fromTPS(s.p.tps, s.p.komi || 0); for (const m of s.moves) g.play(m.ptn);
      if (s.node && typeof s.node === 'object') return Object.keys(s.node)[0]; return T.winningMoves(g, 1).moves[0]; })()`);
    const before = await ev(`${S}.moves.length`);
    await until(playable, 'playable before ' + mv);
    assert.ok(await ev(`window.__e2e.board().play(${JSON.stringify(mv)})`), 'could not play ' + mv);
    await until(`(${S}.moves.length >= ${before + 2} && !${S}.busy) || ${S}.status === 'solved'`, 'the reply', 15000);
    await sleep(300);
  }
  await until(`${S}.status === 'solved'`, 'solved');
}

try {
  // ---------- board: every old value of the Board setting gets PTN Ninja ----------
  await production(true);
  for (const [at, ls, what] of [['/#/puzzle/thr19', {}, 'first visit, nothing stored'], ['/#/puzzle/thr19', { prefs: { size: '6', board: 'tinue' } }, "prefs.board 'tinue'"],
    ['/#/puzzle/thr19', { prefs: { size: '6', board: 'ninja' } }, "prefs.board 'ninja'"], ['/#/puzzle/thr19', { prefs: { size: '6', board: 42 } }, 'prefs.board junk'],
    ['/?board=tinue#/puzzle/thr19', {}, '?board=tinue'], ['/?board=whatever#/puzzle/thr19', { prefs: { board: 'ninja' } }, '?board=whatever'], ['/?board=ninja#/puzzle/thr19', { prefs: { board: 'tinue' } }, '?board=ninja over prefs tinue']]) {
    const t0 = await load(at, ls);
    await until(playable, what + ': playable', 20000);
    timings[what] = Date.now() - t0;
    assert.equal(await ev(onlyNinja), true, what + ': PTN Ninja\'s board, and no other');
    assert.equal(await ev(`performance.getEntriesByType('resource').some((e) => /\\/board\\.js(\\?|$)/.test(e.name))`), false, what + ': board.js never loaded');
    if (what === '?board=tinue') assert.equal(await ev(`JSON.parse(localStorage.getItem('tinue.prefs') || '{}').board ?? null`), null);
    if (what === "prefs.board 'tinue'") assert.equal(await ev(`JSON.parse(localStorage.getItem('tinue.prefs')).board`), 'tinue', 'the old value left alone');
  }
  step('PTN Ninja\'s board, playable, for a first visit, prefs.board tinue/ninja/junk and ?board=tinue/whatever/ninja; board.js never loaded ' + JSON.stringify(timings));

  // ---------- oldhtml: an index.html from before, which starts no frame for a player who never chose PTN Ninja ----------
  oldHtml = execFileSync('git', ['show', '33228e6:public/index.html'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(oldHtml, /window\.__tinueNinja/, 'the old HTML');
  for (const [ls, what] of [[{}, 'nothing stored'], [{ prefs: { size: '6', board: 'tinue' } }, "prefs.board 'tinue'"]]) {
    const t0 = await load('/#/puzzle/thr19', ls);
    assert.equal(await ev('window.__tinueNinja'), false, 'the old HTML started no frame');
    await until(playable, 'old HTML, ' + what + ': playable', 20000);
    timings['old index.html, ' + what] = Date.now() - t0;
    assert.equal(await ev(onlyNinja), true, 'old HTML: PTN Ninja, started by the page');
    assert.equal(await ev(`document.querySelectorAll('#board iframe').length`), 1);
  }
  oldHtml = null;
  await solve();
  step('an index.html cached from before (it starts no frame for these players): the page starts PTN Ninja itself and the puzzle plays and is solved ' + JSON.stringify([timings['old index.html, nothing stored'], timings["old index.html, prefs.board 'tinue'"]]));

  // ---------- retired: new Board() throws, on the dev page and the built pages ----------
  const throws = `(async () => { const m = await import(new URL('board.js', performance.getEntriesByType('resource').find((e) => new URL(e.name).pathname.endsWith('/app.js')).name).href); const out = []; for (const args of [[document.getElementById('board')], [document.createElement('div'), { onMove() {} }], []]) { try { new m.Board(...args); out.push('constructed'); } catch (e) { out.push(e instanceof Error ? e.message : String(e)); } }
    return { out, kids: document.getElementById('board').querySelectorAll('.tb, .tb-sq').length, kit: typeof m.buildPTN }; })()`;
  let r = await ev(throws);
  assert.deepEqual(r.out, [MSG, MSG, MSG], 'the dev page'); assert.equal(r.kids, 0); assert.equal(r.kit, 'function');
  const built = [];
  if (SITE) {
    for (const [name, analysis] of [['tinue', false], ['tinue-beta', true]]) {
      await production(false);
      const t0 = await load('/#/puzzle/thr19', {}, `http://127.0.0.1:${SP}/${name}`);
      await until(`document.readyState === 'complete' && !!document.querySelector('#board iframe')`, name + ': the page');
      assert.equal(await ev('window.TINUE_ANALYSIS === true'), analysis, name + ': its config');
      await until(`!document.querySelector('#ptn-in').disabled && /Your turn|to play|White|Black/.test(document.querySelector('#feedback').textContent)`, name + ': a puzzle playable on PTN Ninja', 25000);
      const ms = Date.now() - t0;
      assert.equal(await ev(onlyNinja), true, name + ': PTN Ninja only');
      assert.equal(await ev(`performance.getEntriesByType('resource').some((e) => /\\/board\\.js(\\?|$)/.test(e.name))`), false, name + ': board.js not loaded by the page');
      r = await ev(throws);
      assert.deepEqual(r.out, [MSG, MSG, MSG], name + ': new Board() throws'); assert.equal(r.kids, 0);
      built.push(`${name} (analysis ${analysis}, playable at ${ms} ms)`);
    }
    await production(true);
  } else console.log('-- no SITE: the built pages are not checked');
  step('new Board() throws "' + MSG + '" at once on the dev page' + (built.length ? ' and the built ' + built.join(', ') : '') + '; buildPTN still importable');

  // ---------- never: the message, nothing judged; Retry, then the puzzle ----------
  for (const [w, h, phone, tag] of [[1280, 800, false, '1280'], [390, 844, true, '390']]) {
    await size(w, h, phone);
    mode = 'never'; posts.length = 0;
    const t0 = await load('/#/puzzle/thr12', { prefs: { size: '6' } });
    await sleep(1500);
    assert.equal(await ev(`!!document.querySelector('#board .board-down[data-kind="load"]')`), false, 'no message at once');
    const at = await until(down('load'), 'the did-not-load message', 20000);
    timings['never → message ' + tag] = Date.now() - t0;
    assert.equal(await ev(`document.querySelector('#board .board-down p').textContent`), 'The board (PTN Ninja) didn’t load.');
    assert.equal(await ev(`document.querySelector('#board .board-down button').textContent`), 'Retry');
    await nothingOpen('never');
    assert.equal(await ev(`${S}.t0 ?? null`), null, 'no clock');
    await key('Enter', 'Enter', 13); await sleep(400);
    assert.equal(await ev(`${S}.p.id + ' ' + !!${S}.placeholder`), 'thr12 false', 'Enter is not Next');
    assert.equal(await ev(`!!document.querySelector('.tb-sq, #board .tb')`), false, 'no other board');
    // the message box sits in the board's place, inside it, centred, readable
    const geo = await ev(`(() => { const b = document.querySelector('#board').getBoundingClientRect(), m = document.querySelector('#board .board-down').getBoundingClientRect(); return [b.width, b.height, m.width, m.height, m.left - b.left, m.top - b.top, document.documentElement.scrollWidth - innerWidth]; })()`);
    assert.ok(geo[0] > 200 && geo[1] > 200 && Math.abs(geo[2] - geo[0]) < 1 && Math.abs(geo[3] - geo[1]) < 1 && geo[6] <= 0, 'the message fills the board\'s box ' + JSON.stringify(geo));
    await shot(`never-${tag}.png`);
    await sleep(1000);
    assert.deepEqual(posts, [], 'nothing posted while the board is not there');
    mode = 'ok';
    await ev(`(document.querySelector('#board .board-down button').click(), true)`);
    await until(playable, 'playable after Retry', 20000);
    assert.equal(await ev(`!!document.querySelector('#board .board-down')`), false, 'the message gone');
    if (!phone) await shot(`retry-playable-${tag}.png`);
    await solve();
    await until(`${S}.status === 'solved'`, 'solved after Retry');
    await sleep(1500);
    assert.ok(posts.length > 0, 'the solve is posted once the board is there: ' + JSON.stringify(posts));
    step(`${tag}: a frame that never comes up: after ${at + 1500} ms "The board (PTN Ninja) didn’t load." with Retry, in the board's box; no clock, no input, Hint/Solution off, Enter not Next, nothing posted; Retry → playable → solved and posted`);
  }
  await size(1280, 800);

  // ---------- block: ptn.ninja refusing the connection ----------
  mode = 'block'; posts.length = 0;
  {
    const t0 = await load('/#/puzzle/thr12', { prefs: { size: '6' } });
    await until(down('load'), 'the message, blocked', 20000);
    timings['blocked → message'] = Date.now() - t0;
    await nothingOpen('blocked');
    assert.deepEqual(posts, []);
    await shot('blocked-1280.png');
  }
  mode = 'ok';
  step(`ptn.ninja refusing the connection: the same message after ${timings['blocked → message']} ms; nothing open, nothing posted`);

  // ---------- died: stops answering after the first move ----------
  for (const [w, h, phone, tag] of [[1280, 800, false, '1280'], [390, 844, true, '390']]) {
    await size(w, h, phone);
    mode = 'ok';
    await load('/#/puzzle/thr19', { prefs: { size: '6' } });
    await until(playable, 'playable', 20000); await sleep(800);
    const tPlay = Date.now(); results.length = 0;
    assert.ok(await ev(`window.__e2e.board().play('4b2>1111')`));
    await until(`${S}.moves.length >= 2 && !${S}.busy`, 'the reply', 15000);
    await sleep(500);
    posts.length = 0;
    await ev(`(document.querySelector('#board iframe').contentWindow.postMessage({ action: 'STANDIN_DIE' }, '*'), true)`);
    const t = Date.now();
    await until(down('stopped'), 'the stopped message', 15000);
    timings['died → message ' + tag] = Date.now() - t;
    const tDown = Date.now();
    assert.equal(await ev(`document.querySelector('#board .board-down p').textContent`), 'The board (PTN Ninja) stopped answering.');
    assert.equal(await ev(`document.querySelector('#feedback h2')?.textContent`), 'Waiting for the board', 'the card says what it is waiting for');
    const st = await nothingOpen('died');
    assert.equal(st.status, 'play', 'the puzzle is not settled'); assert.equal(st.moves, 2);
    assert.equal(await ev(`window.__e2e.board().play('e1>')`), false, 'no move reaches it');
    await shot(`died-${tag}.png`);
    await sleep(4000); // (the board down a while: the solve clock must not count it)
    assert.deepEqual(posts, [], 'nothing judged while it is down');
    await ev(`(document.querySelector('#board .board-down button').click(), true)`);
    await until(playable, 'playable after Retry', 20000);
    const downMs = Date.now() - tDown;
    const back = await ev(`(() => { const b = window.__e2e.board(); return [b.g.toTPS().split(' ')[0], ${S}.moves.length]; })()`);
    const want = await ev(`(async () => { const T = await import('/shared/tak.js'); const s = ${S}; const g = T.Game.fromTPS(s.p.tps, 0); for (const m of s.moves) g.play(m.ptn); return g.toTPS().split(' ')[0]; })()`);
    assert.deepEqual(back, [want, 2], 'the position put back as it was');
    await solve();
    assert.ok(posts.length > 0, 'the solve posted');
    const res = results.find((r) => r.path === '/api/result')?.body, wall = Date.now() - tPlay;
    // (the clock ran from the first move's puzzle start, before tPlay; it stopped while the message showed)
    assert.ok(res && typeof res.ms === 'number', 'the result carries its solve time ' + JSON.stringify(res));
    assert.ok(res.ms < wall - downMs + 2000, `the solve time leaves out the ${downMs} ms the board was down: ms ${res.ms}, wall ${wall}`);
    timings['died: ms posted / wall / down ' + tag] = [res.ms, wall, downMs];
    step(`${tag}: a frame that stops answering mid-puzzle: noticed in ${timings['died → message ' + tag]} ms; "stopped answering" with Retry, the card "Waiting for the board"; no move goes through, nothing posted; Retry puts the position back and the puzzle is solved and posted, its solve time without the ${downMs} ms down (${res.ms} ms of ${wall})`);
  }
  await size(1280, 800);

  // ---------- held: stops answering while a move waits for Confirm ----------
  {
    mode = 'ok';
    await load('/#/puzzle/thr19', { prefs: { size: '6', confirm: true } });
    await until(playable, 'playable', 20000); await sleep(800);
    posts.length = 0;
    assert.ok(await ev(`window.__e2e.board().play('4b2>1111')`));
    await until(`document.querySelector('#confirm-msg').textContent === 'Confirm 4b2>1111?'`, 'the move held');
    await sleep(800); // (Confirm would take it now)
    await ev(`(document.querySelector('#board iframe').contentWindow.postMessage({ action: 'STANDIN_DIE' }, '*'), true)`);
    await until(down('stopped'), 'the stopped message', 15000);
    assert.equal(await ev(`document.querySelector('#confirm-msg').textContent`), '', 'the held move is dropped');
    await ev(`(document.querySelector('#confirm-yes').click(), true)`);
    await sleep(500);
    assert.deepEqual(posts, [], 'nothing judged'); assert.equal(await ev(`${S}.moves.length`), 0);
    await ev(`(document.querySelector('#board .board-retry').click(), true)`);
    await until(playable, 'playable after one press of Retry', 20000);
    assert.equal(await ev(`window.__e2e.board().g.toTPS().split(' ')[0] === ${S}.p.tps.split(' ')[0]`), true, 'the puzzle as it was');
    step('a frame that stops answering while a move waits for Confirm: the move is dropped, nothing is judged, and the first press of Retry works');
  }

  // ---------- slow but healthy ----------
  for (const m of ['trickle:20000', 'slow:6000', 'lag:300']) {
    mode = m;
    const t0 = await load('/#/puzzle/thr12', { prefs: { size: '6' } });
    let saw = null;
    let note = false;
    for (let t = Date.now(); Date.now() - t < 32000; await sleep(100)) {
      const k = await ev(`document.querySelector('#board .board-down')?.dataset.kind || ''`);
      if (k && k !== 'note') saw = k; if (k === 'note') note = true;
      if (await ev(playable)) break;
    }
    timings[m + ' → playable'] = Date.now() - t0;
    assert.equal(saw, null, m + ': never declared down');
    if (m.startsWith('trickle')) assert.ok(note, 'a page still arriving: "Loading the board…" meanwhile');
    await solve();
    await sleep(5000); // (heartbeats over a slow frame)
    assert.equal(await ev(`!!document.querySelector('#board .board-down[data-kind="stopped"], #board .board-down[data-kind="load"]')`), false, m + ': still not down');
  }
  mode = 'ok';
  step(`a slow but healthy frame (its page arriving only after 20 s, past the old 15 s cap; up 6 s late; 300 ms per answer) is waited for ("Loading the board…"), never declared dead, and played: ${timings['trickle:20000 → playable']} / ${timings['slow:6000 → playable']} / ${timings['lag:300 → playable']} ms to playable`);

  // ---------- pictures on the real embed ----------
  if (REAL && SHOTS) {
    mode = 'real';
    await production(true);
    for (const [w, h, phone, tag] of [[1280, 800, false, '1280'], [390, 844, true, '390']]) {
      await size(w, h, phone);
      await sleep(2500);
      const t0 = await load('/#/puzzle/thr19', {});
      await until(`${playable} && document.querySelector('#board iframe').style.opacity === '1'`, 'real: playable', 30000);
      timings['real first visit → playable ' + tag] = Date.now() - t0;
      await sleep(1200); await shot(`real-first-${tag}.png`);
      await until(`!document.querySelector('#feedback [data-act="hint"]')?.disabled`, 'Hint on', 5000);
      await ev(`(document.querySelector('#feedback [data-act="hint"]').click(), true)`); await sleep(1200); await shot(`real-hint-${tag}.png`);
      const wrong = await ev(`(async () => { const T = await import('/shared/tak.js'); const s = ${S}; const g = T.Game.fromTPS(s.p.tps, 0); return g.legalMoves().map((m) => g.moveToPTN(m)).find((p) => !/^(4b2>1111)$/.test(p) && /^[a-f][1-6]$/.test(p)); })()`);
      assert.ok(await ev(`window.__e2e.board().play(${JSON.stringify(wrong)})`), 'the wrong move ' + wrong);
      await sleep(900); await shot(`real-wrong-${tag}.png`);
      await until(`${S}.status !== 'play' || !${S}.busy`, 'after the wrong move', 15000); await sleep(1500);
      await solve(); await sleep(1500);
      await until(`!!document.querySelector('a[href^="https://ptn.ninja/"]')`, 'the ↗ link', 5000);
      await shot(`real-solved-${tag}.png`);
      await ev(`(location.hash = '#/settings', true)`); await sleep(900);
      await ev(`(document.querySelector('#st-ninja-theme').closest('.set-item').scrollIntoView({ block: 'start' }), true)`); await sleep(300);
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, `real-settings-${tag}.png`), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
    await size(1280, 800);
    step('pictures on the real ptn.ninja: first visit, hint, wrong move, solved with ↗, Settings, at 1280 and 390 ' + JSON.stringify(Object.fromEntries(Object.entries(timings).filter(([k]) => k.startsWith('real')))));
  }

  const bad = errors.filter((e) => !/ptn\.ninja/i.test(e));
  assert.deepEqual(bad, [], 'page errors');
  console.log(`\ne2e-ptn-only: all ${n} passed (${stats.docs} ptn.ninja page loads)\ntimings ${JSON.stringify(timings)}`);
  clearTimeout(watchdog);
  process.exit(0);
} catch (e) {
  console.log('FAILED:', e.stack || e, '\ncard:', await card().catch(() => ''), '\nerrors:', JSON.stringify(errors));
  if (SHOTS) await shot('failed.png').catch(() => {});
  process.exit(1);
}
