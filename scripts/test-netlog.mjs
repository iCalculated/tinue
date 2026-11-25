// The client's slow-request reports (public/api.js reportSlow / flushSlow), without a browser: window, document,
// navigator, localStorage and fetch are stubs. Checks the report's fields, the offline queue (cap, flush on success and
// on 'online', no double send, give up after 3 failed flushes, no report about /api/slow) and that nothing throws into
// api() when storage is unavailable.   node scripts/test-netlog.mjs
import assert from 'node:assert/strict';

const listeners = {}, beacons = [], posts = [];
let storage = new Map(), storageBroken = false, net = 'up', slowAnswer = 200;
globalThis.window = { TINUE_API: 'https://api.test', TINUE_BUILD: 1731800000, addEventListener: (k, f) => { listeners[k] = f; } };
globalThis.document = { visibilityState: 'visible' };
const nav = { onLine: true, connection: { effectiveType: '3g', rtt: 450, downlink: 1.2, saveData: false },
  sendBeacon: (url, data) => { beacons.push({ url, data: JSON.parse(data) }); return true; } };
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
globalThis.localStorage = {
  getItem: (k) => { if (storageBroken) throw new Error('SecurityError'); return storage.has(k) ? storage.get(k) : null; },
  setItem: (k, v) => { if (storageBroken) throw new Error('QuotaExceededError'); storage.set(k, String(v)); },
  removeItem: (k) => { if (storageBroken) throw new Error('SecurityError'); storage.delete(k); },
};
// The network: 'up' answers, 'down' fails like a dropped mobile connection (TypeError), 'flaky' fails the first try only.
let flakyLeft = 0;
globalThis.fetch = async (url, opts = {}) => {
  if (url.endsWith('/api/slow')) {
    if (net === 'down') throw new TypeError('Failed to fetch');
    posts.push({ url, opts, data: JSON.parse(opts.body) });
    return { ok: slowAnswer === 200, status: slowAnswer, json: async () => ({}) };
  }
  if (net === 'down' || (net === 'flaky' && flakyLeft-- > 0)) throw new TypeError('Failed to fetch');
  return { ok: true, status: 200, json: async () => ({ fine: true }) };
};

const { api, flushSlow, reportSlow, setToken } = await import('../public/api.js');
const Q = 'tinue.slowq', queue = () => JSON.parse(storage.get(Q) || '[]');
const settle = () => new Promise((r) => setTimeout(r, 10));
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await test('a request that needed a retry is reported live with err, tries, conn, online, sinceOk and build', async () => {
  net = 'flaky'; flakyLeft = 1;
  assert.deepEqual(await api('/api/next?size=6'), { fine: true });
  assert.equal(beacons.length, 1);
  const b = beacons.pop();
  assert.equal(b.url, 'https://api.test/api/slow');
  const { ms, ...rest } = b.data;
  assert.ok(ms >= 0);
  assert.deepEqual(rest, { path: '/api/next', outcome: 'retried', hidden: false, err: 'TypeError', online: true,
    conn: { effectiveType: '3g', rtt: 450, downlink: 1.2, saveData: false }, tries: 2, sinceOk: -1, build: 1731800000 });
  assert.equal(queue().length, 0);
});

await test('a fast call that succeeds sends nothing; sinceOk counts from it', async () => {
  net = 'up';
  await api('/api/me');
  assert.equal(beacons.length + posts.length, 0);
  reportSlow('/api/x?y=1', 2500, 'ok', { tries: 1 });
  const b = beacons.pop().data;
  assert.ok(b.sinceOk >= 0 && b.sinceOk < 1000, String(b.sinceOk));
  assert.equal(b.err, undefined); assert.equal(b.path, '/api/x');
});

await test('a failed call is queued, not sent; the next success flushes it once, with queued', async () => {
  net = 'down';
  await assert.rejects(api('/api/next'), TypeError);
  assert.equal(beacons.length + posts.length, 0);
  assert.equal(queue().length, 1);
  assert.equal(queue()[0].r.outcome, 'failed'); assert.equal(queue()[0].r.err, 'TypeError'); assert.equal(queue()[0].r.tries, 2);
  net = 'up';
  await api('/api/me');
  await settle();
  assert.equal(posts.length, 1);
  const p = posts.pop();
  assert.equal(p.opts.credentials, 'include'); assert.equal(p.opts.keepalive, true);
  assert.deepEqual(p.opts.headers, {}); // signed out: no authorization header
  assert.equal(p.data.batch.length, 1);
  assert.ok(p.data.batch[0].queued >= 0);
  assert.equal(queue().length, 0);
  await api('/api/me'); await settle();
  assert.equal(posts.length, 0, 'sent twice');
});

await test('offline: even an ok-but-slow report waits; the queue keeps the newest 10; the online event flushes it', async () => {
  nav.onLine = false;
  for (let i = 0; i < 14; i++) reportSlow('/api/p' + i, 3000, 'ok', { tries: 1 });
  assert.equal(beacons.length, 0);
  assert.deepEqual(queue().map((e) => e.r.path), Array.from({ length: 10 }, (_, i) => '/api/p' + (i + 4)));
  assert.equal(queue()[0].r.online, false);
  nav.onLine = true;
  listeners.online();
  listeners.online(); // a second event while the first flush is in flight sends nothing more
  await settle();
  assert.equal(posts.length, 1); assert.equal(posts.pop().data.batch.length, 10);
});

