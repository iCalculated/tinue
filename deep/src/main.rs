//! deep CLI. Input lines are `tps|halfkomi` (further `|` fields are ignored; `#` lines skipped).
//!
//!   deep test [n=1000000] [lp=20]
//!   deep perft <depth> [tps]
//!   deep diff <file>                       differential test against tak.js data (tests/gen-diff.mjs)
//!   deep prove <file> [secs=] [nodes=] [p=] [q=0|1] [and=1] [gated=1] [dump=1] [lp=]
//!   deep up <file> <shard> <nshards> <nodes> [lp=] [max=] [secs=]
//!   deep cert <file> <shard> <nshards> <b1> [lite=1] [strict=1] [q=1] [b2=] [tl=] [lp=] [hisshi=1] [maxrep=] [lb=]
//!   deep walk <file> <shard> <nshards> [secs=10] [nodes=3000000] [min=11] [fails=2] [lp=]
//!   deep bench <file> [mode=up|prove] [nodes=] [q=] [lp=]   one core: nodes/s, bytes/node, times

use deep::board::*;
use deep::search::*;
use deep::positions::*;
use deep::testkit::*;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::time::Instant;

fn opts(args: &[String]) -> HashMap<String, String> {
    args.iter().filter_map(|a| a.split_once('=').map(|(k, v)| (k.to_string(), v.to_string()))).collect()
}
fn opt<T: std::str::FromStr>(o: &HashMap<String, String>, k: &str, d: T) -> T {
    o.get(k).and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn rows(path: &str) -> Vec<(String, i32)> {
    let f = std::fs::File::open(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    std::io::BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| {
            let mut it = l.split('|');
            let tps = it.next().unwrap().trim().to_string();
            let hk = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
            (tps, hk)
        })
        .collect()
}

fn stop_after(secs: f64) -> Option<StopFn> {
    if secs <= 0.0 {
        return None;
    }
    let t0 = Instant::now();
    Some(Box::new(move |_| t0.elapsed().as_secs_f64() > secs))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("help");
    let o = opts(&args[2.min(args.len())..]);
    let pos: Vec<&String> = args.iter().skip(2).filter(|a| !a.contains('=')).collect();
    let code = match cmd {
        "perft" => {
            let d: u32 = pos.first().and_then(|x| x.parse().ok()).unwrap_or(4);
            let mut b = if pos.len() > 1 { Board::from_tps(&pos[1..].iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" "), 0).unwrap() } else { Board::new() };
            let t = Instant::now();
            let mut buf = Vec::new();
            for dd in 1..=d {
                println!("perft {dd} = {}", perft(&mut b, dd, &mut buf));
            }
            println!("{:.2}s", t.elapsed().as_secs_f64());
            0
        }
        "test" => cmd_test(&o),
        "bench" => cmd_bench(pos.first().expect("deep bench <file>"), &o),
        "diff" => cmd_diff(pos.first().expect("deep diff <file>")),
        "prove" => cmd_prove(pos.first().expect("deep prove <file>"), &o),
        "up" => {
            if pos.len() < 4 {
                eprintln!("deep up <file> <shard> <nshards> <nodes>");
                2
            } else {
                cmd_up(pos[0], pos[1].parse().unwrap(), pos[2].parse().unwrap(), pos[3].parse().unwrap(), &o)
            }
        }
        "walk" => {
            if pos.len() < 3 {
                eprintln!("deep walk <file> <shard> <nshards> [secs=10] [nodes=3000000] [min=11] [fails=2] [lp=]");
                2
            } else {
                cmd_walk(pos[0], pos[1].parse().unwrap(), pos[2].parse().unwrap(), &o)
            }
        }
        "cert" => {
            if pos.len() < 4 {
                eprintln!("deep cert <file> <shard> <nshards> <b1> [lite=1] [strict=1] [q=1] [b2=] [tl=] [lp=] [hisshi=1] [maxrep=]");
                2
            } else {
                cmd_cert(pos[0], pos[1].parse().unwrap(), pos[2].parse().unwrap(), pos[3].parse().unwrap(), &o)
            }
        }
        _ => {
            eprintln!("usage: deep test | perft <d> [tps] | diff <file> | prove <file> [secs= nodes= q= and= gated= dump= lp=] | up <file> <shard> <nshards> <nodes> [lp= max=]");
            2
        }
    };
    std::process::exit(code);
}

