//! Adversarial checks of the tables and the search (written apart from the author's tests).
use deep::board::*;
use deep::positions::*;
use deep::search::*;

/// Stored 6x6 rows (tps, halfkomi, plies, id) from data/tinue.db, threat-only exact lengths.
const THREAT_ROWS: &[(&str, i32, u8, &str)] = &[
    ("x,2,2,x,2S,1/2,x,2121,211121C,2,x/212221S,1,x2,1,11/1S,2,2,1,1,11/2,2,2,2,1S,12C/x,2,x,1S,2,1 1 33", 0, 7, "pd519942"),
    ("x2,2S,x2,2/x3,12,2,1/x,1112S,1C,112C,221,1/x,1,1,1,2,x/x2,1,x,12,x/x2,1,x,2,x 2 20", 0, 9, "pd343978"),
    ("1,1,1,x2,1/1,1,1,12S,1222121C,121/2,2,2,2,1111112C,1/x,2,2,2,2,1/x,1,2,2,1,1S/2,2,2,1,1,1 2 34", 0, 11, "pd723405"),
    ("x,1,x,2,x2/x,1C,x,1,x2/2,112C,12,11212,x2/x2,2,x3/x2,2,1,x2/2,x2,1,x,1 2 15", 0, 13, "pd411005"),
    ("x3,1,1,1/1,11112C,11,x,1,1/x2,22221S,x,11C,2/x3,2,12,x/x,2,2,2,1,x/2,2,x,2,x,1 1 25", 0, 15, "pd468981"),
];

fn board(tps: &str, hk: i32) -> Board {
    Board::from_tps(tps, hk).unwrap()
}

/// Exact length by many solve() calls of `step` nodes each on the same tables (each call aborts on
/// its budget and the next resumes).
/// A slice must be larger than the depth the search needs to settle any node: with 5-node slices
/// pd519942 makes no progress at p = 7 (every call re-descends the same path and aborts again).
fn exact_in_slices(s: &mut Search, b: &mut Board, step: u64) -> u8 {
    let mut p = 1u8;
    let mut calls = 0u64;
    loop {
        calls += 1;
        assert!(calls < 200_000, "no progress with {step}-node slices at p = {p}");
        match s.solve(b, true, p, 0, step, false) {
            Outcome::Unknown => continue,
            Outcome::Disproven => p += 2,
            Outcome::Proven(_) => return p,
            Outcome::Full => panic!("table full"),
        }
        assert!(p <= 61);
    }
}

#[test]
fn budget_abort_then_resume_gives_the_same_answer() {
    for &(tps, hk, plies, id) in THREAT_ROWS {
        let mut s = Search::new(20);
        let mut b = board(tps, hk);
        for step in [97, 331, 1009] {
            s.reset();
            assert_eq!(exact_in_slices(&mut s, &mut b, step), plies, "{id} step {step}");
            let c = s.check(&mut b, true, false).unwrap_or_else(|e| panic!("{id} step {step}: {e}"));
            assert_eq!(c.len, plies, "{id} step {step} checked length");
        }
        // an unlimited solve interrupted every 50 nodes still ends in a checked proof
        s.reset();
        let mut calls = 0;
        loop {
            calls += 1;
            match s.solve(&mut b, true, UNL, 0, 50, false) {
                Outcome::Unknown => assert!(calls < 100_000, "{id}: no end"),
                Outcome::Proven(_) => break,
                o => panic!("{id}: unlimited sliced {o:?}"),
            }
        }
        let c = s.check(&mut b, true, false).unwrap_or_else(|e| panic!("{id} unlimited sliced: {e}"));
        assert!(c.len >= plies);
    }
}

#[test]
fn table_full_aborts_at_three_quarters_and_reset_recovers() {
    let (tps, hk, plies, id) = THREAT_ROWS[4];
    let mut s = Search::new(9); // 512 Pos and Val entries, 4096 kid slots
    let mut b = board(tps, hk);
    let (o, _) = s.exact(&mut b, 10_000_000, 61);
    assert_eq!(o, Outcome::Full, "{id}");
    let (pu, vu, ku) = s.t.fill();
    assert!(pu * 4 <= 512 * 3 && vu * 4 <= 512 * 3 && ku * 4 <= 4096 * 3, "fill {pu} {vu} {ku}");
    // after a reset the same small table solves an easy row correctly
    let (e, _, l) = (LEN11[0].0, LEN11[0].1, 11u8);
    let mut b2 = board(e, 0);
    s.reset();
    let mut big = Search::new(16);
    let want = big.exact(&mut b2, 2_000_000, 61).0;
    assert_eq!(want, Outcome::Proven(l));
    let got = s.exact(&mut b2, 2_000_000, 61).0;
    assert!(got == Outcome::Proven(l) || got == Outcome::Full, "{got:?}");
    if got == Outcome::Proven(l) {
        assert_eq!(s.check(&mut b2, true, false).unwrap().len, l);
    }
    let _ = plies;
}

