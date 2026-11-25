// C2: the client outbox (public/outbox.js) and what the server tells it (server.js `judge` on /api/next, `rev` on puzzles).
//   node --no-warnings scripts/test-outbox.mjs
// The outbox is driven with a fake fetch, storage and clock. Then the server is booted twice on a throwaway database:
// TINUE_JUDGE unset (no `judge`, no `rev`: /api/next's answers exactly as before) and TINUE_JUDGE=shadow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';
import { createOutbox, ownerOf, newNonce, KEY, MAX_ITEMS, MAX_PLY, HOLD_MS, MAX_FAILS, MAX_AGE } from '../public/outbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'ab'.repeat(24), OTHER = 'cd'.repeat(24);
const P = { id: 'pd1', rev: 3 };

// A fake world: a clock, timers run by run(), storage, and a fetch that answers from a script.
function world({ answers = () => 200, storage = true, token = TOKEN } = {}) {
  const w = { t: 1e12, timers: [], reqs: [], tok: token, data: new Map() };
  w.storage = storage === 'throws' ? { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } }
    : storage ? { getItem: (k) => (w.data.has(k) ? w.data.get(k) : null), setItem: (k, v) => w.data.set(k, String(v)), removeItem: (k) => w.data.delete(k) } : null;
  w.fetch = async (url, init) => {
    w.reqs.push({ url, init, body: JSON.parse(init.body) });
    const a = answers(w.reqs.at(-1), w.reqs.length);
    if (a === 'throw') throw new TypeError('network');
    return { status: a, headers: { get: (h) => (h === 'retry-after' && a === 429 ? '2' : null) }, text: async () => '{}' };
  };
  w.later = (f, ms) => { w.timers.push({ at: w.t + ms, f }); };
  // Run due timers (advancing the clock up to `ms` ahead), letting fetch promises settle between.
  w.run = async (ms = 0) => {
    const end = w.t + ms;
    for (let guard = 0; guard < 1000; guard++) {
      await new Promise((r) => setImmediate(r));
      w.timers.sort((a, b) => a.at - b.at);
      const due = w.timers[0];
      if (!due || due.at > end) break;
      w.timers.shift(); w.t = Math.max(w.t, due.at); due.f();
    }
    w.t = Math.max(w.t, end);
    await new Promise((r) => setImmediate(r));
  };
  w.make = () => createOutbox({ url: 'https://api.test/api/move', fetch: w.fetch, storage: w.storage, token: () => w.tok, now: () => w.t, later: w.later, build: 77 });
  w.queue = () => JSON.parse(w.data.get(KEY) || '[]');
  return w;
}

// 1. Off unless /api/next said judge: 'shadow' — nothing opens, nothing is sent, not even what an earlier load queued.
{
  const w = world();
  const ob = w.make();
  assert.equal(ob.open(P), null, 'no attempt before the server says shadow');
  ob.setMode(undefined);
  assert.equal(ob.open(P), null);
  ob.setMode('decide'); // a C2 page never posts where the server decides
  assert.equal(ob.open(P), null);
  w.data.set(KEY, JSON.stringify([{ k: 'x'.repeat(22), n: 0, o: ownerOf(TOKEN), t: w.t, h: 0, b: { puzzleId: 'pd1', nonce: 'x'.repeat(22), ply: 0, move: 'a1' } }]));
  const ob2 = w.make(); ob2.setMode(undefined);
  ob2.move(null, 'a1'); ob2.act(null, 'hint'); ob2.pagehide();
  await w.run(120e3);
  assert.equal(w.reqs.length, 0, 'judge off: zero requests');
  console.log('ok off: no attempt and zero requests while the server has the judge off (queued plies wait)');
}

// 2. No token: nothing opens (shadow never mints, and a post without a token would only be refused).
{
  const w = world({ token: null });
  const ob = w.make(); ob.setMode('shadow');
  assert.equal(ob.open(P), null);
  await w.run(60e3);
  assert.equal(w.reqs.length, 0);
  console.log('ok guest: no token, no attempt, no request');
}

