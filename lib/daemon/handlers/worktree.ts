/**
 * Worktree lifecycle IPC verbs (spec §3): provision, create, dispose, list,
 * freshen, adopt. Every mutation the CLI and the skills perform goes through
 * here, which is what makes the daemon the single writer of the registry.
 *
 * The verbs are thin: the intelligence lives in lib/worktree/* (create,
 * dispose guard, locks, branch naming) and lib/daemon/worktree-reconciler.ts
 * (reconcile, freshen). What this module owns is the ORDER those pieces run
 * in, which is load-bearing for provision (§7):
 *
 *   1. resolve intent and fire every registry-decidable refusal BEFORE any
 *      tree is touched — an expected "resume there?" refusal must never
 *      strand a claimed tree;
 *   2. select / create the tree;
 *   3. claim it under its lock;
 *   4. check the work branch out per the resolution matrix;
 *   5. roll back on any failure after the claim — reverted to on-deck when the
 *      tree never left its `on-deck/<name>` branch, disposable (with the
 *      failure as the reason) when it did. No limbo states.
 *
 * Handler outcomes are `{ok:true, data}` / `{ok:false, error}` with typed
 * refusal strings; daemon.ts's handleCommand does the outcome logging, so
 * nothing here logs request/response.
 *
 * Every `repoName` here (payload field, registry key, `ctx.repoIndex()`
 * lookup) is the CLI's serialized repo identity, not a display name —
 * `index[repoName]` and `loadRegistry(repoName)` only resolve because both
 * sides now key on that same identity string.
 */

import { realpathSync, rmSync } from "fs";
import { join } from "path";

import type { HandlerContext, HandlerMap } from "./types.ts";
import {
  findByBranch,
  loadRegistry,
  saveRegistry,
  type DisposalMode,
  type TreeRecord,
} from "../../worktree/registry.ts";
import { disambiguate, slugifyTicketTitle } from "../../worktree/branch-name.ts";
import { createTree } from "../../worktree/create.ts";
import { classifyDirtyAsync, disposeTree, type DisposeDeps } from "../../worktree/dispose.ts";
import { isTreeLocked, withTreeLock } from "../../worktree/locks.ts";
import {
  branchExistsLocalAsync,
  currentBranchAsync,
  remoteDefaultRef,
  remoteRefExists,
  runGit,
} from "../../worktree/git-async.ts";
import {
  loadWorktreeAppConfig,
  loadWorktreeRepoConfig,
  resolveReadySteps,
} from "../../worktree/config.ts";
import { changedSince, runReadySteps, stepsToRun } from "../../worktree/ready.ts";
import { freshenRepo, reconcileRepoRegistry } from "../worktree-reconciler.ts";
import { repoDataDir, rtDir } from "../../rt-paths.ts";

const PROVISION_FETCH_TIMEOUT_MS = 5 * 60_000;

/** git's ref-not-found signature — the ONE fetch failure that means "no such remote branch". */
const NO_REMOTE_REF_RE = /couldn't find remote ref/i;

const PARKING_LOT_BRANCH_RE = /^parking-lot\/\d+$/;

/** Lines of failed-step output carried into a `create-failed:` refusal. */
const CREATE_FAILED_TAIL_LINES = 10;

export type BranchState = "new" | "tracking-remote" | "existing-clean" | "diverged" | "behind";

export interface WorktreeHandlerOpts {
  /** Broadcast bus (daemon's broadcast+cron composite). */
  emit: (type: string, data: unknown) => void;
  /** Ask the reconciler for a pass (replenish after a claim / disposal). */
  kick: () => void;
  /** The live replenish create for a repo, or null; provision joins it rather than racing it. */
  creationInFlight: (repoName: string) => Promise<void> | null;
}

// ─── Small shared helpers ────────────────────────────────────────────────────

