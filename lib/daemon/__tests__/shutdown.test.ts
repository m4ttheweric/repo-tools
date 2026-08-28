import { expect, test } from "bun:test";
import type { Logger } from "pino";
import { makeGracefulExit } from "../shutdown.ts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

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
