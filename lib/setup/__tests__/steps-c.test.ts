import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { basename, dirname, join } from "path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { teamSettingsPath } from "../../rt-paths.ts";
import { updateRepoIndex } from "../../repo-index.ts";
import { setSetting } from "../../settings/write.ts";
import type { SecretsSeams } from "../../secrets/store.ts";
import type { RelayClient } from "../../team/relay-client.ts";
import type { ApplyContext, StepOutcome } from "../apply.ts";
import { BASE_PLUGINS } from "../base-plugins.ts";
import { MERGE_MANIFESTS_MISSING_CODE } from "../skills-materialize.ts";
import { stageSecret } from "../staging.ts";
import { readSetupState } from "../state.ts";
import type { TeamSnapshot } from "../team-settings.ts";
import type { ToolsInstallSeams } from "../tools-install.ts";
import type { ToolResolution } from "../../deps/resolve.ts";
import { fakeProbes, fakeTray, ok } from "./fakes.ts";
import type { Probes } from "../probes.ts";

import { MATTSTACK_MARKETPLACE_SOURCE, pluginsInstallStep } from "../steps/plugins.ts";
import { gitIdentityStep } from "../steps/git-identity.ts";
import { linearMcpStep } from "../steps/linear-mcp.ts";
import {
  extensionInstallRun,
  extensionInstallStep,
  fastbrowserSetupStep,
  herdrIntegrationStep,
  servicesStartRun,
  servicesStartStep,
  snapshotPushStep,
} from "../steps/tools.ts";
import { outcomeFromChecks, settleChecks, verifyStep } from "../steps/verify.ts";
import { teamSyncRow } from "../validators/rt-health.ts";

// ─── shared fakes (mirrors steps-a/b.test.ts's trivial no-ops) ─────────────

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

function makeCtx(p: Probes, overrides: Partial<ApplyContext> = {}): { ctx: ApplyContext; logs: { id: string; line: string }[] } {
  const logs: { id: string; line: string }[] = [];
  const ctx: ApplyContext = {
    p,
    emit: () => {},
    log(id, line) {
      logs.push({ id, line });
    },
    intent: null,
    team: { slug: "", name: "", mode: "none" },
    snapshot: null,
    reqs: [],
    nonInteractive: false,
    teamOfOne: false,
    appPath: null,
    ci: false,
    secrets: fakeSecrets,
    teamSecrets: () => fakeSecrets,
    relay: fakeRelay,
    secretPresence: { has: async () => null },
    redact: () => {},
    async need() {
      return "no-app";
    },
    ...overrides,
  };
  return { ctx, logs };
}

function detailOf(outcome: StepOutcome): string | undefined {
  return "detail" in outcome ? outcome.detail : undefined;
}

function remedyOf(outcome: StepOutcome): string | undefined {
  return "remedy" in outcome ? outcome.remedy : undefined;
}

