import { describe, test, expect } from "bun:test";
import {
  assignPorts,
  resolveWorktrees,
  deriveProxyConfigs,
  pathFromDir,
  displayName,
  isHtmlResponse,
  parseWorktreeCookie,
  pickUpstream,
  shortDirFromPath,
  validateConfig,
  BADGE_COLORS,
  type Worktree,
  type DetectedWorktree,
  type DevConfig,
  type TiltResource,
} from "./lib";
import { generateTiltfile, normalizeCmd } from "./tiltfile-template";

describe("displayName", () => {
  test("extracts last path segment", () => {
    expect(displayName({ path: "/-/main", upstream: 3000 })).toBe("main");
  });

  test("handles deeply nested paths", () => {
    expect(displayName({ path: "/a/b/feature", upstream: 3000 })).toBe(
      "feature",
    );
  });

  test("handles single segment path", () => {
    expect(displayName({ path: "/main", upstream: 3000 })).toBe("main");
  });

  test("falls back to raw path if no segments", () => {
    expect(displayName({ path: "/", upstream: 3000 })).toBe("/");
  });
});

describe("isHtmlResponse", () => {
  test("returns true for text/html", () => {
    const headers = new Headers({ "content-type": "text/html" });
    expect(isHtmlResponse(headers)).toBe(true);
  });

  test("returns true for text/html with charset", () => {
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
    });
    expect(isHtmlResponse(headers)).toBe(true);
  });

  test("returns false for application/json", () => {
    const headers = new Headers({ "content-type": "application/json" });
    expect(isHtmlResponse(headers)).toBe(false);
  });

  test("returns false for text/css", () => {
    const headers = new Headers({ "content-type": "text/css" });
    expect(isHtmlResponse(headers)).toBe(false);
  });

  test("returns false when no content-type header", () => {
    const headers = new Headers();
    expect(isHtmlResponse(headers)).toBe(false);
  });
});

describe("parseWorktreeCookie", () => {
  test("extracts wt value from cookie string", () => {
    expect(parseWorktreeCookie("wt=/-/main")).toBe("/-/main");
  });

  test("extracts wt from multiple cookies", () => {
    expect(parseWorktreeCookie("session=abc; wt=/-/feature; theme=dark")).toBe(
      "/-/feature",
    );
  });

  test("returns null when no wt cookie", () => {
    expect(parseWorktreeCookie("session=abc; theme=dark")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseWorktreeCookie("")).toBeNull();
  });
});

describe("pickUpstream", () => {
  const wtA: Worktree = { path: "/-/a", upstream: 3001 };
  const wtB: Worktree = { path: "/-/b", upstream: 3002 };
  const byPath = new Map([
    ["/-/a", wtA],
    ["/-/b", wtB],
  ]);

  test("returns default when no cookie", () => {
    const req = new Request("http://localhost/");
    expect(pickUpstream(req, byPath, wtA)).toBe(wtA);
  });

  test("returns matching worktree from cookie", () => {
    const req = new Request("http://localhost/", {
      headers: { cookie: "wt=/-/b" },
    });
    expect(pickUpstream(req, byPath, wtA)).toBe(wtB);
  });

  test("returns default for unknown cookie value", () => {
    const req = new Request("http://localhost/", {
      headers: { cookie: "wt=/-/unknown" },
    });
    expect(pickUpstream(req, byPath, wtA)).toBe(wtA);
  });

  test("returns default when cookie has other values only", () => {
    const req = new Request("http://localhost/", {
      headers: { cookie: "session=xyz" },
    });
    expect(pickUpstream(req, byPath, wtA)).toBe(wtA);
  });
});

describe("shortDirFromPath", () => {
  test("returns last two segments", () => {
    expect(
      shortDirFromPath("/Users/matthew/Documents/GitHub/assured-dev"),
    ).toBe("GitHub/assured-dev");
  });

  test("handles trailing slash", () => {
    expect(
      shortDirFromPath("/Users/matthew/Documents/GitHub/assured-dev/"),
    ).toBe("GitHub/assured-dev");
  });

  test("handles short path", () => {
    expect(shortDirFromPath("/repo")).toBe("/repo");
  });
});

