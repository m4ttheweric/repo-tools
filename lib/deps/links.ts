/**
 * Tagged PATH links: exposing a bundled tool at ~/.local/bin/<tool> so it's
 * reachable without the caller knowing about the app bundle. A single-argv
 * tool gets a real symlink; a multi-argv tool (e.g. fast-browser, which runs
 * through a bundled node) gets a tiny tagged wrapper script instead, since a
 * symlink can only point at one file. LINK_TAG marks that wrapper as ours so
 * unlink/reconcile only ever touch links rt itself created.
 */

import { join } from "path";
import { installRtBinary } from "../dev-mode.ts";
import type { Probes } from "../setup/probes.ts";
import { bundledToolExec, isOurLink, LINK_TAG, linkPath, userCopyOnPath } from "./resolve.ts";

export { isOurLink, LINK_TAG, linkPath };

/** The tools rt exposes on PATH by default (deps.lock's exposeByDefault still gates whether each is actually bundled). */
export const DEFAULT_EXPOSED = ["rt", "fast-browser", "gitq", "deck"] as const;

export type LinkOutcome =
  | { ok: true; path: string; state: "linked" | "already" }
  | { ok: false; reason: "no-bundle" | "user-copy" | "dev-mode-owns-rt" | "occupied"; detail: string };

export interface LinkSeams {
  /** Installs the "rt" link specifically (atomic link-then-rename), never a bare symlink. Overridable in tests. */
  installRtBinary: (src: string) => string;
}

const REAL_SEAMS: LinkSeams = { installRtBinary };

/**
 * rt in dev mode is signalled the same way lib/dev-mode.ts's currentMode()
 * detects it — a "#!" wrapper script at the link path — but read through the
 * Probes seam instead of raw fs, and narrowed to exclude our own tagged
 * wrapper (whose second line carries LINK_TAG, not a dev-mode shebang body).
 */
function isDevModeWrapper(p: Pick<Probes, "readFile">, path: string): boolean {
  const content = p.readFile(path);
  if (!content || !content.startsWith("#!")) return false;
  return !(content.split("\n")[1] ?? "").startsWith(LINK_TAG);
}

function wrapperScript(tool: string, exec: string[]): string {
  const argv = exec.map((e) => `"${e}"`).join(" ");
  return `#!/bin/sh\n${LINK_TAG} ${tool}\nexec ${argv} "$@"\n`;
}

/**
 * Expose a bundled tool at ~/.local/bin/<tool>. Refuses to shadow a
 * genuinely separate install (a copy elsewhere on PATH, or an unrelated file
 * already occupying the link path) unless `force`. "rt" always installs
 * through installRtBinary (atomic link-then-rename) rather than a bare
 * symlink, and is refused outright while dev mode owns the link path — force
 * does not override that; leave dev mode first.
 */
export function link(p: Probes, tool: string, opts: { force?: boolean } = {}, seams: LinkSeams = REAL_SEAMS): LinkOutcome {
  const path = linkPath(p.home, tool);

  if (tool === "rt" && isDevModeWrapper(p, path)) {
    return { ok: false, reason: "dev-mode-owns-rt", detail: `${path} is the dev-mode wrapper script; leave dev mode before linking rt` };
  }

  const exec = bundledToolExec(p, tool);
  if (!exec) return { ok: false, reason: "no-bundle", detail: `no bundled tool named "${tool}" in the app's deps.lock` };

  const occupied = p.exists(path);
  if (occupied && isOurLink(p, tool)) return { ok: true, path, state: "already" };

  if (!opts.force) {
    const elsewhere = userCopyOnPath(p, tool);
    if (elsewhere) return { ok: false, reason: "user-copy", detail: `${tool} is already on PATH at ${elsewhere}; pass --force to shadow it with the bundled copy` };
    if (occupied) return { ok: false, reason: "occupied", detail: `${path} exists and is not a mattstack-managed link; pass --force to replace it` };
  }

  if (occupied) p.removeFile(path);

  if (exec.length === 1) {
    if (tool === "rt") seams.installRtBinary(exec[0]!);
    else p.symlink(exec[0]!, path);
  } else {
    p.writeFile(path, wrapperScript(tool, exec), 0o755);
  }
  return { ok: true, path, state: "linked" };
}

/** Removes ~/.local/bin/<tool> only if it is one of our links (symlink or tagged wrapper) — never a user's own file. */
export function unlink(p: Probes, tool: string): { removed: boolean } {
  const path = linkPath(p.home, tool);
  if (!p.exists(path) || !isOurLink(p, tool)) return { removed: false };
  p.removeFile(path);
  return { removed: true };
}

/**
 * Auto-unlink: every tool with one of OUR links whose real copy has since
 * shown up elsewhere on PATH gets removed, so a tool the user installed for
 * themselves (e.g. `brew install gh`, after rt had linked the bundled one)
 * takes over cleanly instead of staying shadowed. Scans whatever actually
 * sits in ~/.local/bin rather than DEFAULT_EXPOSED — a tool can be linked
 * outside that default set (`rt deps link <tool> --force`) and still needs
 * reconciling.
 */
export function reconcile(p: Probes): { removed: string[]; kept: string[] } {
  const dir = join(p.home, ".local", "bin");
  const removed: string[] = [];
  const kept: string[] = [];
  for (const tool of p.readDir(dir)) {
    if (!isOurLink(p, tool)) continue; // not one of ours — nothing to reconcile
    if (userCopyOnPath(p, tool)) {
      p.removeFile(linkPath(p.home, tool));
      removed.push(tool);
    } else {
      kept.push(tool);
    }
  }
  return { removed, kept };
}
