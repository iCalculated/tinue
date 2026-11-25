// Post-hoc shadow judging of legacy misses (docs/plan/PLAN.md step S3). Dark: nothing a player sees reads it.
//
// When TINUE_JUDGE is shadow (or veto/decide), each rated miss /api/result records the old way is queued here after its
// transaction has committed. Later, one job at a time, the miss move is rebuilt from the attempt's logged moves
// (attempts.log; defender replies from the puzzle's tree) and judged again on the server: the tree and the puzzle's
// alts as they are now, the newest complete book version (book, book_node), and the browser's own still-wins check
// (server/prover.js running server/shadow-child.js, at the browser's budgets, nice 19 and, on macOS, under
// `taskpolicy -b`: background QoS, so it never takes a P-core from the live server). The outcome goes into the ledger
// as one `ply` row of the legacy attempt with src = 'shadow' (n = SHADOW_N0 + the miss's ply index, so it never
// collides with a real ply). scripts/false-miss-report.mjs reads those rows.
//
// It never changes the attempt, the answer, a rating or the answer's timing: legacyMiss() only pushes two ids onto a
// bounded queue (full: dropped and counted) and never throws; the work starts from a timer, after the answer has gone.
// Each job has a hard node budget (the browser's) and a wall-clock cap; every failure (timeout, crash, a broken row,
// a database that is busy) ends the job, is counted, and never reaches the request path. Its write never waits for a
// lock (busy_timeout 0 around it, as checkpoint() does): busy means the job's row is skipped, not that a player waits.
//
// TINUE_JUDGE unset or 'off' (the default): createShadow returns an object whose methods do nothing. No timer, no
// process, no query, no write.
//
// Load: one job at a time; at most one queued job per user; guests (no name) hold at most half the queue; at most
// maxPerHour jobs start in any hour (the rest wait in the queue). So one player (or one guest token) posting misses
// as fast as the rate limit allows costs one queue slot, and the core time per hour is bounded whatever comes in.
//
// Restarts, drops: queued jobs live in memory and are lost on a restart; a dropped job is not queued at all. Both are
// re-found from the log: refind() runs refindDelayMs after startup and then every refindEveryMs (hourly), and queues
// (one per user, oldest first) the legacy rated misses of the last refindHours (TINUE_SHADOW_REFIND_HOURS, default 48)
// that have no shadow row yet. A job that ran writes a row whatever its outcome (even 'na' for a log it cannot
// replay), so nothing is judged twice. Misses from before the ledger existed have no attempt row and cannot be shadowed.
import fs from 'node:fs';
import { bookKey, puzzleStart, treeDepth } from '../shared/book.js';
import { judge, newAttempt } from '../shared/judge.js';
import { bookLookup, bookNodeLookup } from './book.js';
import { createProver, BUDGETS, CHILD } from './prover.js';
import { MODES, judgeMode } from './judge-mode.js';

export const SHADOW_N0 = 10000;
const TASKPOLICY = '/usr/sbin/taskpolicy';
// The shadow's prover child: background QoS on macOS (`taskpolicy -b node …`; nice alone still runs on P-cores and
// slowed the live server about 5× on crux) and nice 19 everywhere.
export function shadowProverOptions({ platform = process.platform, exists = fs.existsSync, jobMs = 20e3 } = {}) {
  const node = ['--no-warnings', '--max-old-space-size=1024', CHILD];
  const bg = platform === 'darwin' && exists(TASKPOLICY);
  return { procs: 1, maxQueue: 1, maxMs: jobMs, idleMs: 60e3, nice: 19,
    cmd: bg ? TASKPOLICY : process.execPath, args: bg ? ['-b', process.execPath, ...node] : node };
}
// TINUE_JUDGE as a mode, parsed in one place for every reader (server/judge-mode.js): trimmed, any case; anything
// unknown is 'off' with one startup warning. shadow, veto and decide all run this re-judge.
export { MODES, judgeMode } from './judge-mode.js';

// ---- the miss, rebuilt from a legacy log (pure; also used by the report) ----

