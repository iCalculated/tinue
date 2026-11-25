#!/bin/sh
# Publish puzzle CONTENT to crux: only rows that are new or changed since what crux has, in one transaction, after a
# snapshot of crux's database. Code goes separately (scripts/deploy-crux.sh); this ships no server code.
# usage: scripts/publish-puzzles.sh [--dry-run] [--all] [--overwrite-remote-edits]
#   --dry-run                print every remote and destructive command; the delta is estimated against the manifest
#                            crux gave on the last publish ($STATE/last-remote.tsv), if there is one
#   --all                    ship every public row except held ones (before 2026-11-17 every deploy shipped all)
#   --overwrite-remote-edits also ship rows that changed on crux since the last publish, here or not (a hand fix on
#                            crux, like pd575074's); without it they are held and listed
# Steps: fingerprint every local public puzzle (scripts/puzzle-rows.mjs) and crux's (the same script, shipped to
# crux's deploy/bin/ first, read-only there) → ship the rows that differ → on crux: snapshot data/tinue.db to
# data/snapshots/, check it, count rows, scripts/import.mjs on just those rows (one transaction; run from the publish
# directory so crux's own sidecars, data/swing and data/grade, are not re-applied to every row), count again, restart
# (the server caches theme counts and board pictures) and wait for health → fingerprint crux again and check every
# shipped row now matches. Nothing to ship = nothing written, no snapshot, no restart.
# Book rows (PLAN B2, §1.1): the local book's live rows that crux lacks or holds only weaker
# (scripts/publish-puzzles-book.mjs, shipped to deploy/bin/ beside puzzle-rows.mjs) go in the same import, the same
# transaction, as crux's next book version (import.mjs --book). Insert-only: a row on crux is never edited or deleted,
# except that a stronger row sets the retired_ver of the weaker one it replaces. A length conflict with crux's book stops
# the publish before anything is written. The new version is NOT served until TINUE_BOOK_VER (the pointer: BOOK_VER in
# deploy-lib.sh, then deploy-crux.sh) is raised to it; lowering the pointer again hides it (rollback). The publish never moves the pointer.
# A change to an existing puzzle's tree, tps or komi bumps its rev; the old ones are kept in puzzle_rev (import.mjs).
# Local DB: $TINUE_DB or data/tinue.db (read-only). Rollback: stop com.shy.tinue, copy the snapshot over data/tinue.db
# (and remove data/tinue.db-wal, -shm), start it; attempts played since the snapshot are lost.
set -e
cd "$(dirname "$0")/.."
ALL=; OVER=
for a in "$@"; do case "$a" in
  --all) ALL=--all ;; --overwrite-remote-edits) OVER=--overwrite-remote-edits ;; --dry-run) ;;
  *) echo "publish-puzzles: unknown option $a" >&2; exit 2 ;;
esac; done
. scripts/deploy-lib.sh
LOCAL_DB="${TINUE_DB:-data/tinue.db}"
[ -f "$LOCAL_DB" ] || { echo "publish-puzzles: no local database at $LOCAL_DB" >&2; exit 1; }
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$STATE"
W="$STATE/publish/$TS"; [ -n "$DRY" ] && W=$(mktemp -d "${TMPDIR:-/tmp}/tinue-publish-dry.XXXXXX")
mkdir -p "$W"
PR="node --no-warnings scripts/puzzle-rows.mjs"
RNODE="'$REMOTE_NODE' --no-warnings"

