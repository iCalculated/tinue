#!/bin/sh
# Syntaks (Ciekce, MIT) with the cnet023 net (Ciekce, shipped with his OK, 2026-11-15) for the browser:
# wasm32-wasip1 + SIMD128, single-threaded (syntaks-wasm.patch: the search runs inline; TEI lines in through the
# exported tk_command, output on stdout). public/syntaks/worker.js runs it in a Web Worker with a tiny WASI shim.
#   sh wasm/syntaks/build.sh        -> public/syntaks/syntaks.wasm (gitignored; build-static.sh builds it if missing)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
REV=4f224c9                      # upstream "new net (#203)": the commit crux's syntaks-final is built from
NET_SHA=329f2e6d70250f0f632fd90b387a5827bf3269aa6d8f1585c46f0af244cb75c0
SRC="$HERE/.src"                 # gitignored checkout
OUT="$ROOT/public/syntaks/syntaks.wasm"
TC=1.100.0                       # Syntaks uses features stabilised after 1.91 (cfg_select, if-let guards, ...)
rustup target list --installed --toolchain "$TC" | grep -q wasm32-wasip1 || rustup target add wasm32-wasip1 --toolchain "$TC"
if [ ! -d "$SRC/.git" ]; then git clone -q https://github.com/Ciekce/syntaks.git "$SRC"; fi
cd "$SRC"
git fetch -q origin 2>/dev/null || true
git checkout -q -f "$REV" && git clean -qfd
git apply "$HERE/syntaks-wasm.patch"
# cdylib for the exports; the atomic-wait stand-in (no WASI backend upstream)
cat >> Cargo.toml <<EOT

[lib]
crate-type = ["rlib", "cdylib"]

[patch."https://github.com/Ciekce/atomic-wait"]
atomic-wait = { path = "$HERE/atomic-wait-stub" }

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
EOT
NET="$HERE/.src-net/cnet023.nnue"
if [ ! -f "$NET" ]; then # (downloaded beside it and moved into place once it checks out, so a cut download can't stick)
  mkdir -p "$HERE/.src-net"
  curl -sSfL -o "$NET.part" "https://github.com/Ciekce/syntaks-nets/releases/download/cnet023/cnet023.nnue"
  echo "$NET_SHA  $NET.part" | shasum -a 256 -c - >/dev/null
  mv "$NET.part" "$NET"
fi
echo "$NET_SHA  $NET" | shasum -a 256 -c - >/dev/null
EVALFILE="$NET" RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint,+sign-ext" \
  nice cargo +"$TC" build --release --lib --target wasm32-wasip1
mkdir -p "$(dirname "$OUT")"
cp target/wasm32-wasip1/release/syntaks.wasm "$OUT"
ls -l "$OUT"
