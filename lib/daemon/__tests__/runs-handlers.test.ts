import { afterEach, describe, expect, test } from "bun:test";
import { createRunsHandlers } from "../handlers/runs.ts";
import { root, seedRun } from "../../runs/__tests__/fixtures.ts";

afterEach(() => { delete process.env.RT_RUNS_ROOT; });

const log = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } as any;
const noEmit = () => {};

describe("runs handlers", () => {
  test("runs:list scopes by repo; runs:get resolves with and without repo", async () => {
    const dir = root();
    seedRun(dir, "remote:alpha", "20260821-010101-aaaa", 1000);
    const h = createRunsHandlers({ log } as any, noEmit);
    const listHandler = h["runs:list"] as any;
    const getHandler = h["runs:get"] as any;
    const list = await listHandler({ repo: "remote:alpha" });
    expect(list.ok).toBe(true);
    expect((list as any).data.runs).toHaveLength(1);
    const byBoth = await getHandler({ repo: "remote:alpha", runId: "20260821-010101-aaaa" });
    expect((byBoth as any).data.run.repo).toBe("remote:alpha");
    const byId = await getHandler({ runId: "20260821-010101-aaaa" });
    expect((byId as any).data.run.repo).toBe("remote:alpha");
    const missing = await getHandler({ runId: "nope" });
    expect(missing.ok).toBe(false);
  });

  test("runs:get without runId is a validation error", async () => {
    const h = createRunsHandlers({ log } as any, noEmit);
    const getHandler = h["runs:get"] as any;
    const r = await getHandler({} as any);
    expect(r.ok).toBe(false);
  });

  test("runs:abandon refuses a run that already ended, and emits nothing", async () => {
    const dir = root();
    seedRun(dir, "remote:acme", "20260822-150000-ffff", 1000, 2, { status: "done" });
    const emitted: string[] = [];
    const handlers = createRunsHandlers({ log } as any, (topic) => { emitted.push(topic); });

    const res = await handlers["runs:abandon"]({ runId: "20260822-150000-ffff", repo: "remote:acme" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already");
    // A refusal must not announce a change that did not happen.
    expect(emitted).toEqual([]);
  });

  test("runs:abandon emits run-updated on success", async () => {
    const dir = root();
    seedRun(dir, "remote:acme", "20260822-150001-gggg", 1000, 2, { status: "running" });
    const emitted: { topic: string; payload: any }[] = [];
    const handlers = createRunsHandlers({ log } as any, (topic, payload) => { emitted.push({ topic, payload }); });

    const res = await handlers["runs:abandon"]({ runId: "20260822-150001-gggg", repo: "remote:acme" });

    expect(res.ok).toBe(true);
    expect(emitted[0]!.topic).toBe("run-updated");
    expect(emitted[0]!.payload).toMatchObject({ repo: "remote:acme", kind: "abandoned" });
  });

  test("a bare legacy repo filter resolves nothing rather than name-matching, never crashes", async () => {
    const dir = root();
    seedRun(dir, "remote:alpha", "20260821-010101-aaaa", 1000);
    const h = createRunsHandlers({ log } as any, noEmit);

    const list = await (h["runs:list"] as any)({ repo: "alpha" });
    expect(list).toEqual({ ok: true, data: { runs: [] } });

    const get = await (h["runs:get"] as any)({ repo: "alpha", runId: "20260821-010101-aaaa" });
    expect(get).toEqual({ ok: false, error: "run not found" });

    const abandon = await (h["runs:abandon"] as any)({ repo: "alpha", runId: "20260821-010101-aaaa" });
    expect(abandon).toEqual({ ok: false, error: "run not found" });
  });
});
