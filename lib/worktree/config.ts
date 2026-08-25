/**
 * Worktree config: the per-repo pool declaration (`rt.worktrees`, resolved
 * through the settings resolver since RT-47) plus the app-level on/off file.
 *
 * ── Where the per-repo values come from ───────────────────────────────────
 * `loadWorktreeRepoConfig` goes through `lib/settings/resolve.ts#getSetting`,
 * which layers the authored stores:
 *
 *   default < team < user < team.repo < user.repo < machine < machine.repo
 *
 * `rt.worktrees` is a **deep-merge** key (registry: `merge: "deep"`): the team
 * store can own `onDeck`/`ready`, the user store can add a personal
 * `namePool` — all at once. Arrays inside the key still replace atomically, so
 * one `ready` ladder or one `namePool` wins outright rather than being
 * spliced.
 *
 * The store rungs are keyed by repo IDENTITY (a normalized remote), so this
 * reader derives one from the repo path — which is why it is ASYNC (the
 * derivation is a `git config` spawn, never a sync one; it is memoized per
 * path). A repo with no derivable identity (local-path remote, not a git repo
 * yet) simply makes the `*.repo` rungs unreachable; global keys still answer.
 * Honest degrade, not an error.
 *
 * ── Computed defaults and sanitizers stay HERE ────────────────────────────
 * The registry only carries `{ onDeck: 0 }`; `root` (= `<repoPath>/.worktrees`)
 * and `branchFormat` cannot live there because they depend on the repo being
 * read. And the resolver only type-checks the TOP level of a value (an
 * object), so the sanitizers below are what actually guarantee the
 * `WorktreeRepoConfig` shape, from whichever rung a field arrived on. That
 * includes the namePool dot-filter, which now guards team- and user-authored
 * pools too.
 *
 * `expandHome` also stays: the resolver's closed variable set is
 * `${repoRoot}/${worktree}/${home}/${team:<name>}` and a bare `~` is not in it,
 * so a machine-store `"root": "~/wt"` would otherwise reach the filesystem
 * verbatim. Shared scopes should use `${repoRoot}`-style variables (spec); the
 * machine store is allowed literals, and this is what makes them work.
 *
 * ── This reader never throws ──────────────────────────────────────────────
 * Its callers are the daemon reconciler's per-pass duties and the provision
 * handler: both must answer rather than blow up. `getSetting` throws for
 * exactly one input — an unsatisfiable closed-set variable — so that degrades
 * to "nothing declared" with one warning rather than taking a reconcile pass
 * (or every repo behind it) down.
 *
 * ── The app-level file is an ownership-latch port (wave 2) ────────────────
 * `~/.mattstack/rt/worktrees.json` — registry key `rt.worktreeApp` (a
 * DIFFERENT key from `rt.worktrees` above: same file family, unrelated shape
 * and scope — `rt.worktrees` is per-repo and repoScoped, this one is a single
 * machine-wide toggle). `getSetting("rt.worktreeApp").value === undefined`
 * means the store does not own the key yet: the file stays authoritative,
 * INCLUDING the one-time seed from the legacy `~/.mattstack/rt/parking-lot.json`
 * when the new file is absent and the old one exists. Once the store owns the
 * key it wins PER-FIELD (`rt.worktreeApp` is a field-bag object, not a map) —
 * a store value carrying only `killProcesses` still gets `enabled`'s default.
 * Both fields default to true either way, matching the legacy
 * `raw?.enabled !== false` semantics. A probe failure (thrown by getSetting)
 * counts as unowned plus one warning that never echoes the store's value.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readJson, writeJson } from "../json-store.ts";
import { rtDir } from "../rt-paths.ts";
import { deriveRepoIdentity } from "../settings/identity.ts";
import { explainSetting, getSetting, type ResolveOpts } from "../settings/resolve.ts";

/**
 * Expand a leading `~` against call-time HOME (matching rt-paths convention:
 * `process.env.HOME ?? homedir()`, resolved at call time so tests can repoint
 * the whole tree by setting process.env.HOME before calling). Only a leading
 * `~` or `~/...` is special; `~foo` and mid-string `~` are left alone.
 */
function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? homedir();
  if (path.startsWith("~/")) return join(process.env.HOME ?? homedir(), path.slice(2));
  return path;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReadyStep {
  run: string;
  when?: string;
}

