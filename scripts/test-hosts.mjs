// The server as its Linux host runs it (scripts/deploy-ovh.sh's env), under both API names and from both pages: CORS, the
// cookie, share links, /api/handoff-token; and that a fenced host does not start.   node scripts/test-hosts.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { testServer, ROOT } from './lib/boot.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-hosts-')), DB = path.join(dir, 't.db');
const { PORT, boot, stop } = testServer(dir);
const src = fs.readFileSync(path.join(ROOT, 'scripts/deploy-ovh.sh'), 'utf8');
const ENV = Object.fromEntries(/<<ENV\n([\s\S]*?)\nENV\n/.exec(src)[1].split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)).filter(([k, v]) => !v.includes('$') && !['PORT', 'HOST', 'TINUE_SYNTAKS'].includes(k)));
assert.equal(ENV.TINUE_HANDOFF_ORIGIN, 'https://shydrie.xyz');
const req = (host, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { host, 'x-forwarded-proto': 'https', ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: s, json: () => JSON.parse(s) }));
  });
  r.on('error', reject); r.end(body && JSON.stringify(body));
});
const NEW = 'api.tinue.me', OLD = 'tinue-api.shydrie.xyz', ME = 'https://tinue.me', SHY = 'https://shydrie.xyz', PAGES = 'https://pages.shydrie.xyz';

await stop(await boot(DB));
{ const d = new DatabaseSync(DB); d.prepare("INSERT INTO puzzles (id, size, tps, plies, tree, source, init_rating, rating) VALUES ('p1', 6, 'x6/x6/x6/x6/x6/x6 1 1', 1, '{\"a1\":\"win\"}', 't', 1500, 1500)").run(); d.close(); }
let child = await boot(DB, ENV);
const token = (await req(NEW, '/api/register', { method: 'POST', body: { name: 'alice' }, headers: { origin: ME } })).json().token;
const cookie = 'tinue_token=' + token;
for (const host of [NEW, OLD]) {
  for (const [origin, ok] of [[ME, true], [SHY, true], [PAGES, false], ['https://evil.tinue.me', false], ['http://tinue.me', false], ['null', false]]) {
    const r = await req(host, '/api/me', { headers: { origin, cookie } });
    assert.equal(r.headers['access-control-allow-origin'], ok ? origin : undefined, host + ' ' + origin);
    assert.equal(r.json().user?.name ?? null, ok ? 'alice' : null, `the cookie on ${host} from ${origin}`);
    const pre = await req(host, '/api/result', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers['access-control-allow-origin'], ok ? origin : undefined);
    assert.equal(!!(await req(host, '/api/login', { method: 'POST', body: { token }, headers: { origin } })).headers['set-cookie'], ok);
  }
  assert.equal((await req(host, '/api/me', { headers: { cookie } })).json().user.name, 'alice', 'no Origin: a bot or a typed address');
  assert.match((await req(host, '/api/login', { method: 'POST', body: { token }, headers: { origin: ME } })).headers['set-cookie'][0], /^tinue_token=[a-f0-9]{48}; Path=\/; Max-Age=\d+; SameSite=Lax; HttpOnly; Secure$/);
  const share = await req(host, '/p/p1');
  assert.equal(share.status, 200); assert.ok(share.text.includes(`https://${host}/p/p1.png`)); assert.ok(share.text.includes('https://tinue.me/#/puzzle/p1'), 'forwards to the page'); assert.ok(!share.text.includes('shydrie.xyz/tinue'));
  assert.equal((await req(host, '/p/p1.png')).headers['content-type'], 'image/png');
  const doc = await req(host, '/api'); assert.equal(doc.status, 200); assert.ok(doc.text.includes('https://tinue.me/#/puzzle/')); assert.ok(!doc.text.includes('shydrie.xyz/tinue'));
  for (const h of [{}, { 'sec-fetch-mode': 'navigate' }]) assert.equal((await req(host, '/api/stats', { headers: h })).status, 200, host + ' is never redirected');
}
assert.equal((await req('crux.tail5ed24.ts.net', '/api/stats')).status, 200, 'TINUE_MOVED_FROM is empty there');
console.log('both API names: ok (CORS, cookie, share links, docs; pages.shydrie.xyz and *.tinue.me get neither)');

const hand = (headers, { host = OLD, method = 'POST' } = {}) => req(host, '/api/handoff-token', { method, headers: { 'x-forwarded-for': '198.51.100.1', ...headers } });
const good = await hand({ origin: SHY, cookie: 'x=1; ' + cookie + '; y=2' });
assert.equal(good.status, 200); assert.deepEqual(good.json(), { token }); assert.equal(good.headers['cache-control'], 'no-store'); assert.equal(good.headers['access-control-allow-origin'], SHY); assert.equal(good.headers['access-control-allow-credentials'], 'true'); assert.equal(good.headers['set-cookie'], undefined);
for (const [what, h] of [['tinue.me', { origin: ME, cookie }], ['pages', { origin: PAGES, cookie }], ['null', { origin: 'null', cookie }], ['none', { cookie }], ['http', { origin: 'http://shydrie.xyz', cookie }], ['a port', { origin: SHY + ':8443', cookie }], ['a suffix', { origin: SHY + '.evil.example', cookie }]]) {
  const r = await hand(h); assert.equal(r.status, 404, 'origin ' + what); assert.ok(!r.text.includes(token));
}
assert.equal((await hand({ origin: SHY, cookie }, { method: 'GET' })).status, 404);
for (const [what, h] of [['a bearer token beside it', { origin: SHY, cookie, authorization: 'Bearer ' + token }], ['no cookie', { origin: SHY }], ['an unknown token', { origin: SHY, cookie: 'tinue_token=' + 'a'.repeat(48) }], ['a longer one', { origin: SHY, cookie: cookie + 'ab' }]]) {
  const r = await hand(h); assert.equal(r.status, 401, what); assert.deepEqual(r.json(), { error: 'none' }); assert.equal(r.headers['cache-control'], 'no-store');
}
// failures are limited per client (4 so far); a right cookie still works from a limited one, and others aren't limited
for (let i = 0; i < 6; i++) assert.equal((await hand({ origin: SHY })).status, 401);
const lim = await hand({ origin: SHY }); assert.equal(lim.status, 429); assert.ok(+lim.headers['retry-after'] > 0);
assert.equal((await hand({ origin: SHY, cookie })).status, 200);
assert.equal((await hand({ origin: SHY, 'x-forwarded-for': '198.51.100.2' })).status, 401);
await stop(child);
assert.ok(!fs.readFileSync(path.join(dir, 'access.log'), 'utf8').includes(token), 'the token is in no log'); assert.ok(!(child.out() + child.err()).includes(token));
console.log('handoff-token: ok (one origin, cookie only, no-store, failures limited, never logged)');

// a fenced host: neither the server nor a script that opens the database through it starts, and the database is untouched
fs.writeFileSync(path.join(dir, 'MOVED'), 'x'); const before = fs.readFileSync(DB);
for (const s of ['server/server.js', 'scripts/import.mjs']) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, s)], { cwd: dir, env: { ...process.env, TINUE_DB: DB, PORT: String(PORT) }, encoding: 'utf8', timeout: 20e3 });
  assert.equal(r.status, 1, s); assert.match(r.stderr, /fenced/);
}
assert.ok(before.equals(fs.readFileSync(DB)));
console.log('fenced host: ok (nothing starts)');
fs.rmSync(dir, { recursive: true, force: true });