describe("assignPorts", () => {
  test("2 worktrees: backend lanes are 52000-52001", () => {
    expect(assignPorts(0, 2)).toEqual({
      backend: 52000,
      adjuster: 52002,
      frontend: 52004,
    });
    expect(assignPorts(1, 2)).toEqual({
      backend: 52001,
      adjuster: 52003,
      frontend: 52005,
    });
  });

  test("3 worktrees: ports scale without collision", () => {
    const p0 = assignPorts(0, 3);
    const p1 = assignPorts(1, 3);
    const p2 = assignPorts(2, 3);
    const allPorts = [
      p0.backend,
      p0.adjuster,
      p0.frontend,
      p1.backend,
      p1.adjuster,
      p1.frontend,
      p2.backend,
      p2.adjuster,
      p2.frontend,
    ];
    expect(new Set(allPorts).size).toBe(9);
  });

  test("overrides replace computed values", () => {
    const ports = assignPorts(0, 2, { backend: 9999 });
    expect(ports.backend).toBe(9999);
    expect(ports.adjuster).toBe(52002);
  });
});

describe("pathFromDir", () => {
  test("extracts last dir segment as path", () => {
    expect(pathFromDir("/Users/matthew/Documents/GitHub/assured-dev")).toBe(
      "/assured-dev",
    );
  });

  test("strips trailing slash", () => {
    expect(pathFromDir("/repo/my-project/")).toBe("/my-project");
  });
});

describe("resolveWorktrees", () => {
  test("resolves worktrees with auto-assigned ports", () => {
    const detected: DetectedWorktree[] = [
      { dir: "/repo/a", branch: "main" },
      { dir: "/repo/b", branch: "feature" },
    ];
    const resolved = resolveWorktrees(detected);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].ports.backend).toBe(52000);
    expect(resolved[1].ports.backend).toBe(52001);
    expect(resolved[0].dir).toBe("/repo/a");
    expect(resolved[0].path).toBe("/a");
    expect(resolved[0].branch).toBe("main");
  });
});

describe("deriveProxyConfigs", () => {
  test("creates adjuster and frontend proxy configs", () => {
    const detected: DetectedWorktree[] = [
      { dir: "/repo/a", branch: "main" },
      { dir: "/repo/b", branch: "feature" },
    ];
    const resolved = resolveWorktrees(detected);
    const proxyPorts = { adjuster: 4001, frontend: 4002 };
    const { adjuster, frontend } = deriveProxyConfigs(proxyPorts, resolved);

    expect(adjuster.port).toBe(4001);
    expect(adjuster.worktrees[0].upstream).toBe(resolved[0].ports.adjuster);
    expect(adjuster.worktrees[1].upstream).toBe(resolved[1].ports.adjuster);

    expect(frontend.port).toBe(4002);
    expect(frontend.worktrees[0].upstream).toBe(resolved[0].ports.frontend);
    expect(frontend.worktrees[1].upstream).toBe(resolved[1].ports.frontend);
  });

  test("worktree paths and dirs are preserved", () => {
    const detected: DetectedWorktree[] = [
      { dir: "/repo/main", branch: "main" },
    ];
    const resolved = resolveWorktrees(detected);
    const proxyPorts = { adjuster: 4001, frontend: 4002 };
    const { adjuster } = deriveProxyConfigs(proxyPorts, resolved);
    expect(adjuster.worktrees[0].path).toBe("/main");
    expect(adjuster.worktrees[0].dir).toBe("/repo/main");
  });
});

