/**
 * `secrets.write` — drains T3's staging pen (lib/setup/staging.ts) into the
 * real sops-backed store. The drain callback goes straight to `writeSecret`,
 * not `SecretWriter.write`: staged team secrets use domains shaped
 * `team-<slug>-<domain>`, and `SecretWriter` is type-narrowed to
 * `"rt" | "board"` and would reject them.
 */

import { drainStaged } from "../staging.ts";
import { NoAgeKeyError, writeSecret } from "../../secrets/store.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";

async function secretsWriteRun(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    const count = await drainStaged(ctx.p, (domain, key, value) => writeSecret(domain, key, value, ctx.secrets));
    return { state: "done", detail: count === 0 ? "nothing staged" : `${count} staged secrets written` };
  } catch (err) {
    if (err instanceof NoAgeKeyError) {
      return { state: "failed", detail: err.message, remedy: "home.init did not mint a key — Retry from home.init" };
    }
    throw err;
  }
}

export const secretsWriteStep: StepDef = {
  id: "secrets.write",
  title: "Write your secrets",
  kind: "rt",
  applies: () => true,
  run: secretsWriteRun,
};
