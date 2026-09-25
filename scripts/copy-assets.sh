#!/usr/bin/env bash
# Copies runtime models into the web bundle.
#
# Separate from the JavaScript build because the two run in different places:
# esbuild runs on the host, and this only needs a shell. Creating an empty
# assets folder would be worse than none at all - the build would succeed and
# the client would die at load time on a 404 for a model it was told exists.
set -euo pipefail

OUT=web/dist

if [ ! -d assets ]; then
    echo "no assets/ directory at the workspace root" >&2
    exit 1
fi

echo ">> copying assets"
rm -rf "$OUT/assets"
mkdir -p "$OUT"
cp -r assets "$OUT/assets"
du -sh "$OUT/assets" | sed 's/^/   /'
