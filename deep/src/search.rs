//! Tables, expansion and df-pn search (SOLVER.md sections 2 to 5).
//!
//! pn/dn are always the attacker's proof and disproof numbers: pn = 0 proven, dn = 0 disproven.
//! A node is (position, depth limit p, quiet moves left q). p = UNL means no depth limit.
//! The core keeps no clocks, threads or files: budgets are node counts, and an optional `stop`
//! callback (polled every 1024 nodes) lets a wrapper impose a time limit.

use crate::board::*;

pub const INF: u32 = 1 << 30;
pub const K: u32 = 100;
pub const UNL: u8 = 255;
pub const MAXQ: usize = 3;
pub const PATH_LIMIT: u32 = 120;
pub const SIM_NODES: i32 = 400;

const EXPANDED: u8 = 1;
const QUIET_BUILT: u8 = 2;
const ON_PATH: u8 = 4;

#[derive(Clone, Copy, Default, Debug)]
pub struct PosE {
    pub key: u64,
    pub kids_off: u32,
    pub quiet_off: u32,
    pub nkids: u16,
    pub nquiet: u16,
    pub best: Move,
    pub gen: u16,
    /// plies of the shortest proof found, 0 if none
    pub min_win: u8,
    /// deepest limit disproved with q quiet moves left (255 = unlimited)
    pub max_fail: [u8; MAXQ],
    pub flags: u8,
}

