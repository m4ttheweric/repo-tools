import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { HERDR_UNAVAILABLE, herdrAvailable, herdrRequest, waitTimeout } from "../client.ts";
import { fakeHerdr, HerdrFakeError } from "./fake-herdr.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops.length = 0;
});

test("a success reply comes back as ok with the result object", async () => {
  const { sock, seen, stop } = fakeHerdr((method) => {
    if (method === "pane.list") return { type: "pane_list", panes: [{ pane_id: "w1:p1" }] };
    return new HerdrFakeError("invalid_request", "nope");
  });
  stops.push(stop);
  const res = await herdrRequest<{ type: string; panes: unknown[] }>("pane.list", {}, { sockPath: sock });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.result.panes).toHaveLength(1);
  expect(seen[0]).toEqual({ method: "pane.list", params: {} });
});

test("an error reply comes back as ok:false with herdr's code and message", async () => {
  const { sock, stop } = fakeHerdr(() => new HerdrFakeError("agent_blocked", "agent w1:p1 is blocked"));
  stops.push(stop);
  const res = await herdrRequest("agent.prompt", { target: "w1:p1", text: "hi" }, { sockPath: sock });
  expect(res).toEqual({ ok: false, code: "agent_blocked", message: "agent w1:p1 is blocked" });
});

test("params travel verbatim, with the request id as a string", async () => {
  const { sock, seen, stop } = fakeHerdr(() => ({ type: "ok" }));
  stops.push(stop);
  await herdrRequest("pane.send_input", { pane_id: "w1:p1", text: "ls", keys: ["enter"] }, { sockPath: sock });
  expect(seen[0]!.params).toEqual({ pane_id: "w1:p1", text: "ls", keys: ["enter"] });
});

test("a missing socket is herdr unavailable, never a throw", async () => {
  const res = await herdrRequest("pane.list", {}, { sockPath: join(tmpdir(), "no-such-herdr.sock") });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.message.startsWith(HERDR_UNAVAILABLE)).toBe(true);
});

test("a reply slower than timeoutMs is a timeout", async () => {
  const { sock, stop } = fakeHerdr(async () => {
    await Bun.sleep(400);
    return { type: "ok" };
  });
  stops.push(stop);
  const res = await herdrRequest("agent.wait", { target: "w1:p1" }, { sockPath: sock, timeoutMs: 100 });
  expect(res).toMatchObject({ ok: false, code: "timeout" });
});

test("herdrAvailable probes session.snapshot", async () => {
  const { sock, seen, stop } = fakeHerdr(() => ({ type: "session_snapshot", snapshot: { panes: [], workspaces: [], agents: [], tabs: [], layouts: [], version: "0.8.0", protocol: 19 } }));
  stops.push(stop);
  expect(await herdrAvailable(sock)).toBe(true);
  expect(seen[0]!.method).toBe("session.snapshot");
  expect(await herdrAvailable(join(tmpdir(), "no-such-herdr.sock"))).toBe(false);
});

test("waitTimeout adds the 5s margin herdr needs to answer at its own budget", () => {
  expect(waitTimeout(60_000)).toBe(65_000);
});
