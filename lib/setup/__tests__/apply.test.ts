import { describe, expect, test } from "bun:test";
import type { SecretsSeams } from "../../secrets/store.ts";
import type { RelayClient } from "../../team/relay-client.ts";
import type { ApplyContext, StepDef, StepOutcome } from "../apply.ts";
import { createApplyContext, runApplyWith } from "../apply.ts";
import type { ApplyEvent, StepId } from "../contract.ts";
import { STEP_IDS } from "../contract.ts";
import { UserActionableError } from "../errors.ts";
import { STEPS } from "../steps/index.ts";
import { fakeProbes } from "./fakes.ts";

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

function testCtx(overrides: Partial<ApplyContext> = {}): { ctx: ApplyContext; events: ApplyEvent[] } {
  const events: ApplyEvent[] = [];
  const p = fakeProbes();
  const ctx: ApplyContext = {
    p,
    emit: (ev) => events.push(ev),
    log(id, line) {
      events.push({ event: "log", id, line });
    },
    intent: null,
    team: { slug: "acme", name: "Acme", mode: "none" },
    snapshot: null,
    reqs: [],
    nonInteractive: false,
    teamOfOne: false,
    appPath: null,
    ci: false,
    secrets: fakeSecrets,
    relay: fakeRelay,
    async need() {
      return "app-gone";
    },
    ...overrides,
  };
  return { ctx, events };
}

function fakeStep(id: StepId, outcome: StepOutcome | (() => Promise<StepOutcome>), opts: { applies?: boolean } = {}): StepDef {
  return {
    id,
    title: id,
    kind: "rt",
    applies: () => opts.applies ?? true,
    run: typeof outcome === "function" ? outcome : async () => outcome,
  };
}

function throwingStep(id: StepId, err: unknown): StepDef {
  return { id, title: id, kind: "rt", applies: () => true, run: async () => { throw err; } };
}

describe("runApplyWith — happy path", () => {
  test("three done steps stream plan, running/done per step, then done ok:true", async () => {
    const { ctx, events } = testCtx();
    const steps: StepDef[] = [
      fakeStep("home.init", { state: "done", detail: "pushed main" }),
      fakeStep("home.restore", { state: "done" }),
      fakeStep("team.create", { state: "done", detail: "created" }),
    ];

    const result = await runApplyWith(steps, ctx, {});

    expect(result).toEqual({ ok: true });
    expect(events).toEqual([
      { event: "plan", steps: [
        { id: "home.init", title: "home.init", kind: "rt" },
        { id: "home.restore", title: "home.restore", kind: "rt" },
        { id: "team.create", title: "team.create", kind: "rt" },
      ] },
      { event: "step", id: "home.init", state: "running" },
      { event: "step", id: "home.init", state: "done", detail: "pushed main" },
      { event: "step", id: "home.restore", state: "running" },
      { event: "step", id: "home.restore", state: "done" },
      { event: "step", id: "team.create", state: "running" },
      { event: "step", id: "team.create", state: "done", detail: "created" },
      { event: "done", ok: true },
    ]);
  });

  test("persists lastApplyAt and clears the intent on a clean run", async () => {
    const { ctx } = testCtx({ intent: { v: 1, at: "x", mode: "create" } });
    (ctx.p as ReturnType<typeof fakeProbes>).writeFile("/fake-home/.mattstack/rt/setup-intent.json", "{}");
    await runApplyWith([fakeStep("home.init", { state: "done" })], ctx, {});

    const state = JSON.parse((ctx.p as ReturnType<typeof fakeProbes>).readFile("/fake-home/.mattstack/rt/setup-state.json")!);
    expect(state.lastApplyAt).toBe(ctx.p.now().toISOString());
    expect((ctx.p as ReturnType<typeof fakeProbes>).readFile("/fake-home/.mattstack/rt/setup-intent.json")).toBeNull();
  });
});

describe("runApplyWith — failure stops the run", () => {
  test("second step fails: third never runs, stream ends with done ok:false failedStep", async () => {
    const { ctx, events } = testCtx();
    let thirdRan = false;
    const steps: StepDef[] = [
      fakeStep("home.init", { state: "done" }),
      fakeStep("home.restore", { state: "failed", detail: "claude plugin install exited 1", remedy: "Open Claude Code once, then Retry." }),
      fakeStep("team.create", async () => {
        thirdRan = true;
        return { state: "done" };
      }),
    ];

    const result = await runApplyWith(steps, ctx, {});

    expect(result).toEqual({ ok: false, failedStep: "home.restore" });
    expect(thirdRan).toBe(false);
    expect(events.at(-2)).toEqual({
      event: "step",
      id: "home.restore",
      state: "failed",
      detail: "claude plugin install exited 1",
      remedy: "Open Claude Code once, then Retry.",
    });
    expect(events.at(-1)).toEqual({ event: "done", ok: false, failedStep: "home.restore" });
  });
});

