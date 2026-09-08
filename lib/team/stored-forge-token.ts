/**
 * The forge token rt holds for a remote's host, read from the personal
 * store. A fresh machine's git, gh and glab have nothing of their own to
 * offer a private team repo; this is what rt hands them instead.
 */

import type { Probes } from "../setup/probes.ts";
import { forgeTokenLookupReal, tokenOrNull } from "./forge-token.ts";

export async function storedForgeToken(p: Probes, remote: string): Promise<string | null> {
  return tokenOrNull(await forgeTokenLookupReal(p, remote));
}