const parseLog = (log) => {
  if (Array.isArray(log)) return log;
  if (typeof log !== 'string') return null;
  try { const v = JSON.parse(log); return Array.isArray(v) ? v : null; } catch { return null; }
};
// The key of node that is move m (canonical PTN, or any spelling g.canon maps to it), or null.
const keyOf = (node, m, g) => {
  if (!node || node === 'win' || typeof node !== 'object') return null;
  if (Object.hasOwn(node, m)) return m;
  let c;
  try { c = g.canon(m); } catch { return null; }
  for (const k of Object.keys(node)) { try { if (g.canon(k) === c) return k; } catch {} }
  return null;
};

// p: the puzzle row (tps, komi, tree, swing, size); log: attempts.log ([{m, ms, k}] as JSON text or parsed).
// The first decisive entry (miss, slow or view) must be a miss; the moves before it are replayed with the tree's
// replies. Returns { error } or
//   { move, line, n, how, playout, solver, size, komi, tps, game, pos, before, left, inTree, alt }
//   line: the plies before the move (player moves and the tree's replies); n = line.length (the move's ply index);
//   how: 'rules' (the move ended the game), 'playout' (play-out moves were logged after it: a lost or left play-out),
//        'check' (neither: the still-wins check said no; on 6×6 that is mostly the quick threat-only 'no', V3, but the
//        log cannot tell it from a play-out lost or left before the player's first play-out move: the client logs
//        the player's play-out moves ('po') and, since 2026-11-21, the defender's replies ('po' marked: judge.js
//        isReplyEntry), never the play-on's start, so a log with a reply in it is a play-out);
//   game: Game.result() after the move; pos / before: book keys after and before it; left: plies left at the node.
export function missOf(p, log) {
  const entries = parseLog(log);
  if (!entries) return { error: 'log' };
  const i = entries.findIndex((e) => e && (e.k === 'miss' || e.k === 'slow' || e.k === 'view'));
  if (i < 0) return { error: 'nomiss' };
  if (entries[i].k !== 'miss') return { error: entries[i].k };
  const move = entries[i].m;
  if (typeof move !== 'string' || !move) return { error: 'log' };
  const playout = entries.slice(i + 1).some((e) => e && e.k === 'po');
  let g, node, swing;
  try { g = puzzleStart(p.tps, p.komi || 0); } catch { return { error: 'tps' }; }
  try { node = typeof p.tree === 'string' ? JSON.parse(p.tree) : p.tree; } catch { return { error: 'tree' }; }
  try { swing = p.swing ? (typeof p.swing === 'string' ? JSON.parse(p.swing) : p.swing) : {}; } catch { swing = {}; }
  const solver = g.toMove, line = [];
  for (const e of entries.slice(0, i)) {
    if (!e || e.k !== 'ok') continue; // hints (an unrated attempt never gets here anyway)
    const k = keyOf(node, e.m, g);
    if (!k || !node[k] || typeof node[k].r !== 'string') return { error: 'offtree' };
    try { const c = g.canon(k); g.play(c); line.push(c); } catch { return { error: 'illegal' }; }
    if (g.result()) return { error: 'ended' };
    try { g.play(node[k].r); line.push(node[k].r); } catch { return { error: 'illegal' }; }
    node = node[k].n;
  }
  const komi = p.komi || 0, before = bookKey(g, komi);
  const alts = (line.length ? swing?.altsAt?.[line.join(' ')] : swing?.alts) || [];
  let canon, alt = false;
  try { canon = g.canon(move); } catch { return { error: 'illegal' }; }
  // An alt matches in any spelling g.canon maps to the move (as tree keys do): stored alts need not be canonical.
  if (Array.isArray(alts)) alt = alts.some((a) => { try { return typeof a === 'string' && g.canon(a) === canon; } catch { return false; } });
  try { g.play(canon); } catch { return { error: 'illegal' }; }
  const game = g.result();
  let left = null;
  try { left = node === 'win' ? 1 : node && typeof node === 'object' ? treeDepth(node) : null; } catch {} // (a malformed tree)
  return {
    move: canon, line, n: line.length, how: game ? 'rules' : playout ? 'playout' : 'check', playout, solver,
    size: p.size, komi, tps: p.tps, game, pos: game ? null : bookKey(g, komi), before,
    left,
    inTree: !!keyOf(node, canon, g), alt,
  };
}

