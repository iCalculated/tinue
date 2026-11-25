# Alternative winning first moves in conversion puzzles (2026.11.15)

Status: change set **applied** 2026.11.15 18:40 (Shy: "yeah you can fix and refund as requested"). The four sidecars are
patched and the local `data/tinue.db` is updated. Backups are `*.bak-pre-altwins-20261115-1840` next to each file. The
sidecars are gitignored, so `docs/alt-wins-changes.jsonl` is the versioned record of the 70 changes (row 71 is the 2026.11.16 regrade of pd575074, below). crux gets them with
the next deploy, and the refunds run on crux after that. Since d0ade43 the browser checks every off-tree move the
lists don't decide live, roots included, and plays out one it can't decide on 4×4–6×6 (play-on); on 7×7/8×8 the result is held while the check runs on. Since 3421d53 any proven slower
win counts as solved.

## The problem in one paragraph

A conversion (turn = 0) is a position the attacker was already winning, so several first moves often keep a forced
win. The trainer accepts only the tree's keys (every win at the puzzle's length *under the prover's model*) and the
precomputed slower wins in `swing.alts`; anything else at the root is a miss. Past the root of a 7+ ply puzzle the
browser re-checks for ~2.5 s, but not at the root. (As of this report; since d0ade43 it checks the root too.)

## Where a real win can be missed

| puzzle | same length | slower |
|---|---|---|
| short (3/5 ply, `p*`) | can't happen: the tree is built by brute force over every move | threat first moves: proved by `score-swing --refine` at 30k nodes (`alts`); unresolved ones counted in `altsUnk`. Quiet first moves: never checked on 6×6 |
| deep (7+ ply, `pd*`) | **quiet first moves**: the tree's keys are threat moves only, and the brute-force quiet check stops at 5 plies | same as short |

Syntaks win probability can't find candidates in conversions: in pd614199, 100+ of 120 first moves score p ≈ 1. So the
scan runs tinue's own prover on every non-key first move instead.

## Method

- **Same-length scan** (`scan2.mjs`, MODES=same): for every non-key, non-alt first move of a deep puzzle, df-pn from the
  defender-to-move position at depth plies−1 (3k nodes), proofs confirmed with `fullDefense` (30k). This catches faster
  wins too. A proved move needs one quiet move (the first); after it the attacker plays Tak threats only.
- **Undecided moves** (`prove2.mjs`): one search per defender reply (one combined df-pn can't prove pd614199/c2 even at
  300k nodes; per reply it can), budgets 3k → 30k → 300k, stopping at the first escaping reply. Syntaks's best
  defence is tried first (`synreply.mjs`), which cuts disproof time 2–5×. Proofs confirmed with `fullDefense`.
