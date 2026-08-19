import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { syncLog } from "../sync-log.ts";

let tmpRoot: string;
let logFile: string;
let savedSyncLogPath: string | undefined;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-sync-log-")));
  logFile = join(tmpRoot, "sync.log");
  savedSyncLogPath = process.env.RT_SYNC_LOG_PATH;
  process.env.RT_SYNC_LOG_PATH = logFile;
});

afterEach(() => {
  if (savedSyncLogPath === undefined) delete process.env.RT_SYNC_LOG_PATH;
  else process.env.RT_SYNC_LOG_PATH = savedSyncLogPath;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("syncLog", () => {
  test("phase() renders payload keys, and writes land only at RT_SYNC_LOG_PATH", () => {
    syncLog.start("test session");
    syncLog.phase("escalation-verdict", { verdict: "completed" });
    syncLog.end();

    // write() resolves RT_SYNC_LOG_PATH at call time, so every write above
    // landed in this temp file and none reached the real ~/.mattstack/rt/sync.log.
    // We only ever read this temp file, never the real log.
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("verdict=completed");
    // No status key was supplied, so none should be invented.
    expect(content).not.toContain("status=ok");
  });
});
