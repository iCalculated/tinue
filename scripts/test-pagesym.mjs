// A puzzle page visit under a symmetry (public/pagesym.js: a puzzle opened from a Rush run shows as it did in the run):
// orienting the puzzle the page gets, the boundary that turns everything outgoing back, and the page's use of both.
// The server must not notice: every request a visit makes under s is the one the same visit makes at s = 0.
// (scripts/e2e-pagesym.mjs drives the real page in headless Chrome against a recording fake API.)
//   node scripts/test-pagesym.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../shared/tak.js';
import * as SYM from '../shared/sym.js';
import { orientPage, unorientPage, toServer, symOf, puzzleHash } from '../public/pagesym.js';
import { createOutbox } from '../public/outbox.js';
import * as R from '../public/rush-rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
let n = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); n++; console.log('ok', name); } catch (e) { failed++; console.log('FAIL', name, '\n ', e.message.split('\n').slice(0, 4).join('\n  ')); } };
const S7 = [1, 2, 3, 4, 5, 6, 7];
const norm = (t) => Game.fromTPS(t).toTPS();
const legal = (g) => g.legalMoves().map((m) => g.moveToPTN(m));

// Puzzles as GET /api/puzzle sends them. The real 6×6 sample (no history: the page builds them from their TPS), plus
// one generated per size with a game history from the empty board (the page then builds everything from it), a dragon
// path, alts and altsAt, and a tree two moves deep.
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rush-sym-sample.json'), 'utf8'))
  .map((p) => { const { before, last, ...q } = p; return { ...q, themes: ['roadIn3'], attempts: 3, solves: 1, rd: 80, rev: 2 }; });
function rng(seed) { return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); }
function generated(size, seed) {
  const rnd = rng(seed), g = new Game(size), history = [];
  const pick = (h) => { const ms = legal(h); return ms[Math.floor(rnd() * ms.length)]; };
  // stack moves only come after a few placements; 3 + 2·size plies gives a few stacks to move
  for (let i = 0, tries = 0; i < 3 + 2 * size && tries < 500; tries++) {
    const m = pick(g), h = g.clone(); h.play(m);
    if (h.result()) continue; // (the puzzle's start is a game still going)
    g.play(m); history.push(m); i++;
  }
  const tps = g.toTPS(), ms = legal(g);
  const m1 = ms[0], h = g.clone(); h.play(m1);
  const r1 = legal(h).at(-1); h.play(r1);
  const m2 = legal(h)[1];
  return { id: `gen${size}`, size, tps, plies: 3, komi: size === 6 ? 2 : 0, rating: 1500, rd: 90, attempts: 0, solves: 0, themes: [],
    source: 'playtak', sourceRef: 'game/123', tree: { [m1]: { r: r1, n: { [m2]: { r: null, n: 'win' } } } },
    meta: { history, white: 'w', black: 'b', ratingWhite: 1, ratingBlack: 2, dragon: { path: history.slice(-2), depth: 2 } },
    turn: g.toMove, pre0: 0, alts: [ms[2], ms[3]], altsAt: { [`${m1} ${r1}`]: [legal(h)[2]] }, rev: 1 };
}
const GEN = [4, 5, 6, 7, 8].map((size, i) => generated(size, 7 + i));
const ALL = [...SAMPLE, ...GEN];

await test('symmetry segment: 1..7 only; anything else is 0, and s = 0 is the route as it always was', () => {
  for (const s of S7) { assert.equal(symOf(String(s)), s); assert.equal(puzzleHash('pd 1', s), `#/puzzle/pd%201/${s}`); }
  for (const bad of [undefined, null, '', '0', '8', '9', 'x', '07', '-1', '3.5', ' 3', '3 ', 3]) assert.equal(symOf(bad), 0, String(bad));
  for (const bad of [0, 8, -1, 'x', undefined]) assert.equal(puzzleHash('pd1', bad), '#/puzzle/pd1');
  assert.equal(puzzleHash('pd1'), '#/puzzle/pd1');
});

await test('orientPage: s = 0 is the server object itself; otherwise new objects, the canonical one untouched', () => {
  for (const p of ALL) {
    assert.equal(orientPage(p, 0), p); assert.equal(orientPage(p, 9), p);
    const before = JSON.stringify(p);
    for (const s of S7) { const q = orientPage(p, s); assert.notEqual(q, p); assert.equal(q.sym, s); if (p.meta) assert.notEqual(q.meta, p.meta); }
    assert.equal(JSON.stringify(p), before, 'never mutated');
  }
});

await test('orientPage / unorientPage: every field the page uses turns and turns back exactly, key order included', () => {
  for (const p of ALL) for (const s of S7) {
    const q = orientPage(p, s), n = p.size;
    assert.equal(JSON.stringify(unorientPage(q)), JSON.stringify(p), `${p.id} ${s}`);
    assert.equal(q.tps, SYM.tps(s, p.tps));
    assert.deepEqual(Object.keys(q.tree), Object.keys(p.tree).map((m) => SYM.move(s, n, m)));
    if (p.alts) assert.deepEqual(q.alts, p.alts.map((m) => SYM.move(s, n, m)));
    if (p.altsAt) assert.deepEqual(Object.keys(q.altsAt), Object.keys(p.altsAt).map((k) => k.split(' ').map((m) => SYM.move(s, n, m)).join(' ')));
    if (p.meta) {
      // the history replays from the empty board to the turned start, and its last move (the intro's) is the turned one
      const g = new Game(n);
      for (const m of q.meta.history) g.play(m);
      assert.equal(g.toTPS(), norm(q.tps), `${p.id} ${s} history`);
      assert.equal(q.meta.history.at(-1), SYM.move(s, n, p.meta.history.at(-1)));
      assert.deepEqual(q.meta.dragon.path, p.meta.dragon.path.map((m) => SYM.move(s, n, m)));
      assert.deepEqual([q.meta.white, q.meta.black, q.meta.dragon.depth], [p.meta.white, p.meta.black, p.meta.dragon.depth]);
    }
    for (const k of ['id', 'size', 'komi', 'rating', 'rev', 'themes', 'attempts', 'turn', 'source', 'sourceRef']) assert.deepEqual(q[k], p[k], k);
  }
});

