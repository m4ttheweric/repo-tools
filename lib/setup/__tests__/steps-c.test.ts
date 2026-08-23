import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { basename, join } from "path";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { updateRepoIndex } from "../../repo-index.ts";
import { setSetting } from "../../settings/write.ts";
import type { SecretsSeams } from "../../secrets/store.ts";
import type { RelayClient } from "../../team/relay-client.ts";
import type { ApplyContext, StepOutcome } from "../apply.ts";
import { MERGE_MANIFESTS_MISSING_CODE } from "../skills-materialize.ts";
import { readSetupState } from "../state.ts";
import type { ToolsInstallSeams } from "../tools-install.ts";
import type { ToolResolution } from "../../deps/resolve.ts";
import { fakeProbes, fakeTray, ok } from "./fakes.ts";
import type { Probes } from "../probes.ts";

import { MATTSTACK_MARKETPLACE_SOURCE, pluginsInstallStep } from "../steps/plugins.ts";
import {
  extensionInstallRun,
  extensionInstallStep,
  fastbrowserSetupStep,
  herdrIntegrationStep,
  servicesStartRun,
  servicesStartStep,
  snapshotPushStep,
} from "../steps/tools.ts";
import { outcomeFromChecks, verifyStep } from "../steps/verify.ts";

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

