#!/usr/bin/env bash
set -euo pipefail
architecture=${1:-$(dpkg --print-architecture)}
case "$architecture" in
  amd64) checksum=81ae2b8542ef5311fc72ecf53c9a523923c834569c7b0da52e0bf4360b9cb5f9 ;;
  arm64) checksum=ecc02e27b0ae55aba721f0671d44a919c26643456674a1857a2d0cde806e0d7e ;;
  *) echo "Unsupported QQ architecture: $architecture" >&2; exit 1 ;;
esac
apt-get update
apt-get install -y --no-install-recommends curl ca-certificates fonts-noto-cjk \
  libx11-6 xclip xdotool python3-venv libnss3 libgbm1 libasound2t64 \
  libgtk-3-0t64 libxss1 libxtst6 libatomic1 \
  tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng
package=$(mktemp /tmp/qq.XXXXXXXX.deb)
trap 'rm -f -- "$package"' EXIT
# Fixed, tested Tencent distribution. Do not silently install a different UI version.
curl -fL --retry 3 --connect-timeout 30 --max-time 900 -o "$package" \
  "https://qqdl.gtimg.cn/qqfile/QQNT/9.9.33/release/c97651b2/QQ_3.2.32_260730_${architecture}_01.deb"
printf '%s  %s\n' "$checksum" "$package" | sha256sum -c -
[ "$(dpkg-deb -f "$package" Architecture)" = "$architecture" ]
apt-get install -y --no-install-recommends "$package"
