#!/usr/bin/env bash
# Builds the shared movement simulation to wasm for the JavaScript client.
# Runs INSIDE the toolchain container; use ./x sim from the host.
#
# This is the one piece of the client that is still Rust, and deliberately so:
# it is the same `solatel-protocol::sim` the server runs, so the client's
# prediction cannot drift from the server's authority. Everything else about
# the client - rendering, input, assets - is JavaScript.
set -euo pipefail

OUT=client/generated

echo ">> building the shared simulation for wasm32"
cargo build -p solatel-sim-wasm --target wasm32-unknown-unknown --release

# The CLI that generates the glue and the crate compiled into the wasm must be
# the same version, or the module fails to instantiate in the browser with an
# error that does not name the real cause.
locked_version() {
    awk '/^name = "wasm-bindgen"$/{found=1; next} found && /^version = /{gsub(/[",]/,"",$3); print $3; exit}' Cargo.lock
}
LOCKED="$(locked_version)"
CLI="$(wasm-bindgen --version | awk '{print $2}')"
if [ -n "$LOCKED" ] && [ "$LOCKED" != "$CLI" ]; then
    echo "wasm-bindgen version mismatch: Cargo.lock has $LOCKED, CLI is $CLI" >&2
    echo "Rebuild the toolchain image with:" >&2
    echo "  ./x image --build-arg WASM_BINDGEN_VERSION=$LOCKED" >&2
    exit 1
fi

WASM=target/wasm32-unknown-unknown/release/solatel_sim_wasm.wasm
if [ ! -f "$WASM" ]; then
    echo "expected wasm artifact not found at $WASM" >&2
    exit 1
fi

echo ">> generating JS bindings (wasm-bindgen $CLI)"
rm -rf "$OUT"
mkdir -p "$OUT"
wasm-bindgen \
    --no-typescript \
    --target web \
    --out-dir "$OUT" \
    --out-name solatel_sim \
    "$WASM"

echo ">> simulation built into $OUT"
ls -lh "$OUT" | sed 's/^/   /'
