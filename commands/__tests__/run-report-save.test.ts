/**
 * `reportSave` (commands/run.ts) — the only place that tells the user
 * whether a preset/variation save actually landed. `savePreset`/
 * `saveVariation` no-op or refuse rather than throw (best-effort I/O), so a
 * formatting/branch bug here is the one way a failed save could still print
 * a checkmark.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { __test__ } from "../run.ts";

const { reportSave } = __test__;

/** Strips ANSI so assertions read as plain text. */
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, "");

describe("reportSave", () => {
  let writes: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    writes = [];
    spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test("ok:true prints a checkmark with the name, never a failure line", () => {
    reportSave("preset", "backend-lite", { ok: true }, "acme");

    const out = plain(writes.join(""));
    expect(out).toContain("✓");
    expect(out).toContain("backend-lite");
    expect(out).not.toContain("not saved");
  });

  test("no-identity failure names the repo and the override hint", () => {
    reportSave("preset", "backend-lite", { ok: false, reason: "no-identity" }, "acme");

    const out = plain(writes.join(""));
    expect(out).toContain("not saved");
    expect(out).toContain("no repo identity for acme");
    expect(out).toContain("pin one with");
    expect(out).toContain("rt settings set rt.repoIdentityOverrides");
    expect(out).not.toContain("✓");
  });

  test("write-failed surfaces the refusal's own message verbatim", () => {
    const message =
      "rt: no local team store found — clone a team under ~/.mattstack/teams/<name> or pass opts.team";
    reportSave("variation", "debug", { ok: false, reason: "write-failed", message }, "acme");

    const out = plain(writes.join(""));
    expect(out).toContain("not saved");
    expect(out).toContain(message);
    expect(out).not.toContain("✓");
  });
});