fn cmd_test(o: &HashMap<String, String>) -> i32 {
    let mut ok = true;
    let t = Instant::now();
    let mut b = Board::new();
    let p4 = perft(&mut b, 4, &mut Vec::new());
    let pass = p4 == 13_586_048;
    ok &= pass;
    println!("{} perft 6x6 depth 4 = {p4} (want 13586048) {:.1}s", if pass { "ok  " } else { "FAIL" }, t.elapsed().as_secs_f64());
    let n: usize = opt(o, "n", 1_000_000);
    let t = Instant::now();
    let (cnt, wins, flats, roads, errs) = brute_check(n, opt(o, "seed", 12345u64), 20);
    ok &= errs.is_empty();
    println!("{} winNow/roadIn1 vs brute force: {cnt} positions, {wins} with a win for the mover ({flats} flat), {roads} road-in-1s (either colour), {} errors {:.1}s", if errs.is_empty() { "ok  " } else { "FAIL" }, errs.len(), t.elapsed().as_secs_f64());
    for e in errs.iter().take(10) {
        println!("    {e}");
    }
    let t = Instant::now();
    let (lines, p8) = section8(opt(o, "lp", 20), opt(o, "nodes", 2_000_000));
    ok &= p8;
    for l in lines {
        println!("{l}");
    }
    println!("section 8 {:.1}s", t.elapsed().as_secs_f64());
    println!("{}", if ok { "ALL OK" } else { "FAILURES" });
    if ok {
        0
    } else {
        1
    }
}

fn cmd_diff(path: &str) -> i32 {
    let f = std::fs::File::open(path).expect("open");
    let mut shown = 0;
    let st = diff_check(std::io::BufReader::new(f), &mut |m| {
        shown += 1;
        if shown <= 30 {
            println!("{m}");
        }
    });
    println!("diff: {} positions, {} moves, {} game-ending moves {:?}, {} errors", st.positions, st.moves, st.ends, st.kinds, st.errors);
    if st.errors == 0 {
        0
    } else {
        1
    }
}

fn outcome_str(o: Outcome) -> &'static str {
    match o {
        Outcome::Proven(_) => "proved",
        Outcome::Disproven => "disproved",
        Outcome::Unknown => "unknown",
        Outcome::Full => "full",
    }
}