describe("BADGE_COLORS", () => {
  test("has at least 2 colors", () => {
    expect(BADGE_COLORS.length).toBeGreaterThanOrEqual(2);
  });

  test("all entries are hex color strings", () => {
    for (const c of BADGE_COLORS) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

// ── validateConfig ──────────────────────────────────────────

describe("validateConfig", () => {
  const base: DevConfig = {
    repoDir: "/repo",
    resources: [{ name: "a", cmd: "echo a", labels: ["setup"] }],
  };

  test("passes for valid config", () => {
    expect(() => validateConfig(base)).not.toThrow();
  });

  test("throws on empty resources", () => {
    expect(() =>
      validateConfig({ ...base, resources: [] }),
    ).toThrow("at least one resource");
  });

  test("throws on empty name", () => {
    expect(() =>
      validateConfig({
        ...base,
        resources: [{ name: "", cmd: "echo", labels: ["x"] }],
      }),
    ).toThrow("empty name");
  });

  test("throws on empty cmd", () => {
    expect(() =>
      validateConfig({
        ...base,
        resources: [{ name: "x", cmd: "  ", labels: ["x"] }],
      }),
    ).toThrow("empty cmd");
  });

  test("throws on empty labels", () => {
    expect(() =>
      validateConfig({
        ...base,
        resources: [{ name: "x", cmd: "echo", labels: [] }],
      }),
    ).toThrow("at least one label");
  });

  test("throws on duplicate names", () => {
    expect(() =>
      validateConfig({
        ...base,
        resources: [
          { name: "x", cmd: "echo 1", labels: ["a"] },
          { name: "x", cmd: "echo 2", labels: ["a"] },
        ],
      }),
    ).toThrow("Duplicate resource name: 'x'");
  });

  test("throws on unknown dep", () => {
    expect(() =>
      validateConfig({
        ...base,
        resources: [
          { name: "a", cmd: "echo a", labels: ["s"], deps: ["missing"] },
        ],
      }),
    ).toThrow("depends on unknown resource 'missing'");
  });

  test("passes with valid deps", () => {
    expect(() =>
      validateConfig({
        ...base,
        resources: [
          { name: "install", cmd: "npm i", labels: ["setup"] },
          {
            name: "build",
            cmd: "npm build",
            labels: ["setup"],
            deps: ["install"],
          },
        ],
      }),
    ).not.toThrow();
  });
});

// ── generateTiltfile ────────────────────────────────────────

describe("generateTiltfile", () => {
  test("renders a minimal run resource", () => {
    const resources: TiltResource[] = [
      { name: "install", cmd: "npm install", labels: ["setup"] },
    ];
    const out = generateTiltfile(resources);
    expect(out).toContain("local_resource(");
    expect(out).toContain("'install'");
    expect(out).toContain("cmd='npm install'");
    expect(out).toContain("labels=['setup']");
  });

  test("cmdType serve emits serve_cmd", () => {
    const resources: TiltResource[] = [
      {
        name: "server",
        cmd: "node index.js",
        cmdType: "serve",
        labels: ["apps"],
      },
    ];
    const out = generateTiltfile(resources);
    expect(out).toContain("serve_cmd='node index.js'");
    // Ensure 'cmd=' does not appear as a standalone key (only as part of serve_cmd)
    expect(out).not.toMatch(/[^_]cmd='/);
  });

  test("autoInit false emits auto_init=False", () => {
    const resources: TiltResource[] = [
      {
        name: "lint",
        cmd: "npm run lint",
        labels: ["tools"],
        autoInit: false,
      },
    ];
    const out = generateTiltfile(resources);
    expect(out).toContain("auto_init=False");
  });

  test("autoInit true or undefined does not emit auto_init", () => {
    const resources: TiltResource[] = [
      { name: "build", cmd: "npm run build", labels: ["setup"] },
    ];
    const out = generateTiltfile(resources);
    expect(out).not.toContain("auto_init");
  });

  test("deps renders resource_deps", () => {
    const resources: TiltResource[] = [
      {
        name: "test",
        cmd: "npm test",
        labels: ["checks"],
        deps: ["install", "build"],
      },
    ];
    const out = generateTiltfile(resources);
    expect(out).toContain("resource_deps=['install', 'build']");
  });

  test("links renders links", () => {
    const resources: TiltResource[] = [
      {
        name: "api",
        cmd: "node api.js",
        cmdType: "serve",
        labels: ["apps"],
        links: ["http://localhost:3000"],
      },
    ];
    const out = generateTiltfile(resources);
    expect(out).toContain("links=['http://localhost:3000']");
  });

  test("groups resources by first label with section comments", () => {
    const resources: TiltResource[] = [
      { name: "a", cmd: "echo a", labels: ["setup"] },
      { name: "b", cmd: "echo b", labels: ["setup"] },
      { name: "c", cmd: "echo c", labels: ["apps"] },
    ];
    const out = generateTiltfile(resources);
    const setupIdx = out.indexOf("# ── Setup");
    const appsIdx = out.indexOf("# ── Apps");
    expect(setupIdx).toBeGreaterThan(-1);
    expect(appsIdx).toBeGreaterThan(setupIdx);
  });

  test("always emits env var preamble", () => {
    const out = generateTiltfile([]);
    expect(out).toContain("REPO_ROOT = os.environ['REPO_ROOT']");
    expect(out).toContain("PORT_BACKEND");
  });

  test("multi-line cmd uses triple-quoted string", () => {
    const resources: TiltResource[] = [
      {
        name: "multi",
        cmd: "echo hello\necho world",
        labels: ["setup"],
      },
    ];
    const out = generateTiltfile(resources);
    expect(out).toContain("cmd='''");
  });
});

// ── Starlark syntax validation ──────────────────────────────

describe("Starlark syntax", () => {
  test("generated Tiltfile is valid Python syntax", () => {
    const resources: TiltResource[] = [
      { name: "install", cmd: "npm install", labels: ["setup"] },
      {
        name: "api",
        cmd: "cd /repo && npm start",
        cmdType: "serve",
        labels: ["apps"],
        deps: ["install"],
        links: ["http://localhost:3000"],
      },
      {
        name: "migrate",
        cmd: "cd /repo\necho 'running migrations'\nnpm run migrate",
        labels: ["setup"],
        deps: ["install"],
      },
      {
        name: "lint",
        cmd: "npm run lint",
        labels: ["tools"],
        autoInit: false,
      },
    ];
    const tiltfile = generateTiltfile(resources);
    const result = Bun.spawnSync([
      "python3",
      "-c",
      `compile(${JSON.stringify(tiltfile)}, '<tiltfile>', 'exec')`,
    ]);
    if (result.exitCode !== 0) {
      const err = new TextDecoder().decode(result.stderr);
      throw new Error(
        `Generated Tiltfile has invalid syntax:\n${err}\n\nTiltfile:\n${tiltfile}`,
      );
    }
  });

  test("actual config produces valid Python syntax", async () => {
    const configPath = new URL("./dev-proxy.config.ts", import.meta.url)
      .pathname;
    const { default: config } = (await import(configPath)) as {
      default: DevConfig;
    };
    const tiltfile = generateTiltfile(config.resources);
    const result = Bun.spawnSync([
      "python3",
      "-c",
      `compile(${JSON.stringify(tiltfile)}, '<tiltfile>', 'exec')`,
    ]);
    if (result.exitCode !== 0) {
      const err = new TextDecoder().decode(result.stderr);
      throw new Error(
        `Config Tiltfile has invalid syntax:\n${err}\n\nTiltfile:\n${tiltfile}`,
      );
    }
  });
});

// ── normalizeCmd ────────────────────────────────────────────

describe("normalizeCmd", () => {
  test("collapses indented continuations into single line", () => {
    const input = `cd /repo/apps/backend &&
        PORT=3000
        doppler run --preserve-env --
        node server.js`;
    expect(normalizeCmd(input)).toBe(
      "cd /repo/apps/backend && PORT=3000 doppler run --preserve-env -- node server.js",
    );
  });

  test("preserves real shell scripts with if/then/fi", () => {
    const input = `cd /repo
if true; then
    echo yes
fi`;
    expect(normalizeCmd(input)).toBe(input);
  });

  test("preserves single-line commands as-is", () => {
    expect(normalizeCmd("npm install")).toBe("npm install");
  });

  test("preserves for/do/done scripts", () => {
    const input = `for f in *.js; do
    echo $f
done`;
    expect(normalizeCmd(input)).toBe(input);
  });

  test("serve cmd with no script keywords collapses", () => {
    const input = `cd /repo &&
        PORT=3000
        pnpm exec parcel src/index.html`;
    const result = normalizeCmd(input);
    expect(result).not.toContain("\n");
    expect(result).toBe("cd /repo && PORT=3000 pnpm exec parcel src/index.html");
  });
});
