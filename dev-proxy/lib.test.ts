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
  BADGE_COLORS,
  type Worktree,
  type DetectedWorktree,
} from "./lib";

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
