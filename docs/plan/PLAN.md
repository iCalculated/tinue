# tinue: book, judge, log — implementation plan (reconstructed)

*2026-11-17, revision 2. Rebuilt from CLEANUP/MINING/SOLVER, `docs/system-design.html` and the code at 3026736. Three independent drafts (`draft-safety.md`, `draft-delete.md`, `draft-evidence.md`) were merged; revision 2 applies two adversarial reviews (see "Review record" at the end; the pre-review text is `.rev/PLAN.pre-review2.md`).*

## Summary (read this on a phone)

**The problem.** Today the browser decides whether a move was a miss, and crux trusts it. A move that wins with a quiet move or by flat count can get a threat-only "no", which is charged as a rated miss. No log exists that would let anyone re-check that. Refunds are hand scripts that cannot undo RD or volatility and never touch the puzzle.

**The plan, in three pieces.**
1. **Book.** A table on crux of positions proven to win. Its key is the position after the attacker's move; its value is the winning length. It replaces `alts`, `altsAt`, the per-tab proof cache and `flaw`. Every alt served today goes in, including ones that fail to re-prove (marked unchecked). A book row can only make a move count as a win; a missing row never by itself makes a miss.
2. **Judge.** crux judges every move through one route, `POST /api/move`, using the tree, then the book, then a prover. **On defended 6×6 nothing but the rules or a lost play-out makes a rated miss**: a move without a proof is played out against native Syntaks, and a live `deep` search can only upgrade it to proven. That is SD's proposal A9 and CLEANUP's "Syntaks native (df-pn off 6×6)"; it is visible and needs Sasha's yes (V3). Off 6×6 the server runs `pns.js` with today's node budgets and today's rule. A timeout, crash, restart, full queue, dead engine or lost network never gives a rated miss. Play-outs end solved or not.
3. **Log.** One append-only record of every attempt: each ply including the defender's replies, what each verdict rested on, and ratings before and after with RD and volatility. An attempt's result is fixed by its first decisive ply. Refunds, re-judging and a nightly false-miss check run from it.

**Order.** Log, then book, then the judge in shadow (it never mints users or rates), then a narrow veto, then the server decides for new builds, then deletions. Nothing a player sees changes before gate G1. Every step before X1 rolls back by an environment change; after X1 a capability check stops a new client from talking to an old server.

**What it deletes, in the end.** About 4,400 lines gross, about 3,000 net (Part 2).

**What needs your yes.** Chiefly: play out every unproven 6×6 move (V3), 6×6 replies only from crux (V2), old-tab misses unrated (V4), how an abandoned play-out counts (V16), and refunds that also restore the puzzle (V18). Steps L1–C2 and U1 can start now (§5).

---

## Tags

- **[DOCS]**: quoted from CLEANUP, MINING, SOLVER, or the design page (`SD §n` = `docs/system-design.html`, untracked; `SD line n` = line of the text dump `.design.txt`).
  - [INF] That file is the "design page" the briefs used. Its §8.1 contains the "Stale comments" CLEANUP §1 asks to fix (SD line 1262). CLEANUP calls it `tinue-design.html`, so the name differs.
- **[CODE path:line]**: the repo at 3026736.
  - `public/` and `shared/` are unchanged at HEAD 6e79c6c.
  - `server/server.js` gained 21 lines at HEAD (`git diff --stat 3026736 HEAD`); lines after about 136 are **21 higher** at HEAD.
  - `[CODE db]` is a read-only count on lyra's `data/tinue.db`: 71,112 puzzles and 15 attempts. That is not crux.
  - `[CODE log]` is the copy `briefs/access.log` (11-08 07:18Z to 11-17 08:38Z).
  - `solver/deep/src/main.rs` is being edited by another worker; its line numbers move (at the time of writing `prove` is dispatched at :68 and the usage line is :78).
- **[INF]**: an inference, with its reason.
- **[PLAN]**: what this reconstruction prescribes. A PLAN line is itself an inference about what the lost plan should say.

---

## Decisions (where the drafts or the reviews disagreed)

| # | Question | Chosen | Rejected, and why |
|---|---|---|---|
| 1 | How moves reach the judge | **Every ply goes to `POST /api/move`, keyed by a client attempt nonce and `ply`** (delete draft). The client plays tree replies locally and does not wait on on-tree moves; it waits on off-tree moves (`judging`). Every ply carries the `rev` of the tree the client loaded. | Off-tree only with the line sent at the end (evidence): `report` persistence survives. Event batches (safety): same idea, more surface. Waiting on every move: a round trip on every on-tree reply. |
| 2 | What "log" means | **A server-side append-only attempt log.** The client "outbox" is the ordered queue of unacked plies, **kept in sessionStorage** keyed by attempt nonce and resent on load. Its pagehide flush (one `sendBeacon`) is the only pagehide hook left. | Memory-only outbox (revision 1): a solve played offline and then reloaded is lost, and a reload during `judging` is a free retry — today's held record prevents both [CODE app.js:41-69, 597-599, 793-807]. localStorage with heartbeats (safety): more than needed. |
| 3 | Log schema | **New tables `attempt`, `ply`, `rating_event`, `puzzle_rev`.** `attempts` stays as a projection written in the deciding transaction until P6, then becomes a view. | `ALTER TABLE attempts` plus `moves` (delete): repeat attempts would land in a table read as "first attempt only" [CODE server.js:249, 279, 626]. |
| 4 | Live 6×6 prover | **Book first; then live `deep prove q=1` at 2 s, which can only upgrade the move to a proven play-out. A disproof never rates on defended 6×6**: it goes on the miss card only. A background `deep prove` (about 60 s, nice) runs through every unproven play-out and raises the cap if it proves, as the browser's final check does today [CODE app.js:843-847, 896-900]. | Rated `deep q=1` disproof (revision 1): unsound — "a disproof through it can miss zugzwang" [DOCS SOLVER §4]; λ² disproof "assumes passing never helps … and allows one extra quiet move" [DOCS MINING]; disproofs get no checker [DOCS SOLVER §5 checks proofs]; and CLEANUP's after-state has no df-pn in a 6×6 rated result. Being about 19× faster than pns.js [DOCS MINING "90k nodes/s against 4.8k"], it would also finish disproofs today's browser leaves pending, so some of today's play-outs would become instant rated misses. |
| 5 | Off-6×6 prover location | **Server, `pns.js` in a child process, with today's node budgets** `[[3e4,2.5e4],[1e5,2.5e4]]` and up to 60 s final [CODE engine.js:51]. **This departs from CLEANUP §5** ("keep `pns.js` as the browser prover off 6×6") and is listed as V19. | Browser proves, server checks (CLEANUP §5; evidence draft): keeps two judging paths and a client-asserted 'no', against "With the server judging, an old client cannot produce a wrong rated result" [DOCS CLEANUP §3]. It is the fallback if Sasha says no to V19. |
| 6 | Book key and versions | Text key `"<board> <stm>\|<2·komi>"` built by one JS function; Rust producers are cross-checked against it (B1a). Rows insert-only, versioned, retired not deleted; no symmetry folding. A stronger-model row retires a weaker one. | Hash keys: old Zobrist keys had about 33 effective bits [DOCS SD §2.1]. Symmetry folding merges only 384 ids [DOCS SD §2.8]. |
| 7 | Book field in the puzzle payload | **No.** `alts`/`altsAt` stay in the payload only for old tabs, until X5. | A `book` field for offline book hits, which per-move judging does not use. |
| 8 | Old tabs | Narrow veto first (S5); at D1 legacy **misses** become unrated while wins still count; `/api/result` checks both `attempts` and `attempt`; new builds in decide mode never call `/api/result`. | Rated-if-refuted (evidence): more code for days. Refused after 14 days (delete): a free retry. |
| 9 | Abandonment | **Explicit acts only.** `left` comes only from `act:'leave'` sent by the page that owns the attempt (Next, or another puzzle in that page). `unload` comes only from `act:'unload'` in the outbox's pagehide beacon. Today's rated rules apply to those [CODE playon.js:37]. An attempt that just goes quiet expires after 30 min as `expired`, **unrated**. | Inferring `left` from `/api/next` (revision 1): the client already calls `/api/next?for=<current id>` mid-puzzle [CODE next.js:79; log 2026-11-15T19:53:21Z `GET /api/next?size=6&for=p867434`]. Rating expiry as `unload` (revision 1): a lost network or a locked phone would be charged, against I2. |
| 10 | Retry after a miss | **Keep `missed → play`** (V10). The attempt's result is already fixed by the miss; retry plays are logged and never rated. | Terminal `missed` (delete; CLEANUP's diagram). Most visible change. |
| 11 | Ordering | Safety's skeleton with gates G1 and G2: L → B → S → U → C → D → X → P. | Delete's cutover-first order: cannot roll back without a client redeploy. |
| 12 | Part numbering | Part 1 the redesigns and what they force; Part 2 the deletions. | Parts 1–3 as book, judge, log: "The plan's part 2 lists the deletions" [DOCS CLEANUP §6] would point at the judge. |
| 13 | Picker and daily | Read `status`/`kind`; keep stage 2 over `reserve`; keep REFUNDED (Sasha's 2026-11-16 call, "we should down prio it" [CODE server.js:223]). Removing FLAW/CONVERT/UNSCORED is CLEANUP §2's "minus the removed terms" and is visible (V13). | Dropping everything silently. |
| 14 | 7×7/8×8 judging | Server `pns` with `pending` for up to 60 s, as today [CODE app.js:626-637]. | Unserving 7×7/8×8 (V12). |
| 15 | Which attempt counts | **First decided result**, as today [CODE server.js:625-627]. `first` is assigned in the deciding transaction, guarded by unique indexes on `attempts(user_id, puzzle_id)` and `attempt(user_id, puzzle_id) WHERE first = 1`. | "First attempt opened" (revision 1): a silent change to Sasha's "first result counts". |

---

## Rated-result safety (binding on every step)

**F-list: how a real win can become a rated miss today.**

| # | Channel | Evidence |
|---|---|---|
| F1 | The still-wins check returns `'no'` when no **Tak-threat** win exists, and that `'no'` is a rated miss. | [CODE engine-worker.js:70-73, 86-88]. [DOCS SD §8.1] "A live 'no' is a rated miss though the check is threat-only". |
| F2 | Deep trees and `alts` are threat-model lists, so a quiet win at a non-root node reaches only F1. | [DOCS SD §8.1] "Threat-only deep trees past R ≥ 7"; pd575074 `4c3+` (SD line 843) |
| F3 | Off 6×6 there is no play-out, so a `'no'` goes straight to a rated miss. | [CODE app.js:620-651; playon.js:34-37] |
| F4 | The server trusts `win` and `casual`. The only guard is the build floor for misses. | [CODE server.js:614, 631-632] |
| F5 | Nothing re-judges after the fact, and refunds are manual and partial. | [DOCS SD §8.1] "Not built: server-side async proof with automatic refund"; SD line 734 "The scripts never touch the puzzles table" |

**By design and stay** [DOCS SD §8.2 "Rated miss when defended."; CODE playon.js:37, 55-101]: failing to convert within the cap against Syntaks, and Give up, Solution or leaving mid-game when Syntaks has defended.

**Invariants** [PLAN]:
- **I1. Evidence.** A rated miss needs one of:
  - `rules`: the move ended the game without a win for the player;
  - `playout`: a play-out lost under `lossRated` (`why` ∈ `out`, `refuted`, `road`, `defended`, `gaveup`, `left`, `unload`), where `left`/`unload` come only from an explicit act ply;
  - `view`: Solution shown; `giveup`;
  - off 6×6 only: `refuted-full` (a completed disproof whose model is `full`), or **`refuted-threat`**, today's threat-only `'no'` kept unchanged until Sasha answers Q3. It is a known exception (F1/F3) and is re-judged nightly (I5).
  The nightly audit A6 counts rated misses without one of these and expects 0.
- **I2. Failure is not evidence.** Timeout, budget, 503/429, crash, OOM, restart, a full queue, an illegal engine move, an unknown book version, a rev mismatch, a lost network or an expiry all mean `undecided`. `undecided` leads to a play-out where a rated defender exists, otherwise to an unrated result. This extends "A timeout is never a 'no'" [CODE engine.js:47].
- **I3. Never more misses until G2.** Until G2 the server may only turn a rated miss into unrated or solved. Concretely: 6×6 disproofs never rate (Decision 4); off 6×6 the server pns uses the browser's node budgets, so it completes the same disproofs the browser would [INF: pns.js is deterministic for a given position and node budget; the wall clock only cuts it short]; until D2, a client-run play-out's ending is accepted as today (legality-checked, wins trusted as today: the residual F4 window is documented, not new).
- **I4. Reproducible.** Every verdict records the puzzle rev, book version, prover build and budget, and the defender's replies.
- **I5. Re-judged.** Every rated miss with evidence `refuted-*`, or `playout` on a move that was never proven, is re-judged within 24 h at a larger budget. A proof turns it into a refund proposal.
- **I6. Fixed once.** An attempt's result is set once, by the earliest ply (in ply order) with a decisive verdict. A `pending` ply blocks every later ply from deciding; its final verdict decides as of that ply (wins → solved; `'no'` → missed; unknown → missed **unrated**). Later plies are logged and never rated. Hint status is taken as of the deciding ply [CODE app.js:630-631 `flags: { hinted: S.hinted }` at the miss].

---

## Part 1 · The three redesigns

### 1.1 Book [PLAN unless tagged]

**What it is.** "Emit tinue's tree format and `book` rows: position after the move, `win_len`" [DOCS MINING, changes to `deep cert`, item 5]. Puzzle state becomes "`kind`, `grade`, `status`, `book`" [DOCS CLEANUP table]. A row says: after this attacker move, with the defender to move, the attacker has a forced win of `win_len` plies (`checked` says whether a checker confirmed it). Wins only.

**Key.** `pos = "<TPS board> <side to move>|<2·komi>"` with the move number dropped, built by `bookKey(game, komi)` in `shared/book.js` on `Game.toTPS()` [CODE shared/tak.js:98]. JS callers use it directly. `deep` is Rust and has its own TPS writer and move notation [CODE solver/deep/src/main.rs: input lines are `tps|halfkomi`]; B1a cross-checks it.
- It is a position, not a move path, so transpositions hit. Today's `altsAt` is keyed by the moves played [CODE server.js:201-203].
- Komi is in the key because flat wins depend on it [INF].

**`win_len`.** Plies left from `pos`, defender to move, including the attacker's last ply. A puzzle's `plies` = 1 + its key's `win_len` (SOLVER "AND minWin = 1 + max(children's, 1)" [DOCS SOLVER §4]; tree format d('win') = 1 [DOCS SD §3.0]). NULL = length unknown; the cap then uses the unknown-length rule (§1.2).

