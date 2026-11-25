#!/bin/sh
# Check the API the way players reach it.
# Primary: https://tinue-api.shydrie.xyz, crux through Cloudflare Tunnel (what the current site build calls). The name
#   resolves to Cloudflare's edge from anywhere, lyra and crux included, so a plain curl tests the real path.
#   Only this one decides the exit status.
# Secondary, while the Funnel stays up (open tabs on old builds, bots, shared links whose og:image points there): each
#   public Funnel relay for crux.tail5ed24.ts.net:8443. A plain curl from a tailnet machine (lyra, crux) resolves that
#   name to crux's tailnet address and never touches Funnel, so it stays green while the public path is down.
#   2026-11-16: no player request arrived from 08:41 to 09:31 PST while every check we ran that way passed. So each
#   relay is looked up on 1.1.1.1 and pinned with --resolve. A failing or slow relay is only a warning.
# usage: scripts/check-public.sh [--dry-run] [api_url] [funnel_host] [funnel_port]
#   exit 0 if the primary answers 200, else 1. --dry-run (or DRY_RUN=1) prints the requests it would make and exits 0.
DRY="${DRY_RUN:-}"; [ "$DRY" = 0 ] && DRY=
[ "$1" = --dry-run ] && { DRY=1; shift; }
API="${1:-https://tinue-api.shydrie.xyz}"; FHOST="${2:-crux.tail5ed24.ts.net}"; FPORT="${3:-8443}"; SLOW=2
if [ -n "$DRY" ]; then
  echo "[dry-run] curl ${API%/}/api/stats (exit 1 unless 200)"
  echo "[dry-run] dig +short @1.1.1.1 $FHOST A, then curl --resolve $FHOST:$FPORT:<ip> https://$FHOST:$FPORT/api/stats per relay (warnings only)"
  exit 0
fi
probe() { curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 15 "$@" || true; }
slow() { awk -v t="$1" -v s="$SLOW" 'BEGIN { exit !(t > s) }'; }
out=$(probe "${API%/}/api/stats"); code=${out%% *}; t=${out#* }
if [ "$code" = 200 ]; then
  echo "public check: $API answered 200 in ${t}s"
  slow "$t" && echo "public check: WARNING $API is slow (${t}s)"
  bad=0
else
  echo "public check: $API FAILED (${code:-no answer} in ${t:-?}s; 502 = node down behind cloudflared, 530 = cloudflared down)"
  bad=1
fi
IPS=$(dig +short @1.1.1.1 "$FHOST" A | grep -E '^[0-9.]+$')
[ -n "$IPS" ] || echo "public check: WARNING no public Funnel address found for $FHOST"
for ip in $IPS; do
  # with the page's Origin: a plain request to the old host is answered 301 (moved), a page's fetch still gets 200
  out=$(probe -H 'Origin: https://shydrie.xyz' --resolve "$FHOST:$FPORT:$ip" "https://$FHOST:$FPORT/api/stats"); code=${out%% *}; t=${out#* }
  if [ "$code" != 200 ]; then echo "public check: WARNING Funnel relay $ip FAILED (${code:-no answer} in ${t:-?}s)"
  elif slow "$t"; then echo "public check: WARNING Funnel relay $ip slow (200 in ${t}s)"
  else echo "public check: Funnel relay $ip answered 200 in ${t}s"; fi
done
exit $bad
