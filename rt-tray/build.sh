#!/bin/bash
set -euo pipefail

# ─── mattstack.app build ─────────────────────────────────────────────────────
# Usage:
#   ./build.sh            debug: swift build only, no bundle
#   ./build.sh release    mattstack.app (prod)
#   ./build.sh dev        mattstack-dev.app (dev; Contents/MacOS/rt is the source-runner shim)
#   ./build.sh install    release + copy to /Applications + launch
#
# Env: RT_DAEMON_BIN RT_VSIX RT_VERSION RT_REQUIRE_DEPS SPARKLE_PUBLIC_ED_KEY RT_BUILD_TOOL
#
# The bundle id, daemon label, and display name live ONLY here; Info.plist is a
# sed template and the LaunchAgent plists come from scripts/render-launchagents.sh.
# The tray binary comes from xcodebuild (when Xcode + project.yml exist) or
# swift build; both feed the SAME assemble + sign path, so the bundle contract
# (check-bundle.sh) is identical either way.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

MODE="${1:-debug}"
PRODUCT_NAME="rt-tray"

case "$MODE" in
    debug)            IS_DEV=false; BUILD_CONFIG="debug" ;;
    dev)              IS_DEV=true;  BUILD_CONFIG="release" ;;
    release|install)  IS_DEV=false; BUILD_CONFIG="release" ;;
    *) echo "  ✗ Unknown mode: $MODE (expected debug|release|dev|install)" >&2; exit 1 ;;
esac

if [ "$IS_DEV" = true ]; then
    APP_NAME="mattstack-dev"; DISPLAY_NAME="mattstack-dev"
    BUNDLE_ID="com.mattstack.app.dev"; DAEMON_LABEL="com.mattstack.daemon.dev"
    SCHEME="mattstack-dev"
else
    APP_NAME="mattstack"; DISPLAY_NAME="mattstack"
    BUNDLE_ID="com.mattstack.app"; DAEMON_LABEL="com.mattstack.daemon"
    SCHEME="mattstack"
fi

APP_BUNDLE="$SCRIPT_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
DEPS_DIR="$SCRIPT_DIR/deps/arm64"
SU_FEED_URL="https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml"
ENTITLEMENTS_JIT="$REPO_DIR/scripts/entitlements.plist"

