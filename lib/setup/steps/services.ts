/**
 * `services.register` / `proxy.install` — the two `--from-app` steps: rt
 * cannot itself register a LaunchAgent or run the privileged proxy
 * installer, so both hand off to mattstack.app over the need protocol
 * (`ctx.need`) and wait for its answer.
 */

import { currentMode } from "../../dev-mode.ts";
import { markDaemonInstalled } from "../../daemon-config.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { servicePlists } from "../need.ts";
import { needOutcome, toFailedOutcome } from "./step-utils.ts";

async function servicesRegisterRun(ctx: ApplyContext): Promise<StepOutcome> {
  const { plists, deckOmitted } = servicePlists(currentMode(), ctx.p);
  if (deckOmitted) ctx.log("services.register", "deck not bundled yet — only the daemon is registered");

  const reply = await ctx.need("services.register", { type: "app-register-services", plists });
  const outcome = needOutcome(reply, ctx, {
    noAppDetail: "mattstack.app not running — open it to register services",
    noAppRemedy: "Open mattstack.app, then Retry",
    timeoutRemedy: "Retry with mattstack.app running",
  });

  if (outcome.state === "done") markDaemonInstalled(ctx.p.home);
  return outcome;
}

async function servicesRegisterRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await servicesRegisterRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const servicesRegisterStep: StepDef = {
  id: "services.register",
  title: "Register background services",
  kind: "app",
  applies: () => true,
  run: servicesRegisterRunSafe,
};

/** The uninstall plan's own signal for "portless is installed" (docs/superpowers/plans/2026-08-21-rt-setup-verbs.md's proxy.remove gate) — reused here so a from-scratch re-run recognizes an already-installed proxy without re-raising the admin prompt. */
const PORTLESS_LAUNCHD_PLIST = "/Library/LaunchDaemons/sh.portless.proxy.plist";

async function proxyInstallRun(ctx: ApplyContext): Promise<StepOutcome> {
  if (ctx.p.exists(PORTLESS_LAUNCHD_PLIST)) return { state: "done", detail: "already installed" };

  const reply = await ctx.need("proxy.install", { type: "app-privileged", op: "proxy-install" });
  return needOutcome(reply, ctx, {
    noAppDetail: "mattstack.app not running — open it to install the local proxy",
    noAppRemedy: "Open mattstack.app, then Retry",
    timeoutRemedy: "Retry with mattstack.app running",
  });
}

async function proxyInstallRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await proxyInstallRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const proxyInstallStep: StepDef = {
  id: "proxy.install",
  title: "Install the local proxy",
  kind: "privileged",
  applies: () => true,
  run: proxyInstallRunSafe,
};