#[test]
fn generation_reset_and_wraparound_match_a_fresh_table() {
    let (tps, hk, plies, id) = THREAT_ROWS[3];
    let mut b = board(tps, hk);
    let mut fresh = Search::new(18);
    let want = fresh.exact(&mut b, 4_000_000, 61);
    let want_nodes = fresh.stats.nodes;
    assert_eq!(want.0, Outcome::Proven(plies), "{id}");
    let mut s = Search::new(18);
    // dirty the table with another row first, then reset past the u16 generation wrap
    let (t2, h2, _, _) = THREAT_ROWS[4];
    let mut b2 = board(t2, h2);
    s.exact(&mut b2, 4_000_000, 61);
    for _ in 0..70_000 {
        s.reset();
    }
    let n0 = s.stats.nodes;
    let got = s.exact(&mut b, 4_000_000, 61);
    assert_eq!(got, want, "{id} after wraparound");
    assert_eq!(s.stats.nodes - n0, want_nodes, "{id}: a reset table must search exactly like a fresh one");
    assert_eq!(s.check(&mut b, true, false).unwrap().len, plies);
}

#[test]
fn unlimited_and_depth_limited_agree() {
    let mut s = Search::new(20);
    for &(tps, hk, plies, id) in THREAT_ROWS {
        let mut b = board(tps, hk);
        // unlimited first, then exact lengths on the same tables (proofs of any length are shared)
        s.reset();
        assert!(matches!(s.solve(&mut b, true, UNL, 0, 2_000_000, false), Outcome::Proven(_)), "{id}");
        assert_eq!(s.exact(&mut b, 4_000_000, 61).0, Outcome::Proven(plies), "{id} exact after unlimited");
        assert_eq!(s.check(&mut b, true, false).unwrap().len, plies, "{id}");
        // and one ply short of the length is a disproof at every depth limit below it
        s.reset();
        assert_eq!(s.solve(&mut b, true, plies - 2, 0, 4_000_000, false), Outcome::Disproven, "{id}");
    }
}

/// Stored `pc` rows whose solutions need a quiet attacker move (no threat-only win at all).
const QUIET_ROWS: &[(&str, i32, &str)] = &[
    ("2,2,x,2,112,1/x2,2,2,112,1/x,1,x3,1/1,1,1,21,1,2212C/x3,2,2,1221C/x4,12,1 2 26", 0, "pc346479-51"),
];

#[test]
fn quiet_proofs_and_the_gated_root() {
    let mut s = Search::new(20);
    for &(tps, hk, id) in QUIET_ROWS {
        let mut b = board(tps, hk);
        s.reset();
        assert_eq!(s.solve(&mut b, true, UNL, 0, 2_000_000, false), Outcome::Disproven, "{id} q=0");
        s.reset();
        assert!(matches!(s.solve(&mut b, true, UNL, 1, 3_000_000, false), Outcome::Proven(_)), "{id} q=1");
        let c = s.check(&mut b, true, false).unwrap_or_else(|e| panic!("{id} q=1: {e}"));
        let key = s.entry(b.key).unwrap().best;
        let u = b.make(key);
        let att = 1 - b.stm as usize;
        assert!(!b.threatens(att), "{id}: the key {} should be quiet", Board::ptn(key));
        // the defender position after the quiet key: gated and plain solves with no quiet move left
        s.reset();
        let g = s.solve(&mut b, false, UNL, 0, 3_000_000, true);
        assert!(matches!(g, Outcome::Proven(_)), "{id} gated: {g:?}");
        let cg = s.check(&mut b, false, false).unwrap_or_else(|e| panic!("{id} gated: {e}"));
        assert!(cg.len < c.len);
        s.reset();
        assert!(matches!(s.solve(&mut b, false, UNL, 0, 3_000_000, false), Outcome::Proven(_)), "{id} plain");
        b.unmake(key, u);
    }
}

#[path = "../examples/advcheck.rs"]
mod advcheck;

/// Hard-case rules differential against shared/tak.js (tests/adv-gen.mjs + examples/advcheck.rs):
/// moves, results, keys, win_now, road_in1, threatens, the defender zone and the far-placement
/// shortcut. Skipped when node is not on PATH.
#[test]
fn hard_case_rules_against_tak_js() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let out = match std::process::Command::new("node").args(["--no-warnings", &format!("{dir}/tests/adv-gen.mjs"), "300", "41"]).output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => {
            eprintln!("node not available: hard-case differential skipped");
            return;
        }
    };
    let path = std::env::temp_dir().join(format!("deep-adv-{}.txt", std::process::id()));
    std::fs::write(&path, out).unwrap();
    let (n, errors) = advcheck::check_file(path.to_str().unwrap());
    let _ = std::fs::remove_file(&path);
    assert!(n >= 250, "only {n} positions");
    assert_eq!(errors, 0);
}
