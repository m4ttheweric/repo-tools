/**
 * rt settings get/set/list/explain — the resolver-backed settings verbs
 * (RT-47 Task 6). Kept separate from commands/settings.ts (token/notification/
 * dev-mode/runaway leaves) so this file owns only the four resolver verbs.
 *
 *   rt settings get <key> [--repo <name>] [--json]
 *   rt settings set <key> <json-value> --scope user|team|machine [--repo <name>]
 *   rt settings list [--repo <name>] [--json]
 *   rt settings explain <key> [--repo <name>]
 *
 * `--repo <name>` resolves a repo NAME to a path via ~/.mattstack/rt/repos.json,
 * derives its identity (async — never a sync spawn), and feeds the resolver
 * both `legacy.repoName` (the wave-1 legacy rung) and `expandCtx.repoRoot`
 * (so a `${repoRoot}` value in a `get` never throws when --repo was given).
 * Without --repo, an unexpandable `${repoRoot}` is the honest outcome of
 * `get` — its thrown message is rendered cleanly and the process exits 1,
 * no stack trace.
 *
 * These verbs run entirely in-process against lib/settings/resolve.ts and
 * write.ts (both daemon-free, sync-spawn-free) — they do not go through the
 * daemon. The daemon's settings:get/settings:list handlers
 * (lib/daemon/handlers/settings.ts) exist for other in-process-unfriendly
 * consumers and are deliberately expand:false, repo-context-free.
 */

import { join } from "path";
import { parse, type ParseError } from "jsonc-parser";
import { bold, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { readJson } from "../lib/json-store.ts";
import { rtDir } from "../lib/rt-paths.ts";
import { deriveRepoIdentity } from "../lib/settings/identity.ts";
import {
  explainSetting,
  getSetting,
  listSettings,
  type ExplainRow,
  type ListedSetting,
  type Provenance,
  type Resolved,
} from "../lib/settings/resolve.ts";
import { setSetting } from "../lib/settings/write.ts";
import { getDef, type SettingDef, type SettingScope } from "../lib/settings/registry.ts";

// ─── arg parsing (commands/events.ts conventions) ────────────────────────────

const FLAGS_WITH_VALUES = new Set(["--repo", "--scope"]);

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (FLAGS_WITH_VALUES.has(a)) i++; // skip the flag's value slot
      continue;
    }
    out.push(a);
  }
  return out;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`rt settings: ${msg}`);
  process.exit(1);
}

/** Renders a thrown resolver/write error cleanly — no "rt settings:" double-prefix (the resolver's own messages already start with "rt: "), no stack trace. */
function failWithError(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// ─── --repo resolution ────────────────────────────────────────────────────────

interface RepoContext {
  repoIdentity: string | null;
  /** Always set when --repo was given, regardless of whether identity derivation succeeded — this is what lets `${repoRoot}` expand even for a repo whose remote doesn't normalize to an identity. */
  expandCtx?: { repoRoot: string };
  legacy?: { repoName: string };
}

function repoIndex(): Record<string, string> {
  return readJson<Record<string, string>>(join(rtDir(), "repos.json"), {});
}

async function resolveRepoContext(repoName: string | undefined): Promise<RepoContext> {
  if (!repoName) return { repoIdentity: null };
  const repoPath = repoIndex()[repoName];
  if (!repoPath) fail(`repo "${repoName}" is not registered in ~/.mattstack/rt/repos.json`);
  const identity = await deriveRepoIdentity(repoPath);
  return {
    repoIdentity: identity,
    expandCtx: { repoRoot: repoPath },
    legacy: { repoName },
  };
}

// ─── formatting helpers ────────────────────────────────────────────────────────

/** Compact one-line rendering for list/explain rows. */
export function formatValueInline(value: unknown): string {
  if (value === undefined) return "<unset>";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Multi-line rendering for a single `get`. */
export function formatValuePretty(value: unknown): string {
  if (value === undefined) return "<unset>";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function formatProvenance(provenance: Provenance[]): string {
  if (provenance.length === 0) return "(no provenance — value is unset)";
  return provenance.map((p) => (p.file ? `${p.scope} (${p.file})` : p.scope)).join(" + ");
}

/**
 * The `migrated:false` loud-degrade label: "reads legacy: <file>" plus the
 * sibling live command when the registry names one — spec: "list LABELS
 * them (`reads legacy: <file>`)". Returns null for a migrated key (nothing
 * to render).
 */
export function migratedNote(def: SettingDef): string | null {
  if (def.migrated) return null;
  const legacyPart = def.legacyFile ? `reads legacy: ${def.legacyFile}` : "not writable through the settings resolver yet";
  const siblingPart = def.siblingCommand ? ` — use \`${def.siblingCommand}\`` : "";
  return `${legacyPart}${siblingPart}`;
}

// ─── get ────────────────────────────────────────────────────────────────────

export async function settingsGet(args: string[]): Promise<void> {
  const [key] = positionals(args);
  if (!key) fail("usage: rt settings get <key> [--repo <name>] [--json]");
  const json = args.includes("--json");
  const repoCtx = await resolveRepoContext(flagValue(args, "--repo"));

  let resolved: Resolved<unknown>;
  try {
    resolved = getSetting(key, {
      repoIdentity: repoCtx.repoIdentity,
      expandCtx: repoCtx.expandCtx,
      legacy: repoCtx.legacy,
    });
  } catch (err) {
    failWithError(err);
  }

  const def = getDef(key) as SettingDef; // getSetting already threw for an unregistered key

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      key,
      value: resolved.value,
      provenance: resolved.provenance,
      migrated: def.migrated,
      ...(def.migrated ? {} : { legacyFile: def.legacyFile ?? null, siblingCommand: def.siblingCommand ?? null }),
    }));
    return;
  }

  console.log("");
  console.log(`  ${bold}${key}${reset}`);
  console.log(`  ${formatValuePretty(resolved.value)}`);
  console.log(`  ${dim}${formatProvenance(resolved.provenance)}${reset}`);
  const note = migratedNote(def);
  if (note) console.log(`  ${yellow}${note}${reset}`);
  console.log("");
}

