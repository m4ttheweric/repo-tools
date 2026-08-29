import { mkdirSync, writeFileSync } from "fs";
import { expect, test } from "bun:test";
import type { Logger } from "pino";
import { DAEMON_PID_PATH, RT_DIR } from "../../daemon-config.ts";
import { evictStaleDaemon } from "../boot-reconcile.ts";

mkdirSync(RT_DIR, { recursive: true });

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("evictStaleDaemon waits for the old pid to die, escalating to SIGKILL", async () => {
  const child = Bun.spawn({ cmd: ["bash", "-c", "trap '' TERM; sleep 30"] });
  writeFileSync(DAEMON_PID_PATH, String(child.pid));
  const start = Date.now();
  await evictStaleDaemon(silentLog);
  expect(isAlive(child.pid)).toBe(false);
  expect(Date.now() - start).toBeLessThan(5000);
  child.kill();
});
