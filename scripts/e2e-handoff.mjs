// The move to another domain, end to end between two local origins: the real server behind a switchable proxy, the old
// page (a production build for http://127.0.0.1:<p>/tinue/, then build-moved.sh on it), the new one (build-static.sh
// DOMAIN, at http://localhost:<p+1>/) and headless Chrome with a local stand-in for PTN Ninja. Made-up players only.
// Not part of npm test (it needs Chrome and public/syntaks/syntaks.wasm):  node --no-warnings scripts/e2e-handoff.mjs
// Ports from $E2E_PORT (default 9761): old page, new page, API, the server behind it, DevTools. Temporary files under
// $E2E_TMP, removed at the end. POST /api/handoff-token is answered by the proxy (the contract's answers).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { standin, STANDIN_ARGS, STANDIN_PATTERN } from './e2e-standin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const P = +process.env.E2E_PORT || 9761, OLD = `http://127.0.0.1:${P}/tinue/`, NEW = `http://localhost:${P + 1}/`, API = `http://127.0.0.1:${P + 2}`, SRV = P + 3, DT = P + 4;
const dir = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'tinue-e2e-handoff-')), DB = path.join(dir, 'e2e.db'), SITE = path.join(dir, 'old'), SITE2 = path.join(dir, 'new');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), kids = [];
process.on('exit', () => { for (const k of kids) try { k.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
setTimeout(() => { console.log('timed out'); process.exit(2); }, 300e3).unref();
let n = 0; const step = (s) => console.log('ok', ++n, s);

// ---------- the server, behind a proxy that can be down and that records what reaches it ----------
const boot = () => new Promise((res, rej) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TINUE_')));
  const c = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server/server.js')], { stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...env, PORT: String(SRV), TINUE_DB: DB, TINUE_ACCESS_LOG: path.join(dir, 'access.log'), TINUE_SYNTAKS: '/nonexistent', TINUE_ORIGINS: [new URL(OLD).origin, new URL(NEW).origin].join() } });
  c.stdout.on('data', (d) => { if (String(d).includes('tinue on')) res(c); }); c.on('exit', (x) => rej(new Error('server exited ' + x))); kids.push(c);
});
let c = await boot(); c.kill(); await new Promise((r) => c.once('exit', r));
{
  const db = new DatabaseSync(DB), ins = db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, source_ref, init_rating, rating, komi, turn, grade) VALUES (?, 6, ?, ?, ?, '', 'playtak', '1', 1500, 1500, ?, 1, 'A')`);
  for (const p of JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rush-sym-sample.json'), 'utf8')).slice(0, 8)) ins.run(p.id, p.tps, p.plies, JSON.stringify(p.tree), p.komi);
  db.close();
}
c = await boot();
let down = false, tokenMode = 'ok', reqs = [], rushRuns = [];
const proxy = http.createServer(async (req, res) => {
  const chunks = []; for await (const x of req) chunks.push(x); const body = Buffer.concat(chunks);
  if (req.method !== 'OPTIONS') reqs.push({ m: req.method, url: req.url, o: req.headers.origin, ref: req.headers.referer, auth: req.headers.authorization, body: body.toString() });
  if (down) return res.writeHead(502, { 'content-type': 'text/html' }).end('<h1>502</h1>');
  const o = req.headers.origin, cors = { 'access-control-allow-origin': o || '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type, authorization' };
  const json = (st, x) => res.writeHead(st, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(x));
  if (req.method === 'POST' && req.url === '/api/handoff-token') {
    if (o !== new URL(OLD).origin) return json(404, { error: 'not found' });
    const t = /tinue_token=([a-f0-9]{48})/.exec(req.headers.cookie || '')?.[1];
    return tokenMode === 'off' ? json(404, { error: 'not found' }) : t && !req.headers.authorization ? json(200, { token: t }) : json(401, { error: 'none' });
  }
  if (req.method === 'POST' && req.url === '/api/rush/result') { const r = JSON.parse(body).run; if (rushRuns.includes(r)) return json(409, { error: 'run already posted' }); rushRuns.push(r); return json(200, { id: rushRuns.length, best: {} }); }
  const up = http.request({ host: '127.0.0.1', port: SRV, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => res.destroy()); up.end(body);
}).listen(P + 2, '127.0.0.1');
const call = async (p, body, token) => (await fetch(`http://127.0.0.1:${SRV}${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) })).json();
const t1 = (await call('/api/register', { name: 'tester1' })).token, t2 = (await call('/api/register', { name: 'tester2' })).token;
const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rush-sym-sample.json'), 'utf8')).slice(0, 8).map((p) => p.id);
const attempts = () => { const db = new DatabaseSync(DB, { readOnly: true }), r = db.prepare('SELECT u.name, a.puzzle_id AS id, a.win, a.rated FROM attempts a JOIN users u ON u.id = a.user_id ORDER BY a.ts').all().map((x) => ({ ...x })); db.close(); return r; };

// ---------- the pages, as GitHub Pages serves them ----------
const sh = (args, env) => { const r = spawnSync('sh', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TINUE_DB: DB, ...env } }); assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout; };
const git = (...a) => { const r = spawnSync('git', ['-C', path.join(SITE, 'tinue'), '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
sh(['scripts/build-static.sh', API], { SITE, SITE_URL: OLD, DOMAIN: '' });
sh(['scripts/build-static.sh', API], { SITE: SITE2, SITE_URL: NEW, OLD_URL: OLD, DOMAIN: 'tinue.test' });
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'R1');
assert.equal(fs.readFileSync(path.join(SITE2, 'tinue/CNAME'), 'utf8'), 'tinue.test\n');
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const pages = (root, port, host, seen = []) => { http.createServer((req, res) => {
  seen.push([req.url, req.headers.referer]);
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  for (const f of [p, p + '.html', p + (p.endsWith('/') ? '' : '/') + 'index.html']) { const x = path.join(root, f); if (fs.existsSync(x) && fs.statSync(x).isFile()) return res.writeHead(200, { 'content-type': TYPES[path.extname(x)] || 'text/plain', 'cache-control': 'no-store' }).end(fs.readFileSync(x)); }
  const e = path.join(root, '404.html'); res.writeHead(404, { 'content-type': 'text/html' }).end(fs.existsSync(e) ? fs.readFileSync(e) : 'not found');
}).listen(port, host); return seen; };
const seenOld = pages(SITE, P, '127.0.0.1'), seenNew = pages(path.join(SITE2, 'tinue'), P + 1, 'localhost');

// ---------- Chrome ----------
const profile = path.join(dir, 'chrome');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...STANDIN_ARGS, 'about:blank'], { stdio: 'ignore' }); kids.push(chrome);
let ws, id = 0; const pend = new Map(), errors = [], urls = [];
for (let i = 0; i < 50 && !ws; i++) { try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch {} await sleep(200); }
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const cdp = (method, params = {}) => new Promise((r, j) => { const i = ++id, t = setTimeout(() => { pend.delete(i); j(new Error('no answer to ' + method)); }, 15000); pend.set(i, (m) => { clearTimeout(t); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Fetch.requestPaused') { if (m.params.request.url.startsWith('https://ptn.ninja/')) standin(cdp, m.params, 'ok'); else cdp('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }); }
  else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) urls.push(m.params.frame.url + (m.params.frame.urlFragment || ''));
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); };
const ev = async (x) => { const r = await cdp('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || x); return r.result?.result?.value; };
const until = async (x, what, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(x).catch(() => false)) return; await sleep(80); } throw new Error(`timed out: ${what}; ` + JSON.stringify(await ev('({ at: location.href, card: document.querySelector("#feedback")?.innerText, ls: { ...localStorage }, ss: { ...sessionStorage } })').catch(String)) + errors.join()); };
await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
// (no outside request leaves this machine: fonts are refused, PTN Ninja is the stand-in)
await cdp('Fetch.enable', { patterns: [STANDIN_PATTERN, { urlPattern: 'https://*' }] });
const nav = async (u) => { await cdp('Page.navigate', { url: 'about:blank' }); await sleep(60); urls.length = 0; reqs = []; await cdp('Page.navigate', { url: u }); };
const shot = async (name) => { if (!process.env.SHOTS) return; fs.mkdirSync(process.env.SHOTS, { recursive: true }); for (const [w, h] of [[1280, 800], [390, 844]]) { await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 }); await sleep(500); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS, `${name}-${w}.png`), Buffer.from(r.result.data, 'base64')); } await cdp('Emulation.clearDeviceMetricsOverride'); await sleep(200); };
const ready = `document.readyState === 'complete' && !!document.querySelector('#userbox .menu')`;
const atNew = (tail, what) => until(`location.origin === ${JSON.stringify(new URL(NEW).origin)} && !/h[snd]=/.test(location.hash) && ${ready} && ${tail ? `(location.pathname + location.hash).endsWith(${JSON.stringify(tail)})` : 'true'}`, what || 'at the new page');
const ls = (k) => ev(`JSON.parse(localStorage.getItem('tinue.${k}'))`);
const named = (x) => until(`document.querySelector('#userbox .name')?.textContent === ${JSON.stringify(x)}`, 'signed in as ' + x);
// storage set on an origin, by way of a plain file of it
const setOn = async (origin, vals, ses = {}) => { await cdp('Page.navigate', { url: origin + 'LICENSE.txt' }); await until(`location.href === ${JSON.stringify(origin + 'LICENSE.txt')} && document.readyState === 'complete'`, 'a plain file');
  await ev(`(localStorage.clear(), sessionStorage.clear(), ${JSON.stringify(Object.entries(vals))}.forEach(([k, v]) => localStorage.setItem('tinue.' + k, JSON.stringify(v))), ${JSON.stringify(Object.entries(ses))}.forEach(([k, v]) => sessionStorage.setItem('tinue.' + k, JSON.stringify(v))), true)`); };
