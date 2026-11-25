// Share links for chat apps: GET /p/<id> is a tiny page whose Open Graph tags Discord (and Slack, iMessage…) turn
// into an embed, then sends people on to the puzzle; GET /p/<id>.png is the board picture for that embed.
// The picture is drawn here with no dependencies: polygons into an RGBA buffer at 3× and averaged down, then PNG.
import zlib from 'node:zlib';
import { Game, WALL, CAP, colorOf, typeOf } from '../shared/tak.js';
import { unplayedPlies } from '../shared/ptn.js';

// Colors from public/board.css's felt board (--b1 the cloth, --thread its seams, --b3 the tray, --p1/--p2 flats,
// --p1s/--p2s walls+caps, borders, --pri the last move's thread).
export const C = {
  b1: [74, 103, 97], thread: [143, 169, 161], pri: [227, 211, 161],
  p1: [236, 231, 219], p1s: [245, 241, 232], p1b: [154, 148, 138],
  p2: [21, 27, 26], p2s: [29, 37, 36], p2b: [95, 107, 103], shadow: [0, 0, 0],
  b3: [52, 75, 70],
};
const SS = 3; // supersampling factor
const SP = 0.07; // stack step, fraction of a square (board.js SP = 7%)
// board.css, in fractions of a square: the running stitches between squares (.tb-sq::before: dashes 5.5% long every
// 10%, 1.3% wide, at .7), the last move's thread (.tb-cur: a box inset 7% with 6% corners; on a square moved to or
// placed on a solid line 3.8% wide and a 14% wash, on the square moved from a dashed one 2.5% wide, 3% inside, at .65),
// and the stones (52% of a square, 13% corners; walls 19% wide)
export const SEAM = { dash: 0.055, period: 0.1, width: 0.013, alpha: 0.7 };
export const LAST = { inset: 0.07, radius: 0.06, ring: 0.038, wash: 0.14, dashed: 0.025, offset: 0.03, faint: 0.65 };
export const STONE = { size: 0.52, radius: 0.13, wall: 0.19, umbra: 0.3 };

function canvas(w, h) {
  const W = w * SS, H = h * SS;
  const px = new Float32Array(W * H * 3);
  return {
    w, h, W, H, px,
    fill(rgb) { for (let i = 0; i < W * H; i++) { px[i * 3] = rgb[0]; px[i * 3 + 1] = rgb[1]; px[i * 3 + 2] = rgb[2]; } },
    // even-odd scanline fill of a polygon given in output pixels; alpha blends over what is there
    poly(pts, rgb, a = 1) {
      const P = pts.map(([x, y]) => [x * SS, y * SS]);
      let y0 = Infinity, y1 = -Infinity;
      for (const [, y] of P) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H - 1, Math.ceil(y1));
      for (let y = y0; y <= y1; y++) {
        const yc = y + 0.5, xs = [];
        for (let i = 0; i < P.length; i++) {
          const [ax, ay] = P[i], [bx, by] = P[(i + 1) % P.length];
          if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
          for (let x = xa; x <= xb; x++) {
            const o = (y * W + x) * 3;
            px[o] += (rgb[0] - px[o]) * a; px[o + 1] += (rgb[1] - px[o + 1]) * a; px[o + 2] += (rgb[2] - px[o + 2]) * a;
          }
        }
      }
    },
    rect(x, y, w, h, rgb, a) { this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], rgb, a); },
    png() {
      const raw = Buffer.alloc((w * 3 + 1) * h);
      for (let y = 0; y < h; y++) {
        raw[y * (w * 3 + 1)] = 0;
        for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) s += px[((y * SS + dy) * W + x * SS + dx) * 3 + c];
          raw[y * (w * 3 + 1) + 1 + x * 3 + c] = Math.max(0, Math.min(255, Math.round(s / (SS * SS))));
        }
      }
      const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
      return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
    },
  };
}

const roundRect = (x, y, w, h, r, seg = 5) => {
  const pts = [];
  const corner = (cx, cy, a0) => { for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * (Math.PI / 2); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  corner(x + w - r, y + r, -Math.PI / 2); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, Math.PI / 2); corner(x + r, y + r, Math.PI);
  return pts;
};
const circle = (cx, cy, r, seg = 48) => Array.from({ length: seg }, (_, i) => [cx + r * Math.cos((i / seg) * 2 * Math.PI), cy + r * Math.sin((i / seg) * 2 * Math.PI)]);
const rotate = (pts, cx, cy, deg) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
};
const shift = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy]);

