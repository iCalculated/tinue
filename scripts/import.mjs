// Load normalized puzzle files (data/puzzles/*.jsonl) into SQLite. Re-runnable: existing puzzles keep
// their earned rating/attempts; only unplayed puzzles get their prior refreshed.
// usage: node scripts/import.mjs [dir] [--swing data/swing/swing-v4.jsonl] [--allow-superseded] [--overrides f | --no-overrides]
// A full rebuild needs two runs: the default import (PlayTak sidecar swing-v4), then --swing data/swing/deep-v4.jsonl (pd*).
// Turning-point scores (turn, swing) come from the scoring sidecar (one {id, pre0, pre2, pre4, lostBefore, alt, turn}
// per line; optional) or, for deploy exports, from each puzzle's own turn/swing fields. Sidecar wins; a puzzle with
// neither keeps what the DB already has.
// Puzzle revisions (PLAN §1.4 `rev`, B2): when an import changes an existing puzzle's tree, tps or komi (what a verdict is
// judged against), the old ones go to puzzle_rev under the old rev (insert only) and puzzles.rev goes up by one. Other
// columns (themes, meta, grade, ...) do not bump it. A new puzzle starts at rev 0.
// --book <file> (scripts/publish-puzzles.sh, marker import-book-v1): book rows (one {pos, win_len, exact, model, proof,
// checked, puzzle_id, commit_sha} per line) added as the book's next version (server/book.js planPublish), in the same
// transaction as the puzzles: a length conflict with the live book refuses the whole import, puzzles included. Rows are
// only inserted; a stronger row retires a weaker one by setting its retired_ver. Nothing is served from the new version
// until TINUE_BOOK_VER reaches it. --book-commit <sha> names the publishing commit (book_ver.commit_sha; required with
// --book), --book-note <text> the book_ver note.
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/server.js';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ptnFromServer } from '../shared/ptn.js';
import { backfillPuzzleState, heldIds } from '../server/puzzle-state.js';
import { planPublish } from '../server/book.js';
import { REFUNDED_SQL } from '../server/log.js';
import { SWING_KEYS, turnOf } from './puzzle-rows.mjs';

// Game history (moves before the puzzle) for PlayTak puzzles, from the raw dump if present.
const RAW = 'data/raw/games_anon.db';
const raw = fs.existsSync(RAW) ? new DatabaseSync(RAW, { readOnly: true }) : null;
const getGame = raw?.prepare('SELECT notation FROM games WHERE id = ?');
function withHistory(p) {
  if (!getGame || !p.meta?.gameId || p.meta.history) return p;
  const row = getGame.get(p.meta.gameId);
  if (row?.notation) p.meta.history = row.notation.split(',').map(ptnFromServer).slice(0, p.meta.ply);
  return p;
}

