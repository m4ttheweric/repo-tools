/**
 * `fastbrowser.setup`, `herdr.integration`, `extension.install`,
 * `services.start`, `snapshot.push` — the remaining `--tool`/rt-driven apply
 * steps. Each tool-setup step pre-checks the tool's own presence itself
 * (never lets `setupTool`'s `UserActionableError` fall through to the
 * generic failed-outcome catch) so a genuinely absent, optional tool on a
 * fresh machine reads as `skipped`, not `failed`.
 */

import { resolveTool } from "../../deps/resolve.ts";
import type { SnapshotResult } from "../../daemon/home-snapshot.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import type { Probes } from "../probes.ts";
import { claudeConfigDirs, NO_EDITORS_DETAIL, setupTool, VSIX_NOT_FOUND_DETAIL, type ToolsInstallSeams } from "../tools-install.ts";
import { toFailedOutcome } from "./step-utils.ts";

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** `seams` is exposed only for tests — `detectEditors`/`findVsix` read the real machine, so a test drives them the same way tools-install.test.ts does rather than through Probes. Production always takes `setupTool`'s own real-seam default. */
export async function extensionInstallRun(ctx: ApplyContext, seams?: ToolsInstallSeams): Promise<StepOutcome> {
  const result = await setupTool(ctx.p, "extension", { configDirs: [] }, seams);
  if (result.ok) return { state: "done", detail: result.detail };
  if (result.detail === VSIX_NOT_FOUND_DETAIL) return { state: "skipped", detail: "extension not bundled" };
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

  // status 0 is the transport-level "no socket, nobody home" case (see
  // trayRequest) — genuinely unreachable, and a fair skip when nobody's
  // watching. Any OTHER non-200 means the app IS running and refused the
  // start (a real app-side failure) — that must always surface as `failed`,
  // never silently downgrade to a "not running" skip in a CI run.
  if (res.status === 0) {
    return ctx.nonInteractive
      ? { state: "skipped", detail: "mattstack.app not running" }
      : { state: "failed", detail: "mattstack.app not running", remedy: "Open mattstack.app" };
  }
  if (res.status !== 200) {
    return { state: "failed", detail: `mattstack.app returned status ${res.status} starting the daemon`, remedy: "Open mattstack.app" };
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

/**
 * Strips `user:pass@`/`user@` credentials out of any `http(s)://` URL found
 * anywhere in `text` — the same userinfo shape `team-settings.ts`'s
 * `stripUserinfo` strips, generalized to run mid-string: a daemon/git error
 * wraps the URL in prose ("fatal: unable to access '<url>': …"), so it is
 * never at position 0 the way `stripUserinfo`'s anchored match requires.
 */
function redactUrlCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^\s'"@/]+@/gi, "$1");
}

async function snapshotPushRun(ctx: ApplyContext): Promise<StepOutcome> {
  // `rt home snapshot` has no `push` subcommand — the daemon's own
  // `home:snapshot` handler (lib/daemon/handlers/home.ts) is the real
  // trigger `rt home snapshot` itself round-trips to; drive it the same way
  // rather than shelling out to a CLI verb that doesn't exist.
  //
  // There is deliberately NO local git fallback here. Only the daemon knows
  // the zone/exclude/owners model (`user/snapshot-owners.jsonc`) that keeps
  // another machine's profile, or a user's staged WIP, out of the shared
  // home repo — it builds `:(exclude)<zone>` pathspecs onto BOTH the add and
  // the commit (lib/daemon/home-snapshot.ts). A bare `git add -A` + `git
  // commit` here would ship exactly what that model exists to keep out, and
  // it would be the everyday path for a non-interactive/CI install (the
  // daemon is usually not up in that case). A missed snapshot is
  // recoverable on the daemon's next cycle; a leaked zone or WIP file
  // pushed to the shared repo is not — so this skips honestly instead.
  const reply = await ctx.p.daemon("home:snapshot");
  if (reply === null) {
    return { state: "skipped", detail: "snapshot deferred to the daemon's next cycle (daemon unreachable)" };
  }

  if (!reply.ok) {
    return { state: "failed", detail: redactUrlCredentials(reply.error ?? "home:snapshot reported failure"), remedy: "check `git -C ~/.mattstack/user status`" };
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
