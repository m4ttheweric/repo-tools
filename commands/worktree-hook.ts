/**
 * rt worktree claude-hook (Claude Code WorktreeCreate/WorktreeRemove hook).
 * Protocol (probed 2026-09-01): stdin JSON; stdout = absolute tree path on
 * create; non-zero exit surfaces stderr verbatim in the Claude session.
 * The WorktreeRemove stdin shape is UNVERIFIED (never observed firing), so
 * the parser accepts worktree_path or path and treats absence as a noop.
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { daemonQuery } from "../lib/daemon-client.ts";
import { currentRepoIdentityFor } from "../lib/repo-arg.ts";
import { isRepoRegistered } from "../lib/repo-index.ts";
import { claudeWorktreeHookStatus, HOOK_TIMEOUT_SECONDS, installClaudeWorktreeHooks, uninstallClaudeWorktreeHooks } from "../lib/claude-settings.ts";
import { getSetting } from "../lib/settings/resolve.ts";
import { setSetting } from "../lib/settings/write.ts";
import { decideCreate, decideRemove, stockWorktreeAdd } from "../lib/worktree/claude-hook.ts";
import { loadWorktreeAppConfig } from "../lib/worktree/config.ts";
import { explainError } from "./worktree.ts";
import { findTreeByPath } from "../lib/worktree/registry.ts";

// One shared number with lib/claude-settings.ts's HOOK_TIMEOUT_SECONDS (the
// installed hook entries' Claude Code `timeout` field) so the two can never
// drift apart: the daemon call this constant bounds must never outlive the
// hook process Claude Code itself is willing to wait on.
const HOOK_PROVISION_TIMEOUT_MS = HOOK_TIMEOUT_SECONDS * 1000;

export function claudeSettingsPath(): string {
  return join(process.env.HOME ?? homedir(), ".claude", "settings.json");
}

// Same key/scope as lib/worktree/config.ts's app-level toggle (`enabled`,
// `killProcesses`)... a field-bag, not owned exclusively by either module, so
// every read/write here must merge rather than replace.
const WORKTREE_APP_SETTING_KEY = "rt.worktreeApp";

/** The pure offer gate: every field must clear for the offer to fire. */
export function shouldOfferClaudeHook(env: {
  isTTY: boolean;
  json: boolean;
  batch: boolean;
  settingsFileExists: boolean;
  hookInstalled: boolean;
  priorAnswer: string | undefined;
}): boolean {
  return (
    env.isTTY &&
    !env.json &&
    !env.batch &&
    env.settingsFileExists &&
    !env.hookInstalled &&
    env.priorAnswer === undefined
  );
}

function priorClaudeHookAnswer(): string | undefined {
  const value = getSetting<Record<string, unknown> | undefined>(WORKTREE_APP_SETTING_KEY).value;
  return typeof value?.claudeHook === "string" ? value.claudeHook : undefined;
}

/**
 * Merges into whatever machine-scope value already exists so sibling fields
 * (`enabled`, `killProcesses`) are never clobbered. Seeded from the
 * currently-EFFECTIVE config (`loadWorktreeAppConfig()`, which falls through
 * to the legacy file / the unowned-machine default per lib/worktree/config.ts's
 * header) so that a first-time-owns-the-key write pins the behavior that was
 * already true, rather than picking up the store branch's own
 * `enabled !== false` default (which disagrees with the unowned default).
 */
export function recordClaudeHookAnswer(answer: "installed" | "declined"): void {
  const effective = loadWorktreeAppConfig();
  const existing = getSetting<Record<string, unknown> | undefined>(WORKTREE_APP_SETTING_KEY).value ?? {};
  setSetting(WORKTREE_APP_SETTING_KEY, { ...effective, ...existing, claudeHook: answer }, "machine");
}

/**
 * One-time TTY offer to install the Claude Code worktree hook, called as the
 * last statement of the five worktree lifecycle verbs' success paths. Never
 * throws into its caller: an offer failure must never fail the lifecycle
 * verb that hosted it.
 */
export async function maybeOfferClaudeHook(json: boolean): Promise<void> {
  try {
    const settingsPath = claudeSettingsPath();
    const status = claudeWorktreeHookStatus(settingsPath);

    const offer = shouldOfferClaudeHook({
      isTTY: Boolean(process.stdin.isTTY),
      json,
      batch: Boolean(process.env.RT_BATCH),
      settingsFileExists: existsSync(settingsPath),
      hookInstalled: status.installed,
      priorAnswer: priorClaudeHookAnswer(),
    });
    if (!offer) return;

    const { confirm } = await import("../lib/rt-render.ts");
    const accepted = await confirm({
      message: "Install the Claude Code worktree hook? (rt provisions a worktree automatically when Claude creates one)",
      initialValue: true,
    });

    if (!accepted) {
      recordClaudeHookAnswer("declined");
      return;
    }

    const rtBin = Bun.which("rt");
    if (!rtBin) {
      console.warn("rt: skipping claude hook install offer... rt is not on PATH");
      return;
    }
    installClaudeWorktreeHooks(settingsPath, rtBin);
    recordClaudeHookAnswer("installed");
  } catch (err) {
    console.warn(`rt: claude hook install offer failed... ${String(err)}`);
  }
}

