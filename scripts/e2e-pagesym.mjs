// The real puzzle page under a symmetry, end to end: headless Chrome against a recording fake API (no database, no
// network). Two puzzles (a real 6×6 one built from its TPS, and one with a game history the page replays), each visited
// under s = 0..7 by #/puzzle/<id>/<s>, played the same way in the puzzle's own labels and entered turned: a wrong move,
// a listed alternative played out against "crux" (the fake /api/defend) with one move of the player's and Give up, the
// solution, the engine line (/api/analyze), then Next. Every request the page made under s must equal the s = 0 one
// (timings and the random nonce aside); the board must show the turned labels; Next must come back without a symmetry.
// Not part of npm test (it needs Chrome):  node scripts/e2e-pagesym.mjs [chrome binary]
// Ports $E2E_PORT (default 9311; pages + API) and the next one (DevTools); its Chrome profile lives in a new directory under $E2E_TMP (else the
// system's temporary directory), removed at the end. E2E_SYMS=0,3 limits the symmetries (0 always runs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standin, STANDIN_ARGS, STANDIN_PATTERN } from './e2e-standin.mjs'; // (PTN Ninja, the only board: a local stand-in)
import { Game } from '../shared/tak.js';
import * as SYM from '../shared/sym.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.argv[2] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = +process.env.E2E_PORT || 9311, DT = PORT + 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const legal = (g) => g.legalMoves().map((m) => g.moveToPTN(m));

// ---------- the puzzles ----------
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rush-sym-sample.json'), 'utf8'));
function withAlts(p) { // a listed alternative and a wrong move: legal moves off the tree, away from its squares
  const g = Game.fromTPS(p.tps, p.komi), off = legal(g).filter((m) => !(m in (p.tree === 'win' ? {} : p.tree)) && /^[a-h][1-8]$/.test(m));
  return { ...p, alts: [off[0]], wrong: off.at(-1) };
}
const A = (() => { const { before, last, ...p } = SAMPLE[0]; return withAlts({ ...p, id: 'pdA', themes: [], attempts: 1, solves: 0, rd: 80, source: 'playtak', sourceRef: '1', meta: {} }); })();
// A game played at random until the side to move has a road in one: the puzzle starts two plies before that, with the
// game so far as its history (the page builds its board and lines from it) and that road as the tree's end.
const B = (() => {
  let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (;;) {
    const g = new Game(6), h = [];
    for (let i = 0; i < 60 && !g.result(); i++) {
      const roads = legal(g).filter((m) => { const c = g.clone(); c.play(m); return c.result()?.winner === g.toMove; });
      if (roads.length && h.length >= 14) {
        const start = new Game(6); for (const m of h.slice(0, -2)) start.play(m);
        if (start.toMove !== g.toMove) break;
        return withAlts({ id: 'pdB', size: 6, komi: 2, tps: start.toTPS(), plies: 3, rating: 1500, rd: 80, attempts: 0, solves: 0, themes: [], source: 'playtak', sourceRef: '2',
          altFirst: true, tree: { [h.at(-2)]: { r: h.at(-1), n: 'win' } }, meta: { history: h.slice(0, -2), white: 'w', black: 'b' }, turn: start.toMove, pre0: 0 });
      }
      const ms = legal(g).filter((m) => { const c = g.clone(); c.play(m); return !c.result(); });
      const m = ms[Math.floor(rnd() * ms.length)]; g.play(m); h.push(m);
    }
  }
})();
const OTHER = { ...A, id: 'pdOther' };

