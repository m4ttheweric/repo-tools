import { expect, test } from "bun:test";
import { listCswapAccounts, parseCswapList } from "../cswap.ts";

const CAPTURED = `
A newer version of claude-swap is available (0.25.0). You are using 0.23.0. Run \`cswap upgrade\` to update.
Accounts:
  1: alex@acme.test [Acme] (history: shared)
     ├ $$:    100%   $400.07 / $400.00
     ├ 5h:      0%
     ├ 7d:     40%   resets Aug 30 20:00  in 4d 0h
     └ Fable:  35%   resets Aug 30 20:00  in 4d 0h · 6m ago
  2: someone@example.com
     └ 5h:     12%
`;

test("parses slots, emails, aliases and a compact headroom summary", () => {
  expect(parseCswapList(CAPTURED)).toEqual([
    { slot: 1, email: "alex@acme.test", alias: "Acme", headroom: "5h 0% · 7d 40% · Fable 35%" },
    { slot: 2, email: "someone@example.com", headroom: "5h 12%" },
  ]);
});

test("a headroom label containing a colon still parses", () => {
  const text = `
Accounts:
  1: a@b.c
     ├ Sub:Label:  50%
`;
  expect(parseCswapList(text)).toEqual([{ slot: 1, email: "a@b.c", headroom: "Sub:Label 50%" }]);
});

test("an empty or unrelated output parses to no accounts", () => {
  expect(parseCswapList("")).toEqual([]);
  expect(parseCswapList("cswap: not found")).toEqual([]);
});

test("listCswapAccounts is empty when the binary is missing or fails", async () => {
  const missing = async () => ({ stdout: "", stderr: "", exitCode: -1 });
  expect(await listCswapAccounts(missing)).toEqual([]);
});
