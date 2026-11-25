// The fitter (scripts/fit-sound.mjs) on our own synth: render known recipes into a WAV of several takes, fit it, and
// recover the modes, the body, the bounce and the sound itself.   node scripts/test-fit-sound.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderRecipe, recipeFor, SOUNDS } from '../public/sound.js';
import { readWav, wav16, fitRecording, distance, findTakes } from './fit-sound.mjs';
import * as fitMod from './fit-sound.mjs';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const SR = 48000, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-fit-'));

// Three takes of a flat on the board (the thunk recipe, with its bounce), each with its own noise, 350 ms apart, then
// two takes of the capstone; written as 16-bit WAV (so the reader and the quantisation are part of the test).
const flat = recipeFor('flatBoard', 'thunk', 0), cap = recipeFor('capBoard', 'thunk', 0);
const plan = [[flat, 1], [flat, 2], [flat, 3]], plan2 = [[cap, 1], [cap, 2]];
function recording(list) {
  const x = new Float64Array(Math.round(SR * (0.15 + 0.35 * list.length)));
  const at = list.map(([r, seed], i) => { const s = Math.round(SR * (0.1 + 0.35 * i)); x.set(renderRecipe({ ...r, seed }, SR), s); return s; });
  return { x, at };
}
const A = recording(plan), B = recording(plan2);
fs.writeFileSync(path.join(dir, 'flat.wav'), wav16(A.x, SR));
fs.writeFileSync(path.join(dir, 'cap.wav'), wav16(B.x, SR));

// The truth's modes that must come back: those whose spectral peak, (gain x T60)^2, is within 10 dB of the strongest
// mode's (the weaker ones, short and high, are mostly gone before the contact is); and the body.
const truth = (r) => {
  const all = r.events[0].modes.map((m) => ({ ...m, h: (Math.abs(m.gain) * m.ms) ** 2 })), top = Math.max(...all.map((m) => m.h));
  return all.filter((m) => m.h > top / 10).concat([r.events[0].body]);
};
const fitted = (rec) => { const e = rec.events[0]; return [...e.modes, ...(e.body ? [e.body] : [])]; };
// every wanted mode has a fitted one within df (fraction) in frequency, and that one's T60 within dt (fraction)
function recovers(want, got, tag, df, dt) {
  for (const m of want) {
    const best = got.reduce((b, q) => (Math.abs(q.f / m.f - 1) < Math.abs(b.f / m.f - 1) ? q : b));
    assert.ok(Math.abs(best.f / m.f - 1) < df, `${tag}: mode ${m.f.toFixed(0)} Hz: nearest fitted ${best.f.toFixed(0)} Hz`);
    assert.ok(Math.abs(best.ms / m.ms - 1) < dt, `${tag}: mode ${m.f.toFixed(0)} Hz: T60 ${best.ms.toFixed(1)} ms, truth ${m.ms.toFixed(1)}`);
  }
}
const worst = { f: 0, t: 0 }; // (reported)
const track = (want, got) => { for (const m of want) { const b = got.reduce((p, q) => (Math.abs(q.f / m.f - 1) < Math.abs(p.f / m.f - 1) ? q : p)); worst.f = Math.max(worst.f, Math.abs(b.f / m.f - 1)); worst.t = Math.max(worst.t, Math.abs(b.ms / m.ms - 1)); } };

const { x: xa, sr: sra } = readWav(path.join(dir, 'flat.wav')), { x: xb } = readWav(path.join(dir, 'cap.wav'));
const RA = fitRecording(xa, sra), RB = fitRecording(xb, SR);

test('WAV round trip and the takes: one per placement, each starting within 1.5 ms of where it was put', () => {
  assert.equal(sra, SR);
  assert.equal(xa.length, A.x.length);
  for (const [R, T] of [[RA, A], [RB, B]]) {
    assert.equal(R.takes.length, T.at.length);
    R.takes.forEach((t, i) => assert.ok(Math.abs(t.start - T.at[i]) < 0.0015 * SR, `take ${i}: ${t.start} vs ${T.at[i]}`));
  }
  assert.equal(findTakes(new Float64Array(SR), SR).length, 0, 'silence has no takes');
});

test('the modes: every strong one back within 4% in frequency and 50% in T60 in each take; on the average of the takes within 2.5% and 30%', () => {
  for (const [R, r, tag] of [[RA, flat, 'flat'], [RB, cap, 'cap']]) {
    R.takes.forEach((t, i) => { recovers(truth(r), fitted(t.recipe), `${tag} take ${i}`, 0.04, 0.5); track(truth(r), fitted(t.recipe)); });
    recovers(truth(r), fitted(R.average), `${tag} average`, 0.025, 0.3);
    const b = R.average.events[0].body;
    assert.ok(b && Math.abs(b.f / r.events[0].body.f - 1) < 0.02, `${tag}: body ${JSON.stringify(b)}`);
  }
});

test('the capstone (no bounce): no second event', () => {
  RB.takes.forEach((t) => assert.equal(t.recipe.events.length, 1, JSON.stringify(t.recipe.events.map((e) => e.at))));
});

