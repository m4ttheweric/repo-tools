/**
 * `fastbrowser.setup`, `herdr.integration`, `extension.install`,
 * `services.start`, `snapshot.push` — the remaining `--tool`/rt-driven apply
 * steps. Each tool-setup step pre-checks the tool's own presence itself
 * (never lets `setupTool`'s `UserActionableError` fall through to the
 * generic failed-outcome catch) so a genuinely absent, optional tool on a
 * fresh machine reads as `skipped`, not `failed`.
 */

import { join } from "path";
import { resolveTool } from "../../deps/resolve.ts";
import type { SnapshotResult } from "../../daemon/home-snapshot.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import type { Probes } from "../probes.ts";
import { claudeConfigDirs, setupTool, type ToolsInstallSeams } from "../tools-install.ts";
import { toFailedOutcome } from "./step-utils.ts";

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

// ─── fastbrowser.setup ───────────────────────────────────────────────────────

async function fastbrowserSetupRun(ctx: ApplyContext): Promise<StepOutcome> {
  const resolved = resolveTool(ctx.p, "fast-browser");
  if (!resolved.exec) return { state: "skipped", detail: "fast-browser not bundled" };

  const result = await setupTool(ctx.p, "fast-browser", { configDirs: [] });
  if (result.ok) return { state: "done", detail: result.detail };
  return { state: "failed", detail: result.detail, remedy: "Run `fast-browser setup` in a terminal for details" };
}

async function fastbrowserSetupRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await fastbrowserSetupRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const fastbrowserSetupStep: StepDef = {
  id: "fastbrowser.setup",
  title: "Set up Fast Browser",
  kind: "rt",
  applies: () => true,
  run: fastbrowserSetupRunSafe,
};

// ─── herdr.integration ───────────────────────────────────────────────────────

async function herdrIntegrationRun(ctx: ApplyContext): Promise<StepOutcome> {
  const resolved = resolveTool(ctx.p, "herdr");
  if (!resolved.chosen) return { state: "skipped", detail: "herdr not installed (Tools row)" };

  const configDirs = claudeConfigDirs(ctx.p, []);
  const result = await setupTool(ctx.p, "herdr", { configDirs });
  if (result.ok) return { state: "done", detail: result.detail };
  return { state: "failed", detail: result.detail, remedy: "Run `herdr integration install claude` in a terminal for details" };
}

async function herdrIntegrationRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await herdrIntegrationRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const herdrIntegrationStep: StepDef = {
  id: "herdr.integration",
  title: "Set up herdr integration",
  kind: "rt",
  applies: () => true,
  run: herdrIntegrationRunSafe,
};

// ─── extension.install ───────────────────────────────────────────────────────

const VSIX_MISSING_PREFIX = "rt-context.vsix not found";
const NO_EDITORS_DETAIL = "no compatible editors found";

/** `seams` is exposed only for tests — `detectEditors`/`findVsix` read the real machine, so a test drives them the same way tools-install.test.ts does rather than through Probes. Production always takes `setupTool`'s own real-seam default. */
export async function extensionInstallRun(ctx: ApplyContext, seams?: ToolsInstallSeams): Promise<StepOutcome> {
  const result = await setupTool(ctx.p, "extension", { configDirs: [] }, seams);
  if (result.ok) return { state: "done", detail: result.detail };
  if (result.detail.startsWith(VSIX_MISSING_PREFIX)) return { state: "skipped", detail: "extension not bundled" };
  if (result.detail === NO_EDITORS_DETAIL) return { state: "skipped", detail: "no editor found" };
  return { state: "failed", detail: result.detail, remedy: "Install the extension manually, then Retry" };
}

async function extensionInstallRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await extensionInstallRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const extensionInstallStep: StepDef = {
  id: "extension.install",
  title: "Install the browser extension",
  kind: "rt",
  applies: () => true,
  run: extensionInstallRunSafe,
};

// ─── services.start ──────────────────────────────────────────────────────────

const DAEMON_POLL_ATTEMPTS = 12;
const DAEMON_POLL_INTERVAL_MS = 250;

