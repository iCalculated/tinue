// The prover pool (server/prover.js, plan step S2a).
//   node scripts/test-prover.mjs                      fault injection (1,000 trials) + a few real positions (npm test)
//   node scripts/test-prover.mjs --equiv 1000 [db]    the pool against the browser's own path (public/engine.js checkStill
//                                                     in a Worker, default budgets) on that many positions from a copy
//                                                     of the build DB (default data/tinue.db; read-only)
// Every failure must come out { kind: 'undecided' } (I2): never 'no', never a rejected promise.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createProver, BUDGETS, QUICK_MS, MAX_MS } from '../server/prover.js';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Game } from '../shared/tak.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1]; };
const sh = (script, opts = {}) => createProver({ cmd: '/bin/sh', args: ['-c', script], nice: 0, ...opts });
const POS = { size: 6, komi: 2, tps: 'x6/x6/x6/x6/x6/2,x5 1 2', plies: [], attacker: 1 };

// ---- the browser path: public/engine.js checkStill, its Worker run on worker_threads (heap as large as a tab's) ----
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.Worker = class {
  constructor(url) {
    const boot = `import { parentPort } from 'node:worker_threads';
      globalThis.self = { postMessage: (m) => parentPort.postMessage(m) };
      await import(${JSON.stringify(String(url))});
      parentPort.on('message', (data) => self.onmessage({ data }));`;
    this.w = new NodeWorker(new URL('data:text/javascript,' + encodeURIComponent(boot)), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    this.w.on('message', (data) => this.onmessage?.({ data }));
    this.w.on('error', (e) => this.onerror?.(e));
  }
  postMessage(m) { this.w.postMessage(m); }
  terminate() { this.w.terminate(); }
};
const engine = await import(pathToFileURL(path.join(ROOT, 'public/engine.js')).href);

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };

