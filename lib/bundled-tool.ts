/**
 * Resolve a bundled helper by name: the copy inside mattstack.app first, then
 * PATH, then the bare name.
 *
 * The bare-name fallback is deliberate. Returning it unchanged means a machine
 * with neither copy fails exactly as it did before — with the tool's own
 * "not found" — rather than with a null-path crash from this module. What the
 * caller gains is that an INSTALLED machine no longer depends on the user
 * having the tool on PATH at all.
 *
 * `lib/ui/resolve.ts` keeps its own resolver because it also owns a bespoke
 * missing-tool message and an exit path; this is the plain version for tools
 * that just need an argv[0].
 */

import { bundledHelperPath } from "./bundle-layout.ts";

export type Which = (bin: string) => string | null;

const defaultWhich: Which = (b) => Bun.which(b);

/**
 * `bundledHelperPath` throws on a row mislabeled `kind: "buildtool"`. A bad
 * deps.lock entry must degrade to the PATH fallback rather than crash every
 * spawn — same reasoning as resolveFzf's own guard.
 */
function bundled(name: string): string | null {
  try {
    return bundledHelperPath(name);
  } catch {
    return null;
  }
}

export function resolveBundledTool(name: string, which: Which = defaultWhich): string {
  return bundled(name) ?? which(name) ?? name;
}
