// The Rush end screen's pictures (public/rush-look.js) against what Rush had on its board: for real puzzles (tall
// stacks, walls, capstones, spreads, a game on record) under each of the 8 symmetries and several board orientations,
// every kind of result (solved, a wrong placement, a wrong spread after earlier moves, skipped, time ran out, a play-out)
// is stored as a run keeps it (R.recordOf, through JSON, with and without its sym as older runs have none), drawn, and
// compared with what tinue's own Board had on it, loaded as rush.js loaded it: the same stones in every stack, the same
// square under each spot of the picture with the same labels, the same tint, and the marked moves on exactly the squares
// the Board's own highlight gave those moves when it played them. That Board is retired (PTN Ninja is the only board,
// 2026-11-22), so what it had is kept in scripts/rush-look-board.json, recorded from it at 33228e6 (hashes of the squares
// and stones per picture, and the marked moves' squares). Run: node scripts/test-rush-look.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as R from '../public/rush-rules.js';
import { picture, pictureHTML } from '../public/rush-look.js';
import { dispPoint } from '../public/analysis.js';
import * as SYM from '../shared/sym.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rush-sym-sample.json'), 'utf8'));
const BOARD = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rush-look-board.json'), 'utf8')).pictures;
const h = (x) => crypto.createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const FILES = 'abcdefgh';
let ok = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); ok++; console.log('ok', name); } catch (e) { failed++; console.log('FAIL', name, '\n ', e.message.split('\n').slice(0, 6).join('\n  ')); }
}

// the board's orientations (board.js OPS, composed): none, a quarter turn, a half turn, a mirror, a mirror and a turn
const ORIENTS = [[1, 0, 0, 1], [0, 1, -1, 0], [-1, 0, 0, -1], [-1, 0, 0, 1], [0, -1, -1, 0]];
const legal = (g) => g.legalMoves().map((m) => g.moveToPTN(m));
const tree = (p) => (p.tree === 'win' ? {} : p.tree);
// the puzzles: a tall stack with slivers (pd866897), spreads as answers, walls and capstones, games on record
const PUZ = ['pd866897', 'pd659315', 'pd413248', 'pd877899'].map((id) => SAMPLE.find((p) => p.id === id));

// One run's results for puzzle p (already turned, as Rush holds it), each kind once.
function resultsOf(p) {
  const g = R.startGame(p), first = Object.keys(tree(p))[0], moves = legal(g).filter((m) => !(m in tree(p)));
  const place = moves.find((m) => /^[SC]?[a-h]\d$/.test(m)), spread0 = moves.find((m) => /[<>+-]/.test(m));
  // deeper: the first move and its reply on the board, then a spread off the line there (or a placement)
  const e = tree(p)[first], at = e?.r ? [first, e.r] : [];
  const h = R.startGame(p, at), off = legal(h).filter((m) => !(m in (e?.n && e.n !== 'win' ? e.n : {})));
  const deep = off.find((m) => /[<>+-]\d*$/.test(m) && m[0] > '1') || off.find((m) => /[<>+-]/.test(m)) || off[0];
  const look = { end: 'held', engine: 'Syntaks', proven: false, n: 3, cap: 8, byYou: false };
  const sym = p.sym;
  return [
    { id: p.id, rating: 1500, solved: true, ms: 2000, sym },
    { id: p.id, rating: 1500, solved: false, wrong: place, at: [], ms: 3000, sym },
    { id: p.id, rating: 1500, solved: false, wrong: deep, at, ms: 4000, sym },
    { id: p.id, rating: 1500, solved: false, wrong: spread0, at: [], ms: 4000, sym },
    { id: p.id, rating: 1500, solved: false, skipped: true, ms: 1000, sym },
    { id: p.id, rating: 1500, solved: false, unfinished: true, at, ms: 1000, sym },
    { id: p.id, rating: 1500, solved: false, played: place, po: look, at: [], ms: 9000, sym },
    { id: p.id, rating: 1500, solved: true, played: spread0, po: { ...look, end: 'win' }, at: [], ms: 9000, sym },
  ].filter((r) => r.wrong !== undefined ? !!r.wrong : r.played !== undefined ? !!r.played : true);
}
// A run of those results, stored as rush.js stores it: recordOf, then JSON (localStorage).
function stored(p, results) {
  const run = R.newRun('rush');
  R.startClock(run, 0);
  for (const r of results) R.finish(run, { ...r });
  R.end(run, 1e5);
  return JSON.parse(JSON.stringify(R.recordOf(run, [p], 1700000000000))).puzzles;
}

