import fs from 'node:fs';
import { replay } from '../../shared/ptn.js';
import { analyze } from '../../shared/analyze.js';
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
for (const p of lines) {
  const { g } = replay(p.puzzleNotation);
  const t = Date.now();
  const a = analyze(g.toTPS(), { line: p.solution, maxPlies: 5 });
  console.log(p.puzzleId, p.puzzleSize, 'src', JSON.stringify(p.solution), '→', a.ok ? `${a.plies}ply wins=${a.rootWins} line=${a.mainLine.join(' ')} r=${a.rating} [${a.tags.join(',')}] nodes=${a.nodes}` : a.reason, (Date.now()-t)+'ms');
}
