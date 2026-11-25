// How well do puzzle ratings converge with a tiny player base? Simulates N players with hidden true
// skill solving puzzles whose hidden true difficulty = our prior + noise, then compares the error of
// (a) the prior alone, (b) online Glicko-2 (what the server does live), (c) the batch joint fit (rerate.mjs).
import { DatabaseSync } from 'node:sqlite';
import { rate, PLAYER_START } from '../shared/rating.js';
import { PUZZLE_START } from '../shared/glicko.js';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? +process.argv[i + 1] : d; };
const NU = arg('users', 25), PER = arg('per', 60), NOISE = arg('noise', 200);
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const db = new DatabaseSync('data/tinue.db', { readOnly: true });
const P = db.prepare('SELECT id, init_rating FROM puzzles').all().map((p) => ({ id: p.id, prior: p.init_rating, truth: p.init_rating + NOISE * gauss(), rating: p.init_rating, rd: PUZZLE_START.rd, vol: PUZZLE_START.vol, attempts: 0 }));
const U = Array.from({ length: NU }, (_, i) => ({ id: i, truth: 1500 + 350 * gauss(), ...PLAYER_START, games: 0 }));
const att = [];
for (let round = 0; round < PER; round++) for (const u of U) {
  // pick nearest unseen puzzle to the user's current rating (like /api/next), random among closest 24
  const seen = new Set(att.filter((a) => a.u === u.id).map((a) => a.p.id));
  const near = P.filter((p) => !seen.has(p.id)).sort((a, b) => Math.abs(a.rating - u.rating) - Math.abs(b.rating - u.rating)).slice(0, 24);
  const p = near[Math.floor(near.length * rnd() ** 2)];
  const win = rnd() < 1 / (1 + 10 ** ((p.truth - u.truth) / 400)) ? 1 : 0;
  const r = rate(u, p, win);
  Object.assign(u, r.user); u.games++; Object.assign(p, r.puzzle); p.attempts++;
  att.push({ u: u.id, p, win });
}
// joint MAP
const C = Math.LN10 / 400, SP = 250, SU = 350;
const R = new Map(P.map((p) => [p.id, p.prior])), UR = new Map(U.map((u) => [u.id, 1500]));
const byP = new Map(), byU = new Map();
for (const a of att) { (byP.get(a.p.id) || byP.set(a.p.id, []).get(a.p.id)).push(a); (byU.get(a.u) || byU.set(a.u, []).get(a.u)).push(a); }
for (let it = 0; it < 200; it++) {
  for (const [id, as] of byP) { const pr = as[0].p.prior; let g = -(R.get(id) - pr) / SP ** 2, h = -1 / SP ** 2; for (const a of as) { const q = 1 / (1 + Math.exp(C * (R.get(id) - UR.get(a.u)))); g += C * (q - a.win); h -= C * C * q * (1 - q); } R.set(id, R.get(id) - g / h); }
  for (const [uid, as] of byU) { let g = -(UR.get(uid) - 1500) / SU ** 2, h = -1 / SU ** 2; for (const a of as) { const q = 1 / (1 + Math.exp(C * (R.get(a.p.id) - UR.get(uid)))); g += C * (a.win - q); h -= C * C * q * (1 - q); } UR.set(uid, UR.get(uid) - g / h); }
}
const played = P.filter((p) => p.attempts > 0);
const rmse = (f) => Math.sqrt(played.reduce((s, p) => s + (f(p) - p.truth) ** 2, 0) / played.length);
const urmse = (f) => Math.sqrt(U.reduce((s, u) => s + (f(u) - u.truth) ** 2, 0) / U.length);
console.log(`${NU} players × ${PER} puzzles = ${att.length} attempts over ${played.length} distinct puzzles (avg ${(att.length / played.length).toFixed(1)} plays each); true noise around prior = ${NOISE}`);
console.log(`puzzle RMSE vs truth:  prior only ${rmse((p) => p.prior).toFixed(0)}   online Glicko ${rmse((p) => p.rating).toFixed(0)}   joint fit ${rmse((p) => R.get(p.id)).toFixed(0)}`);
console.log(`player RMSE vs truth:  online Glicko ${urmse((u) => u.rating).toFixed(0)}   joint fit ${urmse((u) => UR.get(u.id)).toFixed(0)}`);
