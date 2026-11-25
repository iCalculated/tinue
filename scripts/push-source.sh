#!/bin/sh
# Push this checkout's main to the public source repository, so the commit version.json names (and the page's "Source
# code" link leads to) is there before the build that uses it is. ship.sh runs it first.
# usage: scripts/push-source.sh [--dry-run]
#   TINUE_REPO  the repository (default iCalculated/tinue); the remote whose URL ends in it is used. No such remote (a
#               clone, or before the move): nothing to push.
set -e
cd "$(dirname "$0")/.."
DRY="${DRY_RUN:-}"; [ "$DRY" = 0 ] && DRY=; [ "$1" = --dry-run ] && DRY=1
REPO="${TINUE_REPO:-iCalculated/tinue}"
REMOTE=$(git remote -v | awk -v r="$REPO" '$3 == "(push)" { u = $2; sub(/\.git$/, "", u); n = length(u) - length(r); if (n > 0 && substr(u, n + 1) == r && substr(u, n, 1) ~ /[:\/]/) { print $1; exit } }')
[ -n "$REMOTE" ] || { echo "push-source: no remote for $REPO; the source was not pushed"; exit 0; }
BR=$(git symbolic-ref --short HEAD 2>/dev/null || echo detached)
[ "$BR" = main ] || { echo "push-source: this checkout is on $BR, not main; not pushed" >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no -- package.json server shared public scripts wasm)" ] || echo "push-source: WARNING uncommitted changes will be in the build but not in the pushed source"
if [ -n "$DRY" ]; then echo "[dry-run] git push $REMOTE main"; exit 0; fi
sh scripts/hooks/pre-push <<REFS
refs/heads/main $(git rev-parse main) refs/heads/main 0
REFS
git push -q "$REMOTE" main && echo "push-source: $(git rev-parse --short main) is on $REMOTE main"
