#!/bin/sh
# Move the API from crux to the new host, and back. Run it from a checkout, on a machine that can ssh to both.
# usage: TINUE_HOST=ubuntu@host MOVE_DEST=mover@host MOVE_KEY='~/.ssh/key on crux' ops/move/move.sh COMMAND [--dry-run]
#   tools       copy ops/ to crux
#   hop start|stop|status
#   state | check
#   preseed     send a copy now, so the difference at the cutover is small
#   rehearse    preseed, then check and serve that copy on the new host as a throwaway; changes nothing. Do it twice.
#   go          the cutover: hold, stop crux, copy, check, start the new host, let requests through
#   abort       any time before go's last step: back to crux, nothing lost
#   rollback [--any-commit]   after go, with the new host healthy: the same in the other direction (every write comes
#               back). crux must have the new host's commit first (scripts/deploy-crux.sh --fenced)
# Every step prints its time. A failure stops where it is, with requests still held. Stopped in go: go again, or abort.
# Stopped in rollback: rollback again (go and abort refuse). The gate holds a request for 10 minutes; go refuses to finish
# after 5.
# The point of no return is go's "pass": until then no request has reached the new host's node.
set -eu
cd "$(dirname "$0")/../.."
DRY="${DRY_RUN:-}"; [ "$DRY" = 0 ] && DRY=
CMD="${1:-}"; [ $# = 0 ] || shift
A=; for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) A="$A $a" ;; esac; done
: "${TINUE_HOST:?set TINUE_HOST}" "${MOVE_DEST:?set MOVE_DEST (mover@host)}"
CRUX="${CRUX:-shy@crux}" MAXHOLD="${MAXHOLD:-300}"
SSH="${MOVE_SSH:-ssh -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o ControlMaster=auto -o ControlPersist=120 -o ControlPath=~/.ssh/tinue-%C}"
# one go, abort, rollback or rehearse at a time from this machine
case "$CMD" in go|abort|rollback|rehearse) if [ -z "$DRY${MOVE_SH_LOCKED:-}" ]; then
  L="${TMPDIR:-/tmp}/tinue-move.lock" RC=0; export MOVE_SH_LOCKED=1
  if command -v flock >/dev/null; then flock -n -E 75 "$L" sh ops/move/move.sh "$CMD" $A || RC=$?; else lockf -s -k -t 0 "$L" sh ops/move/move.sh "$CMD" $A || RC=$?; fi
  [ $RC != 75 ] || echo "move: another move.sh is still running" >&2; exit $RC
