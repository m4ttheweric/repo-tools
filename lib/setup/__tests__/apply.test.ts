import { describe, expect, test } from "bun:test";
import type { SecretsSeams } from "../../secrets/store.ts";
import type { RelayClient } from "../../team/relay-client.ts";
import type { ApplyContext, StepDef, StepOutcome } from "../apply.ts";
import { createApplyContext, outcomeFromNeed, runApplyWith } from "../apply.ts";
import { createNdjsonEmitter, type Emit } from "../emit.ts";
import type { ApplyEvent, StepId } from "../contract.ts";
import { STEP_IDS } from "../contract.ts";
import { UserActionableError } from "../errors.ts";
import type { Probes } from "../probes.ts";
import { STEPS } from "../steps/index.ts";
import { fakeProbes, fakeTray } from "./fakes.ts";

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

const fakeTeamSecrets = (): SecretsSeams => fakeSecrets;

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
  const emit: Emit = overrides.emit ?? ((ev) => events.push(ev));
  const ctx: ApplyContext = {
    p,
    emit,
    log(id, line) {
      emit({ event: "log", id, line });
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
    teamSecrets: fakeTeamSecrets,
    relay: fakeRelay,
    secretPresence: { has: async () => null },
    redact: () => {},
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
  return {
    id,
    title: id,
    kind: "rt",
    applies: () => true,
    run: async () => {
      throw err;
    },
  };
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
      {
        event: "plan",
        steps: [
          { id: "home.init", title: "home.init", kind: "rt" },
          { id: "home.restore", title: "home.restore", kind: "rt" },
          { id: "team.create", title: "team.create", kind: "rt" },
        ],
      },
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

  test("lastApplyAt is written even on a run that fails partway through", async () => {
    const { ctx } = testCtx();
    const steps: StepDef[] = [fakeStep("home.init", { state: "done" }), fakeStep("home.restore", { state: "failed", detail: "boom" })];

    await runApplyWith(steps, ctx, {});

    const state = JSON.parse((ctx.p as ReturnType<typeof fakeProbes>).readFile("/fake-home/.mattstack/rt/setup-state.json")!);
    expect(state.lastApplyAt).toBe(ctx.p.now().toISOString());
  });
});

