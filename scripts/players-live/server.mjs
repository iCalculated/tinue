#!/usr/bin/env node
// Live "tinue players" page: every attempt (accounts + anonymous guests) with rating over time.
// Runs beside the API server and reads the DB read-only.
//   HOST=… PORT=8792 node scripts/players-live/server.mjs     (systemd tinue-players; on crux launchd com.shy.tinue-players)
// It may be served to the public (Sasha, 2026-11-22: nothing on it is sensitive). What keeps that safe:
// it never reads a token, email or address column and shows a guest's browser id only as its first eight
// characters (the whole id can claim a nameless guest's row, see newGuest in server/server.js); the page is built
// with textContent only; and the DB is looked at CHECK_MS apart at most, so its cost does not grow with readers.
//
// Polls are cheap. One read-only handle stays open; PRAGMA data_version on it changes whenever another connection
// commits, so an idle poll costs one pragma. When it has changed, a stamp (a checksum of every column the page
// reads, ~40 ms on crux) decides whether the snapshot is rebuilt. Between two looks CHECK_MS apart every reader gets
// the snapshot held in memory, and a failing DB is retried (and logged) that often too. Responses carry an ETag
// (an unchanged poll is a 304 with no body) and go out gzipped when the client accepts it.
// /rush.json (Rush and Streak runs, rush-stats.mjs) is a second snapshot with its own stamp, so a rated attempt
// doesn't rebuild it and a Rush run doesn't rebuild /data.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { puzzleStats, hasFlaw, hasRefundMark, isRefund, refundSql } from './puzzle-stats.mjs';
import { rushStats, rushFeeds } from './rush-stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = process.env.TINUE_DB || path.join(HERE, '..', '..', 'data', 'tinue.db');
const HOST = process.env.HOST || '127.0.0.1', PORT = +(process.env.PORT || 8792);
const BOOT = Date.now().toString(36);
const REOPEN_MS = 10 * 60e3; // reopen now and then, so a replaced DB file is picked up
const CHECK_MS = Math.max(0, +(process.env.CHECK_MS ?? 5000) || 0); // the DB is looked at this often at most, however many readers poll (the page polls every 15 s)

const caches = {}; // path -> snapshot (filled below, once the builders exist)
let db = null, openedAt = 0;
function conn() {
  if (db && Date.now() - openedAt > REOPEN_MS) { db.close(); db = null; }
  if (!db) { db = new DatabaseSync(DB, { readOnly: true }); openedAt = Date.now(); for (const c of Object.values(caches)) c.version = null; } // a new handle's data_version means nothing yet
  return db;
}

// A checksum of exactly the columns build() and puzzleStats() read, so any edit that could change the page changes it:
// new rows, in-place edits (a refund rewriting its attempt, a regrade, a theme rename, a user rename to a same-length
// name). Unplayed puzzles never reach the page, so only played ones are read.
const hasGid = (d) => d.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'gid');
const usersSql = (d) => `SELECT id, name${hasGid(d) ? ', gid' : ''} FROM users ORDER BY id`;
const usersOf = (d) => new Map(d.prepare(usersSql(d)).all().map((u) => [u.id, u]));
const dataFeeds = (d) => [[usersSql(d)], ...(refundSql(d) ? [[refundSql(d)]] : []),
  [`SELECT user_id, puzzle_id, win, rated, user_rating, user_delta, puzzle_rating, ts, ms${hasRefundMark(d) ? ', refund' : ''} FROM attempts ORDER BY rowid`],
  ['SELECT gid, puzzle_id, win, hinted, guest_rating, puzzle_rating, ms, ts FROM guest_attempts ORDER BY rowid'],
  [`SELECT id, size, plies, turn, grade, themes, init_rating, rating, rd${hasFlaw(d) ? ', flaw' : ''} FROM puzzles
    WHERE id IN (SELECT puzzle_id FROM attempts UNION SELECT puzzle_id FROM guest_attempts) ORDER BY id`]];
function stampOf(d, feeds) {
  const h = crypto.createHash('sha1');
  // type-tagged, length-prefixed: NULL, Infinity, NaN, 0 and '' all hash differently, and no value can fake a separator
  const enc = (v) => (v === null ? 'N' : typeof v === 'number' ? `n${Object.is(v, -0) ? '-0' : v}` : typeof v === 'bigint' ? `b${v}`
    : typeof v === 'string' ? `s${v.length}:${v}` : v instanceof Uint8Array ? `x${v.length}:${Buffer.from(v).toString('hex')}` : `?${String(v)}`);
  for (const [sql, ...params] of feeds) { for (const r of d.prepare(sql).iterate(...params)) { h.update(Object.values(r).map(enc).join(',')); h.update('\n'); } h.update('|'); }
  return h.digest('base64url').slice(0, 22);
}

