/**
 * The one description of "a Linear MCP server" in rt: where Claude Code's
 * config lives, what counts as a Linear MCP by shape, and the single entry
 * Install adds. Kept apart from both the `linear.mcp` step and the
 * `tool.linear-mcp` row so the validator never imports a step and the two
 * can never disagree about what they are looking at.
 */
import { dirname, join } from "path";
import type { Probes } from "./probes.ts";

export const LINEAR_MCP_SERVER_NAME = "linear";
export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";
const LINEAR_MCP_HOST = "mcp.linear.app";

export interface McpServerEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  [k: string]: unknown;
}

export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

/**
 * Claude Code keeps this file NEXT TO a custom CLAUDE_CONFIG_DIR but at the
 * home root by default. Deriving it from the default config dir instead
 * would pick `~/.claude/.claude.json`, a relic Claude Code no longer reads.
 */
export function claudeJsonPath(p: Pick<Probes, "env" | "home">): string {
  const dir = p.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : join(p.home, ".claude.json");
}

/**
 * By shape, never by name: `linear-matt` and `linear-work` are one person's
 * artifacts. Auth is not part of the test, because the hosted server is
 * equally valid with a bearer header and with Claude Code's own OAuth, which
 * stores no header here at all.
 */
export function isLinearMcp(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as McpServerEntry;
  if (typeof e.url === "string") {
    try {
      if (new URL(e.url).hostname === LINEAR_MCP_HOST) return true;
    } catch {
      // A malformed url is simply not a match.
    }
  }
  const argv = [e.command, ...(Array.isArray(e.args) ? e.args : [])].filter((v) => typeof v === "string").join(" ");
  return argv.includes("linear-mcp");
}

export type ConfigRead =
  | { ok: true; config: ClaudeConfig }
  | { ok: false; reason: "absent" }
  | { ok: false; reason: "unreadable" }
  | { ok: false; reason: "unparsable" };

/**
 * `absent` is the one reason a caller may answer by writing the path, so it
 * must be proven, not assumed: the readFile probe collapses EVERY error into
 * null (a root-owned file, mode 0000, an ELOOPing symlink chain, a transient
 * EMFILE), which without the exists check is indistinguishable from no file
 * at all, and the file being replaced is Claude Code's live session state.
 */
export function readClaudeConfig(p: Pick<Probes, "readFile" | "exists">, path: string): ConfigRead {
  const raw = p.readFile(path);
  if (raw === null) return { ok: false, reason: p.exists(path) ? "unreadable" : "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "unparsable" };
  }
  // JSON.parse accepts any value: a bare number or array is valid JSON and
  // an invalid config, and merging into one would destroy the file.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "unparsable" };
  // The merge spreads mcpServers, so a present-but-not-plain-object value
  // there would be dropped on write rather than merged into. Refuse the file
  // instead; null and missing both mean "no servers" and merge correctly.
  const servers = (parsed as ClaudeConfig).mcpServers;
  if (servers !== undefined && servers !== null && (typeof servers !== "object" || Array.isArray(servers))) return { ok: false, reason: "unparsable" };
  return { ok: true, config: parsed as ClaudeConfig };
}

export function linearServerNames(config: ClaudeConfig): string[] {
  return Object.entries(config.mcpServers ?? {})
    .filter(([, entry]) => isLinearMcp(entry))
    .map(([name]) => name);
}

/** The name is taken whatever sits under it: an unrelated server called `linear` is not ours to move. */
export function nameTaken(config: ClaudeConfig): boolean {
  return Object.hasOwn(config.mcpServers ?? {}, LINEAR_MCP_SERVER_NAME);
}

/** `mcp__linear__get_issue` resolves on the server NAME, so a Linear MCP under any other name is unreachable from the skills. */
export function callableBySkills(config: ClaudeConfig): boolean {
  return isLinearMcp(config.mcpServers?.[LINEAR_MCP_SERVER_NAME]);
}

export function withLinearEntry(config: ClaudeConfig, apiKey: string): ClaudeConfig {
  return {
    ...config,
    mcpServers: {
      ...(config.mcpServers ?? {}),
      [LINEAR_MCP_SERVER_NAME]: { type: "http", url: LINEAR_MCP_URL, headers: { Authorization: `Bearer ${apiKey}` } },
    },
  };
}

/**
 * The target is Claude Code's live state file (hundreds of KB of session
 * state), so the replace is atomic: a partial write over it would leave the
 * user with a corrupt config. 0600 on the temp file because the rename
 * carries the temp file's own mode onto a path holding an API token, and the
 * explicit chmod because writeFile's mode only lands on a freshly created
 * inode: a temp file left behind by an earlier failed rename is reused at
 * whatever mode it already had.
 */
export function writeClaudeConfig(p: Pick<Probes, "mkdirp" | "writeFile" | "rename" | "chmod" | "removeFile">, path: string, config: ClaudeConfig): void {
  const tmp = `${path}.rt-tmp`;
  p.mkdirp(dirname(path));
  // Unlink first so the token always lands on a fresh 0600 inode: writing
  // through a temp file left by an earlier failed rename would expose the
  // content at that file's old mode until the chmod below.
  p.removeFile(tmp);
  p.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", 0o600);
  p.chmod(tmp, 0o600);
  try {
    p.rename(tmp, path);
  } catch (err) {
    p.removeFile(tmp); // a failed rename must not leave the token in a stray file
    throw err;
  }
}
