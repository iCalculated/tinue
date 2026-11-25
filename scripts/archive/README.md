# scripts/archive

One-offs that already ran and superseded experiments, kept for the record. Nothing here is deployed or run on a schedule.
Paths inside them are fixed up for this folder, but they are not maintained: schemas and constants may have moved on.

- `migrate-vol-2026-11-15.mjs`: moved accounts to volatility 0.06 (ran 2026-11-15, commit 665b461).
- `simulate-glicko.mjs`: Elo vs Glicko-2 for newcomers (vol 0.09 era); `../simulate-newcomers.mjs` uses the live rules.
- `measure-swing.mjs`, `report-swing.mjs`, `mine-swing-pilot.mjs`: turning-point pilots behind `docs/mining-options.md` and
  `docs/research/mine-swing-pilot.md`; superseded by `../score-swing.mjs` and `../mine-swing.mjs`.
- `mine-all.sh`: the first stratified `mine-playtak.mjs` run (playtak-N.jsonl).
- `test-sample.mjs`: ad-hoc analyzer probe over a JSONL of puzzles.
- `reprior.mjs`: re-clamped stored priors when the ceiling went 2900 → 3500 (commit 5a89eb2, 2026-11-08). Miners rate
  with the current clamp, so it is only needed if `PRIOR_MIN`/`PRIOR_MAX` change again.
- `rerate.mjs`: batch joint MAP re-fit of every player and puzzle rating (archived 2026-11-17 with L4: ratings are now
  replayed from the attempt ledger by `../replay-ratings.mjs`; a batch re-fit would rewrite them outside it).
