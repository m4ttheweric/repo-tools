#!/usr/bin/env bash
# Build the rt.cool docs site and deploy it to Cloudflare Pages.
#
# One-time setup (maintainer, outside this script):
#   1. Create a Cloudflare Pages project (default name: rt-cool).
#   2. Authenticate wrangler: `wrangler login`, or set CLOUDFLARE_API_TOKEN.
#   3. Point rt.cool (apex + www) DNS at the Pages project.
#
# Usage:
#   bash scripts/deploy-docs.sh            # build + deploy to production
#   bash scripts/deploy-docs.sh --check    # build only, verify wrangler is present, no deploy
#
# Env:
#   CF_PAGES_PROJECT   Pages project name (default: rt-cool)
set -euo pipefail

PROJECT="${CF_PAGES_PROJECT:-rt-cool}"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/website"

echo "==> Building site"
bun install --frozen-lockfile
bun run build

if [ ! -f build/index.html ]; then
  echo "error: build/ missing index.html; aborting" >&2
  exit 1
fi

# Run wrangler on the Node runtime, not Bun's ... `bunx --bun wrangler pages
# deploy` silently uploads nothing (it bails right after fetching the project).
WRANGLER="bunx wrangler"
if ! command -v wrangler >/dev/null 2>&1 && ! $WRANGLER --version >/dev/null 2>&1; then
  echo "error: wrangler not found. Install it (bun add -g wrangler) or run via bunx." >&2
  exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "==> --check: build OK, wrangler available, project=$PROJECT. Not deploying."
  exit 0
fi

echo "==> Deploying build/ to Cloudflare Pages project '$PROJECT'"
$WRANGLER pages deploy build --project-name "$PROJECT" --branch main
echo "==> Deployed. If DNS is pointed at the project, rt.cool is live."
