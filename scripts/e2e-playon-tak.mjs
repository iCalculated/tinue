// The Tak rule on the real puzzle page, end to end: headless Chrome against a recording fake API, the in-browser Syntaks
// defending (copy public/syntaks/syntaks.wasm in first: it is gitignored) and the in-browser prover checking. The
// fixture is pd871847's position at the node where the reported play-out left the tree (5 plies left: the old cap was
// 6 moves), its move f5 listed as a proven alternative.
//   A: f5, then Tak moves that keep a forced win (the reported line where they still fit) past the old cap, then the
//      win: posted as a solve, its log carrying the defender's replies.
//   B: f5, then three quiet moves: the countdown shows 2, then 1, then the play-out ends 'out'; posted as a miss.
// The same f5 unproven (not listed: the in-browser check of it is held by the test, window.__answerStill, so it plays
// out), the check answering mid-game (F2, Sasha 2026-11-21: judge.js endsOnNo):
//   N: a Tak move, and the check says 'no' while Syntaks is choosing its reply: the play-out ends once that reply is on
//      the board, as a rated miss posted once, its log ending with the reply.
//   K: the check says 'unknown' (a timeout) right away: nothing changes; Tak moves to the win, a rated solve.
//   W: Tak moves to a win in one; the check is still running until the winning move reaches the page (PTN Ninja's
//      INSERT_PLY), which lets it go, and the check answers 'no' in that very task, just after the board's listener:
//      the page took the win first, so the 'no' reaches nothing (answered 0): a rated solve.
// Screenshots of the card in each state at 1280 and 390 px wide go to SHOTS (default: none), and the width each text of
// the card has at 390 px is printed. Not part of npm test (it needs Chrome).
//   SHOTS=dir node scripts/e2e-playon-tak.mjs [chrome binary]
// Ports: TINUE_TEST_PORT (pages + API) and the next one (DevTools); its Chrome profile lives in a new directory under
// $E2E_TMP (else the system's temporary directory), removed at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standin, STANDIN_ARGS, STANDIN_PATTERN } from './e2e-standin.mjs'; // (PTN Ninja, the only board: a local stand-in)
import { Game } from '../shared/tak.js';
import { winMove, allTinueMoves } from '../shared/pns.js';
import { isTak, isReplyEntry, capMoves, TAK_COUNTDOWN } from '../public/playon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.argv[2] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = +process.env.TINUE_TEST_PORT || 9331, DT = PORT + 1, SHOTS = process.env.SHOTS || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
assert.ok(fs.existsSync(path.join(ROOT, 'public/syntaks/syntaks.wasm')), 'copy public/syntaks/syntaks.wasm in first');

// ---------- the puzzles ----------
const TPS = '221,1221,21,1,x2/x3,1,2212S,x/x,2C,x2,1111C,2S/2,2,2,21S,2S,x/x2,2,x2,1S/2,x5 1 26';
const TREE = { 'e4+': { r: 'Sf5', n: { f6: { r: 'Se6', n: 'win' } } }, e6: { r: 'Sf6', n: { 'e4>': { r: 'Sd4', n: 'win' } } } };
const P = (id, alts = ['f5']) => ({ id, size: 6, komi: 0, tps: TPS, plies: 5, tree: TREE, alts, rating: 1500, rd: 80, attempts: 0, solves: 0,
  themes: [], source: 'playtak', sourceRef: '1', meta: {}, turn: 1 });
const PZ = { pdTakA: P('pdTakA'), pdTakB: P('pdTakB'), pdTakN: P('pdTakN', []), pdTakK: P('pdTakK', []), pdTakW: P('pdTakW', []), pdOther: { ...P('pdOther') } };
const OLD_CAP = capMoves(5);

