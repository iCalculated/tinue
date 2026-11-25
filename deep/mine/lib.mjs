// Shared helpers for the hard-100 mining drivers (no dependencies beyond node and shared/).
//   runDeep(args, opts)  -> run target/release/deep under nice, sharded over processes, JSONL back
//   Engine               -> one Syntaks TEI process (teinewgame before every search)
//   readJsonl / writeJsonl, canon(tps, ptn) move canonicaliser, idea(ptn)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../../shared/tak.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEEP = process.env.DEEP_BIN || path.join(HERE, '..', 'target', 'release', 'deep');
export const SYN = process.env.SYN || '';
export const CHECK_PROOF = path.join(HERE, '..', 'check-proof.mjs');

export const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
export const writeJsonl = (f, rows) => fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
export const arg = (name, d) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : d; };

// CPU seconds of finished children (user + sys), from /usr/bin/time -p wrappers.
export function runOne(cmd, args, { stdoutFile, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const t = spawn('/usr/bin/time', ['-p', 'nice', '-n', '10', cmd, ...args], { cwd, stdio: ['ignore', stdoutFile ? fs.openSync(stdoutFile, 'w') : 'pipe', 'pipe'] });
    let out = '', err = '';
    t.stdout?.on('data', (d) => (out += d));
    t.stderr.on('data', (d) => (err += d));
    t.on('error', reject);
    t.on('exit', (code) => {
      const user = +(err.match(/^user\s+([\d.]+)/m)?.[1] || 0), sys = +(err.match(/^sys\s+([\d.]+)/m)?.[1] || 0);
      resolve({ code, out, err: err.replace(/^(real|user|sys)\s.*$/gm, '').trim(), cpu: user + sys });
    });
  });
}

/** Run `deep <cmd> <file> <shard> <n> ...rest` over n processes; returns {rows, cpu}. */
export async function runDeepSharded(cmd, file, n, rest, outFile) {
  const parts = await Promise.all([...Array(n).keys()].map((i) => runOne(DEEP, [cmd, file, String(i), String(n), ...rest], { stdoutFile: `${outFile}.part${i}` })));
  let cpu = 0, text = '';
  for (let i = 0; i < n; i++) { cpu += parts[i].cpu; if (parts[i].code) console.error(`deep ${cmd} shard ${i} exit ${parts[i].code}: ${parts[i].err.slice(0, 500)}`); text += fs.readFileSync(`${outFile}.part${i}`, 'utf8'); fs.unlinkSync(`${outFile}.part${i}`); }
  fs.writeFileSync(outFile, text);
  return { text, cpu };
}

/** Bounded parallel map. */
export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all([...Array(Math.min(n, items.length)).keys()].map(async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); } }));
  return out;
}

/** `deep prove` for suspects, one process per suspect, `procs` at once. jobs: [{ id, tps, hk }] (id = its row); sets
 *  result, len and, for a proof, checked ('ok' | 'FAIL' from check-proof.mjs) on each job. Rows take turns, so no row
 *  is left to run alone on one core at the end. Once a row has a checked proof (a cook: the row is rejected whatever
 *  its other suspects say), its suspects not yet started get result 'skipped'. Returns { cpu, skipped }. */
export async function proveSuspects(jobs, { dir, procs, secs, lp = '22' }) {
  fs.mkdirSync(dir, { recursive: true });
  const rowsOf = new Map();
  for (const j of jobs) { if (!rowsOf.has(j.id)) rowsOf.set(j.id, []); rowsOf.get(j.id).push(j); }
  const qs = [...rowsOf.values()], order = [];
  for (let k = 0; qs.some((q) => k < q.length); k++) for (const q of qs) if (k < q.length) order.push({ j: q[k], k });
  const cooked = new Set(); let cpu = 0, skipped = 0;
  await pool(order, procs, async ({ j, k }) => {
    if (cooked.has(j.id)) { j.result = 'skipped'; skipped++; return; }
    const f = path.join(dir, `${j.id}.${k}.in`), o = path.join(dir, `${j.id}.${k}.out`);
    fs.writeFileSync(f, `${j.tps}|${j.hk}\n`);
    const r = await runOne(DEEP, ['prove', f, 'and=1', 'q=1', `secs=${secs}`, 'dump=1', `lp=${lp}`], { stdoutFile: o });
    cpu += r.cpu;
    const fld = fs.readFileSync(o, 'utf8').split('\n').find((l) => /^0\t/.test(l))?.split('\t');
    if (!fld) { j.result = 'error'; console.error(`deep prove ${j.id}.${k} exit ${r.code}: ${r.err.slice(0, 300)}`); return; }
    j.result = fld[1]; j.len = +fld[2];
    if (j.result === 'proved') { // independent check of every cook proof
      const ck = await runOne('node', ['--no-warnings', CHECK_PROOF, o]);
      j.checked = ck.out.match(/^0\t(ok|FAIL)/m)?.[1] || null;
      if (j.checked === 'ok') cooked.add(j.id);
    }
  });
  return { cpu, skipped };
}

