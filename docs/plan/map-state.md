# Map: puzzle state and the offline pipeline, as of main 3026736

Reference for the people writing the implementation plan (book, judge, log). Read-only survey, 2026-11-17.

**Evidence tags.** Every claim carries one:

- **[DOCS]**: from a document, quoted or cited. `SD §x` = `~/Projects/tinue/docs/system-design.html` (untracked; written 2026-11-16 from a ~13:00 PST snapshot). CLEANUP / MINING / SOLVER = the three briefs.
- **[CODE]**: from the code at commit 3026736, cited `path:line`. Server lines are from `git show 3026736:server/server.js`. Someone was editing `server/server.js` in the working tree while I read it (+21 lines at :136, the Cloudflare move). Lines up to 133 are unchanged; later lines shift by 20 in the working copy.
- **[DB]**: a read-only query (`/usr/bin/sqlite3 -readonly`) on lyra's build database `~/Projects/tinue/data/tinue.db` (mtime 2026-11-16 21:38, 71,112 puzzles, 15 attempts). This is **not crux**. Attempt-derived state (refunds, `flaw = 2`, ratings) lives only on crux, which I did not touch. Sidecar counts come from reading `data/swing/*.jsonl` with node.
- **[INFER]**: my inference, with the reason.

Scripts used for the counts are in `plan/.work/` (side.mjs, prec.mjs, served.mjs, book.mjs, alts.mjs).

---

## 0. Headline facts

1. **The served pool is `turn = 1 OR grade = 'A'`.** [CODE] `server/server.js:236-237` (`SERVED` and `served()`), used at `:241` (stage 1 of `pickMany`), `:252` (score) and `:262` (tier). It is a preference, not an exclusion. When stage 1 returns too few rows, stage 2 picks from every row, with handicaps (+250 for a conversion, +150 for an unscored row) [CODE] `:239-243,252`. This is the only way 7×7 and 8×8 puzzles are ever served (0 served rows) and the main way rare-theme filters are filled. `/api/puzzle/:id` returns any row [CODE] `:604-607`. `/api/result` rates any row and never checks `served` [CODE] `:612-645`. The daily puzzle has its own tiers and never consults `grade` [CODE] `:281-289`.
2. **Local DB today [DB]:** 71,112 rows, of which 26,478 are served (37.2%; 62.8% outside the pool). At the 62,058-row snapshot the documents were written from, 20,914 were served and 66.3% were outside [DB, `tinue.db.bak-pre-ps6-20261116-2016`], which matches CLEANUP's "66%". Since then lyra's DB gained 8,131 + 404 `ps` 6×6 rows, 513 `pc` rows and 6 `pdg` rows. The deploy export `deploy/puzzles/puzzles.jsonl` has 71,112 lines, dated 11-16 23:39, so crux has probably been deployed to that state. [INFER] The export step precedes the rsync and import in `scripts/deploy-crux.sh:12-36`, and I did not check crux.
3. **There are now 12 sidecar files, not 7. Five of them are live.** The live set is `swing-v4` (p), `deep-v4` (pd), `ps-v4` (ps), `sc-deploy-now-v1` (pc) and `dg-subs-v1` (pdg). Every one of them matches the DB row for row (§2). Grades come from two more files: `data/grade/grades.jsonl` (49,117 rows) and the tracked `scripts/grade-overrides.jsonl` (13 hand rows, added 11-16 20:42, after the design page was written).
4. **Stored alternative wins are bare move lists without lengths or proofs.** `swing.alts` is a list of root moves and `swing.altsAt` maps a move path to a list of moves. Neither has a win length, a proof, or the undecided remainder, because import drops `altsUnk`. `altsAt` exists only on 5-ply puzzles. In the served pool, 1,329 rows have non-empty `alts` and 1,125 have `altsAt`, for 6,694 entries in all. 1,134 served rows still have undecided slower first moves (§4).
5. **A book built from today's data:** for the served pool, 69,226 distinct positions after a tree key, each with an exact length, plus 6,680 alt positions with no length: 75,906 rows. The 6×6 subset is 20,246 + 2,459 = 22,705. Across 496,036 tree positions no position has two different lengths (§6).

---

## 1. `puzzles` columns

Schema [CODE] `server/server.js:35-43`. Late columns were added by migration [CODE] `:96-99`. Row counts are [DB].

