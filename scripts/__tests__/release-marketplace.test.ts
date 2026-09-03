import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BASE_PLUGINS } from "../../lib/setup/base-plugins";

// Everything here is offline: the only remotes are local bare repos, so the
// suite exercises the real push and the real `git ls-remote` re-pin without a
// network. `claude` is used when it happens to be on PATH — the script's own
// structural checks are what run in CI.

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "release", "marketplace.sh");

let TMP: string;

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "rt-marketplace-test-"));
});
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
function scratch(name: string): string {
  const dir = join(TMP, `${name}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PINNED_SHA = "a".repeat(40);

interface Plugin {
  name: string;
  source: unknown;
  description?: string;
}

function catalog(plugins: Plugin[]): string {
  return JSON.stringify({ name: "mattstack", owner: { name: "Test" }, plugins }, null, 2);
}

function urlPlugin(name: string, url = "https://github.com/example/x.git", sha = PINNED_SHA): Plugin {
  return { name, source: { source: "url", url, ref: "main", sha }, description: name };
}

/** A source dir shaped like the repo's own `marketplace/`. */
function sourceDir(plugins: Plugin[]): string {
  const dir = scratch("src");
  writeFileSync(join(dir, "marketplace.json"), catalog(plugins));
  writeFileSync(join(dir, "README.md"), "# test\n");
  writeFileSync(join(dir, "LICENSE"), "MIT\n");
  return dir;
}

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const res = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function bareRepo(): string {
  const dir = scratch("bare");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
  return dir;
}

/** The published tree, read back out of the bare repo the way a clone would see it. */
function publishedFiles(bare: string): string[] {
  return git(bare, "ls-tree", "-r", "--name-only", "main").split("\n").filter(Boolean).sort();
}

describe("marketplace.sh validation", () => {
  test("accepts a catalog of pinned url sources", () => {
    const r = run(["--dry-run", sourceDir([urlPlugin("fast-browser")])]);
    expect(r.out).toContain("staged and validated");
    expect(r.code).toBe(0);
  });

  test("rejects a url source whose sha is not a full 40-char commit", () => {
    const r = run(["--dry-run", sourceDir([urlPlugin("fast-browser", undefined, "abc1234")])]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("needs a full 40-char sha");
  });

  test("rejects a relative source that is not in the published tree", () => {
    const src = sourceDir([{ name: "current-time", source: "./plugins/current-time" }]);
    const r = run(["--dry-run", src]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not in the published tree");
  });

  test("rejects a relative source with no plugin.json", () => {
    const src = sourceDir([{ name: "current-time", source: "./plugins/current-time" }]);
    mkdirSync(join(src, "plugins", "current-time"), { recursive: true });
    const r = run(["--dry-run", src]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no .claude-plugin/plugin.json");
  });

  test("accepts a relative source that carries a real plugin", () => {
    const src = sourceDir([{ name: "current-time", source: "./plugins/current-time" }]);
    const plugin = join(src, "plugins", "current-time", ".claude-plugin");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "current-time", version: "0.1.0" }));
    const r = run(["--dry-run", src]);
    expect(r.out).toContain("staged and validated");
    expect(r.code).toBe(0);
  });

  // The whole reason the published catalog uses pinned URLs: git stores a
  // symlink as a link, so a clone would resolve it against paths that only
  // exist on the authoring machine.
  test("rejects a symlink in the staged tree", () => {
    const src = sourceDir([{ name: "linked", source: "./plugins/linked" }]);
    const real = join(src, "real-plugin", ".claude-plugin");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "plugin.json"), JSON.stringify({ name: "linked" }));
    mkdirSync(join(src, "plugins"), { recursive: true });
    symlinkSync(join(src, "real-plugin"), join(src, "plugins", "linked"));
    const r = run(["--dry-run", src]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("dangling pointers");
  });

  // Both of these resolve against the authoring machine, so they can validate
  // here and still be missing for every client.
  test("rejects an absolute relative-source path", () => {
    const r = run(["--dry-run", sourceDir([{ name: "escapee", source: "/etc" }])]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("points outside the published tree");
  });

  test("rejects a relative source that escapes the tree with ..", () => {
    const r = run(["--dry-run", sourceDir([{ name: "escapee", source: "../../etc" }])]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("points outside the published tree");
  });

  test("rejects a url source with no url", () => {
    const r = run(["--dry-run", sourceDir([{ name: "x", source: { source: "url", sha: PINNED_SHA } }])]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("has no url");
  });

  test("rejects a catalog with no plugins", () => {
    const r = run(["--dry-run", sourceDir([])]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("lists no plugins");
  });

  test("rejects the same plugin name twice", () => {
    const r = run(["--dry-run", sourceDir([urlPlugin("dup"), urlPlugin("dup")])]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("listed twice");
  });
});

describe("marketplace.sh publish", () => {
  test("publishes the catalog into an empty repo", () => {
    const bare = bareRepo();
    const r = run([sourceDir([urlPlugin("fast-browser")])], { RT_MARKETPLACE_REPO: bare });
    expect(r.out).toContain("no main yet");
    expect(r.code).toBe(0);
    expect(publishedFiles(bare)).toEqual([".claude-plugin/marketplace.json", "LICENSE", "README.md"]);
  });

  test("republishing identical content makes no commit", () => {
    const bare = bareRepo();
    const src = sourceDir([urlPlugin("fast-browser")]);
    run([src], { RT_MARKETPLACE_REPO: bare });
    const first = git(bare, "rev-parse", "main");
    const r = run([src], { RT_MARKETPLACE_REPO: bare });
    expect(r.out).toContain("nothing to publish");
    expect(r.code).toBe(0);
    expect(git(bare, "rev-parse", "main")).toBe(first);
  });

  // Dropping a plugin has to remove it from the published repo, not just from
  // the catalog — a stale directory left behind is still installable.
  test("a file dropped from the source is dropped from the published tree", () => {
    const bare = bareRepo();
    const withPlugin = sourceDir([
      urlPlugin("fast-browser"),
      { name: "inline", source: "./plugins/inline" },
    ]);
    const inline = join(withPlugin, "plugins", "inline", ".claude-plugin");
    mkdirSync(inline, { recursive: true });
    writeFileSync(join(inline, "plugin.json"), JSON.stringify({ name: "inline" }));
    run([withPlugin], { RT_MARKETPLACE_REPO: bare });
    expect(publishedFiles(bare)).toContain("plugins/inline/.claude-plugin/plugin.json");

    run([sourceDir([urlPlugin("fast-browser")])], { RT_MARKETPLACE_REPO: bare });
    expect(publishedFiles(bare)).toEqual([".claude-plugin/marketplace.json", "LICENSE", "README.md"]);
    // History is kept rather than force-pushed away.
    expect(git(bare, "rev-list", "--count", "main")).toBe("2");
  });

  test("a rejected catalog never reaches the remote", () => {
    const bare = bareRepo();
    const r = run([sourceDir([urlPlugin("fast-browser", undefined, "short")])], { RT_MARKETPLACE_REPO: bare });
    expect(r.code).not.toBe(0);
    expect(spawnSync("git", ["-C", bare, "rev-parse", "main"]).status).not.toBe(0);
  });
});

describe("marketplace.sh --refresh", () => {
  test("re-pins each url source to its ref's current head", () => {
    const upstream = scratch("upstream");
    execFileSync("git", ["init", "-q", "-b", "main", upstream]);
    writeFileSync(join(upstream, "f"), "one");
    git(upstream, "add", "-A");
    git(upstream, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one");
    const head = git(upstream, "rev-parse", "HEAD");

    const src = sourceDir([urlPlugin("fast-browser", upstream)]);
    const r = run(["--refresh", src]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(head.slice(0, 12));

    const doc = JSON.parse(readFileSync(join(src, "marketplace.json"), "utf8"));
    expect(doc.plugins[0].source.sha).toBe(head);
    expect(doc.plugins[0].source.ref).toBe("main");
  });

  test("reports an already-current pin instead of rewriting it", () => {
    const upstream = scratch("upstream");
    execFileSync("git", ["init", "-q", "-b", "main", upstream]);
    writeFileSync(join(upstream, "f"), "one");
    git(upstream, "add", "-A");
    git(upstream, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one");
    const head = git(upstream, "rev-parse", "HEAD");

    const src = sourceDir([urlPlugin("fast-browser", upstream, head)]);
    const r = run(["--refresh", src]);
    expect(r.out).toContain("unchanged");
    expect(r.out).toContain("every pin already current");
  });

  // A catalog holding some plugins' new pins and others' old ones reads as a
  // deliberate partial bump, which is worse than not having moved at all.
  test("writes no pin at all when a later plugin's ref is missing", () => {
    const upstream = scratch("upstream");
    execFileSync("git", ["init", "-q", "-b", "main", upstream]);
    writeFileSync(join(upstream, "f"), "one");
    git(upstream, "add", "-A");
    git(upstream, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one");

    const src = sourceDir([
      urlPlugin("resolves-fine", upstream),
      { name: "broken", source: { source: "url", url: upstream, ref: "nope", sha: PINNED_SHA } },
    ]);
    const r = run(["--refresh", src]);
    expect(r.code).not.toBe(0);

    const doc = JSON.parse(readFileSync(join(src, "marketplace.json"), "utf8"));
    expect(doc.plugins[0].source.sha).toBe(PINNED_SHA);
  });

  test("refuses to refresh a url source with no url", () => {
    const src = sourceDir([{ name: "x", source: { source: "url", ref: "main", sha: PINNED_SHA } }]);
    const r = run(["--refresh", src]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("has no url");
  });

  // A pin with no `ref` is deliberate: it never follows a branch, so there is
  // nothing for --refresh to re-resolve it against.
  test("leaves a url source with no ref alone", () => {
    const src = sourceDir([
      { name: "pinned-forever", source: { source: "url", url: "https://example.com/x.git", sha: PINNED_SHA } },
    ]);
    const r = run(["--refresh", src]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("every pin already current");
    expect(JSON.parse(readFileSync(join(src, "marketplace.json"), "utf8")).plugins[0].source.sha).toBe(PINNED_SHA);
  });

  // Pins are applied by name, so a duplicate would take whichever resolved
  // last — and --refresh runs on its own, before publishing would catch it.
  test("refuses to refresh a catalog listing one name twice", () => {
    const src = sourceDir([urlPlugin("dup"), urlPlugin("dup")]);
    const before = readFileSync(join(src, "marketplace.json"), "utf8");
    const r = run(["--refresh", src]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("listed twice");
    expect(readFileSync(join(src, "marketplace.json"), "utf8")).toBe(before);
  });

  test("fails loudly when a ref does not exist upstream", () => {
    const upstream = scratch("upstream");
    execFileSync("git", ["init", "-q", "-b", "main", upstream]);
    writeFileSync(join(upstream, "f"), "one");
    git(upstream, "add", "-A");
    git(upstream, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one");

    const src = sourceDir([
      { name: "fast-browser", source: { source: "url", url: upstream, ref: "nope", sha: PINNED_SHA } },
    ]);
    const r = run(["--refresh", src]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("nope not found");
  });
});

describe("the catalog this repo actually publishes", () => {
  const doc = JSON.parse(readFileSync(join(ROOT, "marketplace", "marketplace.json"), "utf8"));

  // BASE_PLUGINS installs "<name>@mattstack"; the catalog's own name is what
  // the "@mattstack" half resolves against.
  test("is named mattstack", () => {
    expect(doc.name).toBe("mattstack");
  });

  test("carries every plugin plugins.install treats as baseline", () => {
    const base = BASE_PLUGINS.map((entry) => entry.split("@")[0]);
    expect(base.length).toBeGreaterThan(0);
    const listed = doc.plugins.map((p: { name: string }) => p.name);
    for (const name of base) expect(listed).toContain(name);
  });

  test("is published to the source plugins.install hardcodes", () => {
    const src = readFileSync(join(ROOT, "lib", "setup", "steps", "plugins.ts"), "utf8");
    expect(src).toContain("https://github.com/m4ttstack/mattstack-marketplace");
    expect(readFileSync(SCRIPT, "utf8")).toContain("m4ttstack/mattstack-marketplace");
  });
});
