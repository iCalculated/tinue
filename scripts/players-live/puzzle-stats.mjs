// Puzzle-rating tracking for the players-live page: per-puzzle trajectories, how far the prior is off by group, how
// well ratings predict results over time, and calibration. Read-only; cheap (one pass over attempts), and the server
// only reruns it when an attempt lands.
//
// Stored per attempt: the puzzle's rating BEFORE it and the player's rating before it. Not stored: rds, theme, guest
// weight. So the rating trajectory is as stored (successive puzzle_rating values, then the current rating), and rd is
// replayed with tinue's own Glicko code, each step's weight inferred as observed Δ ÷ full-Glicko Δ (themes 0.1/0.7,
// guests ×0.5, a newcomer's first puzzle 0). Player rd at each attempt is replayed from the start rating.
//
// Refunds: since 2026-11-20 a refund counts as a solve: the attempts row reads as one (win = 1, rated = 1) with
// refund = 1, and its step carries refund: 1 and won: 1 (no kept: the miss's rise is replaced by the solve's move; rt is
// when it was counted, from its refund event). Before that, and until scripts/refund-legacy-wins.mjs has run, a refunded
// miss kept its attempts row as rated = 0, win = 0, user_delta <> 0 (docs/alt-wins.md; an attempt recorded unrated has
// user_delta 0). Such a step carries refund: 1 and kept: how far the puzzle's rating still stands from that miss. From the ledger when scripts/refund.mjs made the refund (the miss's own move plus the compensating
// one, with back and rt: that move and when); otherwise the rating change stored across the step, which is 0 once an
// earlier by-hand refund has put the puzzle back to its start. puzzles.flaw (1 fixed, 2 not) rides along when present.
//
// A refund's own move on the puzzle (its 'refund' event: puzzle_after − puzzle_before; refund.mjs's compensating step,
// or refund-legacy-wins.mjs's correction) changes only puzzles.rating, when the refund is made. The attempts rows don't
// record it, so without care it would show as part of whichever result's step spans that moment (the last one, mostly):
// an ordinary miss drawn as lowering the puzzle by the whole correction. So each such move is taken out of that step
// and shown as a step of its own at the refund's time (fix: 1, back: the move, after: the rating it left), and the
// refunded step carries back too. A refunded step that now counts as a solve is rated for the replayed rd as it was
// played (a miss: its recorded step is the miss's rise; rose: that rise).
import { update, cap, blend, expected, PUZZLE_START, PLAYER_START } from '../../shared/glicko.js';

