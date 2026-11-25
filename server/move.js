// Per-ply reporting, server side (docs/plan/PLAN.md §1.2 "API", steps C1a and C1b): POST /api/move and GET /api/attempt.
// NOTHING HERE RATES. These routes never write `attempts`, `puzzles` or `rating_event`, and never change a rating. The
// client (public/outbox.js) posts here only when the server advertises the judge (server.js JUDGE_FIELD), off by default. Only decide mode (C1b) may create a user: a nameless guest, through
// server.js's newGuest under its 10/h/IP guest limit, exactly as a first /api/result does today.
//
// Switch: TINUE_JUDGE = off (default) | shadow | veto | decide, parsed by server/judge-mode.js (trimmed, any case;
// anything else is off, with one startup warning).
//   off     the routes do not exist: createMoveApi() creates no table and matches no route, so a caller gets exactly
//           what any unknown API route gets today: 404 {"error":"unknown route"}, body unread. ("routes unused" is the
//           plan's rollback.)
//   shadow  the routes run in shadow: rows only for signed-in users, never a guest minted.
//   veto    exactly as shadow. veto is S5's /api/result switch; S5 is not built, so until it is, veto must behave as
//           shadow here (and in server/shadow.js).
//   decide  shadow judging plus C1b: a ply without a token is bound to a guest (below), and attempts rows say
//           mode 'decide'. Still unrated: the deciding transaction that rates is D1b. Not for production before D1b.
//
// Decide mode: guest binding (C1b; PLAN §1.2 "Identity", "Guests").
//   A first ply of a new nonce without a token mints a guest (ctx.mint: server.js newGuest under the shared
//   'guest:<ip>' 10/h limit, after the ply is validated and the per-address limits pass) and the attempt is bound to it.
//   Its answer carries {token} (and the cookie, where server.js would set one).
//   Minting is idempotent per nonce: the minted token is kept sealed in move_mint (AES-256-GCM under a key derived
//   from the nonce and a server key: data/mint-key, created 0600 in decide mode only; never printed), so a retry
//   without a token (the answer was lost) gets the same token and no second guest. A tokenless ply of a known nonce
//   whose attempt minted its guest (move_attempt.minted; never an account's or a token-bearing guest's attempt: 409)
//   acts as that attempt's user for that attempt only: the nonce is the capability (it is never logged; the GET takes
//   it in a header). The seal is dropped once a request for the attempt carries that user's token as a Bearer header
//   (the page holds it), or after MINT_TTL. Without the seal (expired, key lost) a tokenless retry is still bound to
//   the same user and gets no token: never a second guest.
//   A process death between newGuest's commit and the attempt's insert (no await between them) would leave one
//   nameless guest with no rows and no rating change; the retry then mints again. That is the only double-mint window.
//
// Restarts (C1b; PLAN §1.2 "Restarts"). A move ply is marked `judging` (attempt.state) while its inputs are awaited.
//   On startup every undecided attempt with an unjudged ply at its head (state `judging`, or a ply received but not yet
//   judged) is re-queued: judged again from its stored body, in order, behind the same per-nonce chain. An attempt
//   re-queued more than MAX_REQUEUES times (a ply that kills the process) and a ply whose inputs threw MAX_TRIES times
//   in one process resolve `undecided` (fault 'restart' / 'crash') -> an unrated miss (I2). A `pending` ply (a prover
//   search, none exists before S2/D3) cannot be re-run: its final verdict is 'unknown' -> missed, unrated (I6).
//   Open play-outs are left as they are (the client runs them until D2).
//
// Protocol.
//   POST /api/move   body: JSON (sent as text/plain so a browser needs no preflight for it), at most MAX_BODY bytes
//     {puzzleId, rev, nonce, ply, move? | act?: 'hint'|'view'|'giveup'|'leave'|'unload', seen?, clientVerdict?, ms?, theme?, b?}
//     nonce  the client's random id for one page-and-puzzle load: [A-Za-z0-9_-]{16,64}. It names one attempt.
//     ply    0, 1, 2, ... counting the client's posts (moves and acts) in that attempt, < MAX_PLY. The server judges
//            plies in ply order: one that arrives ahead of a missing earlier one waits (verdict 'queued') and is
//            judged when the gap fills.
//     rev    the puzzle rev the client loaded. Missing: taken as 0 only while the puzzle has never been revised
//            (puzzles.rev = 0); otherwise, or for a rev with no tree on record, the moves are judged as `undecided`.
//   Answers (200): {attempt, ply, verdict, reply?, cap?, proven?, refutation?, why?, mode: 'shadow'}
//     verdict: the judge's (shared/judge.js) | 'queued' (waiting for an earlier ply) | 'illegal' (not a legal move in
//     the position this attempt has reached) | 'logged' (after the attempt was decided or became a conflict: kept,
//     never judged). Without a signed-in user nothing is written: {mode: 'shadow', stored: false}.
//
//   GET /api/attempt with header x-tinue-nonce: <n>   the attempt's state and plies, to its own user only (anyone
//     else: 404). The nonce is never taken from the query string: a URL lands in the access log.
//
// Rules (PLAN §1.2).
//   Identity: one `attempt` row per nonce (attempt.nonce is UNIQUE). A nonce is bound to its first ply's user, puzzle
//     and rev; a ply naming another user or puzzle for it gets 409 and is not stored.
//   Idempotency on (nonce, ply): every ply is stored once (`ply`, plus its receipt in `move_req`). A replay whose
//     semantic field (`move`, compared canonically, or `act`) matches returns the stored answer; timing and client
//     fields (ms, seen, clientVerdict, b, theme) are ignored and never conflict.
//   Conflicts: a different move or act for a stored ply is logged and answered with the stored answer. An undecided
//     attempt becomes `conflict` (closed, unrated, nothing after it is judged); a decided attempt never changes.
//   Serialised per attempt: every request for a nonce runs after the previous one for that nonce (a promise chain).
//   Decided attempts never change: state, result, why, decided_ply, rated, unrated_why and closed are written once.
//   Shadow rows: mode 'shadow', first 0 (attempt_first is for a deciding transaction, and legacy rows from
//     /api/result already take first = 1), rated 0, unrated_why 'shadow'. What the judge itself would have rated is
//     kept beside it in move_attempt (would_rate, would_why) for the comparison report; it is never applied.
//   Caps (a stranger cannot fill the disk): only existing users write; MAX_PLY plies per attempt; a ply at most
//     WINDOW ahead of the first unjudged one. Per user, kept in the database (a restart does not reset them): at most
//     LIMITS.dayAttempts new attempts and LIMITS.dayPlies stored plies per UTC day (counted from the user's own shadow
//     rows; replays of stored plies are always answered). Per user in memory: newPer10Min new attempts per 10 minutes,
//     pliesPerMin posts a minute. Per caller address in memory (never stored or printed): ipNewPer10Min new attempts
//     per 10 minutes, ipPliesPerDay stored plies per 24 hours. No limit is shared by all callers, so no one can use up
//     anyone else's (C1b/D1b: keep it that way for decide-mode attempts). A request a limit refuses counts against none.
//     Worst case per user ~ dayPlies x ~280 bytes ~ 0.8 MB a day. No retention job yet: shadow rows (move_req, ply,
//     move_attempt) are only for the C2 comparison and can be deleted once G1 is decided.
//   First (Decision 15) for the would-rate: an `attempts` row or a first `attempt` row when the attempt opens, or
//     another shadow attempt of the same user and puzzle that decided (closed) before this one decides -> 'repeat'.
//     A legacy /api/result row written after the attempt opened is not counted: in C2 the same page load's own
//     /api/result lands then, and there is no link from it to the nonce yet. The C2 report must treat a legacy result
//     from another tab between open and decision as a known, rare overcount of would_rate.
//   Log: a conflict prints "move: conflict a<attempt id> ply <n> ..."; a startup re-queue prints counts only. No line
//     anywhere holds a token, IP, nonce, gid or user agent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Game } from '../shared/tak.js';
import { judge, newAttempt, pliesLeftOf, result as judgeResult } from '../shared/judge.js';
import { bookKey } from '../shared/book.js';
import { THEMES } from '../shared/themes.js';
import { BOOK_VER, bookLookup, bookNodeLookup } from './book.js';
import { statusOf } from './puzzle-state.js';
import { COMMIT } from './revision.js';
import { PTN_RE, GID_RE, cleanMs, httpError } from './common.js';
import { addColumns } from './schema.js';
import { MODES, judgeMode } from './judge-mode.js';

