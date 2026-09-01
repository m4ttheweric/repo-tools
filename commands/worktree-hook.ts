/**
 * rt worktree claude-hook — Claude Code WorktreeCreate/WorktreeRemove hook.
 * Protocol (probed 2026-09-01): stdin JSON; stdout = absolute tree path on
 * create; non-zero exit surfaces stderr verbatim in the Claude session.
 * The WorktreeRemove stdin shape is UNVERIFIED (never observed firing), so
 * the parser accepts worktree_path or path and treats absence as a noop.
 */
import { daemonQuery } from "../lib/daemon-client.ts";
import { currentRepoIdentityFor } from "../lib/repo-arg.ts";
import { decideCreate, decideRemove, stockWorktreeAdd } from "../lib/worktree/claude-hook.ts";
import { explainError } from "./worktree.ts";
import { findTreeByPath } from "../lib/worktree/registry.ts";

const HOOK_PROVISION_TIMEOUT_MS = 240_000;

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
      repoIdentity: (cwd) => currentRepoIdentityFor(cwd) ?? null,
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