const readOn = async (origin, k) => { await cdp('Page.navigate', { url: origin + 'LICENSE.txt' }); await until(`location.href === ${JSON.stringify(origin + 'LICENSE.txt')} && document.readyState === 'complete'`, 'a plain file'); return k ? ls(k) : ev('({ ...localStorage })'); };
const play = async () => { await until(`!document.querySelector('#ptn-in').disabled`, 'board'); await until(`!document.querySelector('[data-act="solution"]')?.disabled`, 'Solution'); await sleep(1100); await ev(`(document.querySelector('[data-act="solution"]').click(), true)`); };
const entry = (pid, owner, t = Date.now() - 60e3, win = true) => ({ puzzleId: pid, body: { puzzleId: pid, win, ms: 1000 }, b: 1794817281, owner, gid: null, t });
const { ownerOf } = await import('../public/outbox.js');
const o1 = ownerOf(t1), prefs = { difficulty: 'harder', size: '6', v2: true, v3: true };

// ---------- 1: the results queue on the old page (R1) ----------
await setOn(OLD, { token: t1, prefs }); await nav(OLD + '#/puzzle/' + ids[0]); await named('tester1');
down = true; await play();
await until(`/reach the puzzle server/.test(document.querySelector('#feedback').innerText)`, 'the notice');
assert.equal((await ls('r.' + o1 + '.' + ids[0])).body.win, false); assert.equal(attempts().length, 0);
down = false; await ev(`(dispatchEvent(new Event('online')), true)`);
await until(`localStorage.getItem('tinue.r.${o1}.${ids[0]}') === null`, 'sent'); assert.equal(attempts().length, 1);
await until(`!/reach the puzzle server|Not sent yet/.test(document.body.innerText)`, 'the card follows');
step('old page: a result played while the API was down waits and is sent once when it is back');
await ev(`(location.hash = '#/puzzle/${ids[1]}', true)`); await until(`location.pathname.endsWith('/puzzle/${ids[1]}')`, 'the next puzzle'); down = true; await play();
await until(`localStorage.getItem('tinue.r.${o1}.${ids[1]}') !== null`, 'queued'); 
await ev(`(() => { const k = 'tinue.r.${o1}.${ids[1]}', e = JSON.parse(localStorage.getItem(k)); e.t -= 60000; localStorage.setItem(k, JSON.stringify(e)); return true; })()`);

