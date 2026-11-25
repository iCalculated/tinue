// Model checking of the next-puzzle logic (public/next.js): every sequence of events up to a depth (explicit-state,
// bounded), then seeded random walks (property-based), against a fake server and a fake page that does what app.js
// does around next.js. Zero dependencies.
//   node scripts/test-next-model.mjs [depth=6] [runs=3000]
//
// Events: a result (win, loss, hint), Next, a request coming back or failing (the batch, the pair, a plain pick, each
// in the order sent), a filter change, a change of player, a rating jump past DRIFT, a reload.
// Checked after every step:
//   1. no puzzle is served twice to the same player once played;
//   2. a puzzle is only started under the filters and player it was picked for;
//   3. the live queue never holds the puzzle on the board, the stored next one, or the same puzzle twice;
//   4. Next needs no request of its own when something was ready: the queue had puzzles at the result, or the pair
//      for this puzzle came back before Next (a win or loss, filters, player and page unchanged since);
//   5. only a batch arriving adds to or replaces the stored queue; everything else only takes from it (so a drift
//      never empties it before the new batch is in);
//   6. a player change leaves nothing stored.
import { createNext, DRIFT } from '../public/next.js';

const DEPTH = +(process.argv[2] || 6), RUNS = +(process.argv[3] || 3000);
const tick = async () => { for (let i = 0; i < 40; i++) await null; }; // let every promise chain in next.js settle
const SETTLED = { A: true, B: false }; // player A has a settled rating (batch queue), B a provisional one (pair only)
class Violation extends Error {}
const check = (ok, msg) => { if (!ok) throw new Violation(msg); };

class Sim {
  constructor() {
    this.mem = new Map();
    this.store = { get: (k, d) => (this.mem.has(k) ? JSON.parse(this.mem.get(k)) : d), set: (k, v) => this.mem.set(k, JSON.stringify(v)), del: (k) => this.mem.delete(k) };
    this.filters = 'f0'; this.player = 'A'; this.rating = { A: 1500, B: 1500 };
    this.played = { A: new Set(), B: new Set() }; // the server's attempts
    this.cur = null; // { p, reported, ctx }
    this.page = 0; this.fallbacks = 0; this.epoch = 0; // epoch: bumped by a change of filters, player or page
    this.boot();
  }
  boot() {
    this.page++; this.epoch++; this.pending = []; // a reload drops the old page and its requests
    const page = this.page;
    this.n = createNext({
      get: (path) => new Promise((resolve, reject) => {
        const q = new URL(path, 'http://x').searchParams;
        this.pending.push({ kind: q.get('n') ? 'batch' : q.get('for') ? 'pair' : 'one', q, who: this.player, key: this.filters, page, epoch: this.epoch, resolve, reject });
      }),
      store: this.store, now: () => 1.8e12, filterKey: () => this.filters, playerKey: () => this.player, query: () => 'q',
      settled: () => SETTLED[this.player], rating: () => this.rating[this.player], currentId: () => this.cur?.p.id,
    });
    this.n.resume();
  }
  // The server: nearest first from one pool, never an excluded puzzle or one this player has played. Puzzles carry
  // the filters and player they were picked for, so a stale one can be told apart.
  pick(q, who, key, n, also = []) {
    const ex = new Set([...(q.get('exclude') || '').split(',').filter(Boolean), ...also]);
    const out = [];
    for (let i = 0; out.length < n; i++) { const id = 'p' + i; if (!ex.has(id) && !this.played[who].has(id)) out.push({ id, key, who }); }
    return out;
  }
  serve(c) {
    if (c.kind === 'batch') return { rating: this.rating[c.who], puzzles: this.pick(c.q, c.who, c.key, +c.q.get('n')) };
    if (c.kind === 'pair') { const [win, loss] = this.pick(c.q, c.who, c.key, 2, [c.q.get('for')]); return { win, loss }; }
    return { puzzle: this.pick(c.q, c.who, c.key, 1)[0] };
  }
  liveQueue() { const q = this.store.get('queue', null); return q && q.key === this.filters && q.who === this.player ? q.puzzles.map((p) => p.id) : null; }

