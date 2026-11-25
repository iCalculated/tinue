// Rapid line switches after a puzzle (public/lines.js showLineOn, app.js showLine): on PTN Ninja, whose load swaps its
// line at once and resolves 60 ms later, a click on the official line then one on your branch used to leave the board
// on the official line while the panel and the analysis followed the branch.   node scripts/test-lines.mjs
import assert from 'node:assert/strict';
import { showLineOn, moveSquares } from '../public/lines.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// NinjaBoard's shape: load() replaces the line synchronously, then waits; goTo/last/first move within the current line
function ninjaLike(ms = 60) {
  return {
    line: [], cur: 0,
    async load(ptn) { this.line = ptn.split(' '); this.cur = this.line.length; await sleep(ms); },
    async last() { this.cur = this.line.length; },
    async first() { this.cur = 0; },
    async goTo(i) { this.cur = i + 1; },
    get shown() { return this.line.slice(0, this.cur).join(' '); },
  };
}
const ptnOf = (line) => line.join(' ');
const official = ['a1', 'f6', 'c3', 'd4', 'c4'], branch = ['a1', 'f6', 'c3', 'e5', 'b2'];

await test('official then branch within the load: the board ends on the branch, at the branch ply asked for', async () => {
  const b = ninjaLike(), st = { loadedKey: branch.join(' ') }; // exploring the branch, loaded
  const one = showLineOn(b, st, official, 4, ptnOf);
  await sleep(10);
  const two = showLineOn(b, st, branch, 5, ptnOf);
  await Promise.all([one, two]);
  assert.equal(b.shown, branch.join(' '));
  assert.equal(st.loadedKey, branch.join(' '));
  // and stepping within it from there needs no load and stays on it
  await showLineOn(b, st, branch, 4, ptnOf);
  assert.equal(b.shown, branch.slice(0, 4).join(' '));
});

await test('three quick switches: the last one wins, whatever order the loads resolve in', async () => {
  const b = ninjaLike(), st = { loadedKey: null };
  const a = showLineOn(b, st, official, 5, ptnOf), c = showLineOn(b, st, branch, 3, ptnOf), d = showLineOn(b, st, official, 2, ptnOf);
  await Promise.all([a, c, d]);
  assert.equal(b.shown, official.slice(0, 2).join(' '));
  assert.equal(st.loadedKey, official.join(' '));
});

await test('a board whose load does not wait (tinue\'s own) behaves as before', async () => {
  const b = ninjaLike(0), st = { loadedKey: null };
  assert.equal(await showLineOn(b, st, official, 3, ptnOf), true);
  assert.equal(b.shown, official.slice(0, 3).join(' '));
  await showLineOn(b, st, official, 0, ptnOf);
  assert.equal(b.shown, '');
});

await test('the squares a move touches: its own, then each square a stack drops onto', () => {
  for (const [ptn, sqs] of [['c3', 'c3'], ['Sc3', 'c3'], ['Cf6', 'f6'], ['a1>', 'a1 b1'], ['3c3>', 'c3 d3'], ['4b2>211', 'b2 c2 d2 e2'], ['2d4<11', 'd4 c4 b4'],
    ['3c3+12', 'c3 c4 c5'], ['5e5-221', 'e5 e4 e3 e2'], ['2c3-*', 'c3 c2'], ['3a1>111', 'a1 b1 c1 d1'], ['2c3-11*', 'c3 c2 c1']]) assert.equal(moveSquares(ptn).join(' '), sqs, ptn);
  assert.deepEqual(moveSquares('nonsense'), []);
});

console.log(`${n} tests passed`);
