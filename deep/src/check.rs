//! Proof checker (SOLVER.md section 5), run on every proof by the CLI.

use crate::board::*;
use crate::search::*;
use std::collections::{HashMap, HashSet};

/// Result of the proof checker.
#[derive(Debug, Clone)]
pub struct Checked {
    pub len: u8,
    pub positions: usize,
    /// (TPS of an attacker position, its move in PTN)
    pub dump: Vec<(String, String)>,
}

impl Search {
    /// Walk the proof from the root: at attacker nodes play `best`; at defender nodes try every
    /// legal move, skipping those after which the attacker wins at once. Fails on a missing entry,
    /// an illegal move, a non-winning end, or a position already on the path. Uses the attacker
    /// of the last solve().
    pub fn check(&self, b: &mut Board, root_or: bool, want_dump: bool) -> Result<Checked, String> {
        let mut ck = Checker { s: self, memo: HashMap::new(), path: HashSet::new(), dump: Vec::new(), want_dump, mv: Vec::new() };
        let len = if root_or { ck.or(b)? } else { ck.and(b)? };
        Ok(Checked { len, positions: ck.memo.len(), dump: ck.dump })
    }
}

struct Checker<'a> {
    s: &'a Search,
    memo: HashMap<u64, u8>,
    path: HashSet<u64>,
    dump: Vec<(String, String)>,
    want_dump: bool,
    mv: Vec<Vec<Move>>,
}

impl Checker<'_> {
    fn or(&mut self, b: &mut Board) -> Result<u8, String> {
        if let Some(&l) = self.memo.get(&b.key) {
            return Ok(l);
        }
        if self.path.contains(&b.key) {
            return Err(format!("cycle at {}", b.to_tps()));
        }
        let att = self.s.att as usize;
        let e = self.s.entry(b.key).filter(|e| e.min_win > 0 && e.best != NO_MOVE).ok_or_else(|| format!("missing entry at attacker node {}", b.to_tps()))?;
        let m = e.best;
        if !b.is_legal(m) {
            return Err(format!("illegal move {} at {}", Board::ptn(m), b.to_tps()));
        }
        if self.want_dump {
            self.dump.push((b.to_tps(), Board::ptn(m)));
        }
        self.path.insert(b.key);
        let u = b.make(m);
        let r = match b.result() {
            Some(end) if end.winner as usize == att => Ok(1),
            Some(_) => Err(format!("non-winning end after {} at {}", Board::ptn(m), b.to_tps())),
            None => self.and(b).map(|l| l.saturating_add(1)),
        };
        b.unmake(m, u);
        self.path.remove(&b.key);
        let l = r?;
        self.memo.insert(b.key, l);
        Ok(l)
    }

    fn and(&mut self, b: &mut Board) -> Result<u8, String> {
        if let Some(&l) = self.memo.get(&b.key) {
            return Ok(l);
        }
        if self.path.contains(&b.key) {
            return Err(format!("cycle at {}", b.to_tps()));
        }
        let att = self.s.att as usize;
        self.path.insert(b.key);
        let mut moves = self.mv.pop().unwrap_or_default();
        b.legal_moves(&mut moves);
        let mut worst = 1u8;
        let mut err = None;
        for &m in moves.iter() {
            let u = b.make(m);
            let r = match b.result() {
                Some(end) if end.winner as usize == att => Ok(1),
                Some(_) => Err(format!("defender reply {} ends the game without an attacker win at {}", Board::ptn(m), b.to_tps())),
                None => {
                    if b.win_now().is_some() {
                        Ok(1)
                    } else {
                        self.or(b)
                    }
                }
            };
            b.unmake(m, u);
            match r {
                Ok(l) => worst = worst.max(l),
                Err(e) => {
                    err = Some(e);
                    break;
                }
            }
        }
        self.mv.push(moves);
        self.path.remove(&b.key);
        if let Some(e) = err {
            return Err(e);
        }
        let l = worst.saturating_add(1);
        self.memo.insert(b.key, l);
        Ok(l)
    }
}
