import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { HELPERS_DIR, RT_BUNDLE_PATH, __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { getDaemonConfig } from "../../daemon-config.ts";
import { updateRepoIndex } from "../../repo-index.ts";
import { getSetting } from "../../settings/resolve.ts";
import { setSetting } from "../../settings/write.ts";
import type { SecretsSeams } from "../../secrets/store.ts";
import type { RelayClient } from "../../team/relay-client.ts";
import type { ApplyContext, StepOutcome } from "../apply.ts";
import { awaitNeed, SERVICE_PLISTS } from "../need.ts";
import { MERGE_MANIFESTS_MISSING_CODE } from "../skills-materialize.ts";
import { fakeProbes, fakeTray, ok } from "./fakes.ts";
import type { Probes } from "../probes.ts";

import { servicesRegisterStep, proxyInstallStep } from "../steps/services.ts";
import { deckManagedStep } from "../steps/deck.ts";
import { skillsMaterializeStep, boardKeysStep, cronTriageStep } from "../steps/skills.ts";

// ─── shared fakes (same shapes as steps-a.test.ts; none of steps B's bodies
// touch secrets/relay, so these stay trivial no-ops) ────────────────────────

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

/** Routes ctx.need through a real `awaitNeed` over `fakeTray`, so the "ok"/"timeout"/"app-gone" branches are genuinely driven by the same polling logic production uses — only "no-app" (a pre-check that never touches tray) is returned as a bare literal by a test instead. */
function needViaTray(routes: Record<string, (body?: unknown) => { status: number; json: unknown }>): ApplyContext["need"] {
  return async (id) => awaitNeed(fakeTray(routes), id, { timeoutMs: 30, pollMs: 1 });
}

function detailOf(outcome: StepOutcome): string | undefined {
  return "detail" in outcome ? outcome.detail : undefined;
}

// ─── real-HOME bundle fixture (mirrors steps-a.test.ts's bundleProbe) ───────
// appBundlePath/bundledToolPath read the real deps.lock off disk and the
// real `mattstack.appPath` machine setting regardless of the Probes seam —
// only their own `exists`/`readFile` calls are injectable — so a "tool is
// bundled" test needs a real temp bundle root, not just fakeProbes state.

function lockTool(name: string, sha: string) {
  return { name, version: "0.1.0", license: "MIT", url: `https://x/${name}.tgz`, sha256: sha.repeat(64), archive: "raw", extract: "", bundlePath: `${HELPERS_DIR}/${name}`, exec: [`${HELPERS_DIR}/${name}`], exposeByDefault: true, entitlements: "none", status: "bundled", kind: "helper" };
}

describe("services B: services.register, proxy.install, deck.managed, skills.materialize, board.keys, cron.triage", () => {
  const origHome = process.env.HOME;
  let home: string;
  let appRoot: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-steps-b-home-")));
    process.env.HOME = home;
    appRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "rt-steps-b-app-"))), "mattstack.app");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  /** Writes the real bundle (deps.lock, rt binary, whichever of deck/gitq/board are requested) to disk and points `mattstack.appPath` at it, then returns a fakeProbes mirroring the same layout so the Probes-side `exists`/`readFile` calls agree with what's really on disk. `deck` is always included — every deck.managed test needs the gate to pass; omit "gitq" or "board" from `tools` to simulate either not being bundled yet. */
  function bundledProbes(opts: { tools?: ("gitq" | "board")[]; overrides?: Partial<Parameters<typeof fakeProbes>[0]> } = {}): ReturnType<typeof fakeProbes> {
    const names = ["deck", ...(opts.tools ?? ["gitq"])];
    mkdirSync(join(appRoot, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(appRoot, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(appRoot, HELPERS_DIR), { recursive: true });
    writeFileSync(join(appRoot, "Contents", "Info.plist"), "<plist/>");
    writeFileSync(join(appRoot, "Contents", "Resources", "deps.lock"), JSON.stringify({ schema: 1, arch: "arm64", tools: names.map((n, i) => lockTool(n, String(i))) }));
    writeFileSync(join(appRoot, RT_BUNDLE_PATH), "rt-binary");
    const files: Record<string, string> = { [join(appRoot, RT_BUNDLE_PATH)]: "rt-binary" };
    for (const name of names) {
      writeFileSync(join(appRoot, HELPERS_DIR, name), `${name}-binary`);
      files[join(appRoot, HELPERS_DIR, name)] = `${name}-binary`;
    }
    setSetting("mattstack.appPath", appRoot, "machine");

    return fakeProbes({
      home,
      env: { PATH: "" }, // never let a real PATH tool stand in for "not bundled" in these tests
      ...opts.overrides,
      files: { ...files, ...opts.overrides?.files },
      dirs: { [appRoot]: [], ...opts.overrides?.dirs },
    });
  }

  // ─── services.register ─────────────────────────────────────────────────

  describe("services.register", () => {
    test("deck not bundled: requests only the daemon plist and logs it", async () => {
      const p = fakeProbes({ home });
      const { ctx, logs } = makeCtx(p, { need: needViaTray({ "GET /setup/need/services.register": () => ({ status: 200, json: { state: "done", detail: "registered" } }) }) });

      const outcome = await servicesRegisterStep.run(ctx);
      expect(outcome).toEqual({ state: "done", detail: "registered" });
      expect(logs.some((l) => l.line.includes("deck not bundled"))).toBe(true);
      // markDaemonInstalled is called with ctx.p.home (services.ts), not the
      // ambient shared preload HOME — read back through the SAME explicit
      // `home` to prove the write actually landed under THIS test's temp
      // HOME, and independently off real fs to prove it isn't a fakeProbes
      // illusion.
      expect(getDaemonConfig(home)?.installed).toBe(true);
      const raw = JSON.parse(readFileSync(join(home, ".mattstack", "rt", "daemon.json"), "utf8"));
      expect(raw.installed).toBe(true);
    });

    test("deck bundled: requests both plists, no log", async () => {
      const p = bundledProbes({ tools: [] });
      let captured: unknown;
      const { ctx, logs } = makeCtx(p, {
        need: async (id, request) => {
          captured = request;
          return { ok: true, detail: "registered" };
        },
      });

      await servicesRegisterStep.run(ctx);
      expect(captured).toEqual({ type: "app-register-services", plists: [...SERVICE_PLISTS] });
      expect(logs.some((l) => l.line.includes("deck not bundled"))).toBe(false);
    });

    test("no-app + nonInteractive -> skipped", async () => {
      const p = fakeProbes({ home });
      const { ctx } = makeCtx(p, { nonInteractive: true, need: async () => "no-app" });

      const outcome = await servicesRegisterStep.run(ctx);
      expect(outcome).toEqual({ state: "skipped", detail: "mattstack.app not running — open it to register services" });
    });

    test("no-app + interactive -> failed with remedy", async () => {
      const p = fakeProbes({ home });
      const { ctx } = makeCtx(p, { nonInteractive: false, need: async () => "no-app" });

      const outcome = await servicesRegisterStep.run(ctx);
      expect(outcome).toEqual({ state: "failed", detail: "mattstack.app not running — open it to register services", remedy: "Open mattstack.app, then Retry" });
    });

    test("timeout -> failed with retry remedy", async () => {
      const p = fakeProbes({ home });
      // Always "pending" (reachable, never terminal) -> polls until the deadline, never "app-gone".
      const { ctx } = makeCtx(p, { need: needViaTray({ "GET /setup/need/services.register": () => ({ status: 200, json: { state: "pending" } }) }) });

      const outcome = await servicesRegisterStep.run(ctx);
      expect(outcome).toEqual({ state: "failed", detail: "timed out waiting for mattstack.app", remedy: "Retry with mattstack.app running" });
    });

    test("app reports failure -> failed with its own detail, no remedy", async () => {
      const p = fakeProbes({ home });
      const { ctx } = makeCtx(p, { need: needViaTray({ "GET /setup/need/services.register": () => ({ status: 200, json: { state: "failed", detail: "plist rejected by launchd" } }) }) });

      const outcome = await servicesRegisterStep.run(ctx);
      expect(outcome).toEqual({ state: "failed", detail: "plist rejected by launchd" });
    });

    test("idempotent re-run: a second `done` reply registers again cleanly", async () => {
      const p = fakeProbes({ home });
      const need = needViaTray({ "GET /setup/need/services.register": () => ({ status: 200, json: { state: "done", detail: "registered" } }) });

      const { ctx: first } = makeCtx(p, { need });
      const { ctx: second } = makeCtx(p, { need });
      expect(await servicesRegisterStep.run(first)).toEqual({ state: "done", detail: "registered" });
      expect(await servicesRegisterStep.run(second)).toEqual({ state: "done", detail: "registered" });
      expect(getDaemonConfig(home)?.installed).toBe(true);
    });
  });

  // ─── proxy.install ──────────────────────────────────────────────────────

  describe("proxy.install", () => {
    test("requests the privileged proxy-install op; ok reply -> done", async () => {
      let captured: unknown;
      const { ctx } = makeCtx(fakeProbes({ home }), {
        need: async (id, request) => {
          captured = request;
          return { ok: true, detail: "proxy installed" };
        },
      });

      const outcome = await proxyInstallStep.run(ctx);
      expect(captured).toEqual({ type: "app-privileged", op: "proxy-install" });
      expect(outcome).toEqual({ state: "done", detail: "proxy installed" });
    });

    test("no-app + nonInteractive -> skipped; interactive -> failed with remedy", async () => {
      const { ctx: nonInteractive } = makeCtx(fakeProbes({ home }), { nonInteractive: true, need: async () => "no-app" });
      expect(await proxyInstallStep.run(nonInteractive)).toEqual({
        state: "skipped",
        detail: "mattstack.app not running — open it to install the local proxy",
      });

      const { ctx: interactive } = makeCtx(fakeProbes({ home }), { nonInteractive: false, need: async () => "no-app" });
      expect(await proxyInstallStep.run(interactive)).toEqual({
        state: "failed",
        detail: "mattstack.app not running — open it to install the local proxy",
        remedy: "Open mattstack.app, then Retry",
      });
    });

    test("app-gone -> failed with retry remedy", async () => {
      const { ctx } = makeCtx(fakeProbes({ home }), { need: async () => "app-gone" });
      expect(await proxyInstallStep.run(ctx)).toEqual({
        state: "failed",
        detail: "mattstack.app stopped responding",
        remedy: "Retry with mattstack.app running",
      });
    });

    test("denied by the privileged installer -> failed with its detail", async () => {
      const { ctx } = makeCtx(fakeProbes({ home }), { need: async () => ({ ok: false, detail: "admin prompt cancelled" }) });
      expect(await proxyInstallStep.run(ctx)).toEqual({ state: "failed", detail: "admin prompt cancelled" });
    });

    test("idempotent re-run: two ok replies both report done", async () => {
      const need: ApplyContext["need"] = async () => ({ ok: true, detail: "already installed" });
      expect(await proxyInstallStep.run(makeCtx(fakeProbes({ home }), { need }).ctx)).toEqual({ state: "done", detail: "already installed" });
      expect(await proxyInstallStep.run(makeCtx(fakeProbes({ home }), { need }).ctx)).toEqual({ state: "done", detail: "already installed" });
    });

    test("the portless LaunchDaemon already exists on disk: done without ever calling ctx.need — a from-scratch re-run must not re-raise the admin prompt", async () => {
      let needCalled = false;
      const p = fakeProbes({ home, files: { "/Library/LaunchDaemons/sh.portless.proxy.plist": "<plist/>" } });
      const { ctx } = makeCtx(p, {
        need: async () => {
          needCalled = true;
          return { ok: true, detail: "" };
        },
      });

      expect(await proxyInstallStep.run(ctx)).toEqual({ state: "done", detail: "already installed" });
      expect(needCalled).toBe(false);
    });

    test("the portless LaunchDaemon is absent: falls through to ctx.need as normal", async () => {
      const p = fakeProbes({ home });
      let requested = false;
      const { ctx } = makeCtx(p, {
        need: async () => {
          requested = true;
          return { ok: true, detail: "installed" };
        },
      });

      expect(await proxyInstallStep.run(ctx)).toEqual({ state: "done", detail: "installed" });
      expect(requested).toBe(true);
    });
  });

  // ─── deck.managed ───────────────────────────────────────────────────────

  describe("deck.managed", () => {
    const healthyFetch = (deckPort: number, boardPort = deckPort, patchOk = true): Probes["fetch"] =>
      async (url, init) => {
        if (url.endsWith("/healthz")) return { status: 200, body: "ok", headers: {} };
        if (url.includes("/api/v1/apps/board") && init?.method === "PATCH") return { status: patchOk ? 200 : 500, body: "", headers: {} };
        return { status: 404, body: "", headers: {} };
      };

    test("deck not bundled -> skipped", async () => {
      const p = fakeProbes({ home });
      const { ctx } = makeCtx(p);
      expect(await deckManagedStep.run(ctx)).toEqual({ state: "skipped", detail: "deck not bundled yet" });
    });

    test("deck bundled but unhealthy (no api.json) -> failed, never runs adopt", async () => {
      const p = bundledProbes();
      const { ctx } = makeCtx(p);
      const outcome = await deckManagedStep.run(ctx);
      expect(outcome).toEqual({
        state: "failed",
        detail: "deck is not answering its own /healthz — cannot adopt board safely",
        remedy: "Start deck, then Retry",
      });
      expect(p.calls.exec).toEqual([]);
    });

    test("healthy + board bundled: adopts, repoints via PATCH, registers gitq", async () => {
      const p = bundledProbes({
        tools: ["gitq", "board"],
        overrides: {
          files: { [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
          fetch: healthyFetch(4100),
          exec: async () => ok(""),
        },
      });
      const { ctx } = makeCtx(p);

      const outcome = await deckManagedStep.run(ctx);
      expect(outcome.state).toBe("done");
      expect(detailOf(outcome)).toContain("repointed");
      expect(detailOf(outcome)).toContain("gitq registered");

      const deckBin = join(appRoot, HELPERS_DIR, "deck");
      expect(p.calls.exec[0]).toEqual([deckBin, "adopt", "mrs", "--as", "board", "--json"]);
      expect(p.calls.exec[1]).toEqual([deckBin, "add", "gitq", "--cmd", join(appRoot, HELPERS_DIR, "gitq"), "--managed-by", "mattstack", "--host", "gitq.mattstack"]);
      expect(p.calls.fetch).toContain("http://127.0.0.1:4100/api/v1/apps/board");
    });

    test("healthy + board NOT bundled: adopts, skips the repoint honestly", async () => {
      const p = bundledProbes({
        tools: ["gitq"],
        overrides: {
          files: { [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
          fetch: healthyFetch(4100),
          exec: async () => ok(""),
        },
      });
      const { ctx, logs } = makeCtx(p);

      const outcome = await deckManagedStep.run(ctx);
      expect(outcome.state).toBe("done");
      expect(detailOf(outcome)).toContain("repoint skipped (board not bundled yet)");
      expect(p.calls.fetch.some((u) => u.includes("/api/v1/apps/board"))).toBe(false);
      expect(logs).toEqual([]); // the skip is in the outcome detail, not a separate log line
    });

    test("adopt fails with 'deck not running' -> failed, retryable precondition (not a rejection)", async () => {
      const p = bundledProbes({
        tools: [],
        overrides: {
          files: { [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
          fetch: healthyFetch(4100),
          exec: async () => ({ code: 1, stdout: "", stderr: "error: deck not running\n" }),
        },
      });
      const { ctx } = makeCtx(p);

      expect(await deckManagedStep.run(ctx)).toEqual({
        state: "failed",
        detail: "deck stopped responding before it could adopt board",
        remedy: "Start deck, then Retry",
      });
    });

    test("adopt fails with 'name taken' -> failed, generic retry remedy", async () => {
      const p = bundledProbes({
        tools: [],
        overrides: {
          files: { [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
          fetch: healthyFetch(4100),
          exec: async () => ({ code: 1, stdout: "", stderr: "error: name taken\n" }),
        },
      });
      const { ctx } = makeCtx(p);

      expect(await deckManagedStep.run(ctx)).toEqual({ state: "failed", detail: "name taken", remedy: "Retry" });
    });

    test("gitq not bundled: logged and reported, board portion still completes, never fatal", async () => {
      // "board" only, no "gitq" — bundledToolPath(p, "gitq") has nothing to find.
      const p = bundledProbes({
        tools: ["board"],
        overrides: {
          files: { [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
          fetch: healthyFetch(4100),
          exec: async () => ok(""),
        },
      });
      const { ctx, logs } = makeCtx(p);
      const outcome = await deckManagedStep.run(ctx);
      expect(outcome).toEqual({ state: "done", detail: "board adopted (repointed); gitq not registered: not bundled" });
      expect(logs.some((l) => l.line.includes("gitq") && l.line.includes("not bundled"))).toBe(true);
      expect(p.calls.exec).toHaveLength(1); // only the adopt — no `deck add gitq` with a null bin
    });

    test("gitq's real 'deck add' is a stub (MAT-384): a driver-fatal response is logged and tallied, never fails the run", async () => {
      const p = bundledProbes({
        tools: ["gitq", "board"],
        overrides: {
          files: { [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
          fetch: healthyFetch(4100),
          exec: async (argv) => (argv.includes("add") ? { code: 400, stdout: "", stderr: "command + workingDirectory, or staticPort, required" } : ok("")),
        },
      });
      const { ctx, logs } = makeCtx(p);
      const outcome = await deckManagedStep.run(ctx);
      expect(outcome.state).toBe("done");
      expect(detailOf(outcome)).toContain("gitq not registered: command + workingDirectory, or staticPort, required");
      expect(logs.some((l) => l.line.includes("deck add failed"))).toBe(true);
    });

    test("gitq duplicate registration answers deck's frozen 'name taken', not '/already/' — recognized as already-registered, not a failure", async () => {
      const p = bundledProbes({
        tools: ["gitq", "board"],
        overrides: {
          files: { [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
          fetch: healthyFetch(4100),
          exec: async (argv) => (argv.includes("add") ? { code: 1, stdout: "", stderr: '409 {"error":"name taken"}' } : ok("")),
        },
      });
      const { ctx } = makeCtx(p);
      const outcome = await deckManagedStep.run(ctx);
      expect(outcome).toEqual({ state: "done", detail: "board adopted (repointed); gitq already registered" });
    });

    test("fresh install (no legacy 'mrs'): adopt answers 'unknown app' — skips the board leg honestly, run continues past deck.managed", async () => {
      const p = bundledProbes({
        tools: ["gitq", "board"],
        overrides: {
          files: { [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
          fetch: healthyFetch(4100),
          exec: async (argv) => (argv.includes("adopt") ? { code: 1, stdout: '{"adopted":false,"error":"unknown app"}', stderr: "" } : ok("")),
        },
      });
      const { ctx } = makeCtx(p);
      const outcome = await deckManagedStep.run(ctx);
      // "done", not "failed" — the run is free to proceed to skills.materialize/board.keys/cron.triage next.
      expect(outcome).toEqual({ state: "done", detail: "board not adopted (no legacy mrs to adopt); gitq registered" });
      // No repoint PATCH was issued — there was nothing to repoint.
      expect(p.calls.fetch.some((u) => u.includes("/api/v1/apps/board"))).toBe(false);
    });

    test("idempotent re-run: second pass's adopt/repoint/gitq-add all still succeed against deck's real idempotent replies", async () => {
      let addCalls = 0;
      const p = bundledProbes({
        tools: ["gitq", "board"],
        overrides: {
          files: { [join(home, ".mattstack", "deck", "api.json")]: JSON.stringify({ port: 4100 }) },
          fetch: healthyFetch(4100),
          exec: async (argv) => {
            // adopt: exit 0 both passes — deck's own "already adopted" idempotency.
            if (!argv.includes("add")) return ok("");
            // add: only the SECOND call is a duplicate — deck's frozen "name taken".
            addCalls += 1;
            return addCalls === 1 ? ok("") : { code: 1, stdout: "", stderr: '409 {"error":"name taken"}' };
          },
        },
      });
      const { ctx: first } = makeCtx(p);
      const { ctx: second } = makeCtx(p);
      expect(await deckManagedStep.run(first)).toEqual({ state: "done", detail: "board adopted (repointed); gitq registered" });
      expect(await deckManagedStep.run(second)).toEqual({ state: "done", detail: "board adopted (repointed); gitq already registered" });
    });
  });

  // ─── skills.materialize ─────────────────────────────────────────────────

  describe("skills.materialize", () => {
    test("merge-manifests.sh absent -> skipped honestly, reason carries the missing code", async () => {
      const p = fakeProbes({ home });
      const { ctx } = makeCtx(p);
      const outcome = await skillsMaterializeStep.run(ctx);
      expect(outcome.state).toBe("skipped");
      expect(detailOf(outcome)).toContain(MERGE_MANIFESTS_MISSING_CODE);
    });

    test("script present + a registered repo -> done, per-repo summary", async () => {
      const repoDir = mkdtempSync(join(home, "repo-"));
      const repoName = basename(repoDir);
      updateRepoIndex(repoName, repoDir);

      const p = fakeProbes({
        home,
        env: { RT_MERGE_MANIFESTS: "/fake-home/merge-manifests.sh" },
        exec: async () => ok("materialized"),
      });
      const { ctx } = makeCtx(p);
      expect(await skillsMaterializeStep.run(ctx)).toEqual({ state: "done", detail: "materialized 1, failed 0" });
    });

    test("a per-repo script failure is logged and tallied, never fatal to the step", async () => {
      const repoDir = mkdtempSync(join(home, "repo-"));
      const repoName = basename(repoDir);
      updateRepoIndex(repoName, repoDir);

      const p = fakeProbes({
        home,
        env: { RT_MERGE_MANIFESTS: "/fake-home/merge-manifests.sh" },
        exec: async () => ({ code: 2, stdout: "", stderr: "not a git remote" }),
      });
      const { ctx, logs } = makeCtx(p);
      expect(await skillsMaterializeStep.run(ctx)).toEqual({ state: "done", detail: "materialized 0, failed 1" });
      expect(logs.some((l) => l.line.includes("not a git remote"))).toBe(true);
    });

    test("idempotent re-run: same script, same repo, done again", async () => {
      const repoDir = mkdtempSync(join(home, "repo-"));
      updateRepoIndex(basename(repoDir), repoDir);
      const p = fakeProbes({ home, env: { RT_MERGE_MANIFESTS: "/fake-home/merge-manifests.sh" }, exec: async () => ok("materialized") });

      expect(await skillsMaterializeStep.run(makeCtx(p).ctx)).toEqual({ state: "done", detail: "materialized 1, failed 0" });
      expect(await skillsMaterializeStep.run(makeCtx(p).ctx)).toEqual({ state: "done", detail: "materialized 1, failed 0" });
    });
  });

  // ─── board.keys ─────────────────────────────────────────────────────────

  describe("board.keys", () => {
    function seedTrackedRepo(): { repoName: string; repoDir: string } {
      const repoDir = mkdtempSync(join(home, "repo-"));
      const repoName = basename(repoDir);
      updateRepoIndex(repoName, repoDir);
      return { repoName, repoDir };
    }

    test("writes board.rtRepos from registered repos whose identity is tracked; read back", async () => {
      const { repoName } = seedTrackedRepo();
      setSetting("rt.repoRoots", [home], "machine");
      const p = fakeProbes({ home });
      const { ctx } = makeCtx(p, { snapshot: { slug: "acme", integrations: {}, trackingIdentities: [`gitlab.com/acme/${repoName}`], marketplaces: [], plugins: [], remote: null } });

      const outcome = await boardKeysStep.run(ctx);
      expect(detailOf(outcome)).toContain("board.rtRepos");
      expect(getSetting<string[]>("board.rtRepos").value).toEqual([repoName]);
    });

    test("writes board.cwds/gitq.board/gitq.workSlots once, then skips them once set (idempotent latch)", async () => {
      const { repoName } = seedTrackedRepo();
      setSetting("rt.repoRoots", [home], "machine");
      const p = fakeProbes({ home });
      const { ctx: first } = makeCtx(p, { snapshot: { slug: "acme", integrations: {}, trackingIdentities: [`gitlab.com/acme/${repoName}`], marketplaces: [], plugins: [], remote: null } });

      const firstOutcome = await boardKeysStep.run(first);
      expect(detailOf(firstOutcome)).toContain("board.cwds");
      expect(detailOf(firstOutcome)).toContain("gitq.board");
      expect(detailOf(firstOutcome)).toContain("gitq.workSlots");
      const expectedCwd = join(home, repoName);
      expect(getSetting("board.cwds").value).toEqual({ review: expectedCwd, respond: expectedCwd, doctor: expectedCwd });
      expect(getSetting("gitq.board").value).toEqual({ repos: [repoName], port: 11008 });
      expect(getSetting("gitq.workSlots").value).toEqual({ workSlotLocation: join(home, ".gitq-slots"), maxWorkSlots: 3 });

      // Someone (or a prior run) already set board.cwds by hand — the second run must not clobber it.
      setSetting("board.cwds", { review: "/custom", respond: "/custom", doctor: "/custom" }, "machine");
      const { ctx: second } = makeCtx(p, { snapshot: { slug: "acme", integrations: {}, trackingIdentities: [`gitlab.com/acme/${repoName}`], marketplaces: [], plugins: [], remote: null } });
      const secondOutcome = await boardKeysStep.run(second);
      expect(detailOf(secondOutcome)).not.toContain("board.cwds");
      expect(getSetting("board.cwds").value).toEqual({ review: "/custom", respond: "/custom", doctor: "/custom" });
    });

    test("idempotent re-run: board.rtRepos is not rewritten when the computed value is unchanged", async () => {
      const { repoName } = seedTrackedRepo();
      setSetting("rt.repoRoots", [home], "machine");
      const p = fakeProbes({ home });
      const snapshot = { slug: "acme", integrations: {}, trackingIdentities: [`gitlab.com/acme/${repoName}`], marketplaces: [], plugins: [], remote: null };

      await boardKeysStep.run(makeCtx(p, { snapshot }).ctx);
      const outcome = await boardKeysStep.run(makeCtx(p, { snapshot }).ctx);
      expect(detailOf(outcome)).not.toContain("board.rtRepos");
    });

    test("no tracked repos and no repo root: board.rtRepos/gitq.board still write (empty), board.cwds/gitq.workSlots honestly left unset, never crashes", async () => {
      const p = fakeProbes({ home });
      const { ctx, logs } = makeCtx(p);
      const outcome = await boardKeysStep.run(ctx);
      expect(outcome).toEqual({ state: "done", detail: "wrote: board.rtRepos, gitq.board" });
      expect(getSetting<string[]>("board.rtRepos").value).toEqual([]);
      expect(getSetting("gitq.board").value).toEqual({ repos: [], port: 11008 });
      expect(getSetting("board.cwds").value).toBeUndefined();
      expect(getSetting("gitq.workSlots").value).toBeUndefined();
      expect(logs.some((l) => l.line.includes("board.cwds"))).toBe(true);
      expect(logs.some((l) => l.line.includes("gitq.workSlots"))).toBe(true);
    });
  });

  // ─── cron.triage ────────────────────────────────────────────────────────

  describe("cron.triage", () => {
    test("board.triage unset -> skipped, never installs a trigger", async () => {
      const p = fakeProbes({ home });
      const { ctx } = makeCtx(p);
      expect(await cronTriageStep.run(ctx)).toEqual({ state: "skipped", detail: "board.triage not enabled" });
      expect(getSetting("rt.cron").value).toBeUndefined();
    });

    test("enabled, board only bundled (no checkout) -> installs the trigger against the bundled binary's triage subcommand", async () => {
      setSetting("board.triage", { enabled: true }, "user");
      const p = bundledProbes({ tools: ["board"] });
      const { ctx } = makeCtx(p);

      const outcome = await cronTriageStep.run(ctx);
      expect(outcome).toEqual({ state: "done", detail: "installed board-triage" });
      const triggers = getSetting<{ triggers: { name: string; run: string[] }[] }>("rt.cron").value?.triggers ?? [];
      expect(triggers).toHaveLength(1);
      expect(triggers[0]!.run).toEqual([join(appRoot, HELPERS_DIR, "board"), "triage"]);
    });

    test("enabled, board not resolvable at all -> skipped, board-missing wording", async () => {
      setSetting("board.triage", { enabled: true }, "user");
      const p = fakeProbes({ home });
      const { ctx } = makeCtx(p);

      const outcome = await cronTriageStep.run(ctx);
      expect(outcome).toEqual({ state: "skipped", detail: "board binary not found — resolve it first (`rt deps resolve board`)" });
    });

    test("enabled, a registered board checkout carrying bin/triage.ts -> done, installs the trigger", async () => {
      setSetting("board.triage", { enabled: true }, "user");
      const boardCheckout = mkdtempSync(join(home, "board-"));
      mkdirSync(join(boardCheckout, "bin"), { recursive: true });
      writeFileSync(join(boardCheckout, "bin", "triage.ts"), "// triage");
      updateRepoIndex("board", boardCheckout);

      // resolveBoardTriage's existence check runs through ctx.p, not real fs —
      // the fake must know about the script too, not just the real disk write above.
      const p = fakeProbes({ home, files: { [join(boardCheckout, "bin", "triage.ts")]: "// triage" } });
      const { ctx } = makeCtx(p);

      const outcome = await cronTriageStep.run(ctx);
      expect(outcome).toEqual({ state: "done", detail: "installed board-triage" });
      const triggers = getSetting<{ triggers: { name: string; run: string[] }[] }>("rt.cron").value?.triggers ?? [];
      expect(triggers).toHaveLength(1);
      expect(triggers[0]!.run).toEqual(["bun", "run", join(boardCheckout, "bin", "triage.ts")]);
    });

    test("idempotent re-run: installing the same trigger twice still leaves exactly one", async () => {
      setSetting("board.triage", { enabled: true }, "user");
      const boardCheckout = mkdtempSync(join(home, "board-"));
      mkdirSync(join(boardCheckout, "bin"), { recursive: true });
      writeFileSync(join(boardCheckout, "bin", "triage.ts"), "// triage");
      updateRepoIndex("board", boardCheckout);

      // resolveBoardTriage's existence check runs through ctx.p, not real fs —
      // the fake must know about the script too, not just the real disk write above.
      const p = fakeProbes({ home, files: { [join(boardCheckout, "bin", "triage.ts")]: "// triage" } });
      await cronTriageStep.run(makeCtx(p).ctx);
      await cronTriageStep.run(makeCtx(p).ctx);

      const triggers = getSetting<{ triggers: unknown[] }>("rt.cron").value?.triggers ?? [];
      expect(triggers).toHaveLength(1);
    });
  });
});
