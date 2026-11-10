#!/bin/sh
# Copies the Firebase browser SDK into web/vendor so the app needs no build
# step and no third-party CDN. Usage: scripts/vendor-firebase.sh [version]
set -eu
version="${1:-13.2.0}"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
npm install --prefix "$tmp" --silent --no-save "firebase@$version"
for name in app firestore messaging; do
  # The bundles import each other from gstatic; point them at the local copies.
  sed "s#https://www.gstatic.com/firebasejs/$version/#./#g" \
    "$tmp/node_modules/firebase/firebase-$name.js" > "$root/web/vendor/firebase-$name.js"
done
echo "$version" > "$root/web/vendor/VERSION"
echo "Vendored firebase $version"
