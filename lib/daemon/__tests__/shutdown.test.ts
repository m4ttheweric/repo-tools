import { existsSync, writeFileSync } from "fs";
import { expect, test } from "bun:test";
import type { Logger } from "pino";
import { DAEMON_PID_PATH, DAEMON_SOCK_PATH } from "../../daemon-config.ts";
import { removeRuntimeFiles, makeGracefulExit } from "../shutdown.ts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

test("gracefulExit exits 0 after the shutdown verb, 1 on a bare signal", async () => {
  const exits: number[] = [];
  const exit = (c?: number) => { exits.push(c ?? 0); };
  let viaVerb = false;
  const handlers = makeGracefulExit({ cleanup: () => {}, flushLogs: () => {}, log: silentLog,
    wasVerbShutdown: () => viaVerb, exit, recordCleanExit: () => {} });
  await handlers("SIGTERM");
  expect(exits).toEqual([1]);
  viaVerb = true;
  await handlers("SIGTERM");
  expect(exits).toEqual([1, 0]);
});

test("gracefulExit awaits cleanup before flushing and exiting", async () => {
  const order: string[] = [];
  const handlers = makeGracefulExit({
    cleanup: async () => { await Promise.resolve(); order.push("cleanup"); },
    flushLogs: () => { order.push("flush"); },
    log: silentLog,
    wasVerbShutdown: () => false,
    exit: () => { order.push("exit"); },
    recordCleanExit: () => {},
  });
  await handlers("SIGTERM");
  expect(order).toEqual(["cleanup", "flush", "exit"]);
});

test("gracefulExit records the exit kind and code via recordCleanExit", async () => {
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
  await handlers("SIGINT");
  expect(recorded).toEqual([{ kind: "signal", code: 1 }]);
  viaVerb = true;
  await handlers("SIGHUP");
  expect(recorded).toEqual([{ kind: "signal", code: 1 }, { kind: "shutdown", code: 0 }]);
});

test("removeRuntimeFiles does not unlink rt.pid/rt.sock when the pid file belongs to another process", () => {
  writeFileSync(DAEMON_PID_PATH, "999999");
  writeFileSync(DAEMON_SOCK_PATH, "");
  removeRuntimeFiles({ pid: process.pid, log: silentLog });
  expect(existsSync(DAEMON_PID_PATH)).toBe(true);
  expect(existsSync(DAEMON_SOCK_PATH)).toBe(true);
});

test("removeRuntimeFiles unlinks when the pid file is ours", () => {
  writeFileSync(DAEMON_PID_PATH, String(process.pid));
  writeFileSync(DAEMON_SOCK_PATH, "");
  removeRuntimeFiles({ pid: process.pid, log: silentLog });
  expect(existsSync(DAEMON_PID_PATH)).toBe(false);
  expect(existsSync(DAEMON_SOCK_PATH)).toBe(false);
});
