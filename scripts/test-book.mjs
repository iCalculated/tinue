// Book tests (docs/plan/PLAN.md §1.1): the key (shared/book.js) and the stored-win walk.   node scripts/test-book.mjs
import assert from 'node:assert/strict';
import { Game } from '../shared/tak.js';
import { bookKey, bookKeyOfTPS, halfKomi, puzzleStart, puzzleWins, treeDepth } from '../shared/book.js';

// Key: board + side to move, move number dropped, '|' + 2·komi.
{
  const tps = '2,x5/2,x2,1,x2/2,2,x,1C,x2/21,211S,x4/2,2,x,112C,1,x/2,2,x,1,1,1 2 14';
  const g = Game.fromTPS(tps, 2);
  assert.equal(bookKey(g), '2,x5/2,x2,1,x2/2,2,x,1C,x2/21,211S,x4/2,2,x,112C,1,x/2,2,x,1,1,1 2|4');
  assert.equal(bookKey(g, 2.5), bookKey(g).replace(/\|4$/, '|5'));
  assert.equal(bookKeyOfTPS(tps.replace(/ 14$/, ' 30'), 2), bookKey(g), 'move number is not part of the key');
  assert.equal(bookKeyOfTPS(tps.replace(/ 14$/, ''), 2), bookKey(g), 'TPS without a move number');
  assert.notEqual(bookKeyOfTPS(tps.replace(' 2 14', ' 1 14'), 2), bookKey(g), 'side to move is');
  assert.equal(halfKomi(0), '0'); assert.equal(halfKomi(0.5), '1'); assert.equal(halfKomi(null), '0');
  assert.throws(() => halfKomi(0.3)); assert.throws(() => halfKomi(-1));
  // Transpositions share a key; komi from the game by default.
  const a = Game.fromTPS('x6/x6/x6/x6/x6/x6 1 3', 1.5), b = a.clone();
  for (const m of ['a1', 'f6', 'b1', 'e6']) a.play(m);
  for (const m of ['b1', 'e6', 'a1', 'f6']) b.play(m);
  assert.equal(bookKey(a), bookKey(b));
  assert.match(bookKey(a), /^x4,2,2\/x6\/x6\/x6\/x6\/1,1,x4 1\|3$/);
  console.log('ok book key: format, move number dropped, komi, transpositions');
}

// The walk: tree keys with lengths (plies = 1 + root winLen), alts at the root and altsAt (client path form).
{
  const p = { tps: '2,x5/2,x2,1,x2/2,2,x,1C,x2/21,211S,x4/2,2,x,112C,1,x/2,2,x,1,1,1 2 14', komi: 2, plies: 5,
    tree: '{"3d2<111":{"r":"2a3+11","n":{"a4+":{"r":"Sa3","n":"win"}}}}',
    swing: JSON.stringify({ alts: ['3d2+'], altsAt: { '3d2<111 2a3+11': ['f6'] } }) };
  assert.equal(treeDepth(JSON.parse(p.tree)), p.plies);
  assert.equal(treeDepth('win'), 1);
  assert.equal(treeDepth({ a1: null }), 1); // a key without a reply (4 unserved rows): only a game-ending move
  assert.throws(() => puzzleWins({ ...p, tree: '{"3d2<111":null}', swing: null }), /no reply/);
  const w = puzzleWins(p);
  const tree = w.filter((x) => x.kind === 'tree'), alt = w.filter((x) => x.kind === 'alt');
  assert.deepEqual(tree.map((x) => [x.path.join(' '), x.move, x.winLen]), [['', '3d2<111', 4], ['3d2<111 2a3+11', 'a4+', 2]]);
  assert.equal(1 + tree[0].winLen, p.plies);
  assert.deepEqual(alt.map((x) => [x.path.join(' '), x.move, x.winLen]), [['', '3d2+', null], ['3d2<111 2a3+11', 'f6', null]]);
  const g = Game.fromTPS(p.tps, p.komi); g.play('3d2<111');
  assert.equal(tree[0].pos, bookKey(g));
  assert.ok(w.every((x) => x.pos === null || x.pos.endsWith(' 1|4')), 'defender (white) to move after a black attacker move');
  assert.deepEqual(puzzleWins({ ...p, tree: '"win"', swing: null }), [], '1-ply puzzles add no rows');
  // A mid-game board without a move number (or with move 1) would replay under the opening rule: refused.
  const w1 = '2,x5/2,x2,1,x2/2,2,x,1C,x2/21,211S,x4/2,2,x,112C,1,x/2,2,x,1,1,1 1';
  assert.throws(() => puzzleWins({ tps: w1, komi: 2, tree: '{"a5":{"r":"b5","n":"win"}}', swing: null }), /opening rule/);
  assert.throws(() => puzzleWins({ tps: w1 + ' 1', komi: 2, tree: '"win"', swing: null }), /opening rule/);
  assert.throws(() => puzzleStart('x6/x6/x6/x6/x6/1,2,x4 2'), /opening rule/, 'ply 1 with two pieces');
  assert.equal(puzzleStart('x6/x6/x6/x6/x6/1,x5 2').ply, 1, 'a real ply-1 board');
  assert.equal(puzzleStart('x6/x6/x6/x6/x6/x6 1').ply, 0);
  assert.equal(puzzleStart(w1 + ' 14').ply, 26);
  console.log('ok book walk: tree keys, lengths, alts, altsAt');
}

