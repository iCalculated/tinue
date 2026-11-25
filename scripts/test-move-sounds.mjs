// The move sounds as the board plays them (board-kit.js hooks -> sound.js, wired as app.js wires them), on PTN Ninja's
// board (public/ninja.js NinjaBoard: its moves as PTN Ninja reports them, its replies, loads and jumps) and a fake
// AudioContext: what lands where picks the sound; a stack moved on PTN Ninja's board sounds as a whole when PTN Ninja
// reports the move (it reports only finished moves: no sound per stone as it is set down); a capstone flattening a wall
// is one smash; a move played back at once queues its drops on the audio clock and a jump to another position stops
// them; Off makes nothing. And the sound lab's pure part (public/sound-lab.js): its JSON round-trips to the same
// renders, and a device's own recipes count only on a beta build.
//   node --no-warnings scripts/test-move-sounds.mjs
import assert from 'node:assert/strict';

let n = 0;
const atest = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake Web Audio: every source started, with its buffer and start time; stop() noted.
const made = [];
class FakeAC {
  constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; this.started = []; this.currentTime = 5; made.push(this); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createBuffer(c, len) { const d = new Float32Array(len); return { length: len, getChannelData: () => d }; }
  createBufferSource() {
    const ac = this, src = { connect() {}, disconnect() {}, stop() { src.stopped = true; },
      start(when) { src.when = when; src.at = performance.now(); ac.started.push(src); } };
    return src;
  }
}
globalThis.window ??= { addEventListener() {} };
globalThis.document ??= { addEventListener() {}, hidden: false };
window.AudioContext = FakeAC;
const sound = await import('../public/sound.js');
const { buildPTN, hooks: H } = await import('../public/board-kit.js');
const { NinjaBoard } = await import('../public/ninja.js');
const lab = await import('../public/sound-lab.js');
const { SOUNDS, MOVE_SOUNDS, VARIANTS } = sound;

// app.js's wiring, with a log of what the hooks were given
const hooks = [];
H.onPly = (ptn, smash, info) => { hooks.push(['ply', ptn, !!info?.byHand]); sound.playMove(ptn, smash, info); };
H.onLand = (list) => { hooks.push(['land']); sound.playLanding(list); };
H.onCut = () => { hooks.push(['cut']); sound.cut(); };

// which sound a started buffer is (the renders are deterministic: compare with each take's render)
const renders = new Map();
const renderOf = (name, v) => { const k = name + v; if (!renders.has(k)) renders.set(k, SOUNDS[name].render(48000, { voice: 'thunk', variant: v })); return renders.get(k); };
function nameOf(buf) {
  const d = buf.getChannelData(0);
  for (const name of MOVE_SOUNDS) for (let v = 0; v < VARIANTS; v++) {
    const r = renderOf(name, v);
    if (r.length === d.length && r.every((x, i) => x === d[i])) return name;
  }
  return '?';
}
const ac = () => made[0];
const mark = () => { const k = ac()?.started.length ?? 0, h = hooks.length; return () => ({ srcs: (ac()?.started ?? []).slice(k), hooks: hooks.slice(h) }); };
const names = (srcs) => srcs.map((s) => nameOf(s.buffer));

// PTN Ninja's board, up, with its frame faked: what it posts goes nowhere; a move made on it arrives as PTN Ninja reports
// it (INSERT_PLY, _heard), exactly as on the page.
const moves = [];
const board = Object.assign(Object.create(NinjaBoard.prototype), { opts: { disableBoard: false }, hl: [], lockUntil: 0, onMove: (m) => moves.push(m),
  iframe: { dataset: { up: '1' } }, _send: async () => {}, _post() {}, _settle() {}, _shape() {}, _afterDraw() {}, _focus() {} });
