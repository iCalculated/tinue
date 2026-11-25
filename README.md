# tinue

A Lichess-style puzzle trainer for [Tak](https://ustak.org). You get a puzzle near your rating, the opponent
answers your moves automatically, any move that still forces the win counts, and both you and the puzzle
are re-rated after your first attempt.

```bash
npm start                  # http://localhost:8642  (node >= 22.13, zero npm deps)
```

Tests: `npm test` (rating unit tests, property-based tests in `scripts/test-props.mjs`, an API run on a throwaway DB,
the engine's perft/differential suite, the in-memory picker against the SQL it replaced: `scripts/test-picker-equiv.mjs`, which
takes a database to copy for a run on real data). `npm run verify` proves the picker's guarantees with the Z3 SMT solver
(`scripts/verify-picker.py`, via `uv`; the only non-Node tool, and not part of `npm test`).

## How it works

Everything heavy happens **offline** (mining, solving, tagging) or **in the browser** (move validation,
opponent replies, win detection). The server (`server/server.js`, plus `share.js` for link previews and `syntaks.js`
for 6×6 analysis) is static files plus a small SQLite API (`users`, `puzzles`, `attempts`, `daily`; `guest_attempts`
from older clients). It should run on the smallest VPS.

| piece | file | notes |
|---|---|---|
| Rules engine | `shared/tak.js` | TPS/PTN, legal moves, Zobrist hashing, road/flat/dragon-clause wins, brute-force win-in-N solver with TT. Perft-exact (5×5 d4 = 2,999,784). Same file runs in Node and the browser. |
| Analyzer | `shared/analyze.js` | For each puzzle: proves the shortest forced win, builds the **solution tree** (every winning move at every attacker node + one chosen defender reply), tags tactics, computes a prior rating. |
| Miner | `scripts/mine-playtak.mjs` | Walks back from the end of every road-win PlayTak game and takes the **earliest** position that's already a forced win (≤ 5 plies) — the moment the tinue appeared. The loser's mistake is replayed as the opening animation, like Lichess. |
| Importer | `scripts/import.mjs` | Loads `data/puzzles/*.jsonl` into SQLite. Re-runnable; played puzzles keep their earned ratings. Merges turning-point scores from `--swing` (default: `data/swing/swing-v4.jsonl` if present, else none; refuses a sidecar superseded by a newer `-vN` of its family unless `--allow-superseded`). A full rebuild needs a second run, `--swing data/swing/deep-v4.jsonl`, for the deep (pd*) puzzles. |
| Stats | `scripts/data-stats.mjs` | Prints live counts from a puzzle DB (read-only): puzzles by size, length and miner, the served pool, grades, attempts. Docs point here instead of quoting numbers. |
| Server | `server/server.js` | Players: guests (a nameless `users` row, made by their first result) and claim-a-username accounts, both a random token (bearer header or cookie; honor system) and both rated here, next-puzzle selection (turning points first; ranked in memory by `pool.js`), rating updates, per-IP rate limits. Serves `dev/` (test pages) only when `TINUE_ORIGINS` is unset. |
| Client | `public/` | The board is [PTN Ninja](https://ptn.ninja) in an iframe (`public/ninja.js`), as PlayTak embeds it. Our engine judges moves and supplies replies. After the solve, positions are evaluated by Syntaks on the server for 6×6 (`server/syntaks.js`, `/api/analyze`), else by Tiltak (WASM, in the browser). A move the browser can't prove or disprove in time is played out against Syntaks (6×6: in the browser as WebAssembly with Ciekce's cnet023 net, `public/syntaks.js` + `public/syntaks/`, built by `wasm/syntaks/build.sh`; crux's `/api/defend` while it downloads or on slow devices) or Tiltak (4×4/5×5) defending: "play on", `public/playon.js` and `startPlayOn` in `app.js`. Where Syntaks defends (6×6 at a komi it knows) a proven off-tree win is played out the same way against it, to a road ("proven play-out", Shy 2026-11-16: "Make people prove winning sequences! Just fine if they are slower"; "Rated miss when defended"): the win is a full rated solve; failing to finish, giving up, viewing the solution or leaving for another puzzle is a rated miss once Syntaks has defended and moved; a reload or closed tab is unrated. The move cap covers the proof's length (`provenCap`); while that isn't known, running out of moves is unrated. Elsewhere (Tiltak or no defender) a proven win is solved on the spot. No defender resigns (`RESIGN_UNPROVEN` in `playon.js` brings back resigning in an unproven play-on). Side panel: feedback, the game's history leading into the puzzle (click any move to view it), history, leaderboard. |

### The board

- **PTN Ninja is the only board** (2026-11-22): [ptn.ninja](https://ptn.ninja) in an iframe, driven over postMessage the
  way PlayTak embeds it (`public/ninja.js`). Every visit, whatever a stored Board setting or a `?board=` in the address
  says (both are ignored).
  - An inline script in `index.html` preconnects and starts the iframe as the page loads; the frame stays hidden until
    the puzzle is drawn. Rush borrows the same frame.
  - No fallback. If PTN Ninja says nothing 8 s after its page loaded (a blocked ptn.ninja loads an error page), or
    isn't up 45 s after the frame started while its page is still loading (a slow phone is waited for: "Loading the
    board…"), or stops answering (a heartbeat), the board's place says so with a Retry button. Meanwhile nothing can be
    played: no move is judged, no rating changes, the puzzle's solve clock is paused, and Rush's clock never starts. A
    Rush or Streak run whose board stops answering ends there, posted as abandoned (never a best, not kept in Recent
    runs), and the end screen says why.
  - With reduced motion (the system setting), PTN Ninja's pieces don't animate.
  - The board's look (Settings: Board theme, Board look) is PTN Ninja's settings and theme; "tinue felt" is the
    default, "tinue classic" the old brown checkers.
- **tinue's own board** (`public/board.js` + `board.css`) is retired: the code is kept for now, but constructing it
  throws ("tinue's own board is retired: PTN Ninja is the only board"), and the page never loads it. What the page
  needs of it (`buildPTN`, `landOf`, `turnMark`, `focusedByPointer`, the sound hooks) is in `public/board-kit.js`.
- Still drawn by tinue itself, as still pictures (not boards): the share and og images (`server/share.js`) and the Rush
  end screen's pictures (`public/rush-look.js`, with `board.css`'s colours).

### Deploying

Code and puzzles ship separately. Every script takes `--dry-run` (or `DRY_RUN=1`): it prints each ssh, rsync and
destructive step instead of running it. `scripts/test-deploy.mjs` (in `npm test`) runs them all against a fake crux.

- **Everything, in order:** `SITE=$HOME/Projects/site scripts/ship.sh [--puzzles] [--no-push] [--legacy]`.
  1. API code to crux (`deploy-crux.sh`).
  2. With `--puzzles`, new and changed puzzle rows (`publish-puzzles.sh`); otherwise skipped.
  3. The static client: `build-static.sh` into `$SITE`, then publish it (`publish-site.sh`; `--no-push`
     commits without pushing). Before anything ships, the source goes to its public repository (`push-source.sh`), and it refuses unless `$SITE` is on `main` with nothing unpushed,
     since the push sends the whole branch.
  4. `check-public.sh`: the Cloudflare host failing fails the ship; a Funnel relay failing is only a warning.

  API first: open tabs keep calling whatever API is up, so it has to stay compatible with them anyway.
- **API code only:** `scripts/deploy-crux.sh`. Writes `deploy/revision.json` (commit, and a hash of any uncommitted
  diff), rsyncs `package.json`, `server/`, `shared/`, `public/` and `scripts/` (not `scripts/archive/` or `dev/`),
  writes the launchd plist (`MIN_BUILD`, `BOOK_VER` and `JUDGE` from `scripts/deploy-lib.sh`), restarts
  `com.shy.tinue`, waits up to 30 s for `/api/stats` on crux itself, and keeps Funnel on 8443 only. It never writes a
  puzzle row. Run `scripts/check-public.sh` after a bare deploy. `--legacy` is the pre-2026-11-17 path
  (`deploy-crux-legacy.sh`: code plus a full export re-imported on crux), kept until the split has been used once.
- **Puzzles only:** `scripts/publish-puzzles.sh [--all] [--overwrite-remote-edits]`. Fingerprints every public row
  here and on crux (`scripts/puzzle-rows.mjs`), ships only rows that differ, and on crux: snapshots the database to
  `data/snapshots/` (checked), runs `import.mjs` on just those rows in one transaction, restarts, waits for health,
  then fingerprints again and checks every shipped row. A row edited on crux since the last publish is held and listed
  unless `--overwrite-remote-edits`; `--all` ships every public row. Nothing to ship writes nothing. Rollback: stop
  `com.shy.tinue`, copy the snapshot over `data/tinue.db` (remove `-wal`/`-shm`), start it; attempts since are lost.
  Hand grades (`scripts/grade-overrides.jsonl`) reach crux with the code and apply, to every row, at crux's next
  import (a publish with nothing to ship runs none).
- **Static client only:** `scripts/push-source.sh`, then `SITE=$HOME/Projects/site scripts/build-static.sh`, then
  `SITE=$HOME/Projects/site scripts/publish-site.sh tinue '<what>'`. The beta: `build-beta.sh`, then `publish-site.sh tinue-beta '<what>'`.

  `SITE` has no default: for a test build, point it at a scratch directory. A lock stops two builds writing into
  the same directory at once.
- **Puzzle state columns** (`kind`, `status`, `pre0`, `miner`, `book`; `server/puzzle-state.js`; the
  picker reads `status` and `kind`): the server adds them at startup and every import refills them right after it commits. Once after the first
  deploy of that code (before the first publish), and after any hand edit of `turn`/`grade`/`swing` on crux, run
  `node --no-warnings scripts/puzzle-state.mjs` there. It is safe while people play (the server waits out its short
  write transactions); `--check` writes nothing, and a re-run writes nothing.

The static build:
- copies `public/` and the shared modules;
- points `config.js` at the crux API;
- stamps every script/style URL (Pages lets browsers cache for ~10 min);
- writes a page per puzzle so links unfurl in Discord;
- checks that every imported module was copied.

The puzzle pages come from the local `data/tinue.db`, so check that their diff is what you expect before
committing.

### Where things live

- **Source:** https://github.com/iCalculated/tinue, branch `main`. Its history starts at the move out of the author's
  private repository; `scripts/hooks/pre-push` keeps the older commits out (install it: `cp scripts/hooks/pre-push .git/hooks/`).
- **The built page:** branch `site` of the same repository (the beta: branch `beta`), unrelated to `main`, with the page
  at its root. `version.json` names the source commit.
- **The site:** the repository behind shydrie.xyz holds those branches as submodules, `tinue` and `tinue-beta`. GitHub
  Pages fetches submodules over https from public repositories only, so this repository has to stay public.
- **Roll back the page:** in the site repository, `git revert --no-edit <the pointer commit> && git push`, then
  `git submodule update tinue`. The next publish builds on the tip of `site` whatever the pointer says.

### tinue.me

`DOMAIN=tinue.me` makes `scripts/build-static.sh` build for its own domain (API at api.tinue.me, `CNAME`, `404.html`); without
it nothing changes. `PAGES=$SITE/tinue sh scripts/publish-site.sh tinue` pushes that build to branch `site`, which GitHub
Pages serves itself. The old address then gets the handoff page: `scripts/build-moved.sh` on the last build made for it,
and `publish-site.sh tinue-moved` (branch `moved`, then the pointer). It brings a visitor's player, settings and unsent
results to the new address once, encrypted for a one-use key the new page makes (`moved/import.js` says how), and forwards
old links. Tests: `scripts/test-handoff.mjs`, and `scripts/e2e-handoff.mjs` in headless Chrome. The server's side: `ops/README.md`.

Results wait in the browser until the server has them (`public/results.js`).

### Puzzle format

```json
{"id":"p880284","size":5,"tps":"x,1,2,x2/112121,x,2C,1,x/x,21C,x,2,x/2,x2,2,x/2,x4 1 12","plies":3,
 "tree":{"5a4-122":{"r":"c5<","n":"win"}},"tags":["s5","fork","tinueIn2","spread"],"rating":1640, ...}
```

`tree` is either `"win"` (any immediately winning move is accepted) or a map from **every** winning attacker
move to `{r: defender reply, n: subtree}`. Because the tree is precomputed, the browser does no search —
it just looks up your move.

**Defender replies** are chosen to (1) survive longest, then (2) leave the attacker the fewest winning
continuations (most "only-move"-like), then (3) match what happened in the real game, then (4) prefer
walls/caps. The source data's replies are often arbitrary corner walls (`Se1`, `Cg1`) because, in a
tinue, everything loses; (2) makes the line as instructive as possible instead.

### Turning points

We want tactics that *change the course of the game*, not ones where the winner was already winning and just wins
faster (see `docs/mining-options.md`). An offline scoring pass writes a sidecar, one line per puzzle:
`{id, pre0, pre2, pre4, lostBefore, alt, turn}` (attacker = the side that wins the puzzle; p = Tiltak's
(score + 100) / 200 from the attacker's side):

- `pre0`: attacker p right before the loser's mistake (`pre2`/`pre4`: 2 and 4 plies earlier). All Tiltak evals run at
  komi 2, whatever the game's komi: at komi 0 Tiltak gives white ~0.87 from the opening, while white really scores
  ~0.60 in these games, so a komi-0 baseline made black attackers turning points almost automatically and white
  ones rarely. Proofs use the game's real komi. (`--eval-komi game` restores per-game komi.);
- `lostBefore`: `proved` if df-pn shows every loser move at pre0 still loses to a tinuë (the "mistake" changed nothing);
- `alt`: attacker p after their best *non-winning* first move at the puzzle (if high, missing the tactic still wins);
- first-pass `turn`: 1 iff pre0 ≤ 0.6, not `lostBefore = proved`, and alt < 0.65; 0 otherwise; null for 7×7/8×8.

A second pass (`score-swing.mjs --refine data/swing/swing.jsonl` → `data/swing/swing-v2.jsonl`) is
stricter, after an adversarial check of the first pass found ~8% false turning points and a puzzle defect:

- `alts` (3+ ply puzzles): first moves outside the solution tree that *also* force a win (every Tak-threat move,
  df-pn confirmed with full defense); `flaw = 1`. The tree holds every win at the puzzle's minimal depth, so these
  are slower wins, which count as solves; the lists are the fast path, and any other off-tree move is checked live in
  the browser (and played out against an engine when the check can't decide). 57% of 3/5-ply puzzles have
  one, so `flaw` is only a mild serving tiebreak. Road-in-1s get no precomputed alts; the browser checks them live.
- candidates are re-measured: pre0 at 50k nodes; alt over *every* non-tree move at 5k plus the best 3 at 50k (the
  first pass's 100-node prefilter once missed a winning move); `esc` = exact check (4×4, 5×5 multi-ply) that the
  loser had an escape before the mistake (df-pn's threat model misses quiet/flat-count wins).
- `turn`: 1 iff pre0 ≤ 0.5, not lost before, alt < 0.65 (0.70 for road-in-1s, where 0.65–0.70 was noise), and no
  `alts`. (The 0.5–0.6 band failed the stricter checks 45% of the time.)

A third pass (`score-swing.mjs --patch data/swing/swing-v2.jsonl` → `data/swing/swing-v3.jsonl`)
followed a second adversarial check (v2 turning-point precision ≈ 81–88%; slower wins still marked wrong deeper in):

- `altsAt` (5-ply): slower wins at later attacker moves, keyed by the space-joined moves played so far; the client
  accepts them like `alts`. `alts` also gains quiet (non-threat) slower first moves on 4×4 and 5×5 3-ply (exact
  Solver, win within plies + 2), which the threat-move search can't see. Either one sets `flaw`.
- turning points only, demotions only: `slow1` = a road-in-1 with a proven slower win (not a unique tactic); komi-0
  games near a flat ending are re-evaluated at the real komi (`pre0k0`/`altk0`; komi 2 flips flat-count endings);
  `esc` horizon 5 on every 4×4 and near-flat 5×5; rows near the cutoffs (pre0 > 0.4 or alt ≥ 0.55) re-evaluated at
  1M nodes (`pre0Deep`/`altDeep`, top 5 alternatives). The worst of the measured values decides.

`swing-v4.jsonl` (what we import, with `deep-v4.jsonl` for the deep puzzles) is v3 with the 6×6 rows corrected by a
Syntaks screen (2026-11-15); rows it rewrote carry `syn6`, which is how `import.mjs` recognises an older copy.

`import.mjs` stores `turn`, `flaw` and the evidence as JSON in `swing` (columns on `puzzles`); `publish-puzzles.sh`
carries them to crux. Next-puzzle selection (`/api/next`, `/api/group`) ranks candidates by rating distance plus a handicap: +150 for
unscored, +250 for conversions, +100 for flawed puzzles, +400 for a puzzle that cost someone a refund and has no
stored alternative yet (`flaw = 2`, docs/alt-wins.md, Refunds). So a turning point is preferred unless a conversion is 250
points closer to your target (past that, an off-level puzzle is the worse puzzle).
The pick is random among the 24 best-ranked that share the best candidate's tier (turn, flaw) and score within 75
of it, biased toward the nearest. Every puzzle still opens by id (`#/puzzle/<id>`).
After a turning-point puzzle the info panel says so; `/api/stats` has `byTurn` and `/api/themes` a `turning` count.

### Ratings

- **Players and puzzles: Glicko-2** (`shared/glicko.js`), one rating period per attempt, as on Lichess.
  Players start at 1500 ± 500 with volatility 0.06 (Lichess: ± 500, 0.09), so a newcomer's first results move the rating
  a lot (a 2300 player is within 100 of their level after a median of ~10 puzzles, 2450 ~15, 2800 ~35;
  `scripts/simulate-newcomers.mjs`) and a settled rating moves about ±10 per puzzle. Puzzles start at their prior ± 250. A result from an uncertain player moves a puzzle
  less. Ratings show "1650?" while the deviation is ≥ 110, and the leaderboard marks them the same way.
  Only the first decisive result is rated. Any proven forced win counts as a solve, however long. A wrong move is
  a loss (then you can keep trying, unrated). An off-tree move the precomputed lists don't decide gets a live check
  in the browser (up to 2.5 s), at any node of any puzzle. A move still undecided is played out on the board: against
  Syntaks on 6×6 (rated either way only if Syntaks defended throughout), against Tiltak on 4×4/5×5 (unrated). On
  either, a win the check (still running) proves is rated. Where no engine defends (7×7/8×8) the result is held while the check runs on, and goes in
  unrated if it never settles. Hints make it casual. Viewing the solution before a result is a loss. A miss from a
  page build older than `TINUE_MIN_BUILD` is unrated. Otherwise the same rules as Lichess.
- **Guests** are rated by the server like accounts (since 2026-11-15; before, in the browser): a visitor's first
  result makes them a nameless user, and claiming a name keeps the rating and history. A guest moves puzzle ratings
  at half weight (`GUEST_PUZZLE_WEIGHT`, times any theme weight), and like anyone not at all while their deviation is
  ≥ 230 (the first couple of results); at most 10 new guests per IP per hour. Guests aren't on the leaderboard.
  A guest from before gets the rating the server replays from the first tries its browser reported
  (`guest_attempts`, `replayGuest`), which also become its history; the rating the browser kept is not trusted.
- **Theme damping** (from Lichess): drilling a named theme partly gives the answer away, so those results
  move ratings by 0.1× (win) / 0.7× (loss) (`THEME_WIN_WEIGHT`, `THEME_LOSS_WEIGHT` in `shared/rating.js`), except a theme marked `fullWeight` in `shared/themes.js` (Deep tinuë), which counts in full.
- **Prior (bootstrapping):** Lichess starts every puzzle at 1500 ± 500 and lets its traffic sort it out.
  We can't, so each puzzle starts at a feature-based guess: 900 / 1500 / 2100 / 2450 for 1 / 3 / 5 / 7 ply,
  adjusted for number of winning first moves, stack/spread first move, quiet moves, defend-first, board
  size, and how many nodes the solver needed (`shared/analyze.js: priorRating`).
- **Batch re-rating** (`scripts/archive/rerate.mjs`) is retired: a joint MAP fit of all players and puzzles.

`scripts/archive/simulate-glicko.mjs` compared the old shrinking-K Elo with Glicko-2: a new player gets within 120 of
their true skill in ~12 puzzles instead of ~50, and puzzle ratings end up closer to the truth.
`scripts/simulate-rating.mjs` compares online Glicko with the batch joint fit; they now nearly agree (puzzle
RMSE 182 vs 181), so nothing re-rates in batch.

### API for bots

Read-only, public profile data only (the same as the leaderboard), 120 requests/minute per IP:

- `GET /api/users/:name`: `{ user: { name, rating, rd, provisional, games, wins } }`, or 404.
- `GET /api/users?names=a,b,c`: `{ users: [...], missing: ["c"] }` (up to 20 names, case-insensitive).
- `GET /api/daily`: the puzzle of the day, `{ day: "YYYY-MM-DD", puzzle: { id, url, size, komi, rating, turn, toMove, tps } }`.
  Same for everyone for a whole Pacific date, never repeated (`daily` table). Like Lichess's (2150–2300) it comes
  from a hard band: a random 6×6 turning point rated 2000–2400 (5×5 until 2026-11-14) that nobody has tried signed in, with fallbacks.
- `GET /api/group?names=a,b,c`: the puzzle of the day plus those players' profiles and average rating
  (`{ day, users, missing, rating, puzzle }`). Until 2026-11-13 it picked a per-group puzzle; a chat bot calls it daily.
- `GET /api/leaderboard`: `{ leaders: [{ name, rating, games, wins, provisional }] }`, the top 50 named players with a rated puzzle.
- `GET /api`: this list as plain text, for whoever writes a bot.

### Logs

The server appends one line per request to `data/access.log` (time, method, path, status, server ms, an 8-char
hash of the client IP, user id), rotated at 5 MB. The browser abandons a stalled request after 8 s (reads retry
once) and reports any request that took it over 2 s to `POST /api/slow`, logged as `SLOW-CLIENT`. A
`SLOW-CLIENT` line with no slow server line next to it means the time went to the network, not the server.

Latency: visitors reach crux through a Cloudflare Tunnel (`tinue-api.shydrie.xyz`; TLS ends at Cloudflare's edge near
the player, so a new connection costs ~0.1 s). Tailscale Funnel (`crux.tail5ed24.ts.net:8443`) stays up for old builds,
bots and old shared links; its relays cost ~0.4–1.2 s per new connection on a good day and several seconds on a bad
one, which is why the site moved off it (2026-11-16). The client hides most of what's left: the static page
preconnects to the API while its modules load, startup requests (`/api/me`, `/api/themes`, `/api/next`) go out
together, and preflights are cached for 2 h. The next puzzle never waits: while you play one, `/api/next?for=<id>`
picks what follows it both ways (at the rating a solve or a miss will leave), the result chooses, and the chosen one is
stored in the browser until played, so a return visit starts without asking (after a hint, the pick is made after the
result instead). That pair is for provisional players and guests, whose rating moves a lot per puzzle. Settled players
(no "?") keep a queue instead, as Lichess's app does: `/api/next?n=10` picks 10 at their rating, refilled when 2 are
left (so batches overlap) and re-picked once their rating drifts more than 50 from the batch's (the old queue serves
until the new batch is in); one request per ~8 puzzles instead of two picks per puzzle. If the queue is empty at a
puzzle's start (a batch slow or failed), that puzzle also gets the pair, so nobody waits. (Lichess's site serves a fixed 200-puzzle "path" per rating bucket, re-picked after a 100-point drift.) A page load is ~75 KB gzipped plus fonts; the engines (Tiltak's 550 KB wasm) load only after a solve.

### Themes

Tagged from the main line (Lichess `cook.py` style) by `tagPuzzle` in `shared/analyze.js`; names and the definitions
players see (under the Theme menu, and on a finished puzzle's tags) are in `shared/themes.js`. Keys: `roadIn1`,
`tinueIn2`/`3`/`4` (Road in 2, 3, 4+), `deep` (a list, `scripts/deep-proven.jsonl`), `gaelet` (Flat win), `fork`,
`quietMove` (Non-Tak tinuë; never on flat wins), `smash`, `spread`, `throw`, `stackRoad`, `reveal` (Drawbridge),
`capture`, `wallBlock` (Defend first), `placement`, `dragon`, and the board size. Names follow USTA's terminology page
(https://ustak.org/tak-terminology/) where it has a term; Road in N, Deep tinuë, Non-Tak tinuë, Stack road, Defend
first and Placement only are our own.

## Data sources

- **PlayTak games DB** (`https://playtak.com/games_anon.db.gz`, 880k games, refreshed daily) — the
  single source; every other big set was mined from it too. Put it at `data/raw/games_anon.db`.
  No explicit data license; credit PlayTak and ask USTA before a public launch.
- **Ditaktic** (Nqeron's daily puzzles, ~1,050 hand-picked, with difficulty labels) — copyrighted; used
  locally (`data/puzzles-local/`, `node scripts/import.mjs data/puzzles-local`) and as calibration data
  for the prior. Ask Nqeron before publishing.

## Next steps (most compelling first)

1. **Calibrate the prior against human labels.** Fit `priorRating` weights to Ditaktic's
   Beginner→Impossible labels (ordinal regression) — the simulation says the prior dominates rating
   accuracy until each puzzle has dozens of plays.
2. **Concentrate plays.** Serve from a curated pool (Lichess "paths": rating buckets × quality tiers)
   so each puzzle accrues plays faster; promote puzzles out of the pool once their rating settles.
3. **Deeper puzzles.** The proof-number prover (`shared/pns.js`, `shared/deep.js`) mines 7+-ply tinues from
   PlayTak games (`pd*`). (Jaffray-Ben's 6×6 set is licensed for local use only: not a source.) The strongest option is **syntaks** (gruppler/Ciekce,
   MIT, Rust→WASM, already powering PTN Ninja's "Tinuë Solver", 0 mismatches vs Topaz on 2.5k positions);
   it also finds quiet tinues. Distrust Topaz-derived depth labels until re-proved.
4. **Ask the community for data.** Morten Lohne's unpublished tak-puzzle-finder `puzzles.db` (~30k vetted
   puzzles, Tiltak evals, avoidance follow-ups, gaelets) is shared among Tak devs — ask Morten or gruppler on
   the Tak Discord. Tiltak's 52 motif-labeled tactic tests make a good tagger/solver regression set.
5. **Mine everything.** Current counts: `scripts/data-stats.mjs`. The full DB (~700k road
   wins) would give ~600k; do it on a beefier box, or prefer games where both players are ≥ 1500.
   Re-mine nightly from the daily dump to pick up new games.
6. **Quality signals.** Up/down votes (Lichess `PuzzleTrust`-weighted; the old votes API was removed, and the server drops its table at startup when it is empty), auto-retire puzzles with
   pathological solve rates, flag 1-ply puzzles with many winning moves as "trivial".
7. **"Only move" / non-tinue puzzles.** Positions where exactly one move keeps a winning eval (needs an
   evaluation engine — Tiltak WASM), plus "tinuë avoidance" defense puzzles.
8. **Accounts.** Google sign-in on top of the current token accounts; rating-history graph exists.
9. **Deploy.** Done: the API runs on crux behind a Cloudflare Tunnel (`tinue-api.shydrie.xyz`), with Tailscale
   Funnel as a second path (see Deploying and Logs).

## License

GPL-3.0-or-later (`LICENSE`). Bundled: Tiltak (GPL-3.0, `public/tiltak/NOTICE`), Syntaks and the cnet023 net
(`public/syntaks/NOTICE.txt`), lz-string (MIT, `public/vendor/`).