/// Unlimited-depth proof per row. Output: row, result, checked length, minWin, nodes, ms, best.
/// With dump=1, each proof follows as `R|tps|halfkomi|and` and `P|tps|move` lines.
fn cmd_prove(path: &str, o: &HashMap<String, String>) -> i32 {
    let lp: u32 = opt(o, "lp", 22);
    let secs: f64 = opt(o, "secs", 0.0);
    let nodes: u64 = opt(o, "nodes", u64::MAX / 4);
    let q: u8 = opt(o, "q", 0);
    let and = opt(o, "and", 0) == 1;
    let gated = opt(o, "gated", 0) == 1;
    let dump = opt(o, "dump", 0) == 1;
    let plim: u8 = opt(o, "p", UNL); // depth limit (default unlimited)
    let mut s = Search::new(lp);
    let out = std::io::stdout();
    let mut out = out.lock();
    let mut fails = 0;
    for (i, (tps, hk)) in rows(path).into_iter().enumerate() {
        let mut b = match Board::from_tps(&tps, hk) {
            Ok(b) => b,
            Err(e) => {
                writeln!(out, "{i}\terror\t{e}").unwrap();
                continue;
            }
        };
        s.reset();
        s.stop = stop_after(secs);
        let n0 = s.stats.nodes;
        let t = Instant::now();
        let r = s.solve(&mut b, !and, plim, q, nodes, gated);
        let ms = t.elapsed().as_millis();
        let n = s.stats.nodes - n0;
        let e = s.entry(b.key);
        let best = e.filter(|e| e.best != NO_MOVE).map(|e| Board::ptn(e.best)).unwrap_or("-".into());
        if let Outcome::Proven(mw) = r {
            match s.check(&mut b, !and, dump) {
                Ok(c) => {
                    writeln!(out, "{i}\tproved\t{}\t{mw}\t{n}\t{ms}\t{best}", c.len).unwrap();
                    if dump {
                        writeln!(out, "R|{}|{hk}|{}", b.to_tps(), and as u8).unwrap();
                        for (t, m) in c.dump {
                            writeln!(out, "P|{t}|{m}").unwrap();
                        }
                    }
                }
                Err(err) => {
                    fails += 1;
                    writeln!(out, "{i}\tCHECKFAIL\t0\t{mw}\t{n}\t{ms}\t{best}\t{err}").unwrap();
                }
            }
        } else {
            writeln!(out, "{i}\t{}\t0\t0\t{n}\t{ms}\t{best}", outcome_str(r)).unwrap();
        }
        out.flush().unwrap();
    }
    if fails > 0 {
        1
    } else {
        0
    }
}

/// Exact threat-only length per row of a shard. Output: row, length (0 = none up to max, ? =
/// budget), nodes, ms, checked length, key.
fn cmd_up(path: &str, shard: usize, nshards: usize, nodes: u64, o: &HashMap<String, String>) -> i32 {
    let lp: u32 = opt(o, "lp", 22);
    let max: u8 = opt(o, "max", 61);
    let secs: f64 = opt(o, "secs", 0.0);
    let mut s = Search::new(lp);
    let out = std::io::stdout();
    let mut out = out.lock();
    let mut fails = 0;
    for (i, (tps, hk)) in rows(path).into_iter().enumerate() {
        if i % nshards != shard {
            continue;
        }
        let mut b = match Board::from_tps(&tps, hk) {
            Ok(b) => b,
            Err(e) => {
                writeln!(out, "{i}\terror\t{e}").unwrap();
                continue;
            }
        };
        s.reset();
        s.stop = stop_after(secs);
        let n0 = s.stats.nodes;
        let t = Instant::now();
        let (r, p) = s.exact(&mut b, nodes, max);
        let ms = t.elapsed().as_millis();
        let n = s.stats.nodes - n0;
        match r {
            Outcome::Proven(len) => {
                let best = s.entry(b.key).map(|e| Board::ptn(e.best)).unwrap_or_default();
                match s.check(&mut b, true, false) {
                    Ok(c) if c.len == len => writeln!(out, "{i}\t{len}\t{n}\t{ms}\t{}\t{best}", c.len).unwrap(),
                    Ok(c) => {
                        fails += 1;
                        writeln!(out, "{i}\t{len}\t{n}\t{ms}\tCHECKLEN {}\t{best}", c.len).unwrap()
                    }
                    Err(e) => {
                        fails += 1;
                        writeln!(out, "{i}\t{len}\t{n}\t{ms}\tCHECKFAIL {e}\t{best}").unwrap()
                    }
                }
            }
            Outcome::Disproven => writeln!(out, "{i}\t0\t{n}\t{ms}\tnone<={p}\t-").unwrap(),
            other => writeln!(out, "{i}\t?\t{n}\t{ms}\t{}>={p}\t-", outcome_str(other)).unwrap(),
        }
        out.flush().unwrap();
    }
    if fails > 0 {
        1
    } else {
        0
    }
}

