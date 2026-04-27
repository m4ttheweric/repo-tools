/**
 * rt mr config — per-repo defaults + describe-atom inputs.
 *
 * Lives at ~/.rt/<repo>/mr.json (sibling of sync.json). All fields optional.
 * Extended from the open atom with `prompts`, `context`, `inline`, `agent`
 * so `rt mr describe` has a home for its cursor-rules-style setup.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MRConfig {
  // Open-atom defaults
  target?: string;
  draft?: boolean;
  removeSourceBranch?: boolean;
  squash?: boolean;

  // Describe-atom inputs
  /**
   * Markdown fragments concatenated into the agent's style/template context.
   * Paths are absolute, ~-prefixed (homedir), or relative to the data dir.
   * `.mdc` files have their YAML frontmatter stripped automatically.
   */
  prompts?: string[];

  /** Glob patterns (repo-root relative) for additional context files. */
  context?: {
    include?: string[];
    exclude?: string[];
  };

  /** Freeform extra guidance appended to the assembled prompt. */
  inline?: string;

  /** Agent CLI override. Defaults are agent-aware, e.g. Claude `-p`, Codex `exec -`. */
  agent?: {
    cli?: string;
    args?: string[];
    /** Soft cap on the diff block included in the prompt, in KB (default 80). */
    maxDiffKb?: number;
  };
}

// ─── Load ────────────────────────────────────────────────────────────────────

export function loadMRConfig(dataDir: string): MRConfig {
  const path = join(dataDir, "mr.json");
  if (!existsSync(path)) return {};

  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const out: MRConfig = {};

    if (typeof raw.target === "string") out.target = raw.target;
    if (typeof raw.draft === "boolean") out.draft = raw.draft;
    if (typeof raw.removeSourceBranch === "boolean") out.removeSourceBranch = raw.removeSourceBranch;
    if (typeof raw.squash === "boolean") out.squash = raw.squash;

    if (Array.isArray(raw.prompts)) {
      out.prompts = raw.prompts.filter((p: unknown): p is string => typeof p === "string");
    }
    if (raw.context && typeof raw.context === "object") {
      const ctx: MRConfig["context"] = {};
      if (Array.isArray(raw.context.include)) {
        ctx.include = raw.context.include.filter((p: unknown): p is string => typeof p === "string");
      }
      if (Array.isArray(raw.context.exclude)) {
        ctx.exclude = raw.context.exclude.filter((p: unknown): p is string => typeof p === "string");
      }
      out.context = ctx;
    }
    if (typeof raw.inline === "string") out.inline = raw.inline;
    if (raw.agent && typeof raw.agent === "object") {
      const a: MRConfig["agent"] = {};
      if (typeof raw.agent.cli === "string") a.cli = raw.agent.cli;
      if (Array.isArray(raw.agent.args)) {
        a.args = raw.agent.args.filter((x: unknown): x is string => typeof x === "string");
      }
      if (typeof raw.agent.maxDiffKb === "number") a.maxDiffKb = raw.agent.maxDiffKb;
      out.agent = a;
    }
    return out;
  } catch {
    return {};
  }
}

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a config path: absolute → as-is, ~/... → homedir-relative,
 * otherwise → resolved relative to dataDir (~/.rt/<repo>).
 */
export function resolveConfigPath(raw: string, dataDir: string): string {
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  if (raw === "~") return homedir();
  if (isAbsolute(raw)) return raw;
  return join(dataDir, raw);
}

// ─── Prompt file reading (.mdc frontmatter strip) ────────────────────────────

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Read a prompt file. For `.mdc` files (cursor-rules style), strip the YAML
 * frontmatter block at the top. Returns `null` if the file doesn't exist or
 * isn't readable (caller decides whether to warn).
 */
export function readPromptFile(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    if (path.endsWith(".mdc")) {
      return raw.replace(FRONTMATTER_RE, "").trimStart();
    }
    return raw;
  } catch {
    return null;
  }
}
