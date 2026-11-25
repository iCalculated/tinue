// Rush on PTN Ninja's board (public/ninja.js lend / borrow) in node: the real class against a fake page and a fake
// frame that answers as PTN Ninja does (GAME_STATE after a position is set, GET_THEME at once), or stays silent. One
// frame for the page: Rush's board borrows the puzzle page's and gives it back; until it borrows, and after, its calls
// are only tracked; Start's wait for the frame; a frame that never comes up, or stops answering mid-run, is down (Rush
// hears it, the puzzle page says so in the board's place); there is no other board; the frame laid over Rush's box.
//   node scripts/test-ninja-rush.mjs
import assert from 'node:assert/strict';

// ---- a fake page (as test-ninja-board.mjs's, with boxes, classes and main) ----
const L = new Map();
const on = (t, f) => { if (!L.has(t)) L.set(t, new Set()); L.get(t).add(f); };
const dispatch = (type, e) => { for (const f of [...(L.get(type) || [])]) f(e); return e; };
class Style { constructor() { this.cssText = ''; } get opacity() { return /opacity:([^;]*)/.exec(this.cssText)?.[1] ?? ''; } set opacity(v) { this.cssText = this.cssText.replace(/;?opacity:[^;]*/, '') + ';opacity:' + v; } }
function element(tag) {
  const cls = new Set();
  const e = { tagName: tag.toUpperCase(), style: new Style(), dataset: {}, children: [], parent: null, hidden: false, className: '', rect: null,
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle() {}, contains: (c) => cls.has(c) },
    addEventListener() {}, removeEventListener() {},
    get isConnected() { return !!this.parent; },
    getClientRects() { let x = this; while (x) { if (x.hidden) return []; x = x.parent; } return [1]; },
    getBoundingClientRect() { return this.rect || { left: 0, top: 0, width: 0, height: 0 }; },
    closest(s) { let x = this; while (x) { if (x.tagName === s.toUpperCase()) return x; x = x.parent; } return null; },
    querySelector(s) { return this.children.find((c) => c.tagName === s.toUpperCase()) || null; },
    replaceChildren(...k) { for (const c of this.children) c.parent = null; this.children = []; for (const c of k) this.append(c); },
    append(c) { c.parent = this; this.children.push(c); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; },
    contains: () => false, focus() { doc.activeElement = this; }, blur() { if (doc.activeElement === this) doc.activeElement = doc.body; },
    removeAttribute() {}, setAttribute() {}, set innerHTML(v) {}, firstChild: {}, textContent: '' };
  if (tag === 'iframe') e.contentWindow = { posts: [], postMessage(m, origin) { assert.equal(origin, 'https://ptn.ninja'); this.posts.push(m); this.answer?.(m); } };
  return e;
}
const doc = { body: element('body'), activeElement: null, hidden: false, createElement: element, addEventListener() {}, removeEventListener() {}, elementFromPoint: () => null };
doc.activeElement = doc.body;
globalThis.window = globalThis; globalThis.document = doc;
globalThis.addEventListener = on; globalThis.removeEventListener = (t, f) => L.get(t)?.delete(f);
globalThis.dispatchEvent = (e) => dispatch(e.type, e);
globalThis.KeyboardEvent = class { constructor(type, o) { Object.assign(this, o, { type }); } preventDefault() { this.defaultPrevented = true; } };
globalThis.matchMedia = (q) => ({ matches: !/reduced-motion/.test(q), addEventListener() {} }); // (no reduced motion; a fine pointer)
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '6px' });
globalThis.scrollX = 0; globalThis.scrollY = 100;
const ls = new Map();
globalThis.localStorage = { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 1);
const warns = []; console.warn = (...a) => warns.push(a.join(' '));

