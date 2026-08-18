/**
 * isGitLabRemote — the single gate that keeps MR enrichment from firing GitLab
 * GraphQL queries at non-GitLab remotes. Regression coverage for the daemon
 * log flooding with "GitLab MR fetch failed ... 422" on GitHub repos.
 */

import { describe, test, expect } from "bun:test";
import { isGitLabRemote, parseRemoteUrl } from "../enrich.ts";

describe("isGitLabRemote", () => {
  test("true for gitlab.com remotes (ssh + https)", () => {
    expect(isGitLabRemote("git@gitlab.com:acme/acme-dev.git")).toBe(true);
    expect(isGitLabRemote("https://gitlab.com/acme/acme-dev.git")).toBe(true);
  });

  test("true for self-hosted gitlab.* hosts", () => {
    expect(isGitLabRemote("git@gitlab.example.com:team/app.git")).toBe(true);
  });

  // These are the exact remotes that flooded the daemon log with 422 warnings.
  test("false for GitHub remotes", () => {
    expect(isGitLabRemote("git@github.com:m4ttstack/rt.git")).toBe(false);
    expect(isGitLabRemote("https://github.com/m4ttheweric/soribashi.git")).toBe(false);
    expect(isGitLabRemote("git@github.com:m4ttheweric/grift.git")).toBe(false);
    expect(isGitLabRemote("git@github.com:m4ttheweric/tfp-four-directions.git")).toBe(false);
  });

  test("false for undefined / empty", () => {
    expect(isGitLabRemote(undefined)).toBe(false);
    expect(isGitLabRemote("")).toBe(false);
  });

  // A GitHub URL still parses into host/projectPath — which is exactly why a
  // parse-success check alone was insufficient and a host gate is required.
  test("GitHub remote parses but must not be treated as GitLab", () => {
    const parsed = parseRemoteUrl("git@github.com:m4ttstack/rt.git");
    expect(parsed).toEqual({ host: "https://github.com", projectPath: "m4ttstack/rt" });
    expect(isGitLabRemote("git@github.com:m4ttstack/rt.git")).toBe(false);
  });
});
