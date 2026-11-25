// Rush and Streak runs for the players-live page (/rush.json): who plays, and the latest runs with their puzzles and
// moves, so the page can draw trajectories, think time and solve rate against puzzle rating. Read-only and cheap:
// one grouped pass over rush_runs, then three range reads over the latest RUNS runs. Columns are those documented at
// the top of server/rush.js. Never a token, email or address column; a gid only as its first eight characters.
//
// Arrays keep the body small (a run has ~40 puzzles and ~70 moves):
//   run.pz[pos] = [puzzle_id, puzzle_rating, state, ms, clock_ms, combo, hidden, wrong]
//       state: 1 solved, 0 missed, 2 skipped, 3 unfinished (an abandoned run's last puzzle, or a move left open)
//   run.mv[i]   = [pos, n, first_ms, ms, at_ms, clock_ms, weight, correct, ptn, check_v, paused_ms, open, credit,
//                  final_v, check_ms, held_ms]   (trailing nulls dropped)
//   run.po[i]   = [pos, n, proven, cap, ending, paused_ms, moves in the play-out]
const RUNS = 200; // runs sent in full; the players table counts every run
const TABLES = ['rush_runs', 'rush_puzzles', 'rush_moves', 'rush_playouts'];

export const rushReady = (d) => TABLES.every((t) => d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
const firstId = (d) => d.prepare('SELECT id FROM rush_runs ORDER BY id DESC LIMIT 1 OFFSET ?').get(RUNS - 1)?.id ?? 0;

const RUN = 'id, user_id, gid, mode, score, moves, errors, best_combo, ms, user_rating, ts, abandoned, played_at, late, input, confirm, width, paused_ms';
const PUZZLE = 'run_id, pos, puzzle_id, solved, skipped, ms, wrong, clock_ms, combo, puzzle_rating, hidden, unfinished';
const MOVE = 'run_id, pos, n, first_ms, ms, at_ms, clock_ms, weight, correct, ptn, check_v, paused_ms, open, credit, final_v, check_ms, held_ms';
const PLAYOUT = 'run_id, pos, n, proven, cap, ending, paused_ms, CASE WHEN json_valid(moves) THEN json_array_length(moves) END len';

// What the stamp reads: [sql, ...params] for every column rushStats reads, so an in-place edit is a new body too.
export function rushFeeds(d, usersSql) {
  if (!rushReady(d)) return [];
  const from = firstId(d);
  return [[usersSql], [`SELECT ${RUN} FROM rush_runs ORDER BY id`],
    [`SELECT ${PUZZLE} FROM rush_puzzles WHERE run_id >= ? ORDER BY run_id, pos`, from],
    [`SELECT ${MOVE} FROM rush_moves WHERE run_id >= ? ORDER BY run_id, pos, n`, from],
    [`SELECT ${PLAYOUT} FROM rush_playouts WHERE run_id >= ? ORDER BY run_id, pos, n`, from]];
}

// users: Map(id -> { id, name, gid? }), as the page's other data labels players.
export function rushStats(d, users) {
  if (!rushReady(d)) return { at: Date.now(), total: 0, shown: 0, players: [], runs: [] };
  const byGid = new Map();
  for (const u of users.values()) if (u.gid) byGid.set(u.gid, u);
  // A run is its token's user; a tokenless browser's run joins that player once a token arrives (users.gid).
  const who = (r) => {
    const u = r.user_id != null ? users.get(r.user_id) : byGid.get(r.gid);
    if (u) return { player: u.name || (u.gid ? 'guest ' + u.gid.slice(0, 8) : 'guest u' + u.id), kind: u.name ? 'account' : 'guest' };
    return { player: r.gid ? 'guest ' + r.gid.slice(0, 8) : r.user_id != null ? 'user ' + r.user_id : 'guest', kind: 'guest' };
  };
  const from = firstId(d), runs = [], byId = new Map(), players = new Map();
  let total = 0;
  for (const r of d.prepare(`SELECT ${RUN} FROM rush_runs ORDER BY id`).iterate()) {
    total++;
    const w = who(r), t = r.played_at ?? r.ts, mode = r.mode === 'streak' ? 'streak' : 'rush';
    if (!players.has(w.player)) players.set(w.player, { ...w, last: 0, rush: { runs: 0, left: 0, best: null, bestT: null }, streak: { runs: 0, left: 0, best: null, bestT: null } });
    const p = players.get(w.player), m = p[mode];
    p.last = Math.max(p.last, t);
    if (r.abandoned) m.left++;
    else { m.runs++; if (m.best == null || r.score > m.best) { m.best = r.score; m.bestT = t; } } // a run left unfinished never counts for a best
    if (r.id < from) continue;
    const run = { id: r.id, ...w, mode, score: r.score, moves: r.moves, errors: r.errors, combo: r.best_combo, ms: r.ms, paused: r.paused_ms,
      t, posted: r.ts, left: r.abandoned ? 1 : 0, late: r.late ? 1 : 0, ur: r.user_rating == null ? null : Math.round(r.user_rating),
      input: r.input, width: r.width, confirm: r.confirm, pz: [], mv: [], po: [] };
    runs.push(run); byId.set(r.id, run);
  }
  for (const p of d.prepare(`SELECT ${PUZZLE} FROM rush_puzzles WHERE run_id >= ? ORDER BY run_id, pos`).iterate(from)) {
    const run = byId.get(p.run_id); if (!run || !(p.pos >= 0)) continue;
    while (run.pz.length < p.pos) run.pz.push(null);
    run.pz[p.pos] = [p.puzzle_id, p.puzzle_rating == null ? null : Math.round(p.puzzle_rating), p.unfinished ? 3 : p.skipped ? 2 : p.solved ? 1 : 0,
      p.ms, p.clock_ms, p.combo, p.hidden ? 1 : 0, p.wrong];
  }
  for (const m of d.prepare(`SELECT ${MOVE} FROM rush_moves WHERE run_id >= ? ORDER BY run_id, pos, n`).iterate(from)) {
    const run = byId.get(m.run_id); if (!run) continue;
    const a = [m.pos, m.n, m.first_ms, m.ms, m.at_ms, m.clock_ms, m.weight, m.correct, m.ptn, m.check_v, m.paused_ms, m.open, m.credit, m.final_v, m.check_ms, m.held_ms];
    while (a.length && a.at(-1) == null) a.pop();
    run.mv.push(a);
  }
  for (const o of d.prepare(`SELECT ${PLAYOUT} FROM rush_playouts WHERE run_id >= ? ORDER BY run_id, pos, n`).iterate(from))
    byId.get(o.run_id)?.po.push([o.pos, o.n, o.proven, o.cap, o.ending, o.paused_ms, o.len]);
  return { at: Date.now(), total, shown: runs.length, players: [...players.values()], runs };
}
