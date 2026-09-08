/**
 * The one stored-then-staged read of rt's forge token. `absent` and
 * `unreadable` are kept apart because only `absent` is evidence that the user
 * has connected no account: a store rt cannot read says nothing about them.
 */

import { NoAgeKeyError, readSecret } from "../secrets/store.ts";
import { forgeTokenKey } from "./git-credential.ts";
import type { SecretPresence } from "../setup/validators/accounts.ts";
import { createRealAgeKeySeam } from "../home/age-key.ts";
import { createRealSecretsExecSeam } from "../secrets/store.ts";
import type { Probes } from "../setup/probes.ts";
import { readStagedSecret } from "../setup/staging.ts";

export type ForgeTokenLookup =
  | { kind: "token"; token: string }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

export interface ForgeTokenSeams {
  readStored: (domain: string, key: string) => Promise<string | null>;
  readStaged: (domain: string, key: string) => string | null;
}

export async function forgeTokenLookup(remote: string, seams: ForgeTokenSeams): Promise<ForgeTokenLookup> {
  const key = forgeTokenKey(remote);
  if (!key) return { kind: "absent" };
  try {
    const stored = await seams.readStored("rt", key);
    if (stored !== null) return { kind: "token", token: stored };
  } catch (err) {
    if (!(err instanceof NoAgeKeyError)) {
      return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
    }
  }
  const staged = seams.readStaged("rt", key);
  return staged === null ? { kind: "absent" } : { kind: "token", token: staged };
}

export function tokenOrNull(lookup: ForgeTokenLookup): string | null {
  return lookup.kind === "token" ? lookup.token : null;
}

export async function forgeTokenLookupFromPresence(remote: string, secrets: SecretPresence | undefined): Promise<ForgeTokenLookup> {
  if (!secrets) return { kind: "absent" };
  return forgeTokenLookup(remote, { readStored: (d, k) => secrets.has(d, k), readStaged: () => null });
}

export async function forgeTokenLookupReal(p: Probes, remote: string): Promise<ForgeTokenLookup> {
  return forgeTokenLookup(remote, {
    readStored: (d, k) => readSecret(d, k, { ageKeySeam: createRealAgeKeySeam(), execSeam: createRealSecretsExecSeam() }),
    readStaged: (d, k) => readStagedSecret(p, d, k),
  });
}
