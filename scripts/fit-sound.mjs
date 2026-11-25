// Fit move-sound recipes (public/sound.js's format) to a recording of real pieces being placed.
//   node scripts/fit-sound.mjs take.wav [--out dir] [--min-gap ms] [--modes n] [--against sound[:voice]] [--channel c]
// Input: a WAV (16/24/32-bit PCM or 32-bit float, any rate) holding one or several takes (a piece placed, then quiet,
// then the next...). Of a stereo file the louder channel is fitted (--channel 0, 1 or mix to choose): two microphones a
// few cm apart, mixed, comb-filter the sound. DC and rumble under 60 Hz (handling noise) are removed first. For each
// take it finds the onset, cuts it, and estimates a recipe:
//   - the events: the first impact and any later contact (a bounce, a settle, a smash's second impact), found as
//     jumps in the energy above 2.5 kHz, where the contact noise lives and the modes have mostly died;
//   - per event, the modes: peaks of the spectrum after the contact, then their frequencies, decays (T60) and
//     amplitudes refined together by least squares on the waveform (variable projection: amplitudes solved exactly
//     for each trial of frequencies and decays); earlier events' modes are subtracted before fitting a later one;
//   - the body: the lowest fitted mode under 450 Hz within 6 dB of the strongest there;
//   - the contact: what the modes leave unexplained around the onset: its length from its energy centroid, its band
//     from where its spectrum falls 6 dB under its plateau, its level as the RMS.
// It renders each recipe (and the average recipe of all takes) and reports a log-spectrogram distance to the
// recording (the mean absolute difference, dB, of band energies in 2 ms frames, both at equal total energy, over the
// cells within 30 dB of the loudest), and beside it what that number can hide: the band shares and centroid of the
// recording against the resynthesis, and the recording's strongest spectral peaks with the fitted mode that matches each
// (a warning when one of the 3 strongest has none). It warns when a take looks like several pieces landing (more than
// 2 events, or over 150 ms of sound: record them further apart or lower --min-gap), when bursts of contact noise
// outnumber the takes found, and averages only the takes with the most common number of events. It writes
// <name>.recipe.json (the takes' recipes, the average one and the distances) and <name>.fit.wav (every take
// resynthesized at its own onset) beside the input or into --out. --against flatBoard (or flatBoard:deep, any sound of
// public/sound.js) also reports how far that sound, as it is now, is from each take: the distance before fitting.
// No dependencies: a plain FFT and small dense solves.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderRecipe, loudness, SOUNDS } from '../public/sound.js';

// ---- WAV ----
// channel: 'auto' (the louder channel; the default), 'mix' (the mean of all), or a channel's index.
export function readWav(file, { channel = 'auto' } = {}) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(file + ': not a WAV');
  let o = 12, fmt = -1, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = o + 8;
    if (id === 'data') { data = [o + 8, Math.min(n, b.length - o - 8)]; break; }
    o += 8 + n + (n & 1);
  }
  if (fmt < 0 || !data) throw new Error(file + ': no fmt/data chunk');
  let code = b.readUInt16LE(fmt);
  const ch = b.readUInt16LE(fmt + 2), sr = b.readUInt32LE(fmt + 4), bits = b.readUInt16LE(fmt + 14);
  if (code === 0xfffe) code = b.readUInt16LE(fmt + 24); // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes
  const bps = bits / 8, n = Math.floor(data[1] / (bps * ch)), x = new Float64Array(n);
  const rd = (p) => code === 3 ? (bits === 64 ? b.readDoubleLE(p) : b.readFloatLE(p)) : bits === 16 ? b.readInt16LE(p) / 32768
    : bits === 24 ? b.readIntLE(p, 3) / 8388608 : bits === 32 ? b.readInt32LE(p) / 2147483648 : (b.readUInt8(p) - 128) / 128;
  const chans = Array.from({ length: ch }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) chans[c][i] = rd(data[0] + (i * ch + c) * bps);
  let used = channel;
  if (ch === 1) used = 0;
  // (ranked after clean(): a constant offset or rumble on an otherwise silent channel must not outweigh a tap)
  else if (channel === 'auto') { const en = chans.map((y) => clean(y, sr).reduce((s, v) => s + v * v, 0)); used = en.indexOf(Math.max(...en)); }
  if (used === 'mix') for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += chans[c][i]; x[i] = s / ch; }
  else { used = Number(used); if (!(used >= 0 && used < ch)) throw new Error(`${file}: no channel ${channel} (it has ${ch})`); x.set(chans[used]); }
  return { x, sr, channels: ch, channel: used };
}
export function wav16(x, sr) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + 2 * i);
  return b;
}

// ---- spectra ----
export function fft(re, im) { // in place, length a power of two
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < h; j++) {
        const k = i + j + h, vr = re[k] * cr - im[k] * ci, vi = re[k] * ci + im[k] * cr;
        re[k] = re[i + j] - vr; im[k] = im[i + j] - vi; re[i + j] += vr; im[i + j] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const pow2 = (n) => { let N = 1; while (N < n) N <<= 1; return N; };
// Power spectrum of x (zero-padded to N), bins 0..N/2.
export function power(x, N = pow2(x.length)) {
  const re = new Float64Array(N), im = new Float64Array(N);
  re.set(x.length > N ? x.subarray(0, N) : x);
  fft(re, im);
  const P = new Float64Array(N / 2 + 1);
  for (let i = 0; i <= N / 2; i++) P[i] = re[i] * re[i] + im[i] * im[i];
  return P;
}
// A filter applied in the frequency domain: gain(f) on the spectrum (zero phase).
function zfilter(x, sr, gain) {
  const N = pow2(2 * x.length), re = new Float64Array(N), im = new Float64Array(N);
  re.set(x); fft(re, im);
  for (let i = 0; i < N; i++) { const g = gain((Math.min(i, N - i) * sr) / N); re[i] *= g; im[i] = -im[i] * g; }
  fft(re, im);
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = re[i] / N;
  return y;
}
const highpass = (fc) => (f) => 1 / Math.sqrt(1 + (fc / Math.max(f, 1e-9)) ** 8);
// A recording made ready to fit: no DC, nothing under 70 Hz (a 2nd-order Butterworth high-pass run forwards and back,
// twice: 8th-order, zero phase, any length; -0.4 dB at 150 Hz, -30 dB at 30 Hz): handling rumble would otherwise merge
// takes and be fitted as modes.
export function clean(x, sr) {
  let m = 0;
  for (const v of x) m += v;
  m /= x.length || 1;
  const y = Float64Array.from(x, (v) => v - m), w = (2 * Math.PI * 70) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
  const b0 = (1 + c) / 2 / (1 + al), b1 = -(1 + c) / (1 + al), a1 = (-2 * c) / (1 + al), a2 = (1 - al) / (1 + al);
  for (const dir of [1, -1, 1, -1]) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let k = 0; k < y.length; k++) { const i = dir > 0 ? k : y.length - 1 - k, v = y[i], o = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
  }
  return y;
}
const db = (p) => 10 * Math.log10(Math.max(p, 1e-30));
// RMS envelope in frames of `ms`.
function envelope(x, sr, ms) {
  const w = Math.max(1, Math.round((ms * sr) / 1000)), e = new Float64Array(Math.ceil(x.length / w));
  for (let j = 0; j < e.length; j++) { let s = 0; const a = j * w, b = Math.min(x.length, a + w); for (let i = a; i < b; i++) s += x[i] * x[i]; e[j] = Math.sqrt(s / Math.max(1, b - a)); }
  return { e, w };
}