// 3. Shadow: plies go one at a time, in order, text/plain with the bearer token, nonce in the body, never in the URL.
{
  const w = world();
  const ob = w.make(); ob.setMode('shadow');
  const a = ob.open(P, 'roadIn1');
  assert.match(a.nonce, /^[A-Za-z0-9_-]{16,64}$/);
  ob.move(a, 'c3', { clientVerdict: 'ok', ms: 1234.4 });
  ob.act(a, 'hint', { clientVerdict: 'hint', ms: 2000 });
  ob.move(a, 'd4', { clientVerdict: 'solved', ms: 3000 });
  assert.equal(w.reqs.length, 0, 'nothing is sent in the caller\'s turn (no added latency)');
  assert.equal(w.queue().length, 3, 'queued in sessionStorage');
  await w.run();
  assert.equal(w.reqs.length, 3);
  assert.deepEqual(w.reqs.map((r) => r.body.ply), [0, 1, 2]);
  for (const r of w.reqs) {
    assert.equal(r.url, 'https://api.test/api/move', 'nothing in the URL');
    assert.equal(r.init.method, 'POST');
    assert.equal(r.init.headers['content-type'], 'text/plain');
    assert.equal(r.init.headers.authorization, 'Bearer ' + TOKEN);
    assert.ok(!('guest' in r.body) && !('token' in r.body), 'no guest seed, no token in the body');
    assert.equal(r.body.nonce, a.nonce); assert.equal(r.body.puzzleId, 'pd1'); assert.equal(r.body.rev, 3);
    assert.equal(r.body.theme, 'roadIn1'); assert.equal(r.body.b, 77);
  }
  assert.deepEqual(w.reqs[0].body, { puzzleId: 'pd1', rev: 3, nonce: a.nonce, ply: 0, move: 'c3', clientVerdict: 'ok', ms: 1234, theme: 'roadIn1', b: 77 });
  assert.equal(w.reqs[1].body.act, 'hint');
  assert.equal(w.queue().length, 0, 'acked plies leave the queue');
  // a puzzle without rev (a stored one from before the judge was on): no rev field
  const b = ob.open({ id: 'ps2' });
  ob.move(b, 'a1', { clientVerdict: 'missed' }); await w.run();
  assert.ok(!('rev' in w.reqs.at(-1).body));
  assert.equal(ob.act(b, 'resign'), false, 'unknown acts are not sent');
  console.log('ok shadow: in order, text/plain, bearer header, nonce/rev/clientVerdict in the body, nothing in the URL');
}

// 4. A held move (the still-wins check) waits, and so does everything after it; filled, it goes with its verdict.
{
  const w = world();
  const ob = w.make(); ob.setMode('shadow');
  const a = ob.open(P);
  const fill = ob.hold(a, 'e5', { ms: 500 });
  ob.act(a, 'hint');
  await w.run(2000);
  assert.equal(w.reqs.length, 0, 'held');
  fill('missed'); fill('solved'); // once
  await w.run();
  assert.deepEqual(w.reqs.map((r) => [r.body.ply, r.body.move ?? r.body.act, r.body.clientVerdict]), [[0, 'e5', 'missed'], [1, 'hint', undefined]]);
  // never filled: it goes as 'judging' after HOLD_MS
  const fill2 = ob.hold(a, 'f6');
  await w.run(HOLD_MS - 1); assert.equal(w.reqs.length, 2);
  await w.run(2); assert.equal(w.reqs.at(-1).body.clientVerdict, 'judging');
  fill2('ok'); await w.run(); assert.equal(w.reqs.length, 3, 'a late fill sends nothing more');
  // release (leaving): held plies go at once
  ob.hold(a, 'a2'); ob.release(a); await w.run();
  assert.equal(w.reqs.at(-1).body.move, 'a2'); assert.equal(w.reqs.at(-1).body.clientVerdict, 'judging');
  console.log('ok hold: a move waiting on the check holds the queue until filled, released or HOLD_MS');
}

