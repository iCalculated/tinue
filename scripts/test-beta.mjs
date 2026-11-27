// The beta build (scripts/build-beta.sh -> build-static.sh NAME/STUBS=none/BETA): where it goes, what it marks, and the
// page's hash routes when there are no per-puzzle pages.   node scripts/test-beta.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const root = new URL('..', import.meta.url).pathname;
const app = fs.readFileSync(root + 'public/app.js', 'utf8');
const { symOf } = await import(root + 'public/pagesym.js');
const sh = (script, args, env) => spawnSync('sh', [root + 'scripts/' + script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('puzzle addresses: a path with per-puzzle pages, the hash route without them', () => {
  const lines = app.split('\n');
  const src = ['const APP = ', 'const STUBS = ', 'const puzzlePath = '].map((s) => { const l = lines.find((x) => x.startsWith(s)); assert.ok(l, s); return l; }).join('\n');
  const at = (pathname, search, stubs) => vm.runInNewContext(src + '\npuzzlePath', { window: stubs === undefined ? {} : { TINUE_STUBS: stubs }, location: { pathname, search }, encodeURIComponent });
  assert.equal(at('/tinue/', '')('pd91325'), '/tinue/puzzle/pd91325');
  assert.equal(at('/tinue/puzzle/p1', '?board=ninja')('pd9'), '/tinue/puzzle/pd9?board=ninja');
  assert.equal(at('/tinue-beta/', '', false)('pd91325'), '/tinue-beta/#/puzzle/pd91325');
  assert.equal(at('/tinue-beta/', '?board=ninja', false)('pd 9'), '/tinue-beta/?board=ninja#/puzzle/pd%209');
  assert.equal(at('/tinue/', '', true)('p1'), '/tinue/puzzle/p1'); // only an explicit false turns the pages off
  // the address shown and the one compared with are the same function, so the page never loops rewriting it
  assert.match(app, /const showPuzzleURL = \(id, s = 0\) => \{ if \(location\.pathname \+ location\.search \+ location\.hash !== puzzlePath\(id, s\)\) showURL\(puzzlePath\(id, s\)\); \};/);
  assert.match(app, /const showURL = \(u\) => \{ history\.replaceState\(null, '', u\); pathShown = pathNow\(\); \};/);
});

test('a visit under a symmetry (a puzzle opened from a Rush run): #/puzzle/<id>/<s> on both builds; s = 0 as before', () => {
  const lines = app.split('\n');
  const src = ['const APP = ', 'const STUBS = ', 'const puzzlePath = '].map((s) => lines.find((x) => x.startsWith(s))).join('\n');
  const at = (pathname, search, stubs) => vm.runInNewContext(src + '\npuzzlePath', { window: stubs === undefined ? {} : { TINUE_STUBS: stubs }, location: { pathname, search }, encodeURIComponent });
  // s = 0 (and anything that isn't 1..7) leaves every address byte for byte as it was
  for (const [pn, q, stubs] of [['/tinue/', '', undefined], ['/tinue/puzzle/p1', '?board=ninja', undefined], ['/tinue-beta/', '', false], ['/tinue-beta/', '?board=ninja', false]]) {
    const f = at(pn, q, stubs);
    for (const bad of [0, 8, -1, 2.5, '3', null, NaN]) assert.equal(f('pd 9', bad), f('pd 9'), `${pn}${q} ${bad}`);
  }
  assert.equal(at('/tinue/', '')('pd9', 3), '/tinue/#/puzzle/pd9/3');
  assert.equal(at('/tinue/puzzle/p1', '?board=ninja')('pd9', 7), '/tinue/?board=ninja#/puzzle/pd9/7');
  assert.equal(at('/tinue-beta/', '', false)('pd9', 1), '/tinue-beta/#/puzzle/pd9/1');
  assert.equal(at('/tinue-beta/', '?board=ninja', false)('pd 9', 5), '/tinue-beta/?board=ninja#/puzzle/pd%209/5');
  // and the router (route(): the hash, else the path; then [, page, arg, symArg]) reads back what the page wrote
  const read = (pathname, addr) => {
    const u = new URL('https://shydrie.xyz' + addr), APP = pathname.replace(/[^/]*$/, '');
    const [, page, arg, symArg] = (u.hash && u.hash !== '#' ? u.hash : '#/' + u.pathname.slice(APP.length)).split('/');
    return [page, decodeURIComponent(arg), symOf(symArg)];
  };
  for (const stubs of [undefined, false]) for (const s of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const addr = at('/tinue/', '?board=ninja', stubs)('pd 9', s);
    assert.deepEqual(read('/tinue/', addr), ['puzzle', 'pd 9', s], addr);
  }
  // a stale or malformed symmetry in an address is ignored
  for (const h of ['#/puzzle/pd9/9', '#/puzzle/pd9/x', '#/puzzle/pd9/', '#/puzzle/pd9', '#/puzzle/pd9/07', '#/puzzle/pd9/-1', '#/puzzle/pd9/3.5']) assert.deepEqual(read('/tinue/', '/tinue/' + h), ['puzzle', 'pd9', 0], h);
  // the route compares the symmetry too (the same puzzle under another one is another visit), and the address it shows
  // for the puzzle on screen keeps it
  assert.match(app, /const \[, page, arg, symArg\] = /);
  // (want is sym, or for an older Rush row naming the puzzle on screen the symmetry worked out from it: test-pagesym.mjs)
  assert.match(app, /if \(S\?\.p\.id !== id \|\| symNow\(\) !== want\) loadById\(id, want, found \? null : look\); else \{ restoreLeft\(\); showPuzzleURL\(S\.p\.id, want\); \}/);
});

test('build-static --dry-run: NAME picks the directory and the site address; STUBS=none needs no database', () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-beta-'));
  let r = sh('build-static.sh', ['--dry-run'], { SITE: site, NAME: 'tinue-beta', STUBS: 'none', BETA: 'x@1', TINUE_DB: '/nonexistent.db' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`rm -rf ${site}/tinue-beta \\(all but \\.git\\);`));
  assert.match(r.stdout, /no puzzle pages \(STUBS=none\)/);
  assert.ok(!/build-stubs/.test(r.stdout));
  r = sh('build-static.sh', ['--dry-run'], { SITE: site, TINUE_DB: '/nonexistent.db', NAME: '', STUBS: '' });
  assert.equal(r.status, 1); // the real build still needs the database for its puzzle pages
  for (const bad of ['a/b', '.x']) assert.equal(sh('build-static.sh', ['--dry-run'], { SITE: site, NAME: bad, STUBS: 'none' }).status, 2, bad);
  assert.deepEqual(fs.readdirSync(site), []); // a dry run writes nothing
  fs.rmSync(site, { recursive: true });
});

test('a real beta build (when the engine binary is here): its own directory, marked, no puzzle pages, every module present', () => {
  if (!fs.existsSync(root + 'public/syntaks/syntaks.wasm')) { console.log('   (skipped: no public/syntaks/syntaks.wasm in this checkout)'); return; }
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-beta-'));
  const r = sh('build-beta.sh', [], { SITE: site, TINUE_DB: '/nonexistent.db', TINUE_MAIN: '/nonexistent', TINUE_ESBUILD: 'none' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(fs.readdirSync(site).filter((f) => !f.startsWith('.')), ['tinue-beta']);
  const out = path.join(site, 'tinue-beta');
  assert.ok(!fs.existsSync(path.join(out, 'puzzle')));
  const cfg = fs.readFileSync(path.join(out, 'config.js'), 'utf8');
  assert.match(cfg, /window\.TINUE_API = 'https:\/\/api\.tinue\.me';/);
  assert.match(cfg, /window\.TINUE_STUBS = false;/);
  assert.match(cfg, /window\.TINUE_BETA = '[A-Za-z0-9@._\/ -]+';/);
  assert.match(cfg, /^window\.TINUE_ANALYSIS = true;$/m, 'the beta has the analysis view');
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /src="app\.js\?v=\d+"/);
  assert.match(fs.readFileSync(path.join(out, 'version.json'), 'utf8'), /^\{"v":\d+,"sha":"[0-9a-f]{40}(-dirty)?"\}\n$/);
  for (const f of ['app.js', 'board-kit.js', 'ninja.js', 'board.js', 'style.css', 'shared/themes.js', 'syntaks/syntaks.wasm', 'tiltak/tiltak_wasm_bg.wasm', 'manifest.webmanifest']) assert.ok(fs.existsSync(path.join(out, f)), f);
  // every local import in every module (but vendor/) carries this build's ?v, so no module loads twice under two addresses
  const v = JSON.parse(fs.readFileSync(path.join(out, 'version.json'), 'utf8')).v;
  let stamped = 0;
  for (const f of fs.readdirSync(out, { recursive: true }).filter((f) => f.endsWith('.js') && !f.startsWith('vendor'))) {
    for (const [, spec] of fs.readFileSync(path.join(out, f), 'utf8').matchAll(/(?:from |import\()'(\.\.?\/[^']+\.js[^']*)'/g)) { assert.ok(spec.endsWith('?v=' + v), `${f}: ${spec}`); stamped++; }
  }
  assert.ok(stamped > 30, String(stamped));
  // every module app.js imports is listed in the page, at the very address it is imported by (another would load twice)
  const listed = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  assert.ok(listed.length > 25 && new Set(listed).size === listed.length, String(listed.length));
  for (const l of listed) assert.ok(l.endsWith('?v=' + v) && fs.existsSync(path.join(out, l.split('?')[0])), l);
  for (const [, f] of app.matchAll(/^import .* from '\.\/([^']+)';/gm)) assert.ok(listed.includes(f + '?v=' + v), f);
  assert.ok(!listed.some((l) => /^(app|rush|sound-lab)\.js/.test(l)), 'not the page itself, nor what loads on demand');
  fs.rmSync(site, { recursive: true });
});

test('the real build is unchanged by default: tinue/, puzzle pages, no beta marks', () => {
  const s = fs.readFileSync(root + 'scripts/build-static.sh', 'utf8');
  assert.match(s, /^NAME="\$\{NAME:-tinue\}"$/m);
  assert.match(s, /^\[ "\$STUBS" = none \] \|\| node --no-warnings scripts\/build-stubs\.mjs "\$OUT" "\$SITE_URL" "\$API"$/m);
  assert.match(s, /^\[ "\$STUBS" = none \] && printf "window\.TINUE_STUBS = false;\\n" >> "\$OUT\/config\.js"$/m);
  assert.match(s, /^if \[ -n "\$BETA" \]; then$/m);
});

test('a plain link to the puzzle on screen keeps the visit (and its symmetry); only an explicit symmetry or a Rush note restarts it', () => {
  const i = app.indexOf("if (!sym && !zero && !found && S?.p.id === id) want = symNow();"), j = app.indexOf("if (S?.p.id !== id || symNow() !== want) loadById(");
  assert.ok(i > 0 && j > i, 'the keep-the-visit line comes before the restart test');
  // the decision itself, as the two lines make it
  const decide = (onScreen, cur, id, sym, found, noteSym) => { let want = found ? noteSym : sym; if (!sym && !found && onScreen === id) want = cur; return onScreen !== id || cur !== want ? 'load:' + want : 'keep:' + want; };
  assert.equal(decide('pd1', 3, 'pd1', 0, false), 'keep:3'); // plain link, turned visit: kept
  assert.equal(decide('pd1', 0, 'pd1', 0, false), 'keep:0');
  assert.equal(decide('pd1', 3, 'pd1', 5, false), 'load:5'); // an explicit other symmetry is another visit
  assert.equal(decide('pd1', 3, 'pd1', 3, false), 'keep:3');
  assert.equal(decide('pd1', 0, 'pd1', 0, true, 2), 'load:2'); // an older Rush row that saw it turned
  assert.equal(decide('pd1', 3, 'pd2', 0, false), 'load:0'); // another puzzle never inherits it
});

console.log(`all ${n} passed`);
