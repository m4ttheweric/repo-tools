import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { createTestHome, rt } from "../harness.ts";

// Log filenames are computed from LOCAL date components (see todayLocal() in
// lib/plugin-api.ts and today() in lib/cli-logger.ts), not UTC -- this must
// match that format exactly or the test flakes near midnight / off-UTC.
function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The harness spawns rt with a minimal env that drops TZ, so the CLI derives
// its local day from the system zone while this test process runs in $TZ if
// set, else Etc/UTC (bun test forces UTC for determinism without exposing it
// in process.env). Any rt invocation whose dated log file we read must run
// in the test's EFFECTIVE zone so both sides compute the same day.
const tz: Record<string, string> = { TZ: process.env.TZ ?? "Etc/UTC" };

function installPlugin(home: string, dirName: string, manifest: unknown, files: Record<string, string> = {}): string {
  const dir = join(home, ".mattstack", "rt", "plugins", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, content);
    if (name.endsWith(".sh")) chmodSync(path, 0o755);
  }
  return dir;
}

describe("user plugins", () => {
  let home: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());

    installPlugin(home, "e2e-plugin", {
      name: "e2e-plugin",
      apiVersion: 1,
      commands: {
        "e2e-hello": { description: "e2e module command", module: "./hello.ts", aliases: ["eh"] },
        "e2e-notes": {
          description: "nested",
          subcommands: { add: { description: "add", module: "./notes.ts", fn: "add" } },
        },
        "e2e-boom": { description: "throws", module: "./boom.ts", hidden: true },
        "e2e-exec": { description: "exec probe", exec: "./probe.sh" },
        "e2e-exec-fail": { description: "exec failure", exec: "./fail.sh", hidden: true },
      },
    }, {
      "hello.ts": `import type { RtCommandContext } from "rt-plugin";
export async function run(args: string[], ctx: RtCommandContext) {
  const runs = ctx.rt.store<number>("runs");
  const n = ((await runs.get()) ?? 0) + 1;
  await runs.set(n);
  ctx.rt.log.info("hello ran", { n });
  console.log("HELLO " + n + " " + args.join(","));
}`,
      "notes.ts": `export async function add(args: string[]) { console.log("ADDED " + args.join(" ")); }`,
      "boom.ts": `export async function run() { throw new Error("kaboom"); }`,
      "probe.sh": `#!/bin/sh\necho "EXEC $RT_PLUGIN_NAME $@"\n`,
      "fail.sh": `#!/bin/sh\nexit 7\n`,
    });

    installPlugin(home, "e2e-collide", {
      name: "e2e-collide", apiVersion: 1,
      commands: { version: { description: "shadow", module: "./v.ts" } },
    }, { "v.ts": `export async function run() { console.log("SHADOW"); }` });

    installPlugin(home, "e2e-broken", "{ not json");
  });

  afterAll(() => cleanup());

  test("plugin commands appear in --help alongside built-ins", async () => {
    const result = await rt(["--help"], { home });
    expect(result.stderr + result.stdout).toContain("e2e-hello");
    expect(result.stderr + result.stdout).toContain("version");
  }, 30_000);

  test("module command runs with store persistence and domain log", async () => {
    const first = await rt(["e2e-hello", "x"], { home, env: tz });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("HELLO 1 x");
    const second = await rt(["e2e-hello"], { home, env: tz });
    expect(second.stdout).toContain("HELLO 2");

    const day = localDay();
    const domain = readFileSync(join(home, ".mattstack", "rt", "logs", `plugins.${day}.log`), "utf8");
    expect(domain).toContain('"plugin":"e2e-plugin"');

    const cli = readFileSync(join(home, ".mattstack", "rt", "logs", `cli.${day}.log`), "utf8");
    expect(cli).toContain('"command":"e2e-hello"');
    expect(cli).toContain('"outcome":"ok"');
  }, 30_000);

  test("aliases and nested subcommands dispatch", async () => {
    const alias = await rt(["eh"], { home });
    expect(alias.stdout).toContain("HELLO");
    const nested = await rt(["e2e-notes", "add", "milk"], { home });
    expect(nested.stdout).toContain("ADDED milk");
  }, 30_000);

  test("throwing plugin: exit 1 + error outcome in cli log", async () => {
    const result = await rt(["e2e-boom"], { home, env: tz });
    expect(result.exitCode).toBe(1);
    const day = localDay();
    const cli = readFileSync(join(home, ".mattstack", "rt", "logs", `cli.${day}.log`), "utf8");
    expect(cli).toContain("kaboom");
    expect(cli).toContain('"outcome":"error"');
  }, 30_000);

  test("exec node: env injection, args passthrough, exit-code propagation", async () => {
    const ok = await rt(["e2e-exec", "a", "b"], { home });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("EXEC e2e-plugin a b");
    const fail = await rt(["e2e-exec-fail"], { home });
    expect(fail.exitCode).toBe(7);
  }, 30_000);

  test("collision: built-in version wins, warning names the plugin", async () => {
    const result = await rt(["version"], { home });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("SHADOW");
    expect(result.stderr).toContain("e2e-collide");
  }, 30_000);

  test("malformed plugin is skipped loudly and rt keeps working", async () => {
    const result = await rt(["e2e-hello"], { home });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("e2e-broken");
  }, 30_000);

  test("rt plugin list and validate report health", async () => {
    const list = await rt(["plugin", "list"], { home });
    expect(list.stdout).toContain("e2e-plugin");
    expect(list.stdout).toContain("e2e-broken");
    const validate = await rt(["plugin", "validate", "e2e-plugin"], { home });
    expect(validate.exitCode).toBe(0);
  }, 30_000);

  test("rt plugin new scaffolds a working, typecheckable plugin", async () => {
    const created = await rt(["plugin", "new", "fresh-tool"], { home });
    expect(created.exitCode).toBe(0);
    const dir = join(home, ".mattstack", "rt", "plugins", "fresh-tool");
    expect(existsSync(join(dir, "plugin.json"))).toBe(true);
    expect(existsSync(join(home, ".mattstack", "rt", "plugin-api", "index.d.ts"))).toBe(true);

    const run = await rt(["fresh-tool"], { home });
    expect(run.stdout).toContain("hello from fresh-tool");

    // IDE contract: only when the scaffold's install succeeded (needs network).
    if (existsSync(join(dir, "node_modules", "typescript"))) {
      execSync("bunx tsc --noEmit", { cwd: dir });
    }
  }, 120_000);
});
