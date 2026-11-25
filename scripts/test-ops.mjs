// ops/: the move end to end between two stand-in hosts (real server, gate, databases; ssh, systemctl, launchctl, lsof
// shimmed): go, interrupted and resumed go, abort, rollback; backups; the database checks; the scripts' dry runs; and that
// nothing committed there names a machine, a person or a secret.   node scripts/test-ops.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { testServer } from './lib/boot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OPS = path.join(ROOT, 'ops');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-ops-')), LOG = path.join(T, 'log'), SH = path.join(T, 'shims');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what) => { for (let i = 0; i < 400; i++) { if (await f()) return; await wait(25); } throw new Error('never: ' + what); };
for (const g of ['SIGTERM', 'SIGINT']) process.on(g, () => process.exit(1));
process.on('exit', () => { for (const c of kids) try { process.kill(c, 'SIGKILL'); } catch {} for (const f of ['ovh.pid', 'crux.pid']) try { process.kill(+fs.readFileSync(path.join(T, f), 'utf8')); } catch {} fs.rmSync(T, { recursive: true, force: true }); });
const kids = new Set();

// 1. what is committed: no address but loopback, documentation and Cloudflare's published list; no home path, no key
{
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = [...walk(OPS), ...['deploy-ovh.sh', 'deploy-lib.sh', 'ship.sh', 'check-public.sh', 'publish-puzzles.sh'].map((f) => path.join(ROOT, 'scripts', f))];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8'), n = path.relative(ROOT, f);
    if (!n.endsWith('cloudflare-ranges.txt')) for (const m of s.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) assert.ok(['127.0.0.1', '1.1.1.1'].includes(m[0]), `${n}: ${m[0]}`);
    assert.doesNotMatch(s, /\/Users\/|\/home\/(?!mover\b)|BEGIN [A-Z ]*PRIVATE KEY|AAAA[A-Za-z0-9+/]{20}|\bBearer [A-Za-z0-9]/, n);
  }
  for (const f of files.filter((x) => x.endsWith('.sh'))) { const r = spawnSync('sh', ['-n', f], { encoding: 'utf8' }); assert.equal(r.status, 0, f + r.stderr); }
  assert.doesNotMatch(spawnSync('sh', [path.join(OPS, 'cloudflare-ranges.sh'), 'caddy'], { encoding: 'utf8' }).stdout, /\b0\.0\.0\.0|::\/0/);
  const unit = fs.readFileSync(path.join(OPS, 'systemd/tinue.service'), 'utf8');
  assert.match(unit, /^ConditionPathExists=\/etc\/tinue\/WRITER$/m); assert.doesNotMatch(unit, /^MemoryDenyWriteExecute/m);
  if (spawnSync('caddy', ['version']).status === 0) {
    const C = path.join(T, 'caddy'); fs.mkdirSync(path.join(C, 'sites'), { recursive: true });
    fs.copyFileSync(path.join(OPS, 'Caddyfile'), path.join(C, 'Caddyfile'));
    for (const f of fs.readdirSync(path.join(OPS, 'caddy'))) fs.copyFileSync(path.join(OPS, 'caddy', f), path.join(C, 'sites', f));
    fs.writeFileSync(path.join(C, 'cf-ranges.caddy'), spawnSync('sh', [path.join(OPS, 'cloudflare-ranges.sh'), 'caddy']).stdout);
    fs.writeFileSync(path.join(C, 'upstream.caddy'), '(upstream) {\n\timport proxy 127.0.0.1:8641\n}\n');
    const r = spawnSync('caddy', ['adapt', '--adapter', 'caddyfile', '--config', path.join(C, 'Caddyfile')], { encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: C, XDG_CONFIG_HOME: C } });
    assert.equal(r.status, 0, r.stderr);
    const srv = JSON.parse(r.stdout).apps.http.servers.srv0;
    assert.ok(Object.values(JSON.parse(r.stdout).apps.http.servers).some((s) => s.listen.includes(':80')), 'port 80 answers'); assert.deepEqual(srv.client_ip_headers, ['CF-Connecting-IP']); assert.ok(srv.trusted_proxies.ranges.length >= 20);
    assert.equal(r.stdout.match(/"dial":"127\.0\.0\.1:8641"/g).length, 2, 'both API names through the gate');
    assert.equal(r.stdout.match(/"X-Forwarded-For":\["\{http\.vars\.client_ip\}"\]/g).length, 4); assert.ok(!/try_duration|request_buffers/.test(r.stdout));
  } else console.log('  (no caddy here: its configuration was not checked)');
  // provisioning and the engine build change nothing under --dry-run
  fs.writeFileSync(path.join(T, 'k.pub'), 'ssh-ed25519 TESTKEY someone@somewhere\n');
  for (const [f, a] of [['provision.sh', ['--mover-key', path.join(T, 'k.pub')]], ['build-syntaks.sh', []], ['upstream.sh', ['gate']], ['site.sh', ['api.tinue.me']]]) {
    const r = spawnSync('sh', [path.join(OPS, f), ...a, '--dry-run'], { encoding: 'utf8', env: { ...process.env, DRY_RUN: '1' } });
    assert.equal(r.status, 0, f + ': ' + r.stderr); assert.match(r.stdout, /\[dry-run\]/, f);
  }
  console.log('files: ok (no addresses, paths or keys; shell and Caddy syntax; dry runs)');
}

