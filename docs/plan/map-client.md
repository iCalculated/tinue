# Client map: tinue `public/` as of main 3026736

Reference material for the plan writers. Scope: `public/app.js` (1,881 lines), `public/playon.js`, `public/engine.js`,
`public/engine-worker.js`, `public/syntaks.js`, `public/tiltak.js`, `public/next.js`, `public/api.js`, `public/index.html`,
`public/config.js`, plus the server lines the client depends on (`server/server.js`) and the build stamp
(`scripts/build-static.sh`).

**Tags.** Every statement carries one of these:
- **[CODE path:line]** read in the code at 3026736.
- **[DOCS "quote"]** from CLEANUP.md / MINING.md / SOLVER.md (the briefs) or `docs/system-design.html` (the design page).
- **[INF]** my inference, with the reason.

The design page's line numbers are for `public/app.js` at 034736e [DOCS system-design §3: "Line numbers are public/app.js at
034736e"]. Since then 0197cd5…35cd944 merged the proven play-out, so its numbers are off by ~30–60 lines and its §3.3 says
the proven play-out is "decided after this snapshot, not live" [DOCS system-design §3.3]. In the repo it is now live code
[CODE app.js:624, playon.js:71-86; git log 35cd944 "Merge playon: prove the win on the board"]. Whether it is deployed I
could not check (no network) [INF].

Imports [CODE app.js:1-11]: `shared/tak.js` (Game, rules), `shared/ptn.js`, `shared/themes.js`, `shared/rating.js`
(provisional, PLAYER_START), `board.js`, `engine.js` (df-pn/Solver worker), `tiltak.js`, `syntaks.js`, `api.js`, `next.js`,
`playon.js`. `ninja.js` is imported only with `?board=ninja` [CODE app.js:115-117]. `shared/*` is copied into the static
build [CODE build-static.sh:45]; `public/shared/` does not exist in the repo (dev server serves it) [INF: `/bin/ls public`
shows no `shared`].

---

## 0. Puzzle state object `S`

Created by `start()` [CODE app.js:438-440]: `{ p, g, node: p.tree, solver, hist, moves, snaps, view, status: 'play',
resultSent, hinted, delta, busy: true, misses, outcome, branch, onBranch, theme, t0, born, hiddenMs, hiddenAt, log }`.
Fields added later (all [CODE]): `checking` (591), `quickCheck` (599), `proven` Map (615), `proofPlies` Map (616),
`uncheckedMoves` Set (617), `checkPending` (630, 837), `held` (679), `decidedMs` (627), `refutation` (639), `playOn`
(834), `slowWin` (745, 1096), `unchecked`/`uncheckedWhy` (759, 787), `casual`/`casualWhy` (685-686), `serverRated`,
`repeat`, `notCounted`, `resend` (706-719), `needsRestore` (787, 1057), `pendingHint`/`pendingSolution` (1164, 1207),
`viewT0` (1170), `viewed` (1183), `hint` (1227), `evalKey`/`eval`/`tk` (368), `loadedKey`.

The puzzle payload the client reads [CODE server.js:194-207]: `id, size, tps, plies, tree, themes, source, sourceRef,
rating, rd, attempts, solves, komi, meta, turn, pre0`, and `alts` / `altsAt` from the `swing` column. Tree format: a node
is `'win'` or `{ptn: {r: reply, n: next}}` [CODE app.js:527-530, 560-561; DOCS system-design §3.0].

---

## 1. A move that is not in the stored tree

Entry: every board move goes to `userMove(ptn)` [CODE app.js:116-117, 545] (also typed moves via `board.play`, 1743-1750).

### 1.1 Guards before classification (in order)

| # | Condition | Effect | Where |
|---|---|---|---|
| 1 | `!S` or placeholder | ignored | [CODE app.js:546] |
| 2 | `status === 'solved'` | free exploration (`explore`), never a result | [CODE app.js:547] |
| 3 | `S.playOn` | play-on move (§1.6) | [CODE app.js:548] |
| 4 | `tooSoon(S)`: < `TOO_SOON_MS = 500` since `S.born` | board restored, move dropped | [CODE app.js:506-507, 549] |
| 5 | `busy`, browsing (`view != null`), or status not `play`/`retry` | board restored | [CODE app.js:550] |
| 6 | not canonical / not legal | board restored | [CODE app.js:553-554] |

### 1.2 Classification

- Move ends the game with the solver winning (any route, in tree or not) → correct, `solved()` → `report(true)`
  [CODE app.js:557-559, 653-657, 1081-1086].
- Node not `'win'`, move is a key of the node, game not over → on-tree: "Best move!", reply after 450 ms
  [CODE app.js:560-561, 658-672].
- Otherwise **off-tree** [CODE app.js:579]. Undo the move. If it is the move whose check is already pending at the same ply
  → just restore, not a second miss [CODE app.js:582].
- If the move ended the game without the solver winning (`res` truthy): straight to the miss path, no lists, no check
  [CODE app.js:586 `if (!res && node)`].

### 1.3 The off-tree pipeline (`app.js:583-651`), in order

