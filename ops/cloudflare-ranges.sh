#!/bin/sh
# Cloudflare's published proxy ranges, kept in cloudflare-ranges.txt: the one list both Caddy and the firewall use.
# usage: cloudflare-ranges.sh caddy | nft | check
#   caddy, nft   print that program's form of the list
#                (Caddy also believes loopback: the old names come from crux's Cloudflare tunnel over the ssh hop)
#   check        compare with the list Cloudflare publishes now; exit 1 if it differs (tinue-cfranges.timer, weekly:
#                the failed unit shows in `systemctl --failed`, which deploy-ovh.sh prints). Never applied by itself.
set -e
F="$(dirname "$0")/cloudflare-ranges.txt"
case "$1" in
  caddy) echo "trusted_proxies static 127.0.0.1 $(tr '\n' ' ' < "$F")" ;;
  nft) for v in 4 6; do
      printf 'define CF%s = { %s }\n' $v "$(if [ $v = 4 ]; then grep -v : "$F"; else grep : "$F"; fi | paste -s -d, -)"; done ;;
  check) NEW=$({ curl -fsS --max-time 30 https://www.cloudflare.com/ips-v4; echo; curl -fsS --max-time 30 https://www.cloudflare.com/ips-v6; echo; } | grep . | LC_ALL=C sort -u)
    [ "$(printf '%s\n' "$NEW" | wc -l)" -ge 10 ] || { echo "cloudflare-ranges: no list came" >&2; exit 1; }
    if [ "$NEW" = "$(LC_ALL=C sort -u "$F")" ]; then echo "cloudflare-ranges: unchanged"
    else echo "cloudflare-ranges: Cloudflare's list CHANGED; update ops/cloudflare-ranges.txt run provision.sh on the host and, from a new session within 5 minutes, provision.sh --confirm-firewall:"; printf '%s\n' "$NEW"; exit 1; fi ;;
  *) echo "usage: cloudflare-ranges.sh caddy | nft | check" >&2; exit 2 ;;
esac