await test('canonical move forms commute with every symmetry (g.canon of a turned move is the turned canon)', () => {
  let k = 0;
  for (const p of [...SAMPLE.slice(0, 6), ...GEN]) {
    const g = Game.fromTPS(p.tps, p.komi);
    for (const s of S7) {
      const h = Game.fromTPS(SYM.tps(s, p.tps), p.komi);
      for (const m of legal(g)) {
        // the forms a player types: as written, with the count 1 spelled out, with the drops spelled out
        const st = /^(\d?)([a-h][1-8])([<>+-])(\d*)$/.exec(m), forms = [m];
        if (st) { const c = +(st[1] || 1); forms.push(c + st[2] + st[3] + (st[4] || String(c))); }
        for (const f of forms) { assert.equal(h.canon(SYM.move(s, p.size, f)), SYM.move(s, p.size, g.canon(f)), `${p.id} ${s} ${f}`); k++; }
      }
    }
  }
  assert.ok(k > 5000, k);
});

await test('toServer: s = 0 is the identity on everything (same bytes, same objects); otherwise back undoes fwd', () => {
  const id = toServer(0, 6), log = [{ m: 'a1', ms: 3, k: 'ok' }], r = { pv: ['a1'] };
  assert.equal(id.back('a1'), 'a1'); assert.equal(id.log(log), log); assert.equal(id.answer(r), r);
  assert.equal(id.tps('x6/x6/x6/x6/x6/x6 1 1'), 'x6/x6/x6/x6/x6/x6 1 1'); // not even normalised
  for (const bad of [undefined, null, 9, 'x']) assert.equal(toServer(bad, 6).sym, 0);
  for (const p of ALL) for (const s of S7) {
    const x = toServer(s, p.size), g = Game.fromTPS(p.tps, p.komi);
    for (const m of legal(g)) assert.equal(x.back(x.fwd(m)), m);
    assert.equal(x.tps(SYM.tps(s, p.tps), p.komi), norm(p.tps));
  }
});

// ---------- a scripted visit, at the boundary ----------
// What app.js sends about a puzzle, built with the same pieces it uses: the outbox (its queued /api/move bodies, as
// stored), report()'s /api/result body with its log (s.x.log), the engine worker's position (enginePos), /api/analyze's
// address (runEngine) and /api/defend's (defend.js syntaksReply with s.x). The play is fixed in the puzzle's own
// labels and entered as the player sees it (turned), so under every s the requests must be the s = 0 ones, byte for byte.
const stubs = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window ??= {}; globalThis.localStorage ??= stubs;
const defend = await import('../public/defend.js');
console.debug = () => {}; // (defend.js says which engine answered)
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

async function visit(p0, s) {
  const p = orientPage(p0, s), n = p.size, komi = p.komi || 0;
  const x = toServer(p.sym, n), fwd = (m) => SYM.move(s, n, m); // what the player enters for the puzzle's own move m
  const out = { engine: [], urls: [] };
  // enginePos as app.js writes it, with S.p, S.p0, S.hist and S.x as start() sets them
  const S = { p, p0, x, hist: p.meta?.history || [] };
  const enginePos = (plies) => ({ size: S.p.size, komi: S.p.komi || 0, tps: S.hist.length ? null : S.p0.tps, plies: plies.map(S.x.back) });
  const st = store();
  const ob = createOutbox({ url: '/api/move', fetch: async () => ({ status: 200 }), storage: st, token: () => 'tok', later: () => {}, nonce: () => 'N'.repeat(22), now: () => 1000, build: 7 });
  ob.setMode('shadow');
  const att = ob.open(p, 'roadIn3');
  const g = Game.fromTPS(p.tps, komi), log = [], hist = [...S.hist];
  const line = () => (hist.length ? [...hist] : []);
  const k1 = Object.keys(p0.tree)[0];
  // a wrong move (any legal move off the tree and off the alts), judged a miss after the engine had its look
  const wrong = legal(Game.fromTPS(p0.tps, komi)).find((m) => !(m in p0.tree) && !(p0.alts || []).includes(m));
  const w = fwd(wrong), fill = ob.hold(att, g.canon(w), { ms: 900 });
  out.engine.push(enginePos([...line(), g.canon(w)]));
  log.push({ m: g.canon(w), ms: 900, k: 'miss' }); fill('missed');
  // a move judged off the tree (a listed alternative: slowerWins), played out against crux's Syntaks for one reply
  if (p0.alts?.length) {
    const a = fwd(p0.alts[0]), po = { g: g.clone(), local: false, engine: 'syntaks', fallback: false };
    ob.hold(att, po.g.canon(a), { ms: 1500 })('play');
    log.push({ m: a, ms: 1500, k: 'slow' });
    po.g.play(a);
    out.engine.push(enginePos([...line(), a]));
    globalThis.fetch = async (url) => { out.urls.push(url); const t = new URL('http://x' + url).searchParams.get('tps'); const h = Game.fromTPS(t, komi); return { json: async () => ({ move: legal(h)[0], mate: null, winProb: 0.5 }) }; };
    const r = await defend.syntaksReply(po, po.g.toTPS(), komi, () => true, x);
    out.reply = x.back(r.move); // in the puzzle's own labels again, to compare
    assert.ok(legal(po.g).includes(r.move), 'the reply is legal on the page\'s (turned) board');
    po.g.play(r.move);
    const m = fwd(legal(Game.fromTPS(x.tps(po.g.toTPS(), komi), komi))[0]); // (the same move whatever the labels)
    ob.move(att, m, { clientVerdict: 'reply', ms: 2100 }); log.push({ m, ms: 2100, k: 'po' });
  }
  // then the solution: the puzzle's first move and the defender's reply, then its next move
  let node = p.tree, k = fwd(k1);
  ob.move(att, g.canon(k), { clientVerdict: 'ok', ms: 3000 }); log.push({ m: g.canon(k), ms: 3000, k: 'ok' });
  g.play(k); hist.push(k);
  if (node[k].r) { g.play(node[k].r); hist.push(node[k].r); }
  out.analyze = `/api/analyze?tps=${encodeURIComponent(x.tps(g.toTPS(), komi))}&komi=${komi}`; // runEngine's address
  const pv = { engine: 'syntaks', pv: [legal(Game.fromTPS(norm(x.tps(g.toTPS(), komi)), komi))[0]], best: null };
  out.pvBack = x.back(x.answer(pv).pv[0]); // (the line comes back turned: shown on the page's board)
  assert.ok(legal(g).includes(x.answer(pv).pv[0]));
  ob.act(att, 'view', { ms: 4000 });
  // the result body as report() builds it
  out.result = { puzzleId: p.id, win: false, theme: 'roadIn3', ms: 900, log: log.length ? x.log(log) : undefined };
  out.moves = JSON.parse(st.getItem('tinue.outbox')).map((e) => e.b);
  return out;
}