| column | meaning | written by | read by | rows set |
|---|---|---|---|---|
| `id` | PK. Prefix = miner: `p` shallow, `pd` deep, `ps` swing, `pc` swedishchef seeds (mine2), `pdg` dragon sub-positions (`pdg<game>-<ply>`). `j` (Jaffray) is mined but not imported. | miners: [CODE] `scripts/mine-playtak.mjs:103`, `mine-deep.mjs:163` (`j`: `:199`), `mine-swing.mjs:245`. pc and pdg come from scripts outside the repo [INFER]: no repo code emits those prefixes (grep). | everywhere | 71,112 (p 14,570; pd 22,790; ps 33,233; pc 513; pdg 6) |
| `size`, `tps`, `komi`, `plies`, `source`, `source_ref` | position, length of the stored win, provenance (`source` = `'PlayTak'` on every row) | miners → `import.mjs` upsert [CODE] `scripts/import.mjs:108-125` | picker filter `size` [CODE] `server.js:247`; `publicPuzzle` `:194-200`; client | all. 5 rows have `plies` > 15 (`pc`, 17–21) |
| `tree` | JSON. A node is `'win'` or `{<key>: {r: <reply>, n: <node>}}` [DOCS] SD §3.0. Only one defender reply is stored per key. | miners; hand patches to the files (alt-wins extensions, syn6 plies-fix) [DOCS] SD §2.6 | client move validation (on-tree = `node[canon]` [CODE] `public/app.js:560-562`) | all. 4 unserved `pd` D rows (pd689421, pd434618, pd176012, pd155525) hold 39 `null` children. 18 unserved `pd` 6×6 D rows have tree depth ≠ `plies` [DB, book.mjs] |
| `themes` | CSV of tags (§1.4) | `tags` from the file; `'tak'` is dropped [CODE] `import.mjs:124` | picker theme filter `server.js:246`; `/api/themes` (`:437-453` area); client | all |
| `init_rating` | prior | miner `rating` (`priorRating`), `reprior.mjs` (file rewrite); import overwrites it on **every** run [CODE] `import.mjs:111` | deploy export sends it as `rating` [CODE] `deploy-crux.sh:19`; `rerate.mjs:20` | all |
| `rating`, `rd`, `vol` | Glicko-2 state | result handler [CODE] `server.js:642`; import resets `rating` to the prior while `attempts = 0` [CODE] `import.mjs:112`; `rerate.mjs --apply` writes `rating` only [CODE] `scripts/rerate.mjs:98-101` | picker, daily, client | lyra: 12 played rows with `rd` ≠ 250 |
| `attempts`, `solves` | rated plays and solves | result handler only [CODE] `server.js:642`. Refund scripts never decrement them [DOCS] SD §5.6 | picker `PLAYED` [CODE] `:253` | — |
| `meta` | JSON (§1.1) | miner, plus `history` added at import from the raw dump [CODE] `import.mjs:15-24` | whole object sent to the client [CODE] `server.js:198`; client reads `white/black/ratingWhite/ratingBlack/history/dragon.path` [CODE] `public/app.js:342,436,1554-1570`, `shared/ptn.js:51-54`; share pages read `lastMove`, `history` [CODE] `server/share.js:130-172` | all |
| `turn` | 1 = turning point, 0 = conversion, NULL = unscored | **only** sidecar or export fields via `setTurn` [CODE] `import.mjs:98-102,127,134` | `SERVED`; picker tier/handicap [CODE] `server.js:252,262`; daily tiers `:282-285`; client caption "Turning point: you were behind / the game was even" [CODE] `public/app.js:1568` (visible); `botPuzzle` `:307` (bots, `/api/daily`) | 1: 20,021; 0: 49,602; NULL: 1,489 (1,481 7×7/8×8, 6 pdg, 2 ps) |
| `swing` | JSON of exactly 8 keys `pre0, pre2, pre4, lostBefore, alt, alts, altsAt, esc` [CODE] `import.mjs:94,99` (§1.2) | import from the sidecar or export | `swingPublic` sends `pre0`, non-empty `alts`, `altsAt` [CODE] `server.js:204-207`; client `slowerWins()` [CODE] `app.js:1071-1075`, used at `:588` | non-NULL on all 71,112 rows (pdg rows hold all-null keys) |
| `flaw` | 1 = `alts` or `altsAt` non-empty; 2 = refund mark (a refunded miss and no stored alternative) | recomputed from swing on every `setTurn` [CODE] `import.mjs:101-102`; then `REFUND_MARK` [CODE] `:151-153` | picker `FLAW` +100 / `REFUNDED` +400, no `PLAYED` pull [CODE] `server.js:220,226,252-253`; daily tiers `:280-285` | lyra: 1 = 19,419, 2 = 0 (no refunded attempts locally). crux: 21 rows had `flaw = 2` [DOCS] SD §2.8 |
| `grade` | A–D for conversions | import: `UPDATE puzzles SET grade = NULL`, then grades.jsonl, then overrides [CODE] `import.mjs:136,140-144`; export field only when no grades file exists (crux) [CODE] `:128` | `SERVED`; nothing else in the server. The daily tiers ignore it, so tier 4 (`turn IS NOT NULL`) can draw a D conversion [CODE] `server.js:285` | A 6,458 (incl. 6 pdg with `turn` NULL, 1 turn = 1); B 8,712; C 13,371; D 20,582; NULL 21,989 |

`turn = 1` rows that also carry a grade [DB]: 10. These are p878742, p877487, p877251, p871685, p853009 and p838023 (all D, 1-ply 6×6, still served as turning points), p878572 (B), pd840615 (B), pd613306 (C) and pd611857 (A). The schema comment says grades are "conversions (turn = 0) only" [CODE] `server.js:42`. SD §2.8 counted ten such rows too, "promoted by syn6 after grading".

### 1.1 `meta` keys [DB]

| key | rows | who sets it | used at runtime |
|---|---|---|---|
| `gameId, date, white, black, ratingWhite, ratingBlack, ply, lastMove, rootWins, factors, mainLine, history` | 71,112 | miner row [DOCS] SD §2.2 (`mine-playtak.mjs:101-112`); `history` at import | `white/black/ratings/history` (client, share); `lastMove` (share image; the client animates it [DOCS] SD §2.2); `factors` (`reprior.mjs`, `rerate.mjs`) |
| `prevTps`, `gameLine` | 71,106 (all but pdg) | miner | `prevTps` is the scoring input (pre0) [DOCS] SD §2.5 |
| `nodes` | 70,593 (not pc/pdg) | miner | prior's search factor |
| `screen` | 33,233 (every ps) | `mine-swing.mjs` screen: `{pre0, lostBefore, alt, altMove, turn, trigger, pS, found, wonGame, gameResult, nodes}` [DOCS] SD §2.4 | none. Its `turn` is **not** the stored `turn` [DOCS] SD §2.4 |
| `prover` | 28,260: `pns` 27,872, `quiet` 116, `exact` 272 | deep builder / mine2 | none found |
| `attNodes` | 27,988 | deep builder | none found |
| `mine2` | 513 (pc) | crux mine2: `{missed, lostPrev, epLen, synPlies, synMin, gameHas, slowerSyn, alt, wins:[{m,plies,pv}], turn, flaw, turnWhy, pre0Used, altUsed}` | none. A second copy of turn/flaw beside the columns |
| `seed` | 513 (pc) | provenance string ("swedishchef … re-proved by tinue") | none |
| `dragon` | 6 (pdg) | `{kind:'sub', from, fromSrc, fromPlies, fromTurn, fromGrade, path, …, tier}` | `dragon.path` → `unplayedPlies` → "a line from this game" credit [CODE] `shared/ptn.js:51-54`, `app.js:1557-1567` (visible) |