```sql
CREATE TABLE book (
  pos         TEXT    NOT NULL,   -- bookKey: position after the attacker's move, defender to move
  ver         INTEGER NOT NULL,   -- book version that added it (one per publish)
  win_len     INTEGER,            -- NULL = length unknown
  exact       INTEGER NOT NULL,   -- 1: the disproof at win_len-2 finished (MINING "mark it exact: false if …")
  model       TEXT    NOT NULL,   -- what the length is exact under: full | threat | threat+1quiet
  proof       TEXT    NOT NULL,   -- tree | alt | deep-cert | live-deep | live-pns | rejudge
  checked     INTEGER NOT NULL,   -- 1: SOLVER §5 checker or tak.js fullDefense replayed it
  puzzle_id   TEXT,               -- producer (provenance only)
  commit      TEXT    NOT NULL,   -- CLEANUP §1 "Write the commit sha into each output row"
  ts          INTEGER NOT NULL,
  retired_ver INTEGER,            -- set instead of DELETE
  PRIMARY KEY (pos, ver)
) WITHOUT ROWID;
CREATE TABLE book_node (          -- attacker nodes whose every legal move was classified
  pos     TEXT NOT NULL, ver INTEGER NOT NULL,
  moves   TEXT NOT NULL,          -- JSON {move(canon): 'key'|'win'|'refuted'|'undecided'} — every legal move, explicitly
  model   TEXT NOT NULL,          -- full | threat | threat+1quiet
  puzzle_id TEXT, commit TEXT NOT NULL, retired_ver INTEGER,
  PRIMARY KEY (pos, ver)
) WITHOUT ROWID;
CREATE TABLE book_ver (ver INTEGER PRIMARY KEY, ts INTEGER NOT NULL, commit TEXT NOT NULL,
  added INTEGER, retired INTEGER, note TEXT);
```

**Lookups.** Newest unretired row with `ver ≤ TINUE_BOOK_VER`. Rolling back lowers the pointer.

**Insert rules.**
- Within one model, a second live row for a `pos` with a different `win_len` fails the publish when the two lengths cannot both be right: both `exact = 1`, or an `exact = 1` length above an `exact = 0` one (0 such conflicts across 496,036 tree positions in the DB [CODE db, map-state §6.4]). Two `exact = 0` lengths are both upper bounds: the shorter is kept (the checked one if equal) and the change is listed.
- A row with a stronger model (`full` > `threat+1quiet` > `threat`) or `exact = 1` retires a weaker row for the same `pos` without failing the publish. Every length change is listed for review, because it changes the play-out cap. This is needed for quiet-faster puzzles: SD lists pd575074 9→7, pd424243 9→7, pd816821 13→11 [DOCS SD line 1243 "pulled to D for faster quiet wins"].
- A publish that would retire the book row of a position the tree still lists as a key is refused.
- `checked = 0` rows may be stored, but only with `exact = 0` (an `exact = 1` row must be `checked = 1`; the publish refuses others). A wrong win row gives a false **solve**, never a miss [INF]. For the cap, `exact = 0` counts as length unknown, so only a checked length can shorten it.

**`book_node` (coverage).** Stored only from a **non-strict** classification of every legal move. A strict run "stop[s] when a second idea wins at R >= 7" [DOCS SOLVER §6], so moves it never reached would look refuted; MINING's stage A is `lite=1 strict=1` [DOCS MINING]. Refuted moves are listed explicitly; a move missing from `moves` is never inferred refuted. Uses:
- the miss card's refutation, and the picker's FLAW term (P4);
- off 6×6, a short-circuit miss **only** when `model = 'full'` (`refuted-full`); otherwise the judge runs pns as today;
- on defended 6×6, never a rated miss (Decision 4).

**Contents and size.**

| Set | Rows | Source |
|---|---|---|
| Served tree-key positions | 69,226 (6×6: 20,246) | [CODE db, map-state §6.4] |
| Served `alts` + `altsAt` positions | 6,680 (6×6: 2,459), no length | same |
| Total book v1 | 75,906 | same |
| Served attacker nodes to cover | 6×6 28,850 (4.1 M legal moves); 5×5 68,386; 4×4 427 | [CODE db, evidence draft `.ev/nodes.mjs`] |

- Size about 8–15 MB [INF]. 1-ply puzzles add no rows. 7×7/8×8 tree rows are loaded too, because stage 2 serves them [CODE server.js:239-243].
- Coverage cost is unknown until B4 measures it; MINING's stage B runs 20–170 s per line [DOCS MINING stage table], and crux's disk is 95% full [DOCS MINING Setup].

