#!/usr/bin/env bash
# Read-only checks. Run in the deployment directory before building or starting it.
set -euo pipefail
fail() { echo "ERROR: $*" >&2; exit 1; }
command -v docker >/dev/null || fail 'Install Docker Engine and Compose v2 first.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required (docker compose).'
architecture=$(docker info --format '{{.Architecture}}') || fail 'Cannot reach Docker. Check its service and your permissions.'
case "$architecture" in
  x86_64|amd64) platform=linux/amd64 ;;
  aarch64|arm64) platform=linux/arm64 ;;
  *) fail "Unsupported Docker architecture: $architecture. Only 64-bit x86 and ARM are supported." ;;
esac
if [ -n "${DOCKER_DEFAULT_PLATFORM:-}" ] && [ "$DOCKER_DEFAULT_PLATFORM" != "$platform" ]; then
  fail "DOCKER_DEFAULT_PLATFORM forces $DOCKER_DEFAULT_PLATFORM on $platform; unset it to use native execution."
fi
[ -f docker-compose.yml ] && [ -f .env ] || fail 'Run setup.sh first, then cd to the deployment directory.'
docker compose config --quiet || fail 'Compose configuration is invalid; check .env without publishing its contents.'
if grep -Eq '^WEB_PASSWORD=(change-me)?$' .env; then
  fail 'Replace the example WEB_PASSWORD with a random password.'
fi
[ -f config/mobile/server.py ] && [ -x mobile-services/mobile/python ] || fail 'Deployment source or executable scripts are missing.'
printf 'OK: %s, Docker %s, Compose v2.\n' "$platform" "$(docker version --format '{{.Server.Version}}')"
echo 'Build and start: docker compose up -d --build'
echo 'After startup: docker compose ps (chat should become healthy); connect through an HTTPS proxy.'
