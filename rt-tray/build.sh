#!/bin/bash
set -euo pipefail

# ─── rt-tray build script ───────────────────────────────────────────────────
# Compiles the Swift source, assembles the .app bundle, and optionally signs it.
#
# Usage:
#   ./build.sh              Build debug (rt-tray SwiftPM product, unbundled)
#   ./build.sh release      Build release + assemble mattstack.app (prod)
#   ./build.sh dev          Build release + assemble mattstack-dev.app (dev)
#   ./build.sh install      Build release + install mattstack.app to ~/Applications
#
# PRODUCT_NAME is the SwiftPM executable target name (Package.swift never
# renames it — see spec MAT-383 §1) and is where the compiled binary comes
# FROM: .build/<config>/$PRODUCT_NAME. APP_NAME is the bundle identity — what
# the binary is copied TO (Contents/MacOS/$APP_NAME) and the .app filename.
# These diverge on purpose: prod APP_NAME=mattstack, dev APP_NAME=mattstack-dev.
#
# The bundle id, daemon label, and display name live ONLY here (never
# hardcoded again in Info.plist/LaunchAgent.plist, which are sed templates
# filled in below) so there is exactly one place that knows the two flavors'
# identities.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

MODE="${1:-debug}"
PRODUCT_NAME="rt-tray"

case "$MODE" in
    debug)
        IS_DEV=false
        BUILD_CONFIG="debug"
        ;;
    dev)
        IS_DEV=true
        BUILD_CONFIG="release"
        ;;
    release|install)
        IS_DEV=false
        BUILD_CONFIG="release"
        ;;
    *)
        echo "  ✗ Unknown mode: $MODE (expected debug|release|dev|install)" >&2
        exit 1
        ;;
esac

if [ "$IS_DEV" = true ]; then
    APP_NAME="mattstack-dev"
    DISPLAY_NAME="mattstack-dev"
    BUNDLE_ID="com.mattstack.app.dev"
    DAEMON_LABEL="com.rt.daemon.dev"
else
    APP_NAME="mattstack"
    DISPLAY_NAME="mattstack"
    BUNDLE_ID="com.mattstack.app"
    DAEMON_LABEL="com.rt.daemon"
fi

APP_BUNDLE="$SCRIPT_DIR/$APP_NAME.app"

# ─── Build ────────────────────────────────────────────────────────────────────

echo "  Building $PRODUCT_NAME ($MODE)..."

if [ "$BUILD_CONFIG" = "debug" ]; then
    swift build 2>&1 | sed 's/^/  /'
    BINARY="$SCRIPT_DIR/.build/debug/$PRODUCT_NAME"
else
    if [ "$IS_DEV" = true ]; then
        # Dev flavor ships the shim as its rt-daemon (§3) — build both products.
        swift build -c release 2>&1 | sed 's/^/  /'
    else
        # Prod flavor never ships rt-daemon-shim — drop its compile step entirely.
        swift build -c release --product "$PRODUCT_NAME" 2>&1 | sed 's/^/  /'
    fi
    BINARY="$SCRIPT_DIR/.build/release/$PRODUCT_NAME"
    SHIM_BINARY="$SCRIPT_DIR/.build/release/rt-daemon-shim"
fi

if [ ! -f "$BINARY" ]; then
    echo "  ✗ Build failed — binary not found at $BINARY"
    exit 1
fi

echo "  ✓ Build succeeded"

# ─── Assemble .app bundle ────────────────────────────────────────────────────

if [ "$BUILD_CONFIG" = "debug" ]; then
    echo "  Skipping .app bundle assembly for debug build."
    echo "  Run: .build/debug/$PRODUCT_NAME"
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

