#!/usr/bin/env sh

# Checks for circular dependencies in staged or specified files.
# Requires: npm install -g madge
#
# Usage:
#   ./check-circular-deps.sh              # checks staged TS/TSX files
#   ./check-circular-deps.sh file1.ts file2.ts  # check specific files

if ! command -v madge >/dev/null 2>&1; then
  echo "madge not found. install it globally: npm install -g madge"
  exit 1
fi

if [ $# -gt 0 ]; then
  FILES="$*"
else
  FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' | grep -v '\.test\.\|\.spec\.\|__fixtures__\|__mocks__\|\.d\.ts')
fi

if [ -z "$FILES" ]; then
  echo "no TS/TSX files to check."
  exit 0
fi

echo "checking for circular dependencies..."
echo "$FILES" | tr ' ' '\n' | sed 's/^/  /'
echo ""

# shellcheck disable=SC2086
madge --circular --extensions ts,tsx $FILES
result=$?

if [ $result -ne 0 ]; then
  echo ""
  echo "circular dependencies detected. the mr-danger bot will fail these in CI."
fi

exit $result
