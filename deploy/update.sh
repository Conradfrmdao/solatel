#!/bin/bash
# Builds whatever main is and puts it live - but only when no match has money
# in it. Run every two minutes by solatel-update.timer through
# /usr/local/sbin/solatel-update, which fetches main and then runs this script
# as main has it, so a fix to this file reaches the server the way everything
# else does.
#
#   solatel-update            build main if it moved; switch when escrow is empty
#   solatel-update --now      switch even with matches running: they end, and
#                             their stakes settle as abandons (rake and all)
#   solatel-update --retry    build again a commit that failed before
#   update.sh configure       write the services, the timers and Caddy's
#                             configuration from this directory, and nothing else
#
# What it is doing is at https://<domain>/deploy.json, so it can be watched
# from outside the machine; the whole of the last build's output is in
# /var/lib/solatel/build.log.
#
# The layout (deploy/install.sh makes it):
#   /opt/solatel/src         main, as fetched; root's, and what this runs from
#   /opt/solatel/build       a copy the build user compiles in, so nothing a
#                            build runs can change what root runs next
#   /opt/solatel/releases/X  a built commit: the server, the client, the settings
#   /opt/solatel/current     the release being served
set -euo pipefail

ROOT=/opt/solatel
SRC=$ROOT/src
BUILD=$ROOT/build
RELEASES=$ROOT/releases
CURRENT=$ROOT/current
STATE=/var/lib/solatel
PUBLIC=$STATE/public
FAILED=$STATE/failed
BUILD_LOG=$STATE/build.log
BUILDER=solatel-build
BUILDER_HOME=/var/lib/solatel-build
NODE_DIR=/opt/node
NODE_MAJOR=22
HEALTH=http://127.0.0.1:8080/health
# How long a new server gets to answer healthy before it is rolled back. It
# can wait up to ninety seconds for the escrow lease when its predecessor did
# not hand it over.
HEALTHY_WITHIN=150
SELF=$(readlink -f "${BASH_SOURCE[0]}")

commit=$(git -C "$SRC" rev-parse --short=12 HEAD)

live_commit() {
    if [ -L "$CURRENT" ]; then basename "$(readlink -f "$CURRENT")"; fi
}

# What deploy.json says. A failure carries the end of the log that explains it.
status() {
    local state=$1 message=$2 log=${3:-} lines='[]'
    if [ -n "$log" ] && [ -s "$log" ]; then
        lines=$(tail -n 80 "$log" | sed 's/\x1b\[[0-9;]*m//g' | jq -R . | jq -s .)
    fi
    mkdir -p "$PUBLIC"
    jq -n --arg state "$state" --arg message "$message" --arg commit "$commit" \
        --arg live "$(live_commit)" --arg at "$(date -u +%FT%TZ)" --argjson log "$lines" \
        '{state: $state, message: $message, commit: $commit, live: $live, at: $at}
         + (if ($log | length) > 0 then {log: $log} else {} end)' >"$PUBLIC/deploy.json.part"
    chmod 644 "$PUBLIC/deploy.json.part"
    mv "$PUBLIC/deploy.json.part" "$PUBLIC/deploy.json"
    echo ">> $state: $message"
}

current_state() {
    jq -r '.state // empty' "$PUBLIC/deploy.json" 2>/dev/null || true
}

# ---- configuration -----------------------------------------------------------

