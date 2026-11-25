// Account-saved settings, server half (server/settings.js, POST /api/settings): the column's migration, the shape
// checks, who may write, and that only the caller's own answers carry them.   node scripts/test-settings-server.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';
import { cleanSettings, mergeSettings, readSettings, addSettingsColumn, MAX_KEYS, MAX_BYTES } from '../server/settings.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-settings-'));
const { env, base, boot, stop } = testServer(dir);
const call = async (p, body, token, raw) => {
  const headers = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) };
  const r = await fetch(base + p, body !== undefined ? { method: 'POST', headers, body: raw ? body : JSON.stringify(body) } : { headers });
  const text = await r.text();
  const head = { retryAfter: r.headers.get('retry-after') };
  try { return { status: r.status, text, ...head, ...JSON.parse(text) }; } catch { return { status: r.status, text, ...head }; }
};
const cols = (f) => { const d = new DatabaseSync(f, { readOnly: true }); const c = d.prepare('PRAGMA table_info(users)').all().map((x) => x.name); d.close(); return c; };
const stored = (f, name) => { const d = new DatabaseSync(f, { readOnly: true }); const r = d.prepare('SELECT settings FROM users WHERE name = ?').get(name); d.close(); return r?.settings; };
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// Shape checks, without a server.
await test('cleanSettings: what passes and what is refused', () => {
  const ok = { board: 'ninja', confirm: true, volume: 0.5, n2: -3, sA9: '' };
  assert.equal(cleanSettings(ok).json, JSON.stringify(ok));
  assert.equal(cleanSettings({}).json, '{}');
  assert.ok(cleanSettings(Object.fromEntries(Array.from({ length: MAX_KEYS }, (_, i) => ['k' + i, 1]))).json);
  assert.ok(cleanSettings({ ['a' + 'B'.repeat(23)]: 1 }).json); // 24 characters: the longest name
  const bad = [undefined, null, 1, 'x', true, [], [1], Object.create(null),
    Object.fromEntries(Array.from({ length: MAX_KEYS + 1 }, (_, i) => ['k' + i, 1])),
    { ['a' + 'B'.repeat(24)]: 1 }, { Board: 1 }, { '1a': 1 }, { 'a-b': 1 }, { a_b: 1 }, { '': 1 }, { __proto__x: 1 },
    JSON.parse('{"__proto__": 1}'), { a: null }, { a: {} }, { a: { b: 1 } }, { a: [] }, { a: [1] }, { a: JSON.parse('1e999') }, { a: NaN },
    { a: 'x'.repeat(2001) }, Object.fromEntries(Array.from({ length: 4 }, (_, i) => ['k' + i, 'é'.repeat(1000)]))]; // last: 8 kB of UTF-8
  for (const v of bad) assert.ok(cleanSettings(v).error, JSON.stringify(v) ?? String(v));
  assert.ok(cleanSettings({ a: 'x'.repeat(2000) }).json);
  assert.equal(readSettings(null), null); assert.equal(readSettings('nope'), null); assert.equal(readSettings('[1]'), null);
  assert.deepEqual(readSettings('{"a":1}'), { a: 1 });
});

// A database like production's today: guests are users (nullable name, gid), no settings column; plus one from before
// guests were users (name NOT NULL), which the server rebuilds as users_v2.
const PROD = path.join(dir, 'prod.db'), OLD = path.join(dir, 'old.db');
{
  const o = new DatabaseSync(PROD);
  o.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, token_hash TEXT NOT NULL, gid TEXT UNIQUE,
      rating REAL NOT NULL DEFAULT 1500, rd REAL NOT NULL DEFAULT 500, vol REAL NOT NULL DEFAULT 0.06, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL)`);
  const ins = o.prepare('INSERT INTO users (name, token_hash, gid, rating, rd, games, wins, created_at) VALUES (?,?,?,?,?,?,?,?)');
  o.exec('BEGIN');
  for (let i = 0; i < 5000; i++) ins.run(i % 3 ? 'p' + i : null, 'h' + i, i % 3 ? null : i.toString(16).padStart(32, '0'), 1400 + (i % 400), 60 + (i % 300), i % 50, i % 20, i);
  o.exec('COMMIT'); o.close();
  const q = new DatabaseSync(OLD);
  q.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, token_hash TEXT NOT NULL,
      rating REAL NOT NULL DEFAULT 1500, rd REAL NOT NULL DEFAULT 500, vol REAL NOT NULL DEFAULT 0.06, games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES (7, 'Bob', 'h7', 1720, 80, 0.06, 40, 25, 1);`);
  q.close();
}

