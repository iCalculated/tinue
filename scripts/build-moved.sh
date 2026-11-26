#!/bin/sh
# Turn the last production build for shydrie.xyz/tinue/ into the handoff page (moved/handoff.html) for the move to
# tinue.me. Run by hand, once, after that build is live and https://tinue.me works.
# usage: SITE=$HOME/Projects/site sh scripts/build-moved.sh [--dry-run]
#   then: SITE=$HOME/Projects/site sh scripts/publish-site.sh tinue-moved 'tinue moved'
# $SITE/tinue must hold that build, committed and clean (a checkout of branch `site`, as the submodule has it). Only
# index.html and version.json change: the puzzle pages already forward to ../#/puzzle/<id>, which the handoff page
# forwards on, so old links and their previews keep working; open tabs keep the files they load later, see a newer
# build, and reload into the handoff page.
#   NEW_URL, OLD_URL  the two addresses (defaults https://tinue.me/ and https://shydrie.xyz/tinue/)
set -e
cd "$(dirname "$0")/.."
DRY="${DRY_RUN:-}"; [ "$DRY" = 0 ] && DRY=; [ "$1" = --dry-run ] && DRY=1
[ -n "$SITE" ] || { echo "build-moved: set SITE (SITE=\$HOME/Projects/site)" >&2; exit 2; }
D="$SITE/tinue"; NEW_URL="${NEW_URL:-https://tinue.me/}"; OLD_URL="${OLD_URL:-https://shydrie.xyz/tinue/}"
die() { echo "build-moved: $*; nothing changed" >&2; exit 1; }
[ -e "$D/.git" ] || die "$D is not a checkout"
[ -z "$(git -C "$D" status --porcelain)" ] || die "$D is not clean"
[ ! -e "$D/CNAME" ] || die "$D is a build for another domain"
grep -q tinue-handoff "$D/index.html" && die "$D is the handoff page already"
V=$(sed -n 's/^{"v":\([0-9]*\),.*/\1/p' "$D/version.json"); [ -n "$V" ] || die "no version in $D/version.json"
# The handoff page runs that build's own modules, under their own addresses.
for f in api results playon rush-rules; do [ -s "$D/$f.js" ] || die "$D/$f.js is missing (a build with the results queue is needed)"; done
grep -Eq "from ?[\"']\./results\.js\?v=$V[\"']" "$D/app.js" || die "$D/app.js is not build $V with the results queue"
grep -q "^window.TINUE_API = 'http" "$D/config.js" || die "$D/config.js names no API"
N=$(date +%s); [ "$N" -gt "$V" ] || N=$((V + 1))
if [ -n "$DRY" ]; then echo "[dry-run] write $D/index.html (the handoff to $NEW_URL, modules of build $V) and $D/version.json (v $N)"; exit 0; fi
SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)
NAME=$(printf %s "$NEW_URL" | sed -e 's#^[a-z]*://##' -e 's#/$##')
sed -e "s#__NEW__#$NEW_URL#g" -e "s#__NEWNAME__#$NAME#g" -e "s#__OLD__#$OLD_URL#g" -e "s#__V__#$V#g" moved/handoff.html > "$D/index.html"
printf '{"v":%s,"sha":"%s"}\n' "$N" "$SHA" > "$D/version.json"
CHANGED=$(git -C "$D" status --porcelain | cut -c4- | sort | tr '\n' ' ')
[ "$CHANGED" = "index.html version.json " ] || { echo "build-moved: expected only index.html and version.json to change, got: $CHANGED" >&2; exit 1; }
echo "staged the handoff page in $D (to $NEW_URL). To publish: SITE=$SITE sh scripts/publish-site.sh tinue-moved"
