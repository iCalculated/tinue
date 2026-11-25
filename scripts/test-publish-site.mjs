// publish-site.sh, push-source.sh and hooks/pre-push against local bare repositories standing in for GitHub: the built
// branch is pushed before the pointer, only <name> is committed, rollback by revert, a wiped .git is refused, the plain
// directory layout still works, the private history never leaves.   node --no-warnings scripts/test-publish-site.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-publish-site-'));
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const env = { ...process.env, ...ID, DRY_RUN: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
const run = (cmd, args, cwd, extra = {}, input) => { const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', input }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const git = (cwd, ...a) => { const r = run('git', a, cwd); assert.equal(r.code, 0, `git ${a.join(' ')}: ${r.out}`); return r.out.trim(); };
const write = (d, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); } };
const page = (v) => ({ 'index.html': `page ${v}`, 'version.json': `{"v":${v}}`, 'puzzle/p1.html': 'p1' });

const TIN = path.join(T, 'tinue.git'), BLOG = path.join(T, 'blog.git'), SITE = path.join(T, 'site'), SEED = path.join(T, 'seed');
git(T, 'init', '-q', '--bare', '-b', 'main', TIN); git(T, 'init', '-q', '--bare', '-b', 'main', BLOG);
git(TIN, 'config', 'uploadpack.allowReachableSHA1InWant', 'true'); // as GitHub
git(T, 'init', '-q', '-b', 'site', SEED); write(SEED, page(1)); git(SEED, 'add', '.'); git(SEED, 'commit', '-qm', 'site'); git(SEED, 'push', '-q', TIN, 'site');
git(T, 'init', '-q', '-b', 'main', SITE); write(SITE, { 'index.html': 'home' }); git(SITE, 'add', '.'); git(SITE, 'commit', '-qm', 'init');
git(SITE, 'remote', 'add', 'origin', BLOG); git(SITE, 'push', '-q', 'origin', 'main');
const publish = (...a) => run('sh', [path.join(ROOT, 'scripts/publish-site.sh'), ...a], ROOT, { SITE });
const served = () => { // what Pages would check out: a depth-1 clone with depth-1 submodules
  const d = fs.mkdtempSync(path.join(T, 'served-'));
  git(d, 'clone', '-q', '--depth=1', 'file://' + BLOG, 'b'); git(path.join(d, 'b'), 'submodule', 'update', '-q', '--init', '--force', '--depth=1', '--recursive');
  return fs.readFileSync(path.join(d, 'b/tinue/index.html'), 'utf8');
};

// plain directory (the layout before the move)
write(SITE, Object.fromEntries(Object.entries(page(1)).map(([f, t]) => ['tinue/' + f, t])));
fs.writeFileSync(path.join(SITE, 'draft.html'), 'not mine');
let r = publish('tinue', 'plain'); assert.equal(r.code, 0, r.out);
assert.equal(git(BLOG, 'log', '-1', '--format=%s', 'main'), 'plain'); assert.equal(served(), 'page 1');
const plain = git(SITE, 'rev-parse', 'HEAD:tinue');

// the swap to a submodule with the same tree
git(SITE, 'rm', '-rq', 'tinue'); git(SITE, 'submodule', '--quiet', 'add', '-b', 'site', 'file://' + TIN, 'tinue'); git(SITE, 'commit', '-qm', 'swap'); git(SITE, 'push', '-q', 'origin', 'main');
const SUB = path.join(SITE, 'tinue');
assert.equal(git(SUB, 'rev-parse', 'HEAD^{tree}'), plain); assert.equal(served(), 'page 1');

