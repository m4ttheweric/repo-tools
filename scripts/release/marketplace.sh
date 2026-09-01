#!/bin/bash
# scripts/release/marketplace.sh [--refresh] [--dry-run] [<source-dir>]
#
# Publishes marketplace/ in this repo to m4ttstack/mattstack-marketplace, the
# catalog `plugins.install` adds on every machine rt sets up.
#
#   (no flags)  stage the source dir, validate it, commit and push the result
#   --dry-run   stage and validate only
#   --refresh   re-resolve each pinned plugin's `ref` to its current head and
#               rewrite <source-dir>/marketplace.json in place (local only)
#
# The published repo is generated wholesale: its tree is replaced by the staged
# one every run, so a hand edit there survives exactly until the next release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REFRESH=0
DRY_RUN=0
SRC="$ROOT/marketplace"
for arg in "$@"; do
    case "$arg" in
        --refresh) REFRESH=1 ;;
        --dry-run) DRY_RUN=1 ;;
        -*) echo "usage: marketplace.sh [--refresh] [--dry-run] [<source-dir>]" >&2; exit 2 ;;
        *) SRC="$arg" ;;
    esac
done

CATALOG="$SRC/marketplace.json"
TARGET_REPO="${RT_MARKETPLACE_REPO:-m4ttstack/mattstack-marketplace}"

[ -f "$CATALOG" ] || { echo "✗ $CATALOG missing" >&2; exit 1; }

if [ "$REFRESH" -eq 1 ]; then
    # Every ref is resolved before any is written: a catalog left holding some
    # plugins' new pins and others' old ones is worse than one that did not
    # move, because the diff looks like a deliberate partial bump.
    RESOLVED="$(mktemp "${TMPDIR:-/tmp}/mattstack-marketplace-pins.XXXXXX")"
    trap 'rm -f "$RESOLVED"' EXIT
    # Captured, not piped from a process substitution: there the emitter's exit
    # status is discarded, so a malformed catalog would yield zero rows, skip
    # every plugin, and report "every pin already current" — a silent pass.
    PLAN="$(python3 - "$CATALOG" <<'PY'
import json, sys
# Pins are applied by name, so two entries sharing one would both take
# whichever resolved last. Publishing rejects duplicates too, but --refresh
# runs on its own and would corrupt the catalog before anyone published it.
seen, rows = set(), []
for plugin in json.load(open(sys.argv[1]))["plugins"]:
    name = plugin["name"]
    if name in seen:
        sys.exit(f"{name}: listed twice — cannot refresh pins by name")
    seen.add(name)
    src = plugin.get("source")
    if isinstance(src, dict) and src.get("source") == "url":
        url = (src.get("url") or "").strip()
        if not url:
            sys.exit(f"{name}: url source has no url")
        # A url source with no `ref` is a deliberate pin that never follows a
        # branch; --refresh leaves it where it is rather than guessing which
        # branch to re-resolve against.
        if src.get("ref"):
            rows.append("\t".join([name, url, src["ref"], src.get("sha", "")]))
print("\n".join(rows))
PY
    )" || { echo "✗ cannot plan a refresh of $CATALOG" >&2; exit 1; }

    changed=0
    while IFS=$'\t' read -r name url ref old; do
        [ -n "$name" ] || continue
        new="$(git ls-remote "$url" "$ref" | awk 'NR==1{print $1}')"
        [ -n "$new" ] || { echo "✗ $name: $ref not found in $url" >&2; exit 1; }
        printf '%s\t%s\n' "$name" "$new" >> "$RESOLVED"
        if [ "$new" = "$old" ]; then
            echo "  $name: unchanged ($ref @ ${old:0:12})"
        else
            echo "  $name: ${old:0:12} → ${new:0:12} ($ref)"
            changed=1
        fi
    done <<< "$PLAN"
    if [ "$changed" -eq 1 ]; then
        python3 - "$CATALOG" "$RESOLVED" <<'PY'
import json, sys
path, resolved = sys.argv[1:3]
pins = dict(line.rstrip("\n").split("\t", 1) for line in open(resolved) if line.strip())
doc = json.load(open(path))
for plugin in doc["plugins"]:
    if plugin["name"] in pins:
        plugin["source"]["sha"] = pins[plugin["name"]]
with open(path, "w") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")
PY
        echo "→ $CATALOG updated; commit it"
    else
        echo "→ every pin already current"
    fi
    exit 0
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/mattstack-marketplace.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

git init -q -b main "$STAGE"
mkdir -p "$STAGE/.claude-plugin"
cp "$CATALOG" "$STAGE/.claude-plugin/marketplace.json"
if [ -f "$SRC/README.md" ]; then cp "$SRC/README.md" "$STAGE/README.md"; fi
if [ -f "$SRC/LICENSE" ]; then cp "$SRC/LICENSE" "$STAGE/LICENSE"; fi
# Plugins with no repo of their own ship inline; everything else is a pinned URL.
if [ -d "$SRC/plugins" ]; then cp -R "$SRC/plugins" "$STAGE/plugins"; fi

