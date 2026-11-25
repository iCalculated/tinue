#!/bin/sh
# crux's side of the move, as its user on crux. move.sh copies ops/ there and calls it; each command can be run again.
#   state | stats         what this host is doing; its /api/stats
#   check                 exit 1 unless it can be moved now (node up, nothing else writing the database)
#   preseed               copy the live database and send it, so the real copy is only the difference
#   fence                 stop everything that writes the database, for good; leave the final copy in the outbox
#   send                  send the outbox to the new host
#   unfence               (abort) undo fence
#   take-back SHA         (rollback) fetch the new host's fenced database, check it, make it the database, start
#   hop start|stop|status the ssh forwards: new host's 8643 -> node here, 8644 here -> the new host's port 80
#   pull                  fetch the newest backup; pull-install: every 10 minutes, by launchd
#   DEST=mover@host KEY=~/.ssh/key   the new host (send, preseed, take-back, hop, pull)
set -eu
T="${TINUE_HOME:-$HOME/Projects/tinue}" W="${MOVE_HOME:-$HOME/Projects/tinue-move}" LA="$HOME/Library/LaunchAgents"
NODE="${CRUX_NODE:-/opt/homebrew/bin/node}" RSYNC="${CRUX_RSYNC:-rsync}" DEST="${DEST:-}" KEY="${KEY:-}" PORT="${PORT:-8642}"
HERE=$(cd "$(dirname "$0")" && pwd); D="$T/data"; G="gui/$(id -u)"
LABELS="com.shy.tinue com.shy.tinue-players com.shy.tinue-guestwatch"
SHA='s/.*"sha":"\([0-9a-f]\{64\}\)".*/sha=\1/p'
WRITERS='scripts/(import|refund|refund-legacy-wins|rejudge|puzzle-state|book-init|apply-flat-threat|replay-ratings)[.]mjs'
mkdir -p "$W/out" "$W/plists"
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
start() { # put the jobs back and wait for health
  for l in $LABELS; do
    [ ! -f "$W/plists/$l.plist" ] || { mv "$W/plists/$l.plist" "$LA/"; launchctl enable "$G/$l"; loaded "$l" || launchctl bootstrap "$G" "$LA/$l.plist"; }
  done
  i=0; until stats >/dev/null; do i=$((i+1)); [ $i -lt 60 ] || die "node did not answer"; sleep 0.5; done
}
case "${1:-}" in
  state) echo "crux: moved=$([ -e "$D/MOVED" ] && cat "$D/MOVED" || echo no) node=$(listening && echo up || echo down) commit=$(sed -n 's/.*"sha":"\([0-9a-f]*\)","short":"[^"]*","dirty":\([a-z]*\).*/\1 dirty=\2/p' "$T/deploy/revision.json" 2>/dev/null)" ;;
  stats) stats ;;
  check)
    [ ! -e "$D/MOVED" ] || die "already fenced"; stats >/dev/null || die "node does not answer"
    ! pgrep -f "$WRITERS" >/dev/null || die "something else is writing the database: $(pgrep -fl "$WRITERS" | head -3)"
    [ "$(df -Pk "$D" | awk 'NR==2 {print $4}')" -gt 1000000 ] || die "less than 1 GB free"; echo "crux: ready" ;;
  preseed) stats > "$W/out/stats.json"; db backup "$D/tinue.db" "$W/out/tinue.db"; db manifest "$W/out/tinue.db" > "$W/out/manifest.json"; send "$W/out/tinue.db" "$W/out/manifest.json" "$W/out/stats.json"; echo "crux: preseeded" ;;
  fence)
    if [ -e "$D/MOVED" ] && [ ! -e "$D/tinue.db" ]; then echo "crux: fenced already"; exit 0; fi
    ! pgrep -f "$WRITERS" >/dev/null || die "something else is writing the database"
    if [ ! -e "$D/MOVED" ]; then 
      if stats > "$W/out/stats.json.new"; then mv "$W/out/stats.json.new" "$W/out/stats.json"
      else [ -f "$W/plists/com.shy.tinue.plist" ] && [ -s "$W/out/stats.json" ] || die "node does not answer; nothing stopped"; fi # (or an interrupted fence stopped it already, with its answer saved)
      rm -f "$W/out/manifest.json"
    fi
    for l in $LABELS; do
      ! loaded "$l" || launchctl bootout "$G/$l" || true
      i=0; while loaded "$l"; do i=$((i+1)); [ $i -lt 100 ] || die "$l did not stop"; sleep 0.2; done
      launchctl disable "$G/$l"; [ ! -f "$LA/$l.plist" ] || mv "$LA/$l.plist" "$W/plists/"
    done
    i=0; while listening || in_use; do i=$((i+1)); [ $i -lt 75 ] || die "something still listens on $PORT or has the database open"; sleep 0.2; done
    N="tinue.db.moved-$(date -u +%Y%m%dT%H%M%SZ)"; [ ! -s "$D/MOVED" ] || N=$(cat "$D/MOVED")
    echo "$N" > "$D/MOVED" # from here no server or import starts on this host (server/server.js)
    db checkpoint "$D/tinue.db"
    rm -f "$W/out/tinue.db"; cp -c "$D/tinue.db" "$W/out/tinue.db" 2>/dev/null || cp "$D/tinue.db" "$W/out/tinue.db"
    db manifest "$W/out/tinue.db" > "$W/out/manifest.json.new"; mv "$W/out/manifest.json.new" "$W/out/manifest.json"
    mv "$D/tinue.db" "$D/$N"; chmod 400 "$D/$N"; echo "crux: fenced ($N)" ;;
  send) [ -e "$D/MOVED" ] && [ ! -e "$D/tinue.db" ] && [ -s "$W/out/manifest.json" ] || die "fence first"; send "$W/out/tinue.db" "$W/out/manifest.json" "$W/out/stats.json"; echo "crux: sent $(sed -n "$SHA" "$W/out/manifest.json")" ;;
  unfence)
    if [ -e "$D/MOVED" ]; then
      N=$(cat "$D/MOVED")
      if [ ! -e "$D/tinue.db" ]; then [ -f "$D/$N" ] || die "no $N"; chmod 600 "$D/$N"; mv "$D/$N" "$D/tinue.db"; fi
      rm "$D/MOVED"
    fi
    start; echo "crux: unfenced, serving" ;;
  take-back)
    dest; if [ ! -e "$D/MOVED" ]; then stats >/dev/null && { echo "crux: serving already"; exit 0; }; start; echo "crux: serving"; exit 0; fi
    ! listening || die "something listens on $PORT"
    mkdir -p "$W/back"; [ -f "$W/back/tinue.db" ] || cp -c "$W/pull/latest.db" "$W/back/tinue.db" 2>/dev/null || true # a base for the difference
    i=0; until "$RSYNC" -azI --partial --timeout=30 -e "ssh $SSHO" "$DEST:/var/lib/tinue-out/tinue.db" "$DEST:/var/lib/tinue-out/manifest.json" "$W/back/"; do i=$((i+1)); [ $i -lt 4 ] || die "could not fetch"; sleep 1; done
    [ "$(sed -n "$SHA" "$W/back/manifest.json")" = "sha=${2:-none}" ] || die "that is not the copy the new host was fenced with"
    db verify "$W/back/tinue.db" "$W/back/manifest.json"; rm -f "$W/back/tinue.db-wal" "$W/back/tinue.db-shm"
    [ ! -e "$D/tinue.db" ] && [ ! -e "$D/tinue.db-wal" ] || die "there is a tinue.db here that fence did not put away; look before going on"
    cp "$W/back/tinue.db" "$D/tinue.db.back"; chmod 600 "$D/tinue.db.back"; mv "$D/tinue.db.back" "$D/tinue.db"; rm "$D/MOVED" "$W/back/manifest.json"
    start; echo "crux: took the database back, serving" ;;
  hop)
    P="$W/hop.pid"; up() { [ -s "$P" ] && kill -0 "$(cat "$P")" 2>/dev/null; }
    case "${2:-}" in
      start) dest; if up; then echo "hop: up already"; else
        nohup sh -c 'while :; do ssh -N '"$SSHO"' -o ExitOnForwardFailure=yes -R 127.0.0.1:8643:127.0.0.1:'"$PORT"' -L 127.0.0.1:8644:127.0.0.1:80 '"$DEST"'; sleep 1; done' > "$W/hop.log" 2>&1 < /dev/null &
        echo $! > "$P"; echo "hop: started"; fi ;;
      stop) if up; then H=$(cat "$P"); C=$(pgrep -P "$H" || true); kill "$H"; [ -z "$C" ] || kill $C 2>/dev/null || true; fi; rm -f "$P"; echo "hop: stopped" ;;
      *) up && echo "hop: up" || { echo "hop: down"; exit 1; } ;;
    esac ;;
  pull)
    dest; mkdir -p "$W/pull"; "$RSYNC" -azI --partial --timeout=60 -e "ssh $SSHO" "$DEST:/var/lib/tinue-backup/latest.db" "$W/pull/latest.db"
    X=$(mktemp -d); cp -c "$W/pull/latest.db" "$X/t.db" 2>/dev/null || cp "$W/pull/latest.db" "$X/t.db"
    M=$(db manifest "$X/t.db"); rm -rf "$X"
    case "$M" in *'"integrity":"ok"'*'"missing":[]'*) ;; *) die "the pulled backup is not whole" ;; esac
    cp -c "$W/pull/latest.db" "$W/pull/good.db.part" 2>/dev/null || cp "$W/pull/latest.db" "$W/pull/good.db.part"; mv "$W/pull/good.db.part" "$W/pull/good.db" # the newest whole one
    [ -f "$W/pull/day-$(date +%u).db" ] && [ "$(date -r "$W/pull/day-$(date +%u).db" +%F 2>/dev/null)" = "$(date +%F)" ] || { cp -c "$W/pull/good.db" "$W/pull/day-$(date +%u).db" 2>/dev/null || cp "$W/pull/good.db" "$W/pull/day-$(date +%u).db"; }
    echo "pull: $(date -u +%FT%TZ) ok" ;;
  pull-install)
    dest; L=com.shy.tinue-pull
    { printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>%s</string>\n<key>ProgramArguments</key><array><string>/bin/sh</string><string>%s/crux.sh</string><string>pull</string></array>\n' "$L" "$HERE"
      printf '<key>EnvironmentVariables</key><dict><key>DEST</key><string>%s</string><key>KEY</key><string>%s</string><key>CRUX_NODE</key><string>%s</string><key>CRUX_RSYNC</key><string>%s</string></dict>\n<key>StartCalendarInterval</key><array>' "$DEST" "$KEY" "$NODE" "$RSYNC"
      for m in 4 14 24 34 44 54; do printf '<dict><key>Minute</key><integer>%s</integer></dict>' $m; done
      printf '</array>\n<key>StandardOutPath</key><string>%s/pull.log</string><key>StandardErrorPath</key><string>%s/pull.log</string>\n</dict></plist>\n' "$W" "$W"; } > "$LA/$L.plist"
    launchctl bootout "$G/$L" 2>/dev/null || true; launchctl bootstrap "$G" "$LA/$L.plist"; echo "pull: every 10 minutes" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
