// The next-puzzle logic (public/next.js) against fakes: an in-memory store, a clock, and a fake /api/next that picks
// from one fixed pool, nearest first, like the real one (skipping excluded and already-played puzzles).
//   node scripts/test-next.mjs
import assert from 'node:assert/strict';
import { createNext, BATCH, REFILL_AT, DRIFT, NEXT_TTL } from '../public/next.js';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const ids = (ps) => ps.map((p) => p.id);
const KEY = 'normal|6|', WHO = 'tok12345';

// A player and a server. hold: requests wait for answer()/fail() instead of being answered at once.
function world({ settled = true, rating = 1500, queue = null, next = null, hold = false, pool = 200 } = {}) {
  const mem = new Map();
  const store = { get: (k, d) => (mem.has(k) ? JSON.parse(mem.get(k)) : d), set: (k, v) => mem.set(k, JSON.stringify(v)), del: (k) => mem.delete(k) };
  const w = { settled, rating, filters: KEY, player: WHO, current: null, t: 1.8e12, hold, store, calls: [], pending: [], played: new Set() };
  w.pool = Array.from({ length: pool }, (_, i) => ({ id: 'p' + i }));
  if (queue) store.set('queue', { key: KEY, who: WHO, rating: queue.rating ?? rating, at: w.t, puzzles: queue.puzzles });
  if (next) store.set('next', { key: KEY, who: WHO, at: w.t, puzzle: next });
  // The server: nearest-first picks from the pool, never an excluded or played puzzle.
  const pick = (q, n, also = []) => {
    const ex = new Set([...(q.get('exclude') || '').split(',').filter(Boolean), ...also]);
    return w.pool.filter((p) => !ex.has(p.id) && !w.played.has(p.id)).slice(0, n);
  };
  const serve = (q) => {
    if (q.get('n')) return { rating: Math.round(w.rating), puzzles: pick(q, +q.get('n')) };
    if (q.get('for')) { const [a, b] = pick(q, 2, [q.get('for')]); return { win: a, loss: b }; }
    return { puzzle: pick(q, 1)[0] ?? null };
  };
  const get = (path) => new Promise((resolve, reject) => {
    const q = new URL(path, 'http://x').searchParams, call = { path, q, kind: q.get('n') ? 'batch' : q.get('for') ? 'pair' : 'one', resolve, reject };
    w.calls.push(call);
    if (w.hold) w.pending.push(call); else queueMicrotask(() => resolve(serve(q)));
  });
  // answer/fail the oldest held request of a kind (answers are computed now, as the server would)
  w.answer = (kind) => { const i = w.pending.findIndex((c) => !kind || c.kind === kind); assert.ok(i >= 0, 'no held ' + kind); const [c] = w.pending.splice(i, 1); c.resolve(serve(c.q)); };
  w.fail = (kind) => { const i = w.pending.findIndex((c) => !kind || c.kind === kind); assert.ok(i >= 0, 'no held ' + kind); const [c] = w.pending.splice(i, 1); c.reject(new Error('net')); };
  w.n = createNext({
    get, store, now: () => w.t, filterKey: () => w.filters, playerKey: () => w.player, query: () => 'difficulty=normal&size=6',
    settled: () => w.settled, rating: () => w.rating, currentId: () => w.current,
  });
  w.batches = () => w.calls.filter((c) => c.kind === 'batch');
  w.queued = () => ids(store.get('queue', null)?.puzzles || []);
  w.storedNext = () => store.get('next', null)?.puzzle?.id ?? null;
  // The app around it: start a puzzle, report its result, and Next (the prefetched one, else a plain request).
  w.start = (p) => { w.current = p.id; w.n.prefetchPair(p); };
  w.result = (win = true, { usePair = true } = {}) => { w.played.add(w.current); w.n.prefetchNext(win, w.current, usePair); };
  w.nextPuzzle = async () => {
    await flush();
    const r = await w.n.take();
    if (r?.puzzle && r.puzzle.id !== w.current) return r.puzzle;
    return { id: w.pool.find((p) => !w.played.has(p.id) && p.id !== w.current).id, fallback: true }; // loadNext's own request
  };
  // Play `count` puzzles in a row from p; returns the ids played.
  w.run = async (p, count, win = () => true) => {
    const seen = [];
    for (let i = 0; i < count; i++) { seen.push(p.id); w.start(p); await flush(); w.result(win(i)); p = await w.nextPuzzle(); }
    return seen;
  };
  return w;
}
const q10 = (from = 0) => Array.from({ length: BATCH }, (_, i) => ({ id: 'q' + (from + i) }));
const pids = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: 'p' + (from + i) })); // the server's pool, nearest first
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('constants are the agreed ones', () => {
  assert.deepEqual([BATCH, REFILL_AT, DRIFT, NEXT_TTL], [10, 2, 50, 12 * 3600e3]);
});

