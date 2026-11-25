// The Rush end screen's look-back dialog in a real browser: headless Chrome against a fake API (no database, no network)
// and a stored run (localStorage, as rush.js keeps it), opened from the recent runs. A card opens the dialog (its
// result button says so: aria-expanded), the arrow keys move through the run, Esc closes it and gives the focus back to
// the card. Then the ways out of the page with the dialog open, each of which once left it open and modal in a hidden
// page, so nothing anywhere took a click until a reload: the dialog's #id link to the puzzle page, the browser's Back
// to Rush, and any other route. After each, a click on a visible button must land on that button.
// Not part of npm test (it needs Chrome):  node scripts/e2e-rush-look.mjs [chrome binary]
// Ports $E2E_PORT (9321: pages + API) and the next one (DevTools); its Chrome profile lives in a new directory under
// $E2E_TMP (else the system's temporary directory), removed at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standin, STANDIN_ARGS, STANDIN_PATTERN } from './e2e-standin.mjs'; // (PTN Ninja, the only board: a local stand-in)
import * as R from '../public/rush-rules.js';
import * as SYM from '../shared/sym.js';
import { encodeLook, LEGACY } from '../public/ninja-look.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.argv[2] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = +(process.env.E2E_PORT || 9321), DT = PORT + 1, BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const legal = (g) => g.legalMoves().map((m) => g.moveToPTN(m));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rush-sym-sample.json'), 'utf8'));

// A stored run of six puzzles under symmetries 0..5, solved and wrong in turn (R.recordOf, as rush.js stores it).
function stored() {
  const run = R.newRun('rush'), ps = [];
  R.startClock(run, 0);
  SAMPLE.slice(0, 6).forEach((p0, i) => {
    const p = SYM.orient(p0, i), tree = p.tree === 'win' ? {} : p.tree; ps.push(p);
    const wrong = legal(R.startGame(p)).find((m) => !(m in tree) && /^[a-h]\d$/.test(m));
    if (i % 2) { R.wrong(run, 1000); R.finish(run, { id: p.id, rating: p.rating, ms: 3000, sym: i, solved: false, wrong, at: [] }); }
    else { R.correct(run); R.finish(run, { id: p.id, rating: p.rating, ms: 2000, sym: i, solved: true }); }
  });
  R.end(run, 170e3);
  return R.recordOf(run, ps, Date.now() - 60e3);
}

