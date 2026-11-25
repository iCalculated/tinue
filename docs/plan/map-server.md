# tinue server map (main @ 3026736, read 2026-11-17)

Scope: `server/server.js` (771 lines), `server/syntaks.js` (210), `server/share.js` (207), `shared/rating.js`, `shared/glicko.js`, and the parts of `shared/` the server imports; plus the scripts that write the production DB (`scripts/import.mjs`, `rerate.mjs`, `reprior.mjs`, `deploy-crux.sh`) and the iOS client's API use (`~/Projects/TakMessages/Shared/TinueAPI.swift`).

Tags: **[CODE]** = read in the cited file. **[DOCS]** = quoted from a doc (named). **[INF]** = inference, reason given. **[DB]** = local `data/tinue.db`, read with `sqlite3 -readonly`. The local DB holds 71,112 puzzles but only 15 attempts. Play data lives on crux, and I did not touch crux.

Line-number warning: `docs/system-design.html` §5–§6 cite server.js lines from an older revision. For example, it puts POST /api/result at 586–621, but on 3026736 the route is at server.js:612–647. Its prose matches the current code, but its line numbers are about 26 lines short. Use the line numbers in this file.

---

## 0. Headline facts

1. **The server never judges a move.** [CODE] POST /api/result takes `win` as a client boolean (server.js:614–616) and rates it (:635–642). The server does not replay `log`. It checks only the shape of `log` (:112–124) and stores it. The file header says so too: "Puzzle solving (move validation, opponent replies, alt-solution checks) all happens in the browser" (server.js:2).
2. **The server runs no prover.** [CODE] server.js imports `rating.js`, `glicko.js`, `themes.js`, `tak.js` (`Game`) and `syntaks.js` (server.js:9–14). It does not import `pns.js`, `deep.js` or `analyze.js`. Its only engine is native Syntaks, reached through **GET /api/analyze** (review panel) and **GET /api/defend** (play-out replies) (:696, :701–702). **POST /api/slow runs no engine.** It writes a latency line to the access log (:679–686).
3. **Only the client decides whether a miss is rated.** [CODE] The server has two levers. `casual` (client-sent, :632) makes an attempt unrated. The stale-build guard makes a *miss* unrated when `?b=` is below `TINUE_MIN_BUILD` (:21, :631). `?b=` is a query parameter the client sets itself (`public/app.js:221` `withBuild`). It protects against honest old tabs, not against a hostile client.
4. **The attempt row cannot answer "why".** [CODE] `attempts` stores win/rated/ratings-before/delta/ts/ms/log (:45–50). It does not store the build, the theme weight, the reason a row is unrated, the defender's replies, the engine used, the tree version judged against, or any RD/vol before or after. Section 3.3 has the full list.
5. **Refunds are manual SQL on crux, outside the repo.** [DOCS] system-design §5.6: "scripts crux:~/tinue-alts/refund.mjs, refund2.mjs, refund3.mjs … there is no altset/ directory in the repo or on crux". The only refund logic in the repo is the **refund mark** (`REFUND_MARK`, import.mjs:151–153) and the picker/daily penalty for `flaw = 2` (server.js:226, 252–253, 280–285).
6. **iOS (Gaelet) reads only `/api/daily` and `/api/puzzle/:id`.** [CODE] It decodes `tree` as `"win"` or `{ptn: null | {r, n}}` (TinueAPI.swift:62–77), plus `id, tps, plies, themes`. It never posts a result. Any change to the tree format or these field names breaks shipped builds.

---

## 1. Routes

Dispatch: `http.createServer` (server.js:740–759). `/api` and `/api/*` go to `api()` (:751). GET/HEAD `/p/<id>` and `/p/<id>.png` go to `share()` (:752). Anything else is a static file (:753). OPTIONS returns 204 after CORS (:749). [CODE]

### 1.1 Cross-cutting [CODE]

- **Identity.** `userFrom` (:146–150) accepts `Authorization: Bearer <48 hex>` or the `tinue_token` cookie. The cookie counts only when `cookieOk` (:145) holds: no Origin, an allowed Origin, or Origin host = Host. The token's sha256 is looked up in `users.token_hash` (unique index, :95). There are no sessions and no expiry. The cookie's Max-Age is 315360000 s (10 years, :533, :540, :624).
- **CORS.** Only `TINUE_ORIGINS` gets CORS. The default list is `https://shydrie.xyz` plus localhost:8642 and localhost:8650 (:180–192). `access-control-max-age: 7200` is already set (:188).
- **Body.** JSON object of at most 100,000 bytes/chars, else 413 or 400 (:380–391).
- **Client address.** The **last** non-empty `x-forwarded-for` entry. IPv6 is keyed by /64 and IPv4-mapped addresses as IPv4 (:404–413). `cf-connecting-ip` is deliberately ignored (:400).
- **Rate limits.** Fixed windows in memory (:414–425). They reset on restart and are pruned every 10 minutes.
- **Errors.** Thrown errors with `.status` become JSON. Anything else becomes a 500 and is logged to stderr (:754–758). `unhandledRejection` and `uncaughtException` are logged, not fatal (:737–738).

### 1.2 Table [CODE]

