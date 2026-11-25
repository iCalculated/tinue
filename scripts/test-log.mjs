// The attempt ledger (server/log.js, PLAN §1.3): schema, startup idempotence and the duplicate count. Boots
// server/server.js on throwaway databases in a temp dir (never data/tinue.db).   node --no-warnings scripts/test-log.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';
import { rate, GUEST_PUZZLE_WEIGHT, themeWeight } from '../shared/rating.js';
import { THEMES } from '../shared/themes.js';
import { EVENTS } from '../server/log.js';
import { COMMIT, readCommit } from '../server/revision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-log-'));
const { base, boot, stop } = testServer(dir, { quiet: true });
const schema = (f) => { const d = new DatabaseSync(f, { readOnly: true }); const s = d.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all().map((r) => ({ ...r })); d.close(); return s; };

// The commit logged with each attempt: deploy/revision.json as deploy-lib.sh's revision_json prints it, or '';
// TINUE_COMMIT comes first.
{
  const lib = spawnSync('/bin/sh', ['-c', '. scripts/deploy-lib.sh; revision_json'], { cwd: ROOT, encoding: 'utf8' });
  const F = path.join(dir, 'revision.json'), rev = JSON.parse(lib.stdout), put = (o) => fs.writeFileSync(F, typeof o === 'string' ? o : JSON.stringify(o));
  put(lib.stdout);
  assert.equal(readCommit(F, ''), rev.dirty ? `${rev.sha}+${rev.diff}` : rev.sha);
  const sha = 'a'.repeat(40);
  put({ sha, dirty: false, diff: '' }); assert.equal(readCommit(F, ''), sha); assert.equal(readCommit(F, 'env'), 'env');
  put({ sha, dirty: true, diff: '0123456789ab' }); assert.equal(readCommit(F, ''), sha + '+0123456789ab');
  for (const bad of [{ sha: 'unknown' }, {}, 'not json', 'null']) { put(bad); assert.equal(readCommit(F, ''), ''); }
  fs.rmSync(F); assert.equal(readCommit(F, ''), ''); assert.equal(readCommit(F, 'env'), 'env'); assert.equal(readCommit(F, undefined), process.env.TINUE_COMMIT || '');
  console.log('ok the deployed commit is read from revision.json');
}

