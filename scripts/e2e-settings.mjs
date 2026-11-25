// Settings saved to the account, end to end: the real server (server/server.js) on a new database with a few fixture
// puzzles, and the real page in headless Chrome. Signed in, a change on the Settings page reaches the account and comes
// back on a reload with this browser's storage cleared (same token); a change made while the server is down is sent at
// the next boot; another account's settings apply when it signs in; signed out or as a guest nothing is posted; with
// site storage blocked the page says settings can't be saved. Sound is one of the page's settings, synced like the
// others. Throughout, the old beta's Engine arrows (no setting any more, Sasha 2026-11-21; the same account and, on the
// same site, the same browser storage) is never shown, applied, posted or dropped. The
// settings are on the Settings page only (the puzzle page has a link there). There is no Board setting (PTN Ninja is the
// only board, 2026-11-22): a stored, synced or ?board= 'tinue' still gets PTN Ninja, and an account's old 'board' is
// carried untouched. The board is a local stand-in for https://ptn.ninja (scripts/e2e-standin.mjs). Every dropdown on both pages draws its
// chevron 10px in from the right edge, hovered, focused and disabled too.
// Not part of npm test (it needs Chrome):  node scripts/e2e-settings.mjs [shots dir]
// With a shots dir: pictures at 1280x800 and 390x844 of the puzzle page (its filters and the Settings link under
// them, no settings there), the Settings page as a guest and signed in, a dropdown close up, and (E2E_NINJA=1) the look field with a theme pasted and the PTN Ninja board showing it.
// E2E_NINJA=1 loads the real https://ptn.ninja instead of the stand-in (network: a few cold loads, seconds apart).
// Ports: $E2E_PORT (default 9331) for the server, +1 for DevTools. Its database and Chrome profile live in a new
// directory under $E2E_TMP (else the system's temporary directory), removed at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standin, STANDIN_ARGS, STANDIN_PATTERN } from './e2e-standin.mjs';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.argv[2] || null;
const PORT = +process.env.E2E_PORT || 9331, DT = PORT + 1, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'tinue-e2e-settings-'));
const DB = path.join(dir, 'e2e.db'), LOG = path.join(dir, 'access.log');
let n = 0;
// A run that hangs still cleans up (its server and Chrome are children: left behind, they'd hold the port and the pipe).
const kids = [];
process.on('exit', () => { for (const k of kids) try { k.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const watchdog = setTimeout(() => { console.log('timed out after 330 s at step', n + 1); for (const k of kids) try { k.kill(); } catch {} process.exit(2); }, 330000);
const step = (s) => { n++; console.log('ok', s); };

// ---------- the server ----------
let server = null;
const boot = () => new Promise((resolve, reject) => {
  const env = { ...process.env, PORT: String(PORT), TINUE_DB: DB, TINUE_ACCESS_LOG: LOG, TINUE_SYNTAKS: '/nonexistent' };
  delete env.TINUE_ORIGINS;
  const c = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server/server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  c.stdout.on('data', (d) => { if (String(d).includes('tinue on')) resolve(c); });
  c.on('exit', (code) => reject(new Error('server exited ' + code)));
  server = c; kids.push(c);
});
const stop = async () => { const c = server; server = null; if (!c) return; c.kill(); await new Promise((r) => c.once('exit', r)); };
const call = async (p, body, token) => {
  const headers = { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) };
  return (await fetch(BASE + p, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers })).json();
};
const posts = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('POST /api/settings')).length : 0);

