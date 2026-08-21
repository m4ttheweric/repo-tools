/**
 * rt settings get/set/list/explain — the resolver-backed settings verbs
 * (RT-47 Task 6). Kept separate from commands/settings.ts (token/notification/
 * dev-mode/runaway leaves) so this file owns only the four resolver verbs.
 *
 *   rt settings get <key> [--repo <name>] [--json]
 *   rt settings set <key> <json-value> --scope user|team|machine [--repo <name>] [--team <name>]
 *   rt settings list [--repo <name>] [--json]
 *   rt settings explain <key> [--repo <name>]
 *
 * `--repo <name>` resolves a repo NAME to a path via ~/.mattstack/rt/repos.json,
 * derives its identity (async — never a sync spawn), and feeds the resolver
 * `expandCtx.repoRoot` (so a `${repoRoot}` value in a `get` never throws when
 * --repo was given). Without --repo, an unexpandable `${repoRoot}` is the
 * honest outcome of `get` — its thrown message is rendered cleanly and the
 * process exits 1, no stack trace.
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
import { getDef, isMigrated, type SettingDef, type SettingScope } from "../lib/settings/registry.ts";
import { buildInterceptRules, writeInterceptRules } from "../lib/endpoint/shim.ts";

// ─── arg parsing (commands/events.ts conventions) ────────────────────────────

const FLAGS_WITH_VALUES = new Set(["--repo", "--scope", "--team"]);

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
}

function repoIndex(): Record<string, string> {
  return readJson<Record<string, string>>(join(rtDir(), "repos.json"), {});
}

/**
 * Resolves `--repo <name>` for the READ verbs (get/list/explain).
 *
 * When the name resolves to a path but no identity derives (a local-path
 * remote, no remote at all, an unrecognized host), the repo rungs of every
 * store are simply unreachable — `${repoRoot}` still answers, so the command
 * succeeds with a strictly smaller ladder. That is an honest degrade, but a
 * SILENT one is a trap: the user asked about a repo and got an answer that
 * quietly ignored every repo-scoped value. So say it once, dim, on stderr —
 * the resolved value still lands on stdout unpolluted, and `--json` output is
 * untouched. `set` does not come through here; it refuses outright rather
 * than writing into a section nothing will read back.
 */
