/**
 * Stack guard for `rt sync`: decides, before any ref moves, whether the
 * current branch belongs to a stack and must not be rebased onto the default
 * branch on its own. Sources, in order: gitq's stack store (the branch is a
 * node), then the forge (its open MR targets a non-default branch, or an
 * open MR targets it).
 */

import type { Probes } from "./setup/probes.ts";
import { forgeFromRemote } from "./setup/team-settings.ts";
import { forgeArgv, glabEnv } from "./team/forge.ts";
import { bundledToolExec } from "./deps/resolve.ts";

export interface StackMembership {
  name: string;
  root: string;
  parent: string;
  children: string[];
}

export interface ForgeMr {
  iid: number;
  source: string;
  target: string;
  url: string;
}

export interface StackRefusal {
  kind: "stack-refusal" | "stack-check-unavailable";
  branch: string;
  source: "gitq" | "forge";
  stack: StackMembership | null;
  mrs: ForgeMr[] | null;
  tool: string;
  hint: string;
}

/** Distinct from 3, which is the paused-conflict bundle the same --json mode emits. */
export const STACK_REFUSAL_EXIT = 4;

export function renderStackRefusal(refusal: StackRefusal, mode: "json" | "human"): string {
  if (mode === "json") return JSON.stringify(refusal, null, 2);
  return refusal.tool ? `${refusal.hint} (${refusal.tool})` : refusal.hint;
}

export type StackVerdict =
  | { verdict: "clear" }
  | { verdict: "refuse"; refusal: StackRefusal }
  | { verdict: "unverified"; refusal: StackRefusal };

export interface StackGuardRunners {
  /** stdout of `gitq stacks --json` for cwd, or null when gitq cannot answer here. */
  gitqStacks(cwd: string): Promise<string | null>;
  forgeOpenMrs(cwd: string): Promise<{ ok: true; mrs: ForgeMr[] } | { ok: false; error: string }>;
}

interface GitqStackJson {
  stackName: string;
  root: string;
  nodes: { branch: string; parent: string }[];
}

function parseGitqStacks(stdout: string): GitqStackJson[] {
  try {
    const parsed = JSON.parse(stdout) as { stacks?: GitqStackJson[] };
    return Array.isArray(parsed.stacks) ? parsed.stacks : [];
  } catch {
    return [];
  }
}

function gitqMembership(stacks: GitqStackJson[], branch: string): StackMembership | null {
  for (const stack of stacks) {
    const node = stack.nodes.find((n) => n.branch === branch);
    if (!node) continue;
    return {
      name: stack.stackName,
      root: stack.root,
      parent: node.parent,
      children: stack.nodes.filter((n) => n.parent === branch).map((n) => n.branch),
    };
  }
  return null;
}

export async function checkStackMembership(opts: {
  cwd: string;
  branch: string;
  defaultBranch: string;
  runners: StackGuardRunners;
}): Promise<StackVerdict> {
  const gitqOut = await opts.runners.gitqStacks(opts.cwd);
  const membership = gitqOut === null ? null : gitqMembership(parseGitqStacks(gitqOut), opts.branch);
  if (membership) {
    const tool = `gitq sync --stack ${membership.name}`;
    return {
      verdict: "refuse",
      refusal: {
        kind: "stack-refusal",
        branch: opts.branch,
        source: "gitq",
        stack: membership,
        mrs: null,
        tool,
        hint: `${opts.branch} is a member of stack ${membership.name} (parent ${membership.parent}); rebasing it alone onto ${opts.defaultBranch} would break the stack. Run: ${tool}`,
      },
    };
  }
  const forge = await opts.runners.forgeOpenMrs(opts.cwd);
  if (!forge.ok) {
    return {
      verdict: "unverified",
      refusal: {
        kind: "stack-check-unavailable",
        branch: opts.branch,
        source: "forge",
        stack: null,
        mrs: null,
        tool: "",
        hint: `could not list open MRs to rule out a stack: ${forge.error}`,
      },
    };
  }
  const own = forge.mrs.filter((mr) => mr.source === opts.branch && mr.target !== opts.defaultBranch);
  const dependents = forge.mrs.filter((mr) => mr.target === opts.branch);
  if (own.length > 0 || dependents.length > 0) {
    const detail = own.length > 0
      ? `its open MR !${own[0]!.iid} targets ${own[0]!.target}`
      : `open MR${dependents.length === 1 ? "" : "s"} ${dependents.map((mr) => `!${mr.iid} (${mr.source})`).join(", ")} target it`;
    return {
      verdict: "refuse",
      refusal: {
        kind: "stack-refusal",
        branch: opts.branch,
        source: "forge",
        stack: null,
        mrs: [...own, ...dependents],
        tool: "gitq track",
        hint: `${opts.branch} is part of an untracked stack: ${detail}. Track it with gitq track, then run gitq sync`,
      },
    };
  }
  return { verdict: "clear" };
}

type ForgeListing = { ok: true; mrs: ForgeMr[] } | { ok: false; error: string };

function failure(prefix: string, r: { code: number; stdout: string; stderr: string }): ForgeListing {
  const detail = (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n")[0];
  return { ok: false, error: `${prefix}: ${detail}` };
}

function parseListing<T>(stdout: string, map: (row: T) => ForgeMr): ForgeListing {
  try {
    const rows = JSON.parse(stdout) as T[];
    return { ok: true, mrs: Array.isArray(rows) ? rows.map(map) : [] };
  } catch {
    return { ok: false, error: "forge listing was not JSON" };
  }
}

async function listOpenMrs(p: Probes, remote: string): Promise<ForgeListing> {
  const forge = forgeFromRemote(remote);
  if (!forge) return { ok: false, error: `origin ${remote} is not a GitHub or GitLab remote` };
  if (forge.provider === "github") {
    const r = await p.exec([...forgeArgv(p, "gh"), "pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,baseRefName,url"]);
    if (r.code !== 0) return failure("gh pr list failed", r);
    return parseListing<{ number: number; headRefName: string; baseRefName: string; url: string }>(r.stdout, (row) => ({
      iid: row.number, source: row.headRefName, target: row.baseRefName, url: row.url,
    }));
  }
  const r = await p.exec([...forgeArgv(p, "glab"), "mr", "list", "--output", "json", "--per-page", "100"], { env: glabEnv(forge.host) });
  if (r.code !== 0) return failure("glab mr list failed", r);
  return parseListing<{ iid: number; source_branch: string; target_branch: string; web_url: string }>(r.stdout, (row) => ({
    iid: row.iid, source: row.source_branch, target: row.target_branch, url: row.web_url,
  }));
}

/**
 * Real runners over the machine's gitq and forge CLIs. The forge listing is
 * per remote, not per worktree, so one instance serves a whole `rt sync all`
 * sweep with a single gh/glab call.
 */
export function createStackGuardRunners(p: Probes): StackGuardRunners {
  const listings = new Map<string, Promise<ForgeListing>>();
  return {
    async gitqStacks(cwd) {
      const r = await p.exec([...(bundledToolExec(p, "gitq") ?? ["gitq"]), "stacks", "--json", "-C", cwd]);
      return r.code === 0 ? r.stdout : null;
    },
    async forgeOpenMrs(cwd) {
      const remote = await p.exec(["git", "remote", "get-url", "origin"], { cwd });
      if (remote.code !== 0) return failure("no origin remote", remote);
      const url = remote.stdout.trim();
      let pending = listings.get(url);
      if (!pending) {
        pending = listOpenMrs(p, url);
        listings.set(url, pending);
      }
      return pending;
    },
  };
}
