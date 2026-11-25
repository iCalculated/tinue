//! Adversarial rules check against shared/tak.js data written by tests/adv-gen.mjs.
//!   node --no-warnings deep/tests/adv-gen.mjs 2000 7 > adv.txt
//!   cargo run --release --example advcheck adv.txt
//! Compares, per position: the legal move set (and is_legal on every move encoding), the result of
//! every move, Zobrist keys and unmake, win_now (existence and that its move wins), road_in1 for both
//! colours, threatens() after every move, whether the opponent can win at once after every move, the
//! defender zone of SOLVER.md 3 (every move outside it must lose at once), and the far-placement
//! shortcut of the OR expansion. Exits 1 on any mismatch.
use deep::board::*;
use std::collections::{HashMap, HashSet};
use std::io::BufRead;

#[derive(Default)]
struct Tally {
    positions: usize,
    moves: usize,
    ends: usize,
    zone_tested: usize,
    zone_moves_outside: usize,
    far_tested: usize,
    wall_threat_missed: usize,
    errors: HashMap<&'static str, usize>,
    shown: usize,
}
impl Tally {
    fn err(&mut self, kind: &'static str, msg: String) {
        *self.errors.entry(kind).or_default() += 1;
        if self.shown < 40 {
            self.shown += 1;
            println!("{kind}: {msg}");
        }
    }
}

fn win_code(c: usize) -> [String; 2] {
    [format!("r{}", c + 1), format!("f{}", c + 1)]
}

/// The defender zone exactly as Search::expand_and builds it (SOLVER.md 3).
fn zone(b: &mut Board) -> Option<u64> {
    let def = b.stm as usize;
    let att = 1 - def;
    let empties = b.empty().count_ones() as usize;
    let w = b.road_in1(att)?;
    if empties < N || b.reserves(def) < 2 {
        return None;
    }
    b.pass();
    let u = b.make(w);
    let r = b.road(att);
    let ns = flood(r, r & NORTH) & flood(r, r & SOUTH);
    let ew = flood(r, r & EAST) & flood(r, r & WEST);
    b.unmake(w, u);
    b.pass();
    Some(ns | ew | mv_squares(w))
}

#[allow(dead_code)]
fn main() {
    let path = std::env::args().nth(1).expect("advcheck <file>");
    let (_, errors) = check_file(&path);
    std::process::exit(if errors == 0 { 0 } else { 1 });
}