// ---------- the fake API, recording ----------
let reqs = [];
const user = { id: 1, name: null, rating: 1500, rd: 100, provisional: true, games: 0, wins: 0 };
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/json' };
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const json = (o, st = 200) => res.writeHead(st, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (u.pathname.startsWith('/api/')) {
    reqs.push({ method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), body: body ? JSON.parse(body) : null });
    const canonMove = (t) => legal(Game.fromTPS(t, 2))[0]; // whatever the engine says, said about the position it was sent
    if (u.pathname === '/api/me') return json({ user });
    if (u.pathname === '/api/next') return json({ puzzle: OTHER, judge: 'shadow' });
    if (u.pathname.startsWith('/api/puzzle/')) return json({ puzzle: [A, B, OTHER].find((p) => p.id === decodeURIComponent(u.pathname.slice(12))) ?? null, judge: 'shadow' }); // (as the server's JUDGE_FIELD: without it the page sends no shadow move log)
    if (u.pathname === '/api/result') return json({ user, rated: true, userDelta: 3 });
    if (u.pathname === '/api/move') return json({ ok: true });
    if (u.pathname === '/api/analyze') return json({ engine: 'syntaks', side: 'white', scoreCp: 0, mate: null, winProb: 0.5, pv: [canonMove(u.searchParams.get('tps'))], best: canonMove(u.searchParams.get('tps')), depth: 3, nodes: 1, ms: 1 });
    if (u.pathname === '/api/defend') return json({ move: canonMove(u.searchParams.get('tps')), mate: null, winProb: 0.5, side: 'black', depth: 3, ms: 1 });
    return json({ error: 'unknown route' }, 404);
  }
  // No in-browser Syntaks: every defender reply then comes from the fake /api/defend, so a visit's requests don't depend
  // on whether the download finished before the second reply (it raced, and the count of /api/defend calls with it).
  if (u.pathname.startsWith('/syntaks/')) return res.writeHead(404).end();
  let f = path.join(ROOT, 'public', decodeURIComponent(u.pathname));
  if (u.pathname === '/' || u.pathname.startsWith('/puzzle/')) f = path.join(ROOT, 'public/index.html');
  try { const buf = fs.readFileSync(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(buf); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

// ---------- Chrome over the DevTools protocol ----------
const profile = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'tinue-e2e-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...STANDIN_ARGS, 'about:blank'], { stdio: 'ignore' });
let ws, id = 0;
const pending = new Map(), logs = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${DT}/json/list`)).json()).find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch {}
    await sleep(200);
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Fetch.requestPaused') standin(cdp, m.params, process.env.E2E_NINJA || 'ok'); else if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails?.exception?.description); };
}
// (each call gives up after 60 s, and a DevTools error is thrown, naming the call)
const cdp = (method, params = {}) => new Promise((r, j) => { const i = ++id, t = setTimeout(() => { pending.delete(i); j(new Error('no answer to ' + method)); }, 60e3); t.unref(); pending.set(i, (m) => { clearTimeout(t); if (m.error) j(new Error(`${method}: ${m.error.message}`)); else r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + expr); return r.result?.result?.value; };
const until = async (expr, what, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (typeof expr === 'function' ? expr() : await ev(expr)) return; await sleep(100); } throw new Error('timed out: ' + what); };
const playable = `!document.querySelector('#ptn-in').disabled`;
const type = async (m) => { await until(playable, 'board playable before ' + m); await ev(`(() => { const i = document.querySelector('#ptn-in'); i.value = ${JSON.stringify(m)}; document.querySelector('#ptn-form').requestSubmit(); return true; })()`); };
const click = (act) => until(`(() => { const b = document.querySelector('#feedback [data-act="${act}"]'); if (!b || b.disabled) return false; b.click(); return true; })()`, 'button ' + act);
const quiet = async () => { let n = -1; while (n !== reqs.length) { n = reqs.length; await sleep(1200); } }; // (the outbox posts on a timer)

// One visit: the play in the puzzle's own labels (p), entered under s.
async function visit(p, s) {
  await cdp('Page.navigate', { url: 'about:blank' }); await sleep(100);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until(`document.readyState === 'complete' && !!document.querySelector('#ptn-in')`, 'page');
  await ev(`(sessionStorage.clear(), localStorage.clear(), localStorage.setItem('tinue.token', '"tok"'), true)`);
  await cdp('Page.navigate', { url: 'about:blank' }); await sleep(100);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/` });
  await until(`location.pathname === '/puzzle/pdOther'`, 'the first puzzle (judge: shadow)');
  await until(playable, 'first puzzle playable');
  reqs = [];
  const fwd = (m) => SYM.move(s, 6, m);
  await ev(`(location.hash = ${JSON.stringify('#/puzzle/' + p.id + (s ? '/' + s : ''))}, true)`);
  await until(`(location.pathname + location.hash).includes('${p.id}')`, 'the puzzle');
  await sleep(300);
  const addr = await ev('location.pathname + location.search + location.hash');
  assert.equal(addr, s ? `/#/puzzle/${p.id}/${s}` : `/puzzle/${p.id}`, 'the address keeps the symmetry');
  const moves = [];
  // (after the new puzzle's first second, when the board takes moves: busy.js)
  await until(playable, 'playable'); await sleep(1300);
  // a wrong move: checked, then a miss
  const wrong = async () => {
    await type(fwd(p.wrong));
    await until(`document.querySelector('#feedback')?.textContent.match(/doesn|answers|road|win|not the move/i)`, 'the miss');
    await sleep(2800); // (the check, then the board is put back 700 ms after a miss)
  };
  // the listed alternative: a proven play-out against crux; one move of the player's, then Give up
  const alt = async () => {
    await type(fwd(p.alts[0]));
    await until(`!!document.querySelector('#feedback [data-act="giveup"]')`, 'the play-out');
    await until(playable, 'the defender answered');
    const g = Game.fromTPS(p.tps, p.komi); g.play(p.alts[0]);
    const reply = reqs.filter((r) => r.path === '/api/defend').at(-1);
    g.play(legal(Game.fromTPS(reply.q.tps, 2))[0]);
    const mine = legal(g).find((m) => { const c = g.clone(); c.play(m); return !c.result(); });
    await type(fwd(mine));
    await sleep(300); await until(playable, 'the second reply');
    await sleep(1600); await click('giveup');
    await sleep(1200);
  };
  // B plays the alternative first, so its result's log carries the play-out ('slow', 'po'); A's carries the miss
  if (p.altFirst) { await alt(); await wrong(); } else { await wrong(); await alt(); }
  // the solution's line, to the road
  const h = Game.fromTPS(p.tps, p.komi);
  for (let node = p.tree; ;) {
    const k = node === 'win' ? legal(h).find((m) => { const c = h.clone(); c.play(m); return c.result()?.winner === h.toMove; }) : Object.keys(node)[0];
    await type(fwd(k)); moves.push(fwd(k)); h.play(k);
    if (node === 'win' || h.result()) break;
    if (node[k].r) { h.play(node[k].r); moves.push(fwd(node[k].r)); }
    node = node[k].n;
    await sleep(700);
  }
  await until(`!!document.querySelector('#feedback [data-act="next"]')`, 'solved');
  // a step back from the road (the engine has nothing to say about a finished game): the engine line for that position
  await sleep(1200); await ev('(document.activeElement?.blur(), true)');
  for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await until(() => reqs.some((r) => r.path === '/api/analyze'), 'the engine line');
  const an = reqs.filter((r) => r.path === '/api/analyze').at(-1), pv0 = legal(Game.fromTPS(an.q.tps, 2))[0];
  // wait for the server's line itself: the tactics worker's proven line can be drawn before it
  await until(`[...document.querySelectorAll('[data-pv]')].some((b) => b.textContent === ${JSON.stringify(fwd(pv0))})`, 'the engine line shown').catch(() => {});
  const pvShown = await ev(`[...document.querySelectorAll('[data-pv]')].map((b) => b.textContent).join(' ')`);
  assert.ok(pvShown.includes(fwd(pv0)), `the engine line comes back turned: ${fwd(pv0)} in "${pvShown}"`);
  await sleep(300);
  // the move list shows the turned labels
  const listed = await ev(`document.querySelector('#moves')?.textContent || ''`);
  for (const m of moves) assert.ok(listed.includes(m), `the move list shows ${m} (s=${s}): ${listed.slice(0, 200)}`);
  await quiet();
  // Next: the next puzzle, with no symmetry in its address
  await sleep(1100); await click('next');
  await until(`location.pathname === '/puzzle/pdOther' && !location.hash`, 'next puzzle, plain address');
  await quiet();
  return reqs;
}
// What a request says about the play: its timings and the attempt's random nonce aside.
const play = (rs) => rs.map(({ method, path: p, q, body }) => {
  const b = body && JSON.parse(JSON.stringify(body));
  if (b) { delete b.ms; delete b.nonce; if (Array.isArray(b.log)) b.log.forEach((e) => delete e.ms); }
  return { method, path: p, q, body: b };
});
const byKind = (rs) => ({ result: rs.filter((r) => r.path === '/api/result'), move: rs.filter((r) => r.path === '/api/move').sort((a, b) => a.body.ply - b.body.ply),
  analyze: rs.filter((r) => r.path === '/api/analyze'), defend: rs.filter((r) => r.path === '/api/defend'), other: rs.filter((r) => !['/api/result', '/api/move', '/api/analyze', '/api/defend'].includes(r.path)) });

