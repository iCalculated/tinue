// Per-conversion features from the build DB -> feats.jsonl
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { threatMoves, defenderMoves } from '../../shared/pns.js';
import { Game, winningMoves } from '../../shared/tak.js';
const d = new DatabaseSync(process.env.DB || new URL('../../data/tinue.db', import.meta.url).pathname, { readOnly: true });
const out = fs.createWriteStream(process.env.OUT || 'feats.jsonl');
let n = 0;
for (const r of d.prepare("SELECT id,size,komi,plies,tps,rating,init_rating,themes,swing,meta,tree,flaw,turn FROM puzzles WHERE turn = " + (+process.env.TURN || 0) + " AND source NOT LIKE 'Ditaktic%'").iterate()) {
  const t = JSON.parse(r.tree), s = r.swing ? JSON.parse(r.swing) : {}, m = r.meta ? JSON.parse(r.meta) : {};
  // walk attacker nodes: keys per node, depth
  let nodes = 0, multi = 0, maxKeys = 0, leaves = 0; const keysByDepth = [];
  const walk = (node, depth) => {
    if (node === 'win' || !node) { leaves++; return; }
    const ks = Object.keys(node); nodes++; if (ks.length > 1) multi++; maxKeys = Math.max(maxKeys, ks.length);
    (keysByDepth[depth] ||= []).push(ks.length);
    for (const k of ks) walk(node[k] ? node[k].n : "win", depth + 1);
  };
  let rootKeys;
  if (t === 'win') { const g = Game.fromTPS(r.tps, r.komi); rootKeys = winningMoves(g, 1).moves; }
  else { walk(t, 0); rootKeys = Object.keys(t); }
  // main line through first keys
  let line = [], node = t; while (node && node !== 'win') { const k = Object.keys(node)[0]; line.push(k); if (!node[k]) break; line.push(node[k].r); node = node[k].n; }
  const gl = m.gameLine || [];
  const found = gl.length ? rootKeys.includes(gl[0]) || rootKeys.includes(gl[0].replace(/^1(?=[a-h])/, '')) : null;
  // quiet = after the attacker move, the attacker has no road-in-1 (it isn't a Tak threat). Checked along the main line.
  const g0 = Game.fromTPS(r.tps, r.komi), att = g0.toMove;
  const isThreat = (g) => { const h = g.clone(); h.toMove = att; return winningMoves(h, 1).moves.length > 0; };
  const quiet = []; let ok = true;
  { const g = g0.clone(); for (let i = 0; i < line.length; i++) { const mv = line[i]; if (!mv || mv === 'win') break;
      try { g.play(mv); } catch { ok = false; break; }
      if (i % 2 === 0) { if (g.result()) break; quiet.push(isThreat(g) ? 0 : 1); } } }
  const thr = [], keysAt = [], defs = [];
  if (t !== 'win') { const g = g0.clone(); let node = t;
    for (let i = 0; i < line.length && node && node !== 'win'; i += 2) {
      const ks = Object.keys(node); keysAt.push(ks.length);
      thr.push(threatMoves(g).length);
      const k = ks[0]; g.play(k); if (!node[k] || g.result()) break;
      defs.push(defenderMoves(g, att).length);
      g.play(node[k].r); node = node[k].n;
    } }
  let rootQuiet = null;
  if (t !== 'win' && rootKeys.length) { rootQuiet = 0; for (const k of rootKeys) { const g = g0.clone(); try { g.play(k); if (!g.result() && !isThreat(g)) rootQuiet++; } catch {} } }
  const attName = att === 1 ? m.white : m.black, attRating = att === 1 ? m.ratingWhite : m.ratingBlack;
  const reasons = [];
  if ((s.pre0 ?? 0) > 0.5) reasons.push('ahead');
  if (s.lostBefore === 'proved' || s.esc === false) reasons.push('lostBefore');
  if (s.alt != null && s.alt >= 0.65) reasons.push('missOk');
  if ((s.alts && s.alts.length) || s.slow1) reasons.push('slowerWin');
  const themes = r.themes ? r.themes.split(',') : [];
  out.write(JSON.stringify({
    id: r.id, src: r.id.startsWith('ps') ? 'ps' : r.id.startsWith('pd') ? 'pd' : 'p', size: r.size, komi: r.komi, plies: r.plies,
    rating: Math.round(r.rating), init: Math.round(r.init_rating), flaw: r.flaw ? 1 : 0, themes,
    pre0: s.pre0 ?? null, alt: s.alt ?? null, lostBefore: s.lostBefore ?? null, esc: s.esc ?? null,
    alts: s.alts ? s.alts.length : null, altsAt: s.altsAt ? Object.keys(s.altsAt).length : 0, slow1: s.slow1 ?? null,
    rootKeys: rootKeys.length, rootWins: m.rootWins ?? null, attNodes: nodes, multiNodes: multi, maxKeys, leaves,
    found, gameLen: gl.length, foundScreen: m.screen?.found ?? null, wonGame: m.screen?.wonGame ?? null,
    quietLine: quiet, thr, keysAt, defs, lineOk: ok, rootQuiet, attName, attBot: /bot|tiltak|takkerus|topaz/i.test(attName || '') || attRating === 0, attRating, reasons, rW: m.ratingWhite ?? null, rB: m.ratingBlack ?? null, ply: m.ply ?? null, white: m.white, black: m.black,
  }) + '\n');
  n++;
}
out.end(() => console.log('wrote', n));
