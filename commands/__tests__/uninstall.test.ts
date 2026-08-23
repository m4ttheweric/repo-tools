import { describe, test, expect } from "bun:test";
import { realUninstallDeps, runUninstallCommand, type UninstallDeps } from "../uninstall.ts";
import type { UninstallAction } from "../../lib/setup/uninstall.ts";
import type { ApplyEvent } from "../../lib/setup/contract.ts";
import type { SecretsSeams } from "../../lib/secrets/store.ts";
import type { RelayClient } from "../../lib/team/relay-client.ts";
import type { SecretPresence } from "../../lib/setup/validators/accounts.ts";
import { fakeProbes, fakeTray } from "../../lib/setup/__tests__/fakes.ts";

/** Answers `/version` reachable and every `/setup/need/<id>` as immediately done — the default tray behind every test below except the one that deliberately drives a real timeout. */
const instantTray = fakeTray({
  "GET /version": () => ({ status: 200, json: {} }),
  "GET /setup/need/services.unregister": () => ({ status: 200, json: { state: "done", detail: "unregistered" } }),
  "GET /setup/need/proxy.remove": () => ({ status: 200, json: { state: "done", detail: "removed" } }),
});

const fakeSecrets: SecretsSeams = {
  ageKeySeam: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
  execSeam: {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    fileExists: () => false,
    statFile: () => null,
    readFile: () => "",
    writeFile: () => {},
    ensureDir: () => {},
    chmod: () => {},
    fsyncAndRename: () => {},
    removeFile: () => {},
  },
};

const fakeRelay: RelayClient = {
  create: async () => ({ id: "", creatorSecret: "" }),
  fetch: async () => "gone",
  redeem: async () => "already",
  reply: async () => {},
  readReply: async () => "none",
  delete: async () => {},
};

function fakeSecretPresence(): SecretPresence {
  return { async has() { return null; } };
}

const SAMPLE_ACTIONS: UninstallAction[] = [
  { id: "services.unregister", title: "Stop and remove the rt daemon and deck services", kind: "app" },
];

function baseDeps(
  overrides: Partial<Omit<UninstallDeps, "probes">> & { probes?: ReturnType<typeof fakeProbes> } = {},
): Omit<UninstallDeps, "probes"> & { probes: ReturnType<typeof fakeProbes>; lines: string[]; exitCodes: number[]; confirmCalls: string[] } {
  const lines: string[] = [];
  const exitCodes: number[] = [];
  const confirmCalls: string[] = [];
  return {
    probes: fakeProbes({ tray: instantTray }),
    secrets: fakeSecrets,
    relay: fakeRelay,
    secretPresence: fakeSecretPresence(),
    actions: SAMPLE_ACTIONS,
    print: (s) => lines.push(s),
    exit: (code: number) => {
      exitCodes.push(code);
      throw new Error("exit sentinel");
    },
    isTTY: () => false,
    confirm: async (message) => {
      confirmCalls.push(message);
      return true;
    },
    lines,
    exitCodes,
    confirmCalls,
    ...overrides,
  };
}

async function runExpectingExit(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && err.message === "exit sentinel") return;
    throw err;
  }
}

describe("rt uninstall — dry-run", () => {
  test("--json --dry-run: prints the contract envelope {contract,at,actions:[{id,title}]}, nothing else, exit 0", async () => {
    const deps = baseDeps();
    await runUninstallCommand(["--json", "--dry-run"], {}, deps);

    expect(deps.lines).toHaveLength(1);
    const payload = JSON.parse(deps.lines[0]!) as { contract: number; actions: { id: string; title: string }[] };
    expect(payload.contract).toBe(1);
    expect(payload.actions).toEqual([{ id: "services.unregister", title: "Stop and remove the rt daemon and deck services" }]);
    expect(deps.exitCodes).toEqual([]);
  });

  test("--dry-run --delete-data with no --yes on a non-TTY: never confirm-required — dry-run is read-only", async () => {
    const deps = baseDeps({ isTTY: () => false });
    await runUninstallCommand(["--json", "--dry-run", "--delete-data"], {}, deps);
    expect(deps.exitCodes).toEqual([]);
  });

  test("human dry-run: one line per action title, no JSON", async () => {
    const deps = baseDeps();
    await runUninstallCommand(["--dry-run"], {}, deps);
    for (const line of deps.lines) expect(() => JSON.parse(line)).toThrow();
    expect(deps.lines.some((l) => l.includes("Stop and remove the rt daemon"))).toBe(true);
  });
});