await boot(); await stop(); // the schema
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rush-sym-sample.json'), 'utf8'));
// An empty square of a TPS position (any placement there is legal: a move played, right or wrong).
const emptySquare = (tps) => {
  const rows = tps.split(' ')[0].split('/'), n = rows.length;
  for (let r = 0; r < n; r++) {
    let f = 0;
    for (const c of rows[r].split(',')) {
      const m = /^x(\d*)$/.exec(c);
      if (!m) { f++; continue; }
      return 'abcdefgh'[f] + (n - r);
    }
  }
  throw new Error('no empty square in ' + tps);
};
{
  const db = new DatabaseSync(DB);
  const ins = db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, source_ref, init_rating, rating, komi, turn, grade) VALUES (?, 6, ?, ?, ?, '', 'playtak', '1', 1500, 1500, ?, 1, 'A')`);
  for (const p of SAMPLE.slice(0, 8)) ins.run(p.id, p.tps, p.plies, JSON.stringify(p.tree), p.komi);
  db.close();
}
await boot();
// Made-up test accounts. tester1's account already holds the old beta's Engine arrows (as that beta would have saved it).
const BETA = { arrows: false };
const t1 = await call('/api/register', { name: 'tester1' }), t2 = await call('/api/register', { name: 'tester2' });
assert.ok(t1.token && t2.token);
assert.equal(t1.settings, null);
await call('/api/settings', { changes: BETA }, t1.token);
await sleep(300);
const POSTS0 = posts(); // (that post above, by "the beta")

// ---------- Chrome ----------
const profile = path.join(dir, 'chrome');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...STANDIN_ARGS,
  'about:blank'], { stdio: 'ignore' });
kids.push(chrome);
console.log('server and Chrome up');
let ws, id = 0;
const pend = new Map(), errors = [];
for (let i = 0; i < 50 && !ws; i++) {
  try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch {} // (no wait after: its open event would be missed)
  await sleep(200);
}
if (!ws) throw new Error('no Chrome page to drive');
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; setTimeout(() => j(new Error('DevTools socket never opened')), 10000); });
console.log('DevTools connected');
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Page.javascriptDialogOpening') { console.log('dialog:', m.params.type, m.params.message); cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }
  else if (m.method === 'Fetch.requestPaused' && m.params.request.url.startsWith('https://ptn.ninja/')) standin(cdp, m.params, process.env.E2E_NINJA ? 'real' : 'ok');
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
};
// (each call gives up after 15 s, naming itself, rather than hang the run)
const cdp = (method, params = {}) => new Promise((r, j) => { const i = ++id, t = setTimeout(() => { pend.delete(i); j(new Error('no answer to ' + method + ' ' + JSON.stringify(params).slice(0, 120))); }, 15000); pend.set(i, (m) => { clearTimeout(t); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
const until = async (expr, what, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return; await sleep(100); } throw new Error('timed out: ' + what + ' ' + JSON.stringify(await ev('({ at: location.href, status: document.querySelector("#st-status")?.textContent, user: document.querySelector("#userbox")?.innerHTML.slice(0, 200) })').catch((e) => String(e))) + ' errors: ' + JSON.stringify(errors)); };
// A picture of the viewport as it is (sel: scrolled into view first, at the top unless center).
const shot = async (name, sel = null, block = 'start') => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  if (sel) await ev(`(document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: ${JSON.stringify(block)} }), true)`); else await ev('(scrollTo(0, 0), true)');
  await sleep(400);
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, 'base64'));
};
const size = (w, h, mobile = false) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
const WIDE = [1280, 800], PHONE = [390, 844, true];
await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable'); await cdp('Fetch.enable', { patterns: [STANDIN_PATTERN] });
await size(...WIDE);
const prefs = () => ev(`JSON.parse(localStorage.getItem('tinue.prefs') || '{}')`);
const srv = async (tok = t1.token) => (await call('/api/me', null, tok)).settings;
// The beta's settings, as they must stay: in this browser's prefs (when there) and on the account.
const betaKept = async (where, tok = t1.token) => {
  const s = await srv(tok);
  assert.equal(s.arrows, BETA.arrows, where + ': the account\'s Engine arrows');
};
// No row, control or text for a feature this site doesn't have, anywhere in the page.
const noBetaRows = async (where) => {
  assert.equal(await ev(`!!document.querySelector('#set-arrows, #set-sound, #st-arrows')`), false, where + ': an Engine arrows control, or a setting on the puzzle page');
  assert.doesNotMatch(await ev(`document.body.innerText`), /Engine arrows|A key/, where + ': Engine arrows words');
};
// A fresh load with this browser's storage set to exactly `ls` (token and the like), at the address `at`.
async function load(ls, at = '/#/settings') {
  await cdp('Page.navigate', { url: BASE + '/LICENSE.txt' }); await sleep(150);
  await cdp('Network.clearBrowserCookies'); // (a sign-in also sets the token as a cookie)
  await ev(`(localStorage.clear(), sessionStorage.clear(), ${JSON.stringify(Object.entries(ls))}.forEach(([k, v]) => localStorage.setItem('tinue.' + k, JSON.stringify(v))), true)`);
  await cdp('Page.navigate', { url: BASE + at }); await sleep(150);
  await until(`document.readyState === 'complete' && !!document.querySelector('#view-settings')`, 'the page');
}
// (by way of another page: a navigation that changes only the hash would not load the page again)
const reload = async (at = '/#/settings') => { await cdp('Page.navigate', { url: BASE + '/LICENSE.txt' }); await sleep(150); await cdp('Page.navigate', { url: BASE + at }); await sleep(150); await until(`document.readyState === 'complete'`, 'reloaded'); };
const pick = (sel, v) => ev(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const PREFS = { v2: true, v3: true, size: '6', difficulty: 'normal' };
// Every visible dropdown draws its own chevron, 10px in from the right edge (style.css), and keeps it hovered, focused
// and disabled: no later rule may set background over it.
const chevron = (sel) => ev(`(() => { const s = document.querySelector(${JSON.stringify(sel)}), c = getComputedStyle(s);
  return [c.appearance, c.backgroundImage.startsWith('url("data:image/svg+xml'), c.backgroundRepeat, c.backgroundPositionX, c.backgroundPositionY, c.backgroundSize, c.paddingRight].join(' '); })()`);
const CHEVRON = 'none true no-repeat calc(100% - 10px) 50% 10px 6px 28px';
async function chevrons(where) {
  const ids = await ev(`[...document.querySelectorAll('select')].filter((s) => s.offsetParent).map((s) => '#' + s.id)`);
  assert.ok(ids.length >= 2, where + ': dropdowns found');
  for (const sel of ids) {
    assert.equal(await chevron(sel), CHEVRON, where + ' ' + sel);
    const r = await ev(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.scrollIntoView({ block: 'center' }); const b = s.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r[0], y: r[1] });
    assert.equal(await ev(`document.querySelector(${JSON.stringify(sel)}).matches(':hover')`), true, where + ' ' + sel + ' hovered');
    assert.equal(await chevron(sel), CHEVRON, where + ' ' + sel + ' hovered');
    await ev(`(document.querySelector(${JSON.stringify(sel)}).focus(), true)`);
    assert.equal(await chevron(sel), CHEVRON, where + ' ' + sel + ' focused');
    await ev(`(document.querySelector(${JSON.stringify(sel)}).blur(), document.querySelector(${JSON.stringify(sel)}).disabled = true, true)`);
    assert.equal(await chevron(sel), CHEVRON, where + ' ' + sel + ' disabled');
    await ev(`(document.querySelector(${JSON.stringify(sel)}).disabled = false, true)`);
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
}

try {
  // 0. a guest: the puzzle page has its filters and a link to Settings, no setting; the Settings page (pictures at both
  // widths); every dropdown's chevron, on both pages
  for (const [w, label] of [[WIDE, '1280'], [PHONE, '390']]) {
    await size(...w);
    await load({ prefs: { ...PREFS, ...BETA } }, '/#/');
    await until(`document.title.startsWith('Puzzle #') && !!document.querySelector('.set-link a')`, 'a puzzle shown', 25000);
    await sleep(800);
    assert.deepEqual(await ev(`[...document.querySelectorAll('#view-puzzle select')].map((s) => s.id)`), ['theme', 'difficulty', 'size'], 'the puzzle page: filters only');
    assert.equal(await ev(`!!document.querySelector('#view-puzzle').textContent.match(/Board style|Confirm moves|All settings/)`), false);
    assert.equal(await ev(`document.querySelector('.set-link a').textContent`), 'Settings');
    await shot(`puzzle-${label}.png`);
    await shot(`puzzle-link-${label}.png`, '.set-link', 'center');
    await noBetaRows('the puzzle page');
    await chevrons('the puzzle page at ' + label);
    await ev(`(document.querySelector('.set-link a').click(), true)`);
    await until(`location.hash === '#/settings' && document.querySelector('#st-status')?.textContent.startsWith('Saved on this device.')`, 'Settings, as a guest');
    assert.equal(await ev(`document.documentElement.scrollWidth - innerWidth`) <= 0, true, 'no sideways scroll at ' + label);
    await chevrons('the Settings page at ' + label);
    await shot(`settings-guest-${label}.png`);
  }
  assert.equal((await prefs()).arrows, BETA.arrows, 'the old beta\'s Engine arrows in storage, untouched');
  await size(...WIDE);
  step('signed out: the puzzle page has its filters and a Settings link, no setting; the link opens the Settings page; no beta-only row; every chevron 10px in, hovered, focused and disabled');

  // 1. signed in: the Settings page, from the account menu
  await load({ token: t1.token, me: { name: 'tester1' }, prefs: { ...PREFS, ...BETA } }, '/#/');
  await until(`!!document.querySelector('#userbox a[href="#/settings"]')`, 'the account menu\'s Settings link');
  await ev(`(document.querySelector('#userbox a[href="#/settings"]').click(), true)`);
  await until(`location.hash === '#/settings' && !document.querySelector('#view-settings').classList.contains('hidden')`, 'the Settings page');
  await until(`document.querySelector('#st-status').textContent === 'Saved to your account.'`, 'status: saved to your account');
  assert.equal(posts(), POSTS0, 'nothing posted for an account at this site\'s defaults');
  assert.equal(await ev(`document.title`), 'Settings — tinue');
  // every setting there, each labelled and described; no Board row; the board's theme and look always usable
  const items = await ev(`[...document.querySelectorAll('#view-settings .set-item > label')].map((l) => l.textContent + ':' + (document.getElementById(l.htmlFor)?.id || ''))`);
  assert.deepEqual(items, ['Board theme:st-ninja-theme', 'Board look:st-ninja', 'Confirm moves:st-confirm', 'Sound:st-sound']);
  await noBetaRows('the Settings page');
  assert.equal(await ev(`!!document.querySelector('#st-board')`), false, 'no Board row');
  assert.equal(await ev(`document.querySelector('#st-ninja').disabled || document.querySelector('#st-ninja-theme').disabled`), false, 'the theme and look usable');
  assert.doesNotMatch(await ev(`document.querySelector('#view-settings').textContent`), /Choose PTN Ninja|tinue’s own|tinue legacy|PTN Ninja theme|PTN Ninja look/);
  await shot('settings-signed-in-1280.png');
  await size(...PHONE); await sleep(300);
  assert.ok(await ev(`document.documentElement.scrollWidth - innerWidth`) <= 0, 'no sideways scroll at 390');
  await shot('settings-signed-in-390.png');
  await size(...WIDE);
  step('signed in: the Settings page from the account menu, four settings labelled, "Saved to your account."');

  // 2. a change here reaches the account (that key only)
  await pick('#st-confirm', 'on');
  await until(`document.querySelector('#st-status').textContent === 'Saved to your account.'`, 'saved after the change');
  await sleep(300);
  assert.deepEqual(await srv(), { ...BETA, confirm: true }, 'only the key changed; the beta\'s kept');
  assert.equal(posts(), POSTS0 + 1, 'one post');
  assert.deepEqual(await ev(`['confirm'].map((k) => document.querySelector('#st-' + k).value)`), ['on']);
  // Sound too: one post of that key
  await pick('#st-sound', 'deep');
  await until(`document.querySelector('#st-status').textContent === 'Saved to your account.'`, 'saved after Sound');
  await sleep(300);
  assert.deepEqual(await srv(), { ...BETA, confirm: true, sound: 'deep' }, 'only Sound added');
  assert.equal(posts(), POSTS0 + 2, 'one post more');
  const p2 = await prefs();
  assert.deepEqual([p2.arrows, p2.sound, p2.confirm], [BETA.arrows, 'deep', true]);
  step('a change on the Settings page (Confirm moves, then Sound) is posted (that key) and stored; the old Engine arrows kept');

  // 3. this browser's storage cleared, same token: the account's settings come back, the beta's are not applied here
  await load({ token: t1.token });
  await until(`document.querySelector('#st-confirm').value === 'on' && document.querySelector('#st-sound').value === 'deep'`, 'the account\'s confirm and Sound back');
  const p3 = await prefs();
  assert.equal(p3.confirm, true); assert.equal(p3.sound, 'deep');
  assert.ok(!('arrows' in p3), 'the account\'s old Engine arrows is not written here');
  assert.equal(posts(), POSTS0 + 2, 'taking the account\'s settings posts nothing');
  await betaKept('after a load');
  step('storage cleared, same token: the account\'s settings (Sound too) come back with /api/me, nothing posted, the old Engine arrows not applied');

  // 4. the puzzle page's link opens the Settings page in step with the account
  await call('/api/settings', { changes: { confirm: false } }, t1.token); // ("another device")
  await reload('/#/');
  await until(`!document.querySelector('#view-puzzle').classList.contains('hidden') && !!document.querySelector('.set-link a')`, 'puzzle page');
  await ev(`(document.querySelector('.set-link a').click(), true)`);
  await until(`location.hash === '#/settings' && document.querySelector('#st-confirm').value === 'off'`, 'the Settings link, in step');
  step('signed in: the puzzle page\'s Settings link opens the Settings page, in step with the account');

  // 5. the server down: the change waits, says so, and is sent at the next boot; the beta's own unsent mark is kept
  await stop();
  await pick('#st-confirm', 'on');
  await until(`document.querySelector('#st-status').textContent === 'Could not save to your account. tinue will try again.'`, 'status: could not save', 25000);
  assert.equal((await prefs()).confirm, true, 'kept on this device');
  // (an old beta, in another tab, has an unsent Engine arrows of its own in the same mark)
  await ev(`(() => { const m = JSON.parse(localStorage.getItem('tinue.setUnsent')); m.k.push('arrows'); localStorage.setItem('tinue.setUnsent', JSON.stringify(m)); return true; })()`);
  await boot();
  await reload();
  await until(`document.querySelector('#st-status').textContent === 'Saved to your account.'`, 'sent at the next boot', 25000);
  await sleep(300);
  assert.equal((await srv()).confirm, true, 'the unsent change won over the account\'s older one');
  await betaKept('after the unsent post');
  assert.deepEqual(await ev(`JSON.parse(localStorage.getItem('tinue.setUnsent')).k`), ['arrows'], 'the old beta\'s unsent mark kept, this site\'s cleared');
  await ev(`(localStorage.removeItem('tinue.setUnsent'), true)`);
  step('a change made while the server is down: "Could not save…", kept here, sent at the next boot; the beta\'s unsent mark kept');

  // 6. another account signs in on this device: its settings apply (not the beta's of it)
  await call('/api/settings', { settings: { board: 'tinue', confirm: false, ninja: '', sound: 'light', arrows: true } }, t2.token);
  await sleep(500); // (the server appends its access-log line after answering: let it land before counting)
  const before = posts();
  await ev(`(localStorage.removeItem('tinue.token'), localStorage.removeItem('tinue.me'), true)`);
  await reload('/#/settings');
  await until(`document.querySelector('#st-status').textContent.startsWith('Saved on this device.')`, 'signed out: saved on this device');
  assert.equal(await ev(`document.querySelector('#st-confirm').value`), 'on', 'signing out keeps this device\'s settings');
  await pick('#st-confirm', 'on'); await sleep(800);
  assert.equal(posts(), before, 'signed out: nothing posted');
  await ev(`(document.querySelector('#claim-open').click(), document.querySelector('#token-open').click(), document.querySelector('#tok-in').value = ${JSON.stringify(t2.token)}, document.querySelector('#tok').requestSubmit(), true)`);
  await until(`document.querySelector('#st-confirm').value === 'off' && document.querySelector('#st-sound').value === 'light' && document.querySelector('#st-status').textContent === 'Saved to your account.'`, 'tester2\'s settings applied');
  const p6 = await prefs();
  assert.equal(p6.confirm, false); assert.equal(p6.sound, 'light');
  assert.notEqual(p6.arrows, true, 'tester2\'s old Engine arrows not applied here');
  assert.equal(posts(), before, 'taking tester2\'s settings posts nothing');
  step('signed out: "Saved on this device…", changes stay here, nothing posted; another account\'s settings apply on sign-in');

  // 7. a guest: nothing posted
  const guest = await call('/api/result', { puzzleId: 'pd877899', win: true }).catch(() => null);
  if (guest?.token) {
    const b7 = posts();
    await load({ token: guest.token, me: { name: null } });
    await until(`document.querySelector('#st-status').textContent.startsWith('Saved on this device.')`, 'guest: on this device');
    await pick('#st-confirm', 'on'); await sleep(800);
    assert.equal(posts(), b7, 'a guest posts nothing');
    assert.equal((await prefs()).confirm, true);
    step('a guest: "Saved on this device…", nothing posted');
  } else console.log('-- skipped the guest step: /api/result made no guest', JSON.stringify(guest)?.slice(0, 200));

  // 8. the claim popover's Settings link (signed out)
  await load({}, '/#/');
  await until(`!!document.querySelector('#claim-open')`, 'claim button');
  await ev(`(document.querySelector('#claim-open').click(), document.querySelector('#settings-open').click(), true)`);
  await until(`location.hash === '#/settings' && !document.querySelector('.menu.open')`, 'Settings from the claim popover, popover closed');
  step('signed out: the claim popover has a Settings link');

  // 9. site storage blocked: the page says so
  const blockScript = (await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });` })).result.identifier;
  await reload('/#/settings');
  await until(`document.querySelector('#st-status').textContent === "Settings can't be saved in this browser."`, 'blocked storage');
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: blockScript });
  step('site storage blocked: "Settings can\'t be saved in this browser."');

  // 9b. a ?board=tinue link, and prefs saying tinue's board: PTN Ninja all the same, and no note about boards
  await load({ prefs: { ...PREFS, board: 'tinue', confirm: true } }, '/?board=tinue#/settings');
  await until(`!!document.querySelector('#st-confirm')`, 'the Settings page');
  assert.equal(await ev(`!!document.querySelector('#board iframe[src^="https://ptn.ninja/"]') && !document.querySelector('#board .tb-sq, #board .tb')`), true, 'the board is PTN Ninja\'s');
  assert.equal(await ev(`document.querySelector('#st-note').textContent`), '', 'no note');
  await ev(`(location.hash = '#/', true)`);
  await until(`document.title.startsWith('Puzzle #') && !document.querySelector('#ptn-in').disabled`, 'a puzzle playable on PTN Ninja', 25000);
  assert.equal((await prefs()).board, 'tinue', 'the old stored Board setting is left as it was (never read)');
  await shot('settings-board-tinue-link-1280.png');
  step('?board=tinue with prefs.board tinue: PTN Ninja\'s board, playable; no note; the stored value left alone');

  // 10-14
  const srvUntil = async (fn, what) => { for (let t = Date.now(); Date.now() - t < 15000; await sleep(150)) if (fn(await srv())) return; throw new Error('timed out: ' + what + ' ' + JSON.stringify(await srv())); };
  const STEADY = `document.readyState === 'complete' && document.querySelector('#st-status')?.textContent === 'Saved to your account.'`;

  // 10. an account whose synced Board setting is tinue's: PTN Ninja anyway; the account's value carried, never rewritten
  await call('/api/settings', { changes: { board: 'tinue' } }, t1.token);
  await load({ token: t1.token, me: { name: 'tester1' }, prefs: { ...PREFS, ...BETA } });
  await until(STEADY, 'tester1, settled');
  await reload(); await sleep(1500); await until(STEADY, 'a second load');
  assert.equal((await srv()).board, 'tinue', 'the account\'s old Board setting carried as it is');
  assert.equal(await ev(`!!document.querySelector('#st-board')`), false);
  assert.equal(await ev(`!!document.querySelector('#board iframe[src^="https://ptn.ninja/"]')`), true, 'the PTN Ninja board');
  assert.equal(await ev(`document.querySelector('#st-ninja').disabled`), false, 'the look field usable');
  await betaKept('with the old Board setting');
  assert.equal((await prefs()).arrows, BETA.arrows, 'and in storage');
  step('an account whose old Board setting is tinue: PTN Ninja\'s board, the value carried untouched');

  // 11. an out-of-date page: another device changes the look; this page changes Confirm moves; the account keeps
  // both, and this page takes the other device's look from the answer
  const LOOK = '&axisLabels=false';
  const confirmNow = await ev(`document.querySelector('#st-confirm').value`), confirmNext = confirmNow === 'on' ? 'off' : 'on';
  await call('/api/settings', { changes: { ninja: LOOK } }, t1.token); // ("device A")
  await pick('#st-confirm', confirmNext);
  await srvUntil((x) => x.confirm === (confirmNext === 'on'), 'confirm saved');
  assert.equal((await srv()).ninja, LOOK, 'the other device\'s look kept');
  await until(`JSON.parse(localStorage.getItem('tinue.prefs')).ninja === ${JSON.stringify(LOOK)}`, 'this page takes it');
  step('an out-of-date page changing one setting keeps another device\'s newer change, and takes it');

  // 12. another tab of this browser changes Confirm moves, Sound and (an old beta) Engine arrows: this tab follows the
  // first two, keeps the third as it is, posts nothing for them, and its next write doesn't put the old values back
  const b12 = posts(), confirm12 = (await ev(`document.querySelector('#st-confirm').value`)) === 'on' ? false : true;
  await ev(`(() => { const p = JSON.parse(localStorage.getItem('tinue.prefs')); p.confirm = ${confirm12}; p.sound = 'off'; p.arrows = true; localStorage.setItem('tinue.prefs', JSON.stringify(p));
    dispatchEvent(new StorageEvent('storage', { key: 'tinue.prefs', storageArea: localStorage })); return true; })()`);
  await until(`document.querySelector('#st-confirm').value === ${JSON.stringify(confirm12 ? 'on' : 'off')} && document.querySelector('#st-sound').value === 'off'`, 'this tab follows');
  await sleep(500); assert.equal(posts(), b12, 'the other tab sends it, not this one');
  await pick('#difficulty', (await ev(`document.querySelector('#difficulty').value`)) === 'harder' ? 'normal' : 'harder');
  await sleep(300);
  const p12 = await prefs();
  assert.equal(p12.sound, 'off', 'this tab\'s write kept the other tab\'s Sound'); assert.equal(p12.confirm, confirm12);
  assert.equal(p12.arrows, true, 'and its Engine arrows, as it is');
  step('another tab\'s change: followed here (or kept as it is, for the old Engine arrows), not posted here, not undone by this tab\'s next write');

  // 13. an account saying board 'ninja' and this device 'tinue' (old values): a puzzle link opens that puzzle, on PTN Ninja
  await call('/api/settings', { changes: { board: 'ninja' } }, t1.token);
  for (const pid of ['pd652074', 'pd489269']) {
    await load({ token: t1.token, me: { name: 'tester1' }, prefs: { ...PREFS, board: 'tinue' } }, '/#/puzzle/' + pid);
    await until(`!!document.querySelector('#board iframe') && document.title.startsWith('Puzzle #') && !document.querySelector('#ptn-in').disabled`, 'a puzzle shown on PTN Ninja', 25000);
    assert.equal(await ev(`document.title`), `Puzzle #${pid} — tinue`, 'the linked puzzle');
  }
  await call('/api/settings', { changes: { ninja: '' } }, t1.token);
  step('a puzzle link, with old Board values that differ: the linked puzzle, on PTN Ninja, no switch or reload');

  // 14. an account with nothing stored: the first post carries this browser's beta settings as they are
  const t3 = await call('/api/register', { name: 'tester3' });
  await load({ token: t3.token, me: { name: 'tester3' }, prefs: { ...PREFS, confirm: true, arrows: false, sound: 'off' } });
  await until(STEADY, 'tester3, settled');
  await sleep(300);
  assert.deepEqual(await srv(t3.token), { arrows: false, sound: 'off', confirm: true, ninja: '' });
  step('an account with nothing stored gets this device\'s settings, the old Engine arrows carried as it is');
  await betaKept('at the end');

  // 14b. an index.html cached from before the Settings page (a CDN edge can serve one for minutes after a deploy) with
  // this app.js: it has no <main id="view-settings">. The page still boots and shows a puzzle, the Settings page opens
  // (its <main> added), and back again; no page errors.
  {
    const OLD = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').replace(/<main id="view-settings"[^>]*><\/main>\n?/, '');
    assert.ok(!OLD.includes('view-settings'), 'the old HTML has no Settings <main>');
    const paused = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Fetch.requestPaused' && m.params.request.url.startsWith(BASE)) cdp('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }, { name: 'cache-control', value: 'no-store' }], body: Buffer.from(OLD).toString('base64') }).catch(() => {});
    };
    ws.addEventListener('message', paused);
    await cdp('Fetch.enable', { patterns: [{ urlPattern: BASE + '/', resourceType: 'Document' }, STANDIN_PATTERN] });
    const before = errors.length;
    try {
      await cdp('Page.navigate', { url: BASE + '/LICENSE.txt' }); await sleep(150);
      await ev(`(localStorage.clear(), sessionStorage.clear(), localStorage.setItem('tinue.prefs', ${JSON.stringify(JSON.stringify(PREFS))}), true)`);
      await cdp('Page.navigate', { url: BASE + '/#/' }); await sleep(150);
      await until(`document.title.startsWith('Puzzle #') && !document.querySelector('#view-puzzle').classList.contains('hidden')`, 'a puzzle on the old HTML', 25000);
      assert.equal(await ev(`document.querySelectorAll('#view-settings').length`), 0, 'served the old HTML');
      await ev(`(location.hash = '#/settings', true)`);
      await until(`document.title === 'Settings — tinue' && !!document.querySelector('#st-confirm') && document.querySelector('#view-puzzle').classList.contains('hidden')`, 'Settings on the old HTML');
      assert.equal(await ev(`document.querySelector('#view-settings').nextElementSibling?.matches('footer.credits')`), true, 'its <main> before the footer');
      await ev(`(location.hash = '#/', true)`);
      await until(`document.title.startsWith('Puzzle #') && document.querySelector('#view-settings').classList.contains('hidden')`, 'back to the puzzle');
      assert.deepEqual(errors.slice(before), [], 'no page errors on the old HTML');
    } finally {
      await cdp('Fetch.enable', { patterns: [STANDIN_PATTERN] }); ws.removeEventListener('message', paused);
    }
  }
  step('an index.html cached from before the Settings page, with this app.js: boots, shows a puzzle, opens Settings and goes back, no errors');

  // 15. the look field and the theme list (on the stand-in; with E2E_NINJA=1 on the real ptn.ninja, which draws them)
  {
    if (process.env.E2E_NINJA) await sleep(2500); // (cold loads of ptn.ninja a few seconds apart)
    await load({ token: t1.token, me: { name: 'tester1' }, prefs: { ...PREFS } }, '/#/settings');
    await until(`!document.querySelector('#st-ninja').disabled && document.querySelector('#st-status').textContent === 'Saved to your account.'`, 'the look field usable');
    await ev(`(document.querySelector('#st-ninja').value = 'javascript:alert(1)', document.querySelector('#st-ninja-form').requestSubmit(), true)`);
    assert.equal(await ev(`document.querySelector('#st-ninja-msg').textContent`), 'Only ptn.ninja links can be used here.');
    await ev(`(document.querySelector('#st-ninja').focus(), document.querySelector('#st-ninja').value = '', true)`);
    await cdp('Input.insertText', { text: 'https://ptn.ninja/&axisLabels=false&theme=retro&showRoads=true' });
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(`document.querySelector('#st-ninja-msg').textContent.startsWith('Using axis labels off, theme retro.')`, 'the paste used (Enter in the field)');
    assert.equal(await ev(`document.querySelector('#st-ninja-msg').textContent`), 'Using axis labels off, theme retro. Left out, because tinue sets these itself: showRoads.');
    await sleep(800);
    assert.equal((await srv()).ninja, (await prefs()).ninja);
    assert.match((await srv()).ninja, /^&axisLabels=false&theme=[A-Za-z0-9$+-]+$/);
    assert.equal(await ev(`document.querySelector('#st-ninja-theme').value`), 'retro', 'the theme select shows the pasted built-in theme');
    await betaKept('after the look');
    await ev(`document.activeElement.blur()`);
    await shot('look-field-1280.png', '.set-list', 'start');
    await size(...PHONE); await sleep(300); await shot('look-field-390.png', '#st-ninja-form', 'center'); await size(...WIDE);
    step('the look field: javascript: refused in words; a ptn.ninja link pasted, Enter, used and left-out settings named, saved to the account');
    // the board itself, with the look; the iframe started (index.html) with the look in its address
    await sleep(2500);
    await reload('/#/');
    await until(`document.querySelector('#board iframe')?.style.opacity === '1' && document.title.startsWith('Puzzle #')`, 'PTN Ninja shown', 30000);
    await sleep(2000);
    const src = await ev(`document.querySelector('#board iframe').src`);
    assert.ok(src.startsWith('https://ptn.ninja/&') && src.includes('&axisLabels=false') && /&theme=[A-Za-z0-9$+-]+$/.test(src), src);
    await shot('look-board-1280.png');
    await size(...PHONE); await sleep(1500); await shot('look-board-390.png', '#board', 'start'); await size(...WIDE);
    step('the embedded board starts with the look in its address: ' + src.slice(0, 60) + '…');
    // Clear, from the Settings page: back to tinue's look on the same board (no reload)
    await ev(`(location.hash = '#/settings', true)`);
    await until(`!document.querySelector('#st-ninja-clear').disabled`, 'Clear');
    await ev(`(document.querySelector('#st-ninja-clear').click(), true)`);
    await until(`document.querySelector('#st-ninja-msg').textContent === 'The board has tinue felt again.'`, 'cleared');
    await ev(`(location.hash = '#/', true)`); await sleep(2000);
    await shot('look-cleared-1280.png');
    step('Clear: back to tinue felt on the same board');
    // the theme select (ninja-main): the same stored look as the paste box, synced the same way
    await ev(`(location.hash = '#/settings', true)`);
    await until(`!document.querySelector('#st-ninja-theme').disabled && document.querySelector('#st-ninja-theme').value === ''`, 'the theme select at tinue felt');
    assert.equal(await ev(`document.querySelector('#st-ninja-theme option').textContent`), 'tinue felt');
    assert.equal(await ev(`document.querySelector('#st-ninja-theme [value="custom"]').hidden`), true);
    await pick('#st-ninja-theme', 'aqua');
    await until(`(JSON.parse(localStorage.getItem('tinue.prefs')).ninja || '').startsWith('&theme=')`, 'the theme stored');
    await sleep(600);
    assert.equal((await srv()).ninja, (await prefs()).ninja, 'synced to the account as the paste box\'s string');
    assert.equal(await ev(`document.querySelector('#st-ninja').value`), '&theme=aqua', 'the paste box shows the same look, readably');
    await shot('settings-theme-1280.png');
    await ev(`(location.hash = '#/', true)`); await sleep(1500);
    await shot('ninja-theme-aqua.png');
    await ev(`(location.hash = '#/settings', true)`); await sleep(300);
    await pick('#st-ninja-theme', '');
    await until(`!JSON.parse(localStorage.getItem('tinue.prefs')).ninja`, 'tinue felt again');
    step('the theme select: Aqua stored as the look string, synced, shown on the board; tinue felt clears it');
    // tinue legacy (the board before the felt) and every one of PTN Ninja's built-ins in the list, by PTN Ninja's names
    assert.deepEqual(await ev(`[...document.querySelectorAll('#st-ninja-theme option')].filter((o) => !o.hidden).map((o) => o.textContent)`),
      ['tinue felt', 'tinue classic', 'Aaron', 'Aer', 'Aether', 'Aqua', 'Atlas', 'Backlit', 'BubbleTron', 'Classic', 'Discord', 'Essence', 'Fresh', 'Ignis', 'Luna', 'Paper', 'Retro', 'Stealth', 'Terra', 'Zen']);
    await pick('#st-ninja-theme', 'legacy');
    await until(`document.querySelector('#st-ninja').value === '&theme=tinue-classic'`, 'tinue classic stored');
    // typed by name: tinue classic (any of its names), while 'classic' alone is PTN Ninja's Classic
    for (const [v, want] of [['classic', 'classic'], ['tinue classic', 'legacy'], ['Classic Tinue', 'legacy'], ['classic', 'classic'], ['legacy', 'legacy']]) {
      await ev(`(document.querySelector('#st-ninja').value = ${JSON.stringify(v)}, document.querySelector('#st-ninja-form').requestSubmit(), document.activeElement?.blur(), true)`);
      await until(`document.querySelector('#st-ninja-theme').value === ${JSON.stringify(want)}`, 'typed ' + v);
    }
    await pick('#st-ninja-theme', 'legacy'); await until(`document.querySelector('#st-ninja-theme').value === 'legacy'`, 'tinue classic again');
    await sleep(600);
    assert.equal((await srv()).ninja, (await prefs()).ninja, 'synced');
    await shot('settings-theme-legacy-1280.png', '.set-list', 'start');
    await ev(`(location.hash = '#/', true)`); await sleep(1500);
    await shot('ninja-theme-legacy.png');
    await ev(`(location.hash = '#/settings', true)`); await sleep(300);
    // a theme's code as PTN Ninja's theme editor shares it, and its game links (which carry no look)
    const code = JSON.stringify({ id: 'mine', name: 'Mine', boardStyle: 'grid2', boardChecker: false, rings: 0, colors: { primary: '#ff9800', secondary: '#3e2723', ui: '#4e342e', player1: '#fff3e0', player2: '#212121', board1: '#a1887f', board2: '#8d6e63', board3: '#5d4037' } }, null, 2);
    for (const [v, msg] of [['https://ptn.ninja/s/AbCd1234', /^PTN Ninja’s game links don’t carry its look\./], ['Zen', /^Using theme zen\.$/], [code, /^Using a custom theme\.$/]]) {
      await ev(`(document.querySelector('#st-ninja').value = ${JSON.stringify(v)}, document.querySelector('#st-ninja-form').requestSubmit(), true)`);
      await until(`${msg}.test(document.querySelector('#st-ninja-msg').textContent)`, 'the paste ' + v.slice(0, 30));
    }
    assert.equal(await ev(`document.querySelector('#st-ninja-theme').value`), 'custom');
    await ev(`(location.hash = '#/', true)`); await sleep(1500);
    await shot('ninja-theme-code.png');
    await ev(`(location.hash = '#/settings', true)`); await sleep(300);
    await pick('#st-ninja-theme', '');
    await until(`!JSON.parse(localStorage.getItem('tinue.prefs')).ninja`, 'tinue felt again');
    step('the theme list: tinue felt, tinue classic and all 18 of PTN Ninja\'s; tinue classic typed by any of its names (classic alone: PTN Ninja\'s), Zen by name and a theme\'s code used; a short link answered in words');
  }
  if (errors.length) console.log('page errors:', errors);
  assert.deepEqual(errors.filter((e) => !/ptn\.ninja|ResizeObserver/i.test(e)), [], 'no page errors');
  console.log(`all ${n} steps passed`);
} finally {
  try { ws.close(); } catch {}
  chrome.kill();
  await stop();
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
  clearTimeout(watchdog);
}
