#!/usr/bin/env bash
# Copies the raw screenshots from docs/scripts/screenshots.spec.ts into
# docs/images/ as palette PNGs (ImageMagick), and fails if any is over 150 KB.
# Run from the repo root after the screenshots.
set -euo pipefail

raw=node_modules/.cache/somememos-docs/raw
out=docs/images
mkdir -p "$out"
for name in phone-import-roles phone-hot phone-note phone-sync-plan phone-sync-connected \
  desktop-search-breakdown desktop-editor desktop-publish; do
  convert "$raw/$name.png" -strip -colors 96 -define png:compression-level=9 "$out/$name.png"
  size=$(stat -c %s "$out/$name.png")
  echo "$out/$name.png $((size / 1024)) KB"
  if [ "$size" -gt 153600 ]; then
    echo "too large: $out/$name.png" >&2
    exit 1
  fi
done
du -ch "$out"/*.png | tail -1