// ---------- 2: the old page becomes the handoff ----------
sh(['scripts/build-moved.sh'], { SITE, NEW_URL: NEW, OLD_URL: OLD });
assert.deepEqual(git('status', '--porcelain').trim().split('\n').map((x) => x.trim()), ['M index.html', 'M version.json']);
await nav(OLD + '#/puzzle/' + ids[2]); await atNew('/puzzle/' + ids[2]);
assert.equal(await ls('token'), t1); assert.equal((await ls('prefs')).difficulty, 'harder'); assert.equal((await ls('r.' + o1 + '.' + ids[1])).body.win, false);
assert.equal(await ev('sessionStorage.getItem("tinue.hs")'), null); assert.equal(attempts().length, 1);
down = false; await nav(NEW); await atNew(); await named('tester1'); await until(`localStorage.getItem('tinue.r.${o1}.${ids[1]}') === null`, 'sent from the new page');
assert.deepEqual(attempts().map((a) => [a.name, a.id]), [['tester1', ids[0]], ['tester1', ids[1]]]);
step('a visit to the old page while the API is down: player, settings and the unsent result arrive; the result is sent once, from the new page');
await nav(OLD + '#/me'); await atNew('#/me'); await named('tester1'); await until(`!!document.querySelector('.hist')`, 'History');
assert.equal(attempts().length, 2, 'the copy left on the old page was a repeat'); assert.equal(Object.keys(await readOn(OLD)).filter((k) => k.startsWith('tinue.r.')).length, 0, 'and is gone once the server has it');
await nav(OLD + '#/leaderboard'); await atNew('#/leaderboard'); assert.ok(!reqs.some((r) => r.o === new URL(OLD).origin)); assert.ok(!seenNew.slice(-40).some(([u]) => /h[snd]=/.test(u)));
step('later visits forward with the route, asking nothing');
await nav(OLD + 'puzzle/' + ids[3] + '.html'); await atNew('/puzzle/' + ids[3]); await nav(NEW + 'tinue/puzzle/notbuilt1.html'); await atNew(null); assert.ok(reqs.some((r) => r.url.startsWith('/api/puzzle/notbuilt1')));
await nav(OLD + '#/evil//x?https://example.com'); await atNew('/puzzle/' + ids[0]).catch(() => {}); assert.equal(await ev('location.origin'), new URL(NEW).origin); await nav(NEW + 'tinue/#/rush'); await atNew('#/rush');
step('old puzzle pages, their 404s and unknown routes land on the new site');

