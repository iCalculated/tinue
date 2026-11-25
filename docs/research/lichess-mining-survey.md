# Puzzle mining: what Lichess and the Tak puzzle projects do, and what we could adopt

Survey date 2026.11.07. Goal (Shy): the tactic should **change the course of the game**. A side that is
already winning shouldn't get puzzles that only make it win faster.

Sources were read directly (GitHub code via `gh`). lichess.org blog pages return 403 to our fetcher, so
blog claims come from search snippets and from the generator code itself, which is the real spec anyway.
Downloaded sources: `a scratch directory (not kept)`.

## Lichess, as implemented (ornicar/lichess-puzzler `generator/generator.py`, `util.py`, `tagger/cook.py`)

- `win_chances(cp) = 2/(1+exp(-0.00368208·cp)) − 1`, on a −1..1 scale (so 0.6 = 30 percentage points).
- Games are walked **forward** with `prev_score` = the eventual solver's eval *before* the opponent's move
  (the server-side fishnet evals are the cheap first pass). The **first** qualifying position ends the
  game, so there is one puzzle per game.
- **Already-winning rejection:** `if prev_score > Cp(300) and score < mate_soon: reject`. +300cp ≈ 75%
  win. Also `if is_up_in_material(board, winner): reject`, which applies to **every** puzzle, mates
  included.
- **Swing requirement (advantage puzzles):** `score >= Cp(200) and win_chances(score) > win_chances(prev_score) + 0.6`.
  The threshold was 0.5 and `score >= Cp(0)` until commit 497d445, "stop making draw puzzles"
  (2020-12-10).
- If `score < Cp(400)` and the solver isn't down material, the position is rejected as "not clearly winning".
- **Only move at every solver ply:** `win_chances(best) > win_chances(second) + 0.7` (35 pp), or the best
  move is the only tablebase win, or mate-in-1 with every non-mate ≤ 0.6.
- **Dedupe:** the server is asked `is_seen_pos(parent FEN : move)` before solving. Analysis inside a game
  is suspended after a repeated position until the next irreversible move.
- **Source tier:** tier is set from player rating (>1500/1600/1750) and time control. Mate-in-1 and
  two-movers are dropped for low tiers.
- **Theme buckets** (cook.py): mate; else `crushing` (final cp > 600), `advantage` (> 200), `equality`
  (≤ 200). `defensiveMove` is a quiet last move. Length tags are oneMove/short/long/veryLong. Phase tags
  are opening/middlegame/endgame.
- **Equality** puzzles ("find the narrow path to an even position") are only served when explicitly
  requested. Generation of new ones stopped in Dec 2020.
- **Votes** (lila `PuzzleTrust.scala`, `PuzzleApi.scala`): a vote is weighted by trust (seniority, rating,
  title). It gets +2 when the vote disagrees with the result (an upvote after failing). Raters ±300 from
  the puzzle rating, or with a provisional rating, are distrusted. `vote = (up−down)/(up+down)`;
  Popularity = 100×that. The daily puzzle maximizes `plays × vote`. Selection paths are bucketed by
  `PuzzleTier` top/good/all, and new or anonymous users get `top`.
- **Post-hoc cleanup:** lila#18891 / gr-g/lichess-puzzle-checker flagged 11.9% of puzzles as `tooSubtle`
  ("ends too soon": static eval of the final position < 150cp). Popular puzzles were flagged less.
  Mates are never flagged, so this doesn't apply to tinue puzzles.

## Tak prior art

