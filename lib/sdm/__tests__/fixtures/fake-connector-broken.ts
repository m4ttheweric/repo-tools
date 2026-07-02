#!/usr/bin/env bun
/**
 * Fixture connector for connectors.test.ts: `discover` succeeds with no
 * connections, but `resolve` always exits nonzero regardless of the url.
 * Used to test that resolveConnection collects the run error into
 * ResolveConnectionResult.errors instead of silently skipping it, and keeps
 * trying later connectors rather than aborting.
 */

const [, , command] = process.argv;

if (command === "discover") {
  process.stdout.write(JSON.stringify({ version: 1, connections: [] }) + "\n");
} else if (command === "resolve") {
  process.stderr.write("simulated resolve failure\n");
  process.exit(1);
} else {
  process.stderr.write(`fake-connector-broken: unknown command ${JSON.stringify(command)}\n`);
  process.exit(1);
}
