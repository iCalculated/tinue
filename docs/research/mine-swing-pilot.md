# swing-scan pilot—option b, measured

2026.11.08. Pilot of memo option b (`docs/mining-options.md` §3b): scan whole games forward, lichess-style, and keep tinuës that *turn* the game.
Script: `scripts/research/mine-swing-pilot.mjs` (run + `--report`). Outputs: `<scratch>/mining/` (`pilot-games.jsonl` per game, `pilot-puzzles.jsonl` puzzles in miner format, ids `ps<gameId>`, `meta.swing` = `{pre0, lostBefore, alt, altMove, turn, trigger, pS, found, wonGame, gameResult, nodes}`; `pilot-hvh/` = human-only run). `pilot-puzzles.jsonl` has 119 lines, but only the first 106 belong to the 528 games in `pilot-games.jsonl`; the last 13 (9 turn=1) come from another run with no game records, and are not in any number below. Nothing in `data/`, nothing committed, crux untouched.

## verdict

**Go, but scoped: run b on the ~33k non-road games first (~29 CPU-h, ≈ 7 h on 4 crux cores).** Every puzzle there is new. Quality is good once the alt check is tightened: see **verification**, where 11 of the 71 turn=1 puzzles fail a stricter re-check (7 have a second winning first move). For road wins, b mostly re-finds mine-playtak's puzzle: 82% of its turning-point puzzles are the exact position mine-playtak picks. Running mine-playtak over the ≥1500 pool plus option a's filter gets those far cheaper. Scan road games with b second, for the ~3.4% whose turning point sits earlier in the game.

Before any full run:
1. reset Tiltak's game and komi per game (bug below; the pilot does it);
2. decide the komi-0 colour bias.
3. add verification's checks to the miner: pre0 and alt at 50–100k nodes, and df-pn on the top alt moves to catch second solutions (≈ +20% CPU).

## method

- **Pool.** mine-playtak's filters (rated, swap, default pieces, non-guest), sizes 5/6, both players ≥1500, any result. That gives 147k games: 114.4k road, 32.7k non-road (plus 81 with result 0-0).
- **Sample.** Hash-ordered so it spreads over all years, with road and non-road interleaved.
- **Per game:**
  - Tiltak (WASM, 5k nodes) on every position.
  - Candidate i is the position right after the opponent's move, when attacker pre0 = 1 − p_stm(i−1) ≤ 0.6 and either:
    - A: p_stm(i) − pre0 ≥ 0.30, or
    - B: the loser's p drops ≥ 0.30 from i−1 to i+1.
  - Prove each candidate in order:
    1. df-pn `shortestTinue` (threat model, ≤15 plies, 3e4 nodes);
    2. then `analyze` for ≤5 plies (exact brute force, quiet wins included) or `analyzeDeep` for 7+ (60 s deadline).
  - `lostBefore`: df-pn at pre0, 3e4 nodes.
  - `alt`: every non-winning first move scanned at 200 nodes, the top 5 re-checked at 5k; the max attacker p.
  - `turn`: as the lead decided.
  - One puzzle per game: the first turn=1 candidate, else the first proven one.
- **Limits.** 4 threads. Cap: 8 candidates and 120 s per game.

**Sample actually run:** 528 games (264 road + 264 non-road), shrunk from 2,000. Reasons:
- The laptop was at load ~400–500, giving 2.4 s wall/game on 4 threads.
- The first run had to be thrown away (komi bug below).

Plus 123 human-vs-human games (`--humans`). Sampling error (1σ) on per-1k yields is about ±24 (road) and ±17 (non-road).

## yield (corrected run, 528 games)

| bucket | games | candidates/game | any tinuë proven | **turn = 1** | per 1k games | conversion only (turn = 0) |
|---|---|---|---|---|---|---|
| road | 264 | 1.8 | 73 (28%) | **50 (19%)** | **189** | 23 |
| non-road | 264 | 2.2 | 33 (13%) | **21 (8%)** | **80** | 12 |
| · flat | 154 | 2.5 | 22 | 12 | 78 | 10 |
| · resign/time | 98 | 1.4 | 10 | 8 | 82 | 2 |
| · draw | 12 | 4.2 | 1 | 1 | 83 | 0 |
| humans only (both non-bot) | 123 | 2.1 | 19 | 12 | road 131, non-road 65 | 7 |

