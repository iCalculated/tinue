# tinue implementation plan: book, judge, log (draft "delete")

Priority of this draft: **delete the most code.** It starts from CLEANUP's end state and works back to the shortest run of commits that reaches it. It counts what each step removes and says what players lose.

**Tags.** [D] = FROM THE DOCS, quoted (CLEANUP, MINING, SOLVER, or SD = `docs/system-design.html`). [C] = FROM THE CODE, cited as `path:line` at commit 3026736, or a read-only count from `data/tinue.db` or `briefs/access.log`. [I] = INFERENCE, with the reason. Sentences that say what to build ("will", "add", "delete") are the plan's proposals, not claims about the system. Line numbers for `server/server.js` are at 3026736; HEAD (6e79c6c) adds 21 lines around :136 [C `git log`].

---

## 0 · The end state in one table

| Concept | Today | After | Removed |
|---|---|---|---|
| Who decides a rated result | The browser. The server takes `win` and `casual` on trust [C server.js:614-632] | crux, one move at a time | client-side judging |
| Puzzle state | `turn`, `grade`, `flaw`, `swing` (8 keys) [C import.mjs:94], 12 sidecar files, 5 of them live [C map-state §2.1] | `kind`, `grade`, `status`, plus the `book` table | 2 columns, every sidecar |
| Paths for an off-tree move | cache, alts/altsAt, quick check, slowSolve, play-on, held miss, miss [C app.js:579-651] | tree → book → prover → **solved / miss / play** | 4 paths |
| Play-out endings | 10 kinds, 9 reachable [C app.js:1025-1061, playon.js:85-86] | 2: solved or not | 8 |
| Engines that touch a play | df-pn (browser), Syntaks WASM, Syntaks native, Tiltak (play-on and review), solver (review and refutation) [C app.js:361-402, 914-970] | On crux: Syntaks native defends 6×6 and `deep` proves 6×6; `pns.js` proves the other sizes. In the browser: Tiltak, for 4×4/5×5 review only | 3 browser engine uses |
| Input guards | TOO_SOON, FRESH, 600 ms, 700 ms, 1,500 ms [C app.js:493-510, 644, 853] | one `busyUntil` | 4 |
| Ways a result reaches crux | `report`, keepalive on pagehide, `flushHeld`, displaced-record resend [C app.js:51-71, 676-724, 790-807] | none: crux already has every move | all four |
| Next-puzzle machinery | `for=` pair, queue of 10, `tinue.next` [C next.js:1-115] | `next` arrives in the deciding answer | next.js |
| Build check | interval, visibility, bar, reload deferral [C app.js:213-280] | one check between puzzles | ~55 lines |

**Totals (estimates in §9):** about 1,400 client lines and 7 files removed (one is a 19.5 MB wasm), about 800 test lines, and about 1,900 offline script lines. The server grows by about 300 lines. Net is roughly **−3,500 lines.**

The cost to players, stated once here and itemised in §11:
- **No play without a network.** Every move goes to crux.
- **On-tree moves get a round trip.** The existing 450 ms reply animation [C app.js:662-672] hides it as long as the round trip stays under ~450 ms.
- **Every 6×6 defender reply comes from crux.** Today the browser's WASM goes first [C app.js:930-937].
- **No defender on 4×4, 5×5 or 6×6 komi 4.** An undecided move there becomes an unrated miss instead of an unrated game against Tiltak.
- **7×7 and 8×8 stop being served.** They have no defender and no scoring, and they have 0 rows in the served pool [C map-state §3].

---

## 1 · Rules this plan must keep (Sasha's decisions)

