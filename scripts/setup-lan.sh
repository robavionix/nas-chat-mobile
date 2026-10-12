#!/usr/bin/env bash
# Run from the source checkout, writing only to a separate deployment directory.
set -euo pipefail
umask 077

: "${CHAT_ROOT:?Set CHAT_ROOT to the existing chat-remote deployment directory}"
: "${LAN_IP:?Set LAN_IP to the NAS private IPv4 address}"
: "${LAN_CIDR:?Set LAN_CIDR to the allowed home network, e.g. 192.168.1.0/24}"
backend_port=$(sed -n 's/^HTTP_PORT=//p' "$CHAT_ROOT/.env" 2>/dev/null || true)
backend_port=${backend_port:-5804}
chat_client=$(sed -n 's/^CHAT_CLIENT=//p' "$CHAT_ROOT/.env" 2>/dev/null || true)
chat_client=${chat_client:-wechat}
case "$chat_client" in wechat|qq) ;; *) echo 'Invalid CHAT_CLIENT in deployment .env' >&2; exit 1;; esac
proxy_name=nas-chat-mobile-lan
default_lan_port=5843
if [ "$chat_client" = qq ]; then proxy_name=nas-chat-mobile-qq-lan; default_lan_port=5844; fi
LAN_PORT="${LAN_PORT:-$default_lan_port}"
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
for command in python3 openssl docker; do
    command -v "$command" >/dev/null || { echo "Missing dependency: $command" >&2; exit 1; }
done
docker compose version >/dev/null

# Validate all values before creating keys or generating nginx configuration.
python3 - "$CHAT_ROOT" "$source_dir" "$LAN_IP" "$LAN_CIDR" "$LAN_PORT" "$backend_port" <<'PY'
import ipaddress, sys
from pathlib import Path
root, source = (Path(value).resolve() for value in sys.argv[1:3])
if root == source or source in root.parents:
    raise SystemExit('CHAT_ROOT must be outside the source checkout')
if not (root / 'config/mobile/web/index.html').is_file():
    raise SystemExit('CHAT_ROOT must contain the installed config/mobile/web/index.html')
