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

async function reposCloneRun(ctx: ApplyContext): Promise<StepOutcome> {
  const { p } = ctx;
  const root = getSetting<string[]>("rt.repoRoots").value?.[0];
  if (!root) return { state: "failed", detail: "no repo root" };

  const skip = skippedIdentities(p.env);
  const identities = (ctx.snapshot?.trackingIdentities ?? []).filter((identity) => {
    const base = repoBasename(identity);
    return !skip.has(identity) && !skip.has(base);
  });

  let cloned = 0;
  let present = 0;
  let failed = 0;

  for (const identity of identities) {
    const base = repoBasename(identity);
    const dest = join(root, base);

    if (p.exists(dest)) {
      present++;
      updateRepoIndex(base, dest);
      continue;
    }

    const result = await p.exec(["git", "clone", `https://${identity}.git`, dest]);
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