1. **Cache.** `key = provenKey(canon)` = moves so far + `|` + canon; `known = S.proven.get(key)` ('wins' | 'no')
   [CODE app.js:587, 1079]. Per puzzle object, in memory only [INF: Map on `S`, recreated in `start()`].
2. **Stored alternative wins.** `wins = known === 'wins' || (node !== 'win' && slowerWins().includes(canon))`
   [CODE app.js:588]. `slowerWins()` = `p.alts` at the root, `p.altsAt[moves so far joined by space]` deeper
   [CODE app.js:1072-1075]. At a `'win'` node the lists are not consulted [CODE app.js:588].
3. **Defender lookup.** `po = playOnDefender()` = `defender(size, komi, tiltak.supports)` [CODE app.js:589, 820;
   playon.js:34-37]: `'syntaks'` if size 6 and |komi| ≤ 3.5 in half-points; else `'tiltak'` where Tiltak plays
   (sizes 4–6, |komi| ≤ 5 [CODE tiltak.js:20-21]); else `null`.
4. **Quick check** (only if `!wins && !known`) [CODE app.js:590-619]:
   - Card: "Checking <move>" (`S.checking`) [CODE app.js:591, 1454-1456]; `S.busy = true` [CODE app.js:583].
   - `minor = !!(S.checkPending || S.resultSent)`: only the first unsettled check can decide the result
     [CODE app.js:595]. Minor checks get budgets `[[3e4, 5e3]]` [CODE app.js:596].
   - `engine.checkStill` spawns a fresh module worker per check [CODE engine.js:51-77]: `quick` resolves within
     `quickMs = 2500` ms wall clock ('wins' | 'no' | 'pending'); `final` keeps running up to `maxMs = 60e3` of
     **visible** time ('wins' | 'no' | 'unknown') with budgets `[[3e4, 2.5e4], [1e5, 2.5e4]]`. Worker: threat-only
     `TinueSearch`, then `fullDefense` confirmation; 'no' = no Tak-threat win exists [CODE engine-worker.js:69-101].
     On 'wins' it also reports the proof length `plies` (`proofTreeLine`) [CODE engine-worker.js:99-101; engine.js:70].
   - Major check only: `S.quickCheck = {miss, chk, tMove}` and a **held record** `heldRec.set({id, ms})` in
     sessionStorage; the stored next puzzle is dropped if it is this one [CODE app.js:599-600]. Leaving now →
     `abandonQuick` → unrated miss (§4).
   - After `quick`: if the puzzle changed or the quick check was abandoned → cancel and return [CODE app.js:602]. On
     'no' the held record is deleted [CODE app.js:606]. If an earlier held check already settled the puzzle meanwhile,
     this move counts for nothing [CODE app.js:608-612].
   - `quickOutcome(quick, minor)` [CODE playon.js:126]: 'wins' → cache 'wins' + proof plies; 'no' → cache 'no';
     undecided & major → `pending = chk`; undecided & minor → cancel, add to `S.uncheckedMoves` [CODE app.js:613-618].
5. **Undecided + defender exists** → `startPlayOn(..., pending, ...)`: **play-on** (unproven) [CODE app.js:620].
6. **Proven** (`wins`: from cache, alts/altsAt or quick 'wins'):
   `provenPlayOut(po) && !S.checkPending` → `startPlayOn(..., proven=true, proofPlies)` = **proven play-out**;
   otherwise **`slowSolve`** (the move stays, puzzle solved on the spot, `report(true)`) [CODE app.js:624, 1093-1101;
   playon.js:81 `provenPlayOut = engine === 'syntaks'`].
7. **Otherwise a miss** [CODE app.js:626-651]: logged `'miss'`, `S.misses.push`; if `pending` (undecided, no defender)
   the miss becomes a **held miss**: `S.checkPending = {...}`, `heldRec.set`, `pending.final.then(settleCheck)`
   [CODE app.js:629-637]. The **refutation** worker starts for the card text (display only) [CODE app.js:638-642;
   engine.js:38-44]. `fail()` → status `'retry'`, `report(false)` (queued in `s.held` if a check is pending)
   [CODE app.js:643, 1077, 678-680]. **700 ms** later `busy = false` and the board is restored [CODE app.js:644-650].

### 1.4 Per board size (who can reach what)

| Board / komi | alts/altsAt | cache | quick check | proven → | undecided (major) → | undecided (minor) → | 'no' → |
|---|---|---|---|---|---|---|---|
| 6×6, half-point \|komi\| ≤ 3.5 | yes | yes | yes | **proven play-out vs Syntaks** (slowSolve only if another check is held) | play-on vs Syntaks (WASM → crux → WASM-wait → Tiltak fallback) | miss, move marked unchecked | rated miss |
| 6×6, \|komi\| 4.0 (6 served rows locally) | yes | yes | yes | slowSolve | play-on vs **Tiltak** (unrated) | same | rated miss |
| 4×4, 5×5 | yes | yes | yes | slowSolve | play-on vs Tiltak (unrated unless proof) | same | rated miss |
| 7×7, 8×8 | yes (if rows have them) | yes | yes | slowSolve | **held miss**, ≤ 60 s visible, `settleCheck` | same | rated miss |