  events() {
    const ev = [];
    if (this.cur && !this.cur.reported) ev.push('win', 'loss', 'hint');
    if (!this.cur || this.cur.reported) ev.push('next');
    for (const kind of ['batch', 'pair', 'one']) if (this.pending.some((c) => c.kind === kind)) ev.push(kind + '+', kind + '-');
    ev.push('filter', 'player', 'drift', 'reload');
    return ev;
  }
  async start(p) {
    check(p.key === this.filters && p.who === this.player, `stale puzzle ${p.id} (picked for ${p.key}/${p.who}, now ${this.filters}/${this.player})`);
    check(!this.played[this.player].has(p.id), `${p.id} served again to ${this.player} after it was played`);
    this.cur = { p, reported: false };
    this.n.prefetchPair(p);
    await tick();
  }
  async load() { // loadNext: the prefetched one if it's there in time (in flight counts as too late), else its own request
    const pre = this.n.take();
    await tick();
    let r = pre ? await Promise.race([pre, Promise.resolve('late')]) : null;
    if (r === 'late') r = null;
    if (!r?.puzzle || r.puzzle.id === this.cur?.p.id) {
      this.fallbacks++;
      r = { puzzle: this.pick(new URLSearchParams(), this.player, this.filters, 1, this.cur ? [this.cur.p.id] : [])[0] };
    }
    await this.start(r.puzzle);
  }
  async step(e) {
    const before = this.liveQueue(), who0 = this.player, key0 = this.filters;
    if (e === 'win' || e === 'loss' || e === 'hint') {
      const c = this.cur;
      c.ctx = { epoch: this.epoch, queueHad: (this.liveQueue() || []).length > 0 && SETTLED[this.player], usePair: e !== 'hint' };
      c.reported = true;
      this.played[this.player].add(c.p.id);
      this.n.prefetchNext(e === 'win', c.p.id, e !== 'hint');
    } else if (e === 'next') {
      const c = this.cur, ctx = c?.ctx;
      const ready = ctx && ctx.epoch === this.epoch && (ctx.queueHad || (ctx.usePair && c.pairEpoch === this.epoch));
      const f = this.fallbacks;
      await this.load();
      check(!ready || this.fallbacks === f, `Next made its own request although ${ctx?.queueHad ? 'the queue had puzzles' : 'the pair was back'}`);
    } else if (e.endsWith('+') || e.endsWith('-')) {
      const i = this.pending.findIndex((c) => c.kind === e.slice(0, -1)), [c] = this.pending.splice(i, 1);
      if (e.endsWith('+')) {
        // the pair for the puzzle on the board, asked for under today's filters, player and page
        if (c.kind === 'pair' && c.q.get('for') === this.cur?.p.id && c.epoch === this.epoch) this.cur.pairEpoch = this.epoch;
        c.resolve(this.serve(c));
      } else c.reject(new Error('net'));
    } else if (e === 'filter') { this.filters = this.filters === 'f0' ? 'f1' : 'f0'; this.epoch++; await this.load(); } // app.js: loadNext
    else if (e === 'player') { this.n.forgetNext(); this.player = this.player === 'A' ? 'B' : 'A'; this.epoch++; } // the puzzle stays on the board
    else if (e === 'drift') this.rating[this.player] += DRIFT + 10;
    else if (e === 'reload') { this.boot(); this.cur = null; await this.load(); } // the page starts over: no puzzle on the board
    await tick();
    // invariants
    const q = this.liveQueue(), nx = this.store.get('next', null);
    if (q) {
      check(new Set(q).size === q.length, `the queue repeats a puzzle: ${q}`);
      check(!this.cur || !q.includes(this.cur.p.id), `the puzzle on the board ${this.cur?.p.id} is queued: ${q}`);
      check(!nx || nx.key !== this.filters || nx.who !== this.player || !q.includes(nx.puzzle.id), `the stored next ${nx?.puzzle.id} is queued: ${q}`);
    }
    if (e === 'player') check(!this.store.get('queue', null) && !nx, 'a player change left the queue or the next one stored');
    if (!e.startsWith('batch+') && before && q && who0 === this.player && key0 === this.filters) {
      let j = 0; for (const id of before) if (id === q[j]) j++;
      check(j === q.length, `"${e}" changed the queue other than by taking from it: ${before} -> ${q}`);
    }
  }
}

async function runSeq(seq) {
  const sim = new Sim();
  await sim.load();
  for (let i = 0; i < seq.length; i++) {
    const ev = sim.events();
    if (!ev.includes(seq[i])) return { sim, ok: true, stop: i };
    try { await sim.step(seq[i]); } catch (e) { if (e instanceof Violation) return { sim, ok: false, at: i, msg: e.message }; throw e; }
  }
  return { sim, ok: true };
}

// ---- exhaustive, bounded: depth-first over every enabled event, replaying each prefix from scratch ----
let states = 0, failures = [];
async function dfs(seq) {
  const r = await runSeq(seq);
  states++;
  if (!r.ok) { failures.push({ seq: seq.slice(0, r.at + 1), msg: r.msg }); return; }
  if (seq.length >= DEPTH) return;
  for (const e of r.sim.events()) { await dfs([...seq, e]); if (failures.length >= 5) return; }
}
const t0 = Date.now();
await dfs([]);
console.log(`exhaustive to depth ${DEPTH}: ${states} sequences, ${failures.length ? 'FAILED' : 'all invariants hold'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

// ---- seeded random walks, depth 30 ----
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const t1 = Date.now();
let walked = 0;
for (let seed = 1; seed <= RUNS && failures.length < 5; seed++) {
  const rnd = mulberry32(seed), sim = new Sim(), seq = [];
  await sim.load();
  try {
    for (let i = 0; i < 30; i++) {
      const ev = sim.events();
      // weight the app's own flow over the rarer outside events, so walks get deep into the queue
      const w = ev.map((e) => (['filter', 'player', 'reload'].includes(e) ? 0.15 : e === 'drift' ? 0.3 : 1));
      let x = rnd() * w.reduce((a, b) => a + b), k = 0;
      while ((x -= w[k]) > 0) k++;
      seq.push(ev[k]); await sim.step(ev[k]);
    }
    walked++;
  } catch (e) { if (!(e instanceof Violation)) throw e; failures.push({ seed, seq, msg: e.message }); }
}
console.log(`random walks: ${walked} of ${RUNS} seeds x 30 steps clean (${((Date.now() - t1) / 1000).toFixed(1)} s)`);

for (const f of failures) console.log(`FAIL ${f.seed ? 'seed ' + f.seed + ': ' : ''}${f.msg}\n     after: ${f.seq.join(' ')}`);
if (failures.length) process.exit(1);