test('the bounce: a second event within 2.5 ms of its time, weaker than the first', () => {
  for (const t of RA.takes) {
    const ev = t.recipe.events;
    assert.equal(ev.length, 2, JSON.stringify(ev.map((e) => e.at)));
    assert.ok(Math.abs(ev[1].at - flat.events[1].at) < 2.5, `bounce at ${ev[1].at}`);
    assert.ok(ev[1].contact.gain < ev[0].contact.gain, 'weaker contact');
  }
});

test('the contact: its length within 50% and its upper edge within an octave of the truth', () => {
  const c = flat.events[0].contact;
  for (const t of RA.takes) {
    const f = t.recipe.events[0].contact;
    assert.ok(f.ms > c.ms / 1.5 && f.ms < c.ms * 1.5, `contact ${f.ms} ms vs ${c.ms}`);
    assert.ok(f.hi > c.hi / 2 && f.hi < c.hi * 2, `contact hi ${f.hi} vs ${c.hi}`);
  }
});

let dists;
test('the resynthesis: within 4 dB (log-spectrogram) of each take and of the average, and far nearer than another sound', () => {
  const other = SOUNDS.wallPiece.render(SR, {});
  dists = RA.takes.map((t) => t.distance).concat(RB.takes.map((t) => t.distance));
  for (const t of [...RA.takes, ...RB.takes]) {
    assert.ok(t.distance < 4, `distance ${t.distance}`);
    assert.ok(distance(t.y, SR, other) > t.distance + 4, 'a different sound is much further');
  }
  assert.ok(RA.averageDistance < 4 && RB.averageDistance < 4, `average ${RA.averageDistance}, ${RB.averageDistance}`);
});

// Short, high sounds: a wall stood on the board (a 1.3 ms contact, modes up to 3.3 kHz ringing 8-22 ms, a weak body)
// and a stone set on a piece (dropPiece: modes to 3.3 kHz); three takes each. Fitting them must not leave out the
// short modes nor hand the contact's length to them.
const WALL = { level: -14, events: [{ at: 0, gain: 1, contact: { ms: 1.3, lo: 900, hi: 5000, gain: 0.9 },
  modes: [{ f: 1100, ms: 22, gain: 0.85 }, { f: 1450, ms: 18, gain: -1 }, { f: 1930, ms: 14, gain: 0.85 }, { f: 2530, ms: 10, gain: -0.7 }, { f: 3300, ms: 8, gain: 0.55 }],
  body: { f: 330, ms: 30, gain: 0.15 } }] };
const clack = recipeFor('dropPiece', 'thunk', 0);
const RW = fitRecording(recording([[WALL, 5], [WALL, 6], [WALL, 7]]).x, SR), RP = fitRecording(recording([[clack, 1], [clack, 2], [clack, 3]]).x, SR);
test('a wall: each take and the average within 3.5 dB; the strong modes back in the average (3%, 40%); the body within 3% and its T60 within 50%; the contact short', () => {
  for (const t of RW.takes) assert.ok(t.distance < 3.5, `take distance ${t.distance}`);
  assert.ok(RW.averageDistance < 3.5, `average ${RW.averageDistance}`);
  const e = RW.average.events[0];
  recovers(truth(WALL).slice(0, -1), e.modes, 'wall average', 0.03, 0.4);
  assert.ok(e.body && Math.abs(e.body.f / 330 - 1) < 0.03 && Math.abs(e.body.ms / 30 - 1) < 0.5, `body ${JSON.stringify(e.body)}`);
  assert.ok(e.contact.ms < 2.6, `contact ${e.contact.ms} ms (truth 1.3)`);
});
test('a stone set on a piece: every mode up to 3.3 kHz back in the average within 3%; the average within 4 dB', () => {
  recovers(clack.events[0].modes.filter((m) => m.f < 3400), RP.average.events[0].modes, 'on a piece', 0.03, 0.5);
  assert.ok(RP.averageDistance < 4, `average ${RP.averageDistance}`);
});