// ---- takes ----
// The takes of a recording: [start, end) sample ranges around each burst of sound separated by >= minGap ms of quiet.
export function findTakes(x, sr, { minGap = 150, pre = 1, post = 10, maxMs = 600 } = {}) {
  const { e, w } = envelope(x, sr, 1), sorted = Float64Array.from(e).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0, peak = sorted[sorted.length - 1] || 0;
  if (!(peak > 0)) return [];
  const thr = Math.max(floor * 6, peak * 10 ** (-45 / 20)); // active: 15 dB over the floor and within 45 dB of the loudest
  const runs = [];
  for (let j = 0; j < e.length; j++) {
    if (e[j] <= thr) continue;
    const last = runs.at(-1);
    if (last && j - last[1] <= minGap) last[1] = j; else runs.push([j, j]);
  }
  // A clip with no quiet in it (one take trimmed tight: its 10th-percentile frame is part of the ring, so the floor
  // rule finds nothing): no longer than a take, it is one take.
  if (!runs.length && x.length <= (maxMs * sr) / 1000) runs.push([0, e.length - 1]);
  return runs.map(([a, b]) => {
    // the onset: the first sample (from 2 ms before the first active frame) above 20 dB under that take's peak / 10
    let pk = 0;
    for (let i = a * w; i < Math.min(x.length, (b + 1) * w); i++) pk = Math.max(pk, Math.abs(x[i]));
    let i = Math.max(0, a * w - Math.round(0.002 * sr));
    while (i < x.length && Math.abs(x[i]) < pk * 0.03) i++;
    const s = Math.max(0, i - Math.round((pre * sr) / 1000));
    return [s, Math.min(x.length, (b + 1) * w + Math.round((post * sr) / 1000), s + Math.round((maxMs * sr) / 1000))];
  }).filter(([s, t]) => t - s > 0.004 * sr);
}

// Event onsets inside a take (sample offsets): jumps of >= 6 dB in the 0.5 ms energy above 2.5 kHz against the
// quietest of the 3 ms before, at least 8 ms apart, within 30 dB of the take's strongest such burst.
export function findEvents(y, sr) {
  const hp = zfilter(y, sr, highpass(Math.min(2500, sr / 5))), { e, w } = envelope(hp, sr, 0.5);
  let pk = 0;
  for (const v of e) pk = Math.max(pk, v);
  const back = Math.round(3 / 0.5), gap = Math.round(8 / 0.5), out = [0];
  // the first event is the take's onset (the cut starts 1 ms before it)
  let first = 0;
  while (first < e.length && e[first] < pk * 0.1) first++;
  out[0] = Math.max(0, first * w - Math.round(0.0005 * sr));
  let last = first;
  for (let j = first + gap; j < e.length - 1; j++) {
    if (e[j] < pk * 10 ** (-30 / 20) || e[j] < e[j + 1] || j - last < gap) continue;
    let lo = Infinity;
    for (let k = Math.max(0, j - back); k < j; k++) lo = Math.min(lo, e[k]);
    if (e[j] > 2 * lo) { // +6 dB
      let k = j; while (k > j - 3 && e[k - 1] > 1.5 * lo && e[k - 1] < e[k]) k--; // back to where the rise starts (1.5 ms at most)
      out.push(k * w); last = j;
    }
  }
  return out;
}

// ---- modes by variable projection ----
// Spectral peaks of y over [a, b) (a cosine taper on its last quarter against truncation sidelobes): local maxima
// that stand at least 4 dB over the lowest point between them and the next higher peak (or 15% away, at least
// 2.5 / the stretch's length in Hz) on each side,
// within 30 dB of the strongest; [f, dB] strongest first.
function peaks(y, sr, a, b, fmin, fmax) {
  const seg = Float64Array.from(y.subarray(a, b)), n = seg.length, t = Math.floor(n / 4);
  for (let i = 0; i < t; i++) seg[n - t + i] *= 0.5 * (1 + Math.cos((Math.PI * i) / t));
  const M = Math.max(1 << 15, pow2(n * 4)), P = power(seg, M), df = sr / M, L = Array.from(P, db), out = [];
  const reach = (i) => Math.max(0.15 * i, (2.5 * sr) / n / df); // 15%, or 2.5 / (the stretch's length) at low f
  for (let i = Math.max(2, Math.ceil(fmin / df)); i < fmax / df; i++) {
    if (!(L[i] > L[i - 1] && L[i] >= L[i + 1])) continue;
    let ok = true;
    for (const dir of [-1, 1]) {
      let lo = L[i];
      for (let k = i + dir; k > 0 && k < L.length - 1 && Math.abs(k - i) < reach(i); k += dir) { if (L[k] > L[i]) break; lo = Math.min(lo, L[k]); }
      if (L[i] - lo < 4) ok = false;
    }
    if (ok) { const d = L[i - 1] - 2 * L[i] + L[i + 1], off = d < 0 ? (0.5 * (L[i - 1] - L[i + 1])) / d : 0; out.push([(i + off) * df, L[i]]); }
  }
  const top = Math.max(...out.map((c) => c[1]));
  return out.filter((c) => c[1] > top - 30).sort((p, q) => q[1] - p[1]);
}