test('a settled player plays the queue in order, one batch request at REFILL_AT left, appended', async () => {
  const w = world({ queue: { puzzles: q10() } });
  let p = { id: 'p0' };
  for (let i = 0; i < BATCH - REFILL_AT; i++) {
    w.start(p); await flush();
    assert.equal(w.batches().length, 0, `no batch while more than ${REFILL_AT} are queued (puzzle ${i})`);
    w.result(); p = await w.nextPuzzle();
    assert.equal(p.id, 'q' + i);
  }
  // Taking q7 left two: the refill went out then, excluding what's queued, the one taken and the one on the board.
  assert.equal(w.batches().length, 1);
  const ex = w.batches()[0].q.get('exclude').split(',');
  for (const id of ['q8', 'q9', 'q7', w.current]) assert.ok(ex.includes(id), id + ' excluded');
  assert.deepEqual(w.queued().slice(0, 2), ['q8', 'q9'], 'the batch is appended after what was queued');
  assert.equal(w.queued().length, 2 + BATCH);
  assert.equal(w.calls.filter((c) => c.kind === 'pair').length, 0, 'no pair while the queue has puzzles');
});

test('a drift over DRIFT replaces the queue, but only once the new batch has arrived', async () => {
  const w = world({ rating: 1500 + DRIFT + 1, queue: { rating: 1500, puzzles: q10() }, hold: true });
  w.start({ id: 'p0' }); await flush();
  assert.equal(w.batches().length, 1, 'drift noticed at the puzzle start');
  w.result(); await flush();
  assert.deepEqual(w.queued(), ids(q10()).slice(1), 'the old queue is still served while the batch is out');
  const r = await w.n.take();
  assert.equal(r.puzzle.id, 'q0');
  assert.equal(w.batches().length, 1, 'one batch in flight, not two');
  w.answer('batch'); await flush();
  const q = w.store.get('queue');
  assert.equal(q.rating, 1500 + DRIFT + 1);
  assert.equal(q.puzzles.length, BATCH);
  assert.ok(!q.puzzles.some((x) => x.id.startsWith('q')), 'the old puzzles are gone');
});

test('within DRIFT the queue is kept', async () => {
  const w = world({ rating: 1500 + DRIFT, queue: { rating: 1500, puzzles: q10() } });
  w.start({ id: 'p0' }); await flush();
  assert.equal(w.batches().length, 0);
});

test('an empty queue at a puzzle start asks for a batch and the pair', async () => {
  const w = world({ hold: true });
  w.start({ id: 'p0' }); await flush();
  assert.deepEqual(w.calls.map((c) => c.kind).sort(), ['batch', 'pair']);
  assert.equal(w.calls.find((c) => c.kind === 'pair').q.get('for'), 'p0');
});

test('the pair answers when the batch is slow, and the batch fills the queue after', async () => {
  const w = world({ hold: true });
  w.start({ id: 'p0' }); await flush();
  w.answer('pair'); w.result(true); await flush();
  const r = await w.n.take();
  assert.equal(r.puzzle.id, 'p1', 'the win side of the pair');
  assert.equal(w.storedNext(), 'p1');
  w.answer('batch'); await flush();
  assert.deepEqual(w.queued(), ids(pids(BATCH - 1, 2)), 'the batch, less the pair\'s pick (the server picked both)');
});

test('a provisional player gets the pair only, never a batch', async () => {
  const w = world({ settled: false, queue: { puzzles: q10() } });
  const seen = await w.run({ id: 'p0' }, 5, (i) => i % 2 === 0);
  assert.equal(w.batches().length, 0);
  assert.equal(w.calls.filter((c) => c.kind === 'pair').length, 5);
  assert.ok(!seen.some((id) => id.startsWith('q')));
});

test('without a usable pair (hint, lost upload) the next one is asked for after the result', async () => {
  const w = world({ settled: false });
  w.start({ id: 'p0' }); await flush();
  w.result(false, { usePair: false }); await flush();
  assert.deepEqual(w.calls.map((c) => c.kind), ['pair', 'one']);
  assert.equal((await w.n.take()).puzzle.id, 'p1');
});

