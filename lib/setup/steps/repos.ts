/**
 * `repos.clone` — clones every repo the team snapshot declares as tracked
 * (`mattstack.tracking`) into the first configured `rt.repoRoots` entry.
 * Individual clone failures (auth, network) are logged and counted, never
 * fatal to the step — `repos.clone` still reports `done` with the tally, so
 * the run reaches `verify` and the operator can retry the ones that failed.
 */

import { join } from "path";
import { getSetting } from "../../settings/resolve.ts";
import { updateRepoIndexAsync } from "../../repo-index.ts";
import { serializeIdentity } from "../../settings/identity.ts";
import { gitWithToken } from "../../team/git-credential.ts";
import { withoutUrls } from "../../team/redact.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { forgeTokenFor } from "./forge-token.ts";
import { toFailedOutcome } from "./step-utils.ts";

/** Mirrors lib/team/join.ts's own clone env — never prompt for credentials in an unattended run, and never let a global gitconfig credential helper substitute one in behind the operator's back. */
const CLONE_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_PROTOCOL_FROM_USER: "0" };
/** Generous but bounded: a stalled clone must surface as a failed/counted identity, never hang the whole Install button with no progress. */
const CLONE_TIMEOUT_MS = 120_000;

/** The identity's last path segment (`github.com/acme/repo` -> `repo`) — the clone destination's directory name. Exported: `steps/skills.ts`'s `board.keys` derives the same registered-repo-name set from tracking identities and must agree with this step on what a repo is called. */
export function repoBasename(identity: string): string {
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

/**
 * Index `dest` under the tracked identity, reporting a refused move rather
 * than counting the repo present/cloned: the row would still name the path
 * the repo moved away from, so the tally would claim a repo rt cannot reach.
 */
async function indexDest(ctx: ApplyContext, identity: string, base: string, dest: string): Promise<boolean> {
  // The index keys on the serialized identity; `identity` here is already the
  // raw host/path the tracked-repos setting carries.
  const indexed = await updateRepoIndexAsync(serializeIdentity({ kind: "remote", id: identity }), dest);
  if (indexed.ok) return true;
  ctx.log("repos.clone", `${base}: ${dest} is in place, but ${identity} is indexed at a path that no longer exists and could not be moved — ${indexed.error}; run: rt repos locate ${dest}`);
  return false;
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

  // A fresh Mac with no `Documents/GitHub`-shaped directory yet has nothing
  // for `settings.seed` (step 8) to detect and seed rt.repoRoots from — that
  // is a normal fresh-machine condition, not a terminal one: `failed` would
  // dead-end Install with a Retry that resumes at this same step and fails
  // identically (the same class settings.seed's own docblock warns against).
  const root = getSetting<string[]>("rt.repoRoots").value?.[0];
  if (!root) {
    return { state: "skipped", detail: "no repo root configured yet — set rt.repoRoots, then re-run rt setup apply to clone your tracked repos" };
  }

  let cloned = 0;
  let present = 0;
  let failed = 0;

  for (const identity of identities) {
    const base = repoBasename(identity);
    const dest = join(root, base);

    if (p.exists(dest)) {
      if (!isCloneOf(p, dest, identity)) {
        failed++;
        ctx.log("repos.clone", `${base}: ${dest} exists but isn't a clone of ${identity} (basename collision or unrelated folder) — resolve by hand`);
        continue;
      }
      if (await indexDest(ctx, identity, base, dest)) present++;
      else failed++;
      continue;
    }

    const remote = `https://${identity}.git`;
    const git = gitWithToken(["clone", remote, dest], await forgeTokenFor(ctx, remote), CLONE_ENV);
    const result = await p.exec(git.argv, { env: git.env, timeoutMs: CLONE_TIMEOUT_MS });
    if (result.code !== 0) {
      failed++;
      ctx.log("repos.clone", `${base}: clone failed — ${withoutUrls(`${result.stdout}\n${result.stderr}`.trim())}`);
      continue;
    }

    if (await indexDest(ctx, identity, base, dest)) cloned++;
    else failed++;
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