// ---------- 3: signed out stays signed out; asked for, it comes back ----------
await setOn(NEW, {}); await nav(OLD + '#/'); await atNew(); await sleep(400); assert.equal(await ls('token'), null);
await ev(`(document.querySelector('#claim-open').click(), true)`); assert.match(await ev(`document.querySelector('#userbox').innerText`), /Played on shydrie\.xyz\? Bring your account/);
await shot('bring'); await ev(`(document.querySelector('[data-bring]').click(), true)`); await until(`localStorage.getItem('tinue.token') !== null`, 'brought').catch(async () => { throw new Error(urls.join('\n')); }); await atNew(); await named('tester1'); assert.equal(await ls('token'), t1);
step('signed out on the new page: the old one signs nobody in again, unless asked to ("Bring your account")');

// ---------- 4: two players ----------
await setOn(OLD, { token: t1, prefs }); await setOn(NEW, { token: t2, gid: 'b'.repeat(32) });
await nav(OLD); await atNew(); await until(`!!document.querySelector('#two-bar')`, 'the question'); assert.equal(await ls('token'), t2);
await shot('two-players'); assert.match(await ev(`document.querySelector('#two-bar').innerText`), /You have two players: tester2 here, tester1 from shydrie\.xyz\./);
await ev(`(document.querySelectorAll('#two-bar button')[1].click(), true)`); assert.equal(await ls('token'), t2); assert.equal((await ls('parked')).token, t1);
await ev(`(document.querySelector('[data-unpark]').click(), true)`); await named('tester1'); assert.equal(await ls('token'), t1); assert.equal((await ls('parked')).token, t2); assert.equal((await ls('parked')).gid, 'b'.repeat(32));
await ev(`(document.querySelector('[data-unpark]').click(), true)`); await named('tester2'); assert.equal((await ls('parked')).token, t1); assert.equal(await ls('gid'), 'b'.repeat(32));
await setOn(OLD, { token: t1, prefs }); await setOn(NEW, { token: t2 }); await nav(OLD); await until(`!!document.querySelector('#two-bar')`, 'asked again'); await ev(`(document.querySelectorAll('#two-bar button')[0].click(), true)`); await named('tester1'); assert.equal((await ls('parked')).token, t2); assert.equal(await ev('sessionStorage.getItem("tinue.hp")'), null);
step('two players: neither overwritten; keep, use, and switch both ways');

