// PTN Ninja's board (public/ninja.js NinjaBoard) in node: the real class against a fake page and a fake frame that
// records what tinue posts. Its ready flag, destroy(), the turn keys of a board out of sight, lock(), what happens when
// PTN Ninja doesn't come, is slow, or stops answering (the message and Retry in the board's place: there is no other
// board), and load()'s waits.   node scripts/test-ninja-board.mjs
import assert from 'node:assert/strict';

// ---- a fake page: listeners on window, elements with styles, an iframe whose contentWindow records posts ----
const L = new Map();
const on = (t, f) => { if (!L.has(t)) L.set(t, new Set()); L.get(t).add(f); };
const dispatch = (type, e) => { for (const f of [...(L.get(type) || [])]) f(e); return e; };
class Style { constructor() { this.cssText = ''; } get opacity() { return /opacity:([^;]*)/.exec(this.cssText)?.[1] ?? ''; } set opacity(v) { this.cssText = this.cssText.replace(/;?opacity:[^;]*/, '') + ';opacity:' + v; } }
const listening = () => [...L.values()].reduce((n, s) => n + s.size, 0);
function element(tag) {
  const e = { tagName: tag.toUpperCase(), style: new Style(), dataset: {}, children: [], parent: null, hidden: false, className: '',
    classList: { add() {}, toggle() {} }, addEventListener() {}, removeEventListener() {},
    get isConnected() { return !!this.parent; },
    getClientRects() { let x = this; while (x) { if (x.hidden) return []; x = x.parent; } return [1]; },
    querySelector(s) { return this.children.find((c) => c.tagName === s.toUpperCase()) || null; },
    replaceChildren(...k) { for (const c of this.children) c.parent = null; this.children = []; for (const c of k) this.append(c); },
    append(c) { c.parent = this; this.children.push(c); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; },
    contains: () => false, focus() { doc.activeElement = this; }, blur() { if (doc.activeElement === this) doc.activeElement = doc.body; },
    removeAttribute() {}, setAttribute() {}, set innerHTML(v) {}, firstChild: {}, textContent: '' };
  if (tag === 'iframe') e.contentWindow = { posts: [], postMessage(m, origin) { assert.equal(origin, 'https://ptn.ninja'); this.posts.push(m); } };
  return e;
}
const doc = { body: element('body'), activeElement: null, hidden: false, createElement: element, addEventListener() {}, removeEventListener() {}, elementFromPoint: () => null };
doc.activeElement = doc.body;
globalThis.window = globalThis; globalThis.document = doc;
globalThis.addEventListener = on; globalThis.removeEventListener = (t, f) => L.get(t)?.delete(f);
globalThis.dispatchEvent = (e) => dispatch(e.type, e);
globalThis.KeyboardEvent = class { constructor(type, o) { Object.assign(this, o, { type }); } preventDefault() { this.defaultPrevented = true; } };
globalThis.matchMedia = (q) => ({ matches: !/reduced-motion/.test(q), addEventListener() {} }); // (no reduced motion; a fine pointer)
const ls = new Map();
globalThis.localStorage = { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 1);
const warns = []; console.warn = (...a) => warns.push(a.join(' '));

