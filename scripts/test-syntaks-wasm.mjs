// Syntaks in WebAssembly (public/syntaks/syntaks.wasm, built by wasm/syntaks/build.sh), driven through the same
// worker.js the browser runs: a legal move from a quiet position, and a forced road found as a mate score from the
// side to move. Skipped when the wasm hasn't been built.   node scripts/test-syntaks-wasm.mjs [--bench]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Game } from '../shared/tak.js';

const WASM = new URL('../public/syntaks/syntaks.wasm', import.meta.url);
if (!fs.existsSync(WASM)) { console.log('skip: public/syntaks/syntaks.wasm not built (sh wasm/syntaks/build.sh)'); process.exit(0); }
const wasm = fs.readFileSync(WASM);
let resolve;
globalThis.self = { postMessage: (m) => resolve(m) };
globalThis.fetch = async () => new Response(wasm, { headers: { 'content-type': 'application/wasm' } });
new Function(fs.readFileSync(new URL('../public/syntaks/worker.js', import.meta.url), 'utf8') + '\nself.tei = tei;')();
const ask = (data) => new Promise((r) => { resolve = r; self.onmessage({ data }); });

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await test('loads', async () => assert.equal((await ask({ type: 'init', url: 'x' })).type, 'ready'));

await test('a legal move from a quiet position', async () => {
  const tps = 'x6/x6/x6/x6/x6/2,x5 1 2', r = await ask({ id: 1, type: 'go', tps, halfKomi: 4, ms: 5000, nodes: 20000 });
  assert.equal(r.type, 'result');
  const g = Game.fromTPS(tps, 2);
  assert.ok(g.isLegal(g.parseMove(r.bestmove)), r.bestmove);
  assert.ok(r.info.depth >= 3 && r.info.pv.length >= 1);
});

await test('a road in one is a mate score for the side to move', async () => {
  // White to move with a2–e2 placed: f2 completes the road
  const tps = 'x6/x6/x6/x6/1,1,1,1,1,x/2,2,2,2,x2 1 6', r = await ask({ id: 2, type: 'go', tps, halfKomi: 4, ms: 5000, nodes: 20000 });
  assert.equal(r.bestmove, 'f2');
  assert.ok(r.info.mate > 0, JSON.stringify(r.info));
});

await test('a position Syntaks rejects is an error, not a search of the previous one', async () => {
  const r = await ask({ id: 3, type: 'go', tps: 'x6/x6/x6/x6/x6/x6/x6 1 2', halfKomi: 4, ms: 1000, nodes: 1000 });
  assert.equal(r.type, 'error'); assert.match(r.error, /rejected/);
});

if (process.argv.includes('--bench')) { // the engine's own bench: the node count must match the native build (5075713)
  const t0 = performance.now(), out = self.tei('bench').join('\n');
  console.log(out.split('\n').slice(-2).join(' '), Math.round(performance.now() - t0) + ' ms');
  assert.match(out, /5075713 nodes/);
}
console.log(`\nOK: ${n} syntaks-wasm tests`);