// Solve the symmetric positive system G c = r (Cholesky; G is C x C as rows), with a small ridge.
function chol(G, r, ridge) {
  const C = r.length, L = G.map((row) => Float64Array.from(row));
  let tr = 0;
  for (let i = 0; i < C; i++) tr += G[i][i];
  // a ridge (1e-3 of the mean diagonal, or ridge[i] times that): no pair of near-equal columns can cancel each other
  // with huge amplitudes
  for (let i = 0; i < C; i++) L[i][i] += 1e-3 * (ridge ? ridge[i] : 1) * (tr / C) + 1e-30;
  for (let j = 0; j < C; j++) {
    let d = L[j][j];
    for (let k = 0; k < j; k++) d -= L[j][k] * L[j][k];
    d = Math.sqrt(Math.max(d, 1e-30)); L[j][j] = d;
    for (let i = j + 1; i < C; i++) { let s = L[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]; L[i][j] = s / d; }
  }
  const z = new Float64Array(C), c = new Float64Array(C);
  for (let i = 0; i < C; i++) { let s = r[i]; for (let k = 0; k < i; k++) s -= L[i][k] * z[k]; z[i] = s / L[i][i]; }
  for (let i = C - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < C; k++) s -= L[k][i] * c[k]; c[i] = s / L[i][i]; }
  return c;
}