// What a recording can do wrong: DC and handling rumble, takes closer than --min-gap, two microphones, nothing at all.
test('DC and 30 Hz rumble are removed before fitting: the same takes and a fit as near as on the clean recording', () => {
  const clean = recording(plan).x, R0 = RA;
  const R1 = fitRecording(clean.map((v, i) => v + 0.01 + 0.03 * Math.sin((2 * Math.PI * 30 * i) / SR)), SR);
  assert.equal(R1.takes.length, 3, 'three takes, not one');
  assert.ok(R1.averageDistance < R0.averageDistance + 0.75, `rumble ${R1.averageDistance} vs clean ${R0.averageDistance}`);
  assert.ok(!R1.average.events[0].modes.some((m) => m.f < 100), 'no rumble mode');
});
test('takes closer than --min-gap: a warning, and the average only of the takes with the most common number of events', () => {
  const x = new Float64Array(Math.round(SR * 1.1));
  for (const [ms, seed] of [[100, 1], [180, 2], [700, 3], [950, 4]]) { const y = renderRecipe({ ...flat, seed }, SR), o = Math.round((ms * SR) / 1000); for (let i = 0; i < y.length; i++) x[o + i] += y[i]; }
  const R = fitRecording(x, SR);
  assert.equal(R.takes.length, 3);
  assert.ok(R.takes[0].warn.some((w) => /several pieces landing/.test(w)), JSON.stringify(R.takes[0].warn));
  assert.deepEqual(R.used, [1, 2]);
  assert.ok(R.warnings.some((w) => /averaged 2 of 3/.test(w)));
  assert.ok(R.averageDistance < 4, `average ${R.averageDistance}`);
});
test('a stereo file: the louder channel is fitted by default (two microphones mixed comb-filter); --channel picks one; the fit reports what the distance can hide', () => {
  const x = recording(plan).x, d = 24, y = new Float64Array(x.length);
  for (let i = d; i < x.length; i++) y[i] = 0.7 * x[i - d];
  const b = Buffer.alloc(44 + x.length * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 4, 40);
  for (let i = 0; i < x.length; i++) { b.writeInt16LE(Math.round(x[i] * 32767), 44 + 4 * i); b.writeInt16LE(Math.round(y[i] * 32767), 46 + 4 * i); }
  fs.writeFileSync(path.join(dir, 'st.wav'), b);
  const a = readWav(path.join(dir, 'st.wav')), m = readWav(path.join(dir, 'st.wav'), { channel: 'mix' }), r = readWav(path.join(dir, 'st.wav'), { channel: 1 });
  assert.equal(a.channel, 0); assert.equal(a.channels, 2);
  assert.ok(Math.abs(a.x[5000] - x[5000]) < 1e-4 && Math.abs(r.x[5000] - y[5000]) < 1e-4 && Math.abs(m.x[5000] - (x[5000] + y[5000]) / 2) < 1e-4);
  const t = RA.takes[0];
  assert.equal(t.check.take.shares.length, 6);
  assert.ok(t.check.peaks.length >= 3 && t.check.peaks.slice(0, 3).every((p) => p.mode != null), JSON.stringify(t.check.peaks));
});

test('a single take trimmed tight (no quiet in the clip) is one take; a constant offset on a silent channel does not win the channel choice', () => {
  const { clean } = fitMod;
  for (const t60 of [60, 150, 300]) {
    const x = Float64Array.from({ length: Math.round(0.032 * SR) }, (_, i) => 0.8 * Math.sin((2 * Math.PI * 900 * i) / SR) * 10 ** ((-3 * i) / ((t60 / 1000) * SR)));
    assert.equal(findTakes(clean(x, SR), SR).length, 1, `T60 ${t60} ms`);
  }
  const n2 = SR, b = Buffer.alloc(44 + n2 * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n2 * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n2 * 4, 40);
  const tap = Math.round(0.005 * SR);
  for (let i = 0; i < n2; i++) { b.writeInt16LE(1024, 44 + 4 * i); b.writeInt16LE(i >= 20000 && i < 20000 + tap ? Math.round(0.25 * 32767 * Math.sin(i / 3)) : 0, 46 + 4 * i); }
  fs.writeFileSync(path.join(dir, 'dc.wav'), b);
  const w = readWav(path.join(dir, 'dc.wav'));
  assert.equal(w.channel, 1, 'the channel with the tap');
  assert.equal(findTakes(clean(w.x, SR), SR).length, 1);
});

test('the command line writes the recipe JSON (the same format renderRecipe reads) and the resynthesis WAV', () => {
  const r = spawnSync(process.execPath, [new URL('./fit-sound.mjs', import.meta.url).pathname, path.join(dir, 'flat.wav'), '--out', dir, '--against', 'flatBoard'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 take\(s\)/);
  assert.match(r.stdout, /flatBoard as it is: distance/);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'flat.recipe.json'), 'utf8'));
  assert.equal(j.takes.length, 3);
  const y = renderRecipe(j.average, SR);
  assert.ok(y.length > 0 && y[0] === 0 && y[y.length - 1] === 0);
  const w = readWav(path.join(dir, 'flat.fit.wav'));
  assert.equal(w.x.length, xa.length);
  fs.writeFileSync(path.join(dir, 'quiet.wav'), wav16(new Float64Array(SR), SR));
  const q = spawnSync(process.execPath, [new URL('./fit-sound.mjs', import.meta.url).pathname, path.join(dir, 'quiet.wav'), '--out', dir], { encoding: 'utf8' });
  assert.equal(q.status, 1, 'silence: an error');
  assert.match(q.stderr, /no takes found/);
  assert.ok(!fs.existsSync(path.join(dir, 'quiet.recipe.json')) && !fs.existsSync(path.join(dir, 'quiet.fit.wav')), 'and nothing written');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`all ${n} passed (per take: worst frequency error ${(100 * worst.f).toFixed(1)}%, worst T60 error ${(100 * worst.t).toFixed(0)}%; distances ${dists.map((d) => d.toFixed(2)).join(' ')} dB)`);
