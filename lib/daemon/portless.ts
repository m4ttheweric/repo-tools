/**
 * portless integration helpers. We drive portless purely via the CLI (repo
 * stealth; no portless.json in the repo). `portless run` accepts --app-port
 * (caller fixes the port) and --name (caller fixes the base name) so rt can
 * construct a stable, no-port URL before the process is even started.
 */

import { readFileSync } from "fs";
import { basename, join } from "path";
import { execSync } from "child_process";

/** Lowercase + reduce to a DNS-label-safe subdomain segment. */
export function sanitizeSubdomain(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The base name rt hands portless via --name. We pick it (rather than letting
 * portless infer) so we can construct the URL ourselves. package.json name wins
 * (last path segment of a scoped name, @ stripped), else the directory basename.
 */
export function deriveAppName(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    if (pkg?.name && typeof pkg.name === "string") {
      const last = pkg.name.replace(/^@/, "").split("/").pop() || pkg.name;
      const clean = sanitizeSubdomain(last);
      if (clean) return clean;
    }
  } catch { /* no/invalid package.json */ }
  return sanitizeSubdomain(basename(cwd.replace(/\/+$/, "")));
}

/**
 * Construct the portless URL. No port is ever appended (the proxy must run on
 * the default port for this to resolve). Branch prefix only for linked worktrees.
 */
export function portlessUrl(name: string, branchPrefix: string | null, scheme = "https"): string {
  const host = branchPrefix ? `${branchPrefix}.${name}.localhost` : `${name}.localhost`;
  return `${scheme}://${host}`;
}

/**
 * Sanitized branch name if cwd is a LINKED worktree (portless prefixes those);
 * null for the primary checkout or on any error. `run` injected for testing.
 */
export function worktreeBranchPrefix(
  cwd: string,
  run: (args: string) => string = (args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: "pipe" }).trim(),
): string | null {
  try {
    const gitDir = run("rev-parse --git-dir");
    if (!gitDir.includes("/worktrees/")) return null; // primary checkout; no prefix
    const branch = run("rev-parse --abbrev-ref HEAD");
    if (!branch || branch === "HEAD") return null;
    return sanitizeSubdomain(branch);
  } catch {
    return null;
  }
}

/** Wrap a shell command so it runs through the portless proxy. opts let rt fix the app port and name. */
export function buildPortlessCommand(inner: string, opts?: { appPort?: number; name?: string }): string {
  const flags: string[] = [];
  if (opts?.name) flags.push(`--name ${opts.name}`);
  if (opts?.appPort) flags.push(`--app-port ${opts.appPort}`);
  return `portless run ${flags.length ? flags.join(" ") + " " : ""}${inner}`;
}

/** Whether the portless binary is resolvable on PATH. */
export function portlessAvailable(which: (bin: string) => string | null = (b) => Bun.which(b)): boolean {
  return which("portless") !== null;
}
