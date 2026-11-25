#!/bin/sh
# Set up the API host (Ubuntu Server 26.04, x86-64), as root, from a copy of this repository's ops/. Run it again any
# time: it changes only what differs, and says what. It starts no tinue server (that needs the WRITER file).
# usage: provision.sh [--login USER] [--mover-key FILE.pub] [--no-hop] [--dry-run]
#        provision.sh --confirm-firewall     keep the new firewall (else it is undone 5 minutes after it was loaded)
#   --login      the account people log in as by key (default ubuntu); only it and `mover` may ssh in, keys only
#   --mover-key  crux's public key: the unprivileged account `mover` receives the database, forwards the two move ports
#                (8643 here to crux's node, crux to port 80 here for certificates) and lets crux pull backups
#   --no-hop     that key may no longer forward ports (after the move)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
LOGIN=ubuntu; KEY=; HOP=1; DRY="${DRY_RUN:-}"; [ "$DRY" = 0 ] && DRY=; CONFIRM=
NODE_V=v24.22.3 NODE_SHA=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
while [ $# -gt 0 ]; do case "$1" in
  --login) LOGIN="$2"; shift ;; --mover-key) KEY="$2"; shift ;; --no-hop) HOP= ;; --dry-run) DRY=1 ;; --confirm-firewall) CONFIRM=1 ;;
  *) echo "provision: unknown option $1" >&2; exit 2 ;;
esac; shift; done
say() { echo "provision: $*"; }
run() { if [ -n "$DRY" ]; then echo "[dry-run] $*"; else "$@"; fi; }
[ -n "$DRY" ] || [ "$(id -u)" = 0 ] || { echo "provision: run as root" >&2; exit 1; }
CHANGED=
# put MODE DEST: standard input into DEST, only if it differs; CHANGED is then set
put() {
  T=$(mktemp); cat > "$T"; CHANGED=
  if ! cmp -s "$T" "$2"; then CHANGED=1; say "write $2"; [ -n "$DRY" ] || { mkdir -p "$(dirname "$2")"; install -m "$1" "$T" "$2"; }; fi
  rm -f "$T"
}
dir() { run install -d -m "$1" -o "$2" -g "$3" "$4"; } # dir MODE OWNER GROUP PATH

if [ -n "$CONFIRM" ]; then
  run systemctl stop tinue-fw-revert.timer
  [ -n "$DRY" ] || { [ -s /etc/nftables.conf.new ] || { echo "provision: no new firewall to confirm" >&2; exit 1; }
    nft list table inet tinue >/dev/null || { echo "provision: the new firewall is not loaded (undone already?); run provision.sh again" >&2; exit 1; }
    mv /etc/nftables.conf.new /etc/nftables.conf; }
  run systemctl enable nftables; say "firewall kept"; exit 0
fi

# 1. packages: node from nodejs.org, pinned and checksummed; caddy from its own repository
PK="rsync curl ca-certificates xz-utils gpg git nftables chrony unattended-upgrades build-essential rustup lsof"
if [ -n "$DRY" ] || ! dpkg -s $PK >/dev/null 2>&1; then run apt-get update -q; run env DEBIAN_FRONTEND=noninteractive apt-get install -yq $PK; fi
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != $NODE_V ]; then
  say "node $NODE_V"
  [ -n "$DRY" ] || { T=$(mktemp -d); curl -fsSL -o "$T/n.txz" "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-x64.tar.xz"
    echo "$NODE_SHA  $T/n.txz" | sha256sum -c - >/dev/null
    rm -rf "/opt/node-$NODE_V"; mkdir "/opt/node-$NODE_V"; tar -xJf "$T/n.txz" -C "/opt/node-$NODE_V" --strip-components=1 --no-same-owner
    ln -sfn "/opt/node-$NODE_V/bin/node" /usr/local/bin/node; rm -rf "$T"; }
fi
if ! command -v caddy >/dev/null; then
  say "caddy"
  [ -n "$DRY" ] || { curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q; apt-get install -yq caddy; }
fi
put 644 /etc/apt/apt.conf.d/20auto-upgrades <<'X'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
X

# 2. accounts and directories. /srv/tinue is code (root's: the service cannot change it), /var/lib/tinue is state.
id tinue >/dev/null 2>&1 || run useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin tinue
id tinue-build >/dev/null 2>&1 || run useradd --system --user-group --create-home --home-dir /var/lib/tinue-build --shell /bin/sh tinue-build # compiles the engine; no sudo
id mover >/dev/null 2>&1 || run useradd --create-home --user-group --shell /bin/sh mover
dir 755 root root /srv/tinue; dir 755 "$LOGIN" "$LOGIN" /srv/tinue/deploy
dir 700 tinue tinue /var/lib/tinue; dir 700 mover mover /var/lib/tinue-in; dir 750 root mover /var/lib/tinue-out
dir 2750 tinue mover /var/lib/tinue-backup; dir 755 root root /var/lib/tinue-gate; dir 750 root tinue /etc/tinue
[ -L /srv/tinue/data ] || run ln -s /var/lib/tinue /srv/tinue/data
[ -s /var/lib/tinue-gate/mode ] || { say "gate mode: hold"; [ -n "$DRY" ] || { echo hold > /var/lib/tinue-gate/mode; chmod 644 /var/lib/tinue-gate/mode; }; }

