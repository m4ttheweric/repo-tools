/**
 * The settings schema registry (RT-47): a static table describing every
 * known `rt.*` settings key, plus lookup and validation helpers.
 *
 * This module is pure data — no file IO, no daemon dependency, safe to
 * import anywhere (including the daemon thread). The resolver
 * (lib/settings/resolve.ts) is the only consumer that layers store files on
 * top of these defs; this file just says what a key IS and what a legal
 * value for it looks like.
 *
 * `migrated: true` means the reader for this key goes through the resolver
 * (wave 1: rt.roles, rt.intercepts, rt.worktrees, rt.repoIdentityOverrides).
 * `migrated: false` keys still appear in `rt settings list` (so the full
 * settings map is visible even before a key's reader has been ported), but
 * `set` on them refuses — see the spec's "Schema registry" section for why
 * writing a value nothing reads is the dishonesty class this design bans.
 */

export type SettingScope = "user" | "team" | "machine";

export interface SettingDef {
  key: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  scopes: SettingScope[];
  default?: unknown;
  merge: "replace" | "deep";
  teamLocked?: boolean;
  secret?: boolean;
  repoScoped?: boolean;
  migrated: boolean;
  legacyFile?: string;
  siblingCommand?: string;
  pathGuardFields?: string[];
  description: string;
}

const ALL_SCOPES: SettingScope[] = ["user", "team", "machine"];

const REGISTRY: SettingDef[] = [
  // --- migrated:true (wave 1) ---------------------------------------------
  {
    key: "rt.roles",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: true,
    pathGuardFields: ["hook"],
    description: "Per-repo dev-role definitions: port pools, env passthrough, and the dev-server hook command.",
  },
  {
    key: "rt.intercepts",
    type: "array",
    scopes: ALL_SCOPES,
    merge: "replace",
    repoScoped: true,
    migrated: true,
    description: "Per-repo endpoint intercept rules consumed by rt intercept install.",
  },
  {
    key: "rt.worktrees",
    type: "object",
    scopes: ALL_SCOPES,
    default: { onDeck: 0 },
    merge: "deep",
    repoScoped: true,
    migrated: true,
    description: "Per-repo worktree pool config (onDeck size, ready steps, name pool); root/branchFormat/ready computed-or-empty in the reader.",
  },
  {
    key: "rt.repoIdentityOverrides",
    type: "object",
    scopes: ["machine"],
    merge: "replace",
    migrated: true,
    description: "Map of observed remote URL to pinned repo identity, for forks/multi-remote repos on this machine.",
  },
  {
    key: "rt.repoRoots",
    type: "array",
    scopes: ["machine"],
    default: [],
    merge: "replace",
    migrated: true,
    description:
      'Directories rt scans for git repos (rt cd, run-outside-a-repo pickers). Entries may start with "~/" or use "${home}". One level deep, plus worktree-pool parent folders one level deeper.',
  },

  // --- migrated:false (wave 1 legacy-file keys) ---------------------------
  {
    key: "rt.llm",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    migrated: false,
    legacyFile: "llm.json",
    description: "LLM provider and model selection for rt's AI-assisted commands.",
  },
  {
    key: "rt.cron",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    migrated: false,
    legacyFile: "cron.jsonc",
    description: "Scheduled rt job definitions and their cron expressions.",
  },
  {
    key: "rt.repoTracking",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    migrated: false,
    legacyFile: "repo-tracking.json",
    description: "Which repos rt tracks for background sync and status polling.",
  },
  {
    key: "rt.notifications",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    migrated: false,
    legacyFile: "notifications.json",
    siblingCommand: "rt settings notifications",
    description: "Desktop notification preferences (which events notify, sound on/off).",
  },
  {
    key: "rt.sync",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: false,
    legacyFile: "repos/<repo>/sync.json",
    description: "Branch sync behavior: fast-forward rules and stale-branch handling.",
  },
  {
    key: "rt.branchNaming",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: false,
    legacyFile: "repos/<repo>/branch-naming.json",
    description: "Templates rt uses to derive branch names from ticket identifiers.",
  },
  {
    key: "rt.variations",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: false,
    legacyFile: "repos/<repo>/variations.json",
    description: "Named parameter sets rt run can pick between for a command.",
  },
  {
    key: "rt.presets",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: false,
    legacyFile: "repos/<repo>/presets/<name>.json",
    description: "Saved argument presets for frequently repeated rt commands.",
  },
  {
    key: "rt.workspaceSync",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: false,
    legacyFile: "repos/<repo>/workspace-sync.json",
    description: "Rules for keeping herdr workspace layout in sync with active worktrees.",
  },
  {
    key: "rt.dopplerTemplate",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: false,
    legacyFile: "repos/<repo>/doppler-template.yaml",
    description: "Template used to generate a repo's Doppler secrets config.",
  },
  {
    key: "rt.workspacePrefs",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    migrated: false,
    legacyFile: "workspace-prefs.json",
    description: "Per-machine editor/terminal preferences applied when opening a worktree.",
  },
  {
    key: "rt.runaway",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    migrated: false,
    legacyFile: "runaway-config.json",
    siblingCommand: "rt settings runaway",
    description: "Thresholds for the runaway-process guard that kills stuck dev servers.",
  },
  {
    key: "rt.hooks",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: false,
    legacyFile: "repos/<repo>/hooks.json",
    description: "User-defined lifecycle hooks rt runs around commands (pre/post command scripts).",
  },
];

