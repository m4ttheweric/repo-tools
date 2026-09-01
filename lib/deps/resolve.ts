/**
 * Bundled-tool resolution: where a tool actually runs from — the app
 * bundle's deps.lock, or a copy the user already has on PATH — expressed as
 * pure lookups over the Probes seam so `rt deps` and other resolvers share
 * one answer without either touching the real machine directly in tests.
 *
 * Which helpers exist comes entirely from the bundle's deps.lock via
 * lib/bundle-layout.ts; there is no separate hardcoded tool list here.
 *
 * linkPath/LINK_TAG/isOurLink live here (not lib/deps/links.ts, which owns
 * the rest of the tagged-link vocabulary) so links.ts can depend on resolve.ts
 * one-directionally — resolveTool needs isOurLink for its `linked` field, and
 * link()/unlink()/reconcile() need appBundlePath/bundledToolExec/
 * userCopyOnPath, so a links.ts -> resolve.ts -> links.ts cycle is the only
 * other option. links.ts re-exports all three under their documented name.
 */

import { join } from "path";
import { appBundleRoot, bundledExec, bundledHelperPath, RT_BUNDLE_PATH } from "../bundle-layout.ts";
import { DEV_TRAY_APP_BUNDLE, TRAY_APP_BUNDLE } from "../rt-paths.ts";
import type { Probes } from "../setup/probes.ts";

/** The app bundle rt runs from, else the installed active flavor (mattstack.appPath, /Applications, ~/Applications). */
export function appBundlePath(p: Pick<Probes, "exists" | "home">): string | null {
  return appBundleRoot(p.exists);
}

/**
 * Every bundle root a tagged link is allowed to point into: the active
 * flavor's resolved root, plus the two canonical /Applications locations for
 * BOTH flavors — so a link written while running as prod is still
 * recognized as ours after a switch to dev (or vice versa), not just the
 * flavor currently resolving. Deduped; nulls (no active bundle) dropped.
 */
function candidateBundleRoots(p: Pick<Probes, "exists" | "home">): string[] {
  const roots = [appBundlePath(p), join("/Applications", TRAY_APP_BUNDLE), join("/Applications", DEV_TRAY_APP_BUNDLE)];
  return [...new Set(roots.filter((r): r is string => r !== null))];
}

/** True when `target` resolves inside `root` — a path-prefix compare, the same shape whichever root is being checked against. */
function pointsIntoBundle(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function pointsIntoAnyBundle(target: string, roots: string[]): boolean {
  return roots.some((root) => pointsIntoBundle(target, root));
}

/** Absolute path of a bundled tool's binary/entry, only if the bundle and the file both exist. "rt" resolves through RT_BUNDLE_PATH rather than deps.lock — it is the app's own executable, not a listed helper. */
export function bundledToolPath(p: Pick<Probes, "exists" | "home">, tool: string): string | null {
  const root = appBundlePath(p);
  if (!root) return null;
  if (tool === "rt") {
    const path = join(root, RT_BUNDLE_PATH);
    return p.exists(path) ? path : null;
  }
  try {
    return bundledHelperPath(tool, root, p.exists);
  } catch {
    return null; // a `kind: "buildtool"` row (deps-dir-relative paths, e.g. sparkle) — not resolvable inside a bundle, and not exposable via `rt deps` either
  }
}

/** Absolute argv prefix that runs a bundled tool, only if every entry exists. */
export function bundledToolExec(p: Pick<Probes, "exists" | "home">, tool: string): string[] | null {
  const root = appBundlePath(p);
  if (!root) return null;
  if (tool === "rt") {
    const path = join(root, RT_BUNDLE_PATH);
    return p.exists(path) ? [path] : null;
  }
  try {
    return bundledExec(tool, root, p.exists);
  } catch {
    return null; // see bundledToolPath — buildtool rows resolve to null, never throw, for deps purposes
  }
}

/**
 * First PATH entry holding a genuine, independent copy of `tool` — not our
 * own managed slot (~/.local/bin/<tool>, whichever form it takes), not
 * anything living inside a recognized app bundle (the daemon prepends the
 * bundle's own Contents/Helpers onto PATH, which would otherwise make every
 * bundled tool look like "a user copy" of itself), and not a directory (a
 * bundled npm-style tool's own install dir, e.g. Contents/Helpers/fast-browser,
 * is a directory on disk — never something PATH-execution would run).
 */
export function userCopyOnPath(p: Pick<Probes, "exists" | "readlink" | "fileSize" | "env" | "home">, tool: string): string | null {
  const own = linkPath(p.home, tool);
  const roots = candidateBundleRoots(p);
  const dirs = (p.env.PATH ?? "").split(":").filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = join(dir, tool);
    if (candidate === own) continue;
    if (pointsIntoAnyBundle(candidate, roots)) continue; // the bundle's own copy, reached via a PATH entry the daemon itself prepended
    if (!p.exists(candidate)) continue;
    if (p.fileSize(candidate) === null) continue; // a directory (or something unreadable) is never an executable copy
    const target = p.readlink(candidate);
    if (target !== null && pointsIntoAnyBundle(target, roots)) continue; // a stray symlink into the bundle from elsewhere on PATH
    return candidate;
  }
  return null;
}

