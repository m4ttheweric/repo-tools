import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoDataDir } from "../../rt-paths.ts";
import { runInterception } from "../run.ts";

function writeRepoConfig(repo: string, obj: unknown): void {
  const dir = repoDataDir(repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

// Role "web" for repo "r1" — read via loadEndpointRepoConfig inside
// runInterception's env step. env renders ${port}; preserveEnv protects the
// caller's KEEP_* vars (both feed argInject's ${envKeys}).
writeRepoConfig("r1", {
  roles: { web: { env: { PORT: "${port}" }, preserveEnv: ["KEEP_*"] } },
});

function harness(over: Partial<Parameters<typeof runInterception>[0]> = {}) {
  const calls: { exec?: { bin: string; args: string[]; env: Record<string, string> }; warned: string[] } = { warned: [] };
  const deps = {
    rules: [{ command: "fakecmd", repo: "r1", repoRemote: null,
      matches: [{ cwdGlob: ".", argPattern: "serve", role: "web",
        argInject: { afterArg: "run", template: "--keep=${envKeys}", skipIfArgPresent: "--keep" } }] }],
    gitToplevel: async () => "/wt/a",
    gitRemote: async () => null,
    claim: async () => ({ ok: true, data: { role: "web", port: 3000, url: "http://localhost:3000", refs: {} } }),
    execReal: async (bin: string, args: string[], env: Record<string, string>) => { calls.exec = { bin, args, env }; throw new Error("EXEC"); },
    resolveRealBinary: () => "/usr/bin/fakecmd",
    warn: (m: string) => calls.warned.push(m),
    ...over,
  };
  return { deps, calls };
}
const run = (deps: any, args: string[], env: Record<string, string | undefined> = {}) =>
  runInterception(deps, "fakecmd", args, "/wt/a", { PATH: "/usr/bin", ...env }, 42).catch((e) => { if (e.message !== "EXEC") throw e; });

describe("runInterception", () => {
  test("match → claim → env rendered, preserveEnv expanded into argInject, exec real", async () => {
    const { deps, calls } = harness();
    await run(deps, ["run", "serve"], { KEEP_ME: "1" });
    expect(calls.exec!.bin).toBe("/usr/bin/fakecmd");
    expect(calls.exec!.args).toEqual(["run", "--keep=PORT,KEEP_ME", "serve"]);
    expect(calls.exec!.env.PORT).toBe("3000");
    expect(calls.exec!.env.KEEP_ME).toBe("1");
  });
  test("no match → exec real untouched, no claim call", async () => {
    let claimed = false;
    const { deps, calls } = harness({ claim: async () => { claimed = true; return null; } });
    await run(deps, ["run", "test"]);
    expect(claimed).toBe(false);
    expect(calls.exec!.args).toEqual(["run", "test"]);
  });
  test("daemon down (claim → null) → warn once and exec real untouched", async () => {
    const { deps, calls } = harness({ claim: async () => null });
    await run(deps, ["run", "serve"]);
    expect(calls.warned.some((w) => w.includes("passthrough"))).toBe(true);
    expect(calls.exec!.args).toEqual(["run", "serve"]);
  });
  test("real binary unresolvable → hard error (never exec the shim recursively)", async () => {
    const { deps } = harness({ resolveRealBinary: () => null });
    await expect(run(deps, ["run", "serve"])).rejects.toThrow(/real binary/);
  });
});

// ─── cli.ts fast path — byte-transparency ────────────────────────────────────
//
// The generated PATH shims exec `rt intercept run <command> -- "$@"` for
// every intercepted real-world invocation (e.g. `pnpm start`), so this path
// through cli.ts must be byte-transparent: no dispatch() screen-clear/
// breadcrumb, no first-run auto-setup, no plugin-tree load noise. A unit
// test of runInterception alone can't see any of that — it only exists in
// cli.ts, before dispatch() is ever reached — so this spawns the real CLI
// entry point end to end against a throwaway HOME that deliberately has NO
// daemon.json (the exact condition that triggers first-run setup on every
// other command path).
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI_PATH = join(REPO_ROOT, "cli.ts");

describe("cli.ts intercept run fast path", () => {
  test("stdout is exactly the child's output; stderr carries no screen-clear/banner/first-run noise", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "rt-intercept-transparency-"));
    // No ~/.mattstack/rt/daemon.json in tmpHome — first-run setup would fire
    // on any other command path (see cli.ts's "First-run auto-setup" block).

    const proc = Bun.spawn([process.execPath, "run", CLI_PATH, "intercept", "run", "echo", "--", "hello"], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: tmpHome },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("hello\n"); // exactly the wrapped `echo hello`'s output — nothing prepended/appended
    expect(stderr).not.toContain("\x1b"); // no ANSI escape (screen clear / breadcrumb) bytes
    expect(stderr.toLowerCase()).not.toContain("first run");
  }, 20_000);
});