let ok = 0;
try {
  await connect();
  await cdp('Runtime.enable'); await cdp('Fetch.enable', { patterns: [STANDIN_PATTERN] });
  for (const p of [A, B]) {
    const base = byKind(play(await visit(p, 0).catch(async (e) => { console.log('feedback:', await ev(`document.querySelector('#feedback')?.textContent`), '\nmoves:', await ev(`document.querySelector('#moves')?.textContent`), '\nreqs:', reqs.map((r) => r.path + ' ' + JSON.stringify(r.body ?? r.q)).join('\n'), logs); throw e; })));
    assert.ok(base.result.length === 1 && base.move.length >= 5 && base.defend.length === 2 && base.analyze.length >= 1, `${p.id}: the visit made its requests ${JSON.stringify(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.length])))}`);
    console.log(`  ${p.id} s=0: ${base.move.length} plies, ${base.defend.length} defend, ${base.analyze.length} analyze, log ${JSON.stringify(base.result[0].body.log)}`);
    for (const s of (process.env.E2E_SYMS || '1,2,3,4,5,6,7').split(',').map(Number).filter((x) => x > 0)) {
      const v = byKind(play(await visit(p, s)));
      for (const k of Object.keys(base)) assert.deepEqual(v[k], base[k], `${p.id} s=${s}: ${k} requests differ from s=0`);
      ok++; console.log(`ok ${p.id} s=${s}: every request equals s=0's`);
    }
  }
  if (logs.length) console.log('page exceptions:', logs);
  console.log(`e2e-pagesym: all ${ok} passed`);
} finally {
  ws?.close(); chrome.kill(); srv.close();
  await sleep(300); fs.rmSync(profile, { recursive: true, force: true });
}
