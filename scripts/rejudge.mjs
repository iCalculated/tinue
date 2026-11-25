// Nightly re-judge of the last 7 days' rated misses (docs/plan/PLAN.md §1.3 "Re-judging", invariant I5, step S4).
// PROPOSALS ONLY: it opens the database read-only (and query_only) and writes nothing but its own report files. No
// rating, attempt, attempts, puzzle, book or ply row changes; a refund is still a person running scripts/refund.mjs
// (Sasha, 7a/V17: no automatic refunds).
//
//   node --no-warnings scripts/rejudge.mjs [--db data/tinue.db] [--out data/rejudge] [--days 7] [--cpu-hours 1]
//        [--budgets '[[3e4,2.5e4],…]'] [--now <ISO time>] [--json]
//
// What it re-judges (I5): every rated first miss in the attempt ledger closed in the last --days days whose move was not
// decided by the rules, i.e.
//   'check'   a miss charged with no play-out move after it: on 6×6 the browser's quick threat-only 'no' (F1), off 6×6
//             a completed threat-only 'no' (F3; evidence refuted-threat);
//   'playout' a play-out lost or left after the move (rated by design, §8.2; re-judged because the move may never have
//             been proven, so its cap was capMoves(left) and not provenCap; see capShort).
// Rebuilt from attempts.log with the tree's replies (server/shadow.js missOf), as the S3 shadow does, on the puzzle AS
// THE PLAYER HAD IT (attempt.puzzle_rev, as server/move.js puzzleAt: the live row when its rev matches, else the
// puzzle_rev snapshot, else 'rev-missing' and the miss is not judged). Legacy rows only
// (mode 'legacy'): other modes do not exist before C1 and are counted, not judged.
//
// Evidence that the move wins, cheapest first; the first found is used and nothing more runs for that miss:
//   tree / alt   the puzzle's tree and alts as they are NOW (a later import may have added the move), used only when the
//                live puzzle has the same start and replays the player's log to the same line as the attempt's rev;
//   book         the newest complete book version's row for the position after the move, or a book_node key/win;
//   prover       the browser's own still-wins check (public/engine-worker.js 'still', unchanged) at larger node budgets
//                than the browser's, in this process. A 'wins' here is a proof with every defender reply considered.
// A threat-only search that FINISHED with 'no' says the same at any budget (the search is deterministic): only a
// full-width prover can settle it. On 6×6 that is `deep q=1` at 60 s (plan §1.3), which needs `deep serve` (S2b, not
// built): such misses are listed as 'needs-deep', never as proposals.
//
// Polite: one process, no children. It lowers its own priority (nice 19; on macOS also `taskpolicy -b -p <pid>`,
// background QoS) and stops cleanly once its own CPU time (process.cpuUsage, user + system, not wall clock) would pass
// --cpu-hours (default 1): the report then says partial, and lists what it did not reach. Each search is bounded by its
// node budget, so one job's CPU is bounded; the cap is checked before each job against the largest job so far.
//
// Resumable and idempotent per UTC day: the report goes to <out>/rejudge-YYYY-MM-DD.json (+ .txt), rewritten
// atomically after every search. Each prover verdict is cached under a key of (position, budgets, engine code hash) and
// read back from the last --days days' reports, so a re-run (a second run the same night, the next night over the
// same window) only searches what it has not searched before, and a finished run re-run is free.
//
// Privacy: puzzle ids, ledger attempt ids and user ids only (as in scripts/false-miss-report.mjs); no names, tokens,
// nonces, IPs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { missOf, noKind } from '../server/shadow.js';
import { bookLookup, bookNodeLookup } from '../server/book.js';
import { BUDGETS } from '../server/prover.js';
import { capMoves, provenCap, judge, newAttempt } from '../shared/judge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DAY_MS = 86400e3;
// The browser's budgets first (so a stage that finished there finishes the same way here), then larger ones. Each stage
// is [threat-only nodes, full-defence nodes]; a later stage runs only what an earlier one left unfinished.
export const REJUDGE_BUDGETS = [...BUDGETS, [1e6, 2.5e5], [4e6, 1e6]];
const ENGINE_FILES = ['public/engine-worker.js', 'public/shared/pns.js', 'public/shared/tak.js'];
export function engineHash(root = ROOT) {
  const h = crypto.createHash('sha256');
  for (const f of ENGINE_FILES) { try { h.update(fs.readFileSync(path.join(root, f))); } catch { h.update('missing:' + f); } }
  return h.digest('hex').slice(0, 12);
}
export const cacheKey = (m, budgets, eng) => crypto.createHash('sha256')
  .update(JSON.stringify([m.size, m.komi, m.tps, m.line, m.move, m.solver, budgets, eng])).digest('hex').slice(0, 20);
