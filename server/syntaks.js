// Syntaks (6x6 NNUE engine by Ciekce and contributors, MIT; github.com/Ciekce/syntaks) as a small pool of long-lived TEI processes.
// The review panel's 6x6 analysis is a server call (the native build here is much stronger than public/syntaks's wasm,
// which only defends play-outs in the browser); Tiltak in the browser stays the fallback.
//
//   const r = await analyze(tps, komi, { signal });  // -> { scoreCp, mate, winProb, wdl, pv, depth, nodes, ms, side }
//   const r = await analyze(tps, komi, { lines: 3 }); // the same fields for line 1, plus
//     lines: [{ move, pv, scoreCp, mate, winProb, wdl, depth }] (best first, ≤ 3), multipv: lines.length > 1
//   A search without `lines` (lines 1: /api/defend, today's clients) sends the same engine commands and returns the
//   same fields as before MultiPV existed. An engine that ignores MultiPV gives one line and multipv: false.
//
// One search at a time per process, so the pool is the CPU budget: POOL x THREADS cores for MOVETIME each.
// TINUE_SYNTAKS_THREADS (default 1): the OVH host runs 2, about the nodes crux searches with 1.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { canonPTN } from '../shared/ptn.js';
import { parseInfo, keepLine, bestLines } from '../shared/tei.js';

const DEFAULT_BIN = os.homedir() + '/syntaks-opt/final/syntaks-final';
export const BIN = process.env.TINUE_SYNTAKS || (fs.existsSync(DEFAULT_BIN) ? DEFAULT_BIN : '');
export const available = () => !!BIN && fs.existsSync(BIN);

const THREADS = Math.min(8, Math.max(1, Math.floor(Number(process.env.TINUE_SYNTAKS_THREADS)) || 1));
const POOL = 2, MOVETIME = 1200, MAX_QUEUE = 12, MAX_PRIORITY = 4, CACHE_MAX = 2000;
const GRACE = 2500; // past MOVETIME: send stop; another GRACE and the process is killed (a wedged search must not block the pool)
const IDLE_MS = 15 * 60e3; // idle processes exit, so a quiet server holds no engine memory

const procs = []; // { child, buf, job, halfKomi, idle }
const queue = []; // jobs: { key, tps, halfKomi, lines, waiters }
const pending = new Map(); // key -> queued or running job, so identical requests share one search
const cache = new Map(); // keyOf(tps, komi, lines) -> result; Map order is insertion order, so re-inserting on a hit makes it an LRU

function start() {
  const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  // mpv: the MultiPV the process searches with (the engine starts at 1, so a lines-1 search never sends it)
  const p = { child, buf: '', job: null, halfKomi: null, mpv: 1, idle: null, dead: false };
  try { os.setPriority(child.pid, 10); } catch {} // nice: puzzle API requests come first
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    p.buf += d;
    let i;
    while ((i = p.buf.indexOf('\n')) >= 0) { const line = p.buf.slice(0, i).trim(); p.buf = p.buf.slice(i + 1); onLine(p, line); }
  });
  const die = (why) => {
    if (p.dead) return;
    p.dead = true;
    const i = procs.indexOf(p);
    if (i >= 0) procs.splice(i, 1);
    finish(p, new Error(why));
    pump(); // queued work gets a fresh process
  };
  child.on('exit', (code, sig) => die(`syntaks exited (${sig || code})`));
  child.on('error', (e) => die('syntaks: ' + e.message));
  child.stdin.on('error', () => {}); // EPIPE after a crash; 'exit' handles it
  send(p, 'tei\nsetoption name Threads value ' + THREADS + '\nsetoption name Hash value 64\nsetoption name MateScores value true\nsetoption name HumanWDL value true');
  procs.push(p);
  return p;
}
const send = (p, s) => { if (!p.dead) p.child.stdin.write(s + '\n'); };

function onLine(p, line) {
  const j = p.job;
  if (!j) return;
  if (line.startsWith('info ')) {
    const info = parseInfo(line);
    if (info) keepLine(j.byIdx, info);
  } else if (line.startsWith('bestmove')) { j.best = line.split(/\s+/)[1] || null; finish(p, null); }
}