await test('a flush that fails puts its reports back, at most 3 times, then drops them', async () => {
  nav.onLine = false; reportSlow('/api/a', 3000, 'ok'); nav.onLine = true;
  slowAnswer = 429;
  for (let i = 0; i < 3; i++) { flushSlow(); await settle(); assert.equal(posts.pop().data.batch.length, 1); assert.equal(queue()[0].n, i + 1); }
  flushSlow(); await settle();
  assert.equal(posts.length, 0); assert.equal(queue().length, 0);
  slowAnswer = 200;
  // a network failure while flushing counts the same way
  nav.onLine = false; reportSlow('/api/b', 3000, 'ok'); nav.onLine = true;
  net = 'down'; flushSlow(); await settle();
  assert.equal(queue().length, 1); assert.equal(queue()[0].n, 1);
  net = 'up'; flushSlow(); await settle();
  assert.equal(posts.pop().data.batch[0].path, '/api/b'); assert.equal(queue().length, 0);
});

await test('queued reports older than a day are dropped; junk in storage is ignored', async () => {
  storage.set(Q, JSON.stringify([{ t: Date.now() - 2 * 86400e3, r: { path: '/old' } }, null, 5, { t: 'x', r: {} }, { t: Date.now(), r: { path: '/new' } }]));
  flushSlow(); await settle();
  assert.deepEqual(posts.pop().data.batch.map((r) => r.path), ['/new']);
  storage.set(Q, '"not an array"');
  await api('/api/me'); await settle();
  assert.equal(posts.length, 0);
  storage.delete(Q);
});

await test('/api/slow itself is never reported; no navigator.connection or onLine (Safari-like): keys omitted', async () => {
  net = 'down';
  await assert.rejects(api('/api/slow', { x: 1 }));
  assert.equal(queue().length, 0);
  net = 'up';
  const c = nav.connection; delete nav.connection; delete nav.onLine; delete window.TINUE_BUILD;
  reportSlow('/api/q', 3000, 'ok', { tries: 1 });
  const b = beacons.pop().data;
  assert.equal('conn' in b, false); assert.equal('online' in b, false); assert.equal('build' in b, false);
  nav.connection = { effectiveType: '4g' }; nav.onLine = true; window.TINUE_BUILD = 1731800000;
  reportSlow('/api/q', 3000, 'ok');
  assert.deepEqual(beacons.pop().data.conn, { effectiveType: '4g' });
  nav.connection = c;
});

await test('storage unavailable: api() still works and never throws from the report; the queue lives in memory', async () => {
  storageBroken = true;
  net = 'down';
  await assert.rejects(api('/api/next'), TypeError); // the request's own error, nothing from the report
  net = 'up';
  assert.deepEqual(await api('/api/me'), { fine: true });
  await settle();
  assert.equal(posts.pop().data.batch[0].outcome, 'failed');
  await api('/api/me'); await settle();
  assert.equal(posts.length, 0);
  storageBroken = false;
});

await test('storage full (writes throw, reads work): a flushed queue is not sent again on every answered call', async () => {
  nav.onLine = false; reportSlow('/api/full', 3000, 'ok'); nav.onLine = true;
  const set = localStorage.setItem; localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  for (let i = 0; i < 3; i++) { await api('/api/me'); await settle(); }
  localStorage.setItem = set;
  assert.equal(posts.length, 1, 'sent ' + posts.length + ' times'); assert.equal(posts.pop().data.batch[0].path, '/api/full');
  assert.equal(queue().length, 0);
});

await test('the token: never in a URL or body; a flush carries it as the Authorization header; a live report never', async () => {
  const sb = nav.sendBeacon; nav.sendBeacon = undefined;
  const tok = 'ab'.repeat(24); setToken(tok);
  reportSlow('/api/z', 2500, 'ok');
  await settle();
  const p = posts.pop();
  assert.equal(p.opts.keepalive, true); assert.equal(p.opts.headers, undefined); assert.equal(p.data.path, '/api/z');
  nav.onLine = false; reportSlow('/api/w', 2500, 'ok'); nav.onLine = true; flushSlow(); await settle();
  const f = posts.pop();
  assert.deepEqual(f.opts.headers, { authorization: 'Bearer ' + tok });
  assert.ok(!JSON.stringify([p, f.url, f.data, beacons]).includes(tok), 'token sent');
  setToken(null);
  nav.sendBeacon = sb;
});

await test('offline: the wait and can\'t-reach notices say so (same kind); online they are unchanged', async () => {
  const m = await import('../public/api.js');
  net = 'down'; nav.onLine = false;
  await assert.rejects(m.api('/api/next'));
  assert.deepEqual(m.notice, { kind: 'net', title: 'You seem to be offline', body: 'Puzzles will load again when your connection is back.' });
  m.setNotice(m.WAIT_NOTICE);
  assert.equal(m.notice.kind, 'wait'); assert.equal(m.notice.title, 'You seem to be offline');
  m.setNotice({ kind: 'none', title: 'No puzzles match', body: '' });
  assert.equal(m.notice.title, 'No puzzles match');
  nav.onLine = true;
  await assert.rejects(m.api('/api/next'));
  assert.equal(m.notice.title, 'Can’t reach the puzzle server');
  m.setNotice(m.WAIT_NOTICE); assert.equal(m.notice, m.WAIT_NOTICE);
  net = 'up'; await m.api('/api/me'); assert.equal(m.notice, null); // cleared by the next answer, as before
  m.setNotice(null); storage.delete(Q); await settle(); posts.length = 0;
});

console.log(`\nOK: ${n} netlog tests`);
