#!/bin/sh
# Serve a built page (branch `site` or `beta` of the public repository) from this host, as the login user.
# usage: page.sh site | beta [--back]     --back: the release before
# Each publish is its own folder under /srv/tinue-page/releases; /srv/tinue-page/<name> is a link that flips to it at once,
# so nobody gets half a build. The last 3 are kept.
set -eu
B="${1:-}"; case "$B" in site|beta) ;; *) echo "usage: page.sh site | beta [--back]" >&2; exit 2 ;; esac
D="${TINUE_PAGE:-/srv/tinue-page}" URL="${TINUE_PAGE_REPO:-https://github.com/iCalculated/tinue.git}"
mkdir -p "$D/releases"; exec 9> "$D/lock"; flock -w 120 9
flip() { ln -sfn "releases/$1" "$D/$B.new"; mv -T "$D/$B.new" "$D/$B"; echo "page: $B is $1"; }
if [ "${2:-}" = --back ]; then
  N=$(ls -1 "$D/releases" | grep "^$B-" | grep -vxF "$(basename "$(readlink "$D/$B")")" | tail -1); [ -n "$N" ] || { echo "page: no other $B release" >&2; exit 1; }
  flip "$N"; exit 0
fi
[ -d "$D/repo.git" ] || git init -q --bare "$D/repo.git"
git -C "$D/repo.git" fetch -q --depth 1 "$URL" "+refs/heads/$B:refs/heads/$B"
C=$(git -C "$D/repo.git" rev-parse --short=12 "$B"); N="$B-$(date -u +%Y%m%dT%H%M%S)-$C"
case "$(readlink "$D/$B" 2>/dev/null || true)" in *-"$C") echo "page: $B is $C already"; exit 0 ;; esac
rm -rf "$D/releases/.part"; mkdir "$D/releases/.part"
git -C "$D/repo.git" archive "$B" | tar -x -C "$D/releases/.part"
[ -s "$D/releases/.part/index.html" ] && [ -s "$D/releases/.part/version.json" ] || { echo "page: $B is not a finished build; nothing changed" >&2; exit 1; }
mv "$D/releases/.part" "$D/releases/$N"; flip "$N"
ls -1 "$D/releases" | grep "^$B-" | head -n -3 | while read -r o; do rm -rf "$D/releases/$o"; done