const { NinjaBoard, SAYS } = await import('../public/ninja.js');
const { buildPTN } = await import('../public/board-kit.js');
const MS = NinjaBoard.MS = { up: 80, loaded: 50, note: 40, heart: 60000, dead: 60 }; // (the heartbeat off but where tested: this fake frame answers nothing)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (f) => dispatch('message', { source: f.contentWindow, data: { action: 'GAME_STATE', value: {} } });
const key = (k, target = doc.body) => dispatch('keydown', new KeyboardEvent('keydown', { key: k, target, cancelable: true }));
const acts = (f) => f.contentWindow.posts.map((m) => m.action + (m.action === 'SET_UI' && 'disableBoard' in m.value ? ':' + m.value.disableBoard : ''));
const host = () => { const el = element('div'); doc.body.append(el); return el; };
const PUZ = (tps) => buildPTN({ size: 6, komi: 0, tps, moves: [], white: 'a', black: 'b' });
const T1 = 'x6/x6/x6/x6/x6/x6 1 1', T2 = '1,x5/x6/x6/x6/x6/x5,2 1 2';
// what the board's place says: null (the board), or the message's kind and whether Retry shows
const said = (b) => (b.msgEl?.isConnected ? b.msgEl.dataset.kind + (b.msgB.hidden ? '' : '+retry') : null);
const text = (b) => b.msgP?.textContent;

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await test('the ready flag is its own frame\'s: index.html\'s frame (data-up) counts, a second board waits for its own', async () => {
  const el1 = host(), f1 = element('iframe'); f1.dataset.up = '1'; el1.append(f1);
  const b1 = new NinjaBoard(el1);
  let r1 = false; b1.ready.then(() => (r1 = true)); await sleep(0);
  assert.ok(r1, 'index.html saw this frame up: ready at once');
  assert.deepEqual(acts(f1).slice(0, 2), ['SET_UI', 'SHOW_NAMES']);
  const el2 = host(), b2 = new NinjaBoard(el2), f2 = el2.children[0];
  assert.equal(f2.tagName, 'IFRAME'); assert.ok(!f2.dataset.up);
  let r2 = false; b2.ready.then(() => (r2 = true));
  up(f1); await sleep(0);
  assert.ok(!r2 && !f2.contentWindow.posts.length, 'the first frame\'s GAME_STATE is not the second\'s: nothing sent to a frame still loading');
  up(f2); await sleep(0);
  assert.ok(r2); assert.deepEqual(acts(f2).slice(0, 2), ['SET_UI', 'SHOW_NAMES']);
  b1.destroy(); b2.destroy();
});

await test('destroy(): listeners, timers and the frame go; nothing is sent after', async () => {
  const before = listening(), el = host(), b = new NinjaBoard(el), f = el.children[0];
  assert.ok(listening() > before);
  b.destroy();
  assert.equal(listening(), before, 'its window listeners removed');
  assert.ok(!f.isConnected, 'its frame dropped');
  await sleep(MS.up + 40);
  assert.ok(!el.children.length && !f.dataset.down, 'no message after destroy');
  up(f); b.highlight(['a1']); await sleep(0);
  assert.equal(f.contentWindow.posts.length, 0);
});

await test('the turn keys: a board out of sight leaves them to the board in sight (Rush\'s, over the puzzle page\'s)', async () => {
  const el = host(), b = new NinjaBoard(el), f = el.children[0]; up(f); await sleep(0);
  f.contentWindow.posts.length = 0;
  let e = key('['); await sleep(0);
  assert.ok(e.defaultPrevented); assert.deepEqual(acts(f), ['ROTATE_LEFT'], 'in sight: it turns');
  f.contentWindow.posts.length = 0; el.hidden = true; // (the puzzle page hidden while Rush is shown)
  e = key('['); await sleep(0);
  assert.ok(!e.defaultPrevented, 'not taken by the hidden board (left to the board in sight)');
  assert.deepEqual(acts(f), [], 'nothing sent to the hidden frame');
  b.destroy();
});

await test('lock(until): the frame is off until then, back on after; lock(Infinity) holds until the next lock', async () => {
  const el = host(), b = new NinjaBoard(el), f = el.children[0]; up(f); await sleep(0);
  f.contentWindow.posts.length = 0;
  b.lock(performance.now() + 60); await sleep(0);
  assert.deepEqual(acts(f), ['SET_UI:true'], 'off at once (it only stored a time before)');
  b.ui({ disableBoard: false }); await sleep(0);
  assert.deepEqual(acts(f).at(-1), 'SET_UI:true', 'turning the board on during a lock leaves it off');
  await sleep(90);
  assert.equal(acts(f).at(-1), 'SET_UI:false', 'on again once the lock runs out');
  f.contentWindow.posts.length = 0;
  b.lock(Infinity); await sleep(0);
  assert.deepEqual(acts(f), ['SET_UI:true']);
  b.ui({ disableBoard: false }); await sleep(120);
  assert.ok(acts(f).every((a) => a === 'SET_UI:true'), 'Infinity: stays off, no timer firing at once');
  b.lock(performance.now()); await sleep(0);
  assert.equal(acts(f).at(-1), 'SET_UI:false', 'a lock in the past: on');
  b.ui({ disableBoard: true }); b.lock(performance.now() + 20); await sleep(50);
  assert.equal(acts(f).at(-1), 'SET_UI:true', 'the board off by tinue stays off when a lock runs out');
  b.destroy();
});

