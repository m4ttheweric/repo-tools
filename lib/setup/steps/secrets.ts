/**
 * `secrets.write` — drains T3's staging pen (lib/setup/staging.ts) into the
 * real sops-backed store(s). The drain callback dispatches by domain shape:
 * a staged domain matching `team-<slug>-(rt|board)` — the exact shape
 * `commands/setup.ts`'s `teamScopedDomain` stages under — goes through the
 * TEAM store (`writeTeamSecret`, at `teams/<slug>/mattstack/secrets/<domain>.json`,
 * `realTeamSecrets.read`'s only read path); everything else is a personal
 * domain and goes through `writeSecret`. Neither call goes through
 * `SecretWriter.write`, which is type-narrowed to `"rt" | "board"` and would
 * reject a raw domain string.
 */

import { drainStaged } from "../staging.ts";
import { NoAgeKeyError, writeSecret } from "../../secrets/store.ts";
import { writeTeamSecret } from "../../secrets/team-store.ts";
import { UserActionableError } from "../errors.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";

const TEAM_SCOPED_DOMAIN = /^team-(.+)-(rt|board)$/;

function parseTeamScopedDomain(domain: string): { slug: string; domain: "rt" | "board" } | null {
  const m = TEAM_SCOPED_DOMAIN.exec(domain);
  return m ? { slug: m[1]!, domain: m[2] as "rt" | "board" } : null;
}

async function secretsWriteRun(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    const count = await drainStaged(ctx.p, async (domain, key, value) => {
      // Forward-only: registered before the write, which is the first place
      // this value could reach a thrown message a crash-safety catch below
      // (or the engine's own bug path) would otherwise log unredacted.
      ctx.redact(value);

      const team = parseTeamScopedDomain(domain);
      if (team) {
        await writeTeamSecret(team.slug, team.domain, key, value, ctx.teamSecrets(team.slug));
      } else {
        await writeSecret(domain, key, value, ctx.secrets);
      }
    });
    return { state: "done", detail: count === 0 ? "nothing staged" : `${count} staged secrets written` };
  } catch (err) {
    if (err instanceof NoAgeKeyError) {
      return { state: "failed", detail: err.message, remedy: "home.init did not mint a key — Retry from home.init" };
    }
    // A joined machine's pull-only clone is not a defect Install should block
    // on: drainStaged leaves the offending domain's staging file untouched on
    // this throw (same as any other failed write), so the secret stays
    // staged rather than being silently dropped.
    if (err instanceof UserActionableError && err.code === "team-pull-only") {
      return { state: "skipped", detail: `${err.message} Nothing was written.` };
    }
    // Anything else — sops missing/non-zero, no team recipients yet, a
    // malformed .sops.yaml — is an expected store-write failure, not a bug:
    // drainStaged leaves the offending domain's staging file untouched on a
    // throw, so Retry finds the same secret still queued.
    const detail = err instanceof Error ? err.message : String(err);
    return { state: "failed", detail };
  }
}

export const secretsWriteStep: StepDef = {
  id: "secrets.write",
  title: "Write your secrets",
  kind: "rt",
  applies: () => true,
  run: secretsWriteRun,
};