function emit(json: boolean, data: Record<string, unknown>, text: string): void {
  console.log(json ? JSON.stringify(data) : `\n  ${text}\n`);
}

function settingsFail(json: boolean, err: unknown): never {
  emit(json, { error: String(err) }, `✗ ${String(err)}`);
  process.exit(1);
}

export async function hookInstallCommand(
  args: string[],
  _ctx: unknown,
  deps: { which: (cmd: string) => string | null } = { which: (cmd) => Bun.which(cmd) },
): Promise<void> {
  const json = args.includes("--json");
  const rtBin = deps.which("rt");
  if (!rtBin) {
    emit(json, { error: "rt-not-on-path" }, "✗ rt is not on PATH; install rt first");
    process.exit(1);
  }
  try {
    const r = installClaudeWorktreeHooks(claudeSettingsPath(), rtBin);
    recordClaudeHookAnswer("installed");
    emit(json, { installed: true, changed: r.changed, rtBin }, r.changed ? `✓ hook installed (${rtBin})` : "✓ already installed");
  } catch (err) {
    settingsFail(json, err);
  }
}

export async function hookUninstallCommand(args: string[], _ctx: unknown): Promise<void> {
  const json = args.includes("--json");
  try {
    const r = uninstallClaudeWorktreeHooks(claudeSettingsPath());
    emit(json, { installed: false, changed: r.changed }, r.changed ? "✓ hook entries removed" : "nothing to remove");
  } catch (err) {
    settingsFail(json, err);
  }
}

export async function hookStatusCommand(args: string[], _ctx: unknown): Promise<void> {
  const json = args.includes("--json");
  try {
    const s = claudeWorktreeHookStatus(claudeSettingsPath());
    if (json) {
      console.log(JSON.stringify(s));
      return;
    }
    if (!s.installed) {
      console.log("\n  hook not installed (rt worktree hook install)\n");
      return;
    }
    console.log(`\n  installed: ${s.command}`);
    console.log(s.binaryExists
      ? "  binary: ok\n"
      : "  ✗ binary missing (EnterWorktree will fail everywhere); escape hatch: rt worktree hook uninstall\n");
  } catch (err) {
    settingsFail(json, err);
  }
}

type ParsedStdin =
  | { event: "create"; cwd: string; name: string }
  | { event: "remove"; path: string | null }
  | { event: "invalid" };

export function parseHookStdin(raw: string): ParsedStdin {
  try {
    const j = JSON.parse(raw);
    if (j.hook_event_name === "WorktreeCreate" && typeof j.cwd === "string" && typeof j.name === "string") {
      return { event: "create", cwd: j.cwd, name: j.name };
    }
    if (j.hook_event_name === "WorktreeRemove") {
      const p = typeof j.worktree_path === "string" ? j.worktree_path : typeof j.path === "string" ? j.path : null;
      return { event: "remove", path: p };
    }
  } catch { /* fall through to invalid */ }
  return { event: "invalid" };
}

/**
 * The `repoIdentity` dep `decideCreate` calls: read-only end to end. It
 * derives the identity without ever registering it, then answers "rt's
 * repo" only if that identity is already an index row. A repo that is
 * derivable but not indexed returns null, which `decideCreate` already
 * routes to the stock fallback. Deps are overridable purely so a unit test
 * can exercise the "not indexed" and "indexed" branches without a real git
 * repo or a live index.
 */
export function hookRepoIdentity(
  cwd: string,
  deps: { identityFor: (cwd: string) => string | undefined; isRegistered: (identity: string) => boolean } = {
    identityFor: currentRepoIdentityFor,
    isRegistered: isRepoRegistered,
  },
): string | null {
  const identity = deps.identityFor(cwd);
  return identity !== undefined && deps.isRegistered(identity) ? identity : null;
}

export async function claudeHookCommand(args: string[], _ctx: unknown): Promise<void> {
  const removeMode = args.includes("--remove");
  const parsed = parseHookStdin(await Bun.stdin.text());

  if (parsed.event === "invalid") {
    console.error("rt worktree claude-hook: unrecognized stdin payload");
    process.exit(removeMode ? 0 : 2);
  }

  if (parsed.event === "remove" || removeMode) {
    if (parsed.event !== "remove") process.exit(0);
    const decision = decideRemove(parsed.path, (p) => findTreeByPath(p));
    if (decision.kind === "dispose") {
      const res = await daemonQuery("worktree:dispose", { repoName: decision.repoName, tree: decision.tree, force: false, callerPid: process.pid });
      if (res && !res.ok) console.error(`rt: tree kept: ${explainError(res.error ?? "unknown error")}`);
    }
    process.exit(0);
  }

  const decision = await decideCreate(
    { cwd: parsed.cwd, name: parsed.name },
    {
      repoIdentity: hookRepoIdentity,
      provision: (repoName, intent) =>
        daemonQuery("worktree:provision", { repoName, owner: "claude", ...intent }, HOOK_PROVISION_TIMEOUT_MS),
      stockAdd: stockWorktreeAdd,
    },
  );

  if (decision.kind === "refused") {
    console.error(`rt worktree provision refused: ${explainError(decision.error)} (escape hatch: rt worktree hook uninstall)`);
    process.exit(2);
  }
  console.log(decision.path);
  process.exit(0);
}
