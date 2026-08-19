#!/usr/bin/env bun

/**
 * rt intercept — generic command interception CLI verbs (RT-28 Task 7).
 *
 *   rt intercept run <command> -- [args...]   hidden verb the shim execs
 *   rt intercept status [--json]              shim + rule health
 *   rt intercept install [--json]             (re)write PATH shims
 *   rt intercept uninstall [--json]           remove generated shims
 *
 * `interceptRun` wires the real dependencies for `lib/endpoint/run.ts`'s
 * `runInterception` — the pure, testable core (see
 * `lib/endpoint/__tests__/intercept-run.test.ts`). Everything that talks to
 * git, the daemon, or a real subprocess lives here; the decision tree does
 * not.
 *
 * `RT_INTERCEPT_BYPASS=1` short-circuits HERE, before any matching — the
 * generated `/bin/sh` shim (`lib/endpoint/shim.ts`) carries no bypass logic
 * of its own, by design (see that module's header comment).
 */

import { closeSync, openSync, readSync, realpathSync, statSync } from "fs";
import { join } from "path";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { daemonQuery } from "../lib/daemon-client.ts";
import { runCapture } from "../lib/subprocess.ts";
import { GENERATED_MARKER, loadInterceptRules, shimPath, shimReport, installShims, uninstallShims } from "../lib/endpoint/shim.ts";
import { runInterception, type RunDeps } from "../lib/endpoint/run.ts";

function usageFail(msg: string): never {
  console.error(`rt intercept: ${msg}`);
  process.exit(1);
}

function toStringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ─── real RunDeps wiring ─────────────────────────────────────────────────────