// 2. the TEI smoke test against a fake engine: passes, and fails on a missing option or a silent engine
{
  const eng = (name, opts, mpv = true) => { const f = path.join(T, name); fs.writeFileSync(f, `#!${process.execPath}
let mpv = 1; require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  if (l === 'tei') { for (const o of ${JSON.stringify(opts)}) console.log('option name ' + o + ' type spin'); console.log('teiok'); }
  const m = /MultiPV value (\\d)/.exec(l); if (m) mpv = +m[1];
  if (l.startsWith('go')) { for (let i = 1; i <= (${mpv} ? mpv : 1); i++) console.log('info depth 3 multipv ' + i + ' score cp 5 wdl 400 200 400 nodes 10 pv a' + i); console.log('bestmove a1'); }
  if (l === 'quit') process.exit(0);
});`, { mode: 0o755 }); return f; };
  const all = ['Threads', 'Hash', 'MateScores', 'HumanWDL', 'HalfKomi', 'MultiPV'], run = (f) => spawnSync(process.execPath, [path.join(OPS, 'tei-smoke.mjs'), f], { encoding: 'utf8' });
  assert.equal(run(eng('good', all)).status, 0); assert.match(run(eng('old', all.slice(0, 5))).stderr, /no option MultiPV/); assert.match(run(eng('onepv', all, false)).stderr, /no third line/); assert.equal(run('/nonexistent').status, 1);
  console.log('engine smoke test: ok');
}