`meta.mine2.wins[].plies` is the only stored per-move win **length** outside the tree. It covers only the 513 pc rows [DB].

### 1.2 `swing` keys

Who computes them: `score-swing.mjs` passes v1–v3 [CODE] `scripts/score-swing.mjs:387-453` (v1), `:250-279` (v2 `refineOne`), `:314-373` (v3 `patchOne`), then the syn6 and alt-wins patches. Import keeps only 8 keys [CODE] `import.mjs:94`. [DB] = rows where the key is non-null:

| key | meaning | non-null | runtime reader |
|---|---|---|---|
| `pre0` | Tiltak p(attacker) before the loser's mistake | 69,463 | client caption (`pre0 < 0.4` → "you were behind") [CODE] `app.js:1568` |
| `pre2`, `pre4` | the same 2 and 4 plies earlier | 69,109 | none |
| `lostBefore` | df-pn at `prevTps`: proved / disproved / unknown | 69,109 | none |
| `alt` | best non-tree first move's p | 69,622 | none |
| `alts` | proven slower first moves outside the tree (`[]` = scanned, none found) | 41,602 (non-empty 17,954) | client `slowerWins()` at the root; `flaw` |
| `altsAt` | `{"<space-joined moves so far>": [moves]}` at later attacker nodes, 5-ply puzzles only | 3,336, all `plies = 5` | client `slowerWins()` deeper in; `flaw` |
| `esc` | the loser had an escape at `prevTps` | 14,348 | none |

Sidecar-only keys that import drops [DB, side.mjs]: `puz, altMove, altN, altNT, altNTMove, altTinue, komiUsed, v, ms, cpu, pre0k5, altk5, pre0k0, altk0, pre0Deep, altDeep, demoted, slow1, altsQuiet, refineFail, reason, syn6, altwins-20261115, note, flaw, src, tier, sameTpsAs, turnNote`. Two of them matter for a judge:

- `altsUnk` / `altsAtUnk`: counts of undecided moves (numbers, not lists).
- `slow1`: road-in-1 rows with a proven slower win.

### 1.3 `tree` keys

A node is the string `'win'` or a map `move → {r, n}`; there are no other keys [DOCS] SD §3.0; [CODE] `app.js:560-562`. Served pool [DB, book.mjs]: 47,679 attacker nodes and 71,185 keys. Every tree's depth equals `plies`. 13,902 served rows are 1-ply (tree = `'win'`, no stored key).

### 1.4 `themes` values [DB]

Each entry is total / served. Tag definitions are in [CODE] `shared/themes.js:2-24`.

| tag | total / served | tag | total / served | tag | total / served |
|---|---|---|---|---|---|
| s5 | 47,938 / 18,535 | s6 | 20,210 / 7,675 | stackRoad | 13,734 / 4,748 |
| roadIn1 | 27,849 / 13,827 | placement | 18,304 / 7,947 | smash | 10,946 / 4,659 |
| capture | 27,397 / 9,800 | tinueIn2 | 7,085 / 3,090 | throw | 10,930 / 5,156 |
| tinueIn4 | 26,907 / 6,448 | tinueIn3 | 6,416 / 2,981 | wallBlock | 5,593 / 1,643 |
| fork | 22,945 / 6,186 | reveal | 4,330 / 1,012 | gaelet | 2,855 / 132 |
| spread | 22,876 / 7,816 | s4 | 1,483 / 268 | s7 | 1,053 / 0 |
| s8 | 428 / 0 | quietMove | 380 / 32 | dragon | 113 / 77 |

Rare-theme filters fall through to the fallback stage almost at once. For example 6×6 `quietMove` has 5 served rows out of 130 [DB].

---

## 2. Sidecars and their precedence

### 2.1 The "7 sidecars" of CLEANUP

This is SD §2.8's table [DOCS]: `swing.jsonl` (v1), `swing-v2`, `-v3`, `-v4`, `deep-v3`, `deep-v4`, `ps-v3`. Today `data/swing/` holds 12 sidecar files, plus `.bak-*` copies [DB, side.mjs]:

| file | rows | prefixes | turn 1 / 0 / null | rows with alts / altsAt | syn6-marked | matches DB |
|---|---|---|---|---|---|---|
| swing.jsonl (v1) | 14,592 | p | 2,080 / 11,024 / 1,488 | 0 / 0 | 0 | superseded |
| swing-v2 | 14,592 | p | 1,962 / 11,142 / 1,488 | 2,133 / 0 | 0 | superseded |
| swing-v3 | 14,592 | p | 1,837 / 11,267 / 1,488 | 2,154 / 942 | 0 | superseded |
| **swing-v4** | 14,592 | p | 1,822 / 11,282 / 1,488 | 2,192 / 942 | 159 | **14,570 / 14,570** |
| deep-v3 | 23,436 | pd | 1,024 / 22,411 / 1 | 11,276 / 0 | 0 | superseded |
| **deep-v4** | 23,436 | pd | 1,003 / 22,433 / 0 | 11,366 / 0 | 226 | **22,790 / 22,790** |
| ps-v3 | 37,166 | ps | 18,905 / 18,259 / 2 | 5,450 / 2,426 | 0 | superseded since 11-16 20:16 |
| **ps-v4** (new 11-16) | 37,166 | ps (5×5 + 6×6) | 18,572 / 18,592 / 2 | 5,458 / 2,426 | 5,206 | **33,233 / 33,233** |
| ps6-le5-side (new) | 8,131 | ps 6×6 ≤5 | 4,610 / 3,519 / 2 | 1,134 / 593 | 4,900 | equal to ps-v4 on all 8,131 ids |
| ps6-ge7-side (new) | 404 | ps 6×6 7+ | 125 / 279 / 0 | 85 / 0 | 144 | equal to ps-v4 on all 404 ids |
| **sc-deploy-now-v1** (new) | 513 | pc | 343 / 170 / 0 | 0 / 0 (fields `pre0, alt, turn, flaw, alts, slow1, lostBefore, src`) | 0 | **513 / 513** |
| **dg-subs-v1** (new) | 6 | pdg | 0 / 0 / 6 | 0 / 0 (fields `turn, flaw, src, tier, sameTpsAs, turnNote`) | 0 | **6 / 6** |

