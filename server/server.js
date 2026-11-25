// Minimal zero-dependency server: static files + a small JSON API backed by SQLite.
// Puzzle solving (move validation, opponent replies, alt-solution checks) all happens in the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { rate, DIFFICULTY, themeWeight, rdFromCount, PLAYER_START, provisional, settled, replayGuest, GUEST_PUZZLE_WEIGHT } from '../shared/rating.js';
import { PUZZLE_START, LEGACY_START } from '../shared/glicko.js';
import { THEMES } from '../shared/themes.js';
import { Game } from '../shared/tak.js';
import * as syntaks from './syntaks.js';
import { boardPng, sharePage } from './share.js';
import { PTN_RE, GID_RE, cleanMs, httpError, pacificDay } from './common.js';
import { createPool } from './pool.js';
import { addColumns } from './schema.js';
import { initLog, logLegacyResult } from './log.js';
import { addPuzzleState, served, pickable, statusOf, kindOf, swingPublic, KIND_SQL, PICKABLE_SQL } from './puzzle-state.js';
import { initBook } from './book.js';
import { createMoveApi } from './move.js';
import { createShadow } from './shadow.js';
import { createRush } from './rush.js';
import { addSettingsColumn, cleanSettings, mergeSettings, readSettings, MAX_BYTES } from './settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PORT || 8642);
const DB_PATH = process.env.TINUE_DB || path.join(ROOT, 'data', 'tinue.db');
// The oldest client build (build-static.sh's stamp, sent as ?b= on /api/result) whose misses are still rated; 0 = any.
// Set by the deploy scripts (scripts/deploy-lib.sh). Raise it there when a client fix changes what counts as a miss.
const MIN_MISS_BUILD = +process.env.TINUE_MIN_BUILD || 0;