# 1. crux's fingerprints (read-only on crux; the reader is shipped first, outside the server code)
remote 'mkdir -p ~/Projects/tinue/deploy/bin ~/Projects/tinue/deploy/publish'
push scripts/puzzle-rows.mjs "$HOST":Projects/tinue/deploy/bin/puzzle-rows.mjs
manifest() { # manifest OUT: crux's fingerprints into OUT
  if [ -n "$DRY" ]; then echo "[dry-run] $SSH $HOST \"cd ~/Projects/tinue && $RNODE deploy/bin/puzzle-rows.mjs manifest data/tinue.db > deploy/manifest.tsv && gzip -c deploy/manifest.tsv\" > $1.gz"; return; fi
  # into a file first, so a failing reader fails the ssh (a pipe would report gzip's success and an empty manifest)
  $SSH "$HOST" "cd ~/Projects/tinue && $RNODE deploy/bin/puzzle-rows.mjs manifest data/tinue.db > deploy/manifest.tsv && gzip -c deploy/manifest.tsv" > "$1.gz"
  gunzip -f "$1.gz"
  # An empty answer would make every row look new; a database with no puzzles is a first install (deploy-crux.sh --legacy).
  [ -s "$1" ] || { echo "publish-puzzles: crux reported no puzzles; refusing (a first install goes through scripts/deploy-crux.sh --legacy)" >&2; exit 1; }
}
BK="node --no-warnings scripts/publish-puzzles-book.mjs"
push scripts/publish-puzzles-book.mjs "$HOST":Projects/tinue/deploy/bin/publish-puzzles-book.mjs
book_manifest() { # book_manifest OUT: crux's live book rows into OUT
  if [ -n "$DRY" ]; then echo "[dry-run] $SSH $HOST \"cd ~/Projects/tinue && $RNODE deploy/bin/publish-puzzles-book.mjs manifest data/tinue.db > deploy/book-manifest.tsv && gzip -c deploy/book-manifest.tsv\" > $1.gz"; return; fi
  $SSH "$HOST" "cd ~/Projects/tinue && $RNODE deploy/bin/publish-puzzles-book.mjs manifest data/tinue.db > deploy/book-manifest.tsv && gzip -c deploy/book-manifest.tsv" > "$1.gz"
  gunzip -f "$1.gz"
  head -1 "$1" | grep -q '^#book ' || { echo "publish-puzzles: crux's book manifest has no header; refusing" >&2; exit 1; }
}
manifest "$W/remote-before.tsv"
book_manifest "$W/book-before.tsv"
if [ -n "$DRY" ]; then
  if [ -f "$STATE/last-remote.tsv" ]; then echo "publish: (dry run) estimating the delta against $STATE/last-remote.tsv, crux's manifest after the last publish"; cp "$STATE/last-remote.tsv" "$W/remote-before.tsv"
  else echo "publish: (dry run) no earlier manifest from crux, so the delta below counts every row as new"; : > "$W/remote-before.tsv"; fi
  if [ -f "$STATE/last-remote-book.tsv" ]; then cp "$STATE/last-remote-book.tsv" "$W/book-before.tsv"; else echo '#book 0 0' > "$W/book-before.tsv"; fi
fi
# The record of the last publish: what was shipped then. On a first publish, the last full export (deploy/puzzles/,
# written by the legacy deploy) stands in for it, so a crux-side edit made since is still recognized and held.
PUB="$STATE/published.tsv"
if [ ! -f "$PUB" ] && [ -f "$STATE/puzzles/puzzles.jsonl" ]; then
  echo "publish: no publish record yet; using $STATE/puzzles/puzzles.jsonl (the last legacy export) as the baseline"
  $PR manifest-export "$STATE/puzzles/puzzles.jsonl" > "$W/baseline.tsv"; PUB="$W/baseline.tsv"
fi

# 2. the delta
$PR delta "$LOCAL_DB" "$W/remote-before.tsv" "$W" --published "$PUB" $ALL $OVER
$BK delta "$LOCAL_DB" "$W/book-before.tsv" "$W" || { echo "publish-puzzles: book delta refused; crux was not written" >&2; [ -n "$DRY" ] && rm -rf "$W"; exit 1; }
N=$(wc -l < "$W/shipped.txt" | tr -d ' ')
NB=$(wc -l < "$W/book-shipped.tsv" | tr -d ' ')
if [ "$N" = 0 ] && [ "$NB" = 0 ]; then echo "publish: nothing to publish; crux was not written"; [ -n "$DRY" ] && rm -rf "$W"; exit 0; fi
if [ -n "$DRY" ]; then echo "[dry-run] gzip $W/rows/puzzles.jsonl ($N rows) $W/book/book.jsonl ($NB book rows)"; else gzip -f "$W/rows/puzzles.jsonl" "$W/book/book.jsonl"; fi
BOOKARGS=
if [ "$NB" != 0 ]; then
  BCOMMIT=$(git rev-parse --short=12 HEAD 2>/dev/null) || { echo "publish-puzzles: no git commit to name the book version" >&2; exit 1; }
  BOOKARGS="--book book/book.jsonl --book-commit $BCOMMIT --book-note publish-$TS"
fi

