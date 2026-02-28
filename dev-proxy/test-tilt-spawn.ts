#!/usr/bin/env bun
/**
 * Test: spawn tilt exactly like orchestrate.ts does, with cleaned env.
 * Mirrors the exact env cleaning from spawnTilt().
 * Ctrl+C to stop.
 */
import { resolve, dirname, join } from "path";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { generateTiltfile } from "./tiltfile-template";
import { validateConfig, type DevConfig } from "./lib";

const configPath = resolve(dirname(import.meta.path), "dev-proxy.config.ts");
const { default: config } = (await import(configPath)) as { default: DevConfig };
validateConfig(config);

const tiltfilePath = join(tmpdir(), `dev-proxy-tiltfile-test-${process.pid}`);
writeFileSync(tiltfilePath, generateTiltfile(config.resources));

const worktreeDir = config.repoDir;
const devProxyDir = dirname(import.meta.path);

// Clean PATH
const cleanPath = (process.env.PATH ?? "")
  .split(":")
  .filter((p) => !p.startsWith(devProxyDir))
  .join(":");

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PATH: cleanPath,
  PWD: worktreeDir,
  REPO_ROOT: worktreeDir,
  PORT_BACKEND: "52000",
  PORT_ADJUSTER: "52002",
  PORT_FRONTEND: "52004",
};
// Remove leaked env vars
delete env.OLDPWD;
delete env.INIT_CWD;
for (const key of Object.keys(env)) {
  if (key.startsWith("npm_")) delete env[key];
}

console.log(`Tiltfile: ${tiltfilePath}`);
console.log(`cwd: ${worktreeDir}`);
console.log(`\nLeaked env vars:`);
let found = false;
for (const [k, v] of Object.entries(env)) {
  if (k === "PATH") continue;
  if (v?.includes("repo-tools/dev-proxy")) {
    console.log(`  ${k}=${v}`);
    found = true;
  }
}
if (!found) console.log("  (none — clean!)");
console.log();

const proc = Bun.spawn(
  ["tilt", "up", "-f", tiltfilePath, "--port", "10370", "--stream"],
  { cwd: worktreeDir, env, stdout: "inherit", stderr: "inherit" },
);

process.on("SIGINT", () => {
  proc.kill("SIGTERM");
  try { unlinkSync(tiltfilePath); } catch {}
  process.exit(0);
});

await proc.exited;
try { unlinkSync(tiltfilePath); } catch {}