// ---------- the fake API, recording ----------
let reqs = [];
const user = { id: 1, name: null, rating: 1500, rd: 100, provisional: true, games: 0, wins: 0 };
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/json' };
// /api/defend (only if the in-browser Syntaks isn't up yet): the first move that leaves the attacker no win in one
const parry = (tps) => { const g = Game.fromTPS(tps, 0), a = 3 - g.toMove; const ms = g.legalMoves().filter((m) => { const u = g.apply(m); const ok = !g.result() && !winMove(g, a); g.undo(u); return ok; }); return g.moveToPTN(ms[0] ?? g.legalMoves()[0]); };
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const json = (o, st = 200) => res.writeHead(st, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (u.pathname.startsWith('/api/')) {
    reqs.push({ method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), body: body ? JSON.parse(body) : null });
    if (u.pathname === '/api/me') return json({ user });
    if (u.pathname === '/api/next') return json({ puzzle: PZ.pdOther });
    if (u.pathname.startsWith('/api/puzzle/')) return json({ puzzle: PZ[decodeURIComponent(u.pathname.slice(12))] ?? null });
    if (u.pathname === '/api/result') return json({ user, rated: true, userDelta: 3 });
    if (u.pathname === '/api/defend') return json({ move: parry(u.searchParams.get('tps')), mate: null, winProb: 0.5, side: 'black', depth: 3, ms: 1 });
    if (u.pathname === '/api/analyze') return json({ error: 'off' }, 503);
    return json({ error: 'unknown route' }, 404);
  }
  let f = path.join(ROOT, 'public', decodeURIComponent(u.pathname));
  if (u.pathname === '/' || u.pathname.startsWith('/puzzle/')) f = path.join(ROOT, 'public/index.html');
  try { const buf = fs.readFileSync(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(buf); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
const say = (...a) => console.error(`[${((Date.now() - T0) / 1e3).toFixed(1)}s]`, ...a), T0 = Date.now();

// ---------- Chrome over the DevTools protocol ----------
const profile = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'tinue-e2e-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...STANDIN_ARGS, 'about:blank'], { stdio: 'ignore' });
// (a run that hangs ends itself: no Chrome or profile left behind)
const watchdog = setTimeout(() => { say('watchdog: giving up'); chrome.kill(); srv.close(); fs.rmSync(profile, { recursive: true, force: true }); process.exit(3); }, +process.env.E2E_MAX_MS || 300e3);
let ws, id = 0;
const pending = new Map(), errors = [];
let opened;
for (let i = 0; i < 50 && !ws; i++) {
  // (the open handler is set at once: a socket that opens during a sleep would otherwise never be seen to)
  try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); opened = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); } } catch {}
  if (!ws) await sleep(200);
}
await opened;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Fetch.requestPaused') standin(cdp, m.params, process.env.E2E_NINJA || 'ok'); else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description); };
// (each call gives up after 60 s, and a DevTools error is thrown, naming the call)
const cdp = (method, params = {}) => new Promise((r, j) => { const i = ++id, t = setTimeout(() => { pending.delete(i); j(new Error('no answer to ' + method)); }, 60e3); t.unref(); pending.set(i, (m) => { clearTimeout(t); if (m.error) j(new Error(`${method}: ${m.error.message}`)); else r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + expr); return r.result?.result?.value; };
const until = async (expr, what, ms = 30000) => { say('wait', what); const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return; await sleep(100); } throw new Error('timed out: ' + what); };
const playable = `!document.querySelector('#ptn-in').disabled`;
const type = async (m) => { await until(playable, 'board playable before ' + m); await ev(`(() => { const i = document.querySelector('#ptn-in'); i.value = ${JSON.stringify(m)}; document.querySelector('#ptn-form').requestSubmit(); return true; })()`); };
const card = () => ev(`document.querySelector('#feedback')?.innerText || ''`);
const status = () => ev(`document.querySelector('#feedback .po-status')?.innerText || ''`);
const poLine = () => ev(`[...document.querySelectorAll('#moves .mv.po')].map((e) => e.textContent)`);
const size = (w, h, mobile) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
await cdp('Runtime.enable'); await cdp('Fetch.enable', { patterns: [STANDIN_PATTERN] }); await cdp('Page.enable'); await size(1280, 900, false);
// every 'still' check (engine.js checkStill) is held until the test answers it (N, K, W; A and B's f5 is listed: no check)
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
const widths = {};
async function shots(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h, mob] of [[1280, 900, false], [390, 844, true]]) {
    await size(w, h, mob); await sleep(400);
    await ev(`document.querySelector('#feedback')?.scrollIntoView({ block: 'center' }), true`); await sleep(150);
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}-${w}.png`), Buffer.from(r.result.data, 'base64'));
    // the room each text of the card has at 390 px: its box's width, and how many characters of its own text fit on a line
    if (w === 390) widths[name] = await ev(`(() => { const c = document.createElement('canvas').getContext('2d'), out = {};
      for (const [k, sel] of [['h2', '#feedback h2'], ['p', '#feedback .body > p'], ['status', '#feedback .po-status'], ['line', '#feedback .po-line:not(.po-status)']]) {
        const e = document.querySelector(sel); if (!e) continue; const cs = getComputedStyle(e); c.font = cs.font;
        const t = e.innerText.split('\\n')[0] || 'x', per = c.measureText(t).width / t.length;
        out[k] = { px: Math.round(e.clientWidth), font: cs.fontSize + ' ' + cs.fontFamily.split(',')[0], charsPerLine: Math.floor(e.clientWidth / per), lines: Math.round(e.getBoundingClientRect().height / parseFloat(cs.lineHeight || cs.fontSize)) };
      } return out; })()`);
  }
  await size(1280, 900, false); await sleep(300);
}

// The page's game: the fixture plus the play-out's moves as its move list shows them.
const gameNow = async () => { const g = Game.fromTPS(TPS, 0); for (const m of await poLine()) g.play(g.canon(m)); return g; };
const myTurn = async (n) => { // n: the length po.line has when it is the player's turn again
  await until(`document.querySelectorAll('#moves .mv.po').length >= ${n} || !document.querySelector('#feedback [data-act="giveup"]')`, 'the reply', 40000);
  await sleep(200);
};

async function open(pid) {
  await cdp('Page.navigate', { url: 'about:blank' }); await sleep(100);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until(`document.readyState === 'complete' && !!document.querySelector('#ptn-in')`, 'page');
  await ev(`(sessionStorage.clear(), localStorage.clear(), localStorage.setItem('tinue.token', '"tok"'), true)`);
  await cdp('Page.navigate', { url: 'about:blank' }); await sleep(100);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/` });
  await until(`location.pathname === '/puzzle/pdOther'`, 'the first puzzle');
  await until(playable, 'first puzzle playable');
  await ev(`(location.hash = '#/puzzle/${pid}', true)`);
  await until(`(location.pathname + location.hash).includes('${pid}')`, 'the puzzle');
  await until(playable, 'playable'); await sleep(1300); // (a new puzzle takes no move in its first second: busy.js)
  reqs = [];
}
const result = () => reqs.filter((r) => r.path === '/api/result').map((r) => r.body);
const report = { A: {}, B: {}, N: {}, K: {}, W: {} };
// A Tak move that keeps the forced win (as A), or the win in one when there is one and `win`.
const takMove = (g, win) => {
  if (win && winMove(g, 1)) return g.moveToPTN(winMove(g, 1));
  const wins = allTinueMoves(g, 13, { maxNodes: 3e4 }).filter((m) => { const c = g.clone(); c.play(m); return !c.result() && isTak(c, 1); });
  return wins[0];
};
// Submit a move and run js as soon as the page has taken it (typeThen: the board is PTN Ninja's, so a typed move reaches
// the page once the frame reports it back, a few ms later: polled for, well before the defender's reply), or before it
// (thenType, in the same task): either way the check's answer resolves its promise at once, and the page's handler of
// it runs as a microtask.
const typeThen = async (m, js) => { await until(playable, 'board playable before ' + m); return ev(`(async () => { const n0 = document.querySelectorAll('#moves .mv.po').length; const i = document.querySelector('#ptn-in'); i.value = ${JSON.stringify(m)}; document.querySelector('#ptn-form').requestSubmit();
  for (let k = 0; k < 2000 && document.querySelectorAll('#moves .mv.po').length <= n0; k++) await new Promise((r) => setTimeout(r, 1)); return ${js}; })()`); };