export interface WorktreeRepoConfig {
  onDeck: number; // default 0
  namePool?: string[];
  root: string; // default join(repoPath, ".worktrees")
  branchFormat: string; // default "<ticket>-<slug>"
  ready: ReadyStep[]; // declared domain steps ONLY (implicit install prepended at resolve time)
}

export interface WorktreeAppConfig {
  enabled: boolean;
  killProcesses: boolean;
}

// ─── Repo overlay ────────────────────────────────────────────────────────────

const SETTING_KEY = "rt.worktrees";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The resolve options every rung of this key is read with. `expand` is left at
 * its default (true) so a shared-scope `"root": "${repoRoot}/trees"` works;
 * `${worktree}` is NOT satisfiable here (this reader has no invocation
 * context), so a value using it degrades — see the module header.
 */
function resolveOpts(repoIdentity: string | null, repoPath: string): ResolveOpts {
  return {
    repoIdentity,
    expandCtx: { repoRoot: repoPath },
  };
}

/**
 * The resolved `rt.worktrees` object, or `{}` when nothing resolves. Never
 * throws (module header): an unexpandable closed-set variable warns and
 * degrades this key rather than propagating into a reconcile pass.
 */
function resolveDeclared(
  repoName: string,
  repoIdentity: string | null,
  repoPath: string,
): Record<string, unknown> {
  try {
    const { value } = getSetting<unknown>(SETTING_KEY, resolveOpts(repoIdentity, repoPath));
    return isPlainObject(value) ? value : {};
  } catch (err) {
    console.warn(`rt: ignoring "${SETTING_KEY}" for repo "${repoName}" — ${(err as Error).message}`);
    return {};
  }
}

// ─── Sanitizers ──────────────────────────────────────────────────────────────
// The resolver type-checks only the top level of the key, so these are what
// guarantee WorktreeRepoConfig's shape.

/** Pool size. Anything that isn't a non-negative integer means "no pool". */
function sanitizeOnDeck(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Worktree root, with the reader's computed default. `expandHome` is applied
 * after the resolver's own variable expansion — see the module header for why
 * a bare `~` still has to work.
 */
function sanitizeRoot(raw: unknown, repoPath: string): string {
  return typeof raw === "string" && raw.length > 0 ? expandHome(raw) : join(repoPath, ".worktrees");
}

function sanitizeBranchFormat(raw: unknown): string {
  return typeof raw === "string" && raw.length > 0 ? raw : "<ticket>-<slug>";
}

/** Declared domain steps; an entry without a string `run` is not a step. */
function sanitizeReady(raw: unknown): ReadyStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (step): step is ReadyStep => isPlainObject(step) && typeof step.run === "string",
  );
}

/**
 * Returns undefined when no pool was declared at all (an absent pool and an
 * empty one mean different things to `pickName`).
 *
 * A dot-leading name would build a tree the reconciler's reap duty then deletes
 * as a `.trash-*` leftover, so the pool never gets to declare one — and since
 * RT-47 that guard covers team- and user-authored pools too, not just the
 * legacy file.
 */
function sanitizeNamePool(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((name): name is string => typeof name === "string" && !name.startsWith("."));
}

/**
 * The repo's worktree pool declaration, resolved across the whole settings
 * ladder (module header). ASYNC because the store rungs are keyed by repo
 * identity and deriving one from a path is a git spawn.
 */
export async function loadWorktreeRepoConfig(
  repoName: string,
  repoPath: string,
): Promise<WorktreeRepoConfig> {
  const derived = await deriveRepoIdentity(repoPath);
  const identity = derived.kind === "remote" ? derived.id : null;
  const declared = resolveDeclared(repoName, identity, repoPath);

  const cfg: WorktreeRepoConfig = {
    onDeck: sanitizeOnDeck(declared.onDeck),
    root: sanitizeRoot(declared.root, repoPath),
    branchFormat: sanitizeBranchFormat(declared.branchFormat),
    ready: sanitizeReady(declared.ready),
  };
  const namePool = sanitizeNamePool(declared.namePool);
  if (namePool) cfg.namePool = namePool;
  return cfg;
}