export const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

// ---- the check, in this process (no child: its CPU is this process's CPU) ----

let worker = null;
// The browser's still-wins check run synchronously here, with the S3 shadow's trace of each df-pn run
// (server/shadow-child.js does the same in its own process). Returns { kind: 'wins'|'no'|'undecided', plies, trace }.
export async function inProcessCheck() {
  if (!worker) {
    const { TinueSearch } = await import('../public/shared/pns.js');
    const st = { reply: null, trace: null };
    const solve = TinueSearch.prototype.solve;
    TinueSearch.prototype.solve = function (p) {
      const rec = st.trace && st.trace.length < 16 ? { n: this.maxNodes, full: !!this.fullDefense } : null;
      try { const ok = solve.call(this, p); if (rec) st.trace.push({ ...rec, r: ok ? 1 : 0 }); return ok; }
      catch (e) { if (rec && e?.message === 'budget') st.trace.push({ ...rec, r: 'budget' }); throw e; }
    };
    globalThis.self ??= {};
    globalThis.self.postMessage = (m) => { if (!m.partial && st.reply) st.reply(m); };
    await import('../public/engine-worker.js');
    const onmessage = globalThis.self.onmessage;
    worker = (req) => {
      let m = null;
      st.reply = (x) => { m = x; }; st.trace = [];
      try { onmessage({ data: { ...req, type: 'still' } }); } finally { st.reply = null; }
      const trace = st.trace; st.trace = null;
      if (!m || m.kind === 'error') return { kind: 'undecided', reason: 'error', trace };
      if (m.kind === 'unknown') return { kind: 'undecided', reason: 'budget', plies: null, trace };
      return { kind: m.kind, plies: m.plies ?? null, ...(m.kind === 'wins' ? { fullDefense: true } : {}), trace };
    };
  }
  return worker;
}

// ---- priority ----

export function beNice({ platform = process.platform, exists = fs.existsSync, run = execFileSync, setPriority = os.setPriority } = {}) {
  const done = [];
  try { setPriority(0, 19); done.push('nice19'); } catch {}
  if (platform === 'darwin' && exists('/usr/sbin/taskpolicy')) {
    try { run('/usr/sbin/taskpolicy', ['-b', '-p', String(process.pid)], { stdio: 'ignore', timeout: 5000 }); done.push('darwin-bg'); } catch {}
  }
  return done;
}
const cpuSeconds = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };

// ---- the scope ----

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

// Rated first misses closed in [t0, t1), newest first (I5's 24 h: tonight's new misses go before older ones), with
// their legacy log and whether a refund already exists.
export function misses(db, t0, t1) {
  if (!hasTable(db, 'attempt')) return null;
  const refunds = hasTable(db, 'rating_event'), mark = db.prepare('PRAGMA table_info(attempts)').all().some((c) => c.name === 'refund');
  return db.prepare(`SELECT a.id, a.user_id, a.puzzle_id, a.mode, a.closed, a.puzzle_rev,
      (SELECT log FROM attempts o WHERE o.user_id = a.user_id AND o.puzzle_id = a.puzzle_id ORDER BY o.ts LIMIT 1) log,
      (SELECT COUNT(*) FROM attempts o WHERE o.user_id = a.user_id AND o.puzzle_id = a.puzzle_id AND ${mark ? '(o.refund IS NOT NULL OR (o.rated = 0 AND o.user_delta <> 0))' : 'o.rated = 0 AND o.user_delta <> 0'}) legacyRefund,
      ${refunds ? "(SELECT COUNT(*) FROM rating_event e WHERE e.attempt_id = a.id AND e.kind = 'refund')" : '0'} refund
    FROM attempt a WHERE a.first = 1 AND a.result = 0 AND a.rated = 1 AND a.closed >= ? AND a.closed < ?
    ORDER BY a.closed DESC, a.id DESC`).all(t0, t1);
}

