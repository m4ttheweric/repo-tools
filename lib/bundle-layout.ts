/**
 * The mattstack.app bundle layout and deps.lock schema, as rt sees them.
 * build.sh writes this layout; check-bundle.sh asserts it; rt's deps command
 * and the rt-ui binary resolver read it through here. Paths are relative to
 * the .app root unless a function says "absolute".
 */
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join } from "path";
import { currentMode } from "./dev-mode.ts";
import { DEV_TRAY_APP_BUNDLE, TRAY_APP_BUNDLE, installedTrayAppPath } from "./rt-paths.ts";

export type DepsLockArchive = "raw" | "tar.gz" | "tar.xz" | "zip" | "npm" | "go-src";
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
   * than resolve one. Never absolute or ".."-escaping either way.
   */
  bundlePath: string;
  /** Argv prefix that runs the tool, relative the same way bundlePath is. */
  exec: string[];
  exposeByDefault: boolean;
  entitlements: DepsLockEntitlements;
  status: DepsLockStatus;
  kind: DepsLockKind;
  /** m4ttstack source repo for CI-built helpers; absent for third-party pins. */
  repo?: string;
  /** App directory inside a monorepo `repo` (e.g. "apps/chat"); drives the bundle build's recipe path, version path, and app-prefixed release tags. */
  subdir?: string;
}

export interface DepsLock {
  schema: 1;
  arch: "arm64";
  tools: DepsLockTool[];
}

export const DEPS_LOCK_BUNDLE_PATH = "Contents/Resources/deps.lock";
export const HELPERS_DIR = "Contents/Helpers";
export const RT_BUNDLE_PATH = "Contents/MacOS/rt";

const ARCHIVES = new Set<DepsLockArchive>(["raw", "tar.gz", "tar.xz", "zip", "npm", "go-src"]);
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_STRING_FIELDS = ["name", "version", "license", "url", "sha256", "extract", "bundlePath"] as const;

/** True for an absolute path or one that walks up via a ".." segment — neither is a safe archive-relative path. */
function isUnsafeRelativePath(p: string): boolean {
  return isAbsolute(p) || p.split("/").includes("..");
}

export function parseDepsLock(text: string): DepsLock {
  const raw = JSON.parse(text) as DepsLock;
  if (raw.schema !== 1) throw new Error(`deps.lock: unsupported schema ${String(raw.schema)}`);
  if (raw.arch !== "arm64") throw new Error(`deps.lock: arch must be arm64, got ${String(raw.arch)}`);
  if (!Array.isArray(raw.tools)) throw new Error("deps.lock: tools must be an array");

  const seen = new Set<string>();
  raw.tools.forEach((t, i) => {
    if (typeof t !== "object" || t === null) throw new Error(`deps.lock: tools[${i}] must be an object`);
    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof (t as unknown as Record<string, unknown>)[field] !== "string") {
        throw new Error(`deps.lock: tools[${i}].${field} must be a string`);
      }
    }
    const name = t.name;
    if (!name) throw new Error(`deps.lock: tools[${i}] has no name`);
    if (seen.has(name)) throw new Error(`deps.lock: duplicate tool ${name}`);
    seen.add(name);

    if (!ARCHIVES.has(t.archive)) throw new Error(`deps.lock: ${name} has unknown archive ${String(t.archive)}`);
    if (t.kind !== "helper" && t.kind !== "buildtool") throw new Error(`deps.lock: ${name} has unknown kind`);
    if (t.status !== "bundled" && t.status !== "pending") throw new Error(`deps.lock: ${name} has unknown status`);
    if (t.entitlements !== "none" && t.entitlements !== "jit") {
      throw new Error(`deps.lock: ${name} has unknown entitlements`);
    }
    if (typeof t.exposeByDefault !== "boolean") throw new Error(`deps.lock: ${name} exposeByDefault must be boolean`);

    if (t.repo !== undefined) {
      if (typeof t.repo !== "string" || !/^m4ttstack\/[A-Za-z0-9._-]+$/.test(t.repo)) {
        throw new Error(`deps.lock: ${name} repo must be "m4ttstack/<repo>", got ${String(t.repo)}`);
      }
    }
    if (t.subdir !== undefined) {
      if (t.repo === undefined) throw new Error(`deps.lock: ${name} subdir requires a repo`);
      if (typeof t.subdir !== "string" || isUnsafeRelativePath(t.subdir)) {
        throw new Error(`deps.lock: ${name} subdir must be a relative in-repo path, got ${String(t.subdir)}`);
      }
    }

    if (isUnsafeRelativePath(t.bundlePath)) {
      throw new Error(`deps.lock: ${name} bundlePath must be relative with no ".." segments, got ${t.bundlePath}`);
    }
    if (t.kind === "helper" && !t.bundlePath.startsWith(`${HELPERS_DIR}/`)) {
      throw new Error(`deps.lock: ${name} bundlePath must live under ${HELPERS_DIR}/`);
    }

    if (!Array.isArray(t.exec) || t.exec.length === 0) throw new Error(`deps.lock: ${name} needs a non-empty exec`);
    t.exec.forEach((e, j) => {
      if (typeof e !== "string") throw new Error(`deps.lock: ${name} exec[${j}] must be a string`);
      if (isUnsafeRelativePath(e)) {
        throw new Error(`deps.lock: ${name} exec[${j}] must be relative with no ".." segments, got ${e}`);
      }
      if (t.kind === "helper" && !e.startsWith(`${HELPERS_DIR}/`)) {
        throw new Error(`deps.lock: ${name} exec[${j}] must live under ${HELPERS_DIR}/`);
      }
    });

    if (t.status === "bundled") {
      if (!t.url) throw new Error(`deps.lock: bundled tool ${name} needs a url`);
      if (!SHA256.test(t.sha256)) throw new Error(`deps.lock: bundled tool ${name} needs a 64-hex sha256`);
      if (!t.version) throw new Error(`deps.lock: bundled tool ${name} needs a version`);
    } else if (t.status === "pending" && t.url !== "") {
      throw new Error(`deps.lock: pending tool ${name} must not carry a url`);
    } else if (t.url || t.sha256) {
      throw new Error(`deps.lock: pending tool ${name} must not carry a url or sha256`);
    }

    Object.freeze(t.exec);
    Object.freeze(t);
  });
  Object.freeze(raw.tools);
  return Object.freeze(raw);
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

