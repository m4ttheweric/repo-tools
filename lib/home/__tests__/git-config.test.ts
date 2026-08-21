import { describe, test, expect } from "bun:test";
import { parseOriginUrl } from "../git-config.ts";

describe("parseOriginUrl", () => {
  test("extracts the origin remote url from a realistic clone config", () => {
    const config = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallrefupdates = true
[remote "origin"]
\turl = https://github.com/mattgoodwin/mattstack-prefs.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
\tmerge = refs/heads/main
`;

    expect(parseOriginUrl(config)).toBe("https://github.com/mattgoodwin/mattstack-prefs.git");
  });

  test("extracts an ssh-form url", () => {
    const config = `[remote "origin"]
\turl = git@github.com:mattgoodwin/mattstack-prefs.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
`;
    expect(parseOriginUrl(config)).toBe("git@github.com:mattgoodwin/mattstack-prefs.git");
  });

  test("ignores a url line belonging to a different remote", () => {
    const config = `[remote "upstream"]
\turl = https://github.com/someone-else/mattstack-prefs.git
[remote "origin"]
\turl = https://github.com/mattgoodwin/mattstack-prefs.git
`;
    expect(parseOriginUrl(config)).toBe("https://github.com/mattgoodwin/mattstack-prefs.git");
  });

  test("returns null when there is no [remote \"origin\"] section", () => {
    const config = `[core]
\trepositoryformatversion = 0
`;
    expect(parseOriginUrl(config)).toBeNull();
  });

  test("returns null for an empty file", () => {
    expect(parseOriginUrl("")).toBeNull();
  });

  test("returns null when the origin section has no url line", () => {
    const config = `[remote "origin"]
\tfetch = +refs/heads/*:refs/remotes/origin/*
`;
    expect(parseOriginUrl(config)).toBeNull();
  });
});
