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

import { renderPage } from "../lib/docs-render.ts";
import type { CommandNode } from "../../lib/command-tree.ts";

const OPTS = {
  common: { flags: new Set<string>(), href: "/guides/common-flags" },
  sourceBase: "https://github.com/x/repo-tools/blob/main/",
  hasPartial: () => false,
};

test("renderPage emits front matter, breadcrumb, description, and source link", () => {
  const node: CommandNode = {
    description: "Smart rebase onto origin/master",
    module: "./commands/git/rebase.ts",
    fn: "rebaseCommand",
    args: [{ name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Preview only" }],
  };
  const out = renderPage(node, ["git", "rebase"], "git/rebase", OPTS);
  expect(out).toMatch(/^---\n/);                       // front matter
  expect(out).toContain("sidebar_label: rebase");
  expect(out).toContain("`rt › git › rebase`");         // breadcrumb
  expect(out).toContain("Smart rebase onto origin/master");
  expect(out).toContain("## Arguments & flags");
  expect(out).toContain(
    "commands/git/rebase.ts › rebaseCommand](https://github.com/x/repo-tools/blob/main/commands/git/rebase.ts)",
  );
});

test("renderPage lists subcommands for a branch node", () => {
  const node: CommandNode = {
    description: "Git operations",
    subcommands: {
      rebase: { description: "Smart rebase", module: "./commands/git/rebase.ts", fn: "rebaseCommand" },
      reset: { description: "Safe reset", subcommands: {} },
    },
  };
  const out = renderPage(node, ["git"], "git/index", OPTS);
  expect(out).toContain("## Subcommands");
  expect(out).toContain("[`rebase`](rebase)");
  expect(out).toContain("Smart rebase");
});

test("renderPage splices a partial import only when the partial exists", () => {
  const node: CommandNode = { description: "Runner", module: "./commands/run.ts", fn: "runCommand" };
  const withPartial = renderPage(node, ["run"], "run", { ...OPTS, hasPartial: () => true });
  expect(withPartial).toContain("import Notes from '@site/docs/reference/_partials/run.mdx'");
  expect(withPartial).toContain("<Notes />");
  const without = renderPage(node, ["run"], "run", OPTS);
  expect(without).not.toContain("import Notes");
});

test("renderPage hides subcommands section when node has no subcommands", () => {
  const node: CommandNode = { description: "Runner", module: "./commands/run.ts", fn: "runCommand" };
  expect(renderPage(node, ["run"], "run", OPTS)).not.toContain("## Subcommands");
});
