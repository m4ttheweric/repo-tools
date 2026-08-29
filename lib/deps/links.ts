/**
 * Tagged PATH links: exposing a bundled tool at ~/.local/bin/<tool> so it's
 * reachable without the caller knowing about the app bundle. A single-argv
 * tool gets a real symlink; a multi-argv tool (e.g. fast-browser, which runs
 * through a bundled node) gets a tiny tagged wrapper script instead, since a
 * symlink can only point at one file. LINK_TAG marks that wrapper as ours so
 * unlink/reconcile only ever touch links rt itself created.
 */

import { dirname, join } from "path";
import { installRtBinary } from "../dev-mode.ts";
import type { Probes } from "../setup/probes.ts";
import { readSetupState, updateSetupState } from "../setup/state.ts";
import { bundledToolExec, isOurLink, LINK_TAG, linkPath, userCopyOnPath } from "./resolve.ts";

export { isOurLink, LINK_TAG, linkPath };

/** The tools rt exposes on PATH by default (deps.lock's exposeByDefault still gates whether each is actually bundled). */
export const DEFAULT_EXPOSED = ["rt", "fast-browser", "gitq", "deck"] as const;

export type LinkOutcome =
  | { ok: true; path: string; state: "linked" | "already" }
  | { ok: false; reason: "no-bundle" | "user-copy" | "dev-mode-owns-rt" | "occupied"; detail: string };

export interface LinkSeams {
  /**
   * Installs the "rt" link at `dest` (atomic link-then-rename), never a bare
   * symlink. The REAL implementation (lib/dev-mode.ts's installRtBinary)
   * ignores `dest` — it resolves its own destination from real HOME, since
   * that is the one path production ever writes to. `dest` exists on this
   * seam purely so a test can inject a `p.home` other than real HOME and get
   * a seam that honors it; in production p.home is always real HOME, so the
   * two resolutions never diverge.
   */
  installRtBinary: (src: string, dest: string) => string;
}

const REAL_SEAMS: LinkSeams = { installRtBinary: (src) => installRtBinary(src) };

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

/** Single-quotes `s` for /bin/sh, escaping embedded single quotes via the standard '\'' trick — safe against $, `, \, " and everything else a relocated bundle path could contain. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function wrapperScript(tool: string, exec: string[]): string {
  const argv = exec.map(shQuote).join(" ");
  return `#!/bin/sh\n${LINK_TAG} ${tool}\nexec ${argv} "$@"\n`;
}

/** Something occupies `path` — a real file/dir, OR a symlink whose target no longer exists (dangling). readlink() reports a dangling link's target; exists() would not. */
function isPresent(p: Pick<Probes, "exists" | "readlink">, path: string): boolean {
  return p.readlink(path) !== null || p.exists(path);
}

function markForced(p: Probes, tool: string): void {
  updateSetupState(p, (s) => ({ ...s, forcedLinks: [...s.forcedLinks, tool] }));
}

function clearForced(p: Probes, tool: string): void {
  updateSetupState(p, (s) => ({ ...s, forcedLinks: s.forcedLinks.filter((t) => t !== tool) }));
}

/**
 * Expose a bundled tool at ~/.local/bin/<tool>. Refuses to shadow a
 * genuinely separate install (a copy elsewhere on PATH, or an unrelated file
 * already occupying the link path) unless `force` — a forced link is
 * remembered (SetupState.forcedLinks) so a later `reconcile()` never
 * auto-removes it just because a user copy exists; that's exactly the case
 * force was for. An our-link whose target has gone stale (dangling symlink)
 * is repaired unconditionally, force or not — it was never a genuine
 * occupant. "rt" always installs through installRtBinary (atomic
 * link-then-rename) rather than a bare symlink; the pre-existing entry is
 * left in place for the rename to replace atomically, never pre-removed.
 * "rt" is refused outright while dev mode owns the link path — force does
 * not override that; leave dev mode first.
 */
