import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../state/index.ts";
import { createChatHandlers } from "../daemon/handlers/chat.ts";
import { drainNotifications, notify, peekNotifications } from "../notifier.ts";
import { setSetting } from "../settings/write.ts";

const push = () => {
  setSetting("chat.push.provider", "ntfy", "user");
  setSetting("chat.push.target", "https://ntfy.sh/x", "user");
};

beforeEach(() => {
  // bun:test's spyOn reuses the existing spy (and its accumulated call
  // history) when the target is already mocked, so a fetch spy installed in
  // an earlier test would otherwise leak calls into this test's assertions.
  // Restoring the real fetch first forces the next spyOn() to start clean.
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
  drainNotifications();
  // Settings need the same reset the queue gets. Without clearing the
  // provider, test 1 passes only because it happens to run before the first
  // push() call, and reordering the file breaks it.
  setSetting("chat.push.provider", "", "user");
  setSetting("chat.push.target", "", "user");
});

afterEach(() => {
  // Both halves of this cleanup leak into the NEXT test file in the same bun
  // process (bun runs all files in one process, sorted by path, so this file
  // runs before lib/daemon/__tests__/chat-handlers.test.ts). The fetch spy,
  // left installed, would break probes.test.ts's real-fetch assertions. And
  // the push settings, left set, would make chat-handlers.test.ts's @matt
  // tests — which install no fetch spy — fire a REAL POST to ntfy.sh.
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
  setSetting("chat.push.provider", "", "user");
  setSetting("chat.push.target", "", "user");
});

// Every spy carries a mock implementation. A bare spyOn(globalThis, "fetch")
// CALLS THROUGH, so the moment the category filter regresses, the last test
// makes a real network POST to ntfy.sh from the suite.
const inert = () => spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

test("no provider configured sends nothing anywhere", async () => {
  const fetchSpy = inert();
  notify("#r", "agent: @matt hi", undefined, "chat_mention");
  await Bun.sleep(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a chat_mention notification is pushed when a provider is configured", async () => {
  push();
  const fetchSpy = inert();
  notify("#r", "agent: @matt hi", undefined, "chat_mention");
  await Bun.sleep(0);
  expect(fetchSpy).toHaveBeenCalledWith("https://ntfy.sh/x", expect.objectContaining({ method: "POST" }));
});

test("a failing push does not fail the notification", async () => {
  push();
  spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
  expect(() => notify("#r", "agent: @matt hi", undefined, "chat_mention")).not.toThrow();
  await Bun.sleep(0);
  expect(peekNotifications()).toHaveLength(1);
});

test("a non-chat notification is never pushed", async () => {
  push();
  const fetchSpy = inert();
  notify("MR ready", "something else", undefined, "general");
  await Bun.sleep(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a real @matt mention through chat:post reaches the push provider", async () => {
  push();
  const fetchSpy = inert();
  const h = createChatHandlers({
    db: openStateDb(join(tmpdir(), `chat-push-${process.pid}.db`)),
    emitEvent: () => 0,
  });
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt ok to force-release?" });
  await Bun.sleep(0);
  expect(fetchSpy).toHaveBeenCalledWith("https://ntfy.sh/x", expect.objectContaining({ method: "POST" }));
});