// ---------- the fake API ----------
const user = { id: 1, name: null, rating: 1500, rd: 100, provisional: true, games: 0, wins: 0 };
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/json' };
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  await new Promise((r) => { req.on('data', () => {}); req.on('end', r); });
  const json = (o, st = 200) => res.writeHead(st, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (u.pathname.startsWith('/api/')) {
    if (u.pathname === '/api/me') return json({ user });
    if (u.pathname.startsWith('/api/puzzle/')) {
      const p = SAMPLE.find((x) => x.id === decodeURIComponent(u.pathname.slice(12)));
      return json({ puzzle: p ? { ...p, themes: [], attempts: 1, solves: 0, rd: 80, source: 'playtak', sourceRef: '1', meta: {} } : null });
    }
    if (u.pathname === '/api/rush/top') return json({ top: [] });
    if (u.pathname === '/api/themes') return json({ themes: {} }); // (the glossary, the other page visited)
    return json({ error: 'unknown route' }, 404);
  }
  let f = path.join(ROOT, 'public', decodeURIComponent(u.pathname));
  if (u.pathname === '/') f = path.join(ROOT, 'public/index.html');
  try { const buf = fs.readFileSync(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(buf); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

// ---------- Chrome over the DevTools protocol ----------
const profile = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'tinue-e2e-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...STANDIN_ARGS, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0, ninjaMode = process.env.E2E_NINJA || 'ok';
const pending = new Map(), logs = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch {}
    await sleep(200);
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Fetch.requestPaused') standin(cdp, m.params, () => ninjaMode); else if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails?.exception?.description); };
}
// (each call gives up after 60 s, and a DevTools error is thrown, naming the call)
const cdp = (method, params = {}) => new Promise((r, j) => { const i = ++id, t = setTimeout(() => { pending.delete(i); j(new Error('no answer to ' + method)); }, 60e3); t.unref(); pending.set(i, (m) => { clearTimeout(t); if (m.error) j(new Error(`${method}: ${m.error.message}`)); else r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + expr); return r.result?.result?.value; };
const until = async (expr, what, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return; await sleep(100); } throw new Error('timed out: ' + what); };
// A real mouse click (input events, as a player's: a click() from script would get through an inert page) at the
// middle of the first visible element matching sel; returns what was under the pointer.
async function clickOn(sel) {
  const r = await ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length && x.getBoundingClientRect().width > 0); if (!e) return null;
    e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(), x = b.x + b.width / 2, y = b.y + b.height / 2; window.__hit = null;
    document.addEventListener('click', (ev) => { window.__hit = ev.target === e || e.contains(ev.target); }, { capture: true, once: true }); return { x, y }; })()`);
  assert.ok(r, 'something to click: ' + sel);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await sleep(150);
  return ev('window.__hit');
}
const key = async (k, code) => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: { Escape: 27, ArrowRight: 39 }[k] }); await sleep(150); };
const dlg = () => ev(`(() => { const d = document.querySelector('#rush-look'); return { open: !!d?.open, h: d?.querySelector('h2')?.textContent || '' }; })()`);
const expanded = () => ev(`[...document.querySelectorAll('.rush-card .rush-res')].map((b) => b.getAttribute('aria-expanded'))`);
// the end screen of the stored run, opened from the recent runs
async function openRun() {
  await ev(`location.hash = '#/rush'; 1`);
  await until(`!!document.querySelector('.rush-recent-row')`, 'the recent runs');
  assert.ok(await clickOn('.rush-recent-row'), 'the recent run takes the click');
  await until(`document.querySelectorAll('.rush-card').length === 6`, 'six cards');
}

let ok = 0;
const step = async (name, fn) => { await fn(); ok++; console.log('ok', name); };
try {
  await connect();
  await cdp('Runtime.enable'); await cdp('Fetch.enable', { patterns: [STANDIN_PATTERN] });
  await cdp('Page.navigate', { url: BASE });
  await until(`document.readyState === 'complete'`, 'the page');
  await ev(`localStorage.clear(); localStorage.setItem('tinue.rushHistory', ${JSON.stringify(JSON.stringify([stored()]))}); 1`);
  await cdp('Page.navigate', { url: BASE + '#/rush' });
  await until(`document.readyState === 'complete'`, 'the page');

  await step('a card opens its puzzle; the arrow keys move on; Esc closes and the focus goes back to the card', async () => {
    await openRun();
    assert.ok(await clickOn('.rush-card[data-i="2"] .rush-res'), 'the card takes the click');
    assert.equal((await dlg()).open, true); assert.match((await dlg()).h, /^Puzzle 3 of 6/);
    assert.deepEqual(await expanded(), ['false', 'false', 'true', 'false', 'false', 'false']);
    assert.equal(await ev('document.activeElement.id'), 'rush-look-x');
    await key('ArrowRight', 'ArrowRight');
    assert.match((await dlg()).h, /^Puzzle 4 of 6/); assert.equal((await expanded())[3], 'true');
    await key('Escape', 'Escape');
    assert.equal((await dlg()).open, false);
    assert.ok((await expanded()).every((x) => x === 'false'));
    assert.equal(await ev(`document.activeElement.closest('.rush-card')?.dataset.i`), '3');
  });
  await step('the dialog\'s #id link: the puzzle page, and nothing left open over it', async () => {
    assert.ok(await clickOn('.rush-card[data-i="1"] .rush-res'));
    assert.ok(await clickOn('#rush-look a'), 'the link takes the click');
    await until(`location.hash.startsWith('#/puzzle/') && !document.querySelector('#view-puzzle').classList.contains('hidden')`, 'the puzzle page');
    assert.equal((await dlg()).open, false, 'the dialog closed');
    assert.equal(await ev(`document.querySelectorAll(':modal').length`), 0);
    assert.ok(await clickOn('#view-puzzle button:not([disabled])'), 'a button on the puzzle page takes the click');
  });
  await step('the browser\'s Back to Rush: its buttons take clicks', async () => {
    await ev('history.back(); 1');
    await until(`location.hash === '#/rush' && !document.querySelector('#view-rush').classList.contains('hidden')`, 'Rush again');
    await sleep(300);
    assert.equal(await ev(`document.querySelectorAll(':modal').length`), 0);
    assert.ok(await clickOn('#view-rush button:not([disabled])'), 'a button on Rush takes the click');
  });
  await step('another route with the dialog open (leave()): closed, and that page takes clicks', async () => {
    await openRun();
    assert.ok(await clickOn('.rush-card[data-i="0"] .rush-res'));
    assert.equal((await dlg()).open, true);
    await ev(`location.hash = '#/glossary'; 1`);
    await until(`document.querySelector('#view-rush').classList.contains('hidden')`, 'another page');
    await sleep(300);
    assert.equal((await dlg()).open, false, 'the dialog closed');
    assert.equal(await ev(`document.querySelectorAll(':modal').length`), 0);
    assert.ok(await clickOn('[data-nav]'), 'that page takes the click');
  });
  await step('the player\'s board theme: a built-in one heard late recolours the same pictures in place (felt until then, nothing moves); known at once the next time; tinue classic at once', async () => {
    const page = (look) => JSON.stringify(JSON.stringify({ ninja: look }));
    await ev(`localStorage.setItem('tinue.prefs', ${page(encodeLook({ theme: 'zen' }))}); localStorage.removeItem('tinue.ninjaThemes'); 1`);
    ninjaMode = 'holdtheme';
    await cdp('Page.navigate', { url: BASE + '?zen#/rush' });
    await until(`document.readyState === 'complete' && document.querySelector('#board iframe')?.dataset.up === '1'`, 'the frame up');
    await sleep(300);
    await openRun();
    const rects = () => ev(`JSON.stringify([...document.querySelectorAll('.rush-card, .rush-card .rush-pic, #rush-look[open], #rush-look[open] .rush-pic')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => v.toFixed(2)); }))`);
    assert.equal(await ev(`document.querySelector('#rush-end').classList.contains('rt')`), false, 'not heard yet: felt');
    assert.ok(await clickOn('.rush-card[data-i="1"] .rush-res'));
    const before = await rects();
    await ev(`document.querySelector('#board iframe').contentWindow.postMessage({ action: 'STANDIN_GIVE_THEME' }, '*'); 1`);
    await until(`document.querySelector('#rush-end').classList.contains('rt')`, 'the theme arrives');
    await sleep(100);
    assert.equal(await rects(), before, 'nothing moved: the cards, the pictures and the dialog where they were');
    assert.equal(await ev(`getComputedStyle(document.querySelector('#rush-end')).getPropertyValue('--rt-b1').trim()`), '#decb9e', 'Zen\'s board');
    assert.equal(await ev(`getComputedStyle(document.querySelector('#rush-look .tb-sq'), '::before').backgroundColor`), 'rgb(222, 203, 158)', 'a square\'s tile in Zen\'s board1');
    assert.equal(await ev(`import('/ninja.js').then((m) => m.knownTheme('zen')?.boardStyle)`), 'grid3');
    await key('Escape', 'Escape');
    // the next end screen: themed as it is drawn (checked in the same task as the click: no felt frame in between)
    await ev(`document.querySelector('#rush-back').click(); 1`);
    await until(`!!document.querySelector('.rush-recent-row')`, 'the recent runs');
    assert.equal(await ev(`document.querySelector('.rush-recent-row').click(); document.querySelector('#rush-end').classList.contains('rt') && document.querySelectorAll('.rush-card').length === 6`), true, 'drawn themed from the start');
    // tinue classic (its colours are tinue's own): themed at once, nothing asked
    ninjaMode = 'ok';
    await ev(`localStorage.setItem('tinue.prefs', ${page(encodeLook({ theme: LEGACY }))}); 1`);
    await cdp('Page.navigate', { url: BASE + '?classic#/rush' });
    await until(`document.readyState === 'complete' && !!document.querySelector('.rush-recent-row')`, 'the recent runs');
    assert.equal(await ev(`document.querySelector('.rush-recent-row').click(); getComputedStyle(document.querySelector('#rush-end')).getPropertyValue('--rt-b1').trim()`), '#f0d9b5');
    // its checker as drawn: a dark square (.d) in --rt-base-d, a light one in --rt-base-l, black's flats in --rt-p2
    const drawn = await ev(`(() => { const end = document.querySelector('#rush-end'), v = (k) => getComputedStyle(end).getPropertyValue(k).trim();
      const rgb = (c) => { const i = document.createElement('i'); i.style.color = c; end.append(i); const x = getComputedStyle(i).color; i.remove(); return x; };
      const bg = (q) => { const e = document.querySelector('.rush-card ' + q); return e && getComputedStyle(e).backgroundColor; };
      return JSON.stringify([[bg('.tb-sq.d'), rgb(v('--rt-base-d'))], [bg('.tb-sq:not(.d)'), rgb(v('--rt-base-l'))], [bg('.tb-st.p2:not(.S, .C)'), rgb(v('--rt-p2'))], [v('--rt-base-d') !== v('--rt-base-l')]]); })()`);
    for (const [got, want] of JSON.parse(drawn)) assert.equal(got, want ?? true, drawn);
    // a new look while the end screen is open (another tab, or the account's): the pictures take it, back to felt too
    const tab = (look) => `localStorage.setItem('tinue.prefs', ${page(look)}); dispatchEvent(new StorageEvent('storage', { key: 'tinue.prefs' })); 1`;
    await ev(tab(encodeLook({ theme: 'zen' })));
    await until(`getComputedStyle(document.querySelector('#rush-end')).getPropertyValue('--rt-b1').trim() === '#decb9e'`, 'zen from another tab');
    await ev(tab(''));
    await until(`!document.querySelector('#rush-end').classList.contains('rt') && !document.querySelector('#rush-end').style.length`, 'felt from another tab');
    // and tinue felt: nothing set, board.css's felt
    await ev(`localStorage.setItem('tinue.prefs', ${page('')}); 1`);
    await cdp('Page.navigate', { url: BASE + '?felt#/rush' });
    await until(`document.readyState === 'complete' && !!document.querySelector('.rush-recent-row')`, 'the recent runs');
    assert.equal(await ev(`document.querySelector('.rush-recent-row').click(); document.querySelector('#rush-end').classList.contains('rt') || document.querySelector('#rush-end').style.length`), 0);
  });
  assert.deepEqual(logs, [], 'no page exceptions');
  console.log(`e2e-rush-look: all ${ok} passed`);
} finally {
  ws?.close(); chrome.kill(); srv.close();
  await sleep(300); fs.rmSync(profile, { recursive: true, force: true });
}
