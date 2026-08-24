#!/bin/sh
# repo-purity.sh -- the whole tracked tree greps clean of employer/domain terms.
#
# rt is a public, general-purpose developer tool. Nothing about any particular
# employer, customer, or internal system belongs in it -- not in code, not in
# fixtures, not in docs, not in plans. This sweeps everything git tracks, so
# program artifacts and design documents are held to the same line as source.
#
# The bar exists because it was crossed: rt was public for six months carrying
# an internal GitLab host, real ticket ids and titles, internal repo names, and
# two named customers wired to database resource names in test fixtures. A word
# list cannot certify what it was never told to look for, so add to it whenever
# a new term shows up rather than assuming this list is complete.
#
# Run bare from anywhere: scripts/repo-purity.sh. Exit 0 = clean.
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)

# Assembled from fragments so this file greps clean for its own banned words
# (the same technique the skills repo's copy uses).
A1=$(printf '%s%s' 'ass' 'ured')
A2=$(printf '%s%s' 'claim' 'view')
A3=$(printf '%s%s' 'cv-' '[0-9]')
A4=$(printf '%s%s' 'CV-' '[0-9]')
A5=$(printf '%s%s' 'pgr' '-qa')
A6=$(printf '%s%s' 'am' 'fam')
A7=$(printf '%s%s' 'adjus' 'ter')
A8=$(printf "%s%s" "hog" "warts")
A9=$(printf "%s%s" "CV" "I")
# The carrier name reached HEAD hyphenated ("progressive-qa") after the first
# scrub only caught the spaced form — a word list is only as good as its variants.
A10=$(printf "%s%s" "progres" "sive")

PATTERN="$A1|$A2|$A3|$A4|$A5|$A6|$A7|$A8|$A9|$A10"

# Lockfiles are excluded: their base64 integrity hashes collide with the short
# patterns often enough to be pure noise, and nothing is authored in them.
HITS=$(cd "$ROOT" \
  && git ls-files -z \
  | grep -zvE '(bun\.lock|package-lock\.json)$' \
  | xargs -0 grep -niE "$PATTERN" 2>/dev/null \
  | grep -v '^scripts/repo-purity.sh:' || true)
if [ -n "$HITS" ]; then
  echo "FAIL repo-purity:"
  printf '%s\n' "$HITS"
  echo ""
  echo "rt is public. Use neutral placeholders (acme, ACME-1234, gitlab.example.com)."
  exit 1
fi
echo "ok   repo-purity"
