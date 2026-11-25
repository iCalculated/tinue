//! Test support: a small RNG, random playouts, brute-force references, perft, and the fixed test
//! positions of SOLVER.md section 8 and the MINING.md regressions.

use crate::board::*;
use std::collections::{HashMap, HashSet};
use std::io::BufRead;

pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    pub fn chance(&mut self, p: f64) -> bool {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }
}

pub fn perft(b: &mut Board, d: u32, buf: &mut Vec<Vec<Move>>) -> u64 {
    if d == 0 {
        return 1;
    }
    let mut moves = buf.pop().unwrap_or_default();
    b.legal_moves(&mut moves);
    let mut n = 0;
    for &m in moves.iter() {
        if d == 1 {
            n += 1;
            continue;
        }
        let u = b.make(m);
        n += if b.result().is_some() { 1 } else { perft(b, d - 1, buf) };
        b.unmake(m, u);
    }
    buf.push(moves);
    n
}

/// Does the side to move have a winning move? (every legal move, made and scored)
pub fn brute_win(b: &mut Board) -> Option<Move> {
    let me = b.stm;
    let mut moves = Vec::new();
    b.legal_moves(&mut moves);
    for m in moves {
        let u = b.make(m);
        let w = matches!(b.result(), Some(End { winner, .. }) if winner == me);
        b.unmake(m, u);
        if w {
            return Some(m);
        }
    }
    None
}

/// Can colour c (made the mover) complete a road this move?
pub fn brute_road(b: &mut Board, c: usize) -> bool {
    let flip = b.stm as usize != c;
    if flip {
        b.pass();
    }
    let mut moves = Vec::new();
    b.legal_moves(&mut moves);
    let mut found = false;
    for m in moves {
        let u = b.make(m);
        let w = has_road_set(b.road(c));
        b.unmake(m, u);
        if w {
            found = true;
            break;
        }
    }
    if flip {
        b.pass();
    }
    found
}

/// Random playout policies: how often to prefer placements and walls, to reach flat endings and
/// reserve exhaustion as well as roads.
pub fn random_move(b: &Board, rng: &mut Rng, style: usize, moves: &mut Vec<Move>) -> Move {
    b.legal_moves(moves);
    let (pp, pw) = match style % 4 {
        0 => (0.0, 0.0),
        1 => (0.6, 0.2),
        2 => (0.9, 0.4),
        _ => (0.97, 0.1),
    };
    if rng.chance(pp) {
        let places: Vec<Move> = moves.iter().copied().filter(|&m| !is_spread(m)).collect();
        if !places.is_empty() {
            if rng.chance(pw) {
                let walls: Vec<Move> = places.iter().copied().filter(|&m| mv_type(m) == WALL).collect();
                if !walls.is_empty() {
                    return walls[rng.below(walls.len())];
                }
            }
            return places[rng.below(places.len())];
        }
    }
    moves[rng.below(moves.len())]
}

/// Check win_now and road_in1 (both colours) against brute force on `count` random playout
/// positions. Returns (positions, wins found, flat wins found, road-in-1s over both colours, errors).
pub fn brute_check(count: usize, seed: u64, max_err: usize) -> (usize, usize, usize, usize, Vec<String>) {
    let mut rng = Rng(seed);
    let mut errs = Vec::new();
    let (mut n, mut wins, mut flats) = (0, 0, 0);
    let mut roads = [0usize; 2];
    let mut moves = Vec::new();
    let mut g = 0usize;
    while n < count && errs.len() < max_err {
        let mut b = Board::new();
        b.halfkomi = rng.below(9) as i32;
        let style = g;
        g += 1;
        loop {
            n += 1;
            let bw = brute_win(&mut b);
            let fw = b.win_now();
            if bw.is_some() != fw.is_some() {
                errs.push(format!("win_now {:?} brute {:?} at {}|{}", fw.map(Board::ptn), bw.map(Board::ptn), b.to_tps(), b.halfkomi));
            }
            if let Some(m) = fw {
                wins += 1;
                let me = b.stm;
                let ok = b.is_legal(m) && {
                    let u = b.make(m);
                    let r = b.result();
                    b.unmake(m, u);
                    if let Some(e) = r {
                        if !e.road {
                            flats += 1;
                        }
                    }
                    matches!(r, Some(End { winner, .. }) if winner == me)
                };
                if !ok {
                    errs.push(format!("win_now move {} does not win at {}|{}", Board::ptn(m), b.to_tps(), b.halfkomi));
                }
            }
            for c in 0..2 {
                let r1 = b.road_in1(c);
                let br = b.ply >= 2 && brute_road(&mut b, c);
                if br {
                    roads[c] += 1;
                }
                if r1.is_some() != br {
                    errs.push(format!("road_in1({c}) {:?} brute {} at {}", r1.map(Board::ptn), br, b.to_tps()));
                } else if let Some(m) = r1 {
                    let flip = b.stm as usize != c;
                    if flip {
                        b.pass();
                    }
                    let ok = b.is_legal(m) && {
                        let u = b.make(m);
                        let w = has_road_set(b.road(c));
                        b.unmake(m, u);
                        w
                    };
                    if flip {
                        b.pass();
                    }
                    if !ok {
                        errs.push(format!("road_in1({c}) move {} is not a road at {}", Board::ptn(m), b.to_tps()));
                    }
                }
            }
            if n >= count || errs.len() >= max_err {
                break;
            }
            // half the games dodge game-ending moves when they can, so threats pile up
            let mut m = random_move(&b, &mut rng, style, &mut moves);
            if (style / 4) % 2 == 1 {
                for _ in 0..12 {
                    let u = b.make(m);
                    let ends = b.result().is_some();
                    b.unmake(m, u);
                    if !ends {
                        break;
                    }
                    m = random_move(&b, &mut rng, style, &mut moves);
                }
            }
            b.make(m);
            if b.result().is_some() {
                break;
            }
        }
    }
    (n, wins, flats, roads[0] + roads[1], errs)
}

