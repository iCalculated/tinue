# tinue implementation plan: book, judge, log

*Reconstructed draft (evidence-first). This is the plan CLEANUP.md refers to, rebuilt from the three briefs, the design page and the code at main 3026736. Main is now at 6e79c6c, which changes only the Funnel redirect: `server/server.js` lines after ~136 sit 21 lines lower there, so all `server.js` lines below are cited at 3026736.*

## 0 · How to read this

**Tags.** Every statement carries one of these:

- **[DOCS]**: quoted from CLEANUP, MINING, SOLVER, or `docs/system-design.html` (written SD §x).
- **[CODE path:line]**: read in the repo at 3026736.
- **[DATA]**: a read-only query on lyra's `data/tinue.db` (71,112 puzzles, 15 attempts). This is **not** crux. My own counts come from `plan/.ev/nodes.mjs`; the rest are from `plan/map-state.md`.
- **[INF]**: an inference, with its reason.
- **[PLAN]**: a prescription of this draft. Where it reconstructs what the briefs' author most likely wrote, it names the fragment it rests on. Where the briefs are silent it says **silent**, gives the two likeliest readings, and recommends one.

**What the briefs fix about the plan** [DOCS]:

- It "covers the three redesigns (book, judge, log)" (CLEANUP, "How to use this").
- "The plan's part 2 lists the deletions" (CLEANUP §6).
- There is "One verifier, as in the plan. It owns keys, cooks, faster wins and `status`" (CLEANUP §4).
- Parts 4 to 6 of CLEANUP "land with the plan" (CLEANUP, "Order").

The numbering below therefore puts the design in part 1 and the deletions in part 2.

- **Silent:** whether "part 2" means a deletions section, or the judge part (if the plan numbered book, judge and log as parts 1 to 3, the judge part would list most client deletions).
- **This draft:** part 1 holds all three designs, so part 2 can be the deletion list that CLEANUP §6 points to by number.

**Rule carried over from CLEANUP** [DOCS]: "A change must leave what a player sees the same or better. Anything visible is marked *visible* and needs Sasha's yes unless already decided." **Method**: "One small commit per item, `npm test` green, line delta in the message." Both apply to every step in part 3.

### The plan in one table

The rows and "after" values are CLEANUP's [DOCS]. The "today, checked" column corrects them against the code.

| Area | Today, checked | After [DOCS CLEANUP] |
|---|---|---|
| Puzzle state | `turn`, `grade`, `flaw`, `swing` (`alts`, `altsAt`, `pre0`, 5 unused keys), 5 live sidecars of 12, `grades.jsonl` + `grade-overrides.jsonl` [CODE import.mjs:94-144; DATA] | `kind`, `grade`, `status`, `book` |
| Paths for an off-tree 6×6 move | tree, `alts`/`altsAt`, `S.proven` cache, quick check (df-pn worker), proven play-out or `slowSolve`, play-on (Syntaks WASM → crux → WASM-wait → Tiltak), held, miss [CODE app.js:579-651, 914-970] | "book or judge: miss or play" |
| Play-out endings | 10 kinds, 9 reachable (`resign` is dead: `RESIGN_UNPROVEN = false`) [CODE playon.js:85-86; app.js:1025-1061]. The briefs' "9" is the design page's count | "2: solved or not" |
| Engines in a rated result | df-pn (browser), Syntaks WASM (browser, tried first), Syntaks native (crux). Tiltak defends only **unrated** games [CODE app.js:930-937; playon.js:60, 68-69] | "Syntaks native (df-pn off 6×6)" |
| Who decides a rated result | the browser. The server trusts `win` and `casual`, and only unrates misses from builds below `TINUE_MIN_BUILD` [CODE server.js:631-632] | the server: "With the server judging, an old client cannot produce a wrong rated result" [DOCS CLEANUP §3] |
| Result transport | one POST with a 20 s timeout and no retry, plus `heldRec` + Web Lock + `pagehide` keepalive + `flushHeld` [CODE api.js:53; app.js:41-80, 767-807] | "One outbox replaces held records, the Web Lock and `pagehide` sends" [DOCS CLEANUP §6] |
| Offline stages | 3 miners, scoring v1–v3, syn6, alt-wins, 7 grade steps, ≥ 5 import runs [DATA map-state §2.2] | mine → verify → grade → import |

### Work in flight that this plan builds on, not redoes

All [PLAN]:

- **`deep/` Rust crate** implementing SOLVER, with `deep cert` emitting book rows. In this plan it is the 6×6 half of the verifier. The plan only fixes the row format the crate must emit (§1.1).
- **In-memory picker** for `/api/next`. This plan changes only its inputs: `status` instead of the `SERVED` predicate, and two derived penalty fields instead of `flaw` (§1.4).
- **Deploy split** into `deploy` (code) and `publish-puzzles` (content). Book rows ride on `publish-puzzles` (§1.1, §1.5).
- **Removal of `/api/guest-result` and `votes`.** Nothing here depends on them. The log (§1.3) must not reintroduce a gid-keyed table.

---

## 1 · Design

### 1.1 Book

**What it is.**

- [DOCS MINING, "Changes you need to make to `deep cert`", item 5]: "Emit tinue's tree format and `book` rows: position after the move, `win_len`."
- [DOCS CLEANUP table]: Puzzle state becomes "`kind`, `grade`, `status`, `book`". Paths become "book or judge".
- [PLAN] The book is crux's table of proven wins. Each row says that after this attacker move, with the defender to move, the attacker has a proven forced win of exactly `win_len` plies. Judging a move in a served puzzle is a lookup of the position the move creates. It is not a walk of move lists.

**Key.**

- [PLAN] The key is the board and side to move of the TPS, with the move number dropped, plus half-komi: `"<board> <stm>|<komi*2>"`. Size is implicit in the board.
  - [INF] The key is a position, not a move path, because transpositions exist. Today's `altsAt` is keyed by a path [CODE app.js:1072-1075], so it misses them.
  - [INF] Komi must be in the key, because flat wins depend on it.
  - Store the text, not a hash. SD §2.1 records tinue's old ~33-bit Zobrist keys on crux [DOCS].
- **Silent:** canonicalising under the 8 board symmetries. Two readings:
  - (a) no canonical form;
  - (b) canonical form, which merges the 384 symmetry-redundant ids [DOCS SD §2.8].
  - **Recommend (a)** for the first cut: every producer and the judge must agree on one form, and nothing measured needs (b).

**`win_len` convention** [PLAN, matching SOLVER §4: "AND minWin = 1 + max(children's, 1)"]:

- `win_len` = plies still to play from the position after the move, defender to move, ending with the attacker's winning ply.
- A puzzle's `plies` = 1 + the key's `win_len`.
- Check against the tree format [CODE app.js:527-530, `pliesLeft`; DOCS SD §3.0, "d('win') = 1 … 2 + max"]: a 3-ply puzzle's key leads to `{r, n: 'win'}`, and 1 + d('win') = 2 = `win_len`, so `plies` = 3.
- [DATA map-state §6.4] Across all 496,036 tree positions in the DB, no position has two different lengths. **A conflicting insert fails the publish.**

**Schema** [PLAN; column set after map-state §6.4, trimmed to what the briefs name]:

