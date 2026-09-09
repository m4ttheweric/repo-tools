import { expect, test } from "bun:test";
import { createEscapeInjector } from "../gate-escape.ts";
import { bgSocketPath } from "../bg-service.ts";
import type { herdrRequest } from "../../herdr/client.ts";

function fakeHerdrRecording(seen: Array<{ method: string; params: unknown; sockPath: string | undefined }>): typeof herdrRequest {
  return (async (method: string, params: unknown, o?: { sockPath?: string }) => {
    seen.push({ method, params, sockPath: o?.sockPath });
    return { ok: true, result: {} };
  }) as typeof herdrRequest;
}

test("a bare ref sends escape with sockPath undefined (the visible default)", async () => {
  const seen: Array<{ method: string; params: unknown; sockPath: string | undefined }> = [];
  const injector = createEscapeInjector(fakeHerdrRecording(seen));
  const res = await injector("w1:p2");
  expect(res).toEqual({ ok: true });
  expect(seen).toEqual([{ method: "pane.send_keys", params: { pane_id: "w1:p2", keys: ["escape"] }, sockPath: undefined }]);
});

test("a bg: ref resolves to the bare pane id on the bg socket", async () => {
  const seen: Array<{ method: string; params: unknown; sockPath: string | undefined }> = [];
  const injector = createEscapeInjector(fakeHerdrRecording(seen));
  const res = await injector("bg:w1:p2");
  expect(res).toEqual({ ok: true });
  expect(seen).toEqual([{ method: "pane.send_keys", params: { pane_id: "w1:p2", keys: ["escape"] }, sockPath: bgSocketPath() }]);
});

test("a herdr error surfaces as ok:false with code and message", async () => {
  const herdr: typeof herdrRequest = (async () => ({ ok: false, code: "pane_not_found", message: "no such pane" })) as typeof herdrRequest;
  const injector = createEscapeInjector(herdr);
  const res = await injector("bg:w1:p2");
  expect(res).toEqual({ ok: false, error: "pane_not_found: no such pane" });
});