/// Single-core measurement: per row (tables reset), search time without the checker, nodes, and
/// table bytes in use at the end. Prints a summary.
fn cmd_bench(path: &str, o: &HashMap<String, String>) -> i32 {
    let lp: u32 = opt(o, "lp", 22);
    let nodes: u64 = opt(o, "nodes", 2_000_000);
    let q: u8 = opt(o, "q", 0);
    let up = o.get("mode").map(|m| m == "up").unwrap_or(true);
    let mut s = Search::new(lp);
    let (mut tn, mut tt, mut tb, mut solved, mut n_rows) = (0u64, 0f64, 0usize, 0usize, 0usize);
    let mut ms: Vec<f64> = Vec::new();
    let mut nn: Vec<u64> = Vec::new();
    let mut bpn: Vec<f64> = Vec::new();
    for (tps, hk) in rows(path) {
        let mut b = Board::from_tps(&tps, hk).unwrap();
        s.reset();
        let n0 = s.stats.nodes;
        let t = Instant::now();
        let r = if up { s.exact(&mut b, nodes, 61).0 } else { s.solve(&mut b, true, UNL, q, nodes, false) };
        let dt = t.elapsed().as_secs_f64();
        let n = s.stats.nodes - n0;
        n_rows += 1;
        tn += n;
        tt += dt;
        tb += s.t.used_bytes();
        if n > 0 {
            bpn.push(s.t.used_bytes() as f64 / n as f64);
        }
        if matches!(r, Outcome::Proven(_)) {
            solved += 1;
            ms.push(dt * 1000.0);
            nn.push(n);
        }
    }
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    nn.sort();
    bpn.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |v: &Vec<f64>, p: f64| if v.is_empty() { 0.0 } else { v[((v.len() - 1) as f64 * p) as usize] };
    let pctn = |v: &Vec<u64>, p: f64| if v.is_empty() { 0 } else { v[((v.len() - 1) as f64 * p) as usize] };
    println!("mode {} rows {n_rows} solved {solved} (budget {nodes} nodes)", if up { "up (exact length)" } else { "prove (unlimited)" });
    println!("nodes {tn} in {tt:.2}s = {:.0} nodes/s on one core; sims {} ok {}; expansions {}", tn as f64 / tt, s.stats.sim_calls, s.stats.sim_ok, s.stats.expansions);
    println!("table bytes in use per node: {:.0} overall, median row {:.0}", tb as f64 / tn as f64, pct(&bpn, 0.5));
    println!("solved rows: ms median {:.1} p90 {:.1} max {:.1}; nodes median {} p90 {} max {}", pct(&ms, 0.5), pct(&ms, 0.9), pct(&ms, 1.0), pctn(&nn, 0.5), pctn(&nn, 0.9), pctn(&nn, 1.0));
    println!("entry sizes: Pos {} B, Val {} B, kid 10 B; allocated {} MB at lp={lp}", std::mem::size_of::<PosE>(), 24, s.t.bytes() >> 20);
    0
}