// L1: tables and puzzles.rev on a fresh DB; a second start changes nothing; the duplicate count is printed.
{
  const F = path.join(dir, 'l1.db');
  let s = await boot(F);
  await stop(s);
  assert.match(s.out(), /attempts: 0 duplicate \(user_id, puzzle_id\) pairs/);
  const one = schema(F), names = one.map((r) => r.name);
  for (const t of ['attempt', 'ply', 'rating_event', 'puzzle_rev', 'attempt_first']) assert.ok(names.includes(t), t);
  const d = new DatabaseSync(F);
  const rev = d.prepare('PRAGMA table_info(puzzles)').all().find((c) => c.name === 'rev');
  assert.equal(rev.notnull, 1); assert.equal(rev.dflt_value, '0');
  d.exec(`INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating) VALUES ('x', 6, 't', 1, '{}', 'test', 1500, 1500);
    INSERT INTO attempts (user_id, puzzle_id, win, rated, ts) VALUES (1, 'x', 0, 1, 1), (1, 'x', 1, 0, 2), (2, 'x', 1, 1, 3);`);
  assert.equal(d.prepare("SELECT rev FROM puzzles WHERE id = 'x'").get().rev, 0);
  // the plan's partial unique index: one first attempt per (user, puzzle) in the ledger
  d.exec(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, "commit", mode, opened, state) VALUES ('n1', 1, 'x', 1, '', 'legacy', 1, 'closed')`);
  assert.throws(() => d.exec(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, "commit", mode, opened, state) VALUES ('n2', 1, 'x', 1, '', 'legacy', 1, 'closed')`), /UNIQUE/);
  d.exec(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, "commit", mode, opened, state) VALUES ('n3', 1, 'x', 0, '', 'shadow', 1, 'open')`);
  d.close();
  s = await boot(F);
  await stop(s);
  assert.match(s.out(), /attempts: 1 duplicate \(user_id, puzzle_id\) pair\b/);
  assert.deepEqual(schema(F), one);
  console.log('ok L1: ledger tables + puzzles.rev created; a restart changes nothing; duplicate pairs counted');
}


// A fixture: 40 6x6 puzzles across the rating range, some already played (settled rd), all served.
const TPS = 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14', TREE = JSON.stringify({ b1: 'win' });
let seed = 7; const R = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
async function fixture(name) {
  const F = path.join(dir, name);
  await stop(await boot(F));
  const d = new DatabaseSync(F);
  const ins = d.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, attempts, solves, turn) VALUES (?,6,?,1,?,?,'test',?,?,?,?,?,1)`);
  for (let i = 0; i < 40; i++) {
    const rt = 1100 + i * 30, played = i % 3 === 0;
    ins.run(`q${i}`, TPS.replace('2 1 14', `2 1 ${14 + i}`), TREE, i % 2 ? 's6,tinueIn2' : 's6,fork,roadIn1', rt, rt, played ? 90 + i : 250, played ? 12 : 0, played ? 5 : 0);
  }
  d.close();
  return F;
}
const caller = (base) => async (p, body, token) => {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) };
  const r = await fetch(base + p, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  return { status: r.status, ...(await r.json()) };
};
const close = (a, b, msg) => { for (const k of Object.keys(a)) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${msg} ${k}: ${a[k]} vs ${b[k]}`); assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), msg); };
const J = (s) => JSON.parse(s);
const replayed = [];
const replay = (F, ...a) => spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/replay-ratings.mjs'), '--db', F, ...a], { encoding: 'utf8' });

// L2: 100 fuzzed results (accounts and guests, themes, casual, repeats, stale builds) each leave one attempt + one
// rating_event per first attempt, and rate(before) reproduces after; the chains end at today's users/puzzles rows.
{
  const F = await fixture('l2.db');
  const s = await boot(F, { TINUE_MIN_BUILD: '5' });
  const call = caller(base);
  const tokens = [];
  try {
    for (const name of ['ann', 'bo', 'cy']) tokens.push((await call('/api/register', { name })).token);
    const themes = [undefined, 'tinueIn2', 'fork', 'roadIn1', 'nonsense'];
    for (let i = 0; i < 100; i++) {
      const who = Math.floor(R() * (tokens.length + 1)); // tokens.length: a new guest
      const pid = `q${Math.floor(R() * 40)}`, win = R() < 0.55, casual = R() < 0.15, theme = themes[Math.floor(R() * themes.length)];
      const b = Math.floor(R() * 9);
      const r = await call(`/api/result?b=${b}`, { puzzleId: pid, win, ...(casual ? { casual: true } : {}), theme, ms: Math.floor(R() * 60000), log: [{ m: 'b1', ms: 5, k: win ? 'ok' : 'miss' }] }, tokens[who]);
      assert.equal(r.status, 200);
      if (r.token) tokens.push(r.token); // guests become players who come back
    }
    const d = new DatabaseSync(F, { readOnly: true });
    const att = d.prepare('SELECT rowid, * FROM attempts ORDER BY rowid').all();
    const led = d.prepare('SELECT * FROM attempt ORDER BY id').all();
    assert.ok(led.every((a) => a.commit === COMMIT), 'each attempt names the running commit');
    const ev = d.prepare('SELECT * FROM rating_event ORDER BY id').all();
    assert.equal(led.length, att.length); assert.equal(ev.length, att.length);
    assert.ok(att.length >= 60 && att.length < 100, String(att.length)); // some repeats
    const users = new Map(d.prepare('SELECT * FROM users').all().map((u) => [u.id, u]));
    const state = { u: new Map(), p: new Map() };
    let ratedN = 0, guestN = 0, staleN = 0, casualN = 0;
    att.forEach((a, i) => {
      const l = led[i], e = ev[i];
      assert.equal(e.attempt_id, l.id); assert.equal(e.kind, 'rate'); assert.equal(l.mode, 'legacy'); assert.equal(l.first, 1); assert.equal(l.state, 'closed');
      assert.deepEqual([l.user_id, l.puzzle_id, l.result, l.rated, l.ms], [a.user_id, a.puzzle_id, a.win, a.rated, a.ms]);
      assert.equal(l.guest, users.get(a.user_id).name == null ? 1 : 0); guestN += l.guest;
      const ub = J(e.user_before), ua = J(e.user_after), pb = J(e.puzzle_before), pa = J(e.puzzle_after), { pw } = J(e.note);
      assert.equal(ub.rating, a.user_rating); assert.equal(pb.rating, a.puzzle_rating); // the attempts row's own snapshot
      if (state.u.has(a.user_id)) assert.deepEqual(ub, state.u.get(a.user_id), 'user chain'); // one event's after is the next one's before
      if (state.p.has(a.puzzle_id)) assert.deepEqual(pb, state.p.get(a.puzzle_id), 'puzzle chain');
      if (l.rated) {
        ratedN++;
        assert.equal(l.weight, themeWeight(l.theme, THEMES, !!l.result)); assert.equal(e.weight, l.weight);
        assert.equal(pw, l.guest ? e.weight * GUEST_PUZZLE_WEIGHT : e.weight);
        const r = rate(ub, pb, !!l.result, e.weight, pw);
        close({ rating: r.user.rating, rd: r.user.rd, vol: r.user.vol, games: ub.games + 1, wins: ub.wins + l.result }, ua, 'user after');
        close({ rating: r.puzzle.rating, rd: r.puzzle.rd, vol: r.puzzle.vol, attempts: pb.attempts + 1, solves: pb.solves + l.result }, pa, 'puzzle after');
        assert.ok(Math.abs(a.user_delta - (ua.rating - ub.rating)) < 1e-9);
      } else {
        assert.deepEqual(ua, ub); assert.deepEqual(pa, pb); assert.equal(e.weight, 0);
        assert.ok(['casual', 'stale-build'].includes(l.unrated_why), l.unrated_why);
        if (l.unrated_why === 'stale-build') { staleN++; assert.equal(l.result, 0); assert.ok(!(l.build >= 5)); } else casualN++;
      }
      state.u.set(a.user_id, ua); state.p.set(a.puzzle_id, pa);
    });
    for (const [id, st] of state.u) close(st, { rating: users.get(id).rating, rd: users.get(id).rd, vol: users.get(id).vol, games: users.get(id).games, wins: users.get(id).wins }, 'users row');
    for (const [id, st] of state.p) { const p = d.prepare('SELECT * FROM puzzles WHERE id = ?').get(id); close(st, { rating: p.rating, rd: p.rd, vol: p.vol, attempts: p.attempts, solves: p.solves }, 'puzzles row'); }
    d.close();
    assert.ok(ratedN > 30 && guestN > 5 && staleN > 0 && casualN > 0, JSON.stringify({ ratedN, guestN, staleN, casualN }));
    { const x = replay(F); assert.equal(x.status, 0, x.stdout + x.stderr); replayed.push(x.stdout.trim()); }
    console.log(`ok L2: 100 results -> ${att.length} first attempts, each one attempt + one rate event; rate(before) = after on ${ratedN} rated (${guestN} by guests), ${staleN} stale + ${casualN} casual unrated; chains end at the users/puzzles rows`);
  } finally { await stop(s); }

  // A forced failure of either ledger insert rolls back to the savepoint; the rating, the attempts row and the answer
  // are what they would have been without the ledger.
  for (const table of ['attempt', 'rating_event']) {
    const G = await fixture(`l2-fail-${table}.db`);
    const w = new DatabaseSync(G);
    w.exec(`CREATE TRIGGER fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END`);
    w.close();
    const s2 = await boot(G);
    try {
      const call2 = caller(base);
      const tok = (await call2('/api/register', { name: 'dee' })).token;
      for (const [i, win] of [[3, false], [4, true], [5, false]]) {
        const before = new DatabaseSync(G, { readOnly: true });
        const u0 = before.prepare("SELECT * FROM users WHERE name = 'dee'").get(), p0 = before.prepare('SELECT * FROM puzzles WHERE id = ?').get(`q${i}`);
        before.close();
        const r = await call2('/api/result', { puzzleId: `q${i}`, win }, tok);
        assert.equal(r.status, 200); assert.equal(r.rated, true);
        const want = rate(u0, p0, win);
        assert.equal(r.userDelta, want.userDelta); assert.equal(r.user.rating, want.user.rating);
        const d = new DatabaseSync(G, { readOnly: true });
        const u = d.prepare("SELECT * FROM users WHERE name = 'dee'").get(), p = d.prepare('SELECT * FROM puzzles WHERE id = ?').get(`q${i}`);
        assert.deepEqual([u.rating, u.rd, u.vol, u.games], [want.user.rating, want.user.rd, want.user.vol, u0.games + 1]);
        assert.deepEqual([p.rating, p.rd, p.attempts], [want.puzzle.rating, want.puzzle.rd, p0.attempts + 1]);
        assert.equal(d.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id = ? AND puzzle_id = ?').get(u.id, `q${i}`).n, 1);
        assert.equal(d.prepare('SELECT COUNT(*) n FROM attempt').get().n, 0);
        assert.equal(d.prepare('SELECT COUNT(*) n FROM rating_event').get().n, 0);
        d.close();
      }
      assert.match(s2.err(), /ledger: write failed \(rating kept\): forced ledger failure/);
    } finally { await stop(s2); }
  }
  console.log('ok L2: a forced failure of the attempt or the rating_event insert leaves the rating, the attempts row and the answer intact');

  // TINUE_LOG=0: nothing is logged.
  const H = await fixture('l2-off.db');
  const s3 = await boot(H, { TINUE_LOG: '0' });
  try {
    const call3 = caller(base);
    const tok = (await call3('/api/register', { name: 'eve' })).token;
    assert.equal((await call3('/api/result', { puzzleId: 'q1', win: true }, tok)).rated, true);
    const d = new DatabaseSync(H, { readOnly: true });
    assert.equal(d.prepare('SELECT COUNT(*) n FROM attempts').get().n, 1);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM attempt').get().n + d.prepare('SELECT COUNT(*) n FROM rating_event').get().n, 0);
    d.close();
  } finally { await stop(s3); }
  console.log('ok L2: TINUE_LOG=0 writes no ledger rows');
}

// busy_timeout: a result arriving while another process (an import) holds the write lock waits for it instead of
// failing with a 500 and being lost; the periodic TRUNCATE checkpoint still returns at once while a reader is active.
{
  const F = await fixture('busy.db');
  const s = await boot(F, { TINUE_CHECKPOINT_MS: '100' });
  const hold = (sql, ms) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--no-warnings', '-e', `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(F)});
      d.exec(${JSON.stringify(sql)}); console.log('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms}); d.exec('COMMIT'); d.close();`], { stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.on('data', (d) => { if (String(d).includes('held')) resolve({ done: new Promise((r) => c.once('exit', r)) }); });
    c.on('error', reject);
  });
  try {
    const call = caller(base);
    const tok = (await call('/api/register', { name: 'fay' })).token;
    const { done } = await hold("BEGIN IMMEDIATE; UPDATE puzzles SET meta = meta WHERE id = 'q0';", 300);
    const t0 = performance.now(), r = await call('/api/result', { puzzleId: 'q2', win: true }, tok), ms = performance.now() - t0;
    await done;
    assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.rated, true);
    assert.ok(ms > 150, `waited ${ms.toFixed(0)} ms for the lock`);
    const d = new DatabaseSync(F, { readOnly: true });
    assert.equal(d.prepare('SELECT games FROM users WHERE name = ?').get('fay').games, 1);
    d.close();
    // a reader holding its snapshot for 1.5 s: each checkpoint in that time reports busy and returns at once
    // The write comes after the reader has its snapshot: written before it, a checkpoint tick could empty the log in the
    // gap (starting the reader takes longer than a tick on a loaded machine) and no later checkpoint would be busy.
    let printed = '';
    s.stdout.on('data', (x) => { printed += x; });
    const reader = await hold('BEGIN; SELECT COUNT(*) FROM puzzles;', 1500);
    const w = new DatabaseSync(F); w.exec("UPDATE puzzles SET meta = '{}' WHERE id = 'q1'"); w.close(); // frames to checkpoint
    await reader.done;
    const lines = printed.split('\n').filter((l) => l.startsWith('checkpoint'));
    assert.ok(lines.length >= 3, printed);
    for (const l of lines) assert.ok(+/checkpoint (\d+) ms/.exec(l)[1] < 100, l);
    console.log(`ok busy: a result posted while another process held the write lock waited ${ms.toFixed(0)} ms and was rated; ${lines.length} checkpoints during a 1.5 s read returned busy at once`);
  } finally { await stop(s); }
}

