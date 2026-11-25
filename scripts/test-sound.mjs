// The sounds (public/sound.js): every buffer clean (finite, quiet, starts and ends at 0, no DC), the designed length
// at 44.1 and 48 kHz, deterministic; the move sounds measurably wood (many partials, a broadband contact, a click that
// dies before the board's body) and in the physical order (piece brighter than board, wall highest, capstone lowest,
// smash biggest, drops softer); the five other sounds exactly as they were; importing it in node touches no browser
// API.   node scripts/test-sound.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const atest = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const root = new URL('..', import.meta.url).pathname;
const src = fs.readFileSync(root + 'public/sound.js', 'utf8');

let mod;
await atest('importing in node touches no window/document/AudioContext', async () => {
  // watch every browser global: the import may only ask whether `window` exists (typeof), nothing more
  const seen = [];
  for (const g of ['window', 'document', 'AudioContext', 'webkitAudioContext'])
    Object.defineProperty(globalThis, g, { configurable: true, get() { seen.push(g); return undefined; } });
  mod = await import('../public/sound.js');
  assert.deepEqual(seen.filter((g) => g !== 'window'), [], 'only typeof window may be looked at');
  for (const g of ['window', 'document', 'AudioContext', 'webkitAudioContext']) delete globalThis[g];
});
const { SOUNDS, VOICES, DEFAULT_VOICE, MOVE_SOUNDS, MOVE_RECIPES, VARIANTS, renderRecipe, recipeFor, play, unlock, setEnabled, isEnabled } = mod;
const FIVE = ['wrong', 'solved', 'rushGood', 'rushEnd', 'lowTime'];
const MOVES = ['flatBoard', 'flatPiece', 'wallBoard', 'wallPiece', 'capBoard', 'capPiece', 'smash', 'dropBoard', 'dropPiece'];

// design ranges in ms
const RANGE = { smash: [120, 260], wrong: [100, 250], solved: [200, 500], rushGood: [30, 70], rushEnd: [200, 500], lowTime: [100, 250] };
const cases = []; // [name, opts, [lo, hi] ms]
for (const name of Object.keys(SOUNDS)) {
  const voices = SOUNDS[name].voiced ? [...VOICES, undefined] : [undefined], range = RANGE[name] || [20, 160];
  for (const voice of voices)
    for (const variant of SOUNDS[name].move ? [...Array(VARIANTS).keys()] : [undefined])
      cases.push([name, { ...(voice ? { voice } : {}), ...(variant !== undefined ? { variant } : {}) }, range]);
}

test('the set: the nine move sounds, then the five others; each with a label, a description and a render', () => {
  assert.deepEqual(MOVE_SOUNDS, MOVES);
  assert.deepEqual(Object.keys(SOUNDS), [...MOVES, ...FIVE]);
  for (const [k, s] of Object.entries(SOUNDS)) {
    assert.equal(typeof s.label, 'string', k); assert.equal(typeof s.desc, 'string', k); assert.equal(typeof s.render, 'function', k);
    assert.equal(!!s.move, MOVES.includes(k), k);
  }
  assert.equal(VARIANTS, 4);
});

test('every buffer (each voice and variant): finite, |peak| <= 0.5, exactly 0 at both ends, |DC| < 0.002, length in its range', () => {
  for (const sr of [44100, 48000])
    for (const [name, opts, [lo, hi]] of cases) {
      const x = SOUNDS[name].render(sr, opts), tag = `${name} ${JSON.stringify(opts)} @${sr}`;
      assert.ok(x instanceof Float32Array && x.length > 0, tag);
      let peak = 0, dc = 0;
      for (const v of x) { assert.ok(Number.isFinite(v), tag); peak = Math.max(peak, Math.abs(v)); dc += v; }
      assert.ok(peak <= 0.5, `${tag}: peak ${peak}`);
      assert.ok(peak > 0.05, `${tag}: not silent (${peak})`);
      assert.equal(x[0], 0, tag); assert.equal(x[x.length - 1], 0, tag);
      assert.ok(Math.abs(dc / x.length) < 0.002, `${tag}: DC ${dc / x.length}`);
      const ms = (x.length / sr) * 1000;
      assert.ok(ms >= lo && ms <= hi, `${tag}: ${ms} ms not in [${lo}, ${hi}]`);
    }
});

