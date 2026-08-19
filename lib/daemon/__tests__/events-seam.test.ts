import { describe, test, expect } from "bun:test";
import type { Handler } from "../handlers/types.ts";

describe("handler signal seam", () => {
  test("Handler type admits a (payload, signal) implementation", async () => {
    const h: Handler = async (_payload, signal) => ({ ok: true, aborted: signal?.aborted ?? null });
    const ac = new AbortController();
    expect(await h({}, ac.signal)).toEqual({ ok: true, aborted: false });
    expect(await h({})).toEqual({ ok: true, aborted: null });
  });
});