export function link(p: Probes, tool: string, opts: { force?: boolean } = {}, seams: LinkSeams = REAL_SEAMS): LinkOutcome {
  const path = linkPath(p.home, tool);

  if (tool === "rt" && isDevModeWrapper(p, path)) {
    return { ok: false, reason: "dev-mode-owns-rt", detail: `${path} is the dev-mode wrapper script; leave dev mode before linking rt` };
  }

  const exec = bundledToolExec(p, tool);
  if (!exec) return { ok: false, reason: "no-bundle", detail: `no bundled tool named "${tool}" in the app's deps.lock` };

  const present = isPresent(p, path);
  const ours = present && isOurLink(p, tool);
  const healthy = ours && p.exists(path); // exists() is false for our own link when its target has gone stale

  if (healthy) {
    if (opts.force) markForced(p, tool);
    return { ok: true, path, state: "already" };
  }

  if (!ours && !opts.force) {
    const elsewhere = userCopyOnPath(p, tool);
    if (elsewhere) return { ok: false, reason: "user-copy", detail: `${tool} is already on PATH at ${elsewhere}; pass --force to shadow it with the bundled copy` };
    if (present) return { ok: false, reason: "occupied", detail: `${path} exists and is not a mattstack-managed link; pass --force to replace it` };
  }

  if (present && tool !== "rt") p.removeFile(path);
  p.mkdirp(dirname(path)); // ~/.local/bin may not exist yet on a fresh machine — symlink()/writeFile() do not create parents

  if (exec.length === 1) {
    if (tool === "rt") seams.installRtBinary(exec[0]!, path);
    else p.symlink(exec[0]!, path);
  } else {
    p.writeFile(path, wrapperScript(tool, exec), 0o755);
  }
  if (opts.force) markForced(p, tool);
  return { ok: true, path, state: "linked" };
}

/** Removes ~/.local/bin/<tool> only if it is one of our links (symlink — including a dangling one — or tagged wrapper) — never a user's own file. Also clears any forced-link memory for `tool`. */
export function unlink(p: Probes, tool: string): { removed: boolean } {
  const path = linkPath(p.home, tool);
  if (!isPresent(p, path) || !isOurLink(p, tool)) return { removed: false };
  p.removeFile(path);
  clearForced(p, tool);
  return { removed: true };
}

/**
 * Auto-unlink: every tool with one of OUR links whose real copy has since
 * shown up elsewhere on PATH gets removed, so a tool the user installed for
 * themselves (e.g. `brew install gh`, after rt had linked the bundled one)
 * takes over cleanly instead of staying shadowed. Scans whatever actually
 * sits in ~/.local/bin rather than DEFAULT_EXPOSED — a tool can be linked
 * outside that default set (`rt deps link <tool> --force`) and still needs
 * reconciling. A tool in SetupState.forcedLinks is always kept — force is
 * the user overriding "prefer the user copy" for that tool specifically, and
 * reconcile must not silently undo that on the very next daemon boot.
 */
export function reconcile(p: Probes): { removed: string[]; kept: string[] } {
  const dir = join(p.home, ".local", "bin");
  const forced = new Set(readSetupState(p).forcedLinks);
  const defaultExposed = new Set<string>(DEFAULT_EXPOSED);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const tool of p.readDir(dir)) {
    if (!isOurLink(p, tool)) continue; // not one of ours — nothing to reconcile
    // DEFAULT_EXPOSED (rt, fast-browser, gitq, deck) is mattstack's own
    // product surface, not a vendored third-party tool like the bundled
    // "gh" — userCopyOnPath matches by name only, so a same-named PATH
    // entry is at least as likely to be an unrelated namesake (Kong's own
    // "deck") as a genuine second copy of ours, and shadow-removing our own
    // "rt" this way breaks every command. Only a vendored tool's step-aside
    // (deferring to a real system copy the user installed) is safe to
    // decide by name alone.
    if (defaultExposed.has(tool) || forced.has(tool) || !userCopyOnPath(p, tool)) {
      kept.push(tool);
    } else {
      p.removeFile(linkPath(p.home, tool));
      removed.push(tool);
    }
  }
  return { removed, kept };
}