"Matches DB" means the 8-key `swing` JSON and `turn` both equal the DB row [DB, prec.mjs]. The other grade inputs:

- `data/grade/grades.jsonl` [DB]: 49,117 rows (p 11,253; pd 21,957; ps 15,907). It is the 11-14 run plus 3,519 ps6 rows appended on 11-16 [DOCS] `scripts/grade/README.md` "Hand grades". Re-running grade.py drops those 3,519 ps6 grades [DOCS] same paragraph.
- `scripts/grade-overrides.jsonl` (tracked): 13 rows, listed in §5.
- `docs/alt-wins-changes.jsonl` (tracked): a record of 71 field changes. It is documentation; import does not read it [CODE] (grep).

All of `data/` is gitignored [CODE] `.gitignore`. Only the two tracked files are versioned.

### 2.2 Precedence rules today [CODE] `scripts/import.mjs`

1. **Rows.** Files in one directory, sorted by name [CODE] `:107`. Exact-TPS dedupe: whichever id already holds that TPS (in the DB or earlier in the run) wins, and the newcomer is skipped [CODE] `:113,120-122`. There is no symmetry or colour handling; 384 ids are redundant under board symmetry [DOCS] SD §2.8.
2. **Upsert.** Every content field is refreshed, `init_rating` included. `rating` is reset only while `attempts = 0`. `rd`, `vol`, `attempts` and `solves` are never touched [CODE] `:108-112`.
3. **turn / swing / flaw.** The `--swing` file, or by default the first that exists of swing-v4, -v3, -v2, swing.jsonl [CODE] `:53`. It overrides for **every DB row it names, not just this directory's** [CODE] `:132-134`. Next comes an export row's own `turn`/`swing`, when `swing` is present and the sidecar lacks the id [CODE] `:127`. Otherwise the DB keeps what it has. Each run takes exactly one sidecar.
4. **Superseded-sidecar refusal** (exit 2 unless `--allow-superseded`) [CODE] `:54-92`. A file is refused if: its name or realpath is `<family>-vN` and a higher vM exists beside it or in `data/swing/`; or it is the same inode as such a file; or an id that another sidecar marks `syn6` appears here without the marker. Only `syn6` is guarded by content. The alt-wins stamp (`altwins-20261115`) is not, so a post-syn6, pre-alt-wins copy renamed to `swing-v4.jsonl` would pass and silently revert the alt-wins `alts`. [INFER] from `:79-86`: only `"syn6"` is searched.
5. **flaw** = 1 iff `alts` or `altsAt` is non-empty, on every `setTurn` [CODE] `:101-102`. Then `REFUND_MARK` sets 2 where `flaw IS NULL` and a refunded attempt exists [CODE] `:151-153`. A refunded puzzle that later gains alts drops from 2 to 1, by design (comment `:149`).
6. **grade.** If a grades file exists: `UPDATE puzzles SET grade = NULL` for **all rows**, then the file's grades [CODE] `:136`. An export's grade is used only when no grades file exists (crux) [CODE] `:128`. Then `grade-overrides.jsonl` wins over both [CODE] `:137-144`. The overrides file is validated before anything is written [CODE] `:36-50`.
7. **meta.history** is filled from `data/raw/games_anon.db` when absent [CODE] `:15-24`.

**Build recipe today [INFER].** The puzzle files are split over five directories: `data/puzzles` (62,058 rows), `data/puzzles-ps6` (8,131), `data/puzzles-ps6ge7` (404), `data/puzzles-sc6` (513) and `data/puzzles-dragon` (6) [DB]. Each run takes one directory and one sidecar [CODE] `:53,93`. The header comment still says "two runs" [CODE] `import.mjs:4`, and SD says three [DOCS] SD §2.8. A from-scratch build now needs at least five runs: (default swing-v4) + `--swing deep-v4` + `--swing ps-v4` (ps-v4 covers every ps id, and ps-v3 is now refused) + `--swing sc-deploy-now-v1` + `--swing dg-subs-v1`, and they must load directories in the order that reproduces the TPS dedupe winners. No repo script records this recipe: grep finds no reference to the new directories or sidecars. On crux, by contrast, one run of the export suffices [CODE] `deploy-crux.sh:36`.

---

## 3. Offline stages that exist

Every stage below except the final import runs outside `import.mjs` and writes gitignored files.

