#!/usr/bin/env bash
# Render a Playwright demo: webm -> mp4 (CFR, web-safe).
# Usage:
#   ./render.sh <dir-with-page@*.webm> <out.mp4>
# Example:
#   ./render.sh tmp/feat-demo tmp/feat-demo/demo.mp4
set -euo pipefail

DIR="${1:?dir with page@*.webm}"
OUT="${2:?output mp4 path}"
WIDTH="${WIDTH:-1440}"
FPS="${FPS:-30}"

# Playwright 1.5x writes the video as <hash>.webm (no page@ prefix)
WEBM="$(find "$DIR" -maxdepth 1 -name '*.webm' | head -1)"
[ -n "$WEBM" ] || { echo "no *.webm in $DIR" >&2; exit 1; }

ffmpeg -y -loglevel error -i "$WEBM" \
  -vf "scale=${WIDTH}:-2,fps=${FPS}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$OUT"

echo "wrote $OUT"
