// TEI (Tak's UCI) engine output: `info` lines, and the lines of a MultiPV search. Used by server/syntaks.js.
//
//   parseInfo('info depth 9 multipv 2 score cp 31 wdl 400 300 300 nodes 812 pv c3 d4')
//     -> { multipv: 2, depth: 9, nodes: 812, cp: 31, mate: null, bound: false, wdl: [400, 300, 300], pv: ['c3', 'd4'] }
//   Numbers are from the side to move, as the engine prints them. null for a line with no score (info string, currmove).

export function parseInfo(line) {
  const t = line.trim().split(/\s+/), get = (k) => { const i = t.indexOf(k); return i < 0 ? null : t[i + 1]; };
  if (t[0] !== 'info' || t[1] === 'string') return null; // (free text: a 'score' in it isn't one)
  const s = t.indexOf('score');
  if (s < 0) return null;
  // A score without its kind or number (cut short) is no line: kept, it would replace the last exact one with nothing.
  if ((t[s + 1] !== 'cp' && t[s + 1] !== 'mate') || !Number.isFinite(+t[s + 2])) return null;
  const pvAt = t.indexOf('pv'), wdlAt = t.indexOf('wdl');
  return {
    multipv: +get('multipv') || 1, // an engine without MultiPV (or with MultiPV 1) may leave it out: that is line 1
    depth: +get('depth') || 0, nodes: +get('nodes') || 0,
    cp: t[s + 1] === 'cp' ? +t[s + 2] : null, mate: t[s + 1] === 'mate' ? +t[s + 2] : null,
    bound: t.includes('lowerbound') || t.includes('upperbound'),
    wdl: wdlAt < 0 ? null : t.slice(wdlAt + 1, wdlAt + 4).map(Number),
    pv: pvAt < 0 ? [] : t.slice(pvAt + 1),
  };
}

// Per MultiPV index, the newest line (`last`) and the newest exact one (`exact`, not a lowerbound/upperbound from an
// iteration cut short). byIdx: a Map, index -> { last, exact }.
export function keepLine(byIdx, info) {
  const e = byIdx.get(info.multipv) || { last: null, exact: null };
  e.last = info;
  if (!info.bound) e.exact = info;
  byIdx.set(info.multipv, e);
  return byIdx;
}

// The search's lines, best first: per index the last exact line (else the last one). A search stopped mid-iteration
// can leave line 2 at an older depth than line 1, so a line whose first move an earlier line already plays (the new
// best was the old runner-up) is dropped: each move appears once.
export function bestLines(byIdx) {
  const seen = new Set(), out = [];
  for (const k of [...byIdx.keys()].sort((a, b) => a - b)) {
    const info = byIdx.get(k).exact || byIdx.get(k).last;
    const first = info.pv[0];
    if (first != null && seen.has(first)) continue;
    if (first != null) seen.add(first);
    out.push(info);
  }
  return out;
}