| Route | Lines | Inputs | Limit | Trusts from client | Writes |
|---|---|---|---|---|---|
| GET /api/me | 517 | token | none | — | — |
| POST /api/register | 521–534 | `{name, guest:{gid}}` | 5/h per IP, successes only (:523, :531) | name (regex `^[A-Za-z0-9_-]{2,20}$`), gid | `users.name`, or a new users row via `newGuest` |
| POST /api/login | 536–541 | `{token}` | **none** | token | cookie only |
| POST /api/logout | 543 | — | none | — | clears cookie |
| GET /api/next | 545–573 | `rating` (anon only, clamped 0–3500), `size`, `theme`, `difficulty`, `exclude` (≤200 ids), `n` (≤20), `for=<id>` | **none** | anon rating, exclude list | — (SQLite read per call) |
| GET /api/daily | 579–582 | — | `look:` 120/min per IP (:578) | — | `daily` row on the first request of a Pacific day (:300) |
| GET /api/group, /api/users, /api/users/:name | 583–599 | `names` (≤20, ≤32 chars each) | same `look:` limit | — | `daily` row (group) |
| GET /api, /api/ | 601 | — | none | — | — (plain-text API doc, :310–331) |
| GET /api/puzzle/:id | 604–607 | id `[\w.-]+` | **none** | — | — |
| **POST /api/result** | 612–647 | body `{puzzleId, win, casual, theme, ms, log, guest:{gid}}`, query `b` | 60/min per user or IP (:613); new guest 10/h per IP (:621) | **win, casual, theme, b, ms, log** | `attempts`, `users`, `puzzles` (§1.3) |
| GET /api/history | 649–654 | token | none | — | — (last 200 attempts joined to puzzles) |
| GET /api/themes | 656–660 | `size` | none | — | — (`themeCounts`, cached for the process lifetime, :435–454) |
| POST /api/guest-result | 664–676 | `{gid, puzzleId, win, hinted, rating, rd, games, ms, log}` | 60/min and 1500/day per IP | everything; rates nothing | `guest_attempts` (INSERT OR IGNORE) |
| POST /api/slow | 679–686 | `{path, ms, outcome, hidden}` | 30/min per IP | everything (logged only) | access log line `SLOW-CLIENT` |
| GET /api/leaderboard | 688–692 | — | none | — | — |
| GET /api/analyze | 696 | `tps`, `komi` | `ana:` 120/min; 30 uncached/min; 2 in flight (per user, else per IP) | tps/komi (strictly validated) | Syntaks cache (memory) |
| GET /api/defend | 701–702 | `tps`, `komi` | `def:` 120/min; 40 uncached/min; 1 in flight; priority queue | same | same |
| GET /api/stats | 704–709 | — | none | — | — |
| GET/HEAD /p/:id, /p/:id.png | 358–375 | id | none | — | in-memory PNG LRU (500) |
| static | 338–353 | path | none | — | — (serves `public/` and `/shared/`; `/dev/` only when `TINUE_ORIGINS` is unset) |

Anything else under `/api` returns 404 `unknown route` (:711).

### 1.3 POST /api/result in detail [CODE, server.js:612–647]

