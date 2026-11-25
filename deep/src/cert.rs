//! Certifier (SOLVER.md section 6 with the MINING.md changes): classify every attacker node on the
//! main line, follow every key, backtrack over all longest defender replies to find a line that
//! stays unique, and emit tinue's tree format plus book rows.
//!
//! Two Search instances: `s0` holds threat-only (q = 0) work and `s1` holds q = 1 work, so a proof
//! that uses a quiet move can never make a q = 0 lookup look shorter (README: minWin ignores q).
//! The library keeps no clocks: the caller installs `stop` callbacks on both searches and passes
//! `expired`, which says whether the row's time limit has passed.

use crate::board::*;
use crate::search::*;
use std::collections::HashSet;
use std::fmt::Write as _;

#[derive(Clone, Debug)]
pub struct CertOpts {
    /// threats only (stage A)
    pub lite: bool,
    /// stop classifying a node once a second idea wins at R >= 7
    pub strict: bool,
    /// q for the quiet pass (0 = none, 1 = one quiet move)
    pub q: u8,
    pub b1: u64,
    pub b2: u64,
    /// hisshi root: lengths and keys measured at q = 1
    pub hisshi: bool,
    /// most longest replies tried per defender node when backtracking (0 = all)
    pub max_replies: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Key,
    Slower,
    Quiet,
}

#[derive(Clone, Debug)]
pub struct Win {
    pub m: Move,
    pub kind: Kind,
    /// proof length found (an upper bound for slower/quiet wins)
    pub len: u8,
}

#[derive(Clone, Debug, Default)]
pub struct NodeRec {
    pub tps: String,
    pub r: u8,
    pub keys: Vec<Move>,
    pub wins: Vec<Win>,
    pub undecided: Vec<Move>,
    pub undecided_threat: Vec<Move>,
    pub refuted: usize,
    pub ideas: usize,
    pub stopped: bool,
    pub fail: bool,
    /// distinct ideas among defender replies to the first key that do not lose at once
    pub def_ideas: usize,
    pub reply: Option<Move>,
}

pub struct Branch {
    /// largest R on the chosen line where the node fails (0 = none)
    pub cut_r: u8,
    pub tree: String,
    pub nodes: Vec<NodeRec>,
    pub book: Vec<(String, u8)>,
    /// main line (first key, chosen reply, ...)
    pub line: Vec<Move>,
}

pub struct Cert<'a> {
    pub s0: &'a mut Search,
    pub s1: &'a mut Search,
    pub o: CertOpts,
    pub expired: &'a mut dyn FnMut() -> bool,
    pub timed_out: bool,
    pub full: bool,
    pub hint: Vec<Move>,
}

/// An idea: a placement square, or a stack square plus direction.
pub fn idea(m: Move) -> u16 {
    if is_spread(m) {
        100 + (mv_sq(m) * 4 + mv_dir(m)) as u16
    } else {
        mv_sq(m) as u16
    }
}

pub fn idea_name(m: Move) -> String {
    let s = Board::sq_name(mv_sq(m));
    if is_spread(m) {
        format!("{s}{}", DIR_CH[mv_dir(m)])
    } else {
        s
    }
}

/// Last square a spread drops on.
pub fn spread_end(m: Move) -> usize {
    let n = PATS.nsq[mv_pat(m)] as usize;
    RAYS.sq[mv_sq(m)][mv_dir(m)][n - 1] as usize
}

fn adjacent(a: usize, b: usize) -> bool {
    let (ax, ay, bx, by) = (a % N, a / N, b % N, b / N);
    (ax as i32 - bx as i32).abs() + (ay as i32 - by as i32).abs() == 1
}

/// Ladder steps on a main line given each attacker node's defender idea count (SOLVER.md 6).
pub fn ladder_steps(line: &[Move], def_ideas: &[usize]) -> usize {
    let att: Vec<Move> = line.iter().step_by(2).copied().collect();
    let mut n = 0;
    for i in 1..att.len().min(def_ideas.len()) {
        if def_ideas[i] > 1 || def_ideas[i - 1] > 1 {
            continue;
        }
        let (a, b) = (att[i - 1], att[i]);
        let step = (!is_spread(a) && !is_spread(b) && adjacent(mv_sq(a), mv_sq(b))) || (is_spread(a) && is_spread(b) && spread_end(a) == mv_sq(b));
        if step {
            n += 1;
        }
    }
    n
}

