#!/bin/sh
# Build the Syntaks engine natively on the API host (github.com/Ciekce/syntaks, MIT): the same commit and net as
# wasm/syntaks/build.sh, for this machine's CPU. Run it as the login user from a copy of ops/. It is compiled and tried
# (ops/tei-smoke.mjs) by the account tinue-build, which has no sudo; only then does the login user install it.
#   sh ops/build-syntaks.sh [--dry-run]   -> /opt/syntaks/syntaks
set -eu
REV=4f224c9c347ff55f054f54c55eca8514bc7bc9cd TC=1.100.0 NET_SHA=329f2e6d70250f0f632fd90b387a5827bf3269aa6d8f1585c46f0af244cb75c0
NODE="${NODE:-/usr/local/bin/node}"
if [ "${1:-}" = --dry-run ] || { [ -n "${DRY_RUN:-}" ] && [ "$DRY_RUN" != 0 ]; }; then
  echo "[dry-run] as tinue-build: rust $TC; clone syntaks $REV; fetch cnet023.nnue (sha256 $NET_SHA); cargo build --release --locked; TEI smoke test; then install /opt/syntaks/syntaks"; exit 0
fi
if [ "${1:-}" != compile ]; then
  HERE=$(cd "$(dirname "$0")" && pwd); AS='sudo -n -H -u tinue-build'
  (cd / && $AS sh -s compile) < "$HERE/build-syntaks.sh" # (piped: that account can't read this home)
  B=/var/lib/tinue-build/src/target/release/syntaks
  (cd / && $AS "$NODE" --input-type=module - "$B") < "$HERE/tei-smoke.mjs"
  sudo -n install -d -m 755 /opt/syntaks
  sudo -n install -m 755 "$B" /opt/syntaks/syntaks.new
  sudo -n mv /opt/syntaks/syntaks.new /opt/syntaks/syntaks
  echo "syntaks: $(sha256sum /opt/syntaks/syntaks | cut -c1-12) at /opt/syntaks/syntaks ($REV, cnet023)"; exit 0
fi
cd "$HOME"
rustup toolchain list < /dev/null | grep -q "^$TC" || rustup toolchain install --profile minimal "$TC" < /dev/null
[ -d src/.git ] || git clone -q https://github.com/Ciekce/syntaks.git src < /dev/null
cd src
git cat-file -e "$REV^{commit}" 2>/dev/null || git fetch -q origin < /dev/null
git checkout -q -f --detach "$REV" && git clean -qfd -e target
[ "$(git rev-parse HEAD)" = $REV ] || { echo "syntaks: not at $REV" >&2; exit 1; }
cd ..
if [ ! -f cnet023.nnue ]; then
  curl -sSfL -o net.part https://github.com/Ciekce/syntaks-nets/releases/download/cnet023/cnet023.nnue
  echo "$NET_SHA  net.part" | sha256sum -c - >/dev/null; mv net.part cnet023.nnue
fi
echo "$NET_SHA  cnet023.nnue" | sha256sum -c - >/dev/null
cd src && EVALFILE="$HOME/cnet023.nnue" RUSTFLAGS="-C target-cpu=native" nice rustup run "$TC" cargo build --release --locked < /dev/null
