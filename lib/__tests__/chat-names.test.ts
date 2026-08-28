import { describe, expect, test } from "bun:test";
import { AGENT_NAMES, baseOfHandle, pickAgentName } from "../chat-names.ts";

describe("AGENT_NAMES", () => {
  test("every name is a short, bare, valid chat name, and none repeats", () => {
    expect(AGENT_NAMES.length).toBeGreaterThanOrEqual(240);
    expect(new Set(AGENT_NAMES).size).toBe(AGENT_NAMES.length);
    for (const n of AGENT_NAMES) expect(n).toMatch(/^[a-z]{3,6}$/);
  });

  test("the human's own handle is not in the pool", () => {
    expect(AGENT_NAMES).not.toContain("matt");
  });
});

describe("pickAgentName", () => {
  const first = () => 0; // always the first candidate

  test("skips names live sessions hold, whether bare or suffixed", () => {
    expect(pickAgentName([], {}, first)).toBe(AGENT_NAMES[0]!);
    expect(pickAgentName([AGENT_NAMES[0]!], {}, first)).toBe(AGENT_NAMES[1]!);
    expect(pickAgentName([`${AGENT_NAMES[0]}-2`, AGENT_NAMES[1]!], {}, first)).toBe(AGENT_NAMES[2]!);
  });

  test("a never-used name beats every used one, whatever random() says", () => {
    const lastUsed = Object.fromEntries(AGENT_NAMES.slice(1).map((n, i) => [n, 1 + i]));
    expect(pickAgentName([], lastUsed, () => 0.5)).toBe(AGENT_NAMES[0]!);
    expect(pickAgentName([], lastUsed, () => 0.99)).toBe(AGENT_NAMES[0]!);
  });

  test("once every free name has been used, the least recently used wins", () => {
    const lastUsed = Object.fromEntries(AGENT_NAMES.map((n, i) => [n, 1000 + i]));
    lastUsed[AGENT_NAMES[5]!] = 1;
    expect(pickAgentName([], lastUsed, () => 0.5)).toBe(AGENT_NAMES[5]!);
    // the oldest name is held live, so the next oldest is drawn
    expect(pickAgentName([AGENT_NAMES[5]!], lastUsed, () => 0.5)).toBe(AGENT_NAMES[0]!);
  });

  test("ties among equally old names are broken at random", () => {
    const lastUsed = Object.fromEntries(AGENT_NAMES.map((n) => [n, 7]));
    expect(pickAgentName([], lastUsed, () => 0)).toBe(AGENT_NAMES[0]!);
    expect(pickAgentName([], lastUsed, () => 0.999)).toBe(AGENT_NAMES.at(-1)!);
  });

  test("falls back to the whole pool when every name is held", () => {
    expect(AGENT_NAMES).toContain(pickAgentName(AGENT_NAMES, {}, () => 0.5));
  });

  test("a random() of 1 still lands inside the pool", () => {
    expect(AGENT_NAMES).toContain(pickAgentName([], {}, () => 1));
  });
});

test("baseOfHandle strips only a numeric suffix", () => {
  expect(baseOfHandle("fred")).toBe("fred");
  expect(baseOfHandle("fred-2")).toBe("fred");
  expect(baseOfHandle("mr-board")).toBe("mr-board");
});
