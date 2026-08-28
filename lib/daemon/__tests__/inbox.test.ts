import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deliverToInbox, renderDeliveries } from "../inbox.ts";

test("renderDeliveries formats room and dm lines", () => {
  expect(renderDeliveries([
    { room: "general", dm: false, handle: "max", body: "hello" },
    { room: "dm-1", dm: true, handle: "eli", body: "hi" },
  ])).toBe("[#general] max: hello\n[dm] eli: hi");
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

test("deliverToInbox never writes once it has already reported failure", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "inbox-late-")), "s.sock");
  const res = await deliverToInbox(path, "late", { timeoutMs: 50 });
  expect(res.ok).toBe(false);

  const lines: string[] = [];
  const server = Bun.listen({ unix: path, socket: { data(_s, d) { lines.push(d.toString()); } } });
  await Bun.sleep(100);
  server.stop(true);
  expect(lines.join("")).toBe("");
});
