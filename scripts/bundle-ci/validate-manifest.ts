// Validates an app repo's mattstack.deck.json for the bundle pipeline.
// The pipeline never guesses a build command: any invalid shape throws
// with the remediation the app owner needs.
import { readFileSync } from "fs";
import { isAbsolute } from "path";

export interface BundleRecipe {
  name: string;
  build: string;
  artifact: string;
}

export function readBundleRecipe(manifestPath: string): BundleRecipe {
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(`no mattstack.deck.json at ${manifestPath}`);
  }
  const m = JSON.parse(text) as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name) {
    throw new Error(`${manifestPath}: manifest needs a string "name"`);
  }
  const bundle = m.bundle as Record<string, unknown> | undefined;
  if (typeof bundle !== "object" || bundle === null) {
    throw new Error(`${manifestPath}: add bundle.build + bundle.artifact to mattstack.deck.json`);
  }
  if (typeof bundle.build !== "string" || !bundle.build) {
    throw new Error(`${manifestPath}: bundle.build must be a non-empty string`);
  }
  if (typeof bundle.artifact !== "string" || !bundle.artifact) {
    throw new Error(`${manifestPath}: bundle.artifact must be a non-empty string`);
  }
  if (isAbsolute(bundle.artifact) || bundle.artifact.split("/").includes("..")) {
    throw new Error(`${manifestPath}: bundle.artifact must be repo-relative with no ".." segments`);
  }
  return { name: m.name, build: bundle.build, artifact: bundle.artifact };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: validate-manifest.ts <path-to-mattstack.deck.json>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(readBundleRecipe(path)));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
