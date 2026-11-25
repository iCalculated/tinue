// The off-6×6 prover pool (plan §1.2, step S2a): pns.js in child processes, judging "does this off-tree move still
// force a win?" exactly as the browser does today (public/engine.js checkStill: the same worker code, the same node
// budgets, quick answer at 2.5 s, final search up to 60 s). Used by server/shadow.js, off any route.
//
//   const prover = createProver();
//   const c = prover.still({ size, komi, tps, plies, attacker });
//   await c.quick  // 'wins' | 'no' | 'pending' | 'undecided'
//   await c.final  // { kind: 'wins', plies, fullDefense: true } | { kind: 'no' } | { kind: 'undecided', reason }
//   c.cancel()
//
// I2: every failure is { kind: 'undecided', reason }, never 'no': a timeout, the node budget running out ('budget'), a
// crash, an out-of-memory exit ('oom'), a kill, a full queue, a spawn failure, a malformed request or answer
// ('input', 'garbage'), a cancel or the pool closing. Neither promise ever rejects.
// Modelled on server/syntaks.js: long-lived processes (one search at a time each), niced, retired when idle; a process
// whose search is cut short (timeout, cancel, a bad answer) is killed, and the next job gets a fresh one.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shadow-child.js');
// The browser's budgets (public/engine.js checkStill): [threat-only nodes, full-defence nodes] per stage.
export const BUDGETS = [[3e4, 2.5e4], [1e5, 2.5e4]];
export const QUICK_MS = 2500, MAX_MS = 60e3;
const MAX_NODES = 1e6; // a request asking for more than this per stage is refused ('input')
const KINDS = new Set(['wins', 'no', 'unknown', 'error']);
// A search trace (server/shadow-child.js): each df-pn run of the check in order, { n: node budget, full: every defender
// reply considered, r: 1 proved | 0 disproved | 'budget' ran out }. Passed through as `trace`; anything else is dropped.
const okTrace = (t) => Array.isArray(t) && t.length <= 16
  && t.every((x) => !!x && typeof x === 'object' && Number.isFinite(x.n) && typeof x.full === 'boolean' && [0, 1, 'budget'].includes(x.r));