describe("rt uninstall — the --delete-data consent gate", () => {
  test("non-TTY, --delete-data, no --yes: exit 2 confirm-required, nothing runs", async () => {
    const deps = baseDeps({ isTTY: () => false });
    await runExpectingExit(() => runUninstallCommand(["--json", "--delete-data"], {}, deps));

    expect(deps.exitCodes).toEqual([2]);
    const payload = JSON.parse(deps.lines[0]!) as { error: { code: string } };
    expect(payload.error.code).toBe("confirm-required");
  });

  test("non-TTY, --delete-data, --yes: proceeds — the app's own confirmation sheet already gave consent", async () => {
    const deps = baseDeps({ isTTY: () => false });
    await runUninstallCommand(["--json", "--delete-data", "--yes"], {}, deps);
    expect(deps.exitCodes).toEqual([]);
    const events = deps.lines.map((l) => JSON.parse(l) as ApplyEvent);
    expect(events.at(-1)).toMatchObject({ event: "done", ok: true });
  });

  test("non-TTY, --keep-data (default), no --yes: no gate at all", async () => {
    const deps = baseDeps({ isTTY: () => false });
    await runUninstallCommand(["--json"], {}, deps);
    expect(deps.exitCodes).toEqual([]);
  });

  test("TTY, no --yes: confirms before running; a decline runs nothing", async () => {
    const deps = baseDeps({ isTTY: () => true, confirm: async () => false });
    await runUninstallCommand([], {}, deps);
    expect(deps.lines.some((l) => l.includes("Stop and remove the rt daemon"))).toBe(true);
  });

  test("TTY, --yes: skips the confirm prompt entirely", async () => {
    const deps = baseDeps({ isTTY: () => true });
    await runUninstallCommand(["--yes"], {}, deps);
    expect(deps.confirmCalls).toEqual([]);
  });
});

describe("rt uninstall — NDJSON discipline and exit codes", () => {
  test("--json: stdout is plan/step/done for a happy action, exit 0", async () => {
    const deps = baseDeps({ isTTY: () => false });
    await runUninstallCommand(["--json", "--yes"], {}, deps);

    const events = deps.lines.map((l) => JSON.parse(l) as ApplyEvent);
    // services.unregister logs one line (deck not bundled in this fake), then asks the app over the need protocol, before its terminal step event.
    expect(events.map((e) => e.event)).toEqual(["plan", "step", "log", "need", "step", "done"]);
    expect(deps.exitCodes).toEqual([]);
  });

  test("a failed action -> exit 2, the stream already carries the failure", async () => {
    // Reachable (so `need` doesn't take the nonInteractive "no-app" skip
    // path) but never answers the specific need id — times out fast.
    const failingProbes = fakeProbes({
      files: { "/Library/LaunchDaemons/sh.portless.proxy.plist": "<plist/>" },
      tray: fakeTray({
        "GET /version": () => ({ status: 200, json: {} }),
        "GET /setup/need/proxy.remove": () => ({ status: 200, json: { state: "pending" } }),
      }),
    });
    const deps = baseDeps({
      probes: failingProbes,
      isTTY: () => false,
      actions: [{ id: "proxy.remove", title: "x", kind: "privileged" }],
      needOpts: { timeoutMs: 5, pollMs: 1 },
    });

    await runExpectingExit(() => runUninstallCommand(["--json"], {}, deps));
    expect(deps.exitCodes).toEqual([2]);
    const events = deps.lines.map((l) => JSON.parse(l) as ApplyEvent);
    expect(events.at(-1)).toMatchObject({ event: "done", ok: false });
  });

  test("realUninstallDeps() builds without throwing", () => {
    expect(() => realUninstallDeps()).not.toThrow();
  });
});
