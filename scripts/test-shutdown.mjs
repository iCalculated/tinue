// SIGTERM: a request under way is answered, the WAL is folded into the database, exit 0; a taken port is exit 1.
//   node scripts/test-shutdown.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { testServer, ROOT } from './lib/boot.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-stop-')), DB = path.join(dir, 't.db');
const { PORT, base, boot, stop } = testServer(dir);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await stop(await boot(DB));
{ const d = new DatabaseSync(DB); for (let i = 0; i < 3; i++) d.prepare("INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating, turn) VALUES (?, 6, 'x6/x6/x6/x6/x6/x6 1 1', 1, '{\"a1\":\"win\"}', 't', 1500, 1500, 1)").run('p' + i); d.close(); }
const ended = (child) => new Promise((r) => (child.exitCode != null ? r([child.exitCode, child.signalCode]) : child.once('exit', (...a) => r(a))));

{
  const child = await boot(DB), agent = new http.Agent({ keepAlive: true });
  // an idle kept-open connection (a proxy's pool), and a POST whose body is half sent
  await new Promise((r) => http.get({ port: PORT, host: '127.0.0.1', path: '/api/stats', agent }, (res) => { res.resume(); res.on('end', r); }));
  const body = JSON.stringify({ puzzleId: 'p0', win: true, guest: { gid: 'a'.repeat(32) } });
  const answer = new Promise((resolve, reject) => {
    const r = http.request({ port: PORT, host: '127.0.0.1', path: '/api/result', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(s) })); });
    r.on('error', reject); r.write(body.slice(0, 10)); setTimeout(() => r.end(body.slice(10)), 700);
  });
  await wait(200);
  const t0 = Date.now(); child.kill('SIGTERM'); child.kill('SIGTERM'); await wait(100);
  await assert.rejects(fetch(base + '/api/stats'), 'no new connections while stopping');
  const r = await answer;
  assert.equal(r.status, 200); assert.ok(r.json.user.id);
  assert.deepEqual(await ended(child), [0, null]); assert.ok(Date.now() - t0 < 5000, 'it did not wait for the idle connection');
  assert.ok(!fs.existsSync(DB + '-wal') || fs.statSync(DB + '-wal').size === 0, 'the WAL is empty');
  const d = new DatabaseSync(DB, { readOnly: true }); assert.equal(d.prepare('SELECT COUNT(*) n FROM attempts').get().n, 1, 'the result is kept'); d.close();
  assert.match(fs.readFileSync(path.join(dir, 'access.log'), 'utf8'), /POST \/api\/result 200/);
  agent.destroy();
  console.log('SIGTERM: ok (in-flight POST answered and kept, WAL folded in, exit 0)');
}
{ // a request that never finishes does not hold it past STOP_MS
  const child = await boot(DB), s = net.connect(PORT, '127.0.0.1'); s.on('error', () => {});
  s.write('POST /api/result HTTP/1.1\r\nhost: x\r\ncontent-length: 50\r\n\r\n{'); await wait(200);
  const t0 = Date.now(); child.kill('SIGTERM'); assert.deepEqual(await ended(child), [0, null]); const ms = Date.now() - t0; assert.ok(ms > 2000 && ms < 4500, ms + ' ms'); s.destroy();
  console.log('stuck request: ok (stops after 2.5 s)');
}
{ // the port is taken: exit 1, not 0
  const s = net.createServer().listen(PORT, '127.0.0.1'); await new Promise((r) => s.once('listening', r));
  const c = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'server/server.js')], { env: { ...process.env, TINUE_DB: DB, TINUE_ACCESS_LOG: path.join(dir, 'access.log'), PORT: String(PORT), HOST: '127.0.0.1' }, encoding: 'utf8', timeout: 20e3 });
  assert.equal(c.status, 1, c.stdout + c.stderr); assert.match(c.stderr, /EADDRINUSE/); s.close();
  console.log('port taken: ok (exit 1)');
}
fs.rmSync(dir, { recursive: true, force: true });