// ---------- 5: known only by the cookie ----------
await setOn(OLD, {}); await setOn(NEW, {});
await cdp('Network.setCookie', { url: API, name: 'tinue_token', value: t1, httpOnly: true, sameSite: 'Lax' });
await nav(OLD + '#/settings'); await atNew('#/settings'); await named('tester1'); assert.equal(await ls('token'), t1);
const ht = reqs.filter((r) => r.url === '/api/handoff-token'); assert.equal(ht.length, 1); assert.equal(ht[0].o, new URL(OLD).origin); assert.equal(ht[0].auth, undefined);
await cdp('Network.clearBrowserCookies');
await setOn(OLD, { gid: 'c'.repeat(32), prefs }); await setOn(NEW, {}); await nav(OLD); await atNew(); assert.equal(await ls('token'), null); assert.equal(await ls('gid'), 'c'.repeat(32)); assert.equal((await ls('prefs')).difficulty, 'harder');
assert.ok(await readOn(OLD, 'moved')); // (401: there is nobody)
await setOn(OLD, {}); await setOn(NEW, {}); tokenMode = 'off'; await nav(OLD); await atNew(); assert.equal(await readOn(OLD, 'moved'), null, 'no answer about the cookie: asked again next time'); tokenMode = 'ok';
step('a cookie-only player arrives signed in; one without a player keeps gid and settings');

// ---------- 6: results of a visitor without a token, a held one, a Rush queue larger than an address ----------
const anon = entry(ids[4], ''); anon.gid = 'd'.repeat(32);
await setOn(OLD, { gid: 'd'.repeat(32), ['r..' + ids[4]]: anon }); await setOn(NEW, {}); await nav(OLD); await atNew();
const tok = await ls('token'); assert.match(tok, /^[a-f0-9]{48}$/); assert.equal((await call('/api/me', null, tok)).user.name, null); assert.equal(attempts().filter((a) => a.name === null).length, 1);
step('a tokenless visitor: the unsent result makes the guest, and the guest arrives');
await setOn(OLD, { token: t1 }, { held: { id: ids[5], ms: 5, win: true, theme: '', b: 1794817281, owner: o1, page: 'gone' } }); await setOn(NEW, {});
await cdp('Page.navigate', { url: OLD }); await atNew(); await named('tester1'); assert.deepEqual(attempts().filter((a) => a.id === ids[5]).map((a) => [a.name, a.win]), [['tester1', 1]]);
step('a held result of this tab is sent');
const big = Array.from({ length: 20 }, (_, i) => ({ t: Date.now() - 1e6 + i, who: o1, body: { run: `${(Date.now() - 1e6).toString(36)}.r${i}.mac`, pad: 'x'.repeat(8000), mode: 'rush' } }));
const snap = { t: Date.now(), who: o1, snap: Date.now(), body: { run: `${Date.now().toString(36)}.live.mac`, mode: 'rush' } };
await setOn(OLD, { token: t1, rushQueue: [...big, snap] }); await setOn(NEW, {}); down = true; await nav(OLD); await atNew(); 
const carried = (await ls('rushQueue')).length; assert.ok(carried >= 3 && carried < 20, String(carried)); down = false;
await nav(OLD); await atNew(); assert.deepEqual([...rushRuns].sort(), big.map((x) => x.body.run).sort(), 'each run once'); assert.deepEqual((await readOn(OLD, 'rushQueue')).map((x) => x.body.run), [snap.body.run], 'the live one stays');
await nav(NEW + '#/rush'); await atNew('#/rush'); await until(`(JSON.parse(localStorage.getItem('tinue.rushQueue')) || []).length === 0`, 'the copies are refused as repeats'); assert.equal(rushRuns.length, 20);
step(`a Rush queue too big for one address: ${carried} of 20 went along, the rest were sent from the old page; each counted once; a live run left alone`);

