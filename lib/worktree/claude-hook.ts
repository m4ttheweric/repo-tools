/**
 * Decision core for the Claude Code WorktreeCreate hook. The hook must be
 * TOTAL: Claude Code has no fallthrough (empty stdout fails the creation),
 * so every input either yields a path or a deliberate refusal.
 * daemonQuery null = unreachable (fallback); an answered refusal is loud,
 * EXCEPT repo-unknown, which means "not rt's repo" (fallback).
 */
import { join } from "path";
import type { DaemonResponse } from "../daemon-client.ts";

export interface CreateHookInput { cwd: string; name: string }
export type CreateDecision =
  | { kind: "provisioned"; path: string }
  | { kind: "fallback"; path: string }
  | { kind: "refused"; error: string };
export interface CreateHookDeps {
  repoIdentity: (cwd: string) => string | null;
  provision: (repoName: string, intent: { ticket?: string; ticketTitle?: string; branch?: string }) => Promise<DaemonResponse | null>;
  stockAdd: (cwd: string, name: string) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
}

const TICKET_RE = /^([A-Za-z]+-\d+)(?:-(.+))?$/;

export function nameIntent(name: string): { ticket: string; ticketTitle?: string } | { branch: string } {
  const m = TICKET_RE.exec(name);
  const ticket = m?.[1];
  if (!ticket) return { branch: name };
  const title = m[2];
  return title ? { ticket, ticketTitle: title } : { ticket };
}

export async function decideCreate(input: CreateHookInput, deps: CreateHookDeps): Promise<CreateDecision> {
  const fallback = async (): Promise<CreateDecision> => {
    const added = await deps.stockAdd(input.cwd, input.name);
    return added.ok ? { kind: "fallback", path: added.path } : { kind: "refused", error: added.error };
  };

  const repoName = deps.repoIdentity(input.cwd);
  if (!repoName) return fallback();

  const res = await deps.provision(repoName, nameIntent(input.name));
  if (res === null) return fallback();
  if (!res.ok) return res.error === "repo-unknown" ? fallback() : { kind: "refused", error: res.error ?? "unknown error" };
  return { kind: "provisioned", path: res.data.path };
}

export async function stockWorktreeAdd(cwd: string, name: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd });
  if (top.exitCode !== 0) return { ok: false, error: "not a git repository" };
  const root = top.stdout.toString().trim();
  const path = join(root, ".claude", "worktrees", name);
  const add = Bun.spawnSync(["git", "worktree", "add", "-b", name, path], { cwd: root });
  if (add.exitCode !== 0) return { ok: false, error: add.stderr.toString().trim().split("\n").pop() ?? "git worktree add failed" };
  return { ok: true, path };
}

export type RemoveDecision = { kind: "dispose"; repoName: string; tree: string } | { kind: "noop" };

export function decideRemove(
  worktreePath: string | null,
  registryLookup: (path: string) => { repoName: string; tree: string } | null,
): RemoveDecision {
  if (!worktreePath) return { kind: "noop" };
  const hit = registryLookup(worktreePath);
  return hit ? { kind: "dispose", repoName: hit.repoName, tree: hit.tree } : { kind: "noop" };
}