async function gitToplevel(cwd: string): Promise<string | null> {
  const res = await runCapture(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  if (res.exitCode !== 0) return null;
  const trimmed = res.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function gitRemote(toplevel: string): Promise<string | null> {
  const res = await runCapture(["git", "-C", toplevel, "config", "--get", "remote.origin.url"]);
  if (res.exitCode !== 0) return null;
  const trimmed = res.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads just the first 512 bytes of `path` and checks for the generated-shim
 * marker (always on line 2, well inside that window — see
 * `renderInterceptShim`). Deliberately a raw partial read, not
 * `readFileSync`, so this stays cheap even against a large real binary: a
 * few bytes off disk, never the whole file. Any read failure (permission,
 * ENOENT between stat and here, a directory) is treated as "not a shim" —
 * this is a guard against recursion, not a correctness gate on resolution.
 */
function looksLikeGeneratedShim(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(512);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8").includes(GENERATED_MARKER);
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
}

/**
 * Scans `PATH` for an executable file named `command` that is NOT one of
 * rt's own generated intercept shims, skipping this command's own shim path
 * (so the search never resolves back to itself) — `~/.local/bin` sits on
 * PATH ahead of everything else so an unfiltered scan would just find the
 * shim again.
 *
 * Path-string equality alone is not a sufficient recursion guard: a
 * symlinked HOME makes the shim reachable under a different absolute path
 * string, and a shim file COPIED (not symlinked) onto PATH ahead of
 * `~/.local/bin` would never string-match `ownShimPath` at all — either
 * would recurse `rt intercept run` into itself forever. So every candidate
 * gets two additional, cheap checks before it's accepted: a realpath
 * comparison against the resolved shim path (catches the symlink case), and
 * a content sniff for the generated-shim marker (catches the copy case).
 *
 * `RT_INTERCEPT_REAL` overrides the whole search (test/debug escape hatch).
 */
export function resolveRealBinary(command: string): string | null {
  if (process.env.RT_INTERCEPT_REAL) return process.env.RT_INTERCEPT_REAL;

  let ownShimPath: string | null = null;
  try {
    ownShimPath = shimPath(command);
  } catch {
    ownShimPath = null;
  }
  let ownShimReal: string | null = null;
  if (ownShimPath) {
    try {
      ownShimReal = realpathSync(ownShimPath);
    } catch {
      ownShimReal = null; // shim not actually on disk — nothing to compare against
    }
  }

  const pathVar = process.env.PATH ?? "";
  for (const dir of pathVar.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (candidate === ownShimPath) continue;

    let st;
    try {
      st = statSync(candidate);
    } catch {
      continue; // not present in this PATH entry
    }
    if (!st.isFile() || (st.mode & 0o111) === 0) continue;

    if (ownShimReal) {
      try {
        if (realpathSync(candidate) === ownShimReal) continue; // symlinked back to the shim
      } catch {
        continue; // vanished between stat and realpath — treat as absent
      }
    }

    if (looksLikeGeneratedShim(candidate)) continue; // a copied (not symlinked) shim

    return candidate;
  }
  return null;
}

/**
 * Ported from @assured/dev-ports doppler.ts passthrough: inherit-stdio spawn,
 * forward SIGINT/SIGTERM/SIGHUP to the child, and mirror its exit code.
 */
async function execReal(bin: string, args: string[], env: Record<string, string>): Promise<never> {
  const child = Bun.spawn([bin, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env,
  });

  const forward = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      // child already gone
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGHUP", () => forward("SIGHUP"));

  const code = await child.exited;
  process.exit(code);
}

// ─── rt intercept run ────────────────────────────────────────────────────────

/** Splits `<command> -- <args...>` (what the generated shim always sends). */
function parseRunArgs(args: string[]): { command: string; forwardArgs: string[] } | null {
  const command = args[0];
  if (!command) return null;
  const dashIdx = args.indexOf("--");
  const forwardArgs = dashIdx === -1 ? args.slice(1) : args.slice(dashIdx + 1);
  return { command, forwardArgs };
}

export async function interceptRun(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args);
  if (!parsed) usageFail("usage: rt intercept run <command> -- [args...]");
  const { command, forwardArgs } = parsed;

  const cwd = process.cwd();
  const pid = process.pid;
  const callerEnv = { ...process.env };

  if (callerEnv.RT_INTERCEPT_BYPASS === "1") {
    const bin = resolveRealBinary(command);
    if (!bin) throw new Error(`rt intercept: real binary for "${command}" could not be resolved`);
    await execReal(bin, forwardArgs, toStringEnv(callerEnv));
    return;
  }

  const deps: RunDeps = {
    rules: loadInterceptRules(),
    gitToplevel,
    gitRemote,
    claim: (payload) => daemonQuery("endpoint:claim", payload, 10_000),
    execReal,
    resolveRealBinary,
    warn: (msg) => console.error(msg),
  };

  await runInterception(deps, command, forwardArgs, cwd, callerEnv, pid);
}

// ─── rt intercept status ─────────────────────────────────────────────────────

export async function interceptStatus(args: string[]): Promise<void> {
  const json = args.includes("--json");

  const report = shimReport();
  const rules = loadInterceptRules();
  const rulesByRepo: Record<string, number> = {};
  for (const rule of rules) rulesByRepo[rule.repo] = (rulesByRepo[rule.repo] ?? 0) + 1;

  const daemonUp = (await daemonQuery("endpoint:status", {}, 5_000)) !== null;

  if (json) {
    console.log(JSON.stringify({ ok: true, shims: report, rulesByRepo, daemonUp }));
    return;
  }

  console.log(`\n  ${bold}${cyan}rt intercept status${reset} ${dim}(daemon ${daemonUp ? "up" : "down"})${reset}\n`);
  if (report.length === 0) {
    console.log(`  ${dim}no intercept rules registered — declare "intercepts" in a repo config, then rt intercept install${reset}\n`);
    return;
  }
  for (const entry of report) {
    const mark = entry.installed ? (entry.current ? `${green}✓${reset}` : `${yellow}stale${reset}`) : `${red}✗ missing${reset}`;
    const count = rulesByRepo[entry.repo] ?? 0;
    console.log(`  ${mark} ${bold}${entry.command}${reset} ${dim}(${entry.repo}, ${count} rule${count === 1 ? "" : "s"})${reset}`);
  }
  console.log();
}

// ─── rt intercept install / uninstall ────────────────────────────────────────

export async function interceptInstall(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const result = await installShims();

  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }

  console.log(`\n  ${bold}${cyan}rt intercept install${reset} ${dim}(${result.rules} rule${result.rules === 1 ? "" : "s"})${reset}\n`);
  if (result.installed.length > 0) console.log(`  ${green}✓ installed${reset} ${result.installed.join(", ")}`);
  if (result.current.length > 0) console.log(`  ${dim}already current${reset} ${result.current.join(", ")}`);
  if (result.installed.length === 0 && result.current.length === 0) console.log(`  ${dim}no commands to shim${reset}`);
  console.log();
}

export async function interceptUninstall(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const result = uninstallShims();

  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }

  console.log(`\n  ${bold}${cyan}rt intercept uninstall${reset}\n`);
  if (result.removed.length > 0) console.log(`  ${green}✓ removed${reset} ${result.removed.join(", ")}`);
  else console.log(`  ${dim}nothing to remove${reset}`);
  console.log();
}
