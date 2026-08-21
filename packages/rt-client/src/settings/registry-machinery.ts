/**
 * The settings schema registry machinery (RT-47/RT-50): lookup and
 * validation over a static table describing every known settings key.
 *
 * This module is pure data plumbing — no file IO, no daemon dependency, safe
 * to import anywhere (including the daemon thread). The def TABLE itself
 * lives in registry-defs.ts (rt's rows today; a later task adds the rest of
 * the suite); this file only knows how to look a def up and check a value
 * against it.
 *
 * `migrated: true` means the reader for this key goes through the resolver.
 * `migrated: false` keys still appear in `rt settings list` (so the full
 * settings map is visible even before a key's reader has been ported), but
 * `set` on them refuses — see the spec's "Schema registry" section for why
 * writing a value nothing reads is the dishonesty class this design bans.
 *
 * `migrated` is omitted entirely (not `undefined` written out) for suite keys
 * outside rt's wave-1 legacy-file migration — deck/board/gitq/mattstack/claude
 * defs have no legacy file to migrate FROM, so the flag is meaningless for
 * them. `isMigrated()` is the one place that turns absence into "yes,
 * resolver-backed" — every other module must call it rather than testing
 * `def.migrated` directly, or a suite key's absent flag reads as `false` and
 * `set` refuses it.
 */

import { REGISTRY } from "./registry-defs.ts";

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
  migrated?: boolean;
  legacyFile?: string;
  pathGuardFields?: string[];
  description: string;
}

const BY_KEY: Map<string, SettingDef> = new Map(REGISTRY.map((def) => [def.key, def]));

/** Looks up a def by its flat namespaced key (e.g. "rt.roles"). */
export function getDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

/** Every registered def, in registry declaration order. */
export function allDefs(): SettingDef[] {
  return [...REGISTRY];
}

/** True unless `def.migrated` is explicitly `false` — see the module doc. */
export function isMigrated(def: SettingDef): boolean {
  return def.migrated !== false;
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
