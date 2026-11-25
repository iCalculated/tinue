//! Search: SOLVER.md section 8, the MINING.md regressions, and exact lengths of stored rows.
use deep::board::*;
use deep::positions::*;
use deep::search::*;

#[test]
fn section8_and_regressions() {
    let (lines, ok) = section8(20, 2_000_000);
    assert!(ok, "{lines:#?}");
}

/// Stored `pd` 6x6 rows (tps, halfkomi, plies, id) from data/tinue.db. pd731708 is stored with
/// plies = 9 but its own tree, shared/pns.js and deep all give 15 (see deep/README.md).
const ROWS: &[(&str, i32, u8, &str)] = &[
    ("x,2,2,x,2S,1/2,x,2121,211121C,2,x/212221S,1,x2,1,11/1S,2,2,1,1,11/2,2,2,2,1S,12C/x,2,x,1S,2,1 1 33", 0, 7, "pd519942"),
    ("x2,2,x2,2/x3,21,2,12/x2,21C,x,21,2/1,1,x,1121112C,x,1/x,1,x,212,x2/1,x,2,2,x2 2 23", 0, 7, "pd580134"),
    ("x2,2S,x2,2/x3,12,2,1/x,1112S,1C,112C,221,1/x,1,1,1,2,x/x2,1,x,12,x/x2,1,x,2,x 2 20", 0, 9, "pd343978"),
    ("x2,121S,x,2,1/x2,1,12,12,x/x2,1,21C,1,12/2,x3,12,1/2,x2,2,1,1/2,x2,2,x,1 1 18", 5, 9, "pd447929"),
    ("1,21,x,1,1,2/2,21S,x,1,2S,2/2,2,x,1,21,2/x,2,1212,2S,21C,1/x,22,2,211111212C,221,1/x,1,2,21S,2S,12 2 41", 4, 11, "pd614842"),
    ("1,1,1,x2,1/1,1,1,12S,1222121C,121/2,2,2,2,1111112C,1/x,2,2,2,2,1/x,1,2,2,1,1S/2,2,2,1,1,1 2 34", 0, 11, "pd723405"),
    ("2,x5/x6/x,2C,2,2,x2/x,12,1,1,1,1/1,2,x,1,x2/1,1,12,2,x2 1 11", 5, 13, "pd844537"),
    ("x,1,x,2,x2/x,1C,x,1,x2/2,112C,12,11212,x2/x2,2,x3/x2,2,1,x2/2,x2,1,x,1 2 15", 0, 13, "pd411005"),
    ("x3,1,1,1/1,11112C,11,x,1,1/x2,22221S,x,11C,2/x3,2,12,x/x,2,2,2,1,x/2,2,x,2,x,1 1 25", 0, 15, "pd468981"),
    ("22221,2,x3,2/x,2,2,1,2,x/1,2,2,2,1,x/1,2,1C,12C,1,x/1,1,1,1,212S,x/x3,1,2,1 2 20", 0, 15, "pd107822"),
    ("1,x2,1S,x,2/2221S,121C,1,1,2122112112,11/1,x,12S,12,x,112/x,121112,x,112S,21S,x/2,2,2,2C,1S,x/x,12,x,2,1S,1 1 65", 0, 15, "pd731708"),
];

#[test]
fn exact_lengths_of_stored_rows() {
    let mut s = Search::new(20);
    for &(tps, hk, plies, id) in ROWS {
        let mut b = Board::from_tps(tps, hk).unwrap();
        s.reset();
        let (o, _) = s.exact(&mut b, 4_000_000, 61);
        assert_eq!(o, Outcome::Proven(plies), "{id}");
        let c = s.check(&mut b, true, true).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(c.len, plies, "{id} checked length");
        // the unlimited proof is checked too, and is never shorter than the exact length
        s.reset();
        match s.solve(&mut b, true, UNL, 0, 2_000_000, false) {
            Outcome::Proven(_) => {
                let c = s.check(&mut b, true, false).unwrap_or_else(|e| panic!("{id} unlimited: {e}"));
                assert!(c.len >= plies, "{id}: unlimited proof {} shorter than exact {plies}", c.len);
            }
            o => panic!("{id}: unlimited {o:?}"),
        }
    }
}

#[test]
fn quiet_search_finds_no_less_than_threats() {
    let mut s = Search::new(20);
    for &(tps, hk, _, id) in ROWS {
        let mut b = Board::from_tps(tps, hk).unwrap();
        s.reset();
        let o = s.solve(&mut b, true, UNL, 1, 2_000_000, false);
        assert!(matches!(o, Outcome::Proven(_)), "{id} q=1: {o:?}");
        s.check(&mut b, true, false).unwrap_or_else(|e| panic!("{id} q=1: {e}"));
    }
}
