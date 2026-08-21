#!/bin/bash
set -euo pipefail

# ─── rt-tray build script ───────────────────────────────────────────────────
# Compiles the Swift source, assembles the .app bundle, and optionally signs it.
#
# Usage:
#   ./build.sh              Build debug (rt-tray SwiftPM product, unbundled)
#   ./build.sh release      Build release + assemble mattstack.app (prod)
#   ./build.sh dev          Build release + assemble mattstack-dev.app (dev)
#   ./build.sh install      Build release + install mattstack.app to /Applications
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
    DAEMON_LABEL="com.mattstack.daemon.dev"
else
    APP_NAME="mattstack"
    DISPLAY_NAME="mattstack"
    BUNDLE_ID="com.mattstack.app"
    DAEMON_LABEL="com.mattstack.daemon"
fi

APP_BUNDLE="$SCRIPT_DIR/$APP_NAME.app"

# ─── Build ────────────────────────────────────────────────────────────────────

echo "  Building $PRODUCT_NAME ($MODE)..."

if [ "$BUILD_CONFIG" = "debug" ]; then
    swift build 2>&1 | sed 's/^/  /'
    BINARY="$SCRIPT_DIR/.build/debug/$PRODUCT_NAME"
else
    if [ "$IS_DEV" = true ]; then
        # Dev flavor ships the shim as Contents/MacOS/rt — build both products.
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

# Generate app icons (draws "m" via Core Graphics → iconutil → .icns).
# make-icon.swift produces BOTH flavors in one run: AppIcon.icns (prod) and
# AppIcon-dev.icns (dev, tinted amber). Regenerate only if either is missing
# — delete both to force a rebuild.
if [ ! -f "$SCRIPT_DIR/AppIcon.icns" ] || [ ! -f "$SCRIPT_DIR/AppIcon-dev.icns" ]; then
    echo "  Generating AppIcon.icns + AppIcon-dev.icns..."
    swift "$SCRIPT_DIR/make-icon.swift"
else
    echo "  AppIcon.icns + AppIcon-dev.icns already exist — skipping generation (delete to regenerate)"
fi

if [ "$IS_DEV" = true ]; then
    ICON_SRC="$SCRIPT_DIR/AppIcon-dev.icns"
else
    ICON_SRC="$SCRIPT_DIR/AppIcon.icns"
fi

if [ -f "$ICON_SRC" ]; then
    # Bundle-internal name stays AppIcon.icns for both flavors — that's what
    # Info.plist's CFBundleIconFile names; only the source file differs.
    cp "$ICON_SRC" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
    echo "  ✓ $(basename "$ICON_SRC") copied to Resources as AppIcon.icns"
else
    echo "  ⚠ $(basename "$ICON_SRC") not found — notifications will show a default icon"
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
# Prod: Contents/MacOS/rt is the real compiled `rt` binary.
# Dev: Contents/MacOS/rt IS the shim (Sources-daemon-shim) — permanently
# the source-runner, not a swap payload (spec §3). RT_DAEMON_BIN env var wins
# for the prod path (CI passes the freshly-built rt binary); local dev falls
# back to whatever `rt` resolves to on PATH.

if [ "$IS_DEV" = true ]; then
    if [ ! -f "$SHIM_BINARY" ]; then
        echo "  ✗ rt-daemon-shim not built — dev bundle has no daemon without it"
        exit 1
    fi
    cp "$SHIM_BINARY" "$APP_BUNDLE/Contents/MacOS/rt"
    chmod +x "$APP_BUNDLE/Contents/MacOS/rt"
    echo "  ✓ Embedded rt-daemon-shim as Contents/MacOS/rt (dev source-runner)"
