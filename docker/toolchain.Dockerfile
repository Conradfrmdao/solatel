# The Solatel build toolchain.
#
# This machine has no MSVC linker, so Rust runs in a container rather than on
# the host. That also means the server is built on the same Linux image it will
# eventually be deployed on.

FROM rust:1-bookworm

# Needed only by native (non-wasm) builds of Bevy, which is what `cargo test
# --workspace` produces. The wasm client does not need them, but without them
# running the test suite fails with a confusing linker error.
#
# The window-system headers are here for the same reason and are just as
# unobvious: winit builds its X11 *and* Wayland backends on Linux whether or not
# anything will ever open a window, so `cargo test` on the client crate fails in
# a dependency's build script - "Package 'wayland-client' ... not found" - long
# before any test runs. Nothing in this image displays anything; it only has to
# link.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libasound2-dev \
        libudev-dev \
        libwayland-dev \
        libxkbcommon-dev \
        libx11-dev \
        libxcursor-dev \
        libxi-dev \
        libxrandr-dev \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown

# Must match the pinned `wasm-bindgen` dependency in solatel-client/Cargo.toml.
# `./x client` re-checks this at build time and fails loudly if they diverge.
ARG WASM_BINDGEN_VERSION=0.2.128
RUN cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked

WORKDIR /work