// ---- fault injection ----
// (The stand-ins `exec` their final sleep, so the SIGKILL the pool sends lands on it: a plain `sleep` left behind one
// orphan per trial, about 535 per run, each alive for 100 s.)
async function faults(N) {
  const t0 = Date.now();
  // [name, make prover, how to break it, expected reason(s)]
  const cases = [
    ['kill', () => sh('while read l; do exec sleep 100; done'), async (P, c) => { await tick(30); process.kill(P.procs()[0], 'SIGKILL'); }, ['killed']],
    ['timeout', () => sh('read l; exec sleep 100', { maxMs: 40 }), null, ['timeout']],
    ['oom exit 134', () => sh('read l; exit 134'), null, ['oom']],
    ['oom abort', () => sh('read l; kill -ABRT $$'), null, ['oom']],
    ['oom message', () => sh('read l; echo "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" >&2; exit 1'), null, ['oom']],
    ['crash', () => sh('read l; exit 1'), null, ['crash']],
    ['crash, half an answer', () => sh(`read l; printf '{"id":1,"kind":"no"'; exit 0`), null, ['crash']],
    ['garbage', () => sh('read l; echo garbage; exec sleep 100'), null, ['garbage']],
    ['garbage: a "no" for another id', () => sh(`read l; echo '{"id":-1,"kind":"no"}'; exec sleep 100`), null, ['garbage']],
    ['garbage: an unknown kind', () => sh(`read l; echo "{\\"id\\":$(echo "$l" | sed 's/^{"id":\\([0-9]*\\).*/\\1/'),\\"kind\\":\\"NO\\"}"; exec sleep 100`), null, ['garbage']],
    ['garbage: bad plies', () => sh(`read l; echo "{\\"id\\":$(echo "$l" | sed 's/^{"id":\\([0-9]*\\).*/\\1/'),\\"kind\\":\\"wins\\",\\"plies\\":-2}"; exec sleep 100`), null, ['garbage']],
    ['budget ("unknown")', () => sh(`read l; echo "{\\"id\\":$(echo "$l" | sed 's/^{"id":\\([0-9]*\\).*/\\1/'),\\"kind\\":\\"unknown\\"}"; exec sleep 100`), null, ['budget']],
    ['worker error', () => sh(`read l; echo "{\\"id\\":$(echo "$l" | sed 's/^{"id":\\([0-9]*\\).*/\\1/'),\\"kind\\":\\"error\\"}"; exec sleep 100`), null, ['error']],
    ['spawn failure', () => createProver({ cmd: '/nonexistent/prover', args: [] }), null, ['spawn']],
    ['cancel while running', () => sh('read l; exec sleep 100'), async (P, c) => { await tick(20); c.cancel(); }, ['cancelled']],
    ['bad request', () => sh('read l; exec sleep 100'), null, ['input'], { size: 6, attacker: 3 }],
  ];
  const tally = {};
  let trials = 0, i = 0;
  // the queue: one process busy, three waiting, the fifth refused at once
  const queueTrial = async () => {
    const P = sh('while read l; do exec sleep 100; done', { maxQueue: 3 });
    const cs = [0, 1, 2, 3, 4].map(() => P.still(POS));
    const v = await cs[4].final;
    check(v.kind === 'undecided' && v.reason === 'queue', 'queue full: ' + JSON.stringify(v));
    P.close();
    for (const c of cs.slice(0, 4)) { const w = await c.final; check(w.kind === 'undecided' && w.reason === 'closed', 'closed: ' + JSON.stringify(w)); }
    tally.queue = (tally.queue || 0) + 1;
  };
  while (trials < N) {
    const batch = [];
    for (let b = 0; b < 25 && trials < N; b++, trials++, i++) {
      if (i % (cases.length + 1) === cases.length) { batch.push(queueTrial()); continue; }
      const [name, make, breakIt, reasons, pos] = cases[i % (cases.length + 1)];
      batch.push((async () => {
        const P = make(), c = P.still(pos || POS);
        if (breakIt) await breakIt(P, c);
        const [v, q] = await Promise.all([c.final, c.quick]);
        check(v.kind === 'undecided' && reasons.includes(v.reason), `${name}: ${JSON.stringify(v)}`);
        check(q === 'undecided' || q === 'pending', `${name}: quick ${q}`);
        // the pool goes on: a fresh process takes the next job (or the same failure again), never a hang
        P.close();
        tally[name] = (tally[name] || 0) + 1;
      })());
    }
    await Promise.all(batch);
  }
  const undecided = Object.values(tally).reduce((a, b) => a + b, 0);
  console.log(`faults: ${undecided} of ${N} trials undecided as expected, ${failures} failures (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log('  ' + Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', '));
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the real child: verdicts, a real kill mid-search, a real out-of-memory exit ----
async function realChild() {
  const P = createProver({ procs: 2 });
  // p880518's key 4b3+31 (wins, 2 plies after it), a quiet 5×5 move and two openings (no)
  const cases = [
    { size: 5, komi: 0, tps: '2,x,2,2C,x/x5/21C,121222,1,1,1/x5/x3,1,x 2 13', plies: ['4b3+31'], attacker: 2 },
    { size: 5, komi: 0, tps: 'x5/x5/x5/1,1,1,x2/2,2,x3 1 4', plies: ['e1'], attacker: 1 },
    POS,
    { size: 4, komi: 0, tps: null, plies: ['a1', 'd4', 'b2'], attacker: 2 },
  ];
  const kinds = [];
  for (const pos of cases) {
    const [mine, theirs] = await Promise.all([P.still(pos).final, browser(pos)]);
    check(same(mine, theirs), `real ${JSON.stringify(pos)}: pool ${JSON.stringify(mine)} browser ${JSON.stringify(theirs)}`);
    kinds.push(mine.kind + (mine.plies != null ? ' ' + mine.plies : ''));
  }
  // kill the real child in the middle of a long search
  const heavy = await heavyPosition();
  if (heavy) {
    const c = P.still(heavy);
    await tick(300);
    for (const pid of P.procs()) process.kill(pid, 'SIGKILL');
    const v = await c.final;
    check(v.kind === 'undecided' && v.reason === 'killed', 'real kill: ' + JSON.stringify(v));
    // a real heap limit: 40 MB cannot hold a full-defence search
    const S = createProver({ heapMB: 40 });
    const o = await S.still(heavy).final;
    check(o.kind === 'undecided' && ['oom', 'crash'].includes(o.reason), 'real oom: ' + JSON.stringify(o));
    S.close();
    console.log(`real child: kill -> ${v.reason}, heap 40 MB -> ${o.reason}`);
  }
  P.close();
  console.log(`real child: ${cases.length} positions match the browser path (${kinds.join(', ')})`);
  check(kinds[0] === 'wins 2', 'p880518 4b3+31 wins in 2');
}
// A position whose search runs for many seconds (pd576590 38... 3b3<, about 27 s on the browser path, ends 'unknown').
const HEAVY = { size: 6, komi: 2, tps: 'x6/1,1,2,2,21,2/x,2,1,2,21,221/2,2212,2,2C,x2/2112S,2,x,1,221,2/2,x,1,1,1,1 2 26', plies: ['3b3<'], attacker: 2 };
const heavyPosition = async () => HEAVY;

// the browser's answer, in the pool's terms
async function browser(pos) {
  const c = engine.checkStill(pos);
  const kind = await c.final;
  return kind === 'wins' ? { kind, plies: c.info.plies ?? null } : { kind };
}
const same = (mine, theirs) => theirs.kind === 'unknown' ? mine.kind === 'undecided'
  : mine.kind === theirs.kind && (theirs.kind !== 'wins' || mine.plies === theirs.plies);

// ---- equivalence on positions from the build DB ----
async function equiv(N, dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let seed = 20261117; const R = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const rows = db.prepare('SELECT id, size, tps, komi, tree, swing FROM puzzles WHERE size != 6 ORDER BY id').all();
  const six = db.prepare('SELECT id, size, tps, komi, tree, swing FROM puzzles WHERE size = 6 ORDER BY id').all();
  db.close();
  const positions = [], seen = new Set();
  // Off-tree moves at a node of the line (what the judge asks about), keys and alts (wins) mixed in, 10% 6×6.
  while (positions.length < N) {
    const pool = R() < 0.1 ? six : rows, r = pool[Math.floor(R() * pool.length)];
    const g = Game.fromTPS(r.tps, r.komi || 0), attacker = g.toMove, plies = [];
    let node = JSON.parse(r.tree);
    while (node && node !== 'win' && R() < 0.4) { const k = Object.keys(node)[0]; if (!node[k]?.r) break; plies.push(k, node[k].r); g.play(k); g.play(node[k].r); node = node[k].n; }
    const legal = g.legalMoves().map((m) => g.moveToPTN(m));
    let alts = [];
    try { alts = plies.length ? [] : JSON.parse(r.swing || '{}').alts || []; } catch {}
    const keys = node && node !== 'win' ? Object.keys(node) : [];
    const roll = R(), cand = roll < 0.25 && keys.length ? keys : roll < 0.45 && alts.length ? alts : legal.filter((m) => !keys.includes(m));
    const mv = cand[Math.floor(R() * cand.length)];
    if (!mv || !legal.includes(g.canon(mv))) continue;
    const u = g.apply(g.parseMove(mv)), over = g.result(); g.undo(u);
    if (over) continue; // the rules decide those (rows 2, 3), never the prover
    const pos = { size: r.size, komi: r.komi || 0, tps: r.tps, plies: [...plies, g.canon(mv)], attacker };
    const k = JSON.stringify(pos);
    if (seen.has(k)) continue;
    seen.add(k); positions.push({ id: r.id, pos });
  }
  const conc = Math.max(1, Math.min(6, os.cpus().length - 2));
  const t0 = Date.now();
  // the browser path first, then the pool (not at once: the 60 s wall clock is the one thing that isn't the budget)
  const ms = [];
  const ref = await mapLimit(positions, conc, async (x) => { const t = Date.now(), r = await browser(x.pos); ms.push([Date.now() - t, x]); return r; });
  const t1 = Date.now();
  const P = createProver({ procs: conc, maxQueue: positions.length });
  const got = await mapLimit(positions, conc, (x) => P.still(x.pos).final);
  P.close();
  const t2 = Date.now();
  const tally = {}; let mism = 0;
  positions.forEach((x, i) => {
    const k = ref[i].kind; tally[k] = (tally[k] || 0) + 1;
    if (!same(got[i], ref[i])) { mism++; console.log('MISMATCH', x.id, JSON.stringify(x.pos.plies), 'browser', JSON.stringify(ref[i]), 'pool', JSON.stringify(got[i])); }
  });
  check(mism === 0, `${mism} mismatches`);
  const slow = ms.sort((a, b) => b[0] - a[0])[0];
  if (slow) console.log(`slowest (browser path, ${slow[0]} ms): ${slow[1].id} ${JSON.stringify(slow[1].pos)}`);
  console.log(`equiv: ${N - mism} of ${N} positions identical (browser: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}; ` +
    `browser ${((t1 - t0) / 1000).toFixed(0)} s, pool ${((t2 - t1) / 1000).toFixed(0)} s at concurrency ${conc}; budgets ${JSON.stringify(BUDGETS)})`);
}
async function mapLimit(xs, k, f) {
  const out = new Array(xs.length); let next = 0;
  await Promise.all(Array.from({ length: k }, async () => { while (next < xs.length) { const i = next++; out[i] = await f(xs[i]); } }));
  return out;
}

// The pool's settings are the browser's (I3): checkStill's defaults in public/engine.js, read from its source, so a
// change on either side fails here; and the child runs niced with the plan's heap limit.
async function pins() {
  const src = fs.readFileSync(path.join(ROOT, 'public/engine.js'), 'utf8');
  const m = /export function checkStill\(pos, \{ quickMs = ([^,]+), maxMs = ([^,]+), budgets = (\[\[.*?\]\]) \}/.exec(src);
  check(!!m, 'engine.js checkStill defaults not found');
  if (m) {
    check(Number(m[1]) === QUICK_MS && Number(m[2]) === MAX_MS, `quick/max ms: engine.js ${m[1]}/${m[2]}, pool ${QUICK_MS}/${MAX_MS}`);
    check(JSON.stringify(JSON.parse(m[3].replace(/(\d+(?:\.\d+)?e\d+)/g, (x) => String(Number(x))))) === JSON.stringify(BUDGETS), `budgets: engine.js ${m[3]}, pool ${JSON.stringify(BUDGETS)}`);
  }
  const P = createProver();
  const c = P.still(POS);
  await tick(200);
  const [pid] = P.procs();
  check(pid && os.getPriority(pid) === 10, 'child niced to 10: ' + (pid && os.getPriority(pid)));
  check(pid && execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).includes('--max-old-space-size=1024'), 'child heap 1024 MB');
  await c.final; P.close();
  console.log('pins: budgets, quick/max ms as engine.js; child niced, 1024 MB heap');
}

const N = arg('--equiv');
if (N) await equiv(+N, arg('--db') || path.join(ROOT, 'data/tinue.db'));
else { await pins(); await faults(+(arg('--faults') || 1000)); await realChild(); }
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
console.log('OK: prover');
process.exit(0); // (the browser path's workers are terminated; nothing else should hold the loop, but don't wait on it)