pub fn jstr(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            _ => o.push(c),
        }
    }
    o.push('"');
    o
}

impl<'a> Cert<'a> {
    pub fn new(s0: &'a mut Search, s1: &'a mut Search, o: CertOpts, expired: &'a mut dyn FnMut() -> bool) -> Self {
        Cert { s0, s1, o, expired, timed_out: false, full: false, hint: Vec::new() }
    }

    fn solve(&mut self, quiet_tables: bool, b: &mut Board, root_or: bool, p: u8, q: u8, budget: u64, gated: bool) -> Outcome {
        if self.timed_out || (self.expired)() {
            self.timed_out = true;
            return Outcome::Unknown;
        }
        let s = if quiet_tables { &mut *self.s1 } else { &mut *self.s0 };
        let mut r = s.solve(b, root_or, p, q, budget, gated);
        if r == Outcome::Full {
            self.full = true;
            s.reset();
            r = s.solve(b, root_or, p, q, budget, gated);
        }
        if r == Outcome::Unknown && (self.expired)() {
            self.timed_out = true;
        }
        r
    }

    /// Key test: does m (already made; defender to move) win within `p` plies at the key q?
    fn key_test(&mut self, b: &mut Board, p: u8, threat: bool, budget: u64) -> Outcome {
        if self.o.hisshi {
            self.solve(true, b, false, p, 1, budget, !threat)
        } else {
            self.solve(false, b, false, p, 0, budget, !threat)
        }
    }

    /// Candidate attacker moves at `b`: legal, not ending the game without a win, not letting the
    /// defender win at once. Returns (move, is_threat, wins_now), likely cooks first.
    fn candidates(&mut self, b: &mut Board, threats_only: bool) -> Vec<(Move, bool, bool)> {
        let att = b.stm as usize;
        let mut mv = Vec::new();
        b.legal_moves(&mut mv);
        let mut out = Vec::new();
        for &m in &mv {
            let u = b.make(m);
            let item = match b.result() {
                Some(e) if e.winner as usize == att => Some((m, true, true)),
                Some(_) => None,
                None => {
                    if b.win_now().is_some() {
                        None
                    } else {
                        let t = b.threatens(att);
                        if threats_only && !t {
                            None
                        } else {
                            Some((m, t, false))
                        }
                    }
                }
            };
            b.unmake(m, u);
            if let Some(x) = item {
                out.push(x);
            }
        }
        // threats first (spreads before placements), then engine hints, then the rest
        let hint = self.hint.clone();
        out.sort_by_key(|&(m, t, w)| (!w, !t, !hint.contains(&m), !is_spread(m)));
        out
    }

