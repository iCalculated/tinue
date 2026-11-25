#!/bin/sh
# Ship tinue: API code to crux, then (with --puzzles) puzzle content, then the static client to GitHub Pages, then the
# public check as a hard failure. API first: a new client may call what only the new API has, while the clients already
# open in tabs keep talking to whatever API is up (it has to stay compatible with them anyway).
# usage: SITE=$HOME/Projects/site scripts/ship.sh [--dry-run] [--puzzles] [--no-push] [--legacy]
#   --puzzles  also run scripts/publish-puzzles.sh (new and changed rows) between the API and the client
#   --no-push  build and commit the client in $SITE but do not push it
#   --legacy   deploy the API the old way (scripts/deploy-crux.sh --legacy: code plus every puzzle re-imported)
#   --dry-run  every step prints its remote and destructive commands instead of running them
# Exit status: the first failing step's. The last step is scripts/check-public.sh: the Cloudflare host failing makes
# this fail; a Funnel relay failing is printed as a warning only.
# The source goes to its public repository first (scripts/push-source.sh; not with --no-push), so the page never runs
# code whose source isn't there. The client is committed and pushed by scripts/publish-site.sh.
# Test hooks: PUSH_SOURCE, DEPLOY_CRUX, PUBLISH_PUZZLES, BUILD_STATIC, CHECK_PUBLIC replace the step commands (scripts/test-deploy.mjs).
set -e
cd "$(dirname "$0")/.."
PUZZLES=; PUSH=1; LEGACY=
for a in "$@"; do case "$a" in
  --puzzles) PUZZLES=1 ;; --no-push) PUSH= ;; --legacy) LEGACY=--legacy ;; --dry-run) ;;
  *) echo "ship: unknown option $a" >&2; exit 2 ;;
esac; done
. scripts/deploy-lib.sh
[ -n "$SITE" ] || { echo "ship: set SITE (SITE=\$HOME/Projects/site)" >&2; exit 2; }
[ -n "$LEGACY" ] && [ -n "$PUZZLES" ] && { echo "ship: --legacy already re-imports every puzzle; drop --puzzles" >&2; exit 2; }
step() { echo; echo "== ship: $*"; }
# Before anything ships: the push below sends $SITE's whole main, so it must be on main with nothing of its own unpushed
# (a homepage edit waiting there would go public with the client). Local refs only; no fetch.
if [ -n "$PUSH" ]; then
  BR=$(git -C "$SITE" symbolic-ref --short HEAD 2>/dev/null || echo detached)
  [ "$BR" = main ] || { echo "ship: $SITE is on $BR, not main; nothing shipped (check it out, or --no-push)" >&2; exit 1; }
  AHEAD=$(git -C "$SITE" rev-list --count origin/main..main 2>/dev/null) || { echo "ship: $SITE has no origin/main; nothing shipped" >&2; exit 1; }
  [ "$AHEAD" = 0 ] || { echo "ship: $SITE main has $AHEAD unpushed commit(s) that are not this build; nothing shipped (push or drop them first, or --no-push)" >&2; exit 1; }
fi

[ -z "$PUSH" ] || ${PUSH_SOURCE:-sh scripts/push-source.sh}
step "1/4 API code to crux"
${DEPLOY_CRUX:-sh scripts/deploy-crux.sh} $LEGACY
if [ -n "$PUZZLES" ]; then step "2/4 puzzles to crux"; ${PUBLISH_PUZZLES:-sh scripts/publish-puzzles.sh}
else step "2/4 puzzles: skipped (--puzzles publishes new and changed rows)"; fi

step "3/4 client to GitHub Pages ($SITE)"
${BUILD_STATIC:-sh scripts/build-static.sh}
sh scripts/publish-site.sh $([ -n "$PUSH" ] || echo --no-push) tinue "tinue $(git rev-parse --short HEAD)"

step "4/4 public check"
if ${CHECK_PUBLIC:-sh scripts/check-public.sh}; then echo "ship: done"
else
  echo "ship: FAILED the public check: https://tinue-api.shydrie.xyz is not answering 200; players on the current build cannot reach the API. Check cloudflared on crux (530 = tunnel down, 502 = node down behind it)." >&2
  exit 1
fi