| stage | script | where / when | output | evidence |
|---|---|---|---|---|
| A shallow mine (`p`) | `scripts/mine-playtak.mjs` (exact `mateIn`, u = 5, 3, 1) | lyra 11-07 | `data/puzzles/playtak-{4..8}.jsonl`, 14,592 | [DOCS] SD §2.2; [CODE] `mine-playtak.mjs:103` |
| B deep mine (`pd`, `j`) | `scripts/mine-deep.mjs` + `shared/deep.js` (df-pn walk-back 7–15) | crux 11-07/08, old-Zobrist code copy | `deep-playtak.jsonl`, 23,436 | [DOCS] SD §2.3 |
| C swing mine (`ps`) | `scripts/mine-swing.mjs` (Tiltak scan + prove) | crux 11-08/09 | `data/mined/swing-playtak.jsonl` 37,166, then the 5×5 selection `swing-playtak-5.jsonl` 26,528 | [DOCS] SD §2.4; [CODE] `mine-swing.mjs:245` |
| D scoring v1 / v2 refine / v3 patch | `scripts/score-swing.mjs` | crux | sidecars v1–v3 per set | [DOCS] SD §2.5; [CODE] `score-swing.mjs:61,250-279,314-373` |
| D4 syn6 | `syn6/screen.mjs` (not in repo), native Syntaks | crux 11-15 | rows rewritten in swing-v4 (159), deep-v4 (226) | [DOCS] SD §2.6 |
| alt-wins | `scan2/prove2/synreply/validate/stillcheck.mjs` (session scratch, not in repo) | lyra + crux 11-15 | patched swing-v4, deep-v4, deep-playtak.jsonl, grades; record `docs/alt-wins-changes.jsonl` (71 rows) | [DOCS] SD §2.6; `docs/alt-wins.md` |
| E grades | `scripts/grade/`: 7 steps (`feats`, `composer_walk(_tp)`, `search_cheap`, `v2_walk`, `v2_forks.py`, `v2_fin`, `grade.py`; plus `composer_show` for display) | lyra/crux 11-14, plus the ps6 append 11-16 | `data/grade/grades.jsonl` | [DOCS] SD §2.7, grade README |
| mine2 | crux `~/tinue-mine2` (not in repo): ps 6×6 re-screen, swedishchef seeds, old games, quiet chain, dragons, 8M verify gate | crux 11-15 → | the 11-16 imports below | [DOCS] SD §2.9 |
| ps6 ≤5 import | session scripts → `data/puzzles-ps6/ps6-le5.jsonl` + `ps6-le5-side` + ps-v4 + 3,519 grade rows | lyra 11-16 20:16 (backup `bak-pre-ps6-20261116-2016`) | +8,131 rows | [DB] file mtimes; [DOCS] SD §8.2 ("Status: not imported" at 14:50) |
| batch 2 | `puzzles-ps6ge7` (404, the 7+ ply rows that passed the alt-win check), `puzzles-sc6` (513 pc), `puzzles-dragon` (6 pdg) + their sidecars + overrides `c0b0373` | lyra 11-16 21:32 (backup `bak-pre-batch2-…`) | +923 rows | [DB]; [CODE] git log |
| F import | `scripts/import.mjs` | lyra builds, crux via export | `puzzles` | §2.2 |
| deploy | `scripts/deploy-crux.sh` export → crux import | — | crux `puzzles` (upsert of every row each deploy) | [CODE] `deploy-crux.sh:12-36` |
| side scripts | `reprior.mjs` (rewrites file priors), `rerate.mjs` (ridge refit, writes `rating` only) | on demand | — | [CODE] `scripts/reprior.mjs:1-20`, `scripts/rerate.mjs:98-101` |

**How a row becomes served [CODE].** A row is served if `turn = 1` (set only by a scoring sidecar) or `grade = 'A'` (set by grades.jsonl or an override) (`server.js:236`). It becomes unserved when the sidecar says `turn` 0/NULL and the grade is not A. In practice the levers are: a scoring pass demotes it, grade.py does not give A, or a hand override row sets D (for example the 3 holds and 4 alt-wins pulls). There is no other status flag. The **refund mark** (`flaw = 2`) only ranks a row last, within whichever stage it is in [CODE] `:221-226,252`.

**Served pool today [DB, served.mjs]:**

| size, kind | served | turning points | A conversions |
|---|---|---|---|
| 4×4 p | 268 | 203 | 65 |
| 5×5 p | 1,055 | 847 | 208 |
| 5×5 pd | 2,887 | 582 | 2,305 |
| 5×5 ps | 14,589 | 12,310 | 2,279 |
| 5×5 pdg | 4 | 0 | 4 (turn NULL) |
| 6×6 p | 1,033 | 771 | 262 |
| 6×6 pd | 1,082 | 230 | 852 |
| 6×6 ps | 5,215 | 4,735 | 480 |
| 6×6 pc | 343 | 343 | 0 |
| 6×6 pdg | 2 | 0 | 2 |
| 7×7, 8×8 | 0 | — | — |
| **all** | **26,478** | 20,021 | 6,457 |

By size and length (turning points / A):

| plies | 4×4 | 5×5 | 6×6 |
|---|---|---|---|
| 1 | 172 / 0 | 9,639 / 0 | 4,091 / 0 |
| 3 | 20 / 39 | 1,172 / 496 | 938 / 442 |
| 5 | 11 / 26 | 1,246 / 839 | 575 / 302 |
| 7 | — | 767 / 1,127 | 246 / 309 |
| 9 | — | 399 / 929 | 126 / 271 |
| 11 | — | 254 / 761 | 55 / 144 |
| 13 | — | 186 / 331 | 24 / 73 |
| 15 | — | 76 / 313 | 24 / 55 |

Totals: 6×6 7,675 served, of which 1,327 at 7+ plies; 5×5 18,535. Rows that are not served and cannot be graded today [DB]: 495 ungraded conversions (ps 6×6 7+ 279, pc 170, p 6×6 22, pd 6×6 24), plus 1,481 unscored 7×7/8×8 rows.

---

## 4. Stored alternative wins: shape and completeness

