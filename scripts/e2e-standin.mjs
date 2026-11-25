// PTN Ninja is tinue's only board (2026-11-22), so every e2e that opens the page needs it. This serves the local stand-in
// (scripts/ninja-standin.html) for https://ptn.ninja over the DevTools protocol, so an e2e needs no network:
//   chrome args:  ...STANDIN_ARGS (the frame in the page's own process, so the page's Fetch domain sees its requests)
//   Fetch.enable: { patterns: [...yours, STANDIN_PATTERN] }
//   on Fetch.requestPaused: if (await standin(cdp, params)) return;  (true: it was ptn.ninja's, and is answered)
// mode: the stand-in's (ok, never, die:N, slow:MS, lag:MS), or trickle:MS (its page arrives only after MS, as on a
// very slow connection: no load event until then; then it is 'ok'), or 'block' (ptn.ninja refuses the connection), or 'real'
// (let it through to the real ptn.ninja). A function, so a test can change it between loads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'scripts/ninja-standin.html'), 'utf8');
export const STANDIN_ARGS = ['--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process'];
export const STANDIN_PATTERN = { urlPattern: 'https://ptn.ninja/*' };
export const stats = { docs: 0, reqs: 0 };
export async function standin(cdp, p, mode = () => 'ok', sessionId) {
  const url = new URL(p.request.url);
  if (url.origin !== 'https://ptn.ninja' || p.responseStatusCode != null) return false;
  let m = typeof mode === 'function' ? mode() : mode;
  if (/^trickle:\d+$/.test(m)) { if (p.resourceType === 'Document') await new Promise((r) => setTimeout(r, +m.slice(8))); m = 'ok'; }
  stats.reqs++; if (p.resourceType === 'Document') stats.docs++;
  try {
    if (m === 'real') await cdp('Fetch.continueRequest', { requestId: p.requestId }, sessionId);
    else if (m === 'block') await cdp('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' }, sessionId);
    else {
      let body, type = 'text/html';
      if (url.pathname.startsWith('/__tinue/')) { body = fs.readFileSync(path.join(ROOT, url.pathname.slice(9))); type = 'text/javascript'; }
      else body = Buffer.from(HTML.replace('__MODE__', m));
      await cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: type }, { name: 'cache-control', value: 'no-store' }], body: body.toString('base64') }, sessionId);
    }
  } catch { await cdp('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {}); }
  return true;
}
