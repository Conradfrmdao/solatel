#!/usr/bin/env bash
# Solatel task runner.
#
# The Rust toolchain lives in a container (this machine has no MSVC linker, and
# the server ships on Linux anyway). Every command below is the same command you
# would run locally, just wrapped so it runs in that container.
#
#   ./x image            build the toolchain image (first-time setup)
#   ./x sim              build the shared simulation to wasm for the client
#   ./x maps             regenerate the collision tables from assets/maps
#   ./x client           build the browser client into web/dist
#   ./x watch            rebuild the client's JavaScript on every change
#   ./x server           run the game server (every map, every table)
#   ./x test             run the workspace test suite
#   ./x ledger           run the ledger invariant tests (throwaway postgres)
#   ./x treasury         set up or inspect the devnet treasury
#   ./x pay [memo sol]   send a devnet deposit with a memo (no args: set up)
#   ./x check            clippy + rustfmt
#   ./x db               open a psql shell on DATABASE_URL
#   ./x sh               shell inside the toolchain container
set -euo pipefail

# Git Bash rewrites container-side paths like /work into Windows paths unless
# this is set. Host-side paths are converted explicitly below.
export MSYS_NO_PATHCONV=1

IMAGE=solatel-toolchain
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v cygpath >/dev/null 2>&1; then
    HOSTDIR="$(cygpath -w "$ROOT")"
else
    HOSTDIR="$ROOT"
fi

# target/ and the cargo registry live in named volumes rather than on the bind
# mount: Rust build directories are enormous and painfully slow over a Windows
# bind mount. Build *outputs* we care about are written into web/dist, which is
# on the mount and therefore visible from the host.
docker_run() {
    docker run --rm \
        -v "${HOSTDIR}:/work" \
        -v solatel-target:/work/target \
        -v solatel-cargo-registry:/usr/local/cargo/registry \
        -w /work \
        "$@"
}

ensure_image() {
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        echo ">> toolchain image not found; building it (this takes a few minutes, once)"
        cmd_image
    fi
}

require_env() {
    if [ ! -f "$ROOT/.env" ]; then
        echo "No .env file found. Copy .env.example to .env and set DATABASE_URL." >&2
        exit 1
    fi
}

cmd_image() {
    # HOSTDIR, not ROOT: MSYS_NO_PATHCONV above stops Git Bash rewriting paths
    # on the way to docker, which is what the -v flags below need - but it means
    # a POSIX $ROOT reaches the Windows docker client unconverted, and it
    # answers "path /c/projects/solatel not found".
    docker build -f "${HOSTDIR}/docker/toolchain.Dockerfile" -t "$IMAGE" "$@" "${HOSTDIR}"
}

# The client is JavaScript now, so a build has three parts in two places: the
# shared simulation compiles to wasm in the container, esbuild bundles the
# JavaScript on the host, and the models are copied in. Only the first needs
# Rust, which is why it is the only one that pays for a container.
cmd_sim() {
    ensure_image
    docker_run "$IMAGE" bash scripts/build-sim.sh
    # Verify the module is actually loadable. A build can succeed and still
    # emit a wasm the browser refuses to instantiate.
    #
    # HOSTDIR here, for the same reason as cmd_image: this python is the
    # Windows one, and MSYS_NO_PATHCONV leaves it holding "/c/projects/..."
    # which it resolves as "C:\c\projects\..." and cannot find.
    python "${HOSTDIR}/scripts/check-wasm.py" "${HOSTDIR}/client/generated/solatel_sim_bg.wasm"
}

# Collision is derived from the same models the client draws, on the host:
# it is numpy, not Rust, and putting it in the container would mean a second
# toolchain image for one script.
cmd_maps() {
    python "${HOSTDIR}/scripts/derive-maps.py" "$@"
}

cmd_client() {
    cmd_sim
    ensure_node_modules
    echo ">> bundling the client"
    # HOSTDIR: npm is the Windows one, and MSYS_NO_PATHCONV leaves a POSIX
    # path unconverted, which it reads as "C:\c\projects\...".
    npm --prefix "${HOSTDIR}/client" run build
    docker_run "$IMAGE" bash scripts/copy-assets.sh
    echo ">> client built into web/dist"
}

cmd_watch() {
    ensure_node_modules
    npm --prefix "${HOSTDIR}/client" run watch
}

ensure_node_modules() {
    if [ ! -d "$ROOT/client/node_modules" ]; then
        echo ">> installing client dependencies"
        npm --prefix "${HOSTDIR}/client" install --no-audit --no-fund
    fi
}

cmd_server() {
    ensure_image
    require_env
    if [ ! -f "$ROOT/web/dist/index.html" ]; then
        echo ">> web/dist is empty; building the client first"
        cmd_client
    fi
    # The matchmaking knobs are forwarded from the host when set, so that
    #
    #     SOLATEL_MATCH_FLOOR=1 SOLATEL_QUEUE_WAIT=3 ./x server
    #
    # works the way it reads - which is what testing alone needs. They are
    # per-run choices rather than configuration; everything else comes from
    # .env. There is no map to choose: the server runs every map at once.
    local forward=()
    for name in SOLATEL_MATCH_FLOOR SOLATEL_QUEUE_WAIT; do
        if [ -n "${!name:-}" ]; then forward+=(-e "$name=${!name}"); fi
    done
    # A terminal only when there is one, so a script can run the server in
    # the background too.
    local tty=()
    if [ -t 0 ]; then tty=(-it); fi
    docker_run --env-file "${HOSTDIR}/.env" "${forward[@]}" \
        -p 8080:8080 "${tty[@]}" "$IMAGE" \
        cargo run -p solatel-server "$@"
}

cmd_test() {
    ensure_image
    docker_run "$IMAGE" cargo test --workspace "$@"
}

cmd_check() {
    ensure_image
    docker_run "$IMAGE" bash -c \
        'cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings'
}

cmd_treasury() {
    require_env
    ensure_image
    docker_run --env-file "${HOSTDIR}/.env" "$IMAGE"         cargo run -q -p solatel-server -- treasury
}

cmd_pay() {
    require_env
    ensure_image
    docker_run --env-file "${HOSTDIR}/.env" "$IMAGE" \
        cargo run -q -p solatel-server -- pay "$@"
}

cmd_ledger() {
    bash "$ROOT/scripts/test-ledger.sh"
}

cmd_db() {
    require_env
    # shellcheck disable=SC1091
    set -a; . "$ROOT/.env"; set +a
    docker run --rm -it postgres:17-alpine psql "$DATABASE_URL" "$@"
}

cmd_sh() {
    ensure_image
    docker_run -it "$IMAGE" bash
}

case "${1:-}" in
    image)  shift; cmd_image "$@" ;;
    sim)    shift; cmd_sim "$@" ;;
    maps)   shift; cmd_maps "$@" ;;
    client) shift; cmd_client "$@" ;;
    watch)  shift; cmd_watch "$@" ;;
    server) shift; cmd_server "$@" ;;
    test)   shift; cmd_test "$@" ;;
    treasury) shift; cmd_treasury "$@" ;;
    pay)    shift; cmd_pay "$@" ;;
    ledger) shift; cmd_ledger "$@" ;;
    check)  shift; cmd_check "$@" ;;
    db)     shift; cmd_db "$@" ;;
    sh)     shift; cmd_sh "$@" ;;
    *)
        sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
esac
