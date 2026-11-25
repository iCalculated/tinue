# Conversion grades

Grades the conversion puzzles (turn = 0: the attacker was already winning, a miss wasn't punished, or a slower win
exists) A/B/C/D, so the good ones can be served next to the turning points. Designed 2026-11-14 by three independent
approaches (puzzle composition, real PlayTak misses, search structure), merged, then revised after skeptics replayed
24 sampled puzzles.

- **D, never serve:** road-in-1. A flat-count finish. A node accepting 10+ moves. 3+ fastest first ideas. 5+ winning
  first ideas, counting forcing slower ones.
- **Caps** (each lowers the tier to at most C or B):
  - More than one route: 2 fastest first ideas, or forcing slower first moves.
  - No real decoy at the root.
  - Reserves running out.
  - Ladders: refill/seesaw lines, or the key is the only threat.
  - "Loose" nodes: a second winning idea or a slower win, at a node with 5+ plies left. Judged against turning
    points of the same length, so long lines aren't capped for being long.
- **Score:** a logit fit on real non-bot PlayTak first-move misses. It counts real defender block ideas, forced
  spread/throw/smash motifs and wrong-drop decoys; captures and wall blocks lower it. A small nudge comes from the
  source game. Length is excluded.
- **Tiers from the score:**
  - A: at least the median turning point of the same length.
  - B: at least the 25th percentile.
  - C: below that.

`grade.py` holds the full rule (docstring). Output `data/grade/grades.jsonl` is `{id, tier, score, why}`; `why` names
the caps that fired. `scripts/import.mjs` picks it up by default (`--grades` to override) and fills `puzzles.grade`;
`scripts/publish-puzzles.sh` carries `grade` to crux (`deploy-crux.sh` ships code only).

## Hand grades

`grades.jsonl` is grade.py's output, so a re-run overwrites it: never edit it by hand. A hand grade (a hold, an
alt-wins pull, a puzzle grade.py never sees) goes in the tracked `scripts/grade-overrides.jsonl`, one
`{id, tier, why, ...stamps}` per line, with a `why` naming the reason or who approved it (e.g. `"hold-20261116": true`).
`import.mjs` applies it after the grades file, so it always wins (`--overrides <path>` elsewhere, `--no-overrides` to
skip). A bad tier, a missing id or why, a duplicate id or bad JSON aborts the import before the DB is written; an id
not in the DB yet is only counted. On crux: `deploy-crux.sh` ships the file with the code, and crux's next import (a
`publish-puzzles.sh` that ships at least one row) applies it to every row. A `hold-YYYYMMDD` stamp also sets
`puzzles.status` to `paused` unless the row is served anyway (`server/puzzle-state.js`).

`grades.jsonl` is not one grade.py run, though: the 2026-11-14 run's rows plus 3,519 `ps*` rows appended on 2026-11-16
from a separate pass over the ps6 import (same scripts, run on those puzzles only). grade.py rewrites the whole file,
so re-running it on the inputs now in `data/grade/` drops the ps6 grades. Rebuild the inputs from the current DB first
(feats.mjs reads it, so it should pick the ps6 puzzles up; not yet tried), or append the ps6 pass again.

Ideas: a placement is its square; a stack move is square + direction (drop counts and stone types are one idea).

## Rebuild

Run from `data/grade/`. Heavy steps belong on crux, niced (`DB=` points at any copy of the puzzle DB; read-only).

```sh
node --no-warnings ../../scripts/grade/feats.mjs                          # -> feats.jsonl (turn 0)
TURN=1 OUT=tp-feats.jsonl node --no-warnings ../../scripts/grade/feats.mjs
for i in 0 1 2 3; do node --no-warnings ../../scripts/grade/composer_walk.mjs $i 4 & done; wait
cat composer_ideas.[0-3].jsonl > composer_ideas.jsonl
for i in 0 1 2 3; do TURN=1 node --no-warnings ../../scripts/grade/composer_walk.mjs $i 4 & done; wait
cat composer_tpideas.[0-3].jsonl > composer_tpideas.jsonl
mkdir -p search_out
TURN=0 node --no-warnings ../../scripts/grade/search_cheap.mjs > search_out/cheap0.jsonl   # TURN=1 -> cheap1.jsonl
TURN=0 SHARD=i NSHARD=5 BUD=1e4 node --no-warnings ../../scripts/grade/v2_walk.mjs        # -> v2_walk.0.<i>.jsonl; TURN=1 for TPs
uv run python ../../scripts/grade/v2_forks.py                              # -> v2_forks.{0,1}.jsonl
node --no-warnings ../../scripts/grade/v2_fin.mjs                          # -> v2_fin.jsonl (every puzzle; that run's covered only an id list)
uv run --with pandas --with numpy python ../../scripts/grade/grade.py [--tp] [--ids a,b]   # -> grades.jsonl
```

The 2026-11-14 run walked only the conversions the first draft hadn't put in D on other grounds (plus the 2,465 it
had put in D on route count, as shards `d0`–`d5` via `ONLY=<id file>`). The files in `data/grade/` are that run's.
`composer_show.mjs <ids>` prints a puzzle's main line with keys and decoys per node.

## Known limits
- Uniqueness past the root for 7+ ply rests on the threat-only tree. Quiet same-length wins happen in about 3% of
  deep 7-ply puzzles.
- Only the main line (one stored defence) is walked.
- No on-site solve data yet. Validation is real-game misses, which depend on how each source was mined. Skeptics
  agreed with 12 of 24 sampled tiers and held A to a stricter bar than "median turning point".
- 1,211 conversions have no demotion reason (screen eval only). Their `why` says to recheck them as turning points.