// 5. Failures are silent and bounded: backoff, then this page stops; the next load resends (a replay is idempotent).
{
  let down = true;
  const w = world({ answers: () => (down ? 'throw' : 200) });
  const ob = w.make(); ob.setMode('shadow');
  const a = ob.open(P);
  ob.move(a, 'c3'); ob.move(a, 'c4');
  await w.run(600e3);
  assert.equal(w.reqs.length, MAX_FAILS, 'stops after MAX_FAILS failures in a row');
  assert.ok(w.reqs.every((r) => r.body.ply === 0));
  ob.move(a, 'c5'); await w.run(600e3);
  assert.equal(w.reqs.length, MAX_FAILS, 'stopped for the rest of this page');
  assert.equal(w.queue().length, 3, 'kept for the next load');
  down = false;
  const ob2 = w.make(); // a reload of this tab
  await w.run(60e3); assert.equal(w.reqs.length, MAX_FAILS, 'not before the server says shadow again');
  ob2.setMode('shadow'); await w.run();
  assert.deepEqual(w.reqs.slice(MAX_FAILS).map((r) => r.body.ply), [0, 1, 2]);
  assert.equal(w.queue().length, 0);
  console.log('ok failures: backoff, stop after', MAX_FAILS, 'and resend on the next load');
}

// 6. 404 (routes gone: the server turned the judge off) stops at once; 4xx drops that ply; 429 waits its retry-after.
{
  const w = world({ answers: (r, i) => (i === 1 ? 400 : i === 2 ? 429 : i === 4 ? 404 : 200) });
  const ob = w.make(); ob.setMode('shadow');
  const a = ob.open(P);
  for (const m of ['a1', 'a2', 'a3', 'a4']) ob.move(a, m);
  await w.run();
  assert.equal(w.reqs.length, 2, '400 dropped ply 0; ply 1 got 429');
  await w.run(1999); assert.equal(w.reqs.length, 2, 'waits retry-after');
  await w.run(1); assert.equal(w.reqs.length, 4);
  assert.deepEqual(w.reqs.map((r) => r.body.ply), [0, 1, 1, 2]);
  await w.run(600e3);
  assert.equal(w.reqs.length, 4, '404: nothing more');
  assert.equal(ob.open(P), null, '404: no new attempts either');
  console.log('ok answers: 404 stops, 400 drops one ply, 429 waits');
}

// 7. Bounds: at most MAX_ITEMS queued (oldest dropped), MAX_PLY per attempt, MAX_AGE; another player's plies are dropped.
{
  const w = world({ answers: () => 'throw' });
  const ob = w.make(); ob.setMode('shadow');
  let sent = 0;
  for (let i = 0; i < 3; i++) { const a = ob.open(P); for (let j = 0; j < 40; j++) sent += ob.move(a, 'a1') ? 1 : 0; }
  assert.equal(sent, 120); assert.equal(w.queue().length, MAX_ITEMS, 'oldest dropped');
  const big = ob.open(P);
  for (let j = 0; j < MAX_PLY + 10; j++) ob.act(big, 'hint');
  assert.equal(big.n, MAX_PLY, 'MAX_PLY plies per attempt');
  // a sign-out / another player: nothing queued for the old token is sent with the new one
  const w2 = world();
  const o2 = w2.make(); o2.setMode('shadow');
  const a2 = o2.open(P);
  w2.tok = OTHER;
  assert.equal(o2.move(a2, 'a1'), false, 'an attempt opened for another player takes no plies');
  w2.tok = TOKEN; o2.move(a2, 'a1'); w2.tok = OTHER;
  await w2.run();
  assert.equal(w2.reqs.length, 0, 'never sent under another token');
  assert.equal(w2.queue().length, 0, 'dropped');
  // too old
  w2.tok = TOKEN; o2.move(a2, 'a2'); w2.t += MAX_AGE; await w2.run(); assert.equal(w2.reqs.length, 0);
  console.log('ok bounds: queue cap, ply cap, age, owner');
}