else
    # Resolution order: an explicit RT_DAEMON_BIN (what CI sets), then the
    # repo's own compiled binary, then whatever `rt` is on PATH. The PATH
    # entry is LAST and is validated below, because on a dev-mode machine it
    # is the wrapper SCRIPT (~/.local/bin/rt, which execs bun against the
    # source checkout). Embedding that as a prod bundle's daemon produces an
    # app that installs cleanly and then never starts its daemon.
    DAEMON_SRC="${RT_DAEMON_BIN:-}"
    if [ -z "$DAEMON_SRC" ] && [ -f "$SCRIPT_DIR/../dist/rt" ]; then
        DAEMON_SRC="$SCRIPT_DIR/../dist/rt"
    fi
    if [ -z "$DAEMON_SRC" ]; then
        DAEMON_SRC="$(command -v rt 2>/dev/null || true)"
    fi

    # A prod daemon must be a real executable, never a script: `file` reports
    # Mach-O for the compiled binary and "script text" for the dev wrapper.
    if [ -n "$DAEMON_SRC" ] && [ -f "$DAEMON_SRC" ] && ! file -b "$DAEMON_SRC" | grep -q "Mach-O"; then
        echo "  ✗ $DAEMON_SRC is not a compiled binary (dev-mode wrapper?)"
        echo "    Build one with: bun run build   (or set RT_DAEMON_BIN)"
        exit 1
    fi

    if [ -n "$DAEMON_SRC" ] && [ -f "$DAEMON_SRC" ]; then
        cp "$DAEMON_SRC" "$APP_BUNDLE/Contents/MacOS/rt"
        chmod +x "$APP_BUNDLE/Contents/MacOS/rt"
        echo "  ✓ Embedded rt from $DAEMON_SRC"
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

# Anchored at both ends: "2.8.0-rc1" must not silently pass as "2.8.0" and
# collide with the real release's CFBundleVersion. A non-semver RT_VERSION
# aborts the build instead of writing CFBundleVersion=0 (indistinguishable
# from a real build-0 bug once it's in a shipped Info.plist).
numeric_build() {
    local v="${1#v}"
    if [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        echo $(( BASH_REMATCH[1] * 1000000 + BASH_REMATCH[2] * 1000 + BASH_REMATCH[3] ))
    else
        return 1
    fi
}
RT_VERSION="${RT_VERSION:-$(cd "$SCRIPT_DIR/.." && git describe --tags --abbrev=0 2>/dev/null || echo dev)}"
RT_VERSION="${RT_VERSION#v}"  # strip leading 'v'
if [ "$RT_VERSION" != "dev" ]; then
    RT_BUILD="$(numeric_build "$RT_VERSION")" || { echo "  ✗ RT_VERSION '$RT_VERSION' is not semver (expected X.Y.Z)" >&2; exit 1; }
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $RT_VERSION" "$APP_BUNDLE/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $RT_BUILD" "$APP_BUNDLE/Contents/Info.plist"
    echo "  ✓ Version set to $RT_VERSION (build $RT_BUILD)"
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
# shim (see the embed step above), so it's signed here too. The `-i rt`
# identifier override is load-bearing on both branches, do not remove it —
# without it codesign keeps SwiftPM's default product name and launchd
# rejects the binary with EX_CONFIG (cached LWCR was for a different identifier).
DAEMON_BIN="$APP_BUNDLE/Contents/MacOS/rt"
if [ -f "$DAEMON_BIN" ]; then
    if [ "$IS_DEV" = true ]; then
        codesign "${SIGN_FLAGS[@]}" \
            -i rt \
            --entitlements "$SCRIPT_DIR/../scripts/entitlements.plist" \
            "$DAEMON_BIN"
        echo "  ✓ Signed rt (dev source-runner / shim) as identifier=rt"
    else
        codesign "${SIGN_FLAGS[@]}" \
            -i rt \
            --entitlements "$SCRIPT_DIR/../scripts/entitlements.plist" \
            "$DAEMON_BIN"
        echo "  ✓ Signed rt with JIT entitlements as identifier=rt"
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
    INSTALL_DIR="/Applications"
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
