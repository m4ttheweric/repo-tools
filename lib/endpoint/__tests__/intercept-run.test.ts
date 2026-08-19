import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
