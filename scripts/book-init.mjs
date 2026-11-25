// B1c (docs/plan/PLAN.md §1.1, acceptance A2): fill the book from a database's stored wins, as one book version.
//   node --no-warnings scripts/book-init.mjs <db> [--dry-run] [--commit <sha>] [--report <out.json>]
//        [--deep deep/target/release/deep] [--deep-nodes 4000000] [--deep-secs 20] [--js-nodes 300000] [--jobs N] [--limit N]
//        [--chunk 1000] [--pause-ms 50] [--exclude scripts/book-exclude.json] [--resume <db>.book-proofs.jsonl | none]
//        [--retry-failed] (--server-has-busy-timeout | --server-stopped: required unless --dry-run)
// Sources: the tree keys of every turning point and A-grade puzzle (turn = 1 OR grade = 'A': a superset of the served
// pool on purpose, so a paused or rejected row keeps its proofs if it returns) and of every 7x7/8x8 puzzle (stage 2 serves those), and every stored alt of the same puzzles (swing.alts, swing.altsAt).
//   tree key -> proof 'tree', win_len = 1 + depth(next node), model 'threat', exact 0, checked 0.
//   alt      -> re-proved from the position after it (defender to move): 6x6 by `deep prove and=1` (q=0, then q=1),
//               whose checker walks every proof; other sizes by shared/pns.js TinueSearch with fullDefense, deepened
//               2, 4, 6, ... plies (exact when every shorter depth failed within budget). A proof -> checked 1 with its
//               length; no proof -> kept as checked 0, win_len NULL, model 'threat' (the weakest: nothing
//               was proved under any model; any later proof replaces it), and listed, disproofs marked. An alt that ends the game at once needs no row (the rules see it).
//   scripts/book-exclude.json lists decided-bad alts. Each entry is resolved up front to the position after it (its move
//   and path spelled any way the rules read them; an entry that is not a stored alt of its puzzle stops the run, exit
//   2), and that position is left out whoever reaches it (another puzzle's alt or tree key too; a tree key there fails
//   A2). A2 is checked against the plan before anything is written: a failing A2 writes nothing.
// Writes only the book, book_node and book_ver tables (server/book.js planPublish + writePublish): the plan is made
// read-only first, and a length conflict writes nothing. The rows then go in transactions of --chunk rows (BEGIN
// IMMEDIATE, busy timeout 5 s, --pause-ms between chunks); the book_ver row goes last and marks the version complete.
// While a chunk holds the write lock, a server write waits only if the server's connection has a busy timeout; without
// one it fails at once ('database is locked': a lost result or rating). server/server.js sets busy_timeout = 5000, so
// --server-has-busy-timeout holds for the production server. A
// run that writes must say which holds: --server-has-busy-timeout (the server's DB is opened with a timeout) or
// --server-stopped; without either it stops before anything (exit 2). A dry run needs neither. A run killed while writing leaves an incomplete version, which
// lookups ignore and the next run continues, taking back any row in it that its own plan does not call for (A2 on the
// plan counts rows of an incomplete version only through the plan). Idempotent: a re-run adds nothing it already has.
// Each re-proof is appended to the resume file (default <db>.book-proofs.jsonl, --resume none for no file) as it
// finishes; a re-run after a kill takes proofs from it and proves only the rest (--retry-failed proves recorded
// failures again, e.g. with bigger budgets), and skips alts the book already holds with a checked length.
// One run per database at a time: <db>.book-init.lock (O_EXCL, holds the pid) is taken first, dry run too, and removed
// on exit (also on SIGINT/SIGTERM before the write). The write itself is synchronous, so a JS signal handler could not
// run until it had finished; the handlers are dropped just before it, and SIGINT/SIGTERM then stop the run at once
// (the open chunk rolls back, the incomplete version is continued by the next run) but leave the lock, as -9 does: the
// next run stops (exit 2) and says so; remove the file once that pid is gone. (Inside the write, a chunk also refuses a version another run has completed.)
// --dry-run opens the database read-only and works on an in-memory copy of its book (the resume file is still
// written). Progress goes to stderr (at least every 30 s while proving). Prints the A2 report; exit 1 if A2 fails, exit 3 if
// the run itself failed (a write may have left an incomplete version: run again to continue it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Game } from '../shared/tak.js';
import { TinueSearch, proofTreeLine } from '../shared/pns.js';
import { puzzleWins, puzzleStart, halfKomi, bookKey } from '../shared/book.js';
import { initBook, planPublish, writePublish, bookLookup } from '../server/book.js';

