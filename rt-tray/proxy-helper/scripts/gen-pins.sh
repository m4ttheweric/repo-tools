#!/bin/bash
set -euo pipefail
# Byte semantics for sort and for the path check in tree_hash, both of which the
# Swift side matches exactly.
export LC_ALL=C

# Writes Sources/ProxyInstall/Pins.generated.swift from rt-tray/deps.lock plus
# the payload the helper will copy. Nothing in the package supplies a fallback,
# so this has to run before ANY swift build or swift test of the helper.
#
# The payload paths are arguments, never derived, and there is no default. In a
# real build they are the bundle's SIGNED Helpers copies: codesign rewrites a
# Mach-O in place, so pins taken from the fetched dep describe bytes that never
# ship, and the helper then refuses its own payload at install time. A default
# would put that failure one forgotten argument away.
#
# usage: gen-pins.sh <app-version> <portless-dist-dir> <node-binary>
#   build (rt-tray/build.sh, after the helper signing pass):
#     gen-pins.sh 2.8.0 <app>/Contents/Helpers/portless-dist <app>/Contents/Helpers/node/bin/node
#   development, only to make `swift build` / `swift test` compile (their
#   fixtures never read Pins.current), after scripts/fetch-deps.sh arm64:
#     gen-pins.sh 0.0.0-dev rt-tray/deps/arm64/portless rt-tray/deps/arm64/node/bin/node

usage() {
    echo "usage: gen-pins.sh <app-version> <portless-dist-dir> <node-binary>" >&2
    echo "       gen-pins.sh --print-tree-hash <portless-dist-dir>" >&2
    echo "  dev: gen-pins.sh 0.0.0-dev rt-tray/deps/arm64/portless rt-tray/deps/arm64/node/bin/node" >&2
    echo "  build: the paths are the bundle's SIGNED Contents/Helpers copies, not the fetched deps" >&2
    exit 64
}

# Shape-checks the digest so an unreadable file fails the build rather than
# pinning an empty or partial hash.
file_hash() { # path -> 64 hex chars
    local path="$1" hex
    hex="$(shasum -a 256 "$path" 2>/dev/null | cut -d' ' -f1 || true)"
    if [[ ! "$hex" =~ ^[0-9a-f]{64}$ ]]; then
        echo "  x gen-pins: could not hash $path" >&2
        exit 1
    fi
    printf '%s' "$hex"
}

# sha256 over "<relative path>\n<sha256(content) hex>\n" for every regular file,
# concatenated in byte order of the relative path.
#
# Parity anchor: FileOps.treeHash in Sources/ProxyInstall/FileOps.swift recomputes
# this at install time and compares. The two definitions must stay byte-identical
# or every install refuses a payload that is in fact correct.
tree_hash() {
    local root="$1" rel hex odd count=0
    # Symlinks, fifos, sockets and devices alike: the Swift side throws on all of
    # them, so refusing here keeps both definitions describing the same trees.
    odd="$(cd "$root" && find . ! -type f ! -type d -print -quit)"
    if [ -n "$odd" ]; then
        echo "  x gen-pins: non-regular entry '${odd#./}' under $root; the pin cannot describe it" >&2
        exit 1
    fi
    # find reports the bytes on disk; Foundation reports them decomposed, so a
    # non-ASCII name would hash differently on the two sides of the pin. Both
    # sides refuse it instead, and this one refuses at build time.
    while IFS= read -r -d '' rel; do
        rel="${rel#./}"
        if [[ "$rel" =~ [^[:print:]] ]]; then
            echo "  x gen-pins: non-ASCII or control character in payload path '$rel' under $root" >&2
            exit 1
        fi
        count=$((count + 1))
    done < <(cd "$root" && find . -type f -print0)
    # An empty tree has a perfectly good digest of its own, so emptiness has to be
    # caught by counting rather than by inspecting the hash afterwards.
    if [ "$count" -eq 0 ]; then
        echo "  x gen-pins: no regular files under $root; refusing to pin an empty tree" >&2
        exit 1
    fi
    # The digest is captured into a variable rather than substituted into the
    # printf argument: nested inside one, a failing hash would exit only its own
    # subshell and printf would happily emit an empty field.
    ( cd "$root" && find . -type f -print0 | sort -z ) \
        | while IFS= read -r -d '' rel; do
              rel="${rel#./}"
              hex="$(shasum -a 256 "$root/$rel" 2>/dev/null | cut -d' ' -f1 || true)"
              if [[ ! "$hex" =~ ^[0-9a-f]{64}$ ]]; then
                  echo "  x gen-pins: could not hash '$rel' under $root" >&2
                  exit 1
              fi
              printf '%s\n%s\n' "$rel" "$hex"
          done \
        | shasum -a 256 | cut -d' ' -f1
}

