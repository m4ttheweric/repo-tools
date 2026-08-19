/**
 * Intercept rules file, PATH shim render/install, and pure invocation matching.
 *
 * This is the data plane for command interception (RT-28 Task 6):
 *
 *  - `buildInterceptRules` reads the repo index the same way
 *    `lib/port-scanner.ts:loadRepoIndex` does, and flattens each registered
 *    repo's `intercepts[]` config (Task 1's `loadEndpointRepoConfig`) into a
 *    flat list of `InterceptRule`, one per intercept entry, each carrying the
 *    repo's git remote (captured once per repo, not once per rule).
 *  - `installShims` / `uninstallShims` write/remove tiny `/bin/sh` PATH shims
 *    under `~/.local/bin` for every distinct intercepted command.
 *  - `matchInvocation` is the pure matcher a real invocation is tested
 *    against — used both by `rt intercept run` (Task 7) and `rt intercept
 *    status`.
 *
 * The shim itself carries NO bypass logic: it unconditionally execs
 * `rt intercept run <command> -- "$@"`. RT_INTERCEPT_BYPASS and the
 * real-binary fallback are decisions made inside `rt intercept run`
 * (Task 7), not in sh — keeping the generated file trivial to read and the
 * decision logic in one (testable, TypeScript) place.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, relative, sep } from "path";
import { readJson, writeJson } from "../json-store.ts";
import { rtDir } from "../rt-paths.ts";
import { runCapture } from "../subprocess.ts";
import { loadEndpointRepoConfig, type InterceptMatch } from "./config.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InterceptRule {
  command: string;
  repo: string;
  repoRemote: string | null;
  matches: InterceptMatch[];
}

const GENERATED_MARKER = "# rt intercept shim — generated; do not edit (rt intercept install)";

// ─── intercepts.json ─────────────────────────────────────────────────────────

export function interceptsPath(): string {
  return join(rtDir(), "intercepts.json");
}

interface RulesFile {
  rules: InterceptRule[];
}

/** Keeps only well-shaped match entries; drops anything malformed rather than throwing. */
function sanitizeMatches(raw: unknown): InterceptMatch[] {
  if (!Array.isArray(raw)) return [];
  const out: InterceptMatch[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const m = entry as Record<string, unknown>;
    if (typeof m.cwdGlob !== "string" || typeof m.role !== "string") continue;
    const match: InterceptMatch = { cwdGlob: m.cwdGlob, role: m.role };
    if (typeof m.argPattern === "string") match.argPattern = m.argPattern;
    if (m.argInject && typeof m.argInject === "object" && !Array.isArray(m.argInject)) {
      match.argInject = m.argInject as InterceptMatch["argInject"];
    }
    out.push(match);
  }
  return out;
}

/** Keeps only well-shaped rule entries; drops anything malformed rather than throwing. */
function sanitizeRules(raw: unknown): InterceptRule[] {
  if (!Array.isArray(raw)) return [];
  const out: InterceptRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.command !== "string" || typeof r.repo !== "string") continue;
    const repoRemote = typeof r.repoRemote === "string" ? r.repoRemote : null;
    out.push({ command: r.command, repo: r.repo, repoRemote, matches: sanitizeMatches(r.matches) });
  }
  return out;
}

export function writeInterceptRules(rules: InterceptRule[]): void {
  const file: RulesFile = { rules };
  writeJson(interceptsPath(), file);
}

export function loadInterceptRules(): InterceptRule[] {
  const data = readJson<Partial<RulesFile>>(interceptsPath(), { rules: [] });
  return sanitizeRules(data.rules);
}

// ─── buildInterceptRules ─────────────────────────────────────────────────────

