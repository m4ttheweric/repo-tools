import { describe, expect, test } from "bun:test";
import { AGENT_NAMES, baseOfHandle, pickAgentName } from "../chat-names.ts";

describe("AGENT_NAMES", () => {
  test("every name is a short, bare, valid chat name, and none repeats", () => {
    expect(AGENT_NAMES.length).toBeGreaterThanOrEqual(80);
    expect(new Set(AGENT_NAMES).size).toBe(AGENT_NAMES.length);
    for (const n of AGENT_NAMES) expect(n).toMatch(/^[a-z]{3,6}$/);
  });

  test("the human's own handle is not in the pool", () => {
    expect(AGENT_NAMES).not.toContain("matt");
  });
});

describe("pickAgentName", () => {
  test("skips names live sessions hold, whether bare or suffixed", () => {
    const first = () => 0; // always the first free name
    expect(pickAgentName([], first)).toBe(AGENT_NAMES[0]!);
    expect(pickAgentName([AGENT_NAMES[0]!], first)).toBe(AGENT_NAMES[1]!);
    expect(pickAgentName([`${AGENT_NAMES[0]}-2`, AGENT_NAMES[1]!], first)).toBe(AGENT_NAMES[2]!);
  });

  test("falls back to the whole pool when every name is held", () => {
    expect(AGENT_NAMES).toContain(pickAgentName(AGENT_NAMES, () => 0.5));
  });

  test("a random() of 1 still lands inside the pool", () => {
    expect(AGENT_NAMES).toContain(pickAgentName([], () => 1));
  });
});

test("baseOfHandle strips only a numeric suffix", () => {
  expect(baseOfHandle("fred-2")).toBe("fred");
  expect(baseOfHandle("fred")).toBe("fred");
  expect(baseOfHandle("mary-anne")).toBe("mary-anne");
});
