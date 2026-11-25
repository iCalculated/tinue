#!/bin/sh
# crux's side of the move, as its user on crux. move.sh copies ops/ there and calls it; each command can be run again.
#   state | stats         what this host is doing; its /api/stats
#   check                 exit 1 unless it can be moved now (node up, nothing else writing the database)
#   preseed               copy the live database and send it, so the real copy is only the difference
#   fence                 stop everything that writes the database, for good; leave the final copy in the outbox
#   send                  send the outbox to the new host
#   unfence               (abort) undo fence
#   take-back SHA         (rollback) fetch the new host's fenced database, check it, make it the database, start
#   hop start|stop|status the ssh forwards: new host's 8643 -> node here, 8644 here -> the new host's port 80. status and
#                         start ask the far end through it (both forwards are one ssh, which ends if either fails)
#   pull                  fetch the newest backup and check it and its age; pull-install: every 10 minutes, by launchd
#   recover --ovh-is-off [FILE]   the new host is LOST: serve its last pulled backup (or FILE). Only once it can't come back
#   DEST=mover@host KEY=~/.ssh/key   the new host (send, preseed, take-back, hop, pull)
#   ALERT=command         pull calls it with one sentence when backups go bad (once until they are good again)
set -eu
T="${TINUE_HOME:-$HOME/Projects/tinue}" W="${MOVE_HOME:-$HOME/Projects/tinue-move}" LA="$HOME/Library/LaunchAgents"
NODE="${CRUX_NODE:-/opt/homebrew/bin/node}" RSYNC="${CRUX_RSYNC:-rsync}" DEST="${DEST:-}" KEY="${KEY:-}" PORT="${PORT:-8642}"
HERE=$(cd "$(dirname "$0")" && pwd); D="$T/data"; G="gui/$(id -u)"
LABELS="com.shy.tinue com.shy.tinue-players com.shy.tinue-guestwatch"
SHA='s/.*"sha":"\([0-9a-f]\{64\}\)".*/sha=\1/p'
WRITERS='scripts/(import|refund|refund-legacy-wins|rejudge|puzzle-state|book-init|apply-flat-threat|replay-ratings)[.]mjs'
mkdir -p "$W/out" "$W/plists"
# One step at a time: an ssh that dropped leaves its step running. (The kernel lets go of the lock however the step ends.)
locked() { if command -v flock >/dev/null; then flock -n -E 75 "$@"; else lockf -s -k -t 0 "$@"; fi; }
case "${1:-}" in preseed|fence|send|unfence|take-back|recover) if [ -z "${MOVE_LOCKED:-}" ]; then
  RC=0; MOVE_LOCKED=1 locked "$W/lock" /bin/sh "$HERE/crux.sh" "$@" || RC=$?
  [ $RC != 75 ] || echo "crux: another step is still running here; wait for it and look again" >&2; exit $RC