# 3. ssh: keys only, two accounts. 00- because the first value read wins.
put 644 /etc/ssh/sshd_config.d/00-tinue.conf <<X
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
X11Forwarding no
AllowUsers $LOGIN mover
ClientAliveInterval 5
ClientAliveCountMax 3
Match User mover
  AuthorizedKeysFile /etc/ssh/authorized_keys.d/%u
  PermitTTY no
  AllowAgentForwarding no
X
if [ -n "$CHANGED" ] && [ -z "$DRY" ]; then
  H=$(getent passwd "$LOGIN" | cut -d: -f6)
  [ -s "$H/.ssh/authorized_keys" ] && sshd -t || { rm /etc/ssh/sshd_config.d/00-tinue.conf; echo "provision: $LOGIN has no key, or sshd refused the configuration; ssh left as it was" >&2; exit 1; }
  systemctl reload ssh
fi
if [ -n "$KEY" ]; then
  [ "$(grep -c '^ssh-' "$KEY")" = 1 ] || { echo "provision: $KEY is not one public key" >&2; exit 1; }
  O=restrict; [ -z "$HOP" ] || O='restrict,port-forwarding,permitlisten="127.0.0.1:8643",permitopen="127.0.0.1:80"'
  echo "$O $(grep '^ssh-' "$KEY" | cut -d' ' -f1,2) mover" | put 644 /etc/ssh/authorized_keys.d/mover # (root's: mover cannot widen it)
fi

# 4. firewall: 22 by key from anywhere, 80 and 443 from Cloudflare only. A bad set undoes itself.
F=$(mktemp); { sed '/^@CF@$/,$d' "$HERE/nftables.conf"; sh "$HERE/cloudflare-ranges.sh" nft; sed '1,/^@CF@$/d' "$HERE/nftables.conf"; } > "$F"
if cmp -s "$F" /etc/nftables.conf && nft list table inet tinue >/dev/null 2>&1; then rm -f /etc/nftables.conf.new
else
  put 600 /etc/nftables.conf.new < "$F"
  say "firewall: loading; undone in 5 minutes unless 'provision.sh --confirm-firewall' is run from a NEW ssh session"
  if [ -z "$DRY" ]; then
    nft -c -f /etc/nftables.conf.new
    systemctl stop tinue-fw-revert.timer 2>/dev/null || true; systemctl reset-failed tinue-fw-revert.service 2>/dev/null || true
    OLD='nft delete table inet tinue'; if nft list table inet tinue >/dev/null 2>&1; then OLD='nft -f /etc/nftables.conf'; fi
    systemd-run --quiet --on-active=300 --unit=tinue-fw-revert sh -c "$OLD"
    nft -f /etc/nftables.conf.new
  fi
fi

rm -f "$F"

# 5. caddy
R=$(mktemp); sh "$HERE/cloudflare-ranges.sh" caddy > "$R"; put 644 /etc/caddy/cf-ranges.caddy < "$R"; C=$CHANGED; rm -f "$R" # (not a pipe: CHANGED would be a subshell's)
put 644 /etc/caddy/Caddyfile < "$HERE/Caddyfile"; C=$C$CHANGED
run mkdir -p /etc/caddy/sites
[ -s /etc/caddy/upstream.caddy ] || { printf '(upstream) {\n\timport proxy 127.0.0.1:8641\n}\n' | put 644 /etc/caddy/upstream.caddy; C=1; }
for f in "$HERE"/caddy/*.caddy; do n=$(basename "$f"); [ ! -f "/etc/caddy/sites/$n" ] || { put 644 "/etc/caddy/sites/$n" < "$f"; C=$C$CHANGED; }; done # only names already served
if [ -n "$C" ] && [ -z "$DRY" ]; then caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { echo "provision: caddy refuses its configuration" >&2; exit 1; }; systemctl reload-or-restart caddy; fi

# 6. units: enabled for boot; without WRITER tinue, its players page and its backup do nothing
C=; for f in "$HERE"/systemd/*; do put 644 "/etc/systemd/system/$(basename "$f")" < "$f"; C=$C$CHANGED; done
[ -z "$C" ] || run systemctl daemon-reload
run systemctl enable --quiet tinue.service tinue-players.service
run systemctl enable --quiet --now tinue-backup.timer tinue-cfranges.timer chrony.service unattended-upgrades.service
say "done (code goes in with scripts/deploy-ovh.sh; env is /etc/tinue/tinue.env, written by it)"
