#!/usr/bin/env bash
# Build, sign, notarize and staple the MMF desktop app for Apple Silicon, then
# assemble the files for a GitHub Release (DMG, updater bundle, latest.json).
#
# Runs locally only: every secret comes from this Mac's login keychain, never
# from files or CI.
#   - Developer ID Application certificate   (codesign)
#   - notarytool profile "MMF-notarization"   (xcrun notarytool store-credentials)
#   - generic password "mmf-updater-key-password" for ~/.tauri/mmf_updater.key
#
# Usage: scripts/release-mac.sh [--publish]
#   Without --publish it stops after writing dist-release/; with it, it also
#   creates a draft GitHub Release v<version> holding those files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/apps/desktop"
CONF="$APP_DIR/src-tauri/tauri.conf.json"
TARGET=aarch64-apple-darwin
BUNDLE="$ROOT/target/$TARGET/release/bundle"
OUT="$ROOT/dist-release"
REPO=docgraphapp/modelfit
NOTARY_PROFILE=MMF-notarization
UPDATER_KEY="$HOME/.tauri/mmf_updater.key"

PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1

VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$CONF")"
PRODUCT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["productName"])' "$CONF")"
TAG="v$VERSION"

IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
if [ -z "$IDENTITY" ]; then
  echo "error: no Developer ID Application certificate in the keychain" >&2
  exit 1
fi
[ -f "$UPDATER_KEY" ] || { echo "error: missing $UPDATER_KEY" >&2; exit 1; }

# A shell-wide NODE_ENV=development makes Vite emit a dev bundle (dev JSX
# runtime, the browser mock harness); a release must never inherit that.
export NODE_ENV=production
export APPLE_SIGNING_IDENTITY="$IDENTITY"
export TAURI_SIGNING_PRIVATE_KEY="$UPDATER_KEY"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s mmf-updater-key-password -w)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD

echo "==> Building $PRODUCT $VERSION for $TARGET"
echo "    signing as: $IDENTITY"
(cd "$APP_DIR" && npm run tauri -- build --target "$TARGET")

APP="$BUNDLE/macos/$PRODUCT.app"
DMG="$BUNDLE/dmg/${PRODUCT}_${VERSION}_aarch64.dmg"
[ -d "$APP" ] && [ -f "$DMG" ] || { echo "error: build outputs not found under $BUNDLE" >&2; exit 1; }

codesign --verify --deep --strict "$APP"

# Notarizing the DMG also covers the app inside it, so both can be stapled.
echo "==> Notarizing $(basename "$DMG")"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"
xcrun stapler staple "$APP"
spctl --assess --type execute --verbose "$APP"

# Tauri packed the updater bundle before stapling; repack the stapled app and
# sign it again so auto-updates install a notarized copy.
echo "==> Packing updater bundle"
rm -rf "$OUT" && mkdir -p "$OUT"
UPDATE_TGZ="$OUT/$PRODUCT.app.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$UPDATE_TGZ" -C "$(dirname "$APP")" "$(basename "$APP")"
(cd "$APP_DIR" && env -u TAURI_SIGNING_PRIVATE_KEY npm run tauri -- signer sign -f "$UPDATER_KEY" "$UPDATE_TGZ" >/dev/null)
cp "$DMG" "$OUT/"
# Version-free copy: the website links releases/latest/download/<this name>.
cp "$DMG" "$OUT/${PRODUCT}_aarch64.dmg"

python3 - "$OUT" "$VERSION" "$TAG" "$REPO" "$PRODUCT" <<'EOF'
import json, sys, datetime
out, version, tag, repo, product = sys.argv[1:]
sig = open(f"{out}/{product}.app.tar.gz.sig").read().strip()
manifest = {
    "version": version,
    "notes": f"{product} {version}",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        "darwin-aarch64": {
            "signature": sig,
            "url": f"https://github.com/{repo}/releases/download/{tag}/{product}.app.tar.gz",
        }
    },
}
json.dump(manifest, open(f"{out}/latest.json", "w"), indent=2)
EOF

echo "==> Release files in $OUT:"
ls -lh "$OUT"

if [ "$PUBLISH" = 1 ]; then
  echo "==> Creating draft release $TAG on $REPO"
  gh release create "$TAG" -R "$REPO" --draft --title "$PRODUCT $VERSION" \
    --notes "$PRODUCT $VERSION for Apple Silicon Macs (macOS 12+)." \
    "$OUT"/*
fi
