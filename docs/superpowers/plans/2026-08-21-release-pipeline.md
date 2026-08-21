# MAT-383 L4 — Release Pipeline, Bundling, Identity Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mattstack.app *the* release: one tag on m4ttstack/rt builds rt (arm64), bundles the pinned helpers per `deps.lock`, freezes the app's identity (`Contents/MacOS/rt`, macOS 14 floor, `mattstack://`), signs inside-out, notarizes, ships a DMG + Sparkle zip + signed appcast, and proves the result in a headless clean-room job; rt stops copying binaries around and simply links into the bundle.

**Architecture:** Three layers. (1) A data contract — `rt-tray/deps.lock` + the bundle layout (`Contents/MacOS/rt`, `Contents/Helpers/<tool>`, `Contents/Resources/deps.lock`) — shared by the build, the checks, and rt at runtime (`lib/bundle-layout.ts`, which L1's `rt deps` consumes). (2) Build scripts — `rt-tray/build.sh` (swift-build today, xcodebuild when Xcode 26 lands; both converge on one assemble-and-sign path), `scripts/fetch-deps.sh`, `scripts/release/{notarize,make-zip,make-dmg,appcast}.sh`, and a rewritten `check-bundle.sh` that asserts the contract. (3) The train — `.github/workflows/release.yml` (release job + clean-room job) and the rt-side library pieces L1 consumes (`installRtBinary` symlink, `trayAppPath` via `mattstack.appPath`, `legacyUserAppPath`, `resolveFzf`), plus docs. After the cross-plan review, `rt update`, `commands/post-install.ts` (sweep + `setupApply`) and the `rt verify` rows are L1's (T30, T27/T24, T7/T11).

**Tech Stack:** bash (build/release scripts), Bun/TypeScript (rt), GitHub Actions (`macos-latest`), Sparkle 2.9.6 (`generate_appcast`, EdDSA), `codesign`/`notarytool`/`stapler`/`hdiutil`/`ditto`.

**Spec:** `docs/superpowers/specs/2026-08-20-mattstack-app-installer-design.md` (§2 rulings 6/7/8/13 + V2/V3, §7, §8, §11, §12.2 layer (a), §14) and `docs/superpowers/specs/2026-08-21-rt-setup-contract.md` (`GET /version`, `POST /update/check`). Research: `docs/superpowers/specs/research/2026-08-20-mattstack-app/research-{sparkle-install-launchd,dependency-inventory,local-inventory}.md`. On conflict, the spec wins.

**Worktree / branch:** execute in `/Users/matt/Documents/GitHub/repo-tools-l4-wt`, branch `goodwinmattheweric/mat-383-release-pipeline` off `origin/main`. Commit prefix `MAT-383:`; every commit body ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Execution order (binding; see `docs/superpowers/plans/2026-08-21-cross-plan-review.md` §3):** Phase A (parallel with L1/L3/L7, no cross-file overlap): T1, T2, T6, T7, T9-trimmed (`lib/dev-mode.ts`, `lib/rt-paths.ts` + tests only), T11-trimmed (`lib/fzf.ts`, `lib/notifier.ts` + tests), T3-trimmed (`commands/settings.ts`, `dev-mode-handoff.test.ts`, `scripts/entitlements.plist`, `build.sh` minimal, `check-bundle.sh` rewrite). Phase B: T4 and T5 AFTER L3 T1 + T2 + T10 merge (Package.swift, Sparkle, plist templates, `render-launchagents.sh` are L3's); T8 any time (green only after L7 T12 lands); T12 AFTER L1 T30 + T31 merge (`update.mdx`/docs), then L1 T31 regenerates docs on top. Phase C: T13 (entitlements), T14 (Xcode cutover, after L3 T2 `project.yml`), T15 (dry run → tag; clean-room green requires L7 T12 + L1 T27). T10 is dropped. Merge order to main: L4 Phase A → L3 T1–T11 → L1 Phase A → L4 T4/T5/T8 → L1 Phase B → L3 T12–T19 → L7 → L4 T12 → L1 T31–T32 → MATT gates.

## Global Constraints

- **Rebase onto `origin/main` before every merge.** T4/T5 start only after L3 T1/T2/T10 have merged; T12 after L1 T30/T31.
- **File ownership (cross-plan review §1):** L4 owns `rt-tray/build.sh`, `rt-tray/check-bundle.sh`, `lib/bundle-layout.ts`, `lib/rt-paths.ts`, `lib/dev-mode.ts`, `lib/fzf.ts`, `lib/notifier.ts`, `README.md`, `.github/workflows/release.yml`, `scripts/release/*`, `scripts/fetch-deps.sh`, `rt-tray/deps.lock`. L4 does **not** edit `commands/post-install.ts`, `commands/update.ts`, `commands/verify.ts`, `cli.ts` (L1), nor `rt-tray/Package.swift`, `rt-tray/Info.plist`, `rt-tray/LaunchAgent.plist`, `rt-tray/LaunchAgent-deck.plist`, `rt-tray/project.yml`, `rt-tray/scripts/render-launchagents.sh`, `rt-tray/Sources/**`, `rt-tray/Sources-daemon-shim/**` (L3). `build.sh` consumes L3's templates and render script; `check-bundle.sh` asserts what they produce.

- **Identity frozen (ruling 13):** bundle ids `com.mattstack.app` / `com.mattstack.app.dev`; daemon labels `com.mattstack.daemon` / `com.mattstack.daemon.dev` (unchanged); embedded binary is `Contents/MacOS/rt` with codesign identifier `rt` (both flavors — the dev shim is also named `rt`); product name `mattstack`; `LSMinimumSystemVersion 14.0`; `CFBundleURLTypes` for `mattstack://`; `NSUserNotificationAlertStyle` kept; no `LSFileQuarantineEnabled`.
- **arm64-only** (ruling 7). No x64 artifacts anywhere.
- **The app IS the release (ruling 7):** `mattstack-<ver>.dmg` (first install, notarized + stapled), `mattstack-<ver>.zip` (Sparkle enclosure, `ditto -c -k --sequesterRsrc --keepParent`), `appcast.xml` (EdDSA-signed in CI), deltas. The `rt-darwin-*.tar.gz` tarball is **dropped** — the zip is the headless artifact (`ditto -x -k` + `<app>/Contents/MacOS/rt --post-install`).
- **Appcast host:** GitHub Release asset, fed through the stable URL `https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml` (justification in "Decisions" below; ruled R1 in the cross-plan review — L3's Info.plist template and spec §11 carry the same URL).
- **Dependency policy (ruling 8 / §7):** BUNDLE into `Contents/Helpers/` pinned by `rt-tray/deps.lock` (name, version, url, sha256, license, bundlePath, exposeByDefault); suite uses them by absolute path; default-exposed set is `rt`, `fast-browser`, `gitq`, `deck` (V2; linking is L1's `rt deps link`). `deck`/`board`/`gitq` are `status: "pending"` until L5 publishes. tmux/zellij/terminal-notifier dropped.
- **Signing:** hardened runtime + timestamp on every Mach-O, inside-out, never `--deep`. Bun-based executables get `scripts/entitlements.plist` = `com.apple.security.cs.allow-jit` **only**; `allow-unsigned-executable-memory` is added per tool only after the measurement task shows a crash. Team ID, labels, and each helper's signing identifier stay stable across releases.
- **CFBundleVersion** is numeric and monotonic: `major*1_000_000 + minor*1_000 + patch` (2.8.0 → `2008000`); `CFBundleShortVersionString` is the semver without `v`.
- **Sparkle plist:** `SUFeedURL`, `SUPublicEDKey` (from the committed `rt-tray/SUPublicEDKey` file), `SUEnableAutomaticChecks` (prod true / dev false), `SUScheduledCheckInterval 21600`, `SUAutomaticallyUpdate true`, `SUVerifyUpdateBeforeExtraction true`; no `SUEnable*Service` keys.
- **Install on the user's machine (§11, V3):** app lives in `/Applications` (fallback `~/Applications`); `~/.local/bin/rt` is a **symlink** to `<appPath>/Contents/MacOS/rt`; dev mode overwrites it with the wrapper script; `currentMode()` reads through links; rt reads `mattstack.appPath` (machine store) first, then `/Applications`, then `~/Applications`; legacy sweep also removes a stale `~/Applications/mattstack.app` and boots out the ghost `com.rt.daemon` unconditionally. (The sweep body and the `/Volumes/`/AppTranslocation exit-2 refusal live in L1 T27/T24's `commands/post-install.ts`; L4 supplies `installRtBinary`, `legacyUserAppPath`, `bundleRootFromExec` only.)
- **Agent plist PATH (ruling R2):** `EnvironmentVariables.PATH` in both LaunchAgent plists is the **static** `/usr/bin:/bin:/usr/sbin:/sbin`; rt and deck prepend `<bundleRoot>/Contents/Helpers` (derived at runtime from their own execPath) and `$HOME/.local/bin` at process start. No `/Applications/...` path is ever written into a plist; `build.sh` does not touch `EnvironmentVariables` (the plists are rendered by L3's `rt-tray/scripts/render-launchagents.sh`); `check-bundle.sh` asserts the static value. `KeepAlive` is `{SuccessfulExit: false}` in **both** flavors (spec §8).
- **Both agent plists ship:** `Contents/Library/LaunchAgents/com.mattstack.daemon[.dev].plist` and `com.mattstack.deck[.dev].plist` (L3 T2 owns the templates + render script; `build.sh` calls the script; `check-bundle.sh` asserts both). `Contents/Helpers/deck` itself stays absent until L5 publishes — the deck plist registers as `notFound` until then, which L1's `services.register` handles by requesting the deck plist only when the helper is bundled.
- **build.sh never notarizes** (CI-only, in `scripts/release/notarize.sh`); `check-bundle.sh` keeps asserting that.
- **rt repo stealth / honesty:** rt never writes into target repos; nothing is marked ready on a guess; every tool resolution says where it found the binary.
- **Clean-code comments:** comments state constraints only; no process artifacts, task numbers, or decision history in source. Put rationale in commit bodies.
- **Verification is local:** implementers run `bun test`, `bunx tsc --noEmit`, `bash -n <script>`, and `rt-tray/check-bundle.sh` themselves. Tasks needing Xcode 26, Apple notary, GitHub secrets, or the live machine are marked **ORCHESTRATOR-ONLY / MATT**.
- **Cross-lane requirements folded in (from L7 clean room and L1):** (a) `SPARKLE_PUBLIC_ED_KEY` env overrides the committed `rt-tray/SUPublicEDKey` at build time so local/VM builds can use a throwaway key pair; (b) artifact names are fixed: `mattstack-<version>.dmg`, `mattstack-<version>.zip` (zip = Sparkle enclosure); (c) the post-release job calls `scripts/e2e-cleanroom.sh <zip>` (owned by L7; zip → `ditto -x -k` → `<app>/Contents/MacOS/rt --post-install --non-interactive --team-of-one --no-launch` → `rt verify --ci`) — this plan wires the invocation and does not write that script; (d) `--no-launch` / `--non-interactive` / `--team-of-one` are L1's flags on `rt --post-install` (today `cli.ts` ignores extra args after `--post-install`, so passing them is harmless until L1 lands); (e) nothing in the release artifacts may assume Homebrew on the target machine (L7's Tart images are vanilla).

---

## Decisions recorded by this plan

1. **Appcast on the Release, not gh-pages.** m4ttstack/rt has no Pages site and no `gh-pages` branch today (verified: both API calls 404). Putting `appcast.xml` on each Release and pointing `SUFeedURL` at `…/releases/latest/download/appcast.xml` needs no extra branch, no extra commit, no Pages enablement, and keeps feed + enclosures + deltas on one host with one set of permissions (`contents: write` already present). GitHub serves it over HTTPS with a 302 that `NSURLSession` follows. Cost: a few-second window during release creation where `latest` resolves before `appcast.xml` is attached (Sparkle just retries next interval); and a pre-release never becomes `latest` (correct). **Ruled R1 (cross-plan review):** Release asset is the host; spec §11 and L3 T2 are amended to match. gh-pages is a documented escape hatch only (Open question 1, closed).
2. **No tarball.** The clean-room job and any future headless install use the zip. `rt update`'s tarball path is deleted (by L1 T30, which owns `commands/update.ts`).
3. **xcodebuild as a *builder*, not a signer.** Nested code (rt, Helpers, LaunchAgents, vsix, deps.lock) is added after the Swift build, which would invalidate any archive/export signature, so the xcodebuild path runs `xcodebuild build … CODE_SIGNING_ALLOWED=NO` and then the same assemble-and-sign function as the swift-build path. One signing path, one bundle contract, whichever compiler produced the tray binary.
4. **Sparkle tools come from `deps.lock` too** (`kind: "buildtool"`, `Sparkle-2.9.6.tar.xz`, pinned sha256) — no third-party GitHub Action.
5. **`bun` pinned to 1.3.13** in both `deps.lock` and the CI `setup-bun` step (1.3.12 is unsignable; 1.3.13 is what Matt runs).
6. **fast-browser is bundled from its npm tarball** (`@mattstack/fast-browser@0.1.0-alpha.11`, zero runtime dependencies, MIT) as a package directory executed by the private node: `exec: ["Contents/Helpers/node/bin/node", "Contents/Helpers/fast-browser/bin/fast-browser.mjs"]`. No launcher scripts inside the bundle; L1's `rt deps link` renders the wrapper in `~/.local/bin` from `exec`.

## Bundle layout contract (the L1 ↔ L4 interface)

```
mattstack.app/Contents/
  Info.plist                              identity + Sparkle keys (build.sh is the only writer of identity values)
  MacOS/mattstack                         tray executable (CFBundleExecutable)
  MacOS/rt                                the rt binary (prod) / the dev source-runner shim (dev); codesign identifier "rt"
  Frameworks/Sparkle.framework
  Helpers/fzf  Helpers/jq  Helpers/gh  Helpers/glab  Helpers/bun      single Mach-O files
  Helpers/node/                           node dist (bin/node, lib/node_modules/npm, …)
  Helpers/fast-browser/                   npm package contents (bin/fast-browser.mjs, …)
  Helpers/deck  Helpers/board  Helpers/gitq                           ABSENT until L5 publishes (deps.lock status "pending")
  Library/LaunchAgents/com.mattstack.daemon[.dev].plist                BundleProgram Contents/MacOS/rt   (rendered by L3's render-launchagents.sh)
  Library/LaunchAgents/com.mattstack.deck[.dev].plist                  BundleProgram Contents/Helpers/deck (same script; deck helper absent until L5)
  Helpers/mattstack-proxy-install                                       ABSENT until L5 (deps.lock status "pending"; L3 T8's privileged helper)
  Resources/deps.lock                     byte-identical copy of rt-tray/deps.lock
  Resources/rt-context.vsix               the editor extension
  Resources/AppIcon.icns, *.caf, mission-control-screenshot.png
```

`lib/bundle-layout.ts` (Task 1) exposes this to rt: `bundleRootFromExec()`, `appBundleRoot()`, `readDepsLock(root)`, `bundledHelperPath(name, root)`, `bundledExec(name, root)`. L1's `rt deps resolve|link` builds on these; nothing in L4 shells out to `rt deps`.

---

### Task 1: `lib/bundle-layout.ts` — the layout + deps.lock contract in TypeScript

**Files:**
- Create: `lib/bundle-layout.ts`
- Create: `lib/__tests__/bundle-layout.test.ts`

**Interfaces:**
- Consumes: `installedTrayAppPath`, `TRAY_APP_BUNDLE`, `DEV_TRAY_APP_BUNDLE` from `lib/rt-paths.ts`; `currentMode` from `lib/dev-mode.ts`.
- Produces (used by Tasks 2, 10, 11, 12 and by L1):
  - `type DepsLockTool = { name; version; license; url; sha256; archive: "raw"|"tar.gz"|"tar.xz"|"zip"|"npm"; extract: string; bundlePath: string; exec: string[]; exposeByDefault: boolean; entitlements: "none"|"jit"; status: "bundled"|"pending"; kind: "helper"|"buildtool" }`
  - `type DepsLock = { schema: 1; arch: "arm64"; tools: DepsLockTool[] }`
  - `const DEPS_LOCK_BUNDLE_PATH = "Contents/Resources/deps.lock"`, `const HELPERS_DIR = "Contents/Helpers"`, `const RT_BUNDLE_PATH = "Contents/MacOS/rt"`
  - `parseDepsLock(text: string): DepsLock` (throws on schema violations)
  - `bundleRootFromExec(execPath?: string): string | null`
  - `appBundleRoot(exists?: (p: string) => boolean): string | null`
  - `readDepsLock(root: string): DepsLock | null`
  - `bundledHelperPath(name: string, root?: string | null, exists?): string | null`
  - `bundledExec(name: string, root?: string | null, exists?): string[] | null`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/bundle-layout.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  bundleRootFromExec, bundledExec, bundledHelperPath, parseDepsLock, readDepsLock,
  DEPS_LOCK_BUNDLE_PATH,
} from "../bundle-layout.ts";

const LOCK = {
  schema: 1,
  arch: "arm64",
  tools: [
    { name: "fzf", version: "0.74.3", license: "MIT", url: "https://x/fzf.tar.gz", sha256: "a".repeat(64),
      archive: "tar.gz", extract: "fzf", bundlePath: "Contents/Helpers/fzf", exec: ["Contents/Helpers/fzf"],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper" },
    { name: "fast-browser", version: "0.1.0-alpha.11", license: "MIT", url: "https://x/fb.tgz", sha256: "b".repeat(64),
      archive: "npm", extract: "package", bundlePath: "Contents/Helpers/fast-browser",
      exec: ["Contents/Helpers/node/bin/node", "Contents/Helpers/fast-browser/bin/fast-browser.mjs"],
      exposeByDefault: true, entitlements: "none", status: "bundled", kind: "helper" },
    { name: "deck", version: "", license: "MIT", url: "", sha256: "", archive: "raw", extract: "",
      bundlePath: "Contents/Helpers/deck", exec: ["Contents/Helpers/deck"],
      exposeByDefault: true, entitlements: "jit", status: "pending", kind: "helper" },
  ],
};

function fakeApp(): string {
  const root = join(mkdtempSync(join(tmpdir(), "rt-bundle-")), "mattstack.app");
  mkdirSync(join(root, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(root, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(root, "Contents", "Helpers"), { recursive: true });
  writeFileSync(join(root, "Contents", "Info.plist"), "<plist/>");
  writeFileSync(join(root, "Contents", "MacOS", "rt"), "");
  writeFileSync(join(root, DEPS_LOCK_BUNDLE_PATH), JSON.stringify(LOCK));
  writeFileSync(join(root, "Contents", "Helpers", "fzf"), "");
  return root;
}

describe("parseDepsLock", () => {
  test("accepts the schema and keeps tool order", () => {
    const lock = parseDepsLock(JSON.stringify(LOCK));
    expect(lock.tools.map((t) => t.name)).toEqual(["fzf", "fast-browser", "deck"]);
  });
  test("rejects duplicate names, bundled tools without url/sha256, and pending tools with a url", () => {
    const dup = { ...LOCK, tools: [LOCK.tools[0], LOCK.tools[0]] };
    expect(() => parseDepsLock(JSON.stringify(dup))).toThrow(/duplicate/);
    const noSha = { ...LOCK, tools: [{ ...LOCK.tools[0], sha256: "" }] };
    expect(() => parseDepsLock(JSON.stringify(noSha))).toThrow(/sha256/);
    const pendingUrl = { ...LOCK, tools: [{ ...LOCK.tools[2], url: "https://x" }] };
    expect(() => parseDepsLock(JSON.stringify(pendingUrl))).toThrow(/pending/);
  });
  test("rejects a bundlePath outside Contents/Helpers for helpers", () => {
    const bad = { ...LOCK, tools: [{ ...LOCK.tools[0], bundlePath: "Contents/MacOS/fzf" }] };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/Contents\/Helpers/);
  });
});

describe("bundleRootFromExec", () => {
  test("finds the .app root from Contents/MacOS/<bin>", () => {
    const root = fakeApp();
    expect(bundleRootFromExec(join(root, "Contents", "MacOS", "rt"))).toBe(root);
  });
  test("null for a binary that is not inside a bundle", () => {
    expect(bundleRootFromExec("/usr/bin/true")).toBeNull();
  });
});

describe("bundledHelperPath / bundledExec", () => {
  test("resolve a bundled helper to its absolute path", () => {
    const root = fakeApp();
    expect(bundledHelperPath("fzf", root)).toBe(join(root, "Contents", "Helpers", "fzf"));
    expect(bundledExec("fzf", root)).toEqual([join(root, "Contents", "Helpers", "fzf")]);
  });
  test("null for a pending tool, an unknown tool, and a bundled tool whose file is missing", () => {
    const root = fakeApp();
    expect(bundledHelperPath("deck", root)).toBeNull();
    expect(bundledHelperPath("nope", root)).toBeNull();
    expect(bundledHelperPath("fast-browser", root)).toBeNull();
  });
  test("null when there is no bundle root", () => {
    expect(bundledHelperPath("fzf", null)).toBeNull();
    expect(readDepsLock("/nonexistent.app")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/__tests__/bundle-layout.test.ts`
Expected: FAIL — `Cannot find module '../bundle-layout.ts'`.

- [ ] **Step 3: Implement**

```ts
// lib/bundle-layout.ts
/**
 * The mattstack.app bundle layout and deps.lock schema, as rt sees them.
 * build.sh writes this layout; check-bundle.sh asserts it; `rt deps` (L1)
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
  /** Bundle-relative destination (file or directory). */
  bundlePath: string;
  /** Bundle-relative argv prefix that runs the tool. */
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
    if (t.entitlements !== "none" && t.entitlements !== "jit") throw new Error(`deps.lock: ${t.name} has unknown entitlements`);
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
  try { real = realpathSync(execPath); } catch { return null; }
  const macos = dirname(real);
  const contents = dirname(macos);
  const root = dirname(contents);
  if (basename(macos) !== "MacOS" || basename(contents) !== "Contents") return null;
  if (!root.endsWith(".app") || !existsSync(join(contents, "Info.plist"))) return null;
  return root;
}

/** The bundle rt belongs to: the one it runs from, else the installed active flavor. */
export function appBundleRoot(exists: (p: string) => boolean = existsSync): string | null {
  const fromExec = bundleRootFromExec();
  if (fromExec) return fromExec;
  const bundle = currentMode() === "dev" ? DEV_TRAY_APP_BUNDLE : TRAY_APP_BUNDLE;
  return installedTrayAppPath(bundle, exists);
}

export function readDepsLock(root: string): DepsLock | null {
  try {
    return parseDepsLock(readFileSync(join(root, DEPS_LOCK_BUNDLE_PATH), "utf8"));
  } catch {
    return null;
  }
}

function bundledTool(name: string, root: string | null): { tool: DepsLockTool; root: string } | null {
  if (!root) return null;
  const lock = readDepsLock(root);
  const tool = lock?.tools.find((t) => t.name === name);
  if (!tool || tool.status !== "bundled") return null;
  return { tool, root };
}

/** Absolute path of a bundled helper's bundlePath, only if it exists on disk. */
export function bundledHelperPath(
  name: string,
  root: string | null = appBundleRoot(),
  exists: (p: string) => boolean = existsSync,
): string | null {
  const found = bundledTool(name, root);
  if (!found) return null;
  const abs = join(found.root, found.tool.bundlePath);
  return exists(abs) ? abs : null;
}

/** Absolute argv prefix that runs a bundled helper, only if every exec path exists. */
export function bundledExec(
  name: string,
  root: string | null = appBundleRoot(),
  exists: (p: string) => boolean = existsSync,
): string[] | null {
  const found = bundledTool(name, root);
  if (!found) return null;
  const argv = found.tool.exec.map((p) => join(found.root, p));
  return argv.every(exists) ? argv : null;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test lib/__tests__/bundle-layout.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/bundle-layout.ts lib/__tests__/bundle-layout.test.ts
git commit -m "MAT-383: lib/bundle-layout — deps.lock schema + bundle paths as rt sees them

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `rt-tray/deps.lock` + `scripts/fetch-deps.sh` + `scripts/lib/deps-lock.ts`

**Files:**
- Create: `rt-tray/deps.lock`
- Create: `scripts/lib/deps-lock.ts` (TSV emitter for bash consumers)
- Create: `scripts/fetch-deps.sh`
- Modify: `.gitignore` (add `rt-tray/deps/`, `rt-tray/out/`, `rt-tray/.build-xcode/` — `rt-tray/*.xcodeproj/` is L3 T1's line; do not add it here)
- Create: `lib/__tests__/deps-lock-file.test.ts`

**Interfaces:**
- Consumes: `parseDepsLock` from Task 1.
- Produces: `rt-tray/deps/arm64/<name>` (file) or `rt-tray/deps/arm64/<name>/` (dir) per bundled helper; `rt-tray/deps/tools/sparkle/bin/{generate_appcast,sign_update,generate_keys}`; `bun scripts/lib/deps-lock.ts [--kind helper|buildtool] [--status bundled|pending]` prints TSV rows `name\tversion\turl\tsha256\tarchive\textract\tbundlePath\tentitlements\tstatus\tkind\texposeByDefault`. `scripts/fetch-deps.sh [arm64]` exit 0 with everything present and verified; `scripts/fetch-deps.sh --lock` fills empty `sha256` fields from fresh downloads and rewrites the lock (only for adding tools later).

- [ ] **Step 1: Write the lock**

```json
{
  "schema": 1,
  "arch": "arm64",
  "tools": [
    { "name": "fzf", "version": "0.74.3", "license": "MIT",
      "url": "https://github.com/junegunn/fzf/releases/download/v0.74.3/fzf-0.74.3-darwin_arm64.tar.gz",
      "sha256": "1f8501cea4f9c0c2d6110d0ff75d0ec9451cd9d7524d9a26244a154ea89f3bd5",
      "archive": "tar.gz", "extract": "fzf", "bundlePath": "Contents/Helpers/fzf", "exec": ["Contents/Helpers/fzf"],
      "exposeByDefault": false, "entitlements": "none", "status": "bundled", "kind": "helper" },
    { "name": "jq", "version": "1.8.2", "license": "MIT",
      "url": "https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-macos-arm64",
      "sha256": "2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/jq", "exec": ["Contents/Helpers/jq"],
      "exposeByDefault": false, "entitlements": "none", "status": "bundled", "kind": "helper" },
    { "name": "gh", "version": "2.98.0", "license": "MIT",
      "url": "https://github.com/cli/cli/releases/download/v2.98.0/gh_2.98.0_macOS_arm64.zip",
      "sha256": "8cfb027cc5310675f2b830eac8f9865c1155a45ffcf9757f699fdd5a22046ca4",
      "archive": "zip", "extract": "gh_2.98.0_macOS_arm64/bin/gh", "bundlePath": "Contents/Helpers/gh", "exec": ["Contents/Helpers/gh"],
      "exposeByDefault": false, "entitlements": "none", "status": "bundled", "kind": "helper" },
    { "name": "glab", "version": "1.114.0", "license": "MIT",
      "url": "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/1.114.0/glab_1.114.0_darwin_arm64.tar.gz",
      "sha256": "d60d76cc0176cd7e7efe9c9fae0e57979048dad78fdd24903ba986ded1c82a01",
      "archive": "tar.gz", "extract": "bin/glab", "bundlePath": "Contents/Helpers/glab", "exec": ["Contents/Helpers/glab"],
      "exposeByDefault": false, "entitlements": "none", "status": "bundled", "kind": "helper" },
    { "name": "bun", "version": "1.3.13", "license": "MIT",
      "url": "https://github.com/oven-sh/bun/releases/download/bun-v1.3.13/bun-darwin-aarch64.zip",
      "sha256": "5467e3f65dba526b9fea98f0cce04efafc0c63e169733ec27b876a3ad32da190",
      "archive": "zip", "extract": "bun-darwin-aarch64/bun", "bundlePath": "Contents/Helpers/bun", "exec": ["Contents/Helpers/bun"],
      "exposeByDefault": false, "entitlements": "jit", "status": "bundled", "kind": "helper" },
    { "name": "node", "version": "24.19.0", "license": "MIT",
      "url": "https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz",
      "sha256": "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
      "archive": "tar.gz", "extract": "node-v24.19.0-darwin-arm64", "bundlePath": "Contents/Helpers/node", "exec": ["Contents/Helpers/node/bin/node"],
      "exposeByDefault": false, "entitlements": "jit", "status": "bundled", "kind": "helper" },
    { "name": "fast-browser", "version": "0.1.0-alpha.11", "license": "MIT",
      "url": "https://registry.npmjs.org/@mattstack/fast-browser/-/fast-browser-0.1.0-alpha.11.tgz",
      "sha256": "43d0faf99e78d0a4ac5a72fcb201557ddb1fa1fe1180bb0e01a1e6df0286b728",
      "archive": "npm", "extract": "package", "bundlePath": "Contents/Helpers/fast-browser",
      "exec": ["Contents/Helpers/node/bin/node", "Contents/Helpers/fast-browser/bin/fast-browser.mjs"],
      "exposeByDefault": true, "entitlements": "none", "status": "bundled", "kind": "helper" },
    { "name": "deck", "version": "", "license": "MIT", "url": "", "sha256": "",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/deck", "exec": ["Contents/Helpers/deck"],
      "exposeByDefault": true, "entitlements": "jit", "status": "pending", "kind": "helper" },
    { "name": "board", "version": "", "license": "MIT", "url": "", "sha256": "",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/board", "exec": ["Contents/Helpers/board"],
      "exposeByDefault": false, "entitlements": "jit", "status": "pending", "kind": "helper" },
    { "name": "gitq", "version": "", "license": "MIT", "url": "", "sha256": "",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/gitq", "exec": ["Contents/Helpers/gitq"],
      "exposeByDefault": true, "entitlements": "jit", "status": "pending", "kind": "helper" },
    { "name": "mattstack-proxy-install", "version": "", "license": "MIT", "url": "", "sha256": "",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/mattstack-proxy-install", "exec": ["Contents/Helpers/mattstack-proxy-install"],
      "exposeByDefault": false, "entitlements": "none", "status": "pending", "kind": "helper" },
    { "name": "sparkle", "version": "2.9.6", "license": "MIT",
      "url": "https://github.com/sparkle-project/Sparkle/releases/download/2.9.6/Sparkle-2.9.6.tar.xz",
      "sha256": "52bf9e88cdd972fc0c81501377a880e90d47031bd8ca5462488f843e2609e192",
      "archive": "tar.xz", "extract": "", "bundlePath": "tools/sparkle", "exec": ["tools/sparkle/bin/generate_appcast"],
      "exposeByDefault": false, "entitlements": "none", "status": "bundled", "kind": "buildtool" }
  ]
}
```

(The sha256 values above were computed on 2026-08-21 from the exact URLs; `fetch-deps.sh` re-verifies every download.)

`mattstack-proxy-install` is the privileged proxy helper L3 T8 execs from `Contents/Helpers/` (cross-plan review §2 #28). Nobody builds it in this program — it ships with L5. The `pending` row makes `check-bundle.sh` tolerate its absence and lets L3 report "helper not bundled" honestly; record it in L5's handoff.

- [ ] **Step 2: Write the failing lock-file test**

```ts
// lib/__tests__/deps-lock-file.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../bundle-layout.ts";

const LOCK_PATH = join(import.meta.dir, "..", "..", "rt-tray", "deps.lock");

describe("rt-tray/deps.lock", () => {
  const lock = parseDepsLock(readFileSync(LOCK_PATH, "utf8"));

  test("parses under the schema", () => {
    expect(lock.schema).toBe(1);
    expect(lock.arch).toBe("arm64");
  });
  test("carries the ruling-8 bundle set, with deck/board/gitq pending until L5", () => {
    const by = Object.fromEntries(lock.tools.map((t) => [t.name, t]));
    for (const n of ["fzf", "jq", "gh", "glab", "bun", "node", "fast-browser"]) expect(by[n]?.status).toBe("bundled");
    for (const n of ["deck", "board", "gitq", "mattstack-proxy-install"]) expect(by[n]?.status).toBe("pending");
    expect(by["sparkle"]?.kind).toBe("buildtool");
  });
  test("default-exposed set is exactly fast-browser, gitq, deck (rt is exposed by the binary link, not a helper)", () => {
    const exposed = lock.tools.filter((t) => t.exposeByDefault).map((t) => t.name).sort();
    expect(exposed).toEqual(["deck", "fast-browser", "gitq"]);
  });
  test("bun-based helpers declare jit entitlements; Go/C helpers declare none", () => {
    const by = Object.fromEntries(lock.tools.map((t) => [t.name, t]));
    expect(by["bun"].entitlements).toBe("jit");
    expect(by["node"].entitlements).toBe("jit");
    for (const n of ["fzf", "jq", "gh", "glab"]) expect(by[n].entitlements).toBe("none");
  });
});
```

Run: `bun test lib/__tests__/deps-lock-file.test.ts` → FAIL (file missing) until Step 1's JSON is saved at `rt-tray/deps.lock`; then PASS.

- [ ] **Step 3: TSV emitter for bash**

```ts
// scripts/lib/deps-lock.ts
// Prints rt-tray/deps.lock as TSV so build.sh / fetch-deps.sh / check-bundle.sh
// never parse JSON in bash. Usage: bun scripts/lib/deps-lock.ts [--kind K] [--status S]
import { readFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../../lib/bundle-layout.ts";

const args = process.argv.slice(2);
const opt = (flag: string): string | null => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] ?? null : null; };
const kind = opt("--kind");
const status = opt("--status");

const lock = parseDepsLock(readFileSync(join(import.meta.dir, "..", "..", "rt-tray", "deps.lock"), "utf8"));
for (const t of lock.tools) {
  if (kind && t.kind !== kind) continue;
  if (status && t.status !== status) continue;
  console.log([t.name, t.version, t.url, t.sha256, t.archive, t.extract, t.bundlePath, t.entitlements, t.status, t.kind, String(t.exposeByDefault)].join("\t"));
}
```

Run: `bun scripts/lib/deps-lock.ts --kind helper --status bundled | wc -l` → `7`.

- [ ] **Step 4: fetch-deps.sh**

```bash
#!/bin/bash
# scripts/fetch-deps.sh [arm64] [--lock]
# Downloads every bundled tool in rt-tray/deps.lock, verifies sha256, and
# unpacks it into rt-tray/deps/<arch>/<name> (helpers) or
# rt-tray/deps/tools/<name> (build tools). --lock fills EMPTY sha256 fields
# from the downloads and rewrites deps.lock (for adding a tool); it never
# overwrites a non-empty hash.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="arm64"
WRITE_LOCK=false
for a in "$@"; do
  case "$a" in
    arm64) ARCH=arm64 ;;
    --lock) WRITE_LOCK=true ;;
    *) echo "usage: $0 [arm64] [--lock]" >&2; exit 2 ;;
  esac
done

LOCK="$ROOT/rt-tray/deps.lock"
DEPS="$ROOT/rt-tray/deps/$ARCH"
TOOLS="$ROOT/rt-tray/deps/tools"
CACHE="${RT_DEPS_CACHE:-$HOME/Library/Caches/mattstack-deps}"
mkdir -p "$DEPS" "$TOOLS" "$CACHE"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

fetch() { # url sha → prints cached path
  local url="$1" want="$2" name dest
  name="$(basename "$url")"
  dest="$CACHE/${want:-nohash}-$name"
  if [ ! -f "$dest" ]; then
    curl -fsSL --retry 3 -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
  if [ -n "$want" ] && [ "$(sha "$dest")" != "$want" ]; then
    echo "  ✗ sha256 mismatch for $name (want $want, got $(sha "$dest"))" >&2
    rm -f "$dest"; exit 1
  fi
  echo "$dest"
}

unpack() { # archive-file archive-kind extract-path dest
  local file="$1" kind="$2" extract="$3" dest="$4" tmp
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  case "$kind" in
    raw) cp "$file" "$dest"; chmod 755 "$dest" ;;
    tar.gz|tar.xz|npm)
      tmp="$(mktemp -d)"
      tar -xf "$file" -C "$tmp"
      if [ -n "$extract" ]; then cp -R "$tmp/$extract" "$dest"; else cp -R "$tmp" "$dest"; fi
      rm -rf "$tmp" ;;
    zip)
      tmp="$(mktemp -d)"
      ditto -x -k "$file" "$tmp"
      cp -R "$tmp/$extract" "$dest"
      rm -rf "$tmp" ;;
    *) echo "  ✗ unknown archive kind $kind" >&2; exit 1 ;;
  esac
  [ -d "$dest" ] || chmod 755 "$dest"
}

NEW_HASHES=()
while IFS=$'\t' read -r name version url sha archive extract bundlePath ent status kind expose; do
  [ "$status" = "bundled" ] || { echo "  · $name: pending (not bundled in this build)"; continue; }
  if [ "$kind" = "buildtool" ]; then dest="$TOOLS/$name"; else dest="$DEPS/$name"; fi
  if [ -z "$sha" ]; then
    $WRITE_LOCK || { echo "  ✗ $name has no sha256 in deps.lock — run $0 --lock" >&2; exit 1; }
    file="$(fetch "$url" "")"
    sha="$(sha "$file")"
    NEW_HASHES+=("$name=$sha")
  else
    file="$(fetch "$url" "$sha")"
  fi
  unpack "$file" "$archive" "$extract" "$dest"
  echo "  ✓ $name $version → ${dest#$ROOT/}"
done < <(bun "$ROOT/scripts/lib/deps-lock.ts")

if $WRITE_LOCK && [ ${#NEW_HASHES[@]} -gt 0 ]; then
  for kv in "${NEW_HASHES[@]}"; do
    n="${kv%%=*}"; h="${kv#*=}"
    bun -e '
      const [path, name, hash] = Bun.argv.slice(2);
      const lock = JSON.parse(await Bun.file(path).text());
      const t = lock.tools.find((x) => x.name === name); t.sha256 = hash;
      await Bun.write(path, JSON.stringify(lock, null, 2) + "\n");
    ' "$LOCK" "$n" "$h"
    echo "  ✓ wrote sha256 for $n into deps.lock"
  done
fi

# Sparkle's tools are an xz tarball with bin/ at its root; --help proves they run.
[ -x "$TOOLS/sparkle/bin/generate_appcast" ] && "$TOOLS/sparkle/bin/generate_appcast" --help >/dev/null 2>&1 \
  && echo "  ✓ sparkle tools runnable"
echo "  Done."
```

Run: `bash -n scripts/fetch-deps.sh && chmod +x scripts/fetch-deps.sh && scripts/fetch-deps.sh arm64`
Expected: seven `✓` helper lines + `sparkle`, `rt-tray/deps/arm64/{fzf,jq,gh,glab,bun,node/,fast-browser/}` present, `rt-tray/deps/tools/sparkle/bin/generate_appcast` runnable, `file rt-tray/deps/arm64/fzf` says Mach-O arm64. Then `rt-tray/deps/arm64/fzf --version`, `rt-tray/deps/arm64/jq --version`, `rt-tray/deps/arm64/gh --version`, `rt-tray/deps/arm64/glab --version`, `rt-tray/deps/arm64/bun --version` (prints 1.3.13), `rt-tray/deps/arm64/node/bin/node --version` (v24.19.0), `rt-tray/deps/arm64/node/bin/node rt-tray/deps/arm64/fast-browser/bin/fast-browser.mjs --help` exits 0.

- [ ] **Step 5: .gitignore**

Append to `.gitignore`:
```
rt-tray/deps/
rt-tray/out/
rt-tray/.build-xcode/
```
(`rt-tray/*.xcodeproj/` is added by L3 T1 — L3's `project.yml` regenerates the project; cross-plan review §1 row 8. Rebase-after if L3 merged first; the three lines above are disjoint.)

- [ ] **Step 6: Commit**

```bash
git add rt-tray/deps.lock scripts/lib/deps-lock.ts scripts/fetch-deps.sh .gitignore lib/__tests__/deps-lock-file.test.ts
git commit -m "MAT-383: deps.lock + fetch-deps.sh — pinned, sha256-verified helpers for the bundle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Identity freeze — `rt-daemon` → `rt`, plist keys, numeric build, jit-only entitlements

**Trimmed by the cross-plan review (§1 rows 12, 15, 16, 18, 19):** the plist templates, `Package.swift`, and every Swift file are L3's. This task keeps only the rt-side edits, the minimal `build.sh` edits, and the `check-bundle.sh` rewrite.

**Files:**
- ~~Modify: `rt-tray/LaunchAgent.plist`~~ — Dropped — owned by L3 T2 (cross-plan review); L3 T2 applies the `BundleProgram Contents/MacOS/rt` / `ProgramArguments` / Label-comment edit in its template.
- ~~Modify: `rt-tray/Info.plist`~~ — Dropped — owned by L3 T2 (cross-plan review); `CFBundleURLName` is `@@BUNDLE_ID@@.join` (L3's value; L4's `.url` is withdrawn).
- ~~Modify: `rt-tray/Package.swift`~~ — Dropped — owned by L3 T1 (cross-plan review); L3 T1 sets `.macOS(.v14)`.
- Modify: `rt-tray/build.sh` (embed as `Contents/MacOS/rt`, sign `-i rt`, numeric CFBundleVersion; full rewrite lands in Task 4 — this task makes the minimal edits listed here)
- ~~Modify: `rt-tray/Sources/AppDelegate.swift:331`, `rt-tray/Sources/UpdateChecker.swift:164`, `rt-tray/Sources/DaemonLifecycle.swift:8`, `rt-tray/Sources-daemon-shim/main.swift:4,26`~~ — Dropped — owned by L3 T18 (`AppDelegate.swift`, `DaemonLifecycle.swift`, `Sources-daemon-shim/main.swift` string/comment edits) and L3 T10 (`UpdateChecker.swift` is deleted) (cross-plan review).
- Modify: `commands/settings.ts:462-471` (`disableDevMode` reads `Contents/MacOS/rt`)
- Modify: `lib/__tests__/dev-mode-handoff.test.ts:185-188`
- Modify: `scripts/entitlements.plist` (allow-jit only)
- Modify: `rt-tray/check-bundle.sh` (full rewrite, below)

**Interfaces:**
- Produces: identifier `rt` on the embedded binary; `numeric_build()` bash function in build.sh (`2.8.0 → 2008000`); `scripts/entitlements.plist` = jit only; `check-bundle.sh` exit 0 = contract holds. The bundle path `Contents/MacOS/rt` itself is produced by L3 T2's templates + L3 T18's Swift edits; this task's check-bundle asserts it.
- Consumes: nothing from earlier tasks (Helpers/Sparkle assertions are added by Tasks 4–5). The check-bundle Swift-source gates (Step 5, last section) are explicit requirements on L3 T9 (`TrayServer` keeps the literal `path == "/flavor/retire"`) and L3 T18 (`forInfoDictionaryKey: "MSDaemonLabel"`, `defaultDaemonLabel = "com.mattstack.daemon"`, socket guard before `AppDelegate()` in `main.swift`, `UpdatePolicy.shouldStartUpdater(isDevBuild: isDevBuild` in `Sources/Updates/UpdaterController.swift`, the string `update check skipped (dev build)`).

- [ ] **Step 1: Plists + Package.swift**

Dropped — owned by L3 T2 (templates: `BundleProgram Contents/MacOS/rt`, `ProgramArguments [Contents/MacOS/rt, --daemon]`, Label comment, `LSMinimumSystemVersion 14.0`, `CFBundleURLTypes` with `CFBundleURLName @@BUNDLE_ID@@.join`) and L3 T1 (`Package.swift` `.macOS(.v14)`) (cross-plan review §1 rows 12, 15, 16).

- [ ] **Step 2: Swift + TS references**

Swift edits dropped — owned by L3 T18 (`AppDelegate.swift:331` → `Bundle.main.bundlePath + "/Contents/MacOS/rt"`; `DaemonLifecycle.swift:8,17-18`; `Sources-daemon-shim/main.swift:4,26`) and L3 T10 (`UpdateChecker.swift` deleted) (cross-plan review §1 rows 18, 19). TS edits stay:

- `commands/settings.ts` docblock line 462: `…carries at Contents/MacOS/rt`; line 471: `const prodBinary = join(prodAppPath, "Contents", "MacOS", "rt");`
- `lib/__tests__/dev-mode-handoff.test.ts:185-188`: replace `"rt-daemon"` with `"rt"` in both the comment and the `writeFileSync` path.

- [ ] **Step 3: Entitlements**

`scripts/entitlements.plist` becomes:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- JavaScriptCore / V8 JIT under the hardened runtime. Add
       com.apple.security.cs.allow-unsigned-executable-memory for a specific
       tool only if that signed tool crashes at launch (see deps.lock). -->
  <key>com.apple.security.cs.allow-jit</key><true/>
</dict>
</plist>
```
Sanity: `bun build --compile ./cli.ts --outfile /tmp/rt-jit && codesign --force --sign - --entitlements scripts/entitlements.plist /tmp/rt-jit && /tmp/rt-jit --version` prints the version (ad-hoc + jit-only runs; the Developer-ID measurement is Task 14).

- [ ] **Step 4: build.sh minimal edits (pre-rewrite)**

In `rt-tray/build.sh`: every `Contents/MacOS/rt-daemon` → `Contents/MacOS/rt`; `DAEMON_BIN="$APP_BUNDLE/Contents/MacOS/rt"`; both codesign calls on it use `-i rt`; replace the version block (lines 244-250) with:
```bash
numeric_build() {
    local v="${1#v}"
    if [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
        echo $(( BASH_REMATCH[1] * 1000000 + BASH_REMATCH[2] * 1000 + BASH_REMATCH[3] ))
    else
        echo 0
    fi
}
RT_VERSION=$(cd "$SCRIPT_DIR/.." && git describe --tags --abbrev=0 2>/dev/null || echo "dev")
RT_VERSION="${RT_VERSION#v}"
if [ "$RT_VERSION" != "dev" ]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $RT_VERSION" "$APP_BUNDLE/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(numeric_build "$RT_VERSION")" "$APP_BUNDLE/Contents/Info.plist"
    echo "  ✓ Version set to $RT_VERSION (build $(numeric_build "$RT_VERSION"))"
fi
```
`RT_VERSION` may also be passed in by CI as `RT_VERSION=v2.8.0 rt-tray/build.sh release` — change the first line to `RT_VERSION="${RT_VERSION:-$(cd "$SCRIPT_DIR/.." && git describe --tags --abbrev=0 2>/dev/null || echo dev)}"`.

- [ ] **Step 5: Rewrite `rt-tray/check-bundle.sh`**

```bash
#!/bin/bash
# rt-tray/check-bundle.sh — asserts the mattstack.app bundle contract for BOTH
# flavors. Builds them via build.sh (no notarization; that is CI-only), then
# checks identity, layout, signing, Helpers, Sparkle, and the dev shim's exit
# codes. Exit 0 only when every assertion passes.
#
# Usage:
#   RT_DAEMON_BIN=../dist/rt ./check-bundle.sh     # embed a compiled rt (a
#                                                  # dev-mode machine's `rt`
#                                                  # on PATH is a script)
#   ./check-bundle.sh --app /Applications/mattstack.app   # assert an INSTALLED
#                                                         # prod bundle, no build
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then pass "$desc = $actual"; else fail "$desc: expected [$expected], got [$actual]"; fi
}
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null; }

PROD="$SCRIPT_DIR/mattstack.app"
DEV="$SCRIPT_DIR/mattstack-dev.app"
INSTALLED_ONLY=false
if [ "${1:-}" = "--app" ]; then
    INSTALLED_ONLY=true
    PROD="$2"
    DEV=""
else
    echo "== Building prod flavor (release) =="; ./build.sh release; echo ""
    echo "== Building dev flavor (dev) ==";      ./build.sh dev;     echo ""
fi
echo "== Assertions =="

[ -d "$PROD" ] || fail "prod bundle not found at $PROD"
[ -z "$DEV" ] || [ -d "$DEV" ] || fail "dev bundle not found at $DEV"

# ─── build.sh never notarizes, never --deep signs ───────────────────────────
if grep -qi notarize build.sh; then fail "build.sh contains a notarize step (CI-only: scripts/release/notarize.sh)"; else pass "build.sh has no local notarize step"; fi
if grep -E 'codesign.*--deep' build.sh | grep -vq '^ *#'; then fail "build.sh signs with --deep (forbidden: corrupts nested Sparkle XPC signatures)"; else pass "build.sh never signs with --deep"; fi

# ─── Identity (ruling 13) ──────────────────────────────────────────────────
check_identity() { # app bundle-id exe label devbuild
    local app="$1" bid="$2" exe="$3" label="$4" devbuild="$5" info="$1/Contents/Info.plist"
    assert_eq "$exe CFBundleIdentifier" "$bid" "$(plist "$info" CFBundleIdentifier)"
    assert_eq "$exe CFBundleExecutable" "$exe" "$(plist "$info" CFBundleExecutable)"
    assert_eq "$exe CFBundleDisplayName" "$exe" "$(plist "$info" CFBundleDisplayName)"
    assert_eq "$exe MSDaemonLabel" "$label" "$(plist "$info" MSDaemonLabel)"
    assert_eq "$exe MSDevBuild" "$devbuild" "$(plist "$info" MSDevBuild)"
    assert_eq "$exe LSMinimumSystemVersion" "14.0" "$(plist "$info" LSMinimumSystemVersion)"
    assert_eq "$exe LSUIElement" "true" "$(plist "$info" LSUIElement)"
    assert_eq "$exe URL scheme" "mattstack" "$(plist "$info" 'CFBundleURLTypes:0:CFBundleURLSchemes:0')"
    if plist "$info" LSFileQuarantineEnabled >/dev/null; then fail "$exe sets LSFileQuarantineEnabled (must be absent)"; else pass "$exe has no LSFileQuarantineEnabled"; fi
    local short build
    short="$(plist "$info" CFBundleShortVersionString)"; build="$(plist "$info" CFBundleVersion)"
    if [[ "$build" =~ ^[0-9]+$ ]]; then pass "$exe CFBundleVersion is numeric ($build)"; else fail "$exe CFBundleVersion not numeric: $build"; fi
    if [[ "$short" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        assert_eq "$exe CFBundleVersion = major*1e6+minor*1e3+patch" "$(( BASH_REMATCH[1]*1000000 + BASH_REMATCH[2]*1000 + BASH_REMATCH[3] ))" "$build"
    fi
    # Embedded rt: present, executable, identifier "rt", no rt-daemon anywhere.
    local rt="$app/Contents/MacOS/rt"
    [ -x "$rt" ] && pass "$exe ships Contents/MacOS/rt" || fail "$exe missing Contents/MacOS/rt"
    assert_eq "$exe rt codesign identifier" "Identifier=rt" "$(codesign -dv "$rt" 2>&1 | grep '^Identifier=' || true)"
    [ -z "$(find "$app" -name 'rt-daemon*' 2>/dev/null)" ] && pass "$exe has no rt-daemon artifacts" || fail "$exe still contains rt-daemon artifacts"
    # Agent plist.
    local agent="$app/Contents/Library/LaunchAgents/$label.plist"
    if [ -f "$agent" ]; then
        pass "$exe agent plist named $label.plist"
        assert_eq "$exe agent Label" "$label" "$(plist "$agent" Label)"
        assert_eq "$exe agent BundleProgram" "Contents/MacOS/rt" "$(plist "$agent" BundleProgram)"
        assert_eq "$exe agent AssociatedBundleIdentifiers[0]" "$bid" "$(plist "$agent" 'AssociatedBundleIdentifiers:0')"
        if plist "$agent" StandardOutPath >/dev/null || plist "$agent" StandardErrorPath >/dev/null; then fail "$exe agent sets Std*Path (macOS 26 \$(HOME) breakage)"; else pass "$exe agent has no Std*Path"; fi
    else
        fail "$exe agent plist missing at $agent"
    fi
    # Deck agent plist (rendered by the same script; Contents/Helpers/deck is absent until L5 — the plist ships regardless).
    local decklabel="${label/daemon/deck}" deck="$app/Contents/Library/LaunchAgents/${label/daemon/deck}.plist"
    if [ -f "$deck" ]; then
        pass "$exe deck plist named $decklabel.plist"
        assert_eq "$exe deck Label" "$decklabel" "$(plist "$deck" Label)"
        assert_eq "$exe deck BundleProgram" "Contents/Helpers/deck" "$(plist "$deck" BundleProgram)"
        assert_eq "$exe deck AssociatedBundleIdentifiers[0]" "$bid" "$(plist "$deck" 'AssociatedBundleIdentifiers:0')"
    else
        fail "$exe deck plist missing at $deck"
    fi
    # Both agents: KeepAlive { SuccessfulExit = false } (spec §8) and the static PATH (ruling R2 —
    # rt/deck prepend their own Helpers dir and ~/.local/bin at process start; no /Applications in plists).
    for a in "$agent" "$deck"; do
        [ -f "$a" ] || continue
        assert_eq "$exe $(basename "$a") KeepAlive:SuccessfulExit" "false" "$(plist "$a" 'KeepAlive:SuccessfulExit')"
        assert_eq "$exe $(basename "$a") EnvironmentVariables.PATH" "/usr/bin:/bin:/usr/sbin:/sbin" "$(plist "$a" 'EnvironmentVariables:PATH')"
        if plist "$a" EnvironmentVariables:PATH 2>/dev/null | grep -q '/Applications/'; then fail "$exe $(basename "$a") hardcodes /Applications in PATH"; fi
    done
}
check_identity "$PROD" "com.mattstack.app" "mattstack" "com.mattstack.daemon" "false"
[ -n "$DEV" ] && check_identity "$DEV" "com.mattstack.app.dev" "mattstack-dev" "com.mattstack.daemon.dev" "true"

if [ -n "$DEV" ]; then
    # Dev rt IS the shim: small Swift binary; prod rt is the compiled daemon (MB).
    DEV_RT_SIZE=$(stat -f%z "$DEV/Contents/MacOS/rt" 2>/dev/null || echo 0)
    [ "$DEV_RT_SIZE" -lt 1000000 ] && pass "dev rt is the shim ($DEV_RT_SIZE bytes)" || fail "dev rt is not the shim ($DEV_RT_SIZE bytes)"
    [ -z "$(find "$PROD" -iname '*rt-daemon-shim*')" ] && pass "prod bundle has no shim artifacts" || fail "prod bundle contains shim artifacts"
fi
PROD_RT_SIZE=$(stat -f%z "$PROD/Contents/MacOS/rt" 2>/dev/null || echo 0)
if [ "$PROD_RT_SIZE" -gt 1000000 ]; then pass "prod rt looks compiled ($PROD_RT_SIZE bytes)"; else echo "  ⚠ prod rt is $PROD_RT_SIZE bytes — pass RT_DAEMON_BIN=<compiled rt> for a meaningful check"; fi

# ─── Signing: every Mach-O signed, hardened runtime when Developer ID, jit-only entitlements ───
sign_flags() { codesign -dvv "$1" 2>&1 | grep -E '^(flags|Authority)=' | head -2 | tr '\n' ' '; }
has_runtime() { codesign -dvv "$1" 2>&1 | grep -q 'flags=.*runtime'; }
is_devid() { codesign -dvv "$1" 2>&1 | grep -q 'Authority=Developer ID Application'; }
ent_has() { codesign -d --entitlements - --xml "$1" 2>/dev/null | grep -q "$2"; }
check_signed() { # path label want-ent(none|jit)
    local p="$1" label="$2" want="$3"
    codesign --verify --strict "$p" 2>/dev/null && pass "$label signature verifies" || fail "$label signature does not verify"
    if is_devid "$p"; then has_runtime "$p" && pass "$label has hardened runtime" || fail "$label lacks hardened runtime ($(sign_flags "$p"))"; fi
    if ent_has "$p" 'allow-jit'; then [ "$want" = jit ] && pass "$label has allow-jit" || fail "$label unexpectedly has allow-jit"; else [ "$want" = none ] && pass "$label has no jit entitlement" || fail "$label missing allow-jit"; fi
    ent_has "$p" 'allow-unsigned-executable-memory' && fail "$label carries allow-unsigned-executable-memory (only after the measurement task says so)" || pass "$label has no allow-unsigned-executable-memory"
}
for app in "$PROD" $DEV; do
    exe="$(plist "$app/Contents/Info.plist" CFBundleExecutable)"
    codesign --verify --deep --strict "$app" 2>/dev/null && pass "$exe bundle verifies (--deep --strict)" || fail "$exe bundle fails codesign --verify --deep --strict"
    check_signed "$app/Contents/MacOS/rt" "$exe rt" jit
    check_signed "$app/Contents/MacOS/$exe" "$exe tray" none
    # Inner/outer identity must match (no nested ad-hoc inside a Developer ID bundle).
    assert_eq "$exe inner/outer signing authority" "$(codesign -dvv "$app" 2>&1 | grep '^Authority=' | head -1)" "$(codesign -dvv "$app/Contents/MacOS/rt" 2>&1 | grep '^Authority=' | head -1)"
done

# ─── Icons ──────────────────────────────────────────────────────────────────
[ -f "$PROD/Contents/Resources/AppIcon.icns" ] && pass "prod ships AppIcon.icns" || fail "prod missing AppIcon.icns"
if [ -n "$DEV" ]; then
    [ -f "$DEV/Contents/Resources/AppIcon.icns" ] && pass "dev ships AppIcon.icns" || fail "dev missing AppIcon.icns"
    cmp -s "$PROD/Contents/Resources/AppIcon.icns" "$DEV/Contents/Resources/AppIcon.icns" && fail "prod/dev icons identical (dev tint missing)" || pass "prod/dev icons differ"
fi

# ═══ Helpers (deps.lock) — section appended by Task 4 ═══
# ═══ Sparkle — section appended by Task 5 ═══

# ─── Dev shim exit-code contract ────────────────────────────────────────────
if [ -n "$DEV" ]; then
    SHIM="$DEV/Contents/MacOS/rt"
    SHIM_TMP=$(mktemp -d /tmp/mat383-shim.XXXXXX)
    trap 'rm -rf "$SHIM_TMP"' EXIT
    shim_case() {
        local desc="$1" expected_code="$2" home="$3" out rc
        out=$(env -i HOME="$home" "$SHIM" --daemon 2>&1); rc=$?
        if [ "$rc" -ne "$expected_code" ]; then fail "$desc: expected exit $expected_code, got $rc (${out:-<empty>})"; return; fi
        if [ "$expected_code" -eq 0 ] && [ "$(printf '%s' "$out" | grep -c 'standing down' || true)" -ne 1 ]; then fail "$desc: exit 0 but not exactly one stand-down line"; return; fi
        pass "$desc → exit $rc"
    }
    H1="$SHIM_TMP/no-config"; mkdir -p "$H1/.mattstack/rt"; shim_case "shim: missing dev-mode.json" 0 "$H1"
    H2="$SHIM_TMP/no-sourcepath"; mkdir -p "$H2/.mattstack/rt"; echo '{"bunPath":"/nope/bun"}' > "$H2/.mattstack/rt/dev-mode.json"; shim_case "shim: config without sourcePath" 0 "$H2"
    H3="$SHIM_TMP/no-bun"; mkdir -p "$H3/.mattstack/rt"; echo "{\"sourcePath\":\"$SHIM_TMP/src\",\"bunPath\":\"$SHIM_TMP/absent-bun\"}" > "$H3/.mattstack/rt/dev-mode.json"; shim_case "shim: bun missing" 0 "$H3"
    H4="$SHIM_TMP/no-source"; mkdir -p "$H4/.mattstack/rt"; echo "{\"sourcePath\":\"$SHIM_TMP/gone\",\"bunPath\":\"/bin/echo\"}" > "$H4/.mattstack/rt/dev-mode.json"; shim_case "shim: sourcePath gone" 0 "$H4"
    OUT5=$(env -i "$SHIM" --daemon 2>&1); RC5=$?
    [ "$RC5" -eq 0 ] && printf '%s' "$OUT5" | grep -q 'standing down: HOME not set' && pass "shim: HOME unset → exit 0" || fail "shim: HOME unset → got $RC5"
    H6="$SHIM_TMP/exec-fail"; mkdir -p "$H6/.mattstack/rt" "$SHIM_TMP/realsrc/lib"
    echo 'x' > "$SHIM_TMP/realsrc/lib/daemon.ts"; printf '#no\n' > "$SHIM_TMP/fake-bun"; chmod 644 "$SHIM_TMP/fake-bun"
    echo "{\"sourcePath\":\"$SHIM_TMP/realsrc\",\"bunPath\":\"$SHIM_TMP/fake-bun\"}" > "$H6/.mattstack/rt/dev-mode.json"
    env -i HOME="$H6" "$SHIM" --daemon >/dev/null 2>&1; RC6=$?
    [ "$RC6" -ne 0 ] && grep -q 'error: execv' "$H6/.mattstack/rt/logs/daemon-stderr.log" 2>/dev/null && pass "shim: genuine execv failure → exit $RC6" || fail "shim: execv failure should exit nonzero with an error line (got $RC6)"
fi

# ─── Swift source gates that survive the rename ─────────────────────────────
if ! $INSTALLED_ONLY; then
    grep_src() { grep -R --include='*.swift' -q "$1" Sources Sources-daemon-shim; }
    grep_src 'forInfoDictionaryKey: "MSDaemonLabel"' && pass "BundleFlavor reads MSDaemonLabel" || fail "BundleFlavor does not read MSDaemonLabel"
    grep_src 'defaultDaemonLabel = "com.mattstack.daemon"' && pass "BundleFlavor falls back to com.mattstack.daemon" || fail "BundleFlavor fallback label wrong"
    grep_src 'Contents/MacOS/rt-daemon' && fail "Swift still references Contents/MacOS/rt-daemon" || pass "no Swift reference to Contents/MacOS/rt-daemon"
    grep_src 'path == "/flavor/retire"' && pass "/flavor/retire endpoint present" || fail "/flavor/retire endpoint missing"
    GUARD_LINE=$(grep -n 'TrayServer.exitIfAnotherTrayOwnsSocket()' Sources/main.swift | head -1 | cut -d: -f1)
    DELEGATE_LINE=$(grep -n 'AppDelegate()' Sources/main.swift | head -1 | cut -d: -f1)
    [ -n "$GUARD_LINE" ] && [ -n "$DELEGATE_LINE" ] && [ "$GUARD_LINE" -lt "$DELEGATE_LINE" ] && pass "socket guard precedes AppDelegate" || fail "socket guard does not precede AppDelegate"
    # Sparkle gating (L3 T10 replaces UpdateChecker with UpdaterController + UpdatePolicy).
    if grep -q 'UpdatePolicy.shouldStartUpdater(isDevBuild: isDevBuild' Sources/Updates/UpdaterController.swift 2>/dev/null; then
        pass "UpdaterController gates Sparkle on the dev flavor"
    else
        fail "UpdaterController does not gate Sparkle on BundleFlavor.isDevBuild"
    fi
    TRAY_STRINGS=$(mktemp /tmp/mat383-strings.XXXXXX)
    strings "$PROD/Contents/MacOS/$(plist "$PROD/Contents/Info.plist" CFBundleExecutable)" > "$TRAY_STRINGS" 2>/dev/null
    assert_bin_has() { # desc needle
        if grep -qF "$2" "$TRAY_STRINGS"; then pass "built tray binary contains: $2"; else fail "built tray binary is missing: $2 ($1)"; fi
    }
    assert_bin_has "silent dev updater" "update check skipped (dev build)"
    rm -f "$TRAY_STRINGS"
fi

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 6: Run everything**

Run: `bun test && bunx tsc --noEmit && bash -n rt-tray/build.sh rt-tray/check-bundle.sh && (bun build --compile ./cli.ts --outfile dist/rt && cd rt-tray && RT_DAEMON_BIN=../dist/rt ./check-bundle.sh)`
Expected: bun tests green (handoff test now fakes `Contents/MacOS/rt`); check-bundle `0 failed` once L3 T1/T2/T10/T18 have merged (ad-hoc signatures: the Developer-ID-only assertions are skipped by `is_devid`). Before L3 merges, the template/Swift assertions fail by design — that is the dependency signal; do not patch them out.

- [ ] **Step 7: Commit**

```bash
git add rt-tray/build.sh rt-tray/check-bundle.sh commands/settings.ts lib/__tests__/dev-mode-handoff.test.ts scripts/entitlements.plist
git commit -m "MAT-383: identity freeze — rt side reads Contents/MacOS/rt, numeric build, jit-only entitlements, check-bundle asserts the contract

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `rt-tray/build.sh` rewrite — Helpers, Resources, Sparkle keys, inside-out signing, xcodebuild-or-swift-build

**AFTER L3 T1 + T2 + T10 merge.** This rewrite deletes L3 T10's fenced build.sh stopgap and depends on L3's `Package.swift` (Sparkle), `Info.plist`/`LaunchAgent.plist`/`LaunchAgent-deck.plist` templates, `project.yml`, and `rt-tray/scripts/render-launchagents.sh` (cross-plan review §1 rows 12–17).

**Files:**
- Rewrite: `rt-tray/build.sh`
- Modify: `rt-tray/check-bundle.sh` (append the Helpers section at the `Task 4` marker)

**Interfaces:**
- Consumes: `rt-tray/deps.lock` via `bun scripts/lib/deps-lock.ts` (Task 2); `rt-tray/deps/arm64/<name>` (Task 2); `numeric_build` + identity vars (Task 3); `scripts/entitlements.plist` (jit-only); L3 T2's `rt-tray/scripts/render-launchagents.sh <prod|dev> <outdir>` (renders **both** agent plists — daemon + deck — with `KeepAlive {SuccessfulExit:false}` and the static `EnvironmentVariables.PATH`); L3 T2's `Info.plist` template (already declares `LSMinimumSystemVersion`, `CFBundleURLTypes` with `CFBundleURLName @@BUNDLE_ID@@.join`, and the `SU*` keys with placeholder values — build.sh overwrites them with `Set`, never `Add`).
- Environment contract (used by Task 8's workflow): `RT_DAEMON_BIN` (compiled rt; required in release mode unless `dist/rt` exists), `RT_VSIX` (path to the `.vsix`; optional), `RT_VERSION` (e.g. `v2.8.0`; default `git describe`), `RT_REQUIRE_DEPS=1` (missing `rt-tray/deps/arm64` is fatal; CI sets it), `SPARKLE_PUBLIC_ED_KEY` (overrides `rt-tray/SUPublicEDKey`), `RT_BUILD_TOOL=swift|xcode` (default: `xcode` when `xcodebuild -version` succeeds AND `rt-tray/project.yml` exists, else `swift`).
- Produces: `rt-tray/mattstack.app` / `rt-tray/mattstack-dev.app` matching the layout contract; functions `assemble_common`, `sign_bundle`, `embed_sparkle`, `bundle_helpers` (all internal to build.sh).

- [ ] **Step 1: Write the new build.sh**

```bash
#!/bin/bash
set -euo pipefail

# ─── mattstack.app build ─────────────────────────────────────────────────────
# Usage:
#   ./build.sh            debug: swift build only, no bundle
#   ./build.sh release    mattstack.app (prod)
#   ./build.sh dev        mattstack-dev.app (dev; Contents/MacOS/rt is the source-runner shim)
#   ./build.sh install    release + copy to /Applications + launch
#
# Env: RT_DAEMON_BIN RT_VSIX RT_VERSION RT_REQUIRE_DEPS SPARKLE_PUBLIC_ED_KEY RT_BUILD_TOOL
#
# The bundle id, daemon label, and display name live ONLY here; Info.plist is a
# sed template and the LaunchAgent plists come from scripts/render-launchagents.sh.
# The tray binary comes from xcodebuild (when Xcode + project.yml exist) or
# swift build; both feed the SAME assemble + sign path, so the bundle contract
# (check-bundle.sh) is identical.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

MODE="${1:-debug}"
PRODUCT_NAME="rt-tray"

case "$MODE" in
    debug)            IS_DEV=false; BUILD_CONFIG="debug" ;;
    dev)              IS_DEV=true;  BUILD_CONFIG="release" ;;
    release|install)  IS_DEV=false; BUILD_CONFIG="release" ;;
    *) echo "  ✗ Unknown mode: $MODE (expected debug|release|dev|install)" >&2; exit 1 ;;
esac

if [ "$IS_DEV" = true ]; then
    APP_NAME="mattstack-dev"; DISPLAY_NAME="mattstack-dev"
    BUNDLE_ID="com.mattstack.app.dev"; DAEMON_LABEL="com.mattstack.daemon.dev"
    SCHEME="mattstack-dev"
else
    APP_NAME="mattstack"; DISPLAY_NAME="mattstack"
    BUNDLE_ID="com.mattstack.app"; DAEMON_LABEL="com.mattstack.daemon"
    SCHEME="mattstack"
fi

APP_BUNDLE="$SCRIPT_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
DEPS_DIR="$SCRIPT_DIR/deps/arm64"
SU_FEED_URL="https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml"
ENTITLEMENTS_JIT="$REPO_DIR/scripts/entitlements.plist"

numeric_build() {
    local v="${1#v}"
    if [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
        echo $(( BASH_REMATCH[1] * 1000000 + BASH_REMATCH[2] * 1000 + BASH_REMATCH[3] ))
    else
        echo 0
    fi
}

# ─── Which compiler ──────────────────────────────────────────────────────────
if [ -z "${RT_BUILD_TOOL:-}" ]; then
    if xcodebuild -version >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/project.yml" ]; then RT_BUILD_TOOL=xcode; else RT_BUILD_TOOL=swift; fi
fi
echo "  Building $APP_NAME ($MODE) with $RT_BUILD_TOOL..."

XCODE_APP=""
if [ "$RT_BUILD_TOOL" = xcode ]; then
    command -v xcodegen >/dev/null || { echo "  ✗ xcodegen not found (brew install xcodegen)"; exit 1; }
    xcodegen generate --spec "$SCRIPT_DIR/project.yml" --project "$SCRIPT_DIR" >/dev/null
    DERIVED="$SCRIPT_DIR/.build-xcode"
    xcodebuild -project "$SCRIPT_DIR/mattstack.xcodeproj" -scheme "$SCHEME" -configuration Release \
        -derivedDataPath "$DERIVED" -destination 'platform=macOS,arch=arm64' \
        CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build 2>&1 | sed 's/^/  /'
    XCODE_APP="$DERIVED/Build/Products/Release/$APP_NAME.app"
    [ -d "$XCODE_APP" ] || { echo "  ✗ xcodebuild produced no $XCODE_APP"; exit 1; }
    BINARY="$XCODE_APP/Contents/MacOS/$APP_NAME"
    if [ "$IS_DEV" = true ]; then
        swift build -c release --product rt-daemon-shim 2>&1 | sed 's/^/  /'
        SHIM_BINARY="$SCRIPT_DIR/.build/release/rt-daemon-shim"
    fi
else
    if [ "$BUILD_CONFIG" = "debug" ]; then
        swift build 2>&1 | sed 's/^/  /'
        BINARY="$SCRIPT_DIR/.build/debug/$PRODUCT_NAME"
    elif [ "$IS_DEV" = true ]; then
        swift build -c release 2>&1 | sed 's/^/  /'
        BINARY="$SCRIPT_DIR/.build/release/$PRODUCT_NAME"
        SHIM_BINARY="$SCRIPT_DIR/.build/release/rt-daemon-shim"
    else
        swift build -c release --product "$PRODUCT_NAME" 2>&1 | sed 's/^/  /'
        BINARY="$SCRIPT_DIR/.build/release/$PRODUCT_NAME"
    fi
fi
[ -f "$BINARY" ] || { echo "  ✗ Build failed — binary not found at $BINARY"; exit 1; }
echo "  ✓ Build succeeded"

if [ "$BUILD_CONFIG" = "debug" ]; then
    echo "  Skipping .app bundle assembly for debug build."
    echo "  Run: $BINARY"
    exit 0
fi

# ─── Assemble ────────────────────────────────────────────────────────────────
echo "  Assembling $APP_NAME.app..."
rm -rf "$APP_BUNDLE"
if [ -n "$XCODE_APP" ]; then
    ditto "$XCODE_APP" "$APP_BUNDLE"
    find "$APP_BUNDLE" -name '_CodeSignature' -prune -exec rm -rf {} + 2>/dev/null || true
else
    mkdir -p "$CONTENTS/MacOS"
    cp "$BINARY" "$CONTENTS/MacOS/$APP_NAME"
fi
mkdir -p "$CONTENTS/Resources" "$CONTENTS/Helpers" "$CONTENTS/Frameworks" "$CONTENTS/Library/LaunchAgents"

# Icons (make-icon.swift emits both flavors; bundle-internal name is always AppIcon.icns).
if [ ! -f "$SCRIPT_DIR/AppIcon.icns" ] || [ ! -f "$SCRIPT_DIR/AppIcon-dev.icns" ]; then
    echo "  Generating AppIcon.icns + AppIcon-dev.icns..."; swift "$SCRIPT_DIR/make-icon.swift"
fi
ICON_SRC="$SCRIPT_DIR/AppIcon.icns"; [ "$IS_DEV" = true ] && ICON_SRC="$SCRIPT_DIR/AppIcon-dev.icns"
[ -f "$ICON_SRC" ] && cp "$ICON_SRC" "$CONTENTS/Resources/AppIcon.icns" && echo "  ✓ $(basename "$ICON_SRC") → AppIcon.icns"

# Notification sounds (UNNotificationSound needs caf inside Resources).
if [ -d "$REPO_DIR/sounds" ]; then
    for mp3 in "$REPO_DIR"/sounds/*.mp3; do
        [ -f "$mp3" ] || continue
        afconvert -d LEI16@44100 -f caff "$mp3" "$CONTENTS/Resources/$(basename "$mp3" .mp3).caf" 2>/dev/null && echo "  ✓ $(basename "$mp3" .mp3).caf"
    done
fi
[ -f "$SCRIPT_DIR/mission-control-screenshot.png" ] && cp "$SCRIPT_DIR/mission-control-screenshot.png" "$CONTENTS/Resources/" && xattr -cr "$CONTENTS/Resources/mission-control-screenshot.png" 2>/dev/null || true

# ─── Embed rt (Contents/MacOS/rt) ────────────────────────────────────────────
# Prod: the compiled rt. Dev: the shim, permanently (the dev flavor runs the
# daemon from source). A script is never a valid prod daemon.
if [ "$IS_DEV" = true ]; then
    [ -f "$SHIM_BINARY" ] || { echo "  ✗ rt-daemon-shim not built"; exit 1; }
    cp "$SHIM_BINARY" "$CONTENTS/MacOS/rt"; chmod +x "$CONTENTS/MacOS/rt"
    echo "  ✓ Embedded the source-runner shim as Contents/MacOS/rt"
else
    DAEMON_SRC="${RT_DAEMON_BIN:-}"
    [ -z "$DAEMON_SRC" ] && [ -f "$REPO_DIR/dist/rt" ] && DAEMON_SRC="$REPO_DIR/dist/rt"
    [ -z "$DAEMON_SRC" ] && DAEMON_SRC="$(command -v rt 2>/dev/null || true)"
    if [ -n "$DAEMON_SRC" ] && [ -f "$DAEMON_SRC" ] && ! file -b "$DAEMON_SRC" | grep -q "Mach-O"; then
        echo "  ✗ $DAEMON_SRC is not a compiled binary (dev-mode wrapper?) — bun run build, or set RT_DAEMON_BIN"; exit 1
    fi
    if [ -n "$DAEMON_SRC" ] && [ -f "$DAEMON_SRC" ]; then
        cp "$DAEMON_SRC" "$CONTENTS/MacOS/rt"; chmod +x "$CONTENTS/MacOS/rt"
        echo "  ✓ Embedded rt from $DAEMON_SRC"
    else
        echo "  ⚠ rt binary not found — Contents/MacOS/rt will be missing (set RT_DAEMON_BIN)"
    fi
fi

# ─── Helpers from deps.lock ──────────────────────────────────────────────────
HELPER_ENTITLEMENTS=()   # "path<TAB>jit|none" for the signing pass
bundle_helpers() {
    if [ ! -d "$DEPS_DIR" ]; then
        if [ "${RT_REQUIRE_DEPS:-0}" = 1 ]; then echo "  ✗ $DEPS_DIR missing — run scripts/fetch-deps.sh arm64"; exit 1; fi
        echo "  ⚠ $DEPS_DIR missing — Helpers skipped (scripts/fetch-deps.sh arm64 to bundle them)"
        return
    fi
    while IFS=$'\t' read -r name version url sha archive extract bundlePath ent status kind expose; do
        [ "$kind" = helper ] || continue
        if [ "$status" != bundled ]; then echo "  · $name: pending, not in this build"; continue; fi
        src="$DEPS_DIR/$name"
        [ -e "$src" ] || { echo "  ✗ $name not fetched at $src — run scripts/fetch-deps.sh arm64"; exit 1; }
        dest="$APP_BUNDLE/$bundlePath"
        rm -rf "$dest"; mkdir -p "$(dirname "$dest")"
        cp -R "$src" "$dest"
        xattr -cr "$dest" 2>/dev/null || true
        HELPER_ENTITLEMENTS+=("$dest	$ent")
        echo "  ✓ Helpers/$name $version"
    done < <(bun "$REPO_DIR/scripts/lib/deps-lock.ts")
    cp "$SCRIPT_DIR/deps.lock" "$CONTENTS/Resources/deps.lock"
}
bundle_helpers

# ─── Extension ───────────────────────────────────────────────────────────────
if [ -n "${RT_VSIX:-}" ]; then
    [ -f "$RT_VSIX" ] || { echo "  ✗ RT_VSIX=$RT_VSIX not found"; exit 1; }
    cp "$RT_VSIX" "$CONTENTS/Resources/rt-context.vsix" && echo "  ✓ rt-context.vsix"
fi

# ─── Sparkle framework (swift-build path copies the SPM artifact; xcodebuild embeds it itself) ───
embed_sparkle() {
    [ -d "$CONTENTS/Frameworks/Sparkle.framework" ] && { echo "  ✓ Sparkle.framework (embedded by xcodebuild)"; return; }
    local fw
    fw="$(find "$SCRIPT_DIR/.build/artifacts" -type d -name 'Sparkle.framework' -path '*macos-arm64*' 2>/dev/null | head -1)"
    if [ -z "$fw" ]; then echo "  ⚠ Sparkle.framework not in .build/artifacts — Package.swift has no Sparkle dependency yet; updater disabled in this build"; return; fi
    ditto "$fw" "$CONTENTS/Frameworks/Sparkle.framework"
    echo "  ✓ Sparkle.framework → Contents/Frameworks"
}
embed_sparkle

# ─── LaunchAgent plists (daemon + deck; rendered by the template script) ─────
# Both plists carry KeepAlive {SuccessfulExit:false} and the static PATH
# /usr/bin:/bin:/usr/sbin:/sbin — rt and deck prepend their own bundle's
# Contents/Helpers and $HOME/.local/bin at process start, so no install
# location is ever baked into a plist.
mkdir -p "$CONTENTS/Library/LaunchAgents"
"$SCRIPT_DIR/scripts/render-launchagents.sh" "$([ "$IS_DEV" = true ] && echo dev || echo prod)" "$CONTENTS/Library/LaunchAgents"
echo "  ✓ LaunchAgent plists ($DAEMON_LABEL.plist, ${DAEMON_LABEL/daemon/deck}.plist)"

# ─── Info.plist: identity (template) + version + Sparkle keys ─────────────────
INFO="$CONTENTS/Info.plist"
sed -e "s/@@APP_NAME@@/$APP_NAME/g" -e "s/@@BUNDLE_ID@@/$BUNDLE_ID/g" \
    -e "s/@@DISPLAY_NAME@@/$DISPLAY_NAME/g" -e "s/@@DAEMON_LABEL@@/$DAEMON_LABEL/g" \
    "$SCRIPT_DIR/Info.plist" > "$INFO"
# The template already declares LSMinimumSystemVersion, CFBundleURLTypes and the
# SU* keys; PlistBuddy "Add" fails on an existing key, so every write below goes
# through plist_set (Set, creating the key only when the template lacks it).
plist_set() { # key type value
    /usr/libexec/PlistBuddy -c "Set :$1 $3" "$INFO" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$INFO"
}
plist_set MSDevBuild bool "$IS_DEV"
plist_set LSMinimumSystemVersion string 14.0

RT_VERSION="${RT_VERSION:-$(cd "$REPO_DIR" && git describe --tags --abbrev=0 2>/dev/null || echo dev)}"
RT_VERSION="${RT_VERSION#v}"
if [ "$RT_VERSION" != "dev" ]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $RT_VERSION" "$INFO"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(numeric_build "$RT_VERSION")" "$INFO"
    echo "  ✓ Version $RT_VERSION (build $(numeric_build "$RT_VERSION"))"
fi

PUBLIC_KEY="${SPARKLE_PUBLIC_ED_KEY:-}"
[ -z "$PUBLIC_KEY" ] && [ -f "$SCRIPT_DIR/SUPublicEDKey" ] && PUBLIC_KEY="$(tr -d '[:space:]' < "$SCRIPT_DIR/SUPublicEDKey")"
if [ "$IS_DEV" = true ]; then
    plist_set SUEnableAutomaticChecks bool false
else
    plist_set SUFeedURL string "$SU_FEED_URL"
    plist_set SUEnableAutomaticChecks bool true
    plist_set SUScheduledCheckInterval integer 21600
    plist_set SUAutomaticallyUpdate bool true
    plist_set SUVerifyUpdateBeforeExtraction bool true
fi
if [ -n "$PUBLIC_KEY" ]; then
    plist_set SUPublicEDKey string "$PUBLIC_KEY"
    echo "  ✓ SUPublicEDKey set"
else
    echo "  ⚠ no Sparkle public key (rt-tray/SUPublicEDKey or SPARKLE_PUBLIC_ED_KEY) — updates cannot be verified by this build"
fi
echo -n "APPL????" > "$CONTENTS/PkgInfo"
echo "  ✓ App bundle assembled at $APP_BUNDLE"

# ─── Sign, inside-out ────────────────────────────────────────────────────────
# Order: Sparkle XPCs → Autoupdate → Updater.app → Sparkle.framework →
# Helpers → Contents/MacOS/rt → outer app. Never --deep (it rewrites the
# Sparkle XPC signatures and breaks updates while notarization still passes).
SIGNING_IDENTITY=""
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    SIGNING_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | awk -F'"' '{print $2}')
    echo "  Signing with: $SIGNING_IDENTITY"
    SIGN_FLAGS=(--force --sign "$SIGNING_IDENTITY" --options runtime --timestamp)
else
    echo "  No Developer ID found — ad-hoc signing"
    SIGN_FLAGS=(--force --sign -)
fi
sign() { codesign "${SIGN_FLAGS[@]}" "$@"; }

SPARKLE_FW="$CONTENTS/Frameworks/Sparkle.framework"
if [ -d "$SPARKLE_FW" ]; then
    V="$SPARKLE_FW/Versions/B"
    sign "$V/XPCServices/Installer.xpc"
    sign --preserve-metadata=entitlements "$V/XPCServices/Downloader.xpc"
    sign "$V/Autoupdate"
    sign "$V/Updater.app"
    sign "$SPARKLE_FW"
    echo "  ✓ Signed Sparkle.framework (inside-out)"
fi

sign_helper_tree() { # root ent — signs every Mach-O under root (files or a dir like node/)
    local root="$1" ent="$2" f
    while IFS= read -r -d '' f; do
        if file -b "$f" | grep -q "Mach-O"; then
            if [ "$ent" = jit ]; then sign -i "com.mattstack.helper.$(basename "$f")" --entitlements "$ENTITLEMENTS_JIT" "$f"
            else sign -i "com.mattstack.helper.$(basename "$f")" "$f"; fi
        fi
    done < <(find "$root" -type f -print0)
}
for entry in "${HELPER_ENTITLEMENTS[@]+"${HELPER_ENTITLEMENTS[@]}"}"; do
    path="${entry%%	*}"; ent="${entry##*	}"
    sign_helper_tree "$path" "$ent"
    echo "  ✓ Signed Helpers/$(basename "$path") ($ent)"
done

if [ -f "$CONTENTS/MacOS/rt" ]; then
    sign -i rt --entitlements "$ENTITLEMENTS_JIT" "$CONTENTS/MacOS/rt"
    echo "  ✓ Signed Contents/MacOS/rt (identifier rt, jit)"
fi

sign --entitlements /dev/stdin <<EOF "$APP_BUNDLE"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <false/>
</dict>
</plist>
EOF
echo "  ✓ Signed app bundle"
codesign --verify --deep --strict "$APP_BUNDLE" 2>/dev/null && echo "  ✓ Signature verified (--deep --strict)" || { echo "  ✗ Signature verification failed"; exit 1; }

# ─── Install ─────────────────────────────────────────────────────────────────
if [ "$MODE" = "install" ]; then
    INSTALL_DIR="/Applications"
    if pkill -f "$APP_NAME.app/Contents/MacOS/$APP_NAME" 2>/dev/null; then
        for _ in $(seq 1 20); do pgrep -f "$APP_NAME.app/Contents/MacOS/$APP_NAME" >/dev/null 2>&1 || break; sleep 0.1; done
    fi
    rm -rf "$INSTALL_DIR/$APP_NAME.app"
    ditto "$APP_BUNDLE" "$INSTALL_DIR/$APP_NAME.app"
    echo "  ✓ Installed to $INSTALL_DIR/$APP_NAME.app"
    open "$INSTALL_DIR/$APP_NAME.app"
fi
echo ""
echo "  Done."
```

Notes for the implementer: `sign` wraps `codesign` so the Developer-ID flags are never duplicated; `HELPER_ENTITLEMENTS` uses a literal TAB as separator; the `${arr[@]+"${arr[@]}"}` form keeps `set -u` happy on bash 3.2 when no helpers were bundled; the agent plists are L3's (`render-launchagents.sh` renders daemon + deck from `LaunchAgent.plist`/`LaunchAgent-deck.plist`, KeepAlive `{SuccessfulExit:false}` in both flavors) and their `EnvironmentVariables.PATH` is the static `/usr/bin:/bin:/usr/sbin:/sbin` (ruling R2 — rt's daemon boot and deck prepend `<bundleRoot>/Contents/Helpers` and `$HOME/.local/bin` themselves; build.sh never writes a PATH); `plist_set` exists because L3's Info.plist template already declares the `LSMinimumSystemVersion`/`CFBundleURLTypes`/`SU*` keys and PlistBuddy `Add` fails on an existing key. `CFBundleURLName` stays the template's `@@BUNDLE_ID@@.join` (L4's earlier `.url` is withdrawn).

- [ ] **Step 2: Append the Helpers section to check-bundle.sh** (replace the `# ═══ Helpers (deps.lock) — section appended by Task 4 ═══` line)

```bash
# ═══ Helpers (deps.lock) ═══
LOCK_TSV="$(bun "$SCRIPT_DIR/../scripts/lib/deps-lock.ts" --kind helper)"
check_helpers() { # app
    local app="$1" exe; exe="$(plist "$app/Contents/Info.plist" CFBundleExecutable)"
    if [ ! -d "$SCRIPT_DIR/deps/arm64" ] && ! $INSTALLED_ONLY; then echo "  ⚠ $exe: rt-tray/deps/arm64 absent — Helpers assertions skipped (scripts/fetch-deps.sh arm64)"; return; fi
    cmp -s "$SCRIPT_DIR/deps.lock" "$app/Contents/Resources/deps.lock" && pass "$exe Resources/deps.lock matches rt-tray/deps.lock" || fail "$exe Resources/deps.lock missing or stale"
    while IFS=$'\t' read -r name version url sha archive extract bundlePath ent status kind expose; do
        local p="$app/$bundlePath"
        if [ "$status" = pending ]; then
            [ -e "$p" ] && fail "$exe ships $name although deps.lock says pending" || pass "$exe: $name absent (pending until L5)"
            continue
        fi
        [ -e "$p" ] || { fail "$exe missing Helpers/$name at $bundlePath"; continue; }
        pass "$exe ships Helpers/$name"
        while IFS= read -r -d '' f; do
            file -b "$f" | grep -q "Mach-O" || continue
            check_signed "$f" "$exe Helpers/$name/$(basename "$f")" "$ent"
            assert_eq "$exe $name identifier" "Identifier=com.mattstack.helper.$(basename "$f")" "$(codesign -dv "$f" 2>&1 | grep '^Identifier=' || true)"
        done < <(find "$p" -type f -print0)
        [ -z "$(find "$p" -name '.*' -maxdepth 1 2>/dev/null | grep -v '/\.$' )" ] || true
    done <<< "$LOCK_TSV"
    # Every bundled helper answers --version from inside the bundle (signed, entitled).
    [ -x "$app/Contents/Helpers/fzf" ] && "$app/Contents/Helpers/fzf" --version >/dev/null 2>&1 && pass "$exe Helpers/fzf runs" || fail "$exe Helpers/fzf does not run"
    [ -x "$app/Contents/Helpers/jq" ] && "$app/Contents/Helpers/jq" --version >/dev/null 2>&1 && pass "$exe Helpers/jq runs" || fail "$exe Helpers/jq does not run"
    [ -x "$app/Contents/Helpers/bun" ] && "$app/Contents/Helpers/bun" --version >/dev/null 2>&1 && pass "$exe Helpers/bun runs (jit entitlement sufficient)" || fail "$exe Helpers/bun does not run under its entitlements"
    [ -x "$app/Contents/Helpers/node/bin/node" ] && "$app/Contents/Helpers/node/bin/node" -e 'process.exit(0)' >/dev/null 2>&1 && pass "$exe Helpers/node runs" || fail "$exe Helpers/node does not run under its entitlements"
    [ -f "$app/Contents/Helpers/fast-browser/bin/fast-browser.mjs" ] && pass "$exe Helpers/fast-browser package present" || fail "$exe Helpers/fast-browser package missing"
}
check_helpers "$PROD"
[ -n "$DEV" ] && check_helpers "$DEV"
# Agent PATH is the static system set (asserted per plist in check_identity); services never
# capture a shell PATH and never bake in an install location — rt/deck prepend their own Helpers dir.
```

- [ ] **Step 3: Run**

Run: `bash -n rt-tray/build.sh rt-tray/check-bundle.sh && scripts/fetch-deps.sh arm64 && bun build --compile ./cli.ts --outfile dist/rt && cd rt-tray && RT_DAEMON_BIN=../dist/rt ./check-bundle.sh`
Expected: `0 failed`; `ls rt-tray/mattstack.app/Contents/Helpers` shows `bun fast-browser fzf gh glab jq node`; `ls rt-tray/mattstack.app/Contents/Library/LaunchAgents` shows `com.mattstack.daemon.plist com.mattstack.deck.plist`; `du -sh rt-tray/mattstack.app` (expect roughly 300–400 MB — record the number in the commit body).
Also: `RT_REQUIRE_DEPS=1 rt-tray/build.sh release` with `rt-tray/deps` moved aside exits 1 with the fetch hint (then move it back).

- [ ] **Step 4: Commit**

```bash
git add rt-tray/build.sh rt-tray/check-bundle.sh
git commit -m "MAT-383: build.sh — Helpers from deps.lock, Resources, rendered agent plists, Sparkle keys, inside-out signing, xcodebuild-or-swift-build

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Sparkle framework — embed, rpath check, signing assertions

**AFTER L3 T10 merges** (L3 T10 adds the Sparkle SPM dependency, rpath, and `Package.resolved`; cross-plan review §1 row 12). "Skip if L3 has already added" is now "requires".

**Files:**
- ~~Modify: `rt-tray/Package.swift` + `rt-tray/Package.resolved`~~ — Dropped — owned by L3 T10 (cross-plan review).
- Modify: `rt-tray/check-bundle.sh` (replace the `# ═══ Sparkle — section appended by Task 5 ═══` marker)

**Interfaces:**
- Consumes: `embed_sparkle` + the Sparkle signing block in build.sh (Task 4).
- Produces: `Contents/Frameworks/Sparkle.framework` in both flavors, signed inside-out; tray binary carries `@rpath/Sparkle.framework/Versions/B/Sparkle` + an `@executable_path/../Frameworks` rpath.

- [ ] **Step 1: Package.swift**

Dropped — owned by L3 T10 (cross-plan review): L3's `Package.swift` declares `.package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.6")`, the `Sparkle` product dependency, and the `@executable_path/../Frameworks` rpath; `project.yml` carries the same package for the xcodebuild path. Verify before Step 2 that `rt-tray/Package.swift` names `2.9.6` or newer and `rt-tray/Package.resolved` is committed; do not edit either here — report a mismatch to L3 instead.

- [ ] **Step 2: Build + inspect**

Run: `cd rt-tray && swift package resolve && ./build.sh release && otool -L mattstack.app/Contents/MacOS/mattstack | grep Sparkle && otool -l mattstack.app/Contents/MacOS/mattstack | grep -A2 LC_RPATH | grep Frameworks && ls mattstack.app/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices`
Expected: `@rpath/Sparkle.framework/Versions/B/Sparkle`, an rpath `@executable_path/../Frameworks`, and `Downloader.xpc Installer.xpc`. `open mattstack.app` launches (menu-bar "m" appears) — the app links Sparkle even before L3 wires `SPUStandardUpdaterController`.

- [ ] **Step 3: check-bundle Sparkle section**

```bash
# ═══ Sparkle ═══
check_sparkle() { # app
    local app="$1" exe fw; exe="$(plist "$app/Contents/Info.plist" CFBundleExecutable)"; fw="$app/Contents/Frameworks/Sparkle.framework"
    [ -d "$fw" ] || { fail "$exe missing Contents/Frameworks/Sparkle.framework"; return; }
    pass "$exe ships Sparkle.framework"
    otool -L "$app/Contents/MacOS/$exe" | grep -q '@rpath/Sparkle.framework' && pass "$exe tray links Sparkle via @rpath" || fail "$exe tray does not link Sparkle"
    otool -l "$app/Contents/MacOS/$exe" | grep -A2 LC_RPATH | grep -q '@executable_path/../Frameworks' && pass "$exe tray has the Frameworks rpath" || fail "$exe tray lacks the @executable_path/../Frameworks rpath"
    codesign --verify --deep --strict "$fw" 2>/dev/null && pass "$exe Sparkle.framework verifies (inside-out signed)" || fail "$exe Sparkle.framework signature broken"
    for xpc in Installer Downloader; do
        codesign --verify --strict "$fw/Versions/B/XPCServices/$xpc.xpc" 2>/dev/null && pass "$exe $xpc.xpc verifies" || fail "$exe $xpc.xpc signature broken"
    done
    assert_eq "$exe Sparkle signing authority matches app" "$(codesign -dvv "$app" 2>&1 | grep '^Authority=' | head -1)" "$(codesign -dvv "$fw" 2>&1 | grep '^Authority=' | head -1)"
    # Plist keys.
    local info="$app/Contents/Info.plist"
    if [ "$(plist "$info" MSDevBuild)" = "true" ]; then
        assert_eq "$exe SUEnableAutomaticChecks (dev)" "false" "$(plist "$info" SUEnableAutomaticChecks)"
    else
        assert_eq "$exe SUFeedURL" "https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml" "$(plist "$info" SUFeedURL)"
        assert_eq "$exe SUEnableAutomaticChecks" "true" "$(plist "$info" SUEnableAutomaticChecks)"
        assert_eq "$exe SUScheduledCheckInterval" "21600" "$(plist "$info" SUScheduledCheckInterval)"
        assert_eq "$exe SUAutomaticallyUpdate" "true" "$(plist "$info" SUAutomaticallyUpdate)"
        assert_eq "$exe SUVerifyUpdateBeforeExtraction" "true" "$(plist "$info" SUVerifyUpdateBeforeExtraction)"
    fi
    for k in SUEnableInstallerLauncherService SUEnableDownloaderService SUEnableInstallerConnectionService SUEnableInstallerStatusService; do
        plist "$info" "$k" >/dev/null && fail "$exe sets $k (sandbox-only, must be absent)"
    done
    if [ -n "${SPARKLE_PUBLIC_ED_KEY:-}" ]; then
        assert_eq "$exe SUPublicEDKey (env override)" "$SPARKLE_PUBLIC_ED_KEY" "$(plist "$info" SUPublicEDKey)"
    elif [ -f "$SCRIPT_DIR/SUPublicEDKey" ]; then
        assert_eq "$exe SUPublicEDKey (committed file)" "$(tr -d '[:space:]' < "$SCRIPT_DIR/SUPublicEDKey")" "$(plist "$info" SUPublicEDKey)"
    else
        echo "  ⚠ $exe: no Sparkle public key available to assert (rt-tray/SUPublicEDKey or SPARKLE_PUBLIC_ED_KEY)"
    fi
}
check_sparkle "$PROD"
[ -n "$DEV" ] && check_sparkle "$DEV"
```

- [ ] **Step 4: Run + commit**

Run: `cd rt-tray && RT_DAEMON_BIN=../dist/rt SPARKLE_PUBLIC_ED_KEY=$(openssl rand -base64 32) ./check-bundle.sh` → `0 failed` (the throwaway key proves the env override path end to end).

```bash
git add rt-tray/check-bundle.sh
git commit -m "MAT-383: Sparkle — embedded framework + rpath + inside-out signature assertions in check-bundle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `scripts/release/` — zip, DMG, notarize, appcast

**Files:**
- Create: `scripts/release/make-zip.sh`
- Create: `scripts/release/make-dmg.sh`
- Create: `scripts/release/notarize.sh`
- Create: `scripts/release/appcast.sh`
- Modify: `scripts/README.md` (document the four + `fetch-deps.sh`)

**Interfaces:**
- `make-zip.sh <app> <out.zip>` → `ditto -c -k --sequesterRsrc --keepParent`; exit 0, zip exists.
- `make-dmg.sh <app> <out.dmg> [signing-identity]` → APFS/LZFSE DMG named `mattstack` with an `Applications` symlink; signed when an identity is given.
- `notarize.sh <path.app|path.dmg>` → needs `APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID`; submits (`.app` via a temporary zip), waits, prints the notary log on failure, staples and validates the target. **ORCHESTRATOR-ONLY to run**; implementers only `bash -n`.
- `appcast.sh <archives-dir> <tag>` → needs `SPARKLE_ED_KEY` (private EdDSA key, the exact content of `generate_keys -x`'s file) and `rt-tray/deps/tools/sparkle/bin/generate_appcast`; pulls the previous `appcast.xml` + up to 2 previous zips into `<archives-dir>` so deltas are generated, runs `generate_appcast --download-url-prefix https://github.com/m4ttstack/rt/releases/download/<tag>/ --maximum-versions 3`, then deletes the downloaded old zips so only new files get uploaded. Output: `<archives-dir>/appcast.xml`, `<archives-dir>/*.delta`.

- [ ] **Step 1: make-zip.sh**

```bash
#!/bin/bash
# scripts/release/make-zip.sh <app> <out.zip> — the Sparkle enclosure.
set -euo pipefail
APP="$1"; OUT="$2"
[ -d "$APP" ] || { echo "✗ no app at $APP" >&2; exit 1; }
rm -f "$OUT"; mkdir -p "$(dirname "$OUT")"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT"
echo "✓ $(du -h "$OUT" | cut -f1) $OUT"
```

- [ ] **Step 2: make-dmg.sh**

```bash
#!/bin/bash
# scripts/release/make-dmg.sh <app> <out.dmg> [signing-identity]
# First-install disk image: APFS, LZFSE, volume "mattstack", drag-to-Applications.
set -euo pipefail
APP="$1"; OUT="$2"; IDENTITY="${3:-}"
[ -d "$APP" ] || { echo "✗ no app at $APP" >&2; exit 1; }
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/$(basename "$APP")"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"; mkdir -p "$(dirname "$OUT")"
hdiutil create -volname "mattstack" -srcfolder "$STAGE" -ov -fs APFS -format ULFO -quiet "$OUT"
if [ -n "$IDENTITY" ]; then
    codesign --force --sign "$IDENTITY" --timestamp "$OUT"
    echo "✓ signed $OUT"
fi
echo "✓ $(du -h "$OUT" | cut -f1) $OUT"
```

- [ ] **Step 3: notarize.sh**

```bash
#!/bin/bash
# scripts/release/notarize.sh <target.app|target.dmg>
# Submits to Apple's notary service, waits, staples, validates. Env:
# APPLE_ID APPLE_ID_PASSWORD APPLE_TEAM_ID. On rejection prints the notary log.
set -euo pipefail
TARGET="$1"
: "${APPLE_ID:?}" "${APPLE_ID_PASSWORD:?}" "${APPLE_TEAM_ID:?}"
[ -e "$TARGET" ] || { echo "✗ no such target $TARGET" >&2; exit 1; }

SUBMIT="$TARGET"
TMP=""
case "$TARGET" in
    *.app)
        TMP="$(mktemp -d)"; SUBMIT="$TMP/$(basename "$TARGET" .app).zip"
        ditto -c -k --keepParent "$TARGET" "$SUBMIT" ;;
    *.dmg) ;;
    *) echo "✗ notarize.sh handles .app and .dmg only" >&2; exit 2 ;;
esac
trap '[ -n "$TMP" ] && rm -rf "$TMP"' EXIT

echo "→ submitting $(basename "$SUBMIT") for notarization…"
RESULT="$(xcrun notarytool submit "$SUBMIT" --apple-id "$APPLE_ID" --password "$APPLE_ID_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait --timeout 45m --output-format json)"
ID="$(printf '%s' "$RESULT" | /usr/bin/plutil -extract id raw -o - - 2>/dev/null || printf '%s' "$RESULT" | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' | head -1)"
STATUS="$(printf '%s' "$RESULT" | sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p' | head -1)"
echo "  submission $ID → $STATUS"
if [ "$STATUS" != "Accepted" ]; then
    xcrun notarytool log "$ID" --apple-id "$APPLE_ID" --password "$APPLE_ID_PASSWORD" --team-id "$APPLE_TEAM_ID" || true
    exit 1
fi
xcrun stapler staple "$TARGET"
xcrun stapler validate "$TARGET"
echo "✓ notarized + stapled $TARGET"
```

- [ ] **Step 4: appcast.sh**

```bash
#!/bin/bash
# scripts/release/appcast.sh <archives-dir> <tag>
# Generates/updates appcast.xml for the zip in <archives-dir>. Pulls the
# previous feed + up to two previous enclosures (for deltas) from the
# latest GitHub Release, signs with SPARKLE_ED_KEY (stdin to generate_appcast),
# and leaves only NEW files in <archives-dir>: the new zip, *.delta, appcast.xml.
set -euo pipefail
ARCHIVES="$1"; TAG="$2"
: "${SPARKLE_ED_KEY:?private EdDSA key required}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GEN="$ROOT/rt-tray/deps/tools/sparkle/bin/generate_appcast"
[ -x "$GEN" ] || { echo "✗ $GEN missing — run scripts/fetch-deps.sh" >&2; exit 1; }
REPO="${GITHUB_REPOSITORY:-m4ttstack/rt}"
PREFIX="https://github.com/$REPO/releases/download/$TAG/"

NEW_ZIP="$(ls "$ARCHIVES"/mattstack-*.zip | head -1)"
[ -f "$NEW_ZIP" ] || { echo "✗ no mattstack-*.zip in $ARCHIVES" >&2; exit 1; }

OLD_FILES=()
if curl -fsSL -o "$ARCHIVES/appcast.xml" "https://github.com/$REPO/releases/latest/download/appcast.xml"; then
    echo "→ previous appcast fetched"
    # Enclosure URLs, newest first; the two newest become delta sources.
    for url in $(grep -o 'url="[^"]*\.zip"' "$ARCHIVES/appcast.xml" | sed 's/url="//; s/"$//' | head -2); do
        f="$ARCHIVES/$(basename "$url")"
        if [ "$f" != "$NEW_ZIP" ] && curl -fsSL -o "$f" "$url"; then OLD_FILES+=("$f"); echo "  fetched $(basename "$f") for deltas"; fi
    done
else
    rm -f "$ARCHIVES/appcast.xml"
    echo "→ no previous appcast (first release)"
fi

printf '%s' "$SPARKLE_ED_KEY" | "$GEN" --ed-key-file - \
    --download-url-prefix "$PREFIX" \
    --maximum-versions 3 \
    --link "https://github.com/$REPO/releases" \
    "$ARCHIVES"

for f in "${OLD_FILES[@]+"${OLD_FILES[@]}"}"; do rm -f "$f"; done
rm -rf "$ARCHIVES/old_updates"
grep -q "$(basename "$NEW_ZIP")" "$ARCHIVES/appcast.xml" || { echo "✗ appcast.xml does not reference $(basename "$NEW_ZIP")" >&2; exit 1; }
echo "✓ appcast.xml updated; deltas: $(ls "$ARCHIVES"/*.delta 2>/dev/null | wc -l | tr -d ' ')"
```

- [ ] **Step 5: Local dry run of the two runnable scripts + syntax of all**

Run: `chmod +x scripts/release/*.sh && bash -n scripts/release/*.sh && scripts/release/make-zip.sh rt-tray/mattstack.app rt-tray/out/mattstack-0.0.0.zip && scripts/release/make-dmg.sh rt-tray/mattstack.app rt-tray/out/mattstack-0.0.0.dmg && hdiutil attach rt-tray/out/mattstack-0.0.0.dmg -quiet -mountpoint /tmp/ms-dmg && ls /tmp/ms-dmg && hdiutil detach /tmp/ms-dmg -quiet`
Expected: zip and dmg exist; the mounted DMG lists `Applications mattstack.app`. Then a local appcast run with a throwaway key (no network needed for the generate step when no previous appcast exists — `curl` to the release URL fails gracefully): `cd rt-tray && SPARKLE_ED_KEY="$(deps/tools/sparkle/bin/generate_keys -x /dev/stdout 2>/dev/null || true)"` — if the Keychain prompt is undesirable, skip this and rely on Task 15 (ORCHESTRATOR) for the first real appcast. `bash -n` and the zip/dmg runs are the required local evidence.

- [ ] **Step 6: scripts/README.md** — add a `## release/` section listing the four scripts with one line each and `## fetch-deps.sh` (one line: fetch + verify helpers per `rt-tray/deps.lock`).

- [ ] **Step 7: Commit**

```bash
git add scripts/release scripts/README.md
git commit -m "MAT-383: release scripts — zip enclosure, APFS DMG, notarize+staple, Sparkle appcast with deltas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7 (MATT): Sparkle EdDSA key pair → 1Password + `SPARKLE_ED_KEY` secret + committed public key

**Files:**
- Create: `rt-tray/SUPublicEDKey` (one line: the base64 public key)

**Interfaces:**
- Produces: GitHub secret `SPARKLE_ED_KEY` on m4ttstack/rt (private key file content); `rt-tray/SUPublicEDKey` consumed by build.sh (Task 4) and check-bundle (Task 5).

- [ ] **Step 1 (MATT, on the live machine):**

```bash
cd /Users/matt/Documents/GitHub/repo-tools-l4-wt
scripts/fetch-deps.sh arm64                                # brings rt-tray/deps/tools/sparkle
rt-tray/deps/tools/sparkle/bin/generate_keys               # creates the key in the login Keychain, prints the public key
rt-tray/deps/tools/sparkle/bin/generate_keys -p > rt-tray/SUPublicEDKey
rt-tray/deps/tools/sparkle/bin/generate_keys -x "$HOME/Desktop/mattstack-sparkle-private.key"
# → store mattstack-sparkle-private.key in 1Password (item "mattstack Sparkle EdDSA private key"), then:
gh secret set SPARKLE_ED_KEY -R m4ttstack/rt < "$HOME/Desktop/mattstack-sparkle-private.key"
rm -P "$HOME/Desktop/mattstack-sparkle-private.key"
```

- [ ] **Step 2: Verify + commit**

`cat rt-tray/SUPublicEDKey` is a single base64 line (44 chars). `gh secret list -R m4ttstack/rt` lists `SPARKLE_ED_KEY`.

```bash
git add rt-tray/SUPublicEDKey
git commit -m "MAT-383: Sparkle public EdDSA key for mattstack.app

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(A lost private key means every installed app must be reinstalled by hand — the 1Password copy is the only backup. Never commit it; never echo it in CI logs.)

---

### Task 8: `.github/workflows/release.yml` rewrite — release job + clean-room job, tag or dry run

**Files:**
- Rewrite: `.github/workflows/release.yml`
- Create: `lib/__tests__/release-workflow.test.ts` (shape assertions on the YAML)

**Interfaces:**
- Consumes: `scripts/fetch-deps.sh`, `rt-tray/build.sh` (env contract of Task 4), `scripts/release/*.sh` (Task 6), secrets `APPLE_CERT_P12_BASE64`, `APPLE_CERT_P12_PASSWORD`, `APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID`, `SPARKLE_ED_KEY`.
- Consumes (L7): `scripts/e2e-cleanroom.sh <zip>` — the clean-room job calls it; L7 owns it.
- Produces: Release assets `mattstack-<ver>.dmg`, `mattstack-<ver>.zip`, `*.delta`, `appcast.xml`, `SHA256SUMS`; on `workflow_dispatch` (dry run) the same files as a workflow artifact named `release-dry-run` and no Release.

- [ ] **Step 1: Write the workflow**

```yaml
name: Release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: write

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

jobs:
  release:
    runs-on: macos-latest
    outputs:
      version: ${{ steps.meta.outputs.version }}
      tag: ${{ steps.meta.outputs.tag }}
      publish: ${{ steps.meta.outputs.publish }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Release metadata
        id: meta
        run: |
          if [ "${GITHUB_EVENT_NAME}" = "push" ]; then
            TAG="${GITHUB_REF_NAME}"; PUBLISH=true
          else
            TAG="v0.0.0-ci${GITHUB_RUN_NUMBER}"; PUBLISH=false
          fi
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "version=${TAG#v}" >> "$GITHUB_OUTPUT"
          echo "publish=$PUBLISH" >> "$GITHUB_OUTPUT"

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.13
      - name: Install dependencies
        run: bun install

      # ── Developer ID (required on a tag; ad-hoc on a dry run) ────────────────
      - name: Check signing secrets
        id: signing
        env:
          CERT_B64: ${{ secrets.APPLE_CERT_P12_BASE64 }}
          PUBLISH: ${{ steps.meta.outputs.publish }}
        run: |
          if [ -n "$CERT_B64" ]; then
            echo "available=true" >> $GITHUB_OUTPUT
          elif [ "$PUBLISH" = "true" ]; then
            echo "::error::Developer ID secrets missing — a tagged release must be signed and notarized"; exit 1
          else
            echo "available=false" >> $GITHUB_OUTPUT
            echo "::warning::Developer ID secrets not configured — dry run will be ad-hoc signed"
          fi

      - name: Import Developer ID certificate
        if: steps.signing.outputs.available == 'true'
        env:
          APPLE_CERT_P12_BASE64: ${{ secrets.APPLE_CERT_P12_BASE64 }}
          APPLE_CERT_P12_PASSWORD: ${{ secrets.APPLE_CERT_P12_PASSWORD }}
        run: |
          KEYCHAIN_PATH="$RUNNER_TEMP/rt-signing.keychain-db"
          KEYCHAIN_PASSWORD=$(openssl rand -base64 24)
          CERT_PATH="$RUNNER_TEMP/cert.p12"
          echo "$APPLE_CERT_P12_BASE64" | base64 --decode > "$CERT_PATH"
          security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          security import "$CERT_PATH" -P "$APPLE_CERT_P12_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN_PATH"
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          security list-keychains -d user -s "$KEYCHAIN_PATH" $(security list-keychains -d user | tr -d '"')
          SIGNING_IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" | grep "Developer ID Application" | head -1 | awk -F'"' '{print $2}')
          [ -n "$SIGNING_IDENTITY" ] || { echo "::error::Developer ID Application certificate not found"; exit 1; }
          echo "SIGNING_IDENTITY=$SIGNING_IDENTITY" >> $GITHUB_ENV
          echo "KEYCHAIN_PATH=$KEYCHAIN_PATH" >> $GITHUB_ENV
          rm -f "$CERT_PATH"

      # ── Inputs to the bundle ─────────────────────────────────────────────────
      - name: Compile rt (arm64)
        run: bun build --compile --target=bun-darwin-arm64 ./cli.ts --outfile dist/rt --define RT_VERSION='"${{ steps.meta.outputs.tag }}"'

      - name: Fetch bundled dependencies
        run: scripts/fetch-deps.sh arm64

      - name: Build extension
        run: |
          cd extensions/vscode/rt-context
          bun install
          bun run package
          echo "RT_VSIX=$(ls "$PWD"/*.vsix | head -1)" >> $GITHUB_ENV

      # ── The app (build.sh signs inside-out with the imported identity) ───────
      - name: Build mattstack.app
        env:
          RT_DAEMON_BIN: ${{ github.workspace }}/dist/rt
          RT_VERSION: ${{ steps.meta.outputs.tag }}
          RT_REQUIRE_DEPS: "1"
          RT_BUILD_TOOL: swift
        run: rt-tray/build.sh release

      - name: Assert the bundle contract
        run: rt-tray/check-bundle.sh --app rt-tray/mattstack.app

      - name: Notarize and staple the app
        if: steps.signing.outputs.available == 'true'
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_ID_PASSWORD: ${{ secrets.APPLE_ID_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: scripts/release/notarize.sh rt-tray/mattstack.app

      # ── Artifacts ────────────────────────────────────────────────────────────
      - name: Zip enclosure + DMG
        env:
          VERSION: ${{ steps.meta.outputs.version }}
        run: |
          mkdir -p out
          scripts/release/make-zip.sh rt-tray/mattstack.app "out/mattstack-${VERSION}.zip"
          scripts/release/make-dmg.sh rt-tray/mattstack.app "out/mattstack-${VERSION}.dmg" "${SIGNING_IDENTITY:-}"

      - name: Notarize and staple the DMG
        if: steps.signing.outputs.available == 'true'
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_ID_PASSWORD: ${{ secrets.APPLE_ID_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          VERSION: ${{ steps.meta.outputs.version }}
        run: scripts/release/notarize.sh "out/mattstack-${VERSION}.dmg"

      - name: Appcast (signed, with deltas)
        if: steps.meta.outputs.publish == 'true'
        env:
          SPARKLE_ED_KEY: ${{ secrets.SPARKLE_ED_KEY }}
        run: |
          [ -n "$SPARKLE_ED_KEY" ] || { echo "::error::SPARKLE_ED_KEY secret missing"; exit 1; }
          scripts/release/appcast.sh out "${{ steps.meta.outputs.tag }}"

      - name: Checksums
        run: cd out && shasum -a 256 mattstack-*.dmg mattstack-*.zip *.delta appcast.xml 2>/dev/null > SHA256SUMS; cat out/SHA256SUMS

      - name: Cleanup keychain
        if: always() && env.KEYCHAIN_PATH != ''
        run: security delete-keychain "$KEYCHAIN_PATH" || true

      # ── Publish ──────────────────────────────────────────────────────────────
      - name: Ensure release notes exist
        if: steps.meta.outputs.publish == 'true'
        run: '[ -f RELEASE_NOTES.md ] || echo "Release ${GITHUB_REF_NAME}." > RELEASE_NOTES.md'

      - name: Create Release
        if: steps.meta.outputs.publish == 'true'
        uses: softprops/action-gh-release@v2
        with:
          body_path: RELEASE_NOTES.md
          files: |
            out/mattstack-*.dmg
            out/mattstack-*.zip
            out/*.delta
            out/appcast.xml
            out/SHA256SUMS

      - name: Upload dry-run artifacts
        if: steps.meta.outputs.publish != 'true'
        uses: actions/upload-artifact@v4
        with:
          name: release-dry-run
          path: out/
          retention-days: 7

  # ── Clean room (spec §12.2 layer a): a fresh runner installs from the zip ───
  clean-room:
    needs: release
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout: |
            scripts
            rt-tray

      - name: Download the app zip (release)
        if: needs.release.outputs.publish == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          mkdir -p "$RUNNER_TEMP/dl"
          gh release download "${{ needs.release.outputs.tag }}" -R "$GITHUB_REPOSITORY" -p "mattstack-*.zip" -D "$RUNNER_TEMP/dl"

      - name: Download the app zip (dry run)
        if: needs.release.outputs.publish != 'true'
        uses: actions/download-artifact@v4
        with:
          name: release-dry-run
          path: ${{ runner.temp }}/dl

      - name: Headless install + verify
        run: scripts/e2e-cleanroom.sh "$(ls "$RUNNER_TEMP"/dl/mattstack-*.zip | head -1)"
```

The clean-room job's contract with L7's `scripts/e2e-cleanroom.sh` (cross-plan review §5 #36/#46): the job passes the zip **positionally** (`scripts/e2e-cleanroom.sh "<zip>"`) and L7's script accepts a positional `<zip|dmg|app>` as `--artifact`; the script does `ditto -x -k` into `/Applications`, runs `/Applications/mattstack.app/Contents/MacOS/rt --post-install --non-interactive --team-of-one --no-launch` (its defaults; `CI=true` also implies `--no-launch`), puts `~/.local/bin` on PATH, `rt --version`, `rt daemon install`, `rt verify --ci`, and runs `rt-tray/check-bundle.sh --app /Applications/mattstack.app` when present — the sparse checkout above includes `rt-tray` for that reason. Until L7's script lands, the job fails with "No such file" — that is the intended dependency signal, not something to paper over with an inline copy.

- [ ] **Step 2: Shape test (keeps the job names/steps honest without running CI)**

```ts
// lib/__tests__/release-workflow.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const wf = parse(readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "release.yml"), "utf8"));
const stepNames = (job: string): string[] => wf.jobs[job].steps.map((s: any) => s.name ?? s.uses);

describe("release.yml", () => {
  test("triggers on v* tags and manual dispatch; two jobs", () => {
    expect(wf.on.push.tags).toEqual(["v*"]);
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(Object.keys(wf.jobs)).toEqual(["release", "clean-room"]);
    expect(wf.jobs["clean-room"].needs).toBe("release");
  });
  test("arm64 only — no x64 compile, no tarballs", () => {
    const text = JSON.stringify(wf);
    expect(text).not.toContain("bun-darwin-x64");
    expect(text).not.toContain("tar.gz");
    expect(text).toContain("bun-darwin-arm64");
  });
  test("the train is ordered: compile → deps → build → contract → notarize app → zip/dmg → notarize dmg → appcast → release", () => {
    const names = stepNames("release");
    const idx = (n: string) => names.findIndex((s) => s.startsWith(n));
    expect(idx("Compile rt")).toBeLessThan(idx("Fetch bundled dependencies"));
    expect(idx("Fetch bundled dependencies")).toBeLessThan(idx("Build mattstack.app"));
    expect(idx("Build mattstack.app")).toBeLessThan(idx("Assert the bundle contract"));
    expect(idx("Assert the bundle contract")).toBeLessThan(idx("Notarize and staple the app"));
    expect(idx("Notarize and staple the app")).toBeLessThan(idx("Zip enclosure + DMG"));
    expect(idx("Zip enclosure + DMG")).toBeLessThan(idx("Notarize and staple the DMG"));
    expect(idx("Notarize and staple the DMG")).toBeLessThan(idx("Appcast"));
    expect(idx("Appcast")).toBeLessThan(idx("Create Release"));
  });
  test("release assets are the dmg, the zip, deltas, appcast, checksums", () => {
    const step = wf.jobs.release.steps.find((s: any) => s.name === "Create Release");
    expect(step.with.files).toContain("out/mattstack-*.dmg");
    expect(step.with.files).toContain("out/mattstack-*.zip");
    expect(step.with.files).toContain("out/appcast.xml");
    expect(step.with.files).toContain("out/*.delta");
  });
  test("clean room runs L7's script, not inline steps, and never installs brew packages", () => {
    const text = JSON.stringify(wf.jobs["clean-room"]);
    expect(text).toContain("scripts/e2e-cleanroom.sh");
    expect(text).not.toContain("brew install");
  });
  test("bun is pinned to the deps.lock version", () => {
    const lock = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "rt-tray", "deps.lock"), "utf8"));
    const bun = lock.tools.find((t: any) => t.name === "bun").version;
    const setup = wf.jobs.release.steps.find((s: any) => String(s.uses ?? "").startsWith("oven-sh/setup-bun"));
    expect(setup.with["bun-version"]).toBe(bun);
  });
});
```

Run: `bun test lib/__tests__/release-workflow.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml lib/__tests__/release-workflow.test.ts
git commit -m "MAT-383: release.yml — arm64 app train (deps, build, notarize, dmg, zip, appcast) + clean-room job; tarballs gone

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: rt side — `installRtBinary` symlink, `trayAppPath` via `mattstack.appPath`, `legacyUserAppPath`

**Trimmed by the cross-plan review (§1 row 1):** `commands/post-install.ts` and `lib/__tests__/post-install-sweep.test.ts` are L1 T27/T24's. L1 T27 absorbs verbatim the `appPathIsTransient`/exit-2 refusal, the `runLegacySweep(root)` body and its new sweep test case that this task previously carried (they live in this file at commit `4d36c2d`, L4:1928-1937 and L4:1985-2127); L1 T24 `settings.seed` records `mattstack.appPath` via `bundleRootFromExec()`; L1 T5 `path.link` calls `installRtBinary`. This task now ships only the two library modules L1 consumes.

**Files:**
- Modify: `lib/dev-mode.ts:37-50` (`installRtBinary` → atomic symlink)
- Modify: `lib/rt-paths.ts:116-131` (`trayAppPath`/`devTrayAppPath` read the machine key, default `/Applications`; `legacyUserAppPath()`)
- ~~Modify: `commands/post-install.ts`~~ — Dropped — owned by L1 T27/T24 (cross-plan review).
- Modify: `lib/__tests__/dev-mode.test.ts`, `lib/__tests__/rt-paths.test.ts:160-180`, `lib/__tests__/dev-mode-handoff.test.ts` (fake bundle path)
- ~~Modify: `lib/__tests__/post-install-sweep.test.ts`~~ — Dropped — owned by L1 T27 (cross-plan review).

**Interfaces:**
- Consumes: `installedTrayAppPath` (existing; already reads `mattstack.appPath`).
- Produces: `installRtBinary(src): string` now creates `~/.local/bin/rt -> src` (symlink, link-then-rename); `trayAppPath(exists?)`, `devTrayAppPath(exists?)`; `legacyUserAppPath()`. (Post-install exit code 2 on a DMG/translocated path is produced by L1 T27/T24.)

- [ ] **Step 1: Failing tests**

Add to `lib/__tests__/dev-mode.test.ts`:
```ts
import { lstatSync, readlinkSync, realpathSync } from "fs";
import { installRtBinary } from "../dev-mode.ts";

describe("installRtBinary", () => {
  const BIN = join(process.env.HOME!, ".local", "bin");
  afterEach(() => { try { rmSync(join(BIN, "rt")); } catch { /* absent */ } });

  test("creates ~/.local/bin/rt as a symlink to the given binary", () => {
    const src = join(process.env.HOME!, "mattstack.app", "Contents", "MacOS", "rt");
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o755 });
    const dest = installRtBinary(src);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(src);
    expect(currentMode()).toBe("prod");
  });

  test("replaces an existing regular file (the dev wrapper) and an existing link atomically", () => {
    mkdirSync(BIN, { recursive: true });
    writeFileSync(join(BIN, "rt"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const src = join(process.env.HOME!, "app-a", "Contents", "MacOS", "rt");
    mkdirSync(dirname(src), { recursive: true }); writeFileSync(src, "", { mode: 0o755 });
    installRtBinary(src);
    expect(realpathSync(join(BIN, "rt"))).toBe(realpathSync(src));
    const src2 = join(process.env.HOME!, "app-b", "Contents", "MacOS", "rt");
    mkdirSync(dirname(src2), { recursive: true }); writeFileSync(src2, "", { mode: 0o755 });
    installRtBinary(src2);
    expect(readlinkSync(join(BIN, "rt"))).toBe(src2);
  });

  test("currentMode reads through the link: a link to a script is dev, to a Mach-O is prod", () => {
    const script = join(process.env.HOME!, "wrapper.sh");
    writeFileSync(script, "#!/bin/zsh\nexit 0\n", { mode: 0o755 });
    installRtBinary(script);
    expect(currentMode()).toBe("dev");
  });
});
```
(add `dirname` to the `path` import and `lstatSync, readlinkSync, realpathSync` to the `fs` import.)

Replace `lib/__tests__/rt-paths.test.ts` tests at lines 167-180 with:
```ts
  test("trayAppPath prefers the installed bundle (machine key, /Applications, ~/Applications) and defaults to /Applications", () => {
    const none = () => false;
    expect(trayAppPath(none)).toBe("/Applications/mattstack.app");
    expect(devTrayAppPath(none)).toBe("/Applications/mattstack-dev.app");
    const userOnly = (p: string) => p === join(process.env.HOME!, "Applications", "mattstack.app");
    expect(trayAppPath(userOnly)).toBe(join(process.env.HOME!, "Applications", "mattstack.app"));
  });
```

In `lib/__tests__/dev-mode-handoff.test.ts`: define `const FAKE_PROD_APP = join(HOME, "Applications", TRAY_APP_BUNDLE)` and `const FAKE_DEV_APP = join(HOME, "Applications", DEV_TRAY_APP_BUNDLE)` (import the two constants from `../rt-paths.ts` instead of `trayAppPath`/`devTrayAppPath`), and use them wherever the test previously called `trayAppPath()`/`devTrayAppPath()` (the `mkdirSync`/`writeFileSync` of the fake bundles and the `expect(openLine).toContain(...)` assertions). `isolatedExists` already denies `/Applications/`, so `installedTrayAppPath(..., isolatedExists)` finds the fake under `~/Applications`.

(The `post-install-sweep.test.ts` case for the stale `~/Applications/mattstack.app` copy + unconditional `com.rt.daemon` bootout is L1 T27's — Dropped here, cross-plan review §1 row 1.)

Run: `bun test lib/__tests__/dev-mode.test.ts lib/__tests__/rt-paths.test.ts` → FAIL (symlink, signature).

- [ ] **Step 2: Implement `lib/dev-mode.ts`**

```ts
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, symlinkSync } from "fs";
…
/**
 * Link ~/.local/bin/rt at `src` (the rt inside the app bundle). Link-then-
 * rename so a process executing the old target keeps its mapped pages and
 * the switch is atomic whether the old entry was a file or a link.
 */
export function installRtBinary(src: string): string {
  const dest = rtBinaryPath();
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.new`;
  rmSync(tmp, { force: true });
  symlinkSync(src, tmp);
  renameSync(tmp, dest);
  return dest;
}
```
(`copyFileSync`/`chmodSync` imports drop out if now unused.) `currentMode()` is unchanged — `existsSync`/`openSync` follow symlinks, which is the "reads through links" requirement.

- [ ] **Step 3: Implement `lib/rt-paths.ts`**

```ts
/** Where the prod bundle is: the machine key / /Applications / ~/Applications, defaulting to /Applications (V3). */
export function trayAppPath(exists: (path: string) => boolean = existsSync): string {
  return installedTrayAppPath(TRAY_APP_BUNDLE, exists) ?? join("/Applications", TRAY_APP_BUNDLE);
}

/** Same for the dev bundle. */
export function devTrayAppPath(exists: (path: string) => boolean = existsSync): string {
  return installedTrayAppPath(DEV_TRAY_APP_BUNDLE, exists) ?? join("/Applications", DEV_TRAY_APP_BUNDLE);
}

/** The phase-1 install location, swept when the app now lives elsewhere (V3). */
export function legacyUserAppPath(): string {
  return join(home(), "Applications", TRAY_APP_BUNDLE);
}
```
`installedTrayAppPath` must be declared before use — move the two functions below it or leave hoisting to do its job (function declarations hoist; fine). Update the docblock above them: "Where a bundle is ACTUALLY installed…" now applies to both.

- [ ] **Step 4: Implement `commands/post-install.ts` changes**

Dropped — owned by L1 T27/T24 (cross-plan review): L1 T27 rewrites `commands/post-install.ts` as sweep → `setupApply([...])` with `runPostInstall(args: string[], opts: { bundleRoot?: string | null } = {})`, absorbing this task's former `appPathIsTransient` exit-2 refusal and `runLegacySweep(root)` body; `recordAppPath`/`installRtBinaryStep`/`findVsix` become L1's `settings.seed`/`path.link`/`extension.install` apply steps. L1 T27 runs AFTER this task merges (it imports `installRtBinary`, `legacyUserAppPath`, `bundleRootFromExec`).

- [ ] **Step 5: Run + typecheck + commit**

Run: `bun test && bunx tsc --noEmit` → green (`commands/post-install.ts` still calls `installRtBinary(src)` with the same signature, so the existing `post-install-sweep.test.ts` stays green untouched until L1 T27 rewrites both).

```bash
git add lib/dev-mode.ts lib/rt-paths.ts lib/__tests__/dev-mode.test.ts lib/__tests__/rt-paths.test.ts lib/__tests__/dev-mode-handoff.test.ts
git commit -m "MAT-383: installRtBinary links into the bundle; trayAppPath honours mattstack.appPath; legacyUserAppPath

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: `rt update` is thin — ask the app (`POST /update/check`)

Dropped — owned by L1 T30 (`commands/update.ts`: `POST /update/check` via `trayRequest`, exit **2** + `--json` envelope per the contract — ruling R4) and L1 T10 (`cli.ts` first-run hook) (cross-plan review §1 rows 2, 4). L1 T30 adopts this task's injectable `deps` shape (`tray`, `currentMode`, `log`, `exit`), the `res.ok === false` "this mattstack.app predates CLI-triggered updates — use the menu bar" branch, and `RELEASES_URL = https://github.com/m4ttstack/rt/releases/latest`; the former body is in this file at commit `4d36c2d` (L4:2146-2266). Task 12 regenerates `website/docs/reference/update.mdx` after L1 T30 merges.

---

### Task 11: Bundled fzf first, terminal-notifier dropped (`rt verify` rows are L1's)

**Files:**
- Modify: `lib/fzf.ts`
- Modify: `lib/__tests__/fzf.test.ts`
- ~~Modify: `commands/verify.ts`~~ — Dropped — owned by L1 T7/T11 (cross-plan review §1 row 3): L1 T7 adds the `tool.rt-link` and `tool.vsix` rows to the rt-health table and makes `tool.fzf` report `resolveFzf()`'s "bundled | PATH"; L1 T11 turns the table into `rt verify`'s rows. Nothing from this task's former verify.ts edit is lost.
- Modify: `lib/notifier.ts:225-296` (osascript only), `lib/__tests__/notifier-fallback.test.ts`
- `e2e/tests/verify.test.ts` unaffected (no check name changes here).

**Interfaces:**
- Consumes: `bundledHelperPath("fzf")`, `appBundleRoot()` (Task 1).
- Produces: `resolveFzf(which?, bundled?)` — bundled path first, then PATH (L1 T7 consumes it for the `tool.fzf` row); `FZF_MISSING_MESSAGE` names the bundle; `__test__.setFallbackNotifier(argv0 | null)` replaces `setTerminalNotifierPath`.

- [ ] **Step 1: fzf tests (replace the file)**

```ts
import { describe, test, expect } from "bun:test";
import { resolveFzf, ensureFzf, FZF_MISSING_MESSAGE } from "../fzf.ts";

describe("resolveFzf", () => {
  test("prefers the fzf bundled inside mattstack.app", () => {
    expect(resolveFzf(() => "/opt/homebrew/bin/fzf", () => "/Applications/mattstack.app/Contents/Helpers/fzf"))
      .toBe("/Applications/mattstack.app/Contents/Helpers/fzf");
  });
  test("falls back to PATH when nothing is bundled (source runs, dev mode)", () => {
    expect(resolveFzf(() => "/opt/homebrew/bin/fzf", () => null)).toBe("/opt/homebrew/bin/fzf");
  });
  test("null when neither exists", () => {
    expect(resolveFzf(() => null, () => null)).toBeNull();
  });
});

describe("ensureFzf", () => {
  test("returns the resolved path when present", () => {
    expect(ensureFzf(() => null, (msg) => { throw new Error(msg); }, () => "/x/fzf")).toBe("/x/fzf");
  });
  test("fails with an actionable message naming the bundle when missing", () => {
    let captured = "";
    expect(() => ensureFzf(() => null, (msg) => { captured = msg; throw new Error("would-exit"); }, () => null)).toThrow("would-exit");
    expect(captured).toContain("fzf not found");
    expect(captured).toContain("mattstack.app");
  });
});

describe("FZF_MISSING_MESSAGE", () => {
  test("says where rt looks and what to do", () => {
    expect(FZF_MISSING_MESSAGE).toContain("Contents/Helpers/fzf");
    expect(FZF_MISSING_MESSAGE).toContain("brew install fzf");
  });
});
```

- [ ] **Step 2: `lib/fzf.ts`**

```ts
/**
 * fzf is a hard dependency of rt: every interactive picker shells out to it.
 * rt uses the copy bundled inside mattstack.app by absolute path (ruling 8)
 * and only falls back to PATH when it is not running from an install
 * (source checkout, dev mode). Every fzf spawn site calls ensureFzf() first.
 */
import { bundledHelperPath } from "./bundle-layout.ts";
import { bold, dim, yellow, reset } from "./tui.ts";

type Which = (bin: string) => string | null;
type Bundled = () => string | null;
const defaultWhich: Which = (b) => Bun.which(b);
const defaultBundled: Bundled = () => bundledHelperPath("fzf");

/** Bundled fzf first, then PATH; null when neither. Injectable for tests. */
export function resolveFzf(which: Which = defaultWhich, bundled: Bundled = defaultBundled): string | null {
  return bundled() ?? which("fzf");
}

export const FZF_MISSING_MESSAGE =
  `\n  ${yellow}fzf not found${reset}\n` +
  `  ${dim}rt uses the fzf inside mattstack.app (Contents/Helpers/fzf) and found neither it nor an fzf on PATH.${reset}\n` +
  `  ${dim}Reinstall mattstack.app, or${reset} ${bold}brew install fzf${reset}${dim} to use your own copy, then re-run.${reset}\n`;

export function ensureFzf(
  which: Which = defaultWhich,
  fail: (msg: string) => never = (msg) => { console.error(msg); process.exit(1); },
  bundled: Bundled = defaultBundled,
): string {
  const path = resolveFzf(which, bundled);
  if (path) return path;
  return fail(FZF_MISSING_MESSAGE);
}
```
Check every `ensureFzf(` caller compiles unchanged (`grep -rn "ensureFzf(" lib commands`) — the new parameter is last and optional.

- [ ] **Step 3: `commands/verify.ts`**

Dropped — owned by L1 T7 (`tool.rt-link`, `tool.vsix`, `tool.fzf` rows in the rt-health table; remedy text "run: rt setup apply --from path.link") and L1 T11 (verify = validator rows) (cross-plan review). L1 T7 runs after this task merges so `resolveFzf()` exists.

- [ ] **Step 4: `lib/notifier.ts` — osascript only**

Delete `_terminalNotifierPath`, `resolveTerminalNotifier`, and the Homebrew candidate list. `notifyFallback` becomes:
```ts
/** Fallback notifier executable; replaceable in tests with a fake that hangs. */
let fallbackNotifier = "osascript";

/** Direct notification via osascript (no queue); fire-and-forget with a kill escalation (MAT-222). */
function notifyFallback(title: string, message: string, _url?: string): void {
  const body = `${title}: ${message}`;
  const argv = [fallbackNotifier, "-e", `display notification "${escapeAppleScript(body)}" with title "rt"`];
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const term = setTimeout(() => { try { proc.kill("SIGTERM"); } catch { /* exited */ } }, FALLBACK_TERM_MS);
    const kill = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* exited */ } }, FALLBACK_KILL_MS);
    void proc.exited.finally(() => { clearTimeout(term); clearTimeout(kill); });
  } catch { /* notification is best-effort */ }
}
```
and in `__test__`: replace `setTerminalNotifierPath` with
```ts
  setFallbackNotifier(path: string | null): void { fallbackNotifier = path ?? "osascript"; },
```
Update the module docblock line 12 (`terminal-notifier/osascript` → `osascript`) and line 301. In `lib/__tests__/notifier-fallback.test.ts`: `__test__.setFallbackNotifier(fakeHangingNotifier(15))` / `afterEach(() => __test__.setFallbackNotifier(null))`; rename the fake file to `osascript` inside `fakeHangingNotifier` (the name is cosmetic — the path is passed explicitly).

- [ ] **Step 5: Run + commit**

Run: `bun test lib/__tests__/fzf.test.ts lib/__tests__/notifier-fallback.test.ts lib/__tests__/notifier.test.ts && bunx tsc --noEmit && grep -rn "terminal-notifier" lib commands | wc -l` → tests PASS; grep count `0` (the README mention goes in Task 12).

```bash
git add lib/fzf.ts lib/__tests__/fzf.test.ts lib/notifier.ts lib/__tests__/notifier-fallback.test.ts
git commit -m "MAT-383: bundled fzf by absolute path (resolveFzf), terminal-notifier dropped

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Docs — README install/upgrade/requirements, CLAUDE.md, website install page, rt-release skill

**AFTER L1 T30 + T31 merge** (`update.mdx` is regenerated from L1's new `rt update` tree description; L1 T31 then rebases onto this task for the final `bun run docs:gen && bun run docs:check` — cross-plan review §1 rows 5–6, §3). L4 owns `README.md`; L1 T31 only asserts that the brew/tmux/zellij/terminal-notifier lines are gone.

**Files:**
- Modify: `README.md` (`## Install`, `### What Gets Installed`, `### Upgrade`, `## Requirements`, `### Testing the installer`, `### rt-tray`, `### Release process`)
- Modify: `CLAUDE.md:3` (distribution sentence)
- Modify: `website/docs/getting-started/install.mdx`
- Modify: `skills/rt-release/SKILL.md`
- Regenerate: `website/docs/reference/update.mdx` via `bun run docs:gen`

**Interfaces:** none (prose). Every statement must match Tasks 1–11 (no tarballs, no tap, no tmux/terminal-notifier, DMG + `rt update` asks the app).

- [ ] **Step 1: README**

`## Install` becomes:
```markdown
## Install

Download `mattstack-<version>.dmg` from the latest
[GitHub Release](https://github.com/m4ttstack/rt/releases/latest), open it, and
drag **mattstack.app** to `/Applications`. Launch it once: the menu-bar "m"
appears and the setup window walks you through the rest (rt on your PATH, the
daemon, the editor extension, permissions, your team).

Headless (CI, a fresh machine over SSH):

```bash
ditto -x -k mattstack-<version>.zip /Applications
/Applications/mattstack.app/Contents/MacOS/rt --post-install
rt verify
```

`~/.local/bin/rt` is a symlink into the app bundle; `rt verify` reports the
health of each piece.
```
`### What Gets Installed` table: `rt` binary → "Symlink `~/.local/bin/rt` → `mattstack.app/Contents/MacOS/rt`"; `rt-tray.app` row → `mattstack.app` "Menu bar app: setup, daemon health, notifications, Sparkle updates"; `fzf` + `tmux` row → "Bundled tools | `fzf`, `jq`, `gh`, `glab`, `bun`, a private `node`, `fast-browser` inside `Contents/Helpers` — used by rt by absolute path; none are put on your PATH unless you ask"; drop `tmux`.
`### Upgrade`: "mattstack.app updates itself (Sparkle) and restarts its services when its version changes. `rt update` just asks the app to check now."
`## Requirements`: macOS 14 or newer, Apple Silicon; Xcode Command Line Tools (git); `fzf` row → "bundled; a `brew install fzf` copy is used only when rt runs from source"; delete the `tmux` row; keep `chafa`/`kitten` optional rows.
`### Testing the installer`: `rt --post-install` is the headless entry — it runs the legacy sweep and then `rt setup apply --non-interactive --team-of-one` (L1 T27), which records `mattstack.appPath`, links `~/.local/bin/rt`, installs `rt-context.vsix` from `Contents/Resources`, registers the services when the app is reachable, writes shell integration. State explicitly that a first `rt` invocation no longer auto-runs setup (L1 T10 prints a one-line hint instead — `rt verify` after a bare install reports what is missing); do not promise auto-setup anywhere in the README.
`### rt-tray`: add `scripts/fetch-deps.sh arm64` before `./build.sh release`, mention `RT_DAEMON_BIN=../dist/rt ./check-bundle.sh`, `./build.sh install` → `/Applications`.
`### Release process`: "Push a version tag (`skills/rt-release`); CI compiles rt (arm64), fetches the pinned helpers, builds + signs + notarizes mattstack.app, produces `mattstack-<ver>.dmg` / `.zip`, signs the Sparkle appcast, publishes the Release, then installs from the zip on a fresh runner and runs `rt verify --ci`."

- [ ] **Step 2: CLAUDE.md line 3**

`Personal developer CLI built with Bun. Compiled to a standalone binary via \`bun build --compile\` and shipped inside mattstack.app (DMG first install, Sparkle updates); \`~/.local/bin/rt\` is a symlink into the bundle.`

- [ ] **Step 3: website install.mdx** — mirror the README `## Install` + `## Upgrade` text (DMG, headless zip, `rt update` asks the app); table rows as in Step 1. Then `bun run docs:gen && bun run docs:check` (regenerates `reference/update.mdx` from the command tree as L1 T30 left it — exit 2 + `--json`; if `docs:check` flags drift elsewhere, fix only what this plan changed). L1 T31 re-runs both after merging on top of this task.

- [ ] **Step 4: skills/rt-release/SKILL.md**

- Intro paragraph: "…builds mattstack.app (arm64), notarizes it, attaches `mattstack-<ver>.dmg`, `mattstack-<ver>.zip`, the deltas, `appcast.xml` and `SHA256SUMS`, then installs from the zip on a fresh runner."
- Step 1 gains two preconditions: `rt-tray/SUPublicEDKey` is committed and `gh secret list -R m4ttstack/rt` shows `APPLE_*` + `SPARKLE_ED_KEY`; if either is missing, stop and say so.
- Step 8: assets to confirm are the five above; also "the `clean-room` job is green (the headless install proved `rt verify --ci`)" and "`curl -fsSL https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml | grep sparkle:version` shows the new build number".
- Guardrails: add "Never re-run `generate_appcast` by hand against a published release — CI is the only appcast writer; if a release is broken, cut the next tag."
- Delete every `rt-darwin-*.tar.gz` mention.

Also (for Task 8's `lib/__tests__/release-workflow.test.ts`, which does `import { parse } from "yaml"`): add `yaml` to `devDependencies` in `package.json` (`bun add -d yaml`) — or switch the test to Bun's built-in YAML parser if one is available in the pinned Bun — and say which in the commit body.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md website/docs skills/rt-release/SKILL.md package.json bun.lock
git commit -m "MAT-383: docs — DMG install, Sparkle upgrade, bundled tools, new release train

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13 (ORCHESTRATOR-ONLY / MATT): Entitlement measurement on a Developer-ID-signed build

**Why:** §14 risk 1 and ruling-8 "start allow-jit only, test". Ad-hoc signatures do not enforce the hardened runtime, so only a Developer-ID build answers this.

- [ ] **Step 1 (live machine, Developer ID in the login keychain):**
```bash
cd /Users/matt/Documents/GitHub/repo-tools-l4-wt
bun build --compile ./cli.ts --outfile dist/rt && scripts/fetch-deps.sh arm64
RT_DAEMON_BIN=$PWD/dist/rt rt-tray/build.sh release        # signs with Developer ID
A=rt-tray/mattstack.app/Contents
"$A/MacOS/rt" --version && "$A/MacOS/rt" verify --json >/dev/null; echo "rt exit $?"
"$A/Helpers/bun" --version; "$A/Helpers/bun" -e 'console.log(1+1)'
"$A/Helpers/node/bin/node" -e 'console.log(process.versions.node)'
"$A/Helpers/node/bin/node" "$A/Helpers/fast-browser/bin/fast-browser.mjs" --help >/dev/null; echo "fb exit $?"
for t in fzf jq gh glab; do "$A/Helpers/$t" --version >/dev/null && echo "$t ok"; done
HOME=$(mktemp -d) "$A/MacOS/rt" nav --help >/dev/null 2>&1; echo "picker path exit $?"
```
- [ ] **Step 2:** If any Bun/Node binary dies with `SIGKILL`/`Code Signature Invalid`/`mmap` errors in Console, add `com.apple.security.cs.allow-unsigned-executable-memory` **for that tool only**: introduce `scripts/entitlements-jit-unsigned.plist` (jit + unsigned-exec-mem), a new `entitlements: "jit-unsigned"` value in `deps.lock` + `lib/bundle-layout.ts` (`DepsLockEntitlements`), build.sh's `sign_helper_tree` mapping it, and check-bundle's `check_signed` accepting it for that tool. If `rt` itself needs it, swap `ENTITLEMENTS_JIT` for rt only. Record the measured outcome per tool in the commit body.
- [ ] **Step 3:** `RT_DAEMON_BIN=$PWD/dist/rt rt-tray/check-bundle.sh` → 0 failed with Developer ID (the runtime-flag assertions now execute). Commit `MAT-383: entitlements measured on a Developer ID build — <outcome>`.

### Task 14 (ORCHESTRATOR-ONLY / MATT): Xcode 26 path + Matt's machine cutover

**AFTER L3 T2 merges** (`rt-tray/project.yml` is L3's; `xcodegen generate --spec` consumes it).

- [ ] After Matt installs Xcode 26 and L3's `rt-tray/project.yml` exists: `sudo xcode-select -s /Applications/Xcode.app && cd rt-tray && RT_DAEMON_BIN=../dist/rt ./check-bundle.sh` — build.sh must pick `xcode` automatically (log line "with xcode"), and both flavors must pass the same assertions as the swift path. Then `RT_BUILD_TOOL=swift ./check-bundle.sh` must still pass (the CLT path stays the CI default until the Xcode path has produced one green release).
- [ ] Cutover of the live machine (identifier `rt-daemon` → `rt` invalidates launchd's cached launch constraints for the old job): `rt-tray/build.sh install` (prod) then `rt daemon install`; if the agent fails with `EX_CONFIG`/"launch constraint", `launchctl bootout gui/$UID/com.mattstack.daemon; sfltool resetbtm` then re-open the app and approve it in Login Items once. Re-grant Full Disk Access to `/Applications/mattstack.app` (V3). Run `rt verify`.

### Task 15 (ORCHESTRATOR-ONLY): Dry run, then the first tagged release

- [ ] `gh workflow run release.yml -R m4ttstack/rt --ref goodwinmattheweric/mat-383-release-pipeline` (dry run) — the `release` job must reach "Upload dry-run artifacts"; `clean-room` depends on L7's `scripts/e2e-cleanroom.sh` (fails with "No such file" until L7 merges; that failure is expected and reported, not patched around).
- [ ] Merge order: L3's `project.yml` is not required for the swift path; L7's script is required for a green clean-room job; Task 7's key is required for a tag.
- [ ] First tag via `skills/rt-release`; confirm assets, `appcast.xml` reachable at the `latest/download` URL, `clean-room` green, and one manual Sparkle update on Matt's machine from the previous build (VM layer b is L7's).

---

## Self-review

**Spec coverage (L4 scope items 1–8 from the brief, against §2/§7/§8/§11/§12.2/§14):**
1. Identity freeze — Task 3 (rt identifier, numeric CFBundleVersion, jit-only entitlements, check-bundle asserts the whole contract); the plist templates, `Package.swift` floor and Swift string edits are L3 T1/T2/T18's (cross-plan review). ✔
2. deps.lock + fetch-deps.sh + Helpers bundling + per-helper signing/entitlements, pending placeholders — Tasks 2, 4, 13. ✔
3. build.sh wraps xcodebuild with CLT fallback; Sparkle embed + rpath + inside-out signing; SUFeedURL/SUPublicEDKey injection (file or `SPARKLE_PUBLIC_ED_KEY`) — Tasks 4, 5, 14. ✔
4. DMG + notarize + staple; zip enclosure via ditto — Task 6 (+ Task 8 wiring). ✔
5. generate_appcast in CI with `SPARKLE_ED_KEY`, last 3 zips for deltas, host decided (Release asset via `latest/download`), DMG+zip uploaded — Tasks 6, 7, 8. ✔
6. release.yml rewrite incl. clean-room job (calls L7's script with `--post-install --non-interactive --team-of-one --no-launch`; `rt verify --ci`) — Task 8. ✔ Tarball dropped (Decision 2). ✔
7. `installRtBinary` → symlink; `trayAppPath` via `mattstack.appPath`; `legacyUserAppPath` — Task 9 (trimmed). `rt update` thin (exit 2 + `--json`), `commands/post-install.ts` (sweep + `setupApply`, exit 2 on a DMG path), `rt verify` rows — L1 T30 / T27+T24 / T7+T11 (cross-plan review; L4 T10 dropped). check-bundle asserts the new layout — Task 3. ✔ fzf by absolute path, terminal-notifier drop — Task 11. ✔
8. README/CLAUDE.md/website/rt-release skill; tap references gone — Task 12. ✔
Coordinator additions (a)–(e) — Global Constraints + Tasks 4, 5, 8. ✔
§8 agent plists: rendered by L3's `render-launchagents.sh` (daemon + deck, `KeepAlive {SuccessfulExit:false}`, static `EnvironmentVariables.PATH` per ruling R2 — rt/deck prepend their Helpers dir and `~/.local/bin` themselves) — Task 4 calls it, Task 3's check-bundle asserts both plists. §14 risk 1 — Task 13. ✔

**Placeholder scan:** the only deferred values are the outcomes of ORCHESTRATOR tasks (entitlement measurement, first notarized run) and L7's script, each named explicitly. `deps.lock` carries real hashes computed from the real URLs.

**Type/name consistency:** `bundleRootFromExec`/`appBundleRoot`/`bundledHelperPath`/`bundledExec`/`readDepsLock`/`RT_BUNDLE_PATH`/`DEPS_LOCK_BUNDLE_PATH` (Task 1) are the names L1 T5/T24/T27 consume; `installRtBinary(src)` keeps its signature (Task 9 ↔ settings.ts:478; L1 T5 `link("rt")` calls it); `trayAppPath(exists?)`/`devTrayAppPath(exists?)` (Task 9) match the handoff test rewrite; `resolveFzf` (Task 11 ↔ L1 T7); `__test__.setFallbackNotifier` (Task 11); build.sh env names `RT_DAEMON_BIN RT_VSIX RT_VERSION RT_REQUIRE_DEPS SPARKLE_PUBLIC_ED_KEY RT_BUILD_TOOL` (Task 4 ↔ Task 8); artifact names `mattstack-<ver>.{dmg,zip}` (Tasks 6, 8, 12); `check-bundle.sh --app <path>` (Task 3 ↔ Task 8 ↔ L7 T12); `render-launchagents.sh <prod|dev> <outdir>` (L3 T2 ↔ Task 4); CFBundleVersion `major*1e6+minor*1e3+patch` (Tasks 3/4 ↔ contract `GET /version` example `2008000` ↔ L3 `build: Int(CFBundleVersion) ?? 0` ↔ L7 `make-appcast.sh`).

## Open questions

1. **Appcast host.** CLOSED (ruling R1, cross-plan review): GitHub Release asset via `latest/download` is the host; spec §11 and L3's Info.plist template carry the same URL. Escape hatch only: if the redirect ever misbehaves for Sparkle (or pre-release channels are wanted), GitHub Pages is one constant (`SU_FEED_URL`) + one `actions/deploy-pages` step + the check-bundle assertion.
2. **CFBundleVersion scheme vs. the contract's example.** CLOSED (cross-plan review §5 #53): the contract example is `"build": 2008000` (`major*1e6+minor*1e3+patch`); L3's `GET /version` returns `Int(CFBundleVersion) ?? 0` (a number); L7's `make-appcast.sh` computes the build with the same formula.
3. **xcodebuild archive/export vs. build.** Ruling 6 says "build.sh wraps xcodebuild"; this plan wraps `xcodebuild build` and keeps our own inside-out signing (Decision 3). If Matt wants an `.xcarchive` for symbolication, add `-archivePath` to the same command later; signing still stays in build.sh.
4. **fast-browser artifact.** Bundled from npm `0.1.0-alpha.11` today; L5 may publish a different artifact (e.g. a tarball with the Playwright runtime). When it does, only the `deps.lock` row changes. Its runtime setup (`~/.fast-browser/runtime`, extension side-load) remains L1's `fastbrowser.setup` step.
5. **Dev flavor Helpers.** The plan bundles Helpers into `mattstack-dev.app` too (same code path, realistic dev testing, ~300 MB extra on disk). If that is unwanted, gate `bundle_helpers` on `IS_DEV=false` and relax the dev assertions in check-bundle.
6. **`--no-launch` / `--non-interactive` / `--team-of-one`** are L1's flags (L1 T27: `--no-launch` is also implied by `--ci`/`CI=true`); L7's script passes them by default and the workflow passes the zip positionally. Until L1 lands, `--post-install` on a runner still `open`s the app (as today's `test-install` does); harmless, but the clean-room job's daemon checks stay at "warn".
7. **`rt-tray/*.xcodeproj/` in .gitignore.** CLOSED (cross-plan review §1 row 8): L3 T1 adds the line (L3 regenerates the project from `project.yml`); Task 2 does not.
8. **Deck's LaunchAgent plist.** CLOSED (cross-plan review §1 row 17): L3 T2 ships `LaunchAgent-deck.plist` and `render-launchagents.sh` renders both plists; Task 4's build.sh copies both, Task 3's check-bundle asserts both. `Contents/Helpers/deck` stays absent until L5; L1's `services.register` requests the deck plist only when the helper is bundled.
9. **Local `appcast.sh` dry run** needs a throwaway EdDSA key (`generate_keys` writes to the login Keychain and prompts). Task 6 leaves the first real appcast run to Task 15 rather than prompting implementers' keychains.
