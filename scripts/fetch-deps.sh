#!/bin/bash
# scripts/fetch-deps.sh [arm64] [--lock]
# Downloads every bundled tool in rt-tray/deps.lock, verifies sha256, and
# unpacks it into rt-tray/deps/<arch>/<name> (helpers) or
# rt-tray/deps/tools/<name> (build tools). --lock fills EMPTY sha256 fields
# from the downloads and rewrites deps.lock (for adding a tool); it never
# overwrites a non-empty hash.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="arm64"
WRITE_LOCK=false
for a in "$@"; do
  case "$a" in
    arm64) ARCH=arm64 ;;
    --lock) WRITE_LOCK=true ;;
    *) echo "usage: $0 [arm64] [--lock]" >&2; exit 2 ;;
  esac
done

LOCK="$ROOT/rt-tray/deps.lock"
DEPS="$ROOT/rt-tray/deps/$ARCH"
TOOLS="$ROOT/rt-tray/deps/tools"
CACHE="${RT_DEPS_CACHE:-$HOME/Library/Caches/mattstack-deps}"
mkdir -p "$DEPS" "$TOOLS" "$CACHE"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

fetch() { # url sha → prints cached path
  local url="$1" want="$2" name dest
  name="$(basename "$url")"
  dest="$CACHE/${want:-nohash}-$name"
  if [ ! -f "$dest" ]; then
    curl -fsSL --retry 3 -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
  if [ -n "$want" ] && [ "$(sha "$dest")" != "$want" ]; then
    echo "  x sha256 mismatch for $name (want $want, got $(sha "$dest"))" >&2
    rm -f "$dest"
    exit 1
  fi
  echo "$dest"
}

unpack() { # archive-file archive-kind extract-path dest
  local file="$1" kind="$2" extract="$3" dest="$4" tmp
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  case "$kind" in
    raw) cp "$file" "$dest"; chmod 755 "$dest" ;;
    tar.gz|tar.xz|npm)
      tmp="$(mktemp -d)"
      tar -xf "$file" -C "$tmp"
      if [ -n "$extract" ]; then cp -R "$tmp/$extract" "$dest"; else cp -R "$tmp" "$dest"; fi
      rm -rf "$tmp" ;;
    zip)
      tmp="$(mktemp -d)"
      ditto -x -k "$file" "$tmp"
      cp -R "$tmp/$extract" "$dest"
      rm -rf "$tmp" ;;
    *) echo "  x unknown archive kind $kind" >&2; exit 1 ;;
  esac
  [ -d "$dest" ] || chmod 755 "$dest"
}

# The lock's bundlePath/exec are already traversal-safe (parseDepsLock rejects
# ".." and absolute paths); "name" drives the fetch destination directly and
# isn't validated there, so it gets its own guard before it reaches a path.
assert_safe_name() {
  case "$1" in
    */*|..|*..*) echo "  x refusing unsafe tool name: $1" >&2; exit 1 ;;
  esac
}

# bash's `read` treats tab as "IFS whitespace" and silently collapses runs of
# it, dropping empty TSV fields (deps.lock has several: extract="", pending
# rows' url/sha256) and shifting every field after one left. Split by hand.
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

NEW_HASHES=()
FAILED=false
while IFS= read -r line; do
  split_tsv "$line"
  name="${FIELDS[0]}"; version="${FIELDS[1]}"; url="${FIELDS[2]}"; sha="${FIELDS[3]}"
  archive="${FIELDS[4]}"; extract="${FIELDS[5]}"; kind="${FIELDS[9]}"; status="${FIELDS[8]}"
  if [ "$status" != "bundled" ]; then
    echo "  . $name: pending (not bundled in this build)"
    continue
  fi
  assert_safe_name "$name"
  if [ "$kind" = "buildtool" ]; then dest="$TOOLS/$name"; else dest="$DEPS/$name"; fi
  stamp="$dest.sha256"

  if [ -z "$sha" ]; then
    if ! $WRITE_LOCK; then
      echo "  x $name has no sha256 in deps.lock — run $0 --lock" >&2
      FAILED=true
      continue
    fi
    file="$(fetch "$url" "")"
    sha="$(sha "$file")"
    NEW_HASHES+=("$name=$sha")
  fi

  if [ -e "$dest" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$sha" ]; then
    echo "  = $name $version already verified → ${dest#$ROOT/}"
    continue
  fi

  file="$(fetch "$url" "$sha")"
  unpack "$file" "$archive" "$extract" "$dest"
  echo "$sha" > "$stamp"
  echo "  + $name $version -> ${dest#$ROOT/}"
done < <(bun "$ROOT/scripts/lib/deps-lock.ts")

if $WRITE_LOCK && [ ${#NEW_HASHES[@]} -gt 0 ]; then
  for kv in "${NEW_HASHES[@]}"; do
    n="${kv%%=*}"
    h="${kv#*=}"
    bun -e '
      const [path, name, hash] = Bun.argv.slice(2);
      const lock = JSON.parse(await Bun.file(path).text());
      const t = lock.tools.find((x) => x.name === name);
      t.sha256 = hash;
      await Bun.write(path, JSON.stringify(lock, null, 2) + "\n");
    ' "$LOCK" "$n" "$h"
    echo "  + wrote sha256 for $n into deps.lock"
  done
fi

if $FAILED; then
  echo "  Failed: one or more bundled tools have no sha256 and --lock was not passed." >&2
  exit 1
fi

# Sparkle's tools are an xz tarball with bin/ at its root; --help proves they run.
if [ -x "$TOOLS/sparkle/bin/generate_appcast" ]; then
  "$TOOLS/sparkle/bin/generate_appcast" --help >/dev/null 2>&1 && echo "  + sparkle tools runnable"
fi
echo "  Done."
