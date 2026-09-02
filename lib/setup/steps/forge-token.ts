/**
 * The forge token an Install step offers git for a remote: the sops store
 * when it exists, else what the checklist staged, since team.create,
 * team.join and repos.clone all run before secrets.write drains the stage.
 */

import { NoAgeKeyError, readSecret } from "../../secrets/store.ts";
import { forgeTokenKey } from "../../team/git-credential.ts";
import type { ApplyContext } from "../apply.ts";
import { readStagedSecret } from "../staging.ts";

/** Null when rt holds no token for the remote's host. */
export async function forgeTokenFor(ctx: ApplyContext, remote: string): Promise<string | null> {
  const key = forgeTokenKey(remote);
  if (!key) return null;
  try {
    const stored = await readSecret("rt", key, ctx.secrets);
    if (stored !== null) return stored;
  } catch (err) {
    if (!(err instanceof NoAgeKeyError)) return null;
  }
  return readStagedSecret(ctx.p, "rt", key);
}