test('the same sound at 44.1 and 48 kHz: the same length in ms, loudness within 1.5 dB, peak within 1.5 dB (2.5 for the noisy move sounds)', () => {
  for (const [name, opts] of cases) {
    const a = SOUNDS[name].render(44100, opts), b = SOUNDS[name].render(48000, opts);
    assert.ok(Math.abs((a.length / 44100 - b.length / 48000) * 1000) <= 1, name);
    const pk = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // (the contact noise is drawn per sample, so its tallest spike differs by rate: the peak gets more room)
    assert.ok(Math.abs(20 * Math.log10(pk(a) / pk(b))) < (SOUNDS[name].move ? 2.5 : 1.5), `${name} ${JSON.stringify(opts)}: peak differs by rate`);
    assert.ok(Math.abs(mod.loudness(a, 44100) - mod.loudness(b, 48000)) < 1.5, `${name} ${JSON.stringify(opts)}: loudness differs by rate`);
  }
});

test('deterministic: two renders are identical; no Math.random in the file', () => {
  for (const sr of [44100, 48000])
    for (const [name, opts] of cases) assert.deepEqual(SOUNDS[name].render(sr, opts), SOUNDS[name].render(sr, opts), name);
  assert.ok(!/Math\.random/.test(src));
});

// FNV-1a of the samples of wrong, solved, rushGood, rushEnd and lowTime as they were before the move sounds were
// rebuilt (commit 0bf89ab): they must stay those sounds exactly. (If only these change after a Node upgrade, the maths
// library moved: listen, then re-pin.)
const fnv = (x) => { let a = 0x811c9dc5; for (const v of new Uint8Array(x.buffer, x.byteOffset, x.byteLength)) { a ^= v; a = Math.imul(a, 0x01000193) >>> 0; } return a.toString(16).padStart(8, '0'); };
const PINNED = {
  'wrong.light@44100': 'fe75b629', 'wrong.thunk@44100': '56516d57', 'wrong.deep@44100': 'ef446748', 'solved@44100': '104c655a',
  'rushGood.light@44100': 'b0d9b775', 'rushGood.thunk@44100': 'fa2eb8ec', 'rushGood.deep@44100': '1d353c49', 'rushEnd@44100': '67b16fb0', 'lowTime@44100': 'e0652dea',
  'wrong.light@48000': 'ee9c0375', 'wrong.thunk@48000': 'c7be2d8e', 'wrong.deep@48000': '21ee1007', 'solved@48000': 'f3861e06',
  'rushGood.light@48000': 'aefe97c7', 'rushGood.thunk@48000': '0abc12ff', 'rushGood.deep@48000': 'de4fbc60', 'rushEnd@48000': '802e2f7c', 'lowTime@48000': 'dc14b9b2',
};
test('wrong, solved, rushGood, rushEnd and lowTime are unchanged, sample for sample (every voice, 44.1 and 48 kHz)', () => {
  for (const [k, h] of Object.entries(PINNED)) {
    const [, name, voice, sr] = /^(\w+)(?:\.(\w+))?@(\d+)$/.exec(k);
    assert.equal(fnv(SOUNDS[name].render(Number(sr), voice ? { voice } : {})), h, k);
  }
});

test('the recipes are plain data: JSON round trip renders the same; renderRecipe(recipeFor(...)) is the sound', () => {
  const copy = JSON.parse(JSON.stringify(MOVE_RECIPES));
  assert.deepEqual(copy, MOVE_RECIPES);
  for (const name of MOVES) {
    assert.deepEqual(renderRecipe(copy.sounds[name], 48000), renderRecipe(MOVE_RECIPES.sounds[name], 48000), name);
    for (const voice of VOICES) for (let v = 0; v < VARIANTS; v++)
      assert.deepEqual(renderRecipe(recipeFor(name, voice, v), 48000), SOUNDS[name].render(48000, { voice, variant: v }), `${name} ${voice} ${v}`);
  }
  assert.deepEqual(recipeFor('flatBoard', 'thunk', 0), MOVE_RECIPES.sounds.flatBoard, 'thunk, variant 0: the recipe as written');
});

test('the noise seed of each take is written down (SEED_PICKS, what seedPick finds), so a take renders once; every move sound is warmed, and again after a change of voice', () => {
  const want = {};
  for (const name of MOVES) { want[name] = {}; for (const v of VOICES) want[name][v] = [1, 2, 3].map((i) => mod.seedPick(MOVE_RECIPES.sounds[name], name, v, i)); }
  assert.deepEqual(mod.SEED_PICKS, want, 'paste into sound.js SEED_PICKS:\n' + Object.entries(want).map(([n, o]) => `  ${n}: { ${Object.entries(o).map(([v, a]) => `${v}: [${a.join(', ')}]`).join(', ')} },`).join('\n'));
  const warm = /const WARM = \[([^\]]*)\]/.exec(src)[1].match(/\w+/g);
  assert.deepEqual([...warm].sort(), [...MOVES].sort());
  assert.match(src, /export const setVoice = [^\n]*warm\(\)/);
});

