/**
 * rt runner: a board of services, run in a detached tmux session by
 * default or in background herdr panes under --herdr. The command is the
 * gate and the wiring; the loop lives in lib/runner/runner.ts and the two
 * backends in lib/runner/engine.ts (herdr) and lib/runner/tmux-engine.ts.
 */
import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import type { CommandContext } from "../lib/command-tree.ts";
import { herdrRequest } from "../lib/herdr/client.ts";
import { bgEnsure, bgRelease } from "../packages/rt-client/src/index.ts";
import { HerdrEngine } from "../lib/runner/engine.ts";
import { Runner, SessionDied, type RunnerDeps, type SeedEntry } from "../lib/runner/runner.ts";
import { createTmuxEngine, killTmuxServer } from "../lib/runner/tmux-engine.ts";
import { planReconcile, planTmuxReconcile, readRegistry, registerWorkspace, unregisterWorkspace, isAlive } from "../lib/runner/workspace-registry.ts";
import { interactive } from "../lib/ui/gate.ts";
import { exit, openSession } from "../lib/ui/spawn.ts";
import { resolveRun } from "./run.ts";

/** Mirrors the herdr `Bun.which` idiom; `path` is a seam so tests can fake tmux being absent from PATH. */
export function tmuxAvailable(path: string = process.env.PATH ?? ""): boolean {
  return Bun.which("tmux", { PATH: path }) !== null;
}

export type { SeedEntry };

/** rtCommand's own daemon-down message shape (transport.ts); the only bg:release failure worth swallowing rather than warning about. */
function isDaemonUnreachable(error: string | undefined): boolean {
  return error !== undefined && error.includes("daemon unreachable");
}

/**
 * Acquires the daemon-owned bg server for `--herdr` mode: one `bg:ensure`
 * call under a board claim, and a release closure the caller runs on
 * teardown. Extracted from the gate so the claim/release wiring is
 * unit-testable without a real daemon or herdr socket.
 */
export async function acquireBgSocket(
  claim: string,
  deps: { bgEnsure: typeof bgEnsure; bgRelease: typeof bgRelease } = { bgEnsure, bgRelease },
): Promise<{ sock: string; release: () => Promise<void> }> {
  const res = await deps.bgEnsure({ claim });
  if (!res.ok || !res.data) {
    throw new Error(res.error ?? "bg:ensure failed");
  }
  const sock = res.data.socket;
  const release = async () => {
    const r = await deps.bgRelease({ claim });
    if (!r.ok && !isDaemonUnreachable(r.error)) {
      process.stderr.write(`  rt runner: bg release failed (${r.error})\n`);
    }
  };
  return { sock, release };
}

/** The exact deps the success path hands to Runner; pulled out so the assembly is unit-testable without a real herdr socket. */
export function buildRunnerDeps(args: string[], ctx: CommandContext, sock: string, seed?: SeedEntry[]): RunnerDeps {
  return {
    engine: new HerdrEngine(sock),
    openSession,
    resolve: () => resolveRun(args.filter((a) => a !== "--resolve-only"), ctx),
    now: () => new Date(),
    sleep: (ms) => Bun.sleep(ms),
    openUrl: async (url: string) => {
      const r = spawnSync("open", [url], { stdio: "ignore" });
      if (r.error) throw r.error;
      if (r.signal) throw new Error(`open was killed by ${r.signal}`);
      if (r.status !== 0) throw new Error(`open exited with ${r.status}`);
    },
    workspaceLabel: `rt-runner-${randomBytes(2).toString("hex")}`,
    seed,
    registerWorkspace: (id) => registerWorkspace(id),
    unregisterWorkspace: (id) => unregisterWorkspace(id),
  };
}

/** Same assembly as buildRunnerDeps, on the tmux backend: a fresh detached server per launch, registered under the "tmux" kind so its reconcile never touches herdr workspaces. */
export function buildTmuxRunnerDeps(args: string[], ctx: CommandContext, seed?: SeedEntry[]): RunnerDeps {
  return {
    engine: createTmuxEngine(),
    openSession,
    resolve: () => resolveRun(args.filter((a) => a !== "--resolve-only"), ctx),
    now: () => new Date(),
    sleep: (ms) => Bun.sleep(ms),
    openUrl: async (url: string) => {
      const r = spawnSync("open", [url], { stdio: "ignore" });
      if (r.error) throw r.error;
      if (r.signal) throw new Error(`open was killed by ${r.signal}`);
      if (r.status !== 0) throw new Error(`open exited with ${r.status}`);
    },
    workspaceLabel: `rt-runner-${randomBytes(2).toString("hex")}`,
    seed,
    registerWorkspace: (id) => registerWorkspace(id, process.pid, "tmux"),
    unregisterWorkspace: (id) => unregisterWorkspace(id, "tmux"),
  };
}

