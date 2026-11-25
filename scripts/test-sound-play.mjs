// When and whether sounds play (public/sound.js playback, against a fake AudioContext): the context sleeps when idle
// and in a hidden tab and wakes for the next sound; Off stops what is queued; a move waiting for a resume is dropped
// when the board jumps; distinct landings are never merged; a cut move stops counting toward tail(); a long press as
// the first touch still sounds (and nothing else asked for before the first gesture does); a resume that lands after
// hide or Off sleeps again; cues still waiting can be dropped; the legacy filters stay finite at low rates.
//   node --no-warnings scripts/test-sound-play.mjs
import assert from 'node:assert/strict';

let n = 0;
const atest = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms)), tick = () => wait(0);

// A fake Web Audio: the audio clock is set by hand (now), resume() can be held, sources note start/stop.
const made = [];
class FakeAC {
  constructor() { this.state = 'suspended'; this.sampleRate = 48000; this.destination = {}; this.started = []; this.currentTime = 10; this.hold = null; this.suspends = 0; made.push(this); }
  resume() {
    this.resumes = (this.resumes || 0) + 1; // (as a browser's: the state changes when the promise settles)
    return (this.hold || Promise.resolve()).then(() => { this.state = 'running'; });
  }
  suspend() { this.suspends++; this.state = 'suspended'; return Promise.resolve(); }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createBuffer(c, len) { const d = new Float32Array(len); return { length: len, getChannelData: () => d }; }
  createBufferSource() {
    const ac = this, src = { connect() {}, disconnect() {}, stop() { src.stopped = true; }, start(when) { src.when = when; ac.started.push(src); } };
    return src;
  }
}
const listeners = {};
globalThis.window = { AudioContext: FakeAC };
globalThis.document = { hidden: false, addEventListener: (t, f) => (listeners[t] ||= []).push(f) };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userActivation: { hasBeenActive: true } } });
let copies = 0;
const fresh = async () => { made.length = 0; document.hidden = false; return import('../public/sound.js?play' + ++copies); };

await atest('idle: the context sleeps IDLE_MS (1.5 s) after the last sound ends, and a tap that plays nothing arms it too', async () => {
  const s = await fresh();
  s.listen();
  s.playMove('a1'); const ac = made[0]; await tick();
  assert.equal(ac.state, 'running'); assert.equal(ac.started.length, 1);
  await wait(1200); assert.equal(ac.state, 'running', 'still awake 1.2 s on (the click is ~0.1 s long)');
  await wait(700); assert.equal(ac.state, 'suspended', 'asleep about 1.5 s after the sound ended');
  // a tap resumes it (inside the gesture) and it sleeps again 1.5 s later
  const r0 = ac.resumes;
  for (const f of listeners.pointerdown) f({ type: 'pointerdown', pointerType: 'mouse' });
  assert.equal(ac.resumes, r0 + 1, 'the tap resumed it inside the gesture');
  await tick(); assert.equal(ac.state, 'running');
  await wait(1600); assert.equal(ac.state, 'suspended', 'the tap armed the idle timer');
  // the next sound while asleep: resumed, then started on the running clock (not in the past)
  ac.currentTime = 50;
  s.playMove('3a1>111', false, { onto: ['piece', 'piece', 'piece'] });
  assert.equal(ac.started.length, 1, 'nothing starts before the context runs');
  await tick();
  assert.equal(ac.state, 'running'); assert.equal(ac.started.length, 4);
  assert.ok(ac.started.slice(2).every((x) => x.when > 50), 'the later drops scheduled ahead of the clock');
  // a sound keeps it awake while it plays: a new sound before the timer re-arms it
  await wait(1000); s.play('solved'); await wait(1000);
  assert.equal(ac.state, 'running', 'kept awake by the newer sound');
});