ip = ipaddress.IPv4Address(sys.argv[3])
network = ipaddress.IPv4Network(sys.argv[4], strict=True)
private = [ipaddress.IPv4Network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
if not any(network.subnet_of(value) for value in private) or ip not in network:
    raise SystemExit('LAN_IP must belong to LAN_CIDR, which must be a private IPv4 network')
for value, name in ((sys.argv[5], 'LAN_PORT'), (sys.argv[6], 'HTTP_PORT')):
    if not value.isdigit() or not 1024 <= int(value) <= 65535:
        raise SystemExit(name + ' must be an integer between 1024 and 65535')
PY

CHAT_ROOT="$(cd -- "$CHAT_ROOT" && pwd)"
proxy_dir="$CHAT_ROOT/lan-proxy"
web_dir="$CHAT_ROOT/config/mobile/web"
mkdir -p "$proxy_dir/authority" "$proxy_dir/tls"
chmod 700 "$proxy_dir/authority" "$proxy_dir/tls"
ca_name='NAS Chat Mobile Local CA'

if [[ ! -f "$proxy_dir/authority/root.key" && ! -f "$proxy_dir/authority/root.pem" ]]; then
    openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
        -subj "/CN=$ca_name" \
        -addext 'basicConstraints=critical,CA:TRUE' \
        -addext 'keyUsage=critical,keyCertSign,cRLSign' \
        -keyout "$proxy_dir/authority/root.key" -out "$proxy_dir/authority/root.pem"
elif [[ ! -f "$proxy_dir/authority/root.key" || ! -f "$proxy_dir/authority/root.pem" ]]; then
    echo 'Incomplete existing CA: restore the missing CA file before continuing.' >&2
    exit 1
fi
openssl x509 -in "$proxy_dir/authority/root.pem" -noout -checkend 34300800 >/dev/null || {
    echo 'Existing root CA expires within 397 days; replace it and reinstall trust on devices.' >&2
    exit 1
}
if [[ ! -f "$proxy_dir/tls/server.key" ]]; then
    openssl genrsa -out "$proxy_dir/tls/server.key" 2048
fi
openssl req -new -key "$proxy_dir/tls/server.key" -subj "/CN=$LAN_IP" -out "$proxy_dir/tls/server.csr"
cat > "$proxy_dir/tls/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$LAN_IP
EOF
openssl x509 -req -in "$proxy_dir/tls/server.csr" \
    -CA "$proxy_dir/authority/root.pem" -CAkey "$proxy_dir/authority/root.key" \
    -CAcreateserial -days 397 -sha256 -extfile "$proxy_dir/tls/server.ext" \
    -out "$proxy_dir/tls/server.pem"
openssl verify -CAfile "$proxy_dir/authority/root.pem" "$proxy_dir/tls/server.pem"
openssl x509 -in "$proxy_dir/authority/root.pem" -outform DER -out "$web_dir/lan-root.cer"

python3 - "$source_dir" "$proxy_dir" "$web_dir" "$LAN_IP" "$LAN_CIDR" "$LAN_PORT" "$ca_name" "$backend_port" "$proxy_name" <<'PY'
import json, plistlib, sys, uuid
from pathlib import Path
source, proxy, web = (Path(value) for value in sys.argv[1:4])
ip, cidr, port, ca_name, backend_port, proxy_name = sys.argv[4:]
config = (source / 'lan-proxy/nginx.conf.example').read_text()
for key, value in {'LAN_IP': ip, 'LAN_CIDR': cidr, 'LAN_PORT': port, 'HTTP_PORT': backend_port}.items():
    config = config.replace('__' + key + '__', value)
# Write in place: the proxy may already bind-mount this inode.
(proxy / 'nginx.conf').write_text(config)
compose = (source / 'lan-proxy/compose.example.yaml').read_text().replace('nas-chat-mobile-lan', proxy_name)
(proxy / 'compose.yaml').write_text(compose)
(web / 'lan-config.json').write_text(json.dumps({'url': f'https://{ip}:{port}/mobile/', 'caName': ca_name}) + '\n')
certificate = {
    'PayloadType': 'com.apple.security.root', 'PayloadVersion': 1,
    'PayloadIdentifier': 'local.nas-chat-mobile.ca', 'PayloadUUID': str(uuid.uuid4()),
    'PayloadDisplayName': ca_name, 'PayloadContent': (web / 'lan-root.cer').read_bytes(),
}
profile = {
    'PayloadType': 'Configuration', 'PayloadVersion': 1,
    'PayloadIdentifier': 'local.nas-chat-mobile.trust', 'PayloadUUID': str(uuid.uuid4()),
    'PayloadDisplayName': ca_name, 'PayloadDescription': 'Trust the local HTTPS certificate for your NAS chat mobile view.',
    'PayloadContent': [certificate],
}
(web / 'lan-chat.mobileconfig').write_bytes(plistlib.dumps(profile))
PY

chmod 600 "$proxy_dir/authority/"* "$proxy_dir/tls/"*
chmod 644 "$proxy_dir/nginx.conf" "$proxy_dir/compose.yaml" \
    "$web_dir/lan-root.cer" "$web_dir/lan-chat.mobileconfig" "$web_dir/lan-config.json"
docker compose -f "$proxy_dir/compose.yaml" config --quiet
docker compose -f "$proxy_dir/compose.yaml" run --rm --no-deps lan nginx -t
# Recreate only the separate LAN proxy; the chat desktop stays running.
docker compose -f "$proxy_dir/compose.yaml" up -d --force-recreate
echo "LAN HTTPS ready: https://$LAN_IP:$LAN_PORT/mobile/"
echo 'Open /mobile/lan-setup.html through your existing trusted HTTPS address to install the root certificate.'
echo 'Rerun this command before the 397-day server certificate expires; the existing root CA is retained.'