- The road rate (19%) agrees with the memo's option-a estimate for live puzzles (≈21% turnaround), a useful cross-check.
- **Candidates.** 925 were tried and 111 proven (12%). Almost all failures are "no tinuë" (806); the rest are budget, deadline or too-deep (10).
- **Trigger B** (Tiltak blind at i) added only 1 proven puzzle; A or AB found the rest.
- **Why proven candidates weren't turning points:**
  - alt ≥ 0.65 (the attacker stays winning without the tactic): 40.
  - lostBefore proved: 1. The pre0 ≤ 0.6 gate already removes nearly all the fake mistakes the memo found (31% of live puzzles).
  - lostBefore was never "unknown" among turn=1 puzzles.

## new vs existing

- **Live set.** The sample is spread over all years; the live set only covers the most recent ~6k road games per size. So only 9 of the 528 sampled games had been processed by mine-playtak. In those, 2 of 2 pilot puzzles were identical to the live puzzle. Overall, 69/71 turn=1 puzzles are not in `data/puzzles` or `tinue.db` (dedupe by TPS, and by gameId).
- **Against mine-playtak run on everything** (simulated with `--report --sim-live`, which re-runs its pick on each road game):
  - 41/50 road turn=1 puzzles are exactly mine-playtak's position;
  - 43/50 sit ≤5 plies from the end, 6 at 6–15 plies, 1 at more than 15.
  - New-only yield in road games ≈ **34 per 1k** (9/264).
  - All non-road puzzles are new by construction: no miner looks at those games.
- **Projected new turning-point puzzles from a full b run:**
  - ≈ **2.6k** from non-road (32.7k × 80/1k);
  - ≈ **3.9k** from road (114k × 34/1k);
  - b would also re-find ~17.6k of mine-playtak's road positions.
  - For scale: option a keeps ≈2.5k of the current 11.6k live size-5/6 puzzles.

## what the puzzles look like (turn = 1, n = 71)

- **Plies:**

  | plies | 1 | 3 | 5 | 7 | 9 | 11 | 13 | 15 |
  |---|---|---|---|---|---|---|---|---|
  | puzzles | 31 | 10 | 14 | 7 | 5 | 2 | 1 | 1 |

  44% are road-in-1. 16 are deep (7+): `analyzeDeep` trees, threat-model keys only, same caveat as mine-deep.
- **Prior rating:** bimodal. 31 are under 1200 (the road-in-1s), 30 are 2000+, median 1537.
- **Uniqueness:**
  - rootWins = 1 for 56/71 (79%; live set 61%), 2 for 12, 3 for 2, 4+ for 1;
  - lichess-strict (one key at every non-final attacker ply): 55/71.
  - So the turn filter by itself pushes toward only-move puzzles. The alt rule rejects most multi-solution positions: in the turn=0 set, alt ≥ 0.65 for 34 of 35.
- **Course change:**
  - pre0 < 0.3 for 66/71, so the loser was clearly better;
  - alt < 0.35 for 60/71, so missing the tactic leaves the attacker losing;
  - the attacker's side won the game in 57, drew 1.
