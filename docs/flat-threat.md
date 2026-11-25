# Flat-threat flag: runbook

`puzzles.flat_threat` is `'exact'`, `'model'` or NULL. It marks puzzles whose forced road win relies on a flat-win
threat (the scan's `needsFlat`). It is stored only: no route, page, feed or build reads it. Sasha's calls: show it, if
ever, only after the attempt, and that is a separate decision. Store all 223 (90 exact, 133 model), hidden.
`scripts/apply-flat-threat.mjs` has the details, and `scripts/test-flat-threat.mjs` checks that it stays hidden.

No server restart and no deploy are needed. The server never names the column, and it runs the same with the column
absent or present. The script adds the column inside its own write transaction, while the server keeps running.

## Production (crux, `~/Projects/tinue`), in order

0. Ship the script and the results file. This needs no deploy. The script imports `server/puzzle-state.js`, which crux
   already has. The results file holds puzzle ids and computed fields only, no player data.

       scp scripts/apply-flat-threat.mjs shy@crux:Projects/tinue/scripts/
       scp <scan results.jsonl> shy@crux:Projects/tinue/deploy/flat-threat-results.jsonl

   Then, on crux:

       cd ~/Projects/tinue
       N=/opt/homebrew/bin/node; R=deploy/flat-threat-results.jsonl; TS=$(date +%Y%m%d-%H%M%S)
       df -h . && ls -la data/tinue.db      # room for one more copy of the database

1. Dry run. It writes nothing to the database, with the server running or not. Save one puzzle's API answer now, to
   compare after the apply.

       $N --no-warnings scripts/apply-flat-threat.mjs $R --db data/tinue.db
       curl -s http://127.0.0.1:8642/api/puzzle/ps632048 > /tmp/flat-before.json

   Expect `selected 223: exact 90, model 133`, `column absent (--apply adds it)`, and
   `plan: flag 223 (exact 90, model 133), already right 0, unflag 0; skipped: missing 0, not served 0, changed since the scan 0; flagged after: 223`.
   Any skip is listed with its ids. A skipped puzzle was paused, rejected or re-imported since the scan; it stays
   unflagged. If the output has a `dry run: --apply would refuse: ...` line, stop: the apply would refuse too.

2. Back up and apply. The script makes the backup first: an online SQLite backup taken in one step (so the server's
   writes cannot stall it), made standalone and quick_checked. It refuses an existing file.
   It then writes everything in one transaction, and refuses unless 200 to 250 rows would end up flagged.

       mkdir -p data/snapshots
       $N --no-warnings scripts/apply-flat-threat.mjs $R --db data/tinue.db --apply --backup data/snapshots/pre-flat-threat-$TS.db

   Expect `applied: {"exact":90,"model":133} (223 written, 0 cleared)` and a one-line `undo:` command (it names
   the node that ran it). If the column already held flags, the undo line also gives the sqlite3 command that puts
   those back from the backup.

3. Verify.

       /usr/bin/sqlite3 data/tinue.db "SELECT flat_threat, COUNT(*) FROM puzzles WHERE flat_threat IS NOT NULL GROUP BY 1"   # exact|90, model|133
       $N --no-warnings scripts/apply-flat-threat.mjs $R --db data/tinue.db | grep '^plan'   # flag 0 ..., already right 223, unflag 0
       curl -s http://127.0.0.1:8642/api/puzzle/ps632048 > /tmp/flat-after.json
       cmp /tmp/flat-before.json /tmp/flat-after.json && echo unchanged   # unchanged: the API answer is byte-identical
                                    # (if someone played ps632048 in between, only its rating/rd may differ: diff the two)
       grep -cE 'flat_threat|"(exact|model)"' /tmp/flat-after.json         # 0
       curl -s http://127.0.0.1:8642/api/stats >/dev/null && echo server up

4. Undo, if needed. Do not copy the backup over `data/tinue.db`: that would also undo every result since the backup.

       $N --no-warnings scripts/apply-flat-threat.mjs --clear --db data/tinue.db --backup data/snapshots/pre-flat-clear-$(date +%Y%m%d-%H%M%S).db

   This sets every row to NULL. The empty column can stay, because nothing reads it. To remove the column too (the
   table is briefly rewritten under the write lock):

       /usr/bin/sqlite3 data/tinue.db "ALTER TABLE puzzles DROP COLUMN flat_threat"

## Keeping it right

- A publish (`scripts/publish-puzzles.sh` → `scripts/import.mjs`) upserts named columns only, so it keeps the flag.
  The test checks this. The flag lives only in crux's database, because the local database is the publish source and
  never carries it.
- A re-import that changes a flagged puzzle's tree (`rev` goes up) keeps the flag, but the flag may then be stale.
  Re-run the scan for that id and then `--apply` again. `--apply` makes the column match the results file exactly:
  it flags what is selected and clears any other flagged row. It also skips ids whose size, plies or komi changed since
  the scan.
- `flatFaster` is not stored.
