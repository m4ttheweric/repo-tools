import { expect, test } from "bun:test";

import { parseEvidenceRequestFlags } from "../../commands/evidence.ts";

test("parses the full request flag set", () => {
  const p = parseEvidenceRequestFlags([
    "sb1", "--case", "c1", "--view", "qa-case", "--recipe", "shot",
    "--slot", "before", "--arg", "contactId=k", "--arg", "section=overview",
    "--force-before",
  ]);
  expect(p).toEqual({
    sandboxId: "sb1", caseId: "c1", view: "qa-case", recipe: "shot",
    slot: "before", args: { contactId: "k", section: "overview" },
    local: false, forceBefore: true, json: false,
  });
});

test("errors: missing required flag, bad slot, malformed --arg", () => {
  expect(parseEvidenceRequestFlags(["sb1", "--view", "v", "--recipe", "r", "--slot", "after"]))
    .toEqual({ error: "--case is required" });
  expect(parseEvidenceRequestFlags(["sb1", "--case", "c", "--view", "v", "--recipe", "r", "--slot", "x"]))
    .toEqual({ error: "--slot must be before, after, or standalone" });
  expect(parseEvidenceRequestFlags(["sb1", "--case", "c", "--view", "v", "--recipe", "r", "--slot", "after", "--arg", "noequals"]))
    .toEqual({ error: "--arg takes k=v" });
});

test("--local with no sandbox id is valid (branch resolved from the worktree)", () => {
  const p = parseEvidenceRequestFlags(["--local", "--case", "c", "--view", "v", "--recipe", "r", "--slot", "standalone"]);
  expect(p).toMatchObject({ sandboxId: null, local: true });
});
