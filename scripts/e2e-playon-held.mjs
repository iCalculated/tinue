// The Tak rule's out with the check still running, then leaving (2026-11-21 review): headless Chrome against a recording
// fake API. The in-browser Syntaks is kept out (its wasm answers 404), so the fake crux answers every defender reply at
// once; every 'still' check is held in the page (window.__answerStill answers them) so a check stays live on demand.
//   L1: three quiet moves (out), the 20 s wait, the card; then on to another puzzle: nothing is posted for the old one
//       while its check runs on, and the new puzzle plays; the proof then lands: an unrated miss (never a rated one).
//   L2: the same, but the check then says no: a rated miss, posted once it answers.
//   R:  the same out, on to another puzzle, then back to the same one: the old attempt goes in first, as a rated miss.
//   U:  the same out, then a reload: a rated miss goes out as the page goes (the card's note said so); and before the
//       reload, the held record already carries the game's log (a crash would resend it, unrated: playon.js runOnHeld).
// The check answering mid-game (F2, Sasha 2026-11-21: "terminate playout early on miss"; judge.js endsOnNo):
//   N:  'no' on the player's turn (after ← presses, which a play-out ignores): it ends at once as a rated miss, posted
//       once, with the game's log; the held record is gone once the server has it, so a reload sends nothing more;
//       the board is then a missed puzzle's (the puzzle's own line still plays, unrated).
//   NT: 'no' while the defender's reply is on its way (crux slowed): the play-out goes on until the reply is on the
//       board, then ends before the player's turn opens; one rated miss whose log ends with that reply.
//   NC: 'no' while the player's next move waits for Confirm: it ends; the held move is dropped (not played, not
//       logged, and Confirm afterwards does nothing); one rated miss.
//   NH: 'no' while the tab is hidden: it ends all the same; one rated miss.
//   K:  'unknown' mid-game changes nothing: the play-out goes on under the Tak rule, runs out after three quiet moves
//       with no wait for the check, and is a rated miss, posted once.
// Not part of npm test (it needs Chrome; about 3 minutes).   ONLY=L1,U node scripts/e2e-playon-held.mjs
// Ports: TINUE_TEST_PORT (pages + API) and the next one (DevTools); its Chrome profile is made under $E2E_TMP and removed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standin, STANDIN_ARGS, STANDIN_PATTERN } from './e2e-standin.mjs'; // (PTN Ninja, the only board: a local stand-in)
import { Game } from '../shared/tak.js';
import { winMove } from '../shared/pns.js';
import { isTak, isReplyEntry } from '../public/playon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = +process.env.TINUE_TEST_PORT || 9471, DT = PORT + 1, SHOTS = process.env.SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(), say = (...a) => console.error(`[${((Date.now() - T0) / 1e3).toFixed(1)}s]`, ...a);

const TPS = '221,1221,21,1,x2/x3,1,2212S,x/x,2C,x2,1111C,2S/2,2,2,21S,2S,x/x2,2,x2,1S/2,x5 1 26';
const TREE = { 'e4+': { r: 'Sf5', n: { f6: { r: 'Se6', n: 'win' } } }, e6: { r: 'Sf6', n: { 'e4>': { r: 'Sd4', n: 'win' } } } };
const P = (id, extra = {}) => ({ id, size: 6, komi: 0, tps: TPS, plies: 5, tree: TREE, alts: [], rating: 1500, rd: 80, attempts: 0, solves: 0,
  themes: [], source: 'playtak', sourceRef: '1', meta: {}, turn: 1, ...extra });
