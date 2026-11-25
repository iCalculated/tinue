// False-miss candidates and the V3 load estimate (docs/plan/PLAN.md step S3). Read-only: proposes, applies nothing.
//
//   node --no-warnings scripts/false-miss-report.mjs [--db data/tinue.db] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
//     [--all-attempts]   also count V3 from the attempts table (results from before the ledger existed too)
//
// Range: UTC days, both ends included, on the attempt's close time; default: yesterday and today (a daily run).
// Reads the ledger (attempt and its src='shadow' ply rows, written by server/shadow.js), the legacy move log
// (attempts.log) and the puzzles' size/tps/tree (to rebuild the miss without any engine). Prints:
//   1. every legacy rated miss the shadow judge found to be a winning move: puzzle id, move, the evidence kind, user id
//      (no names, tokens, IPs or emails). A candidate needs evidence the shadow can see: the move is a tree key or an
//      alt, the book (newest complete version) holds the position after it, or the browser's own check, re-run at the
//      browser's budgets, proves it. A quiet win none of those proves stays 'no'/'undecided', not a candidate; and a
//      miss from before the ledger existed has no attempt row and is never shadowed;
//   2. how many 6×6 rated misses were decided by a quick threat-only 'no' with no play-out (the V3 load estimate),
//      split by what stopped the search. The client's log does not record that; the shadow judge re-runs the same
//      deterministic check at the same budgets and records its trace, so the split exists only for misses shadowed
//      (TINUE_JUDGE on) and is 'unrecorded' for the rest. The count is an upper bound: the log cannot tell a quick 'no'
//      from a play-out lost or left before the player's first play-out move (the client logs only the player's
//      play-out moves). Where the shadow's check took longer than the browser's quick answer (QUICK_MS), the browser
//      most likely answered 'pending' and showed a play-on: those are split out as 'likely-playout'.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { missOf, noKind, SHADOW_N0 } from '../server/shadow.js';
import { QUICK_MS } from '../server/prover.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
const day = (s, end) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) { console.error('bad date (YYYY-MM-DD): ' + s); process.exit(2); }
  return Date.parse(s + 'T00:00:00Z') + (end ? 86400e3 : 0);
};
const today = new Date().toISOString().slice(0, 10), yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
const from = arg('--from') || yesterday, to = arg('--to') || today;

export function report(db, t0, t1) {
  const misses = db.prepare(`SELECT a.id, a.user_id, a.puzzle_id, a.closed,
      (SELECT log FROM attempts o WHERE o.user_id = a.user_id AND o.puzzle_id = a.puzzle_id ORDER BY o.ts LIMIT 1) log
    FROM attempt a WHERE a.mode = 'legacy' AND a.first = 1 AND a.result = 0 AND a.rated = 1 AND a.closed >= ? AND a.closed < ?
    ORDER BY a.closed, a.id`).all(t0, t1);
  const puzzle = db.prepare('SELECT id, size, tps, komi, tree, swing FROM puzzles WHERE id = ?');
  const shadowOf = db.prepare("SELECT n, move, verdict, evidence FROM ply WHERE attempt_id = ? AND src = 'shadow' AND n >= ? ORDER BY n LIMIT 1");
  const out = { from: t0, to: t1, misses: misses.length, shadowed: 0, verdicts: {}, bySize: {}, candidates: [],
    v3: { quickNo6: 0, split: {}, playout6: 0, rules6: 0, unreplayable6: 0 } };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  for (const a of misses) {
    const p = puzzle.get(a.puzzle_id);
    const size = p?.size ?? '?';
    bump(out.bySize, size);
    const s = shadowOf.get(a.id, SHADOW_N0);
    let ev = null;
    if (s) { out.shadowed++; bump(out.verdicts, s.verdict); try { ev = JSON.parse(s.evidence); } catch { ev = null; } }
    if (s?.verdict === 'wins') {
      out.candidates.push({ puzzle: a.puzzle_id, move: s.move, evidence: ev?.kind ?? '?', user: a.user_id, closed: new Date(a.closed).toISOString(),
        ...(ev?.book ? { book: { ver: ev.book.ver, proof: ev.book.proof, model: ev.book.model, win_len: ev.book.win_len } } : {}),
        ...(ev?.pns?.plies != null ? { proofPlies: ev.pns.plies } : {}), how: ev?.how ?? null });
    }
    if (size !== 6) continue;
    // V3: rebuilt from the legacy log (no engine): the first decisive entry is a miss, no play-out moves after it,
    // and the move did not end the game.
    let m;
    try { m = p ? missOf(p, a.log) : { error: 'nopuzzle' }; } catch { m = { error: 'replay' }; }
    if (m.error) { out.v3.unreplayable6++; continue; }
    if (m.how === 'rules') { out.v3.rules6++; continue; }
    if (m.how === 'playout') { out.v3.playout6++; continue; }
    out.v3.quickNo6++;
    bump(out.v3.split, s && Number.isFinite(ev?.checkMs) && ev.checkMs > QUICK_MS ? 'likely-playout'
      : s && ev?.pns?.kind === 'no' ? noKind(ev.trace) : s && ev?.pns ? 'shadow-' + ev.pns.kind : 'unrecorded');
  }
  return out;
}