/**
 * Whether anyone has actually DECLARED worktree settings for this repo — the
 * opt-in signal the daemon reconciler gates its per-repo pass on.
 *
 * "Declared" means: some rung stronger than `default` has a value present for
 * `rt.worktrees`. The registry default (`{ onDeck: 0 }`) exists for every repo
 * on the machine, so counting it would opt every registered repo into worktree
 * reconciliation.
 *
 * This asks `explainSetting` for rung PRESENCE rather than reading `getSetting`
 * provenance, and the difference is load-bearing: provenance names the scopes
 * that still own a surviving leaf, so an authored-but-empty block (`"worktrees":
 * {}` — the established opt-in idiom, used in the reconciler's own tests)
 * contributes no leaf and would vanish from provenance entirely. Presence keeps
 * this function's answer identical to the pre-RT-47 `raw.worktrees !== undefined`
 * test on the legacy file, while also seeing a repo whose declaration lives
 * only in a store. An invalid value counts too, for the same reason it did
 * before: somebody meant to declare something.
 */
export async function worktreeSettingsDeclared(repoName: string, repoPath: string): Promise<boolean> {
  const derived = await deriveRepoIdentity(repoPath);
  const identity = derived.kind === "remote" ? derived.id : null;
  try {
    return explainSetting(SETTING_KEY, resolveOpts(identity, repoPath)).some(
      (row) => row.present && row.scope !== "default",
    );
  } catch (err) {
    console.warn(`rt: ignoring "${SETTING_KEY}" for repo "${repoName}" — ${(err as Error).message}`);
    return false;
  }
}

// ─── Implicit install ladder ─────────────────────────────────────────────────

type Manager = "pnpm" | "bun" | "yarn" | "npm";

/**
 * pnpm's default is deliberately a PLAIN install, not `--side-effects-cache`:
 * that cache replays a dependency's recorded postinstall effects instead of
 * re-running it, and it only ever captured files written inside node_modules.
 * A dep whose postinstall writes outside the package dir (prisma generating
 * into apps/backend/generated/, say) is therefore silently skipped on a fresh
 * tree — the install "succeeds" and the tree is missing generated code. The
 * flag stays available as a declared ready step for repos verified free of
 * out-of-tree generators; it is not safe as a blind default.
 */
const MANAGER_STEP: Record<Manager, ReadyStep> = {
  pnpm: { run: "pnpm install", when: "changed:pnpm-lock.yaml" },
  bun: { run: "bun install", when: "changed:bun.lock*" },
  yarn: { run: "yarn install", when: "changed:yarn.lock" },
  npm: { run: "npm install", when: "changed:package-lock.json" },
};

function detectManager(repoPath: string): Manager | null {
  const packageJsonPath = join(repoPath, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager : undefined;
    if (declared) {
      const prefix = declared.split("@")[0];
      if (prefix === "pnpm" || prefix === "bun" || prefix === "yarn" || prefix === "npm") {
        return prefix;
      }
    }
  } catch {
    // malformed package.json falls through to lockfile sniffing
  }

  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) return "bun";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "package-lock.json"))) return "npm";
  return "npm";
}

/**
 * ladder (spec §5): no package.json → null; packageManager field prefix
 * pnpm|bun|yarn|npm → step; else lockfile sniff pnpm-lock.yaml→pnpm,
 * bun.lock|bun.lockb→bun, yarn.lock→yarn, package-lock.json→npm; else npm.
 */
export function resolveImplicitInstall(repoPath: string): ReadyStep | null {
  const manager = detectManager(repoPath);
  return manager ? MANAGER_STEP[manager] : null;
}

/** One leading `VAR=value` assignment (value optionally quoted). */
const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
const ENV_WORD = /^env\s+/;
const OPTION_TOKEN = /^(-\S*)\s+/;
/** env(1) short options whose argument is the NEXT token (`-u NAME` etc.). */
const ENV_ARG_OPTIONS = new Set(["-u", "-C", "-P", "-S"]);

/**
 * Drop a shell env prefix from a declared run, leaving the command word first:
 * `SKIP_GEN_TYPES=1 pnpm install` → `pnpm install`, `env -i FOO=bar pnpm
 * install` → `pnpm install`. Purely for recognising WHICH command a step runs
 * (the install-dedup test below); the step itself is always executed verbatim,
 * env prefix included. Option words are only consumed after an `env`, so a
 * command's own flags are never eaten. Every token match requires trailing
 * whitespace, so a run that is nothing but a prefix (`A=1`, `env`) is left
 * alone rather than emptied.
 */
