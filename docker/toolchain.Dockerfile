# The Solatel build toolchain.
#
# This machine has no MSVC linker, so Rust runs in a container rather than on
# the host. That also means the server is built on the same Linux image it will
# eventually be deployed on.

FROM rust:1-bookworm

# cmake builds `basisu`, the encoder for the photographs' KTX2
# (scripts/build-basisu.sh). The window-system and sound headers that used to
# be here were for the Bevy client this replaced, which is long gone.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        cmake \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown

# Must match the `wasm-bindgen` version Cargo.lock pins.
# `./x client` re-checks this at build time and fails loudly if they diverge.
ARG WASM_BINDGEN_VERSION=0.2.128
RUN cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked

WORKDIR /work
