# tinue: implementation plan for book, judge and log (draft written for rated-result safety)

Draft, 2026-11-17. This reconstructs the plan that CLEANUP.md refers to ("The implementation plan covers the three redesigns (book, judge, log)"). It is written to one priority: **at no step may a real win be recorded as a rated miss, and each step must roll back on its own.** Other drafts weigh other things. This one does not try to be balanced.

**Tags.** Every factual statement is tagged:
- **[DOCS]** quotes or cites CLEANUP / MINING / SOLVER (the briefs) or `docs/system-design.html` (SD §n, untracked).
- **[CODE path:line]** is code at main 3026736. HEAD has since moved to 6e79c6c (the Funnel redirect), which shifts later server.js lines by about 20.
- **[DB]** is a read-only query on lyra's `data/tinue.db` (not crux).
- **[LOG]** is the access-log copy `briefs/access.log` (2026-11-08 07:18Z to 11-17 08:38Z).
- **[INF]** is my inference, with the reason.

Untagged imperative text ("add", "the judge does") is this plan's proposal. Proposals that change anything a player sees are marked **VISIBLE** and collected in §11 for Sasha's yes.

The maps `plan/map-client.md`, `map-server.md` and `map-state.md` carry the details. I re-checked the facts this plan rests on: server.js:612–647, app.js:576–807, playon.js:1–154, engine.js:45–77, engine-worker.js:66–101, syntaks.js:12–170 and api.js:45–60, all at 3026736.

---

## 0. The safety argument in one page

### 0.1 How a real win can become a rated miss today

| # | Channel | Evidence |
|---|---|---|
| F1 | The still-wins check says `'no'` when **no Tak-threat win** exists. A win that needs a quiet move or a flat count is invisible to it, and `'no'` is charged as a rated miss. | [CODE engine-worker.js:70-73, 86-88]. [DOCS SD §8.1] "A live 'no' is a rated miss though the check is threat-only". The "1,181 sampled moves" behind the comment "was not located". |
| F2 | The deep trees and `alts` are threat-model lists. A quiet win at a non-root node of a deep puzzle reaches only the live check (F1). | [DOCS SD §8.1] "Threat-only deep trees past R ≥ 7"; pd575074 and three others had faster quiet wins. |
| F3 | Off 6×6, `'no'` is the only verdict between an off-tree move and a rated miss. There is no play-out. | [CODE app.js:620-651; playon.js:34-37] |
| F4 | An old build above `MIN_MISS_BUILD` keeps its bugs. Below it, misses are unrated and wins count. | [CODE server.js:631-632; DOCS SD §3.7] |
| F5 | The server trusts `win` and `casual` from any client and never re-judges. A false rated miss is found only when a person notices one. | [CODE server.js:612-645]. [DOCS SD §8.1] "Not built: server-side async proof with automatic refund" |
| F6 | Refunds are manual scripts on crux. They revert neither RD/vol nor the puzzle. Only 20 of the 34 refunds are attributed to a script. | [DOCS SD §5.6] |