- **Shape.** `swing.alts = ["c4-", …]` (root moves). `swing.altsAt = {"d2 d1<": ["3b1+", …]}`, where the key is the space-joined moves played so far, attacker and defender, from the puzzle root [CODE] `app.js:1072-1075`; `score-swing.mjs:35`. No length, no proof and no source are stored. `meta.mine2.wins[].plies` (pc only) is the one exception [DB].
- **What makes an entry.** df-pn 3e4 plus a `fullDefense` re-proof at 3e5, or the exact Solver for quiet alts (v2/v3). alt-wins used prove2 + `fullDefense`. syn6 used Syntaks 16M + PV replay or the Solver [DOCS] SD §2.5–2.6, §2.10. The model is threat moves after at most one quiet first move, so entries are proofs but the list is a lower bound [DOCS] SD §2.10.
- **At least one entry is not a proof.** ps505288's `alts` = `["c4-"]` [DB], and its override says c4- "could not be proved to win (would be a false solve)". The row was held (grade D) but its `alts` is unchanged. Anyone who reaches it through `/api/puzzle/:id`, a fallback pick or an old link is credited a solve for c4- [CODE] `app.js:588`.
- **Coverage in the served pool** [DB + sidecars, served.mjs]:

| served, by size and plies | rows | never scanned (`alts` null) | scanned, none | some | with altsAt |
|---|---|---|---|---|---|
| 1-ply (all sizes) | 13,902 | 13,902 | — | — | — |
| 4×4 3/5 | 96 | 0 | 73 | 23 | 19 |
| 5×5 3 | 1,668 | 0 | 1,530 | 138 | 0 |
| 5×5 5 | 2,085 | 2 | 1,845 | 238 | 772 |
| 5×5 7–15 | 5,143 | 2 | 4,588 | 553 | 0 |
| 6×6 3 | 1,380 | 121 | 1,135 | 124 | 0 |
| 6×6 5 | 877 | 104 | 692 | 81 | 334 |
| 6×6 7–15 | 1,327 | 120 | 1,035 | 172 | 0 |

The 345 never-scanned 6×6 rows are 343 pc and 2 pdg. Undecided moves left by the scans (counts kept only in the sidecars, `altsUnk` + `altsAtUnk`) [DB]:

- served rows: 1,134 rows / 2,137 moves;
- served 6×6: 392 rows / 976 moves;
- all rows: 8,019 rows / 16,434 moves.

The separate alt-wins scan left 2,411 undecided 6×6 first moves in 358 puzzles [DOCS] SD §8.1; the job file has 2,493 [DOCS] SD §8.3.

- **What is never covered**: anything past the root of a 7+ ply line (no `altsAt`); 7×7/8×8; quiet same-length keys at non-root nodes of deep trees; 5×5 conversions in the alt-wins scan [DOCS] SD §8.1. Live play fills these gaps with the browser still-check, play-on and held results [DOCS] SD §3.1–3.4.

---

## 5. Hand fixes and what protects them

| fix | where it lives | could an import or rebuild undo it? | protection today |
|---|---|---|---|
| pd575074 A → D (quiet 9-ply win) | crux one-row update on 11-16 13:08; `alt-wins-changes.jsonl` row 71; `grade-overrides.jsonl` | Before 1d663c1 (11-16 20:42), yes: a re-run of grade.py or a stale lyra export would have reverted it | Now the override, applied last on lyra **and** on crux (`deploy-crux.sh:36` runs import with the default overrides, and `scripts/` is rsynced) [CODE] `import.mjs:34,140-144`. Its `alts` is still `[]` and the tree does not list 4c3+ [DB] |
| pd424243, pd98272, pd816821 → D | overrides | as above | overrides |
| 3 holds (ps505655, ps702036, ps505288) → D | overrides (`hold-20261116`) | grade only; ps505288's unproven `alts` stays live | overrides; nothing guards swing |
| 6 dragon sub-positions → A | overrides (`dragon-20261116`) | grade.py never sees pdg rows | overrides |
| 13 extended trees (15 same-length quiet root keys), 18 syn6 plies-fixes, dragon retag | patched `data/puzzles/deep-playtak.jsonl`, `playtak-*.jsonl`, `swing-playtak-5.jsonl` (gitignored) | **yes**, by any re-mine or regeneration of those files. A crux-only tree edit is overwritten by the next export | none in code. Records: `alt-wins-changes.jsonl` (alt-wins only) and `.bak` files |
| alt-wins `alts` additions (32 puzzles) and syn6 turn changes (385 rows; ps-v4 adds 5,206 syn6 marks) | swing-v4, deep-v4, ps-v4 (gitignored) | an older sidecar: refused by name, inode or the syn6 marker. A renamed pre-alt-wins post-syn6 copy is **not** refused [INFER] §2.2 | supersession check `import.mjs:54-92` |
| ps6 grades (3,519 rows) | appended to grades.jsonl | **yes**: grade.py rewrites the whole file [DOCS] grade README | none; the README warns |
| refund mark (`flaw = 2`) | derived on each import from crux attempts | cleared whenever the row gains `alts` (by design) | recomputed every import |
| hand prior resets on crux (6 refunded puzzles) [DOCS] SD §5.6 | crux `rating`/`rd` | `rating` resets to `init_rating` only while `attempts = 0`. `rerate.mjs --apply` ratings on unplayed rows are undone by the next import [INFER] from `import.mjs:112` + `rerate.mjs:100` | — |

CLEANUP's diagnosis that "an export … undo[es] a hand fix such as pd575074" holds for every field except `grade`, `rating` (once played), `rd`, `vol`, `attempts` and `solves`. The deploy upserts every content column of every row from lyra [CODE] `import.mjs:108-112`, `deploy-crux.sh:17-20`. Only grade hand fixes have had a code-level guard, and only since 11-16 20:42.

---