/// Certifier (SOLVER.md 6 + MINING.md changes). Input lines `tps|halfkomi|id|hint|L` (hint: engine
/// favourites, space-separated PTN, tried early; L: known length, else measured). One JSON object
/// per row: L, exact, status (ok / timeout / nolen / error), cutR, nodes, tree, line, book, ladder.
fn cmd_cert(path: &str, shard: usize, nshards: usize, b1: u64, o: &HashMap<String, String>) -> i32 {
    use deep::cert::*;
    use std::cell::Cell;
    use std::rc::Rc;
    let lp: u32 = opt(o, "lp", 22);
    let tl: f64 = opt(o, "tl", 30.0);
    let copts = CertOpts {
        lite: opt(o, "lite", 0) == 1,
        strict: opt(o, "strict", 0) == 1,
        q: opt(o, "q", 0),
        b1,
        b2: opt(o, "b2", 20_000),
        hisshi: opt(o, "hisshi", 0) == 1,
        max_replies: opt(o, "maxrep", 0),
    };
    let lb: u64 = opt(o, "lb", 3_000_000);
    let mut s0 = Search::new(lp);
    let mut s1 = Search::new(lp.saturating_sub(1).max(16));
    let deadline: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
    let d0 = deadline.clone();
    let d1 = deadline.clone();
    let out = std::io::stdout();
    let mut out = out.lock();
    let f = std::fs::File::open(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let lines: Vec<String> = std::io::BufReader::new(f).lines().map_while(Result::ok).filter(|l| !l.trim().is_empty() && !l.starts_with('#')).collect();
    for (i, line) in lines.iter().enumerate() {
        if i % nshards != shard {
            continue;
        }
        let fl: Vec<&str> = line.split('|').collect();
        let tps = fl[0].trim();
        let hk: i32 = fl.get(1).and_then(|x| x.trim().parse().ok()).unwrap_or(0);
        let id = fl.get(2).map(|s| s.trim()).unwrap_or("");
        let hint: Vec<Move> = fl.get(3).map(|h| h.split_whitespace().filter_map(|m| Board::parse_move(m).ok()).collect()).unwrap_or_default();
        let given_l: Option<u8> = fl.get(4).and_then(|x| x.trim().parse().ok());
        let mut b = match Board::from_tps(tps, hk) {
            Ok(b) => b,
            Err(e) => {
                writeln!(out, "{{\"row\":{i},\"id\":{},\"status\":\"error\",\"err\":{}}}", jstr(id), jstr(&e)).unwrap();
                continue;
            }
        };
        s0.reset();
        s1.reset();
        let t0 = Instant::now();
        deadline.set(Some(t0 + std::time::Duration::from_secs_f64(tl)));
        let dd = d0.clone();
        s0.stop = Some(Box::new(move |_| dd.get().map(|d| Instant::now() > d).unwrap_or(false)));
        let dd = d1.clone();
        s1.stop = Some(Box::new(move |_| dd.get().map(|d| Instant::now() > d).unwrap_or(false)));
        let n0 = s0.stats.nodes + s1.stats.nodes;
        let dl = deadline.clone();
        let mut expired = move || dl.get().map(|d| Instant::now() > d).unwrap_or(false);
        let mut c = Cert::new(&mut s0, &mut s1, copts.clone(), &mut expired);
        c.hint = hint;
        let (len, exact) = if copts.hisshi {
            match c.hisshi_len(&mut b, lb, 61) {
                Some((l, e)) => (Some(l), e),
                None => (None, false),
            }
        } else if let Some(l) = given_l {
            (Some(l), true)
        } else {
            match c.s0.exact(&mut b, lb, 61).0 {
                Outcome::Proven(l) => (Some(l), true),
                _ => (None, false),
            }
        };
        let Some(l) = len else {
            let timed = c.timed_out;
            drop(c);
            writeln!(out, "{{\"row\":{i},\"id\":{},\"status\":\"{}\",\"ms\":{}}}", jstr(id), if timed { "timeout" } else { "nolen" }, t0.elapsed().as_millis()).unwrap();
            out.flush().unwrap();
            continue;
        };
        let br = c.node(&mut b, l);
        let status = if c.timed_out { "timeout" } else { "ok" };
        let full = c.full;
        drop(c);
        let def: Vec<usize> = br.nodes.iter().filter(|n| n.reply.is_some()).map(|n| n.def_ideas).collect();
        // def ideas along the main line, in line order
        let mut line_def = Vec::new();
        {
            let mut bb = b.clone();
            for (j, &m) in br.line.iter().enumerate() {
                if j % 2 == 0 {
                    let t = bb.to_tps();
                    line_def.push(br.nodes.iter().find(|n| n.tps == t).map(|n| n.def_ideas).unwrap_or(9));
                }
                bb.make(m);
            }
        }
        let _ = def;
        let ladder = ladder_steps(&br.line, &line_def);
        let nodes = br.nodes.iter().map(node_json).collect::<Vec<_>>().join(",");
        let line_s = br.line.iter().map(|m| jstr(&Board::ptn(*m))).collect::<Vec<_>>().join(",");
        let book = br.book.iter().map(|(t, w)| format!("{{\"tps\":{},\"win_len\":{w}}}", jstr(t))).collect::<Vec<_>>().join(",");
        let searched = s0.stats.nodes + s1.stats.nodes - n0;
        writeln!(
            out,
            "{{\"row\":{i},\"id\":{},\"tps\":{},\"halfkomi\":{hk},\"L\":{l},\"exact\":{exact},\"status\":\"{status}\",\"full\":{full},\"cutR\":{},\"ladder\":{ladder},\"attMoves\":{},\"searched\":{searched},\"ms\":{},\"line\":[{line_s}],\"nodes\":[{nodes}],\"tree\":{},\"book\":[{book}]}}",
            jstr(id),
            jstr(tps),
            br.cut_r,
            br.line.len().div_ceil(2),
            t0.elapsed().as_millis(),
            br.tree
        )
        .unwrap();
        out.flush().unwrap();
    }
    0
}

/// Uncapped stage-0 walk (MINING.md 0.2). Input lines `gameid|halfkomi|tps;tps;...`: the winner-to-move
/// positions of one game, latest first. Each is proved (unlimited, q = 0, `secs` each); a proof is
/// measured with the exact threat-only length (`nodes` budget); anything else is a failure. The walk
/// goes on past one failure and stops after `fails` (2). Output: `P\tgame\tindex\tlength\ttps` for
/// every position with length >= `min`, then `G\tgame\ttried\tproved\tfailures\tms` per game.
fn cmd_walk(path: &str, shard: usize, nshards: usize, o: &HashMap<String, String>) -> i32 {
    let lp: u32 = opt(o, "lp", 22);
    let secs: f64 = opt(o, "secs", 10.0);
    let nodes: u64 = opt(o, "nodes", 3_000_000);
    let min: u8 = opt(o, "min", 11);
    let max_fails: usize = opt(o, "fails", 2);
    let mut s = Search::new(lp);
    let out = std::io::stdout();
    let mut out = out.lock();
    let f = std::fs::File::open(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    for (i, line) in std::io::BufReader::new(f).lines().map_while(Result::ok).enumerate() {
        if i % nshards != shard || line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split('|');
        let gid = it.next().unwrap_or("").to_string();
        let hk: i32 = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
        let tpss: Vec<&str> = it.next().unwrap_or("").split(';').filter(|t| !t.is_empty()).collect();
        let t = Instant::now();
        let (mut tried, mut proved, mut fails) = (0, 0, 0);
        for (j, tps) in tpss.iter().enumerate() {
            if fails >= max_fails {
                break;
            }
            let Ok(mut b) = Board::from_tps(tps, hk) else {
                fails += 1;
                continue;
            };
            tried += 1;
            s.reset();
            s.stop = stop_after(secs);
            let r = s.solve(&mut b, true, UNL, 0, u64::MAX / 4, false);
            if !matches!(r, Outcome::Proven(_)) {
                fails += 1;
                continue;
            }
            s.reset();
            s.stop = None;
            match s.exact(&mut b, nodes, 61).0 {
                Outcome::Proven(len) => {
                    proved += 1;
                    if len >= min && s.check(&mut b, true, false).map(|c| c.len == len).unwrap_or(false) {
                        writeln!(out, "P\t{gid}\t{j}\t{len}\t{tps}").unwrap();
                    }
                }
                // proved without a depth limit but no exact length within budget: keep as unknown length
                _ => {
                    proved += 1;
                    writeln!(out, "P\t{gid}\t{j}\t?\t{tps}").unwrap();
                }
            }
        }
        writeln!(out, "G\t{gid}\t{tried}\t{proved}\t{fails}\t{}", t.elapsed().as_millis()).unwrap();
        out.flush().unwrap();
    }
    0
}
