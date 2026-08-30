/**
 * Where rt-ui runs from. Source wins over an installed bundle on purpose: in
 * dev mode the active bundle is the blessed mattstack-dev.app, which is never
 * rebuilt, so bundle-first would pin every source run to a stale helper.
 */
import { existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { appBundleRoot, bundleRootFromExec, HELPERS_DIR } from "../bundle-layout.ts";

export interface ResolveProbes {
  env: Record<string, string | undefined>;
  exists(p: string): boolean;
  /** The .app root rt runs from or is installed as, or null. */
  bundleRoot(): string | null;
  /** The repo root when running from a source checkout, else null. */
  sourceRoot(): string | null;
  which(bin: string): string | null;
}

export class RtUiMissingError extends Error {
  constructor(tried: string[]) {
    super(
      `rt-ui not found. Tried:\n${tried.map((t) => `  ${t}`).join("\n")}\n` +
        `From a source checkout run: bun run ui:build`,
    );
    this.name = "RtUiMissingError";
  }
}

function defaultSourceRoot(): string | null {
  // import.meta.dir is a real directory only when running from source; a
  // compiled binary reports a virtual path that does not exist on disk.
  const here = import.meta.dir;
  if (!here || bundleRootFromExec() !== null) return null;
  try {
    if (!statSync(here).isDirectory()) return null;
  } catch {
    return null;
  }
  return resolve(dirname(here), "..");
}

export const defaultProbes: ResolveProbes = {
  env: process.env,
  exists: existsSync,
  bundleRoot: () => appBundleRoot(),
  sourceRoot: defaultSourceRoot,
  which: (b) => Bun.which(b),
};

export function resolveRtUi(p: ResolveProbes = defaultProbes): string {
  const tried: string[] = [];
  const fromEnv = p.env.RT_UI_BIN;
  if (fromEnv) return fromEnv;

  const src = p.sourceRoot();
  if (src) {
    const candidate = join(src, "ui", "dist", "rt-ui");
    if (p.exists(candidate)) return candidate;
    tried.push(candidate);
  }

  const bundle = p.bundleRoot();
  if (bundle) {
    const candidate = join(bundle, HELPERS_DIR, "rt-ui");
    if (p.exists(candidate)) return candidate;
    tried.push(candidate);
  }

  const onPath = p.which("rt-ui");
  if (onPath) return onPath;
  tried.push("rt-ui on PATH");

  throw new RtUiMissingError(tried);
}