```sql
CREATE TABLE book (            -- proven wins, one row per position after an attacker move
  pos      TEXT NOT NULL,      -- "<board> <stm>|<komi*2>", defender to move
  win_len  INTEGER NOT NULL,   -- plies left, incl. the attacker's last; even, ≥ 2
  exact    INTEGER NOT NULL,   -- 1: disproof at win_len − 2 finished (MINING "mark it exact: false if …")
  model    TEXT NOT NULL,      -- 'full' | 'threat' | 'threat+1quiet' (what the length is exact under)
  proof    TEXT NOT NULL,      -- 'tree' | 'deep-cert' | 'pns' | 'syn6' | 'altwins' (who proved it)
  checked  INTEGER NOT NULL,   -- 1: SOLVER §5 checker replayed the proof, or the tree is exhaustive (R ≤ 5)
  puzzle_id TEXT NOT NULL,     -- first puzzle that produced it
  commit   TEXT NOT NULL,      -- producing commit (CLEANUP §1 "Write the commit sha into each output row")
  ver      INTEGER NOT NULL,   -- publish number that wrote it; rows are never updated, only superseded
  PRIMARY KEY (pos)
);
CREATE TABLE book_node (       -- attacker nodes the verifier classified completely
  pos      TEXT NOT NULL,      -- attacker to move
  puzzle_id TEXT NOT NULL,
  undecided TEXT NOT NULL,     -- JSON list of moves neither proven nor refuted (MINING cert `undecided`)
  model    TEXT NOT NULL,      -- what a refutation here rests on: 'λ1' | 'λ2' | 'full'
  commit TEXT NOT NULL, ver INTEGER NOT NULL,
  PRIMARY KEY (pos)
);
```

**`book_node` is this draft's addition.** The briefs are silent here, so there are two readings:

- **(a) Wins only.** The book holds only `book`. Any move whose position is absent goes to the live judge.
- **(b) Wins plus coverage.** The book also records, for each attacker node, that the verifier classified *every* legal move.
  - MINING's cert output already carries this per node: "`nodes: [{tps, R, keys, listedWins, undecided, bestAlt, p}]`" [DOCS MINING Deliverables].
  - SOLVER §6's `classify` sorts each legal move into key / slower win / quiet win / undecided / refuted [DOCS].
  - Then a move at a covered node that has no `book` row and is not listed as `undecided` is refuted, and the judge can say *miss* without an engine.
- **Recommend (b).** "Engines in a rated result: Syntaks native" [DOCS CLEANUP] leaves no live prover on 6×6. Under (a) a 6×6 miss could then come only from losing a play-out, which turns every wrong move into a play-out (*visible*, and crux load).
  - (b) keeps today's behaviour, an instant rated miss for a refuted move [CODE app.js:626-651].
  - Its refutations are stronger than today's. Today's live 'no' is threat-only [DOCS SD §3.2: "A win needing a quiet attacker move or a flat count is invisible"]. The cert's B stage adds a λ² test with one quiet move [DOCS MINING Stage B].

**Why the book can be complete for served puzzles** [INF]:

- Off-tree moves never continue the scripted line. They end in a miss or a play-out [DOCS CLEANUP: "book or judge: miss or play"].
- So the judge only ever needs verdicts for positions one attacker move away from a tree node, and those are finite.
- [DATA, `plan/.ev/nodes.mjs`, served pool] Attacker nodes and legal moves to classify:

| Size | Attacker nodes (incl. 'win' nodes) | Legal moves to classify |
|---|---|---|
| 4×4 | 427 | 19,719 |
| 5×5 | 68,386 | 5,780,544 |
| 6×6 | 28,850 | 4,125,543 |

**Size.**

- [DATA map-state §6.4] Served pool:
  - 69,226 tree positions (6×6: 20,246), all with an exact length under their model;
  - 6,680 positions from `alts`/`altsAt` (6×6: 2,459), with **no** length;
  - 75,906 `book` rows in all;
  - plus 97,663 `book_node` rows if (b).
- Cost to classify the 4.1M 6×6 moves: **unknown**.
  - [INF] Most refute in microseconds, since a λ¹ disproof with no threat is immediate [DOCS SOLVER §4, "if b == 0: fail"].
  - The tail sits at stage B budgets of "20 to 170 s" a node on hard puzzles [DOCS MINING table].
  - The pilot in part 3, step 6, measures it before the full run.

**Who writes it.**

- [DOCS CLEANUP §4]: "One verifier, as in the plan. It owns keys, cooks, faster wins and `status`."
- [PLAN] On 6×6 that is `deep cert`. Off 6×6 it is a `pns.js` verifier: "keep `pns.js` as the browser prover off 6×6 and the independent checker" [DOCS CLEANUP §5]. `deep` is "6×6 only" [DOCS MINING Setup].
- Every proof goes through SOLVER §5's checker. Publish refuses a `checked = 0` row on 6×6.
- Tree rows come in with `proof = 'tree'`:
  - `checked = 1` where the tree came from the exhaustive solver (R ≤ 5);
  - otherwise `model = 'threat'`, `exact` per the deep cert re-measure. MINING: "Run `deep up` on 200 stored `pd` 6×6 rows first; lengths must match `plies`, and any mismatch is a finding" [DOCS MINING Setup].

**How it is published.**

- [DOCS CLEANUP §3]: "`publish-puzzles` ships only new or changed rows, in one transaction, after an automatic snapshot", and "crux owns puzzles, book and attempts."
- [PLAN] Book rows go in the same transaction as their puzzle rows.
- `ver` increases by one per publish. A row is never updated: a corrected length is a new row with a higher `ver`, and the old one is moved to `book_old`, kept for re-judging.
- Each puzzle gets `book = sha256` of its slice (§1.4). Every attempt records that hash (§1.3), so "what was this move judged against" stays answerable after any publish. Today that cannot be recovered [CODE import.mjs:110-111, 134 overwrite `tree`/`swing` on every deploy].

**What it replaces** [PLAN]:

| Replaced | Where today | Note |
|---|---|---|
| `swing.alts`, `swing.altsAt` and their payload | [CODE server.js:204-207; app.js:588, 1072-1075] | 6,694 entries → 6,680 positions [DATA]. Payload fields stay until old builds are gone (§4) |
| per-puzzle cache `S.proven`, `S.proofPlies`, `provenKey` | [CODE app.js:587, 615-616, 1079] | the server answers instead |
| the 6×6 quick check (`engine.checkStill`) | [CODE app.js:590-619; engine.js:51-77] | covered nodes need no search |
| `proofLength` worker, `setProofLength`, `capWait('length')` | [CODE engine.js:80; app.js:896-912; playon.js:133-138] | `win_len` gives the cap's input |
| `flaw = 1` | [CODE import.mjs:101-102] | derived: the root node has a `book` row other than a key |

**Known content fix** [DATA map-state §4]: ps505288's `alts = ["c4-"]` "could not be proved to win". The book admits proven rows only, so this false solve disappears. *Visible* to anyone who reaches that held row by id (a play-out or a judged move instead of a free solve).

### 1.2 Judge

**What it is.**

- [DOCS CLEANUP §3]: "With the server judging, an old client cannot produce a wrong rated result."
- [DOCS CLEANUP table]: "book or judge: miss or play"; "Play-out endings 2: solved or not"; "Engines in a rated result: Syntaks native (df-pn off 6×6)."
- [PLAN] One server-side function in `shared/judge.js`, pure apart from injected engines:

```
judge(puzzle, bookSlice, line, engines) →
  { verdict: 'reply' | 'solved' | 'missed' | 'play',
    reply?, cap?, proven: bool, evidence: {...}, rated: bool, why?: string }
```