Order of operations:
1. Rate limit `res:` + (`u<id>` or IP), 60/min (:613).
2. Parse the body (:614). If there is a token, re-read the user row "fresh" (:615).
3. Reject unless `puzzleId` is a string and `win` is a boolean (:616). 404 if the puzzle does not exist (:617–618).
4. **No user**: rate limit `guest:` IP 10/h, then `newGuest(guest?.gid)` (:620–623). This mints a token and a users row. If the gid has legacy `guest_attempts`, they are replayed into `attempts` with `replayGuest` (server.js:165–173; rating.js:43–53). The token comes back in the JSON and as a cookie (:624).
5. **First attempt only**: if `attempts` already has `(user_id, puzzle_id)`, return `{rated:false, userDelta:0}` and write nothing (:626–627). There is no UNIQUE constraint; only the non-unique index `attempts_user` exists (:51). In-process this cannot race, because everything after `await body(req)` up to COMMIT runs synchronously on one thread. [INF from Node's single-threaded execution; nothing between :615 and :643 awaits.]
6. **Stale-build guard**: `stale = MIN_MISS_BUILD > 0 && !win && !((+q.b||0) >= MIN_MISS_BUILD)` (:631). `MIN_MISS_BUILD = +process.env.TINUE_MIN_BUILD` (:21). deploy-crux.sh sets it to `1794817280` (deploy-crux.sh:34, :46). The comment there says that is 2026-11-16, when "an undecided move is played out against a defender instead of being charged".
7. `rated = casual !== true && !stale` (:632). **The client decides `casual`.** The current client sends `casual` for a hint, for "a miss whose check never answered", and for a Tiltak-defended win (public/app.js:683–686).
8. Theme weight: `theme` must be a key of `THEMES` (:633). `themeWeight` returns 0.1 for a win and 0.7 for a miss in a themed drill, else 1 (rating.js:15–19). A guest moves the puzzle at `w × 0.5` (:635; rating.js:25). **The theme is not checked against the puzzle's own themes**: any valid theme key sent with a result gets the reduced weight (:633). The `for=` pre-pick, by contrast, does check that the theme is among the puzzle's (:567). [CODE]
9. `rate()` is Glicko-2, one period per attempt. A player with RD ≥ 230 does not move the puzzle ("clueless", rating.js:7, 34).
10. One transaction (:637–644): INSERT into attempts `(user_id, puzzle_id, win, rated, user_rating, puzzle_rating, user_delta, ts=now(), ms=cleanMs, log=cleanLog)`. If rated, it also updates users `(rating, rd, vol, games+1, wins+win)` and puzzles `(rating, rd, vol, attempts+1, solves+win)`.
11. Reply: `{rated, user, userDelta, puzzleRating, token?}` (:646). The reply does **not** say why a result was unrated. The client guesses ("played before, or a miss from an out-of-date page (the server doesn't say which)", app.js:711).

What the server **checks**: the puzzle exists; the result is the first per user; the build stamp (misses only); the shape of `ms` (0–1 h) and `log` (1–64 entries; `k ∈ {ok, slow, miss, view, hint, po}`; move regex `^[1-8]?[SCF]?[a-h][1-8](?:[<>+-][1-8]*)?[*'!?]*$`). If any log entry is malformed, the whole log becomes NULL (:110–124).

What it **does not check**:
- whether `win` is consistent with `log`;
- whether any logged move is legal, in the tree, or a proven win;
- whether a play-out happened, who defended it, or how it ended;
- whether `casual` or `theme` is truthful;
- whether `ms` is plausible.

[CODE] The design page says the same: "The server never replays or validates the moves: win is taken from the client" [DOCS system-design §5.2] and "The server trusts the client's win (no move replay)" [DOCS §8.1].

Consequence [INF]: the client fully controls whether a result is a rated win, a rated miss, or unrated. A false rated miss can come only from client logic, or from an old build above MIN_BUILD. A hostile client can farm wins. The current defences against an old client are MIN_MISS_BUILD and the client-side `checkBuild` reload (app.js:216–242).

### 1.4 Guests and gid [CODE]

- `newGuest` (:156–177). A 32-hex `gid` from the client links a new users row to legacy `guest_attempts`. **If a nameless users row already has that gid, the row gets a new token and is handed to the caller** (:159–163). Its old token stops working, because `token_hash` is overwritten.
- [INF] Anyone who learns a nameless guest's gid can take over that guest's row. The gid is 128 random bits kept in localStorage (app.js:87–93), so the risk is low. It is worth keeping in mind if an outbox or log ever records gids.
- `POST /api/register` with an existing nameless user just sets `name` (:529). Nothing records when a guest became named. So at re-judge time you cannot tell whether a past attempt was a guest's (guest puzzle weight 0.5) or an account's. [INF from the schema: users has only `created_at`, :30.]

### 1.5 /api/next, briefly [CODE]

- Synchronous SQLite per call (:244–272). For a signed-in user it runs `NOT IN (SELECT puzzle_id FROM attempts WHERE user_id …)` (:249).
- Served pool: `turn = 1 OR grade = 'A'` (:236). Second stage: **everything else, including grade D** (:240–243, `only = null`). [CODE; DOCS system-design §5.4 notes the same: "no query excludes it".]
- `for=<id>` pre-picks both outcomes by calling `rate()` (:563–571).
- An in-memory picker is in flight elsewhere (per the task). It must keep REFUNDED, PLAYED, the tiers, PICK_WINDOW and the U² draw. The Z3 proof `scripts/verify-picker.py` does not model REFUNDED [DOCS §5.4].

---

## 2. Engines on the server

### 2.1 Which code runs an engine [CODE]

- `engineCall` (server.js:481–509) is the only caller of `syntaks.analyze`. It serves `/api/analyze` (`tag 'ana'`, `perMin 30`, `inflightMax 2`, output = the raw result) and `/api/defend` (`tag 'def'`, `perMin 40`, `inflightMax 1`, `priority true`, output = `{move, mate, winProb, side, depth, ms, cached?}`, and only if `legalIn`) (:696, :701–702).
- `/api/slow` (:679–686) and `/api/guest-result` run nothing.
- **No route runs df-pn, `pns.js`, `deep.js` or Tiltak.** The still-wins check, the proof-length measurement and the Tiltak defender all run in the browser (public/app.js:906–908 `engine.proofLength`; :941–948 Tiltak).

### 2.2 Input validation [CODE]

- `komi` must be a number in −3.5…3.5 in half steps, else 400 (:483–484).
- `tps6()` (:459–474): exactly 6×6; ≤ 600 chars; 3 fields; strict row regex; widths add up to 6; move-1 contents exact; then `Game.fromTPS`. A failure returns 400 `tps: a 6x6 position in TPS` (:486).
- A finished game returns 400 (:487). `!syntaks.available()` returns 503 `engine unavailable` (:488).
- `legalIn` (:480) passes on the engine's move only if tinue's rules accept it. If not, the server returns 503 `engine gave no legal move` and **evicts the cache entry** (:499).

### 2.3 Budgets, pool, queue, cache (server/syntaks.js) [CODE]

| Knob | Value | Line |
|---|---|---|
| Binary | `TINUE_SYNTAKS`, else `~/syntaks-opt/final/syntaks-final` if it exists | 12–14 |
| Pool | `POOL = 2` processes, each `Threads 1`, `Hash 64`, `MateScores true`, `HumanWDL true` | 16, 46 |
| Search | `go movetime 1200` | 16, 142 |
| Overrun | at MOVETIME+GRACE (3.7 s) send `stop` and mark `overran`; after another GRACE (2.5 s) `SIGKILL` | 17, 143–147 |
| Queue | normal ≤ `MAX_QUEUE = 12`; priority (defend) ≤ `MAX_PRIORITY = 4`, inserted ahead of normal jobs | 16, 161–165 |
| Dedup | `pending` map: identical `(tps, komi)` requests share one search; a queued review job a defend now waits on is promoted to priority | 159–171 |
| Cache | in-memory LRU, `CACHE_MAX = 2000`, key `tps|komi`; **lost on restart**; aborted or overrun searches are not cached | 16, 23, 85, 110–113 |
| Abort | client disconnect → `ac.abort()` (server.js:495); the job is dropped if queued with no waiters, else `stop` | 177–196 |
| Idle | processes exit after 15 min idle | 18, 115–126 |
| Priority | `os.setPriority(pid, 10)` (nice 10) | 28 |
| Komi change | `setoption HalfKomi` + `teinewgame 6` (clears the hash) | 141 |
| Result | from the last exact `info` line (else the last bounded one); scores flipped to White's view; `winProb` = (W + D/2)/1000, or 0/1 on mate | 82–108 |

Failure modes as the client sees them [CODE]:
- Engine missing: 503 `engine unavailable` (server.js:488; syntaks.js:156).
- Queue full: 503 `engine busy` (syntaks.js:162).
- Process died or was killed: the job is rejected with `syntaks exited …`, and engineCall returns 503 `engine failed` and logs to stderr (server.js:503–504; syntaks.js:35–43).
- Client gone: status 499, nothing written (server.js:502).
- Per-key limits: 429 (:491–492). The in-flight check comes before the limits, so a refused call does not use them up.

What the client does then [CODE, public/app.js:913–950]:
- For a play-out it tries the in-browser Syntaks WASM first, if loaded and fast enough.
- Otherwise it calls `/api/defend` with an 8 s timeout. If that fails it waits up to 20 s for WASM. If that fails, **Tiltak in the browser** defends, and the game becomes unrated (`gameRated`, public/playon.js:60).
- `/api/analyze` has a 6 s client timeout (app.js:380).

[INF] Today "Syntaks" in a rated play-out means **either** native Syntaks on crux **or** Syntaks WASM in the browser (`po.engine === 'syntaks'` covers both, app.js:917–937, playon.js:35, 60). It is not "native Syntaks on the server" as the task's rule summary says.

Measured [DOCS system-design §7]: `/api/defend` server p50 1,204 ms. `/api/analyze` p50 205 ms (mostly cache hits), max 1,835 ms. "~2.6M nodes" per reply is an estimate, not measured in production. In the access log covered by the design page, all 26 × 429 were on /api/analyze.

---

## 3. Database

### 3.1 Schema (as created by server.js:27–68 plus migrations :70–108; the local DB `.schema` agrees, with columns added by ALTER at the end) [CODE][DB]

**users** (:27–31, rebuilt by the guests-as-users migration :85–94)
`id INTEGER PK, name TEXT UNIQUE COLLATE NOCASE (NULL = guest), token_hash TEXT NOT NULL, gid TEXT UNIQUE, rating REAL (1500), rd REAL (500), vol REAL (0.06), games INTEGER, wins INTEGER, created_at INTEGER`
Index: `users_token` UNIQUE(token_hash) (:95).

**puzzles** (:35–43; rd/vol added by migration :72–82; turn/swing/flaw/grade by :97–102)
`id TEXT PK, size, tps, plies, tree TEXT(JSON), themes TEXT (csv), source, source_ref, init_rating, rating, rd (250), vol (0.09), attempts, solves, komi, meta TEXT(JSON), turn INTEGER (1/0/NULL), swing TEXT(JSON), flaw INTEGER (NULL/1/2), grade TEXT (A–D)`
Index: `puzzles_rating` (rating) (:44). There is none on size, turn, grade or themes.

**attempts** (:45–50; ms/log by migration :105–108)
`user_id INTEGER NOT NULL, puzzle_id TEXT NOT NULL, win INTEGER, rated INTEGER, user_rating REAL (before), puzzle_rating REAL (before), user_delta REAL, ts INTEGER (server receive time, ms), ms INTEGER (client-reported), log TEXT (JSON)`
Index: `attempts_user` (user_id, puzzle_id), **not unique** (:51). No PK; the implicit rowid is what refunds refer to (DOCS alt-wins.md Refunds).

**guest_attempts** (:54–58): `gid, puzzle_id, win, hinted, guest_rating, guest_rd, guest_games, puzzle_rating, ms, log, ts`, PK (gid, puzzle_id). Legacy and never rated.

**daily** (:60–62): `day TEXT PK, puzzle_id TEXT NOT NULL UNIQUE, ts`.

**votes** (:64–67): `user_id, puzzle_id, vote, ts`, PK (user_id, puzzle_id). No API; 0 rows on crux [DOCS §1.3] and locally [DB].

PRAGMA: `journal_mode = WAL` (:33). There is no explicit checkpoint, and `journal_size_limit` is not set. [CODE; DOCS §6.2 "Whether the ~97 MB WAL is ever checkpointed" is unverified.]

### 3.2 Who writes which column [CODE]

| Table.column | Writer |
|---|---|
| users.* (insert) | `newGuest` server.js:170–171 (from /api/result :622 or /api/register :530) |
| users.token_hash | :161 (gid re-issue), :170 |
| users.name | :529 (register) |
| users.rating, rd, vol, games, wins | /api/result :641; refund scripts on crux (rating, games only) [DOCS alt-wins.md] |
| puzzles.* except the play stats | `scripts/import.mjs` upsert :108–112 (overwrites size, tps, plies, **tree**, themes, source, source_ref, **init_rating**, komi, meta; `rating` only when `attempts = 0`) |
| puzzles.turn, swing, flaw | import.mjs:100–102, 127, 134 (flaw = 1 when swing has alts/altsAt, else NULL) |
| puzzles.flaw = 2 | import.mjs:151–153 `REFUND_MARK` (and by hand after a refund) |
| puzzles.grade | import.mjs:128 (export field), :136 (grades file: NULL all, then set), :143 (overrides) |
| puzzles.rating, rd, vol, attempts, solves | /api/result :642; `rerate.mjs --apply` writes **rating only** (rerate.mjs:100–101); hand resets after a refund [DOCS §5.6] |
| attempts.* | /api/result :639–640; `newGuest` replay :172–173; refund scripts set rated = 0 [DOCS] |
| guest_attempts | /api/guest-result :672–674 |
| daily | `dailyPuzzle` :300 (`INSERT OR IGNORE`) |

Every deploy runs `import.mjs` on crux against crux's own DB (deploy-crux.sh:36). So `tree`, `init_rating`, `turn/swing/flaw` and `grade` on crux are **overwritten in place** from lyra's export on every deploy, with no version kept. [CODE] (Splitting deploy from publish is in flight elsewhere, per the task.)

### 3.3 How an attempt is recorded, and what can't be rebuilt [CODE unless marked]

Recorded per attempt: who, which puzzle, win, rated, user rating before, puzzle rating before, user delta, server ts, client ms, client log.

The `log` is the **solver's** events only. `logMove` pushes `{m, ms, k}` for `ok`, `miss`, `slow`, `po` and `{ms, k}` for `view`, `hint`. There are at most 64 per attempt, and only until the result is sent (app.js:524; callers :627, :653, :831, :993, :1095, :1169, :1214).

Not recoverable afterwards:

- **Defender replies.**
  - In the tree they can be re-derived from the tree, but only if the tree has not changed (see the tree item below).
  - **In a play-out they are not logged at all.** Only the player's `po` moves are logged (app.js:993); the engine's replies (crux, WASM or Tiltak) are not. So the game cannot be replayed. [INF: `po` moves without replies don't fix the positions, though a replay against today's Syntaks might reproduce them; a deterministic move at fixed movetime is not guaranteed.]
- **Which engine defended, and how the play-out ended.** `win`, `resign`, `proved`, `road`, `held`, `out`, `gaveup`, `left`, `unload` and `noengine` all exist in the client (playon.js:40; app.js:1025–1061), but none of them is sent.
- **Why the attempt is unrated.** Hint, stale build, unchecked miss, Tiltak win, stall, or refund are indistinguishable except for two signatures. A refund leaves `rated = 0, win = 0, user_delta ≠ 0` [DOCS alt-wins.md Refunds]. A page-accident refund sets `user_delta = 0` and so looks like any other unrated row. [DOCS §8.4: "How many misses were unrated by the stale-build guard rather than by hints (attempt rows record no reason)".]
- **Build.** `?b=` is used for the guard but not stored. It survives only in the access log's request path (`/api/result?b=…`, logged up to 200 chars, :744) next to `u<id>` and a timestamp, for as long as the log keeps it (§5).
- **Theme drilled** (weight 0.1 or 0.7) and **guest-at-the-time** (puzzle weight 0.5). Neither is stored, so the exact rating update cannot be recomputed from the row.
- **RD and volatility before and after**, for both user and puzzle. Not stored. So refunds cannot revert RD/vol [DOCS alt-wins.md: "The user's rd/vol aren't reverted … Neither is stored per attempt"], and a later rating can't be replayed exactly. [INF: a full replay from PLAYER_START/PUZZLE_START in ts order is possible, but it would not reproduce the live numbers, because of the stored-vs-live differences above.]
- **The tree, alts and altsAt the attempt was judged against.** `puzzles.tree` and `swing` are overwritten on import (import.mjs:110–111, 134), and no version id is stored on the attempt. The client also judged against the copy it fetched, possibly days earlier in an open tab.
- **Client-side verdicts.** The still-wins result, proof length, check timeout and "unchecked" are only reflected in `k` (`slow` = proven off-tree, `miss`). The proof itself is not kept.
- **When the move was made.** `ts` is when the server got the result. A held result resent on reload can land much later (app.js:40–48 held record). `ms` is client-reported.
- **Puzzle-side effect.** The puzzle's delta is not stored; only the rating before is.

---

## 4. Refunds, regrades, down-prioritising, rerating

### 4.1 Refund [DOCS alt-wins.md "Refunds"; system-design §5.6]

**Manual.** The scripts live on crux in `~/tinue-alts/refund{,2,3}.mjs`, not in the repo. Per the docs they do the following:
1. `attempts.rated = 0`.
2. `users.rating -= user_delta`.
3. `users.games -= 1` (alt-wins.md also implies wins are unchanged for a miss).
4. User RD/vol are **not** reverted.
5. They **do not touch puzzles**: rating, attempts and solves stay. "Returning a puzzle to its prior with RD 250 appears only as a proposal … applied by hand to only 6 of the 17" [DOCS §5.6].

On crux: 34 refunded attempts on 29 puzzles; "the other 14 come from batches not attributed to a file" [DOCS §5.6].

Data a refund needs today: the attempt's rowid (or user_id + puzzle_id), its `user_delta`, and the user's current row. Data it would need to be exact but **does not have**: user and puzzle RD/vol before, the puzzle delta, and all later attempts on that user and puzzle replayed. [INF from 3.3]

### 4.2 Refund mark, i.e. down-prioritising [CODE]

- `REFUND_MARK` (import.mjs:151–153): `UPDATE puzzles SET flaw = 2 WHERE flaw IS NULL AND id IN (SELECT puzzle_id FROM attempts WHERE rated = 0 AND win = 0 AND user_delta IS NOT NULL AND user_delta <> 0)`.
- It runs at the end of every import, because import rewrites `flaw` from `swing` (:100–102, :134). It is also meant to be run by hand right after a refund.
- It **only applies where flaw is NULL**, so a refunded puzzle with stored alts stays at flaw 1. The mark clears only when alts appear. A fix that only adds a tree key does not clear it [DOCS alt-wins.md].
- Picker: `REFUNDED = 400` instead of FLAW, and no PLAYED pull (server.js:226, 252–253, 261).
- Daily: tiers 2–4 exclude flaw 2; tiers 5–7 do not (:280–289).
- [INF] A refund mark is derived **only** from the signature of an attempt row. Any process that rewrites attempts (re-judging, a log migration) must preserve or replace that signature, or puzzles silently lose their mark on the next import.

### 4.3 Regrade [CODE]

- Grades come from `data/grade/grades.jsonl` (default if present) or `--grades`. With a grades file, import sets every grade to NULL and reapplies (import.mjs:136). Otherwise it takes the export's `grade` field (:128). `scripts/grade-overrides.jsonl` (tracked, rsynced to crux) is applied last (:138–144). A bad override aborts the import (:36–50).
- A regrade has **no effect on past attempts or ratings**. A→D removes the puzzle from SERVED (:236), but stage 2 of the picker can still serve it (:240–243). Example: pd575074 [DOCS alt-wins.md: "prod got a one-row update after a .backup"].

### 4.4 Rerate, scripts/rerate.mjs [CODE]

- `import { db } from '../server/server.js'` (:13). Importing it runs server.js's schema creation and migrations, but not `listen` (server.js:767).
- Joint MAP fit of puzzle and user ratings on the **Elo/logistic curve**, not Glicko. It uses `attempts WHERE rated = 1` (win only), Normal priors (puzzle ~ feature prior `meta.factors`, σ 250; user ~ 1500, σ 350), and 300 coordinate-Newton iterations, then a ridge refit of the prior weights if ≥ 50 puzzles have ≥ 5 plays (:20–92).
- `--apply` writes **only `puzzles.rating`**. It does not touch rd, vol or users (:98–104).
- [INF] It predates Glicko (the header says "online Elo", :7). Applying it now would leave Glicko RDs inconsistent with the new ratings. It ignores theme and guest weights and treats refunded rows (rated = 0) as absent, which is the right thing for refunds.

### 4.5 Reprior, scripts/reprior.mjs [CODE]

- Offline only. It rewrites a puzzles **JSONL** file's `rating` (= prior) as the sum of `meta.factors`, clamped to `PRIOR_MIN`/`PRIOR_MAX` (shared/analyze.js) (:9–17).
- It touches no DB. Its effect reaches the DB only through import, which updates `init_rating` always and `rating` only when `attempts = 0` (import.mjs:112).
- [INF] Refunds never decrement `puzzles.attempts` [DOCS §5.6], so a puzzle whose only plays were refunded keeps `attempts > 0`, and a reprior never resets its rating.

---

## 5. Access log [CODE, server.js:714–745]

- **File:** `TINUE_ACCESS_LOG` or `data/access.log`. When over 5e6 bytes it is renamed to `.1`, checked on every line (:731). **Only one generation is kept**: the next rotation overwrites `.1`. [CODE] [INF: at ~1 MB per 8 days (DOCS §6.2) that is roughly 40 days per file, so around 80 days of history at most.]
- **Line per request** (on `finish`, :742–745): `ISO-time METHOD url[≤200 chars, includes the query string] status server-ms tag[ u<userId>]`.
  - Example [local log]: `2026-11-16T21:03:46.614Z GET /tiltak/tiltak_wasm.js 200 54.1ms 5e43a4e8`.
- **Extra line** from `/api/slow`: `ISO SLOW-CLIENT <path≤120, no whitespace> <ms>ms ok|retried|failed <tag>[ hidden]` (:684).
- **Privacy scheme:**
  - `tag = HMAC-SHA256(LOG_SECRET, 'YYYY-MM-DD(UTC) ' + ipKey).hex[0:8]` (:728).
  - The key is 32 random bytes in `data/log-secret`, mode 600, created on first start. If unwritable, it is per-process (:721–727).
  - Per the code comment, the tag "can't be reversed to an IP … or followed across days" (:718–720).
- [INF] Caveats on that claim:
  - (a) `u<id>` is logged in clear, so a signed-in user's requests (and their daily tags) **are** linkable across days. Only anonymous traffic is unlinkable.
  - (b) The query string is logged. `/api/analyze` and `/api/defend` log full TPS positions, and `/api/result?b=` logs the build.
  - (c) No request bodies are logged. Results, moves and names never reach the log. Tokens are never in URLs (Bearer or cookie only), so none leak into it.
- `?b=` in the log is today the **only** record of which build sent a result. [CODE: app.js:221, :698]

---

## 6. Daily puzzle and /api/puzzle/:id (iOS)

### 6.1 Daily [CODE, server.js:278–304]

- **Day:** `pacificDay` = `Intl` en-CA date in America/Los_Angeles (:290). The **first request of the day writes** the `daily` row (:300), so any GET of /api/daily or /api/group can create it.
- **Band:** 6×6, rating 2000–2400 (:278–279).
- **Tiers** (first non-empty wins, `ORDER BY random()`, excluding puzzles already used as daily) (:281–289):
  1. turn = 1, flaw NULL/0, in band, unplayed by any **named** user;
  2. turn = 1, not flaw 2, in band, unplayed;
  3. turn = 1, not flaw 2, in band;
  4. turn not NULL, not flaw 2, in band;
  5. 6×6 with rating ≥ 2000;
  6. any 6×6;
  7. anything.
- [INF] Tier 1's "no flaw" also means no alts, i.e. a single winning first move under the stored lists.
- `/api/daily` returns `{day, puzzle: botPuzzle}` with `botPuzzle = {id, url, size, komi, rating, turn, toMove, tps}` (:307, :579–582). There is no tree in it.

### 6.2 /api/puzzle/:id [CODE, server.js:604–607]

- No rate limit, no auth. Returns `{puzzle: publicPuzzle(p)}`, or 404 `{puzzle: null}`.
- `publicPuzzle` (:194–200) = `{id, size, tps, plies, tree (parsed JSON), themes [], source, sourceRef, rating, rd, attempts, solves, komi, meta (parsed), turn, pre0, alts?, altsAt?}`. `alts` and `altsAt` are included only when non-empty (:204–207).
- `/api/next` returns the same shape (:558, :569–572).

### 6.3 iOS app (Gaelet) [CODE, ~/Projects/TakMessages/Shared/TinueAPI.swift]

- **Base URL:** `https://tinue-api.shydrie.xyz` (:9). Builds up to 14 still call the Funnel host `crux.tail5ed24.ts.net:8443` (:7–8 comment).
- **Calls:** `GET api/daily`, then `GET api/puzzle/<daily.puzzle.id>` (:12–16), with a 15 s timeout. Non-2xx throws.
- **Decodes:**
  - from daily: `day`, `puzzle.{id, url, size, komi, rating, tps}` (:28–32);
  - from puzzle: `{id, tps, plies, tree, themes}` (:33–35).
  - `tree` is `"win"` or `{ptn: null | {r: String, n: tree?}}` (:62–77).
- **Judges locally** (TAK/PuzzleView.swift:152–161): any move that ends the game in the solver's favour counts; otherwise the move must be a key of the current tree node. Misses are only counted on screen. **It never posts a result**, so it is not rated and never uses `alts`/`altsAt`.
- **Compatibility constraints** for any redesign [INF from the decoding above]:
  1. /api/daily must keep `day` and `puzzle.{id, url, size, komi, rating, tps}` with these types (komi as a number, rating as an Int).
  2. /api/puzzle/:id must keep `id`, `tps`, `plies`, `themes` and a `tree` in exactly this recursive shape. Extra fields are ignored by `JSONDecoder`.
  3. A "book" that replaces `tree` must still emit `tree` for these two routes, or iOS must ship first and old builds stay broken.
  4. Old web tabs also read `tree`, `alts`, `altsAt`, `pre0` and `turn` from /api/next and /api/puzzle (app.js; publicPuzzle).

---

## 7. What would have to exist for "book or judge: miss or play" on the server

Today's path for an off-tree move (client): tree keys → `alts`/`altsAt` → cache → quick still-wins check (df-pn in a worker) → slow solve → play-on (Syntaks WASM, else crux /api/defend, else Tiltak) → held result (7×7/8×8) → miss. [DOCS CLEANUP table; CODE app.js:520–1100, playon.js]

For the server to decide every off-tree move itself, these pieces are missing [INF from §1–§3 unless marked]:

1. **A move-by-move protocol** instead of one `win` boolean at the end.
   - Either the client posts each solver move and the server answers with reply, `solved`, `miss` or `play`, or the client posts the full line and the server re-judges it.
   - Either way the server must hold or reconstruct per-attempt state: puzzle id, the **version** of tree/book used, the position, and the moves so far.
   - Today there is no attempt id until the result, and no server-side session.
2. **A book on the server** of proven wins at every attacker node the server will accept (CLEANUP: "book rows: position after the move, win_len" [DOCS MINING]).
   - The judge needs it keyed by position (TPS or Zobrist), not by move path, because transpositions exist. [INF]
   - It needs a lookup structure in the DB or in memory. Today the only per-puzzle store is the `tree`/`swing` JSON blobs on `puzzles`, and they are overwritten on import.
   - Rows need a version or hash so an attempt can name what it was judged against.
3. **A prover on the server**, or a clear rule that "not in the book" means "play".
   - Today the server runs no prover (§2.1).
   - Judging off-book moves needs either the `deep` crate (native, in flight) behind a bounded queue like syntaks.js (pool, MAX_QUEUE, abort-on-disconnect, cache), or a policy of no proving at play time: book hit = solved/continue, book miss = play-out.
   - It must not be df-pn in Node on the request thread: the server is single-threaded synchronous SQLite, and a 1–3 s proof would block every other request. [INF from server.js being one process with DatabaseSync]
4. **A server-side play-out.**
   - The defender's replies must come from the server and be recorded: native Syntaks via a `/api/defend`-like route, but bound to the attempt, so the server knows the game happened and what was played.
   - Today `/api/defend` is stateless: it answers any 6×6 TPS (:701), and the server cannot tell a defend call from an attempt.
   - The ending (solved / not solved) must be decided by the server from its own game state (`Game.result()`), not reported.
   - The cap (`capMoves`, `provenCap`, playon.js:8–30) must move to the server, or into shared code it runs.
5. **Engine availability policy.** When Syntaks is busy or down (503 today), the server must decide the result. **[Needs Sasha's yes; visible]** Options: unrated, held and retried, or fall back to the browser WASM. Today the client falls back to WASM and then Tiltak (unrated).
   - The 7×7/8×8 rule ("none") must also be explicit. **[Needs Sasha's yes if it changes]** Today those sizes have no play-out and hold up to 60 s [DOCS §8.1].
6. **Rated-result rules preserved** (Sasha's decisions):
   - any proven forced win is a solve;
   - an unproven off-tree move gets a still-wins check, then a play-out against Syntaks (6×6, |komi| ≤ 3.5);
   - rated miss when Syntaks defended;
   - no rated Tiltak play-out;
   - first result counts; guests at half weight.
   - The server judge must reproduce each of these. Any change to the cap, to stall/unload exemptions (playon.js:59–101) or to the still-wins budget is *visible*.
7. **Old clients.** Builds that send `win` with no per-move protocol keep working until they reload.
   - Either `/api/result` keeps accepting them (under MIN_MISS_BUILD rules) or it refuses them. Refusing a miss is safe. Refusing a win is *visible*.
   - [INF] "With the server judging, an old client cannot produce a wrong rated result" [DOCS CLEANUP part 3] holds only once `/api/result` stops rating client-asserted results. Until then MIN_MISS_BUILD stays the guard.
8. **iOS untouched.** It doesn't post results, so it is unaffected as long as §6.3's fields stay.
9. **Refund path.** With a server judge and a full log, a "false rated miss" becomes detectable automatically: re-judge with a newer book or prover and flip the result. That needs the log in §8 and a scripted, in-repo refund that also handles the puzzle side (today's scripts don't).

## 8. What a server-side attempt log must record so any past result can be re-judged

Minimum per attempt [INF: each item fills a gap in §3.3]:

1. **Identity:** a stable `attempt_id`; `user_id`; whether the user was a guest at the time (`name IS NULL` then); the token or session that sent it is not needed.
2. **Puzzle version:** puzzle id plus a hash of what was served (tree/book rows, `alts`/`altsAt` or their successor, komi, tps). A book table needs per-row versioning or an immutable content hash, so an import cannot change the past.
3. **Client:** build stamp (`b`), and platform (web vs other) if more clients ever post.
4. **Full line:** every ply in order, **including defender replies**, each tagged with
   - source: `tree` / `book` / `engine:<name>@<version or hash>` / `player`;
   - the judge's verdict at that ply: `book-hit`, `proven(len, nodes, prover version)`, `refuted`, `undecided→play`, `play-out move n of cap`;
   - server ms.
5. **Ending:** solved / not solved, plus the detailed reason today's client keeps to itself (`win`, `proved`, `road`, `held`, `out`, `gaveup`, `left`, `unload`, `stalled`, `noengine`, `view`/solution, `hint`). Also the cap in force and the proof length if known.
6. **Rating inputs and outputs:**
   - rated or not and **why** (hint, stale build, engine unavailable, unload, refund…);
   - theme key and weight;
   - guest weight;
   - user and puzzle `{rating, rd, vol}` **before and after**.
   - With this, a refund or a re-judge can reverse exactly, and `rerate`-style replays are reproducible.
7. **Timestamps:** server time of each ply, or of start and end, separate from client-reported `ms`.
8. **Refund/re-judge history** as **separate rows** (`attempt_id`, when, old verdict → new, delta applied, by whom or what script), not by mutating `rated`/`user_delta` in place.
   - Today the refund mark *depends* on that in-place signature (import.mjs:151–153). A log that changes it must give `REFUND_MARK` an equivalent source, e.g. "has an unresolved refund event".
9. **Engine nondeterminism:** a play-out can only be re-judged if the defender's moves are stored. A re-run of Syntaks at `movetime 1200` is not guaranteed to reproduce them (time-based search, pool load). [INF]

Privacy note [INF]: this log ties moves to `user_id`, the same identity the access log already records in clear. It does not need IPs, gids or tokens. The access-log HMAC scheme can stay as it is.

---

## 9. Contradictions and corrections to the three documents (and the task text)

| Claim | Source | What the code says |
|---|---|---|
| "/api/slow … runs a prover or native Syntaks" (implied by the task's grouping) | task text | /api/slow only writes a `SLOW-CLIENT` access-log line (server.js:679–686). The engine routes are **/api/analyze and /api/defend** (:696, :701). |
| "Engines in a rated result: df-pn, Syntaks native, Syntaks WASM, Tiltak" | CLEANUP table | A Tiltak-defended game is **unrated both ways** (playon.js:55–60, :63, :91; app.js:684–686). Tiltak can appear in an *unrated* result only. df-pn and both Syntaks builds can affect a rated one. All of this happens in the browser; the server just receives `win`. |
| "Syntaks native (df-pn off 6×6)" as the target engine | CLEANUP table | Today the rated 6×6 defender is often **WASM in the browser**, tried first when loaded (app.js:930–937). Moving to native-only is *visible* (latency, crux load) and needs Sasha's yes. |
| "native Syntaks on the server for 6×6" (rule summary) | task text | Same point: `po.engine === 'syntaks'` covers browser WASM and crux (/api/defend). |
| "Send `Access-Control-Max-Age: 7200`" | CLEANUP §2 | Already sent (server.js:188). |
| "Avoid tokens in query strings" | CLEANUP §2 | No token travels in a URL today (Bearer header or cookie, server.js:147). The URLs do carry TPS and `b`, which the access log records. |
| "Pages plus Funnel" (keep as is) | CLEANUP "Keep as is" | The primary API path is now **Cloudflare Tunnel** `tinue-api.shydrie.xyz`; Funnel is kept as legacy (deploy-crux.sh:2–4, :68–69; commit 0db73bd). iOS uses the Cloudflare host. |
| "the access log's privacy scheme" (keep) | CLEANUP | Fine for IPs, but `u<id>` is in clear and query strings (TPS, build) are logged (server.js:744). Cross-day linkage holds only for anonymous traffic. |
| "written from `tinue-design.html`" | CLEANUP intro | The file is `docs/system-design.html` (untracked). Its line numbers for server.js are stale by about 26 lines against 3026736. |
| "Delete … `/api/guest-result`, legacy guest replay" | CLEANUP §1 | `replayGuest` runs inside `newGuest` for any new user with a legacy gid (server.js:165–173). Removing `/api/guest-result` alone leaves the replay; the `guest_attempts` table is read by it and by `scripts/guest-watch.mjs` and `players-live`. |
| "A unique index on (user_id, puzzle_id)" | CLEANUP §1 | Correct that none exists (only non-unique `attempts_user`, :51). Note that first-attempt uniqueness is in code (:626) and does not race in-process. Before adding the index, check crux for duplicates (e.g. from `newGuest` replays). |
| "Rate limits on /api/next and /api/login" | CLEANUP §1 | Correct: neither has one (:536–573). /api/puzzle/:id, /api/history, /api/stats and /api/themes have none either. |
| "crux owns puzzles, book and attempts" | CLEANUP §3 | Today crux owns attempts and users. **Puzzles are owned by lyra's DB** and pushed by export + import on every deploy, which overwrites tree, init_rating, flaw and grade (deploy-crux.sh:13–21, :36; import.mjs:108–153). |
| "With the server judging, an old client cannot produce a wrong rated result" | CLEANUP §3 | True only after `/api/result` stops rating client-asserted `win`. Today it does rate it, and old clients are held back only by `TINUE_MIN_BUILD` (server.js:631) plus `checkBuild` (app.js:216–242). |
| "One verifier … owns … `status`"; unserved rows marked `reserve` | CLEANUP §4 | No `status` or `kind` column exists. The served pool is computed as `turn = 1 OR grade = 'A'` (server.js:236). The fallback stage serves *all* other rows, grade D included (:240–243). A `reserve` status would also need the picker's stage 2 changed, which is *visible*: 7×7/8×8 filters are served only through stage 2 today [DOCS §1.3 footnote]. |
| Daily puzzle "cut its seven tiers to three" | CLEANUP "Keep as is" | The tiers are at server.js:281–289. Tiers 5–7 are what guarantee a daily exists. Cutting them can leave a day with no puzzle (404, which iOS treats as an error). |
| "C++ `deep` solver" | CLEANUP §5 | The task says `deep/` is a Rust crate (in flight). The repo's `shared/deep.js` is the JS deep miner. Nothing native runs on the server except Syntaks. |
| `/api/next` "p50 60 ms and p99 2 s" | CLEANUP §2 | The design page's measured 11-15 slow spell is "65 requests ≥ 1 s (p90 617.8 ms); on 11-16 none (max 237.4 ms)" [DOCS §7]. The p99 of 2 s is not supported for 11-16. |
| Refunds "exist" as a process | task text | Refund scripts exist only on crux (`~/tinue-alts/refund*.mjs`) [DOCS §5.6], and 14 of the 34 refunds are not attributed to any script. They don't touch puzzles and don't revert RD/vol. |
