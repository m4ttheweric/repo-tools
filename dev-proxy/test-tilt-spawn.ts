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
import { validateConfig, flattenResources, type DevConfig, assignPorts } from "./lib";

const configPath = resolve(dirname(import.meta.path), "dev-proxy.config.ts");
const { default: config } = (await import(configPath)) as { default: DevConfig };
validateConfig(config);

const appNames = config.apps.map((a) => a.name);
const resources = flattenResources(config);
const tiltfilePath = join(tmpdir(), `dev-proxy-tiltfile-test-${process.pid}`);
writeFileSync(tiltfilePath, generateTiltfile(resources, appNames));

const worktreeDir = config.repoDir;
const devProxyDir = dirname(import.meta.path);

// Clean PATH
const cleanPath = (process.env.PATH ?? "")
  .split(":")
  .filter((p) => !p.startsWith(devProxyDir))
  .join(":");

// Assign ports dynamically for worktree index 0 with 1 total worktree
const ports = assignPorts(appNames, 0, 1);

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PATH: cleanPath,
  PWD: worktreeDir,
  REPO_ROOT: worktreeDir,
};

// Set PORT_<NAME> env vars dynamically
for (const [name, port] of Object.entries(ports)) {
  env[`PORT_${name.toUpperCase()}`] = String(port);
}

// Remove leaked env vars
delete env.OLDPWD;
delete env.INIT_CWD;
for (const key of Object.keys(env)) {
  if (key.startsWith("npm_")) delete env[key];
}

console.log(`Tiltfile: ${tiltfilePath}`);
console.log(`cwd: ${worktreeDir}`);
console.log(`\nPorts:`);
for (const [name, port] of Object.entries(ports)) {
  console.log(`  PORT_${name.toUpperCase()} = ${port}`);
}
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
