// Batch re-rating: joint MAP fit of player and puzzle ratings from every rated first attempt.
//
//   P(solve) = 1 / (1 + 10^((R_puzzle - R_user)/400))           (same curve as online Elo)
//   R_puzzle ~ Normal(prior(features), SIGMA_P)                  (shrink toward the feature prior)
//   R_user   ~ Normal(1500, SIGMA_U)
//
// With few players, online Elo leaves puzzle ratings noisy for a long time. A joint fit uses every
// attempt to inform both sides at once, and the prior keeps lightly-played puzzles sensible.
// It also re-fits the prior's feature weights (ridge regression toward the hand-set weights of 1),
// so as data accumulates, brand-new puzzles start closer to where they'll end up.
//
// usage: node scripts/archive/rerate.mjs [--apply] [--sigma-p 250] [--sigma-u 350]
import { db } from '../../server/server.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const SIGMA_P = +arg('sigma-p', 250), SIGMA_U = +arg('sigma-u', 350);
const C = Math.LN10 / 400;

const puzzles = db.prepare('SELECT id, init_rating, rating, meta FROM puzzles').all();
const attempts = db.prepare('SELECT user_id, puzzle_id, win FROM attempts WHERE rated = 1').all();
const users = db.prepare('SELECT id, rating FROM users').all();
console.log(`${puzzles.length} puzzles, ${users.length} users, ${attempts.length} rated attempts`);

// ---- 1. re-fit prior feature weights (only meaningful once puzzles have real data) ----
const keys = ['base', 'options', 'stackMove', 'smash', 'quiet', 'defendFirst', 'throw', 'reveal', 'size', 'search'];
const feats = new Map(puzzles.map((p) => {
  const f = JSON.parse(p.meta || '{}').factors || { base: p.init_rating };
  return [p.id, keys.map((k) => f[k] || 0)];
}));
const playCount = new Map();
for (const a of attempts) playCount.set(a.puzzle_id, (playCount.get(a.puzzle_id) || 0) + 1);

let w = keys.map(() => 1);
const prior = (id) => feats.get(id).reduce((s, x, i) => s + w[i] * x, 0);

// ---- 2. joint MAP by gradient ascent ----
const R = new Map(puzzles.map((p) => [p.id, prior(p.id)]));
const U = new Map(users.map((u) => [u.id, 1500]));
const byPuzzle = new Map(), byUser = new Map();
for (const a of attempts) {
  (byPuzzle.get(a.puzzle_id) || byPuzzle.set(a.puzzle_id, []).get(a.puzzle_id)).push(a);
  (byUser.get(a.user_id) || byUser.set(a.user_id, []).get(a.user_id)).push(a);
}

function fit(iters = 300) {
  for (let it = 0; it < iters; it++) {
    // Newton-ish coordinate updates (each is a 1-D concave problem)
    for (const [id, as] of byPuzzle) {
      let g = -(R.get(id) - prior(id)) / SIGMA_P ** 2, h = -1 / SIGMA_P ** 2;
      for (const a of as) {
        const p = 1 / (1 + Math.exp(C * (R.get(id) - U.get(a.user_id)))); // P(user solves)
        g += C * (p - a.win); h -= C * C * p * (1 - p);
      }
      R.set(id, R.get(id) - g / h);
    }
    for (const [uid, as] of byUser) {
      let g = -(U.get(uid) - 1500) / SIGMA_U ** 2, h = -1 / SIGMA_U ** 2;
      for (const a of as) {
        const p = 1 / (1 + Math.exp(C * (R.get(a.puzzle_id) - U.get(uid))));
        g += C * (a.win - p); h -= C * C * p * (1 - p);
      }
      U.set(uid, U.get(uid) - g / h);
    }
  }
}

fit();
// Ridge-refit weights on puzzles with >= 5 plays, then refit ratings with the new prior.
const trained = puzzles.filter((p) => (playCount.get(p.id) || 0) >= 5);
if (trained.length >= 50) {
  const lambda = 20; // pulls weights toward 1 (the hand-set prior)
  const n = keys.length;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? lambda : 0)));
  const b = Array.from({ length: n }, () => lambda);
  for (const p of trained) {
    const x = feats.get(p.id).map((v) => v / 100); // scale for conditioning
    const y = R.get(p.id) / 100;
    for (let i = 0; i < n; i++) { b[i] += x[i] * y; for (let j = 0; j < n; j++) A[i][j] += x[i] * x[j]; }
  }
  // Gaussian elimination
  for (let i = 0; i < n; i++) {
    let m = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[m][i])) m = k;
    [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
    for (let k = i + 1; k < n; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j < n; j++) A[k][j] -= f * A[i][j]; b[k] -= f * b[i]; }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
  w = x;
  console.log('refit prior weights:', Object.fromEntries(keys.map((k, i) => [k, +w[i].toFixed(2)])));
  fit();
} else console.log(`prior weights unchanged (need >= 50 puzzles with >= 5 plays; have ${trained.length})`);

const moved = puzzles.map((p) => ({ id: p.id, from: p.rating, to: R.get(p.id), plays: playCount.get(p.id) || 0 }))
  .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
console.log('biggest puzzle moves:', moved.slice(0, 8).map((m) => `${m.id} ${Math.round(m.from)}→${Math.round(m.to)} (${m.plays} plays)`).join(', '));

if (APPLY) {
  db.exec('BEGIN');
  const up = db.prepare('UPDATE puzzles SET rating = ? WHERE id = ?');
  for (const p of puzzles) up.run(R.get(p.id), p.id);
  // users keep their online rating (it's what they see move); log the fitted value for comparison
  db.exec('COMMIT');
  console.log('applied puzzle ratings');
} else console.log('dry run — pass --apply to write puzzle ratings');
