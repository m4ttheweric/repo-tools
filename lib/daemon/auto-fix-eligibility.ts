/**
 * Auto-fix eligibility evaluator.
 *
 * Pure function over a normalized MR snapshot + the on-disk attempt log.
 * Returns `{ eligible: true }` only when every gate passes; otherwise
 * `{ eligible: false, reason: <short string> }` describing the first
 * gate that failed (cheapest-first for fast short-circuit).
 *
 * Gates:
 *   1. Author is me
 *   2. MR status = opened
 *   3. Approved + no pending changes_requested
 *   4. Pipeline failed on current HEAD; not a retried-and-passed flake
 *   5. Attempt budget for this SHA + cooldown since last fixed commit
 */

import { countAttemptsForSha, readLog } from "../auto-fix-log.ts";

export interface MrSnapshot {
  authorIsMe:            boolean;
  status:                string;
  isApproved:            boolean;
  changesRequested:      boolean;
  pipelineStatus:        string;
  pipelineSha:           string;
  flakeRetriedAndPassed: boolean;
}

export interface EligibilityInput {
  repoName:    string;
  branch:      string;
  headSha:     string;
  mr:          MrSnapshot;
  now:         number;
  cooldownMs:  number;
  attemptCap:  number;
}

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: string };

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { mr, repoName, branch, headSha, now, cooldownMs, attemptCap } = input;

  if (!mr.authorIsMe) {
    return { eligible: false, reason: "not authored by me" };
  }
  if (mr.status !== "opened") {
    return { eligible: false, reason: `status=${mr.status}` };
  }

  if (!mr.isApproved) {
    return { eligible: false, reason: "not approved" };
  }
  if (mr.changesRequested) {
    return { eligible: false, reason: "changes_requested pending" };
  }

  if (mr.pipelineStatus !== "failed") {
    return { eligible: false, reason: `pipeline=${mr.pipelineStatus}` };
  }
  if (mr.pipelineSha !== headSha) {
    return { eligible: false, reason: "pipeline ran on stale SHA, not current MR HEAD" };
  }
  if (mr.flakeRetriedAndPassed) {
    return { eligible: false, reason: "flake (job retried-and-passed)" };
  }

  const attempts = countAttemptsForSha(repoName, branch, headSha);
  if (attempts >= attemptCap) {
    return { eligible: false, reason: `attempt cap reached (${attempts}/${attemptCap})` };
  }

  const log = readLog(repoName);
  const lastFixed = log
    .filter(e => e.branch === branch && e.outcome === "fixed")
    .sort((a, b) => b.attemptedAt - a.attemptedAt)[0];
  if (lastFixed && now - lastFixed.attemptedAt < cooldownMs) {
    return {
      eligible: false,
      reason: `cooldown active (${Math.round((now - lastFixed.attemptedAt) / 1000)}s since last fix)`,
    };
  }

  return { eligible: true };
}