// ---------- 7: hostile links ----------
const b64u = (x) => Buffer.from(x).toString('base64url'), payload = { v: 1, token: 'f0'.repeat(24), gid: 'e'.repeat(32) };
await setOn(NEW, { token: t1 });
for (const h of ['#hd=' + b64u(JSON.stringify(payload)) + '&to=%23%2Fme', '#hd=&to=x', '#hd=%%%', '#hd=' + b64u(crypto.getRandomValues(new Uint8Array(200)))]) { await nav(NEW + h); await atNew(); await sleep(150); assert.equal(await ls('token'), t1, h); assert.equal(await ev('sessionStorage.getItem("tinue.hp")'), null); }
await ev(`(sessionStorage.setItem('tinue.hs', JSON.stringify({ k: {}, t: Date.now() })), true)`); await cdp('Page.navigate', { url: 'about:blank' }); await nav(NEW + '#hd=' + b64u(JSON.stringify(payload))); await atNew(); assert.equal(await ls('token'), t1);
// an attacker's key: the payload goes to the new site only, where no key of this tab matches
const ap = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']), apub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', ap.publicKey)));
await setOn(OLD, { token: t2 }); await setOn(NEW, {}); await nav(OLD + '#hn=' + apub + '&to=https%3A%2F%2Fexample.com'); await atNew(); await sleep(200); assert.equal(await ls('token'), null); assert.ok(urls.every((u) => [OLD, NEW].some((x) => u.startsWith(x))), urls.join());
await nav(OLD + '#hn=' + 'A'.repeat(87)); await until(`location.origin === ${JSON.stringify(new URL(NEW).origin)}`, 'an invalid key: just forwarded');
// framed: nothing happens
await setOn(NEW, {}); await ev(`(document.body.innerHTML = '<iframe src="${OLD}#hn=${apub}"></iframe>', true)`); await sleep(1200); assert.equal(await ev('document.querySelector("iframe").contentWindow.length'), 0); assert.equal(await ls('token'), null);
step('crafted links and frames change nothing and send nothing elsewhere');
// the normal round, a second copy of it, and a round interrupted: the payload works once
await setOn(OLD, { token: t1 }); await setOn(NEW, {}); await nav(OLD); await atNew(); await named('tester1'); const hd = urls.find((u) => /hd=/.test(u));
await setOn(NEW, {}); assert.ok(hd, urls.join('\n')); await nav(hd); await atNew(); await sleep(300); assert.equal(await ls('token'), null, 'replayed');
assert.ok(!urls.join().includes(t1) && !decodeURIComponent(hd).includes(t1)); assert.ok(!Buffer.from(hd.match(/hd=([^&]*)/)[1], 'base64url').toString('latin1').includes(t1));
step('the payload is encrypted, and replaying its address does nothing');

// ---------- nothing leaked ----------
assert.ok(![...seenOld, ...seenNew].some(([u, r]) => /h[snd]=/.test(u + ' ' + r) || (u + r).includes(t1))); assert.ok(!reqs.some((r) => /h[snd]=/.test(r.url + r.ref + r.body)));
assert.deepEqual(errors, []);
const v = await (await fetch(`http://127.0.0.1:${DT}/json/version`)).json(), bw = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => { bw.onopen = r; }); const gone = new Promise((r) => chrome.on('exit', r)); bw.send('{"id":1,"method":"Browser.close"}'); await Promise.race([gone, sleep(8000)]);
{ const db = new DatabaseSync(path.join(profile, 'Default/History'), { readOnly: true }), all = db.prepare('SELECT url FROM urls').all().map((x) => x.url); db.close(); assert.ok(all.some((u) => u.startsWith(NEW)), 'the history was read'); for (const t of [t1, t2, tok]) assert.ok(!all.some((u) => u.includes(t) || Buffer.from((/hd=([^&]*)/.exec(u) || [])[1] || '', 'base64url').toString('latin1').includes(t))); }
step('no token in any request address, referrer, or the browser history');
console.log(`e2e-handoff: all ${n} ok`); process.exit(0);