#[derive(Clone, Copy, Default)]
struct ValE {
    key: u64,
    pn: u32,
    dn: u32,
    gen: u16,
    p: u8,
    q: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Abort {
    Budget,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Proven(u8),
    Disproven,
    Unknown,
    Full,
}

pub struct Tables {
    lp: u32,
    pos: Vec<PosE>,
    val: Vec<ValE>,
    kid_key: Vec<u64>,
    kid_mv: Vec<Move>,
    kid_len: usize,
    pos_used: usize,
    val_used: usize,
    gen: u16,
}

impl Tables {
    /// 2^lp Pos entries, 2^lp Val entries, 2^(lp+3) kid slots.
    pub fn new(lp: u32) -> Tables {
        let n = 1usize << lp;
        Tables { lp, pos: vec![PosE::default(); n], val: vec![ValE::default(); n], kid_key: vec![0; n << 3], kid_mv: vec![0; n << 3], kid_len: 0, pos_used: 0, val_used: 0, gen: 1 }
    }
    pub fn bytes(&self) -> usize {
        self.pos.len() * std::mem::size_of::<PosE>() + self.val.len() * std::mem::size_of::<ValE>() + self.kid_key.len() * 10
    }
    pub fn used_bytes(&self) -> usize {
        self.pos_used * std::mem::size_of::<PosE>() + self.val_used * std::mem::size_of::<ValE>() + self.kid_len * 10
    }
    pub fn fill(&self) -> (usize, usize, usize) {
        (self.pos_used, self.val_used, self.kid_len)
    }
    /// O(1) reset by generation.
    pub fn reset(&mut self) {
        self.gen = self.gen.wrapping_add(1);
        if self.gen == 0 {
            for e in self.pos.iter_mut() {
                e.gen = 0;
            }
            for e in self.val.iter_mut() {
                e.gen = 0;
            }
            self.gen = 1;
        }
        self.kid_len = 0;
        self.pos_used = 0;
        self.val_used = 0;
    }
    #[inline]
    fn mask(&self) -> usize {
        self.pos.len() - 1
    }
    #[inline]
    pub fn pos_find(&self, key: u64) -> Option<usize> {
        let m = self.mask();
        let mut i = (key >> (64 - self.lp)) as usize;
        loop {
            let e = &self.pos[i];
            if e.gen != self.gen {
                return None;
            }
            if e.key == key {
                return Some(i);
            }
            i = (i + 1) & m;
        }
    }
    #[inline]
    fn pos_get(&mut self, key: u64) -> Result<usize, Abort> {
        let m = self.mask();
        let mut i = (key >> (64 - self.lp)) as usize;
        loop {
            let e = &self.pos[i];
            if e.gen != self.gen {
                if self.pos_used * 4 >= self.pos.len() * 3 {
                    return Err(Abort::Full);
                }
                self.pos_used += 1;
                self.pos[i] = PosE { key, gen: self.gen, best: NO_MOVE, ..Default::default() };
                return Ok(i);
            }
            if e.key == key {
                return Ok(i);
            }
            i = (i + 1) & m;
        }
    }
    #[inline]
    fn val_idx(&self, key: u64, p: u8, q: u8) -> usize {
        let h = (key ^ (p as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (q as u64 + 1).wrapping_mul(0xC2B2_AE3D_27D4_EB4F)).wrapping_mul(0xff51_afd7_ed55_8ccd);
        (h >> (64 - self.lp)) as usize
    }
    #[inline]
    fn val_find(&self, key: u64, p: u8, q: u8) -> Option<(u32, u32)> {
        let m = self.mask();
        let mut i = self.val_idx(key, p, q);
        loop {
            let e = &self.val[i];
            if e.gen != self.gen {
                return None;
            }
            if e.key == key && e.p == p && e.q == q {
                return Some((e.pn, e.dn));
            }
            i = (i + 1) & m;
        }
    }
    #[inline]
    fn val_store(&mut self, key: u64, p: u8, q: u8, pn: u32, dn: u32) -> Result<(), Abort> {
        let m = self.mask();
        let cap = self.val.len();
        let mut i = self.val_idx(key, p, q);
        loop {
            let e = &mut self.val[i];
            if e.gen != self.gen {
                if self.val_used * 4 >= cap * 3 {
                    return Err(Abort::Full);
                }
                self.val_used += 1;
                *e = ValE { key, pn, dn, gen: self.gen, p, q };
                return Ok(());
            }
            if e.key == key && e.p == p && e.q == q {
                e.pn = pn;
                e.dn = dn;
                return Ok(());
            }
            i = (i + 1) & m;
        }
    }
    #[inline]
    fn kids_push(&mut self, list: &[(u64, Move)]) -> Result<u32, Abort> {
        let off = self.kid_len;
        if (off + list.len()) * 4 >= self.kid_key.len() * 3 {
            return Err(Abort::Full);
        }
        for (i, &(k, m)) in list.iter().enumerate() {
            self.kid_key[off + i] = k;
            self.kid_mv[off + i] = m;
        }
        self.kid_len += list.len();
        Ok(off as u32)
    }
}

#[derive(Clone, Copy)]
struct Child {
    key: u64,
    mv: Move,
    quiet: bool,
    pn: u32,
    dn: u32,
}

#[inline]
fn cp(p: u8) -> u8 {
    if p == UNL {
        UNL
    } else {
        p.saturating_sub(1)
    }
}

pub type StopFn = Box<dyn FnMut(u64) -> bool>;

#[derive(Default, Clone, Debug)]
pub struct Stats {
    pub nodes: u64,
    pub sim_calls: u64,
    pub sim_ok: u64,
    pub expansions: u64,
}

pub struct Search {
    pub t: Tables,
    pub att: u8,
    kx: u64,
    budget: u64,
    pub stats: Stats,
    path_hits: u64,
    bufs: Vec<Vec<Child>>,
    mvbufs: Vec<Vec<Move>>,
    tmp_threat: Vec<(u64, Move)>,
    tmp_quiet: Vec<(u64, Move)>,
    pub stop: Option<StopFn>,
}

impl Search {
    pub fn new(lp: u32) -> Search {
        Search { t: Tables::new(lp), att: 0, kx: 0, budget: 0, stats: Stats::default(), path_hits: 0, bufs: Vec::new(), mvbufs: Vec::new(), tmp_threat: Vec::new(), tmp_quiet: Vec::new(), stop: None }
    }
    pub fn reset(&mut self) {
        self.t.reset();
    }
    /// Table key: the board key folded with the attacker colour and komi, so positions solved for
    /// different attackers or komi never share entries.
    #[inline]
    fn tk(&self, raw: u64) -> u64 {
        raw ^ self.kx
    }
    fn set_att(&mut self, att: u8, halfkomi: i32) {
        self.att = att;
        self.kx = (if att == 1 { ZOB.att } else { 0 }) ^ ZOB.komi.wrapping_mul(halfkomi as i64 as u64 | 1).rotate_left(halfkomi as u32 & 63);
    }

