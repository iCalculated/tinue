#!/bin/sh
# Check the API the way players reach it: each public name through Cloudflare (a plain curl from anywhere tests that path).
# TINUE_HOST set (the API is on its Linux host): https://api.tinue.me and https://tinue-api.shydrie.xyz, both required.
# Unset (crux): https://tinue-api.shydrie.xyz is required, and each public Tailscale Funnel relay is probed for a warning
#   (old builds, bots, shared links). A plain curl from a tailnet machine resolves the Funnel name to crux's tailnet
#   address and never touches Funnel, so each relay is looked up on 1.1.1.1 and pinned with --resolve.
# usage: scripts/check-public.sh [--dry-run] [api_url ...]
#   exit 0 if every API name answers 200, else 1. --dry-run (or DRY_RUN=1) prints the requests it would make and exits 0.
DRY="${DRY_RUN:-}"; [ "$DRY" = 0 ] && DRY=
[ "$1" = --dry-run ] && { DRY=1; shift; }
FHOST=crux.tail5ed24.ts.net; FPORT=8443; SLOW=2
if [ $# = 0 ]; then set -- https://tinue-api.shydrie.xyz; [ -z "$TINUE_HOST" ] || set -- https://api.tinue.me "$@"; fi
if [ -n "$DRY" ]; then
  for API in "$@"; do echo "[dry-run] curl ${API%/}/api/stats (exit 1 unless 200)"; done
  [ -n "$TINUE_HOST" ] || echo "[dry-run] dig +short @1.1.1.1 $FHOST A, then curl --resolve $FHOST:$FPORT:<ip> https://$FHOST:$FPORT/api/stats per relay (warnings only)"
  exit 0
fi
probe() { curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 15 "$@" || true; }
slow() { awk -v t="$1" -v s="$SLOW" 'BEGIN { exit !(t > s) }'; }
if [ -n "$TINUE_HOST" ]; then WHY="502 = node down behind Caddy; 521, 522 = Caddy or the firewall; 525, 526 = its certificate"
else WHY="502 = node down behind cloudflared, 530 = cloudflared down"; fi
bad=0
for API in "$@"; do
  out=$(probe "${API%/}/api/stats"); code=${out%% *}; t=${out#* }
  if [ "$code" = 200 ]; then
    echo "public check: $API answered 200 in ${t}s"
    slow "$t" && echo "public check: WARNING $API is slow (${t}s)"
  else
    echo "public check: $API FAILED (${code:-no answer} in ${t:-?}s; $WHY)"
    bad=1
  fi
done
[ -z "$TINUE_HOST" ] || exit $bad
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
