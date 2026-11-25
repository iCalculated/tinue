# Shared by the deploy scripts (sourced, not run). Sets where the API host is and how to reach it, and the dry-run switch.
#   TINUE_HOST=user@host  the Linux API host (ops/README.md). Set: the scripts go there (ship.sh, publish-puzzles.sh,
#                         check-public.sh, deploy-ovh.sh). Unset: crux. deploy-crux.sh always means crux.
#   CRUX=user@host        crux over ssh (default shy@crux)
#   CRUX_NODE, CRUX_SQLITE node and sqlite3 on crux (absolute; launchd has no PATH)
#   TINUE_DEPLOY_DIR      local state: export, publish records, revision (default deploy/, gitignored)
#   DRY_RUN=1 or --dry-run  print every remote and destructive command instead of running it
SSH="ssh -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3"
REMOTE_NODE="${CRUX_NODE:-/opt/homebrew/bin/node}"
REMOTE_SQLITE="${CRUX_SQLITE:-/usr/bin/sqlite3}"
# HOST: ssh; RDIR: the code there, as rsync names it; RCD: the same for cd; RAS: who may touch the database; RRESTART; RLOG
if [ -n "$TINUE_HOST" ]; then
  HOST="$TINUE_HOST" RDIR="${TINUE_SRV:-/srv/tinue}" RCD="${TINUE_SRV:-/srv/tinue}" RAS='sudo -n -u tinue' RRESTART='sudo -n systemctl restart tinue.service'
  REMOTE_NODE="${TINUE_NODE:-/usr/local/bin/node}" REMOTE_SQLITE= RLOG='sudo -n journalctl -u tinue -n 20 --no-pager'
else
  HOST="${CRUX:-shy@crux}" RDIR=Projects/tinue RCD='~/Projects/tinue' RAS= RRESTART='launchctl kickstart -k gui/$(id -u)/com.shy.tinue'
  RLOG='tail -20 ~/Library/Logs/tinue.log'
fi
# A host whose database moved away (ops/move/crux.sh fence): nothing is shipped to it.
UNFENCED="if ${RAS:+$RAS }test -e $RCD/data/MOVED; then echo 'refused: this host is fenced (data/MOVED); its database lives on another host now. Nothing was done.' >&2; exit 1; fi"
STATE="${TINUE_DEPLOY_DIR:-deploy}"
DRY="${DRY_RUN:-}"; [ "$DRY" = 0 ] && DRY=
for a in "$@"; do [ "$a" = --dry-run ] && DRY=1; done
export DRY_RUN="$DRY" # scripts called from here inherit it

# run CMD...: run it, or print it under --dry-run
run() { if [ -n "$DRY" ]; then echo "[dry-run] $*"; else "$@"; fi; }
# remote SCRIPT: one ssh to the host running SCRIPT under /bin/sh (not the login shell, so the fake-remote test runs it the same way), or print it (every line) under --dry-run
remote() { if [ -n "$DRY" ]; then echo "[dry-run] $SSH $HOST <<'REMOTE'"; printf '%s\n' "$1" | sed 's/^/[dry-run]   /'; echo "[dry-run] REMOTE"; else $SSH "$HOST" "/bin/sh -c '$(printf '%s' "$1" | sed "s/'/'\\\\''/g")'"; fi; }
# push SRC... DEST (DEST relative to the remote home): small files, chunky and resumable (crux drops long streams)
push() { run rsync -az --timeout=300 -e "$SSH" "$@"; }

# The code being shipped: commit, and whether the working tree differs from it (a dirty deploy names its diff's hash).
revision_json() {
  sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  dirty=false; diffh=
  if [ -n "$(git status --porcelain --untracked-files=no -- package.json server shared public scripts ops 2>/dev/null)" ]; then
    dirty=true; diffh=$(git diff HEAD -- package.json server shared public scripts ops | shasum -a 256 | cut -c1-12)
  fi
  printf '{"sha":"%s","short":"%s","dirty":%s,"diff":"%s","branch":"%s","at":"%s"}\n' \
    "$sha" "$(echo "$sha" | cut -c1-7)" "$dirty" "$diffh" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# Remote shell: wait for the restarted server to answer on 8642; a hard failure (exit 1) if it does not. Expects HEALTH_TRIES set in the remote script.
REMOTE_HEALTH='
  STATS=; i=0; while [ $i -lt $HEALTH_TRIES ]; do i=$((i+1)); STATS=$(curl -sf --max-time 3 localhost:8642/api/stats) && break; STATS=; sleep 1; done
  if [ -z "$STATS" ]; then echo "health: FAILED, node did not answer on 8642 within $HEALTH_TRIES s; last log lines:"; '"$RLOG"' 2>/dev/null; exit 1; fi
  printf "health: ok %.200s\n" "$STATS"'

# MIN_BUILD: misses sent by a site build older than this are recorded unrated (server.js, MIN_MISS_BUILD; passed as
# TINUE_MIN_BUILD in the launchd plist or /etc/tinue/tinue.env). It is the build-static.sh stamp (version.json) of the oldest build whose idea of a
# miss is still right; raise it when a client fix changes what counts as a miss. 1794817280 = 2026-11-16, an undecided
# move is played out against a defender instead of being charged, and the held-result fixes (before it: 1794808991, any
# forced win counts as a solve). One value for every deploy script.
MIN_BUILD=1794817280

# BOOK_VER, JUDGE: TINUE_BOOK_VER (the served book version, server/book.js; 0 = none) and TINUE_JUDGE (off | shadow | veto |
# decide, server/judge-mode.js) in the same plist or file. Set them here: a deploy writes it anew, so a hand edit on the host
# is lost. The values below are what the server does with neither set.
BOOK_VER=0
JUDGE=off