// ---- moves ----
export function canon(tps, ptn) { try { const g = Game.fromTPS(tps); return g.moveToPTN(g.parseMove(ptn)); } catch { return ptn; } }
/** Idea of a move: placement square, or source square plus direction. */
export function idea(ptn) {
  const m = ptn.match(/^[0-9]*([FSC]?)([a-h][1-8])([-+<>])?/);
  if (!m) return ptn;
  return m[3] ? m[2] + m[3] : m[2];
}
export function legalPTN(tps) { const g = Game.fromTPS(tps); return g.legalMoves().map((mv) => g.moveToPTN(mv)); }
export function after(tps, ptn, komi = 0) { const g = Game.fromTPS(tps, komi); g.play(ptn); return g.toTPS(); }

// ---- Syntaks (TEI) ----
export class Engine {
  constructor(bin = SYN) {
    this.child = spawn('nice', ['-n', '10', bin], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.buf = ''; this.job = null; this.cpuStart = process.hrtime.bigint();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); this.onLine(l); }
    });
    this.child.on('exit', () => { this.dead = true; if (this.job) this.job.reject(new Error('syntaks exited')); });
    this.send('tei\nsetoption name Threads value 1\nsetoption name Hash value 256\nsetoption name MateScores value true\nsetoption name HumanWDL value true');
  }
  send(s) { if (!this.dead) this.child.stdin.write(s + '\n'); }
  onLine(l) {
    const j = this.job; if (!j) return;
    if (l.startsWith('info ') && l.includes(' score ')) {
      const t = l.split(' '), g = (k) => { const i = t.indexOf(k); return i < 0 ? null : t[i + 1]; };
      const s = t.indexOf('score'), pvAt = t.indexOf('pv'), wdlAt = t.indexOf('wdl');
      const info = {
        k: +(g('multipv') || 1), depth: +g('depth'), nodes: +g('nodes'),
        cp: t[s + 1] === 'cp' ? +t[s + 2] : null, mate: t[s + 1] === 'mate' ? +t[s + 2] : null,
        bound: t.includes('lowerbound') || t.includes('upperbound'),
        wdl: wdlAt < 0 ? null : t.slice(wdlAt + 1, wdlAt + 4).map(Number), pv: pvAt < 0 ? [] : t.slice(pvAt + 1),
      };
      info.p = info.mate != null ? (info.mate > 0 ? 1 : 0) : info.wdl ? (info.wdl[0] + info.wdl[1] / 2) / 1000 : null;
      if (!info.bound || !j.lines.has(info.k)) j.lines.set(info.k, info);
      else if (info.depth > j.lines.get(info.k).depth) j.lines.set(info.k, info);
      if (info.k === 1 && info.pv[0]) j.trace.push([info.nodes, info.pv[0]]);
    } else if (l.startsWith('bestmove')) {
      this.job = null; j.best = l.split(/\s+/)[1];
      j.resolve({ best: j.best, lines: [...j.lines.values()].sort((a, b) => a.k - b.k), trace: j.trace, ms: Date.now() - j.t0 });
    }
  }
  /** One search. side-to-move numbers. exclude/searchmoves: PTN lists. */
  search(tps, halfKomi, { nodes = 1e6, multipv = 1, exclude = [], searchmoves = [] } = {}) {
    return new Promise((resolve, reject) => {
      this.job = { resolve, reject, lines: new Map(), trace: [], t0: Date.now() };
      let go = `go nodes ${Math.floor(nodes)}`;
      if (searchmoves.length) go += ` searchmoves ${searchmoves.join(' ')}`;
      if (exclude.length) go += ` excludemoves ${exclude.join(' ')}`;
      this.send(`setoption name MultiPV value ${multipv}\nsetoption name HalfKomi value ${halfKomi}\nteinewgame 6\nposition tps ${tps}\n${go}`);
    });
  }
  /** CPU seconds the engine process has used so far (ps), so contention does not inflate the count. */
  cpuSec() {
    try {
      const t = execFileSync('/bin/ps', ['-o', 'time=', '-p', String(this.child.pid)], { encoding: 'utf8' }).trim();
      const [a, b] = t.split('-').length > 1 ? [t.split('-')[0], t.split('-')[1]] : [0, t];
      return (+a) * 86400 + b.split(':').reduce((acc, x) => acc * 60 + +x, 0);
    } catch { return 0; }
  }
  quit() { this.send('quit'); setTimeout(() => { try { this.child.kill(); } catch {} }, 2000).unref(); }
}

/** Nodes at which the engine first picked a move of `keyIdeas` as pv[0] and kept it to the end (null if never). */
export function nodesToKey(trace, tps, keyIdeas) {
  let first = null;
  for (const [n, mv] of trace) { const ok = keyIdeas.has(idea(canon(tps, mv))); if (ok && first == null) first = n; if (!ok) first = null; }
  return first;
}
