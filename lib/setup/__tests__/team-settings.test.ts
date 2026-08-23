import { describe, test, expect } from "bun:test";
import { readTeamSnapshot, forgeFromRemote, type TeamIntegrations } from "../team-settings.ts";
import { fakeProbes } from "./fakes.ts";
import type { SettingsReader } from "../team-settings.ts";

const GIT_CONFIG_PATH = "/fake-home/.mattstack/teams/acme/.git/config";

/** Never touches the real resolver/disk — this is the whole point of the injected `read` seam (finding 10). */
function fakeReader(values: Record<string, unknown>): SettingsReader {
  return <T>(key: string): T | undefined => values[key] as T | undefined;
}

describe("readTeamSnapshot — injected read seam", () => {
  test("assembles integrations/marketplaces/plugins/trackingIdentities from the reader, never touching getSetting", async () => {
    const integrations: TeamIntegrations = { forge: { host: "gitlab.example.com", provider: "gitlab" }, linear: { teamKey: "RT" } };
    const read = fakeReader({
      "mattstack.integrations": integrations,
      "mattstack.tracking": { repos: { "github.com/acme/repo": {}, "gitlab.example.com/acme/other": {} } },
      "claude.marketplaces": ["market-a"],
      "claude.plugins": ["plugin-a", "plugin-b"],
    });
    const p = fakeProbes({ home: "/fake-home" });
    const snapshot = readTeamSnapshot(p, "acme", { read });
    expect(snapshot).toEqual({
      slug: "acme",
      integrations,
      trackingIdentities: ["github.com/acme/repo", "gitlab.example.com/acme/other"],
      marketplaces: ["market-a"],
      plugins: ["plugin-a", "plugin-b"],
      remote: null,
    });
  });

  test("every key absent -> honest empty defaults, never a throw", async () => {
    const read = fakeReader({});
    const snapshot = readTeamSnapshot(fakeProbes({ home: "/fake-home" }), "acme", { read });
    expect(snapshot.integrations).toEqual({});
    expect(snapshot.trackingIdentities).toEqual([]);
    expect(snapshot.marketplaces).toEqual([]);
    expect(snapshot.plugins).toEqual([]);
  });

  test("a non-array claude.marketplaces/plugins value degrades to [] rather than propagating a bad shape", async () => {
    const read = fakeReader({ "claude.marketplaces": "not-an-array", "claude.plugins": { nope: true } });
    const snapshot = readTeamSnapshot(fakeProbes({ home: "/fake-home" }), "acme", { read });
    expect(snapshot.marketplaces).toEqual([]);
    expect(snapshot.plugins).toEqual([]);
  });

  test("an injected warn seam is accepted and never invoked when the injected reader never fails (finding 18: no bare console call in this path)", async () => {
    const warnings: string[] = [];
    const snapshot = readTeamSnapshot(fakeProbes({ home: "/fake-home" }), "acme", { read: fakeReader({}), warn: (m) => warnings.push(m) });
    expect(snapshot.integrations).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe("readTeamSnapshot — remote via p.readFile + parseOriginUrl", () => {
  test("a standard single-remote config resolves the origin url", () => {
    const files = { [GIT_CONFIG_PATH]: '[remote "origin"]\n\turl = https://gitlab.example.com/acme/mattstack.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' };
    const p = fakeProbes({ home: "/fake-home", files });
    expect(readTeamSnapshot(p, "acme", { read: fakeReader({}) }).remote).toBe("https://gitlab.example.com/acme/mattstack.git");
  });

  test("origin declared AFTER another remote -> still resolves origin's own url, not the other remote's", () => {
    const files = {
      [GIT_CONFIG_PATH]:
        '[remote "upstream"]\n\turl = https://gitlab.example.com/upstream/mattstack.git\n\tfetch = +refs/heads/*:refs/remotes/upstream/*\n' +
        '[remote "origin"]\n\turl = https://gitlab.example.com/acme/mattstack.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    };
    const p = fakeProbes({ home: "/fake-home", files });
    expect(readTeamSnapshot(p, "acme", { read: fakeReader({}) }).remote).toBe("https://gitlab.example.com/acme/mattstack.git");
  });

  test("the fetch line precedes url within the origin section -> still finds url", () => {
    const files = { [GIT_CONFIG_PATH]: '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\turl = https://gitlab.example.com/acme/mattstack.git\n' };
    const p = fakeProbes({ home: "/fake-home", files });
    expect(readTeamSnapshot(p, "acme", { read: fakeReader({}) }).remote).toBe("https://gitlab.example.com/acme/mattstack.git");
  });

  test("pushurl is never mistaken for url", () => {
    const files = {
      [GIT_CONFIG_PATH]: '[remote "origin"]\n\tpushurl = https://gitlab.example.com/acme/push-only.git\n\turl = https://gitlab.example.com/acme/mattstack.git\n',
    };
    const p = fakeProbes({ home: "/fake-home", files });
    expect(readTeamSnapshot(p, "acme", { read: fakeReader({}) }).remote).toBe("https://gitlab.example.com/acme/mattstack.git");
  });

  test("an origin section with no url of its own never falls through to a later section's url", () => {
    const files = {
      [GIT_CONFIG_PATH]: '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[some "other"]\n\turl = https://should-not-match.example.com/x.git\n',
    };
    const p = fakeProbes({ home: "/fake-home", files });
    expect(readTeamSnapshot(p, "acme", { read: fakeReader({}) }).remote).toBeNull();
  });

  test("no origin section at all -> null", () => {
    const files = { [GIT_CONFIG_PATH]: '[remote "upstream"]\n\turl = https://gitlab.example.com/upstream/mattstack.git\n' };
    const p = fakeProbes({ home: "/fake-home", files });
    expect(readTeamSnapshot(p, "acme", { read: fakeReader({}) }).remote).toBeNull();
  });

  test("no config file at all -> null", () => {
    const p = fakeProbes({ home: "/fake-home" });
    expect(readTeamSnapshot(p, "acme", { read: fakeReader({}) }).remote).toBeNull();
  });
});

describe("forgeFromRemote", () => {
  test("github.com -> github", () => {
    expect(forgeFromRemote("https://github.com/acme/repo.git")).toEqual({ host: "github.com", provider: "github" });
  });

  test("a self-hosted host -> gitlab (self-hosted assumption)", () => {
    expect(forgeFromRemote("https://gitlab.example.com/acme/repo.git")).toEqual({ host: "gitlab.example.com", provider: "gitlab" });
  });

  test("an unparsable remote -> null", () => {
    expect(forgeFromRemote("not a url")).toBeNull();
  });

  test("userinfo in the remote is stripped from host, never leaked (finding 7)", () => {
    expect(forgeFromRemote("https://x-token-auth:sk-sentinel@gitlab.example.com/acme/repo.git")).toEqual({ host: "gitlab.example.com", provider: "gitlab" });
  });

  test("an ssh remote resolves the same way, no userinfo to strip", () => {
    expect(forgeFromRemote("git@github.com:acme/repo.git")).toEqual({ host: "github.com", provider: "github" });
  });
});