const thenType = async (js, m) => { await until(playable, 'board playable before ' + m); return ev(`(() => { const r = ${js}; const i = document.querySelector('#ptn-in'); i.value = ${JSON.stringify(m)}; document.querySelector('#ptn-form').requestSubmit(); return r; })()`); };
const startUnproven = async (pid) => {
  await open(pid); await type('f5');
  await until(`!!document.querySelector('#feedback [data-act="giveup"]')`, 'the unproven play-out', 15000);
  assert.match(await ev(`document.querySelector('#feedback h2')?.innerText || ''`), /Play it out/);
  await myTurn(2);
};

try {
  // ---- A: Tak moves past the old cap, then the win ----
  await open('pdTakA');
  const script = ['f4', 'f5', 'f4', 'e4+', 'f6']; // the reported line, where it still fits
  const pat = [];
  for (let k = 1; ; k++) {
    const g = k === 1 ? null : await gameNow();
    let mv;
    if (k === 1) mv = 'f5';
    else if (k > OLD_CAP && winMove(g, 1)) mv = g.moveToPTN(winMove(g, 1));
    else {
      const wins = allTinueMoves(g, 13, { maxNodes: 3e4 }).filter((m) => { const c = g.clone(); c.play(m); return !c.result(); });
      mv = wins.includes(script[k - 2]) ? script[k - 2] : wins[0];
      assert.ok(mv, `a Tak move that keeps the win at move ${k}`);
    }
    if (g) { const c = g.clone(); c.play(mv); pat.push(c.result() ? 'W' : isTak(c, 1) ? 'T' : 'q'); } else pat.push('T');
    await type(mv);
    if (k === 1) { await until(`!!document.querySelector('#feedback [data-act="giveup"]')`, 'the play-out'); await shots('A1-start'); }
    if (pat.at(-1) === 'W') break;
    await myTurn(2 * k);
    if (k === OLD_CAP) { report.A.pastOldCap = await status(); await shots('A2-past-old-cap'); }
    assert.ok(k < 30, 'the line ends');
  }
  await until(`/Solved/.test(document.querySelector('#feedback h2')?.innerText || '')`, 'the solved card', 30000);
  await sleep(1500); await shots('A3-solved');
  const rA = result();
  assert.equal(rA.length, 1); assert.equal(rA[0].win, true);
  const replies = rA[0].log.filter(isReplyEntry);
  Object.assign(report.A, { pattern: pat.join(''), moves: pat.length, oldCap: OLD_CAP, card: await card(), posted: { win: rA[0].win, casual: !!rA[0].casual, log: rA[0].log.map((e) => `${e.k}:${e.m}`) } });
  assert.ok(pat.length > OLD_CAP, `won after the old cap (${pat.length} moves)`);
  assert.equal(replies.length, pat.length - 1); // every reply logged
  assert.equal(rA[0].log.find((e) => e.k === 'slow')?.m, 'f5');

  // ---- B: f5, then three quiet moves ----
  await open('pdTakB');
  await type('f5');
  await until(`!!document.querySelector('#feedback [data-act="giveup"]')`, 'the play-out');
  await myTurn(2);
  report.B.status = [await status()]; await shots('B1-tak');
  for (let q = 1; q <= TAK_COUNTDOWN + 1; q++) {
    const g = await gameNow();
    // a quiet placement: not Tak, the game goes on, and the defender gets no win in one from it
    const mv = g.legalMoves().filter((m) => m.kind === 'p').map((m) => g.moveToPTN(m)).find((m) => {
      const c = g.clone(); c.play(m); return !c.result() && !isTak(c, 1) && !winMove(c, 2);
    });
    assert.ok(mv, 'a quiet move');
    await type(mv);
    if (q <= TAK_COUNTDOWN) {
      await myTurn(2 + 2 * q);
      report.B.status.push(await status()); await shots(`B${q + 1}-countdown-${TAK_COUNTDOWN + 1 - q}`);
    }
  }
  await until(`/No threat/.test(document.querySelector('#feedback h2')?.innerText || '')`, 'the out card', 40000);
  await sleep(1500);
  report.B.card = await card(); await shots('B4-out');
  const rB = result();
  assert.equal(rB.length, 1); assert.equal(rB[0].win, false);
  report.B.posted = { win: rB[0].win, casual: !!rB[0].casual, log: rB[0].log.map((e) => `${e.k}:${e.m}`) };
  assert.equal(rB[0].log.filter((e) => e.k === 'po' && !isReplyEntry(e)).length, TAK_COUNTDOWN + 1);
  assert.match(report.B.status[1], /isn’t Tak · 2 moves left/); assert.match(report.B.status[2], /isn’t Tak · 1 move left/);

  // ---- N: 'no' while Syntaks chooses its reply ----
  if (!process.env.ONLY || process.env.ONLY.includes('N')) {
    await startUnproven('pdTakN');
    const mv = takMove(await gameNow(), false); assert.ok(mv, 'a Tak move');
    report.N.answered = await typeThen(mv, `window.__answerStill('no')`);
    report.N.thinkingThen = await status(); // (the reply not in yet: the play-out goes on until it is)
    assert.equal(report.N.answered, 1);
    await until(`/That’s not the move/.test(document.querySelector('#feedback h2')?.innerText || '')`, 'the miss card', 40000);
    await sleep(1500); report.N.card = await card(); await shots('N-refuted');
    const rN = result();
    assert.equal(rN.length, 1); assert.equal(rN[0].win, false); assert.equal(!!rN[0].casual, false, 'a rated miss');
    report.N.posted = { win: rN[0].win, casual: !!rN[0].casual, log: rN[0].log.map((e) => `${e.k}:${e.m}`) };
    assert.equal(rN[0].log.length, 4); assert.ok(isReplyEntry(rN[0].log[3]), 'the reply Syntaks was choosing is on the board and logged');
    assert.equal(rN[0].log[2].m, mv); assert.match(report.N.card, /found no forced win after/);
  }
  // ---- K: 'unknown' changes nothing ----
  if (!process.env.ONLY || process.env.ONLY.includes('K')) {
    await startUnproven('pdTakK');
    report.K.before = await status();
    report.K.answered = await ev(`window.__answerStill('unknown')`); await sleep(500);
    report.K.after = await status(); assert.equal(report.K.after, report.K.before);
    for (let k = 2; ; k++) {
      const g = await gameNow(), mv = takMove(g, true); assert.ok(mv, `a Tak move at ${k}`);
      const c = g.clone(); c.play(mv); await type(mv);
      if (c.result()) break;
      await myTurn(2 * k); assert.ok(k < 30, 'the line ends');
    }
    await until(`/Solved/.test(document.querySelector('#feedback h2')?.innerText || '')`, 'the solved card', 30000); await sleep(1000);
    const rK = result(); report.K.card = await card();
    assert.equal(rK.length, 1); assert.equal(rK[0].win, true); assert.equal(!!rK[0].casual, false, 'a rated solve');
  }
  // ---- W: the win accepted, then the 'no' ----
  if (!process.env.ONLY || process.env.ONLY.includes('W')) {
    await startUnproven('pdTakW');
    for (let k = 2; ; k++) {
      const g = await gameNow(), mv = takMove(g, true); assert.ok(mv, `a Tak move at ${k}`);
      const c = g.clone(); c.play(mv);
      // (the board is PTN Ninja's: a move reaches the page as its INSERT_PLY message. The 'no' goes in the same task, from
      // a listener registered after the board's)
      if (c.result()) {
        // (whether the check was running until the win reached the page: what let it go is recorded from its stack)
        report.W.runningBeforeTyping = await ev(`(() => { window.__wAns = null; window.__letGo = []; Error.stackTraceLimit = 30;
          for (const w of window.__stills) if (!w.dead) { const t = w.terminate.bind(w); w.terminate = () => { window.__letGo.push(/NinjaBoard\\._played/.test(new Error().stack) ? 'the move arriving' : 'before it'); t(); }; }
          addEventListener('message', function h(e) { const d = e.data || {}; if (d.action !== 'INSERT_PLY') return; removeEventListener('message', h); window.__wAns = [String(d.value?.ptn ?? d.value), window.__answerStill('no')]; });
          return window.__stills.filter((w) => !w.dead).length; })()`);
        await type(mv);
        await until(`window.__wAns != null`, 'the winning move reaching the page');
        const [heard, answered] = await ev(`window.__wAns`);
        assert.equal(heard, mv); Object.assign(report.W, { letGoBy: await ev(`window.__letGo`), answered, winAt: k }); break;
      }
      await type(mv); await myTurn(2 * k); assert.ok(k < 30, 'the line ends');
    }
    assert.equal(report.W.runningBeforeTyping, 1, 'the check running as the win is played');
    assert.deepEqual(report.W.letGoBy, ['the move arriving'], 'running until the win reached the page, and let go by it');
    assert.equal(report.W.answered, 0, 'the win let it go in the same task: the \'no\' after it reaches nothing');
    await until(`/Solved/.test(document.querySelector('#feedback h2')?.innerText || '')`, 'the solved card', 30000); await sleep(1500);
    const rW = result(); report.W.card = await card();
    assert.equal(rW.length, 1); assert.equal(rW[0].win, true); assert.equal(!!rW[0].casual, false, 'a rated solve');
    report.W.posted = { win: rW[0].win, casual: !!rW[0].casual, log: rW[0].log.map((e) => `${e.k}:${e.m}`) };
  }

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ report, widths }, null, 1));
  console.log('\nOK: e2e play-on Tak rule');
} finally {
  try { await cdp('Browser.close'); } catch {}
  chrome.kill(); srv.close();
  await sleep(500); fs.rmSync(profile, { recursive: true, force: true }); clearTimeout(watchdog);
}
