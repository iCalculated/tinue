#!/bin/sh
# Build the static client for shydrie.xyz/tinue/ (GitHub Pages) and stage it in the site repo.
# usage: SITE=<dir> scripts/build-static.sh [--dry-run] [--all-stubs] [API_URL]
#   NAME=<dir name>  the directory under SITE and on the site (default tinue). The beta is NAME=tinue-beta
#                    (scripts/build-beta.sh sets it, with STUBS=none and BETA).
#   STUBS=none       no per-puzzle pages (71k files): the page then keeps puzzles on hash routes (#/puzzle/<id>),
#                    so a reload works without them. data/tinue.db is not needed.
#   BETA=<label>     marks the build as a beta (a badge with the label, noindex).
#   ANALYSIS=1       the analysis view after a puzzle (engine lines, arrows, candidate chips: app.js ANALYSIS). Off by
#                    default, so the production build hasn't it; scripts/build-beta.sh turns it on.
#   --dry-run    check the inputs, print every destructive step, write nothing (also DRY_RUN=1)
#   --all-stubs  rewrite every puzzle page (also STUBS=all); by default the old puzzle/ is kept across the build and
#                only pages whose content changed are rewritten (scripts/build-stubs.mjs): the same output, fewer writes
#   DOMAIN=tinue.me  the build for its own domain instead of shydrie.xyz/tinue/ (off by default): the page's address is
#                    https://$DOMAIN/ and the API https://api.$DOMAIN, the page takes players over from the old address
#                    (moved/import.js; OLD_URL, default https://shydrie.xyz/tinue/), and CNAME, .nojekyll and 404.html are
#                    written. Published with PAGES=$SITE/tinue scripts/publish-site.sh tinue.
#   API default: https://tinue-api.shydrie.xyz (crux through Cloudflare Tunnel). Every puzzle page's og:image is built
#   from it too, so a build with another API rewrites all of them.
#   Rollback to the Funnel: SITE=$HOME/Projects/site sh scripts/build-static.sh https://crux.tail5ed24.ts.net:8443
#   SITE=$HOME/Projects/site  stages a real deploy in the site repo (then scripts/publish-site.sh)
#   SITE=<scratch dir>        a test build that touches nothing live
# There is no default: several sessions build tinue, and a test build into the real site repo once wiped a deploy
# that was half-written. A lock stops two builds writing into the same SITE at once.
set -e
cd "$(dirname "$0")/.."
DRY="${DRY_RUN:-}"; [ "$DRY" = 0 ] && DRY=
while [ $# -gt 0 ]; do case "$1" in --dry-run) DRY=1; shift ;; --all-stubs) STUBS=all; shift ;; *) break ;; esac; done
export STUBS
DB="${TINUE_DB:-data/tinue.db}" # the puzzle pages' source (build-stubs.mjs reads the same TINUE_DB)
NAME="${NAME:-tinue}"
case "$NAME" in ''|*/*|.*) echo "build-static: NAME must be a plain directory name" >&2; exit 2 ;; esac
if [ -n "$DOMAIN" ]; then
  case "$DOMAIN" in *[!a-z0-9.-]*|-*|.*) echo "build-static: DOMAIN must be a plain host name" >&2; exit 2 ;; esac
  [ -z "$BETA" ] && [ "$STUBS" != none ] || { echo "build-static: DOMAIN is the production build (no BETA, no STUBS=none)" >&2; exit 2; }
  SITE_URL="${SITE_URL:-https://$DOMAIN/}"; OLD_URL="${OLD_URL:-https://shydrie.xyz/tinue/}"
fi
SITE_URL="${SITE_URL:-https://shydrie.xyz/$NAME/}"
API="${1:-https://${DOMAIN:+api.$DOMAIN}}"; [ "$API" != https:// ] || API=https://tinue-api.shydrie.xyz
if [ -z "$SITE" ]; then
  echo "build-static: set SITE (SITE=\$HOME/Projects/site for a deploy, or a scratch dir for a test build)" >&2; exit 2
fi
if [ -n "$DRY" ]; then
  [ "$STUBS" = none ] || [ -f "$DB" ] || { echo "$DB is missing (the puzzle pages need it)" >&2; exit 1; }
  OUT="$SITE/$NAME"; W=public/syntaks/syntaks.wasm
  { [ -f "$W" ] && [ "$W" -nt wasm/syntaks/build.sh ] && [ "$W" -nt wasm/syntaks/syntaks-wasm.patch ]; } || echo "[dry-run] sh wasm/syntaks/build.sh ($W missing or older than its recipe)"
  echo "[dry-run] lock $SITE/.tinue-build.lock"
  [ "$STUBS" = all ] || [ ! -d "$OUT/puzzle" ] || echo "[dry-run] mv $OUT/puzzle $SITE/.tinue-stubs-keep (kept across the rebuild)"
  echo "[dry-run] rm -rf $OUT (all but .git); copy public/, shared/, tiltak/, syntaks/ into it; sed -i the ENGINE hash, preconnect and ?v= stamps"
  [ -z "$DOMAIN" ] || echo "[dry-run] for $SITE_URL: moved/import.js (from $OLD_URL) into $OUT/index.html; write CNAME ($DOMAIN), .nojekyll, 404.html"
  echo "[dry-run] write $OUT/config.js (API $API, analysis view $([ "${ANALYSIS:-0}" = 1 ] && echo on || echo off)), $OUT/version.json"
  [ "$STUBS" = none ] && { echo "[dry-run] no puzzle pages (STUBS=none)"; exit 0; }
  [ "$STUBS" = all ] || [ ! -d "$OUT/puzzle" ] || echo "[dry-run] mv $SITE/.tinue-stubs-keep $OUT/puzzle"
  [ -d "$OUT/puzzle" ] && [ "$STUBS" != all ] && node --no-warnings scripts/build-stubs.mjs "$OUT" "$SITE_URL" "$API" --dry-run \
    || echo "[dry-run] node scripts/build-stubs.mjs $OUT $SITE_URL $API (every page)"
  exit 0
fi
mkdir -p "$SITE"
LOCK="$SITE/.tinue-build.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  PID=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo "build-static: another build (pid $PID) is writing to $SITE; wait for it" >&2; exit 3; fi
  rm -rf "$LOCK" && mkdir "$LOCK" # stale lock from a build that died
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM
OUT="$SITE/$NAME"
# Everything the build needs is checked before the old tinue/ is cleared, so a failed build leaves the site as it was.
# The puzzle pages (build-stubs) read data/tinue.db, which isn't in git (a fresh worktree has none).
[ "$STUBS" = none ] || [ -f "$DB" ] || { echo "$DB is missing (the puzzle pages need it); $OUT left as it was" >&2; exit 1; }
case "${TINUE_ESBUILD:-none}" in none) ;; *) [ -x "$TINUE_ESBUILD" ] || { echo "TINUE_ESBUILD=$TINUE_ESBUILD is not a program; $OUT left as it was" >&2; exit 1; } ;; esac # (scripts/shrink.mjs)
# Syntaks in the browser (play-on's defender): built from source when missing or older than its recipe
# (wasm/syntaks/build.sh, ~2 min). One that doesn't load (a copy cut short) is rebuilt once. Its URL carries the
# binary's hash, so browsers keep it until it changes.
W=public/syntaks/syntaks.wasm
wasm_build() { sh wasm/syntaks/build.sh || { echo "syntaks.wasm build failed; $OUT left as it was" >&2; exit 1; }; }
wasm_ok() { node -e "new WebAssembly.Module(require('fs').readFileSync('$W'))"; }
{ [ -f "$W" ] && [ "$W" -nt wasm/syntaks/build.sh ] && [ "$W" -nt wasm/syntaks/syntaks-wasm.patch ]; } || wasm_build
wasm_ok || { echo "$W isn't a valid module; rebuilding it" >&2; rm -f "$W"; wasm_build; wasm_ok; } \
  || { echo "$W isn't a valid module; $OUT left as it was" >&2; exit 1; }
# The puzzle pages are kept across the rebuild (build-stubs.mjs rewrites only the changed ones and removes the rest);
# a .tinue-stubs-keep left by a build that died is stale (and outside tinue/, so never published): start fresh then.
KEEP="$SITE/.tinue-stubs-keep"; rm -rf "$KEEP"
[ "$STUBS" != all ] && [ "$STUBS" != none ] && [ -d "$OUT/puzzle" ] && mv "$OUT/puzzle" "$KEEP"
# A .git in $OUT (the site repo holds it as a submodule) stays: it says where the built branch is.
mkdir -p "$OUT" && find "$OUT" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + && mkdir -p "$OUT/shared"
[ -d "$KEEP" ] && mv "$KEEP" "$OUT/puzzle"
cp public/index.html public/app.js public/api.js public/next.js public/board.js public/board-kit.js public/ninja.js public/board.css public/style.css public/engine.js public/engine-worker.js public/tiltak.js public/playon.js public/playon-copy.js public/defend.js public/freeplay.js public/busy.js public/lines.js public/settings.js public/prefsync.js public/ninja-look.js public/sound.js public/sound-lab.js public/outbox.js public/results.js public/pagesym.js public/rush.js public/rush-rules.js public/rush-look.js public/rush-theme.js public/syntaks.js public/analysis.js public/og.png public/apple-touch-icon.png public/icon-192.png public/icon-512.png public/icon-maskable-512.png public/manifest.webmanifest "$OUT/"
# the analysis view's stylesheet: app.js loads it only when the view is on (ANALYSIS), but names it either way, so it is
# copied either way (the module check below follows app.js's new URL('./…'))
cp public/analysis.css "$OUT/"
mkdir -p "$OUT/vendor" && cp public/vendor/* "$OUT/vendor/" # lz-string's compressor (MIT, licence beside it): PTN Ninja links
mkdir -p "$OUT/tiltak" && cp public/tiltak/worker.js public/tiltak/tiltak_wasm.js public/tiltak/tiltak_wasm_bg.wasm public/tiltak/NOTICE public/tiltak/COPYING "$OUT/tiltak/"
mkdir -p "$OUT/syntaks" && cp public/syntaks/worker.js "$W" public/syntaks/NOTICE.txt "$OUT/syntaks/"
sed -i '' "s/^const ENGINE = '[^']*';/const ENGINE = '$(shasum -a 256 "$W" | cut -c1-12)';/" "$OUT/syntaks.js"
cp LICENSE "$OUT/LICENSE.txt"
cp shared/tak.js shared/themes.js shared/rating.js shared/glicko.js shared/pns.js shared/ptn.js shared/judge.js shared/sym.js "$OUT/shared/"
printf "// Built %s — API at %s.\nwindow.TINUE_API = '%s';\n" "$(date +%Y-%m-%d)" "$API" "$API" > "$OUT/config.js"
# Open the TLS connection to the API while the page's modules download (a cold handshake to the API's proxy costs up to ~1 s).
sed -i '' -E "s#(<link rel=\"icon\")#<link rel=\"preconnect\" href=\"$API\" crossorigin=\"use-credentials\">\\1#" "$OUT/index.html"
# Cache-bust: GitHub Pages lets browsers cache files ~10 min, so stamp every script/style URL per build.
V=$(date +%s)
# Build stamp: an open tab compares window.TINUE_BUILD with version.json (fetched uncached) to notice a newer build
# (app.js, "a newer build"): between puzzles it reloads, mid-puzzle it shows a bar.
# version.json also names the commit built (read by people and scripts, not by the page: app.js reads only v).
SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)
[ -n "$(git status --porcelain --untracked-files=no -- public shared 2>/dev/null)" ] && SHA="$SHA-dirty"
printf '{"v":%s,"sha":"%s"}\n' "$V" "$SHA" > "$OUT/version.json"
printf "window.TINUE_BUILD = %s;\n" "$V" >> "$OUT/config.js"
# The analysis view: on only when asked for (the beta); the production build says off in so many words.
if [ "${ANALYSIS:-0}" = 1 ]; then printf "window.TINUE_ANALYSIS = true;\n" >> "$OUT/config.js"; else printf "window.TINUE_ANALYSIS = false;\n" >> "$OUT/config.js"; fi
# No puzzle pages: the page keeps puzzles on hash routes (app.js STUBS). A beta: its badge, and kept out of search.
[ "$STUBS" = none ] && printf "window.TINUE_STUBS = false;\n" >> "$OUT/config.js"
if [ -n "$BETA" ]; then
  printf "window.TINUE_BETA = '%s';\n" "$(printf %s "$BETA" | tr -cd 'A-Za-z0-9@._/ -')" >> "$OUT/config.js"
  sed -i '' -E 's#(<link rel="icon")#<meta name="robots" content="noindex">\1#' "$OUT/index.html"
fi
# Its own domain: the address in the page's tags and links, the import of players from the old address (first in <head>,
# inline: it takes the payload off the address before anything else runs), and what GitHub Pages needs.
if [ -n "$DOMAIN" ]; then
  printf "window.TINUE_OLD = '%s';\n" "$OLD_URL" >> "$OUT/config.js"
  DOMAIN="$DOMAIN" SITE_URL="$SITE_URL" OLD_URL="$OLD_URL" node -e "
    const fs = require('fs'), out = process.argv[1], { DOMAIN, SITE_URL, OLD_URL } = process.env;
    const js = fs.readFileSync('moved/import.js', 'utf8').replaceAll('__OLD__', OLD_URL);
    const html = fs.readFileSync(out + '/index.html', 'utf8').replaceAll('https://shydrie.xyz/tinue/', SITE_URL), at = '<meta charset=\"utf-8\">\n';
    if (html.split(at).length !== 2 || js.includes('</script')) throw new Error('index.html has no place for moved/import.js');
    fs.writeFileSync(out + '/index.html', html.replace(at, () => at + '<script>\n' + js + '</script>\n'));
    fs.copyFileSync('moved/404.html', out + '/404.html');
    fs.writeFileSync(out + '/CNAME', DOMAIN + '\n'); fs.writeFileSync(out + '/.nojekyll', '');" "$OUT"
fi
# Every local .js/.css href/src in index.html (styles, scripts, modulepreloads); absolute and data: URLs are skipped.
sed -i '' -E "s#(href|src)=\"([A-Za-z0-9_./-]+\.(js|css))\"#\1=\"\2?v=$V\"#g" "$OUT/index.html"
# Every module's local imports, in every copied module: one missed would be fetched under two addresses (with and without
# ?v) and run as two instances. A file with nothing to stamp comes out as it went in.
for f in "$OUT"/*.js "$OUT"/shared/*.js "$OUT"/tiltak/*.js; do sed -i '' -E -e "s#from '(\./[^']+\.js)'#from '\1?v=$V'#" -e "s#import\('(\./[^']+\.js)'\)#import('\1?v=$V')#" "$f"; done
# Per-puzzle pages at puzzle/<id> so pasting a puzzle's address into Discord shows its board (scripts/build-stubs.mjs).
[ "$STUBS" = none ] || node --no-warnings scripts/build-stubs.mjs "$OUT" "$SITE_URL" "$API"
echo "staged $OUT (API $API). To publish: SITE=$SITE sh scripts/publish-site.sh $NAME"
# Fail the build if any module the page imports wasn't copied (the dev server serves everything, so it hides this).
node --input-type=module -e "
import fs from 'fs'; import path from 'path';
const root=process.argv[1]; const seen=new Set(); const missing=[];
function walk(f){ if(seen.has(f))return; seen.add(f); const src=fs.readFileSync(path.join(root,f),'utf8');
  for (const m of src.matchAll(/(?:from|new URL\(|import\()\s*'\.\/([^'?]+)/g)) { const t=path.normalize(path.join(path.dirname(f), m[1])); if(!fs.existsSync(path.join(root,t))) missing.push(f+' -> '+t); else if (t.endsWith('.js')) walk(t); } }
walk('app.js'); if (missing.length) { console.error('MISSING MODULES:', missing); process.exit(1); }" "$OUT"
# Lighter for the first visit: modules listed up front, minified, the styles in the page (last: everything above reads the source).
node scripts/shrink.mjs "$OUT"
