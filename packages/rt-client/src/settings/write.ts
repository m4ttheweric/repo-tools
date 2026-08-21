/**
 * The settings write path (RT-47): `setSetting` — a single, comment-preserving
 * write into one of the three AUTHORED stores (user/team/machine; `legacy` and
 * `default` are read-only rungs and never appear here).
 *
 * Writes go through jsonc-parser's `modify`/`applyEdits` rather than
 * parse-mutate-stringify, so existing comments and formatting in the store
 * file survive a write to an unrelated key (verified: `modify` only rewrites
 * the minimal edit range needed for the touched path; everything else in the
 * document — including comments — is untouched text).
 *
 * JSONPath segments are literal object keys, not `.`-namespaced walks: a
 * global write targets `[key]` (e.g. `["rt.llm"]`) and a repoScoped write
 * targets `["repos", identity, key]`. A dotted key like `"rt.roles"` is one
 * path segment, not two — jsonc-parser never splits on `.` (verified with a
 * throwaway script against the installed 3.3.1). Missing parents (`"repos"`,
 * or the identity's section under it) are created by `modify` itself, and
 * that creation is comment-safe — no special-casing needed here.
 *
 * Creating an absent store file (user/machine only — see "Team selection"
 * below for why team stores are never auto-created): the file is seeded
 * in-memory as `// header comment\n{}\n` BEFORE the first `modify` call.
 * This is required, not cosmetic — a verified footgun: running `modify` on a
 * comment-only document with NO braces at all (e.g. just `// header\n`)
 * places the new object first and re-emits the header AFTER the closing
 * brace, which is backwards. Seeding an empty object ahead of time gives
 * `modify` real JSON structure to edit into, and the header comment stays
 * exactly where it was written, above the object.
 *
 * ── Refusals ────────────────────────────────────────────────────────────
 * In order: unregistered key, migrated:false (naming `def.legacyFile` and,
 * when present, `def.siblingCommand`), a scope the def does not list, a
 * repoIdentity supplied for a key that is not `repoScoped`, a value that
 * fails `registry.validateValue` (type check + the path-literal guard), and
 * finally — only for `scope: "team"` — a team store that cannot be resolved
 * (see below). Filesystem-touching checks (team resolution) run last, after
 * every pure/in-memory refusal, so a bad call never creates or touches a
 * file it was going to refuse anyway.
 *
 * ── The path-literal guard is scope-aware ──────────────────────────────
 * Mirrors `resolve.ts`'s `validateForScope`: `def.pathGuardFields` (wave 1:
 * `rt.roles.hook`) is enforced at `user` and `team` scope, where a path
 * literal would silently stop applying the moment a teammate's checkout (or
 * this developer's own machine) sits at a different path. `machine` scope is
 * exempt — it is the one store where a path literal is the CORRECT way to
 * express something local-only, so writes there skip the guard entirely
 * (implemented by stripping `pathGuardFields` before calling
 * `validateValue`, same trick `resolve.ts` uses on the read side).
 *
 * ── Team selection (a design decision this task made, per the brief) ──
 * The base signature (`setSetting(key, value, scope, opts?)`) is extended
 * here with `opts.team`, an explicit team NAME to target. Selection rule for
 * `scope: "team"`:
 *   - `opts.team` given → that team's store; refuse if it has no local
 *     settings file (a team dir can exist mid-clone without one — see
 *     `stores.ts#listTeams`).
 *   - `opts.team` omitted, exactly one team has a local store → use it.
 *   - `opts.team` omitted, zero or multiple teams have a local store →
 *     refuse with a clear error (asking for `opts.team` in the multiple
 *     case). Wave 1 ships exactly one team, so this is the common path; the
 *     alternative of silently picking "the first team alphabetically" was
 *     considered and rejected — guessing which team's shared file to mutate
 *     is exactly the silent-oracle behavior this design bans elsewhere.
 * A team store is NEVER auto-created by `setSetting` — team stores are
 * seeded by the migration/orchestrator step and live in a repo that needs a
 * commit+push to reach teammates; conjuring one here would produce an
 * uncommitted, unshared file masquerading as team state.
 *
 * Every successful `scope: "team"` write prints one reminder line to
 * stderr: the edit only exists in this local clone until it is committed
 * and pushed. No such reminder for `user`/`machine` (nothing to push there
 * in wave 1).
 *
 * ── Malformed stores refuse rather than edit around the damage ─────────
 * An existing store's on-disk text is parsed and checked (`assertEditableJsonc`)
 * before `modify` ever runs: real parse errors, a non-object root, or a
 * duplicate key anywhere in the tree all refuse with one message naming the
 * file. The duplicate-key case is the sharp one — it is not a parse error at
 * all (JSON's grammar permits it), but `modify` edits the FIRST occurrence by
 * offset while every reader takes the LAST, so a naive edit-in-place would
 * report success while the effective value never changes, and the file would
 * still degrade to empty on the next `readStore`. Refusing is the only
 * option that doesn't either lie about success or write a still-broken file.
 *
 * ── Writes are write-temp-then-rename ───────────────────────────────────
 * Mirrors `lib/json-store.ts`'s `writeJson`: the edited text is written to a
 * `<path>.<pid>.<random>.tmp` file in the SAME directory, then renamed onto
 * the real path — stores never tear, matching the rest of rt's persistence
 * (the machine store especially has no git fallback to recover a partial
 * write from). The tmp file carries the edited TEXT exactly as `applyEdits`
 * produced it, never round-tripped through `JSON.stringify` — that's what
 * keeps comments alive.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { applyEdits, modify, parseTree, type JSONPath, type Node, type ParseError } from "jsonc-parser";
import { randomBytes } from "crypto";
import { dirname } from "path";
import { machineSettingsPath, teamSettingsPath, userSettingsPath } from "./paths.ts";
import { getDef, isMigrated, validateValue, type SettingDef, type SettingScope } from "./registry-machinery.ts";
import { listTeams } from "./stores.ts";

export interface SetSettingOpts {
  /** Normalized repo identity — required to target a repoScoped key's `repos.<identity>` section. */
  repoIdentity?: string;
  /**
   * Which team's local store to write into, for `scope: "team"`. See the
   * module doc's "Team selection" section. Ignored for `user`/`machine`.
   */
  team?: string;
}