| Rule | Source | How the plan keeps it |
|---|---|---|
| Any proven forced win is a solve, at any length | [D SD §3.2; C app.js:1088-1092 "People don't like having to play for shortest"] | Judge: a book or prover proof gives `proven`. Off 6×6 that is solved on the spot. On 6×6 it is a proven play-out, and winning it is a solve. Length never matters. |
| Prove winning sequences by playing them on 6×6 | [D SD §8.2 "Make people prove winning sequences! Just fine if they are slower"] | Proven 6×6 moves (|komi| ≤ 3.5) are played out against Syntaks |
| Rated miss when Syntaks defended | [D SD §8.2 "Rated miss when defended."] | A play-out that ends not solved is rated when Syntaks gave at least one reply (today's `gameRated`, playon.js:60) and the game was not cut short by the engine |
| No play-out against Tiltak | [D SD §8.2 "No play out w tiltak"] | Tiltak never defends. **Change:** unproven play-on against Tiltak (4×4/5×5, 6×6 komi 4) is also removed. It is unrated today [C playon.js:60], so no rating rule changes, but players see it (V3). |
| First result counts; guests count at half weight; Glicko-2 | [C server.js:626-635; rating.js] | Unchanged. `seq = 1` is the first attempt, and the weights are stored per attempt (§4). |
| A false rated miss is the worst bug | task brief | A rated miss needs evidence: a disproof, a Syntaks-defended loss, Solution, or Give up. Engine trouble only ever produces unrated results or play-outs (§3.5). Disproofs are re-judged in batch with automatic refunds (§4.4). |
| Old tabs live for days; Gaelet reads /api/daily and /api/puzzle/:id | task brief; [C TinueAPI.swift:12-16, 62-77 via map-server §6.3] | §8 |

Two places where the code differs from how the rules were summarised to me:
- **Who defends 6×6 today.** The rated 6×6 defender is often **Syntaks WASM in the browser**. Native Syntaks on crux is only the fallback [C app.js:930-937]. Moving every reply to crux is visible (V2).
- **Tiltak is never in a rated result** [C playon.js:60, 68-69]. CLEANUP lists it among "engines in a rated result" [D]. That claim is wrong, so dropping Tiltak from play changes no rating.

---

## 2 · BOOK

### 2.1 What it is

A table of proven attacker wins keyed by **the position after the attacker's move**, with the defender to move. It holds wins only. MINING asks for exactly this: "book rows: position after the move, `win_len`" [D MINING "Changes … 5"]. Judging a move is then a lookup in most cases: the judge looks for the position the move reaches.

It replaces:
- `swing.alts` and `swing.altsAt` [C server.js:204-207; app.js:1072-1075];
- the per-tab proof cache `S.proven` and `S.proofPlies` [C app.js:587, 615-616];
- the proof-length worker [C app.js:896-912; engine-worker.js:102-110], because `win_len` gives the cap;
- `flaw = 1`, which becomes derivable as "a book row at the root other than a key" (and stops being used anyway, §5.3);
- the sidecar files as the store of alternative wins.

### 2.2 Key and schema

```sql
CREATE TABLE book (
  pos      TEXT PRIMARY KEY,   -- TPS board + ' ' + side to move + '|' + half-komi; move number stripped
  win_len  INTEGER,            -- plies the attacker needs from pos (defender to move, reply counted); NULL off 6×6 allowed
  exact    INTEGER NOT NULL,   -- 1: a disproof at win_len-2 exists
  src      TEXT NOT NULL,      -- tree | alt | deep-cert | live-deep | live-pns
  checked  INTEGER NOT NULL,   -- 1: proof walked by a checker (SOLVER §5) or by tak.js
  puzzle_id TEXT,              -- the row that produced it (NULL for a live proof shared by transposition)
  commit   TEXT NOT NULL,      -- producing commit sha
  ts       INTEGER NOT NULL
) WITHOUT ROWID;
```

- **Key.** The key is the position text `Game.toTPS()` [C shared/tak.js:98] without the move number. Komi is in the key because flat wins depend on it. The 8 board symmetries are **not** canonicalised, because every producer would have to agree on the canonical form [I: it adds code for a 384-row gain, SD §2.8]. The key is not a hash, because tinue's old Zobrist keys had about 33 effective bits [D SD §2.1].
- **One length per key.** Across all 496,036 tree positions in the DB, no position has two lengths [C map-state §6.4, book.mjs `lenConflicts: 0`]. A conflicting insert fails loudly.
- **`win_len` NULL** is allowed only when size ≠ 6. Off 6×6 a proven move is solved on the spot, so nothing reads the length there. This saves a length pass over the 4,221 non-6×6 alt positions [C map-state §6.4: 6,680 alt positions, 2,459 of them 6×6].

### 2.3 Size

- **Served pool today:** 69,226 distinct positions after tree keys (6×6: 20,246) plus 6,680 alt positions (6×6: 2,459). That is **75,906 rows** [C map-state §6.4].
- **Bytes:** about 8–10 MB in SQLite [I: about 110 bytes per row; a 6×6 TPS is under 100 characters].
- **No 1-ply rows:** the 13,902 served 1-ply puzzles add none, because the rules detect the win [C map-state §6.4].
- **Reserve rows** get no book rows.

### 2.4 Who writes it

| Writer | Rows | When |
|---|---|---|
| `scripts/book-init.mjs` (new, one-time, ~60 lines) | Every tree key's position (`src=tree`, length = 1 + depth of the next node) and every alt position that has a proof (`src=alt`). 6×6 alt lengths come from `deep up` over the 2,459 positions. | migration D1 |
| The verifier, `deep cert` (in flight) | 6×6 keys, slower wins and cooks, with exact length and `checked=1` | every publish of new 6×6 puzzles |
| The judge on crux | `live-deep` / `live-pns` after a proof passes the checker | at play time |
| `scripts/rejudge.mjs` | rows found while re-judging disproved misses (§4.4) | nightly batch |

**ps505288's `c4-` must not enter the book.** Its override says it "could not be proved to win" [C grade-overrides.jsonl via map-state §5], yet it is still in `swing.alts`. `book-init` takes an alt only if `deep up` (6×6) or `TinueSearch` with `fullDefense` (other sizes) proves it again. Alts that fail are listed in the migration report.

### 2.5 Publishing

crux owns `puzzles`, `book` and `attempts` [D CLEANUP §3 "crux owns puzzles, book and attempts"]. The in-flight `publish-puzzles` step writes puzzle rows and their book rows in one transaction. Book rows are never deleted. A puzzle that is rejected keeps its rows, because they are true facts about positions.

### 2.6 What it removes

The **quick check stays only for moves the book does not know**, and it runs on crux (§3).

| Removed | Where | Lines |
|---|---|---|
| `slowerWins` | [C app.js:1071-1075] | 5 |
| `provenKey`, `S.proven`, `S.proofPlies` | [C app.js:587, 615-616, 1078-1079] | ~6 |
| `swingPublic` alts/altsAt (after the old-client window) | [C server.js:201-207] | 7 |
| `setProofLength`, `proofLength`, engine-worker `length` | [C app.js:894-912; engine.js:80; engine-worker.js:102-110] | ~30 |

---

## 3 · JUDGE

### 3.1 One function, on crux

`server/judge.js` exports `judge(attempt, move) → {verdict, reply?, evidence}`. `verdict ∈ ok | solved | miss | play`.

```
apply move to the attempt's game (illegal → 400)
game over:  attacker won → solved (evidence: rules)   else → miss (evidence: rules, e.g. own road for the defender)
in play-out:   → §3.4
node has the move as a key → ok, reply = stored r (evidence: tree)
b = book[pos]                     → proven(b.win_len)                              (evidence: book)
else r = prove(pos, size)         → proven(len) | disproven | undecided            (evidence: deep/pns, nodes, ms)
        proven: insert book row (live-*, checked by the prover's checker)
proven:      defended(size, komi) ? play(proven, cap = provenCap(left, len)) : solved
disproven:   miss
undecided:   defended(size, komi) ? play(unproven, cap = capMoves(left)) : miss, unrated ('undecided')
defended(size, komi) = size === 6 && |komi| ≤ 3.5 && 2·komi integer          (today: playon.js:35)
```

- `capMoves`, `provenCap` and `proofMoves` move from `public/playon.js:8-30` to the server unchanged [C]. They are moved, not rewritten.
- **The prover:**
  - **6×6:** `deep prove q=1` with a 2 s budget, which proves and disproves [D MINING "Only `deep` also returns disproofs"].
  - **Other sizes:** today's `still` worker logic [C engine-worker.js:69-101], moved into a child-process script `server/prove-pns.mjs` (~45 lines), with a 3 s budget.
  - Both run as child processes under one semaphore of 2. They never run on the request thread: the server is a single process using synchronous SQLite [I: map-server §7.3].
- **Disproof models.** deep `q=1` allows one quiet move, which is stronger than today's threat-only `no` [C engine-worker.js:73-76 "'no' only means no win made of Tak threats exists"]. Its disproof can still miss a zugzwang [D MINING "assumes passing never helps"]. Today a threat-only 'no' is a rated miss [C app.js:626-643]. On 6×6 this plan keeps "disproven → rated miss" on a model that is at least as strong, so no false miss is possible that is not possible today [I: deep's model is a superset of threat-only]. Off 6×6 the model stays threat-only, as today.
- **The miss card.** deep's disproof stores the refuting reply at the AND node [D SOLVER §4 "AND best = refuting reply"]. The judge returns it as `refutation`. That replaces the browser's refute worker [C app.js:638-642; engine-worker.js:111-132]. Off 6×6 the card shows no refuting line unless pns returns one (V10).

### 3.2 API

One route. It is also the log writer (§4).

```
POST /api/move   {puzzleId, ply, move?, act?: 'hint' | 'view' | 'giveup', theme?, b}
→ 200 {attempt, ply, verdict: 'ok'|'solved'|'miss'|'play'|'reply'|'hint',
       reply?, hint?, line? (the solution, at solved/miss), refutation?, cap?, proven?,
       rated?, userDelta?, user?, puzzleRating?, token?, next?}
```