// 8. Storage that throws (private mode, quota): memory only; pagehide posts the queue keepalive without waiting.
{
  const w = world({ storage: 'throws', answers: () => 'throw' });
  const ob = w.make(); ob.setMode('shadow');
  const a = ob.open(P);
  ob.move(a, 'a1'); ob.act(a, 'unload');
  ob.pagehide();
  assert.equal(w.reqs.length, 2);
  assert.ok(w.reqs.every((r) => r.init.keepalive === true && r.init.headers.authorization === 'Bearer ' + TOKEN));
  assert.deepEqual(w.reqs.map((r) => r.body.act ?? r.body.move), ['a1', 'unload']);
  console.log('ok storage: memory only when storage throws; pagehide sends keepalive');
}
assert.ok(new Set(Array.from({ length: 200 }, () => newNonce())).size === 200);

// 9. The page: app.js only posts through the outbox.
{
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.equal(app.split("'/api/move'").length, 2, 'app.js names /api/move once: the outbox address');
  console.log('ok page: one outbox address');
}

// 10. The server: judge off (default) -> /api/next and /api/puzzle exactly as before; shadow -> judge: 'shadow' + rev.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-outbox-'));
  const { base, boot, stop } = testServer(dir);
  const get = async (p) => (await fetch(base + p)).json();
  const DB = path.join(dir, 't.db');
  await stop(await boot(DB));
  {
    const db = new DatabaseSync(DB);
    const ins = db.prepare('INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, komi, turn) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const tps = 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14';
    ins.run('pd1', 6, tps, 1, JSON.stringify('win'), 's6', 'PlayTak', 1500, 1500, 2, 1);
    ins.run('pd2', 6, tps, 1, JSON.stringify('win'), 's6', 'PlayTak', 1510, 1510, 2, 1);
    db.prepare("UPDATE puzzles SET rev = 2 WHERE id = 'pd2'").run();
    db.close();
  }
  const shapes = async () => ({ one: await get('/api/next?size=6'), pair: await get('/api/next?size=6&for=pd1'), batch: await get('/api/next?size=6&n=5'), byId: await get('/api/puzzle/pd2') });
  let s = await boot(DB);
  let off;
  try {
    off = await shapes();
    for (const k of ['one', 'pair', 'batch']) assert.ok(!('judge' in off[k]), 'off: no judge field on /api/next ' + k);
    for (const p of [off.one.puzzle, off.pair.win, off.pair.loss, ...off.batch.puzzles, off.byId.puzzle]) if (p) assert.ok(!('rev' in p), 'off: no rev');
    assert.deepEqual(Object.keys(off.one).sort(), ['puzzle']);
    assert.deepEqual(Object.keys(off.pair).sort(), ['loss', 'win']);
    assert.deepEqual(Object.keys(off.batch).sort(), ['puzzles', 'rating']);
    assert.deepEqual(Object.keys(off.byId).sort(), ['puzzle']);
    const r = await fetch(base + '/api/move', { method: 'POST', body: '{}' });
    assert.equal(r.status, 404, 'off: /api/move is an unknown route');
  } finally { await stop(s); }
  for (const mode of ['shadow', 'decide']) {
    s = await boot(DB, { TINUE_JUDGE: mode });
    try {
      const on = await shapes();
      if (mode === 'decide') { for (const k of ['one', 'pair', 'batch', 'byId']) assert.ok(!('judge' in on[k]), 'decide: not advertised to C2 pages'); continue; }
      for (const k of ['one', 'pair', 'batch']) assert.equal(on[k].judge, 'shadow', 'shadow: judge on /api/next ' + k);
      assert.equal(on.byId.puzzle.rev, 2);
      assert.equal(on.byId.judge, 'shadow', 'shadow: judge on /api/puzzle/:id too (a fresh tab on a puzzle link)');
      for (const p of [on.one.puzzle, on.pair.win, on.pair.loss, ...on.batch.puzzles]) assert.ok(Number.isInteger(p.rev));
      // the rest of each puzzle is as with the judge off
      const strip = ({ rev, attempts, ...p }) => p;
      assert.deepEqual(strip(on.byId.puzzle), strip(off.byId.puzzle));
    } finally { await stop(s); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok server: judge off -> no judge, no rev; shadow -> judge: "shadow" and rev; decide -> not advertised');
}
console.log('outbox: all ok');