// L3: refunds count as solves (2026-11-20). Three worlds from one fixture: W plays a script with ann's two rated misses
// (q4, q7), W' the same script without them, and Wwon with them as solves. Others play q4/q7 after ann (their ratings
// depend on hers) but never a puzzle ann plays later, so ann's own chain sees the same puzzle states in W and Wwon.
const script = [
  ['cy', 'q10', 1], ['cy', 'q11', 0], ['cy', 'q12', 1],
  ['ann', 'q0', 1], ['ann', 'q1', 0], ['ann', 'q2', 1], ['ann', 'q3', 1], ['ann', 'q5', 0], ['ann', 'q6', 1],
  ['ann', 'q4', 0, 'miss1'], ['bo', 'q4', 1], ['bo', 'q20', 0], ['cy', 'q8', 1],
  ['ann', 'q8', 1], ['ann', 'q9', 0, 'casual'], ['ann', 'q13', 1, 'theme'],
  ['ann', 'q7', 0, 'miss2'], ['bo', 'q7', 0], ['bo', 'q21', 1],
  ['ann', 'q14', 0], ['ann', 'q15', 1], ['cy', 'q16', 1], ['ann', 'q17', 0, 'theme'],
];
async function world(name, omit, solved = false) {
  const F = await fixture(name), s = await boot(F);
  try {
    const call = caller(base), tok = {};
    for (const n of ['ann', 'bo', 'cy']) tok[n] = (await call('/api/register', { name: n })).token;
    for (const [who, pid, win, tag] of script) {
      if (omit && tag?.startsWith('miss')) continue;
      const r = await call('/api/result', { puzzleId: pid, win: !!win || (solved && !!tag?.startsWith('miss')), ...(tag === 'casual' ? { casual: true } : tag === 'theme' ? { theme: 'tinueIn2' } : {}) }, tok[who]);
      assert.equal(r.status, 200);
    }
  } finally { await stop(s); }
  return F;
}
const snap = (F) => {
  const d = new DatabaseSync(F, { readOnly: true });
  const o = { users: d.prepare('SELECT id, name, rating, rd, vol, games, wins FROM users ORDER BY id').all().map((r) => ({ ...r })),
    puzzles: Object.fromEntries(d.prepare('SELECT id, rating, rd, vol, attempts, solves, flaw FROM puzzles ORDER BY id').all().map((r) => [r.id, { ...r }])),
    attempts: d.prepare('SELECT rowid, * FROM attempts ORDER BY rowid').all().map((r) => ({ ...r })),
    events: d.prepare('SELECT COUNT(*) n FROM rating_event').get().n };
  d.close(); return o;
};
const refund = (F, ...a) => spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/refund.mjs'), '--db', F, ...a], { encoding: 'utf8' });
{
  const W = await world('l3-w.db', false), W1 = await world('l3-never.db', true), W2 = await world('l3-won.db', false, true);
  const before = snap(W), never = snap(W1), won = snap(W2);
  const ann = (o) => o.users.find((u) => u.name === 'ann');
  assert.notEqual(ann(before).rating, ann(never).rating);
  const evOf = (pid) => { const d = new DatabaseSync(W, { readOnly: true }); const e = d.prepare("SELECT e.* FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.puzzle_id = ? AND a.user_id = ? AND e.kind = 'rate'").get(pid, ann(before).id); d.close(); return e; };
  const ev4 = evOf('q4'), ev7 = evOf('q7');
  const d4 = JSON.parse(ev4.puzzle_after).rating - JSON.parse(ev4.puzzle_before).rating;
  assert.ok(Math.abs(d4) > 0.1, 'ann moves q4 (not clueless): ' + d4);
  // what a solve gives, from the states logged on the miss (no theme, an account: weight 1 both sides)
  const solveOf = (e) => rate(J(e.user_before), J(e.puzzle_before), true, 1, 1);

  // A dry run writes nothing (the attempts.refund column is already there: the server added it at startup).
  let r = refund(W, '--user', 'ann', '--puzzle', 'q7');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /dry run/); assert.match(r.stdout, /counted as a solve/);
  assert.deepEqual(snap(W), before);
  // Refusals: a solve, an unrated attempt, an unknown pair, a pair without a ledger row.
  for (const [pid, re] of [['q8', /a solve/], ['q9', /not rated/], ['q30', /no ledger attempt/]]) {
    r = refund(W, '--user', 'ann', '--puzzle', pid, '--apply');
    assert.equal(r.status, 3, pid + r.stdout); assert.match(r.stderr, re);
  }
  // The later miss first, then the earlier one (whose chain then includes a refund).
  for (const pid of ['q7', 'q4']) { r = refund(W, '--user', 'ann', '--puzzle', pid, '--apply'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /written/); }
  const after = snap(W);
  const num = ({ rating, rd, vol, games, wins }) => ({ rating, rd, vol, games, wins });
  close(num(ann(after)), num(ann(won)), 'ann after refunds = ann having solved them');
  assert.equal(ann(after).games, ann(before).games); assert.equal(ann(after).wins, ann(before).wins + 2);
  for (const u of before.users) if (u.name !== 'ann') assert.deepEqual(after.users.find((x) => x.id === u.id), u, 'other users untouched: ' + u.name);
  for (const [id, p] of Object.entries(before.puzzles)) {
    if (id === 'q4' || id === 'q7') continue;
    assert.deepEqual(after.puzzles[id], p, 'puzzle untouched: ' + id);
  }
  // the puzzle: the miss's move out, the solve's in, both from the logged states; later results by others stay
  for (const [id, e] of [['q4', ev4], ['q7', ev7]]) {
    const miss = J(e.puzzle_after).rating - J(e.puzzle_before).rating, sol = solveOf(e).puzzleDelta;
    assert.ok(miss > 0 && sol < 0, `${id}: a miss raised it, a solve lowers it`);
    assert.ok(Math.abs(after.puzzles[id].rating - (before.puzzles[id].rating - miss + sol)) < 1e-9, id);
    assert.equal(after.puzzles[id].attempts, before.puzzles[id].attempts); assert.equal(after.puzzles[id].solves, before.puzzles[id].solves + 1);
    assert.equal(after.puzzles[id].rd, before.puzzles[id].rd);
  }
  // attempts: only the two refunded rows changed, to the solve they count as, with the refund mark.
  const changed = after.attempts.filter((a, i) => JSON.stringify(a) !== JSON.stringify(before.attempts[i]));
  assert.deepEqual(changed.map((a) => a.puzzle_id).sort(), ['q4', 'q7']);
  for (const a of changed) {
    const b = before.attempts.find((x) => x.rowid === a.rowid);
    assert.deepEqual([b.win, b.rated, b.refund], [0, 1, null]);
    assert.deepEqual([a.win, a.rated, a.refund, a.user_rating], [1, 1, 1, b.user_rating]);
    // the History's Δ: the row's net effect on her rating, the miss (which stands) plus what this refund applied (its
    // event's after − before), not the solve then (in the note)
    const d = new DatabaseSync(W, { readOnly: true });
    const re = d.prepare("SELECT e.user_before, e.user_after, e.note FROM rating_event e JOIN attempt x ON x.id = e.attempt_id WHERE e.kind = 'refund' AND x.user_id = ? AND x.puzzle_id = ?").get(a.user_id, a.puzzle_id);
    d.close();
    const applied = J(re.user_after).rating - J(re.user_before).rating; assert.ok(applied > 0, 'raised');
    assert.equal(a.user_delta, b.user_delta + applied); // (an earlier miss's raise fades through later results: the net can be below 0)
    assert.ok(Math.abs(J(re.note).solve - solveOf(a.puzzle_id === 'q4' ? ev4 : ev7).userDelta) < 1e-9); assert.equal(J(re.note).miss, b.user_delta);
  }
  assert.equal(after.events, before.events + 2);
  // L4 (A8): the ledger replays to the logged states and today's rows, refunds included; also on the never-played world.
  for (const F of [W, W1]) { const x = replay(F); assert.equal(x.status, 0, x.stdout + x.stderr); assert.match(x.stdout, /0 gaps, 0 mismatches/); replayed.push(x.stdout.trim()); }
  // A second refund is refused: by the refund event, by attempts.refund alone, and by the legacy signature alone.
  r = refund(W, '--user', 'ann', '--puzzle', 'q4', '--apply');
  assert.equal(r.status, 3); assert.match(r.stderr, /already refunded/);
  { const d = new DatabaseSync(W); d.exec("DELETE FROM rating_event WHERE kind = 'refund' AND attempt_id = (SELECT id FROM attempt WHERE puzzle_id = 'q7' AND user_id = " + ann(before).id + ")"); d.close(); }
  r = refund(W, '--user', 'ann', '--puzzle', 'q7', '--apply');
  assert.equal(r.status, 3); assert.match(r.stderr, /attempts\.refund is set/);
  { const d = new DatabaseSync(W); d.exec("UPDATE attempts SET rated = 0 WHERE puzzle_id = 'q5' AND user_id = " + ann(before).id); d.close(); }
  r = refund(W, '--user', 'ann', '--puzzle', 'q5', '--apply');
  assert.equal(r.status, 3); assert.match(r.stderr, /legacy signature/);
  // A miss under a theme: the solve it counts as is rated at the theme's win weight (0.1; the miss had 0.7). W2: ann's
  // q17 (tinueIn2) miss, refunded in the won world, whose chain already holds two solves of her own.
  {
    const d = new DatabaseSync(W2, { readOnly: true });
    const e = d.prepare("SELECT e.*, a.theme FROM rating_event e JOIN attempt a ON a.id = e.attempt_id WHERE a.puzzle_id = 'q17' AND a.user_id = ? AND e.kind = 'rate'").get(ann(won).id);
    const row = d.prepare("SELECT rowid FROM attempts WHERE puzzle_id = 'q17' AND user_id = ?").get(ann(won).id);
    d.close();
    assert.equal(e.theme, 'tinueIn2'); assert.equal(e.weight, themeWeight('tinueIn2', THEMES, false));
    r = refund(W2, '--attempt', String(e.attempt_id), '--apply'); assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /weight 0\.1, puzzle 0\.1/);
    const d2 = new DatabaseSync(W2, { readOnly: true });
    const ev = d2.prepare("SELECT note, user_before, user_after, puzzle_before, puzzle_after FROM rating_event WHERE kind = 'refund'").get(), a = d2.prepare('SELECT * FROM attempts WHERE rowid = ?').get(row.rowid);
    d2.close();
    assert.deepEqual([J(ev.note).w, J(ev.note).pw, J(ev.note).asWin], [0.1, 0.1, true]);
    // the solve then, at the theme's win weight, in the note; the History's Δ is what the refund applied
    assert.ok(Math.abs(J(ev.note).solve - rate(J(e.user_before), J(e.puzzle_before), true, 0.1, 0.1).userDelta) < 1e-9);
    assert.equal(a.user_delta, J(ev.note).miss + (J(ev.user_after).rating - J(ev.user_before).rating));
    const x = replay(W2); assert.equal(x.status, 0, x.stdout + x.stderr); assert.match(x.stdout, /0 gaps, 0 mismatches/);
  }
  // A users row changed outside the ledger (a hand fix, a TINUE_LOG=0 window): the chain can't be trusted, refused.
  { const d = new DatabaseSync(W1); d.exec("UPDATE users SET rating = rating + 1 WHERE name = 'bo'"); d.close(); }
  { const x = replay(W1); assert.equal(x.status, 1); assert.match(x.stdout, /mismatch: user \d+ row differs from the replay by 1\b/); }
  r = refund(W1, '--user', 'bo', '--puzzle', 'q20', '--apply');
  assert.equal(r.status, 3); assert.match(r.stderr, /changed outside the ledger/);
  console.log(`ok L3: two refunds leave ann exactly as if she had solved them (rating ${ann(before).rating.toFixed(1)} -> ${ann(after).rating.toFixed(1)}, max |diff| vs solved ${Math.max(...['rating', 'rd', 'vol'].map((k) => Math.abs(ann(after)[k] - ann(won)[k])))}), others and other puzzles untouched; q4/q7 miss out, solve in; rows read as solves with refund = 1; a themed miss counts at the win weight; second refunds refused; dry run writes nothing`);
}

