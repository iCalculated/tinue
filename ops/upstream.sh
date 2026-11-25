#!/bin/sh
# Which process the API names go to, as root: the gate (during a move) or node itself.   usage: upstream.sh gate | node [--dry-run]
set -e
E="${CADDY_ETC:-/etc/caddy}"
case "$1" in gate) P=8641 ;; node) P=8642 ;; *) echo "usage: upstream.sh gate | node [--dry-run]" >&2; exit 2 ;; esac
if [ "$2" = --dry-run ] || { [ -n "$DRY_RUN" ] && [ "$DRY_RUN" != 0 ]; }; then echo "[dry-run] upstream 127.0.0.1:$P, validate, reload caddy"; exit 0; fi
[ "$1" = node ] || { systemctl enable --quiet --now tinue-gate; sleep 1; systemctl is-active --quiet tinue-gate || { echo "upstream: the gate is not running" >&2; exit 1; }; }
[ ! -f "$E/upstream.caddy" ] || cp "$E/upstream.caddy" "$E/upstream.old"
printf '(upstream) {\n\timport proxy 127.0.0.1:%s\n}\n' "$P" > "$E/upstream.caddy"
if ! caddy validate --adapter caddyfile --config "$E/Caddyfile" >/dev/null 2>&1; then
  [ ! -f "$E/upstream.old" ] || cp "$E/upstream.old" "$E/upstream.caddy"; echo "upstream: caddy refused the configuration; put back" >&2; exit 1
fi
systemctl reload caddy; echo "upstream: $1 (127.0.0.1:$P)"