const { NinjaBoard, SAYS } = await import('../public/ninja.js');
const { buildPTN } = await import('../public/board-kit.js');
const { parsePTN } = await import('../public/shared/ptn.js');
const { Game } = await import('../public/shared/tak.js');
const { frameGeom } = await import('../public/ninja-look.js');
NinjaBoard.MS = { up: 120, loaded: 120, note: 60, heart: 30, dead: 60 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (f, action, value) => dispatch('message', { source: f.contentWindow, data: { action, value } });
const acts = (f) => f.contentWindow.posts.map((m) => m.action);
const PUZ = (tps, moves = []) => buildPTN({ size: 6, komi: 0, tps, moves, white: 'a', black: 'b' });
const T1 = 'x6/x6/x6/x6/x6/x6 1 1', T2 = '1,x5/x6/x6/x6/x6/x5,2 1 2', T3 = 'x6/x6/x2,1,2,x2/x6/x6/x6 1 2';
// PTN Ninja as the frame: answers what it is sent, as the real one does (GAME_STATE once a position is set or changed,
// GET_THEME's reply), until it dies.
function alive(f, lag = 1) { // (lag: how long it takes to say it has a position)
  let g = new Game(6);
  f.dead = false;
  f.contentWindow.answer = (m) => setTimeout(() => {
    if (f.dead) return;
    if (m.action === 'GET_THEME') return say(f, 'GET_THEME', { id: 'tinue' });
    if (m.action === 'SET_CURRENT_PTN') { const { headers, moves } = parsePTN(m.value); g = headers.TPS ? Game.fromTPS(headers.TPS, 0) : new Game(6); for (const x of moves) g.apply(g.parseMove(x)); }
    else if (m.action === 'APPEND_PLY') g.apply(g.parseMove(m.value));
    else return;
    const tps = g.toTPS();
    setTimeout(() => { if (!f.dead) say(f, 'GAME_STATE', { tps }); }, lag - 1);
  }, 1);
}
// the page: index.html's frame in the puzzle page's #board (in its <main>), Rush's board box elsewhere
function page({ up = true } = {}) {
  const main = element('main'), wrap = element('div'), el = element('div'), f = element('iframe');
  doc.body.append(main); main.append(wrap); wrap.append(el); el.append(f);
  f.dataset.t0 = performance.now();
  if (up) f.dataset.up = '1';
  const rel = element('div'); doc.body.append(rel); rel.rect = { left: 40, top: 60, width: 500, height: 640 };
  return { main, el, f, rel };
}
const moves = [];
const lend = (pb, rel, onDead = () => {}) => pb.lend(rel, { onMove: (m) => moves.push(m), onDead });
// what the puzzle page shows in the board's place: null, or the message's kind
const said = (pb) => (pb.msgEl?.isConnected ? pb.msgEl.dataset.kind : null);

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await test('lent but not borrowed: calls are only tracked, nothing goes to the frame; no other board exists', async () => {
  const { el, f, rel } = page(); alive(f);
  const pb = new NinjaBoard(el); await sleep(5);
  f.contentWindow.posts.length = 0;
  const b = lend(pb, rel);
  b.ui({ disableBoard: true }); await b.load(PUZ(T2)); await b.setPlayer(2); b.lock(performance.now() + 50);
  assert.equal(b.g.toTPS(), T2, 'tracked'); assert.equal(b.player, 2);
  assert.deepEqual(acts(f).filter((x) => x !== 'GET_THEME'), [], 'the frame untouched (the puzzle page\'s heartbeat aside)');
  assert.ok(!rel.classList.contains('lent'));
  assert.deepEqual(rel.children, [], 'nothing drawn in Rush\'s box: it is only the box the frame is laid over');
  assert.ok(!('fb' in b) && !('under' in b), 'no other board to fall back to');
  pb.destroy();
});

await test('frameReady: waits for PTN Ninja up and answering; never up by MS.up: false and the frame down (no other board)', async () => {
  const { el, f, rel } = page({ up: false });
  const pb = new NinjaBoard(el), b = lend(pb, rel);
  assert.equal(b.frameUp, false);
  let t = performance.now(), r = await b.frameReady();
  assert.equal(r, false); assert.ok(performance.now() - t >= 100, 'waited for the cap');
  assert.equal(f.dataset.down, 'load'); assert.equal(said(pb), 'load', 'the puzzle page says so');
  t = performance.now(); r = await b.frameReady();
  assert.ok(performance.now() - t < 30 && r === false, 'down: no second wait');
  assert.equal(b.borrow(), false, 'nothing to borrow');
  alive(f); say(f, 'GAME_STATE', { tps: T1 }); // (up late after all)
  assert.ok(!f.dataset.down && said(pb) === null, 'up late: the message goes');
  assert.equal(await b.frameReady(), true, 'up and answering: true');
  pb.destroy();

  const p2 = page({ up: false }); alive(p2.f);
  const pb2 = new NinjaBoard(p2.el), b2 = lend(pb2, p2.rel);
  setTimeout(() => say(p2.f, 'GAME_STATE', { tps: T1 }), 40);
  t = performance.now(); r = await b2.frameReady();
  assert.ok(r && performance.now() - t < 100, 'resolves when PTN Ninja comes up, not at the cap');
  pb2.destroy();

  const p3 = page(); // up, but answers nothing (hung)
  const pb3 = new NinjaBoard(p3.el), b3 = lend(pb3, p3.rel);
  assert.equal(await b3.frameReady(), false);
  assert.equal(p3.f.dataset.down, 'stopped', 'down: it stopped answering');
  assert.equal(b3.borrow(), false);
  pb3.destroy();
});

await test('Retry from Rush reloads the one frame (the puzzle page\'s) and the next Start waits for it again', async () => {
  const { el, f, rel } = page({ up: false });
  const pb = new NinjaBoard(el), b = lend(pb, rel);
  assert.equal(await b.frameReady(), false);
  f.src = 'https://ptn.ninja/&old';
  b.retry();
  assert.ok(f.src.startsWith('https://ptn.ninja/&') && f.src !== 'https://ptn.ninja/&old', 'loaded again: ' + f.src);
  assert.ok(!f.dataset.down && !f.dataset.up, 'loading');
  alive(f); setTimeout(() => say(f, 'GAME_STATE', { tps: T1 }), 30);
  assert.equal(await b.frameReady(), true);
  pb.destroy();
});

await test('borrow: the frame is Rush\'s; a new position goes by message (no reload); the puzzle page\'s board keeps its calls and puts its position back on giveBack', async () => {
  const { main, el, f, rel } = page(); alive(f);
  const pb = new NinjaBoard(el, { onMove: (m) => moves.push('page:' + m) }); await sleep(5);
  await pb.load(PUZ(T1, ['a1', 'f6'])); await pb.setPlayer(1);
  const b = lend(pb, rel); b.ui({ disableBoard: true });
  assert.equal(await b.frameReady(), true);
  f.contentWindow.posts.length = 0;
  const src = f.src;
  assert.equal(b.borrow(), true);
  assert.ok(main.classList.contains('lend') && rel.classList.contains('lent'), 'the puzzle page laid out out of sight; the frame over Rush\'s box');
  assert.equal(rel.style.aspectRatio, String(frameGeom({}, 6).ratio), 'Rush\'s box in the frame\'s shape');
  assert.ok(f.ninjaOwner?.lender, 'owned by Rush\'s board');
  assert.deepEqual(acts(f).slice(0, 3), ['SET_UI', 'SHOW_NAMES', 'SET_UI'], 'tinue\'s settings and look first');
  assert.equal(f.contentWindow.posts[2].value.disableBoard, true, 'Rush\'s board\'s state: off');
  f.contentWindow.posts.length = 0;
  const t0 = performance.now();
  await b.load(PUZ(T2));
  assert.deepEqual(acts(f), ['SET_UI', 'HIGHLIGHT_SQUARES', 'SET_CURRENT_PTN', 'LAST'], 'a message, never a reload');
  assert.equal(f.src, src);
  assert.ok(performance.now() - t0 < 50, 'load() returned once PTN Ninja had it');
  assert.equal(b.g.toTPS(), T2);
  await sleep(20); f.contentWindow.posts.length = 0;
  await pb.append('c3'); pb.highlight(['b2']); await sleep(5);
  assert.deepEqual(acts(f).filter((x) => x !== 'GET_THEME'), [], 'the puzzle page\'s calls go nowhere while Rush has the frame (Rush\'s heartbeat aside)');
  moves.length = 0;
  await b.setPlayer(2); b.ui({ disableBoard: false }); await sleep(5);
  say(f, 'INSERT_PLY', 'a2'); await sleep(0);
  assert.deepEqual(moves, ['a2'], 'Rush heard it; the puzzle page did not');
  f.contentWindow.posts.length = 0;
  b.giveBack();
  assert.ok(!main.classList.contains('lend') && !rel.classList.contains('lent'));
  assert.ok(!f.ninjaOwner);
  assert.match(f.style.cssText, /width:111\.11111%/, 'back in the puzzle page\'s shape');
  await sleep(5);
  const set = f.contentWindow.posts.find((m) => m.action === 'SET_CURRENT_PTN');
  assert.deepEqual(parsePTN(set.value).moves, ['a1', 'f6', 'c3'], 'its line, the move made while lent included');
  assert.deepEqual(f.contentWindow.posts.find((m) => m.action === 'HIGHLIGHT_SQUARES').value, ['b2']);
  assert.deepEqual(f.contentWindow.posts.find((m) => m.action === 'GO_TO_PLY').value, { plyID: 2, isDone: true });
  f.contentWindow.posts.length = 0;
  await b.load(PUZ(T3));
  assert.equal(b.g.toTPS(), T3); assert.deepEqual(acts(f).filter((x) => x !== 'GET_THEME'), [], 'after it: Rush\'s calls only tracked');
  pb.destroy();
});

await test('a correct first move and a wrong one: both reach Rush, which judges them (the frame only reports moves)', async () => {
  const { el, f, rel } = page(); alive(f);
  const pb = new NinjaBoard(el), got = [];
  const b = pb.lend(rel, { onMove: (m) => got.push(m) });
  await b.frameReady(); b.borrow();
  await b.load(PUZ(T2)); await b.setPlayer(2); await b.ui({ disableBoard: false });
  say(f, 'INSERT_PLY', 'b5'); await sleep(0);
  const g = Game.fromTPS(T2, 0); g.apply(g.parseMove('b5'));
  assert.deepEqual(got, ['b5']); assert.equal(b.g.toTPS(), g.toTPS(), 'the board tracks the move');
  say(f, 'INSERT_PLY', 'not a move'); say(f, 'INSERT_PLY', 'b5'); await sleep(0);
  assert.deepEqual(got, ['b5'], 'an illegal or repeated square isn\'t a move');
  f.contentWindow.posts.length = 0;
  await b.load(PUZ(T2));
  assert.equal(b.g.toTPS(), T2); assert.ok(acts(f).includes('SET_CURRENT_PTN'));
  b.giveBack(); pb.destroy();
});

await test('a frame that dies mid-run (at a load, or between: the heartbeat): Rush hears it once, the frame is down and given back, the puzzle page says so; nothing takes its place', async () => {
  for (const when of ['load', 'heartbeat']) {
    const { el, f, rel } = page(); alive(f);
    const pb = new NinjaBoard(el); let died = 0;
    const b = lend(pb, rel, () => { died++; });
    await b.frameReady(); b.borrow();
    await b.load(PUZ(T2)); await b.setPlayer(2); await b.ui({ disableBoard: false });
    say(f, 'INSERT_PLY', 'b5'); await sleep(0); await b.append('e2');
    await sleep(80);
    assert.equal(died, 0, 'alive: the heartbeat answered');
    f.dead = true;
    const t = performance.now();
    if (when === 'load') await b.load(PUZ(T3)); else await sleep(200);
    assert.equal(died, 1, when + ': Rush heard it');
    assert.ok(performance.now() - t < 400);
    assert.equal(f.dataset.down, 'stopped');
    assert.ok(!rel.classList.contains('lent') && !f.ninjaOwner, 'given back');
    assert.equal(said(pb), 'stopped', 'the puzzle page shows the message');
    assert.deepEqual(rel.children, [], 'nothing drawn in Rush\'s box');
    f.contentWindow.posts.length = 0;
    await b.load(PUZ(T1)); await pb.load(PUZ(T1)); await sleep(150);
    assert.deepEqual(acts(f), [], 'nothing sent to a frame that is down');
    assert.equal(died, 1, 'once');
    assert.equal(await b.frameReady(), false, 'the next Start: the board isn\'t there');
    // PTN Ninja answering again (a Retry, or it was only hung): the puzzle page's board back, in its position
    alive(f); say(f, 'GAME_STATE', { tps: T1 }); await sleep(10);
    assert.equal(said(pb), null); assert.ok(!f.dataset.down);
    assert.ok(acts(f).includes('SET_CURRENT_PTN'), 'its position sent again');
    assert.equal(await b.frameReady(), true);
    pb.destroy();
  }
  assert.ok(warns.some((w) => /stopped answering/.test(w)));
});

await test('a hidden tab is not a dead frame', async () => {
  const { el, f, rel } = page(); alive(f);
  const pb = new NinjaBoard(el); let died = 0;
  const b = lend(pb, rel, () => { died++; });
  await b.frameReady(); b.borrow(); await b.load(PUZ(T2));
  doc.hidden = true; f.dead = true; await sleep(200);
  assert.equal(died, 0); assert.ok(!f.dataset.down);
  doc.hidden = false; dispatch('visibilitychange', {}); // (the page's own event: a no-op listener in this fake, so the beat goes on by itself)
  await sleep(250);
  assert.equal(died, 1, 'shown again, and still silent: down');
  pb.destroy();
  const p2 = page(); alive(p2.f); let died2 = 0;
  const pb2 = new NinjaBoard(p2.el), b2 = lend(pb2, p2.rel, () => { died2++; });
  await b2.frameReady(); b2.borrow(); await b2.load(PUZ(T2));
  doc.hidden = true; p2.f.dead = true;
  await b2.load(PUZ(T3));
  assert.equal(died2, 0, 'a load in a hidden tab');
  doc.hidden = false; await sleep(250); pb2.destroy();
});

await test('a frame slow to say it has a position (a slow phone) is not dead: Rush stays on it', async () => {
  const keep = NinjaBoard.MS; NinjaBoard.MS = { ...keep, heart: 1000, dead: 1000 };
  const { el, f, rel } = page(); alive(f, 300);
  const pb = new NinjaBoard(el); let died = 0;
  const b = lend(pb, rel, () => { died++; });
  await b.frameReady(); b.borrow();
  for (const tps of [T2, T3]) {
    const t = performance.now();
    await b.load(PUZ(tps));
    assert.ok(performance.now() - t >= 290 && performance.now() - t < 900, 'waited for its word');
  }
  assert.equal(died, 0); assert.ok(b.borrowed, 'still on the frame'); assert.ok(!f.dataset.down);
  const p1 = b.load(PUZ(T1)), p2 = b.load(PUZ(T2)); await Promise.all([p1, p2]);
  assert.equal(died, 0);
  b.giveBack(); pb.destroy(); NinjaBoard.MS = keep;
});

await test('the frame taken out of the page mid-run: no error, Rush hears it, the puzzle page says so', async () => {
  const { el, f, rel } = page(); alive(f);
  const pb = new NinjaBoard(el, {}); let died = 0; await sleep(5);
  await pb.load(PUZ(T1, ['a1', 'f6']));
  const b = lend(pb, rel, () => { died++; });
  await b.frameReady(); b.borrow();
  await b.load(PUZ(T2)); await b.setPlayer(2); await b.ui({ disableBoard: false });
  const errs = []; process.on('unhandledRejection', (e) => errs.push(e));
  f.remove(); f.contentWindow = null;
  await sleep(250);
  assert.deepEqual(errs, [], 'no error');
  assert.equal(died, 1);
  assert.equal(said(pb), 'stopped');
  assert.equal(await b.frameReady(), false);
  pb.destroy();
});

await test('the frame laid over Rush\'s box: its box exactly (clipped there), PTN Ninja\'s board as large as fits, centred', async () => {
  for (const box of [{ left: 40, top: 60, width: 500, height: 640 }, { left: 16, top: 120, width: 358, height: 452 }, { left: 0, top: 0, width: 300, height: 300 }]) {
    const { el, f, rel } = page(); alive(f); rel.rect = box;
    const pb = new NinjaBoard(el), b = lend(pb, rel);
    await b.frameReady(); b.borrow(); await b.load(PUZ(T1));
    const css = f.style.cssText, px = (k) => +new RegExp(`(?:^|;)${k}:([-\\d.]+)px`).exec(css)[1];
    const [t, r, bo, l] = /clip-path:inset\(([^)]*) round/.exec(css)[1].split(' ').map((x) => parseFloat(x));
    const vis = { left: px('left') + l, top: px('top') + t, right: px('left') + px('width') - r, bottom: px('top') + px('height') - bo };
    const near = (a, x, what) => assert.ok(Math.abs(a - x) < 0.02, `${what}: ${a} vs ${x}`);
    near(vis.left, box.left + scrollX, 'left'); near(vis.top, box.top + scrollY, 'top (page coordinates)');
    near(vis.right, box.left + box.width, 'right'); near(vis.bottom, box.top + scrollY + box.height, 'bottom');
    assert.match(css, /position:absolute/); assert.match(css, /visibility:visible/); assert.match(css, /round 6px/);
    const g = frameGeom({}, 6), w = Math.min(box.width, box.height * g.ratio);
    near(px('width'), w * g.w, 'the frame as wide as PTN Ninja\'s board needs, from the box that fits');
    assert.ok(px('width') >= box.width - 0.01 || px('height') >= box.height - 0.01, 'the frame covers the box one way at least');
    b.giveBack(); pb.destroy();
  }
});

await test('the end of a run: dimmed; PTN Ninja\'s own turn of its board for the pictures', async () => {
  const { el, f, rel } = page(); alive(f);
  const pb = new NinjaBoard(el), b = lend(pb, rel);
  await b.frameReady(); b.borrow(); await b.load(PUZ(T1)); await sleep(150);
  assert.equal(f.style.opacity, '1', 'shown once drawn');
  b.dim(true); assert.equal(f.style.opacity, '.55');
  assert.deepEqual(b.frameM(), [1, 0, 0, 1]);
  say(f, 'SET_UI', { boardTransform: [1, 0] });
  assert.deepEqual(b.frameM(), [0, 1, -1, 0], 'turned once: as the ] key turns it');
  ls.delete('tinue.ninjaTransform');
  b.giveBack(); pb.destroy();
});

await test('the words in the board\'s place are plain and few', () => {
  assert.deepEqual(SAYS, { note: 'Loading the board…', load: 'The board (PTN Ninja) didn’t load.', stopped: 'The board (PTN Ninja) stopped answering.' });
});

// rush.js's side of a board that fails (it needs a browser to run: e2e-rush-ninja runs it; these pin it in npm test)
await test('rush.js: a run starts only on a board that is there; one whose board dies goes as abandoned and is never kept', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../public/rush.js', import.meta.url), 'utf8');
  const fn = (name) => { const i = src.search(new RegExp('^(async )?function ' + name + '\\(', 'm')); assert.ok(i >= 0, name); const j = src.indexOf('\n}\n', i); return src.slice(i, j); };
  const start = fn('startRun');
  assert.ok(start.indexOf('const up = board.frameReady();') >= 0, 'Start asks for the board');
  const ok = start.indexOf('const ok = await up;'), gate = start.indexOf('if (!ok) return boardMissing();'), run = start.indexOf('st = { who:');
  assert.ok(ok >= 0 && gate > ok && run > gate, 'Start waits for the board and stops before the run exists without it');
  assert.ok(start.indexOf('abandon(st)') > gate && start.indexOf("write(SPARE_KEY, rest)") > gate, 'nothing is spent before the board is there');
  const died = fn('boardDied');
  assert.match(died, /s\.boardDown = true;\s*abandon\(s\);/, 'a run whose board died is marked so and posted as abandoned');
  assert.match(died, /endRun\(\)/);
  const end = fn('endRun');
  assert.ok(end.includes("if (s.gone !== 'left' && !s.boardDown) saveRun(rec);"), 'never kept as a run of this browser\'s');
  assert.ok(end.includes("if (s.boardDown) return showBest(null, null, s, 'board');"), 'nothing more is posted; the end screen says why');
  assert.equal((src.match(/saveRun\(/g) || []).length, 2, 'saveRun: its definition and that one call');
  assert.match(src, /onDead: boardDied/);
});

console.log(`all ${n} passed`);
