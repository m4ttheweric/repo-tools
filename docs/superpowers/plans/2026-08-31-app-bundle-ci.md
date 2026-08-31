# App-Bundle CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manual-dispatch GitHub Actions pipeline that builds each managed mattstack app's darwin-arm64 binary from its repo's main, publishes a tarball release (binary + `skills/`), and opens a PR updating `rt-tray/deps.lock`.

**Architecture:** deps.lock rows gain a `repo` field marking the buildable set; each app repo's `mattstack.deck.json` gains a `bundle: {build, artifact}` recipe the workflow runs verbatim. Three small testable bun scripts under `scripts/bundle-ci/` do the parsing/matrix/lock-rewrite; the workflow itself stays thin YAML. `fetch-deps.sh` and `build.sh` gain an isolated skills-landing path (preserve `skills/` from the tarball, land at `Contents/Helpers/skills/<name>/`, join the signing pass).

**Tech Stack:** Bun 1.3.13 (scripts + tests), bash (fetch/build), GitHub Actions (`workflow_dispatch`, matrix on `macos-15` arm64), `gh` CLI for releases/PRs.

**Spec:** `docs/superpowers/specs/2026-08-31-app-bundle-ci-design.md`

## Global Constraints

- arm64 only: deps.lock stays `"arch": "arm64"`; no multi-arch fields anywhere.
- Never touch the binary extract/verify/sign path in `fetch-deps.sh`/`build.sh` beyond the skills-landing addition the spec names.
- The pipeline never guesses a build command: missing/invalid `bundle` node fails that app's leg loudly.
- Tag immutability: an existing `v<version>` tag on the app repo fails the leg ("bump the version"), never overwrites.
- No direct pushes to repo-tools main from CI; deps.lock lands via PR only.
- Smoke = binary exits 0 on `--version` exactly (no `--help` fallback) — mirrors `check-bundle.sh:336`.
- Comments follow clean-code rules: no ticket refs, no process citations, no narration. No em/en dashes anywhere.
- Code stays UI-free plain Bun/TS (no ink/react/JSX) per repo rule.
- Every new bun test runs under the repo's bunfig preload (HOME isolation) automatically; never bypass it.

## File Structure

```
lib/bundle-layout.ts                     # + optional `repo` field validation, pending-url rule
lib/__tests__/bundle-layout.test.ts      # + repo/pending-url cases
lib/__tests__/deps-lock-live.test.ts     # NEW: schema assertions against the real deps.lock
rt-tray/deps.lock                        # + repo on deck/board/gitq; + console/chat pending rows
scripts/lib/deps-lock.ts                 # + --lock <path> flag
scripts/lib/__tests__/deps-lock-cli.test.ts  # NEW
scripts/bundle-ci/validate-manifest.ts   # NEW: manifest -> {name, build, artifact} | loud error
scripts/bundle-ci/plan-matrix.ts         # NEW: apps input -> build matrix JSON
scripts/bundle-ci/update-lock.ts         # NEW: apply build results to deps.lock, format-preserving
scripts/bundle-ci/__tests__/*.test.ts    # NEW: one per script
scripts/fetch-deps.sh                    # + skills preservation + stamp marker + env overrides
scripts/__tests__/fetch-deps-skills.test.ts  # NEW: hermetic file:// e2e of the skills path
rt-tray/build.sh                         # + skills landing + signing entry + no-dot reject
rt-tray/check-bundle.sh                  # + skills tree assertions
.github/workflows/bundle-apps.yml        # NEW: plan -> build matrix -> PR
.github/workflows/checks.yml             # + actionlint step
docs/release-and-distribution.md         # + bundle-apps section incl. PAT manual step
```

---

### Task 1: `repo` field + pending-url rule in parseDepsLock

**Files:**
- Modify: `lib/bundle-layout.ts` (DepsLockTool interface ~line 17, parseDepsLock validation ~line 62)
- Test: `lib/__tests__/bundle-layout.test.ts`

**Interfaces:**
- Produces: `DepsLockTool.repo?: string` (optional; when present must match `/^m4ttstack\/[A-Za-z0-9._-]+$/`). New parse rule: a `status: "pending"` row must have `url === ""`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/__tests__/bundle-layout.test.ts` (reuse the file's existing minimal-valid-tool helper if one exists; otherwise this local helper):

```ts
function lockWith(tool: Record<string, unknown>): string {
  return JSON.stringify({
    schema: 1, arch: "arm64",
    tools: [{
      name: "x", version: "1.0.0", license: "MIT",
      url: "https://example.com/x.tgz",
      sha256: "a".repeat(64),
      archive: "tar.gz", extract: "x",
      bundlePath: "Contents/Helpers/x", exec: ["Contents/Helpers/x"],
      exposeByDefault: false, entitlements: "none",
      status: "bundled", kind: "helper",
      ...tool,
    }],
  });
}

test("repo field: valid m4ttstack slug parses and round-trips", () => {
  const lock = parseDepsLock(lockWith({ repo: "m4ttstack/deck" }));
  expect(lock.tools[0]!.repo).toBe("m4ttstack/deck");
});

test("repo field: absent stays undefined", () => {
  expect(parseDepsLock(lockWith({})).tools[0]!.repo).toBeUndefined();
});

test("repo field: wrong org rejected", () => {
  expect(() => parseDepsLock(lockWith({ repo: "someoneelse/deck" }))).toThrow(/repo/);
});

test("repo field: non-string rejected", () => {
  expect(() => parseDepsLock(lockWith({ repo: 7 }))).toThrow(/repo/);
});

test("pending row carrying a url is rejected", () => {
  expect(() =>
    parseDepsLock(lockWith({ status: "pending", url: "https://example.com/x.tgz", sha256: "", version: "" })),
  ).toThrow(/pending/);
});

