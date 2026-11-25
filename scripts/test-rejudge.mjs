// Nightly re-judge (scripts/rejudge.mjs; PLAN step S4): the report renders on a fixture database and nothing is
// applied. Throwaway databases and report dirs in a temp dir only.   node --no-warnings scripts/test-rejudge.mjs
//
// The pd575074 fixture is the same SYNTHETIC stand-in as scripts/test-shadow.mjs's (the real position is only on crux).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-rejudge-'));
const F = path.join(dir, 'fixture.db');
delete process.env.TINUE_JUDGE;
Object.assign(process.env, { TINUE_DB: F, TINUE_SYNTAKS: '/nonexistent', TINUE_ACCESS_LOG: path.join(dir, 'access.log') });
const { db } = await import('../server/server.js'); // the server's schema on a throwaway DB (not listening)
const { publishBook } = await import('../server/book.js');
const { bookKey, puzzleStart } = await import('../shared/book.js');
const { rejudge, renderReport, beNice, REJUDGE_BUDGETS, DAY_MS, utcDay } = await import('./rejudge.mjs');

const PD = { id: 'pd575074', size: 6, komi: 2, tps: 'x6/x6/x6/2,2,12121,x3/x6/1,1,x4 1 10',
  tree: { d1: { r: 'f6', n: { e1: { r: 'a6', n: 'win' } } } } };
const PQ = { id: 'q-prov', size: 6, komi: 2, tps: 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14', tree: { b1: { r: 'f6', n: 'win' } } };
for (const p of [PD, PQ]) db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, komi) VALUES (?,?,?,?,?,'test',1500,1500,?)`)
  .run(p.id, p.size, p.tps, 3, JSON.stringify(p.tree), p.komi);
const NOW = Date.parse('2026-11-17T12:00:00Z');
let uid = 0;
function attempt(puzzleId, log, { rated = 1, result = 0, ago = 3600e3, mode = 'legacy' } = {}) {
  const u = ++uid, ts = NOW - ago;
  db.prepare("INSERT INTO users (id, name, token_hash, created_at) VALUES (?, ?, ?, 0)").run(u, 'u' + u, 'h' + u);
  db.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, ts, log, user_delta) VALUES (?,?,?,?,?,?,?)').run(u, puzzleId, result, rated, ts, JSON.stringify(log), -10);
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, "commit", mode, opened, closed, state, result, rated)
    VALUES (?,?,?,1,'',?,?,?,'closed',?,?)`).run('legacy-' + u, u, puzzleId, mode, ts, ts, result, rated);
  return { u, id: Number(id) };
}
const g = puzzleStart(PD.tps, 2); for (const m of ['d1', 'f6', '4c3+']) g.play(m);
publishBook(db, { rows: [{ pos: bookKey(g), win_len: 7, exact: 0, model: 'full', proof: 'rejudge', checked: 1, puzzle_id: PD.id }], commitSha: 'test' });
const A = {
  pd: attempt(PD.id, [{ m: 'd1', ms: 900, k: 'ok' }, { m: '4c3+', ms: 2100, k: 'miss' }]), // book -> refund proposal
  prov: attempt(PQ.id, [{ m: 'Cb1', ms: 700, k: 'miss' }], { ago: 2 * DAY_MS }), // the check proves it -> refund proposal
  no: attempt(PQ.id, [{ m: 'a1+', ms: 800, k: 'miss' }], { ago: 3 * DAY_MS }), // finished threat-only 'no' -> needs deep
  po: attempt(PQ.id, [{ m: 'a1>', ms: 800, k: 'miss' }, { m: 'b1', ms: 900, k: 'po' }], { ago: 4 * DAY_MS }), // a lost play-out
  bad: attempt(PQ.id, [{ m: 'zz9', ms: 800, k: 'miss' }]), // unreplayable
  done: attempt(PQ.id, [{ m: 'Cb1', ms: 700, k: 'miss' }]), // proven, but already refunded
  shadow: attempt(PQ.id, [{ m: 'Cb1', ms: 700, k: 'miss' }], { mode: 'shadow' }), // not a legacy row: counted only
  old: attempt(PQ.id, [{ m: 'Cb1', ms: 700, k: 'miss' }], { ago: 8 * DAY_MS }), // outside the window
  unrated: attempt(PQ.id, [{ m: 'Cb1', ms: 700, k: 'miss' }], { rated: 0 }),
  solved: attempt(PQ.id, [{ m: 'b1', ms: 700, k: 'ok' }], { result: 1 }),
};
db.prepare(`INSERT INTO rating_event (attempt_id, kind, ts, by, weight) VALUES (?, 'refund', ?, 'test', 1)`).run(A.done.id, NOW - 60e3);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const snapshot = (d) => JSON.stringify(['users', 'puzzles', 'attempts', 'attempt', 'ply', 'rating_event', 'book', 'book_node', 'book_ver']
  .map((t) => d.prepare(`SELECT * FROM ${t}`).all().map((r) => JSON.stringify(r)).sort()));
