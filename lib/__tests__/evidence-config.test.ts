import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandEvidenceRoot, loadEvidenceConfig, validateRequestArgs, viewPlaceholders } from "../evidence-config.ts";

const FIXTURE = `{
  // adapter facts
  "evidenceRoot": "~/evidence",
  "appPort": 4001,
  "views": {
    "cvi-case": { "path": "/cv/{caseId}/s/{contactId?}", "ready": { "selector": "[data-x]" } },
  },
  "recipes": { "shot": { "args": { "section": "overview" }, "annotate": [] } },
  "login": { "url": "/", "fields": { "#u": "QA_USER" }, "submit": "button", "assertAuthed": { "selector": "[data-user]" } },
}`;

function writeOverlay(): string {
  const root = mkdtempSync(join(tmpdir(), "rt-ev-"));
  mkdirSync(join(root, "demo"));
  writeFileSync(join(root, "demo", "evidence.jsonc"), FIXTURE);
  return root;
}

test("loads jsonc (comments + trailing commas); null on missing or malformed", () => {
  const root = writeOverlay();
  const cfg = loadEvidenceConfig("demo", root)!;
  expect(cfg.appPort).toBe(4001);
  expect(cfg.views["cvi-case"]!.ready!.selector).toBe("[data-x]");
  expect(loadEvidenceConfig("nope", root)).toBeNull();
  writeFileSync(join(root, "demo", "evidence.jsonc"), "{ not json");
  expect(loadEvidenceConfig("demo", root)).toBeNull();
});

test("expandEvidenceRoot expands ~ at call time", () => {
  const prev = process.env.HOME;
  process.env.HOME = "/tmp/fakehome";
  expect(expandEvidenceRoot("~/evidence")).toBe("/tmp/fakehome/evidence");
  process.env.HOME = prev;
});

test("viewPlaceholders and validateRequestArgs enforce declared placeholders only", () => {
  const root = writeOverlay();
  const cfg = loadEvidenceConfig("demo", root)!;
  expect(viewPlaceholders(cfg.views["cvi-case"]!)).toEqual(["caseId", "contactId"]);
  expect(validateRequestArgs(cfg, "nope", "shot", {})).toContain("unknown view");
  expect(validateRequestArgs(cfg, "cvi-case", "nope", {})).toContain("unknown recipe");
  expect(validateRequestArgs(cfg, "cvi-case", "shot", { rogue: "x" })).toContain("undeclared");
  expect(validateRequestArgs(cfg, "cvi-case", "shot", { contactId: "k" })).toBeNull();
  expect(validateRequestArgs(cfg, "cvi-case", "shot", {})).toBeNull(); // contactId is optional ({contactId?})
});