const onNinja = (ptn) => board._heard('INSERT_PLY', ptn);
// positions (5x5, white to move): a3 a white stack of 3 flats (or with a cap / a wall on top), c3 a black flat or wall
const pos = (a3, c3 = '2') => buildPTN({ size: 5, tps: `x5/x5/${a3},x,${c3},x2/x5/x5 1 6` });
async function at(ptn) { await board.load(ptn); await board.last(); await board.setPlayer(null); await board.ui({ disableBoard: false }); moves.length = 0; await sleep(50); }

await atest('Off: a placement, a spread on PTN Ninja\'s board and a replayed one create no AudioContext at all', async () => {
  sound.setEnabled(false);
  sound.unlock();
  await at(pos('111'));
  onNinja('3a3>111'); await sleep(20);
  await board.append('e5'); await board.append('b3>'); await sleep(20);
  assert.deepEqual(moves, ['3a3>111']);
  assert.equal(made.length, 0, 'no context');
  sound.setEnabled(true);
  sound.unlock();
  assert.equal(made.length, 1);
});

await atest('placements on PTN Ninja\'s board: a flat, a wall, a capstone each make their own sound, once', async () => {
  for (const [ptn, want] of [['b2', 'flatBoard'], ['Sb2', 'wallBoard'], ['Cb2', 'capBoard']]) {
    await at(pos('111'));
    const m = mark();
    onNinja(ptn); await sleep(30);
    assert.deepEqual(moves, [ptn]);
    assert.deepEqual(names(m().srcs), [want], ptn);
    assert.deepEqual(m().hooks, [['ply', ptn, false]]);
  }
});

await atest('a 3-drop spread made on PTN Ninja\'s board: its three drops when PTN Ninja reports the move (not as each stone is set down)', async () => {
  await at(pos('111')); // b3 empty, c3 a black flat, d3 empty
  const m = mark();
  onNinja('3a3>111'); await sleep(300);
  const r = m();
  assert.deepEqual(moves, ['3a3>111']);
  assert.deepEqual(names(r.srcs), ['dropBoard', 'dropPiece', 'dropBoard'], 'board, piece, board');
  assert.equal(r.srcs[0].when, undefined); assert.ok(r.srcs[1].when > 5 && r.srcs[2].when > r.srcs[1].when, 'the later drops queued after the first');
  assert.deepEqual(r.hooks.filter((h) => h[0] === 'ply'), [['ply', '3a3>111', false]]);
  assert.ok(!r.hooks.some((h) => h[0] === 'land'), 'no per-stone landings (PTN Ninja reports only finished moves)');
});

await atest('a stack whose top is a capstone or a wall: its last landing is that piece\'s own sound, on the board or on a piece', async () => {
  for (const [a3, ptn, want] of [['11C', '2a3>11', ['dropBoard', 'capPiece']], ['11S', '2a3>11', ['dropBoard', 'wallPiece']], ['1C', 'a3>', ['capBoard']]]) {
    await at(pos(a3));
    const m = mark();
    onNinja(ptn); await sleep(300);
    assert.deepEqual(names(m().srcs), want, a3);
  }
});

await atest('a capstone flattening a wall as the last drop: smash, once, never also the cap\'s', async () => {
  await at(pos('11C', '2S'));
  let m = mark();
  onNinja('2a3>11*'); await sleep(300);
  assert.deepEqual(moves, ['2a3>11'], 'canonical PTN (the smash is the board\'s to know)');
  assert.deepEqual(names(m().srcs), ['dropBoard', 'smash']);
  await at(pos('111C', '2S'));
  m = mark();
  onNinja('3a3>21*'); await sleep(300);
  const r = m();
  assert.deepEqual(names(r.srcs), ['dropBoard', 'smash'], 'as a whole move sounds (sound.js moveSounds): the cap\'s drop is the smash');
  assert.equal(names(r.srcs).filter((x) => x === 'smash').length, 1);
});

