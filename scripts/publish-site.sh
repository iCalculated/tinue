#!/bin/sh
# Publish a built client that build-static.sh or build-beta.sh staged at $SITE/<name>.
# usage: SITE=$HOME/Projects/site sh scripts/publish-site.sh [--dry-run] [--no-push] [tinue|tinue-beta] [message]
# $SITE/<name> is either
#   a submodule: a checkout of this project's own repository, branch `site` (tinue) or `beta` (tinue-beta), whose root is
#     the built page. The build is committed on the tip of that branch and pushed, THEN $SITE's pointer is bumped and
#     pushed. That order matters: a pointer to a commit GitHub doesn't have fails the whole Pages build, homepage too
#     (what is live stays live). Roll back with git revert of the pointer commit in $SITE; the next publish builds on the
#     tip again, whatever the pointer says.
#   or a plain directory of $SITE (the layout before the move): committed there as it always was.
# Anything else in $SITE is left alone: only <name> is committed.
set -e
DRY="${DRY_RUN:-}"; [ "$DRY" = 0 ] && DRY=
PUSH=1
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1; shift ;; --no-push) PUSH=; shift ;;
  -*) echo "publish-site: unknown option $1" >&2; exit 2 ;; *) break ;;
esac; done
[ -n "$SITE" ] || { echo "publish-site: set SITE (SITE=\$HOME/Projects/site)" >&2; exit 2; }
NAME="${1:-tinue}"; MSG="${2:-$NAME}"
case "$NAME" in tinue) BRANCH=site ;; tinue-beta) BRANCH=beta ;; *) echo "publish-site: $NAME is neither tinue nor tinue-beta" >&2; exit 2 ;; esac
D="$SITE/$NAME"
SUB=; [ -e "$D/.git" ] && SUB=1
if [ -z "$SUB" ] && git -C "$SITE" ls-files -s -- "$NAME" 2>/dev/null | grep -q '^160000'; then
  echo "publish-site: $D is a submodule of $SITE but its .git is gone (not checked out, or an old build-static.sh wiped it); nothing published. Restore it: printf 'gitdir: ../.git/modules/$NAME\n' > $D/.git" >&2; exit 1
fi
if [ -n "$DRY" ]; then
  [ -z "$SUB" ] || echo "[dry-run] git -C $D fetch, reset --soft origin/$BRANCH, add -A, commit -m '$MSG'${PUSH:+, push origin HEAD:$BRANCH}"
  echo "[dry-run] git -C $SITE add $NAME && git -C $SITE commit -m '$MSG'${PUSH:+ && git -C $SITE push origin main}"
  exit 0
fi
[ -s "$D/index.html" ] && [ -s "$D/version.json" ] || { echo "publish-site: $D is not a finished build; nothing published" >&2; exit 1; }
if [ -n "$SUB" ]; then
  git -C "$D" fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  git -C "$D" reset -q --soft "origin/$BRANCH" # the build replaces every file, so whatever was checked out doesn't matter
  git -C "$D" add -A
  if git -C "$D" diff --cached --quiet; then echo "publish-site: the build is unchanged; nothing to commit on $BRANCH"
  else git -C "$D" commit -q -m "$MSG" && echo "publish-site: committed $(git -C "$D" rev-parse --short HEAD) on $BRANCH"; fi
  [ -z "$PUSH" ] || git -C "$D" push -q origin "HEAD:refs/heads/$BRANCH"
fi
git -C "$SITE" add -- "$NAME"
if git -C "$SITE" diff --cached --quiet -- "$NAME"; then echo "publish-site: $NAME is unchanged; nothing to commit in $SITE"
else git -C "$SITE" commit -q -m "$MSG" -- "$NAME" && echo "publish-site: committed $(git -C "$SITE" rev-parse --short HEAD) in $SITE"; fi
if [ -n "$PUSH" ]; then git -C "$SITE" push -q origin main && echo "publish-site: pushed; Pages serves it in a minute or two"
else echo "publish-site: not pushed (--no-push)"; fi