// A host whose database has moved to another one (ops/README.md) keeps a MOVED file beside it and must never write it
// again: two writers would mean lost or doubled results. Scripts that import this file (import.mjs) stop here too.
if (DB_PATH !== ':memory:' && fs.existsSync(path.join(path.dirname(DB_PATH), 'MOVED'))) {
  console.error('tinue: this host was fenced (data/MOVED): its database lives on another host now; not starting');
  process.exit(1);
}
export const db = new DatabaseSync(DB_PATH);
// Wait up to BUSY_MS for another process's write lock (scripts/import.mjs, a hand fix) instead of failing at once: a
// result that arrived during an import's transaction got a 500 and was lost. checkpoint() sets it to 0 around itself.
const BUSY_MS = 5000;
db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
// A user is an account (with a name) or a guest (name NULL: someone who has played without claiming a name). Both are
// rated the same way, by the server; claiming a name just names the row. gid: a guest's random per-browser id, which
// links its row to the anonymous results older clients sent to guest_attempts; kept after claiming.
const USERS_TABLE = `(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, token_hash TEXT NOT NULL, gid TEXT UNIQUE,
  rating REAL NOT NULL DEFAULT ${PLAYER_START.rating}, rd REAL NOT NULL DEFAULT ${PLAYER_START.rd}, vol REAL NOT NULL DEFAULT ${PLAYER_START.vol}, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  settings TEXT -- the account's saved settings, a JSON object (server/settings.js); NULL: none saved
)`;
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users ${USERS_TABLE};
CREATE TABLE IF NOT EXISTS puzzles (
  id TEXT PRIMARY KEY, size INTEGER NOT NULL, tps TEXT NOT NULL, plies INTEGER NOT NULL,
  tree TEXT NOT NULL, themes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, source_ref TEXT,
  init_rating REAL NOT NULL, rating REAL NOT NULL, rd REAL NOT NULL DEFAULT ${PUZZLE_START.rd}, vol REAL NOT NULL DEFAULT ${PUZZLE_START.vol}, attempts INTEGER NOT NULL DEFAULT 0,
  solves INTEGER NOT NULL DEFAULT 0, komi REAL NOT NULL DEFAULT 0, meta TEXT,
  turn INTEGER, swing TEXT, -- turning-point flag (1/0/NULL = unscored) and its evidence, from scoring's sidecar
  flaw INTEGER, -- 1: a first move outside the solution tree also forces a win; 2: refunded and not fixed (REFUNDED)
  grade TEXT -- conversions (turn = 0) only: A (served with turning points), B, C, D; from scripts/grade/ (see its README)
);
CREATE INDEX IF NOT EXISTS puzzles_rating ON puzzles(rating);
CREATE TABLE IF NOT EXISTS attempts (
  user_id INTEGER NOT NULL, puzzle_id TEXT NOT NULL, win INTEGER NOT NULL, rated INTEGER NOT NULL,
  user_rating REAL, puzzle_rating REAL, user_delta REAL, ts INTEGER NOT NULL,
  ms INTEGER, -- visible time from the board becoming playable to the result (NULL: older client)
  log TEXT -- JSON [{m, ms, k}]: the solver's moves up to the result; k = ok | slow (a proven win outside the tree) | miss | view | hint
);
CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_id, puzzle_id);
-- Anonymous guest results from clients before 2026-11-15 (guests are users now; nothing writes here since): data only,
-- never rated. gid = random per-browser id; no IP. A guest's rows become its attempts when it gets a users row (newGuest).
CREATE TABLE IF NOT EXISTS guest_attempts (
  gid TEXT NOT NULL, puzzle_id TEXT NOT NULL, win INTEGER NOT NULL, hinted INTEGER NOT NULL,
  guest_rating REAL, guest_rd REAL, guest_games INTEGER, puzzle_rating REAL, ms INTEGER, log TEXT, ts INTEGER NOT NULL,
  PRIMARY KEY (gid, puzzle_id)
);
-- Puzzle of the day: one row per Pacific date, picked on that date's first request; a puzzle is never daily twice.
CREATE TABLE IF NOT EXISTS daily (
  day TEXT PRIMARY KEY, puzzle_id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL
);
`);
// votes: the table of a votes API removed on 2026-11-07. Dropped when it is empty (production's had no rows); a table
// with rows is left for someone to look at.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'votes'").get() && !db.prepare('SELECT 1 FROM votes LIMIT 1').get()) db.exec('DROP TABLE votes');

// Glicko-2 migration: older databases have Elo ratings without a deviation. Give each one a deviation
// from how much it has been played (a veteran is fairly certain, a new account is not).
for (const [table, count, start] of [['users', 'games', LEGACY_START], ['puzzles', 'attempts', PUZZLE_START]]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes('rd')) continue;
  db.exec('BEGIN'); // all or nothing, so a crash midway can't leave a half-migrated table
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN rd REAL NOT NULL DEFAULT ${start.rd}; ALTER TABLE ${table} ADD COLUMN vol REAL NOT NULL DEFAULT ${start.vol};`);
    const set = db.prepare(`UPDATE ${table} SET rd = ? WHERE id = ?`);
    for (const r of db.prepare(`SELECT id, ${count} n FROM ${table} WHERE ${count} > 0`).all()) set.run(rdFromCount(r.n, start.rd), r.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Guests as users (2026-11-15): name becomes optional and gid is added. SQLite can't drop NOT NULL in place, so an older
// table is rebuilt, ids and all (attempts refer to them).
// settings is copied too when the old table has it (it can't today: it is added below, after this rebuild).
if (db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'name').notnull) {
  const keep = 'id, name, token_hash, rating, rd, vol, games, wins, created_at' + (db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'settings') ? ', settings' : '');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE users_v2 ${USERS_TABLE};
      INSERT INTO users_v2 (${keep}) SELECT ${keep} FROM users;
      DROP TABLE users; ALTER TABLE users_v2 RENAME TO users;`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
addSettingsColumn(db); // users.settings on a database from before it (server/settings.js)
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_token ON users(token_hash)'); // every request looks its user up by token
// Turning-point migrations: older databases lack the columns; NULL means "not scored" / "no known flaw".
addColumns(db, 'puzzles', [['turn', 'INTEGER'], ['swing', 'TEXT'], ['flaw', 'INTEGER'], ['grade', 'TEXT']]);

addPuzzleState(db); // kind, status, pre0, miner, book: schema only, filled by import.mjs / scripts/puzzle-state.mjs (server/puzzle-state.js says what is read)
initBook(db); // book tables (server/book.js; unused until TINUE_BOOK_VER > 0)

// Solve-time migration: older databases lack ms/log on attempts (NULL = not recorded).
addColumns(db, 'attempts', [['ms', 'INTEGER'], ['log', 'TEXT']]);
const attemptDups = initLog(db); // attempt ledger tables (server/log.js); returns duplicate (user_id, puzzle_id) pairs in attempts
// POST /api/move, GET /api/attempt (server/move.js): never rates; TINUE_JUDGE=off (default): no routes, no tables, no file.
// decide only: minted guest tokens are sealed under data/mint-key (created then).
const moveApi = createMoveApi(db, { mintKeyFile: path.join(path.dirname(DB_PATH), 'mint-key') });
// What /api/next tells the page about the judge (C2): with the routes in shadow, `judge: 'shadow'` makes the page post
// each ply to /api/move beside /api/result, and each puzzle carries the `rev` it was loaded at. Off (the default): no
// field, so the page sends nothing. Not advertised in decide mode: a C2 page must not post there (D1b decides that).
const JUDGE_FIELD = moveApi.mode === 'shadow' || moveApi.mode === 'veto' ? { judge: 'shadow' } : {};
const rush = createRush(db, { now: () => now() }); // Rush and Streak (server/rush.js): their own tables and routes, never rated
const shadow = createShadow(db); // S3: re-judges legacy rated misses later, off the request path (server/shadow.js); TINUE_JUDGE=off (default): does nothing
const LOG_KINDS = new Set(['ok', 'slow', 'miss', 'view', 'hint', 'po']);
// A result's move log: at most LOG_MAX entries (64 until 2026-11-21; a play-out has no move cap now and logs the
// defender's replies too, so 64 ran out about 30 moves in; 512 entries is ~25 KB, well under MAX_BODY). Pages keep
// within it (public/playon.js LOG.max); one entry over and no log is stored.
const LOG_MAX = 512;
const cleanLog = (v) => {
  if (!Array.isArray(v) || !v.length || v.length > LOG_MAX) return null;
  const out = [];
  for (const e of v) {
    if (!e || typeof e !== 'object' || !LOG_KINDS.has(e.k)) return null;
    const ms = cleanMs(e.ms);
    if (ms == null) return null;
    if (e.k === 'view' || e.k === 'hint') { out.push({ k: e.k, ms }); continue; }
    if (typeof e.m !== 'string' || e.m.length > 24 || !PTN_RE.test(e.m)) return null;
    out.push({ m: e.m, ms, k: e.k });
  }
  return JSON.stringify(out);
};

const USER = 'id, name, rating, rd, vol, games, wins';
// What the client sees of a user: no volatility, rounded deviation, and whether the rating is provisional ("1650?").
// name is null for a guest.
const publicUser = (u) => u && { id: u.id, name: u.name, rating: u.rating, rd: Math.floor(u.rd), provisional: provisional(u), games: u.games, wins: u.wins };
// The caller's own saved settings (server/settings.js), beside `user` in the answers about the caller only: null when
// none are saved or nobody is signed in. Read by id apart from USER, so no other answer can carry them by accident.
const settingsById = db.prepare('SELECT settings FROM users WHERE id = ?');
const ownSettings = (u) => (u ? readSettings(settingsById.get(u.id)?.settings) : null);

// A player as anyone may see them (leaderboard-level data).
const profile = (u) => ({ name: u.name, rating: Math.round(u.rating), rd: Math.floor(u.rd), provisional: provisional(u), games: u.games, wins: u.wins });
// Where the page lives, for links in bot replies.
const SITE = process.env.TINUE_SITE || 'https://tinue.me/';

// A host name the API has left (TINUE_MOVED_FROM; the Tailscale Funnel's, since 2026-11-16). tinue-api.shydrie.xyz never
// belongs there: it is served beside api.tinue.me for open tabs, bots and shared links. A request that still names such
// a host and is not a page's fetch (an app, a bot, a crawler, a typed or shared link) is sent to the same path on the new host:
// 301 for GET and HEAD, 308 for anything else so the method and body are kept. A page's fetch is still answered here:
// a CORS request redirected to another origin arrives there with Origin "null", and a preflight can't be redirected at
// all, so redirecting an open tab on an old build would break it rather than move it (those tabs update themselves
// through version.json). Browsers mark their fetches with Origin or a sec-fetch-mode other than "navigate".
const MOVED_FROM = new Set((process.env.TINUE_MOVED_FROM ?? 'crux.tail5ed24.ts.net:8443,crux.tail5ed24.ts.net').split(',').filter(Boolean));
const MOVED_TO = (process.env.TINUE_MOVED_TO || 'https://api.tinue.me').replace(/\/+$/, '');
function moved(req, res, url) {
  if (!MOVED_FROM.has(String(req.headers.host || '').toLowerCase())) return false;
  const mode = req.headers['sec-fetch-mode'];
  if (req.headers.origin || (mode && mode !== 'navigate')) return false;
  const to = MOVED_TO + url.pathname + url.search;
  const body = JSON.stringify({ error: 'moved', location: to, message: `The tinue API moved to ${MOVED_TO}. Use that address; this one is going away.` });
  res.writeHead(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308,
    { location: to, 'content-type': 'application/json', 'cache-control': 'max-age=3600', vary: 'origin, sec-fetch-mode' });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

// Token from `Authorization: Bearer …` (the page) or the cookie. The cookie only counts when the request
// comes from an allowed origin, the API host itself, or no browser page at all (no Origin header): on
// tinue-api.shydrie.xyz it is same-site with every *.shydrie.xyz page (pages.shydrie.xyz hosts one-off HTML; on
// api.tinue.me with anything under tinue.me), and a
// SameSite=Lax cookie rides along on their fetches, so without this check such a page could post results as the
// player. CORS hides the reply from that page but doesn't stop the write. cookie() applies the same check before
// setting or clearing the cookie, which is what stops such a page logging a player out or in.
const cookieOk = (req) => { const o = req.headers.origin; if (!o || ORIGINS.has(o)) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };
function userFrom(req) {
  const m = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '') || (cookieOk(req) && /(?:^|;\s*)tinue_token=([a-f0-9]{48})/.exec(req.headers.cookie || ''));
  if (!m) return null;
  return db.prepare(`SELECT ${USER} FROM users WHERE token_hash = ?`).get(sha(m[1])) || null;
}

// A new guest: a users row without a name (or with one, when a first-time visitor claims a name straight away). If
// its browser (gid) sent anonymous results before guests were users, they become its attempts and set its rating
// (replayGuest); otherwise it starts at PLAYER_START. If the gid already has a nameless row (the answer carrying its
// token never arrived), that row gets a new token instead; a named account is never handed out by gid.
function newGuest(gidIn, name = null) {
  let gid = typeof gidIn === 'string' && GID_RE.test(gidIn) ? gidIn : null;
  const token = crypto.randomBytes(24).toString('hex');
  const old = gid && db.prepare('SELECT id, name FROM users WHERE gid = ?').get(gid);
  if (old && old.name == null && name == null) {
    db.prepare('UPDATE users SET token_hash = ? WHERE id = ?').run(sha(token), old.id);
    return { user: db.prepare(`SELECT ${USER} FROM users WHERE id = ?`).get(old.id), token };
  }
  if (old) gid = null;
  // A result on a paused or rejected puzzle replays unrated, as it would be reported now (PLAN P3).
  const prior = gid ? db.prepare(`SELECT g.*, p.rd AS prd, p.status, p.grade, p.turn FROM guest_attempts g LEFT JOIN puzzles p ON p.id = g.puzzle_id
    WHERE g.gid = ? ORDER BY g.ts`).all(gid).map((g) => (pickable(g) ? g : { ...g, hinted: 1 })) : [];
  const { rating: r, games, wins, attempts } = replayGuest(prior);
  db.exec('BEGIN');
  try {
    const { lastInsertRowid: id } = db.prepare('INSERT INTO users (name, token_hash, gid, rating, rd, vol, games, wins, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(name, sha(token), gid, r.rating, r.rd, r.vol, games, wins, now());
    const ins = db.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts, ms, log) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const a of attempts) ins.run(id, a.puzzle_id, a.win, a.rated, a.user_rating, a.puzzle_rating, a.user_delta, a.ts, a.ms, a.log);
    db.exec('COMMIT');
    return { user: db.prepare(`SELECT ${USER} FROM users WHERE id = ?`).get(id), token };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Origins allowed to call the API from a browser (the static page: tinue.me, and shydrie.xyz for old tabs and the beta; plus local dev).
const ORIGINS = new Set((process.env.TINUE_ORIGINS || 'https://tinue.me,https://shydrie.xyz,http://localhost:8642,http://localhost:8650').split(','));
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.has(o)) {
    res.setHeader('access-control-allow-origin', o);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', moveApi.routes.size ? 'content-type, authorization, x-tinue-nonce' : 'content-type, authorization'); // the nonce header: only with the /api/move routes on
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-expose-headers', 'retry-after'); // not CORS-safelisted: the page's outbox waits by it
    res.setHeader('access-control-max-age', '7200'); // cache preflights (else every signed-in request costs an extra round trip)
    res.setHeader('timing-allow-origin', o); // lets the page's slow-request reports split connect / TLS / wait
    res.setHeader('vary', 'origin');
  }
}

// The old page on shydrie.xyz hands its player over to tinue.me with the token in its localStorage. A player whose token
// is only in the HttpOnly cookie has none there to hand over, so that one origin may ask for it (POST /api/handoff-token).
// Unset (the default): no such route. Temporary: switched off once the old page is gone.
const HANDOFF_ORIGIN = process.env.TINUE_HANDOFF_ORIGIN || '';
const HANDOFF_FAILS = 10;

const publicPuzzle = (p) => p && ({
  id: p.id, size: p.size, tps: p.tps, plies: p.plies, tree: JSON.parse(p.tree),
  themes: p.themes ? p.themes.split(',') : [], source: p.source, sourceRef: p.source_ref,
  rating: Math.round(p.rating), rd: Math.round(p.rd), attempts: p.attempts, solves: p.solves, komi: p.komi,
  meta: p.meta ? JSON.parse(p.meta) : null,
  turn: p.turn ?? null, ...swingPublic(p.swing), ...(JUDGE_FIELD.judge ? { rev: p.rev ?? 0 } : {}), // rev: C2, only with the judge on
});

// Ranking: rating distance plus a handicap, within one stage of pickNext (below): the served pool first, everything else
// only when nothing in the pool matches the filters. In that fallback a conversion (turn = 0: the winner was already
// winning) carries CONVERT and an unscored puzzle (turn NULL: 7×7/8×8, komi Tiltak can't do, timeouts) UNSCORED, so an
// unscored puzzle is preferred unless a conversion is 100 points closer. (Before the served pool, 2026-11-14, all puzzles
// competed in one ranking and CONVERT = 250, ≈ an 81% expected score, kept conversions behind turning points unless that
// much closer: a strict tier order would serve a turning point 1000 points off over a conversion 300 off.)
// FLAW: another attacker move also forces a win. The client accepts it without a miss, but a puzzle with one
// winning idea is the better puzzle: +100 against clean puzzles of the same tier (57% of 3/5-ply puzzles).
// Exact consequences, proved for all ratings by scripts/verify-picker.py (Z3): a fresh pick is at most PICK_WINDOW (75)
// farther from the target than any fresh clean puzzle it passed over; a played-but-unsettled one at most 225 (PLAYED +
// PICK_WINDOW); a puzzle with flaw = 1 is served only when at least 25 closer than every fresh clean one.
const UNSCORED = 150, CONVERT = 250, FLAW = 100, PICK_WINDOW = 75;
// REFUNDED (flaw = 2, import.mjs's refund mark): the puzzle cost someone a refund (a rated miss on a move that wins, or
// that nothing could decide) and that move still isn't in its stored lists, so the next player can hit the same thing
// (Shy, 2026-11-16: "we should down prio it"). +REFUNDED instead of FLAW, and no PLAYED pull (those misses are plays,
// so PLAYED was drawing players onto exactly these puzzles): served only when nothing else in the pool is within
// REFUNDED points of the target. The verify-picker.py bounds hold for every other puzzle; this one only moves back.
const REFUNDED = 400, refunded = (r) => r.flaw === 2;
// PLAYED: a puzzle someone has already played (rated) whose rating is still unsettled (provisional: rating.js settled) is
// ranked as if PLAYED points closer. Plays then pile onto the same puzzles until their ratings settle, instead of each
// player spreading over fresh ones (2026-11-14: 257 puzzles had 1 play each, none settled). One play is enough to
// qualify, so the first player to reach a puzzle pulls the next ones there; settled puzzles get no bonus.
const PLAYED = 150;
const needsData = (r) => r.attempts > 0 && !settled(r) && !refunded(r);

// Served pool (2026-11-14): turning points plus the A-grade conversions (scripts/grade/: one route, real decoys, at
// least a median turning point of the same length), ranked as equals. Other puzzles only when nothing in the pool
// matches the filters (7x7/8x8 have none scored). served(r): status = 'served' (server/puzzle-state.js, PLAN P2).
// A row's score is |rating - target| + a + b - c, added in that order (pool.js): a the tier, b the flaw, c the PLAYED pull.
const scoreParts = (r) => [served(r) ? 0 : kindOf(r) === 'conversion' ? CONVERT : UNSCORED, refunded(r) ? REFUNDED : r.flaw ? FLAW : 0,
  needsData(r) ? PLAYED : 0];
// Every puzzle's ranking columns, in memory (server/pool.js); kept in step with the table.
const pool = createPool(db, { parts: scoreParts, served, pickable }); // pickable: never a paused/rejected row (Q11)
const puzzleById = db.prepare('SELECT * FROM puzzles WHERE id = ?');
const pickNext = (opts) => pickMany(opts, 1)[0] ?? null;
// n puzzles at once (a settled player's batch): from the served pool, topped up from the rest if it runs short.
function pickMany(opts, n) {
  const got = pickFrom(opts, true, n);
  return got.length >= n ? got : [...got, ...pickFrom({ ...opts, exclude: [...(opts.exclude || []), ...got.map((p) => p.id)] }, false, n - got.length)];
}
// servedOnly: the served pool only (else every puzzle). The best max(24, 4n) by score, theme, size, the user's
// attempts and exclude filtered out (pool.top), then the draw below.
function pickFrom({ user, rating, difficulty, theme, size, exclude }, servedOnly, n = 1) {
  const target = rating + (Object.hasOwn(DIFFICULTY, difficulty) ? DIFFICULTY[difficulty] : 0);
  const top = pool.top({ target, servedOnly, theme: theme || undefined, size: size || undefined, player: user?.id, exclude: exclude || [] }, Math.max(24, 4 * n));
  if (!top.length) return [];
  // Random among the best-ranked candidate's tier within PICK_WINDOW of its score, biased toward the closest. Same tier
  // only, so a sparse tier isn't diluted by the next one; rows of other tiers are skipped, not a stop (stopping at the
  // first other-tier row left a single candidate, i.e. the same puzzle every time, in ~20% of filter/rating cases).
  // Played-but-unsettled puzzles are their own tier: when one ranks first, the pick stays among them (otherwise the
  // window's random pick spreads plays over the ~20 fresh puzzles near the target and nothing settles).
  const tier = (r) => `${served(r) ? 'served' : kindOf(r)}|${r.flaw || 0}|${needsData(r) ? 1 : 0}`;
  const rows = top.filter((r) => tier(r) === tier(top[0]) && r.score <= top[0].score + PICK_WINDOW);
  // A batch needing more than the window holds takes the next-best candidates by score (any tier).
  if (rows.length < n) rows.push(...top.filter((r) => !rows.includes(r)).slice(0, n - rows.length));
  const out = [];
  while (out.length < n && rows.length) {
    const { id } = rows.splice(Math.floor(rows.length * Math.random() ** 2), 1)[0];
    out.push(puzzleById.get(id));
  }
  return out;
}

// Puzzle of the day, like Lichess's: the same puzzle for everyone for a whole Pacific date, drawn at random from a hard
// band (Lichess: 2150-2300) and never repeated. 6x6 only (5x5 until 2026-11-14; days already drawn keep theirs). First
// choice: a turning point with one winning first move that nobody has tried signed in (so the regulars haven't seen it);
// each fallback relaxes one condition, so the day always has a puzzle.
const DAILY_MIN = 2000, DAILY_MAX = 2400, DAILY_SIZE = 6;
const BAND = `size = ${DAILY_SIZE} AND rating BETWEEN ${DAILY_MIN} AND ${DAILY_MAX}`, UNPLAYED = 'id NOT IN (SELECT puzzle_id FROM attempts JOIN users ON users.id = user_id WHERE name IS NOT NULL)';
const NOT_REFUNDED = 'COALESCE(flaw, 0) <> 2'; // a refunded, unfixed puzzle (REFUNDED above) is the daily only as a last resort
const TURNING = `${KIND_SQL} = 'turning'`, SCORED = `${KIND_SQL} <> 'unscored'`; // kind (PLAN P2): was turn = 1 / turn IS NOT NULL
const DAILY_TIERS = [
  `${TURNING} AND NOT COALESCE(flaw, 0) AND ${BAND} AND ${UNPLAYED}`,
  `${TURNING} AND ${NOT_REFUNDED} AND ${BAND} AND ${UNPLAYED}`,
  `${TURNING} AND ${NOT_REFUNDED} AND ${BAND}`,
  `${SCORED} AND ${NOT_REFUNDED} AND ${BAND}`,
  `size = ${DAILY_SIZE} AND rating >= ${DAILY_MIN}`,
  `size = ${DAILY_SIZE}`,
  '1',
].map((t) => `${t} AND ${PICKABLE_SQL}`); // every tier, the last resorts too: never a paused/rejected puzzle (Q11)
function dailyPuzzle() {
  const day = pacificDay(now());
  let row = db.prepare('SELECT puzzle_id FROM daily WHERE day = ?').get(day);
  if (!row) {
    for (const t of DAILY_TIERS) {
      row = db.prepare(`SELECT id AS puzzle_id FROM puzzles WHERE ${t} AND id NOT IN (SELECT puzzle_id FROM daily) ORDER BY random() LIMIT 1`).get();
      if (row) break;
    }
    if (!row) return null;
    db.prepare('INSERT OR IGNORE INTO daily (day, puzzle_id, ts) VALUES (?, ?, ?)').run(day, row.puzzle_id, now());
  }
  const p = db.prepare('SELECT * FROM puzzles WHERE id = ?').get(row.puzzle_id);
  return p && { day, p };
}

// The puzzle summary bots get from /api/group and /api/daily.
const botPuzzle = (p) => ({ id: p.id, url: SITE + '#/puzzle/' + p.id, size: p.size, komi: p.komi, rating: Math.round(p.rating), turn: p.turn ?? null, toMove: p.tps.split(' ')[1] === '2' ? 'black' : 'white', tps: p.tps });

// What GET /api returns: the public, read-only API for bots.
const API_DOC = (base) => `tinue puzzle API (Tak puzzles; site ${SITE})
Base: ${base} (paths below are relative to it). Read-only JSON. 120 requests/minute per IP. Names are case-insensitive.

