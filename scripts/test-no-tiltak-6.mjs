// No Tiltak on 6×6 (Sasha, 2026-11-21: "we shouldn't have any tiltak analysis in 6x6"). 6×6 is Syntaks's alone: the
// analysis panel, a play-out's defender, a free game and Rush all ask tiltak.js supports() (or judge.js defender())
// before Tiltak, so those say no on 6×6 at every komi, analyze() refuses a 6×6 position, and a play-out whose Syntaks
// drops out ends 'noengine' without starting Tiltak. 4×4 and 5×5 are unchanged.
//   node --no-warnings scripts/test-no-tiltak-6.mjs
import assert from 'node:assert/strict';

// A fake Worker for the browser modules: records the workers made and every Tiltak search asked of them (its board
// size), and a Tiltak worker answers with its first legal move.
const made = [], searched = [];
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener = () => {};
globalThis.Worker = class {
  constructor(url) {
    this.url = String(url); made.push(this.url);
    setTimeout(() => this.onmessage?.({ data: { type: 'ready', bootMs: 1 } }), 1);
  }
  postMessage(m) {
    if (m.type !== 'analyze') return;
    searched.push(m.size);
    const g = Game.fromTPS(m.tps, 0), mv = g.moveToPTN(g.legalMoves()[0]);
    setTimeout(() => this.onmessage?.({ data: { type: 'done', id: m.id, bestmove: mv, info: { cp: 0, pv: [mv] } } }), 1);
  }
  terminate() {}
};

const { Game } = await import('../shared/tak.js');
const tiltak = await import('../public/tiltak.js');
const { defender } = await import('../public/playon.js');
const { freeDefender } = await import('../public/freeplay.js');
const { defenderMove } = await import('../public/defend.js');

let n = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); n++; console.log('ok', name); } catch (e) { failed++; console.log('FAIL', name, '\n ', e.message.split('\n')[0]); } };
const KOMIS = Array.from({ length: 25 }, (_, i) => -6 + i / 2); // -6 … 6 by halves
const TPS6 = '221,1221,21,1,x2/x3,1,2212S,x/x,2C,x2,1111C,2S/2,2,2,21S,2S,x/x2,2,x2,1S/2,x5 1 26';
const TPS5 = 'x5/x5/x2,1,x2/x5/2,x4 1 2';
const tiltakMade = () => made.filter((u) => /tiltak/.test(u)).length;
const asked = (size) => searched.filter((z) => z === size).length;

await test('tiltak.supports: never 6×6, at any komi; 4×4 and 5×5 as before', () => {
  for (const k of KOMIS) assert.equal(tiltak.supports(6, k), false, `6×6 komi ${k}`);
  assert.equal(tiltak.supports(4, 0), true); assert.equal(tiltak.supports(5, 2), true); assert.equal(tiltak.supports(5, 4.5), true);
  assert.equal(tiltak.supports(7, 0), false); assert.equal(tiltak.supports(8, 2), false);
});

await test('tiltak.analyze refuses a 6×6 position without starting the engine', async () => {
  const before = tiltakMade();
  await assert.rejects(tiltak.analyze({ tps: TPS6, size: 6, komi: 0, ms: 100 }));
  await assert.rejects(tiltak.analyze({ tps: TPS6, komi: 2, ms: 100 }), 'the size read from the TPS too');
  assert.equal(tiltakMade(), before);
});

await test('defender: Syntaks or none on 6×6, never Tiltak, even if the callback says it plays there', () => {
  for (const k of KOMIS) assert.notEqual(defender(6, k, () => true), 'tiltak', `6×6 komi ${k}`);
  assert.equal(defender(6, 2, () => true), 'syntaks');
  assert.equal(defender(6, 4, () => true), null);
  assert.equal(defender(6, 4, tiltak.supports), null);
  assert.equal(defender(5, 0, tiltak.supports), 'tiltak'); assert.equal(defender(4, 2, tiltak.supports), 'tiltak');
});

await test('free game on 6×6 where Syntaks can\'t run here (no SIMD, or failed): no game, not Tiltak', () => {
  const here = (s) => ({ syntaksHere: s, tiltakHere: tiltak.supports(6, 0) });
  assert.equal(freeDefender(defender(6, 0, tiltak.supports), here(false)), null);
  assert.equal(freeDefender(defender(6, 0, tiltak.supports), { ...here(true), syntaksStatus: 'failed' }), null);
  assert.equal(freeDefender(defender(6, 0, tiltak.supports), { ...here(true), failed: ['syntaks'] }), null);
  assert.equal(freeDefender(defender(6, 0, tiltak.supports), here(true)), 'syntaks');
});

await test('a 6×6 play-out whose Syntaks drops out ends noengine: Tiltak never started, no "Tiltak defends now" redraw', async () => {
  const before = tiltakMade();
  let redraws = 0;
  const po = { engine: 'syntaks', g: Game.fromTPS(TPS6, 0), mine: 1 };
  const d = await defenderMove(po, { size: 6, komi: 0, tps: TPS6, live: () => true, onFallback: () => redraws++, reply: async () => null });
  assert.deepEqual(d, { end: 'noengine' });
  assert.equal(po.fallback, true);
  assert.equal(redraws, 0);
  assert.equal(tiltakMade(), before);
});

await test('5×5 unchanged: Syntaks isn\'t there, Tiltak defends', async () => {
  const before = asked(5);
  const po = { engine: 'tiltak', g: Game.fromTPS(TPS5, 0), mine: 1 };
  const d = await defenderMove(po, { size: 5, komi: 0, tps: TPS5, live: () => true });
  assert.ok(d?.mv, JSON.stringify(d));
  assert.equal(asked(5), before + 1);
});

await test('Tiltak was never asked about a 6×6 position', () => assert.equal(asked(6), 0));

console.log(`\n${n} tests passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