# Before the catalog checks, so a symlinked plugin is named as one: git stores
# a symlink as a link, so a clone of the published repo would get a dangling
# pointer instead of the plugin. The local dev marketplace uses them
# deliberately; the published one must never.
if find "$STAGE" -path "$STAGE/.git" -prune -o -type l -print | grep -q .; then
    echo "✗ staged tree contains symlinks — a clone would get dangling pointers" >&2
    find "$STAGE" -path "$STAGE/.git" -prune -o -type l -print >&2
    exit 1
fi

# A malformed catalog is only discoverable at `claude plugin marketplace add`
# time, which is a fresh machine's very first step — assert here instead.
python3 - "$STAGE" <<'PY'
import json, os, re, sys
stage = sys.argv[1]
doc = json.load(open(os.path.join(stage, ".claude-plugin", "marketplace.json")))
problems = []
if not doc.get("name"):
    problems.append("catalog has no name")
names = set()
for plugin in doc.get("plugins") or []:
    name = plugin.get("name")
    if not name:
        problems.append("a plugin entry has no name")
        continue
    if name in names:
        problems.append(f"{name}: listed twice")
    names.add(name)
    src = plugin.get("source")
    if isinstance(src, str):
        # An absolute or ../-escaping source resolves against the *authoring*
        # machine, so it can validate here and still be missing for every
        # client — the published tree is all a clone gets.
        root = os.path.realpath(stage)
        target = os.path.realpath(os.path.join(stage, src))
        if target != root and not target.startswith(root + os.sep):
            problems.append(f"{name}: source {src} points outside the published tree")
        elif not os.path.isdir(target):
            problems.append(f"{name}: source {src} is not in the published tree")
        elif not os.path.isfile(os.path.join(target, ".claude-plugin", "plugin.json")):
            problems.append(f"{name}: source {src} has no .claude-plugin/plugin.json")
    elif isinstance(src, dict) and src.get("source") == "url":
        if not (src.get("url") or "").strip():
            problems.append(f"{name}: url source has no url")
        if not re.fullmatch(r"[0-9a-f]{40}", src.get("sha") or ""):
            problems.append(f"{name}: url source needs a full 40-char sha, got {src.get('sha')!r}")
    else:
        problems.append(f"{name}: unsupported source {src!r}")
if not doc.get("plugins"):
    problems.append("catalog lists no plugins")
for p in problems:
    print(f"✗ {p}", file=sys.stderr)
sys.exit(1 if problems else 0)
PY

# The real parser, when it is on PATH: structural checks above cannot know what
# claude actually accepts. Runs against a throwaway config so it cannot touch the
# invoking user's plugin config. CLAUDE_CONFIG_DIR outranks HOME for the CLI (a
# cswap session exports it), so it is unset explicitly -- HOME alone let this
# step register the temp stage in the real profile and delete it on exit.
if command -v claude >/dev/null 2>&1; then
    # Outside $STAGE: anything left under it is committed and published.
    VHOME="$(mktemp -d "${TMPDIR:-/tmp}/mattstack-marketplace-home.XXXXXX")"
    trap 'rm -rf "$STAGE" "$VHOME"' EXIT
    if VOUT="$(env -u CLAUDE_CONFIG_DIR HOME="$VHOME" claude plugin marketplace add "$STAGE" 2>&1)"; then
        echo "✓ claude accepts the staged catalog"
    else
        printf '%s\n' "$VOUT" >&2
        echo "✗ claude plugin marketplace add rejected the staged catalog" >&2
        exit 1
    fi
else
    echo "  note: claude not on PATH — structural validation only"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "✓ dry run: staged and validated, not pushed"
    exit 0
fi

# RT_MARKETPLACE_REPO takes "owner/name" or any git URL/path; the latter is how
# the tests publish into a throwaway bare repo instead of GitHub.
case "$TARGET_REPO" in
    *://* | /* | ./* | ../*) PUSH_URL="$TARGET_REPO" ;;
    *)
        # Token in the URL, never echoed: `set -x` is off and no command below
        # prints PUSH_URL. Without one, the local credential helper answers.
        if [ -n "${MARKETPLACE_TOKEN:-}" ]; then
            PUSH_URL="https://x-access-token:${MARKETPLACE_TOKEN}@github.com/${TARGET_REPO}.git"
        else
            PUSH_URL="https://github.com/${TARGET_REPO}.git"
        fi
        ;;
esac

git -C "$STAGE" remote add origin "$PUSH_URL"
if git -C "$STAGE" fetch -q --depth 1 origin main 2>/dev/null; then
    # History is kept (no force push), but the tree is wholly the staged one:
    # a plugin dropped from the catalog must also leave the published repo.
    git -C "$STAGE" reset -q --soft FETCH_HEAD
    git -C "$STAGE" add -A
    if git -C "$STAGE" diff --cached --quiet; then
        echo "✓ $TARGET_REPO already matches marketplace/ — nothing to publish"
        exit 0
    fi
else
    echo "→ $TARGET_REPO has no main yet — publishing the first commit"
    git -C "$STAGE" add -A
fi

SOURCE_REF="${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD)}"
git -C "$STAGE" \
    -c user.name="mattstack release" \
    -c user.email="goodwin.matthew.eric@gmail.com" \
    commit -q -m "Publish marketplace from rt ${SOURCE_REF:0:12}"
git -C "$STAGE" push -q origin main
echo "✓ published to $TARGET_REPO"