await test('no PTN Ninja by MS.up: the message and Retry in the board\'s place, nothing sent, nothing playable; no other board', async () => {
  const states = [];
  const el = host(), b = new NinjaBoard(el, { onMove: () => {}, onState: (s) => states.push(s) }), f = el.children[0];
  b.load(PUZ(T1)); b.setPlayer(1); b.ui({ disableBoard: false });
  let ready = false; b.ready.then(() => (ready = true));
  await sleep(MS.note + 10);
  assert.equal(said(b), 'note', 'a quiet "Loading the board…" first, no button'); assert.equal(text(b), SAYS.note);
  await sleep(MS.up);
  assert.equal(b.state, 'down'); assert.equal(f.dataset.down, 'load');
  assert.equal(said(b), 'load+retry'); assert.equal(text(b), 'The board (PTN Ninja) didn’t load.');
  assert.deepEqual(states, ['down'], 'the page heard it (app.js redraws: Hint and Solution stay off)');
  assert.ok(!ready, 'nothing waiting on the board went ahead: no clock started, nothing judged');
  assert.equal(b.available, false);
  assert.equal(b.play('a1'), false, 'a typed move is refused');
  assert.equal(f.contentWindow.posts.length, 0, 'nothing was sent to a frame never up');
  assert.ok(el.children.every((c) => c.tagName === 'IFRAME' || c.className === 'board-down'), 'only the frame and the message: no other board');
  assert.ok(f.isConnected, 'the frame kept (it may come up yet)');
  assert.ok(warns.some((w) => /did not load/.test(w)));
  // up late after all, by itself: the message goes, the board is there, everything asked for goes out in order
  up(f); await sleep(5);
  assert.equal(said(b), null); assert.equal(b.state, 'up'); assert.ok(ready);
  assert.deepEqual(states, ['down', 'up']);
  const a = acts(f);
  assert.deepEqual(a.slice(0, 2), ['SET_UI', 'SHOW_NAMES'], 'greeted');
  assert.ok(a.includes('SET_CURRENT_PTN') && a.includes('SET_PLAYER'), 'the puzzle and the side to move: ' + a);
  await sleep(300);
  assert.equal(f.style.opacity, '1', 'shown once drawn');
  b.destroy();
});

await test('Retry: the frame loads again and the wait starts over; once up the puzzle is playable, in the position it was in', async () => {
  const el = host(), b = new NinjaBoard(el, { onMove: () => {} }), f = el.children[0];
  f.src = 'https://ptn.ninja/&old';
  b.load(PUZ(T1)); b.setPlayer(1); b.ui({ disableBoard: false });
  await sleep(MS.up + 20);
  assert.equal(said(b), 'load+retry');
  const t0 = +f.dataset.t0 || 0;
  b.msgB.onclick();
  assert.equal(said(b), 'note', 'loading again: the quiet line, no button');
  assert.notEqual(f.src, 'https://ptn.ninja/&old'); assert.match(f.src, /^https:\/\/ptn\.ninja\/&moveNumber=false/);
  assert.ok(+f.dataset.t0 > t0, 'the wait counts from the reload');
  assert.ok(!f.dataset.down && !f.dataset.up);
  await sleep(MS.up / 2); up(f); await sleep(5);
  assert.equal(said(b), null); assert.equal(b.state, 'up');
  assert.ok(acts(f).includes('SET_CURRENT_PTN'));
  // playable: a typed move goes to PTN Ninja
  f.contentWindow.posts.length = 0;
  assert.equal(b.play('a1'), true); await sleep(0);
  assert.deepEqual(acts(f), ['INSERT_PLY']);
  b.destroy();
});

