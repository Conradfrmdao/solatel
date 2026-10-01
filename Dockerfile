# The Solatel server, with the client it serves, as one image.
#
#   docker build -t solatel .
#   docker run --env-file solatel.env -p 8080:8080 solatel
#
# Configuration is the environment and nothing else: no secret is baked into
# the image, and `.env.example` lists every variable. See
# `documents/RUNBOOK.md` for running it.
#
# Three stages. Rust builds the server and the shared simulation (to wasm,
# for the client's prediction); Node bundles the client around that wasm; the
# last stage is a slim Debian with the binary, the bundle and nothing to
# build with. Migrations are compiled into the binary by `sqlx::migrate!` and
# applied when the server starts.

# ---- Rust: the server, and the simulation the client predicts with ----------
FROM rust:1-bookworm AS rust
WORKDIR /src

# The toolchain file asks for stable with the wasm target; rustup reads it on
# the first cargo call. wasm-bindgen's CLI must be the exact version the lock
# file pins, or the module fails to instantiate in the browser with an error
# that names something else - so it is read from the lock, not typed here.
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
RUN rustup show active-toolchain \
 && version="$(awk '/^name = "wasm-bindgen"$/{f=1;next} f&&/^version = /{gsub(/"/,"",$3);print $3;exit}' Cargo.lock)" \
 && cargo install wasm-bindgen-cli --version "$version" --locked

COPY crates crates
COPY migrations migrations
COPY scripts/build-sim.sh scripts/build-sim.sh
RUN cargo build --release --locked -p solatel-server \
 && bash scripts/build-sim.sh

# ---- Node: the client bundle -------------------------------------------------
FROM node:22-bookworm-slim AS client
WORKDIR /src
COPY client/package.json client/package-lock.json client/
# Dev dependencies included: esbuild is one. Puppeteer comes as `-core`,
# which downloads no browser.
RUN npm --prefix client ci --no-audit --no-fund
COPY client client
COPY --from=rust /src/client/generated client/generated
COPY assets assets
# Publishes every file under a name hashed from its contents, with brotli and
# gzip copies beside it - a minute or so of compression, once per image.
RUN npm --prefix client run build

# ---- The image that runs -----------------------------------------------------
FROM debian:bookworm-slim
# Certificates for the database's TLS and the Solana RPC; nothing else.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /app solatel
WORKDIR /app
COPY --from=rust /src/target/release/solatel-server /app/solatel-server
COPY --from=client /src/web/dist /app/web
ENV WEB_DIR=/app/web \
    BIND_ADDR=0.0.0.0:8080 \
    RUST_LOG=solatel_server=info,tower_http=warn,info
USER solatel
EXPOSE 8080
# SIGTERM is what `docker stop` and every orchestrator send. The server shuts
# down on it and releases the escrow lease, so the next one takes over at
# once; give it a few seconds' grace (`--stop-timeout`, or the platform's
# equivalent) rather than killing it outright.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/solatel-server"]