`line` holds the player's moves and, during a play-out, the defender replies the server itself chose. A verdict is a function of (puzzle, book `ver`, line, recorded engine replies). Re-running it on a logged attempt reproduces the verdict, and that is what makes re-judging and refunds mechanical (§1.3).

**Protocol.** The briefs are silent here. Two readings:

- (a) **Every move goes to the server**, on-tree moves included.
- (b) **The client plays the tree locally** (`play ⇄ reply` in CLEANUP §6's machine has no server step). It calls the judge only when a move leaves the tree (`play → judging`). At the end it sends the whole line, and the server replays it before rating.
- **Recommend (b).**
  - It is what the state machine draws [DOCS CLEANUP §6].
  - It keeps the on-tree reply at today's 450 ms with no network in the path [CODE app.js:660-672].
  - It matches iOS, which judges the tree locally [CODE TakMessages TAK/PuzzleView.swift:152-161 per map-server §6.3].
  - The server still decides every rated result, because it replays the line against the tree and its own records.

**Routes** [PLAN]:

| Route | Body | Answer | Replaces |
|---|---|---|---|
| `POST /api/judge` | `{attempt?, puzzleId, line, ms, theme?}` | `{attempt, verdict, reply?, cap?, proven, why?}`. It creates the attempt on the first call | quick check, alts, cache, held miss |
| `POST /api/playout` | `{attempt, move, ms}` | `{reply?, ending?: 'solved' \| 'not', why?, rated?}` | stateless `GET /api/defend` [CODE server.js:701-702], `syntaksReply`, Tiltak fallback |
| `POST /api/result` | `{attempt?, puzzleId, line, events, ms}` (events: hint, view, give up, left) | `{rated, userDelta, …, next?}` | trusting `win`/`casual` [CODE server.js:612-647] |

**Decision procedure for one off-tree move** [PLAN]. The order follows today's client [CODE app.js:557-651], moved to the server.

| # | Test | 6×6, half-point \|komi\| ≤ 3.5 | Off 6×6 (4×4, 5×5, 6×6 komi 4.0, 7×7, 8×8) |
|---|---|---|---|
| 1 | move wins the game | `solved` (rules) | `solved` |
| 2 | move ends the game otherwise | `missed` | `missed` |
| 3 | `book` row for the position after it | `play`, proven, `cap = provenCap(win_len)` | `solved` on the spot |
| 4 | covered `book_node`, move not `undecided` | `missed`, evidence = node `ver` + model | `missed` |
| 5 | `undecided` at a covered node | `play`, unproven | live df-pn (below) |
| 6 | node not covered (reserve row, old link, unverified puzzle) | `play`, unproven (**open question Q3**) | live df-pn |

- Row 3, 6×6 [DOCS SD §8.2, Sasha]: "Make people prove winning sequences! Just fine if they are slower."
- Row 3, off 6×6 [DOCS SD §8.2]: "No play out w tiltak … On 4×4 and 5×5 a proven win stays solved on the spot, as today."
- Rows 1–2 match [CODE app.js:557-559, 586].
- Row 4 off 6×6 rests on the `pns.js` verifier's coverage.

**Live df-pn off 6×6** (rows 5–6). The briefs give a location, not a mechanism: "keep `pns.js` as the browser prover off 6×6" [DOCS CLEANUP §5]. Two readings:

- **(a) The browser proves, the server checks.** The client runs today's still-wins worker and sends the proof. The server runs the SOLVER §5 checker on it with `shared/tak.js`.
  - This matches CLEANUP §5 word for word.
  - It keeps CPU off crux: the server is one Node process on synchronous SQLite [CODE server.js:740-759; map-server §7].
- **(b) The server proves**, in a `worker_threads` pool behind a bounded queue like `server/syntaks.js`.
- **Recommend (a)**, with the same budgets as today (2.5 s quick, 60 s visible; [CODE engine.js:51]).
  - A browser 'wins' without a proof that checks counts as undecided.
  - A 'no' needs no proof. Today it is a rated miss [CODE app.js:626-651], and keeping it unchanged keeps the rule.
  - Exposure under the server-judging claim: a hostile client can forge a 'no' only against itself.
  - Undecided at the budget behaves as today:
    - 4×4/5×5/6×6 komi 4.0: an **unrated** Tiltak play-on [CODE playon.js:34-37, 60];
    - 7×7/8×8: an unrated miss after up to 60 s [CODE app.js:626-637; DOCS SD §3.4].
  - Whether to keep the unrated Tiltak play-on at all is **Q4**.

**Per-size policy** [PLAN, from the CLEANUP engines row]:

| Board | Book | Live prover | Play-out defender | Rated play-out? |
|---|---|---|---|---|
| 6×6, half-point \|komi\| ≤ 3.5 | `deep cert` | none ("Syntaks native" only) | Syntaks native on crux | yes, both ways, as today [CODE playon.js:60, 68-69, 91] |
| 4×4, 5×5, 6×6 komi 4.0 | `pns.js` verifier | `pns.js` (browser, server-checked) | Tiltak, unrated only (Q4) | no, as today |
| 7×7, 8×8 | `pns.js` verifier | `pns.js` | none | — |

**Play-out, driven by the server** [PLAN].

- The server keeps the play-out's position and line on the attempt.
- On each `POST /api/playout` it:
  1. checks the move is legal [CODE `legalIn`, server.js:480];
  2. applies it and checks the result;
  3. asks Syntaks through the existing pool and priority queue [CODE server/syntaks.js:16, 159-171];
  4. logs both plies (§1.3) and answers.
- `capMoves` and `provenCap` move from `public/playon.js:8-30` into `shared/` so the server applies the same cap.
- **Two endings** [DOCS CLEANUP]: `solved` (the player's road or flat win) or `not`. What today's ten kinds distinguish [CODE app.js:1025-1061] survives as `why` in the log: `road`, `held`, `out`, `gaveup`, `left`, `timeout`, `engine`, `stalled`. The client shows one card per ending.

**Rated rules carried over unchanged** [CODE playon.js:59-101; DOCS SD §8.2]. The server now computes them instead of the browser:

- **`solved`** is rated unless a hint came first or it is not the first result.
  - A book-proven play-out in which Syntaks gives no legal move ends `solved`. This is today's `'proved'` [CODE app.js:956].
- **`not`** is rated iff all of these hold:
  - Syntaks replied at least once [CODE playon.js:60, `line.length >= 2`];
  - the game did not stall: a reply owed for more than `STALL_MS = 6000` [CODE playon.js:59, 101];
  - it is not a proven play-out ended by the page going away, or ended `out` with an unknown proof length [CODE playon.js:91].
- Under the server judge, "page went away" = the attempt timed out with no event. "Left for another puzzle" = an explicit `left` event from the outbox (§1.3). This reproduces today's split between `unload` and `left` [CODE app.js:771-790].
- **First result counts, guests at half weight, Glicko-2**: unchanged [CODE server.js:626-627, 635; shared/rating.js].

**Budgets, latency, queueing** [PLAN, with today's numbers as anchors]:

| Item | Target | Anchor today |
|---|---|---|
| `/api/judge` server time, book hit | p99 < 5 ms (in-memory map of book slices for served puzzles, loaded with the in-memory picker) | — |
| `/api/judge` client round trip | p50 < 300 ms, p99 < 1 s on a phone | quick window 2,500 ms [CODE engine.js:51] |
| Syntaks reply in a play-out | `go movetime 1200`, unchanged | `/api/defend` server p50 1,204 ms [DOCS SD §7] |
| Pool and queue | POOL = 2, priority queue 4, unchanged; re-measure after cutover (Q5) | [CODE server/syntaks.js:16, 161-165] |

**When the engine is slow or down. Invariant: never a false rated miss** [PLAN]. A false rated miss is "the worst possible bug" [task brief].

- The judge returns `missed` only from rows 2 and 4 (rules or a covered refutation), never from an engine error, a timeout or a queue refusal.
- If the Syntaks queue is full or the engine is missing (`503`) [CODE server/syntaks.js:156, 162], the play-out waits and retries for up to 20 s of visible time, which matches today's WASM wait [CODE app.js:937]. If it still has no reply:
  - **proven** play-out → `solved` (today's `'proved'`);
  - **unproven** play-out → `not`, unrated, `why = 'engine'`.
  - Today the second case falls to in-browser WASM (rated), then to Tiltak (unrated) [CODE app.js:914-970]. Dropping the WASM step is *visible* (§5, V2).
- If `/api/judge` itself is unreachable, the client stays in `judging` and the outbox retries. After 20 s of visible time the card reads "Couldn't reach the server; this one won't be rated", and the attempt closes unrated when its events arrive.

**Client code the judge removes**: see part 2. The headline items:

- the whole quick-check block of `userMove` [CODE app.js:583-651];
- `settleCheck`, `abandonQuick`, `abandonCheck` [CODE app.js:729-792];
- the defender chain [CODE app.js:914-982];
- the ten-way `endPlayOn` [CODE app.js:1025-1061];
- `gameRated` … `stalls`, which move to the server [CODE playon.js:59-101].

### 1.3 Log and outbox

**Which "log".** The briefs are silent. Two readings:

- (a) **The attempt log**: an append-only server record of every attempt, holding its moves, verdicts, evidence, build and commit.
- (b) **The `log` field / access log**: the client's ≤ 64-entry `log` on `attempts` [CODE server.js:110-124; app.js:524], or the access log [CODE server.js:714-745].

**This draft takes (a).** Reasons:

1. CLEANUP keeps the access log: "Keep as is: … the access log's privacy scheme" [DOCS]. A redesign named "log" beside book and judge is not that.
2. "crux owns puzzles, book and attempts" [DOCS CLEANUP §3] lists the three things the redesigns own. The book holds the puzzle evidence and the judge produces verdicts, so the log is where attempts live.
3. Without (a) the judge's verdicts are not re-checkable. Today's row cannot say:
   - why a result is unrated;
   - which build sent it;
   - which tree it was judged against;
   - what the defender played;
   - the RD and volatility before the result [CODE server.js:45-50; DOCS SD §8.4 "attempt rows record no reason"; map-server §3.3].
   SD §8.1 lists "Not built: server-side async proof with automatic refund" [DOCS], and an automatic refund needs exactly this record.
4. The client half of the log is CLEANUP §6's outbox [DOCS]: "One outbox replaces held records, the Web Lock and `pagehide` sends."

**Schema** [PLAN]:

```sql
CREATE TABLE attempt (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL, puzzle_id TEXT NOT NULL,
  first INTEGER NOT NULL,          -- 1 for the (user, puzzle) attempt that counts
  guest INTEGER NOT NULL,          -- users.name IS NULL at the time (weight 0.5)
  theme TEXT,                      -- checked against the puzzle's themes (today it isn't: server.js:633)
  puzzle_book TEXT NOT NULL,       -- puzzles.book hash judged against
  tree_hash TEXT NOT NULL,         -- sha256 of the tree served
  build INTEGER, commit TEXT NOT NULL,  -- client build (`b`), server commit
  started INTEGER NOT NULL, ended INTEGER,  -- server ms
  ms INTEGER,                      -- client visible ms, as today
  ending TEXT,                     -- 'solved' | 'not' | NULL while open
  why TEXT,                        -- tree, book, play:<road|held|out|gaveup|left|timeout|engine|stalled>, hint, view, …
  rated INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX attempt_first ON attempt(user_id, puzzle_id) WHERE first = 1;  -- CLEANUP §1's unique index
CREATE TABLE attempt_ply (           -- append-only
  attempt_id INTEGER NOT NULL, n INTEGER NOT NULL,
  side TEXT NOT NULL,                -- 'p' player | 'd' defender
  move TEXT NOT NULL,
  src TEXT NOT NULL,                 -- 'tree' | 'book' | 'judge' | 'syntaks@<hash>' | 'tiltak' | 'player'
  verdict TEXT,                      -- reply | solved | missed | play | NULL
  evidence TEXT,                     -- JSON ≤ 2 KB: {book_ver, win_len, node_model} | {proof_nodes, checker} | {nodes, ms, mate, winProb}
  ts INTEGER NOT NULL, client_ms INTEGER,
  PRIMARY KEY (attempt_id, n)
);
CREATE TABLE rating_event (          -- append-only; every rating change, including refunds
  id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- 'rate' | 'refund' | 'rejudge'
  ts INTEGER NOT NULL, by TEXT NOT NULL,  -- 'server@<commit>' | 'scripts/refund.mjs@<commit>'
  weight REAL NOT NULL,              -- theme × guest
  user_before TEXT, user_after TEXT, -- JSON {rating, rd, vol, games, wins}
  puzzle_before TEXT, puzzle_after TEXT,
  note TEXT
);
```

- **Recomputable ratings** [PLAN]: replaying `rating_event` rows in `id` order from the starting values reproduces `users` and `puzzles` exactly, because weights and before/after values are stored.
  - Today an exact replay is impossible: theme weight, guest status and RD/vol are not stored [CODE server.js:633-642; map-server §3.3].
  - `rerate.mjs` is a pre-Glicko Elo fit that writes `puzzles.rating` only [CODE scripts/rerate.mjs:98-101]. It is superseded and deleted (part 2).
- **Refunds** [PLAN] become an in-repo `scripts/refund.mjs` that appends a `refund` event:
  - it restores the user's rating, RD, vol and games from `user_before` when nothing later touched them, and otherwise replays later events;
  - it does the same for the puzzle, which today's crux scripts never do [DOCS SD §5.6: "the refund scripts never touch the puzzle"].
  - `REFUND_MARK` [CODE import.mjs:151-153] is repointed to "has a `refund` event whose move is still not in the book". That ends the dependence on the in-place `rated = 0, win = 0, user_delta ≠ 0` signature [CODE same].
- **Re-judging** [PLAN]: `scripts/rejudge.mjs --since <ver>` runs `judge()` over logged lines against a newer book. For each logged `missed` the new book proves, it proposes a `refund`.
  - For 6×6 the defender replies are in `attempt_ply`, so the game replays exactly.
  - A re-run of Syntaks would not reproduce them, because `movetime` search is time-based [INF].
- **Old `attempts` table**: kept and dual-written until the cutover is final (part 3), then a view over `attempt` for `/api/history`, the picker's `PLAYED` and the daily's `UNPLAYED` [CODE server.js:249, 279].

**Privacy and retention** [PLAN]:

- The log holds `user_id` only: no IP, gid, token or HMAC tag. That is the identity the access log already records in clear (`u<id>`) [CODE server.js:744]. The access log's scheme is unchanged [DOCS CLEANUP "Keep as is"].
- Rated attempts and their events are kept for as long as the ratings exist, since they *are* the ratings.
- Unrated attempts that never reached an ending: their plies are deleted after 180 days and the attempt row is kept.
- Size [INF]: crux had 1,301 rated attempts by 11-16 [DOCS SD §8.3]. At ≤ 64 plies × ~100 B a row, the log is tens of MB a year.

**Outbox (client)** [DOCS CLEANUP §6, made concrete; PLAN]:

- One localStorage queue `tinue.outbox`, holding entries of the form `{owner, attempt, seq, kind, data, b}`. `kind` is `result`, `event`, `left` or `line`.
- **Sends:**
  - on every enqueue;
  - at boot;
  - on `online` and `visibilitychange`.
- **Retries** with backoff for up to 24 h. The server answers `(attempt, seq)` idempotently, so a resend is harmless and two tabs need no lock.
- **Never on `pagehide`**:
  - the page going away is the server's `timeout` (§1.2);
  - so a keepalive that fails loses nothing;
  - today it can: [CODE app.js:691] deletes the held record before the keepalive send.
- **Owner**: a record whose `owner` is not the signed-in account is dropped, as `heldResend` does today [CODE playon.js:109-115].
- **What it carries**: only what the server cannot know: hints, Solution views, give-up and left events, client `ms`, and the final line of an all-tree solve. Verdicts are already on the server.
- **What it replaces**: `heldRec`, the Web Lock, `pageAlive`, `flushHeld` and its 3 s boot wait, the `reporting`/`uploading` sets, `heldDisplaced`/`deferredResendOk`/`resendAfterUpload`, and the pagehide `abandonCheck` [CODE app.js:41-80, 95-96, 767-807; playon.js:103-149].
- It also fixes a gap: an ordinary result that fails its single POST is lost today [CODE app.js:694, 717; api.js:53].

### 1.4 Puzzle state: `kind`, `grade`, `status`, `book`

[DOCS CLEANUP table]: "`turn`, `grade`, `flaw`, `swing.alts`, `altsAt`, 7 sidecars → `kind`, `grade`, `status`, `book`."

| New | Values | Filled at migration from | Written afterwards by |
|---|---|---|---|
| `kind` | `turning`, `conversion`, `unscored` | `turn` 1 / 0 / NULL [DATA: 20,021 / 49,602 / 1,489] | verify ("One turning-point rule … Three searches a puzzle" [DOCS CLEANUP §4]) |
| `grade` | A–D, conversions | unchanged | one grade script [DOCS CLEANUP §4] + `grade-overrides.jsonl` last [CODE import.mjs:138-144] |
| `status` | `served`, `reserve`, `rejected` | `served` = `turn = 1 OR grade = 'A'` [CODE server.js:236]: 26,478 [DATA]. `reserve` = the other 44,634. `rejected` = none at migration | verifier [DOCS CLEANUP §4 "owns … `status`"]; overrides |
| `book` | sha256 of the puzzle's book slice | computed at backfill | `publish-puzzles` |
| `pre0` | number | `swing.pre0` | verify |

- **`kind`.** Two readings:
  - (a) the turning-point label;
  - (b) the miner prefix.
  - The briefs exclude (b): "`p`, `pd`, `ps` and `pc` become a `source` tag" [DOCS CLEANUP §4].
  - Keep `pre0` as its own column. The client shows "Turning point: you were behind / the game was even" from `turn` and `pre0` [CODE app.js:1568], so dropping it is *visible*.
  - The miner tag cannot be called `source`, which already holds `'PlayTak'` on every row [DATA]. Use `miner` (`p`, `pd`, `ps`, `pc`, `pdg`).
- **`status` and the picker.** CLEANUP §4: "Mark them `reserve` and exclude them from rescoring, export and stubs."
  - It does **not** say "from the picker". The picker's fallback stage serves every non-served row today [CODE server.js:239-243]. That stage is the only source of 7×7/8×8 puzzles (0 served, 1,481 rows) and of most rare-theme filters [DATA].
  - **Recommend**: `reserve` stays pickable in the fallback stage, so players see no change. `rejected` is never picked and is rated by no route.
  - `/api/puzzle/:id` still returns a rejected row, for iOS and old links, with `rated: false`.
  - Excluding `reserve` from the picker would be *visible* (V6).
- **`flaw` goes, its picker terms stay** [PLAN]:
  - `FLAW` +100 [CODE server.js:220] becomes `altWins`: the root node has a `book` row that is not a key.
  - `REFUNDED` +400 and no `PLAYED` pull [CODE server.js:226, 252-253] become `refunded`: there is an unresolved refund event (§1.3).
  - Both are fields of the in-memory picker tuple, so "Keep the score, window and U² draw so the Z3 proof still applies" [DOCS CLEANUP §2] holds, and **no term is removed** without Sasha (V7).
- **Daily** [CODE server.js:281-289]: re-express the tiers on `status` and `kind` with the same meaning. Cutting seven tiers to three [DOCS CLEANUP "Keep as is"] is outside this plan. Tiers 5–7 are what guarantee a daily exists, and iOS treats a 404 as an error [CODE TinueAPI.swift:12-16 per map-server §6.3].
- **Dropped columns**: `turn`, `swing`, `flaw`. Dropped 30 days after the reads move (part 3), after a snapshot.

### 1.5 Offline: mine → verify → grade → import

[DOCS CLEANUP §4]: "One miner … One turning-point rule … One verifier … One grade script … Stop maintaining what is not served."

| Stage | Input → output | Owner |
|---|---|---|
| mine | games → `candidates.jsonl` `{tps, komi, miner, game, ply}`. "no 15-ply cap" [DOCS CLEANUP §4]; MINING's sources [DOCS MINING Pipeline 0] | in flight / later |
| verify | candidates → `verified.jsonl`, one row per puzzle `{id, tree, plies, kind, pre0, status, cert, book: [...], book_node: [...]}`. 6×6: `deep cert` + Syntaks turning-point searches; off 6×6: the `pns.js` verifier. Every proof checked (SOLVER §5) and walked with `tak.js` (MINING E) | `deep/` crate (in flight) + `scripts/verify.mjs` |
| grade | verified conversions → `grades.jsonl` | one script; MINING D's components where they apply |
| import | `publish-puzzles`: new or changed rows + book + book_node, one transaction, snapshot first, never touching `rating`/`rd`/`vol`/`attempts`/`solves` of played rows | in flight (deploy split) |

- **Silent:** whether "verify" re-runs over the existing 71,112 rows or only new candidates. Two readings:
  - (a) a one-time re-verification of the served pool;
  - (b) new rows only.
  - **Recommend (a) for served 6×6 (7,675 rows), then served 5×5/4×4 (18,803)**, because the judge's coverage depends on it.
  - "Done when: the served pool differs only by decided changes and verifier rejections" [DOCS CLEANUP] assumes (a).
- **Import stops reading sidecars.** `verified.jsonl` carries `kind` and `status`. The sidecar precedence, the supersession guard and the five-run rebuild [CODE import.mjs:53-134; DATA map-state §2.2] are deleted (part 2).
- **Hand fixes** live in one tracked overrides file applied last, as grades do since 1d663c1 [CODE import.mjs:138-144]. The file is extended to `status` and `tree`, so the 13 tree extensions and 18 syn6 plies-fixes that today live only in gitignored files [DATA map-state §5] become durable.

### 1.6 Client state machine

[DOCS CLEANUP §6]:

```
loading → intro → play ⇄ reply → solved | missed → review
                   └→ judging → missed | playout ⇄ reply → solved | missed
```

Two edges the diagram lacks. Both are flagged; neither is guessed silently.

1. **`judging → solved`.** Off 6×6, a proven win "stays solved on the spot, as today" [DOCS SD §8.2]. The diagram's paths row is scoped to "an off-tree 6×6 move" [DOCS CLEANUP table], where every win is played out. So the edge is needed off 6×6.
   - **Recommend**: add it.
   - Without it, 4×4/5×5/7×7/8×8 proven wins would need a play-out with no rated defender ("No play out w tiltak" [DOCS SD §8.2]) or become misses.
2. **`missed → play`.** Today a miss sets status `'retry'`. The player keeps going and can reach "Solved, after a miss" [CODE app.js:1077, 1351].
   - The diagram's `missed → review` ends the puzzle at the first miss. That is *visible* (V1).
   - **Recommend**: keep retry as `missed → play`. Results after the first are already unrated [CODE server.js:626-627], so the machine is unchanged for ratings.

**Lock and timing** [DOCS CLEANUP §6]:

- "One input lock (`busyUntil`) replaces TOO_SOON, FRESH, the 600 ms, 700 ms and 1,500 ms guards. Keep the same durations." [CODE app.js:493-510, 644-650, 853].
- The 450 ms reply, the 650 ms intro and the cap waits are animation or engine waits, not accident guards [INF from map-client §3.2]. They become state durations.
- The Enter-key gap on the 600 ms Solution guard [CODE app.js:1720] closes, because `busyUntil` gates every input.

**One file, one table test** [DOCS CLEANUP §6: "one small state machine, in one file, with a table test"]:

- `public/machine.js` exports `step(state, event) → state'`.
- `scripts/test-machine.mjs` asserts every (state, event) pair, including the illegal ones (which must be no-ops).

**Review** [DOCS CLEANUP §6]: "Review has one engine a size and no fallbacks."

| Board | Engine today, then fallbacks [CODE app.js:361-402] | After |
|---|---|---|
| 6×6, half-point komi | crux Syntaks → Tiltak → solver | crux Syntaks |
| 4×4 – 6×6, other komi | Tiltak → solver | Tiltak |
| 7×7, 8×8 | solver | solver |

When crux is down, 6×6 review shows "engine unavailable" instead of Tiltak's line. That is *visible* (V3).

**Next puzzle** [DOCS CLEANUP §6]: "try returning the next puzzle in the `/api/result` response. Delete the queue only if time to next puzzle does not get worse on a phone." Measured, not assumed.

**`#checkBuild`** [DOCS CLEANUP §3]: "can shrink to one check between puzzles."

- [PLAN] This holds only once `/api/result` stops rating client-asserted results (§4, step 14).
- Drop the 10-minute interval and the visibility check [CODE app.js:241-242]. Keep the check in `start()`.

---

## 2 · Deletions

By file and function. Lines are at 3026736 (`public/` and `shared/` are unchanged at 6e79c6c). "→" means moved, not deleted. Each row lands in the commit named in part 3.

| File | Deleted | Lines [CODE] | Replaced by | Step |
|---|---|---|---|---|
| public/app.js | `heldRec`, `ownHeld`, `pageAlive`, `pageId`/`owner` (owner hash kept in the outbox) | 48-80 | outbox | 9 |
| public/app.js | `reporting`, `uploading` | 95-96 | outbox | 9 |
| public/app.js | `report`'s held re-stamp, the keepalive path and `notCounted = 'lost'` | 676-724 (rewritten) | outbox `send` | 9 |
| public/app.js | `settleCheck`, `abandonCheck`, `abandonQuick`, `flushHeld`, the `pagehide` listener | 729-807 | server timeout + outbox | 9, 11 |
| public/app.js | quick-check block in `userMove` (cache, `slowerWins`, `checkStill`, major/minor, held miss) | 583-651 → ~15 lines calling `/api/judge` | judge | 11 |
| public/app.js | `slowerWins`, `provenKey`, `S.proven`, `S.proofPlies`, `S.uncheckedMoves` | 1072-1075, 1079, 615-617 | book | 11 |
| public/app.js | `slowSolve` (6×6 use; kept as `judging → solved` display off 6×6) | 1093-1101 | judge verdict | 11 |
| public/app.js | `LOCAL_MIN_NODES`, `syntaksReply`, the defender chain in `defenderTurn` (WASM, crux, WASM-wait, Tiltak fallback, `noengine`) | 917-982 | `/api/playout` | 12 |
| public/app.js | `visibleTimeout`, `makeProven`, `setProofLength` | 861-912 | `win_len` from the book | 12 |
| public/app.js | `endPlayOn`'s ten kinds | 1025-1061 → 2 | server ending + `why` | 12 |
| public/app.js | `playOnRated`, `defenderName` variants, `uncheckedText`, `playOnUnratedText` | 822-825, 1414-1425 | server `why` → one card table | 12 |
| public/app.js | `TOO_SOON_MS`/`tooSoon`, `FRESH_MS`/`fresh`/`wakeActions`, `justViewed`, the 700 ms and 1,500 ms checks | 493-510, 644-650, 1469-1472, 1684-1689 | `busyUntil` | 13 |
| public/app.js | build interval and visibility check, mid-puzzle bar logic, reload deferral | 240-263, 310-314 | one check in `start()` | 15 |
| public/app.js | `runTiltak`/`runSolver` as 6×6 fallbacks | 378-402 (6×6 branches) | one engine a size | 16 |
| public/playon.js | `defender`, `gameRated`, `unratedWhy`, `winRated`, `lossRated`, `lossWhy`, `stalls`, `STALL_MS` | 34-37, 59-101 | → `shared/judge.js` | 7 |
| public/playon.js | `capMoves`, `provenCap`, `proofMoves`, cap notes | 8-30 | → `shared/judge.js` | 7 |
| public/playon.js | `resigns`, `RESIGN_UNPROVEN`, `mayResign` (dead) | 43, 82-86 | — | 7 |
| public/playon.js | `heldResend`, `heldDisplaced`, `quickOutcome`, `CAP_WAIT_MS`/`capWait`, `resendAfterUpload`, `deferredResendOk` | 109-149 | outbox, book | 9, 12 |
| public/engine.js | `proofLength`; `checkStill` on 6×6 (kept off 6×6 under §1.2 (a)) | 51-80 | book | 11 |
| public/engine-worker.js | `'length'` handler | 102-110 | book | 11 |
| public/syntaks.js + the ~9.96 MB WASM [DOCS SD §3] | whole file, if V2 is approved (review never uses it [CODE app.js:361-402]) | all | crux Syntaks | 12 |
| server/server.js | `MIN_MISS_BUILD`, the stale rule, trusting `win`/`casual` | 21, 628-632 | judge + compat rule (§4) | 14, 20 |
| server/server.js | `swingPublic`'s `alts`/`altsAt` | 204-207 | book (after the old-build window) | 20 |
| server/server.js | `SERVED`/`served()` predicate, `flaw` reads | 220-237, 280 | `status`, derived picker fields | 17 |
| server/server.js | stateless `GET /api/defend` | 697-702 | `/api/playout` | 20 |
| scripts/import.mjs | sidecar selection, supersession guard, `setTurn`/swing/flaw, `REFUND_MARK` | 53-134, 151-153 | `publish-puzzles` reading `verified.jsonl` | 18 |
| scripts/ | `score-swing.mjs`, `rerate.mjs`; `grade/` steps folded into one; crux `~/tinue-alts/refund*.mjs` (not in the repo) | — | verify, log replay, `refund.mjs` | 18, 19 |
| scripts/test-playon.mjs | held and resend cases | — | `test-machine.mjs`, `test-outbox.mjs` | 9, 13 |
| DB | `puzzles.turn`, `swing`, `flaw`; `attempts` table (→ view) | — | `kind`, `pre0`, `book`; `attempt` | 21 |

The report lists the lines, files and columns removed, as CLEANUP's "Done when" asks [DOCS].

---

## 3 · Order of work

**Gates.**

- **Gate A** (steps 1–6) is dark: nothing visible, and the server only records.
- **Gate B** (steps 7–16) moves judging to the server behind a build that old tabs do not run. Steps 11, 12 and 16 need Sasha's yes for V1–V3.
- **Gate C** (steps 17–21) migrates state and deletes.

Every step is one commit with a test and a rollback [DOCS CLEANUP Method].

| # | Commit | Test | Rollback |
|---|---|---|---|
| 1 | `shared/judge.js`: pure `judge()`, `capMoves`/`provenCap` moved in, rated rules ported from playon.js | `scripts/test-judge.mjs`: a table of today's decisions per size and komi (§1.2), plus every `test-playon.mjs` cap pair ("OK: 8 play-on tests" [DOCS SD §3.3]) | revert (unused) |
| 2 | `book`, `book_node` tables (empty); loader into memory | schema test; load 0 rows | drop tables |
| 3 | Backfill `book` from served trees (69,226 rows, `proof = 'tree'`), and from `alts`/`altsAt` once lengths exist | 0 length conflicts; every row replays with `tak.js`; counts match §1.1 | `DELETE … WHERE ver = n` |
| 4 | `attempt`, `attempt_ply`, `rating_event`; `/api/result` dual-writes them beside `attempts` | replaying `rating_event` reproduces `users`/`puzzles` rating, rd, vol for every new attempt (|Δ| < 1e-9) | stop dual-write; tables stay |
| 5 | Shadow judge: `/api/result` runs `judge()` on the posted log and stores agreement in `attempt.why`; the result is still rated as today | report of disagreements per kind; acceptance in "Done when" | flag off |
| 6 | Verifier pilot: `deep cert` over 300 served 6×6 rows → `book` + `book_node` (MINING's pilot size) | lengths match `plies` (or are findings); checker 0 failures; CPU per node measured and projected to 28,850 nodes | delete rows by `ver` |
| 6b | Full 6×6 verification, then 4×4/5×5 with the `pns.js` verifier | coverage 100% of served attacker nodes; rejections listed for Sasha | delete by `ver` |
| 7 | Server: `POST /api/judge`, `POST /api/playout` (attempt-bound Syntaks, same pool and queue), attempt timeout | `test-server.mjs`: book hit, covered refutation, undecided → play, engine 503 → never `missed`, proven + engine down → `solved`, two endings, stall | routes unused by any client |
| 8 | Server: `/api/result` takes `{attempt, events}` from new builds and rates from server state | test: a client-sent `win: true` on an attempt the judge marked `missed` stays a miss | old path still serves old builds |
| 9 | Client: outbox; delete held records, Web Lock, pagehide sends | `test-outbox.mjs`: kill the page at every state, then reboot → exactly one result, never two; another owner's record dropped | revert client build |
| 10 | Client: `public/machine.js` with the CLEANUP §6 states plus the two edges (§1.6) | `test-machine.mjs` table | revert |
| 11 | Client: off-tree moves → `/api/judge`; delete the quick-check block, alts, cache, held miss | browser test: 6×6 refuted → miss in < 1 s; book win → play-out; 5×5 proven → solved on the spot | revert build; server keeps old `/api/result` |
| 12 | Client: play-out over `/api/playout`; delete WASM and the Tiltak fallback on 6×6 (*V2*) | play-out to a road, to the cap, give up, leave, engine down | revert build |
| 13 | `busyUntil` replaces the five guards, same durations | machine table: each guard duration asserted | revert |
| 14 | Compat rule for builds without attempt ids (§4); `MIN_MISS_BUILD` retired | test: an old-build miss on a move the book proves is unrated; an old-build miss on a covered refutation is rated | re-set `TINUE_MIN_BUILD` |
| 15 | `#checkBuild` shrinks to `start()` | build-bar test | revert |
| 16 | Review: one engine a size (*V3*) | per-size engine choice test | revert |
| 17 | `kind`, `status`, `pre0`, `book` columns filled; server reads `status`; picker tuple gets `altWins`, `refunded`; daily tiers rewritten; `verify-picker.py` updated | the served id set before and after is identical (26,478 locally; crux count at migration); picker model checker passes; daily tier picks identical over 365 seeded days | server reads `turn`/`grade` again (columns still there) |
| 18 | `publish-puzzles` reads `verified.jsonl`; sidecar import deleted; `score-swing.mjs` archived | rebuild from `verified.jsonl` reproduces crux's served pool except listed verifier rejections | previous import.mjs from git |
| 19 | `scripts/refund.mjs`, `scripts/rejudge.mjs` on `rating_event`; `REFUND_MARK` repointed; `rerate.mjs` archived | refund round-trip restores user and puzzle exactly; rejudge on a fixture finds the planted false miss | revert scripts |
| 20 | After the old-build window: drop `alts`/`altsAt` from payloads and stateless `/api/defend` | iOS contract test (§4) still passes | revert |
| 21 | After 30 days and a snapshot: drop `turn`, `swing`, `flaw`; `attempts` becomes a view | full `npm test`; `/api/history` unchanged | restore from snapshot |

Order constraints:

- 3 and 6 must precede 11, since the judge needs coverage before the client depends on it.
- 4 must precede 8, since rating from server state needs the log.
- 5 runs at least a week before 11, to collect disagreements.
- 17 follows CLEANUP §2's in-memory picker (in flight).

---

## 4 · Old clients and the iOS app

**Old web builds** stay open "for days" [task brief]. They post `{puzzleId, win, casual, theme, ms, log}` with `?b=` and no attempt id [CODE app.js:698-699]. [PLAN] compat rule for results without an attempt id:

- **Wins** count as today: "Wins are the same in every build and count" [CODE server.js:628-630 comment]. The judge cannot replay an old play-on win, because defender replies were never logged [CODE app.js:993]. Refusing them would be *visible*.
- **Misses** are rated only if `judge()` on the logged line finds the first `miss` move refuted at a covered `book_node`. Any other old-build miss is unrated, with `why = 'old-build'`.
  - Rationale: an old build can call a winning move a miss [CODE server.js:628-630]. This strictly narrows today's rated set, so it cannot create a false rated miss.
- **The window closes** at the later of 14 days after step 14 and the last day with more than 1% of result POSTs lacking an attempt id. The share is read from the access log's `?b=`, which today is "the only record of which build sent a result" [CODE server.js:744; map-server §5]. After that, a result without an attempt id is unrated.

**iOS (Gaelet)** calls `GET /api/daily`, then `GET /api/puzzle/:id`, and never posts a result [CODE TinueAPI.swift:12-16, PuzzleView.swift:152-161 per map-server §6.3].

- [PLAN] Contract: keep, with their types:
  - from `/api/daily`: `day`, `puzzle.{id, url, size, komi, rating, tps}`;
  - from `/api/puzzle/:id`: `id, tps, plies, themes, tree`, with `tree` in exactly `"win" | {ptn: null | {r, n}}` [CODE TinueAPI.swift:62-77].
- The book is never sent in place of `tree`.
- Step 17 adds `scripts/test-ios-contract.mjs`, which decodes both answers with that shape.
- Builds up to 14 call the Funnel host [CODE TinueAPI.swift:7-8 comment]. 6e79c6c now redirects it, so nothing here depends on the host.

**Bots** (`/api/group`, `botPuzzle`) read `turn` [CODE server.js:307]. Keep a `turn` field derived from `kind` in `botPuzzle`.

---

## 5 · Visible to players: each needs Sasha's yes

| # | Change | Why the plan wants it | Without it |
|---|---|---|---|
| V1 | A miss ends the puzzle (`missed → review`), with no "Solved, after a miss" | CLEANUP §6 diagram as drawn | **Recommended**: keep retry (`missed → play`) |
| V2 | 6×6 play-out replies always from crux; no Syntaks WASM, no Tiltak fallback. Latency per reply ≈ 1.2 s + RTT instead of ≈ 1.5 s local; engine failure → unrated game, not a WASM game | "Syntaks native"; a server judge cannot trust browser replies [INF] | keep WASM as an unrated-only fallback, which is what Tiltak is today |
| V3 | 6×6 review shows no line when crux is down (no Tiltak fallback) | "one engine a size and no fallbacks" | keep the fallback |
| V4 | Undecided or uncovered 6×6 moves played out instead of a 2.5 s quick 'no' (rows 5–6 of §1.2) | "Syntaks native" only; SD §8.2 row 5 (A9) proposed the same for threat-only 'no' | live `deep` on crux for uncovered nodes (Q3) |
| V5 | Off-6×6 undecided moves: unrated miss instead of an unrated Tiltak play-on | fewer engines | keep the Tiltak play-on (Q4) |
| V6 | `reserve` rows dropped from the picker's fallback (7×7/8×8 and rare themes run dry) | literal reading of "exclude" | **Recommended**: keep `reserve` pickable |
| V7 | Picker terms FLAW / REFUNDED changed or removed | CLEANUP §2 "minus the removed terms" | **Recommended**: keep both, derived |
| V8 | Results lost today (a failed single POST) are now delivered later; old-build misses become unrated unless book-confirmed | outbox; judge | — (better, but ratings change) |
| V9 | ps505288's unproven alt `c4-` stops being a free solve | book holds proofs only | — |
| V10 | Next puzzle returned in `/api/result` and the queue deleted | CLEANUP §6 | only if a phone test shows no slower time to next puzzle |

Not visible: the book, the log, the outbox's existence, `kind`/`status` (with V6 and V7 declined), and the verifier.

---

## 6 · Open questions for Sasha

| # | Question | Recommendation |
|---|---|---|
| Q1 | Keep "Solved, after a miss" (V1)? | Yes, keep. |
| Q2 | Syntaks native only for 6×6 play-outs (V2)? | Yes, once step 6b shows crux handles the play-out rate. Keep WASM only if a phone test shows replies over 3 s p90. |
| Q3 | 6×6 move at an uncovered node: play it out (V4), or run `deep` live on crux for ≤ 2.5 s? | Play it out. Coverage of served nodes is 100% after 6b, so this hits only reserve rows and old links. |
| Q4 | Keep the unrated Tiltak play-on off 6×6 for undecided moves? | Keep it for now. It is unrated, so it cannot hurt ratings; deletion can follow a count of how often it runs, which the log will give. |
| Q5 | Pool size: keep POOL = 2 at nice 10? | Keep, and measure queue waits from `attempt_ply` for two weeks. |
| Q6 | Reserve rows in the picker (V6)? | Keep pickable. |
| Q7 | FLAW / REFUNDED (V7)? | Keep, derived from the book and refund events. |
| Q8 | Retention: delete plies of unfinished unrated attempts after 180 days? | Yes. |
| Q9 | Auto-refund: when `rejudge.mjs` finds a logged rated miss the new book proves, apply the refund automatically or queue it for a yes? | Queue it for a yes for the first month, then apply automatically. This is SD §8.1's "server-side async proof with automatic refund". |
| Q10 | The "hard" collection from MINING: unrated until decided? | Yes, as MINING proposes, via `status = 'reserve'` plus a collection tag. "Silver is only fair once off-tree wins are played out" [DOCS MINING], and that is true after step 12. |
| Q11 | pd575074's one unrefunded rated miss (−2.9) [DOCS SD §8.2] | Refund it through `refund.mjs` as its first real case. |

---

## Done when

From CLEANUP's "Done when" [DOCS], plus numbers for the three redesigns [PLAN]:

- `npm test` passes, including the new `test-judge`, `test-machine`, `test-outbox` and `test-ios-contract`.
- **Served pool**: the served id set "differs only by decided changes and verifier rejections" [DOCS CLEANUP]. Every rejection is listed with its cook or length finding.
- **Book**:
  - 0 length conflicts;
  - every served 6×6 book row `checked = 1`;
  - 28,850 served 6×6 attacker nodes covered (and 68,813 off 6×6), with `undecided` lists;
  - the 6,680 alt positions carry lengths or are re-proven out.
- **Judge**:
  - in shadow mode (step 5), over at least two weeks of live results: **0** cases where the judge says `missed` and a checked proof says the move wins;
  - every disagreement explained;
  - engine-down test: no rated miss produced in 100 forced 503s.
- **Latency**:
  - `/api/judge` server p99 < 5 ms on book hits;
  - phone round trip p50 < 300 ms, p99 < 1 s;
  - play-out reply p50 ≤ 1.4 s server-side (today 1,204 ms [DOCS SD §7]).
- **Log**:
  - replaying `rating_event` reproduces every `users` and `puzzles` rating, rd and vol written since cutover;
  - a refund round-trip is exact for user and puzzle;
  - 0 results lost in the outbox kill test;
  - 0 duplicate first attempts (the unique index holds).
- **Old clients**: after the window, 0 rated results from requests without an attempt id.
- **Report**: lines, files and columns removed, per part 2.

---

## Appendix: where the briefs and the code disagree (affects this plan)

| Brief says | Code or data says | How the plan handles it |
|---|---|---|
| "Play-out endings: 9" | 10 kinds, 9 reachable; `unload` was split from `left` after the design page [CODE app.js:1025-1061; playon.js:85-91] | 2 endings, 8 `why` values |
| Tiltak among "engines in a rated result" | a Tiltak-defended game is unrated both ways [CODE playon.js:60, 68-69] | no change needed; Tiltak stays unrated |
| "Syntaks native" (and the task's "native Syntaks on the server") as today's 6×6 defender | WASM in the browser first, crux as fallback [CODE app.js:930-937] | V2 |
| `#checkBuild` can shrink "with the server judging" | true only once `/api/result` stops rating client `win`/`casual` [CODE server.js:631-632] | step 14 before step 15 |
| "7 sidecars", "3 import runs" | 12 sidecars (5 live); ≥ 5 runs; no recipe script [DATA map-state §2] | verify output replaces all of them |
| "With 5×5 conversions unserved, only about 1,100 rows need a grade" | 4,792 5×5 A conversions are served; no decision recorded [DATA map-state §7] | not assumed; grading stays over all served conversions |
| "exclude them from … export" (reserve) | the fallback stage serves reserve rows, including all 7×7/8×8 [CODE server.js:239-243] | reserve stays pickable (Q6) |
| a "C++ `deep` solver" (CLEANUP §5) | the in-flight crate is Rust (`solver/deep/Cargo.toml`) | language-neutral; the row format is fixed here |
| CLEANUP machine has no `judging → solved` | off-6×6 proven wins are solved on the spot by Sasha's decision [DOCS SD §8.2] | edge added (§1.6) |
| "Pages plus Funnel" | Cloudflare Tunnel is primary; 6e79c6c redirects Funnel [CODE git log] | no dependency |