describe("runApplyWith — thrown errors", () => {
  test("a step throwing UserActionableError becomes a failed step carrying the remedy", async () => {
    const { ctx, events } = testCtx();
    const steps: StepDef[] = [throwingStep("home.init", new UserActionableError("x", "msg", { remedy: "do y" }))];

    const result = await runApplyWith(steps, ctx, {});

    expect(result).toEqual({ ok: false, failedStep: "home.init" });
    expect(events.at(-2)).toEqual({ event: "step", id: "home.init", state: "failed", detail: "msg", remedy: "do y" });
    expect(events.at(-1)).toEqual({ event: "done", ok: false, failedStep: "home.init" });
  });

  test("a step throwing a plain Error emits a failed step + done, then rethrows", async () => {
    const { ctx, events } = testCtx();
    const boom = new Error("unexpected");
    const steps: StepDef[] = [throwingStep("home.init", boom)];

    await expect(runApplyWith(steps, ctx, {})).rejects.toBe(boom);
    expect(events.at(-2)).toEqual({ event: "step", id: "home.init", state: "failed", detail: "bug: unexpected" });
    expect(events.at(-1)).toEqual({ event: "done", ok: false, failedStep: "home.init" });
  });
});

describe("runApplyWith — skipped is non-fatal", () => {
  test("a skipped step continues to the next one", async () => {
    const { ctx, events } = testCtx();
    const steps: StepDef[] = [
      fakeStep("skills.materialize", { state: "skipped", detail: "plugins not installed yet" }),
      fakeStep("plugins.install", { state: "done", detail: "materialized skills too" }),
    ];

    const result = await runApplyWith(steps, ctx, {});

    expect(result).toEqual({ ok: true });
    expect(events).toContainEqual({ event: "step", id: "skills.materialize", state: "skipped", detail: "plugins not installed yet" });
    expect(events).toContainEqual({ event: "step", id: "plugins.install", state: "done", detail: "materialized skills too" });
    expect(events.at(-1)).toEqual({ event: "done", ok: true });
  });
});

describe("runApplyWith — --from resume", () => {
  test("resumes at the named step; earlier steps are emitted skipped, never run", async () => {
    const { ctx, events } = testCtx();
    let firstRan = false;
    const steps: StepDef[] = [
      fakeStep("home.init", async () => {
        firstRan = true;
        return { state: "done" };
      }),
      fakeStep("home.restore", { state: "done" }),
      fakeStep("team.create", { state: "done" }),
    ];

    const result = await runApplyWith(steps, ctx, { from: "home.restore" });

    expect(result).toEqual({ ok: true });
    expect(firstRan).toBe(false);
    expect(events).toEqual([
      { event: "plan", steps: [
        { id: "home.init", title: "home.init", kind: "rt" },
        { id: "home.restore", title: "home.restore", kind: "rt" },
        { id: "team.create", title: "team.create", kind: "rt" },
      ] },
      { event: "step", id: "home.init", state: "skipped", detail: "before --from" },
      { event: "step", id: "home.restore", state: "running" },
      { event: "step", id: "home.restore", state: "done" },
      { event: "step", id: "team.create", state: "running" },
      { event: "step", id: "team.create", state: "done" },
      { event: "done", ok: true },
    ]);
  });

  test("plan lists every step, including the ones before --from", async () => {
    const { ctx, events } = testCtx();
    const steps: StepDef[] = [fakeStep("home.init", { state: "done" }), fakeStep("home.restore", { state: "done" })];

    await runApplyWith(steps, ctx, { from: "home.restore" });

    expect(events[0]).toEqual({
      event: "plan",
      steps: [
        { id: "home.init", title: "home.init", kind: "rt" },
        { id: "home.restore", title: "home.restore", kind: "rt" },
      ],
    });
  });

  test("an unknown --from id falls back to running the whole list from the start", async () => {
    const { ctx, events } = testCtx();
    const steps: StepDef[] = [fakeStep("home.init", { state: "done" })];

    const result = await runApplyWith(steps, ctx, { from: "verify" });

    expect(result).toEqual({ ok: true });
    expect(events).toContainEqual({ event: "step", id: "home.init", state: "running" });
  });
});

