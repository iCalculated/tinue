//! Rules layer: perft, brute force, TPS/PTN round trips, and the tak.js differential test.
use deep::board::*;
use deep::testkit::*;

#[test]
fn perft_6x6_depth4() {
    let mut b = Board::new();
    assert_eq!(perft(&mut b, 4, &mut Vec::new()), 13_586_048);
}

#[test]
fn win_now_and_road_in1_match_brute_force() {
    let (n, wins, flats, roads, errs) = brute_check(200_000, 99, 5);
    assert!(errs.is_empty(), "{errs:#?}");
    assert!(n >= 200_000 && wins > 1000 && flats > 1000 && roads > 1000, "coverage: {wins} wins, {flats} flat, {roads} roads");
}

#[test]
fn tps_ptn_round_trip_and_make_unmake() {
    let mut rng = Rng(7);
    let mut moves = Vec::new();
    for g in 0..300 {
        let mut b = Board::new();
        b.halfkomi = (g % 7) as i32;
        loop {
            let parsed = Board::from_tps(&b.to_tps(), b.halfkomi).unwrap();
            assert_eq!(parsed, b, "TPS round trip {}", b.to_tps());
            assert_eq!(b.key, b.compute_key());
            b.legal_moves(&mut moves);
            let before = b.clone();
            for &m in moves.iter() {
                assert_eq!(Board::parse_move(&Board::ptn(m)).unwrap(), m, "PTN {}", Board::ptn(m));
                assert!(b.is_legal(m));
                let u = b.make(m);
                assert_eq!(b.key, b.compute_key(), "key after {}", Board::ptn(m));
                b.unmake(m, u);
                assert_eq!(b, before, "unmake {}", Board::ptn(m));
            }
            let m = random_move(&b, &mut rng, g, &mut moves);
            b.make(m);
            if b.result().is_some() {
                break;
            }
        }
    }
}

/// Generates playouts with shared/tak.js (needs node) and compares every legal move set and the
/// result of every legal move. Skipped when node is not on PATH.
#[test]
fn differential_against_tak_js() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let out = match std::process::Command::new("node").args(["--no-warnings", &format!("{dir}/tests/gen-diff.mjs"), "120", "5"]).output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => {
            eprintln!("node not available: differential test skipped");
            return;
        }
    };
    let mut errs = Vec::new();
    let st = diff_check(std::io::Cursor::new(out), &mut |m| errs.push(m));
    assert!(st.positions > 5_000, "{st:?}");
    assert_eq!(st.errors, 0, "{:#?}", &errs[..errs.len().min(10)]);
}
