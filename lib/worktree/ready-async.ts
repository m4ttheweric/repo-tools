/**
 * Background settling of claim-time ready steps (RT-96): provision hands the
 * tree over as soon as the branch is checked out and the triggered steps run
 * here, inside the daemon, with the outcome written to the registry. One task
 * per tree path; a second start (or an await-ready caller) joins the same
 * settle promise. The task never rejects — every outcome is a ReadySettle.
 */

import type { Logger } from "pino";
import type { ReadyStep } from "./config.ts";
import { runReadySteps } from "./ready.ts";
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

  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await Bun.sleep(LOCK_RETRY_DELAY_MS);

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
