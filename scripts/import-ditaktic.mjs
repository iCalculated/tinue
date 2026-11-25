// Import Ditaktic daily puzzles (ditaktic.blogspot.com, by Nqeron) from the decoded blog dump.
// The puzzles are copyrighted: output goes to data/puzzles-local/ (gitignored) for local use only.
//
// Each post has the puzzle (a ptn.ninja link → TPS) and, in a LATER post, "Solution to #N" with the
// author's line (ptn.ninja branches marked {13b1} etc. — we keep only the main line before the first branch).
// We re-derive the full solution tree with our own solver, steering the main line toward the author's.
// Positions we can't prove within maxPlies/maxNodes (or that aren't forced-win puzzles) go to *-unsolved.jsonl.
//
// usage: node --no-warnings scripts/import-ditaktic.mjs <ditaktic_decoded.json>
//          [--out-dir data/puzzles-local] [--threads 12] [--max-plies 7] [--max-nodes 3e7] [--fresh] [--only 92.1,92.2]
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

// Normalized difficulty. Early posts use Kingkiller Tak ranks; the blog's own titles map
// Takolyte→Beginner and El'the→Hard (e.g. #13.2, #13.5), so E'lir→Easy, Re'lar→Medium.
export const LABELS = ['Trivial', 'Beginner', 'Easy', 'Medium', 'Hard', 'Impossible'];
const RANK_ALIASES = [
  [/pre-?beginner|trivial/i, 'Trivial'], [/takolyte/i, 'Beginner'], [/beginner/i, 'Beginner'],
  [/e['’]?lir/i, 'Easy'], [/re['’]?lar/i, 'Medium'], [/el['’]?the/i, 'Hard'],
  [/impossible/i, 'Impossible'], [/hard/i, 'Hard'], [/medium/i, 'Medium'], [/easy/i, 'Easy'],
];
function normDifficulty(p) {
  const tail = (p.type_line || '').split('\n')[0].split(' - ').pop();
  for (const src of [p.difficulty && p.difficulty.length > 3 ? p.difficulty : '', tail, p.title || '', p.url || '']) {
    for (const [re, lab] of RANK_ALIASES) if (re.test(src)) return lab;
  }
  return null;
}

// Puzzle kind from the post's first line ("Tinuë - White to play - Easy:").
function puzzleKind(p) {
  const head = (p.type_line || '').split('\n')[0].split(/ - |-\s(?=Black|White)/)[0].replace(/&nbsp;/g, '').trim();
  if (/avoidance/i.test(head)) return { head, ok: false, why: 'tinue avoidance (defensive puzzle, not a forced win)' };
  if (/best move/i.test(head)) return { head, ok: false, why: 'best-move puzzle (not a forced win)' };
  if (/mistakes/i.test(head)) return { head, ok: false, why: 'find-the-mistakes game review' };
  if (/indigo|red to win/i.test(head)) return { head, ok: false, why: 'variant game (not standard Tak)' };
  if (/tinu|to win|forced win|gaelet|black to win/i.test(head)) return { head, ok: true };
  return { head, ok: false, why: 'unrecognized puzzle type: ' + head.slice(0, 60) };
}

const header = (ptn, k) => (ptn.match(new RegExp(`\\[${k}\\s+"([^"]*)"\\]`)) || [])[1];

// Main line of a ptn.ninja PTN: moves before the first {branch} marker; drop numbers, "--", results, annotations.
export function mainLineOf(ptn) {
  let body = ptn.replace(/\[(\w+)\s+"[^"]*"\]/g, ' ');
  const b = body.indexOf('{'); if (b >= 0) body = body.slice(0, b);
  return body.split(/\s+/).map((t) => t.replace(/^\d+\./, '').replace(/[!?'"*]+$/, ''))
    .filter((t) => t && t !== '--' && !/^(R-0|0-R|F-0|0-F|1-0|0-1|1\/2-1\/2)$/.test(t));
}

if (isMainThread) {
  const src = process.argv[2];
  if (!src || src.startsWith('--')) { console.error('usage: import-ditaktic.mjs <ditaktic_decoded.json> [opts]'); process.exit(1); }
  const outDir = arg('out-dir', 'data/puzzles-local');
  const threads = +arg('threads', 12), maxPlies = +arg('max-plies', 7), maxNodes = +arg('max-nodes', 3e7);
  const only = arg('only', null)?.split(',');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'ditaktic.jsonl'), unFile = path.join(outDir, 'ditaktic-unsolved.jsonl');
  if (process.argv.includes('--fresh')) for (const f of [outFile, unFile]) fs.rmSync(f, { force: true });
  const done = new Set();
  for (const f of [outFile, unFile]) if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) done.add(JSON.parse(l).id);

  const posts = JSON.parse(fs.readFileSync(src, 'utf8'));
  // solutions are published in later posts, keyed by puzzle number
  const sols = new Map();
  for (const p of posts) for (const [k, v] of Object.entries(p.solutions_in_post || {})) if (v?.ptn) (sols.get(k) || sols.set(k, []).get(k)).push(v.ptn);

  const tasks = [], unsolved = [];
  const seen = new Set();
  for (const p of posts) {
    const id = 'd' + String(p.id).replace(/[^\w.-]/g, '-').replace(/\./g, '-');
    if (seen.has(id)) continue; seen.add(id);
    if (done.has(id) || (only && !only.includes(p.id))) continue;
    const kind = puzzleKind(p);
    const ptn = p.puzzle?.ptn || '';
    const tps = header(ptn, 'TPS');
    const difficulty = normDifficulty(p);
    const komi = +(header(ptn, 'Komi') || 0);
    // author's solution: prefer the one whose TPS matches the puzzle; else moves embedded in the puzzle PTN
    const cands = sols.get(p.id) || [];
    const solPtn = cands.find((s) => header(s, 'TPS') === tps) || cands[0] || null;
    let authorLine = solPtn ? mainLineOf(solPtn) : [];
    if (!authorLine.length && tps) authorLine = mainLineOf(ptn);
    const solTpsMismatch = !!(solPtn && header(solPtn, 'TPS') !== tps);
    const base = {
      id, size: +(header(ptn, 'Size') || 0) || null, tps: tps || null, komi, difficulty, rawDifficulty: p.difficulty,
      kind: kind.head, title: p.title, date: p.published, sourceRef: p.url, authorLine, authorSolution: solPtn,
      flats: header(ptn, 'Flats') || null, caps: header(ptn, 'Caps') || null,
    };
    if (!tps) { unsolved.push({ ...base, reason: 'no TPS (game record or variant board)' }); continue; }
    if (!kind.ok) { unsolved.push({ ...base, reason: kind.why }); continue; }
    if (solTpsMismatch) base.solTpsMismatch = true;
    tasks.push(base);
  }
  const unFd = fs.openSync(unFile, 'a'), outFd = fs.openSync(outFile, 'a');
  for (const u of unsolved) fs.writeSync(unFd, JSON.stringify(u) + '\n');
  console.error(`${posts.length} posts: ${tasks.length} to analyze, ${unsolved.length} skipped as non-forced-win/no TPS, ${done.size} already done; ${threads} threads`);

  // --order hard: biggest/hardest first (least straggling). Default 'mix': round-robin across difficulty labels,
  // small boards first within a label, so a partial run is already a balanced calibration sample.
  if (arg('order', 'mix') === 'hard') tasks.sort((a, b) => (b.size - a.size) || (LABELS.indexOf(b.difficulty) - LABELS.indexOf(a.difficulty)));
  else {
    const byLab = new Map();
    for (const t of tasks.sort((a, b) => a.size - b.size)) (byLab.get(t.difficulty) || byLab.set(t.difficulty, []).get(t.difficulty)).push(t);
    const qs = [...byLab.values()]; tasks.length = 0;
    for (let i = 0; qs.some((q) => i < q.length); i++) for (const q of qs) if (i < q.length) tasks.push(q[i]);
  }
  let next = 0, finished = 0, ok = 0; const t0 = Date.now();
  await new Promise((resolve) => {
    let alive = 0;
    const n = Math.min(threads, tasks.length);
    if (!n) return resolve();
    const spawn = () => { // a worker that dies records its puzzle as a crash and is replaced, as in mine-deep.mjs
      alive++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { maxPlies, maxNodes } });
      let cur = null, dead = false;
      const feed = () => { if (next < tasks.length) w.postMessage(cur = tasks[next++]); else { cur = null; w.terminate(); if (--alive === 0) resolve(); } };
      w.on('message', (m) => {
        finished++;
        if (m.puzzle) { ok++; fs.writeSync(outFd, JSON.stringify(m.puzzle) + '\n'); }
        else fs.writeSync(unFd, JSON.stringify(m.unsolved) + '\n');
        const r = m.puzzle ? `ok ${m.puzzle.plies}p r${m.puzzle.rating}` : 'UNSOLVED ' + m.unsolved.reason;
        console.error(`[${finished}/${tasks.length}] ${m.id} s${cur?.size} ${m.ms}ms ${r}`);
        feed();
      });
      w.on('error', (e) => {
        if (dead) return; dead = true;
        console.error('worker error', cur?.id, e);
        if (cur) { finished++; fs.writeSync(unFd, JSON.stringify({ ...cur, reason: 'crash: ' + e.message }) + '\n'); }
        alive--;
        if (next < tasks.length) spawn(); else if (alive === 0) resolve();
      });
      feed();
    };
    for (let i = 0; i < n; i++) spawn();
  });
  console.error(`done: ${ok}/${finished} solved in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${outFile}, ${unFile}`);
} else {
  const { analyze } = await import('../shared/analyze.js');
  const { Game } = await import('../shared/tak.js');
  const { maxPlies, maxNodes } = workerData;
  parentPort.on('message', (t) => {
    const t0 = Date.now();
    let a;
    try {
      // the author's line is a hint only; a plies hint deeper than maxPlies would blow the budget, so cap it
      const ap = t.authorLine.length;
      a = analyze(t.tps, { plies: ap && ap <= maxPlies && ap % 2 ? ap : undefined, line: t.authorLine, maxPlies, komi: t.komi, maxNodes });
    } catch (e) { a = { ok: false, reason: 'error: ' + e.message }; }
    const ms = Date.now() - t0;
    if (!a.ok) {
      const reason = a.reason === 'no forced win found' ? `no forced win within ${maxPlies} plies` : a.reason;
      return parentPort.postMessage({ id: t.id, ms, unsolved: { ...t, reason, nodes: a.nodes ?? null, plies: a.plies ?? null } });
    }
    // does our tree accept the author's first move? (canonicalize: authors write "a1+" / "1a1+1" interchangeably)
    let authorFirstAccepted = null;
    if (t.authorLine[0]) {
      try {
        const g = Game.fromTPS(t.tps, t.komi); const m = g.canon(t.authorLine[0]);
        authorFirstAccepted = a.tree === 'win' ? (() => { const me = g.toMove, u = g.apply(g.parseMove(m)); const r = g.result(); g.undo(u); return !!r && r.winner === me; })() : m in a.tree;
      } catch { authorFirstAccepted = false; }
    }
    parentPort.postMessage({
      id: t.id, ms,
      puzzle: {
        id: t.id, size: t.size, tps: t.tps, komi: t.komi, plies: a.plies, tree: a.tree, tags: a.tags, rating: a.rating,
        source: 'Ditaktic', sourceRef: t.sourceRef,
        meta: {
          difficulty: t.difficulty, rawDifficulty: t.rawDifficulty, kind: t.kind, authorLine: t.authorLine, authorPlies: t.authorLine.length,
          authorFirstAccepted, title: t.title, date: t.date, rootWins: a.rootWins, nodes: a.nodes, factors: a.factors, mainLine: a.mainLine,
          ...(t.solTpsMismatch ? { solTpsMismatch: true } : {}), ms,
        },
      },
    });
  });
}