# Convert notification sounds (mp3 → caf). UNNotificationSound only accepts
# AIFF/WAV/CAF and requires the file inside the app bundle's Resources/ dir
# (or ~/Library/Sounds, /Library/Sounds, /System/Library/Sounds).
SOUNDS_SRC="$SCRIPT_DIR/../sounds"
if [ -d "$SOUNDS_SRC" ]; then
    for mp3 in "$SOUNDS_SRC"/*.mp3; do
        [ -f "$mp3" ] || continue
        base=$(basename "$mp3" .mp3)
        out="$APP_BUNDLE/Contents/Resources/$base.caf"
        if afconvert -d LEI16@44100 -f caff "$mp3" "$out" 2>/dev/null; then
            echo "  ✓ $base.caf"
        else
            echo "  ⚠ afconvert failed for $base.mp3"
        fi
    done
else
    echo "  ⚠ sounds/ not found — notifications will fall back to system default"
fi

# Bundle the keyboard-conflict screenshot (shown in the fix-it window)
MC_SCREENSHOT="$SCRIPT_DIR/mission-control-screenshot.png"
if [ -f "$MC_SCREENSHOT" ]; then
    cp "$MC_SCREENSHOT" "$APP_BUNDLE/Contents/Resources/mission-control-screenshot.png"
    xattr -cr "$APP_BUNDLE/Contents/Resources/mission-control-screenshot.png" 2>/dev/null || true
    echo "  ✓ mission-control-screenshot.png"
else
    echo "  ⚠ mission-control-screenshot.png not found — conflict window will show placeholder"
fi

# Copy tray binary — source is $PRODUCT_NAME (SwiftPM), destination is $APP_NAME
# (bundle identity). These are the same string in prod today but diverge for dev.
cp "$BINARY" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

# ─── Embed daemon binary ──────────────────────────────────────────────────────
# Prod: Contents/MacOS/rt-daemon is the real compiled `rt` binary.
# Dev: Contents/MacOS/rt-daemon IS the shim (Sources-daemon-shim) — permanently
# the source-runner, not a swap payload (spec §3). RT_DAEMON_BIN env var wins
# for the prod path (CI passes the freshly-built rt binary); local dev falls
# back to whatever `rt` resolves to on PATH.

if [ "$IS_DEV" = true ]; then
    if [ ! -f "$SHIM_BINARY" ]; then
        echo "  ✗ rt-daemon-shim not built — dev bundle has no daemon without it"
        exit 1
    fi
    cp "$SHIM_BINARY" "$APP_BUNDLE/Contents/MacOS/rt-daemon"
    chmod +x "$APP_BUNDLE/Contents/MacOS/rt-daemon"
    echo "  ✓ Embedded rt-daemon-shim as Contents/MacOS/rt-daemon (dev source-runner)"
else
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
fi

# Ship LaunchAgent plist inside the bundle (SMAppService reads it from here).
# Installed filename matches the Label: com.rt.daemon.plist / com.rt.daemon.dev.plist.
mkdir -p "$APP_BUNDLE/Contents/Library/LaunchAgents"
AGENT_PLIST="$APP_BUNDLE/Contents/Library/LaunchAgents/$DAEMON_LABEL.plist"
sed -e "s/@@DAEMON_LABEL@@/$DAEMON_LABEL/g" \
    -e "s/@@BUNDLE_ID@@/$BUNDLE_ID/g" \
    "$SCRIPT_DIR/LaunchAgent.plist" > "$AGENT_PLIST"

# KeepAlive shape diverges by flavor (spec §1/§3): prod is a plain bool true;
# dev is { SuccessfulExit = false } so the shim's exit-0 (unconfigured
# precondition) paths stay down while real crashes still restart. Injected via
# PlistBuddy, not sed — a dict value can't be a single-line token substitution.
if [ "$IS_DEV" = true ]; then
    /usr/libexec/PlistBuddy -c "Add :KeepAlive dict" "$AGENT_PLIST"
    /usr/libexec/PlistBuddy -c "Add :KeepAlive:SuccessfulExit bool false" "$AGENT_PLIST"
else
    /usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "$AGENT_PLIST"
fi
echo "  ✓ LaunchAgent plist ($DAEMON_LABEL.plist) copied to Contents/Library/LaunchAgents"

# Fill in Info.plist template (BUNDLE_ID/APP_NAME/DISPLAY_NAME/DAEMON_LABEL live
# ONLY in this script) and inject version from git tag.
sed -e "s/@@APP_NAME@@/$APP_NAME/g" \
    -e "s/@@BUNDLE_ID@@/$BUNDLE_ID/g" \
    -e "s/@@DISPLAY_NAME@@/$DISPLAY_NAME/g" \
    -e "s/@@DAEMON_LABEL@@/$DAEMON_LABEL/g" \
    "$SCRIPT_DIR/Info.plist" > "$APP_BUNDLE/Contents/Info.plist"

if [ "$IS_DEV" = true ]; then
    /usr/libexec/PlistBuddy -c "Add :MSDevBuild bool true" "$APP_BUNDLE/Contents/Info.plist"
else
    /usr/libexec/PlistBuddy -c "Add :MSDevBuild bool false" "$APP_BUNDLE/Contents/Info.plist"
fi

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
#
# Dev signs with the SAME identity, bundle-wide (spec §1/§3): a nested ad-hoc
# binary inside a Developer-ID hardened-runtime bundle is an invalid signing
# config, so there is no dev-specific branch here — this block already applies
# uniformly to both flavors.

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

# 1. Embedded daemon — needs Bun JIT entitlements. In dev this file IS the
# shim (see the embed step above), so it's signed here too, keeping the
# `-i rt-daemon` identifier override: load-bearing, do not remove it — without
# it codesign keeps SwiftPM's default (rt-daemon-shim) and launchd rejects the
# binary with EX_CONFIG (cached LWCR was for identifier=rt-daemon).
DAEMON_BIN="$APP_BUNDLE/Contents/MacOS/rt-daemon"
if [ -f "$DAEMON_BIN" ]; then
    if [ "$IS_DEV" = true ]; then
        codesign "${SIGN_FLAGS[@]}" \
            -i rt-daemon \
            --entitlements "$SCRIPT_DIR/../scripts/entitlements.plist" \
            "$DAEMON_BIN"
        echo "  ✓ Signed rt-daemon (dev source-runner / shim) as identifier=rt-daemon"
    else
        codesign "${SIGN_FLAGS[@]}" \
            --entitlements "$SCRIPT_DIR/../scripts/entitlements.plist" \
            "$DAEMON_BIN"
        echo "  ✓ Signed rt-daemon with JIT entitlements"
    fi
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
# install always installs the prod flavor ($APP_NAME=mattstack here — MODE
# "install" forces IS_DEV=false above). There is no "dev install" mode yet;
# the dev bundle is built and run in place until a later task wires it up.

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
