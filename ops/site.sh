#!/bin/sh
# Serve one public name, as root. Enable a name only when Let's Encrypt's HTTP-01 request for it reaches this server
# (see README: failed attempts are rate limited).   usage: site.sh NAME [--off] [--dry-run]
set -e
E="${CADDY_ETC:-/etc/caddy}"; HERE=$(cd "$(dirname "$0")" && pwd); N="$1"
[ -n "$N" ] && [ -f "$HERE/caddy/$N.caddy" ] || { echo "site: no ops/caddy/$N.caddy" >&2; exit 2; }
case " $* " in *" --dry-run "*) echo "[dry-run] $* in $E/sites, validate, reload caddy"; exit 0 ;; esac
if [ "$2" = --off ]; then rm -f "$E/sites/$N.caddy"; else cp "$HERE/caddy/$N.caddy" "$E/sites/"; fi
if ! caddy validate --adapter caddyfile --config "$E/Caddyfile" >/dev/null 2>&1; then rm -f "$E/sites/$N.caddy"; echo "site: caddy refused the configuration; $N removed" >&2; exit 1; fi
systemctl reload caddy; echo "site: $N ${2:-on}"
