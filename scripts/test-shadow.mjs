// Post-hoc shadow judging (server/shadow.js, scripts/false-miss-report.mjs; PLAN step S3). Throwaway databases in a
// temp dir only.   node --no-warnings scripts/test-shadow.mjs
//
// The pd575074 fixture is SYNTHETIC: pd575074's position is only in crux's database, not in the repo. It is the
// closest stand-in: a 6×6 puzzle (komi 2) whose stored line is reached by one tree key and reply, where the player's
// off-tree move 4c3+ gets a quick threat-only 'no' from the browser's check (so the client charged a rated miss with no
// play-out), and the book proves the position after it won (as the full-width alt-wins proof of the real 4c3+ would).
// It is a candidate ONLY because this test puts that book row in: without it the shadow's check says 'no'
// (refuted-threat), as it would for the real quiet 4c3+. In production pd575074 becomes a candidate only once a book
// version holds the position after 4c3+ (S4/B2), and only if its miss has a ledger attempt row.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';

setInterval(() => {}, 1000); // the shadow's timers are unref'd (the server's socket keeps it alive): keep this alive
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-shadow-'));
delete process.env.TINUE_JUDGE;
Object.assign(process.env, { TINUE_DB: path.join(dir, 'unit.db'), TINUE_SYNTAKS: '/nonexistent', TINUE_ACCESS_LOG: path.join(dir, 'access.log') });
const { db } = await import('../server/server.js'); // the server's schema on a throwaway DB (not listening)
process.on('uncaughtException', (e) => { console.error(e); process.exit(1); }); // (server.js logs and carries on)
process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
const { createShadow, judgeMode, missOf, noKind, shadowProverOptions, SHADOW_N0 } = await import('../server/shadow.js');
const { publishBook } = await import('../server/book.js');
const { bookKey, puzzleStart } = await import('../shared/book.js');
const { report, v3FromAttempts } = await import('./false-miss-report.mjs');

const PD = { id: 'pd575074', size: 6, komi: 2, tps: 'x6/x6/x6/2,2,12121,x3/x6/1,1,x4 1 10',
  tree: { d1: { r: 'f6', n: { e1: { r: 'a6', n: 'win' } } } } }; // synthetic (see the header)