test('a failed batch is retried on the next take', async () => {
  const w = world({ queue: { puzzles: q10().slice(0, REFILL_AT + 2) }, hold: true });
  w.start({ id: 'p0' }); await flush();
  assert.equal(w.batches().length, 0);
  w.result(); await flush(); // takes q0: REFILL_AT + 1 left
  assert.equal((await w.n.take()).puzzle.id, 'q0');
  w.start({ id: 'q0' }); await flush();
  w.result(); await flush(); // takes q1: REFILL_AT left, the refill goes out
  assert.equal((await w.n.take()).puzzle.id, 'q1');
  assert.equal(w.batches().length, 1);
  w.fail('batch'); await flush();
  assert.equal(w.queued().length, REFILL_AT);
  w.start({ id: 'q1' }); await flush(); // the next puzzle's start tries again
  w.result(); await flush(); // (and the take while it's out doesn't ask twice)
  assert.equal((await w.n.take()).puzzle.id, 'q2');
  assert.equal(w.batches().length, 2, 'retried once');
  w.answer('batch'); await flush();
  assert.equal(w.queued().length, REFILL_AT - 1 + BATCH);
});

test('a failed batch with nothing queued is retried by the take itself', async () => {
  const w = world({ hold: true });
  w.start({ id: 'p0' }); await flush();
  w.fail('batch'); w.fail('pair'); await flush();
  w.result(); await flush(); // the pair came back empty: Next asks on its own, and the batch is asked for again
  assert.equal(w.batches().length, 2);
  w.answer('batch'); await flush();
  assert.equal(await w.n.take(), null);
  assert.equal(w.queued().length, BATCH);
  const p = await w.nextPuzzle();
  w.start(p); await flush();
  assert.equal(w.batches().length, 2, 'the queue is full now: no third batch');
});

test('a filter change drops the queue and the prefetched puzzle', async () => {
  const w = world({ queue: { puzzles: q10() } });
  w.start({ id: 'p0' }); await flush(); w.result(); await flush();
  w.filters = 'hard|6|';
  assert.equal(w.n.take(), null, 'the prefetched one was picked under the old filters');
  w.start({ id: 'p50' }); await flush();
  assert.equal(w.batches().length, 1, 'a fresh batch for the new filters');
  assert.equal(w.calls.filter((c) => c.kind === 'pair').length, 1, 'and the pair, since nothing is queued for them');
  assert.equal(w.store.get('queue').key, 'hard|6|');
  assert.ok(!w.queued().some((id) => id.startsWith('q')));
});

test('a batch that arrives after a filter or player change is dropped', async () => {
  for (const change of [(w) => { w.filters = 'hard|6|'; }, (w) => { w.player = 'other123'; }]) {
    const w = world({ hold: true });
    w.start({ id: 'p0' }); await flush();
    change(w);
    w.answer('batch'); await flush();
    assert.equal(w.store.get('queue', null), null);
  }
});

test('a player change (forgetNext) drops the queue, the stored next and the pair', async () => {
  const w = world({ queue: { puzzles: q10() }, next: { id: 'p9' } });
  w.n.resume();
  w.start({ id: 'p0' }); await flush();
  w.n.forgetNext(); w.player = 'other123';
  assert.equal(w.store.get('queue', null), null);
  assert.equal(w.store.get('next', null), null);
  assert.equal(w.n.take(), null);
  w.settled = false; w.result(); await flush();
  assert.deepEqual(w.calls.map((c) => c.kind), ['one'], 'the pair from before is not used');
});

test('resume: a stored next for this player and filters, under NEXT_TTL', async () => {
  const fresh = world({ next: { id: 'p7' } });
  fresh.n.resume();
  assert.equal((await fresh.n.take()).puzzle.id, 'p7');
  const old = world({ next: { id: 'p7' } });
  old.t += NEXT_TTL; old.n.resume();
  assert.equal(old.n.take(), null);
  const other = world({ next: { id: 'p7' } });
  other.player = 'other123'; other.n.resume();
  assert.equal(other.n.take(), null);
  const stale = world({ queue: { puzzles: q10() } });
  stale.t += NEXT_TTL; stale.start({ id: 'p0' }); await flush();
  assert.equal(stale.batches().length, 1, 'an old queue is re-picked');
});