**Writers.**
1. `scripts/book-init.mjs`, run once **against a pulled copy of crux's DB** (crux holds hand-fixed trees: SD line 686, pd575074 updated in place). It loads tree keys (`proof='tree'`, length = 1 + depth) and **every alt served today**. Each alt is re-proved (`deep up` on 6×6, `TinueSearch` with `fullDefense` elsewhere): success → `checked=1` with length; failure → `checked=0, proof='alt'`, kept. Only decided-bad alts are left out, through a tracked exclusion list: today ps505288's `c4-`, which "could not be proved to win" [CODE db, grade-overrides via map-state §4]. Re-proof failures go to Sasha as a diff; nothing is removed silently. (71 hand-reviewed alt changes exist [DOCS SD line 404].)
2. The verifier, `deep cert` (in flight, 6×6): keys, slower and quiet wins, exact lengths, `book_node`, `checked=1` [DOCS CLEANUP §4 "One verifier … owns keys, cooks, faster wins and `status`"].
3. The judge at play time: `live-deep`/`live-pns`, inserted only after the checker passes.
4. `scripts/rejudge.mjs`: proofs found while re-judging.

**Publishing.** Book rows ride on the in-flight `publish-puzzles` step: "ships only new or changed rows, in one transaction, after an automatic snapshot" [DOCS CLEANUP §3]. Each publish writes one `book_ver` row and bumps `puzzles.rev` for changed puzzles (column added at L1).

**What it replaces.**

| Today | Where | Replaced at |
|---|---|---|
| `swing.alts`, `altsAt`, `slowerWins()` | [CODE server.js:204-207; app.js:1072-1075] | X1 (client), X5 (payload) |
| `S.proven`, `S.proofPlies`, `provenKey` | [CODE app.js:587, 615-616, 1079] | X1 |
| proof-length worker, `setProofLength`, `capWait('length')` | [CODE app.js:896-912; playon.js:133-138] | X2 |
| `flaw = 1` | [CODE import.mjs:101-102] | P4 |

### 1.2 Judge [PLAN unless tagged]

**One function.** `judge(attempt, ply, inputs) → answer` in `shared/judge.js`; pure (no I/O, no clock). `server/judge-io.js` supplies book reads, the prover pool and Syntaks. Table-tested; any logged attempt can be re-run (I4).

These move from `public/playon.js` unchanged: `capMoves`, `provenCap`, `proofMoves`, `defender`, `gameRated`, `winRated`, `lossRated`, `lossWhy`, `stalls`, `STALL_MS` [CODE playon.js:8-37, 55-101]. `playon.js` re-exports them until X2.

**Who defends**: `size === 6 && |komi| ≤ 3.5 && 2·komi integer` [CODE playon.js:35].

**Judged against.** The `rev` the client sends. A ply judged against a `puzzle_rev` the client did not load is impossible by construction. If the server's answer contradicts what the client already showed for that rev (`clientVerdict`), the attempt is closed **unrated** (`unrated_why='client-disagree'`) and an alert is logged; never a miss.