These are **by design, not bugs** (Sasha's rules): losing a play-out of a winning move within the cap against Syntaks is a rated miss [DOCS SD §8.2 "Rated miss when defended"; CODE playon.js:71-91, SD §3.3 "a real win not converted within the cap is a rated miss"]. The plan keeps that.

### 0.2 Invariants every step must keep

- **I1. A rated miss needs positive evidence.** It is allowed only when one of these holds:
  - (a) the line ended the game without the player winning;
  - (b) a **completed** disproof under a named model (today `threat`) is attached to the move;
  - (c) a play-out against the rated defender ended unsolved under Sasha's rules (`lossRated`, [CODE playon.js:91]).

  One function, `ratedMiss(evidence)`, decides this, and a nightly audit checks every `rated = 1, win = 0` row for its evidence.
- **I2. Failure is never evidence.** These all become `undecided`, never `refuted`: timeout, budget exhausted, 503/429, crash, OOM, a lost network, an unknown book version, an illegal engine move, a queue that is full. `undecided` leads to a play-out where a rated defender exists, and otherwise to an unrated result. This is today's rule for timeouts, "A timeout is never a 'no'" [CODE engine.js:47], extended to every server failure.
- **I3. Monotone rollout.** Until the gate in §10 (G2) opens, the server may only turn a client's rated miss into an unrated result or a solve. It never creates a rated miss the client did not send.
- **I4. Reproducible verdicts.** Every verdict records what it was judged against:
  - the puzzle content hash;
  - the book revision;
  - the prover build and budget;
  - the defender's replies.

  So any past result can be re-judged.
- **I5. Automatic detection.** Every rated miss is re-judged with a bigger budget within 24 h. A proven win becomes a refund proposal.

### 0.3 Order in one line

**Log → book → shadow judge (post-hoc, then live) → veto → outbox → server decides for new builds → server-run play-out → deletions → puzzle-state migration.**

The log goes first because nothing can be measured or refunded exactly without it. The judge decides nothing until shadow data shows it never disagrees in the dangerous direction (§10, G1–G2).

---

## 1. BOOK

### 1.1 What it is

A table of **proven wins keyed by position**: "position after the attacker's move (defender to move) → `win_len`". [DOCS MINING] "emit tinue's tree format and `book` rows: position after the move, `win_len`".

It answers one question in a lookup: after this move, does the attacker still have a proven forced win, and how long is it?

It holds wins only. A missing row means "not known", **never** "refuted" (I2). That one rule makes an incomplete book safe: a gap costs time (the prover runs), never a false miss. [INF]

### 1.2 Key

`pos = <TPS board>|<side to move>|<halfKomi>`, with the move number stripped. Built with `Game.toTPS()` [CODE shared/tak.js:98] by one shared function, `bookKey(game, komi)`, in `shared/book.js`. The client, the server, `deep cert` and the builder scripts all use it.

- Komi is in the key because flat wins depend on it [INF].
- The text is stored, not a 64-bit hash. tinue's own keys had about 33 effective bits on the crux copies [DOCS SD §2.1 via map-state §6.4].
- No symmetry canonicalisation in v1. It merges only 384 ids [DOCS SD §2.8], and every producer would have to agree on it, which is a new way to get a wrong key. Revisit later.

### 1.3 Schema (crux, additive)

```sql
CREATE TABLE book (
  pos TEXT NOT NULL,          -- bookKey
  attacker INTEGER NOT NULL,  -- 1 | 2
  win_len INTEGER,            -- plies from pos, defender to move; NULL = proven, length unknown
  exact INTEGER NOT NULL,     -- 1 = a disproof at win_len-2 exists
  model TEXT NOT NULL,        -- full | threat | threat+1quiet
  proof TEXT NOT NULL,        -- tree-brute | tree-dfpn | refine | solver-quiet | altwins | syn6 | deep-cert | live
  checked INTEGER NOT NULL,   -- 1 = proof checker replayed it (SOLVER §5)
  puzzle_id TEXT,             -- producer row (provenance only; the key is the position)
  rev INTEGER NOT NULL,       -- book revision that added it
  retired_rev INTEGER,        -- set instead of DELETE: past attempts stay re-judgeable
  commit_sha TEXT, ts INTEGER,
  PRIMARY KEY (pos, attacker, rev)
);
CREATE TABLE book_rev (rev INTEGER PRIMARY KEY, ts INTEGER, commit_sha TEXT, rows_added INTEGER, rows_retired INTEGER, note TEXT);
```

- **Insert-only.** A correction retires the old row (`retired_rev`) and adds a new one. A live lookup reads the newest row of `(pos, attacker)` that is not retired.
- **No length conflicts.** On insert, a second unretired row for the same `(pos, attacker)` with a different `win_len` fails loudly. map-state found 0 conflicts across 496,036 tree positions [DB, map-state §6.4].
- **Which rows can carry a verdict.** Proof sources that were never checked (`tree-dfpn`: deep trees "never fullDefense-confirmed" [DOCS SD §8.1]) may still be stored. They only ever say "win", and a wrong win gives a false solve, not a false miss [INF]. For **cap** purposes, a row with `exact = 0` is treated as length unknown.

### 1.4 Size and contents

| Set | Rows | Source |
|---|---|---|
| Served pool, tree keys | 69,226 distinct (6×6: 20,246) | [DB, map-state §6.4] |
| Served pool, `alts` + `altsAt` | 6,680 (6×6: 2,459). No length stored. | same |
| Served total | 75,906 (6×6: 22,705) | same |
| Whole DB (everything stage 2, links or the daily can reach) | about 592,442 | same |

- **Bytes.** At an estimated 150–200 B a row with its index, the served set is about 12–15 MB and the whole DB about 90–120 MB [INF from 6×6 TPS ≈ 60–100 chars].
- **What to load first.** crux's disk is 95% full [DOCS SD §8.1]. So v0 loads the served pool plus every 7×7/8×8 row (those are reachable through stage 2 [CODE server.js:239-243]). The rest follows once disk is freed (CLEANUP part 1).
- **1-ply puzzles** contribute no rows. The rules see the win [DB, map-state].
- **Known-bad alts are left out.** ps505288's `c4-` "could not be proved" [DOCS grade-overrides via map-state §4]. Book v0 imports an alt only if the producer marked it proven, and it carries an explicit exclusion list that starts with ps505288/c4-.

### 1.5 Who writes it

1. **v0 (this plan, step B1).** `scripts/book-build.mjs` replays every tree key and every alt with `shared/tak.js`. That is the logic in `plan/.work/book.mjs`.
   - Tree positions get `win_len = 1 + depth(next)` and `proof` set from the row's prefix and `meta.prover` (tags as in map-state §6.4).
   - Alts get `win_len NULL`.
2. **Lengths for alts.** `deep up` for 6×6, `shortestTinue`/pns elsewhere.
3. **v1.** The verifier (`deep cert` for 6×6, in flight in `solver/deep`) emits book rows with `checked = 1`, `proof = 'deep-cert'` and exact lengths. [DOCS MINING "Changes … 5"]
4. **Live proofs.** A proof found while judging (§2) is checked with the proof checker and inserted as `proof = 'live'`. One live row then serves every later player.

### 1.6 Publishing

- It rides on the in-flight `publish-puzzles` step: changed rows only, one transaction, snapshot first [DOCS CLEANUP part 3; deploy worktree 81d4340].
- A publish writes one `book_rev` row. `puzzles.book_rev` names the revision a puzzle's rows were last verified at.
- **Rollback:** point `TINUE_BOOK_REV` at the previous revision. Lookups ignore rows with `rev` greater than it. Nothing is deleted.
- **Clients.** `/api/puzzle/:id` and `/api/next` gain a `book: [[pos, len|null], …]` field holding this puzzle's rows (about 2.9 per served puzzle [INF: 75,906 / 26,478]).
  - A web client can then show "proven win" for a book hit with no request, and judge book hits while offline.
  - The field is additive. iOS ignores unknown fields [DOCS map-server §6.3, JSONDecoder].

### 1.7 What it replaces

| Today | Replaced by | When |
|---|---|---|
| `swing.alts` and `altsAt` in the payload, and `slowerWins()` [CODE app.js:1072-1075; server.js:204-207] | `book` field plus the server lookup | after the legacy window (§9). Old tabs read `alts`; removing it early sends quiet alts into a threat-only check, which is F1 again [INF] |
| per-puzzle `S.proven` / `S.proofPlies` cache [CODE app.js:587, 615-616] | book rows plus `live` rows | deletion step X1 |
| quick check as the first answer for known moves | book lookup | decide step D1 |
| `flaw = 1` derived from alts [CODE import.mjs:101-102] | `EXISTS(book row at the root other than a key)` | P4 |

---

## 2. JUDGE

### 2.1 One function

`judge(puzzle, bookView, line, proverResults) → Verdict` in `shared/judge.js`. It is pure: no I/O, no clock. The server wraps it with the I/O (book reads, prover jobs, the defender). Being pure, it is table-testable, and a past attempt can be re-run against its logged inputs.

Per player move it returns one of:

| Verdict | Meaning | Next state |
|---|---|---|
| `ended-win` | the move ends the game for the player (any route) [CODE app.js:557-559] | solved |
| `ended-loss` | the move ends the game against the player [CODE app.js:586] | missed (I1a) |
| `tree` | key of the current node | reply (the stored reply) |
| `proven{len, source}` | book row, or a completed proof | 6×6 rated: playout (proven). Elsewhere: solved on the spot (`slowSolve` parity, [CODE app.js:624]) |
| `refuted{model, nodes}` | a completed disproof | missed (I1b), or playout under option A9 (§12 Q1) |
| `undecided{reason}` | budget, timeout, queue full, engine down, crash, unknown version | 6×6 rated: playout (unproven). 4×4/5×5: unrated Tiltak play-on in the browser. 7×7/8×8: held, settled later or unrated |

`ratedMiss(evidence)` and `ratedSolve(evidence)` live beside it, so these rules exist in one place:
- `gameRated`, `winRated`, `lossRated`, `stalls` (moved from [CODE playon.js:54-101]);
- the hint rule (casual);
- the stale-build rule.

### 2.2 Per-size policy (today's rules kept)

| Board / komi | Book | Prover (server) | Defender in a rated play-out | Unproven and undecided |
|---|---|---|---|---|
| 6×6, half-point \|komi\| ≤ 3.5 | yes | `deep` native, threat model first (q=0), then q=1 | Syntaks native on crux (target; **VISIBLE**, see §11 V1) | play-out vs Syntaks |
| 6×6, other komi (4.0: 6 served rows [DB, map-client §1.4]) | yes | `deep` (it takes half-komi [DOCS SOLVER §1]) | none: Syntaks rejects \|komi\| > 3.5 [CODE server.js:483-484] | today: Tiltak, unrated. Plan: same, client-side and unrated (§2.6) |
| 4×4, 5×5 | yes | `pns.js` df-pn in a child process ("df-pn off 6×6" [DOCS CLEANUP table]) | none rated ("No play out w tiltak" [DOCS SD §8.2]) | unrated Tiltak play-on in the browser, as today; a later proof makes it a solve |
| 7×7, 8×8 | yes | `pns.js` child process, 60 s | none | held up to 60 s; then unrated, as today [CODE app.js:629-637, 758-759] |

Proven off-tree wins keep today's split:
- 6×6 half-point komi: a **proven play-out** vs Syntaks [CODE playon.js:81].
- Elsewhere: solved on the spot [CODE app.js:624; DOCS SD §8.2 "On 4×4 and 5×5 a proven win stays solved on the spot"].

So the state machine needs a `judging → solved` edge (§7).

### 2.3 Budgets and the prover pool

`server/prover.js` copies `server/syntaks.js`'s design [CODE syntaks.js:16-28, 150-196]: a child-process pool, nice 10, bounded queues, deduplication of identical requests, abort on disconnect, and an LRU. It differs in three ways:

- results that are a **proof** are written to `book` (`proof = 'live'`) only after the checker passes;
- a **disproof** is cached in memory only, keyed by `(pos, model, budget)`;
- a crash, a kill or OOM resolves `undecided{reason: 'crash' | 'oom' | 'killed'}` and never rejects into a `refuted` [I2].

| Knob | 6×6 (`deep`) | other sizes (`pns.js`) | Why |
|---|---|---|---|
| processes | 2 | 1 | crux CPU is shared with the API and Syntaks (POOL = 2) [CODE syntaks.js:16]; the API is P0 [INF from SD §8.1 "batch jobs share crux's CPU"] |
| memory per process | table `lp=20` (≈ 190–375 MB [INF: SOLVER says 1.5 GB per process, half that at lp=22]) | `--max-old-space-size=1024` | pns.js keeps "~28 KB per full-defense node" [CODE engine.js:48-49] |
| quick phase | 2.0 s wall, q=0 | today's major budgets `[[3e4,2.5e4],[1e5,2.5e4]]` [CODE engine.js:51] | answers within today's 2.5 s window [CODE engine.js:51] |
| final phase | to 60 s: q=0 unlimited, then q=1 b2 = 20k [DOCS SOLVER §6] | to 60 s | today's `maxMs` [CODE engine.js:51] |
| checker | every proof, before it is used [DOCS SOLVER §5] | `fullDefense` confirmation as today [CODE engine-worker.js:92-94] | a proof must be a proof |
| queue | 6 interactive + 2 re-judge; full → `undecided{queue}` at once | 3; full → `undecided{queue}` | fail fast into a play-out, never into a miss |

**Verdict strength.** `refuted` from `deep` at q=0 has the same model as today's `'no'` (threat-only), so decide mode keeps parity. q=1 disproves more, but "can miss zugzwang" [DOCS SOLVER §4]. The verdict records which model refuted, so a later change of rule (A9) can be applied and audited.

**Latency targets.**
- Book hit: ≤ 50 ms p99 on the server.
- Prover quick verdict: ≤ 2.5 s p95, the same window players have today.
- Judge round trip on the client: p50 ≤ 400 ms for book hits. The tunnel adds 0.1–0.4 s [DOCS CLEANUP part 2].

### 2.4 API

Attempts open **lazily**: at the first event that would today create a held record or send a result. That is an off-tree move, a play-out start, a hint, Solution, or the solve itself. On-tree moves are buffered and sent with it.

This keeps "played" meaning what it means today. Opening at the first on-tree move would make a puzzle someone merely touched count as played. [CODE app.js:599-600, 634 write the held record only at an off-tree move; INF]

```
POST /api/attempt                 {attemptId: uuid, puzzleId, build, theme?, guest?:{gid}}
  → {attemptId, mode: 'shadow'|'decide', first: bool, puzzleHash, bookRev, token?}
     idempotent on attemptId; the attempt is bound to the user at open (guest minted here, as newGuest today)

POST /api/attempt/:id/events      {events: [{seq, kind, ply?, move?, ms, clientVerdict?}], build}
  kind ∈ move | hint | view | giveup | left | unload
  → {ackedSeq, state, verdicts: [{seq, verdict, next, reply?, cap?, evidence}], result?: {win, rated, why, userDelta, user}}
     idempotent on (attemptId, seq); same body → stored answer; different body → 409, attempt marked 'conflict' (unrated)

GET  /api/attempt/:id             → {state, verdicts since seq?, result?}   (polling while judging/held)
```

- **The attempt id is a capability.** It is 128 random bits held only by the client. Events need no token, so a sign-in or sign-out mid-attempt cannot redirect a result to another account. That replaces `owner`, `authEpoch` and `answerOwnsToken` [CODE app.js:49; playon.js:146-154].
- **Serialised per attempt.** Each attempt's events are handled through an in-memory promise chain, so two requests can't interleave around an `await` on the prover. The rating transaction stays synchronous, as `/api/result` is now [CODE server.js:637-644; DOCS map-server §1.3 step 5].
- **First attempt rule.** Today it is the first `(user, puzzle)` row to reach the server [CODE server.js:626-627]. With attempts it is the first attempt **opened**. Later attempts are marked `first = 0` and never rated. The unique index on `(user_id, puzzle_id)` for `attempts` (CLEANUP part 1; test b74d0b2 in the server worktree) stays the backstop. **VISIBLE (minor)**, §11 V10.

### 2.5 Play-out driven by the server (decide step D2)

- **The judge's `playout` answer carries Syntaks's first reply.** Each later player move is an event, and its answer carries the next reply or the ending. One round trip per move, against two today (client to WASM or crux, then a result at the end) [INF].
- **The play-out state is the event list.** `Game` is rebuilt from the puzzle plus the events. A server restart loses nothing but the in-flight Syntaks search, which the next event re-asks [INF: syntaks cache is memory only, CODE syntaks.js:23].
- **The cap and its waits move into shared code the server runs:** `capMoves`, `provenCap`, `capWait` [CODE playon.js:8-30, 133-138]. The server knows the proof length from the book row or the live proof, so the `'length'` wait disappears once the book has lengths. Until then a NULL length keeps today's rule: running out with the length unknown is unrated [CODE playon.js:91].
- **Endings collapse to 2: solved, or not** [DOCS CLEANUP table]. The log keeps the reason (`why`), because ratedness depends on it:

| Server-side ending | result | rated? (Sasha's rules, unchanged) |
|---|---|---|
| player's road or flat win | solved | rated (`winRated`) |
| a proof lands mid-game (prover final phase) | solved | rated ('proved') |
| proven play-out, defender cannot reply (engine down after retries) | solved | rated ('proved' [CODE app.js:956]) |
| cap reached, defender's road, flats or draw | not | `lossRated` (Syntaks moved, no fallback, not stalled; proven with length unknown → unrated) |
| `giveup` / `left` events | not | `lossRated`, stall-exempt if a reply was owed > 6 s [CODE playon.js:59, 101]. The server knows exactly when it owed a reply. |
| `unload` event (flushed from the outbox on the next load) | not | today's rule: proven → unrated, unproven → `lossRated` [CODE playon.js:91] |
| no event for 30 min (attempt expires) | not | **unrated**, `why = 'expired'`. **VISIBLE**, §11 V7. Today an unproven play-out abandoned by pagehide is rated through keepalive. |
| unproven play-out, defender unavailable (503 after one retry and a 20 s wait) | not | unrated ('noengine'), and the prover keeps running: a proof still makes it a solve [CODE app.js:970; SD §3.3] |

`resign` stays gone: `RESIGN_UNPROVEN = false` makes it unreachable [CODE playon.js:85-86].

### 2.6 What stays in the browser

- The Tiltak play-on on 4×4/5×5 and 6×6 komi 4. It is unrated both ways except by proof [CODE playon.js:60, 68-69]. The server need not trust it: the client logs its moves as `unrated-play` events, and only a server proof can turn it into a solve.
- The review engines (display only).
- The "why it fails" refutation, also display only [CODE app.js:638-642].

### 2.7 Client code it removes

These are listed in Part 2 with the step that removes them.

---

## 3. LOG

### 3.1 Which reading, and why

CLEANUP uses "log" for two things:
- a server-side record of attempts ("crux owns puzzles, book and attempts" [DOCS CLEANUP part 3]);
- the client's "One outbox replaces held records, the Web Lock and pagehide sends" [DOCS CLEANUP part 6].

This plan takes both, as one design: **an append-only server record of every attempt, fed by a client outbox that delivers each event exactly once.** The reasons:

1. **Refunds need it.**
   - A refund can be exact only if user and puzzle `{rating, rd, vol}` before and after are stored. Today they are not, so refunds can't revert RD/vol [DOCS SD §5.6; map-server §3.3].
   - The refund mark depends on an in-place mutation of attempt rows [CODE import.mjs:151-153], which a separate refund event replaces.
2. **Re-judging needs it.** It needs the defender's replies, which are not logged today: "only the player's `po` moves are logged" [CODE app.js:993; map-server §3.3]. It also needs the puzzle version: the tree is overwritten on every import [CODE import.mjs:108-112].
3. **The outbox and the server log are one mechanism.** The outbox's job (deliver each event once) is exactly what an append-only log keyed by `(attempt_id, seq)` makes idempotent. With idempotent writes the duplicate-tab problem dissolves, and the Web Lock and `pageAlive` probe existed only for that [CODE app.js:41-80; INF].

### 3.2 Schema (crux, additive; `attempts` stays as the rating projection)

```sql
CREATE TABLE attempt_log (
  attempt_id TEXT PRIMARY KEY,         -- client uuid; legacy results get 'L' || attempts.rowid
  attempts_rowid INTEGER,              -- link to the projection row (NULL until closed / for unrated non-first)
  user_id INTEGER NOT NULL, guest INTEGER NOT NULL,   -- guest = name IS NULL at the time (not recoverable today, map-server §1.4)
  puzzle_id TEXT NOT NULL, puzzle_hash TEXT NOT NULL, book_rev INTEGER,
  build INTEGER, server_commit TEXT, mode TEXT,        -- legacy | shadow | decide
  first INTEGER NOT NULL, state TEXT NOT NULL,         -- open | judging | playout | held | closed | expired | conflict
  opened_ts INTEGER, closed_ts INTEGER, client_ms INTEGER,
  result INTEGER,                      -- 1 solved, 0 not
  why TEXT,                            -- ending reason: win|proved|out|road|held|gaveup|left|unload|expired|noengine|hint|view|ended-loss|refuted|…
  rated INTEGER, rated_why TEXT,       -- null if rated; else hint|stale-build|repeat|noengine|stalled|tiltak|unload-proven|length-unknown|expired|veto-book-win|conflict|refund
  theme TEXT, theme_w REAL, guest_w REAL,
  user_before TEXT, user_after TEXT, puzzle_before TEXT, puzzle_after TEXT  -- JSON {rating, rd, vol}
);
CREATE TABLE attempt_event (
  attempt_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- move | reply | verdict | hint | view | giveup | left | unload | shadow
  ply INTEGER, move TEXT,
  source TEXT,                         -- player | tree | book | engine:syntaks-native@<sha> | engine:syntaks-wasm@<sha> | engine:tiltak@<sha>
  verdict TEXT, evidence TEXT,         -- JSON: book {pos, rev, len} | prover {engine, sha, model, nodes, ms, budget, result} | cap
  client_verdict TEXT,                 -- shadow: what the client decided
  PRIMARY KEY (attempt_id, seq)
);
CREATE TABLE refund (
  id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL, ts INTEGER, by TEXT, reason TEXT,
  before TEXT, after TEXT,             -- JSON of the projection fields changed
  puzzle_side INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0
);
```

- **Size.** About 150 results a day [LOG: 1,375 result POSTs in 9 days]. At an estimated 10 events of about 150 B per attempt, that is about 0.25 MB a day, or 80–100 MB a year [INF]. No pruning is needed for years.
- **Privacy.**
  - The log stores `user_id` (already in clear in the access log [CODE server.js:744; map-server §5]), moves, timings and verdicts.
  - It stores no IP, gid, token or user agent. Keep it that way: a gid in the log would let anyone who reads it take over a nameless guest row through `newGuest` [CODE server.js:159-163; map-server §1.4].
  - The access log's HMAC scheme is unchanged.
- **Retention.** Keep for as long as ratings exist, because ratings are a replay of it. If a user asks for deletion, null out `user_id` in their rows and keep the puzzle side.
- **Projection.** `attempts` keeps being written in the same transaction, so everything that reads it today keeps working: history, the picker's played set, `REFUND_MARK`, `rerate.mjs` [CODE server.js:249, 649-654; import.mjs:151-153]. The log is the record. `attempts` is derived from it.

### 3.3 The outbox (client)

`public/outbox.js` keeps one localStorage list, `tinue.outbox`, of `{attemptId, puzzleId, build, opened, events[], ackedSeq, aliveAt, state}`.

- **Append before send.** Every event is appended synchronously before any request goes out. A crash between the two loses nothing.
- **Sender.** One sender per page posts all unacked events of every attempt, its own and others'. Sends are idempotent, so two tabs sending the same events is harmless.
  - Retries back off: 1, 2, 4, 8 … up to 300 s while the page is visible.
  - It also sends on `online`, on `visibilitychange` to visible, and at boot.
  - Every send is a full `fetch` with a timeout, never `sendBeacon` and never `keepalive`, so nothing is sent "for the dying page".
- **Liveness.** The owning tab writes `aliveAt` every 5 s. At boot, an attempt in state `playout` or `open` whose `aliveAt` is more than 15 s old gets an `unload` event appended. That replaces `pagehide` and `abandonCheck` [CODE app.js:768-790] and the Web Lock probe [CODE app.js:75-80].
- **Removal.** An attempt leaves the outbox when the server's answer has `state ∈ closed | expired | conflict` and every event is acked. Cap: 50 attempts. Past it, the oldest **closed** ones drop first, and an unacked one is never dropped.
- **Storage failure** (private mode, quota). The outbox runs in memory and the card says results may not survive a reload. **VISIBLE (text only)**. Today's heldRec has the same exposure silently [CODE app.js:51-69, INF].

### 3.4 What it replaces

- held records (`heldRec`, `heldResend`, `heldDisplaced`, `deferredResendOk`, `resendAfterUpload`);
- the Web Lock, `pageAlive`, `ownHeld`, `flushHeld`;
- the pagehide `abandonCheck`;
- the "a failed upload is simply lost" path [CODE app.js:717; map-client §4.1, Contradiction 8]. Ordinary results get retries for the first time.
- On the server: the stale-build guard's role (only for legacy, §9), the manual refund scripts on crux, and `rerate.mjs`'s role. It is pre-Glicko [CODE rerate.mjs:7] and replaced by `scripts/replay-ratings.mjs`.

---

## 4. Failure cases (the core of this draft)

| Case | Today | Plan (decide mode) | Never a rated miss because |
|---|---|---|---|
| Prover times out / budget | quick `pending` → play-on (6×6) or held (7×7/8×8); 60 s → `unknown` → unrated [CODE app.js:613-637, 758] | `undecided{timeout}` → playout / held / unrated, same table | I2: only a completed disproof is `refuted` |
| Prover crashes / OOM / killed | worker `onerror` → `unknown` [CODE engine.js:71] | `undecided{crash}` and a stderr line; the attempt's final phase is re-queued once | same |
| Prover queue full | n/a (browser) | `undecided{queue}` immediately | same |
| Syntaks native down / 503 / 429 at play-out start | WASM, then Tiltak → unrated [CODE app.js:930-969] | proven move: solved on the spot ('proved'). Unproven: one retry, then a 20 s wait, then `noengine` → unrated, prover still running | `noengine` is unrated [CODE app.js:970] |
| Syntaks returns an illegal move | crux evicts the cache entry, 503 [CODE server.js:499] | same, then the 503 row above | same |
| Syntaks slow (> 6 s owed) and player leaves | `stalled` → unrated [CODE playon.js:101] | the server timestamps when the reply was owed and when it was sent, so stall is computed exactly | same rule, no client clock |
| Client → crux request times out (8 s) | n/a | outbox keeps the event and resends; the server answers with the stored verdict (idempotent) | a missing answer is not a verdict |
| Player offline at an off-tree move | the browser judges locally | book hit in the payload → proven locally (server confirms later). Otherwise state `held` with the card "Can't reach the server: this move is checked when you're back online"; the board stays playable unrated. On arrival the server judges: `proven` → solve; `refuted` (completed) → miss as today's `'no'`; `undecided` → unrated (no play-out possible after the fact, like today's 7×7 held unknown) | `undecided` is unrated |
| crux entirely down | results lost if the single 20 s POST fails [CODE api.js:53; app.js:717] | outbox holds everything; delivered within 300 s of crux returning | nothing is decided without the server |
| Server restart mid play-out | n/a (browser) | state rebuilt from events; the Syntaks reply is re-asked on the next event | — |
| Duplicate sends (retry, two tabs, back button) | first-attempt check; displaced-record logic [CODE app.js:57-64] | PK `(attempt_id, seq)`; same body → stored answer; different body → 409 + `conflict` → unrated | a conflict is unrated |
| Same puzzle in two tabs | first result to arrive counts | first attempt **opened** counts; the other is `first = 0`, unrated | — |
| Sign-in / sign-out mid-attempt | `owner` hash and `authEpoch` [CODE playon.js:146-154] | attempt bound to its user at open; events need only the id | — |
| Old build (no attempt API) | `MIN_MISS_BUILD`: misses below it unrated [CODE server.js:631] | legacy path + veto (§9). After G2, every legacy miss is unrated | a legacy miss is unrated after G2 |
| Book row wrong (claims a win) | n/a (an alt does the same: ps505288) | a false **solve**, not a miss. The checker flag and the nightly audit catch `checked = 0` rows used in a solve | a book row never yields a miss |
| Book row missing | n/a | prover runs | absence is not evidence |
| Book revision rolled back mid-attempt | n/a | the attempt keeps its `book_rev`; rows above the cap are ignored for new attempts only | — |
| Bug in `shared/judge.js` | n/a | shadow phases (S, C) measure it before it decides; table test; `TINUE_JUDGE=shadow` rolls back in one restart | gate G1 requires 0 server-refuted / client-proven disagreements |
| Puzzle republished (tree changed) mid-attempt | the client keeps its fetched copy | the attempt keeps `puzzle_hash`; the server judges against the version it opened with (puzzle rows are versioned by hash in `puzzle_version`, P1) | — |
| Clock skew / hidden tab | visible-time accounting in the browser [CODE engine.js:56-68] | server budgets are server-side CPU/wall time; play-out stall uses server timestamps | — |

---

## 5. Puzzle-state migration: `turn, grade, flaw, swing.alts, altsAt, sidecars` → `kind, grade, status, book`

[DOCS CLEANUP table]. Follows map-state §6, with the safety decisions made explicit.

| New | From | Rule | Visible? |
|---|---|---|---|
| `kind` | `turn` 1/0/NULL → `turning`/`conversion`/`unscored` [CODE import.mjs:98-102] | written by the scorer/verifier, never by import | no, if `pre0` is kept for the caption [CODE app.js:1568] |
| `pre0` | `swing.pre0` | kept as a column (it is shown) | no |
| `grade` | unchanged, overrides last [CODE import.mjs:136-144] | — | no |
| `status` | `served` iff `turn = 1 OR grade = 'A'` [CODE server.js:236]; `held` for `hold-20261116` overrides; else `reserve` | backfilled **exactly** from today's predicate; equality test on every row | no |
| `book` | `swing.alts`/`altsAt` + tree positions | §1 | no |
| `miner` | id prefix p/pd/ps/pc/pdg | new column; `source` already holds 'PlayTak' on every row [DB, map-state §6.1] | no |
| evidence | `swing.{pre2, pre4, lostBefore, alt, esc}` and sidecar keys | `puzzle_evidence` table keyed by id; nothing at runtime reads them [CODE server.js:204-207] | no |
| `puzzle_version` | — | `(puzzle_id, hash, tree, komi, tps, book_rev, ts)` on every publish that changes a row; attempts point at the hash | no |

**Safety-relevant rules.**
- The picker keeps its stage 2 over `reserve` [CODE server.js:239-243]. Excluding `reserve` would empty 7×7/8×8 and the rare-theme filters [DB, map-state §6.3]. **VISIBLE** if changed, so it is not changed here.
- `/api/result` and the judge rate any row whose `status ∈ served | reserve`. `held` and `rejected` rows are still returned by `/api/puzzle/:id` (Gaelet, links), but attempts on them are **unrated** (`rated_why = 'held'`). Today they are rated [CODE server.js:612-645], and ps505288's unproven alt is a false solve [DB, map-state §4]. **VISIBLE**, §11 V11.
- `FLAW` (+100) and `REFUNDED` (+400) [CODE server.js:220-226] keep their weights. FLAW comes from the book; REFUNDED comes from `refund` rows (`applied = 1`, not superseded by a later book row at the root). REFUND_MARK keeps running until the picker reads the new source, so the switch is one commit with an equality test (P4).

---

## 6. Offline pipeline: mine → verify → grade → import

[DOCS CLEANUP table, part 4].

1. **mine.** The existing miners and MINING's funnel emit candidates. Output rows carry `miner` and the git commit [DOCS CLEANUP part 1 "Write the commit sha into each output row"].
2. **verify.** One verifier owns keys, cooks, faster wins and `status` [DOCS CLEANUP part 4].
   - 6×6: `deep cert` (in flight) with MINING's changes: every key, backtracking, cooks first, book rows.
   - Other sizes: pns.js plus `shortestTinue` lengths.
   - Output: book rows (`checked = 1`), a status proposal per id (`served` / `reserve` / `rejected` + reason), and lengths.
   - **Rejections never apply themselves.** They go into a diff report for Sasha [DOCS CLEANUP "Done when": "differs only by decided changes and verifier rejections"].
3. **grade.** One script reads the verifier output and writes `grade`. Overrides still apply last.
4. **import (= publish-puzzles, in flight).** Changed rows only, one transaction after a snapshot. Writes `puzzle_version`, `book` (insert-only) and `book_rev`. Never touches `rating/rd/vol/attempts/solves` once played [CODE import.mjs:112].

**Safety rule for the pipeline.** A publish that would make a **tree key** position non-winning (a book row retired with no replacement while the tree still lists the key) is refused. Such a key would become an off-tree move judged by the prover, a new path to a miss [INF].

---

## 7. Client state machine

CLEANUP part 6's machine plus the three edges parity needs. Each added edge is flagged.

```
loading → intro → play ⇄ reply → solved → review
                   │               missed → play (retry, as today's 'retry')   [kept: removing it is VISIBLE, §11 V8]
                   │               missed → review (Solution / Next)
                   └→ judging → solved          [proven off 6×6: slowSolve parity, CODE app.js:624]
                              → missed          [ended-loss, or refuted with evidence]
                              → playout ⇄ reply → solved | missed
                              → held → solved | missed | (unrated) missed   [offline, or 7×7/8×8 pending]
```

- **One input lock**, `busyUntil`, replaces TOO_SOON (500 ms), FRESH (1000 ms), justViewed (600 ms), the 700 ms after a miss and Give up's 1500 ms. The durations stay the same [DOCS CLEANUP part 6; CODE app.js:493-510, 644-650, 853]. `justViewed` gains the Enter path, which it misses today [CODE app.js:1720]. That is a bug fix, not visible.
- **Every state is a pure function of `(puzzle, events, server answers)`**, so the table test drives it with recorded event lists. That includes every row of §4.
- **The outbox is the only writer of results.** No state sends anything directly.

---

## Part 2 · Deletions (by file and function)

CLEANUP says "The plan's part 2 lists the deletions". Each item is deleted only at the step named, after its gate.

| File | Function / constant (3026736 lines) | Replaced by | Step |
|---|---|---|---|
| public/app.js | `heldRec` (51-69), `pageAlive` (75-80), page lock, `ownHeld`, `reporting`/`uploading` (95-96) | outbox | X1 |
| public/app.js | `report` (676-724): `casual` computation (685-686), keepalive branch (691), held re-stamp (694) | server result in the events answer | X1 |
| public/app.js | `settleCheck` (729-765), `abandonCheck` (768-776), `abandonQuick` (780-789), pagehide listener (790), `flushHeld` (793-807) | server `held` state + outbox `unload` | X1 |
| public/app.js | off-tree pipeline in `userMove` (586-637): `provenKey`, `S.proven`, `S.proofPlies`, `slowerWins` (1072-1075), quick check call, minor/major split, `S.uncheckedMoves` | `judging` state → `/api/attempt/:id/events` | X1 |
| public/app.js | `slowSolve` (1093-1101) | `judging → solved` driven by the server verdict | X1 |
| public/app.js | `syntaksReply` (918-940), `LOCAL_MIN_NODES` (917), the WASM-then-crux-then-WASM chain, `po.slowLocal` | server-run play-out | X2 (after D2) |
| public/app.js | rated Tiltak fallback in `defenderTurn` (961-969), `po.fallback` | `noengine` → unrated (server) | X2 |
| public/app.js | `makeProven` (880-895), `setProofLength` (896-912), cap waits in `playOnMove` (996-1012), `visibleTimeout` (861) | book length + server cap | X2 |
| public/app.js | `TOO_SOON_MS`, `FRESH_MS`, `wakeActions`, `justViewed` and the 700/1500 ms checks (493-510, 1429, 1469-1472, 1684-1689) | `busyUntil` | X3 |
| public/app.js | `checkBuild` interval and visibility triggers (240-243), mid-puzzle bar hiding (248-263), reload deferral (310-314) | one check between puzzles [DOCS CLEANUP part 3] | X4 (after legacy is all unrated) |
| public/playon.js | `heldResend` (109-115), `heldDisplaced` (120-121), `resendAfterUpload` (144), `deferredResendOk` (149), `answerOwnsToken` (154), `quickOutcome` (126) | outbox, attempt capability | X1 |
| public/playon.js | `resigns` (43), `RESIGN_UNPROVEN`, `mayResign` (85-86) | — (unreachable today) | X0 (any time) |
| public/playon.js | `gameRated`, `unratedWhy`, `winRated`, `lossRated`, `lossWhy`, `stalls`, `STALL_MS`, `capMoves`, `provenCap`, `capWait`, `CAP_WAIT_MS` | **moved** to `shared/judge.js` (server runs them; the client imports them for cards) | S1 (move), X2 (client copies gone) |
| public/engine.js | `checkStill` (51-77), `proofLength` (80) | server prover | X1 / X2 |
| public/engine-worker.js | `'still'` (69-101) and `'length'` (102-110) handlers | server prover | X1 / X2 |
| public/syntaks.js | the whole Syntaks WASM defender (and its Cache-API idea, CLEANUP part 2) | Syntaks native | X2, only with Sasha's yes (V1) |
| server/server.js | `swingPublic`'s `alts`/`altsAt` (204-207) | `book` field | X5 (after the legacy window) |
| server/server.js | `MIN_MISS_BUILD` stale rule (21, 631) | legacy = unrated (§9) | X4 |
| server/server.js | stateless `GET /api/defend` (701-702) | attempt-bound replies | X2 (kept until no build that calls it is seen for 7 days) |
| scripts/import.mjs | `setTurn`/swing precedence/supersession guard (53-134), `REFUND_MARK` (151-153) | publish-puzzles + status + refund table | P4 |
| crux ~/tinue-alts/refund*.mjs | manual refunds | `scripts/refund.mjs` | L3 |
| scripts/rerate.mjs | pre-Glicko MAP fit | `scripts/replay-ratings.mjs` | L4 |

---

## 8. Commit sequence

Each commit is small, has a test in `npm test` (or a named script), and rolls back alone.
- **Server switches:** `TINUE_JUDGE = off | shadow | veto | decide`, `TINUE_LOG`, `TINUE_BOOK_REV`. They are set in `deploy-crux.sh`'s plist and take one restart.
- **Client switches:** the server tells the client which mode to use (`mode` in `/api/attempt`), so going from decide back to shadow needs no client deploy.
- **The client keeps its local judging path until X1.** Steps before X1 are reversible by an env change alone.

### Phase L: log (nothing visible)

| # | Commit | Test | Rollback |
|---|---|---|---|
| L1 | `attempt_log`, `attempt_event`, `refund` tables, CREATE IF NOT EXISTS, no writers | test-server: schema present, idempotent startup | tables unused |
| L2 | `/api/result` writes an `attempt_log` row (`'L'+rowid`) in the same transaction: build, `server_commit` (from revision.json, deploy split in flight), guest-at-time, theme + weights, before/after `{rating, rd, vol}` for user and puzzle, `rated_why`, `puzzle_hash`. The answer gains `why` (additive; old clients ignore it). | test-server: each result yields one log row; `rate(before)` reproduces `after` exactly; 100 random results fuzzed | `TINUE_LOG=0` |
| L3 | `scripts/refund.mjs`: dry-run by default; writes a `refund` row; reverts the user exactly from `user_before/after` when the row has them, else today's subtraction; optional `--puzzle` side; **also** writes the legacy signature (`rated=0`, `user_delta` kept) so `REFUND_MARK` still fires [CODE import.mjs:151-153] | fixture DB: refund then replay = never played; REFUND_MARK marks it | script unused |
| L4 | `scripts/replay-ratings.mjs`: recompute ratings from the log in ts order | fixture; on crux (read-only copy) reproduces live ratings for all post-L2 attempts within 1e-9 | script unused |

### Phase B: book (nothing visible)

| # | Commit | Test | Rollback |
|---|---|---|---|
| B1 | `shared/book.js` (`bookKey`), `book`/`book_rev` tables, `scripts/book-build.mjs` (served pool + 7×7/8×8; exclusion list with ps505288/c4-) | 0 length conflicts; every served tree key's position present; win_len = 1 + depth(next) on all; random 500 replays | `TINUE_BOOK_REV=0` |
| B2 | publish-puzzles ships book rows insert-only and writes `book_rev` (on top of the in-flight split) | test-deploy (fake crux, deploy worktree 0808d8e): rev N+1 adds, rev rollback hides | rev pointer |
| B3 | `book` field in `/api/puzzle/:id` and `/api/next` payloads | test-server: field present; iOS fixture decode (TinueAPI.swift shape) unchanged; daily unchanged | drop field |
| B4 | lengths for alts: `deep up` (6×6) / shortest (others) fill `win_len`; `deep up` run on 200 stored `pd` rows first and every mismatch reported [DOCS MINING Setup] | lengths match `plies` on tree positions; mismatches listed, not applied | rev pointer |

### Phase S: shadow judge (nothing visible)

| # | Commit | Test | Rollback |
|---|---|---|---|
| S1 | `shared/judge.js` (pure) + `ratedMiss`/`ratedSolve`; playon.js's rating rules moved into it and re-exported from playon.js (client unchanged) | table test: every row of map-client §1.4 and §2, every row of §4 here; test-playon still green | revert one file |
| S2 | `server/prover.js` pool (`deep` for 6×6, pns.js child for others) with the typed verdicts | fault injection: SIGKILL, OOM (tiny heap), hang (timeout), queue full → `undecided` every time; a refuted verdict only from a completed search object; checker runs on every proof | not wired yet |
| S3 | **post-hoc shadow**: after each legacy `/api/result` with a `log`, re-judge every logged `miss` move (line rebuilt from the tree, since the attempt's `puzzle_hash` matches) via book then prover; write `shadow` events; write a daily `false-miss-candidates` report (client rated miss, server `proven`) | fixture with pd575074's quiet move: client miss → candidate; budgets respected under load | `TINUE_JUDGE=off` |
| S4 | nightly re-judge of all rated misses in the last 7 days at 10× budget (q=1), at `taskpolicy -b nice` [memory note: crux background QoS] | 1 CPU-hour cap honoured; report lists proven wins; nothing applied | disable the launchd job |
| S5 | **veto** (`TINUE_JUDGE=veto`): a legacy rated miss whose missed position is a **book** hit (synchronous lookup, no prover on the request path) is recorded unrated, `rated_why='veto-book-win'` | test-server: a quiet alt played on an old build → unrated; a refuted move still rated | `TINUE_JUDGE=shadow` |

### Phase C: new client, client still decides (nothing visible)

| # | Commit | Test | Rollback |
|---|---|---|---|
| C1 | server routes `/api/attempt`, `/events`, `GET` (idempotent, serialised per attempt, guest minted at open) | test-server: 1,000 random event streams with 30% duplicates, 30% reordering, a restart mid-stream → one log row per attempt, events exactly once, 409 on a conflicting resend | routes unused |
| C2 | `public/outbox.js` and attempt ids. The client sends events **beside** today's `report()` (which now carries `attemptId`); held/WebLock code untouched | node harness with fake fetch and storage: drop/duplicate/kill-page at random points across 1,000 simulated attempts → 0 lost, 0 duplicate rows | client flag `OUTBOX=0` (server-sent) |
| C3 | client posts each off-tree move with its own decision as `clientVerdict`; the server judges in shadow and logs the comparison; defender replies logged with their engine | comparison report renders; no latency added to the client (fire-and-forget) | mode `off` |

**Gate G1** (see §10) before any D step.

### Phase D: the server decides, for new builds only

| # | Commit | Test | Rollback |
|---|---|---|---|
| D1 | `mode = 'decide'` for builds ≥ `JUDGE_MIN_BUILD`: the client renders `judging` from the server verdict (book hits locally first), offline → `held`; the server derives win/rated from events and ignores `win`/`casual`. **At the same deploy** raise `TINUE_MIN_BUILD` to `JUDGE_MIN_BUILD`, so every legacy miss is unrated (wins still count) | table test of the state machine on recorded event lists; staging run of every §4 row with crux's engine stopped, then killed | server `mode = 'shadow'` (client falls back to its local path, still present) |
| D2 | server-run play-out: the `playout` answer carries Syntaks native's reply; cap/stall/endings on the server. **Needs Sasha's yes (V1).** | scripted games: engine stopped mid-game (proven → solve, unproven → `noengine` unrated), restart mid-game, a 7 s reply then Give up → stalled unrated | server flag `PLAYOUT_SERVER=0` → client's local defender path (still present until X2) |
| D3 | attempt expiry (30 min without events → `expired`, unrated); outbox `unload` on boot | test-server with a fake clock | expiry off |
| D4 | off-6×6 prover verdicts decide (4×4/5×5/7×7/8×8); Tiltak play-on stays client-side and unrated | as D1 per size | per-size flag |

**Gate G2** before any X step.

### Phase X: deletions (Part 2). One-way unless the build is reverted.

| # | Commit | Precondition | Test | Rollback |
|---|---|---|---|---|
| X0 | delete `resign` code | none | test-playon | revert |
| X1 | delete client held machinery and the client off-tree pipeline (Part 2 rows marked X1) | G2 | state-machine table test; outbox harness | revert the client build (the server still serves `mode=decide`) |
| X2 | delete the client defender chain, WASM defender, `/api/defend` | G2 + 7 days with no `/api/defend` from builds < D2 [LOG check] | play-out scripts | revert |
| X3 | `busyUntil` | none after X1 | guard timing test (same durations) | revert |
| X4 | legacy `/api/result` = always unrated; `MIN_MISS_BUILD` removed; `#checkBuild` → one check between puzzles | G2 | test-server | revert |
| X5 | drop `alts`/`altsAt` from payloads | 7 days with no legacy result POST [LOG] and X4 live | iOS fixture decode; old-client fixture: alt → judged by the server | re-add the fields |

### Phase P: puzzle state (after X1 so the client no longer reads `swing`)

| # | Commit | Test | Rollback |
|---|---|---|---|
| P1 | `kind`, `status`, `pre0`, `miner` columns + `puzzle_version`, backfilled | `status='served'` set == `SERVED` predicate on all 71,112 rows [DB] | columns unused |
| P2 | picker (in-memory, in flight) and daily read `status`/`kind` with stage 2 over `reserve` intact | test-next-model 6 invariants; picker simulation identical on a crux copy | revert to the predicate |
| P3 | `held`/`rejected` attempts unrated (V11) | test-server | revert |
| P4 | FLAW from book, REFUNDED from `refund`; `REFUND_MARK` and the sidecar precedence retired | ranking equality test on a crux copy (every row's score term equal) | revert |
| P5 | verifier output drives `status`, via Sasha-approved diff only | diff report: 0 unexplained ids | rev pointer |

---

## 9. Old clients and the iOS app

- **Old web tabs** keep posting `POST /api/result?b=…{win, casual}` "for days" (task note). In this log copy, superseded builds stopped within hours, and the 905 build-less POSTs were last seen 11-16 19:15Z [LOG]. The rules over time:
  - **Up to S5:** unchanged (`MIN_MISS_BUILD` [CODE server.js:631]).
  - **From S5:** veto, i.e. a book-proven "miss" is recorded unrated.
  - **From D1:** every legacy miss is unrated (`TINUE_MIN_BUILD = JUDGE_MIN_BUILD`). Legacy wins count as today, because unrating them would be a visible punishment for an old tab.
  - **From X4:** legacy results are all unrated, and recorded so they are not a free retry.
- **Payload compatibility.** `alts`, `altsAt`, `turn`, `pre0` and `tree` stay in `/api/next` and `/api/puzzle/:id` until X5, because old tabs judge with them [CODE app.js:588, 1568].
- **iOS (Gaelet)** reads `/api/daily` `{day, puzzle{id, url, size, komi, rating, tps}}` and `/api/puzzle/:id` `{id, tps, plies, themes, tree}`. It judges locally and never posts [CODE TakMessages TinueAPI.swift:12-77, PuzzleView.swift:152-161 via map-server §6.3].
  - Nothing in this plan changes those fields. `tree` stays the canonical puzzle line; the book is additive.
  - B3 and X5 each carry a decode test against a fixture of those exact shapes.
  - If Gaelet ever posts results, it uses the attempt API. There is no special case.

---

## 10. Acceptance checks (numbers)

| Check | Target |
|---|---|
| L2 replay | `replay-ratings.mjs` reproduces live user and puzzle `{rating, rd, vol}` for 100% of post-L2 attempts, abs error < 1e-9 |
| B1 book | 0 length conflicts; 100% of served tree-key positions present; 0 rows from the exclusion list |
| B4 lengths | `deep up` equals `plies` on ≥ 199/200 sampled `pd` rows, every mismatch explained [DOCS MINING] |
| S2 faults | 0 `refuted` verdicts under 1,000 injected crash/timeout/OOM/queue-full runs |
| C1/C2 delivery | 1,000 simulated attempts with 30% drops, 30% duplicates and random page kills: exactly one log row per attempt, 0 lost events, 0 rated results from conflicts |
| Book hit latency | ≤ 50 ms p99 server time over a day of traffic |
| Prover quick | ≤ 2.5 s p95 for 6×6 judge calls; the Syntaks reply median stays ≤ 1.3 s server time (today 1.2 s [LOG]) |
| Re-judge | 100% of rated misses re-judged within 24 h, within 1 CPU-hour a night |
| Deploy | `npm test` green at every commit; `check-public` passes after each deploy |
| Served pool | after P5, the pool differs from today's only by Sasha-approved ids; 0 unexplained [DOCS CLEANUP "Done when"] |

**Gate G1 (before D1)** needs ≥ 14 days in shadow and ≥ 300 off-tree judgments. Off-tree moves per day are unknown and are measured in S3 [INF: about 150 results a day, LOG]. Over that period:
- 0 cases of server `refuted` where the client proved a win, or where the line was later played out to a win;
- every client rated miss that the server proved is explained, and a refund is proposed;
- server `undecided` at most 1.2 × the client's `pending`/`unknown` rate. More would mean more unrated play, which is a regression, not a safety failure.

**Gate G2 (before X)** needs 14 days in decide mode with:
- 0 refunds caused by the judge;
- 0 attempts stuck in `judging` or `held` for more than 24 h;
- outbox delivery ≥ 99.9% within 300 s of connectivity;
- S4 finding no proven-win rated misses that come from the judge itself.

---

## 11. What players see (each item needs Sasha's yes)

| # | Change | Step | Recommendation |
|---|---|---|---|
| V1 | Play-out replies come only from Syntaks native on crux, no WASM. Latency per reply ≈ 1.2 s + 0.1–0.4 s network, against WASM's 1.5 s. When crux is busy, games become unrated (`noengine`) instead of switching engines. | D2, X2 | yes: the server must see and record the replies to re-judge. Keep WASM until G2 as the client fallback, and it makes the game unrated. |
| V2 | A miss whose move the book proves is shown "Not rated: that move wins (checked after)". | S5 | yes: today it is a rated miss and a refund later. |
| V3 | Misses from old tabs are unrated (wins still count). | D1 | yes |
| V4 | Offline off-tree move: "checked when you're back online"; the result arrives later. | D1 | yes |
| V5 | **A9**: on 6×6, a move refuted only under the threat model is played out instead of charged [DOCS SD §8.2 row 5 "framed as closing the main hole"]. | D1 option | yes. It closes F1, the largest known false-miss channel, at the price of more play-outs. |
| V6 | 6×6 komi 4.0 (6 served rows): unchanged (unrated Tiltak play-on, browser). | — | no change |
| V7 | A play-out left with no further contact for 30 min is unrated. Today an unproven one closed by pagehide is a rated miss. | D3 | yes: a dead phone is not a give-up. The `unload` event from a later visit still applies today's rule. |
| V8 | Keep "missed → play again" (`retry`, "Solved, after a miss") [CODE app.js:1077, 1083]. | — | keep. CLEANUP's machine drops it. |
| V9 | Proven off-tree wins off 6×6 stay solved on the spot. | — | keep |
| V10 | With two tabs on one puzzle, the first attempt *opened* counts. | C1 | yes (negligible) |
| V11 | Attempts on `held`/`rejected` puzzles are unrated. | P3 | yes: ps505288's unproven alt is a false solve today |
| V12 | Results that failed to upload now arrive later instead of being lost, so ratings may move on the next visit. | C2 | yes |
| V13 | Automatic refund proposals: Sasha approves a batch, or they auto-apply. | S4 | proposals first; auto-apply after a month with no wrong proposal |

---

## 12. Open questions for Sasha (with recommendations)

1. **A9: play out threat-only refutations on 6×6?** Recommendation: yes, at D1. q=1 disproofs could later narrow it, since `deep` returns them [DOCS MINING].
2. **Rated defender: native only, or WASM too?** Recommendation: native only for rated games (V1). The replies must be the server's to be re-judgeable and trusted.
3. **Auto-refunds?** Recommendation: proposals for a month, then auto-apply where the evidence is a checked proof.
4. **Expired play-outs: unrated or rated miss?** Recommendation: unrated (V7).
5. **pd575074's unrefunded −2.9 miss** [DOCS SD §8.2]. Recommendation: refund it with L3 as the tool's first real use.
6. **Keep `retry` after a miss?** Recommendation: keep (V8).
7. **What `reserve` means.** Recommendation: unchanged serving through stage 2, with no exclusion until Sasha decides 7×7/8×8 and the rare themes [DB, map-state §6.3].
8. **Grade D "never serve"** is not enforced in stage 2 or daily tier 4 [CODE server.js:240-243, 285]. Recommendation: `status = rejected` for D excludes them from stage 2 too. **VISIBLE**: decide separately.

---

## 13. Where the documents and the code disagree (affects this plan)

- **Defender.** CLEANUP's "Syntaks native" target differs from the code, where WASM is tried first [CODE app.js:930-937]. So V1 is a change, not a cleanup.
- **Tiltak.** CLEANUP lists Tiltak among "engines in a rated result", but a Tiltak game is unrated both ways [CODE playon.js:60, 68-69].
- **Endings.** There are 10 ending kinds today, 9 of them reachable. CLEANUP's "9" is the design page's count [CODE app.js:1025-1061; map-client §2].
- **Old clients.** "With the server judging, an old client cannot produce a wrong rated result" [DOCS CLEANUP part 3] holds only once legacy misses are unrated (D1). Legacy wins still count until X4.
- **Sidecars and the solver.** "7 sidecars" is now 12 (5 live). `deep` is a Rust crate (in flight), not C++ [DB, map-state §2; DOCS CLEANUP part 5].