// ─── set ────────────────────────────────────────────────────────────────────

const VALID_SCOPES: SettingScope[] = ["user", "team", "machine"];

export async function settingsSet(args: string[]): Promise<void> {
  const [key, rawValue] = positionals(args);
  const scope = flagValue(args, "--scope");
  const usage = "usage: rt settings set <key> <json-value> --scope user|team|machine [--repo <name>]";
  if (!key || rawValue === undefined) fail(usage);
  if (!scope) fail(`${usage} (--scope is required)`);
  if (!VALID_SCOPES.includes(scope as SettingScope)) {
    fail(`--scope must be one of ${VALID_SCOPES.join(", ")} (got "${scope}")`);
  }

  const trimmed = rawValue.trim();
  if (trimmed === "") fail(`<json-value> is not valid JSON(C): ${rawValue}`);
  const errors: ParseError[] = [];
  const value = parse(trimmed, errors, { allowTrailingComma: true });
  if (errors.length > 0) fail(`<json-value> is not valid JSON(C): ${rawValue}`);

  const repoName = flagValue(args, "--repo");
  let repoIdentity: string | undefined;
  if (repoName) {
    const repoPath = repoIndex()[repoName];
    if (!repoPath) fail(`repo "${repoName}" is not registered in ~/.mattstack/rt/repos.json`);
    const identity = await deriveRepoIdentity(repoPath);
    if (!identity) fail(`repo "${repoName}"'s remote does not normalize to an identity — repo-scoped settings are unreachable for it (see \`rt settings explain\`)`);
    repoIdentity = identity;
  }

  try {
    setSetting(key, value, scope as SettingScope, { repoIdentity });
  } catch (err) {
    failWithError(err);
  }

  console.log(`\n  ${green}✓${reset} ${bold}${key}${reset} set (${scope}${repoName ? `, ${repoName}` : ""})\n`);
}

// ─── list ───────────────────────────────────────────────────────────────────

export async function settingsList(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const repoCtx = await resolveRepoContext(flagValue(args, "--repo"));

  const settings = listSettings({
    repoIdentity: repoCtx.repoIdentity,
    expandCtx: repoCtx.expandCtx,
    legacy: repoCtx.legacy,
  });

  if (json) {
    console.log(JSON.stringify({ ok: true, settings }));
    return;
  }

  console.log("");
  for (const s of settings) {
    console.log(renderListRow(s));
  }
  console.log("");
}

export function renderListRow(s: ListedSetting): string {
  const labels: string[] = [];
  if (s.unregistered) labels.push("unregistered");
  if (!s.migrated) {
    const def = getDef(s.key);
    labels.push(def ? (migratedNote(def) as string) : "reads legacy");
  }
  if (s.expandError) labels.push(`expandError: ${s.expandError}`);
  for (const inv of s.invalid ?? []) labels.push(`invalid[${inv.scope}]: ${inv.reason}`);

  const labelStr = labels.length > 0 ? `  ${yellow}(${labels.join("; ")})${reset}` : "";
  return `  ${bold}${s.key}${reset} = ${formatValueInline(s.value)}${labelStr}`;
}

// ─── explain ────────────────────────────────────────────────────────────────

export async function settingsExplain(args: string[]): Promise<void> {
  const [key] = positionals(args);
  if (!key) fail("usage: rt settings explain <key> [--repo <name>]");
  const repoCtx = await resolveRepoContext(flagValue(args, "--repo"));

  let rows: ExplainRow[];
  try {
    rows = explainSetting(key, {
      repoIdentity: repoCtx.repoIdentity,
      legacy: repoCtx.legacy,
    });
  } catch (err) {
    failWithError(err);
  }

  console.log("");
  console.log(`  ${bold}${key}${reset}`);
  for (const row of rows) {
    console.log(renderExplainRow(row));
  }
  console.log("");
}

/**
 * One row per reachable rung, weakest-first (the order explainSetting
 * already returns them in — SCOPE_ORDER — is the stable sort). present rows
 * show their authored value; shadowed (teamLocked) and invalid rows are
 * marked but not applied.
 */
export function renderExplainRow(row: ExplainRow): string {
  const scopeLabel = row.scope.padEnd(11);
  const fileLabel = row.file ?? (row.scope === "default" ? "(registry default)" : "(no file)");

  if (!row.present) {
    return `  ${dim}${scopeLabel} ${fileLabel}  —${reset}`;
  }

  if (row.shadowed) {
    return `  ${dim}${scopeLabel}${reset} ${fileLabel}  ${formatValueInline(row.value)}  ${yellow}[shadowed: ${row.shadowed}]${reset}`;
  }
  if (row.invalid) {
    return `  ${dim}${scopeLabel}${reset} ${fileLabel}  ${formatValueInline(row.value)}  ${red}[invalid: ${row.invalid}]${reset}`;
  }
  return `  ${green}${scopeLabel}${reset} ${fileLabel}  ${formatValueInline(row.value)}`;
}