// Fit modes shared by the events of one take: every event (onset ats[e]) strikes the same modes (frequency, T60)
// again with its own amplitudes and phases. The fit uses the samples of y from ats[0] to the end, each event's first
// skips[e] samples (its contact) at a lower weight. Candidates come from spectral peaks; every mode's
// frequency and T60 are refined by coordinate search with all amplitudes solved by least squares at each trial
// (variable projection); then peaks left in the residual are added (twice at most) and refined. Modes ringing
// shorter than 1.5 x skips[0] are left to the contact, and a mode that ends pinned at that limit is dropped (it was
// fitting the contact's tail). Returns { modes: [{ f, ms }], amps: [event][mode] { gain,
// phase } (gain: the amplitude at that event's onset, signed by its sine part) }.
export function fitShared(y, sr, ats, skips, opts = {}) {
  let { maxModes = 12, fmin = 60, fmax } = opts;
  // the samples: from the first onset on; inside an event's first skips[e] samples (its contact) at weight EARLY,
  // so the modes still may not claim more than is there at the onset, without having to explain the contact noise
  const E = ats.length, N = y.length, idx = [], wt = [], EARLY = opts.early ?? 0.3;
  for (let i = ats[0]; i < N; i++) { let w = 1; for (let e = 0; e < E; e++) if (i >= ats[e] && i < ats[e] + skips[e]) w = EARLY; idx.push(i); wt.push(Math.sqrt(w)); }
  const M = idx.length, minT60 = Math.max(4, (1.5 * skips[0] * 1000) / sr);
  if (M - skips[0] < 0.004 * sr) return { modes: [], amps: ats.map(() => []) };
  fmax = Math.min(fmax || 8000, 0.45 * sr);
  const Y = Float64Array.from(idx, (i, j) => y[i] * wt[j]), yy = Y.reduce((s, v) => s + v * v, 0);
  const cols = (f, t60) => { // 2E columns over idx; event e's decay counted from ats[e] + skips[e] (well conditioned)
    const a = Math.log(1000) / ((t60 * sr) / 1000), w = (2 * Math.PI * f) / sr, out = [];
    for (let e = 0; e < E; e++) {
      const s = new Float64Array(M), c = new Float64Array(M), ref = ats[e] + skips[e];
      for (let j = 0; j < M; j++) { const i = idx[j]; if (i < ats[e]) continue; const n = i - ats[e], d = wt[j] * Math.exp(-a * (i - ref)); s[j] = d * Math.sin(w * n); c[j] = d * Math.cos(w * n); }
      out.push(s, c);
    }
    return out;
  };
  const sep = (f) => Math.max(0.03 * f, (0.6 * sr) / M); // closer modes than this cannot be told apart here
  const dot = (p, q) => { let s = 0; for (let j = 0; j < M; j++) s += p[j] * q[j]; return s; };
  // a later event's amplitudes overlap the earlier events' in time: a heavier ridge on them, so a bounce takes only
  // what the first strike cannot explain (no large pair of amplitudes cancelling across events)
  const rid = (C) => Float64Array.from({ length: C }, (_, p) => (Math.floor(p / 2) % E ? 30 : 1));
  const solveC = (G, R) => chol(G, R, rid(R.length));
  // |Y - Bc|^2 = yy - 2 c.R + c.G.c (exact also with the ridge's c)
  const resid = (G, R, c) => { let v = yy; for (let p = 0; p < c.length; p++) { let g = 0; for (let q = 0; q < c.length; q++) g += G[p][q] * c[q]; v += c[p] * (g - 2 * R[p]); } return v; };
  let modes = [], B = [], G = [], R = [], best = Infinity;
  const evalWith = (k, nc) => { // residual if mode k's columns were nc (G and R updated in copies)
    const C = B.length, G2 = G.map((row) => Float64Array.from(row)), R2 = Float64Array.from(R), B2 = B.slice();
    for (let u = 0; u < 2 * E; u++) B2[2 * E * k + u] = nc[u];
    for (let u = 0; u < 2 * E; u++) { const p = 2 * E * k + u; R2[p] = dot(nc[u], Y); for (let q = 0; q < C; q++) { const v = dot(nc[u], B2[q]); G2[p][q] = v; G2[q][p] = v; } }
    const c = solveC(G2, R2);
    return { r: resid(G2, R2, c), G2, R2, B2, c };
  };
  const rebuild = () => {
    B = modes.flatMap((m) => cols(m.f, m.ms)); const C = B.length;
    G = Array.from({ length: C }, () => new Float64Array(C)); R = new Float64Array(C);
    for (let p = 0; p < C; p++) { R[p] = dot(B[p], Y); for (let q = p; q < C; q++) { const v = dot(B[p], B[q]); G[p][q] = v; G[q][p] = v; } }
    best = resid(G, R, solveC(G, R));
  };
  const tryMode = (k, f, t60) => {
    if (!(f > fmin * 0.8 && f < fmax * 1.1 && t60 >= minT60 && t60 < 2000)) return false;
    if (modes.some((m, j) => j !== k && Math.abs(m.f - f) < sep(f))) return false; // two modes on one peak
    const t = evalWith(k, cols(f, t60));
    if (t.r < best) { best = t.r; G = t.G2; R = t.R2; B = t.B2; modes[k] = { f, ms: t60 }; return true; }
    return false;
  };
  const refine = (ks) => {
    for (const k of ks) for (const t of [6, 10, 15, 22, 30, 45, 60, 90, 130, 200]) tryMode(k, modes[k].f, Math.max(t, minT60));
    for (let step = 0.08; step > 0.002; step *= 0.5)
      for (let rnd = 0; rnd < 2; rnd++)
        for (let k = 0; k < modes.length; k++) {
          const fs = 0.25 * step * modes[k].f;
          if (!tryMode(k, modes[k].f + fs, modes[k].ms)) tryMode(k, modes[k].f - fs, modes[k].ms);
          if (!tryMode(k, modes[k].f, modes[k].ms * (1 + step))) tryMode(k, modes[k].f, modes[k].ms / (1 + step));
        }
  };
  // candidates from the stretch before the second event (or the whole take when that is under 15 ms)
  const a0 = ats[0] + skips[0], b0 = E > 1 && ats[1] - a0 > 0.015 * sr ? ats[1] : N, init = Math.max(30, minT60);
  const p0 = peaks(y, sr, a0, b0, fmin, fmax), top = p0[0]?.[1] ?? 0;
  // and from the first 6 ms after the contact: a short, high mode (a wall's, a clack's) is gone from the long stretch's
  // spectrum but stands out here (at a coarser resolution)
  const e0 = Math.min(b0, a0 + Math.round(0.006 * sr)), pe = !opts.noEarly && e0 - a0 > 0.002 * sr ? peaks(y, sr, a0, e0, Math.max(fmin, 1500), fmax) : [];
  for (const c of pe.filter(([, l]) => l > (pe[0]?.[1] ?? 0) - 15)) if (!p0.some(([f]) => Math.abs(f - c[0]) < Math.max(sep(c[0]), (1.5 * sr) / (e0 - a0)))) p0.push(c);
  // and the stretch's strongest peaks as a smoothed spectrum shows them, where peaks() has nothing near: on a short take
  // it can find no dip deep enough between close partials and miss exactly the ones that carry the sound
  const miss = strongest(y.subarray(a0, b0), sr, 4).filter(([f]) => f >= fmin && f <= fmax && !p0.some(([g]) => Math.abs(g - f) < 0.06 * f));
  if (miss.length) p0.splice(Math.max(0, Math.min(p0.length, maxModes - miss.length)), 0, ...miss);
  modes = p0.slice(0, maxModes).map(([f]) => ({ f, ms: init }));
  if (!modes.length) return { modes: [], amps: ats.map(() => []) };
  rebuild(); refine(modes.map((_, k) => k));
  for (let pass = 0; pass < 2 && modes.length < maxModes; pass++) {
    const c = solveC(G, R), r = Float64Array.from(y);
    for (let j = 0; j < M; j++) { let m = 0; for (let p = 0; p < B.length; p++) m += c[p] * B[p][j]; r[idx[j]] -= m / wt[j]; }
    const add = peaks(r, sr, a0, b0, fmin, fmax).filter(([f, l]) => l > top - 25 && !modes.some((m) => Math.abs(m.f - f) < sep(f))).slice(0, maxModes - modes.length);
    if (!add.length) break;
    const k0 = modes.length;
    modes.push(...add.map(([f]) => ({ f, ms: init })));
    rebuild(); refine(modes.map((_, k) => k).slice(k0));
  }
  const c = solveC(G, R);
  let amps = ats.map((at, e) => modes.map((m, k) => {
    const s = c[2 * E * k + 2 * e], q = c[2 * E * k + 2 * e + 1], g = Math.hypot(s, q), up = 1000 ** ((skips[e] * 1000) / sr / m.ms);
    return { gain: (s < 0 ? -g : g) * up, phase: Math.atan2(q, s), g0: g };
  }));
  // drop the negligible: a mode whose energy over the fit (~ g0^2 T60, its strongest event) is 35 dB under the strongest
  const en = modes.map((m, k) => Math.max(...amps.map((a) => a[k].g0 ** 2)) * m.ms), emax = Math.max(...en);
  const keep = modes.map((_, k) => k).filter((k) => en[k] > emax * 10 ** -3.5 && modes[k].ms > 1.03 * minT60).sort((p, q) => modes[p].f - modes[q].f);
  return { modes: keep.map((k) => modes[k]), amps: amps.map((a) => keep.map((k) => ({ gain: a[k].gain, phase: a[k].phase }))) };
}
// Single-event convenience: [{ f, ms, gain, phase }].
export function fitModes(y, sr, at, from, opts) {
  const r = fitShared(y, sr, [at], [from - at], opts);
  return r.modes.map((m, k) => ({ ...m, ...r.amps[0][k] }));
}
// The signal of fitted modes struck at sample `at` (amplitudes { gain, phase }), over a buffer of length N.
function modesSignal(N, sr, at, modes, amps) {
  const y = new Float64Array(N);
  modes.forEach((m, k) => {
    const a = Math.log(1000) / ((m.ms * sr) / 1000), w = (2 * Math.PI * m.f) / sr, ph = amps[k].phase ?? 0, g = Math.abs(amps[k].gain);
    for (let i = at; i < N; i++) { const n = i - at, d = g * Math.exp(-a * n); if (d < 1e-9) break; y[i] += d * Math.sin(w * n + ph); }
  });
  return y;
}