configure() {
    local changed=0 unit name domain
    for unit in "$SRC"/deploy/systemd/*; do
        name=$(basename "$unit")
        if ! cmp -s "$unit" "/etc/systemd/system/$name"; then
            install -m 644 "$unit" "/etc/systemd/system/$name"
            changed=1
        fi
    done
    if [ "$changed" = 1 ]; then systemctl daemon-reload; fi
    systemctl enable --quiet solatel.service solatel-update.timer solatel-backup.timer
    systemctl start solatel-update.timer solatel-backup.timer

    domain=$(cat /etc/solatel/domain)
    sed "s/SOLATEL_DOMAIN/$domain/g" "$SRC/deploy/Caddyfile" >/etc/caddy/Caddyfile.next
    if cmp -s /etc/caddy/Caddyfile.next /etc/caddy/Caddyfile; then
        rm -f /etc/caddy/Caddyfile.next
    elif caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.next >/dev/null 2>&1; then
        mv /etc/caddy/Caddyfile.next /etc/caddy/Caddyfile
        systemctl reload caddy || systemctl restart caddy
        echo ">> caddy configured for $domain"
    else
        echo ">> deploy/Caddyfile does not validate; keeping the one in place" >&2
        rm -f /etc/caddy/Caddyfile.next
    fi
}

# ---- the build, run as its own process (see `__build` below) -----------------

as_builder() {
    runuser -u "$BUILDER" -- env -i \
        HOME="$BUILDER_HOME" \
        PATH="$BUILDER_HOME/.cargo/bin:$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" \
        LANG=C.UTF-8 CARGO_TERM_COLOR=never NO_COLOR=1 \
        nice -n 19 ionice -c 2 -n 7 "$@"
}

ensure_node() {
    if [ -x "$NODE_DIR/bin/node" ] \
        && [ "$("$NODE_DIR/bin/node" -p 'process.versions.node.split(".")[0]')" = "$NODE_MAJOR" ]; then
        return
    fi
    local arch base sums name sum tmp
    case $(uname -m) in
        x86_64) arch=x64 ;;
        aarch64) arch=arm64 ;;
        *) echo "no Node.js build for $(uname -m)" >&2; return 1 ;;
    esac
    base=https://nodejs.org/dist/latest-v$NODE_MAJOR.x
    sums=$(curl -fsSL "$base/SHASUMS256.txt")
    name=$(printf '%s\n' "$sums" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-$arch\.tar\.xz$" | head -n 1)
    sum=$(printf '%s\n' "$sums" | awk -v n="$name" '$2 == n {print $1}')
    echo ">> installing $name"
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/$name" "$base/$name"
    echo "$sum  $tmp/$name" | sha256sum --check --quiet
    rm -rf "$NODE_DIR.next"
    mkdir -p "$NODE_DIR.next"
    tar -xJf "$tmp/$name" -C "$NODE_DIR.next" --strip-components=1
    rm -rf "$NODE_DIR" "$tmp"
    mv "$NODE_DIR.next" "$NODE_DIR"
}

ensure_rust() {
    if [ ! -x "$BUILDER_HOME/.cargo/bin/rustup" ]; then
        echo ">> installing rust"
        as_builder sh -c 'curl --proto "=https" --tlsv1.2 -fsSL https://sh.rustup.rs \
            | sh -s -- -y --no-modify-path --profile default --default-toolchain stable'
    fi
    # rust-toolchain.toml asks for the wasm target; adding it is a no-op once
    # it is there.
    as_builder rustup target add wasm32-unknown-unknown
}

# The CLI must be the version Cargo.lock pins, or the wasm builds and then
# fails to load in the browser (scripts/build-sim.sh).
ensure_wasm_bindgen() {
    local want have triple
    want=$(awk '/^name = "wasm-bindgen"$/{f=1;next} f&&/^version = /{gsub(/"/,"",$3);print $3;exit}' Cargo.lock)
    have=$(as_builder sh -c 'wasm-bindgen --version 2>/dev/null || true' | awk '{print $2}')
    if [ "$have" = "$want" ]; then return; fi
    echo ">> installing wasm-bindgen $want"
    case $(uname -m) in
        x86_64) triple=x86_64-unknown-linux-musl ;;
        aarch64) triple=aarch64-unknown-linux-gnu ;;
        *) triple= ;;
    esac
    if [ -n "$triple" ] && as_builder sh -c "set -e
        dir=\$(mktemp -d)
        curl -fsSL https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$want/wasm-bindgen-$want-$triple.tar.gz \
            | tar -xz -C \"\$dir\"
        install -m 755 \"\$dir/wasm-bindgen-$want-$triple/wasm-bindgen\" \"\$HOME/.cargo/bin/wasm-bindgen\"
        rm -rf \"\$dir\""; then
        return
    fi
    as_builder cargo install --locked wasm-bindgen-cli --version "$want"
}

build() {
    echo ">> building $commit"
    rsync -a --delete --chown="$BUILDER:$BUILDER" \
        --exclude=/.git --exclude=/target --exclude=/client/node_modules \
        --exclude=/client/generated --exclude=/web/dist \
        "$SRC/" "$BUILD/"
    cd "$BUILD"
    ensure_node
    ensure_rust
    ensure_wasm_bindgen

    echo ">> the server"
    as_builder cargo build --release --locked -p solatel-server
    echo ">> the simulation, for the client"
    as_builder bash scripts/build-sim.sh
    local lock
    lock=$(sha256sum client/package-lock.json | cut -d' ' -f1)
    if [ "$(cat client/node_modules/.solatel-lock 2>/dev/null || true)" != "$lock" ]; then
        echo ">> the client's packages"
        as_builder npm --prefix client ci --no-audit --no-fund
        as_builder sh -c "echo $lock > client/node_modules/.solatel-lock"
    fi
    echo ">> the client"
    as_builder npm --prefix client run build
    test -x target/release/solatel-server
    test -s web/dist/index.html
    test -s web/dist/build.json
    echo ">> built $commit"
}

# A release is root's and read-only to the server: the binary, the client it
# serves and the settings it runs with, all from one commit.
stage() {
    local dir=$RELEASES/$commit
    rm -rf "$dir.part"
    mkdir -p "$dir.part"
    install -m 755 "$BUILD/target/release/solatel-server" "$dir.part/solatel-server"
    cp -R "$BUILD/web/dist" "$dir.part/web"
    install -m 644 "$SRC/deploy/solatel.env" "$dir.part/solatel.env"
    echo "$commit" >"$dir.part/COMMIT"
    chown -R root:root "$dir.part"
    chmod -R a+rX,go-w "$dir.part"
    rm -rf "$dir"
    mv "$dir.part" "$dir"
}

# ---- switching ---------------------------------------------------------------

# Prints the stakes in escrow and succeeds while there are any, or while the
# server is up and cannot say. A server that is not running or not answering
# has nothing in play to protect.
money_in_play() {
    systemctl is-active --quiet solatel.service || return 1
    local body escrow
    body=$(curl -s --max-time 5 "$HEALTH") || return 1
    escrow=$(printf '%s' "$body" | jq -r '.escrow_micro_usd // "unknown"' 2>/dev/null || echo unknown)
    if [ "$escrow" = 0 ]; then return 1; fi
    echo "$escrow"
}

# Healthy, and the server that says so is the one started at $2 (seconds
# since the epoch) - not an old one still holding the port.
healthy_within() {
    local until=$((SECONDS + $1)) since=$2 body uptime
    while [ "$SECONDS" -lt "$until" ]; do
        if body=$(curl -fs --max-time 5 "$HEALTH"); then
            uptime=$(printf '%s' "$body" | jq -r '(.uptime_ms // 1e15) / 1000 | floor' 2>/dev/null || echo 1000000000000)
            if [ "$uptime" -le $(($(date +%s) - since + 2)) ]; then return 0; fi
        fi
        sleep 3
    done
    return 1
}

point_at() {
    ln -sfn "$1" "$CURRENT.next"
    mv -Tf "$CURRENT.next" "$CURRENT"
}

switch() {
    local previous started log
    previous=$(readlink -f "$CURRENT" 2>/dev/null || true)
    status switching "starting $commit"
    configure
    started=$(date +%s)
    systemctl stop solatel.service || true
    point_at "$RELEASES/$commit"
    # Whether it came up is the health check's to say, not systemctl's.
    systemctl start solatel.service || true
    if healthy_within "$HEALTHY_WITHIN" "$started"; then
        status live "serving $commit"
        prune
        return 0
    fi
    log=$STATE/start.log
    journalctl -u solatel.service --since "@$started" --no-pager -o cat | tail -n 80 >"$log" || true
    mkdir -p "$FAILED"
    touch "$FAILED/$commit"
    if [ -n "$previous" ] && [ -d "$previous" ] && [ "$previous" != "$RELEASES/$commit" ]; then
        systemctl stop solatel.service || true
        point_at "$previous"
        started=$(date +%s)
        systemctl start solatel.service || true
        healthy_within "$HEALTHY_WITHIN" "$started" || true
        status failed "$commit did not come up healthy; back on $(basename "$previous")" "$log"
    else
        status failed "$commit did not come up healthy, and there is nothing to go back to" "$log"
    fi
    exit 1
}

# The release being served, the one before it to go back to, and the newest
# other; the rest go.
prune() {
    local keep=0 dir live
    live=$(readlink -f "$CURRENT" 2>/dev/null || true)
    while IFS= read -r dir; do
        dir=${dir%/}
        if [ "$dir" = "$live" ]; then continue; fi
        keep=$((keep + 1))
        if [ "$keep" -gt 2 ]; then rm -rf "$dir"; fi
    done < <(ls -1dt "$RELEASES"/*/ 2>/dev/null || true)
}