await test('migration: the column is added to a production-like database, rows untouched, startup fast', async () => {
  const before = new DatabaseSync(PROD, { readOnly: true }), rows = before.prepare('SELECT * FROM users ORDER BY id').all(); before.close();
  assert.ok(!cols(PROD).includes('settings'));
  const s = await boot(PROD); await stop(s);
  assert.ok(cols(PROD).includes('settings'));
  const d = new DatabaseSync(PROD, { readOnly: true });
  const after = d.prepare('SELECT * FROM users ORDER BY id').all(); d.close();
  assert.equal(after.length, rows.length);
  for (let i = 0; i < rows.length; i++) assert.deepEqual({ ...after[i] }, { ...rows[i], settings: null });
  // Startup includes node's own start and the other migrations; the ALTER is O(1) (no row is rewritten).
  assert.ok(s.ms < 5000, `startup ${s.ms.toFixed(0)} ms`);
  console.log(`   first start on the 5000-user database: ${s.ms.toFixed(0)} ms`);
});

await test('migration: a second start finds the column and adds nothing; the old-schema rebuild keeps it', async () => {
  const d = new DatabaseSync(PROD); d.exec(`UPDATE users SET settings = '{"keep":true}' WHERE id = 2`); d.close();
  const s = await boot(PROD); await stop(s);
  assert.equal(cols(PROD).filter((c) => c === 'settings').length, 1);
  assert.equal(stored(PROD, 'p1'), '{"keep":true}'); // id 2 is p1
  console.log(`   second start: ${s.ms.toFixed(0)} ms`);
  await stop(await boot(OLD));
  const c = cols(OLD); assert.ok(c.includes('settings') && c.includes('gid'));
  const o = new DatabaseSync(OLD, { readOnly: true }); assert.equal(o.prepare('PRAGMA table_info(users)').all().find((x) => x.name === 'name').notnull, 0); o.close();
  // addSettingsColumn on its own: once, then a no-op.
  const m = new DatabaseSync(':memory:'); m.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  assert.equal(addSettingsColumn(m), true); assert.equal(addSettingsColumn(m), false); m.close();
});