// The impulse response of the recipe's contact band (2nd-order Butterworth high-pass at lo twice, low-pass at hi
// twice, as public/sound.js filters it), over `len` samples.
function bandIR(sr, lo, hi, len) {
  const h = new Float64Array(len); h[0] = 1;
  const edge = (type, f) => {
    const w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
    const b0 = type === 'lp' ? (1 - c) / 2 : (1 + c) / 2, b1 = type === 'lp' ? 1 - c : -(1 + c), a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < len; i++) { const x = h[i], y = (b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x; y2 = y1; y1 = y; h[i] = y; }
  };
  const nyq = 0.45 * sr; hi = Math.min(hi || nyq, nyq); lo = Math.min(lo || 0, hi / 2);
  if (lo > 20) { edge('hp', lo); edge('hp', lo); }
  if (hi < nyq) { edge('lp', hi); edge('lp', hi); }
  return h;
}
// The contact of an event at `at` from the residual r (what the modes leave). Band: third-octave spectrum of its
// first 6 ms, the edges where it falls 6 dB under its plateau. Length: the recipe's envelope (u^2 e^(2(1-u)),
// u = t / (ms/5)) smeared by that band's filters, fitted to the residual's 0.125 ms RMS envelope over the first
// 15 ms (or up to the next event). Level: its RMS over its length.
export function fitContact(r, sr, at, until) {
  const end = Math.min(r.length, until ?? r.length, at + Math.round(0.015 * sr));
  if (end - at < 8) return null;
  const seg = r.subarray(at, Math.min(end, at + Math.round(0.006 * sr))), M = 1 << 14, P = power(seg, M), df = sr / M;
  const bands = []; // third octaves from 100 Hz
  for (let f = 100; f < 0.45 * sr; f *= 2 ** (1 / 3)) { let s = 0, c = 0; for (let i = Math.round(f / 2 ** (1 / 6) / df); i < (f * 2 ** (1 / 6)) / df && i < P.length; i++) { s += P[i]; c++; } bands.push([f, db(s / Math.max(1, c))]); }
  const plateau = bands.map((b) => b[1]).sort((a, b) => b - a).slice(0, Math.max(3, Math.round(bands.length / 4)));
  const ref = plateau[Math.floor(plateau.length / 2)] - 6;
  let li = bands.findIndex((b) => b[1] >= ref), hi = bands.length - 1;
  while (hi > 0 && bands[hi][1] < ref) hi--;
  const lo = Math.round(li > 0 ? bands[li][0] / 2 ** (1 / 6) : 0), hiHz = Math.round(bands[Math.max(li, hi)][0] * 2 ** (1 / 6));
  const w = Math.max(2, Math.round(0.000125 * sr)), env = [];
  for (let i = at; i + w <= end; i += w) { let q = 0; for (let j = i; j < i + w; j++) q += r[j] * r[j]; env.push(Math.sqrt(q / w)); }
  if (!(Math.max(...env) > 0)) return null;
  const h2 = bandIR(sr, lo, hiHz, Math.round(0.008 * sr)).map((v) => v * v), L = end - at;
  let ms = 3, bestE = Infinity;
  for (let m = 0.4; m <= 15; m *= 1.04) {
    const n = Math.max(4, Math.round((m * sr) / 1000)), tp = n / 5, e2 = new Float64Array(L);
    for (let i = 0; i < Math.min(n, L); i++) { const u = i / tp; e2[i] = (u * u * Math.exp(2 * (1 - u))) ** 2; }
    const x = new Float64Array(L); // expected energy: env^2 convolved with h^2
    for (let i = 0; i < L; i++) { if (!e2[i]) continue; for (let k = 0; k < h2.length && i + k < L; k++) x[i + k] += e2[i] * h2[k]; }
    const mod = env.map((_, j) => { let q = 0; for (let i = j * w; i < j * w + w; i++) q += x[i]; return Math.sqrt(q / w); });
    let mm = 0, my = 0;
    for (let j = 0; j < env.length; j++) { mm += mod[j] * mod[j]; my += mod[j] * env[j]; }
    const g = my / (mm || 1); let e = 0;
    for (let j = 0; j < env.length; j++) e += (env[j] - g * mod[j]) ** 2;
    if (e < bestE) { bestE = e; ms = m; }
  }
  const n = Math.max(4, Math.round((ms * sr) / 1000));
  let ss = 0;
  for (let i = at; i < Math.min(r.length, at + n); i++) ss += r[i] * r[i];
  // (x 1.25: on the recipe's own bursts the RMS so measured comes out 0.8 of the gain that made them: the soft
  // ceiling and the share of the band filters' tail that falls after the window)
  return { ms: +ms.toFixed(2), lo, hi: hiHz, gain: +(1.25 * Math.sqrt(ss / n)).toFixed(5) };
}