const BY_KEY: Map<string, SettingDef> = new Map(REGISTRY.map((def) => [def.key, def]));

/** Looks up a def by its flat namespaced key (e.g. "rt.roles"). */
export function getDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

/** Every registered def, in registry declaration order. */
export function allDefs(): SettingDef[] {
  return [...REGISTRY];
}

const PATH_LIKE = /^[/~]/;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Checks whether `value` is a legal value for `def`: the JSON-ish type
 * matches def.type, and (when def.pathGuardFields is set) no guarded field
 * anywhere in the value looks like an absolute path or home-relative path
 * literal — those are only legal in the machine store's own file contents,
 * never as a shared-scope value (spec: "No path type exists ... enforced for
 * wave-1 keys on the hook field specifically").
 */
export function validateValue(def: SettingDef, value: unknown): { ok: true } | { ok: false; reason: string } {
  const typeCheck = checkType(def.type, value);
  if (!typeCheck.ok) return typeCheck;

  if (def.pathGuardFields && def.pathGuardFields.length > 0) {
    const violation = findPathGuardViolation(value, def.pathGuardFields);
    if (violation) {
      return {
        ok: false,
        reason: `field "${violation.field}" looks like a path literal ("${violation.value}"); path literals are only legal in the machine store`,
      };
    }
  }

  return { ok: true };
}

function checkType(type: SettingDef["type"], value: unknown): { ok: true } | { ok: false; reason: string } {
  switch (type) {
    case "string":
      return typeof value === "string" ? { ok: true } : { ok: false, reason: `expected string, got ${typeOf(value)}` };
    case "number":
      return typeof value === "number" ? { ok: true } : { ok: false, reason: `expected number, got ${typeOf(value)}` };
    case "boolean":
      return typeof value === "boolean" ? { ok: true } : { ok: false, reason: `expected boolean, got ${typeOf(value)}` };
    case "array":
      return Array.isArray(value) ? { ok: true } : { ok: false, reason: `expected array, got ${typeOf(value)}` };
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? { ok: true }
        : { ok: false, reason: `expected object, got ${typeOf(value)}` };
  }
}

/**
 * Walks a value looking for any object field named in `guardFields` whose
 * string value looks like a path literal (leading `/` or `~`). Recurses
 * through plain objects and arrays; best-effort (spec: "enforced for wave-1
 * keys on the hook field specifically, best-effort elsewhere").
 */
function findPathGuardViolation(
  value: unknown,
  guardFields: string[],
): { field: string; value: string } | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findPathGuardViolation(item, guardFields);
      if (hit) return hit;
    }
    return null;
  }

  if (value !== null && typeof value === "object") {
    for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      if (guardFields.includes(field) && typeof fieldValue === "string" && PATH_LIKE.test(fieldValue)) {
        return { field, value: fieldValue };
      }
      const hit = findPathGuardViolation(fieldValue, guardFields);
      if (hit) return hit;
    }
  }

  return null;
}
