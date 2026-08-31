/**
 * rt runner: a board of headless herdr panes. The command is the gate and
 * the wiring; the loop lives in lib/runner/runner.ts and the herdr calls in
 * lib/runner/engine.ts.
 */
import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import type { CommandContext } from "../lib/command-tree.ts";
import { herdrAvailable, herdrSocketPath } from "../lib/herdr/client.ts";
import { HerdrEngine } from "../lib/runner/engine.ts";
import { Runner, SessionDied, type RunnerDeps, type SeedEntry } from "../lib/runner/runner.ts";
import { interactive } from "../lib/ui/gate.ts";
import { exit, openSession } from "../lib/ui/spawn.ts";
import { resolveRun } from "./run.ts";

export type { SeedEntry };

/** The exact deps the success path hands to Runner; pulled out so the assembly is unit-testable without a real herdr socket. */
export function buildRunnerDeps(args: string[], ctx: CommandContext, sock: string, seed?: SeedEntry[]): RunnerDeps {
  return {
    engine: new HerdrEngine(sock),
    openSession,
    resolve: () => resolveRun(args.filter((a) => a !== "--resolve-only"), ctx),
    now: () => new Date(),
    sleep: (ms) => Bun.sleep(ms),
    openUrl: async (url: string) => {
      spawnSync("open", [url], { stdio: "ignore" });
    },
    workspaceLabel: `rt-runner-${randomBytes(2).toString("hex")}`,
    seed,
  };
}

/** Gate + build + run, shared by the args-driven command and the seeded entry point. `args` feeds `buildRunnerDeps`'s resolve closure; the seeded caller has no CLI args, so it always passes `[]`. */
async function gateAndRun(ctx: CommandContext, args: string[], seed?: SeedEntry[]): Promise<void> {
  if (!interactive()) {
    process.stderr.write("rt runner needs an interactive terminal (it drives herdr panes from the one you are in)\n");
    return exit(1);
  }
  const sock = herdrSocketPath();
  if (!(await herdrAvailable(sock))) {
    process.stderr.write(`herdr is not answering at ${sock}; start herdr and run rt runner from one of its panes\n`);
    return exit(1);
  }

  const runner = new Runner(buildRunnerDeps(args, ctx, sock, seed));

  // The board dies with this process: a signal tears the workspace down
  // before exit so no headless pane outlives its board.
  const onSignal = () => {
    void runner.teardown().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

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
  }
}

export async function runnerCommand(args: string[], ctx: CommandContext): Promise<void> {
  return gateAndRun(ctx, args);
}

/** Opens the board pre-seeded with resolved rows (e.g. from `rt run` on a preset); the in-board `a` key still falls back to the normal resolve flow. */
export async function runSeededBoard(seed: SeedEntry[], ctx: CommandContext): Promise<void> {
  return gateAndRun(ctx, [], seed);
}