All [CODE app.js:586-651, playon.js:34-37, tiltak.js:20-21]. Komi counts: [CODE `sqlite3 -readonly data/tinue.db`,
served pool `turn = 1 OR grade = 'A'` (server.js:236)]: 6×6 served rows by komi 0.0×4453, 0.5×1, 1.0×3, 1.5×4,
2.0×1886, 2.5×1036, 3.0×286, **4.0×6**. The local served pool has only sizes 4/5/6 (268 / 18,535 / 7,675) [CODE same
query]. 7×7/8×8 rows still reach players through links (`/api/puzzle/:id`, app.js:327) and through the picker topping up
from outside the served pool [CODE server.js:239-241 "topped up from the rest if it runs short"] [INF: the local DB may
lag crux's].

The rule as stated in the task ("native Syntaks on the server for 6×6 … none for 7×7/8×8") **does not match the code**:
the client asks in-browser Syntaks WASM first and crux only when WASM is not ready, not supported or slow; 4×4/5×5 and
6×6 komi 4 still get an unproven play-on against Tiltak (unrated) [CODE app.js:914-940, 961-969; playon.js:34-37].

### 1.5 Which engine defends (play-on and proven play-out)

`defenderTurn` [CODE app.js:943-982], `syntaksReply` [CODE app.js:914-940]:

1. `po.local = engine === 'syntaks' && syntaks.supports(size, komi)` (WASM SIMD + Worker + 6×6 + half-point |komi| ≤
   3.5) [CODE app.js:849; syntaks.js:18-21]. WASM is loaded on play-on start [CODE app.js:850].
2. **Syntaks WASM** if loaded (`status() === 'ready'`) and device not marked slow: `search({ms: 1500, nodes: 1.5e6})`
   raced against 4.5 s [CODE app.js:923-924, 930-935]. Slow device: `nodes < LOCAL_MIN_NODES (150e3) && mate == null &&
   ms ≥ 1200` → later replies go to crux [CODE app.js:917, 934].
3. **Syntaks native on crux**: `GET /api/defend?tps&komi`, client timeout 8 s, aborted on game end
   [CODE app.js:925-928, 936; server.js:701].
4. **WASM again**, waiting up to 4.5 + 20 s for the download, if crux gave nothing and WASM hasn't failed
   [CODE app.js:937].
5. Nothing legal: proven play-out → ends `'proved'` (a solve; no play-out against Tiltak) [CODE app.js:956]; unproven →
   `po.fallback = true` [CODE app.js:957].
6. **Tiltak WASM** (fallback, or the defender from the start on 4×4/5×5/6×6-komi-4): warmup raced against 20 s, then
   `analyze({ms: 1500})` raced against 6 s [CODE app.js:961-969].
7. No legal move from anything → `endPlayOn('noengine')` [CODE app.js:970].

Resigning: `mayResign(po) = !po.proven && RESIGN_UNPROVEN` and `RESIGN_UNPROVEN = false` [CODE playon.js:85-86], so
the `'resign'` branch [CODE app.js:959] is **unreachable** today [INF: both operands constant-false for every po].

Cap: `capMoves(pliesLeft) = left + max(3, ⌈0.3·left⌉)`, `left = ⌈pliesLeft/2⌉`; proven play-outs raise it to cover the
proof (`provenCap`), measuring the proof length in a worker if unknown [CODE playon.js:8-30; app.js:896-912]. At the cap
the game may **wait** (`capWait`: 'length' up to 30 s, 'proof' up to 20 s, visible time) before ending `'out'`
[CODE playon.js:133-138; app.js:996-1012].

During play-on the check keeps running: a proof mid-game → `makeProven` (Syntaks, no fallback: becomes a proven
play-out, cap raised, the miss erased) or `endPlayOn('proved')` (Tiltak or after fallback) [CODE app.js:843-848,
880-893]. A 'no' or 'unknown' mid-game is only stored (`c.final`) and the game decides [CODE app.js:847].

### 1.6 "Held" results

Three distinct things are called held [CODE]:
- **`heldRec`** (sessionStorage `tinue.held`, one slot): written at a major quick check (600), a held miss (634), and
  play-on start (841); re-stamped with the settled result in `report` (694); deleted on server ack (708), on quick 'no'
  (606), on keepalive send (691), and by `flushHeld` (797, 805). Details in §4.
- **`S.checkPending`**: a decision still owed by a running check (held miss on 7×7/8×8, or any play-on) [CODE
  app.js:630, 837].
- **`S.held[]`**: results `report()` was asked to send while `checkPending` was set; only `held[0].ms` is used when the
  check settles [CODE app.js:678-680, 744]. `settleCheck(s, verdict)` [CODE app.js:729-765]: 'wins' → misses from that
  move erased, solve sent with the original move's flags; 'no' → miss as played (rated unless hinted); 'unknown' → miss
  sent unrated (`s.unchecked`). For play-on misses the rated decision is `lossRated(po, po.end)` regardless of verdict
  [CODE app.js:758].

### 1.7 Miss

A miss sets status `'retry'`: the puzzle is **not over**; the player keeps trying and can still solve it (outcome
`'miss'`, card "Solved, after a miss") or press Solution [CODE app.js:1077, 1083, 1351, 1443-1449]. Only the first
result is sent (`resultSent`) [CODE app.js:677, 682].

---

## 2. Every way a play-out can end

`endPlayOn(s, kind)` [CODE app.js:1025-1061]. Kinds passed anywhere in the code: **10**.

| # | kind | Trigger | Where | Result | Rated? |
|---|---|---|---|---|---|
| 1 | `win` | player's road or flat win (`ending()` → 'win') | [CODE app.js:994-995, 975-976; playon.js:40] | solve | `winRated`: proven → yes; else Syntaks, no fallback, defender moved [CODE playon.js:68-69] |
| 2 | `resign` | Syntaks mate score for the player | [CODE app.js:959] | solve | **unreachable** (RESIGN_UNPROVEN = false) |
| 3 | `proved` (a) | check proves the move mid-game while Tiltak defends or after Syntaks fell back | [CODE app.js:883] | solve | always (`winRated` 'proved') |
| 3 | `proved` (b) | Syntaks drops out of a **proven** play-out (no legal reply from WASM or crux) | [CODE app.js:956] | solve | always |
| 4 | `out` | `po.mine ≥ po.cap` after the player's move (after any cap wait) | [CODE app.js:1011] | miss | `lossRated`: Syntaks throughout; proven with unknown proof length → unrated ('proven-length') [CODE playon.js:91] |
| 5 | `road` | defender's road, including one the player's own move completes (`byYou`) | [CODE playon.js:40; app.js:1046-1047] | miss | lossRated |
| 6 | `held` | flat loss or draw | [CODE playon.js:40] | miss | lossRated |
| 7 | `gaveup` | Give up button (guard 1.5 s) **or** Solution during play-on | [CODE app.js:1687, 1166] | miss | lossRated (stalled → unrated) |
| 8 | `left` | moving to another puzzle in the page (`abandonCheck` without keepalive) | [CODE app.js:773] | miss | lossRated (stalled → unrated) |
| 9 | `unload` | `pagehide` (`abandonCheck` with keepalive) | [CODE app.js:773, 790] | miss | lossRated; **proven play-out → unrated** ('proven-unload') |
| 10 | `noengine` | no engine produced a legal move | [CODE app.js:970] | miss, check keeps running; a later proof still makes it a solve | always unrated (fallback) |

The design page's table lists 9 endings: win, resign, proved, out, road, held, gaveup, left, noengine
[DOCS system-design §3.3 Ending table]. `unload` was split from `left` after its snapshot (c943bd3 "only the page going
away is unrated") [CODE playon.js:87-91; git log]. So CLEANUP's "9" is the design page's count [INF: CLEANUP says it was
written from the design page]; today there are **10 kinds, 9 reachable** (`resign` is dead), and 11 distinct triggers if
`proved` (a)/(b) are split. Card text varies by ending and proven/unproven [CODE app.js:1483-1498; playon.js:141].

Ratedness side rules: `gameRated(po) = engine === 'syntaks' && !fallback && !stalled && line.length ≥ 2` [CODE
playon.js:60]; `stalls()`: gaveup/left/unload while the defender has owed a reply > `STALL_MS = 6000` [CODE
playon.js:59, 101; app.js:1029]. A rated outcome is expressed to the server only as `casual: true/false` (§4).

---

## 3. Puzzle-screen states, flags and timers

### 3.1 `S.status` values [CODE grep `status = '`]

| status | set at | meaning |
|---|---|---|
| (S = null / `PLACEHOLDER`) | [CODE app.js:300, 1277-1281, 1384] | loading or "No puzzles match" |
| `'play'` | [CODE app.js:438, 659] | solver to move, no miss yet |
| `'retry'` | [CODE app.js:787, 1043, 1077] | after a miss; still playable |
| `'playon'` | [CODE app.js:854] | play-on / proven play-out game (with `S.playOn`) |
| `'viewing'` | [CODE app.js:1170] | Solution animation (750 ms per ply, 1186-1193) |
| `'solved'` | [CODE app.js:749, 1082, 1183] | over: review/exploration; `outcome` ∈ clean / miss / viewed |

Orthogonal sub-states [CODE]: `notice` (server wait/net/none card overrides everything, api.js:23-25, app.js:1451);
`S.checking` (quick check card, 1454); `S.quickCheck`; `S.checkPending` (held, also with status 'solved', 1414-1416);
`po.thinking`, `po.waiting` ('length'|'proof'), `po.end`, `po.fallback`, `po.slowLocal`, `po.proven`, `po.provedLate`;
`S.view` (browsing an earlier ply, 1252-1272); `S.onBranch`/`S.branch` (exploration after solve); `S.resultSent`;
`S.hinted`; `S.needsRestore` (left mid-game but page stayed, 1062-1070); `S.busy`.

### 3.2 Everything that guards input

| Guard | Value | What it blocks | Where |
|---|---|---|---|
| `board.ui({disableBoard})` | — | board input: before load, intro, busy phases, Solution, after `'retry'` restore is false only when live | [CODE app.js:118, 446, 462, 539, 947, 1003, 1173] |
| `TOO_SOON_MS` | 500 ms from `S.born` | board moves | [CODE app.js:506-507, 549] |
| `FRESH_MS` | 1000 ms from `S.t0` (after intro) | Hint/Solution rendered disabled + click dropped; re-enabled at 1030 ms (`wakeActions`) | [CODE app.js:487, 493-502, 1429, 1684] |
| `justViewed` | 600 ms after Solution (`viewT0`) | Next (card and dock); **not** Enter | [CODE app.js:510, 1673, 1689; Enter 1720] |
| miss reset | 700 ms `busy` after a miss | moves; Hint/Solution deferred via `pendingHint/Solution` | [CODE app.js:644-650, 1164, 1207] |
| on-tree reply | 450 ms `busy` | moves | [CODE app.js:660-672] |
| intro | 650 ms before the last history ply; board disabled until done | moves; t0 not started (so FRESH too) | [CODE app.js:455-466] |
| Give up | 1500 ms from `po.t0` | Give up rendered disabled + click dropped; re-render at 1600 ms | [CODE app.js:853, 1469, 1472, 1687] |
| same pending move | — | not a second miss | [CODE app.js:582] |
| `S.busy` | — | moves (550), Solution/Hint deferred (1164, 1207), browsing (1263) | [CODE] |
| play-on | `po.end || po.thinking || s.busy` | play-on moves | [CODE app.js:988] |
| cap wait | 30 s ('length') / 20 s ('proof'), visible time | moves (busy) | [CODE playon.js:133; app.js:1003-1005] |
| browsing | `S.view != null` | moves restored | [CODE app.js:550] |
| `board.holding` | stones in hand | navigation | [CODE app.js:1253, 1706; board.js:176] |
| play-on | — | browsing disabled; Reload button ignored; build bar hidden | [CODE app.js:1254, 267, 251] |
| `loadSeq` / `S !== s` | — | stale async continuations | [CODE app.js:195, 283, 297, passim] |
| board.js long-press | 500 ms | touch right-click | [CODE board.js:115-122] |
| board.js digit window | 1500 ms | keyboard stone count | [CODE board.js:263] |
| booting class | 2000 ms max | page hidden until laid out | [CODE index.html:20] |

CLEANUP names "TOO_SOON, FRESH, the 600 ms, 700 ms and 1,500 ms guards" [DOCS CLEANUP §6]; those map to rows 2–5 and 8.
The 450 ms reply, 650 ms intro and cap waits also hold input but are animation/engine waits, not accident guards [INF].

Other timers [CODE]: quick check 2.5 s, check 60 s visible (engine.js:51); refute 8 s + 2 s kill (engine.js:38);
`STALL_MS` 6 s (playon.js:59); WASM 4.5 s / +20 s, crux defend 8 s, Tiltak 20 s / 6 s (app.js:923-966); review crux
6 s, Tiltak 2.5 s (app.js:380, 393); `pageAlive` 1.5 s (app.js:77); `flushHeld` and `loadNext` waits 3 s (app.js:288,
291, 311, 1879); build checks 10 min / 30 s / 120 s (app.js:224, 241-242).

---

## 4. How a result reaches the server

### 4.1 `report(win, s, flags, {keepalive, ms})` [CODE app.js:676-724]

- No-op if `s.resultSent` (first result only) [677]. If `s.checkPending`, queued into `s.held` [678-680].
- **Client-computed rating flags**: `casual = flags.hinted || (!win && s.unchecked) || (win && flags.playOn?.unrated)`
  [685]. `s.unchecked` is set by `abandonQuick` and by `settleCheck` when the check said 'unknown' or the play-on loss is
  not `lossRated` [787, 758-759].
- Payload: `POST /api/result?b=<BUILD>` body `{puzzleId, win, casual: true | theme, ms, log, guest: {gid}` (no token
  only)`}` [698-699, 221]. `ms` = `decidedMs ?? elapsed` (visible ms since playable) [687, 511-515]. `log` = up to 64
  `{m?, ms, k}` with k ∈ ok | miss | slow | po | hint | view [524, 627, 653, 831, 993, 1169, 1214].
- Transport: `api()` POST = one try, 20 s, **no retry** [CODE api.js:53]. `noWait` so the card doesn't flip [699].
- If a held record exists for this puzzle it is re-stamped `{id, ms, win, casual, theme}` [694]; deleted on an answer
  with `user` [708]. **A result that never had a held record is not re-stamped, so a failed upload is simply lost**
  (`s.notCounted = 'lost'`) [717; INF: 694 only rewrites an existing record].
- Answer handling: `r.token` stored only if no sign-in happened meanwhile (`answerOwnsToken`, `signIn` counter)
  [697, 703-704; playon.js:154]; `rated`, `userDelta` shown; `repeat` = unrated and not casual (repeat or stale build)
  [710-711]; 429/other errors → `notCounted` 'rate'/'error' [706].
- Then `nextQ.prefetchNext(win, id, usePair = !casual && answered)` [723].

### 4.2 Held records, Web Lock, pagehide, resend [CODE app.js:41-80, 767-807]

- `heldRec` one slot in sessionStorage `tinue.held` = `{id, ms, win?, casual?, theme?, b: BUILD, owner, page}`
  [52-69]. `owner` = FNV-1a hash of the token [49]; `page` = per-page UUID [48].
- **Web Lock** `tinue.held.<pageId>` taken with the page's first record, held for the page's life [50, 65]; `pageAlive`
  probes another page's lock with a 1.5 s abort [75-80], so a duplicated tab doesn't send a live page's record.
- **Displacement**: writing a record for another puzzle first sends a settled previous record (`heldDisplaced`); if its
  first upload is still in flight, resend only if it failed and no auth change since (`deferredResendOk`, `authEpoch`)
  [57-64; playon.js:120-121, 144-149].
- **pagehide**: `abandonCheck(S, {keepalive: true})` [790] → mid play-on `endPlayOn('unload')`, else
  `settleCheck('unknown')` (unrated miss), or `abandonQuick` (unrated miss) [768-789]; sent with `keepalive` and the
  held record deleted **before** the send [691].
- **Boot**: `flushHeld()` before the first puzzle, awaited ≤ 3 s [793-807, 1878-1879]: `heldResend` [playon.js:109-115]
  drops another owner's record or a live page's; a settled record goes as settled **under the build that wrote it**
  (`withBuild(..., send.build)`); an unsettled one as `{win: false, casual: true}`.
- `reporting` Set and `uploading` Map track in-flight uploads (build reload waits ≤ 3 s; displacement waits) [95-96,
  700-701, 802].
- Leaving a puzzle mid-check through Next/link/filter: `start()` and `loadNext()` call `abandonCheck` [433, 287-288];
  sign-in/out call it first [133, 171].

### 4.3 What the server takes on trust [CODE server.js:612-645]

The server checks only: rate limit (60/min/user or IP; 10 new guests/h/IP), `puzzleId` string, `win` boolean, puzzle
exists, first attempt per (user, puzzle) [613-627]. It then trusts **`win`**, **`casual`**, **`theme`**, `ms`, `log`
from the client. The only server-side judgment is `stale = MIN_MISS_BUILD > 0 && !win && (b < MIN_MISS_BUILD)` → miss
recorded unrated; wins from any build count [631-632; server.js:19-21; deploy-crux.sh:34 `MIN_BUILD=1794817280`].
Everything in §1–§2 (tree membership, alts, df-pn verdicts, play-on outcome, whether Syntaks defended, stalls,
lossRated/winRated, hints) is decided in the browser and arrives as `win` + `casual` [INF: no other field reaches the
rating code]. Guest half weight and Glicko-2 are server-side [CODE server.js:633-634].

---

## 5. `#checkBuild` and `version.json` [CODE app.js:213-280, 307-314]

- Build stamp: `window.TINUE_BUILD` appended to `config.js`, `{"v": V}` in `version.json`, `?v=V` on every module
  import [CODE build-static.sh:51-57]. Dev server: `BUILD = 0`, all off [CODE app.js:220, 227].
- `checkBuild()` fetches `version.json?t=…` with `cache: 'no-store'`; any different `v` (rollbacks too) sets `newBuild`
  unless that build was tried in the last 120 s (`tinue.reloadedFor`) [226-239]. Called on every `start()` [442], every
  10 min while visible [241], on becoming visible after > 30 s [242].
- Bar: hidden mid-puzzle (moves or misses made, or play-on) and while dismissed (until the next puzzle) [248-263].
  Reload button: from a result card → `loadNext({reload: true})`; before the first move → reload into this puzzle;
  never in play-on [266-270].
- Between puzzles `loadNext` reloads into the new build only if nothing is held/being checked/uploading, unless Reload
  was pressed (then waits ≤ 3 s for uploads) [310-314]. `reloadInto` saves the target id and theme; after reload
  `loadById` takes the stored next puzzle without a request [272-280, 321-330].
- `?b=BUILD` is sent on `/api/result` and `/api/me` [221, 698, 1807, 1876] and decides the server's stale-miss rule
  (§4.3).

---

## 6. `for=<id>` pre-picks and the queue [CODE next.js; app.js:205-211, 282-317]

- `nextQ = createNext({...})` [app.js:207-210]. `start()` calls `prefetchPair(p)` [app.js:441].
- **Provisional / guest**: `prefetchPair` requests `/api/next?…&for=<id>` → `{win, loss}` picked at the rating the
  player would have after each result [next.js:80-91; server.js:560-571]. `prefetchNext(win, id, usePair)` picks one
  side if the result counted as assumed (not casual, answered); else a plain `/api/next` [next.js:94-105].
- **Settled account** (`settled() = token && me && !me.provisional`): a **queue** of `BATCH = 10` (`n=10`) at their
  rating, refilled at `REFILL_AT = 2`, re-picked on drift > `DRIFT = 50`; the pair is requested only when the queue is
  empty [next.js:13, 24-77, 81-89].
- The chosen next puzzle is stored in localStorage `tinue.next` (TTL 12 h) and resumed at boot [next.js:12, 102, 112-115;
  app.js:1869]; dropped when the current puzzle is being checked so leaving isn't a free retry [app.js:600, 635, 842].
- `loadNext`: `take()` with a 3 s race, else `/api/next?…` (excluding the puzzle being left) [app.js:289-295].
- Guests without a token send `rating` and `exclude` (legacy local seen list) [app.js:196-204].
- Verified by `scripts/test-next.mjs` and the model checker `scripts/test-next-model.mjs` (6 invariants)
  [CODE test-next-model.mjs:1-16; package.json:10].

---

## 7. Review / analysis view [CODE app.js:356-402, 1104-1153, 1283-1321]

Only in status `'solved'` [362]. Per position (`evalKey`), aborting the previous request [366-369]:

| Size / komi | 1st | fallback 1 | fallback 2 |
|---|---|---|---|
| 6×6 half-point \|komi\| ≤ 3.5 | crux `/api/analyze` (Syntaks native), 6 s, quiet | Tiltak WASM, 2.5 s streaming | tinue solver (`analyze`, maxPlies 9, budget 4e5) |
| 4×4, 5×5, 6×6 other komi (\|komi\| ≤ 5, rounded to 0/2) | Tiltak WASM | solver | — |
| 7×7, 8×8 | solver | — | — |

[CODE app.js:374-401; tiltak.js:16-21; engine-worker.js:133-142]. Syntaks **WASM is never used for review** [INF:
`runEngine` has no `syntaks.search` call]. Game over → "X won" with no engine [372]. Engine line is clickable (`playPV`,
404-423). Footer and tag claim "Syntaks … running on the puzzle server" for review [CODE app.js:1302].

The "why it fails" refutation (§1.3 step 7) is a separate display-only engine use during play (`Solver` + `shortestTinue`
in the refute worker) [CODE engine-worker.js:111-132]; CLEANUP doesn't mention it [DOCS CLEANUP §6 has no entry].

---

## 8. Today → CLEANUP part 6 machine

Target [DOCS CLEANUP §6]: `loading → intro → play ⇄ reply → solved | missed → review`, with `play → judging → missed |
playout ⇄ reply → solved | missed`; "One input lock (`busyUntil`)…", "One outbox replaces held records, the Web Lock and
`pagehide` sends", "Review has one engine a size and no fallbacks".

| Today (state / path) | Machine state | Code that would go (if the server judges and the book replaces alts) |
|---|---|---|
| `S = null` / `PLACEHOLDER`, `notice`, `loadNext`, `loadById`, `reloadInto` | loading | `reloadTheme`/`reloadedFor` plumbing shrinks with one build check (app.js:224, 272-280, 307-314) |
| `start()` intro (650 ms, board off, `busy`) | intro | — (keep the animation [DOCS CLEANUP "Keep as is": "the intro animation"]) |
| status `'play'`, not busy | play | `TOO_SOON_MS`, `FRESH_MS`, `wakeActions`, `fresh()`, `justViewed`, 700 ms/1500 ms checks → `busyUntil` (app.js:487, 493-510, 1429, 1469, 1472, 1684, 1687, 1689) |
| on-tree key, 450 ms reply | reply | — |
| solver's game win / tree end | solved | — |
| off-tree: cache `S.proven`, `alts`/`altsAt` lookup | play → judging ("book or judge") | `slowerWins`, `provenKey`, `S.proven`, `S.proofPlies` (app.js:587-588, 615-616, 1071-1079); `alts`/`altsAt` in `publicPuzzle` (server.js:201-207) |
| quick check (`S.checking`, `S.quickCheck`, major/minor) | judging | `engine.checkStill` call, `quickOutcome`, `abandonQuick`, `uncheckedMoves`, the minor-budget branch (app.js:590-619, 777-789; playon.js:123-126; engine.js:45-77 if the browser no longer judges) |
| quick 'no' → `fail()` | missed | — |
| undecided + defender → `startPlayOn` | playout | — (kept, rewritten) |
| proven → proven play-out (6×6 Syntaks) | playout | the proven/unproven split: `makeProven`, `setProofLength`, `proofLength` worker, `provenCap`, `capWait`, `CAP_WAIT_MS`, `visibleTimeout` (app.js:860-912, 996-1010; playon.js:16-30, 128-141; engine-worker.js:102-110) **if** the judge's book gives the length |
| proven → `slowSolve` (4×4/5×5, 7×7/8×8, 6×6 komi 4, or another check held) | **no matching edge** (machine has judging → missed \| playout only) | `slowSolve` (1093-1101) — needs a decision (see Contradictions) |
| undecided, no defender → held miss (7×7/8×8), `settleCheck` up to 60 s | judging (server) → missed | `checkPending` held-miss path, `S.held`, `settleCheck` (626-637, 676-680, 726-765) |
| `'playon'`, `po.thinking`, defender turn | playout ⇄ reply | `syntaksReply` chain WASM → crux → WASM-wait (914-940), Tiltak fallback (961-969), `po.fallback`, `po.slowLocal`, `LOCAL_MIN_NODES`, `defenderName` variants, `noengine` |
| endings win / proved / resign | solved | `resign`, `RESIGN_UNPROVEN`, `mayResign`, `resigns` (playon.js:42-43, 82-86; app.js:959) |
| endings out / road / held / gaveup / left / unload / noengine | missed | `gameRated`, `unratedWhy`, `winRated`, `lossRated`, `lossWhy`, `stalls`, `STALL_MS`, `provenLossLead`, `playOnUnratedText`, card variants (playon.js:54-101, 139-141; app.js:1418-1425, 1483-1498) |
| status `'retry'` (after a miss, still playable) | missed (→ play again?) | see Contradictions |
| `'viewing'` (Solution) | missed → review | — |
| `'solved'` + exploration + `runEngine` | review | Tiltak and solver fallbacks for 6×6 (378-402) → one engine a size |
| `heldRec`, `pageLock`, `pageAlive`, `ownHeld`, `flushHeld`, `heldDisplaced`, `heldResend`, `deferredResendOk`, `resendAfterUpload`, `uploading`, `authEpoch` (partly), pagehide `abandonCheck` | outbox | app.js:41-80, 95-99, 691-694, 767-807; playon.js:103-149 |
| `checkBuild` + bar + reload deferral | one check between puzzles | app.js:240-243 (interval, visibility), 248-263 mid-puzzle hiding logic, 310-314 deferral; server `MIN_MISS_BUILD` [INF: unneeded once the server judges] |
| `next.js` pair + queue | unchanged until measured | `prefetchPair`/`for=` and queue only if `/api/result` returns the next puzzle and phone latency doesn't worsen [DOCS CLEANUP §6] |

---

## Contradictions and gaps vs the three documents

1. **"Syntaks native" as today's/target play-out engine.** Today the first defender on 6×6 is in-browser **Syntaks WASM**;
   crux is the fallback [CODE app.js:930-937]. The task's statement of the live rule ("native Syntaks on the server")
   is inaccurate for the client. CLEANUP's target "Syntaks native" would move every reply to crux (latency, crux load:
   POOL = 2 [DOCS system-design §3.3]) — a visible change.
