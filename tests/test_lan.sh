#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
temporary=$(mktemp -d /tmp/nas-chat-lan-test.XXXXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
mkdir -p "$temporary/bin"
# Exercise real certificate/config generation without starting containers.
cat > "$temporary/bin/docker" <<'SH'
#!/bin/sh
exit 0
SH
chmod 755 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
for client in wechat qq; do
  root="$temporary/$client"
  mkdir -p "$root/config/mobile/web"
  printf '<!doctype html>test' > "$root/config/mobile/web/index.html"
  port=5804
  tls=5843
  if [ "$client" = qq ]; then port=5805; tls=5844; fi
  printf 'CHAT_CLIENT=%s\nHTTP_PORT=%s\n' "$client" "$port" > "$root/.env"
  CHAT_ROOT="$root" LAN_IP=192.168.1.20 LAN_CIDR=192.168.1.0/24 LAN_PORT="$tls" \
    bash "$repo/scripts/setup-lan.sh" > "$temporary/$client.log" 2>&1
  grep -q "proxy_pass http://127.0.0.1:$port;" "$root/lan-proxy/nginx.conf"
  grep -q "listen 192.168.1.20:$tls ssl;" "$root/lan-proxy/nginx.conf"
  openssl verify -CAfile "$root/lan-proxy/authority/root.pem" "$root/lan-proxy/tls/server.pem" >/dev/null
  openssl x509 -in "$root/lan-proxy/tls/server.pem" -noout -ext subjectAltName | grep -q 'IP Address:192.168.1.20'
  [ "$(stat -c %a "$root/lan-proxy/authority/root.key")" = 600 ]
  [ "$(find "$root/config/mobile/web" -name '*.key' | wc -l)" -eq 0 ]
done
grep -q 'container_name: nas-chat-mobile-lan' "$temporary/wechat/lan-proxy/compose.yaml"
grep -q 'container_name: nas-chat-mobile-qq-lan' "$temporary/qq/lan-proxy/compose.yaml"
before=$(sha256sum "$temporary/qq/lan-proxy/authority/root.key")
CHAT_ROOT="$temporary/qq" LAN_IP=192.168.1.20 LAN_CIDR=192.168.1.0/24 LAN_PORT=5844 \
  bash "$repo/scripts/setup-lan.sh" > "$temporary/renew.log" 2>&1
[ "$before" = "$(sha256sum "$temporary/qq/lan-proxy/authority/root.key")" ]
printf 'CHAT_CLIENT=qq\nHTTP_PORT=5805;touch bad\n' > "$temporary/qq/.env"
if CHAT_ROOT="$temporary/qq" LAN_IP=192.168.1.20 LAN_CIDR=192.168.1.0/24 LAN_PORT=5844 \
  bash "$repo/scripts/setup-lan.sh" > /dev/null 2>&1; then
  echo 'Invalid backend port was accepted' >&2
  exit 1
fi
echo 'PASS independent WeChat/QQ LAN proxies, backend ports, real certificate chain/SAN, private keys, renewal and input validation'
