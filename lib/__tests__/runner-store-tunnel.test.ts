import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmp: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rt-runner-tunnel-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
});
afterEach(() => {
  if (origHome) process.env.HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("LaneConfig tunnel round-trip", () => {
  test("absent tunnel field round-trips as undefined", async () => {
    const { saveRunnerConfig, loadRunnerConfig } = await import("../runner-store.ts");
    saveRunnerConfig("test", [{
      id: "1", canonicalPort: 4000, entries: [], repoName: "repo-a", mode: "warm",
    }]);
    const loaded = loadRunnerConfig("test");
    expect(loaded[0]!.tunnel).toBeUndefined();
  });

  test("tunnel.enabled=true survives save/load", async () => {
    const { saveRunnerConfig, loadRunnerConfig } = await import("../runner-store.ts");
    saveRunnerConfig("test", [{
      id: "1", canonicalPort: 4000, entries: [], repoName: "repo-a", mode: "warm",
      tunnel: { enabled: true },
    }]);
    const loaded = loadRunnerConfig("test");
    expect(loaded[0]!.tunnel).toEqual({ enabled: true });
  });

  test("tunnel.enabled=false also persists (explicitly disabled)", async () => {
    const { saveRunnerConfig, loadRunnerConfig } = await import("../runner-store.ts");
    saveRunnerConfig("test", [{
      id: "1", canonicalPort: 4000, entries: [], repoName: "repo-a", mode: "warm",
      tunnel: { enabled: false },
    }]);
    const loaded = loadRunnerConfig("test");
    expect(loaded[0]!.tunnel).toEqual({ enabled: false });
  });
});
