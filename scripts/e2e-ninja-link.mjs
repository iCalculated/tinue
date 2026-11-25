// The ↗ that opens the puzzle in PTN Ninja (Sasha, 2026-11-22: "the open in ptn ninja button on the solution screen"),
// end to end: the real server (server/server.js) on a new database with two fixture puzzles, and the real page in
// headless Chrome, in the production build (window.TINUE_ANALYSIS held at false) and the beta's (local config.js: true),
// on PTN Ninja's board, the only one (a local stand-in, scripts/ninja-standin.html, in place of https://ptn.ninja; the
// production rounds open the page with ?board=tinue, which is ignored).
// The ↗ is never in the page while the puzzle is on (it carries the solution): not while solving, not after a wrong
// move; once it is over (solved, missed then solved, the solution shown) there is one ↗ by the step buttons (the beta
// also has the info row's "PTN Ninja ↗"), at 1280x800 and in the phone's dock at 390x844. Its address is decoded and
// replayed: the puzzle's position, the line shown, the ply shown (◀ and ▶ move it). Production loads nothing else of
// the analysis view (no analysis.css, no candidate chips, no info-row link).
// With E2E_REAL=1, a last phase on the real https://ptn.ninja (a few cold loads, seconds apart): tinue classic picked
// on the Settings page goes to the embedded board as SET_UI with its theme object and is drawn (the board's light
// squares sampled from a screenshot: #f0d9b5), and the ↗'s address opened on ptn.ninja shows the puzzle by its name.
// Not part of npm test (it needs Chrome):  node scripts/e2e-ninja-link.mjs [shots dir]
// Ports: $E2E_PORT (default 9361) for the server, +1 for DevTools. Its database and Chrome profile live in a new
// directory under $E2E_TMP (else the system's temporary directory), removed at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { decompressFromEncodedURIComponent as unlz } from '../public/vendor/lz-string.js';
import { replay } from '../public/shared/ptn.js';
import { Game } from '../shared/tak.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.argv[2] || null;
const REAL = !!process.env.E2E_REAL;
const PORT = +process.env.E2E_PORT || 9361, DT = PORT + 1, BASE = `http://127.0.0.1:${PORT}`;
const STANDIN = fs.readFileSync(path.join(ROOT, 'scripts/ninja-standin.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'tinue-e2e-link-'));
const DB = path.join(dir, 'e2e.db');
let n = 0;
const kids = [];
process.on('exit', () => { for (const k of kids) try { k.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const watchdog = setTimeout(() => { console.log('timed out after 330 s at step', n + 1); for (const k of kids) try { k.kill(); } catch {} process.exit(2); }, 330000);
const step = (s) => { n++; console.log('ok', s); };

// ---------- the server ----------
const boot = () => new Promise((resolve, reject) => {
  const env = { ...process.env, PORT: String(PORT), TINUE_DB: DB, TINUE_ACCESS_LOG: path.join(dir, 'access.log'), TINUE_SYNTAKS: '/nonexistent', TINUE_LOG: '0' };
  delete env.TINUE_ORIGINS;
  const c = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server/server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  c.stdout.on('data', (d) => { if (String(d).includes('tinue on')) resolve(c); });
  c.on('exit', (code) => reject(new Error('server exited ' + code)));
  kids.push(c);
});
{ const c = await boot(); c.kill(); await new Promise((r) => c.once('exit', r)); } // (the schema)
const PUZZLES = [
  { id: 'thr19', tps: 'x2,1,2,x2/1,2,2,2,2,11/12,1,1,x2,1C/22,x,2,1,21,1/2,1111,11,2,x,2/2,2,12,2,2,1 1 25', tree: { '4b2>1111': { r: 'e1>', n: 'win' } }, turn: 1 },
  { id: 'thr12', tps: '1,x,1,x,1,1/2,2,1,2,12,x/1,2,2,1,x,1/2,2,1S,2,x2/1,x,2,2,2,x/2,2,1,x2,1 2 17', tree: { Cb2: { r: 'Sf2', n: 'win' }, Cf2: { r: 'Sb2', n: 'win' } }, turn: 2 },
  // a puzzle with its game's history (meta.history): the link's PTN is the whole game and its ply counts the history too.
  // A game played at random until the side to move has a road in one; the puzzle starts two plies before that.
  (() => {
    const legal = (g) => g.legalMoves().map((m) => g.moveToPTN(m));
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (;;) {
      const g = new Game(6), h = [];
      for (let i = 0; i < 60 && !g.result(); i++) {
        const roads = legal(g).filter((m) => { const c = g.clone(); c.play(m); return c.result()?.winner === g.toMove; });
        if (roads.length && h.length >= 14) {
          const start = new Game(6); for (const m of h.slice(0, -2)) start.play(m);
          if (start.toMove !== g.toMove) break;
          return { id: 'hist1', tps: start.toTPS(), tree: { [h.at(-2)]: { r: h.at(-1), n: 'win' } }, turn: start.toMove, meta: { history: h.slice(0, -2) } };
        }
        const ms = legal(g).filter((m) => { const c = g.clone(); c.play(m); return !c.result(); });
        const m = ms[Math.floor(rnd() * ms.length)]; g.play(m); h.push(m);
      }
    }
  })(),
];
{
  const db = new DatabaseSync(DB);
  const ins = db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, source_ref, init_rating, rating, komi, turn, grade, meta) VALUES (?, 6, ?, 3, ?, '', 'playtak', '1', 1500, 1500, 0, ?, 'A', ?)`);
  for (const p of PUZZLES) ins.run(p.id, p.tps, JSON.stringify(p.tree), p.turn, p.meta ? JSON.stringify(p.meta) : null);
  db.close();
}
await boot();

// ---------- Chrome ----------
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${path.join(dir, 'chrome')}`, '--no-first-run', '--no-default-browser-check',
  '--mute-audio', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
kids.push(chrome);
let ws, id = 0, real = false, ninjaLoads = 0;
const pending = new Map(), errors = [];
for (let i = 0; i < 50 && !ws; i++) {
  try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch {}
  await sleep(200);
}
if (!ws) throw new Error('no Chrome page to drive');
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; setTimeout(() => j(new Error('DevTools socket never opened')), 10000); });
const cdp = (method, params = {}, sessionId) => new Promise((r, j) => {
  const i = ++id, t = setTimeout(() => { pending.delete(i); j(new Error('no answer to ' + method)); }, 20000);
  pending.set(i, (m) => { clearTimeout(t); m.error ? j(new Error(method + ': ' + m.error.message)) : r(m.result); });
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
// Requests: app.js gets read-only handles on the page's state appended (the repository is untouched); https://ptn.ninja
// is the stand-in (its modules from this checkout), or the real one in the last phase.
async function paused(p, sessionId) {
  const url = new URL(p.request.url);
  try {
    if (url.origin === 'https://ptn.ninja') {
      if (p.resourceType === 'Document') ninjaLoads++;
      if (real) return await cdp('Fetch.continueRequest', { requestId: p.requestId }, sessionId);
      let body, type = 'text/html';
      if (url.pathname.startsWith('/__tinue/')) { body = fs.readFileSync(path.join(ROOT, url.pathname.slice(9))); type = 'text/javascript'; }
      else body = Buffer.from(STANDIN.replace('__MODE__', 'ok'));
      return await cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: type }, { name: 'cache-control', value: 'no-store' }], body: body.toString('base64') }, sessionId);
    }
    if (p.responseStatusCode && /\/app\.js(\?|$)/.test(url.pathname + url.search) && url.origin === BASE) {
      const b = await cdp('Fetch.getResponseBody', { requestId: p.requestId }, sessionId);
      const src = (b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body) + '\n;window.__e2e = { S: () => S, board: () => board };\n';
      return await cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: (p.responseHeaders || []).filter((h) => !/^content-length$/i.test(h.name)), body: Buffer.from(src).toString('base64') }, sessionId);
    }
    await cdp('Fetch.continueRequest', { requestId: p.requestId }, sessionId);
  } catch (e) { cdp('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {}); }
}
const PATTERNS = { patterns: [{ urlPattern: 'https://ptn.ninja/*' }, { urlPattern: '*/app.js*', requestStage: 'Response' }] };
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Fetch.requestPaused') paused(m.params, m.sessionId);
  else if (m.method === 'Target.attachedToTarget') {
    const s = m.params.sessionId;
    (async () => { if (m.params.targetInfo.type === 'iframe') await cdp('Fetch.enable', PATTERNS, s).catch(() => {}); await cdp('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {}); })();
  } else if (m.method === 'Runtime.exceptionThrown' && !m.sessionId) errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
};
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' in ' + expr.slice(0, 120)); return r.result?.value; };
const until = async (expr, what, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return; await sleep(100); } throw new Error('timed out: ' + what + ' errors: ' + JSON.stringify(errors)); };
const size = (w, h, mobile = false) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
const shotData = async () => Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64');
const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await ev('(scrollTo(0, 0), true)'); await sleep(400); fs.writeFileSync(path.join(SHOTS, name), await shotData()); };
const click = async (sel) => {
  const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; let b = e.getBoundingClientRect(); if (b.top < 0 || b.bottom > innerHeight) { e.scrollIntoView({ block: 'nearest' }); b = e.getBoundingClientRect(); } return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  assert.ok(r, 'nothing to click at ' + sel);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Fetch.enable', PATTERNS);
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
let prodScript = null;
const production = async (on) => {
  if (on && !prodScript) prodScript = (await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'TINUE_ANALYSIS', { get: () => false, set() {}, configurable: false });` })).identifier;
  else if (!on && prodScript) { await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: prodScript }); prodScript = null; }
};
const load = async (at, prefs = null) => {
  await cdp('Page.navigate', { url: BASE + '/LICENSE.txt' }); await sleep(150);
  await ev(`(localStorage.clear(), sessionStorage.clear(), ${prefs ? `localStorage.setItem('tinue.prefs', ${JSON.stringify(JSON.stringify(prefs))}),` : ''} true)`);
  await cdp('Page.navigate', { url: BASE + at });
  await until(`document.readyState === 'complete' && !!window.__e2e`, 'the page');
};

// ---------- what the page shows ----------
const S = 'window.__e2e.S()';
// (and past the first moments of a new puzzle, when its board takes no move: busy.js 'board')
const ready = `${S} && !${S}.placeholder && ${S}.t0 != null && !${S}.busy && ${S}.status === 'play' && performance.now() - ${S}.born > 900`;
const links = () => ev(`[...document.querySelectorAll('a[data-ninja]')].map((a) => ({ where: a.closest('.nav') ? (a.closest('.dock') ? 'dock' : 'nav') : a.closest('#info') ? 'info' : 'other', href: a.getAttribute('href'), text: a.textContent, target: a.target, rel: a.rel, shown: !!a.getClientRects().length }))`);
const noLink = async (where) => { assert.deepEqual(await links(), [], where + ': no PTN Ninja link'); };
const statusIs = (s) => ev(`${S}.status`).then((v) => assert.equal(v, s));
// While the puzzle is on, every 50 ms: the ↗ must never be in the page (sampled across the moves and replies; the
// status and the page read in one go)
let watch = null;
const watchStart = () => { watch = { bad: [] }; const w = watch; (async () => { while (watch === w) { const st = await ev(`(() => { const s = ${S}; return s && s.status !== 'solved' && document.querySelectorAll('a[data-ninja]').length ? s.status : null; })()`).catch(() => null); if (st) w.bad.push(st); await sleep(50); } })(); };
const watchStop = () => { const w = watch; watch = null; assert.deepEqual(w.bad, [], 'a PTN Ninja link while the puzzle was on'); };
async function move(mv) {
  const before = await ev(`${S}.moves.length`);
  assert.ok(await ev(`Promise.resolve(window.__e2e.board().play(${JSON.stringify(mv)})).then((r) => r !== false)`), 'could not play ' + mv);
  await until(`(${S}.moves.length >= ${before + 1} && !${S}.busy) || ${S}.status === 'solved'`, 'the move taken', 15000).catch(async (e) => { throw new Error(e.message + ' ' + mv + ' ' + JSON.stringify(await ev(`(() => { const s = ${S}; return { cb: document.querySelector('#confirm-bar')?.hidden, bcur: window.__e2e.board().cur, bsn: window.__e2e.board().snaps?.length, prefs: localStorage.getItem('tinue.prefs'), vis: document.visibilityState, born: s.born, now: performance.now(), view: s.view, can: window.__e2e.board()._canInput?.(), st: s.status, busy: s.busy, moves: s.moves.map((m) => m.ptn), node: s.node, p: s.p.tps }; })()`))); });
}
async function solve() {
  for (let k = 0; k < 6 && !(await ev(`${S}.status === 'solved'`)); k++) {
    await until(`!${S}.busy && performance.now() - ${S}.born > 900`, 'ready to move', 15000); await sleep(300);
    const mv = await ev(`(async () => { const s = ${S}, T = await import('/shared/tak.js'); const g = T.Game.fromTPS(s.p.tps, s.p.komi || 0); for (const m of s.moves) g.play(m.ptn);
      if (s.node && typeof s.node === 'object') return Object.keys(s.node)[0]; return T.winningMoves(g, 1).moves[0]; })()`);
    await move(mv);
    await sleep(300);
  }
  await until(`${S}.status === 'solved'`, 'solved');
}
// A move off the puzzle's line: any legal one not in the tree (a flat on an empty square, else anything)
async function wrongMove() {
  await until(`!${S}.busy && performance.now() - ${S}.born > 900`, 'ready to move', 15000); await sleep(300);
  const mv = await ev(`(async () => { const s = ${S}, T = await import('/shared/tak.js'); const g = T.Game.fromTPS(s.p.tps, s.p.komi || 0); for (const m of s.moves) g.play(m.ptn);
    const good = new Set(Object.keys(s.node || {})), wins = new Set(T.winningMoves(g, 1).moves || []);
    return g.legalMoves().map((m) => g.moveToPTN(m)).find((p) => !good.has(p) && !wins.has(p) && /^[a-h][1-8]$/.test(p)); })()`);
  assert.ok(mv, 'a wrong move');
  await ev(`Promise.resolve(window.__e2e.board().play(${JSON.stringify(mv)}))`);
  await until(`${S}.status === 'retry' || ${S}.status === 'playon' || ${S}.misses?.length > 0`, 'the miss', 15000);
  await sleep(300);
  return mv;
}
// The ↗'s address, decoded: the PTN replays to the position the page shows (S.snaps), at the ply shown
async function checkHref(where) {
  await until(`[...document.querySelectorAll('a[data-ninja]')].every((a) => a.getAttribute('href')) && document.querySelectorAll('a[data-ninja]').length > 0`, where + ': the link has its address');
  const ls = await links(), href = ls[0].href;
  for (const l of ls) assert.equal(l.href, href, where + ': every link the same');
  const m = /^https:\/\/ptn\.ninja\/([A-Za-z0-9$+-]+)&name=([^&]+)(?:&ply=(\d+)!)?$/.exec(href);
  assert.ok(m, where + ': ' + href);
  const ptn = unlz(m[1]);
  const st = await ev(`(() => { const s = ${S}; return { id: s.p.id, tps: s.p.tps, view: s.view, hist: s.hist, moves: s.moves.map((x) => x.ptn), snaps: s.snaps, branch: !!(s.branch && s.onBranch) }; })()`);
  assert.equal(decodeURIComponent(m[2]), 'tinue #' + st.id, where + ': named');
  // with a game's history the PTN is the whole game from the empty board, and the ply counts the history too
  const line = [...st.hist, ...st.moves], plies = st.view ?? line.length;
  assert.equal(m[3] == null ? 0 : +m[3] + 1, plies, where + ': at the ply shown');
  const r = replay(ptn, plies);
  assert.equal(r.headers.TPS, st.hist.length ? undefined : st.tps, where + ': the puzzle\'s position');
  assert.deepEqual(r.moves, line, where + ': the line shown');
  let want;
  if (plies >= st.hist.length) want = st.snaps[plies - st.hist.length];
  else { const g = new Game(6); for (const mv of st.hist.slice(0, plies)) g.play(mv); want = g.toTPS(); }
  assert.equal(r.g.toTPS().split(' ')[0], want.split(' ')[0], where + ': the position at that ply');
  if (st.hist.length && plies >= st.hist.length) { const g = new Game(6); for (const mv of st.hist) g.play(mv); assert.equal(g.toTPS().split(' ')[0], st.tps.split(' ')[0], where + ': the history reaches the puzzle'); }
  return { href, plies };
}
// After the puzzle: exactly the ↗ by the step buttons in production (the beta adds the info row's link)
async function after(where, prod, phone = false) {
  await until(`${S}.status === 'solved' && !${S}.busy`, where + ': over');
  await sleep(600);
  const ls = await links();
  const want = prod ? [phone ? 'dock' : 'nav'] : [phone ? 'dock' : 'nav', 'info'];
  assert.deepEqual(ls.map((l) => l.where).sort(), want.sort(), where + ': where the links are ' + JSON.stringify(ls));
  for (const l of ls) { assert.equal(l.target, '_blank'); assert.match(l.rel, /noopener/); assert.ok(l.shown, where + ': shown'); }
  assert.equal(ls.find((l) => l.where !== 'info').text, '↗');
  assert.equal(await ev(`document.querySelector('#moves .nav a[data-ninja]').getAttribute('aria-label')`), 'Open this line in PTN Ninja');
  if (prod) {
    assert.equal(await ev(`!!document.querySelector('link[href*="analysis.css"]')`), false, where + ': no analysis.css');
    assert.equal(await ev(`document.querySelectorAll('#moves .chip, #moves .eng.ana, #moves [data-thr]').length`), 0, where + ': nothing else of the analysis view');
  }
  const h = await checkHref(where);
  // the ply follows the step buttons
  if (!phone) {
    await click('#moves .nav button[data-step="first"]'); await sleep(300);
    let h2 = await checkHref(where + ' ⏮');
    assert.equal(h2.plies, 0, 'at the start: no ply'); assert.doesNotMatch(h2.href, /&ply=/);
    await click('#moves .nav button[data-step="next"]'); await sleep(300);
    await click('#moves .nav button[data-step="next"]'); await sleep(300);
    h2 = await checkHref(where + ' ▶▶');
    assert.ok(h2.plies >= 1 && h2.plies <= h.plies, where + ' ▶▶ ' + h2.plies);
    await click('#moves .nav button[data-step="last"]'); await sleep(300);
    assert.equal((await checkHref(where + ' ⏭')).href, h.href);
  }
  return h;
}

const ROUNDS = [];
try {
  for (const prod of [true, false]) for (const brd of ['ninja']) {
    const cfg = (prod ? 'production, ?board=tinue' : 'beta') + ', PTN Ninja’s board';
    await production(prod);
    const q = prod ? '/?board=tinue' : '/';
    for (const [w, h, phone] of [[1280, 800, false], [390, 844, true]]) {
      await size(w, h, phone);
      const tag = `${prod ? 'prod' : 'beta'}-${brd}-${w}`;
      // solved
      await load(q + '#/puzzle/thr19');
      await until(ready, 'puzzle ready', 30000);
      assert.equal(await ev(`!!document.querySelector('#board iframe') && !document.querySelector('.tb-sq, .tb')`), true, 'PTN Ninja\'s board (the stand-in) in use, no other');
      await noLink(cfg + ' solving');
      watchStart(); await solve(); watchStop();
      ROUNDS.push(await after(cfg + ' ' + w + ' solved', prod, phone));
      await shot(`${tag}-solved.png`);
      // missed: a wrong move (no link while it is shown and while the puzzle goes on), then solved
      await load(q + '#/puzzle/thr19');
      await until(ready, 'puzzle ready', 30000);
      watchStart();
      await wrongMove();
      await noLink(cfg + ' after a wrong move (' + (await ev(`${S}.status`)) + ')');
      await until(`${S}.status === 'retry' || ${S}.status === 'play' || ${S}.status === 'solved'`, 'back to the puzzle', 15000);
      if (await ev(`${S}.status !== 'solved'`)) { await until(`!${S}.busy && !${S}.needsRestore`, 'restored', 15000); await solve(); }
      watchStop();
      assert.ok(await ev(`${S}.misses.length > 0`), 'the miss counted');
      await after(cfg + ' ' + w + ' missed', prod, phone);
      await shot(`${tag}-missed.png`);
      // the solution shown
      await load(q + '#/puzzle/thr12');
      await until(ready, 'puzzle ready', 30000);
      await sleep(1200); // (Solution takes presses after the first second)
      watchStart();
      await click('#feedback [data-act="solution"]');
      await until(`${S}.status === 'solved' && !${S}.busy`, 'the solution shown', 20000);
      watchStop();
      await after(cfg + ' ' + w + ' solution', prod, phone);
      await shot(`${tag}-solution.png`);
      // a puzzle with its game's history: the whole game in the link, the ply counted from the game's start
      if (!phone) {
        await load(q + '#/puzzle/hist1');
        await until(ready, 'puzzle ready', 30000);
        assert.ok(await ev(`${S}.hist.length >= 12`), 'the history puzzle has its history');
        watchStart(); await solve(); watchStop();
        const hh = await after(cfg + ' ' + w + ' with history', prod, phone);
        assert.ok(hh.plies > await ev(`${S}.moves.length`), 'the ply counts the history');
        await shot(`${tag}-history.png`);
      }
    }
    step(cfg + ': no link while solving or after a wrong move; after solved, missed and Solution one ↗ by the step buttons (dock on the phone)' + (prod ? '' : ' and the info row\'s') + ', its PTN replayed to the position at the ply shown (and with a game\'s history: the whole game, the ply counted from its start)');
  }
  // the Settings page's theme list (opened out as a list box for the picture: a dropdown's own popup isn't in a screenshot)
  await production(true);
  for (const [w, h, phone] of [[1280, 800, false], [390, 844, true]]) {
    await size(w, h, phone);
    await load('/#/settings');
    await until(`!!document.querySelector('#st-ninja-theme') && !document.querySelector('#st-ninja-theme').disabled`, 'the theme select');
    const names = await ev(`[...document.querySelectorAll('#st-ninja-theme option')].filter((o) => !o.hidden).map((o) => o.textContent)`);
    assert.deepEqual(names.slice(0, 2), ['tinue felt', 'tinue classic']); assert.equal(names.length, 20);
    if (SHOTS) { await ev(`(() => { const s = document.querySelector('#st-ninja-theme'); s.size = 20; s.style.height = 'auto'; s.style.backgroundImage = 'none'; s.closest('.set-item').scrollIntoView({ block: 'start' }); return true; })()`); await sleep(400); fs.writeFileSync(path.join(SHOTS, `settings-themes-${w}.png`), await shotData()); }
  }
  step('the Settings page lists tinue felt, tinue classic and PTN Ninja’s 18 built-ins');
  await size(1280, 800);

  if (REAL) {
    real = true;
    await production(true);
    await cdp('Network.enable'); await cdp('Network.setCacheDisabled', { cacheDisabled: false });
    // tinue classic chosen on the Settings page: SET_UI with its theme object, drawn on the embedded board
    await load('/#/puzzle/thr19', { size: '6' });
    await until(`${S} && !${S}.placeholder && document.querySelector('#board iframe')?.style.opacity === '1'`, 'PTN Ninja shown', 30000);
    await sleep(2500);
    await ev(`(() => { const b = window.__e2e.board(), o = b._post.bind(b); window.__sent = []; b._post = (a, v) => { window.__sent.push({ a, v: JSON.parse(JSON.stringify(v ?? null)) }); return o(a, v); }; return true; })()`);
    await ev(`(location.hash = '#/settings', true)`);
    await until(`!!document.querySelector('#st-ninja-theme') && !document.querySelector('#st-ninja-theme').disabled`, 'the theme select');
    const opts = await ev(`[...document.querySelectorAll('#st-ninja-theme option')].filter((o) => !o.hidden).map((o) => o.value + ':' + o.textContent)`);
    assert.equal(opts.length, 20, opts.join(' '));
    assert.deepEqual(opts.slice(0, 2), [':tinue felt', 'legacy:tinue classic']);
    await ev(`(() => { const s = document.querySelector('#st-ninja-theme'); s.value = 'legacy'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await until(`window.__sent.some((m) => m.a === 'SET_UI' && m.v && m.v.theme && m.v.theme.id === 'tinue-legacy')`, 'SET_UI with tinue classic');
    const sent = (await ev('window.__sent')).find((m) => m.a === 'SET_UI' && m.v.theme?.id === 'tinue-legacy');
    assert.equal(sent.v.theme.colors.board1, '#f0d9b5'); assert.equal(sent.v.theme.boardChecker, true);
    assert.equal(await ev(`document.querySelector('#st-ninja').value`), '&theme=legacy', 'the paste box: readable');
    assert.equal(await ev(`document.querySelector('#st-ninja-theme').value`), 'legacy');
    if (SHOTS) { await ev(`(document.querySelector('.set-list').scrollIntoView({ block: 'start' }), true)`); await sleep(400); fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, 'real-settings-legacy-1280.png'), await shotData()); }
    await ev(`(location.hash = '#/puzzle/thr19', true)`);
    await sleep(3000);
    // the board's colours, from a picture: the legacy board's two square colours, not the felt's
    const box = await ev(`(() => { scrollTo(0, 0); const b = document.querySelector('#board').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()`);
    await sleep(400);
    const png = await shotData();
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'real-legacy-board-1280.png'), png);
    const px = pixels(png);
    const near = (c) => { let k = 0; for (let y = Math.round(box[1]); y < box[1] + box[3]; y += 3) for (let x = Math.round(box[0]); x < box[0] + box[2]; x += 3) { const [r, g, b] = px.at(x, y); if (Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) < 24) k++; } return k; };
    const light = near([0xf0, 0xd9, 0xb5]), dark = near([0xb5, 0x88, 0x63]), felt = near([0x4a, 0x67, 0x61]);
    assert.ok(light > 200 && dark > 200 && felt < 50, 'the legacy board drawn ' + JSON.stringify({ light, dark, felt }));
    step(`real ptn.ninja: tinue classic picked, sent as SET_UI with its theme object and drawn (light ${light}, dark ${dark}, felt ${felt} samples)`);
    // the ↗ opened on ptn.ninja
    await sleep(2000);
    await solve(); await sleep(1500);
    await after('real ptn.ninja, tinue classic', true);
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'real-legacy-solved-1280.png'), await shotData());
    const h = await checkHref('real');
    await cdp('Page.navigate', { url: h.href });
    await until(`location.origin === 'https://ptn.ninja' && document.title.includes('tinue #thr19')`, 'the game on ptn.ninja', 30000);
    await sleep(3000);
    const title = await ev('document.title');
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'real-opened-1280.png'), await shotData());
    step('the ↗ opened on ptn.ninja: ' + title + ' (' + ninjaLoads + ' ptn.ninja page loads in all)');
  }
  assert.deepEqual(errors.filter((e) => !/ptn\.ninja|ResizeObserver/i.test(e)), [], 'no page errors');
  console.log(`all ${n} steps passed`);
} finally {
  try { ws.close(); } catch {}
  for (const k of kids) try { k.kill(); } catch {}
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
  clearTimeout(watchdog);
}
process.exit(0);

// A PNG's pixels (8-bit RGB or RGBA, as Chrome writes them): at(x, y) -> [r, g, b]
function pixels(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (type === 'IDAT') idat.push(d); p += 12 + len; }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      out[y * stride + x] = (line[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
  }
  return { at: (x, y) => { const i = Math.round(y) * stride + Math.round(x) * bpp; return [out[i], out[i + 1], out[i + 2]]; } };
}
