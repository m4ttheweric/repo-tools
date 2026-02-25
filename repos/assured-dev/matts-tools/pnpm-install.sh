#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || dirname "$(cd "$(dirname "$0")/.." && pwd)")"

cd "$WORKSPACE_ROOT"
echo "Running pnpm install in $WORKSPACE_ROOT"
pnpm install
