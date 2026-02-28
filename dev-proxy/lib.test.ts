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
  flattenResources,
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
  test("2 worktrees: ports are assigned without collision", () => {
    const p0 = assignPorts(["backend", "adjuster", "frontend"], 0, 2);
    expect(p0).toEqual({
      backend: 52000,
      adjuster: 52002,
      frontend: 52004,
    });
    const p1 = assignPorts(["backend", "adjuster", "frontend"], 1, 2);
    expect(p1).toEqual({
      backend: 52001,
      adjuster: 52003,
      frontend: 52005,
    });
  });

  test("3 worktrees: ports scale without collision", () => {
    const names = ["backend", "adjuster", "frontend"];
    const p0 = assignPorts(names, 0, 3);
    const p1 = assignPorts(names, 1, 3);
    const p2 = assignPorts(names, 2, 3);
    const allPorts = [
      ...Object.values(p0),
      ...Object.values(p1),
      ...Object.values(p2),
    ];
    expect(new Set(allPorts).size).toBe(9);
  });

  test("works with arbitrary app names", () => {
    const ports = assignPorts(["api", "web"], 0, 2);
    expect(ports.api).toBe(52000);
    expect(ports.web).toBe(52002);
  });

  test("single app gets sequential ports per worktree", () => {
    expect(assignPorts(["api"], 0, 3).api).toBe(52000);
    expect(assignPorts(["api"], 1, 3).api).toBe(52001);
    expect(assignPorts(["api"], 2, 3).api).toBe(52002);
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
    const resolved = resolveWorktrees(detected, ["backend", "adjuster", "frontend"]);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].ports.backend).toBe(52000);
    expect(resolved[1].ports.backend).toBe(52001);
    expect(resolved[0].dir).toBe("/repo/a");
    expect(resolved[0].path).toBe("/a");
    expect(resolved[0].branch).toBe("main");
  });

  test("works with custom app names", () => {
    const detected: DetectedWorktree[] = [
      { dir: "/repo/a", branch: "main" },
    ];
    const resolved = resolveWorktrees(detected, ["api", "web"]);
    expect(resolved[0].ports.api).toBe(52000);
    expect(resolved[0].ports.web).toBe(52001);
  });
});

