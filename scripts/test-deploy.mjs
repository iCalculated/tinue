// Deploy scripts against a fake crux: shims for ssh, rsync, scp, launchctl, curl, dig, tailscale, sleep, sqlite3 and
// node on PATH, and a temp directory standing in for crux's home. Nothing here reaches the network or a real database.
// Asserts the order that matters: snapshot before any database write, no puzzle import in a code deploy, health check
// before the public check, a non-zero exit when the public check (Cloudflare host) fails, and that --dry-run runs no
// remote command at all.   node --no-warnings scripts/test-deploy.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { exportRow, fingerprint } from './puzzle-rows.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-deploy-test-'));
const SH = path.join(T, 'shims'), CRUX = path.join(T, 'crux'), LOG = path.join(T, 'log'), STATE = path.join(T, 'state');
const LOCAL_DB = path.join(T, 'local.db'), CRUX_DB = path.join(CRUX, 'Projects/tinue/data/tinue.db'), SITE = path.join(T, 'site');
for (const d of [SH, CRUX, STATE, path.join(CRUX, 'Library/LaunchAgents'), path.join(CRUX, 'Library/Logs'), path.dirname(CRUX_DB), path.join(T, 'empty')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(LOG, '');

const shim = (name, body) => fs.writeFileSync(path.join(SH, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
// ssh: drop options, log, run the command in the fake crux home with a clean environment (as a real ssh would).
shim('ssh', `while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
host=$1; shift
printf 'ssh %s %s\\n' "$host" "$(printf '%s' "$*" | tr '\\n' ' ' | cut -c1-400)" >> "$FAKE_LOG"
cd "$FAKE_CRUX" && exec env -i HOME="$FAKE_CRUX" PATH="$FAKE_SHIMS:/usr/bin:/bin" FAKE_LOG="$FAKE_LOG" FAKE_CRUX="$FAKE_CRUX" FAKE_HEALTH="$FAKE_HEALTH" /bin/sh -c "$*"`);
// rsync: host:path becomes a path under the fake crux home; -e and --timeout are dropped.
shim('rsync', `n=$#; skip=
for a in "$@"; do
  if [ -n "$skip" ]; then skip=; continue; fi
  case "$a" in -e) skip=1 ;; --timeout=*) ;; *:*) set -- "$@" "$FAKE_CRUX/\${a#*:}" ;; *) set -- "$@" "$a" ;; esac
done
shift $n
echo "rsync $*" >> "$FAKE_LOG"
exec /usr/bin/rsync "$@"`);
shim('scp', 'echo "scp $*" >> "$FAKE_LOG"; exit 1');
shim('launchctl', `echo "launchctl $*" >> "$FAKE_LOG"
case "$1" in print) [ -f "$FAKE_CRUX/.loaded" ] ;; bootstrap) touch "$FAKE_CRUX/.loaded" ;; bootout) [ -f "$FAKE_CRUX/.loaded" ] || exit 3; rm -f "$FAKE_CRUX/.loaded" ;; esac`);
shim('curl', `case "$*" in
  *localhost:8642*) echo "curl health" >> "$FAKE_LOG"; [ "\${FAKE_HEALTH:-ok}" = ok ] || exit 7; echo '{"n":1}' ;;
  *--resolve*) echo "curl funnel" >> "$FAKE_LOG"; echo "\${FAKE_FUNNEL:-200} 0.100" ;;
  *) echo "curl public" >> "$FAKE_LOG"; echo "\${FAKE_PUBLIC:-200} 0.100" ;;
esac`);
shim('dig', 'echo "dig $*" >> "$FAKE_LOG"; echo 100.64.0.1');
shim('tailscale', 'echo "tailscale $*" >> "$FAKE_LOG"; case "$*" in *status*) echo \'"AllowFunnel": {"crux:8443": true}\' ;; esac');
shim('sleep', 'exit 0');
shim('sqlite3', 'echo "sqlite3 $*" >> "$FAKE_LOG"; exec /usr/bin/sqlite3 "$@"');
shim('rnode', `echo "node $*" >> "$FAKE_LOG"; exec '${process.execPath}' "$@"`);
shim('build-static', 'echo "build-static" >> "$FAKE_LOG"; mkdir -p "$SITE/tinue"; date +%s%N > "$SITE/tinue/version.json"; echo page > "$SITE/tinue/index.html"');
const log = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
const clearLog = () => fs.writeFileSync(LOG, '');
const at = (lines, re) => lines.findIndex((l) => re.test(l));

const ENV = { ...process.env, PATH: SH + ':' + process.env.PATH, FAKE_LOG: LOG, FAKE_CRUX: CRUX, FAKE_SHIMS: SH, CRUX: 'shy@crux',
  CRUX_NODE: path.join(SH, 'rnode'), CRUX_SQLITE: path.join(SH, 'sqlite3'), TINUE_DEPLOY_DIR: STATE, TINUE_DB: LOCAL_DB, SITE, DRY_RUN: '' };
function sh(script, args = [], extra = {}) {
  const r = spawnSync('sh', [path.join(ROOT, 'scripts', script), ...args], { env: { ...ENV, ...extra }, encoding: 'utf8', timeout: 120e3 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const ok = (r, what) => assert.equal(r.code, 0, `${what} failed:\n${r.out}`);

// Puzzles: crux has v1 (p1 played), local has v2 = two changed (p1, p3), one new, one Ditaktic (local-only).
const puzzle = (i, extra = {}) => ({ id: 'p' + i, size: 5, tps: `x5/x5/x5/x5/${i},x4 1 ${i}`, komi: 0, plies: 1, tree: { a1: 'win' }, tags: ['s5', 'roadIn1'],
  rating: 1000 + i, source: 'PlayTak', sourceRef: null, meta: { gameId: i }, turn: 1, swing: { pre0: 0.1, alt: null }, grade: null, ...extra });
function load(db, rows) {
  const dir = fs.mkdtempSync(path.join(T, 'rows-'));
  fs.writeFileSync(path.join(dir, 'p.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/import.mjs'), dir],
    { cwd: path.join(T, 'empty'), env: { ...process.env, TINUE_DB: db, TINUE_ACCESS_LOG: path.join(T, 'access.log') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
const v1 = Array.from({ length: 10 }, (_, i) => puzzle(i + 1));
load(CRUX_DB, v1);
{ const d = new DatabaseSync(CRUX_DB); d.exec("UPDATE puzzles SET attempts = 3, rating = 1234 WHERE id = 'p1'"); d.close(); }
load(LOCAL_DB, [...v1.map((p) => (p.id === 'p3' ? { ...p, tree: { a1: 'win', b1: 'win' } } : p.id === 'p1' ? { ...p, tags: ['s5', 'roadIn1', 'tak', 'quiet'] } : p)), puzzle(11), puzzle(12, { id: 'dk1', source: 'Ditaktic' })]);
const q = (sql) => { const d = new DatabaseSync(CRUX_DB, { readOnly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
const puzzlesOnCrux = () => JSON.stringify(q('SELECT * FROM puzzles ORDER BY id'));

// 1. code deploy: ships code, restarts, waits for health; never touches a puzzle row
{
  const before = puzzlesOnCrux(), r = sh('deploy-crux.sh');
  ok(r, 'deploy-crux.sh');
  const L = log();
  assert.equal(puzzlesOnCrux(), before, 'a code deploy rewrote puzzle rows');
  assert.ok(!L.some((l) => /import\.mjs|puzzles\.jsonl/.test(l)), 'a code deploy ran an import or shipped puzzles:\n' + L.join('\n'));
  assert.ok(at(L, /^rsync .*server/) >= 0 && at(L, /^launchctl bootstrap/) > at(L, /^rsync .*server/), 'code shipped, then bootstrap');
  assert.ok(at(L, /^curl health/) > at(L, /^launchctl bootstrap/), 'health checked after the restart');
  assert.ok(L.some((l) => /^tailscale funnel --bg --https=8443 8642$/.test(l)) && !L.some((l) => /https=443\b/.test(l)), 'Funnel on 8443 only');
  const rev = JSON.parse(fs.readFileSync(path.join(CRUX, 'Projects/tinue/deploy/revision.json'), 'utf8'));
  assert.equal(rev.sha, spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(), 'revision.json names the commit');
  assert.ok(fs.existsSync(path.join(CRUX, 'Projects/tinue/server/server.js')) && !fs.existsSync(path.join(CRUX, 'Projects/tinue/dev')), 'code shipped, dev/ not');
  // the plist: valid, and its switches are the server's own defaults
  const PL = path.join(CRUX, 'Library/LaunchAgents/com.shy.tinue.plist');
  if (fs.existsSync('/usr/bin/plutil')) {
    const j = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', PL], { encoding: 'utf8' });
    assert.equal(j.status, 0, j.stdout + j.stderr);
    const { TINUE_MIN_BUILD, ...env } = JSON.parse(j.stdout).EnvironmentVariables;
    assert.match(TINUE_MIN_BUILD, /^\d{10}$/);
    assert.deepEqual(env, { PORT: '8642', HOST: '127.0.0.1', TINUE_ORIGINS: 'https://shydrie.xyz', TINUE_SECURE: '1', TINUE_BOOK_VER: '0', TINUE_JUDGE: 'off' });
  }
  // second deploy: plist unchanged, restart in place
  clearLog(); ok(sh('deploy-crux.sh'), 'second deploy-crux.sh');
  assert.ok(at(log(), /^launchctl kickstart -k gui\/\d+\/com\.shy\.tinue$/) >= 0 && at(log(), /^launchctl bootstrap/) < 0, 'restart in place');
  // health failure is a hard failure
  clearLog(); const bad = sh('deploy-crux.sh', [], { FAKE_HEALTH: 'down' });
  assert.notEqual(bad.code, 0, 'deploy must fail when node does not answer'); assert.match(bad.out, /health: FAILED/);
  console.log('code deploy: ok (no puzzle row touched, health after restart, revision recorded, health failure fails)');
}

// 2. publish: snapshot, then only the new and changed rows in one import, counts before and after, restart, health
{
  clearLog();
  const r = sh('publish-puzzles.sh'); ok(r, 'publish-puzzles.sh');
  const L = log();
  const snap = at(L, /^sqlite3 data\/tinue\.db \.backup/), imp = at(L, /^node .*import\.mjs rows$/);
  assert.ok(snap >= 0 && imp > snap, 'snapshot before the import:\n' + L.join('\n'));
  assert.ok(!L.slice(0, snap).some((l) => /import\.mjs|^sqlite3 /.test(l)), 'no database write before the snapshot');
  assert.ok(at(L, /^launchctl kickstart -k .*com\.shy\.tinue$/) > imp && at(L, /^curl health/) > imp, 'restart and health after the import');
  assert.match(r.out, /new 1, changed 2, unchanged 8/); assert.match(r.out, /rows before: 10\b/); assert.match(r.out, /rows after: 11 \(1 new\)/);
  assert.match(r.out, /verify: 3 of 3 shipped rows now match/);
  const snaps = fs.readdirSync(path.join(CRUX, 'Projects/tinue/data/snapshots'));
  assert.equal(snaps.length, 1, snaps.join(' '));
  const s = new DatabaseSync(path.join(CRUX, 'Projects/tinue/data/snapshots', snaps[0]), { readOnly: true });
  assert.equal(s.prepare('SELECT COUNT(*) n FROM puzzles').get().n, 10, 'the snapshot holds the database before the publish'); s.close();
  assert.deepEqual({ ...q("SELECT rating, attempts FROM puzzles WHERE id = 'p1'")[0] }, { rating: 1234, attempts: 3 }, 'a played puzzle keeps its rating');
  assert.equal(q("SELECT themes FROM puzzles WHERE id = 'p1'")[0].themes, 's5,roadIn1,quiet', 'changed played row published');
  assert.equal(JSON.parse(q("SELECT tree FROM puzzles WHERE id = 'p3'")[0].tree).b1, 'win', 'changed row published');
  assert.equal(q("SELECT COUNT(*) n FROM puzzles WHERE id = 'dk1'")[0].n, 0, 'Ditaktic never ships');
  // again: nothing to do, nothing written, no snapshot
  clearLog(); const again = sh('publish-puzzles.sh'); ok(again, 'second publish');
  assert.match(again.out, /nothing to publish/); assert.ok(!log().some((l) => /\.backup|import\.mjs|kickstart/.test(l)), 'an empty publish writes nothing');
  // a hand fix on crux is held, not overwritten, unless asked
  { const d = new DatabaseSync(CRUX_DB); d.exec(`UPDATE puzzles SET meta = '{"gameId":5,"fixed":1}' WHERE id = 'p5'`); d.close(); }
  clearLog(); const held = sh('publish-puzzles.sh'); ok(held, 'publish with a crux-side edit');
  assert.match(held.out, /HELD 1 rows/); assert.match(held.out, /nothing to publish/);
  assert.equal(JSON.parse(q("SELECT meta FROM puzzles WHERE id = 'p5'")[0].meta).fixed, 1, 'crux-side edit kept');
  // edited on both sides since the last publish: still held (the local edit does not silently undo crux's)
  { const d = new DatabaseSync(LOCAL_DB); d.exec(`UPDATE puzzles SET meta = '{"gameId":5,"local":1}' WHERE id = 'p5'`); d.close(); }
  clearLog(); const both = sh('publish-puzzles.sh'); ok(both, 'publish with a row edited on both sides');
  assert.match(both.out, /HELD 1 rows/); assert.match(both.out, /1 also changed here/); assert.match(both.out, /nothing to publish/);
  assert.equal(JSON.parse(q("SELECT meta FROM puzzles WHERE id = 'p5'")[0].meta).fixed, 1, 'crux-side edit kept when both changed');
  clearLog(); const allHeld = sh('publish-puzzles.sh', ['--all']); ok(allHeld, 'publish --all with a held row');
  assert.match(allHeld.out, /HELD 1 rows/); assert.equal(JSON.parse(q("SELECT meta FROM puzzles WHERE id = 'p5'")[0].meta).fixed, 1, '--all does not overwrite a held row');
  clearLog(); ok(sh('publish-puzzles.sh', ['--overwrite-remote-edits']), 'publish --overwrite-remote-edits');
  assert.equal(JSON.parse(q("SELECT meta FROM puzzles WHERE id = 'p5'")[0].meta).local, 1, 'local edit shipped on request');
  { const d = new DatabaseSync(LOCAL_DB); d.exec(`UPDATE puzzles SET meta = '{"gameId":5}' WHERE id = 'p5'`); d.close(); }
  clearLog(); ok(sh('publish-puzzles.sh'), 'publish the reverted local row');
  assert.equal(JSON.parse(q("SELECT meta FROM puzzles WHERE id = 'p5'")[0].meta).fixed, undefined, 'overwritten on request');
  // a reader that fails on crux (wrong node path) stops the publish before anything is written
  shim('badnode', 'exit 1');
  clearLog(); const broken = sh('publish-puzzles.sh', [], { CRUX_NODE: path.join(SH, 'badnode') });
  assert.notEqual(broken.code, 0, 'a failed manifest must stop the publish'); assert.ok(!log().some((l) => /\.backup|import\.mjs/.test(l)));
  console.log('publish: ok (snapshot first, 3 of 11 rows shipped, counts printed, played rating kept, empty publish writes nothing, crux edit held)');
}

// 2b. the fingerprint covers every swing key an import stores: a row round-trips, and a change to any one key is seen
{
  const swing = { pre0: 0.1, pre2: 0.2, pre4: 0.3, lostBefore: 'no', alt: 0.4, alts: ['a2'], altsAt: { 'a1 b1': ['c1'] }, esc: 1 };
  const row = puzzle(1, { swing, grade: 'A' }), DB = path.join(T, 'swing.db');
  load(DB, [row]);
  const stored = () => { const d = new DatabaseSync(DB, { readOnly: true }); try { return exportRow(d.prepare('SELECT * FROM puzzles').get()); } finally { d.close(); } };
  assert.deepEqual(stored().swing, swing, 'every key is stored');
  assert.equal(fingerprint(stored()), fingerprint(row), 'a row fingerprints the same once imported');
  for (const k of Object.keys(swing)) assert.notEqual(fingerprint({ ...row, swing: { ...swing, [k]: 'other' } }), fingerprint(row), `a changed ${k} ships`);
  console.log(`swing: ok (${Object.keys(swing).length} keys stored and fingerprinted)`);
}

// 3. ship: API, client, public check last; the Cloudflare host failing fails it, a Funnel relay only warns
{
  for (const c of [['init', '-q', '--bare', '-b', 'main', path.join(T, 'origin.git')], ['init', '-q', '-b', 'main', SITE]]) spawnSync('git', c);
  const g = (...a) => spawnSync('git', ['-C', SITE, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  fs.writeFileSync(path.join(SITE, 'index.html'), 'home'); g('add', '.'); g('commit', '-qm', 'init'); g('remote', 'add', 'origin', path.join(T, 'origin.git')); g('push', '-q', 'origin', 'main');
  const shipEnv = { PUSH_SOURCE: 'true', BUILD_STATIC: path.join(SH, 'build-static'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  clearLog(); const r = sh('ship.sh', [], shipEnv); ok(r, 'ship.sh');
  const L = log(), health = at(L, /^curl health/), build = at(L, /^build-static/), pub = at(L, /^curl public/);
  assert.ok(health >= 0 && build > health && pub > build, 'API health, then client, then public check:\n' + L.join('\n'));
  assert.ok(at(L, /^launchctl/) < build, 'API restarted before the client build');
  assert.match(spawnSync('git', ['--git-dir', path.join(T, 'origin.git'), 'log', '--oneline', '-1'], { encoding: 'utf8' }).stdout, /tinue /, 'client pushed');
  // unrelated unpushed work in the site repo: refused before anything ships
  fs.writeFileSync(path.join(SITE, 'index.html'), 'home v2'); g('commit', '-qam', 'homepage draft');
  clearLog(); const dirty = sh('ship.sh', [], shipEnv);
  assert.notEqual(dirty.code, 0); assert.match(dirty.out, /1 unpushed commit/); assert.deepEqual(log(), [], 'nothing ran before the refusal');
  g('reset', '-q', '--hard', 'origin/main');
  clearLog(); const down = sh('ship.sh', [], { ...shipEnv, FAKE_PUBLIC: '530' });
  assert.notEqual(down.code, 0, 'ship must fail when the Cloudflare host fails'); assert.match(down.out, /FAILED the public check/);
  clearLog(); const relay = sh('ship.sh', [], { ...shipEnv, FAKE_FUNNEL: '502' });
  ok(relay, 'ship with a Funnel relay down'); assert.match(relay.out, /WARNING Funnel relay/);
  clearLog(); const sick = sh('ship.sh', [], { ...shipEnv, FAKE_HEALTH: 'down' });
  assert.notEqual(sick.code, 0); assert.ok(at(log(), /^build-static|^curl public/) < 0, 'nothing after a failed API health check');
  console.log('ship: ok (health before client before public check; Cloudflare failure exits non-zero, Funnel only warns)');
}

// 4. --dry-run: every script prints its remote and destructive commands and runs none of them
{
  const before = puzzlesOnCrux(), siteHead = spawnSync('git', ['-C', SITE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout;
  { const d = new DatabaseSync(LOCAL_DB); d.exec("UPDATE puzzles SET init_rating = 999 WHERE id = 'p2'"); d.close(); } // something to publish
  clearLog();
  for (const [s, args] of [['deploy-crux.sh', ['--dry-run']], ['publish-puzzles.sh', ['--dry-run']], ['check-public.sh', ['--dry-run']], ['build-static.sh', ['--dry-run']], ['ship.sh', ['--dry-run', '--puzzles']]]) {
    const r = sh(s, args); ok(r, s + ' --dry-run');
    if (s !== 'check-public.sh' && s !== 'build-static.sh') assert.match(r.out, /\[dry-run\] ssh /, s + ' prints its ssh');
    if (/deploy|publish|ship/.test(s)) assert.match(r.out, /\[dry-run\] rsync /, s + ' prints its rsync');
    if (s === 'publish-puzzles.sh') { assert.match(r.out, /shipping 1\b/); assert.match(r.out, /\.backup/); }
  }
  // the legacy path's dry run must not rewrite deploy/puzzles/ (publish-puzzles.sh's baseline of what crux last got)
  const exp = path.join(ROOT, 'deploy/puzzles/puzzles.jsonl'), stamp = fs.existsSync(exp) ? fs.statSync(exp).mtimeMs : null;
  const leg = sh('deploy-crux.sh', ['--legacy', '--dry-run']); ok(leg, 'deploy-crux.sh --legacy --dry-run');
  assert.ok(leg.out.search(/rsync [^\n]*\/revision\.json shy@crux:/) >= 0 && leg.out.search(/rsync [^\n]*\/revision\.json shy@crux:/) < leg.out.indexOf('launchctl'), 'the legacy path ships revision.json before its restart');
  assert.equal(fs.existsSync(exp) ? fs.statSync(exp).mtimeMs : null, stamp, 'a legacy dry run rewrote deploy/puzzles/');
  assert.deepEqual(log(), [], 'a dry run invoked a remote or network command');
  assert.equal(puzzlesOnCrux(), before); assert.equal(spawnSync('git', ['-C', SITE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout, siteHead);
  console.log('dry run: ok (no shim invoked, crux and site unchanged)');
}

// 5. stubs: skipping unchanged pages gives the same directory as writing them all
{
  const stubs = (out, ...a) => { const r = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/build-stubs.mjs'), out, 'https://x/tinue/', 'https://api', ...a], { env: { ...process.env, TINUE_DB: LOCAL_DB, DRY_RUN: '' }, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const A = path.join(T, 'stubsA'), B = path.join(T, 'stubsB');
  stubs(A, '--all');
  fs.mkdirSync(path.join(B, 'puzzle'), { recursive: true });
  fs.writeFileSync(path.join(B, 'puzzle', 'p1.html'), 'stale'); fs.writeFileSync(path.join(B, 'puzzle', 'gone.html'), 'removed puzzle');
  stubs(B); // fresh pages, one stale, one stray
  const second = stubs(B);
  const tree = (d) => Object.fromEntries(fs.readdirSync(path.join(d, 'puzzle')).sort().map((f) => [f, fs.readFileSync(path.join(d, 'puzzle', f), 'utf8')]));
  assert.deepEqual(tree(B), tree(A), 'skip-unchanged output differs from a full build');
  assert.match(second, /wrote 0 of 11 /, 'a rebuild with nothing changed writes nothing');
  console.log('stubs: ok (identical to --all; unchanged pages not rewritten)');
}

// 6. build-static copies every file the page links (stylesheets, home-screen icon, manifest) and the manifest's icons
{
  const cp = fs.readFileSync(path.join(ROOT, 'scripts/build-static.sh'), 'utf8').match(/^cp public\/index\.html .*"\$OUT\/"$/m);
  assert.ok(cp, "build-static.sh's cp line for public/ files not found");
  const copied = new Set(cp[0].split(' ').filter((w) => w.startsWith('public/')).map((w) => w.slice('public/'.length)));
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const links = [...html.matchAll(/<link [^>]*href="([^":#?]+)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('/'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));
  const need = [...links, ...manifest.icons.map((i) => i.src)];
  for (const f of ['apple-touch-icon.png', 'manifest.webmanifest', 'icon-maskable-512.png']) assert.ok(need.includes(f), f + ' not linked');
  // the page address becomes puzzle/<id> (replaceState), so the relative icon and manifest links must be pinned at load
  assert.match(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), /link\[rel="apple-touch-icon"\], link\[rel="manifest"\]'\)\) l\.href = l\.href;/, 'icon and manifest links are not pinned to absolute addresses');
  for (const f of need) { assert.ok(copied.has(f), `build-static.sh doesn't copy public/${f}`); assert.ok(fs.existsSync(path.join(ROOT, 'public', f)), `public/${f} missing`); }
  // and every module reachable from app.js (imports, import(), new URL: the workers), vendor/ copied whole
  const sh = fs.readFileSync(path.join(ROOT, 'scripts/build-static.sh'), 'utf8');
  for (const m of sh.matchAll(/^(?:mkdir -p "\$OUT\/\w+" && )?cp ((?:public|shared)\/.*?) "\$OUT\//gm)) for (const f of m[1].split(' ')) copied.add(f.replace('public/', ''));
  assert.ok(copied.has('vendor/*'));
  const seen = new Set();
  (function walk(f) {
    if (seen.has(f)) return; seen.add(f);
    if (!f.startsWith('vendor/') && f !== 'syntaks/syntaks.wasm') assert.ok(copied.has(f), `build-static.sh doesn't copy ${f}`); // (the engine goes by $W)
    if (!f.endsWith('.js')) return;
    const src = fs.readFileSync(path.join(ROOT, f.startsWith('shared/') ? '' : 'public', f), 'utf8');
    for (const m of src.matchAll(/(?:from|new URL\(|import\()\s*'\.\/([^'?]+)/g)) walk(path.posix.join(path.posix.dirname(f), m[1]));
  })('app.js');
  assert.ok(seen.size > 25, [...seen].join(' '));
  console.log(`static files: ok (${need.length} linked files and ${seen.size} modules copied)`);
}
fs.rmSync(T, { recursive: true, force: true });
console.log('deploy scripts: all ok');
