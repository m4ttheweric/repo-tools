import { afterEach, expect, test } from "bun:test";
import { herdrRequest } from "../../herdr/client.ts";
import { fakeHerdr, HerdrFakeError, type FakeHerdrHandler } from "../../herdr/__tests__/fake-herdr.ts";
import { injectIntoPane } from "../inject.ts";

const stops: Array<() => void> = [];
afterEach(() => { for (const s of stops) s(); stops.length = 0; });

function on(handler: FakeHerdrHandler) {
  const { sock, seen, stop } = fakeHerdr(handler);
  stops.push(stop);
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: sock });
  return { seen, herdr };
}

// agent.get's reply, as chat:invite reads it: result.agent.agent (kind) and result.agent.agent_status.
const agent = (status: string, kind = "claude") => ({ type: "agent_info", agent: { pane_id: "w1:p1", agent: kind, agent_status: status } });

test("an idle pane accepts: prompt sent with a wait, reached working", async () => {
  const { herdr, seen } = on((method, params) => {
    if (method === "agent.get") return agent("idle");
    if (method === "agent.prompt") return { type: "agent_prompted", agent: { ...agent("working").agent, text: params.text } };
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await injectIntoPane({ paneId: "w1:p1", text: "do the thing", herdr });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "accepted" } });
  expect(seen.find((s) => s.method === "agent.prompt")!.params).toEqual({ target: "w1:p1", text: "do the thing", wait: { until: ["working"], timeout_ms: 5000 } });
});

test("a blocked pane is refused, nothing sent", async () => {
  const { herdr, seen } = on((method) => (method === "agent.get" ? agent("blocked") : new HerdrFakeError("invalid_request", method)));
  const res = await injectIntoPane({ paneId: "w1:p1", text: "hi", herdr });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "at a prompt" } });
  expect(seen.map((s) => s.method)).toEqual(["agent.get"]);
});

test("a non-claude pane is refused", async () => {
  const { herdr } = on((method) => (method === "agent.get" ? agent("idle", "codex") : new HerdrFakeError("invalid_request", method)));
  const res = await injectIntoPane({ paneId: "w1:p1", text: "hi", herdr });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "not a claude pane" } });
});

test("a working pane is queued: prompt sent without a wait", async () => {
  const { herdr, seen } = on((method) => {
    if (method === "agent.get") return agent("working");
    if (method === "agent.prompt") return { type: "agent_prompted", agent: agent("working").agent };
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await injectIntoPane({ paneId: "w1:p1", text: "later", herdr });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "queued" } });
  expect(seen.find((s) => s.method === "agent.prompt")!.params).toEqual({ target: "w1:p1", text: "later" });
});

test("a stalled prompt gets one pane.send_keys Enter nudge, then queued", async () => {
  let prompts = 0;
  const { herdr, seen } = on((method) => {
    if (method === "agent.get") return agent("idle");
    if (method === "agent.prompt") { prompts++; return new HerdrFakeError("timeout", "timed out waiting for agent status"); }
    if (method === "pane.send_keys") return { type: "ok" };
    if (method === "agent.wait") return new HerdrFakeError("timeout", "timed out waiting for agent status");
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await injectIntoPane({ paneId: "w1:p1", text: "x", herdr });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "queued" } });
  expect(prompts).toBe(1);
  expect(seen.filter((s) => s.method === "pane.send_keys")).toHaveLength(1);
});

test("the Enter nudge failing unreachable is herdr unavailable, not queued", async () => {
  const { herdr, seen } = on((method) => {
    if (method === "agent.get") return agent("idle");
    if (method === "agent.prompt") return new HerdrFakeError("timeout", "timed out waiting for agent status");
    if (method === "pane.send_keys") return new HerdrFakeError("unreachable", "herdr socket vanished");
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await injectIntoPane({ paneId: "w1:p1", text: "x", herdr });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.startsWith("herdr unavailable")).toBe(true);
  expect(seen.some((s) => s.method === "agent.wait")).toBe(false);
});

test("agent.wait failing unreachable after the nudge is herdr unavailable, not queued", async () => {
  const { herdr, seen } = on((method) => {
    if (method === "agent.get") return agent("idle");
    if (method === "agent.prompt") return new HerdrFakeError("timeout", "timed out waiting for agent status");
    if (method === "pane.send_keys") return { type: "ok" };
    if (method === "agent.wait") return new HerdrFakeError("unreachable", "herdr socket vanished");
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await injectIntoPane({ paneId: "w1:p1", text: "x", herdr });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.startsWith("herdr unavailable")).toBe(true);
  expect(seen.filter((s) => s.method === "pane.send_keys")).toHaveLength(1);
});

test("the caller's own pane is refused before any herdr call", async () => {
  const { herdr, seen } = on(() => new HerdrFakeError("invalid_request", "unreachable in this test"));
  const res = await injectIntoPane({ paneId: "w1:p1", text: "x", callerPane: "w1:p1", herdr });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "that is this pane" } });
  expect(seen).toHaveLength(0);
});

test("multi-line text is delivered verbatim as the prompt", async () => {
  const { herdr, seen } = on((method) =>
    method === "agent.get" ? agent("idle")
    : method === "agent.prompt" ? { type: "agent_prompted", agent: agent("working").agent }
    : new HerdrFakeError("invalid_request", method));
  await injectIntoPane({ paneId: "w1:p1", text: "line one\nline two", herdr });
  expect(seen.find((s) => s.method === "agent.prompt")!.params.text).toBe("line one\nline two");
});

test("a missing socket is herdr unavailable (ok:false)", async () => {
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: "/tmp/absent-herdr-inject.sock" });
  const res = await injectIntoPane({ paneId: "w1:p1", text: "x", herdr });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.startsWith("herdr unavailable")).toBe(true);
});
