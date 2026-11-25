//! The fixed test positions of SOLVER.md section 8 and the MINING.md regressions.

use crate::board::*;
use crate::search::*;

/// SOLVER.md section 8 and the MINING.md regression positions (komi 0 unless given).
pub const MUST_NOT_PROVE: [(&str, i32); 2] = [
    ("211,1,1,21,2,121/2,22,2S,1,1,2/2S,2,1S,12,21S,2/1,1,2,1,2,111/2,21,1,1,212C,2/21222,x,x,x,x,1C 2 30", 0),
    ("2,x,21,1,1,1/x,x,22,x,x,12/1121112S,22,2211,2,x,x/x,x,11,2,11111211112,x/x,x,x,21,x,1/1,12C,1C,1,1,2 2 50", 5),
];
pub const LEN11: [(&str, &str, &str); 2] = [
    ("x,1,1,1,x,x/x,2,2,2,x,x/x,2,2,2,1,x/x,1,2,1,1,1/x,x,2,1,1,x/1,x,2,x,x,2 2 11", "Ce5", "Ce5 d3< f5 d6- d4+ c6- 2d5< 2c3+11 c4+"),
    ("1,x,2,2,2,2/1,x,2,21,x,x/x,21212,1C,1,1,x/2,x,21,1,1,x/x,x,2,12,1,x/x,x,2,1,x,x 2 18", "5b4+14", "5b4+14 2d5+ c6> Sd5 Cc6 a6> b5+ d5+ c6>"),
];
pub const QUIET_POS: &str = "2,x,x,x,2,x/x,x,x,1,2,x/x,112,11211212,x,2,x/x,2,x,1,1C,1/x,1,2,1,x,x/1,x,2,2,x,x 2 19";
pub const QUIET_LINE: [&str; 3] = ["c3", "b2>", "a4"];

pub fn play_line(b: &mut Board, line: &[&str]) -> Result<(), String> {
    for s in line {
        let m = Board::parse_move(s)?;
        if !b.is_legal(m) {
            return Err(format!("illegal {s} at {}", b.to_tps()));
        }
        b.make(m);
        if b.result().is_some() && s != line.last().unwrap() {
            return Err(format!("game over after {s}"));
        }
    }
    Ok(())
}

/// Along a main line from an attacker-to-move root with exact length `len`: each attacker move
/// must leave a defender position won within the plies remaining (q = 0). Returns the number of
/// attacker moves checked, or the first failure.
pub fn check_line(s: &mut Search, root: &Board, line: &str, len: u8, budget: u64) -> Result<usize, String> {
    let mut b = root.clone();
    let moves: Vec<&str> = line.split(' ').collect();
    let mut checked = 0;
    for (i, mv) in moves.iter().enumerate() {
        let m = Board::parse_move(mv)?;
        if !b.is_legal(m) {
            return Err(format!("illegal {mv} at {}", b.to_tps()));
        }
        b.make(m);
        if i % 2 == 0 {
            let r = len as i32 - i as i32 - 1;
            if b.result().is_some() {
                checked += 1;
                break;
            }
            s.reset();
            match s.solve(&mut b, false, r.max(0) as u8, 0, budget, false) {
                Outcome::Proven(_) => checked += 1,
                o => return Err(format!("{mv} (ply {}) not won within {r}: {o:?}", i + 1)),
            }
        }
    }
    Ok(checked)
}

/// The section 8 checks and the MINING.md regressions; returns report lines and whether all passed.
pub fn section8(lp: u32, budget: u64) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut ok = true;
    let mut s = Search::new(lp);
    let mark = |pass: bool, ok: &mut bool| {
        *ok &= pass;
        if pass {
            "ok  "
        } else {
            "FAIL"
        }
    };
    for (tps, hk) in MUST_NOT_PROVE {
        for q in [0u8, 1] {
            let mut b = Board::from_tps(tps, hk).unwrap();
            s.reset();
            let n0 = s.stats.nodes;
            let o = s.solve(&mut b, false, UNL, q, budget, false);
            let pass = !matches!(o, Outcome::Proven(_));
            out.push(format!("{} must-not-prove (and) q={q} halfkomi={hk}: {:?} nodes={}", mark(pass, &mut ok), o, s.stats.nodes - n0));
        }
    }
    for (tps, key, line) in LEN11 {
        let mut b = Board::from_tps(tps, 0).unwrap();
        s.reset();
        let n0 = s.stats.nodes;
        let (o, _) = s.exact(&mut b, budget * 4, 61);
        let n = s.stats.nodes - n0;
        let best = s.entry(b.key).map(|e| Board::ptn(e.best)).unwrap_or_default();
        let chk = s.check(&mut b, true, false);
        let pass = o == Outcome::Proven(11) && best == key && matches!(chk, Ok(ref c) if c.len == 11);
        out.push(format!("{} exact {:?} key {} (want 11, {}) checked length {:?} nodes={n}", mark(pass, &mut ok), o, best, key, chk.map(|c| c.len)));
        let lc = check_line(&mut s, &b, line, 11, budget);
        out.push(format!("{} regression main line {line}: {:?} attacker moves winning in time", mark(lc.is_ok(), &mut ok), lc));
    }
    {
        let mut b = Board::from_tps(QUIET_POS, 0).unwrap();
        play_line(&mut b, &QUIET_LINE).unwrap();
        s.reset();
        let o0 = s.solve(&mut b, false, UNL, 0, budget, false);
        s.reset();
        let o1 = s.solve(&mut b, false, UNL, 1, budget * 4, false);
        let chk = if matches!(o1, Outcome::Proven(_)) { s.check(&mut b, false, false).map(|c| c.len) } else { Err("no proof".into()) };
        let pass = !matches!(o0, Outcome::Proven(_)) && matches!(o1, Outcome::Proven(_)) && chk.is_ok();
        out.push(format!("{} after c3 b2> a4: q=0 {:?}, q=1 {:?} checked length {:?}", mark(pass, &mut ok), o0, o1, chk));
        // MINING: "after c3 b2>, a4 also wins (21 plies or fewer)": a4 plus the defender-root proof
        let total = chk.as_ref().map(|l| 1 + *l as u32).unwrap_or(999);
        out.push(format!("{} regression: a4 wins in {total} plies from after c3 b2> (want <= 21)", mark(total <= 21, &mut ok)));
    }
    (out, ok)
}