const round = (v, d) => +v.toFixed(d);
// One take -> a recipe (gains in the recording's units; level its loudness). The modes are fitted jointly over
// all its events; each event gets its own contact and its own amplitudes of them; the body is the lowest mode under
// 450 Hz within 6 dB of the strongest there.
// The first event's contact is left out of the mode fit (skipMs). 4 ms suits a flat's broad contact but hides most of a
// mode that rings 8-10 ms (a wall's, a clack's); so unless opts.skipMs is given, the take is fitted leaving out 4 ms and
// 1.5 ms, and the 1.5 ms fit is kept when the contact it finds is short (under 2.5 ms) and it is nearer the take by
// over 0.4 dB (distance). (On a broad contact, 1.5 ms lets the contact's tail into the modes: a body ringing far too long.)
export function fitTake(y, sr, opts = {}) {
  const ats = findEvents(y, sr);
  if (opts.skipMs != null) return fitTakeWith(y, sr, ats, opts.skipMs, opts);
  let best = null;
  for (const ms of [4, 1.5]) {
    const r = fitTakeWith(y, sr, ats, ms, opts), off = Math.round((r._start * sr) / 1000), { _start, ...rec } = r;
    const d = distance(y.subarray(off), sr, renderRecipe(rec, sr, { raw: true }));
    if (!best || (d < best.d - 0.4 && r.events[0].contact?.ms < 2.5)) best = { r, d };
  }
  return best.r;
}
function fitTakeWith(y, sr, ats, skipMs, opts) {
  const skips = ats.map((_, e) => Math.round(((e ? Math.min(2.5, skipMs) : skipMs) * sr) / 1000)); // each event's contact, left out
  const fit = fitShared(y, sr, ats, skips, opts), r = Float64Array.from(y);
  ats.forEach((at, e) => { const m = modesSignal(y.length, sr, at, fit.modes, fit.amps[e]); for (let i = 0; i < y.length; i++) r[i] -= m[i]; });
  // The recipe strikes every mode in sine phase at the event's onset, so place each onset where the fitted phases
  // come closest to that (energy-weighted sin^2 of the phase, over +-1.5 ms): a sound reaching the microphone a little
  // late, or a detector a little early, then costs no phase. Amplitudes and phases move with it.
  const on = ats.map((at, e) => {
    let bestD = 0, bestC = Infinity;
    const lim = Math.round((e ? 0.0006 : 0.0015) * sr), lo = e ? Math.max(-lim, ats[e - 1] - at + 1) : Math.max(-lim, -at);
    for (let d = lo; d <= lim; d++) {
      let c = 0;
      fit.modes.forEach((m, k) => { const a = fit.amps[e][k], ph = a.phase + (2 * Math.PI * m.f * d) / sr; c += a.gain * a.gain * m.ms * Math.sin(ph) ** 2; });
      if (c < bestC - 1e-15) { bestC = c; bestD = d; }
    }
    fit.amps[e] = fit.amps[e].map((a, k) => {
      const m = fit.modes[k], ph = a.phase + (2 * Math.PI * m.f * bestD) / sr, g = Math.abs(a.gain) * 1000 ** (-((bestD * 1000) / sr) / m.ms);
      return { gain: Math.cos(ph) < 0 ? -g : g, phase: Math.atan2(Math.sin(ph), Math.cos(ph)) };
    });
    return at + bestD;
  });
  const contacts = on.map((at, e) => fitContact(r, sr, at, on[e + 1]));
  const en = (k) => Math.max(...fit.amps.map((a) => a[k].gain ** 2)) * fit.modes[k].ms;
  const low = fit.modes.map((_, k) => k).filter((k) => fit.modes[k].f < 450 && fit.modes[k].f >= 100 && fit.modes[k].ms >= 15); // (a board rings)
  // the body: the lowest of the modes under 450 Hz within 6 dB of the strongest of them (a capstone's lowest piece mode
  // can be as strong as the board under it)
  const emax = Math.max(0, ...low.map(en)), bk = low.length ? low.filter((k) => en(k) >= emax / 4).reduce((p, q) => (fit.modes[p].f <= fit.modes[q].f ? p : q)) : -1;
  const t0 = (on[0] / sr) * 1000;
  const events = on.map((at, e) => {
    // (the phase left after placing the onset: kept, so the recipe renders what was fitted; 0 or pi is the sign)
    const md = (k) => { const a = fit.amps[e][k], ph = a.gain < 0 ? a.phase - Math.PI * Math.sign(a.phase || 1) : a.phase;
      return { f: round(fit.modes[k].f, 1), ms: round(fit.modes[k].ms, 2), gain: round(a.gain, 5), phase: round(ph, 3) }; };
    return { at: round((at / sr) * 1000 - t0, 2), gain: 1, contact: contacts[e],
      modes: fit.modes.map((_, k) => k).filter((k) => k !== bk).map(md), body: bk >= 0 ? md(bk) : null };
  });
  return { level: round(loudness(Float32Array.from(y), sr), 2), events, _start: t0 };
}

// ---- distance ----
// Band energies (dB) of x in frames: ~5.3 ms Hann windows every 2 ms, third-octave-ish bands 100 Hz-10 kHz.
function bandgram(x, sr) {
  const W = pow2(Math.round(0.0053 * sr)), hop = Math.round(0.002 * sr), win = Float64Array.from({ length: W }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W));
  const edges = []; for (let f = 100; f <= Math.min(10000, 0.45 * sr); f *= 2 ** (1 / 4)) edges.push(f);
  const out = [];
  for (let s = -W / 2; s < x.length; s += hop) {
    const seg = new Float64Array(W);
    for (let i = 0; i < W; i++) { const j = s + i; seg[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0; }
    const P = power(seg, W), df = sr / W, row = [];
    for (let b = 0; b + 1 < edges.length; b++) { let e = 0; for (let i = Math.floor(edges[b] / df); i < edges[b + 1] / df; i++) e += P[i]; row.push(e); }
    out.push(row);
  }
  return out;
}
// Mean |difference| in dB over the cells where either sound is within 30 dB of the louder one's strongest cell,
// after scaling b to a's total energy; both start at their own sample 0. (30 dB, not more: quiet cells would count as
// much as the partials that carry the sound, and a fit missing the strongest of them could still score well.)
export function distance(a, sr, b, { floorDb = 30 } = {}) {
  const ea = a.reduce((s, v) => s + v * v, 0), eb = b.reduce((s, v) => s + v * v, 0), g = Math.sqrt(ea / (eb || 1));
  const n = Math.max(a.length, b.length), A = new Float64Array(n), B = new Float64Array(n);
  A.set(a); for (let i = 0; i < b.length; i++) B[i] = b[i] * g;
  const ga = bandgram(A, sr), gb = bandgram(B, sr);
  let mx = 0;
  for (const g2 of [ga, gb]) for (const r of g2) for (const v of r) mx = Math.max(mx, v);
  const floor = mx * 10 ** (-floorDb / 10);
  let s = 0, c = 0;
  for (let t = 0; t < ga.length; t++) for (let k = 0; k < ga[t].length; k++) {
    const x = ga[t][k], y = gb[t][k];
    if (x < floor && y < floor) continue;
    s += Math.abs(db(Math.max(x, floor)) - db(Math.max(y, floor))); c++;
  }
  return c ? s / c : 0;
}