// Only a successful resolution is cached: a miss is one getSetting() read plus
// at most two existsSync() calls — negligible next to the rt-ui spawn this
// sits in front of — so a daemon started before the app was installed still
// picks it up on the next call instead of pinning "not installed" for its
// lifetime.
let appBundleRootMemo: string | null = null;

/**
 * The bundle rt belongs to: the one it runs from, else the installed active
 * flavor. Memoized per process on success only, and ONLY for the true
 * default (`exists === existsSync`, i.e. a zero-arg call) — this sits on the
 * rt-ui picker/prompt hot path (`lib/ui/resolve.ts`'s `bundleRoot` seam →
 * appBundleRoot() with no args, on every spawn) and that path is the memo's
 * whole reason to exist. A caller that INJECTS an `exists` (every
 * Probes-driven caller, e.g. `lib/deps/resolve.ts`'s `appBundlePath(p)` →
 * `appBundleRoot(p.exists)`) bypasses the memo entirely, both read and write:
 * those callers exist specifically so tests (and `rt deps`) can point
 * resolution at a fake bundle without touching real disk, and a shared
 * process-wide cache keyed by the FIRST such call would let one test's fake
 * bundle pin every later `appBundlePath(p)` call in the same process, real
 * callers included. Reset the default-path memo via
 * __test__.resetBundleLayoutMemo() (still needed between tests that call the
 * zero-arg form).
 */
export function appBundleRoot(exists: (p: string) => boolean = existsSync): string | null {
  const usingDefaultExists = exists === existsSync;
  if (usingDefaultExists && appBundleRootMemo) return appBundleRootMemo;
  const fromExec = bundleRootFromExec();
  let value: string | null;
  if (fromExec) {
    value = fromExec;
  } else {
    const bundle = currentMode() === "dev" ? DEV_TRAY_APP_BUNDLE : TRAY_APP_BUNDLE;
    value = installedTrayAppPath(bundle, exists);
  }
  if (usingDefaultExists && value) appBundleRootMemo = value;
  return value;
}

interface DepsLockCacheEntry {
  mtimeMs: number;
  size: number;
  lock: DepsLock | null;
}

// Keyed by root and invalidated by the lock file's mtime+size, not just root:
// `rt update` replaces the bundle (and its deps.lock) in place at the same
// path, so caching on root alone would keep serving the pre-update lock for
// the rest of the process's life.
const depsLockMemo = new Map<string, DepsLockCacheEntry>();

export function readDepsLock(root: string): DepsLock | null {
  const path = join(root, DEPS_LOCK_BUNDLE_PATH);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    depsLockMemo.delete(root);
    return null;
  }
  const cached = depsLockMemo.get(root);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.lock;

  let lock: DepsLock | null;
  try {
    lock = parseDepsLock(readFileSync(path, "utf8"));
  } catch {
    lock = null;
  }
  depsLockMemo.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, lock });
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

/**
 * Absolute path of a bundled helper's bundlePath, only if it exists on disk.
 * @throws if `name` resolves to a `kind: "buildtool"` row — its bundlePath is
 * deps-dir-relative, so there is no bundle-relative path to hand back.
 */
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

/**
 * Absolute argv prefix that runs a bundled helper, only if every exec path exists.
 * @throws if `name` resolves to a `kind: "buildtool"` row — its exec entries
 * are deps-dir-relative, so there is no bundle-relative argv to hand back.
 */
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
