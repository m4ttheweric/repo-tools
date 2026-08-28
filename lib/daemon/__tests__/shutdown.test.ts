import { existsSync, writeFileSync } from "fs";
import { expect, test } from "bun:test";
import type { Logger } from "pino";
import { DAEMON_PID_PATH, DAEMON_SOCK_PATH } from "../../daemon-config.ts";
import { createCleanup, makeGracefulExit } from "../shutdown.ts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

const cleanupDeps = {
  servers: {},
  hooksGuard: { closeAll: () => {} } as any,
  log: silentLog,
};

test("gracefulExit exits 0 after the shutdown verb, 1 on a bare signal", () => {
  const exits: number[] = [];
  const exit = (c?: number) => { exits.push(c ?? 0); };
  let viaVerb = false;
  const handlers = makeGracefulExit({ cleanup: () => {}, flushLogs: () => {}, log: silentLog,
    wasVerbShutdown: () => viaVerb, exit, recordCleanExit: () => {} });
  handlers("SIGTERM");
  expect(exits).toEqual([1]);
  viaVerb = true;
  handlers("SIGTERM");
  expect(exits).toEqual([1, 0]);
});

test("gracefulExit records the exit kind and code via recordCleanExit", () => {
  const recorded: Array<{ kind: string; code: number }> = [];
  let viaVerb = false;
  const handlers = makeGracefulExit({
    cleanup: () => {},
    flushLogs: () => {},
    log: silentLog,
    wasVerbShutdown: () => viaVerb,
    exit: () => {},
    recordCleanExit: (kind, code) => { recorded.push({ kind, code }); },
  });
  handlers("SIGINT");
  expect(recorded).toEqual([{ kind: "signal", code: 1 }]);
  viaVerb = true;
  handlers("SIGHUP");
  expect(recorded).toEqual([{ kind: "signal", code: 1 }, { kind: "shutdown", code: 0 }]);
});

test("cleanup does not unlink rt.pid/rt.sock when the pid file belongs to another process", () => {
  writeFileSync(DAEMON_PID_PATH, "999999");
  writeFileSync(DAEMON_SOCK_PATH, "");
  createCleanup({ ...cleanupDeps, pid: process.pid })();
  expect(existsSync(DAEMON_PID_PATH)).toBe(true);
  expect(existsSync(DAEMON_SOCK_PATH)).toBe(true);
});

test("cleanup unlinks when the pid file is ours", () => {
  writeFileSync(DAEMON_PID_PATH, String(process.pid));
  writeFileSync(DAEMON_SOCK_PATH, "");
  createCleanup({ ...cleanupDeps, pid: process.pid })();
  expect(existsSync(DAEMON_PID_PATH)).toBe(false);
  expect(existsSync(DAEMON_SOCK_PATH)).toBe(false);
});