await atest('verdicts wait for the move\'s own sounds: after a click, at the usual beat; after a spread, after its drops', async () => {
  await at(pos('1', '2'));
  onNinja('b2'); await sleep(50);
  assert.equal(sound.verdict('rushGood', 45), 45, 'a click: the usual beat');
  await sleep(200);
  await at(pos('111'));
  onNinja('3a3>111');
  const d = sound.verdict('solved', 170);
  assert.ok(d > 170, `solved waits for the queued drops: ${d}`);
  await sleep(d + 100);
});

await atest('Rush\'s next puzzle: its intro move sounds after the verdict, not on top of it; a jump drops a held move sound', async () => {
  await at(pos('111'));
  const m = mark(), t0 = performance.now();
  onNinja('b2'); // the player's last move of the puzzle (a miss)
  const d = sound.verdict('wrong', 80, 130);
  await board.load(pos('111')); await board.last(); await board.append('e5'); // calm(): the intro move at once
  assert.equal(m().srcs.length, 1, 'only the player\'s flat so far');
  await sleep(d + 200);
  const r = m(), intro = r.srcs.filter((s) => nameOf(s.buffer) === 'flatBoard')[1], wrong = r.srcs.find((s) => nameOf(s.buffer) === '?');
  assert.ok(wrong && intro, 'the verdict and the intro both played');
  assert.ok(intro.at - t0 >= d + 125, `the intro ${Math.round(intro.at - t0)} ms, after the wrong sound's knocks (${d} + 130)`);
  sound.holdMoves(100);
  const k = m().srcs.length;
  await board.append('d1'); await board.goTo(0); await sleep(150);
  assert.equal(m().srcs.length, k, 'a held move sound is dropped when the board jumps');
});

await atest('a spread played back at once queues its drops on the audio clock; a jump to another position stops the queued ones', async () => {
  await at(pos('111'));
  let m = mark();
  await board.append('3a3>111'); await board.last(); // the reply, then the app's last(): the same position, no cut
  let r = m();
  assert.deepEqual(names(r.srcs), ['dropBoard', 'dropPiece', 'dropBoard']);
  assert.equal(r.srcs[0].when, undefined);
  assert.ok(r.srcs[1].when > 5 && r.srcs[2].when > r.srcs[1].when, 'later drops queued');
  const g1 = r.srcs[1].when - 5, g2 = r.srcs[2].when - r.srcs[1].when;
  for (const g of [g1, g2]) assert.ok(g >= 0.083 && g <= 0.127, 'about 105 ms ± 20% apart: ' + g);
  assert.ok(!r.srcs.some((s) => s.stopped), 'last() after append() cuts nothing');
  assert.ok(!r.hooks.some((h) => h[0] === 'cut'));
  await board.goTo(-1); // step back to the start
  r = m();
  assert.ok(r.hooks.some((h) => h[0] === 'cut'));
  assert.deepEqual(r.srcs.map((s) => !!s.stopped), [false, true, true], 'the two queued drops stopped');
  m = mark();
  const sn = board.snaps[1];
  sound.playMove(sn.ptn, sn.smash, sn.land); // stepping forward (app.js navTo plays it with the snapshot's land)
  assert.deepEqual(names(m().srcs), ['dropBoard', 'dropPiece', 'dropBoard']);
  await sleep(300);
});

await atest('the board model gives each snapshot what it set down (landOf), for replies, solutions and steps', async () => {
  await board.load(buildPTN({ size: 5, tps: 'x5/x5/111C,x,2S,x2/x5/x5 1 6', moves: ['Sb1', 'Ce5', 'd1', 'e4', '3a3>21*'] }));
  assert.deepEqual(board.snaps.slice(1).map((s) => s.land), [{ piece: 'wall' }, { piece: 'cap' }, { piece: 'flat' }, { piece: 'flat' }, { top: 'cap', onto: ['board', 'piece'] }]);
  assert.equal(board.snaps[5].smash, true);
  assert.deepEqual(sound.moveSounds({ ptn: '3a3>21*', smash: true, ...board.snaps[5].land }, { seed: 1 }).map((e) => e[1]), ['dropBoard', 'smash']);
});