    /// Entry for a position already in the tables (by board key).
    pub fn entry(&self, raw: u64) -> Option<PosE> {
        self.t.pos_find(self.tk(raw)).map(|i| self.t.pos[i])
    }

    /// Solve `b` to depth limit `p` (UNL = unlimited) with `q` quiet attacker moves allowed.
    /// root_or: the side to move attacks; otherwise the root is a defender node and the other side
    /// attacks. gated: apply the pass test at a defender root (the move into it was quiet).
    /// `budget` counts mid() calls in this call. Tables are kept, so repeated calls resume, but only
    /// if a call can settle at least one node: an abort stores nothing, so a budget smaller than the
    /// descent the search needs repeats the same path forever (5 nodes never finish pd519942 at
    /// p = 7; 97 and more do, see tests/adversarial.rs).
    pub fn solve(&mut self, b: &mut Board, root_or: bool, p: u8, q: u8, budget: u64, gated: bool) -> Outcome {
        let att = if root_or { b.stm } else { 1 - b.stm };
        self.set_att(att, b.halfkomi);
        self.budget = self.stats.nodes + budget;
        let q = q.min(MAXQ as u8 - 1);
        if root_or && p < 3 {
            if p >= 1 {
                if let Some(m) = b.win_now() {
                    return match self.t.pos_get(self.tk(b.key)) {
                        Ok(i) => {
                            let e = &mut self.t.pos[i];
                            e.min_win = 1;
                            e.best = m;
                            Outcome::Proven(1)
                        }
                        Err(_) => Outcome::Full,
                    };
                }
            }
            return Outcome::Disproven;
        }
        let min_p = if root_or { 1 } else if gated { 4 } else { 2 };
        loop {
            let (pn, dn) = self.value(b.key, p, q, min_p, (1, 1), 0);
            if pn == 0 {
                let mw = self.entry(b.key).map(|e| e.min_win).unwrap_or(0);
                return Outcome::Proven(mw);
            }
            if dn == 0 {
                return Outcome::Disproven;
            }
            match self.mid(b, p, q, INF, INF, gated && !root_or, 0) {
                Ok(()) => {}
                Err(Abort::Budget) => return Outcome::Unknown,
                Err(Abort::Full) => return Outcome::Full,
            }
        }
    }

    /// Exact threat-only length: winNow, then p = 3, 5, 7, ... at q = 0 on the same tables; the
    /// first proof is the length. Returns (outcome, last p tried).
    pub fn exact(&mut self, b: &mut Board, budget: u64, max_p: u8) -> (Outcome, u8) {
        let start = self.stats.nodes;
        let mut p = 1u8;
        loop {
            let left = budget.saturating_sub(self.stats.nodes - start);
            if left == 0 {
                return (Outcome::Unknown, p);
            }
            match self.solve(b, true, p, 0, left, false) {
                Outcome::Proven(_) => return (Outcome::Proven(p), p),
                Outcome::Disproven => {}
                o => return (o, p),
            }
            if p as u32 + 2 > max_p as u32 {
                return (Outcome::Disproven, p);
            }
            p += 2;
        }
    }

    /// Value of a child position (board key `raw`) at limit p with q quiet moves left.
    #[inline]
    fn value(&mut self, raw: u64, p: u8, q: u8, min_p: u8, init: (u32, u32), depth: u32) -> (u32, u32) {
        let k = self.tk(raw);
        let unl = p == UNL;
        if let Some(i) = self.t.pos_find(k) {
            let e = &self.t.pos[i];
            if e.min_win > 0 && e.min_win <= p {
                return (0, INF);
            }
            if p < min_p {
                return (INF, 0);
            }
            for qq in q as usize..MAXQ {
                if e.max_fail[qq] >= p {
                    return (INF, 0);
                }
            }
            if unl && (e.flags & ON_PATH != 0 || depth > PATH_LIMIT) {
                self.path_hits += 1;
                return (INF, 0);
            }
        } else {
            if p < min_p {
                return (INF, 0);
            }
            if unl && depth > PATH_LIMIT {
                self.path_hits += 1;
                return (INF, 0);
            }
        }
        if let Some((pn, dn)) = self.t.val_find(k, p, q) {
            if unl && dn == 0 {
                self.path_hits += 1; // only path-dependent disproofs live in Val
            }
            return (pn, dn);
        }
        init
    }