// Tables, lookups and insert rules (server/book.js).
{
  const { DatabaseSync } = await import('node:sqlite');
  const { initBook, bookLookup, bookNodeLookup, publishBook, BOOK_VER } = await import('../server/book.js');
  const db = new DatabaseSync(':memory:');
  initBook(db); initBook(db); // idempotent
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).join(',');
  assert.equal(cols('book'), 'pos,ver,win_len,exact,model,proof,checked,puzzle_id,commit_sha,ts,retired_ver');
  assert.equal(cols('book_node'), 'pos,ver,moves,model,puzzle_id,commit_sha,retired_ver');
  assert.equal(cols('book_ver'), 'ver,ts,commit_sha,added,retired,note');
  assert.equal(BOOK_VER, Math.max(0, Math.floor(+process.env.TINUE_BOOK_VER || 0)));
  const P = (i) => `x6/x6/x6/x6/x6/${i},x5 2|0`; // distinct well-formed keys
  const row = (pos, o = {}) => ({ pos, win_len: 4, exact: 0, model: 'threat', proof: 'tree', checked: 0, puzzle_id: 'p1', ...o });
  const count = () => db.prepare('SELECT (SELECT COUNT(*) FROM book) b, (SELECT COUNT(*) FROM book_ver) v, (SELECT COUNT(*) FROM book WHERE retired_ver IS NOT NULL) r').get();
  const commitSha = 'abc123';

  const r1 = publishBook(db, { rows: [row(P(1)), row(P(2), { win_len: null, proof: 'alt' }), row(P(1))], commitSha, ts: 1 });
  assert.deepEqual([r1.ver, r1.added, r1.kept, r1.retired], [1, 2, 1, 0]);
  assert.equal(bookLookup(db, P(1)), null, 'pointer 0 (default): book off');
  assert.equal(bookLookup(db, P(1), 1).win_len, 4);
  assert.equal(bookLookup(db, P(2), 1).win_len, null);
  assert.equal(bookLookup(db, P(9), 1), null);

  // Same model, lengths that cannot both be right (an exact length above a bound, or two exact lengths): the publish
  // fails and writes nothing (also within one publish).
  const before = count();
  assert.throws(() => publishBook(db, { rows: [row(P(3)), row(P(1), { win_len: 6, exact: 1, checked: 1 })], commitSha }), (e) => e.report.conflicts.length === 1 && e.report.conflicts[0].pos === P(1));
  assert.throws(() => publishBook(db, { rows: [row(P(4), { exact: 1, checked: 1 }), row(P(4), { win_len: 6, exact: 1, checked: 1 })], commitSha }), (e) => e.report.conflicts[0].within);
  assert.throws(() => publishBook(db, { rows: [row(P(4), { win_len: 6, exact: 1, checked: 1 }), row(P(4), { win_len: 4 })], commitSha }), (e) => e.report.conflicts[0].within);
  assert.throws(() => publishBook(db, { rows: [row(P(1), { win_len: 6, exact: 1, checked: 1 }), row(P(5), { exact: 1, checked: 1 })], commitSha: 'x', ver: 1 }), /not above/);
  assert.deepEqual(count(), before);
  // Dry run: the report, nothing written.
  const dry = publishBook(db, { rows: [row(P(1), { win_len: 6, exact: 1, checked: 1 })], commitSha, dryRun: true });
  assert.equal(dry.conflicts.length, 1); assert.deepEqual(count(), before);

  // Stronger model retires the weaker row; the length change is listed; lowering the pointer brings the old row back.
  const r2 = publishBook(db, { rows: [row(P(1), { win_len: 2, model: 'full', proof: 'deep-cert', checked: 1 })], commitSha, ts: 2 });
  assert.deepEqual([r2.ver, r2.added, r2.retired], [2, 1, 1]);
  assert.deepEqual(r2.lengthChanges, [{ pos: P(1), from: 4, to: 2, fromModel: 'threat', toModel: 'full', puzzle: 'p1' }]);
  assert.equal(bookLookup(db, P(1), 2).win_len, 2);
  assert.equal(bookLookup(db, P(1), 1).win_len, 4, 'rollback by pointer');
  // A weaker row is not added over a stronger one (lookups take the newest).
  const r3 = publishBook(db, { rows: [row(P(1), { win_len: 4 })], commitSha });
  assert.deepEqual([r3.ver, r3.added, r3.kept], [null, 0, 1]);
  assert.equal(bookLookup(db, P(1), 99).model, 'full');
  // exact = 1 retires exact = 0 of the same model even at another length; a length replaces NULL; checked replaces unchecked.
  const r4 = publishBook(db, { rows: [row(P(5)), row(P(6))], commitSha });
  const r5 = publishBook(db, { rows: [row(P(5), { win_len: 2, exact: 1, checked: 1 }), row(P(2), { win_len: 6, proof: 'alt' }), row(P(6), { checked: 1 })], commitSha });
  assert.deepEqual([r4.ver, r5.ver, r5.added, r5.retired], [3, 4, 3, 3]);
  assert.equal(bookLookup(db, P(5), 4).exact, 1);
  assert.equal(bookLookup(db, P(2), 4).win_len, 6);
  assert.equal(bookLookup(db, P(6), 4).checked, 1);
  // A stronger model without a length does not displace a length.
  assert.equal(publishBook(db, { rows: [row(P(5), { win_len: null, model: 'full', proof: 'alt' })], commitSha }).kept, 1);
  // ... and exact = 0 at another length does not displace exact = 1, nor is it a conflict.
  assert.equal(publishBook(db, { rows: [row(P(5), { win_len: 4 })], commitSha }).kept, 1);
  // Retiring a position a tree still lists as a key is refused; others retire.
  assert.throws(() => publishBook(db, { retire: [P(6)], protect: new Set([P(6)]), commitSha }), /retirements of tree keys/);
  const r6 = publishBook(db, { retire: [P(6)], commitSha });
  assert.equal(r6.retired, 1); assert.equal(bookLookup(db, P(6), r6.ver), null); assert.equal(bookLookup(db, P(6), r6.ver - 1).checked, 1);
  // Bad rows are rejected before anything is written.
  for (const bad of [{ pos: 'nope' }, { win_len: 0 }, { exact: 1, win_len: null }, { exact: 1, checked: 0 }, { model: 'quiet' }, { proof: 'guess' }, { checked: 2 }])
    assert.throws(() => publishBook(db, { rows: [row(P(7), bad)], commitSha }));
  assert.throws(() => publishBook(db, { rows: [row(P(7))] }), /commitSha/);
  // book_node: one live classification per pos; a weaker model does not displace a stronger one.
  const n1 = publishBook(db, { nodes: [{ pos: P(8), model: 'threat', moves: { a1: 'key', b1: 'refuted' } }], commitSha });
  const n2 = publishBook(db, { nodes: [{ pos: P(8), model: 'full', moves: { a1: 'key', b1: 'undecided' } }], commitSha });
  publishBook(db, { nodes: [{ pos: P(8), model: 'threat', moves: { a1: 'key' } }], commitSha });
  assert.equal(bookNodeLookup(db, P(8), 99).moves.b1, 'undecided');
  assert.equal(bookNodeLookup(db, P(8), n1.ver).moves.b1, 'refuted');
  assert.equal(n2.nodesRetired, 1);
  assert.throws(() => publishBook(db, { nodes: [{ pos: P(8), model: 'full', moves: { a1: 'maybe' } }], commitSha }));
  // An unproved placeholder (failed re-proof: no length, unchecked) never blocks a proof, whatever its model, and a
  // later proof replaces it; an unchecked row of a stronger model does not retire a checked row.
  {
    const { compareRows } = await import('../server/book.js');
    const fail = { win_len: null, exact: 0, model: 'threat+1quiet', checked: 0 };
    assert.equal(compareRows(fail, { win_len: 7, exact: 0, model: 'threat', checked: 1 }), 'replace', 'fail vs checked proof');
    assert.equal(compareRows(fail, { win_len: 7, exact: 1, model: 'threat', checked: 1 }), 'replace', 'fail vs exact proof');
    assert.equal(compareRows(fail, { win_len: 9, exact: 0, model: 'threat', checked: 0 }), 'replace', 'fail vs tree key');
    assert.equal(compareRows({ win_len: 9, exact: 0, model: 'threat', checked: 0 }, fail), 'keep');
    assert.equal(compareRows(fail, { ...fail, model: 'full' }), 'keep', 'two placeholders: the first stays');
    assert.equal(compareRows({ win_len: 7, exact: 1, model: 'threat', checked: 1 }, { win_len: 11, exact: 0, model: 'threat+1quiet', checked: 0 }), 'keep', 'unchecked stronger model vs checked exact');
    const f1 = publishBook(db, { rows: [row(P(10), { win_len: null, model: 'threat+1quiet', proof: 'alt' })], commitSha });
    const f2 = publishBook(db, { rows: [row(P(10), { win_len: 7, proof: 'alt', checked: 1 })], commitSha });
    assert.deepEqual([f2.added, f2.retired], [1, 1]);
    assert.equal(bookLookup(db, P(10), f2.ver).win_len, 7); assert.equal(bookLookup(db, P(10), f1.ver).win_len, null);
  }
  // Two exact = 0 lengths of one model are both upper bounds: no conflict, the shorter is kept (the checked one if
  // equal), in either order, within a publish and against the live book; the change is listed.
  {
    const { compareRows } = await import('../server/book.js');
    const tree = { win_len: 9, exact: 0, model: 'threat', checked: 0 }, deep = { win_len: 7, exact: 0, model: 'threat', checked: 1 };
    assert.equal(compareRows(tree, deep), 'replace'); assert.equal(compareRows(deep, tree), 'keep');
    assert.equal(compareRows({ ...deep, checked: 0 }, deep), 'replace'); assert.equal(compareRows(deep, { ...deep, checked: 0 }), 'keep');
    assert.equal(compareRows({ ...deep, exact: 1 }, tree), 'keep', 'exact 7 under a bound of 9');
    assert.equal(compareRows(deep, { ...tree, exact: 1 }), 'conflict', 'exact 9 above a bound of 7');
    const w = publishBook(db, { rows: [row(P(11), { win_len: 9 }), row(P(11), { win_len: 7, proof: 'alt', checked: 1 })], commitSha });
    assert.equal(bookLookup(db, P(11), w.ver).win_len, 7); assert.equal(w.lengthChanges.length, 1);
    const l = publishBook(db, { rows: [row(P(11), { win_len: 5 })], commitSha });
    assert.deepEqual([l.added, l.retired, bookLookup(db, P(11), l.ver).win_len], [1, 1, 5]);
    assert.equal(publishBook(db, { rows: [row(P(11), { win_len: 9 })], commitSha }).kept, 1);
  }
  // Versions are one per publish and recorded.
  assert.deepEqual(db.prepare('SELECT ver FROM book_ver ORDER BY ver').all().map((r) => r.ver), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  console.log('ok book tables: idempotent schema, lookup by pointer, conflicts fail, stronger/exact retire, retire guard');
}

