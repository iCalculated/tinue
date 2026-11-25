# deep: native tinue solver (6x6)

A Rust rebuild of the `deep` tool described in the hard-100 briefs (SOLVER.md, MINING.md):
df-pn over Tak threats with exact proof lengths, Kawano replay between sibling replies, an optional
quiet attacker move with a pass test, and a proof checker on every proof. 6x6 only. No
dependencies and no `unsafe`. Unrelated to `shared/deep.js` (the JS deep-puzzle analyser).

The library (`src/lib.rs`) keeps no clocks, threads or files, so it can go to WebAssembly later:
budgets are node counts, a time limit is a `stop` callback the wrapper installs, and table size is a
runtime parameter (`lp` = log2 entries). `cargo build --lib --target wasm32-wasip1` compiles; nothing
has been run under wasm yet.

## Build and test

```
cd deep
cargo build --release                 # -> deep/target/release/deep
cargo test --release                  # perft, brute force, tak.js differential (needs node), section 8, stored rows
target/release/deep test              # perft 4, winNow/roadIn1 vs brute force on 1M positions, section 8 + regressions
node --no-warnings tests/gen-diff.mjs 3000 11 > /tmp/diff.txt && target/release/deep diff /tmp/diff.txt
```

`tests/gen-diff.mjs` plays random 6x6 games with `shared/tak.js` (placement-, wall- and
threat-heavy policies, random komi) and writes every position's legal moves and the result of each
one; `deep diff` compares legal move sets, results (road, flat with komi, draws, reserve
exhaustion, smashes), TPS round trips, incremental Zobrist keys, unmake, and `winNow`.

## Commands

Input files hold one position per line, `tps|halfkomi` (more `|` fields are ignored, `#` lines
skipped). halfkomi is twice the komi (komi 2.5 -> 5).

| Command | What it does | Output per row (tab-separated) |
|---|---|---|
| `deep prove <file> [secs=] [nodes=] [p=] [q=0\|1] [and=1] [gated=1] [dump=1] [lp=22]` | proof (unlimited unless `p=` sets a depth limit); `and=1`: the side to move defends; `gated=1`: pass test at a defender root (the move into it was quiet) | row, proved/disproved/unknown/full/CHECKFAIL, checked length, minWin, nodes, ms, best |
| `deep up <file> <shard> <nshards> <nodes> [lp=22] [max=61] [secs=]` | exact threat-only length: winNow, then p = 3, 5, 7, ... at q = 0 | row, length (0 = none up to max, ? = budget), nodes, ms, checked length, key |
| `deep cert <file> <shard> <nshards> <b1> [lite=1] [strict=1] [q=1] [b2=] [tl=] [hisshi=1] [maxrep=] [lb=] [lp=]` | certifier (SOLVER.md 6 with the MINING.md changes, `src/cert.rs`): input `tps\|halfkomi\|id\|hint\|L`; follows every key, backtracks over all longest replies, likely cooks first, hisshi length at q = 1 | one JSON object per row: L, exact, status, cutR, nodes (keys, listed wins, undecided), line, tinue `tree`, `book` rows, ladder steps |
| `deep walk <file> <shard> <nshards> [secs=10] [nodes=3000000] [min=11] [fails=2]` | uncapped stage-0 walk: input `gameid\|halfkomi\|tps;tps;...` (winner-to-move positions, latest first); prove, then exact length; past one failure, stop after two | `P` lines for kept positions, `G` line per game |
| `deep bench <file> [mode=up\|prove] [nodes=] [q=] [lp=]` | one-core speed, bytes per node, times | summary |
| `deep perft <depth> [tps]` | perft | counts |

Every proof is walked by the checker (SOLVER.md section 5) before it is printed. With `dump=1`,
`prove` follows each proof with `R|tps|halfkomi|and` and one `P|tps|move` line per attacker
position. `node --no-warnings deep/check-proof.mjs <output>` re-walks those dumps with
`shared/tak.js` only: it plays each stored move, tries every legal reply (an immediate attacker win
is found by brute force), and fails on a missing entry, an illegal move, a non-winning end or a
cycle.

Memory: `lp=22` allocates 544 MB (2^22 Pos entries of 32 B, 2^22 Val entries of 24 B, 2^25 kid
slots of 10 B); pages are touched only as used. A search aborts with `full` at 75% of any table.

## Library

```rust
let mut s = deep::Search::new(22);               // tables shared by all calls until s.reset()
s.stop = Some(Box::new(|nodes| false));           // optional, polled every 1024 nodes
let o = s.solve(&mut board, root_or, p, q, budget_nodes, gated); // p = search::UNL for unlimited
let (o, p) = s.exact(&mut board, budget_nodes, 61);
let c = s.check(&mut board, root_or, want_dump)?; // true length + (tps, move) dump
```

`solve` is the call a certifier needs (position, limit p, q, budget, gated) on shared tables. Table
keys fold in the attacker colour and komi, so one table can serve both sides. `minWin` ignores q
(a proof is a proof), so after a q = 1 search on the same tables a q = 0 lookup may see a proof
that uses a quiet move; reset between rows when a threat-only length is wanted (`up` does).
Unlimited-depth disproofs that depended on a cycle cut or the 120-ply path limit are kept only for
unlimited lookups (in Val), never as `maxFail`, so they cannot leak into depth-limited answers.

## Measured (Apple Silicon, one core, other jobs running)

| Check | deep (this crate) | prototype (SOLVER.md 7) |
|---|---|---|
| Speed | 97k nodes/s exact-length mode, 86k prove mode | about 90k nodes/s |
| Table bytes in use per node | 83 (exact), 111 (prove) | about 200 |
| Prove, 213 stored 15-ply `pd` rows | all within 500k nodes (max 92k); median 22 ms, p90 143 ms, max 1.1 s | 0.3 s typical; 47 of 48 within 500k |
| Exact length, same 213 rows | all within 4M nodes (max 116k); median 104 ms, p90 507 ms, max 1.6 s | 1.5 s typical; 48 of 48 within 2M |

The prototype's rows were self-play wins of 15 to 29 plies; these are stored rows of exactly 15,
so the times are not like for like.

## Stored rows with a wrong `plies`

`deep up` matched `plies` on 198 of 200 sampled `pd` 6x6 rows and on all 213 rows with
`plies = 15`. The two mismatches (pd731708 stored 9, pd137717 stored 13; deep 15 and 15) are
the stored value's fault: current `shared/pns.js` (pruned and full defence) gives 15 for both,
the stored trees are themselves 15 plies deep, and the exact length falls by 2 at every step of
the stored main lines. Scanning all 22,796 `pd` rows for `plies` different from the deepest line of
the row's own tree finds 18, all 6x6, all with `plies` too small; deep's exact length equals the
tree depth on all 18. See the worker report for the id list.

## Mining drivers (`deep/mine/`, node, no dependencies)

`stage0.mjs` (stored rows, `deep up`), `stageAB.mjs --stage=A|B` (`deep cert`), `stageC.mjs [--calibrate]`
(Syntaks cliff, targeted `deep prove`, stage D node counts), `stageE.mjs` (every listed win dumped and
walked by check-proof.mjs, replay from the game record, engine playouts), `candidates.mjs` (import row
format, id prefix `ph`, `cert` and `book`), `walk.mjs` (uncapped walk over games_anon.db), `report.mjs`.
They read the tinue DB and the dump read-only and write only under `--out`. `SYN` names the Syntaks
binary. tak-human is not wired in: its ranking terms and the residual risk are left null.
