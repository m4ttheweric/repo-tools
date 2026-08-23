/**
 * Branch naming template resolver — VSCode extension copy.
 *
 * Synchronous-only: supports ${identifier}, ${teamPrefix}, ${ticketNumber},
 * ${titleSlug}. ${llmSlug:N} falls back to a mechanical slug (LLM is CLI-only).
 *
 * `loadBranchNamingConfig` resolves `rt.branchNaming` through rt-client's
 * settings resolver (ownership latch, docs/settings-architecture.md): the
 * store wins once it holds a value for this repo identity; otherwise the
 * legacy `<dataDir>/branch-naming.json` file stays authoritative and is
 * lazily imported into the store on read, then renamed (never deleted) so a
 * second read never re-imports it. Imports write to the TEAM.repo rung
 * (docs/superpowers/specs/2026-08-20-suite-settings-migration.md's key
 * disposition table: a branch template is a repo convention, not a personal
 * preference, same reasoning as `rt.sync`/`rt.variations`). A machine with no
 * cloned team store (or more than one) can't take a `scope: "team"` write —
 * `setSetting` refuses, which this treats as any other import failure: warn,
 * leave the legacy file in place, serve the value from it this run.
 */

import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { getSetting, setSetting } from "@mattstack/rt-client";

export interface BranchNamingConfig {
  template: string;
}

const SETTING_KEY = "rt.branchNaming";

function asConfig(raw: unknown): BranchNamingConfig | null {
  const template = (raw as { template?: unknown } | null)?.template;
  if (typeof template !== "string" || !template.trim()) return null;
  return { template: template.trim() };
}

/**
 * `value === undefined` is the ownership-latch signal (docs/settings-
 * architecture.md#porting-an-apps-config): the store has nothing for this
 * repo identity. A resolver throw (e.g. a hand-authored value using an
 * unexpandable closed-set variable like `${worktree}`) counts as unowned
 * too, per the same doc — it must degrade to the legacy file, not surface.
 */
function probeStore(repoIdentity: string | null): { owned: boolean; value: BranchNamingConfig | null } {
  try {
    const { value } = getSetting<unknown>(SETTING_KEY, { repoIdentity });
    if (value === undefined) return { owned: false, value: null };
    return { owned: true, value: asConfig(value) };
  } catch {
    return { owned: false, value: null };
  }
}

/**
 * Imports the legacy file's template into the team.repo store rung, then
 * verifies the import actually landed (a fresh `getSetting` read — the
 * resolver never memoizes) before renaming the file. Never unlinks: a write
 * that silently failed to persist must leave the only copy of the template
 * on disk. `setSetting`'s single-team auto-detection picks the team when
 * exactly one has a local store; zero or multiple refuse, caught below like
 * any other import failure.
 */
function migrateLegacyFile(legacyPath: string, repoIdentity: string, config: BranchNamingConfig): void {
  try {
    setSetting(SETTING_KEY, { template: config.template }, "team", { repoIdentity });
  } catch (err) {
    console.warn(`rt-context: could not import ${legacyPath} into the settings store: ${(err as Error).message}`);
    return;
  }

  let verified: BranchNamingConfig | null;
  try {
    verified = asConfig(getSetting<unknown>(SETTING_KEY, { repoIdentity }).value);
  } catch (err) {
    console.warn(`rt-context: imported ${legacyPath} but could not verify the write: ${(err as Error).message}`);
    return;
  }

  if (!verified || verified.template !== config.template) {
    console.warn(`rt-context: imported ${legacyPath} but the store did not read back the same value — leaving the file in place`);
    return;
  }

  try {
    renameSync(legacyPath, `${legacyPath}.migrated`);
  } catch (err) {
    console.warn(`rt-context: imported ${legacyPath} but could not rename it to .migrated: ${(err as Error).message}`);
  }
}

/**
 * `dataDir` locates the legacy file; `repoIdentity` (identity.ts's
 * normalized `host/path`, or null when it can't be derived for this repo)
 * keys the store's repo-scoped rung. Never throws — a resolution failure
 * returns null exactly like a missing/corrupt file always has.
 */
export function loadBranchNamingConfig(
  dataDir: string,
  repoIdentity: string | null,
): BranchNamingConfig | null {
  try {
    const probe = probeStore(repoIdentity);
    if (probe.owned) return probe.value;

    const legacyPath = join(dataDir, "branch-naming.json");
    if (!existsSync(legacyPath)) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(legacyPath, "utf8"));
    } catch (err) {
      console.warn(`rt-context: legacy branch-naming file ${legacyPath} is corrupt JSON, leaving in place: ${(err as Error).message}`);
      return null;
    }

    const config = asConfig(raw);
    if (!config) return null;

    if (repoIdentity !== null) migrateLegacyFile(legacyPath, repoIdentity, config);

    return config;
  } catch {
    return null;
  }
}

function mechanicalSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const VAR_RE = /\$\{([a-zA-Z]+(?::\d+)?)\}/g;

export function resolveBranchName(
  ticket: { identifier: string; title: string },
  config: BranchNamingConfig | null,
): string {
  const template = config?.template ?? "${identifier}-${titleSlug}";

  let result = "";
  let lastIndex = 0;

  VAR_RE.lastIndex = 0;

  let match: ReturnType<typeof VAR_RE.exec>;
  while ((match = VAR_RE.exec(template)) !== null) {
    result += template.slice(lastIndex, match.index);

    const raw = match[1]!;
    let varName: string;
    let llmMaxChars: number | undefined;

    if (raw.startsWith("llmSlug")) {
      const colonIdx = raw.indexOf(":");
      if (colonIdx === -1) {
        throw new Error(`Invalid variable \${${raw}}. \${llmSlug} requires :N`);
      }
      const n = parseInt(raw.slice(colonIdx + 1), 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid variable \${${raw}}. N must be a positive integer`);
      }
      varName = "llmSlug";
      llmMaxChars = n;
    } else {
      varName = raw;
    }

    switch (varName) {
      case "identifier":
        result += ticket.identifier.toLowerCase();
        break;
      case "teamPrefix":
        result += ticket.identifier.split("-")[0]?.toLowerCase() ?? "";
        break;
      case "ticketNumber":
        result += ticket.identifier.split("-").slice(1).join("-") ?? "";
        break;
      case "titleSlug":
        result += mechanicalSlug(ticket.title);
        break;
      case "llmSlug":
        // LLM is CLI-only; use mechanical slug truncated to maxChars
        result += mechanicalSlug(ticket.title).slice(0, llmMaxChars!);
        break;
      default:
        throw new Error(`Unknown variable \${${raw}}`);
    }

    lastIndex = match.index + match[0].length;
  }

  result += template.slice(lastIndex);
  result = result.replace(/^\/+|\/+$/g, "").trim();

  if (!result) {
    return `${ticket.identifier.toLowerCase()}-${mechanicalSlug(ticket.title)}`;
  }

  return result;
}
