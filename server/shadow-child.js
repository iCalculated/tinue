// One prover process for server/prover.js: runs the browser's own still-wins check (public/engine-worker.js 'still',
// the same file the page's worker loads, unchanged: it only needs `self`, and its './shared/' imports resolve through
// public/shared) on JSON lines from stdin, one at a time, and writes one JSON line per answer. With a trace of the
// check's df-pn runs, so the shadow's log (server/shadow.js, plan step S3) can say whether a 'no' came from a threat
// search that finished or from a later stage after one ran out of budget (the V3 load estimate):
//   in:  {"id":1,"size":6,"komi":2,"tps":"…"|null,"plies":["…"],"attacker":1,"budgets":[[3e4,2.5e4],[1e5,2.5e4]]}
//   out: {"id":1,"kind":"wins"|"no"|"unknown"|"error","plies":12|null,"trace":[{"n":30000,"full":false,"r":0}, …]}
// The trace is read by wrapping TinueSearch.prototype.solve of the very module instance the worker imports
// (public/shared/pns.js); the search itself is untouched.
import readline from 'node:readline';
import { TinueSearch } from '../public/shared/pns.js';

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let reply = null, trace = null;
const solve = TinueSearch.prototype.solve;
TinueSearch.prototype.solve = function (p) {
  const rec = trace && trace.length < 16 ? { n: this.maxNodes, full: !!this.fullDefense } : null;
  try {
    const ok = solve.call(this, p);
    if (rec) trace.push({ ...rec, r: ok ? 1 : 0 });
    return ok;
  } catch (e) {
    if (rec && e?.message === 'budget') trace.push({ ...rec, r: 'budget' });
    throw e;
  }
};
globalThis.self = { postMessage: (m) => { if (!m.partial && reply) reply(m); } };
await import('../public/engine-worker.js');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  let req;
  try { req = JSON.parse(line); } catch { out({ id: null, kind: 'error', error: 'bad request' }); continue; }
  let m = null;
  reply = (x) => { m = x; };
  trace = [];
  self.onmessage({ data: { ...req, type: 'still' } }); // (synchronous: the search runs to its budget and answers)
  reply = null;
  const t = trace; trace = null;
  out(m ? { id: req.id, kind: m.kind, plies: m.plies ?? null, trace: t, ...(m.error ? { error: m.error } : {}) } : { id: req.id, kind: 'error', error: 'no answer' });
}
