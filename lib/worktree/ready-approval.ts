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
import { getSetting } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";
import type { ReadyStep } from "./config.ts";

export const READY_APPROVAL_KEY = "rt.worktreeReadyApproval";

/** Order-sensitive content hash of a ready ladder; a stable id for approval. */
export function readyLadderHash(steps: ReadyStep[]): string {
  const canonical = JSON.stringify(steps.map((s) => [s.run, s.when ?? null]));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** The user-approved hash for this repo, or undefined when none is recorded. */
export function readReadyApproval(repoIdentity: string | null): string | undefined {
  if (!repoIdentity) return undefined;
  try {
    const { value } = getSetting<string>(READY_APPROVAL_KEY, { repoIdentity });
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Record the user's approval of `hash` for this repo (user scope). */
export function writeReadyApproval(repoIdentity: string, hash: string): void {
  setSetting(READY_APPROVAL_KEY, hash, "user", { repoIdentity });
}
