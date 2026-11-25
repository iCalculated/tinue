// Typed moves off the board (shared/tak.js parseMove): the PTN regexes accept files a-h and ranks 1-8 on every size,
// and sqIndex used to wrap an off-board square onto a real one (g1 on 6x6 played a2), so a typo was played, judged and
// rated as a different legal move. Now every square off the board, and every spread that runs off it, is unparseable,
// and every caller treats it as an invalid move: the typed-move box (NinjaBoard.play, _canon), Rush's judge, the
// server's ply judge (moveInputs), the shadow re-judge. Sizes 3 to 8.
//   node scripts/test-parse.mjs
import assert from 'node:assert/strict';
import { Game } from '../shared/tak.js';
import { buildPTN } from '../public/board-kit.js';
import { NinjaBoard } from '../public/ninja.js';
import { judge } from '../public/rush-rules.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const FILES = 'abcdefgh';
const sq = (c, r) => FILES[c] + (r + 1);
// a mid-game position on any size: white and black flats spread over the board, so most spreads are legal
function midGame(size) {
  const g = new Game(size);
  for (const m of [sq(0, 0), sq(size - 1, size - 1)]) g.play(m);
  for (let i = 0; i < size * size && g.ply < size * 2; i++) {
    const mv = g.legalMoves().find((m) => m.kind === 'p' && m.type === 0 && (m.sq * 7) % 3 === g.ply % 3);
    if (!mv) break;
    g.apply(mv);
  }
  return g;
}

await test('every placement on a square off the board throws, every one on it parses to that square (3-8)', () => {
  for (let size = 3; size <= 8; size++) {
    const g = new Game(size);
    for (let c = 0; c < 8; c++) for (let r = 0; r < 8; r++) for (const pre of ['', 'S', 'C']) {
      const ptn = pre + sq(c, r);
      if (c < size && r < size) assert.equal(g.parseMove(ptn).sq, r * size + c, ptn + ' on ' + size);
      else assert.throws(() => g.parseMove(ptn), /off the board/, ptn + ' on ' + size);
    }
  }
});

await test('the reported typos: g1 and h3 on 6x6, f1 g1 h3 on 5x5 no longer become a2, b4, a2, b2, c4', () => {
  for (const [size, ptn] of [[6, 'g1'], [6, 'h3'], [5, 'f1'], [5, 'g1'], [5, 'h3'], [3, 'd1'], [7, 'a8'], [7, 'h7']]) {
    const g = midGame(size);
    assert.throws(() => g.parseMove(ptn), undefined, ptn);
    assert.throws(() => g.canon(ptn), undefined, ptn);
    assert.throws(() => g.play(ptn), undefined, ptn);
  }
});

await test('a spread from off the board, or one whose drops run past the edge, throws (3-8)', () => {
  for (let size = 3; size <= 8; size++) {
    const g = new Game(size);
    const D = { '+': [1, 0], '-': [-1, 0], '>': [0, 1], '<': [0, -1] };
    for (let c = 0; c < 8; c++) for (let r = 0; r < 8; r++) for (const dir of '+-<>') for (let k = 1; k <= 3; k++) {
      const ptn = k + sq(c, r) + dir + '1'.repeat(k);
      const [dr, dc] = D[dir], er = r + dr * k, ec = c + dc * k;
      const on = c < size && r < size && er >= 0 && er < size && ec >= 0 && ec < size;
      if (on) assert.equal(g.parseMove(ptn).sq, r * size + c, ptn + ' on ' + size);
      else assert.throws(() => g.parseMove(ptn), undefined, ptn + ' on ' + size);
    }
  }
});

await test('every legal move of random games still round-trips through PTN (3-8)', () => {
  let R = 20261120;
  const rnd = (k) => { R = (Math.imul(R, 1103515245) + 12345) >>> 0; return R % k; };
  for (let size = 3; size <= 8; size++) for (let game = 0; game < 12; game++) {
    const g = new Game(size);
    for (let ply = 0; ply < 60 && !g.result(); ply++) {
      const ms = g.legalMoves();
      for (const m of ms) { const p = g.moveToPTN(m); assert.equal(g.canon(p), p); assert.ok(g.isLegal(g.parseMove(p)), p); }
      g.apply(ms[rnd(ms.length)]);
    }
  }
});

await test('the typed-move box (PTN Ninja\'s board) refuses g1 on 6x6: play() is false, nothing is sent; _canon is null', async () => {
  assert.ok(buildPTN({ size: 6 }).includes('[Size "6"]'));
  const sent = [], b = Object.assign(Object.create(NinjaBoard.prototype), { games: [midGame(6)], cur: 0, player: null,
    opts: { disableBoard: false }, iframe: { dataset: { up: '1' } }, _send: (a, v) => { sent.push(v); return Promise.resolve(); } });
  assert.equal(b.play('g1'), false);
  assert.equal(b.play('h3'), false);
  assert.equal(b.play('1c3>11'), false);
  assert.deepEqual(sent, []);
  const ok = b.g.moveToPTN(b.g.legalMoves()[0]);
  assert.equal(b.play(ok), true, 'a real move still goes through'); assert.deepEqual(sent, [ok]);
  b.iframe.dataset.down = 'stopped'; assert.equal(b.play(ok), false, 'and none while the board is down');
  assert.equal(NinjaBoard.prototype._canon(midGame(6), 'g1'), null);
  assert.equal(NinjaBoard.prototype._canon(midGame(5), 'f1'), null);
});

await test("Rush's judge calls it illegal, not a wrong or right move", () => {
  const p = { tps: midGame(6).toTPS(), tree: {} };
  assert.deepEqual(judge(p, [], 'g1'), { kind: 'illegal' });
  assert.deepEqual(judge(p, [], 'h3'), { kind: 'illegal' });
});

console.log(`${n} tests passed`);
