//! Rules layer: 6x6 Tak on bitboards (SOLVER.md section 1).
//!
//! Ground truth is shared/tak.js: same square numbering (sq = row*6 + col, a1 = 0), the opening
//! swap (first two plies place the opponent's flat), wall smashing by a lone capstone, the dragon
//! clause (the mover wins a double road), flat wins when the board is full or either side is out of
//! pieces, scored f_white - f_black - komi.
//!
//! A stack is a u64 of colours from the bottom (bit i = 1 if the piece at height i is Black) plus a
//! height; only the top piece can be a wall or a capstone, so piece types live in two bitboards.

pub const N: usize = 6;
pub const NN: usize = N * N;
pub const BOARD: u64 = (1u64 << NN) - 1;
pub const START_STONES: u8 = 30;
pub const START_CAPS: u8 = 1;
pub const MAXH: usize = 64;

pub type Move = u16;
pub const FLAT: u16 = 0;
pub const WALL: u16 = 1;
pub const CAP: u16 = 2;
pub const NO_MOVE: Move = 0xffff;

const fn file_mask(c: usize) -> u64 {
    let mut m = 0u64;
    let mut r = 0;
    while r < N {
        m |= 1u64 << (r * N + c);
        r += 1;
    }
    m
}
const fn rank_mask(r: usize) -> u64 {
    ((1u64 << N) - 1) << (r * N)
}
pub const FILE_A: u64 = file_mask(0);
pub const FILE_LAST: u64 = file_mask(N - 1);
pub const SOUTH: u64 = rank_mask(0);
pub const NORTH: u64 = rank_mask(N - 1);
pub const WEST: u64 = FILE_A;
pub const EAST: u64 = FILE_LAST;
pub const RANKS: [u64; N] = {
    let mut a = [0u64; N];
    let mut i = 0;
    while i < N {
        a[i] = rank_mask(i);
        i += 1;
    }
    a
};
pub const FILES: [u64; N] = {
    let mut a = [0u64; N];
    let mut i = 0;
    while i < N {
        a[i] = file_mask(i);
        i += 1;
    }
    a
};

/// Directions in PTN order of tak.js DIRS: 0 '+' (up a rank), 1 '-', 2 '>' (next file), 3 '<'.
pub const DIR_CH: [char; 4] = ['+', '-', '>', '<'];

const fn step(sq: usize, d: usize) -> i32 {
    let r = sq / N;
    let c = sq % N;
    match d {
        0 => {
            if r + 1 < N {
                (sq + N) as i32
            } else {
                -1
            }
        }
        1 => {
            if r > 0 {
                (sq - N) as i32
            } else {
                -1
            }
        }
        2 => {
            if c + 1 < N {
                (sq + 1) as i32
            } else {
                -1
            }
        }
        _ => {
            if c > 0 {
                (sq - 1) as i32
            } else {
                -1
            }
        }
    }
}

/// Precomputed rays: the squares from a source outward, prefix masks, and "deposit" masks (a bit
/// pattern over the first five ray squares mapped to a bitboard).
pub struct Rays {
    pub sq: [[[u8; N - 1]; 4]; NN],
    pub len: [[u8; 4]; NN],
    pub mask: [[[u64; N]; 4]; NN],
    pub dep: [[[u64; 1 << (N - 1)]; 4]; NN],
}
const fn build_rays() -> Rays {
    let mut r = Rays { sq: [[[0; N - 1]; 4]; NN], len: [[0; 4]; NN], mask: [[[0; N]; 4]; NN], dep: [[[0; 1 << (N - 1)]; 4]; NN] };
    let mut s = 0;
    while s < NN {
        let mut d = 0;
        while d < 4 {
            let mut n = 0;
            let mut x = step(s, d);
            let mut m = 0u64;
            while x >= 0 {
                r.sq[s][d][n] = x as u8;
                m |= 1u64 << x;
                n += 1;
                r.mask[s][d][n] = m;
                x = step(x as usize, d);
            }
            r.len[s][d] = n as u8;
            let mut bits = 0;
            while bits < (1 << (N - 1)) {
                let mut dm = 0u64;
                let mut i = 0;
                while i < n {
                    if bits & (1 << i) != 0 {
                        dm |= 1u64 << r.sq[s][d][i];
                    }
                    i += 1;
                }
                r.dep[s][d][bits] = dm;
                bits += 1;
            }
            d += 1;
        }
        s += 1;
    }
    r
}
pub static RAYS: Rays = build_rays();

