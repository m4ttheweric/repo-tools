/**
 * Script storage for rt x.
 *
 * Two scopes:
 *   Team:  <repoRoot>/.rt/scripts/<name>.json  — git-tracked, shared
 *   User:  <dataDir>/scripts/<name>.json        — local-only, private
 *
 * Team takes precedence when both exist.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Multiplexer = "zellij" | "tmux" | "concurrent";

export interface StepDef {
  label: string;
  command: string;
  /** Subdirectory relative to repo root. */
  cwd?: string;
  /** If set, this step only runs when the user passes this flag (e.g. "--clean"). */
  flag?: string;
}

export interface RtScript {
  name: string;
  description?: string;
  setup: StepDef[];
  commands: StepDef[];
  teardown: StepDef[];
  multiplexer?: Multiplexer;
}

// ─── Reserved names ──────────────────────────────────────────────────────────

const RESERVED_NAMES = new Set(["create"]);

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name);
}

// ─── Paths ───────────────────────────────────────────────────────────────────

function teamDir(repoRoot: string): string {
  return join(repoRoot, ".rt", "scripts");
}

function userDir(dataDir: string): string {
  return join(dataDir, "scripts");
}

function scriptPath(dir: string, name: string): string {
  return join(dir, `${name}.json`);
}

// ─── Load ────────────────────────────────────────────────────────────────────

function loadFromFile(path: string): RtScript | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      name: raw.name ?? basename(path, ".json"),
      description: raw.description,
      setup: Array.isArray(raw.setup) ? raw.setup : [],
      commands: Array.isArray(raw.commands) ? raw.commands : [],
      teardown: Array.isArray(raw.teardown) ? raw.teardown : [],
      multiplexer: raw.multiplexer,
    };
  } catch {
    return null;
  }
}

/**
 * Load a script by name. Team scope takes precedence over user scope.
 */
export function loadScript(
  name: string,
  repoRoot: string,
  dataDir: string,
): RtScript | null {
  return (
    loadFromFile(scriptPath(teamDir(repoRoot), name)) ??
    loadFromFile(scriptPath(userDir(dataDir), name))
  );
}

// ─── Save ────────────────────────────────────────────────────────────────────

export function saveScript(
  script: RtScript,
  scope: "team" | "user",
  repoRoot: string,
  dataDir: string,
): string {
  const dir = scope === "team" ? teamDir(repoRoot) : userDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = scriptPath(dir, script.name);
  writeFileSync(path, JSON.stringify(script, null, 2) + "\n");
  return path;
}

// ─── List ────────────────────────────────────────────────────────────────────

export interface ScriptEntry {
  name: string;
  scope: "team" | "user";
  script: RtScript;
}

function scanDir(dir: string, scope: "team" | "user"): ScriptEntry[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const name = basename(f, ".json");
        const script = loadFromFile(join(dir, f));
        return script ? { name, scope, script } : null;
      })
      .filter((e): e is ScriptEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * List all scripts. Team scripts shadow user scripts with the same name.
 */
export function listScripts(repoRoot: string, dataDir: string): ScriptEntry[] {
  const teamScripts = scanDir(teamDir(repoRoot), "team");
  const userScripts = scanDir(userDir(dataDir), "user");

  const seen = new Set(teamScripts.map((e) => e.name));
  const merged = [...teamScripts];
  for (const entry of userScripts) {
    if (!seen.has(entry.name)) {
      merged.push(entry);
    }
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Filtering helpers ───────────────────────────────────────────────────────

/**
 * Filter steps based on active flags. Steps with no `flag` always run.
 * Steps with a `flag` only run if that flag is in `activeFlags`.
 */
export function filterSteps(steps: StepDef[], activeFlags: Set<string>): StepDef[] {
  return steps.filter((s) => !s.flag || activeFlags.has(s.flag));
}
