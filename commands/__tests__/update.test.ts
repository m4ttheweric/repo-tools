import { describe, expect, test } from "bun:test";
import { RELEASES_URL, runUpdate, type UpdateDeps } from "../update.ts";

interface Harness {
  deps: UpdateDeps;
  calls: string[];
  logs: string[];
  exitCode: number | null;
}

function harness(opts: {
  mode?: "dev" | "prod";
  tray?: (endpoint: string, method: "GET" | "POST") => Promise<{ ok: boolean; error?: string } | null>;
}): Harness {
  const calls: string[] = [];
  const logs: string[] = [];
  let exitCode: number | null = null;

  const deps: UpdateDeps = {
    async tray(endpoint, method) {
      calls.push(`${method} ${endpoint}`);
      return opts.tray ? opts.tray(endpoint, method) : null;
    },
    currentMode: () => opts.mode ?? "prod",
    log: (line) => logs.push(line),
    exit: ((code: number) => {
      exitCode = code;
      return undefined as never;
    }) as UpdateDeps["exit"],
  };

  return { deps, calls, logs, get exitCode(): number | null { return exitCode; } };
}

describe("runUpdate", () => {
  test("dev mode — refuses without ever calling the tray, exit 2", async () => {
    const h = harness({ mode: "dev" });
    await runUpdate([], {}, h.deps);
    expect(h.calls).toEqual([]);
    expect(h.logs[0]).toBe("dev mode is active — switch to prod first: rt settings dev-mode prod");
    expect(h.exitCode).toBe(2);
  });

  test("dev mode with --json — envelope error code dev-mode, exit 2", async () => {
    const h = harness({ mode: "dev" });
    await runUpdate(["--json"], {}, h.deps);
    const body = JSON.parse(h.logs[0]!);
    expect(body.error.code).toBe("dev-mode");
    expect(h.exitCode).toBe(2);
  });

  test("prod mode, app answers ok:true — asks mattstack.app, no exit call", async () => {
    const h = harness({ mode: "prod", tray: async () => ({ ok: true }) });
    await runUpdate([], {}, h.deps);
    expect(h.calls).toEqual(["POST /update/check"]);
    expect(h.logs[0]).toBe("asked mattstack.app to check for updates (Sparkle) — watch the menu bar");
    expect(h.exitCode).toBeNull();
  });

  test("prod mode, app answers ok:true, --json — envelope asked:true", async () => {
    const h = harness({ mode: "prod", tray: async () => ({ ok: true }) });
    await runUpdate(["--json"], {}, h.deps);
    const body = JSON.parse(h.logs[0]!);
    expect(body.asked).toBe(true);
    expect(h.exitCode).toBeNull();
  });

  test("app not running (tray null) — points at the releases URL, exit 2", async () => {
    const h = harness({ mode: "prod", tray: async () => null });
    await runUpdate([], {}, h.deps);
    expect(h.calls).toEqual(["POST /update/check"]);
    expect(h.logs[0]).toContain(RELEASES_URL);
    expect(h.exitCode).toBe(2);
  });

  test("app not running, --json — envelope error code app-not-running", async () => {
    const h = harness({ mode: "prod", tray: async () => null });
    await runUpdate(["--json"], {}, h.deps);
    const body = JSON.parse(h.logs[0]!);
    expect(body.error.code).toBe("app-not-running");
    expect(h.exitCode).toBe(2);
  });

  test("app too old (ok:false) — points at the menu bar, exit 2", async () => {
    const h = harness({ mode: "prod", tray: async () => ({ ok: false, error: "unknown route" }) });
    await runUpdate([], {}, h.deps);
    expect(h.logs[0]).toContain("Check for Updates");
    expect(h.logs[0]).toContain("unknown route");
    expect(h.exitCode).toBe(2);
  });

  test("app too old, --json — envelope error code app-too-old", async () => {
    const h = harness({ mode: "prod", tray: async () => ({ ok: false, error: "unknown route" }) });
    await runUpdate(["--json"], {}, h.deps);
    const body = JSON.parse(h.logs[0]!);
    expect(body.error.code).toBe("app-too-old");
    expect(h.exitCode).toBe(2);
  });
});