// Settle the process's current job (err: the process died or timed out) and hand it the next one.
function finish(p, err) {
  const j = p.job;
  if (!j) return;
  p.job = null;
  clearTimeout(j.stopT); clearTimeout(j.killT);
  if (pending.get(j.key) === j) pending.delete(j.key);
  // A bounded line is from an unfinished iteration; the last complete one is the engine's real opinion (per line).
  const infos = bestLines(j.byIdx);
  const r = !err && infos.length ? shape(infos, j.tps, Date.now() - j.t0, j.best, j.lines) : null;
  if (r && !j.aborted && !j.overran) remember(j.key, r); // a search stopped early is shallower than a full one: don't cache it
  for (const w of j.waiters) {
    w.signal?.removeEventListener('abort', w.onAbort);
    if (r) w.resolve(r); else w.reject(err || new Error('syntaks gave no evaluation'));
  }
  j.waiters.clear();
  if (!p.dead) { pump(); idle(p); }
}

// Engine numbers are from the side to move; the API speaks from White's side, like public/tiltak.js.
// `best` is the engine's own bestmove line: the move it would play (pv[0] can be missing on a stopped search).
// infos: the search's lines, best first (shared/tei.js bestLines). The top level is line 1, as it always was; a
// MultiPV search (lines > 1) adds every line.
function shape(infos, tps, ms, best, lines) {
  const white = tps.split(' ')[1] !== '2', sgn = white ? 1 : -1;
  const line = (info) => {
    const wdl = info.wdl && (white ? info.wdl : info.wdl.slice().reverse());
    const mate = info.mate == null ? null : sgn * info.mate;
    // HumanWDL is calibrated on human games: (win + draw/2) is the side's practical chance. A mate is certain.
    const winProb = mate != null ? (mate > 0 ? 1 : 0) : wdl ? (wdl[0] + wdl[1] / 2) / 1000 : null;
    return { scoreCp: info.cp == null ? null : sgn * info.cp, mate, winProb, wdl, pv: info.pv.slice(0, 12).map(canonPTN) };
  };
  const info = infos[0], top = line(info);
  const r = {
    engine: 'syntaks', side: white ? 'white' : 'black',
    scoreCp: top.scoreCp, mate: top.mate, winProb: top.winProb, wdl: top.wdl,
    pv: top.pv, best: best ? canonPTN(best) : info.pv[0] ? canonPTN(info.pv[0]) : null,
    depth: info.depth, nodes: info.nodes, ms,
  };
  if (lines > 1) {
    r.lines = infos.slice(0, lines).map((x, k) => { const l = line(x); return { move: l.pv[0] ?? (k ? null : r.best), ...l, depth: x.depth }; });
    r.multipv = r.lines.length > 1;
  }
  return r;
}