await atest('a hidden tab: every sound stops (queued drops too) and the context sleeps at once; nothing starts while hidden', async () => {
  const s = await fresh();
  s.listen();
  s.playMove('3a1>111', false, { onto: ['piece', 'piece', 'piece'] }); await tick();
  const ac = made[0], srcs = ac.started.slice();
  assert.equal(srcs.length, 3);
  document.hidden = true; for (const f of listeners.visibilitychange) f();
  assert.equal(ac.state, 'suspended', 'asleep the moment the tab is hidden');
  assert.ok(srcs.every((x) => x.stopped), 'nothing left to play when it resumes');
  s.play('solved'); await tick(); assert.equal(ac.started.length, 3, 'silent while hidden');
  document.hidden = false;
  s.play('solved'); await tick(); assert.equal(ac.started.length, 4, 'plays again once visible');
});

await atest('Off stops a spread\'s queued drops (they would play when On resumes the clock); On plays only what is asked then', async () => {
  const s = await fresh();
  s.playMove('4a1>1111', false, { onto: ['piece', 'piece', 'piece', 'piece'] }); await tick();
  const ac = made[0], srcs = ac.started.slice();
  s.setEnabled(false);
  assert.equal(ac.state, 'suspended');
  assert.ok(srcs.slice(1).every((x) => x.stopped), 'the queued drops are stopped');
  s.setEnabled(true); s.unlock(); s.play('flatBoard'); await tick();
  assert.equal(ac.started.length, 5, 'only the preview');
});

await atest('a move waiting for the context to resume is dropped if the board jumps meanwhile (cut); a verdict waiting is not', async () => {
  const s = await fresh();
  s.play('solved'); await tick();
  const ac = made[0];
  s.setEnabled(false); s.setEnabled(true);
  let release; ac.hold = new Promise((r) => (release = r));
  s.playMove('3a1>111'); // waits for the resume
  s.later('wrong', 0); await wait(5); // a verdict waiting too
  s.cut(); // a step back before the resume completes
  release(); ac.hold = null; await tick(); await tick();
  const after = ac.started.slice(1);
  assert.equal(after.length, 1, 'only the verdict: ' + after.length);
  assert.equal(after[0].buffer.length, s.SOUNDS.wrong.render(48000).length);
});

await atest('a newer move cuts the later drops of one still waiting for the resume (as it would have once they were queued)', async () => {
  const s = await fresh();
  s.play('solved'); await tick();
  const ac = made[0];
  s.setEnabled(false); s.setEnabled(true);
  let release; ac.hold = new Promise((r) => (release = r));
  s.playMove('3a1>111');
  s.playMove('e5');
  release(); ac.hold = null; await tick(); await tick();
  assert.equal(ac.started.length - 1, 2, 'the spread\'s first drop and the new flat, not the spread\'s last two drops');
});

await atest('distinct landings are never merged: two drops by a held key 30 ms apart, and a move and its reply in one task, both sound; one move twice in 40 ms is one', async () => {
  const s = await fresh();
  s.play('solved'); await tick();
  const ac = made[0], k = ac.started.length;
  s.playLanding([{ piece: 'flat', onto: 'board', drop: true }]);
  await wait(30);
  s.playLanding([{ piece: 'flat', onto: 'board', drop: true }]);
  assert.equal(ac.started.length - k, 2, 'two dropBoard landings 30 ms apart');
  await wait(50);
  s.playMove('b2'); s.playMove('e5'); // reduced-motion Rush: the move and the reply in one task
  assert.equal(ac.started.length - k, 4, 'the reply sounds too');
  await wait(50);
  s.playMove('c3'); s.playMove('c3');
  assert.equal(ac.started.length - k, 5, 'the same move delivered twice is one sound');
});

await atest('tail(): drops a cut stopped no longer delay the next verdict', async () => {
  const s = await fresh();
  s.play('solved'); await tick();
  const ac = made[0];
  s.playMove('5a1>11111', false, { onto: ['piece', 'piece', 'piece', 'piece', 'piece'] });
  assert.ok(s.tail() > 350, 'a 5-drop spread: ' + s.tail());
  await wait(60);
  s.cut(); // (the audio clock has not moved: every later drop is still ahead, so all are stopped)
  await wait(50);
  s.playMove('e5');
  const d = s.verdict('rushGood', 45);
  assert.ok(d <= 90, 'the verdict at its usual beat, not after the stopped drops: ' + d);
  assert.ok(ac.started.filter((x) => x.stopped).length === 4);
});

