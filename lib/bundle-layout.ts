/**
 * The mattstack.app bundle layout and deps.lock schema, as rt sees them.
 * build.sh writes this layout; check-bundle.sh asserts it; rt's deps command
 * and the fzf resolver read it through here. Paths are relative to the .app
 * root unless a function says "absolute".
 */
import { existsSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, join } from "path";
import { currentMode } from "./dev-mode.ts";
import { DEV_TRAY_APP_BUNDLE, TRAY_APP_BUNDLE, installedTrayAppPath } from "./rt-paths.ts";

export type DepsLockArchive = "raw" | "tar.gz" | "tar.xz" | "zip" | "npm";
export type DepsLockEntitlements = "none" | "jit";
export type DepsLockStatus = "bundled" | "pending";
export type DepsLockKind = "helper" | "buildtool";

export interface DepsLockTool {
  name: string;
  version: string;
  license: string;
  url: string;
  sha256: string;
  archive: DepsLockArchive;
  /** Path inside the archive to copy into bundlePath; "" for a raw binary. */
  extract: string;
  /**
   * Destination for the unpacked tool. For kind "helper" this is relative to
   * the .app root (always under Contents/Helpers/). For kind "buildtool"
   * (e.g. sparkle) it is relative to the deps directory instead — those
   * tools never ship inside the app — so it must never be joined against a
   * bundle root; bundledHelperPath/bundledExec refuse buildtool rows rather
   * than resolve one.
   */
  bundlePath: string;
  /** Argv prefix that runs the tool, relative the same way bundlePath is. */
  exec: string[];
  exposeByDefault: boolean;
  entitlements: DepsLockEntitlements;
  status: DepsLockStatus;
  kind: DepsLockKind;
}

export interface DepsLock {
  schema: 1;
  arch: "arm64";
  tools: DepsLockTool[];
}

export const DEPS_LOCK_BUNDLE_PATH = "Contents/Resources/deps.lock";
export const HELPERS_DIR = "Contents/Helpers";
export const RT_BUNDLE_PATH = "Contents/MacOS/rt";

const ARCHIVES = new Set<DepsLockArchive>(["raw", "tar.gz", "tar.xz", "zip", "npm"]);
const SHA256 = /^[0-9a-f]{64}$/;

export function parseDepsLock(text: string): DepsLock {
  const raw = JSON.parse(text) as DepsLock;
  if (raw.schema !== 1) throw new Error(`deps.lock: unsupported schema ${String(raw.schema)}`);
  if (raw.arch !== "arm64") throw new Error(`deps.lock: arch must be arm64, got ${String(raw.arch)}`);
  if (!Array.isArray(raw.tools)) throw new Error("deps.lock: tools must be an array");

  const seen = new Set<string>();
  for (const t of raw.tools) {
    if (!t.name) throw new Error("deps.lock: tool without a name");
    if (seen.has(t.name)) throw new Error(`deps.lock: duplicate tool ${t.name}`);
    seen.add(t.name);
    if (!ARCHIVES.has(t.archive)) throw new Error(`deps.lock: ${t.name} has unknown archive ${String(t.archive)}`);
    if (t.kind !== "helper" && t.kind !== "buildtool") throw new Error(`deps.lock: ${t.name} has unknown kind`);
    if (t.status !== "bundled" && t.status !== "pending") throw new Error(`deps.lock: ${t.name} has unknown status`);
    if (t.entitlements !== "none" && t.entitlements !== "jit") {
      throw new Error(`deps.lock: ${t.name} has unknown entitlements`);
    }
    if (typeof t.exposeByDefault !== "boolean") throw new Error(`deps.lock: ${t.name} exposeByDefault must be boolean`);
    if (!Array.isArray(t.exec) || t.exec.length === 0) throw new Error(`deps.lock: ${t.name} needs a non-empty exec`);
    if (t.kind === "helper" && !t.bundlePath.startsWith(`${HELPERS_DIR}/`)) {
      throw new Error(`deps.lock: ${t.name} bundlePath must live under ${HELPERS_DIR}/`);
    }
    if (t.status === "bundled") {
      if (!t.url) throw new Error(`deps.lock: bundled tool ${t.name} needs a url`);
      if (!SHA256.test(t.sha256)) throw new Error(`deps.lock: bundled tool ${t.name} needs a 64-hex sha256`);
      if (!t.version) throw new Error(`deps.lock: bundled tool ${t.name} needs a version`);
    } else if (t.url || t.sha256) {
      throw new Error(`deps.lock: pending tool ${t.name} must not carry a url or sha256`);
    }
  }
  return raw;
}

