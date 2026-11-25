// The gate: Caddy -> gate -> the one writing node, in the path only while the API moves between hosts. It can hold every
// request while the writer changes, then let them through, so a short pause loses nothing (Caddy's own retry answered 502
// to POSTs the upstream had already done).
//   node ops/gate.mjs            env GATE_MODE (mode file), GATE_STATUS (status file), GATE_PORT (8641)
//   mode file: "pass <port>" or "hold"; read at start and on SIGUSR2 (ops/gate-ctl.sh does both)
//   status file: JSON { pid, mode, port, queued, inflight, at }, rewritten on every change while holding
// Rules: the body is read whole (at most MAX_BODY), then forwarded with method, path and headers unchanged. Each request
// is sent at most once; an upstream that fails after that gets the client's socket destroyed, never an answer made here
// (a JSON one would tell the page its result was dealt with). A client that has gone away is dropped from the queue,
// except a result (KEEP): that is still sent, and the server keeps the first of any resend. Held past MAX_HOLD: the
// client's socket is destroyed, a KEEP is still sent later. Over MAX_QUEUE: the socket is destroyed. The queue is in memory.
// `hold` is in force when the status says mode hold and inflight 0: every request sent before it has been answered.
// SIGTERM with a queue is refused; a second one is obeyed.
import http from 'node:http';
import fs from 'node:fs';

const { GATE_MODE, GATE_STATUS } = process.env, PORT = +(process.env.GATE_PORT || 8641);
if (!GATE_MODE || !GATE_STATUS) { console.error('gate: set GATE_MODE and GATE_STATUS'); process.exit(2); }
const MAX_BODY = 2e6, MAX_HOLD = +process.env.GATE_MAX_HOLD || 600e3, MAX_QUEUE = +process.env.GATE_MAX_QUEUE || 500;
const KEEP = /^\/api\/(?:result|rush\/result)(?:\?|$)/;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect', 'content-length']);
let mode = { hold: true }, queue = [], inflight = 0, terms = 0, closing = false;

function readMode() {
  const m = /^(?:(hold)|pass (\d{2,5}))\s*$/.exec(fs.readFileSync(GATE_MODE, 'utf8'));
  if (!m) throw new Error('bad mode file');
  return m[1] ? { hold: true } : { port: +m[2] };
}
function status() {
  const s = { pid: process.pid, mode: mode.hold ? 'hold' : 'pass', port: mode.port ?? null, queued: queue.length, inflight, at: new Date().toISOString() };
  try { fs.writeFileSync(GATE_STATUS + '.tmp', JSON.stringify(s) + '\n'); fs.renameSync(GATE_STATUS + '.tmp', GATE_STATUS); } catch (e) { console.error('gate status', e.message); }
}
function load() {
  try { mode = readMode(); } catch (e) { console.error('gate: kept the mode,', e.message); return; } // an unreadable file changes nothing (at start: hold)
  console.log(new Date().toISOString(), 'gate', JSON.stringify(mode), 'queued', queue.length, 'inflight', inflight);
  if (!mode.hold) { const w = queue; queue = []; for (const j of w) send(j); }
  status();
}
const headers = (raw) => { // [k, v, k, v, ...] as received -> { k: v or [v, v] }, without the hop-by-hop ones
  const h = {};
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i].toLowerCase();
    if (!HOP.has(k)) h[k] = k in h ? [].concat(h[k], raw[i + 1]) : raw[i + 1];
  }
  return h;
};
function finished() { inflight--; if (mode.hold) status(); bye(); }
function send(j) {
  clearTimeout(j.timer);
  const { req, res, body } = j, keep = req.method === 'POST' && KEEP.test(req.url);
  if (j.gone && !keep) return;
  inflight++;
  let over = false;
  const end = (e) => { if (over) return; over = true; if (e) { console.error('gate upstream', e.code || e.message); res.destroy(); } finished(); };
  const h = headers(req.rawHeaders);
  if (body.length || !['GET', 'HEAD'].includes(req.method)) h['content-length'] = body.length;
  const u = http.request({ host: '127.0.0.1', port: mode.port, method: req.method, path: req.url, headers: h, agent: false }, (r) => {
    const out = [];
    r.on('data', (c) => out.push(c));
    r.on('error', end);
    r.on('close', () => { if (!r.complete) end(new Error('cut off')); });
    r.on('end', () => {
      if (!r.complete) return;
      if (!j.gone) {
        const b = Buffer.concat(out), rh = headers(r.rawHeaders);
        if (req.method === 'HEAD') { if (r.headers['content-length']) rh['content-length'] = r.headers['content-length']; }
        else if (r.statusCode !== 204 && r.statusCode !== 304) rh['content-length'] = b.length;
        res.writeHead(r.statusCode, rh); res.end(b);
      }
      end();
    });
  });
  u.on('error', end);
  u.end(body);
}
const server = http.createServer(async (req, res) => {
  const j = { req, res, body: null, gone: false, timer: null };
  res.on('close', () => {
    j.gone = !res.writableFinished;
    if (j.gone && j.body && !(req.method === 'POST' && KEEP.test(req.url)) && queue.includes(j)) { queue = queue.filter((x) => x !== j); clearTimeout(j.timer); status(); bye(); }
  });
  const b = []; let n = 0;
  try { for await (const c of req) { n += c.length; if (n > MAX_BODY) { res.destroy(); return; } b.push(c); } } catch { return; } // the body never all came: nothing to send
  j.body = Buffer.concat(b);
  if (!mode.hold) { send(j); return; }
  if (queue.length >= MAX_QUEUE) { res.destroy(); return; }
  queue.push(j);
  j.timer = setTimeout(() => res.destroy(), MAX_HOLD); // 'close' then drops it, or keeps a result
  status();
});
server.keepAliveTimeout = 120e3; server.headersTimeout = 125e3; server.requestTimeout = 0; // Caddy pools connections for 60 s

process.on('SIGUSR2', load);
function bye() { if (closing && !inflight && !queue.length) setTimeout(() => process.exit(0), 100); }
process.on('SIGTERM', () => {
  if (queue.length && ++terms < 2) { console.error(`gate: ${queue.length} requests are held; not stopping (pass them on, or send SIGTERM again to drop them)`); return; }
  if (queue.length) { console.error(`gate: dropping ${queue.length} held requests`); queue = []; }
  closing = true; server.close(); setInterval(() => server.closeIdleConnections(), 50); bye();
});
server.on('error', (e) => { console.error('gate', e.message); process.exit(1); });
// (holding until it has the port and has read the mode; a second gate fails on the port without touching the status)
server.listen(PORT, '127.0.0.1', () => { load(); status(); console.log('gate on 127.0.0.1:' + PORT); });