const argv = process.argv.slice(2), gi = argv.indexOf('--grades');
// Book rows (B2): read and checked before the DB is written; written inside the import's transaction below.
const bki = argv.indexOf('--book'), BOOK = bki >= 0 ? argv.splice(bki, 2)[1] : null;
const bci = argv.indexOf('--book-commit'), BOOK_COMMIT = bci >= 0 ? argv.splice(bci, 2)[1] : null;
const bni = argv.indexOf('--book-note'), BOOK_NOTE = bni >= 0 ? argv.splice(bni, 2)[1] : null;
if (bki >= 0 && (!BOOK || BOOK.startsWith('--') || !fs.existsSync(BOOK))) { console.error(`import: --book needs an existing file (${BOOK})`); process.exit(2); }
if (BOOK && (!BOOK_COMMIT || BOOK_COMMIT.startsWith('--'))) { console.error('import: --book needs --book-commit <sha>'); process.exit(2); }
const bookRows = [];
if (BOOK) fs.readFileSync(BOOK, 'utf8').split('\n').forEach((l, i) => {
  if (!l.trim()) return;
  try { bookRows.push(JSON.parse(l)); } catch (e) { console.error(`import: ${BOOK} line ${i + 1}: ${e.message}`); process.exit(2); }
});
// Conversion grades (scripts/grade/, README there): one {id, tier (or grade), score, why} per line. Default: data/grade/grades.jsonl if present.
const GRADES = gi >= 0 ? argv.splice(gi, 2)[1] : fs.existsSync('data/grade/grades.jsonl') ? 'data/grade/grades.jsonl' : null;
// Hand grades (scripts/grade-overrides.jsonl, tracked; scripts/grade/README.md): one {id, tier, why, ...stamps} per line,
// applied after the grades file so a hand grade survives a grade.py re-run. --overrides points elsewhere; --no-overrides skips.
const oi = argv.indexOf('--overrides'), noi = argv.indexOf('--no-overrides');
// (a bare --overrides would otherwise read as "no overrides" and drop every hand grade without a word)
if (oi >= 0 && (noi >= 0 || !argv[oi + 1] || argv[oi + 1].startsWith('--'))) { console.error('import: --overrides needs a path (and not --no-overrides with it)'); process.exit(2); }
const OVERRIDES = oi >= 0 ? argv.splice(oi, 2)[1] : noi >= 0 ? (argv.splice(noi, 1), null) : fileURLToPath(new URL('grade-overrides.jsonl', import.meta.url));
const overrides = new Map();
if (OVERRIDES) { // every check before the DB is written: a bad override aborts the whole import
  const bad = [];
  if (!fs.existsSync(OVERRIDES)) bad.push('no such file');
  else fs.readFileSync(OVERRIDES, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim(), at = `line ${i + 1}`;
    if (!t || t.startsWith('#') || t.startsWith('//')) return;
    let r; try { r = JSON.parse(t); } catch (e) { return bad.push(`${at}: ${e.message}`); }
    if (typeof r?.id !== 'string' || !r.id) return bad.push(`${at}: no id`);
    if (!['A', 'B', 'C', 'D'].includes(r.tier)) bad.push(`${at} (${r.id}): tier ${JSON.stringify(r.tier)} is not A/B/C/D`);
    if (typeof r.why !== 'string' || !r.why.trim()) bad.push(`${at} (${r.id}): no why`);
    if (overrides.has(r.id)) bad.push(`${at} (${r.id}): duplicate id`);
    overrides.set(r.id, r.tier);
  });
  if (bad.length) { console.error(`refusing grade overrides ${OVERRIDES}:\n  ${bad.join('\n  ')}`); process.exit(2); }
}
const si = argv.indexOf('--swing');
if (si >= 0 && (!argv[si + 1] || argv[si + 1].startsWith('--'))) { console.error('import: --swing needs a path'); process.exit(2); } // (else no scores, without a word)
// Default: the newest scoring pass (v4). An older sidecar would silently revert turn and erase flaw for every puzzle in the DB.
const SWING = si >= 0 ? argv.splice(si, 2)[1] : fs.existsSync('data/swing/swing-v4.jsonl') ? 'data/swing/swing-v4.jsonl' : null;
// Refuse a superseded sidecar. The -v4 files carry the syn6 Syntaks screen's corrections, so importing an older scoring
// pass would revert turn/swing/flaw for every puzzle it covers. A sidecar is refused (exit 2) when any of these holds:
//  1. name: it is <family>[-vN].jsonl (case-insensitive, as APFS is; no suffix = v1), by the name given or after resolving
//     symlinks (fs.realpathSync.native), and a newer <family>-vM.jsonl (M > N) sits next to it or in data/swing/;
//  2. identity: it is the same file (dev+inode: a hardlink or symlink under any name) as such a superseded sidecar;
//  3. content (a copy kept elsewhere, under any name or version number): an id that another sidecar next to it or in
//     data/swing/ marks with `syn6` (a row the syn6 change-set rewrote) appears here without the marker.
// --allow-superseded skips all three. A --swing path that does not exist is an error.
const ai = argv.indexOf('--allow-superseded'), allowOld = ai >= 0 && argv.splice(ai, 1).length > 0;
const unknown = argv.filter((a) => a.startsWith('--'));
if (unknown.length) { console.error(`import: unknown option ${unknown.join(' ')}`); process.exit(2); }
if (SWING && !fs.existsSync(SWING)) { console.error(`no such sidecar: ${SWING}`); process.exit(2); }
if (SWING && !allowOld) {
  const famOf = (f) => { const m = path.basename(f).match(/^(.+?)(?:-v(\d+))?\.jsonl$/i); return m && { fam: m[1].toLowerCase(), v: +(m[2] || 1) }; };
  const real = fs.realpathSync.native(SWING), st = fs.statSync(real);
  const dirs = [...new Set([path.dirname(path.resolve(SWING)), path.dirname(real), 'data/swing'].filter((d) => fs.existsSync(d)).map((d) => fs.realpathSync.native(d)))];
  const cands = dirs.flatMap((d) => fs.readdirSync(d).map((f) => path.join(d, f))).filter((f) => famOf(f) && fs.statSync(f).isFile());
  const newest = new Map();
  for (const f of cands) { const x = famOf(f); if (x.v > (newest.get(x.fam)?.v ?? 0)) newest.set(x.fam, { v: x.v, f }); }
  const older = (f) => { const x = famOf(f); return x && newest.has(x.fam) && newest.get(x.fam).v > x.v ? newest.get(x.fam).f : null; };
  const why = new Set();
  for (const f of [SWING, real]) if (older(f)) why.add(`${path.basename(f)} is superseded by ${older(f)}`);
  for (const f of cands) {
    const o = older(f), fst = o && fs.statSync(f);
    if (o && fst.dev === st.dev && fst.ino === st.ino) why.add(`same file (dev+inode) as ${f}, superseded by ${o}`);
  }
  const marked = new Map(); // id -> a sidecar that marks it
  for (const f of cands) {
    const fst = fs.statSync(f); if (fst.dev === st.dev && fst.ino === st.ino) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line.includes('"syn6"')) { const r = JSON.parse(line); if (r.syn6) marked.set(r.id, f); }
  }
  if (marked.size) {
    const lack = [];
    for (const line of fs.readFileSync(real, 'utf8').split('\n')) if (line.trim()) { const r = JSON.parse(line); if (marked.has(r.id) && !r.syn6) lack.push(r.id); }
    if (lack.length) why.add(`${lack.length} ids that ${[...new Set(lack.map((i) => marked.get(i)))].join(', ')} mark(s) syn6 lack the marker here (e.g. ${lack.slice(0, 3).join(' ')}): an older pass`);
  }
  if (why.size) {
    console.error(`refusing sidecar ${SWING}: ${[...why].join('; ')}. Importing it would revert the newer turn/swing/flaw. Use the newest, or pass --allow-superseded.`);
    process.exit(2);
  }
}
const dir = argv[0] || 'data/puzzles';
const side = new Map();
if (SWING && fs.existsSync(SWING))
  for (const line of fs.readFileSync(SWING, 'utf8').split('\n')) if (line.trim()) { const r = JSON.parse(line); side.set(r.id, r); }
