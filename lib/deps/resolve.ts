/**
 * Bundled-tool resolution: where a tool actually runs from — the app
 * bundle's deps.lock, or a copy the user already has on PATH — expressed as
 * pure lookups over the Probes seam so `rt deps` and the fzf resolver share
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
import type { Probes } from "../setup/probes.ts";

/** The app bundle rt runs from, else the installed active flavor (mattstack.appPath, /Applications, ~/Applications). */
export function appBundlePath(p: Pick<Probes, "exists" | "home">): string | null {
  return appBundleRoot(p.exists);
}

/** Absolute path of a bundled tool's binary/entry, only if the bundle and the file both exist. "rt" resolves through RT_BUNDLE_PATH rather than deps.lock — it is the app's own executable, not a listed helper. */
export function bundledToolPath(p: Pick<Probes, "exists" | "home">, tool: string): string | null {
  const root = appBundlePath(p);
  if (!root) return null;
  if (tool === "rt") {
    const path = join(root, RT_BUNDLE_PATH);
    return p.exists(path) ? path : null;
  }
  return bundledHelperPath(tool, root, p.exists);
}

/** Absolute argv prefix that runs a bundled tool, only if every entry exists. */
export function bundledToolExec(p: Pick<Probes, "exists" | "home">, tool: string): string[] | null {
  const root = appBundlePath(p);
  if (!root) return null;
  if (tool === "rt") {
    const path = join(root, RT_BUNDLE_PATH);
    return p.exists(path) ? [path] : null;
  }
  return bundledExec(tool, root, p.exists);
}

/** True when `target` (a symlink readlink() result) resolves inside the given bundle root. */
function pointsIntoBundle(target: string, root: string | null): boolean {
  return root !== null && (target === root || target.startsWith(`${root}/`));
}

/**
 * First PATH entry holding an executable `tool` that is not one of our own
 * links: our managed slot (~/.local/bin/<tool>) never counts, even when it
 * holds the tagged-wrapper form this seam can't inspect (no readFile
 * access), and a stray symlink resolving into the bundle from elsewhere on
 * PATH is skipped the same way a link at the canonical slot would be.
 */
export function userCopyOnPath(p: Pick<Probes, "exists" | "readlink" | "env" | "home">, tool: string): string | null {
  const own = linkPath(p.home, tool);
  const root = appBundlePath(p);
  const dirs = (p.env.PATH ?? "").split(":").filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = join(dir, tool);
    if (candidate === own) continue;
    if (!p.exists(candidate)) continue;
    const target = p.readlink(candidate);
    if (target !== null && pointsIntoBundle(target, root)) continue;
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

/**
 * A link is ours iff it is a symlink whose target lies inside the app bundle
 * (Contents/Helpers or Contents/MacOS), or a regular file whose second line
 * starts with LINK_TAG (the tagged wrapper written for multi-argv tools).
 */
export function isOurLink(p: Pick<Probes, "readlink" | "readFile" | "exists" | "home">, tool: string): boolean {
  const path = linkPath(p.home, tool);
  const target = p.readlink(path);
  if (target !== null) return pointsIntoBundle(target, appBundlePath(p));
  if (!p.exists(path)) return false;
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