// Worker (non-6x6 re-proofs in parallel): [{ pos, tps, komi }] -> [[pos, proof]].
function jsProve({ tps, komi }, jsNodes) {
  const g = Game.fromTPS(tps, komi), att = 3 - g.toMove;
  const isBudget = (e) => e?.message === 'budget';
  const s = new TinueSearch(g.clone(), { maxNodes: jsNodes, fullDefense: true }); s.att = att;
  let found = 0, budget = false;
  try { for (let d = 2; d <= 40 && !found; d += 2) if (s.solve(d)) found = d; } catch (e) { if (!isBudget(e)) throw e; budget = true; }
  if (found) return { win_len: found, exact: 1, model: 'threat', how: 'pns fullDefense id' };
  const u = new TinueSearch(g.clone(), { maxNodes: jsNodes, fullDefense: true }); u.att = att;
  let ok = false;
  try { ok = u.solve(Infinity); } catch (e) { if (!isBudget(e)) throw e; budget = true; }
  const L = ok ? proofTreeLine(u).plies : 0;
  return L > 0 ? { win_len: L, exact: 0, model: 'threat', how: 'pns fullDefense' } : { fail: budget ? 'pns budget' : 'pns: no threat tinue with full defence', disproved: !budget };
}
if (!isMainThread) { // one position per message, so a slow position holds up only its own worker
  parentPort.on('message', (x) => parentPort.postMessage(x ? [x.pos, jsProve(x, workerData.jsNodes)] : null));
} else {
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const bool = (k) => { const i = args.indexOf(k); return i >= 0 ? (args.splice(i, 1), true) : false; };
const dryRun = bool('--dry-run');
const serverWaits = bool('--server-has-busy-timeout'), serverStopped = bool('--server-stopped');
const reportFile = flag('--report', null);
const excludeFile = flag('--exclude', null);
const resumeOpt = flag('--resume', null), retryFailed = bool('--retry-failed');
const DEEP = flag('--deep', path.join(ROOT, 'deep/target/release/deep'));
const deepNodes = +flag('--deep-nodes', 4e6), deepSecs = +flag('--deep-secs', 20), jsNodes = +flag('--js-nodes', 3e5);
const chunk = Math.max(1, +flag('--chunk', 1000)), pauseMs = Math.max(0, +flag('--pause-ms', 50));
const limit = +flag('--limit', 0), jobs = Math.max(1, +flag('--jobs', Math.max(1, Math.floor(os.cpus().length / 2))));
let commitSha = flag('--commit', null);
const dbPath = args[0];
if (!dbPath || args.length !== 1) { console.error('usage: book-init.mjs <db> [--dry-run] [--commit sha] [--report out.json] [--deep path] [--limit N]'); process.exit(2); }
if (!fs.existsSync(dbPath)) { console.error('no such database: ' + dbPath); process.exit(2); }
if (!dryRun && !serverWaits && !serverStopped) {
  console.error('book-init writes the live book in chunks that hold the write lock; a server connection without a busy timeout fails its writes meanwhile.\n'
    + 'Pass --server-has-busy-timeout (the server opens the DB with a timeout) or --server-stopped, or use --dry-run.');
  process.exit(2);
}
const lockFile = fs.realpathSync(dbPath) + '.book-init.lock'; // the real path: one lock however the database is named
try { const fd = fs.openSync(lockFile, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); } catch (e) {
  if (e.code !== 'EEXIST') throw e;
  const pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
  let alive = false; try { process.kill(pid, 0); alive = true; } catch (k) { alive = k.code === 'EPERM'; }
  console.error(alive ? `another book-init (pid ${pid}) holds ${lockFile}: wait for it or stop it`
    : `${lockFile} is left by pid ${pid || '?'}, which is not running (killed while writing, or with -9?): remove the file and run again`);
  process.exit(2);
}
process.on('exit', () => { try { if (fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.rmSync(lockFile); } catch {} });
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(sig, () => process.exit(code));
process.on('uncaughtException', (e) => { console.error(e); process.exit(3); }); // not 1: that is "A2 failed"
const resumeFile = resumeOpt === 'none' ? null : resumeOpt ?? dbPath + '.book-proofs.jsonl';
if (!commitSha) {
  const r = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' });
  commitSha = r.status === 0 ? r.stdout.trim() : null;
  if (!commitSha) { console.error('no git here: pass --commit <sha>'); process.exit(2); }
}
const t0 = Date.now();
const progress = (...a) => console.error(`[book-init ${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
const SERVED = "(turn = 1 OR grade = 'A')"; // a superset of the served pool, on purpose (header)
const EXCLUDE = JSON.parse(fs.readFileSync(excludeFile ?? path.join(ROOT, 'scripts/book-exclude.json'), 'utf8'));

// The source is read-only in a dry run; the book is then built in memory from a copy of the source's book.
const src = new DatabaseSync(dbPath, { readOnly: dryRun, timeout: 5000 }); // wait for the server's writes, never fail on them
let db = src;
if (dryRun) {
  db = new DatabaseSync(':memory:');
  initBook(db);
  const has = (t) => src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  for (const t of ['book', 'book_node', 'book_ver']) if (has(t)) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const ins = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    db.exec('BEGIN');
    for (const r of src.prepare(`SELECT ${cols.join(',')} FROM ${t}`).iterate()) ins.run(...cols.map((c) => r[c]));
    db.exec('COMMIT');
  }
} else initBook(db);

// Every exclusion entry -> the position after its move (move and path canonicalised by replaying them), which must be
// a stored alt of its puzzle. Anything else stops the run before any work: a stale entry never passes A2 unseen.
const excludedPos = new Map(), badExclusions = [];
for (const e of EXCLUDE) {
  const p = src.prepare('SELECT id, tps, komi, tree, swing FROM puzzles WHERE id = ?').get(e.puzzle);
  let pos = null, why = p ? null : 'no such puzzle';
  if (p) try {
    const g = puzzleStart(p.tps, p.komi);
    for (const m of [...String(e.path).split(' ').filter(Boolean), e.move]) g.play(g.canon(m));
    if (g.result()) why = 'the move ends the game (nothing to exclude)';
    else if (!puzzleWins(p).some((w) => w.kind === 'alt' && w.pos === bookKey(g, p.komi))) why = 'not a stored alt of the puzzle';
    else pos = bookKey(g, p.komi);
  } catch (err) { why = err.message; }
  if (pos) excludedPos.set(pos, e); else badExclusions.push({ ...e, why });
}
if (badExclusions.length) {
  for (const b of badExclusions) console.error('exclusion entry does not resolve:', JSON.stringify(b));
  process.exit(2);
}

const puzzles = src.prepare(`SELECT id, size, tps, komi, plies, tree, swing, ${SERVED} AS served FROM puzzles
  WHERE ${SERVED} OR size IN (7, 8) ORDER BY id${limit ? ' LIMIT ' + limit : ''}`).all();

const rows = [], walkErrors = [], treePos = new Map(), alts = [], excludedHit = [], excludedTree = [];
let gameEnding = 0;
for (const p of puzzles) {
  let wins;
  try { wins = puzzleWins(p); } catch (e) { walkErrors.push({ puzzle: p.id, error: e.message }); continue; }
  for (const w of wins) {
    if (w.kind === 'tree') {
      if (!w.pos) continue; // a tree key never ends the game ('win' nodes have no key), but be safe
      if (excludedPos.has(w.pos)) { excludedTree.push({ puzzle: p.id, path: w.path.join(' '), move: w.move, pos: w.pos }); continue; }
      rows.push({ pos: w.pos, win_len: w.winLen, exact: 0, model: 'threat', proof: 'tree', checked: 0, puzzle_id: p.id });
      treePos.set(w.pos, { puzzle: p.id, size: p.size, served: !!p.served });
      continue;
    }
    if (w.pos && excludedPos.has(w.pos)) { excludedHit.push({ puzzle: p.id, path: w.path.join(' '), move: w.move, pos: w.pos }); continue; }
    if (!w.pos) { gameEnding++; continue; }
    alts.push({ puzzle: p.id, size: p.size, komi: p.komi, path: w.path.join(' '), move: w.move, pos: w.pos, served: !!p.served });
  }
}

// Re-proof, once per position (pos includes komi).
const byPos = new Map();
for (const a of alts) { if (!byPos.has(a.pos)) byPos.set(a.pos, []); byPos.get(a.pos).push(a); }
const gameAfter = (a) => { const p = puzzleRow(a.puzzle); const g = puzzleStart(p.tps, p.komi); for (const m of [...a.path.split(' ').filter(Boolean), a.move]) g.play(g.canon(m)); return g; };
const pcache = new Map();
function puzzleRow(id) { if (!pcache.has(id)) pcache.set(id, src.prepare('SELECT tps, komi FROM puzzles WHERE id = ?').get(id)); return pcache.get(id); }

// Proofs are appended to the resume file as each one finishes ({pos, ...proof} per line; {pos, q0fail} for a 6x6
// position deep q=0 could not prove, which goes straight to q=1 next time), so a killed run loses at most the positions
// in flight. A re-run takes every proof (and failure, unless --retry-failed) from the file, and skips positions the
// book already holds with a checked length. A proof depends only on the position (komi included), so the file stays
// valid for any database.
const proofs = new Map(), q0failed = new Set(); // pos -> { win_len, exact, model, how } | { fail, disproved }
if (resumeFile && fs.existsSync(resumeFile)) {
  for (const l of fs.readFileSync(resumeFile, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let x; try { x = JSON.parse(l); } catch { continue; } // a line cut by a kill
    const { pos, q0fail, ...pr } = x;
    if (!byPos.has(pos)) continue;
    if (q0fail) { q0failed.add(pos); continue; }
    if (pr.fail && retryFailed) continue;
    proofs.set(pos, { ...pr, how: pr.how ?? (pr.fail ? undefined : 'resume') });
  }
}
const resumed = proofs.size;
const liveProved = db.prepare('SELECT 1 FROM book WHERE pos = ? AND retired_ver IS NULL AND checked = 1 AND win_len IS NOT NULL AND ver IN (SELECT ver FROM book_ver) LIMIT 1');
const skipLive = new Set([...byPos.keys()].filter((pos) => !proofs.has(pos) && liveProved.get(pos)));
const rfd = resumeFile ? fs.openSync(resumeFile, 'a') : null;
const record = (pos, x) => { if (rfd !== null) fs.writeSync(rfd, JSON.stringify({ pos, ...x }) + '\n'); };
const todo = [...byPos.keys()].filter((pos) => !proofs.has(pos) && !skipLive.has(pos));
progress(`alts: ${byPos.size} positions; ${resumed} from ${resumeFile ?? '(no resume file)'}, ${skipLive.size} already proved in the book, ${todo.length} to prove`);
const ticker = (stage, total) => {
  let done = 0, failed = 0, last = 0;
  return (ok) => {
    done++; if (!ok) failed++;
    if (done === total || Date.now() - last > 30000) { last = Date.now(); progress(`${stage}: ${done}/${total}, ${failed} not proved`); }
  };
};

// 6x6: deep prove and=1 (the side to move defends), q=0 then q=1 for what is left; deep prints one line per position
// as it finishes, read as it comes.
const six = todo.filter((pos) => byPos.get(pos)[0].size === 6);
const tDeep0 = Date.now();
if (six.length) {
  if (!fs.existsSync(DEEP)) { console.error(`${DEEP} missing: cd deep && cargo build --release (or --deep <path>)`); process.exit(2); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'book-init-'));
  const run = (list, q, onLine) => new Promise((resolve, reject) => {
    const f = path.join(tmp, `q${q}.txt`);
    fs.writeFileSync(f, list.map((pos) => `${gameAfter(byPos.get(pos)[0]).toTPS()}|${halfKomi(byPos.get(pos)[0].komi)}`).join('\n') + '\n');
    const child = spawn(DEEP, ['prove', f, 'and=1', `q=${q}`, `nodes=${deepNodes}`, `secs=${deepSecs}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    readline.createInterface({ input: child.stdout }).on('line', (l) => { const f2 = l.split('\t'); if (f2.length > 2 && /^\d+$/.test(f2[0]) && list[+f2[0]]) onLine(list[+f2[0]], f2); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 || code === 1 ? resolve() : reject(new Error(`deep prove exited ${code}: ${err}`))));
  });
  let left = six.filter((pos) => !q0failed.has(pos));
  const carried = six.filter((pos) => q0failed.has(pos));
  for (const q of [0, 1]) {
    const seen = new Set(), tick = ticker(`deep q=${q}`, left.length);
    if (left.length) await run(left, q, (pos, f2) => {
      seen.add(pos);
      const ok = f2[1] === 'proved' && +f2[2] > 0;
      tick(ok);
      if (ok) { const pr = { win_len: +f2[2], exact: 0, model: q ? 'threat+1quiet' : 'threat', how: `deep q=${q}` }; proofs.set(pos, pr); record(pos, pr); return; }
      const pr = { fail: `deep q=${q}: ${f2.slice(1, 2).concat(f2.slice(6)).join(' ')}`, disproved: f2[1] === 'disproved' };
      proofs.set(pos, pr);
      record(pos, q ? pr : { q0fail: true });
    });
    for (const pos of left) if (!seen.has(pos)) { proofs.set(pos, { fail: `deep q=${q}: no output` }); if (q) record(pos, proofs.get(pos)); }
    left = q ? [] : [...left.filter((pos) => proofs.get(pos).fail), ...carried];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
const tDeep = Date.now() - tDeep0;
// Other sizes: TinueSearch with every defender move, deepened 2, 4, 6, ...; past 40 plies (or on a budget) an
// unlimited proof gives an upper bound (exact 0).
const tJs0 = Date.now();
{
  const items = todo.filter((pos) => byPos.get(pos)[0].size !== 6).map((pos) => ({ pos, tps: gameAfter(byPos.get(pos)[0]).toTPS(), komi: byPos.get(pos)[0].komi }));
  const tick = ticker('pns', items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, () => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { jsNodes } });
    const feed = () => { if (next < items.length) w.postMessage(items[next++]); else { w.terminate(); resolve(); } };
    w.on('message', (m) => { if (m) { proofs.set(m[0], m[1]); record(m[0], m[1]); tick(!m[1].fail); } feed(); });
    w.once('error', reject);
    feed();
  })));
}
const tJs = Date.now() - tJs0;
if (rfd !== null) fs.closeSync(rfd);