// Squares a PTN move touched (for the last-move tint): a placement's square, or a spread's source and drop squares.
function touched(ptn, size) {
  const m = /^([FSC]?)([a-h])([1-8])$/.exec(ptn) || /^(\d?)([a-h])([1-8])([<>+-])(\d*)\*?$/.exec(ptn);
  if (!m) return [];
  const f = m[2].charCodeAt(0) - 97, r = +m[3] - 1;
  if (!m[4]) return [[f, r]];
  const [df, dr] = { '>': [1, 0], '<': [-1, 0], '+': [0, 1], '-': [0, -1] }[m[4]];
  const n = m[5] ? m[5].length : 1;
  return Array.from({ length: n + 1 }, (_, i) => [f + df * i, r + dr * i]).filter(([a, b]) => a >= 0 && b >= 0 && a < size && b < size);
}

// One stone at (sx, sy) of side s, in tinue's style: flat (rounded square), wall (rotated slab) or cap (disc).
function stone(cv, sx, sy, s, col, ty, q) {
  const fill = col === 1 ? C.p1 : C.p2, strong = col === 1 ? C.p1s : C.p2s, edge = col === 1 ? C.p1b : C.p2b;
  const bw = Math.max(1, 0.013 * q), cx = sx + s / 2, cy = sy + s / 2, um = STONE.umbra;
  if (ty === WALL) {
    const w = (STONE.wall / STONE.size) * s, wx = cx - w / 2, rot = col === 1 ? -45 : 45;
    const body = roundRect(wx, sy, w, s, w * 0.36);
    cv.poly(rotate(shift(body, col === 1 ? -0.02 * q : 0.02 * q, 0.03 * q), cx, cy, rot), C.shadow, um);
    cv.poly(rotate(body, cx, cy, rot), edge);
    cv.poly(rotate(roundRect(wx + bw, sy + bw, w - 2 * bw, s - 2 * bw, w * 0.3), cx, cy, rot), strong);
  } else if (ty === CAP) {
    cv.poly(circle(cx, cy + 0.03 * q, s / 2), C.shadow, um);
    cv.poly(circle(cx, cy, s / 2), edge);
    cv.poly(circle(cx, cy, s / 2 - bw), strong);
  } else {
    const r = STONE.radius * s;
    cv.poly(roundRect(sx, sy + 0.03 * q, s, s, r), C.shadow, um);
    cv.poly(roundRect(sx, sy, s, s, r), edge);
    cv.poly(roundRect(sx + bw, sy + bw, s - 2 * bw, s - 2 * bw, Math.max(0, r - bw)), fill);
  }
}

const TRAY = 0.75; // tray height, in squares
export const imageSize = (n, px = 600) => ({ width: px, height: px + Math.round((TRAY * px) / n) });

// A ring: the band between two round rectangles, as one polygon: the outer contour closed, then the inner one closed
// and reversed, so the even-odd fill leaves the hole and the two edges joining them lie on one segment and cancel out
// (left open, each contour lost its closing edge, the top one, and the ring had no top: test-felt-board holds it).
const ring = (x, y, w, h, r, t) => {
  const o = roundRect(x, y, w, h, r), i = roundRect(x + t, y + t, w - 2 * t, h - 2 * t, Math.max(0, r - t));
  return [...o, o[0], i[0], ...i.slice(1).reverse(), i[0]];
};