# ---- what a run does ---------------------------------------------------------

mode=${1:-}
case $mode in
    configure)
        configure
        exit 0
        ;;
    __build)
        # Its own process, so that `set -e` holds inside it: bash ignores
        # `set -e` in a function called as an `if` condition.
        build
        exit 0
        ;;
    "" | --now | --retry) ;;
    *)
        echo "usage: solatel-update [--now | --retry]" >&2
        exit 2
        ;;
esac

# Anything that fails from here on that is not handled below says so in
# deploy.json, rather than leaving it saying "building" for ever.
set -o errtrace
trap 'status failed "the update stopped at deploy/update.sh line $LINENO"' ERR

mkdir -p "$RELEASES" "$FAILED" "$PUBLIC"

if [ "$commit" = "$(live_commit)" ] && [ "$mode" != --retry ]; then
    # Nothing new. Say so if the last word was something else.
    if [ "$(current_state)" != live ] && systemctl is-active --quiet solatel.service; then
        status live "serving $commit"
    fi
    exit 0
fi

if [ "$mode" = --retry ]; then
    rm -f "$FAILED/$commit"
elif [ -e "$FAILED/$commit" ]; then
    exit 0
fi

if [ ! -s "$SRC/deploy/solatel.env" ]; then
    status failed "there are no settings to run $commit with: deploy/solatel.env is missing"
    exit 1
fi

if [ ! -s "$RELEASES/$commit/COMMIT" ]; then
    status building "building $commit; the first build takes about twenty minutes, later ones a few"
    if ! timeout 2h "$BASH" "$SELF" __build >"$BUILD_LOG" 2>&1; then
        touch "$FAILED/$commit"
        status failed "the build of $commit failed" "$BUILD_LOG"
        exit 1
    fi
    stage
fi

if [ "$mode" != --now ] && escrow=$(money_in_play); then
    status waiting "$commit is built; waiting for the matches in progress to end (escrow: $escrow micro-USD)"
    exit 0
fi

switch
