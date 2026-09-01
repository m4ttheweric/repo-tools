import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { composePackCommits, packProvenance } from "../provenance.ts";

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function repo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rt-prov-${name}-`));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("packProvenance", () => {
  test("records basename=shortsha per git dir and is clean when nothing changed", () => {
    const dir = repo("clean");
    const sha = git(dir, "rev-parse", "--short", "HEAD");
    const p = packProvenance([dir]);
    expect(p.dirty).toBe(0);
    expect(p.commits).toEqual([`${dir.split("/").pop()}=${sha}`]);
  });

  test("an unstaged change marks the run dirty", () => {
    const dir = repo("unstaged");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    expect(packProvenance([dir]).dirty).toBe(1);
  });

  test("a staged but uncommitted change marks the run dirty", () => {
    const dir = repo("staged");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    git(dir, "add", "a.txt");
    expect(packProvenance([dir]).dirty).toBe(1);
  });

  test("an untracked file marks the run dirty", () => {
    const dir = repo("untracked");
    writeFileSync(join(dir, "new.txt"), "x\n");
    expect(packProvenance([dir]).dirty).toBe(1);
  });

  test("a directory that is not a git checkout contributes nothing and never sets dirty", () => {
    const plain = mkdtempSync(join(tmpdir(), "rt-prov-plain-"));
    writeFileSync(join(plain, "junk.txt"), "x\n");
    const p = packProvenance([plain, ""]);
    expect(p).toEqual({ dirty: 0, commits: [] });
  });

  test("git not on PATH reads as absent provenance", () => {
    const dir = repo("nogit");
    const saved = process.env.PATH;
    try {
      process.env.PATH = "";
      const p = packProvenance([dir]);
      expect(p).toEqual({ dirty: 0, commits: [] });
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("composePackCommits", () => {
  test("orders dir entries, then mattstack, then the raw pack sha; empty is null", () => {
    expect(composePackCommits({ dirty: 0, commits: ["acme=abc1234"] }, "deadbee", "other=fff0000")).toBe("acme=abc1234,mattstack=deadbee,other=fff0000");
    expect(composePackCommits({ dirty: 0, commits: [] }, "deadbee")).toBe("mattstack=deadbee");
    expect(composePackCommits({ dirty: 0, commits: [] })).toBeNull();
  });
});