await test('a visit under each symmetry sends exactly what the same visit sends at s = 0 (results, plies, engine, analyze, defend)', async () => {
  for (const p of [SAMPLE[0], SAMPLE[7], SAMPLE[19], ...GEN]) {
    const base = await visit(p, 0);
    assert.ok(base.moves.length >= 3 && base.result.log.length >= 2, 'the visit sent something');
    for (const s of S7) {
      const v = await visit(p, s);
      assert.deepEqual(v.moves, base.moves, `${p.id} s=${s} /api/move bodies`);
      assert.deepEqual(v.result, base.result, `${p.id} s=${s} /api/result body`);
      assert.deepEqual(v.engine, base.engine, `${p.id} s=${s} engine positions`);
      assert.equal(v.analyze, base.analyze, `${p.id} s=${s} /api/analyze`);
      assert.deepEqual(v.urls, base.urls, `${p.id} s=${s} /api/defend`);
      assert.equal(v.reply, base.reply); assert.equal(v.pvBack, base.pvBack);
    }
  }
});

await test('Rush leaves its turned position alone: defend.syntaksReply without a boundary sends what it is given', async () => {
  const p = orientPage(SAMPLE[0], 3), po = { g: Game.fromTPS(p.tps, 2), local: false, engine: 'syntaks' }, urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return { json: async () => ({ move: legal(po.g)[0] }) }; };
  await defend.syntaksReply(po, p.tps, 2, () => true);
  assert.equal(urls[0], `/api/defend?tps=${encodeURIComponent(p.tps)}&komi=2`);
});

await test('the outbox keeps no symmetry: an attempt at s = 0 is as before, and a queued body never carries sym or size', () => {
  const st = store(), ob = createOutbox({ url: '/api/move', fetch: async () => ({ status: 200 }), storage: st, token: () => 'tok', later: () => {}, nonce: () => 'N'.repeat(22) });
  ob.setMode('shadow');
  assert.deepEqual(Object.keys(ob.open(SAMPLE[0], '')), ['nonce', 'puzzleId', 'rev', 'theme', 'owner', 'n', 'closed']);
  const a = ob.open(orientPage(SAMPLE[0], 5), '');
  assert.equal(a.sym, 5);
  ob.move(a, SYM.move(5, 6, 'a1'));
  const [e] = JSON.parse(st.getItem('tinue.outbox'));
  assert.equal(e.b.move, 'a1'); assert.ok(!('sym' in e.b) && !('size' in e.b));
  assert.equal(ob.open({ ...SAMPLE[0], sym: 9 }, '').sym, undefined, 'a bad sym is none');
});

