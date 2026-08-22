/**
 * `home.init` / `home.restore` — the two steps that get the home repo
 * (~/.mattstack/user, A1: user/ IS the repo) and its age key onto this
 * machine. `home.restore` never runs the real restore itself: the app
 * already ran `rt home init`'s materialize phase (settings lane) before this
 * step gets a turn, so this only confirms the clone and the key landed.
 */

import { join } from "path";
import { readAgeKey } from "../../home/age-key.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";

function homeGitDir(home: string): string {
  return join(home, ".mattstack", "user", ".git");
}

async function hasLocalKey(ctx: ApplyContext): Promise<boolean> {
  try {
    const result = await readAgeKey(ctx.secrets.ageKeySeam);
    return "key" in result;
  } catch {
    // Keychain unreachable/locked reads the same as "no key yet" here — the
    // fallback below (running `rt home init` for real, or failing
    // home.restore) is the honest next step either way.
    return false;
  }
}

async function homeInitRun(ctx: ApplyContext): Promise<StepOutcome> {
  const { p } = ctx;
  const alreadyCloned = p.exists(homeGitDir(p.home));
  if (alreadyCloned && (await hasLocalKey(ctx))) {
    return { state: "done", detail: "already initialized" };
  }

  const result = await p.runRt(["home", "init"]);
  if (result.code === 0) {
    const lastLine = result.stdout.trim().split("\n").pop() ?? "";
    return { state: "done", detail: lastLine };
  }

  const stderrHead = result.stderr.trim().split("\n")[0] ?? "";
  return { state: "failed", detail: stderrHead, remedy: "Run `gh auth login`, then Retry" };
}

async function homeRestoreRun(ctx: ApplyContext): Promise<StepOutcome> {
  const { p } = ctx;
  const homeRepo = ctx.intent?.restore?.homeRepo;
  const cloned = p.exists(homeGitDir(p.home));
  const gitConfig = cloned ? p.readFile(join(homeGitDir(p.home), "config")) : null;
  const originMatches = homeRepo !== undefined && gitConfig !== null && gitConfig.includes(homeRepo);

  if (cloned && originMatches && (await hasLocalKey(ctx))) {
    return { state: "done", detail: "restored" };
  }

  return {
    state: "failed",
    detail: `the home repo clone or its local age key could not be confirmed at ${join(p.home, ".mattstack", "user")}`,
    remedy: "Run `rt restore <org>/<repo>` (pastes your age key), then Retry",
  };
}

export const homeInitStep: StepDef = {
  id: "home.init",
  title: "Create your settings home repo",
  kind: "rt",
  applies: (ctx) => ctx.intent?.mode !== "restore",
  run: homeInitRun,
};

export const homeRestoreStep: StepDef = {
  id: "home.restore",
  title: "Restore your settings home repo",
  kind: "rt",
  applies: (ctx) => ctx.intent?.mode === "restore",
  run: homeRestoreRun,
};