// The puzzle's board as tinue draws it (the felt, its stitched seams, the last move's thread), plus a tray underneath:
// each side's stones and capstones in hand, with a bar over the side to move.
export function boardPng(p, px = 600) {
  const g = Game.fromTPS(p.tps, p.komi || 0);
  const n = g.size, q = px / n;
  const { height } = imageSize(n, px);
  const cv = canvas(px, height);
  cv.fill(C.b3);
  cv.rect(0, 0, px, px, C.b1);
  // running stitches between the squares, none on the board's edge
  const sw = Math.max(1, SEAM.width * q), dash = SEAM.dash * q, per = SEAM.period * q;
  for (let k = 1; k < n; k++) for (let t = 0; t < px - 0.5; t += per) {
    cv.rect(k * q, t, sw, Math.min(dash, px - t), C.thread, SEAM.alpha); // a seam down
    cv.rect(t, k * q - sw, Math.min(dash, px - t), sw, C.thread, SEAM.alpha); // a seam across
  }
  // the last move: a solid thread and a faint wash round the square moved to (or placed on), a dashed faint one round
  // the square moved from (touched() lists a spread's source first)
  let meta = {}; try { meta = JSON.parse(p.meta || '{}'); } catch {}
  const sqs = touched(meta.lastMove || '', n);
  sqs.forEach(([f, r], i) => {
    const x = f * q + LAST.inset * q, y = (n - 1 - r) * q + LAST.inset * q, w = (1 - 2 * LAST.inset) * q, rr = LAST.radius * q;
    if (i > 0 || sqs.length === 1) {
      cv.poly(roundRect(x, y, w, w, rr), C.pri, LAST.wash);
      cv.poly(ring(x, y, w, w, rr, LAST.ring * q), C.pri);
      return;
    }
    const o = LAST.offset * q, t = LAST.dashed * q, a = x + o, b = w - 2 * o, d = 3 * t, gap = 2 * t;
    for (let u = 0; u < b; u += d + gap) {
      const L = Math.min(d, b - u);
      cv.rect(a + u, y + o, L, t, C.pri, LAST.faint); cv.rect(a + u, y + o + b - t, L, t, C.pri, LAST.faint);
      cv.rect(a, y + o + u, t, L, C.pri, LAST.faint); cv.rect(a + b - t, y + o + u, t, L, C.pri, LAST.faint);
    }
  });
  for (let sq = 0; sq < n * n; sq++) {
    const stack = g.board[sq];
    if (!stack.length) continue;
    const f = sq % n, r = Math.floor(sq / n);
    const x0 = f * q, y0 = (n - 1 - r) * q;
    const show = stack.slice(-Math.max(1, n)); // like board.js, at most n stones drawn per stack
    const base = show.length > 1 ? -SP * 0.5 * (show.length - 1) : 0; // keep tall stacks inside their square
    show.forEach((pc, z) => {
      const top = z === show.length - 1;
      const lift = (z * SP + base) * q;
      const m = (1 - STONE.size) / 2;
      stone(cv, x0 + m * q, y0 + m * q - lift, STONE.size * q, colorOf(pc), top ? typeOf(pc) : 0, q);
    });
  }
  // tray, like tinue's: each side's stones in hand as an overlapping row, capstones at the end (White left, Black
  // right), and a bar over the side to move
  const th = height - px, mid = px + th / 2, st = 0.46 * th, pad = 0.25 * th;
  for (const col of [1, 2]) {
    const x0 = col === 1 ? 0 : px / 2, nf = g.stones[col], nc = g.caps[col];
    if (g.toMove === col) cv.rect(x0, px, px / 2, Math.max(3, 0.07 * th), C.pri);
    const capsW = nc ? nc * st + (nc - 1) * 0.15 * st + 0.35 * st : 0;
    const room = px / 2 - 2 * pad - capsW - st;
    const step = nf > 1 ? Math.min(0.62 * st, room / (nf - 1)) : 0;
    let x = x0 + pad;
    for (let k = 0; k < nf; k++) stone(cv, x + k * step, mid - st / 2, st, col, 0, q);
    x += (nf ? (nf - 1) * step + st : 0) + 0.35 * st;
    for (let k = 0; k < nc; k++) stone(cv, x + k * 1.15 * st, mid - st / 2, st, col, CAP, q);
  }
  return cv.png();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Words for the embed: who moves, board, komi and the game's last few moves. Nothing about the solution: not its
// length, and not whether it's a road or a flat win (both would give part of the puzzle away). When the history ends in
// a line the game never played (unplayedPlies: a dragon sub-position), those aren't the game's last moves, so they
// are called a line and only its moves are listed (its last four at most).
export function shareText(p) {
  const side = p.tps.trim().split(/\s+/)[1] === '2' ? 'Black' : 'White';
  const title = `${side} to play: find the win`;
  let meta = {}; try { meta = typeof p.meta === 'string' ? JSON.parse(p.meta || '{}') : p.meta || {}; } catch {}
  const h = Array.isArray(meta.history) ? meta.history : [];
  const off = unplayedPlies(meta);
  let last = '';
  if (h.length) {
    const from = Math.max(0, h.length - (off ? Math.min(off, 4) : 4));
    last = h.slice(from).map((m, k) => { const i = from + k; return (i % 2 === 0 ? `${i / 2 + 1}. ` : k === 0 ? `${(i + 1) / 2}… ` : '') + m; }).join(' ');
  }
  const desc = [`${p.size}×${p.size}`, p.komi ? `komi ${p.komi}` : null, last ? (off ? `a line not played in the game, ending ${last}` : `last moves ${last}`) : null].filter(Boolean).join(' · ');
  return { title, desc };
}

export function sharePage(p, { shareUrl, imageUrl, puzzleUrl }) {
  const { title, desc } = shareText(p);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · tinue</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="tinue · Tak puzzles">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(shareUrl)}">
<meta property="og:image" content="${esc(imageUrl)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${imageSize(p.size).width}">
<meta property="og:image:height" content="${imageSize(p.size).height}">
<meta property="og:image:alt" content="${esc(`Tak board, ${p.size}×${p.size}, ${title}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#9cb83a">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${esc(puzzleUrl)}">
</head><body style="font-family:system-ui,sans-serif;background:#262421;color:#e8e6e3;padding:24px">
<p><a style="color:#9cb83a" href="${esc(puzzleUrl)}">${esc(title)}</a></p>
<script>location.replace(${JSON.stringify(puzzleUrl)}.replace('#', location.search + '#'))</script>
</body></html>`;
}
