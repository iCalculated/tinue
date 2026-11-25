# mining options—puzzles that change the course of the game

2026.11.07 (reviewed 2026.11.08). Goal (Shy): keep tactics that *turn* a game; drop ones where the winner was already winning and just wins faster.
Sources: `ornicar/lichess-puzzler` @ `8e24b6d` (generator v50; `generator/{generator,util}.py`, `bin/copy-to-play.js`, `lila/regen.js`) + `lichess-org/lila` (`PuzzleTrust`, `PuzzleFinisher`, issue #18891); full notes in `docs/research/lichess-mining-survey.md`.
Measurement scripts: `scripts/research/{tiltak-node,measure-swing,report-swing}.mjs`. Nothing committed, crux untouched.

Units: Tiltak score s ∈ [−100, 100] from the side to move, p = (s+100)/200 (Tiltak's MCTS *expected score*, draws ≈ 0.5, not a calibrated win rate). Lichess "win chance" wc = 2/(1+e^(−0.00368·cp)) − 1 ∈ [−1, 1], so wc = 2p−1 and a wc gap of Δ = a p gap of Δ/2. Reference points: +200 cp ≈ p 0.68, +300 cp ≈ p 0.75.

## 1. how lichess mines

- **Games:** every game in the database.lichess.org export that carries `%eval` analysis, standard variant, *any result*. Scans **forward**; first qualifying position wins; **one puzzle per game**.
- **Tier:** starts at 4, lowered by either player's rating (>1750 → 3, >1600 → 2, >1500 → 1, else 0) and by time control base+40·inc (≥480 s → 3, ≥180 → 2, >60 → 1, else 0); +1 for a titled non-bot player, +1 for <38 plies, +1 more for <21. **Tier 0 games are not mined at all.** Mate-in-1 and 2-move advantage puzzles need tier ≥3; mate-in-2 needs tier ≥2.
- **Candidate** = position right after the opponent's move ("the mistake"), solver to move, ≥2 legal moves. Rejected if:
  - solver was already winning before the mistake: eval > +300 cp (p ≈ 0.75)—**forced mates (≤15 moves) exempt**;
  - solver is already up material (P1 N3 B3 R5 Q9)—mates included.
- **Accepted as:**
  - mate in 1–14 *moves* (up to ~27 plies; our tinues are ≤5 plies, or 7+ in mine-deep), or
  - advantage: eval ≥ +200 cp **and** wc jumps by > 0.6 (**p +0.30**). Under +400 cp it also needs the solver to be down material.
- **Only-move rule at every solver ply:** wc(best) − wc(2nd) > 0.7 (**p gap > 0.35**). For a mate line (best wc = 1) that means:
  - any alternative mate, even a slower one, kills the line;
  - **so does any non-mating alternative with wc ≥ 0.3 (≈ +165 cp, p ≥ 0.65)**—if missing the mate still leaves you clearly better, it isn't a puzzle;
  - the final move is looser: several mates-in-1 are OK, and a single mate-in-1 is OK, if the best non-mate is ≤ 0.6 wc (p ≤ 0.8).
- **Advantage lines** stop at the first non-unique solver move, abort if eval drops below +200, are trimmed to end on a solver move, need ≥2 solver moves, and any repetition cancels.
- **After mining:**
  - new puzzles start at Glicko 1500 ± 500 with a vote prior of 10 up / 0 down (`copy-to-play.js`);
  - votes are trust-weighted (seniority, rating, title); a vote that *disagrees* with the result (upvote after failing, downvote after solving) gets +2, raters >300 from the puzzle's rating or provisional get −2/−4;
  - paths serve the top 20/50/95% by vote per rating bucket (`top`/`good`/`all`); the bottom 5% and anything with an `issue` are never served;
  - `tooSubtle`: a one-off external flag (lila#18891, gr-g/lichess-puzzle-checker: Stockfish *static* eval of the final position < 150 cp, 11.9% of puzzles, mates never flagged). Flagged puzzles are excluded from paths unless the **puzzle's** rating is ≥ 2200 or its RD ≥ 120;
  - when a player picks an "obvious" theme as their angle (mate-in-N, en passant, double check, …), rating updates are scaled 0.1× on a solve / 0.4× on a fail.

**The point for us:** lichess's "changes the course" test for *advantage* puzzles is pre ≤ 0.75, swing ≥ +0.30, not already up material. Mates—our analogue—skip the pre-eval test; their course-change guards are only the material check and the only-move rule ("if you miss the mate you're not better than ~+165 cp"). So there are two separate filters to port: **pre-mistake eval** (§2, option a) and **alternative-move eval** (option a2/e). We measured only the first.

## 2. what we measured

299 live puzzles (sizes 5/6 × plies 1/3/5, 50 per cell—stratified, so raw sample percentages over-weight 3/5-ply; population estimates below are re-weighted by live cell counts; Tiltak WASM in Node, 20k nodes). Attacker p at **pre0** = the position right before the loser's mistake (loser to move, so attacker p = 1 − p(stm)):

| attacker p before mistake | <0.3 | 0.3–0.6 | 0.6–0.7 | 0.7–0.9 | ≥0.9 | median |
|---|---|---|---|---|---|---|
| all (raw sample) | 15% | 3% | 3% | 16% | 62% | 0.93 |
| 1-ply | 21% | 2% | 2% | 20% | 55% | 0.91 |
| 3-ply | 16% | 3% | 4% | 12% | 64% | 0.94 |
| 5-ply | 9% | 5% | 2% | 17% | 67% | 0.95 |

- **Bimodal-ish.** Either the loser was clearly winning and blundered, or the attacker was already well ahead; 0.3–0.6 is thin (3%). The 0.6–0.75 band isn't empty, though: cutoff 0.6 / 0.7 / 0.75 keeps 19 / 21 / 24% raw, **21 / 24 / 27% weighted**. So lichess's 0.75 would keep ~700 more puzzles (+28%) than 0.6.
- **Steady.** 67% were already ≥0.7 at pre0, pre2 *and* pre4. 50 of the 56 swing puzzles were also ≤0.6 two and four plies earlier, so the swings aren't one-move blips (missing pre2/pre4 early in a game counts as ≤0.6).
- **Fake mistakes.** The prover shows **31%** (raw; ≈16% weighted, since it's concentrated in long tinues) were already lost for the loser *before* the mistake: 8% of 1-ply, 30% of 3-ply, 54% of 5-ply; 50% when the loser is a bot vs 16% human.
  - 38% of attackers already had a tinue on their previous turn. Of those, 52% were 7–11 plies, 16% ≥13, and **32% were ≤5 plies**—these sit just outside the miner's window (`mine-playtak` only examines the last 5 plies of the game), so the attacker took longer than necessary.
  - Either way, "earliest ≤5-ply win in the last 5 plies" picks an arbitrary point in an already-lost game. Many of these games also yield a `pd` puzzle from mine-deep, which needs the same filter.
- **Missed wins are rare in this set:** 4/299 losers had their own road-in-1 or tinue at pre0 (all 4 in the <0.3 bucket). Nearly every swing is a missed *defense*.
- **Uniqueness:** only 61% of size-5/6 puzzles have a single winning first move (`meta.rootWins` = 1: 63% of 1-ply, 60% of 3-ply, 54% of 5-ply). Lichess would reject every mate line with *any* alternative mate at *any* solver ply, so ≤61% would survive its rule.
- 5k-node evals ≈ 20k (mean |Δp| 0.014, p90 0.03, max 0.17; 2/90 flip across 0.6), so 5k is fine for screening.
- **Reproducible:** a re-run of 16 sampled puzzles reproduced pre0 and both prover verdicts exactly (fixed-node search is deterministic).

**Recommended threshold:** keep puzzles where attacker **p(pre0) ≤ 0.6** *and* the prover did **not** prove the loser already lost.
- Keeps 54/299 raw (18%); **re-weighted to the live mix ≈ 21%, about 2,500** of the 11.6k size-5/6 puzzles (1-ply cells keep 22–24%, 5-ply 12%). Sampling error ±4–5 points.
- Why 0.6 and not lichess's 0.75: a conservative start for Shy's "the game was genuinely open". Tiltak isn't calibrated like Stockfish, and we don't know in which direction it's off, so let the spot list (0.5–0.8) settle it before fixing the cutoff.
- Tag the rest `convert` and hide them from default serving. Don't delete them.

Examples (`https://shydrie.xyz/tinue/#/puzzle/<id>`; pre0/pre2/pre4 attacker p):

| | ids |
|---|---|
| keep: steady swings | p868985, p863423, p878395, p865878, p868974, p875506, p878758, p864723 |
| keep: loser was winning | p861415 0.07/0.04/0.05, p868870 0.10/0.08/0.06, p873160 0.06/0.10/0.06 |
| borderline | p846986 0.63, p861926 0.65, p870839 0.63/0.11/0.09 |
| drop: already winning | p850539 0.99, p859885 0.94, p863855 0.94 |
| drop: already lost before mistake | p836917, p862180, p869662, p873544 (pre0 ≥ 0.97) |

## 3. options, best value/cost first

### a. turning-point filter on existing puzzles—**do first**
- **Adds:** quality, not quantity. About 2.5k "real" size-5/6 puzzles promoted; about 9.1k tagged `convert`.
- **How:**
  - promote `scripts/research/measure-swing.mjs` into `scripts/score-swing.mjs`: drop sampling, add a per-puzzle timeout (one puzzle hung >10 min), output a sidecar `data/puzzles/swing.jsonl` `{id, pre0, pre2, pre4, lostBefore}`;
  - `scripts/import.mjs` merges it into `tags` (`turnaround` if pre0 ≤ 0.6 and not lost; `convert` otherwise);
  - `server/server.js` next-puzzle query skips `convert` by default.
- **a2. alternative-move eval (lichess's mate-line rule; not yet measured):** in the same pass, Tiltak-evaluate the attacker's best *non-winning* first move at the puzzle position. If the attacker stays ≥ ~0.65 without the tinue, the tactic doesn't change the outcome—tag `convert` too. This is Shy's "win faster" test stated directly, and it catches cases pre0 can't (e.g. pre0 0.5, but the attacker has three winning plans). Same mechanics as option e's road-in-1 test.
- **a3. re-mine fake mistakes:** for `lostBefore = proved`, the real turning point is earlier. Walk back (mine-deep's df-pn) to the last loser-to-move position with a surviving defense; that gives either a longer tinue or a defense puzzle (option c).
- **Compute:** about 1.6 s per puzzle at 20k nodes with both prover checks (≈1.3 s at 5k), so 13.1k puzzles ≈ 6 CPU-h ≈ **35 min on 10 cores**. Pre0 eval alone ≈ 4 min. a2 adds a few child evals per puzzle (unmeasured; ~0.2 s at 5k if the shortlist is ~5 moves). Runs on the laptop.
- **Risks:**
  - Tiltak only runs on sizes 4–6 with komi 0/2. Komi 2.5 → 2 (303 size-6 puzzles) and 1/1.5 → 2 are approximate. The 1,488 7×7/8×8 puzzles need option e's cheap check.
  - The prover only searches Tak-threat attacker moves, so "already lost" is a lower bound.
  - Size 4 (1,493 puzzles) wasn't sampled; prover cost on 7×7/8×8 wasn't measured.

### b. lichess-style scan of every game—**the big new source**
- **Adds:** puzzles from games our miner never looks at:
  - flat wins, resigns, timeouts, draws;
  - earlier turning points in road-win games (the miner only examines the last 5 plies; mine-deep the last 15);
  - tinues the solver *missed* (the game went on, maybe lost).

  Pool (size 5/6, rated, swap, both ≥1500): 114k road + 19k flat + 13k resign/time + 1.5k draw ≈ **148k games** (~34k non-road). Yield is **unmeasured**. The 4/299 figure above only covers the loser's own win one ply before the mistake, so it says nothing about earlier missed tinues—the pilot has to measure that.
- **How:** new `scripts/mine-swing.mjs`, reusing the worker pool from `mine-playtak.mjs` and the engine from `tiltak-node.mjs`.
  1. Replay with `shared/tak.js` and evaluate every ply at 5k nodes.
  2. Candidate = side-to-move p jumps ≥ +0.30 after the opponent's move, from ≤ 0.6 before.
  3. Prove the tinue with `shared/analyze.js` (≤5 plies), then `shared/deep.js`/`pns.js` (deeper).
  4. Apply lichess's mate-line rule (reject on any second tinuing move at any attacker ply, or a non-tinue alternative ≥ ~0.65—see a2) and option a's lost-before check.
  5. One puzzle per game. Dedupe on (prevTps, mistake) against the live set.
- **Compute:** Tiltak pass ≈ 148k × 35 plies × 41 ms ≈ **60 CPU-h ≈ 6 h on 10 cores** (measured under heavy load, so pessimistic); prover time on candidates comes on top (unmeasured). Only the last 16 plies ≈ half. Native Tiltak would be several× faster, but needs a cargo build from GitHub (not done). Run it on crux *after* the current `tinue-mine` job finishes.
- **Risks:**
  - At 5k nodes Tiltak may not "see" a deep tinue, which misses candidates. Mitigation: also trigger on a loser-side p drop ≥ 0.3 and let the prover decide.
  - Overlap with the live set.
  - Unknown yield, so **pilot on 2k non-road games first** (~5 min of Tiltak).

### c. defense puzzles ("avoid the tinue")
- **Adds:** a new category. The lichess analogue is the legacy `equality` theme (find the only move that holds; generation stopped in Dec 2020 and it's served only on request)—*not* `defensiveMove`, which is just a tag for a quiet last move in an attacking line. Morten Lohne's tak-puzzle-finder mines exactly this ("tinue avoidance").
- Candidates are already in hand: pre0 positions where the prover *disproved* lost-before (198/299). "Disproved" only means no Tak-threat tinue was found after some loser move—a quiet-move tinue may still exist. Keep those where **exactly one** move survives a deep check and Tiltak gives the defender > 0.1 after it. These are precisely the moments that changed the game.
- **How:**
  - `shared/pns.js` per legal move, Tiltak-top moves first, stopping at 2 survivors;
  - new tree kind `{"survive": [moves]}` in `shared/analyze.js`;
  - client success = "played a listed survivor" (`public/`);
  - opt-in theme, like lichess's `equality`.
- **Compute (guess, unmeasured):** about 100+ proofs per 6×6 position on the hard (true only-move) ones, maybe 10–30 s each; most positions exit early at 2 survivors. ~81% of the 13.1k evaluable puzzles are disproved candidates (~10.6k) ≈ 30–90 CPU-h at worst.
- **Risks:** client and rating-prior work; "no tinue within budget" ≠ safe (use a deep budget); one-move puzzles may feel thin.

### d. only-move non-tinue puzzles (lichess "advantage")
- **Adds:** tactics that win a road race or flats without a forced road.
- **How:** extend b. While the attacker's best beats the 2nd by p > 0.35 and p stays ≥ 0.68, keep going. Stop at the first non-unique move. ≥2 attacker moves; repetition cancels. Flag `tooSubtle` if the end is < 0.70.
- **Risks:** correctness rests on Tiltak alone, with no proof. The client has to accept "the engine's move", not "any winning move". **Last.**

### e. cheap quality filters (do alongside a; reuse its runner)
- **Road-in-1 missed-win test** (Morten Lohne's tak-puzzle-finder): keep only if the best *non-winning* move leaves the side < 0.5. That removes "you're crushing anyway" from about 9.4k road-in-1 puzzles on sizes 4–6 (8.4k on 5/6). Tiltak can't exclude moves, so evaluate the top few non-winning children directly. This is a2 for 1-ply.
- **Only-move weight:** many winning first moves, or a non-winning 2nd-best ≥ 0.65 (lichess's mate threshold) → down-weight; Morten keeps tinue roots only if 2nd < 0.7.
- **Obviousness:** Tiltak at 50k nodes on the puzzle. If it plays the solution at ≥ 0.95, down-weight. If it picks a wrong move, boost (hidden tactic).
- **7×7/8×8 "already ahead" without Tiltak** (`shared/tak.js` only): before the mistake, the winner had ≥2 open road threats, or a decisive flat lead with low reserves → `convert`. This is our `is_up_in_material`.
- **Source tier:** loser is a bot → down-weight (half of bot-loss puzzles were already lost). Lichess also skips games where either player is ≤1500 or the clock is ≤60 s; ratings are in `meta`.
- **Dedupe:** 8 symmetries + colour swap; collapse persistent tinues.

### f. votes + "top" tier (lila)
Up/down after a rated attempt, trust-weighted (a vote against the result counts more). Serve the top 20/50/95% per band. A manual blocklist plus an `issue` flag. Only worth it once traffic exists.

## 4. next step

Run **option a (+ a2) over the full live set on the laptop**:
- `measure-swing.mjs` with `--all` + per-puzzle timeout, at 5k nodes for pre0/pre2/pre4 plus both prover checks, plus the best-non-winning-move eval;
- about 35–45 min on 10 cores;
- output `data/puzzles/swing.jsonl`, plus a 40-puzzle spot list straddling 0.5–0.8 for Shy to play.

If the spot check agrees, pick the cutoff (0.6 vs 0.75), wire `turnaround`/`convert` into `import.mjs` and serving. Then pilot b on 2k non-road games.
