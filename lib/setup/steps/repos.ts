/**
 * `repos.clone` — clones every repo the team snapshot declares as tracked
 * (`mattstack.tracking`) into the first configured `rt.repoRoots` entry.
 * Individual clone failures (auth, network) are logged and counted, never
 * fatal to the step — `repos.clone` still reports `done` with the tally, so
 * the run reaches `verify` and the operator can retry the ones that failed.
 */

import { join } from "path";
import { getSetting } from "../../settings/resolve.ts";
import { updateRepoIndex } from "../../repo-index.ts";
import { withoutUrls } from "../../team/redact.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { toFailedOutcome } from "./step-utils.ts";

/** Mirrors lib/team/join.ts's own clone env — never prompt for credentials in an unattended run, and never let a global gitconfig credential helper substitute one in behind the operator's back. */
const CLONE_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_PROTOCOL_FROM_USER: "0" };
/** Generous but bounded: a stalled clone must surface as a failed/counted identity, never hang the whole Install button with no progress. */
const CLONE_TIMEOUT_MS = 120_000;

/** The identity's last path segment (`github.com/acme/repo` -> `repo`) — the clone destination's directory name. */
function repoBasename(identity: string): string {
  return identity.split("/").pop() || identity;
}

function skippedIdentities(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env.RT_SKIP_REPOS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** A real clone of `identity`, not just any directory that happens to share its basename — two tracked identities can collide on basename (`gitlab.com/a/api`, `github.com/b/api`), and an unrelated folder can already occupy the path. */
function isCloneOf(p: ApplyContext["p"], dest: string, identity: string): boolean {
  const config = p.readFile(join(dest, ".git", "config"));
  return config !== null && config.includes(identity);
}

async function reposCloneRun(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await reposCloneRunUnsafe(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

async function reposCloneRunUnsafe(ctx: ApplyContext): Promise<StepOutcome> {
  const { p } = ctx;

  // Computed BEFORE the root check: zero identities means there is no work
  // regardless of whether a root is configured, and `skipped` — the
  // engine's honest "nothing to do here" — is the truth, not `failed`.
  const skip = skippedIdentities(p.env);
  const identities = (ctx.snapshot?.trackingIdentities ?? []).filter((identity) => {
    const base = repoBasename(identity);
    return !skip.has(identity) && !skip.has(base);
  });

  if (identities.length === 0) {
    return { state: "skipped", detail: "no repos to clone" };
  }

  const root = getSetting<string[]>("rt.repoRoots").value?.[0];
  if (!root) {
    return { state: "failed", detail: "no repo root configured", remedy: "Set a repo root (rt.repoRoots), then Retry" };
  }

  let cloned = 0;
  let present = 0;
  let failed = 0;

  for (const identity of identities) {
    const base = repoBasename(identity);
    const dest = join(root, base);

    if (p.exists(dest)) {
      if (isCloneOf(p, dest, identity)) {
        present++;
        updateRepoIndex(base, dest);
      } else {
        failed++;
        ctx.log("repos.clone", `${base}: ${dest} exists but isn't a clone of ${identity} (basename collision or unrelated folder) — resolve by hand`);
      }
      continue;
    }

    const result = await p.exec(["git", "clone", `https://${identity}.git`, dest], { env: CLONE_ENV, timeoutMs: CLONE_TIMEOUT_MS });
    if (result.code !== 0) {
      failed++;
      ctx.log("repos.clone", `${base}: clone failed — ${withoutUrls(`${result.stdout}\n${result.stderr}`.trim())}`);
      continue;
    }

    cloned++;
    updateRepoIndex(base, dest);
  }

  return { state: "done", detail: `cloned ${cloned}, present ${present}, failed ${failed}` };
}

export const reposCloneStep: StepDef = {
  id: "repos.clone",
  title: "Clone your repos",
  kind: "rt",
  applies: () => true,
  run: reposCloneRun,
};