const PQ = { id: 'q-prov', size: 6, komi: 2, tps: 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14', tree: { b1: { r: 'f6', n: 'win' } } };
const addPuzzle = (d, p) => d.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, komi) VALUES (?,?,?,?,?,'test',1500,1500,?)`)
  .run(p.id, p.size, p.tps, 3, JSON.stringify(p.tree), p.komi);
for (const p of [PD, PQ]) addPuzzle(db, p);
let uid = 0, ts = Date.now() - 3600e3;
// A legacy rated miss as /api/result + logLegacyResult leave it: an attempts row with the log, an attempt row.
function legacyMiss(d, puzzleId, log, { rated = 1, result = 0 } = {}) {
  const u = ++uid; ts += 1000;
  d.prepare("INSERT INTO users (id, name, token_hash, created_at) VALUES (?, ?, ?, 0)").run(u, 'u' + u, 'h' + u);
  d.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, ts, log) VALUES (?,?,?,?,?,?)').run(u, puzzleId, result, rated, ts, JSON.stringify(log));
  d.prepare(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, "commit", mode, opened, closed, state, result, rated) VALUES (?,?,?,1,'','legacy',?,?,'closed',?,?)`)
    .run('legacy-' + u, u, puzzleId, ts, ts, result, rated);
  return u;
}
const shadowRows = (d = db) => d.prepare("SELECT * FROM ply WHERE src = 'shadow' ORDER BY attempt_id").all().map((r) => ({ ...r, evidence: JSON.parse(r.evidence) }));
const snapshot = (d = db) => JSON.stringify(['users', 'puzzles', 'attempts', 'attempt', 'rating_event'].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const spyTimers = () => { const s = { calls: 0, setTimeout(...a) { s.calls++; return setTimeout(...a); }, clearTimeout(t) { clearTimeout(t); } }; return s; };

// missOf: the line rebuilt through the tree; how the miss was decided.
{
  const m = missOf({ ...PD, tree: JSON.stringify(PD.tree) }, [{ m: 'd1', ms: 1, k: 'ok' }, { m: '4c3+', ms: 2, k: 'miss' }]);
  assert.deepEqual([m.move, m.line, m.n, m.how, m.solver, m.left, m.inTree], ['4c3+', ['d1', 'f6'], 2, 'check', 1, 3, false]);
  const g = puzzleStart(PD.tps, 2); g.play('d1'); g.play('f6'); const before = bookKey(g); g.play('4c3+');
  assert.equal(m.pos, bookKey(g)); assert.equal(m.before, before);
  assert.equal(missOf(PD, [{ m: 'd1', ms: 1, k: 'ok' }, { m: '4c3+', ms: 2, k: 'miss' }, { m: 'a5', ms: 3, k: 'po' }]).how, 'playout');
  assert.equal(missOf(PD, [{ m: 'zz9', ms: 1, k: 'miss' }]).error, 'illegal');
  assert.equal(missOf(PD, [{ m: 'a5', ms: 1, k: 'ok' }, { m: 'b5', ms: 2, k: 'miss' }]).error, 'offtree');
  assert.equal(missOf(PD, [{ ms: 1, k: 'view' }]).error, 'view');
  assert.equal(missOf(PD, 'not json').error, 'log');
  assert.equal(missOf(PD, null).error, 'log');
  assert.equal(noKind([{ n: 3e4, full: false, r: 0 }]), 'threat-finished');
  assert.equal(noKind([{ n: 3e4, full: false, r: 'budget' }, { n: 1e5, full: false, r: 0 }]), 'threat-budget');
  assert.equal(noKind([{ n: 3e4, full: false, r: 1 }, { n: 2.5e4, full: true, r: 0 }]), 'full-defence');
  assert.equal(noKind(undefined), 'unrecorded');
  // An alt is matched in any spelling (stored alts need not be canonical), like a tree key.
  for (const a of ['1a1+', '1a1+1', 'a1+']) {
    const t = JSON.stringify({ Cb1: { r: 'f6', n: 'win' } });
    assert.equal(missOf({ ...PQ, tree: t, swing: JSON.stringify({ alts: [a] }) }, [{ m: 'a1+', ms: 1, k: 'miss' }]).alt, true, a);
  }
  assert.equal(missOf({ ...PD, tree: JSON.stringify(PD.tree), swing: JSON.stringify({ altsAt: { 'd1 f6': ['4c3+4'] } }) },
    [{ m: 'd1', ms: 1, k: 'ok' }, { m: '4c3+', ms: 2, k: 'miss' }]).alt, true);
  assert.equal(missOf({ ...PQ, swing: JSON.stringify({ alts: ['b2', 'zz9'] }) }, [{ m: 'a1+', ms: 1, k: 'miss' }]).alt, false);
  // The shadow's prover child: background QoS on macOS (taskpolicy -b), nice 19 everywhere.
  const mac = shadowProverOptions({ platform: 'darwin', exists: () => true });
  assert.equal(mac.cmd, '/usr/sbin/taskpolicy'); assert.deepEqual(mac.args.slice(0, 2), ['-b', process.execPath]); assert.equal(mac.nice, 19);
  assert.match(mac.args.at(-1), /shadow-child\.js$/);
  const lin = shadowProverOptions({ platform: 'linux', exists: () => true });
  assert.equal(lin.cmd, process.execPath); assert.equal(lin.args[0], '--no-warnings'); assert.equal(lin.nice, 19);
  assert.equal(shadowProverOptions({ platform: 'darwin', exists: () => false }).cmd, process.execPath);
  console.log('ok missOf: line rebuilt through the tree; check / playout / errors; trace classes');
}

// Switch off (the default): nothing runs. No timer, no prover, no query, no write.
{
  assert.equal(judgeMode(undefined), 'off'); assert.equal(judgeMode('on'), 'off'); assert.equal(judgeMode('shadow'), 'shadow');
  const u = legacyMiss(db, PQ.id, [{ m: 'Cb1', ms: 5, k: 'miss' }]);
  const before = snapshot(), timers = spyTimers();
  let made = 0;
  const brokenDb = new Proxy({}, { get() { throw new Error('the off switch touched the database'); } });
  for (const d of [db, brokenDb]) {
    const s = createShadow(d, { timers, prover: () => { made++; throw new Error('no'); } });
    assert.equal(s.mode, 'off');
    s.legacyMiss(u, PQ.id); s.legacyMiss(u, PQ.id); s.refind(); await s.whenIdle(); s.close();
    assert.equal(createShadow(d, { mode: 'off', timers }), s);
  }
  assert.equal(timers.calls, 0); assert.equal(made, 0);
  assert.equal(shadowRows().length, 0); assert.equal(snapshot(), before);
  db.exec('DELETE FROM attempt; DELETE FROM attempts; DELETE FROM users');
  console.log('ok off: no timers, no prover, no database access, no writes');
}

// Switch on: the pd575074 fixture becomes a false-miss candidate (book); a prover-proven miss too; a refuted one not.
{
  const g = puzzleStart(PD.tps, 2); for (const m of ['d1', 'f6', '4c3+']) g.play(m);
  publishBook(db, { rows: [{ pos: bookKey(g), win_len: 7, exact: 0, model: 'full', proof: 'rejudge', checked: 1, puzzle_id: PD.id }], commitSha: 'test' });
  const uPD = legacyMiss(db, PD.id, [{ m: 'd1', ms: 900, k: 'ok' }, { m: '4c3+', ms: 2100, k: 'miss' }]);
  const uPR = legacyMiss(db, PQ.id, [{ m: 'Cb1', ms: 700, k: 'miss' }]);
  const uNO = legacyMiss(db, PQ.id, [{ m: 'a1+', ms: 800, k: 'miss' }]);
  const uPO = legacyMiss(db, PQ.id, [{ m: 'a1>', ms: 800, k: 'miss' }, { m: 'b1', ms: 900, k: 'po' }]);
  const uUN = legacyMiss(db, PQ.id, [{ m: 'b2', ms: 800, k: 'miss' }], { rated: 0 }); // unrated: never queued
  const uBAD = legacyMiss(db, PQ.id, [{ m: 'zz9', ms: 800, k: 'miss' }]);
  const before = snapshot();
  const s = createShadow(db, { mode: 'shadow', gapMs: 0, refindDelayMs: null });
  for (const u of [uPD, uPR, uNO, uPO, uBAD]) s.legacyMiss(u, u === uPD ? PD.id : PQ.id);
  s.legacyMiss(uUN, PQ.id); // (server.js only calls it for rated misses; if it did, the unrated attempt is skipped)
  s.legacyMiss(uPD, PD.id); // a second report of the same attempt: judged once
  await s.whenIdle(); s.close();
  assert.equal(snapshot(), before, 'shadow changed something besides ply rows');
  const rows = Object.fromEntries(shadowRows().map((r) => [db.prepare('SELECT user_id FROM attempt WHERE id = ?').get(r.attempt_id).user_id, r]));
  assert.equal(Object.keys(rows).length, 5);
  const pd = rows[uPD];
  assert.deepEqual([pd.n, pd.move, pd.verdict, pd.by, pd.evidence.kind, pd.evidence.how, pd.evidence.pns.kind, pd.evidence.no], [SHADOW_N0 + 2, '4c3+', 'wins', 'p', 'book', 'check', 'no', 'threat-finished']);
  assert.equal(pd.evidence.judge.verdict, 'solved'); assert.equal(pd.evidence.judge.proven, true); // 6×6: a proven play-out (no Syntaks reply here: proved)
  assert.deepEqual([rows[uPR].verdict, rows[uPR].evidence.kind, rows[uPR].evidence.pns.plies], ['wins', 'prover', 4]);
  assert.deepEqual([rows[uNO].verdict, rows[uNO].evidence.kind, rows[uNO].evidence.no], ['no', 'refuted-threat', 'threat-finished']);
  assert.deepEqual([rows[uPO].verdict, rows[uPO].evidence.how], ['no', 'playout']);
  assert.deepEqual([rows[uBAD].verdict, rows[uBAD].n, rows[uBAD].evidence.reason], ['na', SHADOW_N0, 'illegal']);
  assert.equal(s.stats.droppedWhy.user, 1); assert.equal(s.stats.skipped.noattempt, 1); // (the second report: one queued job per user)

  const r = report(db, 0, Date.now() + 1);
  assert.deepEqual(r.candidates.map((c) => [c.puzzle, c.move, c.evidence, c.user]), [[PD.id, '4c3+', 'book', uPD], [PQ.id, 'Cb1', 'prover', uPR]]);
  for (const c of r.candidates) assert.deepEqual(Object.keys(c).filter((k) => /name|token|ip|mail/i.test(k)), []);
  // V3: pd575074, Cb1 and a1+ were quick 'no' misses (Cb1's shadow check says wins: the client must have run out of
  // time); a1> was played out; zz9 is not rebuildable.
  assert.deepEqual(r.v3, { quickNo6: 3, split: { 'threat-finished': 2, 'shadow-wins': 1 }, playout6: 1, rules6: 0, unreplayable6: 1 });
  assert.deepEqual(v3FromAttempts(db, 0, Date.now() + 1), { misses6: 5, quickNo6: 3, playout6: 1, rules6: 0, unreplayable6: 1 });
  console.log('ok on: pd575074 4c3+ (synthetic) -> candidate (book); Cb1 -> candidate (prover); a1+ -> no; nothing but ply rows written');
  // A shadow check slower than the browser's quick answer: the browser likely showed a play-on (zero-move play-out).
  const pdRow = shadowRows().find((x) => x.move === '4c3+');
  db.prepare("UPDATE ply SET evidence = ? WHERE attempt_id = ? AND src = 'shadow'").run(JSON.stringify({ ...pdRow.evidence, checkMs: 4000 }), pdRow.attempt_id);
  assert.deepEqual(report(db, 0, Date.now() + 1).v3.split, { 'likely-playout': 1, 'threat-finished': 1, 'shadow-wins': 1 });
  db.prepare("UPDATE ply SET evidence = ? WHERE attempt_id = ? AND src = 'shadow'").run(JSON.stringify(pdRow.evidence), pdRow.attempt_id);
  assert.ok(Number.isFinite(pdRow.evidence.checkMs));
  console.log('ok report: candidates with puzzle, move, evidence, user id only; V3 count split by what stopped the search');
}

// Queue cap: one job at a time; a full queue drops (and counts) instead of growing.
{
  db.exec("DELETE FROM ply WHERE src = 'shadow'");
  let started = 0;
  const stuck = () => ({ still() { started++; return { quick: new Promise(() => {}), final: new Promise(() => {}), cancel() {} }; }, close() {} });
  const s = createShadow(db, { mode: 'shadow', maxQueue: 2, gapMs: 0, jobMs: 60e3, prover: stuck, refindDelayMs: null });
  const ids = db.prepare("SELECT user_id, puzzle_id FROM attempt WHERE rated = 1").all();
  for (const a of ids) s.legacyMiss(a.user_id, a.puzzle_id);
  assert.equal(s.stats.queued, 2); assert.equal(s.stats.dropped, ids.length - 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(started, 1, 'more than one job at a time');
  s.close();
  console.log(`ok queue: cap 2 kept 2 of ${ids.length}, dropped ${ids.length - 2}; one job at a time`);
}

// One player flooding misses holds one queue slot; guests hold at most half the queue; a named player's miss gets in.
{
  const stuck = () => ({ still() { return { final: new Promise(() => {}), cancel() {} }; }, close() {} });
  const s = createShadow(db, { mode: 'shadow', maxQueue: 4, gapMs: 1e9, prover: stuck, refindDelayMs: null });
  for (let i = 0; i < 60; i++) s.legacyMiss(999, 'p' + i, true); // one guest, a minute at the rate limit
  for (let g = 1000; g < 1010; g++) s.legacyMiss(g, 'p', true); // ten more guests
  s.legacyMiss(1, 'real-player-miss', false);
  assert.equal(s.stats.queued, 3); // guest 999, guest 1000, the named player
  assert.deepEqual(s.stats.droppedWhy, { user: 59, guests: 9 });
  s.close();
  console.log('ok flood: one queued job per user, guests at most half the queue, a named player still gets in');
}

// The hourly budget: at most maxPerHour jobs start in an hour; the rest wait, queued.
{
  db.exec("DELETE FROM ply WHERE src = 'shadow'");
  let t = 1e12, started = 0;
  const p = () => ({ still() { started++; return { final: Promise.resolve({ kind: 'no' }) }; }, close() {} });
  const s = createShadow(db, { mode: 'shadow', gapMs: 0, maxPerHour: 2, now: () => t, prover: p, refindDelayMs: null });
  const ids = db.prepare("SELECT user_id, puzzle_id FROM attempt WHERE rated = 1 ORDER BY id").all();
  for (const a of ids.slice(0, 4)) s.legacyMiss(a.user_id, a.puzzle_id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.stats.ran, 2); assert.ok(s.stats.skipped.hourly >= 1);
  s.close();
  console.log('ok hourly: 2 of 4 jobs started under maxPerHour 2; the rest wait');
}

// Refind runs periodically (not only at startup), one per user, and honours TINUE_SHADOW_REFIND_HOURS.
{
  db.exec("DELETE FROM ply WHERE src = 'shadow'");
  const calls = [];
  const timers = { setTimeout(f, ms) { calls.push({ f, ms }); return calls.length; }, clearTimeout() {} };
  const s = createShadow(db, { mode: 'shadow', timers, refindDelayMs: 5, refindEveryMs: 3600e3, gapMs: 1e9,
    prover: () => ({ still() { return { final: new Promise(() => {}) }; }, close() {} }) });
  assert.deepEqual(calls.map((c) => c.ms), [5]);
  calls[0].f(); // the startup refind: queues, and schedules the next refind an hour on
  assert.ok(calls.some((c) => c.ms === 3600e3), 'no periodic refind');
  assert.equal(s.stats.queued, 5);
  s.close();
  process.env.TINUE_SHADOW_REFIND_HOURS = '0.000001'; // ~4 ms: every miss here is older
  const s2 = createShadow(db, { mode: 'shadow', gapMs: 1e9, refindDelayMs: null });
  assert.equal(s2.refind(), 0); s2.close();
  delete process.env.TINUE_SHADOW_REFIND_HOURS;
  console.log('ok refind: periodic (hourly), window from TINUE_SHADOW_REFIND_HOURS');
}

// A judge that throws, rejects or never answers: the job ends ('undecided'), nothing reaches the caller.
{
  const cases = {
    'factory throws': () => { throw new Error('boom'); },
    'still throws': () => ({ still() { throw new Error('boom'); }, close() {} }),
    'final rejects': () => ({ still() { return { final: Promise.reject(new Error('boom')), cancel() {} }; }, close() {} }),
    'never answers': () => ({ still() { return { final: new Promise(() => {}), cancel() {} }; }, close() {} }),
    'garbage': () => ({ still() { return { final: Promise.resolve(42), cancel() {} }; }, close() {} }),
  };
  for (const [name, prover] of Object.entries(cases)) {
    db.exec("DELETE FROM ply WHERE src = 'shadow'");
    const a = db.prepare("SELECT a.user_id, a.puzzle_id FROM attempt a JOIN attempts o ON o.user_id = a.user_id WHERE o.log LIKE '%a1+%'").get();
    const s = createShadow(db, { mode: 'shadow', gapMs: 0, jobMs: 30, prover, refindDelayMs: null });
    const t0 = performance.now();
    s.legacyMiss(a.user_id, a.puzzle_id);
    assert.ok(performance.now() - t0 < 50, 'legacyMiss blocked');
    await s.whenIdle(); s.close();
    const [row] = shadowRows();
    assert.equal(row.verdict, 'undecided', name); assert.equal(row.evidence.pns.kind, 'undecided', name);
  }
  // A database that fails under the job: counted, never thrown.
  const bad = new Proxy(db, { get(t, k) { if (k === 'prepare') return () => { throw new Error('disk on fire'); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
  const err = console.error; console.error = () => {};
  try {
    const s = createShadow(bad, { mode: 'shadow', gapMs: 0, refindDelayMs: null });
    s.legacyMiss(1, PQ.id); assert.equal(s.refind(), 0);
    await s.whenIdle(); s.close();
    assert.ok(s.stats.failed.job >= 1 && s.stats.failed.refind === 1);
  } finally { console.error = err; }
  console.log('ok faults: throw / reject / timeout / garbage -> undecided row; a broken database is counted, never thrown');
}

// Restart: lost jobs are re-found from the log (recent legacy rated misses without a shadow row).
{
  db.exec("DELETE FROM ply WHERE src = 'shadow'");
  const s = createShadow(db, { mode: 'shadow', gapMs: 0, refindDelayMs: 0, prover: () => ({ still() { return { final: Promise.resolve({ kind: 'no' }) }; }, close() {} }) });
  await new Promise((r) => setTimeout(r, 20));
  await s.whenIdle();
  assert.equal(shadowRows().length, 5); // the five rated misses
  assert.equal(s.refind(), 0); s.close(); // nothing left to find
  console.log('ok restart: refind queues the rated misses that have no shadow row, once');
}

// The hook in server.js, end to end: off (default) writes nothing; shadow judges a rated miss after the answer.
const { base, boot, stop } = testServer(dir, { quiet: true });
for (const mode of [null, 'shadow']) {
  const F = path.join(dir, `e2e-${mode || 'off'}.db`);
  let s = await boot(F); await stop(s); // schema
  const d = new DatabaseSync(F); addPuzzle(d, PQ); d.close();
  s = await boot(F, mode ? { TINUE_JUDGE: mode } : {});
  try {
    const r = await fetch(base + '/api/result', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ puzzleId: PQ.id, win: false, ms: 3000, log: [{ m: 'Cb1', ms: 3000, k: 'miss' }] }) }).then((x) => x.json());
    assert.equal(r.rated, true); assert.ok(r.userDelta < 0);
    const rd = new DatabaseSync(F, { readOnly: true });
    let rows = [];
    for (let i = 0; i < (mode ? 150 : 15) && !rows.length; i++) { await new Promise((x) => setTimeout(x, 100)); rows = shadowRows(rd); }
    rd.close();
    if (!mode) assert.equal(rows.length, 0, 'off wrote a shadow row');
    else { assert.equal(rows.length, 1); assert.deepEqual([rows[0].move, rows[0].verdict, rows[0].evidence.kind], ['Cb1', 'wins', 'prover']); }
  } finally { await stop(s); }
  assert.doesNotMatch(s.err(), /shadow/);
  console.log(`ok server ${mode || 'off'}: rated miss answered as before; ${mode ? 'one shadow row (prover) written after' : 'no shadow row'}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-shadow: all ok');
process.exit(0);
