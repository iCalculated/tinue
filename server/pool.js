// The picker's puzzles in memory: what server.js's pickFrom ranks on, for every puzzle, in rowid order. A pick scans
// these arrays (~71k rows, about half a millisecond) instead of a full table scan with a sort (~20 ms locally, and
// synchronous: every other request waits). The full row is read by id only for the puzzles picked.
//
// Same answers as the SQL ranking it replaced (scripts/test-picker-equiv.mjs checks it on a copy of the real data):
//   - score = ((|rating - target| + a) + b) - c, added in that order (as SQL did, so the doubles match to the bit);
//     a, b, c come from server.js (parts), a function of the row's light columns;
//   - ORDER BY score LIMIT n over a rowid-order scan returns equal scores in rowid order; so does top() here;
//   - the theme filter is SQLite's LIKE '%,theme,%' on ',themes,': for a theme of letters and digits (every real
//     one) that is an ASCII-case-insensitive substring test, done here; anything else (wildcards % or _, other
//     characters) is asked of SQLite itself. Either way once per theme string, then cached.
//
// Staying in step with the table: this connection's own puzzle writes (a result) call refresh(id). Any other
// connection's commit (an import, rerate, a hand fix, a test writing the file) changes PRAGMA data_version, and the
// next pick reloads everything first (~150 ms on 71k rows, once). So picks need no restart after an import,
// nor do themeCounts and stats (server.js), which go by it too.
export function createPool(db, { parts, served, pickable = () => true }) {
  const version = db.prepare('PRAGMA data_version');
  const light = 'id, size, rating, rd, attempts, turn, grade, flaw, themes, kind, status';
  const one = db.prepare(`SELECT ${light} FROM puzzles WHERE id = ?`);
  const likeIds = db.prepare("SELECT id FROM puzzles WHERE (',' || themes || ',') LIKE ?");
  const playedBy = db.prepare('SELECT puzzle_id FROM attempts WHERE user_id = ?');
  let ver, n, ids, at, rating, rd, attempts, turn, grade, flaw, kind, status, size, themesLC, isServed, isPickable, a, b, c, blocked, masks;

  const lowerASCII = (s) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  const set = (i, r) => {
    rating[i] = r.rating; rd[i] = r.rd; attempts[i] = r.attempts; turn[i] = r.turn; grade[i] = r.grade; flaw[i] = r.flaw; kind[i] = r.kind; status[i] = r.status;
    size[i] = r.size; themesLC[i] = r.themes == null ? null : lowerASCII(`,${r.themes},`);
    isServed[i] = served(r) ? 1 : 0; isPickable[i] = pickable(r) ? 1 : 0;
    [a[i], b[i], c[i]] = parts(r);
  };
  function load() {
    ver = version.get().data_version;
    const all = db.prepare(`SELECT ${light} FROM puzzles ORDER BY rowid`).all();
    n = all.length; ids = new Array(n); at = new Map();
    rating = new Float64Array(n); rd = new Float64Array(n); attempts = new Float64Array(n); size = new Float64Array(n);
    turn = new Array(n); grade = new Array(n); flaw = new Array(n); kind = new Array(n); status = new Array(n); themesLC = new Array(n);
    isServed = new Uint8Array(n); isPickable = new Uint8Array(n); a = new Float64Array(n); b = new Float64Array(n); c = new Float64Array(n); blocked = new Uint8Array(n);
    masks = new Map();
    for (let i = 0; i < n; i++) { ids[i] = all[i].id; at.set(all[i].id, i); set(i, all[i]); }
  }
  // Another connection committed since the last look: reload. (This connection's own commits don't change it.)
  const fresh = () => { if (version.get().data_version !== ver) load(); };
  load();

  // Rows whose ',themes,' is LIKE '%,theme,%'. Cached per theme string (up to 64; a reload drops them).
  function themeMask(theme) {
    let m = masks.get(theme);
    if (m) return m;
    m = new Uint8Array(n);
    if (/^[A-Za-z0-9]+$/.test(theme)) {
      const needle = lowerASCII(`,${theme},`);
      for (let i = 0; i < n; i++) if (themesLC[i] !== null && themesLC[i].includes(needle)) m[i] = 1;
    } else {
      for (const r of likeIds.all(`%,${theme},%`)) { const i = at.get(r.id); if (i !== undefined) m[i] = 1; }
    }
    if (masks.size >= 64) masks.delete(masks.keys().next().value);
    masks.set(theme, m);
    return m;
  }

  // The `limit` best rows by score (ties in rowid order), each { id, rating, rd, attempts, turn, grade, flaw, kind, status, score }:
  // what  SELECT *, <score> FROM puzzles WHERE <filters> ORDER BY score LIMIT <limit>  returned, minus the other
  // columns. servedOnly: the served pool only; player: the user id whose attempts are left out (none: nobody's); exclude: puzzle ids.
  // A row that isn't pickable (status paused/rejected: server/puzzle-state.js) is never returned, by any stage.
  function top({ target, servedOnly, theme, size: sz, player, exclude = [] }, limit) {
    fresh();
    const mask = theme ? themeMask(theme) : null;
    const marks = [];
    const block = (id) => { const i = at.get(id); if (i !== undefined && !blocked[i]) { blocked[i] = 1; marks.push(i); } };
    if (player !== undefined) for (const r of playedBy.all(player)) block(r.puzzle_id);
    for (const id of exclude) block(id);
    // The best `limit` so far, sorted by (score, index): a row enters only if it beats the worst kept (an equal score
    // loses to the earlier row already there, as in a stable sort).
    const bs = new Float64Array(limit), bi = new Int32Array(limit);
    let k = 0;
    try {
      for (let i = 0; i < n; i++) {
        if (!isPickable[i] || blocked[i] || (servedOnly && !isServed[i]) || (sz !== undefined && size[i] !== sz) || (mask && !mask[i])) continue;
        const s = Math.abs(rating[i] - target) + a[i] + b[i] - c[i];
        if (k === limit && !(s < bs[k - 1])) continue;
        let j = k < limit ? k++ : k - 1;
        while (j > 0 && bs[j - 1] > s) { bs[j] = bs[j - 1]; bi[j] = bi[j - 1]; j--; }
        bs[j] = s; bi[j] = i;
      }
    } finally {
      for (const i of marks) blocked[i] = 0;
    }
    const out = [];
    for (let j = 0; j < k; j++) {
      const i = bi[j];
      out.push({ id: ids[i], rating: rating[i], rd: rd[i], attempts: attempts[i], turn: turn[i], grade: grade[i], flaw: flaw[i], kind: kind[i], status: status[i], score: bs[j] });
    }
    return out;
  }

  // This connection changed a puzzle's row (a rated result: rating, rd, attempts, solves): read its light columns
  // back. (Its themes can't have changed: only other connections write them, and those reload. The theme masks stay.)
  function refresh(id) {
    fresh();
    const i = at.get(id), r = one.get(id);
    if (i === undefined || !r) { load(); return; } // not one we know, or gone: start over
    set(i, r);
  }
  return { top, refresh };
}
