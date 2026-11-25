// The C2 comparison report (docs/plan/PLAN.md step C2, gate G1): each shadow attempt (POST /api/move, server/move.js)
// joined to the legacy /api/result row of the same page load, and the two verdicts compared. Read-only.
//
//   node --no-warnings scripts/c2-report.mjs [--db data/tinue.db] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
//
// Range: UTC days, both ends included, on the shadow attempt's open time; default: everything.
//
// The join. A page load sends its result to /api/result and its plies to /api/move, with nothing linking the two (the
// legacy request is left as it is). Both carry the same move timings, though: the page's attempts.log entries
// ({m, ms, k}) and its shadow plies' `ms` come from the same clock (app.js elapsed(); a player move's ms is the very same
// value). A legacy row joins a shadow attempt of the same user and puzzle when every one of its log entries is one of
// the attempt's plies, in order, with the same move or act and ms within ACT_MS. Two tabs on one puzzle do not collide:
// their timings differ. A legacy row with no usable log joins by time only (|ts - opened| <= SLACK_MS) and is flagged.
//
// First (Decision 15), recomputed here. move.js takes `first` when the attempt opens, from whether an `attempts` row
// exists. The page posts its plies on a timer after report() has gone, so for a one-move solve or miss the page's own
// /api/result lands BEFORE the attempt opens and move.js records 'repeat' (would_rate 0) for a first try. The stored
// would_rate / would_why are therefore not used as they stand: the attempt is first unless an `attempts` row of the
// same user and puzzle that is NOT its own joined row was written before it opened, or another shadow attempt of the
// same user and puzzle decided before it did. The judge's stored state (move_attempt.judge) is then re-run through
// shared/judge.js result() with that first.
//
// Prints (user ids only; no names, tokens, nonces or IPs):
//   joins (by log, by time, none) and how many 'repeat's the recomputed first corrected;
//   G1: server rated misses the browser did not rate (must be 0), browser rated misses the server would solve (refund
//   proposals), browser rated misses the server leaves unrated, outcome agreement on the joined pairs, the server's
//   'undecided' count against the browser's pending/judging plies, and 'client-disagree' attempts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { result as judgeResult, isReplyEntry } from '../shared/judge.js';

export const SLACK_MS = 60e3, ACT_MS = 250;
const MOVE_KINDS = new Set(['ok', 'slow', 'miss', 'po']);

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Does legacy log `log` (attempts.log, parsed) fit the shadow plies `plies` ([{ n, move?, act?, ms }] in ply order)?
export function logFits(log, plies) {
  if (!Array.isArray(log) || !log.length) return false;
  let i = 0;
  for (const e of log) {
    if (isReplyEntry(e)) continue; // the defender's replies (logged since 2026-11-21) are no plies of the player's
    if (!e || !Number.isFinite(e.ms)) return false;
    const want = MOVE_KINDS.has(e.k) ? (p) => p.move === e.m : (p) => p.act === e.k;
    while (i < plies.length && !(want(plies[i]) && Number.isFinite(plies[i].ms) && Math.abs(plies[i].ms - e.ms) <= ACT_MS)) i++;
    if (i++ >= plies.length) return false;
  }
  return true;
}