describe("deriveProxyConfigs", () => {
  test("creates proxy configs for apps with proxy field", () => {
    const detected: DetectedWorktree[] = [
      { dir: "/repo/a", branch: "main" },
      { dir: "/repo/b", branch: "feature" },
    ];
    const apps = [
      { name: "backend", cmd: "echo backend" },
      { name: "adjuster", cmd: "echo adj", proxy: { port: 4001 } },
      { name: "frontend", cmd: "echo fe", proxy: { port: 4002 } },
    ];
    const appNames = apps.map((a) => a.name);
    const resolved = resolveWorktrees(detected, appNames);
    const configs = deriveProxyConfigs(apps, resolved);

    expect(configs.size).toBe(2);
    expect(configs.has("backend")).toBe(false);

    const adjuster = configs.get("adjuster")!;
    expect(adjuster.port).toBe(4001);
    expect(adjuster.worktrees[0].upstream).toBe(resolved[0].ports.adjuster);
    expect(adjuster.worktrees[1].upstream).toBe(resolved[1].ports.adjuster);

    const frontend = configs.get("frontend")!;
    expect(frontend.port).toBe(4002);
    expect(frontend.worktrees[0].upstream).toBe(resolved[0].ports.frontend);
  });

  test("worktree paths and dirs are preserved", () => {
    const detected: DetectedWorktree[] = [
      { dir: "/repo/main", branch: "main" },
    ];
    const apps = [
      { name: "web", cmd: "echo web", proxy: { port: 4001 } },
    ];
    const resolved = resolveWorktrees(detected, ["web"]);
    const configs = deriveProxyConfigs(apps, resolved);
    const web = configs.get("web")!;
    expect(web.worktrees[0].path).toBe("/main");
    expect(web.worktrees[0].dir).toBe("/repo/main");
  });

  test("returns empty map when no apps have proxy", () => {
    const detected: DetectedWorktree[] = [
      { dir: "/repo/a", branch: "main" },
    ];
    const apps = [{ name: "api", cmd: "echo api" }];
    const resolved = resolveWorktrees(detected, ["api"]);
    const configs = deriveProxyConfigs(apps, resolved);
    expect(configs.size).toBe(0);
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

// ── flattenResources ────────────────────────────────────────

describe("flattenResources", () => {
  test("flattens setup/apps/tools into TiltResource array", () => {
    const config: DevConfig = {
      repoDir: "/repo",
      setup: [{ name: "install", cmd: "npm install" }],
      apps: [
        { name: "api", cmd: "PORT={port} node server.js", links: ["http://localhost:{port}"] },
      ],
      tools: [{ name: "lint", cmd: "npm run lint" }],
    };
    const resources = flattenResources(config);
    expect(resources).toHaveLength(3);

    // Setup
    expect(resources[0].name).toBe("install");
    expect(resources[0].labels).toEqual(["setup"]);
    expect(resources[0].cmdType).toBeUndefined();
    expect(resources[0].autoInit).toBeUndefined();

    // Apps
    expect(resources[1].name).toBe("api");
    expect(resources[1].labels).toEqual(["apps"]);
    expect(resources[1].cmdType).toBe("serve");
    // {port} should be replaced with {port_api}
    expect(resources[1].cmd).toContain("{port_api}");
    expect(resources[1].links).toEqual(["http://localhost:{port_api}"]);

    // Tools
    expect(resources[2].name).toBe("lint");
    expect(resources[2].labels).toEqual(["tools"]);
    expect(resources[2].autoInit).toBe(false);
  });

  test("handles missing optional sections", () => {
    const config: DevConfig = {
      repoDir: "/repo",
      apps: [{ name: "api", cmd: "node server.js" }],
    };
    const resources = flattenResources(config);
    expect(resources).toHaveLength(1);
    expect(resources[0].cmdType).toBe("serve");
  });

  test("preserves cross-reference port placeholders", () => {
    const config: DevConfig = {
      repoDir: "/repo",
      apps: [
        { name: "backend", cmd: "PORT={port} node server.js" },
        {
          name: "frontend",
          cmd: "PORT={port} BACKEND=http://localhost:{port_backend} parcel",
        },
      ],
    };
    const resources = flattenResources(config);
    expect(resources[1].cmd).toBe(
      "PORT={port_frontend} BACKEND=http://localhost:{port_backend} parcel",
    );
  });
});

// ── validateConfig ──────────────────────────────────────────

describe("validateConfig", () => {
  const base: DevConfig = {
    repoDir: "/repo",
    apps: [{ name: "api", cmd: "echo api" }],
  };

  test("passes for valid config", () => {
    expect(() => validateConfig(base)).not.toThrow();
  });

  test("passes with all sections", () => {
    expect(() =>
      validateConfig({
        ...base,
        setup: [{ name: "install", cmd: "npm i" }],
        tools: [{ name: "lint", cmd: "npm lint" }],
      }),
    ).not.toThrow();
  });

  test("throws on empty apps with no setup or tools", () => {
    expect(() =>
      validateConfig({ repoDir: "/repo", apps: [] }),
    ).toThrow("at least one resource");
  });

  test("throws on empty name", () => {
    expect(() =>
      validateConfig({
        repoDir: "/repo",
        apps: [{ name: "", cmd: "echo" }],
      }),
    ).toThrow("empty name");
  });

  test("throws on empty cmd", () => {
    expect(() =>
      validateConfig({
        repoDir: "/repo",
        apps: [{ name: "x", cmd: "  " }],
      }),
    ).toThrow("empty cmd");
  });

  test("throws on duplicate names across sections", () => {
    expect(() =>
      validateConfig({
        repoDir: "/repo",
        setup: [{ name: "x", cmd: "echo 1" }],
        apps: [{ name: "x", cmd: "echo 2" }],
      }),
    ).toThrow("Duplicate resource name: 'x'");
  });

  test("throws on unknown dep", () => {
    expect(() =>
      validateConfig({
        repoDir: "/repo",
        apps: [{ name: "a", cmd: "echo a", deps: ["missing"] }],
      }),
    ).toThrow("depends on unknown resource 'missing'");
  });

  test("passes with valid cross-section deps", () => {
    expect(() =>
      validateConfig({
        repoDir: "/repo",
        setup: [{ name: "install", cmd: "npm i" }],
        apps: [{ name: "api", cmd: "npm start", deps: ["install"] }],
      }),
    ).not.toThrow();
  });
});

// ── generateTiltfile ────────────────────────────────────────

describe("generateTiltfile", () => {
  const appNames = ["api"];

  test("renders a minimal run resource", () => {
    const resources: TiltResource[] = [
      { name: "install", cmd: "npm install", labels: ["setup"] },
    ];
    const out = generateTiltfile(resources, appNames);
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
    const out = generateTiltfile(resources, appNames);
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
    const out = generateTiltfile(resources, appNames);
    expect(out).toContain("auto_init=False");
  });

  test("autoInit true or undefined does not emit auto_init", () => {
    const resources: TiltResource[] = [
      { name: "build", cmd: "npm run build", labels: ["setup"] },
    ];
    const out = generateTiltfile(resources, appNames);
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
    const out = generateTiltfile(resources, appNames);
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
    const out = generateTiltfile(resources, appNames);
    expect(out).toContain("links=['http://localhost:3000']");
  });

  test("groups resources by first label with section comments", () => {
    const resources: TiltResource[] = [
      { name: "a", cmd: "echo a", labels: ["setup"] },
      { name: "b", cmd: "echo b", labels: ["setup"] },
      { name: "c", cmd: "echo c", labels: ["apps"] },
    ];
    const out = generateTiltfile(resources, appNames);
    const setupIdx = out.indexOf("# ── Setup");
    const appsIdx = out.indexOf("# ── Apps");
    expect(setupIdx).toBeGreaterThan(-1);
    expect(appsIdx).toBeGreaterThan(setupIdx);
  });

  test("emits dynamic PORT env vars based on app names", () => {
    const out = generateTiltfile([], ["backend", "adjuster", "frontend"]);
    expect(out).toContain("REPO_ROOT = os.environ['REPO_ROOT']");
    expect(out).toContain("PORT_BACKEND");
    expect(out).toContain("PORT_ADJUSTER");
    expect(out).toContain("PORT_FRONTEND");
  });

  test("emits only provided app names in preamble", () => {
    const out = generateTiltfile([], ["api", "web"]);
    expect(out).toContain("PORT_API");
    expect(out).toContain("PORT_WEB");
    expect(out).not.toContain("PORT_BACKEND");
  });

  test("multi-line cmd uses triple-quoted string", () => {
    const resources: TiltResource[] = [
      {
        name: "multi",
        cmd: "echo hello\necho world",
        labels: ["setup"],
      },
    ];
    const out = generateTiltfile(resources, appNames);
    expect(out).toContain("cmd='''");
  });
});

// ── Starlark syntax validation ──────────────────────────────

describe("Starlark syntax", () => {
  test("generated Tiltfile is valid Python syntax", () => {
    const appNames = ["api"];
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
    const tiltfile = generateTiltfile(resources, appNames);
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
    const resources = flattenResources(config);
    const appNames = config.apps.map((a) => a.name);
    const tiltfile = generateTiltfile(resources, appNames);
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