    /// classify(position, R) from SOLVER.md 6. `full`: run the slower/quiet passes (R >= 5).
    pub fn classify(&mut self, b: &mut Board, r: u8, lite: bool, full: bool, budget1: u64) -> NodeRec {
        let mut rec = NodeRec { tps: b.to_tps(), r, ..Default::default() };
        let cands = self.candidates(b, lite);
        let mut ideas: HashSet<u16> = HashSet::new();
        let strict_now = self.o.strict && r >= 7;
        // pass 1: keys
        let mut rest = Vec::new();
        for &(m, t, w) in &cands {
            if w {
                rec.keys.push(m);
                rec.wins.push(Win { m, kind: Kind::Key, len: 1 });
                ideas.insert(idea(m));
                continue;
            }
            let u = b.make(m);
            let o = if r >= 3 { self.key_test(b, r - 1, t, 5 * budget1) } else { Outcome::Disproven };
            b.unmake(m, u);
            match o {
                Outcome::Proven(l) => {
                    rec.keys.push(m);
                    rec.wins.push(Win { m, kind: Kind::Key, len: l + 1 });
                    ideas.insert(idea(m));
                }
                _ => rest.push((m, t)),
            }
        }
        if strict_now && ideas.len() > 1 {
            rec.stopped = true;
        }
        if full && !rec.stopped {
            // pass 2 and 3: other ideas only (a slower win of a key idea is not a cook)
            for &(m, t) in &rest {
                if ideas.contains(&idea(m)) {
                    continue;
                }
                let u = b.make(m);
                let mut res = None;
                let mut undecided = false;
                match self.solve(false, b, false, UNL, 0, budget1, !t) {
                    Outcome::Proven(l) => res = Some(Win { m, kind: Kind::Slower, len: l + 1 }),
                    Outcome::Disproven => {}
                    _ => undecided = true,
                }
                if res.is_none() && self.o.q > 0 && !lite {
                    match self.solve(true, b, false, UNL, self.o.q, self.o.b2, !t) {
                        Outcome::Proven(l) => {
                            res = Some(Win { m, kind: Kind::Quiet, len: l + 1 });
                            undecided = false;
                        }
                        Outcome::Disproven => undecided = false,
                        _ => undecided = true,
                    }
                }
                b.unmake(m, u);
                if let Some(w) = res {
                    ideas.insert(idea(w.m));
                    rec.wins.push(w);
                    if strict_now && ideas.len() > 1 {
                        rec.stopped = true;
                        break;
                    }
                } else if undecided {
                    rec.undecided.push(m);
                    if t {
                        rec.undecided_threat.push(m);
                    }
                } else {
                    rec.refuted += 1;
                }
            }
        }
        rec.ideas = ideas.len();
        rec.fail = r >= 7 && rec.ideas != 1;
        rec
    }

    /// Defender replies to a key that keep the full length: (reply, its attacker position is
    /// not won within R-4). Also returns the distinct reply ideas that do not lose at once.
    fn longest_replies(&mut self, b: &mut Board, r: u8) -> (Vec<Move>, usize) {
        let att = 1 - b.stm as usize;
        let mut mv = Vec::new();
        b.legal_moves(&mut mv);
        let mut longest = Vec::new();
        let mut ideas = HashSet::new();
        for &m in &mv {
            let u = b.make(m);
            let ends = b.result().is_some();
            let alive = !ends && b.win_now().is_none();
            if alive {
                ideas.insert(idea(m));
            }
            // R = 3: every reply that does not end the game leaves a win in 1, so all are longest
            if r < 5 && !ends {
                longest.push(m);
            } else if alive {
                let keep = {
                    let o = if self.o.hisshi { self.solve(true, b, true, r - 4, 1, self.o.b1, false) } else { self.solve(false, b, true, r - 4, 0, self.o.b1, false) };
                    o == Outcome::Disproven
                };
                if keep {
                    longest.push(m);
                }
            }
            b.unmake(m, u);
            let _ = att;
        }
        (longest, ideas.len())
    }