**Contract (first match wins; I6 decides which ply's verdict fixes the result).**

| # | State and input | Answer | Rated? | Evidence |
|---|---|---|---|---|
| 1 | `play`, move is a key at the node (for that rev) | `ok` + stored reply (`solved` if the line ends) | solved: rated if this attempt is the first decided and not hinted as of this ply | `tree` |
| 2 | any move that wins the game for the player | `solved` | as row 1 | `rules` |
| 3 | any move that ends the game without a win for the player (loss or draw) | `missed` | rated | `rules` [CODE app.js:557-560, 586] |
| 4 | off-tree, `book` row, defended | `play`, proven, cap = `provenCap(left, win_len)`; NULL/inexact → `capMoves(left)` with the unknown-length rule | play-out table | `book {pos, ver, win_len, checked}` |
| 5 | off-tree, `book` row, not defended | `solved` on the spot | rated | `book` |
| 6 | off-tree, defended, live `deep prove q=1` (2 s) proves and the checker passes | as row 4; inserts `live-deep` | as row 4 | `prover {deep@sha, q, nodes, ms}` |
| 7 | off-tree, defended, anything else (disproof, budget, queue, crash, binary missing, rev unknown) | `play`, unproven, cap = `capMoves(left)`; a background `deep prove` runs (Decision 4); a disproof or `book_node` refutation is kept for the card only | play-out table | `undecided {reason}` / `refutation {src}` |
| 8 | off-tree, not defended, covered `book_node` with `model='full'` lists the move `refuted` | `missed` | rated (`refuted-full`) | `node {pos, ver}` |
| 9 | off-tree, not defended, live `pns` quick proves with `fullDefense` | `solved` | rated | `prover {pns, …}` |
| 10 | off-tree, not defended, `pns` completes a threat-only `'no'` within today's node budget | `missed` | rated (`refuted-threat`; Q3) | `prover` |
| 11 | off-tree, not defended, `pns` pending | `pending`. The client may run today's unrated Tiltak play-on (Q4). The final search runs up to 60 s; I6 applies: wins → `solved` rated; `'no'` → `missed` rated unless an unrated Tiltak game already ended it (unrated, as today); unknown → missed **unrated** | as stated | `prover` |
| 12 | `act: hint` | `hint` target; the attempt becomes casual **from this ply on** | a result decided later is unrated | `act` |
| 13 | `act: view` (Solution) | `missed` | rated unless hinted earlier | `view` |
| 14 | `act: leave` / `act: unload` | ends a play-out per the play-out table; outside a play-out, closes an undecided attempt unrated (`left`) | per table | `act` |
| 15 | attempt not first, or puzzle `status ∈ paused, rejected` (from P3) | judged normally, never rated | unrated | `repeat` / `paused` |

Rows 1–3 follow [CODE app.js:557-560, 586]. Rows 5 and 9 follow [DOCS SD §8.2] "On 4×4 and 5×5 a proven win stays solved on the spot, as today" and [CODE app.js:624]. Rows 10–11 follow [CODE app.js:613-651, 729-765, 1025-1062].

**Play-out, run on crux** (D2). The `play` answer carries Syntaks's first reply; each player ply is a `/api/move` call whose answer carries the next reply or the ending. The game is rebuilt from `ply` rows [INF: Syntaks cache is memory only, CODE syntaks.js:23]. Pool: POOL = 2, MOVETIME 1200, priority queue 4 [CODE syntaks.js:16]. Two endings [DOCS CLEANUP "2: solved or not"]; the reason goes to the log as `why`; the rated rules are today's [CODE playon.js:37, 55-101]:

| Ending (`why`) | Result | Rated? |
|---|---|---|
| player's road or flat win (`win`) | solved | `winRated` |
| a proof lands mid-game, from the background `deep` or pns (`proved`) | solved | rated |
| proven play-out, Syntaks gives no legal reply after a retry and 20 s (`proved`) | solved | rated [CODE app.js:956] |
| cap reached, or Syntaks's road, flats or draw (`out`, `road`, `defended`) | not | `lossRated`; proven with unknown length at `out` → unrated [CODE playon.js:37] |
| Tak rule, not proven, the check of the move played out answers `'no'` mid-game (`refuted`; F2, Sasha 2026-11-21) | not | `lossRated`, as `out`. The browser and the shadow judge each end on their own check's `'no'`, so the ply they end at can differ; the browser sends no act for it (as for `out`), and c2-report counts it off-tree |
| unproven at the cap while the background proof still runs | wait up to 20 s (today's `capWait('proof')` [CODE playon.js:133-137]); a proof raises the cap via `provenCap` | — |
| Give up / Solution (`gaveup`) | not | `lossRated`; **stalled → unrated** if, when the act arrived, a defender reply was owed and not yet shown: the act carries `seen` (index of the last reply shown); owed time counts from the server's receipt of the player's ply, so transit and restarts count as owed [CODE playon.js:47, 97-101] |
| `act: leave` (`left`) | not | `lossRated`, stall rule as above |
| `act: unload` from the pagehide beacon (`unload`) | not | today's rule: proven → unrated, unproven → `lossRated` [CODE playon.js:37] |
| no ply and no act for 30 min (`expired`) | not | **unrated** (V16) |
| unproven, Syntaks unavailable (`noengine`) | not | unrated; a proof still makes it a solve [CODE app.js:970] |

`resign` is dropped: `RESIGN_UNPROVEN = false` makes it unreachable [CODE playon.js:85-86].

**API.**
```
POST /api/move  {puzzleId, rev, nonce, ply, move? | act?: 'hint'|'view'|'giveup'|'leave'|'unload', seen?, clientVerdict?, ms, theme?, b}
 → {attempt, ply, verdict: 'ok'|'solved'|'missed'|'play'|'reply'|'pending'|'hint',
    reply?, cap?, proven?, refutation?, why?, rated?, userDelta?, user?, puzzleRating?, token?, next?}
GET  /api/attempt?nonce=<n>  → plies and state (resume after reload; poll while `pending`)
```
- **Identity.** The client makes a random `nonce` per page and puzzle load and sends it on every ply. Idempotency is on `(nonce, ply)`. Guest minting is idempotent per nonce: a retry of a ply that minted gets the same token. Until it holds a token, the client sends one ply at a time.
- **Replays and conflicts.** A replay with the same semantic fields (`move` or `act`) returns the stored answer; timing fields (`ms`, `client_ms`) are ignored. A different move or act for a stored ply is logged and answered with the stored answer. Only an **undecided** attempt can become `conflict` (unrated); a decided attempt never changes.
- **Serialised per attempt** with an in-memory promise chain. The deciding transaction is synchronous and writes `attempt`, the `attempts` projection and the rating together [CODE server.js:637-644].
- **Guests.** In decide mode, the first ply without a token mints through `newGuest` under the 10/h/IP limit [CODE server.js:620-622]. In shadow mode `/api/move` **never mints** and writes rows only for existing users.
- **First result counts** (Decision 15). `first` is set when the attempt decides, if no `attempts` row and no first `attempt` exists for (user, puzzle).
- **`theme`** is checked against the puzzle's own themes (today any valid key gets the weight [CODE server.js:633]); visible to ratings, V20.
- **Transport.** Plies go as `text/plain` JSON to avoid a CORS preflight per ply; the server also sends `Access-Control-Max-Age: 7200` [DOCS CLEANUP §2].
- **`/api/puzzle/:id` stays pure** (iOS, §3.2). `/api/next` advertises `judge: <protocol version>`; a client without it shows a blocking "update in progress" notice instead of guessing (after X1).

**Restarts.** On startup the server re-queues every ply in `judging`/`pending` with its remaining budget, and restarts the background proof of each open unproven play-out. A ply that cannot be re-run resolves `undecided` → unrated (I2). Tested in D1.

**Prover pool** (`server/prover.js`, modelled on `server/syntaks.js` [CODE syntaks.js:14-28]).

| Knob | 6×6 `deep` | other sizes `pns.js` child |
|---|---|---|
| processes | 1 interactive + 1 background (nice) | 1 |
| interface | needs a `deep serve` stdin mode (request to the solver worker; the crate is file-driven today [CODE main.rs usage line]) | child process, JSON lines |
| memory | `lp=22` (about 750 MB [DOCS MINING "pass `lp=22` for half that"]) | `--max-old-space-size=1024` [CODE engine.js:49] |
| quick | 2 s wall, `q=1 b2=20000`; proofs only | today's node budgets [CODE engine.js:51] |
| background | up to 60 s per unproven play-out, `taskpolicy -b nice` | up to 60 s, rows 11 only |
| queue | 4; full → `undecided{queue}` | 3; full → `undecided{queue}` |
| checker | every proof [DOCS SOLVER §5] | `fullDefense` as today [CODE engine-worker.js:92-94] |

A crash, kill or OOM resolves to `undecided{crash|oom|killed}`.

### 1.3 Log [PLAN unless tagged]

**Reading.** "crux owns puzzles, book and attempts" [DOCS CLEANUP §3]. CLEANUP's "Keep as is" lists "the access log's privacy scheme" [DOCS] — the scheme, not the access log itself — so "log" could in principle mean the access log; [INF] the attempt-ledger reading is chosen because the existing per-attempt `log` column (`log TEXT -- JSON [{m, ms, k}]` [CODE server.js:50]) is the likeliest referent and because refunds and re-judging need it. Its client half is CLEANUP's "One outbox replaces held records, the Web Lock and `pagehide` sends" [DOCS CLEANUP §6].

**Why it is needed** [CODE]:
- Rows do not store RD/vol before and after, the theme weight, or guest status [CODE server.js:45-50, 633-642].
- Defender replies are not logged; only the player's `po` moves are [CODE app.js:993].
- `tree` is overwritten on every import and `swing` by `setTurn` [CODE import.mjs:108-112, 134], so "judged against what?" cannot be answered.

```sql
-- L1 also adds: ALTER TABLE puzzles ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
CREATE TABLE attempt (
  id          INTEGER PRIMARY KEY,
  nonce       TEXT NOT NULL UNIQUE,
  user_id     INTEGER, puzzle_id TEXT NOT NULL,     -- user_id NULL only for shadow rows of unknown users (not written)
  first       INTEGER NOT NULL DEFAULT 0,           -- set in the deciding transaction
  guest       INTEGER,
  puzzle_rev  INTEGER NOT NULL DEFAULT 0, book_ver INTEGER NOT NULL DEFAULT 0,
  build       INTEGER, commit TEXT NOT NULL,
  mode        TEXT NOT NULL,                        -- legacy | shadow | decide
  theme       TEXT, weight REAL,
  opened      INTEGER NOT NULL, closed INTEGER, ms INTEGER,
  state       TEXT NOT NULL,                        -- open | judging | pending | playout | closed | conflict
  decided_ply INTEGER,                              -- I6
  result      INTEGER,                              -- 1 solved, 0 not
  why         TEXT,                                 -- tree|book|proof|rules|refuted-full|refuted-threat|view|giveup|win|proved|out|refuted|road|defended|left|unload|expired|noengine
  rated       INTEGER NOT NULL DEFAULT 0,
  unrated_why TEXT                                  -- hint|repeat|undecided|noengine|stalled|tiltak|proven-unload|proven-length|legacy|paused|conflict|expired|client-disagree
);
CREATE UNIQUE INDEX attempt_first ON attempt(user_id, puzzle_id) WHERE first = 1;
CREATE TABLE ply (attempt_id INTEGER NOT NULL, n INTEGER NOT NULL, by TEXT NOT NULL,  -- p | d | a
  move TEXT, src TEXT NOT NULL, verdict TEXT, evidence TEXT, cap INTEGER, ts INTEGER NOT NULL, client_ms INTEGER,
  answer TEXT, PRIMARY KEY (attempt_id, n)) WITHOUT ROWID;
CREATE TABLE rating_event (id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                     -- rate | refund | rejudge
  ts INTEGER NOT NULL, by TEXT NOT NULL, weight REAL NOT NULL,
  user_before TEXT, user_after TEXT,      -- JSON {rating, rd, vol, games, wins}
  puzzle_before TEXT, puzzle_after TEXT,  -- JSON {rating, rd, vol, attempts, solves}
  note TEXT);
CREATE TABLE puzzle_rev (id TEXT NOT NULL, rev INTEGER NOT NULL, tree TEXT NOT NULL, komi REAL, tps TEXT,
  ts INTEGER NOT NULL, PRIMARY KEY (id, rev)) WITHOUT ROWID;
```

**Rules.**
- **Unique `attempts`.** CLEANUP §1 asks for "A unique index on `(user_id, puzzle_id)`" [DOCS]. Today's index is not unique [CODE server.js:51]; lyra's copy already has 1 duplicate pair [CODE db]. L1 counts duplicates on crux first and lists them for Sasha; the index lands only when the count is 0 or each is resolved.
- `attempts` is written in the deciding transaction for the first decided attempt only. History, `PLAYED`, `UNPLAYED`, `REFUND_MARK` are unchanged. It becomes a view at P6 [CODE server.js:249, 279; import.mjs:151-153].
- **Log writes never roll back a rating.** In L2 (legacy path) the log rows are written in a SAVEPOINT inside `/api/result`'s transaction; a log error releases to the savepoint and the rating commits. Tested with a forced insert failure.
- **Replay.** Applying `rating_event` in id order reproduces `users` and `puzzles` for every post-L2 attempt (A8).
- **Refunds.** `scripts/refund.mjs`, dry-run by default. It appends a `refund` event, replays **only the refunded user's own chain**, and treats the puzzle as one compensating event (its rating, attempts and solves restored by the attempt's own delta). Other users' past results are never rewritten. It refuses an attempt that already has a `refund` event or the legacy signature (`rated = 0` with `user_delta ≠ 0`). Until P4 it also writes that legacy signature so `REFUND_MARK` keeps firing [CODE import.mjs:151-152]. Restoring the puzzle is new (today's scripts never touch it [DOCS SD line 734]) and is V18. It replaces `crux:~/tinue-alts/refund*.mjs` once L3 lands; from then the old scripts are not run.
- **Re-judging.** `scripts/rejudge.mjs` nightly at `taskpolicy -b nice`: every rated miss with evidence `refuted-*`, or `playout` on a never-proven move, at 60 s `deep q=1` (6×6) or `pns` (others) against the logged plies and the newest book. A proof inserts a `rejudge` book row and a refund **proposal** (Q8). This is SD's "server-side async proof with automatic refund" [DOCS SD §8.1].
- **Privacy.** `user_id` only: no IP, gid, token or user agent (`user_id` is already in the access log [CODE server.js:744]). A gid must never enter it [CODE server.js:159-163]. The access log's scheme is unchanged.
- **Retention.** Rated attempts kept as long as ratings exist; plies of unrated attempts that never closed deleted after 180 days. About 150 attempts a day from 1,375 result POSTs in 9 days [CODE log]; under 100 MB a year [INF].

**Client delivery** (the "outbox").
- An ordered queue of unacked `{nonce, ply, body}` in **sessionStorage**, resent on load (safe: idempotent on `(nonce, ply)`). A pending off-tree ply is in it, so a reload during `judging` resends that move and is not a free retry.
- Retries with backoff (1, 2, 4 … 30 s) while visible, and on `online` and `visibilitychange`.
- On-tree plies are queued and the board moves on. An off-tree ply waits in `judging`, "Checking…" after 300 ms, "Can't reach the server, retrying" after 3 s.
- On `pagehide` the outbox sends one `navigator.sendBeacon` with its unacked plies and, during a play-out, `act:'unload'`. This is the one remaining pagehide hook, owned by the outbox.
- Every storage access is wrapped in try/catch; without storage it degrades to memory-only.
- A failed result POST is lost today [CODE app.js:695, 717; api.js:53]; under this design it is retried until acked.

### 1.4 Puzzle state: `kind, grade, status, book` [PLAN unless tagged]