export function stripEnvPrefix(run: string): string {
  let rest = run.trimStart();
  let inEnv = false;
  for (;;) {
    if (ASSIGNMENT_TOKEN.test(rest)) {
      rest = rest.replace(ASSIGNMENT_TOKEN, "");
      continue;
    }
    if (ENV_WORD.test(rest)) {
      rest = rest.replace(ENV_WORD, "");
      inEnv = true;
      continue;
    }
    const option = inEnv ? rest.match(OPTION_TOKEN) : null;
    if (option) {
      rest = rest.slice(option[0].length);
      if (ENV_ARG_OPTIONS.has(option[1] ?? "")) rest = rest.replace(/^\S+\s+/, "");
      continue;
    }
    return rest;
  }
}

/**
 * Implicit install first UNLESS cfg.ready already declares its own install
 * step for the detected manager (run starts with "<manager> install", e.g.
 * "pnpm install --side-effects-cache") — only an install step replaces the
 * implicit one; any other declared command for that manager (e.g. "pnpm
 * lint") does not suppress it. Otherwise cfg.ready in order.
 *
 * The prefix test runs against the env-stripped run: declaring
 * `SKIP_GEN_TYPES=1 pnpm install` is still declaring the install, and letting
 * an env prefix hide it from the dedup made the tree install twice.
 */
export function resolveReadySteps(cfg: WorktreeRepoConfig, repoPath: string): ReadyStep[] {
  const manager = detectManager(repoPath);
  if (!manager) return cfg.ready;

  const installWords = `${manager} install`;
  const alreadyDeclared = cfg.ready.some((step) => {
    const command = stripEnvPrefix(step.run);
    // Whole-token match: `pnpm install --flag` counts, `pnpm installer` does not.
    return command === installWords || command.startsWith(`${installWords} `);
  });
  if (alreadyDeclared) return cfg.ready;

  return [MANAGER_STEP[manager], ...cfg.ready];
}

// ─── App-level config ────────────────────────────────────────────────────────

const APP_CONFIG_DEFAULTS: WorktreeAppConfig = { enabled: true, killProcesses: true };
const APP_SETTING_KEY = "rt.worktreeApp";

/**
 * The ownership-latch probe: `undefined` means `rt.worktreeApp` is unowned
 * (no store rung has a value) and the legacy file stays authoritative. A
 * probe failure degrades to unowned too, with one warning that names the key
 * but never the value.
 */
function probeAppConfigStore(): { enabled?: boolean; killProcesses?: boolean } | undefined {
  try {
    return getSetting<{ enabled?: boolean; killProcesses?: boolean }>(APP_SETTING_KEY).value;
  } catch (err) {
    console.warn(`rt: ignoring "${APP_SETTING_KEY}" — ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * ~/.mattstack/rt/worktrees.json; if absent AND ~/.mattstack/rt/parking-lot.json exists, seed from
 * it once (write the new file), then read the new file. Defaults
 * { enabled: true, killProcesses: true }.
 */
function loadFromLegacyFile(): WorktreeAppConfig {
  const path = join(rtDir(), "worktrees.json");
  const legacyPath = join(rtDir(), "parking-lot.json");

  if (!existsSync(path) && existsSync(legacyPath)) {
    const legacy = readJson<{ enabled?: boolean; killProcesses?: boolean }>(legacyPath, {});
    const seeded: WorktreeAppConfig = {
      enabled: legacy.enabled !== false,
      killProcesses: legacy.killProcesses !== false,
    };
    writeJson(path, seeded);
  }

  return readJson<WorktreeAppConfig>(path, APP_CONFIG_DEFAULTS);
}

/**
 * `rt.worktreeApp`, ownership-latch semantics (module header): store-owned
 * wins per field over the legacy file, which stays authoritative — seed
 * included — until the store carries a value.
 */
export function loadWorktreeAppConfig(): WorktreeAppConfig {
  const declared = probeAppConfigStore();
  if (declared !== undefined) {
    return {
      enabled: declared.enabled !== false,
      killProcesses: declared.killProcesses !== false,
    };
  }
  return loadFromLegacyFile();
}
