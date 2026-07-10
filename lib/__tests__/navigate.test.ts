import { describe, test, expect } from "bun:test";
import { buildNavArgs } from "../navigate.ts";

describe("buildNavArgs preview", () => {
  const base = { options: [], message: "m" };

  test("omits preview args when preview is not set", () => {
    const args = buildNavArgs(base);
    expect(args.some((a) => a.startsWith("--preview"))).toBe(false);
    expect(args).not.toContain("--bind=ctrl-p:toggle-preview");
  });

  test("emits preview command, window, and toggle bind when preview is set", () => {
    const args = buildNavArgs({ ...base, preview: "echo {1}" });
    expect(args).toContain("--preview=echo {1}");
    expect(args).toContain("--preview-window=right,50%,border-rounded");
    expect(args).toContain("--bind=ctrl-p:toggle-preview");
  });
});
