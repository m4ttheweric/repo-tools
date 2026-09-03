/**
 * `settings.seed` — writes the handful of machine-scoped keys nothing else
 * seeds automatically: `mattstack.appPath` (from `ctx.appPath`, already
 * resolved through bundleRootFromExec/installedTrayAppPath by
 * createApplyContext — no path regex of our own here) and `rt.repoRoots`
 * (detected candidate directories, only when nothing is set yet).
 *
 * Never seeds a key with an empty placeholder value: T16's High finding —
 * scaffolding `board.projects: []` broke a running mr-board by flipping its
 * store-ownership latch — is exactly the failure mode this step must not
 * repeat. Every write here carries a real, non-empty value or doesn't happen.
 */

import { join } from "path";
import { getSetting } from "../../settings/resolve.ts";
import { setSetting } from "../../settings/write.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { toFailedOutcome, unwritten } from "./step-utils.ts";

/** The DMG mount or a Gatekeeper-translocated copy — a bundle running from either is a transient location `mattstack.appPath` must never point at, since the app can vanish out from under that path the moment the DMG is ejected. Also `commands/post-install.ts`'s own pre-apply refusal — same predicate, single source. */
export function isTransientAppRoot(root: string): boolean {
  return root.startsWith("/Volumes/") || root.includes("/AppTranslocation/");
}

const CANDIDATE_ROOT_NAMES = ["Documents/GitHub", "GitHub", "code", "src"];
/** The candidate this step creates when a team declares repos to clone but nothing on disk already matches — first in CANDIDATE_ROOT_NAMES, rt's own convention. */
const DEFAULT_ROOT_NAME = CANDIDATE_ROOT_NAMES[0]!;

function detectRepoRoots(ctx: ApplyContext): string[] {
  return CANDIDATE_ROOT_NAMES.map((rel) => join(ctx.p.home, rel)).filter((path) => ctx.p.exists(path));
}

/**
 * A fresh Mac has none of the candidate directories yet, which previously
 * left `rt.repoRoots` unset and `repos.clone` (step 9) with nowhere to
 * clone into — a normal fresh-machine condition, not something a human
 * needs to notice and fix by hand. Only creates the directory when there is
 * real work waiting on it (a team actually declares repos to track); a
 * team-less install gets no directory it doesn't need.
 */
function detectOrCreateDefaultRoot(ctx: ApplyContext): string[] {
  const detected = detectRepoRoots(ctx);
  if (detected.length > 0) return detected;
  if ((ctx.snapshot?.trackingIdentities.length ?? 0) === 0) return [];

  const path = join(ctx.p.home, DEFAULT_ROOT_NAME);
  ctx.p.mkdirp(path);
  return [path];
}

async function settingsSeedRun(ctx: ApplyContext): Promise<StepOutcome> {
  const written: string[] = [];

  if (ctx.appPath !== null) {
    if (isTransientAppRoot(ctx.appPath)) {
      return {
        state: "failed",
        detail: `running from ${ctx.appPath} — drag mattstack.app to /Applications, then Retry`,
        remedy: "Move mattstack.app to /Applications and relaunch it",
      };
    }
    // Only when it actually changes — a same-valued write on every Retry is
    // noise (a "wrote to the local store" line every time) and a lie about
    // what this run actually did.
    if (getSetting<string>("mattstack.appPath").value !== ctx.appPath) {
      setSetting("mattstack.appPath", ctx.appPath, "machine");
      written.push("mattstack.appPath");
    }
  }

  if (unwritten("rt.repoRoots")) {
    const detected = detectOrCreateDefaultRoot(ctx);
    if (detected.length > 0) {
      setSetting("rt.repoRoots", detected, "machine");
      written.push("rt.repoRoots");
    }
  }

  return { state: "done", detail: written.length > 0 ? `wrote: ${written.join(", ")}` : "nothing to seed" };
}

async function settingsSeedRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await settingsSeedRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const settingsSeedStep: StepDef = {
  id: "settings.seed",
  title: "Seed your settings",
  kind: "rt",
  applies: () => true,
  run: settingsSeedRunSafe,
};