GET /api/daily
  The puzzle of the day: the same puzzle for everyone for the whole day (Pacific time; it changes at midnight),
  never repeated. A 6x6 puzzle rated 2000-2400, usually a turning point (the move that swung the game).
  -> { day: "YYYY-MM-DD", puzzle: { id, url, size, komi, rating, turn, toMove, tps } }
  url opens the puzzle on the site; toMove is "white" or "black"; tps is the position (Tak Positional System).

GET /api/group?names=a,b,c
  The puzzle of the day plus those players' profiles (up to 20 names; unknown names listed in missing).
  -> { day, users: [{ name, rating, rd, provisional, games, wins }], missing: [...], rating: <their average>, puzzle }
  names is optional; rating is null when none of the names exist. rd is the rating's uncertainty; a rating is
  provisional (shown with "?") until rd drops below 110.

GET /api/users/NAME          -> { user: { name, rating, rd, provisional, games, wins } }   (404 if unknown)
GET /api/users?names=a,b,c   -> { users: [...], missing: [...] }
GET /api/leaderboard         -> { leaders: [{ name, rating, games, wins, provisional }] }   (top 50 named players with a rated puzzle)

Example chat post: "Puzzle of the day (2331, white to play): ${SITE}#/puzzle/pd626152"
Solving it on the site is rated as usual, signed in or as a guest (first try only; a hint makes it unrated).
`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };

// Dev harness pages (dev/) are served only by a local dev server, never in production (TINUE_ORIGINS set).
const DEV = !process.env.TINUE_ORIGINS;

function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  if (p.includes('\0')) { res.writeHead(400).end(); return; }
  let base = path.join(ROOT, 'public');
  if (p.startsWith('/shared/')) { base = path.join(ROOT, 'shared'); p = p.slice('/shared'.length); }
  else if (DEV && p.startsWith('/dev/')) { base = path.join(ROOT, 'dev'); p = p.slice('/dev'.length); }
  else if (p.startsWith('/puzzle/')) { res.writeHead(302, { location: '/' + url.search + '#' + p }).end(); return; } // the app shows /puzzle/<id> again; keeps the query
  else if (p === '/' || p === '/glossary' || p === '/me' || p === '/leaderboard') p = '/index.html';
  const file = path.normalize(path.join(base, p));
  if (!file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(buf);
  });
}

// Share links: /p/<id> (an embed page for Discord & co. that forwards to the puzzle) and /p/<id>.png (its board).
// The page forwards to the puzzle on SITE (the static site).
const pngCache = new Map(); // id -> png, LRU-ish (Map keeps insertion order)
function share(req, res, id, png) {
  const p = db.prepare('SELECT id, size, tps, plies, themes, source, komi, rating, meta FROM puzzles WHERE id = ?').get(id);
  if (!p) { res.writeHead(404, { 'content-type': 'text/plain' }).end('no such puzzle'); return; }
  if (png) {
    let buf = pngCache.get(id);
    if (!buf) {
      buf = boardPng(p);
      pngCache.set(id, buf);
      if (pngCache.size > 500) pngCache.delete(pngCache.keys().next().value);
    }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'public, max-age=86400' }).end(req.method === 'HEAD' ? undefined : buf);
    return;
  }
  const proto = req.headers['x-forwarded-proto'] === 'https' || process.env.TINUE_SECURE ? 'https' : 'http';
  const here = `${proto}://${req.headers.host}`;
  const html = sharePage(p, { shareUrl: `${here}/p/${id}`, imageUrl: `${here}/p/${id}.png`, puzzleUrl: `${SITE}#/puzzle/${encodeURIComponent(id)}` });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' }).end(req.method === 'HEAD' ? undefined : html);
}

