#!/bin/sh
# The API host's side of the move, as root on that host. move.sh calls it; each command can be run again.
#   state            what this host is doing, one line
#   check            exit 1 unless it is ready to receive the database
#   hold | pass PORT the gate (gate-ctl.sh). pass first asks that port, and goes on holding if nothing answers there
#   returned         (rollback, last) crux has the database back: this host may receive it again
#   rehearse         check the copy in the inbox and serve it on a spare port, as a throwaway
#   install SHA      check the copy in the inbox against its manifest and make it the database
#   start            WRITER, start node, wait for health, compare its /api/stats with crux's
#   stop             (abort) stop node and take WRITER away
#   fence            (rollback) the same, then mark this host MOVED and put the database in the outbox for crux
#   tail             start the players page and make a first backup, checked
#   restore FILE     put a backup in place of the live database (node stops meanwhile; what it replaces is kept)
# Two marker files in /etc/tinue, which is root's: WRITER, node may run here; SERVED, requests have reached node here, so
# its database is the newest there is: install and stop then refuse, until a rollback has taken that database back.
set -eu
D="${TINUE_STATE:-/var/lib/tinue}" IN="${TINUE_IN:-/var/lib/tinue-in}" OUT="${TINUE_OUT:-/var/lib/tinue-out}" CODE="${TINUE_CODE:-/srv/tinue}"
NODE="${NODE:-/usr/local/bin/node}" PORT="${PORT:-8642}" RPORT="${REHEARSE_PORT:-8652}"
G="${TINUE_GUARD:-/etc/tinue}"
HERE=$(cd "$(dirname "$0")" && pwd)
# One step at a time: an ssh that dropped leaves its step running. (The kernel lets go of the lock however the step ends.)
locked() { if command -v flock >/dev/null; then flock -n -E 75 "$@"; else lockf -s -k -t 0 "$@"; fi; }
case "${1:-}" in hold|pass|rehearse|install|start|stop|fence|returned|tail|restore) if [ -z "${MOVE_LOCKED:-}" ]; then
  RC=0; MOVE_LOCKED=1 locked "${TINUE_LOCK:-/run/tinue-move.lock}" /bin/sh "$HERE/ovh.sh" "$@" || RC=$?
  [ $RC != 75 ] || echo "ovh: another step is still running here; wait for it and look again" >&2; exit $RC