// 3. the move. Two "hosts" in one directory each; every port is this test's own.
const P0 = +process.env.TINUE_TEST_PORT || 20000 + Math.floor(Math.random() * 20000), GATE = P0 + 1, OVH = P0 + 2, CRUX = P0 + 3, REH = P0 + 4;
const H = { crux: path.join(T, 'crux'), ovh: path.join(T, 'ovh') };
const CD = path.join(H.crux, 'Projects/tinue/data'), OD = path.join(H.ovh, 'state'), GD = path.join(H.ovh, 'etc'), IN = path.join(H.ovh, 'in'), OUT = path.join(H.ovh, 'out'), RUN = path.join(H.ovh, 'run');
for (const d of [SH, CD, path.join(H.crux, 'Library/LaunchAgents'), path.join(H.crux, 'Projects/tinue/deploy'), OD, GD, IN, OUT, RUN, path.join(H.ovh, 'code/deploy')]) fs.mkdirSync(d, { recursive: true });
for (const d of ['server', 'shared', 'public']) { fs.cpSync(path.join(ROOT, d), path.join(H.ovh, 'code', d), { recursive: true }); fs.cpSync(path.join(ROOT, d), path.join(H.crux, 'Projects/tinue', d), { recursive: true }); }
for (const d of ['package.json', 'ops']) fs.cpSync(path.join(ROOT, d), path.join(H.ovh, 'code', d), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(H.crux, 'Projects/tinue/package.json'));
const REV = JSON.stringify({ sha: 'a'.repeat(40), short: 'aaaaaaa', dirty: false, diff: '', branch: 'main', at: 'x' }) + '\n';
fs.writeFileSync(path.join(H.ovh, 'code/deploy/revision.json'), REV); fs.writeFileSync(path.join(H.crux, 'Projects/tinue/deploy/revision.json'), REV);
fs.writeFileSync(path.join(H.crux, 'Library/LaunchAgents/com.shy.tinue.plist'), 'plist');
fs.writeFileSync(LOG, '');
const shim = (name, body) => fs.writeFileSync(path.join(SH, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
// a server as that host's service manager runs it, its pid in a file
const server = (who, root, port, db) => `(exec 3>&- 4>&- 5>&- 6>&-; cd '${root}' && exec env -i PATH="$PATH" PORT=${port} HOST=127.0.0.1 TINUE_DB='${db}' TINUE_ACCESS_LOG='${T}/${who}.access' TINUE_SYNTAKS=/nonexistent '${process.execPath}' --no-warnings server/server.js) > '${T}/${who}.log' 2>&1 < /dev/null & echo $! > '${T}/${who}.pid'`;
const down = (who) => `if [ -s '${T}/${who}.pid' ]; then P=$(cat '${T}/${who}.pid'); kill $P 2>/dev/null; while kill -0 $P 2>/dev/null; do sleep 0.05; done; rm -f '${T}/${who}.pid'; fi`;
shim('systemctl', `echo "systemctl $*" >> '${LOG}'
[ -e '${T}/fail-start' ] && [ "$*" = "start tinue.service" ] && exit 0
case "$*" in
  *is-active*tinue.service) [ -s '${T}/ovh.pid' ] && kill -0 $(cat '${T}/ovh.pid') 2>/dev/null ;;
  "start tinue.service") [ -e '${GD}/WRITER' ] || exit 0; [ -s '${T}/ovh.pid' ] && exit 0; ${server('ovh', path.join(H.ovh, 'code'), OVH, path.join(OD, 'tinue.db'))} ;;
  "stop "*tinue.service*) ${down('ovh')} ;;
esac; exit $?`);
shim('launchctl', `echo "launchctl $*" >> '${LOG}'
L=$(basename "\${2:-x}"); case "$1" in
  print) [ "$L" = com.shy.tinue ] && [ -s '${T}/crux.pid' ] && kill -0 $(cat '${T}/crux.pid') 2>/dev/null ;;
  bootout) [ -e '${T}/fail-bootout' ] && { kill -9 $PPID; exit 1; }; [ "$L" = com.shy.tinue ] && { ${down('crux')}; } ;;
  bootstrap) if [ -e '${T}/fail-bootstrap' ]; then rm '${T}/fail-bootstrap'; echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; fi; case "$3" in *com.shy.tinue.plist) ${server('crux', path.join(H.crux, 'Projects/tinue'), CRUX, path.join(CD, 'tinue.db'))} ;; esac ;;
esac`);
shim('lsof', `case "$*" in *LISTEN*) [ -s '${T}/crux.pid' ] && kill -0 $(cat '${T}/crux.pid') 2>/dev/null ;; *) [ -s '${T}/crux.pid' ] && kill -0 $(cat '${T}/crux.pid') 2>/dev/null ;; esac`);
shim('pgrep', '[ -e "$0.busy" ]'); // another writer, when the test says so
shim('rsync', `n=$#; skip=; for a in "$@"; do if [ -n "$skip" ]; then skip=; continue; fi
  case "$a" in -e) skip=1 ;; --timeout=*) ;; *:/var/lib/tinue-in/) set -- "$@" '${IN}/' ;; *:/var/lib/tinue-backup/*) set -- "$@" "${H.ovh}/backup/\${a##*/}" ;; *:/var/lib/tinue-out/*) [ -e '${T}/fail-fetch' ] && exit 12; set -- "$@" "${OUT}/\${a##*/}" ;; *) set -- "$@" "$a" ;; esac; done
shift $n; [ -e '${T}/fail-send' ] && exit 12; exec /usr/bin/rsync "$@"`);
const ovhEnv = `TINUE_STATE='${OD}' TINUE_IN='${IN}' TINUE_OUT='${OUT}' TINUE_CODE='${H.ovh}/code' NODE='${process.execPath}' PORT=${OVH} REHEARSE_PORT=${REH} TINUE_GUARD='${GD}' TINUE_LOCK='${H.ovh}/lock' NO_SETUID=1 HEALTH_S=6 GATE_MODE='${RUN}/mode' GATE_STATUS='${RUN}/status' TINUE_BACKUP='${H.ovh}/backup'`;
const cruxEnv = `HOME='${H.crux}' TINUE_HOME='${H.crux}/Projects/tinue' MOVE_HOME='${H.crux}/move' PORT=${CRUX}`;
// "ssh host command": the sudo and the installed paths become this directory's
shim('fakessh', `h=$1; shift; echo "ssh $h $*" >> '${LOG}'
case "$h" in
  u@ovh) C=$(printf '%s' "$*" | sed 's#sudo -n sh /srv/tinue/ops/move/ovh.sh#sh ${H.ovh}/code/ops/move/ovh.sh#; s#sudo -n sh /srv/tinue/ops/upstream.sh gate#true#'); cd '${H.ovh}' && env ${ovhEnv} sh -c "$C" ;;
  u@crux) case "$*" in *"crux.sh hop"*) [ -e '${T}/fail-hop' ] && { echo 'hop: does NOT answer'; exit 1; }; echo "hop: up"; exit 0 ;; esac
    C=$(printf '%s' "$*" | sed 's#Projects/tinue-move/ops/move/crux.sh#${H.ovh}/code/ops/move/crux.sh#'); cd '${H.crux}' && env ${cruxEnv} sh -c "$C" ;;
esac`);
const ENV = { ...process.env, PATH: SH + ':' + process.env.PATH, TINUE_HOST: 'u@ovh', MOVE_DEST: 'mover@ovh', CRUX: 'u@crux', MOVE_SSH: 'fakessh', CRUX_NODE: process.execPath, DRY_RUN: '', TMPDIR: T };
// (asynchronous: the gate's clients below live in this process)
const move = (args, env = {}) => new Promise((resolve) => {
  const c = spawn('sh', [path.join(H.ovh, 'code/ops/move/move.sh'), ...args], { env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d)); c.once('close', (code) => resolve({ code, out }));
});
const crux = (...a) => new Promise((resolve) => { const c = spawn(path.join(SH, 'fakessh'), ['u@crux', "DEST='mover@ovh' CRUX_NODE='" + process.execPath + "' /bin/sh Projects/tinue-move/ops/move/crux.sh " + a.join(' ')], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d)); c.once('close', (code) => resolve({ code, out })); });
const ok = (r, what) => assert.equal(r.code, 0, `${what} failed:\n${r.out}`);
// ports named in move.sh are the real ones: this copy's are the test's
{ const f = path.join(H.ovh, 'code/ops/move/move.sh'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('8642', String(OVH)).replaceAll('8643', String(CRUX))); }

const { boot, stop } = testServer(T), CDB = path.join(CD, 'tinue.db'), ODB = path.join(OD, 'tinue.db');
await stop(await boot(CDB));
const q = (f, sql) => { const d = new DatabaseSync(f, { readOnly: true }); try { return d.prepare(sql).all().map((r) => ({ ...r })); } finally { d.close(); } };
{ const d = new DatabaseSync(CDB); d.exec("INSERT INTO rush_key SELECT 'k' WHERE NOT EXISTS (SELECT 1 FROM rush_key)"); for (let i = 0; i < 200; i++) d.prepare("INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, turn) VALUES (?, 6, 'x6/x6/x6/x6/x6/x6 1 1', 1, '{\"a1\":\"win\"}', 't', 1500, 1500.1, 1)").run('p' + i); d.close(); }
fs.writeFileSync(path.join(RUN, 'mode'), `pass ${CRUX}\n`);
const gate = spawn(process.execPath, [path.join(OPS, 'gate.mjs')], { env: { ...process.env, GATE_MODE: path.join(RUN, 'mode'), GATE_STATUS: path.join(RUN, 'status'), GATE_PORT: String(GATE) }, stdio: ['ignore', 'ignore', 'inherit'] });
gate.on('exit', (...a) => console.error('gate exited', a));
kids.add(gate.pid);
const gstatus = () => JSON.parse(fs.readFileSync(path.join(RUN, 'status'), 'utf8'));
await until(() => fs.existsSync(path.join(RUN, 'status')), 'gate');
const env0 = { PATH: ENV.PATH, HOME: H.crux };
spawnSync(path.join(SH, 'launchctl'), ['bootstrap', 'gui/1', path.join(H.crux, 'Library/LaunchAgents/com.shy.tinue.plist')], { env: env0 });
const via = async (p, o = {}) => { const r = await fetch(`http://127.0.0.1:${GATE}${p}`, { ...o, headers: { connection: 'close', 'content-type': 'application/json', ...o.headers } }); return r.json(); };
await until(() => via('/api/stats').catch(() => false), 'crux up behind the gate').catch(async (e) => { console.error(fs.readdirSync(T), fs.existsSync(path.join(T,'crux.log'))&&fs.readFileSync(path.join(T,'crux.log'),'utf8'), await via('/api/stats').catch((x)=>x)); throw e; });
let sent = 0, token = null;
const solve = async () => { const id = 'p' + sent++; const r = await via('/api/result', { method: 'POST', body: JSON.stringify({ puzzleId: id, win: true, guest: { gid: 'b'.repeat(32) } }), headers: token ? { authorization: 'Bearer ' + token } : {} }); assert.ok(r.user, JSON.stringify(r)); token ||= r.token; assert.ok(token); };
const attempts = (f) => q(f, 'SELECT COUNT(*) n, COUNT(DISTINCT puzzle_id) d FROM attempts')[0];
// play through the gate, one result after another, while something runs; every one must be answered
const playing = async (p) => { let on = true; const loop = (async () => { while (on) { await solve(); await wait(150); } })(); const r = await p; on = false; await loop; return r; };
await solve();

{ // dry runs name every step and do nothing
  const l0 = fs.readFileSync(LOG, 'utf8');
  for (const c of ['go', 'abort', 'rollback', 'rehearse', 'check', 'preseed', 'tools', 'state']) { const r = await move([c, '--dry-run']); ok(r, c + ' --dry-run'); assert.match(r.out, /\[dry-run\]/); }
  const r = await move(['go', '--dry-run']);
  assert.match(r.out, /hold[\s\S]*fence[\s\S]*send[\s\S]*install[\s\S]*start[\s\S]*pass/);
  assert.equal(fs.readFileSync(LOG, 'utf8'), l0, 'a dry run ran something');
  assert.equal((await move(['go'], { MOVE_DEST: '' })).code === 0, false, 'no default host');
}
{ // rehearsal: served on the spare port as a throwaway; nothing changed
  const r = await playing(move(['rehearse'])); ok(r, 'rehearse'); assert.match(r.out, /verify: ok/); assert.match(r.out, /ovh: rehearsed/);
  assert.ok(!fs.existsSync(ODB) && !fs.existsSync(path.join(OD, 'rehearsal')) && !fs.existsSync(path.join(GD, 'WRITER')));
  // refused: different commits, a dirty deploy, another writer on crux, WRITER already here, rollback before anything moved
  const rev = path.join(H.ovh, 'code/deploy/revision.json');
  fs.writeFileSync(rev, REV.replace('a'.repeat(40), 'b'.repeat(40))); let x = await move(['go']); assert.notEqual(x.code, 0); assert.match(x.out, /not the same commit/);
  fs.writeFileSync(rev, REV); fs.writeFileSync(path.join(SH, 'pgrep.busy'), ''); x = await move(['go']); assert.notEqual(x.code, 0); assert.match(x.out, /something else is writing/); fs.rmSync(path.join(SH, 'pgrep.busy'));
  fs.writeFileSync(path.join(GD, 'WRITER'), ''); x = await move(['go']); assert.notEqual(x.code, 0); assert.match(x.out, /SERVED is here already/); fs.rmSync(path.join(GD, 'WRITER'));
  x = await move(['rollback']); assert.notEqual(x.code, 0); assert.match(x.out, /has served nothing/);
  assert.equal(gstatus().mode, 'pass', 'nothing held by a refusal'); await solve();
  console.log('rehearsal and refusals: ok');
}
{ // go fails while sending; abort puts crux back; what was held meanwhile is answered by crux
  fs.writeFileSync(path.join(T, 'fail-send'), '');
  const n = attempts(CDB).n;
  let r = await move(['go']); assert.notEqual(r.code, 0, 'preseed fails before anything is held'); assert.equal(gstatus().mode, 'pass');
  fs.rmSync(path.join(T, 'fail-send'));
  // now break the start on the new host instead
  fs.writeFileSync(path.join(T, 'fail-start'), '');
  const failing = move(['go']); failing.then((x) => process.env.DEBUG && console.log(x.out)); await until(() => gstatus().mode === 'hold', 'held');
  const held = solve();
  r = await failing; assert.notEqual(r.code, 0); assert.match(r.out, /did not answer/);
  assert.ok(!fs.existsSync(CDB) && fs.existsSync(path.join(CD, 'MOVED')), 'crux is fenced');
  fs.rmSync(path.join(T, 'fail-start'));
  r = await move(['abort']); ok(r, 'abort'); await held; assert.ok(fs.existsSync(CDB) && !fs.existsSync(path.join(CD, 'MOVED')) && !fs.existsSync(path.join(GD, 'WRITER')));
  assert.equal(attempts(CDB).n, n + 1); assert.equal(attempts(CDB).d, n + 1);
  // one bootstrap that fails (launchd's race after a bootout) is tried again, and abort can be run again
  fs.writeFileSync(path.join(T, 'fail-start'), ''); r = await move(['go']); assert.notEqual(r.code, 0); fs.rmSync(path.join(T, 'fail-start'));
  fs.writeFileSync(path.join(T, 'fail-bootstrap'), ''); r = await move(['abort']); ok(r, 'abort over a failed bootstrap'); r = await move(['abort']); ok(r, 'abort again'); await solve();
  // fence killed right after it asked launchd to stop: abort puts crux back
  fs.writeFileSync(path.join(T, 'fail-bootout'), ''); r = await move(['go']); assert.notEqual(r.code, 0); fs.rmSync(path.join(T, 'fail-bootout'));
  spawnSync('sh', ['-c', down('crux')]); r = await move(['abort']); ok(r, 'abort after a killed fence'); await solve();
  // a fence still at work (its ssh dropped): nothing else runs on that host meanwhile
  const dbm = path.join(H.ovh, 'code/ops/move/db.mjs'), src = fs.readFileSync(dbm, 'utf8');
  fs.writeFileSync(dbm, src.replace("else if (cmd === 'manifest' && a) console", "else if (cmd === 'manifest' && a) fs.existsSync(" + JSON.stringify(path.join(T, 'slow')) + ") && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000), console"));
  fs.writeFileSync(path.join(T, 'slow'), ''); const fence = crux('fence'); await until(() => fs.existsSync(path.join(CD, 'MOVED')), 'fencing');
  r = await move(['abort']); assert.notEqual(r.code, 0); assert.match(r.out, /another step is still running/); ok(await fence, 'the fence goes on'); fs.rmSync(path.join(T, 'slow')); fs.writeFileSync(dbm, src);
  // a stray tinue.db beside the fenced one: neither served nor fenced over it
  const kept = path.join(CD, fs.readFileSync(path.join(CD, 'MOVED'), 'utf8').trim()), size = fs.statSync(kept).size; fs.writeFileSync(CDB, '');
  r = await crux('fence'); assert.notEqual(r.code, 0); r = await crux('unfence'); assert.notEqual(r.code, 0); assert.match(r.out, /two databases/); assert.equal(fs.statSync(kept).size, size); fs.rmSync(CDB);
  // passing requests to a port where nothing answers is refused
  r = spawnSync(path.join(SH, 'fakessh'), ['u@ovh', `sudo -n sh /srv/tinue/ops/move/ovh.sh pass ${CRUX}`], { env: ENV }); assert.notEqual(r.status, 0); assert.equal(gstatus().mode, 'hold');
  r = await move(['abort']); ok(r, 'abort'); await solve(); assert.deepEqual(attempts(CDB), { n: sent, d: sent });
  console.log('abort: ok (crux serves again; the held result is recorded once)');
}
{ // go, interrupted at the send and run again: every result sent during it is answered and recorded exactly once
  fs.rmSync(path.join(IN, 'tinue.db'), { force: true });
  const r = await playing((async () => {
    // first try: the copy of the final database fails (the preseed has gone through by then)
    const first = move(['go']); await until(() => gstatus().mode === 'hold', 'held'); fs.writeFileSync(path.join(T, 'fail-send'), '');
    const f = await first; if (process.env.DEBUG) console.log(f.out); if (f.code === 0) return f; // (it got past the send first: nothing to resume)
    fs.rmSync(path.join(T, 'fail-send')); const g = await move(['go']); if (process.env.DEBUG) console.log(g.out); return g;
  })());
  fs.rmSync(path.join(T, 'fail-send'), { force: true });
  ok(r, 'go'); assert.match(r.out, /done: held for/);
  assert.ok(fs.existsSync(path.join(GD, 'WRITER')) && fs.existsSync(path.join(CD, 'MOVED')) && !fs.existsSync(CDB));
  const moved = fs.readdirSync(CD).find((f) => f.startsWith('tinue.db.moved-')); assert.equal(fs.statSync(path.join(CD, moved)).mode & 0o777, 0o400);
  assert.equal(gstatus().port, OVH);
  await solve(); assert.deepEqual(attempts(ODB), { n: sent, d: sent }, 'every result, once'); assert.equal(q(ODB, 'SELECT COUNT(*) n FROM users')[0].n, 1);
  assert.match((await move(['go'])).out, /already done/);
  let x = await move(['abort']); assert.notEqual(x.code, 0); assert.match(x.out, /Use rollback/);
  // the fenced host refuses to start, even by its service manager, and makes no empty database
  const s = spawnSync(process.execPath, ['--no-warnings', 'server/server.js'], { cwd: path.join(H.crux, 'Projects/tinue'), env: { ...process.env, PORT: String(CRUX), TINUE_DB: CDB }, encoding: 'utf8' }); assert.equal(s.status, 1); assert.ok(!fs.existsSync(CDB));
  console.log(`go: ok (${sent} results played through it, each recorded once; ${/held for \d+ s/.exec(r.out)[0]})`);
}
{ // backup on the new host, and the restore drill
  const B = path.join(H.ovh, 'backup'); fs.mkdirSync(B, { recursive: true });
  const run = (...a) => spawnSync(process.execPath, ['--no-warnings', path.join(OPS, 'backup.mjs'), ...a], { env: { ...process.env, TINUE_DB: ODB, TINUE_BACKUP: B }, encoding: 'utf8' });
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(B, `hourly-2020-01-01T${String(i).padStart(2, '0')}.db`), '');
  assert.match(run('--dry-run').stdout, /dry-run/); let r = run(); assert.equal(r.status, 0, r.stderr); r = run(); assert.equal(r.status, 0, r.stderr);
  const ls = fs.readdirSync(B); assert.equal(ls.filter((f) => f.startsWith('hourly-')).length, 48); assert.equal(ls.filter((f) => f.startsWith('daily-')).length, 1); assert.ok(!ls.some((f) => /-wal|-shm|part/.test(f)));
  assert.deepEqual(attempts(path.join(B, 'latest.db')), { n: sent, d: sent });
  r = run('--verify'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /restore drill: ok/);
  fs.writeFileSync(path.join(B, 'latest.db'), fs.readFileSync(path.join(B, 'latest.db')).subarray(0, 20000)); assert.notEqual(run('--verify').status, 0, 'a cut-off backup fails the drill');
  console.log('backup: ok');
}
{ // a rollback that stopped: neither go nor abort brings the older database back; rollback again finishes
  fs.writeFileSync(path.join(T, 'fail-hop'), ''); let r = await move(['rollback']); assert.notEqual(r.code, 0); assert.equal(gstatus().mode, 'pass', 'no way back: nothing is held'); fs.rmSync(path.join(T, 'fail-hop'));
  const rev = path.join(H.ovh, 'code/deploy/revision.json'); fs.writeFileSync(rev, REV.replace('a'.repeat(40), 'c'.repeat(40))); r = await move(['rollback']); assert.notEqual(r.code, 0); assert.match(r.out, /not the same commit/); assert.equal(gstatus().mode, 'pass'); fs.writeFileSync(rev, REV);
  await solve(); // written on the new host only
  // held by hand: abort and stop refuse, go lets requests through again
  spawnSync(path.join(SH, 'fakessh'), ['u@ovh', 'sudo -n sh /srv/tinue/ops/move/ovh.sh hold'], { env: ENV });
  assert.equal(gstatus().mode, 'hold'); r = await move(['abort']); assert.notEqual(r.code, 0); assert.match(r.out, /Use rollback/); r = await move(['go']); ok(r, 'go'); assert.match(r.out, /has the database already/); await solve();
  fs.writeFileSync(path.join(T, 'fail-fetch'), ''); r = await move(['rollback']); assert.notEqual(r.code, 0); assert.match(r.out, /could not fetch/); assert.equal(gstatus().mode, 'hold');
  const held = solve(); await wait(100);
  r = await move(['abort']); assert.notEqual(r.code, 0); assert.match(r.out, /Use rollback/); r = await move(['go']); assert.notEqual(r.code, 0); assert.match(r.out, /run: move.sh rollback/);
  for (const c of ['stop', 'install ' + 'a'.repeat(64), 'start']) assert.notEqual(spawnSync(path.join(SH, 'fakessh'), ['u@ovh', 'sudo -n sh /srv/tinue/ops/move/ovh.sh ' + c], { env: ENV }).status, 0, c);
  fs.rmSync(path.join(T, 'fail-fetch')); r = await move(['rollback']); ok(r, 'rollback again'); await held; await solve(); assert.deepEqual(attempts(CDB), { n: sent, d: sent }); assert.ok(!fs.existsSync(path.join(GD, 'SERVED')));
  r = await move(['go']); ok(r, 'go again'); await solve(); assert.deepEqual(attempts(ODB), { n: sent, d: sent });
  console.log('a stopped rollback: ok');
}
{ // crux's pull: whole and fresh copies only; a bad one is kept apart, said once, and leaves nothing behind
  const B = path.join(H.ovh, 'backup'), W = path.join(H.crux, 'move/pull'), tmp = () => fs.readdirSync(T).length, A = path.join(T, 'alerts');
  fs.mkdirSync(B, { recursive: true }); shim('alert', `echo "$*" >> '${A}'`); ENV.ALERT = 'alert';
  const mk = () => { const x = spawnSync(process.execPath, ['--no-warnings', path.join(OPS, 'backup.mjs')], { env: { ...process.env, TINUE_DB: ODB, TINUE_BACKUP: B }, encoding: 'utf8' }); assert.equal(x.status, 0, x.stderr); assert.ok(fs.readFileSync(path.join(B, 'health'), 'utf8').length > 2); fs.writeFileSync(path.join(B, 'health'), 'ok\n'); };
  mk(); let r = await crux('pull'); ok(r, 'pull'); const n0 = tmp(), good = fs.statSync(path.join(W, 'good.db')).size;
  const whole = fs.readFileSync(path.join(B, 'latest.db')); fs.writeFileSync(path.join(B, 'latest.db'), whole.subarray(0, 20000));
  r = await crux('pull'); assert.notEqual(r.code, 0); r = await crux('pull'); assert.notEqual(r.code, 0); assert.match(r.out, /not whole/); assert.equal(fs.statSync(path.join(W, 'good.db')).size, good); assert.equal(tmp() - n0, 1, 'only the alert'); assert.equal(fs.readFileSync(A, 'utf8').trim().split('\n').length, 1);
  mk(); ok(await crux('pull'), 'pull again'); fs.utimesSync(path.join(B, 'latest.db'), Date.now() / 1000 - 3600, Date.now() / 1000 - 3600); r = await crux('pull'); assert.notEqual(r.code, 0); assert.match(r.out, /over 30 minutes old/);
  mk(); fs.writeFileSync(path.join(B, 'health'), 'a disk mirror is degraded\n'); r = await crux('pull'); assert.notEqual(r.code, 0); assert.match(r.out, /degraded/); mk(); ok(await crux('pull'), 'pull'); 
  // the hop: no tunnel is "down", whatever its loop does
  shim('ssh', 'echo refused >&2; exit 255'); const hop = (a) => spawnSync('sh', [path.join(OPS, 'move/crux.sh'), 'hop', a], { env: { PATH: ENV.PATH, HOME: H.crux, MOVE_HOME: path.join(H.crux, 'move'), DEST: 'mover@ovh', HOP_TRIES: '2' }, encoding: 'utf8' });
  assert.equal(hop('start').status, 1); assert.equal(hop('status').status, 1); assert.equal(hop('stop').status, 0); fs.rmSync(path.join(SH, 'ssh'));
  // the new host lost: its last pulled backup, on crux, only when told it can't come back, never over a database
  await solve(); r = await crux('recover'); assert.notEqual(r.code, 0); fs.writeFileSync(CDB + '-wal', ''); r = await crux('recover', '--ovh-is-off'); assert.notEqual(r.code, 0); fs.rmSync(CDB + '-wal');
  r = await crux('recover', '--ovh-is-off'); ok(r, 'recover'); assert.match(r.out, /newest attempt is of 20/); assert.equal(attempts(CDB).n, sent - 1); assert.ok(!fs.existsSync(path.join(CD, 'MOVED')));
  // (both have a database now: go will not choose)
  fs.writeFileSync(path.join(RUN, 'x'), ''); spawnSync(path.join(SH, 'fakessh'), ['u@ovh', 'sudo -n sh /srv/tinue/ops/move/ovh.sh hold'], { env: ENV }); r = await move(['go']); assert.notEqual(r.code, 0); assert.match(r.out, /both hosts/);
  spawnSync(path.join(SH, 'fakessh'), ['u@ovh', `sudo -n sh /srv/tinue/ops/move/ovh.sh pass ${OVH}`], { env: ENV });
  spawnSync('sh', ['-c', down('crux')]); fs.renameSync(CDB, path.join(CD, 'undone')); for (const x of ['-wal', '-shm']) fs.rmSync(CDB + x, { force: true }); fs.writeFileSync(path.join(CD, 'MOVED'), fs.readdirSync(CD).find((f) => f.startsWith('tinue.db.moved-')));
  // a backup restored on the new host itself
  const f = path.join(T, 'restore.db'); fs.copyFileSync(path.join(B, 'latest.db'), f);
  const rs = (x) => spawnSync(path.join(SH, 'fakessh'), ['u@ovh', 'sudo -n sh /srv/tinue/ops/move/ovh.sh restore ' + x], { env: ENV, encoding: 'utf8' });
  fs.writeFileSync(path.join(T, 'broken.db'), 'x'.repeat(5000)); assert.notEqual(rs(path.join(T, 'broken.db')).status, 0); const now = attempts(ODB).n; assert.equal(now, sent);
  const x = rs(f); assert.equal(x.status, 0, x.stderr); sent--; await solve(); assert.equal(attempts(ODB).n, now); // (the lost one, played again)
  console.log('pull, hop, recover, restore: ok');
}
{ // rollback with the new host healthy: everything written there comes back, held results included; then go again
  let r = await playing(move(['rollback'])); ok(r, 'rollback'); assert.equal(gstatus().port, CRUX);
  await solve(); assert.deepEqual(attempts(CDB), { n: sent, d: sent }, 'every result came back, once');
  assert.ok(!fs.existsSync(path.join(GD, 'WRITER')) && fs.existsSync(path.join(OD, 'MOVED')) && !fs.existsSync(path.join(CD, 'MOVED')));
  r = await move(['rollback']); assert.notEqual(r.code, 0); assert.match(r.out, /served nothing/); await solve(); assert.deepEqual(attempts(CDB), { n: sent, d: sent }, 'run twice, the older database does not come back over the newer');
  // a second go that stops between crux's fence and the copy: rollback must not serve the copy left from the first one
  await solve(); fs.writeFileSync(path.join(T, 'fail-send'), ''); const stop = move(['go']); const g2 = await stop; assert.notEqual(g2.code, 0); fs.rmSync(path.join(T, 'fail-send'));
  r = await move(['rollback']); assert.notEqual(r.code, 0); assert.match(r.out, /move.sh abort/); r = await move(['abort']); ok(r, 'abort'); await solve(); assert.deepEqual(attempts(CDB), { n: sent, d: sent });
  r = await playing(move(['go'])); ok(r, 'go after a rollback'); await solve(); assert.deepEqual(attempts(ODB), { n: sent, d: sent });
  console.log('rollback: ok (and a second one changes nothing, and go works after it)');
}
{ // verify refuses a database that differs in one row, or is cut off; checkpoint refuses one in use
  const f = path.join(T, 'v.db'), m = path.join(T, 'v.json'), run = (...a) => spawnSync(process.execPath, ['--no-warnings', path.join(OPS, 'move/db.mjs'), ...a], { encoding: 'utf8' });
  assert.equal(run('backup', ODB, f).status, 0); fs.writeFileSync(m, run('manifest', f).stdout); assert.equal(run('verify', f, m).status, 0);
  assert.ok(!fs.readFileSync(m, 'utf8').includes(q(f, 'SELECT k FROM rush_key')[0].k + '"'), 'the signing key is in it by hash only');
  { const d = new DatabaseSync(f); d.exec('DELETE FROM attempts WHERE rowid = (SELECT MAX(rowid) FROM attempts)'); d.close(); } assert.equal(run('verify', f, m).status, 1);
  assert.equal(run('backup', path.join(T, 'absent.db'), f).status, 1); assert.ok(!fs.existsSync(path.join(T, 'absent.db')));
  assert.match(run('checkpoint', ODB).stderr, /in use|locked/);
  const S = (o) => { const p = path.join(T, 's' + Math.random()); fs.writeFileSync(p, JSON.stringify(o)); return p; };
  assert.equal(run('stats-eq', S({ n: 3, avg: 1500.1 }), S({ n: 3, avg: 1500.1000000001 })).status, 0); assert.equal(run('stats-eq', S({ n: 3 }), S({ n: 4 })).status, 1); { const x = run('stats-eq', S({ n: 3, avg: 1500.1 }), S({ n: 3, avg: 1500.2 })); assert.equal(x.status, 0); assert.match(x.stdout, /WARNING/); } assert.equal(run('stats-eq', S({}), S({})).status, 1);
  console.log('database checks: ok');
}
gate.kill('SIGKILL');
spawnSync('sh', ['-c', down('ovh') + ';' + down('crux')]);
console.log('ops: all ok');
process.exit(0);