/** Exported so a test can drive the wait with an instant fake sleep instead of the real 3s worst case. */
export async function waitForDaemonUp(
  p: Pick<Probes, "daemon">,
  opts: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? DAEMON_POLL_ATTEMPTS;
  const intervalMs = opts.intervalMs ?? DAEMON_POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? realSleep;

  for (let i = 0; i < attempts; i++) {
    const res = await p.daemon("ping");
    if (res?.ok) return true;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return false;
}

export async function servicesStartRun(ctx: ApplyContext, sleep?: (ms: number) => Promise<void>): Promise<StepOutcome> {
  const res = await ctx.p.tray("/daemon/start", { method: "POST" });
  if (res.status !== 200) {
    return ctx.nonInteractive
      ? { state: "skipped", detail: "mattstack.app not running" }
      : { state: "failed", detail: "mattstack.app not running", remedy: "Open mattstack.app" };
  }

  const up = await waitForDaemonUp(ctx.p, { sleep });
  if (up) return { state: "done", detail: "daemon running" };
  return { state: "failed", detail: "daemon did not come up", remedy: "Approve the background item in Login Items, then Retry" };
}

async function servicesStartRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await servicesStartRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const servicesStartStep: StepDef = {
  id: "services.start",
  title: "Start services",
  kind: "rt",
  applies: () => true,
  run: servicesStartRunSafe,
};

// ─── snapshot.push ────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 30_000;

function homeUserRepoDir(p: Pick<Probes, "home">): string {
  return join(p.home, ".mattstack", "user");
}

async function gitSnapshotFallback(ctx: ApplyContext): Promise<StepOutcome> {
  const repoDir = homeUserRepoDir(ctx.p);
  if (!ctx.p.exists(join(repoDir, ".git"))) {
    return { state: "skipped", detail: "home repo not provisioned yet (`rt home init`)" };
  }

  const remedy = "check `git -C ~/.mattstack status`";

  const add = await ctx.p.exec(["git", "-C", repoDir, "add", "-A"], { timeoutMs: GIT_TIMEOUT_MS });
  if (add.code !== 0) return { state: "failed", detail: `git add failed (exit ${add.code}): ${firstLine(add.stderr || add.stdout)}`, remedy };

  const commit = await ctx.p.exec(["git", "-C", repoDir, "commit", "-m", "setup: snapshot"], { timeoutMs: GIT_TIMEOUT_MS });
  const nothingToCommit = commit.code !== 0 && /nothing to commit/i.test(`${commit.stdout}\n${commit.stderr}`);
  if (commit.code !== 0 && !nothingToCommit) {
    return { state: "failed", detail: `git commit failed (exit ${commit.code}): ${firstLine(commit.stderr || commit.stdout)}`, remedy };
  }

  const push = await ctx.p.exec(["git", "-C", repoDir, "push"], { timeoutMs: GIT_TIMEOUT_MS });
  if (push.code !== 0) return { state: "failed", detail: `git push failed (exit ${push.code}): ${firstLine(push.stderr || push.stdout)}`, remedy };

  return { state: "done", detail: nothingToCommit ? "nothing new to commit; pushed" : "committed and pushed" };
}

async function snapshotPushRun(ctx: ApplyContext): Promise<StepOutcome> {
  // `rt home snapshot` has no `push` subcommand — the daemon's own
  // `home:snapshot` handler (lib/daemon/handlers/home.ts) is the real
  // trigger `rt home snapshot` itself round-trips to; drive it the same way
  // rather than shelling out to a CLI verb that doesn't exist.
  const reply = await ctx.p.daemon("home:snapshot");
  if (reply === null) return gitSnapshotFallback(ctx);

  if (!reply.ok) {
    return { state: "failed", detail: reply.error ?? "home:snapshot reported failure", remedy: "check `git -C ~/.mattstack status`" };
  }

  const result = reply.data as SnapshotResult | undefined;
  if (result?.skipped) return { state: "skipped", detail: `snapshot skipped: ${result.skipped}` };
  if (!result?.committed) return { state: "done", detail: "no changes to snapshot" };
  return { state: "done", detail: `committed ${result.sha ? result.sha.slice(0, 8) : "(no sha)"}` };
}

async function snapshotPushRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await snapshotPushRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const snapshotPushStep: StepDef = {
  id: "snapshot.push",
  title: "Push your first snapshot",
  kind: "rt",
  applies: () => true,
  run: snapshotPushRunSafe,
};