await test('a frame whose page loaded (a blocked ptn.ninja loads an error page) and then says nothing: down after MS.loaded, before MS.up', async () => {
  const el = host(), f = element('iframe'); el.append(f);
  f.dataset.t0 = performance.now(); f.dataset.loaded = performance.now(); // (index.html saw its load event)
  const b = new NinjaBoard(el);
  await sleep(MS.loaded + 15);
  assert.equal(f.dataset.down, 'load');
  b.destroy();
});

await test('the wait counts from when the frame started (index.html), not from when ninja.js got going', async () => {
  const el = host(), f = element('iframe'); el.append(f);
  f.dataset.t0 = performance.now() - MS.up + 20; // started a while before this module loaded
  const b = new NinjaBoard(el, { onMove: () => {} });
  await sleep(50);
  assert.equal(b.state, 'down', 'down after what was left of the wait');
  b.destroy();
  const el2 = host(), b2 = new NinjaBoard(el2, { onMove: () => {} }); // a frame made here: the whole wait
  await sleep(50);
  assert.equal(b2.state, 'loading');
  await sleep(MS.up);
  assert.equal(b2.state, 'down');
  b2.destroy();
});

await test('slow but healthy: up before the cap is never down, and shows no message but the quiet line', async () => {
  for (const at of [MS.note / 2, MS.up - 20]) {
    const el = host(), b = new NinjaBoard(el), f = el.children[0];
    await sleep(at); up(f);
    await sleep(MS.up);
    assert.equal(b.state, 'up'); assert.equal(said(b), null); assert.ok(!f.dataset.down);
    b.destroy();
  }
  // a hidden tab is never held to the cap: it waits until shown
  doc.hidden = true;
  const el = host(), b = new NinjaBoard(el), f = el.children[0];
  await sleep(MS.up + 30);
  assert.equal(b.state, 'loading', 'hidden: still waiting');
  up(f); await sleep(5); assert.equal(b.state, 'up');
  doc.hidden = false; b.destroy();
});

await test('a frame that stops answering mid-puzzle (the heartbeat): the message, nothing judged, nothing sent; answering again puts the board back as it is now', async () => {
  const keep = { ...MS }; MS.heart = 30; MS.dead = 40;
  const el = host(), moves = [], states = [];
  const b = new NinjaBoard(el, { onMove: (m) => moves.push(m), onState: (s) => states.push(s) }), f = el.children[0];
  let alive = true;
  const orig = f.contentWindow.postMessage.bind(f.contentWindow);
  f.contentWindow.postMessage = (m, o) => { orig(m, o); if (alive && m.action === 'GET_THEME') setTimeout(() => dispatch('message', { source: f.contentWindow, data: { action: 'GET_THEME', value: {} } }), 2); };
  up(f); await sleep(5);
  await b.load(PUZ(T1)); await b.setPlayer(1); await b.ui({ disableBoard: false });
  dispatch('message', { source: f.contentWindow, data: { action: 'INSERT_PLY', value: 'a1' } }); await sleep(0);
  assert.deepEqual(moves, ['a1']);
  await sleep(150);
  assert.equal(b.state, 'up', 'answering: up');
  alive = false; // (PTN Ninja hangs, or crashes)
  await sleep(MS.heart + MS.dead + 40);
  assert.equal(b.state, 'down'); assert.equal(f.dataset.down, 'stopped');
  assert.equal(said(b), 'stopped+retry'); assert.equal(text(b), 'The board (PTN Ninja) stopped answering.');
  assert.deepEqual(states, ['up', 'down']);
  assert.equal(b.play('f6'), false, 'no typed move');
  f.contentWindow.posts.length = 0;
  await b.append('f6'); b.highlight(['c3']); await sleep(5); // (the puzzle goes on being tracked: a reply, say)
  assert.deepEqual(acts(f).filter((x) => x !== 'GET_THEME'), [], 'nothing sent while down');
  // it answers again (it was only hung): back, with everything as it is now
  alive = true; dispatch('message', { source: f.contentWindow, data: { action: 'GET_THEME', value: {} } }); await sleep(5);
  assert.equal(b.state, 'up'); assert.equal(said(b), null); assert.deepEqual(states, ['up', 'down', 'up']);
  const set = f.contentWindow.posts.find((m) => m.action === 'SET_CURRENT_PTN');
  assert.ok(set, 'its position sent again');
  assert.deepEqual(set.value.split('\n\n')[1].trim(), '1. a1 f6', 'with the moves since');
  assert.deepEqual(f.contentWindow.posts.find((m) => m.action === 'HIGHLIGHT_SQUARES').value, ['c3']);
  assert.equal(f.contentWindow.posts.find((m) => m.action === 'SET_PLAYER').value, 1);
  b.destroy(); Object.assign(MS, keep);
});