/// Drop patterns. A pattern for carry k is a k-bit mask m whose bit j is set when hand piece j
/// (from the bottom of the hand) is the last piece dropped on its square; bit k-1 is always set.
/// popcount(m) is the number of squares, and the set bits are exactly the hand pieces that end up
/// on top of a destination square. Index: (1 << (k-1)) - 1 + low bits of m.
pub const NPAT: usize = (1 << N) - 1;
pub struct Pats {
    pub k: [u8; NPAT],
    pub m: [u8; NPAT],
    pub nsq: [u8; NPAT],
    pub drops: [[u8; N]; NPAT],
    pub last1: [bool; NPAT],
    /// pext[hand][pat]: the bits of `hand` at the positions of pattern pat's mask, packed.
    pub pext: [[u8; NPAT]; 1 << N],
}
const fn build_pats() -> Pats {
    let mut p = Pats { k: [0; NPAT], m: [0; NPAT], nsq: [0; NPAT], drops: [[0; N]; NPAT], last1: [false; NPAT], pext: [[0; NPAT]; 1 << N] };
    let mut k = 1;
    while k <= N {
        let mut low = 0;
        while low < (1 << (k - 1)) {
            let idx = (1 << (k - 1)) - 1 + low;
            let m = low | (1 << (k - 1));
            p.k[idx] = k as u8;
            p.m[idx] = m as u8;
            let mut run = 0;
            let mut n = 0;
            let mut j = 0;
            while j < k {
                run += 1;
                if m & (1 << j) != 0 {
                    p.drops[idx][n] = run;
                    n += 1;
                    run = 0;
                }
                j += 1;
            }
            p.nsq[idx] = n as u8;
            p.last1[idx] = k == 1 || (m >> (k - 2)) & 1 == 1;
            let mut hand = 0;
            while hand < (1 << N) {
                let mut out = 0u8;
                let mut o = 0;
                let mut j = 0;
                while j < k {
                    if m & (1 << j) != 0 {
                        if hand & (1 << j) != 0 {
                            out |= 1 << o;
                        }
                        o += 1;
                    }
                    j += 1;
                }
                p.pext[hand][idx] = out;
                hand += 1;
            }
            low += 1;
        }
        k += 1;
    }
    p
}
pub static PATS: Pats = build_pats();

#[inline]
pub fn pat_range(k: usize) -> std::ops::Range<usize> {
    ((1 << (k - 1)) - 1)..((1 << k) - 1)
}

const fn splitmix(s: u64) -> (u64, u64) {
    let s = s.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = s;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    (s, z ^ (z >> 31))
}
/// Zobrist words from independent splitmix64 outputs.
pub struct Zob {
    pub p: [[[u64; 2]; MAXH]; NN],
    pub t: [[u64; 3]; NN],
    pub side: u64,
    pub att: u64,
    pub komi: u64,
}
const fn build_zob() -> Zob {
    let mut z = Zob { p: [[[0; 2]; MAXH]; NN], t: [[0; 3]; NN], side: 0, att: 0, komi: 0 };
    let mut s = 0x7461_6b5f_6465_6570u64;
    let mut sq = 0;
    while sq < NN {
        let mut h = 0;
        while h < MAXH {
            let (s1, a) = splitmix(s);
            let (s2, b) = splitmix(s1);
            s = s2;
            z.p[sq][h][0] = a;
            z.p[sq][h][1] = b;
            h += 1;
        }
        let (s1, a) = splitmix(s);
        let (s2, b) = splitmix(s1);
        s = s2;
        z.t[sq][1] = a;
        z.t[sq][2] = b;
        sq += 1;
    }
    let (s1, a) = splitmix(s);
    let (s2, b) = splitmix(s1);
    let (_, c) = splitmix(s2);
    z.side = a;
    z.att = b;
    z.komi = c;
    z
}
pub static ZOB: Zob = build_zob();

#[inline]
pub fn nbr(b: u64) -> u64 {
    ((b << N) | (b >> N) | ((b << 1) & !FILE_A) | ((b >> 1) & !FILE_LAST)) & BOARD
}
/// Squares of `r` connected to `seed` within `r`.
#[inline]
pub fn flood(r: u64, seed: u64) -> u64 {
    let mut x = seed & r;
    loop {
        let y = (x | nbr(x)) & r;
        if y == x {
            return x;
        }
        x = y;
    }
}
/// Does the road set contain a spanning road?
#[inline]
pub fn has_road_set(r: u64) -> bool {
    if r & SOUTH != 0 && r & NORTH != 0 {
        let mut x = r & SOUTH;
        loop {
            if x & NORTH != 0 {
                return true;
            }
            let y = (x | nbr(x)) & r;
            if y == x {
                break;
            }
            x = y;
        }
    }
    if r & WEST != 0 && r & EAST != 0 {
        let mut x = r & WEST;
        loop {
            if x & EAST != 0 {
                return true;
            }
            let y = (x | nbr(x)) & r;
            if y == x {
                break;
            }
            x = y;
        }
    }
    false
}

