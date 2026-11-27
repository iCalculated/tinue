// Syntaks for the analysis view (public/syntaks-analysis.js, the beta's): its own worker and its own instance, so play-on's
// is never touched. The engine's host (the WASI shim, the TEI call) is worker.js's, whose messages this replaces.
//
//   → { type: 'init', module }                             ← { type: 'ready' } | { type: 'error', error }
//   → { type: 'go', id, n, tps, halfKomi, lines, ms, nodes, long }
//                                                          ← { type: 'heard', n }, at once unless a search holds the worker
//                                                          ← { type: 'lines', id, infos, depth, nodes, ms }, as it deepens
//                                                          ← { type: 'long', id, ms }: nothing is heard for that long
//                                                          ← { type: 'done', …, kns }, or { type: 'error', id, error }
//   → { type: 'stop', n }                                  ← { type: 'heard', n }
// infos: best first, as the engine prints them (the side to move's view). A search can't be stopped inside the engine, so
// it begins with short ones that keep the hash; between two of them a newer go or a stop is heard, and the old one is
// silent. From long ms on, one search of all the time left (short ones begin again at depth 1 and get no deeper): that one
// the page ends with the worker. Its own bounds end it through the engine's clock.
if (typeof wasi === 'undefined') importScripts('./worker.js' + self.location.search); // (the page starts the two as one script)

const CHUNKS = [50, 80, 110, 150], FIRST_DEPTH = 5, FIRST_MS = 100, EVERY = 100, DEEP = 24, MATE_MS = 1200, IDLE = 700;
let job = null, running = false, booted = null, multipv = 1, heard = 0, onLine = null, skew = 0;
const write = wasi.fd_write;
wasi.fd_write = (...a) => { const r = write(...a); if (onLine) while (heard < lines.length) onLine(lines[heard++]); return r; };

// (the engine's clock: put forward, its search is out of time)
const clock = wasi.clock_time_get;
wasi.clock_time_get = (id, p, out) => { const r = clock(id, p, out); if (id) { const v = view(); v.setBigUint64(out, v.getBigUint64(out, true) + BigInt(skew), true); } return r; };

// A scored info line (shared/tei.js parseInfo agrees), or null.
function infoOf(line) {
  const t = line.split(/\s+/), s = t.indexOf('score'), m = t.indexOf('multipv');
  if (t[0] !== 'info' || t[1] === 'string' || s < 0 || !/^(cp|mate)$/.test(t[s + 1]) || !Number.isFinite(+t[s + 2])) return null;
  return { ...parseInfo([t.join(' ')]), multipv: (m < 0 ? 0 : +t[m + 1]) || 1, bound: t.includes('lowerbound') || t.includes('upperbound') };
}

