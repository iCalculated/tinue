// Results waiting for the server: every puzzle result is written here before it is posted and removed once the server
// has it (or refuses it for good), so a failed upload, a closed tab or a server move loses nothing. The server keeps a
// player's first result for a puzzle, so a resend never counts twice.
// One localStorage key per result, tinue.r.<owner>.<puzzle id> (so two tabs never overwrite each other's), each
// { puzzleId, body, b, owner, gid, t }: body as first sent (frozen: a resend can't turn a rated miss into an unrated
// one), b the build that played it, owner a hash of the token (outbox.js ownerOf; '' before the first one), gid the
// browser's id for a tokenless send. A second result for the same puzzle doesn't replace the first. An entry goes out
// only while its owner is who is signed in. No DOM here: scripts/test-results-queue.mjs drives it with fakes.
export const PREFIX = 'tinue.r.', MAX = 50, MAX_AGE = 30 * 864e5, FRESH_MS = 25e3, WAIT_MIN = 5e3, WAIT_MAX = 300e3;
const REFUSED = new Set(['bad result', 'no such puzzle', 'too big']);
// Whether an answer settles a result: recorded (or a repeat), or refused for good. Anything else (429, a 5xx, a proxy's
// page, another route's error) keeps it.
export const settles = (r) => !!r && typeof r === 'object' && (!!r.user || REFUSED.has(r.error));
export const limited = (r) => /^too many/i.test(r?.error || '');
const valid = (e, now) => !!e && typeof e === 'object' && typeof e.puzzleId === 'string' && /^[\w.-]{1,64}$/.test(e.puzzleId) && typeof e.owner === 'string' && /^[a-z0-9]{0,12}$/.test(e.owner)
  && !!e.body && typeof e.body === 'object' && e.body.puzzleId === e.puzzleId && typeof e.body.win === 'boolean' && typeof e.t === 'number' && now - e.t < MAX_AGE;
export const keyOf = (e) => `${PREFIX}${e.owner}.${e.puzzleId}`;
// Every entry in a storage, oldest first; aged or malformed ones are dropped. (Also the move's handoff page's reader.)
export function listOf(storage, now = Date.now()) {
  const out = [];
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k?.startsWith(PREFIX)) keys.push(k); }
    for (const k of keys) {
      let e = null; try { e = JSON.parse(storage.getItem(k)); } catch {}
      if (valid(e, now) && keyOf(e) === k) out.push(e); else storage.removeItem(k);
    }
  } catch {}
  return out.sort((a, b) => a.t - b.t);
}

// storage: localStorage (or null). send(e): posts one entry → its answer (throws: none came). owner(): whose token this
// is now. settled(e, r): the server has settled it (it is off the queue already); called synchronously, before the next
// entry goes, so a token the answer brought is in place for it.
export function createResults({ storage, send, owner, settled = () => {}, now = Date.now, later = (f, ms) => setTimeout(f, ms) }) {
  const mine = new Set(), busy = new Set(); // keys this page wrote or tried; keys on their way from this page (report's own post)
  let running = null, wait = 0, until = 0, netDown = false, timer = 0, seq = 0;
  const has = (puzzleId, o = owner()) => { try { return storage.getItem(keyOf({ owner: o, puzzleId })) != null; } catch { return false; } };
  const drop = (e) => { try { storage.removeItem(keyOf(e)); } catch {} };
  const list = () => (storage ? listOf(storage, now()) : []);
  // → the entry that stands for this puzzle (an earlier one if there is one), or null when it couldn't be stored.
  function add({ puzzleId, body, b, owner: o, gid }) {
    try {
      const k = keyOf({ owner: o, puzzleId }), all = list();
      let e = all.find((x) => keyOf(x) === k);
      if (!e) {
        e = { puzzleId, body, b: b || 0, owner: o, gid: gid || null, t: now() };
        if (!valid(e, now())) return null;
        storage.setItem(k, JSON.stringify(e));
        if (storage.getItem(k) == null) return null;
        for (const old of all.slice(0, Math.max(0, all.length + 1 - MAX))) drop(old);
      }
      mine.add(k);
      return JSON.parse(storage.getItem(k));
    } catch { return null; }
  }
  // A token this browser's first result just brought: what was played before it is that player's.
  function own() {
    const o = owner();
    if (!o) return;
    for (const e of list()) if (e.owner === '') try {
      const m = { ...e, owner: o };
      if (storage.getItem(keyOf(m)) == null) storage.setItem(keyOf(m), JSON.stringify(m));
      if (mine.has(keyOf(e))) mine.add(keyOf(m));
      drop(e);
    } catch {}
  }
  function kick(ms) {
    const at = now() + ms;
    if (timer && until <= at) return;
    const id = timer = ++seq; until = at;
    later(() => { if (timer === id) { timer = 0; flush(); } }, ms);
  }
  const backoff = () => kick(wait = Math.min(WAIT_MAX, wait ? wait * 2 : WAIT_MIN));
  // Sends what is this player's, oldest first, one at a time. An entry another page wrote moments ago may still be on
  // its way from there: it gets FRESH_MS.
  async function run() {
    timer = 0;
    const tried = new Set();
    let failed = false, fresh = 0;
    for (;;) {
      const e = list().find((x) => x.owner === owner() && !tried.has(x.puzzleId));
      if (!e) break;
      tried.add(e.puzzleId);
      const k = keyOf(e), age = now() - e.t;
      if (busy.has(k)) continue;
      if (!mine.has(k) && age >= 0 && age < FRESH_MS) { fresh = Math.max(fresh, FRESH_MS - age); continue; }
      mine.add(k);
      let r;
      try { r = await send(e); } catch { netDown = true; backoff(); return; }
      netDown = false;
      if (settles(r)) { drop(e); settled(e, r); continue; }
      failed = true;
      if (limited(r)) { wait = Math.max(wait, 30e3); break; }
    }
    if (failed) backoff(); else { wait = 0; if (fresh) kick(fresh); }
  }
  const flush = () => (running ||= run().catch(() => {}).finally(() => { running = null; }));
  return {
    add, has, own, list, drop, flush,
    ids: () => list().filter((e) => e.owner === owner()).map((e) => e.puzzleId),
    // report()'s own post of an entry: kept out of flush while it is on its way.
    start(e) { if (e) busy.add(keyOf(e)); },
    stop(e) { if (e) busy.delete(keyOf(e)); },
    failed(net = false) { netDown = net; backoff(); },
    // Some other call was just answered (or the browser came online): the network is back, so no need to wait for the timer.
    answered() { if (netDown || !timer) { if (!running && list().some((e) => e.owner === owner() && !busy.has(keyOf(e)))) flush(); } },
  };
}
