// tinue's own board (public/board.js) is retired: PTN Ninja is the only board (Sasha, 2026-11-22: "switch entirely to
// ptn ninja with no fallback ... keep the code for our board for now but please have it hard fail if loaded"). Here:
// constructing it throws at once, whatever it is given; nothing the page loads imports board.js or constructs a Board;
// the helpers the page needs live in board-kit.js. (The built pages, production's and the beta's, are checked in a
// browser by scripts/e2e-ptn-only.mjs.)   node --no-warnings scripts/test-board-retired.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const root = new URL('..', import.meta.url).pathname;
const MSG = "tinue's own board is retired: PTN Ninja is the only board";

await test('new Board(...) throws at once, with a clear message, whatever it is given (no element is touched)', async () => {
  globalThis.document ??= { addEventListener() {} };
  const mod = await import('../public/board.js');
  assert.equal(mod.RETIRED, MSG);
  let touched = 0;
  const el = new Proxy({}, { get() { touched++; return () => {}; }, set() { touched++; return true; } });
  for (const args of [[el], [el, { onMove() {} }], [], [null], [{}, {}]]) {
    assert.throws(() => new mod.Board(...args), (e) => e instanceof Error && e.message === MSG, JSON.stringify(args.length));
  }
  assert.equal(touched, 0, 'it throws before doing anything');
  // no way around it: no flag, option or static turns it back on
  const src = fs.readFileSync(root + 'public/board.js', 'utf8');
  const ctor = src.slice(src.indexOf('constructor(el, { onMove } = {}) {'));
  assert.match(ctor, /^constructor\(el, \{ onMove \} = \{\}\) \{\n {4}throw new Error\(RETIRED\);/, 'the first statement');
  // its helpers are still there for anyone who imports them (the same functions as board-kit.js's)
  const kit = await import('../public/board-kit.js');
  for (const k of ['buildPTN', 'landOf', 'turnMark', 'focusedByPointer', 'hooks']) assert.equal(mod[k], kit[k], k);
});

// Every module the page can load: app.js and what it imports, statically or with import(), and the workers it starts
// (new Worker / new URL), followed through the files; plus index.html's scripts.
function graph(entry) {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(path.join(root, 'public', f), 'utf8');
    for (const m of src.matchAll(/(?:from|import\(|new URL\(|new Worker\()\s*['"]\.\/([^'"?]+)/g)) {
      const t = path.normalize(path.join(path.dirname(f), m[1]));
      if (t.endsWith('.js') && fs.existsSync(path.join(root, 'public', t))) todo.push(t);
    }
  }
  return seen;
}

await test('nothing the page loads imports board.js; the page loads board-kit.js and ninja.js instead', () => {
  const g = graph('app.js');
  for (const f of ['ninja.js', 'board-kit.js', 'rush.js', 'rush-look.js', 'settings.js', 'prefsync.js', 'ninja-look.js']) assert.ok(g.has(f), f + ' is in the page');
  assert.ok(!g.has('board.js'), 'board.js is not: ' + [...g].join(' '));
  const html = fs.readFileSync(root + 'public/index.html', 'utf8');
  assert.doesNotMatch(html, /board\.js/);
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
});

await test('no shipped file constructs a Board or names the class (board.js itself aside)', () => {
  const files = fs.readdirSync(root + 'public', { recursive: true }).filter((f) => /\.(js|html)$/.test(f) && f !== 'board.js' && !f.startsWith('vendor') && !/^(tiltak|syntaks)\//.test(f));
  assert.ok(files.length > 25, files.length + ' files');
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, 'public', f), 'utf8');
    assert.doesNotMatch(src, /new\s+Board\s*\(/, f + ': constructs a Board');
    assert.doesNotMatch(src, /\bimport\b[^;]*['"]\.\/board\.js/, f + ': imports board.js');
    assert.doesNotMatch(src, /\bBoard\.(onPly|onLand|onCut)\b/, f + ': uses the retired class\'s hooks');
  }
  // the server's pictures (og/share images) draw by themselves: they never construct the board either
  for (const f of ['server/share.js', 'server/server.js']) assert.doesNotMatch(fs.readFileSync(root + f, 'utf8'), /new\s+Board\s*\(|board\.js'/, f);
});

await test('the builds ship board-kit.js (and board.js, unloaded, which throws if anything ever loads it)', () => {
  const sh = fs.readFileSync(root + 'scripts/build-static.sh', 'utf8');
  assert.match(sh, /^cp public\/index\.html .*public\/board-kit\.js .*"\$OUT\/"$/m);
});

console.log(`all ${n} passed`);