#[inline]
pub fn is_spread(m: Move) -> bool {
    m & 0x8000 != 0
}
#[inline]
pub fn mv_sq(m: Move) -> usize {
    (m & 63) as usize
}
#[inline]
pub fn mv_place(sq: usize, t: u16) -> Move {
    (t << 6) | sq as u16
}
#[inline]
pub fn mv_spread(sq: usize, dir: usize, pat: usize) -> Move {
    0x8000 | ((pat as u16) << 8) | ((dir as u16) << 6) | sq as u16
}
#[inline]
pub fn mv_type(m: Move) -> u16 {
    (m >> 6) & 3
}
#[inline]
pub fn mv_dir(m: Move) -> usize {
    ((m >> 6) & 3) as usize
}
#[inline]
pub fn mv_pat(m: Move) -> usize {
    ((m >> 8) & 63) as usize
}
/// Squares a move touches: the placement square, or the source plus every square it drops on.
#[inline]
pub fn mv_squares(m: Move) -> u64 {
    let sq = mv_sq(m);
    if !is_spread(m) {
        return 1u64 << sq;
    }
    (1u64 << sq) | RAYS.mask[sq][mv_dir(m)][PATS.nsq[mv_pat(m)] as usize]
}
#[inline]
fn low(n: usize) -> u64 {
    if n >= 64 {
        !0
    } else {
        (1u64 << n) - 1
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct End {
    /// 0 White, 1 Black, 2 draw
    pub winner: u8,
    pub road: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Undo {
    pub key: u64,
    pub smash: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Board {
    pub st: [u64; NN],
    pub h: [u8; NN],
    pub own: [u64; 2],
    pub wall: u64,
    pub cap: u64,
    pub stones: [u8; 2],
    pub caps: [u8; 2],
    /// side to move: 0 White, 1 Black
    pub stm: u8,
    /// half-moves since the game start (only the opening swap rule reads it)
    pub ply: u32,
    pub halfkomi: i32,
    pub key: u64,
}

impl Default for Board {
    fn default() -> Self {
        Self::new()
    }
}

impl Board {
    pub fn new() -> Board {
        Board { st: [0; NN], h: [0; NN], own: [0; 2], wall: 0, cap: 0, stones: [START_STONES; 2], caps: [START_CAPS; 2], stm: 0, ply: 0, halfkomi: 0, key: 0 }
    }
    #[inline]
    pub fn occ(&self) -> u64 {
        self.own[0] | self.own[1]
    }
    #[inline]
    pub fn empty(&self) -> u64 {
        !self.occ() & BOARD
    }
    #[inline]
    pub fn reserves(&self, c: usize) -> u32 {
        self.stones[c] as u32 + self.caps[c] as u32
    }
    #[inline]
    pub fn road(&self, c: usize) -> u64 {
        self.own[c] & !self.wall
    }
    #[inline]
    pub fn top_type(&self, sq: usize) -> u16 {
        let b = 1u64 << sq;
        if self.wall & b != 0 {
            WALL
        } else if self.cap & b != 0 {
            CAP
        } else {
            FLAT
        }
    }
    #[inline]
    pub fn pass(&mut self) {
        self.stm ^= 1;
        self.key ^= ZOB.side;
    }
    /// Recompute the Zobrist key from scratch (tests).
    pub fn compute_key(&self) -> u64 {
        let mut k = 0u64;
        for sq in 0..NN {
            for j in 0..self.h[sq] as usize {
                k ^= ZOB.p[sq][j][((self.st[sq] >> j) & 1) as usize];
            }
            if self.h[sq] > 0 {
                k ^= ZOB.t[sq][self.top_type(sq) as usize];
            }
        }
        if self.stm == 1 {
            k ^= ZOB.side;
        }
        k
    }
    #[inline]
    fn set_own(&mut self, sq: usize) {
        let b = 1u64 << sq;
        self.own[0] &= !b;
        self.own[1] &= !b;
        let h = self.h[sq] as usize;
        if h > 0 {
            self.own[((self.st[sq] >> (h - 1)) & 1) as usize] |= b;
        }
    }

    pub fn make(&mut self, m: Move) -> Undo {
        let u = Undo { key: self.key, smash: false };
        let sq = mv_sq(m);
        if !is_spread(m) {
            let t = mv_type(m);
            let col = if self.ply < 2 { 1 - self.stm as usize } else { self.stm as usize };
            let b = 1u64 << sq;
            self.st[sq] = col as u64;
            self.h[sq] = 1;
            self.own[col] |= b;
            if t == WALL {
                self.wall |= b;
            } else if t == CAP {
                self.cap |= b;
            }
            if t == CAP {
                self.caps[col] -= 1;
            } else {
                self.stones[col] -= 1;
            }
            self.key ^= ZOB.p[sq][0][col] ^ ZOB.t[sq][t as usize];
            self.stm ^= 1;
            self.ply += 1;
            self.key ^= ZOB.side;
            return u;
        }
        let mut smash = false;
        let dir = mv_dir(m);
        let pat = mv_pat(m);
        let k = PATS.k[pat] as usize;
        let nsq = PATS.nsq[pat] as usize;
        let hs = self.h[sq] as usize;
        let s = self.st[sq];
        let srct = self.top_type(sq);
        let base = hs - k;
        let mut key = self.key;
        for j in base..hs {
            key ^= ZOB.p[sq][j][((s >> j) & 1) as usize];
        }
        key ^= ZOB.t[sq][srct as usize];
        let mut hand = s >> base;
        self.st[sq] = s & low(base);
        self.h[sq] = base as u8;
        let sb = 1u64 << sq;
        self.wall &= !sb;
        self.cap &= !sb;
        self.set_own(sq);
        let ray = &RAYS.sq[sq][dir];
        for i in 0..nsq {
            let d = PATS.drops[pat][i] as usize;
            let ds = ray[i] as usize;
            let db = 1u64 << ds;
            let dh = self.h[ds] as usize;
            if self.wall & db != 0 {
                self.wall &= !db;
                key ^= ZOB.t[ds][WALL as usize];
                smash = true;
            }
            let pieces = hand & low(d);
            hand >>= d;
            for j in 0..d {
                key ^= ZOB.p[ds][dh + j][((pieces >> j) & 1) as usize];
            }
            self.st[ds] |= pieces << dh;
            self.h[ds] = (dh + d) as u8;
            self.set_own(ds);
            if i == nsq - 1 && srct != FLAT {
                if srct == WALL {
                    self.wall |= db;
                } else {
                    self.cap |= db;
                }
                key ^= ZOB.t[ds][srct as usize];
            }
        }
        self.key = key ^ ZOB.side;
        self.stm ^= 1;
        self.ply += 1;
        Undo { key: u.key, smash }
    }

    pub fn unmake(&mut self, m: Move, u: Undo) {
        self.stm ^= 1;
        self.ply -= 1;
        self.key = u.key;
        let sq = mv_sq(m);
        if !is_spread(m) {
            let t = mv_type(m);
            let col = if self.ply < 2 { 1 - self.stm as usize } else { self.stm as usize };
            let b = 1u64 << sq;
            self.st[sq] = 0;
            self.h[sq] = 0;
            self.own[col] &= !b;
            self.wall &= !b;
            self.cap &= !b;
            if t == CAP {
                self.caps[col] += 1;
            } else {
                self.stones[col] += 1;
            }
            return;
        }
        let dir = mv_dir(m);
        let pat = mv_pat(m);
        let k = PATS.k[pat] as usize;
        let nsq = PATS.nsq[pat] as usize;
        let ray = &RAYS.sq[sq][dir];
        let last = ray[nsq - 1] as usize;
        let lb = 1u64 << last;
        let srct = if self.wall & lb != 0 {
            WALL
        } else if self.cap & lb != 0 {
            CAP
        } else {
            FLAT
        };
        self.wall &= !lb;
        self.cap &= !lb;
        let mut hand = 0u64;
        for i in (0..nsq).rev() {
            let d = PATS.drops[pat][i] as usize;
            let ds = ray[i] as usize;
            let dh = self.h[ds] as usize - d;
            let pieces = (self.st[ds] >> dh) & low(d);
            self.st[ds] &= low(dh);
            self.h[ds] = dh as u8;
            hand = (hand << d) | pieces;
            if i == nsq - 1 && u.smash {
                self.wall |= 1u64 << ds;
            }
            self.set_own(ds);
        }
        let base = self.h[sq] as usize;
        self.st[sq] |= hand << base;
        self.h[sq] = (base + k) as u8;
        let sb = 1u64 << sq;
        if srct == WALL {
            self.wall |= sb;
        } else if srct == CAP {
            self.cap |= sb;
        }
        self.set_own(sq);
    }

    /// Free squares from `sq` in direction `dir` before an edge, wall or capstone, and whether the
    /// next square is a wall a capstone on `sq` could smash.
    #[inline]
    pub fn reach(&self, sq: usize, dir: usize) -> (usize, bool) {
        let len = RAYS.len[sq][dir] as usize;
        let ray = &RAYS.sq[sq][dir];
        let blk = self.wall | self.cap;
        let mut dist = 0;
        while dist < len {
            let b = 1u64 << ray[dist];
            if blk & b != 0 {
                return (dist, self.cap & (1u64 << sq) != 0 && self.wall & b != 0);
            }
            dist += 1;
        }
        (dist, false)
    }

    /// Legal spreads of stack `sq` in direction `dir` (the stack must be the mover's).
    #[inline]
    pub fn spreads_from(&self, sq: usize, dir: usize, out: &mut Vec<Move>) {
        let (dist, smash) = self.reach(sq, dir);
        if dist == 0 && !smash {
            return;
        }
        let carry = (self.h[sq] as usize).min(N);
        for k in 1..=carry {
            for idx in pat_range(k) {
                let nsq = PATS.nsq[idx] as usize;
                if nsq <= dist || (smash && nsq == dist + 1 && PATS.last1[idx]) {
                    out.push(mv_spread(sq, dir, idx));
                }
            }
        }
    }

    /// All legal moves: spreads first, then capstone, flat and wall placements.
    pub fn legal_moves(&self, out: &mut Vec<Move>) {
        out.clear();
        let emp = self.empty();
        if self.ply < 2 {
            let mut e = emp;
            while e != 0 {
                let sq = e.trailing_zeros() as usize;
                e &= e - 1;
                out.push(mv_place(sq, FLAT));
            }
            return;
        }
        let me = self.stm as usize;
        let mut o = self.own[me];
        while o != 0 {
            let sq = o.trailing_zeros() as usize;
            o &= o - 1;
            for dir in 0..4 {
                self.spreads_from(sq, dir, out);
            }
        }
        if self.caps[me] > 0 {
            let mut e = emp;
            while e != 0 {
                let sq = e.trailing_zeros() as usize;
                e &= e - 1;
                out.push(mv_place(sq, CAP));
            }
        }
        if self.stones[me] > 0 {
            for t in [FLAT, WALL] {
                let mut e = emp;
                while e != 0 {
                    let sq = e.trailing_zeros() as usize;
                    e &= e - 1;
                    out.push(mv_place(sq, t));
                }
            }
        }
    }

    pub fn is_legal(&self, m: Move) -> bool {
        let sq = mv_sq(m);
        if sq >= NN {
            return false;
        }
        let b = 1u64 << sq;
        let me = self.stm as usize;
        if !is_spread(m) {
            let t = mv_type(m);
            if self.occ() & b != 0 || t > CAP {
                return false;
            }
            if self.ply < 2 {
                return t == FLAT;
            }
            return if t == CAP { self.caps[me] > 0 } else { self.stones[me] > 0 };
        }
        if self.ply < 2 || self.own[me] & b == 0 {
            return false;
        }
        let pat = mv_pat(m);
        if pat >= NPAT {
            return false;
        }
        let k = PATS.k[pat] as usize;
        if k > (self.h[sq] as usize).min(N) {
            return false;
        }
        let nsq = PATS.nsq[pat] as usize;
        let (dist, smash) = self.reach(sq, mv_dir(m));
        nsq <= dist || (smash && nsq == dist + 1 && PATS.last1[pat])
    }

    #[inline]
    pub fn flat_end(&self) -> End {
        let f0 = (self.own[0] & !self.wall & !self.cap).count_ones() as i32;
        let f1 = (self.own[1] & !self.wall & !self.cap).count_ones() as i32;
        let d = 2 * (f0 - f1) - self.halfkomi;
        End { winner: if d > 0 { 0 } else if d < 0 { 1 } else { 2 }, road: false }
    }

    /// Result after the last move (the mover is the side not to move), as tak.js Game.result().
    #[inline]
    pub fn result(&self) -> Option<End> {
        let mover = (self.stm ^ 1) as usize;
        if has_road_set(self.road(mover)) {
            return Some(End { winner: mover as u8, road: true });
        }
        if has_road_set(self.road(1 - mover)) {
            return Some(End { winner: (1 - mover) as u8, road: true });
        }
        if self.occ() == BOARD || self.reserves(0) == 0 || self.reserves(1) == 0 {
            return Some(self.flat_end());
        }
        None
    }

    /// A move giving colour `c` a road now, whoever is to move (SOLVER.md 1, roadIn1).
    /// Assumes neither side has a road already.
    pub fn road_in1(&self, c: usize) -> Option<Move> {
        if self.ply < 2 {
            return None;
        }
        let r = self.road(c);
        let an = nbr(flood(r, r & NORTH)) | NORTH;
        let as_ = nbr(flood(r, r & SOUTH)) | SOUTH;
        let ae = nbr(flood(r, r & EAST)) | EAST;
        let aw = nbr(flood(r, r & WEST)) | WEST;
        let zone = (an & as_) | (ae & aw);
        if self.reserves(c) > 0 {
            let e = self.empty() & zone;
            if e != 0 {
                return Some(mv_place(e.trailing_zeros() as usize, if self.stones[c] > 0 { FLAT } else { CAP }));
            }
        }
        let spans = |x: u64| (x & an != 0 && x & as_ != 0) || (x & ae != 0 && x & aw != 0);
        let mut o = self.own[c];
        while o != 0 {
            let sq = o.trailing_zeros() as usize;
            o &= o - 1;
            let sb = 1u64 << sq;
            let h = self.h[sq] as usize;
            let s = self.st[sq];
            let carry = h.min(N);
            let topt = self.top_type(sq);
            let carried = (s >> (h - carry)) & low(carry);
            let cbits = if c == 1 { carried } else { !carried & low(carry) };
            let single = cbits.count_ones() == 1 && topt != WALL;
            for dir in 0..4 {
                let (dist, smash) = self.reach(sq, dir);
                if dist == 0 && !smash {
                    continue;
                }
                let maxsq = if smash && carry > dist { dist + 1 } else { dist.min(carry) };
                let mut raym = RAYS.mask[sq][dir][maxsq];
                if topt == WALL {
                    raym |= sb;
                }
                let cand = raym & !r;
                if !spans(cand) {
                    continue;
                }
                if single && cand & zone == 0 {
                    continue;
                }
                let rbase = r & !sb;
                for k in 1..=carry {
                    let hand = (s >> (h - k)) & low(k);
                    let hc = (if c == 1 { hand } else { !hand & low(k) }) as usize;
                    let base = h - k;
                    let src_road = if base > 0 && ((s >> (base - 1)) & 1) as usize == c { sb } else { 0 };
                    for idx in pat_range(k) {
                        let nsq = PATS.nsq[idx] as usize;
                        if !(nsq <= dist || (smash && nsq == dist + 1 && PATS.last1[idx])) {
                            continue;
                        }
                        let mut tops = PATS.pext[hc][idx] as usize;
                        if topt == WALL {
                            tops &= !(1 << (nsq - 1));
                        }
                        let r1 = (rbase & !RAYS.mask[sq][dir][nsq]) | RAYS.dep[sq][dir][tops] | src_road;
                        let add = r1 & !r;
                        if !spans(add) {
                            continue;
                        }
                        if has_road_set(r1) {
                            return Some(mv_spread(sq, dir, idx));
                        }
                    }
                }
            }
        }
        None
    }

    /// A flat-count win for the side to move this move, if one exists (road wins not considered).
    /// Only possible when the mover has one piece left or fewer than N squares are empty.
    pub fn flat_win_now(&mut self) -> Option<Move> {
        let c = self.stm as usize;
        let res = self.reserves(c);
        let empt = self.empty();
        let e = empt.count_ones() as usize;
        if res == 0 || e == 0 || self.ply < 2 {
            return None;
        }
        if res > 1 && e >= N {
            return None;
        }
        let wins = |b: &Board| matches!(b.result(), Some(End { winner, .. }) if winner as usize == c);
        if res == 1 || e == 1 {
            let m = mv_place(empt.trailing_zeros() as usize, if self.stones[c] > 0 { FLAT } else { CAP });
            let u = self.make(m);
            let w = wins(self);
            self.unmake(m, u);
            if w {
                return Some(m);
            }
        }
        if e < N {
            let first = empt.trailing_zeros() as usize;
            let (row, col) = (first / N, first % N);
            let mut buf: Vec<Move> = Vec::new();
            for (line, dirs) in [(RANKS[row], [2usize, 3]), (FILES[col], [0usize, 1])] {
                if empt & line != empt {
                    continue;
                }
                let mut src = self.own[c] & line;
                while src != 0 {
                    let sq = src.trailing_zeros() as usize;
                    src &= src - 1;
                    for dir in dirs {
                        let len = RAYS.len[sq][dir] as usize;
                        if RAYS.mask[sq][dir][len] & empt != empt {
                            continue;
                        }
                        buf.clear();
                        self.spreads_from(sq, dir, &mut buf);
                        for &m in &buf {
                            if RAYS.mask[sq][dir][PATS.nsq[mv_pat(m)] as usize] & empt != empt {
                                continue;
                            }
                            let u = self.make(m);
                            let w = wins(self);
                            self.unmake(m, u);
                            if w {
                                return Some(m);
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// A winning move for the side to move, if any (road or flats).
    #[inline]
    pub fn win_now(&mut self) -> Option<Move> {
        if let Some(m) = self.road_in1(self.stm as usize) {
            return Some(m);
        }
        self.flat_win_now()
    }

    /// After an attacker move (defender to move): does the attacker threaten to win next move?
    pub fn threatens(&mut self, att: usize) -> bool {
        if self.road_in1(att).is_some() {
            return true;
        }
        if self.reserves(att) <= 1 || (self.empty().count_ones() as usize) < N {
            self.pass();
            let w = self.flat_win_now().is_some();
            self.pass();
            return w;
        }
        false
    }

    // ---------------- TPS / PTN ----------------

    pub fn from_tps(tps: &str, halfkomi: i32) -> Result<Board, String> {
        let t = tps.trim();
        let t = t.strip_prefix("[TPS").map(|x| x.trim().trim_start_matches('"').trim_end_matches(']').trim_end_matches('"')).unwrap_or(t);
        let mut parts = t.split_whitespace();
        let bs = parts.next().ok_or("empty TPS")?;
        let turn: u32 = parts.next().unwrap_or("1").parse().map_err(|_| "bad turn")?;
        let moveno: u32 = parts.next().unwrap_or("1").parse().map_err(|_| "bad move number")?;
        let rows: Vec<&str> = bs.split('/').collect();
        if rows.len() != N {
            return Err(format!("TPS has {} rows; only {}x{} is supported", rows.len(), N, N));
        }
        let mut b = Board::new();
        b.halfkomi = halfkomi;
        for (ri, row) in rows.iter().enumerate() {
            let r = N - 1 - ri;
            let mut c = 0usize;
            for cell in row.split(',') {
                if let Some(rest) = cell.strip_prefix('x') {
                    c += if rest.is_empty() { 1 } else { rest.parse::<usize>().map_err(|_| format!("bad cell {cell}"))? };
                    continue;
                }
                if c >= N {
                    return Err(format!("row {ri} too long"));
                }
                let sq = r * N + c;
                let bytes = cell.as_bytes();
                let (digits, t) = match bytes.last() {
                    Some(b'S') => (&cell[..cell.len() - 1], WALL),
                    Some(b'C') => (&cell[..cell.len() - 1], CAP),
                    _ => (cell, FLAT),
                };
                if digits.is_empty() || digits.len() > MAXH {
                    return Err(format!("bad cell {cell}"));
                }
                let mut st = 0u64;
                for (i, ch) in digits.chars().enumerate() {
                    let col = match ch {
                        '1' => 0,
                        '2' => 1,
                        _ => return Err(format!("bad cell {cell}")),
                    };
                    st |= (col as u64) << i;
                    let last = i == digits.len() - 1;
                    if last && t == CAP {
                        if b.caps[col] == 0 {
                            return Err("too many capstones".into());
                        }
                        b.caps[col] -= 1;
                    } else {
                        if b.stones[col] == 0 {
                            return Err("too many stones".into());
                        }
                        b.stones[col] -= 1;
                    }
                }
                b.st[sq] = st;
                b.h[sq] = digits.len() as u8;
                let bit = 1u64 << sq;
                if t == WALL {
                    b.wall |= bit;
                } else if t == CAP {
                    b.cap |= bit;
                }
                b.set_own(sq);
                c += 1;
            }
            if c != N {
                return Err(format!("TPS row {ri} has {c} squares, expected {N}"));
            }
        }
        if turn != 1 && turn != 2 {
            return Err("bad turn".into());
        }
        b.stm = (turn - 1) as u8;
        b.ply = (moveno.max(1) - 1) * 2 + b.stm as u32;
        b.key = b.compute_key();
        Ok(b)
    }

    /// Board and side to move, without the move number (a position identity).
    pub fn tps_board(&self) -> String {
        let mut rows = Vec::new();
        for r in (0..N).rev() {
            let mut cells: Vec<String> = Vec::new();
            let mut empty = 0;
            for c in 0..N {
                let sq = r * N + c;
                let h = self.h[sq] as usize;
                if h == 0 {
                    empty += 1;
                    continue;
                }
                if empty > 0 {
                    cells.push(if empty > 1 { format!("x{empty}") } else { "x".into() });
                    empty = 0;
                }
                let mut s: String = (0..h).map(|j| if (self.st[sq] >> j) & 1 == 1 { '2' } else { '1' }).collect();
                match self.top_type(sq) {
                    WALL => s.push('S'),
                    CAP => s.push('C'),
                    _ => {}
                }
                cells.push(s);
            }
            if empty > 0 {
                cells.push(if empty > 1 { format!("x{empty}") } else { "x".into() });
            }
            rows.push(cells.join(","));
        }
        format!("{} {}", rows.join("/"), self.stm + 1)
    }
    pub fn to_tps(&self) -> String {
        format!("{} {}", self.tps_board(), self.ply / 2 + 1)
    }

    pub fn sq_name(sq: usize) -> String {
        format!("{}{}", (b'a' + (sq % N) as u8) as char, sq / N + 1)
    }

    pub fn ptn(m: Move) -> String {
        let sq = mv_sq(m);
        if !is_spread(m) {
            let p = match mv_type(m) {
                WALL => "S",
                CAP => "C",
                _ => "",
            };
            return format!("{p}{}", Board::sq_name(sq));
        }
        let pat = mv_pat(m);
        let k = PATS.k[pat];
        let nsq = PATS.nsq[pat] as usize;
        let mut s = String::new();
        if k > 1 {
            s.push_str(&k.to_string());
        }
        s.push_str(&Board::sq_name(sq));
        s.push(DIR_CH[mv_dir(m)]);
        if nsq > 1 {
            for i in 0..nsq {
                s.push_str(&PATS.drops[pat][i].to_string());
            }
        }
        s
    }

    pub fn parse_move(s: &str) -> Result<Move, String> {
        let s = s.trim().trim_end_matches(['\'', '"', '!', '?', '*']);
        let b = s.as_bytes();
        let sqof = |f: u8, r: u8| -> Result<usize, String> {
            if !(b'a'..b'a' + N as u8).contains(&f) || !(b'1'..b'1' + N as u8).contains(&r) {
                return Err(format!("bad square in {s}"));
            }
            Ok((r - b'1') as usize * N + (f - b'a') as usize)
        };
        let mut i = 0;
        let mut count: Option<usize> = None;
        let mut t = FLAT;
        if i < b.len() && matches!(b[i], b'F' | b'S' | b'C') {
            t = match b[i] {
                b'S' => WALL,
                b'C' => CAP,
                _ => FLAT,
            };
            i += 1;
        } else if i < b.len() && b[i].is_ascii_digit() {
            count = Some((b[i] - b'0') as usize);
            i += 1;
        }
        if i + 2 > b.len() {
            return Err(format!("unparseable move {s}"));
        }
        let sq = sqof(b[i], b[i + 1])?;
        i += 2;
        if i == b.len() {
            if count.is_some() {
                return Err(format!("unparseable move {s}"));
            }
            return Ok(mv_place(sq, t));
        }
        if t != FLAT && b[0] != b'F' {
            return Err(format!("unparseable move {s}"));
        }
        let dir = match b[i] {
            b'+' => 0,
            b'-' => 1,
            b'>' => 2,
            b'<' => 3,
            _ => return Err(format!("unparseable move {s}")),
        };
        i += 1;
        let k = count.unwrap_or(1);
        let drops: Vec<usize> = if i == b.len() { vec![k] } else { b[i..].iter().map(|&d| (d as char).to_digit(10).map(|x| x as usize).ok_or(format!("bad drops {s}"))).collect::<Result<_, _>>()? };
        if k == 0 || k > N || drops.iter().sum::<usize>() != k || drops.contains(&0) {
            return Err(format!("drop counts do not sum: {s}"));
        }
        let mut m = 0usize;
        let mut acc = 0;
        for d in &drops {
            acc += d;
            m |= 1 << (acc - 1);
        }
        let idx = (1 << (k - 1)) - 1 + (m & ((1 << (k - 1)) - 1));
        Ok(mv_spread(sq, dir, idx))
    }
}