const failures = [];
for (const [pos, list] of byPos) {
  if (skipLive.has(pos)) continue; // the book already holds a checked length for it
  const pr = proofs.get(pos);
  if (pr.fail) {
    for (const a of list) failures.push({ puzzle: a.puzzle, path: a.path, move: a.move, size: a.size, pos, why: pr.fail, disproved: !!pr.disproved });
    rows.push({ pos, win_len: null, exact: 0, model: 'threat', proof: 'alt', checked: 0, puzzle_id: list[0].puzzle });
  } else rows.push({ pos, win_len: pr.win_len, exact: pr.exact, model: pr.model, proof: 'alt', checked: 1, puzzle_id: list[0].puzzle });
}

// The plan (reads only), A2 against it, and only on a pass the write (dry run: to the in-memory copy).
let plan = null, error = null;
try { plan = planPublish(db, { rows, resume: true }); } catch (e) { error = e.message; }
const servedTree = [...treePos].filter(([, t]) => t.served);
const a2check = (has) => {
  const missingTree = servedTree.filter(([pos]) => !has(pos)).map(([pos, t]) => ({ pos, puzzle: t.puzzle }));
  const missing78 = [...treePos].filter(([, t]) => !t.served).filter(([pos]) => !has(pos)).length;
  const missingAlts = alts.filter((a) => !has(a.pos)).map((a) => ({ puzzle: a.puzzle, path: a.path, move: a.move }));
  const excludedPresent = [...excludedPos.keys()].filter((pos) => has(pos));
  const pass = !error && !plan.report.conflicts.length && !missingTree.length && !missingAlts.length && !excludedPresent.length && !excludedTree.length && !walkErrors.length;
  return { missingTree, missing78, missingAlts, excludedPresent, pass };
};
// What the book will hold: the plan's rows (added now, or already written in the version it resumes), and rows live in
// complete versions (a row in an incomplete version counts only through the plan: the write takes back the rest).
const adding = new Set(plan ? [...plan.adds.map((r) => r.pos), ...plan.written] : []);
const liveRow = db.prepare(`SELECT 1 FROM book WHERE pos = ? AND ver IN (SELECT ver FROM book_ver)
  AND (retired_ver IS NULL OR retired_ver NOT IN (SELECT ver FROM book_ver)) LIMIT 1`);