const json = (res, code, obj, headers = {}) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(obj));

const MAX_BODY = 1e5;

async function body(req) {
  if (+req.headers['content-length'] > MAX_BODY) throw httpError(413, 'too big');
  let s = '';
  for await (const c of req) { s += c; if (s.length > MAX_BODY) throw httpError(413, 'too big'); }
  if (!s) return {};
  let o;
  try { o = JSON.parse(s); } catch { throw httpError(400, 'bad json'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw httpError(400, 'bad json');
  return o;
}

// Per-key fixed-window rate limits, in memory. Behind a proxy every request comes from 127.0.0.1, so the client address
// comes from x-forwarded-for, whose last non-empty entry is the proxy's own:
//   Caddy (ops/Caddyfile) REPLACES the header with the one address Cloudflare named (CF-Connecting-IP, believed only from
//     Cloudflare's ranges).
//   Cloudflare Tunnel (crux) APPENDS the client address after whatever x-forwarded-for the client sent; Tailscale Funnel
//     (crux) replaces it.
// So a client can't pick its key. Don't read cf-connecting-ip here: not every path in strips a forged one.
// IPv6 clients (Cloudflare serves IPv6) are keyed by their /64: usually one household or LAN, like an IPv4 NAT
// address, and one client can rotate freely within it, so a narrower key would be no limit at all. An IPv4-mapped
// address (::ffff:a.b.c.d) is keyed as the IPv4 address.
function ipKey(a) {
  a = String(a || '').replace(/^\[|\](:\d+)?$/g, '').replace(/%.*$/, '').toLowerCase();
  const m4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (m4) return m4[1];
  if (!a.includes(':')) return a;
  const [h, t = ''] = a.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const groups = a.includes('::') ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}
const ip = (req) => ipKey((req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).pop() || req.socket.remoteAddress);
const windows = new Map();
// Over the limit: the seconds until the window resets (≥ 1, for Retry-After); else 0.
function limited(key, max, ms, count = true) {
  const t = now();
  let w = windows.get(key);
  if (!w || t >= w.reset) windows.set(key, (w = { n: 0, reset: t + ms }));
  if (w.n >= max) return Math.max(1, Math.ceil((w.reset - t) / 1000));
  if (count) w.n++;
  return 0;
}
const hit = (key) => { const w = windows.get(key); if (w) w.n++; };
setInterval(() => { const t = now(); for (const [k, w] of windows) if (t >= w.reset) windows.delete(k); }, 10 * 60e3).unref();
const LOGIN_FAILS = 20;
const SESSION_AGE = 315360000; // s: the token cookie's life, ten years
const tooMany = (res, wait) => json(res, 429, { error: 'Too many requests. Try again later.' }, wait ? { 'retry-after': String(wait) } : {});
// Over the limit: answer 429 with the wait, true.
const refuse = (res, ...limit) => { const wait = limited(...limit); if (wait) tooMany(res, wait); return !!wait; };

// Secure cookie when served over HTTPS (the proxies set x-forwarded-proto: https) or when told to (TINUE_SECURE=1). No
// Domain attribute: the cookie is host-only, so each API name keeps its own and none reaches the page's host. Returned as a headers object, and empty unless cookieOk (see userFrom): a
// page on another *.shydrie.xyz host can't plant a token (login CSRF) or clear one. The token is still in the JSON.
const cookie = (req, v, age) => cookieOk(req) ? { 'set-cookie': `tinue_token=${v}; Path=/; Max-Age=${age}; SameSite=Lax; HttpOnly` +
  (process.env.TINUE_SECURE || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '') } : {};

// Theme counts per board size, kept until another connection commits (an import, a hand fix: PRAGMA data_version, as the
// pool and stats). This connection's own results don't change them.
const dataVersion = db.prepare('PRAGMA data_version');
let themeCache = null;
function themeCounts() {
  const key = dataVersion.get().data_version;
  if (themeCache?.key === key) return themeCache;
  // Every pickable puzzle is servable (conversions only as a fallback), so `themes` counts them all and the picker never
  // hides a theme that would still serve something; `turning` counts the turning points among them. Paused and
  // rejected puzzles are never served, so they aren't counted: no filter is offered that would serve nothing.
  const all = { total: 0, themes: {}, turning: { total: 0, themes: {} } }, bySize = {}, sizes = {};
  for (const r of db.prepare('SELECT themes, size, turn, grade, kind, status FROM puzzles').iterate()) {
    if (!pickable(r)) continue;
    const turning = kindOf(r) === 'turning';
    sizes[r.size] = (sizes[r.size] || 0) + 1;
    const b = (bySize[r.size] ||= { total: 0, themes: {}, turning: { total: 0, themes: {} } });
    for (const c of [all, b]) {
      c.total++;
      if (turning) c.turning.total++;
      for (const t of (r.themes || '').split(',').filter(Boolean)) {
        c.themes[t] = (c.themes[t] || 0) + 1;
        if (turning) c.turning.themes[t] = (c.turning.themes[t] || 0) + 1;
      }
    }
  }
  return (themeCache = { key, all, bySize, sizes });
}

// A strict 6x6 TPS parse, or null. Game.fromTPS checks row widths and piece counts but is lenient about the rest
// (extra fields, odd turn numbers); Syntaks ignores a TPS it can't parse and keeps the previous position, so
// nothing loose may reach it.
const TPS_ROW = /^(?:x[1-6]?|[12]{1,64}[SC]?)(?:,(?:x[1-6]?|[12]{1,64}[SC]?))*$/;
function tps6(tps) {
  if (!tps || tps.length > 600) return null;
  const parts = tps.split(' '), rows = parts[0].split('/');
  if (parts.length !== 3 || rows.length !== 6 || !/^[12]$/.test(parts[1]) || !/^[1-9]\d{0,3}$/.test(parts[2])) return null;
  const occupied = [];
  for (const row of rows) {
    if (!TPS_ROW.test(row)) return null;
    if (row.split(',').reduce((n, c) => n + (c[0] === 'x' ? +(c.slice(1) || 1) : 1), 0) !== 6) return null;
    occupied.push(...row.split(',').filter((c) => c[0] !== 'x'));
  }
  // Move 1 is the opening, where each side places the other's flat; Syntaks plays it that way. A position labelled
  // move 1 must hold exactly what was placed so far: nothing with White to move, one black flat with Black to move.
  if (parts[2] === '1' && occupied.join(',') !== (parts[1] === '2' ? '2' : '')) return null;
  try { return Game.fromTPS(tps); } catch { return null; }
}
// A Syntaks search for a client: validated 6x6 TPS and komi, per-IP limits (uncached searches cost a crux core for
// ~1.2 s), a cap on searches in flight per client, and the search dropped if the client goes away.
const inflight = new Map(); // tag|ip -> open engine requests
// The engine's move, checked against our own rules: Syntaks silently searches its last good position when it can't
// parse one (sway's warning), so a reply is only passed on if it is legal here.
const legalIn = (g, ptn) => { try { return !!ptn && g.isLegal(g.parseMove(ptn)); } catch { return false; } };
// lines: MultiPV (the review panel asks for up to 3; /api/defend always 1), its own cache entry (server/syntaks.js).
async function engineCall(req, res, q, user, { tag, perMin, inflightMax, priority = false, lines = 1, out }) {
  const tps = typeof q.tps === 'string' ? q.tps.trim() : '';
  const komi = q.komi == null || q.komi === '' ? 0 : Number(q.komi);
  if (!Number.isFinite(komi) || komi < -3.5 || komi > 3.5 || komi * 2 !== Math.round(komi * 2)) return json(res, 400, { error: 'komi: -3.5 to 3.5 in steps of 0.5' });
  const g = tps6(tps);
  if (!g) return json(res, 400, { error: 'tps: a 6x6 position in TPS' });
  if (g.result()) return json(res, 400, { error: 'game over' });
  if (!syntaks.available()) return json(res, 503, { error: 'engine unavailable' });
  // A player is their account (several can share an address), else the address.
  const pos = g.toTPS(), key = user ? 'u' + user.id : ip(req), fk = tag + '|' + key;
  if ((inflight.get(fk) || 0) >= inflightMax) return tooMany(res); // (before the limits: a refused call doesn't use them up)
  if (refuse(res, tag + ':' + key, 120, 60e3) || (!syntaks.cached(pos, komi, lines) && refuse(res, tag + '-eng:' + key, perMin, 60e3))) return;
  inflight.set(fk, (inflight.get(fk) || 0) + 1);
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); }); // the client gave up or moved on
  try {
    const r = await syntaks.analyze(pos, komi, { signal: ac.signal, priority, lines });
    const body = out(r, g);
    if (!body) { syntaks.forget(pos, komi, lines); return json(res, 503, { error: 'engine gave no legal move' }); } // not cached
    return json(res, 200, body, { 'cache-control': 'max-age=86400' });
  } catch (e) {
    if (e.status === 499) return; // nobody is listening
    if (!e.status) console.error(tag, e.message);
    return json(res, e.status || 503, { error: e.status ? e.message : 'engine failed' });
  } finally {
    const n = inflight.get(fk) - 1;
    if (n > 0) inflight.set(fk, n); else inflight.delete(fk);
  }
}

