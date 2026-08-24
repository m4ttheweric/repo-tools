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
import { toFailedOutcome } from "./step-utils.ts";

/** `rt home init` itself, self-invoked as a subprocess, does a lot (clone, then its own materialize phase) — generous but bounded so a stalled clone/network call surfaces as a real failure instead of hanging the whole Install button. */
const HOME_INIT_TIMEOUT_MS = 180_000;

function homeGitDir(home: string): string {
  return join(home, ".mattstack", "user", ".git");
}

type KeyStatus = { status: "present" } | { status: "absent" } | { status: "unreachable"; message: string };

/**
 * `readAgeKey` throws (rather than reporting "absent") specifically so a
 * caller can never mint/act on a false negative when the keychain is merely
 * locked or unreachable — collapsing that back into "no key" is the one
 * thing its own doc warns against, so this keeps the three outcomes
 * distinct instead of swallowing the throw.
 */
async function checkLocalKey(ctx: ApplyContext): Promise<KeyStatus> {
  try {
    const result = await readAgeKey(ctx.secrets.ageKeySeam);
    return { status: "key" in result ? "present" : "absent" };
  } catch (err) {
    return { status: "unreachable", message: err instanceof Error ? err.message : String(err) };
  }
}

async function homeInitRun(ctx: ApplyContext): Promise<StepOutcome> {
  const { p } = ctx;
  const alreadyCloned = p.exists(homeGitDir(p.home));
  const keyStatus = await checkLocalKey(ctx);

  if (alreadyCloned && keyStatus.status === "present") {
    return { state: "done", detail: "already initialized" };
  }

  // A locked/unreachable keychain must fail loudly here rather than fall
  // through to a full `rt home init` re-run, which would hit the exact same
  // keychain call (and, on an already-cloned repo, redo materialize for no
  // reason) — see checkLocalKey's doc.
  if (keyStatus.status === "unreachable") {
    return { state: "failed", detail: `local age key check failed: ${keyStatus.message}`, remedy: "Unlock your keychain, then Retry" };
  }

  const result = await p.runRt(["home", "init"], { timeoutMs: HOME_INIT_TIMEOUT_MS });
  if (result.code === 0) {
    const lastLine = result.stdout.trim().split("\n").pop() ?? "";
    return { state: "done", detail: lastLine };
  }

  const stderrHead = result.stderr.trim().split("\n")[0] ?? "";
  return { state: "failed", detail: stderrHead, remedy: homeInitRemedy(result.stderr) };
}

/** Stderr that names a remote/auth failure on its own terms, with no ambiguity about which end of the wire failed. */
const REMOTE_AUTH_STDERR = /authenticat|could not read username|access denied|repository not found|403 forbidden|invalid username or (?:password|token)|gh auth login|permission denied \(publickey/i;
/** ssh writes "Permission denied (publickey)", but so does a plain local `fatal: cannot mkdir user: Permission denied` — on its own this says nothing about a remote. */
const AMBIGUOUS_PERMISSION_STDERR = /permission denied/i;
/** `commands/home.ts` prints `failed at step "<id>"`; only the clone step ever contacts a host. */
const CLONE_STEP_STDERR = /failed at step "cloneUserRepo"/;

/**
 * `rt home init` reaches a remote only when a url was resolved; the local-only
 * path (`git init`/`add`/`commit`) contacts no host at all, so `gh auth login`
 * is reserved for stderr that actually names an auth/clone failure. A bare
 * "permission denied" qualifies only alongside the clone step — otherwise a
 * local filesystem permission error, the very class the local-only path
 * introduced, would be sent to `gh auth login`.
 */
function homeInitRemedy(stderr: string): string {
  const remoteShaped =
    REMOTE_AUTH_STDERR.test(stderr) ||
    (AMBIGUOUS_PERMISSION_STDERR.test(stderr) && CLONE_STEP_STDERR.test(stderr));
  return remoteShaped ? "Run `gh auth login`, then Retry" : "Check the error above, then Retry";
}

async function homeRestoreRun(ctx: ApplyContext): Promise<StepOutcome> {
  const { p } = ctx;
  const homeRepo = ctx.intent?.restore?.homeRepo;
  const cloned = p.exists(homeGitDir(p.home));
  const gitConfig = cloned ? p.readFile(join(homeGitDir(p.home), "config")) : null;
  const originMatches = homeRepo !== undefined && gitConfig !== null && gitConfig.includes(homeRepo);
  const keyStatus = await checkLocalKey(ctx);

  if (cloned && originMatches && keyStatus.status === "present") {
    return { state: "done", detail: "restored" };
  }

  if (keyStatus.status === "unreachable") {
    // The clone/origin may be perfectly fine here — an unlock, not a fresh
    // restore, is the actual fix, and pointing at `rt restore` would be
    // actively wrong (it would ask for the age key again, when the real
    // problem is this machine can't read the one it already has).
    return {
      state: "failed",
      detail: `local age key check failed: ${keyStatus.message}`,
      remedy: "Unlock your keychain, then Retry",
    };
  }

  return {
    state: "failed",
    detail: `the home repo clone or its local age key could not be confirmed at ${join(p.home, ".mattstack", "user")}`,
    remedy: "Run `rt setup intent restore <org>/<repo>`, then `rt home key import` to paste your age key, then Retry",
  };
}

async function homeInitRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await homeInitRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

async function homeRestoreRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await homeRestoreRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const homeInitStep: StepDef = {
  id: "home.init",
  title: "Create your settings home repo",
  kind: "rt",
  applies: (ctx) => ctx.intent?.mode !== "restore",
  run: homeInitRunSafe,
};

export const homeRestoreStep: StepDef = {
  id: "home.restore",
  title: "Restore your settings home repo",
  kind: "rt",
  applies: (ctx) => ctx.intent?.mode === "restore",
  run: homeRestoreRunSafe,
};
