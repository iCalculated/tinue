#!/bin/sh
# Build THIS checkout (any branch, any clone or worktree) as the beta: shydrie.xyz/tinue-beta/, a second copy of the
# static client next to the real one, for looking at a change before it ships.
# usage: SITE=$HOME/Projects/site sh scripts/build-beta.sh [--dry-run] [API_URL]
#   then: SITE=$HOME/Projects/site sh scripts/publish-site.sh tinue-beta 'tinue-beta: <what>'
# What the beta is: the same page talking to the SAME production API, so sign-in, ratings and results are real (a
# puzzle solved on the beta is a rated result). It shares the browser's storage with the real page (same origin), so
# you are signed in as yourself. It has no per-puzzle pages (STUBS=none): puzzles stay on #/puzzle/<id>. It wears a
# "beta" badge naming the branch and commit, is marked noindex, and has the analysis view after a puzzle (ANALYSIS=1;
# the production build hasn't). Client changes only: a change that needs new
# server code can be looked at here only after that server code is deployed.
# In a clone or worktree public/syntaks/syntaks.wasm (not in git) is copied from the main checkout ($TINUE_MAIN,
# default ~/Projects/tinue) instead of being rebuilt, which takes minutes of compiling; if the branch changes the
# wasm recipe (wasm/syntaks/), build it on purpose first.
set -e
cd "$(dirname "$0")/.."
[ -n "$SITE" ] || { echo "build-beta: set SITE (SITE=\$HOME/Projects/site)" >&2; exit 2; }
MAIN="${TINUE_MAIN:-$HOME/Projects/tinue}"
W=public/syntaks/syntaks.wasm
if [ ! -f "$W" ] && [ -f "$MAIN/$W" ]; then cp "$MAIN/$W" "$W"; fi
[ -f "$W" ] && touch "$W" # newer than its recipe, so build-static does not start a compile
LABEL="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)@$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
[ -n "$(git status --porcelain --untracked-files=no -- public shared 2>/dev/null)" ] && LABEL="$LABEL-dirty"
NAME=tinue-beta STUBS=none BETA="$LABEL" ANALYSIS=1 SITE="$SITE" sh scripts/build-static.sh "$@"