const planned = plan ? a2check((pos) => adding.has(pos) || !!liveRow.get(pos)) : { pass: false, missingTree: [], missing78: 0, missingAlts: [], excludedPresent: [] };
let pub = plan?.report ?? { added: 0, retired: 0, kept: 0, conflicts: [], lengthChanges: [] }, wrote = false;
if (planned.pass) {
  progress(`A2 holds on the plan; writing ${plan.adds.length} rows in chunks of ${chunk}`);
  const onChunk = (done, n) => { if (done === n || Math.floor(done / chunk) % 50 === 0) progress(`written ${done}/${n}`); };
  // writePublish never yields to the event loop: drop the handlers so a signal takes its default action (stop now).
  for (const sig of ['SIGINT', 'SIGTERM']) process.removeAllListeners(sig);
  pub = writePublish(db, plan, { commitSha, note: `book-init ${path.basename(dbPath)}: ${puzzles.length} puzzles`, chunk, pauseMs, onChunk });
  wrote = true;
} else if (!error) error = 'A2 fails on the plan: nothing written';
const ver = db.prepare('SELECT MAX(ver) v FROM book_ver').get().v ?? 0;

// A2 again on what the book now holds (the lookups a judge would make at the newest complete version).
const live = (pos) => bookLookup(db, pos, ver);
const { missingTree, missing78, missingAlts, excludedPresent, pass: livePass } = wrote ? a2check(live) : planned;
if (wrote && !livePass) error = 'A2 held on the plan but not on the written book';
const count = (t, w = '') => db.prepare(`SELECT COUNT(*) n FROM ${t} ${w}`).get().n;
const bySize = (list) => list.reduce((m, x) => ((m[x.size] = (m[x.size] || 0) + 1), m), {});
const report = {
  db: dbPath, dryRun, commitSha, ver, error,
  puzzles: puzzles.length, servedPuzzles: puzzles.filter((p) => p.served).length,
  treeEntries: rows.filter((r) => r.proof === 'tree').length, treePositions: treePos.size, servedTreePositions: servedTree.length,
  altEntries: alts.length, altPositions: byPos.size, altsGameEnding: gameEnding,
  reproved: byPos.size - skipLive.size - new Set(failures.map((f) => f.pos)).size, reproofFailures: failures.length, reproofFailurePositions: new Set(failures.map((f) => f.pos)).size,
  proofsResumed: resumed, alreadyProvedInBook: skipLive.size, reproofFailuresBySize: bySize(failures), reproofDisproofs: failures.filter((f) => f.disproved).length, proofsBy: [...proofs.values()].reduce((m, p) => ((m[p.how || 'fail'] = (m[p.how || 'fail'] || 0) + 1), m), {}),
  publish: { added: pub.added, retired: pub.retired, kept: pub.kept, conflicts: pub.conflicts, lengthChanges: pub.lengthChanges },
  a2: {
    conflicts: pub.conflicts.length,
    servedKeyCoverage: `${servedTree.length - missingTree.length}/${servedTree.length}`, missingTree,
    tree78Missing: missing78,
    altsPresent: `${alts.length - missingAlts.length}/${alts.length}`, missingAlts,
    excluded: [...excludedPos].map(([pos, e]) => ({ puzzle: e.puzzle, move: e.move, path: e.path, pos, notLoaded: !puzzles.some((p) => p.id === e.puzzle), absent: !excludedPresent.includes(pos) })),
    excludedReached: excludedHit, excludedTreeKeys: excludedTree,
  },
  rows: { book: count('book'), live: count('book', 'WHERE ver IN (SELECT ver FROM book_ver) AND (retired_ver IS NULL OR retired_ver NOT IN (SELECT ver FROM book_ver))'), book_node: count('book_node'), book_ver: count('book_ver') },
  walkErrors, failures,
  ms: { total: Date.now() - t0, deep: tDeep, js: tJs },
};
const pass = planned.pass && (!wrote || livePass);
report.a2.pass = pass;
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 1));
const { failures: _f, walkErrors: _w, ...brief } = report;
brief.a2 = { ...report.a2, missingTree: missingTree.slice(0, 20), missingAlts: missingAlts.slice(0, 20) };
console.log(JSON.stringify(brief, null, 1));
for (const f of failures.slice(0, 50)) console.log(f.disproved ? 'reproof DISPROVED' : 'reproof failed', f.puzzle, f.path ? `@${f.path}` : '@root', f.move, f.why);
if (failures.length > 50) console.log(`... ${failures.length - 50} more (--report for all)`);
for (const w of walkErrors) console.log('walk error', w.puzzle, w.error);
console.log(pass ? 'A2 pass' : 'A2 FAIL', dryRun ? '(dry run: nothing written)' : wrote ? '' : '(nothing written)');
process.exit(pass ? 0 : 1);
}