// /api/stats (the deploy and public checks poll it): the same three queries, ~55 ms of full scans that block every other
// request, so the answer is kept until a puzzle changes: this connection's rated results (puzzleWrites) or another
// connection's commit (PRAGMA data_version). Byte for byte what the queries would return now. Computed at start too,
// so the deploy's first probe doesn't pay it.
let statsCache = null, puzzleWrites = 0;
function stats() {
  const key = `${dataVersion.get().data_version}|${puzzleWrites}`;
  if (statsCache?.key === key) return statsCache.body;
  const r = db.prepare('SELECT COUNT(*) n, MIN(rating) lo, MAX(rating) hi, AVG(rating) avg FROM puzzles').get();
  const byPly = db.prepare('SELECT plies, COUNT(*) n, AVG(rating) avg FROM puzzles GROUP BY plies ORDER BY plies').all();
  const byTurn = db.prepare('SELECT turn, COUNT(*) n, AVG(rating) avg FROM puzzles GROUP BY turn ORDER BY turn').all(); // turn null = unscored
  statsCache = { key, body: { ...r, byPly, byTurn } };
  return statsCache.body;
}

async function api(req, res, url) {
  let user = userFrom(req);
  if (user) res.userId = user.id;
  const route = `${req.method} ${url.pathname}`;
  const q = Object.fromEntries(url.searchParams);

  if (route === 'GET /api/me') return json(res, 200, { user: publicUser(user), settings: ownSettings(user) });

  // Save the caller's settings (server/settings.js checks their shape). { settings }: the whole object, replacing what
  // was stored. { changes }: only these keys, over what is stored (the page sends this, so an out-of-date tab or device
  // can't put back old values of settings it didn't change). The read and the write below have no await between them,
  // so two posts can't interleave. Named accounts only: a guest (no name) gets a 403, as the page syncs only for signed-in names and guests can be
  // minted by anyone. The settings are never logged (the access log has the path only).
  if (route === 'POST /api/settings') {
    if (!user) return json(res, 401, { error: 'Sign in to save settings.' });
    if (user.name == null) return json(res, 403, { error: 'Choose a name to save settings.' });
    if (refuse(res, 'set:u' + user.id, 30, 60e3)) return;
    let b;
    try { b = await body(req); } catch (e) {
      if (e.status === 400) return json(res, 400, { error: 'Send settings as a JSON object.' });
      if (e.status === 413) return json(res, 400, { error: `Settings are at most ${MAX_BYTES} bytes.` }); // (the contract: 400 with a sentence)
      throw e;
    }
    const c = b && typeof b === 'object' && Object.hasOwn(b, 'changes') ? mergeSettings(settingsById.get(user.id)?.settings, b.changes) : cleanSettings(b?.settings);
    if (c.error) return json(res, 400, { error: c.error });
    db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(c.json, user.id);
    return json(res, 200, { settings: ownSettings(user) });
  }

  // Claim a name. A guest's row just gets the name (rating and history stay); a first-time visitor gets a new row,
  // like a guest's (body.guest.gid, see newGuest). The token is returned only when it is new.
  if (route === 'POST /api/register') {
    const key = 'reg:' + ip(req);
    if (refuse(res, key, 5, 3600e3, false)) return;
    const { name, guest } = await body(req);
    if (user?.name) return json(res, 409, { error: 'You already have a username.' });
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{2,20}$/.test(name)) return json(res, 400, { error: 'Name must be 2–20 letters, digits, _ or -.' });
    if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) return json(res, 409, { error: 'That name is taken.' });
    let token = null;
    if (user) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
    else ({ user, token } = newGuest(guest?.gid, name));
    hit(key); // only successful registrations count toward the limit
    const u = db.prepare(`SELECT ${USER} FROM users WHERE id = ?`).get(user.id);
    return json(res, 200, { user: publicUser(u), settings: ownSettings(u), ...(token ? { token } : {}) }, token ? cookie(req, token, SESSION_AGE) : {});
  }

  // Paste your token on a new device. Only failures count toward the limit (LOGIN_FAILS an hour per client), so a
  // player who signs in on several devices is never limited. A right token always signs in, even from a limited client
  // (it can't be guessed, and the client would show a 429 as "That token doesn't match an account").
  if (route === 'POST /api/login') {
    const key = 'login:' + ip(req);
    const { token } = await body(req);
    const u = typeof token === 'string' && /^[a-f0-9]{48}$/.test(token) && db.prepare(`SELECT ${USER} FROM users WHERE token_hash = ?`).get(sha(token));
    if (!u) {
      if (refuse(res, key, LOGIN_FAILS, 3600e3, false)) return;
      hit(key); return json(res, 401, { error: 'Unknown token.' });
    }
    return json(res, 200, { user: publicUser(u), settings: ownSettings(u) }, cookie(req, token, SESSION_AGE));
  }

  // The caller's own cookie token, as JSON, for the old page's handoff (HANDOFF_ORIGIN). Only that exact origin, only from
  // the cookie (a page with a bearer token has nothing to ask), never logged or cached. Failures are limited per client.
  if (HANDOFF_ORIGIN && route === 'POST /api/handoff-token' && req.headers.origin === HANDOFF_ORIGIN) {
    const t = req.headers.authorization ? null : /(?:^|;\s*)tinue_token=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!t || !db.prepare('SELECT 1 FROM users WHERE token_hash = ?').get(sha(t))) {
      const key = 'handoff:' + ip(req);
      if (refuse(res, key, HANDOFF_FAILS, 3600e3, false)) return;
      hit(key); return json(res, 401, { error: 'none' }, { 'cache-control': 'no-store' });
    }
    return json(res, 200, { token: t }, { 'cache-control': 'no-store' });
  }

  if (route === 'POST /api/logout') return json(res, 200, {}, cookie(req, '', 0));

  if (route === 'GET /api/next') {
    const r = q.rating ? Number(q.rating) : NaN;
    const rating = user ? user.rating : Number.isFinite(r) ? Math.min(3500, Math.max(0, r)) : 1500;
    const size = Number.isInteger(+q.size) && +q.size > 0 ? +q.size : undefined;
    const exclude = (q.exclude || '').split(',').filter(Boolean).slice(0, 200);
    const opts = { rating, difficulty: q.difficulty, theme: q.theme, size, exclude };
    const pick = (o) => pickNext({ user, ...o }) ?? (user ? pickNext({ user: null, ...o }) : null); // seen them all: repeats
    // n=<count>: a batch for a settled player's queue (the client keeps it, Lichess-style), all at today's rating; the
    // answer says which rating, so the client can tell when the player has drifted away from it.
    const n = Math.min(20, Math.max(0, Math.trunc(+q.n) || 0));
    if (n > 1) {
      const got = pickMany({ user, ...opts }, n);
      if (got.length < n && user) got.push(...pickMany({ user: null, ...opts, exclude: [...exclude, ...got.map((p) => p.id)] }, n - got.length));
      return json(res, 200, { rating: Math.round(rating), puzzles: got.map(publicPuzzle), ...JUDGE_FIELD });
    }
    // for=<id>: while that puzzle is being played, pick what comes after it both ways, each at the rating the player
    // will have after solving or missing it (rated as /api/result will rate it), so the next one is ready either way.
    // A puzzle they've already played (or a paused/rejected one: P3) won't change their rating, so both picks are at today's rating.
    const cur = typeof q.for === 'string' && db.prepare('SELECT * FROM puzzles WHERE id = ?').get(q.for);
    if (cur) {
      const who = user ?? { rating, rd: PLAYER_START.rd, vol: PLAYER_START.vol }; // a first result makes a new guest
      const repeat = user && db.prepare('SELECT 1 FROM attempts WHERE user_id = ? AND puzzle_id = ?').get(user.id, cur.id);
      const th = typeof q.theme === 'string' && Object.hasOwn(THEMES, q.theme) && cur.themes.split(',').includes(q.theme) ? q.theme : undefined;
      const after = (win) => (repeat || !pickable(cur) ? who.rating : rate(who, cur, win, themeWeight(th, THEMES, win)).user.rating);
      const next = (win) => publicPuzzle(pick({ ...opts, rating: after(win), exclude: [...exclude, cur.id] }));
      return json(res, 200, { win: next(true), loss: next(false), ...JUDGE_FIELD });
    }
    return json(res, 200, { puzzle: publicPuzzle(pick(opts)), ...JUDGE_FIELD });
  }

  // Lookups for bots, e.g. a group chat: find players by name, or get the puzzle of the day (alone or with a group's
  // profiles). Public data only.
  if (route === 'GET /api/users' || route === 'GET /api/group' || route === 'GET /api/daily' || route.startsWith('GET /api/users/')) {
    if (refuse(res, 'look:' + ip(req), 120, 60e3)) return;
    if (route === 'GET /api/daily') {
      const d = dailyPuzzle();
      return d ? json(res, 200, { day: d.day, puzzle: botPuzzle(d.p) }) : json(res, 404, { error: 'no puzzles' });
    }
    if (route.startsWith('GET /api/users/')) {
      let name; try { name = decodeURIComponent(url.pathname.slice('/api/users/'.length)); } catch { return json(res, 400, { error: 'bad name' }); }
      const u = db.prepare(`SELECT ${USER} FROM users WHERE name = ?`).get(name);
      return u ? json(res, 200, { user: profile(u) }) : json(res, 404, { user: null });
    }
    const names = [...new Set((q.names || '').split(',').map((n) => n.trim()).filter((n) => n && n.length <= 32))].slice(0, 20);
    if (!names.length && route === 'GET /api/users') return json(res, 400, { error: 'names: comma-separated usernames' });
    const found = names.map((n) => db.prepare(`SELECT ${USER} FROM users WHERE name = ?`).get(n));
    // Names are case-insensitive: SHY and shy are one user, counted once.
    const users = [...new Map(found.filter(Boolean).map((u) => [u.id, u])).values()], missing = names.filter((_, i) => !found[i]);
    if (route === 'GET /api/users') return json(res, 200, { users: users.map(profile), missing });
    // /api/group: the group's profiles plus the puzzle of the day (it used to pick a puzzle per group; Shy's call).
    const d = dailyPuzzle();
    if (!d) return json(res, 404, { error: 'no puzzles' });
    const rating = users.length ? Math.round(users.reduce((t, u) => t + u.rating, 0) / users.length) : null;
    return json(res, 200, { day: d.day, users: users.map(profile), missing, rating, puzzle: botPuzzle(d.p) });
  }

  if (route === 'GET /api' || route === 'GET /api/') return res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(API_DOC(`${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`));

  let m;
  if (req.method === 'GET' && (m = /^\/api\/puzzle\/([\w.-]+)$/.exec(url.pathname))) {
    const p = db.prepare('SELECT * FROM puzzles WHERE id = ?').get(m[1]);
    // judge: as on /api/next, so a page opened on a puzzle link turns its shadow outbox on before that first attempt opens
    return p ? json(res, 200, { puzzle: publicPuzzle(p), ...JUDGE_FIELD }) : json(res, 404, { puzzle: null });
  }
  // server/move.js. decide mode only: mint makes a guest exactly as /api/result does (same 10/h/IP window), cookie re-issues one.
  if (moveApi.routes.has(route) && await moveApi.handle(req, res, { route, user, client: ip(req),
    mint: (gid) => { const wait = limited('guest:' + ip(req), 10, 3600e3); if (wait) return { wait }; const g = newGuest(gid); return { ...g, headers: cookie(req, g.token, SESSION_AGE) }; },
    cookie: (token) => cookie(req, token, SESSION_AGE) })) return;

  // A result. Without a token, the first result makes the visitor a guest (newGuest, from body.guest.gid) and the
  // answer carries its token. Guests are rated like accounts and move puzzles at GUEST_PUZZLE_WEIGHT; making guests
  // is limited per IP, and the clueless rule (rate()) keeps a brand-new one from moving puzzles at all.
  if (route === 'POST /api/result') {
    if (refuse(res, 'res:' + (user ? 'u' + user.id : ip(req)), 60, 60e3)) return;
    const { puzzleId, win, casual, theme, ms, log, guest } = await body(req);
    if (user) user = db.prepare(`SELECT ${USER} FROM users WHERE id = ?`).get(user.id); // fresh: another result may have landed meanwhile
    if (typeof puzzleId !== 'string' || typeof win !== 'boolean') return json(res, 400, { error: 'bad result' });
    const p = db.prepare('SELECT * FROM puzzles WHERE id = ?').get(puzzleId);
    if (!p) return json(res, 404, { error: 'no such puzzle' });
    let token = null;
    if (!user) {
      if (refuse(res, 'guest:' + ip(req), 10, 3600e3)) return;
      ({ user, token } = newGuest(guest?.gid));
    }
    const issued = token ? { token } : {}, setCookie = token ? cookie(req, token, SESSION_AGE) : {};
    // Only the first attempt is recorded and rated; repeats change nothing.
    if (db.prepare('SELECT 1 FROM attempts WHERE user_id = ? AND puzzle_id = ?').get(user.id, p.id))
      return json(res, 200, { rated: false, user: publicUser(user), settings: ownSettings(user), userDelta: 0, puzzleRating: Math.round(p.rating), ...issued }, setCookie);
    // A miss from an open tab running a build older than MIN_MISS_BUILD (or sending no build at all) is recorded unrated:
    // that code can call a winning move a miss (it wanted the shortest win, and timed its still-wins check out as a
    // miss), and a tab keeps the code it was opened with until it reloads. Wins are the same in every build and count.
    const stale = MIN_MISS_BUILD > 0 && !win && !((+q.b || 0) >= MIN_MISS_BUILD);
    // A paused or rejected puzzle (reached by id: history, a link, an old tab or queue, a day it was the daily) is recorded
    // unrated, unrated_why naming its status (PLAN P3, V8). The client shows its usual "not rated" for it.
    const off = pickable(p) ? null : statusOf(p);
    const rated = casual !== true && !stale && !off; // hints make an attempt casual (Lichess rule)
    // The theme practice weight only for one of the puzzle's own themes (V20): any other theme sent is the normal weight.
    const th = typeof theme === 'string' && Object.hasOwn(THEMES, theme) && (p.themes || '').split(',').includes(theme) ? theme : undefined;
    const w = themeWeight(th, THEMES, win);
    const r = rated ? rate(user, p, win, w, user.name == null ? w * GUEST_PUZZLE_WEIGHT : w) : null;
    const userDelta = r ? r.userDelta : 0;
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO attempts (user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts, ms, log) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(user.id, p.id, win ? 1 : 0, rated ? 1 : 0, user.rating, p.rating, userDelta, now(), cleanMs(ms), cleanLog(log));
      if (rated) db.prepare('UPDATE users SET rating = ?, rd = ?, vol = ?, games = games + 1, wins = wins + ? WHERE id = ?').run(r.user.rating, r.user.rd, r.user.vol, win ? 1 : 0, user.id);
      if (rated) db.prepare('UPDATE puzzles SET rating = ?, rd = ?, vol = ?, attempts = attempts + 1, solves = solves + ? WHERE id = ?').run(r.puzzle.rating, r.puzzle.rd, r.puzzle.vol, win ? 1 : 0, p.id);
      logLegacyResult(db, { user, puzzle: p, win, rated, unratedWhy: off || (stale ? 'stale-build' : 'casual'), theme: th, weight: w, puzzleWeight: user.name == null ? w * GUEST_PUZZLE_WEIGHT : w, r, build: +q.b || 0, ms: cleanMs(ms), ts: now() }); // ledger (server/log.js): a SAVEPOINT that never throws
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (rated) { pool.refresh(p.id); puzzleWrites++; } // its rating, rd and attempts moved
    if (rated && !win) shadow.legacyMiss(user.id, p.id, user.name == null); // queued only (never throws); judged later, after this answer
    const u = db.prepare(`SELECT ${USER} FROM users WHERE id = ?`).get(user.id);
    return json(res, 200, { rated, user: publicUser(u), settings: ownSettings(u), userDelta, puzzleRating: Math.round(r ? r.puzzle.rating : p.rating), ...issued }, setCookie);
  }

  if (route === 'GET /api/history') {
    if (!user) return json(res, 200, { history: [] });
    // refund: a refunded miss counted as solved (attempts.refund, added by initLog); its user_delta is the row's net effect
    // on the rating (what the refund applied, plus the miss where it stands), not the solve then (server/log.js addRefundColumn)
    const rows = db.prepare(`SELECT a.puzzle_id, a.win, a.rated, a.user_rating, a.user_delta, a.refund, a.ts, p.rating AS puzzle_rating, p.themes, p.plies, p.size
      FROM attempts a JOIN puzzles p ON p.id = a.puzzle_id WHERE a.user_id = ? ORDER BY a.ts DESC LIMIT 200`).all(user.id);
    return json(res, 200, { history: rows });
  }

  if (route === 'GET /api/themes') {
    const { all, bySize, sizes } = themeCounts(); // theme counts for the chosen board size
    const c = q.size ? (Object.hasOwn(bySize, q.size) ? bySize[q.size] : { total: 0, themes: {}, turning: { total: 0, themes: {} } }) : all;
    return json(res, 200, { total: c.total, themes: c.themes, turning: c.turning, sizes });
  }

  // Gone: clients before 2026-11-15 sent a guest's result here (recorded in guest_attempts, which newGuest still
  // replays). No client has sent one since; a straggler gets a clean refusal.
  if (route === 'POST /api/guest-result') return json(res, 410, { error: 'gone: reload the page' });

  // The browser reports requests that took it a long time (its timing includes the network; ours doesn't), one per
  // call, or {batch: [...]} of reports that waited for the connection (api.js flushSlow): the first 10, each counted
  // against the limit. Every field is the client's word: only known keys, in range, become tokens (slowFields).
  if (route === 'POST /api/slow') {
    if (refuse(res, 'slow:' + ip(req), 30, 60e3)) return;
    const b = await body(req);
    const cf = slowCf(req);
    const reports = Array.isArray(b.batch) ? b.batch.slice(0, 10) : [b], lines = [];
    for (let i = 0; i < reports.length; i++) {
      const r = reports[i];
      if (!r || typeof r !== 'object' || Array.isArray(r) || (i > 0 && limited('slow:' + ip(req), 30, 60e3))) continue;
      const pathStr = typeof r.path === 'string' ? r.path.slice(0, 120).replace(/[^\x21-\x7e]/g, '') || '?' : '?'; // printable ASCII: no NEL, ESC, NUL
      const ms = Number.isFinite(r.ms) ? Math.round(r.ms) : -1;
      lines.push(`${new Date().toISOString()} SLOW-CLIENT ${pathStr} ${ms}ms ${r.outcome === 'retried' || r.outcome === 'failed' ? r.outcome : 'ok'} ${who(req)}${r.hidden ? ' hidden' : ''}` +
        `${user ? ' u' + user.id : ''}${slowFields(r)}${cf}`);
    }
    if (lines.length) logLine(lines.join('\n')); // one write: a batch's lines stay together and in order
    return json(res, 200, {});
  }

  if (route === 'GET /api/leaderboard') {
    // Every named player with a rated puzzle, by rating; provisional ones are flagged so the page shows "1650?".
    const rows = db.prepare('SELECT name, rating, rd, games, wins FROM users WHERE name IS NOT NULL AND games > 0 ORDER BY rating DESC LIMIT 50').all();
    return json(res, 200, { leaders: rows.map(({ rd, ...r }) => ({ ...r, rating: Math.round(r.rating), provisional: provisional({ rd }) })) });
  }

  // 6x6 engine analysis for the review panel (Syntaks; see server/syntaks.js). Each uncached call is ~1.2 s of one
  // crux core, so misses have a tighter per-IP limit than cache hits, and a client gets at most 2 in flight.
  // lines (optional, 1 to 3): MultiPV in the same 1.2 s search, each line shallower; the reply then also has
  // lines: [{ move, pv, scoreCp, mate, winProb, wdl, depth }] and multipv (false when the engine gave one line).
  if (route === 'GET /api/analyze') {
    const lines = q.lines == null || q.lines === '' ? 1 : /^[1-3]$/.test(q.lines) ? +q.lines : null;
    if (lines == null) return json(res, 400, { error: 'lines: 1 to 3' });
    return engineCall(req, res, q, user, { tag: 'ana', perMin: 30, inflightMax: 2, lines, out: (r) => r });
  }
  // Play-on: Syntaks defends a position the browser couldn't decide (the player plays their move out against it), while
  // the in-browser engine downloads or where it's too slow. The same pool and cache as /api/analyze, ahead of it in the
  // queue (a game is waiting on it), with its own per-player allowance; one reply at a time per player. The reply is
  // the engine's move; mate and winProb are from White's side.
  if (route === 'GET /api/defend') return engineCall(req, res, q, user, { tag: 'def', perMin: 40, inflightMax: 1, priority: true,
    out: (r, g) => legalIn(g, r.best) && ({ move: g.canon(r.best), mate: r.mate, winProb: r.winProb, side: r.side, depth: r.depth, ms: r.ms, ...(r.cached ? { cached: true } : {}) }) });

  if (route === 'GET /api/stats') return json(res, 200, stats());
  if (await rush.handle(req, res, url, route, { user, body, json, refuse: (...limit) => refuse(res, ...limit), ip: ip(req) })) return;

  return json(res, 404, { error: 'unknown route' });
}

