/**
 * The forge token rt holds for a remote's host, read from the personal
 * store. A fresh machine's git, gh and glab have nothing of their own to
 * offer a private team repo; this is what rt hands them instead.
 */

import { createRealAgeKeySeam } from "../home/age-key.ts";
import { createRealSecretsExecSeam, readSecret } from "../secrets/store.ts";
import type { Probes } from "../setup/probes.ts";
import { forgeTokenKey } from "./git-credential.ts";

export async function storedForgeToken(_p: Probes, remote: string): Promise<string | null> {
  const key = forgeTokenKey(remote);
  if (!key) return null;
  try {
    return await readSecret("rt", key, { ageKeySeam: createRealAgeKeySeam(), execSeam: createRealSecretsExecSeam() });
  } catch {
    return null;
  }
}