/** `git -C <repoPath> config --get remote.origin.url`, trimmed; null on any failure or empty output. */
async function captureRepoRemote(repoPath: string): Promise<string | null> {
  const result = await runCapture(["git", "-C", repoPath, "config", "--get", "remote.origin.url"]);
  if (result.exitCode !== 0) return null;
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads the repo index (mirrors `lib/port-scanner.ts:loadRepoIndex`'s read of
 * `~/.mattstack/rt/repos.json`) and, for each registered repo, flattens its
 * `intercepts[]` config into one `InterceptRule` per intercept entry. Repos
 * with no intercepts contribute nothing. `repoRemote` is captured once per
 * repo via an async `git config` call — the reason this function (and
 * `installShims`, which calls it) is async while the rest of this module is
 * synchronous.
 */
export async function buildInterceptRules(): Promise<InterceptRule[]> {
  const index = readJson<Record<string, string>>(join(rtDir(), "repos.json"), {});
  const rules: InterceptRule[] = [];
  for (const [repo, repoPath] of Object.entries(index)) {
    const config = loadEndpointRepoConfig(repo);
    if (config.intercepts.length === 0) continue;
    const repoRemote = await captureRepoRemote(repoPath);
    for (const intercept of config.intercepts) {
      rules.push({ command: intercept.command, repo, repoRemote, matches: intercept.matches });
    }
  }
  return rules;
}

// ─── shim render + path ──────────────────────────────────────────────────────

/** `~/.local/bin`, resolved at call time so tests can fake HOME. */
function localBinDir(): string {
  return join(process.env.HOME ?? homedir(), ".local", "bin");
}

/**
 * Renders the generated `/bin/sh` PATH shim for `command`. Fixed shape:
 * shebang, generated marker, and an unconditional exec into
 * `rt intercept run <command>` — no bypass branch here (see module header).
 */
export function renderInterceptShim(command: string): string {
  return [
    "#!/bin/sh",
    GENERATED_MARKER,
    `exec rt intercept run ${command} -- "$@"`,
    "",
  ].join("\n");
}

/**
 * `~/.local/bin/<command>`. Throws on `"rt"` (dev-mode owns that path; see
 * `lib/command-tree.ts`'s `IS_DEV_MODE` check) or on any command name
 * containing a path separator.
 */
export function shimPath(command: string): string {
  if (command === "rt") {
    throw new Error('shimPath: refusing to shim "rt" — dev-mode owns ~/.local/bin/rt');
  }
  if (command.includes("/") || command.includes(sep)) {
    throw new Error(`shimPath: invalid command name "${command}" (contains a path separator)`);
  }
  return join(localBinDir(), command);
}

// ─── install / uninstall / report ────────────────────────────────────────────

export async function installShims(): Promise<{ installed: string[]; current: string[]; rules: number }> {
  const rules = await buildInterceptRules();
  writeInterceptRules(rules);

  const commands = [...new Set(rules.map((rule) => rule.command))];
  mkdirSync(localBinDir(), { recursive: true });

  const installed: string[] = [];
  const current: string[] = [];
  for (const command of commands) {
    const path = shimPath(command);
    const rendered = renderInterceptShim(command);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (existing === rendered) {
      current.push(command);
    } else {
      writeFileSync(path, rendered, { mode: 0o755 });
      installed.push(command);
    }
  }
  return { installed, current, rules: rules.length };
}

/**
 * Removes every file under `~/.local/bin` whose content carries the
 * generated-shim marker line — a directory scan (not a walk of the current
 * rules file) so a shim left behind by a repo/command that's since dropped
 * out of the rules is still cleaned up.
 */
export function uninstallShims(): { removed: string[] } {
  const dir = localBinDir();
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed };
  }
  for (const name of entries) {
    const path = join(dir, name);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue; // not a regular readable file
    }
    if (!content.includes(GENERATED_MARKER)) continue;
    try {
      rmSync(path);
      removed.push(name);
    } catch {
      // already gone
    }
  }
  return { removed };
}

/** Verify probe: for every distinct rule command, whether a shim exists on disk and whether it's current. */
export function shimReport(): Array<{ command: string; repo: string; installed: boolean; current: boolean }> {
  const rules = loadInterceptRules();
  const seen = new Set<string>();
  const report: Array<{ command: string; repo: string; installed: boolean; current: boolean }> = [];
  for (const rule of rules) {
    if (seen.has(rule.command)) continue;
    seen.add(rule.command);

    let path: string;
    try {
      path = shimPath(rule.command);
    } catch {
      report.push({ command: rule.command, repo: rule.repo, installed: false, current: false });
      continue;
    }
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    report.push({
      command: rule.command,
      repo: rule.repo,
      installed: existing !== null,
      current: existing === renderInterceptShim(rule.command),
    });
  }
  return report;
}

// ─── matchInvocation ─────────────────────────────────────────────────────────

/**
 * Pure match of a real invocation against the rule set: command equality,
 * an optional remote check (skipped when the rule carries no `repoRemote`),
 * `cwdGlob` matched via `Bun.Glob` against the cwd relative to the repo
 * toplevel (`""` normalized to `"."`), and an optional `argPattern` tested
 * against the space-joined args. Returns the first matching rule/match pair,
 * or null (including whenever `toplevel` is null — an invocation outside any
 * git repo can never match).
 */
export function matchInvocation(
  rules: InterceptRule[],
  inv: { command: string; args: string[]; cwd: string; toplevel: string | null; remote: string | null },
): { rule: InterceptRule; match: InterceptMatch } | null {
  if (inv.toplevel === null) return null;
  const relRaw = relative(inv.toplevel, inv.cwd);
  const rel = relRaw === "" ? "." : relRaw;
  const argsJoined = inv.args.join(" ");

  for (const rule of rules) {
    if (rule.command !== inv.command) continue;
    if (rule.repoRemote && rule.repoRemote !== inv.remote) continue;

    for (const match of rule.matches) {
      let hit: boolean;
      try {
        hit = new Bun.Glob(match.cwdGlob).match(rel);
      } catch {
        continue; // malformed cwdGlob — skip this match, don't blow up the invocation
      }
      if (!hit) continue;

      if (match.argPattern) {
        let re: RegExp;
        try {
          re = new RegExp(match.argPattern);
        } catch {
          continue; // malformed argPattern — skip this match
        }
        if (!re.test(argsJoined)) continue;
      }

      return { rule, match };
    }
  }
  return null;
}
