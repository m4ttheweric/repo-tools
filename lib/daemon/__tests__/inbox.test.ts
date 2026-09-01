import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_TIMEOUT_MS, deliverToInbox, deliveryLabel, renderDeliveries, wrapCrossSession } from "../inbox.ts";

test("the default push timeout is 3000ms, not the original 1000ms that made one slow recipient look like a dropped push", () => {
  expect(DEFAULT_TIMEOUT_MS).toBe(3000);
});

test("renderDeliveries formats room and dm lines, each carrying the id rt chat ack takes", () => {
  expect(renderDeliveries([
    { room: "general", dm: false, handle: "max", body: "hello", id: 12 },
    { room: "dm-1", dm: true, handle: "eli", body: "hi", id: 13 },
  ])).toBe("[#general] max #12: hello\n[dm] eli #13: hi");
});

test("wrapCrossSession produces the exact envelope Claude Code collapses on", () => {
  expect(wrapCrossSession("max (#general)", "[#general] max: hello")).toBe(
    '<cross-session-message from-name="max (#general)">\n[#general] max: hello\n</cross-session-message>',
  );
});

test("wrapCrossSession neutralizes attribute-breaking characters in the label", () => {
  const wrapped = wrapCrossSession('x" bad="<y>', "body");
  expect(wrapped.startsWith("<cross-session-message from-name=\"x' bad='")).toBe(true);
  expect(wrapped).not.toContain('""');
  expect(wrapped.split("\n")[0]).not.toContain("<y>");
});

test("deliveryLabel names the sender for one message and counts a batch", () => {
  expect(deliveryLabel([{ room: "general", dm: false, handle: "max" }])).toBe("max (#general)");
  expect(deliveryLabel([{ room: "dm-1", dm: true, handle: "eli" }])).toBe("eli (dm)");
  expect(deliveryLabel([
    { room: "general", dm: false, handle: "max" },
    { room: "general", dm: false, handle: "eli" },
    { room: "general", dm: false, handle: "kai" },
  ])).toBe("rt chat (3 messages)");
});

test("deliverToInbox writes exactly one msgV:1 user frame line", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "inbox-")), "s.sock");
  const lines: string[] = [];
  const server = Bun.listen({ unix: path, socket: { data(_s, d) { lines.push(d.toString()); } } });
  const res = await deliverToInbox(path, "[#general] max: hello");
  await Bun.sleep(30);
  server.stop(true);
  expect(res.ok).toBe(true);
  const frame = JSON.parse(lines.join("").trim());
  expect(frame.msgV).toBe(1);
  expect(frame.type).toBe("user");
  expect(frame.priority).toBe("next");
  expect(frame.message).toEqual({ role: "user", content: "[#general] max: hello" });
  expect(typeof frame.msg_id).toBe("string");
});

test("deliverToInbox reports failure on a dead socket", async () => {
  const res = await deliverToInbox(join(tmpdir(), "nope.sock"), "x", { timeoutMs: 200 });
  expect(res.ok).toBe(false);
});

test("no frame is written after a failed connect has settled", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "inbox-late-")), "s.sock");
  const res = await deliverToInbox(path, "late", { timeoutMs: 50 });
  expect(res.ok).toBe(false);

  const lines: string[] = [];
  const server = Bun.listen({ unix: path, socket: { data(_s, d) { lines.push(d.toString()); } } });
  await Bun.sleep(100);
  server.stop(true);
  expect(lines.join("")).toBe("");
});