fi ;; esac
die() { echo "crux: $*" >&2; exit 1; }
db() { "$NODE" --no-warnings "$HERE/db.mjs" "$@"; }
SSHO="-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"; [ -z "$KEY" ] || SSHO="$SSHO -o IdentitiesOnly=yes -i $KEY"
dest() { [ -n "$DEST" ] || die "set DEST"; }
listening() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }
in_use() { for x in "" -wal -shm; do [ ! -e "$D/tinue.db$x" ] || ! lsof -t "$D/tinue.db$x" >/dev/null 2>&1 || return 0; done; return 1; }
loaded() { launchctl print "$G/$1" >/dev/null 2>&1; }
# -I: never skip a file for having the same size and second as the one there (a preseed and the final copy can)
send() { dest; i=0; until "$RSYNC" -azI --partial --timeout=30 -e "ssh $SSHO" "$@" "$DEST:/var/lib/tinue-in/"; do i=$((i+1)); [ $i -lt 4 ] || die "could not send $*"; sleep 1; done; }
stats() { curl -sf --max-time 5 "http://127.0.0.1:$PORT/api/stats"; }
whole() { case "$1" in *'"integrity":"ok"'*'"missing":[]'*) ;; *) return 1 ;; esac; } # whole MANIFEST
# put the jobs back as fence found them ($W/loaded) and wait for health; run again, it does what is left to do
start() {
  for l in $LABELS; do [ ! -f "$W/plists/$l.plist" ] || mv "$W/plists/$l.plist" "$LA/"; done
  for l in com.shy.tinue $(grep -vx com.shy.tinue "$W/loaded" 2>/dev/null || true); do
    launchctl enable "$G/$l" || true
    i=0; until loaded "$l" || [ $i -ge 5 ]; do i=$((i+1)); launchctl bootstrap "$G" "$LA/$l.plist" || sleep 1; done # (right after a bootout it can fail with an I/O error)
    loaded "$l" || echo "crux: WARNING $l did not load" >&2
  done
  i=0; until stats >/dev/null; do i=$((i+1)); [ $i -lt 60 ] || die "node did not answer"; sleep 0.5; done
  rm -f "$W/loaded"
}
hop_up() { [ -s "$W/hop.pid" ] && ps -p "$(cat "$W/hop.pid")" -o command= 2>/dev/null | grep -q 127.0.0.1:8643; }
hop_ok() { hop_up && curl -s -o /dev/null --max-time 5 http://127.0.0.1:8644/; } # any answer: the new host's Caddy
case "${1:-}" in
  state) echo "crux: moved=$([ -e "$D/MOVED" ] && cat "$D/MOVED" || echo no) node=$(listening && echo up || echo down) commit=$(sed -n 's/.*"sha":"\([0-9a-f]*\)","short":"[^"]*","dirty":\([a-z]*\).*/\1 dirty=\2/p' "$T/deploy/revision.json" 2>/dev/null)" ;;
  stats) stats ;;
  check)
    [ ! -e "$D/MOVED" ] || die "already fenced"; stats >/dev/null || die "node does not answer"
    ! pgrep -f "$WRITERS" >/dev/null || die "something else is writing the database: $(pgrep -fl "$WRITERS" | head -3)"
    [ "$(df -Pk "$D" | awk 'NR==2 {print $4}')" -gt 1000000 ] || die "less than 1 GB free"; echo "crux: ready" ;;
  preseed) stats > "$W/out/stats.json"; db backup "$D/tinue.db" "$W/out/tinue.db"; db manifest "$W/out/tinue.db" > "$W/out/manifest.json"; send "$W/out/tinue.db" "$W/out/manifest.json" "$W/out/stats.json"; echo "crux: preseeded" ;;
  fence)
    if [ -s "$D/MOVED" ] && [ -e "$D/$(cat "$D/MOVED")" ]; then
      [ ! -e "$D/tinue.db" ] || die "fenced already, but something made a tinue.db here since; look at both before going on"
      echo "crux: fenced already"; exit 0
    fi
    ! pgrep -f "$WRITERS" >/dev/null || die "something else is writing the database"
    if [ ! -e "$D/MOVED" ]; then 
      if stats > "$W/out/stats.json.new"; then mv "$W/out/stats.json.new" "$W/out/stats.json"
      else [ -s "$W/loaded" ] && [ -s "$W/out/stats.json" ] || die "node does not answer; nothing stopped"; fi # (or an interrupted fence stopped it already, with its answer saved)
      rm -f "$W/out/manifest.json"
    fi
    [ -e "$W/loaded" ] || { for l in $LABELS; do ! loaded "$l" || echo "$l"; done > "$W/loaded.new"; mv "$W/loaded.new" "$W/loaded"; }
    for l in $LABELS; do
      if grep -qx "$l" "$W/loaded"; then
        ! loaded "$l" || launchctl bootout "$G/$l" || true
        i=0; while loaded "$l"; do i=$((i+1)); [ $i -lt 100 ] || die "$l did not stop"; sleep 0.2; done
        launchctl disable "$G/$l"
      fi
      [ ! -f "$LA/$l.plist" ] || mv "$LA/$l.plist" "$W/plists/"
    done
    i=0; while listening || in_use; do i=$((i+1)); [ $i -lt 75 ] || die "something still listens on $PORT or has the database open"; sleep 0.2; done
    N="tinue.db.moved-$(date -u +%Y%m%dT%H%M%SZ)"; [ ! -s "$D/MOVED" ] || N=$(cat "$D/MOVED")
    echo "$N" > "$D/MOVED" # from here no server or import starts on this host (server/server.js)
    db checkpoint "$D/tinue.db"
    rm -f "$W/out/new.db"; cp -c "$D/tinue.db" "$W/out/new.db" 2>/dev/null || cp "$D/tinue.db" "$W/out/new.db"
    db manifest "$W/out/new.db" > "$W/out/manifest.json.new"; whole "$(cat "$W/out/manifest.json.new")" || die "the database is not whole (or not tinue's); nothing sent"
    mv "$W/out/new.db" "$W/out/tinue.db"; mv "$W/out/manifest.json.new" "$W/out/manifest.json"
    [ "$(cat "$D/MOVED" 2>/dev/null)" = "$N" ] && ! listening && ! in_use && [ ! -e "$D/$N" ] || die "something changed here meanwhile; look before going on"
    mv "$D/tinue.db" "$D/$N"; chmod 400 "$D/$N"; echo "crux: fenced ($N)" ;;
  send) [ -e "$D/MOVED" ] && [ ! -e "$D/tinue.db" ] && [ -s "$W/out/manifest.json" ] || die "fence first"; send "$W/out/tinue.db" "$W/out/manifest.json" "$W/out/stats.json"; echo "crux: sent $(sed -n "$SHA" "$W/out/manifest.json")" ;;
  unfence)
    if [ -e "$D/MOVED" ]; then
      N=$(cat "$D/MOVED")
      [ ! -e "$D/tinue.db" ] || [ ! -e "$D/$N" ] || die "two databases here, tinue.db and $N (the one fence put away); look before going on"
      if [ ! -e "$D/tinue.db" ]; then [ -f "$D/$N" ] || die "no $N"; chmod 600 "$D/$N"; mv "$D/$N" "$D/tinue.db"; fi
      rm "$D/MOVED"
    fi
    start; echo "crux: unfenced, serving" ;;
  take-back)
    dest; if [ ! -e "$D/MOVED" ]; then stats >/dev/null && { echo "crux: serving already"; exit 0; }; start; echo "crux: serving"; exit 0; fi
    ! listening || die "something listens on $PORT"
    if [ -e "$D/tinue.db" ] && [ ! -e "$D/tinue.db-wal" ] && [ "$(shasum -a 256 < "$D/tinue.db" | cut -d' ' -f1)" = "${2:-none}" ]; then rm "$D/MOVED"; start; echo "crux: took the database back, serving"; exit 0; fi # (stopped just before its end)
    mkdir -p "$W/back"; [ -f "$W/back/tinue.db" ] || cp -c "$W/pull/latest.db" "$W/back/tinue.db" 2>/dev/null || true # a base for the difference
    i=0; until "$RSYNC" -azI --partial --timeout=30 -e "ssh $SSHO" "$DEST:/var/lib/tinue-out/tinue.db" "$DEST:/var/lib/tinue-out/manifest.json" "$W/back/"; do i=$((i+1)); [ $i -lt 4 ] || die "could not fetch"; sleep 1; done
    [ "$(sed -n "$SHA" "$W/back/manifest.json")" = "sha=${2:-none}" ] || die "that is not the copy the new host was fenced with"
    db verify "$W/back/tinue.db" "$W/back/manifest.json"; rm -f "$W/back/tinue.db-wal" "$W/back/tinue.db-shm"
    [ ! -e "$D/tinue.db" ] && [ ! -e "$D/tinue.db-wal" ] || die "there is a tinue.db here that fence did not put away; look before going on"
    cp "$W/back/tinue.db" "$D/tinue.db.back"; chmod 600 "$D/tinue.db.back"; mv "$D/tinue.db.back" "$D/tinue.db"; rm "$D/MOVED" "$W/back/manifest.json"
    start; echo "crux: took the database back, serving" ;;
  hop)
    P="$W/hop.pid"
    case "${2:-}" in
      start) dest; if ! hop_up; then
        nohup sh -c 'while :; do ssh -N '"$SSHO"' -o ExitOnForwardFailure=yes -R 127.0.0.1:8643:127.0.0.1:'"$PORT"' -L 127.0.0.1:8644:127.0.0.1:80 '"$DEST"'; sleep 1; done' > "$W/hop.log" 2>&1 < /dev/null &
        echo $! > "$P"; fi
        i=0; until hop_ok; do i=$((i+1)); [ $i -lt ${HOP_TRIES:-20} ] || { echo "hop: does NOT answer ($(tail -1 "$W/hop.log"))"; exit 1; }; sleep 1; done; echo "hop: up" ;;
      stop) if hop_up; then H=$(cat "$P"); C=$(pgrep -P "$H" || true); kill "$H"; [ -z "$C" ] || kill $C 2>/dev/null || true; fi; rm -f "$P"; echo "hop: stopped" ;;
      *) if hop_ok; then echo "hop: up"; else echo "hop: down"; exit 1; fi ;;
    esac ;;
  pull)
    dest; mkdir -p "$W/pull"
    bad() { if [ ! -e "$W/pull/bad" ] && [ -n "${ALERT:-}" ]; then $ALERT "tinue backups: $1" || true; fi; echo "$1" > "$W/pull/bad"; die "$1"; }
    "$RSYNC" -azI --partial --timeout=60 -e "ssh $SSHO" "$DEST:/var/lib/tinue-backup/latest.db" "$DEST:/var/lib/tinue-backup/health" "$W/pull/" || bad "could not fetch the backup"
    [ -n "$(find "$W/pull/latest.db" -mmin -30)" ] || bad "the newest backup is over 30 minutes old"
    X=$(mktemp -d); trap 'rm -rf "$X"' EXIT; cp -c "$W/pull/latest.db" "$X/t.db" 2>/dev/null || cp "$W/pull/latest.db" "$X/t.db"
    M=$(db manifest "$X/t.db") && whole "$M" || bad "the pulled backup is not whole"
    cp -c "$W/pull/latest.db" "$W/pull/good.db.part" 2>/dev/null || cp "$W/pull/latest.db" "$W/pull/good.db.part"; mv "$W/pull/good.db.part" "$W/pull/good.db" # the newest whole one
    [ -f "$W/pull/day-$(date +%u).db" ] && [ "$(date -r "$W/pull/day-$(date +%u).db" +%F 2>/dev/null)" = "$(date +%F)" ] || { cp -c "$W/pull/good.db" "$W/pull/day-$(date +%u).db" 2>/dev/null || cp "$W/pull/good.db" "$W/pull/day-$(date +%u).db"; }
    [ "$(cat "$W/pull/health")" = ok ] || bad "$(cat "$W/pull/health")" # (the host's own word, ops/backup.mjs)
    rm -f "$W/pull/bad"; echo "pull: $(date -u +%FT%TZ) ok" ;;
  pull-install)
    dest; L=com.shy.tinue-pull
    { printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>%s</string>\n<key>ProgramArguments</key><array><string>/bin/sh</string><string>%s/crux.sh</string><string>pull</string></array>\n' "$L" "$HERE"
      printf '<key>EnvironmentVariables</key><dict><key>DEST</key><string>%s</string><key>KEY</key><string>%s</string><key>CRUX_NODE</key><string>%s</string><key>CRUX_RSYNC</key><string>%s</string><key>ALERT</key><string>%s</string></dict>\n<key>StartCalendarInterval</key><array>' "$DEST" "$KEY" "$NODE" "$RSYNC" "${ALERT:-}"
      for m in 4 14 24 34 44 54; do printf '<dict><key>Minute</key><integer>%s</integer></dict>' $m; done
      printf '</array>\n<key>StandardOutPath</key><string>%s/pull.log</string><key>StandardErrorPath</key><string>%s/pull.log</string>\n</dict></plist>\n' "$W" "$W"; } > "$LA/$L.plist"
    launchctl bootout "$G/$L" 2>/dev/null || true; launchctl bootstrap "$G" "$LA/$L.plist"; echo "pull: every 10 minutes" ;;
  recover)
    [ "${2:-}" = --ovh-is-off ] || die "first make sure the new host cannot serve again (off, or in rescue with its WRITER file removed), then: recover --ovh-is-off"
    F="${3:-$W/pull/good.db}"; [ -s "$F" ] || die "no $F"; [ -e "$D/MOVED" ] || die "this host is not fenced"
    for x in "" -wal -shm; do [ ! -e "$D/tinue.db$x" ] || die "there is a tinue.db$x here; look before going on"; done
    launchctl bootout "$G/com.shy.tinue-pull" 2>/dev/null || true # (it would go on replacing good.db)
    rm -f "$D/tinue.db.back"; cp "$F" "$D/tinue.db.back"; chmod 600 "$D/tinue.db.back"; M=$(db manifest "$D/tinue.db.back"); whole "$M" || die "$F is not whole"
    rm -f "$D/tinue.db.back-wal" "$D/tinue.db.back-shm"; echo "crux: its newest attempt is of $("$NODE" -p 'new Date(JSON.parse(process.argv[1]).lastAttempt).toISOString()' "$M")"
    mv "$D/tinue.db.back" "$D/tinue.db"; rm "$D/MOVED"; start; echo "crux: recovered, serving" ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