await test('a frame that stops answering, then Retry: reloaded, and once up the position goes to it again', async () => {
  const keep = { ...MS }; MS.heart = 30; MS.dead = 40;
  const el = host(), b = new NinjaBoard(el, { onMove: () => {} }), f = el.children[0];
  up(f); await sleep(5);
  await b.load(PUZ(T2)); await b.setPlayer(1);
  await sleep(MS.heart + MS.dead + 40);
  assert.equal(said(b), 'stopped+retry');
  b.retry(); assert.equal(said(b), 'note');
  f.contentWindow.posts.length = 0;
  up(f); await sleep(5);
  assert.equal(said(b), null);
  const a = acts(f);
  assert.deepEqual(a.slice(0, 2), ['SET_UI', 'SHOW_NAMES'], 'greeted again');
  assert.ok(a.includes('SET_CURRENT_PTN') && a.includes('SET_PLAYER'));
  b.destroy(); Object.assign(MS, keep);
});

await test('load(): no fixed waits; animation back on once PTN Ninja has drawn the position, shown once its size is still', async () => {
  const el = host(), b = new NinjaBoard(el), f = el.children[0]; up(f); await sleep(0);
  const msg = (data) => dispatch('message', { source: f.contentWindow, data });
  f.contentWindow.posts.length = 0;
  let t0 = performance.now(); await b.load(PUZ(T2));
  assert.ok(performance.now() - t0 < 20, 'load() returns without the old 60 ms sleep');
  assert.deepEqual(f.contentWindow.posts.map((m) => m.action), ['SET_UI', 'HIGHLIGHT_SQUARES', 'SET_CURRENT_PTN', 'LAST']);
  assert.equal(f.contentWindow.posts[0].value.animateBoard, false);
  let appended = false; b.append('a2').then(() => (appended = true));
  await sleep(10);
  assert.ok(!appended && f.style.opacity === '0', 'a move appended waits for the animation; not shown yet');
  msg({ action: 'GAME_STATE', value: { tps: 'x6/x6/x6/x6/x6/x6 1 1' } }); await sleep(5);
  assert.ok(!appended, 'another position\'s GAME_STATE (the load\'s first step) is not the one');
  t0 = performance.now();
  msg({ action: 'GAME_STATE', value: { tps: T2 } });
  await sleep(60);
  const ui = f.contentWindow.posts.filter((m) => m.action === 'SET_UI' && 'animateBoard' in m.value).map((m) => m.value.animateBoard);
  assert.deepEqual(ui, [false, true], 'animation back on');
  assert.ok(appended && f.contentWindow.posts.at(-1).action === 'APPEND_PLY', 'then the move, animated');
  assert.equal(f.style.opacity, '1', 'shown');
  // PTN Ninja silent: at most DRAW_MS, then on anyway
  const el2 = host(), b2 = new NinjaBoard(el2), f2 = el2.children[0]; up(f2); await sleep(0);
  dispatch('message', { source: f2.contentWindow, data: { action: 'SET_UI', value: { boardSize: { width: 1, height: 1 } } } });
  f2.contentWindow.posts.length = 0; await b2.load(PUZ(T1));
  const on = () => f2.contentWindow.posts.some((m) => m.action === 'SET_UI' && m.value.animateBoard === true);
  await sleep(80); assert.ok(!on());
  await sleep(80); assert.ok(on(), 'on after DRAW_MS without an answer');
  // still resizing: not shown until its size has kept for a moment
  dispatch('message', { source: f2.contentWindow, data: { action: 'SET_UI', value: { boardSize: { width: 2, height: 2 } } } });
  const el3 = host(), b3 = new NinjaBoard(el3), f3 = el3.children[0]; up(f3); await sleep(0);
  await b3.load(PUZ(T1));
  const resize = () => dispatch('message', { source: f3.contentWindow, data: { action: 'SET_UI', value: { boardSize: { width: 3, height: 3 } } } });
  dispatch('message', { source: f3.contentWindow, data: { action: 'GAME_STATE', value: { tps: T1 } } });
  for (let i = 0; i < 4; i++) { resize(); await sleep(20); }
  assert.equal(f3.style.opacity, '0', 'resizing: not shown');
  await sleep(120);
  assert.equal(f3.style.opacity, '1', 'shown once still');
  for (const x of [b, b2, b3]) x.destroy();
});

