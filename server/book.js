// The book (docs/plan/PLAN.md §1.1): positions proven to be won for the side that just moved, keyed by
// shared/book.js bookKey. Rows are insert-only and versioned; a row is retired (retired_ver set), never deleted.
// Off by default: lookups see only rows with ver <= TINUE_BOOK_VER, which defaults to 0 (server/move.js; the shadow judge,
// server/shadow.js, names the newest complete version itself).
//
// The plan's column `commit` is named commit_sha here in all three tables (COMMIT is an SQL keyword).
export const BOOK_VER = Math.max(0, Math.floor(+process.env.TINUE_BOOK_VER || 0));

export const MODELS = { threat: 1, 'threat+1quiet': 2, full: 3 }; // what a length is exact under; higher is stronger
export const PROOFS = new Set(['tree', 'alt', 'deep-cert', 'live-deep', 'live-pns', 'rejudge']);
export const NODE_VERDICTS = new Set(['key', 'win', 'refuted', 'undecided']);

export function initBook(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS book (
  pos         TEXT    NOT NULL,   -- bookKey: position after the attacker's move, defender to move
  ver         INTEGER NOT NULL,   -- book version that added it (one per publish)
  win_len     INTEGER,            -- plies left from pos, the attacker's last ply included; NULL = length unknown
  exact       INTEGER NOT NULL,   -- 1: no shorter win under model (the disproof at win_len - 2 finished)
  model       TEXT    NOT NULL,   -- what the length is exact under: full | threat | threat+1quiet
  proof       TEXT    NOT NULL,   -- tree | alt | deep-cert | live-deep | live-pns | rejudge
  checked     INTEGER NOT NULL,   -- 1: a checker (deep's SOLVER §5 checker, or tak.js fullDefense) replayed it
  puzzle_id   TEXT,               -- producer (provenance only)
  commit_sha  TEXT    NOT NULL,   -- producing commit
  ts          INTEGER NOT NULL,
  retired_ver INTEGER,            -- the version that retired it (set instead of DELETE)
  PRIMARY KEY (pos, ver)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS book_node (  -- attacker nodes whose every legal move was classified
  pos         TEXT    NOT NULL, ver INTEGER NOT NULL,
  moves       TEXT    NOT NULL,   -- JSON {move (canonical PTN): 'key'|'win'|'refuted'|'undecided'}, every legal move
  model       TEXT    NOT NULL,   -- full | threat | threat+1quiet
  puzzle_id   TEXT, commit_sha TEXT NOT NULL, retired_ver INTEGER,
  PRIMARY KEY (pos, ver)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS book_ver (
  ver INTEGER PRIMARY KEY, ts INTEGER NOT NULL, commit_sha TEXT NOT NULL, added INTEGER, retired INTEGER, note TEXT
);`);
}

// The row a judge would use for pos at book version maxVer: the newest row with ver <= maxVer that was not retired as
// of maxVer (retired_ver NULL or > maxVer), so lowering the pointer brings back what a later version retired. Only
// complete versions (with a book_ver row) count, for the rows a version adds and for those it retires: a publish
// killed part way is invisible at any pointer, its own or above.
export function bookLookup(db, pos, maxVer = BOOK_VER) {
  if (!(maxVer > 0)) return null;
  return db.prepare(`SELECT * FROM book WHERE pos = ? AND ver <= ? AND (retired_ver IS NULL OR retired_ver > ? OR retired_ver NOT IN (SELECT ver FROM book_ver))
    AND ver IN (SELECT ver FROM book_ver) ORDER BY ver DESC LIMIT 1`).get(pos, maxVer, maxVer) ?? null;
}
export function bookNodeLookup(db, pos, maxVer = BOOK_VER) {
  if (!(maxVer > 0)) return null;
  const r = db.prepare(`SELECT * FROM book_node WHERE pos = ? AND ver <= ? AND (retired_ver IS NULL OR retired_ver > ? OR retired_ver NOT IN (SELECT ver FROM book_ver))
    AND ver IN (SELECT ver FROM book_ver) ORDER BY ver DESC LIMIT 1`).get(pos, maxVer, maxVer);
  return r ? { ...r, moves: JSON.parse(r.moves) } : null;
}

function checkRow(r) {
  const bad = (why) => { throw new Error(`book row ${r.pos}: ${why}`); };
  if (typeof r.pos !== 'string' || !/^[0-9xSC,/]+ [12]\|\d+$/.test(r.pos)) bad('pos is not a bookKey');
  if (r.win_len != null && !(Number.isInteger(r.win_len) && r.win_len > 0)) bad('win_len ' + r.win_len);
  if (r.exact !== 0 && r.exact !== 1) bad('exact ' + r.exact);
  if (r.exact === 1 && r.win_len == null) bad('exact without a length');
  if (r.exact === 1 && r.checked !== 1) bad('exact without a check'); // an exact length sets the play-out cap: never unchecked
  if (!MODELS[r.model]) bad('model ' + r.model);
  if (!PROOFS.has(r.proof)) bad('proof ' + r.proof);
  if (r.checked !== 0 && r.checked !== 1) bad('checked ' + r.checked);
}

// How a new row b relates to a live row a for the same pos:
//   'conflict'  same model, both lengths known and different, and they cannot both be right: two exact = 1 lengths, or
//               an exact = 1 length above an exact = 0 one (an exact length is never above a valid upper bound). Two
//               exact = 0 lengths are both upper bounds and never conflict: the shorter wins. Fails the publish;
//   'replace'   b is stronger: a is retired, b added;
//   'keep'      b adds nothing (equal or weaker): b is not added (it would otherwise shadow a, as lookups take the newest).
// Stronger, in order: a proved row (a length, or checked = 1) over an unproved placeholder (no length, unchecked: a stored
// alt whose re-proof failed), whatever the placeholder's model; two placeholders keep the first. A row without a length
// never displaces one with a length. Then the model, except that an unchecked row never displaces a checked one by model
// alone. Then exact = 1 over exact = 0, or the shorter of two exact = 0 bounds; then a length over none; then checked over
// unchecked (so of two equal exact = 0 lengths the checked one).
export function compareRows(a, b) {
  const proved = (r) => r.win_len != null || r.checked === 1;
  if (proved(a) !== proved(b)) return proved(b) ? 'replace' : 'keep';
  if (!proved(a)) return 'keep';
  if (a.win_len != null && b.win_len == null) return 'keep'; // a row without a length never displaces one with a length
  const ma = MODELS[a.model], mb = MODELS[b.model];
  if (mb !== ma) return mb > ma && !(a.checked === 1 && b.checked !== 1) ? 'replace' : 'keep';
  const known = a.win_len != null && b.win_len != null;
  if (known && a.win_len !== b.win_len) {
    if (a.exact === 1 && b.exact === 1) return 'conflict';
    if (a.exact === 1) return a.win_len > b.win_len ? 'conflict' : 'keep';
    if (b.exact === 1) return b.win_len > a.win_len ? 'conflict' : 'replace';
    return b.win_len < a.win_len ? 'replace' : 'keep'; // two upper bounds: the shorter
  }
  if (b.exact !== a.exact) return b.exact > a.exact ? 'replace' : 'keep';
  if ((a.win_len == null) !== (b.win_len == null)) return b.win_len != null ? 'replace' : 'keep';
  return b.checked > a.checked ? 'replace' : 'keep';
}

// One publish, in two steps:
//   planPublish (reads only): picks one row per pos by compareRows, decides each against the live book, finds conflicts
//     and refused retirements, and chooses the version (default: newest + 1).
//   writePublish: writes the plan as that version, in transactions of `chunk` rows (BEGIN IMMEDIATE, so a chunk waits for
//     the server's writes instead of failing part way), pausing pauseMs between them; the retirements, nodes and the
//     book_ver row go last, in the final transaction. A version is complete only once its book_ver row exists; lookups
//     ignore a version without one. A kill between chunks leaves the version incomplete: planPublish with resume: true
//     continues it; without resume it refuses to start another. A resumed plan is decided against the book as it was
//     before the incomplete version; a row already written in it is kept only if the new plan adds that same row with
//     the same retirements. Every other row in it is taken back (reclaim: deleted, and the rows it retired made live
//     again; safe, as no lookup sees an incomplete version) before anything is added, so the completed version holds
//     exactly what the new plan calls for, even if the input changed between the kill and the rerun.
//   rows:   [{ pos, win_len, exact, model, proof, checked, puzzle_id }]
//   retire: [pos] to retire without a replacement; refused for any pos in protect (positions a tree lists as a key).
// Report: { ver, added, retired, kept, lengthChanges: [{ pos, from, to, fromModel, toModel }], conflicts, refused }.
// publishBook = plan + write. Any conflict, or a refused retirement, fails it before anything is written (the error
// carries .report). dryRun: the plan's report only. A publish that adds and retires nothing writes nothing.
const versions = (db) => {
  const complete = db.prepare('SELECT MAX(ver) v FROM book_ver').get().v ?? 0;
  const any = db.prepare('SELECT MAX(v) v FROM (SELECT MAX(ver) v FROM book_ver UNION ALL SELECT MAX(ver) FROM book UNION ALL SELECT MAX(ver) FROM book_node)').get().v ?? 0;
  return { complete, any, incomplete: any > complete ? any : null };
};

export function planPublish(db, { rows = [], nodes = [], retire = [], protect = new Set(), ver, resume = false }) {
  const v = versions(db);
  let resuming = false;
  if (v.incomplete && resume) {
    if (ver != null && ver !== v.incomplete) throw new Error(`publishBook: version ${v.incomplete} is incomplete; resume it, not ${ver}`);
    ver = v.incomplete; resuming = true;
  } else if (v.incomplete) throw new Error(`publishBook: version ${v.incomplete} is incomplete (no book_ver row); resume it`);
  ver ??= v.any + 1;
  if (!resuming && !(Number.isInteger(ver) && ver > v.any)) throw new Error(`publishBook: version ${ver} is not above ${v.any}`);
  const report = { ver, added: 0, retired: 0, kept: 0, nodesAdded: 0, nodesRetired: 0, lengthChanges: [], conflicts: [], refused: [], resumed: resuming, alreadyWritten: 0 };
  const change = (a, b) => { if (a.win_len !== b.win_len) report.lengthChanges.push({ pos: b.pos, from: a.win_len, to: b.win_len, fromModel: a.model, toModel: b.model, puzzle: b.puzzle_id ?? null }); };

  // Within the publish: one row per pos, by the same rules.
  const chosen = new Map();
  for (const r0 of rows) {
    const r = { puzzle_id: null, ...r0, win_len: r0.win_len ?? null };
    checkRow(r);
    const a = chosen.get(r.pos);
    if (!a) { chosen.set(r.pos, r); continue; }
    const c = compareRows(a, r);
    if (c === 'conflict') report.conflicts.push({ pos: r.pos, a: { win_len: a.win_len, model: a.model, puzzle: a.puzzle_id }, b: { win_len: r.win_len, model: r.model, puzzle: r.puzzle_id }, within: true });
    else if (c === 'replace') { change(a, r); chosen.set(r.pos, r); } else report.kept++;
  }
  for (const n of nodes) {
    if (!MODELS[n.model] || !n.moves || typeof n.moves !== 'object') throw new Error('book_node ' + n.pos + ': bad row');
    for (const x of Object.values(n.moves)) if (!NODE_VERDICTS.has(x)) throw new Error('book_node ' + n.pos + ': verdict ' + x);
  }
  for (const pos of retire) if (protect.has(pos)) report.refused.push(pos);

  // Live rows, as of before this version when resuming (its own rows left out, its retirements undone).
  const live = resuming
    ? db.prepare('SELECT * FROM book WHERE pos = ? AND ver <> ? AND (retired_ver IS NULL OR retired_ver = ?) ORDER BY ver DESC')
    : db.prepare('SELECT * FROM book WHERE pos = ? AND retired_ver IS NULL ORDER BY ver DESC');
  const liveOf = (pos) => (resuming ? live.all(pos, ver, ver) : live.all(pos));
  const atVer = new Map(resuming ? db.prepare('SELECT * FROM book WHERE ver = ?').all(ver).map((a) => [a.pos, a]) : []);
  const same = (a, r) => ['win_len', 'exact', 'model', 'proof', 'checked'].every((k) => a[k] === r[k]);
  const adds = [], written = [], reclaim = new Set([...atVer.keys()].filter((pos) => !chosen.has(pos)));
  for (const r of chosen.values()) {
    const old = liveOf(r.pos), w = atVer.get(r.pos);
    let add = true, conflict = false;
    for (const a of old) {
      const c = compareRows(a, r);
      if (c === 'conflict') { report.conflicts.push({ pos: r.pos, a: { win_len: a.win_len, model: a.model, ver: a.ver, puzzle: a.puzzle_id }, b: { win_len: r.win_len, model: r.model, puzzle: r.puzzle_id } }); conflict = true; }
      else if (c === 'keep') add = false;
    }
    if (w && !(add && !conflict && same(w, r) && old.every((a) => a.retired_ver === ver))) { reclaim.add(r.pos); }
    else if (w) { report.alreadyWritten++; report.added++; written.push(r.pos); continue; }
    if (conflict) continue;
    if (!add) { report.kept++; continue; }
    for (const a of old) { report.retired++; change(a, r); }
    adds.push(r);
    report.added++;
  }
  report.reclaimed = reclaim.size;
  return { ver, resuming, adds, written, reclaim: [...reclaim], nodes, retire: retire.filter((p) => !protect.has(p)), report };
}

const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export function writePublish(db, plan, { commitSha, note = null, ts = Date.now(), chunk = Infinity, pauseMs = 0, onChunk = null }) {
  if (!commitSha) throw new Error('publishBook: commitSha required');
  const { ver, report } = plan;
  if (report.conflicts.length || report.refused.length) throw new Error('writePublish: the plan has conflicts or refused retirements');
  if (!plan.adds.length && !plan.retire.length && !plan.nodes.length && !plan.resuming) { report.ver = null; return report; }
  const live = db.prepare('SELECT * FROM book WHERE pos = ? AND retired_ver IS NULL ORDER BY ver DESC');
  const ins = db.prepare('INSERT INTO book (pos, ver, win_len, exact, model, proof, checked, puzzle_id, commit_sha, ts) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const ret = db.prepare('UPDATE book SET retired_ver = ? WHERE pos = ? AND ver = ?');
  const verDone = db.prepare('SELECT 1 FROM book_ver WHERE ver = ?');
  const begin = () => { // every chunk: a version completed meanwhile (by another run) is never written into
    db.exec('BEGIN IMMEDIATE');
    if (verDone.get(ver)) { db.exec('ROLLBACK'); throw new Error(`writePublish: version ${ver} was completed by another run; nothing more written`); }
  };
  const del = db.prepare('DELETE FROM book WHERE pos = ? AND ver = ?'), unret = db.prepare('UPDATE book SET retired_ver = NULL WHERE pos = ? AND retired_ver = ?');
  const n0 = Math.max(1, Math.min(chunk, plan.reclaim.length || 1));
  for (let i = 0; i < plan.reclaim.length; i += n0) { // take back the killed run's rows the plan does not keep, in chunks
    begin();
    try {
      for (const pos of plan.reclaim.slice(i, i + n0)) {
        del.run(pos, ver);
        unret.run(pos, ver);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    sleep(pauseMs);
  }
  const n = Math.max(1, Math.min(chunk, plan.adds.length || 1));
  for (let i = 0; i < Math.max(1, plan.adds.length); i += n) {
    const last = i + n >= plan.adds.length;
    begin();
    try {
      for (const r of plan.adds.slice(i, i + n)) { // decided again inside the lock: the book may have changed since the plan
        const old = live.all(r.pos);
        if (old.some((a) => a.ver === ver)) continue;
        const cs = old.map((a) => compareRows(a, r));
        if (cs.includes('conflict')) throw new Error(`book changed under the publish: ${r.pos} now conflicts`);
        if (cs.includes('keep')) continue;
        for (const a of old) ret.run(ver, a.pos, a.ver);
        ins.run(r.pos, ver, r.win_len, r.exact, r.model, r.proof, r.checked, r.puzzle_id, commitSha, ts);
      }
      if (last) {
        for (const pos of plan.retire) db.prepare('UPDATE book SET retired_ver = ? WHERE pos = ? AND retired_ver IS NULL').run(ver, pos);
        const liveNode = db.prepare('SELECT * FROM book_node WHERE pos = ? AND retired_ver IS NULL');
        const insNode = db.prepare('INSERT INTO book_node (pos, ver, moves, model, puzzle_id, commit_sha) VALUES (?,?,?,?,?,?)');
        for (const nd of plan.nodes) { // a node classification replaces any live one of the same or a weaker model
          const old = liveNode.all(nd.pos);
          if (old.some((a) => MODELS[a.model] > MODELS[nd.model])) continue;
          for (const a of old) { db.prepare('UPDATE book_node SET retired_ver = ? WHERE pos = ? AND ver = ?').run(ver, a.pos, a.ver); report.nodesRetired++; }
          insNode.run(nd.pos, ver, JSON.stringify(nd.moves), nd.model, nd.puzzle_id ?? null, commitSha);
          report.nodesAdded++;
        }
        report.added = db.prepare('SELECT COUNT(*) n FROM book WHERE ver = ?').get(ver).n;
        report.retired = db.prepare('SELECT COUNT(*) n FROM book WHERE retired_ver = ?').get(ver).n;
        if (!report.added && !report.retired && !report.nodesAdded && !report.nodesRetired) { db.exec('ROLLBACK'); report.ver = null; return report; }
        db.prepare('INSERT INTO book_ver (ver, ts, commit_sha, added, retired, note) VALUES (?,?,?,?,?,?)').run(ver, ts, commitSha, report.added, report.retired, note);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    onChunk?.(Math.min(i + n, plan.adds.length), plan.adds.length);
    if (!last) sleep(pauseMs);
  }
  return report;
}

export function publishBook(db, { rows = [], nodes = [], retire = [], protect = new Set(), commitSha, note = null, ts = Date.now(), ver, dryRun = false, resume = false, chunk, pauseMs, onChunk }) {
  if (!commitSha) throw new Error('publishBook: commitSha required');
  const plan = planPublish(db, { rows, nodes, retire, protect, ver, resume });
  const { report } = plan;
  if (dryRun) {
    if (!plan.adds.length && !report.retired && !plan.retire.length && !plan.nodes.length && !plan.resuming) report.ver = null;
    return report;
  }
  if (report.conflicts.length || report.refused.length) {
    const e = new Error(`book publish refused: ${report.conflicts.length} length conflicts, ${report.refused.length} retirements of tree keys`);
    e.report = report;
    throw e;
  }
  return writePublish(db, plan, { commitSha, note, ts, chunk, pauseMs, onChunk });
}
