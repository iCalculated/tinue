// Puzzle state columns (docs/plan/PLAN.md §1.4, commit P1): kind, status, pre0, miner, book on puzzles, derived from the
// columns that decided before P2. The server goes by kind and status (bottom of this file); it reads none of the others. They are
// a pure function of turn, grade, swing, id and the hand-grade holds, so they can be recomputed at any time:
//   kind    turn 1 / 0 / NULL                      -> 'turning' / 'conversion' / 'unscored'
//   status  grade D -> 'rejected' (Q11, Sasha 2026-11-17: "we shouldn't serve grade Ds"; D wins over turn = 1), or
//           'paused' when a hold-YYYYMMDD override row holds it (today's 3 holds are all grade D: a hold says more than
//           the grade it was made with); else turn = 1 OR grade = 'A' -> 'served'; else a hold -> 'paused'; else
//           'reserve'. Nothing serves a 'paused' or 'rejected' row, and a result on one is unrated (P3).
//           (The verifier may also reject rows later, with Sasha's approval of its diff.)
//   pre0    swing.pre0 (what /api/puzzle sends as pre0: swingPublic), NULL without one
//   miner   the id's letter prefix (p, pd, ps, pc, pdg, ...): which miner made it; source already holds 'PlayTak'
//   book    sha256 of the puzzle's book slice (§1.1). No book exists before B1, so it stays NULL here.
// Who keeps them right: scripts/import.mjs recomputes every row right after each import commits (only rows whose value
// differs are written), and scripts/puzzle-state.mjs does the same by hand (after a hand fix on crux, or the
// first time on a database whose columns are new). The server only adds the columns (addPuzzleState, at startup).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addColumns } from './schema.js';

export const STATE_COLUMNS = [['kind', 'TEXT'], ['status', 'TEXT'], ['pre0', 'REAL'], ['miner', 'TEXT'], ['book', 'TEXT']];
export const OVERRIDES = fileURLToPath(new URL('../scripts/grade-overrides.jsonl', import.meta.url));

// The columns, added once (ALTER TABLE ADD COLUMN only edits the schema: no row is rewritten). Idempotent.
export const addPuzzleState = (db) => addColumns(db, 'puzzles', STATE_COLUMNS);

// Ids of the hand-grade overrides that put a puzzle on hold (a `hold-YYYYMMDD: true` stamp, e.g. hold-20261116).
// Lines import.mjs would refuse are skipped here (import refuses the whole file before anything is written).
export function heldIds(file = OVERRIDES) {
  const held = new Set();
  if (!file || !fs.existsSync(file)) return held;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    let r; try { r = JSON.parse(t); } catch { continue; }
    if (typeof r?.id === 'string' && Object.keys(r).some((k) => /^hold-\d{8}$/.test(k) && r[k] === true)) held.add(r.id);
  }
  return held;
}

const servedNow = (r) => r.turn === 1 || r.grade === 'A'; // the served pool before P2 (server.js read it directly)
const kindNow = (turn) => (turn === 1 ? 'turning' : turn === 0 ? 'conversion' : 'unscored');
export function derive(r, held) {
  let pre0 = null;
  if (r.swing) { const s = JSON.parse(r.swing); pre0 = typeof s?.pre0 === 'number' ? s.pre0 : null; }
  return {
    kind: kindNow(r.turn),
    status: r.grade === 'D' ? (held.has(r.id) ? 'paused' : 'rejected') : servedNow(r) ? 'served' : held.has(r.id) ? 'paused' : 'reserve',
    pre0,
    miner: /^([a-z]+)(?=\d)/.exec(r.id)?.[1] ?? null,
  };
}

// What the client needs of the swing analysis: pre0 (the "you were behind" caption), alts (proven first-move wins outside
// the tree, which count as solves: slowSolve) and altsAt (the same at later attacker moves, keyed by the space-joined
// moves played so far); the rest is for analysis only.
export function swingPublic(raw) {
  const s = raw ? JSON.parse(raw) : {};
  return { pre0: s.pre0 ?? null, ...(s.alts?.length ? { alts: s.alts } : {}), ...(s.altsAt ? { altsAt: s.altsAt } : {}) };
}

// Recompute every row; write only the rows that differ. inTransaction: the caller has one open and the writes join it;
// otherwise they go in transactions of `chunk` rows with `pause` ms between them, so a result the server writes meanwhile
// waits one chunk (server.js waits up to 5 s on a busy lock) and never the whole run: the pause leaves the lock free
// between chunks instead of re-taking it at once, which was one ~1 s lock in effect.
// Returns { rows, changed, ms }.
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
export function backfillPuzzleState(db, { held = heldIds(), chunk = 2000, pause = 25, inTransaction = false } = {}) {
  const t0 = performance.now();
  const rows = db.prepare('SELECT id, turn, grade, swing, kind, status, pre0, miner FROM puzzles ORDER BY rowid').all();
  const set = db.prepare('UPDATE puzzles SET kind = ?, status = ?, pre0 = ?, miner = ? WHERE id = ?');
  const todo = [];
  for (const r of rows) {
    const d = derive(r, held);
    if (d.kind !== r.kind || d.status !== r.status || d.pre0 !== r.pre0 || d.miner !== r.miner) todo.push([d.kind, d.status, d.pre0, d.miner, r.id]);
  }
  const own = !inTransaction;
  for (let i = 0; i < todo.length; i += own ? chunk : todo.length) {
    if (own && i) sleep(pause);
    if (own) db.exec('BEGIN');
    try {
      for (const a of todo.slice(i, own ? i + chunk : todo.length)) set.run(...a);
      if (own) db.exec('COMMIT');
    } catch (e) { if (own) db.exec('ROLLBACK'); throw e; }
  }
  return { rows: rows.length, changed: todo.length, ms: Math.round(performance.now() - t0) };
}

// What the server goes by (PLAN P2): the stored kind and status. A row the backfill has not reached (NULL: a database
// whose columns were just added, rows a test wrote by hand) gets them derived from turn/grade as derive() would (a hold
// needs the overrides file, which the server doesn't read: such a row is 'reserve' until the backfill marks it).
// Grade D is 'rejected' here whatever the column says (unless 'paused'), so the server is right before the Q11 backfill
// has run (status still 'served'/'reserve' on D rows) and after a hand edit to D that skipped scripts/puzzle-state.mjs.
// The SQL forms say the same for a query (the daily tiers); scripts/test-pstate.mjs holds JS and SQL equal.
export const UNSERVED = ['paused', 'rejected']; // never picked by anything; a result on one is unrated (P3)
export const kindOf = (r) => r.kind ?? kindNow(r.turn);
export function statusOf(r) {
  if (UNSERVED.includes(r.status)) return r.status;
  if (r.grade === 'D') return 'rejected';
  return r.status ?? (servedNow(r) ? 'served' : 'reserve');
}
export const served = (r) => statusOf(r) === 'served'; // the served pool: the picker's first stage
export const pickable = (r) => !UNSERVED.includes(statusOf(r)); // any stage, any picker
export const KIND_SQL = "COALESCE(kind, CASE turn WHEN 1 THEN 'turning' WHEN 0 THEN 'conversion' ELSE 'unscored' END)";
export const STATUS_SQL = "CASE WHEN status IN ('paused', 'rejected') THEN status WHEN grade = 'D' THEN 'rejected' " +
  "ELSE COALESCE(status, CASE WHEN turn = 1 OR grade = 'A' THEN 'served' ELSE 'reserve' END) END";
export const PICKABLE_SQL = `(${STATUS_SQL}) NOT IN ('paused', 'rejected')`;