async function resolveRepoContext(repoName: string | undefined): Promise<RepoContext> {
  if (!repoName) return { repoIdentity: null };
  const repoPath = repoIndex()[repoName];
  if (!repoPath) fail(`repo "${repoName}" is not registered in ~/.mattstack/rt/repos.json`);
  const identity = await deriveRepoIdentity(repoPath);
  if (!identity) {
    console.error(
      `${dim}identity: none derivable for ${repoName} — repo sections unreachable (see rt.repoIdentityOverrides)${reset}`,
    );
  }
  return {
    repoIdentity: identity,
    expandCtx: { repoRoot: repoPath },
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
  if (isMigrated(def)) return null;
  return def.legacyFile ? `reads legacy: ${def.legacyFile}` : "not writable through the settings resolver yet";
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
      migrated: isMigrated(def),
      ...(isMigrated(def) ? {} : { legacyFile: def.legacyFile ?? null }),
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
  const usage = "usage: rt settings set <key> <json-value> --scope user|team|machine [--repo <name>] [--team <name>]";
  if (!key || rawValue === undefined) fail(usage);
  if (!scope) fail(`${usage} (--scope is required)`);
  if (!VALID_SCOPES.includes(scope as SettingScope)) {
    fail(`--scope must be one of ${VALID_SCOPES.join(", ")} (got "${scope}")`);
  }

  // `--team` is the CLI surface for `setSetting`'s team selection (see
  // write.ts's "Team selection"). It only means anything at team scope; taking
  // it silently at user/machine scope would let `rt settings set … --scope
  // user --team acme` look like it targeted a team store while writing
  // the user one.
  const team = flagValue(args, "--team");
  if (args.includes("--team")) {
    if (scope !== "team") fail(`--team only applies to --scope team (got --scope ${scope})`);
    if (team === undefined || team.startsWith("--") || team.trim() === "") fail("--team requires a team name");
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
    setSetting(key, value, scope as SettingScope, { repoIdentity, team });
  } catch (err) {
    failWithError(err);
  }

  const where = [scope === "team" && team ? `team:${team}` : scope, ...(repoName ? [repoName] : [])].join(", ");
  console.log(`\n  ${green}✓${reset} ${bold}${key}${reset} set (${where})`);

  // See "the intercepts.json regeneration seam" below for why the write side
  // owns this and why it is not a full `rt intercept install`.
  const regen = await regenerateInterceptsCache(key);
  if (regen.regenerated) {
    console.log(`  ${dim}intercepts.json regenerated (${regen.rules} rule${regen.rules === 1 ? "" : "s"})${reset}`);
  } else if (regen.error) {
    console.log(`  ${yellow}could not regenerate intercepts.json (${regen.error}) — run \`rt intercept install\`${reset}`);
  }
  console.log("");
}

// ─── the intercepts.json regeneration seam ──────────────────────────────────
//
// ~/.mattstack/rt/intercepts.json is a CACHE of what `loadEndpointConfig`
// would return for every registered repo; the intercept shim's match path
// reads only that file, never the resolver (it must stay spawn-free and
// instant). So a `set` of a key the cache is built from has to regenerate it,
// or the next intercepted command matches against the pre-write rules.
//
// The dependency direction is deliberate and one-way: this command module
// imports lib/endpoint/shim.ts, and nothing under lib/endpoint imports a
// command module — so the writer (which is the only place that KNOWS a write
// just happened) drives the regen, and no import cycle exists. Putting the
// hook inside setSetting would have inverted that, dragging the endpoint
// module (and its git spawns) into every settings write.
//
// Deliberately NOT `installShims()`: writing executables onto the user's PATH
// is not a side effect `rt settings set` should have silently. A newly
// intercepted command therefore lands in the cache but has no shim yet, which
// `rt intercept status` and `rt verify` both already report as "declared but
// not installed → run rt intercept install".

/** The keys `buildInterceptRules` resolves; a write to either invalidates the cache. */
const INTERCEPT_CACHE_KEYS = new Set(["rt.intercepts", "rt.roles"]);

export interface RegenResult {
  regenerated: boolean;
  /** Rules written, when regenerated. */
  rules?: number;
  /** Why it failed, when it failed. Never thrown — the `set` itself already succeeded. */
  error?: string;
}

/**
 * Rebuilds intercepts.json when `key` is one the cache is derived from.
 *
 * Never throws: by the time this runs the store write has already landed, so
 * a regen failure must be reported (the caller prints it) rather than turned
 * into a failed `set` the user would retry pointlessly. `rt intercept install`
 * is always the manual recovery.
 */
export async function regenerateInterceptsCache(key: string): Promise<RegenResult> {
  if (!INTERCEPT_CACHE_KEYS.has(key)) return { regenerated: false };
  try {
    const rules = await buildInterceptRules();
    writeInterceptRules(rules);
    return { regenerated: true, rules: rules.length };
  } catch (err) {
    return { regenerated: false, error: (err as Error).message };
  }
}

// ─── list ───────────────────────────────────────────────────────────────────

export async function settingsList(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const repoCtx = await resolveRepoContext(flagValue(args, "--repo"));

  const settings = listSettings({
    repoIdentity: repoCtx.repoIdentity,
    expandCtx: repoCtx.expandCtx,
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
  // `migrated` is a registry fact, so an UNREGISTERED row has none — it comes
  // back false by default. Labelling those "reads legacy" would name a
  // migration window that does not exist for a key rt has never heard of;
  // "unregistered" is the whole story there.
  if (!s.migrated && !s.unregistered) {
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