    #[inline]
    fn child_value(&mut self, c: &Child, child_or: bool, cp_: u8, q: u8, depth: u32) -> (u32, u32) {
        let (min_p, init) = if child_or {
            (3, (3, 1))
        } else if c.quiet {
            (4, (K + 1, 1))
        } else {
            (2, (1, 1))
        };
        let cq = if c.quiet { q - 1 } else { q };
        self.value(c.key, cp_, cq, min_p, init, depth)
    }

    fn fail(&mut self, pi: usize, p: u8, q: u8, clean: bool, key: u64) -> Result<(), Abort> {
        if p == UNL && !clean {
            return self.t.val_store(key, p, q, INF, 0);
        }
        let e = &mut self.t.pos[pi];
        if e.max_fail[q as usize] < p {
            e.max_fail[q as usize] = p;
        }
        Ok(())
    }

    fn take_mvbuf(&mut self) -> Vec<Move> {
        self.mvbufs.pop().unwrap_or_default()
    }

    /// OR expansion (attacker to move). Threat list once; the quiet list when want_quiet.
    fn expand_or(&mut self, b: &mut Board, pi: usize, want_quiet: bool) -> Result<(), Abort> {
        let att = b.stm as usize;
        let def = 1 - att;
        let e = self.t.pos[pi];
        let do_threat = e.flags & EXPANDED == 0;
        let do_quiet = want_quiet && e.flags & QUIET_BUILT == 0;
        if !do_threat && !do_quiet {
            return Ok(());
        }
        self.stats.expansions += 1;
        if do_threat {
            if let Some(m) = b.win_now() {
                let e = &mut self.t.pos[pi];
                e.min_win = 1;
                e.best = m;
                e.flags |= EXPANDED | QUIET_BUILT;
                return Ok(());
            }
        }
        let def_threat = b.road_in1(def).is_some();
        let empties = b.empty().count_ones() as usize;
        let far = empties >= N + 1 && b.reserves(att) >= 2 && b.reserves(def) >= 2;
        let near_walls = empties <= 3 || b.reserves(att) <= 3;
        let mut moves = self.take_mvbuf();
        b.legal_moves(&mut moves);
        let mut th = std::mem::take(&mut self.tmp_threat);
        let mut qu = std::mem::take(&mut self.tmp_quiet);
        th.clear();
        qu.clear();
        let old_threats: Vec<Move> = if do_threat { Vec::new() } else { (0..e.nkids as usize).map(|i| self.t.kid_mv[e.kids_off as usize + i]).collect() };
        for &m in moves.iter() {
            let place = !is_spread(m);
            let is_wall = place && mv_type(m) == WALL;
            if is_wall && !near_walls && !do_quiet {
                continue;
            }
            if !do_threat && old_threats.contains(&m) {
                continue;
            }
            let u = b.make(m);
            let ended = if place && far { false } else { b.result().is_some() };
            if ended {
                b.unmake(m, u);
                continue;
            }
            let threat = if is_wall && !near_walls { false } else { b.threatens(att) };
            if (threat && !do_threat) || (!threat && !do_quiet) {
                b.unmake(m, u);
                continue;
            }
            let def_wins = if place && far { def_threat && b.road_in1(def).is_some() } else { b.win_now().is_some() };
            let key = b.key;
            b.unmake(m, u);
            if def_wins {
                continue;
            }
            if threat {
                th.push((key, m));
            } else {
                qu.push((key, m));
            }
        }
        self.mvbufs.push(moves);
        let r = (|| {
            if do_threat {
                let off = self.t.kids_push(&th)?;
                let e = &mut self.t.pos[pi];
                e.kids_off = off;
                e.nkids = th.len() as u16;
                e.flags |= EXPANDED;
            }
            if do_quiet {
                let off = self.t.kids_push(&qu)?;
                let e = &mut self.t.pos[pi];
                e.quiet_off = off;
                e.nquiet = qu.len() as u16;
                e.flags |= QUIET_BUILT;
            }
            Ok(())
        })();
        self.tmp_threat = th;
        self.tmp_quiet = qu;
        r
    }