- **MortenLohne/tak-puzzle-finder** (Rust: Tiltak + Topaz). This is the closest analogue and it is
  worth copying ideas from.
  - Every ply of every game is analyzed, not only the end of road wins. Tiltak runs at 50k nodes for
    0 and 2 komi, top move plus second-best with the best move excluded.
  - Topaz tinue search runs at 10M/20M nodes.
  - **Tinue-avoidance puzzles:** if the side to move has a half-decent move (Tiltak > 0.1), run Topaz
    tinue search after *each* legal move. Tiltak's top-2 moves are tried first. A puzzle needs exactly
    one non-tinue defense; the search exits early on `MultipleDefenses`. Length = longest refutation + 2.
  - "Best move" candidates use `first > 0.4 && second < 0.6 && first−second > 0.3`.
  - Gaelet (flat-win) roots use Tiltak > 0.9 and second < 0.6, with side to move having ≤ 4 reserves.
  - **Immediate-win export filter:** keep only if `tiltak_deep_alternative_eval < 0.5`. That is the best
    move once all winning moves are excluded, so you're not winning anyway if you miss it. Also
    `num_winning_origin_squares = 1` and both players rated > 1200.
  - Tinue roots are kept only if second-best eval < 0.7.
  - Followup ranking: `tinue_len − longest_parent_tinue_len + (1−tiltak_eval)·6` (·12 if Tiltak picks
    the wrong move) `+ (0.9 − second_eval)·3`.
  - Defender-reply heuristic: wall +10, adjacent to the last attack +2, behind it +1.
  - Puzzle prior: `1250 + 350·(attacker moves)`, Glicko-2 from first attempts.
- **Jaffray-Ben/Tak-puzzles** (Python, Topaz/TakZero).
  - `onemove/`: one-move "only move" puzzles on a unified win%−loss% scale `u`. The required gap ramps
    from 50u (25 pp) when even or behind to 80u (40 pp) at +100. The bar is low when the side is even
    or losing and high when it is already winning.
  - Positions with `CERTAIN_WIN_U = 94` (~97% win) or more count as already won and are not puzzles.
  - Win-in-1 positions are skipped as pointless.
  - `road_threats` is stored (0 = positional, ≥1 = road defense). `found_in_game` is kept as a tag.
  - Results can be broadened beyond road wins.
  - A blunder explorer finds eval drops.
  - `Tinue puzzles/`: consecutive identical tinues are deduped; `--min-ply 3`; bots and guests excluded.
- **nitzel/tak-tinue-puzzles** (puzzle.exegames.de, with MortenLohne/tinue-finder).
  - Undo N plies from the end of road wins and search ≤ depth.
  - 1-ply tinues are omitted.
  - A suggestion: in 1-ply puzzles, don't show games where the side to move isn't the eventual
    winner.
  - "Avoiding tinues/threats" is an open goal.
- **takthoughts.blogspot.com** puzzle taxonomy: Tinue, **Tinue Avoidance**, Gaelet (flat win), Best Move.
- **Ditaktic** (Nqeron): human-curated, already used privately for rating calibration (docs/DATA.md).

## Options for tinue (ranked by fit to Shy's goal)

Tiltak's TEI `cp` is win%−loss% in [−100, 100]; `winProb = (cp+100)/200` (see `public/tiltak.js`).
Lichess's numbers translate as follows:

| Lichess rule | Tiltak cp |
|---|---|
| pre-mistake ≤ +300cp (≈ 75% win) | eval ≤ +50 |
| swing ≥ 0.6 | Δ ≥ +60 |
| only-move gap 0.7 | ≥ 70 |


1. **Swing gate on the mistake** (Lichess `prev_score > 300` reject plus `+0.6` swing). Run Tiltak
   (sizes 4–6) on `meta.prevTps`, the position before the loser's mistake, from the winner's side.
   - Drop the puzzle, or tag it `convert`, when the winner's pre-mistake win% is ≥ ~75% (cp ≥ +50).
   - Require Δwin% ≥ 30 pp versus the puzzle position.
   - Tag `turnaround` when pre < 50%, or `equalizer`/`seize` for 50–75%.
   - Works retroactively on all ~14.5k puzzles.
   - Cost: a Node harness for the WASM worker (shim `self` with `worker_threads`), about 0.5–1 day. Then
     2 evals × 14.5k × ~1s ≈ 8 CPU-h, run locally in parallel.
