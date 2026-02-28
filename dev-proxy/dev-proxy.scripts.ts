/**
 * Shell command templates for dev-proxy resources.
 * Kept separate from the config to keep it clean and scannable.
 *
 * Placeholders: {repo}, {port}, {port_<name>}
 */

export const DB_MIGRATIONS_SCRIPT = `
cd {repo}/apps/backend
OUTPUT=$(pnpm run cloneDB-fix-migrations 2>&1)
echo "$OUTPUT"

if echo "$OUTPUT" | grep -q "Run: pnpm deploy-db"; then
    echo ""
    echo "Migrations need to be applied, running deploy-db..."
    pnpm run deploy-db
else
    echo ""
    echo "Database migrations are up to date"
fi`.trim();

export const BACKEND_CMD = `cd {repo}/apps/backend &&
  PORT={port}
  doppler run --preserve-env --
  node --experimental-loader newrelic/esm-loader.mjs
       --require newrelic
       ./start-dev-server.js
       --no-notify --respawn --exit-child --rs
       --transpile-only src/server`;

export const PARCEL_CMD = (app: string) => `cd {repo}/apps/${app} &&
  PORT={port}
  REACT_APP_ENDPOINT=http://localhost:{port_backend}
  doppler run --preserve-env --
  pnpm exec parcel --watch-dir ../../ src/index.html`;
