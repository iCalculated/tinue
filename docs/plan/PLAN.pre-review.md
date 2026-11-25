# tinue: book, judge, log — implementation plan (reconstructed)

*2026-11-17. Rebuilt from CLEANUP/MINING/SOLVER, `docs/system-design.html` and the code at 3026736. Three independent drafts (`draft-safety.md`, `draft-delete.md`, `draft-evidence.md`) were merged into this file; where they disagreed, the choice and the rejected option are in the Decisions table.*

## Summary (read this on a phone)

**The problem.** Today the browser decides whether a move was a miss, and crux trusts it. A move that wins with a quiet move or by flat count gets a threat-only "no", which is charged as a rated miss. No log exists that would let anyone re-check that. Refunds are hand scripts that cannot undo RD or volatility.

**The plan, in three pieces.**
1. **Book.** A table on crux of positions proven to win. Its key is the position after the attacker's move; its value is the winning length. It replaces `alts`, `altsAt`, the per-tab proof cache and `flaw`. It holds wins only, so a missing row costs time but can never cause a miss.
2. **Judge.** crux judges every move through one route, `POST /api/move`, using the tree, then the book, then a prover with a time budget. On 6×6 the prover is `deep`, which disproves with one quiet move allowed, a stronger test than today's threat-only check. On other sizes it is `pns.js` in a child process. A miss needs positive evidence. A timeout, a crash, a full queue or a dead engine always gives a play-out or an unrated result, never a rated miss. Play-outs run on crux against native Syntaks and end in one of two ways: solved, or not.
3. **Log.** One append-only record of every attempt: each ply including the defender's replies, what each verdict rested on, and ratings before and after with RD and volatility. The rating that counts is the server's copy. Refunds, re-judging and a nightly automatic false-miss check run from it.

**Order.** The log goes first, then the book, then the judge in shadow mode, then a veto that only removes misses. Next the server decides for new builds, and finally the deletions follow. Nothing changes what a player sees until gate G1. Every step before the deletions rolls back with an environment change.

**What it deletes, in the end.** About 4,400 lines gross and about 3,000 net. That includes the held-result machinery, the Web Lock, the pagehide sends, the browser still-wins check, the WASM defender chain, eight of ten play-out endings, four of five input guards and the sidecar import.

**What needs your yes.** 6×6 replies only from crux, and old-tab misses becoming unrated. Optionally also: ending a puzzle at the first miss, dropping the Tiltak play-on, 7×7/8×8, the picker fallback, and the queue. Each has a recommendation in §6/§7. Steps L1–C2 (§3) can start now.

---

## Tags

- **[DOCS]**: quoted from CLEANUP, MINING, SOLVER, or the design page (`SD §n` = `docs/system-design.html`, untracked).
  - [INF] That file is the "design page" the briefs used. Its §8.1 contains the "Stale comments" CLEANUP §1 asks to fix (SD line 1262). CLEANUP calls it `tinue-design.html`, so the name differs.
- **[CODE path:line]**: the repo at 3026736.
  - `public/` and `shared/` are unchanged at HEAD 6e79c6c.
  - `server/server.js` lines after about 136 are 21 lower at HEAD.
  - `[CODE db]` is a read-only count on lyra's `data/tinue.db`: 71,112 puzzles and 15 attempts. That is not crux.
  - `[CODE log]` is the copy `briefs/access.log` (11-08 07:18Z to 11-17 08:38Z).
- **[INF]**: an inference, with its reason.
- **[PLAN]**: what this reconstruction prescribes. A PLAN line is itself an inference about what the lost plan should say. Sections whose heading says PLAN are prescriptions throughout.

Citations carried over from the drafts were re-read at 3026736: server.js:19-21, 40-51, 200-245, 278-289, 480-500, 612-647, 696-702; app.js:41-80, 95-96, 240-243, 308-315, 493-510, 545-651, 674-807, 914-972, 990-995, 1025-1062, 1072-1101, 1568, 1720; playon.js:30-40, 55-154; engine.js:45-52; engine-worker.js:66-101; import.mjs:98-112, 148-154; syntaks.js:14-24; tak.js:98. Other line numbers come from `map-*.md` and were not re-read.

---

## Decisions (where the drafts disagreed)

