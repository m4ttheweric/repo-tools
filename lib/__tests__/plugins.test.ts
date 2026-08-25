import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { validateManifest, toCommandNode, ExecFailure, discoverPlugins, loadPluginTree, scaffoldPlugin, deepValidate } from "../plugins.ts";

const valid = {
  name: "my-plugin",
  apiVersion: 1,
  commands: {
    standup: {
      description: "Draft my standup",
      module: "./standup.ts",
      aliases: ["su"],
      context: "worktree",
      args: [{ name: "Team", flag: "--team", type: "select", options: [{ value: "cv", label: "cv" }] }],
    },
    notes: {
      description: "Scratch notes",
      subcommands: {
        add: { description: "Add a note", module: "./notes.ts", fn: "add" },
      },
    },
    deploy: { description: "Deploy", exec: "./scripts/deploy.sh" },
    lint: { description: "Lint", exec: ["bash", "-c", "echo hi"] },
  },
};

describe("validateManifest", () => {
  test("accepts a full valid manifest", () => {
    expect(validateManifest(valid)).toEqual([]);
  });

  test("rejects non-object / missing basics", () => {
    expect(validateManifest(null).length).toBeGreaterThan(0);
    expect(validateManifest({}).length).toBeGreaterThan(0);
    expect(validateManifest({ name: "x", apiVersion: 1, commands: {} })).toEqual([
      "commands: must declare at least one command",
    ]);
  });

  test("rejects wrong apiVersion", () => {
    const errors = validateManifest({ ...valid, apiVersion: 2 });
    expect(errors.join()).toContain("apiVersion");
  });

  test("rejects non-kebab-case name", () => {
    expect(validateManifest({ ...valid, name: "My Plugin" }).join()).toContain("kebab-case");
  });

  test("rejects unknown fields at every level", () => {
    expect(validateManifest({ ...valid, extra: 1 }).join()).toContain('unknown field "extra"');
    const cmds = { bad: { description: "x", module: "./x.ts", modle: "typo" } };
    expect(validateManifest({ ...valid, commands: cmds }).join()).toContain('unknown field "modle"');
  });

  test("requires exactly one of module/exec/subcommands", () => {
    const both = { name: "p", apiVersion: 1, commands: { a: { description: "d", module: "./a.ts", exec: "./a.sh" } } };
    expect(validateManifest(both).join()).toContain("exactly one");
    const none = { name: "p", apiVersion: 1, commands: { a: { description: "d" } } };
    expect(validateManifest(none).join()).toContain("exactly one");
    const modPlusSub = {
      name: "p", apiVersion: 1,
      commands: { a: { description: "d", module: "./a.ts", subcommands: { b: { description: "e", module: "./b.ts" } } } },
    };
    expect(validateManifest(modPlusSub).join()).toContain("exactly one");
  });

  test("rejects fn without module and bad arg entries", () => {
    const fnNoModule = { name: "p", apiVersion: 1, commands: { a: { description: "d", exec: "./a.sh", fn: "run" } } };
    expect(validateManifest(fnNoModule).join()).toContain('"fn" requires "module"');
    const badArg = { name: "p", apiVersion: 1, commands: { a: { description: "d", module: "./a.ts", args: [{ name: "X", type: "nope" }] } } };
    expect(validateManifest(badArg).join()).toContain("args[0]");
  });

  test("validates nested subcommands recursively", () => {
    const nested = {
      name: "p", apiVersion: 1,
      commands: { a: { description: "d", subcommands: { b: { description: "e" } } } },
    };
    expect(validateManifest(nested).join()).toContain("a.b");
  });

  test("rejects non-kebab-case aliases", () => {
    for (const alias of ["My Alias", "--foo", ""]) {
      const manifest = {
        name: "p", apiVersion: 1,
        commands: { a: { description: "d", module: "./a.ts", aliases: [alias] } },
      };
      expect(validateManifest(manifest).join()).toContain("aliases must be kebab-case");
    }
  });

  test("accepts a valid kebab-case alias", () => {
    const manifest = {
      name: "p", apiVersion: 1,
      commands: { a: { description: "d", module: "./a.ts", aliases: ["su"] } },
    };
    expect(validateManifest(manifest)).toEqual([]);
  });
});