export function compare(db, t0 = 0, t1 = 8.64e15) {
  const atts = db.prepare(`SELECT a.id, a.user_id, a.puzzle_id, a.opened, a.closed, a.state, a.result, a.why, m.judge, m.would_rate, m.would_why
    FROM attempt a JOIN move_attempt m ON m.attempt_id = a.id WHERE a.mode = 'shadow' AND a.opened >= ? AND a.opened < ? ORDER BY a.id`).all(t0, t1);
  const reqs = db.prepare('SELECT n, body FROM move_req WHERE attempt_id = ? ORDER BY n');
  const hasLog = db.prepare('PRAGMA table_info(attempts)').all().some((c) => c.name === 'log');
  const legacy = db.prepare(`SELECT rowid AS rid, win, rated, ts, ${hasLog ? 'log' : 'NULL AS log'} FROM attempts WHERE user_id = ? AND puzzle_id = ? ORDER BY ts`);
  const earlierShadow = db.prepare(`SELECT 1 FROM attempt WHERE mode = 'shadow' AND user_id = ? AND puzzle_id = ? AND id != ? AND state = 'closed'
    AND closed < ? LIMIT 1`);

  const out = {
    attempts: atts.length, decided: 0, joined: { log: 0, time: 0, none: 0 }, repeatCorrected: 0,
    pairs: 0, agree: 0, disagree: 0,
    serverMissBrowserNot: [], // G1: must be empty
    browserMissServerSolved: [], // refund proposals
    browserMissServerUnrated: 0,
    serverUndecided: 0, browserPending: 0, clientDisagree: 0, offTree: 0, whys: {},
  };
  for (const a of atts) {
    const plies = reqs.all(a.id).map((r) => ({ n: r.n, ...(parse(r.body) || {}) }));
    out.browserPending += plies.filter((p) => p.clientVerdict === 'pending' || p.clientVerdict === 'judging').length;
    const rows = legacy.all(a.user_id, a.puzzle_id);
    let mine = rows.find((r) => logFits(parse(r.log), plies)), by = mine ? 'log' : null;
    if (!mine) {
      mine = rows.find((r) => !Array.isArray(parse(r.log)) && Math.abs(r.ts - a.opened) <= SLACK_MS);
      if (mine) by = 'time';
    }
    out.joined[by || 'none']++;
    if (a.state !== 'closed') continue;
    out.decided++;
    const first = !rows.some((r) => r !== mine && r.ts < a.opened) && !earlierShadow.get(a.user_id, a.puzzle_id, a.id, a.closed);
    const st = parse(a.judge);
    const res = st && Array.isArray(st.plies) ? judgeResult({ ...st, first }) : null;
    const rated = res?.state === 'decided' ? res.rated : !!a.would_rate;
    const why = res?.state === 'decided' ? res.unratedWhy ?? null : a.would_why;
    if (a.would_why === 'repeat' && first) out.repeatCorrected++;
    const solved = a.result === 1;
    out.whys[a.why || '?'] = (out.whys[a.why || '?'] || 0) + 1;
    if (a.why === 'undecided' || why === 'undecided') out.serverUndecided++;
    if (a.why === 'client-disagree' || why === 'client-disagree') out.clientDisagree++;
    if (!['tree', 'rules', 'view', 'giveup', 'hint', 'left', 'unload', 'expired'].includes(a.why)) out.offTree++;
    const id = { attempt: a.id, user: a.user_id, puzzle: a.puzzle_id, why: a.why };
    const browserRatedMiss = !!mine && mine.win === 0 && mine.rated === 1;
    if (rated && !solved && !browserRatedMiss) out.serverMissBrowserNot.push({ ...id, legacy: mine ? { win: mine.win, rated: mine.rated } : null });
    if (!mine) continue;
    out.pairs++;
    if ((mine.win === 1) === solved) out.agree++; else out.disagree++;
    if (browserRatedMiss && solved) out.browserMissServerSolved.push(id);
    else if (browserRatedMiss && !rated) out.browserMissServerUnrated++;
  }
  return out;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
  const day = (s, end) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) { console.error('bad date (YYYY-MM-DD): ' + s); process.exit(2); }
    return Date.parse(s + 'T00:00:00Z') + (end ? 86400e3 : 0);
  };
  const db = new DatabaseSync(arg('--db') || path.join(ROOT, 'data', 'tinue.db'), { readOnly: true });
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'move_attempt'").get()) { console.log('no shadow attempts (TINUE_JUDGE has never been on)'); process.exit(0); }
  const r = compare(db, arg('--from') ? day(arg('--from')) : 0, arg('--to') ? day(arg('--to'), true) : 8.64e15);
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
  console.log(`shadow attempts ${r.attempts}, decided ${r.decided}; joined to /api/result by log ${r.joined.log}, by time ${r.joined.time}, none ${r.joined.none}`);
  console.log(`'repeat' corrected to first (result landed before the attempt opened): ${r.repeatCorrected}`);
  console.log(`pairs ${r.pairs}: outcome agrees ${r.agree}, differs ${r.disagree}`);
  console.log(`G1 server rated misses the browser did not rate: ${r.serverMissBrowserNot.length} (must be 0)`);
  for (const x of r.serverMissBrowserNot) console.log(`  a${x.attempt} u${x.user} ${x.puzzle} why=${x.why} legacy=${x.legacy ? `win ${x.legacy.win} rated ${x.legacy.rated}` : 'none'}`);
  console.log(`browser rated misses the server would solve (refund proposals): ${r.browserMissServerSolved.length}`);
  for (const x of r.browserMissServerSolved) console.log(`  a${x.attempt} u${x.user} ${x.puzzle} why=${x.why}`);
  console.log(`browser rated misses the server leaves unrated: ${r.browserMissServerUnrated}`);
  console.log(`off-tree decisions ${r.offTree}; server undecided ${r.serverUndecided} vs browser pending/judging plies ${r.browserPending}; client-disagree ${r.clientDisagree}`);
  console.log('why: ' + Object.entries(r.whys).map(([k, v]) => `${k} ${v}`).join(', '));
}
