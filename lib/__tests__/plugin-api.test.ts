import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rt-plugin-api-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("ensurePluginApiDir", () => {
  test("writes package.json, index.d.ts, index.js", async () => {
    const { ensurePluginApiDir, pluginApiDir } = await import("../plugin-api.ts");
    ensurePluginApiDir();
    const dir = pluginApiDir();
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("rt-plugin");
    expect(pkg.types).toBe("index.d.ts");
    expect(readFileSync(join(dir, "index.d.ts"), "utf8")).toContain("export interface RtApi");
    expect(readFileSync(join(dir, "index.js"), "utf8")).toContain("types-only");
  });

  test("is idempotent when content matches (no rewrite)", async () => {
    const { ensurePluginApiDir, pluginApiDir } = await import("../plugin-api.ts");
    ensurePluginApiDir();
    const dts = join(pluginApiDir(), "index.d.ts");
    const before = statSync(dts).mtimeMs;
    await Bun.sleep(10);
    ensurePluginApiDir();
    expect(statSync(dts).mtimeMs).toBe(before);
  });

  test("rewrites when existing content is stale", async () => {
    const { ensurePluginApiDir, pluginApiDir } = await import("../plugin-api.ts");
    ensurePluginApiDir();
    const dts = join(pluginApiDir(), "index.d.ts");
    writeFileSync(dts, "// stale");
    ensurePluginApiDir();
    expect(readFileSync(dts, "utf8")).toContain("export interface RtApi");
  });
});

describe("makeApi.store", () => {
  test("round-trips JSON under ~/.rt/plugin-data/<plugin>/<key>.json", async () => {
    const { makeApi } = await import("../plugin-api.ts");
    const store = makeApi("my-plugin").store<string[]>("notes");
    expect(await store.get()).toBeNull();
    await store.set(["a", "b"]);
    expect(await store.get()).toEqual(["a", "b"]);
    expect(existsSync(join(home, ".rt", "plugin-data", "my-plugin", "notes.json"))).toBe(true);
  });

  test("rejects keys with path separators", async () => {
    const { makeApi } = await import("../plugin-api.ts");
    expect(() => makeApi("p").store("../escape")).toThrow(/invalid store key/);
    expect(() => makeApi("p").store("a/b")).toThrow(/invalid store key/);
  });
});

describe("makeApi.log", () => {
  test("appends JSON lines with plugin attribution", async () => {
    const { makeApi } = await import("../plugin-api.ts");
    makeApi("my-plugin").log.info("hello", { n: 1 });
    const day = new Date().toISOString().slice(0, 10);
    const line = readFileSync(join(home, ".rt", "logs", `plugins.${day}.log`), "utf8").trim();
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({ level: "info", plugin: "my-plugin", msg: "hello", n: 1 });
  });

  test("debug is gated by RT_LOG_LEVEL", async () => {
    const { makeApi } = await import("../plugin-api.ts");
    const saved = process.env.RT_LOG_LEVEL;
    delete process.env.RT_LOG_LEVEL;
    makeApi("p").log.debug("quiet");
    const day = new Date().toISOString().slice(0, 10);
    const file = join(home, ".rt", "logs", `plugins.${day}.log`);
    expect(existsSync(file)).toBe(false);
    process.env.RT_LOG_LEVEL = "debug";
    makeApi("p").log.debug("loud");
    expect(readFileSync(file, "utf8")).toContain("loud");
    process.env.RT_LOG_LEVEL = saved;
  });
});