// The V3 count from the attempts table alone (every first result since the start, before the ledger existed too):
// 6×6 rated misses whose log shows a quick 'no' with no play-out. No shadow trace exists for these: no split.
export function v3FromAttempts(db, t0, t1) {
  const rows = db.prepare(`SELECT o.log, p.size, p.tps, p.komi, p.tree, p.swing FROM attempts o JOIN puzzles p ON p.id = o.puzzle_id
    WHERE o.rated = 1 AND o.win = 0 AND p.size = 6 AND o.ts >= ? AND o.ts < ?`).all(t0, t1);
  const out = { misses6: rows.length, quickNo6: 0, playout6: 0, rules6: 0, unreplayable6: 0 };
  for (const r of rows) {
    let m;
    try { m = missOf(r, r.log); } catch { m = { error: 'replay' }; }
    out[m.error ? 'unreplayable6' : m.how === 'rules' ? 'rules6' : m.how === 'playout' ? 'playout6' : 'quickNo6']++;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t0 = day(from, false), t1 = day(to, true);
  const db = new DatabaseSync(arg('--db') || path.join(ROOT, 'data', 'tinue.db'), { readOnly: true });
  const r = report(db, t0, t1);
  if (argv.includes('--all-attempts')) r.v3attempts = v3FromAttempts(db, t0, t1);
  db.close();
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
  console.log(`false-miss report ${from} .. ${to} (UTC): ${r.misses} legacy rated misses, ${r.shadowed} shadow-judged`);
  console.log(`  by size: ${Object.entries(r.bySize).map(([k, v]) => `${k}×${k} ${v}`).join(', ') || 'none'}`);
  console.log(`  shadow verdicts: ${Object.entries(r.verdicts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  console.log(`\nfalse-miss candidates (${r.candidates.length}): proposals only, nothing applied`);
  for (const c of r.candidates) {
    const extra = c.book ? ` book v${c.book.ver} ${c.book.proof}/${c.book.model}${c.book.win_len != null ? ` len ${c.book.win_len}` : ''}` : c.proofPlies != null ? ` proof ${c.proofPlies} plies` : '';
    console.log(`  ${c.puzzle}  ${c.move}  ${c.evidence}${extra}  user ${c.user}  ${c.how ?? ''}  ${c.closed}`);
  }
  const v = r.v3;
  console.log(`\nV3 load estimate (upper bound), 6×6 rated misses: ${v.quickNo6} by a quick threat-only 'no' with no play-out move logged`
    + ` (${v.playout6} after a play-out, ${v.rules6} by the rules, ${v.unreplayable6} not rebuildable)`);
  console.log(`  what stopped the search: ${Object.entries(v.split).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  console.log(`  (includes play-outs lost or left before the player's first play-out move: the log can't tell them apart;`
    + ` 'likely-playout' = the shadow's check took over ${QUICK_MS / 1000} s, so the browser likely showed a play-on)`);
  if (r.v3attempts) {
    const a = r.v3attempts;
    console.log(`  from the attempts table (incl. before the ledger; no split): ${a.quickNo6} of ${a.misses6} 6×6 rated misses`
      + ` (${a.playout6} after a play-out, ${a.rules6} by the rules, ${a.unreplayable6} not rebuildable)`);
  }
}