## 6. Proposed mapping to `kind`, `grade`, `status`, `book`

[INFER] throughout. These are proposals, not facts. "Visible" marks a change that needs Sasha's yes.

### 6.1 `kind` (replaces `turn` and the semantics of the id prefix)

- Values: `turning` (today `turn = 1`), `conversion` (`turn = 0`), `unscored` (`turn` NULL: 1,481 7×7/8×8, 6 pdg, 2 ps).
- `pre0` must survive: in `kind` evidence, `meta`, or a `pre0` column. The turning-point caption reads `turn === 1` and `pre0 < 0.4` [CODE] `app.js:1568`. Dropping it is visible.
- The scoring evidence (`pre2, pre4, lostBefore, alt, esc` and the dropped sidecar keys) moves to an audit table or file keyed by id. Nothing at runtime reads it [CODE] `swingPublic` `server.js:204-207`.
- Provenance (`p/pd/ps/pc/pdg`) becomes a tag, as CLEANUP part 4 says ("`p`, `pd`, `ps` and `pc` become a `source` tag"). Two caveats:
  - a `source` column already exists and holds `'PlayTak'` on every row [DB], so the tag needs another name (e.g. `miner`) or `source` must be redefined;
  - `pdg` postdates the docs.
- `kind` is set by the verifier or scorer, never by import.

### 6.2 `grade`

Keep A–D for conversions, written by one grade script from the verifier's output (CLEANUP part 4). Hand grades stay as an overrides table or file applied last. Cleanups:

- Clear grades on the 10 `turn = 1` rows, or decide that turning points can be graded. Six 1-ply 6×6 turning points are graded D yet served. Changing their status is visible.
- `pdg` rows are served through a grade with `turn` NULL. Either give them `kind = conversion` or `status = served` directly.

### 6.3 `status`

`status` replaces the `SERVED` predicate. It also replaces `flaw = 2` as a state, the holds, and "unscored fallback". Values the documents and code imply:

| value | today's equivalent | rows today [DB] | source |
|---|---|---|---|
| `served` | `turn = 1 OR grade = 'A'` | 26,478 | `server.js:236` |
| `reserve` | everything else | 44,634 | CLEANUP 4: "Mark them `reserve` and exclude them from rescoring, export and stubs" |
| `rejected` | the verifier refutes the tree, or a key is not unique enough; today grade D for faster wins (4 pulls) and broken rebuilds (38 syn6 broken-pull/rebuild) | ≥ 7 hand-pulled + syn6 D | CLEANUP "Done when": "differs only by decided changes and verifier rejections"; CLEANUP 4 "[verifier] owns … `status`" |
| `held` | override rows with `hold-20261116` (3), awaiting review | 3 | `grade-overrides.jsonl` |
| (optional) `unrated` / collection `hard` | MINING's proposed "hard" collection, "unrated until Sasha decides" | 0 | MINING Deliverables |

Decisions the plan must make explicit:

- **Visible: what `reserve` means to the picker.** Today non-served rows are still picked in the fallback stage [CODE] `server.js:239-243`. That is all 1,481 7×7/8×8 puzzles and most rare-theme filters (e.g. 6×6 `quietMove` 5 served of 130; 4×4 `gaelet` 0 of 36). If `reserve` is excluded from `/api/next` and the export, the 7×7 and 8×8 options lose every puzzle and theme filters run dry. Either keep a fallback stage over `reserve`, or give 7×7/8×8 and rare themes their own status, or get Sasha's yes.
- **`/api/puzzle/:id` and old links.** Gaelet and old share links fetch any id [CODE] `server.js:604-607`. `rejected` and `held` rows must still return something: a 200 marked unrated, or a 410. They must not be rated: `/api/result` rates any id today [CODE] `:612-645`.
- **`flaw` disappears as a column but its ranking terms carry weight.** FLAW +100 (another first move wins) and REFUNDED +400 shape picks and are covered by the Z3 proof [CODE] `server.js:212-226`. CLEANUP's in-memory picker tuple `(id, size, rating, rd, attempts, status, themes, gameId)` drops `flaw`, and its "minus the removed terms" does not say which terms go. Recommendation:
  - derive "has stored alternatives" from `book` (any book row whose `puzzle_id` and `node` match the root, other than a key);
  - keep "refunded, unfixed" as a picker penalty computed from attempts;
  - or get Sasha's yes to drop them, since removing them changes which puzzles players get.
- **Visible: the daily** draws from `turn`/`flaw` tiers [CODE] `server.js:281-289`, and tier 4 can pick an unserved D conversion. Re-express it on `status = served` + `kind`. Narrowing it is a change for Sasha.
- **Visible: CLEANUP 4's "With 5×5 conversions unserved".** That would remove 4,792 served 5×5 A conversions [DB]. Neither SD §8.2 nor the overrides record such a decision, so it needs Sasha's yes.

### 6.4 `book` (keyed by position)

The judge's question is: "after this move, does the attacker still have a proven forced win, and in how many plies?"

**Key.** Board part of the TPS plus side to move, with the move number stripped, plus half-komi, e.g. `x,1,1,1,x,x/…/1,x,2,x,x,2 2|0`. Size is implicit in the board. Use `Game.toTPS()` [CODE] `shared/tak.js:98`. Komi must be in the key because flat wins depend on it. Optionally canonicalise under the 8 board symmetries. That merges transpositions across ids: 384 ids are redundant under symmetry [DOCS] SD §2.8. It only helps if every producer and the judge use the same canonical form. The deep crate's Zobrist key is 64-bit [DOCS] SOLVER §1. Store the text key, not the hash: tinue's own keys had ~33 effective bits on the crux copies [DOCS] SD §2.1.

**Columns:**

