// Stage D ranking (what can be computed here) and the candidates file in the import row format.
//   node --no-warnings deep/mine/candidates.mjs --out=DIR [--from=E|C]
// Writes DIR/candidates.jsonl: id prefix `ph`, the puzzle fields import.mjs reads (id, size, tps, plies,
// tree, tags, source, sourceRef, rating, komi, meta) plus `cert` and `book`. Nothing is imported.
// Not computed (no tak-human here): -sum log P(key), the P(key) > 0.5 rejection, residual risk.
// Not computed: decoy ideas (deep cert does not report per-move refutation node counts yet).
import fs from 'node:fs';
import path from 'node:path';
import { arg, readJsonl, writeJsonl, idea } from './lib.mjs';

const OUT = arg('out'), FROM = arg('from', 'E');
const rows = new Map(readJsonl(path.join(OUT, 'rows.jsonl')).map((r) => [r.id, r]));
const B = new Map(readJsonl(path.join(OUT, 'stageB.jsonl')).map((c) => [c.id, c]));
const C = new Map(readJsonl(path.join(OUT, 'stageC.jsonl')).map((c) => [c.id, c]));
const E = new Map(readJsonl(path.join(OUT, 'stageE.jsonl')).map((c) => [c.id, c]));
const ids = [...C.values()].filter((c) => c.pass && (FROM !== 'E' || E.get(c.id)?.ok)).map((c) => c.id);
const out = [];
for (const id of ids) {
  const r = rows.get(id), b = B.get(id), c = C.get(id);
  const keyIdeas = new Set(b.nodes[0].keys.map(idea));
  const att = r.tps.split(' ')[1] === '1' ? 'white' : 'black';
  const played = (r.meta.gameLine || [])[0] || null;
  const missed = played ? !keyIdeas.has(idea(played)) : null;
  const ladderFrac = b.attMoves ? b.ladder / b.attMoves : 0;
  const scores = {
    rootLogNodes: c.d.rootNodesToKey ? +Math.log10(c.d.rootNodesToKey).toFixed(2) : null, // null: not found within the D budget
    hardestLogNodes: c.d.hardestNodesToKey ? +Math.log10(c.d.hardestNodesToKey).toFixed(2) : null,
    hardestR: c.d.hardestR,
    engineNeverFound: c.nodes.filter((n) => n.nodesToKey == null).map((n) => n.R),
    missedInGame: missed, missedBy: missed ? r.meta[att === 'white' ? 'white' : 'black'] : null, missedRating: missed ? r.meta[att === 'white' ? 'ratingWhite' : 'ratingBlack'] : null,
    defenceRichNodes: b.nodes.filter((n) => n.R >= 5 && n.defIdeas >= 3).length,
    quietKey: false, // stage A keeps threat keys only
    ladderSteps: b.ladder, ladderFrac: +ladderFrac.toFixed(2), rejectLadder: ladderFrac >= 1 / 3,
    takHuman: null, decoys: null,
  };
  const nodes = c.nodes.map((n) => ({ tps: n.tps, R: n.R, keys: n.keys, listedWins: n.listedWins, undecided: n.undecided, bestAlt: n.bestAlt, cooksC: n.cooks, nodesToKey: n.nodesToKey, p: null }));
  out.push({
    id: `ph${id.slice(2)}${id[1]}`, size: 6, tps: r.tps, plies: b.L, tree: JSON.parse(JSON.stringify(b.tree)), tags: [], source: r.source, sourceRef: r.source_ref,
    rating: null, komi: r.komi,
    meta: { ...r.meta, mainLine: b.line, prover: 'deep cert', from: id, collection: 'hard', unrated: true },
    cert: { tier: c.tier, L: b.L, exact: b.exact, cliff: c.cliff, maxAltP: c.maxAltP, nodes, risk: null, riskNote: 'tak-human not available: residual risk not computed', scores, bTimeout: b.status === 'timeout', verified: FROM === 'E' ? 'E' : 'C only' },
    book: b.book,
  });
}
// order: gold first, then by hardest engine node count (never found = hardest)
out.sort((x, y) => (x.cert.tier === y.cert.tier ? 0 : x.cert.tier === 'gold' ? -1 : 1) || ((y.cert.scores.hardestLogNodes ?? 99) - (x.cert.scores.hardestLogNodes ?? 99)));
writeJsonl(path.join(OUT, 'candidates.jsonl'), out);
console.log(JSON.stringify({ candidates: out.length, gold: out.filter((x) => x.cert.tier === 'gold').length, silver: out.filter((x) => x.cert.tier === 'silver').length, ladderRejects: out.filter((x) => x.cert.scores.rejectLadder).length }));