// Past verdicts from the reports in outDir for the last `days` days (and today's, for a resumed run): key -> pns.
export function loadCache(outDir, now, days) {
  const cache = new Map();
  for (let d = days; d >= 0; d--) {
    const f = path.join(outDir, `rejudge-${utcDay(now - d * DAY_MS)}.json`);
    let r;
    try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const it of r?.items || []) {
      const p = it?.pns;
      // Errors are retried; a search that finished (wins, no) or ran out of its budget is deterministic.
      if (it.key && p && (p.kind === 'wins' || p.kind === 'no' || (p.kind === 'undecided' && p.reason === 'budget'))) cache.set(it.key, p);
    }
  }
  return cache;
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// The run. db: a read-only connection. Options (tests): now, days, cpuCapS, budgets, outDir (null: no files),
// check (async () => (req) => verdict), cpu (seconds used so far), bookVer, engine (code hash).
export async function rejudge(db, { now = Date.now(), days = 7, cpuCapS = 3600, budgets = REJUDGE_BUDGETS, outDir = null,
  check = inProcessCheck, cpu = cpuSeconds, bookVer, engine = engineHash(), priority = [] } = {}) {
  const cpu0 = cpu(), t1 = now, t0 = now - days * DAY_MS, day = utcDay(now);
  const used = () => cpu() - cpu0;
  const rep = { v: 1, day, ranAt: new Date(now).toISOString(), window: { from: new Date(t0).toISOString(), to: new Date(t1).toISOString(), days },
    budgets, engine, priority, cpuCapS, cpuS: 0, partial: false, stopped: null, bookVer: 0,
    counts: { misses: 0, byMode: {}, byHow: {}, bySize: {}, outcome: {} }, proposals: [], refunded: [], needsDeep: [], items: [], note: null };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const file = outDir ? path.join(outDir, `rejudge-${day}.json`) : null;
  const save = () => {
    rep.cpuS = Math.round(used() * 10) / 10;
    if (!file) return;
    fs.mkdirSync(outDir, { recursive: true });
    writeAtomic(file, JSON.stringify(rep, null, 1) + '\n');
    writeAtomic(file.replace(/\.json$/, '.txt'), renderReport(rep));
  };
  const rows = misses(db, t0, t1);
  if (!rows) { rep.note = 'no attempt ledger in this database (step L1 adds it): nothing to re-judge'; save(); return rep; }
  try { rep.bookVer = bookVer ?? (hasTable(db, 'book_ver') ? db.prepare('SELECT MAX(ver) v FROM book_ver').get()?.v ?? 0 : 0); } catch { rep.bookVer = 0; }
  const cache = outDir ? loadCache(outDir, now, days) : new Map();
  const puzzle = db.prepare('SELECT * FROM puzzles WHERE id = ?');
  const snap = hasTable(db, 'puzzle_rev') ? db.prepare('SELECT tree, komi, tps FROM puzzle_rev WHERE id = ? AND rev = ?') : null;
  // The puzzle as of the attempt's rev (server/move.js puzzleAt): live row when the rev matches, else the snapshot.
  const puzzleAt = (p, rev) => {
    if ((p.rev ?? 0) === rev) return p;
    const r = snap?.get(p.id, rev);
    return r ? { id: p.id, size: p.size, tps: r.tps || p.tps, komi: r.komi ?? p.komi ?? 0, tree: r.tree, swing: null } : null;
  };
  let run = null, maxJobS = 0;
  rep.counts.misses = rows.length;

  for (const a of rows) {
    const rev = a.puzzle_rev ?? 0;
    const it = { attempt: a.id, user: a.user_id, puzzle: a.puzzle_id, rev, closed: new Date(a.closed).toISOString() };
    rep.items.push(it);
    bump(rep.counts.byMode, a.mode);
    const done = (outcome) => { it.outcome = outcome; bump(rep.counts.outcome, outcome); };
    if (a.mode !== 'legacy') { done('mode-unsupported'); continue; }
    const p = puzzle.get(a.puzzle_id);
    const pa = p ? puzzleAt(p, rev) : null;
    let m;
    try { m = !p ? { error: 'nopuzzle' } : !pa ? { error: 'rev-missing' } : missOf(pa, a.log); } catch { m = { error: 'replay' }; }
    if (m.error) { it.reason = m.error; done('unreplayable'); continue; }
    if (pa !== p) {
      // A later rev: its tree and alts count only if they reach the very position the player faced.
      it.liveRev = p.rev ?? 0;
      let mNow = null;
      try { mNow = p.tps === pa.tps && (p.komi || 0) === (pa.komi || 0) ? missOf(p, a.log) : null; } catch {}
      if (mNow && !mNow.error && mNow.line.join(' ') === m.line.join(' ') && mNow.move === m.move) { m.inTree ||= mNow.inTree; m.alt ||= mNow.alt; }
    }
    Object.assign(it, { size: m.size, move: m.move, n: m.n, how: m.how });
    bump(rep.counts.byHow, m.how); bump(rep.counts.bySize, m.size);
    if (m.how === 'rules') { done('rules'); continue; } // evidence 'rules': a rated miss by I1, nothing to re-judge

    // The cheap evidence: tree and alts as they are now, then the book.
    let book = null, node = null, says = null;
    if (rep.bookVer > 0) {
      try { book = bookLookup(db, m.pos, rep.bookVer); node = bookNodeLookup(db, m.before, rep.bookVer); says = node?.moves?.[m.move] ?? null; } catch { book = node = null; }
    }
    let kind = m.inTree ? 'tree' : m.alt ? 'alt' : book ? 'book' : says === 'key' || says === 'win' ? 'book-node' : null;
    let pns = null;
    if (!kind && says === 'refuted' && node?.model === 'full') { it.node = { ver: node.ver, model: node.model, says }; done('refuted-full'); continue; }
    if (!kind) {
      it.key = cacheKey(m, budgets, engine);
      if (cache.has(it.key)) { pns = cache.get(it.key); it.cached = true; }
      else {
        const u = used();
        if (u >= cpuCapS || u + maxJobS > cpuCapS) {
          if (!rep.partial) { rep.partial = true; rep.stopped = `cpu cap: ${u.toFixed(1)} s used of ${cpuCapS} s (largest job ${maxJobS.toFixed(1)} s)`; }
          done('not-reached'); continue;
        }
        try {
          run ||= await check();
          const c0 = used();
          pns = await run({ size: m.size, komi: m.komi, tps: m.tps, plies: [...m.line, m.move], attacker: m.solver, budgets });
          const js = used() - c0;
          maxJobS = Math.max(maxJobS, js);
          pns = pns && typeof pns === 'object' ? { ...pns, cpuS: Math.round(js * 100) / 100 } : { kind: 'undecided', reason: 'garbage' };
          if (pns.kind === 'wins' || pns.kind === 'no' || pns.reason === 'budget') cache.set(it.key, pns); // (the same position twice in one run)
        } catch (e) {
          pns = { kind: 'undecided', reason: 'error', error: String(e?.message || e).slice(0, 80) };
        }
      }
      it.pns = { kind: pns.kind, ...(pns.plies != null ? { plies: pns.plies } : {}), ...(pns.reason ? { reason: pns.reason } : {}),
        ...(pns.fullDefense ? { fullDefense: true } : {}), ...(pns.trace ? { trace: pns.trace } : {}), ...(pns.cpuS != null ? { cpuS: pns.cpuS } : {}) };
      if (pns.kind === 'no') it.no = noKind(pns.trace);
      if (pns.kind === 'wins' && pns.fullDefense === true) kind = 'prover';
    }
    if (book) it.book = { ver: book.ver, proof: book.proof, model: book.model, win_len: book.win_len, exact: book.exact, checked: book.checked };
    if (says && kind === 'book-node') it.node = { ver: node.ver, model: node.model, says };
    // What shared/judge.js answers today with these inputs (I4: the record of what the evidence means).
    try {
      const r = judge(newAttempt({ size: m.size, komi: m.komi, solver: m.solver }), { n: m.n, move: m.move }, {
        game: null, left: m.left ?? undefined, tree: m.inTree ? { key: true } : undefined,
        book: book ? { pos: book.pos, ver: book.ver, win_len: book.win_len, exact: book.exact, checked: book.checked } : null,
        node: node && says ? { pos: node.pos, ver: node.ver, model: node.model, refuted: says === 'refuted' } : null,
        pns: pns && (pns.kind === 'wins' || pns.kind === 'no') ? pns : { kind: 'undecided', reason: pns?.reason || 'skipped' },
      });
      it.judge = { verdict: r.verdict, ...(r.proven != null ? { proven: r.proven } : {}) };
    } catch (e) { it.judge = { error: String(e?.message || e).slice(0, 80) }; }

    if (kind) {
      it.evidence = kind;
      const proofPlies = kind === 'prover' ? pns.plies : book?.win_len ?? null;
      // A play-out loss on a move that wins: rated by design (§8.2) when the player had the proven cap; 'review' then,
      // and capShort says whether the cap the client gave an unproven move (capMoves) fell short of the proof's.
      const capShort = m.how === 'playout' && m.left != null && proofPlies != null ? provenCap(m.left, proofPlies) > capMoves(m.left) : null;
      const strength = m.how === 'check' ? 'refund' : 'review';
      const prop = { attempt: a.id, user: a.user_id, puzzle: a.puzzle_id, rev, move: m.move, size: m.size, how: m.how, evidence: kind, strength,
        closed: it.closed, ...(proofPlies != null ? { proofPlies } : {}), ...(capShort != null ? { capShort } : {}) };
      if (a.refund || a.legacyRefund) { done('already-refunded'); rep.refunded.push(prop); }
      else {
        prop.command = `node --no-warnings scripts/refund.mjs --db <db> --attempt ${a.id} --why "rejudge ${day}: ${kind}"`;
        // The book row a later publish could add (plan §1.3: "A proof inserts a rejudge book row"; not inserted here).
        if (kind === 'prover') prop.bookRow = { pos: m.pos, proof: 'rejudge', model: 'threat', win_len: pns.plies ?? null, exact: 0, checked: 0, puzzle_id: a.puzzle_id };
        done('proposal');
        rep.proposals.push(prop);
      }
    } else if (pns?.kind === 'no') {
      // A finished threat-only 'no' (or one after a full-defence refutation): only a full-width prover settles it.
      done(it.no === 'threat-finished' ? 'needs-deep' : 'no');
      if (it.no === 'threat-finished') rep.needsDeep.push({ attempt: a.id, puzzle: a.puzzle_id, rev, move: m.move, size: m.size, how: m.how });
    } else if (pns) done('undecided');
    if (pns && !it.cached) save(); // checkpoint after every search
  }
  save();
  return rep;
}

