// Dragon sub-positions: puzzles reached by a line that leaves a real PlayTak game (meta.dragon.path). The game's
// players and moves are credited only up to where the line starts (shared/ptn.js unplayedPlies); the share text calls
// the line a line. Every other puzzle's share text must stay byte-identical to what it was before.
//   node --no-warnings scripts/test-dragon.mjs   (the DB checks need data/tinue.db, which isn't in git; skipped without it)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unplayedPlies } from '../shared/ptn.js';
import { shareText } from '../server/share.js';

let checks = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

// --- unplayedPlies ---
const H = (n) => Array.from({ length: n }, (_, i) => 'a' + ((i % 6) + 1));
eq(unplayedPlies(undefined), 0, 'no meta');
eq(unplayedPlies(null), 0, 'null meta');
eq(unplayedPlies({}), 0, 'empty meta');
eq(unplayedPlies({ history: H(10) }), 0, 'ordinary puzzle');
eq(unplayedPlies({ history: H(10), dragon: {} }), 0, 'no path');
eq(unplayedPlies({ history: H(10), dragon: { path: 'b1 b2-' } }), 0, 'path not an array');
eq(unplayedPlies({ history: H(10), dragon: { path: { length: 3 } } }), 0, 'array-like path');
eq(unplayedPlies({ history: H(10), dragon: { path: [] } }), 0, 'empty path');
eq(unplayedPlies({ history: H(10), dragon: { path: ['b1', 'b2-'] } }), 2, 'normal');
eq(unplayedPlies({ history: H(10), dragon: { path: H(8) } }), 8, 'normal, 8');
eq(unplayedPlies({ history: H(3), dragon: { path: H(5) } }), 3, 'longer than the history: clamped');
eq(unplayedPlies({ dragon: { path: H(5) } }), 0, 'no history');
eq(unplayedPlies({ history: 'a1 a2', dragon: { path: H(2) } }), 0, 'history not an array');

// --- shareText, the function as it was before (c0b0373), for the byte-identical check ---
function shareTextOld(p) {
  const side = p.tps.trim().split(/\s+/)[1] === '2' ? 'Black' : 'White';
  const title = `${side} to play: find the win`;
  let meta = {}; try { meta = typeof p.meta === 'string' ? JSON.parse(p.meta || '{}') : p.meta || {}; } catch {}
  const h = Array.isArray(meta.history) ? meta.history : [];
  let last = '';
  if (h.length) {
    const from = Math.max(0, h.length - 4);
    last = h.slice(from).map((m, k) => { const i = from + k; return (i % 2 === 0 ? `${i / 2 + 1}. ` : k === 0 ? `${(i + 1) / 2}… ` : '') + m; }).join(' ');
  }
  const desc = [`${p.size}×${p.size}`, p.komi ? `komi ${p.komi}` : null, last ? `last moves ${last}` : null].filter(Boolean).join(' · ');
  return { title, desc };
}

// synthetic: a 2-ply line after White's 31st move, and an 8-ply line (only its last four listed)
const tps = 'x6/x6/x6/x6/x6/x6 1 1';
const syn = (hist, path) => ({ size: 6, komi: 2, tps, meta: JSON.stringify({ history: hist, ...(path ? { dragon: { path } } : {}) }) });
eq(shareText(syn([...H(59), 'b1', 'b2-'], ['b1', 'b2-'])).desc, '6×6 · komi 2 · a line not played in the game, ending 30… b1 31. b2-', '2-ply line');
eq(shareText(syn([...H(50), ...H(8)], H(8))).desc, '6×6 · komi 2 · a line not played in the game, ending 28. a5 a6 29. a1 a2', '8-ply line: last four');
eq(shareText(syn(H(1), H(3))).desc, '6×6 · komi 2 · a line not played in the game, ending 1. a1', 'line clamped to the history');
for (const p of [syn(H(59)), syn(H(2), []), syn([]), { size: 5, komi: 0, tps, meta: null }, { size: 5, komi: 0, tps, meta: '{bad' }, syn(H(9), 'x')])
  eq(shareText(p), shareTextOld(p), 'ordinary (synthetic) unchanged: ' + JSON.stringify(p.meta));

// --- the real rows ---
const DB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'tinue.db');
const SIX = ['pdg111351-61', 'pdg598214-29', 'pdg625630-39', 'pdg708763-66', 'pdg768760-33', 'pdg322280-58'];
if (!fs.existsSync(DB)) console.log('test-dragon: data/tinue.db missing, DB checks skipped');
else {
  const db = new DatabaseSync(DB, { readOnly: true });
  const get = db.prepare('SELECT id, size, tps, plies, themes, source, komi, meta FROM puzzles WHERE id = ?');
  for (const id of SIX) {
    const p = get.get(id);
    assert.ok(p, id + ' is in the DB');
    const m = JSON.parse(p.meta), n = m.dragon.path.length;
    eq(unplayedPlies(m), n, id + ': the whole path is unplayed');
    eq(m.history.slice(-n), m.dragon.path, id + ': history ends with the path');
    const { title, desc } = shareText(p), old = shareTextOld(p);
    eq(title, old.title, id + ': title unchanged');
    assert.ok(!desc.includes('last moves'), id + ': no "last moves": ' + desc); checks++;
    assert.ok(desc.includes('a line not played in the game, ending '), id + ': calls it a line: ' + desc); checks++;
    const listed = desc.split(', ending ')[1].split(' ').filter((t) => !/^\d+[.…]$/.test(t));
    eq(listed, m.dragon.path.slice(-Math.min(n, 4)), id + ': lists only the line\'s plies');
    console.log(`   ${id}: ${desc}`);
  }
  // Every other puzzle the stubs are built for: byte-identical share text (the whole table, it's fast).
  let same = 0, dragons = 0;
  for (const p of db.prepare("SELECT id, size, tps, komi, meta FROM puzzles WHERE source NOT LIKE 'Ditaktic%'").iterate()) {
    if (unplayedPlies(JSON.parse(p.meta || '{}'))) { dragons++; assert.ok(SIX.includes(p.id), 'unexpected line puzzle ' + p.id); continue; }
    assert.deepEqual(shareText(p), shareTextOld(p), p.id + ': share text changed');
    same++;
  }
  checks += same;
  // A tripwire on purpose: when more line puzzles (dragon sub-positions) are imported or graded in, this fails. Check
  // the new ones read right on the site (info panel, move list divider, share text), then add their ids to SIX.
  eq(dragons, SIX.length, 'exactly the six line puzzles');
  console.log(`   ${same} ordinary puzzles: share text byte-identical`);
}
console.log(`test-dragon: ${checks} checks passed`);