describe("apply steps C: plugins, fast-browser, herdr, extension, services.start, snapshot.push, verify", () => {
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
    test("claude not resolvable -> failed with the Tools-row remedy, nothing execed", async () => {
      const p = fakeProbes({ home, env: {} });
      const { ctx } = makeCtx(p);
      const outcome = await pluginsInstallStep.run(ctx);
      expect(outcome).toEqual({
        state: "failed",
        detail: "claude not found (not bundled, no user copy on PATH)",
        remedy: "Install Claude Code (Tools row), then Retry.",
      });
      expect(p.calls.exec).toEqual([]);
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
          return ok("");
        },
      });
      const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

      const outcome = await pluginsInstallStep.run(ctx);

      expect(outcome.state).toBe("done");
      expect(detailOf(outcome)).toContain("3 marketplace(s), 3 plugin(s) across 1 config dir(s)");
      expect(detailOf(outcome)).toContain(MERGE_MANIFESTS_MISSING_CODE); // no mattstack plugin on disk yet in this fake — materialize honestly skips

      const marketAdds = execCalls.filter((c) => c.argv.includes("marketplace") && c.argv.includes("add"));
      const installs = execCalls.filter((c) => c.argv[1] === "plugin" && c.argv[2] === "install");
      const enables = execCalls.filter((c) => c.argv[1] === "plugin" && c.argv[2] === "enable");
      expect(marketAdds).toHaveLength(3);
      expect(installs).toHaveLength(3);
      expect(enables).toHaveLength(3);
      expect(execCalls.every((c) => c.argv[0] === "/usr/local/bin/claude")).toBe(true);
      expect(execCalls.every((c) => c.env?.CLAUDE_CONFIG_DIR === join(home, ".claude"))).toBe(true);

      const marketSrcs = marketAdds.map((c) => c.argv.at(-1) ?? "");
      expect(marketSrcs).toEqual(expect.arrayContaining(["https://example.com/extra-market", MATTSTACK_MARKETPLACE_SOURCE, teamDir]));

      const pluginNames = installs.map((c) => c.argv.at(-1) ?? "");
      expect(pluginNames).toEqual(expect.arrayContaining(["mattstack@mattstack", "fast-browser@mattstack", "acme-skills@acme-market"]));

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
        exec: async () => ok("materialized"),
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
        exec: async (argv) => (argv[2] === "install" ? { code: 3, stdout: "", stderr: "network error" } : ok("")),
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
  });

  // ─── fastbrowser.setup ──────────────────────────────────────────────────

  describe("fastbrowser.setup", () => {
    test("resolvable + setup succeeds -> done", async () => {
      const p = fakeProbes({ home, env: { PATH: "/usr/local/bin" }, files: { "/usr/local/bin/fast-browser": "bin" }, exec: async () => ok("") });
      const { ctx } = makeCtx(p);
      expect(await fastbrowserSetupStep.run(ctx)).toEqual({ state: "done", detail: "fast-browser setup complete" });
      expect(p.calls.exec).toEqual([["/usr/local/bin/fast-browser", "setup"]]);
    });

    test("idempotent re-run: two clean setups both done", async () => {
      const p = fakeProbes({ home, env: { PATH: "/usr/local/bin" }, files: { "/usr/local/bin/fast-browser": "bin" }, exec: async () => ok("") });
      expect(await fastbrowserSetupStep.run(makeCtx(p).ctx)).toEqual({ state: "done", detail: "fast-browser setup complete" });
      expect(await fastbrowserSetupStep.run(makeCtx(p).ctx)).toEqual({ state: "done", detail: "fast-browser setup complete" });
    });

    test("not bundled, no user copy -> skipped honestly, never execs", async () => {
      const p = fakeProbes({ home, env: {} });
      const { ctx } = makeCtx(p);
      expect(await fastbrowserSetupStep.run(ctx)).toEqual({ state: "skipped", detail: "fast-browser not bundled" });
      expect(p.calls.exec).toEqual([]);
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

    test("idempotent re-run: two clean installs both done", async () => {
      const p = fakeProbes({ home, env: { PATH: "/usr/local/bin" }, files: { "/usr/local/bin/herdr": "bin" }, exec: async () => ok("") });
      expect((await herdrIntegrationStep.run(makeCtx(p).ctx)).state).toBe("done");
      expect((await herdrIntegrationStep.run(makeCtx(p).ctx)).state).toBe("done");
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

    test("idempotent re-run: two clean installs both done", async () => {
      const p = fakeProbes({ home, exec: async () => ok("") });
      const seams: ToolsInstallSeams = { ...NOOP_SEAMS, findVsix: () => "/fake/rt-context.vsix", detectEditors: () => [{ name: "Cursor", cliPath: "/x/cursor", appPath: "/x" }] };
      expect((await extensionInstallRun(makeCtx(p).ctx, seams)).state).toBe("done");
      expect((await extensionInstallRun(makeCtx(p).ctx, seams)).state).toBe("done");
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

    test("idempotent re-run: two clean starts both done", async () => {
      const p = fakeProbes({
        home,
        tray: fakeTray({ "POST /daemon/start": () => ({ status: 200, json: {} }) }),
        daemon: async () => ({ ok: true }),
      });
      expect(await servicesStartStep.run(makeCtx(p).ctx)).toEqual({ state: "done", detail: "daemon running" });
      expect(await servicesStartStep.run(makeCtx(p).ctx)).toEqual({ state: "done", detail: "daemon running" });
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
    test("daemon reachable, commits -> done with the short sha", async () => {
      const p = fakeProbes({ home, daemon: async () => ({ ok: true, data: { committed: true, sha: "abcdef1234567890", paths: ["a"], reason: "manual" } }) });
      const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
      expect(outcome).toEqual({ state: "done", detail: "committed abcdef12" });
    });

    test("idempotent re-run: two clean triggers both done", async () => {
      const p = fakeProbes({ home, daemon: async () => ({ ok: true, data: { committed: true, sha: "abcdef1234567890", paths: [], reason: "manual" } }) });
      expect((await snapshotPushStep.run(makeCtx(p).ctx)).state).toBe("done");
      expect((await snapshotPushStep.run(makeCtx(p).ctx)).state).toBe("done");
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
      expect(outcome).toEqual({ state: "failed", detail: "commit failed", remedy: "check `git -C ~/.mattstack status`" });
    });

    describe("git fallback (daemon unreachable)", () => {
      const repoDir = () => join(home, ".mattstack", "user");

      test("commits and pushes via git directly", async () => {
        const execCalls: string[][] = [];
        const p = fakeProbes({
          home,
          dirs: { [join(repoDir(), ".git")]: [] },
          daemon: async () => null,
          exec: async (argv) => {
            execCalls.push(argv);
            return ok("");
          },
        });
        const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
        expect(outcome).toEqual({ state: "done", detail: "committed and pushed" });
        expect(execCalls).toEqual([
          ["git", "-C", repoDir(), "add", "-A"],
          ["git", "-C", repoDir(), "commit", "-m", "setup: snapshot"],
          ["git", "-C", repoDir(), "push"],
        ]);
      });

      test("'nothing to commit' is tolerated — still pushes", async () => {
        const p = fakeProbes({
          home,
          dirs: { [join(repoDir(), ".git")]: [] },
          daemon: async () => null,
          exec: async (argv) => (argv.includes("commit") ? { code: 1, stdout: "", stderr: "nothing to commit, working tree clean" } : ok("")),
        });
        const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
        expect(outcome).toEqual({ state: "done", detail: "nothing new to commit; pushed" });
      });

      test("home repo not provisioned yet -> skipped, never runs git", async () => {
        const execCalls: string[][] = [];
        const p = fakeProbes({ home, daemon: async () => null, exec: async (argv) => { execCalls.push(argv); return ok(""); } });
        const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
        expect(outcome).toEqual({ state: "skipped", detail: "home repo not provisioned yet (`rt home init`)" });
        expect(execCalls).toEqual([]);
      });

      test("push fails -> failed with the git-status remedy", async () => {
        const p = fakeProbes({
          home,
          dirs: { [join(repoDir(), ".git")]: [] },
          daemon: async () => null,
          exec: async (argv) => (argv.includes("push") ? { code: 1, stdout: "", stderr: "rejected" } : ok("")),
        });
        const outcome = await snapshotPushStep.run(makeCtx(p).ctx);
        expect(outcome).toEqual({ state: "failed", detail: "git push failed (exit 1): rejected", remedy: "check `git -C ~/.mattstack status`" });
      });
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
    });
  });
});
