//! Read-only key dump for the book key cross-check (scripts/book-keycheck.mjs, PLAN.md B1a). No search.
//!   cargo run --release --example keydump <file> [v=1]
//! Input lines: `tps|halfkomi|move move ...` (the moves are stored tree moves to parse; may be empty).
//! Output per line, tab-separated:
//!   row, key = tps_board()|halfkomi, number of legal moves, h1, h2, parsed moves
//! where h1/h2 are FNV-1a 32 hashes (two offsets) of the sorted lines `ptn(m)=tps_board() after m|halfkomi` over every
//! legal move m, joined by '\n', and `parsed moves` is ptn(parse_move(s)) for each input move, comma-joined (`!err` on a
//! parse error). With v=1 every `ptn=key` line follows as `M\t<line>`.
use deep::board::*;
use std::io::{BufRead, Write};

fn fnv(s: &[u8], off: u32) -> u32 {
    let mut h = off;
    for &c in s {
        h ^= c as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("keydump <file> [v=1]");
    let verbose = args.iter().any(|a| a == "v=1");
    let f = std::fs::File::open(path).expect("open");
    let out = std::io::stdout();
    let mut out = std::io::BufWriter::new(out.lock());
    let mut buf = Vec::new();
    for (i, line) in std::io::BufReader::new(f).lines().map_while(Result::ok).enumerate() {
        let mut it = line.split('|');
        let tps = it.next().unwrap_or("").trim();
        let hk: i32 = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
        let moves = it.next().unwrap_or("");
        let mut b = match Board::from_tps(tps, hk) {
            Ok(b) => b,
            Err(e) => {
                writeln!(out, "{i}\terror\t{e}").unwrap();
                continue;
            }
        };
        let key = format!("{}|{hk}", b.tps_board());
        buf.clear();
        b.legal_moves(&mut buf);
        let mut lines: Vec<String> = Vec::with_capacity(buf.len());
        for &m in buf.iter() {
            let u = b.make(m);
            lines.push(format!("{}={}|{hk}", Board::ptn(m), b.tps_board()));
            b.unmake(m, u);
        }
        lines.sort();
        let joined = lines.join("\n");
        let parsed: Vec<String> = moves.split_whitespace().map(|s| Board::parse_move(s).map(Board::ptn).unwrap_or_else(|_| "!err".into())).collect();
        writeln!(out, "{i}\t{key}\t{}\t{}\t{}\t{}", lines.len(), fnv(joined.as_bytes(), 0x811c_9dc5), fnv(joined.as_bytes(), 0x0123_4567), parsed.join(",")).unwrap();
        if verbose {
            for l in &lines {
                writeln!(out, "M\t{l}").unwrap();
            }
        }
    }
}