| column | content |
|---|---|
| `pos` | the key above (PK, or PK together with `attacker`) |
| `attacker` | colour, 1 or 2 |
| `win_len` | plies the attacker needs from `pos`, defender to move: odd, counting the defender's reply. MINING: "position after the move, `win_len`" |
| `exact` | 1 when a disproof at `win_len − 2` exists |
| `model` | `full` / `threat` / `threat+1quiet` |
| `proof` | enum source: `tree-brute` (mateIn/buildTree, exhaustive at R ≤ 5), `tree-dfpn` (deep threat-model trees, R ≥ 7, never fullDefense-confirmed [DOCS] SD §8.1), `refine` (df-pn 3e4 + fullDefense 3e5), `solver-quiet`, `altwins`, `syn6` (Syntaks PV + replay), `deep-cert` (the new crate), `live` (a play-time proof on crux) |
| `checked` | 1 when the proof checker (SOLVER §5) replayed it |
| `puzzle_id` | the row that produced it |
| `commit` | the producing commit sha (CLEANUP 1 asks for it on every output row) |
| `ts` | time written |

Book rows hold wins only. A "no" from the judge is a miss or a play-out, not a book row. A `maxFail`-style disproof column is optional: SOLVER §2 keeps `maxFail` per position, and the alt-wins run refuted 155 moves [DOCS] SD §2.6.

**Rows, served pool** [DB, book.mjs + alts.mjs, replaying every tree key and every alt with `shared/tak.js`]:

| source | entries | distinct positions | length known? |
|---|---|---|---|
| tree keys (position after each key) | 71,185 | 69,226 (6×6: 20,246) | yes. win_len counts the defender's reply: 1 + depth(next node). Distribution per key: 2 (meaning the reply and then a road in 1) 36,082; 4 16,942; 6 9,024; 8 4,897; 10 2,588; 12 1,164; 14 488 |
| `alts` + `altsAt` | 6,694 | 6,680 (6×6: 2,459); 0 coincide with a tree position | **no**: needs a length pass (deep cert for 6×6; `shortestTinue` elsewhere) |
| **total** | | **75,906** (6×6: 22,705) | |
| whole DB, for scale | 532,175 keys + 97,013 alts | 496,036 + 96,411 − 5 = 592,442 | |

Three properties of the tree positions:

- **Consistency.** Across all 496,036, no position appears with two different lengths [DB, book.mjs `lenConflicts: 0`]. The table can therefore enforce one length per key, and a conflict on insert is worth failing loudly.
- **Length semantics.** The lengths are exact only under each puzzle's proof model. Deep trees are threat-only at R ≥ 7, and pd575074 and three others had faster quiet wins [DOCS] SD §8.1. So `exact`/`model` matter, and the deep certifier should replace them for 6×6 ("lengths must match `plies`, and any mismatch is a finding" [DOCS] MINING Setup).
- **1-ply puzzles** (13,902 served) contribute no rows. The finishing move ends the game, and the rules detect it.

The book cannot hold the stored defender replies: the tree keeps those. The book is the judge's cache of proven wins, not the puzzle line. Off-tree wins proved live on crux (attempt logs with `k = 'slow'` [CODE] `server.js:51`) are a further source, and only crux has them.

---

## 7. Where the documents and the code or data disagree

1. **"7 sidecars" / "3 import runs".** There are 12 sidecar files today, of which 5 are live, plus grades.jsonl and the overrides file. A rebuild needs at least 5 runs over 5 directories, and that recipe is in no repo script (§2.2). `import.mjs:4` still says two runs.
2. **"62,058 rows", "84 MB export", "66% outside the pool".** These are the 11-16 13:00 snapshot. Today: 71,112 rows, a 96 MB export (17 MB gz), 62.8% outside [DB].
3. **"With 5×5 conversions unserved, only about 1,100 rows need a grade".** 1,100 matches the 6×6 served conversions at the snapshot (262 + 856 [DOCS] SD §2.6). Today 1,596 6×6 A conversions are served, 14,127 6×6 conversions exist, and 495 conversions are ungraded. 5×5 conversions are still served (4,792 A). No decision to unserve them is recorded.
4. **"Mark them `reserve` and exclude them from rescoring, export and stubs".** Unserved rows are served today through the fallback, including all 7×7/8×8 rows. Excluding them from the export is a visible change (§6.3).
5. **"risk of an export undoing a hand fix such as pd575074".** Grade hand fixes have been protected since 1d663c1 / 0047e7d (11-16 20:42–20:51) by `scripts/grade-overrides.jsonl` on both machines. Tree, swing and turn hand fixes are still unprotected (§5).
6. **CLEANUP's list of today's state omits** `flaw = 2` (refund mark, derived from crux attempts), the grade overrides file, `meta.mine2.turn/flaw` duplicates, and `pre0`, which the client shows. `altsUnk` is dropped at import, so the DB cannot tell "no alternatives" from "not decided".
7. **"p, pd, ps and pc become a source tag".** A `source` column already exists ('PlayTak' everywhere), and a fifth prefix `pdg` exists (6 rows, served).
8. **MINING candidate pool "the 938 `ps` rows at 7+ plies".** 404 of them were imported on 11-16 (`ps6-ge7-pass`), 125 as turning points. A new miner must dedupe against them.
9. **Grade D "never serve"** (grade README) is enforced neither in the picker fallback nor in daily tier 4 [CODE] `server.js:239-243,285` (also SD §5.4). Six D-graded 1-ply 6×6 rows are served as turning points [DB].
10. **ps505288** is held as D because its stored alt "could not be proved", but the alt is still in `swing.alts`. A player who reaches the puzzle by id gets a false *solve*, not a false miss.
11. **`altsAt` scope.** The `score-swing.mjs:35` comment says "(5+ ply)". The data has it only on 5-ply rows [DB], matching SD §2.5 ("5-ply puzzles only").