await test('the frame\'s shape leaves the host\'s own styles alone', async () => {
  const el = host(); el.style.width = '300px';
  const b = new NinjaBoard(el);
  assert.equal(el.style.width, '300px');
  assert.equal(el.style.aspectRatio, '0.79045'); assert.equal(el.style.overflow, 'hidden');
  assert.match(el.children[0].style.cssText, /width:111\.11111%/);
  b.destroy();
});

await test('at start every look key goes out, PTN Ninja\'s default under the player\'s look (a 3D board left in the frame goes)', async () => {
  const { LOOK } = await import('../public/ninja-look.js');
  const first = (look) => { const el = host(), b = new NinjaBoard(el, { look }), f = el.children[0]; up(f); const v = f.contentWindow.posts[0]?.value; b.destroy(); return v; };
  await sleep(0);
  const plain = first('');
  for (const k of Object.keys(LOOK)) assert.ok(k in plain, k + ' sent');
  assert.equal(plain.board3D, false); assert.equal(plain.orthographic, false); assert.equal(plain.perspective, 5);
  assert.equal(plain.axisLabels, true); assert.equal(plain.theme.id, 'tinue');
  const mine = first('&board3D=true&axisLabels=false&perspective=8');
  assert.equal(mine.board3D, true); assert.equal(mine.axisLabels, false); assert.equal(mine.perspective, 8);
  assert.equal(mine.orthographic, false, 'what the look leaves out: PTN Ninja\'s default');
});

await test('a slow first visit: still loading (no load event) is not down before MS.up, however long past MS.loaded', async () => {
  // (the page's own load event, not a clock from the frame's start, is what a short wait hangs on: a frame whose bytes are
  // still arriving on a slow phone keeps "Loading the board…")
  assert.ok(NinjaBoard.MS === MS);
  const real = (await import('../public/ninja.js')).NinjaBoard;
  assert.ok(real === NinjaBoard);
  const el = host(), b = new NinjaBoard(el), f = el.children[0];
  await sleep(MS.loaded + 20);
  assert.equal(b.state, 'loading'); assert.equal(said(b), 'note');
  b.destroy();
});

