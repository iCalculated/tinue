// ops/gate.mjs: holds requests while the writer changes and sends each exactly once, with no answer of its own.
//   node scripts/test-gate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-gate-')), MODE = path.join(T, 'mode'), STATUS = path.join(T, 'status');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what) => { for (let i = 0; i < 300; i++) { if (await f()) return; await wait(20); } throw new Error('never: ' + what); };
// The gate's port is TINUE_TEST_PORT (a sandbox may allow only some); the upstreams' are its neighbours.
const P = +process.env.TINUE_TEST_PORT || 20000 + Math.floor(Math.random() * 20000), UP1 = P + 1, UP2 = P + 2;
const upstream = (port, delay = 0) => new Promise((resolve) => {
  const got = [];
  const s = http.createServer((req, res) => {
    const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => {
      const body = Buffer.concat(b); got.push({ url: req.url, method: req.method, headers: req.headers, body: body.toString(), n: body.length });
      if (req.url === '/cut') { res.writeHead(200, { 'content-length': 100 }); res.write('half'); setTimeout(() => res.destroy(), 50); return; }
      if (req.url === '/kill') { req.socket.destroy(); return; }
      setTimeout(() => {
        res.writeHead(req.url === '/304' ? 304 : 200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'], 'x-up': String(port) });
        res.end(req.method === 'HEAD' || req.url === '/304' ? undefined : JSON.stringify({ port, n: body.length }));
      }, req.url.startsWith('/slow') ? 600 : delay);
    });
  });
  s.got = got; s.listen(port, '127.0.0.1', () => resolve(s));
});
const call = (p, { method = 'GET', body, headers = {} } = {}) => {
  let req;
  const done = new Promise((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port: P, path: p, method, agent: false, headers }, (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: s })); res.on('error', reject); });
    req.on('error', reject); req.end(body);
  });
  done.catch(() => {});
  return { done, abort: () => req.destroy() };
};
const post = (p, body, headers) => call(p, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
const dropped = async (c, what) => { const e = await c.done.then((r) => r, (e) => e); assert.ok(e instanceof Error, `${what}: answered ${e.status} ${e.text}`); };
const status = () => JSON.parse(fs.readFileSync(STATUS, 'utf8'));
let gate;
const start = async (env = {}) => {
  fs.rmSync(STATUS, { force: true });
  gate = spawn(process.execPath, [path.join(ROOT, 'ops/gate.mjs')], { env: { ...process.env, GATE_MODE: MODE, GATE_STATUS: STATUS, GATE_PORT: String(P), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  gate.err = ''; gate.stderr.on('data', (d) => (gate.err += d)); let out = ''; gate.stdout.on('data', (d) => (out += d));
  gate.done = new Promise((r) => gate.once('exit', (c, sig) => r(c ?? sig)));
  await until(() => out.includes('gate on'), 'gate up');
};
const ctl = (...a) => new Promise((r) => { const c = spawn('sh', [path.join(ROOT, 'ops/gate-ctl.sh'), ...a], { env: { ...process.env, GATE_MODE: MODE, GATE_STATUS: STATUS, GATE_WAIT: '2' }, stdio: 'ignore' }); c.once('exit', r); });
process.on('exit', () => { gate?.kill('SIGKILL'); fs.rmSync(T, { recursive: true, force: true }); });

const a = await upstream(UP1), b = await upstream(UP2);
fs.writeFileSync(MODE, `pass ${UP1}\n`);
await start();
{ // pass: unchanged both ways
  const r = await post('/api/x?y=%20z', '{"a":1}', { host: 'api.tinue.me', 'x-forwarded-for': '203.0.113.9', authorization: 'Bearer q', cookie: 'c=1' }).done;
  assert.equal(r.status, 200); assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2']); assert.equal(r.text, JSON.stringify({ port: UP1, n: 7 }));
  const g = a.got.at(-1);
  assert.equal(g.url, '/api/x?y=%20z'); assert.equal(g.headers.host, 'api.tinue.me'); assert.equal(g.headers['x-forwarded-for'], '203.0.113.9'); assert.equal(g.headers.authorization, 'Bearer q'); assert.equal(g.body, '{"a":1}');
  assert.equal((await call('/304').done).status, 304);
  assert.equal((await call('/h', { method: 'HEAD' }).done).text, '');
  assert.equal((await call('/o', { method: 'OPTIONS' }).done).status, 200);
  const big = 'x'.repeat(90e3); assert.equal(JSON.parse((await post('/api/result', big, { 'transfer-encoding': 'chunked' }).done).text).n, 90e3);
  const n = a.got.length; await dropped(post('/api/result', 'x'.repeat(2.1e6)), 'over the cap'); assert.equal(a.got.length, n, 'nothing sent of a body over the cap');
  await dropped(call('/kill'), 'upstream gone'); await dropped(call('/cut'), 'upstream cut off');
  assert.equal(a.got.filter((x) => x.url === '/kill').length, 1, 'never retried');
  console.log('pass: ok (headers, host, bodies, 304, HEAD; an upstream failure is a dropped socket, sent once)');
}
{ // hold waits for what was sent before it; then everything goes to the new upstream, in order, once
  const before = call('/slow'); await wait(150);
  fs.writeFileSync(MODE, 'hold\n'); gate.kill('SIGUSR2');
  await until(() => status().mode === 'hold', 'hold'); assert.equal(status().inflight, 1, 'the request under way is counted');
  assert.equal(await ctl('hold'), 0); assert.equal(status().inflight, 0); assert.equal((await before.done).text, JSON.stringify({ port: UP1, n: 0 }));
  a.got.length = 0;
  const first = [post('/api/result', '{"i":0}'), null, null]; await until(() => status().queued === 1, 'q1');
  first[1] = post('/api/result', '{"i":1}'); await until(() => status().queued === 2, 'q2');
  first[2] = call('/api/me'); await until(() => status().queued === 3, 'q3');
  const gone = post('/api/result?b=1', '{"gone":1}'); await until(() => status().queued === 4, 'q4'); gone.abort();
  const rush = post('/api/rush/result', '{"rush":1}'); await until(() => status().queued === 5, 'q5'); rush.abort();
  const login = post('/api/login', '{"login":1}'); await until(() => status().queued === 6, 'q6'); login.abort();
  const next = call('/api/next'); await until(() => status().queued === 6, 'q7'); next.abort(); await until(() => status().queued === 5, 'the aborted ones that are not results leave');
  const late = post('/api/resultx', '{}'); await until(() => status().queued === 6, 'q8'); late.abort(); await until(() => status().queued === 5, 'only the result routes are kept');
  // a body that never all comes is never sent
  const half = net.connect(P, '127.0.0.1'); half.write('POST /api/result HTTP/1.1\r\nhost: x\r\ncontent-length: 50\r\n\r\n{"half":'); await wait(100); half.destroy();
  await wait(200); assert.equal(a.got.length + b.got.length, 0, 'nothing is sent while it holds');
  // an unreadable mode file changes nothing
  fs.writeFileSync(MODE, 'pass everything'); gate.kill('SIGUSR2'); await wait(150); assert.equal(b.got.length, 0); assert.equal(status().mode, 'hold');
  assert.equal(await ctl('pass', String(UP2)), 0);
  for (const c of first) assert.equal((await c.done).headers['x-up'], String(UP2));
  await until(() => b.got.length === 5, 'all five'); await wait(200);
  assert.deepEqual(b.got.map((g) => g.body || g.url), ['{"i":0}', '{"i":1}', '/api/me', '{"gone":1}', '{"rush":1}']); assert.equal(a.got.length, 0);
  assert.equal(status().queued, 0);
  console.log('hold: ok (drains first, queues in order, each sent once to the new upstream; a result outlives its client, nothing else does)');
}
{ // stopping: refused while it holds requests; a second SIGTERM drops them
  await ctl('hold'); const c = call('/api/me'); await until(() => status().queued === 1, 'q');
  gate.kill('SIGTERM'); await wait(200); assert.equal(gate.exitCode, null); assert.match(gate.err, /not stopping/);
  gate.kill('SIGTERM'); assert.equal(await gate.done, 0); await dropped(c, 'dropped at the second SIGTERM');
  // started again it reads the mode file: still holding
  await start(); assert.equal(status().mode, 'hold');
  const p = ctl('pass', String(UP1)); await p; assert.equal((await call('/api/me').done).status, 200);
  const under = call('/slow'); await wait(100); gate.kill('SIGTERM'); assert.equal((await under.done).status, 200, 'a request under way is finished'); assert.equal(await gate.done, 0);
  assert.notEqual(await ctl('hold'), 0, 'gate-ctl says so when there is no gate'); fs.writeFileSync(MODE, 'hold\n');
  console.log('stop: ok (refused while holding, restart keeps holding, in-flight finished)');
}
{ // limits: past the hold limit or the queue limit the socket is dropped, with no answer; a result held too long is still sent
  await start({ GATE_MAX_HOLD: '400', GATE_MAX_QUEUE: '2' });
  a.got.length = 0;
  const r = post('/api/result', '{"old":1}'), g = call('/api/me'); await until(() => status().queued === 2, 'full');
  await dropped(call('/api/stats'), 'queue full'); await dropped(r, 'held too long'); await dropped(g, 'held too long');
  await until(() => status().queued === 1, 'only the result stays');
  await ctl('pass', String(UP1)); await until(() => a.got.length, 'sent'); await wait(100); assert.deepEqual(a.got.map((x) => x.body), ['{"old":1}']);
  console.log('limits: ok');
  gate.kill('SIGTERM'); await gate.done;
}
a.close(); b.close();
console.log('gate: all ok');
process.exit(0);
