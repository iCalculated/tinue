// The Settings page's example position: legal, in play, and with every kind of thing a look changes.
import assert from 'node:assert/strict';
import { Game, colorOf, typeOf, FLAT, WALL, CAP } from '../shared/tak.js';
import { parsePTN } from '../shared/ptn.js';
import { EXAMPLE, KOMI, examplePTN } from '../public/example-board.js';

const { headers, moves } = parsePTN(examplePTN());
assert.deepEqual(moves, [EXAMPLE.move]); assert.equal(+headers.Komi, KOMI); assert.equal(headers.TPS, EXAMPLE.tps);
const g = Game.fromTPS(headers.TPS, KOMI);
assert.ok(g.isLegal(g.parseMove(EXAMPLE.move)));
g.play(EXAMPLE.move);
assert.equal(g.result(), null);
const tops = g.board.filter((s) => s.length).map((s) => s[s.length - 1]);
for (const c of [1, 2]) for (const t of [FLAT, WALL, CAP]) assert.ok(tops.some((p) => colorOf(p) === c && typeOf(p) === t), `colour ${c}, kind ${t}`);
assert.ok(g.board.some((s) => s.length > 6), 'a stack past the carry limit');
assert.match(EXAMPLE.move, /^\d.\d[<>+-]\d\d/, 'the last move is a spread over squares');
const [f, r] = EXAMPLE.hint[0]; assert.equal(g.board[(+r - 1) * 6 + 'abcdef'.indexOf(f)].length, 0, 'the hint is an empty square');
for (const c of [1, 2]) assert.ok(g.stones[c] > 0, 'pieces left in the tray');
console.log('test-example-board: ok');
