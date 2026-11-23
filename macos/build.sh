#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
app="$build/NAS 聊天.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$build/chat.iconset" dist
for arch in arm64 x86_64; do
    xcrun swiftc -O -swift-version 5 -target "${arch}-apple-macos13.0" main.swift -o "$build/NASChat-$arch"
done
xcrun lipo -create "$build/NASChat-arm64" "$build/NASChat-x86_64" -output "$app/Contents/MacOS/NASChat"
xcrun swift icon.swift "$build/chat.iconset"
iconutil -c icns "$build/chat.iconset" -o "$app/Contents/Resources/Chat.icns"
cp Info.plist "$app/Contents/"
codesign --force --sign - --options runtime "$app"
codesign --verify --strict "$app"
ditto -c -k --keepParent "$app" "$build/NASChat-macOS.zip"
mv "$build/NASChat-macOS.zip" dist/