| New | From | Rule |
|---|---|---|
| `kind` | `turn` 1/0/NULL [CODE server.js:40] | `turning`/`conversion`/`unscored`: 20,021 / 49,602 / 1,489 [CODE db]. Bots keep a derived `turn` [CODE server.js:307] |
| `pre0` | `swing.pre0` | own column; the caption reads it [CODE app.js:1568] |
| `grade` | unchanged | overrides applied last [CODE import.mjs:136-144] |
| `status` | `SERVED` predicate [CODE server.js:236] | `served` iff `turn = 1 OR grade = 'A'` (26,478 [CODE db]); `paused` for the `hold-20261116` overrides; otherwise `reserve`. `rejected` only by the verifier with Sasha's diff approved |
| `book` | tree keys + `alts`/`altsAt` | §1.1; `puzzles.book` = sha256 of the puzzle's slice |
| `miner` | id prefix | CLEANUP's `source` tag [DOCS §4]; `source` already holds `'PlayTak'` [CODE db] |
| `rev` | — | added at L1 (default 0); bumped by `publish-puzzles`; old tree to `puzzle_rev` |
| dropped at P6 | `turn`, `swing`, `flaw` | 30 days after the last reader moves, after a snapshot |

- The picker keeps stage 2 over `reserve` [CODE server.js:239-243]; without it 7×7/8×8 (1,481 rows, 0 served [CODE db]) go empty.
- `FLAW` (+100) is derived from the book (P4) and `REFUNDED` (+400) from unresolved refund events; REFUNDED is Sasha's decision [CODE server.js:221-226]. Removing FLAW, CONVERT and UNSCORED ("minus the removed terms" [DOCS CLEANUP §2]) is V13.

### 1.5 Offline pipeline: mine → verify → grade → import [DOCS CLEANUP table, §4]

| Stage | 6×6 | Other sizes |
|---|---|---|
| mine | MINING stage 0 / one forward scanner (in flight) | none: "Leave existing 5×5 labels frozen" [DOCS CLEANUP §4] |
| verify | `deep cert` with MINING's changes 1-5, non-strict for `book_node` | `scripts/verify-pns.mjs` over served 4×4/5×5 (threat model; feeds cards and FLAW, never a short-circuit miss) |
| grade | one `grade.py` reading cook and decoy counts [DOCS CLEANUP §4] | frozen |
| import | `publish-puzzles` writes puzzles + book + `puzzle_rev` in one transaction; never touches rating/rd/vol/attempts/solves of played rows [CODE import.mjs:112] | same |

- Verifier rejections never apply themselves; they become a diff for Sasha [DOCS CLEANUP "Done when"].
- **Hand fixes.** Before P5, the overrides file is extended from grades [CODE import.mjs:136-144] to tree patches, and every crux-edited row is captured into it: the 13 tree extensions, the 18 syn6 ply fixes, pd575074's added key `6e3+15` [DOCS SD line 843]. Until then the in-flight `publish-puzzles` rule that holds crux-edited rows stays [deploy worktree b18a643 "publish --all no longer ships a held row"].
- MINING's hard collection is imported as `status = 'reserve'` plus a collection tag, unrated until Sasha decides. "Silver is only fair once off-tree wins are played out" [DOCS MINING], true only after D2.

### 1.6 Client state machine [PLAN unless tagged]

CLEANUP §6's machine [DOCS] plus two flagged edges:

```
loading → intro → play ⇄ reply → solved → review
                   │                missed → play      (retry, unrated; kept unless V10)
                   │                missed → review
                   └→ judging → solved                  (off 6×6 proven: SD §8.2 "stays solved on the spot")
                              → missed                  (rules; off 6×6 refutation)
                              → pending → solved | missed (pns running, 4×4–8×8)
                              → playout ⇄ reply → solved | missed
```

- One file, `public/puzzle.js`, `step(state, event) → state'`, with `scripts/test-puzzle.mjs` asserting every pair (built unwired at U1).
- Late answers: if the server answers `missed` or `client-disagree` for a ply the client already showed as correct, the client shows the server's card and marks the result "not rated" (the server already recorded it unrated, §1.2).
- **One input lock, `busyUntil`**, same durations [DOCS CLEANUP §6; CODE app.js:493-510, 650, 1687]; per input class. The Enter path gains the 600 ms guard it lacks [CODE app.js:1720].
- **Review**, "one engine a size and no fallbacks" [DOCS CLEANUP §6]: visible (V14).
- **`#checkBuild`** shrinks to one check between puzzles [DOCS CLEANUP §3] only after X4.

---

## Part 2 · Deletions, by file and function

Lines are at 3026736. "→" means moved. Each row lands at the step named in §3.

