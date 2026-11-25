// Render every sound in public/sound.js to 16-bit mono 48 kHz WAV and print its numbers.
//   node scripts/render-sounds.mjs [outdir]
// The move sounds: every voice and variant (flatBoard.thunk.v2.wav), and the default voice's first take under the
// plain name (flatBoard.wav); plus a few stack moves played at once as the player hears them (spread3.thunk.wav: the
// drops of moveSounds, on pieces). wrong and rushGood once per voice (wrong.deep.wav) and plain; the rest once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SOUNDS, VOICES, DEFAULT_VOICE, VARIANTS, loudness, moveSounds } from '../public/sound.js';

const out = process.argv[2] || path.join(os.tmpdir(), 'tinue-sounds');
const SR = 48000;
fs.mkdirSync(out, { recursive: true });

function wav(x, sr) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + 2 * i);
  return b;
}

// Spectral centroid and the share of energy above 4 kHz and 8 kHz, from a plain DFT (25 Hz bins up to 12 kHz).
function spectrum(x, sr) {
  let num = 0, den = 0, hi4 = 0, hi8 = 0;
  for (let f = 25; f <= 12000; f += 25) {
    const w = (2 * Math.PI * f) / sr;
    let re = 0, im = 0;
    for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
    const p = re * re + im * im;
    num += f * p; den += p;
    if (f > 4000) hi4 += p;
    if (f > 8000) hi8 += p;
  }
  return { centroid: num / den, hi4: hi4 / den, hi8: hi8 / den };
}

// A move played at once (as moveSounds gives it), mixed into one buffer.
function sequence(list, voice) {
  const parts = list.map(([ms, name], i) => [Math.round((ms * SR) / 1000), SOUNDS[name].render(SR, { voice, variant: i % VARIANTS })]);
  const x = new Float32Array(Math.max(...parts.map(([s, b]) => s + b.length)));
  for (const [s, b] of parts) for (let i = 0; i < b.length; i++) x[s + i] += b[i];
  return x;
}

const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const jobs = []; // [file, () => buffer]
for (const name of Object.keys(SOUNDS)) {
  const s = SOUNDS[name];
  if (s.move) {
    for (const voice of VOICES) for (let v = 0; v < VARIANTS; v++) jobs.push([`${name}.${voice}.v${v}`, () => s.render(SR, { voice, variant: v })]);
    jobs.push([name, () => s.render(SR, { voice: DEFAULT_VOICE, variant: 0 })]);
  } else {
    if (s.voiced) for (const voice of VOICES) jobs.push([`${name}.${voice}`, () => s.render(SR, { voice })]);
    jobs.push([name, () => s.render(SR, s.voiced ? { voice: DEFAULT_VOICE } : {})]);
  }
}
for (const d of [1, 3, 5]) for (const voice of VOICES)
  jobs.push([`spread${d}.${voice}`, () => sequence(moveSounds({ ptn: `${d}a1>${'1'.repeat(d)}` }, { seed: d }), voice)]);
for (const voice of VOICES)
  jobs.push([`spread3-cap-smash.${voice}`, () => sequence(moveSounds({ ptn: '3a1>111', top: 'cap', smash: true, onto: ['board', 'piece', 'piece'] }, { seed: 3 }), voice)]);

console.log('sound                    ms   peak dB  rms dB  loud dB  dc        first last  centroid  >4k%   >8k%');
for (const [file, make] of jobs) {
  const x = make();
  fs.writeFileSync(path.join(out, file + '.wav'), wav(x, SR));
  let peak = 0, ss = 0, dc = 0;
  for (const v of x) { peak = Math.max(peak, Math.abs(v)); ss += v * v; dc += v; }
  const s = spectrum(x, SR);
  console.log([file.padEnd(23), (x.length / SR * 1000).toFixed(0).padStart(4), db(peak).toFixed(1).padStart(8),
    db(Math.sqrt(ss / x.length)).toFixed(1).padStart(7), loudness(x, SR).toFixed(1).padStart(8),
    (dc / x.length).toExponential(1).padStart(9), String(x[0]).padStart(5), String(x[x.length - 1]).padStart(4),
    s.centroid.toFixed(0).padStart(9), (100 * s.hi4).toFixed(2).padStart(6), (100 * s.hi8).toFixed(3).padStart(6)].join(' '));
}
console.log('wrote', jobs.length, 'files to', out);