test('voices: light, thunk and deep; thunk the default; an unknown voice is the default; variant out of range clamps', () => {
  assert.deepEqual(VOICES, ['light', 'thunk', 'deep']);
  assert.equal(DEFAULT_VOICE, 'thunk');
  for (const name of Object.keys(SOUNDS)) {
    const r = (o) => SOUNDS[name].render(48000, o);
    assert.deepEqual(r({}), r({ voice: DEFAULT_VOICE }), name);
    assert.deepEqual(r({ voice: 'nope' }), r({}), name);
    if (SOUNDS[name].voiced) { assert.notDeepEqual(r({ voice: 'light' }), r({ voice: 'thunk' }), name); assert.notDeepEqual(r({ voice: 'thunk' }), r({ voice: 'deep' }), name); }
    else for (const v of VOICES) assert.deepEqual(r({ voice: v }), r({}), name);
  }
  assert.deepEqual(SOUNDS.flatBoard.render(48000, { variant: 99 }), SOUNDS.flatBoard.render(48000, { variant: VARIANTS - 1 }));
  assert.deepEqual(SOUNDS.flatBoard.render(48000, { variant: -3 }), SOUNDS.flatBoard.render(48000, { variant: 0 }));
});

// ---- measuring ----
const SR = 48000;
function fft(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= N; len <<= 1) { const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
    for (let i = 0; i < N; i += len) { let cr = 1, ci = 0; for (let j = 0; j < h; j++) { const k = i + j + h, vr = re[k] * cr - im[k] * ci, vi = re[k] * ci + im[k] * cr;
      re[k] = re[i + j] - vr; im[k] = im[i + j] - vi; re[i + j] += vr; im[i + j] += vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
}
const P = (x, N = 1 << 16) => { const re = new Float64Array(N), im = new Float64Array(N); re.set(x.subarray(0, N)); fft(re, im); return Float64Array.from({ length: N / 2 + 1 }, (_, i) => re[i] * re[i] + im[i] * im[i]); };
// spectrum facts of x: centroid, the share of energy in [lo, hi), and the partials (25 Hz-smoothed peaks that are the
// highest within +-6%) between 250 Hz and 3 kHz within 10 dB of the strongest of them
function spec(x) {
  const N = 1 << 16, p = P(x, N), df = SR / N;
  let tot = 0, c = 0; for (let i = 1; i < p.length; i++) { tot += p[i]; c += p[i] * i * df; }
  const share = (lo, hi) => { let s = 0; for (let i = Math.ceil(lo / df); i < hi / df && i < p.length; i++) s += p[i]; return s / tot; };
  const k = Math.round(25 / df), sm = new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) { let s = 0; for (let j = Math.max(0, i - (k >> 1)); j <= Math.min(p.length - 1, i + (k >> 1)); j++) s += p[j]; sm[i] = s; }
  const pk = [];
  for (let i = Math.round(250 / df); i <= 3000 / df; i++) { let ok = sm[i] > sm[i - 1]; for (let j = Math.floor(i / 1.06); ok && j <= Math.ceil(i * 1.06); j++) if (sm[j] > sm[i]) ok = false; if (ok) pk.push(sm[i]); }
  const top = Math.max(...pk);
  return { centroid: c / tot, share, partials: pk.filter((v) => v >= top / 10).length };
}
// zero-phase high/low-pass (4th order magnitude) by FFT
function split(x, fc, type) {
  const N = 1 << 16, re = new Float64Array(N), im = new Float64Array(N); re.set(x); fft(re, im);
  for (let i = 0; i < N; i++) { const f = (Math.min(i, N - i) * SR) / N, g = type === 'hp' ? 1 / Math.sqrt(1 + (fc / Math.max(f, 1e-9)) ** 8) : 1 / Math.sqrt(1 + (f / fc) ** 8); re[i] *= g; im[i] = -im[i] * g; }
  fft(re, im); return Float64Array.from({ length: x.length }, (_, i) => re[i] / N);
}
// ms from the peak until the RMS envelope (windows of wms, at least a period of what is measured, every 1 ms) first
// falls 20 dB under it (a later bounce does not count); from: start there (ms) instead of at the peak
function t20(x, from, wms = 3) {
  const w = Math.round((wms * SR) / 1000), e = []; for (let s = 0; s + w <= x.length; s += SR / 1000) { let q = 0; for (let i = s; i < s + w; i++) q += x[i] * x[i]; e.push(q / w); }
  const ip = from ?? e.indexOf(Math.max(...e)); let i = ip;
  while (i < e.length && e[i] > e[ip] / 100) i++;
  return i - ip;
}
// length in ms of the part within 40 dB of the peak
const ms40 = (x) => { const pk = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0); let a = 0, b = x.length - 1; while (Math.abs(x[a]) < pk / 100) a++; while (Math.abs(x[b]) < pk / 100) b--; return ((b - a) * 1000) / SR; };
// the energy share of 1-5 kHz in the first 8 ms
const early = (x) => { const y = x.subarray(0, Math.round(0.008 * SR)), N = 1 << 14, p = P(y, N), df = SR / N; let t = 0, b = 0; for (let i = 1; i < p.length; i++) { t += p[i]; if (i * df >= 1000 && i * df < 5000) b += p[i]; } return b / t; };
// Loudness as a listener hears it: BS.1770 K-weighting at 48 kHz, the whole sound's energy in one 400 ms block, and
// the same through a 4th-order 350 Hz high-pass standing in for a phone speaker.
const bq = (x, b, a) => { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i], o = b[0] * v + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; } return y; };
const kw = (x) => bq(bq(x, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]), [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
const hp350 = (x) => { const w = (2 * Math.PI * 350) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * 0.707), a0 = 1 + al;
  const f = (v) => bq(v, [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0], [1, (-2 * c) / a0, (1 - al) / a0]); return f(f(x)); };