# `--print-tree-hash <dir>` prints the pin definition's digest for one payload
# tree and exits. rt-tray/check-bundle.sh re-asserts the SHIPPED payload against
# the helper's compiled pins with it, the same way it re-asserts the node digest.
if [ "${1:-}" = "--print-tree-hash" ]; then
    [ -n "${2:-}" ] || usage
    [ -d "${2}" ] || { echo "  x gen-pins: no tree at ${2}" >&2; exit 1; }
    tree_hash "${2}"
    exit 0
fi

APP_VERSION="${1:-}"
TREE="${2:-}"
NODE_BIN="${3:-}"
[ -n "$APP_VERSION" ] && [ -n "$TREE" ] && [ -n "$NODE_BIN" ] || usage

HELPER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TRAY_DIR="$(cd "$HELPER_DIR/.." && pwd)"
LOCK="$TRAY_DIR/deps.lock"
OUT="$HELPER_DIR/Sources/ProxyInstall/Pins.generated.swift"
LOCK_NAME="portless"

[ -f "$LOCK" ] || { echo "  x gen-pins: $LOCK not found" >&2; exit 1; }

JQ=""
for candidate in "$TRAY_DIR/deps/arm64/jq" "$(command -v jq 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then JQ="$candidate"; break; fi
done

read_row() { # name<TAB>version<TAB>tarball-sha256
    if [ -n "$JQ" ]; then
        "$JQ" -r --arg n "$LOCK_NAME" \
            '[.tools[] | select(.name == $n)] as $r
             | if ($r | length) == 1 then ($r[0] | [.name, .version, .sha256] | @tsv)
               else ("expected exactly one \($n) row, found \($r | length)" | halt_error(1)) end' "$LOCK"
    elif command -v python3 >/dev/null 2>&1; then
        python3 - "$LOCK" "$LOCK_NAME" <<'PY'
import json, sys
rows = [t for t in json.load(open(sys.argv[1]))["tools"] if t.get("name") == sys.argv[2]]
if len(rows) != 1:
    sys.exit("expected exactly one %s row, found %d" % (sys.argv[2], len(rows)))
print("\t".join(rows[0][k] for k in ("name", "version", "sha256")))
PY
    else
        echo "  x gen-pins: no jq (bundled or on PATH) and no python3 to read $LOCK" >&2
        exit 1
    fi
}

ROW="$(read_row)"
IFS=$'\t' read -r P_NAME P_VERSION P_SHA <<< "$ROW"
[ -n "$P_NAME" ] && [ -n "$P_VERSION" ] && [ -n "$P_SHA" ] || {
    echo "  x gen-pins: incomplete $LOCK_NAME row: '$ROW'" >&2; exit 1
}

[ -d "$TREE" ] || { echo "  x gen-pins: no portless tree at $TREE" >&2; exit 1; }

TREE_SHA="$(tree_hash "$TREE")"

# Only the interpreter is installed into the root-owned tree, so only it is
# pinned; the rest of the node distribution never leaves the bundle.
if [ -L "$NODE_BIN" ]; then
    echo "  x gen-pins: $NODE_BIN is a symlink; the pin cannot describe it" >&2; exit 1
fi
if [ ! -f "$NODE_BIN" ]; then
    echo "  x gen-pins: $NODE_BIN is not a regular file" >&2; exit 1
fi
NODE_SHA="$(file_hash "$NODE_BIN")"

# Every value below lands inside a Swift string literal, so anything that could
# close one is refused rather than escaped.
for value in "$P_VERSION" "$P_SHA" "$TREE_SHA" "$NODE_SHA" "$APP_VERSION"; do
    case "$value" in
        *[!A-Za-z0-9._+-]*) echo "  x gen-pins: refusing unsafe pin value '$value'" >&2; exit 1 ;;
    esac
done

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<EOF
// Generated by rt-tray/proxy-helper/scripts/gen-pins.sh. Do not edit, do not commit.
let PINS_CURRENT = PinsValues(
    portlessVersion: "$P_VERSION",
    portlessTarballSha256: "$P_SHA",
    portlessTreeSha256: "$TREE_SHA",
    nodeBinSha256: "$NODE_SHA",
    appVersion: "$APP_VERSION")
enum Pins { static let current = PINS_CURRENT }
enum HelperVersion { static let value = Pins.current.appVersion }
EOF
echo "  ✓ Pins.generated.swift (portless $P_VERSION, tree ${TREE_SHA:0:12}, node ${NODE_SHA:0:12}, app $APP_VERSION)"
