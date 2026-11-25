// Rush and Streak on PTN Ninja's board (the only board: there is no other to fall back to), end to end: the real page in headless Chrome against a fake API (fixture puzzles,
// no database, no network) and, in place of https://ptn.ninja, a local stand-in (scripts/ninja-standin.html, served by
// request interception) or, with E2E_REAL=1, the real embed. Whole runs are played: every puzzle's line on the board
// (a flat placement by a tap on the frame's square, other moves as tinue's own adapter sends them: INSERT_PLY), a wrong
// move, the end screen and the look-back. Phases (E2E_PHASES, comma separated; default all but real):
//   ninja     Rush then Streak on the stand-in (prefs saying board 'tinue': ignored): Start waits for the frame, new
//             positions by message (the frame never reloads), the frame's box = Rush's board box at 1280x800, 1024x600,
//             390x844 and 320x568, scrolled too
//   never     a frame that never comes up: Start shows "Loading board…", then that the board didn't load, with Retry;
//             no run, no clock, nothing posted; Retry (PTN Ninja up now) starts the run on it
//   die       a frame that dies at a load, and one that dies mid-puzzle: the run ends there ("Run ended", why), posted
//             as abandoned; the puzzle page says the board stopped answering; Play again reloads it and plays
//   lag       a frame slow to say it has each position (300 ms, a slow phone): the run stays on it
//   remove    the frame taken out of the page mid-puzzle: no error, the run ends as for a dead frame
//   confirm   Confirm moves on: a move on the frame waits; Esc cancels and Enter confirms from the page's keyboard
//   real      the real ptn.ninja: a Rush run at 1280x800 (mouse) and a Streak at 390x844 (touch emulation)
// Timings: from the move that solves a puzzle to the next position drawn, and to it taking input, for every transition.
//   node scripts/e2e-rush-ninja.mjs [shots dir]      (E2E_OUT=file.json writes the timings and snapshots)
// Ports $E2E_PORT (9481) and the next one (DevTools); temporary files under $E2E_TMP, removed at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as SYM from '../shared/sym.js';
import { Game } from '../public/shared/tak.js';
import { cleanRun } from '../server/rush.js';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.E2E_ROOT || HERE); // (the public files served: this checkout's, or main's)
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.argv[2] || null;
const PORT = +(process.env.E2E_PORT || 9481), DT = PORT + 1, BASE = `http://127.0.0.1:${PORT}/`;
const PHASES = (process.env.E2E_PHASES || 'ninja,never,die,lag,remove,confirm').split(',');
const ENDED = 'The board (PTN Ninja) stopped answering, so this run ended. It isn’t kept, and doesn’t count against you.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The server's own check of a posted run (server/rush.js cleanRun: what POST /api/rush/result stores, its signed token
// aside), with the ids handed out in order and the stored puzzles: an ended run's post must pass it.
const serverTakes = (b) => !!cleanRun(b, (id) => SAMPLE.some((p) => p.id === id), SAMPLE.map((p) => p.id), (id) => SAMPLE.find((p) => p.id === id));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(HERE, 'scripts/rush-sym-sample.json'), 'utf8'));
const STANDIN = fs.readFileSync(path.join(HERE, 'scripts/ninja-standin.html'), 'utf8');
const tmp = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'tinue-e2e-ninja-'));
const OUT = { timings: {}, snaps: {}, posts: {}, geometry: {}, notes: [] };
const watchdog = setTimeout(() => { console.log('timed out'); cleanup(); process.exit(2); }, +(process.env.E2E_LIMIT || 340e3));

