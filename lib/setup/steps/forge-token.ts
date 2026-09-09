/**
 * The forge token an Install step offers git for a remote: the sops store
 * when it exists, else what the checklist staged, since team.create,
 * team.join and repos.clone all run before secrets.write drains the stage.
 */

import { readSecret } from "../../secrets/store.ts";
import type { ApplyContext } from "../apply.ts";
import { readStagedSecret } from "../staging.ts";
import { forgeTokenLookup, tokenOrNull } from "../../team/forge-token.ts";

/** Null when rt holds no token for the remote's host. */
export async function forgeTokenFor(ctx: ApplyContext, remote: string): Promise<string | null> {
  return tokenOrNull(
    await forgeTokenLookup(remote, {
      readStored: (d, k) => readSecret(d, k, ctx.secrets),
      readStaged: (d, k) => readStagedSecret(ctx.p, d, k),
    })
  );
}
