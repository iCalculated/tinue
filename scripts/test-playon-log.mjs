// The play-out's move log as the page now sends it (the defender's replies too, judge.js replyEntry; at most LOG.max
// entries) is accepted and stored unchanged by /api/result's log check (server.js cleanLog). Boots a server on a
// throwaway database (never data/tinue.db). TINUE_SERVER_ROOT: another checkout's root whose server/server.js to boot
// (e.g. an export of main, to prove the production server takes it); default this one.
//   node --no-warnings scripts/test-playon-log.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';
import { replyEntry, isReplyEntry, LOG } from '../public/playon.js';

const ROOT = process.env.TINUE_SERVER_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-polog-')), DB = path.join(dir, 't.db');
const { base, boot, stop } = testServer(dir, { root: ROOT, quiet: true });

let server = await boot(DB); await stop(server);
{
  const db = new DatabaseSync(DB);
  const ins = db.prepare(`INSERT INTO puzzles (id, size, tps, plies, tree, themes, source, init_rating, rating, rd, turn) VALUES (?,6,?,1,?,'s6,tinueIn2','test',1500,1500,250,1)`);
  for (let i = 0; i < 8; i++) ins.run(`t${i}`, 'x6/x,2,x4/x,2,2,x3/2,2C,1,121,x2/x,2,1,21,1,x/121,x,1,x2,2 1 14', JSON.stringify({ b1: 'win' }));
  db.close();
}
server = await boot(DB);
const call = async (p, body, token) => {
  const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }
    : { headers: token ? { authorization: 'Bearer ' + token } : {} });
  return { status: r.status, ...(await r.json()) };
};
const stored = (id) => { const d = new DatabaseSync(DB, { readOnly: true }); const r = d.prepare('SELECT log FROM attempts WHERE puzzle_id = ?').get(id); d.close(); return r?.log == null ? null : JSON.parse(r.log); };
try {
  const { token } = await call('/api/register', { name: 'polog' });
  // pd871847's play-out as the page now logs it: the on-tree moves, the move played out ('slow': proven), then each
  // reply marked and each of the player's moves (the reconstruction in scripts/test-playon.mjs)
  const line = 'f5 f4+ f4 2f5- f5 3f4+ f4 4f5- e4+ Sf5 f6'.split(' ');
  const log = [{ m: '3e6<12', ms: 20482, k: 'ok' }, { m: '2c6<', ms: 23589, k: 'ok' }, { m: 'd4>', ms: 107336, k: 'ok' },
    ...line.map((m, j) => ({ m: j ? (j % 2 ? replyEntry(m) : m) : m, ms: 172875 + 1000 * j, k: j ? 'po' : 'slow' }))];
  assert.equal(log.filter(isReplyEntry).length, 5);
  let r = await call('/api/result', { puzzleId: 't0', win: false, theme: 'tinueIn2', ms: 172875, log }, token);
  assert.equal(r.status, 200); assert.ok(r.user);
  assert.deepEqual(stored('t0'), log); // stored as sent: every reply kept, with its mark
  console.log('ok a play-out log with the defender\'s replies is stored as sent');
  // the longest log the page sends (LOG.max entries, all play-out plies) is stored too; one more and nothing would be
  const long = Array.from({ length: LOG.max }, (_, j) => ({ m: j % 2 ? replyEntry('a2>') : 'a2<', ms: 1000 + j, k: j ? 'po' : 'miss' }));
  r = await call('/api/result', { puzzleId: 't1', win: false, theme: 'tinueIn2', ms: 1000, log: long }, token);
  assert.equal(r.status, 200); assert.deepEqual(stored('t1'), long);
  r = await call('/api/result', { puzzleId: 't3', win: false, theme: 'tinueIn2', ms: 1000, log: [{ m: 'a1', ms: LOG.ms + 1, k: 'miss' }] }, token);
  assert.equal(r.status, 200); assert.equal(stored('t3'), null); // (and at LOG.ms)
  console.log(`ok the page's longest log (${LOG.max} entries) is stored; past LOG.ms the server keeps none, so the page stops before`);
  // the server's own limit (server.js LOG_MAX; 64 as a literal before 2026-11-21): the page never sends more, a log of
  // exactly that many is stored, one more and none is.
  const src = fs.readFileSync(path.join(ROOT, 'server/server.js'), 'utf8');
  const max = +(src.match(/const LOG_MAX = (\d+);/)?.[1] ?? src.match(/v\.length > (\d+)\) return null;/)?.[1]);
  assert.ok(max >= LOG.max, `the server keeps ${max} entries, the page sends up to ${LOG.max}`);
  const at = (n) => Array.from({ length: n }, (_, j) => ({ m: j % 2 ? replyEntry('a2>') : 'a2<', ms: 1000 + j, k: j ? 'po' : 'miss' }));
  r = await call('/api/result', { puzzleId: 't4', win: false, theme: 'tinueIn2', ms: 1000, log: at(max) }, token);
  assert.equal(r.status, 200); assert.equal(stored('t4').length, max);
  r = await call('/api/result', { puzzleId: 't5', win: false, theme: 'tinueIn2', ms: 1000, log: at(max + 1) }, token);
  assert.equal(r.status, 200); assert.equal(stored('t5'), null);
  console.log(`ok the server keeps ${max} entries (one more: none); the page sends at most ${LOG.max}`);
} finally { await stop(server); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\nOK: play-out log accepted by ${process.env.TINUE_SERVER_ROOT ? ROOT : 'this checkout'}'s server`);
