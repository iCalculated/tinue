// The iOS app's contract (TakMessages, Shared/TinueAPI.swift): what it decodes from /api/daily and /api/puzzle/:id.
// Swift's JSONDecoder fails the whole screen on a missing field or a wrong type, so every field it reads is checked
// here, with the type Swift asks for (Int must be a JSON integer). Boots server/server.js on a throwaway database.
//   GET /api/daily        -> { day: String, puzzle: { id: String, url: String, size: Int, komi: Double, rating: Int, tps: String } }
//   GET /api/puzzle/<id>  -> { puzzle: { id: String, tps: String, plies: Int, tree: TinueTree, themes: [String] } }
//   TinueTree   = "win" | { <move>: null | TinueBranch }        (any other string fails to decode)
//   TinueBranch = { r: String, n?: TinueTree | null }          (n missing or null: the move ends the game)
// The app also reads the TPS's second field (side to move: "1" or "2") and builds a URL from url.
//   node --no-warnings scripts/test-ios-contract.mjs
//   TINUE_IOS_DB=<a database copy> ... also fetches /api/puzzle for every row of that copy (copied first; never written)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-ios-'));
const { base, boot, stop } = testServer(dir);
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type'), body: await r.json() }; };

const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// TinueTree as Swift decodes it; returns the number of nodes, throws with the path on the first violation
function tree(t, at = 'tree') {
  if (t === 'win') return 1;
  assert.ok(t && typeof t === 'object' && !Array.isArray(t), `${at}: not "win" or an object: ${JSON.stringify(t)?.slice(0, 60)}`);
  let n = 1;
  for (const [k, b] of Object.entries(t)) {
    if (b === null) continue;
    assert.ok(typeof b === 'object' && !Array.isArray(b), `${at}.${k}: a branch must be null or {r, n}`);
    assert.ok(isStr(b.r), `${at}.${k}.r: not a string`);
    if (b.n !== undefined && b.n !== null) n += tree(b.n, `${at}.${k}.n`);
  }
  return n;
}
function summary(s) {
  for (const k of ['id', 'url', 'tps']) assert.ok(isStr(s[k]), `daily puzzle.${k}: not a string`);
  for (const k of ['size', 'rating']) assert.ok(isInt(s[k]), `daily puzzle.${k}: not an integer (${s[k]})`);
  assert.ok(isNum(s.komi), 'daily puzzle.komi: not a number');
  assert.doesNotThrow(() => new URL(s.url), 'daily puzzle.url: not a URL');
  assert.match(s.tps.split(' ')[1] ?? '', /^[12]$/, 'daily puzzle.tps: no side to move');
}
function detail(p, id) {
  assert.equal(p.id, id);
  assert.ok(isStr(p.tps), 'puzzle.tps: not a string');
  assert.ok(isInt(p.plies), 'puzzle.plies: not an integer');
  assert.ok(Array.isArray(p.themes) && p.themes.every(isStr), 'puzzle.themes: not [String]');
  return tree(p.tree);
}

// Fixture: every tree shape the format allows (a bare win, nested replies, a branch without n, null children).
const DB = path.join(dir, 't.db');
let server = await boot(DB);
await stop(server);
{
  const db = new DatabaseSync(DB);
  const ins = db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, komi, turn, swing) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tps = 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14';
  ins.run('pd1', 6, tps, 1, JSON.stringify('win'), 's6,roadIn1', 'PlayTak', 2200, 2200.4, 2, 1, JSON.stringify({ pre0: 0.2, alts: ['c1'] }));
  ins.run('ps2', 6, tps.replace(' 1 14', ' 2 14'), 3, JSON.stringify({ a1: { r: 'b2', n: { c1: { r: 'c2', n: 'win' } } }, d1: null, e1: { r: 'f1' } }), '', 'PlayTak', 1500, 1499.6, 0.5, 0, null);
  ins.run('pdg3-4', 5, 'x5/x5/x5/x5/x5 1 1', 1, JSON.stringify('win'), 's5', 'PlayTak', 1400, 1400, 0, null, null);
  db.close();
}
server = await boot(DB);
try {
  const d = await get('/api/daily');
  assert.equal(d.status, 200);
  assert.match(d.type, /^application\/json/);
  assert.ok(isStr(d.body.day) && /^\d{4}-\d{2}-\d{2}$/.test(d.body.day), 'daily.day');
  summary(d.body.puzzle);
  assert.equal(d.body.puzzle.id, 'pd1'); // the only 6x6 in the daily band
  const p = await get(`/api/puzzle/${d.body.puzzle.id}`);
  assert.equal(p.status, 200);
  detail(p.body.puzzle, 'pd1');
  assert.equal(p.body.puzzle.tps, d.body.puzzle.tps);
  for (const id of ['ps2', 'pdg3-4']) { const q = await get(`/api/puzzle/${id}`); assert.equal(q.status, 200); detail(q.body.puzzle, id); }
  assert.equal(detail((await get('/api/puzzle/ps2')).body.puzzle, 'ps2'), 3);
  // negative controls: the checker rejects what Swift would (e.g. a bare "win" as a branch, as some test fixtures write)
  assert.throws(() => tree({ b1: 'win' }));
  assert.throws(() => tree({ a1: { r: 1 } }));
  assert.throws(() => tree('loss'));
  assert.throws(() => summary({ ...d.body.puzzle, rating: 2200.5 }));
  console.log('ok ios: /api/daily and /api/puzzle/:id carry every field TinueAPI.swift decodes, with its types');
} finally { await stop(server); }

if (process.env.TINUE_IOS_DB) {
  const C = path.join(dir, 'copy.db');
  const src = new DatabaseSync(process.env.TINUE_IOS_DB, { readOnly: true });
  src.exec(`VACUUM INTO '${C.replace(/'/g, "''")}'`); src.close();
  const ids = new DatabaseSync(C, { readOnly: true }).prepare('SELECT id FROM puzzles ORDER BY id').all().map((r) => r.id);
  server = await boot(C);
  try {
    let nodes = 0;
    summary((await get('/api/daily')).body.puzzle);
    for (let i = 0; i < ids.length; i += 64) {
      const got = await Promise.all(ids.slice(i, i + 64).map(async (id) => [id, await get(`/api/puzzle/${encodeURIComponent(id)}`)]));
      for (const [id, r] of got) { assert.equal(r.status, 200, id); nodes += detail(r.body.puzzle, id); }
    }
    console.log(`ok ios copy: ${ids.length} puzzles decode as TinueAPI.Detail (${nodes} tree nodes); daily decodes as Summary`);
  } finally { await stop(server); }
}
fs.rmSync(dir, { recursive: true, force: true });
