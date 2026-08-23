import { describe, test, expect } from "bun:test";
import { fakeProbes } from "./fakes.ts";
import { intentPath, readIntent, writeIntent, clearIntent, teamRefFromIntent, type SetupIntent } from "../intent.ts";

describe("intentPath", () => {
  test("joins home/.mattstack/rt/setup-intent.json", () => {
    expect(intentPath("/fake-home")).toBe("/fake-home/.mattstack/rt/setup-intent.json");
  });
});

describe("writeIntent / readIntent", () => {
  test("round-trips a create intent", () => {
    const p = fakeProbes();
    const intent: SetupIntent = {
      v: 1,
      at: "2026-08-21T00:00:00.000Z",
      mode: "create",
      team: { slug: "acme", name: "Acme", remote: "git@host:acme/rt-home.git", others: false },
    };
    writeIntent(p, intent);
    expect(readIntent(p)).toEqual(intent);
  });

  test("round-trips a join intent", () => {
    const p = fakeProbes();
    const intent: SetupIntent = {
      v: 1,
      at: "2026-08-21T00:00:00.000Z",
      mode: "join",
      join: {
        id: "inv1",
        keyB64: "a2V5",
        pointer: { v: 1, team: "acme", name: "Acme", remote: "git@host:acme/rt-home.git", owner: "matt", forge: "github", createdAt: "2026-08-20T00:00:00.000Z" },
      },
    };
    writeIntent(p, intent);
    expect(readIntent(p)).toEqual(intent);
  });

  test("writeIntent writes with mode 0o600", () => {
    const p = fakeProbes();
    writeIntent(p, { v: 1, at: "2026-08-21T00:00:00.000Z", mode: "restore", restore: { homeRepo: "git@host:acme/rt-home.git" } });
    expect(p.calls.modes[intentPath(p.home)]).toBe(0o600);
  });

  test("readIntent returns null when the file is absent", () => {
    const p = fakeProbes();
    expect(readIntent(p)).toBeNull();
  });

  test("readIntent returns null on unparseable JSON", () => {
    const p = fakeProbes({ files: { [intentPath("/fake-home")]: "not json" } });
    expect(readIntent(p)).toBeNull();
  });
});

describe("clearIntent", () => {
  test("removes the intent file", () => {
    const p = fakeProbes();
    writeIntent(p, { v: 1, at: "2026-08-21T00:00:00.000Z", mode: "restore", restore: { homeRepo: "r" } });
    clearIntent(p);
    expect(readIntent(p)).toBeNull();
  });
});

describe("teamRefFromIntent", () => {
  test("create intent yields the team slug/name with mode create", () => {
    const intent: SetupIntent = {
      v: 1,
      at: "x",
      mode: "create",
      team: { slug: "acme", name: "Acme", remote: "r", others: false },
    };
    expect(teamRefFromIntent(intent, [])).toEqual({ slug: "acme", name: "Acme", mode: "create" });
  });

  test("join intent yields the invite pointer's team/name with mode join", () => {
    const intent: SetupIntent = {
      v: 1,
      at: "x",
      mode: "join",
      join: {
        id: "inv1",
        keyB64: "k",
        pointer: { v: 1, team: "acme", name: "Acme HQ", remote: "r", owner: "o", forge: "github", createdAt: "x" },
      },
    };
    expect(teamRefFromIntent(intent, [])).toEqual({ slug: "acme", name: "Acme HQ", mode: "join" });
  });

  test("restore intent yields the first discovered team with mode restore", () => {
    const intent: SetupIntent = { v: 1, at: "x", mode: "restore", restore: { homeRepo: "r" } };
    expect(teamRefFromIntent(intent, ["acme", "beta"])).toEqual({ slug: "acme", name: "acme", mode: "restore" });
  });

  test("null intent with discovered teams yields the first team with mode none", () => {
    expect(teamRefFromIntent(null, ["acme", "beta"])).toEqual({ slug: "acme", name: "acme", mode: "none" });
  });

  test("null intent with no discovered teams yields an empty ref", () => {
    expect(teamRefFromIntent(null, [])).toEqual({ slug: "", name: "", mode: "none" });
  });
});