// ---- rendering ----

// Outcomes that settle nothing: the miss was neither shown winning nor shown lost by a full-width search.
export const UNVERIFIED = new Set(['needs-deep', 'undecided', 'not-reached', 'unreplayable', 'mode-unsupported', 'no']);

export function renderReport(r) {
  const L = [];
  const kv = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  L.push(`rejudge ${r.day}: PROPOSALS ONLY, nothing applied; unverified ${r.items.filter((i) => UNVERIFIED.has(i.outcome)).length}`);
  L.push(`window ${r.window.from} .. ${r.window.to} (${r.window.days} days, attempt.closed); book v${r.bookVer}; engine ${r.engine}`);
  L.push(`cpu ${r.cpuS} s of a ${r.cpuCapS} s cap${r.partial ? ` — PARTIAL (${r.stopped})` : ''}; priority ${r.priority?.join(' ') || 'unchanged'}`);
  if (r.note) L.push(r.note);
  L.push('');
  L.push(`rated first misses: ${r.counts.misses} (modes: ${kv(r.counts.byMode)})`);
  L.push(`  how decided: ${kv(r.counts.byHow)}; sizes: ${Object.entries(r.counts.bySize).map(([k, v]) => `${k}×${k} ${v}`).join(', ') || 'none'}`);
  L.push(`  outcomes: ${kv(r.counts.outcome)}`);
  // Not re-judged at all: G2's "S4 finds no judge-caused false miss" is not met while this is above 0.
  const unv = r.items.filter((i) => UNVERIFIED.has(i.outcome)).length;
  L.push(`  UNVERIFIED: ${unv}${unv ? ' (needs-deep, undecided, not-reached, unreplayable, mode-unsupported: no proof either way; "no false miss found" does not hold for these)' : ''}`);
  L.push('');
  L.push(`proposals (${r.proposals.length}): a person decides; scripts/refund.mjs is a dry run without --apply`);
  for (const p of r.proposals) {
    L.push(`  [${p.strength}] attempt ${p.attempt}  ${p.puzzle}@${p.rev ?? 0}  ${p.move}  ${p.size}×${p.size}  ${p.how}  evidence ${p.evidence}`
      + `${p.proofPlies != null ? `  proof ${p.proofPlies} plies` : ''}${p.capShort != null ? `  capShort ${p.capShort}` : ''}  user ${p.user}  ${p.closed}`);
    if (p.command) L.push(`      ${p.command}`);
  }
  if (r.refunded?.length) {
    L.push(`already refunded (${r.refunded.length}): the re-judge agrees; nothing to do`);
    for (const p of r.refunded) L.push(`  attempt ${p.attempt}  ${p.puzzle}  ${p.move}  evidence ${p.evidence}`);
  }
  L.push('');
  L.push(`needs deep (${r.needsDeep.length}): a finished threat-only 'no'; only a full-width prover (6×6: deep q=1, step S2b) can settle these`);
  for (const d of r.needsDeep) L.push(`  attempt ${d.attempt}  ${d.puzzle}  ${d.move}  ${d.size}×${d.size}  ${d.how}`);
  const nr = r.items.filter((i) => i.outcome === 'not-reached');
  if (nr.length) {
    L.push('');
    L.push(`not reached (${nr.length}): the cpu cap stopped the run; tomorrow's run (or a re-run today) continues from the cache`);
    for (const i of nr) L.push(`  attempt ${i.attempt}  ${i.puzzle}  ${i.move ?? ''}`);
  }
  return L.join('\n') + '\n';
}

