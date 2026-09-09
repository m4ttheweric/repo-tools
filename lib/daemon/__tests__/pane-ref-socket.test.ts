import { expect, test } from "bun:test";
import { resolvePaneRef } from "../pane-ref-socket.ts";
import { bgSocketPath } from "../bg-service.ts";

test("a bare ref resolves to the visible default (undefined sockPath)", () => {
  expect(resolvePaneRef("w1:p2")).toEqual({ paneId: "w1:p2", sockPath: undefined });
});

test("a bg: ref resolves to the bg socket path with the prefix stripped", () => {
  expect(resolvePaneRef("bg:w1:p2")).toEqual({ paneId: "w1:p2", sockPath: bgSocketPath() });
});
