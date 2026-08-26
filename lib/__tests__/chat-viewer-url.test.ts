import { expect, test } from "bun:test";
import { chatViewerUrl } from "../chat-viewer-url.ts";

test("no base, no link", () => {
  expect(chatViewerUrl(undefined, "build")).toBeUndefined();
  expect(chatViewerUrl("", "build", 4)).toBeUndefined();
});

test("room link, message anchor, trailing slash trimmed", () => {
  expect(chatViewerUrl("https://chat.example/", "build")).toBe("https://chat.example/r/build");
  expect(chatViewerUrl("https://chat.example", "build", 412)).toBe("https://chat.example/r/build#m-412");
});

test("a DM room's hashed name survives as one path segment", () => {
  expect(chatViewerUrl("https://chat.example", "dm-abc123", 1)).toBe("https://chat.example/r/dm-abc123#m-1");
});