| File | Deleted | Lines | Replaced by | Step |
|---|---|---|---|---|
| public/app.js | `pageId`, `owner`, `pageLock`, `heldRec`, `ownHeld`, `pageAlive` | 41-80 | nonce + outbox | X1a |
| public/app.js | `reporting`, `uploading`, `authEpoch` | 95-104 | — | X1a |
| public/app.js | off-tree pipeline in `userMove`: `provenKey`, `S.proven`, `S.proofPlies`, `slowerWins`, quick check, major/minor split, held miss, `engine.refute` | 583-651 → about 15 lines | judge | X1b |
| public/app.js | `report`, `settleCheck`, `abandonCheck`, `abandonQuick`, pagehide listener, `flushHeld` | 674-807 | `/api/move` answers; outbox beacon | X1a |
| public/app.js | `fail`, `provenKey`, `slowSolve` (display stays as `judging → solved`) | 1077-1079, 1093-1101 | judge verdict | X1b |
| public/app.js | defender chain: `playOnDefender` … `restoreLeft` | 820-1070 → about 60 lines | server play-out | X2a (V2) |
| public/app.js | `FRESH_MS`, `fresh`, `wakeActions`, `TOO_SOON_MS`, `tooSoon`, `justViewed`, 700 ms / 1500 ms checks | 493-510, 650, 1687 | `busyUntil` | X3 |
| public/app.js | build interval, visibility check, bar logic, reload deferral | 240-263, 308-314 | one check in `loadNext` | X4 |
| public/app.js | card variants for checking, held, resend, notCounted, play-on reasons | about 65 in 1405-1539 [map-client] | one card per ending + `why` | X1b, X2a |
| public/app.js | `runTiltak`/`runSolver` as 6×6 fallbacks | 375-402 (branches) | one engine a size | X7 (V14) |
| public/playon.js | rules | 8-37, 55-101 | → `shared/judge.js` (S1) | X2b |
| public/playon.js | `resigns`, `RESIGN_UNPROVEN`, `mayResign` | 43, 82-86 | — | X0 |
| public/playon.js | `heldResend` … `answerOwnsToken`; file empty | 103-154 | log, judge | X1a, X2b |
| public/engine.js | `checkStill`, `proofLength`; whole file once review needs no solver on 6×6 | 45-81 | server prover | X1b, X2b |
| public/engine-worker.js | `'still'`, `'length'`, `'refute'` handlers | 66-132 | server prover | X1b, X2b |
| public/syntaks.js, syntaks/worker.js, wasm/syntaks/*, 19.5 MB wasm | whole | 70 + 108 + 302 | crux Syntaks | X2c, only with V2 |
| public/next.js, `for=`/`n=`, test-next*.mjs | whole | 115 + 18 + 490 | `next` in the answer | X6, only if A7 holds and the log shows 7 idle days of `for=`/`n=` |
| server/server.js | `MIN_MISS_BUILD`, trust in `win`/`casual` | 19-21, 628-632 | judge | X4 |
| server/server.js | `POST /api/result` | 612-647 | `/api/move` | X8 |
| server/server.js | `GET /api/defend` | 697-702 | attempt-bound play-out | X2c |
| server/server.js | `swingPublic` `alts`/`altsAt` | 201-207 | book | X5 |
| server/server.js | `SERVED`, `flaw` reads | 220-237, 280-285 | `status`, derived fields | P2, P4 |
| scripts/import.mjs | sidecar selection, supersession guard, `setTurn`/`flawOf`, grades file, `REFUND_MARK` | 53-134, 148-153 | `publish-puzzles` | P5b |
| scripts/ | `score-swing.mjs`, `mine-swing.mjs`, `mine-deep.mjs`, `shared/deep.js`, `scripts/grade/*` except `grade.py`, `rerate.mjs`, `bench-pns.mjs` | about 1,860 | verify, replay | P5b (some archived in flight: 076b41d, 8a7fb55) |
| scripts/test-playon.mjs, test-syntaks-wasm.mjs | held/resend/WASM cases | 251 + 47 | test-judge, test-puzzle | X1a, X2c |
| crux `~/tinue-alts/refund*.mjs` | manual refunds | not in repo | `scripts/refund.mjs` | L3 |
| DB | `puzzles.turn`, `swing`, `flaw`; `attempts` → view | — | new columns; `attempt` | P6 |

Totals [INF, delete draft counts]: about 4,400 lines removed, about 1,350 added (judge 220, prover 170, route 120, puzzle.js 200, outbox 60, scripts 240, tests 450), net about −3,000. Without V2 and A7, about −2,000.

---

## Part 3 · Migration order

### 3.1 Commit sequence [PLAN]

Each step is one small commit with `npm test` green and its line delta in the message [DOCS CLEANUP Method "One small commit per item"]. Larger items are split into lettered commits that land one at a time behind a flag. Already in flight and **not redone**: the `deep/` crate (`prove`/`up` exist; `cert` not yet [INF: grep finds none]; a `deep serve` stdin mode is **requested** from that worker, not built here), the in-memory picker, the deploy/publish split (deploy worktree 0808d8e, b18a643), removal of `/api/guest-result` (server worktree a20eb96) and `votes`, and the `/api/analyze` preflight fix (d483a29).

**Switches.** `TINUE_LOG`, `TINUE_BOOK_VER`, `TINUE_JUDGE = off|shadow|veto|decide`, `TINUE_PLAYOUT = client|server`, set in the plist, one restart each. The client keeps its local path until X1; every step before X1 rolls back by an environment change. From C1 the deploy script refuses a server rollback past C1 once X1 is live; the restore drill (CLEANUP "Done when") includes that check.

| # | Commit | Test | Rollback | Visible? |
|---|---|---|---|---|
| L1 | `attempt`, `ply`, `rating_event`, `puzzle_rev` tables; `puzzles.rev` (default 0); duplicate count on `attempts(user_id, puzzle_id)` printed | schema present; startup idempotent | unused | no |
| L1b | unique index on `attempts(user_id, puzzle_id)` once duplicates are 0 or resolved | insert of a duplicate fails | drop index | no |
| L2 | `/api/result` writes `attempt` (`mode='legacy'`) + `rating_event` in a SAVEPOINT in the same transaction | each result → one attempt + one event; forced log failure → rating still commits; `rate(before)` = `after` on 100 fuzzed results | `TINUE_LOG=0` | no |
| L3 | `scripts/refund.mjs` (dry-run; user chain + puzzle compensation; double-refund refusal; legacy signature) | fixture: refund then replay = never played for the user; second refund refused; other users untouched | unused | no |
| L4 | `scripts/replay-ratings.mjs`; `rerate.mjs` archived | A8 | unused | no |
| B1a | `shared/book.js` (`bookKey`) + a cross-check of `deep`'s TPS writer and move notation against `bookKey`/`canon` on every served 6×6 node | 0 mismatches | revert | no |
| B1b | `book`, `book_node`, `book_ver` tables | schema | unused | no |
| B1c | `scripts/book-init.mjs` on a pulled crux copy: served trees, 7×7/8×8 trees, every served alt (re-proved or `checked=0`), exclusion list | A2 | `TINUE_BOOK_VER=0` | no |
| B2 | `publish-puzzles` ships book rows insert-only, bumps `puzzles.rev`, writes `puzzle_rev`; stronger-model retirement | test-deploy (fake crux): ver N+1 adds; pointer lowering hides | pointer | no |
| B3 | `deep up` lengths on 200 stored `pd` rows | **200/200** match `plies`, or stop and report each mismatch [DOCS MINING "must match `plies`, and any mismatch is a finding to report before going on"] | pointer | no |
| B4 | `deep cert` (non-strict) pilot on 300 served 6×6 rows → book + book_node | checker 0 failures; CPU-hours per 1,000 nodes and a projection to 28,850; stop and ask if the projection exceeds MINING's budget | pointer | no |
| S1 | `shared/judge.js` pure; playon.js rules moved and re-exported | contract table row by row; I6 cases (miss → retry → solve; pending → solve-on-tree → `'no'`/`wins`; hint after move before verdict); test-playon.mjs green | revert | no |
| S2a | `server/prover.js` pns child pool | fault injection → `undecided` 1,000/1,000; identical verdicts to browser pns on 1,000 positions at the same node budgets | not wired | no |
| S2b | `deep` pool (after `deep serve` exists): quick + background | as S2a; proofs only; checker on every proof | not wired | no |
| S3 | Post-hoc shadow: each legacy result's logged miss move re-judged async; `shadow` plies; daily false-miss-candidates report; counts how many 6×6 misses today came from a quick `'no'` (V3 load estimate) | fixture: pd575074 `4c3+` → candidate | `TINUE_JUDGE=off` | no |
| S4 | Nightly `rejudge.mjs` over the last 7 days (nice, 1 CPU-h cap); proposals only | report renders; nothing applied | disable job | no |
| S5 | **Veto:** a legacy rated miss is recorded unrated (`unrated_why='book-win'`) when its move has a book row **and** the miss came from a still-wins `'no'` or quick check (log `k='miss'` with no `po` entries after it). Play-out losses stay rated. | quiet alt on an old build → unrated; proven play-out loss → still rated; refuted move → still rated | `TINUE_JUDGE=shadow` | **yes** (V5) |
| U1 | `public/puzzle.js` + `scripts/test-puzzle.mjs`, unwired (dropped 2026-11-24: deleted, it had fallen behind app.js) | every (state, event) pair | revert | no |
| C1a | `POST /api/move`, `GET /api/attempt`: nonce identity, `(nonce, ply)` idempotency, semantic-field conflicts, serialisation; shadow mode only | 1,000 random ply streams, 30% duplicates, 30% reorder, restart mid-stream → one attempt each, plies once; timing-only retries never conflict; decided attempts never change | routes unused | no |
| C1b | decide-mode guest binding: per-nonce idempotent minting; startup re-queue | lost-token retry → one guest; restart in `judging` → resumes or unrated | flag | no |
| C2 | Client outbox (sessionStorage) posts each ply `text/plain` with `rev`, `nonce`, `clientVerdict` **beside** today's `report()`; shadow never mints | comparison report; no added latency; no second guest per visitor | server `off` | no |
| **G1** | gate (§4) | | | |
| D1a | client: awaits off-tree verdicts, `judging`/`pending` UI, late-answer handling, explicit `leave`/`unload` acts, capability check | test-puzzle; staged with the server in shadow | revert client | no (until D1b) |
| D1b | `TINUE_JUDGE=decide` for builds ≥ `JUDGE_MIN_BUILD`: those builds stop calling `/api/result`; `/api/result` rates no miss in decide mode and checks both `attempts` and `attempt`; server rates from its own state; until D2 a client-run play-out's ending is taken as today (legality checked) | every failure row of §4 on staging with Syntaks stopped and killed; two-tab and old-tab/new-tab tests; never a rated miss the browser would not have | `TINUE_JUDGE=shadow` | **yes** (V1, V3, V4, V6, V19) |
| D2 | Server-run play-out, Syntaks native only, background `deep` proof | scripted games: Syntaks stopped mid-game; restart mid-game resumes; reply in transit then Give up → stalled, unrated; proof mid-game raises cap | `TINUE_PLAYOUT=client` | **yes** (V2) |
| D3 | Off-6×6 verdicts from server pns (rows 8–11); Tiltak play-on stays client-side and unrated | as D1 per size | per-size flag | yes (V1, V19) |
| D4 | Attempt expiry at 30 min → `expired`, unrated | fake-clock test; a `for=` prefetch during a play-out changes nothing | expiry off | yes (V16) |
| **G2** | gate (§4) | | | |
| X0 | delete `resign` code | test-playon | revert | no |
| X1a | delete held records, Web Lock, pagehide sends (outbox beacon stays), `report` | kill-the-page harness incl. reload during `judging` → 0 rated results lost, 0 free retries | redeploy previous client (server keeps `decide`) | no |
| X1b | delete the client off-tree pipeline | test-puzzle | as X1a | no |
| X2a | delete the client defender chain | play-out scripts | revert | yes (with V2) |
| X2b | delete playon/engine client copies | tests | revert | no |
| X2c | delete WASM and `/api/defend` | 7 days with **zero** `/api/defend` requests (they carry no `b=`: 0 of 59 in the log copy [CODE log]); old-tab test against new static files: missing handlers → unknown → no rated miss | revert | no |
| X3 | `busyUntil`, same durations | each duration asserted | revert | no |
| X4 | legacy `/api/result` always unrated (recorded); `MIN_MISS_BUILD` removed; `#checkBuild` → one check | test-server | revert | yes (V4) |
| X5 | drop `alts`/`altsAt` from payloads | 7 days with no legacy result; iOS contract test | re-add | no |
| X6 | `next` in the deciding answer; delete next.js, `for=`, `n=` | A7; 7 idle days of `for=`/`n=` | revert | yes (V15) |
| X7 | review: one engine a size | per-size test | revert | yes (V14) |
| X8 | delete `/api/result` | 7 days with 0 POSTs | re-add | no |
| P1 | `kind`, `status`, `pre0`, `miner`, `book` backfilled (unread) | `status='served'` == `SERVED` on every row | unused | no |
| P2 | picker and daily read `status`/`kind` | served id set identical; daily **tier membership** identical (dailyPuzzle picks with `ORDER BY random()` [CODE server.js:296]) | revert | no |
| P3 | `paused`/`rejected` attempts unrated | test-server | revert | yes (V8) |
| P4 | FLAW from the book, REFUNDED from refund events; `REFUND_MARK` retired | every row's score term equal on a crux copy | revert | no |
| P5a | overrides extended to tree patches; crux-edited rows captured | rebuild on a crux copy reproduces every row's tree, plies, komi and grade | revert | no |
| P5b | `publish-puzzles` reads verifier output; sidecar import and offline scripts deleted | A9 | previous import.mjs | no, until Sasha approves rejections |
| P6 | after 30 days + snapshot: drop `turn`, `swing`, `flaw`; `attempts` → view | `/api/history` unchanged | restore snapshot | no |

**Order constraints.** L1 before L2, B2, C1 (rev, book_ver). L2 before S3. B1 before S5 and D1b. S1, S2a before C1a. U1 before C2. C2 runs ≥ 14 days before D1b. S2b (needs `deep serve`) before D2. Every X step needs G2. P1–P2 follow the in-flight picker. B4 and P5b need `deep cert`. P5a before P5b. X2a/X2c need V2.

**Parallel work.** L, B, S1–S2a and U1 can run in parallel.

### 3.2 Old clients and iOS [PLAN unless tagged]

**Old web tabs** post `POST /api/result?b=…{puzzleId, win, casual, theme, ms, log}` [CODE server.js:614]. They stay open for days (task brief); build-less POSTs were last seen 11-16 19:15Z [CODE log].

| Period | Wins | Misses |
|---|---|---|
| until S5 | rated | rated above `TINUE_MIN_BUILD` [CODE server.js:631] |
| S5 → D1b | rated | unrated if the book proves the move and the miss came from a still-wins check |
| D1b → X4 | rated, if no first decided result exists in `attempts` or `attempt` | unrated |
| X4 → X8 | recorded unrated | recorded unrated |

- `alts`, `altsAt`, `turn`, `pre0`, `tree` stay in `/api/next` and `/api/puzzle/:id` until X5 [CODE app.js:588, 1568].
- An old tab and a new tab on one puzzle: whichever **decides** first is the first result; the other is recorded unrated (Decision 15).
- After X2c an old tab may lazily fetch new `engine-worker.js`/`syntaks.js` from Pages [CODE app.js:927; engine.js:8-9, 54, 71]; missing handlers resolve to unknown, never a rated miss (tested at X2c).

**iOS (Gaelet)** reads `/api/daily` and `/api/puzzle/:id` and never posts [CODE TakMessages TinueAPI.swift:12-77]. Those fields and the tree format are frozen; `/api/puzzle/:id` never opens an attempt; `scripts/test-ios-contract.mjs` runs at B2, P2, X5, P6; the daily keeps tiers that make it never empty [CODE server.js:286-288]. Bots keep `botPuzzle.turn` [CODE server.js:307].

---

## 4 · Acceptance checks and gates [PLAN]

| # | Check | Target |
|---|---|---|
| A1 | served set after P1/P2 | identical to `turn = 1 OR grade = 'A'` before any decided change |
| A2 | book | 0 same-model length conflicts (exact vs exact, or exact above a bound); 100% of served key positions; every served alt present (checked or not); ps505288 `c4-` absent via the exclusion list; re-proof failures listed |
| A3 | judge on stored puzzles | 100% of tree keys → `ok`; 100% of book alts → proven; 0 `missed` on any book position |
| A4 | refutation soundness (off 6×6 `full` nodes only) | over the covered 4×4/5×5 `full` nodes, 0 refutations that the tak.js full-width Solver (small positions) or Syntaks self-play from the move wins; on 6×6, refutations appear only on cards |
| A5 | latency | on-tree/book p99 ≤ 20 ms server; live judge p95 ≤ 2.5 s (6×6) / 3 s (others); Syntaks reply p50 ≤ 1.4 s (today 1,204 ms [DOCS SD §7]); play-outs per day measured against S3's estimate |
| A6 | evidence | `rated = 1 AND result = 0` without an I1 evidence (and `left`/`unload` without an act ply) → 0 |
| A7 | time to next puzzle on a phone | median ≤ today's before X6 |
| A8 | replay | post-L2 ratings to \|Δ\| < 1e-9 |
| A9 | pool after P5b | per row, tree, plies, komi and grade equal a crux copy except decided changes and verifier rejections, each with a reason [DOCS CLEANUP "Done when"] |
| A10 | faults | 0 rated misses in 1,000 injected crash/timeout/OOM/queue-full/503/restart runs |
| A11 | delivery | 1,000 simulated attempts, 30% drops, 30% duplicates, random page kills and reloads (incl. during `judging`), two tabs: one first result each, 0 duplicate plies, 0 lost rated results, 0 free retries, 0 rated results from conflicts |
| A12 | iOS | an unchanged Gaelet build plays the daily before and after X5 and P6 |
| A13 | report | lines, files and columns removed [DOCS CLEANUP "Done when"] |
| A14 | key agreement | `deep` vs `bookKey`/`canon` 0 mismatches (B1a), re-run on every `deep` build |

**G1** (before D1b): ≥ 14 days of C2 shadow and ≥ 300 off-tree judgments; 0 cases where the server would rate a miss the browser did not; every browser rated miss the server proves is explained and gets a refund proposal; server `undecided` ≤ 1.2× the browser's `pending`/`unknown` rate; 0 `client-disagree`.

**G2** (before any X): ≥ 14 days in `decide`; 0 judge-caused refunds; 0 attempts stuck > 24 h; A6 = 0; S4 finds no judge-caused false miss.

---

## 5 · What can start now, and what cannot

**Without Sasha's yes** (dark, reversible): L1–L4 (L1b after the duplicate list is resolved), B1a–B4 (B4 once `cert` exists), S1–S4, U1, C1a–C2, X0, X3, P1, the iOS contract test, and the `deep serve` request to the solver worker.

**Needs Sasha's yes before it ships:** S5; D1b (V1, V3, V4, V6, V19); D2/X2 (V2); D3; D4 (V16); X4; X6; X7; P3; refund.mjs's first real refund and its puzzle compensation (V18); the theme check (V20); V10–V13; applying verifier rejections or tree patches in P5.

---

## 6 · Visible changes (each needs Sasha's yes)

| # | Change | Step | Recommendation |
|---|---|---|---|
| V1 | Off-tree moves are judged on crux: "Checking…" includes the round trip; offline an off-tree move waits. On-tree play unchanged. | D1b, D3 | yes |
| V2 | 6×6 play-out replies only from Syntaks native on crux: no WASM (tried first today [CODE app.js:930-937]) and no Tiltak fallback. When crux is busy: proven → solved, unproven → unrated. | D2, X2 | yes. Without it: keep WASM-first with replies posted as `src=wasm` plies, legality-checked. |
| V3 | **6×6: every off-tree move without a proof is played out against Syntaks**; today a quick threat-only `'no'` is an instant rated miss. This is SD's "Proposal A9 \| a quick 'no' resting only on threats → play-on instead of a rated miss" (SD line 878), extended to every disproof because "a disproof through it can miss zugzwang" [DOCS SOLVER §4] and the absence of other wins "rests on three imperfect tests" [DOCS MINING]. More play-outs load crux (S3 estimates how many). | D1b | yes. Alternative: keep instant misses only where today's threat-only check at today's node budget **and** `deep q=1` both say no (never more misses than today). |
| V4 | Old tabs: misses unrated from D1b, everything unrated from X4. | D1b, X4 | yes |
| V5 | A legacy miss on a book-proven move, decided by a still-wins check, shows "not rated". Play-out losses stay rated. | S5 | yes |
| V6 | Results no longer get lost on a failed upload; a reload mid-puzzle resumes the attempt. | D1b | yes |
| V8 | `paused`/`rejected` puzzles unrated; ps505288's `c4-` no longer a free solve. | P3, B1c | yes |
| V9 | The miss card's refutation comes from the judge; on 6×6 it is shown after a play-out; off 6×6 often absent. | D1b | yes |
| V10 | A miss ends the puzzle: no retry, no "Solved, after a miss" [CODE app.js:1351]. | — | **no**: keep retry |
| V11 | No Tiltak play-on: an undecided 4×4/5×5/6×6-komi-4 move is an unrated miss. | — | later, once the log counts it |
| V12 | 7×7/8×8 leave the size menu. | — | Sasha's call |
| V13 | Picker: drop FLAW, CONVERT and UNSCORED terms (CLEANUP §2 "minus the removed terms"); unserve 5×5 conversions (CLEANUP §4 "With 5×5 conversions unserved"; 4,792 are served today [CODE db]). REFUNDED stays (Sasha's decision). | P4 | no for now; revisit with the log |
| V14 | Review: one engine a size; 6×6 shows "engine unavailable" when crux is down. | X7 | yes |
| V15 | Next puzzle in the verdict, queue deleted. | X6 | only if A7 holds |
| V16 | An abandoned play-out that just goes quiet (no `leave`/`unload` act) expires **unrated**. A deliberate close (beacon) or leave keeps today's rule. Today only a real pagehide sends `unload` [CODE app.js:790]; I2 says a lost network is not evidence. | D4 | yes |
| V17 | Automatic refunds. | after S4 | proposals for a month, then auto-apply where the evidence is a checked proof |
| V18 | Refunds also restore the puzzle's rating, attempts and solves (today they never touch it [DOCS SD line 734]); this shifts later players' expected scores on that puzzle slightly; past results of other users are not rewritten. | L3 | yes |
| V19 | Off-6×6 proving moves from the browser to crux (departs from CLEANUP §5 "keep `pns.js` as the browser prover off 6×6"). Same node budgets, so the same verdicts; adds a round trip. | D1b, D3 | yes. Without it: browser proves, server re-checks proofs with tak.js before rating a solve, and a browser `'no'` is rated only as today. |
| V20 | `theme` weight only for the puzzle's own themes (closes an exploit; changes Glicko-2 inputs for a few players). | C1a/D1b | yes |

---

## 7 · Open questions for Sasha

| # | Question | Recommendation |
|---|---|---|
| Q1 | Keep "try again" after a miss (V10)? | Keep. |
| Q2 | Native Syntaks only for 6×6 play-outs (V2)? | Yes, after A5 holds. |
| Q3 | Off 6×6, should a threat-only `'no'` become an unrated miss (or a Tiltak play-on) instead of a rated miss (A9 off 6×6)? | Keep today's rule; count the cases from the log and re-judge nightly first. |
| Q4 | Keep the unrated Tiltak play-on (V11)? | Keep for now. |
| Q5 | 7×7/8×8 in the menu (V12)? | Keep until the verifier covers them. |
| Q6 | Picker terms and 5×5 conversions (V13)? | Keep for now. |
| Q7 | Abandoned play-out (V16): quiet → unrated, deliberate close/leave → today's rule? | Yes. |
| Q8 | Refund proposals: manual or automatic (V17)? | Manual for a month. |
| Q9 | Refund pd575074's unrefunded −2.9 [DOCS SD §8.2] as refund.mjs's first case? | Yes. |
| Q10 | MINING's hard collection: unrated until decided, served only after D2? | Yes [DOCS MINING]. |
| Q11 | Grade D "never serve" is not enforced in stage 2 or daily tier 4 [CODE server.js:240-243, 285]. Make D `rejected`? | Yes, as its own visible change. |
| Q12 | On-tree play with no network: keep? | Keep. |
| Q13 | 6×6: play out every unproven move (V3), or the "both say no" alternative? | Play out. |
| Q14 | Duplicate `attempts` pairs found at L1: which row stands? | Keep the earlier one; list each. |

---

## 7a · Sasha's decisions (2026-11-17, evening)

Each change still ships at its own step with that step's gates (for example V2 after A5 holds, V15 only if A7 holds, C2 running at least 14 days before D1b).

| Item | Decision |
|---|---|
| V1, V19 | Approved. |
| V2 (Q2) | Approved, after A5 holds. |
| V3 (Q13) | **Working choice: the narrower rule, not "play out everything".** Sasha: the worry is the moves "where we've not done an exhaustive search". So: an instant rated miss stays where the threat-only check **and** `deep q=1` both finish inside their budgets and both say no; a move is played out when either check ran out of budget, or the two disagree. S3 counts how many misses fall on each side. Final confirmation still to come from Sasha before D1b. |
| V4 | Approved (left to my judgment). |
| V5 | **Yes** (2026-11-17, 19:45 PST: "Yes, V5"). S5 may ship once B1 has written the book; play-out losses stay rated. |
| V6, V9, V14 | Approved. |
| V8 (Q11) | Approved: grade D is never served (status `rejected`), `paused`/`rejected` puzzles are unrated, no free solves. Lane `gw2-pstate`. |
| V10 (Q1), V11 (Q4), V12 (Q5), V13 (Q6), Q3, Q12 | Keep as today, as recommended. |
| V15 | Approved, only if A7 holds. |
| V16 (Q7) | Approved. |
| V17 (Q8) | No automatic refunds. The refund tool stays manual, for past results and bugs; Sasha expects refunds to be rare once moves can be played out. |
| V18 | Approved. Sasha's reading is right: when a puzzle wrongly failed someone, the refund also takes back the rating the puzzle gained from that result. |
| V20 | Approved. Lane `gw2-pstate`. |
| Q9 | Approved: refund pd575074's −2.9 as the first case. |
| Q14 | Keep the earlier row; list each pair. |
| Backups | Stay on crux only; no off-machine copies. |

---

## What this reconstruction cannot know

Everything below is [INF].

1. **Numbering.** "part 2 lists the deletions" fits "Part 1 design, Part 2 deletions" (used here) or "Parts 1–3 book, judge, log".
2. **Protocol.** The briefs never say whether every move or only off-tree moves reach the server.
3. **What "log" meant.** The client outbox alone, an extension of the access log (CLEANUP keeps only its "privacy scheme" as is), or an attempt ledger (here).
4. **Whether 6×6 had a live prover.** "Syntaks native (df-pn off 6×6)" is read here as "df-pn never rates a 6×6 result": live `deep` may upgrade, never refute. The original might have had no live prover at all.
5. **What the author knew.** The briefs were written from the design page alone: Tiltak in a rated result; 9 endings (10 kinds, 9 reachable); 7 sidecars (12 exist, 5 live); C++ `deep` (the crate is Rust); "5×5 conversions unserved" (4,792 served — read here as a proposal, V13). It may not have known that WASM defends first today.
6. **Retry.** CLEANUP's machine drops `missed → play` and `judging → solved`.
7. **Old tabs and iOS.** Unknown whether the plan had a window, a veto or gates.
8. **Schemas, budgets, numbers.** All this reconstruction's. CLEANUP names only `reserve`.
9. **The verifier off 6×6.** May have meant 6×6 only.
10. **Coverage cost.** Unmeasured until B4.

---

## Appendix · Where the briefs and the code disagree

| Brief says | Code says | Effect here |
|---|---|---|
| Tiltak among "engines in a rated result" [DOCS CLEANUP] | a Tiltak-defended game is unrated both ways [CODE playon.js:60, 68-69] | nothing to change for ratings |
| "Play-out endings 9" | 10 kinds, 9 reachable; `resign` dead [CODE app.js:1025-1062; playon.js:85] | 2 endings plus `why` |
| "Syntaks native" as the 6×6 defender | WASM first; crux as fallback [CODE app.js:930-937] | V2 is a change |
| "an old client cannot produce a wrong rated result" | true only once legacy misses are unrated [CODE server.js:631-632] | D1b, then X4 |
| "crux owns puzzles" | lyra's export overwrites crux rows on deploy [CODE import.mjs:108-112] | in-flight publish split is a precondition; P5a |
| "7 sidecars", "3 import runs" | 12 sidecars (5 live); at least 5 runs [CODE db, map-state §2] | the verifier replaces them |
| "With 5×5 conversions unserved, only about 1,100 rows need a grade" | 4,792 5×5 A conversions are served [CODE db] | read as a proposal: V13 |
| "Mark them `reserve` and exclude them from rescoring, export and stubs" | stage 2 serves reserve, incl. all 7×7/8×8 [CODE server.js:239-243] | reserve stays pickable (Q6) |
| "C++ `deep` solver" (CLEANUP §5) | the crate is Rust | language-neutral; B1a cross-check |
| "keep `pns.js` as the browser prover off 6×6" | — | departed from, flagged as V19 |

---

## Review record

Two adversarial reviews, 2026-11-17: reviewer 1 (22 findings: 11 blockers, 6 major, 5 minor) and reviewer 2 (22 findings: 9 blockers, 7 major, 6 minor). 44 findings in all, many overlapping (about 30 distinct). Each was checked against the code or documents.

**Confirmed: 42. Partly accepted: 2. Rejected outright: 0.**

Checked directly for this revision: `next.js:79` prefetches `/api/next?…&for=<current id>` mid-puzzle; `app.js:843-847` proves during a play-on and raises the cap; `app.js:557-560` treats any non-winning game end as a miss; `app.js:1351` holds "Solved, after a miss" (`1077` is `fail`); SOLVER §4 "a disproof through it can miss zugzwang"; MINING "three imperfect tests"; SD line 878 (A9 → play-on); CLEANUP "Keep as is" names the access log's privacy scheme; MINING "must match `plies`"; `import.mjs:136-144` overrides set grade only; `server.js:296` daily `ORDER BY random()`; `server.js:51` index not unique (1 duplicate pair in lyra's DB); `server.js:221-226` REFUNDED is Sasha's call; 0 of 59 `/api/defend` lines carry `b=`; `server.js` is 21 lines **longer** at HEAD.

**What changed.**
- 6×6 disproofs (live `deep` and `book_node`) never rate; every unproven 6×6 move is played out; V3 restated as SD's A9, both directions, with an alternative (Decision 4, rows 6–7, A4 rewritten).
- Background `deep` proof during unproven play-outs; nightly re-judge covers unproven play-out losses (I5).
- `book_node` only from non-strict runs with every move listed; refuted never inferred from absence; off 6×6 short-circuit only on `model='full'`; B1a key cross-check (A14).
- I6 (result fixed by first decisive ply; hint as of that ply); Decision 15 (first *decided* result counts, V7 removed); unique `attempts` index with a duplicate check (L1b).
- Explicit `leave`/`unload` acts; expiry → `expired` unrated (V16); stall measured from server receipt with `seen`.
- Nonce identity, per-nonce idempotent minting, one-ply-at-a-time until token, semantic-only conflicts that never touch decided attempts; shadow never mints.
- `rev` in every ply; `client-disagree` unrated; capability flag and rollback guard; startup re-queue.
- Outbox persisted in sessionStorage; pagehide beacon owned by the outbox; A11 adds reloads during `judging` and two tabs.
- `/api/result` checks both tables, rates no miss in decide mode; new builds stop calling it; log writes in a SAVEPOINT; `rev`/`book_ver` moved to L1.
- B1 keeps every served alt (unchecked if re-proof fails), on a pulled crux copy; tree-patch overrides (P5a); A9 compares rows, not ids.
- Refunds: user chain only, puzzle as one compensation, double-refund refusal (V18).
- S5 narrowed to still-wins misses; stronger-model retirement in the book; B3 200/200; B4 costed; `deep serve` requested.
- `held` split into status `paused`, verdict `pending`, ending `defended`.
- New V items: V13 (picker terms, 5×5 conversions), V18, V19 (Decision 5 as a departure from CLEANUP §5), V20 (theme).
- Steps split (L1b, B1a–c, S2a–b, U1, C1a–b, D1a–b, X1a–b, X2a–c, P5a–b); X2c gate on all `/api/defend` traffic plus an old-tab static-file test; X6 keeps `for=`/`n=` until idle; `text/plain` plies.
- Citations fixed: CLEANUP "Keep as is" quote; V3's A9 claim; HEAD offset; `import.mjs` swing overwrite (via `setTurn`); `app.js:1351`; `main.rs` line drift; P2 daily test.

**Partly accepted.**
- Reviewer 1 (I3): "merge D1 and D2, or rate client play-outs only from server-checked `src=wasm` plies". Kept D1/D2 separate. With 6×6 disproofs no longer rating, D1b creates no new 6×6 misses. Until D2, a client play-out ending is taken as today, so the window adds no new trust. The residual F4 trust for wins is documented in I3.
- Reviewer 2 (Decision 5): "follow CLEANUP §5 or mark it a departure". Marked as a departure (V19), with CLEANUP's version as the fallback. Not reverted, because a browser `'no'` is a client-asserted miss, which CLEANUP §3 rules out.

**Re-read for contradictions.** I checked the Summary, the Decisions, I1–I6, the §1.2 tables, §3.1, §3.2, §5 and §6 against each other. Verdict names (`pending`), endings (`defended`, `expired`), statuses (`paused`) and V numbers (V7 retired) are now used consistently.