/** The .app root containing execPath (resolved through symlinks), or null. */
export function bundleRootFromExec(execPath: string = process.execPath): string | null {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return null;
  }
  const macos = dirname(real);
  const contents = dirname(macos);
  const root = dirname(contents);
  if (basename(macos) !== "MacOS" || basename(contents) !== "Contents") return null;
  if (!root.endsWith(".app") || !existsSync(join(contents, "Info.plist"))) return null;
  return root;
}

let appBundleRootMemo: { value: string | null } | null = null;

/**
 * The bundle rt belongs to: the one it runs from, else the installed active
 * flavor. Memoized per process — this sits on the fzf-picker hot path
 * (ensureFzf → appBundleRoot on every spawn) — so `exists` is only honoured
 * on the first call; reset via __test__.resetBundleLayoutMemo() between tests.
 */
export function appBundleRoot(exists: (p: string) => boolean = existsSync): string | null {
  if (appBundleRootMemo) return appBundleRootMemo.value;
  const fromExec = bundleRootFromExec();
  let value: string | null;
  if (fromExec) {
    value = fromExec;
  } else {
    const bundle = currentMode() === "dev" ? DEV_TRAY_APP_BUNDLE : TRAY_APP_BUNDLE;
    value = installedTrayAppPath(bundle, exists);
  }
  appBundleRootMemo = { value };
  return value;
}

const depsLockMemo = new Map<string, DepsLock | null>();

/** Memoized per root (see appBundleRoot's docblock); reset the same way. */
export function readDepsLock(root: string): DepsLock | null {
  if (depsLockMemo.has(root)) return depsLockMemo.get(root)!;
  let lock: DepsLock | null;
  try {
    lock = parseDepsLock(readFileSync(join(root, DEPS_LOCK_BUNDLE_PATH), "utf8"));
  } catch {
    lock = null;
  }
  depsLockMemo.set(root, lock);
  return lock;
}

function findBundledTool(name: string, root: string | null): { tool: DepsLockTool; root: string } | null {
  if (!root) return null;
  const lock = readDepsLock(root);
  const tool = lock?.tools.find((t) => t.name === name);
  if (!tool || tool.status !== "bundled") return null;
  return { tool, root };
}

/** A buildtool's bundlePath/exec are deps-dir-relative, not bundle-relative — never join them against a bundle root. */
function refuseBuildtool(tool: DepsLockTool): void {
  if (tool.kind === "buildtool") {
    throw new Error(
      `bundle-layout: "${tool.name}" is a buildtool dependency (deps-dir-relative paths) and cannot be resolved inside an app bundle`,
    );
  }
}

/** Absolute path of a bundled helper's bundlePath, only if it exists on disk. */
export function bundledHelperPath(
  name: string,
  root: string | null = appBundleRoot(),
  exists: (p: string) => boolean = existsSync,
): string | null {
  const found = findBundledTool(name, root);
  if (!found) return null;
  refuseBuildtool(found.tool);
  const abs = join(found.root, found.tool.bundlePath);
  return exists(abs) ? abs : null;
}

/** Absolute argv prefix that runs a bundled helper, only if every exec path exists. */
export function bundledExec(
  name: string,
  root: string | null = appBundleRoot(),
  exists: (p: string) => boolean = existsSync,
): string[] | null {
  const found = findBundledTool(name, root);
  if (!found) return null;
  refuseBuildtool(found.tool);
  const argv = found.tool.exec.map((p) => join(found.root, p));
  return argv.every(exists) ? argv : null;
}

export const __test__ = {
  resetBundleLayoutMemo(): void {
    appBundleRootMemo = null;
    depsLockMemo.clear();
  },
};