const C = Math.LN10 / 400;
const SETTLED_RD = 150; // a player's rating counts as settled below this rd
const WEIGHTS = [1, 0.7, 0.5, 0.35, 0.1, 0.05, 0];
const ll = (p, y) => { p = Math.min(1 - 1e-6, Math.max(1e-6, p)); return -(y ? Math.log(p) : Math.log(1 - p)); };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const hasTable = (d, t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
export const hasFlaw = (d) => d.prepare('PRAGMA table_info(puzzles)').all().some((c) => c.name === 'flaw');
export const hasRefundMark = (d) => d.prepare('PRAGMA table_info(attempts)').all().some((c) => c.name === 'refund');
export const isRefund = (a) => !!a.refund || (!a.rated && !a.win && !!a.user_delta);
// Ledger refunds, one row each: whose attempt, when, how far the puzzle moved back (back) and had risen on the miss (rose).
const DELTA = (e) => `json_extract(${e}.puzzle_after, '$.rating') - json_extract(${e}.puzzle_before, '$.rating')`;
export const refundSql = (d) => (hasTable(d, 'rating_event') && hasTable(d, 'attempt') ? `SELECT e.id, a.user_id, a.puzzle_id, e.ts, ${DELTA('e')} back,
  (SELECT ${DELTA('r')} FROM rating_event r WHERE r.attempt_id = e.attempt_id AND r.kind = 'rate' ORDER BY r.id LIMIT 1) rose
  FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE e.kind = 'refund' ORDER BY e.id` : null);

// Offset b (rating points) that best explains a group's results: P(solve) = 1/(1+10^((prior+b − player)/400)).
// Negative = the group is easier than its prior says.
function offset(rows) {
  if (rows.length < 3) return null;
  let b = 0, info = 0;
  for (let it = 0; it < 40; it++) {
    let g = 0; info = 0;
    for (const r of rows) { const p = 1 / (1 + Math.exp(-C * (r.ur - r.init - b))); g += C * (p - r.win); info += C * C * p * (1 - p); }
    b = Math.max(-1500, Math.min(1500, b + g / info));
  }
  return { n: rows.length, offset: Math.round(b), se: Math.round(1 / Math.sqrt(info)), solve: mean(rows.map((r) => r.win)) };
}

export function puzzleStats(d, label) {
  const attempts = d.prepare(`SELECT user_id, puzzle_id, win, rated, user_rating, user_delta, puzzle_rating, ts${hasRefundMark(d) ? ', refund' : ''} FROM attempts ORDER BY ts`).all();
  const rsql = refundSql(d), ledger = new Map();
  // (several per pair when an older refund was later counted as a solve: refund.mjs's upgrade)
  if (rsql) for (const e of d.prepare(rsql).iterate()) { const k = e.user_id + '|' + e.puzzle_id; ledger.has(k) ? ledger.get(k).push(e) : ledger.set(k, [e]); }
  const guestUsers = d.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'gid');
  const legacy = d.prepare(`SELECT substr(gid, 1, 8) gid, puzzle_id, win, hinted, ts FROM guest_attempts
    ${guestUsers ? 'WHERE gid NOT IN (SELECT gid FROM users WHERE gid IS NOT NULL)' : ''} ORDER BY ts`).all();
  const ids = [...new Set([...attempts.map((a) => a.puzzle_id), ...legacy.map((g) => g.puzzle_id)])];
  const meta = new Map();
  const q = d.prepare(`SELECT id, size, plies, turn, grade, themes, init_rating, rating, rd${hasFlaw(d) ? ', flaw' : ''} FROM puzzles WHERE id = ?`);
  for (const id of ids) { const p = q.get(id); if (p) meta.set(id, p); }

  // player rd at each attempt
  const urd = new Map(), byPuzzle = new Map();
  for (const a of attempts) {
    const u = urd.get(a.user_id) ?? { ...PLAYER_START };
    a.urd = u.rd;
    if (a.rated) urd.set(a.user_id, cap(update({ ...u, rating: a.user_rating }, { rating: a.puzzle_rating, rd: 150, vol: 0.09 }, a.win)));
    if (!byPuzzle.has(a.puzzle_id)) byPuzzle.set(a.puzzle_id, []);
    byPuzzle.get(a.puzzle_id).push(a);
  }

  const rated = [], puzzles = [];
  for (const id of ids) {
    const p = meta.get(id); if (!p) continue;
    const xs = byPuzzle.get(id) || [];
    let st = { rating: xs[0]?.puzzle_rating ?? p.init_rating, rd: PUZZLE_START.rd, vol: PUZZLE_START.vol };
    const steps = [], fixes = [], adj = new Map();
    // The refunds' own moves, each taken out of the step spanning its time (the last step at or before it).
    for (const a of xs) if (isRefund(a)) for (const e of ledger.get(a.user_id + '|' + id) ?? []) {
      if (e.back == null || Math.abs(e.back) < 1e-9) continue;
      let j = -1; xs.forEach((b, i) => { if (b.ts <= e.ts) j = i; }); if (j < 0) j = xs.length - 1;
      fixes.push({ j, e, a }); adj.set(j, (adj.get(j) ?? 0) + e.back);
    }
    const raw = [];
    xs.forEach((a, i) => {
      const before = a.puzzle_rating, after = (i + 1 < xs.length ? xs[i + 1].puzzle_rating : p.rating) - (adj.get(i) ?? 0);
      raw.push(after);
      st.rating = before;
      const usr = { rating: a.user_rating, rd: a.urd, vol: 0.06 };
      const played = a.refund ? 0 : a.win; // a refunded solve was a miss when played, and moved the puzzle as one
      const full = cap(update(st, usr, played ? 0 : 1)), fullD = full.rating - before, obsD = after - before;
      let w = 0;
      if (a.rated && Math.abs(fullD) > 1e-9) w = WEIGHTS.reduce((b, x) => (Math.abs(x * fullD - obsD) < Math.abs(b * fullD - obsD) ? x : b), 1);
      // Standard Glicko E: the puzzle's replayed rd at the time discounts the rating gap; the player's own rd is not
      // used. Live and prior use the same rd, so only the rating differs. pFlat = live with no rd discount (g = 1),
      // to tell rd flattening apart from wrong ratings.
      const pWin = expected(usr, st), pPrior = expected(usr, { rating: p.init_rating, rd: st.rd });
      const pFlat = 1 / (1 + 10 ** ((st.rating - a.user_rating) / 400));
      if (a.rated) rated.push({ ts: a.ts, id, k: i, win: a.win, ur: a.user_rating, urd: a.urd, init: p.init_rating, plies: p.plies, size: p.size, turn: p.turn, pWin, pPrior, pFlat });
      if (w > 0) st = blend(st, full, w);
      st.rating = after;
      steps.push({ t: a.ts, who: label(a.user_id), win: a.win, rated: a.rated, ur: Math.round(a.user_rating), after: Math.round(after), rd: Math.round(i + 1 < xs.length ? st.rd : p.rd), moved: w > 0 });
      if (isRefund(a)) {
        const s = steps.at(-1);
        s.refund = 1;
        const es =ledger.get(a.user_id + '|' + id) ?? [], e = es[0], back = es.reduce((t, x) => t + (x.back ?? 0), 0);
        if (a.refund) { s.won = 1; s.rose = Math.round(obsD); if (es.length) { s.rt = es.at(-1).ts; s.back = Math.round(back); } } // counted as a solve: nothing of the miss is kept
        else {
          s.kept = Math.round(e && e.rose != null && e.back != null ? e.rose + e.back : obsD);
          if (e) { s.rt = e.ts; if (e.back != null) s.back = Math.round(e.back); }
        }
      }
    });
    // The refunds' moves as steps of their own, in time order within the step they were taken from.
    fixes.sort((x, y) => x.e.ts - y.e.ts || x.e.id - y.e.id);
    const run = new Map();
    for (const { j, e, a } of fixes) {
      const r = (run.get(j) ?? raw[j]) + e.back; run.set(j, r);
      steps.push({ t: e.ts, who: label(a.user_id), fix: 1, refund: 1, ...(a.refund ? { won: 1 } : {}), win: a.refund ? 1 : 0, rated: 0, ur: Math.round(a.user_rating),
        after: Math.round(r), rd: steps[j].rd, moved: true, back: Math.round(e.back) });
    }
    for (const g of legacy.filter((g) => g.puzzle_id === id))
      steps.push({ t: g.ts, who: 'guest ' + g.gid, win: g.win, rated: 0, legacy: 1, hinted: g.hinted, moved: false });
    steps.sort((a, b) => a.t - b.t);
    puzzles.push({ id, size: p.size, plies: p.plies, turn: p.turn, grade: p.grade, themes: p.themes, init: Math.round(p.init_rating),
      rating: Math.round(p.rating), rd: Math.round(p.rd), plays: steps.filter((s) => !s.fix).length, moves: steps.filter((s) => s.moved && !s.fix).length, last: steps.at(-1)?.t ?? 0, ...(p.flaw ? { flaw: p.flaw } : {}), steps });
  }

  // how far the prior is off, settled players only
  const set = rated.filter((r) => r.urd < SETTLED_RD);
  const groups = (name, f) => {
    const m = new Map(); for (const r of set) { const k = f(r); if (k != null) { if (!m.has(k)) m.set(k, []); m.get(k).push(r); } }
    return { name, rows: [...m].map(([k, rs]) => ({ k, ...offset(rs) })).filter((g) => g.n >= 15) };
  };
  const offsets = [
    groups('Depth', (r) => (r.plies <= 3 ? '1–3 plies' : r.plies === 5 ? '5 plies' : '7+ plies')),
    groups('Kind', (r) => (r.turn === 1 ? 'turning point' : r.turn === 0 ? 'conversion' : null)),
    groups('Board', (r) => `${r.size}×${r.size}`),
  ];
  for (const g of offsets) g.rows.sort((a, b) => (a.k < b.k ? -1 : 1));

  // prediction accuracy: the solve probability the system had when the puzzle was served, vs the prior rating with the
  // same rd, vs the live rating without the rd discount, vs a constant (the running solve rate)
  rated.sort((a, b) => a.ts - b.ts);
  let wins = 0;
  rated.forEach((r, i) => { r.base = (wins + 1) / (i + 2); wins += r.win; });
  const score = (rs) => (rs.length ? { n: rs.length, live: mean(rs.map((r) => ll(r.pWin, r.win))), prior: mean(rs.map((r) => ll(r.pPrior, r.win))),
    flat: mean(rs.map((r) => ll(r.pFlat, r.win))), base: mean(rs.map((r) => ll(r.base, r.win))), solve: mean(rs.map((r) => r.win)), pred: mean(rs.map((r) => r.pWin)) } : null);
  const W = 60, roll = [], ends = [];
  for (let j = W; j <= rated.length; j += 5) ends.push(j);
  if (rated.length >= W && ends.at(-1) !== rated.length) ends.push(rated.length); // the newest attempts are always in the last point
  for (const j of ends) {
    const s = score(rated.slice(j - W, j));
    roll.push({ n: j, t: rated[j - 1].ts, live: s.live, prior: s.prior, base: s.base }); // n: rated attempts up to this point
  }
  // calibration: rated attempts in 10 equal-count bins by predicted solve probability, live and prior-only
  const calib = (k) => {
    const xs = rated.map((r) => ({ p: r[k], win: r.win })).sort((a, b) => a.p - b.p), B = 10, out = [];
    if (xs.length < B * 10) return out;
    for (let b = 0; b < B; b++) {
      const s = xs.slice(Math.floor((b * xs.length) / B), Math.floor(((b + 1) * xs.length) / B));
      out.push({ p: mean(s.map((r) => r.p)), y: mean(s.map((r) => r.win)), n: s.length });
    }
    return out;
  };
  return {
    summary: { all: offset(set), accuracy: score(rated), replayed: score(rated.filter((r) => r.k >= 1 && r.urd < SETTLED_RD)), settled: set.length },
    offsets, roll, calib: { live: calib('pWin'), prior: calib('pPrior') }, puzzles,
  };
}
