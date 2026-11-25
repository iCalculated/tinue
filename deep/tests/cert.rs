//! Certifier on the MINING.md regression positions (stage A settings) and ladder-step detection.
use deep::board::*;
use deep::cert::*;
use deep::positions::*;
use deep::search::*;

fn stage_a(tps: &str) -> (Branch, bool) {
    let mut s0 = Search::new(20);
    let mut s1 = Search::new(18);
    let mut never = || false;
    let o = CertOpts { lite: true, strict: true, q: 0, b1: 60_000, b2: 20_000, hisshi: false, max_replies: 0 };
    let mut c = Cert::new(&mut s0, &mut s1, o, &mut never);
    let mut b = Board::from_tps(tps, 0).unwrap();
    let br = c.node(&mut b, 11);
    let t = c.timed_out;
    (br, t)
}

#[test]
fn regressions_pass_stage_a() {
    // the two "passes" positions and the one that must be rejected only at C all pass A
    for (tps, key) in [(LEN11[0].0, "Ce5"), (LEN11[1].0, "5b4+14"), (QUIET_POS, "c3")] {
        let (br, t) = stage_a(tps);
        assert!(!t);
        assert_eq!(br.cut_r, 0, "{tps}");
        assert_eq!(Board::ptn(br.line[0]), key);
        assert_eq!(br.line.len(), 10, "key, reply x4, final key and reply: {:?}", br.line.iter().map(|m| Board::ptn(*m)).collect::<Vec<_>>());
        assert!(br.tree.starts_with(&format!("{{\"{key}\":{{\"r\":")));
        assert_eq!(br.tree.matches("\"win\"").count() >= 1, true);
        // book rows: one per key followed, with the remaining length
        assert!(br.book.iter().any(|(_, w)| *w == 10));
        // every node on the line is unique at R >= 7
        for n in &br.nodes {
            if n.r >= 7 {
                assert_eq!(n.ideas, 1);
            }
        }
    }
}

#[test]
fn ladder_steps_detected() {
    let mv = |s: &str| Board::parse_move(s).unwrap();
    // placements next to each other with single-idea replies count; a jump does not
    let line = [mv("a1"), mv("f6"), mv("a2"), mv("f5"), mv("c4"), mv("f4")];
    assert_eq!(ladder_steps(&line, &[1, 1, 1]), 1);
    assert_eq!(ladder_steps(&line, &[2, 1, 1]), 0);
    // a spread starting where the previous spread ended
    let s1 = mv("2a1>11");
    assert_eq!(spread_end(s1), 2);
    let line2 = [s1, mv("f6"), mv("c1+"), mv("f5")];
    assert_eq!(ladder_steps(&line2, &[1, 1]), 1);
}
