/**
 * Background settling of claim-time ready steps (RT-96): provision hands the
 * tree over as soon as the branch is checked out and the triggered steps run
 * here, inside the daemon, with the outcome written to the registry. One task
 * per tree path; a second start (or an await-ready caller) joins the same
 * settle promise. The task never rejects — every outcome is a ReadySettle.
 */

import type { Logger } from "pino";
import { evaluateReadyGate, loadWorktreeRepoConfig, type ReadyStep } from "./config.ts";
import { changedSince, runReadySteps, stepsToRun } from "./ready.ts";
import { findByPath, loadRegistry } from "./registry.ts";
import { patchTree } from "./patch.ts";
import { withTreeLock } from "./locks.ts";
import { MAX_LOGGED_OUTPUT, outputTail } from "../subprocess.ts";

export type ReadySettle =
  | { ok: true }
  | { ok: false; failedStep?: string; skipped?: "tree-gone" | "busy" };

/** Lock retry budget: dispose/freshen hold a tree lock for at most one pass of
 *  work; a task that cannot get the lock inside this window reports busy
 *  rather than camping forever. */
const LOCK_RETRY_ATTEMPTS = 10;
const LOCK_RETRY_DELAY_MS = 3_000;

const inFlight = new Map<string, Promise<ReadySettle>>();

export function readyTaskFor(path: string): Promise<ReadySettle> | null {
  return inFlight.get(path) ?? null;
}

export interface ReadyTaskDeps {
  repoName: string;
  path: string;
  steps: ReadyStep[];
  emit: (type: string, data: unknown) => void;
  log: Logger;
  /** Lock retry budget; defaults to the constants above. */
  lockRetry?: { attempts: number; delayMs: number };
}

export function startReadyTask(deps: ReadyTaskDeps): Promise<ReadySettle> {
  const existing = inFlight.get(deps.path);
  if (existing) return existing;

  const task = runTask(deps)
    .catch((err): ReadySettle => {
      deps.log.warn({ err, repo: deps.repoName, path: deps.path }, "ready task: settle threw");
      return { ok: false, failedStep: "internal" };
    })
    .finally(() => {
      inFlight.delete(deps.path);
    });
  inFlight.set(deps.path, task);
  return task;
}

async function runTask(deps: ReadyTaskDeps): Promise<ReadySettle> {
  const { repoName, path, emit, log } = deps;
  const attempts = deps.lockRetry?.attempts ?? LOCK_RETRY_ATTEMPTS;
  const delayMs = deps.lockRetry?.delayMs ?? LOCK_RETRY_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await Bun.sleep(delayMs);

    const outcome = await withTreeLock(path, async (): Promise<ReadySettle> => {
      const rec = findByPath(loadRegistry(repoName), path);
      // A disposed or re-pooled tree must not have minutes of installs run
      // inside it on a stale claim's behalf.
      if (!rec || rec.state !== "claimed" || !rec.readyPendingAt) {
        return { ok: false, skipped: "tree-gone" };
      }

      const result = await runReadySteps(path, deps.steps);
      if (!result.ok) {
        patchTree(repoName, path, (r) => {
          delete r.readyPendingAt;
          r.readyFailure = result.failedStep;
        });
        log.warn(
          {
            repo: repoName, tree: rec.name, path,
            failedStep: result.failedStep,
            output: outputTail(result.output, MAX_LOGGED_OUTPUT),
          },
          "ready task: step failed; tree is usable but its dependencies may be stale",
        );
        emit("worktree:ready-settled", {
          repo: repoName, tree: rec.name, path, ok: false, failedStep: result.failedStep,
        });
        return { ok: false, failedStep: result.failedStep };
      }

      patchTree(repoName, path, (r) => {
        delete r.readyPendingAt;
        delete r.readyFailure;
        r.readyAt = new Date().toISOString();
      });
      emit("worktree:ready-settled", { repo: repoName, tree: rec.name, path, ok: true });
      return { ok: true };
    });

    if (outcome !== "busy") return outcome;
  }

  log.warn({ repo: repoName, path }, "ready task: tree lock stayed busy; leaving steps pending for recovery");
  return { ok: false, skipped: "busy" };
}

/**
 * The claim-time step set, recomputed from current config and the tree's
 * stamp — what provision would queue right now. Used when the queue itself
 * was lost (daemon restart) and by await-ready's orphan recovery.
 */
export async function computeClaimReadySteps(
  repoName: string,
  repoPath: string,
  treePath: string,
): Promise<ReadyStep[]> {
  const cfg = await loadWorktreeRepoConfig(repoName, repoPath);
  const { steps } = await evaluateReadyGate(cfg, repoName, repoPath);
  const stamp = findByPath(loadRegistry(repoName), treePath)?.readyStamp;
  const changed = stamp ? await changedSince(treePath, stamp) : null;
  return stepsToRun(steps, changed);
}

export interface RecoverDeps {
  repoName: string;
  repoPath: string;
  emit: (type: string, data: unknown) => void;
  log: Logger;
}

/**
 * Restart recovery: a claimed tree still marked pending with no in-flight
 * task lost its settle to a daemon death. Steps are idempotent by the RT-34
 * contract, so the whole recomputed set re-runs. Fire-and-forget per tree —
 * a reconcile pass must never block on installs.
 */
export async function recoverPendingReady(deps: RecoverDeps): Promise<string[]> {
  const { repoName, repoPath, emit, log } = deps;
  const kicked: string[] = [];
  for (const rec of loadRegistry(repoName)) {
    if (rec.state !== "claimed" || !rec.readyPendingAt || readyTaskFor(rec.path)) continue;
    const steps = await computeClaimReadySteps(repoName, repoPath, rec.path);
    log.info(
      { repo: repoName, tree: rec.name, steps: steps.map((s) => s.run) },
      "ready task: recovering steps left pending by a daemon restart",
    );
    startReadyTask({ repoName, path: rec.path, steps, emit, log });
    kicked.push(rec.name);
  }
  return kicked;
}