const block = (x) => { let e = 0; for (const v of kw(x)) e += v * v; return -0.691 + 10 * Math.log10(e / (0.4 * SR)); };
const render = (name, voice, variant = 0) => Float64Array.from(SOUNDS[name].render(SR, { voice, variant }));
const heard = (x) => { const y = new Float64Array(SR); y.set(x.subarray(0, SR)); return { full: block(y), phone: block(hp350(y)) }; };
const M = {}; // measurements of every move sound, variant 0, per voice
for (const v of VOICES) { M[v] = {}; for (const name of MOVES) { const x = render(name, v); M[v][name] = { x, s: spec(x), h: heard(x), ms: ms40(x) }; } }

test('wood, not a tone: a flat on the board has >= 4 partials within 10 dB (250 Hz-3 kHz), a contact with >= 20% of the first 8 ms in 1-5 kHz, < 5% of all its energy above 5 kHz (every voice)', () => {
  for (const v of VOICES) {
    const m = M[v].flatBoard;
    assert.ok(m.s.partials >= 4, `${v}: ${m.s.partials} partials`);
    assert.ok(early(m.x) >= 0.2, `${v}: ${early(m.x).toFixed(2)} of the first 8 ms in 1-5 kHz`);
    assert.ok(m.s.share(5000, 24000) < 0.05, `${v}: ${m.s.share(5000, 24000).toFixed(3)} above 5 kHz`);
    for (const name of MOVES) assert.ok(M[v][name].s.share(5000, 24000) < 0.05, `${v} ${name}: above 5 kHz`);
  }
});

test('the click dies first: above 350 Hz a flat on the board falls 20 dB within 8-22 ms of its peak; under 350 Hz (the board) it lasts longer', () => {
  for (const v of ['thunk', 'deep']) {
    const x = M[v].flatBoard.x, c = t20(split(x, 350, 'hp')), b = t20(split(x, 350, 'lp'), 5, 8); // (the body from 5 ms, after the contact)
    assert.ok(c >= 8 && c <= 22, `${v}: click ${c} ms`);
    assert.ok(b >= c + 8, `${v}: body ${b} ms vs click ${c} ms`);
  }
});

test('the physical order, in every voice: on a piece brighter and shorter than on the board; a wall higher and lighter than a flat; the capstone lowest and heaviest', () => {
  for (const v of VOICES) {
    const m = M[v], c = (k) => m[k].s.centroid, low = (k) => m[k].s.share(0, 400);
    assert.ok(c('flatPiece') > 1.1 * c('flatBoard') && m.flatPiece.ms < 0.8 * m.flatBoard.ms, `${v}: flat on a piece ${c('flatPiece').toFixed(0)} Hz ${m.flatPiece.ms.toFixed(0)} ms vs on the board ${c('flatBoard').toFixed(0)} Hz ${m.flatBoard.ms.toFixed(0)} ms`);
    assert.ok(c('capPiece') > 1.1 * c('capBoard') && m.capPiece.ms < 0.8 * m.capBoard.ms, `${v}: capstone on a piece vs on the board`);
    assert.ok(c('dropPiece') > 1.1 * c('dropBoard'), `${v}: drop on a piece brighter`);
    assert.ok(c('wallBoard') > 1.05 * c('flatBoard') && low('wallBoard') < low('flatBoard'), `${v}: a wall on the board is higher and lighter than a flat`);
    assert.ok(c('wallPiece') > c('flatPiece') && c('wallPiece') > c('flatBoard'), `${v}: a wall on a piece is the highest of the placements`);
    for (const k of MOVES) if (k !== 'capBoard') assert.ok(c('capBoard') < c(k), `${v}: capstone ${c('capBoard').toFixed(0)} Hz is lower than ${k} ${c(k).toFixed(0)}`);
    assert.ok(low('capBoard') > low('flatBoard') && low('capBoard') > low('wallBoard'), `${v}: the capstone has the most energy under 400 Hz`);
    assert.ok(c('capPiece') < c('flatPiece'), `${v}: the capstone on a piece is heavier than a flat on one`);
  }
});

