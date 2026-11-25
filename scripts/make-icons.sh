#!/bin/sh
# Regenerate the home-screen icons in public/ from scripts/icons/*.svg (artwork = the favicon in public/index.html).
# Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick).   sh scripts/make-icons.sh
set -e
cd "$(dirname "$0")/.."
S=scripts/icons
# apple-touch-icon: opaque RGB (iOS shows transparency as black)
rsvg-convert -w 180 -h 180 $S/apple-touch-icon.svg | magick - -strip -background '#262421' -alpha remove -alpha off \
  -define png:color-type=2 -define png:compression-level=9 public/apple-touch-icon.png
rsvg-convert -w 192 -h 192 $S/icon.svg | magick - -strip -define png:compression-level=9 public/icon-192.png
rsvg-convert -w 512 -h 512 $S/icon.svg | magick - -strip -define png:compression-level=9 public/icon-512.png
rsvg-convert -w 512 -h 512 $S/icon-maskable.svg | magick - -strip -background '#262421' -alpha remove -alpha off \
  -define png:compression-level=9 public/icon-maskable-512.png
/bin/ls -l public/apple-touch-icon.png public/icon-192.png public/icon-512.png public/icon-maskable-512.png
