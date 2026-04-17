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
    SHIM_BINARY="$SCRIPT_DIR/.build/debug/rt-daemon-shim"
else
    swift build -c release 2>&1 | sed 's/^/  /'
    BINARY="$SCRIPT_DIR/.build/release/$APP_NAME"
    SHIM_BINARY="$SCRIPT_DIR/.build/release/rt-daemon-shim"
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

# Copy tray binary
cp "$BINARY" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

# ─── Embed daemon binary ──────────────────────────────────────────────────────
# RT_DAEMON_BIN env var wins (CI passes the freshly-built rt binary). For local
# dev, fall back to whatever `rt` resolves to on PATH — that's the same compiled
# binary the user already has installed.

DAEMON_SRC="${RT_DAEMON_BIN:-}"
if [ -z "$DAEMON_SRC" ]; then
    DAEMON_SRC="$(command -v rt 2>/dev/null || true)"
fi

if [ -n "$DAEMON_SRC" ] && [ -f "$DAEMON_SRC" ]; then
    cp "$DAEMON_SRC" "$APP_BUNDLE/Contents/MacOS/rt-daemon"
    chmod +x "$APP_BUNDLE/Contents/MacOS/rt-daemon"
    echo "  ✓ Embedded rt-daemon from $DAEMON_SRC"
else
    echo "  ⚠ rt binary not found — daemon will not be embedded"
    echo "    Set RT_DAEMON_BIN or install rt on PATH"
fi

# Embed rt-daemon-shim — the signed exec-proxy used by dev-mode. It execs into
# `bun run lib/daemon.ts` so daemon edits don't require a release cycle.
if [ -f "$SHIM_BINARY" ]; then
    cp "$SHIM_BINARY" "$APP_BUNDLE/Contents/MacOS/rt-daemon-shim"
    chmod +x "$APP_BUNDLE/Contents/MacOS/rt-daemon-shim"
    echo "  ✓ Embedded rt-daemon-shim from $SHIM_BINARY"
else
    echo "  ⚠ rt-daemon-shim not built — dev-mode daemon swap will be unavailable"
fi

# Ship LaunchAgent plist inside the bundle (SMAppService reads it from here)
mkdir -p "$APP_BUNDLE/Contents/Library/LaunchAgents"
cp "$SCRIPT_DIR/LaunchAgent.plist" "$APP_BUNDLE/Contents/Library/LaunchAgents/com.rt.daemon.plist"
echo "  ✓ LaunchAgent plist copied to Contents/Library/LaunchAgents"

# Copy Info.plist and inject version from git tag
cp "$SCRIPT_DIR/Info.plist" "$APP_BUNDLE/Contents/Info.plist"
RT_VERSION=$(cd "$SCRIPT_DIR/.." && git describe --tags --abbrev=0 2>/dev/null || echo "dev")
RT_VERSION="${RT_VERSION#v}"  # strip leading 'v'
if [ "$RT_VERSION" != "dev" ]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $RT_VERSION" "$APP_BUNDLE/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $RT_VERSION" "$APP_BUNDLE/Contents/Info.plist"
    echo "  ✓ Version set to $RT_VERSION"
fi

# Create PkgInfo
echo -n "APPL????" > "$APP_BUNDLE/Contents/PkgInfo"

echo "  ✓ App bundle created at $APP_BUNDLE"

# ─── Code sign (inside-out) ──────────────────────────────────────────────────
# Sign the embedded daemon FIRST with Bun's JIT entitlements, then sign the
# outer bundle with the tray's minimal entitlements. --deep would clobber the
# daemon's JIT entitlements, so we sign each piece explicitly.

SIGNING_IDENTITY=""
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    SIGNING_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | awk -F'"' '{print $2}')
    echo "  Signing with: $SIGNING_IDENTITY"
    SIGN_FLAGS=(--force --sign "$SIGNING_IDENTITY" --options runtime --timestamp)
else
    echo "  No Developer ID found — ad-hoc signing"
    SIGNING_IDENTITY="-"
    SIGN_FLAGS=(--force --sign -)
fi

# 1. Embedded daemon — needs Bun JIT entitlements
DAEMON_BIN="$APP_BUNDLE/Contents/MacOS/rt-daemon"
if [ -f "$DAEMON_BIN" ]; then
    codesign "${SIGN_FLAGS[@]}" \
        --entitlements "$SCRIPT_DIR/../scripts/entitlements.plist" \
        "$DAEMON_BIN"
    echo "  ✓ Signed rt-daemon with JIT entitlements"
fi

# 1b. Daemon shim — same Team ID + JIT entitlements so it can replace rt-daemon
# under launchd's LWCR check. Entitlements apply if the shim ever serves in
# rt-daemon's slot (dev-mode swap).
SHIM_BUNDLE="$APP_BUNDLE/Contents/MacOS/rt-daemon-shim"
if [ -f "$SHIM_BUNDLE" ]; then
    codesign "${SIGN_FLAGS[@]}" \
        --entitlements "$SCRIPT_DIR/../scripts/entitlements.plist" \
        "$SHIM_BUNDLE"
    echo "  ✓ Signed rt-daemon-shim with JIT entitlements"
fi

# 2. Outer .app bundle — tray entitlements (sandbox disabled)
codesign "${SIGN_FLAGS[@]}" \
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
echo "  ✓ Signed app bundle"

# ─── Verify ──────────────────────────────────────────────────────────────────

codesign --verify "$APP_BUNDLE" 2>/dev/null && echo "  ✓ Signature verified" || echo "  ⚠ Signature verification failed"

# ─── Install ──────────────────────────────────────────────────────────────────

if [ "$MODE" = "install" ]; then
    INSTALL_DIR="$HOME/Applications"
    mkdir -p "$INSTALL_DIR"
    
    # Kill existing instance and wait for it to fully exit
    if pkill -f "$APP_NAME.app/Contents/MacOS/$APP_NAME" 2>/dev/null; then
        echo "  Waiting for old instance to exit…"
        for i in $(seq 1 20); do
            pgrep -f "$APP_NAME.app/Contents/MacOS/$APP_NAME" > /dev/null 2>&1 || break
            sleep 0.1
        done
    fi

    rm -rf "$INSTALL_DIR/$APP_NAME.app"
    cp -R "$APP_BUNDLE" "$INSTALL_DIR/$APP_NAME.app"
    echo "  ✓ Installed to $INSTALL_DIR/$APP_NAME.app"
    
    # Launch
    open "$INSTALL_DIR/$APP_NAME.app"
    echo "  ✓ Launched $APP_NAME"
fi

echo ""
echo "  Done."
