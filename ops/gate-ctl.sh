#!/bin/sh
# Drive the gate (ops/gate.mjs), as root on its host.   usage: gate-ctl.sh hold | pass PORT | status
# hold returns once nothing sent before it is still under way; pass once the gate has taken the new mode.
set -e
MODE="${GATE_MODE:-/var/lib/tinue-gate/mode}"; STATUS="${GATE_STATUS:-/run/tinue-gate/status}"; WAIT="${GATE_WAIT:-15}"
field() { sed -n 's/.*"'"$1"'":"\{0,1\}\([^",}]*\).*/\1/p' "$STATUS"; }
set_mode() {
  PID=$(field pid); kill -0 "$PID" 2>/dev/null || { echo "gate: not running" >&2; exit 1; }
  printf '%s\n' "$1" > "$MODE.tmp"; chmod 644 "$MODE.tmp"; mv "$MODE.tmp" "$MODE"; kill -USR2 "$PID"
}
wait_for() { # wait_for TEST MESSAGE: poll ten times a second
  i=0; until eval "$1"; do i=$((i+1)); [ $i -le $((WAIT * 10)) ] || { echo "gate: $2 after $WAIT s: $(cat "$STATUS")" >&2; exit 1; }; sleep 0.1; done
}
case "$1" in
  hold) set_mode hold; wait_for '[ "$(field mode)" = hold ] && [ "$(field inflight)" = 0 ]' "not drained" ;;
  pass) case "$2" in ''|*[!0-9]*) echo "gate: pass needs a port" >&2; exit 2 ;; esac
    set_mode "pass $2"; wait_for '[ "$(field mode)" = pass ] && [ "$(field port)" = "'"$2"'" ]' "did not pass" ;;
  status) ;;
  *) echo "usage: gate-ctl.sh hold | pass PORT | status" >&2; exit 2 ;;
esac
cat "$STATUS"