describe("toCommandNode", () => {
  let home: string;
  let dir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-plugins-"));
    savedHome = process.env.HOME;
    process.env.HOME = home;
    dir = join(home, ".mattstack", "rt", "plugins", "test-plugin");
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("passes through declarative fields", () => {
    const node = toCommandNode("test-plugin", dir, {
      description: "d", module: "./x.ts",
      aliases: ["a"], hidden: true, context: "worktree", requiresTTY: true, fullscreen: true,
      args: [{ name: "N", type: "text" }],
    });
    expect(node.description).toBe("d");
    expect(node.aliases).toEqual(["a"]);
    expect(node.hidden).toBe(true);
    expect(node.context).toBe("worktree");
    expect(node.requiresTTY).toBe(true);
    expect(node.fullscreen).toBe(true);
    expect(node.args).toHaveLength(1);
    expect(typeof node.handler).toBe("function");
  });

  test("module handler imports lazily and injects ctx.rt", async () => {
    writeFileSync(join(dir, "hello.ts"), `
      export async function run(args, ctx) {
        await ctx.rt.store("seen").set({ args, hasIdentity: !!ctx.identity });
      }
    `);
    const node = toCommandNode("test-plugin", dir, { description: "d", module: "./hello.ts" });
    await node.handler!(["x", "y"], {});
    const seen = JSON.parse(readFileSync(join(home, ".mattstack", "rt", "plugin-data", "test-plugin", "seen.json"), "utf8"));
    expect(seen).toEqual({ args: ["x", "y"], hasIdentity: false });
  });

  test("module handler honors fn and reports missing exports with provenance", async () => {
    writeFileSync(join(dir, "multi.ts"), `export async function add() {}`);
    const good = toCommandNode("test-plugin", dir, { description: "d", module: "./multi.ts", fn: "add" });
    await good.handler!([], {});
    const bad = toCommandNode("test-plugin", dir, { description: "d", module: "./multi.ts", fn: "nope" });
    expect(bad.handler!([], {})).rejects.toThrow(/test-plugin.*does not export "nope"/);
  });

  test("module handler wraps import failures with provenance", async () => {
    writeFileSync(join(dir, "broken.ts"), `throw new Error("module failed");`);
    const node = toCommandNode("test-plugin", dir, { description: "d", module: "./broken.ts" });
    expect(node.handler!([], {})).rejects.toThrow(/test-plugin.*failed to load/);
  });

  test("subcommands convert recursively", () => {
    const node = toCommandNode("test-plugin", dir, {
      description: "d",
      subcommands: { inner: { description: "e", module: "./x.ts" } },
    });
    expect(node.subcommands!.inner!.description).toBe("e");
    expect(typeof node.subcommands!.inner!.handler).toBe("function");
    expect(node.handler).toBeUndefined();
  });

  test("exec handler passes args + RT_* env and succeeds on exit 0", async () => {
    const script = join(dir, "probe.sh");
    writeFileSync(script, `#!/bin/sh\necho "$RT_PLUGIN_NAME|$RT_REPO_NAME|$@" > "${dir}/probe.out"\n`);
    chmodSync(script, 0o755);
    const node = toCommandNode("test-plugin", dir, { description: "d", exec: "./probe.sh" });
    await node.handler!(["one", "two"], {
      identity: { repoName: "r", identity: "path:/tmp/r", repoRoot: "/tmp/r", dataDir: "/tmp/d", remoteUrl: "", baseUrl: "" },
      autoResolved: true,
    });
    expect(readFileSync(join(dir, "probe.out"), "utf8").trim()).toBe("test-plugin|r|one two");
  });

  test("exec handler throws ExecFailure carrying the child's exit code", async () => {
    const script = join(dir, "fail.sh");
    writeFileSync(script, `#!/bin/sh\nexit 7\n`);
    chmodSync(script, 0o755);
    const node = toCommandNode("test-plugin", dir, { description: "d", exec: "./fail.sh" });
    try {
      await node.handler!([], {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecFailure);
      expect((err as ExecFailure).code).toBe(7);
    }
  });

  test("exec array form prepends fixed args; bare commands use PATH", async () => {
    const node = toCommandNode("test-plugin", dir, {
      description: "d",
      exec: ["sh", "-c", `echo fixed > "${dir}/sh.out"`],
    });
    await node.handler!([], {});
    expect(readFileSync(join(dir, "sh.out"), "utf8").trim()).toBe("fixed");
  });
});

function writePlugin(home: string, dirName: string, manifest: unknown): void {
  const dir = join(home, ".mattstack", "rt", "plugins", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
}

describe("discovery + merge", () => {
  let home: string;
  let savedHome: string | undefined;
  let warnings: string[];
  const warn = (m: string) => warnings.push(m);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-merge-"));
    savedHome = process.env.HOME;
    process.env.HOME = home;
    warnings = [];
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const BUILTINS = {
    version: { description: "Show version", aliases: ["v"], handler: async () => {} },
  };

  test("no plugins dir: returns builtins untouched, no warnings", () => {
    const tree = loadPluginTree(BUILTINS, warn);
    expect(Object.keys(tree)).toEqual(["version"]);
    expect(warnings).toEqual([]);
  });

  test("valid plugin commands merge into the tree", () => {
    writePlugin(home, "my-plugin", {
      name: "my-plugin", apiVersion: 1,
      commands: { standup: { description: "d", module: "./standup.ts" } },
    });
    const tree = loadPluginTree(BUILTINS, warn);
    expect(tree.standup!.description).toBe("d");
    expect(warnings).toEqual([]);
  });

  test("malformed JSON is skipped with a warning; rt keeps working", () => {
    writePlugin(home, "bad-plugin", "{ not json");
    writePlugin(home, "good-plugin", {
      name: "good-plugin", apiVersion: 1,
      commands: { ok: { description: "d", module: "./ok.ts" } },
    });
    const tree = loadPluginTree(BUILTINS, warn);
    expect(tree.ok).toBeDefined();
    expect(warnings.join()).toContain('skipping plugin "bad-plugin"');
  });

  test("built-in name and alias collisions: built-in wins", () => {
    writePlugin(home, "collide", {
      name: "collide", apiVersion: 1,
      commands: {
        version: { description: "shadow", module: "./v.ts" },
        mine: { description: "d", module: "./m.ts", aliases: ["v"] },
      },
    });
    const tree = loadPluginTree(BUILTINS, warn);
    expect(tree.version!.description).toBe("Show version");
    expect(tree.mine).toBeUndefined();
    expect(warnings.join()).toContain("collides with built-in");
  });

  test("plugin-vs-plugin collision: first by dir sort order wins", () => {
    const cmd = { dup: { description: "d", module: "./x.ts" } };
    writePlugin(home, "a-plugin", { name: "a-plugin", apiVersion: 1, commands: cmd });
    writePlugin(home, "b-plugin", { name: "b-plugin", apiVersion: 1, commands: cmd });
    const tree = loadPluginTree(BUILTINS, warn);
    expect(tree.dup).toBeDefined();
    expect(warnings.join()).toContain('plugin "b-plugin"');
    expect(warnings.join()).toContain('plugin "a-plugin"');
  });

  test("reserved fast-path name (verify) is not mounted even though it isn't a builtin", () => {
    writePlugin(home, "verify-plugin", {
      name: "verify-plugin", apiVersion: 1,
      commands: { verify: { description: "d", module: "./v.ts" } },
    });
    const tree = loadPluginTree(BUILTINS, warn);
    expect(tree.verify).toBeUndefined();
    expect(warnings.join()).toContain("verify");
    expect(warnings.join()).toContain("built-in");
  });

  test("manifest/dir name mismatch warns but still mounts", () => {
    writePlugin(home, "dir-name", {
      name: "other-name", apiVersion: 1,
      commands: { thing: { description: "d", module: "./t.ts" } },
    });
    const tree = loadPluginTree(BUILTINS, warn);
    expect(tree.thing).toBeDefined();
    expect(warnings.join()).toContain("differs from directory name");
  });

  test("discoverPlugins reports validation errors without throwing", () => {
    writePlugin(home, "wrong-version", { name: "wrong-version", apiVersion: 99, commands: { a: { description: "d", module: "./a.ts" } } });
    const found = discoverPlugins();
    expect(found).toHaveLength(1);
    expect(found[0]!.manifest).toBeNull();
    expect(found[0]!.errors.join()).toContain("apiVersion");
  });

  test("plugins path that is a file (not a dir) reports an error instead of throwing", () => {
    mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
    writeFileSync(join(home, ".mattstack", "rt", "plugins"), "not a directory");
    const found = discoverPlugins();
    expect(found).toHaveLength(1);
    expect(found[0]!.errors.join()).toContain("cannot read plugins directory");
  });
});

describe("scaffoldPlugin", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-scaffold-"));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("creates a valid, discoverable plugin and the plugin-api dir", () => {
    const dir = scaffoldPlugin("my-tool");
    expect(dir).toBe(join(home, ".mattstack", "rt", "plugins", "my-tool"));
    for (const f of ["plugin.json", "my-tool.ts", "tsconfig.json", "package.json"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(existsSync(join(home, ".mattstack", "rt", "plugin-api", "index.d.ts"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.commands["my-tool"].module).toBe("./my-tool.ts");

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.devDependencies["rt-plugin"]).toBe("file:../../plugin-api");
  });

  test("rejects non-kebab-case names and existing dirs", () => {
    expect(() => scaffoldPlugin("Bad Name")).toThrow(/kebab-case/);
    scaffoldPlugin("twice");
    expect(() => scaffoldPlugin("twice")).toThrow(/already exists/);
  });
});

describe("deepValidate", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-deepval-"));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  function plant(manifest: object, files: Record<string, string>): void {
    const dir = join(home, ".mattstack", "rt", "plugins", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  }

  test("healthy plugin: no problems", async () => {
    plant(
      { name: "p", apiVersion: 1, commands: { go: { description: "d", module: "./go.ts" } } },
      { "go.ts": "export async function run() {}" },
    );
    expect(await deepValidate(discoverPlugins()[0]!)).toEqual([]);
  });

  test("reports missing module file, missing fn export, import failure, missing exec target", async () => {
    plant(
      {
        name: "p", apiVersion: 1,
        commands: {
          gone: { description: "d", module: "./gone.ts" },
          nofn: { description: "d", module: "./nofn.ts", fn: "missing" },
          broken: { description: "d", module: "./broken.ts" },
          script: { description: "d", exec: "./nowhere.sh" },
        },
      },
      { "nofn.ts": "export const x = 1;", "broken.ts": 'import "./void.ts";' },
    );
    const problems = await deepValidate(discoverPlugins()[0]!);
    expect(problems.join()).toContain("gone: module ./gone.ts not found");
    expect(problems.join()).toContain('does not export "missing"');
    expect(problems.join()).toContain("failed to import");
    expect(problems.join()).toContain("exec target ./nowhere.sh not found");
  });
});
