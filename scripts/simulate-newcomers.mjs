// How fast does a newcomer reach their level, and does it cost settled players anything? Compares the live rate()
// (shared/rating.js) with the rules before 2026-11-15 (start ± 250, vol 0.09). No database: each puzzle
// is served at the player's rating ± 40 (like /api/next at "normal"), its true difficulty = its rating ± noise.
// usage: node scripts/simulate-newcomers.mjs [--runs 400] [--noise 200] [--seed 1]
import { update, cap } from '../shared/glicko.js';
import { rate, PLAYER_START, DIFFICULTY } from '../shared/rating.js';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? +process.argv[i + 1] : d; };
const RUNS = arg('runs', 400), NOISE = arg('noise', 200), SEED = arg('seed', 1);

const RULES = {
  'before (± 250, plain Glicko)': { start: { rating: 1500, rd: 250, vol: 0.09 }, step: (u, p, win) => cap(update(u, p, win ? 1 : 0)) },
  [`now (± ${PLAYER_START.rd}, vol ${PLAYER_START.vol})`]: { start: PLAYER_START, step: (u, p, win) => rate(u, p, win).user },
};

function rng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { rnd, gauss: () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()) };
}
// One player of true strength T for n puzzles; pWin(i) overrides the win chance (hot streaks), offset = difficulty.
function play(rule, T, seed, n, { pWin, offset = 0, from } = {}) {
  const R = rng(seed); let u = { ...(from ?? rule.start) }; const tr = [];
  for (let i = 0; i < n; i++) {
    const r = u.rating + offset + (R.rnd() - 0.5) * 80, p = { rating: r, rd: 250, vol: 0.09 };
    const win = R.rnd() < (pWin?.(i) ?? 1 / (1 + 10 ** ((r + NOISE * R.gauss() - T) / 400)));
    const nu = rule.step(u, p, win);
    tr.push({ r: nu.rating, rd: nu.rd, vol: nu.vol, win, d: nu.rating - u.rating }); u = nu;
  }
  return tr;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
const seeds = (f) => Array.from({ length: RUNS }, (_, k) => f(SEED * 100003 + k));

console.log(`${RUNS} runs per cell, puzzle truth = rating ± ${NOISE}`);
console.log('reach = puzzles until first within 100 of true strength (median/p90); rmse after 20/50 puzzles; "?" = median puzzles until rd < 110');
for (const [name, rule] of Object.entries(RULES)) {
  console.log(name);
  for (const T of [1000, 1500, 1900, 2300, 2450, 2800]) {
    const trs = seeds((s) => play(rule, T, s + T, 100));
    const reach = trs.map((tr) => tr.findIndex((x) => Math.abs(x.r - T) < 100) + 1 || 999);
    const rmse = (n) => Math.sqrt(mean(trs.map((tr) => (tr[n - 1].r - T) ** 2))).toFixed(0);
    const prov = pct(trs.map((tr) => tr.findIndex((x) => x.rd < 110) + 1 || 999), 0.5);
    console.log(`  ${T}: reach ${String(pct(reach, 0.5)).padStart(2)}/${String(pct(reach, 0.9)).padStart(2)}  rmse ${rmse(20).padStart(3)}, ${rmse(50).padStart(3)}  "?" ${prov}`);
  }
  const climb = seeds((s) => play(rule, 2450, s, 10)), first = Array.from({ length: 10 }, (_, i) => mean(climb.map((tr) => tr[i].d)).toFixed(0));
  const settled = [1500, 1900, 2450].flatMap((T) => seeds((s) => play(rule, T, s + 7 * T, 150).slice(100))).flat();
  const w = settled.filter((x) => x.win).map((x) => x.d), l = settled.filter((x) => !x.win).map((x) => x.d);
  console.log(`  2450 newcomer, mean change on puzzles 1–10: ${first.join(' ')}`);
  console.log(`  settled (puzzles 100–150): win +${mean(w).toFixed(1)}, loss ${mean(l).toFixed(1)}, rd ${mean(settled.map((x) => x.rd)).toFixed(0)}`);
  // A settled 1800 has a 20-puzzle 70% hot streak, then plays normally: how far does the rating run, how fast does it return?
  const hs = seeds((s) => play(rule, 1800, s, 220, { pWin: (i) => (i >= 150 && i < 170 ? 0.7 : undefined) }));
  console.log(`  hot streak (1800, 20 at 70%): +${mean(hs.map((tr) => tr[169].r - 1800)).toFixed(0)} at its end, +${mean(hs.map((tr) => tr[194].r - 1800)).toFixed(0)} 25 later`);
  // "easiest" serves 600 below: the hold doesn't apply, so a streak of easy wins settles as before.
  const easy = seeds((s) => play(rule, 1500, s, 30, { offset: DIFFICULTY.easiest }));
  console.log(`  1500 on "easiest", after 30: ${mean(easy.map((tr) => tr[29].r)).toFixed(0)} ± ${mean(easy.map((tr) => tr[29].rd)).toFixed(0)}`);
}

// Accounts from before 2026-11-15 keep their stored volatility (0.09): does it drift toward the new 0.06 on its own?
{
  const rule = Object.values(RULES).at(-1), from = { rating: 1800, rd: 83, vol: 0.09 };
  const trs = seeds((s) => play(rule, 1800, s, 300, { from }));
  const w = trs.flatMap((tr) => tr.slice(200).filter((x) => x.win).map((x) => x.d));
  console.log(`\nexisting settled account (1800 ± 83, vol 0.09) after 300 more puzzles under the new rules: win +${mean(w).toFixed(1)}, rd ${mean(trs.map((tr) => tr.at(-1).rd)).toFixed(0)}, vol ${mean(trs.map((tr) => tr.at(-1).vol)).toFixed(4)}`);
}
