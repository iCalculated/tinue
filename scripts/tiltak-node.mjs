// Tiltak (Morten Lohne, GPL-3.0; public/tiltak/) in plain Node, no install. The wasm-bindgen glue runs
// unchanged: start_engine() spawns an async TEI loop on the microtask queue, so each request is
// "send lines, await bestmove". Fixed-node searches only (deterministic, comparable across positions).
//
//   const t = await Tiltak.create();
//   const r = await t.evaluate({ tps, size, komi: 2, nodes: 20000 });
//   // r = { cpStm, pStm, pWhite, bestmove, pv, nodes, ms (wall), cpu (thread CPU ms), noInfo }
//
// Perspective: Tiltak's "score cp" is from the SIDE TO MOVE and equals 200·p − 100 (p = MCTS expected
// score of its best move), see public/tiltak.js. pStm = (cp+100)/200; pWhite flips it for black to move.
// Same panic rules as public/tiltak/worker.js: size 4/5/6 only, komi 0 or 2 only, no finished games.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../public/tiltak/', import.meta.url));
const mod = await import(new URL('../public/tiltak/tiltak_wasm.js', import.meta.url));
let inited = false;

export class Tiltak {
  static async create() {
    if (!inited) { mod.initSync({ module: fs.readFileSync(dir + 'tiltak_wasm_bg.wasm') }); inited = true; }
    const t = new Tiltak();
    t.waiter = null; t.last = null; t.size = null; t.halfKomi = 0; t.dead = null;
    const origErr = console.error;
    console.error = (...a) => { const m = a.map(String).join(' '); if (/panicked at/.test(m)) { t.dead = m; t.waiter?.reject(new Error(m)); } origErr(...a); };
    t.send = mod.start_engine((line) => t.onLine(line));
    await t.cmd('tei', (l) => l === 'teiok');
    return t;
  }
  onLine(line) {
    if (line.startsWith('info ')) { this.last = line; }
    const w = this.waiter;
    if (w && w.done(line)) { this.waiter = null; w.resolve(line); }
  }
  cmd(line, done) {
    if (this.dead) return Promise.reject(new Error(this.dead));
    return new Promise((resolve, reject) => { this.waiter = { done, resolve, reject }; this.send(line); });
  }
  async evaluate({ tps, size, komi = 0, nodes = 20000 }) {
    const halfKomi = Math.round(komi * 2);
    if (![4, 5, 6].includes(size)) throw new Error('size ' + size);
    if (![0, 4].includes(halfKomi)) throw new Error('komi ' + komi);
    if (size !== this.size) { this.send(`teinewgame ${size}`); this.size = size; }
    // set komi on every call: caching it let a komi-2 setting leak into later komi-0 evals in worker threads
    this.send(`setoption name HalfKomi value ${halfKomi}`); this.halfKomi = halfKomi;
    this.send(`position tps ${tps.trim()}`);
    this.last = null;
    const t0 = performance.now(), c0 = cpuMs();
    const best = await this.cmd(`go nodes ${nodes}`, (l) => l.startsWith('bestmove'));
    const ms = performance.now() - t0, cpu = cpuMs() - c0;
    const info = this.last ? parseInfo(this.last) : null;
    const whiteToMove = tps.trim().split(/\s+/)[1] === '1';
    const cpStm = info?.cp ?? null;
    const pStm = cpStm == null ? null : (cpStm + 100) / 200;
    return { cpStm, pStm, pWhite: pStm == null ? null : whiteToMove ? pStm : 1 - pStm,
      bestmove: best.split(/\s+/)[1] || null, pv: info?.pv || [], nodes: info?.nodes ?? 0, ms, cpu, noInfo: !info };
  }
}

// thread CPU ms (wall time is meaningless on a loaded box)
function cpuMs() { const u = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; }

function parseInfo(line) {
  const w = line.split(/\s+/), info = { pv: [] };
  for (let i = 1; i < w.length; i++) {
    const k = w[i];
    if (k === 'pv') { info.pv = w.slice(i + 1); break; }
    if (k === 'score') { const kind = w[++i], v = +w[++i]; info[kind] = v; continue; }
    if (i + 1 < w.length) info[k] = +w[++i];
  }
  return info;
}