const ro = () => { const d = new DatabaseSync(F, { readOnly: true }); d.exec('PRAGMA query_only = 1'); return d; };
const before = snapshot(db);
const outcomes = (r) => Object.fromEntries(r.items.map((i) => [i.attempt, i.outcome]));

// A real run (the browser's check in this process, the rejudge budgets): proposals, needs-deep, nothing applied.
const out1 = path.join(dir, 'out1');
let r1;
{
  const d = ro(), t = Date.now();
  r1 = await rejudge(d, { now: NOW, outDir: out1 });
  d.close();
  assert.equal(snapshot(db), before, 'rejudge changed the database');
  assert.equal(r1.counts.misses, 7); // pd, prov, no, po, bad, done, shadow (old, unrated, solved: out)
  assert.deepEqual(outcomes(r1), { [A.pd.id]: 'proposal', [A.prov.id]: 'proposal', [A.no.id]: 'needs-deep', [A.po.id]: 'needs-deep',
    [A.bad.id]: 'unreplayable', [A.done.id]: 'already-refunded', [A.shadow.id]: 'mode-unsupported' });
  const P = Object.fromEntries(r1.proposals.map((p) => [p.attempt, p]));
  assert.deepEqual([P[A.pd.id].evidence, P[A.pd.id].strength, P[A.pd.id].move, P[A.pd.id].proofPlies], ['book', 'refund', '4c3+', 7]);
  assert.deepEqual([P[A.prov.id].evidence, P[A.prov.id].strength, P[A.prov.id].proofPlies], ['prover', 'refund', 4]);
  assert.equal(P[A.prov.id].bookRow.proof, 'rejudge'); assert.equal(P[A.prov.id].bookRow.pos.split(' ')[0].length > 0, true);
  assert.equal(P[A.done.id], undefined); assert.deepEqual(r1.refunded.map((p) => [p.attempt, p.evidence, p.command]), [[A.done.id, 'prover', undefined]]);
  assert.equal(r1.proposals.length, 2);
  assert.match(P[A.pd.id].command, new RegExp(`scripts/refund\\.mjs --db <db> --attempt ${A.pd.id} `)); // a dry run unless --apply
  assert.doesNotMatch(P[A.pd.id].command, /--apply/);
  assert.deepEqual(r1.needsDeep.map((x) => [x.attempt, x.move]), [[A.no.id, 'a1+'], [A.po.id, 'a1>']]);
  assert.equal(r1.items.find((i) => i.attempt === A.pd.id).pns, undefined, 'book evidence: no search');
  assert.equal(r1.partial, false); assert.equal(r1.bookVer, 1);
  for (const p of r1.proposals) assert.deepEqual(Object.keys(p).filter((k) => /name|token|nonce|ip|mail|gid/i.test(k)), []);
  const json = fs.readFileSync(path.join(out1, 'rejudge-2026-11-17.json'), 'utf8');
  assert.doesNotMatch(json, /legacy-\d|"h\d+"|"u\d+"/, 'no nonces, token hashes or names in the report');
  const txt = fs.readFileSync(path.join(out1, 'rejudge-2026-11-17.txt'), 'utf8');
  assert.equal(txt, renderReport(JSON.parse(json)));
  assert.match(txt, /PROPOSALS ONLY, nothing applied; unverified 4/); assert.match(txt, /pd575074@0 {2}4c3\+/); assert.match(txt, /needs deep \(2\)/);
  assert.match(txt, /UNVERIFIED: 4 \(needs-deep/); // 2 needs-deep, 1 unreplayable, 1 other mode: never "no false miss found"
  assert.deepEqual(fs.readdirSync(out1).sort(), ['rejudge-2026-11-17.json', 'rejudge-2026-11-17.txt']); // no temp files left
  console.log(`ok run: 2 refund proposals (book, prover), 2 needs-deep, refunded/unreplayable/other modes not proposed, db unchanged (${Date.now() - t} ms)`);
}

// Idempotent: a second run the same day and the next night search nothing they searched before.
{
  const d = ro();
  const never = async () => () => { throw new Error('searched again'); };
  const r2 = await rejudge(d, { now: NOW + 600e3, outDir: out1, check: never });
  assert.deepEqual(r2.proposals, r1.proposals); assert.deepEqual(outcomes(r2), outcomes(r1));
  const r3 = await rejudge(d, { now: NOW + DAY_MS, outDir: out1, check: never });
  assert.equal(r3.day, utcDay(NOW + DAY_MS)); assert.equal(r3.proposals.length, 2);
  assert.ok(fs.existsSync(path.join(out1, 'rejudge-2026-11-18.json')));
  // A changed engine (or budgets) is a different key: searched again.
  let calls = 0;
  await rejudge(d, { now: NOW, outDir: path.join(dir, 'outE'), engine: 'other', check: async () => () => { calls++; return { kind: 'no', trace: [] }; } });
  assert.equal(calls, 3); // done (prov: the same position), no, po
  d.close();
  assert.equal(snapshot(db), before);
  console.log('ok idempotent: same-day and next-day re-runs reuse every verdict; a new engine hash searches again');
}

// The CPU cap: measured as CPU (an injected clock here), stops cleanly with a partial report; a re-run continues.
{
  const d = ro(), out = path.join(dir, 'outC');
  let clock = 0, calls = 0;
  const check = async () => () => { calls++; clock += 100; return { kind: 'no', trace: [{ n: 3e4, full: false, r: 0 }] }; };
  const r = await rejudge(d, { now: NOW, outDir: out, check, cpu: () => clock, cpuCapS: 150 });
  assert.equal(calls, 1); assert.equal(r.partial, true); assert.match(r.stopped, /cpu cap/);
  assert.equal(Object.values(outcomes(r)).filter((o) => o === 'not-reached').length, 2);
  assert.match(fs.readFileSync(path.join(out, 'rejudge-2026-11-17.txt'), 'utf8'), /PARTIAL[\s\S]*not reached \(2\)/);
  assert.equal(outcomes(r)[A.pd.id], 'proposal', 'cheap evidence still runs past the cap');
  const r2 = await rejudge(d, { now: NOW + 3600e3, outDir: out, check, cpu: () => clock, cpuCapS: 1e6 });
  assert.equal(calls, 3); assert.equal(r2.partial, false);
  assert.equal(Object.values(outcomes(r2)).filter((o) => o === 'not-reached').length, 0);
  // A cap of 0 searches nothing at all.
  calls = 0;
  const r0 = await rejudge(d, { now: NOW, outDir: null, check, cpu: () => clock, cpuCapS: 0 });
  assert.equal(calls, 0); assert.equal(r0.partial, true);
  // The real clock: process CPU, not wall time (a sleep costs nothing).
  const t0 = process.cpuUsage(); await new Promise((res) => setTimeout(res, 200)); const dt = process.cpuUsage(t0);
  assert.ok((dt.user + dt.system) / 1e6 < 0.15);
  d.close();
  console.log('ok cpu cap: stops before a job that would pass it, partial report lists what was not reached, re-run resumes');
}

// A database without the ledger: an empty report, nothing else. A failing search is undecided, never 'no'.
{
  const F2 = path.join(dir, 'bare.db'), b = new DatabaseSync(F2);
  b.exec('CREATE TABLE attempts (user_id INTEGER, puzzle_id TEXT, win INTEGER, rated INTEGER, ts INTEGER, log TEXT, user_delta REAL); CREATE TABLE puzzles (id TEXT)');
  b.close();
  const d = new DatabaseSync(F2, { readOnly: true });
  const r = await rejudge(d, { now: NOW, outDir: null });
  assert.match(r.note, /no attempt ledger/); assert.equal(r.items.length, 0); d.close();
  const d2 = ro();
  const rf = await rejudge(d2, { now: NOW, outDir: null, check: async () => () => { throw new Error('boom'); } });
  assert.equal(rf.proposals.length, 1); // only the book one
  assert.equal(outcomes(rf)[A.no.id], 'undecided'); assert.equal(rf.needsDeep.length, 0);
  d2.close();
  console.log('ok no ledger -> empty report; a crashed search -> undecided');
}

// Priority: nice 19, and background QoS on macOS.
{
  const calls = [];
  const done = beNice({ platform: 'darwin', exists: () => true, run: (c, a) => calls.push([c, ...a]), setPriority: (p, n) => calls.push(['nice', p, n]) });
  assert.deepEqual(done, ['nice19', 'darwin-bg']);
  assert.deepEqual(calls, [['nice', 0, 19], ['/usr/sbin/taskpolicy', '-b', '-p', String(process.pid)]]);
  assert.deepEqual(beNice({ platform: 'linux', setPriority: () => {} }), ['nice19']);
  assert.ok(REJUDGE_BUDGETS.length > 2 && REJUDGE_BUDGETS.every(([a, b]) => a <= 4e6 && b <= 1e6));
  console.log('ok priority: nice 19 + taskpolicy -b');
}

// The command line on the fixture: read-only, renders, exits 0. And nothing in the server or client runs it.
{
  const out = path.join(dir, 'outCli');
  const p = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/rejudge.mjs'), '--db', F, '--out', out, '--now', '2026-11-17T12:00:00Z',
    '--budgets', '[[3e4,2.5e4]]'], { encoding: 'utf8', timeout: 60e3 });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^rejudge 2026-11-17: PROPOSALS ONLY/); assert.match(p.stdout, /proposals \(2\)/);
  assert.equal(snapshot(db), before);
  assert.equal(spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/rejudge.mjs'), '--db', path.join(dir, 'nope.db')]).status, 2);
  for (const f of ['server/server.js', 'server/shadow.js', 'public/app.js']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /rejudge\.mjs/);
  console.log('ok cli: renders on the fixture, database unchanged; not wired into the server or client');
}