export { MODES, judgeMode };
export const NONCE_HEADER = 'x-tinue-nonce';
export const MAX_REQUEUES = 2, MAX_TRIES = 3, MINT_TTL = 86400e3;
const ROW_MODES = new Set(['shadow', 'decide']); // attempt rows these routes own (never 'legacy')
export const MAX_BODY = 2048, MAX_PLY = 64, WINDOW = 16;
export const LIMITS = Object.freeze({ newPer10Min: 20, pliesPerMin: 240, dayAttempts: 300, dayPlies: 3000, ipNewPer10Min: 200,
  ipPliesPerDay: 20000, anonPerMin: 120 });
const DAY = 86400e3;
const ACTS = new Set(['hint', 'view', 'giveup', 'leave', 'unload']);
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const ROUTES = new Set(['POST /api/move', 'GET /api/attempt']);

export function initMove(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS move_attempt (   -- shadow judging state per /api/move attempt (server/move.js)
  attempt_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  next INTEGER NOT NULL DEFAULT 0,          -- the lowest ply not yet judged
  judge TEXT NOT NULL,                      -- shared/judge.js attempt state, JSON
  track TEXT,                               -- JSON moves on the board so far (tree replies included); NULL: not known
  would_rate INTEGER, would_why TEXT,       -- what the judge would have rated at the decision (never applied)
  conflicts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS move_req (       -- each ply as received, once: its semantic key and cleaned body
  attempt_id INTEGER NOT NULL, n INTEGER NOT NULL,
  sem TEXT NOT NULL,                        -- 'm:<canonical move>' | 'a:<act>'
  body TEXT NOT NULL, ts INTEGER NOT NULL,
  judged INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (attempt_id, n)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS move_attempt_user ON move_attempt(user_id);
CREATE TABLE IF NOT EXISTS move_mint (      -- decide mode: the token minted for a nonce, sealed, until the page holds it
  attempt_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  box TEXT NOT NULL,                        -- base64 iv|tag|AES-256-GCM(token), key HMAC(mint key, nonce)
  ts INTEGER NOT NULL
);
`);
  addColumns(db, 'move_attempt', [['requeues', 'INTEGER NOT NULL DEFAULT 0'], // startups that re-queued it
    ['minted', 'INTEGER NOT NULL DEFAULT 0']]); // 1: its user is a guest minted for its nonce
}

// The server's key for sealing minted tokens: 32 random bytes as hex in `file` (created 0600 when missing). No file,
// or one that cannot be read or written: a key for this process only (a restart then loses the seals, never a guest).
export function mintKey(file) {
  if (file) {
    try { const k = fs.readFileSync(file, 'utf8').trim(); if (/^[a-f0-9]{64}$/.test(k)) return Buffer.from(k, 'hex'); } catch {}
    const k = crypto.randomBytes(32);
    try { fs.writeFileSync(file, k.toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); return k; } catch {}
    try { const k2 = fs.readFileSync(file, 'utf8').trim(); if (/^[a-f0-9]{64}$/.test(k2)) return Buffer.from(k2, 'hex'); } catch {} // a race
  }
  return crypto.randomBytes(32);
}
const sealKey = (key, nonce) => crypto.createHmac('sha256', key).update('mint ' + nonce).digest();
export function seal(key, nonce, token) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', sealKey(key, nonce), iv);
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function unseal(key, nonce, box) {
  try {
    const b = Buffer.from(box, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey(key, nonce), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const t = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    return /^[a-f0-9]{48}$/.test(t) ? t : null;
  } catch { return null; }
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// The request body, read only up to MAX_BODY bytes; JSON object or 400/413.
async function readBody(req) {
  if (+req.headers['content-length'] > MAX_BODY) throw httpError(413, 'too big');
  let s = '';
  for await (const c of req) { s += c; if (s.length > MAX_BODY) throw httpError(413, 'too big'); }
  let o;
  try { o = JSON.parse(s); } catch { throw httpError(400, 'bad json'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw httpError(400, 'bad json');
  return o;
}

// A ply body, checked field by field: { nonce, n, puzzleId, rev, move | act, seen, clientVerdict, ms, theme, b } or
// throws 400. (The move is only checked for shape here; its canonical form needs the board size.)
export function parsePly(o) {
  const bad = (why) => { throw httpError(400, 'bad ply: ' + why); };
  if (typeof o.nonce !== 'string' || !NONCE.test(o.nonce) || o.nonce.startsWith('legacy-')) bad('nonce');
  if (!isInt(o.ply, 0, MAX_PLY - 1)) bad('ply');
  if (typeof o.puzzleId !== 'string' || !/^[\w.-]{1,64}$/.test(o.puzzleId)) bad('puzzleId');
  if (o.rev != null && !isInt(o.rev, 0, 1e9)) bad('rev');
  const hasMove = o.move != null, hasAct = o.act != null;
  if (hasMove === hasAct) bad('one of move, act');
  if (hasMove && (typeof o.move !== 'string' || o.move.length > 24 || !PTN_RE.test(o.move))) bad('move');
  if (hasAct && !ACTS.has(o.act)) bad('act');
  return {
    nonce: o.nonce, n: o.ply, puzzleId: o.puzzleId, rev: o.rev ?? null,
    ...(hasMove ? { move: o.move } : { act: o.act }),
    seen: isInt(o.seen, 0, 999) ? o.seen : null,
    clientVerdict: typeof o.clientVerdict === 'string' && /^[a-z-]{1,16}$/.test(o.clientVerdict) ? o.clientVerdict : null,
    ms: cleanMs(o.ms),
    theme: typeof o.theme === 'string' && Object.hasOwn(THEMES, o.theme) ? o.theme : null,
    b: isInt(o.b, 1, 1e11) ? o.b : null,
    // decide mode, minting only: a pre-2026-11-15 browser's anonymous id, as /api/result takes it. Never stored here.
    gid: o.guest && typeof o.guest === 'object' && typeof o.guest.gid === 'string' && GID_RE.test(o.guest.gid) ? o.guest.gid : null,
  };
}

// The judge's inputs for a move ply (shared/judge.js `inputs`), from what the server holds: the rules, the tree of the
// rev the client loaded, and the book (only when TINUE_BOOK_VER > 0). No prover and no Syntaks reply in C1a, so an
// off-tree move is `undecided` (I2): an unrated result, never a rated one. ctx: { db, pz (puzzle at the rev, or null),
// track (moves so far, or null), canon, now }. Returns { inputs, after } where after is the game after the move, or
// { illegal: true }.
export function moveInputs({ db, pz, track, canon, now }) {
  if (!pz) return { inputs: { fault: { reason: 'rev' }, now } };
  if (!track) return { inputs: { fault: { reason: 'board' }, now } };
  let g, node;
  try { ({ g, node } = replay(pz, track)); } catch { return { inputs: { fault: { reason: 'board' }, now } }; }
  let mv;
  try { mv = g.parseMove(canon); if (!g.isLegal(mv)) return { illegal: true }; } catch { return { illegal: true }; }
  const before = BOOK_VER > 0 ? safe(() => bookKey(g, pz.komi)) : null;
  g.apply(mv);
  const res = g.result();
  const inputs = { game: res, left: pliesLeftOf(node) || undefined, now };
  if (node && node !== 'win' && typeof node === 'object' && Object.hasOwn(node, canon) && !res) inputs.tree = { key: true, reply: node[canon]?.r ?? null };
  if (BOOK_VER > 0) {
    const after = safe(() => bookKey(g, pz.komi));
    const b = after && safe(() => bookLookup(db, after));
    if (b) inputs.book = { pos: b.pos, ver: b.ver, win_len: b.win_len, exact: b.exact, checked: b.checked };
    const nd = before && safe(() => bookNodeLookup(db, before));
    if (nd && nd.moves?.[canon] === 'refuted') inputs.node = { pos: nd.pos, ver: nd.ver, model: nd.model, refuted: true };
  }
  return { inputs };
}
const safe = (f) => { try { return f(); } catch { return null; } };
// The game and tree node after the moves in track (player moves and tree replies, in order).
function replay(pz, track) {
  const g = Game.fromTPS(pz.tps, pz.komi || 0);
  let node = pz.tree;
  for (let i = 0; i < track.length; i++) {
    g.play(track[i]);
    if (i % 2 === 0) node = node && node !== 'win' && typeof node === 'object' ? node[track[i]]?.n ?? null : null;
  }
  return { g, node };
}

// Why the attempt was decided, in the attempt.why vocabulary (PLAN §1.3), from the deciding ply's evidence.
function whyOf(p) {
  const e = p?.evidence || {};
  if (e.playout) return { held: 'defended', gaveup: 'giveup', invalid: 'noengine' }[e.playout.why] || e.playout.why;
  if (e.kind === 'prover') return 'proof';
  if (e.kind === 'act') return e.act === 'leave' ? 'left' : e.act === 'expire' ? 'expired' : e.act;
  return e.kind || null;
}

// The answer a client gets for a judged ply (what is stored in ply.answer).
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));
const answerOf = (id, n, ans, mode) => ({ attempt: id, ply: n, ...pick(ans, ['verdict', 'reply', 'cap', 'proven', 'refutation', 'why']), mode });
// The attempt.state of an undecided attempt, from its judge state.
const openStateOf = (ja, res) => (res.state === 'blocked' ? (ja.playout && !ja.playout.end ? 'playout' : 'pending') : 'open');

// Options (tests): mode, now, inputs, limits; mintKeyFile (server.js: data/mint-key; decide mode only reads it);
// requeue: false to skip the startup re-queue.
export function createMoveApi(db, { mode: modeIn = judgeMode(), now = Date.now, inputs = moveInputs, limits = {}, mintKeyFile = null, requeue: doRequeue = true } = {}) {
  const L = { ...LIMITS, ...limits };
  const mode = MODES.has(modeIn) ? modeIn : 'off';
  if (mode === 'off') return { mode, routes: new Set(), handle: async () => false };
  // veto: S5 is not built, so veto is shadow here until it is. decide: shadow judging plus guest binding.
  const decide = mode === 'decide', rowMode = decide ? 'decide' : 'shadow';
  initMove(db);
  const key = decide ? mintKey(mintKeyFile) : null;
  const q = {
    attemptByNonce: db.prepare('SELECT * FROM attempt WHERE nonce = ?'),
    state: db.prepare('SELECT * FROM move_attempt WHERE attempt_id = ?'),
    req: db.prepare('SELECT * FROM move_req WHERE attempt_id = ? AND n = ?'),
    reqs: db.prepare('SELECT n, sem, judged FROM move_req WHERE attempt_id = ? ORDER BY n'),
    ply: db.prepare('SELECT * FROM ply WHERE attempt_id = ? AND n = ?'),
    plies: db.prepare('SELECT n, by, move, verdict, ts, client_ms, answer FROM ply WHERE attempt_id = ? ORDER BY n'),
    puzzle: db.prepare('SELECT * FROM puzzles WHERE id = ?'),
    rev: db.prepare('SELECT tree, komi, tps FROM puzzle_rev WHERE id = ? AND rev = ?'),
    hasFirst: db.prepare('SELECT (SELECT 1 FROM attempts WHERE user_id = ? AND puzzle_id = ?) a, (SELECT 1 FROM attempt WHERE user_id = ? AND puzzle_id = ? AND first = 1) b'),
    dayAttempts: db.prepare('SELECT COUNT(*) c FROM move_attempt m JOIN attempt a ON a.id = m.attempt_id WHERE m.user_id = ? AND a.opened >= ?'),
    dayPlies: db.prepare('SELECT COUNT(*) c FROM move_attempt m JOIN move_req r ON r.attempt_id = m.attempt_id WHERE m.user_id = ? AND r.ts >= ?'),
    otherDecided: db.prepare(`SELECT 1 FROM move_attempt m JOIN attempt a ON a.id = m.attempt_id
      WHERE m.user_id = ? AND a.puzzle_id = ? AND a.id != ? AND a.state = 'closed' LIMIT 1`),
    insAttempt: db.prepare(`INSERT INTO attempt (nonce, user_id, puzzle_id, first, guest, puzzle_rev, book_ver, build, "commit", mode, theme,
      opened, state, rated, unrated_why) VALUES (?,?,?,0,?,?,?,?,?,?,?,?,'open',0,NULL)`),
    user: db.prepare('SELECT id, name FROM users WHERE id = ?'),
    box: db.prepare('SELECT * FROM move_mint WHERE attempt_id = ?'),
    insBox: db.prepare('INSERT OR REPLACE INTO move_mint (attempt_id, user_id, box, ts) VALUES (?,?,?,?)'),
    dropBox: db.prepare('DELETE FROM move_mint WHERE attempt_id = ?'),
    sweepBoxes: db.prepare('DELETE FROM move_mint WHERE ts < ?'),
    setJudge: db.prepare('UPDATE move_attempt SET judge = ? WHERE attempt_id = ?'),
    updPly: db.prepare('UPDATE ply SET verdict = ?, evidence = ?, answer = ? WHERE attempt_id = ? AND n = ?'),
    bumpRequeue: db.prepare('UPDATE move_attempt SET requeues = requeues + 1 WHERE attempt_id = ? RETURNING requeues'),
    stuck: db.prepare(`SELECT a.* FROM attempt a JOIN move_attempt m ON m.attempt_id = a.id
      WHERE a.mode IN ('shadow', 'decide') AND (a.state IN ('judging', 'pending')
        OR (a.state IN ('open', 'playout') AND EXISTS (SELECT 1 FROM move_req r WHERE r.attempt_id = a.id AND r.n = m.next AND r.judged = 0)))
      ORDER BY a.id`),
    insState: db.prepare('INSERT INTO move_attempt (attempt_id, user_id, next, judge, track, minted) VALUES (?,?,0,?,?,?)'),
    insReq: db.prepare('INSERT INTO move_req (attempt_id, n, sem, body, ts) VALUES (?,?,?,?,?)'),
    insPly: db.prepare('INSERT INTO ply (attempt_id, n, by, move, src, verdict, evidence, cap, ts, client_ms, answer) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    judgedReq: db.prepare('UPDATE move_req SET judged = 1 WHERE attempt_id = ? AND n = ?'),
    setState: db.prepare('UPDATE move_attempt SET next = ?, judge = ?, track = ?, requeues = 0 WHERE attempt_id = ?'), // a judged ply: re-queues count from 0
    setWould: db.prepare('UPDATE move_attempt SET would_rate = ?, would_why = ? WHERE attempt_id = ?'),
    conflictCount: db.prepare('UPDATE move_attempt SET conflicts = conflicts + 1 WHERE attempt_id = ?'),
    // Only an attempt that is not yet decided moves; the WHERE keeps a decided row from ever being written again.
    openState: db.prepare(`UPDATE attempt SET state = ? WHERE id = ? AND state IN ('open', 'judging', 'pending', 'playout')`),
    decide: db.prepare(`UPDATE attempt SET state = 'closed', closed = ?, ms = ?, decided_ply = ?, result = ?, why = ?, rated = 0, unrated_why = 'shadow'
      WHERE id = ? AND state IN ('open', 'judging', 'pending', 'playout')`),
    conflict: db.prepare(`UPDATE attempt SET state = 'conflict', closed = ?, rated = 0, unrated_why = 'conflict'
      WHERE id = ? AND state IN ('open', 'judging', 'pending', 'playout')`),
  };
  const tx = (f) => { db.exec('BEGIN'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };
  const decided = (a) => a.state === 'closed' || a.state === 'conflict';
  const plyMs = (id, n) => safe(() => JSON.parse(q.req.get(id, n)?.body || '{}').ms) ?? null;

  // The attempt row after its judge state changed (inside a transaction): decided once, else its open state.
  function applyResult(a, cur, ja, res, ts) {
    if (decided(cur)) return;
    if (res.state === 'decided') {
      const dp = ja.plies.find((x) => x.n === res.ply);
      // Unrated in C1a/C1b whatever the mode: D1b's deciding transaction is what rates.
      q.decide.run(ts, plyMs(a.id, res.ply), res.ply, res.outcome === 'solved' ? 1 : 0, whyOf(dp), a.id);
      // First is checked again here against the user's other shadow attempts (Decision 15: the first to decide).
      const w = ja.first && q.otherDecided.get(cur.user_id, cur.puzzle_id, a.id) ? judgeResult({ ...ja, first: false }) : res;
      q.setWould.run(w.rated ? 1 : 0, w.unratedWhy ?? null, a.id);
    } else q.openState.run(openStateOf(ja, res), a.id);
  }
  // Seals of minted tokens (decide mode).
  const openBox = (a) => {
    if (!key) return null;
    const bx = q.box.get(a.id);
    if (!bx || bx.user_id !== a.user_id || now() - bx.ts > MINT_TTL) return null;
    return unseal(key, a.nonce, bx.box);
  };

  // The puzzle as of the attempt's rev: the live row when the rev is current, else the puzzle_rev snapshot, else null.
  const pzCache = new Map();
  function puzzleAt(id, rev) {
    const k = id + '|' + rev;
    if (pzCache.has(k)) return pzCache.get(k);
    const p = q.puzzle.get(id);
    let pz = null;
    if (p && (p.rev ?? 0) === rev) pz = { size: p.size, tps: p.tps, komi: p.komi || 0, tree: safe(() => JSON.parse(p.tree)) };
    else if (p) { const r = q.rev.get(id, rev); if (r) pz = { size: p.size, tps: r.tps || p.tps, komi: r.komi ?? p.komi ?? 0, tree: safe(() => JSON.parse(r.tree)) }; }
    if (pzCache.size > 500) pzCache.clear();
    pzCache.set(k, pz);
    return pz;
  }

  // ---- limits (in memory; keys are user ids or the caller's address, never stored or printed) ----
  const windows = new Map();
  // over([[key, max, ms], ...]): seconds to wait if any window is full (nothing counted), else 0 and each one counted.
  function over(list) {
    const t = now();
    const ws = list.map(([key, max, ms]) => {
      let w = windows.get(key);
      if (!w || t >= w.reset) { if (windows.size > 5e4) for (const [k, v] of windows) if (t >= v.reset) windows.delete(k); windows.set(key, (w = { n: 0, reset: t + ms })); }
      return [w, max];
    });
    const wait = Math.max(0, ...ws.map(([w, max]) => (w.n >= max ? Math.max(1, Math.ceil((w.reset - t) / 1000)) : 0)));
    if (!wait) for (const [w] of ws) w.n++;
    return wait;
  }
  // Per user per UTC day, from the database (so a restart does not reset it), kept in memory once read.
  const days = new Map();
  function today(userId) {
    const t = now(), day = Math.floor(t / DAY);
    let d = days.get(userId);
    if (!d || d.day !== day) {
      if (days.size > 5e4) days.clear();
      d = { day, attempts: q.dayAttempts.get(userId, day * DAY).c, plies: q.dayPlies.get(userId, day * DAY).c };
      days.set(userId, d);
    }
    return d;
  }
  const untilTomorrow = () => Math.max(1, Math.ceil((DAY - (now() % DAY)) / 1000));

  // ---- serialisation: one promise chain per nonce ----
  const chains = new Map();
  function serial(nonce, f) {
    const prev = chains.get(nonce) || Promise.resolve();
    const run = prev.then(f, f);
    const tail = run.catch(() => {});
    chains.set(nonce, tail);
    tail.then(() => { if (chains.get(nonce) === tail) chains.delete(nonce); });
    return run;
  }

  // Judge every received ply from `next` on while the run is contiguous. One transaction per ply.
  // fault: judge the first ply drained as this fault (a re-queue past MAX_REQUEUES): undecided, never evidence (I2).
  const tries = new Map(); // `${attempt id}:${n}` -> times its inputs threw in this process
  async function drain(a, fault = null) {
    for (;;) {
      const st = q.state.get(a.id);
      const r = q.req.get(a.id, st.next);
      if (!r || r.judged) return;
      const f = fault; fault = null; // a re-queue's fault is for the head ply only
      const att = q.attemptByNonce.get(a.nonce);
      const body = JSON.parse(r.body), n = r.n;
      const track = st.track ? JSON.parse(st.track) : null;
      let ans, nextTrack = track, judgeState = st.judge, verdictOnly = null;
      if (decided(att)) verdictOnly = 'logged';
      else if (body.act != null) {
        const out = judge(JSON.parse(st.judge), { n, act: body.act, ...(body.seen != null ? { seen: body.seen } : {}) }, { now: r.ts });
        ans = out; judgeState = JSON.stringify(out.attempt);
      } else {
        const pz = puzzleAt(att.puzzle_id, att.puzzle_rev), k = a.id + ':' + n;
        let got;
        if (f || (tries.get(k) || 0) >= MAX_TRIES) got = { inputs: { fault: { reason: f || 'crash' }, now: r.ts } };
        else {
          q.openState.run('judging', a.id); // a restart from here on finds it and re-queues it
          // A throw is treated as the process dying here: the ply stays unjudged for the client's retry or the next
          // startup's re-queue; after MAX_TRIES throws in this process it is judged as a fault (undecided).
          try { got = await inputs({ db, pz, track, canon: body.move, now: r.ts }); }
          catch (e) { if (tries.size > 1e4) tries.clear(); tries.set(k, (tries.get(k) || 0) + 1); throw e; }
          tries.delete(k);
        }
        if (got.illegal) verdictOnly = 'illegal';
        else {
          const out = judge(JSON.parse(st.judge), { n, move: body.move }, got.inputs);
          ans = out; judgeState = JSON.stringify(out.attempt);
          // The board the client goes on from: an on-tree move and its reply stay; a play-out keeps the move and the
          // defender's reply; anything else (a miss, a solve, a stale or ignored ply) is taken back, as the page does.
          // Without a reply to put on the board the position is not known past the move (null: later moves are judged
          // `undecided`).
          if (track && ['ok', 'play', 'reply'].includes(out.verdict)) nextTrack = out.reply ? [...track, body.move, out.reply] : null;
        }
      }
      tx(() => {
        // Re-read under the transaction: the decided columns are written at most once.
        const cur = q.attemptByNonce.get(a.nonce);
        const answer = verdictOnly ? { attempt: a.id, ply: n, verdict: verdictOnly, mode: att.mode } : answerOf(a.id, n, ans, att.mode);
        const p = verdictOnly ? null : ans.attempt.plies.find((x) => x.n === n);
        q.insPly.run(a.id, n, body.act != null ? 'a' : 'p', body.move ?? null, 'client', answer.verdict,
          p?.evidence ? JSON.stringify(p.evidence) : null, Number.isInteger(ans?.cap) ? ans.cap : null, r.ts, body.ms, JSON.stringify(answer));
        q.judgedReq.run(a.id, n);
        q.setState.run(n + 1, judgeState, nextTrack ? JSON.stringify(nextTrack) : null, a.id);
        // (an ignored or illegal ply changes no result, but puts a `judging` attempt back to its open state)
        if (!decided(cur)) { const ja = JSON.parse(judgeState); applyResult(a, cur, ja, verdictOnly ? judgeResult(ja) : ans.result, r.ts); }
      });
    }
  }

  // The answer for ply n of attempt a, as stored now: the judged answer, or 'queued' while it waits.
  function stored(a, n) {
    const p = q.ply.get(a.id, n);
    if (p) return JSON.parse(p.answer);
    const st = q.state.get(a.id);
    return { attempt: a.id, ply: n, verdict: 'queued', next: st.next, mode: a.mode };
  }

  // POST /api/move. user: the signed-in user or null; client: a key for the caller's in-memory limits.
  // ctx (server.js): bearer (the user came from an Authorization header), mint(gid) -> { user, token, headers } |
  // { wait } (decide mode: newGuest under the guest limit), cookie(token) -> headers (decide mode: re-issue).
  async function post(user, raw, client, ctx = {}) {
    const b = parsePly(raw);
    const tooMany = (wait) => ({ status: 429, body: { error: 'Too many requests. Try again later.' }, wait });
    if (!user) {
      const wait = over([['anon:' + client, L.anonPerMin, 60e3]]);
      if (wait) return tooMany(wait);
      if (!decide) return { status: 200, body: { mode: 'shadow', stored: false } }; // shadow never mints and writes only for users
    } else {
      const wait = over([['u:' + user.id, L.pliesPerMin, 60e3]]);
      if (wait) return tooMany(wait);
    }
    return serial(b.nonce, async () => {
      let a = q.attemptByNonce.get(b.nonce);
      let issue = null; // the token this answer carries (decide mode)
      if (a && !ROW_MODES.has(a.mode)) return { status: 409, body: { error: 'nonce in use' } };
      if (decide && a) {
        if (!user) {
          // A tokenless ply of a known nonce: that attempt's user, for this attempt only (the nonce is the capability),
          // and only when that user is the guest this nonce minted. An account's nonce (or a guest's that arrived with
          // its token) is no capability: without the token, 409, never a ply on someone's attempt.
          if (!q.state.get(a.id)?.minted) return { status: 409, body: { error: 'nonce in use' } };
          user = q.user.get(a.user_id) || null;
          if (!user) return { status: 409, body: { error: 'nonce in use' } };
          const wait = over([['u:' + user.id, L.pliesPerMin, 60e3]]);
          if (wait) return tooMany(wait);
        }
        if (a.user_id === user.id) {
          if (ctx.bearer) q.dropBox.run(a.id); // the page holds the token: the seal is no longer needed
          else issue = openBox(a); // a lost answer's retry (or a cookie-only request): the same token again
        }
      }
      if (a && (a.user_id !== user?.id || a.puzzle_id !== b.puzzleId)) return { status: 409, body: { error: 'nonce in use' } };
      let p = null;
      if (!a) {
        p = q.puzzle.get(b.puzzleId);
        if (!p) return { status: 404, body: { error: 'no such puzzle' } };
      }
      // The ply's semantic key: the canonical move (needs the board size) or the act.
      const size = p ? p.size : q.puzzle.get(a.puzzle_id)?.size;
      let sem, move = null;
      if (b.act != null) sem = 'a:' + b.act;
      else {
        const sq = /([a-h])([1-8])/.exec(b.move); // the move's square must be on this board
        try { if (sq[1].charCodeAt(0) - 97 >= size || +sq[2] > size) throw 0; move = new Game(size).canon(b.move); } catch { return { status: 400, body: { error: 'bad ply: move' } }; }
        sem = 'm:' + move;
      }
      // Limits on what would be stored: a new attempt, a new ply. A replay of a stored ply is always answered.
      let day = user ? today(user.id) : null;
      const fresh = !a || !q.req.get(a.id, b.n);
      if (fresh && day && ((!a && day.attempts >= L.dayAttempts) || day.plies >= L.dayPlies)) return tooMany(untilTomorrow());
      if (fresh) {
        const w = over([...(a ? [] : [...(user ? [['new:u' + user.id, L.newPer10Min, 600e3]] : []), ['new:ip:' + client, L.ipNewPer10Min, 600e3]]),
          ['ply:ip:' + client, L.ipPliesPerDay, DAY]]);
        if (w) return tooMany(w);
      }
      let minted = null;
      if (!user) {
        // Decide mode, a new nonce without a token: the visitor becomes a guest (validated ply, limits passed).
        const m = ctx.mint ? ctx.mint(b.gid) : null;
        if (!m) return { status: 503, body: { error: 'cannot make a guest now' } };
        if (m.wait) return tooMany(m.wait);
        user = m.user; minted = m;
        issue = m.token;
        day = today(user.id);
      }
      const t = now();
      const out = tx(() => {
        if (!a) {
          // No rev sent: rev 0 if the puzzle was never revised, else -1 (not known: its moves are judged `undecided`).
          const rev = b.rev ?? ((p.rev ?? 0) === 0 ? 0 : -1);
          const f = q.hasFirst.get(user.id, p.id, user.id, p.id);
          const ja = newAttempt({ size: p.size, komi: p.komi || 0, solver: safe(() => Game.fromTPS(p.tps, p.komi || 0).toMove) ?? 1,
            first: !f.a && !f.b, status: statusOf(p) });
          const { lastInsertRowid: id } = q.insAttempt.run(b.nonce, user.id, p.id, user.name == null ? 1 : 0, rev, BOOK_VER, b.b, COMMIT, rowMode,
            b.theme && (p.themes || '').split(',').includes(b.theme) ? b.theme : null, t);
          const pz = rev < 0 ? null : puzzleAt(p.id, rev);
          q.insState.run(id, user.id, JSON.stringify(ja), pz ? '[]' : null, minted ? 1 : 0);
          if (minted) { q.sweepBoxes.run(t - MINT_TTL); q.insBox.run(id, user.id, seal(key, b.nonce, minted.token), t); }
          a = q.attemptByNonce.get(b.nonce);
          day.attempts++;
        }
        const st = q.state.get(a.id);
        const have = q.req.get(a.id, b.n);
        if (have) {
          if (have.sem === sem) return { dup: true };
          // A different move or act for a stored ply: logged; an undecided attempt becomes `conflict`.
          q.conflictCount.run(a.id);
          const became = q.conflict.run(t, a.id).changes > 0;
          console.error(`move: conflict a${a.id} ply ${b.n}${became ? ' (attempt now conflict, unrated)' : ' (attempt already decided: unchanged)'}`);
          return { dup: true };
        }
        if (b.n >= st.next + WINDOW) return { far: true };
        q.insReq.run(a.id, b.n, sem, JSON.stringify({ ...(move != null ? { move } : { act: b.act }), seen: b.seen, clientVerdict: b.clientVerdict, ms: b.ms }), t);
        day.plies++;
        return {};
      });
      // The token goes out with the answer only (never into ply.answer); the cookie where server.js would set one.
      const extra = issue ? { body: { token: issue }, headers: (minted ? minted.headers : ctx.cookie?.(issue)) || {} } : { body: {}, headers: {} };
      if (out.far) return { status: 409, body: { error: 'ply too far ahead', next: q.state.get(a.id).next, ...extra.body }, headers: extra.headers };
      await drain(a);
      return { status: 200, body: { ...stored(a, b.n), ...extra.body }, headers: extra.headers };
    });
  }

  // GET /api/attempt (nonce in the x-tinue-nonce header): the attempt's state and plies (resume after a reload), to
  // its own user only.
  async function get(user, nonce) {
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return { status: 400, body: { error: 'bad nonce' } };
    if (!user) return { status: 404, body: { error: 'no such attempt' } };
    const wait = over([['u:' + user.id, L.pliesPerMin, 60e3]]);
    if (wait) return { status: 429, body: { error: 'Too many requests. Try again later.' }, wait };
    return serial(nonce, async () => {
      const a = q.attemptByNonce.get(nonce);
      if (!a || !ROW_MODES.has(a.mode) || a.user_id !== user.id) return { status: 404, body: { error: 'no such attempt' } };
      await drain(a);
      const cur = q.attemptByNonce.get(nonce), st = q.state.get(a.id);
      const plies = q.plies.all(a.id).map((p) => JSON.parse(p.answer));
      const waiting = q.reqs.all(a.id).filter((r) => !r.judged).map((r) => r.n);
      return { status: 200, body: { attempt: cur.id, puzzleId: cur.puzzle_id, rev: cur.puzzle_rev, mode: cur.mode, state: cur.state,
        decidedPly: cur.decided_ply, result: cur.result, why: cur.why, rated: false, next: st.next, plies, waiting } };
    });
  }

  // ---- startup re-queue (C1b) ----
  // A pending ply's search did not survive the restart and cannot be re-run here: its final verdict is 'unknown'
  // (missed, unrated: I2, I6). Inside the attempt's chain.
  function settlePending(a) {
    const st = q.state.get(a.id), ja = JSON.parse(st.judge), res = judgeResult(ja);
    if (res.state !== 'blocked' || (ja.playout && !ja.playout.end)) return false;
    const out = judge(ja, { n: res.ply, final: { kind: 'unknown', reason: 'restart' } }, {});
    if (out.verdict !== 'missed') return false;
    const t = now();
    tx(() => {
      const cur = q.attemptByNonce.get(a.nonce);
      const p = out.attempt.plies.find((x) => x.n === res.ply), old = q.ply.get(a.id, res.ply);
      const answer = { ...(old ? JSON.parse(old.answer) : { attempt: a.id, ply: res.ply, mode: a.mode }), verdict: 'missed', why: 'undecided' };
      q.updPly.run('missed', JSON.stringify(p.evidence), JSON.stringify(answer), a.id, res.ply);
      q.setJudge.run(JSON.stringify(out.attempt), a.id);
      applyResult(a, cur, out.attempt, out.result, t);
    });
    return true;
  }
  // Every undecided attempt left mid-judgement by the last process: resumed (judged again from its stored plies) or,
  // past MAX_REQUEUES startups or with a pending search, closed unrated. Counts only are printed.
  async function requeue() {
    const rows = q.stuck.all();
    const n = { resumed: 0, unrated: 0, failed: 0 };
    for (const a of rows) {
      try {
        await serial(a.nonce, async () => {
          const cur = q.attemptByNonce.get(a.nonce);
          if (!cur || decided(cur)) return;
          const times = q.bumpRequeue.get(a.id)?.requeues ?? 1;
          const settled = cur.state === 'pending' && settlePending(cur);
          const ja = JSON.parse(q.state.get(a.id).judge);
          if (q.attemptByNonce.get(a.nonce).state === 'judging') q.openState.run(openStateOf(ja, judgeResult(ja)), a.id);
          const forced = times > MAX_REQUEUES;
          await drain(q.attemptByNonce.get(a.nonce), forced ? 'restart' : null);
          n[settled || forced ? 'unrated' : 'resumed']++;
        });
      } catch { n.failed++; }
    }
    if (rows.length) console.log(`move: re-queued ${rows.length} attempt${rows.length === 1 ? '' : 's'} after restart: ${n.resumed} resumed, ${n.unrated} closed unrated, ${n.failed} still waiting`);
    return { stuck: rows.length, ...n };
  }
  const requeued = doRequeue ? Promise.resolve().then(requeue).catch((e) => { console.error('move: re-queue', e?.message); return null; }) : Promise.resolve(null);

  // The route hook for server.js: answers and returns true for the two routes, else false.
  // ctx: { route, user, client, mint?, cookie? } (the query string is never read: no nonce in a URL).
  async function handle(req, res, { route, user, client, mint, cookie }) {
    if (!ROUTES.has(route)) return false;
    const bearer = /^Bearer /.test(req.headers?.authorization || '') && !!user;
    const r = route === 'GET /api/attempt' ? await get(user, req.headers?.[NONCE_HEADER])
      : await post(user, await readBody(req), client, { bearer, mint: decide ? mint : null, cookie });
    res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(r.headers || {}), ...(r.wait ? { 'retry-after': String(r.wait) } : {}) })
      .end(JSON.stringify(r.body));
    return true;
  }

  return { mode, routes: ROUTES, handle, post, get, drain, requeue, requeued };
}
