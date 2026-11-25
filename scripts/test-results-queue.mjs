// The results queue (public/results.js): kept until the server has a result, one per player and puzzle, never sent under
// another player's token, resent after failures.   node --no-warnings scripts/test-results-queue.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createResults, listOf, keyOf, settles, PREFIX, MAX, MAX_AGE, FRESH_MS } from '../public/results.js';

const storage = (full = false) => { const m = new Map(); return { m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { if (full) throw new Error('full'); m.set(k, String(v)); }, removeItem: (k) => m.delete(k) }; };
function world({ ls = storage(), owner = 'me', answer = () => ({ user: { id: 1 }, rated: true }) } = {}) {
  const w = { ls, t: 1e12, owner, answer, sent: [], done: [], timers: [] };
  w.make = () => createResults({ storage: w.ls, owner: () => w.owner, now: () => w.t, later: (f, ms) => w.timers.push({ at: w.t + ms, f }),
    send: async (e) => { w.sent.push(e); const a = w.answer(e, w.sent.length); if (a === 'net') throw new TypeError('network'); if (typeof a === 'function') return a(); return a; },
    settled: (e, r) => { w.done.push([e, r]); if (r.token) { w.owner = 'new'; w.q.own(); } } });
  w.q = w.make();
  w.run = async (ms) => { const end = w.t + ms; for (let i = 0; i < 500; i++) { await new Promise((r) => setImmediate(r)); w.timers.sort((a, b) => a.at - b.at); if (!w.timers[0] || w.timers[0].at > end) break; const x = w.timers.shift(); w.t = Math.max(w.t, x.at); x.f(); } w.t = end; };
  return w;
}
const rec = (id, o = 'me', extra = {}) => ({ puzzleId: id, body: { puzzleId: id, win: true, ms: 5, ...extra }, b: 7, owner: o, gid: o ? null : 'a'.repeat(32) });