/**
 * Closes any rt-runner-* workspace no live runner owns (a prior launch that
 * died to SIGHUP or a crash, before this reconcile shipped). Best-effort: a
 * failure here must never block a new launch.
 */
export async function reconcileRunnerWorkspaces(sock: string): Promise<void> {
  try {
    const res = await herdrRequest<{ workspaces?: { workspace_id: string; label: string }[] }>("workspace.list", {}, { sockPath: sock });
    if (!res.ok) return;
    const workspaces = (res.result.workspaces ?? []).map((w) => ({ id: w.workspace_id, label: w.label }));
    const plan = planReconcile(workspaces, readRegistry(), isAlive);
    for (const id of plan.closeWorkspaceIds) {
      await herdrRequest("workspace.close", { workspace_id: id }, { sockPath: sock });
    }
    for (const id of plan.removeRegistryIds) {
      unregisterWorkspace(id);
    }
  } catch (err) {
    process.stderr.write(`  rt runner: orphan reconcile failed (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

/**
 * Closes any tmux server this machine's registry shows dead-owned (a prior
 * launch that never reached teardown). There is no tmux `workspace.list`
 * equivalent to cross-check against, unlike the herdr reconcile: the
 * registry itself is the whole signal. Best-effort: a failure here must
 * never block a new launch.
 */
export async function reconcileTmuxWorkspaces(): Promise<void> {
  try {
    const plan = planTmuxReconcile(readRegistry("tmux"), isAlive);
    for (const socket of plan.killSocketIds) await killTmuxServer(socket);
    for (const id of plan.removeIds) unregisterWorkspace(id, "tmux");
  } catch (err) {
    process.stderr.write(`  rt runner: tmux orphan reconcile failed (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

/** Gate + build + run, shared by the args-driven command and the seeded entry point. `args` feeds the resolve closure and, on the herdr path, selects the backend; the seeded caller has no CLI args, so it always passes `[]` and gets the tmux default. */
async function gateAndRun(ctx: CommandContext, args: string[], seed?: SeedEntry[]): Promise<void> {
  if (!interactive()) {
    process.stderr.write("rt runner needs an interactive terminal (it drives a live board from the one you are in)\n");
    return exit(1);
  }

  const useHerdr = args.includes("--herdr");
  const cleanArgs = args.filter((a) => a !== "--herdr" && a !== "--tmux");

  let runner: Runner;
  let releaseBgSocket: (() => Promise<void>) | undefined;
  if (useHerdr) {
    // buildRunnerDeps/new Runner live inside this same try, not after it: a
    // throw from either after acquireBgSocket succeeds would otherwise skip
    // releaseBgSocket entirely and leak the claim -- nothing past this block
    // ever runs release() for a herdr-path failure.
    try {
      const acquired = await acquireBgSocket("runner:" + process.pid);
      releaseBgSocket = acquired.release;
      await reconcileRunnerWorkspaces(acquired.sock);
      runner = new Runner(buildRunnerDeps(cleanArgs, ctx, acquired.sock, seed));
    } catch (err) {
      await releaseBgSocket?.();
      const message = err instanceof Error ? err.message : String(err);
      if (isDaemonUnreachable(message)) {
        process.stderr.write("the rt daemon is required for --herdr mode; start it and retry\n");
      } else {
        process.stderr.write(`  rt runner: ${message}\n`);
      }
      return exit(1);
    }
  } else {
    if (!tmuxAvailable()) {
      process.stderr.write("rt runner needs tmux on PATH (or pass --herdr to use herdr panes)\n");
      return exit(1);
    }
    await reconcileTmuxWorkspaces();
    runner = new Runner(buildTmuxRunnerDeps(cleanArgs, ctx, seed));
  }

  // The board dies with this process: a signal tears the workspace down
  // before exit so no background pane outlives its board. SIGHUP (a closed
  // terminal window) gets the same best-effort teardown; a launch this
  // catches never leaves a workspace for the next reconcile to find.
  const onSignal = () => {
    void runner.teardown()
      .finally(() => releaseBgSocket?.())
      .finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  try {
    await runner.run();
  } catch (err) {
    if (err instanceof SessionDied) {
      process.stderr.write(`\n  ${err.message}; the workspace was closed\n\n`);
      return exit(1);
    }
    throw err;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    await releaseBgSocket?.();
  }
}

export async function runnerCommand(args: string[], ctx: CommandContext): Promise<void> {
  return gateAndRun(ctx, args);
}

/** Opens the board pre-seeded with resolved rows (e.g. from `rt run` on a preset); the in-board `a` key still falls back to the normal resolve flow. */
export async function runSeededBoard(seed: SeedEntry[], ctx: CommandContext): Promise<void> {
  return gateAndRun(ctx, [], seed);
}
