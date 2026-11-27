// The Settings page's example positions: legal, ending as named, and between them every kind of thing a look changes.
import assert from 'node:assert/strict';
import { Game, colorOf, typeOf, FLAT, WALL, CAP } from '../shared/tak.js';
import { parsePTN } from '../shared/ptn.js';
import { EXAMPLES, KOMI, examplePTN } from '../public/example-board.js';

const at = {};
for (const [k, x] of Object.entries(EXAMPLES)) {
  const { headers, moves } = parsePTN(examplePTN(k));
  assert.deepEqual(moves, [x.move]); assert.equal(+headers.Komi, KOMI); assert.equal(headers.TPS, x.tps);
  const g = Game.fromTPS(headers.TPS, KOMI);
  assert.equal(g.result(), null, `${k}: not over before its move`);
  assert.ok(g.isLegal(g.parseMove(x.move)), `${k}: legal`);
  g.play(x.move); at[k] = g;
}
assert.equal(at.play.result(), null); assert.deepEqual(at.road.result(), { winner: 1, kind: 'road' }); assert.deepEqual(at.flats.result(), { winner: 1, kind: 'flat' });
assert.equal(EXAMPLES.road.roads, true);
const tops = at.play.board.filter((s) => s.length).map((s) => s[s.length - 1]);
for (const c of [1, 2]) for (const t of [FLAT, WALL, CAP]) assert.ok(tops.some((p) => colorOf(p) === c && typeOf(p) === t), `colour ${c}, kind ${t}`);
assert.ok(at.play.board.some((s) => s.length > 6), 'a stack past the carry limit');
assert.match(EXAMPLES.play.move, /^\d.\d[<>+-]\d\d/, 'the last move is a spread over squares');
const [f, r] = EXAMPLES.play.hint[0]; assert.equal(at.play.board[(+r - 1) * 6 + 'abcdef'.indexOf(f)].length, 0, 'the hint is an empty square');
for (const c of [1, 2]) assert.ok(at.play.stones[c] > 0, 'pieces left in the tray');
console.log('test-example-board: ok');