- **Missed in the game:** 20/71 (the solver didn't play a winning move). These looked like the purest "turning point you missed" puzzles; 13 of them are 5+ plies. Verification: 9 of the 20 fail. In 2, the move the solver played also forces a win, just not the tree's. Several come from flat-win games the solver went on to lose.
- **Motifs:** fork 21, capture 23, smash 18, spread 16, throw 12, stackRoad 11, placement-only 24, defend-first (wallBlock) 7. The mix is healthy, not just corner roads.
- **Phase:** puzzle ply under 20 for 8, 20–39 for 31, 40+ for 32.

### quality caveats (judged as puzzles)

1. **Bot-heavy pool.** 95% of the ≥1500 pool has a bot player, so 68/71 puzzles do too:
   - bot→human 44: a ≥1500 human blundered into the bot's tactic. These are natural positions and fine.
   - human→bot 24: the bot blundered. Fine as positions; less of a human story.

   The human-only run has the same shape: 12 puzzles, 11 unique, mostly 6×6 road-in-1. Don't drop bot games. Optionally down-weight human→bot (memo §3e "source tier").
2. **Komi-0 colour bias** (also hits option a). At komi 0, Tiltak rates white ≈0.88 (5×5) / ≈0.83 (6×6) from the opening onward; at komi 2 it's ≈0.64–0.76 / 0.63. So pre0 ≤ 0.6 is nearly automatic for a *black* attacker and hard for a white one.
   - turn=1 at komi 0: black 50, white 13.
   - The memo's 299-sample shows the same: white-attacker komi-0 puzzles kept 4/46, black 16/33.

   88% of the pool is komi 0. Options (not decided here):
   - score komi-0 positions with Tiltak's komi 2 as a "human-fair" baseline;
   - or gate on pre0 relative to the game's opening baseline.
3. **Easy end.** 31 of 71 are road-in-1. They pass Morten's missed-win test (alt < 0.35), so they really do change the game. Serve them at their low prior; don't count them as the headline yield.
4. **One odd early deep puzzle** worth a human look. ps78100 is a 9-ply tinuë at ply 16 (move 9) of a human-vs-human flat game, and the solver later lost. (Verification: at 100k nodes pre0 is 0.81, so it is not a turning point.) The prover is sound; the question is only whether it's playable.

## examples

PTN: `https://api.playtak.com/v1/games-history/ptn/<game>` (the `sourceRef` the miners use). TPS in `pilot-puzzles.jsonl`.

| id | game result | size | plies | rootWins | pre0 | alt | in game | note |
|---|---|---|---|---|---|---|---|---|
| ps475809 | resign/time | 5 | 3 | 1 | 0.21 | 0.27 | found | move-8 (ply 14) placement fork: e3 threatens both a3 and e2 |
| ps509970 | resign/time | 6 | 1 | 1 | 0.14 | 0.12 | **missed** | 1864 vs 1999 humans; road-in-1 with a throw, never played |
| ps830687 | flat, solver lost | 6 | 9 | 1 | 0.05 | 0.11 | **missed** | fork + spread tinuë; game went on 68 more plies |
| ps469348 | flat, solver lost | 5 | 9 | 1 | 0.12 | 0.24 | **missed** | ✗ verification: alt 0.71 at 50k nodes |
| ps565730 | flat, solver lost | 5 | 7 | 1 | 0.24 | 0.19 | **missed** | ✗ verification: pre0 0.83 at 100k; 5d2> also wins (df-pn) |
| ps451066 | resign/time, solver lost | 5 | 7 | 1 | 0.09 | 0.25 | **missed** | ✗ verification: 2b2< also wins (df-pn) |
| ps637556 | flat | 5 | 7 | 2 | 0.05 | 0.49 | found | AaaarghBot's capture + fork against Morten (2040) |
| ps264770 | road | 5 | 7 | 1 | 0.33 | 0.21 | found | 9 plies from the end: outside mine-playtak's window |
| ps634786 | road | 6 | 5 | 1 | 0.08 | 0.53 | missed | 13 from the end, new |
| ps392910 | road | 5 | 3 | 1 | 0.24 | 0.13 | found | |
| ps803915 | road | 6 | 5 | 1 | 0.07 | 0.10 | found | human vs human |
| ps276404 | road | 5 | 1 | 1 | 0.19 | 0.07 | found | typical road-in-1 turnaround |
| *rejected:* ps551513 | flat | 5 | 1 | 11 | 0.47 | 0.88 | | 11 winning moves, winning anyway |
| *rejected:* ps444425 | road | 5 | 5 | 3 | 0.14 | 0.97 | | three tinuës; a non-tinuë move stays at 0.97 |
| *rejected:* ps630541 | road | 5 | 1 | 2 | 0.07 | 1.00 | | Tiltak sees a forced win without the road |

## cost

- Corrected run, thread-CPU on the loaded laptop: **2.52 s/game**.
  - Road 1.86 s: Tiltak 1.30 s over 39 evals, prove 0.56 s.
  - Non-road 3.18 s: Tiltak 2.16 s over 58 evals, prove 1.02 s.
  - Tiltak is 69% of the cost (35.7 ms/eval at 5k nodes).
  - Deep proofs ≈ 0.17 / 0.37 s/game. alt ≈ 0.27 s per proven candidate. lostBefore ≈ 7 ms.
- Human-only games: 6.6 s/game. They are longer (60 evals), mostly 6×6, and that run had the quiet check on.
- **Dropped:** the brute-force ≤5 "quiet tinuë" check on df-pn-disproved candidates. In the first run it produced 2 of 169 proofs for ~40% of all CPU. The pilot script kept it as `--quiet-nodes` (default 0); `scripts/mine-swing.mjs` dropped the flag (never used in the full run).
- **Full run on crux,** extrapolated from laptop thread-CPU (crux cores are probably faster, so this is pessimistic):

  | scope | CPU-h | 4 free cores | 10 cores |
  |---|---|---|---|
  | non-road only (32.7k) | ≈ 29 | ≈ 7 h | ≈ 3 h |
  | all 147k | ≈ 88 | ≈ 22 h | ≈ 9 h |

  A native Tiltak build would cut the dominant 69% several-fold.

## bugs found

- **Tiltak komi leaks across games in worker threads.** In the first 4-thread run, 436/731 games got a first eval that differs from a fresh Tiltak instance:
  - all were komi-0 games;
  - the values match komi-2 evals (white 0.77 vs 0.88 in the opening).

  I couldn't reproduce it single-threaded or in short scripted sequences, so the root cause is unknown. The pilot now sets `tiltak.size = null; tiltak.halfKomi = -1` before each game, which forces `teinewgame` plus an explicit `setoption HalfKomi`. After that: 0/515 and 0/77 mismatches against fresh instances. The bad run is archived in `mining/run1-komibug/`.
  - **Likely affects `measure-swing.mjs` and the planned `score-swing.mjs`** (one Tiltak per worker across mixed-komi puzzles). Reset per puzzle and spot-check against fresh instances before trusting swing.jsonl.

## verification

2026.11.08, adversarial re-check of all 119 puzzles in `pilot-puzzles.jsonl` (script `mining/verify-pilot.mjs`, output `mining/verify-pilot.jsonl`, summary `mining/verify-sum.mjs`; 4 threads, ~45 min on the loaded laptop). For each puzzle:
- **re-proof** two independent ways: `mateIn` (exact, every move, ≤5 plies), and df-pn `proveTinue` with `fullDefense` (every legal defender move, so a proof is sound at any depth); every tree key re-checked the same way;
- **pre0 and pS** at 100k Tiltak nodes (20× the pilot), plus komi 2 for komi-0 games;
- **alt**: every non-key move at 1k nodes (pilot: 200), the top 6 at 50k (pilot: 5 at 5k), and the top 3 run through df-pn to see whether they also force a win;
- **lostBefore**: is there a tinuë after the loser's Tiltak-best move at pre0?
- **found**: does the move actually played still force a win?

Tiltak was reset before every eval.

**Holds:**
- **Proofs.** All 119 are real forced wins. `mateIn` matches the stored length for every ≤5-ply puzzle (55/55 turn=1), the full-defense df-pn proves all 16 deep ones, and no tree key fails.
- **Novelty.** 69/71 turn=1 puzzles are new, even with the move counter stripped and all 8 board symmetries compared against `data/puzzles` + `tinue.db` (14,570 positions). No duplicates inside the pilot.
- **Arithmetic.** The yield table, per-1k rates, 1σ, 82% (41/50), 3.4% (9/264), CPU/game splits and the CPU-h extrapolation all recompute from `pilot-games.jsonl`. Only the pool counts were off (now fixed above: 32.7k non-road, not 34k; bots 95%, not 93%).
- **Tiltak at 5k is mostly stable.** The median |Δ| from 5k to 100k nodes is 0.015 for pre0 and 0.015 for alt.
- **lostBefore.** For 70/71 turn=1, the loser's Tiltak-best move at pre0 escapes the tinuë. The one turn=0 puzzle rejected on lostBefore (ps536735) is confirmed: the loser's best move still allows road-in-1.
- **turn = 0 is solid.** 33/35 conversions still have alt ≥ 0.65 at 50k nodes. Only ps757753 (alt 0.65 → 0.50) would flip to turn=1.

**Fails: 11 of 71 turn=1 puzzles (15%) are not turning points or not clean puzzles.**

| id | bucket | plies | in game | problem |
|---|---|---|---|---|
| ps565730 | flat | 7 | missed | pre0 0.83 at 100k; alt 0.92; 5d2> also wins |
| ps78100 | flat | 9 | found | pre0 0.81 at 100k (0.60 at 5k, on the gate) |
| ps451066 | resign | 7 | missed | 2b2< also wins (alt 0.90) |
| ps509409 | flat | 5 | missed | b1 also wins (alt 0.92); the loser's best pre0 move still loses to a 5-ply tinuë |
| ps432237 | road | 5 | missed | a2 also wins, and it is the move actually played |
| ps565176 | road | 13 | missed | e2 also wins, and it is the move actually played |
| ps531943 | road | 9 | missed | a2> also wins |
| ps741507 | road | 3 | found | d5 also wins (longer) |
| ps469348 | flat | 9 | missed | alt 0.71 at 50k (b4-) |
| ps697194 | road | 7 | missed | alt 0.72 (b1+); pilot alt was 0.649, right on the gate |
| ps147703 | resign | 15 | missed | alt 0.78 (Ce4) |

- **Main defect: hidden second solutions (7/71, proven).** The alt scan ranks moves at 200 nodes and re-checks 5 at 5k. It misses non-tree moves that *also* force a win, usually a longer tinuë Tiltak can't see at 5k. The trainer only accepts tree keys, so a solver who finds one of these is marked wrong. This is exactly what lichess discards. The pilot's alt is also too low in these cases, which is why they passed the turn gate.
- **The failures concentrate where the pilot put its best examples.** Missed-in-game: 11/20 survive. Deep (7+): 8/16 survive. Road-in-1: 31/31 survive. Found-in-game: 49/51 survive. A "missed" puzzle is often one where the solver played a different winning plan, not a blunder. Three of the six "missed" showcase rows in **examples** fail (marked ✗).
- **The 13 extra puzzles** at the end of `pilot-puzzles.jsonl` (not in the yield): 9/13 survive the same checks.

**Corrected yield (pilot method + stricter checks, turn=1 survivors):**

| bucket | pilot turn=1 | verified | per 1k |
|---|---|---|---|
| road | 50 | 45 | 170 |
| non-road | 21 | 15 | 57 (±15) |
| road, new-only (not mine-playtak's pick) | 9 | ≈4–5 | ≈17 (±8) |

- **Projected new turning-point puzzles:** ≈ **1.9k** from non-road (32.7k × 57/1k) + ≈ **1.9k** from road (114k × ~17/1k), so ≈ **3.8k**, down from 6.6k. The road new-only figure rests on ~5 puzzles, so treat it as ±50%.
- **Survivors by length:** 31 road-in-1, 9 three-ply, 12 five-ply, 8 seven-plus. Without road-in-1s, that is ≈29 real-tactic puzzles per 528 games.

**Komi-0 sensitivity (quantified).**
- Real outcomes in the pool: white scores 0.60 at 5×5 komi 0 and 0.56 at 6×6 komi 0, 0.54 at 6×6 komi 2. Humans only: 0.60 / 0.58 / 0.55.
- Tiltak's ≈0.87 komi-0 opening value is therefore an engine artefact, not a real 87% edge. pre0 is miscalibrated by colour, not just biased.
- If komi-0 positions were scored at komi 2, 15 of the 63 komi-0 turn=1 puzzles would have pre0 > 0.6 (14 of them black attackers). That is 13 of the 54 komi-0 survivors.
- So a komi-2 baseline would cut the black side by ~25% and admit some white-attacker puzzles the pilot never flagged (not measurable from this output, since those were never candidates).

**Komi leak.** Not reproduced here either: sequential reuse across size and komi changes, and panic → recreate → komi 0, all match fresh instances. The per-game reset is a cheap workaround. Also add a per-game sentinel (one fixed opening eval at the game's komi, compared against a constant) so a recurrence shows up in the logs rather than in the data.

**Cost of the fixes:** small, because they only touch proven candidates (~0.2 per game):
- pre0 at 100k;
- alt top-6 at 50k;
- df-pn on the top-3 alt children.

That adds roughly 2–4 s CPU per proven candidate, ≈ +0.5 s/game (+20%), so non-road goes ≈ 29 → 35 CPU-h. The candidate cap also understates yield slightly: 17/528 games had more than 8 candidates, 14 of them with no turn=1 found, and 2 hit the 120 s cap.

**Quality judgment (as a strong player would see it).**
- The survivors are good. They are near-only-move tinuës from positions where the loser was better, mostly ply 20–60, with a real motif mix.
- The weak spots:
  1. the hidden second solutions above (fix: reject or accept alternates, see next);
  2. road-in-1s are half the set. They are legitimate "the opponent left a road" moments, but trivial for a 1500+ player; serve them low and don't headline them;
  3. 95% bot pool. ~1/3 of puzzles are human→bot blunders, where the "course change" is a bot hallucination rather than a human story.

## next

1. Fix the per-game Tiltak reset in the shared runner, and pick a komi-0 policy (caveat 2).
2. Promote this script to `scripts/mine-swing.mjs` (resumable already). Run it on the non-road pool on crux after `tinue-mine`, writing `data/puzzles/swing-<size>.jsonl` with `meta.swing`. Import keeps `meta` intact, and its TPS dedupe drops live duplicates.
3. Road games: run mine-playtak over the ≥1500 pool plus option a (cheap). Later, b with Tiltak only before the last 6 plies, for the ~3.4% earlier turning points.
4. Before the full run, add the verification checks to the miner for every proven candidate: pre0 at ≥50k, alt top-6 at 50k, and df-pn on the top alt children. A proven second winning move means drop the puzzle (lichess), or add it as an accepted key if the trainer gets support for longer alternates. Gate on those values, not the 5k ones.
5. Strip or regenerate the 13 orphan lines at the end of `pilot-puzzles.jsonl` before anyone imports it.
