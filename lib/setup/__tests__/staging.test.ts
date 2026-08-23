import { describe, test, expect } from "bun:test";
import { fakeProbes } from "./fakes.ts";
import { stagingDir, stageSecret, listStaged, drainStaged } from "../staging.ts";

describe("stagingDir", () => {
  test("joins home/.mattstack/rt/setup-staging", () => {
    expect(stagingDir("/fake-home")).toBe("/fake-home/.mattstack/rt/setup-staging");
  });
});

describe("stageSecret", () => {
  test("writes a new domain file with mode 0o600", () => {
    const p = fakeProbes();
    stageSecret(p, "github", "token", "abc123");
    const path = `${stagingDir(p.home)}/github.json`;
    expect(JSON.parse(p.calls.writes[path]!)).toEqual({ token: "abc123" });
    expect(p.calls.modes[path]).toBe(0o600);
  });

  test("staging the same domain twice merges keys into one file", () => {
    const p = fakeProbes();
    stageSecret(p, "github", "token", "abc123");
    stageSecret(p, "github", "orgId", "42");
    const path = `${stagingDir(p.home)}/github.json`;
    expect(JSON.parse(p.calls.writes[path]!)).toEqual({ token: "abc123", orgId: "42" });
  });
});

describe("listStaged", () => {
  test("lists domain/key pairs across staged files", () => {
    const p = fakeProbes();
    stageSecret(p, "github", "token", "abc123");
    stageSecret(p, "slack", "botToken", "xoxb");
    const staged = listStaged(p).sort((a, b) => a.domain.localeCompare(b.domain));
    expect(staged).toEqual([
      { domain: "github", key: "token" },
      { domain: "slack", key: "botToken" },
    ]);
  });

  test("returns empty when nothing is staged", () => {
    const p = fakeProbes();
    expect(listStaged(p)).toEqual([]);
  });
});

describe("drainStaged", () => {
  test("writes every staged key and removes the domain file once all succeed", async () => {
    const p = fakeProbes();
    stageSecret(p, "github", "token", "abc123");
    stageSecret(p, "github", "orgId", "42");
    const written: [string, string, string][] = [];
    const count = await drainStaged(p, async (domain, key, value) => {
      written.push([domain, key, value]);
    });
    expect(count).toBe(2);
    expect(written).toEqual([
      ["github", "token", "abc123"],
      ["github", "orgId", "42"],
    ]);
    expect(listStaged(p)).toEqual([]);
  });

  test("a write that throws on the second key leaves the domain file in place and rethrows", async () => {
    const p = fakeProbes();
    stageSecret(p, "github", "token", "abc123");
    stageSecret(p, "github", "orgId", "42");
    let calls = 0;
    const write = async () => {
      calls++;
      if (calls === 2) throw new Error("boom");
    };
    await expect(drainStaged(p, write)).rejects.toThrow("boom");
    expect(listStaged(p).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { domain: "github", key: "orgId" },
      { domain: "github", key: "token" },
    ]);
  });
});