2. **Play-on against Tiltak still exists.** 4×4/5×5 and the 6 served 6×6 komi-4.0 rows get an unproven play-on vs Tiltak
   (unrated) [CODE playon.js:34-37; DB query]. "No play out w tiltak" is honoured only for *proven* play-outs.
3. **Tiltak never decides a rated result.** CLEANUP lists Tiltak among "engines in a rated result"; in code a game Tiltak
   defended is unrated both ways; only a df-pn proof during it counts [CODE playon.js:60, 68-69].
4. **Endings: 10 kinds today, not 9;** `resign` is dead code; `unload` is new since the design page [§2].
5. **"held" on 6×6** is not the no-defender held miss (that is 7×7/8×8 only); on 6×6 "held" means the result held during
   the quick check and the play-out [CODE app.js:600, 841].
6. **Missed is not terminal today.** After a miss the player keeps playing (`'retry'`) and can still reach "Solved, after a
   miss". The machine's `missed → review` drops that unless `missed` loops back to `play`. *Visible*; needs Sasha's yes.
7. **No judging → solved edge.** Today a proven off-tree win on 4×4/5×5/7×7/8×8 (and 6×6 komi 4) is solved on the spot
   (`slowSolve`). The machine routes judging only to missed | playout, which either means a play-out on boards with no
   rated defender (contradicting "No play out w tiltak") or that the paths table's "6×6" scope leaves other sizes on the
   old code. Needs a decision.