// The puzzle as the player had it (attempt.puzzle_rev): a later rev's tree never decides the line the player faced.
{
  const add = (id, rev, tree, snaps) => {
    db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, komi, rev) VALUES (?,?,?,?,?,'test',1500,1500,?,?)`)
      .run(id, 6, PD.tps, 3, JSON.stringify(tree), 2, rev);
    for (const [r, t] of snaps) db.prepare('INSERT INTO puzzle_rev (id, rev, tree, komi, tps, ts) VALUES (?,?,?,?,?,0)').run(id, r, JSON.stringify(t), 2, PD.tps);
  };
  const log = [{ m: 'd1', ms: 900, k: 'ok' }, { m: '4c3+', ms: 2100, k: 'miss' }];
  // rev 0 answered d1 with a6; rev 1 (live) answers f6, and the book proves 4c3+ after d1 f6 (the PD row above).
  add('r-stale', 1, PD.tree, [[0, { d1: { r: 'a6', n: { e1: { r: 'f6', n: 'win' } } } }]]);
  // rev 1 added 4c3+ at the same line the player faced at rev 0: the tree as now counts.
  add('r-added', 1, { d1: { r: 'a6', n: { e1: { r: 'f6', n: 'win' }, '4c3+': { r: 'f6', n: 'win' } } } }, [[0, { d1: { r: 'a6', n: { e1: { r: 'f6', n: 'win' } } } }]]);
  add('r-gone', 3, PD.tree, []); // rev 0 was never snapshotted
  const ids = {};
  for (const id of ['r-stale', 'r-added', 'r-gone']) {
    const x = attempt(id, log, { ago: 1800e3 });
    ids[id] = x.id;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const d = ro();
  const seen = [];
  const r = await rejudge(d, { now: NOW, outDir: null, check: async () => (req) => { seen.push(req.plies.join(' ')); return { kind: 'no', trace: [{ n: 3e4, full: false, r: 0 }] }; } });
  d.close();
  const it = Object.fromEntries(r.items.map((i) => [i.attempt, i]));
  const s = it[ids['r-stale']];
  assert.equal(s.outcome, 'needs-deep', 'a book row for a position the player never faced is no evidence');
  assert.deepEqual([s.rev, s.liveRev, s.evidence], [0, 1, undefined]);
  assert.ok(seen.includes('d1 a6 4c3+') && !seen.includes('d1 f6 4c3+'), seen.join(' | '));
  assert.ok(!r.proposals.some((p) => p.puzzle === 'r-stale'));
  const ad = r.proposals.find((p) => p.puzzle === 'r-added');
  assert.deepEqual([it[ids['r-added']].outcome, ad?.evidence, ad?.rev], ['proposal', 'tree', 0]);
  assert.deepEqual([it[ids['r-gone']].outcome, it[ids['r-gone']].reason], ['unreplayable', 'rev-missing']);
  assert.ok(r.proposals.every((p) => Number.isInteger(p.rev)) && r.needsDeep.every((p) => Number.isInteger(p.rev)));
  assert.match(renderReport(r), /r-added@0 {2}4c3\+/);
  console.log('ok puzzle rev: replayed on the attempt\'s rev; a later rev counts only at the same line; no snapshot -> rev-missing');
}

if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true }); else console.log(dir);
console.log('rejudge: all ok');
process.exit(0);