test('the smash: two events 60-120 ms apart (the slap no weaker than the strike), the longest and loudest move sound, its slap as loud as a flat placed', () => {
  for (const v of VOICES) {
    const x = M[v].smash.x, w = SR / 200, env = []; // 5 ms RMS, 2.5 ms hops
    for (let s = 0; s + w <= x.length; s += w / 2) { let q = 0; for (let i = s; i < s + w; i++) q += x[i] * x[i]; env.push(10 * Math.log10(q / w + 1e-20)); }
    const top = Math.max(...env), first = Math.max(...env.slice(0, 8)), at2 = env.findIndex((e, i) => i > 16 && e > top - 3), second = Math.max(...env.slice(16));
    const gap = (at2 * w) / 2 / SR * 1000;
    assert.ok(gap >= 55 && gap <= 125, `${v}: second event at ${gap} ms`);
    assert.ok(second >= first - 1 && first > top - 8, `${v}: strike ${(first - top).toFixed(1)} dB, slap ${(second - top).toFixed(1)} dB`);
    for (const k of MOVES) if (k !== 'smash') {
      assert.ok(M[v].smash.ms > M[v][k].ms, `${v}: smash longer than ${k}`);
      assert.ok(M[v].smash.h.full > M[v][k].h.full + 1.5, `${v}: smash ${M[v].smash.h.full.toFixed(1)} louder than ${k} ${M[v][k].h.full.toFixed(1)}`);
    }
    const slap = heard(x.subarray(Math.round(0.08 * SR)));
    assert.ok(slap.full >= M[v].flatBoard.h.full - 0.5, `${v}: slap ${slap.full.toFixed(1)} vs a flat ${M[v].flatBoard.h.full.toFixed(1)}`);
  }
});

// Through a phone speaker (a 4th-order 400 Hz high-pass, as 50 ms loudness, the mean over the four takes): the weight
// order must not be an artefact of energy a phone cannot play.
const phone50 = (x) => mod.loudness(split(x, 400, 'hp'), SR);
const takes = (name, v) => [...Array(VARIANTS).keys()].map((i) => render(name, v, i));
const mean = (a) => a.reduce((s, q) => s + q, 0) / a.length;
const PH = {};
for (const v of VOICES) { PH[v] = {}; for (const k of MOVES) PH[v][k] = mean(takes(k, v).map(phone50)); }
test('on a phone: the smash 1.5 dB over every other move sound, its slap no softer than a flat, its impact within 1 dB of a capstone on a piece; the capstone within 1 dB of a flat; the wall 1.5 dB under it (every voice)', () => {
  for (const v of VOICES) {
    const p = PH[v];
    for (const k of MOVES) if (k !== 'smash') assert.ok(p.smash >= p[k] + 1.5, `${v}: smash ${p.smash.toFixed(1)} vs ${k} ${p[k].toFixed(1)}`);
    const parts = takes('smash', v).map((x, i) => { const at = mod.eventsOf(recipeFor('smash', v, i))[1].at, i0 = Math.round(((at - 1) * SR) / 1000);
      return [phone50(x.slice(0, i0)), phone50(x.slice(i0))]; });
    const imp = mean(parts.map((q) => q[0])), slap = mean(parts.map((q) => q[1]));
    assert.ok(slap >= p.flatBoard, `${v}: slap ${slap.toFixed(1)} vs flatBoard ${p.flatBoard.toFixed(1)}`);
    assert.ok(imp >= p.capPiece - 1, `${v}: impact ${imp.toFixed(1)} vs capPiece ${p.capPiece.toFixed(1)}`);
    assert.ok(p.capBoard >= p.flatBoard - 1, `${v}: capBoard ${p.capBoard.toFixed(1)} vs flatBoard ${p.flatBoard.toFixed(1)}`);
    assert.ok(p.wallBoard <= p.flatBoard - 1.5, `${v}: wallBoard ${p.wallBoard.toFixed(1)} vs flatBoard ${p.flatBoard.toFixed(1)}`);
  }
});