- **Subtrees** for same-length moves (`deepx.js`: `analyzeDeep` with a `branchFor` option, which builds only that
  key's subtree with the usual longest-resisting reply choice); every extended tree replays cleanly (`validate.mjs`).

## Results (6×6 served conversions: 856 deep, 262 short)

Model caveat: "proven" means one quiet move (the first) and then Tak threats only, every defender reply searched.
A win that needs a second quiet move is invisible to this prover, so the counts are lower bounds.

**Same length: complete over all 856 deep conversions.** 7.5 CPU-h on the laptop; every non-key first move was
decided.
- **13 puzzles gain 15 extra root keys.** Each key is a quiet first move that wins in exactly the puzzle's length and
  is currently graded as a miss. Each has a subtree, and every extended tree replays to a road.
  - The puzzles: pd174036, pd253650, pd366364, pd421754, pd467023, pd540239, pd560708, pd575074, pd58362, pd625045,
    pd645055, pd730708 (3 keys), pd772259.
  - Most subtrees are 74–800 bytes. Five are 12–22 KB (pd560708, pd58362, pd730708 ×3: 300–730 lines), because the
    defender's longest-resisting replies branch a lot there. pd730708's tree grows by ~60 KB, so consider pulling it
    instead, since it has 4 winning ideas.
- **3 puzzles are broken.** A quiet first move wins faster than the stored length, and today that faster win is graded
  as a miss. The change set pulls them (grade D):
  - pd424243: 4e3> and 5e3> win in 7; stored 9.
  - pd98272: 4c4-13 wins in 7; stored 9.
  - pd816821: 3c2+ wins in 11; stored 13.

**Slower wins: partial.**
- **Cheap pass, all 1,118 conversions.** One df-pn per first move from the position after it, 3k nodes; 5 CPU-h.
  Followed by per-reply proofs for puzzles with 1–2 undecided moves.
- **Proven:** 61 new slower first moves in 28 6×6 puzzles (10 short, 18 deep), going into `swing.alts`.
  - p850076 alone has 24 winning first moves (nearly any move wins), so it's a candidate to pull.
  - pd614199 gains 3c3-12, a second slower win.
- **Fully decided:** 760 of 1,118 puzzles.
- **Still undecided:** 358 puzzles hold 2,411 first moves. These are left undecided; the browser's live check catches
  them (since d0ade43), and play-on settles what it can't.
  - A crux run (2026.11.15, 15:17–17:31, 6 workers under `taskpolicy -b nice -n 19`) tried only Syntaks's best
    defence per move. It covered 318 moves: 155 refuted, 163 survived. It found no new proofs.
  - Efficiency cores manage only ~2.6 moves/min, so the rest would take ~15 h. The run was paused when tinue's median
    latency reached 0.5 s, then killed at the main session's call.

**Logged root misses on crux.** 109 distinct (puzzle, move) misses from 135 attempts.
- **Proven wins, so a player was wrongly charged: 5.**
  - p860342 4e5<22 (6×6, A conversion)
  - p395846 2b3-11 and p220864 a7 (8×8)
  - p731883 b7< and p604147 5e6<122 (7×7)
  - All five are in the change set as slower alts.
- **The browser's existing `still` check would have proven 4 of the 5 in <0.5 s.** p860342 needs per-reply search,
  about 55 s.
- **pd614199/c2 (alion02's) stays undecided at 300k nodes per reply.** It's proven only at 3M per reply (the hand
  fix).

## Change set (applied 2026.11.15)

Path: `scratchpad/alt/altset/`
- `changes.jsonl`: 70 rows, one per field change.
- `apply.mjs`: one transaction, idempotent, refuses the real DB.
- `sidecars/`: patched copies of `swing-v4`, `deep-v4`, `grades.jsonl` and `deep-playtak.jsonl`. Changed rows are
  stamped `altwins-20261115`.
- `reimport-test.sh`

| class | field | puzzles | effect |
|---|---|---|---|
| same-length | tree (new root key + subtree) | 13 | the move is a solution |
| slower | swing.alts (+ flaw = 1) | 32 (28 6×6, 2 7×7, 2 8×8) | "That wins too, but slower", no miss (now: solved) |
| faster-pull | grade A → D | 3 | out of the served pool |

- **Re-import proof** (scratch copies):
  - apply.mjs vs re-import with the patched sidecars: **0 puzzles differ**.
  - Unpatched re-import vs the live local DB: 0 differ, so there's no pre-existing drift.
- **Served 6×6 pool:** 2,119 → 2,116 puzzles; flaw = 1 goes from 283 to 299. flaw = 1 costs FLAW = +100 in `pickNext`,
  so those 16 conversions get served a little less often.
- **Not included:** grade caps for conversions that turn out to have several winning ideas. syn6's `grade-cap` rule
  would demote some of them. Shy said keep the conversions, so that is left as a decision.
- **Installed:** the patched sidecars were copied over the originals (each differs only in its stamped rows: 14/18/3/13).
  `apply.mjs` wrote the 70 changes to the local DB in one transaction, and a rerun skips all 70. Afterwards every
  changed tree replays, with every root key at the puzzle's length. The served 6×6 pool is 2,116 with flaw = 1 at 299,
  and `npm test` passes on HEAD. A fresh import (default, then `--swing data/swing/deep-v4.jsonl`) gives the same
  result.

## Refunds: a refund counts as a solve (2026.11.20)

Why refunds exist: a player made a move that really wins, the puzzle did not know it (a missing key or alternative),
and the miss was taken back. Sasha, 2026.11.20, first relayed by the players-page session: "the refund should have a
special mark and we should make sure the puzzle rating was updated in the right direction"; then, asked how to correct
the puzzle ratings: "I think the refund can count as a win for the player".

The rule since then: a refunded miss is a solve. The player ends up with what a solve would have given (not just the
lost points back), games and wins count it, and the puzzle is rated as solved by that player instead of keeping the
rise the miss gave it. It stays visibly a refund.

- **The attempts row** reads as the solve (`win = 1, rated = 1`), and its `user_delta` is what the refund did to
  the player's rating: 0 when it was left as it was, and for a player the one-off raised, the whole raise on their last
  refund's row (0 on the others). A live refund (`scripts/refund.mjs`) gives no miss back, so its row's Δ is the
  miss's cost plus what the refund applied: the row's net effect, and the History still sums to the rating (a kept
  first-ever miss reads ✓ refunded −1161, which it did cost). Never the solve then (2026.11.21: a first-ever result's solve then reads +1097 for a
  player whose rating did not move); that figure stays in the refund event's note (`solve`). The player's History
  shows ✓ with a small "refunded" (title "Refunded: counted as solved") and that Δ. `attempts.refund = 1` is the
  mark: `REFUND_MARK` (`scripts/import.mjs`, flaw = 2), `/api/history` and the players page (↺✓, "counted as a solve") read it. The
  column is added at server startup (`addRefundColumn`, `server/log.js`) and by the refund scripts. The legacy
  signature (`rated = 0, win = 0, user_delta <> 0`) is still read everywhere (`REFUNDED_SQL`) until
  `refund-legacy-wins.mjs` has run on crux. The ledger's own `attempt` row keeps `result = 0`: at the board it was a miss.
- **Ledger refunds** (`scripts/refund.mjs`, dry run unless `--apply`, `--db` required, one transaction, the same
  refusals as before plus `attempts.refund` already set): the player's chain is replayed with the attempt as a solve, at
  the weights a solve would have had (the theme's win weight 0.1 unless the theme is full-weight; a guest's half on the
  puzzle side). The puzzle gets one compensating step from the states logged on that attempt's own rate event: the miss's
  move out, the solve's move in (`compensateWin`); attempts stay, solves + 1, rd and vol stay (a solve would have
  narrowed rd as the miss did). Other players' results are never rewritten. The `'refund'` rating_event carries the
  before and after states and `{asWin: true, w, pw, note: 'counted as a solve'}`; `replayUser` and
  `replay-ratings.mjs` replay it so. Never lower (2026.11.21): replaying the chain with a miss as a solve can end
  lower (a newcomer's miss far below them, then solves far above, which gain less from the higher path); then the
  player keeps rating, rd and vol and only wins change (games too for an upgrade): the note says `kept: true` with
  that delta and the computed change, the attempt replays as the miss it was, and the delta is added where the event
  stands (`neverLower`, `refundsOf`). A refund made the older way by `refund.mjs` before 2026.11.20 (left out of the
  chain, its attempts row `rated = 0`) is upgraded by running `refund.mjs` on it again: the chain is replayed with it as
  a solve, and the puzzle gets only the solve's move and its attempt back (`compensateUpgrade`: the older refund had
  already taken the miss's move out); its note says `upgrade: true`. `refund-legacy-wins.mjs` leaves such rows to it.
- **The 34 misses refunded by hand** on 2026.11.10–16 (before the ledger began on 11.17, so no ledger rows; 23 still
  stood in their puzzle's rating, per the players-page audit) are converted once by `scripts/refund-legacy-wins.mjs`
  (dry run unless `--apply`; `--db` required; one transaction; idempotent; refuses a database where the count, dates or
  shape differ from what it was written for; `--expect` overrides the 34). Exact history can't be rebuilt: ratings are
  path dependent and later results started from the raised values. What it does, oldest attempt first (the script's
  header has the detail):
  - deviations aren't stored, so for each rated row the player's and the puzzle's deviations then are the ones with
    which `rate()` reproduces both moves on record (the row's `user_delta`, and the step from its `puzzle_rating` to
    the next row's). Themes can't be known for these rows (weight 1 assumed); a guest's half weight on the puzzle is.
    Where a step can't be fitted, the puzzle's deviation is carried forward from the rows before it (250 before the
    first, else what `rate()` left after the last row that moved it, and after the Elo era the deviation the Glicko
    migration gave the puzzle, `rdFromCount(its rated rows, 250)`), never today's, which later results narrowed.
    Whether a player was still a newcomer (rd ≥ 230: `rate()` moves no puzzle for them) comes from replaying their own
    attempts rows from the start (three results bring rd from 500 to ~212), not from one inferred deviation;
  - the player: the difference a counterfactual makes, not the solve then added to today's rating. The first dry run
    on crux (2026.11.20) did the latter and put a player settled at 2977.8 after 159 games at 4075: their refunded miss
    was their first result ever, and a solve then (1500 ± 500 against a 2324 puzzle) is worth +1097. Now the player's
    own attempts rows are replayed twice from their start, as it happened and with their refunded misses as solves, and
    today's rating, rd and vol get the difference of the two end states (games and wins + 1 each). Glicko-2 carries that
    difference through every later result, so an early refund fades as later results pull the rating to where the
    player is (that player: about +5 in a synthetic replica), and a settled player refunded late keeps about the solve
    then. Opponents are the puzzles at their recorded ratings with the deviations inferred as above; the replay is
    anchored to each row's recorded rating; changes between rows that no result explains are hand edits carried in
    both runs, except each refunded miss's give-back, found among them (within 0.51, so one typed rounded to whole
    points is found) and left out of the solves' run; one not found is a refusal, since counting it as never given
    back would credit the cost twice. A newcomer's row can't fit its puzzle's deviation (it moved nothing), so the
    deviation fitted at the next row that moved that puzzle is used: it is exactly the one the newcomer met. The start is
    the documented one (1500 ± 250 / vol 0.09 before 2026.11.15, 1500 ± 500 / 0.06 since, a converted pre-Glicko
    account's rdFromCount; volatility today's, 0.06 or 0.09) that reproduces the recorded deltas best; Elo rows (before
    2026.11.07 18:02 PST) are not replayed. A themed result is recognised by a recorded delta well under the replay's.
    The History's Δ on the row is the change applied (above), not the solve then;
  - the check, printed per player: the as-played replay against today's rating and rd and against each row's
    `user_delta`. The replay drifts when today's rating is off by more than 25, today's rd by more than 15, or the rows' median
    miss exceeds a quarter of their median |delta| + 1. A bound besides: a player's correction after their first k
    refunds lies between minus those misses' costs and plus those solves (as the counterfactual made them), ± 10,
    because each later result only shrinks the difference (Glicko-2's step on it is a factor in (0, 1)). The first review's bound (that
    swing for every player) was wrong: an early refund's difference fades over dozens of results, not one (a
    first-ever refund 20 results back: +216 in a synthetic world, against ±42 for one result today). A correction can
    be negative (the higher path lost more on later misses);
  - **win, never lower** (Sasha, 2026.11.21): every refunded miss becomes a solve (attempts row, games, wins, the
    mark) whatever happens to the rating, and a player's rating, rd and vol change only when their correction, summed
    over their refunds, is above zero and their replay is trusted (no drift, every give-back found, every correction
    so far within its bound); it is then applied as computed, once, on their last refund's event. Otherwise they stay
    exactly as they are, and the dry run says why ("left unchanged: computed −16.9, never lowered", or the replay's
    flaw): untrusted means unchanged, never a guess, and it never stops the run or other players (`--allow-drift`,
    which raised a drifting player anyway, is gone). For a player who would be raised, a give-back not found or a
    bound overrun still refuses the whole run. An unchanged player's `refund` events have before = after but for
    games and wins (+1 each), so `replayUser` and `replay-ratings.mjs` still reproduce the users row; the note keeps
    the computed figures (`step`, `so`, `total`) beside `rating: 'raised' | 'unchanged'` and `why`. The dry run prints,
    per attempt and per player, the computed correction and what is applied, and the totals line how many players
    are raised and how many left unchanged, and why;
  - the puzzle: its recorded path is kept up to the first refunded miss, then replayed from there, every later result
    making its own move again from the replayed rating and the refunded misses making a solve's move instead. A guest's
    rows from before its account (replayed into attempts at sign-up) never moved the puzzle and move nothing here.
    Replaying with nothing changed gives back today's rating, but only because the deviations were fitted to do so: the
    dry run prints it as a consistency figure, not as a check of the corrections. What it prints as a measure of how
    much the corrections rest on estimates: how many rows had no fitted deviation, and how far the corrected ratings
    move with every inferred deviation 20% lower or higher. Where the step on record
    can't be matched: a rise already taken back by hand counts the solve from `rate()`; a newcomer's miss (rd ≥ 230)
    moved nothing and its solve moves nothing; a step bigger than one result can make keeps the excess as a hand edit.
    A puzzle put back to its start by hand starts there and is rated from it (rd included). rd and vol stay otherwise;
  - attempts and solves are recounted from the attempts rows (rated rows and every refunded miss; not a guest's rows
    from before it had an account, which never moved puzzles); the hand refunds had left them uneven (p849119,
    p544441 and others);
  - every change is a `'refund'` rating_event with before and after states and a `{legacy: true, asWin: true, delta, …}`
    note, hung on a ledger `attempt` row made for it (nonce `refund-legacy-<attempts rowid>`, result 0, `rated = 0` with
    `unrated_why = 'refund-legacy'`, so false-miss-report and rejudge don't take them for rated misses), because
    rating_event needs one; `replayUser` adds the delta where the event stands, so a later ledger refund of the same
    player and `replay-ratings.mjs` agree with the users row. The puzzle's after-state is taken as logged by the replay
    (it was rebuilt from attempts rows, which the ledger can't replay).
  - Why not replay every result from `init_rating` (the first proposal): that would swap a recorded path nobody disputes
    for a model of it. In a made-up world played through `rate()` with pd528655's shape (three of five results
    refunded), the splice lands within 15 points of that world's truth over a ~350-point correction.
  - Not verified on real data: the dry run on crux is the coordinator's step, shown to Sasha before `--apply`. The
    player-side tests are synthetic histories played through `rate()` (a first-ever refund with 10, 20, 40, 80 and 150
    results after, a settled player, a 13-game guest, five early refunds after a +970 start, drift (left unchanged), a give-back not
    found and one rounded, a drifting +1xx left unchanged, Elo-converted puzzles, a newcomer's row on a puzzle fitted
    later, a player whose correction is negative (left unchanged), a mixed run (raised, drifting, negative: ledger
    clean, a second --apply changes no byte), a hand-checked case);
    there each puzzle has one row, so its deviation is recovered exactly, which real puzzles shared by many players
    won't give: the dry run's per-player fit and ±20% figure are what to read.
  - `refund.mjs` (ledger refunds) has no such flaw: it replays the player's whole chain from its first logged state with
    the attempt as a solve, so later results are re-rated from the changed state rather than a delta added on top.
  - **Deploy first.** The code running on the server before this change reads a refund only by the legacy signature:
    after an `--apply` its `import.mjs` would find no refunded puzzle and clear their flaw = 2, and its players page
    would show the rows as plain solves. So deploy this change and restart tinue and tinue-players before `--apply`.
    The script checks: `--apply` refuses while `attempts.refund` is missing (the new server adds it at startup), unless
    `--no-deploy-check` (for a copy). Don't run the older `refund.mjs` in between.
- **The players page.** A refund's own move on the puzzle (`refund.mjs`'s compensating step, or this conversion) changes
  only `puzzles.rating`, at the time of the refund; the attempts rows don't record it. The rating path shows it as a
  step of its own at that time ("the refund counting it as a solve: puzzle −N"), so that no result is drawn with it (it
  used to land on the puzzle's last result: an ordinary miss drawn as lowering the puzzle by the whole correction). The
  refunded step itself is drawn as played (the miss's rise), marked ↺✓, with "missed when played (+X); counted as a
  solve: puzzle −N then".
- **The mark on puzzles** (flaw = 2, served 400 points back) is unchanged: a puzzle that cost a refund is still not
  trusted until it is fixed, whatever the refund counted as. A refund for an accident in the page (the puzzle is fine;
  a player on pd460160, below) has `user_delta = 0` and no `refund` mark and is not a solve: nothing here touches it.

### Before 2026.11.20 (history)

Refunds then gave the lost points back and took the game off; the puzzle kept the miss's rise unless nothing else had
been played on it.

`altset/refund.mjs` lives on crux's DB, where the attempts are. It's a dry run unless `--apply`. It validated against a
crux snapshot on 2026.11.15. Six rated root misses played a move that is now proven to win:

| player | puzzle | move | refund |
|---|---|---|---|
| shy | p395846 (8×8) | 2b3-11 | +16.3 |
| shy | p220864 (8×8) | a7 | +33.2 |
| shy | p731883 (7×7) | b7< | +18.1 |
| shy | p604147 (7×7) | 5e6<122 | +16.9 |
| player A | p860342 | 4e5<22 | +13.7 |
| player B | pd614199 | 3c3-12 (after an accepted c2) | +19.2 |

- Each attempt becomes unrated (`rated = 0`), `users.rating -= user_delta`, and `games -= 1`.
- The user's rd/vol aren't reverted, and neither is the rating move of a puzzle that still has rated attempts. Neither
  is stored per attempt, and the effect is small.
- Puzzle side: a puzzle whose rating rests only on refunded results (no rated attempt left, and the refunded attempts'
  `puzzle_rating` equals `init_rating`) goes back to its start: rating = `init_rating`, rd 250, vol 0.09, attempts
  and solves 0. Where rated attempts remain, leave the rating and lower attempts/solves by the refunded ones.
- Player C's c2 attempt was already unrated.
- Since 3421d53 a slower win ends the puzzle as a solve, so player B's case can't recur.
- Refund mark (2026.11.16; Shy: "if someone got a refund due to a puzzle and we're not confident it was fixed we
  should down prio it"). A refunded attempt keeps its trace: `rated = 0, win = 0, user_delta <> 0` (an attempt recorded
  unrated has `user_delta` 0). A puzzle with such an attempt and no stored alternative (`flaw IS NULL`) gets
  `flaw = 2`. The picker ranks it 400 points back (`REFUNDED` in `server.js`), gives it no pull for being played, and
  the daily puzzle skips it while the band has anything else. So it's served only when nothing else is within 400 of the
  target.
  - After a refund, run `REFUND_MARK` (the UPDATE in `scripts/import.mjs`) on crux's DB. Every import runs it too
    (deploys import on crux), because import rewrites `flaw` from `swing`.
  - The mark clears by itself when the puzzle gets stored alternatives (`flaw = 1`: the refunded move, or its
    siblings, are then accepted at once). A fix that changes only the tree (a new same-length key, no alts) doesn't
    clear it; no refunded puzzle was fixed that way so far. If one is, the refund signature needs a way to say "fixed".
  - A refund for an accident in the page, where the puzzle itself is fine, must not leave that trace: set
    `user_delta = 0` on the attempt as well, so the puzzle isn't marked. First case, 2026.11.16: a player on
    pd460160 (−10.2). A double tap on Next landed on the new puzzle's Solution, a miss 16 ms in
    (fixed in a4f43de). Their rating got the 10.2 back, games − 1, and the puzzle went back to its start (it was its
    only attempt). Backup: `data/tinue.db.bak-pre-refund-*` on crux.
  - 34 attempts were refunded up to 2026.11.16, on 29 puzzles: 8 already had stored alternatives, 21 got the mark
    (3 7×7/8×8, 15 6×6, 3 5×5). Before the mark, the played-but-unsettled pull (`PLAYED`) was drawing players onto
    these (pd528655: 5 plays, 3 refunds).

## gruppler's tinue-solver (PTN Ninja), evaluated

Notes: `scratchpad/gsolver/NOTES.md`. MIT; needs Rust ≥ 1.92.
- **What it is.** Full-width alpha-beta over every move for both sides, so it sees quiet moves at any ply. Its
  `tak-chain` scope is threat-only, like ours.
- **Limits.**
  - It never credits the attacker with a flat win.
  - Komi is fixed at 2: the CLI and wasm take no komi, and only TEI has `halfkomi`.
  - Its "no tinue" means "none within N plies".
- **pd614199.**
  - Correct on the key at 7 plies (36 ms), and correctly rejects c2 at 7 (0.2 s).
  - It found no c2 win within 11 plies (35 min, under swap) and was stopped during depth 13. So c2's longest
    defences go past 11 plies.
- **Speed.** Full scope costs 100–10,000× our prover at 11+ plies (pd880301: 399 s just to verify the key, against
  our 0.4 s).
- **Where it fits.**
  - Offline, as a second opinion on quiet alternatives up to ~9 plies.
  - In the browser, through PTN Ninja's 167 KB wasm in a worker, only for "does this move also win within ≤7 plies".
  - It doesn't replace our prover.

## Not done

- **5×5** (3,459 deep + 1,333 short A conversions). Same pipeline, but there's no 5×5 Syntaks binary for the
  defence ordering; the syntaks-5x5 session's port could supply one.
- **The 2,411 undecided 6×6 moves** (358 puzzles). Left to the browser's live check and play-on (d0ade43).
- **Positions deeper in 9+ ply lines.** Same-length quiet keys are also missing there; only the root was scanned.

## pd575074: a faster quiet win past the root (2026.11.16)

alion's report. pd575074 (6×6, komi 2, stored 11 plies, grade A) has two root keys: the original 6e3- and the quiet
6e3+15, added on 2026.11.15 as a same-length key (change 53 in `alt-wins-changes.jsonl`). After 37. 6e3+15 2c5- the
quiet 38. 4c3+ is not in the tree; the page accepted it as a solve (rated win, no refund needed) but its card said "the
puzzle's faster line starts with 4e5<112". Checked at full width (`winIn`/`allLose` in `shared/tak.js`, no threat
restriction; the 4c3+ proof re-verified by a separate proof-tree walk: 514 attacker nodes, 34,570 road leaves):

| move at ply 38 | wins within 7 | wins within 9 | nodes |
|---|---|---|---|
| 4c3+ (off-tree, quiet) | **yes** (not within 5) | | 226M, 122–220 s |
| 4e5<112 (the tree's main move) | no | yes | 7.9M @7; 478M, 592 s @9 |
| e2 (tree) | no | undecided (stopped at 28 min) | 38.7M @7 |
| e3 (tree) | no | undecided (stopped at 28 min) | 17.7M @7 |

So the off-tree move is *faster* than every stored move at that node. Every other Black reply to 37. 6e3+15 (82 of the
83 that don't lose at once) loses within 5 more plies at full width, so 6e3+15 forces a road by ply 9: two quiet moves
(6e3+15, then 4c3+) beat the stored length 11, which the one-quiet-move scan could not see (the model caveat under
Results). Not decided: whether the root has a win within 7 (`winIn(7)` at the root ran out of V8 Map space; within 5 it
has none), and whether the original key 6e3- can also be shortened (not searched).

What follows:
- "An off-tree proven win is slower" holds only at nodes with ≤5 plies left (exact brute-force trees) and for the lists
  built by exact search (short-puzzle `alts`, `altsAt`, the 4×4/5×5 quiet alts). With 7+ plies left, the root of a deep
  puzzle included, an off-tree win can be slower, the same length or faster, and nothing stored or computed at playtime
  gives its length. The card no longer says "faster" ("…; the puzzle's line plays X instead"); comments in `app.js`,
  `engine-worker.js` and `server.js` were corrected.
- A deep puzzle's `plies` is its length under the prover's model (Tak threats after the first move). The real shortest
  win can be shorter through a quiet move deeper in the line. This is the "positions deeper in 9+ ply lines" gap under
  "Not done"; pd575074 is its first confirmed case, and it shows the 15 "same-length" keys added on 2026.11.15 are
  same-length only under that model.
- Regraded A → D (Sasha, 2026.11.16), as the three faster-first-move puzzles were: a quiet first move wins in 9
  against the stored 11, and the prover can't rebuild it as a 9-ply puzzle (that needs a second quiet move, and the
  root's win in 7 and the 6e3- key are undecided). D is the "never serve" grade, so it leaves the served pool; it
  still opens by its link. Row 71 of `alt-wins-changes.jsonl`; sidecar row stamped `altwins-20261116`; prod got a
  one-row update after a `.backup` (no attempt to refund: the one attempt was a rated win).
- Open (Sasha's call): whether to scan past the root of 9+ ply puzzles for quiet wins. One node cost 226M nodes at
  full width here, so a scan needs a cheaper method (df-pn with a second quiet move allowed, as `scan2.mjs` does for
  the first).


## Live safety net at the root (proposal: needs Shy's OK, visible behaviour)

Status: (1) is done in a wider form. Since d0ade43 every off-tree move the precomputed lists don't decide gets the
live check, at any node of any puzzle, road-in-1s included, and a move still undecided is played out on 4×4–6×6 (play-on); on 7×7/8×8 the result is held while the check runs on. Any
proven win is a solve (3421d53), with no separate same-length test or `k: 'alt'` log. (2) and (3) are not done. The
text below is the proposal as written.

Precomputing every slower win is expensive (a hard one like pd614199/c2 costs minutes per move) and the threat-only
prover can't see wins that need a second quiet move. So a live check at the root is worth having. Three pieces, in
order of cost; recommend (1) + (3), with (2) behind (3):

1. **In-browser root check (small).** Today `userMove` re-checks a non-tree move only past the root of 7+ ply puzzles
   (`S.p.plies >= 7 && S.moves.length`). Extend it to the root of every 3+ ply puzzle (a road-in-1 stays exempt: there
   a slower win is rightly wrong). It reuses the worker's `still` check (df-pn, then confirmed with full defence) and
   the existing "Checking c2…" card. Two changes to the check itself:
   - at the root, first a **same-length** test (depth plies−1, cheap: the 856-puzzle scan averaged ~70 ms per move);
     a hit means the puzzle was wrong, so accept it as **solved** ("c2 also wins in 7: solved") and log `k: 'alt'` so
     the server can flag the puzzle;
   - then the unlimited test as now ("That wins too, but slower", no miss).
   - Cost to players: a wrong first move waits up to 2.5 s (most are disproved in milliseconds). Catches only the
     cheap cases; pd614199/c2 would still be a miss in the browser.
2. **Server-side, asynchronous proof with refund (medium).** On a root miss the client already uploads its move log.
   A separate niced worker on crux (not the API process; one job at a time; ~5 CPU-min cap per move) runs the per-reply
   proof (`prove2.mjs`). If it proves the move: append it to the puzzle's `swing.alts` (DB + a sidecar patch file so
   re-imports keep it), and refund every rated attempt whose root miss was that move: subtract `attempts.user_delta`
   from the user's rating, mark the attempt casual, and tell them on their next visit ("Your c2 on #614199 was proven
   to win: +12 restored"). The puzzle's own rating change isn't stored per attempt, so it stays (small).
3. **"I think this wins" button (small, pairs with 2).** After a root miss, offer a button that sends the move to the
   worker. That spends crux CPU only when a player believes it (Shy's idea), and doubles as a report channel. Without
   (2) it could just record the claim for offline proving.

Open questions for Shy: accept a proven same-length alternative as *solved* (1), or as "wins too" only? Is a refund
worth the complexity, or is "we fixed the puzzle" enough? Should flaw = 1 keep its serving penalty (FLAW = +100) when
the alternative is a slower win in an otherwise good conversion?