// ─── Tagged-link identity (re-exported from lib/deps/links.ts) ───────────────

/** ~/.local/bin/<tool> — where rt exposes a bundled tool on PATH. */
export function linkPath(home: string, tool: string): string {
  return join(home, ".local", "bin", tool);
}

/** Marker line identifying a tagged wrapper script as ours (second line of the file). */
export const LINK_TAG = "# mattstack-link:";

/** Wrapper scripts are tiny shell shims — anything past this size is real content this seam must never decode just to check line 2. */
const MAX_WRAPPER_BYTES = 4096;

/**
 * A link is ours iff it is a symlink whose target lies inside a recognized
 * app bundle root (active flavor, or either flavor's canonical /Applications
 * path — see candidateBundleRoots), or a small regular file whose second
 * line starts with LINK_TAG (the tagged wrapper written for multi-argv
 * tools). The symlink check works on a dangling link too — readlink()
 * reports the target even when it no longer exists, which is exactly what
 * lets a stale link (app moved, `rt update` renamed a helper) be recognized
 * as ours and repaired rather than left unrepairable.
 */
export function isOurLink(p: Pick<Probes, "readlink" | "readFile" | "exists" | "fileSize" | "home">, tool: string): boolean {
  const path = linkPath(p.home, tool);
  const target = p.readlink(path);
  if (target !== null) return pointsIntoAnyBundle(target, candidateBundleRoots(p));
  if (!p.exists(path)) return false;
  const size = p.fileSize(path);
  if (size === null || size > MAX_WRAPPER_BYTES) return false; // never decode a large/unreadable file just to check line 2
  const content = p.readFile(path) ?? "";
  return (content.split("\n")[1] ?? "").startsWith(LINK_TAG);
}

export interface ToolResolution {
  tool: string;
  /** First exec entry / path, for display. */
  bundled: string | null;
  /** Bundled exec argv prefix, else [userCopy], else null. */
  exec: string[] | null;
  userCopy: string | null;
  linked: boolean;
  /** bundled ?? userCopy. */
  chosen: string | null;
}

export function resolveTool(p: Probes, tool: string): ToolResolution {
  const exec = bundledToolExec(p, tool);
  const bundled = exec ? exec[0]! : null;
  const userCopy = userCopyOnPath(p, tool);
  const linked = isOurLink(p, tool);
  const chosen = bundled ?? userCopy;
  const resolvedExec = exec ?? (userCopy ? [userCopy] : null);

  return { tool, bundled, exec: resolvedExec, userCopy, linked, chosen };
}