// The partials of x (80 Hz-5 kHz, 25 Hz-smoothed peaks that are the highest within +-6%), strongest first, as power.
function partials(x) {
  const N = 1 << 16, p = P(x, N), df = SR / N, k = Math.round(25 / df), sm = new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) { let s = 0; for (let j = Math.max(0, i - (k >> 1)); j <= Math.min(p.length - 1, i + (k >> 1)); j++) s += p[j]; sm[i] = s; }
  const pk = [];
  for (let i = Math.round(80 / df); i <= 5000 / df; i++) { let ok = sm[i] > sm[i - 1]; for (let j = Math.floor(i / 1.06); ok && j <= Math.ceil(i * 1.06); j++) if (sm[j] > sm[i]) ok = false; if (ok) pk.push(sm[i]); }
  return pk.sort((a, b) => b - a);
}
test('no boom, no single tone: every move sound in every voice and take has at most 10% of its energy under 150 Hz and no partial more than 10 dB above all the others', () => {
  for (const v of VOICES) for (const k of MOVES) takes(k, v).forEach((x, i) => {
    const lo = spec(x).share(0, 150), pk = partials(x), lead = 10 * Math.log10(pk[0] / pk[1]);
    assert.ok(lo <= 0.1, `${v} ${k} ${i}: ${(100 * lo).toFixed(1)}% under 150 Hz`);
    assert.ok(lead <= 10, `${v} ${k} ${i}: the strongest partial ${lead.toFixed(1)} dB over the next`);
  });
});

// (levels are set by loudness(), which takes a sound under 50 ms whole: the very short drops of the light voice come
// out a little softer than the default's)
test('a drop of a stack move is 3-5 dB softer than the same flat placed (as heard) in the default voice, 2.5-7 dB in the others', () => {
  for (const v of VOICES)
    for (const [d, p] of [['dropBoard', 'flatBoard'], ['dropPiece', 'flatPiece']]) {
      const diff = M[v][p].h.full - M[v][d].h.full, [lo, hi] = v === DEFAULT_VOICE ? [3, 5] : [2.5, 7];
      assert.ok(diff >= lo && diff <= hi, `${v}: ${d} is ${diff.toFixed(1)} dB under ${p}`);
    }
});

test('a phone gives every move sound back: no placement more than 6 dB under a flat on the board through a 350 Hz high-pass (a drop, softer by design, 7.5)', () => {
  for (const v of VOICES) for (const k of MOVES) {
    const d = M[v].flatBoard.h.phone - M[v][k].h.phone;
    assert.ok(d < (/^drop/.test(k) ? 7.5 : 6), `${v}: ${k} is ${d.toFixed(1)} dB under flatBoard on a phone`);
  }
});

test('the voices change character, not just pitch: from light to deep the board body grows (share under 400 Hz) and the sound gets lower; about as loud', () => {
  for (const k of ['flatBoard', 'flatPiece', 'capBoard', 'capPiece', 'dropBoard', 'smash']) {
    const [l, t, d] = VOICES.map((v) => M[v][k]);
    assert.ok(l.s.centroid > t.s.centroid && t.s.centroid > d.s.centroid, `${k}: centroids ${[l, t, d].map((m) => m.s.centroid.toFixed(0))}`);
    const b = [l, t, d].map((m) => m.s.share(0, 400));
    // (on a piece there is little board under it in any voice: there it need only grow)
    assert.ok(b[0] < b[1] && b[1] < b[2] && (/Piece$/.test(k) || b[2] > b[0] + 0.1), `${k}: share under 400 Hz ${b.map((v) => v.toFixed(2))}`);
    const h = [l, t, d].map((m) => m.h.full);
    assert.ok(Math.max(...h) - Math.min(...h) < 3, `${k}: ${h.map((v) => v.toFixed(1))} as heard`);
  }
  // a pitch shift would keep the ratio of the body's share to the piece's; it moves by 3x and more from light to deep
  const r = (v) => M[v].flatBoard.s.share(0, 400) / M[v].flatBoard.s.share(400, 5000);
  assert.ok(r('deep') > 3 * r('light'), `body / piece: light ${r('light').toFixed(2)}, deep ${r('deep').toFixed(2)}`);
});

// (brightness: the contact noise and the modes overlap, so a take's noise moves its centroid; recipeFor picks, of 6
// seeds, the one closest to the first take, which leaves the short on-a-piece sounds up to ~20% apart)
test('variants: VARIANTS different takes of every move sound, each about as loud (2 dB: +-0.6 dB by design, the rest the peak ceiling) and as bright (25%) as the first', () => {
  for (const v of VOICES) for (const k of MOVES) {
    const xs = [...Array(VARIANTS).keys()].map((i) => render(k, v, i));
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) assert.notDeepEqual(xs[i], xs[j], `${v} ${k} ${i}/${j}`);
    const h0 = heard(xs[0]).full, c0 = spec(xs[0]).centroid;
    for (const x of xs.slice(1)) {
      assert.ok(Math.abs(heard(x).full - h0) < 2, `${v} ${k}: variant level ${(heard(x).full - h0).toFixed(1)} dB`);
      assert.ok(Math.abs(spec(x).centroid / c0 - 1) < 0.25, `${v} ${k}: variant centroid ${(spec(x).centroid / c0).toFixed(2)}`);
    }
  }
});

