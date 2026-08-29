import { test, expect } from "bun:test";
import { runUnits, stopUnits, type DaemonUnit } from "../lifecycle.ts";

const noopLog = { warn() {}, info() {}, error() {} } as any;

test("runUnits starts in order; stopUnits stops in reverse", async () => {
  const order: string[] = [];
  const mk = (n: string): DaemonUnit => ({
    name: n,
    start: () => { order.push(`start:${n}`); },
    stop: () => { order.push(`stop:${n}`); },
  });
  const units = [mk("a"), mk("b"), mk("c")];
  await runUnits(units, noopLog);
  await stopUnits(units, noopLog);
  expect(order).toEqual(["start:a","start:b","start:c","stop:c","stop:b","stop:a"]);
});

test("a start failure stops already-started units in reverse and rethrows", async () => {
  const order: string[] = [];
  const units: DaemonUnit[] = [
    { name: "a", start: () => { order.push("start:a"); }, stop: () => { order.push("stop:a"); } },
    { name: "b", start: () => { throw new Error("boom"); }, stop: () => { order.push("stop:b"); } },
  ];
  await expect(runUnits(units, noopLog)).rejects.toThrow("boom");
  expect(order).toEqual(["start:a","stop:a"]); // b never fully started, a rolled back
});

test("stopUnits swallows a stop throw and continues", async () => {
  const order: string[] = [];
  const units: DaemonUnit[] = [
    { name: "a", start: () => {}, stop: () => { order.push("stop:a"); } },
    { name: "b", start: () => {}, stop: () => { throw new Error("x"); } },
  ];
  await stopUnits(units, noopLog); // must not reject
  expect(order).toEqual(["stop:a"]);
});