describe("runApplyWith — need-bearing steps", () => {
  test("an 'app' kind step succeeds via ctx.need resolving done", async () => {
    const { ctx, events } = testCtx({
      async need(id, request) {
        events.push({ event: "need", id, request });
        return { ok: true, detail: "registered" };
      },
    });
    const step: StepDef = {
      id: "services.register",
      title: "Register background services",
      kind: "app",
      applies: () => true,
      async run(c) {
        const reply = await c.need("services.register", { type: "app-register-services", plists: ["com.mattstack.daemon.plist"] });
        if (reply === "timeout" || reply === "app-gone" || reply === "no-app") return { state: "failed", detail: String(reply) };
        return reply.ok ? { state: "done", detail: reply.detail } : { state: "failed", detail: reply.detail ?? "denied" };
      },
    };

    const result = await runApplyWith([step], ctx, {});

    expect(result).toEqual({ ok: true });
    expect(events).toContainEqual({
      event: "need",
      id: "services.register",
      request: { type: "app-register-services", plists: ["com.mattstack.daemon.plist"] },
    });
    expect(events).toContainEqual({ event: "step", id: "services.register", state: "done", detail: "registered" });
  });

  test("a 'privileged' kind step fails via ctx.need resolving failed", async () => {
    const { ctx, events } = testCtx({
      async need(id, request) {
        events.push({ event: "need", id, request });
        return { ok: false, detail: "denied" };
      },
    });
    const step: StepDef = {
      id: "proxy.install",
      title: "Install the local proxy",
      kind: "privileged",
      applies: () => true,
      async run(c) {
        const reply = await c.need("proxy.install", { type: "app-privileged", op: "proxy-install" });
        if (reply === "timeout" || reply === "app-gone" || reply === "no-app") return { state: "failed", detail: String(reply) };
        return reply.ok ? { state: "done", detail: reply.detail } : { state: "failed", detail: reply.detail ?? "denied" };
      },
    };

    const result = await runApplyWith([step], ctx, {});

    expect(result).toEqual({ ok: false, failedStep: "proxy.install" });
    expect(events).toContainEqual({
      event: "need",
      id: "proxy.install",
      request: { type: "app-privileged", op: "proxy-install" },
    });
    expect(events.at(-2)).toEqual({ event: "step", id: "proxy.install", state: "failed", detail: "denied" });
  });
});

describe("STEPS registry", () => {
  test("has exactly one def per STEP_IDS entry, in contract order", () => {
    expect(STEPS.map((s) => s.id)).toEqual([...STEP_IDS]);
  });

  test("every step applies unconditionally and stubs skipped/not implemented", async () => {
    const { ctx } = testCtx();
    for (const step of STEPS) {
      expect(step.applies(ctx)).toBe(true);
      expect(await step.run(ctx)).toEqual({ state: "skipped", detail: "not implemented" });
    }
  });

  test("services.register is kind app, proxy.install is kind privileged, everything else is kind rt", () => {
    for (const step of STEPS) {
      if (step.id === "services.register") expect(step.kind).toBe("app");
      else if (step.id === "proxy.install") expect(step.kind).toBe("privileged");
      else expect(step.kind).toBe("rt");
    }
  });
});

describe("createApplyContext", () => {
  test("builds a context with no team when no intent and no cloned teams", async () => {
    const p = fakeProbes();
    const events: ApplyEvent[] = [];
    const ctx = await createApplyContext({
      probes: p,
      emit: (ev) => events.push(ev),
      secrets: fakeSecrets,
      relay: fakeRelay,
      flags: { nonInteractive: false, teamOfOne: false, ci: false },
    });

    expect(ctx.intent).toBeNull();
    expect(ctx.team).toEqual({ slug: "", name: "", mode: "none" });
    expect(ctx.snapshot).toBeNull();
    expect(ctx.reqs).toEqual([]);
    expect(ctx.appPath).toBeNull();
    expect(ctx.nonInteractive).toBe(false);
    expect(ctx.ci).toBe(false);
  });

  test("ctx.log emits a log event under the given step id", async () => {
    const p = fakeProbes();
    const events: ApplyEvent[] = [];
    const ctx = await createApplyContext({
      probes: p,
      emit: (ev) => events.push(ev),
      secrets: fakeSecrets,
      relay: fakeRelay,
      flags: { nonInteractive: false, teamOfOne: false, ci: false },
    });

    ctx.log("home.init", "gh repo create m4ttheweric/mattstack-home --private");

    expect(events).toEqual([{ event: "log", id: "home.init", line: "gh repo create m4ttheweric/mattstack-home --private" }]);
  });

  test("ctx.need short-circuits to no-app when nonInteractive and the tray socket is unreachable", async () => {
    const p = fakeProbes(); // default tray always returns status 0 (unreachable)
    const events: ApplyEvent[] = [];
    const ctx = await createApplyContext({
      probes: p,
      emit: (ev) => events.push(ev),
      secrets: fakeSecrets,
      relay: fakeRelay,
      flags: { nonInteractive: true, teamOfOne: false, ci: false },
    });

    const result = await ctx.need("services.register", { type: "app-register-services", plists: [] });

    expect(result).toBe("no-app");
    expect(events).toContainEqual({ event: "need", id: "services.register", request: { type: "app-register-services", plists: [] } });
  });
});