    /// Squares of the road W would make for the attacker, plus W's own squares.
    fn zone_of(&self, b: &mut Board, w: Move) -> u64 {
        let att = 1 - b.stm as usize;
        b.pass();
        let u = b.make(w);
        let r = b.road(att);
        let ns = flood(r, r & NORTH) & flood(r, r & SOUTH);
        let ew = flood(r, r & EAST) & flood(r, r & WEST);
        b.unmake(w, u);
        b.pass();
        ns | ew | mv_squares(w)
    }

    /// AND expansion (defender to move).
    fn expand_and(&mut self, b: &mut Board, pi: usize) -> Result<(), Abort> {
        self.stats.expansions += 1;
        let def = b.stm as usize;
        let att = 1 - def;
        if let Some(m) = b.win_now() {
            let e = &mut self.t.pos[pi];
            e.max_fail = [UNL; MAXQ];
            e.best = m;
            e.flags |= EXPANDED;
            return Ok(());
        }
        let empties = b.empty().count_ones() as usize;
        let zone = match b.road_in1(att) {
            Some(w) if empties >= N && b.reserves(def) >= 2 => Some(self.zone_of(b, w)),
            _ => None,
        };
        let mut moves = self.take_mvbuf();
        b.legal_moves(&mut moves);
        let mut th = std::mem::take(&mut self.tmp_threat);
        th.clear();
        let mut lost: Option<Move> = None;
        for &m in moves.iter() {
            if let Some(z) = zone {
                if mv_squares(m) & z == 0 {
                    continue;
                }
            }
            let u = b.make(m);
            match b.result() {
                Some(end) => {
                    b.unmake(m, u);
                    if end.winner as usize != att {
                        lost = Some(m);
                        break;
                    }
                    continue;
                }
                None => {}
            }
            let won = b.win_now().is_some();
            let key = b.key;
            b.unmake(m, u);
            if !won {
                th.push((key, m));
            }
        }
        self.mvbufs.push(moves);
        let r = if let Some(m) = lost {
            let e = &mut self.t.pos[pi];
            e.max_fail = [UNL; MAXQ];
            e.best = m;
            e.flags |= EXPANDED;
            Ok(())
        } else {
            match self.t.kids_push(&th) {
                Ok(off) => {
                    let e = &mut self.t.pos[pi];
                    e.kids_off = off;
                    e.nkids = th.len() as u16;
                    e.flags |= EXPANDED;
                    if th.is_empty() {
                        e.min_win = 2;
                    }
                    Ok(())
                }
                Err(a) => Err(a),
            }
        };
        self.tmp_threat = th;
        r
    }

