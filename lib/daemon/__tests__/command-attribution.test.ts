import { test, expect } from "bun:test";
import { shortReqId, makeSuppressor } from "../command-attribution.ts";

test("shortReqId is short and unique-ish", () => {
  const a = shortReqId(); const b = shortReqId();
  expect(a).toMatch(/^[a-z0-9]{6}$/);
  expect(a).not.toBe(b);
});

test("suppressor logs first, then throttles with a running suppressed count", () => {
  const s = makeSuppressor(60_000);
  expect(s.check("mr:action|boom", 0)).toEqual({ emit: true, suppressed: 0 });      // first: log
  expect(s.check("mr:action|boom", 1_000)).toEqual({ emit: false, suppressed: 1 }); // within window: silent
  expect(s.check("mr:action|boom", 2_000)).toEqual({ emit: false, suppressed: 2 });
  expect(s.check("mr:action|boom", 61_000)).toEqual({ emit: true, suppressed: 2 }); // window elapsed: log with count
  expect(s.check("mr:action|boom", 61_500)).toEqual({ emit: false, suppressed: 1 }); // count resets after an emit
});