// Chunked publish on a file database (book-init on the live DB): each chunk is its own short BEGIN IMMEDIATE, so another
// connection (the server) can write between chunks; a kill part way leaves an incomplete version that
// lookups ignore, a new publish refuses, and resume: true completes; conflicts are found before anything is written.
{
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { initBook, bookLookup, publishBook, planPublish } = await import('../server/book.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-book-chunk-'));
  const file = path.join(dir, 'c.db');
  const db = new DatabaseSync(file, { timeout: 5000 }), server = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL'); initBook(db); server.exec('CREATE TABLE attempts (x INTEGER)');
  const P = (i) => `x6/x6/x6/x6/x6/${i},x5 2|0`;
  const row = (pos, o = {}) => ({ pos, win_len: 4, exact: 0, model: 'threat', proof: 'tree', checked: 0, puzzle_id: 'p1', ...o });
  const rows = Array.from({ length: 7 }, (_, i) => row(P(i + 1)));
  let chunks = 0;
  assert.throws(() => publishBook(db, { rows, commitSha: 'c', chunk: 3, onChunk: (done) => {
    chunks++; server.prepare('INSERT INTO attempts VALUES (?)').run(done); // a server write between chunks, no wait
    if (chunks === 2) throw new Error('killed');
  } }), /killed/);
  assert.equal(server.prepare('SELECT COUNT(*) n FROM attempts').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book WHERE ver = 1').get().n, 6, 'two chunks written');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_ver').get().n, 0);
  assert.equal(bookLookup(db, P(1), 1), null, 'an incomplete version is invisible');
  // ... its retirements too, at a pointer at or above it: v2 (chunk 1) retires P(1)'s row in its first chunk, then dies.
  {
    const m = new DatabaseSync(':memory:'); initBook(m);
    publishBook(m, { rows: [row(P(1), { win_len: 9 }), row(P(2), { win_len: 9 })], commitSha: 'c' });
    assert.throws(() => publishBook(m, { rows: [row(P(1), { win_len: 7 }), row(P(2), { win_len: 7 })], commitSha: 'c', chunk: 1, onChunk: () => { throw new Error('killed'); } }), /killed/);
    assert.equal(m.prepare('SELECT retired_ver FROM book WHERE pos = ? AND ver = 1').get(P(1)).retired_ver, 2);
    for (const v of [1, 2, 3]) for (const i of [1, 2]) assert.equal(bookLookup(m, P(i), v).win_len, 9, `v1 row at pointer ${v}`);
    m.close();
  }
  assert.throws(() => publishBook(db, { rows, commitSha: 'c' }), /incomplete/);
  assert.throws(() => publishBook(db, { rows, commitSha: 'c', ver: 5 }), /incomplete/);
  const r = publishBook(db, { rows, commitSha: 'c', chunk: 3, resume: true });
  assert.deepEqual([r.ver, r.added, r.alreadyWritten, r.resumed], [1, 7, 6, true]);
  assert.deepEqual(db.prepare('SELECT ver, added FROM book_ver').all().map((x) => ({ ...x })), [{ ver: 1, added: 7 }]);
  assert.equal(bookLookup(db, P(7), 1).win_len, 4);
  assert.equal(publishBook(db, { rows, commitSha: 'c', resume: true }).ver, null, 'complete: a re-run adds nothing');
  // A resume finishes exactly the new plan: rows the killed run wrote that the plan dropped or changed are taken back
  // (deleted, their retirements undone), even when the input changed between the kill and the rerun.
  {
    const m = new DatabaseSync(':memory:'); initBook(m);
    publishBook(m, { rows: [row(P(1), { win_len: 9 }), row(P(2), { win_len: 9 })], commitSha: 'c' });
    const kill = () => { throw new Error('killed'); };
    const v2 = [row(P(1), { win_len: 7 }), row(P(2), { win_len: 7 }), row(P(3), { win_len: null, proof: 'alt' }), row(P(4))];
    assert.throws(() => publishBook(m, { rows: v2, commitSha: 'c', chunk: 3, onChunk: kill }), /killed/);
    assert.equal(m.prepare('SELECT COUNT(*) n FROM book WHERE ver = 2').get().n, 3);
    // Rerun: P(1) dropped (pulled puzzle / excluded), P(2) now 5 (tree edited), P(3)'s placeholder now proved.
    const plan = planPublish(m, { rows: [row(P(2), { win_len: 5 }), row(P(3), { win_len: 7, proof: 'alt', checked: 1 }), row(P(4))], resume: true });
    assert.deepEqual([plan.reclaim.sort(), plan.written], [[P(1), P(2), P(3)].sort(), []]);
    const r = publishBook(m, { rows: [row(P(2), { win_len: 5 }), row(P(3), { win_len: 7, proof: 'alt', checked: 1 }), row(P(4))], commitSha: 'c', chunk: 1, resume: true });
    assert.deepEqual([r.ver, r.added, r.retired, r.reclaimed], [2, 3, 1, 3]);
    assert.equal(bookLookup(m, P(1), 2).win_len, 9, 'the dropped row is gone and the row it retired is live again');
    assert.equal(m.prepare('SELECT retired_ver FROM book WHERE pos = ? AND ver = 1').get(P(1)).retired_ver, null);
    assert.deepEqual([bookLookup(m, P(2), 2).win_len, bookLookup(m, P(2), 1).win_len], [5, 9]);
    assert.equal(bookLookup(m, P(3), 2).checked, 1, 'the proof, not the placeholder');
    assert.equal(m.prepare('SELECT COUNT(*) n FROM book WHERE ver = 2').get().n, 3);
    m.close();
  }
  {
    const m = new DatabaseSync(':memory:'); initBook(m);
    const rs = [row(P(1)), row(P(2)), row(P(3))];
    assert.throws(() => publishBook(m, { rows: rs, commitSha: 'c', chunk: 2, onChunk: () => { throw new Error('killed'); } }), /killed/);
    const plan = planPublish(m, { rows: rs, resume: true });
    assert.deepEqual([plan.reclaim, plan.written.length, plan.adds.length], [[], 2, 1], 'same plan: nothing taken back');
    // Every row of the killed run dropped: the version is taken back whole and no version is written.
    const r = publishBook(m, { rows: [], commitSha: 'c', resume: true });
    assert.equal(r.ver, null);
    assert.deepEqual({ ...m.prepare('SELECT (SELECT COUNT(*) FROM book) b, (SELECT COUNT(*) FROM book_ver) v').get() }, { b: 0, v: 0 });
    m.close();
  }
  // Two runs at once: B completes A's incomplete version between A's chunks; A's next chunk writes nothing and fails.
  {
    const m = new DatabaseSync(':memory:'); initBook(m);
    let b = null;
    assert.throws(() => publishBook(m, { rows: [row(P(1)), row(P(3)), row(P(4))], commitSha: 'a', chunk: 1, onChunk: () => {
      b ??= publishBook(m, { rows: [row(P(2))], commitSha: 'b', resume: true });
    } }), /completed by another run/);
    assert.equal(b.ver, 1);
    assert.deepEqual([P(1), P(2), P(3), P(4)].map((p) => bookLookup(m, p, 1)?.commit_sha ?? null), [null, 'b', null, null], 'only B\'s plan is live');
    m.close();
  }
  // A conflict anywhere in the plan writes nothing, even with chunks.
  const plan = planPublish(db, { rows: [row(P(20)), row(P(21)), row(P(3), { win_len: 6, exact: 1, checked: 1 })] });
  assert.equal(plan.report.conflicts.length, 1);
  assert.throws(() => publishBook(db, { rows: [row(P(20)), row(P(21)), row(P(3), { win_len: 6, exact: 1, checked: 1 })], commitSha: 'c', chunk: 1 }), /refused/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book WHERE ver > 1').get().n, 0);
  db.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok book chunked publish: short transactions, server writes between chunks, kill + resume, conflicts first');
}
