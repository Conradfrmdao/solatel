#!/usr/bin/env bash
# Builds `basisu`, the Basis Universal encoder that turns the photographs into
# KTX2 for scripts/fetch-photo-assets.mjs, and prints where it put it.
#
# From source, and from crates.io rather than a prebuilt binary: the
# `basis-universal-sys` crate vendors the upstream encoder (1.16) whole, its
# checksum is pinned below, and crates.io is reachable from every machine that
# builds this - the Docker toolchain (`./x sh`) and a cloud session alike.
# Needs cmake and a C++ compiler. Built once; a second run only prints the path.
set -euo pipefail

VERSION=0.3.1
SHA256=fd9bde5e9547958fb0e77d79fc7879edcf91d5e0c8e372ef8959916cf35e8506

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/target/basisu"
if [ -x "$OUT/basisu" ]; then
    echo "$OUT/basisu"
    exit 0
fi

mkdir -p "$OUT"
CRATE="$OUT/basis-universal-sys-$VERSION.crate"
curl -fsSL -o "$CRATE" "https://static.crates.io/crates/basis-universal-sys/basis-universal-sys-$VERSION.crate"
if ! echo "$SHA256  $CRATE" | sha256sum -c --status; then
    echo "basis-universal-sys $VERSION does not match its published checksum" >&2
    exit 1
fi
tar -xzf "$CRATE" -C "$OUT"
SRC="$OUT/basis-universal-sys-$VERSION/vendor/basis_universal"

cmake -S "$SRC" -B "$OUT/build" -DCMAKE_BUILD_TYPE=Release >"$OUT/build.log" 2>&1
cmake --build "$OUT/build" -j"$(nproc)" >>"$OUT/build.log" 2>&1 || {
    echo "basisu did not build; see $OUT/build.log" >&2
    exit 1
}
cp "$SRC/bin/basisu" "$OUT/basisu"
echo "$OUT/basisu"