const FORMAT = { tabSize: 2, insertSpaces: true, eol: "\n" };

function refuse(message: string): never {
  throw new Error(`rt: ${message}`);
}

/**
 * Writes `value` for `key` into the given scope's store, preserving every
 * existing comment and creating the file/section it needs. See the module
 * doc for the full refusal list and the team-selection rule.
 */
export function setSetting(key: string, value: unknown, scope: SettingScope, opts: SetSettingOpts = {}): void {
  const def = getDef(key);
  if (!def) {
    refuse(`unknown setting "${key}" — not in the settings registry (see \`rt settings list\`)`);
  }

  if (!isMigrated(def)) {
    refuse(migratedFalseMessage(key, def));
  }

  if (!def.scopes.includes(scope)) {
    refuse(`"${key}" cannot be set in the ${scope} store (allowed: ${def.scopes.join(", ")})`);
  }

  if (opts.repoIdentity !== undefined && def.repoScoped !== true) {
    refuse(`"${key}" is not repo-scoped — omit the repo identity`);
  }

  // machine scope is exempt from the path-literal guard (see module doc).
  const guardedDef: SettingDef = scope === "machine" ? { ...def, pathGuardFields: undefined } : def;
  const check = validateValue(guardedDef, value);
  if (!check.ok) {
    refuse(`refusing to set "${key}": ${check.reason} — use \${team:<name>} or \${repoRoot} instead`);
  }

  const storePath = resolveStorePath(scope, opts);
  const jsonPath: JSONPath = opts.repoIdentity !== undefined ? ["repos", opts.repoIdentity, key] : [key];

  writeIntoStore(storePath, jsonPath, value, /* createIfMissing */ scope !== "team");

  if (scope === "team") {
    console.error(
      `rt: wrote "${key}" to the local team store (${storePath}) — this is local only until you commit and push it.`,
    );
  }
}

function migratedFalseMessage(key: string, def: SettingDef): string {
  const legacyPart = def.legacyFile ? ` — it is still read from ${def.legacyFile}` : "";
  const siblingPart = def.siblingCommand ? `; use \`${def.siblingCommand}\` instead` : "";
  return `"${key}" is not writable through the settings resolver yet${legacyPart}${siblingPart}`;
}

