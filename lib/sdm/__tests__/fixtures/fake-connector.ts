#!/usr/bin/env bun
/**
 * Fixture connector for connectors.test.ts. Not a real connector: behavior is
 * fully determined by argv so tests can exercise `discover`, `resolve <url>`
 * resolving to a connection, `resolve <url>` resolving to an unresolved gap,
 * and `resolve <url>` with no match, all without a live registry.
 *
 * resolve behavior, keyed on substrings of the url arg:
 *   "resolve-me" -> one connection
 *   "ambiguous"  -> one unresolved entry (source: "ambiguous")
 *   anything else -> empty output (this connector has no opinion on the url)
 */

const [, , command, arg] = process.argv;

function emit(output: unknown): void {
  process.stdout.write(JSON.stringify(output) + "\n");
}

if (command === "discover") {
  emit({
    version: 1,
    connections: [
      { id: "conn1", label: "Connection One", sdmResource: "example-conn1", tier: "staging" },
    ],
    unresolved: [
      {
        id: "gap1",
        label: "Ambiguous Resource",
        slug: "ambiguous-resource",
        env: "staging",
        source: "ambiguous",
        candidates: ["example-a", "example-b"],
      },
    ],
    allResources: ["example-conn1", "example-a", "example-b", "example-orphan"],
  });
} else if (command === "resolve") {
  const url = arg ?? "";
  if (url.includes("resolve-me")) {
    emit({
      version: 1,
      connections: [
        { id: "res1", label: "Resolved One", sdmResource: "example-res1", tier: "prod" },
      ],
    });
  } else if (url.includes("ambiguous")) {
    emit({
      version: 1,
      connections: [],
      unresolved: [
        {
          id: "res-amb",
          label: "Ambiguous Match",
          slug: "ambiguous-match",
          env: "prod",
          source: "ambiguous",
          candidates: ["example-x", "example-y"],
        },
      ],
    });
  } else {
    emit({ version: 1, connections: [] });
  }
} else {
  process.stderr.write(`fake-connector: unknown command ${JSON.stringify(command)}\n`);
  process.exit(1);
}
