#!/bin/sh
# Build the Syntaks engine natively on the API host (github.com/Ciekce/syntaks, MIT): the same commit and net as
# wasm/syntaks/build.sh, for this machine's CPU. Run it as the login user from a copy of ops/; installs with sudo.
#   sh ops/build-syntaks.sh [--dry-run]   -> /opt/syntaks/syntaks, checked by ops/tei-smoke.mjs before it goes there
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REV=4f224c9 TC=1.100.0 NET_SHA=329f2e6d70250f0f632fd90b387a5827bf3269aa6d8f1585c46f0af244cb75c0
W="${SYNTAKS_WORK:-$HOME/syntaks-build}" NODE="${NODE:-/usr/local/bin/node}"
if [ "${1:-}" = --dry-run ] || { [ -n "${DRY_RUN:-}" ] && [ "$DRY_RUN" != 0 ]; }; then
  echo "[dry-run] rust $TC; clone syntaks $REV into $W; fetch cnet023.nnue (sha256 $NET_SHA); cargo build --release; TEI smoke test; install /opt/syntaks/syntaks"; exit 0
fi
mkdir -p "$W"; cd "$W"
rustup toolchain list | grep -q "^$TC" || rustup toolchain install --profile minimal "$TC"
[ -d src/.git ] || git clone -q https://github.com/Ciekce/syntaks.git src
(cd src && { git cat-file -e "$REV^{commit}" 2>/dev/null || git fetch -q origin; } && git checkout -q -f "$REV" && git clean -qfd -e target)
if [ ! -f cnet023.nnue ]; then
  curl -sSfL -o net.part https://github.com/Ciekce/syntaks-nets/releases/download/cnet023/cnet023.nnue
  echo "$NET_SHA  net.part" | sha256sum -c - >/dev/null; mv net.part cnet023.nnue
fi
echo "$NET_SHA  cnet023.nnue" | sha256sum -c - >/dev/null
(cd src && EVALFILE="$W/cnet023.nnue" RUSTFLAGS="-C target-cpu=native" nice rustup run "$TC" cargo build --release)
"$NODE" "$HERE/tei-smoke.mjs" "$W/src/target/release/syntaks"
sudo -n install -d -m 755 /opt/syntaks
sudo -n install -m 755 "$W/src/target/release/syntaks" /opt/syntaks/syntaks.new
sudo -n mv /opt/syntaks/syntaks.new /opt/syntaks/syntaks
echo "syntaks: $(sha256sum /opt/syntaks/syntaks | cut -c1-12) at /opt/syntaks/syntaks ($REV, cnet023)"