/** Resolves which store file a write targets, applying the team-selection rule for `scope: "team"`. */
function resolveStorePath(scope: SettingScope, opts: SetSettingOpts): string {
  if (scope === "user") return userSettingsPath();
  if (scope === "machine") return machineSettingsPath();

  if (opts.team !== undefined) {
    const path = teamSettingsPath(opts.team);
    if (!existsSync(path)) {
      refuse(`team store for "${opts.team}" does not exist (${path}) — clone/seed it before writing to it`);
    }
    return path;
  }

  const teams = listTeams();
  if (teams.length === 0) {
    refuse(`no local team store found — clone a team under ~/.mattstack/teams/<name> or pass opts.team`);
  }
  if (teams.length > 1) {
    refuse(`multiple local team stores found (${teams.join(", ")}) — pass opts.team to choose one`);
  }
  return teamSettingsPath(teams[0] as string);
}

/** `// header comment\n{}\n` — see module doc for why the object must be seeded before the first `modify`. */
function seedHeader(): string {
  return `// rt settings — created by \`rt settings set\`. JSONC: comments and trailing commas are fine.\n{}\n`;
}

/**
 * Refuses to edit a store whose on-disk text is not a single well-formed
 * JSONC object. Two failure classes:
 *  - genuine parse errors (unbalanced braces, trailing garbage, etc.) —
 *    caught by jsonc-parser's own error collection, the same check
 *    `stores.ts#readStore` runs on the read side;
 *  - a document that PARSES but is unsafe to `modify`: a non-object root, or
 *    a duplicate key anywhere in the tree. `modify` edits the FIRST
 *    occurrence of a duplicate key by offset, while every reader (`parse`,
 *    `JSON.parse`) takes the LAST — so a naive edit-in-place would report
 *    success while the effective value never changes (verified with a
 *    throwaway script: `modify` touched offset 14 in `{"rt.llm":1,"rt.llm":2}`,
 *    but re-parsing the "fixed" text still returned `2`). Both classes refuse
 *    rather than silently editing around the damage — the alternative is a
 *    write that reports success but does nothing, or one that writes a still-
 *    broken file that the NEXT read honest-degrades to an empty store.
 */
function assertEditableJsonc(file: string, content: string): void {
  const errors: ParseError[] = [];
  const tree = parseTree(content, errors, { allowTrailingComma: true });

  const malformed =
    errors.length > 0 || tree === undefined || tree.type !== "object" || findDuplicateKey(tree) !== undefined;

  if (malformed) {
    refuse(`fix the JSONC syntax error in ${file} first — refusing to edit a malformed store`);
  }
}

/** Depth-first search for the first duplicate property name in any object in the tree. */
function findDuplicateKey(node: Node): string | undefined {
  if (node.type === "object" && node.children) {
    const seen = new Set<string>();
    for (const property of node.children) {
      const keyNode = property.children?.[0];
      if (keyNode !== undefined && typeof keyNode.value === "string") {
        if (seen.has(keyNode.value)) return keyNode.value;
        seen.add(keyNode.value);
      }
      const valueNode = property.children?.[1];
      if (valueNode !== undefined) {
        const nested = findDuplicateKey(valueNode);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  }
  if (node.type === "array" && node.children) {
    for (const child of node.children) {
      const nested = findDuplicateKey(child);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function writeIntoStore(storePath: string, jsonPath: JSONPath, value: unknown, createIfMissing: boolean): void {
  let content: string;
  if (existsSync(storePath)) {
    content = readFileSync(storePath, "utf8");
    if (content.trim() === "") {
      content = seedHeader();
    } else {
      assertEditableJsonc(storePath, content);
    }
  } else {
    if (!createIfMissing) {
      // Unreachable via setSetting today: resolveStorePath already refuses
      // every "team" path that lacks a file before we get here. Kept as a
      // defensive guard against a future caller of writeIntoStore directly.
      refuse(`store file ${storePath} does not exist`);
    }
    mkdirSync(dirname(storePath), { recursive: true });
    content = seedHeader();
  }

  const edits = modify(content, jsonPath, value, { formattingOptions: FORMAT });
  const next = applyEdits(content, edits);
  const finalText = next.endsWith("\n") ? next : `${next}\n`;

  // Write-temp-then-rename in the same directory, mirroring
  // lib/json-store.ts's writeJson — stores never tear, and the machine store
  // especially has no git fallback to recover a partial write from. The
  // edited TEXT is written as-is, never round-tripped through
  // JSON.stringify, so comments and formatting survive.
  const tmp = `${storePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, finalText);
    renameSync(tmp, storePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp file never got created, or was already cleaned up — nothing to do
    }
    throw err;
  }
}