describe("apply steps C: plugins, git.identity, fast-browser, herdr, extension, services.start, snapshot.push, verify", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-steps-c-home-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  // ─── plugins.install ────────────────────────────────────────────────────

  describe("plugins.install", () => {
    test("claude not resolvable, interactive -> failed with the Tools-row remedy, nothing execed", async () => {
      const p = fakeProbes({ home, env: {} });
      const { ctx } = makeCtx(p, { nonInteractive: false });
      const outcome = await pluginsInstallStep.run(ctx);
      expect(outcome).toEqual({
        state: "failed",
        detail: "claude not found (not bundled, no user copy on PATH)",
        remedy: "Install Claude Code (Tools row), then Retry.",
      });
      expect(p.calls.exec).toEqual([]);
    });

    test("claude not resolvable, nonInteractive -> skipped honestly (nobody can act on a Retry) — matches servicesStartRun's split", async () => {
      const p = fakeProbes({ home, env: {} });
      const { ctx } = makeCtx(p, { nonInteractive: true });
      const outcome = await pluginsInstallStep.run(ctx);
      expect(outcome).toEqual({ state: "skipped", detail: "claude not found (not bundled, no user copy on PATH)" });
      expect(p.calls.exec).toEqual([]);
    });

    test("a non-string claude.marketplaces/claude.plugins entry is dropped, logged, and never reaches argv", async () => {
      setSetting("claude.marketplaces", ["https://example.com/ok-market", { name: "bad" }], "user");
      setSetting("claude.plugins", [42, "ok-plugin@ok-market"], "user");

      const execCalls: string[][] = [];
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin" },
        exec: async (argv) => {
          execCalls.push(argv);
          return argv[2] === "list" ? ok("[]") : ok("");
        },
      });
      const { ctx, logs } = makeCtx(p);

      const outcome = await pluginsInstallStep.run(ctx);
      expect(outcome.state).toBe("done");
      expect(execCalls.some((a) => a.includes("[object Object]"))).toBe(false);
      expect(execCalls.some((a) => a.at(-1) === "https://example.com/ok-market")).toBe(true);
      expect(execCalls.some((a) => a.at(-1) === "ok-plugin@ok-market")).toBe(true);
      expect(logs.some((l) => l.line.includes("claude.marketplaces") && l.line.includes("dropped 1"))).toBe(true);
      expect(logs.some((l) => l.line.includes("claude.plugins") && l.line.includes("dropped 1"))).toBe(true);
    });

    test("happy path: one custom marketplace + team marketplace/plugin, one config dir — full argv sequence, setup-state recorded", async () => {
      const teamDir = join(home, ".mattstack", "teams", "acme");
      const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
      setSetting("claude.marketplaces", ["https://example.com/extra-market"], "user");

      const execCalls: { argv: string[]; env?: Record<string, string> }[] = [];
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
        exec: async (argv, opts) => {
          execCalls.push({ argv, env: opts?.env });
          return argv[2] === "list" ? ok("[]") : ok("");
        },
      });
      const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

      const outcome = await pluginsInstallStep.run(ctx);

      expect(outcome.state).toBe("done");
      expect(detailOf(outcome)).toContain("3 marketplace(s), 4 plugin(s) across 1 config dir(s)");
      expect(detailOf(outcome)).toContain(MERGE_MANIFESTS_MISSING_CODE); // no mattstack plugin on disk yet in this fake — materialize honestly skips
      // acme-skills is team-authored (came from the team's own marketplace.json) — installed, never auto-enabled.
      expect(detailOf(outcome)).toContain("awaiting your approval to enable: acme-skills@acme-market");

      const marketAdds = execCalls.filter((c) => c.argv.includes("marketplace") && c.argv.includes("add"));
      const installs = execCalls.filter((c) => c.argv[1] === "plugin" && c.argv[2] === "install");
      expect(marketAdds).toHaveLength(3);
      expect(installs).toHaveLength(4);
      expect(execCalls.every((c) => c.argv[0] === "/usr/local/bin/claude")).toBe(true);
      expect(execCalls.every((c) => c.env?.CLAUDE_CONFIG_DIR === join(home, ".claude"))).toBe(true);

      // rt's own marketplace is added FIRST — a hostile marketplace could
      // otherwise squat the "mattstack" name before rt's own add runs.
      const marketSrcs = marketAdds.map((c) => c.argv.at(-1) ?? "");
      expect(marketSrcs[0]).toBe(MATTSTACK_MARKETPLACE_SOURCE);
      expect(marketSrcs).toEqual(expect.arrayContaining(["https://example.com/extra-market", MATTSTACK_MARKETPLACE_SOURCE, teamDir]));

      const pluginNames = installs.map((c) => c.argv.at(-1) ?? "");
      expect(pluginNames).toEqual(expect.arrayContaining(["mattstack@mattstack", "fast-browser@mattstack", "chat@mattstack", "acme-skills@acme-market"]));

      const state = readSetupState(p);
      expect([...state.marketplaces].sort()).toEqual([...marketSrcs].sort());
      expect([...state.plugins].sort()).toEqual([...pluginNames].sort());
    });

    test("runs materializeSkills AFTER a successful install, honest tally when the script exists", async () => {
      const repoDir = mkdtempSync(join(home, "repo-"));
      updateRepoIndex(basename(repoDir), repoDir);

      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin", RT_MERGE_MANIFESTS: "/fake/merge-manifests.sh" },
        files: { "/usr/local/bin/claude": "bin" },
        exec: async (argv) => (argv[2] === "list" ? ok("[]") : ok("materialized")),
      });
      const { ctx } = makeCtx(p);

      const outcome = await pluginsInstallStep.run(ctx);
      expect(outcome.state).toBe("done");
      expect(detailOf(outcome)).toContain("materialized 1, failed 0");
    });

    test("marketplace add exits non-zero (not 'already') -> failed with the contract remedy, install never reached", async () => {
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin" },
        exec: async (argv) => (argv.includes("marketplace") && argv.includes("add") ? { code: 1, stdout: "", stderr: "boom" } : ok("")),
      });
      const { ctx } = makeCtx(p);

      const outcome = await pluginsInstallStep.run(ctx);
      expect(outcome).toEqual({
        state: "failed",
        detail: "claude plugin marketplace add exited 1",
        remedy: "Open Claude Code once so it finishes first-run, then Retry.",
      });
      expect(p.calls.exec.some((a) => a.includes("install"))).toBe(false);
    });

    test("plugin install exits non-zero (not 'already') -> failed, contract example detail text", async () => {
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin" },
        exec: async (argv) => {
          if (argv[2] === "list") return ok("[]");
          return argv[2] === "install" ? { code: 3, stdout: "", stderr: "network error" } : ok("");
        },
      });
      const { ctx } = makeCtx(p);

      const outcome = await pluginsInstallStep.run(ctx);
      expect(outcome).toEqual({
        state: "failed",
        detail: "claude plugin install exited 3",
        remedy: "Open Claude Code once so it finishes first-run, then Retry.",
      });
    });

    test("idempotent re-run: 'already' stderr on add/install tolerated, an unknown 'enable' subcommand ignored — still done", async () => {
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin" },
        exec: async (argv) => {
          if (argv[2] === "list") return ok("[]");
          if (argv.includes("marketplace") && argv.includes("add")) return { code: 1, stdout: "", stderr: "marketplace already added" };
          if (argv[2] === "install") return { code: 1, stdout: "", stderr: "plugin already installed" };
          if (argv[2] === "enable") return { code: 1, stdout: "", stderr: "error: unknown subcommand 'enable'" };
          return ok("");
        },
      });

      const first = await pluginsInstallStep.run(makeCtx(p).ctx);
      const second = await pluginsInstallStep.run(makeCtx(p).ctx);
      expect(first.state).toBe("done");
      expect(second.state).toBe("done");
    });

    test("a team-authored pack ends DISABLED, asserted on the resulting state rather than the argv", async () => {
      const teamDir = join(home, ".mattstack", "teams", "acme");
      const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
      // Models the real claude: install enables what it installs, disable turns it off.
      const enabled: Record<string, boolean> = {};
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
        exec: async (argv) => {
          const [, , verb, id] = argv;
          if (verb === "list") return ok(JSON.stringify(Object.keys(enabled).map((k) => ({ id: k, version: "1.0.0", enabled: enabled[k] }))));
          if (verb === "install") {
            enabled[id!] = true;
            return ok("");
          }
          if (verb === "disable") {
            enabled[id!] = false;
            return ok("");
          }
          if (verb === "enable") {
            enabled[id!] = true;
            return ok("");
          }
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

      const outcome = await pluginsInstallStep.run(ctx);

      expect(outcome.state).toBe("done");
      expect(enabled["acme-skills@acme-market"]).toBe(false);
      for (const base of BASE_PLUGINS) expect(enabled[base]).toBe(true);
    });

    test("apply does not re-enable a pack the member turned off, and does not disable one they turned on", async () => {
      // The spec Acceptance bullet: "A member who enables the pack, then runs
      // rt setup apply, still has it enabled afterwards." This is the only test that
      // enters the already-installed/update branch, so it also covers the restored
      // trusted enable.
      const teamDir = join(home, ".mattstack", "teams", "acme");
      const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
      const enabled: Record<string, boolean> = {
        "acme-skills@acme-market": true, // the member enabled the team pack deliberately
        "mattstack@mattstack": false, // a baseline plugin that drifted off
        "fast-browser@mattstack": true,
        "chat@mattstack": true,
      };
      const execCalls: string[][] = [];
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
        exec: async (argv) => {
          execCalls.push(argv);
          const [, , verb, id] = argv;
          if (verb === "list") return ok(JSON.stringify(Object.keys(enabled).map((k) => ({ id: k, version: "1.0.0", enabled: enabled[k] }))));
          if (verb === "update") return ok(""); // moves version, touches nothing else
          if (verb === "install") {
            enabled[id!] = true;
            return ok("");
          }
          if (verb === "enable") {
            enabled[id!] = true;
            return ok("");
          }
          if (verb === "disable") {
            enabled[id!] = false;
            return ok("");
          }
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

      const outcome = await pluginsInstallStep.run(ctx);

      expect(outcome.state).toBe("done");
      expect(enabled["acme-skills@acme-market"]).toBe(true); // deliberate enable survives apply
      expect(enabled["mattstack@mattstack"]).toBe(true); // trusted plugin got its enable back
      expect(execCalls.some((a) => a[2] === "install")).toBe(false);
    });

    test("a team pack the member left disabled is still disabled after apply", async () => {
      const teamDir = join(home, ".mattstack", "teams", "acme");
      const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
      const enabled: Record<string, boolean> = {
        "acme-skills@acme-market": false,
        "mattstack@mattstack": true,
        "fast-browser@mattstack": true,
        "chat@mattstack": true,
      };
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
        exec: async (argv) => {
          const [, , verb, id] = argv;
          if (verb === "list") return ok(JSON.stringify(Object.keys(enabled).map((k) => ({ id: k, version: "1.0.0", enabled: enabled[k] }))));
          if (verb === "install") {
            enabled[id!] = true;
            return ok("");
          }
          if (verb === "enable") {
            enabled[id!] = true;
            return ok("");
          }
          if (verb === "disable") {
            enabled[id!] = false;
            return ok("");
          }
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

      await pluginsInstallStep.run(ctx);

      expect(enabled["acme-skills@acme-market"]).toBe(false);
    });

    test("a listed team pack whose update claims absence never reaches install, so a deliberate enable survives", async () => {
      const teamDir = join(home, ".mattstack", "teams", "acme");
      const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
      const enabled: Record<string, boolean> = { "acme-skills@acme-market": true };
      for (const base of BASE_PLUGINS) enabled[base] = true;
      const execCalls: string[][] = [];
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
        exec: async (argv) => {
          execCalls.push(argv);
          const [, , verb, id] = argv;
          if (verb === "list") return ok(JSON.stringify(Object.keys(enabled).map((k) => ({ id: k, version: "1.0.0", enabled: enabled[k] }))));
          if (verb === "update") return id === "acme-skills@acme-market" ? { code: 1, stdout: "", stderr: 'Plugin "acme-skills" is not installed' } : ok("");
          if (verb === "install") {
            enabled[id!] = true;
            return ok("");
          }
          if (verb === "disable") {
            enabled[id!] = false;
            return ok("");
          }
          if (verb === "enable") {
            enabled[id!] = true;
            return ok("");
          }
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

      const outcome = await pluginsInstallStep.run(ctx);

      expect(outcome.state).toBe("failed");
      expect(execCalls.some((a) => a[2] === "install")).toBe(false);
      expect(enabled["acme-skills@acme-market"]).toBe(true);
    });

    test("a rolled-back pack is not recorded in setup-state as installed", async () => {
      const teamDir = join(home, ".mattstack", "teams", "acme");
      const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
        exec: async (argv) => {
          const [, , verb] = argv;
          if (verb === "list") return ok("[]");
          if (verb === "disable") return { code: 1, stdout: "", stderr: "boom" };
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

      await pluginsInstallStep.run(ctx);

      expect(readSetupState(p).plugins).not.toContain("acme-skills@acme-market");
    });

    test("a rolled-back pack is in neither the done detail's plugin count nor its pending note", async () => {
      const teamDir = join(home, ".mattstack", "teams", "acme");
      const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
        exec: async (argv) => {
          const [, , verb] = argv;
          if (verb === "list") return ok("[]");
          if (verb === "disable") return { code: 1, stdout: "", stderr: "boom" };
          return ok("");
        },
      });
      const { ctx, logs } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

      const outcome = await pluginsInstallStep.run(ctx);

      expect(outcome.state).toBe("done");
      expect(detailOf(outcome)).toContain(`${BASE_PLUGINS.length} plugin(s)`);
      expect(detailOf(outcome)).not.toContain("awaiting your approval");
      expect(detailOf(outcome)).not.toContain("acme-skills@acme-market");
      expect(logs.some((l) => l.line.includes("installed but NOT enabled"))).toBe(false);
    });

    test("a fresh trusted install is enabled by the step, since the install itself leaves it off", async () => {
      const teamDir = join(home, ".mattstack", "teams", "acme");
      const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
      // `install` deliberately does not touch `enabled`, so only an explicit
      // `enable` can flip one on.
      const enabled: Record<string, boolean> = {};
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
        exec: async (argv) => {
          const [, , verb, id] = argv;
          if (verb === "list") return ok("[]");
          if (verb === "enable") {
            enabled[id!] = true;
            return ok("");
          }
          if (verb === "disable") {
            enabled[id!] = false;
            return ok("");
          }
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

      const outcome = await pluginsInstallStep.run(ctx);

      expect(outcome.state).toBe("done");
      for (const base of BASE_PLUGINS) expect(enabled[base]).toBe(true);
      expect(enabled["acme-skills@acme-market"]).toBe(false);
    });

    test("a trusted plugin missing from the listing whose install reports already-installed still gets its enable", async () => {
      const teamDir = join(home, ".mattstack", "teams", "acme");
      const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
      // The `current` route: installed at another scope, so possibly disabled
      // there, and settlePack returns without ever enabling it.
      const enabled: Record<string, boolean> = {};
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
        exec: async (argv) => {
          const [, , verb, id] = argv;
          if (verb === "list") return ok("[]");
          if (verb === "install") return { code: 1, stdout: "", stderr: "plugin already installed" };
          if (verb === "enable") {
            enabled[id!] = true;
            return ok("");
          }
          if (verb === "disable") {
            enabled[id!] = false;
            return ok("");
          }
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

      const outcome = await pluginsInstallStep.run(ctx);

      expect(outcome.state).toBe("done");
      for (const base of BASE_PLUGINS) expect(enabled[base]).toBe(true);
      expect("acme-skills@acme-market" in enabled).toBe(false);
    });

    test("the settlement runs at the step's own 60s timeout, not the converge budget's 30s", async () => {
      const execCalls: { argv: string[]; timeoutMs?: number }[] = [];
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin" },
        exec: async (argv, opts) => {
          execCalls.push({ argv, timeoutMs: opts?.timeoutMs });
          return argv[2] === "list" ? ok("[]") : ok("");
        },
      });
      const { ctx } = makeCtx(p);

      expect((await pluginsInstallStep.run(ctx)).state).toBe("done");

      const installs = execCalls.filter((c) => c.argv[2] === "install");
      expect(installs.length).toBe(BASE_PLUGINS.length);
      expect(installs.every((c) => c.timeoutMs === 60_000)).toBe(true);
    });

    test("a claude without `plugin update` settles the installed plugin instead of failing the step", async () => {
      const installed = BASE_PLUGINS.map((id) => ({ id, version: "1.0.0", enabled: true }));
      const execCalls: string[][] = [];
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/claude": "bin" },
        exec: async (argv) => {
          execCalls.push(argv);
          if (argv[2] === "list") return ok(JSON.stringify(installed));
          if (argv[2] === "update") return { code: 1, stdout: "", stderr: "error: unknown subcommand 'update'" };
          if (argv[2] === "install") return { code: 1, stdout: "", stderr: "plugin already installed" };
          return ok("");
        },
      });
      const { ctx } = makeCtx(p);

      const outcome = await pluginsInstallStep.run(ctx);

      expect(outcome.state).toBe("done");
      expect(execCalls.some((a) => a[2] === "install")).toBe(true);
    });

    test.each([['Plugin "foo" not found'], ['Plugin "foo" is not installed']])(
      "an update failing with %j falls through to the settlement instead of failing the step",
      async (stderr) => {
        const installed = BASE_PLUGINS.map((id) => ({ id, version: "1.0.0", enabled: true }));
        const execCalls: string[][] = [];
        const p = fakeProbes({
          home,
          env: { PATH: "/usr/local/bin" },
          files: { "/usr/local/bin/claude": "bin" },
          exec: async (argv) => {
            execCalls.push(argv);
            if (argv[2] === "list") return ok(JSON.stringify(installed));
            if (argv[2] === "update") return { code: 1, stdout: "", stderr };
            if (argv[2] === "install") return { code: 1, stdout: "", stderr: "plugin already installed" };
            return ok("");
          },
        });
        const { ctx } = makeCtx(p);

        const outcome = await pluginsInstallStep.run(ctx);

        expect(outcome.state).toBe("done");
        expect(execCalls.some((a) => a[2] === "install")).toBe(true);
      },
    );
  });

  // ─── git.identity ───────────────────────────────────────────────────────

  describe("git.identity", () => {
    const GITHUB_FORGE: TeamSnapshot = {
      slug: "acme",
      integrations: { forge: { host: "github.com", provider: "github" } },
      trackingIdentities: [],
      marketplaces: [],
      plugins: [],
      remote: null,
    };
    const GITLAB_FORGE: TeamSnapshot = { ...GITHUB_FORGE, integrations: { forge: { host: "gitlab.com", provider: "gitlab" } } };

    const READ_NAME = ["git", "config", "--global", "user.name"];
    const READ_EMAIL = ["git", "config", "--global", "user.email"];
    const unset = { code: 1, stdout: "", stderr: "" };

    /** Every write is a 5-element `git config --global <key> <value>`; the reads are 4. */
    function writes(p: ReturnType<typeof fakeProbes>): string[][] {
      return p.calls.exec.filter((argv) => argv[0] === "git" && argv.length === 5);
    }

    test("both global keys already set: skipped, with no forge call and no write", async () => {
      const p = fakeProbes({
        home,
        exec: async (argv) => {
          if (argv[3] === "user.name") return ok("Ada Lovelace\n");
          if (argv[3] === "user.email") return ok("ada@example.com\n");
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { snapshot: GITHUB_FORGE });

      expect(await gitIdentityStep.run(ctx)).toEqual({ state: "skipped", detail: "already configured: Ada Lovelace <ada@example.com>" });
      expect(p.calls.exec).toEqual([READ_NAME, READ_EMAIL]);
    });

    test("neither set, GitHub with a private email: writes the account name and its noreply address", async () => {
      const p = fakeProbes({
        home,
        exec: async (argv) => {
          if (argv[0] === "git" && argv.length === 4) return unset;
          if (argv[0] === "gh") return ok(JSON.stringify({ login: "octocat", name: "Mona Octocat", id: 583231, email: null }));
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { snapshot: GITHUB_FORGE });

      expect(await gitIdentityStep.run(ctx)).toEqual({ state: "done", detail: "Mona Octocat <583231+octocat@users.noreply.github.com>" });
      expect(writes(p)).toEqual([
        ["git", "config", "--global", "user.name", "Mona Octocat"],
        ["git", "config", "--global", "user.email", "583231+octocat@users.noreply.github.com"],
      ]);
    });

    test("neither set, GitLab: writes the profile's commit email", async () => {
      const p = fakeProbes({
        home,
        exec: async (argv) => {
          if (argv[0] === "git" && argv.length === 4) return unset;
          if (argv[0] === "glab") return ok(JSON.stringify({ username: "zaphod", name: "Zaphod Beeblebrox", id: 42, commit_email: "zaphod@acme.example" }));
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { snapshot: GITLAB_FORGE });

      expect(await gitIdentityStep.run(ctx)).toEqual({ state: "done", detail: "Zaphod Beeblebrox <zaphod@acme.example>" });
      expect(writes(p)).toEqual([
        ["git", "config", "--global", "user.name", "Zaphod Beeblebrox"],
        ["git", "config", "--global", "user.email", "zaphod@acme.example"],
      ]);
    });

    test("a forge rt only knows from the team remote is still used", async () => {
      const p = fakeProbes({
        home,
        exec: async (argv) => {
          if (argv[0] === "git" && argv.length === 4) return unset;
          if (argv[0] === "glab") return ok(JSON.stringify({ username: "zaphod", name: "Zaphod", id: 42, commit_email: "zaphod@acme.example" }));
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { snapshot: { ...GITHUB_FORGE, integrations: {}, remote: "https://gitlab.com/acme/mattstack-team-acme.git" } });

      expect((await gitIdentityStep.run(ctx)).state).toBe("done");
      expect(p.calls.exec.some((argv) => argv[0] === "glab")).toBe(true);
    });

    test("name already set, email unset: only the email is written, and the detail names what git now resolves", async () => {
      const p = fakeProbes({
        home,
        exec: async (argv) => {
          if (argv[3] === "user.name" && argv.length === 4) return ok("Ada Lovelace\n");
          if (argv[0] === "git" && argv.length === 4) return unset;
          if (argv[0] === "gh") return ok(JSON.stringify({ login: "octocat", name: "Mona Octocat", id: 583231, email: null }));
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { snapshot: GITHUB_FORGE });

      expect(await gitIdentityStep.run(ctx)).toEqual({ state: "done", detail: "Ada Lovelace <583231+octocat@users.noreply.github.com>" });
      expect(writes(p)).toEqual([["git", "config", "--global", "user.email", "583231+octocat@users.noreply.github.com"]]);
    });

    test("the forge CLI fails: skipped naming the two commands a human can run, its stderr logged, nothing written", async () => {
      const p = fakeProbes({
        home,
        exec: async (argv) => {
          if (argv[0] === "git" && argv.length === 4) return unset;
          if (argv[0] === "gh") return { code: 1, stdout: "", stderr: "gh: not logged in to any GitHub hosts" };
          return ok("");
        },
      });
      const { ctx, logs } = makeCtx(p, { snapshot: GITHUB_FORGE });

      expect(await gitIdentityStep.run(ctx)).toEqual({
        state: "skipped",
        detail: "forge profile unavailable; run git config --global user.name / user.email",
      });
      expect(writes(p)).toEqual([]);
      expect(logs.some((l) => l.id === "git.identity" && l.line.includes("not logged in"))).toBe(true);
    });

    test("no forge connected and no team remote: skipped after the two reads, nothing else execed", async () => {
      const p = fakeProbes({ home, exec: async () => unset });
      const { ctx } = makeCtx(p, { snapshot: { ...GITHUB_FORGE, integrations: {}, remote: null } });

      expect(await gitIdentityStep.run(ctx)).toEqual({
        state: "skipped",
        detail: "no forge connected; run git config --global user.name / user.email",
      });
      expect(p.calls.exec).toEqual([READ_NAME, READ_EMAIL]);
    });

    // The exact case the step exists for: a fresh Mac with no team at all,
    // where the only thing that knows which forge the person uses is the
    // host they confirmed during `rt setup <id> connect`.
    test("no team at all, but a confirmed forge host: the identity is still written", async () => {
      setSetting("rt.integrations", { forgeHost: "gitlab.example.com" }, "user");
      const p = fakeProbes({
        home,
        exec: async (argv) => {
          if (argv[0] === "git" && argv.length === 4) return unset;
          if (argv[0] === "glab") return ok(JSON.stringify({ username: "trillian", name: "Trillian", id: 7, commit_email: "trillian@acme.example" }));
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { snapshot: null });

      expect(await gitIdentityStep.run(ctx)).toEqual({ state: "done", detail: "Trillian <trillian@acme.example>" });
      expect(writes(p)).toEqual([
        ["git", "config", "--global", "user.name", "Trillian"],
        ["git", "config", "--global", "user.email", "trillian@acme.example"],
      ]);
    });

    test("no team and nothing connected: still the no-forge skip, nothing else execed", async () => {
      const p = fakeProbes({ home, exec: async () => unset });
      const { ctx } = makeCtx(p, { snapshot: null });

      expect(await gitIdentityStep.run(ctx)).toEqual({
        state: "skipped",
        detail: "no forge connected; run git config --global user.name / user.email",
      });
      expect(p.calls.exec).toEqual([READ_NAME, READ_EMAIL]);
    });

    test("a confirmed host that is not a hostname is refused, never handed to a forge CLI", async () => {
      setSetting("rt.integrations", { forgeHost: "gitlab.example.com/../evil" }, "user");
      const p = fakeProbes({ home, exec: async () => unset });
      const { ctx } = makeCtx(p, { snapshot: null });

      expect((await gitIdentityStep.run(ctx)).state).toBe("skipped");
      expect(p.calls.exec).toEqual([READ_NAME, READ_EMAIL]);
    });

    test("an unwritable ~/.gitconfig is a real failure, carrying git's own stderr", async () => {
      const p = fakeProbes({
        home,
        exec: async (argv) => {
          if (argv[0] === "git" && argv.length === 5) return { code: 128, stdout: "", stderr: "error: could not lock config file /Users/tester/.gitconfig: Permission denied" };
          if (argv[0] === "git" && argv.length === 4) return unset;
          if (argv[0] === "gh") return ok(JSON.stringify({ login: "octocat", name: "Mona Octocat", id: 583231, email: null }));
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { snapshot: GITHUB_FORGE });

      const outcome = await gitIdentityStep.run(ctx);
      expect(outcome.state).toBe("failed");
      expect(detailOf(outcome)).toContain("could not lock config file");
    });

    test("the forge token rt holds reaches the CLI's env, is registered for redaction, and never touches argv", async () => {
      const seen: (Record<string, string> | undefined)[] = [];
      const p = fakeProbes({
        home,
        exec: async (argv, opts) => {
          if (argv[0] === "git" && argv.length === 4) return unset;
          seen.push(opts?.env);
          return ok(JSON.stringify({ login: "octocat", name: "Mona Octocat", id: 583231, email: null }));
        },
      });
      stageSecret(p, "rt", "githubToken", "ghp_staged");
      const redacted: string[] = [];
      const { ctx } = makeCtx(p, { snapshot: GITHUB_FORGE, redact: (value) => redacted.push(value) });

      expect((await gitIdentityStep.run(ctx)).state).toBe("done");
      expect(seen).toEqual([{ GH_TOKEN: "ghp_staged" }]);
      expect(redacted).toContain("ghp_staged");
      expect(p.calls.exec.flat().join(" ")).not.toContain("ghp_staged");
    });
  });

  // ─── fastbrowser.setup ──────────────────────────────────────────────────

  describe("fastbrowser.setup", () => {
    test("resolvable + setup succeeds -> done", async () => {
      const p = fakeProbes({ home, env: { PATH: "/usr/local/bin" }, files: { "/usr/local/bin/fast-browser": "bin" }, exec: async () => ok("") });
      const { ctx } = makeCtx(p);
      expect(await fastbrowserSetupStep.run(ctx)).toEqual({ state: "done", detail: "fast-browser setup complete" });
      expect(p.calls.exec).toEqual([["/usr/local/bin/fast-browser", "setup", "--host", "claude", "--source", "https://github.com/m4ttstack/mattstack-marketplace.git"]]);
    });

    test("idempotent re-run: two independent setups each make their own real call — nothing memoized between runs", async () => {
      const p = fakeProbes({ home, env: { PATH: "/usr/local/bin" }, files: { "/usr/local/bin/fast-browser": "bin" }, exec: async () => ok("") });
      expect(await fastbrowserSetupStep.run(makeCtx(p).ctx)).toEqual({ state: "done", detail: "fast-browser setup complete" });
      expect(p.calls.exec).toEqual([["/usr/local/bin/fast-browser", "setup", "--host", "claude", "--source", "https://github.com/m4ttstack/mattstack-marketplace.git"]]);
      expect(await fastbrowserSetupStep.run(makeCtx(p).ctx)).toEqual({ state: "done", detail: "fast-browser setup complete" });
      const call = ["/usr/local/bin/fast-browser", "setup", "--host", "claude", "--source", "https://github.com/m4ttstack/mattstack-marketplace.git"];
      expect(p.calls.exec).toEqual([call, call]);
    });

    test("not bundled, no user copy -> skipped honestly, never execs", async () => {
      const p = fakeProbes({ home, env: {} });
      const { ctx } = makeCtx(p);
      expect(await fastbrowserSetupStep.run(ctx)).toEqual({ state: "skipped", detail: "fast-browser not bundled" });
      expect(p.calls.exec).toEqual([]);
    });

    // The clean-room dead-ended here: a bare runner has neither Claude Code
    // nor Codex, fast-browser correctly refused to guess, and the whole run
    // stopped at step 15 of 20 — so services.start, snapshot.push and verify
    // never ran. Mirrors plugins.install's claude branch.
    const NO_HOST = "fast-browser: Detected hosts: none. Non-interactive setup requires an explicit host.";

    test("no host + non-interactive -> skipped, so the rest of the run still executes", async () => {
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/fast-browser": "bin" },
        exec: async () => ({ code: 2, stdout: "", stderr: NO_HOST }),
      });
      const { ctx } = makeCtx(p, { nonInteractive: true });
      const outcome = await fastbrowserSetupStep.run(ctx);
      expect(outcome.state).toBe("skipped");
      expect(detailOf(outcome)).toContain("no Claude Code or Codex host detected");
    });

    // A human IS watching, so the failure stays loud — same split plugins.install makes.
    test("no host + interactive -> still fails", async () => {
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/fast-browser": "bin" },
        exec: async () => ({ code: 2, stdout: "", stderr: NO_HOST }),
      });
      const { ctx } = makeCtx(p, { nonInteractive: false });
      expect((await fastbrowserSetupStep.run(ctx)).state).toBe("failed");
    });

    // Only the no-host case is forgiven: a real fast-browser fault must not be
    // swallowed just because nobody is watching.
    test("a different failure is still failed even non-interactively", async () => {
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/fast-browser": "bin" },
        exec: async () => ({ code: 1, stdout: "", stderr: "segfault" }),
      });
      const { ctx } = makeCtx(p, { nonInteractive: true });
      expect((await fastbrowserSetupStep.run(ctx)).state).toBe("failed");
    });

    test("setup exits non-zero -> failed with the terminal-guidance remedy", async () => {
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/fast-browser": "bin" },
        exec: async () => ({ code: 1, stdout: "", stderr: "boom" }),
      });
      const { ctx } = makeCtx(p);
      const outcome = await fastbrowserSetupStep.run(ctx);
      expect(outcome.state).toBe("failed");
      expect(remedyOf(outcome)).toBe("Run `fast-browser setup` in a terminal for details");
    });
  });

  // ─── herdr.integration ──────────────────────────────────────────────────

  describe("herdr.integration", () => {
    test("herdr on PATH -> done", async () => {
      const p = fakeProbes({ home, env: { PATH: "/usr/local/bin" }, files: { "/usr/local/bin/herdr": "bin" }, exec: async () => ok("") });
      const { ctx } = makeCtx(p);
      const outcome = await herdrIntegrationStep.run(ctx);
      expect(outcome).toEqual({ state: "done", detail: `${join(home, ".claude")}: ok` });
      expect(p.calls.exec).toEqual([["herdr", "integration", "install", "claude"]]);
    });

    test("idempotent re-run: two independent installs each make their own real call — nothing memoized between runs", async () => {
      const p = fakeProbes({ home, env: { PATH: "/usr/local/bin" }, files: { "/usr/local/bin/herdr": "bin" }, exec: async () => ok("") });
      expect((await herdrIntegrationStep.run(makeCtx(p).ctx)).state).toBe("done");
      expect(p.calls.exec).toEqual([["herdr", "integration", "install", "claude"]]);
      expect((await herdrIntegrationStep.run(makeCtx(p).ctx)).state).toBe("done");
      expect(p.calls.exec).toEqual([
        ["herdr", "integration", "install", "claude"],
        ["herdr", "integration", "install", "claude"],
      ]);
    });

    test("herdr not installed -> skipped, points at the Tools row", async () => {
      const p = fakeProbes({ home, env: {} });
      const { ctx } = makeCtx(p);
      expect(await herdrIntegrationStep.run(ctx)).toEqual({ state: "skipped", detail: "herdr not installed (Tools row)" });
      expect(p.calls.exec).toEqual([]);
    });

    test("integration install exits non-zero -> failed", async () => {
      const p = fakeProbes({
        home,
        env: { PATH: "/usr/local/bin" },
        files: { "/usr/local/bin/herdr": "bin" },
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      });
      const { ctx } = makeCtx(p);
      const outcome = await herdrIntegrationStep.run(ctx);
      expect(outcome.state).toBe("failed");
      expect(detailOf(outcome)).toContain("exit 1");
    });
  });

  // ─── extension.install ───────────────────────────────────────────────────

  function noopResolution(tool: string): ToolResolution {
    return { tool, bundled: null, exec: null, userCopy: null, linked: false, chosen: null };
  }

  const NOOP_SEAMS: ToolsInstallSeams = {
    resolveTool: (_p, tool) => noopResolution(tool),
    detectEditors: () => [],
    findVsix: () => null,
    bundledToolExec: () => null,
    link: () => {
      throw new Error("link() should not be called in this test");
    },
  };

  describe("extension.install", () => {
    test("vsix + a compatible editor, install succeeds -> done", async () => {
      const p = fakeProbes({ home, exec: async () => ok("") });
      const seams: ToolsInstallSeams = { ...NOOP_SEAMS, findVsix: () => "/fake/rt-context.vsix", detectEditors: () => [{ name: "Cursor", cliPath: "/x/cursor", appPath: "/x" }] };
      const { ctx } = makeCtx(p);
      const outcome = await extensionInstallRun(ctx, seams);
      expect(outcome.state).toBe("done");
      expect(detailOf(outcome)).toContain("Cursor");
    });

    test("idempotent re-run: two independent installs each make their own real call — nothing memoized between runs", async () => {
      const p = fakeProbes({ home, exec: async () => ok("") });
      const seams: ToolsInstallSeams = { ...NOOP_SEAMS, findVsix: () => "/fake/rt-context.vsix", detectEditors: () => [{ name: "Cursor", cliPath: "/x/cursor", appPath: "/x" }] };
      const expectedCall = ["/x/cursor", "--install-extension", "/fake/rt-context.vsix", "--force"];
      expect((await extensionInstallRun(makeCtx(p).ctx, seams)).state).toBe("done");
      expect(p.calls.exec).toEqual([expectedCall]);
      expect((await extensionInstallRun(makeCtx(p).ctx, seams)).state).toBe("done");
      expect(p.calls.exec).toEqual([expectedCall, expectedCall]);
    });

    test("vsix missing -> skipped 'extension not bundled'", async () => {
      const p = fakeProbes({ home });
      const seams: ToolsInstallSeams = { ...NOOP_SEAMS, findVsix: () => null, detectEditors: () => [{ name: "Cursor", cliPath: "/x/cursor", appPath: "/x" }] };
      const outcome = await extensionInstallRun(makeCtx(p).ctx, seams);
      expect(outcome).toEqual({ state: "skipped", detail: "extension not bundled" });
    });

    test("no compatible editor -> skipped 'no editor found'", async () => {
      const p = fakeProbes({ home });
      const seams: ToolsInstallSeams = { ...NOOP_SEAMS, findVsix: () => "/fake/rt-context.vsix", detectEditors: () => [] };
      const outcome = await extensionInstallRun(makeCtx(p).ctx, seams);
      expect(outcome).toEqual({ state: "skipped", detail: "no editor found" });
    });

    test("editor found, install fails -> failed", async () => {
      const p = fakeProbes({ home, exec: async () => ({ code: 1, stdout: "", stderr: "" }) });
      const seams: ToolsInstallSeams = { ...NOOP_SEAMS, findVsix: () => "/fake/rt-context.vsix", detectEditors: () => [{ name: "Cursor", cliPath: "/x/cursor", appPath: "/x" }] };
      const outcome = await extensionInstallRun(makeCtx(p).ctx, seams);
      expect(outcome.state).toBe("failed");
      expect(remedyOf(outcome)).toBe("Install the extension manually, then Retry");
    });
  });

  // ─── services.start ──────────────────────────────────────────────────────

  describe("services.start", () => {
    test("tray 200, daemon answers immediately -> done", async () => {
      const p = fakeProbes({
        home,
        tray: fakeTray({ "POST /daemon/start": () => ({ status: 200, json: {} }) }),
        daemon: async () => ({ ok: true }),
      });
      const { ctx } = makeCtx(p);
      expect(await servicesStartStep.run(ctx)).toEqual({ state: "done", detail: "daemon running" });
    });

    test("idempotent re-run: two independent starts each hit the tray and poll the daemon again — nothing memoized between runs", async () => {
      let pings = 0;
      const p = fakeProbes({
        home,
        tray: fakeTray({ "POST /daemon/start": () => ({ status: 200, json: {} }) }),
        daemon: async () => {
          pings++;
          return { ok: true };
        },
      });
      expect(await servicesStartStep.run(makeCtx(p).ctx)).toEqual({ state: "done", detail: "daemon running" });
      expect(p.calls.tray).toEqual(["/daemon/start"]);
      expect(pings).toBe(1);
      expect(await servicesStartStep.run(makeCtx(p).ctx)).toEqual({ state: "done", detail: "daemon running" });
      expect(p.calls.tray).toEqual(["/daemon/start", "/daemon/start"]);
      expect(pings).toBe(2);
    });

    test("tray unreachable + nonInteractive -> skipped", async () => {
      const p = fakeProbes({ home }); // default tray: status 0
      const { ctx } = makeCtx(p, { nonInteractive: true });
      expect(await servicesStartStep.run(ctx)).toEqual({ state: "skipped", detail: "mattstack.app not running" });
    });

    test("tray unreachable + interactive -> failed with remedy", async () => {
      const p = fakeProbes({ home });
      const { ctx } = makeCtx(p, { nonInteractive: false });
      expect(await servicesStartStep.run(ctx)).toEqual({ state: "failed", detail: "mattstack.app not running", remedy: "Open mattstack.app" });
    });

    test("tray 500 (app running, refused the start) -> always failed, even nonInteractive — never buried as 'not running'", async () => {
      const p = fakeProbes({ home, tray: fakeTray({ "POST /daemon/start": () => ({ status: 500, json: null }) }) });
      const { ctx } = makeCtx(p, { nonInteractive: true });
      const outcome = await servicesStartStep.run(ctx);
      expect(outcome).toEqual({ state: "failed", detail: "mattstack.app returned status 500 starting the daemon", remedy: "Open mattstack.app" });
    });

    test("tray 404 (stale/unrecognized route) -> failed naming the status, not 'not running'", async () => {
      const p = fakeProbes({ home, tray: fakeTray({ "POST /daemon/start": () => ({ status: 404, json: null }) }) });
      const { ctx } = makeCtx(p);
      const outcome = await servicesStartStep.run(ctx);
      expect(outcome).toEqual({ state: "failed", detail: "mattstack.app returned status 404 starting the daemon", remedy: "Open mattstack.app" });
    });

    test("tray 200 but the daemon never comes up -> failed after exhausting the poll (fast sleep)", async () => {
      let pings = 0;
      const p = fakeProbes({
        home,
        tray: fakeTray({ "POST /daemon/start": () => ({ status: 200, json: {} }) }),
        daemon: async () => {
          pings += 1;
          return { ok: false };
        },
      });
      const { ctx } = makeCtx(p);
      const outcome = await servicesStartRun(ctx, async () => {});
      expect(outcome).toEqual({ state: "failed", detail: "daemon did not come up", remedy: "Approve the background item in Login Items, then Retry" });
      expect(pings).toBe(12);
    });
  });

  // ─── snapshot.push ────────────────────────────────────────────────────────

  describe("snapshot.push", () => {
    test("daemon reachable, commits, no remote -> done, honest that nothing was pushed", async () => {
      const p = fakeProbes({ home, daemon: async () => ({ ok: true, data: { committed: true, sha: "abcdef1234567890", paths: ["a"], reason: "manual" } }) });
      const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
      expect(outcome).toEqual({ state: "done", detail: "committed abcdef12 locally — no remote, nothing pushed" });
    });

    test("daemon reachable, commits, remote attached -> done, defers the push claim to the daemon's next cycle (never asserts a push happened)", async () => {
      const p = fakeProbes({
        home,
        daemon: async () => ({ ok: true, data: { committed: true, sha: "abcdef1234567890", paths: ["a"], reason: "manual" } }),
        exec: async (argv) => (argv[0] === "git" && argv[1] === "remote" ? ok("origin\n") : ok("")),
      });
      const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
      expect(outcome).toEqual({ state: "done", detail: "committed abcdef12 — push follows on the daemon's next cycle" });
    });

    test("idempotent re-run: two independent triggers each call the daemon again — nothing memoized between runs", async () => {
      let daemonCalls = 0;
      const p = fakeProbes({
        home,
        daemon: async () => {
          daemonCalls++;
          return { ok: true, data: { committed: true, sha: "abcdef1234567890", paths: [], reason: "manual" } };
        },
      });
      expect((await snapshotPushStep.run(makeCtx(p).ctx)).state).toBe("done");
      expect(daemonCalls).toBe(1);
      expect((await snapshotPushStep.run(makeCtx(p).ctx)).state).toBe("done");
      expect(daemonCalls).toBe(2);
    });

    test("daemon reachable, snapshot disabled -> skipped honestly", async () => {
      const p = fakeProbes({ home, daemon: async () => ({ ok: true, data: { committed: false, sha: null, paths: [], reason: "manual", skipped: "disabled" } }) });
      const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
      expect(outcome).toEqual({ state: "skipped", detail: "snapshot skipped: disabled" });
    });

    test("daemon reachable, nothing to commit -> done", async () => {
      const p = fakeProbes({ home, daemon: async () => ({ ok: true, data: { committed: false, sha: null, paths: [], reason: "manual" } }) });
      const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
      expect(outcome).toEqual({ state: "done", detail: "no changes to snapshot" });
    });

    test("daemon reports failure -> failed with the git-status remedy", async () => {
      const p = fakeProbes({ home, daemon: async () => ({ ok: false, error: "commit failed" }) });
      const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
      expect(outcome).toEqual({ state: "failed", detail: "commit failed", remedy: "check `git -C ~/.mattstack/user status`" });
    });

    test("daemon-reported failure text is run through stripUserinfo — a credential-bearing origin URL never reaches detail", async () => {
      const p = fakeProbes({
        home,
        daemon: async () => ({ ok: false, error: "fatal: unable to access 'https://x-token-auth:secret123@host/repo.git/'" }),
      });
      const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
      expect(detailOf(outcome)).not.toContain("secret123");
    });

    test("daemon unreachable -> skipped honestly deferring to the daemon, NEVER runs git directly (no local zone/owners reimplementation)", async () => {
      const execCalls: string[][] = [];
      const p = fakeProbes({
        home,
        dirs: { [join(home, ".mattstack", "user", ".git")]: [] }, // even with a real repo present, no git fallback runs
        daemon: async () => null,
        exec: async (argv) => {
          execCalls.push(argv);
          return ok("");
        },
      });
      const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
      expect(outcome).toEqual({ state: "skipped", detail: "snapshot deferred to the daemon's next cycle (daemon unreachable)" });
      expect(execCalls).toEqual([]);
    });
  });

  // ─── verify ───────────────────────────────────────────────────────────────

  describe("verify", () => {
    describe("outcomeFromChecks (pure)", () => {
      test("all pass -> done with a count", () => {
        const checks = [
          { name: "a", status: "pass" as const, detail: "", severity: "critical" as const },
          { name: "b", status: "pass" as const, detail: "", severity: "critical" as const },
        ];
        expect(outcomeFromChecks(checks)).toEqual({ state: "done", detail: "2 checks passed" });
      });

      test("one critical failure -> failed, names the id, points at rt verify", () => {
        const checks = [
          { name: "a", status: "pass" as const, detail: "", severity: "critical" as const },
          { name: "tool.app", status: "fail" as const, detail: "", severity: "critical" as const },
        ];
        expect(outcomeFromChecks(checks)).toEqual({
          state: "failed",
          detail: "1 check failed: tool.app",
          remedy: "Run `rt verify` for details",
        });
      });

      test("a warning-severity fail never counts against canInstall's check", () => {
        const checks = [{ name: "tool.shell", status: "fail" as const, detail: "", severity: "warning" as const }];
        expect(outcomeFromChecks(checks)).toEqual({ state: "done", detail: "0 checks passed" });
      });

      // verify runs seconds after services.start kickstarts the daemon; its
      // launchctl/worktrees sub-probes can still be inconclusive then, which
      // the row rightly reports as a failure — so verify re-reads while the
      // daemon is the only thing failing, and never for anything else.
      test("settleChecks re-reads while tool.daemon is the only critical failure, then returns the settled checks", async () => {
        const daemonDown = [{ name: "tool.daemon", status: "fail" as const, detail: "worktrees endpoint check failed (daemon unreachable)", severity: "critical" as const }];
        const daemonUp = [{ name: "tool.daemon", status: "pass" as const, detail: "pid 1", severity: "critical" as const }];
        const reads = [daemonDown, daemonDown, daemonUp];
        const slept: number[] = [];
        const checks = await settleChecks(async () => reads.shift()!, { attempts: 5, intervalMs: 3000, sleep: async (ms) => { slept.push(ms); } });
        expect(checks).toEqual(daemonUp);
        expect(slept).toEqual([3000, 3000]);
      });

      /** The row's own words, never a hand-copied string: what verify settles on is a contract with `teamSyncRow`, and a fixture would let the two drift apart silently. */
      async function teamSyncWarn(slugs: string[], entries: Record<string, unknown>[]) {
        const r = await teamSyncRow(slugs, async () => entries as never, () => 1_000_000, 300);
        return { name: "team.sync", status: "warn" as const, detail: r!.detail, severity: "warning" as const };
      }

      const clone = (over: Record<string, unknown>) => ({ slug: "acme", lastPullAt: 900_000, pushPending: false, lastPushError: null, lastPullError: null, conflicted: null, ...over });

      // A joiner's clone starts its first pull the moment the engine boots,
      // so a row saying nothing has pulled yet right after join means "the
      // engine hasn't started yet", not a real failure, and verify waits it
      // out the same as tool.daemon.
      test("settleChecks re-reads while team.sync says no clone has pulled yet, then returns the settled checks", async () => {
        const neverPulled = [await teamSyncWarn(["acme"], [clone({ lastPullAt: 0 })])];
        const pulled = [{ name: "team.sync", status: "pass" as const, detail: "1 clone in sync", severity: "warning" as const }];
        const reads = [neverPulled, neverPulled, pulled];
        const slept: number[] = [];
        const checks = await settleChecks(async () => reads.shift()!, { attempts: 5, intervalMs: 3000, sleep: async (ms) => { slept.push(ms); } });
        expect(checks).toEqual(pulled);
        expect(slept).toEqual([3000, 3000]);
      });

      // The detail is assembled from team slugs and raw git stderr, so a
      // free-text match hands either of them the power to make verify sleep
      // its whole budget.
      test("settleChecks never waits on a slug or a git error that happens to contain the settling word", async () => {
        const cases = [
          await teamSyncWarn(["never-team"], [clone({ slug: "never-team", lastPullAt: 1 })]),
          await teamSyncWarn(["acme"], [clone({ lastPullError: "fatal: could not read Username: never" })]),
        ];
        for (const check of cases) {
          expect(check.detail).toContain("never");
          let slept = 0;
          const out = await settleChecks(async () => [check], { attempts: 5, intervalMs: 3000, sleep: async () => { slept++; } });
          expect(out).toEqual([check]);
          expect(slept).toBe(0);
        }
      });

      test("a critical failure verify cannot settle is judged on the first read, even while team.sync waits for its first pull", async () => {
        const checks = [
          { name: "tool.app", status: "fail" as const, detail: "mattstack.app not found", severity: "critical" as const },
          await teamSyncWarn(["acme"], [clone({ lastPullAt: 0 })]),
        ];
        let reads = 0;
        let slept = 0;
        const out = await settleChecks(async () => { reads++; return checks; }, { attempts: 5, intervalMs: 3000, sleep: async () => { slept++; } });
        expect(out).toEqual(checks);
        expect(reads).toBe(1);
        expect(slept).toBe(0);
      });

      test("settleChecks gives up after its attempts, and never waits when something other than the daemon fails", async () => {
        const daemonDown = [{ name: "tool.daemon", status: "fail" as const, detail: "", severity: "critical" as const }];
        let reads = 0;
        const stuck = await settleChecks(async () => { reads++; return daemonDown; }, { attempts: 3, intervalMs: 1, sleep: async () => {} });
        expect(stuck).toEqual(daemonDown);
        expect(reads).toBe(3);
        const other = [{ name: "tool.rt", status: "fail" as const, detail: "", severity: "critical" as const }, ...daemonDown];
        let slept = 0;
        const out = await settleChecks(async () => other, { attempts: 3, intervalMs: 1, sleep: async () => { slept++; } });
        expect(out).toEqual(other);
        expect(slept).toBe(0);
      });

      test("idempotent: same input twice -> identical output", () => {
        const checks = [{ name: "tool.app", status: "fail" as const, detail: "", severity: "critical" as const }];
        expect(outcomeFromChecks(checks)).toEqual(outcomeFromChecks(checks));
      });
    });

    describe("verifyStep — integration over the real composePlan", () => {
      test("a bare fresh machine has at least one required-missing row (tool.app) -> failed", async () => {
        const p = fakeProbes({ home });
        const { ctx } = makeCtx(p, { ci: true });
        const outcome = await verifyStep.run(ctx);
        expect(outcome.state).toBe("failed");
        expect(detailOf(outcome)).toContain("tool.app");
        expect(remedyOf(outcome)).toBe("Run `rt verify` for details");
      });

      test("idempotent re-run: the same bare machine reports the same failure twice", async () => {
        const p = fakeProbes({ home });
        const first = await verifyStep.run(makeCtx(p, { ci: true }).ctx);
        const second = await verifyStep.run(makeCtx(p, { ci: true }).ctx);
        expect(first).toEqual(second);
      });

      test("reads secret presence through ctx.secretPresence, never builds its own real seam", async () => {
        // composePlan re-derives its own TeamSnapshot straight off disk (it
        // never reads ctx.snapshot) — a declared forge is what makes
        // accountRows actually call secrets.has(), so the team store needs a
        // real (if minimal) settings.team.jsonc plus the integration setting,
        // the same seeding pattern lib/daemon/__tests__/repo-tracking.test.ts
        // uses for a `scope: "team"` write.
        const teamPath = teamSettingsPath("acme");
        mkdirSync(dirname(teamPath), { recursive: true });
        writeFileSync(teamPath, "// team store\n{}\n");
        setSetting("mattstack.integrations", { forge: { host: "github.com", provider: "github" } }, "team", { team: "acme" });

        let calls = 0;
        const p = fakeProbes({ home });
        const { ctx } = makeCtx(p, {
          ci: true,
          team: { slug: "acme", name: "Acme", mode: "none" },
          secretPresence: {
            has: async () => {
              calls += 1;
              return null;
            },
          },
        });

        await verifyStep.run(ctx);
        expect(calls).toBeGreaterThan(0);
      });
    });
  });

  describe("linear.mcp", () => {
    const KEY = "lin_api_testkey";
    const hosted = { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${KEY}` } };
    const withKey = { has: async () => KEY };
    const noKey = { has: async () => null };

    test("no stored key -> skipped, nothing written", async () => {
      const p = fakeProbes({ home, env: {} });
      const { ctx } = makeCtx(p, { secretPresence: noKey });
      expect(await linearMcpStep.run(ctx)).toEqual({ state: "skipped", detail: "no Linear key stored (connect Linear, then Retry)" });
      expect(p.calls.writes).toEqual({});
    });

    test("key stored, no config file -> writes the entry into the fake HOME only", async () => {
      const p = fakeProbes({ home, env: {} });
      const { ctx } = makeCtx(p, { secretPresence: withKey });
      const outcome = await linearMcpStep.run(ctx);
      expect(outcome.state).toBe("done");
      const written = JSON.parse(p.readFile(`${home}/.claude.json`)!);
      expect(written.mcpServers.linear).toEqual(hosted);
      for (const path of Object.keys(p.calls.writes)) expect(path.startsWith(home)).toBe(true);
    });

    test("an existing differently-named Linear MCP is preserved and `linear` is still added", async () => {
      const before = { numStartups: 7, mcpServers: { "linear-matt": { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer other" } } } };
      const p = fakeProbes({ home, env: {}, files: { [`${home}/.claude.json`]: JSON.stringify(before, null, 2) } });
      const { ctx } = makeCtx(p, { secretPresence: withKey });
      expect((await linearMcpStep.run(ctx)).state).toBe("done");
      const written = JSON.parse(p.readFile(`${home}/.claude.json`)!);
      expect(written.mcpServers["linear-matt"]).toEqual(before.mcpServers["linear-matt"]);
      expect(written.mcpServers.linear).toEqual(hosted);
      expect(written.numStartups).toBe(7);
    });

    test("running twice is a no-op the second time", async () => {
      const p = fakeProbes({ home, env: {} });
      const { ctx } = makeCtx(p, { secretPresence: withKey });
      expect((await linearMcpStep.run(ctx)).state).toBe("done");
      const afterFirst = p.readFile(`${home}/.claude.json`);
      const renamesAfterFirst = p.calls.renames.length;
      expect(await linearMcpStep.run(ctx)).toEqual({ state: "skipped", detail: "already configured" });
      expect(p.readFile(`${home}/.claude.json`)).toBe(afterFirst);
      expect(p.calls.renames.length).toBe(renamesAfterFirst);
    });

    test("the name `linear` taken by an unrelated server is never taken over", async () => {
      const railway = { type: "http", url: "https://mcp.railway.app/mcp" };
      const p = fakeProbes({ home, env: {}, files: { [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { linear: railway } }) } });
      const { ctx } = makeCtx(p, { secretPresence: withKey });
      expect(await linearMcpStep.run(ctx)).toEqual({ state: "skipped", detail: "already configured" });
      expect(JSON.parse(p.readFile(`${home}/.claude.json`)!).mcpServers.linear).toEqual(railway);
    });

    test("an unparsable config is failed, never replaced", async () => {
      const p = fakeProbes({ home, env: {}, files: { [`${home}/.claude.json`]: "{ not json" } });
      const { ctx } = makeCtx(p, { secretPresence: withKey });
      const outcome = await linearMcpStep.run(ctx);
      expect(outcome.state).toBe("failed");
      expect(p.readFile(`${home}/.claude.json`)).toBe("{ not json");
    });

    test("a config that exists but cannot be read is failed, never replaced", async () => {
      const path = `${home}/.claude.json`;
      const p = fakeProbes({ home, env: {}, files: { [path]: JSON.stringify({ numStartups: 7 }) }, unreadable: [path] });
      const { ctx } = makeCtx(p, { secretPresence: withKey });
      const outcome = await linearMcpStep.run(ctx);
      expect(outcome.state).toBe("failed");
      expect(detailOf(outcome)).toContain("could not be read");
      expect(p.calls.writes).toEqual({});
      expect(p.calls.renames).toEqual([]);
    });

    test("CLAUDE_CONFIG_DIR is honored", async () => {
      const p = fakeProbes({ home, env: { CLAUDE_CONFIG_DIR: `${home}/alt` } });
      const { ctx } = makeCtx(p, { secretPresence: withKey });
      expect((await linearMcpStep.run(ctx)).state).toBe("done");
      expect(p.readFile(`${home}/alt/.claude.json`)).not.toBeNull();
      expect(p.readFile(`${home}/.claude.json`)).toBeNull();
    });

    test("the key is registered for redaction before anything is written", async () => {
      const redacted: string[] = [];
      const p = fakeProbes({ home, env: {} });
      const { ctx } = makeCtx(p, { secretPresence: withKey, redact: (v: string) => redacted.push(v) });
      await linearMcpStep.run(ctx);
      expect(redacted).toContain(KEY);
    });
  });
});