// Found by scripts/test-next-model.mjs.
test('a queue left behind by a filter switch is gone from storage too (switching back or a reload finds nothing)', async () => {
  const w = world({ queue: { puzzles: q10() }, hold: true });
  w.filters = 'hard|6|';
  w.start({ id: 'p0' }); await flush(); // nothing queued for these filters: batch + pair
  w.result(true, { usePair: false }); await flush(); // (a hint) the take waits on the batch...
  w.fail('batch'); w.fail('pair'); await flush(); // ...which fails
  w.filters = KEY;
  w.start({ id: 'p1' }); await flush();
  assert.ok(!w.queued().some((id) => id.startsWith('q')), 'switching back revived the old queue: ' + w.queued());
  const again = createNext({ get: () => new Promise(() => {}), store: w.store, now: () => w.t, filterKey: () => KEY, playerKey: () => WHO, query: () => '', settled: () => true, rating: () => 1500 });
  again.prefetchPair({ id: 'p2' });
  assert.ok(!(again.queue?.puzzles || []).some((p) => p.id.startsWith('q')), 'a reload revived the old queue');
});
test('a prefetch still finishing after a change of player starts no batch for the new one', async () => {
  const w = world({ hold: true });
  w.start({ id: 'p0' }); await flush(); // settled, empty queue: batch + pair
  w.result(); await flush();
  w.answer('batch'); await flush();
  w.n.forgetNext(); w.player = 'other123'; w.settled = false;
  w.fail('pair'); await flush(); // the old prefetch's fallback used to ask for a batch now
  assert.equal(w.batches().length, 1);
  assert.equal(w.store.get('queue', null), null);
});

// The stored next is the puzzle a reload starts on; the queue is what comes after it. Neither may repeat the other,
// in every order the pair and the batch can come back in.
const noDup = (w, where) => {
  const q = w.queued(), nx = w.storedNext();
  assert.equal(new Set(q).size, q.length, `${where}: the queue repeats a puzzle: ${q}`);
  assert.ok(!nx || !q.includes(nx), `${where}: the stored next ${nx} is also queued: ${q}`);
  assert.ok(!w.current || !q.includes(w.current), `${where}: the puzzle on the board ${w.current} is also queued`);
};
test('no duplicates: empty queue, pair first', async () => {
  const w = world({ hold: true });
  w.start({ id: 'p0' }); await flush();
  w.answer('pair'); w.result(); await flush();
  w.answer('batch'); await flush();
  noDup(w, 'pair then batch');
});
test('no duplicates: empty queue, batch first', async () => {
  const w = world({ hold: true });
  w.start({ id: 'p0' }); await flush();
  w.answer('batch'); w.answer('pair'); await flush();
  w.result(); await flush();
  while (w.pending.length) { w.answer(); await flush(); }
  noDup(w, 'batch then pair');
});
test('no duplicates: drift while the queue is served', async () => {
  const w = world({ rating: 1500 + DRIFT + 1, queue: { rating: 1500, puzzles: pids(BATCH) }, hold: true });
  w.start({ id: 'p100' }); await flush();
  w.result(); await flush();
  w.answer('batch'); await flush();
  noDup(w, 'drift');
});
test('no duplicates: a queued puzzle that Next fetched on its own leaves the queue when it starts', async () => {
  const w = world({ queue: { puzzles: pids(BATCH, 1) } });
  w.start({ id: 'p1' }); await flush();
  noDup(w, 'start');
  assert.equal(w.queued()[0], 'p2');
});
test('no duplicates or repeats over 60 puzzles with drifts, misses and both answer orders', async () => {
  for (const order of ['fifo', 'lifo']) {
    const w = world({ hold: true });
    let p = { id: 'p0' };
    const seen = [];
    for (let i = 0; i < 60; i++) {
      seen.push(p.id);
      w.start(p); await flush();
      if (order === 'lifo') w.pending.reverse();
      while (w.pending.length) { w.answer(); await flush(); }
      const win = i % 7 < 4;
      w.rating += (win ? 1 : -1) * 13;
      w.result(win); await flush();
      while (w.pending.length) { w.answer(); await flush(); }
      noDup(w, `${order} puzzle ${i}`);
      p = await w.nextPuzzle();
    }
    assert.equal(new Set(seen).size, seen.length, `${order}: a puzzle came twice: ${seen}`);
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
if (failed) process.exit(1);
