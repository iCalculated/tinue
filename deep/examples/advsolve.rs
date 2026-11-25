//! Adversarial solver driver: every proof is dumped for deep/check-proof.mjs (tak.js only).
//!   advsolve exact  <file> [nodes=] [lp=]          exact threat-only length, dump of that proof
//!   advsolve prove  <file> [nodes=] [lp=] [q=]     unlimited solve at q (0 or 1), dump if proved
//!   advsolve resume <file> [nodes=] [step=] [lp=]  exact length in budget slices vs one call
//! Input lines: `tps|halfkomi|and|tag` (and = 1: the side to move defends). Output per row:
//! `#row<TAB>tag<TAB>outcome<TAB>length<TAB>checked length<TAB>nodes`, then R|/P| dump lines.
use deep::board::*;
use deep::search::*;
use std::collections::HashMap;
use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args[1].clone();
    let o: HashMap<String, String> = args[3..].iter().filter_map(|a| a.split_once('=').map(|(k, v)| (k.to_string(), v.to_string()))).collect();
    let g = |k: &str, d: u64| o.get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let nodes = g("nodes", 2_000_000);
    let lp = g("lp", 21) as u32;
    let q = g("q", 0) as u8;
    let step = g("step", 997);
    let f = std::fs::File::open(&args[2]).expect("open");
    let out = std::io::stdout();
    let mut out = out.lock();
    let mut s = Search::new(lp);
    let mut bad = 0;
    for (i, line) in std::io::BufReader::new(f).lines().map_while(Result::ok).enumerate() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let p: Vec<&str> = line.split('|').collect();
        let hk: i32 = p.get(1).and_then(|x| x.parse().ok()).unwrap_or(0);
        let and = p.get(2).map(|x| *x == "1").unwrap_or(false);
        let tag = p.get(3).copied().unwrap_or("");
        let mut b = Board::from_tps(p[0], hk).unwrap();
        s.reset();
        let n0 = s.stats.nodes;
        let (outc, len) = match mode.as_str() {
            "exact" => {
                let (r, _) = s.exact(&mut b, nodes, g("max", 61) as u8);
                (r, if let Outcome::Proven(l) = r { l } else { 0 })
            }
            "prove" => {
                let r = s.solve(&mut b, !and, UNL, q, nodes, false);
                (r, if let Outcome::Proven(l) = r { l } else { 0 })
            }
            "resume" => {
                // exact length by slices of `step` nodes per solve() call on the same tables
                let mut pl = 1u8;
                let mut r;
                let mut calls = 0u64;
                loop {
                    r = s.solve(&mut b, true, pl, 0, step, false);
                    calls += 1;
                    match r {
                        Outcome::Unknown if calls < nodes / step + 10 => continue,
                        Outcome::Disproven if pl < 61 => pl += 2,
                        _ => break,
                    }
                }
                (r, if let Outcome::Proven(_) = r { pl } else { 0 })
            }
            _ => panic!("mode"),
        };
        let n = s.stats.nodes - n0;
        let os = match outc {
            Outcome::Proven(_) => "proved",
            Outcome::Disproven => "disproved",
            Outcome::Unknown => "unknown",
            Outcome::Full => "full",
        };
        let root_or = mode != "prove" || !and;
        if let Outcome::Proven(_) = outc {
            match s.check(&mut b, root_or, true) {
                Ok(c) => {
                    writeln!(out, "#{i}\t{tag}\t{os}\t{len}\t{}\t{n}", c.len).unwrap();
                    writeln!(out, "R|{}|{hk}|{}", b.to_tps(), (!root_or) as u8).unwrap();
                    for (t, m) in c.dump {
                        writeln!(out, "P|{t}|{m}").unwrap();
                    }
                }
                Err(e) => {
                    bad += 1;
                    writeln!(out, "#{i}\t{tag}\tCHECKFAIL\t{len}\t0\t{n}\t{e}").unwrap();
                }
            }
        } else {
            writeln!(out, "#{i}\t{tag}\t{os}\t0\t0\t{n}").unwrap();
        }
        out.flush().unwrap();
    }
    std::process::exit(if bad > 0 { 1 } else { 0 });
}