test("pending row with empty url parses", () => {
  const lock = parseDepsLock(lockWith({ status: "pending", url: "", sha256: "", version: "" }));
  expect(lock.tools[0]!.status).toBe("pending");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/Documents/GitHub/repo-tools-bundle-ci && bun test lib/__tests__/bundle-layout.test.ts`
Expected: the four repo tests fail (`repo` silently ignored, no throw), pending-url test fails (no throw).

- [ ] **Step 3: Implement**

In `lib/bundle-layout.ts`, add to `DepsLockTool`:

```ts
  /** m4ttstack source repo for CI-built helpers; absent for third-party pins. */
  repo?: string;
```

In `parseDepsLock`, inside the per-tool loop (after the `exposeByDefault` check):

```ts
    if (t.repo !== undefined) {
      if (typeof t.repo !== "string" || !/^m4ttstack\/[A-Za-z0-9._-]+$/.test(t.repo)) {
        throw new Error(`deps.lock: ${name} repo must be "m4ttstack/<repo>", got ${String(t.repo)}`);
      }
    }
```

And in the `status` branch (beside the existing `status === "bundled"` checks):

```ts
    if (t.status === "pending" && t.url !== "") {
      throw new Error(`deps.lock: pending tool ${name} must not carry a url`);
    }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test lib/__tests__/bundle-layout.test.ts`
Expected: PASS, including all pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add lib/bundle-layout.ts lib/__tests__/bundle-layout.test.ts
git commit -m "bundle-layout: optional repo field + pending rows carry no url"
```

---

### Task 2: deps.lock rows (repo fields, console + chat stubs) + live-lock test

**Files:**
- Modify: `rt-tray/deps.lock`
- Create: `lib/__tests__/deps-lock-live.test.ts`

**Interfaces:**
- Consumes: Task 1's `repo` validation.
- Produces: deps.lock rows for `deck`, `board`, `gitq`, `console`, `chat` each carrying `repo`; the buildable set the workflow reads.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/deps-lock-live.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../bundle-layout.ts";

const lock = parseDepsLock(
  readFileSync(join(import.meta.dir, "..", "..", "rt-tray", "deps.lock"), "utf8"),
);

describe("live deps.lock buildable set", () => {
  test("every managed app row carries its m4ttstack repo", () => {
    const want: Record<string, string> = {
      deck: "m4ttstack/deck",
      board: "m4ttstack/board",
      gitq: "m4ttstack/gitq",
      console: "m4ttstack/console",
      chat: "m4ttstack/chat",
    };
    for (const [name, repo] of Object.entries(want)) {
      const row = lock.tools.find((t) => t.name === name);
      expect(row, name).toBeDefined();
      expect(row!.repo, name).toBe(repo);
    }
  });

  test("repo-bearing rows are fully pinned or explicitly pending", () => {
    for (const t of lock.tools) {
      if (!t.repo) continue;
      if (t.status === "bundled") {
        expect(t.url, t.name).toMatch(/^https:\/\/github\.com\/m4ttstack\//);
        expect(t.sha256, t.name).toMatch(/^[0-9a-f]{64}$/);
        expect(t.version, t.name).not.toBe("");
      } else {
        expect(t.url, t.name).toBe("");
      }
    }
  });

  test("third-party pins carry no repo", () => {
    for (const name of ["fzf", "jq", "node", "bun", "cloudflared", "sparkle"]) {
      expect(lock.tools.find((t) => t.name === name)?.repo, name).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test lib/__tests__/deps-lock-live.test.ts`
Expected: FAIL (no row carries `repo`; console/chat rows absent).

- [ ] **Step 3: Edit deps.lock**

- Add `"repo": "m4ttstack/deck"` to the deck row, `"repo": "m4ttstack/board"` to board, `"repo": "m4ttstack/gitq"` to gitq (place it on the first line of each row after `"license"`, matching the file's compact style).
- Add two new rows after gitq (before mattstack-proxy-install), matching the pending-stub shape deck/board use:

```jsonc
    { "name": "console", "version": "", "license": "MIT", "repo": "m4ttstack/console", "url": "", "sha256": "",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/console", "exec": ["Contents/Helpers/console"],
      "exposeByDefault": false, "entitlements": "jit", "status": "pending", "kind": "helper" },
    { "name": "chat", "version": "", "license": "MIT", "repo": "m4ttstack/chat", "url": "", "sha256": "",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/chat", "exec": ["Contents/Helpers/chat"],
      "exposeByDefault": false, "entitlements": "jit", "status": "pending", "kind": "helper" },
```

(`entitlements: "jit"` because both are bun-compiled binaries, like deck/board/gitq. The pipeline flips `archive`/`extract` to the tarball shape when it publishes.)

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test lib/__tests__/deps-lock-live.test.ts lib/__tests__/bundle-layout.test.ts`
Expected: PASS. Also run `bun scripts/lib/deps-lock.ts > /dev/null` to prove the emitter still parses the live file.

- [ ] **Step 5: Commit**

```bash
git add rt-tray/deps.lock lib/__tests__/deps-lock-live.test.ts
git commit -m "deps.lock: repo field on managed rows, console + chat pending stubs"
```

---

### Task 3: `--lock <path>` flag for the deps-lock emitter

**Files:**
- Modify: `scripts/lib/deps-lock.ts`
- Create: `scripts/lib/__tests__/deps-lock-cli.test.ts`

**Interfaces:**
- Produces: `bun scripts/lib/deps-lock.ts [--lock <path>]` reads the given lock instead of `rt-tray/deps.lock`. Task 7's hermetic test depends on this.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/__tests__/deps-lock-cli.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "deps-lock.ts");

function altLock(): string {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const path = join(dir, "alt.lock");
  writeFileSync(path, JSON.stringify({
    schema: 1, arch: "arm64",
    tools: [{
      name: "toolx", version: "9.9.9", license: "MIT",
      url: "https://example.com/toolx.tgz", sha256: "b".repeat(64),
      archive: "tar.gz", extract: "toolx",
      bundlePath: "Contents/Helpers/toolx", exec: ["Contents/Helpers/toolx"],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper",
    }],
  }));
  return path;
}

test("--lock <path> reads the alternate lock", async () => {
  const proc = Bun.spawn(["bun", CLI, "--lock", altLock()], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toContain("toolx\t9.9.9\t");
  expect(out).not.toContain("fzf");
});

test("default path still reads the repo lock", async () => {
  const proc = Bun.spawn(["bun", CLI, "--arch"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out.trim()).toBe("arm64");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test scripts/lib/__tests__/deps-lock-cli.test.ts`
Expected: first test FAILS (unknown flag ignored, repo lock read, output contains fzf).

- [ ] **Step 3: Implement**

In `scripts/lib/deps-lock.ts`'s `import.meta.main` block, resolve the path through the existing `opt` helper:

```ts
  const lockPath = opt("--lock") ?? join(import.meta.dir, "..", "..", "rt-tray", "deps.lock");
  const lock = parseDepsLock(readFileSync(lockPath, "utf8"));
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test scripts/lib/__tests__/deps-lock-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/deps-lock.ts scripts/lib/__tests__/deps-lock-cli.test.ts
git commit -m "deps-lock emitter: --lock flag for alternate lock files"
```

---

### Task 4: validate-manifest script

**Files:**
- Create: `scripts/bundle-ci/validate-manifest.ts`
- Test: `scripts/bundle-ci/__tests__/validate-manifest.test.ts`

**Interfaces:**
- Produces: `readBundleRecipe(manifestPath: string): { name: string; build: string; artifact: string }` (throws with remediation text on any invalid shape) and a CLI (`bun scripts/bundle-ci/validate-manifest.ts <path>`) that prints the JSON on stdout, exits 1 with the error on stderr otherwise. The workflow's build job calls the CLI; tests call the function.

- [ ] **Step 1: Write the failing tests**

Create `scripts/bundle-ci/__tests__/validate-manifest.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readBundleRecipe } from "../validate-manifest.ts";

function manifest(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  const path = join(dir, "mattstack.deck.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("valid manifest returns the recipe", () => {
  const p = manifest({ name: "deck", bundle: { build: "bun run compile", artifact: "dist/deck" } });
  expect(readBundleRecipe(p)).toEqual({ name: "deck", build: "bun run compile", artifact: "dist/deck" });
});

test("missing file throws with the path", () => {
  expect(() => readBundleRecipe("/nonexistent/mattstack.deck.json")).toThrow(/mattstack\.deck\.json/);
});

test("unparsable JSON throws", () => {
  expect(() => readBundleRecipe(manifest("{nope"))).toThrow();
});

test("missing bundle node names the remediation", () => {
  expect(() => readBundleRecipe(manifest({ name: "deck" }))).toThrow(/bundle\.build \+ bundle\.artifact/);
});

test("non-string build rejected", () => {
  expect(() => readBundleRecipe(manifest({ name: "deck", bundle: { build: 7, artifact: "dist/deck" } }))).toThrow(/bundle\.build/);
});

test("missing artifact rejected", () => {
  expect(() => readBundleRecipe(manifest({ name: "deck", bundle: { build: "x" } }))).toThrow(/bundle\.artifact/);
});

test("absolute or ..-escaping artifact rejected", () => {
  expect(() => readBundleRecipe(manifest({ name: "deck", bundle: { build: "x", artifact: "/etc/passwd" } }))).toThrow(/artifact/);
  expect(() => readBundleRecipe(manifest({ name: "deck", bundle: { build: "x", artifact: "../out" } }))).toThrow(/artifact/);
});

test("missing name rejected", () => {
  expect(() => readBundleRecipe(manifest({ bundle: { build: "x", artifact: "dist/x" } }))).toThrow(/name/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test scripts/bundle-ci/__tests__/validate-manifest.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `scripts/bundle-ci/validate-manifest.ts`:

```ts
// Validates an app repo's mattstack.deck.json for the bundle pipeline.
// The pipeline never guesses a build command: any invalid shape throws
// with the remediation the app owner needs.
import { readFileSync } from "fs";
import { isAbsolute } from "path";

export interface BundleRecipe {
  name: string;
  build: string;
  artifact: string;
}

export function readBundleRecipe(manifestPath: string): BundleRecipe {
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(`no mattstack.deck.json at ${manifestPath}`);
  }
  const m = JSON.parse(text) as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name) {
    throw new Error(`${manifestPath}: manifest needs a string "name"`);
  }
  const bundle = m.bundle as Record<string, unknown> | undefined;
  if (typeof bundle !== "object" || bundle === null) {
    throw new Error(`${manifestPath}: add bundle.build + bundle.artifact to mattstack.deck.json`);
  }
  if (typeof bundle.build !== "string" || !bundle.build) {
    throw new Error(`${manifestPath}: bundle.build must be a non-empty string`);
  }
  if (typeof bundle.artifact !== "string" || !bundle.artifact) {
    throw new Error(`${manifestPath}: bundle.artifact must be a non-empty string`);
  }
  if (isAbsolute(bundle.artifact) || bundle.artifact.split("/").includes("..")) {
    throw new Error(`${manifestPath}: bundle.artifact must be repo-relative with no ".." segments`);
  }
  return { name: m.name, build: bundle.build, artifact: bundle.artifact };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: validate-manifest.ts <path-to-mattstack.deck.json>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(readBundleRecipe(path)));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test scripts/bundle-ci/__tests__/validate-manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/bundle-ci/validate-manifest.ts scripts/bundle-ci/__tests__/validate-manifest.test.ts
git commit -m "bundle-ci: manifest recipe validator"
```

---

### Task 5: plan-matrix script

**Files:**
- Create: `scripts/bundle-ci/plan-matrix.ts`
- Test: `scripts/bundle-ci/__tests__/plan-matrix.test.ts`

**Interfaces:**
- Consumes: Task 1's `repo` field via `parseDepsLock` (import from `../../lib/bundle-layout.ts`).
- Produces: `planMatrix(lockText: string, appsInput: string): { name: string; repo: string }[]` (throws on unknown/empty) and a CLI (`bun scripts/bundle-ci/plan-matrix.ts <apps> [--lock <path>]`) printing `{"include":[...]}` for `fromJSON` in the workflow.

- [ ] **Step 1: Write the failing tests**

Create `scripts/bundle-ci/__tests__/plan-matrix.test.ts`:

```ts
import { expect, test } from "bun:test";
import { planMatrix } from "../plan-matrix.ts";

const LOCK = JSON.stringify({
  schema: 1, arch: "arm64",
  tools: [
    { name: "fzf", version: "1", license: "MIT", url: "https://e.com/f", sha256: "a".repeat(64),
      archive: "raw", extract: "", bundlePath: "Contents/Helpers/fzf", exec: ["Contents/Helpers/fzf"],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper" },
    { name: "deck", version: "", license: "MIT", repo: "m4ttstack/deck", url: "", sha256: "",
      archive: "raw", extract: "", bundlePath: "Contents/Helpers/deck", exec: ["Contents/Helpers/deck"],
      exposeByDefault: true, entitlements: "jit", status: "pending", kind: "helper" },
    { name: "gitq", version: "0.2.1", license: "MIT", repo: "m4ttstack/gitq",
      url: "https://github.com/m4ttstack/gitq/releases/download/v0.2.1/gitq-darwin-arm64",
      sha256: "c".repeat(64), archive: "raw", extract: "", bundlePath: "Contents/Helpers/gitq",
      exec: ["Contents/Helpers/gitq"], exposeByDefault: true, entitlements: "jit",
      status: "bundled", kind: "helper" },
  ],
});

test("all selects every repo-bearing row, pending or bundled", () => {
  expect(planMatrix(LOCK, "all")).toEqual([
    { name: "deck", repo: "m4ttstack/deck" },
    { name: "gitq", repo: "m4ttstack/gitq" },
  ]);
});

test("named subset, whitespace tolerated", () => {
  expect(planMatrix(LOCK, " deck , gitq ")).toEqual([
    { name: "deck", repo: "m4ttstack/deck" },
    { name: "gitq", repo: "m4ttstack/gitq" },
  ]);
});

test("unknown name throws", () => {
  expect(() => planMatrix(LOCK, "deck,nope")).toThrow(/nope/);
});

test("a name without a repo row throws", () => {
  expect(() => planMatrix(LOCK, "fzf")).toThrow(/fzf/);
});

test("empty input throws", () => {
  expect(() => planMatrix(LOCK, " ")).toThrow(/apps/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test scripts/bundle-ci/__tests__/plan-matrix.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `scripts/bundle-ci/plan-matrix.ts`:

```ts
// Resolves a workflow_dispatch apps input against deps.lock's repo-bearing
// rows and emits the build matrix. Unknown names fail the whole dispatch
// before anything builds.
import { readFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../../lib/bundle-layout.ts";

export function planMatrix(lockText: string, appsInput: string): { name: string; repo: string }[] {
  const buildable = parseDepsLock(lockText)
    .tools.filter((t) => t.repo)
    .map((t) => ({ name: t.name, repo: t.repo! }));
  const input = appsInput.trim();
  if (!input) throw new Error(`apps input is empty; pass app names or "all"`);
  if (input === "all") return buildable;
  return input.split(",").map((raw) => {
    const name = raw.trim();
    const row = buildable.find((b) => b.name === name);
    if (!row) {
      const known = buildable.map((b) => b.name).join(", ");
      throw new Error(`unknown app "${name}" (buildable: ${known})`);
    }
    return row;
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const lockFlag = args.indexOf("--lock");
  const lockPath = lockFlag >= 0
    ? args[lockFlag + 1]!
    : join(import.meta.dir, "..", "..", "rt-tray", "deps.lock");
  const apps = args.filter((a, i) => a !== "--lock" && i !== lockFlag + 1)[0] ?? "";
  try {
    console.log(JSON.stringify({ include: planMatrix(readFileSync(lockPath, "utf8"), apps) }));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test scripts/bundle-ci/__tests__/plan-matrix.test.ts`
Expected: PASS. Also sanity-run against the live lock: `bun scripts/bundle-ci/plan-matrix.ts all` prints five entries (deck, board, gitq, console, chat).

- [ ] **Step 5: Commit**

```bash
git add scripts/bundle-ci/plan-matrix.ts scripts/bundle-ci/__tests__/plan-matrix.test.ts
git commit -m "bundle-ci: dispatch matrix planner"
```

---

### Task 6: update-lock script (format-preserving row rewrite)

**Files:**
- Create: `scripts/bundle-ci/update-lock.ts`
- Test: `scripts/bundle-ci/__tests__/update-lock.test.ts`

**Interfaces:**
- Produces: `applyBuildResults(lockText: string, results: BuildResult[]): string` where `BuildResult = { name: string; version: string; url: string; sha256: string }`. Rewrites each named row's `version`, `url`, `sha256` values and sets `status: "bundled"`, `archive: "tar.gz"`, `extract: "<name>"` in place, preserving all other bytes of the file (indentation, key order, other rows). CLI: `bun scripts/bundle-ci/update-lock.ts <results.json> [--lock <path>]` rewrites the lock file in place.
- The rewrite is textual (regex within the row's object literal), validated by re-parsing the result with `parseDepsLock` before writing; a diff that fails to re-parse throws and writes nothing.

- [ ] **Step 1: Write the failing tests**

Create `scripts/bundle-ci/__tests__/update-lock.test.ts`:

```ts
import { expect, test } from "bun:test";
import { applyBuildResults } from "../update-lock.ts";
import { parseDepsLock } from "../../../lib/bundle-layout.ts";

const LOCK = `{
  "schema": 1,
  "arch": "arm64",
  "tools": [
    { "name": "deck", "version": "", "license": "MIT", "repo": "m4ttstack/deck", "url": "", "sha256": "",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/deck", "exec": ["Contents/Helpers/deck"],
      "exposeByDefault": true, "entitlements": "jit", "status": "pending", "kind": "helper" },
    { "name": "gitq", "version": "0.2.1", "license": "MIT", "repo": "m4ttstack/gitq",
      "url": "https://github.com/m4ttstack/gitq/releases/download/v0.2.1/gitq-darwin-arm64",
      "sha256": "${"c".repeat(64)}",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/gitq",
      "exec": ["Contents/Helpers/gitq"],
      "exposeByDefault": true, "entitlements": "jit", "status": "bundled", "kind": "helper" }
  ]
}
`;

const RESULT = {
  name: "deck", version: "0.5.0",
  url: "https://github.com/m4ttstack/deck/releases/download/v0.5.0/deck-darwin-arm64.tgz",
  sha256: "d".repeat(64),
};

test("rewrites the named row to the pinned tarball shape", () => {
  const out = applyBuildResults(LOCK, [RESULT]);
  const deck = parseDepsLock(out).tools.find((t) => t.name === "deck")!;
  expect(deck.version).toBe("0.5.0");
  expect(deck.url).toBe(RESULT.url);
  expect(deck.sha256).toBe(RESULT.sha256);
  expect(deck.status).toBe("bundled");
  expect(deck.archive).toBe("tar.gz");
  expect(deck.extract).toBe("deck");
});

test("untouched rows keep their exact bytes", () => {
  const out = applyBuildResults(LOCK, [RESULT]);
  const gitqBlockBefore = LOCK.slice(LOCK.indexOf(`"name": "gitq"`));
  const gitqBlockAfter = out.slice(out.indexOf(`"name": "gitq"`));
  expect(gitqBlockAfter).toBe(gitqBlockBefore);
});

test("unknown app throws and changes nothing", () => {
  expect(() => applyBuildResults(LOCK, [{ ...RESULT, name: "nope" }])).toThrow(/nope/);
});

test("result that would not re-parse throws", () => {
  expect(() => applyBuildResults(LOCK, [{ ...RESULT, sha256: "tooshort" }])).toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test scripts/bundle-ci/__tests__/update-lock.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `scripts/bundle-ci/update-lock.ts`:

```ts
// Applies build results to rt-tray/deps.lock textually so untouched rows
// keep their exact bytes (the file is hand-formatted). The rewritten text
// must re-parse before anything is written.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../../lib/bundle-layout.ts";

export interface BuildResult {
  name: string;
  version: string;
  url: string;
  sha256: string;
}

function rowSpan(lockText: string, name: string): { start: number; end: number } {
  const marker = `"name": "${name}"`;
  const idx = lockText.indexOf(marker);
  if (idx < 0) throw new Error(`deps.lock has no row named ${name}`);
  const start = lockText.lastIndexOf("{", idx);
  let depth = 0;
  for (let i = start; i < lockText.length; i++) {
    if (lockText[i] === "{") depth++;
    else if (lockText[i] === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`unterminated row object for ${name}`);
}

function setField(block: string, field: string, value: string, name: string): string {
  const re = new RegExp(`("${field}":\\s*")[^"]*(")`);
  if (!re.test(block)) throw new Error(`row ${name} has no "${field}" field to rewrite`);
  return block.replace(re, `$1${value}$2`);
}

export function applyBuildResults(lockText: string, results: BuildResult[]): string {
  let out = lockText;
  for (const r of results) {
    const { start, end } = rowSpan(out, r.name);
    let block = out.slice(start, end);
    block = setField(block, "version", r.version, r.name);
    block = setField(block, "url", r.url, r.name);
    block = setField(block, "sha256", r.sha256, r.name);
    block = setField(block, "status", "bundled", r.name);
    block = setField(block, "archive", "tar.gz", r.name);
    block = setField(block, "extract", r.name, r.name);
    out = out.slice(0, start) + block + out.slice(end);
  }
  parseDepsLock(out);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const lockFlag = args.indexOf("--lock");
  const lockPath = lockFlag >= 0
    ? args[lockFlag + 1]!
    : join(import.meta.dir, "..", "..", "rt-tray", "deps.lock");
  const resultsPath = args.filter((a, i) => a !== "--lock" && i !== lockFlag + 1)[0];
  if (!resultsPath) {
    console.error("usage: update-lock.ts <results.json> [--lock <path>]");
    process.exit(2);
  }
  const results = JSON.parse(readFileSync(resultsPath, "utf8")) as BuildResult[];
  writeFileSync(lockPath, applyBuildResults(readFileSync(lockPath, "utf8"), results));
  console.log(`updated ${results.map((r) => `${r.name}@${r.version}`).join(", ")}`);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test scripts/bundle-ci/__tests__/update-lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/bundle-ci/update-lock.ts scripts/bundle-ci/__tests__/update-lock.test.ts
git commit -m "bundle-ci: format-preserving deps.lock row rewriter"
```

---

### Task 7: fetch-deps.sh skills preservation (hermetic test via file:// URLs)

**Files:**
- Modify: `scripts/fetch-deps.sh` (unpack() tar.gz branch ~line 66, skip check ~line 178; add env overrides near the top)
- Create: `scripts/__tests__/fetch-deps-skills.test.ts`

**Interfaces:**
- Consumes: Task 3's `--lock` flag.
- Produces: for a tar.gz helper whose archive carries a top-level `skills/` dir, fetch-deps materializes `deps/<arch>/<name>-skills/` beside the binary and records `deps/<arch>/<name>-skills.sha256` (same sha as the main stamp). Env overrides `RT_DEPS_LOCK` (lock path) and `RT_DEPS_ROOT` (deps output root) for hermetic runs; both default to today's paths. Task 8's build.sh consumes `<name>-skills/`.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/fetch-deps-skills.test.ts`:

```ts
import { beforeAll, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "scripts", "fetch-deps.sh");

let work: string;
let lockPath: string;
let depsRoot: string;

function sh(cmd: string, env: Record<string, string> = {}): string {
  return execSync(cmd, {
    encoding: "utf8",
    env: { ...process.env, RT_DEPS_LOCK: lockPath, RT_DEPS_ROOT: depsRoot, RT_DEPS_CACHE: join(work, "cache"), ...env },
  });
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "fetch-skills-"));
  depsRoot = join(work, "deps");

  const stage = join(work, "stage");
  mkdirSync(join(stage, "skills", "toolx-hello"), { recursive: true });
  writeFileSync(join(stage, "toolx"), "#!/bin/sh\necho toolx 1.0.0\n");
  execSync(`chmod +x ${join(stage, "toolx")}`);
  writeFileSync(join(stage, "skills", "toolx-hello", "SKILL.md"), "---\nname: toolx-hello\n---\nhello\n");
  const tgz = join(work, "toolx-darwin-arm64.tgz");
  execSync(`tar czf ${tgz} -C ${stage} toolx skills`);
  const sha = execSync(`shasum -a 256 ${tgz}`, { encoding: "utf8" }).split(" ")[0]!;

  lockPath = join(work, "deps.lock");
  writeFileSync(lockPath, JSON.stringify({
    schema: 1, arch: "arm64",
    tools: [{
      name: "toolx", version: "1.0.0", license: "MIT",
      url: `file://${tgz}`, sha256: sha,
      archive: "tar.gz", extract: "toolx",
      bundlePath: "Contents/Helpers/toolx", exec: ["Contents/Helpers/toolx"],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper",
    }],
  }));
});

test("skills dir is materialized beside the binary with its own stamp", () => {
  sh(`bash ${SCRIPT} arm64`);
  expect(existsSync(join(depsRoot, "arm64", "toolx"))).toBe(true);
  expect(existsSync(join(depsRoot, "arm64", "toolx-skills", "toolx-hello", "SKILL.md"))).toBe(true);
  expect(existsSync(join(depsRoot, "arm64", "toolx-skills.sha256"))).toBe(true);
});

test("a deleted skills dir re-materializes on the next run despite a valid stamp", () => {
  rmSync(join(depsRoot, "arm64", "toolx-skills"), { recursive: true });
  sh(`bash ${SCRIPT} arm64`);
  expect(existsSync(join(depsRoot, "arm64", "toolx-skills", "toolx-hello", "SKILL.md"))).toBe(true);
});

test("an unchanged run with both present is a skip", () => {
  const out = sh(`bash ${SCRIPT} arm64`);
  expect(out).toContain("already unpacked");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test scripts/__tests__/fetch-deps-skills.test.ts`
Expected: FAIL — `RT_DEPS_LOCK`/`RT_DEPS_ROOT` are ignored today, so the script reads the real lock and either fetches real deps or the first assertion on `toolx` fails. (If the run is slow because it touches the real lock, that IS the failure; stop it and proceed.)

- [ ] **Step 3: Implement**

In `scripts/fetch-deps.sh`:

1. Env overrides (replace the two assignment lines):

```bash
DEPS_ROOT="${RT_DEPS_ROOT:-$ROOT/rt-tray/deps}"
```

and where the TSV is produced:

```bash
bun "$DEPS_LOCK_TS" ${RT_DEPS_LOCK:+--lock "$RT_DEPS_LOCK"} > "$TSV"
```

and the arch preflight:

```bash
LOCK_ARCH="$(bun "$DEPS_LOCK_TS" ${RT_DEPS_LOCK:+--lock "$RT_DEPS_LOCK"} --arch)"
```

2. In `unpack()`'s `tar.gz|tar.xz|npm` branch, after the existing `cp -R "$tmp/$extract" "$dest"` line and before `rm -rf "$tmp"`:

```bash
      rm -rf "$dest-skills"
      if [ -d "$tmp/skills" ]; then
        cp -R "$tmp/skills" "$dest-skills"
      fi
```

3. In the skip check (the `already=true` block), after the raw re-hash guard:

```bash
    # A skills stamp promises a skills dir; a deleted dir must re-materialize.
    if [ -f "$dest-skills.sha256" ] && [ "$(cat "$dest-skills.sha256")" = "$sha" ] && [ ! -d "$dest-skills" ]; then
      already=false
    fi
```

4. After the existing `echo "$sha" > "$stamp"` line:

```bash
  if [ -d "$dest-skills" ]; then
    echo "$sha" > "$dest-skills.sha256"
  else
    rm -f "$dest-skills.sha256"
  fi
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bash -n scripts/fetch-deps.sh && bun test scripts/__tests__/fetch-deps-skills.test.ts`
Expected: syntax clean, all three tests PASS.

- [ ] **Step 5: Verify no regression on the real lock**

Run: `bash scripts/fetch-deps.sh arm64`
Expected: every existing tool reports `already unpacked` (no re-downloads, no `-skills` artifacts appear for tools without skills).

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-deps.sh scripts/__tests__/fetch-deps-skills.test.ts
git commit -m "fetch-deps: preserve tarball skills/ dirs with their own stamp"
```

---

### Task 8: build.sh skills landing + signing; check-bundle assertions

**Files:**
- Modify: `rt-tray/build.sh` (inside `bundle_helpers()`'s row loop, after the `.claude-plugin` prune block ~line 222)
- Modify: `rt-tray/check-bundle.sh` (new assertion block near the helper `--version` loop ~line 326)

**Interfaces:**
- Consumes: Task 7's `deps/arm64/<name>-skills/` layout.
- Produces: `Contents/Helpers/skills/<name>/` in the .app, signed; check-bundle fails on an unsigned/malformed skills tree. This is the stable path the skills-shipping work (`rt skills link --from`) consumes.

- [ ] **Step 1: Add the landing block to build.sh**

In `bundle_helpers()`, after the `.claude-plugin`/`.codex-plugin` prune loop and before the `node` prune block, insert:

```bash
        # Agent skills ride beside the binary in CI tarballs; land them at the
        # stable path rt skills link consumes. A "." in a directory name would
        # make codesign treat it as a nested bundle, so reject it here rather
        # than fail the outer seal later.
        if [ -d "$DEPS_DIR/$name-skills" ]; then
            while IFS= read -r -d '' bad; do
                echo "  ✗ $name skills dir '$(basename "$bad")' contains a dot; rename it in the app repo"; exit 1
            done < <(find "$DEPS_DIR/$name-skills" -type d -name '*.*' -print0)
            skills_dest="$CONTENTS/Helpers/skills/$name"
            rm -rf "$skills_dest"; mkdir -p "$(dirname "$skills_dest")"
            cp -R "$DEPS_DIR/$name-skills" "$skills_dest"
            xattr -cr "$skills_dest" 2>/dev/null || true
            HELPER_ENTITLEMENTS+=("$skills_dest	none")
            echo "  ✓ Helpers/skills/$name"
        fi
```

(`HELPER_ENTITLEMENTS` membership routes the tree through the existing `sign_helper_tree` pass 1 — plain signature on every regular file, no Mach-O second pass since SKILL.md files are not executables.)

- [ ] **Step 2: Add the check-bundle assertions**

In `rt-tray/check-bundle.sh`, after the helper `--version` loop, add:

```bash
    # Skills trees: each dir under Helpers/skills/<app>/ must be a skill
    # (carry a SKILL.md) and stay dot-free (dot dirs read as nested bundles).
    if [ -d "$app/Contents/Helpers/skills" ]; then
        while IFS= read -r -d '' skdir; do
            [ -f "$skdir/SKILL.md" ] && pass "skills: $(basename "$(dirname "$skdir")")/$(basename "$skdir") has SKILL.md" \
                || fail "skills: $skdir has no SKILL.md"
        done < <(find "$app/Contents/Helpers/skills" -mindepth 2 -maxdepth 2 -type d -print0)
        while IFS= read -r -d '' dotdir; do
            fail "skills: dot directory $dotdir would break the bundle seal"
        done < <(find "$app/Contents/Helpers/skills" -type d -name '*.*' -print0)
    fi
```

(Match the surrounding file's `pass`/`fail` helper names exactly; read the neighboring lines first and adapt if the helpers are spelled differently.)

- [ ] **Step 3: Syntax-check both scripts**

Run: `bash -n rt-tray/build.sh && bash -n rt-tray/check-bundle.sh`
Expected: silence.

- [ ] **Step 4: Fixture-verify the landing logic in isolation**

The full build.sh needs Xcode signing; verify just the new block's behavior with a scratch harness (throwaway, not committed):

```bash
cd "$(mktemp -d)"
mkdir -p deps/toolx-skills/hello contents/Helpers
printf -- "---\nname: hello\n---\n" > deps/toolx-skills/hello/SKILL.md
DEPS_DIR=$PWD/deps CONTENTS=$PWD/contents name=toolx bash -c '
  if [ -d "$DEPS_DIR/$name-skills" ]; then
    skills_dest="$CONTENTS/Helpers/skills/$name"
    rm -rf "$skills_dest"; mkdir -p "$(dirname "$skills_dest")"
    cp -R "$DEPS_DIR/$name-skills" "$skills_dest"
  fi'
test -f contents/Helpers/skills/toolx/hello/SKILL.md && echo OK
```

Expected: `OK`. Then add a dot dir (`mkdir deps/toolx-skills/v1.2`) and confirm the reject branch fires when run with the full block.

- [ ] **Step 5: Commit**

```bash
git add rt-tray/build.sh rt-tray/check-bundle.sh
git commit -m "build: land helper skills trees signed at Contents/Helpers/skills"
```

---

### Task 9: bundle-apps workflow + actionlint gate

**Files:**
- Create: `.github/workflows/bundle-apps.yml`
- Modify: `.github/workflows/checks.yml` (add actionlint step after "Unit tests")

**Interfaces:**
- Consumes: Tasks 4-6 CLIs (`validate-manifest.ts`, `plan-matrix.ts`, `update-lock.ts`), Task 2's `repo` rows.
- Produces: the dispatchable pipeline. Secret consumed: `MATTSTACK_RELEASE_TOKEN` (manual precondition, Task 10 documents it).

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/bundle-apps.yml`:

```yaml
name: Bundle apps

on:
  workflow_dispatch:
    inputs:
      apps:
        description: Comma-separated app names, or "all"
        required: true
        default: all
      dry_run:
        description: Build and hash only; skip release and PR
        type: boolean
        default: false

jobs:
  plan:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      matrix: ${{ steps.plan.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.13
      - id: plan
        run: echo "matrix=$(bun scripts/bundle-ci/plan-matrix.ts '${{ inputs.apps }}')" >> "$GITHUB_OUTPUT"

  build:
    needs: plan
    runs-on: macos-15
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.13
      - name: Clone app repo at main
        env:
          GH_TOKEN: ${{ secrets.MATTSTACK_RELEASE_TOKEN }}
        run: |
          gh repo clone "${{ matrix.repo }}" app -- --depth 1 --branch main
          echo "SOURCE_SHA=$(git -C app rev-parse HEAD)" >> "$GITHUB_ENV"
      - name: Read and validate bundle recipe
        run: |
          bun scripts/bundle-ci/validate-manifest.ts app/mattstack.deck.json > recipe.json
          echo "BUILD_CMD=$(bun -e 'console.log(JSON.parse(await Bun.file("recipe.json").text()).build)')" >> "$GITHUB_ENV"
          echo "ARTIFACT=$(bun -e 'console.log(JSON.parse(await Bun.file("recipe.json").text()).artifact)')" >> "$GITHUB_ENV"
          echo "VERSION=$(bun -e 'console.log(JSON.parse(await Bun.file("app/package.json").text()).version)')" >> "$GITHUB_ENV"
      - name: Refuse an already-released version
        if: ${{ !inputs.dry_run }}
        env:
          GH_TOKEN: ${{ secrets.MATTSTACK_RELEASE_TOKEN }}
        run: |
          if gh api "repos/${{ matrix.repo }}/releases/tags/v$VERSION" --silent 2>/dev/null; then
            echo "::error::v$VERSION already released on ${{ matrix.repo }}; bump the version"
            exit 1
          fi
      - name: Build
        working-directory: app
        run: bash -c "$BUILD_CMD"
      - name: Smoke and package
        run: |
          test -x "app/$ARTIFACT" || { echo "::error::bundle.artifact app/$ARTIFACT missing or not executable"; exit 1; }
          "app/$ARTIFACT" --version
          mkdir stage
          cp "app/$ARTIFACT" "stage/${{ matrix.name }}"
          if [ -d app/skills ]; then cp -R app/skills stage/skills; fi
          TGZ="${{ matrix.name }}-darwin-arm64.tgz"
          tar czf "$TGZ" -C stage .
          SHA=$(shasum -a 256 "$TGZ" | cut -d' ' -f1)
          URL="https://github.com/${{ matrix.repo }}/releases/download/v$VERSION/$TGZ"
          printf '{"name":"%s","version":"%s","url":"%s","sha256":"%s","sourceSha":"%s"}\n' \
            "${{ matrix.name }}" "$VERSION" "$URL" "$SHA" "$SOURCE_SHA" > "result-${{ matrix.name }}.json"
          cat "result-${{ matrix.name }}.json"
      - name: Release
        if: ${{ !inputs.dry_run }}
        env:
          GH_TOKEN: ${{ secrets.MATTSTACK_RELEASE_TOKEN }}
        run: |
          gh release create "v$VERSION" "${{ matrix.name }}-darwin-arm64.tgz" \
            --repo "${{ matrix.repo }}" \
            --title "${{ matrix.name }} v$VERSION" \
            --notes "darwin-arm64 bundle build from $SOURCE_SHA"
      - uses: actions/upload-artifact@v4
        with:
          name: result-${{ matrix.name }}
          path: result-${{ matrix.name }}.json

  pr:
    needs: build
    if: ${{ !cancelled() && !inputs.dry_run }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.MATTSTACK_RELEASE_TOKEN }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.13
      - uses: actions/download-artifact@v4
        with:
          pattern: result-*
          merge-multiple: true
      - name: Update deps.lock and open PR
        env:
          GH_TOKEN: ${{ secrets.MATTSTACK_RELEASE_TOKEN }}
        run: |
          bun -e '
            const files = [...new Bun.Glob("result-*.json").scanSync(".")];
            const results = await Promise.all(files.map(async (f) => JSON.parse(await Bun.file(f).text())));
            await Bun.write("results.json", JSON.stringify(results));
          '
          bun scripts/bundle-ci/update-lock.ts results.json
          BRANCH="bundle-ci/${{ github.run_id }}"
          git config user.name "bundle-apps workflow"
          git config user.email "noreply@github.com"
          git checkout -b "$BRANCH"
          git add rt-tray/deps.lock
          BODY=$(bun -e '
            const rs = JSON.parse(await Bun.file("results.json").text());
            console.log(rs.map((r) => `- ${r.name} v${r.version} (source ${r.sourceSha.slice(0, 10)})`).join("\n"));
          ')
          git commit -m "deps.lock: bundle build $(date +%Y-%m-%d)"
          git push origin "$BRANCH"
          gh pr create --title "deps.lock: app bundle build" --body "$BODY"
```

- [ ] **Step 2: Add actionlint to checks.yml**

After the "Unit tests" step in `.github/workflows/checks.yml`:

```yaml
      - name: Workflow lint
        run: |
          brew install actionlint
          actionlint
```

- [ ] **Step 3: Lint locally**

Run: `brew install actionlint 2>/dev/null; actionlint` (from the worktree root)
Expected: no findings on any workflow. Fix anything it reports in `bundle-apps.yml` before committing.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/bundle-apps.yml .github/workflows/checks.yml
git commit -m "ci: bundle-apps dispatch workflow + actionlint gate"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/release-and-distribution.md` (new section after the existing deps/bundle material)

**Interfaces:**
- Consumes: everything above; documents the operator flow.

- [ ] **Step 1: Write the section**

Append a `## App-bundle CI (bundle-apps.yml)` section to `docs/release-and-distribution.md` covering, in this order, each as a short paragraph or list:

- What it does: manual dispatch, builds repo-bearing deps.lock rows from each app repo's main on macos-15 arm64, publishes `v<version>` releases with `<name>-darwin-arm64.tgz` (binary + `skills/`), opens one deps.lock PR.
- The two declarations: `repo` on the deps.lock row (buildable set) and `bundle: {build, artifact}` in the app's `mattstack.deck.json` (recipe). Missing recipe fails that leg loudly; that is the pairing enforcement.
- Version rule: tag comes from the app repo's package.json; an existing tag fails the leg ("bump the version").
- Dry run: `dry_run: true` builds + hashes without releasing; the e2e proof once an app's `bundle` node lands.
- Skills contract: tarball root carries `skills/` verbatim; fetch-deps materializes `deps/arm64/<name>-skills/`; build.sh lands + signs `Contents/Helpers/skills/<name>/`; skill dir names must be dot-free.
- **Manual precondition (Matt, once):** create a fine-grained org PAT named for this purpose with contents read+write on m4ttstack app repos and contents write + PR create on repo-tools; store as the `MATTSTACK_RELEASE_TOKEN` Actions secret on repo-tools.
- Recovery: release exists but PR failed -> re-run the pr job or hand-edit deps.lock from the run summary's url+sha.

- [ ] **Step 2: Commit**

```bash
git add docs/release-and-distribution.md
git commit -m "docs: app-bundle CI operator flow and PAT precondition"
```

---

### Task 11: Full gate + branch wrap-up

**Files:** none new.

- [ ] **Step 1: Run the full local gate**

```bash
bunx tsc --noEmit
bun test lib commands packages scripts
bun run picker:check
```

Expected: typecheck clean; all tests green (new suites included); picker check unaffected.

- [ ] **Step 2: Verify deps.lock end-to-end locally**

```bash
bash scripts/fetch-deps.sh arm64
```

Expected: all existing tools `already unpacked`; console/chat report `pending (not bundled in this build)`.

- [ ] **Step 3: Commit any stragglers and push the branch**

```bash
git status --short
git push -u origin feat/app-bundle-ci
```

Then open the PR (title: "App-bundle CI: build managed apps from source into deps.lock").

---

## Post-merge verification (not plan tasks; tracked in the PR body)

1. Matt creates the `MATTSTACK_RELEASE_TOKEN` PAT + secret (Task 10's exact scopes).
2. First `bundle` node lands in an app repo (deck is the natural first; coordinate with fox/deck-24).
3. Dispatch `bundle-apps.yml` with `apps: deck, dry_run: true` — proves clone/validate/build/smoke/hash on a real repo.
4. Real dispatch for deck; review + merge the deps.lock PR; `bash scripts/fetch-deps.sh arm64` pulls the release; next `.app` build bundles it and check-bundle passes (including any skills tree).