// a publish: built branch, then pointer; nothing else of the site repo; dry run and --no-push push nothing
write(SUB, page(2));
const before = git(TIN, 'rev-parse', 'site') + git(BLOG, 'rev-parse', 'main');
r = publish('--dry-run'); assert.equal(r.code, 0, r.out); assert.match(r.out, /push origin HEAD:site/);
assert.equal(git(TIN, 'rev-parse', 'site') + git(BLOG, 'rev-parse', 'main'), before);
r = publish('tinue', 'tinue two'); assert.equal(r.code, 0, r.out);
assert.equal(served(), 'page 2'); assert.equal(git(TIN, 'log', '-1', '--format=%s', 'site'), 'tinue two');
assert.deepEqual(git(SITE, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['tinue']);
assert.equal(git(BLOG, 'rev-parse', 'main:tinue'), git(TIN, 'rev-parse', 'site'));
r = publish('tinue', 'again'); assert.equal(r.code, 0, r.out); assert.match(r.out, /the build is unchanged/); assert.match(r.out, /unchanged; nothing to commit in/);

// roll back by reverting the pointer; the next publish builds on the branch tip
git(SITE, 'revert', '--no-edit', 'HEAD'); git(SITE, 'push', '-q', 'origin', 'main'); git(SITE, 'submodule', 'update', '-q', 'tinue');
assert.equal(served(), 'page 1'); assert.equal(fs.readFileSync(path.join(SUB, 'index.html'), 'utf8'), 'page 1');
write(SUB, page(3)); r = publish('tinue', 'tinue three'); assert.equal(r.code, 0, r.out);
assert.equal(served(), 'page 3'); assert.equal(git(TIN, 'rev-list', '--count', 'site'), '3');

// the built branch can't be pushed: the pointer is not bumped
const hook = path.join(TIN, 'hooks/pre-receive'); fs.mkdirSync(path.dirname(hook), { recursive: true }); fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const blogHead = git(BLOG, 'rev-parse', 'main'), siteHead = git(SITE, 'rev-parse', 'HEAD');
write(SUB, page(4)); r = publish('tinue', 'four'); assert.notEqual(r.code, 0); assert.equal(git(BLOG, 'rev-parse', 'main'), blogHead); assert.equal(git(SITE, 'rev-parse', 'HEAD'), siteHead);
fs.rmSync(hook);
r = publish('tinue', 'four'); assert.equal(r.code, 0, r.out); assert.equal(served(), 'page 4'); // and a retry recovers

// an unfinished build, and a .git wiped by an older build-static.sh, are refused
fs.rmSync(path.join(SUB, 'version.json')); r = publish(); assert.notEqual(r.code, 0); assert.match(r.out, /not a finished build/);
write(SUB, page(5)); const gf = fs.readFileSync(path.join(SUB, '.git'), 'utf8'); fs.rmSync(path.join(SUB, '.git'));
r = publish(); assert.notEqual(r.code, 0); assert.match(r.out, /its \.git is gone/);
fs.writeFileSync(path.join(SUB, '.git'), gf); assert.equal(publish('tinue', 'five').code, 0);
assert.equal(publish('nyx').code, 2);
console.log('publish-site: ok (plain, swap, publish, revert, failed push, refusals)');

// push-source and the pre-push hook, in a throwaway copy
const SRC = path.join(T, 'src'); git(T, 'init', '-q', '-b', 'main', SRC);
for (const f of ['push-source.sh', 'hooks/pre-push']) { fs.mkdirSync(path.join(SRC, 'scripts/hooks'), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(SRC, 'scripts', f)); }
git(SRC, 'add', '.'); git(SRC, 'commit', '-qm', 'old root'); const OLD = git(SRC, 'rev-parse', 'HEAD');
git(SRC, 'branch', 'private');
git(SRC, 'checkout', '-q', '--orphan', 'fresh');
const hf = path.join(SRC, 'scripts/hooks/pre-push'); fs.writeFileSync(hf, fs.readFileSync(hf, 'utf8').replace(/^OLD=\w+$/m, 'OLD=' + OLD));
git(SRC, 'add', '.'); git(SRC, 'commit', '-qm', 'fresh'); git(SRC, 'branch', '-qM', 'fresh', 'main');
const ps = (...a) => run('sh', ['scripts/push-source.sh', ...a], SRC);
assert.match(ps().out, /no remote for iCalculated\/tinue/);
const PUB = path.join(T, 'iCalculated/tinue.git'); fs.mkdirSync(path.dirname(PUB)); git(T, 'init', '-q', '--bare', '-b', 'main', PUB);
git(SRC, 'remote', 'add', 'other', path.join(T, 'notiCalculated/tinue.git')); assert.match(ps().out, /no remote/);
git(SRC, 'remote', 'add', 'origin', PUB); fs.mkdirSync(path.join(SRC, '.git/hooks'), { recursive: true }); fs.copyFileSync(hf, path.join(SRC, '.git/hooks/pre-push')); fs.chmodSync(path.join(SRC, '.git/hooks/pre-push'), 0o755);
git(SRC, 'replace', '--graft', 'main', 'private'); assert.equal(git(SRC, 'rev-list', '--count', 'main'), '2'); // log sees both locally
r = ps(); assert.equal(r.code, 0, r.out); assert.equal(git(PUB, 'rev-list', '--count', 'main'), '1'); // GitHub gets one
git(SRC, 'checkout', '-q', '-b', 'feature', 'private'); assert.notEqual(run('git', ['push', '-q', 'origin', 'feature'], SRC).code, 0, 'the hook stops a private branch');
assert.match(ps().out, /not main; not pushed/);
git(SRC, 'checkout', '-q', 'main'); git(SRC, 'merge', '-q', '--no-edit', '-X', 'ours', 'private'); // contained already through the graft: nothing to merge
const leak = run('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-p', 'private', '-m', 'leaky'], SRC).out.trim(); git(SRC, 'reset', '-q', '--hard', leak);
r = ps(); assert.notEqual(r.code, 0); assert.match(r.out, /private history/); assert.equal(git(PUB, 'rev-list', '--count', 'main'), '1');
console.log('push-source: ok (right remote only, main only, the private history stays private)');

// the page's source link and the repository push-source pushes to are the same one
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), repo = fs.readFileSync(path.join(ROOT, 'scripts/push-source.sh'), 'utf8').match(/TINUE_REPO:-([\w./-]+)\}/)[1];
assert.equal(html.match(/<a href="https:\/\/github\.com\/([^"]+)">Source&nbsp;code<\/a>/)[1], repo);
fs.rmSync(T, { recursive: true, force: true });
console.log('publish-site: all ok');
