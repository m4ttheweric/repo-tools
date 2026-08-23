import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { linkPath } from "../../deps/links.ts";
import {
  MARKER,
  ZSHENV_MARKER,
  detectShell,
  installShellIntegration,
  installZshenvPrecedence,
  shellRcPath,
} from "../../shell-integration.ts";
import type { SecretsSeams } from "../../secrets/store.ts";
import type { RelayClient } from "../../team/relay-client.ts";
import type { ApplyContext } from "../apply.ts";
import { awaitNeed, SERVICE_PLISTS } from "../need.ts";
import { PORTLESS_LAUNCHD_PLIST } from "../steps/services.ts";
import { readSetupState, updateSetupState } from "../state.ts";
import { fakeProbes, fakeTray, ok } from "./fakes.ts";
import type { Probes } from "../probes.ts";
import { computeUninstallActions, runUninstall, RT_CONTEXT_EXTENSION_ID, type UninstallAction, type UninstallSeams } from "../uninstall.ts";
import type { ApplyEvent } from "../contract.ts";

// ─── shared fakes (mirrors steps-b/c.test.ts's trivial no-ops) ─────────────

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

function makeCtx(p: Probes, overrides: Partial<ApplyContext> = {}): { ctx: ApplyContext; logs: { id: string; line: string }[]; events: ApplyEvent[] } {
  const logs: { id: string; line: string }[] = [];
  const events: ApplyEvent[] = [];
  const ctx: ApplyContext = {
    p,
    emit: (ev) => events.push(ev),
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
  return { ctx, logs, events };
}

/** Routes ctx.need through a real `awaitNeed` over `fakeTray`, mirroring steps-b.test.ts's own helper. */
function needViaTray(routes: Record<string, (body?: unknown) => { status: number; json: unknown }>): ApplyContext["need"] {
  return async (id) => awaitNeed(fakeTray(routes), id, { timeoutMs: 30, pollMs: 1 });
}

const APP_BUNDLE_ROOT = "/Applications/mattstack.app";

/** A no-editors seam by default — every test that cares about extension.uninstall overrides it explicitly. */
const noEditorSeams: UninstallSeams = { detectEditors: () => [] };

describe("rt uninstall", () => {
  // resolveTool/appBundlePath/currentMode all fall through to real fs/HOME
  // regardless of the Probes seam (same posture as steps-b/c.test.ts) — a
  // real per-test temp HOME, never the real machine's.
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-uninstall-home-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  /** A tool resolvable via a fake PATH entry (never the real bundle dance — deck/claude only need to be "resolvable", not "bundled", for uninstall). */
  function pathTool(name: string): { env: Record<string, string>; files: Record<string, string> } {
    return { env: { PATH: "/fake/bin" }, files: { [`/fake/bin/${name}`]: `${name}-binary` } };
  }

  function bareProbes(overrides: Partial<Parameters<typeof fakeProbes>[0]> = {}): ReturnType<typeof fakeProbes> {
    return fakeProbes({ home, ...overrides });
  }

  // ─── computeUninstallActions ────────────────────────────────────────────

  describe("computeUninstallActions", () => {
    test("a from-scratch machine: only services.unregister — nothing else to remove", () => {
      const actions = computeUninstallActions(bareProbes(), { keepData: true }, noEditorSeams);
      expect(actions.map((a) => a.id)).toEqual(["services.unregister"]);
      expect(actions[0]).toEqual({ id: "services.unregister", title: "Stop and remove the rt daemon and deck services", kind: "app" });
    });

    test("a fully-installed machine, keepData true: every id except data, in contract order", () => {
      const dir = join(home, ".local", "bin");
      const p = bareProbes({
        ...pathTool("deck"),
        files: { ...pathTool("deck").files, [PORTLESS_LAUNCHD_PLIST]: "<plist/>" },
        links: { [join(dir, "gitq")]: `${APP_BUNDLE_ROOT}/Contents/Helpers/gitq` },
        dirs: { [dir]: ["gitq"], [APP_BUNDLE_ROOT]: [] },
      });
      installShellIntegration();
      updateSetupState(p, (s) => ({ ...s, extensionEditors: ["Cursor"], plugins: ["mattstack@mattstack"], marketplaces: ["https://x/market"] }));

      const actions = computeUninstallActions(p, { keepData: true }, noEditorSeams);
      expect(actions.map((a) => a.id)).toEqual([
        "services.unregister",
        "deck.managed-remove",
        "proxy.remove",
        "path.unlink",
        "shell.remove",
        "extension.uninstall",
        "plugins.uninstall",
        "app.trash",
      ]);
    });

    test("--delete-data (keepData:false): data appears right before app.trash", () => {
      const p = bareProbes({ dirs: { [APP_BUNDLE_ROOT]: [] } });
      const actions = computeUninstallActions(p, { keepData: false }, noEditorSeams);
      expect(actions.map((a) => a.id)).toEqual(["services.unregister", "data", "app.trash"]);
    });

    test("deck.managed-remove: gated on deck being resolvable at all, not just bundled", () => {
      const withoutDeck = computeUninstallActions(bareProbes(), { keepData: true }, noEditorSeams);
      expect(withoutDeck.some((a) => a.id === "deck.managed-remove")).toBe(false);

      const withDeck = computeUninstallActions(bareProbes(pathTool("deck")), { keepData: true }, noEditorSeams);
      expect(withDeck.some((a) => a.id === "deck.managed-remove")).toBe(true);
    });

    test("proxy.remove: gated on the portless LaunchDaemon plist existing", () => {
      const p = bareProbes({ files: { [PORTLESS_LAUNCHD_PLIST]: "<plist/>" } });
      const actions = computeUninstallActions(p, { keepData: true }, noEditorSeams);
      expect(actions.some((a) => a.id === "proxy.remove")).toBe(true);
      expect(actions.find((a) => a.id === "proxy.remove")).toEqual({ id: "proxy.remove", title: "Remove the local HTTPS proxy (admin prompt)", kind: "privileged" });
    });

    test("path.unlink: gated on at least one our-link existing in ~/.local/bin — a foreign file there doesn't count", () => {
      const dir = join(home, ".local", "bin");
      const foreignOnly = bareProbes({ links: { [join(dir, "rt")]: "/usr/local/bin/some-other-rt" }, dirs: { [dir]: ["rt"] } });
      expect(computeUninstallActions(foreignOnly, { keepData: true }, noEditorSeams).some((a) => a.id === "path.unlink")).toBe(false);

      const ourLink = bareProbes({ links: { [join(dir, "gitq")]: `${APP_BUNDLE_ROOT}/Contents/Helpers/gitq` }, dirs: { [dir]: ["gitq"] } });
      expect(computeUninstallActions(ourLink, { keepData: true }, noEditorSeams).some((a) => a.id === "path.unlink")).toBe(true);
    });

    test("shell.remove: gated on the rc file actually carrying the marker", () => {
      const p = bareProbes();
      expect(computeUninstallActions(p, { keepData: true }, noEditorSeams).some((a) => a.id === "shell.remove")).toBe(false);

      installShellIntegration();
      expect(computeUninstallActions(p, { keepData: true }, noEditorSeams).some((a) => a.id === "shell.remove")).toBe(true);
    });

    test("extension.uninstall: gated on setup-state OR a live detectEditors() seam result", () => {
      const p = bareProbes();
      expect(computeUninstallActions(p, { keepData: true }, noEditorSeams).some((a) => a.id === "extension.uninstall")).toBe(false);

      updateSetupState(p, (s) => ({ ...s, extensionEditors: ["Cursor"] }));
      expect(computeUninstallActions(p, { keepData: true }, noEditorSeams).some((a) => a.id === "extension.uninstall")).toBe(true);

      const freshP = bareProbes();
      const seams: UninstallSeams = { detectEditors: () => [{ name: "Cursor", cliPath: "/x/cli", appPath: "/x" }] };
      expect(computeUninstallActions(freshP, { keepData: true }, seams).some((a) => a.id === "extension.uninstall")).toBe(true);
    });

    test("plugins.uninstall: gated on setup-state recording plugins or marketplaces", () => {
      const p = bareProbes();
      expect(computeUninstallActions(p, { keepData: true }, noEditorSeams).some((a) => a.id === "plugins.uninstall")).toBe(false);

      updateSetupState(p, (s) => ({ ...s, plugins: ["mattstack@mattstack"] }));
      expect(computeUninstallActions(p, { keepData: true }, noEditorSeams).some((a) => a.id === "plugins.uninstall")).toBe(true);
    });

    test("app.trash: gated on appBundlePath resolving", () => {
      expect(computeUninstallActions(bareProbes(), { keepData: true }, noEditorSeams).some((a) => a.id === "app.trash")).toBe(false);
      const p = bareProbes({ dirs: { [APP_BUNDLE_ROOT]: [] } });
      expect(computeUninstallActions(p, { keepData: true }, noEditorSeams).some((a) => a.id === "app.trash")).toBe(true);
    });
  });

  // ─── runUninstall: NDJSON shape + stayed ────────────────────────────────

  describe("runUninstall — NDJSON shape and stayed", () => {
    test("emits plan/step/step/.../done, one 'running' then one terminal event per action", async () => {
      const actions: UninstallAction[] = [{ id: "services.unregister", title: "x", kind: "app" }];
      const p = bareProbes();
      const { ctx, events } = makeCtx(p, { need: async () => ({ ok: true, detail: "done" }) });

      const result = await runUninstall(ctx, actions);
      expect(result.ok).toBe(true);
      expect(events.map((e) => e.event)).toEqual(["plan", "step", "step", "done"]);
      expect((events[1] as { state: string }).state).toBe("running");
      expect((events[2] as { state: string }).state).toBe("done");
    });

    test("stayed includes \"~/.mattstack (kept)\" whenever the data action isn't in the run", async () => {
      const actions: UninstallAction[] = [{ id: "services.unregister", title: "x", kind: "app" }];
      const p = bareProbes();
      const { ctx } = makeCtx(p, { need: async () => ({ ok: true, detail: "done" }) });

      const result = await runUninstall(ctx, actions);
      expect(result.stayed).toContain("~/.mattstack (kept)");
    });

    test("stayed omits the kept note when data IS in the run", async () => {
      const actions: UninstallAction[] = [{ id: "data", title: "x", kind: "rt" }];
      const p = bareProbes(); // the data dir doesn't exist -> skipped, not failed
      const { ctx } = makeCtx(p);

      const result = await runUninstall(ctx, actions);
      expect(result.stayed).not.toContain("~/.mattstack (kept)");
    });

    test("a failed action stops the run — later actions never execute", async () => {
      const actions: UninstallAction[] = [
        { id: "proxy.remove", title: "x", kind: "privileged" },
        { id: "app.trash", title: "y", kind: "rt" },
      ];
      const p = bareProbes({ files: { [PORTLESS_LAUNCHD_PLIST]: "<plist/>" } });
      const { ctx, events } = makeCtx(p, { need: async () => "app-gone" });

      const result = await runUninstall(ctx, actions);
      expect(result.ok).toBe(false);
      expect(result.failed).toBe("proxy.remove");
      expect(events.filter((e) => e.event === "step" && (e as { id: string }).id === "app.trash")).toEqual([]);
    });

    test("no action may crash the run: a library throw is caught and reported as a failed outcome, done still emitted", async () => {
      const actions: UninstallAction[] = [{ id: "plugins.uninstall", title: "x", kind: "rt" }];
      const p = bareProbes({
        ...pathTool("claude"),
        exec: () => {
          throw new Error("boom");
        },
      });
      updateSetupState(p, (s) => ({ ...s, plugins: ["mattstack@mattstack"] }));
      const { ctx, events } = makeCtx(p);

      const result = await runUninstall(ctx, actions);
      expect(result.ok).toBe(false);
      const done = events.find((e) => e.event === "done");
      expect(done).toBeDefined();
    });
  });

  // ─── services.unregister ────────────────────────────────────────────────

  describe("services.unregister", () => {
    test("requests app-unregister-services with the daemon plist (deck not resolvable)", async () => {
      let captured: unknown;
      const p = bareProbes();
      const { ctx } = makeCtx(p, {
        need: async (id, request) => {
          captured = request;
          return { ok: true, detail: "unregistered" };
        },
      });

      const result = await runUninstall(ctx, [{ id: "services.unregister", title: "x", kind: "app" }]);
      expect(result.ok).toBe(true);
      expect(captured).toEqual({ type: "app-unregister-services", plists: [SERVICE_PLISTS[0]] });
    });

    test("no-app + nonInteractive -> skipped (not a failure)", async () => {
      const p = bareProbes();
      const { ctx } = makeCtx(p, { nonInteractive: true, need: async () => "no-app" });
      const result = await runUninstall(ctx, [{ id: "services.unregister", title: "x", kind: "app" }]);
      expect(result.ok).toBe(true);
    });

    test("timeout -> the run fails at this action, with a retry remedy", async () => {
      const p = bareProbes();
      const { ctx, events } = makeCtx(p, {
        need: needViaTray({ "GET /setup/need/services.unregister": () => ({ status: 200, json: { state: "pending" } }) }),
      });
      const result = await runUninstall(ctx, [{ id: "services.unregister", title: "x", kind: "app" }]);
      expect(result.ok).toBe(false);
      expect(result.failed).toBe("services.unregister");
      const stepEvents = events.filter((e) => e.event === "step") as { state: string; remedy?: string }[];
      expect(stepEvents.at(-1)?.remedy).toBe("Retry with mattstack.app running");
    });
  });

  // ─── deck.managed-remove ────────────────────────────────────────────────

  describe("deck.managed-remove", () => {
    const healthyFetch: Probes["fetch"] = async (url) => (url.endsWith("/healthz") ? { status: 200, body: "ok", headers: {} } : { status: 404, body: "", headers: {} });

    test("deck not running (no api.json) -> skipped, never execs", async () => {
      const p = bareProbes(pathTool("deck"));
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "deck.managed-remove", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
      expect(p.calls.exec).toEqual([]);
    });

    test("healthy deck: runs `deck remove --managed board` then `… gitq` — exact argv", async () => {
      const p = bareProbes({
        ...pathTool("deck"),
        files: { ...pathTool("deck").files, [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
        fetch: healthyFetch,
        exec: async () => ok(""),
      });
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "deck.managed-remove", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
      expect(p.calls.exec).toEqual([
        ["/fake/bin/deck", "remove", "--managed", "board"],
        ["/fake/bin/deck", "remove", "--managed", "gitq"],
      ]);
    });

    test("deck answers 'not managed' for both -> honest skip-per-leg, action still done", async () => {
      const p = bareProbes({
        ...pathTool("deck"),
        files: { ...pathTool("deck").files, [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
        fetch: healthyFetch,
        exec: async () => ({ code: 1, stdout: "", stderr: "error: not managed by mattstack\n" }),
      });
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "deck.managed-remove", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
    });

    test("a genuine deck failure -> the action fails with a retry remedy", async () => {
      const p = bareProbes({
        ...pathTool("deck"),
        files: { ...pathTool("deck").files, [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
        fetch: healthyFetch,
        exec: async () => ({ code: 1, stdout: "", stderr: "internal error\n" }),
      });
      const { ctx, events } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "deck.managed-remove", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(false);
      const stepEvents = events.filter((e) => e.event === "step") as { state: string; remedy?: string }[];
      expect(stepEvents.at(-1)?.remedy).toBe("Retry");
    });
  });

  // ─── proxy.remove ───────────────────────────────────────────────────────

  describe("proxy.remove", () => {
    test("not installed -> skipped, never calls ctx.need", async () => {
      let needCalled = false;
      const p = bareProbes();
      const { ctx } = makeCtx(p, {
        need: async () => {
          needCalled = true;
          return { ok: true, detail: "" };
        },
      });
      const result = await runUninstall(ctx, [{ id: "proxy.remove", title: "x", kind: "privileged" }]);
      expect(result.ok).toBe(true);
      expect(needCalled).toBe(false);
    });

    test("installed: requests app-privileged proxy-remove", async () => {
      let captured: unknown;
      const p = bareProbes({ files: { [PORTLESS_LAUNCHD_PLIST]: "<plist/>" } });
      const { ctx } = makeCtx(p, {
        need: async (id, request) => {
          captured = request;
          return { ok: true, detail: "removed" };
        },
      });
      const result = await runUninstall(ctx, [{ id: "proxy.remove", title: "x", kind: "privileged" }]);
      expect(result.ok).toBe(true);
      expect(captured).toEqual({ type: "app-privileged", op: "proxy-remove" });
    });

    test("app-gone -> the action fails with the retry remedy", async () => {
      const p = bareProbes({ files: { [PORTLESS_LAUNCHD_PLIST]: "<plist/>" } });
      const { ctx } = makeCtx(p, { need: async () => "app-gone" });
      const result = await runUninstall(ctx, [{ id: "proxy.remove", title: "x", kind: "privileged" }]);
      expect(result.ok).toBe(false);
    });
  });

  // ─── path.unlink ────────────────────────────────────────────────────────

  describe("path.unlink", () => {
    test("nothing to remove -> done, 'nothing to remove'", async () => {
      const p = bareProbes();
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "path.unlink", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
    });

    test("removes DEFAULT_EXPOSED our-links plus any extra our-link, but NEVER a foreign file — ownership refusal", async () => {
      const dir = join(home, ".local", "bin");
      const p = bareProbes({
        links: {
          [join(dir, "gitq")]: `${APP_BUNDLE_ROOT}/Contents/Helpers/gitq`, // ours, in DEFAULT_EXPOSED
          [join(dir, "herdr")]: `${APP_BUNDLE_ROOT}/Contents/Helpers/herdr`, // ours, outside DEFAULT_EXPOSED
          [join(dir, "rt")]: "/usr/local/bin/some-other-rt", // NOT ours — a real user binary at this slot
        },
        dirs: { [dir]: ["gitq", "herdr", "rt"] },
      });
      const { ctx } = makeCtx(p);

      const result = await runUninstall(ctx, [{ id: "path.unlink", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
      expect(p.calls.removed).toContain(join(dir, "gitq"));
      expect(p.calls.removed).toContain(join(dir, "herdr"));
      expect(p.calls.removed).not.toContain(join(dir, "rt"));
      expect(p.readlink(join(dir, "rt"))).toBe("/usr/local/bin/some-other-rt"); // the foreign file survives untouched
    });
  });

  // ─── shell.remove ───────────────────────────────────────────────────────

  describe("shell.remove", () => {
    test("removes exactly the rc block and the zshenv precedence block it installed", async () => {
      installShellIntegration();
      installZshenvPrecedence();
      const rcPath = shellRcPath(detectShell())!;
      expect(readFileSync(rcPath, "utf8")).toContain(MARKER);
      expect(readFileSync(join(home, ".zshenv"), "utf8")).toContain(ZSHENV_MARKER);

      const p = bareProbes();
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "shell.remove", title: "x", kind: "rt" }]);

      expect(result.ok).toBe(true);
      expect(readFileSync(rcPath, "utf8")).not.toContain(MARKER);
      expect(readFileSync(join(home, ".zshenv"), "utf8")).not.toContain(ZSHENV_MARKER);
    });

    test("a block written before END_MARKER existed can't be safely stripped -> reported in stayed, action still done (not failed)", async () => {
      const rcPath = shellRcPath(detectShell())!;
      writeFileSync(rcPath, `${MARKER}\nexport PATH="$HOME/.local/bin:$PATH"\n`); // no END_MARKER

      const p = bareProbes();
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "shell.remove", title: "x", kind: "rt" }]);

      expect(result.ok).toBe(true);
      expect(result.stayed.some((s) => s.includes("manual"))).toBe(true);
      expect(readFileSync(rcPath, "utf8")).toContain(MARKER); // untouched — never guessed at the extent
    });

    test("idempotent: a second run on an already-clean rc file is still done, nothing to strip", async () => {
      installShellIntegration();
      const p = bareProbes();
      const { ctx: first } = makeCtx(p);
      await runUninstall(first, [{ id: "shell.remove", title: "x", kind: "rt" }]);

      const { ctx: second } = makeCtx(p);
      const result = await runUninstall(second, [{ id: "shell.remove", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
      expect(result.stayed.some((s) => s.includes("manual"))).toBe(false);
    });
  });

  // ─── extension.uninstall ────────────────────────────────────────────────

  describe("extension.uninstall", () => {
    test("no editors -> skipped", async () => {
      const p = bareProbes();
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "extension.uninstall", title: "x", kind: "rt" }], noEditorSeams);
      expect(result.ok).toBe(true);
    });

    test("uninstalls from every detected editor with the exact argv, clears them from setup-state", async () => {
      const execCalls: string[][] = [];
      const p = bareProbes({
        exec: async (argv) => {
          execCalls.push(argv);
          return ok("");
        },
      });
      updateSetupState(p, (s) => ({ ...s, extensionEditors: ["Cursor", "VS Code"] }));
      const seams: UninstallSeams = {
        detectEditors: () => [
          { name: "Cursor", cliPath: "/Applications/Cursor.app/cli", appPath: "/Applications/Cursor.app" },
          { name: "VS Code", cliPath: "/Applications/Code.app/cli", appPath: "/Applications/Code.app" },
        ],
      };
      const { ctx } = makeCtx(p);

      const result = await runUninstall(ctx, [{ id: "extension.uninstall", title: "x", kind: "rt" }], seams);
      expect(result.ok).toBe(true);
      expect(execCalls).toContainEqual(["/Applications/Cursor.app/cli", "--uninstall-extension", RT_CONTEXT_EXTENSION_ID]);
      expect(execCalls).toContainEqual(["/Applications/Code.app/cli", "--uninstall-extension", RT_CONTEXT_EXTENSION_ID]);
      expect(readSetupState(p).extensionEditors).toEqual([]);
    });

    test("an editor that genuinely fails -> the action fails with a manual-removal remedy", async () => {
      const p = bareProbes({ exec: async () => ({ code: 1, stdout: "", stderr: "some real error" }) });
      const seams: UninstallSeams = { detectEditors: () => [{ name: "Cursor", cliPath: "/x/cli", appPath: "/x" }] };
      const { ctx, events } = makeCtx(p);

      const result = await runUninstall(ctx, [{ id: "extension.uninstall", title: "x", kind: "rt" }], seams);
      expect(result.ok).toBe(false);
      const stepEvents = events.filter((e) => e.event === "step") as { state: string; remedy?: string }[];
      expect(stepEvents.at(-1)?.remedy).toBe("Uninstall the extension manually, then Retry");
    });
  });

  // ─── plugins.uninstall ──────────────────────────────────────────────────

  describe("plugins.uninstall", () => {
    test("claude not resolvable -> skipped", async () => {
      const p = bareProbes({ env: {} });
      updateSetupState(p, (s) => ({ ...s, plugins: ["mattstack@mattstack"] }));
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "plugins.uninstall", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
    });

    test("nothing recorded in setup-state -> skipped, never execs", async () => {
      const p = bareProbes(pathTool("claude"));
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "plugins.uninstall", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
      expect(p.calls.exec).toEqual([]);
    });

    test("uninstalls exactly what setup-state recorded — 'claude plugin uninstall mattstack@mattstack'", async () => {
      const execCalls: string[][] = [];
      const p = bareProbes({ ...pathTool("claude"), exec: async (argv) => { execCalls.push(argv); return ok(""); } });
      updateSetupState(p, (s) => ({ ...s, plugins: ["mattstack@mattstack"], marketplaces: ["https://x/market"] }));
      const { ctx } = makeCtx(p);

      const result = await runUninstall(ctx, [{ id: "plugins.uninstall", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
      expect(execCalls).toContainEqual(["/fake/bin/claude", "plugin", "uninstall", "mattstack@mattstack"]);
      expect(execCalls).toContainEqual(["/fake/bin/claude", "plugin", "marketplace", "remove", "https://x/market"]);
      expect(readSetupState(p).plugins).toEqual([]);
      expect(readSetupState(p).marketplaces).toEqual([]);
    });

    test("a genuine failure (not 'already gone') fails the action with a retry remedy", async () => {
      const p = bareProbes({ ...pathTool("claude"), exec: async () => ({ code: 1, stdout: "", stderr: "internal error" }) });
      updateSetupState(p, (s) => ({ ...s, plugins: ["mattstack@mattstack"] }));
      const { ctx, events } = makeCtx(p);

      const result = await runUninstall(ctx, [{ id: "plugins.uninstall", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(false);
      const stepEvents = events.filter((e) => e.event === "step") as { state: string; remedy?: string }[];
      expect(stepEvents.at(-1)?.remedy).toBe("Retry");
    });
  });

  // ─── data ────────────────────────────────────────────────────────────────

  describe("data", () => {
    test("directory doesn't exist -> skipped, never calls removeDir", async () => {
      const p = bareProbes();
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "data", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
      expect(p.calls.removed).toEqual([]);
    });

    test("happy path: removes exactly ~/.mattstack", async () => {
      const dataDir = join(home, ".mattstack");
      const p = bareProbes({ dirs: { [dataDir]: ["settings.json"] }, files: { [join(dataDir, "settings.json")]: "{}" } });
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "data", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
      expect(p.calls.removed).toContain(dataDir);
    });

    test("ownership refusal: an unsafe HOME (\"/\" or empty) refuses instead of deleting", async () => {
      const dataDir = "/.mattstack";
      const rootHomeProbes = fakeProbes({ home: "/", dirs: { [dataDir]: ["x"] } });
      const { ctx: rootCtx } = makeCtx(rootHomeProbes);
      const rootResult = await runUninstall(rootCtx, [{ id: "data", title: "x", kind: "rt" }]);
      expect(rootResult.ok).toBe(false);
      expect(rootHomeProbes.calls.removed).toEqual([]);

      const emptyHomeProbes = fakeProbes({ home: "", dirs: { ".mattstack": ["x"] } });
      const { ctx: emptyCtx } = makeCtx(emptyHomeProbes);
      const emptyResult = await runUninstall(emptyCtx, [{ id: "data", title: "x", kind: "rt" }]);
      expect(emptyResult.ok).toBe(false);
      expect(emptyHomeProbes.calls.removed).toEqual([]);
    });
  });

  // ─── app.trash ──────────────────────────────────────────────────────────

  describe("app.trash", () => {
    test("no app bundle -> skipped", async () => {
      const p = bareProbes();
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "app.trash", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
    });

    test("happy path: osascript tells Finder to delete the bundle", async () => {
      const execCalls: string[][] = [];
      const p = bareProbes({ dirs: { [APP_BUNDLE_ROOT]: [] }, exec: async (argv) => { execCalls.push(argv); return ok(""); } });
      const { ctx } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "app.trash", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(true);
      expect(execCalls).toHaveLength(1);
      expect(execCalls[0]![0]).toBe("osascript");
      expect(execCalls[0]![1]).toBe("-e");
      expect(execCalls[0]![2]).toContain("Finder");
      expect(execCalls[0]![2]).toContain(APP_BUNDLE_ROOT);
    });

    test("osascript failure -> failed with a manual-drag remedy", async () => {
      const p = bareProbes({ dirs: { [APP_BUNDLE_ROOT]: [] }, exec: async () => ({ code: 1, stdout: "", stderr: "not authorized" }) });
      const { ctx, events } = makeCtx(p);
      const result = await runUninstall(ctx, [{ id: "app.trash", title: "x", kind: "rt" }]);
      expect(result.ok).toBe(false);
      const stepEvents = events.filter((e) => e.event === "step") as { state: string; remedy?: string }[];
      expect(stepEvents.at(-1)?.remedy).toBe("Drag mattstack.app to the Trash yourself");
    });
  });
});