const CYC = '2,x2,1,1,1/2,2,21,112S,x,12/2C,x,2,12,x,1/2,211,1,1,2,1/212S,21S,1,1C,1,x/2,x2,1,x2 2 25';
const PZ = { pdOther: P('pdOther'), pdC: P('pdC', { alts: ['f5'] }) };
for (const k of ['L1', 'L2', 'R', 'U', 'N', 'NT', 'NC', 'NH', 'K']) PZ['pd' + k] = P('pd' + k);
// the defender: the cycle's own replies (b2+ after 2a2+, b3- after 2a3-), else a parry
const cyc = new Map();
{ const g = Game.fromTPS(CYC, 3); for (const [m, r] of [['2a2+', 'b2+'], ['2a3-', 'b3-']]) { g.play(g.canon(m)); cyc.set(g.toTPS().split(' ')[0], r); g.play(g.canon(r)); } }
const parry = (tps, komi) => { const g = Game.fromTPS(tps, komi), a = 3 - g.toMove; const hit = cyc.get(tps.split(' ')[0]); if (hit) return hit;
  const ms = g.legalMoves().filter((m) => { const u = g.apply(m); const ok = !g.result() && !winMove(g, a); g.undo(u); return ok; }); return g.moveToPTN(ms[0] ?? g.legalMoves()[0]); };
