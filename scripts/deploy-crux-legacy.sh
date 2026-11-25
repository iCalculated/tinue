#!/bin/sh
# LEGACY deploy (the path before 2026-11-17), kept until scripts/deploy-crux.sh + scripts/publish-puzzles.sh have been used
# for real once: code AND a full export of every public puzzle, re-imported on crux. Run it as scripts/deploy-crux.sh --legacy.
# --dry-run prints the ssh and rsync commands. Its export goes to a temp dir: deploy/puzzles/ is the record of what crux
# last got (scripts/publish-puzzles.sh's first baseline), so only a real deploy rewrites it.
# Deploy the API server to crux (Mac mini on the tailnet). Players reach it two ways: Cloudflare Tunnel at
# https://tinue-api.shydrie.xyz (primary; cloudflared is its own service on crux, never touched here) and Tailscale Funnel
# at https://crux.tail5ed24.ts.net:8443 (kept for old builds, bots and shared links; re-enabled here).
# Ships code + a puzzle export; crux upserts puzzles into its own DB, so players' ratings survive redeploys.
set -e
cd "$(dirname "$0")/.."
unset TINUE_HOST # this script means crux, whatever the shell says
. scripts/deploy-lib.sh
RS=; [ -n "$DRY" ] && { SSH="echo [dry-run] $SSH"; RS="echo [dry-run]"; }
# 1. export public puzzles (PlayTak-derived; never the local-only Ditaktic set), history baked into meta,
#    turning-point scores (turn/swing) carried along so crux's import mirrors them (null = unscored)
EXP=deploy/puzzles; [ -n "$DRY" ] && EXP=$(mktemp -d "${TMPDIR:-/tmp}/tinue-legacy-dry.XXXXXX")
mkdir -p "$EXP"
node --no-warnings -e "
const {DatabaseSync}=require('node:sqlite'); const fs=require('fs');
const d=new DatabaseSync('${TINUE_DB:-data/tinue.db}',{readOnly:true});
const out=fs.createWriteStream('$EXP/puzzles.jsonl');
let n=0; for (const r of d.prepare(\"SELECT * FROM puzzles WHERE source NOT LIKE 'Ditaktic%'\").iterate()) {
  out.write(JSON.stringify({id:r.id,size:r.size,tps:r.tps,komi:r.komi,plies:r.plies,tree:JSON.parse(r.tree),tags:r.themes?r.themes.split(','):[],
    rating:r.init_rating,source:r.source,sourceRef:r.source_ref,meta:JSON.parse(r.meta||'{}'),
    turn:r.turn??null,swing:r.swing?JSON.parse(r.swing):null,grade:r.grade??null})+'\n'); n++; }
out.end(()=>console.log('exported',n,'puzzles'));"
gzip -kf "$EXP/puzzles.jsonl"
# 2. ship code + export (small files; crux drops long streams, so keep it chunky and verifiable)
$SSH "$HOST" "$UNFENCED"'; mkdir -p ~/Projects/tinue/data ~/Projects/tinue/deploy/puzzles ~/Library/Logs'
# dev/ (test harness pages) and scripts/archive/ (one-offs) are never shipped.
$RS rsync -az --timeout=300 -e "$SSH" --exclude scripts/archive package.json server shared public scripts "$HOST":Projects/tinue/
$RS rsync -az --timeout=300 -e "$SSH" "$EXP/puzzles.jsonl.gz" "$HOST":Projects/tinue/deploy/puzzles/
# the commit the server logs with each attempt (server/revision.js), before the restart that reads it
[ -n "$DRY" ] || { mkdir -p "$STATE"; revision_json > "$STATE/revision.json"; }
$RS rsync -az --timeout=300 -e "$SSH" "$STATE/revision.json" "$HOST":Projects/tinue/deploy/revision.json
# 3. import on crux, (re)start the launchd service, keep Funnel on 8443 (cloudflared is not managed here)
# MIN_BUILD: set in scripts/deploy-lib.sh (one value for both deploy paths).
$SSH "$HOST" 'set -e; cd ~/Projects/tinue
  MIN_BUILD='"$MIN_BUILD"'; BOOK_VER='"$BOOK_VER"'; JUDGE='"$JUDGE"'
  gunzip -f deploy/puzzles/puzzles.jsonl.gz
  OUT=$(/opt/homebrew/bin/node --no-warnings scripts/import.mjs deploy/puzzles) # (a refused import stops the deploy here: set -e)
  echo "$OUT" | head -1; echo "$OUT" | grep "^grade overrides" || true
  PL=~/Library/LaunchAgents/com.shy.tinue.plist
  cat > $PL.new <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.shy.tinue</string>
  <key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>--no-warnings</string><string>server/server.js</string></array>
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
  # Wait (up to 15 s) for node to answer, so the public check below does not catch it mid-start.
  STATS=; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do STATS=$(curl -sf --max-time 3 localhost:8642/api/stats) && break; STATS=; sleep 1; done
  if [ -n "$STATS" ]; then printf "%.200s\n" "$STATS"; else echo "WARNING: node did not answer on 8642 within 15 s"; fi
  TS=$(command -v tailscale || ls /opt/homebrew/bin/tailscale /usr/local/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale 2>/dev/null | head -1)
  # Funnel ONLY port 8443 for tinue. Port 443 carries other tailnet-only routes (e.g. /transcripts) and must
  # never be funneled: funnel is per-port, so funneling 443 would publish everything on it.
  $TS funnel --bg --https=8443 8642 || echo "Funnel not enabled yet — follow the URL above to allow it for this tailnet"
  $TS serve status --json | grep -A2 AllowFunnel'
echo "API: https://tinue-api.shydrie.xyz/api/stats (Cloudflare Tunnel, primary)"
echo "     https://crux.tail5ed24.ts.net:8443/api/stats (Tailscale Funnel, legacy)"
# The curl above is crux talking to itself. Players come in through Cloudflare's edge (old clients through Funnel's
# relays); either can be down while crux is fine, so check them from outside (scripts/check-public.sh: only the
# Cloudflare path fails it, a Funnel relay problem is printed as a warning).
sh scripts/check-public.sh || echo "WARNING: https://tinue-api.shydrie.xyz is not answering; players on the current build cannot reach the API. Check cloudflared on crux (530 = tunnel down, 502 = node down behind it)."
