#!/bin/sh
# Deploy the API server's CODE to its Linux host (ops/README.md) and wait until it answers. Puzzles go separately
# (scripts/publish-puzzles.sh). Client and API together: scripts/ship.sh.
# usage: TINUE_HOST=user@host scripts/deploy-ovh.sh [--dry-run]     no default host
# The code goes to a staging copy first, then into /srv/tinue (root's; the service cannot change it), with
# deploy/revision.json and /etc/tinue/tinue.env written anew, then a restart. A host without its WRITER file (it has not
# the database: ops/README.md) gets the code and stays down. /srv/tinue/data and /srv/tinue/deploy are never touched by the
# copy. Exit status: non-zero if shipping fails or node does not answer on the host within 30 s; then
# scripts/check-public.sh is the caller's to run (ship.sh does).
set -e
cd "$(dirname "$0")/.."
for a in "$@"; do case "$a" in --dry-run) ;; *) echo "deploy-ovh: unknown option $a (usage: TINUE_HOST=user@host scripts/deploy-ovh.sh [--dry-run])" >&2; exit 2 ;; esac; done
[ -n "$TINUE_HOST" ] || { echo "deploy-ovh: set TINUE_HOST (user@host)" >&2; exit 2; }
. scripts/deploy-lib.sh

mkdir -p "$STATE"
REV=$(revision_json)
echo "deploy: $REV"
case "$REV" in *'"dirty":true'*) echo "deploy: WARNING the working tree differs from that commit; revision.json records the diff's hash" ;; esac
if [ -n "$DRY" ]; then echo "[dry-run] write $STATE/revision.json"; else printf '%s\n' "$REV" > "$STATE/revision.json"; fi

STAGE=tinue-stage
remote "mkdir -p $STAGE"
push --delete --exclude scripts/archive package.json server shared public scripts ops "$HOST":$STAGE/
push "$STATE/revision.json" "$HOST":/srv/tinue/deploy/revision.json.new
# TINUE_ORIGINS: the page, and the old site for open tabs, its handoff page and the beta. TINUE_MOVED_FROM empty: both API
# names are served here. TINUE_HANDOFF_ORIGIN (POST /api/handoff-token): remove it once the old page's handoff is over.
remote "set -e
  MIN_BUILD=$MIN_BUILD; BOOK_VER=$BOOK_VER; JUDGE=$JUDGE; HEALTH_TRIES=30; STAGE=$STAGE"'
  sudo -n rsync -a --delete --chown=root:root --chmod=D755,Fgo-w,Fa+r --exclude /data --exclude /deploy "$HOME/$STAGE/" /srv/tinue/
  mv /srv/tinue/deploy/revision.json.new /srv/tinue/deploy/revision.json
  sudo -n sh -c "umask 027; cat > /etc/tinue/tinue.env.new; chgrp tinue /etc/tinue/tinue.env.new; mv /etc/tinue/tinue.env.new /etc/tinue/tinue.env" <<ENV
PORT=8642
HOST=127.0.0.1
TINUE_ORIGINS=https://tinue.me,https://shydrie.xyz
TINUE_SITE=https://tinue.me/
TINUE_SECURE=1
TINUE_MIN_BUILD=$MIN_BUILD
TINUE_BOOK_VER=$BOOK_VER
TINUE_JUDGE=$JUDGE
TINUE_MOVED_FROM=
TINUE_MOVED_TO=https://api.tinue.me
TINUE_SYNTAKS=/opt/syntaks/syntaks
TINUE_HANDOFF_ORIGIN=https://shydrie.xyz
ENV
  echo "revision: $(cat /srv/tinue/deploy/revision.json)"
  if ! sudo -n test -e /var/lib/tinue/WRITER; then echo "deploy: this host has no WRITER file: code and env are in, nothing started"; exit 0; fi
  sudo -n systemctl restart tinue.service
  sudo -n systemctl restart tinue-players.service # it loads its code once'"$REMOTE_HEALTH"'
  F=$(systemctl --failed --no-legend --plain | cut -d" " -f1); [ -z "$F" ] || echo "deploy: WARNING failed units: $F"'
echo "deploy: done. The health check above is the host talking to itself; scripts/check-public.sh checks the way players come in."
