/**
 * Approval store for team-authored worktree `ready` shell (RT-89).
 *
 * A team settings rung can own the whole `ready` ladder, whose steps run
 * unattended as `zsh -lc` on every teammate's machine. This records the user's
 * one-time approval of a specific ladder, keyed by a content hash: when the team
 * edits the ladder the hash changes and the approval no longer matches, so the
 * gate re-holds automatically (TOFU, like `direnv allow`). The approval lives in
 * the USER scope only (`scopes: ["user"]`), so a team store can never approve
 * its own shell.
 */

import { createHash } from "crypto";
import { explainSetting, SCOPE_ORDER } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";
import type { ReadyStep } from "./config.ts";

export const READY_APPROVAL_KEY = "rt.worktreeReadyApproval";

/**
 * The scopes an approval may come from. The key allows all three (a repoScoped
 * invariant), but a team-authored approval is never trusted... otherwise a team
 * store could approve its own shell, defeating the gate. So the read ignores
 * team / team.repo and honors only the user's and this machine's own rungs.
 */
const TRUSTED_APPROVAL_SCOPES = new Set(["machine.repo", "machine", "user.repo", "user"]);
const SCOPE_STRONGEST_FIRST = [...SCOPE_ORDER].reverse();

/** Order-sensitive content hash of a ready ladder; a stable id for approval. */
export function readyLadderHash(steps: ReadyStep[]): string {
  const canonical = JSON.stringify(steps.map((s) => [s.run, s.when ?? null]));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The approved hash for this repo from a trusted (user/machine) scope, or
 * undefined. Read via explainSetting rather than getSetting so a team-scope
 * value can be skipped explicitly: the merged resolution would let a stronger
 * team.repo rung win.
 */
export function readReadyApproval(repoIdentity: string | null): string | undefined {
  if (!repoIdentity) return undefined;
  let rows;
  try {
    rows = explainSetting(READY_APPROVAL_KEY, { repoIdentity });
  } catch {
    return undefined;
  }
  const byScope = new Map(rows.map((r) => [r.scope, r]));
  for (const scope of SCOPE_STRONGEST_FIRST) {
    if (!TRUSTED_APPROVAL_SCOPES.has(scope)) continue;
    const row = byScope.get(scope);
    if (row?.present && typeof row.value === "string" && row.value.length > 0) return row.value;
  }
  return undefined;
}

/** Record the user's approval of `hash` for this repo (user scope). */
export function writeReadyApproval(repoIdentity: string, hash: string): void {
  setSetting(READY_APPROVAL_KEY, hash, "user", { repoIdentity });
}