    fn mid(&mut self, b: &mut Board, p: u8, q: u8, thp: u32, thd: u32, quiet: bool, depth: u32) -> Result<(), Abort> {
        self.stats.nodes += 1;
        if self.stats.nodes >= self.budget {
            return Err(Abort::Budget);
        }
        if self.stats.nodes & 1023 == 0 {
            if let Some(f) = self.stop.as_mut() {
                if f(self.stats.nodes) {
                    return Err(Abort::Budget);
                }
            }
        }
        let key = self.tk(b.key);
        let pi = self.t.pos_get(key)?;
        let unl = p == UNL;
        if unl {
            self.t.pos[pi].flags |= ON_PATH;
        }
        let mut buf = if depth as usize >= self.bufs.len() { Vec::new() } else { std::mem::take(&mut self.bufs[depth as usize]) };
        let r = self.mid_body(b, pi, key, p, q, thp, thd, quiet, depth, &mut buf);
        if self.bufs.len() <= depth as usize {
            self.bufs.resize_with(depth as usize + 1, Vec::new);
        }
        self.bufs[depth as usize] = buf;
        if unl {
            self.t.pos[pi].flags &= !ON_PATH;
        }
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn mid_body(&mut self, b: &mut Board, pi: usize, key: u64, p: u8, q: u8, thp: u32, thd: u32, quiet: bool, depth: u32, buf: &mut Vec<Child>) -> Result<(), Abort> {
        let is_or = b.stm == self.att;
        let hits0 = self.path_hits;
        let cp_ = cp(p);
        // pass test for a defender node reached by a quiet attacker move
        if !is_or && quiet {
            let pk = b.key ^ ZOB.side;
            loop {
                let (a, bb) = self.value(pk, cp_, 0, 3, (1, 1), depth + 1);
                if a == 0 {
                    break;
                }
                if bb == 0 {
                    let clean = self.path_hits == hits0;
                    return self.fail(pi, p, q, clean, key);
                }
                if a as u64 + K as u64 >= thp as u64 || bb >= thd {
                    return self.t.val_store(key, p, q, (a + K).min(INF - 1), bb);
                }
                b.pass();
                let r = self.mid(b, cp_, 0, thp - K, thd, false, depth + 1);
                b.pass();
                r?;
            }
        }
        let mut first = false;
        if is_or {
            let e = self.t.pos[pi];
            let want_q = q > 0 && (p == UNL || p >= 5);
            if e.flags & EXPANDED == 0 || (want_q && e.flags & QUIET_BUILT == 0) {
                self.expand_or(b, pi, want_q)?;
            }
        } else if self.t.pos[pi].flags & EXPANDED == 0 {
            self.expand_and(b, pi)?;
            first = true;
        }
        let e = self.t.pos[pi];
        if e.min_win > 0 && e.min_win <= p {
            return Ok(());
        }
        if (q as usize..MAXQ).any(|qq| e.max_fail[qq] >= p) {
            return Ok(()); // already disproven here (e.g. a defender node with a winning reply)
        }
        buf.clear();
        for i in 0..e.nkids as usize {
            let o = e.kids_off as usize + i;
            buf.push(Child { key: self.t.kid_key[o], mv: self.t.kid_mv[o], quiet: false, pn: 0, dn: 0 });
        }
        if is_or && q > 0 && (p == UNL || p >= 5) {
            for i in 0..e.nquiet as usize {
                let o = e.quiet_off as usize + i;
                buf.push(Child { key: self.t.kid_key[o], mv: self.t.kid_mv[o], quiet: true, pn: 0, dn: 0 });
            }
        }
        let child_or = !is_or;
        for i in 0..buf.len() {
            let c = buf[i];
            let v = self.child_value(&c, child_or, cp_, q, depth + 1);
            buf[i].pn = v.0;
            buf[i].dn = v.1;
        }
        if !is_or && quiet && first {
            let pk = b.key ^ ZOB.side;
            self.replay_onto(b, pk, cp_, buf, usize::MAX, q, depth)?;
        }
        loop {
            let (mut pn, mut dn, mut bi, mut second);
            if buf.is_empty() {
                // OR: no threats (disproven). AND: no replies is set static at expansion.
                if is_or {
                    pn = INF;
                    dn = 0;
                } else {
                    pn = 0;
                    dn = INF;
                }
                bi = 0;
                second = INF;
            } else if is_or {
                pn = INF;
                second = INF;
                bi = 0;
                let mut sum = 0u64;
                for (i, c) in buf.iter().enumerate() {
                    if c.pn < pn {
                        second = pn;
                        pn = c.pn;
                        bi = i;
                    } else if c.pn < second {
                        second = c.pn;
                    }
                    sum += c.dn as u64;
                }
                dn = sum.min(INF as u64 - 1) as u32;
                if dn == 0 {
                    pn = INF;
                }
            } else {
                dn = INF;
                second = INF;
                bi = 0;
                let mut sum = 0u64;
                for (i, c) in buf.iter().enumerate() {
                    if c.dn < dn {
                        second = dn;
                        dn = c.dn;
                        bi = i;
                    } else if c.dn < second {
                        second = c.dn;
                    }
                    sum += c.pn as u64;
                }
                pn = sum.min(INF as u64 - 1) as u32;
                if pn == 0 {
                    dn = INF;
                }
            }
            if pn == 0 {
                return self.prove(pi, is_or, buf, p);
            }
            if dn == 0 {
                let clean = self.path_hits == hits0;
                if !is_or && !buf.is_empty() {
                    self.t.pos[pi].best = buf[bi].mv;
                }
                return self.fail(pi, p, q, clean, key);
            }
            if pn >= thp || dn >= thd {
                return self.t.val_store(key, p, q, pn, dn);
            }
            let c = buf[bi];
            let sec = second as u64 + second as u64 / 16 + 1;
            let (cthp, cthd) = if is_or {
                let cthp = (thp as u64).min(sec).min(INF as u64) as u32;
                let cthd = (thd as u64 - dn as u64 + c.dn as u64).min(INF as u64) as u32;
                (cthp, cthd)
            } else {
                let cthd = (thd as u64).min(sec).min(INF as u64) as u32;
                let cthp = (thp as u64 - pn as u64 + c.pn as u64).min(INF as u64) as u32;
                (cthp, cthd)
            };
            let cq = if c.quiet { q - 1 } else { q };
            let u = b.make(c.mv);
            let r = self.mid(b, cp_, cq, cthp, cthd, c.quiet, depth + 1);
            b.unmake(c.mv, u);
            r?;
            let v = self.child_value(&c, child_or, cp_, q, depth + 1);
            buf[bi].pn = v.0;
            buf[bi].dn = v.1;
            if !is_or && v.0 == 0 {
                self.replay_onto(b, c.key, cp_, buf, bi, q, depth)?;
            }
        }
    }

    fn prove(&mut self, pi: usize, is_or: bool, buf: &[Child], p: u8) -> Result<(), Abort> {
        let mut mw: u32;
        let mut best = NO_MOVE;
        if is_or {
            mw = u32::MAX;
            for c in buf.iter().filter(|c| c.pn == 0) {
                let cm = self.entry(c.key).map(|e| e.min_win).unwrap_or(0) as u32;
                if cm > 0 && cm < mw {
                    mw = cm;
                    best = c.mv;
                }
            }
            debug_assert!(mw != u32::MAX);
            mw += 1;
        } else {
            mw = 1;
            for c in buf.iter() {
                let cm = self.entry(c.key).map(|e| e.min_win).unwrap_or(0) as u32;
                mw = mw.max(cm);
            }
            mw += 1;
        }
        let mw = mw.min(254) as u8;
        debug_assert!(p == UNL || mw <= p);
        let e = &mut self.t.pos[pi];
        if e.min_win == 0 || mw < e.min_win {
            e.min_win = mw;
            if is_or {
                e.best = best;
            }
        }
        Ok(())
    }

    /// Kawano simulation of proven P (board key) onto every unsolved child of the current node
    /// (except `skip`), each an attacker-to-move position at limit lim.
    #[allow(clippy::too_many_arguments)]
    fn replay_onto(&mut self, b: &mut Board, p_raw: u64, lim: u8, buf: &mut [Child], skip: usize, q: u8, depth: u32) -> Result<(), Abort> {
        for j in 0..buf.len() {
            if j == skip || buf[j].pn == 0 || buf[j].dn == 0 {
                continue;
            }
            let c = buf[j];
            let u = b.make(c.mv);
            let mut left = SIM_NODES;
            self.stats.sim_calls += 1;
            let r = self.sim(b, p_raw, lim, &mut left);
            b.unmake(c.mv, u);
            if r? {
                self.stats.sim_ok += 1;
                let v = self.child_value(&c, true, lim, q, depth + 1);
                buf[j].pn = v.0;
                buf[j].dn = v.1;
            }
        }
        Ok(())
    }

    fn kid_key(&self, e: &PosE, m: Move) -> Option<u64> {
        for i in 0..e.nkids as usize {
            let o = e.kids_off as usize + i;
            if self.t.kid_mv[o] == m {
                return Some(self.t.kid_key[o]);
            }
        }
        if e.flags & QUIET_BUILT != 0 {
            for i in 0..e.nquiet as usize {
                let o = e.quiet_off as usize + i;
                if self.t.kid_mv[o] == m {
                    return Some(self.t.kid_key[o]);
                }
            }
        }
        None
    }

    /// sim(P, Q, lim): the board is at Q (attacker to move, not proven); P is a proven position.
    fn sim(&mut self, b: &mut Board, p_raw: u64, lim: u8, left: &mut i32) -> Result<bool, Abort> {
        if *left <= 0 || (lim != UNL && lim < 3) {
            return Ok(false);
        }
        *left -= 1;
        let pe = match self.entry(p_raw) {
            Some(e) if e.min_win >= 3 && e.best != NO_MOVE => e,
            _ => return Ok(false),
        };
        let m = pe.best;
        let Some(pa_raw) = self.kid_key(&pe, m) else { return Ok(false) };
        if !b.is_legal(m) {
            return Ok(false);
        }
        let q_raw = b.key;
        let u = b.make(m);
        let r = self.sim_and(b, pa_raw, cp(lim), left);
        b.unmake(m, u);
        let Some(qa_mw) = r? else { return Ok(false) };
        let qi = self.t.pos_get(self.tk(q_raw))?;
        let e = &mut self.t.pos[qi];
        let mw = qa_mw + 1;
        if e.min_win == 0 || mw < e.min_win {
            e.min_win = mw;
            e.best = m;
        }
        Ok(true)
    }

    /// The defender node of sim after P's move; returns its proof length on success.
    fn sim_and(&mut self, b: &mut Board, pa_raw: u64, lim: u8, left: &mut i32) -> Result<Option<u8>, Abort> {
        let att = self.att as usize;
        if b.result().is_some() || !b.threatens(att) || b.win_now().is_some() {
            return Ok(None);
        }
        let qa = self.t.pos_get(self.tk(b.key))?;
        if self.t.pos[qa].flags & EXPANDED == 0 {
            self.expand_and(b, qa)?;
        }
        let e = self.t.pos[qa];
        if e.max_fail[0] == UNL {
            return Ok(None);
        }
        if e.min_win > 0 && e.min_win <= lim {
            return Ok(Some(e.min_win));
        }
        let pae = match self.entry(pa_raw) {
            Some(x) if x.flags & EXPANDED != 0 => x,
            _ => return Ok(None),
        };
        let cl = cp(lim);
        let mut worst = 1u8;
        for i in 0..e.nkids as usize {
            let o = e.kids_off as usize + i;
            let (rk, r) = (self.t.kid_key[o], self.t.kid_mv[o]);
            if let Some(ce) = self.entry(rk) {
                if ce.min_win > 0 && ce.min_win <= cl {
                    worst = worst.max(ce.min_win);
                    continue;
                }
            }
            let mut cands = [0u64; 4];
            let mut n = 0;
            if let Some(k) = (0..pae.nkids as usize).map(|j| pae.kids_off as usize + j).find(|&o| self.t.kid_mv[o] == r) {
                cands[n] = self.t.kid_key[k];
                n += 1;
            }
            let mut others = 0;
            for j in 0..pae.nkids as usize {
                if others == 3 {
                    break;
                }
                let o = pae.kids_off as usize + j;
                if self.t.kid_mv[o] == r {
                    continue;
                }
                cands[n] = self.t.kid_key[o];
                n += 1;
                others += 1;
            }
            let mut ok = false;
            for &pk in &cands[..n] {
                match self.entry(pk) {
                    Some(pe) if pe.min_win >= 3 => {}
                    _ => continue,
                }
                let u = b.make(r);
                let s = self.sim(b, pk, cl, left);
                b.unmake(r, u);
                if s? {
                    let cm = self.entry(rk).map(|x| x.min_win).unwrap_or(0);
                    worst = worst.max(cm);
                    ok = true;
                    break;
                }
                if *left <= 0 {
                    break;
                }
            }
            if !ok {
                return Ok(None);
            }
        }
        let mw = worst + 1;
        let e = &mut self.t.pos[qa];
        if e.min_win == 0 || mw < e.min_win {
            e.min_win = mw;
        }
        Ok(Some(mw))
    }
}