let reqs = [], defends = 0, defendDelay = 0; // (defendDelay: crux's reply held back, ms)
const user = { id: 1, name: null, rating: 1500, rd: 100, provisional: true, games: 0, wins: 0 };
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/json' };
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const json = (o, st = 200) => res.writeHead(st, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (u.pathname.startsWith('/api/')) {
    reqs.push({ method: req.method, path: u.pathname, bytes: body.length, body: body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : null });
    if (u.pathname === '/api/me') return json({ user });
    if (u.pathname === '/api/next') return json({ puzzle: PZ.pdOther, judge: 'shadow' });
    if (u.pathname.startsWith('/api/puzzle/')) return json({ puzzle: PZ[decodeURIComponent(u.pathname.slice(12))] ?? null });
    if (u.pathname === '/api/result') return json({ user, rated: !reqs.at(-1).body?.casual, userDelta: -3 });
    if (u.pathname === '/api/defend') { defends++; if (defendDelay) await sleep(defendDelay); return json({ move: parry(u.searchParams.get('tps'), +u.searchParams.get('komi') || 0), mate: null, winProb: 0.5, side: 'x', depth: 3, ms: 1 }); }
    if (u.pathname === '/api/move') return json({ ok: true });
    return json({ error: 'off' }, 503);
  }
  if (u.pathname.endsWith('syntaks.wasm')) return res.writeHead(404).end(); // (crux defends: answered at once)
  let f = path.join(ROOT, 'public', decodeURIComponent(u.pathname));
  // (a reload at /puzzle/<id> asks for its relative scripts there: the real server's static rewrite, in short)
  if (u.pathname.startsWith('/puzzle/') && path.extname(u.pathname)) f = path.join(ROOT, 'public', u.pathname.slice(8));
  else if (u.pathname === '/' || u.pathname.startsWith('/puzzle/')) f = path.join(ROOT, 'public/index.html');
  try { const buf = fs.readFileSync(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(buf); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
const profile = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'e2e-held-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...STANDIN_ARGS, 'about:blank'], { stdio: 'ignore' });
const watchdog = setTimeout(() => { say('watchdog'); chrome.kill(); srv.close(); fs.rmSync(profile, { recursive: true, force: true }); process.exit(3); }, +process.env.E2E_MAX_MS || 330e3);
let ws, id = 0, opened; const pending = new Map(), errors = [];
for (let i = 0; i < 50 && !ws; i++) {
  try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); opened = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); } } catch {}
  if (!ws) await sleep(200);
}
await opened;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Fetch.requestPaused') standin(cdp, m.params, process.env.E2E_NINJA || 'ok'); else if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text) + ' @ ' + (m.params.exceptionDetails?.url || '')); };
// (each call gives up after 60 s, and a DevTools error is thrown, naming the call)
const cdp = (method, params = {}) => new Promise((r, j) => { const i = ++id, t = setTimeout(() => { pending.delete(i); j(new Error('no answer to ' + method)); }, 60e3); t.unref(); pending.set(i, (m) => { clearTimeout(t); if (m.error) j(new Error(`${method}: ${m.error.message}`)); else r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + expr); return r.result?.result?.value; };
const until = async (expr, what, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return; await sleep(60); } throw new Error('timed out: ' + what); };
const playable = `!document.querySelector('#ptn-in').disabled`;
const type = async (m) => { await until(playable, 'board playable before ' + m); await ev(`(() => { const i = document.querySelector('#ptn-in'); i.value = ${JSON.stringify(m)}; document.querySelector('#ptn-form').requestSubmit(); return true; })()`); };
const card = () => ev(`document.querySelector('#feedback')?.innerText || ''`);
const status = () => ev(`document.querySelector('#feedback .po-status')?.innerText || ''`);
const poLine = () => ev(`[...document.querySelectorAll('#moves .mv.po')].map((e) => e.textContent)`);
const size = (w, h, mob) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: mob });
await cdp('Runtime.enable'); await cdp('Fetch.enable', { patterns: [STANDIN_PATTERN] }); await cdp('Page.enable'); await cdp('Performance.enable'); await size(1280, 900, false);
// hold every 'still' check (engine.js checkStill) until the test answers it
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const RW = window.Worker; window.__stills = [];
  class PW { constructor(u, o) { this.r = new RW(u, o); this._om = null; }
    set onmessage(f) { this._om = f; this.r.onmessage = f; } get onmessage() { return this._om; }
    set onerror(f) { this.r.onerror = f; } get onerror() { return this.r.onerror; }
    addEventListener(...a) { this.r.addEventListener(...a); } removeEventListener(...a) { this.r.removeEventListener(...a); }
    postMessage(m, t) { if (m && m.type === 'still') { this.r.terminate(); window.__stills.push(this); return; } this.r.postMessage(m, t); }
    terminate() { this.dead = true; this.r.terminate(); } }
  window.Worker = PW;
  window.__answerStill = (kind, plies) => { let n = 0; for (const w of window.__stills) if (!w.dead && w._om) { w._om({ data: { kind, plies } }); n++; } return n; };
})();` });
async function shot(name) {
  if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h, mob] of [[1280, 900, false], [390, 844, true]]) {
    await size(w, h, mob); await sleep(350); await ev(`document.querySelector('#feedback')?.scrollIntoView({ block: 'center' }), true`); await sleep(120);
    const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${name}-${w}.png`), Buffer.from(r.result.data, 'base64'));
  }
  await size(1280, 900, false); await sleep(200);
}
async function open(pid, prefs = null) {
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until(`document.readyState === 'complete' && !!document.querySelector('#ptn-in')`, 'page');
  await ev(`(sessionStorage.clear(), localStorage.clear(), localStorage.setItem('tinue.token', '"tok"'), ${prefs ? `localStorage.setItem('tinue.prefs', ${JSON.stringify(JSON.stringify(prefs))}),` : ''} true)`);
  await cdp('Page.navigate', { url: 'about:blank' }); await sleep(100);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/` });
  await until(`location.pathname === '/puzzle/pdOther'`, 'the first puzzle');
  await until(playable, 'first puzzle playable');
  await ev(`(location.hash = '#/puzzle/${pid}', true)`);
  await until(`(location.pathname + location.hash).includes('${pid}')`, 'the puzzle');
  await until(playable, 'playable'); await sleep(1300);
  reqs = [];
}
const results = () => reqs.filter((r) => r.path === '/api/result');
const gameNow = async (tps, komi) => { const g = Game.fromTPS(tps, komi); for (const m of await poLine()) g.play(g.canon(m)); return g; };
const quiet = (g, me) => g.legalMoves().filter((m) => m.kind === 'p').map((m) => g.moveToPTN(m)).find((m) => { const c = g.clone(); c.play(m); return !c.result() && !isTak(c, me) && !winMove(c, 3 - me) && m !== 'f5'; });
const replyIn = (n) => until(`document.querySelectorAll('#moves .mv.po').length >= ${n} || !document.querySelector('#feedback [data-act="giveup"]')`, 'reply ' + n, 30000);
const out = {};
const confirmIt = async () => { for (let i = 0; i < 40; i++) { await sleep(150); await ev(`(document.querySelector('#confirm-yes').click(), true)`); if (await ev(`document.querySelector('#confirm-bar').classList.contains('idle')`)) return; } throw new Error('confirm never took'); };
async function threeQuiet(name, { confirm = false } = {}) {
  for (let q = 1; q <= 3; q++) {
    const g = await gameNow(TPS, 0), mv = quiet(g, 1); assert.ok(mv, 'quiet move');
    await type(mv);
    if (confirm) { await until(`!document.querySelector('#confirm-bar').classList.contains('idle')`, 'held'); out[name + '.held' + q] = await ev(`document.querySelector('#confirm-msg').innerText`); await confirmIt(); }
    if (q === 1) await until(`!!document.querySelector('#feedback [data-act="giveup"]')`, 'play-out', 15000);
    if (q < 3) { await replyIn(2 * q); await sleep(150); (out[name + '.status'] ||= []).push(await status()); }
  }
}

const ON = (k) => !process.env.ONLY || process.env.ONLY.split(',').includes(k);
const outCard = `/No threat/.test(document.querySelector('#feedback h2')?.innerText || '')`;
const posted = () => results().map((r) => ({ id: r.body.puzzleId, win: r.body.win, casual: !!r.body.casual, log: r.body.log?.length ?? 0 }));
let failed = false;
try {
  for (const [k, verdict] of [['L1', 'wins'], ['L2', 'no']]) {
    if (!ON(k)) continue;
    await open('pd' + k); await threeQuiet(k);
    await until(outCard, 'out card', 30000); await sleep(500);
    out[k + '.card'] = await card();
    await ev(`(location.hash = '#/puzzle/pdOther', true)`);
    await until(`location.pathname === '/puzzle/pdOther' && ${playable}`, 'the next puzzle playable', 15000); await sleep(2500);
    out[k + '.postedWhileRunning'] = posted();
    assert.deepEqual(out[k + '.postedWhileRunning'].filter((r) => r.id === 'pd' + k), [], 'nothing posted for the left puzzle while its check runs');
    out[k + '.answered'] = await ev(`window.__answerStill(${JSON.stringify(verdict)}, 8)`);
    await sleep(2000);
    out[k + '.posted'] = posted().filter((r) => r.id === 'pd' + k);
    assert.equal(out[k + '.posted'].length, 1, 'one result for the left puzzle');
    assert.equal(out[k + '.posted'][0].win, false);
    assert.equal(out[k + '.posted'][0].casual, verdict === 'wins', verdict === 'wins' ? 'proved after leaving: unrated' : 'refuted: rated');
    assert.ok(out[k + '.posted'][0].log >= 5, 'with the game\'s log');
    out[k + '.stillOn'] = await ev(`location.pathname`); assert.equal(out[k + '.stillOn'], '/puzzle/pdOther');
    assert.match(out[k + '.card'], /Still checking/); assert.match(out[k + '.card'], /switching puzzles is safe/i); // (the card's note)
  }
  if (ON('R')) {
    // R: out, on to another puzzle, then back to the same one while its check runs: the old attempt is settled first
    // (a rated miss), so the new attempt can't land first and stand instead
    await open('pdR'); await threeQuiet('R');
    await until(outCard, 'out card', 30000); await sleep(500);
    await ev(`(location.hash = '#/puzzle/pdOther', true)`);
    await until(`location.pathname === '/puzzle/pdOther' && ${playable}`, 'the next puzzle playable', 15000); await sleep(1000);
    assert.deepEqual(posted().filter((r) => r.id === 'pdR'), []);
    await ev(`(location.hash = '#/puzzle/pdR', true)`);
    await until(`location.pathname === '/puzzle/pdR' && ${playable}`, 'the same puzzle again', 15000); await sleep(1500);
    out['R.posted'] = posted().filter((r) => r.id === 'pdR');
    assert.equal(out['R.posted'].length, 1); assert.equal(out['R.posted'][0].casual, false, 'opened again: settled now, rated');
  }
  if (ON('U')) {
    await open('pdU'); await threeQuiet('U');
    await until(outCard, 'out card', 30000); await sleep(500);
    out['U.card'] = await card(); await shot('U-out-checking');
    const held = JSON.parse(await ev(`sessionStorage.getItem('tinue.held')`));
    out['U.held'] = { id: held.id, settled: typeof held.win === 'boolean', log: held.log?.map((e) => e.k + ':' + e.m) };
    assert.equal(held.id, 'pdU'); assert.equal(typeof held.win, 'undefined'); assert.ok(held.log?.length >= 5, 'the held record has the log');
    await cdp('Page.reload'); await sleep(3000);
    out['U.posted'] = posted().filter((r) => r.id === 'pdU');
    assert.equal(out['U.posted'].length, 1); assert.equal(out['U.posted'][0].casual, false, 'reload: a rated miss, as the card said');
    assert.match(out['U.card'], /reload/i); // (the card said so)
  }
  // ---- the check answering mid-game ----
  const missCard = `/That’s not the move/.test(document.querySelector('#feedback h2')?.innerText || '')`;
  const heldNow = async () => JSON.parse(await ev(`sessionStorage.getItem('tinue.held')`));
  const logOf = (k) => results().filter((r) => r.body.puzzleId === 'pd' + k).map((r) => r.body.log.map((e) => e.k + ':' + e.m));
  // the play-out started by a quiet move (the countdown at 2), its first reply in
  async function playOut(k, prefs) {
    await open('pd' + k, prefs);
    const mv = quiet(await gameNow(TPS, 0), 1); await type(mv);
    if (prefs?.confirm) await confirmIt();
    await until(`!!document.querySelector('#feedback [data-act="giveup"]')`, 'play-out', 15000); await replyIn(2); await sleep(200);
    return mv;
  }
  const endsAsMiss = async (k) => {
    await until(missCard, k + ': the miss card', 10000); await sleep(800);
    out[k + '.card'] = await card(); out[k + '.posted'] = posted().filter((r) => r.id === 'pd' + k); out[k + '.log'] = logOf(k)[0];
    assert.equal(out[k + '.posted'].length, 1, 'posted once'); assert.equal(out[k + '.posted'][0].win, false); assert.equal(out[k + '.posted'][0].casual, false, 'a rated miss');
    assert.match(out[k + '.card'], /found no forced win after/); assert.match(out[k + '.card'], /counts as a miss/);
    assert.equal(await ev(`!!document.querySelector('#feedback [data-act="giveup"]')`), false, 'the play-out is over');
    assert.equal(await ev(`!!document.querySelector('#feedback [data-act="solution"]') && !!document.querySelector('#feedback [data-act="hint"]')`), true, 'a missed puzzle\'s buttons');
    assert.equal(await heldNow(), null, 'the held record is gone: the server has the result');
  };
  if (ON('N')) {
    const mv1 = await playOut('N');
    const mv2 = quiet(await gameNow(TPS, 0), 1); await type(mv2); await replyIn(4); await sleep(200);
    out['N.before'] = await status();
    for (let i = 0; i < 3; i++) await ev(`(document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })), true)`);
    await sleep(200);
    out['N.answered'] = await ev(`window.__answerStill('no')`);
    await endsAsMiss('N'); await shot('N-refuted');
    assert.equal(out['N.log'].length, 4); assert.deepEqual([out['N.log'][0], out['N.log'][2]], ['miss:' + mv1, 'po:' + mv2]);
    assert.ok(isReplyEntry({ k: 'po', m: out['N.log'][3].slice(3) }), 'the last reply logged');
    await until(playable, 'the retry position playable', 5000);
    // the board is a missed puzzle's: the puzzle's own line still plays (its move and the stored reply), nothing more is posted
    const mvs = () => ev(`document.querySelectorAll('#moves .mv').length`), n0 = await mvs();
    await type('e4+'); await until(`document.querySelectorAll('#moves .mv').length >= ${n0 + 2}`, 'the retry on the puzzle\'s line', 5000);
    out['N.afterRetry'] = await ev(`document.querySelector('#feedback h2')?.innerText || ''`); await sleep(500);
    await cdp('Page.reload'); await sleep(3000);
    assert.equal(posted().filter((r) => r.id === 'pdN').length, 1, 'a reload sends nothing more');
  }
  if (ON('NT')) {
    await playOut('NT');
    const mv2 = quiet(await gameNow(TPS, 0), 1);
    defendDelay = 2500; await type(mv2);
    await until(`/thinking/.test(document.querySelector('#feedback .po-status')?.innerText || '')`, 'the defender thinking', 5000);
    out['NT.thinking'] = await status();
    out['NT.answered'] = await ev(`window.__answerStill('no')`); await sleep(400);
    out['NT.goesOnWhileThinking'] = await ev(`!!document.querySelector('#feedback [data-act="giveup"]')`);
    assert.equal(out['NT.goesOnWhileThinking'], true, 'the play-out waits for the reply'); assert.equal(posted().filter((r) => r.id === 'pdNT').length, 0);
    await endsAsMiss('NT'); defendDelay = 0;
    assert.equal(out['NT.log'].length, 4); assert.match(out['NT.log'][3], /^po:.*!$/, 'the reply is on the board and in the log');
    assert.equal(await ev(`document.querySelectorAll('#moves .mv.po').length`), 0, 'the board is back at the retry position');
  }
  if (ON('NC')) {
    await playOut('NC', { confirm: true });
    const mv2 = quiet(await gameNow(TPS, 0), 1); await type(mv2);
    await until(`!document.querySelector('#confirm-bar').classList.contains('idle')`, 'the move held for Confirm', 5000);
    out['NC.held'] = await ev(`document.querySelector('#confirm-msg').innerText`);
    out['NC.answered'] = await ev(`window.__answerStill('no')`);
    await endsAsMiss('NC');
    assert.equal(await ev(`document.querySelector('#confirm-bar').classList.contains('idle')`), true, 'the held move is dropped');
    assert.equal(out['NC.log'].length, 2, 'the held move was never played'); assert.ok(!out['NC.log'].some((e) => e === 'po:' + mv2));
    await ev(`(document.querySelector('#confirm-yes').click(), true)`); await sleep(1200);
    assert.equal(posted().filter((r) => r.id === 'pdNC').length, 1); assert.match(await card(), /That’s not the move/, 'Confirm afterwards does nothing');
  }
  if (ON('NH')) {
    await playOut('NH');
    await ev(`(Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }), Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), document.dispatchEvent(new Event('visibilitychange')), true)`);
    out['NH.answered'] = await ev(`window.__answerStill('no')`); await sleep(1500);
    out['NH.postedHidden'] = posted().filter((r) => r.id === 'pdNH').length;
    await ev(`(delete document.hidden, delete document.visibilityState, document.dispatchEvent(new Event('visibilitychange')), true)`);
    await endsAsMiss('NH'); assert.equal(out['NH.postedHidden'], 1, 'posted while hidden');
  }
  if (ON('K')) {
    await playOut('K');
    out['K.before'] = await status();
    out['K.answered'] = await ev(`window.__answerStill('unknown')`); await sleep(800);
    out['K.after'] = await status();
    assert.equal(out['K.after'], out['K.before'], 'unknown changes nothing'); assert.equal(await ev(`!!document.querySelector('#feedback [data-act="giveup"]')`), true);
    assert.equal(posted().filter((r) => r.id === 'pdK').length, 0);
    for (let q = 2; q <= 3; q++) { const mv = quiet(await gameNow(TPS, 0), 1); await type(mv); if (q < 3) { await replyIn(4); await sleep(150); } }
    const t = Date.now(); await until(outCard, 'out card', 10000); out['K.outAfterMs'] = Date.now() - t; await sleep(800);
    out['K.card'] = await card(); out['K.posted'] = posted().filter((r) => r.id === 'pdK');
    assert.ok(out['K.outAfterMs'] < 5000, 'no wait for a check that already answered');
    assert.doesNotMatch(out['K.card'], /Still checking/);
    assert.equal(out['K.posted'].length, 1); assert.equal(out['K.posted'][0].casual, false); assert.equal(out['K.posted'][0].log, 5);
  }
  out.errors = errors; assert.deepEqual(errors, []);
} catch (e) { failed = true; out.fail = String(e); out.failCard = await card().catch(() => ''); out.failReqs = reqs.map((r) => r.path); } finally {
  console.log(JSON.stringify(out, null, 1));
  try { await cdp('Browser.close'); } catch {}
  chrome.kill(); srv.close(); await sleep(500); fs.rmSync(profile, { recursive: true, force: true }); clearTimeout(watchdog);
}
console.log(failed ? 'FAIL' : 'OK'); process.exit(failed ? 1 : 0);