// (solved was set 3-9 dB over the old place; the new flat is 3 dB quieter full-range than that place, at the same
// peak, and louder through a phone: its contact is a sharper transient. So solved may now stand up to 10 dB over it.)
test('the verdicts keep their place against the new flat: wrong within 4 dB of it on a phone; solved 3-10 dB above it as heard, under rushEnd + 3', () => {
  for (const v of VOICES) {
    const w = heard(Float64Array.from(SOUNDS.wrong.render(SR, { voice: v }))), p = M[v].flatBoard.h;
    assert.ok(Math.abs(w.phone - p.phone) < 4, `${v}: wrong ${w.phone.toFixed(1)} vs flat ${p.phone.toFixed(1)} on a phone`);
    const s = heard(Float64Array.from(SOUNDS.solved.render(SR))).full, e = heard(Float64Array.from(SOUNDS.rushEnd.render(SR))).full;
    assert.ok(s - p.full > 3 && s - p.full < 10, `${v}: solved - flat = ${(s - p.full).toFixed(1)} dB`);
    assert.ok(s < e + 3);
  }
});

test('pieceSound and moveSounds: which sounds a move makes, one per piece landing, slightly irregular drops', () => {
  const { pieceSound, moveSounds, DROP_GAP_MS, DROP_JITTER } = mod;
  assert.equal(pieceSound({ piece: 'flat', onto: 'board' }), 'flatBoard');
  assert.equal(pieceSound({ piece: 'flat', onto: 'piece', drop: true }), 'dropPiece');
  assert.equal(pieceSound({ piece: 'wall', onto: 'piece', drop: true }), 'wallPiece', 'a wall ending a spread makes its own sound');
  assert.equal(pieceSound({ piece: 'cap', onto: 'board' }), 'capBoard');
  assert.equal(pieceSound({}), 'flatBoard');
  assert.deepEqual(moveSounds('a1'), [[0, 'flatBoard']]);
  assert.deepEqual(moveSounds('Sd4'), [[0, 'wallBoard']]);
  assert.deepEqual(moveSounds('Cc3'), [[0, 'capBoard']]);
  assert.deepEqual(moveSounds(undefined), [[0, 'flatBoard']]);
  const s = moveSounds({ ptn: '5a1>2111', top: 'cap', onto: ['board', 'piece', 'piece', 'board'] }, { seed: 7 });
  assert.deepEqual(s.map((e) => e[1]), ['dropBoard', 'dropPiece', 'dropPiece', 'capBoard']);
  assert.equal(s[0][0], 0);
  const gaps = s.slice(1).map((e, i) => e[0] - s[i][0]);
  for (const g of gaps) assert.ok(g >= DROP_GAP_MS * (1 - DROP_JITTER) - 1 && g <= DROP_GAP_MS * (1 + DROP_JITTER) + 1, `gap ${g}`);
  assert.ok(new Set(gaps).size > 1, 'not a mechanical trill');
  assert.deepEqual(moveSounds({ ptn: '2c2<11', smash: true, top: 'cap' }, { seed: 1 }).map((e) => e[1]), ['dropPiece', 'smash']);
  assert.deepEqual(moveSounds({ ptn: 'c2<', smash: true, top: 'cap' }).map((e) => e[1]), ['smash']);
  assert.deepEqual(moveSounds('c2<').map((e) => e[1]), ['dropPiece'], 'onto unknown: a piece');
  assert.deepEqual(moveSounds({ ptn: 'Sa1', smash: false }), [[0, 'wallBoard']]);
  assert.deepEqual(moveSounds('3c3+', { seed: 2 }), moveSounds('3c3+', { seed: 2 }), 'a seed fixes the timing');
});

test('playback in node: play/playMove/unlock are silent no-ops that never throw; setEnabled/isEnabled', () => {
  assert.equal(isEnabled(), true);
  unlock(); play('flatBoard'); play('nope'); play();
  mod.playMove('a1'); mod.playMove('3a1>12', true, { top: 'cap' }); mod.playSeq([[0, 'smash'], [90, 'x']]);
  setEnabled(false); assert.equal(isEnabled(), false);
  play('solved');
  setEnabled(true); assert.equal(isEnabled(), true);
  mod.later('wrong', 0); mod.listen();
});

test('render-sounds.mjs: no session path baked in as its default output', () => {
  const r = fs.readFileSync(root + 'scripts/render-sounds.mjs', 'utf8');
  assert.ok(!/\/private\/tmp|claude-\d+|scratchpad/.test(r));
  assert.match(r, /os\.tmpdir\(\)/);
});