// The line a stored puzzle's picture shows (review: a solve or a skip shows the start; else the position it was in).
const lineOf = (q) => (q.played != null ? q.at || [] : q.solved || q.skipped ? [] : q.at || []);
const sqsOf = (sh) => (sh.kind === 'place' ? [sh.sq] : [sh.from, ...sh.drops.map((d) => d.sq)]);

async function check(p, q, M, tag) {
  const v = R.review(q, q), pic = picture(v, M), n = p.size, was = BOARD[tag];
  assert.ok(was, `${tag}: recorded from tinue's Board`);
  // the squares: each spot of the picture is the square the Board drew there, with its colour, labels and tint
  assert.equal(h(pic.squares.map((x) => [x.sq, x.name, x.lr, x.lc, x.tint])), was.sq, `${tag}: the squares, labels and tint`);
  pic.squares.forEach((x) => { const r = (x.sq / n) | 0, c = x.sq % n; assert.equal(x.name, FILES[c] + (r + 1)); });
  // the stones: every stack as the Board held it, placed where it placed them, in the same order up the stack
  assert.equal(h(pic.pieces.map(({ sq, color, type, x, y, z, imm }) => [sq, color, type, x, y, z, imm])), was.pc, `${tag}: the stones`);
  // and, without that maths: each stone inside its square's row on the picture, each one drawn over the one under it
  for (let sq = 0; sq < n * n; sq++) {
    const on = pic.pieces.filter((x) => x.sq === sq), dr = dispPoint(sq, n, M)[1];
    on.forEach((x, i) => {
      assert.ok(-x.y >= dr * 100 - 100 && -x.y < dr * 100 + 100, `${tag}: ${x.name} in its row`);
      if (i) assert.ok(x.z > on[i - 1].z, `${tag}: ${x.name}'s stones in order`);
    });
  }
  // the marks: the move played when wrong in red, the puzzle's (or the winning play-out's) in green, on the squares
  // the Board highlighted when it played them there; a placement's stone as the Board set it
  const bad = q.played != null ? (q.solved ? null : q.played) : q.solved || q.skipped ? null : q.wrong;
  const good = q.played != null && q.solved ? q.played : q.answer;
  assert.deepEqual(pic.marks.map((m) => m.role), [bad && 'bad', good && 'good'].filter(Boolean), `${tag}: which marks`);
  assert.equal(pic.marks.length, was.mk.length, `${tag}: as many marks as the Board played`);
  pic.marks.forEach((m, i) => {
    const mv = m.role === 'bad' ? bad : good, [sqs, type] = was.mk[i];
    assert.deepEqual(sqsOf(m.shape), sqs, `${tag}: ${m.role} ${mv}`);
    if (m.shape.kind === 'place') assert.equal({ F: 0, S: 1, C: 2 }[m.shape.type], type, `${tag}: ${mv}'s stone`);
    assert.equal(m.color, R.startGame(p, lineOf(q)).toMove);
  });
  // the HTML draws them all: a square per square, a stone per stone, one group per mark
  const html = pictureHTML(pic);
  assert.equal(html.match(/class="tb-sq[ "]/g).length, n * n);
  assert.equal((html.match(/class="tb-pc"/g) || []).length, pic.pieces.length);
  assert.equal((html.match(/<g class="sh /g) || []).length, pic.marks.length);
  assert.equal((html.match(/class="tb-st p\d S/g) || []).length, pic.pieces.filter((x) => x.type === 1).length);
  return pic;
}

await test('each of the 8 symmetries, every result kind, five board orientations: the picture is what Rush had on its board', async () => {
  let n = 0;
  for (const raw of PUZ) for (const sym of SYM.SYMS) {
    const p = SYM.orient(raw, sym), results = resultsOf(p), recs = stored(p, results);
    assert.ok(results.length >= 7, raw.id + ' has every kind');
    recs.forEach((q, i) => {
      assert.equal(q.sym, sym, 'the record keeps the symmetry'); assert.equal(q.tps, p.tps, 'and the turned start');
      assert.equal(R.puzzleLink(q), '#/puzzle/' + p.id + '/' + sym);
      if (results[i].wrong) assert.equal(q.wrong, results[i].wrong);
    });
    for (const M of ORIENTS) for (const [i, q] of recs.entries()) {
      const tag = `${raw.id} s${sym} M${M} #${i}`, pic = await check(p, q, M, tag);
      // a run stored before records kept sym: the same picture
      const { sym: _, ...old } = q;
      assert.deepEqual(picture(R.review(old, old), M), pic, tag + ' (no sym)');
      n++;
    }
  }
  assert.ok(n > 1000, 'pictures checked: ' + n);
});

await test('a tall stack: the top six up the square, the rest as slivers; a wall on a stack a step lower', () => {
  const p = PUZ[0], v = R.review(p, { solved: true }), pic = picture(v);
  const d3 = pic.pieces.filter((x) => x.name === 'd3'); // 1111112C: seven stones
  assert.equal(d3.length, 7); assert.deepEqual(d3.map((x) => x.imm), [true, false, false, false, false, false, false]);
  assert.equal(d3.at(-1).type, 2);
  const b6 = pic.pieces.filter((x) => x.name === 'b6'); // 21S: the wall one step lower
  assert.equal(b6.at(-1).type, 1); assert.equal(b6.at(-1).y, -(5 * 100 + 0)); // (7 up for z = 1, 7 down for the wall)
  // 18 stones: the lowest hidden (the Board's .ov), as the board does past n + 10
  const tall = { ...p, tps: '1,x5/x6/x6/x6/x6/' + '12'.repeat(9) + ',x5 1 30', last: undefined, before: undefined };
  const t = picture(R.review(tall, { skipped: true })).pieces.filter((x) => x.name === 'a1');
  assert.equal(t.length, 18 - 2);
});

await test('two moves on one square or along one line both show', () => {
  const v = { size: 6, cells: R.review(PUZ[3], { solved: true }).cells, tint: null, marks: [] };
  const place = (sq, type) => ({ kind: 'place', sq, type });
  let pic = picture({ ...v, marks: [{ shape: place(0, 'S'), role: 'bad', color: 1 }, { shape: place(0, 'F'), role: 'good', color: 1 }] });
  assert.match(pic.svg, /r="0.42"[\s\S]*r="0.3"/, 'the red ring outside the green');
  const sp = (k) => ({ kind: 'spread', from: 7, to: 9, carry: k, drops: [{ sq: 8, k: 1 }, { sq: 9, k: k - 1 }], smash: false });
  pic = picture({ ...v, marks: [{ shape: sp(2), role: 'bad', color: 1 }, { shape: sp(3), role: 'good', color: 1 }] });
  assert.deepEqual(pic.marks.map((m) => m.shift), [-0.14, 0.14]);
  // one stack, two ways (2d4+11 against a spread left): each count of stones carried out along its own arrow, apart
  const sp2 = (to, k) => ({ kind: 'spread', from: 7, to, carry: k, drops: [{ sq: to, k }], smash: false });
  pic = picture({ ...v, marks: [{ shape: sp2(13, 2), role: 'bad', color: 1 }, { shape: sp2(6, 5), role: 'good', color: 1 }] });
  const at = [...pic.svg.matchAll(/<circle class="dc" cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => [+m[1], +m[2]]);
  assert.equal(at.length, 2, 'both counts drawn');
  assert.ok(Math.hypot(at[0][0] - at[1][0], at[0][1] - at[1][1]) > 2 * 0.17, 'the counts do not overlap: ' + JSON.stringify(at));
  assert.ok(pic.marks.every((m) => !m.shift), 'the arrows stay on their lines');
});

console.log(`test-rush-look: ${ok} ok, ${failed} failed`);
if (failed) process.exit(1);
