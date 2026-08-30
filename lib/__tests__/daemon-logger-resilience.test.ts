import { test, expect } from "bun:test";
import { createDaemonLogger } from "../daemon-logger.ts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("a stream write error does not throw out of log.info and flips loggerDegraded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "logres-"));
  const handle = await createDaemonLogger({ logDir: dir, level: "info" });
  // Simulate a write failure by emitting 'error' on the underlying stream.
  handle.stream.emit("error", Object.assign(new Error("no space"), { code: "ENOSPC" }));
  expect(() => handle.logger.info("after enospc")).not.toThrow();
  expect(handle.loggerDegraded()).toBe(true);
});
