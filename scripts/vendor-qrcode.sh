#!/bin/sh
# Copies the QR code generator (MIT, Kazuhiko Arase) into web/vendor.
# Usage: scripts/vendor-qrcode.sh [version]
set -eu
version="${1:-2.0.4}"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
npm install --prefix "$tmp" --silent --no-save "qrcode-generator@$version"
cp "$tmp/node_modules/qrcode-generator/dist/qrcode.mjs" "$root/web/vendor/qrcode.mjs"
echo "Vendored qrcode-generator $version"