// A guest past the clueless deviation moves puzzles at GUEST_PUZZLE_WEIGHT: the replay must use the logged pw (the
// fuzz above barely reaches that path). A TINUE_LOG=0 window inside a user's chain leaves the users row equal to the
// last logged after, so only the chain-link check stops a refund from silently dropping the unlogged games.
{
  const F = await fixture('l4-guest.db');
  let s = await boot(F), tok;
  try {
    const call = caller(base);
    for (let i = 0; i < 7; i++) { const r = await call('/api/result', { puzzleId: `q${22 + i}`, win: i % 2 === 0 }, tok); assert.equal(r.status, 200); tok ??= r.token; }
  } finally { await stop(s); }
  const d = new DatabaseSync(F, { readOnly: true });
  const evs = d.prepare(`${EVENTS} ORDER BY e.id`).all().map((e) => ({ ...e, guest: d.prepare('SELECT guest FROM attempt WHERE id = ?').get(e.attempt_id).guest }));
  const uid = evs[0].user_id;
  d.close();
  const moved = evs.filter((e) => e.guest === 1 && e.rated && JSON.parse(e.user_before).rd < 230);
  assert.ok(moved.length >= 2, 'guest events past the clueless rd: ' + moved.length);
  for (const e of moved) {
    const ub = J(e.user_before), pb = J(e.puzzle_before), pa = J(e.puzzle_after);
    assert.equal(J(e.note).pw, e.weight * GUEST_PUZZLE_WEIGHT);
    assert.ok(Math.abs(pa.rating - pb.rating) > 0.1, 'the guest moved the puzzle');
    assert.ok(Math.abs(rate(ub, pb, !!e.result, e.weight, e.weight).puzzle.rating - pa.rating) > 0.1, 'full weight would differ');
  }
  { const x = replay(F); assert.equal(x.status, 0, x.stdout + x.stderr); replayed.push(x.stdout.trim()); }
  // A guest's refunded miss counts as a solve that moves the puzzle at the guest's half weight.
  {
    const e = moved.find((x) => !x.result);
    assert.ok(e, 'a guest miss that moved its puzzle');
    const pb = J(e.puzzle_before), pa = J(e.puzzle_after), d0 = new DatabaseSync(F, { readOnly: true });
    const now = d0.prepare('SELECT rating FROM puzzles WHERE id = ?').get(e.puzzle_id).rating; d0.close();
    const r = refund(F, '--attempt', String(e.attempt_id), '--apply');
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /weight 1, puzzle 0\.5/);
    const half = rate(J(e.user_before), pb, true, 1, GUEST_PUZZLE_WEIGHT).puzzleDelta, full = rate(J(e.user_before), pb, true, 1, 1).puzzleDelta;
    assert.ok(Math.abs(half - full / 2) < 1e-9, 'blend: half the weight, half the move');
    const d1 = new DatabaseSync(F, { readOnly: true }); const got = d1.prepare('SELECT rating FROM puzzles WHERE id = ?').get(e.puzzle_id).rating; d1.close();
    assert.ok(Math.abs(got - (now - (pa.rating - pb.rating) + half)) < 1e-9);
    const x = replay(F); assert.equal(x.status, 0, x.stdout + x.stderr);
  }
  s = await boot(F, { TINUE_LOG: '0' });
  try { assert.equal((await caller(base)('/api/result', { puzzleId: 'q29', win: true }, tok)).rated, true); } finally { await stop(s); }
  s = await boot(F);
  try { assert.equal((await caller(base)('/api/result', { puzzleId: 'q30', win: false }, tok)).rated, true); } finally { await stop(s); }
  { const x = replay(F); assert.equal(x.status, 1); assert.match(x.stdout, /gap: user \d+/); }
  const r = refund(F, '--user', String(uid), '--puzzle', 'q30', '--apply');
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.match(r.stderr, /user chain gap/);
  console.log(`ok L4: a guest's ${moved.length} puzzle-moving events replay with the logged pw; a TINUE_LOG=0 window is a gap the replay lists and refund.mjs refuses`);
}

console.log('ok L4: replay-ratings.mjs reproduces the ledger and the rows (A8), and flags a row changed outside it:\n   ' + replayed.join('\n   '));
fs.rmSync(dir, { recursive: true, force: true });
