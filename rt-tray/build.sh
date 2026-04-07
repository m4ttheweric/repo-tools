#!/bin/bash
set -euo pipefail

# ─── rt-tray build script ───────────────────────────────────────────────────
# Compiles the Swift source, assembles the .app bundle, and optionally signs it.
#
# Usage:
#   ./build.sh              Build debug
#   ./build.sh release      Build release + assemble .app bundle
#   ./build.sh install      Build release + install to ~/Applications

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

MODE="${1:-debug}"
APP_NAME="rt-tray"
BUNDLE_ID="com.rt.tray"
APP_BUNDLE="$SCRIPT_DIR/$APP_NAME.app"

# ─── Build ────────────────────────────────────────────────────────────────────

echo "  Building $APP_NAME ($MODE)..."

if [ "$MODE" = "debug" ]; then
    swift build 2>&1 | sed 's/^/  /'
    BINARY="$SCRIPT_DIR/.build/debug/$APP_NAME"
else
    swift build -c release 2>&1 | sed 's/^/  /'
    BINARY="$SCRIPT_DIR/.build/release/$APP_NAME"
fi

if [ ! -f "$BINARY" ]; then
    echo "  ✗ Build failed — binary not found at $BINARY"
    exit 1
fi

echo "  ✓ Build succeeded"

# ─── Assemble .app bundle ────────────────────────────────────────────────────

if [ "$MODE" = "debug" ]; then
    echo "  Skipping .app bundle assembly for debug build."
    echo "  Run: .build/debug/$APP_NAME"
    exit 0
fi

echo "  Assembling $APP_NAME.app..."

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

# Generate app icon (draws "rt" via Core Graphics → iconutil → AppIcon.icns)
if [ ! -f "$SCRIPT_DIR/AppIcon.icns" ]; then
    echo "  Generating AppIcon.icns..."
    swift "$SCRIPT_DIR/make-icon.swift"
else
    echo "  AppIcon.icns already exists — skipping generation (delete to regenerate)"
fi

if [ -f "$SCRIPT_DIR/AppIcon.icns" ]; then
    cp "$SCRIPT_DIR/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
    echo "  ✓ AppIcon.icns copied to Resources"
else
    echo "  ⚠ AppIcon.icns not found — notifications will show a default icon"
fi

# Copy binary
cp "$BINARY" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

# Copy Info.plist
cp "$SCRIPT_DIR/Info.plist" "$APP_BUNDLE/Contents/Info.plist"

# Create PkgInfo
echo -n "APPL????" > "$APP_BUNDLE/Contents/PkgInfo"

echo "  ✓ App bundle created at $APP_BUNDLE"

# ─── Code sign ────────────────────────────────────────────────────────────────

# Try to find a Developer ID certificate for proper signing
SIGNING_IDENTITY=""
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    SIGNING_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | awk -F'"' '{print $2}')
    echo "  Signing with: $SIGNING_IDENTITY"
    codesign --force --deep --sign "$SIGNING_IDENTITY" \
        --options runtime \
        --entitlements /dev/stdin <<EOF "$APP_BUNDLE"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <false/>
</dict>
</plist>
EOF
    echo "  ✓ Signed with Developer ID"
else
    echo "  No Developer ID found — ad-hoc signing"
    codesign --force --deep --sign - "$APP_BUNDLE"
    echo "  ✓ Ad-hoc signed"
fi

# ─── Verify ──────────────────────────────────────────────────────────────────

codesign --verify "$APP_BUNDLE" 2>/dev/null && echo "  ✓ Signature verified" || echo "  ⚠ Signature verification failed"

# ─── Install ──────────────────────────────────────────────────────────────────

if [ "$MODE" = "install" ]; then
    INSTALL_DIR="$HOME/Applications"
    mkdir -p "$INSTALL_DIR"
    
    # Kill existing instance
    pkill -f "$APP_NAME.app/Contents/MacOS/$APP_NAME" 2>/dev/null || true
    
    rm -rf "$INSTALL_DIR/$APP_NAME.app"
    cp -R "$APP_BUNDLE" "$INSTALL_DIR/$APP_NAME.app"
    echo "  ✓ Installed to $INSTALL_DIR/$APP_NAME.app"
    
    # Launch
    open "$INSTALL_DIR/$APP_NAME.app"
    echo "  ✓ Launched $APP_NAME"
fi

echo ""
echo "  Done."