fi ;; esac
export GATE_STATUS="${GATE_STATUS:-/run/tinue-gate/status}"
die() { echo "ovh: $*" >&2; exit 1; }
as() { u=$1; shift; if [ -n "${NO_SETUID:-}" ]; then "$@"; else runuser -u "$u" -- "$@"; fi; } # NO_SETUID: the tests
db() { as tinue "$NODE" --no-warnings "$HERE/db.mjs" "$@"; }
active() { systemctl is-active --quiet "$1"; }
listening() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/stats"; }
health() { # health PORT: its stats, or exit 1
  E=$(( $(date +%s) + ${HEALTH_S:-20} )); while [ "$(date +%s)" -lt $E ]; do curl -sf --max-time 5 "http://127.0.0.1:$1/api/stats" && return 0; sleep 0.2; done
  echo "ovh: node did not answer on $1 in ${HEALTH_S:-20} s" >&2; return 1
}
receive() { # receive FILE: the inbox copy as tinue's own file. Read as mover, so a link planted there opens nothing.
  rm -f "$1" "$1-wal" "$1-shm"
  as mover cat "$IN/tinue.db" | as tinue sh -c 'umask 077; cat > "$1"' - "$1"
  as mover cat "$IN/manifest.json" | as tinue sh -c 'umask 077; cat > "$1"' - "$1.manifest"
  db verify "$1" "$1.manifest"; rm -f "$1-wal" "$1-shm"
}
stopped() { ! active tinue.service && ! listening || die "a node is still running here"; }
case "${1:-}" in
  state) echo "ovh: writer=$([ -e "$G/WRITER" ] && echo yes || echo no) moved=$([ -e "$D/MOVED" ] && echo yes || echo no) served=$([ -e "$G/SERVED" ] && echo yes || echo no) node=$(active tinue.service && echo up || echo down) commit=$(sed -n 's/.*"sha":"\([0-9a-f]*\)","short":"[^"]*","dirty":\([a-z]*\).*/\1 dirty=\2/p' "$CODE/deploy/revision.json" 2>/dev/null) gate=$(cat "$GATE_STATUS" 2>/dev/null || echo none)" ;;
  check)
    [ ! -e "$G/WRITER" ] && [ ! -e "$G/SERVED" ] || die "WRITER or SERVED is here already"; stopped
    "$NODE" -v >/dev/null; [ -s "$CODE/server/server.js" ] || die "no code in $CODE"
    grep -q '"mode":"pass"' "$GATE_STATUS" && kill -0 "$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$GATE_STATUS")" || die "the gate is not passing requests on"
    [ "$(df -Pk "$D" | awk 'NR==2 {print $4}')" -gt 10000000 ] || die "less than 10 GB free"
    [ "$(TZ=America/Los_Angeles date +%Y-%m-%d)" = "$("$NODE" -p "new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format()")" ] || die "node has the wrong Pacific date"
    echo "ovh: ready" ;;
  hold) sh "$HERE/../gate-ctl.sh" hold ;;
  pass)
    health "$2" >/dev/null || die "not passing requests to $2; the gate stays as it was"
    [ "$2" != "$PORT" ] || { [ -e "$G/WRITER" ] || die "no WRITER here"; : > "$G/SERVED"; sync; }
    sh "$HERE/../gate-ctl.sh" pass "$2" ;;
  returned) [ ! -e "$G/WRITER" ] && [ -e "$D/MOVED" ] || die "this host is not fenced"; rm -f "$G/SERVED"; echo "ovh: crux has the newest database" ;;
  rehearse)
    stopped; R="$D/rehearsal"; as tinue mkdir -p "$R"; receive "$R/tinue.db"
    # the same environment as the real one, another port and another database
    (set -a; [ ! -f /etc/tinue/tinue.env ] || . /etc/tinue/tinue.env; set +a; cd "$CODE"
      exec env PORT="$RPORT" TINUE_DB="$R/tinue.db" TINUE_ACCESS_LOG="$R/access.log" $([ -n "${NO_SETUID:-}" ] || echo setpriv --reuid=tinue --regid=tinue --clear-groups) "$NODE" --no-warnings server/server.js) & P=$!
    OK=0; health "$RPORT" > "$IN.stats" || OK=1
    kill "$P" 2>/dev/null || true; wait "$P" || true
    [ $OK = 0 ] && { as mover cat "$IN/stats.json" > "$IN.want"; "$NODE" --no-warnings "$HERE/db.mjs" stats-eq "$IN.want" "$IN.stats" || echo "ovh: (a live copy: the counts may differ by what was played since)"; }
    as tinue rm -rf "$R"; rm -f "$IN.stats" "$IN.want"; [ $OK = 0 ] || exit 1; echo "ovh: rehearsed" ;;
  install)
    stopped; [ ! -e "$G/WRITER" ] && [ ! -e "$G/SERVED" ] || die "WRITER or SERVED is here: this host has taken requests; not replacing its database (finish the rollback)"
    as mover cat "$IN/manifest.json" | grep -q "\"sha\":\"${2:-none}\"" || die "the inbox is not the copy crux was fenced with"
    receive "$D/tinue.db.new"
    TS=$(date -u +%Y%m%dT%H%M%SZ)
    for x in "" -wal -shm; do [ ! -e "$D/tinue.db$x" ] || mv "$D/tinue.db$x" "$D/old-$TS.db$x"; done # with its WAL: an old one beside the new file would corrupt it
    mv "$D/tinue.db.new" "$D/tinue.db"; rm -f "$D/tinue.db.new.manifest"; sync
    echo "ovh: installed" ;;
  start)
    [ -s "$D/tinue.db" ] || die "no database"
    [ ! -e "$G/SERVED" ] || [ -e "$G/WRITER" ] || die "a rollback is under way: run rollback again"
    rm -f "$D/MOVED"; : > "$G/WRITER"; systemctl start tinue.service
    health "$PORT" > "$IN.stats" || { rm -f "$IN.stats"; exit 1; }
    if [ -e "$G/SERVED" ]; then rm -f "$IN.stats"; echo "ovh: node is up (it has served before: nothing to compare)"; exit 0; fi
    as mover cat "$IN/stats.json" > "$IN.want"
    RC=0; "$NODE" --no-warnings "$HERE/db.mjs" stats-eq "$IN.want" "$IN.stats" || RC=1
    rm -f "$IN.stats" "$IN.want"; [ $RC = 0 ] || die "its /api/stats differs from crux's"
    active tinue.service || die "tinue.service is not active"; echo "ovh: node is up" ;;
  stop) [ ! -e "$G/SERVED" ] || die "SERVED is here: this host's database is the newest; use rollback"
    systemctl stop tinue-players.service tinue.service; stopped; rm -f "$G/WRITER"; echo "ovh: stopped, WRITER gone" ;;
  fence)
    [ -e "$G/SERVED" ] || die "this host has served nothing since it last had the database: its copy may be an old one"
    if [ ! -e "$D/MOVED" ]; then
      systemctl stop tinue-backup.service tinue-players.service tinue.service; stopped
      rm -f "$G/WRITER"; as tinue touch "$D/MOVED"
    fi
    db checkpoint "$D/tinue.db"
    db manifest "$D/tinue.db" > "$OUT/manifest.json"
    as tinue cat "$D/tinue.db" > "$OUT/tinue.db.part"; chmod 640 "$OUT/tinue.db.part"; mv "$OUT/tinue.db.part" "$OUT/tinue.db"; [ -n "${NO_SETUID:-}" ] || chgrp mover "$OUT/tinue.db" "$OUT/manifest.json"
    chmod 640 "$OUT/manifest.json"; echo "ovh: fenced $(sed -n 's/.*"sha":"\([0-9a-f]\{64\}\)".*/sha=\1/p' "$OUT/manifest.json")" ;;
  tail) systemctl start tinue-players.service; systemctl start tinue-backup.service; as tinue "$NODE" --no-warnings "$HERE/../backup.mjs" --verify ;;
  restore)
    [ -e "$G/WRITER" ] && [ -s "${2:-}" ] || die "usage, on the host that serves: restore FILE"
    as tinue sh -c 'umask 077; cat > "$1"' - "$D/tinue.db.new" < "$2"
    case "$(db manifest "$D/tinue.db.new")" in *'"integrity":"ok"'*'"missing":[]'*) ;; *) die "$2 is not whole; nothing changed" ;; esac
    systemctl stop tinue-backup.timer tinue-backup.service tinue-players.service tinue.service; stopped
    TS=$(date -u +%Y%m%dT%H%M%SZ); for x in "" -wal -shm; do [ ! -e "$D/tinue.db$x" ] || mv "$D/tinue.db$x" "$D/old-$TS.db$x"; done
    rm -f "$D/tinue.db.new-wal" "$D/tinue.db.new-shm"; mv "$D/tinue.db.new" "$D/tinue.db"; sync
    systemctl start tinue.service; health "$PORT" >/dev/null; systemctl start tinue-players.service tinue-backup.timer; echo "ovh: restored; what it replaced is old-$TS.db" ;;
  *) sed -n '2,18p' "$0"; exit 2 ;;
esac
