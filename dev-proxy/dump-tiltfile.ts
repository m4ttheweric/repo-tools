#!/usr/bin/env bun
/**
 * Dumps the generated Tiltfile to stdout (or a file) for inspection.
 *
 * Usage:
 *   bun run dump-tiltfile.ts              # print to stdout
 *   bun run dump-tiltfile.ts -o out.py    # write to file
 */
import { resolve, dirname } from "path";
import { writeFileSync, existsSync } from "fs";
import { generateTiltfile } from "./tiltfile-template";
import { validateConfig, flattenResources, ConfigError, type DevConfig } from "./lib";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function die(headline: string, hint?: string): never {
  console.error(`\n  ${red("✗")} ${bold(headline)}`);
  if (hint) console.error(`    ${dim(hint)}`);
  console.error();
  process.exit(1);
}

const configPath = resolve(dirname(import.meta.path), "dev-proxy.config.ts");

if (!existsSync(configPath)) {
  die(
    "Config file not found",
    "Run: cp dev-proxy.config.example.ts dev-proxy.config.ts",
  );
}

let config: DevConfig;
try {
  const mod = (await import(configPath)) as { default: DevConfig };
  config = mod.default;
} catch (e) {
  if (e instanceof ConfigError) die(e.headline, e.hint);
  die("Failed to load config", e instanceof Error ? e.message : String(e));
}

try {
  validateConfig(config);
} catch (e) {
  if (e instanceof ConfigError) die(e.headline, e.hint ?? "Fix in dev-proxy.config.ts");
  throw e;
}

const resources = flattenResources(config);
const appNames = config.apps.map((a) => a.name);
const tiltfile = generateTiltfile(resources, appNames);

const outFlag = process.argv.indexOf("-o");
if (outFlag !== -1 && process.argv[outFlag + 1]) {
  const outPath = process.argv[outFlag + 1];
  writeFileSync(outPath, tiltfile);
  console.log(`Wrote ${tiltfile.split("\n").length} lines to ${outPath}`);
} else {
  console.log(tiltfile);
}