// The average of several recipes: modes matched across takes by frequency (within 3%; to the reference take's modes
// first, then to those of the takes before, closest pairs first, one mode of a take per match) and kept when at least
// half the takes have them; geometric means of frequencies and times, means of gains; later events by their index.
// ref: the take matched against first (fitRecording passes the one nearest its recording).
export function averageRecipe(recipes, ref = 0) {
  const n = recipes.length, gm = (v) => Math.exp(v.reduce((s, x) => s + Math.log(x), 0) / v.length), am = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const avgModes = (lists, r0 = 0) => {
    const cl = []; // [{ f, m: [modes] }]
    for (const t of [r0, ...lists.keys()].filter((t, i, a) => a.indexOf(t) === i && t < lists.length)) {
      const ms = (lists[t] || []).map((m) => ({ ...m, t })), pairs = [], um = new Set(), uc = new Set();
      ms.forEach((m, i) => cl.forEach((c, j) => { const d = Math.abs(Math.log(m.f / c.f)); if (d < Math.log(1.03)) pairs.push([d, i, j]); }));
      for (const [, i, j] of pairs.sort((a, b) => a[0] - b[0])) if (!um.has(i) && !uc.has(j)) { um.add(i); uc.add(j); cl[j].m.push(ms[i]); }
      ms.forEach((m, i) => { if (!um.has(i)) cl.push({ f: m.f, m: [m] }); });
    }
    const groups = cl.map((c) => c.m).sort((a, b) => a[0].f - b[0].f);
    // size: the mean |gain| (scaled by the share of takes that have the mode); phase: the circular mean of the signed
    // starts (gain e^(i phase)), so one take's recipe averages to itself
    return groups.filter((c) => c.length * 2 >= lists.length).map((c) => {
      let re = 0, im = 0;
      for (const q of c) { re += q.gain * Math.cos(q.phase || 0); im += q.gain * Math.sin(q.phase || 0); }
      return { f: round(gm(c.map((q) => q.f)), 1), ms: round(gm(c.map((q) => q.ms)), 2), gain: round(am(c.map((q) => Math.abs(q.gain))) * (c.length / lists.length), 5), phase: round(Math.atan2(im, re), 3) };
    });
  };
  const nev = Math.round(am(recipes.map((r) => r.events.length))), events = [];
  for (let k = 0; k < nev; k++) {
    const es = recipes.map((r) => r.events[k]).filter(Boolean), cs = es.map((e) => e.contact).filter(Boolean), bs = es.map((e) => e.body).filter(Boolean);
    events.push({ at: round(am(es.map((e) => e.at)), 2), gain: 1,
      contact: cs.length ? { ms: round(gm(cs.map((c) => c.ms)), 2), lo: Math.round(gm(cs.map((c) => Math.max(20, c.lo)))), hi: Math.round(gm(cs.map((c) => c.hi))), gain: round(am(cs.map((c) => c.gain)), 5) } : null,
      modes: avgModes(es.map((e) => e.modes), es.length === n ? ref : 0),
      body: bs.length * 2 >= es.length ? avgModes(bs.map((b) => [b]))[0] ?? null : null });
  }
  return { level: round(am(recipes.map((r) => r.level)), 2), events };
}

// Spectral facts of a sound: the share of its energy in BANDS (Hz) and its centroid.
export const BANDS = [[0, 150], [150, 400], [400, 1000], [1000, 2500], [2500, 5000], [5000, Infinity]];
export function balance(x, sr) {
  const P = power(x, Math.max(1 << 14, pow2(x.length))), df = sr / (2 * (P.length - 1));
  let tot = 0, c = 0;
  for (let i = 1; i < P.length; i++) { tot += P[i]; c += P[i] * i * df; }
  return { shares: BANDS.map(([lo, hi]) => { let e = 0; for (let i = Math.max(1, Math.ceil(lo / df)); i < P.length && i * df < hi; i++) e += P[i]; return e / (tot || 1); }), centroid: c / (tot || 1) };
}
// The strongest spectral peaks of a take (its power spectrum smoothed over 25 Hz; a peak is the highest within +-6%;
// 80 Hz-8 kHz), and the fitted mode that matches each (or none): within 3%, or within the mode's own half-width
// (1.1 / T60 Hz: a short ring has a broad peak).
export function strongest(y, sr, n = 4) {
  const M = Math.max(1 << 15, pow2(y.length)), P = power(y, M), df = sr / M, k = Math.max(1, Math.round(25 / df)), sm = new Float64Array(P.length);
  for (let i = 0; i < P.length; i++) { let s = 0; for (let j = Math.max(0, i - (k >> 1)); j <= Math.min(P.length - 1, i + (k >> 1)); j++) s += P[j]; sm[i] = s; }
  const out = [];
  for (let i = Math.round(80 / df); i <= Math.min(8000, 0.45 * sr) / df; i++) {
    let ok = sm[i] > sm[i - 1];
    for (let j = Math.floor(i / 1.06); ok && j <= Math.ceil(i * 1.06); j++) if (sm[j] > sm[i]) ok = false;
    if (ok) out.push([i * df, db(sm[i])]);
  }
  return out.sort((p, q) => q[1] - p[1]).slice(0, n);
}
export function peakCheck(y, sr, recipe, n = 4) {
  const ms = recipe.events.flatMap((e) => [...(e.modes || []), ...(e.body ? [e.body] : [])]);
  return strongest(y, sr, n).map(([f, l]) => {
    const m = ms.reduce((b, q) => (!b || Math.abs(q.f / f - 1) < Math.abs(b.f / f - 1) ? q : b), null);
    return { f: round(f, 1), db: round(l, 1), mode: m && Math.abs(m.f - f) <= Math.max(0.03 * f, 1100 / m.ms) ? m.f : null };
  }).map((p, i, all) => ({ ...p, db: round(p.db - all[0].db, 1) }));
}
// Bursts of contact noise in a recording: runs of energy above 2.5 kHz (1 ms frames within 30 dB of the loudest)
// separated by at least minGap ms below that. More bursts than takes: takes were merged (rumble, or too close).
export function bursts(x, sr, { minGap = 150 } = {}) {
  const { e } = envelope(zfilter(x, sr, highpass(Math.min(2500, sr / 5))), sr, 1);
  let pk = 0;
  for (const v of e) pk = Math.max(pk, v);
  if (!(pk > 0)) return 0;
  let n = 0, last = -Infinity;
  for (let j = 0; j < e.length; j++) if (e[j] > pk * 10 ** (-30 / 20)) { if (j - last > minGap) n++; last = j; }
  return n;
}