/// Returns (positions checked, mismatches).
pub fn check_file(path: &str) -> (usize, usize) {
    let f = std::fs::File::open(path).expect("open");
    let mut t = Tally::default();
    for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split('|').collect();
        let tps = parts[0];
        let hk: i32 = parts[1].parse().unwrap();
        let mut b = match Board::from_tps(tps, hk) {
            Ok(b) => b,
            Err(e) => {
                t.err("parse", format!("{tps}: {e}"));
                continue;
            }
        };
        if b.empty() == 0 {
            continue; // a full board is a finished game
        }
        t.positions += 1;
        if b.key != b.compute_key() {
            t.err("key", format!("root {tps}"));
        }
        if b.to_tps() != tps {
            t.err("tps", format!("{tps} -> {}", b.to_tps()));
        }
        let me = b.stm as usize;
        // tak.js move table
        let mut js: Vec<(String, String, String, String)> = Vec::new();
        for cell in parts[2].split(' ').filter(|c| !c.is_empty()) {
            let v: Vec<&str> = cell.split(':').collect();
            js.push((v[0].into(), v[1].into(), v[2].into(), v[3].into()));
        }
        let js_set: HashSet<String> = js.iter().map(|x| x.0.clone()).collect();
        let roads: [HashSet<String>; 2] = [3, 4].map(|i| parts[i][3..].split(',').filter(|s| !s.is_empty()).map(String::from).collect());
        // legal moves
        let mut moves = Vec::new();
        b.legal_moves(&mut moves);
        let mine: Vec<String> = moves.iter().map(|&m| Board::ptn(m)).collect();
        let mine_set: HashSet<String> = mine.iter().cloned().collect();
        if mine_set.len() != mine.len() {
            t.err("dup", tps.into());
        }
        if mine_set != js_set {
            let extra: Vec<_> = mine_set.difference(&js_set).take(5).collect();
            let miss: Vec<_> = js_set.difference(&mine_set).take(5).collect();
            t.err("legal", format!("{tps}: deep extra {extra:?} missing {miss:?}"));
        }
        // is_legal over every encoding
        for sq in 0..NN {
            let mut all: Vec<Move> = (0..3u16).map(|ty| mv_place(sq, ty)).collect();
            for dir in 0..4 {
                for pat in 0..NPAT {
                    all.push(mv_spread(sq, dir, pat));
                }
            }
            for m in all {
                if b.is_legal(m) != js_set.contains(&Board::ptn(m)) {
                    t.err("is_legal", format!("{tps}: {} deep {}", Board::ptn(m), b.is_legal(m)));
                }
            }
        }
        // win_now / road_in1 at the root
        let wc = win_code(me);
        let any_win = js.iter().any(|x| wc.contains(&x.1));
        match b.win_now() {
            None if any_win => t.err("win_now-miss", format!("{tps}|{hk}")),
            Some(m) => match js.iter().find(|x| x.0 == Board::ptn(m)) {
                Some(x) if wc.contains(&x.1) => {}
                _ => t.err("win_now-false", format!("{tps}|{hk}: {}", Board::ptn(m))),
            },
            _ => {}
        }
        for c in 0..2 {
            match b.road_in1(c) {
                None if !roads[c].is_empty() => t.err("road_in1-miss", format!("{tps}|{hk} colour {}: {:?}", c + 1, roads[c].iter().take(3).collect::<Vec<_>>())),
                Some(m) if !roads[c].contains(&Board::ptn(m)) => t.err("road_in1-false", format!("{tps}|{hk} colour {}: {}", c + 1, Board::ptn(m))),
                _ => {}
            }
        }
        // per-move: result, key, unmake, opponent win, threatens
        let before = b.clone();
        let empties = b.empty().count_ones() as usize;
        // both expansions test win_now first, so their shortcuts only run when the mover cannot win
        let far = !any_win && empties >= N + 1 && b.reserves(me) >= 2 && b.reserves(1 - me) >= 2;
        let near_walls = empties <= 3 || b.reserves(me) <= 3;
        let def_threat = b.road_in1(1 - me).is_some();
        let z = if any_win { None } else { zone(&mut b) };
        if z.is_some() {
            t.zone_tested += 1;
        }
        if far {
            t.far_tested += 1;
        }
        for (ptn, end, opp, slf) in js.iter() {
            let m = match Board::parse_move(ptn) {
                Ok(m) => m,
                Err(e) => {
                    t.err("ptn", format!("{ptn}: {e}"));
                    continue;
                }
            };
            t.moves += 1;
            let u = b.make(m);
            if b.key != b.compute_key() {
                t.err("key", format!("{tps} after {ptn}"));
            }
            let r = b.result();
            let code = match r {
                None => "-".to_string(),
                Some(e) if e.winner == 2 => "d".to_string(),
                Some(e) => format!("{}{}", if e.road { 'r' } else { 'f' }, e.winner + 1),
            };
            if r.is_some() {
                t.ends += 1;
            }
            if &code != end {
                t.err("result", format!("{tps}|{hk} {ptn}: deep {code} tak.js {end}"));
            }
            if r.is_none() {
                // the opponent to move: can it win at once?
                let ow = b.win_now();
                if ow.is_some() != (opp == "1") {
                    t.err("opp-win", format!("{tps}|{hk} after {ptn}: deep {} tak.js {opp}", ow.is_some()));
                }
                if let Some(w) = ow {
                    if !b.is_legal(w) {
                        t.err("opp-win-illegal", format!("{tps}|{hk} after {ptn}: {}", Board::ptn(w)));
                    }
                }
                let th = b.threatens(me);
                if th != (slf == "1") {
                    t.err("threatens", format!("{tps}|{hk} after {ptn}: deep {th} tak.js {slf}"));
                }
                if !any_win && !is_spread(m) && mv_type(m) == WALL && !near_walls && slf == "1" {
                    t.wall_threat_missed += 1;
                    if t.wall_threat_missed <= 5 {
                        println!("note: wall threat outside the wall window: {tps}|{hk} {ptn} (empties {empties})");
                    }
                }
                // OR expansion shortcut for far placements: no game end, defender win only by a road
                // and only if the defender already threatened
                if far && !is_spread(m) {
                    let dw = def_threat && b.road_in1(1 - me).is_some();
                    if dw != (opp == "1") {
                        t.err("far-shortcut", format!("{tps}|{hk} {ptn}: deep {dw} tak.js {opp}"));
                    }
                }
            } else if far && !is_spread(m) {
                t.err("far-ends", format!("{tps}|{hk} {ptn} ends the game"));
            }
            b.unmake(m, u);
            if b != before {
                t.err("unmake", format!("{tps} {ptn}"));
                b = before.clone();
            }
            // defender zone: a move outside it must leave the attacker an immediate win
            if let Some(zz) = z {
                if mv_squares(m) & zz == 0 {
                    t.zone_moves_outside += 1;
                    let att_wins = win_code(1 - me).contains(end) || (end == "-" && opp == "1");
                    if !att_wins {
                        t.err("zone", format!("{tps}|{hk}: {ptn} is outside the zone but does not lose at once ({end}/{opp})"));
                    }
                }
            }
        }
    }
    println!(
        "advcheck: {} positions, {} moves, {} ending moves, zone tested at {} positions ({} outside moves), far shortcut at {}, wall threats outside the window {}",
        t.positions, t.moves, t.ends, t.zone_tested, t.zone_moves_outside, t.far_tested, t.wall_threat_missed
    );
    let total: usize = t.errors.values().sum();
    println!("errors: {total} {:?}", t.errors);
    (t.positions, total)
}