function remember(key, r) {
  cache.delete(key); cache.set(key, r);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function idle(p) {
  clearTimeout(p.idle);
  // Retiring takes the process out of the pool first, so pump() can't hand it a job while it is quitting.
  if (!p.job) p.idle = setTimeout(() => {
    if (p.job || p.dead) return;
    send(p, 'quit');
    p.dead = true;
    const i = procs.indexOf(p);
    if (i >= 0) procs.splice(i, 1);
    setTimeout(() => p.child.kill(), 1000).unref();
  }, IDLE_MS).unref();
}

// Give queued jobs to free processes, starting new ones up to POOL.
function pump() {
  while (queue.length) {
    const p = procs.find((x) => !x.job && !x.dead) || (procs.length < POOL ? start() : null);
    if (!p) return;
    run(p, queue.shift());
  }
}

function run(p, j) {
  p.job = j; clearTimeout(p.idle);
  j.t0 = Date.now(); j.byIdx = new Map(); j.best = null;
  // Komi changes the evaluation of every position, so the hash from the old komi is cleared with it.
  if (p.halfKomi !== j.halfKomi) { send(p, `setoption name HalfKomi value ${j.halfKomi}\nteinewgame 6`); p.halfKomi = j.halfKomi; }
  // MultiPV is set only when it changes (no teinewgame: the hash stays), so a lines-1 search after a lines-3 one is
  // back at 1, and a process that only ever ran lines-1 searches gets exactly the commands it always got.
  if (p.mpv !== j.lines) { send(p, 'setoption name MultiPV value ' + j.lines); p.mpv = j.lines; }
  send(p, `position tps ${j.tps}\ngo movetime ${MOVETIME}`);
  j.stopT = setTimeout(() => {
    j.overran = true;
    send(p, 'stop');
    j.killT = setTimeout(() => { p.child.kill('SIGKILL'); }, GRACE); // 'exit' then rejects the job and replaces the process
  }, MOVETIME + GRACE);
}

// Cache and sharing key. A lines-1 search keeps the key it always had; a MultiPV search is its own entry (it is
// shallower per line, so it never answers a lines-1 request, nor the other way round).
const keyOf = (tps, komi, lines = 1) => tps + '|' + komi + (lines === 1 ? '' : '|' + lines);

/** Evaluate a validated 6x6 TPS. komi in half-point steps. Rejects with .status 503 when unavailable or busy. */
// priority: a play-on game is waiting on it (/api/defend): queued ahead of review-panel searches, with its own cap.
// lines: 1 to 3 (MultiPV), for the review panel; /api/defend always searches 1.
export function analyze(tps, komi, { signal, priority = false, lines = 1 } = {}) {
  const key = keyOf(tps, komi, lines);
  const hit = cache.get(key);
  if (hit) { remember(key, hit); return Promise.resolve({ ...hit, cached: true }); }
  if (!available()) return Promise.reject(Object.assign(new Error('engine unavailable'), { status: 503 }));
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('aborted'), { status: 499 }));
  // Someone already asked for this position (a daily-puzzle rush): wait for that search instead of queueing another.
  let j = pending.get(key);
  if (!j) {
    const ahead = queue.filter((x) => x.priority).length;
    if (priority ? ahead >= MAX_PRIORITY : queue.length - ahead >= MAX_QUEUE) return Promise.reject(Object.assign(new Error('engine busy'), { status: 503 }));
    j = { key, tps, halfKomi: Math.round(komi * 2), lines, waiters: new Set(), aborted: false, priority };
    pending.set(key, j);
    if (priority) queue.splice(ahead, 0, j); else queue.push(j);
  } else if (priority && !j.priority && queue.includes(j) && queue.filter((x) => x.priority).length < MAX_PRIORITY) {
    // a queued review search a game now waits on moves up (within the priority cap; past it, it waits its turn)
    j.priority = true;
    queue.splice(queue.indexOf(j), 1);
    queue.splice(queue.filter((x) => x.priority).length, 0, j);
  }
  const job = j;
  return new Promise((resolve, reject) => {
    const w = { resolve, reject, signal, priority };
    // This client went away (it moved on to another position). The search goes on while anyone else is waiting
    // for it; once nobody is, drop it if it hasn't started, else cut it short.
    w.onAbort = () => {
      if (!job.waiters.delete(w)) return;
      reject(Object.assign(new Error('aborted'), { status: 499 }));
      if (job.waiters.size) {
        // The game that moved it up has gone and only review searches wait: back behind the games, its slot freed.
        const qi = queue.indexOf(job);
        if (job.priority && qi >= 0 && ![...job.waiters].some((x) => x.priority)) {
          job.priority = false;
          queue.splice(qi, 1);
          queue.splice(queue.filter((x) => x.priority).length, 0, job);
        }
        return;
      }
      job.aborted = true;
      if (pending.get(key) === job) pending.delete(key); // a later request starts a full search, not this cut-short one
      const qi = queue.indexOf(job);
      if (qi >= 0) { queue.splice(qi, 1); return; }
      const p = procs.find((x) => x.job === job);
      if (p) send(p, 'stop');
    };
    signal?.addEventListener('abort', w.onAbort, { once: true });
    job.waiters.add(w);
    pump();
  });
}

// Drop a cached result (the server found its move illegal there: don't serve it again).
export const forget = (tps, komi, lines = 1) => { cache.delete(keyOf(tps, komi, lines)); };
// True when a request for this position costs no new search: a cached result, or a search already under way.
export const cached = (tps, komi, lines = 1) => cache.has(keyOf(tps, komi, lines)) || pending.has(keyOf(tps, komi, lines));

// Don't leave engines behind when the server exits.
process.on('exit', () => { for (const p of procs) try { p.child.kill(); } catch {} });