// ---------- the page's wiring (source checks, as test-freeplay.mjs does) ----------
const code = (src) => src.replace(/(^|\s)\/\/[^\n]*/g, '$1');
function fn(name) {
  const i = app.search(new RegExp(`(?<=^|\\n)(async )?function ${name}\\(`));
  assert.ok(i >= 0, `function ${name} in app.js`);
  let d = 0, j = app.indexOf('{', app.indexOf(')', i));
  for (let k = j; k < app.length; k++) { if (app[k] === '{') d++; else if (app[k] === '}' && --d === 0) return code(app.slice(i, k + 1)); }
  throw new Error(name);
}
await test('app.js: one place orients (loadById), one boundary maps back, and the next puzzle never gets a symmetry', () => {
  const src = code(app);
  assert.equal(src.match(/orientPage\(/g).length, 1, 'orientPage is called once');
  assert.match(fn('loadById'), /start\(orientPage\(puzzle, s\), reloaded \? reloadTheme\.theme : '', puzzle\)/);
  assert.match(fn('loadById'), /showPuzzleURL\(puzzle\.id, s\)/);
  // loadNext: the next puzzle (and the stored one, the pair, the queue) at s = 0, its address and its reload too
  const next = fn('loadNext');
  assert.match(next, /showPuzzleURL\(puzzle\.id\);\n {2}start\(puzzle, prefs\.theme\);/);
  assert.match(next, /reloadInto\(puzzle\.id, prefs\.theme\); return;/);
  assert.ok(!/sym|orient/i.test(next));
  // the state of a visit: its own boundary, made from the puzzle it shows, gone with it
  assert.match(fn('start'), /const s = S = \{ p, p0, x: toServer\(p\.sym, p\.size\), g, node: p\.tree,/);
  // everything that leaves: the result's log, the engine worker's position, /api/analyze, /api/defend, the outbox (by p.sym)
  assert.match(fn('report'), /log: s\.log\.length \? s\.x\.log\(s\.log\) : undefined/);
  assert.match(src, /const enginePos = \(plies\) => \(\{ size: S\.p\.size, komi: S\.p\.komi \|\| 0, tps: S\.hist\.length \? null : S\.p0\.tps, plies: plies\.map\(S\.x\.back\) \}\);/);
  // the analysis after a puzzle (runEngine and friends; run under every symmetry in the test after this one): every
  // position it sends (/api/analyze, Tiltak) is s.x.tps of the page's, every answer is turned before it is read
  assert.match(fn('runServer'), /serverAnalyze\(s\.x\.tps\(g\.toTPS\(\), komi\), komi, ANALYSIS \? 3 : 1, ctl\)\.then\(\(r\) => \{\s*if \(!live\(\)\) return;\s*r = s\.x\.analysis\(r\);/);
  assert.match(fn('runServer'), /serverAnalyze\(s\.x\.tps\(c\.toTPS\(\), komi\), komi, 1, ctl\)\.then\(\(cr\) => \{\s*[^\n]*\n\s*cr = s\.x\.answer\(cr\);/);
  assert.match(fn('runTiltak'), /onInfo: \(r\) => \{\s*if \(!live\(\)\) return;\s*r = s\.x\.answer\(r\);/);
  assert.match(fn('runTiltak'), /\.then\(async \(r\) => \{\s*if \(!live\(\)\) return;\s*r = s\.x\.answer\(r\);/);
  assert.match(fn('runTiltak'), /cl = fromChild\(s\.x\.answer\(cr\), m, mover\);/);
  for (const name of ['runEngine', 'runServer', 'runTiltak', 'runSolver']) {
    const f = fn(name);
    for (const m of f.matchAll(/(?:serverAnalyze\(|tiltak\.analyze\(\{ tps: )([^,]+)/g)) assert.match(m[1], /^s\.x\.tps\(/, `${name}: ${m[0]}`);
  }
  assert.match(fn('runEngine'), /engine\.lines\(\{ \.\.\.enginePos\(plies\), pinned: S\.pins\.map\(\(p\) => s\.x\.back\(p\.move\)\) \}\)\.then\(\(r\) => \{ if \(r && live\(\)\) \{ S\.sol = s\.x\.facts\(r\);/);
  assert.match(fn('runSolver'), /fromEngine\(s, await engine\.analyze/);
  assert.ok(!/fetch\(/.test(fn('runEngine') + fn('runServer') + fn('runTiltak')), 'the analysis asks the server only through serverAnalyze');
  assert.match(fn('userMove'), /engine\.refute\(\{ \.\.\.enginePos\(plies\), attacker: S\.solver, remaining \}\)\.then\(\(r\) => \{\n\s*r = fromEngine\(s, r\);/);
  assert.match(fn('syntaksReply'), /defend\.syntaksReply\(po, tps, komi, live, s\.x\)/);
  assert.match(fn('start'), /s\.ob = o\.open\(p, s\.theme\)/);
  // every engine call that takes a position takes enginePos (none builds one from S.p.tps)
  for (const m of src.matchAll(/engine\.(checkStill|refute|analyze|proofLength|lines)\(\{ \.\.\.(\w+)/g)) assert.equal(m[2], 'enginePos', m[0]);
  assert.equal([...src.matchAll(/engine\.(checkStill|refute|analyze|proofLength|lines)\(/g)].length, 5, 'every engine call is in that list');
  // nothing else posts moves: /api/result only from report and from held records (no moves in them), /api/move only via the outbox
  assert.equal(src.split("'/api/move'").length, 2);
  assert.equal(src.split("withBuild('/api/result'").length, 4);
});

// ---------- the analysis after a puzzle, run for real ----------
// app.js's own runEngine, serverAnalyze, runServer, runTiltak, runSolver, setLines, paintShapes and playPV (with
// treePlies, gameAt, the lines and enginePos), taken from its source and run against fakes: /api/analyze answers three
// lines (one when asked about a child), the tactics worker is analysis.js solverLines itself, Tiltak and the solver
// answer from the position they are given. Each fake answers from what it is sent, so under a symmetry the page gets
// the s = 0 answers exactly when it sends the s = 0 requests.
const A = await import('../public/analysis.js');
const { moveSquares } = await import('../public/lines.js');
const { pliesLeftOf } = await import('../public/playon.js');
const { syntaksBoard } = await import('../shared/judge.js');
const ANA = ['gameAt', 'treePlies', 'runEngine', 'serverAnalyze', 'runServer', 'runTiltak', 'runSolver', 'setLines', 'paintShapes', 'playPV'];
const oneLine = (start) => { const l = app.split('\n').find((x) => x.startsWith(start)); assert.ok(l, start); return l; };
const anaSrc = [oneLine('const officialLine = '), oneLine('const shownLine = '), oneLine('const enginePos = '), oneLine('const fromEngine = '),
  ...ANA.map(fn)].join('\n');
const DEPS = ['board', 'engine', 'tiltak', 'API', 'fetch', 'setTimeout', 'clearTimeout', 'renderAll', 'renderEngine', 'Game', 'pinnedAt', 'fromSyntaks', 'fromTiltak',
  'fromChild', 'quickLine', 'mergeLines', 'pickCandidates', 'moveSquares', 'syntaksBoard', 'ANALYSIS', 'finePointer',
  'pliesLeftOf', 'showLine', 'afterExplore'];
const makeAna = new Function(...DEPS, `let S = null, anaCtl = null; const canonG = new Map();\n${anaSrc}\nreturn { setS: (v) => { S = v; }, S: () => S, ${ANA.join(', ')} };`);
const tick = () => new Promise((r) => setTimeout(r, 0));
async function analysisVisit(p0, s, { server = true, tiltakOk = true, miss = true, analysis = true } = {}) {
  const p = orientPage(p0, s), n = p.size, komi = p.komi || 0, x = toServer(p.sym, n);
  const rec = { urls: [], worker: [], tiltak: [], solver: [], shapes: null };
  const legalAt = (t) => legal(Game.fromTPS(t, komi));
  const fetchFake = async (url) => {
    rec.urls.push(url);
    const q = new URL('http://x' + url).searchParams, ms = legalAt(q.get('tps'));
    const line = (i, wp) => ({ move: ms[i], pv: [ms[i], ms[(i + 3) % ms.length]], scoreCp: 10 - i, mate: null, winProb: wp, depth: 7 - i });
    if (!server) return { json: async () => ({ error: 'busy' }) };
    if (q.get('lines') === '3') return { json: async () => ({ engine: 'syntaks', ...line(0, 0.62), best: ms[0], multipv: true, ms: 900, lines: [line(0, 0.62), line(1, 0.55), line(2, 0.4)] }) };
    return { json: async () => ({ engine: 'syntaks', ...line(1, 0.3) }) };
  };
  // (the worker's own gameFrom: engine-worker.js)
  const posGame = ({ size, komi: k, tps, plies }) => { const g = tps ? Game.fromTPS(tps, k || 0) : Object.assign(new Game(size), { komi: k || 0 }); for (const m of plies) g.play(m); return g; };
  const engineFake = {
    lines: async (pos) => { rec.worker.push(pos); return A.solverLines(posGame(pos), { pinned: pos.pinned }); },
    analyze: async (pos) => { rec.solver.push(pos); const g = posGame(pos), ms = legal(g); return { kind: 'win', pv: [ms[2], ms[0], ms[1]], plies: 3, side: g.toMove }; },
  };
  const tiltakFake = {
    stop() {}, supports: (size) => tiltakOk && size <= 6,
    analyze: async ({ tps, ms: t, onInfo }) => {
      rec.tiltak.push([tps, t]);
      const ms = legalAt(tps), r = { pv: [ms[0], ms[1]], bestmove: ms[0], winProb: t > 1000 ? 0.58 : 0.47, depth: 4, nodes: 900, timeMs: t };
      onInfo?.({ ...r, pv: [ms[1]] }); onInfo?.(r);
      return r;
    },
  };
  const shown = { branch: null };
  const F = makeAna({ shapes: (l) => { rec.shapes = l; } }, engineFake, tiltakFake, '', fetchFake, (f, ms) => (ms >= 1000 ? 0 : setTimeout(f, 0)), () => {}, () => {}, () => {},
    Game, A.pinnedAt, A.fromSyntaks, A.fromTiltak, A.fromChild, A.quickLine, A.mergeLines, A.pickCandidates, moveSquares, syntaksBoard, analysis, { matches: true }, pliesLeftOf, async (line, idx) => { shown.line = line; shown.idx = idx; }, () => {});
  // the puzzle solved: its first move and the reply, entered as the player saw them; a miss before that, at the start
  const g0 = Game.fromTPS(p0.tps, komi), k1 = Object.keys(p0.tree)[0], r1 = p0.tree[k1].r;
  const wrong = legal(g0).filter((m) => !(m in p0.tree) && !(p0.alts || []).includes(m)).at(-3);
  const fwd = (m) => SYM.move(s, n, m), hist = p.meta?.history || [];
  const S = { p, p0, x, hist, g: Game.fromTPS(p.tps, komi), solver: Game.fromTPS(p.tps, komi).toMove, status: 'solved', view: hist.length, branch: null, onBranch: false,
    moves: [k1, r1].filter(Boolean).map((m) => ({ ptn: fwd(m) })), misses: miss ? [{ at: 0, ptn: fwd(wrong) }] : [], lines: [], sel: 0 };
  F.setS(S);
  await F.runEngine();
  for (let i = 0; i < 8; i++) await tick();
  // play the second line's moves (as the panel's move buttons do) on a copy of the state
  const lines = S.lines.map((l) => ({ ...l })), pins = (S.pins || []).map((l) => ({ ...l }));
  const shapes = rec.shapes;
  if (S.lines[1]) { await F.playPV(1, 1); rec.branch = S.branch && { ...S.branch, moves: [...S.branch.moves] }; }
  return { ...rec, shapes, lines, pins, sol: S.sol, eng: S.eng, x, wrong: fwd(wrong), puzzle: fwd(k1) };
}
// The s = 0 answer turned by s: a line's moves, an arrow's squares.
const turnLine = (s, n) => (l) => ({ ...l, move: SYM.move(s, n, l.move), pv: l.pv.map((m) => SYM.move(s, n, m)) });

await test('the analysis view off (the production build): production\'s one request per position, line 1 only, no facts, candidates or shapes', async () => {
  for (const [p, opts] of [[SAMPLE[0], {}], [GEN[2], {}], [SAMPLE[3], { server: false }], [GEN[1], {}], [GEN[0], { tiltakOk: false }]]) {
    for (const s of [0, 5]) {
      const v = await analysisVisit(p, s, { ...opts, analysis: false }), n = p.size;
      assert.equal(v.worker.length, 0, `${p.id}: no tactics worker (engine.lines)`);
      assert.ok(!v.shapes?.length, `${p.id}: nothing drawn on the board (only the clearing)`);
      assert.deepEqual(v.pins, [], `${p.id}: no pinned moves`);
      assert.ok(v.lines.length <= 1, `${p.id}: one line at most`);
      assert.ok(!v.lines.some((l) => l.cand), `${p.id}: no candidates`);
      if (n === 6 && opts.server !== false) {
        assert.equal(v.urls.length, 1, `${p.id}: one request`);
        assert.doesNotMatch(v.urls[0], /lines=/, `${p.id}: production's URL`);
        assert.equal(v.tiltak.length, 0);
      } else if (n === 6) assert.equal(v.tiltak.length, 0, `${p.id}: never Tiltak on 6×6`);
      else assert.ok(v.tiltak.length <= 1, `${p.id}: Tiltak's one search, no candidate searches`);
      if (s === 0) continue;
      // the same request as an ordinary (s = 0) visit, byte for byte
      const b = await analysisVisit(p, 0, { ...opts, analysis: false });
      assert.deepEqual(v.urls, b.urls, `${p.id} s=${s}: the s = 0 request`);
    }
  }
});

await test('the analysis under each symmetry: the s = 0 requests byte for byte, the s = 0 lines, pins and arrows turned', async () => {
  const cases = [[SAMPLE[0], {}], [SAMPLE[7], {}], [SAMPLE[19], {}], [GEN[2], {}], [SAMPLE[3], { server: false }], [GEN[1], {}], [GEN[3], {}], [GEN[0], { tiltakOk: false }]];
  let checked = 0, quickSeen = 0, searchSeen = 0;
  for (const [p, opts] of cases) {
    const base = await analysisVisit(p, 0, opts), n = p.size;
    // the visit really analysed something, and the pins are there to be recognised
    assert.ok(base.lines.length >= 1, `${p.id}: lines`);
    assert.ok(base.pins.some((l) => l.tags.includes('yours') && l.move === base.wrong), `${p.id}: the miss is pinned`);
    if (opts.server !== false && n === 6) {
      // a miss that hands over a win in 1 is judged on the page (quickLine: a proven loss, no search of its own)
      const quick = base.lines.find((l) => l.tags.includes('yours'))?.src === 'solver';
      if (quick) quickSeen++; else searchSeen++;
      assert.ok(base.urls.some((u) => u.endsWith('&lines=3')) && base.urls.some((u) => !u.includes('&lines=')) !== quick, `${p.id}: three lines and a child search unless judged`);
      assert.ok(base.lines.some((l) => l.tags.includes('yours')), `${p.id}: the miss is a line`);
    }
    for (const s of S7) {
      const v = await analysisVisit(p, s, opts), T = turnLine(s, n);
      const what = `${p.id} s=${s}`;
      // what leaves the page: the server's addresses, the worker's and Tiltak's positions, all as at s = 0
      assert.deepEqual(v.urls, base.urls, `${what} /api/analyze`);
      assert.deepEqual(v.worker, base.worker, `${what} engine.lines`);
      assert.deepEqual(v.tiltak, base.tiltak, `${what} Tiltak`);
      assert.deepEqual(v.solver, base.solver, `${what} engine.analyze`);
      // what the player sees: the same lines (order, evaluations, tags, sources), every move turned
      assert.deepEqual(v.lines, base.lines.map(T), `${what} lines`);
      assert.deepEqual(v.pins, base.pins.map(T), `${what} pins`);
      assert.ok(v.pins.some((l) => l.tags.includes('yours') && l.move === v.wrong), `${what}: the miss is recognised`);
      if (base.pins.some((l) => l.tags.includes('puzzle'))) {
        const pz = v.lines.find((l) => l.tags.includes('puzzle'));
        assert.ok(pz && pz.move === v.puzzle && pz.ev.kind === 'win' && pz.ev.proven, `${what}: the puzzle's move is a proven line`);
      }
      // the solver's facts as the page holds them (threat marks, the threat sentence, wins): turned
      assert.deepEqual(v.sol?.threats, base.sol?.threats?.map((m) => SYM.move(s, n, m)), `${what} threats`);
      assert.deepEqual(v.sol?.pinned, base.sol?.pinned && Object.fromEntries(Object.entries(base.sol.pinned).map(([k, w]) => [SYM.move(s, n, k), w])), `${what} verdicts`);
      // the squares marked on the board: the s = 0 ones turned
      assert.deepEqual(v.shapes, base.shapes.map((x) => ({ ...x, sqs: x.sqs.map((q) => SYM.move(s, n, q)) })), `${what} marked squares`);
      // a line played onto the board: the s = 0 moves turned
      assert.deepEqual(v.branch && { ...v.branch }, base.branch && { ...base.branch, moves: base.branch.moves.map((m) => SYM.move(s, n, m)) }, `${what} playPV`);
      checked++;
    }
  }
  assert.equal(checked, 8 * 7);
  assert.ok(quickSeen && searchSeen, `both kinds of miss on 6×6 (judged ${quickSeen}, searched ${searchSeen})`);
});

await test('the analysis at s = 0 is the analysis branch\'s: the requests carry the page\'s own position, untouched', async () => {
  const p = SAMPLE[0], v = await analysisVisit(p, 0);
  // (view at the start: the position the miss was made in, sent exactly as Game.toTPS writes it)
  assert.equal(v.urls[0], `/api/analyze?tps=${encodeURIComponent(Game.fromTPS(p.tps, p.komi).toTPS())}&komi=${p.komi}&lines=3`);
  const x = toServer(0, 6);
  for (const k of ['back', 'fwd', 'tps', 'answer', 'analysis', 'facts']) { const o = { a: 1 }; assert.equal(x[k](o), o, k); }
});

await test('app.js: the address carries the symmetry for this visit only', () => {
  const src = code(app);
  assert.match(fn('reloadNow'), /reloadInto\(S\?\.p\?\.id, S\?\.theme, symNow\(\)\)/);
  assert.match(fn('reloadInto'), /APP \+ location\.search \+ \(id \? puzzleHash\(id, s\) : '#\/'\)/);
  assert.match(fn('route'), /const sym = symOf\(symArg\);/);
  assert.match(fn('route'), /showPuzzleURL\(S\.p\.id, symNow\(\)\); /);
  assert.match(src, /url: location\.origin \+ puzzlePath\(p\.id, p\.sym \|\| 0\)/);
  // other puzzles' links (the streak's chips, History) stay plain; only the chip of the puzzle on screen keeps it
  assert.match(src, /href="#\/puzzle\/\$\{esc\(x\.id\)\}\$\{x\.id === S\.p\.id && symNow\(\) \? '\/' \+ symNow\(\) : ''\}"/);
  assert.match(src, /<a href="#\/puzzle\/\$\{esc\(r\.puzzle_id\)\}">/);
  // the one-shot note from a Rush row is read and cleared on every route
  assert.match(fn('route'), /sessionStorage\.removeItem\('tinue\.lookFrom'\)/);
});

await test('app.js: an older Rush row for the puzzle on screen returns to the visit, or turns it as the run did', () => {
  // route()'s decision, as written there: a plain address with a note for the puzzle on screen works the symmetry out
  // against S.p0; the visit restarts only when the id or that symmetry differs from the one on screen.
  // (returning to the visit puts a board a superseded Next left back)
  assert.match(fn('route'), /if \(!sym && !zero && look\?\.id === id && S\?\.p\.id === id && S\.p0\) \{\s*try \{ want = symFromRecord\(S\.p0, look\); found = true; \} catch \{\}/);
  assert.match(fn('route'), /if \(S\?\.p\.id !== id \|\| symNow\(\) !== want\) loadById\(id, want, found \? null : look\); else \{ restoreLeft\(\); showPuzzleURL\(S\.p\.id, want\); \}/);
  const decide = (S, hash, look) => {
    const [, , arg, symArg] = hash.split('/'), id = decodeURIComponent(arg), sym = symOf(symArg);
    let want = sym;
    if (!sym && look?.id === id && S?.p.id === id && S.p0) want = R.symFromRecord(S.p0, look);
    return (S?.p.id !== id || (S?.p?.sym || 0) !== want) ? 'restart@' + want : 'same@' + want;
  };
  const p = SAMPLE[2], ans = Object.keys(p.tree)[0];
  for (const s of S7) {
    const q = orientPage(p, s), plain = { id: p.id, tps: q.tps, at: [], answer: SYM.move(s, p.size, ans) };
    const look = R.lookFrom(plain), link = R.puzzleLink(plain);
    assert.equal(link, `#/puzzle/${p.id}`, 'an older record links plainly');
    const want = R.symFromRecord(p, look);
    // S1: the visit opened from that row (at the symmetry recovered for it) is returned to, not restarted
    assert.equal(decide({ p: q.sym === want ? q : orientPage(p, want), p0: p }, link, look), 'same@' + want, `s=${s} second click`);
    // F2: the same puzzle on screen at s = 0 is turned as the run showed it
    if (want) assert.equal(decide({ p: orientPage(p, 0), p0: p }, link, look), 'restart@' + want, `s=${s} from s=0`);
    // without a note (or for another puzzle) nothing changes: a plain address is s = 0
    assert.equal(decide({ p: orientPage(p, want), p0: p }, link, null), want ? 'restart@0' : 'same@0');
    assert.equal(decide({ p: { id: 'other' }, p0: {} }, link, look), 'restart@0');
  }
});

// ---------- Rush's records and links ----------
await test('Rush records keep the symmetry; links carry it; older records stay valid and link plainly', () => {
  const p = SAMPLE[3], q = orientPage(p, 6), run = R.newRun('rush');
  R.startClock(run, 0); R.correct(run);
  R.finish(run, { id: p.id, rating: 1500, solved: true, ms: 1000, sym: 6, mv: [{ ms: 900, weight: 1, correct: true, ptn: SYM.move(6, 6, Object.keys(p.tree)[0]) }] });
  const rec = R.recordOf(run, [q], 1);
  assert.equal(rec.puzzles[0].sym, 6); assert.equal(rec.puzzles[0].tps, q.tps);
  assert.equal(R.puzzleLink(rec.puzzles[0]), `#/puzzle/${p.id}/6`);
  assert.ok(R.validRecord(rec));
  const plain = { ...rec, puzzles: rec.puzzles.map(({ sym, ...x }) => x) };
  assert.ok(R.validRecord(plain), 'a record from before keeps working');
  assert.equal(R.puzzleLink(plain.puzzles[0]), `#/puzzle/${p.id}`);
  assert.equal(R.puzzleLink({ ...rec.puzzles[0], sym: 0 }), `#/puzzle/${p.id}/0`, 'a record known unturned says so');
  for (const bad of [8, -1, 'x', 2.5, null]) assert.equal(R.validRecord({ ...rec, puzzles: [{ ...rec.puzzles[0], sym: bad }] }), false, String(bad));
});

await test('a record stored without its symmetry: the page works it out from the puzzle (last move and answer break ties)', () => {
  let ties = 0;
  for (const p0 of [...SAMPLE, ...GEN.filter((g) => g.size === 6)]) {
    const p = { ...p0, meta: p0.meta || { history: [] } };
    for (const s of SYM.SYMS) {
      const q = SYM.orient(p, s), last = p.meta.history.at(-1);
      const look = R.lookFrom({ id: p.id, tps: q.tps, ...(last ? { last: SYM.move(s, p.size, last) } : {}), at: [], answer: R.answerAt(q, []) });
      const got = R.symFromRecord(p, look);
      // the same picture with the same labels: the same square names and moves as in the run
      assert.equal(norm(SYM.tps(got, p.tps)), norm(q.tps), `${p.id} ${s}`);
      assert.equal(R.answerAt(SYM.orient(p, got), []), look.answer);
      if (got !== s) ties++;
    }
  }
  // a symmetric start: both symmetries draw it; the answer picks the one the run used
  const sq = { id: 'sym', size: 6, komi: 0, tps: 'x6/x6/x2,1,2,x2/x2,2,1,x2/x6/x6 1 3', tree: { a2: { r: 'e5', n: 'win' } }, meta: { history: [] } }; // (no history: only the answer can tell them apart)
  const fits = SYM.SYMS.filter((s) => norm(SYM.tps(s, sq.tps)) === norm(sq.tps));
  assert.ok(fits.length > 1, 'the start is symmetric');
  for (const s of fits) assert.equal(R.symFromRecord(sq, R.lookFrom({ id: 'sym', tps: SYM.tps(s, sq.tps), at: [], answer: SYM.move(s, 6, 'a2') })), s);
  // a record from before Rush's symmetries (its own orientation), a puzzle revised since, junk: 0
  assert.equal(R.symFromRecord(SAMPLE[0], R.lookFrom({ ...SAMPLE[0], answer: Object.keys(SAMPLE[0].tree)[0] })), 0);
  assert.equal(R.symFromRecord(SAMPLE[0], R.lookFrom({ id: 'x', tps: SAMPLE[1].tps, at: [], answer: null })), 0);
  assert.equal(R.symFromRecord(SAMPLE[0], { id: 'x', tps: 'junk' }), 0);
  assert.equal(R.symFromRecord(null, null), 0);
  void ties;
});

await test('a Rush row known to be unturned (sym 0) links with /0 and opens unturned, even while a turned visit of it is on screen', () => {
  assert.match(fn('route'), /const zero = symArg === '0';/);
  assert.match(fn('route'), /if \(!sym && !zero && !found && S\?\.p\.id === id\) want = symNow\(\);/);
  const p = SAMPLE[2], run = R.newRun('rush');
  R.startClock(run, 0); R.correct(run);
  R.finish(run, { id: p.id, rating: 1500, solved: true, ms: 1000, sym: 0, mv: [{ ms: 900, weight: 1, correct: true, ptn: Object.keys(p.tree)[0] }] });
  const link = R.puzzleLink(R.recordOf(run, [p], 1).puzzles[0]);
  assert.equal(link, `#/puzzle/${p.id}/0`);
  // route()'s choice, as written there, with a turned visit (s = 5) of the same puzzle on screen
  const [, , , symArg] = link.split('/'), sym = symOf(symArg), zero = symArg === '0', symNow = 5;
  let want = sym;
  if (!sym && !zero) want = symNow;
  assert.equal(want, 0, 'loads it under 0, not the turned visit');
});

await test('an older Rush row: the recorded line breaks a tie the answer cannot (two mirror-equivalent replies)', () => {
  const history = 'a1 a5 e1 a2 e2 b1 e3 a3 e4 c1 b5 b3 c5 c2 d5 b2'.split(' ');
  const g = new Game(6); for (const m of history) g.play(m);
  const p = { id: 'd', size: 6, tps: g.toTPS(), tree: { e5: { r: 'Sf5', n: 'win' } }, meta: { history } };
  const t5 = SYM.orient(p, 5);
  assert.equal(t5.tps, p.tps, 'the start is the same under 5');
  const at = ['e5', t5.tree.e5.r], answer = R.answerAt(t5, at);
  assert.equal(R.answerAt(p, at), answer, 'the answer alone cannot tell them apart');
  assert.equal(R.symFromRecord(p, R.lookFrom({ id: 'd', tps: t5.tps, last: SYM.move(5, 6, 'b2'), at, answer })), 5);
  assert.equal(R.symFromRecord(p, R.lookFrom({ id: 'd', tps: p.tps, last: 'b2', at: ['e5', 'Sf5'], answer: R.answerAt(p, ['e5', 'Sf5']) })), 0);
});

console.log(failed ? `test-pagesym: ${n} ok, ${failed} failed` : `all ${n} passed`);
if (failed) process.exit(1);