// ---------- the sound lab ----------
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
await atest('lab: the built-in sliders reproduce the built-in sounds exactly; the copied JSON parses back to the same renders', async () => {
  const def = lab.editSet({});
  for (const name of MOVE_SOUNDS) for (const v of [0, 3])
    assert.ok(same(sound.renderRecipe(sound.recipeFrom(def[name], name, 'deep', v), 44100), SOUNDS[name].render(44100, { voice: 'deep', variant: v })), name + v);
  const state = { flatBoard: { pitch: 0.9, bodyGain: 1.8, bounceAt: 30, bounceGain: 0.4, level: 2 }, capBoard: { bounceGain: 0.3, bounceAt: 15 },
    smash: { gap: 120, slap: 1.6 }, dropBoard: { under: 6 }, wallBoard: { clickHi: 1.3, modeMs: 0.7, pitch: 9 } };
  const edited = lab.editSet(state), text = lab.exportSet(state), back = lab.parseSet(text);
  assert.equal(edited.dropBoard.level, edited.flatBoard.level - 6, 'a drop sits its "under" below its placement');
  assert.equal(edited.smash.events[1].at, 120);
  assert.equal(edited.capBoard.events.length, 2, 'a bounce added where there was none');
  assert.equal(back.params.wallBoard.pitch, 1.4, 'clamped to the slider');
  for (const name of MOVE_SOUNDS) for (const v of [0, 2]) {
    const a = sound.renderRecipe(sound.recipeFrom(edited[name], name, 'thunk', v), 48000), b = sound.renderRecipe(sound.recipeFrom(back.sounds[name], name, 'thunk', v), 48000);
    assert.ok(same(a, b), name + v);
  }
  assert.ok(!same(sound.renderRecipe(sound.recipeFrom(edited.flatBoard, 'flatBoard'), 48000), SOUNDS.flatBoard.render(48000, {})), 'an edit changes the sound');
  assert.deepEqual(lab.parseSet(lab.exportSet(back.params)).params, back.params, 'params round-trip');
  assert.throws(() => lab.parseSet('{"x":1}'));
  assert.deepEqual(back.raw, {}, 'a lab export carries no raw recipes');
  // a fitted recipe pasted in whole: kept as it is (sliders inactive), exported and parsed back the same
  const fitted = { level: -26, events: [{ at: 0, gain: 1, contact: { ms: 2, lo: 300, hi: 4000, gain: 0.5 }, modes: [{ f: 640, ms: 30, gain: 1, phase: 0.2 }], body: null }] };
  const p2 = lab.parseSet({ sounds: { flatBoard: fitted } });
  assert.deepEqual(Object.keys(p2.raw), ['flatBoard']);
  const p3 = lab.parseSet(lab.exportSet(p2.params, p2.raw));
  assert.deepEqual(p3.raw.flatBoard, fitted);
});