8. **No retries for ordinary results.** A plain solve/miss whose upload fails is lost; only results that passed through a
   held state are resent on reload [CODE app.js:694, 717]. The comment at app.js:791 says flushHeld covers "a keepalive
   that didn't make it", but `report` deletes the record before a keepalive send [CODE app.js:691], so a failed
   keepalive is lost too [INF].
9. **Server trusts `win` and `casual`.** Any client (or an old tab) can send `win: true`; the stale-build guard covers
   only misses [CODE server.js:631-632]. CLEANUP's "With the server judging, an old client cannot produce a wrong rated
   result" holds only if the server stops accepting a client-asserted `win` for off-tree moves — old builds in open tabs
   will keep posting `{win, casual}` for days, so the new `/api/result` needs a compatibility rule for them
   [INF from the task's note that old builds stay open].
10. **Review never uses Syntaks WASM;** CLEANUP §2 suggests fetching WASM after the first 6×6 puzzle "and keep it in the
    Cache API", which only matters for play-out defence today [CODE app.js:374-401, 849-850].
11. **Stale comment** `playon.js:32` ("Syntaks on the server for 6×6") — the design page cites it as `playon.js:17`
    [DOCS system-design "Stale comments"]; it moved.
12. **MINING's "Silver is only fair once off-tree wins are played out"** is already true in code for 6×6 half-point komi
    (proven play-out vs Syntaks), but not for 6×6 komi 4.0 or other sizes [CODE app.js:624].
13. **Refutation worker** ("why it fails", display only) is not mentioned in CLEANUP's client part; it is a fourth
    client engine use (Solver + shortestTinue) [CODE app.js:638-642; engine-worker.js:111-132].