- **`ply` is an idempotency key.** A retried request with the same `(attempt, ply)` gets the stored answer and is never judged twice. That makes the client "outbox" one retry loop (§7.3).
- **First move without a token** makes a guest through `newGuest` [C server.js:156-177] under today's 10/h/IP limit [C :621], and the answer carries the token. This is the same as the first result today, one step earlier.
- **`act: 'hint'`** marks the attempt casual and returns the hint target. `act: 'view'` decides a miss, rated unless hinted, as Solution does today [C app.js:1169]. `act: 'giveup'` is valid only in a play-out.
- **`theme`** is checked against the puzzle's own themes. Today any valid key gets the reduced weight [C server.js:633].
- **`next`** is in the answer that decides the result, picked at the post-result rating by the in-flight in-memory picker (§7.4).
- **Rate limits:** 120 requests/min per user or IP, and one move in flight per user.

The tree stays in the puzzle payload. Hint levels and the Solution animation read it in the client. Hiding the tree would only stop a player from cheating themselves [I], so there is no reason to add server code for it.

### 3.3 Budgets and latency targets

| Step | Budget | Target (server time) |
|---|---|---|
| tree / book lookup | — | p99 ≤ 5 ms [I: one indexed SELECT] |
| deep prove (6×6) | 2 s wall, then undecided | p50 ≤ 100 ms for ordinary wrong moves [I: a move that makes no threat is disproved after one expansion]; p95 ≤ 2 s |
| pns prove (other sizes) | 3 s wall | p95 ≤ 3 s; today's quick check answers within 2.5 s [C engine.js:51] |
| Syntaks reply | movetime 1200, 8 s overall | p50 1,204 ms, as today [D SD §7] |
| cap-time re-prove (unproven play-out at the cap) | 10 s | see §3.4 |

**Round trip from Pages to crux:** this repo has no measurement of it [I]. Today's p50 for POST /api/result in the access log is 3.4 ms server-side [C briefs/access.log, 1,375 rows]. The client shows "Checking…" only after 300 ms, so the network cost is invisible for on-tree moves under ~450 ms.

### 3.4 The play-out, driven by crux

- **Start.** On `play`, the judge stores `{proven, cap, len}` in the move row (§4). The defender's first reply goes in the same answer.
- **Each move.** Every player move goes through `/api/move`. The server applies it, checks the game end, then the cap, then asks Syntaks (`syntaks.analyze(pos, komi, {priority: true})`, the existing pool [C server/syntaks.js]) and returns `reply`.
- **At the cap** (`mine ≥ cap`):
  - **Proven:** not solved, rated. The cap covered `win_len`.
  - **Unproven:** the server re-proves the original move once, with 10 s.
    - Proven: the cap rises to `provenCap(left, len)` and the game goes on. This is today's `capWait('proof')` [C playon.js:133-138; app.js:996-1010], made server-side and without the visible-time timer.
    - Otherwise: not solved, rated. Today a capWait timeout is also a rated `out` [C app.js:1011; playon.js:91].
- **Syntaks gives no legal reply** (down, busy, overrun):
  - proven → **solved**, which is today's 'proved' (b) [C app.js:956];
  - unproven → **not solved, unrated ('engine')**.
  - No Tiltak, no WASM.