await atest('lab: the labels say what the sliders do (balance, not loudness); Bounce time is inert without a bounce', async () => {
  const P = Object.fromEntries(lab.PARAMS.map((p) => [p.key, p]));
  assert.equal(P.bodyGain.label, 'Board body vs click'); assert.equal(P.clickGain.label, 'Click vs body');
  for (const name of ['capBoard', 'capPiece', 'dropBoard', 'dropPiece']) {
    assert.equal(lab.defaultsFor(name).bounceGain, 0, name);
    assert.deepEqual(lab.editSet({ [name]: { bounceAt: 50 } })[name], lab.editSet({})[name], name + ': bounce time alone changes nothing (the page disables it)');
  }
  const src = (await import('node:fs')).readFileSync(new URL('../public/sound-lab.js', import.meta.url), 'utf8');
  assert.match(src, /isEnabled\(\)/, 'the lab says when Sound is Off');
  assert.match(src, /data-a="orig"/); assert.match(src, /data-a="ab"/);
  assert.match(src, /id="sl-load"/);
  assert.match(src, /@media \(pointer: coarse\) \{ \.sl button \{ height: auto; min-height: 36px; \}/);
});

await atest('lab: a device\'s own recipes play only on a beta build (window.TINUE_BETA); off it, setCustom and loadCustom do nothing', async () => {
  const edited = lab.editSet({ flatBoard: { pitch: 1.2, level: -3 } });
  const builtIn = sound.recipeFor('flatBoard', 'thunk', 1);
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  store.set(sound.CUSTOM_KEY, JSON.stringify({ tinueSoundLab: 1, sounds: edited }));
  try {
    delete window.TINUE_BETA;
    assert.equal(sound.setCustom(edited), false);
    assert.equal(sound.loadCustom(), false);
    assert.equal(sound.getCustom(), null);
    assert.deepEqual(sound.recipeFor('flatBoard', 'thunk', 1), builtIn, 'not beta: the built-in recipe');
    window.TINUE_BETA = 'sounds@test';
    assert.equal(sound.loadCustom(), true);
    assert.deepEqual(sound.recipeFor('flatBoard', 'thunk', 1), sound.recipeFrom(edited.flatBoard, 'flatBoard', 'thunk', 1), 'beta: the stored recipe');
    // and the board plays it: a flat placed sounds the edited render
    const m = mark();
    await at(pos('111')); onNinja('b2'); await sleep(50);
    const d = m().srcs.at(-1).buffer.getChannelData(0);
    assert.ok([0, 1, 2, 3].some((v) => same(d, sound.renderRecipe(sound.recipeFrom(edited.flatBoard, 'flatBoard', 'thunk', v), 48000))));
    delete window.TINUE_BETA; // a page that is not beta ignores what is set, even mid-session
    assert.deepEqual(sound.recipeFor('flatBoard', 'thunk', 1), builtIn);
    window.TINUE_BETA = 'sounds@test';
    sound.setCustom(null);
    assert.deepEqual(sound.recipeFor('flatBoard', 'thunk', 1), builtIn, 'Back to built-in');
  } finally { delete window.TINUE_BETA; delete globalThis.localStorage; sound.setCustom(null); }
});

await atest('lab: a recipe sound.js cannot render is refused on paste and left out on a device (the built-in plays), never a silent move', async () => {
  const ok = lab.editSet({}).flatBoard;
  const broken = [{ ...ok, events: [null] }, { ...ok, events: [{ ...ok.events[0], contact: { ...ok.events[0].contact, ms: 1e100 } }] },
    { ...ok, events: [{ ...ok.events[0], modes: { f: 400, ms: 30, gain: 1 } }] }, { ...ok, events: [{ ...ok.events[0], body: { f: 'x', ms: 30, gain: 1 } }] }];
  for (const r of broken) {
    assert.equal(sound.validRecipe(r), false, JSON.stringify(r).slice(0, 80));
    assert.throws(() => lab.parseSet({ sounds: { flatBoard: r } }), /flatBoard/);
  }
  window.TINUE_BETA = 'sounds@test';
  try {
    for (const r of broken) {
      assert.equal(sound.setCustom({ flatBoard: r }), false, 'nothing usable: the built-in set');
      sound.setCustom({ flatBoard: r, dropBoard: lab.editSet({ dropBoard: { pitch: 1.1 } }).dropBoard });
      assert.deepEqual(Object.keys(sound.getCustom()), ['dropBoard'], 'the broken entry is left out');
      assert.ok(sound.SOUNDS.flatBoard.render(48000, {}).length > 0, 'flatBoard still renders');
    }
  } finally { delete window.TINUE_BETA; sound.setCustom(null); }
});

await atest('lab: a recording is played as the mono mix it was measured as, so level matching cannot clip it or mis-level it', async () => {
  const sr = 48000, L = Float32Array.from({ length: 4800 }, (_, i) => 0.98 * Math.sin(i / 7) * Math.exp(-i / 900));
  const synLvl = sound.loudness(sound.SOUNDS.flatBoard.render(sr, {}), sr);
  for (const [what, chans] of [['anti-phase', [L, L.map((v) => -0.98 * v)]], ['one-sided', [L, new Float32Array(L.length)]], ['mono', [L]]]) {
    const mono = lab.monoOf(chans), g = lab.matchGain(synLvl, mono, sr);
    let peak = 0; for (const v of mono) peak = Math.max(peak, Math.abs(v * g));
    assert.ok(peak <= 0.99 + 1e-9, `${what}: played peak ${peak}`);
    const lvl = sound.loudness(mono.map((v) => v * g), sr);
    assert.ok(lvl <= synLvl + 0.01 && (lvl > synLvl - 0.01 || peak > 0.98), `${what}: played at ${lvl.toFixed(1)} dB vs the synth's ${synLvl.toFixed(1)}`);
  }
  const src = (await import('node:fs')).readFileSync(new URL('../public/sound-lab.js', import.meta.url), 'utf8');
  assert.match(src, /rec\.buf = m;/, 'the mono mix is what plays');
});

await atest('lab: its own context sleeps when idle; leave() stops its sounds and closes it (app.js calls it when the page is left)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../public/sound-lab.js', import.meta.url), 'utf8'), app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /ac\.suspend\(\)/); assert.match(src, /export function leave\(\)/); assert.match(src, /a\?\.close\(\)/);
  assert.match(app, /if \(page !== 'sounds'\) labPage\?\.leave\(\)/);
  // driven: a fake context, five takes started, then leave()
  const made = [];
  const was = window.AudioContext;
  window.AudioContext = class { constructor() { this.state = 'running'; this.sampleRate = 48000; this.currentTime = 1; this.destination = {}; made.push(this); }
    resume() { this.state = 'running'; return Promise.resolve(); } suspend() { this.state = 'suspended'; return Promise.resolve(); } close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createBuffer(c, len, rate) { const d = new Float32Array(len); return { length: len, sampleRate: rate, duration: len / rate, getChannelData: () => d }; }
    createBufferSource() { const s = { connect() {}, disconnect() {}, start() { s.on = true; }, stop() { s.stopped = true; } }; (this.srcs ||= []).push(s); return s; } };
  const el = { innerHTML: '', querySelector: () => ({ classList: { toggle() {} }, textContent: '', querySelectorAll: () => [] }), querySelectorAll: () => [] };
  const doc = globalThis.document;
  globalThis.document = { getElementById: () => ({}), head: { append() {} }, createElement: () => ({}) };
  try {
    lab.enter(el);
    el.onclick({ target: { closest: (s) => (s === 'button' ? { dataset: { a: 'five' }, closest: () => ({ dataset: { s: 'smash' } }) } : null) } });
    const ac = made.at(-1);
    assert.equal(ac.srcs.length, 5);
    await sleep(2500);
    assert.equal(ac.state, 'running', 'awake while the five takes play (about 2.2 s)');
    await sleep(1600);
    assert.equal(ac.state, 'suspended', 'asleep 1.5 s after the last one ends');
    el.onclick({ target: { closest: (s) => (s === 'button' ? { dataset: { a: 'five' }, closest: () => ({ dataset: { s: 'smash' } }) } : null) } });
    lab.leave();
    assert.equal(ac.state, 'closed');
    assert.ok(ac.srcs.slice(-5).every((s) => s.stopped), 'the five takes stop when the page is left');
  } finally { window.AudioContext = was; globalThis.document = doc; }
});

console.log(`all ${n} passed`);
process.exit(0);