2. **Missed-win filter for road-in-1** (Morten's `tiltak_deep_alternative_eval < 0.5`). Evaluate the
   best move with every winning move excluded. Keep the puzzle only if missing the road leaves you not
   winning. This kills "you're crushing anyway" road-in-1s, which are ~8k of our puzzles.
   - Same harness, plus an exclude-moves search. TEI has no exclude option, so run Tiltak on each of the
     top few non-winning children and take the max. Cost: low–medium.
3. **Proof that the mistake was the turning point** (Morten's `topaz_tinue_avoidance`). Prove that the
   pre-mistake position has ≥1 loser move with no tinue ≤ N. If none exists, the loser was already lost
   and our "mistake" is fake, so walk further back (mine-deep).
   - Uses our `pns.js`. Try Tiltak's top-2 first and exit early once one defense is found.
   - Cost: medium code. Compute is bounded by the early exit.
4. **Tinue-avoidance (defensive) puzzles**, the Lichess equality/defensiveMove analogue. Its
   candidates are our mistake positions themselves: the loser to move, exactly one non-losing move, and
   Tiltak > 0.1 for that side. It's a new theme and an opt-in angle, as Lichess serves equality only on
   request.
   - Cost: medium–high compute. That is one PNS per legal move until 2 defenses are found; at 6×6 there
     are ~100+ children. UI already supports a one-move "win" tree; this needs a "survive" success
     condition.
5. **Mine missed tinues anywhere in a game** (Morten scans every ply; Jaffray's `found_in_game`). Include
   positions where a tinue existed and the player missed it, in games that were later lost or drawn, or
   where the result flipped. These are the purest "changes the course" puzzles.
   - Cost: high compute (solver on every ply). Prefilter with the cheap ≤3-ply solver or a Tiltak swing
     between consecutive plies, like Lichess's use of existing evals.
6. **Only-move scoring** (Lichess 35-pp gap; Jaffray's ramped gap of 25 pp when even to 40 pp when
   winning; Morten's second_eval < 0.6/0.7). For tinue roots, compute the Tiltak eval of the best
   non-winning move.
   - Puzzles where failing still leaves a big edge are lower-stakes, so down-weight them or drop them
     at ≥ +70.
   - Also down-weight high ratios of winning first moves to legal moves (we already count options).
   - Cost: low once (1) exists.
7. **Engine-obviousness / non-obvious score** (Morten's followup score). Run a shallow Tiltak (50k
   nodes) on the puzzle TPS.
   - If it already says ≥ 0.95 *and* picks the solution, the puzzle is "obvious".
   - If Tiltak picks a wrong move, boost the puzzle as a "hidden" tactic.
   - Use as a selection or prior feature. Cost: low (shares the harness).
8. **Cheap already-ahead proxy for 7×7/8×8** (Lichess `is_up_in_material`), where Tiltak doesn't run.
   - Reject if the winner had ≥2 open road threats, or a decisive flat-count lead with low reserves,
     before the mistake.
   - Store `road_threats` like Jaffray. Cost: low (tak.js only).
9. **Dedupe** (Lichess `is_seen_pos` on parent+move; Jaffray's consecutive-tinue dedupe).
   - Canonicalise TPS under the 8 board symmetries plus a colour swap, and keep one per class (the
     best-sourced or highest-tier game).
   - Also dedupe near-identical solutions: same tree shape and same key squares. Cost: low.
10. **Source tier** (Lichess rating/time-control tier; Morten requires both players > 1200; nitzel
    excludes bots). Down-weight or drop puzzles where the loser is a bot or a low-rated player, or the
    game is very fast.
    - Mistakes by FriendlyBot aren't "course-changing" human moments.
    - Cost: trivial (meta already has ratings).
11. **Phase tags and balance** (Lichess opening/middlegame/endgame). Define phase by board fill or
    reserves left. Balance the served mix and expose phase as a theme.
    - Morten's gaelet roots (≤ 4 reserves, unique flat win) add an endgame category beyond roads.
    - Cost: low for tags. Medium for gaelet mining.
12. **Weighted votes, Popularity, and a top tier** (lila `PuzzleTrust`, `PuzzleTier`). Add an up/down
    vote after a rated attempt, weighted so that a vote disagreeing with the result counts more, and a
    rater far from the puzzle rating counts less.
    - Popularity = (up−down)/(up+down). Serve a `top` tier (vote and plays) to new users. Hide at
      vote ≤ −X with n ≥ k.
    - Cost: low–medium (schema column, API, two buttons). It needs traffic to matter.