await test('the shipped waits: a page still loading gets 45 s, a loaded page that says nothing 8 s', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../public/ninja.js', import.meta.url), 'utf8');
  const ms = /const MS = (\{[^}]*\})/.exec(src)[1];
  assert.match(ms, /up: 45000/); assert.match(ms, /loaded: 8000/); assert.match(ms, /heart: 1000/); assert.match(ms, /dead: 3000/); assert.match(ms, /grace: 3000/);
});

await test('a tab shown after its deadline passed while hidden gets a grace before the message', async () => {
  let vis = null; const keepAdd = doc.addEventListener;
  doc.addEventListener = (t, fn) => { if (t === 'visibilitychange') vis = fn; };
  const keep = { ...MS }; MS.grace = 60;
  doc.hidden = true;
  const el = host(), b = new NinjaBoard(el), f = el.children[0];
  doc.addEventListener = keepAdd;
  await sleep(MS.up + 30);
  assert.equal(b.state, 'loading', 'hidden: still waiting');
  doc.hidden = false; vis();
  await sleep(20);
  assert.equal(b.state, 'loading', 'just shown: not called down at once');
  up(f); await sleep(5);
  assert.equal(b.state, 'up'); assert.equal(said(b), null);
  b.destroy();
  // and one that never comes is down once the grace is over
  doc.addEventListener = (t, fn) => { if (t === 'visibilitychange') vis = fn; };
  doc.hidden = true;
  const el2 = host(), b2 = new NinjaBoard(el2);
  doc.addEventListener = keepAdd;
  await sleep(MS.up + 30);
  doc.hidden = false; vis();
  await sleep(MS.grace + 30);
  assert.equal(b2.state, 'down');
  b2.destroy(); Object.assign(MS, keep); delete MS.grace;
});

await test('down: the frame leaves the Tab order (Tab goes to Retry); back when it comes up', async () => {
  const el = host(), b = new NinjaBoard(el), f = el.children[0];
  f.removeAttribute = (k) => { if (k === 'tabindex') delete f.tabIndex; };
  await sleep(MS.up + 20);
  assert.equal(b.state, 'down'); assert.equal(f.tabIndex, -1);
  up(f); await sleep(5);
  assert.equal(b.state, 'up'); assert.ok(!('tabIndex' in f), 'tabbable again');
  b.destroy();
});

await test('Retry on a frame that came up meanwhile loads nothing again; whenUp() resolves when it comes up', async () => {
  const el = host(), b = new NinjaBoard(el), f = el.children[0];
  let upNow = false; b.whenUp().then(() => (upNow = true));
  await sleep(MS.up + 20);
  assert.equal(b.state, 'down'); assert.ok(!upNow);
  f.src = 'https://ptn.ninja/&same';
  up(f); await sleep(5);
  assert.ok(upNow, 'whenUp: resolved by a late GAME_STATE');
  b.retry();
  assert.equal(f.src, 'https://ptn.ninja/&same', 'up: not reloaded'); assert.equal(b.state, 'up');
  b.destroy();
});

await test('reduced motion: PTN Ninja never animates (its address, the greeting, after a load)', async () => {
  const keepMM = globalThis.matchMedia;
  for (const reduce of [true, false]) {
    globalThis.matchMedia = (q) => ({ matches: /reduced-motion/.test(q) ? reduce : true, addEventListener() {} });
    const el = host(), b = new NinjaBoard(el), f = el.children[0];
    assert.match(f.src, reduce ? /&animateBoard=false/ : /&animateBoard=true/);
    up(f); await sleep(5);
    await b.load(PUZ(T1)); await sleep(300);
    const anim = f.contentWindow.posts.filter((m) => m.action === 'SET_UI' && 'animateBoard' in m.value).map((m) => m.value.animateBoard);
    assert.equal(anim[0], !reduce, 'the greeting');
    assert.equal(anim.at(-1), !reduce, 'after the load: ' + anim);
    if (reduce) assert.ok(anim.every((a) => a === false), 'never on: ' + anim);
    await b.ui({ animateBoard: true }); await sleep(0);
    assert.equal(f.contentWindow.posts.at(-1).value.animateBoard, !reduce);
    b.destroy();
  }
  globalThis.matchMedia = keepMM;
});

