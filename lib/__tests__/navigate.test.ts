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
    expect(args).toContain("--preview-window=right,50%,border-line");
    expect(args).toContain("--bind=ctrl-p:toggle-preview");
  });
});

describe("buildNavArgs helpHeader", () => {
  const base = { options: [], message: "m" };

  test("hides the hints at start and toggles them with ctrl-/", () => {
    const args = buildNavArgs({ ...base, helpHeader: "line1\nline2" });
    expect(args).toContain("--header=line1\nline2");
    expect(args).toContain("--footer=ctrl-/: commands");
    expect(args).toContain("--bind=start:hide-header");
    expect(args).toContain("--bind=ctrl-/:toggle-header");
  });

  test("explicit header wins over helpHeader", () => {
    const args = buildNavArgs({ ...base, header: "esc: cancel", helpHeader: "hints" });
    expect(args).toContain("--header=esc: cancel");
    expect(args.some((a) => a.includes("toggle-header") || a.startsWith("--footer"))).toBe(false);
  });

  test("omits footer and toggle binds when helpHeader is not set", () => {
    const args = buildNavArgs(base);
    expect(args.some((a) => a.includes("toggle-header") || a.startsWith("--footer"))).toBe(false);
  });
});

describe("buildNavArgs live refresh", () => {
  const base = { options: [], message: "m" };

  test("omits listen and tracking args when no socket path is given", () => {
    const args = buildNavArgs(base);
    expect(args.some((a) => a.startsWith("--listen"))).toBe(false);
    expect(args).not.toContain("--track");
    expect(args).not.toContain("--id-nth=1");
  });

  test("emits listen and field-based tracking when a socket path is given", () => {
    const args = buildNavArgs(base, "/tmp/rt-nav-1.sock");
    expect(args).toContain("--listen=/tmp/rt-nav-1.sock");
    // Field 1 is the machine value column (d:src, f:readme.md), so the cursor
    // returns to the same entry after a reload instead of jumping to the top.
    expect(args).toContain("--track");
    expect(args).toContain("--id-nth=1");
  });
});

describe("buildNavArgs cyclic scroll", () => {
  test("always enables --cycle so the list wraps at both ends", () => {
    // Up at the top goes to the bottom, down at the bottom goes to the top.
    expect(buildNavArgs({ options: [], message: "m" })).toContain("--cycle");
  });
});