| # | Question | Chosen | Rejected, and why |
|---|---|---|---|
| 1 | How moves reach the judge | **Every ply goes to `POST /api/move`, with `ply` as the idempotency key** (delete). The client still plays tree replies locally and does not wait for the answer on an on-tree move; it waits only on an off-tree move (`judging`). | **Off-tree only, with the line sent at the end** (evidence): a result still has to be shipped, so `report`/outbox persistence survives. **Event batches to `/api/attempt/:id/events`** (safety): the same idea with more surface. **Waiting on every move** (delete): it puts a round trip on every on-tree reply and stops on-tree play during a network blip. |
| 2 | What "log" means | **A server-side append-only attempt log** (all three agree). The client "outbox" becomes the in-memory retry queue of unacked plies (delete). | A localStorage outbox with liveness heartbeats (safety, evidence). Once crux holds every ply, there is no result left to deliver, so persistence buys nothing. |
| 3 | Log schema | **New tables `attempt`, `ply` and `rating_event`.** `attempts` stays as a projection written in the same transaction until P6, then becomes a view (safety and evidence). | `ALTER TABLE attempts` plus `moves` (delete). It is not additive: repeat attempts would land in a table that the picker, the daily and history read as "first attempt only" [CODE server.js:249, 279, 626]. |
| 4 | Live 6×6 prover | **Covered `book_node` first, then live `deep prove q=1` at 2 s.** A completed disproof is a rated miss with its model recorded; budget runs out → undecided → play-out. | **No live prover; uncovered moves are played out** (evidence). Until coverage is complete, nearly every wrong 6×6 move would become a play-out, which is visible and loads crux. **Threat-only q=0 first** (safety): its "no" is today's F1 hole; q=1 is a strict superset [DOCS SOLVER §3 "quiet list, which is built only when q > 0"]. |
| 5 | Off-6×6 prover location | **Server, `pns.js` in a child process**, with today's budgets: 2.5 s quick, up to 60 s final [CODE engine.js:51]. | **Browser proves, server checks** (evidence; matches CLEANUP §5's "browser prover off 6×6"). It keeps two judging paths and a proof-transfer format, against "With the server judging, an old client cannot produce a wrong rated result" [DOCS CLEANUP §3]. |
| 6 | Book key and versions | Text key `"<board> <stm>\|<2·komi>"`. Rows are insert-only, versioned, and retired instead of deleted; no symmetry folding. `win_len` may be NULL (unknown length). | Hash keys: tinue's old Zobrist keys had about 33 effective bits [DOCS SD §2.1]. Symmetry folding merges only 384 ids [DOCS SD §2.8], and every producer would have to agree on it. |
| 7 | Book field in the puzzle payload | **No.** `alts`/`altsAt` stay in the payload only for old tabs, until X5. | The `book` field (safety) exists for offline book hits, which per-move judging does not use. |
| 8 | Old tabs | Veto first: a legacy rated miss on a book-proven move → unrated. At D1 every legacy miss becomes unrated while wins still count. After the window, `/api/result` records results unrated and is deleted once it is idle. | **Rated if a covered refutation confirms it** (evidence): more code, for a window of days. **Refused outright after 14 days** (delete): "not counted" cards, and the puzzle stays a free retry. |
| 9 | Abandonment | **Today's rules, moved to the server:** `left` is rated per `lossRated`; the page going away is `unload` (proven → unrated, unproven → rated); detected when the attempt expires. Leniency is offered as Q7. | Delete and safety each made some of these unrated. That is visible, and it creates an escape from a lost unproven game. Sasha's rule lists "leaving for another puzzle" as a rated miss [CODE playon.js:71-80]. |
| 10 | Retry after a miss | **Keep `missed → play`** unless Sasha says otherwise (V10). | Terminal `missed` (delete; CLEANUP's diagram). It is the most visible change and saves about 30 lines. |
| 11 | Ordering | Safety's skeleton, with gates G1 and G2: L → B → S → C → D → X → P. The delete draft's end state is reached at X and P. | Delete's cutover-first order (D7 deletes the old path in the same commit that switches on judging), because it cannot roll back without a client redeploy. |
| 12 | Part numbering | Part 1 is the three redesigns plus the puzzle state, pipeline and client they force; Part 2 is the deletions (evidence). | Parts 1–3 as book, judge, log. CLEANUP's "The plan's part 2 lists the deletions" would then point at the judge part. |
| 13 | Picker and daily | Read `status`/`kind`; **keep** the stage-2 fallback over `reserve` and the FLAW/REFUNDED terms, derived from the book and from refund events. | Dropping them (delete). That is visible (V13). The daily's 7 → 3 tiers is CLEANUP's own item, not this plan's. |
| 14 | 7×7/8×8 judging | Server `pns` with `held` for up to 60 s, as today [CODE app.js:626-637]. | Unserving 7×7/8×8 (delete): visible (V12). |

---

## Rated-result safety (binding on every step)

**F-list: how a real win can become a rated miss today.**

| # | Channel | Evidence |
|---|---|---|
| F1 | The still-wins check returns `'no'` when no **Tak-threat** win exists, and that `'no'` is a rated miss. | [CODE engine-worker.js:70-73, 86-88]. [DOCS SD §8.1] "A live 'no' is a rated miss though the check is threat-only". The 1,181-move sample behind the code comment "was not located" (SD). |
| F2 | Deep trees and `alts` are threat-model lists, so a quiet win at a non-root node reaches only F1. | [DOCS SD §8.1] "Threat-only deep trees past R ≥ 7"; pd575074 `4c3+` |
| F3 | Off 6×6 there is no play-out, so a `'no'` goes straight to a rated miss. | [CODE app.js:620-651; playon.js:34-37] |
| F4 | The server trusts `win` and `casual`. The only guard is the build floor for misses. | [CODE server.js:614, 631-632] |
| F5 | Nothing re-judges after the fact, and refunds are manual and partial. | [DOCS SD §8.1] "Not built: server-side async proof with automatic refund"; SD §5.6 "the refund scripts never touch the puzzle" |

These outcomes are **by design and stay** [DOCS SD §8.2 "Rated miss when defended."; CODE playon.js:71-91]: failing to convert a winning move within the cap against Syntaks, and Give up, Solution or leaving mid-game when Syntaks has defended.

**Invariants** [PLAN, from the safety draft]:
- **I1. Evidence.** A rated miss needs positive evidence, one of:
  - `rules`: the move ended the game against the player;
  - `refuted`: a **completed** disproof, model recorded;
  - `defended`: a play-out lost under `lossRated`;
  - `view`: Solution was shown;
  - `giveup`.
  The nightly audit A6 counts rated misses without one of these and expects 0.
- **I2. Failure is not evidence.** Timeout, budget, 503/429, crash, OOM, a full queue, an illegal engine move, an unknown book version, or a lost network all mean `undecided`. `undecided` leads to a play-out where a rated defender exists, otherwise to an unrated result. This extends "A timeout is never a 'no'" [CODE engine.js:47] to every server failure.
- **I3. Monotone until G2.** Until gate G2, the server may only turn a rated miss into unrated or solved. It never creates a rated miss the browser would not have.
- **I4. Reproducible.** Every verdict records the puzzle revision, the book version, the prover build and budget, and the defender's replies.
- **I5. Re-judged.** Every rated miss with `refuted` evidence is re-judged within 24 h at a larger budget. A proof turns it into a refund proposal.

---

## Part 1 · The three redesigns

### 1.1 Book [PLAN unless tagged]

**What it is.** "Emit tinue's tree format and `book` rows: position after the move, `win_len`" [DOCS MINING, changes to `deep cert`, item 5]. Puzzle state becomes "`kind`, `grade`, `status`, `book`" [DOCS CLEANUP table]. A row says: after this attacker move, with the defender to move, the attacker has a proven forced win of `win_len` plies. **Wins only**: an absent row means "not known", never "refuted" (I2).

**Key.** `pos = "<TPS board> <side to move>|<2·komi>"` with the move number dropped. It is built by one function, `bookKey(game, komi)` in `shared/book.js`, on `Game.toTPS()` [CODE shared/tak.js:98]. The client, server, `deep cert` and scripts all call it.
- It is a position, not a move path, so transpositions hit. Today's `altsAt` is keyed by the moves played [CODE server.js:201-203] [INF].
- Komi is in the key because flat wins depend on it [INF].

**`win_len`.** Plies left from `pos`, defender to move, including the attacker's last ply. A puzzle's `plies` = 1 + its key's `win_len`. This matches SOLVER's "AND minWin = 1 + max(children's, 1)" [DOCS SOLVER §4] and the tree format's d('win') = 1 [DOCS SD §3.0]. NULL means proven with an unknown length. While the length is unknown, the cap rule for "unknown length" applies (§1.2).

```sql
CREATE TABLE book (
  pos         TEXT    NOT NULL,   -- bookKey: position after the attacker's move, defender to move
  ver         INTEGER NOT NULL,   -- book version that added it (one per publish)
  win_len     INTEGER,            -- plies left incl. the attacker's last; NULL = proven, length unknown
  exact       INTEGER NOT NULL,   -- 1: the disproof at win_len-2 finished (MINING "mark it exact: false if …")
  model       TEXT    NOT NULL,   -- what the length is exact under: full | threat | threat+1quiet
  proof       TEXT    NOT NULL,   -- tree | alt | deep-cert | live-deep | live-pns | rejudge
  checked     INTEGER NOT NULL,   -- 1: SOLVER §5 checker or tak.js fullDefense replayed it
  puzzle_id   TEXT,               -- producer (provenance only)
  commit      TEXT    NOT NULL,   -- producing commit (CLEANUP §1 "Write the commit sha into each output row")
  ts          INTEGER NOT NULL,
  retired_ver INTEGER,            -- set instead of DELETE, so past verdicts stay re-judgeable
  PRIMARY KEY (pos, ver)
) WITHOUT ROWID;
CREATE TABLE book_node (          -- attacker nodes whose every legal move the verifier classified
  pos       TEXT    NOT NULL,     -- attacker to move
  ver       INTEGER NOT NULL,
  undecided TEXT    NOT NULL,     -- JSON list of moves neither proven nor refuted (MINING cert nodes[].undecided)
  model     TEXT    NOT NULL,     -- what a refutation here rests on: threat | threat+1quiet | full
  puzzle_id TEXT, commit TEXT NOT NULL, retired_ver INTEGER,
  PRIMARY KEY (pos, ver)
) WITHOUT ROWID;
CREATE TABLE book_ver (ver INTEGER PRIMARY KEY, ts INTEGER NOT NULL, commit TEXT NOT NULL,
  added INTEGER, retired INTEGER, note TEXT);
```

**Lookups.** A lookup reads the newest unretired row with `ver ≤ TINUE_BOOK_VER`. Rolling back means lowering that number; nothing is deleted.

**Insert rules.**
- A second live row for a `pos` with a different `win_len` fails the publish. Across all 496,036 tree positions in the DB there are 0 such conflicts [CODE db, map-state §6.4].
- A publish that would retire the book row of a position the tree still lists as a key is refused. That key would turn into an off-tree move, a new path to a miss [INF].
- `checked = 0` rows (for example deep trees "never fullDefense-confirmed" [DOCS SD §8.1]) may be stored. A wrong win row gives a false **solve**, never a miss [INF]. For the cap, a row with `exact = 0` is treated as length unknown.

**`book_node` (coverage).** If a move at a covered node has no `book` row and is not in `undecided`, it is refuted without any engine running. `deep cert` already emits `nodes: [{tps, R, keys, listedWins, undecided, bestAlt, p}]` [DOCS MINING Deliverables], and SOLVER §6's certifier sorts every move into key / slower win / quiet win / undecided / refuted [DOCS].

**Contents and size.**

| Set | Rows | Source |
|---|---|---|
| Served tree-key positions | 69,226 (6×6: 20,246) | [CODE db, map-state §6.4] |
| Served `alts` + `altsAt` positions | 6,680 (6×6: 2,459), no length | same |
| Total book v1 | 75,906 | same |
| Served attacker nodes to cover | 6×6 28,850 (4.1 M legal moves); 5×5 68,386; 4×4 427 | [CODE db, evidence draft `.ev/nodes.mjs`] |

- Size: about 8–15 MB [INF: 6×6 TPS under 100 characters, plus the index].
- 1-ply puzzles add no rows: the rules see the win [CODE db, map-state].
- 7×7/8×8 tree rows are loaded too, because stage 2 serves them [CODE server.js:239-243].

**Writers.**
1. `scripts/book-init.mjs`, run once. It writes tree keys (`proof = 'tree'`, length = 1 + depth of the next node) and every alt **that proves again**: `deep up` on 6×6, `TinueSearch` with `fullDefense` elsewhere. ps505288's `c4-` "could not be proved to win" [CODE db, grade-overrides via map-state §4], so it must not enter. Alts that fail are listed in a report and left out.
2. The verifier, `deep cert` (in flight, 6×6): keys, slower and quiet wins, exact lengths, `book_node`, `checked = 1` [DOCS CLEANUP §4 "One verifier … owns keys, cooks, faster wins and `status`"].
3. The judge at play time: `live-deep` and `live-pns`, inserted only after the checker passes.
4. `scripts/rejudge.mjs`: proofs found while re-judging rated misses.

**Publishing.** Book rows ride on the in-flight `publish-puzzles` step: "ships only new or changed rows, in one transaction, after an automatic snapshot" [DOCS CLEANUP §3]. Each publish writes one `book_ver` row and bumps `puzzles.rev` (§1.4).

**What it replaces.**

| Today | Where | Replaced at |
|---|---|---|
| `swing.alts`, `altsAt`, `slowerWins()` | [CODE server.js:204-207; app.js:1072-1075] | X1 (client), X5 (payload) |
| `S.proven`, `S.proofPlies`, `provenKey` | [CODE app.js:587, 615-616, 1079] | X1 |
| the proof-length worker, `setProofLength`, `capWait('length')` | [CODE app.js:896-912; playon.js:133-138] | X2 |
| `flaw = 1` | [CODE import.mjs:101-102] | P4: "the root has a book row that is not a key" |

### 1.2 Judge [PLAN unless tagged]

**One function.** `judge(attempt, ply, inputs) → answer` lives in `shared/judge.js`. It is pure: no I/O and no clock. `server/judge-io.js` supplies the book reads, the prover pool and Syntaks. Because the function is pure, it is table-tested, and any logged attempt can be re-run against its recorded inputs (I4).

These move from `public/playon.js` into it unchanged: `capMoves`, `provenCap`, `proofMoves`, `defender`, `gameRated`, `winRated`, `lossRated`, `lossWhy`, `stalls`, `STALL_MS` [CODE playon.js:8-37, 55-101]. `playon.js` re-exports them until X2.

**Who defends** stays today's predicate: `size === 6 && |komi| ≤ 3.5 && 2·komi integer` [CODE playon.js:35].

**Contract (one row per case; first match wins).**

| # | State and input | Answer | Rated? | Evidence logged |
|---|---|---|---|---|
| 1 | `play`, move is a key at the node | `ok` + stored reply (`solved` if the line ends) | solved: rated if first and no hint | `tree` |
| 2 | any move that wins the game for the player | `solved` | as row 1 | `rules` |
| 3 | any move that ends the game against the player | `missed` | rated (I1 `rules`) | `rules` |
| 4 | off-tree, `book` row, defended (6×6 half-point \|komi\| ≤ 3.5) | `play`, proven, cap = `provenCap(left, win_len)`; NULL length → `capMoves(left)` with the unknown-length rule | see play-out table | `book {pos, ver, win_len}` |
| 5 | off-tree, `book` row, not defended (4×4, 5×5, 6×6 komi 4.0, 7×7, 8×8) | `solved` on the spot | rated | `book` |
| 6 | off-tree, covered `book_node`, move not in `undecided`, no `book` row | `missed` + refuting reply if stored | rated (I1 `refuted`, model of the node) | `node {pos, ver, model}` |
| 7 | 6×6 defended, live `deep prove q=1` (2 s) proves, checker passes | as row 4; inserts `live-deep` | as row 4 | `prover {deep@sha, q, nodes, ms}` |
| 8 | 6×6 defended, live `deep` **completes** a disproof | `missed` + deep's refuting reply [DOCS SOLVER §4 "AND best = refuting reply"] | rated (`refuted`, model `threat+1quiet`); re-judged nightly (I5) | `prover` |
| 9 | 6×6 defended, anything else (budget, queue full, crash, binary missing) | `play`, unproven, cap = `capMoves(left)` | see play-out table | `undecided {reason}` |
| 10 | not defended, live `pns` quick (2.5 s) proves with `fullDefense` | `solved` | rated | `prover {pns, …}` |
| 11 | not defended, `pns` completes a threat-only `'no'` | `missed` | rated (today's rule; A9 off 6×6 is Q3) | `prover` |
| 12 | not defended, `pns` pending at 2.5 s | `held`. The client may run today's unrated Tiltak play-on (Q4). The final search runs up to 60 s: wins → `solved` rated; `'no'` → `missed` rated, unless an unrated Tiltak game already ended it (unrated, as today); unknown → missed **unrated** | as stated | `prover` |
| 13 | `act: hint` | `hint` target; the attempt becomes casual | all later results unrated | `act` |
| 14 | `act: view` (Solution) | `missed` | rated unless hinted (I1 `view`) | `act` |
| 15 | not the first attempt, or puzzle `status ∈ held, rejected` (from P3) | judged normally, never rated | unrated | `repeat` / `held` |

Rows 1–3 follow [CODE app.js:557-559, 586]. Rows 5 and 10 follow [DOCS SD §8.2] "On 4×4 and 5×5 a proven win stays solved on the spot, as today" and [CODE app.js:624]. Rows 11–12 follow [CODE app.js:613-651, 729-765, 1025-1062].

**Play-out, run on crux** (D2). The `play` answer carries Syntaks's first reply. Each later player ply is a `/api/move` call, and its answer carries the next reply or the ending. The game is rebuilt from `ply` rows, so a restart loses only the search in flight [INF: the Syntaks cache is memory only, CODE syntaks.js:23]. It uses the existing pool: POOL = 2, MOVETIME 1200, priority queue 4 [CODE syntaks.js:16].

Two endings [DOCS CLEANUP "2: solved or not"]. The reason goes to the log as `why`, and the rated rules are today's, unchanged [CODE playon.js:55-101]:

| Ending (`why`) | Result | Rated? |
|---|---|---|
| player's road or flat win (`win`) | solved | `winRated` |
| a proof lands mid-game (`proved`) | solved | rated |
| proven play-out, Syntaks gives no legal reply after a retry and 20 s (`proved`) | solved | rated [CODE app.js:956] |
| cap reached, or Syntaks's road, flats or draw (`out`, `road`, `held`) | not | `lossRated`; proven with unknown length at `out` → unrated [CODE playon.js:91] |
| unproven at the cap while the final proof still runs | wait up to 20 s for it (today's `capWait('proof')` [CODE playon.js:133-137]); a proof raises the cap | — |
| Give up / Solution (`gaveup`) | not | `lossRated`; stall-exempt when a reply was owed for more than 6 s (server timestamps) [CODE playon.js:97-101] |
| next puzzle requested mid-game (`left`) | not | `lossRated`, same as today |
| no ply for 30 min (`unload`) | not | today's `unload` rule: proven → unrated, unproven → `lossRated` (Q7) |
| unproven, Syntaks unavailable (`noengine`) | not | unrated; the prover keeps running and a proof still makes it a solve [CODE app.js:970] |

`resign` is dropped: `RESIGN_UNPROVEN = false` makes it unreachable [CODE playon.js:85-86].

**API.**
```
POST /api/move  {puzzleId, ply, move? | act?: 'hint'|'view'|'giveup', ms, theme?, b}
 → {attempt, ply, verdict: 'ok'|'solved'|'missed'|'play'|'reply'|'held'|'hint',
    reply?, cap?, proven?, refutation?, why?, rated?, userDelta?, user?, puzzleRating?, token?, next?}
GET  /api/attempt?puzzle=<id>  → the open attempt's plies and state (resume after reload; poll while `held`)
```
- **Idempotent on `(attempt, ply)`.** A replay of a stored ply returns the stored `answer`. A different body for a stored ply gets 409, and the attempt is marked `conflict`, which is unrated.
- **Serialised per attempt** with an in-memory promise chain. The rating transaction stays synchronous, as in `/api/result` today [CODE server.js:637-644].
- **The first ply without a token mints a guest** through `newGuest`, under today's 10/h/IP limit [CODE server.js:620-622]. The attempt is bound to its user when it opens. That replaces `owner`, `authEpoch` and `answerOwnsToken` [CODE app.js:49; playon.js:146-154].
- **First attempt counts.** The first attempt *opened* for (user, puzzle) has `first = 1`; later ones are judged and never rated [CODE server.js:625-627 today: the first result to arrive].
- **`theme`** is checked against the puzzle's own themes. Today any valid key gets the weight [CODE server.js:633].
- **`next`** is returned in the deciding answer only after the phone measurement (X6).
- **`/api/puzzle/:id` stays pure.** It never opens an attempt (iOS, §3.2).

**Prover pool** (`server/prover.js`, modelled on `server/syntaks.js` [CODE syntaks.js:14-28]).

| Knob | 6×6 `deep` | other sizes `pns.js` child |
|---|---|---|
| processes | 1 (2 once A5 holds) | 1 |
| memory | `lp=20` table (about 200–400 MB [INF from SOLVER's 1.5 GB at a larger table]) | `--max-old-space-size=1024`; "~28 KB per full-defense node" [CODE engine.js:49] |
| quick | 2 s wall, `q=1 b2=20000` | today's budgets `[[3e4,2.5e4],[1e5,2.5e4]]`, 2.5 s [CODE engine.js:51] |
| final | none on the request path (re-judge does it) | up to 60 s, rows 11–12 only |
| queue | 4; full → `undecided{queue}` at once | 3; full → `undecided{queue}` |
| checker | every proof [DOCS SOLVER §5] | `fullDefense` confirmation as today [CODE engine-worker.js:92-94] |
| priority | `taskpolicy -b nice` for re-judge jobs [memory note: crux QoS]; interactive at nice 10 like Syntaks | same |

A crash, a kill or OOM resolves to `undecided{crash|oom|killed}`. It never rejects into `refuted`.

### 1.3 Log [PLAN unless tagged]

**Reading.** "crux owns puzzles, book and attempts" [DOCS CLEANUP §3]. The access log is kept "as is" [DOCS CLEANUP Keep as is], so the redesigned "log" is the attempt record. Its client half is CLEANUP's "One outbox replaces held records, the Web Lock and `pagehide` sends" [DOCS CLEANUP §6]. With every ply on crux, that outbox becomes the in-memory retry of unacked plies (Decision 2).

**Why it is needed** [CODE]:
- Rows do not store RD/vol before and after, the theme weight, or guest status [CODE server.js:45-50, 633-642]. So refunds cannot be exact.
- Defender replies are not logged; only the player's `po` moves are [CODE app.js:993].
- `tree` and `swing` are overwritten on every import [CODE import.mjs:108-112], so "judged against what?" cannot be answered.

```sql
CREATE TABLE attempt (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL, puzzle_id TEXT NOT NULL,
  first       INTEGER NOT NULL,          -- 1 = the attempt that counts
  guest       INTEGER NOT NULL,          -- users.name IS NULL when opened (puzzle weight × 0.5)
  puzzle_rev  INTEGER NOT NULL,          -- puzzles.rev judged against (puzzle_rev table keeps old trees)
  book_ver    INTEGER NOT NULL,
  build       INTEGER, commit TEXT NOT NULL,   -- client ?b=, server sha
  mode        TEXT NOT NULL,             -- legacy | shadow | decide
  theme       TEXT, weight REAL,         -- theme × guest weight actually applied
  opened      INTEGER NOT NULL, closed INTEGER, ms INTEGER,
  state       TEXT NOT NULL,             -- open | judging | held | playout | closed | conflict
  result      INTEGER,                   -- 1 solved, 0 not, NULL open
  why         TEXT,                      -- tree|book|proof|rules|refuted|view|giveup|win|proved|out|road|held|left|unload|noengine
  rated       INTEGER NOT NULL DEFAULT 0,
  unrated_why TEXT                       -- hint|repeat|undecided|noengine|stalled|tiltak|proven-unload|proven-length|legacy|held|conflict
);
CREATE UNIQUE INDEX attempt_first ON attempt(user_id, puzzle_id) WHERE first = 1;
CREATE TABLE ply (                       -- append-only
  attempt_id INTEGER NOT NULL, n INTEGER NOT NULL,
  by        TEXT NOT NULL,               -- p player | d defender | a act
  move      TEXT,
  src       TEXT NOT NULL,               -- player | tree | book | node | deep@sha | pns@sha | syntaks@sha | wasm@sha | tiltak
  verdict   TEXT,                        -- ok|solved|missed|play|reply|held|undecided
  evidence  TEXT,                        -- JSON ≤ 2 KB
  cap INTEGER, ts INTEGER NOT NULL, client_ms INTEGER,
  answer    TEXT,                        -- JSON returned (idempotent replay)
  PRIMARY KEY (attempt_id, n)
) WITHOUT ROWID;
CREATE TABLE rating_event (              -- append-only; every rating change incl. refunds
  id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- rate | refund | rejudge
  ts INTEGER NOT NULL, by TEXT NOT NULL, -- server@sha | scripts/refund.mjs@sha
  weight REAL NOT NULL,
  user_before TEXT, user_after TEXT,     -- JSON {rating, rd, vol, games, wins}
  puzzle_before TEXT, puzzle_after TEXT, -- JSON {rating, rd, vol, attempts, solves}
  note TEXT
);
CREATE TABLE puzzle_rev (id TEXT NOT NULL, rev INTEGER NOT NULL, tree TEXT NOT NULL, komi REAL, tps TEXT,
  ts INTEGER NOT NULL, PRIMARY KEY (id, rev)) WITHOUT ROWID;
```

**Rules.**
- `attempts` keeps being written in the same transaction for the first attempt only. Nothing that reads it changes: history, `PLAYED`, `UNPLAYED`, `REFUND_MARK`. It becomes a view at P6 [CODE server.js:249, 279; import.mjs:151-153].
- **Replay.** Applying `rating_event` in id order from its `before` values reproduces `users` and `puzzles` exactly for every post-L2 attempt (A8). Attempts before L2 lack weight, guest and RD/vol, so their replay is approximate [CODE map-server §3.3].
- **Refunds.** `scripts/refund.mjs` is dry-run by default. It appends a `refund` event and restores user **and** puzzle from `before` when nothing later touched them, and replays later events otherwise. Until P4 it also writes the legacy signature (`rated = 0`, `user_delta` kept) so `REFUND_MARK` keeps firing [CODE import.mjs:151-152]. It replaces `crux:~/tinue-alts/refund*.mjs` [DOCS SD §5.6].
- **Re-judging.** `scripts/rejudge.mjs` runs nightly at `taskpolicy -b nice`. It re-runs `judge()` over every rated miss whose evidence is `refuted` or `held`, at 60 s and `deep q=1`/`pns`, against the logged plies and the newest book. A proof inserts a `rejudge` book row and a refund **proposal** (Q8). This is SD's "server-side async proof with automatic refund" [DOCS SD §8.1].
- **Privacy.**
  - The log stores `user_id` only: no IP, gid, token or user agent. `user_id` already appears in clear in the access log [CODE server.js:744].
  - A gid must never enter it: a gid lets the holder take over a nameless guest through `newGuest` [CODE server.js:159-163, map-server §1.4]. Removing the gid-keyed `guest_attempts` table is in flight.
  - The access log's scheme is unchanged.
- **Retention.** Rated attempts are kept for as long as ratings exist, since they are the ratings. Plies of unrated attempts that never closed are deleted after 180 days.
  - Size: 1,375 result POSTs in 9 days [CODE log] gives about 150 attempts a day. At about 10 plies of about 150 B, that is under 100 MB a year [INF].

**Client delivery** (the "outbox").
- An in-memory, ordered queue of unacked `{ply, body}`.
- On failure it retries the same `ply` with backoff (1, 2, 4 … 30 s) while the page is visible, and again on `online` and `visibilitychange`.
- On-tree plies are queued and the board moves on. An off-tree ply waits in `judging`, with "Checking…" after 300 ms and "Can't reach the server, retrying" after 3 s.
- If the page dies, unacked plies never reach crux. On reload, `GET /api/attempt` resumes at the last acked ply.
- No storage, no Web Lock and no pagehide send.
- A failed result POST is lost today [CODE app.js:695, 717; api.js:53]; under this design it is not.

### 1.4 Puzzle state: `kind, grade, status, book` [PLAN unless tagged]

| New | From | Rule |
|---|---|---|
| `kind` | `turn` 1/0/NULL [CODE server.js:40] | `turning` / `conversion` / `unscored`: 20,021 / 49,602 / 1,489 [CODE db, evidence draft]. Written by verify. Bots keep a `turn` field derived from it [CODE server.js:307] |
| `pre0` | `swing.pre0` | its own column. The caption reads it [CODE app.js:1568] |
| `grade` | unchanged | the overrides file is applied last [CODE import.mjs:136-144] |
| `status` | `SERVED` predicate [CODE server.js:236] | `served` iff `turn = 1 OR grade = 'A'` (26,478 [CODE db]); `held` for the `hold-20261116` overrides; otherwise `reserve`. `rejected` is written only by the verifier with Sasha's diff approved |
| `book` | tree keys + `alts`/`altsAt` | §1.1. `puzzles.book` = sha256 of the puzzle's slice |
| `miner` | id prefix p/pd/ps/pc/pdg | CLEANUP calls it a `source` tag [DOCS §4]; `source` already holds `'PlayTak'` on every row [CODE db, map-state §6.1] |
| `rev` | — | bumped by `publish-puzzles` on change; the old tree goes to `puzzle_rev` |
| dropped at P6 | `turn`, `swing`, `flaw` | 30 days after the last reader moves, after a snapshot |

- The picker keeps stage 2 over `reserve` [CODE server.js:239-243]. Without it, 7×7/8×8 (1,481 rows, 0 served [CODE db]) and rare-theme filters go empty.
- `FLAW` (+100) is derived from the book; `REFUNDED` (+400) from an unresolved `refund` event [CODE server.js:220-226]. Both are picker tuple fields, so the Z3 bounds still hold [DOCS CLEANUP §2].

### 1.5 Offline pipeline: mine → verify → grade → import [DOCS CLEANUP table, §4]

| Stage | 6×6 | Other sizes |
|---|---|---|
| mine | MINING stage 0 / one forward scanner (in flight) | none: "Leave existing 5×5 labels frozen" [DOCS CLEANUP §4] |
| verify | `deep cert` with MINING's changes: every key, backtracking, cooks first, book + book_node rows [DOCS MINING "Changes … 1-5"] | `scripts/verify-pns.mjs` over served 4×4/5×5 (once), for `book_node` |
| grade | one `grade.py` reading the cert's cook and decoy counts [DOCS CLEANUP §4] | frozen |
| import | `publish-puzzles` reads `verified.jsonl` and writes puzzles + book + `puzzle_rev` in one transaction. It never touches rating/rd/vol/attempts/solves of played rows [CODE import.mjs:112] | same |

- Verifier rejections never apply themselves. They become a diff for Sasha [DOCS CLEANUP "Done when": "differs only by decided changes and verifier rejections"].
- Hand fixes (13 tree extensions, 18 syn6 ply fixes, today only in gitignored files [CODE db, map-state §5]) move into the tracked overrides file.
- MINING's hard collection is imported as `status = 'reserve'` plus a collection tag, unrated until Sasha decides. "Silver is only fair once off-tree wins are played out" [DOCS MINING], which is true only after D2.

### 1.6 Client state machine [PLAN unless tagged]

The machine is CLEANUP §6's [DOCS] plus two edges, both flagged:

```
loading → intro → play ⇄ reply → solved → review
                   │                missed → play      (retry; kept unless V10 is approved)
                   │                missed → review
                   └→ judging → solved                  (off 6×6 proven: SD §8.2 "stays solved on the spot")
                              → missed
                              → held → solved | missed  (pns pending, 4×4–8×8; offline off-tree)
                              → playout ⇄ reply → solved | missed
```

- It lives in one file, `public/puzzle.js`, as `step(state, event) → state'`, with `scripts/test-puzzle.mjs` asserting every (state, event) pair. Illegal pairs are no-ops.
- **One input lock, `busyUntil`.** It replaces TOO_SOON 500 ms, FRESH 1000 ms, `justViewed` 600 ms, the 700 ms after a miss and Give up's 1500 ms, keeping the same durations [DOCS CLEANUP §6; CODE app.js:493-510, 650, 1687]. The lock is per input class, so board moves stay at 500 ms after a new puzzle (the delete draft's 1000 ms is avoided). The Enter path gains the 600 ms guard it lacks [CODE app.js:1720], which fixes a bug and changes nothing visible.
- **Review**, "one engine a size and no fallbacks" [DOCS CLEANUP §6]: crux Syntaks for 6×6 half-point komi; Tiltak for 4×4–6×6 at other komi; the solver for 7×7/8×8. This is visible (V14) and needs a yes.
- **`#checkBuild`** shrinks to one check between puzzles [DOCS CLEANUP §3] only after X4, when no client-asserted result is rated.

---

## Part 2 · Deletions, by file and function

Lines are at 3026736. "→" means moved, not deleted. Each row lands at the step named in §3.

| File | Deleted | Lines | Replaced by | Step |
|---|---|---|---|---|
| public/app.js | `pageId`, `owner`, `pageLock`, `heldRec`, `ownHeld`, `pageAlive` | 41-80 | attempt bound at open | X1 |
| public/app.js | `reporting`, `uploading`, `authEpoch` | 95-104 | — | X1 |
| public/app.js | off-tree pipeline in `userMove`: `provenKey`, `S.proven`, `S.proofPlies`, `slowerWins`, the quick check, the major/minor split, the held miss, `engine.refute` | 583-651 → about 15 lines that post and await | judge | X1 |
| public/app.js | `report`, `settleCheck`, `abandonCheck`, `abandonQuick`, pagehide listener, `flushHeld` | 674-807 | server result in the `/api/move` answer | X1 |
| public/app.js | `fail`, `provenKey`, `slowSolve` (its display stays as `judging → solved`) | 1077-1079, 1093-1101 | judge verdict | X1 |
| public/app.js | `playOnDefender`, `defenderName`, `playOnRated`, `startPlayOn`, `visibleTimeout`, `makeProven`, `setProofLength`, `LOCAL_MIN_NODES`, `syntaksReply`, `defenderTurn`'s chain, `playOnMove` cap waits, the 10-way `endPlayOn`, `restoreLeft` | 820-1070 → about 60 lines | server play-out | X2 (V2) |
| public/app.js | `FRESH_MS`, `fresh`, `wakeActions`, `TOO_SOON_MS`, `tooSoon`, `justViewed`, the 700 ms and 1500 ms checks | 493-510, 650, 1687 | `busyUntil` | X3 |
| public/app.js | build interval, visibility check, bar logic mid-puzzle, reload deferral | 240-263, 308-314 | one check in `loadNext` | X4 |
| public/app.js | card variants for checking, held, resend, notCounted and play-on reasons | about 65 in 1405-1539 [map-client] | one card per ending + `why` | X1, X2 |
| public/app.js | `runTiltak`/`runSolver` as 6×6 fallbacks | 375-402 (branches) | one engine a size | X7 (V14) |
| public/playon.js | `capMoves`, `provenCap`, `proofMoves`, `defender`, `gameRated` … `stalls`, `STALL_MS` | 8-37, 55-101 | → `shared/judge.js` (S1); client copies go | X2 |
| public/playon.js | `resigns`, `RESIGN_UNPROVEN`, `mayResign` (unreachable) | 43, 82-86 | — | X0 |
| public/playon.js | `heldResend`, `heldDisplaced`, `quickOutcome`, `CAP_WAIT_MS`, `capWait`, `provenLossLead`, `resendAfterUpload`, `deferredResendOk`, `answerOwnsToken`; the file is then empty | 103-154 | log, judge | X1, X2 |
| public/engine.js | `checkStill`, `proofLength`; whole file (81) once review needs no solver on 6×6 | 45-81 | server prover | X1, X2 |
| public/engine-worker.js | `'still'`, `'length'`, `'refute'` handlers; review keeps only the solver | 66-132 | server prover | X1, X2 |
| public/syntaks.js, public/syntaks/worker.js, wasm/syntaks/*, 19.5 MB wasm, build-static lines | whole | 70 + 108 + 302 [delete draft wc] | crux Syntaks | X2, only with V2 |
| public/next.js, `for=`/`n=` (server.js 553-571), test-next*.mjs | whole | 115 + 18 + 490 | `next` in the answer | X6, only if A7 holds |
| server/server.js | `MIN_MISS_BUILD` and the trust in `win`/`casual` | 19-21, 628-632 | legacy rule, then the judge | X4 |
| server/server.js | `POST /api/result` (kept recording unrated until idle) | 612-647 | `/api/move` | X8 |
| server/server.js | stateless `GET /api/defend` | 697-702 | attempt-bound play-out | X2 |
| server/server.js | `swingPublic` `alts`/`altsAt` | 201-207 | book | X5 |
| server/server.js | `SERVED`/`served`, `flaw` reads | 220-237, 280-285 | `status`, derived fields | P2, P4 |
| scripts/import.mjs | sidecar selection, supersession guard, `setTurn`/`flawOf`, grades file, `REFUND_MARK` | 53-134, 148-153 | `publish-puzzles` reading verifier output | P5 |
| scripts/ | `score-swing.mjs`, `mine-swing.mjs`, `mine-deep.mjs`, `shared/deep.js`, `scripts/grade/*` except `grade.py`, `rerate.mjs`, `bench-pns.mjs` | about 1,860 [delete draft wc] | verify, log replay | P5 (some already archived in the scripts worktree, e.g. 076b41d, 8a7fb55) |
| scripts/test-playon.mjs, test-syntaks-wasm.mjs | held, resend and WASM cases | 251 + 47 | test-judge, test-puzzle | X1, X2 |
| crux `~/tinue-alts/refund*.mjs` | manual refunds | not in repo | `scripts/refund.mjs` | L3 |
| DB | `puzzles.turn`, `swing`, `flaw`; `attempts` → view | — | `kind`, `pre0`, `status`, `book`; `attempt` | P6 |

Totals [INF, delete draft counts]: about 4,400 lines removed, about 1,300 added (judge about 220, prover about 150, route about 90, puzzle.js about 200, scripts about 240, tests about 450), net about −3,000. Nine files and three columns go if every gated item is approved. Without V2 and A7, about −2,000.

---

## Part 3 · Migration order

### 3.1 Commit sequence [PLAN]

Every step is one commit with `npm test` green and its line delta in the message [DOCS CLEANUP Method]. Already in flight and **not redone**: the `deep/` crate (`prove`/`up` exist at solver/deep/src/main.rs:65-66; `cert` not yet [INF: grep finds none]), the in-memory picker, the deploy/publish split (deploy worktree 0808d8e, b18a643), and the removal of `/api/guest-result` (server worktree a20eb96) and of `votes`.

**Switches.**
- Server: `TINUE_LOG`, `TINUE_BOOK_VER`, `TINUE_JUDGE = off|shadow|veto|decide`, `TINUE_PLAYOUT = client|server`. Each is set in the plist and takes one restart.
- The server tells new clients the mode in the first `/api/move` answer. The client keeps its local path until X1, so **every step before X1 rolls back by an environment change**.

| # | Commit | Test | Rollback | Visible? |
|---|---|---|---|---|
| L1 | `attempt`, `ply`, `rating_event`, `puzzle_rev` tables (CREATE IF NOT EXISTS, no writers) | schema present; startup idempotent | unused | no |
| L2 | `/api/result` writes `attempt` (`mode='legacy'`) + `rating_event` in the same transaction: guest-at-time, weight, build, commit, before/after {rating, rd, vol} for user and puzzle, `unrated_why` | each result → one attempt + one event; `rate(before)` = `after` on 100 fuzzed results | `TINUE_LOG=0` | no |
| L3 | `scripts/refund.mjs` (dry-run default; user + puzzle; legacy signature kept) | fixture: refund then replay = never played; REFUND_MARK still marks | unused | no |
| L4 | `scripts/replay-ratings.mjs`; `rerate.mjs` archived | reproduces live ratings for all post-L2 attempts, \|Δ\| < 1e-9 (A8) | unused | no |
| B1 | `shared/book.js` (`bookKey`), `book`/`book_node`/`book_ver`, `scripts/book-init.mjs` (served trees + 7×7/8×8 trees + re-proved alts) | 0 length conflicts; 100% of served key positions present; win_len = 1 + depth on all; ps505288 `c4-` absent; failed alts listed | `TINUE_BOOK_VER=0` | no |
| B2 | `publish-puzzles` ships book rows insert-only, bumps `puzzles.rev`, writes `puzzle_rev` | test-deploy (fake crux): ver N+1 adds; lowering the pointer hides | pointer | no |
| B3 | `deep up` lengths for 6×6 alts; first run on 200 stored `pd` rows | lengths = `plies` on ≥ 199/200, every mismatch reported, not applied [DOCS MINING Setup] | pointer | no |
| B4 | `deep cert` pilot on 300 served 6×6 rows → book + book_node (needs `cert`) | checker 0 failures; CPU per node measured and projected to 28,850 nodes | pointer | no |
| S1 | `shared/judge.js` pure; playon.js rules moved in and re-exported | contract table §1.2 row by row; every test-playon.mjs case still green | revert | no |
| S2 | `server/prover.js` (deep, pns child), typed verdicts | fault injection: SIGKILL, tiny heap, hang, queue full → `undecided` 1,000/1,000; `refuted` only from a completed search; checker on every proof | not wired | no |
| S3 | Post-hoc shadow: each legacy result's logged `miss` move is re-judged (book, then prover, async); `shadow` plies written; daily false-miss-candidates report | fixture: pd575074 `4c3+` miss → candidate | `TINUE_JUDGE=off` | no |
| S4 | Nightly `rejudge.mjs` over rated misses of the last 7 days (taskpolicy -b nice, 1 CPU-h cap); proposals only | report renders; cap honoured; nothing applied | disable job | no |
| S5 | **Veto:** a legacy rated miss whose move position has a book row is recorded unrated (`unrated_why='book-win'`); synchronous lookup only | quiet alt on an old build → unrated; refuted move → still rated | `TINUE_JUDGE=shadow` | **yes** (V5, beneficial) |
| C1 | `POST /api/move` + `GET /api/attempt` routes, idempotent, serialised, guest minted at the first ply; shadow mode answers but rates nothing | 1,000 random ply streams with 30% duplicates, 30% reordering and a restart mid-stream → one attempt each, plies exactly once, 409 on conflict | routes unused | no |
| C2 | Client posts each ply to `/api/move` fire-and-forget with its own verdict (`clientVerdict`) **beside** today's `report()`; the server compares and logs | comparison report; no added client latency | server mode `off` | no |
| **G1** | gate (§4) | | | |
| D1 | `TINUE_JUDGE=decide` for builds ≥ `JUDGE_MIN_BUILD`: the client awaits off-tree verdicts and renders `judging`/`held`; the server rates from its own state and ignores `win`/`casual`. Same deploy: `TINUE_MIN_BUILD = JUDGE_MIN_BUILD`, so every legacy miss is unrated | state-machine table on recorded ply lists; every failure row of §4 on staging with Syntaks stopped and then killed; never a rated miss | `TINUE_JUDGE=shadow` (client falls back to its local path) | **yes** (V1, V3, V4, V6, V7) |
| D2 | Server-run play-out, Syntaks native only | scripted games: Syntaks stopped mid-game (proven → solved, unproven → `noengine` unrated); restart mid-game resumes; 7 s reply then Give up → stalled, unrated | `TINUE_PLAYOUT=client` | **yes** (V2) |
| D3 | Off-6×6 verdicts from the server pns (rows 10–12); Tiltak play-on stays client-side and unrated | as D1 per size | per-size flag | yes (part of V1) |
| D4 | Attempt expiry at 30 min → `unload` rule; `left` on next-puzzle request | fake-clock test | expiry off | no (today's rule) |
| **G2** | gate (§4) | | | |
| X0 | delete `resign` code | test-playon | revert | no |
| X1 | delete client held machinery, the off-tree pipeline and `report` (Part 2 X1 rows) | test-puzzle table; kill-the-page harness → 0 rated results lost | redeploy previous client (server keeps `decide`) | no |
| X2 | delete the client defender chain, WASM, `/api/defend`, playon/engine client copies | play-out scripts; 7 days with no `/api/defend` from builds < D2 [CODE log check] | revert | yes (with V2) |
| X3 | `busyUntil`, same durations | each guard duration asserted | revert | no |
| X4 | legacy `/api/result` always unrated (still recorded); `MIN_MISS_BUILD` removed; `#checkBuild` → one check | test-server | revert | yes (V4, second half) |
| X5 | drop `alts`/`altsAt` from payloads | 7 days with no legacy result [CODE log]; iOS contract test | re-add | no |
| X6 | `next` in the deciding answer; delete next.js, `for=`, `n=`, test-next* | **A7** on a phone | revert | yes (V15) |
| X7 | review: one engine a size | per-size engine test | revert | yes (V14) |
| X8 | delete `/api/result` | 7 days with 0 POSTs [CODE log] | re-add from git | no |
| P1 | `kind`, `status`, `pre0`, `miner`, `rev`, `book` columns backfilled (unread) | `status='served'` set == `SERVED` predicate on every row (26,478 local; crux's own count on crux) | columns unused | no |
| P2 | picker (in-memory) and daily read `status`/`kind`; stage 2 over `reserve` kept | test-next-model invariants; served id set identical; 365 seeded daily picks identical | read the predicate again | no |
| P3 | `held`/`rejected` attempts unrated | test-server | revert | yes (V8) |
| P4 | FLAW from the book, REFUNDED from refund events; `REFUND_MARK` retired | every row's picker score term equal on a crux copy | revert | no |
| P5 | `publish-puzzles` reads verifier output; sidecar import and the offline scripts deleted; hand fixes into overrides | rebuild reproduces crux's served pool except listed rejections (A9) | previous import.mjs | no, until Sasha approves rejections |
| P6 | after 30 days + snapshot: drop `turn`, `swing`, `flaw`; `attempts` → view | full npm test; `/api/history` unchanged | restore snapshot | no |

**Order constraints.**
- L2 before S3: shadow needs the log.
- B1 before S5 and D1.
- S1 and S2 before C1.
- C2 runs at least 14 days before D1.
- Every X step needs G2.
- P1 and P2 follow the in-flight picker.
- B4 and P5 need `deep cert`.
- X2 needs V2.

**Parallel work.** L, B and S1–S2 can run in parallel.

### 3.2 Old clients and iOS [PLAN unless tagged]

**Old web tabs** post `POST /api/result?b=…{puzzleId, win, casual, theme, ms, log}` [CODE server.js:614]. They stay open "for days" (task brief). In this log copy, build-less POSTs were last seen 11-16 19:15Z [CODE log, safety draft]. The rules over time:

| Period | Wins | Misses |
|---|---|---|
| until S5 | rated | rated above `TINUE_MIN_BUILD` [CODE server.js:631] |
| S5 → D1 | rated | unrated if the book proves the move |
| D1 → X4 | rated (unrating them would punish an old tab) | unrated |
| X4 → X8 | recorded unrated (so there is no free retry) | recorded unrated |

- `alts`, `altsAt`, `turn`, `pre0` and `tree` stay in `/api/next` and `/api/puzzle/:id` until X5, because old tabs judge with them [CODE app.js:588, 1568]. Removing `alts` before D1 would send quiet alts into F1 [INF].
- An old tab can still record a false rated **win** via ps505288's `c4-`, as today. From D1, `alts` entries that are not in the book can be stripped from the payload at no risk, since legacy misses are unrated by then.

**iOS (Gaelet)** reads `/api/daily` → `{day, puzzle{id, url, size, komi, rating, tps}}` and `/api/puzzle/:id` → `{id, tps, plies, themes, tree}`, with `tree` = `"win" | {ptn: null|{r, n}}`. It judges locally and never posts [CODE TakMessages TinueAPI.swift:12-77, PuzzleView.swift:152-161, via map-server §6.3].
- Those fields and the tree format are frozen.
- `/api/puzzle/:id` never opens an attempt.
- `scripts/test-ios-contract.mjs` decodes both shapes and runs at B2, P2, X5 and P6.
- The daily keeps tiers 5–7, so it is never empty (iOS treats a 404 as an error) [CODE server.js:286-288; TinueAPI.swift:12-16].
- Bots keep `botPuzzle.turn`, derived from `kind` [CODE server.js:307].

---

## 4 · Acceptance checks and gates [PLAN]

| # | Check | Target |
|---|---|---|
| A1 | served set after P1/P2 | identical to `turn = 1 OR grade = 'A'` (26,478 local) before any decided change |
| A2 | book | 0 length conflicts; 100% of served key positions; ps505288 `c4-` absent; every alt re-proved or listed |
| A3 | judge on stored puzzles | 100% of tree keys → `ok`; 100% of book alts → proven; 0 `missed` on any book position |
| A4 | disproof soundness | over 1,000 random 6×6 wrong moves plus SD §2.6's 155 refuted alt-wins moves: 0 cases of a live `deep` disproof that `deep q=1` at 60 s or `pns` proves |
| A5 | latency | `/api/move` on-tree/book p99 ≤ 20 ms server; live judge p95 ≤ 2.5 s (6×6) / 3 s (others); Syntaks reply p50 ≤ 1.4 s server (today 1,204 ms [DOCS SD §7]) |
| A6 | evidence | `rated = 1 AND result = 0 AND why NOT IN (rules, refuted, view, giveup, out, road, held, left, unload)` → 0 |
| A7 | time to next puzzle on a phone | median ≤ today's, same phone and network, before X6 |
| A8 | replay | post-L2 ratings reproduced to \|Δ\| < 1e-9 |
| A9 | served pool after P5 | differs only by decided changes and verifier rejections, each with a reason [DOCS CLEANUP "Done when"] |
| A10 | faults | 0 rated misses in 1,000 injected crash/timeout/OOM/queue-full/503 runs |
| A11 | delivery | 1,000 simulated attempts with 30% drops, 30% duplicates and random page kills: one attempt each, 0 duplicate plies, 0 rated results from conflicts |
| A12 | iOS | an unchanged Gaelet build plays the daily before and after X5 and P6 |
| A13 | report | lines, files and columns removed, per Part 2 [DOCS CLEANUP "Done when"] |

**G1** (before D1):
- at least 14 days of C2 shadow and at least 300 off-tree judgments;
- 0 cases where the server says `missed` and the browser proved a win, or where the move was later proved;
- every browser rated miss that the server proves is explained and gets a refund proposal;
- server `undecided` at most 1.2× the browser's `pending`/`unknown` rate.

**G2** (before any X):
- at least 14 days in `decide`;
- 0 refunds caused by the judge;
- 0 attempts stuck in `judging`/`held` for more than 24 h;
- A6 = 0;
- S4 finds no judge-caused false miss.

---

## 5 · What can start now, and what cannot

**Without Sasha's yes** (dark, reversible by env or revert):
- L1–L4;
- B1–B4 (B4 once `cert` exists);
- S1–S4;
- C1–C2;
- X0;
- X3 (same durations);
- P1;
- the iOS contract test.
These steps do not change what a player sees.

**Needs Sasha's yes before it ships:**
- S5 (veto; beneficial but visible);
- D1 (judging wait, offline off-tree, `deep q=1` refutation model, old-tab misses unrated);
- D2/X2 (native-only defender);
- D3;
- X4;
- X6;
- X7;
- P3;
- the first real refund (pd575074);
- any V10–V13 or V16–V17 item;
- applying verifier rejections in P5.

---

## 6 · Visible changes (each needs Sasha's yes)

| # | Change | Step | Recommendation |
|---|---|---|---|
| V1 | Off-tree moves are judged on crux: "Checking…" includes the round trip, and offline an off-tree move waits ("Can't reach the server, retrying"). On-tree play is unchanged. | D1, D3 | yes |
| V2 | 6×6 play-out replies only from Syntaks native on crux: no WASM (tried first today [CODE app.js:930-937]) and no Tiltak fallback. About 1.2 s + RTT per reply against about 1.5 s local. When crux is busy: proven → solved, unproven → unrated. | D2, X2 | yes. A server judge cannot rate replies it did not choose. Without a yes: keep WASM-first, with the client posting its replies as `src=wasm` plies, which the server checks for legality. |
| V3 | 6×6 refutations use `deep q=1` (one quiet move) instead of threat-only, so some of today's rated misses become play-outs. This is A9 in a stronger form [DOCS SD §8.2 row 5 "framed as closing the main hole"]. | D1 | yes |
| V4 | Old tabs: misses unrated from D1, then everything unrated from X4. | D1, X4 | yes |
| V5 | A legacy miss on a book-proven move shows "not rated". | S5 | yes |
| V6 | Results no longer get lost on a failed upload; a reload mid-puzzle resumes the attempt. | D1 | yes |
| V7 | Two tabs on one puzzle: the first attempt *opened* counts. | D1 | yes |
| V8 | `held`/`rejected` puzzles unrated; ps505288's `c4-` is no longer a free solve. | P3, B1 | yes |
| V9 | The miss card's refutation comes from the judge (deep's refuting reply); off 6×6 it is often absent. | D1 | yes |
| V10 | *(delete end state)* A miss ends the puzzle: no retry, no "Solved, after a miss" [CODE app.js:1077]. | — | **no**: keep retry |
| V11 | *(delete end state)* No Tiltak play-on: an undecided 4×4/5×5/6×6-komi-4 move is an unrated miss. | — | later, once the log counts how often it runs |
| V12 | *(delete end state)* 7×7/8×8 leave the size menu. | — | Sasha's call; no scoring and no defender |
| V13 | *(delete end state)* picker fallback and FLAW/REFUNDED dropped; rare filters can run dry. | — | no |
| V14 | Review: one engine a size; 6×6 shows "engine unavailable" when crux is down. | X7 | yes |
| V15 | Next puzzle in the verdict, queue deleted. | X6 | only if A7 holds |
| V16 | Leniency: an expired or `left` play-out becomes unrated. | — | no (today's rule kept) |
| V17 | Automatic refunds. | after S4 | proposals for a month, then auto-apply where the evidence is a checked proof |

---

## 7 · Open questions for Sasha

| # | Question | Recommendation |
|---|---|---|
| Q1 | Keep "try again" after a miss (V10)? | Keep. |
| Q2 | Native Syntaks only for 6×6 play-outs (V2)? | Yes, after A5 holds on crux. |
| Q3 | Is a completed `deep q=1` disproof a rated miss (with nightly re-judge), or should every non-book 6×6 move be played out? Off 6×6, does A9 apply to `pns`'s threat-only "no"? | The former on 6×6. Off 6×6 keep today's rule, and count the cases from the log first. |
| Q4 | Keep the unrated Tiltak play-on (V11)? | Keep for now. |
| Q5 | 7×7/8×8 in the menu (V12)? | Keep until the verifier covers them. |
| Q6 | Picker fallback and FLAW/REFUNDED (V13)? | Keep, derived. |
| Q7 | Abandoned unproven play-out: keep today's rated `unload` via expiry, or make it unrated (V16)? | Keep today's rule. |
| Q8 | Refund proposals: manual approval or automatic (V17)? | Manual for a month. |
| Q9 | Refund pd575074's unrefunded −2.9 [DOCS SD §8.2] as `refund.mjs`'s first real case? | Yes. |
| Q10 | MINING's hard collection: unrated until decided, served only after D2? | Yes [DOCS MINING]. |
| Q11 | Grade D "never serve" is not enforced in stage 2 or daily tier 4 [CODE server.js:240-243, 285]. Make D `rejected`? | Yes, as its own visible change. |
| Q12 | Board on-tree play with no network: keep (this plan), or require crux for every move (delete draft)? | Keep. |

---

## What this reconstruction cannot know

The original plan was never delivered. These are the places where it may have differed. Everything below is [INF].

1. **Its numbering.** CLEANUP's "part 2 lists the deletions" fits either "Part 1 design, Part 2 deletions" (used here) or "Parts 1–3 book, judge, log", with the judge part listing the client deletions.
2. **The protocol.** The briefs never say whether every move or only off-tree moves reach the server. CLEANUP's diagram draws `play ⇄ reply` with no server step, which fits either reading.
3. **What "log" meant.** It might have been the client outbox alone. It might have extended the access log, although CLEANUP keeps that "as is". Or it might have been an attempt ledger, as here.
4. **Whether 6×6 has a live prover.** "Syntaks native (df-pn off 6×6)" may mean the original plan relied on full verifier coverage (no df-pn on 6×6 at play time), or played out every non-book 6×6 move. This plan uses live `deep` as a bridge; the original may have had no such bridge.
5. **What the author knew.** The briefs were written from the design page alone, under a different file name (`tinue-design.html`). The plan may assume things that are false in the code:
   - Tiltak in a rated result;
   - 9 endings (10 kinds exist, 9 reachable);
   - 7 sidecars (12 exist, 5 live);
   - C++ `deep` (the in-flight crate is Rust);
   - "5×5 conversions unserved" (4,792 are served).
   The plan may also not have known that WASM defends first today.
6. **Retry.** CLEANUP's machine drops `missed → play` and `judging → solved`. The plan may have meant both, or neither, or simply left them out.
7. **Old tabs and iOS.** The design page covers both (SD §3.7, map-server §6.3), but it is unknown whether the plan had a compatibility window, a veto, or gates.
8. **Schemas, budgets and numbers.** Every table, column, budget, latency target and gate figure here is this reconstruction's. The plan may have named different status values: CLEANUP itself names only `reserve`.
9. **The verifier off 6×6.** "One verifier, as in the plan" may have meant 6×6 only, leaving other sizes frozen with no coverage.
10. **What else the plan contained.** It might have kept the queue, cut daily tiers, unserved 7×7/8×8 or dropped FLAW. CLEANUP mentions some of these as its own items.

---

## Appendix · Where the briefs and the code disagree

| Brief says | Code says | Effect here |
|---|---|---|
| Tiltak among "engines in a rated result" [DOCS CLEANUP] | a Tiltak-defended game is unrated both ways [CODE playon.js:60, 68-69] | nothing to change for ratings |
| "Play-out endings 9" | 10 kinds, 9 reachable; `resign` dead [CODE app.js:1025-1062; playon.js:85] | 2 endings plus `why` |
| "Syntaks native" as the 6×6 defender | WASM in the browser first; crux as fallback [CODE app.js:930-937] | V2 is a change, not a cleanup |
| "an old client cannot produce a wrong rated result" | true only once legacy misses are unrated [CODE server.js:631-632] | D1, then X4 |
| "crux owns puzzles" | lyra's export overwrites crux rows on deploy [CODE import.mjs:108-112] | the in-flight publish split is a precondition |
| "7 sidecars", "3 import runs" | 12 sidecars (5 live); at least 5 runs [CODE db, map-state §2] | the verifier replaces them all |
| "With 5×5 conversions unserved, only about 1,100 rows need a grade" | 4,792 5×5 A conversions are served [CODE db, map-state §6.3] | grading stays over served conversions |
| "Mark them `reserve` and exclude them from rescoring, export and stubs" | stage 2 serves reserve, including all 7×7/8×8 [CODE server.js:239-243] | reserve stays pickable (Q6) |
| "C++ `deep` solver" (CLEANUP §5) | the crate is Rust; `prove`/`up` exist, `cert` does not yet | language-neutral |
| "keep `pns.js` as the browser prover off 6×6" | — | rejected (Decision 5); `pns.js` stays as the checker and runs on the server |
