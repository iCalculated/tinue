// B1a (docs/plan/PLAN.md, acceptance A14): deep's TPS writer and move notation against shared/book.js bookKey and
// tak.js canonical PTN, on every node of every served 6x6 puzzle tree (and every stored alt's position).
//   node --no-warnings scripts/book-keycheck.mjs <db> [--limit N] [--deep deep/target/release/examples/keydump]
// Per position, both sides compute: the key; the set of legal moves, each written as `ptn=key of the position after
// it` (deep's ptn vs tak.js canonical PTN; deep's tps_board after make vs bookKey after apply); and the parse of every
// stored tree move at that node (deep parse_move+ptn vs tak.js canon). Exit 1 and list every mismatch.
// Opens the database read-only. Build the dumper first: cd deep && cargo build --release --example keydump
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Game } from '../shared/tak.js';
import { bookKey, halfKomi } from '../shared/book.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const limit = +flag('--limit', 0);
const DUMP = flag('--deep', path.join(ROOT, 'deep/target/release/examples/keydump'));
const dbPath = args[0];
if (!dbPath) { console.error('usage: book-keycheck.mjs <db> [--limit N] [--deep keydump]'); process.exit(2); }
if (!fs.existsSync(DUMP)) { console.error(`${DUMP} missing: cd deep && cargo build --release --example keydump`); process.exit(2); }

// a superset of the served pool on purpose, as book-init.mjs proves it
const SERVED = "(turn = 1 OR grade = 'A')";
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare(`SELECT id, tps, komi, tree, swing FROM puzzles WHERE size = 6 AND ${SERVED} ORDER BY id${limit ? ' LIMIT ' + limit : ''}`).all();
db.close();

const fnv = (s, h) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
// One position: what deep must reproduce.
const seen = new Map(); // dedupe on tps-with-move-number + komi + moves to parse
const items = [];
function visit(g, komi, moves, where) {
  const tps = g.toTPS(), hk = halfKomi(komi), id = tps + '|' + hk + '|' + moves.join(' ');
  if (seen.has(id)) return;
  seen.set(id, items.length);
  const lines = [];
  for (const mv of g.legalMoves()) {
    const ptn = g.moveToPTN(mv), u = g.apply(mv);
    lines.push(ptn + '=' + bookKey(g, komi));
    g.undo(u);
  }
  lines.sort();
  const joined = lines.join('\n');
  items.push({ where, line: id, key: bookKey(g, komi), n: lines.length, h1: fnv(joined, 0x811c9dc5), h2: fnv(joined, 0x01234567),
    parsed: moves.map((m) => { try { return g.canon(m); } catch { return '!err'; } }).join(','), lines });
}

const t0 = Date.now();
let nodes = 0;
for (const p of rows) {
  const tree = JSON.parse(p.tree), swing = p.swing ? JSON.parse(p.swing) : {};
  const g = Game.fromTPS(p.tps, p.komi);
  const altsHere = (key) => (key ? swing.altsAt?.[key] : swing.alts) || [];
  const walk = (node, g0, pathMoves) => {
    // attacker node: stored tree moves and alts are parsed here
    const here = node === 'win' ? [] : Object.keys(node);
    const alts = altsHere(pathMoves.join(' '));
    visit(g0, p.komi, [...here, ...alts], `${p.id} @${pathMoves.join(' ') || 'root'}`); nodes++;
    for (const a of alts) { // position after each alt (defender to move)
      const g1 = g0.clone(); g1.play(g1.canon(a));
      if (!g1.result()) { visit(g1, p.komi, [], `${p.id} @${[...pathMoves, a].join(' ')} (alt)`); nodes++; }
    }
    if (node === 'win') return;
    for (const m of here) {
      const g1 = g0.clone(); g1.play(g1.canon(m));
      const { r, n } = node[m];
      visit(g1, p.komi, [r], `${p.id} @${[...pathMoves, m].join(' ')}`); nodes++;
      const g2 = g1.clone(); g2.play(g2.canon(r));
      walk(n, g2, [...pathMoves, g0.canon(m), r]);
    }
  };
  walk(tree, g, []);
}
const tJs = Date.now() - t0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'book-keycheck-'));
const input = path.join(tmp, 'in.txt');
fs.writeFileSync(input, items.map((x) => x.line).join('\n') + '\n');
const runDeep = (file, verbose) => {
  const r = spawnSync(DUMP, [file, ...(verbose ? ['v=1'] : [])], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('keydump failed: ' + r.stderr);
  return r.stdout.split('\n').filter(Boolean);
};
const t1 = Date.now();
const out = runDeep(input, false);
const tDeep = Date.now() - t1;

const mism = [];
if (out.length !== items.length) mism.push({ where: '-', what: `deep printed ${out.length} rows for ${items.length} positions` });
const redo = [];
for (const l of out) {
  const f = l.split('\t'), x = items[+f[0]];
  if (f[1] === 'error') { mism.push({ where: x.where, what: 'deep rejected the TPS: ' + f[2] }); continue; }
  const [, key, n, h1, h2, parsed = ''] = f;
  if (key !== x.key) mism.push({ where: x.where, what: `key deep ${key} js ${x.key}` });
  if (parsed !== x.parsed) mism.push({ where: x.where, what: `parsed moves deep ${parsed} js ${x.parsed}` });
  if (+n !== x.n || +h1 !== x.h1 || +h2 !== x.h2) redo.push(x);
}
// Detail for every position whose move set or child keys differ.
if (redo.length) {
  const f2 = path.join(tmp, 'redo.txt');
  fs.writeFileSync(f2, redo.map((x) => x.line).join('\n') + '\n');
  let cur = -1; const got = redo.map(() => []);
  for (const l of runDeep(f2, true)) { if (l.startsWith('M\t')) got[cur].push(l.slice(2)); else cur = +l.split('\t')[0]; }
  redo.forEach((x, i) => {
    const d = new Set(got[i]), j = new Set(x.lines);
    const onlyDeep = got[i].filter((s) => !j.has(s)), onlyJs = x.lines.filter((s) => !d.has(s));
    mism.push({ where: x.where, what: `moves/child keys: only deep [${onlyDeep.join(' ; ')}] only js [${onlyJs.join(' ; ')}]` });
  });
}
fs.rmSync(tmp, { recursive: true, force: true });

const legal = items.reduce((a, x) => a + x.n, 0);
console.log(`book-keycheck: ${rows.length} served 6x6 puzzles, ${nodes} nodes visited, ${items.length} distinct positions, ${legal} legal moves (each: ptn + child key), ${items.reduce((a, x) => a + (x.parsed ? x.parsed.split(',').length : 0), 0)} stored moves parsed; js ${tJs} ms, deep ${tDeep} ms`);
for (const m of mism) console.log('MISMATCH', m.where, m.what);
console.log(`${mism.length} mismatches`);
process.exit(mism.length ? 1 : 0);