// Access log: one line per request — ISO time, method, path, status, server ms, client (short hash of the IP),
// user id. Lets us tell a slow server from a slow network: compare with the client's own timings, which
// it reports to /api/slow when a request felt slow (a SLOW-CLIENT line: see slowFields below). Rotated to .1 at 5 MB.
const ACCESS_LOG = process.env.TINUE_ACCESS_LOG || path.join(ROOT, 'data', 'access.log');
// Client tag in the access log: a keyed hash of the IP that changes every UTC day. Same-day requests from one client
// still group together (visitor counts, latency), but the tag can't be reversed to an IP (an unkeyed short hash can,
// by brute force) or followed across days. The key lives next to the database and never leaves the server.
const LOG_SECRET = (() => {
  const f = path.join(path.dirname(DB_PATH), 'log-secret');
  try { const k = fs.readFileSync(f, 'utf8').trim(); if (/^[a-f0-9]{64}$/.test(k)) return k; } catch {}
  const k = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(f, k + '\n', { mode: 0o600 }); } catch {} // unwritable: a per-process key, same guarantees
  return k;
})();
// A SLOW-CLIENT line (POST /api/slow): ISO time, SLOW-CLIENT, path, client ms, ok|retried|failed, client tag,
// [hidden], [u<id>], then key=value tokens, each only when sent and well-formed: err= the failed try's error name
// (AbortError: the client's timeout; TypeError: the fetch failed at the network level), on=1|0 (navigator.onLine),
// et= rtt= dl= sd=1|0 (navigator.connection: effective type, ms, Mbps, save-data), tries=, sinceok= (ms since the tab's
// last answered call, -1 never), build=, queued= (ms the report waited for the connection), cc= (cf-ipcountry),
// colo= (Cloudflare data centre, from the end of cf-ray). No IP, no full cf-ray, no other header.
const slowInt = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null);
function slowFields(r) {
  const c = r.conn && typeof r.conn === 'object' && !Array.isArray(r.conn) ? r.conn : {};
  const dl = Number.isFinite(c.downlink) && c.downlink >= 0 && c.downlink <= 1e4 ? +c.downlink.toFixed(2) : null;
  return [
    ['err', typeof r.err === 'string' && /^[A-Za-z]{1,40}$/.test(r.err) ? r.err : null],
    ['on', typeof r.online === 'boolean' ? +r.online : null],
    ['et', typeof c.effectiveType === 'string' && /^(?:slow-2g|[234]g)$/.test(c.effectiveType) ? c.effectiveType : null],
    ['rtt', slowInt(c.rtt, 0, 6e4)], ['dl', dl], ['sd', typeof c.saveData === 'boolean' ? +c.saveData : null],
    ['tries', slowInt(r.tries, 0, 9)], ['sinceok', slowInt(r.sinceOk, -1, 1e10)], ['build', slowInt(r.build, 0, 1e11)],
    ['queued', slowInt(r.queued, 0, 7 * 86400e3)],
  ].map(([k, v]) => (v == null ? '' : ` ${k}=${v}`)).join('');
}
function slowCf(req) {
  const cc = req.headers['cf-ipcountry'], ray = req.headers['cf-ray'];
  const colo = typeof ray === 'string' && /-([A-Z]{3,4})$/.exec(ray);
  return (typeof cc === 'string' && /^[A-Z]{2}$/.test(cc) ? ' cc=' + cc : '') + (colo ? ' colo=' + colo[1] : '');
}
const who = (req) => crypto.createHmac('sha256', LOG_SECRET).update(new Date().toISOString().slice(0, 10) + ' ' + ip(req)).digest('hex').slice(0, 8);
function logLine(line) {
  try {
    if ((fs.statSync(ACCESS_LOG, { throwIfNoEntry: false })?.size || 0) > 5e6) fs.renameSync(ACCESS_LOG, ACCESS_LOG + '.1');
    fs.appendFile(ACCESS_LOG, line + '\n', () => {});
  } catch {}
}