# Anchored at both ends: "2.8.0-rc1" must not silently pass as "2.8.0" and
# collide with the real release's CFBundleVersion.
numeric_build() {
    local v="${1#v}"
    if [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        echo $(( BASH_REMATCH[1] * 1000000 + BASH_REMATCH[2] * 1000 + BASH_REMATCH[3] ))
    else
        return 1
    fi
}

# bash's `read` treats tab as "IFS whitespace" and collapses runs of it even
# when IFS is set to only tab, dropping empty TSV fields (deps.lock's pending
# rows carry several) and shifting every later field left. Split by hand so
# an empty field stays a field.
split_tsv() {
    local rest="$1" field
    FIELDS=()
    while [[ "$rest" == *$'\t'* ]]; do
        field="${rest%%$'\t'*}"
        FIELDS+=("$field")
        rest="${rest#*$'\t'}"
    done
    FIELDS+=("$rest")
}

# ─── Which compiler ──────────────────────────────────────────────────────────
if [ -z "${RT_BUILD_TOOL:-}" ]; then
    if xcodebuild -version >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/project.yml" ]; then RT_BUILD_TOOL=xcode; else RT_BUILD_TOOL=swift; fi
fi
echo "  Building $APP_NAME ($MODE) with $RT_BUILD_TOOL..."

XCODE_APP=""
if [ "$RT_BUILD_TOOL" = xcode ]; then
    command -v xcodegen >/dev/null || { echo "  ✗ xcodegen not found (brew install xcodegen)"; exit 1; }
    xcodegen generate --spec "$SCRIPT_DIR/project.yml" --project "$SCRIPT_DIR" >/dev/null
    DERIVED="$SCRIPT_DIR/.build-xcode"
    xcodebuild -project "$SCRIPT_DIR/mattstack.xcodeproj" -scheme "$SCHEME" -configuration Release \
        -derivedDataPath "$DERIVED" -destination 'platform=macOS,arch=arm64' \
        CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build 2>&1 | sed 's/^/  /'
    XCODE_APP="$DERIVED/Build/Products/Release/$APP_NAME.app"
    [ -d "$XCODE_APP" ] || { echo "  ✗ xcodebuild produced no $XCODE_APP"; exit 1; }
    BINARY="$XCODE_APP/Contents/MacOS/$APP_NAME"
    if [ "$IS_DEV" = true ]; then
        swift build -c release --product rt-daemon-shim 2>&1 | sed 's/^/  /'
        SHIM_BINARY="$SCRIPT_DIR/.build/release/rt-daemon-shim"
    fi
else
    if [ "$BUILD_CONFIG" = "debug" ]; then
        swift build 2>&1 | sed 's/^/  /'
        BINARY="$SCRIPT_DIR/.build/debug/$PRODUCT_NAME"
    elif [ "$IS_DEV" = true ]; then
        swift build -c release 2>&1 | sed 's/^/  /'
        BINARY="$SCRIPT_DIR/.build/release/$PRODUCT_NAME"
        SHIM_BINARY="$SCRIPT_DIR/.build/release/rt-daemon-shim"
    else
        swift build -c release --product "$PRODUCT_NAME" 2>&1 | sed 's/^/  /'
        BINARY="$SCRIPT_DIR/.build/release/$PRODUCT_NAME"
    fi
fi
[ -f "$BINARY" ] || { echo "  ✗ Build failed — binary not found at $BINARY"; exit 1; }
echo "  ✓ Build succeeded"

if [ "$BUILD_CONFIG" = "debug" ]; then
    echo "  Skipping .app bundle assembly for debug build."
    echo "  Run: $BINARY"
    exit 0
fi

# ─── Assemble ────────────────────────────────────────────────────────────────
echo "  Assembling $APP_NAME.app..."
rm -rf "$APP_BUNDLE"
if [ -n "$XCODE_APP" ]; then
    ditto "$XCODE_APP" "$APP_BUNDLE"
    # xcodebuild's own (unsigned) signature would otherwise ride along and
    # confuse the inside-out signing pass below.
    find "$APP_BUNDLE" -name '_CodeSignature' -prune -exec rm -rf {} + 2>/dev/null || true
else
    mkdir -p "$CONTENTS/MacOS"
    cp "$BINARY" "$CONTENTS/MacOS/$APP_NAME"
fi
mkdir -p "$CONTENTS/Resources" "$CONTENTS/Helpers" "$CONTENTS/Frameworks" "$CONTENTS/Library/LaunchAgents"

# Icons (make-icon.swift emits both flavors; bundle-internal name is always AppIcon.icns).
if [ ! -f "$SCRIPT_DIR/AppIcon.icns" ] || [ ! -f "$SCRIPT_DIR/AppIcon-dev.icns" ]; then
    echo "  Generating AppIcon.icns + AppIcon-dev.icns..."; swift "$SCRIPT_DIR/make-icon.swift"
fi
ICON_SRC="$SCRIPT_DIR/AppIcon.icns"; [ "$IS_DEV" = true ] && ICON_SRC="$SCRIPT_DIR/AppIcon-dev.icns"
[ -f "$ICON_SRC" ] && cp "$ICON_SRC" "$CONTENTS/Resources/AppIcon.icns" && echo "  ✓ $(basename "$ICON_SRC") → AppIcon.icns"

# Notification sounds (UNNotificationSound needs caf inside Resources).
if [ -d "$REPO_DIR/sounds" ]; then
    for mp3 in "$REPO_DIR"/sounds/*.mp3; do
        [ -f "$mp3" ] || continue
        afconvert -d LEI16@44100 -f caff "$mp3" "$CONTENTS/Resources/$(basename "$mp3" .mp3).caf" 2>/dev/null && echo "  ✓ $(basename "$mp3" .mp3).caf"
    done
fi
[ -f "$SCRIPT_DIR/mission-control-screenshot.png" ] && cp "$SCRIPT_DIR/mission-control-screenshot.png" "$CONTENTS/Resources/" && xattr -cr "$CONTENTS/Resources/mission-control-screenshot.png" 2>/dev/null || true

# ─── Embed rt (Contents/MacOS/rt) ────────────────────────────────────────────
# Prod: the compiled rt. Dev: the shim, permanently (the dev flavor runs the
# daemon from source). A script is never a valid prod daemon.
if [ "$IS_DEV" = true ]; then
    [ -f "$SHIM_BINARY" ] || { echo "  ✗ rt-daemon-shim not built"; exit 1; }
    cp "$SHIM_BINARY" "$CONTENTS/MacOS/rt"; chmod +x "$CONTENTS/MacOS/rt"
    echo "  ✓ Embedded the source-runner shim as Contents/MacOS/rt"
else
    DAEMON_SRC="${RT_DAEMON_BIN:-}"
    [ -z "$DAEMON_SRC" ] && [ -f "$REPO_DIR/dist/rt" ] && DAEMON_SRC="$REPO_DIR/dist/rt"
    [ -z "$DAEMON_SRC" ] && DAEMON_SRC="$(command -v rt 2>/dev/null || true)"
    if [ -n "$DAEMON_SRC" ] && [ -f "$DAEMON_SRC" ] && ! file -b "$DAEMON_SRC" | grep -q "Mach-O"; then
        echo "  ✗ $DAEMON_SRC is not a compiled binary (dev-mode wrapper?) — bun run build, or set RT_DAEMON_BIN"; exit 1
    fi
    if [ -n "$DAEMON_SRC" ] && [ -f "$DAEMON_SRC" ]; then
        cp "$DAEMON_SRC" "$CONTENTS/MacOS/rt"; chmod +x "$CONTENTS/MacOS/rt"
        echo "  ✓ Embedded rt from $DAEMON_SRC"
    else
        echo "  ⚠ rt binary not found — Contents/MacOS/rt will be missing (set RT_DAEMON_BIN)"
    fi
fi

# ─── Helpers from deps.lock ──────────────────────────────────────────────────
# Iterates deps.lock rows rather than copying deps/arm64/* wholesale: the deps
# dir also carries <tool>.sha256 stamp files beside each tool, and a
# wholesale copy would carry those into the signed bundle.
HELPER_ENTITLEMENTS=()   # "path<TAB>jit|none" for the signing pass
bundle_helpers() {
    if [ ! -d "$DEPS_DIR" ]; then
        if [ "${RT_REQUIRE_DEPS:-0}" = 1 ]; then echo "  ✗ $DEPS_DIR missing — run scripts/fetch-deps.sh arm64"; exit 1; fi
        echo "  ⚠ $DEPS_DIR missing — Helpers skipped (scripts/fetch-deps.sh arm64 to bundle them)"
        return
    fi
    local tsv row name version bundlePath ent status
    tsv="$(mktemp /tmp/mattstack-deps-lock.XXXXXX)"
    bun "$REPO_DIR/scripts/lib/deps-lock.ts" --kind helper > "$tsv"
    while IFS= read -r row; do
        [ -n "$row" ] || continue
        split_tsv "$row"
        name="${FIELDS[0]}"; version="${FIELDS[1]}"; bundlePath="${FIELDS[6]}"; ent="${FIELDS[7]}"; status="${FIELDS[8]}"
        if [ "$status" != bundled ]; then echo "  · $name: pending, not in this build"; continue; fi
        src="$DEPS_DIR/$name"
        [ -e "$src" ] || { echo "  ✗ $name not fetched at $src — run scripts/fetch-deps.sh arm64"; rm -f "$tsv"; exit 1; }
        dest="$APP_BUNDLE/$bundlePath"
        rm -rf "$dest"; mkdir -p "$(dirname "$dest")"
        cp -R "$src" "$dest"
        xattr -cr "$dest" 2>/dev/null || true
        # codesign's bundle-resource seal treats any directory whose name contains
        # a "." as a nested bundle that must itself carry a valid signature — and a
        # plain resource directory can never be signed as one (a vendored tool's
        # dotfile-style config dirs, e.g. a plugin manifest folder, are the usual
        # source). Prune them; none of that is needed once the tool is embedded.
        find "$dest" -depth -type d -name '*.*' -print0 | xargs -0 rm -rf
        HELPER_ENTITLEMENTS+=("$dest	$ent")
        echo "  ✓ Helpers/$name $version"
    done < "$tsv"
    rm -f "$tsv"
    cp "$SCRIPT_DIR/deps.lock" "$CONTENTS/Resources/deps.lock"
}
bundle_helpers

# ─── Extension ───────────────────────────────────────────────────────────────
if [ -n "${RT_VSIX:-}" ]; then
    [ -f "$RT_VSIX" ] || { echo "  ✗ RT_VSIX=$RT_VSIX not found"; exit 1; }
    cp "$RT_VSIX" "$CONTENTS/Resources/rt-context.vsix" && echo "  ✓ rt-context.vsix"
fi

# ─── Sparkle framework (swift-build path copies the SPM artifact; xcodebuild embeds it itself) ───
embed_sparkle() {
    [ -d "$CONTENTS/Frameworks/Sparkle.framework" ] && { echo "  ✓ Sparkle.framework (embedded by xcodebuild)"; return; }
    local fw
    fw="$(find "$SCRIPT_DIR/.build/artifacts" -type d -name 'Sparkle.framework' -path '*macos-arm64*' 2>/dev/null | head -1)"
    if [ -z "$fw" ]; then echo "  ⚠ Sparkle.framework not in .build/artifacts — Package.swift has no Sparkle dependency yet; updater disabled in this build"; return; fi
    ditto "$fw" "$CONTENTS/Frameworks/Sparkle.framework"
    echo "  ✓ Sparkle.framework → Contents/Frameworks"
}
embed_sparkle

# ─── LaunchAgent plists (daemon + deck; rendered by the template script) ─────
# Both plists carry KeepAlive {SuccessfulExit:false} and the static PATH
# /usr/bin:/bin:/usr/sbin:/sbin — rt and deck prepend their own bundle's
# Contents/Helpers and $HOME/.local/bin at process start, so no install
# location is ever baked into a plist.
mkdir -p "$CONTENTS/Library/LaunchAgents"
"$SCRIPT_DIR/scripts/render-launchagents.sh" "$([ "$IS_DEV" = true ] && echo dev || echo prod)" "$CONTENTS/Library/LaunchAgents"
echo "  ✓ LaunchAgent plists ($DAEMON_LABEL.plist, ${DAEMON_LABEL/daemon/deck}.plist)"

# ─── Info.plist: identity (template) + version + Sparkle keys ─────────────────
INFO="$CONTENTS/Info.plist"
sed -e "s/@@APP_NAME@@/$APP_NAME/g" -e "s/@@BUNDLE_ID@@/$BUNDLE_ID/g" \
    -e "s/@@DISPLAY_NAME@@/$DISPLAY_NAME/g" -e "s/@@DAEMON_LABEL@@/$DAEMON_LABEL/g" \
    "$SCRIPT_DIR/Info.plist" > "$INFO"
# The template already declares LSMinimumSystemVersion, CFBundleURLTypes and the
# SU* keys; PlistBuddy "Add" fails on an existing key, so every write below goes
# through plist_set (Set, creating the key only when the template lacks it).
plist_set() { # key type value
    /usr/libexec/PlistBuddy -c "Set :$1 $3" "$INFO" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$INFO"
}
plist_set MSDevBuild bool "$IS_DEV"
plist_set LSMinimumSystemVersion string 14.0

RT_VERSION="${RT_VERSION:-$(cd "$REPO_DIR" && git describe --tags --abbrev=0 2>/dev/null || echo dev)}"
RT_VERSION="${RT_VERSION#v}"
if [ "$RT_VERSION" != "dev" ]; then
    RT_BUILD="$(numeric_build "$RT_VERSION")" || { echo "  ✗ RT_VERSION '$RT_VERSION' is not semver (expected X.Y.Z)" >&2; exit 1; }
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $RT_VERSION" "$INFO"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $RT_BUILD" "$INFO"
    echo "  ✓ Version $RT_VERSION (build $RT_BUILD)"
fi

PUBLIC_KEY="${SPARKLE_PUBLIC_ED_KEY:-}"
[ -z "$PUBLIC_KEY" ] && [ -f "$SCRIPT_DIR/SUPublicEDKey" ] && PUBLIC_KEY="$(tr -d '[:space:]' < "$SCRIPT_DIR/SUPublicEDKey")"
if [ "$IS_DEV" = true ]; then
    plist_set SUEnableAutomaticChecks bool false
else
    plist_set SUFeedURL string "$SU_FEED_URL"
    plist_set SUEnableAutomaticChecks bool true
    plist_set SUScheduledCheckInterval integer 21600
    plist_set SUAutomaticallyUpdate bool true
    plist_set SUVerifyUpdateBeforeExtraction bool true
fi
if [ -n "$PUBLIC_KEY" ]; then
    plist_set SUPublicEDKey string "$PUBLIC_KEY"
    echo "  ✓ SUPublicEDKey set"
else
    # No key file/env yet — the template's own placeholder value stays in
    # place so an unsigned local build still assembles.
    echo "  ⚠ no Sparkle public key (rt-tray/SUPublicEDKey or SPARKLE_PUBLIC_ED_KEY) — updates cannot be verified by this build"
fi
echo -n "APPL????" > "$CONTENTS/PkgInfo"
echo "  ✓ App bundle assembled at $APP_BUNDLE"

# ─── Sign, inside-out ────────────────────────────────────────────────────────
# Order: Sparkle XPCs → Autoupdate → Updater.app → Sparkle.framework →
# Helpers → Contents/MacOS/rt → outer app. Never --deep (it rewrites the
# Sparkle XPC signatures and breaks updates while notarization still passes).
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
sign() { codesign "${SIGN_FLAGS[@]}" "$@"; }

# A bundle this large (Helpers alone can carry thousands of resource files —
# node ships its own npm CLI tree) hits an environment-dependent codesign
# quirk: any file the writing process is marked as having provenance-tracked
# gets treated as unsealed nested code, not an ordinary resource, and the
# final outer-bundle seal refuses to complete until it already carries a
# signature. A parallel, entitlement-free pass over every file up front
# satisfies that for the whole tree; every precise signing step below
# (Sparkle, Helpers, Contents/MacOS/rt, the outer bundle itself) then
# overwrites the pieces that need a real identifier/entitlements/timestamp.
# Best-effort: a handful of resource files (broken symlinks, sockets) can
# make an individual codesign invocation fail, which would otherwise abort
# the whole build here under `set -e` — the precise passes below and
# check-bundle.sh's deep, strict verify are what actually gate success.
find "$APP_BUNDLE" -type f -print0 | xargs -0 -P 8 -I{} sh -c 'codesign --force --sign "$1" "$2" >/dev/null 2>&1' _ "$SIGNING_IDENTITY" {} || true

SPARKLE_FW="$CONTENTS/Frameworks/Sparkle.framework"
if [ -d "$SPARKLE_FW" ]; then
    V="$SPARKLE_FW/Versions/B"
    sign "$V/XPCServices/Installer.xpc"
    sign --preserve-metadata=entitlements "$V/XPCServices/Downloader.xpc"
    sign "$V/Autoupdate"
    sign "$V/Updater.app"
    sign "$SPARKLE_FW"
    echo "  ✓ Signed Sparkle.framework (inside-out)"
fi

sign_helper_tree() { # root ent — signs every Mach-O under root (files or a dir like node/)
    local root="$1" ent="$2" f
    while IFS= read -r -d '' f; do
        if file -b "$f" | grep -q "Mach-O"; then
            if [ "$ent" = jit ]; then sign -i "com.mattstack.helper.$(basename "$f")" --entitlements "$ENTITLEMENTS_JIT" "$f"
            else sign -i "com.mattstack.helper.$(basename "$f")" "$f"; fi
        fi
    done < <(find "$root" -type f -print0)
}
for entry in "${HELPER_ENTITLEMENTS[@]+"${HELPER_ENTITLEMENTS[@]}"}"; do
    path="${entry%%	*}"; ent="${entry##*	}"
    sign_helper_tree "$path" "$ent"
    echo "  ✓ Signed Helpers/$(basename "$path") ($ent)"
done

if [ -f "$CONTENTS/MacOS/rt" ]; then
    sign -i rt --entitlements "$ENTITLEMENTS_JIT" "$CONTENTS/MacOS/rt"
    echo "  ✓ Signed Contents/MacOS/rt (identifier rt, jit)"
fi

sign --entitlements /dev/stdin <<EOF "$APP_BUNDLE"
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
# A deep, strict verify runs separately in check-bundle.sh per flavor; this
# is just a fast sanity check that signing didn't obviously fail.
codesign --verify --strict "$APP_BUNDLE" 2>/dev/null && echo "  ✓ Signature verified" || { echo "  ✗ Signature verification failed"; exit 1; }

# ─── Install ─────────────────────────────────────────────────────────────────
if [ "$MODE" = "install" ]; then
    INSTALL_DIR="/Applications"
    if pkill -f "$APP_NAME.app/Contents/MacOS/$APP_NAME" 2>/dev/null; then
        for _ in $(seq 1 20); do pgrep -f "$APP_NAME.app/Contents/MacOS/$APP_NAME" >/dev/null 2>&1 || break; sleep 0.1; done
    fi
    rm -rf "$INSTALL_DIR/$APP_NAME.app"
    ditto "$APP_BUNDLE" "$INSTALL_DIR/$APP_NAME.app"
    echo "  ✓ Installed to $INSTALL_DIR/$APP_NAME.app"
    open "$INSTALL_DIR/$APP_NAME.app"
fi
echo ""
echo "  Done."