async function search(j) {
  const t0 = performance.now(), since = () => performance.now() - t0;
  let nodes = 0, shorts = 0, best = null, depth = 0, full = 0, posted = -1e9, kns = null, fresh = false;
  if (halfKomi !== j.halfKomi) { tei(`setoption name HalfKomi value ${j.halfKomi}`); tei('teinewgame 6'); halfKomi = j.halfKomi; }
  if (multipv !== j.lines) { tei(`setoption name MultiPV value ${j.lines}`); multipv = j.lines; }
  errs = [];
  tei(`position tps ${j.tps}`); // (one it can't parse is a warning only, and it would search the last one)
  if (errs.length) throw new Error('syntaks rejected the position: ' + errs[0]);
  for (let i = 0; job === j; i++) {
    if (since() >= IDLE && j.long - since() > 10) { await new Promise((r) => setTimeout(r, 40)); continue; } // (the long one must wait: no work meanwhile)
    const by = new Map();
    let here = 0;
    const say = (type) => { fresh = false; posted = performance.now(); self.postMessage({ type, id: j.id, infos: best || [], depth, nodes: nodes + here, ms: Math.round(since()), kns }); };
    // Each search begins again at depth 1: a set counts from the depth already shown, and at that depth only if it has more
    // lines of it (the same depth searched again only swaps near-equal moves). One still being searched, part of it from the
    // depth before, waits for its other lines, unless it is the last word. A move appears once; what is missing is filled
    // from the last set.
    const take = (last) => {
      const set = [...by.keys()].sort((a, b) => a - b).map((k) => by.get(k)), n = set.filter((x) => x.depth === set[0].depth).length;
      if (!set.length || set[0].depth < depth || set[0].depth === depth && n <= full || best && !last && n < Math.min(j.lines, best.length)) return;
      depth = set[0].depth; full = n; fresh = true;
      best = [...set.filter((x) => x.depth === depth), ...(best || []), ...set].filter((x, k, all) => all.findIndex((y) => y.pv[0] === x.pv[0]) === k).slice(0, j.lines);
      if ((long || performance.now() - posted >= EVERY) && (depth >= FIRST_DEPTH || since() >= FIRST_MS)) say('lines');
    };
    const ended = () => {
      const mates = best?.map((x) => x.mate).filter((x) => x != null) || [];
      return mates.length && (mates.length === best.length && depth >= 2 * Math.max(...mates.map(Math.abs)) || best[0].mate != null && depth >= 2 * Math.abs(best[0].mate) && since() >= MATE_MS) || depth >= DEEP && best[0].mate == null || nodes - shorts + here >= j.nodes;
    };
    const left = j.ms - since(), long = since() >= j.long && left > 2 * CHUNKS.at(-1);
    heard = 0;
    onLine = (l) => {
      const x = infoOf(l);
      if (!x) return;
      here = x.nodes;
      if (x.bound) return;
      if (x.multipv === 1 && by.size && by.size < j.lines) take();
      by.set(x.multipv, x);
      if (x.multipv === j.lines) take();
      if (long && ended()) skew += 1e11; // (100 s)
    };
    if (long) { // (from a clean hash: what the short ones left in it made the same depth less right)
      self.postMessage({ type: 'long', id: j.id, ms: left });
      tei('teinewgame 6'); tei(`position tps ${j.tps}`);
      full = 0; shorts = nodes; // (its own answer at the depth shown counts, and only its own nodes)
    }
    try { tei((long ? `go nodes ${j.nodes} movetime ` : 'go movetime ') + Math.max(10, Math.round(long ? left : Math.min(CHUNKS[Math.min(i, CHUNKS.length - 1)], left)))); } finally { onLine = null; }
    take(long || j.ms - since() < 10 || nodes - shorts + here >= j.nodes);
    nodes += here; here = 0;
    if (i === 2) kns = nodes / since(); // (how fast this machine is: later searches repeat work the hash already has)
    if (fresh && depth >= FIRST_DEPTH && performance.now() - posted >= EVERY) say('lines');
    if (ended() || j.ms - since() < 10) { if (job === j) { job = null; say('done'); } return; }
    await new Promise((r) => setTimeout(r));
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    booted = WebAssembly.instantiate(data.module, { wasi_snapshot_preview1: wasi }).then((i) => {
      ex = i.exports;
      ex._initialize?.();
      tei('tei'); // (the hash the engine starts with takes the same memory)
      tei('setoption name Hash value 32'); tei('setoption name MateScores value true'); tei('setoption name HumanWDL value true');
      self.postMessage({ type: 'ready' });
    }).catch((e) => { job = null; self.postMessage({ type: 'error', error: String(e.message || e) }); });
    return;
  }
  booted?.then(() => self.postMessage({ type: 'heard', n: data.n })); // (no answer until it can search)
  job = data.type === 'go' ? data : null;
  if (running) return; // (the search running sees it)
  running = true;
  await booted;
  while (job) {
    const j = job;
    try { await search(j); } catch (e) { self.postMessage({ type: 'error', id: j.id, error: String(e.message || e) }); if (job === j) job = null; }
  }
  running = false;
};