// ---- command line ----

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
  const die = (msg) => { console.error('rejudge: ' + msg); process.exit(2); };
  const num = (k, d) => { const v = arg(k); if (v == null) return d; const n = Number(v); if (!(n > 0)) die(`bad ${k}: ${v}`); return n; };
  const dbFile = arg('--db') || path.join(ROOT, 'data', 'tinue.db');
  if (!fs.existsSync(dbFile)) die(`no database at ${dbFile}`);
  let budgets = REJUDGE_BUDGETS;
  if (arg('--budgets')) {
    try { budgets = JSON.parse(arg('--budgets')); } catch { die('bad --budgets (JSON [[threat, full], …])'); }
    if (!Array.isArray(budgets) || !budgets.length || !budgets.every((b) => Array.isArray(b) && b.length === 2 && b.every((x) => Number.isFinite(x) && x > 0 && x <= 1e7))) die('bad --budgets');
  }
  let now = Date.now();
  if (arg('--now')) { now = Date.parse(arg('--now')); if (!Number.isFinite(now)) die('bad --now'); }
  const priority = beNice();
  const db = new DatabaseSync(dbFile, { readOnly: true });
  db.exec('PRAGMA query_only = 1');
  const r = await rejudge(db, { now, days: num('--days', 7), cpuCapS: num('--cpu-hours', 1) * 3600, budgets,
    outDir: path.resolve(arg('--out') || path.join(ROOT, 'data', 'rejudge')), priority });
  db.close();
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 1));
  else process.stdout.write(renderReport(r));
}
