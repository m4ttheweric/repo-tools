#!/usr/bin/env bun
/**
 * Dumps the generated Tiltfile to stdout (or a file) for inspection.
 *
 * Usage:
 *   bun run dump-tiltfile.ts              # print to stdout
 *   bun run dump-tiltfile.ts -o out.py    # write to file
 */
import { resolve, dirname } from "path";
import { writeFileSync } from "fs";
import { generateTiltfile } from "./tiltfile-template";
import { validateConfig, flattenResources, type DevConfig } from "./lib";

const configPath = resolve(dirname(import.meta.path), "dev-proxy.config.ts");
const { default: config } = (await import(configPath)) as {
  default: DevConfig;
};

validateConfig(config);

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