// The API, on a fresh database.
const DB = path.join(dir, 't.db');
await stop(await boot(DB));
assert.ok(cols(DB).includes('settings'));
{ // one puzzle, so a first result can make a guest
  const d = new DatabaseSync(DB);
  d.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, turn) VALUES ('t1',6,?,1,?,'s6','test',1500,1500,250,1)`)
    .run('x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14', JSON.stringify({ b1: 'win' }));
  d.close();
}
const server = await boot(DB);
try {
  let alice, bob, carol;
  await test('read answers carry settings: null before anything is saved', async () => {
    const a = await call('/api/register', { name: 'alice' });
    assert.equal(a.status, 200); assert.equal(a.settings, null); assert.ok('settings' in a); alice = a.token;
    bob = (await call('/api/register', { name: 'bob' })).token;
    carol = (await call('/api/register', { name: 'carol' })).token; // (her own rate-limit window for the changes test)
    const me = await call('/api/me', undefined, alice);
    assert.equal(me.settings, null); assert.equal(me.user.name, 'alice');
    assert.equal((await call('/api/login', { token: alice })).settings, null);
    assert.equal((await call('/api/me')).settings, null); // signed out
  });

  // Public answers, captured before alice saves anything: they must not change by a byte afterwards.
  const publicPaths = ['/api/leaderboard', '/api/users/alice', '/api/users?names=alice,bob', '/api/group?names=alice,bob', '/api/rush/top?size=6'];
  const snap = async () => Promise.all(publicPaths.map(async (p) => { const r = await call(p); assert.equal(r.status, 200, p); return [p, r.text]; }));
  const pub0 = await snap();
  const me0 = (await call('/api/me', undefined, alice)).user;

  const mine = { board: 'ninja', confirm: true, volume: 0.25, note: 'SECRET-MARKER' };
  await test('a write round-trips through every own answer', async () => {
    const w = await call('/api/settings', { settings: mine }, alice);
    assert.equal(w.status, 200); assert.deepEqual(w.settings, mine);
    assert.equal(stored(DB, 'alice'), JSON.stringify(mine));
    const me = await call('/api/me', undefined, alice);
    assert.deepEqual(me.settings, mine); assert.deepEqual(me.user, me0); // user itself unchanged
    assert.deepEqual((await call('/api/login', { token: alice })).settings, mine);
    // A write replaces the whole object.
    assert.deepEqual((await call('/api/settings', { settings: { confirm: false } }, alice)).settings, { confirm: false });
    assert.deepEqual((await call('/api/me', undefined, alice)).settings, { confirm: false });
    assert.deepEqual((await call('/api/settings', { settings: mine }, alice)).settings, mine);
  });

  await test('changes: only those keys, over what is stored; checked as a whole', async () => {
    // Device A saves sound; a stale device B then changes confirm only: A's sound survives.
    await call('/api/settings', { settings: { board: 'tinue', sound: 'deep', note: 'SECRET-MARKER' } }, carol);
    await call('/api/settings', { changes: { sound: 'light' } }, carol);
    const w = await call('/api/settings', { changes: { confirm: true } }, carol);
    assert.equal(w.status, 200); assert.deepEqual(w.settings, { board: 'tinue', sound: 'light', note: 'SECRET-MARKER', confirm: true });
    assert.deepEqual((await call('/api/me', undefined, carol)).settings, w.settings);
    const was = stored(DB, 'carol');
    for (const changes of [null, [1], 'x', { 'Bad-key': 1 }, { a: { b: 1 } }, { ['__proto__']: 1 }]) {
      const r = await call('/api/settings', JSON.stringify({ changes }), carol, true);
      assert.equal(r.status, 400, JSON.stringify(changes)); assert.ok(/^[A-Z].*\.$/.test(r.error), r.error);
    }
    // Each change fits alone but the merged whole is over the limits: refused.
    const many = Object.fromEntries(Array.from({ length: MAX_KEYS - 2 }, (_, i) => ['k' + i, 1]));
    assert.equal((await call('/api/settings', { changes: many }, carol)).status, 400);
    assert.equal(stored(DB, 'carol'), was);
    // Nothing stored yet: changes over {}.
    assert.deepEqual(mergeSettings(null, { a: 1 }), { json: '{"a":1}' });
    assert.deepEqual(mergeSettings('{"a":1,"b":2}', { b: 3 }), { json: '{"a":1,"b":3}' });
    assert.ok(mergeSettings('{"a":1}', { ['Z']: 1 }).error);
  });

  await test('one account never sees another\'s settings', async () => {
    assert.equal((await call('/api/me', undefined, bob)).settings, null);
    assert.equal((await call('/api/login', { token: bob })).settings, null);
    await call('/api/settings', { settings: { board: 'tinue' } }, bob);
    assert.deepEqual((await call('/api/me', undefined, bob)).settings, { board: 'tinue' });
    assert.deepEqual((await call('/api/me', undefined, alice)).settings, mine);
  });

  await test('public answers are byte-identical with settings saved, and never carry them', async () => {
    const pub1 = await snap();
    assert.deepEqual(pub1, pub0);
    for (const [p, t] of pub1) { assert.ok(!t.includes('SECRET-MARKER') && !t.includes('"settings"'), p); }
  });

  await test('validation: every limit gives 400 and stores nothing', async () => {
    const was = stored(DB, 'alice');
    const bad = [
      { settings: Object.fromEntries(Array.from({ length: MAX_KEYS + 1 }, (_, i) => ['k' + i, 1])) }, // too many keys
      { settings: { 'Bad-key': 1 } }, { settings: { ['a' + 'b'.repeat(24)]: 1 } }, // bad keys
      { settings: { a: { b: 1 } } }, { settings: { a: [1] } }, { settings: { a: null } }, // nested object, array, null
      { settings: { a: 'x'.repeat(2001) } }, // long string
      { settings: Object.fromEntries(Array.from({ length: 4 }, (_, i) => ['k' + i, 'x'.repeat(1600)])) }, // > MAX_BYTES of JSON
      { settings: [1, 2] }, { settings: 'x' }, { settings: 5 }, { settings: null }, {}, // not an object / missing
      { settings: { a: 'x'.repeat(200000) } }, // over the server's body limit (413 inside): still 400 with a sentence
    ];
    assert.ok(JSON.stringify(bad[7].settings).length > MAX_BYTES);
    for (const b of bad) {
      const r = await call('/api/settings', b, alice);
      assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80)); assert.equal(typeof r.error, 'string');
      assert.ok(/^[A-Z].*\.$/.test(r.error), r.error); // a plain sentence
    }
    for (const raw of ['[1]', '"x"', '7', 'null', '{bad json', '{"settings": {"a": 1e999}}']) {
      const r = await call('/api/settings', raw, alice, true);
      assert.equal(r.status, 400, raw); assert.ok(/^[A-Z].*\.$/.test(r.error), r.error);
    }
    assert.equal(stored(DB, 'alice'), was);
  });

  await test('no token or an unknown token: 401; a guest: 403; nothing stored', async () => {
    assert.equal((await call('/api/settings', { settings: { a: 1 } })).status, 401);
    assert.equal((await call('/api/settings', { settings: { a: 1 } }, 'f'.repeat(48))).status, 401);
    // A guest: made by a first result.
    const pid = (await call('/api/next')).puzzle?.id;
    assert.equal(pid, 't1');
    {
      const g = await call('/api/result', { puzzleId: pid, win: true });
      assert.equal(g.status, 200); assert.equal(g.settings, null); assert.equal(g.user.name, null);
      const r = await call('/api/settings', { settings: { a: 1 } }, g.token);
      assert.equal(r.status, 403);
      const d = new DatabaseSync(DB, { readOnly: true }); assert.equal(d.prepare('SELECT COUNT(*) n FROM users WHERE settings IS NOT NULL').get().n, 3); d.close();
    }
  });

  await test('settings are never written to the access log', async () => {
    await new Promise((r) => setTimeout(r, 100));
    const log = fs.readFileSync(env.TINUE_ACCESS_LOG, 'utf8');
    assert.ok(log.includes('POST /api/settings 200')); assert.ok(!log.includes('SECRET-MARKER') && !log.includes('ninja'));
  });

  await test('rate-limited: 30 writes a minute per account', async () => {
    let last;
    for (let i = 0; i < 31; i++) last = await call('/api/settings', { settings: { i } }, bob);
    assert.equal(last.status, 429);
    assert.ok(+last.retryAfter >= 1 && +last.retryAfter <= 60, String(last.retryAfter)); // how long to wait
    assert.equal(stored(DB, 'bob'), '{"i":28}'); // bob's 30th write this minute (one came earlier) landed, the 31st did not
  });
} finally { await stop(server); }

await test('a server started on a database that already has the column and saved settings works', async () => {
  const s = await boot(DB);
  try {
    const lb = await call('/api/leaderboard'); assert.equal(lb.status, 200);
    assert.equal(cols(DB).filter((c) => c === 'settings').length, 1);
    assert.equal(stored(DB, 'alice'), JSON.stringify({ board: 'ninja', confirm: true, volume: 0.25, note: 'SECRET-MARKER' }));
  } finally { await stop(s); }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`${n} settings-server tests passed`);
