// The move to tinue.me without a browser (the browser's part: e2e-handoff.mjs): builds without DOMAIN have none of it,
// a DOMAIN build is complete, build-moved.sh changes two files only, publish-site.sh's two new ways, the 404 page and the
// route grammar.   node --no-warnings scripts/test-handoff.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-handoff-'));
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', DRY_RUN: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
for (const k of ['DOMAIN', 'SITE', 'SITE_URL', 'OLD_URL', 'NEW_URL', 'PAGES', 'BETA', 'STUBS', 'NAME', 'ANALYSIS']) delete env[k];
const run = (cmd, args, extra = {}, cwd = ROOT) => { const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const ok = (r) => { assert.equal(r.code, 0, r.out); return r.out; };
const git = (cwd, ...a) => ok(run('git', a, {}, cwd)).trim();
const sh = (s, args, extra) => run('sh', ['scripts/' + s, ...args], extra);

// ---------- the 404 page and the two pages' rules ----------
{
  const js = read('moved/404.html').match(/<script>([\s\S]*)<\/script>/)[1];
  const at = (pathname, hash = '') => { let to; vm.runInNewContext(js, { location: { pathname, hash, replace: (u) => { to = u; } } }); return to; };
  for (const [p, h, want] of [['/puzzle/pd123', '', '/#/puzzle/pd123'], ['/puzzle/pd1.html', '', '/#/puzzle/pd1'], ['/tinue/puzzle/pd1', '', '/#/puzzle/pd1'], ['/tinue/', '#/rush', '/#/rush'], ['/tinue', '', '/#/'],
    ['/tinue/', '#/puzzle/pd1/3', '/#/puzzle/pd1/3'], ['/me', '', '/#/'], ['/tinuex/puzzle/a', '', '/#/'], ['/puzzle/a%2Fb', '', '/#/'], ['/puzzle/a/b', '', '/#/'], ['//evil.com/puzzle/x', '', '/#/'], ['/x', '#hd=abc', '/#/'], ['/x', '#//evil', '/#/']]) assert.equal(at(p, h), want, p + h);
  const imp = read('moved/import.js'), hand = read('moved/handoff.html');
  const grammar = (s) => s.match(/ROUTE = (\/.*\/);/)[1];
  assert.equal(grammar(imp), grammar(hand));
  const R = vm.runInNewContext(grammar(imp));
  for (const r of ['#/', '#/me', '#/puzzle/pd1', '#/puzzle/pd1/7', '#/rush', '#/settings', '#/leaderboard']) assert.ok(R.test(r), r);
  for (const r of ['', '#', '#//x', '#/puzzle/', '#/puzzle/a b', '#/puzzle/pd1/8', '#/me&x', '#/me\n', '#hd=1', 'https://x', '#/javascript:alert(1)']) assert.ok(!R.test(r), r);
  // every navigation is a replace to the one address built in; nothing from the address reaches markup
  assert.deepEqual([...hand.matchAll(/location\.(\w+)\(([^)]{0,12})/g)].map((m) => m[1] + ' ' + m[2]), ['replace NEW + frag', "replace '__NEW__'"]);
  assert.deepEqual([...imp.matchAll(/location\.(?:replace|assign|href *=)\(([^;)]{0,12})/g)].map((m) => m[1]), ["OLD + '#hn='"]);
  for (const s of [imp, hand]) assert.doesNotMatch(s, /innerHTML|outerHTML|insertAdjacent|document\.write|eval\(|new Function/);
  assert.match(hand, /<meta name="referrer" content="no-referrer">/); assert.doesNotMatch(read('public/index.html'), /name="referrer"/); // (there it would turn the beacon's Origin into "null")
  assert.doesNotMatch(hand, /(?:src|href)="(?:https?:)?\/\//);
  assert.equal(imp.indexOf('history.replaceState') < imp.indexOf("SS.getItem('tinue.hs')); SS.removeItem"), true);
  // the hash of a token is the page's own
  const body = imp.match(/var ownerOf = (function[^;]*;[\s\S]*?toString\(36\); \});?/)[1], { ownerOf } = await import('../public/outbox.js');
  const f = vm.runInNewContext('(' + body + ')', { Math }); for (const t of ['', 'ab'.repeat(24), '0123456789abcdef'.repeat(3)]) assert.equal(f(t), ownerOf(t));
  const h = vm.runInNewContext('(' + hand.match(/const ownerOf = (.*);/)[1] + ')'); assert.equal(h('ab'.repeat(24)), ownerOf('ab'.repeat(24)));
  console.log('handoff: addresses, routes, 404 page ok');
}

// ---------- builds ----------
const DB = path.join(T, 'p.db');
{ const db = new DatabaseSync(DB); db.exec('CREATE TABLE puzzles (id TEXT, size INT, tps TEXT, plies INT, themes TEXT, source TEXT, komi INT, meta TEXT)');
  for (const p of JSON.parse(read('scripts/rush-sym-sample.json')).slice(0, 3)) db.prepare('INSERT INTO puzzles VALUES (?,6,?,?,?,?,?,?)').run(p.id, p.tps, p.plies, '', 'playtak', p.komi || 0, '{}'); db.close(); }
for (const bad of ['a/b', 'a b', '-x', 'A.me']) assert.equal(sh('build-static.sh', ['--dry-run'], { SITE: T, DOMAIN: bad, TINUE_DB: DB }).code, 2, bad);
assert.equal(sh('build-static.sh', ['--dry-run'], { SITE: T, DOMAIN: 'tinue.me', STUBS: 'none' }).code, 2); assert.equal(sh('build-beta.sh', ['--dry-run'], { SITE: T, DOMAIN: 'tinue.me' }).code, 2);
assert.match(ok(sh('build-static.sh', ['--dry-run'], { SITE: T, DOMAIN: 'tinue.me', TINUE_DB: DB })), /API https:\/\/api\.tinue\.me,[\s\S]*build-stubs.mjs .* https:\/\/tinue\.me\/ https:\/\/api\.tinue\.me/);
const dry = ok(sh('build-static.sh', ['--dry-run'], { SITE: T, TINUE_DB: DB })); assert.match(dry, /API https:\/\/tinue-api\.shydrie\.xyz,/); assert.doesNotMatch(dry, /CNAME|tinue\.me/);
if (!fs.existsSync(path.join(ROOT, 'public/syntaks/syntaks.wasm'))) { console.log('handoff: builds skipped (no public/syntaks/syntaks.wasm in this checkout)'); process.exit(0); }
const A = path.join(T, 'a'), B = path.join(T, 'b'), files = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => !f.startsWith('.git') && fs.statSync(path.join(d, f)).isFile()).sort();
ok(sh('build-static.sh', [], { SITE: A, TINUE_DB: DB })); ok(sh('build-static.sh', [], { SITE: B, TINUE_DB: DB, DOMAIN: 'tinue.me' }));
const a = (f) => fs.readFileSync(path.join(A, 'tinue', f), 'utf8'), b = (f) => fs.readFileSync(path.join(B, 'tinue', f), 'utf8');
assert.deepEqual(files(path.join(B, 'tinue')).filter((f) => !files(path.join(A, 'tinue')).includes(f)), ['.nojekyll', '404.html', 'CNAME']);
assert.doesNotMatch(a('index.html') + a('config.js'), /tinue\.me|TINUE_OLD|hd=/); assert.match(a('index.html'), /og:url" content="https:\/\/shydrie\.xyz\/tinue\/"/);
assert.equal(b('CNAME'), 'tinue.me\n'); assert.match(b('config.js'), /window\.TINUE_API = 'https:\/\/api\.tinue\.me';[\s\S]*window\.TINUE_OLD = 'https:\/\/shydrie\.xyz\/tinue\/';/);
const html = b('index.html'); assert.match(html, /<head>\n<meta charset="utf-8">\n<script>\n\/\/ Inlined first/); assert.ok(!html.includes('__OLD__'));
assert.equal(html.replace(/<script>\n\/\/ Inlined first[\s\S]*?<\/script>\n/, '').includes('shydrie.xyz'), false); assert.match(html, /og:image" content="https:\/\/tinue\.me\/og\.png"/); assert.match(html, /https:\/\/tinue\.me\/syntaks\/NOTICE\.txt/); assert.match(html, /preconnect" href="https:\/\/api\.tinue\.me"/);
const stub = fs.readdirSync(path.join(B, 'tinue/puzzle'))[0]; assert.match(b('puzzle/' + stub), /https:\/\/tinue\.me\/puzzle\//); assert.match(b('puzzle/' + stub), /https:\/\/api\.tinue\.me\/p\//);
for (const f of files(path.join(A, 'tinue')).filter((f) => f.endsWith('.js') && f !== 'config.js')) assert.equal(a(f).replace(/\?v=\d+/g, ''), b(f).replace(/\?v=\d+/g, ''), f + ': the code is the same in both builds');
console.log('handoff: builds ok');

// ---------- publishing: site (PAGES), then the handoff page (moved) and its pointer ----------
const TIN = path.join(T, 'tinue.git'), BLOG = path.join(T, 'blog.git'), S = path.join(T, 'site');
git(T, 'init', '-q', '--bare', '-b', 'main', TIN); git(T, 'init', '-q', '--bare', '-b', 'main', BLOG); git(TIN, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
git(path.join(A, 'tinue'), 'init', '-q', '-b', 'site'); git(path.join(A, 'tinue'), 'add', '-A'); git(path.join(A, 'tinue'), 'commit', '-qm', 'R1'); git(path.join(A, 'tinue'), 'push', '-q', TIN, 'site');
git(T, 'init', '-q', '-b', 'main', S); fs.writeFileSync(path.join(S, 'index.html'), 'home'); git(S, 'add', '.'); git(S, 'commit', '-qm', 'init'); git(S, 'remote', 'add', 'origin', BLOG);
git(S, 'submodule', '--quiet', 'add', '-b', 'site', 'file://' + TIN, 'tinue'); git(S, 'commit', '-qm', 'sub'); git(S, 'push', '-q', 'origin', 'main');
const ptr = () => git(BLOG, 'rev-parse', 'main:tinue'), r1 = ptr();
const G = path.join(T, 'pages'); git(T, 'clone', '-q', '-b', 'site', 'file://' + TIN, G);
const pub = (args, extra) => sh('publish-site.sh', args, extra);
assert.equal(pub(['tinue', 'x'], { PAGES: G }).code, 1, 'a build without CNAME is not for its own domain'); assert.equal(pub(['tinue', 'x'], { PAGES: path.join(S, 'tinue') }).code, 2, 'a submodule is not a checkout of its own');
for (const f of fs.readdirSync(G)) if (f !== '.git') fs.rmSync(path.join(G, f), { recursive: true }); fs.cpSync(path.join(B, 'tinue'), G, { recursive: true });
assert.match(ok(pub(['--dry-run', 'tinue', 'R2'], { PAGES: G })), /\[dry-run\] git -C .* push origin HEAD:site/); assert.equal(git(TIN, 'rev-parse', 'site'), r1);
ok(pub(['tinue', 'R2'], { PAGES: G })); assert.equal(git(TIN, 'show', 'site:CNAME'), 'tinue.me'); assert.equal(git(TIN, 'ls-tree', '--name-only', 'site', '.nojekyll'), '.nojekyll'); assert.equal(ptr(), r1, 'the pointer stays');
// the handoff page
const D = path.join(S, 'tinue'), moved = (args = [], extra = {}) => sh('build-moved.sh', args, { SITE: S, ...extra });
fs.writeFileSync(path.join(D, 'junk'), 'x'); assert.equal(moved().code, 1); fs.rmSync(path.join(D, 'junk'));
assert.equal(pub(['tinue-moved', 'x'], { SITE: S }).code, 1, 'not the handoff page'); assert.match(ok(moved(['--dry-run'])), /index\.html/); assert.equal(git(D, 'status', '--porcelain'), '');
ok(moved()); assert.deepEqual(git(D, 'diff', '--name-only').split('\n'), ['index.html', 'version.json']);
const hand = fs.readFileSync(path.join(D, 'index.html'), 'utf8'), v1 = JSON.parse(a('version.json')).v; assert.ok(!/__[A-Z]+__/.test(hand)); assert.match(hand, /const NEW = 'https:\/\/tinue\.me\/', V = '\d+'/); assert.ok(hand.includes(`config.js?v=${v1}`));
assert.ok(JSON.parse(fs.readFileSync(path.join(D, 'version.json'), 'utf8')).v > v1); assert.equal(moved().code, 1, 'once');
ok(pub(['tinue-moved', 'moved'], { SITE: S })); assert.notEqual(ptr(), r1); assert.equal(ptr(), git(TIN, 'rev-parse', 'moved')); assert.equal(git(TIN, 'show', 'site:CNAME'), 'tinue.me', 'site is untouched');
// (the first one starts at the tip of `site`, so it must take R2's files away again)
assert.deepEqual(git(TIN, 'ls-tree', '-r', '--name-only', 'moved'), git(TIN, 'ls-tree', '-r', '--name-only', r1));
assert.equal(git(TIN, 'rev-parse', 'moved:puzzle'), git(TIN, 'rev-parse', r1 + ':puzzle'), 'every puzzle page byte for byte');
const p1 = ptr(); let r = pub(['tinue', 'oops'], { SITE: S }); assert.equal(r.code, 1); assert.match(r.out, /would undo the move/); assert.equal(ptr(), p1);
git(S, 'revert', '--no-edit', 'HEAD'); git(S, 'submodule', 'update', '-q', 'tinue'); assert.equal(git(D, 'rev-parse', 'HEAD'), r1); assert.doesNotMatch(fs.readFileSync(path.join(D, 'index.html'), 'utf8'), /tinue-handoff/);
fs.copyFileSync(path.join(B, 'tinue/CNAME'), path.join(D, 'CNAME')); assert.equal(pub(['tinue', 'oops'], { SITE: S }).code, 1, 'a tinue.me build never goes to shydrie.xyz');
console.log('handoff: publishing ok');