fi ;; esac
t() { echo "$(date +%H:%M:%S) $*"; }
on_ovh() { t "ovh $*"; [ -z "$DRY" ] || { echo "[dry-run] ssh $TINUE_HOST ovh.sh $*"; return 0; }; $SSH "$TINUE_HOST" "sudo -n sh /srv/tinue/ops/move/ovh.sh $*"; }
on_crux() { t "crux $*"; [ -z "$DRY" ] || { echo "[dry-run] ssh $CRUX crux.sh $*"; return 0; }; $SSH "$CRUX" "DEST='$MOVE_DEST' KEY=${MOVE_KEY:-} CRUX_NODE='${CRUX_NODE:-/opt/homebrew/bin/node}' CRUX_RSYNC='${CRUX_RSYNC:-rsync}' /bin/sh Projects/tinue-move/ops/move/crux.sh $*"; }
sha() { printf '%s\n' "$1" | sed -n 's/.*sha=\([0-9a-f]\{64\}\).*/\1/p'; } # the copy itself is named to the other side, so a stale one there cannot pass for it
tools() { t "ops/ to crux"; if [ -n "$DRY" ]; then echo "[dry-run] rsync ops to $CRUX"; else $SSH "$CRUX" 'mkdir -p Projects/tinue-move/ops'; rsync -az -e "$SSH" ops/ "$CRUX:Projects/tinue-move/ops/"; fi; }
# same_commit: both hosts run the same clean commit (the same schema is what makes going back possible)
same_commit() {
  [ -n "$DRY" ] && { echo "[dry-run] the same clean commit on both"; return 0; }
  o=$(on_ovh state | sed -n 's/.*commit=\([0-9a-f]* dirty=[a-z]*\).*/\1/p'); c=$(on_crux state | sed -n 's/.*commit=\([0-9a-f]* dirty=[a-z]*\).*/\1/p')
  [ -n "$o" ] && [ "$o" = "$c" ] || { echo "move: not the same commit (ovh $o, crux $c)" >&2; exit 1; }
  case "$o" in *dirty=false) ;; *) echo "move: a dirty deploy ($o)" >&2; exit 1 ;; esac
}
case "$CMD" in
  tools) tools ;;
  hop) on_crux hop $A ;;
  state) on_crux state; on_ovh state ;;
  check) same_commit; on_crux check; on_ovh check ;;
  preseed) on_crux preseed ;;
  rehearse) same_commit; t0=$(date +%s); on_crux preseed; on_ovh rehearse; t "rehearsed in $(( $(date +%s) - t0 )) s (the copy included)" ;;
  go)
    S=$(on_ovh state); case "$S" in
      *'writer=yes'*'"mode":"pass","port":8642'*) echo "move: already done"; exit 0 ;;
      *'writer=yes'*'served=yes'*) case "$(on_crux state)" in *moved=tinue.db*) t "resuming: the new host has the database already" ;; *) echo "move: both hosts may be writers; look before going on" >&2; exit 1 ;; esac ;;
      *'served=yes'*) echo "move: a rollback was begun; run: move.sh rollback" >&2; exit 1 ;;
      *'"mode":"hold"'*) case "$S$(on_crux state)" in *'writer=yes'*|*moved=tinue.db*) t "resuming: crux is fenced and the gate holds" ;;
        *) echo "move: the gate holds but crux is not fenced; run: move.sh abort" >&2; exit 1 ;; esac ;;
      *) same_commit; on_crux check; on_ovh check; on_crux preseed ;;
    esac
    t0=$(date +%s)
    on_ovh hold
    case "$S" in *'writer=yes'*) ;; *) on_crux fence; R=$(on_crux send); echo "$R"; on_ovh install "$(sha "$R")" ;; esac
    on_ovh start
    [ $(( $(date +%s) - t0 )) -lt "$MAXHOLD" ] || { echo "move: held for over $MAXHOLD s; not finishing. Run: move.sh abort" >&2; exit 1; }
    on_ovh pass 8642
    t "done: held for $(( $(date +%s) - t0 )) s. The new host has the only writer now."
    on_ovh tail || echo "move: the players page or the first backup FAILED; the API is up (see above)" >&2 ;;
  abort)
    S=$(on_ovh state); case "$S" in *'served=yes'*|*'"mode":"pass","port":8642'*) echo "move: the new host has taken requests; abort would lose them. Use rollback." >&2; exit 1 ;; esac
    on_ovh hold; on_ovh stop; on_crux unfence; on_ovh pass 8643; t "back on crux" ;;
  rollback)
    S=$(on_ovh state); case "$S" in *served=yes*|*dry-run*) ;; *) echo "move: the new host has served nothing since it last had the database, so its copy may be an old one; a stopped go is undone by: move.sh abort" >&2; exit 1 ;; esac
    case "$A" in *--any-commit*) ;; *) same_commit ;; esac
    on_crux hop start # (asks through it: nothing is held or stopped without a way back)
    t "upstream gate"; [ -n "$DRY" ] || $SSH "$TINUE_HOST" 'sudo -n sh /srv/tinue/ops/upstream.sh gate'
    t0=$(date +%s); on_ovh hold; R=$(on_ovh fence); echo "$R"; on_crux take-back "$(sha "$R")"
    on_crux hop start
    on_ovh pass 8643; on_ovh returned; t "back on crux, held for $(( $(date +%s) - t0 )) s; every write made on the new host came along" ;;
  *) sed -n '2,19p' "$0"; exit 2 ;;
esac