// ---------- the fake API ----------
let posts = [];
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/json', '.txt': 'text/plain' };
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let raw = ''; await new Promise((r) => { req.on('data', (d) => (raw += d)); req.on('end', r); });
  const json = (o, st = 200) => res.writeHead(st, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (u.pathname.startsWith('/api/')) {
    if (u.pathname === '/api/me') return json({ user: null });
    if (u.pathname === '/api/rush/run') {
      const start = +u.searchParams.get('start') || 0;
      return json({ mode: u.searchParams.get('mode'), size: 6, start, run: 'x', sig: 's', puzzles: start ? [] : SAMPLE });
    }
    if (u.pathname === '/api/rush/result') { posts.push(JSON.parse(raw || 'null')); return json({ id: posts.length }); }
    if (u.pathname === '/api/rush/top') return json({ top: [] });
    if (u.pathname === '/api/rush/best') return json({ best: null });
    if (u.pathname === '/api/themes') return json({ themes: {} });
    return json({ error: 'unknown route' }, 404);
  }
  let f = path.join(ROOT, 'public', decodeURIComponent(u.pathname));
  if (u.pathname === '/') f = path.join(ROOT, 'public/index.html');
  try { const buf = fs.readFileSync(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(buf); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

// ---------- Chrome over the DevTools protocol, the frame's own target (an out-of-process iframe) included ----------
const profile = path.join(tmp, 'chrome');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
function cleanup() { try { ws?.close(); } catch {} try { chrome.kill(); } catch {} try { srv.close(); } catch {} setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 300); }
let ws, id = 0;
const pending = new Map(), errors = [];
let mode = 'ok', real = false, ninjaLoads = 0, ninjaReqs = 0, frameSession = null;
for (let i = 0; i < 60 && !ws; i++) {
  try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch {}
  await sleep(200);
}
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; setTimeout(() => j(new Error('no DevTools socket')), 10000); });
const cdp = (method, params = {}, sessionId) => new Promise((r, j) => {
  const i = ++id, t = setTimeout(() => { pending.delete(i); j(new Error('no answer to ' + method)); }, 20000);
  pending.set(i, (m) => { clearTimeout(t); m.error ? j(new Error(method + ': ' + m.error.message)) : r(m.result); });
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
// The stand-in, or the real one, for https://ptn.ninja (in whichever session the request turns up)
async function paused(p, sessionId) {
  const url = new URL(p.request.url);
  if (process.env.E2E_DEBUG) console.log('paused', sessionId ? 'frame' : 'page', p.resourceType, p.request.url.slice(0, 80));
  try {
    if (url.origin !== 'https://ptn.ninja') return await cdp('Fetch.continueRequest', { requestId: p.requestId }, sessionId);
    ninjaReqs++;
    if (p.resourceType === 'Document') ninjaLoads++;
    if (real) return await cdp('Fetch.continueRequest', { requestId: p.requestId }, sessionId);
    let body, type = 'text/html';
    if (url.pathname.startsWith('/__tinue/')) { body = fs.readFileSync(path.join(HERE, url.pathname.slice(9))); type = 'text/javascript'; }
    else body = Buffer.from(STANDIN.replace('__MODE__', mode));
    await cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: type }, { name: 'cache-control', value: 'no-store' }], body: body.toString('base64') }, sessionId);
  } catch (e) { console.log('interception:', e.message); }
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Target.attachedToTarget' && process.env.E2E_DEBUG) console.log('attached', m.params.targetInfo.type, m.params.targetInfo.url);
  if (m.method === 'Fetch.requestPaused') paused(m.params, m.sessionId);
  else if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'iframe') {
    const s = m.params.sessionId;
    frameSession = s;
    (async () => {
      await cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://ptn.ninja/*' }] }, s).catch(() => {});
      await cdp('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {});
    })();
  } else if (m.method === 'Target.attachedToTarget') cdp('Runtime.runIfWaitingForDebugger', {}, m.params.sessionId).catch(() => {}); // (a worker: the engine's)
  else if (m.method === 'Target.detachedFromTarget' && m.params.sessionId === frameSession) frameSession = null;
  else if (m.method === 'Page.javascriptDialogOpening') { console.log('dialog:', m.params.type, m.params.message); cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }
  else if (m.method === 'Runtime.exceptionThrown' && !m.sessionId) errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
};
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://ptn.ninja/*' }] });
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
// In the page from its start: the frame's messages as they arrive (time, action, value), and Math.random as a known
// sequence (Rush uses it only to pick each puzzle's symmetry: the k-th puzzle turned gets symmetry k mod 8).
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `if (window.top === window) {
  window.__k = 0; Math.random = () => ((window.__k++ % 8) + 0.5) / 8;
  window.__ev = []; addEventListener('message', (e) => { if (e.origin === 'https://ptn.ninja') window.__ev.push({ t: performance.now(), a: e.data && e.data.action, v: e.data && e.data.value }); }, true);
}` });
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n' + expr.slice(0, 200)); return r.result?.value; };
const fev = async (expr) => { if (!frameSession) return null; const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true }, frameSession).catch(() => null); return r?.result?.value ?? null; };
const until = async (expr, what, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return; await sleep(40); } throw new Error('timed out: ' + what + ' errors: ' + JSON.stringify(errors.slice(-3))); };
let touch = false;
async function size(w, h, phone = false) {
  touch = phone;
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: phone });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: phone, maxTouchPoints: phone ? 5 : 1 });
}
async function tapAt(x, y) {
  if (touch) {
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
async function clickOn(sel) {
  const r = await ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length && x.getBoundingClientRect().width > 0); if (!e) return null;
    e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  assert.ok(r, 'something to click: ' + sel);
  await tapAt(r.x, r.y);
}
const shots = [];
async function shot(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
  shots.push(name);
}

// ---------- a page ----------
// Fresh storage, then the page at #/rush with prefs (an old Board setting in them, which nothing reads any more).
async function open(board, { confirm = false } = {}) {
  await cdp('Page.navigate', { url: 'about:blank' }); await sleep(300);
  // (storage set on a file of the site's that isn't the page, so that only the page itself loads ptn.ninja: once)
  await cdp('Page.navigate', { url: BASE + 'manifest.webmanifest' }); await sleep(300); await until(`location.href.startsWith('http') && document.readyState === 'complete'`, 'the site');
  await ev(`localStorage.clear(); localStorage.setItem('tinue.prefs', ${JSON.stringify(JSON.stringify({ board, confirm, sound: 'off' }))}); 1`);
  await cdp('Page.navigate', { url: BASE + '#/rush' }); await sleep(200);
  await until(`document.readyState === 'complete' && !!document.querySelector('#rush-go')`, 'Rush');
}
const frameRect = () => ev(`(() => { const f = document.querySelector('#board iframe'); if (!f) return null; const b = f.getBoundingClientRect(), cs = f.style.cssText;
  const ins = /clip-path:\\s*inset\\(([^)]*?)\\s+round/.exec(cs); const v = ins ? ins[1].trim().split(/\\s+/).map(parseFloat) : [0]; const [t, r, bo, l] = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
  return { left: b.left + l, top: b.top + t, right: b.right - r, bottom: b.bottom - bo, opacity: getComputedStyle(f).opacity, vis: getComputedStyle(f).visibility }; })()`);
const boardRect = () => ev(`(() => { const b = document.querySelector('#rush-board').getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; })()`);
const lent = () => ev(`!!document.querySelector('#rush-board.lent')`);

// ---------- solving: each puzzle in the orientation Rush shows it ----------
const legal = (g) => g.legalMoves().map((m) => g.moveToPTN(m));
const winning = (g) => legal(g).find((m) => { const h = g.clone(); h.apply(h.parseMove(m)); return h.result()?.winner === g.toMove; });
const posOf = (p, plies) => { const g = Game.fromTPS(p.tps, p.komi || 0); for (const m of plies) g.apply(g.parseMove(m)); return g; };
const tpsOf = (p, plies) => posOf(p, plies).toTPS();
const isPlace = (m) => /^[a-h][1-8]$/.test(m);
// what is on the board now: the frame's (its last GAME_STATE)
const shownTps = async () => ev(`(() => { const s = window.__ev.filter((x) => x.a === 'GAME_STATE').at(-1); return s ? s.v.tps : null; })()`);
const same = (a, b) => a && b && a.split(' ')[0] === b.split(' ')[0] && a.split(' ')[1] === b.split(' ')[1];
// A move on the board as a player makes it: a tap on the frame's square for a placement (else as tinue's adapter sends a
// typed move: INSERT_PLY, played and reported back by the frame).
// Returns the page time the move reached tinue (the frame's INSERT_PLY).
async function move(m) {
  const n0 = await ev(`window.__ev.length`);
  let tapped = false;
  if (isPlace(m) && frameSession) {
    const r = await fev(`(() => { const e = document.querySelector('[data-coord="${m}"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    const f = await ev(`(() => { const b = document.querySelector('#board iframe').getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
    if (r) { await tapAt(f.x + r.x, f.y + r.y); tapped = true; }
  }
  const got = async (ms) => { const t = Date.now(); while (Date.now() - t < ms) { const x = await ev(`(() => { const e = window.__ev.slice(${n0}).find((x) => x.a === 'INSERT_PLY'); return e ? e.t : null; })()`); if (x != null) return x; await sleep(15); } return null; };
  let t = tapped ? await got(1500) : null;
  if (t == null) {
    if (tapped) OUT.notes.push(`a tap on ${m} made no move in the frame; sent as INSERT_PLY`);
    await ev(`document.querySelector('#board iframe').contentWindow.postMessage({ action: 'INSERT_PLY', value: ${JSON.stringify(m)} }, 'https://ptn.ninja'), 1`);
    t = await got(3000);
  }
  assert.ok(t != null, 'the move reached tinue: ' + m);
  return t;
}
// Waits until the puzzle's position is on the board and takes input; returns { drawn, playable } (page times).
async function playable(p, plies, frame, since) {
  const want = tpsOf(p, plies);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const r = await ev(`(() => { if (!document.querySelector('#rush-board.lent')) return { gone: true }; const e = window.__ev.filter((x) => x.t >= ${since});
        const d = e.find((x) => x.a === 'GAME_STATE' && x.v.tps.split(' ')[0] === ${JSON.stringify(want.split(' ')[0])}); if (!d) return null;
        const on = window.__ev.filter((x) => x.a === 'SET_UI' && x.v && 'disableBoard' in x.v).at(-1); // (input on: as the frame last said, after the position or before it)
        return on && on.v.disableBoard === false && on.t >= ${since} ? { drawn: d.t, playable: Math.max(on.t, d.t) } : null; })()`);
    if (r?.gone) return { gone: true };
    if (r) return r;
    await sleep(15);
  }
  throw new Error('never playable: ' + want + ' shown ' + (await shownTps()));
}
// The k-th puzzle Rush turns gets symmetry k mod 8 (Math.random above); a run's puzzles are the sample, in order.
const runPuzzles = (k0) => SAMPLE.map((p, i) => SYM.orient(p, (k0 + i) % 8));
// Plays puzzle p's line to the end (or a wrong first move); returns the time of the last move.
async function solve(p, frame, { wrong = false } = {}) {
  let plies = [], node = p.tree, last = null;
  if (wrong) {
    const g = posOf(p, []), w = legal(g).find((m) => isPlace(m) && !(p.tree !== 'win' && m in p.tree) && m !== winning(g));
    return { t: await move(w), w };
  }
  for (;;) {
    const g = posOf(p, plies), m = node === 'win' ? winning(g) : Object.keys(node)[0];
    assert.ok(m, 'a move to play in ' + p.id);
    last = await move(m);
    if (node === 'win' || !node[m].r) return { t: last };
    plies = [...plies, m, node[m].r]; node = node[m].n;
    if ((await playable(p, plies, frame, last)).gone) return { t: last, gone: true }; // (the reply on the board, input open; or the run is over)
  }
}
const isFrame = async () => (await lent()) ? 'ninja' : null;
const state = () => ev(`({ title: document.querySelector('#rush-end h1')?.textContent || null, run: !document.querySelector('#rush-run').classList.contains('hidden'),
  strip: [...document.querySelectorAll('#rush-strip li')].map((l) => l.className).join(' '), score: document.querySelector('#rush-score').textContent, note: document.querySelector('#rush-note').textContent })`);
const snapshot = () => ev(`({ board: document.querySelector('#rush-board').innerHTML.replace(/style="[^"]*"/g, ''), strip: document.querySelector('#rush-strip').innerHTML, note: document.querySelector('#rush-note').textContent,
  turn: document.querySelector('#rush-turn').className.replace(/ ?flip/, ''), score: document.querySelector('#rush-score').textContent, iframes: document.querySelectorAll('iframe').length })`);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// One whole run: Start, every puzzle (one wrong move at `wrongAt`; in Streak it ends the run), the end screen, a look-back.
// Returns the transitions (solved -> next drawn, -> next takes input), in ms.
async function playRun(tag, { runMode = 'rush', frame = 'ninja', wrongAt = 5, stopAt = 99, shotsAt = {}, snaps = null, check = null, onStart = null } = {}) {
  await ev(`(document.querySelector('[data-mode="${runMode}"]').click(), 1)`); await sleep(100);
  const k0 = await ev('window.__k');
  const ps = runPuzzles(k0);
  const t0 = Date.now();
  await clickOn('#rush-go');
  if (onStart) await onStart();
  await until(`!document.querySelector('#rush-run').classList.contains('hidden')`, 'the run', 12000);
  const startMs = Date.now() - t0;
  let fr = frame === 'ninja' ? await isFrame() : null;
  const trans = [];
  let since = 0, colours = new Set();
  for (let i = 0; i < ps.length && i < stopAt; i++) {
    const p = ps[i];
    const pl = await playable(p, [], fr, since);
    if (pl.gone) break; // (the board stopped answering: the run is over)
    if (i > 0 && since) trans.push({ drawn: pl.drawn - since, playable: pl.playable - since, frame: !!fr });
    if (i === 0 && shotsAt.start) { await sleep(250); await shot(shotsAt.start); }
    const solver = Game.fromTPS(p.tps).toMove;
    if (shotsAt.mid && !colours.has(solver) && i > 0) { colours.add(solver); await sleep(250); await shot(shotsAt.mid.replace('%', solver === 1 ? 'white' : 'black')); }
    if (snaps) { await sleep(400); snaps.push(await snapshot()); }
    if (check) await check(i, p);
    if ((await state()).title === 'Run ended') break; // (the board stopped answering meanwhile)
    fr = frame === 'ninja' ? await isFrame() : null;
    if (i === wrongAt) {
      const before = (await state()).strip.split(' ').filter((x) => x === 'bad').length;
      await solve(p, fr, { wrong: true });
      // (the engine decides it; a move it can't refute at once is played out, and given up here: a mistake either way)
      for (let k = 0; k < 400 && !(await ev(`[...document.querySelectorAll('#rush-strip li')].length > ${i} || !document.querySelector('#rush-end').classList.contains('hidden')`)); k++) {
        if (await ev(`(() => { const b = document.querySelector('#rush-giveup'); return !!b && !b.classList.contains('hidden') && !b.disabled; })()`)) { OUT.notes.push(`${tag}: the wrong move was played out; given up`); await clickOn('#rush-giveup'); }
        await sleep(100);
      }
      if (shotsAt.wrong) { await sleep(120); await shot(shotsAt.wrong); }
      if (runMode === 'streak') { since = 0; break; }
      since = 0; continue;
    }
    const r = await solve(p, fr);
    since = r.t;
    fr = frame === 'ninja' ? await isFrame() : null;
  }
  if (runMode === 'streak' && shotsAt.beat) { await sleep(150); await shot(shotsAt.beat); }
  const stopped = stopAt < ps.length || (await state()).title === 'Run ended';
  if (!stopped) await until(`!document.querySelector('#rush-end').classList.contains('hidden')`, 'the end screen', 200000);
  if (!stopped) await sleep(500);
  if (shotsAt.end) await shot(shotsAt.end);
  if (shotsAt.look && !stopped) {
    await clickOn('.rush-card[data-i="1"] .rush-res');
    await until(`!!document.querySelector('#rush-look')?.open`, 'the look-back');
    await sleep(300); await shot(shotsAt.look);
    await ev(`document.querySelector('#rush-look').close(), 1`);
  }
  const d = trans.map((x) => x.drawn), q = trans.map((x) => x.playable);
  const out = { n: trans.length, startMs, drawn: { median: median(d), worst: Math.max(...d) }, playable: { median: median(q), worst: Math.max(...q) }, all: trans };
  OUT.timings[tag] = out;
  console.log(`${tag}: ${trans.length} transitions; to drawn median ${out.drawn.median?.toFixed(0)} worst ${out.drawn.worst?.toFixed(0)} ms; to input median ${out.playable.median?.toFixed(0)} worst ${out.playable.worst?.toFixed(0)} ms; Start took ${startMs} ms`);
  return out;
}
const SIZES = [[1280, 800, false], [1024, 600, false], [390, 844, true], [320, 568, true]];
// The frame's box against Rush's board box (#rush-board, which the frame is laid over), at each size and scrolled.
async function geometry(tag) {
  const out = [];
  for (const [w, h, phone] of SIZES) {
    await size(w, h, phone); await sleep(500);
    for (const y of [0, 120]) {
      await ev(`scrollTo(0, ${y}), 1`); await sleep(250);
      const [f, b] = [await frameRect(), await boardRect()];
      const d = Math.max(...['left', 'top', 'right', 'bottom'].map((k) => Math.abs(f[k] - b[k])));
      out.push({ size: `${w}x${h}`, scroll: y, frame: f, board: b, off: +d.toFixed(2) });
      assert.ok(d < 1, `${w}x${h} scrolled ${y}: the frame's box is Rush's board box (${d.toFixed(2)} px off) ${JSON.stringify({ f, b })}`);
      assert.equal(f.vis, 'visible');
    }
    await ev(`scrollTo(0, 0), 1`);
  }
  OUT.geometry[tag] = out;
  await size(1280, 800);
}

let ok = 0;
const step = async (name, fn) => { const t = Date.now(); await fn(); ok++; console.log('ok', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); };
try {
  if (PHASES.includes('ninja')) await step('PTN Ninja (stand-in; prefs saying tinue\'s board, ignored): Start waits for the frame; Rush then Streak played on it; new positions by message; its box is Rush\'s board box at every size', async () => {
    await size(1280, 800); mode = 'slow:3000'; ninjaLoads = 0; posts = [];
    await open('tinue');
    const loads0 = ninjaLoads;
    assert.equal(loads0, 1, 'one frame for the page');
    const onStart = async () => {
      await sleep(60);
      assert.equal(await ev(`document.querySelector('#rush-go').textContent`), 'Loading board…', 'Start says it is waiting for the board');
      await shot('ninja-loading-1280.png');
      assert.equal(await ev(`document.querySelector('#rush-run').classList.contains('hidden')`), true, 'the run waits');
    };
    // a whole Rush run, its geometry at each size checked at its third puzzle
    const g = { done: false };
    await playRun('standin-rush', { onStart, wrongAt: 4, shotsAt: { start: 'ninja-start-1280.png', mid: 'ninja-mid-%-1280.png', wrong: 'ninja-wrong-1280.png', end: 'ninja-end-1280.png', look: 'ninja-look-1280.png' },
      check: async (i) => { if (i === 2 && !g.done) { g.done = true; await geometry('standin'); } } });
    assert.equal(ninjaLoads, loads0, 'the frame was never reloaded: positions went by message');
    const body = posts.at(-1);
    assert.ok(body && body.mode === 'rush' && body.puzzles.length === 20, 'the run posted');
    assert.ok(!body.abandoned);
    assert.equal(body.puzzles.filter((x) => !x.solved).length, 1);
    OUT.posts.ninja = posts.slice();
    // Streak at phone size with touch
    await size(390, 844, true);
    await clickOn('#rush-back'); await until(`!!document.querySelector('#rush-go')`, 'start');
    await playRun('standin-streak', { runMode: 'streak', wrongAt: 8, shotsAt: { start: 'ninja-start-390.png', mid: 'ninja-mid-%-390.png', beat: 'ninja-wrong-390.png', end: 'ninja-end-390.png', look: 'ninja-look-390.png' } });
    assert.equal(ninjaLoads, loads0, 'still the same frame');
    assert.equal((await state()).title, 'Streak over');
    assert.ok(!(await lent()), 'given back at the end');
    await size(1280, 800);
    // a run left mid-puzzle: the frame goes back to the puzzle page (its own shape there, out of sight with it)
    await clickOn('#rush-again');
    await until(`!!document.querySelector('#rush-board.lent')`, 'on the frame');
    await sleep(500);
    await ev(`location.hash = '#/settings'`); await sleep(400);
    assert.ok(!(await lent()) && (await ev(`!document.querySelector('.lend')`)), 'given back');
    const css = await ev(`document.querySelector('#board iframe').style.cssText`);
    assert.ok(!/clip-path/.test(css) && /width: 111\.1/.test(css), 'the puzzle page\'s again: ' + css);
    assert.equal(ninjaLoads, loads0, 'still the one frame');
    await ev(`location.hash = '#/'`); await sleep(1500);
    await shot('ninja-puzzle-page-after-1280.png');
  });

  if (PHASES.includes('never')) await step('a frame that never comes up: "Loading board…", then that the board didn\'t load, with Retry; no run, nothing posted; Retry starts it', async () => {
    await size(1280, 800); mode = 'never'; posts = [];
    await open('ninja');
    await ev(`(document.querySelector('[data-mode="rush"]').click(), 1)`); await sleep(100);
    const t0 = Date.now();
    await clickOn('#rush-go'); await sleep(60);
    assert.equal(await ev(`document.querySelector('#rush-go').textContent`), 'Loading board…');
    await until(`!!document.querySelector('#rush-retry')`, 'the message', 20000);
    const waited = Date.now() - t0;
    OUT.notes.push(`never-up frame: Start said so after ${waited} ms`);
    assert.equal(await ev(`document.querySelector('#rush-err span').textContent`), 'The board (PTN Ninja) didn’t load.');
    assert.equal(await ev(`document.querySelector('#rush-run').classList.contains('hidden')`), true, 'no run');
    assert.equal(await ev(`document.querySelector('#rush-go').textContent`), 'Start');
    assert.ok(!(await lent())); assert.deepEqual(posts, [], 'nothing posted');
    assert.equal(await ev(`document.querySelectorAll('#board .tb-sq, #rush-board .tb-sq, #board .tb, #rush-board .tb').length`), 0, 'no board of tinue\'s (the end screen\'s pictures aside)');
    await shot('never-message-1280.png');
    mode = 'ok';
    const k0 = await ev('window.__k');
    await clickOn('#rush-retry');
    await until(`!document.querySelector('#rush-run').classList.contains('hidden')`, 'the run, after Retry', 20000);
    await until(`!!document.querySelector('#rush-board.lent')`, 'on the frame');
    const ps = runPuzzles(k0);
    for (let i = 0; i < 2; i++) { await playable(ps[i], [], 'ninja', 0); await solve(ps[i], 'ninja'); }
    await until(`document.querySelectorAll('#rush-strip li.good').length === 2`, 'two solved on PTN Ninja');
    await shot('never-retried-1280.png');
    await ev(`location.hash = '#/settings'`); await sleep(400); // (left: posted as abandoned, as any run left)
  });

  if (PHASES.includes('die')) await step('a frame that dies, at a load and mid-puzzle: the run ends there ("Run ended"), posted as abandoned; the puzzle page says so; Play again reloads it', async () => {
    await size(1280, 800); mode = 'die:4'; posts = [];
    await open('ninja');
    await playRun('die-at-load', { wrongAt: 99, check: async (i) => { if (i === 2) await shot('die-before-1280.png'); } });
    await until(`(document.querySelector('#rush-end h1')?.textContent || '') === 'Run ended'`, 'the run ended', 15000);
    await until(`document.querySelector('#rush-newbest').textContent.length > 0`, 'why');
    assert.equal(await ev(`document.querySelector('#rush-newbest').textContent`), ENDED);
    await shot('die-ended-1280.png');
    const body = posts.at(-1);
    assert.ok(body && body.abandoned === true, 'posted as abandoned: ' + JSON.stringify(body)?.slice(0, 200));
    assert.ok(body.puzzles.filter((x) => x.solved).length >= 2, 'the puzzles solved before: ' + body.puzzles.length);
    assert.ok(serverTakes(body), 'the server takes the abandoned post: ' + JSON.stringify(body).slice(0, 300));
    assert.equal(await ev(`document.querySelector('#board .board-down')?.dataset.kind`), 'stopped', 'the puzzle page says the board stopped answering');
    assert.ok(!(await lent()));
    assert.equal(await ev(`document.querySelectorAll('#board .tb-sq, #rush-board .tb-sq, #board .tb, #rush-board .tb').length`), 0, 'no board of tinue\'s (the end screen\'s pictures aside)');
    // Play again: the frame loads again (Retry), Start waits for it, the run is on it
    mode = 'ok'; const loads = ninjaLoads;
    await clickOn('#rush-again');
    await until(`!!document.querySelector('#rush-board.lent')`, 'on the frame again', 20000);
    assert.equal(ninjaLoads, loads + 1, 'reloaded once');
    assert.equal(await ev(`document.querySelector('#board .board-down')`), null, 'the message gone');
    await ev(`location.hash = '#/settings'`); await sleep(400);
    // mid-puzzle: the stand-in stops answering after a correct move
    mode = 'ok'; posts = [];
    await open('ninja');
    let killed = false;
    await playRun('die-mid', { wrongAt: 99, stopAt: 99, check: async (i) => {
      if (i !== 2 || killed) return;
      killed = true;
      await fev('window.__standin.die()');
      await until(`(document.querySelector('#rush-end h1')?.textContent || '') === 'Run ended'`, 'the run ended', 15000);
      await sleep(600); await shot('die-mid-1280.png');
    } });
    const b2 = posts.at(-1);
    assert.ok(b2 && b2.abandoned === true && b2.puzzles.filter((x) => x.solved).length === 2, 'abandoned after two solved: ' + JSON.stringify(b2)?.slice(0, 200));
    assert.ok(serverTakes(b2), 'the server takes it (mid-puzzle)');
  });

  if (PHASES.includes('lag')) await step('a frame slow to say it has each position (300 ms): the run stays on it to the end', async () => {
    await size(1280, 800); mode = 'lag:300'; posts = [];
    await open('ninja');
    const t = await playRun('lag-300', { wrongAt: 5 });
    assert.ok(t.all.length >= 15 && t.all.every((x) => x.frame), 'every transition on the frame');
    assert.ok(!(await ev(`!!document.querySelector('#board iframe').dataset.down`)), 'not down');
    const b = posts.at(-1);
    assert.ok(b && b.puzzles.length === 20, 'the run posted');
    assert.ok(!b.abandoned && !(b.paused >= 500), 'a whole run, not ended for the board; no long pause: ' + b.paused);
    mode = 'ok';
  });

  if (PHASES.includes('remove')) await step('the frame taken out of the page mid-puzzle: no error; the run ends as for a dead frame', async () => {
    await size(1280, 800); mode = 'ok'; posts = [];
    await open('ninja');
    let gone = false;
    await playRun('remove', { wrongAt: 99, check: async (i) => {
      if (i !== 2 || gone) return;
      gone = true;
      await ev(`document.querySelector('#board iframe').remove(), 1`);
      await until(`(document.querySelector('#rush-end h1')?.textContent || '') === 'Run ended'`, 'the run ended', 15000);
      await shot('remove-1280.png');
    } });
    const b = posts.at(-1);
    assert.ok(b && b.abandoned === true, 'posted as abandoned');
  });

  if (PHASES.includes('confirm')) await step('Confirm moves on the frame: the move waits; the keyboard is the page\'s (Esc cancels, Enter confirms), as on the puzzle page', async () => {
    await size(1280, 800); mode = 'ok';
    await open('ninja', { confirm: true });
    const k0 = await ev('window.__k'); const ps = runPuzzles(k0);
    await clickOn('#rush-go'); await until(`!!document.querySelector('#rush-board.lent')`, 'on the frame');
    // the first puzzle whose first move is a placement (others skipped)
    let i = 0;
    for (; ; i++) {
      const p = ps[i]; await playable(p, [], 'ninja', 0);
      const g = posOf(p, []), m = p.tree === 'win' ? winning(g) : Object.keys(p.tree)[0];
      if (isPlace(m)) {
        const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); await sleep(150); };
        await move(m);
        await until(`!document.querySelector('#rush-confirm').classList.contains('idle')`, 'held');
        assert.equal(await ev(`document.activeElement === document.querySelector('#board iframe')`), false, 'the frame gave the keyboard back');
        await shot('confirm-held-1280.png');
        await key('Escape', 'Escape', 27);
        await until(`document.querySelector('#rush-confirm').classList.contains('idle')`, 'cancelled');
        await until(`(() => { const s = window.__ev.filter((x) => x.a === 'GAME_STATE').at(-1); return s && s.v.tps.split(' ')[0] === ${JSON.stringify(p.tps.split(' ')[0])}; })()`, 'the move taken back on the frame');
        assert.equal(await ev(`document.querySelectorAll('#rush-strip li').length`), i, 'nothing counted');
        await sleep(300);
        await move(m);
        await until(`!document.querySelector('#rush-confirm').classList.contains('idle')`, 'held again');
        await key('Enter', 'Enter', 13);
        await until(`document.querySelector('#rush-confirm').classList.contains('idle')`, 'confirmed');
        if (p.tree === 'win' || !p.tree[m].r) await until(`document.querySelectorAll('#rush-strip li.good').length === ${i + 1}`, 'solved');
        else await until(`document.querySelector('#rush-note').textContent.length > 0 && (() => { const s = window.__ev.filter((x) => x.a === 'GAME_STATE').at(-1); return s && s.v.tps.split(' ')[0] === ${JSON.stringify(tpsOf(p, [m, p.tree[m]?.r || m]).split(' ')[0])}; })()`, 'the reply on the board');
        break;
      }
      await ev(`localStorage.setItem('tinue.prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('tinue.prefs')), confirm: false })), 1`);
      await solve(p, 'ninja');
      await ev(`localStorage.setItem('tinue.prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('tinue.prefs')), confirm: true })), 1`);
    }
  });

  if (PHASES.includes('real')) await step('the real ptn.ninja: Rush at 1280x800, Streak at 390x844 with touch', async () => {
    real = true; ninjaLoads = 0;
    await size(1280, 800);
    await open('ninja');
    await playRun('real-rush', { wrongAt: 4, shotsAt: { start: 'real-start-1280.png', mid: 'real-mid-%-1280.png', wrong: 'real-wrong-1280.png', end: 'real-end-1280.png', look: 'real-look-1280.png' },
      check: async (i) => { if (i === 2 && !OUT.geometry.real) await geometry('real'); } });
    await sleep(2500);
    await size(390, 844, true);
    await open('ninja');
    await playRun('real-streak', { runMode: 'streak', wrongAt: 7, shotsAt: { start: 'real-start-390.png', mid: 'real-mid-%-390.png', beat: 'real-wrong-390.png', end: 'real-end-390.png', look: 'real-look-390.png' } });
    OUT.notes.push(`real ptn.ninja page loads: ${ninjaLoads}`);
    real = false;
  });
  const errs = errors.filter((e) => !/ResizeObserver/.test(e));
  assert.deepEqual(errs, [], 'no page exceptions');
  console.log(`e2e-rush-ninja: all ${ok} passed`);
} catch (e) {
  console.log('FAILED:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  OUT.shots = shots;
  if (process.env.E2E_OUT) fs.writeFileSync(process.env.E2E_OUT, JSON.stringify(OUT, null, 1));
  clearTimeout(watchdog);
  cleanup();
}
