/**
 * The team-pack half of Claude Code plugin management: what the team clone
 * serves, what is installed, and the per-pack sequence that converges one to
 * the other. Lives apart from `steps/plugins.ts` so the daemon and the status
 * validator can both use it without importing a setup step.
 */

import { join } from "path";
import { stripJsonc } from "../jsonc.ts";
import type { ExecResult, Probes } from "./probes.ts";

export interface ServedPack {
  id: string;
  name: string;
  servedVersion: string | null;
}

/** `error` is non-null only for a marketplace.json that exists and did not parse. */
export interface ServedPacks {
  packs: ServedPack[];
  error: string | null;
}

export interface InstalledPack {
  id: string;
  version: string | null;
  enabled: boolean;
}

interface MarketplaceEntry {
  name?: unknown;
  source?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parse boundary: any element missing a string `id` rejects the whole
 * payload, rather than dropping just that element. A schema violation anywhere
 * means the shape cannot be trusted, so the honest answer is "could not be
 * read", not a silently incomplete list. A missing `enabled` or `version` is
 * not such a violation: both are normalized.
 */
export function parsePluginList(stdout: string): InstalledPack[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: InstalledPack[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item) || typeof item.id !== "string") return null;
    entries.push({
      id: item.id,
      version: typeof item.version === "string" ? item.version : null,
      enabled: item.enabled === true,
    });
  }
  return entries;
}

function teamCloneDir(home: string, slug: string): string {
  return join(home, ".mattstack", "teams", slug);
}

function readVersion(p: Pick<Probes, "readFile">, pluginDir: string): string | null {
  const raw = p.readFile(join(pluginDir, ".claude-plugin", "plugin.json"));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(stripJsonc(raw)) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * A null `servedVersion` means rt cannot read a version for that pack (an
 * object-form source, or an unreadable plugin.json). Callers must treat that
 * as "outside the converge", never as a version mismatch.
 */
export function readServedPacks(p: Pick<Probes, "readFile" | "home">, slug: string): ServedPacks {
  const clone = teamCloneDir(p.home, slug);
  const path = join(clone, ".claude-plugin", "marketplace.json");
  const raw = p.readFile(path);
  if (raw === null) return { packs: [], error: null };

  let parsed: { name?: unknown; plugins?: unknown };
  try {
    parsed = JSON.parse(stripJsonc(raw)) as { name?: unknown; plugins?: unknown };
  } catch {
    return { packs: [], error: `${path} did not parse` };
  }

  const marketplace = typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : slug;
  const entries = Array.isArray(parsed.plugins) ? (parsed.plugins as MarketplaceEntry[]) : [];
  const packs: ServedPack[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) continue;
    const servedVersion = typeof entry.source === "string" ? readVersion(p, join(clone, entry.source)) : null;
    packs.push({ id: `${entry.name}@${marketplace}`, name: entry.name, servedVersion });
  }
  return { packs, error: null };
}

/** Measured against the real ClaimView pack (1.1 MB, 106 files): install 0.86s, disable 0.40s, uninstall 0.41s. */
export const SETTLE_EXEC_TIMEOUT_MS = 30_000;
/** Three settlement execs. A settlement never starts without this much budget left, so it can never abort part-way and strand a pack installed-and-enabled. */
export const SETTLEMENT_MAX_MS = 3 * SETTLE_EXEC_TIMEOUT_MS;
export const PACK_EXEC_TIMEOUT_MS = 60_000;
/** 30s fetch + this must stay under commands/team.ts PULL_TIMEOUT_MS (180_000). */
export const CONVERGE_BUDGET_MS = 120_000;

export interface ClaudeRunner {
  run(args: string[], timeoutMs: number): Promise<ExecResult>;
}

export type SettleOutcome =
  | { kind: "installed"; id: string }
  | { kind: "current"; id: string }
  | { kind: "rolledBack"; id: string; detail: string }
  /** `stage` and `code` let plugins.install keep its exact contract wording for a clean install failure. Only these two stages can fail terminally: a failed `disable` becomes a rollback, never a failure of its own. */
  | { kind: "failed"; id: string; detail: string; stage: "install" | "rollback"; code: number };

function isAlready(res: ExecResult): boolean {
  return /already (installed|added|exists)/i.test(res.stderr);
}

function isAlreadyDisabled(res: ExecResult): boolean {
  return /already disabled/i.test(res.stderr);
}

/** `claude plugin uninstall` on an absent pack says "not found in installed plugins", which this matches. */
function isAlreadyGone(res: ExecResult): boolean {
  return /not installed|not found/i.test(`${res.stdout}\n${res.stderr}`);
}

/**
 * Installs a pack and, for a team-authored one, settles its enable state by
 * undoing the install rather than leaving the pack enabled. A trusted pack is
 * installed and handed straight back; its enable belongs to the caller. The
 * invariant every branch preserves: on return the pack is installed-and-settled
 * or not installed, never installed-and-enabled for a team-authored pack.
 */
export async function settlePack(runner: ClaudeRunner, id: string, opts: { teamAuthored: boolean }): Promise<SettleOutcome> {
  const install = await runner.run(["plugin", "install", id], SETTLE_EXEC_TIMEOUT_MS);

  if (install.code !== 0) {
    // A pack that already exists appeared underneath this run, so rt did not
    // install it and does not get to change its enablement.
    if (isAlready(install)) return { kind: "current", id };
    // SIGKILL can land after the install wrote its records, so a timeout cannot
    // be read as "nothing happened"; undo it before reporting failure.
    if (install.code === 124) {
      const undo = await runner.run(["plugin", "uninstall", id], SETTLE_EXEC_TIMEOUT_MS);
      const detail = `install timed out; rollback ${undo.code === 0 || isAlreadyGone(undo) ? "ok" : `failed: ${undo.stderr.trim()}`}`;
      return { kind: "failed", id, detail, stage: "install", code: install.code };
    }
    return { kind: "failed", id, detail: install.stderr.trim() || `install exited ${install.code}`, stage: "install", code: install.code };
  }

  // A trusted plugin is installed and handed back. Enabling it is the caller's
  // job, so every trusted-only rule (and its logging) lives in one place; this
  // function is "install a pack and make sure it is not left enabled".
  if (!opts.teamAuthored) return { kind: "installed", id };

  const disable = await runner.run(["plugin", "disable", id], SETTLE_EXEC_TIMEOUT_MS);
  if (disable.code === 0 || isAlreadyDisabled(disable)) return { kind: "installed", id };

  const undo = await runner.run(["plugin", "uninstall", id], SETTLE_EXEC_TIMEOUT_MS);
  const why = disable.stderr.trim() || `disable exited ${disable.code}`;
  if (undo.code === 0 || isAlreadyGone(undo)) return { kind: "rolledBack", id, detail: why };
  return { kind: "failed", id, detail: `${why}; rollback failed: ${undo.stderr.trim()}`, stage: "rollback", code: undo.code };
}
