/**
 * The claude CLI behaviors pack-cache.ts is built on, asserted against the real
 * binary. Opt-in because no CI workflow installs claude: RT_CLAUDE_PLUGIN_E2E=1.
 * Every branch in settlePack keys off one of these, so a claude behavior change
 * must fail loudly here rather than silently in production.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { createTestHome } from "../harness.ts";

const enabled = process.env.RT_CLAUDE_PLUGIN_E2E === "1";

describe.skipIf(!enabled)("claude plugin contract", () => {
  let home: string;
  let market: string;
  const id = "demopack@probeorg";

  /** The streams are kept apart because the matchers are: isNotFound/isAlready/isAlreadyDisabled read stderr alone, so a combined string here would pass through a stream change they would not survive. */
  function claude(args: string[]): { code: number; stdout: string; stderr: string } {
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
    // Explicit, because execFileSync inherits stderr by default and the error
    // path would then hand back a null stderr for every probe below.
    const stdio: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"];
    try {
      return { code: 0, stdout: execFileSync("claude", args, { encoding: "utf8", env, stdio }), stderr: "" };
    } catch (err) {
      const e = err as { status: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  function version(): string {
    return JSON.parse(claude(["plugin", "list", "--json"]).stdout).find((p: { id: string }) => p.id === id).version;
  }

  function isEnabled(): boolean {
    return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).enabledPlugins[id] === true;
  }

  function setVersion(v: string): void {
    writeFileSync(join(market, "packs/demo/.claude-plugin/plugin.json"), JSON.stringify({ name: "demopack", version: v, skills: "./skills/" }));
  }

  let cleanup: () => void;

  afterAll(() => cleanup?.());

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
    market = join(home, "market");
    mkdirSync(join(market, ".claude-plugin"), { recursive: true });
    mkdirSync(join(market, "packs/demo/.claude-plugin"), { recursive: true });
    mkdirSync(join(market, "packs/demo/skills/hello"), { recursive: true });
    writeFileSync(join(market, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "probeorg", owner: { name: "probe" }, plugins: [{ name: "demopack", source: "./packs/demo" }] }));
    writeFileSync(join(market, "packs/demo/skills/hello/SKILL.md"), "---\nname: hello\ndescription: probe\n---\nhi\n");
    setVersion("1.0.0");
    claude(["plugin", "marketplace", "add", market]);
  });

  test("install enables the plugin, which is why rt must disable a team pack", () => {
    expect(claude(["plugin", "install", id]).code).toBe(0);
    expect(isEnabled()).toBe(true);
  });

  test("disable then update preserves the disabled state", () => {
    expect(claude(["plugin", "disable", id]).code).toBe(0);
    setVersion("1.1.0");
    expect(claude(["plugin", "update", id, "-y"]).code).toBe(0);
    expect(version()).toBe("1.1.0");
    expect(isEnabled()).toBe(false);
  });

  test("disable on an already-disabled pack exits non-zero saying already disabled", () => {
    const res = claude(["plugin", "disable", id]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/already disabled/i);
  });

  test("uninstall clears the plugin and its enabledPlugins entry", () => {
    expect(claude(["plugin", "uninstall", id]).code).toBe(0);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.enabledPlugins[id]).toBeUndefined();
  });

  test("update on an uninstalled plugin exits non-zero with wording our absence matcher recognizes", () => {
    const res = claude(["plugin", "update", id, "-y"]);
    expect(res.code).not.toBe(0);
    // The exact wording moved between claude releases ("not found" -> "is not
    // installed"); isNotFound accepts both, so the pattern pins recognition
    // rather than freezing today's exact string.
    expect(res.stderr).toMatch(/not found|not installed/i);
  });

  test("uninstall on an absent pack matches isAlreadyGone's phrasing", () => {
    const res = claude(["plugin", "uninstall", id]);
    expect(res.code).not.toBe(0);
    // isAlreadyGone is the one matcher that reads both streams, so this probe does too.
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/not installed|not found/i);
  });
});