/** realpathSync defensively; a path that doesn't exist compares as-is. */
function canon(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function patchTree(repoName: string, path: string, patch: (rec: TreeRecord) => void): void {
  const trees = loadRegistry(repoName);
  const rec = trees.find((t) => t.path === path);
  if (!rec) return;
  patch(rec);
  saveRegistry(repoName, trees);
}

/**
 * `create-failed:<step>` carrying the tail of that step's output, same shape as
 * `checkout-failed:<detail>`. The step name alone tells the caller which install
 * died but nothing about why, and the output is not otherwise reachable from the
 * CLI.
 */
export function createFailedError(
  created: { failedStep?: string; output?: string },
  note?: string | null,
): string {
  const step = created.failedStep ?? "unknown";
  const tail = (created.output ?? "")
    .trim()
    .split("\n")
    .slice(-CREATE_FAILED_TAIL_LINES)
    .join("\n")
    .trim();
  return [`create-failed:${step}`, tail, note].filter((part) => part).join("\n");
}

/**
 * On-deck trees provision could not select because their last freshen failed and
 * they are inside its retry backoff. Without this the refusal reads as one
 * unlucky create when the whole pool is failing the same way.
 */
export function backoffNote(trees: TreeRecord[], now: number): string | null {
  const held = trees.filter(
    (t) =>
      t.kind === "ephemeral" &&
      t.state === "on-deck" &&
      t.nextRetryAt !== undefined &&
      Date.parse(t.nextRetryAt) > now,
  );
  if (held.length === 0) return null;

  const earliest = Math.min(...held.map((t) => Date.parse(t.nextRetryAt!)));
  const noun = held.length === 1 ? "tree" : "trees";
  return `${held.length} on-deck ${noun} held by retry backoff until ${new Date(earliest).toISOString()}`;
}

/** Every local branch name in the repo, for the sync `exists()` disambiguation predicate. */
async function localBranchNames(repoPath: string): Promise<Set<string>> {
  const r = await runGit(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return new Set(
    r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
  );
}

/** Repos this payload targets: the named one, or every repo in the index. */
function targetRepos(ctx: HandlerContext, repoName?: string): Array<[string, string]> {
  const index = ctx.repoIndex();
  if (repoName) {
    const path = index[repoName];
    return path ? [[repoName, path]] : [];
  }
  return Object.entries(index);
}

function disposeDeps(
  ctx: HandlerContext,
  opts: WorktreeHandlerOpts,
  repoName: string,
  repoPath: string,
): DisposeDeps {
  return {
    repoName,
    repoPath,
    cacheEntries: ctx.cache.entries as DisposeDeps["cacheEntries"],
    emit: opts.emit,
    log: ctx.log,
    killProcesses: loadWorktreeAppConfig().killProcesses,
  };
}

// ─── Provision (spec §7) ─────────────────────────────────────────────────────

/**
 * Best on-deck tree: freshest first (`readyAt` desc, `createdAt` desc as the
 * tie-break), skipping trees another operation holds the lock on and trees
 * whose last freshen failed (they are inside their retry backoff and are not
 * "ready" in the sense provision needs).
 */
function selectOnDeck(repoName: string): TreeRecord | undefined {
  const now = Date.now();
  const stamp = (t: TreeRecord): number => Date.parse(t.readyAt ?? "") || 0;
  return loadRegistry(repoName)
    .filter(
      (t) =>
        t.kind === "ephemeral" &&
        t.state === "on-deck" &&
        !isTreeLocked(t.path) &&
        (!t.nextRetryAt || Date.parse(t.nextRetryAt) <= now),
    )
    .sort((a, b) => stamp(b) - stamp(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

/** Ahead/behind counts of `branch` vs its `origin/` counterpart. */
async function divergence(
  treePath: string,
  branch: string,
): Promise<{ ahead: number; behind: number } | null> {
  const r = await runGit(treePath, [
    "rev-list", "--left-right", "--count", `${branch}...origin/${branch}`,
  ]);
  if (r.exitCode !== 0) return null;
  const [ahead, behind] = r.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(ahead!) || !Number.isFinite(behind!)) return null;
  return { ahead: ahead!, behind: behind! };
}

/**
 * Whether the entry a provision selected may still be claimed by it.
 *
 * ONLY `on-deck` qualifies. `claimed` is exactly the state that means another
 * provision won the race: accepting it would overwrite that caller's owner and
 * disposal mode and re-checkout their tree underneath them. `creating` and
 * `disposable` are equally not ours to take, and a vanished entry means the
 * reconciler pruned the tree while we were selecting it.
 */
export function isClaimable(rec: TreeRecord | undefined): boolean {
  return rec !== undefined && rec.kind === "ephemeral" && rec.state === "on-deck";
}

export function createWorktreeHandlers(
  ctx: HandlerContext,
  opts: WorktreeHandlerOpts,
): HandlerMap {
  /**
   * Undo a claim that could not be completed. Still on its `on-deck/<name>`
   * branch → the tree is untouched and goes back in the pool; already moved
   * off it → it is no longer a pool tree, so it becomes disposable carrying
   * the failure as its reason (never left claimed-but-unusable).
   */
  async function rollbackClaim(
    repoName: string,
    rec: TreeRecord,
    onDeckBranch: string | null,
    reason: string,
  ): Promise<void> {
    const current = await currentBranchAsync(rec.path);
    if (onDeckBranch && current === onDeckBranch) {
      patchTree(repoName, rec.path, (r) => {
        r.state = "on-deck";
        r.branch = onDeckBranch;
        delete r.owner;
        delete r.disposal;
        delete r.claimedAt;
      });
      return;
    }
    patchTree(repoName, rec.path, (r) => {
      r.state = "disposable";
      r.branch = current;
      r.disposableReason = reason;
    });
    opts.emit("worktree:disposable", {
      repo: repoName, tree: rec.name, path: rec.path, branch: current, reason,
    });
  }

  return {
    "worktree:provision": async (payload: any) => {
      const repoName: string | undefined = payload?.repoName;
      const repoPath = repoName ? ctx.repoIndex()[repoName] : undefined;
      if (!repoName || !repoPath) return { ok: false, error: "repo-unknown" };

      const cfg = await loadWorktreeRepoConfig(repoName, repoPath);
      const trees = loadRegistry(repoName);

      // ── 1. Intent + every registry-decidable refusal, before any tree moves.
      let branch: string;
      if (typeof payload.branch === "string" && payload.branch.length > 0) {
        branch = payload.branch;
      } else if (typeof payload.ticket === "string" && payload.ticket.length > 0) {
        const base = slugifyTicketTitle(
          payload.ticket,
          typeof payload.ticketTitle === "string" ? payload.ticketTitle : "",
          cfg.branchFormat,
        ).replace(/-+$/, "");
        const local = await localBranchNames(repoPath);
        const registered = new Set(
          trees.map((t) => t.branch).filter((b): b is string => typeof b === "string"),
        );
        branch = disambiguate(base, (candidate) => local.has(candidate) || registered.has(candidate));
      } else {
        return { ok: false, error: "branch-unresolved" };
      }

      const attached = findByBranch(trees, branch);
      if (attached.length > 1) return { ok: false, error: "branch-duplicated" };
      if (attached.length === 1) return { ok: false, error: `branch-attached:${attached[0]!.name}` };

      // ── 2. Selection, then the pool's own in-flight create, then cold create.
      let rec = selectOnDeck(repoName);
      let wasOnDeck = true;
      if (!rec) {
        const inFlight = opts.creationInFlight(repoName);
        if (inFlight) {
          await inFlight;
          rec = selectOnDeck(repoName);
          // Joining a replenish build is still a build the caller waited for,
          // so it is reported as a cold create, not as a warm pool hit.
          if (rec) wasOnDeck = false;
        }
      }
      if (!rec) {
        const created = await createTree({
          repoName, repoPath, emit: opts.emit, log: ctx.log,
        });
        if (!created.ok) {
          if (created.error === "busy") return { ok: false, error: "busy" };
          return {
            ok: false,
            error: createFailedError(created, backoffNote(loadRegistry(repoName), Date.now())),
          };
        }
        rec = created.tree;
        wasOnDeck = false;
      }

      const tree = rec;
      const onDeckBranch = tree.branch;

      const outcome = await withTreeLock(tree.path, async (): Promise<
        { ok: true; data: any } | { ok: false; error: string }
      > => {
        // The registry may have moved between selection and the lock.
        const fresh = loadRegistry(repoName).find((t) => t.path === tree.path);
        if (!isClaimable(fresh)) return { ok: false, error: "busy" };

        // ── 3. Claim. `branch` is deliberately NOT written here: reconcile
        // step (c) owns that field as git ground truth and would reset it to
        // `on-deck/<name>` on its next pass anyway, so recording the work
        // branch before the checkout only invents a fact git disagrees with.
        // The window that leaves open (another provision naming the same
        // branch between claim and checkout) is closed by git itself — the
        // second checkout fails with "already checked out", which rolls that
        // caller back rather than handing two trees the same branch.
        const disposal: DisposalMode = payload.disposal === "job" ? "job" : "merge";
        patchTree(repoName, tree.path, (r) => {
          r.state = "claimed";
          r.disposal = disposal;
          r.claimedAt = new Date().toISOString();
          if (typeof payload.owner === "string" && payload.owner.length > 0) r.owner = payload.owner;
        });
        opts.emit("worktree:claimed", {
          repo: repoName, tree: tree.name, branch, owner: payload.owner ?? null,
        });

        // ── 4. Branch resolution matrix, against a fresh targeted fetch.
        const fetch = await runGit(tree.path, ["fetch", "origin", branch], {
          timeoutMs: PROVISION_FETCH_TIMEOUT_MS,
        });
        let remoteHasBranch = true;
        if (fetch.exitCode !== 0) {
          const detail = (fetch.stderr + fetch.stdout).trim();
          // The two non-zero outcomes mean opposite things: only git's
          // ref-not-found signature means "no such branch upstream". An
          // unreachable/auth-failed origin must NOT be read as absence — that
          // would silently shadow a teammate's branch with an empty one.
          if (!NO_REMOTE_REF_RE.test(detail)) {
            await rollbackClaim(repoName, tree, onDeckBranch, `checkout-failed:${detail}`);
            return { ok: false, error: `checkout-failed:${detail}` };
          }
          remoteHasBranch = false;
        }

        const localExists = await branchExistsLocalAsync(tree.path, branch);
        let branchState: BranchState;
        let checkout;

        if (localExists) {
          // (c)/(e) local branch wins, checked out untouched — never auto-ff,
          // never reset; divergence is reported, not reconciled.
          checkout = await runGit(tree.path, ["checkout", branch]);
          branchState = "existing-clean";
          if (checkout.exitCode === 0 && (await remoteRefExists(tree.path, branch))) {
            const counts = await divergence(tree.path, branch);
            if (counts && counts.ahead > 0 && counts.behind > 0) branchState = "diverged";
            else if (counts && counts.behind > 0) branchState = "behind";
          }
        } else if (remoteHasBranch) {
          // (b) remote-only: base on the remote tip so a teammate's commits
          // survive. `origin/<branch>` normally exists after the targeted
          // fetch (standard refspec); FETCH_HEAD is the fallback when it does not.
          const startPoint = (await remoteRefExists(tree.path, branch))
            ? `origin/${branch}`
            : "FETCH_HEAD";
          checkout = await runGit(tree.path, ["checkout", "-b", branch, startPoint]);
          branchState = "tracking-remote";
        } else {
          // (a) nowhere: cut it from the default branch.
          const defaultRef = await remoteDefaultRef(tree.path);
          checkout = await runGit(tree.path, ["checkout", "-b", branch, defaultRef]);
          branchState = "new";
        }

        if (checkout.exitCode !== 0) {
          const detail = (checkout.stderr + checkout.stdout).trim();
          await rollbackClaim(repoName, tree, onDeckBranch, `checkout-failed:${detail}`);
          return { ok: false, error: `checkout-failed:${detail}` };
        }

        // The pool branch has served its purpose; the tree now carries the work branch.
        if (onDeckBranch && onDeckBranch.startsWith("on-deck/")) {
          await runGit(tree.path, ["branch", "-D", onDeckBranch]);
        }
        patchTree(repoName, tree.path, (r) => { r.branch = branch; });

        // Re-verify readiness: normally every `when` trigger no-ops, but a
        // default branch that moved (or a teammate branch just checked out)
        // runs the delta. A failing step does NOT destroy the claimed tree —
        // the caller has it and can fix it; readyAt simply doesn't advance.
        const readySteps = resolveReadySteps(cfg, repoPath);
        const stamp = loadRegistry(repoName).find((t) => t.path === tree.path)?.readyStamp;
        const changed = stamp ? await changedSince(tree.path, stamp) : null;
        const toRun = stepsToRun(readySteps, changed);
        let readyFailure: string | null = null;
        if (toRun.length > 0) {
          const ready = await runReadySteps(tree.path, toRun);
          if (!ready.ok) {
            readyFailure = ready.failedStep;
            ctx.log.warn(
              { repo: repoName, tree: tree.name, failedStep: ready.failedStep },
              "provision: ready step failed after claim",
            );
          } else {
            patchTree(repoName, tree.path, (r) => { r.readyAt = new Date().toISOString(); });
          }
        }

        const final = loadRegistry(repoName).find((t) => t.path === tree.path);
        return {
          ok: true,
          data: {
            tree: tree.name,
            path: tree.path,
            branch,
            wasOnDeck,
            readyAt: final?.readyAt ?? null,
            branchState,
            // Additive, and only present when it happened: the tree is usable
            // and handed over, but its dependencies may be stale.
            ...(readyFailure ? { readyFailed: true as const, failedStep: readyFailure } : {}),
          },
        };
      });

      if (outcome === "busy") return { ok: false, error: "busy" };
      // Claiming shrinks the pool: ask for a replenish pass now rather than
      // waiting for the next tick.
      if (outcome.ok) opts.kick();
      return outcome;
    },

    "worktree:create": async (payload: any) => {
      const repoName: string | undefined = payload?.repoName;
      const repoPath = repoName ? ctx.repoIndex()[repoName] : undefined;
      if (!repoName || !repoPath) return { ok: false, error: "repo-unknown" };

      const created = await createTree({ repoName, repoPath, emit: opts.emit, log: ctx.log });
      if (!created.ok) {
        if (created.error === "busy") return { ok: false, error: "busy" };
        return { ok: false, error: createFailedError(created) };
      }

      // Default is a tree for the caller to use; `--on-deck` puts it in the
      // pool instead. A claimed create keeps its `on-deck/<name>` branch (no
      // work branch was named) but is no longer claimable by provision.
      if (payload?.onDeck !== true) {
        patchTree(repoName, created.tree.path, (r) => {
          r.state = "claimed";
          r.claimedAt = new Date().toISOString();
        });
      }

      return { ok: true, data: { tree: created.tree.name, path: created.tree.path } };
    },

    "worktree:dispose": async (payload: any) => {
      const owner: string | undefined = typeof payload?.owner === "string" ? payload.owner : undefined;
      const treeName: string | undefined = typeof payload?.tree === "string" ? payload.tree : undefined;
      const force = payload?.force === true;

      // `--owner` sweeps globally by default (a run may span repos); `--repo`
      // narrows it. A named tree always needs its repo.
      const repos = targetRepos(ctx, payload?.repoName);
      if (repos.length === 0) return { ok: false, error: "repo-unknown" };
      if (!owner && !treeName) return { ok: false, error: "no-target" };

      const targets: Array<{ repoName: string; repoPath: string; rec: TreeRecord }> = [];
      for (const [name, path] of repos) {
        for (const rec of loadRegistry(name).filter((t) => (owner ? t.owner === owner : t.name === treeName))) {
          targets.push({ repoName: name, repoPath: path, rec });
        }
      }

      // A bare tree name that two repos both answer to is not a target rt gets
      // to guess at — disposal is the destructive verb (honesty over magic).
      if (!owner && targets.length > 1) return { ok: false, error: "tree-ambiguous" };

      const disposed: string[] = [];
      const refused: Array<{ tree: string; reason: string }> = [];
      const recoverable: Array<{ tree: string; path: string; until: string }> = [];

      for (const { repoName, repoPath, rec } of targets) {
        const deps = disposeDeps(ctx, opts, repoName, repoPath);
        const outcome = await withTreeLock(rec.path, () =>
          disposeTree(deps, rec, { force, auto: false }),
        );
        if (outcome === "busy") refused.push({ tree: rec.name, reason: "busy" });
        else if (outcome.disposed) {
          disposed.push(rec.name);
          if (outcome.trash) {
            recoverable.push({ tree: rec.name, path: outcome.trash.path, until: outcome.trash.keptUntil });
          }
        } else refused.push({ tree: rec.name, reason: outcome.refusal });
      }

      if (targets.length === 0 && treeName) refused.push({ tree: treeName, reason: "unknown" });
      if (disposed.length > 0) opts.kick();

      return { ok: true, data: { disposed, refused, recoverable } };
    },

    "worktree:list": async (payload: any) => {
      const repos = targetRepos(ctx, payload?.repoName);
      if (repos.length === 0 && payload?.repoName) return { ok: false, error: "repo-unknown" };

      const entries = ctx.cache.entries;
      const rows: Array<Record<string, unknown>> = [];

      for (const [repoName] of repos) {
        const trees = loadRegistry(repoName);
        const branchCounts = new Map<string, number>();
        for (const t of trees) {
          if (t.branch) branchCounts.set(t.branch, (branchCounts.get(t.branch) ?? 0) + 1);
        }

        for (const t of trees) {
          // The join key is (repoName, branch): a bare-branch join would hand
          // a tree another repo's MR when both repos use the same name.
          const entry = t.branch ? entries[t.branch] : undefined;
          const mr =
            entry?.mr && (!entry.repoName || entry.repoName === repoName)
              ? { iid: entry.mr.iid, state: entry.mr.state, title: entry.mr.title }
              : null;
          rows.push({
            ...t,
            repoName,
            mr,
            ...(t.branch && (branchCounts.get(t.branch) ?? 0) > 1 ? { duplicateBranch: true as const } : {}),
          });
        }
      }

      return { ok: true, data: { trees: rows } };
    },

    "worktree:freshen": async (payload: any) => {
      const treeName: string | undefined = typeof payload?.tree === "string" ? payload.tree : undefined;
      const repos = targetRepos(ctx, payload?.repoName);
      if (repos.length === 0) return { ok: false, error: "repo-unknown" };

      const ran: string[] = [];
      for (const [repoName, repoPath] of repos) {
        const names = await freshenRepo(
          { repoName, repoPath, emit: opts.emit, log: ctx.log },
          treeName ? { only: treeName } : {},
        );
        ran.push(...names);
      }
      return { ok: true, data: { ran } };
    },

    /**
     * One-shot migration sweep (spec §11.2): whatever the repo already has
     * becomes registry truth. Reconcile first so every worktree on disk has an
     * entry, then classify: the main clone stays main, clean `parking-lot/N`
     * trees are disposed through the normal guard (no-MR anchor) with their
     * branches, and every other tree is an occupied ephemeral — claimed on the
     * branch it is already sitting on.
     */
    "worktree:adopt": async (payload: any) => {
      const repoName: string | undefined = payload?.repoName;
      const repoPath = repoName ? ctx.repoIndex()[repoName] : undefined;
      if (!repoName || !repoPath) return { ok: false, error: "repo-unknown" };

      // Repo-wide lock: adopt rewrites every entry, so no per-tree operation
      // may interleave with it. Synthetic key (no tree lives at this path).
      const result = await withTreeLock(`${repoPath}#adopt`, async () => {
        const trees = await reconcileRepoRegistry({
          repoName, repoPath, emit: opts.emit, log: ctx.log,
        });

        let main = "";
        const claimed: string[] = [];
        const disposed: string[] = [];
        const refused: Array<{ tree: string; reason: string }> = [];

        for (const rec of trees) {
          if (rec.kind === "main" || canon(rec.path) === canon(repoPath)) {
            if (rec.kind !== "main") patchTree(repoName, rec.path, (r) => { r.kind = "main"; });
            main = rec.name;
            continue;
          }
          // Trees rt already manages are left exactly as they are.
          if (rec.kind === "ephemeral") continue;

          const parked =
            rec.branch !== null &&
            PARKING_LOT_BRANCH_RE.test(rec.branch) &&
            (await classifyDirtyAsync(rec.path)).blockers.length === 0;

          if (parked) {
            // Ephemeral+claimed first: the guard only ever deletes rt's own
            // trees, so the entry has to say so before disposal is even legal.
            patchTree(repoName, rec.path, (r) => {
              r.kind = "ephemeral";
              r.state = "claimed";
              // Same shape as the else-branch below, so a tree the guard
              // refuses is left a plain adopted claimed tree, not a hybrid.
              r.disposal = "merge";
              r.claimedAt = new Date().toISOString();
            });
            const deps = disposeDeps(ctx, opts, repoName, repoPath);
            const outcome = await withTreeLock(rec.path, () =>
              disposeTree(deps, { ...rec, kind: "ephemeral", state: "claimed" }, { auto: false }),
            );
            if (outcome === "busy") refused.push({ tree: rec.name, reason: "busy" });
            else if (outcome.disposed) disposed.push(rec.name);
            else refused.push({ tree: rec.name, reason: outcome.refusal });
            continue;
          }

          patchTree(repoName, rec.path, (r) => {
            r.kind = "ephemeral";
            r.state = "claimed";
            r.disposal = "merge";
            r.claimedAt = new Date().toISOString();
          });
          claimed.push(rec.name);
        }

        return { ok: true as const, data: { main, claimed, disposed, refused } };
      });

      if (result === "busy") return { ok: false, error: "busy" };
      if (result.ok) {
        // Adopt supersedes the parking lot: its per-repo index and app-level
        // transition state are dead once every tree is registry-tracked. The
        // app CONFIG file (~/.mattstack/rt/parking-lot.json, no "-state" suffix) is left
        // alone — loadWorktreeAppConfig still compat-reads it once to seed
        // worktrees.json.
        rmSync(join(repoDataDir(repoName), "parking-lot.json"), { force: true });
        rmSync(join(rtDir(), "parking-lot-state.json"), { force: true });
      }
      return result;
    },
  };
}