// A malformed request must never take the process down.
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));
process.on('uncaughtException', (e) => console.error('uncaught exception', e));

let stopping = false; // SIGTERM came (shutdown below)
const server = http.createServer(async (req, res) => {
  if (stopping) res.setHeader('connection', 'close');
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // With the /api/move routes on, a nonce= in any query string is blanked (a nonce is a capability; it goes in a header).
    const u = moveApi.routes.size ? (req.url || '').replace(/([?&;]nonce=)[^&;#]*/gi, '$1-') : req.url || '';
    logLine(`${new Date().toISOString()} ${req.method} ${u.slice(0, 200)} ${res.statusCode} ${ms.toFixed(1)}ms ${who(req)}${res.userId ? ' u' + res.userId : ''}`);
  });
  try {
    const url = new URL(req.url, 'http://x');
    if (moved(req, res, url)) return;
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    let sm;
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url);
    else if ((req.method === 'GET' || req.method === 'HEAD') && (sm = /^\/p\/([\w.-]+?)(\.png)?$/.exec(url.pathname))) share(req, res, sm[1], !!sm[2]);
    else serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof TypeError && e.code === 'ERR_INVALID_URL') { if (!res.headersSent) res.writeHead(400).end(); return; }
    if (!e.status) console.error(e); // client errors (bad json, too big) are expected; only log real failures
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'server error' });
  }
});

