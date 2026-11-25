#!/bin/sh
# Deploy the API server's CODE to crux (Mac mini on the tailnet) and wait until it answers. Refused once crux is fenced
# (the API has moved: scripts/deploy-ovh.sh). Puzzles are content and go
# separately (scripts/publish-puzzles.sh); this never writes a puzzle row. Client and API together: scripts/ship.sh.
# Players reach the API two ways: Cloudflare Tunnel at https://tinue-api.shydrie.xyz (primary; cloudflared is its own
# service on crux, never touched here) and Tailscale Funnel at https://crux.tail5ed24.ts.net:8443 (kept for old builds,
# bots and shared links; re-enabled here, on 8443 only).
# usage: scripts/deploy-crux.sh [--dry-run] [--legacy] [--fenced]
#   --fenced   only onto a fenced crux: the code and its revision, nothing started (before a rollback: the code that
#              starts there must be the one that last wrote the database). Deploy again after the rollback.
#   --dry-run  print every ssh/rsync and the remote script instead of running them
#   --legacy   the old path (scripts/deploy-crux-legacy.sh): code plus a full export and re-import of every puzzle.
#              Kept until this path has been used for real once.
# Exit status: non-zero if shipping fails or node does not answer on crux within 30 s. It does not run the public check
# (ship.sh does, as a hard failure); run scripts/check-public.sh after a bare deploy.
set -e
cd "$(dirname "$0")/.."
FENCED=
for a in "$@"; do case "$a" in
  --legacy) shift_legacy=1 ;;
  --dry-run) ;;
  --fenced) FENCED=1 ;;
  *) echo "deploy-crux: unknown option $a (usage: scripts/deploy-crux.sh [--dry-run] [--legacy] [--fenced])" >&2; exit 2 ;;
esac; done
[ -n "$shift_legacy" ] && exec sh scripts/deploy-crux-legacy.sh "$@"
unset TINUE_HOST # this script means crux, whatever the shell says
. scripts/deploy-lib.sh

# 1. the revision being shipped, so the server's deploy/revision.json (and batch outputs, bug reports) can name the code
mkdir -p "$STATE"
REV=$(revision_json)
echo "deploy: $REV"
case "$REV" in *'"dirty":true'*) echo "deploy: WARNING the working tree differs from that commit; revision.json records the diff's hash" ;; esac
if [ -n "$DRY" ]; then echo "[dry-run] write $STATE/revision.json"; else printf '%s\n' "$REV" > "$STATE/revision.json"; fi

# 2. ship code (dev/ test pages and scripts/archive/ one-offs never go). No puzzle export, no import.
[ -z "$FENCED" ] || UNFENCED="test -e $RCD/data/MOVED || { echo 'refused: this host is not fenced' >&2; exit 1; }"
remote "$UNFENCED"'; mkdir -p ~/Projects/tinue/data ~/Projects/tinue/deploy ~/Library/Logs'
push --exclude scripts/archive package.json server shared public scripts "$HOST":Projects/tinue/
push "$STATE/revision.json" "$HOST":Projects/tinue/deploy/revision.json

if [ -n "$FENCED" ]; then echo "deploy: code only (fenced); nothing started"; exit 0; fi

# 3. (re)start the launchd service, wait for health, keep Funnel on 8443 (cloudflared is not managed here)
remote "set -e; cd ~/Projects/tinue
  NODE='$REMOTE_NODE'; MIN_BUILD=$MIN_BUILD; BOOK_VER=$BOOK_VER; JUDGE=$JUDGE; HEALTH_TRIES=30"'
  PL=~/Library/LaunchAgents/com.shy.tinue.plist
  cat > $PL.new <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.shy.tinue</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--no-warnings</string><string>server/server.js</string></array>
  <key>WorkingDirectory</key><string>$HOME/Projects/tinue</string>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>8642</string><key>HOST</key><string>127.0.0.1</string><key>TINUE_ORIGINS</key><string>https://tinue.me,https://shydrie.xyz</string><key>TINUE_SITE</key><string>https://shydrie.xyz/tinue/</string><key>TINUE_MOVED_TO</key><string>https://tinue-api.shydrie.xyz</string><key>TINUE_SECURE</key><string>1</string><key>TINUE_MIN_BUILD</key><string>$MIN_BUILD</string><key>TINUE_BOOK_VER</key><string>$BOOK_VER</string><key>TINUE_JUDGE</key><string>$JUDGE</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/tinue.log</string><key>StandardErrorPath</key><string>$HOME/Library/Logs/tinue.log</string>
</dict></plist>
PLIST
  # ProcessType Interactive: without it launchd gives the job background resource limits, which its Syntaks
  # children inherit; on a busy crux they then crawl on leftover E-core time (~40k nodes per search instead of ~2M).
  # Restart in place if it is already loaded and the plist is unchanged (bootout+bootstrap races and can fail with
  # an I/O error). A changed plist only takes effect on a fresh bootstrap, so then bootout and retry the bootstrap.
  if launchctl print gui/$(id -u)/com.shy.tinue >/dev/null 2>&1 && cmp -s $PL $PL.new; then rm $PL.new; launchctl kickstart -k gui/$(id -u)/com.shy.tinue
  else mv $PL.new $PL; launchctl bootout gui/$(id -u)/com.shy.tinue 2>/dev/null || true; sleep 2
    for i in 1 2 3 4 5; do launchctl bootstrap gui/$(id -u) $PL && break; sleep 2; done; fi
  launchctl kickstart -k gui/$(id -u)/com.shy.tinue-players 2>/dev/null || true # the players page loads its code once
  echo "revision: $(cat deploy/revision.json)"'"$REMOTE_HEALTH"'
  TS=$(command -v tailscale || ls /opt/homebrew/bin/tailscale /usr/local/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale 2>/dev/null | head -1)
  # Funnel ONLY port 8443 for tinue. Port 443 carries other tailnet-only routes (e.g. /transcripts) and must
  # never be funneled: funnel is per-port, so funneling 443 would publish everything on it.
  $TS funnel --bg --https=8443 8642 || echo "Funnel not enabled yet — follow the URL above to allow it for this tailnet"
  $TS serve status --json | grep -A2 AllowFunnel || true'
echo "API: https://tinue-api.shydrie.xyz/api/stats (Cloudflare Tunnel, primary)"
echo "     https://crux.tail5ed24.ts.net:8443/api/stats (Tailscale Funnel, legacy)"
echo "deploy: done. The health check above is crux talking to itself; scripts/check-public.sh checks the way players come in."
