#!/usr/bin/env bash
# The ledger invariant tests, against a Postgres already running on this
# machine rather than a throwaway container.
#
#   bash scripts/test-ledger-local.sh
#
# For where there is no Docker - Claude Code on the web is one - and a local
# Postgres instead. `scripts/test-ledger.sh` is unchanged and still the
# canonical run: this puts a stand-in `docker` first on the PATH that turns
# "start a container" into "make a database called ledgertest" and
# "exec psql in it" into psql against localhost, then runs that script.
#
# Needs a role that can create databases, as `postgres` over localhost. The
# database it makes is dropped again at the end, as the container would be.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT

cat > "$SHIM/docker" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  rm)   psql -q -h localhost -U postgres -d postgres \
            -c 'DROP DATABASE IF EXISTS ledgertest' >/dev/null 2>&1 || true ;;
  run)  psql -q -h localhost -U postgres -d postgres \
            -c 'CREATE DATABASE ledgertest' >/dev/null ;;
  exec) shift; [ "$1" = "-i" ] && shift; shift; cmd="$1"; shift
        exec "$cmd" -h localhost "$@" ;;
  logs) ;;
  *)    echo "docker stand-in: $1 is not supported" >&2; exit 1 ;;
esac
SHIM
chmod +x "$SHIM/docker"

PATH="$SHIM:$PATH" bash "$ROOT/scripts/test-ledger.sh"