// Keep idle connections open longer than the proxies in front keep theirs (cloudflared pools origin connections for
// up to 90 s, Caddy for 60 s). With Node's 5 s default, a proxy can reuse a socket the server has just closed and, for a POST it won't
// retry, answer the player with a 502.
server.keepAliveTimeout = 120e3;
server.headersTimeout = 125e3;

// WAL housekeeping. SQLite never shrinks the WAL file on its own: after a big import it stayed at 97 MB on crux.
// journal_size_limit truncates it back to 8 MB whenever it is reset; a TRUNCATE checkpoint at startup (before listening)
// and every CHECKPOINT_MS empties it. A checkpoint blocks the event loop while it copies the frames written since the
// last one: ~1-10 ms for minutes of results, ~1.4 s for a 99 MB import's worth (which the first commit after an import
// pays today anyway, as the automatic checkpoint). With another process reading (players-live, guest-watch) it can't
// reset the WAL and returns at once (busy), to try again next time. Slow or busy ones are logged.
const CHECKPOINT_MS = +process.env.TINUE_CHECKPOINT_MS || 5 * 60e3;
db.exec('PRAGMA journal_size_limit = 8388608');
function checkpoint() {
  const t0 = performance.now();
  try {
    db.exec('PRAGMA busy_timeout = 0'); // never wait on a reader: busy now, try again next time
    const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(), ms = performance.now() - t0;
    if (ms > 100 || r.busy) console.log(`checkpoint ${ms.toFixed(0)} ms${r.busy ? ` busy (${r.checkpointed}/${r.log} frames)` : ''}`);
  } catch (e) { console.error('checkpoint', e.message); } finally { db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`); }
}

// SIGTERM (a restart, or the move to another host): take no new connections, finish the requests under way (at most
// STOP_MS), empty the WAL into the database, exit 0. A result being written is answered, not cut off.
const STOP_MS = 8000;
function shutdown() {
  if (stopping) return;
  stopping = true;
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    setTimeout(() => { // the last access-log lines are written asynchronously
      checkpoint();
      try { db.close(); } catch (e) { console.error('close', e.message); }
      console.log('tinue stopped');
      process.exit(0);
    }, 50);
  };
  server.close(end);
  setInterval(() => server.closeIdleConnections(), 50);
  setTimeout(end, STOP_MS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.on('SIGTERM', shutdown);
  server.on('error', (e) => { console.error(e); if (!server.listening) process.exit(1); }); // can't listen (the port is taken): not a success, and not for uncaughtException to swallow
  console.log(`attempts: ${attemptDups} duplicate (user_id, puzzle_id) pair${attemptDups === 1 ? '' : 's'}`);
  checkpoint();
  setInterval(checkpoint, CHECKPOINT_MS).unref();
  themeCounts();
  stats();
  const host = process.env.HOST || '127.0.0.1';
  server.listen(PORT, host, () => console.log(`tinue on http://${host}:${PORT}`));
}

// For scripts/test-picker-equiv.mjs: the API handler and the picker's pool (whose top() it swaps for the old SQL);
// for scripts/test-pstate.mjs: the daily tiers.
export { api, pool, DAILY_TIERS };