const swingOf = (r) => JSON.stringify(Object.fromEntries(SWING_KEYS.map((k) => [k, r[k] ?? null])));
const setTurnRaw = db.prepare('UPDATE puzzles SET turn = ?, swing = ?, flaw = ? WHERE id = ?');
const flawOf = (r) => ((Array.isArray(r?.alts) && r.alts.length) || (r?.altsAt && Object.keys(r.altsAt).length) ? 1 : null);
const setTurn = { run: (turn, swing, id) => setTurnRaw.run(turn, swing, swing ? flawOf(JSON.parse(swing)) : null, id) };
// Grades: from the sidecar, else from a deploy export's own grade field (always present there; null = ungraded).
const setGrade = db.prepare('UPDATE puzzles SET grade = ? WHERE id = ?');
const grades = new Map();
if (GRADES) for (const line of fs.readFileSync(GRADES, 'utf8').split('\n')) if (line.trim()) { const r = JSON.parse(line); grades.set(r.id, r.grade ?? r.tier ?? null); }
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
const up = db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, source_ref, init_rating, rating, komi, meta)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET size=excluded.size, tps=excluded.tps, plies=excluded.plies, tree=excluded.tree, themes=excluded.themes,
    source=excluded.source, source_ref=excluded.source_ref, init_rating=excluded.init_rating, komi=excluded.komi, meta=excluded.meta,
    rating = CASE WHEN puzzles.attempts = 0 THEN excluded.rating ELSE puzzles.rating END`);
const byTps = new Map(db.prepare('SELECT id, tps FROM puzzles').all().map((r) => [r.tps, r.id]));
// rev (B2): the old judged content goes to puzzle_rev before the row is overwritten.
const getOld = db.prepare('SELECT tree, tps, komi, rev FROM puzzles WHERE id = ?');
const insRev = db.prepare('INSERT INTO puzzle_rev (id, rev, tree, komi, tps, ts) VALUES (?,?,?,?,?,?)'); // a duplicate (id, rev) fails the import
const setRev = db.prepare('UPDATE puzzles SET rev = ? WHERE id = ?');
const now = Date.now();
let n = 0, dup = 0, revs = 0;
db.exec('BEGIN');
for (const f of files) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const p = withHistory(JSON.parse(line));
    const other = byTps.get(p.tps);
    if (other && other !== p.id) { dup++; continue; }
    byTps.set(p.tps, p.id);
    const old = getOld.get(p.id), tree = JSON.stringify(p.tree);
    // 'tak' was an internal tag (multi-ply and no quiet move), never a theme; a re-import drops it.
    up.run(p.id, p.size, p.tps, p.plies, tree, (p.tags || []).filter((t) => t !== 'tak').join(','), p.source, p.sourceRef || null,
      p.rating, p.rating, p.komi || 0, JSON.stringify(p.meta || {}));
    if (old && (old.tree !== tree || old.tps !== p.tps || (old.komi || 0) !== (p.komi || 0))) {
      insRev.run(p.id, old.rev ?? 0, old.tree, old.komi, old.tps, now);
      setRev.run((old.rev ?? 0) + 1, p.id);
      revs++;
    }
    // A deploy export always carries the keys (null = unscored), so crux mirrors the local DB exactly.
    if (!side.has(p.id) && Object.hasOwn(p, 'swing')) setTurn.run(turnOf(p.turn), p.swing ? swingOf(p.swing) : null, p.id);
    if (!grades.has(p.id) && Object.hasOwn(p, 'grade')) setGrade.run(p.grade ?? null, p.id);
    n++;
  }
}
// The sidecar covers every puzzle already in the DB, not just this directory's.
let scored = 0;
for (const r of side.values()) scored += Number(setTurn.run(turnOf(r.turn), swingOf(r), r.id).changes);
let graded = 0;
if (grades.size) { db.exec('UPDATE puzzles SET grade = NULL'); for (const [id, g] of grades) graded += Number(setGrade.run(g, id).changes); }
// Overrides last, so they win over the grades file and a deploy export's grade alike.
const getGrade = db.prepare('SELECT grade FROM puzzles WHERE id = ?');
let overridden = 0, overChanged = 0;
for (const [id, g] of overrides) {
  const row = getGrade.get(id); if (!row) continue; // not imported (yet): counted below, not an error
  overridden++; if (row.grade !== g) overChanged++;
  setGrade.run(g, id);
}
// Refund mark (flaw = 2; server.js REFUNDED ranks it last): a puzzle that cost someone a refund and has no stored
// alternative. A refund leaves its trace on the attempt: attempts.refund = 1 since refunds count as solves (2026-11-20),
// or before that the legacy signature (rated = 0, win = 0, user_delta <> 0; an attempt recorded unrated has user_delta 0)
// until scripts/refund-legacy-wins.mjs has run (REFUNDED_SQL, server/log.js). flaw is rewritten above from swing on
// every import, so the mark is re-derived here, from the attempts of the DB being imported into (crux's on a deploy).
// It goes away by itself once the puzzle gets stored alternatives (flaw = 1, the move is accepted at once).
// REFUND_MARK is also what to run by hand right after a refund (docs/alt-wins.md, Refunds).
const REFUND_MARK = `UPDATE puzzles SET flaw = 2 WHERE flaw IS NULL AND id IN
  (SELECT puzzle_id FROM attempts WHERE ${REFUNDED_SQL('attempts')})`; // (attempts.refund: added at the server's startup, which importing db ran)
const marked = Number(db.prepare(REFUND_MARK).run().changes);
// Book rows (B2), last, inside the same transaction: planned against the live book as this transaction sees it (the
// import's writes above already hold the write lock, so nothing changes under the plan), then inserted as one version.
// A conflict, a refused retirement or an incomplete version rolls back everything, puzzles included.
let book = null;
if (BOOK) {
  try {
    const plan = planPublish(db, { rows: bookRows });
    const rp = plan.report;
    if (rp.conflicts.length || rp.refused.length) {
      const e = new Error(`${rp.conflicts.length} length conflicts with the live book, e.g. ${JSON.stringify(rp.conflicts.slice(0, 3))}`);
      throw e;
    }
    const live = db.prepare('SELECT * FROM book WHERE pos = ? AND retired_ver IS NULL');
    const retire = db.prepare('UPDATE book SET retired_ver = ? WHERE pos = ? AND ver = ? AND retired_ver IS NULL');
    const ins = db.prepare('INSERT INTO book (pos, ver, win_len, exact, model, proof, checked, puzzle_id, commit_sha, ts) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const r of plan.adds) {
      for (const a of live.all(r.pos)) if (Number(retire.run(plan.ver, a.pos, a.ver).changes) !== 1) throw new Error(`book row ${a.pos} v${a.ver} changed under the import`);
      ins.run(r.pos, plan.ver, r.win_len, r.exact, r.model, r.proof, r.checked, r.puzzle_id ?? null, r.commit_sha || BOOK_COMMIT, now);
    }
    const added = plan.adds.length, retired = Number(db.prepare('SELECT COUNT(*) n FROM book WHERE retired_ver = ?').get(plan.ver).n);
    if (added) db.prepare('INSERT INTO book_ver (ver, ts, commit_sha, added, retired, note) VALUES (?,?,?,?,?,?)').run(plan.ver, now, BOOK_COMMIT, added, retired, BOOK_NOTE);
    book = { ver: added ? plan.ver : null, added, retired, kept: rp.kept, lengthChanges: rp.lengthChanges };
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`import: REFUSED, nothing written (puzzles included): book rows from ${BOOK}: ${e.message}`);
    process.exit(1);
  }
}
db.exec('COMMIT');
// State columns (server/puzzle-state.js) from the turn/grade/swing just committed; the holds are this import's overrides
// (none with --no-overrides). After the COMMIT, not inside it: scanning all ~71k rows inside the import's transaction held
// crux's write lock ~250 ms longer on every publish (~1.2 s on the first), while results posted to the server
// waited. Here the scan holds no lock and only changed rows are written, in short transactions. The stored
// status decides what is served (PLAN P2), so a failure here is loud: the import has committed, but the process exits 4
// after its report, and scripts/puzzle-state.mjs must be run before the server is (re)started on this database.
let state;
db.exec('PRAGMA busy_timeout = 5000'); // this process's connection only: wait for the server's writes instead of failing
try { state = backfillPuzzleState(db, { held: heldIds(OVERRIDES) }); } catch (e) { state = { error: e.message }; }
console.log(`imported ${n} puzzles from ${files.length} files (${dup} duplicate positions skipped)`);
console.log(db.prepare('SELECT plies, size, COUNT(*) n, ROUND(AVG(rating)) avg FROM puzzles GROUP BY plies, size ORDER BY plies, size').all());
console.log(side.size ? `turning-point scores from ${SWING}: ${scored} of ${side.size} matched a puzzle` : `no turning-point sidecar (${SWING})`,
  db.prepare('SELECT turn, COUNT(*) n FROM puzzles GROUP BY turn ORDER BY turn').all());
console.log(state.error ? `puzzle state: NOT updated (${state.error}); run scripts/puzzle-state.mjs` : `puzzle state (kind, status, pre0, miner): ${state.changed} of ${state.rows} rows updated`);
if (revs) console.log(`puzzle rev: ${revs} puzzles changed tree, tps or komi; their old rev is kept in puzzle_rev`);
if (book) console.log(book.ver ? `book: version ${book.ver} added ${book.added} rows, retired ${book.retired}, kept ${book.kept} (served only once TINUE_BOOK_VER >= ${book.ver})`
  : `book: nothing added (${book.kept} rows already held or weaker)`);
if (book?.lengthChanges.length) console.log(`book: ${book.lengthChanges.length} length changes, e.g. ${JSON.stringify(book.lengthChanges.slice(0, 5))}`);
if (marked) console.log(`refund mark (flaw = 2): ${marked} puzzles with a refunded miss and no stored alternative`);
if (grades.size) console.log(`conversion grades from ${GRADES}: ${graded} of ${grades.size} matched`, db.prepare('SELECT grade, COUNT(*) n FROM puzzles WHERE turn = 0 GROUP BY grade ORDER BY grade').all());
if (OVERRIDES) console.log(`grade overrides from ${OVERRIDES}: ${overridden} applied, ${overChanged} changed a grade, ${overrides.size - overridden} not in the DB`);
if (state.error) {
  console.error(`import: FAILED AFTER COMMIT: the puzzles were imported but the puzzle state columns (status decides what is served) were NOT updated: ${state.error}\n`
    + 'import: run  node --no-warnings scripts/puzzle-state.mjs  on this database before (re)starting the server.');
  process.exit(4);
}