await atest('a long press as the very first touch: its stone sounds on the touchend that activates the page; a stale one does not', async () => {
  const s = await fresh();
  navigator.userActivation.hasBeenActive = false;
  s.listen();
  for (const f of listeners.pointerdown) f({ type: 'pointerdown', pointerType: 'touch' });
  assert.equal(made.length, 0, 'a touch press makes no context');
  s.playMove('Ca1', false, { piece: 'cap' }); // the long press commits a capstone
  await wait(100);
  navigator.userActivation.hasBeenActive = true;
  for (const f of listeners.touchend) f({ type: 'touchend' });
  await tick();
  assert.equal(made.length, 1); assert.equal(made[0].started.length, 1, 'the capstone sounds');
  // a fresh page: the board jumped, or too long ago: nothing
  const t = await fresh();
  navigator.userActivation.hasBeenActive = false;
  t.playMove('a1'); t.cut();
  navigator.userActivation.hasBeenActive = true;
  t.unlock({ type: 'touchend' }); await tick();
  assert.equal(made[0].started.length, 0, 'a move the board left before activation stays silent');
  navigator.userActivation.hasBeenActive = true;
});

await atest('a move asked for before any gesture with no touch under way (a puzzle\'s intro move) is not saved for the first tap', async () => {
  const s = await fresh();
  navigator.userActivation.hasBeenActive = false;
  s.listen();
  s.playMove('c3'); // the opponent's intro move, from a timer, before the player has touched the page
  await wait(300);
  navigator.userActivation.hasBeenActive = true;
  for (const f of listeners.pointerdown) f({ type: 'pointerdown', pointerType: 'mouse' }); // the first click...
  s.playMove('d4'); await tick(); // ...plays its own move
  assert.equal(made.length, 1); assert.equal(made[0].started.length, 1, 'one sound on the first click, not the late intro too');
});

await atest('the tab hidden, or sound turned Off, while a sound waits for the resume: the context sleeps again once it resumes', async () => {
  for (const how of ['hidden', 'off']) {
    const s = await fresh();
    s.listen();
    s.playMove('a1'); await tick();
    const ac = made[0];
    await wait(2000); assert.equal(ac.state, 'suspended', 'asleep while idle');
    let release; ac.hold = new Promise((r) => (release = r));
    s.playMove('3a1>111', false, { onto: ['piece', 'piece', 'piece'] }); // waits for the resume
    if (how === 'hidden') { document.hidden = true; for (const f of listeners.visibilitychange) f(); } else s.setEnabled(false);
    release(); ac.hold = null; await tick(); await tick();
    assert.equal(ac.started.length, 1, `${how}: the waiting move never starts`);
    assert.equal(ac.state, 'suspended', `${how}: back asleep at once, not left running`);
    document.hidden = false; s.setEnabled(true);
  }
});

await atest('dropLater(): cues still waiting (later, verdict) are forgotten', async () => {
  const s = await fresh();
  s.play('solved'); await tick();
  const ac = made[0], k = ac.started.length;
  s.later('lowTime', 30); s.verdict('wrong', 40);
  s.dropLater();
  await wait(80);
  assert.equal(ac.started.length, k);
});

await atest('the older filters stay stable under Nyquist: solved, wrong and rushGood finite at 8, 11.025 and 16 kHz', async () => {
  const s = await fresh();
  for (const sr of [8000, 11025, 16000]) for (const name of ['solved', 'wrong', 'rushGood', 'rushEnd', 'lowTime'])
    for (const v of s.SOUNDS[name].render(sr, {})) assert.ok(Number.isFinite(v), `${name} @${sr}`);
});

console.log(`all ${n} passed`);
process.exit(0); // (the idle timers of the copies would keep node up a little longer)
