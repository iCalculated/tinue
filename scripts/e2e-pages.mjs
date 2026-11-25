// History, Leaderboard, Settings, Rush's start page and a finished puzzle's themes, in headless Chrome at 1280, 390 and 320 px
// with a made-up API: nothing played, a guest, 3 rows, 200 and 500 rows, long names, provisional, the server not answering.
// A theme tag opens its definition in place (one at a time, nothing above it moves), the login token stays hidden until
// asked for, the chart answers a pointer, no page scrolls sideways, and #/glossary lands on the puzzle.
// The board is the local stand-in (e2e-standin.mjs). Not part of npm test (it needs Chrome):
//   node scripts/e2e-pages.mjs [shots dir]
// Ports: $E2E_PORT (default 9341), +1 for DevTools. Its Chrome profile lives under $E2E_TMP (else the system's temporary
// directory), removed at the end. E2E_ROOT: another checkout to load (with SHOTS_ONLY=1: pictures, no checks).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standin, STANDIN_ARGS, STANDIN_PATTERN } from './e2e-standin.mjs';

const ROOT = process.env.E2E_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONLY = !!process.env.SHOTS_ONLY, SHOTS = process.argv[2] || null;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = +(process.env.E2E_PORT || 9341), DT = PORT + 1, BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'tinue-e2e-pages-'));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rush-sym-sample.json'), 'utf8'));
const kids = [];
process.on('exit', () => { for (const k of kids) try { k.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const dog = setTimeout(() => { console.log('timed out'); process.exit(2); }, 330e3);

// ---------- the fake API ----------
const NOW = Date.now(), TOKEN = 'ab12cd34'.repeat(6);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function rows(n) { // newest first, as the server sends them
  let r = 1500; const out = [], gap = (i) => NOW - i * 3.1 * 3600e3 - (i > 8 ? 2 * 86400e3 : 0) - (i > 60 ? 12 * 86400e3 : 0);
  seed = 7;
  for (let i = n - 1; i >= 0; i--) {
    const rated = rnd() > 0.12, win = rnd() > 0.38, d = rated ? (win ? 1 : -1) * (i > n - 12 ? 90 * rnd() + 8 : 14 * rnd() + 2) : 0, refund = rated && rnd() > 0.97;
    const plies = [1, 3, 3, 5, 5, 7, 11][Math.floor(rnd() * 7)], flat = rnd() > 0.9;
    out.unshift({ puzzle_id: ['pd', 'ps', 'p'][i % 3] + (501434 + i * 37), win: win || refund ? 1 : 0, rated: rated ? 1 : 0, user_rating: r, user_delta: refund ? 0.2 : d, refund: refund ? 1 : 0, ts: gap(i), puzzle_rating: r + (rnd() - 0.4) * 300,
      themes: flat ? 'gaelet,capture' : 'capture,spread', plies, size: i % 9 ? 6 : 5 });
    if (!refund) r += d;
  }
  return out;
}
const account = (h, o = {}) => ({ id: 1, name: 'sparrow', rating: h.length ? h[0].user_rating + (h[0].refund ? 0 : h[0].user_delta) : 1500, rd: 60, provisional: h.length < 15, games: h.filter((x) => x.rated).length, wins: h.filter((x) => x.rated && x.win).length, ...o });
const NAMES = ['Wwwwwwwwwwwwwwwwwwww', 'Abercrombie_the_2nd_', 'sparrow', 'kestrel', 'm', 'TakEnthusiast-1987'];
const leaders = (n) => Array.from({ length: n }, (_, i) => ({ name: NAMES[i] || 'player' + i, rating: 2410 - i * 23, games: [1290, 4, 188, 57, 1, 902][i % 6], wins: 3, provisional: i % 6 === 1 || i % 6 === 4 }));
const top = Array.from({ length: 10 }, (_, i) => ({ name: NAMES[i] || 'Guest ' + (1200 + i), score: 41 - 3 * i, named: i < 6, ...(i === 2 ? { you: true } : {}) }));
let W = {}; // what the API answers now
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/json' };
const asked = [];
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = ''; await new Promise((r) => { req.on('data', (d) => { body += d; }); req.on('end', r); });
  const json = (o, st = 200) => res.writeHead(st, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (u.pathname.startsWith('/api/')) {
    asked.push(u.pathname);
    if (W.down) return json({ error: 'busy' }, 503);
    if (u.pathname === '/api/me') return json({ user: W.user ?? null, ...(W.user?.name ? { settings: null } : {}) });
    if (u.pathname === '/api/settings') return json({ settings: JSON.parse(body).changes });
    if (u.pathname === '/api/history') return json({ history: W.history || [] });
    if (u.pathname === '/api/leaderboard') return json({ leaders: W.leaders || [] });
    if (u.pathname.startsWith('/api/puzzle/') || u.pathname === '/api/next') {
      const p = SAMPLE.find((x) => x.id === decodeURIComponent(u.pathname.slice(12))) || SAMPLE[1];
      return json({ puzzle: { ...p, themes: ['tinueIn2', 'capture', 'spread', 'reveal', 's6'], attempts: 12, solves: 3, rd: 80, source: 'playtak', sourceRef: 'https://playtak.com/games/1', meta: { white: 'kestrel', black: 'sparrow', ratingWhite: 1780, ratingBlack: 1650 } } });
    }
    if (u.pathname === '/api/rush/top') return json({ top: W.top || [] });
    if (u.pathname === '/api/rush/best') return json({ best: W.best || null });
    if (u.pathname === '/api/themes') return json({ themes: { tinueIn2: 5210, capture: 1290, spread: 964, fork: 2044, gaelet: 310, deep: 49, quietMove: 120 }, sizes: { 5: 5000, 6: 20394 } });
    return json({ error: 'unknown route' }, 404);
  }
  const p = decodeURIComponent(u.pathname);
  let f = p.startsWith('/shared/') ? path.join(ROOT, p) : path.join(ROOT, 'public', ['/', '/glossary'].includes(p) ? 'index.html' : p);
  fs.readFile(f, (e, b) => (e ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'text/plain', 'cache-control': 'no-store' }).end(b)));
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

// ---------- Chrome ----------
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${path.join(dir, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', ...STANDIN_ARGS, 'about:blank'], { stdio: 'ignore' });
kids.push(chrome);
let ws, id = 0; const pend = new Map(), errors = [];
for (let i = 0; i < 60 && !ws; i++) { try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch {} await sleep(200); }
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const cdp = (method, params = {}) => new Promise((r, j) => { const i = ++id, t = setTimeout(() => { pend.delete(i); j(new Error('no answer to ' + method)); }, 15e3); pend.set(i, (m) => { clearTimeout(t); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Fetch.requestPaused') standin(cdp, m.params);
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
};
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
const until = async (expr, what, ms = 20e3) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return; await sleep(80); } throw new Error('timed out: ' + what + ' ' + JSON.stringify(errors)); };
await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable'); await cdp('Fetch.enable', { patterns: [STANDIN_PATTERN] });
let label = '';
const size = async (w, h, mobile) => { label = String(w); await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }); await cdp('Emulation.setTouchEmulationEnabled', { enabled: mobile }); };
const load = async (at, world, ls = {}) => {
  W = world;
  await cdp('Page.navigate', { url: BASE + 'manifest.webmanifest' }); await sleep(120);
  await ev(`(localStorage.clear(), sessionStorage.clear(), ${JSON.stringify(Object.entries({ ...(world.user ? { token: TOKEN } : {}), ...ls }))}.forEach(([k, v]) => localStorage.setItem('tinue.' + k, JSON.stringify(v))), true)`);
  await cdp('Page.navigate', { url: BASE + at }); await sleep(250);
  await until(`document.readyState === 'complete' && !document.documentElement.classList.contains('booting')`, 'the page');
};
const shot = async (name, full = false) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true }); await ev(`document.fonts.ready.then(() => (1))`); await sleep(250);
  const r = await cdp('Page.captureScreenshot', { format: 'png', ...(full ? { captureBeyondViewport: true } : {}) });
  fs.writeFileSync(path.join(SHOTS, `${name}-${label}.png`), Buffer.from(r.result.data, 'base64'));
};
// (the width set, not innerWidth: a phone’s grows with what overflows it)
const fits = async (what) => ONLY || assert.ok(await ev(`document.documentElement.scrollWidth`) <= +label, `${what} scrolls sideways at ${label}: ${await ev('document.documentElement.scrollWidth')}`);
const check = async (what, fn) => { if (ONLY) return; await fn(); console.log('ok', label, what); };
const clickXY = async (sel) => { const [x, y] = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const key = async (k, code = k, extra = {}) => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code, ...extra }); };