{ // what settles a result
  for (const r of [{ user: {} }, { user: {}, rated: false }, { error: 'bad result' }, { error: 'no such puzzle' }, { error: 'too big' }]) assert.ok(settles(r), JSON.stringify(r));
  for (const r of [null, undefined, '', 'x', {}, { error: 'server error' }, { error: 'Too many requests' }, { error: 'moved' }, { ok: true }, { user: null }]) assert.ok(!settles(r), JSON.stringify(r));
}
{ // stored before it is sent; the first result of a puzzle stands; another page reads the same queue
  const w = world(), a = w.q.add(rec('p1'));
  assert.deepEqual(JSON.parse(w.ls.getItem(PREFIX + 'me.p1')), a); assert.equal(a.b, 7);
  assert.deepEqual(w.q.add(rec('p1', 'me', { win: false })), a, 'a replay never replaces it');
  assert.ok(w.q.has('p1')); assert.ok(!w.q.has('p1', 'you')); assert.deepEqual(w.q.ids(), ['p1']);
  await w.q.flush(); assert.equal(w.sent.length, 1); assert.deepEqual(w.sent[0].body, a.body); assert.equal(w.ls.length, 0);
}
{ // outage: kept through network failures, proxy pages and 5xx; resent with a growing wait; never dropped
  const w = world({ answer: (e, n) => (n === 1 ? 'net' : n === 2 ? { error: 'server error' } : n === 3 ? {} : { user: {} }) });
  w.q.add(rec('p1')); await w.q.flush(); assert.equal(w.ls.length, 1);
  await w.run(4e3); assert.equal(w.sent.length, 1); await w.run(2e3); assert.equal(w.sent.length, 2);
  await w.run(8e3); assert.equal(w.sent.length, 2); await w.run(3e3); assert.equal(w.sent.length, 3);
  await w.run(60e3); assert.equal(w.sent.length, 4); assert.equal(w.ls.length, 0);
  await w.run(1e7); assert.equal(w.sent.length, 4, 'nothing left to send');
}
{ // a failure of the network ends when another call is answered; a 5xx waits for its timer
  let bad = 'net'; const w = world({ answer: () => bad });
  w.q.add(rec('p1')); await w.q.flush(); bad = { user: {} }; w.q.answered(); await w.run(0); assert.equal(w.sent.length, 2); assert.equal(w.ls.length, 0);
  bad = { error: 'server error' }; w.q.add(rec('p2')); await w.q.flush(); w.q.answered(); w.q.answered(); await w.run(0); assert.equal(w.sent.length, 3);
}
{ // 429: the rest is not sent after it, and the wait is at least half a minute
  const w = world({ answer: () => ({ error: 'Too many requests; try again in 60 s.' }) });
  w.q.add(rec('p1')); w.t++; w.q.add(rec('p2')); await w.q.flush(); assert.equal(w.sent.length, 1);
  await w.run(29e3); assert.equal(w.sent.length, 1); assert.equal(w.ls.length, 2);
}
{ // one refused for good goes; one that keeps failing doesn't block the others
  const w = world({ answer: (e) => (e.puzzleId === 'gone' ? { error: 'no such puzzle' } : e.puzzleId === 'bad' ? { error: 'server error' } : { user: {} }) });
  for (const id of ['bad', 'gone', 'p3']) { w.q.add(rec(id)); w.t++; }
  await w.q.flush(); assert.deepEqual(w.q.ids(), ['bad']);
}
{ // another player's results stay put, and go when that player is back
  const w = world(); w.q.add(rec('p1', 'you')); w.q.add(rec('p2')); await w.q.flush();
  assert.deepEqual(w.sent.map((e) => e.puzzleId), ['p2']); w.owner = 'you'; await w.q.flush(); assert.deepEqual(w.sent.map((e) => e.puzzleId), ['p2', 'p1']); assert.equal(w.ls.length, 0);
}
{ // signed out between two sends: the second does not go
  const w = world({ answer: () => { w.owner = ''; return { user: {} }; } }); w.q.add(rec('p1')); w.t++; w.q.add(rec('p2')); await w.q.flush(); assert.equal(w.sent.length, 1); assert.equal(w.ls.length, 1);
}
{ // a visitor without a token: one at a time, and once the first brings a token the rest are that player's
  const w = world({ owner: '', answer: (e, n) => (n === 1 ? { user: {}, token: 't' } : { user: {} }) });
  w.q.add(rec('p1', '')); w.t++; w.q.add(rec('p2', '')); const owners = []; const s0 = w.sent; w.q.flush(); await w.q.flush();
  for (const e of s0) owners.push(e.owner); assert.deepEqual(owners, ['', 'new']); assert.equal(w.ls.length, 0);
}
{ // own(): an entry the player already has for that puzzle stands
  const w = world({ owner: 'me' }); const a = w.q.add(rec('p1', 'me')); w.q.add(rec('p1', '', { win: false })); w.q.own();
  assert.deepEqual(listOf(w.ls, w.t), [a]);
}
{ // report()'s own post in flight is left alone; a page just loaded gives another page's fresh entry time
  const w = world(), a = w.q.add(rec('p1')); w.q.start(a); await w.q.flush(); w.q.answered(); await w.run(0); assert.equal(w.sent.length, 0);
  const other = world({ ls: w.ls }); other.t = w.t + 1000; await other.q.flush(); assert.equal(other.sent.length, 0);
  await other.run(FRESH_MS); assert.equal(other.sent.length, 1); assert.equal(w.ls.length, 0);
}
{ // bounds: MAX (oldest dropped), MAX_AGE, malformed entries removed, foreign keys untouched
  const w = world(); for (let i = 0; i < MAX + 5; i++) { w.q.add(rec('p' + i)); w.t++; } assert.equal(w.q.list().length, MAX); assert.ok(!w.q.has('p0')); assert.ok(w.q.has('p' + (MAX + 4)));
  w.ls.setItem('tinue.token', '"x"'); w.ls.setItem(PREFIX + 'me.zz', '{bad'); w.ls.setItem(PREFIX + 'me.p9', JSON.stringify({ ...rec('p8'), t: w.t })); w.t += MAX_AGE;
  assert.equal(w.q.list().length, 0); assert.deepEqual([...w.ls.m.keys()], ['tinue.token']);
}
{ // no storage, or a full one: add says null and nothing throws
  for (const ls of [null, storage(true)]) { const w = world({ ls }); assert.equal(w.q.add(rec('p1')), null); assert.ok(!w.q.has('p1')); await w.q.flush(); w.q.own(); assert.deepEqual(w.q.ids(), []); }
  assert.equal(keyOf({ owner: '', puzzleId: 'p1' }), 'tinue.r..p1');
}
{ // the page: queued before the post, and the post sends what is queued
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('async function report('), app.indexOf('// A held result once its slow check settles'));
  assert.ok(fn.indexOf('results.add(') > 0 && fn.indexOf('results.add(') < fn.indexOf("api(withBuild('/api/result'"));
  assert.match(fn, /entry\?\.body \?\?/); assert.match(fn, /if \(entry && settles\(r\)\) results\.drop\(entry\);\n {4}if \(r\.token && ours\)/);
  assert.match(fn, /if \(keepalive\) heldRec\.del\(p\.id\)/);
  assert.match(app, /Not sent yet; it will be sent when the server is back\./);
}
console.log('results queue: all ok');
