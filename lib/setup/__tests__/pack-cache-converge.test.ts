import { describe, test, expect } from "bun:test";
import { join } from "path";
import { fakeProbes } from "./fakes.ts";
import { convergePackCache } from "../pack-cache.ts";
import type { ExecResult } from "../probes.ts";

const home = "/fake-home";
const clone = join(home, ".mattstack", "teams", "acme");
const marketplacePath = join(clone, ".claude-plugin", "marketplace.json");

const quietLog = { info: () => {}, warn: () => {}, error: () => {} } as never;

function served(plugins: { name: string; source?: unknown }[]): Record<string, string> {
  return { [marketplacePath]: JSON.stringify({ name: "assured", plugins }) };
}

function pluginJson(pack: string, version: string): Record<string, string> {
  return { [join(clone, "packs", pack, ".claude-plugin", "plugin.json")]: JSON.stringify({ version }) };
}

/** Builds probes whose exec answers `claude plugin ...` from a scripted table. */
function probesWith(files: Record<string, string>, reply: (argv: string[]) => ExecResult) {
  const execs: string[][] = [];
  const p = fakeProbes({
    home,
    env: { PATH: "/usr/local/bin" },
    files: { "/usr/local/bin/claude": "bin", ...files },
    exec: async (argv: string[]) => {
      execs.push(argv);
      return reply(argv);
    },
  });
  return { p, execs };
}

const listing = (entries: unknown[]): ExecResult => ({ code: 0, stdout: JSON.stringify(entries), stderr: "" });

describe("convergePackCache", () => {
  test("a pack already at the served version issues no update", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      () => listing([{ id: "claimview@assured", version: "0.5.28", enabled: false }]),
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.current).toEqual(["claimview@assured"]);
    expect(execs.filter((a) => a.includes("update"))).toEqual([]);
  });

  test("a stale pack is updated", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) =>
        argv.includes("list")
          ? listing([{ id: "claimview@assured", version: "0.5.18", enabled: false }])
          : { code: 0, stdout: "", stderr: "" },
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.updated).toEqual([{ id: "claimview@assured", to: "0.5.28" }]);
    expect(execs.some((a) => a[1] === "plugin" && a[2] === "update")).toBe(true);
  });

  test("an unreadable listing records every pack failed and writes nothing", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      () => ({ code: 0, stdout: "not json", stderr: "" }),
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.failed).toHaveLength(1);
    expect(execs.every((a) => a[2] === "list")).toBe(true);
  });

  test("a pack the listing does not carry is installed, then disabled", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        if (argv.includes("list")) return listing([]);
        if (argv.includes("update")) return { code: 1, stdout: "", stderr: 'Plugin "claimview" not found' };
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.installed).toEqual(["claimview@assured"]);
    const verbs = execs.filter((a) => a[1] === "plugin").map((a) => a[2]);
    expect(verbs).toEqual(["list", "update", "install", "disable"]);
  });

  test("a null served version is skipped whether or not it is listed", async () => {
    for (const entries of [[], [{ id: "remote@assured", version: "1.0.0", enabled: false }]]) {
      const { p, execs } = probesWith(served([{ name: "remote", source: { source: "github", repo: "o/r" } }]), () => listing(entries));
      const result = await convergePackCache(p, "acme", quietLog);
      expect(result.skipped).toEqual([{ id: "remote@assured", reason: "version unknown" }]);
      expect(execs.filter((a) => a[2] === "update" || a[2] === "install")).toEqual([]);
    }
  });

  test("a settlement that does not fit the remaining budget is skipped whole", async () => {
    let clock = 0;
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        if (argv.includes("list")) return listing([]);
        clock += 100_000;
        return { code: 1, stdout: "", stderr: 'Plugin "claimview" not found' };
      },
    );
    const result = await convergePackCache(p, "acme", quietLog, { now: () => clock });
    expect(result.skipped).toEqual([{ id: "claimview@assured", reason: "settlement did not fit the remaining budget" }]);
    expect(execs.some((a) => a[2] === "install")).toBe(false);
  });

  test("no claude on the machine is a skip, not a failure", async () => {
    const p = fakeProbes({ home, env: {}, files: served([{ name: "claimview", source: "./packs/claimview" }]) });
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.skipped).toEqual([{ id: "*", reason: "claude not found" }]);
  });

  test("a pack reached after the budget is spent is skipped as budget-exhausted", async () => {
    let clock = 0;
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        if (argv.includes("list")) { clock += 200_000; return listing([{ id: "claimview@assured", version: "0.5.18", enabled: false }]); }
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    const result = await convergePackCache(p, "acme", quietLog, { now: () => clock });
    expect(result.skipped).toEqual([{ id: "claimview@assured", reason: "converge budget exhausted" }]);
    expect(execs.some((a) => a[2] === "update")).toBe(false);
  });

  test("an update failure that is not not-found never reaches install", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        if (argv.includes("list")) return listing([{ id: "claimview@assured", version: "0.5.18", enabled: false }]);
        return { code: 1, stdout: "", stderr: "registry exploded" };
      },
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.failed).toEqual([{ id: "claimview@assured", detail: "registry exploded" }]);
    expect(execs.some((a) => a[2] === "install")).toBe(false);
  });

  test("a timed-out update records failed, never 'not installed'", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        if (argv.includes("list")) return listing([{ id: "claimview@assured", version: "0.5.18", enabled: false }]);
        return { code: 124, stdout: "", stderr: "" };
      },
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.failed).toHaveLength(1);
    expect(result.installed).toEqual([]);
    expect(execs.some((a) => a[2] === "install")).toBe(false);
  });

  test("an unparsable marketplace.json is reported, not silently empty", async () => {
    const { p } = probesWith({ [marketplacePath]: "{ broken" }, () => listing([]));
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.failed[0]!.detail).toContain("did not parse");
  });

  test("a stale pack updates and keeps its disabled state", async () => {
    const enabled: Record<string, boolean> = { "claimview@assured": false };
    const versions: Record<string, string> = { "claimview@assured": "0.5.18" };
    const { p } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        const [, , verb, id] = argv;
        if (verb === "list") return listing(Object.keys(versions).map((k) => ({ id: k, version: versions[k], enabled: enabled[k] })));
        // update moves the version and leaves enablement alone; install would enable.
        if (verb === "update") { versions[id!] = "0.5.28"; return { code: 0, stdout: "", stderr: "" }; }
        if (verb === "install") { enabled[id!] = true; return { code: 0, stdout: "", stderr: "" }; }
        return { code: 0, stdout: "", stderr: "" };
      },
    );

    await convergePackCache(p, "acme", quietLog);

    expect(versions["claimview@assured"]).toBe("0.5.28");
    expect(enabled["claimview@assured"]).toBe(false);
  });
});
