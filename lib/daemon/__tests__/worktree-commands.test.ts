/**
 * worktree-commands unit tests — discover a worktree's runnable package.json
 * scripts, and derive a stable process id for a launched command.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import {
  readPackageScripts, deriveProcessId, discoverWorktreeCommands,
  detectPackageManager, buildRunCommand,
} from "../worktree-commands.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rt-wtcmd-")); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

describe("readPackageScripts", () => {
  test("returns scripts as {name, cmd}, sorted by name", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "tsc" } }));
    expect(readPackageScripts(dir)).toEqual([
      { name: "build", cmd: "tsc" },
      { name: "dev", cmd: "vite" },
    ]);
  });

  test("returns [] when there is no package.json", () => {
    expect(readPackageScripts(dir)).toEqual([]);
  });

  test("returns [] when package.json has no scripts", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(readPackageScripts(dir)).toEqual([]);
  });

  test("returns [] for invalid JSON", () => {
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(readPackageScripts(dir)).toEqual([]);
  });
});

describe("discoverWorktreeCommands (monorepo-aware, reuses getWorkspacePackages)", () => {
  function writePkg(d: string, obj: any) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify(obj));
  }

  test("discovers the root package and every workspace package with scripts", () => {
    writePkg(dir, { name: "root", workspaces: ["apps/*"], scripts: { build: "tsc" } });
    writePkg(join(dir, "apps", "adjuster"), { name: "@x/adjuster", scripts: { dev: "vite" } });
    writePkg(join(dir, "apps", "api"), { name: "@x/api", scripts: { start: "node ." } });

    const pkgs = discoverWorktreeCommands(dir);
    const byName = Object.fromEntries(pkgs.map((p) => [p.name, p]));

    expect(byName["root"]?.scripts).toEqual([{ name: "build", cmd: "tsc" }]);
    expect(byName["root"]?.dir).toBe(dir);
    expect(byName["@x/adjuster"]?.scripts).toEqual([{ name: "dev", cmd: "vite" }]);
    expect(byName["@x/adjuster"]?.dir).toBe(join(dir, "apps", "adjuster"));
    expect(byName["@x/api"]?.scripts).toEqual([{ name: "start", cmd: "node ." }]);
  });

  test("omits packages that have no scripts", () => {
    writePkg(dir, { name: "root", workspaces: ["pkgs/*"] }); // root has no scripts
    writePkg(join(dir, "pkgs", "lib"), { name: "lib" });     // no scripts either
    expect(discoverWorktreeCommands(dir)).toEqual([]);
  });

  test("single-package repo returns just the root", () => {
    writePkg(dir, { name: "solo", scripts: { dev: "vite", test: "bun test" } });
    const pkgs = discoverWorktreeCommands(dir);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.name).toBe("solo");
    expect(pkgs[0]?.scripts.map((s) => s.name)).toEqual(["dev", "test"]);
  });
});

describe("detectPackageManager", () => {
  test("pnpm-lock.yaml -> pnpm", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });
  test("yarn.lock -> yarn", () => {
    writeFileSync(join(dir, "yarn.lock"), "");
    expect(detectPackageManager(dir)).toBe("yarn");
  });
  test("bun.lock -> bun", () => {
    writeFileSync(join(dir, "bun.lock"), "");
    expect(detectPackageManager(dir)).toBe("bun");
  });
  test("defaults to npm when no lockfile", () => {
    expect(detectPackageManager(dir)).toBe("npm");
  });
});

describe("buildRunCommand", () => {
  test("runs the named script through the package manager", () => {
    expect(buildRunCommand("pnpm", "dev")).toBe("pnpm run dev");
    expect(buildRunCommand("npm", "test")).toBe("npm run test");
  });
});

describe("deriveProcessId", () => {
  test("combines worktree basename and label", () => {
    expect(deriveProcessId("/Users/x/assured/assured-wktree-2", "dev")).toBe("assured-wktree-2:dev");
  });

  test("slugifies whitespace and unsafe chars in the label", () => {
    expect(deriveProcessId("/a/repo", "run all tests")).toBe("repo:run-all-tests");
  });

  test("tolerates a trailing slash on cwd", () => {
    expect(deriveProcessId("/a/repo/", "dev")).toBe("repo:dev");
  });
});
