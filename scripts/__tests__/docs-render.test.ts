import { test, expect } from "bun:test";
import { renderUsage, renderArgsTable, slugArg } from "../lib/docs-render.ts";
import type { CommandArg } from "../../lib/command-tree.ts";

const NO_COMMON = { flags: new Set<string>(), href: "/guides/common-flags" };

test("slugArg lowercases and hyphenates", () => {
  expect(slugArg("Dry run")).toBe("dry-run");
});

test("renderUsage includes positionals and a [flags] marker", () => {
  const args: CommandArg[] = [
    { name: "Key", type: "text" },
    { name: "Duration", flag: "--duration", type: "text" },
  ];
  const out = renderUsage(["sdm", "connect"], args);
  expect(out).toContain("rt sdm connect <key> [flags]");
});

test("renderArgsTable renders a row per arg with flag, type, default, hint", () => {
  const args: CommandArg[] = [
    { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Preview only" },
  ];
  const out = renderArgsTable(args, NO_COMMON);
  expect(out).toContain("| `--dry-run` | boolean | `false` | Preview only |");
});

test("renderArgsTable links common flags to the guide", () => {
  const args: CommandArg[] = [{ name: "JSON", flag: "--json", type: "boolean" }];
  const common = { flags: new Set(["--json"]), href: "/guides/common-flags" };
  const out = renderArgsTable(args, common);
  expect(out).toContain("[`--json`](/guides/common-flags)");
});

test("renderArgsTable returns empty string when no args", () => {
  expect(renderArgsTable(undefined, NO_COMMON)).toBe("");
  expect(renderArgsTable([], NO_COMMON)).toBe("");
});
