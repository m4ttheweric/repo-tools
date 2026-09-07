import { expect, test } from "bun:test";
import { planMatrix } from "../plan-matrix.ts";

const LOCK = JSON.stringify({
  schema: 1, arch: "arm64",
  tools: [
    { name: "fzf", version: "1", license: "MIT", url: "https://e.com/f", sha256: "a".repeat(64),
      archive: "raw", extract: "", bundlePath: "Contents/Helpers/fzf", exec: ["Contents/Helpers/fzf"],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper" },
    { name: "deck", version: "", license: "MIT", repo: "m4ttstack/deck", url: "", sha256: "",
      archive: "raw", extract: "", bundlePath: "Contents/Helpers/deck", exec: ["Contents/Helpers/deck"],
      exposeByDefault: true, entitlements: "jit", status: "pending", kind: "helper" },
    { name: "gitq", version: "0.2.1", license: "MIT", repo: "m4ttstack/gitq",
      url: "https://github.com/m4ttstack/gitq/releases/download/v0.2.1/gitq-darwin-arm64",
      sha256: "c".repeat(64), archive: "raw", extract: "", bundlePath: "Contents/Helpers/gitq",
      exec: ["Contents/Helpers/gitq"], exposeByDefault: true, entitlements: "jit",
      status: "bundled", kind: "helper" },
  ],
});

test("all selects every repo-bearing row, pending or bundled", () => {
  expect(planMatrix(LOCK, "all")).toEqual([
    { name: "deck", repo: "m4ttstack/deck", subdir: "" },
    { name: "gitq", repo: "m4ttstack/gitq", subdir: "" },
  ]);
});

test("a monorepo row's subdir passes through to its matrix leg", () => {
  const lock = JSON.parse(LOCK);
  lock.tools[1].repo = "m4ttstack/apps";
  lock.tools[1].subdir = "apps/deck";
  expect(planMatrix(JSON.stringify(lock), "deck")).toEqual([
    { name: "deck", repo: "m4ttstack/apps", subdir: "apps/deck" },
  ]);
});

test("named subset, whitespace tolerated", () => {
  expect(planMatrix(LOCK, " deck , gitq ")).toEqual([
    { name: "deck", repo: "m4ttstack/deck", subdir: "" },
    { name: "gitq", repo: "m4ttstack/gitq", subdir: "" },
  ]);
});

test("a repeated name yields one leg, not a duplicate artifact name", () => {
  expect(planMatrix(LOCK, "deck,deck,gitq")).toEqual([
    { name: "deck", repo: "m4ttstack/deck", subdir: "" },
    { name: "gitq", repo: "m4ttstack/gitq", subdir: "" },
  ]);
});

test("unknown name throws", () => {
  expect(() => planMatrix(LOCK, "deck,nope")).toThrow(/nope/);
});

test("a name without a repo row throws", () => {
  expect(() => planMatrix(LOCK, "fzf")).toThrow(/fzf/);
});

test("empty input throws", () => {
  expect(() => planMatrix(LOCK, " ")).toThrow(/apps/);
});