await test('Rush\'s pictures get the player\'s built-in theme from the frame: sent as themeID (so GET_THEME answers it), cached when heard, felt until then', async () => {
  const fs = await import('node:fs');
  const { encodeLook } = await import('../public/ninja-look.js');
  const { knownTheme, onNinjaTheme } = await import('../public/ninja.js');
  const FX = JSON.parse(fs.readFileSync(new URL('./ninja-themes.json', import.meta.url), 'utf8')).builtin;
  ls.delete('tinue.ninjaThemes');
  const el = host(), f = element('iframe'); f.dataset.up = '1'; el.append(f);
  const b = new NinjaBoard(el, { look: encodeLook({ theme: 'zen' }) });
  await sleep(0);
  const greet = f.contentWindow.posts.find((m) => m.action === 'SET_UI');
  assert.equal(greet.value.theme, 'zen'); assert.equal(greet.value.themeID, 'zen', 'themeID too: a theme only as `theme` leaves GET_THEME answering the old one');
  assert.ok(f.contentWindow.posts.some((m) => m.action === 'GET_THEME'), 'asked for its colours once greeted');
  const rush = b.lend(host(), {});
  const asks = () => f.contentWindow.posts.filter((m) => m.action === 'GET_THEME').length, asked = asks();
  assert.deepEqual(rush.pictureTheme(), { theme: null, pending: 'zen' }, 'not heard yet: felt (null), and asked');
  assert.equal(asks(), asked + 1, 'the end screen asks the frame for it');
  let told = 0; const off = onNinjaTheme(() => told++);
  // (an answer from anywhere but the frame's own origin, or for a theme that isn't built in, is not kept)
  dispatch('message', { source: f.contentWindow, origin: 'https://evil.example', data: { action: 'GET_THEME', value: FX.zen.theme } });
  dispatch('message', { source: f.contentWindow, origin: 'https://ptn.ninja', data: { action: 'GET_THEME', value: { ...FX.zen.theme, id: 'standin' } } });
  assert.equal(knownTheme('zen'), null); assert.equal(told, 0);
  dispatch('message', { source: f.contentWindow, origin: 'https://ptn.ninja', data: { action: 'GET_THEME', value: FX.zen.theme } });
  assert.equal(told, 1, 'Rush hears it once');
  const t = rush.pictureTheme().theme;
  assert.equal(t.id, 'zen'); assert.equal(t.colors.board1, FX.zen.theme.colors.board1); assert.equal(t.boardStyle, 'grid3');
  assert.ok(JSON.parse(ls.get('tinue.ninjaThemes')).zen, 'kept in this browser');
  dispatch('message', { source: f.contentWindow, origin: 'https://ptn.ninja', data: { action: 'GET_THEME', value: FX.zen.theme } });
  assert.equal(told, 1, 'the same answer again: nothing to repaint');
  // a new look: a built-in one goes as themeID too, and is asked for after it; tinue classic needs no asking
  f.contentWindow.posts.length = 0;
  await b.setLook(encodeLook({ theme: 'aqua' })); await sleep(0);
  assert.equal(told, 2, 'a new look: an open end screen hears of it (another tab, the account)');
  const acts2 = f.contentWindow.posts.map((m) => m.action + (m.value?.themeID ? ':' + m.value.themeID : ''));
  assert.ok(acts2.indexOf('SET_UI:aqua') >= 0 && acts2.indexOf('GET_THEME') > acts2.indexOf('SET_UI:aqua'), acts2.join(' '));
  await b.setLook(''); await sleep(0);
  assert.equal(told, 3, 'back to felt: heard too');
  assert.deepEqual(rush.pictureTheme(), { theme: null }, 'tinue felt: none');
  off(); rush.giveBack?.(); b.destroy(); ls.delete('tinue.ninjaThemes');
});

console.log(`all ${n} passed`);