    /// Certify the attacker node `b` with R plies remaining. Follows every key; for each key
    /// tries the longest replies (fewest cheap winning ideas first) until one keeps the line unique.
    pub fn node(&mut self, b: &mut Board, r: u8) -> Branch {
        if r <= 1 {
            return Branch { cut_r: 0, tree: "\"win\"".into(), nodes: vec![], book: vec![], line: vec![] };
        }
        let full = r >= 5;
        let mut rec = self.classify(b, r, self.o.lite, full, self.o.b1);
        let mut cut = if rec.fail { r } else { 0 };
        let mut br = Branch { cut_r: 0, tree: String::new(), nodes: vec![], book: vec![], line: vec![] };
        if rec.keys.is_empty() || (rec.stopped && self.o.strict) || self.timed_out {
            if rec.keys.is_empty() {
                cut = cut.max(r);
            }
            br.cut_r = cut;
            br.tree = "null".into();
            br.nodes.push(rec);
            return br;
        }
        let keys = rec.keys.clone();
        let mut tree = String::from("{");
        let mut sub_nodes = Vec::new();
        let mut first = true;
        for (ki, &k) in keys.iter().enumerate() {
            let u = b.make(k);
            if b.result().is_some() {
                b.unmake(k, u);
                // only at R = 1, handled above; a key that ends the game is listed as a win
                continue;
            }
            br.book.push((b.to_tps(), r - 1));
            let (mut replies, def_ideas) = self.longest_replies(b, r);
            if ki == 0 {
                rec.def_ideas = def_ideas;
            }
            // order by a cheap q = 0 classify of the next node (fewest winning ideas first)
            // a reply from the hint (the previous stage's line) goes first and skips the cheap pass
            if let Some(pos) = replies.iter().position(|m| self.hint.contains(m)) {
                let h = replies.remove(pos);
                replies.insert(0, h);
            } else if replies.len() > 1 && r - 2 >= 5 {
                let mut scored = Vec::new();
                for &rp in &replies {
                    let u2 = b.make(rp);
                    let c = self.classify(b, r - 2, true, true, self.o.b1);
                    b.unmake(rp, u2);
                    scored.push(((c.ideas.max(1), c.undecided.len()), rp));
                }
                scored.sort_by_key(|x| x.0);
                replies = scored.into_iter().map(|x| x.1).collect();
            }
            if self.o.max_replies > 0 {
                replies.truncate(self.o.max_replies);
            }
            let mut best: Option<(u8, Move, Branch)> = None;
            for &rp in &replies {
                let u2 = b.make(rp);
                let sub = self.node(b, r - 2);
                b.unmake(rp, u2);
                let c = sub.cut_r;
                let better = best.as_ref().map(|x| c < x.0).unwrap_or(true);
                if better {
                    best = Some((c, rp, sub));
                }
                if c == 0 || self.timed_out {
                    break;
                }
            }
            b.unmake(k, u);
            let (c, rp, sub) = match best {
                Some(x) => x,
                None => {
                    // no full-length reply found within budget (should not happen)
                    cut = cut.max(r);
                    continue;
                }
            };
            cut = cut.max(c);
            if !first {
                tree.push(',');
            }
            first = false;
            let _ = write!(tree, "{}:{{\"r\":{},\"n\":{}}}", jstr(&Board::ptn(k)), jstr(&Board::ptn(rp)), sub.tree);
            if ki == 0 {
                rec.reply = Some(rp);
                br.line.push(k);
                br.line.push(rp);
                br.line.extend(sub.line.iter().copied());
            }
            br.book.extend(sub.book);
            sub_nodes.extend(sub.nodes);
        }
        tree.push('}');
        br.tree = tree;
        br.cut_r = cut;
        br.nodes.push(rec);
        br.nodes.extend(sub_nodes);
        br
    }

    /// Hisshi length: upward iteration at q = 1. Returns (L, exact): exact is false when the
    /// disproof at L - 2 did not finish.
    pub fn hisshi_len(&mut self, b: &mut Board, budget: u64, max_p: u8) -> Option<(u8, bool)> {
        let mut p = 1u8;
        let mut last_unknown = false;
        while p <= max_p {
            match self.solve(true, b, true, p, 1, budget, false) {
                Outcome::Proven(_) => return Some((p, !last_unknown)),
                Outcome::Disproven => last_unknown = false,
                _ => {
                    if self.timed_out {
                        return None;
                    }
                    last_unknown = true
                }
            }
            p += 2;
        }
        None
    }
}

/// JSON for one node record.
pub fn node_json(n: &NodeRec) -> String {
    let ms = |v: &Vec<Move>| v.iter().map(|m| jstr(&Board::ptn(*m))).collect::<Vec<_>>().join(",");
    let wins = n
        .wins
        .iter()
        .map(|w| format!("{{\"m\":{},\"idea\":{},\"kind\":\"{}\",\"len\":{}}}", jstr(&Board::ptn(w.m)), jstr(&idea_name(w.m)), match w.kind {
            Kind::Key => "key",
            Kind::Slower => "slower",
            Kind::Quiet => "quiet",
        }, w.len))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"tps\":{},\"R\":{},\"keys\":[{}],\"listedWins\":[{}],\"undecided\":[{}],\"undecidedThreat\":[{}],\"refuted\":{},\"ideas\":{},\"fail\":{},\"stopped\":{},\"defIdeas\":{},\"reply\":{}}}",
        jstr(&n.tps),
        n.r,
        ms(&n.keys),
        wins,
        ms(&n.undecided),
        ms(&n.undecided_threat),
        n.refuted,
        n.ideas,
        n.fail,
        n.stopped,
        n.def_ideas,
        n.reply.map(|m| jstr(&Board::ptn(m))).unwrap_or("null".into())
    )
}
