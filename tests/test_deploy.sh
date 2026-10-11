#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
temporary=$(mktemp -d /tmp/nas-chat-deploy-test.XXXXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
fixture="$temporary/source"
mkdir -p "$fixture/scripts" "$fixture/mobile/web" "$fixture/mobile/push-deps"
cp "$repo/scripts/setup.sh" "$repo/scripts/doctor.sh" "$fixture/scripts/"
cp "$repo/Dockerfile" "$repo/.dockerignore" "$repo/VERSION" "$repo/docker-compose.example.yml" "$fixture/"
cp -R "$repo/mobile-init" "$repo/mobile-services" "$fixture/"
cp "$repo"/mobile/*.py "$repo"/mobile/requirements*.txt "$fixture/mobile/"
cp "$repo"/mobile/web/*.js "$repo"/mobile/web/*.html "$repo"/mobile/web/*.png "$repo"/mobile/web/*.json "$fixture/mobile/web/"
printf 'private-test-only' > "$fixture/mobile/session.key"
printf 'private-test-only' > "$fixture/mobile/push-deps/native.so"
printf 'private-test-only' > "$fixture/mobile/web/lan-root.cer"
target="$temporary/deployment with spaces"
PUID=1234 PGID=1234 bash "$fixture/scripts/setup.sh" "$target"
[ "$(stat -c %a "$target/.env")" = 600 ]
[ "$(stat -c %a "$target/config")" = 700 ]
[ "$(stat -c %a "$target/config/mobile/server.py")" = 600 ]
[ "$(stat -c %a "$target/config/mobile/web")" = 755 ]
[ "$(stat -c %a "$target/config/mobile/web/login.html")" = 644 ]
grep -Eq '^WEB_PASSWORD=[a-f0-9]{48}$' "$target/.env"
grep -q '^PUID=1234$' "$target/.env"
[ -x "$target/mobile-services/mobile/python" ]
[ -f "$target/config/mobile/web/index.html" ]
[ -f "$target/mobile/requirements.txt" ]
[ ! -e "$target/config/mobile/session.key" ]
[ ! -e "$target/config/mobile/push-deps" ]
[ ! -e "$target/config/mobile/web/lan-root.cer" ]
before=$(sha256sum "$target/.env")
if PUID=1234 PGID=1234 bash "$fixture/scripts/setup.sh" "$target" 2>/dev/null; then
  echo 'Existing deployment was accepted unexpectedly' >&2; exit 1
fi
[ "$before" = "$(sha256sum "$target/.env")" ]
if PUID=1234 PGID=1234 bash "$fixture/scripts/setup.sh" "$fixture/deployment" 2>/dev/null; then
  echo 'Deployment inside source was accepted unexpectedly' >&2; exit 1
fi
if PUID=abc PGID=1234 bash "$fixture/scripts/setup.sh" "$temporary/bad-uid" 2>/dev/null; then
  echo 'Non-numeric UID was accepted unexpectedly' >&2; exit 1
fi
mkdir "$temporary/bin"
cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  'compose version') echo 'Docker Compose version v2.40.3' ;;
  'compose config') exit "${FAKE_COMPOSE_EXIT:-0}" ;;
  'info --format') echo "${FAKE_ARCH:-x86_64}" ;;
  'version --format') echo 29.1.3 ;;
  *) exit 2 ;;
esac
SH
chmod +x "$temporary/bin/docker"
cd "$target"
PATH="$temporary/bin:$PATH" bash "$repo/scripts/doctor.sh"
PATH="$temporary/bin:$PATH" FAKE_ARCH=aarch64 bash "$repo/scripts/doctor.sh"
for architecture in i686 armv7l; do
  if PATH="$temporary/bin:$PATH" FAKE_ARCH="$architecture" bash "$repo/scripts/doctor.sh" 2>/dev/null; then
    echo "Unsupported architecture accepted: $architecture" >&2; exit 1
  fi
done
if PATH="$temporary/bin:$PATH" DOCKER_DEFAULT_PLATFORM=linux/arm64 bash "$repo/scripts/doctor.sh" 2>/dev/null; then
  echo 'Foreign emulation was accepted unexpectedly' >&2; exit 1
fi
if PATH="$temporary/bin:$PATH" FAKE_COMPOSE_EXIT=1 bash "$repo/scripts/doctor.sh" 2>/dev/null; then
  echo 'Broken Compose configuration was accepted unexpectedly' >&2; exit 1
fi
echo 'Deployment tests passed: fresh install, permissions, secret exclusion, no overwrite, architecture checks.'
