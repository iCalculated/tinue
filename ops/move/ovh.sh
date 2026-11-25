#!/bin/sh
# The API host's side of the move, as root on that host. move.sh calls it; each command can be run again.
#   state            what this host is doing, one line
#   check            exit 1 unless it is ready to receive the database
#   hold | pass PORT the gate (gate-ctl.sh)
#   rehearse         check the copy in the inbox and serve it on a spare port, as a throwaway
#   install SHA      check the copy in the inbox against its manifest and make it the database
#   start            WRITER, start node, wait for health, compare its /api/stats with crux's
#   stop             (abort) stop node and take WRITER away
#   fence            (rollback) the same, then mark this host MOVED and put the database in the outbox for crux
#   tail             start the players page and make a first backup, checked
set -eu
D="${TINUE_STATE:-/var/lib/tinue}" IN="${TINUE_IN:-/var/lib/tinue-in}" OUT="${TINUE_OUT:-/var/lib/tinue-out}" CODE="${TINUE_CODE:-/srv/tinue}"
NODE="${NODE:-/usr/local/bin/node}" PORT="${PORT:-8642}" RPORT="${REHEARSE_PORT:-8652}"
HERE=$(cd "$(dirname "$0")" && pwd)
export GATE_STATUS="${GATE_STATUS:-/run/tinue-gate/status}"
die() { echo "ovh: $*" >&2; exit 1; }
as() { u=$1; shift; if [ -n "${NO_SETUID:-}" ]; then "$@"; else runuser -u "$u" -- "$@"; fi; } # NO_SETUID: the tests
db() { as tinue "$NODE" --no-warnings "$HERE/db.mjs" "$@"; }
active() { systemctl is-active --quiet "$1"; }
listening() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/stats"; }
health() { # health PORT: its stats, or exit 1
  i=0; while [ $i -lt ${HEALTH_TRIES:-100} ]; do i=$((i+1)); curl -sf --max-time 2 "http://127.0.0.1:$1/api/stats" && return 0; sleep 0.2; done
  echo "ovh: node did not answer on $1 in 20 s" >&2; return 1
}
receive() { # receive FILE: the inbox copy as tinue's own file. Read as mover, so a link planted there opens nothing.
  rm -f "$1" "$1-wal" "$1-shm"
  as mover cat "$IN/tinue.db" | as tinue sh -c 'umask 077; cat > "$1"' - "$1"
  as mover cat "$IN/manifest.json" | as tinue sh -c 'umask 077; cat > "$1"' - "$1.manifest"
  db verify "$1" "$1.manifest"; rm -f "$1-wal" "$1-shm"
}
stopped() { ! active tinue.service && ! listening || die "a node is still running here"; }
case "${1:-}" in
  state) echo "ovh: writer=$([ -e "$D/WRITER" ] && echo yes || echo no) moved=$([ -e "$D/MOVED" ] && echo yes || echo no) node=$(active tinue.service && echo up || echo down) commit=$(sed -n 's/.*"sha":"\([0-9a-f]*\)","short":"[^"]*","dirty":\([a-z]*\).*/\1 dirty=\2/p' "$CODE/deploy/revision.json" 2>/dev/null) gate=$(cat "$GATE_STATUS" 2>/dev/null || echo none)" ;;
  check)
    [ ! -e "$D/WRITER" ] || die "WRITER is here already"; stopped
    "$NODE" -v >/dev/null; [ -s "$CODE/server/server.js" ] || die "no code in $CODE"
    grep -q '"mode":"pass"' "$GATE_STATUS" && kill -0 "$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$GATE_STATUS")" || die "the gate is not passing requests on"
    [ "$(df -Pk "$D" | awk 'NR==2 {print $4}')" -gt 10000000 ] || die "less than 10 GB free"
    [ "$(TZ=America/Los_Angeles date +%Y-%m-%d)" = "$("$NODE" -p "new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format()")" ] || die "node has the wrong Pacific date"
    echo "ovh: ready" ;;
  hold) sh "$HERE/../gate-ctl.sh" hold ;;
  pass) sh "$HERE/../gate-ctl.sh" pass "$2" ;;
  rehearse)
    stopped; R="$D/rehearsal"; as tinue mkdir -p "$R"; receive "$R/tinue.db"
    # the same environment as the real one, another port and another database
    (set -a; [ ! -f /etc/tinue/tinue.env ] || . /etc/tinue/tinue.env; set +a; cd "$CODE"
      exec env PORT="$RPORT" TINUE_DB="$R/tinue.db" TINUE_ACCESS_LOG="$R/access.log" $([ -n "${NO_SETUID:-}" ] || echo setpriv --reuid=tinue --regid=tinue --clear-groups) "$NODE" --no-warnings server/server.js) & P=$!
    OK=0; health "$RPORT" > "$IN.stats" || OK=1
    kill "$P" 2>/dev/null || true; wait "$P" || true
    [ $OK = 0 ] && { as mover cat "$IN/stats.json" > "$IN.want"; "$NODE" --no-warnings "$HERE/db.mjs" stats-eq "$IN.want" "$IN.stats" || echo "ovh: (a live copy: the counts may differ by what was played since)"; }
    rm -rf "$R" "$IN.stats" "$IN.want"; [ $OK = 0 ] || exit 1; echo "ovh: rehearsed" ;;
  install)
    stopped; [ ! -e "$D/WRITER" ] || die "WRITER is here: this host may have taken requests since; not replacing its database"
    as mover cat "$IN/manifest.json" | grep -q "\"sha\":\"${2:-none}\"" || die "the inbox is not the copy crux was fenced with"
    receive "$D/tinue.db.new"
    TS=$(date -u +%Y%m%dT%H%M%SZ)
    for x in "" -wal -shm; do [ ! -e "$D/tinue.db$x" ] || mv "$D/tinue.db$x" "$D/old-$TS.db$x"; done # with its WAL: an old one beside the new file would corrupt it
    mv "$D/tinue.db.new" "$D/tinue.db"; rm -f "$D/tinue.db.new.manifest"; sync
    echo "ovh: installed" ;;
  start)
    [ -s "$D/tinue.db" ] || die "no database"
    rm -f "$D/MOVED"; : > "$D/WRITER"; systemctl start tinue.service
    health "$PORT" > "$IN.stats" || { rm -f "$IN.stats"; exit 1; }
    as mover cat "$IN/stats.json" > "$IN.want"
    RC=0; "$NODE" --no-warnings "$HERE/db.mjs" stats-eq "$IN.want" "$IN.stats" || RC=1
    rm -f "$IN.stats" "$IN.want"; [ $RC = 0 ] || die "its /api/stats differs from crux's"
    active tinue.service || die "tinue.service is not active"; echo "ovh: node is up" ;;
  stop) systemctl stop tinue-players.service tinue.service; stopped; rm -f "$D/WRITER"; echo "ovh: stopped, WRITER gone" ;;
  fence)
    if [ ! -e "$D/MOVED" ]; then
      systemctl stop tinue-backup.service tinue-players.service tinue.service; stopped
      rm -f "$D/WRITER"; : > "$D/MOVED"
    fi
    db checkpoint "$D/tinue.db"
    db manifest "$D/tinue.db" > "$OUT/manifest.json"
    cp "$D/tinue.db" "$OUT/tinue.db.part"; chmod 640 "$OUT/tinue.db.part"; mv "$OUT/tinue.db.part" "$OUT/tinue.db"; [ -n "${NO_SETUID:-}" ] || chgrp mover "$OUT/tinue.db" "$OUT/manifest.json"
    chmod 640 "$OUT/manifest.json"; echo "ovh: fenced $(sed -n 's/.*"sha":"\([0-9a-f]\{64\}\)".*/sha=\1/p' "$OUT/manifest.json")" ;;
  tail) systemctl start tinue-players.service; systemctl start tinue-backup.service; as tinue "$NODE" --no-warnings "$HERE/../backup.mjs" --verify ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
