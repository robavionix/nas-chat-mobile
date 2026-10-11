#!/usr/bin/env bash
# Prepare a fresh deployment without starting containers or overwriting existing data.
set -euo pipefail
umask 077
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[ "$#" -eq 1 ] || { echo 'Usage: bash scripts/setup.sh /absolute/path/chat-remote' >&2; exit 1; }
target=$1
case "$target" in /*) ;; *) echo 'Use an absolute deployment path.' >&2; exit 1;; esac
[ ! -e "$target" ] && [ ! -L "$target" ] || { echo 'Target already exists; use the upgrade instructions instead.' >&2; exit 1; }
mkdir -p -- "$(dirname -- "$target")"
target="$(cd -- "$(dirname -- "$target")" && pwd -P)/$(basename -- "$target")"
case "$target" in "$source_root"|"$source_root"/*) echo 'Keep deployment data outside the source repository.' >&2; exit 1;; esac
deploy_uid=${PUID:-${SUDO_UID:-$(id -u)}}
deploy_gid=${PGID:-${SUDO_GID:-$(id -g)}}
[[ "$deploy_uid" =~ ^[0-9]+$ && "$deploy_gid" =~ ^[0-9]+$ ]] || { echo 'PUID and PGID must be numeric.' >&2; exit 1; }
[ "$deploy_uid" -ne 0 ] || { echo 'When running as root, set PUID and PGID to the account that will own config/.' >&2; exit 1; }
password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
[ "${#password}" -eq 48 ] || { echo 'Could not generate a random password.' >&2; exit 1; }
mkdir -- "$target"
mkdir -p -- "$target/config/mobile/web" "$target/mobile"
cp -- "$source_root/Dockerfile" "$source_root/.dockerignore" "$source_root/VERSION" "$target/"
cp -- "$source_root/docker-compose.example.yml" "$target/docker-compose.yml"
cp -- "$source_root/scripts/doctor.sh" "$target/doctor.sh"
cp -- "$source_root"/mobile/requirements*.txt "$target/mobile/"
cp -- "$source_root"/mobile/*.py "$source_root"/mobile/requirements*.txt "$target/config/mobile/"
cp -- "$source_root"/mobile/web/*.js "$source_root"/mobile/web/*.html \
  "$source_root"/mobile/web/*.png "$source_root"/mobile/web/*.json "$target/config/mobile/web/"
mkdir -p -- "$target/mobile-init" "$target/mobile-services/mobile"
cp -- "$source_root/mobile-init/50-mobile" "$target/mobile-init/"
cp -- "$source_root/mobile-services/mobile/run" "$source_root/mobile-services/mobile/python" \
  "$source_root/mobile-services/mobile/healthcheck.py" "$target/mobile-services/mobile/"
chmod 755 "$target/doctor.sh" "$target/mobile-init/50-mobile" "$target/mobile-services/mobile/run" \
  "$target/mobile-services/mobile/python" "$target/mobile-services/mobile/healthcheck.py"
cat > "$target/.env" <<EOF
WEB_PASSWORD=$password
PUID=$deploy_uid
PGID=$deploy_gid
BASE_IMAGE=ghcr.io/linuxserver/weixin@sha256:ef55da929cab5fae1f45b902b94918234604fa1473a7a7322383614a51573059
TZ=Asia/Shanghai
HTTP_PORT=5804
MEM_LIMIT=4g
SHM_SIZE=1gb
EOF
# The container's abc account needs these files; do not alter any pre-existing directory.
find "$target/config" -type d -exec chmod 700 {} +
find "$target/config" -type f -exec chmod 600 {} +
# Only web assets are public; a separate read-only mount makes them reachable by nginx.
find "$target/config/mobile/web" -type d -exec chmod 755 {} +
find "$target/config/mobile/web" -type f -exec chmod 644 {} +
chmod 755 "$target" "$target/mobile-init" "$target/mobile-services" "$target/mobile-services/mobile"
if [ "$(id -u)" -eq 0 ]; then
  chown -R "$deploy_uid:$deploy_gid" "$target/config"
elif [ "$(id -u)" != "$deploy_uid" ] || [ "$(id -g)" != "$deploy_gid" ]; then
  echo 'Warning: set config/ ownership to PUID:PGID before starting the container.' >&2
fi
printf 'Prepared: %s\nPassword is saved in .env (not printed). Next: cd to that directory and run docker compose up -d --build\n' "$target"
