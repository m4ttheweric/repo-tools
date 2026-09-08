/**
 * Stack guard for `rt sync`: decides, before any ref moves, whether the
 * current branch belongs to a stack and must not be rebased onto the default
 * branch on its own. Sources, in order: gitq's stack store (the branch is a
 * node), then the forge (its open MR targets a non-default branch, or an
 * open MR targets it).
 */

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
  return { verdict: "clear" };
}