export function createProver({ procs: POOL = 1, maxQueue = 3, heapMB = 1024, quickMs = QUICK_MS, maxMs = MAX_MS,
  idleMs = 15 * 60e3, nice = 10, cmd = process.execPath, args } = {}) {
  args ||= ['--no-warnings', `--max-old-space-size=${heapMB}`, CHILD];
  const procs = [], queue = [];
  let seq = 0, closed = false;
  const stats = { started: 0, done: 0, undecided: {} };

  function start() {
    let child;
    const p = { child: null, buf: '', err: '', job: null, idle: null, dead: false };
    try { child = p.child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch { return null; }
    stats.started++;
    try { if (nice) os.setPriority(child.pid, nice); } catch {} // (the API comes first; pid undefined if spawn failed)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      p.buf += d;
      if (p.buf.length > 1e6) return fail(p, 'garbage'); // no newline in a megabyte: not our child talking
      let i;
      while (!p.dead && (i = p.buf.indexOf('\n')) >= 0) { const line = p.buf.slice(0, i); p.buf = p.buf.slice(i + 1); onLine(p, line); }
    });
    child.stderr.on('data', (d) => { if (p.err.length < 4096) p.err += d; });
    child.on('exit', (code, sig) => die(p, sig === 'SIGKILL' && p.killedByUs ? p.killedByUs
      : code === 134 || sig === 'SIGABRT' || /heap out of memory|Allocation failed/i.test(p.err) ? 'oom'
      : sig === 'SIGKILL' ? 'killed' : 'crash'));
    child.on('error', () => die(p, 'spawn'));
    child.stdin.on('error', () => {}); // EPIPE after a crash: 'exit' settles it
    procs.push(p);
    return p;
  }

  // The process is gone (or being killed): its job is undecided, queued work gets a fresh process.
  function die(p, reason) {
    if (p.dead) return;
    p.dead = true; clearTimeout(p.idle);
    const i = procs.indexOf(p);
    if (i >= 0) procs.splice(i, 1);
    if (p.job) settle(p.job, { kind: 'undecided', reason });
    p.job = null;
    pump();
  }
  // Kill a process whose answer can't be trusted or waited for; its job gets `reason`.
  function fail(p, reason) {
    if (p.dead) return;
    const j = p.job;
    p.killedByUs = reason;
    if (j) settle(j, { kind: 'undecided', reason });
    try { p.child.kill('SIGKILL'); } catch {}
    die(p, reason);
  }

  function onLine(p, line) {
    const j = p.job;
    let m;
    try { m = JSON.parse(line); } catch { return fail(p, 'garbage'); }
    if (!j || !m || typeof m !== 'object' || m.id !== j.id || !KINDS.has(m.kind)
      || !(m.plies == null || (Number.isInteger(m.plies) && m.plies >= 0))) return fail(p, 'garbage');
    p.job = null; clearTimeout(j.timer);
    const v = m.kind === 'wins' ? { kind: 'wins', plies: m.plies ?? null, fullDefense: true } : m.kind === 'no' ? { kind: 'no' }
      : { kind: 'undecided', reason: m.kind === 'unknown' ? 'budget' : 'error' };
    settle(j, okTrace(m.trace) ? { ...v, trace: m.trace } : v); // (trace: optional, server/shadow-child.js sends one)
    idle(p); pump();
  }

  function idle(p) {
    clearTimeout(p.idle);
    p.idle = setTimeout(() => { if (!p.job && !p.dead) { p.killedByUs = 'idle'; try { p.child.kill('SIGKILL'); } catch {} die(p, 'idle'); } }, idleMs);
    p.idle.unref?.();
  }

  function pump() {
    while (queue.length && !closed) {
      const p = procs.find((x) => !x.job && !x.dead) || (procs.length < POOL ? start() : null);
      if (!p) { if (!procs.length) while (queue.length) settle(queue.shift(), { kind: 'undecided', reason: 'spawn' }); return; }
      run(p, queue.shift());
    }
  }

  function run(p, j) {
    p.job = j; clearTimeout(p.idle);
    j.proc = p;
    j.timer = setTimeout(() => { if (p.job === j) fail(p, 'timeout'); }, j.maxMs);
    try { p.child.stdin.write(JSON.stringify({ id: j.id, ...j.req }) + '\n'); } catch { fail(p, 'crash'); }
  }

  function settle(j, v) {
    if (j.done) return;
    j.done = true; clearTimeout(j.timer); clearTimeout(j.quickT);
    stats.done++;
    if (v.kind === 'undecided') stats.undecided[v.reason] = (stats.undecided[v.reason] || 0) + 1;
    j.resolve(v);
  }

  // pos: { size, komi, tps, plies, attacker } as engine.js gets it (enginePos + attacker).
  function still(pos, { budgets = BUDGETS, quickMs: qMs = quickMs, maxMs: mMs = maxMs } = {}) {
    let resolve;
    const final = new Promise((r) => { resolve = r; });
    const j = { id: ++seq, resolve, done: false, maxMs: mMs };
    const req = request(pos, budgets);
    const quick = Promise.race([final.then((v) => v.kind === 'undecided' ? 'undecided' : v.kind),
      new Promise((r) => { j.quickT = setTimeout(r, qMs, 'pending'); j.quickT.unref?.(); })]);
    if (closed) settle(j, { kind: 'undecided', reason: 'closed' });
    else if (!req) settle(j, { kind: 'undecided', reason: 'input' });
    else if (queue.length >= maxQueue) settle(j, { kind: 'undecided', reason: 'queue' }); // (queue: jobs no process is free for)
    else { j.req = req; queue.push(j); pump(); }
    const cancel = () => {
      if (j.done) return;
      const qi = queue.indexOf(j);
      if (qi >= 0) { queue.splice(qi, 1); return settle(j, { kind: 'undecided', reason: 'cancelled' }); }
      if (j.proc && j.proc.job === j) return fail(j.proc, 'cancelled');
      settle(j, { kind: 'undecided', reason: 'cancelled' });
    };
    return { quick, final, cancel };
  }

  function close() {
    closed = true;
    while (queue.length) settle(queue.shift(), { kind: 'undecided', reason: 'closed' });
    for (const p of [...procs]) { p.killedByUs = 'closed'; try { p.child.kill('SIGKILL'); } catch {} die(p, 'closed'); }
  }

  return { still, close, stats, procs: () => procs.map((p) => p.child.pid) };
}

// A well-formed request, or null. Sizes 3-8, a komi, a TPS or none (the start position), plies as PTN strings, the
// attacker (1 or 2), and budgets [[threat, full], ...] of positive node counts within MAX_NODES.
function request(pos, budgets) {
  if (!pos || typeof pos !== 'object') return null;
  const { size, komi = 0, tps = null, plies = [], attacker } = pos;
  if (!Number.isInteger(size) || size < 3 || size > 8 || !Number.isFinite(komi) || !(tps === null || typeof tps === 'string')) return null;
  if (!Array.isArray(plies) || plies.length > 400 || !plies.every((m) => typeof m === 'string' && m.length < 40)) return null;
  if (attacker !== 1 && attacker !== 2) return null;
  if (!Array.isArray(budgets) || !budgets.length || budgets.length > 8
    || !budgets.every((b) => Array.isArray(b) && b.length === 2 && b.every((x) => Number.isFinite(x) && x > 0 && x <= MAX_NODES))) return null;
  return { size, komi, tps, plies, attacker, budgets };
}