# 3. ship the rows, snapshot, import them in one transaction, restart, health
remote "mkdir -p ~/Projects/tinue/deploy/publish/$TS/rows ~/Projects/tinue/deploy/publish/$TS/book"
push "$W/rows/puzzles.jsonl.gz" "$HOST":Projects/tinue/deploy/publish/$TS/rows/
if [ "$NB" != 0 ]; then push "$W/book/book.jsonl.gz" "$HOST":Projects/tinue/deploy/publish/$TS/book/; fi
remote "set -e; cd ~/Projects/tinue
  NODE='$REMOTE_NODE'; SQLITE='$REMOTE_SQLITE'; TS=$TS; HEALTH_TRIES=30; NB=$NB; BOOKARGS='$BOOKARGS'"'
  D=deploy/publish/$TS; SNAP=data/snapshots/tinue-$TS-pre-publish.db
  # crux'"'"'s import must know --book (B2), or it would take the flag for nothing and skip the book: refuse before writing
  if [ "$NB" != 0 ] && ! grep -q import-book-v1 scripts/import.mjs; then echo "publish: crux'"'"'s scripts/import.mjs predates book publishing (B2); deploy the code first (scripts/deploy-crux.sh). Nothing written."; exit 1; fi
  gunzip -f $D/rows/puzzles.jsonl.gz
  [ "$NB" = 0 ] || gunzip -f $D/book/book.jsonl.gz
  count() { "$SQLITE" "$1" "SELECT COUNT(*) FROM puzzles"; } # a read (no -readonly: a WAL database with no -shm would refuse it)
  mkdir -p data/snapshots
  echo "snapshot: $SNAP"
  "$SQLITE" data/tinue.db ".backup '"'"'$SNAP'"'"'"
  # The copy is made a standalone file (no WAL); journal_mode=DELETE checkpoints first, so its -shm is then only an index.
  [ "$("$SQLITE" $SNAP "PRAGMA journal_mode=DELETE")" = delete ] && rm -f $SNAP-shm $SNAP-wal
  [ "$("$SQLITE" $SNAP "PRAGMA quick_check")" = ok ] || { echo "snapshot: FAILED quick_check; nothing imported"; exit 1; }
  BEFORE=$(count data/tinue.db); SNAPN=$(count $SNAP)
  [ "$BEFORE" = "$SNAPN" ] || { echo "snapshot: has $SNAPN puzzles, the database $BEFORE; nothing imported"; exit 1; }
  echo "snapshot: ok ($SNAPN puzzles, $(du -h $SNAP | cut -f1)); $(ls data/snapshots | wc -l | tr -d " ") snapshots, $(df -h . | tail -1 | awk "{print \$4}") free"
  echo "rows before: $BEFORE"
  # A refused import (exit 1/2) rolled back: nothing written. Exit 4: committed, but the status backfill failed (status
  # decides serving): stop before the restart and say what to run. Either way the publish stops here.
  RC=0; OUT=$(cd $D && "$NODE" --no-warnings ../../../scripts/import.mjs rows $BOOKARGS) || RC=$?
  echo "$OUT" | head -1; echo "$OUT" | grep "^grade overrides\|^refund mark\|^puzzle state\|^puzzle rev\|^book" || true
  if [ $RC = 4 ]; then echo "publish: FAILED AFTER the import committed: puzzle status NOT updated; run (cd ~/Projects/tinue && $NODE --no-warnings scripts/puzzle-state.mjs) and then restart com.shy.tinue. Not restarted."; exit 1; fi
  if [ $RC != 0 ]; then echo "publish: import refused or failed (exit $RC); it rolled back, nothing written, not restarted"; exit 1; fi
  AFTER=$(count data/tinue.db)
  echo "rows after: $AFTER ($((AFTER - BEFORE)) new)"
  launchctl kickstart -k gui/$(id -u)/com.shy.tinue # theme counts and board pictures are cached in the server'"$REMOTE_HEALTH"

manifest "$W/remote-after.tsv"
book_manifest "$W/book-after.tsv"
if [ -n "$DRY" ]; then echo "[dry-run] verify, then record $W/local.tsv as $STATE/published.tsv"; rm -rf "$W"; exit 0; fi
$PR verify "$W/local.tsv" "$W/remote-after.tsv" "$W/shipped.txt"
$BK verify "$W/book-shipped.tsv" "$W/book-after.tsv"
cp "$W/local.tsv" "$STATE/published.tsv"; cp "$W/remote-after.tsv" "$STATE/last-remote.tsv"; cp "$W/book-after.tsv" "$STATE/last-remote-book.tsv"
echo "publish: $N rows and $NB book rows published; record in $W"
if [ "$NB" != 0 ]; then
  echo "publish: crux's book is now at version $(head -1 "$W/book-after.tsv" | cut -d' ' -f2). Nothing is served from it until TINUE_BOOK_VER (BOOK_VER in deploy-lib.sh, then deploy-crux.sh) reaches it; lowering it again hides it."
fi