const H3 = rows(3), H200 = rows(200), H500 = rows(500);
try {
  for (const [w, h, mob] of [[1280, 800, false], [390, 844, true], [320, 568, true]]) {
    await size(w, h, mob);
    // ---- History ----
    for (const [name, world] of Object.entries({
      'history-new': {}, 'history-guest': { user: account(H3, { name: null }), history: H3 }, 'history-none': { user: account([]), history: [] }, 'history-3': { user: account(H3, { name: NAMES[0] }), history: H3 },
      'history-200': { user: account(H200, { games: 431, wins: 270 }), history: H200 }, 'history-500': { user: account(H500), history: H500 }, 'history-error': { down: true } })) {
      await load('#/me', world, world.down ? { token: TOKEN, me: { name: 'sparrow' } } : {});
      await until(`document.querySelector('#view-me').children.length > ${world.history?.length ? 2 : 1}`, name);
      await sleep(150);
      await fits(name); await shot(name);
      if (name === 'history-3') await check('the login token is hidden until Show, and then is the token', async () => {
        assert.equal(await ev(`document.querySelector('#view-me').innerHTML.includes('${TOKEN}')`), false);
        await clickXY('#token-show');
        assert.equal(await ev(`document.querySelector('#token-out').value`), TOKEN);
        assert.equal(await ev(`document.querySelector('#token-show').textContent + document.querySelector('#token-show').getAttribute('aria-expanded')`), 'Hidetrue');
        await fits('token shown'); await shot('history-token');
        await clickXY('#token-show');
        assert.equal(await ev(`document.querySelector('#view-me').innerHTML.includes('${TOKEN}') || document.querySelector('#token-out').value === '${TOKEN}'`), false);
      });
      if (name === 'history-guest' || name === 'history-new') await check(name + ': no token, and how to get a name', async () => {
        assert.equal(await ev(`!!document.querySelector('#token-copy')`), false);
        assert.match(await ev(`document.querySelector('#view-me').innerText`), /Claim a username/);
      });
      if (name === 'history-3' || name === 'history-200') await check(name + ': "?" explained when the rating has one', async () => assert.equal(await ev(`/\\? means provisional/.test(document.querySelector('#view-me').innerText)`), name === 'history-3'));
      if (name === 'history-200') {
        await check('the chart names the rating, its change and the day under the pointer, inside the panel, and forgets it on leaving', async () => {
          for (const f of [0.02, 0.5, 0.98]) {
            const b = await ev(`(() => { const b = document.querySelector('.plot').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()`);
            if (mob) await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b[0] + b[2] * f, y: b[1] + b[3] / 2 }] });
            else await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b[0] + b[2] * f, y: b[1] + b[3] / 2 });
            await until(`document.querySelector('.plot-tip').textContent && !document.querySelector('.plot-tip').hidden`, 'the readout');
            assert.match(await ev(`document.querySelector('.plot-tip').textContent`), /^\d{3,4} .*\d/);
            assert.ok(await ev(`(() => { const t = document.querySelector('.plot-tip').getBoundingClientRect(), p = document.querySelector('.chart').getBoundingClientRect(); return t.left >= p.left && t.right <= p.right; })()`), 'readout inside the panel');
            if (f === 0.5) await shot('history-chart');
            if (mob) await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          }
          if (!mob) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await until(`document.querySelector('.plot-tip').hidden`, 'gone'); }
        });
        await check('200 rows: the cap is said', async () => assert.match(await ev(`document.querySelector('#view-me').innerText`), /last 200/i));
      }
      if (name === 'history-error') await check('the server not answering is said', async () => assert.match(await ev(`document.querySelector('#view-me').innerText`), /Can’t reach the puzzle server/));
    }
    // ---- Leaderboard ----
    for (const [name, world] of Object.entries({ 'leaderboard-none': {}, 'leaderboard-3': { user: account(H200), leaders: leaders(3) }, 'leaderboard-50': { user: account(H200), leaders: leaders(50) }, 'leaderboard-error': { down: true } })) {
      await load('#/leaderboard', world);
      await until(`document.querySelector('#view-leaderboard').children.length > 1`, name);
      await fits(name); await shot(name);
      if (name === 'leaderboard-50') await check('one row is marked as yours, and "?" is explained', async () => {
        assert.deepEqual(await ev(`[...document.querySelectorAll('tr.you')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`), ['3 sparrow you 2364 188']);
        assert.match(await ev(`document.querySelector('#view-leaderboard').innerText`), /\?.*provisional/);
      });
      if (name === 'leaderboard-none') await check('empty is said', async () => assert.match(await ev(`document.querySelector('#view-leaderboard').innerText`), /Claim a username/));
    }
    // ---- Settings ----
    await load('#/settings', {}); await until(`!!document.querySelector('#st-sound')`, 'settings'); await fits('settings'); await shot('settings-guest');
    await load('#/settings', { user: account(H200) }, { prefs: { v2: true, v3: true, size: '6', difficulty: 'normal', ninja: 'axisLabels=false&theme=zen' } });
    await until(`document.querySelector('#st-status')?.textContent.startsWith('Saved to')`, 'settings, signed in'); await fits('settings'); await shot('settings-named');
    // ---- Rush's start page ----
    await load('#/rush', {}); await until(`document.querySelector('#rush-top')?.innerText.includes('No scores')`, 'rush'); await fits('rush'); await shot('rush-none');
    const puz = (i) => ({ id: SAMPLE[i].id });
    await load('#/rush', { user: account(H200), top, best: { rush: { today: 22, week: 31, all: 35 }, streak: {} } });
    await until(`document.querySelectorAll('.rush-toplist li').length === 10`, 'rush, scores'); await fits('rush'); await shot('rush-full', true);
    // ---- a finished puzzle's themes ----
    await load('#/puzzle/' + SAMPLE[1].id, { user: account(H200) });
    await until(`document.querySelector('[data-act="solution"]:not(:disabled)')`, 'a puzzle', 25e3); await sleep(1300);
    await ev(`(document.querySelector('[data-act="solution"]').click(), 1)`);
    await until(`!document.querySelector('#info').classList.contains('hidden') && !!document.querySelector('[data-act="next"]')`, 'solved', 25e3); await sleep(900);
    await ev(`document.querySelector('#info').scrollIntoView({ block: 'end' })`);
    if (ONLY) { await ev(`document.querySelector('#info .tag')?.scrollIntoView({ block: 'center' })`); await shot('puzzle-themes'); }
    else {
      const NEXT = mob ? '#moves .dock [data-act="next"]' : '#feedback [data-act="next"]';
      const tags = await ev(`[...document.querySelectorAll('#info .tag')].map((t) => t.tagName + ' ' + t.textContent + ' ' + t.getAttribute('aria-expanded'))`);
      await check('tags are buttons, closed at first', async () => assert.deepEqual(tags, ['Road in 2', 'Capture', 'Spread', 'Drawbridge'].map((t) => `BUTTON ${t} false`)));
      // (page coordinates: nothing above the definition moves)
      const place = () => ev(`['${NEXT}', '#info .tag', '#board'].map((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y + ${mob ? `(s === '${NEXT}' ? 0 : scrollY)` : 'scrollY'}), Math.round(b.width)].join() }).join(' ')`);
      const was = await place();
      await clickXY('#info .tag[data-tag="capture"]'); await sleep(120);
      await check('a tag opens its definition and its Practice link', async () => {
        assert.match(await ev(`document.querySelector('#tag-def').innerText`), /^Your first move .* Practice \(1,290\)$/);
        assert.equal(await ev(`document.querySelector('.tag[data-tag="capture"]').getAttribute('aria-expanded')`), 'true');
        assert.equal(await place(), was, 'nothing above it moved');
      });
      await shot('puzzle-themes-open');
      await clickXY('#info .tag[data-tag="spread"]'); await sleep(120);
      await check('one open at a time', async () => { assert.equal(await ev(`document.querySelectorAll('.tag[aria-expanded="true"]').length`), 1); assert.match(await ev(`document.querySelector('#tag-def').innerText`), /a regular spread/); });
      await check('it stays open, with the keyboard where it was, when the page redraws', async () => {
        await ev(`(document.querySelector('.tag[data-tag="spread"]').focus(), dispatchEvent(new Event('resize')), 1)`);
        await key('ArrowLeft'); await sleep(700);
        assert.equal(await ev(`document.activeElement.dataset.tag + ' ' + document.querySelector('.tag[data-tag="spread"]').getAttribute('aria-expanded') + ' ' + !document.querySelector('#tag-def').hidden`), 'spread true true');
      });
      await check('keyboard: Enter closes and opens it (and is not Next), Escape closes it', async () => {
        const url = await ev('location.href');
        const ent = { windowsVirtualKeyCode: 13, text: '\r' };
        await key('Enter', 'Enter', ent); assert.equal(await ev(`document.querySelector('#tag-def').hidden`), true);
        await key('Enter', 'Enter', ent); assert.equal(await ev(`document.querySelector('#tag-def').hidden`), false);
        await key('Escape', 'Escape', { windowsVirtualKeyCode: 27 }); assert.equal(await ev(`document.querySelector('#tag-def').hidden`), true);
        assert.equal(await ev('location.href'), url);
      });
      await check('Practice sets the theme, whose definition is under the menu', async () => {
        await clickXY('#info .tag[data-tag="capture"]'); await sleep(100); await clickXY('#tag-def .practice');
        await until(`document.querySelector('#theme').value === 'capture' && document.querySelector('#theme-desc').textContent.startsWith('Your first move')`, 'the theme chosen');
        await until(`(() => { const b = document.querySelector('#board').getBoundingClientRect(); return b.top >= 0 && b.top < innerHeight / 2; })()`, 'the new puzzle’s board in the window', 5e3);
        await ev(`(scrollTo(0, 0), document.querySelector('#theme').scrollIntoView({ block: 'center' }), 1)`); await shot('puzzle-theme-chosen');
      });
      await check('#/glossary, #/glossary/fork and /glossary land on the puzzle', async () => {
        for (const at of ['#/glossary', '#/glossary/fork', 'glossary']) {
          await load(at, { user: account(H200) });
          await until(`!document.querySelector('#view-puzzle').classList.contains('hidden') && document.title.startsWith('Puzzle #')`, at);
          assert.ok(!/glossary/.test(await ev('location.href')), at);
          assert.equal(await ev(`document.querySelector('[data-nav].on')?.textContent`), 'Puzzles');
        }
        assert.equal(await ev(`/gloss/i.test(document.querySelector('header').innerText + document.querySelector('main').innerText)`), false);
      });
    }
  }
  if (!ONLY) assert.deepEqual(errors, []);
  console.log('e2e-pages: done', errors.length ? errors : '');
} catch (e) { console.error(e, errors); await shot('failed').catch(() => {}); process.exitCode = 1; }
finally { clearTimeout(dog); ws.close(); chrome.kill(); await new Promise((r) => { if (chrome.exitCode != null) r(); else { chrome.once('exit', r); setTimeout(r, 3000); } }); process.exit(); }
