#!/bin/bash
# Readies a Claude Code on the web container for Solatel.
#
# On Conrad's Windows machine everything runs through ./x and a Docker
# toolchain image. The cloud container has no Docker daemon but has Rust,
# Node and Postgres 16 installed natively, so this installs what is missing
# and runs the tools directly. It does nothing anywhere else.
#
# Idempotent: every step checks before it acts, so a resumed session is fast.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

# ---- Rust: the wasm target, pinned by rust-toolchain.toml -------------------
rustup target add wasm32-unknown-unknown >/dev/null

# ---- wasm-bindgen: must match the version in Cargo.lock exactly -------------
# A mismatched CLI builds fine and then fails to instantiate in the browser
# with an error that does not name the cause (see scripts/build-sim.sh).
WB_VERSION="$(awk '/^name = "wasm-bindgen"$/{f=1;next} f&&/^version = /{gsub(/"/,"",$3);print $3;exit}' Cargo.lock)"
if [ "$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')" != "$WB_VERSION" ]; then
    echo ">> installing wasm-bindgen $WB_VERSION"
    tarball="wasm-bindgen-${WB_VERSION}-x86_64-unknown-linux-musl"
    if curl -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WB_VERSION}/${tarball}.tar.gz" \
        | tar -xz -C /tmp; then
        install -m 755 "/tmp/${tarball}/wasm-bindgen" "$HOME/.cargo/bin/wasm-bindgen"
        rm -rf "/tmp/${tarball}"
    else
        cargo install --locked wasm-bindgen-cli --version "$WB_VERSION"
    fi
fi

# ---- the client's npm packages ----------------------------------------------
# puppeteer-core downloads no browser; the drivers use the preinstalled
# Chromium at /opt/pw-browsers.
npm --prefix client install --no-audit --no-fund

# ---- a local Postgres for tests and a dev server ----------------------------
# Throwaway, inside this container. The server applies migrations itself on
# start. Only used when no DATABASE_URL was configured for the environment,
# so a Neon URL set in the environment settings always wins.
PG_BIN=/usr/lib/postgresql/16/bin
PG_DATA=/var/lib/postgresql/solatel
if [ -x "$PG_BIN/postgres" ]; then
    if [ ! -f "$PG_DATA/PG_VERSION" ]; then
        echo ">> creating a local postgres cluster"
        install -d -o postgres -g postgres "$PG_DATA"
        su postgres -c "$PG_BIN/initdb -D $PG_DATA -A trust -U postgres" >/dev/null
    fi
    if ! su postgres -c "$PG_BIN/pg_ctl -D $PG_DATA status" >/dev/null 2>&1; then
        su postgres -c "$PG_BIN/pg_ctl -D $PG_DATA -l $PG_DATA/server.log -o '-c listen_addresses=localhost' -w start" >/dev/null
    fi
    # User `solatel`, password `solatel`, owning database `solatel`: the
    # DATABASE_URL suggested for the environment settings points here.
    psql -h localhost -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='solatel'" | grep -q 1 \
        || psql -h localhost -U postgres -c "CREATE ROLE solatel LOGIN PASSWORD 'solatel'" >/dev/null
    psql -h localhost -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='solatel'" | grep -q 1 \
        || psql -h localhost -U postgres -c "CREATE DATABASE solatel OWNER solatel" >/dev/null
    if [ -z "${DATABASE_URL:-}" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
        echo 'export DATABASE_URL=postgres://solatel:solatel@localhost:5432/solatel' >> "$CLAUDE_ENV_FILE"
    fi
fi

# ---- the drivers' browser ----------------------------------------------------
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo 'export CHROME_PATH=/opt/pw-browsers/chromium' >> "$CLAUDE_ENV_FILE"
fi

echo ">> solatel cloud setup done"