describe("runApplyWith — a state-write failure never suppresses the terminal done event", () => {
  test("writeFile throwing during post-run persistence still yields exactly one done event", async () => {
    const { ctx, events } = testCtx();
    const throwingP: Probes = {
      ...ctx.p,
      writeFile() {
        throw new Error("disk full");
      },
    };
    const brokenCtx: ApplyContext = { ...ctx, p: throwingP };

    const result = await runApplyWith([fakeStep("home.init", { state: "done" })], brokenCtx, {});

    expect(result).toEqual({ ok: true });
    const doneEvents = events.filter((e) => e.event === "done");
    expect(doneEvents).toEqual([{ event: "done", ok: true }]);
    expect(events.some((e) => e.event === "log" && e.id === "home.init" && e.line.includes("disk full"))).toBe(true);
  });

  test("a throw during persistence after a failing step still yields ok:false and one done event", async () => {
    const { ctx, events } = testCtx();
    const throwingP: Probes = {
      ...ctx.p,
      writeFile() {
        throw new Error("disk full");
      },
    };
    const brokenCtx: ApplyContext = { ...ctx, p: throwingP };
    const steps: StepDef[] = [fakeStep("home.init", { state: "failed", detail: "nope" })];

    const result = await runApplyWith(steps, brokenCtx, {});

    expect(result).toEqual({ ok: false, failedStep: "home.init" });
    const doneEvents = events.filter((e) => e.event === "done");
    expect(doneEvents).toEqual([{ event: "done", ok: false, failedStep: "home.init" }]);
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

  test("a step throwing a plain Error emits a failed step + exactly one done, then rethrows", async () => {
    const { ctx, events } = testCtx();
    const boom = new Error("unexpected");
    const steps: StepDef[] = [throwingStep("home.init", boom)];

    await expect(runApplyWith(steps, ctx, {})).rejects.toBe(boom);
    expect(events.at(-2)).toEqual({ event: "step", id: "home.init", state: "failed", detail: "bug: unexpected" });
    expect(events.at(-1)).toEqual({ event: "done", ok: false, failedStep: "home.init" });
    expect(events.filter((e) => e.event === "done")).toHaveLength(1);
  });

  test("a step throwing a falsy non-Error value (undefined) still rethrows rather than being swallowed", async () => {
    const { ctx, events } = testCtx();
    const steps: StepDef[] = [throwingStep("home.init", undefined)];

    let caught: unknown = "not-thrown";
    let threw = false;
    try {
      await runApplyWith(steps, ctx, {});
    } catch (err) {
      threw = true;
      caught = err;
    }

    expect(threw).toBe(true);
    expect(caught).toBeUndefined();
    expect(events.at(-2)).toEqual({ event: "step", id: "home.init", state: "failed", detail: "bug: undefined" });
    expect(events.filter((e) => e.event === "done")).toHaveLength(1);
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
  test("resumes at the named step; earlier steps get NO step event and never run", async () => {
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
      {
        event: "plan",
        steps: [
          { id: "home.init", title: "home.init", kind: "rt" },
          { id: "home.restore", title: "home.restore", kind: "rt" },
          { id: "team.create", title: "team.create", kind: "rt" },
        ],
      },
      { event: "step", id: "home.restore", state: "running" },
      { event: "step", id: "home.restore", state: "done" },
      { event: "step", id: "team.create", state: "running" },
      { event: "step", id: "team.create", state: "done" },
      { event: "done", ok: true },
    ]);
    // Never a `step` event for home.init at all — the shipped app preserves
    // a retried run's earlier `done` rows, and a `skipped` event here would
    // overwrite one.
    expect(events.some((e) => e.event === "step" && e.id === "home.init")).toBe(false);
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

  test("an unknown --from id is a user-actionable exit-2 error, never a silent full re-run", async () => {
    const { ctx, events } = testCtx();
    let ran = false;
    const steps: StepDef[] = [
      fakeStep("home.init", async () => {
        ran = true;
        return { state: "done" };
      }),
    ];

    const err = await runApplyWith(steps, ctx, { from: "not-a-real-step-id" as StepId }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UserActionableError);
    expect((err as UserActionableError).message).toContain("not-a-real-step-id");
    expect(ran).toBe(false);
    expect(events).toEqual([]); // nothing reaches the stream — this fails before `plan`
  });

  test("a valid --from id gated out by applies() resumes at the first applicable step at-or-after it, not a full restart", async () => {
    const { ctx, events } = testCtx();
    const order: string[] = [];
    const steps: StepDef[] = [
      fakeStep("home.init", async () => {
        order.push("home.init");
        return { state: "done" };
      }),
      fakeStep(
        "home.restore",
        async () => {
          order.push("home.restore");
          return { state: "done" };
        },
        { applies: false },
      ),
      fakeStep("team.create", async () => {
        order.push("team.create");
        return { state: "done" };
      }),
    ];

    const result = await runApplyWith(steps, ctx, { from: "home.restore" });

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["team.create"]); // never re-runs home.init
    expect(events[0]).toEqual({
      event: "plan",
      steps: [
        { id: "home.init", title: "home.init", kind: "rt" },
        { id: "team.create", title: "team.create", kind: "rt" },
      ],
    });
  });
});

describe("runApplyWith — need-bearing steps", () => {
  type NeedRequestForTest = Parameters<ApplyContext["need"]>[1];

  function needStep(id: StepId, kind: "app" | "privileged", request: NeedRequestForTest): StepDef {
    return {
      id,
      title: id,
      kind,
      applies: () => true,
      async run(c) {
        const reply = await c.need(id, request);
        return outcomeFromNeed(reply);
      },
    };
  }

  test("an 'app' kind step succeeds via ctx.need resolving done, mapped through outcomeFromNeed", async () => {
    const { ctx, events } = testCtx({
      async need(id, request) {
        events.push({ event: "need", id, request });
        return { ok: true, detail: "registered" };
      },
    });

    const result = await runApplyWith([needStep("services.register", "app", { type: "app-register-services", plists: ["com.mattstack.daemon.plist"] })], ctx, {});

    expect(result).toEqual({ ok: true });
    expect(events).toContainEqual({
      event: "need",
      id: "services.register",
      request: { type: "app-register-services", plists: ["com.mattstack.daemon.plist"] },
    });
    expect(events).toContainEqual({ event: "step", id: "services.register", state: "done", detail: "registered" });
  });

  test("a 'privileged' kind step fails via ctx.need resolving failed, mapped through outcomeFromNeed", async () => {
    const { ctx, events } = testCtx({
      async need(id, request) {
        events.push({ event: "need", id, request });
        return { ok: false, detail: "denied" };
      },
    });

    const result = await runApplyWith([needStep("proxy.install", "privileged", { type: "app-privileged", op: "proxy-install" })], ctx, {});

    expect(result).toEqual({ ok: false, failedStep: "proxy.install" });
    expect(events).toContainEqual({ event: "need", id: "proxy.install", request: { type: "app-privileged", op: "proxy-install" } });
    expect(events.at(-2)).toEqual({ event: "step", id: "proxy.install", state: "failed", detail: "denied" });
  });

  test("outcomeFromNeed never maps timeout or app-gone to a non-failure", () => {
    expect(outcomeFromNeed("timeout")).toEqual({ state: "failed", detail: "timed out waiting for mattstack.app" });
    expect(outcomeFromNeed("app-gone")).toEqual({ state: "failed", detail: "mattstack.app stopped responding" });
    expect(outcomeFromNeed("no-app").state).toBe("skipped");
    expect(outcomeFromNeed({ ok: true, detail: "d" })).toEqual({ state: "done", detail: "d" });
    expect(outcomeFromNeed({ ok: false, detail: "d" })).toEqual({ state: "failed", detail: "d" });
  });
});

describe("STEPS registry", () => {
  test("has exactly one def per STEP_IDS entry, in contract order", () => {
    expect(STEPS.map((s) => s.id)).toEqual([...STEP_IDS]);
  });

  // Every step body is real now — steps-a/b/c.test.ts cover home.init
  // through cron.triage and plugins.install through verify respectively.

  test("services.register is kind app, proxy.install is kind privileged, everything else is kind rt", () => {
    for (const step of STEPS) {
      if (step.id === "services.register") expect(step.kind).toBe("app");
      else if (step.id === "proxy.install") expect(step.kind).toBe("privileged");
      else expect(step.kind).toBe("rt");
    }
  });
});

describe("wire bytes — createNdjsonEmitter", () => {
  test("every line is single-object NDJSON; hostile detail/log content round-trips byte-identical", async () => {
    const lines: string[] = [];
    const hostile = "line1\nline2\r\nx\0y\uD800z\tw";
    const { ctx } = testCtx({ emit: createNdjsonEmitter((line) => lines.push(line)) });
    const step: StepDef = {
      id: "home.init",
      title: "x",
      kind: "rt",
      applies: () => true,
      async run(c) {
        c.log("home.init", hostile);
        return { state: "done", detail: hostile };
      },
    };

    await runApplyWith([step], ctx, {});

    expect(lines.length).toBeGreaterThan(0);
    for (const raw of lines) {
      expect(raw.endsWith("\n")).toBe(true);
      const body = raw.slice(0, -1);
      expect(body.includes("\n")).toBe(false); // no interior newline outside the trailing terminator
      expect(() => JSON.parse(body)).not.toThrow();
    }

    const parsed = lines.map((l) => JSON.parse(l.slice(0, -1)) as ApplyEvent);
    const logEvent = parsed.find((e) => e.event === "log");
    const doneStep = parsed.find((e) => e.event === "step" && e.state === "done");
    expect(logEvent && (logEvent as { line: string }).line).toBe(hostile);
    expect(doneStep && (doneStep as { detail?: string }).detail).toBe(hostile);
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

  test("resolves the team from Probes.home, never from process.env.HOME", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/totally-different-env-home"; // must never be consulted
    try {
      const p = fakeProbes({
        home: "/fake-home",
        files: { "/fake-home/.mattstack/teams/acme/mattstack/settings.team.jsonc": "{}" },
        dirs: { "/fake-home/.mattstack/teams": ["acme"] },
      });
      const ctx = await createApplyContext({
        probes: p,
        emit: () => {},
        secrets: fakeSecrets,
        relay: fakeRelay,
        flags: { nonInteractive: false, teamOfOne: false, ci: false },
      });

      expect(ctx.team.slug).toBe("acme");
    } finally {
      process.env.HOME = originalHome;
    }
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

  test("ctx.need short-circuits to no-app when nonInteractive and the tray socket is unreachable, without stranding a need on the stream", async () => {
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
    expect(events).toEqual([]); // reachability is probed BEFORE emitting `need` — nobody is listening
  });

  test("ctx.need emits the need event and threads the injected clock into awaitNeed's poll loop when reachable", async () => {
    let calls = 0;
    const tray = fakeTray({
      "GET /version": () => ({ status: 200, json: { version: "1.0.0" } }),
      "GET /setup/need/services.register": () => {
        calls += 1;
        return calls < 2 ? { status: 200, json: { state: "pending" } } : { status: 200, json: { state: "done", detail: "registered" } };
      },
    });
    const p = fakeProbes({ tray });
    const events: ApplyEvent[] = [];
    let elapsedMs = 0;
    const ctx = await createApplyContext({
      probes: p,
      emit: (ev) => events.push(ev),
      secrets: fakeSecrets,
      relay: fakeRelay,
      flags: { nonInteractive: false, teamOfOne: false, ci: false },
      needOpts: {
        pollMs: 1_000,
        timeoutMs: 60_000,
        now: () => elapsedMs,
        sleep: async (ms) => {
          elapsedMs += ms;
        },
      },
    });

    const result = await ctx.need("services.register", { type: "app-register-services", plists: ["x"] });

    expect(result).toEqual({ ok: true, detail: "registered" });
    expect(calls).toBe(2);
    expect(events).toContainEqual({ event: "need", id: "services.register", request: { type: "app-register-services", plists: ["x"] } });
  });
});

describe("ApplyContext.redact", () => {
  test("a registered exact value never appears in log lines or step details", async () => {
    const p = fakeProbes();
    const events: ApplyEvent[] = [];
    const ctx = await createApplyContext({
      probes: p,
      emit: (ev) => events.push(ev),
      secrets: fakeSecrets,
      relay: fakeRelay,
      flags: { nonInteractive: false, teamOfOne: false, ci: false },
    });
    const secret = "sekrit-invite-key-value";
    ctx.redact(secret);

    const step: StepDef = {
      id: "team.join",
      title: "Join your team",
      kind: "rt",
      applies: () => true,
      async run(c) {
        c.log("team.join", `posting with key=${secret}`);
        return { state: "done", detail: `used key ${secret}` };
      },
    };

    await runApplyWith([step], ctx, {});

    const serialized = JSON.stringify(events);
    expect(serialized.includes(secret)).toBe(false);
    expect(events).toContainEqual({ event: "log", id: "team.join", line: "posting with key=***" });
    expect(events).toContainEqual({ event: "step", id: "team.join", state: "done", detail: "used key ***" });
  });

  test("createApplyContext seeds the registry with intent.join.keyB64", async () => {
    const rawKey = "raw-invite-key-material";
    const p = fakeProbes({
      files: {
        "/fake-home/.mattstack/rt/setup-intent.json": JSON.stringify({
          v: 1,
          at: "x",
          mode: "join",
          join: {
            id: "invite-id",
            keyB64: rawKey,
            pointer: { v: 1, team: "acme", name: "Acme", remote: "r", owner: "o", forge: "github.com", createdAt: "x" },
          },
        }),
      },
    });
    const events: ApplyEvent[] = [];
    const ctx = await createApplyContext({
      probes: p,
      emit: (ev) => events.push(ev),
      secrets: fakeSecrets,
      relay: fakeRelay,
      flags: { nonInteractive: false, teamOfOne: false, ci: false },
    });

    ctx.log("team.join", `key=${rawKey}`);

    expect(events).toEqual([{ event: "log", id: "team.join", line: "key=***" }]);
  });
});