const strip = (r) => { const { _start, ...rest } = r; return rest; };
// Fit every take of a recording (cleaned first: clean()). Returns { sr, takes: [{ start, end, recipe, distance, y,
// check: { balance of the take and of its fit, peakCheck }, warn }], average, averageDistance, used (the takes
// averaged: those with the most common number of events), bursts, warnings }.
export function fitRecording(x, sr, opts = {}) {
  x = clean(x, sr);
  const minGap = opts.minGap ?? 150;
  const takes = findTakes(x, sr, opts).map(([s, e]) => {
    const y = x.slice(s, e), recipe = fitTake(y, sr, opts), off = Math.round((recipe._start * sr) / 1000);
    const yy = y.subarray(off), syn = renderRecipe(strip(recipe), sr, { raw: true }), r = strip(recipe);
    const check = { take: balance(yy, sr), fit: balance(syn, sr), peaks: peakCheck(yy, sr, r) }, warn = [];
    const activeMs = ((e - s) / sr) * 1000 - 11; // (findTakes keeps 1 ms before the onset and 10 ms after the sound)
    if (r.events.length > 2 || activeMs > 150)
      warn.push(`${r.events.length} events over ${activeMs.toFixed(0)} ms: several pieces landing? Record them further apart, or lower --min-gap (now ${minGap} ms)`);
    const miss = check.peaks.slice(0, 3).filter((p) => p.mode == null);
    if (miss.length) warn.push(`no fitted mode at its strongest peak(s) ${miss.map((p) => `${p.f.toFixed(0)} Hz (${p.db} dB)`).join(', ')}`);
    return { start: s + off, end: e, recipe: r, y: yy, distance: round(distance(yy, sr, syn), 2), check, warn };
  });
  const warnings = [], nb = bursts(x, sr, { minGap });
  if (nb > takes.length) warnings.push(`${nb} bursts of contact noise but ${takes.length} take(s): takes merged (rumble, or under --min-gap ${minGap} ms apart)?`);
  // the takes averaged: the most common number of events (a take with a bounce and one without do not mix by index)
  const count = new Map();
  for (const t of takes) count.set(t.recipe.events.length, (count.get(t.recipe.events.length) || 0) + 1);
  const modal = [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  const used = takes.map((t, i) => (t.recipe.events.length === modal ? i : -1)).filter((i) => i >= 0);
  if (used.length < takes.length) warnings.push(`averaged ${used.length} of ${takes.length} takes (those with ${modal} event(s)); left out: ${takes.map((t, i) => (used.includes(i) ? null : `take ${i + 1} (${t.recipe.events.length})`)).filter(Boolean).join(', ')}`);
  const ref = used.reduce((b, i, k) => (takes[i].distance < takes[used[b]].distance ? k : b), 0);
  const average = used.length ? averageRecipe(used.map((i) => takes[i].recipe), ref) : null;
  const avgSyn = average && renderRecipe(average, sr, { raw: true });
  const averageDistance = average ? round(used.reduce((s, i) => s + distance(takes[i].y, sr, avgSyn), 0) / used.length, 2) : null;
  return { sr, takes, average, averageDistance, used, bursts: nb, warnings };
}

// ---- command line ----
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), file = args.find((a, i) => !a.startsWith('--') && !(i && args[i - 1].startsWith('--')));
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  if (!file) { console.error('usage: node scripts/fit-sound.mjs take.wav [--out dir] [--min-gap ms] [--modes n] [--against sound[:voice]] [--channel auto|mix|0|1]'); process.exit(2); }
  const ch = opt('channel', 'auto'), { x, sr, channels, channel } = readWav(file, { channel: /^\d+$/.test(ch) ? Number(ch) : ch });
  const res = fitRecording(x, sr, { minGap: Number(opt('min-gap', 150)), maxModes: Number(opt('modes', 12)) });
  if (!res.takes.length) {
    console.error(`${path.basename(file)}: no takes found. Check the level (is anything recorded?) and leave at least ${opt('min-gap', 150)} ms of quiet between takes.`);
    process.exit(1);
  }
  const dir = opt('out', path.dirname(file)), base = path.join(dir, path.basename(file).replace(/\.wav$/i, ''));
  fs.mkdirSync(dir, { recursive: true });
  const out = new Float64Array(x.length);
  for (const t of res.takes) { const s = renderRecipe(t.recipe, sr, { raw: true }); for (let i = 0; i < s.length && t.start + i < out.length; i++) out[t.start + i] += s[i]; }
  fs.writeFileSync(base + '.fit.wav', wav16(out, sr));
  fs.writeFileSync(base + '.recipe.json', JSON.stringify({ source: path.basename(file), sr, takes: res.takes.map((t) => ({ startMs: round((t.start / sr) * 1000, 2), distance: t.distance, recipe: t.recipe })),
    average: res.average, averageDistance: res.averageDistance, averaged: res.used.map((i) => i + 1), warnings: res.warnings }, null, 1) + '\n');
  console.log(`${path.basename(file)}: ${res.takes.length} take(s) at ${sr} Hz` + (channels > 1 ? `, channel ${channel} of ${channels}` : ''));
  const pc = (v) => `${(100 * v).toFixed(1)}%`;
  res.takes.forEach((t, i) => {
    const e = t.recipe.events;
    console.log(`take ${i + 1} at ${((t.start / sr) * 1000).toFixed(1)} ms: ${e.length} event(s) at ${e.map((v) => v.at).join(', ')} ms; ` +
      `modes ${e[0].modes.map((m) => `${m.f.toFixed(0)}/${m.ms.toFixed(0)}`).join(' ')} (Hz/T60 ms); body ${e[0].body ? `${e[0].body.f.toFixed(0)}/${e[0].body.ms.toFixed(0)}` : '-'}; ` +
      `contact ${e[0].contact ? `${e[0].contact.ms} ms ${e[0].contact.lo}-${e[0].contact.hi} Hz` : '-'}; distance ${t.distance} dB`);
    const { take: a, fit: b, peaks: pk } = t.check;
    console.log(`  bands ${BANDS.map(([lo, hi]) => `${lo}-${hi === Infinity ? '' : hi}`).join(' / ')} Hz: take ${a.shares.map(pc).join(' ')}, fit ${b.shares.map(pc).join(' ')}; centroid ${a.centroid.toFixed(0)} -> ${b.centroid.toFixed(0)} Hz (${(100 * (b.centroid / a.centroid - 1)).toFixed(0)}%)`);
    console.log(`  strongest peaks: ${pk.map((p) => `${p.f.toFixed(0)} Hz ${p.db} dB ${p.mode != null ? `= mode ${p.mode.toFixed(0)}` : 'NO MODE'}`).join('; ')}`);
    for (const w of t.warn) console.log(`  warning: ${w}`);
  });
  for (const w of res.warnings) console.log(`warning: ${w}`);
  if (res.average) console.log(`average recipe: distance ${res.averageDistance} dB (mean over the takes averaged)`);
  const against = opt('against');
  if (against) {
    const [name, voice] = against.split(':');
    if (!SOUNDS[name]) { console.error('no sound ' + name); process.exit(2); }
    const syn = SOUNDS[name].render(sr, { voice }), d = res.takes.map((t) => distance(t.y, sr, syn));
    console.log(`${against} as it is: distance ${d.map((v) => v.toFixed(2)).join(', ')} dB` + (d.length > 1 ? ` (mean ${(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2)})` : ''));
  }
  console.log('wrote', base + '.recipe.json', base + '.fit.wav');
}
