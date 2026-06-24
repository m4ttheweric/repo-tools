import { describe, test, expect } from "bun:test";
import { HerdrClient, type HerdrTransport } from "../client.ts";

function fakeTransport(responder: (method: string, params: any) => any): HerdrTransport {
  return {
    async request(line: string): Promise<string> {
      const req = JSON.parse(line);
      const out = responder(req.method, req.params);
      if (out instanceof Error) return JSON.stringify({ id: req.id, error: { code: "x", message: out.message } });
      return JSON.stringify({ id: req.id, result: out });
    },
  };
}

describe("HerdrClient.call", () => {
  test("returns result on success", async () => {
    const c = new HerdrClient({ transport: fakeTransport(() => ({ workspaces: [] })) });
    expect(await c.call("workspace.list")).toEqual({ workspaces: [] });
  });
  test("throws the error message on an error response", async () => {
    const c = new HerdrClient({ transport: fakeTransport(() => new Error("workspace_not_found")) });
    await expect(c.call("pane.list", { workspace_id: "wX" })).rejects.toThrow("workspace_not_found");
  });
  test("sends the method + params through", async () => {
    let seen: any = null;
    const c = new HerdrClient({ transport: fakeTransport((m, p) => { seen = { m, p }; return {}; }) });
    await c.call("pane.run", { pane_id: "w9:p1", text: "ls" });
    expect(seen).toEqual({ m: "pane.run", p: { pane_id: "w9:p1", text: "ls" } });
  });
});

describe("HerdrClient.available", () => {
  test("true when ping resolves", async () => {
    const c = new HerdrClient({ transport: fakeTransport(() => ({ type: "pong" })) });
    expect(await c.available()).toBe(true);
  });
  test("false when the transport throws (socket down)", async () => {
    const c = new HerdrClient({ transport: { request: () => Promise.reject(new Error("ENOENT")) } });
    expect(await c.available()).toBe(false);
  });
});