- **Give up / Solution:** not solved. Rated if Syntaks has replied at least once (today's `line.length ≥ 2` [C playon.js:60]).
- **Abandon.** A user's open attempt is closed lazily when they send a move on another puzzle. No timer is needed. A closed proven play-out is unrated. A closed unproven play-out is rated, as 'left' is today [C playon.js:91].
  - Change: today 'left' on a *proven* play-out is rated [C playon.js:91]. That becomes unrated, a lenient change (V14).
  - A tab closed for good leaves the attempt open with no effect on any rating. Today 'unload' of an unproven play-out is rated [C playon.js:91]. **This is a small escape hatch** [I]. It is accepted because closing the tab costs the player their session.
- **The two endings.** These are the only endings: `solved` and `not solved`. The reason (`rules | cap | giveup | view | abandon | engine`) is evidence in the log. The client does not branch on it.
- **Removed:** `resign` (unreachable today [C playon.js:85-86]), `held` / `road` / `out` as separate client paths, the stall rule (crux cannot stall on itself), the `unload`/`left` split, and `noengine`.

### 3.5 Busy or down: never a false rated miss

| Failure | 6×6 | Other sizes |
|---|---|---|
| prover semaphore full | undecided → play-out | undecided → unrated miss |
| `deep` binary missing or crashes | undecided → play-out | — |
| Syntaks down mid-game | proven → solved; else unrated | — |
| Syntaks down before the first reply | proven → solved; else unrated | — |
| crux down | the client cannot play (V1) | same |
| server restart mid-attempt | the attempt resumes from its move rows (§4) | same |

**Every rated miss in the log carries one of five pieces of evidence:**
1. `disproof` (deep or pns);
2. `rules` (the move gave the defender the game);
3. `syntaks-defended`;
4. `view`;
5. `giveup`.

Acceptance check A6 queries for rated misses without one of these and expects 0.

### 3.6 Per size

| Size / komi | Prover | Defender | proven → | undecided → |
|---|---|---|---|---|
| 6×6, half-point \|komi\| ≤ 3.5 | deep | Syntaks native | proven play-out | unproven play-out |
| 6×6 komi 4.0 (6 served rows [C map-client §1.4]) | pns | none | solved | unrated miss |
| 4×4, 5×5 | pns | none | solved | unrated miss |
| 7×7, 8×8 | — (status `reserve`, not served) | — | — | — |

This is CLEANUP's "Syntaks native (df-pn off 6×6)" [D], with deep as the 6×6 prover.

**One edge CLEANUP's machine lacks: judging → solved off 6×6.** Today `slowSolve` handles it [C app.js:1093-1101]. Without that edge, a proven 5×5 win would have to be played out against Tiltak, against Sasha's rule [I from map-client contradiction 7]. The machine in §7 adds it.

### 3.7 Client code the judge removes

| Removed | Where | Lines |
|---|---|---|
| Off-tree pipeline in `userMove` | [C app.js:563-651] | 89 |
| `report`, `settleCheck`, `abandonCheck`, `abandonQuick`, pagehide, `flushHeld` | [C app.js:674-807] | 134 |
| play-on: `playOnDefender` … `endPlayOn`, `restoreLeft` | [C app.js:808-1070] | 263 |
| `fail`, `slowSolve` | [C app.js:1077, 1088-1101] | 15 |
| `public/playon.js` (cap functions move to the server) | whole file | 154 |
| `public/engine.js`, `public/engine-worker.js` (still, length, refute; review solver §7.5) | whole files | 228 |
| `public/syntaks.js`, `public/syntaks/worker.js`, `wasm/syntaks/*`, the 19.5 MB `syntaks.wasm` | whole files [C git ls-files; ls -la] | 70 + 108 + 302 |
| build-static lines for the WASM build and engine copies | [C build-static.sh:31-38, 40, 42-43, 45, 57] | ~8 |
| `scripts/test-playon.mjs`, `scripts/test-syntaks-wasm.mjs` | whole files | 251 + 47 |

---

## 4 · LOG

### 4.1 Which reading, and why

There are two readings:
- **(a)** CLEANUP's "outbox": a client-side queue that reliably delivers results.
- **(b)** A server-side, append-only record of every attempt, from which ratings can be recomputed and refunds applied.

**This plan takes (b), and (a) shrinks to almost nothing.** Once crux judges every move, it already holds the attempt as it happens, and there is no result left to deliver. The client "outbox" is just the one move request in flight, retried under its idempotency key (§7.3).

That deletes the held record, the Web Lock, `pageAlive`, the displaced-record resend, the pagehide keepalive and `flushHeld` [C app.js:41-81, 95-99, 790-807; playon.js:103-154]: 170+ lines and the three concepts CLEANUP names [D CLEANUP §6 "One outbox replaces held records, the Web Lock and `pagehide` sends"].

It also fixes a bug today's design has: an ordinary result whose single POST fails is lost [C app.js:695-717; api.js:53], and a failed keepalive is lost too [I: app.js:691 deletes the record before sending].

### 4.2 Schema

The existing `attempts` table [C server.js:45-51] gains the columns below, and old rows are kept: their new columns are NULL and `how = 'legacy'`. The `moves` table is new. Both are append-only: a decision writes the attempt's result columns once, and nothing updates them later.

```sql
-- one row per attempt, written at the first move, closed once (result columns written once)
ALTER TABLE attempts ADD id INTEGER;            -- = rowid for new rows; legacy rows keep rowid as id
ALTER TABLE attempts ADD seq INTEGER;           -- 1 = the attempt that counts; UNIQUE(user_id, puzzle_id, seq)
ALTER TABLE attempts ADD guest INTEGER;         -- users.name IS NULL at start (puzzle weight 0.5)
ALTER TABLE attempts ADD build INTEGER;         -- client ?b=
ALTER TABLE attempts ADD commit TEXT;           -- server git sha
ALTER TABLE attempts ADD rev INTEGER;           -- puzzles.rev at start (publish-puzzles bumps it on change)
ALTER TABLE attempts ADD theme TEXT, weight REAL;
ALTER TABLE attempts ADD how TEXT;              -- tree | book | proof | playout | disproof | rules | view | giveup | abandon | engine | undecided
ALTER TABLE attempts ADD why TEXT;              -- NULL = rated; hint | repeat | undecided | engine | abandon-proven | legacy-stale
ALTER TABLE attempts ADD before TEXT, after TEXT; -- JSON {u:{r,rd,vol}, p:{r,rd,vol}}
CREATE TABLE moves (
  attempt INTEGER NOT NULL, ply INTEGER NOT NULL,
  move TEXT, by TEXT NOT NULL,                  -- 'p' player | 'd' defender | 'a' act (hint/view/giveup)
  src TEXT NOT NULL,                            -- player | tree | book | deep | pns | syntaks | rules
  verdict TEXT,                                 -- ok | solved | miss | play | reply | proven:<len> | disproven | undecided
  cap INTEGER, nodes INTEGER, ms INTEGER, ts INTEGER NOT NULL,
  answer TEXT,                                  -- the JSON returned (idempotent replay)
  PRIMARY KEY (attempt, ply)
) WITHOUT ROWID;
CREATE TABLE adjustments (                      -- refunds and re-judges; never an UPDATE of attempts
  id INTEGER PRIMARY KEY, attempt INTEGER NOT NULL, ts INTEGER NOT NULL, by TEXT NOT NULL,
  rated_to INTEGER NOT NULL, user_delta REAL, puzzle_delta REAL, note TEXT
);
```

- **The log is the state.** An attempt in progress is rebuilt from its `moves` rows (replay into `Game`), so a restart or deploy loses nothing.
- **Defender replies are stored.** Play-outs therefore replay exactly. They cannot today, because only the player's `po` moves are logged [C app.js:993; map-server §3.3].
- **Ratings can be recomputed.** A replay applies Glicko-2 to rated attempts in order, using the stored `weight`, plus adjustments. It should reproduce `users` and `puzzles` exactly for every attempt after the cutover [I: rating.js is deterministic, and `before` gives the starting point].
- **Data that cannot be recovered:** attempts before the cutover lack `before`, `weight` and `guest` [C map-server §3.3], so they replay only approximately.

### 4.3 Privacy and retention

- **What is stored:** moves are tied to `user_id`, which the access log already records in the clear [C server.js:744 via map-server §5]. No IP, gid or token is stored.
- **Access log:** unchanged.
- **Retention:** indefinite, because the log is the rating ledger. Deleting a user deletes their `attempts`, `moves` and `adjustments` rows. Their past effect on puzzle ratings stays.
- **Size:** about 1,350 attempts existed at the snapshot [D SD header "~1,350 attempts at snapshot"]. The access log shows 521 and 644 results on 11-15 and 11-16 [C briefs/access.log]. At about 8 move rows per attempt and about 150 bytes a row, that is roughly 0.8 MB a day [I: ~650 × 8 × 150]. That is small enough to keep for good.

### 4.4 Refunds and re-judging

- **`scripts/rejudge.mjs`, nightly, at low priority on crux.** For each rated miss whose evidence is `disproof`, it re-runs the prover with 60 s.
  - If it proves a win, it inserts a book row and an `adjustments` row that reverses the attempt's user and puzzle deltas. The attempt row itself is untouched.
  - This is the "server-side async proof with automatic refund" that SD lists as not built [D SD §8.1].
- **The refund scripts on crux become `scripts/refund.mjs` in the repo.** Today they live in `~/tinue-alts/refund*.mjs` and do not touch puzzles [D SD §5.6]. The new script writes adjustments for both user and puzzle.
- **`REFUND_MARK` and `flaw = 2` are deleted** [C import.mjs:151-153; server.js:226]. A refunded move now has a book row, so the next player is credited. The picker penalty no longer has a cause (V6).

### 4.5 What the log replaces

| Replaced | Detail |
|---|---|
| `heldRec`, `pageLock`, `pageAlive`, `ownHeld`, `heldDisplaced`, `heldResend`, `deferredResendOk`, `resendAfterUpload`, `reporting`, `uploading`, `authEpoch` | [C app.js:41-81, 95-99; playon.js:103-154] |
| `MIN_MISS_BUILD` and `?b=` as a judgment | [C server.js:19-21, 631]. The build is still stored, as data. |
| the `log` column format `{m, ms, k}` | [C server.js:49, 110-124]. Old rows keep it. |
| `scripts/rerate.mjs` (pre-Glicko Elo fit, writes `rating` only) | [C rerate.mjs:7, 98-104] → `scripts/replay-ratings.mjs` (~60 lines) |

---

## 5 · Puzzle state migration: `kind, grade, status, book`

### 5.1 Mapping

| New | From | Rule |
|---|---|---|
| `kind` | `turn` | 1 → `turning`, 0 → `conversion`, NULL → `unscored` [C server.js:41]. `pre0` moves into `meta.pre0`, because the client caption reads it [C app.js:1568]. Bots' `turn` field is derived from `kind` [C server.js:307]. |
| `grade` | `grade` + `grade-overrides.jsonl` | Unchanged, A–D. Overrides become rows in crux's DB, since crux owns puzzles [D CLEANUP §3]. |
| `status` | `SERVED` + overrides | `served` if `turn = 1 OR grade = 'A'` [C server.js:236]; `held` for the 3 `hold-20261116` rows; `rejected` for hand pulls (grade D with a pull note); `reserve` for the rest, including all 1,481 7×7/8×8 rows [C map-state §3] |
| `book` | tree keys + `swing.alts` + `swing.altsAt` | §2.4 |
| (dropped) | `swing`, `flaw`, `turn` | after the old-client window (D11) |

- **Expected counts on lyra's DB:** served 26,478, held 3, reserve 44,631, rejected ≥ 0 [C map-state §0, §6.3]. Acceptance A1 requires `served` = today's `SERVED` count exactly, before any decided change.
- **Content history.** `puzzles` gains `rev INTEGER`. `publish-puzzles` (in flight) bumps it and appends the old `tree` to `puzzle_revs(id, rev, tree, ts)` so an attempt can name what it was judged against. This needs ~10 lines in that step.

### 5.2 Picker and daily

- **Picker.** It reads `status = 'served'` only. **Delete the fallback stage** [C server.js:239-243]. Without it, `CONVERT` and `UNSCORED` [C :220] have nothing to rank, and `FLAW`/`REFUNDED` go with it (§5.3). This is built on the in-flight in-memory picker. Its tuple loses `flaw`. PLAYED, PICK_WINDOW, the tiers and the U² draw stay, so the Z3 proof still applies with fewer terms [D CLEANUP §2 "minus the removed terms"].
- **Daily.** Three tiers [D CLEANUP "cut its seven tiers to three"]: served 6×6 turning points in band unplayed by a named user; served 6×6 in band; any served 6×6. It cannot come up empty while one served 6×6 row exists. That answers map-server's warning that tiers 5–7 guarantee a daily [C server.js:281-289].

### 5.3 What disappears

| Removed | Where |
|---|---|
| `flaw` | [C server.js:40; import.mjs:101-102, 151-153] |
| `FLAW`, `REFUNDED`, `refunded`, the flaw part of `tier` | [C server.js:212-226, 250-262] |
| `swingPublic` | [C :201-207] |
| `UNSCORED`, `CONVERT`, `pickMany`'s top-up | [C :220, 240-243] |
| 4 daily tiers | [C :281-289] |
| sidecar precedence and the superseded-sidecar refusal in `import.mjs` | [C import.mjs:53-102, 127-153] |
| `turn`/`flaw` duplicates in `meta.mine2` | data, migration only |

**FLAW is dropped, not derived.** Its stated purpose is ranking "one winning idea" puzzles higher [C server.js:216-217]. That is the verifier's job (cooks → `status`), so the picker should not do it a second time. Dropping it changes picks (V6).

---

## 6 · Offline pipeline: mine → verify → grade → import

| Stage | 6×6 | Other sizes | Removed |
|---|---|---|---|
| mine | the `deep` crate's walk (MINING stage 0, in flight) | none: existing labels frozen [D CLEANUP §4 "Leave existing 5×5 labels frozen"] | `mine-deep.mjs` 207, `shared/deep.js` 236, `mine-swing.mjs` 275, and optionally `mine-playtak.mjs` 114 |
| verify | `deep cert`: keys, cooks, faster wins, book rows, `status` [D CLEANUP §4 "One verifier … owns keys, cooks, faster wins and `status`"] | `book-init` once (§2.4) | `score-swing.mjs` 462; the syn6 and alt-wins scratch scripts (not in the repo) |
| grade | `grade.py` reading `deep cert`'s cook and decoy counts [D CLEANUP §4] | frozen | `scripts/grade/` except `grade.py`: composer_walk, composer_walk_tp, composer_show, feats, search_cheap, v2_walk, v2_forks, v2_fin = 374 lines |
| import | `publish-puzzles` (in flight), reading verifier JSONL: puzzle rows plus book rows, one transaction | — | `import.mjs` sidecar and grade logic, ~100 of 161 lines; `bench-pns.mjs` 105 |

**What this costs:** no new 4×4, 5×5, 7×7 or 8×8 puzzles until `deep` supports other sizes [I: SOLVER specifies 6×6 only]. No player sees this soon, because 18,535 5×5 rows are served [C map-state §3].

---

## 7 · The client

### 7.1 One state machine, `public/puzzle.js` (~200 lines), with a table test

```
loading → intro → play ⇄ judging → reply → play
                         judging → solved | missed | playout
                  playout → reply → playout | solved | missed
                  solved | missed → review → (Next) loading
```

**Transition table:**

| State | Event | Next state | Effect |
|---|---|---|---|
| loading | puzzle | intro | `busyUntil = now + 650 + 1000` |
| intro | done | play | — |
| play | move (local legality ok) | judging | POST /api/move; "Checking…" after 300 ms |
| play | hint | play | POST act=hint; highlight |
| play | solution | missed | POST act=view; animate the line |
| judging | ok | reply | play the reply after 450 ms |
| reply | shown | play | — |
| judging | solved | solved | — |
| judging | miss | missed | `busyUntil = now + 700`; show refutation |
| judging | play | playout | `busyUntil = now + 1500` (Give up) |
| playout | move | reply | POST; the reply comes back in the answer |
| reply (in playout) | reply | playout | — |
| reply (in playout) | solved / not solved | solved / missed | — |
| playout | giveup / solution | missed | POST act |
| solved / missed | — | review | free exploration, engine panel |
| review | next | loading | `next` came in the deciding answer |
| any | network error | same state | retry the same `ply` (outbox, §7.3) |

- **One input lock.** `busyUntil` replaces `TOO_SOON_MS`, `FRESH_MS`/`wakeActions`/`fresh`, `justViewed`, the 700 ms miss reset and the 1.5 s Give up [C app.js:493-510, 644-650, 853, 1469, 1687, 1689]. The durations stay as listed. One difference: board moves are locked for 1,000 ms after a new puzzle, not 500 ms (V12), because one lock covers every input.
- **`missed` is terminal.** That removes status `'retry'`, `S.misses`, outcome "Solved, after a miss", `needsRestore`, `pendingHint`/`pendingSolution` and the same-pending-move guard [C app.js:582, 1077, 1351, 1164, 1207]. This is the most visible change in the plan (V4). If Sasha says no, add `missed → play` (try again, unrated by first-result-counts) back for about 30 lines.

### 7.2 What happens to `app.js` (1,881 lines [C wc])

| Removed | Lines | Where |
|---|---|---|
| held machinery | 41 | :41-81 |
| upload trackers / auth epoch | ~10 | :95-104 |
| off-tree pipeline | 89 | :563-651 |
| report … endPlayOn, restoreLeft | 397 | :674-1070 |
| slowerWins, fail, provenKey, slowSolve | 24 | :1071-1101 |
| build check beyond one fetch | ~55 of 68 | :213-280 |
| guards | ~12 of 18 | :493-510 |
| review fallbacks | ~10 | :386-402 |
| card variants for checking / play-on / held / resend / notCounted | ~65 | :1405-1426 and ~45 lines of :1427-1539 [I: 31 lines there reference the removed states] |
| **gross** | **~700** | |
| added: glue to `puzzle.js` and to `/api/move` | ~80 | |

`app.js` ends near **1,250 lines**, and `puzzle.js` adds ~200.

### 7.3 The outbox

- **What it is.** An in-memory `{ply, body}` for the one move in flight. On network failure, retry with backoff (1, 2, 4 … 30 s) under the same `ply`. The board stays where it was.
- **No storage, no Web Lock, no pagehide.** If the page dies, the move never reached crux: the player never made it. On reload, `GET /api/attempt?puzzle=<id>` returns the open attempt's line, and play resumes. Today a reload mid play-out is an unrated miss [C app.js:790; playon.js:109-115], so this is better for players (V8).

### 7.4 Build check and next puzzle

- **Build check.** Keep one `version.json` fetch inside `loadNext`. On a new build, reload into the next puzzle. Delete the 10-minute interval, the visibility hook, the bar's mid-puzzle logic and the reload deferral [C app.js:240-243, 248-264, 310-314]. CLEANUP's premise ("With the server judging, an old client cannot produce a wrong rated result" [D §3]) holds only after D11 retires `/api/result` [C server.js:612-647]. Until then `MIN_MISS_BUILD` protects old tabs (§8).
- **Next puzzle.** `next` arrives in the deciding answer (§3.2). Delete `next.js` (115 lines), the `for=` and `n=` branches [C server.js:553-571] and `test-next.mjs`/`test-next-model.mjs` (490 lines). This holds only if phone time-to-next does not get worse [D CLEANUP §6 "Delete the queue only if time to next puzzle does not get worse on a phone"], and that is measured in D9. Cost: today a settled player's 10-puzzle queue survives a dropped connection [C next.js:13]. Without a network that queue no longer helps, because moves need crux anyway (V1).

### 7.5 Review: one engine a size, no fallbacks

| Size | Engine | Removed |
|---|---|---|
| 6×6, half-point \|komi\| ≤ 3.5 | crux `/api/analyze` (kept [C server.js:696]); on failure "engine unavailable" | the Tiltak and solver fallbacks [C app.js:375-381, 388-397] |
| 4×4, 5×5 (Tiltak's komi) | Tiltak WASM | the solver fallback [C app.js:388-401] |
| 6×6 komi 4, 7×7, 8×8 | none | `runSolver` [C app.js:398-402] |

`public/tiltak.js` stays, for review only. `shared/pns.js` and `shared/analyze.js` leave the static bundle [C build-static.sh:45].

---

## 8 · Old clients and the iOS app

| Client | What it calls | Plan |
|---|---|---|
| Gaelet (iOS) | `GET /api/daily` → `{day, puzzle{id,url,size,komi,rating,tps}}`; `GET /api/puzzle/:id` → `{id,tps,plies,themes,tree}` with `tree` = `"win"` or `{ptn: null\|{r,n}}` [C TinueAPI.swift:28-35, 62-77 via map-server §6.3] | Both routes keep these fields and this tree format forever. `/api/puzzle/:id` stays pure: it never starts an attempt. Gaelet never posts results, so the judge does not affect it. |
| web builds before the judge (open tabs) | `/api/next`, `/api/puzzle/:id` (reads `tree`, `alts`, `altsAt`, `pre0`, `turn`), `POST /api/result`, `/api/defend`, Syntaks WASM, Tiltak | **D7 (cutover):** set `TINUE_MIN_BUILD` to the judge build, so every miss from an old tab is unrated [C server.js:631]. Their wins stay rated, as today. `alts`/`altsAt` keep being served, from the book. **D11 (14 days later):** delete `/api/result`, `/api/defend` and `MIN_MISS_BUILD`. An old tab's result is then refused ("not counted" [C app.js:706]). Its play-out falls through to the deleted WASM (404), then to the deleted `/api/defend`, then Tiltak → `noengine`: unrated every time [C app.js:961-970], **never a false rated miss**. Its own checkBuild reloads it between puzzles when nothing is held [C app.js:310-314]. |
| bots (`/api/group`, `/api/daily`) | `botPuzzle.turn` [C server.js:307] | Derived from `kind`. |
| `/p/:id` share pages | `meta.lastMove`, `meta.history` [C server/share.js:130-172] | Unchanged. |

Two risks during the 14-day window:
- An old tab can still record a false rated **win**, for example ps505288's `c4-` via `alts`. That is the same as today [C map-state §4]. If Sasha wants it closed, D7 can also stop serving `alts` entries that the book lacks.
- After D11, a few players on old tabs see "not counted" until they reload.

---

## 9 · Deletions, by file and function

Counts are lines at 3026736 [C wc / ranges].

| File | Deleted | Lines | Commit |
|---|---|---|---|
| public/app.js | §7.2 table | ~700 (−80 glue) | D7, D8, D9 |
| public/playon.js | whole (cap functions move to the server) | 154 | D7 |
| public/engine.js | whole | 81 | D7 |
| public/engine-worker.js | whole (`still` moves to server/prove-pns.mjs) | 147 | D7 |
| public/syntaks.js, public/syntaks/worker.js, NOTICE | whole | 70 + 108 + 62 | D7 |
| wasm/syntaks/ (patch, build.sh, atomic stub) | whole; plus the 19.5 MB built wasm | 302 | D7 |
| public/next.js | whole | 115 | D9 |
| scripts/build-static.sh | WASM build, engine/syntaks/next copies, pns/analyze copy | ~10 | D7, D9 |
| scripts/test-playon.mjs, test-syntaks-wasm.mjs | whole | 298 | D7 |
| scripts/test-next.mjs, test-next-model.mjs | whole | 490 | D9 |
| server/server.js | stage 2, CONVERT/UNSCORED/FLAW/REFUNDED, daily tiers 4–7 | ~30 | D3 |
| server/server.js | `for=`, `n=` | ~18 | D9 |
| server/server.js | `/api/result`, `MIN_MISS_BUILD`, `/api/defend`, `swingPublic`, `flaw`/`turn`/`swing` DDL | ~55 | D11 |
| scripts/import.mjs | sidecars, turn/flaw, grades file, REFUND_MARK | ~100 | D12 |
| scripts/score-swing.mjs, mine-swing.mjs, mine-deep.mjs, shared/deep.js | whole | 1,180 | D12 |
| scripts/grade/* except grade.py | whole | 374 | D12 |
| scripts/rerate.mjs, bench-pns.mjs | whole | 210 | D12 |
| **gross removed** | | **~4,400** | |
| **added**: server/judge.js ~220, prove-pns.mjs ~45, move route ~90, schema ~40, puzzle.js ~200, glue ~80, book-init ~60, replay-ratings ~60, refund ~60, rejudge ~60, tests ~450 | | **~1,300** | |

**Concepts removed:**
- 4 of 7 off-tree paths;
- 8 of 10 ending kinds;
- 4 of 5 input guards;
- 4 result transports;
- 2 puzzle columns and 12 sidecar files;
- 3 browser engine uses: the df-pn check, Syntaks WASM, and the refute and solver worker;
- 4 picker terms;
- 4 daily tiers;
- 1 server judgment hack (`MIN_MISS_BUILD`);
- 1 build-time WASM toolchain.

---

## 10 · Commits, in order

Each commit is small, passes `npm test`, and carries its line delta in the message. "Rollback" says how to undo it without data loss. The in-flight work comes first and is not redone here: the deep crate with `deep prove/up/cert` and JSON output, the in-memory picker, the deploy/publish split, and the removal of `/api/guest-result` and `votes`.

| # | Commit | Test | Rollback | Δ lines |
|---|---|---|---|---|
| D1 | Schema: `kind`, `status`, `rev` on puzzles; tables `book`, `moves`, `adjustments`; new `attempts` columns. Migration fills `kind`/`status`; `book-init.mjs` fills the book. Nothing reads them yet. | Migration on a copy of crux's DB: served count unchanged (A1); book 75,906 ± rows, 0 conflicts (A2); ps505288 `c4-` absent | Drop the new columns and tables (no reader) | +100 |
| D2 | `server/judge.js` + `prove-pns.mjs` + deep runner, one semaphore. No route yet. | `test-judge.mjs`: SOLVER §8 positions; MINING regression positions; pd575074 `4c3+` proven; 200 pd 6×6 rows: every key ok, every alt proven; 1,000 random wrong moves: deep "disproven" never contradicts a pns proof (A4) | Delete files | +300 |
| D3 | Picker and daily read `status`; delete stage 2, the four terms and daily tiers 4–7; 7×7/8×8 become reserve. **Needs Sasha's yes (V5, V6, V7).** | `verify-picker.py` with fewer terms; test-server picks served rows only; the daily is never empty on the local DB | `git revert`; the columns stay | −30 |
| D4 | `POST /api/move` + `GET /api/attempt`: tree/book/prove, play-out via Syntaks, log writes, idempotent `ply`, lazy close | test-server: clean solve; on-tree reply; book proven 6×6 → play-out won → solved rated; disproven → rated miss; undecided → play-out lost → rated miss; Syntaks killed mid-game → unrated / solved-if-proven; restart mid-play-out resumes; repeat attempt `seq = 2` unrated; hint; view; guest minted at the first move | Remove the route; no client uses it | +150 |
| D5 | `public/puzzle.js` + `scripts/test-puzzle.mjs` (every state × event) | the table test | Delete files | +320 |
| D6 | app.js uses `puzzle.js` + `/api/move` behind `?judge=1`. Sasha and the testers play on production. | a manual checklist on phone and desktop; A5 latency from the access log | Drop the flag | +80 |
| D7 | **Cutover.** Flip the default; delete the old path (§3.7, §4.5, §7.2 rows for the judge); delete playon/engine/engine-worker/syntaks + WASM + tests; `TINUE_MIN_BUILD` = this build. **Visible (V1–V4, V9–V12, V14).** | npm test; A6 query = 0 after 48 h; the public check | Redeploy the previous Pages build and set `TINUE_MIN_BUILD` back. The move rows written meanwhile are kept, because they are valid attempts. | −1,550 |
| D8 | Review: one engine a size; checkBuild → one check between puzzles | test-server analyze; manual | revert | −80 |
| D9 | `next` in the deciding answer; delete next.js, `for=`, `n=`, test-next* **only if A7 holds** | A7: time from Next to a playable board on a phone ≤ today's | revert | −620 |
| D10 | `rejudge.mjs`, `refund.mjs`, `replay-ratings.mjs`; delete REFUND_MARK | A8 replay exact; rejudge on the 34 historic refunds' moves finds them [D SD §5.6] | revert | +130 |
| D11 | 14 days after D7: delete `/api/result`, `MIN_MISS_BUILD`, `/api/defend`, `swingPublic`, `alts`/`altsAt`; drop `swing`, `flaw`, `turn` columns (`ALTER TABLE DROP COLUMN`) | test-server; Gaelet against the dev server; access log shows no old-build `/api/result` for 3 days | Re-add the routes from git; columns from the pre-D11 backup | −110 |
| D12 | Offline: `publish-puzzles` reads verifier output; delete sidecar code, score-swing, the JS miners, deep.js, grade aux scripts, rerate, bench-pns | publish of the MINING hard100 set on a copy; served pool differs only by decided changes and verifier rejections (A9) | revert (git keeps them) | −1,860 |

D1, D2, D4 and D5 can run in parallel. D3 needs only D1. D12 needs `deep cert` (in flight).

---

## 11 · What players see (each needs Sasha's yes)

| # | Change | Cost or benefit |
|---|---|---|
| V1 | Every move goes to crux. When crux or the network is down, nothing is playable. | Today a fetched puzzle plays offline, and its result is lost if the upload fails [C app.js:717]. Now nothing plays offline, and nothing is lost. |
| V2 | 6×6 replies always come from native Syntaks on crux. | Replies take ~1.2 s + round trip, against a local 1.5 s search [C app.js:923]. Crux load: `POOL = 2` [C syntaks.js:16]. Today's volume is small: 32 `/api/defend` lines in the log copy [C briefs/access.log]; SD counts 12 play-on attempts [D SD §8.1]. |
| V3 | No Tiltak play-on. An undecided move on 4×4, 5×5 or 6×6 komi 4 is an unrated miss. | The ratings are the same (unrated either way); players lose the game against Tiltak. |
| V4 | A miss ends the puzzle: no "try again", no "Solved, after a miss". | The most visible change. Today's 'retry' [C app.js:1077, 1351] costs about 30 lines to keep. |
| V5 | 7×7/8×8 leave the size menu; rare-theme filters can say "No puzzles match" (no fallback stage). | 1,481 puzzles become unreachable except by link; for example 6×6 `quietMove` has 5 served rows out of 130 [C map-state §1.4]. |
| V6 | FLAW and REFUNDED picker terms dropped. | Somewhat different picks. |
| V7 | Daily tiers 7 → 3. | It may pick a different 6×6. |
| V8 | A reload mid-puzzle resumes it. | Better than today. |
| V9 | 6×6: a move disproved only under the threat model but undecided under deep `q=1` is played out, not charged. | More play-outs, fewer rated misses (SD §8.2 decision #5, "Proposal A9a", adopted in effect). |
| V10 | Cards: two endings plus one line of reason. The refutation line comes from the judge, and off 6×6 often there is none. | Today a 'no' starts a refute worker [C app.js:638-642]. |
| V11 | Review on 6×6 shows "engine unavailable" when crux is down (no Tiltak fallback); 7×7/8×8 and komi 4 have no engine. | — |
| V12 | Board locked 1,000 ms (not 500) at a new puzzle. | — |
| V13 | No queue; `next` comes with the verdict. | Shipped only if it is not slower on phones (D9). |
| V14 | Leaving a proven play-out is unrated even when moving to another puzzle in the page (rated 'left' today). Closing the tab for good leaves an unproven play-out unrated (rated 'unload' today). | Lenient. |
| V15 | Old tabs: misses unrated for 14 days, then results refused until reload. | — |

---

## 12 · Acceptance checks

| # | Check | Number |
|---|---|---|
| A1 | After D1, `status = 'served'` equals today's `turn = 1 OR grade = 'A'` count | exactly 26,478 on lyra's DB [C map-state §0]; crux's own count on crux |
| A2 | Book | ≥ 75,000 rows for the served pool; 0 length conflicts; every 6×6 row `checked = 1`; every alt re-proved or listed as dropped |
| A3 | Judge on stored puzzles | 100% of tree keys → ok; 100% of book alts → proven; 0 `miss` on any book position |
| A4 | Disproof soundness | over 1,000 random 6×6 wrong moves and every alt-wins refutation [D SD §2.6: 155 refuted]: 0 cases of deep "disproven" with a pns or deep-q1-60 s proof |
| A5 | Latency (server, access log, 7 days after D7) | `/api/move` on-tree/book p99 ≤ 20 ms; judge p95 ≤ 2.5 s (6×6) / 3.5 s (others); `/api/next` p99 < 50 ms [D CLEANUP "Done when"] |
| A6 | No rated miss without evidence | `SELECT COUNT(*) FROM attempts WHERE rated=1 AND win=0 AND how NOT IN ('disproof','rules','playout','view','giveup')` → 0 |
| A7 | Time to next puzzle on a phone | median ≤ today's (measure before D9 on the same phone and network) |
| A8 | Rating replay | `replay-ratings.mjs` reproduces `users` and `puzzles` rating/rd/vol for post-cutover attempts within 1e-9 |
| A9 | Served pool after D12 | differs from pre-D1 only by ids listed as a decided change (D3) or a verifier rejection, each with a reason [D CLEANUP "Done when"] |
| A10 | Code | `npm test` green; the report lists lines, files and columns removed: target ≥ 3,000 net lines, 9 files, 3 columns |
| A11 | Gaelet | an unchanged iOS build loads `/api/daily` and `/api/puzzle/:id` and plays the daily, before and after D11 |

---

## 13 · Questions for Sasha, each with a recommendation

| # | Question | Recommendation |
|---|---|---|
| Q1 | Every move judged on crux (no play offline)? | Yes. It is the only way the server judges, and offline results are already lost today. |
| Q2 | Missed is terminal (V4)? | Yes for this draft. If you want "try again", keep it for ~30 lines, unrated by first-result-counts. |
| Q3 | Drop Tiltak play-on for undecided moves on 4×4/5×5 (V3)? | Yes: it never counted (§8.2 row 6), and it is the only reason Tiltak defends. |
| Q4 | Stop serving 7×7/8×8 (V5)? | Yes: no scoring, no defender, 0 served rows. Keep them by link. |
| Q5 | Remove the picker fallback, so rare filters can run dry (V5)? | Yes, and hide theme chips with < 10 served rows for the chosen size. |
| Q6 | Drop FLAW and REFUNDED (V6)? | Yes. The book credits alternative wins, and the verifier owns cooks. |
| Q7 | Leaving a proven play-out is unrated (V14)? | Yes. A proven win abandoned is not a demonstrated miss. |
| Q8 | Old-build misses unrated for 14 days, then `/api/result` gone? | Yes. 14 days covers tabs that stay open for days. |
| Q9 | Should a deep-q1 disproof be a rated miss with nightly re-judge + auto-refund, or should every 6×6 non-book move be played out (no rated miss without a game)? | The former. The latter deletes the 6×6 prover call but turns every wrong 6×6 move into a game. |
| Q10 | The queue (V13)? | Measure first (A7). Delete it only if it is not slower. |
| Q11 | No new 4×4/5×5 puzzles until `deep` supports those sizes? | Yes. 18,535 served 5×5 rows exist [C map-state §3]. |

---

## 14 · Where the documents and the code disagree (relied on above)

- **"Engines in a rated result: df-pn, Syntaks native, Syntaks WASM, Tiltak"** [D CLEANUP]. Tiltak is never rated [C playon.js:60, 68-69].
- **"Play-out endings 9"** [D CLEANUP]. There are 10 kinds and 9 are reachable. `unload` came after SD [C app.js:773, 1025-1061; playon.js:85-91].
- **CLEANUP's machine has no judging → solved edge and no missed → play edge.** Today both exist: `slowSolve` and 'retry' [C app.js:1077, 1093-1101]. §7.1 adds the first and drops the second (V4).
- **"crux owns puzzles"** [D CLEANUP §3]. Today lyra's export overwrites crux's rows on every deploy [C deploy-crux.sh:36; import.mjs:108-112]. The in-flight publish split is a precondition.
- **"7 sidecars", "3 import runs"** [D CLEANUP]. There are 12 sidecar files, and a rebuild needs at least 5 runs [C map-state §2].
- **"With 5×5 conversions unserved, only about 1,100 rows need a grade"** [D CLEANUP §4]. No such decision is recorded, and 4,792 5×5 A conversions are served [C map-state §6.3]. This plan freezes them instead.
- **"C++ `deep` solver"** [D CLEANUP §5]. In flight it is a Rust crate (`solver/deep/src/*.rs`, 2,780 lines, `prove`/`up` subcommands at main.rs:65-66 [C]). `cert` is not there yet [I: grep finds none].
