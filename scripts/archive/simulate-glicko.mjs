// Players with hidden true skill solve our real puzzle pool (puzzle truth = prior + noise).
// Compares the old shrinking-K Elo with Glicko-2 at several starting deviations:
// how fast a new player reaches their level, how noisy they are once there, and how well a small
// pool of players pins down puzzle ratings.
// usage: node scripts/simulate-glicko.mjs [--users 25] [--per 150] [--noise 200] [--seed 7]
import { DatabaseSync } from 'node:sqlite';
import * as G from '../../shared/glicko.js';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? +process.argv[i + 1] : d; };
const NU = arg('users', 25), PER = arg('per', 150), NOISE = arg('noise', 200), SEED = arg('seed', 7);
// The old shrinking-K Elo, kept here as the baseline.
const eloE = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));
const elo = (u, p, win) => { const e = eloE(u.rating, p.rating), uk = Math.max(12, 40 / (1 + u.games / 10)), pk = Math.max(6, 32 / (1 + p.attempts / 10)); return { userDelta: uk * (win - e), puzzleDelta: pk * (e - win) }; };
const db = new DatabaseSync('data/tinue.db', { readOnly: true });
const BASE = db.prepare('SELECT id, init_rating FROM puzzles WHERE size = 5').all();

function run(cfg) {
  let seed = SEED; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const P = BASE.map((p) => ({ prior: p.init_rating, truth: p.init_rating + NOISE * gauss(), rating: p.init_rating, rd: cfg.puzzleRd, vol: 0.09, attempts: 0 }));
  const U = Array.from({ length: NU }, () => ({ truth: 1500 + 350 * gauss(), rating: 1500, rd: cfg.userRd, vol: 0.09, games: 0, seen: new Set(), err: [], swing: [] }));
  for (let round = 0; round < PER; round++) for (const u of U) {
    const near = []; // closest unseen puzzles to the user's rating, random among 24 biased to closest
    for (const p of P) if (!u.seen.has(p)) near.push(p);
    near.sort((a, b) => Math.abs(a.rating - u.rating) - Math.abs(b.rating - u.rating));
    const p = near[Math.floor(Math.min(24, near.length) * rnd() ** 2)];
    u.seen.add(p);
    const win = rnd() < 1 / (1 + 10 ** ((p.truth - u.truth) / 400)) ? 1 : 0;
    const before = u.rating;
    if (cfg.elo) {
      const { userDelta, puzzleDelta } = elo(u, p, win);
      u.rating += userDelta; p.rating += puzzleDelta;
    } else {
      const nu = G.cap(G.update(u, p, win));
      let np = G.cap(G.update(p, u, 1 - win));
      if (cfg.cluelessSkip && u.rd >= 230) np = { rating: p.rating, rd: p.rd, vol: p.vol };
      if (cfg.puzzleFloor) np.rd = Math.max(cfg.puzzleFloor, np.rd);
      Object.assign(u, nu); Object.assign(p, np);
    }
    u.games++; p.attempts++;
    u.err.push(Math.abs(u.rating - u.truth)); u.swing.push(Math.abs(u.rating - before));
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const at = (n) => med(U.map((u) => u.err[n - 1])).toFixed(0).padStart(4);
  const settle = med(U.map((u) => { for (let i = 0; i < u.err.length; i++) if (u.err.slice(i, i + 10).every((e) => e < 120)) return i + 1; return PER + 1; }));
  const swing = med(U.flatMap((u) => u.swing.slice(-50))).toFixed(1);
  const played = P.filter((p) => p.attempts > 0);
  const prmse = (f) => Math.sqrt(played.reduce((s, p) => s + (f(p) - p.truth) ** 2, 0) / played.length).toFixed(0);
  console.log(`${cfg.name.padEnd(30)} err@5 ${at(5)} @10 ${at(10)} @20 ${at(20)} @50 ${at(50)} @${PER} ${at(PER)}  settle ${String(settle).padStart(3)}  late swing ${swing.padStart(5)}  puzzle RMSE ${prmse((p) => p.rating)} (prior ${prmse((p) => p.prior)})`);
}
console.log(`${NU} players (true skill 1500±350) × ${PER} puzzles each, 5×5 pool of ${BASE.length}, puzzle truth = prior ± ${NOISE}`);
console.log('err@N = median |rating − true skill| after N puzzles; settle = median puzzles until within 120 for 10 straight; late swing = median |change| per puzzle over the last 50');
run({ name: 'Elo (old)', elo: true });
for (const userRd of [500, 350, 250, 200, 150]) run({ name: `Glicko user rd ${userRd}, puzzle rd 250`, userRd, puzzleRd: 250 });
run({ name: 'Glicko 250 + Lichess clueless skip', userRd: 250, puzzleRd: 250, cluelessSkip: true });
run({ name: 'Glicko 250 + puzzle rd floor 100', userRd: 250, puzzleRd: 250, puzzleFloor: 100 });
run({ name: 'Glicko 250, puzzle rd 350', userRd: 250, puzzleRd: 350 });