// What stopped a 'no' (V3), from the shadow check's trace: 'threat-finished' (the first threat-only search finished
// with no win), 'threat-budget' (it ran out of budget and a later stage said no), 'full-defence' (the threat search
// proved a win the full-defence check then refuted), 'not-no' (the check did not say no), 'unrecorded' (no trace).
export function noKind(trace) {
  if (!Array.isArray(trace) || !trace.length) return 'unrecorded';
  if (trace[trace.length - 1].r !== 0) return 'not-no';
  if (!trace[0].full && trace[0].r === 0) return 'threat-finished';
  if (!trace[0].full && trace[0].r === 'budget') return 'threat-budget';
  return 'full-defence';
}

// ---- the queue ----

const OFF = Object.freeze({ mode: 'off', legacyMiss() {}, refind() { return 0; }, whenIdle: () => Promise.resolve(), close() {}, stats: Object.freeze({}) });
const envHours = () => { const h = Number(process.env.TINUE_SHADOW_REFIND_HOURS); return Number.isFinite(h) && h > 0 ? h : 48; };

// db: the server's connection (writes from another connection would make pool.js reload every puzzle).
// Options (tests): mode, maxQueue, gapMs (pause before each job), jobMs (a job's search cap), timers, prover (a factory
// returning { still, close }), now, refindHours, refindDelayMs, refindEveryMs, maxPerHour, bookVer (default: the newest
// complete version).
export function createShadow(db, { mode = judgeMode(), maxQueue = 32, gapMs = 1000, jobMs = 20e3, timers = globalThis,
  prover: makeProver, now = Date.now, refindHours, refindDelayMs = 30e3, refindEveryMs = 3600e3, maxPerHour = 60, bookVer } = {}) {
  if (!MODES.has(mode) || mode === 'off') return OFF;
  refindHours ??= envHours();
  const queue = [], waiters = [], starts = [];
  const stats = { mode, queued: 0, dropped: 0, droppedWhy: {}, ran: 0, written: 0, skipped: {}, failed: {}, verdicts: {} };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  let running = false, timer = null, closed = false, pool = null, warned = false;
  const fail = (why, e) => {
    bump(stats.failed, why);
    if (!warned) { warned = true; console.error(`shadow: ${why}: ${e?.message || e} (further failures only counted)`); }
  };
  makeProver ||= () => createProver(shadowProverOptions({ jobMs }));

  let st = null;
  const sql = () => st ||= {
    attempt: db.prepare("SELECT id FROM attempt WHERE user_id = ? AND puzzle_id = ? AND first = 1 AND mode = 'legacy' AND result = 0 AND rated = 1"),
    has: db.prepare("SELECT 1 FROM ply WHERE attempt_id = ? AND src = 'shadow' LIMIT 1"),
    log: db.prepare('SELECT log FROM attempts WHERE user_id = ? AND puzzle_id = ? ORDER BY ts LIMIT 1'),
    puzzle: db.prepare('SELECT id, size, tps, komi, tree, swing FROM puzzles WHERE id = ?'),
    ver: db.prepare('SELECT MAX(ver) v FROM book_ver'),
    insert: db.prepare("INSERT OR IGNORE INTO ply (attempt_id, n, by, move, src, verdict, evidence, ts) VALUES (?, ?, 'p', ?, 'shadow', ?, ?, ?)"),
    busy: db.prepare('PRAGMA busy_timeout'),
    refind: db.prepare(`SELECT a.user_id, a.puzzle_id, MIN(a.id) id, u.name IS NULL guest FROM attempt a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.mode = 'legacy' AND a.first = 1 AND a.result = 0 AND a.rated = 1
      AND a.closed >= ? AND NOT EXISTS (SELECT 1 FROM ply y WHERE y.attempt_id = a.id AND y.src = 'shadow') GROUP BY a.user_id ORDER BY guest, id LIMIT ?`),
  };

  function schedule() {
    if (running || timer || closed || !queue.length) {
      if (!running && !timer && !queue.length) while (waiters.length) waiters.shift()();
      return;
    }
    timer = timers.setTimeout(pump, gapMs);
    timer?.unref?.();
  }
  async function pump() {
    timer = null;
    if (running || closed) return;
    if (!queue.length) return schedule();
    const t = now();
    while (starts.length && starts[0] <= t - 3600e3) starts.shift();
    if (starts.length >= maxPerHour) { // the hour's budget is spent: wait (jobs stay queued) until the oldest start ages out
      timer = timers.setTimeout(pump, starts[0] + 3600e3 - t + 1); timer?.unref?.();
      bump(stats.skipped, 'hourly'); return;
    }
    const j = queue.shift();
    starts.push(t);
    running = true;
    try { await runJob(j); } catch (e) { fail('job', e); } finally { running = false; schedule(); }
  }

  const drop = (why) => { stats.dropped++; bump(stats.droppedWhy, why); };
  // A rated legacy miss of (userId, puzzleId) just committed; guest: the user has no name. O(maxQueue), never throws.
  // A drop is re-found by the next refind.
  function legacyMiss(userId, puzzleId, guest = false) {
    try {
      if (closed) return;
      if (queue.length >= maxQueue) return drop('full');
      if (queue.some((j) => j.userId === userId)) return drop('user'); // one queued job per user
      if (guest && queue.filter((j) => j.guest).length >= Math.max(1, maxQueue >> 1)) return drop('guests');
      queue.push({ userId, puzzleId, guest: !!guest }); stats.queued++;
      schedule();
    } catch (e) { try { fail('enqueue', e); } catch {} }
  }

  // Queue the recent legacy rated misses that have no shadow row (lost to a restart or dropped), the oldest of each
  // user, named players first. Returns how many rows it offered (some may be dropped by the caps; the next run retries).
  function refind(hours = refindHours) {
    try {
      if (closed) return 0;
      const room = maxQueue - queue.length;
      if (room <= 0) return 0;
      const rows = sql().refind.all(now() - hours * 3600e3, room);
      for (const r of rows) legacyMiss(r.user_id, r.puzzle_id, !!r.guest);
      return rows.length;
    } catch (e) { fail('refind', e); return 0; }
  }

  function write(attemptId, n, move, verdict, evidence) {
    if (db.isTransaction) { bump(stats.skipped, 'busy'); return false; } // (never inside someone's transaction)
    let prev = 5000;
    try { prev = sql().busy.get().timeout; } catch {}
    try {
      db.exec('PRAGMA busy_timeout = 0'); // never wait for a lock: busy now, the row is skipped (counted)
      sql().insert.run(attemptId, n, move, verdict, JSON.stringify(evidence), now());
      stats.written++; bump(stats.verdicts, verdict);
      return true;
    } catch (e) {
      if (/busy|locked/i.test(e.message)) bump(stats.skipped, 'busy'); else fail('write', e);
      return false;
    } finally {
      try { db.exec(`PRAGMA busy_timeout = ${Number.isInteger(prev) ? prev : 5000}`); } catch {}
    }
  }

  // The browser's check on the server, capped at jobMs (plus a guard of our own); never rejects.
  async function check(m) {
    let c, t;
    try {
      pool ||= makeProver();
      c = pool.still({ size: m.size, komi: m.komi, tps: m.tps, plies: [...m.line, m.move], attacker: m.solver }, { budgets: BUDGETS, maxMs: jobMs });
      const guard = new Promise((r) => { t = timers.setTimeout(() => r({ kind: 'undecided', reason: 'timeout' }), jobMs + 2000); t?.unref?.(); });
      const v = await Promise.race([Promise.resolve(c.final), guard]);
      if (v?.kind === 'undecided' && v.reason === 'timeout') try { c.cancel?.(); } catch {}
      return v && typeof v === 'object' ? v : { kind: 'undecided', reason: 'garbage' };
    } catch (e) {
      try { c?.cancel?.(); } catch {}
      return { kind: 'undecided', reason: 'error', error: String(e?.message || e).slice(0, 80) };
    } finally { timers.clearTimeout?.(t); }
  }

  async function runJob(j) {
    stats.ran++;
    const q = sql();
    const a = q.attempt.get(j.userId, j.puzzleId);
    if (!a) return bump(stats.skipped, 'noattempt'); // no ledger row (TINUE_LOG=0, or the ledger write failed)
    if (q.has.get(a.id)) return bump(stats.skipped, 'done');
    const t0 = now();
    const p = q.puzzle.get(j.puzzleId);
    let m;
    try { m = p ? missOf(p, q.log.get(j.userId, j.puzzleId)?.log) : { error: 'nopuzzle' }; } catch (e) { m = { error: 'replay' }; }
    if (m.error) return write(a.id, SHADOW_N0, null, 'na', { v: 1, reason: m.error });

    const ev = { v: 1, how: m.how, size: m.size, n: m.n };
    if (m.game) {
      ev.kind = 'rules'; ev.game = m.game;
      return write(a.id, SHADOW_N0 + m.n, m.move, 'rules', ev);
    }
    let book = null, node = null;
    try {
      const ver = bookVer ?? q.ver.get()?.v ?? 0;
      if (ver > 0) { book = bookLookup(db, m.pos, ver); node = bookNodeLookup(db, m.before, ver); }
    } catch (e) { fail('book', e); }
    const nodeSays = node?.moves?.[m.move] ?? null;
    const tc = now();
    const pns = await check(m);
    if (closed) return;
    ev.checkMs = now() - tc; // the server's check time: past the browser's quick answer (2.5 s), the client likely showed a play-on
    ev.pns = { kind: pns.kind, ...(pns.plies != null ? { plies: pns.plies } : {}), ...(pns.reason ? { reason: pns.reason } : {}) };
    if (pns.trace) ev.trace = pns.trace;
    ev.no = pns.kind === 'no' ? noKind(pns.trace) : null;
    if (book) ev.book = { pos: book.pos, ver: book.ver, win_len: book.win_len, exact: book.exact, model: book.model, proof: book.proof, checked: book.checked };
    if (nodeSays) ev.node = { ver: node.ver, model: node.model, says: nodeSays };
    // The evidence that the move wins, strongest first.
    ev.kind = m.inTree ? 'tree' : m.alt ? 'alt' : book ? 'book' : nodeSays === 'key' || nodeSays === 'win' ? 'book-node'
      : pns.kind === 'wins' && pns.fullDefense === true ? 'prover' : pns.kind === 'no' ? 'refuted-threat' : 'undecided';
    const wins = ['tree', 'alt', 'book', 'book-node', 'prover'].includes(ev.kind);
    // What the server-side judge (shared/judge.js) would answer for this move today, for the record.
    try {
      const r = judge(newAttempt({ size: m.size, komi: m.komi, solver: m.solver }), { n: m.n, move: m.move }, {
        game: null, left: m.left ?? undefined, tree: m.inTree ? { key: true } : undefined,
        book: book ? { pos: book.pos, ver: book.ver, win_len: book.win_len, exact: book.exact, checked: book.checked } : null,
        node: node && nodeSays ? { pos: node.pos, ver: node.ver, model: node.model, refuted: nodeSays === 'refuted' } : null,
        pns: pns.kind === 'wins' || pns.kind === 'no' ? pns : { kind: 'undecided', reason: pns.reason },
      });
      ev.judge = { verdict: r.verdict, ...(r.proven != null ? { proven: r.proven } : {}), evidence: r.evidence ?? r.attempt?.plies?.[0]?.evidence ?? null };
    } catch (e) { ev.judge = { error: String(e?.message || e).slice(0, 80) }; }
    ev.ms = now() - t0;
    write(a.id, SHADOW_N0 + m.n, m.move, wins ? 'wins' : pns.kind === 'no' ? 'no' : 'undecided', ev);
  }

  function whenIdle() {
    return new Promise((r) => { waiters.push(r); schedule(); });
  }
  function close() {
    closed = true;
    timers.clearTimeout?.(timer); timer = null; timers.clearTimeout?.(refindT); refindT = null;
    queue.length = 0;
    try { pool?.close(); } catch {}
    while (waiters.length) waiters.shift()();
  }
  let refindT = null;
  const refindLoop = (ms) => {
    if (closed || ms == null || !(ms >= 0)) return;
    refindT = timers.setTimeout(() => { refind(); refindLoop(refindEveryMs); }, ms); refindT?.unref?.();
  };
  refindLoop(refindDelayMs);
  return { mode, legacyMiss, refind, whenIdle, close, stats };
}