// Playback against a fake AudioContext (a fresh copy of the module, imported after the fake window exists).
await atest('playback: activation rules, resume-then-play, Off suspends, voices cached, variants never repeat, drops timed on the audio clock', async () => {
  const made = [];
  class FakeAC {
    constructor() { this.state = 'suspended'; this.sampleRate = 48000; this.destination = {}; this.started = []; this.currentTime = 10; made.push(this); }
    resume() { this.resumes = (this.resumes || 0) + 1; this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createBuffer(c, n) { (this.lens ||= []).push(n); const d = new Float32Array(n); return { length: n, getChannelData: () => d }; }
    createBufferSource() { const src = { connect() {}, disconnect() {}, start: (when) => this.started.push({ len: src.buffer.length, buf: src.buffer, when }) }; return src; }
  }
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const ua = { hasBeenActive: false };
  globalThis.window = { AudioContext: FakeAC };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userActivation: ua } });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms)), tick = () => wait(0);
  try {
    const s = await import('../public/sound.js?fake');
    // a touch press makes no context; the touchend (an activating event) does
    s.unlock({ type: 'pointerdown', pointerType: 'touch' });
    assert.equal(made.length, 0, 'touch pointerdown creates no context');
    s.unlock({ type: 'touchend' });
    assert.equal(made.length, 1);
    const ac = made[0];
    // a sound asked for while the context is still suspended plays once it resumes
    ac.state = 'suspended';
    s.play('flatBoard'); await tick();
    assert.equal(ac.started.length, 1, 'played after resume');
    // Off suspends the context; On + a gesture resumes it
    s.setEnabled(false); assert.equal(ac.state, 'suspended');
    s.play('capBoard'); await tick(); assert.equal(ac.started.length, 1, 'silent while off');
    s.setEnabled(true); s.unlock(); assert.equal(ac.state, 'running');
    // variants: ten flats in a row, never the same buffer twice running, and more than one of them used
    const before = ac.started.length;
    for (let i = 0; i < 10; i++) { await wait(45); s.play('flatBoard'); }
    const bufs = ac.started.slice(before).map((e) => e.buf);
    assert.equal(bufs.length, 10);
    for (let i = 1; i < bufs.length; i++) assert.notEqual(bufs[i], bufs[i - 1], 'no immediate repeat');
    assert.ok(new Set(bufs).size >= 2);
    // the voice: each voice its own buffers; an unvoiced sound one buffer
    const len = (name, voice, variant) => s.SOUNDS[name].render(48000, { voice, variant }).length;
    s.setVoice('deep'); await wait(45); s.play('capBoard');
    assert.ok([0, 1, 2, 3].some((v) => ac.started.at(-1).len === len('capBoard', 'deep', v)));
    s.setVoice('nope'); assert.equal(s.getVoice(), 'deep', 'only a real voice changes it');
    const sl = s.SOUNDS.solved.render(48000).length, solvedBufs = () => ac.lens.filter((n) => n === sl).length; // (a change of voice warms the move sounds meanwhile)
    s.play('solved'); const nb = solvedBufs(); s.setVoice('light'); await wait(45); s.play('solved');
    assert.equal(solvedBufs(), nb, 'solved has one voice: one buffer');
    // a stack move played at once: one buffer per drop, started on the audio clock at its delay, irregular gaps
    const k = ac.started.length;
    await wait(45); s.playMove('4a1>1111', false, { onto: ['board', 'piece', 'piece', 'piece'] });
    const st = ac.started.slice(k);
    assert.equal(st.length, 4);
    assert.equal(st[0].when, undefined, 'the first now');
    for (let i = 1; i < 4; i++) assert.ok(st[i].when > (st[i - 1].when ?? 10), 'later and later');
  } finally {
    delete globalThis.window;
    if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator;
  }
  // a fresh copy, no gesture our listeners saw, but the page was activated (a tap inside the PTN Ninja iframe)
  made.length = 0;
  globalThis.window = { AudioContext: FakeAC };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userActivation: ua } });
  try {
    const s = await import('../public/sound.js?fake2');
    ua.hasBeenActive = false;
    s.play('flatBoard'); await tick();
    assert.equal(made.length, 0, 'never activated: no context, silent');
    ua.hasBeenActive = true;
    s.playMove('a1'); await tick();
    assert.equal(made.length, 1, 'activated elsewhere: play() starts the context');
    assert.equal(made[0].started.length, 1, 'and the move clicks');
    s.later('wrong', 0); await wait(5);
    assert.equal(made[0].started.length, 2, 'later() needs no context made beforehand');
  } finally {
    delete globalThis.window;
    if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator;
  }
});

console.log(`all ${n} passed`);
