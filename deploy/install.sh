#!/bin/bash
# Puts Solatel on a fresh Ubuntu 24.04 (or Debian 12) server, under a domain
# whose DNS already points at it:
#
#   curl -fsSL https://raw.githubusercontent.com/Conradfrmdao/solatel/main/deploy/install.sh | sudo bash -s -- example.com
#
# All on this one machine (documents/RUNBOOK.md, "One VPS"):
#   - Postgres, reached through its socket by the system user the server runs
#     as, so there is no database password anywhere;
#   - Caddy in front, which gets the domain's certificate and renews it;
#   - the server, as a systemd service;
#   - an updater that builds main whenever it moves and switches to it only
#     when no match has money in it, every two minutes (deploy/update.sh);
#   - a copy of the database every night, kept a fortnight;
#   - a firewall that lets in SSH and the web and nothing else.
#
# The admin token is made here and never leaves this machine:
#   sudo cat /etc/solatel/secret.env
#
# Safe to run again, with or without the domain: every step checks first.
set -euo pipefail

REPO=https://github.com/Conradfrmdao/solatel.git
ROOT=/opt/solatel

if [ "$(id -u)" != 0 ]; then
    echo "run it with sudo" >&2
    exit 1
fi
. /etc/os-release
case "${ID:-}" in
    ubuntu | debian) ;;
    *) echo "this is written for Ubuntu 24.04 or Debian 12, not ${PRETTY_NAME:-this system}" >&2; exit 1 ;;
esac

# ---- the domain --------------------------------------------------------------
domain=${1:-}
if [ -z "$domain" ] && [ -s /etc/solatel/domain ]; then domain=$(cat /etc/solatel/domain); fi
domain=${domain#http://}
domain=${domain#https://}
domain=${domain%%/*}
domain=${domain#www.}
domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')
if ! [[ "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
    echo "usage: install.sh <domain>    for example: install.sh solatel.com" >&2
    exit 2
fi
echo ">> installing solatel for $domain"

# ---- packages ----------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends \
    ca-certificates curl git rsync jq xz-utils openssl \
    build-essential pkg-config \
    postgresql caddy ufw fail2ban

# ---- users and places ----------------------------------------------------------
# `solatel` runs the server and owns the database; `solatel-build` compiles,
# and can change nothing the server runs.
id solatel >/dev/null 2>&1 \
    || useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin solatel
id solatel-build >/dev/null 2>&1 \
    || useradd --system --create-home --home-dir /var/lib/solatel-build --shell /usr/sbin/nologin solatel-build
install -d -m 755 "$ROOT" "$ROOT/releases" /var/lib/solatel /var/lib/solatel/public
install -d -m 755 -o solatel-build -g solatel-build "$ROOT/build"
install -d -m 750 -o root -g solatel /etc/solatel
install -d -m 750 -o solatel -g solatel /var/backups/solatel
printf '%s\n' "$domain" >/etc/solatel/domain

if [ ! -s /etc/solatel/secret.env ]; then
    (
        umask 027
        printf 'SOLATEL_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" >/etc/solatel/secret.env
    )
    chown root:solatel /etc/solatel/secret.env
    chmod 640 /etc/solatel/secret.env
fi

# ---- memory for the first build -----------------------------------------------
if ! swapon --show | grep -q . && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 6000000 ]; then
    echo ">> adding 4 GB of swap"
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# ---- the database ----------------------------------------------------------------
systemctl enable --now postgresql
cd /
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'solatel'" | grep -q 1 \
    || runuser -u postgres -- createuser solatel
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'solatel'" | grep -q 1 \
    || runuser -u postgres -- createdb --owner=solatel solatel

# ---- the code --------------------------------------------------------------------
if [ ! -d "$ROOT/src/.git" ]; then
    git clone --quiet --depth 1 --branch main "$REPO" "$ROOT/src"
fi
git -C "$ROOT/src" fetch --quiet --depth 1 origin main
git -C "$ROOT/src" reset --quiet --hard FETCH_HEAD

# The updater the timer runs. It never changes: it fetches main and runs the
# update script main brings, so everything else can.
cat >/usr/local/sbin/solatel-update <<'STUB'
#!/bin/bash
# Fetches main, then hands over to the update script it brings
# (/opt/solatel/src/deploy/update.sh). Written by deploy/install.sh.
set -euo pipefail
exec 9>/run/lock/solatel-update.lock
if ! flock -n 9; then
    echo ">> an update is already running"
    exit 0
fi
git -C /opt/solatel/src fetch --quiet --depth 1 origin main
git -C /opt/solatel/src reset --quiet --hard FETCH_HEAD
exec /bin/bash /opt/solatel/src/deploy/update.sh "$@"
STUB
chmod 755 /usr/local/sbin/solatel-update

# ---- the firewall ------------------------------------------------------------------
# SSH on whatever port it really listens on, so this cannot lock anybody out.
for port in $(ss -Htlnp 2>/dev/null | awk '/"sshd"/ {sub(/.*:/, "", $4); print $4}' | sort -u) 22; do
    ufw allow "$port/tcp" >/dev/null
done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null 2>&1 || true

# ---- services, Caddy, and the first build ------------------------------------------
bash "$ROOT/src/deploy/update.sh" configure
systemctl enable --now caddy >/dev/null
systemctl start --no-block solatel-update.service

cat <<DONE

>> Solatel is installed for $domain, and the first build has started.
   It takes about twenty minutes. Then the game is at https://$domain

   Watch it:      https://$domain/deploy.json   (or: sudo journalctl -fu solatel-update)
   Server logs:   sudo journalctl -fu solatel
   Admin token:   sudo cat /etc/solatel/secret.env   (for https://$domain/admin)

   From now on every change merged into main goes live by itself, as soon
   as no match has money in it.
DONE
