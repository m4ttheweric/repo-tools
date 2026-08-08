import { expect, test } from "bun:test";

import { EVIDENCE_REQUEST_USAGE, parseEvidenceRequestFlags, reviewClosingHints } from "../../commands/evidence.ts";
import type { EvidenceConfig } from "../../lib/evidence-config.ts";

test("argless invocation gets the verb's full usage line, not a bare field error", () => {
  expect(parseEvidenceRequestFlags([])).toEqual({ error: EVIDENCE_REQUEST_USAGE });
  for (const piece of ["<sandboxId>", "--view", "--recipe", "--arg k=v", "--slot before|after|standalone", "--force-before", "--local"]) {
    expect(EVIDENCE_REQUEST_USAGE).toContain(piece);
  }
});

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

test("reviewClosingHints: config-carried, deduped, nothing for repos without a hint", () => {
  const base: Omit<EvidenceConfig, "reviewClosingHint"> = {
    evidenceRoot: "~/e", appPort: 1,
    views: {}, recipes: {},
    login: { url: "/", fields: {}, submit: "b", assertAuthed: { selector: "[x]" } },
  };
  const configs: Record<string, EvidenceConfig | null> = {
    "with-hint": { ...base, reviewClosingHint: "acme:capture-evidence A5" },
    "same-hint": { ...base, reviewClosingHint: "acme:capture-evidence A5" },
    "other-hint": { ...base, reviewClosingHint: "other step" },
    "no-hint": { ...base },
    "no-config": null,
  };
  const lookup = (repoId: string) => configs[repoId] ?? null;
  expect(reviewClosingHints(["with-hint", "same-hint", "other-hint", "no-hint", "no-config"], lookup))
    .toEqual(["acme:capture-evidence A5", "other step"]);
  expect(reviewClosingHints([], lookup)).toEqual([]);
  expect(reviewClosingHints(["no-hint", "no-config"], lookup)).toEqual([]);
});