function build(d) {
  // Guests are users without a name (since 2026-11-15), labelled by their browser id as before.
  const guestUsers = hasGid(d);
  const users = usersOf(d);
  const rows = [];
  const n = new Map();
  const mark = hasRefundMark(d);
  for (const a of d.prepare(`SELECT a.user_id u, a.puzzle_id p, a.win w, a.rated r, a.user_rating ur, a.user_delta dl, ${mark ? 'a.refund' : 'NULL'} rf,
      a.puzzle_rating pr, a.ts t, a.ms ms, p.size sz FROM attempts a LEFT JOIN puzzles p ON p.id = a.puzzle_id ORDER BY a.ts`).iterate()) {
    const u = users.get(a.u);
    const player = u?.name || (u?.gid ? 'guest ' + u.gid.slice(0, 8) : u ? 'guest u' + a.u : 'user ' + a.u);
    n.set(player, (n.get(player) || 0) + 1);
    rows.push({ player, kind: u?.name ? 'account' : 'guest', n: n.get(player), t: a.t, puzzle: a.p, size: a.sz, win: a.w, rated: a.r, hinted: null,
      before: a.ur, after: (a.ur ?? 1500) + (a.dl ?? 0), puzzle_rating: a.pr, ms: a.ms,
      ...(isRefund({ rated: a.r, win: a.w, user_delta: a.dl, refund: a.rf }) ? { refund: 1, ...(a.rf ? { won: 1 } : {}) } : {}) }); // refunded later: before as recorded (won: counted as a solve, after = before + the row's net effect, often 0; not the solve then)
  }
  const guests = new Map();
  for (const g of d.prepare(`SELECT substr(gid, 1, 8) gid, puzzle_id p, win w, hinted h, guest_rating gr, puzzle_rating pr, ms, ts t,
      p.size sz FROM guest_attempts LEFT JOIN puzzles p ON p.id = puzzle_id
      ${guestUsers ? 'WHERE gid NOT IN (SELECT gid FROM users WHERE gid IS NOT NULL)' : ''} ORDER BY ts`).iterate()) { // linked ones are attempts now
    if (!guests.has(g.gid)) guests.set(g.gid, []);
    guests.get(g.gid).push(g);
  }
  for (const [gid, xs] of guests) xs.forEach((g, i) => rows.push({ player: 'guest ' + gid, kind: 'guest', n: i + 1, t: g.t, puzzle: g.p,
    size: g.sz, win: g.w, rated: 0, hinted: g.h, before: g.gr, after: i + 1 < xs.length ? xs[i + 1].gr : null, puzzle_rating: g.pr, ms: g.ms }));
  rows.sort((x, y) => x.t - y.t);
  const name = (id) => { const u = users.get(id); return u?.name || (u?.gid ? 'guest ' + u.gid.slice(0, 8) : 'guest u' + id); };
  // accounts in creation order: the page gives each a line colour by its place here, so colours never move
  const accounts = [...users.values()].filter((u) => u.name).sort((a, b) => a.id - b.id).map((u) => u.name);
  return { at: Date.now(), accounts, rows, puzzles: puzzleStats(d, name) };
}

const snap = (feeds, build) => ({ version: null, stamp: null, etag: null, body: null, gz: null, checked: 0, failed: 0, feeds, build });
caches['/data.json'] = snap(dataFeeds, build);
caches['/rush.json'] = snap((d) => rushFeeds(d, usersSql(d)), (d) => rushStats(d, usersOf(d)));
function snapshot(cache) {
  const now = Date.now();
  if (cache.body && now - cache.checked < CHECK_MS) return cache;
  if (now - cache.failed < CHECK_MS) throw Object.assign(new Error('still failing'), { again: true }); // already logged; not retried on every request
  try {
    const d = conn();
    const version = d.prepare('PRAGMA data_version').get().data_version;
    if (cache.body && version === cache.version) { cache.checked = now; return cache; }
    d.exec('BEGIN'); // stamp and build see one consistent snapshot
    try {
      const stamp = stampOf(d, cache.feeds(d));
      if (stamp !== cache.stamp) {
        const body = Buffer.from(JSON.stringify(cache.build(d)));
        Object.assign(cache, { stamp, etag: `"${BOOT}-${stamp}"`, body, gz: zlib.gzipSync(body) });
      }
    } finally { d.exec('COMMIT'); }
    cache.version = version; cache.checked = now; cache.failed = 0;
    return cache;
  } catch (e) { try { db?.close(); } catch {} db = null; cache.failed = now; throw e; }
}

// gzip unless the client refuses it (absent, or gzip;q=0)
function wantsGzip(header = '') {
  for (const part of header.split(',')) {
    const [enc, ...params] = part.trim().toLowerCase().split(';').map((x) => x.trim());
    if (enc !== 'gzip' && enc !== '*') continue;
    const q = params.find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

// Sent with every answer. The page is one file with inline script and style and fetches only its own two JSON routes.
const SAFE = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function handle(req, res) {
  for (const [k, v] of Object.entries(SAFE)) res.setHeader(k, v);
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad request'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
  if (Object.hasOwn(caches, url.pathname)) {
    const c = snapshot(caches[url.pathname]);
    const vary = { vary: 'accept-encoding', 'cache-control': 'no-cache', etag: c.etag };
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, vary); res.end(); return; }
    const gz = wantsGzip(req.headers['accept-encoding']), body = gz ? c.gz : c.body;
    res.writeHead(200, { ...vary, 'content-type': 'application/json', 'content-length': body.length, ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    res.end(body);
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const page = fs.readFileSync(path.join(HERE, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': page.length, 'content-security-policy': CSP });
    res.end(page);
    return;
  }
  res.writeHead(404); res.end();
}

const server = http.createServer((req, res) => {
  try { handle(req, res); }
  catch (e) {
    if (!e?.again) console.error(new Date().toISOString(), req.method, JSON.stringify(req.url), e?.stack || e);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('server error, see the server log'); }
    else res.destroy();
  }
});
server.on('clientError', (e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); });
server.listen(PORT, HOST, () => console.log(`tinue players on http://${HOST}:${server.address().port}`));