#[derive(Debug, Default)]
pub struct DiffStats {
    pub positions: usize,
    pub moves: usize,
    pub ends: usize,
    pub kinds: Vec<(String, usize)>,
    pub errors: usize,
}

/// Differential test: lines `tps|halfkomi|played|moves|ends` per position of a tak.js playout,
/// `#game` between playouts. Checks TPS round trip, Zobrist after incremental make, legal move
/// sets, the result of every legal move, unmake, and win_now against tak.js's own move results.
pub fn diff_check<R: BufRead>(input: R, report: &mut dyn FnMut(String)) -> DiffStats {
    let mut errs = 0usize;
    let (mut npos, mut nmoves, mut nends) = (0usize, 0usize, 0usize);
    let mut kinds: HashMap<String, usize> = HashMap::new();
    let mut cur: Option<Board> = None;
    let mut moves = Vec::new();
    for line in input.lines().map_while(Result::ok) {
        if line.starts_with('#') {
            cur = None;
            continue;
        }
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 5 {
            continue;
        }
        let (tps, hk, played, js_moves, js_ends) = (parts[0], parts[1].parse::<i32>().unwrap(), parts[2], parts[3], parts[4]);
        let mut fresh = match Board::from_tps(tps, hk) {
            Ok(b) => b,
            Err(e) => {
                report(format!("parse error {e}: {tps}"));
                errs += 1;
                cur = None;
                continue;
            }
        };
        npos += 1;
        let mut report = |msg: String| {
            errs += 1;
            report(msg);
        };
        if fresh.to_tps() != tps {
            report(format!("TPS round trip {} vs {tps}", fresh.to_tps()));
        }
        if let Some(c) = &cur {
            if *c != fresh {
                report(format!("incremental board differs from parsed at {tps} (key {:x} vs {:x})", c.key, fresh.key));
            }
        }
        fresh.legal_moves(&mut moves);
        let mine: HashSet<String> = moves.iter().map(|&m| Board::ptn(m)).collect();
        let theirs: HashSet<String> = js_moves.split(' ').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
        if mine != theirs || mine.len() != moves.len() {
            let a: Vec<_> = mine.difference(&theirs).take(5).collect();
            let b: Vec<_> = theirs.difference(&mine).take(5).collect();
            report(format!("move sets differ at {tps}: extra {a:?} missing {b:?} (dupes {})", moves.len() - mine.len()));
        }
        let ends: HashMap<&str, &str> = js_ends.split(' ').filter(|s| !s.is_empty()).filter_map(|s| s.rsplit_once(':')).collect();
        let me = fresh.stm;
        let mut js_win = false;
        for (_, code) in ends.iter() {
            let w = match *code {
                "r1" | "f1" => 0,
                "r2" | "f2" => 1,
                _ => 2,
            };
            if w == me {
                js_win = true;
            }
        }
        let before = fresh.clone();
        for &m in moves.iter() {
            nmoves += 1;
            let u = fresh.make(m);
            if fresh.key != fresh.compute_key() {
                report(format!("incremental key wrong after {} at {tps}", Board::ptn(m)));
            }
            let r = fresh.result().map(|e| match (e.winner, e.road) {
                (0, true) => "r1",
                (1, true) => "r2",
                (0, false) => "f1",
                (1, false) => "f2",
                _ => "d",
            });
            fresh.unmake(m, u);
            if fresh != before {
                report(format!("unmake of {} did not restore {tps}", Board::ptn(m)));
                fresh = before.clone();
            }
            let p = Board::ptn(m);
            let js = ends.get(p.as_str()).copied();
            if let Some(x) = r {
                nends += 1;
                *kinds.entry(x.to_string()).or_default() += 1;
            }
            if r != js {
                report(format!("result of {p} at {tps}|{hk}: mine {r:?} tak.js {js:?}"));
            }
        }
        let wn = fresh.win_now();
        if wn.is_some() != js_win {
            report(format!("win_now {:?} but tak.js win {js_win} at {tps}|{hk}", wn.map(Board::ptn)));
        }
        cur = None;
        if !played.is_empty() {
            match Board::parse_move(played) {
                Ok(m) if fresh.is_legal(m) => {
                    fresh.make(m);
                    cur = Some(fresh);
                }
                _ => report(format!("cannot play {played} at {tps}")),
            }
        }
    }
    let mut k: Vec<_> = kinds.into_iter().collect();
    k.sort();
    DiffStats { positions: npos, moves: nmoves, ends: nends, kinds: k, errors: errs }
}

